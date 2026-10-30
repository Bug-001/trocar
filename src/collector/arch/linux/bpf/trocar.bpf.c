// trocar Linux per-process redirector — eBPF side (spec 4.6 §Linux 机制, D36 per-user model).
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
//   pidns_ino   = 0 in the initial pid namespace, else the inode of the loader's (= the engine's) own.
//
// Every tgid on this side -- watch_map keys, engine_tgid, orig_dst.pid, event pids -- is numbered in
// the engine's pid namespace, the way its /proc numbers them (spec 4.6 §pid 命名空间): cur_tgid().
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
#include "trocar.h"

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

/* Set by the loader from getuid()/--parent-pid before trocar__load, then frozen by libbpf.
 * const volatile -> a .rodata global the verifier treats as a known constant per load. */
const volatile __u32 owner_uid = 0;
const volatile __u32 engine_tgid = 0;
const volatile __u32 pidns_ino = 0;

#define TROCAR_PIDNS_LEVELS 32 /* MAX_PID_NS_LEVEL: pid namespaces nest at most this deep */

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 4096);
	__type(key, __u32);   /* tgid */
	__type(value, struct trocar_verdict);
} watch_map SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 65536);
	__type(key, __u64);   /* socket cookie */
	__type(value, struct trocar_orig);
} orig_dst SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 65536);
	__type(key, struct trocar_portkey);   /* {client source port (host order), family} */
	__type(value, struct trocar_orig);
} by_port SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_ARRAY);
	__uint(max_entries, 1);
	__type(key, __u32);
	__type(value, struct trocar_config);
} config_map SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	__uint(max_entries, 1 << 20);
} events SEC(".maps");

/* D38 (D-16): what the kernel side let go direct or could not report, by reason (trocar.h TROCAR_DROP_*). */
struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, TROCAR_DROP_MAX);
	__type(key, __u32);
	__type(value, __u64);
} drops SEC(".maps");

static __always_inline void count_drop(__u32 why)
{
	__u64 *n = bpf_map_lookup_elem(&drops, &why);
	if (n)
		*n += 1; /* per-CPU slot: no other CPU writes it */
}

/* The current process's tgid as the engine's /proc numbers it, or 0 for a process outside the engine's pid
 * namespace. In the initial namespace that is the kernel's own number. In a namespace of its own (a container)
 * it is the number at that namespace's level of the leader's struct pid, the level found by the namespace's
 * inode, so a process in a sandbox nested below it gets the number the engine sees too. With pidns_ino 0 the
 * verifier drops the walk as dead code, so a kernel whose cgroup programs lack these helpers still loads. */
static __always_inline __u32 cur_tgid(void)
{
	if (!pidns_ino)
		return bpf_get_current_pid_tgid() >> 32;
	struct task_struct *task = (struct task_struct *)bpf_get_current_task();
	struct pid *pid = BPF_CORE_READ(task, group_leader, thread_pid);
	unsigned int level = BPF_CORE_READ(pid, level);
	for (unsigned int i = 0; i < TROCAR_PIDNS_LEVELS && i <= level; i++) {
		struct upid up;
		if (bpf_core_read(&up, sizeof(up), &pid->numbers[i]))
			return 0;
		if (BPF_CORE_READ(up.ns, ns.inum) == pidns_ino)
			return up.nr;
	}
	return 0;
}

static __always_inline struct trocar_config *get_config(void)
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

static __always_inline int heartbeat_fresh(struct trocar_config *cfg)
{
	if (cfg->hb_ns == 0)
		return 0;
	__u64 now = bpf_ktime_get_ns();
	return (now - cfg->hb_ns) < TROCAR_HEARTBEAT_STALE_NS;
}

static __always_inline void report_flow4(struct bpf_sock_addr *ctx, __u32 tgid)
{
	struct trocar_event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
	if (!e) {
		count_drop(TROCAR_DROP_RINGBUF_FULL);
		return;
	}
	__builtin_memset(e, 0, sizeof(*e));
	e->type = TROCAR_EV_FLOW;
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
	struct trocar_event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
	if (!e) {
		count_drop(TROCAR_DROP_RINGBUF_FULL);
		return;
	}
	__builtin_memset(e, 0, sizeof(*e));
	e->type = TROCAR_EV_FLOW;
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
int trocar_connect4(struct bpf_sock_addr *ctx)
{
	if (ctx->protocol != IPPROTO_TCP)
		return 1;
	/* D36 check order: owner first, then engine self-exclusion, then watch/heartbeat/listener. */
	__u32 uid = bpf_get_current_uid_gid() & 0xffffffff;
	if (uid != owner_uid)
		return 1; /* another user's connection -> never touched (multi-user isolation) */
	__u32 tgid = cur_tgid();
	if (!tgid || tgid == engine_tgid)
		return 1; /* outside the engine's pid namespace, or the engine's own upstream dials -> never steered (no self-loop) */
	struct trocar_verdict *v = bpf_map_lookup_elem(&watch_map, &tgid);
	if (!v)
		return 1; /* not an agent */
	if (!v->decrypt) {
		report_flow4(ctx, tgid);
		return 1; /* watched but pass-through: record metadata only */
	}
	struct trocar_config *cfg = get_config();
	if (!cfg || cfg->engine_port == 0) {
		count_drop(TROCAR_DROP_NO_CONFIG);
		return 1;
	}
	if (!heartbeat_fresh(cfg)) {
		count_drop(TROCAR_DROP_HB_STALE);
		return 1;
	}
	if (!engine_listening4(ctx, cfg->engine_port)) {
		count_drop(TROCAR_DROP_NO_LISTENER);
		return 1;
	}

	struct trocar_orig o = {};
	o.family = 4;
	o.decrypt = 1;
	o.pid = tgid;
	o.ip4 = ctx->user_ip4;	/* network order, pre-rewrite */
	o.port = ctx->user_port;	/* network order, pre-rewrite */
	__u64 cookie = bpf_get_socket_cookie(ctx);
	if (bpf_map_update_elem(&orig_dst, &cookie, &o, BPF_ANY) != 0) {
		count_drop(TROCAR_DROP_ORIG_WRITE);
		return 1; /* never rewrite what the engine could not look up: it would close the connection */
	}

	ctx->user_ip4 = bpf_htonl(ENGINE_IP4);
	ctx->user_port = bpf_htons(cfg->engine_port);
	return 1;
}

SEC("cgroup/connect6")
int trocar_connect6(struct bpf_sock_addr *ctx)
{
	if (ctx->protocol != IPPROTO_TCP)
		return 1;
	__u32 uid = bpf_get_current_uid_gid() & 0xffffffff;
	if (uid != owner_uid)
		return 1;
	__u32 tgid = cur_tgid();
	if (!tgid || tgid == engine_tgid)
		return 1;
	struct trocar_verdict *v = bpf_map_lookup_elem(&watch_map, &tgid);
	if (!v)
		return 1;
	if (!v->decrypt) {
		report_flow6(ctx, tgid);
		return 1;
	}
	struct trocar_config *cfg = get_config();
	if (!cfg || cfg->engine_port == 0) {
		count_drop(TROCAR_DROP_NO_CONFIG);
		return 1;
	}
	if (!heartbeat_fresh(cfg)) {
		count_drop(TROCAR_DROP_HB_STALE);
		return 1;
	}
	if (!engine_listening6(ctx, cfg->engine_port)) {
		count_drop(TROCAR_DROP_NO_LISTENER);
		return 1;
	}

	struct trocar_orig o = {};
	o.family = 6;
	o.decrypt = 1;
	o.pid = tgid;
	o.ip6[0] = ctx->user_ip6[0];
	o.ip6[1] = ctx->user_ip6[1];
	o.ip6[2] = ctx->user_ip6[2];
	o.ip6[3] = ctx->user_ip6[3];
	o.port = ctx->user_port;
	__u64 cookie = bpf_get_socket_cookie(ctx);
	if (bpf_map_update_elem(&orig_dst, &cookie, &o, BPF_ANY) != 0) {
		count_drop(TROCAR_DROP_ORIG_WRITE);
		return 1;
	}

	ctx->user_ip6[0] = 0;
	ctx->user_ip6[1] = 0;
	ctx->user_ip6[2] = 0;
	ctx->user_ip6[3] = bpf_htonl(1); /* ::1 */
	ctx->user_port = bpf_htons(cfg->engine_port);
	return 1;
}

SEC("sockops")
int trocar_sockops(struct bpf_sock_ops *skops)
{
	/* Return 1 everywhere: with sockops multi-attach, a 0 return makes tcp_call_bpf() hand back
	 * -1 for every TCP socket and clobbers other users' / other tools' sockops programs (D36). */
	if (skops->op != BPF_SOCK_OPS_ACTIVE_ESTABLISHED_CB)
		return 1;
	__u64 cookie = bpf_get_socket_cookie(skops);
	struct trocar_orig *o = bpf_map_lookup_elem(&orig_dst, &cookie);
	if (!o)
		return 1;
	struct trocar_portkey k = {};
	k.sport = (__u16)skops->local_port; /* host byte order */
	k.family = o->family;
	if (bpf_map_update_elem(&by_port, &k, o, BPF_ANY) != 0)
		count_drop(TROCAR_DROP_BYPORT_WRITE); /* already rewritten: the engine's lookup will miss and say so */
	bpf_map_delete_elem(&orig_dst, &cookie);
	return 1;
}

SEC("tp_btf/sched_process_exec")
int BPF_PROG(trocar_exec, struct task_struct *p, pid_t old_pid, struct linux_binprm *bprm)
{
	__u32 tgid = cur_tgid();
	if (!tgid)
		return 0; /* outside the engine's pid namespace: it has no number there */
	bpf_map_delete_elem(&watch_map, &tgid); /* a reused tgid starts untrusted (owner-independent) */

	if ((bpf_get_current_uid_gid() & 0xffffffff) != owner_uid)
		return 0; /* only the owner's process events are reported */

	struct trocar_event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
	if (!e) {
		count_drop(TROCAR_DROP_RINGBUF_FULL); /* this agent will not be recognised until a rescan */
		return 0;
	}
	__builtin_memset(e, 0, sizeof(*e));
	e->type = TROCAR_EV_EXEC;
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
int BPF_PROG(trocar_exit, struct task_struct *p)
{
	__u64 pt = bpf_get_current_pid_tgid();
	if ((__u32)pt != pt >> 32)
		return 0; /* only the thread-group leader's exit means the process is gone (in any namespace's numbers) */
	__u32 tgid = cur_tgid();
	if (!tgid)
		return 0;
	bpf_map_delete_elem(&watch_map, &tgid);

	if ((bpf_get_current_uid_gid() & 0xffffffff) != owner_uid)
		return 0;

	struct trocar_event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
	if (!e) {
		count_drop(TROCAR_DROP_RINGBUF_FULL);
		return 0;
	}
	__builtin_memset(e, 0, sizeof(*e));
	e->type = TROCAR_EV_EXIT;
	e->pid = tgid;
	e->tgid = tgid;
	e->ts_ns = bpf_ktime_get_ns();
	bpf_ringbuf_submit(e, 0);
	return 0;
}
