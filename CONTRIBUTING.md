# Contributing to trocar

Thanks for helping. This file says how the project works so a change can land without surprises. Please read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) first. Security issues never go in a public issue or pull request: see [SECURITY.md](SECURITY.md).

## Setup

You need Node 22 or newer.

```sh
git clone https://github.com/Bug-001/trocar.git
cd trocar
npm install
```

trocar has no runtime dependencies; `npm install` only fetches the development tools.

## Tests

- `npm test` runs the whole suite (`node --test`) with three preloads:
  - `flush-exit.cjs` keeps test output when the run is force-exited;
  - `leak-guard.cjs` catches leaked temp directories and child processes;
  - `no-real-os.cjs` stops unit tests from running real OS tools.

  The preloads are part of the test command. Never drop them, and never move them into `NODE_OPTIONS`.
- `npm test -- <files>` runs a few files while you iterate. Always go through `npm test` so the preloads apply.
- `HOME=$(mktemp -d) npm test` is the full run from a fresh HOME. Run it before opening a pull request and put the counts (pass / fail / skip) and the skips in the description.
- Tests get temporary directories from `tmpDir()` in `test/helpers/tmp.mjs`, never a hand-made `mkdtemp`.

### What a test may assert

Tests assert contracts and invariants: exit codes, JSON document fields and codes, the bytes written to files and records. Expected values come from the spec or from real captured bytes, not from copying what the code prints today.

Tests do not pin wording, layout, line counts or internal call order. A test that pins any of those is removed rather than rewritten when a change turns it red.

## Spec first

The design lives in [`spec/01-trocar-rfc/`](spec/01-trocar-rfc/). For behaviour the spec covers:

- read the unit that covers it, including its "source files and interfaces" and "acceptance" sections;
- if your change alters the behaviour, change the spec in the same pull request, before the code;
- turn each acceptance item you touch into a test that fails without your change, point at the existing test that covers it, or say why it does not apply.

If the spec looks wrong, say so in the pull request with the change you propose; the spec is updated to the better design.

## Adding a harness

A harness is data, not code. Add a descriptor in [`src/collector/harness/`](src/collector/harness/) that picks from the primitives in spec 4.11 §2 (which file, which key, which format). Do not add product-, version- or file-specific branches to the editing code; if a harness needs something the primitives cannot express, propose widening a primitive first.

## Commits and pull requests

- Each commit is at most 400 lines, can be verified on its own, and has a body that says why and what the evidence is.
- Related commits go in one pull request. Fill in the pull request template: what and why, how you verified it (fresh-HOME counts and skips), which spec section it touches.
- A change to user-visible behaviour also updates `README.md` and adds or extends a note in `docs/release-notes/`.
- The gate for a pull request is the local fresh-HOME run reported in its description, not GitHub Actions.

## Licensing

trocar is licensed under FSL-1.1-ALv2 (see [LICENSE](LICENSE)). By contributing you agree that your contribution is licensed under the project's license (FSL-1.1-ALv2) and that the maintainer may relicense it.
