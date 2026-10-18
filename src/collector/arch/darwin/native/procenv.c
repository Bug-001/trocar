// procenv.c — the LAUNCH environment of one process (RFC 4.11 P7 `proc.envOf` on macOS, M2)
// Read the one way a non-root user can: sysctl {CTL_KERN, KERN_PROCARGS2, pid} (same user only).
// The buffer: int argc; exec_path NUL; NUL padding; argv[0..argc-1] NUL each; env strings NUL each; an empty string; then the
// kernel's "apple" strings (executable_path=, ptr_munge=, ...). These are the bytes in the target's memory now: in-place writes
// show, libc setenv / putenv / unsetenv after launch do not.
// Usage: procenv <pid> <NAME>... Answers only the named variables, never the whole environment (RFC 4.9 §5.2): each launch entry
// whose name equals one of NAME exactly ("NAME=value", case-sensitive) is printed followed by one NUL, on stdout, exit 0.
// Two facts of the process that are no environment entry are asked for by the names `:exe` and `:cwd`, which no environment entry
// can have (a ':' is not in a variable name), and answered in the same `NAME=value NUL` records: `:exe` is the REAL executable —
// the path the kernel exec'd (the first string of this same buffer), resolved, so a program started through a symlink or as a bare
// word on PATH names its file — and `:cwd` the current directory, from proc_pidinfo(PROC_PIDVNODEPATHINFO) (an already resolved
// vnode path). Both are the same user's processes only, as the environment is; a fact that cannot be read is simply absent from the
// answer, never guessed (RFC 4.8 W4). They replace the `lsof` asks of RFC 4.9 §5.3 (one 3 ms helper, not a walk of every process's
// file table).
// Failure: the errno text on stderr, exit 1; bad argv (no pid, no name, a name with '=' or empty): exit 2.
// Build: scripts/build-darwin-native.sh.
#include <errno.h>
#include <libproc.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>

static int is_apple(const char *s) {
  static const char *keys[] = {"ptr_munge=", "main_stack=", "executable_file=", "dyld_file=", "executable_cdhash=",
                               "executable_boothash=", "th_port=", "arm64e_abi=", "executable_path=", "stack_guard=",
                               "malloc_entropy=", NULL};
  for (int i = 0; keys[i]; i++) if (strncmp(s, keys[i], strlen(keys[i])) == 0) return 1;
  return 0;
}

static int named(const char *e, char **names, int n) {      // e = "NAME=value"; exact NAME match
  for (int i = 0; i < n; i++) { size_t l = strlen(names[i]); if (strncmp(e, names[i], l) == 0 && e[l] == '=') return 1; }
  return 0;
}

static int asked(const char *name, char **names, int n) {   // is `name` one of the asked-for names?
  for (int i = 0; i < n; i++) if (strcmp(names[i], name) == 0) return 1;
  return 0;
}

static void record(const char *name, const char *value) {   // "NAME=value" and one NUL; an empty value is no fact
  if (!value || !*value) return;
  fputs(name, stdout);
  fputc('=', stdout);
  fputs(value, stdout);
  fputc('\0', stdout);
}

int main(int argc, char **argv) {
  if (argc < 3) { fprintf(stderr, "usage: procenv <pid> <NAME>...\n"); return 2; }
  for (int i = 2; i < argc; i++)
    if (!*argv[i] || strchr(argv[i], '=')) { fprintf(stderr, "procenv: not a name: %s\n", argv[i]); return 2; }
  char *endp;
  long pid = strtol(argv[1], &endp, 10);
  if (*argv[1] == '\0' || *endp != '\0' || pid <= 0) { fprintf(stderr, "procenv: not a pid: %s\n", argv[1]); return 2; }
  int mib[3] = {CTL_KERN, KERN_ARGMAX, 0}, argmax = 0;
  size_t sz = sizeof(argmax);
  if (sysctl(mib, 2, &argmax, &sz, NULL, 0) != 0 || argmax <= 0) argmax = 1 << 20;
  char *buf = malloc((size_t)argmax);
  if (!buf) { fprintf(stderr, "procenv: out of memory\n"); return 1; }
  mib[1] = KERN_PROCARGS2;
  mib[2] = (int)pid;
  sz = (size_t)argmax;
  if (sysctl(mib, 3, buf, &sz, NULL, 0) != 0) { fprintf(stderr, "procenv: %s\n", strerror(errno)); return 1; }
  if (sz < sizeof(int)) { fprintf(stderr, "procenv: short read\n"); return 1; }
  int nargs;
  memcpy(&nargs, buf, sizeof(nargs));
  char *p = buf + sizeof(nargs), *end = buf + sz;
  if (asked(":exe", argv + 2, argc - 2)) {                 // the exec'd path, resolved (a symlink, a bare word on PATH) → the file
    char real[PATH_MAX];
    record(":exe", realpath(p, real) ? real : p);
  }
  if (asked(":cwd", argv + 2, argc - 2)) {                 // the vnode path of the process's current directory, already resolved
    struct proc_vnodepathinfo vpi;
    if (proc_pidinfo((int)pid, PROC_PIDVNODEPATHINFO, 0, &vpi, sizeof vpi) > 0) record(":cwd", vpi.pvi_cdir.vip_path);
  }
  p += strnlen(p, (size_t)(end - p));                      // exec_path
  while (p < end && *p == '\0') p++;                       // its padding
  for (int i = 0; i < nargs && p < end; i++) p += strnlen(p, (size_t)(end - p)) + 1;
  // A process that renamed itself (Node / Electron process.title) rewrites the argv area in place: the new title, then NUL
  // padding up to the old argv length. The env strings after it are intact, so skip that padding.
  while (p < end && *p == '\0') p++;
  while (p < end && *p && !is_apple(p)) {                  // env until the empty string (or the first apple key)
    size_t n = strnlen(p, (size_t)(end - p));
    if (named(p, argv + 2, argc - 2)) { fwrite(p, 1, n, stdout); fputc('\0', stdout); }
    p += n + 1;
  }
  free(buf);
  return 0;
}
