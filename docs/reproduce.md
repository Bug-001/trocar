# Reproducing a problem

How to get a board and a dataset to work against without touching the capture running on your machine. Everything here runs from a clone of this repository, after `npm install`.

The rule behind all of it: **real session content, and screenshots of it, stay on your machine.** A test, a pull request or an issue carries synthetic data only. When a defect needs a real shape, describe the shape (keys, types, sizes, order of events) and build a record with that shape and made-up text.

## Synthetic data

There are two sources, both safe to share:

- `samples/demo-session.ndjson` is one fabricated session in the real record format. `node samples/gen-demo-capture.mjs` regenerates it.
- `scripts/gen-dataset.mjs` writes a large dataset, shaped like real traffic and made up word by word:

  ```sh
  node scripts/gen-dataset.mjs --home <dir> [--seed 1] [--bytes 1000000000] [--json]
  ```

  `--home` is a HOME, not a trocar home: the segments land in `<dir>/.trocar/raw/`. One seed gives the same bytes every time. Use a fresh directory, and read a dataset you generated with `HOME=<dir> node bin/trocar.mjs query …`.

A unit test does not need either of them: `test/query/raw-home.mjs` writes a few records into a temporary home, and `tmpDir()` in `test/helpers/tmp.mjs` gives the directory.

## The side board

`scripts/side-board.mjs` serves this clone's board and query code in its own process, apart from any installed daemon. It does not start, stop or change anything that is running.

```sh
node scripts/side-board.mjs --synthetic [--bytes <n>] [--board-dir <dir>] [--url-file <file>]
node scripts/side-board.mjs --real [--board-dir <dir>] [--url-file <file>]
```

- `--synthetic`: a temporary home with the demo session and a generated dataset of `--bytes` bytes (20 MB unless you say).
- `--real`: your own captures in `~/.trocar`, read-only. The temporary home links to each of its directories and copies its files and its index, so whatever the query worker writes lands in the temporary home. Nothing in `~/.trocar` changes.
- `--board-dir <dir>`: serve that build of the board instead of the committed `src/web/board/`. After editing `web/`, make one with `npm run build:board -- --outDir <dir> --emptyOutDir`, so you can look at the change before you commit a build.
- `--url-file <file>`: write the address into the file (mode 0600) instead of printing it. The address holds the board's token, so prefer this over copying it around.

With no `--url-file` the address is the one line on stdout; logs go to stderr. Ctrl-C stops the board and removes the temporary home.

Two things are different from the board your daemon serves:

- **Only GET gets through.** Every other request gets a 405, on every path, in both modes. Buttons that change something do nothing here; a failed request behind one of them is expected, not a defect.
- **The capture page is not this machine's state.** The side board runs with `HOME` set to the temporary home, so anything that reads the machine (the daemon, the agents, the certificates) looks at that empty home. Use the side board to judge sessions, calls and numbers; ask `trocar status` and `trocar doctor` about capture.

## Checking against your real data

Generated data misses what real captures carry, so a change to the query or the board deserves a look over your own data before it ships. Three levels, all read-only:

1. **By eye.** `node scripts/side-board.mjs --real` and open the sessions that matter.
2. **Sequence soak.** Random reader actions against the side board, with the board's invariants checked after every step:

   ```sh
   node scripts/side-board.mjs --real --url-file <file>
   # in a second terminal, while the board runs:
   SEQ_REAL=<file> npm run test:browser -- test/web-v2/browser/seq/real.test.mjs
   ```

   `SEQ_REAL` is the file `--url-file` wrote. `npm run test:browser` sets `TROCAR_PLAYWRIGHT=1` itself, and the test is skipped without both. It needs Google Chrome. `SEQ_SEEDS` (6), `SEQ_STEPS` (60) and `SEQ_SEED_BASE` (1) set how much it runs. It takes reader steps only: nothing grows, and no worker is killed. A failed run prints the violation, the steps and a screenshot path, and never the board's address. The screenshot shows your data: read it, do not upload it.
3. **Cold read of your largest session.** The real query worker, under its real heap, builds your largest session from nothing:

   ```sh
   TROCAR_REAL_HOME=<home> npm run test:real
   ```

   `<home>` is a trocar home, the directory holding `raw/` (normally `~/.trocar`). The test works over a side home, so the home you give it is only read. No timing is asserted; the numbers are logged. Without `TROCAR_REAL_HOME` the test is skipped.

None of these belongs in a default run, and what they print stays with you. What goes into a pull request is that you ran them, and what you found, in words that hold no content.
