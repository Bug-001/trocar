/* trocar Linux redirector — structs shared between the BPF program and the C loader.
 * Spec: spec/01-trocar-rfc/4.6-process-collector.md §Linux 机制. No kernel-only types here,
 * so the userspace loader can include it directly. */
#ifndef TROCAR_BPF_H
#define TROCAR_BPF_H

/* Event types pushed on the ring buffer to userspace. */
#define TROCAR_EV_EXEC 1
#define TROCAR_EV_EXIT 2
#define TROCAR_EV_FLOW 3 /* watched process, verdict=no-decrypt: report {pid,dst}, do not steer */

#define TROCAR_COMM_LEN 16
#define TROCAR_FILE_LEN 128

/* Original destination of a steered (or reported) connection. Addresses/ports are kept in
 * NETWORK byte order exactly as they appeared in the connect() call, so userspace can report
 * them verbatim. family is 4 or 6. */
struct trocar_orig {
	__u8 family;	/* 4 | 6 */
	__u8 decrypt;	/* 1 = steered, 0 = reported only */
	__u16 port;	/* network byte order */
	__u32 pid;	/* tgid of the connecting process */
	__u32 ip4;	/* network byte order (family==4) */
	__u32 ip6[4];	/* network byte order (family==6) */
};

/* One ring-buffer record. */
struct trocar_event {
	__u8 type;	/* TROCAR_EV_* */
	__u8 family;	/* for FLOW: 4 | 6 */
	__u16 dport;	/* for FLOW: network byte order */
	__u32 pid;	/* tgid */
	__u32 tgid;	/* same as pid for leader events; kept explicit for clarity */
	__u64 ts_ns;	/* bpf_ktime_get_ns() */
	__u32 daddr4;	/* for FLOW family==4: network byte order */
	__u32 daddr6[4];/* for FLOW family==6: network byte order */
	char comm[TROCAR_COMM_LEN];
	char filename[TROCAR_FILE_LEN];
};

/* Per-tgid watch verdict. */
struct trocar_verdict {
	__u8 decrypt;	/* 1 = steer this process's new TCP connects, 0 = report metadata only */
};

/* by_port key: the client source port plus its address family (D36). Keyed on both so a v4 and a
 * v6 connection that happen to share a source port never collide into one row. _pad is always
 * zeroed so the 4-byte key is byte-identical on the BPF and the userspace side. */
struct trocar_portkey {
	__u16 sport;	/* client source port, host byte order */
	__u8 family;	/* 4 | 6 */
	__u8 _pad;	/* always 0 */
};

/* Singleton config (ARRAY map index 0). D36: engine_uid is gone — the loader now bakes the
 * owner uid and the engine tgid into BPF rodata (const volatile), set before trocar__load, so
 * neither can be changed over the protocol at runtime. */
struct trocar_config {
	__u16 engine_port;	/* host byte order; 0 = unset */
	__u8 attached;		/* informational mirror of the cgroup-link state */
	__u64 hb_ns;		/* last heartbeat, CLOCK_MONOTONIC ns (== bpf_ktime_get_ns clock) */
};

#define TROCAR_HEARTBEAT_STALE_NS (2000ULL * 1000ULL * 1000ULL) /* 2 s */

/* D38 (D-16): per-CPU counters (PERCPU_ARRAY `drops`, index = reason) of what the kernel side let go direct or could
 * not report, so it is never silent. The helper sums the CPUs into status `drops`; the daemon turns increases into
 * kernel-drops failure events. Names in redirector.c read_drops(), same order. */
#define TROCAR_DROP_NO_CONFIG    0 /* a watched decrypt connection, but no config / no engine port: not rewritten */
#define TROCAR_DROP_HB_STALE     1 /* heartbeat older than 2 s (daemon stuck, helper not beating): not rewritten */
#define TROCAR_DROP_NO_LISTENER  2 /* nobody listens on the engine port: not rewritten */
#define TROCAR_DROP_ORIG_WRITE   3 /* orig_dst could not be written: not rewritten (the engine could not look it up) */
#define TROCAR_DROP_BYPORT_WRITE 4 /* by_port could not be written at ESTABLISHED: the engine's lookup will miss */
#define TROCAR_DROP_RINGBUF_FULL 5 /* an exec / exit / flow event did not fit the ring buffer */
#define TROCAR_DROP_MAX          6

#endif /* TROCAR_BPF_H */
