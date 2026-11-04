# Releasing trocar

trocar ships as the npm package `trocar-cli` (command `trocar`), licensed FSL-1.1-ALv2, and through two installer scripts, `install/install.sh` (macOS, Linux) and `install/install.ps1` (Windows), which place that same tarball and a pinned official Node without npm. Releases are made locally by the maintainer: there is no GitHub Actions pipeline, and the tarball that goes to npm and to the GitHub Release is the very one that passed the local checks. The design behind this procedure is in [spec 4.5 §B](../spec/01-trocar-rfc/4.5-distribution.md).

Below, `<x>` is the version being released (for example `0.2.0`), and `dist/trocar-cli-<x>.tgz` is the tarball `npm run release:pack` writes.

## One-time setup

- The npm account that owns `trocar-cli` has two-factor authentication on.
- Run `npm access set mfa=publish trocar-cli` once. Every publish of the package then needs the 2FA one-time code, so a leaked npm token cannot publish it.

## The first release

npm already holds `trocar-cli` 0.0.x: placeholders published only to reserve the name, with no trocar in them. So that `npm i -g trocar-cli` in the README installs trocar from the moment people can read it:

- publish 0.2.0 through the procedure below no later than the hour the repository becomes public;
- then mark the placeholders: `npm deprecate trocar-cli@"<0.2.0" "name reservation; install trocar-cli@latest"`.

## Procedure

Do the steps in order. If a step before step 6 fails, fix the cause on a branch, merge it, delete the tag if step 5 already made it (`git tag -d v<x>`), and start again from step 1 on the new main commit. Once step 6 has published `<x>`, that version number cannot be used again: redo a failed step 7 or 8 as it is, and treat a failed step 9 as a bad release (step 10).

1. **Bump the version.** On a branch:
   - `npm version <x> --no-git-tag-version`
   - In `CHANGELOG.md`, move the links under `## [Unreleased]` into a new section `## [<x>] - YYYY-MM-DD` (today's date), leave `## [Unreleased]` empty, and update the compare links at the bottom (`[Unreleased]` compares from `v<x>`; add a `[<x>]` line pointing at the release tag). Make sure every linked file in `docs/release-notes/` exists.
   - Commit and merge to `main`.

2. **Full test run on all three OSes.** On a macOS machine, a Windows machine and a Linux machine, check out the `main` commit to be released and run `npm install`, then `npm run test:build` (the committed board is the one `web/` builds to) and `HOME=$(mktemp -d) npm test` (on Windows, in a PowerShell window of its own, since the two variables stay set until it closes: `$h = (New-Item -ItemType Directory (Join-Path $env:TEMP "trocar-home-$(Get-Random)")).FullName; $env:HOME = $h; $env:USERPROFILE = $h; npm test`). Zero failures on every OS, in both runs. Write down the skips of each run; they go in the release notes.

3. **Pack and smoke test on each OS.** On `main` at the release commit, run `npm run release:pack` on a macOS or Linux machine (packing on Windows loses the execute bits; the `bin` and `native` checks catch that) and write down `git rev-parse HEAD`. Copy that tarball to each OS and run, on each, on a clean machine, VM or spare user account — never one whose trocar you use:
   1. `npm i -g ./trocar-cli-<x>.tgz`
   2. Linux only: build the capability helper and install it: `make -C "$(npm root -g)/trocar-cli/src/collector/arch/linux"` (needs clang, make, bpftool, the libbpf, libelf and zlib headers, and a kernel with BTF), then `sudo "$(command -v node)" "$(command -v trocar)" setup-helper` (node and trocar by their paths: root's `PATH` may not have them, for example an nvm node)
   3. `trocar install`
   4. `trocar on <one harness>`
   5. make one call from that agent
   6. `trocar query sessions --json` shows it
   7. `trocar off`
   8. `trocar uninstall`
   9. Linux only: `sudo "$(command -v node)" "$(command -v trocar)" setup-helper --remove`
   10. `npm rm -g trocar-cli`

   Then run each installer once against a loopback registry. Serve, from `127.0.0.1`, `trocar-cli/latest` (a package record whose `dist.tarball` points at the tarball and whose `dist.integrity` is its sha512) plus the tarball, and the Node archives that the tarball's `install/node.sha256` names under `v<node version>/` (copy them from nodejs.org once). Then, in a fresh HOME (on Windows a fresh `USERPROFILE`):
   - macOS / Linux: `TROCAR_REGISTRY=http://127.0.0.1:<port> TROCAR_NODE_MIRROR=http://127.0.0.1:<port> sh install/install.sh --stage` prints `trocar-installer: staged <x> <dir>` as its last line;
   - Windows: the same two variables, then `powershell -NoProfile -ExecutionPolicy Bypass -File install\install.ps1 -Stage`.

4. **Release check.** On the machine that packed in step 3, on `main` at the release commit with a clean tree:
   - `npm run release:check` exits 0. Each failed check prints one line `release: <id>: <reason>` and the command exits 1. The checks:

     | id | passes when |
     |---|---|
     | `branch` | after fetching `origin main` and tags, the current branch is `main` and HEAD equals `origin/main` |
     | `clean` | `git status --porcelain` prints nothing (untracked files count: they would be packed) |
     | `unpublished` | npm has no `trocar-cli@<x>` (a lookup error also fails: not found is not the same as free) |
     | `tag` | the tag `v<x>` does not exist |
     | `license` | `LICENSE` exists and is in the pack list, and `package.json` has a `license` |
     | `private` | `package.json` is not `private: true` |
     | `lifecycle` | `package.json` has no npm lifecycle script (installing the package must not run anything) |
     | `files` | everything in the pack list is `package.json`, a README or LICENSE, or under a `files` entry; no `*.ndjson` |
     | `bin` | every `bin` target is packed and executable |
     | `native` | every prebuilt macOS helper is packed, under `src/collector/arch/darwin/native/`, and executable |
     | `pins` | every prebuilt helper's sha256 on disk equals its pinned value |
     | `notes` | `CHANGELOG.md` has a `## [<x>]` section linking at least one release note, and every linked note exists |
     | `installer` | `install/install.sh` and `install/install.ps1` are in the pack list and pure ASCII; the `.sh` has no CR and passes `sh -n`; the data lines of their SOURCES blocks are equal, line for line, and name this package |
     | `node-pin` | `install/node.sha256` has exactly one line for each Node build (darwin-arm64 and darwin-x64 `.tar.xz`; linux-x64 and linux-arm64 `.tar.xz` and `.tar.gz`; win-x64 and win-arm64 `.zip`), all of one version that `engines` allows, and each line appears verbatim in `https://nodejs.org/dist/v<version>/SHASUMS256.txt` (needs the network, like `unpublished`) |
     | `pathlen` | the longest packed path, placed under `C:\Users\<32 characters>\.trocar\app\.staging-99999\<x>\`, is at most 259 characters |

   - `git rev-parse HEAD` is the commit written down in step 3, and `(cd dist && shasum -a 256 -c SHA256SUMS)` prints `OK` (`SHA256SUMS` names the tarball without a directory): the tarball that goes out is the one smoke-tested in step 3. Do not pack again here. If `main` moved since step 3, go back to step 3.

5. **Tag.** `git tag -a v<x> -m 'trocar <x>'` (add `-s` when you sign tags).

6. **Publish.** `npm publish dist/trocar-cli-<x>.tgz --access public`. npm asks for the 2FA one-time code. Always publish the tested tarball, never a fresh pack.
   - A pre-release goes out as `npm publish dist/trocar-cli-<x>.tgz --access public --tag next`. Once it is confirmed good, promote it with `npm dist-tag add trocar-cli@<x> latest`.

7. **Push the tag.** `git push origin v<x>`.

8. **GitHub Release.** `gh release create v<x> dist/trocar-cli-<x>.tgz dist/SHA256SUMS install/install.sh install/install.ps1 --verify-tag --title v<x> --notes-file <the notes>`, where the notes are this version's `CHANGELOG.md` section plus the skips from step 2. Add `--prerelease` for a `next` release. The two scripts are attached from the clean release commit, so they are the bytes inside the tarball; the README's one-line install fetches them through `releases/latest/download/`, and `SHA256SUMS` still names only the tarball.

9. **Verify from the registry on a clean machine.**
   - `npm i -g trocar-cli@<x>`
   - `trocar --version` prints `trocar <x>`
   - On the clean macOS and Windows test machines, run the one-line install exactly as the README shows it; it ends in `trocar install`'s plan.
   - `npm view trocar-cli@<x> dist.integrity` equals the integrity of the local tarball: `sha512-` followed by `openssl dgst -sha512 -binary dist/trocar-cli-<x>.tgz | openssl base64 -A`

10. **A bad release.** Run `npm deprecate trocar-cli@<x> '<why; use <x+1>>'` and ship a patch release through this same procedure. Never `npm unpublish`: an unpublished version number can never be reused, and people who already installed it get no explanation.

## Bumping the pinned Node

The installers always place the official Node build that `install/node.sha256` names; that file is the only place the Node version and its hashes are written. The pin is the Node that the full test run of step 2 and the installer smoke runs of step 3 last passed on. To move it to a new patch:

1. Pick the version from `https://nodejs.org/dist/index.json` (for the current line, the newest `v22.x`).
2. Rewrite `install/node.sha256` with that version's lines from `https://nodejs.org/dist/v<version>/SHASUMS256.txt`, copied verbatim, one per build in the `node-pin` row above, for example:
   `curl -fsSL https://nodejs.org/dist/v<version>/SHASUMS256.txt | grep -E -- '-(darwin-(arm64|x64)\.tar\.xz|linux-(x64|arm64)\.tar\.(xz|gz)|win-(x64|arm64)\.zip)$' > install/node.sha256`
3. On that Node, run the full fresh-HOME `npm test` on all three OSes and the installer smoke runs of step 3, then commit the new pin on a branch. `npm run release:check` then checks the lines against nodejs.org again.

A version that is already placed keeps the Node it was placed with; a new version of trocar names its own Node directory, so a pin change takes effect with the next release.

## Known limits

- **No npm provenance.** Provenance needs a CI's identity token to sign the build, and releases do not go through CI. The `SHA256SUMS` on the GitHub Release and the npm integrity check in step 9 are what tie the published tarball to the release.
- **Install from a global install, not npx.** The safety net for a removed package or a cleared `npx` cache (spec 4.5 §F) is not built yet, so run `trocar install` from a global install (`npm i -g trocar-cli`), not from `npx trocar-cli`.
