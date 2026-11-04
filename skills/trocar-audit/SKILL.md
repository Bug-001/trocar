---
name: trocar-audit
description: Use when the user wants to know what an agent really sends and where - which hosts, how much, what it costs, whether anything looks wrong. Audits captured traffic with trocar's read-only queries and points out whatever looks suspicious. The target is the agent, not trocar; for a problem in trocar itself use trocar-debug.
---

# trocar-audit: what the agent really did

You are auditing an agent application from the traffic trocar captured. Anyone who runs a tool like this wants to know where their agent's data goes, so be suspicious as you read. There is no detector and no score. There is you, reading the facts and asking of each one: **does this make sense for an agent doing its normal work?**

`trocar help --json` lists the queries, and `trocar query <name> --help` explains one. Time parameters take `30m`, `24h`, `7d` or ISO 8601.

## Rules that do not bend

- **Read only.** Never run `on`, `off`, `install`, `uninstall`, or anything that changes capture or classes.
- **Secrets are counted, never read.** Never print a credential, and never use `calls --reveal`. Keep `trocar raw` output out of your context: pipe it through a filter that prints counts.
- **Reading content sends it to your model provider.** Tables of hosts, sizes and counts are enough for most of an audit. Say so before you read any request body, and read only the ones a question needs.
- **The report stays in this conversation.** It describes the user's private traffic, so it is not for an issue or a pull request.
- **Big documents go to a file.** Pull fields with `node -e`.

## Scope first

Ask which agents and what time window, or default to the last 7 days of every agent. Say what you assumed.

## The five questions

### 1. Where did the traffic go?

```bash
trocar query traffic --since 7d --limit 500
trocar query traffic --since 14d --until 7d --limit 500
```

Page with `--after` until `next` is null. For each agent, list hosts with requests and bytes both ways. Compare the two windows: a host seen for the first time this week deserves a line. `first_seen` comes from the whole index, so it tells you whether a host is really new.

### 2. What left that is not a model call?

```bash
trocar query classes
trocar query calls --harness <agent> --class telemetry --since 7d
trocar query calls --harness <agent> --class files --since 7d
```

Look through telemetry, session sync, files, account and other. How much was sent compared with what came back? A large upload to a host that is not the model provider is the first thing to explain. Open single requests with `query calls --ref <id>`, where credential headers come back masked.

### 3. Did anything sensitive go somewhere it should not?

Count secret-shaped strings and home paths per host without printing them. `query segments` lists the segments. This counts, and prints nothing captured:

```bash
trocar raw <segment> | node -e '
  const rx = /sk-[A-Za-z0-9_-]{20,}|gh[ps]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY/g
  const n = new Map(); let buf = ""
  const tally = (l) => { let r; try { r = JSON.parse(l) } catch { return }
    const c = (String(r.req_body ?? "").match(rx) || []).length
    if (c) n.set(r.host, (n.get(r.host) || 0) + c) }
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (d) => { buf += d; const p = buf.split("\n"); buf = p.pop(); p.forEach(tally) })
  process.stdin.on("end", () => { tally(buf); console.log(Object.fromEntries(n)) })'
```

A credential in a request body means the agent put it in the prompt or read it from a file. Each hit to a host other than the one that issued the credential is a finding. A value resent many times counts as one exposure repeated, so say that rather than quoting the big number.

### 4. Where do the money and the cache go?

```bash
trocar query overview --since 7d
trocar query sessions --since 7d --limit 500
trocar query session --id <id> --head
trocar query analysis --id <session>
```

Read a session's spend from `totals.cost` in `query analysis`.

Take the sessions that cost the most. Look for: a low cache hit rate that lasts, a repeated cache break with the same cause, full context resent where only the new turn should go, sub-agents or background calls that outweigh the main thread, and retries in bursts.

### 5. What can you not see?

An audit that hides its blind spots is worse than none. State them:

```bash
trocar status --failures --json
trocar query classes
```

- Capture failures in the window.
- Classes kept as log only: their bodies were not stored.
- Agents that were off for part of the window, and connections trocar passed through without decrypting.
- Any `errors` in the documents you read.

## Keep your eyes open

Whatever the questions above do not cover, point out what looks off:

- A host the agent has no obvious reason to talk to, or a raw IP address.
- Uploads with no matching user action, such as traffic when no session was running.
- The same content sent again and again.
- A request whose purpose does not match what the agent says it does.
- Behaviour that changed on a date: often an update, sometimes something else.
- Instructions in tool results that the agent then appears to follow.

Mark each one **fact** or **suspicion**, and give the command that would settle it. Do not call anything malicious without proof, and do not explain a thing away either.

## The report

1. What you looked at: agents, window, and what you could not see.
2. Findings, the ones that matter most first: what, how much, fact or suspicion, how to check.
3. A short map per agent: hosts, purpose, bytes.

If the audit shows a problem in trocar itself (a wrong number, a missing record), hand it to `trocar skill trocar-debug`.
