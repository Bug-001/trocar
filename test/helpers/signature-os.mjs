// test/helpers/signature-os.mjs — a descriptor installed on the pseudo-OS 'none'. The collector tests install with osName 'none' so that no machine-wide
// config (/etc/…) of the machine running them is read (0.1 §3); the install manifest's liveness snapshot (4.6 撤销顺序) takes the descriptor's signature
// for that OS, which a real descriptor declares for 'linux' only. This is the same descriptor, declaring its linux signature for 'none' too, so a
// test can say which live processes `off` / `uninstall` should find. Exports only.
export const onNone = (d) => ({ ...d, signatures: { ...d.signatures, none: d.signatures.none || d.signatures.linux } })
