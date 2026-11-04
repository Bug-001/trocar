---
name: trocar-debug
description: Use when something in trocar looks wrong - an agent not captured, a wrong number, a session in the wrong place, a call filed under the wrong name, a board screen that misbehaves. Checks each part of trocar against its contract with real commands, the board's source and screenshots, then reports. The entry point of the skill set; trocar-fix and trocar-pr come after it.
---

# trocar-debug: find out what is wrong

The user noticed something off. Your job is to find out whether trocar broke a contract, show it, and report. You change nothing here. Deep use of one agent finds bugs nobody else can reach, so a careful report from this machine is worth a lot, and it must never carry the user's data with it.

`trocar help --json` lists every command and query, and `trocar query <name> --help` explains one. Trust those over this text if they differ.

## Rules that do not bend

1. **Read only.** Never run `trocar on`, `off`, `install`, `uninstall` or `update`. Never stop or restart the daemon, and never write under `~/.trocar`. If a check would need one of these, ask the user first.
2. **Reading a session sends it to your model provider.** Say so once, before you read any content. Then read only what the symptom needs.
3. **Keep content out of your context unless you need it:**

   | Tier | What | Rule |
   |---|---|---|
   | No content | `status`, `doctor`, `segments`, `overview`, `traffic`, `classes`, contract-check results | Read freely. They still carry user names, paths and hosts, so none of it goes in a report that leaves the machine |
   | Content | `block`, session titles, the board on real data | Only what the symptom needs |
   | Never | Output of `trocar raw`, and `calls --reveal` | Captured headers hold real tokens. Compare bytes by hash through a pipe, never print them |

4. **Big documents go to a file.** A `session` document can be 1 MB. Write it to your working folder and pull fields with `node -e`.
5. **A security problem stops the work.** Tell the user and follow `SECURITY.md`. It does not go in a public issue or pull request.

## Steps

### 1. Pin down the symptom

Ask what looked wrong, on which agent, in which session or at what time, and what they expected. One clear symptom is worth more than a tour.

Note the time now in UTC: `trocar-pr` needs it. Make a working folder outside any repository (`mktemp -d`); screenshots and documents go there.

### 2. Get the contracts

```bash
trocar --version
git clone https://github.com/Bug-001/trocar.git
```

Check out the tag for your version, or the commit after the `+` in a version like `0.1.0+1a2b3c4`, and run `npm install`. The clone holds the spec (`spec/01-trocar-rfc/`, written in Chinese), the board's source, the scripts below, and the place a fix will happen. The installed package has none of these. Without network access, work from `trocar help --json` and say what you could not check.

### 3. Run the machine check

```bash
node scripts/contract-check.mjs --json > "$RUN/contract.json"
```

It reads through the CLI, changes nothing and prints only counts and ids. It checks what can be decided mechanically: every query answers and lists what it could not read; `--json` is one document and exit codes are the documented ones; `segments` agrees with the stored records; block bytes equal the record they came from; the same number agrees across documents; incremental reads add up to a full read; and, per agent, how many calls are unparsed, filed under other, have an inferred agent, or have an incomplete reply. That last group is where deep use of one agent shows up.

A finding here is a lead. Confirm it before you report it.

### 4. Go to the part the symptom points at

| Part | Its promise | Start with | Contract |
|---|---|---|---|
| Switch | `on`: new connections are captured. `off`: nothing of trocar is left on the agent's path | `trocar status <agent> --json`, `trocar doctor <agent> --json` | 1.6 §3.1, §3.5, §3.7 |
| Capture | Every byte is stored, or a failure with a reason is | `trocar status --failures --json`, `query calls --harness <agent>` | 4.1, 4.6 |
| Records | The stored bytes are the truth; everything else can be rebuilt from them | `query segments`, contract-check | 4.2 |
| Agent recognition | Each call lands in the right session and lane, under an honest name | `query sessions`, `query session --id <id> --head` | 3.1, 3.4 |
| Replay | Each step shows what was really sent and received | `query session`, `query lane`, `query block` | 1.4, 3.5 |
| Cache and cost | Numbers come from reported usage; unknown stays unknown | `query session --id <id> --head`, `query pricing` | 3.3 |
| Traffic and storage | Every host and class is accounted for | `query traffic`, `query calls`, `query classes` | 1.10, 1.11 |
| CLI | One document under `--json`, the documented exit codes, plain English | `trocar help --json` | 1.6 §1 |
| Board | The twelve checks | Step 5 | `trocar skill trocar-ux` |

Read the contract, form one hypothesis, and test it with the smallest read that can prove it wrong. Do not guess at causes from the symptom alone: follow the data from the record to the query to the screen, and find the first place it goes wrong.

### 5. Look at the board

Print the standard with `trocar skill trocar-ux` and walk the screens the symptom touches, or all of them if the user asked for a full review.

```bash
trocar board --json > "$RUN/board.json"
node scripts/board-walk.mjs --board "$RUN/board.json" --out "$RUN/walk"
```

The address holds the board's token: keep it in the file, out of your messages. `board-walk` needs the clone's `npm install` and Google Chrome. If your harness has its own browser tool, you can use that instead. Read `web/` for the screen first, so you know what each control promises. Look at every screenshot yourself: the script finds dead controls and overflow, and only you can find a wrong name or a screen that wastes its space.

`node scripts/side-board.mjs --synthetic` gives you a board over generated data, for anything you want to try without the user's data. `--real` serves the clone's code over the user's captures, read-only, and the sequence soak can run against it (`docs/reproduce.md`).

### 6. Try to reproduce on synthetic data

Is the defect there on generated data? If it needs a real shape, describe the shape (keys, types, sizes, event order) rather than the content, and build a record like that. A reproduction on synthetic data is what makes a fix possible, and what lets it leave the machine.

### 7. Report and stop

Report to the user, one entry per finding, in plain words:

- **What is wrong**, and which contract it breaks (spec section).
- **Expected and observed**, in counts and ids.
- **How sure:** confirmed, suspected, or not a bug after all. Say which parts you could not check.
- **Reproduced on synthetic data?**
- **Likely cause**, with `file:line`, if you found it.

Then stop and ask which it is:

- **Leave it.** Delete the working folder.
- **Fix it.** Go to `trocar skill trocar-fix`.
- **Report it without a fix.** Write the issue from what can be said without user data, and go to `trocar skill trocar-pr`: an issue passes the same check as a pull request.

Never send anything without that skill and the user's yes.
