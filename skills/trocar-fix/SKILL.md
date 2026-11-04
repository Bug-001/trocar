---
name: trocar-fix
description: Use when a defect in trocar is confirmed and the user wants it fixed. Turns the report from trocar-debug into a tested change on a branch of the public repository, reproduced on synthetic data only. Comes after trocar-debug and before trocar-pr.
---

# trocar-fix: a reliable change

You have a confirmed defect, and the user has said to fix it. The result is a branch in a clone of the public repository that a maintainer can trust without seeing the user's data. Nothing leaves the machine here: that is `trocar-pr`.

## Rules that do not bend

- **Nothing real goes into the repository.** No captured bytes, prompts, tool output, paths, hosts, session ids or screenshots, in code, tests, comments or commit messages. A fixture copied from a capture and then edited is still a capture: write test data from scratch.
- **Spec first.** If the fix changes behaviour the spec covers, change the spec before the code, in the same branch. If the spec looks wrong, propose the better design and say why.
- **No real machine in tests.** Tests run under a temporary HOME. Never run `trocar on`, `off`, `install`, `uninstall` or `update` to test a change, and never touch the user's `~/.trocar`.

## Steps

### 1. Read the contract

Run `git grep -n "<keyword>" spec/01-trocar-rfc/` and open the unit that covers the behaviour. Read its source-files section (「涉及源文件与接口」) and its acceptance list (「验收(可跑 check)」). `spec/01-trocar-rfc/0.0-overview.md` holds the invariants and decisions, `0.1-engineering-rules.md` the engineering rules. Read `CONTRIBUTING.md` in full.

For every acceptance item your change touches, do one of three things: add a test that goes red without the change, name the existing test that covers it, or write why it does not apply. Do not skip one silently.

### 2. Reproduce on synthetic data, red first

Write the test before the fix and watch it fail for the reason in the report.

- Query and CLI defects: `test/query/raw-home.mjs` writes records into a temporary home; `samples/gen-demo-capture.mjs` and `scripts/gen-dataset.mjs` show how to build envelopes; `tmpDir()` in `test/helpers/tmp.mjs` is the only way to get a temporary directory.
- A defect that only a real shape triggers: describe the shape (keys, types, sizes, order of events), not the content, then build a record with that shape and made-up text.
- Board defects: `node scripts/side-board.mjs --synthetic` serves the board from your clone over generated data. Tests of the board live in `test/web-v2/` and `web/src/**/*.test.tsx`; `test/web-v2/browser/seq/` is the sequence harness, and every board change must pass it.

If you cannot reproduce it on synthetic data, stop and tell the user why. A fix with no red test is not done.

A test asserts contracts and invariants: exit codes, JSON fields and codes, bytes written. Expected values come from the spec, never from copying today's output. A test that pins wording or layout does not belong.

### 3. Fix it generally

- The smallest change that holds for the whole class of input, not for the one shape you saw. No branch for one product, version, encoding or path shape.
- A new harness or a new form of one is data: see `docs/adding-a-harness.md`.
- Provider knowledge stays in the dissectors. The board has no provider branches.
- A number or a judgement the board shows comes from a query document; the board only lays it out. Add a field to the query, never arithmetic to `web/`. The CLI then has it for free.
- Keep it short. Among correct designs, take the one with less code.

### 4. Verify

```bash
npm test -- <the test files you touched>
HOME=$(mktemp -d) npm test
npm run test:web
npm run typecheck
npm run lint
npm run test:build
npm run test:browser
```

Always go through `npm test`, never bare `node --test`: the preloads are part of the test command. Keep the counts (pass, fail, skip) and the reasons for skips; the pull request needs them.

- **Changed `web/`:** run `npm run build:board`, commit `src/web/board/` in its own last commit, and walk the screen with `trocar-ux`. `node scripts/side-board.mjs --real` serves your build over the user's real captures, read-only, without touching the installed daemon. Check it there too, and keep what you see on the machine.
- **Changed CLI output:** render it with `node scripts/cli-shot.mjs -- node bin/trocar.mjs <command>` and look at the picture. Output is English, leads with the conclusion, and shows no codes or stack traces (spec 1.6 §1.1).

### 5. Commit

- Each commit is at most 400 lines, can be verified on its own, and has a body that says why and what the evidence is.
- User-visible change: update `README.md` and `docs/release-notes/<date>.md`.
- Use `git add <paths>`, never `git add -A`. Keep your working notes and screenshots outside the clone.

### 6. Hand over

Tell the user what changed, what the test proves, and the counts. Then go to `trocar-pr`.
