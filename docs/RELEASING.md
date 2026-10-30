# Releasing trocar

trocar ships as the npm package `trocar-cli` (command `trocar`), licensed FSL-1.1-ALv2. Releases are made locally by the maintainer: there is no GitHub Actions pipeline, and the tarball that goes to npm and to the GitHub Release is the very one that passed the local checks. The design behind this procedure is in [spec 4.5 §B](../spec/01-trocar-rfc/4.5-distribution.md).

Below, `<x>` is the version being released (for example `0.2.0`), and `dist/trocar-cli-<x>.tgz` is the tarball `npm run release:pack` writes.

## Procedure

Do the steps in order. If a step fails, fix the cause on a branch, merge it, and start again from step 1 on the new main commit.

1. **Bump the version.** On a branch:
   - `npm version <x> --no-git-tag-version`
   - In `CHANGELOG.md`, move the links under `## [Unreleased]` into a new section `## [<x>] - YYYY-MM-DD` (today's date), leave `## [Unreleased]` empty, and update the compare links at the bottom (`[Unreleased]` compares from `v<x>`; add a `[<x>]` line pointing at the release tag). Make sure every linked file in `docs/release-notes/` exists.
   - Commit and merge to `main`.

2. **Full test run on all three OSes.** On a macOS machine, a Windows machine and a Linux machine, check out the `main` commit to be released and run `HOME=$(mktemp -d) npm test` (on Windows, point `HOME` and `USERPROFILE` at a fresh empty directory). Zero failures on every OS. Write down the skips of each run; they go in the release notes.

3. **Pack and smoke test on each OS.** Run `npm run release:pack` on a macOS or Linux machine (packing on Windows loses the execute bits; the `bin` and `native` checks catch that). Copy that tarball to each OS and run, on each:
   1. `npm i -g dist/trocar-cli-<x>.tgz`
   2. `trocar install`
   3. `trocar on <one harness>`
   4. make one call from that agent
   5. `trocar query sessions --json` shows it
   6. `trocar off`
   7. `trocar uninstall`
   8. `npm rm -g trocar-cli`

4. **Release check, then the final pack.** On the release machine, on `main` at the release commit with a clean tree:
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

   - `npm run release:pack` runs the same checks and then writes `dist/trocar-cli-<x>.tgz` and `dist/SHA256SUMS`. If this tarball's sha256 differs from the one smoke-tested in step 3, the tree changed in between: go back to step 3 with this tarball.

5. **Tag.** `git tag -a v<x> -m 'trocar <x>'` (add `-s` when you sign tags).

6. **Publish.** `npm publish dist/trocar-cli-<x>.tgz --access public`. npm asks for the 2FA one-time code. Always publish the tested tarball, never a fresh pack.
   - A pre-release goes out as `npm publish dist/trocar-cli-<x>.tgz --access public --tag next`. Once it is confirmed good, promote it with `npm dist-tag add trocar-cli@<x> latest`.

7. **Push the tag.** `git push origin v<x>`.

8. **GitHub Release.** `gh release create v<x> dist/trocar-cli-<x>.tgz dist/SHA256SUMS --title v<x> --notes-file <the notes>`, where the notes are this version's `CHANGELOG.md` section plus the skips from step 2. Add `--prerelease` for a `next` release.

9. **Verify from the registry on a clean machine.**
   - `npm i -g trocar-cli@<x>`
   - `trocar --version` prints `<x>`
   - `npm view trocar-cli@<x> dist.integrity` equals the integrity of the local tarball : `sha512-` followed by `openssl dgst -sha512 -binary dist/trocar-cli-<x>.tgz | openssl base64 -A`

10. **A bad release.** Run `npm deprecate trocar-cli@<x> '<why; use <x+1>>'` and ship a patch release through this same procedure. Never `npm unpublish`: an unpublished version number can never be reused, and people who already installed it get no explanation.

## Known limits

- **No npm provenance.** Provenance needs a CI's identity token to sign the build, and releases do not go through CI. The `SHA256SUMS` on the GitHub Release and the npm integrity check in step 9 are what tie the published tarball to the release.
- **Install from a global install, not npx.** The safety net for a removed package or a cleared `npx` cache (spec 4.5 §F) is not built yet, so run `trocar install` from a global install (`npm i -g trocar-cli`), not from `npx trocar-cli`.
