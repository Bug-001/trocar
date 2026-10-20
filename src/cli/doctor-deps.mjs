// doctor-deps.mjs — the half of `trocar doctor` that reads the CAPTURE: the raw files, the records sampled out of them, the self-test
// and the two install-side checks. One file so `doctor.mjs` can start loading it and go on (D62, 1.6 §3.1): these sixteen modules
// (src/raw/*, src/capture/*, the two src/off ones) are nothing `status` needs, and eagerly they cost ~55 ms of a 695 ms
// `doctor` on a Windows test machine before the first byte is read. Loaded here they compile while the daemon answers `GET /status`.
// Nothing of its own: a re-export list, so the names `doctor` uses stay exactly the names their own modules export.
export { checkDeps, runSelfTest } from '../capture/selftest.mjs'
export { readRecords } from '../raw/ingest.mjs'
export { sealedReadProblem } from '../raw/journal.mjs'
export { listSources } from '../raw/discover.mjs'
export { orphanBackups } from '../off/backup.mjs'
export { checkStandalone } from '../off/standalone.mjs'
