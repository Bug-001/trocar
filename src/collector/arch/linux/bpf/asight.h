/* asight Linux redirector — structs shared between the BPF program and the C loader.
 * Spec: spec/01-asight-rfc/4.6-process-collector.md §Linux 机制. No kernel-only types here,
 * so the userspace loader can include it directly. */
#ifndef ASIGHT_BPF_H
#define ASIGHT_BPF_H

/* Event types pushed on the ring buffer to userspace. */
#define ASIGHT_EV_EXEC 1
#define ASIGHT_EV_EXIT 2
#define ASIGHT_EV_FLOW 3 /* watched process, verdict=no-decrypt: report {pid,dst}, do not steer */

#define ASIGHT_COMM_LEN 16
#define ASIGHT_FILE_LEN 128

/* Original destination of a steered (or reported) connection. Addresses/ports are kept in
 * NETWORK byte order exactly as they appeared in the connect() call, so userspace can report
 * them verbatim. family is 4 or 6. */
struct asight_orig {
	__u8 family;	/* 4 | 6 */
	__u8 decrypt;	/* 1 = steered, 0 = reported only */
	__u16 port;	/* network byte order */
	__u32 pid;	/* tgid of the connecting process */
	__u32 ip4;	/* network byte order (family==4) */
	__u32 ip6[4];	/* network byte order (family==6) */
};

/* One ring-buffer record. */
struct asight_event {
	__u8 type;	/* ASIGHT_EV_* */
	__u8 family;	/* for FLOW: 4 | 6 */
	__u16 dport;	/* for FLOW: network byte order */
	__u32 pid;	/* tgid */
	__u32 tgid;	/* same as pid for leader events; kept explicit for clarity */
	__u64 ts_ns;	/* bpf_ktime_get_ns() */
	__u32 daddr4;	/* for FLOW family==4: network byte order */
	__u32 daddr6[4];/* for FLOW family==6: network byte order */
	char comm[ASIGHT_COMM_LEN];
	char filename[ASIGHT_FILE_LEN];
};

/* Per-tgid watch verdict. */
struct asight_verdict {
	__u8 decrypt;	/* 1 = steer this process's new TCP connects, 0 = report metadata only */
};

/* by_port key: the client source port plus its address family (D36). Keyed on both so a v4 and a
 * v6 connection that happen to share a source port never collide into one row. _pad is always
 * zeroed so the 4-byte key is byte-identical on the BPF and the userspace side. */
struct asight_portkey {
	__u16 sport;	/* client source port, host byte order */
	__u8 family;	/* 4 | 6 */
	__u8 _pad;	/* always 0 */
};

/* Singleton config (ARRAY map index 0). D36: engine_uid is gone — the loader now bakes the
 * owner uid and the engine tgid into BPF rodata (const volatile), set before asight__load, so
 * neither can be changed over the protocol at runtime. */
struct asight_config {
	__u16 engine_port;	/* host byte order; 0 = unset */
	__u8 attached;		/* informational mirror of the cgroup-link state */
	__u64 hb_ns;		/* last heartbeat, CLOCK_MONOTONIC ns (== bpf_ktime_get_ns clock) */
};

#define ASIGHT_HEARTBEAT_STALE_NS (2000ULL * 1000ULL * 1000ULL) /* 2 s */

#endif /* ASIGHT_BPF_H */
