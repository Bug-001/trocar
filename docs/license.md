# License

trocar is licensed under the [Functional Source License, version 1.1, with Apache-2.0 as the future license](../LICENSE)
(FSL-1.1-ALv2). It is source-available: you may use, copy, modify and redistribute it for any purpose except making
it available to others in a commercial product or service that competes with it. Each released version becomes
Apache-2.0 two years after its release. One part is licensed differently: the kernel-side eBPF program in
`src/collector/arch/linux/bpf/` is GPL-2.0-only OR MIT, as its license string declares, because the Linux kernel lets
only a program under a GPL-compatible license use the kernel helpers it needs. The rest of trocar's own code is
FSL-1.1-ALv2.

This license does not cover what trocar does not own. The agents' names and icons in `src/off/harness-icons/` and
`src/web/board/assets/harness/` belong to their owners and only identify those agents (see
[SOURCES.md](../src/off/harness-icons/SOURCES.md)); trocar is not affiliated with or endorsed by any of them. The packages
bundled into `src/web/board/assets/` keep their own licenses, listed in
[licenses.md](../src/web/board/assets/licenses.md).

Report a vulnerability privately as [SECURITY.md](../SECURITY.md) says. How to contribute is in
[CONTRIBUTING.md](../CONTRIBUTING.md); what changed in each release is in [CHANGELOG.md](../CHANGELOG.md).
