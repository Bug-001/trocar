// test/helpers/ctime.mjs — a change a test makes to a file, made until the file's ctime has moved.
//
// trocar tells "this file changed" from its stat signature: size, mtime, inode and ctime (src/raw/legacy.mjs `sameStat`, the
// resolver's `fp`/signature in src/query/source.mjs, the loader's `fileSig`). ctime is the one stamp a writer cannot put back, so
// it is what catches a rewrite that restores size and mtime, and a chmod that changes neither. But the kernel stamps it from its
// COARSE clock — a 1 ms tick on the ext4 Linux test machine (CONFIG_HZ=1000), 4 to 10 ms on other configs — so a change made in the same
// tick as the stat that was taken before it leaves ctime exactly where it was, and the signature does not move. A test of the
// whole of one such sequence takes a few ms and hit that tick in 1 run of 6 (source-refresh, the chmod that makes a skipped
// file readable) to 1 of 40 (delete-path row 6, alone) on the Linux test machine, and never on APFS, whose stamps are nanoseconds: green on
// macOS, red in the Linux test machine's full suite, green alone again. A real writer that comes later than one tick moves ctime; this makes
// the test's writer one of those.

const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * changeUntilCtimeMoves(fs, file, change) → [ctimeBefore, ctimeAfter]. Runs `change()` (it must be safe to repeat: the same bytes
 * written, the same mode set), and while the file's ctime is still the one it had before the first run, waits 2 ms and runs it
 * again. Throws, saying so, if 1 s of that never moves it (a file system with a ctime no test can outwait is a finding, not a pass).
 */
export function changeUntilCtimeMoves(fs, file, change, { tries = 500 } = {}) {
  const before = fs.statSync(file).ctimeMs
  let after = before
  for (let n = 0; n < tries && after === before; n++) {
    if (n) nap(2)
    change()
    after = fs.statSync(file).ctimeMs
  }
  if (after === before) throw new Error(`${file}: ctime did not move in ${tries} changes, 2 ms apart`)
  return [before, after]
}
