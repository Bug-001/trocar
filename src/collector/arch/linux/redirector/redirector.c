// asight Linux redirector — privileged userspace loader (spec 4.6 §Linux 机制, §开关语义; D36).
//
// Owns the eBPF bpf_links and maps for src/collector/arch/linux/bpf/asight.bpf.c and answers
// the Node client (src/collector/arch/linux/redirector-client.mjs) over a newline-JSON line
// protocol on stdin/stdout. It does exactly three things — attach/detach the cgroup programs,
// edit the maps, and answer lookups/status — and never touches a single connection byte.
//
// D36 privilege model: this binary carries exactly file caps `cap_bpf,cap_net_admin,cap_perfmon`
// (installed once by the setup-helper step -- `sudo node install.mjs setup-helper`; the operator-
// facing `asight setup-helper` CLI is not built yet). It runs as the OPERATOR (ruid=euid=suid), as a
// child of that user's engine. At startup it loads + attaches EVERYTHING that needs those caps
// (map/prog load, tp_btf attach) BEFORE the first stdin read, then drops to CAP_BPF only, sets
// PR_SET_NO_NEW_PRIVS, stays non-dumpable, and clearenv()s — so from the first byte of protocol
// onward a same-uid agent cannot escalate through it. owner_uid (getuid) and engine_tgid
// (--parent-pid, checked == getppid) are baked into BPF rodata before load and cannot be changed
// over the wire.
//
// Fail-open: the cgroup links are created with bpf_program__attach_cgroup (BPF_LINK_CREATE) and
// NEVER pinned, so when this process exits or is killed the kernel auto-detaches everything and
// agent traffic flows direct. It also sets PR_SET_PDEATHSIG (re-set here because a file-caps exec
// clears it) and exits on stdin EOF, so the death of the engine cleans the kernel up on its own.

#define _GNU_SOURCE /* clearenv(), and GNU prctl/capability decls */
#include <errno.h>
#include <poll.h>
#include <stdarg.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <fcntl.h>
#include <linux/types.h>
#include <linux/capability.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/statfs.h>
#include <sys/utsname.h>
#include <arpa/inet.h>
#include <bpf/libbpf.h>
#include <bpf/bpf.h>

#include "asight.h"
#include "asight.skel.h"

#define CGROUP_ROOT "/sys/fs/cgroup"
#define CGROUP2_SUPER_MAGIC 0x63677270

/* Line protocol version. The client carries the same constant and fails open (keeps working,
 * warns) on a mismatch, so an old client talking to a new loader never wedges. Bump on any
 * wire-visible change (fields, op semantics).
 * 2 (D38): status carries `drops`; config / heartbeat / watch / unwatch answer ok:false with the errno when the map
 * write fails; attach failed carries the errno. */
#define ASIGHT_PROTO 2

/* Overridden by the Makefile (-DASIGHT_BUILD_HASH=...) so `ready` can report the exact build. */
#ifndef ASIGHT_BUILD_HASH
#define ASIGHT_BUILD_HASH "unknown"
#endif

#ifndef CAP_BPF
#define CAP_BPF 39
#endif

/* Minimum kernel the loader will run on. Compile-time (no runtime surface); the test rig overrides it
 * with -DASIGHT_MIN_KMAJOR (above the running major) to prove the floor refusal on a kernel it
 * can't downgrade. */
#ifndef ASIGHT_MIN_KMAJOR
#define ASIGHT_MIN_KMAJOR 5
#endif
#ifndef ASIGHT_MIN_KMINOR
#define ASIGHT_MIN_KMINOR 15
#endif

static volatile sig_atomic_t stop;
static struct asight *skel;
static struct ring_buffer *rb;
static struct bpf_link *cg_links[3]; /* connect4, connect6, sockops */
static const char *cg_names[3] = { "connect4", "connect6", "sockops" };
static struct asight_config cur_cfg; /* userspace-authoritative mirror of config_map[0] */
static __u32 g_parent_pid;           /* --parent-pid value (0 in --selftest) */

static void on_signal(int sig) { (void)sig; stop = 1; }

static __u64 monotonic_ns(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (__u64)ts.tv_sec * 1000000000ULL + (__u64)ts.tv_nsec;
}

static void emitf(const char *fmt, ...)
{
	va_list ap;
	va_start(ap, fmt);
	vfprintf(stdout, fmt, ap);
	va_end(ap);
	fputc('\n', stdout);
	fflush(stdout);
}

/* ---- flat-object JSON extractors (exact top-level key, not strstr) -----------------------
 * Our protocol objects are flat: {"id":1,"op":"watch","tgid":42,"decrypt":1}. json_value walks
 * the object once and matches each member key by its FULL length, so "port" never matches
 * "engine_port" and a key that appears inside a string value is never picked up (D36 must-fix). */
static const char *json_value(const char *s, const char *key)
{
	const char *p = s;
	size_t keylen = strlen(key);
	while (*p && *p != '{') p++;
	if (*p == '{') p++;
	for (;;) {
		while (*p == ' ' || *p == '\t' || *p == ',' || *p == '\n' || *p == '\r') p++;
		if (*p != '"') return NULL; /* '}', NUL, or malformed -> no more members */
		const char *ks = ++p;
		while (*p && *p != '"') { if (*p == '\\' && p[1]) p += 2; else p++; }
		if (*p != '"') return NULL; /* unterminated key */
		size_t klen = (size_t)(p - ks);
		p++; /* past closing quote of the key */
		while (*p == ' ' || *p == '\t') p++;
		if (*p != ':') return NULL;
		p++;
		while (*p == ' ' || *p == '\t') p++;
		const char *vs = p;
		/* Skip this value to reach the next member. STRICTLY bounded: every branch stops at the
		 * terminating NUL and never advances past it, so a crafted unterminated string inside a
		 * nested value cannot make us read past the end of the line (D36 parser fix). */
		if (*p == '"') {
			p++;
			while (*p && *p != '"') { if (*p == '\\' && p[1]) p += 2; else p++; }
			if (*p != '"') return NULL; /* unterminated string value */
			p++;
		} else if (*p == '{' || *p == '[') {
			int depth = 0;
			while (*p) {
				char c = *p;
				if (c == '"') { /* a (possibly escaped) string inside the nested value */
					p++;
					while (*p && *p != '"') { if (*p == '\\' && p[1]) p += 2; else p++; }
					if (*p != '"') return NULL; /* unterminated string inside nested value */
					p++;
					continue;
				}
				if (c == '{' || c == '[') depth++;
				else if (c == '}' || c == ']') { depth--; if (depth == 0) { p++; break; } }
				p++;
			}
			if (depth != 0) return NULL; /* unbalanced / unterminated nested value */
		} else {
			while (*p && *p != ',' && *p != '}') p++;
		}
		if (klen == keylen && strncmp(ks, key, keylen) == 0) return vs;
	}
}
static int json_num(const char *s, const char *key, long long *out)
{
	const char *p = json_value(s, key);
	if (!p) return 0;
	char *end;
	long long v = strtoll(p, &end, 10);
	if (end == p) return 0;
	*out = v;
	return 1;
}
static int json_str(const char *s, const char *key, char *out, size_t n)
{
	const char *p = json_value(s, key);
	if (!p || *p != '"') return 0;
	p++;
	size_t i = 0;
	while (*p && *p != '"' && i + 1 < n) {
		if (*p == '\\' && p[1]) p++; /* keep it simple: copy the escaped char literally */
		out[i++] = *p++;
	}
	out[i] = 0;
	return 1;
}

/* 0, or the negative errno of a failed map write: the caller answers ok:false with it, never a false ok (D38 D-15). */
static int write_config(void)
{
	__u32 k = 0;
	return bpf_map__update_elem(skel->maps.config_map, &k, sizeof(k), &cur_cfg, sizeof(cur_cfg), BPF_ANY);
}
static void reply_rc(long long id, int rc, const char *what)
{
	if (rc == 0) emitf("{\"id\":%lld,\"ok\":true}", id);
	else emitf("{\"id\":%lld,\"ok\":false,\"error\":\"%s failed: %s\"}", id, what, strerror(rc < 0 ? -rc : rc));
}

/* ---- ring buffer: emit exec/exit/flow as event lines ---- */
static void fmt_ip4(__u32 net, char *out, size_t n)
{
	struct in_addr a = { .s_addr = net };
	inet_ntop(AF_INET, &a, out, n);
}
static void fmt_ip6(const __u32 *net, char *out, size_t n)
{
	struct in6_addr a;
	memcpy(&a, net, 16);
	inet_ntop(AF_INET6, &a, out, n);
}
static void json_escape(const char *in, char *out, size_t n)
{
	size_t i = 0;
	for (const char *p = in; *p && i + 2 < n; p++) {
		if (*p == '"' || *p == '\\') { out[i++] = '\\'; out[i++] = *p; }
		else if ((unsigned char)*p < 0x20) { i += snprintf(out + i, n - i, "\\u%04x", *p); }
		else out[i++] = *p;
	}
	out[i] = 0;
}
static int on_event(void *ctx, void *data, size_t sz)
{
	(void)ctx; (void)sz;
	struct asight_event *e = data;
	if (e->type == ASIGHT_EV_EXEC) {
		char comm[64], fn[256], cesc[160], fesc[600];
		snprintf(comm, sizeof(comm), "%.*s", ASIGHT_COMM_LEN, e->comm);
		snprintf(fn, sizeof(fn), "%.*s", ASIGHT_FILE_LEN, e->filename);
		json_escape(comm, cesc, sizeof(cesc));
		json_escape(fn, fesc, sizeof(fesc));
		emitf("{\"ev\":\"exec\",\"tgid\":%u,\"pid\":%u,\"comm\":\"%s\",\"filename\":\"%s\",\"ts_ns\":%llu}",
		      e->tgid, e->pid, cesc, fesc, (unsigned long long)e->ts_ns);
	} else if (e->type == ASIGHT_EV_EXIT) {
		emitf("{\"ev\":\"exit\",\"tgid\":%u,\"ts_ns\":%llu}", e->tgid, (unsigned long long)e->ts_ns);
	} else if (e->type == ASIGHT_EV_FLOW) {
		char ip[64];
		if (e->family == 4) fmt_ip4(e->daddr4, ip, sizeof(ip));
		else fmt_ip6(e->daddr6, ip, sizeof(ip));
		emitf("{\"ev\":\"flow\",\"pid\":%u,\"dst\":{\"address\":\"%s\",\"port\":%u,\"family\":%u},\"ts_ns\":%llu}",
		      e->pid, ip, ntohs(e->dport), e->family, (unsigned long long)e->ts_ns);
	}
	return 0;
}

/* ---- ops ---- */
/* 0, or the negative errno (D-14: `attach failed` says why). */
static int do_attach(void)
{
	int cg = open(CGROUP_ROOT, O_RDONLY);
	if (cg < 0) return -errno;
	struct bpf_program *progs[3] = {
		skel->progs.asight_connect4, skel->progs.asight_connect6, skel->progs.asight_sockops,
	};
	/* sockops FIRST, then connect4 / connect6. connect4/6 steer a connection from the instant they are attached (and stash its original destination
	 * under the socket cookie), and only sockops moves that stash to by_port at ACTIVE_ESTABLISHED. With the order the other way round, a connection
	 * made between the two attaches was steered with no sockops to record where it was going: the engine accepted it, found no original destination
	 * and closed it, a new connection reset in its handshake (S5b; collector-switch S5 on the real daemon). The reverse of do_detach, which removes
	 * connect4/6 first and sockops last. cg_links keeps its own order: [0]=connect4, [1]=connect6, [2]=sockops. */
	static const int order[3] = { 2, 0, 1 };
	for (int n = 0; n < 3; n++) {
		int i = order[n];
		if (cg_links[i]) continue; /* idempotent */
		cg_links[i] = bpf_program__attach_cgroup(progs[i], cg);
		if (!cg_links[i]) {
			int err = errno ? -errno : -EINVAL; /* libbpf sets errno on a NULL link */
			for (int j = 0; j < 3; j++) { if (cg_links[j]) { bpf_link__destroy(cg_links[j]); cg_links[j] = NULL; } } /* all or nothing */
			close(cg);
			return err;
		}
	}
	close(cg);
	cur_cfg.attached = 1;
	(void)write_config(); /* `attached` is an informational mirror the BPF side never reads; status reads the links */
	return 0;
}
static void do_detach(void)
{
	/* Remove connect4/connect6 first so no NEW connection is steered, then briefly drain so a
	 * connection connect4 just steered still reaches sockops (which copies its original dst to
	 * by_port at ACTIVE_ESTABLISHED) before sockops is removed — otherwise the engine would get
	 * an unresolvable connection and break it (S5: zero client errors under rapid toggling).
	 * cg_links order is [0]=connect4, [1]=connect6, [2]=sockops. */
	int had_connect = cg_links[0] || cg_links[1];
	if (cg_links[0]) { bpf_link__destroy(cg_links[0]); cg_links[0] = NULL; }
	if (cg_links[1]) { bpf_link__destroy(cg_links[1]); cg_links[1] = NULL; }
	if (had_connect && cg_links[2]) usleep(50000); /* drain in-flight steered handshakes */
	if (cg_links[2]) { bpf_link__destroy(cg_links[2]); cg_links[2] = NULL; }
	cur_cfg.attached = 0;
	(void)write_config(); /* informational mirror, see do_attach */
}

/* CapEff of this process, as the raw hex capability mask from /proc/self/status. */
static void read_cap_eff(char *out, size_t n)
{
	snprintf(out, n, "unknown");
	FILE *f = fopen("/proc/self/status", "r");
	if (!f) return;
	char line[256];
	while (fgets(line, sizeof(line), f)) {
		if (strncmp(line, "CapEff:", 7) == 0) {
			char *v = line + 7;
			while (*v == ' ' || *v == '\t') v++;
			char *nl = strchr(v, '\n'); if (nl) *nl = 0;
			snprintf(out, n, "%.32s", v); /* CapEff is 16 hex digits; bound it (-Wformat-truncation) */
			break;
		}
	}
	fclose(f);
}

/* Kernel version tier: 2 => >=5.19 (a full capability drop is possible, Extension), 1 => >=5.15. */
static int kernel_tier(unsigned *maj_out, unsigned *min_out)
{
	struct utsname u;
	unsigned maj = 0, min = 0;
	if (uname(&u) == 0) sscanf(u.release, "%u.%u", &maj, &min);
	if (maj_out) *maj_out = maj;
	if (min_out) *min_out = min;
	if (maj > 5 || (maj == 5 && min >= 19)) return 2;
	if (maj == 5 && min >= 15) return 1;
	return 0;
}

/* The real uid of a tgid, read from /proc/<tgid>/status (the first field of the Uid: line), or
 * (uid_t)-1 if it can't be read. */
static uid_t proc_real_uid(__u32 tgid)
{
	char path[64];
	snprintf(path, sizeof(path), "/proc/%u/status", tgid);
	FILE *f = fopen(path, "r");
	if (!f) return (uid_t)-1;
	char line[256];
	uid_t ruid = (uid_t)-1;
	while (fgets(line, sizeof(line), f)) {
		if (strncmp(line, "Uid:", 4) == 0) {
			unsigned long r = 0;
			if (sscanf(line + 4, "%lu", &r) == 1) ruid = (uid_t)r;
			break;
		}
	}
	fclose(f);
	return ruid;
}

/* The `drops` counters summed over the CPUs, as a JSON object by reason (asight.h ASIGHT_DROP_*), or null when they
 * cannot be read — unknown, never zero (D38 D-16). */
static void read_drops(char *out, size_t n)
{
	static const char *names[ASIGHT_DROP_MAX] = { "no-config", "hb-stale", "no-listener", "orig-write", "byport-write", "ringbuf-full" };
	int ncpu = libbpf_num_possible_cpus();
	snprintf(out, n, "null");
	if (ncpu <= 0) return;
	__u64 *vals = calloc((size_t)ncpu, sizeof(__u64));
	if (!vals) return;
	size_t off = (size_t)snprintf(out, n, "{");
	for (__u32 k = 0; k < ASIGHT_DROP_MAX; k++) {
		__u64 sum = 0;
		if (bpf_map__lookup_elem(skel->maps.drops, &k, sizeof(k), vals, sizeof(__u64) * (size_t)ncpu, 0) != 0) {
			snprintf(out, n, "null");
			free(vals);
			return;
		}
		for (int c = 0; c < ncpu; c++) sum += vals[c];
		off += (size_t)snprintf(out + off, n - off, "%s\"%s\":%llu", k ? "," : "", names[k], (unsigned long long)sum);
		if (off >= n) { snprintf(out, n, "null"); free(vals); return; }
	}
	snprintf(out + off, n - off, "}");
	free(vals);
}

static void reply_status(long long id)
{
	__u64 hb = cur_cfg.hb_ns;
	long long age = hb ? (long long)((monotonic_ns() - hb) / 1000000ULL) : -1;
	char links[512];
	size_t off = 0;
	int live = 0;
	links[0] = 0;
	/* attached is derived from the kernel's actual link state (links the kernel still confirms),
	 * never from a cached flag (spec §开关语义: 状态 MUST 来自内核实际态). */
	for (int i = 0; i < 3; i++) {
		if (!cg_links[i]) continue;
		struct bpf_link_info info;
		__u32 len = sizeof(info);
		memset(&info, 0, sizeof(info));
		if (bpf_link_get_info_by_fd(bpf_link__fd(cg_links[i]), &info, &len) == 0) {
			live++;
			off += snprintf(links + off, sizeof(links) - off, "%s{\"name\":\"%s\",\"id\":%u,\"prog_id\":%u}",
					off ? "," : "", cg_names[i], info.id, info.prog_id);
		}
	}
	char cap_eff[64];
	read_cap_eff(cap_eff, sizeof(cap_eff));
	unsigned kmaj = 0, kmin = 0;
	int tier = kernel_tier(&kmaj, &kmin);
	char drops[256];
	read_drops(drops, sizeof(drops));
	emitf("{\"id\":%lld,\"ok\":true,\"attached\":%s,\"engine_port\":%u,\"hb_age_ms\":%lld,"
	      "\"cap_eff\":\"%s\",\"kernel\":\"%u.%u\",\"kernel_tier\":%d,\"links\":[%s],\"drops\":%s}",
	      id, live == 3 ? "true" : "false", cur_cfg.engine_port, age, cap_eff, kmaj, kmin, tier, links, drops);
}

static void reply_lookup(long long id, long long port, long long family)
{
	struct asight_portkey k = {};
	k.sport = (__u16)port;
	k.family = (__u8)(family ? family : 4);
	struct asight_orig o;
	/* lookup-and-delete: a by_port row is for exactly one accepted connection, so consume it on
	 * read — otherwise a later connection reusing the same {sport,family} sees a stale dst (D36). */
	if (bpf_map__lookup_and_delete_elem(skel->maps.by_port, &k, sizeof(k), &o, sizeof(o), 0) != 0) {
		emitf("{\"id\":%lld,\"ok\":true,\"found\":false,\"dst\":null,\"pid\":null,\"decrypt\":0}", id);
		return;
	}
	char ip[64];
	if (o.family == 4) fmt_ip4(o.ip4, ip, sizeof(ip));
	else fmt_ip6(o.ip6, ip, sizeof(ip));
	emitf("{\"id\":%lld,\"ok\":true,\"found\":true,\"dst\":{\"address\":\"%s\",\"port\":%u,\"family\":%u},\"pid\":%u,\"decrypt\":%u}",
	      id, ip, ntohs(o.port), o.family, o.pid, o.decrypt);
}

static void dispatch(const char *line)
{
	char op[32];
	if (!json_str(line, "op", op, sizeof(op))) return;
	long long id = -1, v, v2;
	json_num(line, "id", &id);

	if (!strcmp(op, "ping")) { emitf("{\"id\":%lld,\"ok\":true}", id); return; }
	if (!strcmp(op, "config")) {
		if (json_num(line, "engine_port", &v)) cur_cfg.engine_port = (__u16)v;
		reply_rc(id, write_config(), "config map write");
		return;
	}
	if (!strcmp(op, "attach")) { reply_rc(id, do_attach(), "attach"); return; }
	if (!strcmp(op, "detach")) { do_detach(); emitf("{\"id\":%lld,\"ok\":true}", id); return; }
	/* a beat the kernel never saw is not a beat: steering lapses 2 s later, so say so (D-15) */
	if (!strcmp(op, "heartbeat")) { cur_cfg.hb_ns = monotonic_ns(); reply_rc(id, write_config(), "heartbeat (config map write)"); return; }
	if (!strcmp(op, "watch")) {
		if (!json_num(line, "tgid", &v)) { emitf("{\"id\":%lld,\"ok\":false,\"error\":\"no tgid\"}", id); return; }
		__u32 tgid = (__u32)v;
		/* Only the owner may watch their own processes. A cross-uid watch request (or watching a
		 * process that has already gone) is refused — defense in depth on top of the kernel
		 * owner_uid filter (D36). */
		uid_t ruid = proc_real_uid(tgid);
		if (ruid != getuid()) { emitf("{\"id\":%lld,\"ok\":false,\"error\":\"tgid not owned by this user\"}", id); return; }
		long long d = 0; json_num(line, "decrypt", &d);
		struct asight_verdict ver = { .decrypt = d ? 1 : 0 };
		reply_rc(id, bpf_map__update_elem(skel->maps.watch_map, &tgid, sizeof(tgid), &ver, sizeof(ver), BPF_ANY), "watch map update");
		return;
	}
	if (!strcmp(op, "unwatch")) {
		if (!json_num(line, "tgid", &v)) { emitf("{\"id\":%lld,\"ok\":false,\"error\":\"no tgid\"}", id); return; }
		__u32 tgid = (__u32)v;
		int rc = bpf_map__delete_elem(skel->maps.watch_map, &tgid, sizeof(tgid), 0);
		reply_rc(id, rc == -ENOENT ? 0 : rc, "unwatch map delete"); /* already gone (the exit hook dropped it) is fine */
		return;
	}
	if (!strcmp(op, "status")) { reply_status(id); return; }
	if (!strcmp(op, "lookup")) {
		if (!json_num(line, "port", &v)) { emitf("{\"id\":%lld,\"ok\":false,\"error\":\"no port\"}", id); return; }
		if (!json_num(line, "family", &v2)) v2 = 4;
		reply_lookup(id, v, v2);
		return;
	}
	emitf("{\"id\":%lld,\"ok\":false,\"error\":\"unknown op\"}", id);
}

/* Load the skeleton, bake rodata, load, and attach the two tp_btf tracepoints + the ringbuf.
 * Everything that needs cap_net_admin/cap_perfmon/cap_bpf happens here, before the drop. The
 * cgroup links are attached later (on `attach`); link_create needs no capability. */
static int load_and_prepare(void)
{
	libbpf_set_strict_mode(LIBBPF_STRICT_ALL);
	skel = asight__open();
	if (!skel) return -1;
	skel->rodata->owner_uid = getuid();     /* only this uid is ever steered/reported */
	skel->rodata->engine_tgid = g_parent_pid; /* the engine's own dials are never steered */
	if (asight__load(skel)) { asight__destroy(skel); skel = NULL; return -1; }
	/* tracepoints stay attached across on/off (spec §开关语义: exec/exit 跟踪不摘) */
	if (!bpf_program__attach(skel->progs.asight_exec)) return -1;
	if (!bpf_program__attach(skel->progs.asight_exit)) return -1;
	rb = ring_buffer__new(bpf_map__fd(skel->maps.events), on_event, NULL, NULL);
	if (!rb) return -1;
	return 0;
}

/* Drop to CAP_BPF only, forbid regaining privilege (NNP), stay non-dumpable. Called after
 * load_and_prepare so no further privileged load is needed; map edits, link_create, link info
 * and lookup-and-delete all work under CAP_BPF alone (D36 §2). */
static int lock_down(void)
{
	prctl(PR_SET_DUMPABLE, 0, 0, 0, 0);          /* a file-caps exec already clears this; be explicit */
	if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return -1;
	struct __user_cap_header_struct hdr = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
	struct __user_cap_data_struct data[2];
	memset(data, 0, sizeof(data));
	data[CAP_BPF >> 5].effective |= (1u << (CAP_BPF & 31));
	data[CAP_BPF >> 5].permitted |= (1u << (CAP_BPF & 31));
	/* inheritable stays empty */
	if (syscall(SYS_capset, &hdr, data) != 0) return -1;
	return 0;
}

static int check_environment(void)
{
	struct statfs sf;
	if (statfs(CGROUP_ROOT, &sf) != 0 || (unsigned long)sf.f_type != CGROUP2_SUPER_MAGIC) {
		fprintf(stderr, "asight-redirector: %s is not a cgroup2 mount (unified hierarchy required)\n", CGROUP_ROOT);
		return -1;
	}
	unsigned maj = 0, min = 0;
	kernel_tier(&maj, &min);
	if (maj < ASIGHT_MIN_KMAJOR || (maj == ASIGHT_MIN_KMAJOR && min < ASIGHT_MIN_KMINOR)) {
		fprintf(stderr, "asight-redirector: kernel %u.%u is below the %u.%u floor\n",
			maj, min, (unsigned)ASIGHT_MIN_KMAJOR, (unsigned)ASIGHT_MIN_KMINOR);
		return -1;
	}
	return 0;
}

static void cleanup(void)
{
	do_detach();
	if (rb) ring_buffer__free(rb);
	if (skel) asight__destroy(skel); /* destroys ALL links -> auto-detach, no residue */
}

/* argv: exactly `--selftest` or `--parent-pid <n>` (plus an optional `--parent-pid` alongside
 * selftest, ignored there). Any other flag is a hard error — fixed, minimal surface (D36). */
static int parse_argv(int argc, char **argv, int *selftest, long *parent_pid)
{
	*selftest = 0;
	*parent_pid = -1;
	for (int i = 1; i < argc; i++) {
		if (!strcmp(argv[i], "--selftest")) { *selftest = 1; continue; }
		if (!strcmp(argv[i], "--parent-pid")) {
			if (i + 1 >= argc) return -1;
			char *end;
			long v = strtol(argv[++i], &end, 10);
			if (*end != 0 || v <= 0) return -1;
			*parent_pid = v;
			continue;
		}
		return -1; /* unknown flag */
	}
	return 0;
}

int main(int argc, char **argv)
{
	int selftest;
	long parent_pid;

	if (parse_argv(argc, argv, &selftest, &parent_pid) != 0) {
		fprintf(stderr, "usage: asight-redirector --parent-pid <engine-pid> | --selftest\n");
		return 2;
	}
	/* Drop the environment immediately: nothing below reads it, and a same-uid agent must not be
	 * able to steer libbpf/loader behaviour through inherited env (D36). */
	clearenv();

	/* PDEATHSIG is cleared by the file-caps exec, so (re)set it here, before the getppid check,
	 * so we die with the engine even if it exits during startup. */
	prctl(PR_SET_PDEATHSIG, SIGKILL);
	signal(SIGINT, on_signal);
	signal(SIGTERM, on_signal);
	signal(SIGPIPE, SIG_IGN);

	if (!selftest) {
		if (parent_pid < 0) { fprintf(stderr, "asight-redirector: --parent-pid is required\n"); return 2; }
		if (getppid() != (pid_t)parent_pid) { fprintf(stderr, "asight-redirector: parent pid mismatch\n"); return 3; }
		g_parent_pid = (__u32)parent_pid;
	}

	if (check_environment() != 0) return 4;

	if (load_and_prepare()) { fprintf(stderr, "asight-redirector: load failed\n"); cleanup(); return 1; }

	if (lock_down() != 0) { fprintf(stderr, "asight-redirector: privilege lock-down failed\n"); cleanup(); return 5; }

	if (selftest) {
		cur_cfg.engine_port = 18999;
		if (write_config()) { fprintf(stderr, "selftest: config map write failed\n"); cleanup(); return 1; }
		int rc = do_attach();
		if (rc) { fprintf(stderr, "selftest: attach failed: %s\n", strerror(-rc)); cleanup(); return 1; }
		reply_status(0);
		do_detach();
		reply_status(1);
		cleanup();
		return 0;
	}

	emitf("{\"ev\":\"ready\",\"pid\":%d,\"proto\":%d,\"build\":\"%s\"}", getpid(), ASIGHT_PROTO, ASIGHT_BUILD_HASH);

	int rb_fd = ring_buffer__epoll_fd(rb);
	static char buf[8192];
	size_t fill = 0;
	int skipping = 0; /* dropping the tail of an oversize line until its newline */
	while (!stop) {
		struct pollfd pfds[2] = {
			{ .fd = STDIN_FILENO, .events = POLLIN },
			{ .fd = rb_fd, .events = POLLIN },
		};
		int r = poll(pfds, 2, 500);
		if (r < 0) { if (errno == EINTR) continue; break; }
		if (pfds[1].revents & POLLIN) ring_buffer__poll(rb, 0);
		if (pfds[0].revents & (POLLIN | POLLHUP)) {
			ssize_t n = read(STDIN_FILENO, buf + fill, sizeof(buf) - fill - 1);
			if (n == 0) break;                 /* real EOF -> parent closed stdin -> exit */
			if (n < 0) { if (errno == EINTR) continue; break; }
			fill += (size_t)n;
			buf[fill] = 0;
			char *nl;
			while ((nl = memchr(buf, '\n', fill))) {
				*nl = 0;
				if (skipping) skipping = 0;        /* this newline ends the dropped oversize line */
				else if (*buf) dispatch(buf);
				size_t consumed = (size_t)(nl - buf) + 1;
				memmove(buf, nl + 1, fill - consumed);
				fill -= consumed;
				buf[fill] = 0;
			}
			/* A full buffer with no newline is an oversize line: drop it and skip to the next
			 * newline. Crucially this is NOT treated as EOF (the old bug: read() of 0 bytes). */
			if (fill == sizeof(buf) - 1) {
				emitf("{\"ev\":\"error\",\"reason\":\"oversize line dropped\"}");
				fill = 0;
				skipping = 1;
			}
		}
	}
	emitf("{\"ev\":\"down\",\"reason\":\"loader exiting\"}");
	cleanup();
	return 0;
}
