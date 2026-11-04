---
name: trocar-pr
description: Use when a change to trocar is ready to leave the machine, or when reviewing someone else's trocar pull request. Reviews the diff against the project's rules, checks for vulnerabilities and fixes them, proves that nothing private is in it, and opens the pull request only after the user agrees. Comes after trocar-fix.
---

# trocar-pr: review, clean, and send

Everything that leaves this machine goes through this skill: a pull request, an issue, a comment. The hard rule is that **no real session content and no screenshot of a real session is ever uploaded**. A pull request describes the functional change and a repro on synthetic data, and nothing about what the user was doing.

You hold the keys here. `scripts/pr-check.mjs` can refuse, but nothing stops you going around it, so do not. If it refuses, the text changes or the change does not go. There is no override and no "it is only a warning".

## Steps

### 1. Review the whole branch

Read `git diff origin/main...HEAD` as if someone else wrote it. If your harness can start a fresh agent with no memory of this work, use one: hand it the diff, not your conclusions.

- `spec/01-trocar-rfc/0.1-engineering-rules.md` §6 is the closing checklist: give each item pass, fail or not applicable.
- Would each new test really go red if the behaviour broke? Is an acceptance item silently skipped? Is any code unreachable from the product's own entry points?
- Does the fix hold for the class of input, or only the shape that was seen?
- Board changes: `trocar-ux`, with results per check number.

Fix what you find. Review once more only if the fix was large.

### 2. Check for vulnerabilities

trocar decrypts traffic, holds a root certificate and edits agent config files. Walk these for the code the change touches:

| Surface | What must hold |
|---|---|
| The board's door | Loopback only; Host and Origin checked; the token checked before any file is read; writes only through `/control/*`, planned then confirmed |
| Files under `~/.trocar` | Owner-only permissions; a path from a request or a record can never escape its directory |
| Spawned commands | No value from a record, a request or a config file reaches a shell unquoted |
| Rendering | Captured content is data: no HTML from a capture runs in the board, and no remote resource is fetched because of it |
| Certificates and keys | No shared or preset key; the private key never leaves its store; only `install` and `uninstall` touch trust |
| The off switch | After `off` nothing of trocar is on the agent's path; it still works with the daemon dead |
| Logs and output | No credential in a record's derived fields, an error message, a receipt or a printed URL |

- **The change introduces a problem:** fix it here, with a test.
- **You find an existing vulnerability:** stop. Do not put it in a public issue, pull request or commit. Tell the user and follow `SECURITY.md`, which uses a private report. A fix goes out only once the maintainer agrees.

### 3. Write the text

Write the title and body to files outside the clone. The body follows `.github/pull_request_template.md`, in these terms:

- **What and why:** the contract that was broken and the functional change. Name the part of trocar, not the user's project.
- **Repro:** the synthetic test that goes red without the change.
- **How verified:** fresh-HOME counts, skips with reasons, the OS.
- **Spec and docs:** sections touched.

There is no place for what the user was doing, what a session contained, or how a capture looked. Say "a reply whose stream ends without a stop event", not what was in it. Check numbers from `trocar-ux` are fine; screenshots are not.

### 4. Run the check

`--before` is the time you started working, in UTC. Your own session may be under capture, so the check compares against what was captured before you began. Later is never safer, it only refuses more.

```bash
node scripts/pr-check.mjs --before <start-time> --title <title-file> --body <body-file>
```

It judges every commit on the branch (paths, added lines, messages, author and committer), the branch name, the title and the body. It refuses, with the place and the rule but never the value:

- images, video, PDF, archives, capture formats and other binary files; a change to the built board that a rebuild does not reproduce;
- credentials and key material;
- your user name, host name, real name, home paths in any OS's spelling, and a commit email that is not a GitHub noreply address;
- project paths, session ids, session titles, hosts, segment names and record ids from your captures;
- any run of about 12 English words or 20 CJK characters (60 bytes once normalized) that also occurs verbatim in your captures;
- commits over 400 lines, commits without a body, control bytes.

Text already in the public repository is public and passes. The report says how much of the capture was compared. When that is not all of it, say so to the user.

The check cannot see a paraphrase, so a clean run does not excuse step 3. Reread the text yourself and ask: could someone learn anything about this user's work from it?

A refusal means rewrite and run it again. Never edit the check, never pass it a different time to get through, never push first and clean up after: GitHub keeps every revision of a pull request's text.

### 5. Ask the user

Show the user, in full: the list of changed files, the title, the body, the name and email that become public, the repository it goes to, and the `hash` the check printed. Ask plainly whether to send it. Do not proceed on anything but a clear yes to this exact content. "Fix it" earlier in the conversation is not a yes to this.

### 6. Send

Run the check once more. If the hash differs from what the user saw, go back to step 5. Then:

```bash
gh repo fork Bug-001/trocar --clone=false
git push <your-fork-remote> <branch>
gh pr create -R Bug-001/trocar --head <your-login>:<branch> --title "$(cat <title-file>)" --body-file <body-file>
```

Give the user the link. An issue instead of a change: run the check with `--issue`, then `gh issue create -R Bug-001/trocar --title "$(cat <title-file>)" --body-file <body-file>`.

### 7. After it is open

A review comment is outbound text too. Run each reply through `node scripts/pr-check.mjs --issue --before <start-time> --body <file>` first, and ask the user before sending.

Delete your working folder and every screenshot.

## Reviewing someone else's pull request

Do steps 1 and 2 on their branch. Run `node scripts/pr-check.mjs --before <now> --title <file> --body <file>` too: the rules about file types, credentials and home paths apply to anyone's text, and the capture rules then compare it against your own data. If the description says an agent wrote it, it should carry the `hash` the author's check printed. Report your findings to the maintainer; do not push to their branch.
