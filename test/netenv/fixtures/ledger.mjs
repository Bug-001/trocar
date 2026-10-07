// ledger.mjs — the install manifest's door as the Verge adapter uses it (RFC 4.7 §4, 1.6 R1 R2), in memory, with backups written the way R2 says: under <home>/.asight/backup, one per change, named
// `<sha256 of the path, 16 hex>-<UTC time>`, never overwriting one. The real thing is CLI task 3's (src/off/manifest.mjs + backup.mjs), wired in by Task 8 once that lands; the adapter only needs these seven.
//   entries()  the recorded entries (copies)             find(kind, key)   one entry or null              record(entry)  upsert by (kind, key); every entry has a non-empty `undo_by_hand`
//   forget(kind, key)                                     backup(file, data) → path (throws code 'backup-failed' while `failBackups` is set)
//   dropBackup(path)   keepBackup({ path, backup, reason })  → kept()
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export function memoryLedger({ home, now = () => new Date() } = {}) {
  const entries = []
  const kept = []
  const dir = path.join(home, '.asight', 'backup')
  const ledger = {
    failBackups: false,
    entries: () => entries.map((e) => ({ ...e })),
    kept: () => kept.map((k) => ({ ...k })),
    backups: () => (fs.existsSync(dir) ? fs.readdirSync(dir).map((n) => path.join(dir, n)) : []),
    find: (kind, key) => entries.find((e) => e.kind === kind && e.key === key) ?? null,
    record(entry) {
      if (typeof entry.kind !== 'string' || typeof entry.key !== 'string' || typeof entry.undo_by_hand !== 'string' || entry.undo_by_hand === '') throw new TypeError(`a ledger entry has a kind, a key and an undo_by_hand: ${JSON.stringify(entry).slice(0, 80)}`)
      const i = entries.findIndex((e) => e.kind === entry.kind && e.key === entry.key)
      if (i >= 0) entries[i] = entry; else entries.push(entry)
    },
    forget(kind, key) { const i = entries.findIndex((e) => e.kind === kind && e.key === key); if (i >= 0) entries.splice(i, 1) },
    backup(file, data) {
      if (ledger.failBackups) throw Object.assign(new Error('the backup directory cannot be written'), { code: 'EACCES' })
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const stamp = now().toISOString().replace(/[-:.]/g, '')
      const base = `${crypto.createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 16)}-${stamp}`
      let p = path.join(dir, base)
      for (let n = 1; fs.existsSync(p); n++) p = path.join(dir, `${base}-${n}`)
      fs.writeFileSync(p, data, { mode: 0o600, flag: 'wx' })
      return p
    },
    dropBackup(p) { fs.rmSync(p, { force: true }) },
    keepBackup(info) { kept.push({ ...info }) },
  }
  return ledger
}
