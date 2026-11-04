# Adding a harness

The fixed path for adding a harness to trocar, or a new form or platform to one it already has: every stage, how to check it, and what counts as done.

The design rules are not repeated here. Entries and carriers are [spec 4.11](../spec/01-trocar-rfc/4.11-collector-model.md) §2.3 and §2.4; the Linux name list and trust are [4.6](../spec/01-trocar-rfc/4.6-process-collector.md); the read side is [3.1](../spec/01-trocar-rfc/3.1-adapter-contract.md) and [3.4](../spec/01-trocar-rfc/3.4-session-identity.md). This page puts them in order.

A form is one way the agent ships: a CLI per install method, an editor extension, a desktop app, a service mode.

## 1. What done means

All of these hold, and the pull request says for each one whether it passed, with a pointer. If you cannot check one, say so: [section 5](#5-evidence-you-can-give) says what to give instead.

1. **Every form has an outcome.** Each form × OS is in scope or out of scope. Out-of-scope forms are still listed in the descriptor, with `verified: { reason: 'out-of-scope' }`. No form is simply unmentioned.
2. **`on` opens.** The entries and the certificate carriers land where the plan says, and the receipt tells the truth.
3. **After `on` it works.** A real turn is recorded verbatim, request and reply.
4. **`off` is clean.** Nothing of trocar's is left in the agent's path and the agent's own proxy settings are as they were, including when the user edited the same file between `on` and `off`.
5. **Linux.** The CLI form works on Linux, or the pull request shows why it cannot.
6. **The read side.** Calls land in the right session and lane (main, sub-agent, background), and a compaction call stays in its session. A new wire format passes the checks in 3.1.
7. **Docs.** `README.md` names the harness and `docs/release-notes/` has a note.
8. **Review.** Someone with no part in the change, or an agent in a fresh context, reviewed the branch against [0.1 §6](../spec/01-trocar-rfc/0.1-engineering-rules.md). `HOME=$(mktemp -d) npm test` is green and its counts are in the description.
9. **A real install.** The other install methods, an upgrade, a reinstall and the usual user configurations were each tried once (stage 5).

## 2. The stages

| Stage | Output | What turns red |
|---|---|---|
| 0 Scope | an agreed list of forms | nothing, it is a decision |
| 1 Census | a table per form × OS, every cell with its evidence | nothing, it is measurement |
| 2 Carriers | the entry, certificate and trust of each form, with a reason | `verdictOf` on your draft |
| 3 Descriptor | `src/collector/harness/<h>.mjs` and its tests | the loader's validation, the name and marker tests |
| 4 Read side | a read-side row, a registry row, an icon; a dissector if the format is new | `test/cli/harness-names.test.mjs`, the icon test, the 3.1 checks |
| 5 Try it | each form on a real machine, then each other install | your own evidence, section 5 |
| 6 Review and PR | the checklist of section 1 | `npm test` from a fresh HOME |

1 comes before 2, and 2 before 3. Stage 4 can run beside stage 3.

## 3. Stage by stage

### Stage 0: scope

The list of harnesses is a decision (D37 in [0.0](../spec/01-trocar-rfc/0.0-overview.md)). Open an issue first, saying what the agent is, which forms it ships on which OS, and which of them you want in scope. A new form or platform of a harness already on the list needs no such step.

### Stage 1: census

Every value in a descriptor is a measured fact. More late bugs came from a census question nobody asked than from any other stage, so answer all seven groups before writing a value that depends on them. Start from the source and the docs, mark each answer "inferred", and then measure on a real install. An answer that comes only from docs, a blog post or reading source stays "inferred" and is not used as fact.

Measure on each OS: process shape, trust store, environment variable case, how the environment of another process can be read, and the install layout. A fact that depends only on the agent's own code (how it parses proxy variables, how SOCKS fails, the plugin interface, the wire format) can be measured once.

1. **Install and update.** Where each official method puts it (installer, npm or pnpm, Homebrew, MSIX or winget, bundled in an editor extension or desktop app) and which version. How auto-update swaps files: in place, by rename, by directory. What rerunning the official installer changes.
2. **Process shape.** Read it the way the product does (macOS: first `txt` from `lsof`, argv from `ps`; Windows: image path and command line; Linux: `/proc/<pid>/exe` and cmdline), right after start and again a second later, because process titles change. Find the real name behind symlinks, interpreters, Electron helpers, version-numbered file names. Find **which process holds the model connection** (a resident daemon, an app server, a Chromium network service, an extension host), how long it lives and how many sessions it serves. Find children with the same name that are not the agent, and the launcher chain.
3. **Proxy settings.** Every layer the agent reads and their order: each spelling of the environment variables (`HTTPS_PROXY`, `https_proxy`, `ALL_PROXY`, `NO_PROXY`), its user config, **project-level config found by walking up from the cwd**, desktop app settings, managed policy, command-line flags, the system proxy. Measure with a controlled test: give each layer a different dummy proxy and see where the connection goes. Find any layer that switches others off, whether a running process rereads settings, and whether SOCKS and `https://` proxies work.
4. **Trust.** With only a user-level root installed (the login keychain's user trust on macOS, `CurrentUser\Root` on Windows), does the agent accept a chain through an intermediate? If not: which certificate settings it reads, whether each adds or replaces, which wins, which empty value turns others off. Whether its default roots are the OS's or Node's own. **The chosen carrier must then be measured alone, on each form × OS, with no other trust set.** That measurement is the only ground for `verified: true`.
5. **Wire format and hosts.** The model endpoint, the transport (HTTP/1.1, h2, WebSocket), the stream framing. Whether an existing dissector reads it (`src/dissect/registry.mjs`). How session, sub-agent and compaction show up in the request. The non-model hosts (telemetry, sign-in, updates, plugin markets). **Requests in the same process that do not use its trust path**, which must only be forwarded.
6. **Relays and sign-in walls.** Whether a base URL and a dummy key can point it at a test server for a full turn. If not, where the account wall is and what signed-out output looks like.
7. **Observer effects.** What changes in the agent once a certificate or plugin is in place: request compression, TLS stack, ALPN, extra first-run downloads.

**Check:** every form × OS row has an answer with evidence or "not measured" and a reason, and no answer comes from docs alone.

### Stage 2: choosing carriers

Follow [4.11 §2.4](../spec/01-trocar-rfc/4.11-collector-model.md), form by form, with a one-line reason from the census for each choice:

- **Entry.** First a kind-1 entry, in the agent's own files: `json-key`, `dotenv-block`, `plugin-file`. Only without one, a kind-2 `switch-file` with a hook carrier.
- **Certificate.** First `root`. If that does not reach the agent, in order: `config-key` (replace semantics use the merged bundle, add semantics use `trocar-ca.pem`), then `wrapper` (only for a single native executable in the user's own folder that updates by file name, not a script, not in a package manager's directory), then `plugin` (when the host's plugin interface already has a template).

Then:

- Run `git grep -n "<harness>\|<primitive>" spec/01-trocar-rfc/`, and list every MUST, SHOULD, decision and invariant it hits in the pull request.
- **Feed your draft to the verdict.** With representative process facts from the census (no certificate variable set; the user's own CA variable set), call `verdictOf` from `src/collector/core/proxymode/verdict.mjs` for each form, with `verified` temporarily `true` and the carrier older than the process. Each should give `{ decrypt: true }`. If not, the carrier is wrong or the verdict has a defect.
- **A new primitive** is allowed only when P1 to P13 cannot reach the agent: spec change first, and the pull request says why no existing primitive can be widened. The editing code has no branch per product or version.
- **A defect in a shared primitive** that the census finds gets its own pull request, spec first and red first, with the harness stacked on it. A harness change never touches `src/collector/core/` or `src/collector/arch/`.

### Stage 3: descriptor and names

Write the test that turns red first, then the data.

| What | File | What turns red |
|---|---|---|
| Process shape seeds: one per install method × OS from stage 1, with `source` saying what kind of source it is | `test/helpers/proc-seeds.mjs` | `test/collector/core/identity-presets.test.mjs` runs each seed and its generated variants; a descriptor with no seed fails |
| The descriptor, starting from the pure-data sample `test/collector/harness/fixtures/eighth.mjs`: `name`, `runtime`, `processes`, `hosts`, `proxy`, `proxyMode` (`forms`, `routes`, `certs`, `trusts`, `userCertFiles`, `blockers`, `effects`, `notes`) | `src/collector/harness/<h>.mjs` | validation at load (`src/collector/harness/index.mjs`) and `test/collector/harness/` |
| `verified[os]` for each form: `true` only on census question 4 for that form × OS, otherwise `{ reason: 'not-measured' }` | same | shape at load; the evidence behind it only in review |
| Linux: `trust.chain`, `inject`, `layers`, `configHosts`, `bypass` (functions, for now) | same | `test/collector/harness/<h>.test.mjs`, modelled on `z-code.test.mjs`; nothing forces you to write it, review checks it |
| `proxy.measured`: per OS, measured or inferred (`status` and `doctor` then report `inferred-behaviour`) | same | shape at load (`proxyProblems`) |
| The registry row: id, read-side id when it differs, aliases, display name, icon | `src/off/harness-names.mjs` | `test/cli/harness-names.test.mjs` holds it equal to the descriptors |
| Where `off` looks when its manifest is lost: `MARKER_PATHS`, and `ROUTE_PLACES` for a `plugin-file` or `dotenv-block` route written by `on` | `src/off/marker.mjs`, fixture `test/off/fixtures/seven-homes.mjs` | `test/off/marker.test.mjs` checks the keys; the contents are checked only in review |
| The harness in the lists of `README.md` | `README.md` | `test/readme-truth.test.mjs` |
| Its own reason codes and their English, if any | `src/cli/words.mjs`, `src/health/codes.mjs`, `src/collector/core/codes.mjs` for the daemon's hints | `test/cli/words-findings.test.mjs`, `test/health/codes.test.mjs` |

Not to change: `src/collector/core/**` and `src/collector/arch/**` (guard CM27, `test/collector/harness/eighth.test.mjs`). Nothing to register: `loadHarnesses()` reads every `*.mjs` in the directory. New tests take their expectations from `loadHarnesses()` or the read-side table, and do not list names.

`verified` is not a per-form switch. The door judges a harness, not a form: when a sibling form on the same entry is verified, the door decrypts an unverified one too (`judgedForms`). So the trust measurement for a new form on a shared entry comes before the merge. Conversely, each `route` needs at least one verified form on each OS: a door with none only forwards.

**Check:**

```sh
npm test -- 'test/collector/harness/*.test.mjs' test/collector/core/identity-presets.test.mjs test/collector/contract/switch-contract.test.mjs test/collector/core/proxymode/verdict.test.mjs test/cli/harness-names.test.mjs test/off/marker.test.mjs
git grep -n '<h>' src/collector/core src/collector/arch   # comments only
```

### Stage 4: read side

| What | File | What turns red |
|---|---|---|
| The read-side row: id, `agents`, `sessionKeys`, `parentKeys`, `lane`, `compaction`, `requestKind`, `synth` when there is no session key, `observerEffects` per capture mode, the `traffic` classes | `src/dissect/harnesses.mjs` | `test/cli/harness-names.test.mjs` when missing; then `test/dissect/harnesses.test.mjs` and `test/dissect/traffic.test.mjs`, with cases shaped like real requests |
| The icon, and a line saying where it came from | `src/off/harness-icons/`, `SOURCES.md` there | `test/web-v2/harness-icons.test.mjs` |
| A new vendor: host to vendor | `src/dissect/vendors.mjs` | `test/dissect/vendors.test.mjs` |
| **Only for a new wire format:** a dissector with the methods of 3.1, registered in `src/dissect/registry.mjs`, and a representative request in `test/helpers/seven-shapes.mjs` | `src/dissect/<wire>.mjs` | the checks in 3.1: every block traces back to its source bytes, unmapped keys stay visible, unclaimed traffic is set aside |

The board needs no change: its names and icons come from the registry, and `test/web-v2/harness-seam.test.mjs` and `test/web-v2/no-provider-branches.test.mjs` keep it that way.

**Check:** `npm test -- 'test/dissect/*.test.mjs' test/web-v2/harness-seam.test.mjs test/web-v2/harness-icons.test.mjs`. After a first real turn, `trocar query sessions` and `trocar query calls` agree with the turns you ran.

### Stage 5: try it on a real machine

Run each form on a machine that is yours to change: `install`, `on`, a real turn, `off`, another turn, then `uninstall`. Between `on` and `off`, edit an unrelated field in a file `on` wrote to, and check that the edit survives. Never set a proxy key or a certificate variable by hand for the run: what is being tested is what `on` and `install` provide.

Then, once each:

- every other install method from census question 1;
- an upgrade of the agent, and a rerun of its official installer, then `trocar status <h>` (this is what overwrites hook carriers);
- the user's own settings: a certificate setting pointing at their own file, their own upstream proxy, a proxy or certificate set in project config. `status` must name the blocker or report the form untrusted, never stay silent;
- a real model long enough to trigger the agent's own compaction, if you can. A mock never makes an agent compact, and session grouping of compaction calls can only be seen this way.

If a form is not captured, look at the engine's connection counts before blaming certificates: flat counts mean the traffic never reached the door, so check identity and the entry.

A new shape found here goes back to stage 1 and stage 3. Do not work around it.

### Stage 6: review and pull request

- For each acceptance list the change touches (4.11 §5, 4.6, 3.4, and 3.1 for a new format), turn each item into a test that fails without the change, point at the existing test, or say why it does not apply.
- Reviewers go through what no test forces, in the diff: the contents of `MARKER_PATHS`, the sample in `seven-shapes.mjs`, the descriptor's own test, and the evidence behind each `verified: true`.
- New words in CLI output: render them with `node scripts/cli-shot.mjs -- node bin/trocar.mjs <command>`, in both `status` and `status <h>`. The detail comes from the daemon's hint in `src/collector/core/codes.mjs`, not `src/cli/words.mjs`, and both must read as plain English for a user.
- Commit size, spec order and the pull request template are in [CONTRIBUTING.md](../CONTRIBUTING.md).

### Afterwards: each agent upgrade

An upgrade can change the wire format, the process shape and the config layers. When a new version lands, run stage 5's turn again and read a session of it: the context grows from turn to turn and the lane count matches. If not, go back to stage 1.

## 4. The bugs that arrive late

These are the kinds of bug that showed up after a harness was thought done, and the step that catches each one.

| Kind | Typical case | What catches it |
|---|---|---|
| Process identity and install layout | an agent renames its process title; a desktop app runs in a Helper; a symlink hides `python3.14`; each package manager lays files out differently; a busy machine times out the process lookup | census 1 and 2, the seeds of stage 3, the install methods of stage 5 |
| Proxy layers, spelling and entry position | lowercase `https_proxy` wins; project and managed settings; a user's line after trocar's block wins, and a duplicate YAML key too; a route plugin that ignores `NO_PROXY` | census 3, `blockers` and order in stage 3, the user edit and user configs of stage 5 |
| Trust semantics and shared carriers | two agents read one `NODE_EXTRA_CA_CERTS` file and the second append is refused; upstream verification forgets the agent's own certificate variable | census 4, replace semantics to a merged bundle in stage 2, one `install` with every harness present |
| When a setting takes effect, and resident holders | a managed daemon's environment is frozen at the first TUI; a gateway or resident form keeps going through the door after `off` | census 2 and 3, `takesEffect` and `rereads` |
| Life cycle of switches and carriers | rerunning an official installer overwrites a wrapper; an interrupted run leaves trocar's value, and the next `install` reads it as the user's; `off` writes an old value over the user's new one | census 1, the upgrade and reinstall of stage 5 |
| Platform shapes | dotenv reads Windows backslashes as escapes; an injected stand-in hides the real path; another process's environment cannot be read on macOS or Windows, so it cannot be a trust gate | validation at load, the switch contract generated for each OS, real runs on each OS, and finding every call site of the same kind when you change one |
| Evidence the test made | a pass that depends on a proxy key or CA the test wrote itself, not the product; a throwaway HOME that hides the keychain | stage 5: provide nothing the product does not provide |
| Read side, wire format, upgrades, observer effects | a session key rule that knows only one agent; a new message format turned on by an upgrade; parallel sub-agents on one lane; a plugin manifest's `name` sent to the model | census 5 and 7, read-side tests shaped like real requests, each agent upgrade |
| Done with no evidence | a form marked verified that nobody ran; "only proved the routing" counted as captured; a blamed certificate when the counts showed the traffic never arrived | section 1, the `verified` rule, counts before blame |

Four rules come out of this table:

1. `verified[os]: true` rests only on the trust measurement for that form × OS. Otherwise it is `{ reason: 'not-measured' }`.
2. Read the engine's counts before naming a cause.
3. A test run provides nothing the product does not give: no proxy key, no certificate variable, no door.
4. Green on Linux says nothing about macOS or Windows: Linux can read another process's environment, and they cannot.

## 5. Evidence you can give

You need not own every OS. A pull request that covers the forms you can measure, and says plainly what it does not cover, is welcome. Give:

- **`trocar status <agent> --json`** from your machine, while the agent is on and after a turn: the verdict for each form.
- **`trocar doctor <agent> --json`**: its conclusion.
- **`node scripts/contract-check.mjs --json`**: the counts of pass, fail and skip, and the id of anything that failed.
- **Your census**, as a table of question, answer and how you measured it.
- **Tests on synthetic fixtures**: process seeds, and records written from scratch that have the shape you measured.

Run the first three yourself, on your own machine. They are never part of a test, and `npm test` runs under a temporary HOME. Before pasting their output, keep only the fields you need: home paths, host names and session ids are yours, and `node scripts/pr-check.mjs` refuses them.

**Real captures never go into a pull request.** Not a record, not an edited record, not a screenshot of a real session. Describe the shape instead (keys, types, sizes, order of events), and see [reproduce.md](reproduce.md) for how to build data with it.

Whatever you could not measure stays honest in the data: `verified: { reason: 'not-measured' }`, an inferred `proxy.measured`, and a line in the pull request saying which form × OS and why.
