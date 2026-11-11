# Installing, updating and removing trocar

## Install

One line, nothing needed first: no npm, no Node. The script downloads trocar and an official Node build of its own,
checks both against the hashes the npm registry and the package record, and puts them in `~/.trocar/app`. It needs
no root and writes nothing outside `~/.trocar`. Then it runs `trocar install`, which prints its plan and asks
before it changes anything.

On macOS and Linux:

```sh
curl -fsSL https://github.com/Bug-001/trocar/releases/latest/download/install.sh | sh
```

On a Linux with wget and no curl:

```sh
wget -qO- https://github.com/Bug-001/trocar/releases/latest/download/install.sh | sh
```

On Windows:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -c "irm https://github.com/Bug-001/trocar/releases/latest/download/install.ps1 | iex"
```

The Windows line works in cmd, PowerShell and Win+R. In China, the scripts are also at
`https://cdn.jsdelivr.net/npm/trocar-cli/install/install.sh` (or `.../install/install.ps1`); each download tries npm
and nodejs.org first and moves to npmmirror when that source fails or is too slow. When security software blocks `irm | iex`, save the script first and run it as a file (cmd):

```bat
curl.exe -fsSLo "%TEMP%\trocar-install.ps1" https://github.com/Bug-001/trocar/releases/latest/download/install.ps1 && powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\trocar-install.ps1" & del "%TEMP%\trocar-install.ps1"
```

If the one-line command prints nothing or only a curl or wget error, and a new terminal has no `trocar` command, the download failed: a pipe into
`sh` that gets nothing still exits 0. Use the jsDelivr address above, or download the script first and run it as a file:

```sh
curl -fsSLo install.sh https://github.com/Bug-001/trocar/releases/latest/download/install.sh && sh install.sh
```

`trocar install` adds `~/.trocar/bin` at the end of your PATH (one marked line in your shell's start file; on
Windows one element of your user `Path`), so `trocar` works in a new terminal. A shell that is not interactive may not
read that file (Ubuntu's `~/.bashrc` stops early for one, so `ssh host trocar` does not find it): use `~/.trocar/bin/trocar`
there. Then start capture:

```sh
trocar on
```

For developers, from npm (Node ≥ 22). The package is `trocar-cli`; the command it installs is `trocar`.

```sh
npm i -g trocar-cli
trocar install
trocar on
```

`trocar install` sets up the certificates, once; `trocar on` then starts capture.

`npx trocar-cli <command>` runs one command without installing, but run `trocar install` from a global install:
it registers a login item that runs that copy, and npm may clear the `npx` cache.

On Linux, build the capability helper and install it once per machine, before `trocar install`. The package carries
its source, not a build: the build needs clang, make, bpftool, the libbpf, libelf and zlib headers, and a kernel
with BTF. Build as yourself; only the `sudo` lines need root. On Ubuntu (on Debian, install `bpftool` instead of
`linux-tools-generic`):

```sh
sudo apt-get install build-essential clang libbpf-dev libelf-dev zlib1g-dev linux-tools-generic
make -C "$(npm root -g)/trocar-cli/src/collector/arch/linux"
sudo "$(command -v node)" "$(command -v trocar)" setup-helper
```

The last line names `node` and `trocar` by their full paths because root's PATH may lack them (an nvm node, say).

Installed with the script, the helper cannot come first: its source arrives with the script. `trocar install` finishes
without it; the collector then runs and captures nothing, `trocar status` says the helper is missing, and the receipt's
last line is the `sudo` line to run. The code is under `~/.trocar/app/<version>` (the version is the first word of
`~/.trocar/app/current`): build with `make -C ~/.trocar/app/<version>/src/collector/arch/linux`, run that `sudo` line
(it names this copy's Node and code by their full paths; `trocar on` prints it too), then `trocar on`.

The same five commands on every OS, in this order: `trocar install` (once) → `trocar on` → `trocar off` →
`trocar status` (any time) → `trocar uninstall`. `install` lists every file it will touch and writes them after you
confirm; until it has run, `trocar on` refuses (`error.code` `cert-not-installed`). `on` starts capture, `status` shows state,
`off` stops routing and capture for your agents; the certificates, and the wrappers and plugins that carry them, stay until `trocar uninstall`. When a TLS failure with a host (a
sign-in page that intercepts TLS, for instance) made trocar pass that host's traffic on unread, `trocar on <agent>` again
makes trocar try decrypting it now; otherwise trocar tries again by itself later. Running
`trocar install` from another copy of trocar restarts the collector on that copy's code: the agents being captured
stay captured, and connections open at that moment are cut and retried by the agent.

From source (Node ≥ 22): there is no global `trocar` on your PATH, so run it through the repo.

```sh
git clone https://github.com/Bug-001/trocar && cd trocar && npm install --omit=dev
```

On Linux only, once per machine, build and install the helper:

```sh
make -C src/collector/arch/linux && sudo "$(command -v node)" bin/trocar.mjs setup-helper
```

Then set up the certificates once, and start capture:

```sh
node bin/trocar.mjs install
node bin/trocar.mjs on
```

From a GitHub Release: each Release carries the same tarball as npm and its `SHA256SUMS`. Download both into one
folder, check the sum there, then `npm i -g` the `.tgz` file; it installs like the registry copy.

On macOS (on Linux, `sha256sum -c SHA256SUMS`); each prints OK:

```sh
shasum -a 256 -c SHA256SUMS
npm i -g ./trocar-cli-<version>.tgz
```

On Windows, in PowerShell, `(Get-FileHash .\trocar-cli-<version>.tgz -Algorithm SHA256).Hash -eq (Get-Content SHA256SUMS).Split(' ')[0]`
prints `True` when the sum matches.

## Staying up to date

To take trocar to the newest code and leave the machine as it was:

```sh
trocar update
```

One command takes this checkout to the newest code and leaves the machine the way it was: it refuses to touch a checkout with changes of your own, fast-forwards (never merges), runs
`npm install --omit=dev` (no development tools) when what trocar needs changed, replaces the collector, runs `install`, and switches
capture on again for the agents that had it on. It prints the plan — which version to which, and which agents are
not captured while it runs — and asks first; `--yes` answers, `--dry-run` only prints, `--details` adds the commits.
While it runs those agents are not captured (their connections still work), and the collector is
replaced the way `uninstall` stops it: a response still on its way gets up to 30 s to finish (the update goes on as soon
as it has), then the old collector cuts the rest (a call left open, such as a WebSocket) and stops itself cleanly, so the
new one does not report that the previous one ended without a clean stop. The rows of what it cut, and its stop record,
say that `update` (or `uninstall`) stopped it. An agent that is on while the collector is replaced (an update with only the
collector to replace, or `trocar install` from another copy) stays captured: its new connections during those 30 s are
decrypted and recorded as usual, and a response on one of them is waited for like any other. An update that stops half way leaves a note
behind and says one thing to run: `trocar update`, which goes on from where it stopped. In a checkout it first pulls newer code if
there is any, so a fix that landed since is what finishes it; what cannot be pulled is said, and the code there finishes.
A checkout pulled with `git pull` instead is finished by the next `trocar update` too: while this checkout's own last `install`
ran older code it is not up to date, offline too, so update switches capture off, puts the service on the new code, installs and switches capture
on again. `status` and `doctor` name `trocar update` for that state; `trocar install` alone would leave what `on` wrote as
the older code wrote it.

A copy installed with the script updates with the same `trocar update`, or by running the install line again: it
downloads and checks the new version into its own folder before any agent goes off, then switches to it and finishes
as below. The previous version is kept until nothing can still start it.

A copy installed with npm updates through npm: `npm i -g trocar-cli@latest`, then `trocar update` finishes the
way a git update does: the collector on the new code, `install` again, and the agents that were being captured
switched on again. It finishes also when the collector already came back on the new code by itself (a reboot or a new
login in between): `install` records which code ran it, and until that is the new code there is something to finish. Run it from the copy the login entry starts (the one you ran `trocar install` from); from
another copy the collector comes back on the copy the entry starts, and `update` says so and exits 1.

A machine that ran the build from before the rename moves over once, by hand: that build's own `uninstall`, then
install trocar as described under [Install](#install). Nothing the old name left is read or kept.

## Uninstall

```sh
trocar off
trocar uninstall
```

`trocar off` comes first on macOS and Windows: `uninstall` refuses while capture is on. `uninstall` removes all of
trocar's changes and keeps your records (`~/.trocar/raw`, `~/.trocar/collector/flows`), the last ones sealed first. To
delete the records and their index too (it asks first):

```sh
trocar uninstall --purge-data
```

On macOS and Windows, `uninstall` takes every trocar root out of your user trust store, also one an earlier install left
without a record. `install` keeps you to one trocar root: if your trust store already holds one that trocar's install
record does not list, it changes nothing, names that root, and asks you to run `trocar uninstall` first.

Run `install` and `uninstall` with your account's own home: the login entry starts the background process there,
so with `HOME` (Windows `USERPROFILE`) set to another directory both commands change nothing and name the two homes.

On Linux the machine's capability helper is one more step, with `sudo`. Installed from npm, run it after `uninstall`:
`sudo "$(command -v node)" "$(command -v trocar)" setup-helper --remove`.

Installed with the script, `uninstall` also removes trocar itself as its last step: `~/.trocar/app` (the code and its
Node), the `trocar` launcher and the PATH item. On Windows the folder goes as soon as the command exits. On Linux the
helper is one per machine and other accounts may use it, so while it is installed `uninstall` removes everything else
of yours as usual and keeps only the code, the launcher and the PATH item, which removing the helper needs. It exits 0
and prints the `sudo ... setup-helper --remove` line with full paths. If no other account uses trocar, run that line,
then `trocar uninstall` once more: the second run removes the code, the launcher and the PATH item (after `--purge-data`, nothing of trocar's is left). `--remove` checks
every other account's home for a trocar install and removes nothing while it finds one or cannot read a home, naming
them. Once trocar itself is gone, the receipt names the kept folders to delete by hand.

`uninstall` always prints its plan and asks first; without a terminal and without `--yes` it changes
nothing and exits 2. On macOS and Windows `uninstall` never does `off` for you (on Linux it turns capture off itself): while a harness is on, or a process started during `on` still
holds a door, it changes nothing, exits 1 with `error.code` `collectors-online` and names the harnesses and the pids.
If the system's prompt to remove trocar's root certificate is not answered, `uninstall` exits 1, names the
certificate and the command to remove it by hand, and the next `trocar uninstall` tries again.

On macOS, `launchctl print-disabled gui/$(id -u)` still lists `"com.trocar.collector" => enabled` after
`uninstall`: `launchctl` has no command that removes such an entry. It is harmless: with the LaunchAgent file gone,
it starts nothing. The receipt says so in a note.
