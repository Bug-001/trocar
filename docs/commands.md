# Commands

`trocar help` lists every command; `trocar help <command>` (or `trocar <command> --help`) gives one command's usage,
options and exit codes, and `trocar query <name> --help` describes one query. `trocar help --json` gives all of it as
one document.

| Command | What it does |
|---|---|
| `trocar install` | Once per machine: makes this machine's own root certificate, trusts it for your user and places the certificate each agent reads. It prints the plan and asks first; it never turns capture on. |
| `trocar on` | Starts capturing the agents you name, or every agent `install` knows when you name none. It touches no certificate and restarts no agent. |
| `trocar off` | Takes away everything trocar did to the agents you name, or to all of them: they see the real provider again and nothing new is recorded. It works even when trocar itself is broken. |
| `trocar status` | Which agents are being captured, and why not for the ones that are not; what failed recently. Name an agent for its details. |
| `trocar uninstall` | Removes what `install` put on this machine. Capture must be off first. Your captured data stays unless you ask for it to go. |
| `trocar doctor` | Finds what keeps capture or the network from working and says how to fix it. It changes nothing. |
| `trocar query` | The one way to read what was captured: named queries with their own parameters. The board asks the same queries. |
| `trocar classes` | Shows and edits which hosts belong to which traffic class, and how much of each class is kept. Changes apply to calls made afterwards. |
| `trocar board` | Opens the board in your browser. |
| `trocar update` | Takes trocar to the newest code and leaves the machine as it was, capturing what it was capturing. |
| `trocar raw` | Prints captured records byte for byte. |
| `trocar daemon` | Runs the background collector in the foreground. It starts at login by itself, so you do not normally type this. |
| `trocar setup-helper` | Linux only, once per machine, with `sudo`: installs the helper capture needs there. |
| `trocar help` | The list of commands, or one command's page. |

`install`, `on`, `off`, `status`, `uninstall`, `doctor` and `update` take `--details` for every fact their short
text leaves out, and `--json` for the same as a document. The commands that change something print their plan and
ask first; `--yes` answers for you and `--dry-run` only prints the plan.

Exit codes: 0 done · 1 not done, or a problem was found · 2 a usage error (nothing was touched) · 3 `status` or
`doctor` could not judge · 70 the background collector crashed. `--version` prints the version.
