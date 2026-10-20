// socktable.c — the TCP sockets of this user's processes, one line each (RFC 4.9 §5.3 `socktable.mjs`, §10 `netfacts.mjs`).
// macOS 27 hands the kernel's TCP table (the pcblist sysctl `netstat` reads) only to callers it trusts: under an ad-hoc-signed
// ancestor such as a Nix- or Homebrew-built node, `netstat -anv -p tcp` prints nothing and the sysctl returns no entries (measured
// on a macOS machine 2026-10-20: 226 sockets counted, 0 returned). What a process may always read is its own user's processes: their
// fd lists (proc_pidinfo PROC_PIDLISTFDS) and each socket's addresses (proc_pidfdinfo PROC_PIDFDSOCKETINFO) — one pass over this
// user's processes, about 5 ms on a macOS machine. Another user's processes are not readable and are simply not listed.
// Usage: socktable (no arguments). Output, one TCP socket per line, a socket shared by several processes once per holder:
//   <pid> <state> <local address> <local port> <foreign address> <foreign port>
// state is the TCP state's name as netstat prints it (LISTEN, ESTABLISHED, ...); addresses are inet_ntop text (an IPv4 socket's
// IPv4 text, an IPv6 one's IPv6 text). A process that exits or closes the fd while it is read is skipped, never guessed.
// Failure: the errno text on stderr, exit 1 (the process list itself could not be read); any argument: exit 2.
// Build: scripts/build-darwin-native.sh.
#include <arpa/inet.h>
#include <errno.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <unistd.h>

static const char *STATE[] = {"CLOSED", "LISTEN", "SYN_SENT", "SYN_RECEIVED", "ESTABLISHED", "CLOSE_WAIT", "FIN_WAIT_1",
                              "CLOSING", "LAST_ACK", "FIN_WAIT_2", "TIME_WAIT"};

static void addr(const struct in_sockinfo *in, int local, char *out, size_t n) {
  if (in->insi_vflag & INI_IPV4) {
    const struct in_addr *a = local ? &in->insi_laddr.ina_46.i46a_addr4 : &in->insi_faddr.ina_46.i46a_addr4;
    inet_ntop(AF_INET, a, out, (socklen_t)n);
  } else {
    inet_ntop(AF_INET6, local ? &in->insi_laddr.ina_6 : &in->insi_faddr.ina_6, out, (socklen_t)n);
  }
}

int main(int argc, char **argv) {
  (void)argv;
  if (argc != 1) { fprintf(stderr, "usage: socktable\n"); return 2; }
  int bytes = proc_listpids(PROC_UID_ONLY, getuid(), NULL, 0);
  if (bytes <= 0) { fprintf(stderr, "socktable: proc_listpids: %s\n", strerror(errno)); return 1; }
  pid_t *pids = malloc((size_t)bytes * 2); // room for processes started between the two asks
  bytes = proc_listpids(PROC_UID_ONLY, getuid(), pids, bytes * 2);
  if (!pids || bytes <= 0) { fprintf(stderr, "socktable: proc_listpids: %s\n", strerror(errno)); return 1; }
  for (int i = 0; i < bytes / (int)sizeof(pid_t); i++) {
    pid_t pid = pids[i];
    if (pid <= 0) continue;
    int sz = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
    if (sz <= 0) continue;
    struct proc_fdinfo *fds = malloc((size_t)sz);
    sz = fds ? proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, sz) : 0;
    for (int j = 0; j < sz / (int)sizeof(*fds); j++) {
      if (fds[j].proc_fdtype != PROX_FDTYPE_SOCKET) continue;
      struct socket_fdinfo s;
      if (proc_pidfdinfo(pid, fds[j].proc_fd, PROC_PIDFDSOCKETINFO, &s, sizeof s) < (int)sizeof s) continue;
      if (s.psi.soi_kind != SOCKINFO_TCP) continue;
      const struct in_sockinfo *in = &s.psi.soi_proto.pri_tcp.tcpsi_ini;
      if (!(in->insi_vflag & (INI_IPV4 | INI_IPV6))) continue;
      int st = s.psi.soi_proto.pri_tcp.tcpsi_state;
      char la[INET6_ADDRSTRLEN], fa[INET6_ADDRSTRLEN];
      addr(in, 1, la, sizeof la);
      addr(in, 0, fa, sizeof fa);
      printf("%d %s %s %d %s %d\n", pid, st >= 0 && st < (int)(sizeof STATE / sizeof *STATE) ? STATE[st] : "UNKNOWN", la,
             ntohs((unsigned short)in->insi_lport), fa, ntohs((unsigned short)in->insi_fport));
    }
    free(fds);
  }
  free(pids);
  return 0;
}
