// A test that simulates a Linux or macOS world on this host's real temp folder: on a Windows host those paths hold backslashes and a drive
// letter, a shape no real Linux or macOS machine has, so the POSIX-only writers (a dotenv path value) rightly refuse them. Spread as `{ skip: POSIX_WORLD }`.
export const POSIX_WORLD = process.platform === 'win32' && "a simulated Linux or macOS world writes POSIX paths; this Windows host's temp paths are not POSIX"
// The uid this test process runs as. Windows has no process.getuid and no POSIX owner: fs.stat().uid is 0 for every file and mode
// bits do not bind, the same as root, so 0 is what the files there agree with.
export const HOST_UID = typeof process.getuid === 'function' ? process.getuid() : 0
