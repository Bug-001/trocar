// A test that simulates a Linux or macOS world on this host's real temp folder: on a Windows host those paths hold backslashes and a drive
// letter, a shape no real Linux or macOS machine has, so the POSIX-only writers (a dotenv path value) rightly refuse them, a macOS path key
// reads `C:\…` as a relative name, and a Linux-only planner joins host paths with `\`. Spread as `{ skip: POSIX_WORLD }`.
export const POSIX_WORLD = process.platform === 'win32' && "a simulated Linux or macOS world works in POSIX paths; this Windows host's paths are not POSIX"
// The uid this test process runs as. Windows has no process.getuid and no POSIX owner: fs.stat().uid is 0 for every file and mode
// bits do not bind, the same as root, so 0 is what the files there agree with.
export const HOST_UID = typeof process.getuid === 'function' ? process.getuid() : 0

// A test that needs a mode-000 file to be unreadable, or a 0555 directory unwritable: root reads and writes through POSIX mode bits, and
// Windows does not apply them. Spread as `{ skip: NO_MODE_BITS }`; a check inside a test runs `if (!NO_MODE_BITS)`.
export const NO_MODE_BITS = process.platform === 'win32' ? 'this Windows host does not apply POSIX mode bits' : HOST_UID === 0 ? 'root reads and writes through POSIX mode bits' : false
