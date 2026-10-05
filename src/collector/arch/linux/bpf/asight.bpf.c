// asight Linux per-process redirector — eBPF side (spec 4.6 §Linux 机制, D36 per-user model).
//
// Three cgroup programs attached at the ROOT cgroup via bpf_link (the loader uses
// bpf_program__attach_cgroup, which issues BPF_LINK_CREATE on kernels >=5.7; links are never
// pinned, so when the loader dies the kernel auto-detaches them and agent traffic flows direct
// — fail-open, research finding c). Plus two tp_btf tracepoints that keep the watch set honest
// and stay attached across on/off.
//
// D36 (per-user collector): there is no dedicated engine account. Each OS user runs their own
// engine + loader; the loader bakes two values into rodata before load:
//   owner_uid   = getuid() of the loader (== the engine's uid).  Only this uid's connections and
//                 process events are ever touched or reported, so co-tenant users are invisible
//                 to each other even though the cgroup programs multi-attach at the shared root.
//   engine_tgid = the engine process's tgid (the loader's getppid(), checked against --parent-pid).
//                 Its own upstream dials are never steered, so there is no self-loop.
//
//   connect4 / connect6 : for an owner, non-engine, watched, decrypt-eligible TCP connection,
//                         rewrite the connect destination to the local engine, stashing the
//                         original dst by socket cookie. Watched-but-no-decrypt -> report
//                         {pid,dst} on the ringbuf and leave the connection alone. Everything
//                         else -> untouched (allow).
//   sockops             : at ACTIVE_ESTABLISHED, move the stashed original dst to a by-port
//                         table keyed by {source port, family}, so the engine can recover it
//                         after accept(). Returns 1 so it composes with other sockops programs.
//   sched_process_exec  : clear any stale verdict for a reused tgid and (for the owner) report
//                         the exec.
//   sched_process_exit  : on the thread-group leader, drop the verdict and (for the owner)
//                         report the exit.

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_tracing.h> /* BPF_PROG() for the tp_btf programs */
#include "asight.h"

char LICENSE[] SEC("license") = "Dual MIT/GPL";

#ifndef AF_INET
#define AF_INET 2
#endif
#ifndef AF_INET6
#define AF_INET6 10
#endif
#ifndef IPPROTO_TCP
#define IPPROTO_TCP 6
#endif
#define ENGINE_IP4 0x7f000001 /* 127.0.0.1, host order */

/* Set by the loader from getuid()/--parent-pid before asight__load, then frozen by libbpf.
 * const volatile -> a .rodata global the verifier treats as a known constant per load. */
const volatile __u32 owner_uid = 0;
const volatile __u32 engine_tgid = 0;

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 4096);
	__type(key, __u32);   /* tgid */
	__type(value, struct asight_verdict);
} watch_map SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 65536);
	__type(key, __u64);   /* socket cookie */
	__type(value, struct asight_orig);
} orig_dst SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 65536);
	__type(key, struct asight_portkey);   /* {client source port (host order), family} */
	__type(value, struct asight_orig);
} by_port SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_ARRAY);
	__uint(max_entries, 1);
	__type(key, __u32);
	__type(value, struct asight_config);
} config_map SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	__uint(max_entries, 1 << 20);
} events SEC(".maps");

static __always_inline struct asight_config *get_config(void)
{
	__u32 k = 0;
	return bpf_map_lookup_elem(&config_map, &k);
}

/* Is the engine actually listening on the loopback engine port in the current netns?
 * (fail-open layer 2: engine dead -> no listener -> we do not steer.) */
static __always_inline int engine_listening4(struct bpf_sock_addr *ctx, __u16 port_host)
{
	struct bpf_sock_tuple t = {};
	t.ipv4.daddr = bpf_htonl(ENGINE_IP4);
	t.ipv4.dport = bpf_htons(port_host);
	struct bpf_sock *sk = bpf_sk_lookup_tcp(ctx, &t, sizeof(t.ipv4), BPF_F_CURRENT_NETNS, 0);
	if (!sk)
		return 0;
	bpf_sk_release(sk);
	return 1;
}

static __always_inline int engine_listening6(struct bpf_sock_addr *ctx, __u16 port_host)
{
	struct bpf_sock_tuple t = {};
	t.ipv6.daddr[3] = bpf_htonl(1); /* ::1 */
	t.ipv6.dport = bpf_htons(port_host);
	struct bpf_sock *sk = bpf_sk_lookup_tcp(ctx, &t, sizeof(t.ipv6), BPF_F_CURRENT_NETNS, 0);
	if (!sk)
		return 0;
	bpf_sk_release(sk);
	return 1;
}

static __always_inline int heartbeat_fresh(struct asight_config *cfg)
{
	if (cfg->hb_ns == 0)
		return 0;
	__u64 now = bpf_ktime_get_ns();
	return (now - cfg->hb_ns) < ASIGHT_HEARTBEAT_STALE_NS;
}

static __always_inline void report_flow4(struct bpf_sock_addr *ctx, __u32 tgid)
{
	struct asight_event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
	if (!e)
		return;
	__builtin_memset(e, 0, sizeof(*e));
	e->type = ASIGHT_EV_FLOW;
	e->family = 4;
	e->pid = tgid;
	e->tgid = tgid;
	e->ts_ns = bpf_ktime_get_ns();
	e->daddr4 = ctx->user_ip4;
	e->dport = ctx->user_port;
	bpf_ringbuf_submit(e, 0);
}

static __always_inline void report_flow6(struct bpf_sock_addr *ctx, __u32 tgid)
{
	struct asight_event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
	if (!e)
		return;
	__builtin_memset(e, 0, sizeof(*e));
	e->type = ASIGHT_EV_FLOW;
	e->family = 6;
	e->pid = tgid;
	e->tgid = tgid;
	e->ts_ns = bpf_ktime_get_ns();
	e->daddr6[0] = ctx->user_ip6[0];
	e->daddr6[1] = ctx->user_ip6[1];
	e->daddr6[2] = ctx->user_ip6[2];
	e->daddr6[3] = ctx->user_ip6[3];
	e->dport = ctx->user_port;
	bpf_ringbuf_submit(e, 0);
}

SEC("cgroup/connect4")
int asight_connect4(struct bpf_sock_addr *ctx)
{
	if (ctx->protocol != IPPROTO_TCP)
		return 1;
	/* D36 check order: owner first, then engine self-exclusion, then watch/heartbeat/listener. */
	__u32 uid = bpf_get_current_uid_gid() & 0xffffffff;
	if (uid != owner_uid)
		return 1; /* another user's connection -> never touched (multi-user isolation) */
	__u32 tgid = bpf_get_current_pid_tgid() >> 32;
	if (tgid == engine_tgid)
		return 1; /* the engine's own upstream dials -> never steered (no self-loop) */
	struct asight_verdict *v = bpf_map_lookup_elem(&watch_map, &tgid);
	if (!v)
		return 1; /* not an agent */
	if (!v->decrypt) {
		report_flow4(ctx, tgid);
		return 1; /* watched but pass-through: record metadata only */
	}
	struct asight_config *cfg = get_config();
	if (!cfg || cfg->engine_port == 0 || !heartbeat_fresh(cfg))
		return 1;
	if (!engine_listening4(ctx, cfg->engine_port))
		return 1;

	struct asight_orig o = {};
	o.family = 4;
	o.decrypt = 1;
	o.pid = tgid;
	o.ip4 = ctx->user_ip4;	/* network order, pre-rewrite */
	o.port = ctx->user_port;	/* network order, pre-rewrite */
	__u64 cookie = bpf_get_socket_cookie(ctx);
	bpf_map_update_elem(&orig_dst, &cookie, &o, BPF_ANY);

	ctx->user_ip4 = bpf_htonl(ENGINE_IP4);
	ctx->user_port = bpf_htons(cfg->engine_port);
	return 1;
}

SEC("cgroup/connect6")
int asight_connect6(struct bpf_sock_addr *ctx)
{
	if (ctx->protocol != IPPROTO_TCP)
		return 1;
	__u32 uid = bpf_get_current_uid_gid() & 0xffffffff;
	if (uid != owner_uid)
		return 1;
	__u32 tgid = bpf_get_current_pid_tgid() >> 32;
	if (tgid == engine_tgid)
		return 1;
	struct asight_verdict *v = bpf_map_lookup_elem(&watch_map, &tgid);
	if (!v)
		return 1;
	if (!v->decrypt) {
		report_flow6(ctx, tgid);
		return 1;
	}
	struct asight_config *cfg = get_config();
	if (!cfg || cfg->engine_port == 0 || !heartbeat_fresh(cfg))
		return 1;
	if (!engine_listening6(ctx, cfg->engine_port))
		return 1;

	struct asight_orig o = {};
	o.family = 6;
	o.decrypt = 1;
	o.pid = tgid;
	o.ip6[0] = ctx->user_ip6[0];
	o.ip6[1] = ctx->user_ip6[1];
	o.ip6[2] = ctx->user_ip6[2];
	o.ip6[3] = ctx->user_ip6[3];
	o.port = ctx->user_port;
	__u64 cookie = bpf_get_socket_cookie(ctx);
	bpf_map_update_elem(&orig_dst, &cookie, &o, BPF_ANY);

	ctx->user_ip6[0] = 0;
	ctx->user_ip6[1] = 0;
	ctx->user_ip6[2] = 0;
	ctx->user_ip6[3] = bpf_htonl(1); /* ::1 */
	ctx->user_port = bpf_htons(cfg->engine_port);
	return 1;
}

SEC("sockops")
int asight_sockops(struct bpf_sock_ops *skops)
{
	/* Return 1 everywhere: with sockops multi-attach, a 0 return makes tcp_call_bpf() hand back
	 * -1 for every TCP socket and clobbers other users' / other tools' sockops programs (D36). */
	if (skops->op != BPF_SOCK_OPS_ACTIVE_ESTABLISHED_CB)
		return 1;
	__u64 cookie = bpf_get_socket_cookie(skops);
	struct asight_orig *o = bpf_map_lookup_elem(&orig_dst, &cookie);
	if (!o)
		return 1;
	struct asight_portkey k = {};
	k.sport = (__u16)skops->local_port; /* host byte order */
	k.family = o->family;
	bpf_map_update_elem(&by_port, &k, o, BPF_ANY);
	bpf_map_delete_elem(&orig_dst, &cookie);
	return 1;
}

SEC("tp_btf/sched_process_exec")
int BPF_PROG(asight_exec, struct task_struct *p, pid_t old_pid, struct linux_binprm *bprm)
{
	__u32 tgid = bpf_get_current_pid_tgid() >> 32;
	bpf_map_delete_elem(&watch_map, &tgid); /* a reused tgid starts untrusted (owner-independent) */

	if ((bpf_get_current_uid_gid() & 0xffffffff) != owner_uid)
		return 0; /* only the owner's process events are reported */

	struct asight_event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
	if (!e)
		return 0;
	__builtin_memset(e, 0, sizeof(*e));
	e->type = ASIGHT_EV_EXEC;
	e->pid = tgid;
	e->tgid = tgid;
	e->ts_ns = bpf_ktime_get_ns();
	bpf_get_current_comm(&e->comm, sizeof(e->comm));
	const char *fn = BPF_CORE_READ(bprm, filename);
	bpf_probe_read_kernel_str(&e->filename, sizeof(e->filename), fn);
	bpf_ringbuf_submit(e, 0);
	return 0;
}

SEC("tp_btf/sched_process_exit")
int BPF_PROG(asight_exit, struct task_struct *p)
{
	__u64 pt = bpf_get_current_pid_tgid();
	__u32 tgid = pt >> 32;
	__u32 pid = (__u32)pt;
	if (pid != tgid)
		return 0; /* only the thread-group leader's exit means the process is gone */
	bpf_map_delete_elem(&watch_map, &tgid);

	if ((bpf_get_current_uid_gid() & 0xffffffff) != owner_uid)
		return 0;

	struct asight_event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
	if (!e)
		return 0;
	__builtin_memset(e, 0, sizeof(*e));
	e->type = ASIGHT_EV_EXIT;
	e->pid = tgid;
	e->tgid = tgid;
	e->ts_ns = bpf_ktime_get_ns();
	bpf_ringbuf_submit(e, 0);
	return 0;
}
