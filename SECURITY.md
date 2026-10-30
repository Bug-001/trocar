# Security policy

trocar decrypts the traffic of the agents you point it at, keeps a per-machine root certificate, and edits agent config files. A flaw in any of those can hurt the machine it runs on, so please report one privately.

## Supported versions

Only the latest 0.x release gets security fixes. Older versions do not; upgrade with `npm i -g trocar-cli@latest`, then run `trocar update`.

## Reporting a vulnerability

Report it privately through GitHub private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability** (https://github.com/Bug-001/trocar/security/advisories/new).

Never report a vulnerability in a public issue, pull request or discussion.

A useful report says which version (`trocar --version`) and OS, what an attacker needs (local user, another local user, a web page, a network position), what they gain, and the steps to reproduce. Remove tokens and captured traffic from anything you attach.

## Scope

In scope:

- the per-machine root certificate and its private key (how they are made, stored, trusted and removed);
- the decrypting local proxy and its doors (which processes it decrypts for, who can connect to it);
- captured data at rest under `~/.trocar`;
- the board's loopback token (who can read the board or its API);
- the agent config files trocar edits (what it writes, what it backs up, what `off` and `uninstall` leave behind).

Out of scope: the agents and model providers themselves. Report their flaws to their own maintainers.

## What to expect

This is a one-maintainer project, so the response is a modest best effort: an acknowledgement within about a week, then updates as the work goes on. There is no guaranteed time to a fix. Once a fix is released, the advisory is published, and you are credited in it if you want to be.
