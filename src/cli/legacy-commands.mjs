// legacy-commands.mjs — the commands that keep the bodies they had when bin/asight.mjs held them all (RFC 1.6 §2, D39): `serve`, `etl`, `shard` and `raw`. The bodies were moved here unchanged; the table
// of src/cli/commands.mjs calls `runLegacyCommand(name, rest)`. They print with console.* and set process.exitCode, as they always did; runLegacyCommand hands that code back as its result (and leaves
// process.exitCode as it found it), so the dispatch can return it like every other command. The old capture's own commands — `capture`, `mitm`, `desktop`, `monitor` — went with the old capture
// (D39⑥ executed 2026-10-11, feat/retire-legacy); `shard` stayed (it is the raw layer's ingestion, not a capture source) and moved to the help's data section.
// `verifyOldCa` is the old `asight verify`, which lives on as `asight doctor --only old-ca` (the hidden alias of §2): a read-only question that still answers on machines the old capture was once on.
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { asightHome, mitmOut, serveSource } from '../paths.mjs'
import { parseArgs } from '../cli-args.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const die = (m) => { console.error(m); process.exit(1) }
const r = (...p) => path.join(ROOT, ...p)

export const LEGACY_COMMANDS = new Set(['serve', 'etl', 'shard', 'raw'])

/** Runs one of LEGACY_COMMANDS with the arguments after its name → the exit code the body set (0 when it set none). */
export async function runLegacyCommand(cmd, rest) {
  if (!LEGACY_COMMANDS.has(cmd)) throw new RangeError(`not a command of src/cli/legacy-commands.mjs: ${cmd}`)
  const prior = process.exitCode
  process.exitCode = undefined
  let code = 0
  try { await body(cmd, rest) } finally { code = Number(process.exitCode) || 0; process.exitCode = prior }
  return code
}

/** The old `asight verify` (now `asight doctor --only old-ca`): is the old capture's CA in the user-level trust store and in no machine-wide one. Exit 0 either way it is answered; 1 when the store could not be asked
 *  (never 「not installed」 for 「could not check」). `deps.verify()` replaces the question (a test's); otherwise this home's keychain / NSS database is asked, never the real one of whoever runs a test. */
export async function verifyOldCa({ io, home, platform, deps = {} }) {
  let v
  try {
    v = deps.verify ? deps.verify() : (await import('../capture/onboard.mjs')).verifyUserTrustOnly({ platform, installerOpts: { keychain: path.join(home, 'Library', 'Keychains', 'login.keychain-db'), nssdb: path.join(home, '.pki', 'nssdb') } })
  } catch (e) { io.out(`CA trust ? ${e.message}`); return 1 }
  io.out(v ? 'CA present in user-level trust store, no machine-wide trust ✓' : 'CA not installed ✗ (the board\'s 监测 toggle installs it; the CLI face is retired)')
  return 0
}

async function body(cmd, rest) {
  // Parsing lives in src/cli-args.mjs so it can be tested: `positional()` used to return the first
  // non-flag-NAME argument, i.e. the VALUE of any valued flag (`--interval 10` → "10" as the file).
  const args = parseArgs(rest)
  const flag = args.flag
  const positional = args.positional
  switch (cmd) {
    case 'serve': {
      const { createServer } = await import(r('src', 'server.mjs'));
      const port = Number(flag('--port', process.env.ASIGHT_PORT || 9800));
      const control = rest.includes('--control') || process.env.ASIGHT_CONTROL === '1'; // D26 opt-in
      const { server } = await createServer({
        dbPath: flag('--db', process.env.ASIGHT_DB || undefined),
        // No --source means the DEFAULT capture location, not "nothing" (README:72-77). This
        // passed a bare null, so a plain `asight serve` rendered an empty board on a machine
        // full of captures — a failure shaped exactly like the honest "nothing captured yet"
        // state, which is why it survived. src/paths.mjs exists to keep what capture WRITES and
        // what serve READS in agreement; this verb is the one it was written for.
        sourcePath: flag('--source', process.env.ASIGHT_SOURCE || serveSource()),
        sessionsRoot: path.join(asightHome(), 'sessions'),   // where `asight raw seal` files by session (D35)
        control,
        captureTarget: flag('--capture-target', undefined),
        proxyUrl: flag('--proxy', undefined),
      });
      server.on('error', (e) => { console.error('server error:', e.message); if (e.code === 'EADDRINUSE') process.exit(1); });
      server.listen(port, '127.0.0.1', () => console.log(`asight serving http://127.0.0.1:${port}${control ? '  (control plane ON — /control/* enabled)' : ''}`));
      break;
    }
    // D26: the transparent-monitoring switch — the CLI face `monitor` went with the old capture (D39⑥); the web switch
    // itself stays and maps to the same code (src/capture/control.mjs monitoringOn/Off/Status, src/server.mjs).
    case 'etl': {
      const { etlFile, reportSkips } = await import(r('src', 'etl', 'cli.mjs'));
      const file = positional();
      if (!file) die('usage: asight etl <ndjson|sealed|dir> [--db <path>] [--rebuild]');
      const out = await etlFile(file, { dbPath: flag('--db', undefined), rebuild: rest.includes('--rebuild') });
      console.log(`ETL: ${out.records} records from ${out.file} → ${out.dbPath}`, JSON.stringify(out.stats));
      reportSkips(out); // also the sealed files read only in part (journalled by etlFile)
      if (out.sourceErrors.length) process.exitCode = 1;
      break;
    }
    case 'shard': {
      // Per-session sharding of the capture stream (RFC 4.2 / D20: capture stays a pure tee, this
      // grouping is ETL). One week of real use produced a 7.58 GB single file that `asight serve`
      // could not open; sharded, the board reads only the session being viewed.
      const { shardOnce, rebuildMeta, resplitShards } = await import(r('src', 'etl', 'shard.mjs'));
      const file = positional() || flag('--file', mitmOut());
      const outDir = flag('--out', path.join(asightHome(), 'sessions'));
      if (rest.includes('--resplit')) {
        // One-time migration: split LEGACY single-calls.ndjson shards into {calls,probes,other}.ndjson
        // (byte-conserving, keeps a backup until each swap lands). Then refresh meta so counts match.
        const t0 = Date.now();
        const res = await resplitShards(outDir);
        console.log(`shard: resplit ${res.done} sessions (${res.skipped} already split, ${res.failed} failed) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        for (const f of res.failures || []) console.log(`shard: resplit left ${f.dir} as it was: ${f.reason}${f.sessions ? ` (${f.sessions.join(', ')})` : ''}`);
        const mr = await rebuildMeta(outDir);
        console.log(`shard: rebuilt meta for ${mr.sessions} sessions (${mr.records} records${mr.malformed ? `, ${mr.malformed} malformed line(s) not counted` : ''})`);
        for (const e of mr.errors) console.error(`shard: meta.json of ${e.session} left as it was — ${e.file} could not be read in full: ${e.reason}`);
        if (mr.errors.length) process.exitCode = 1;
        break;
      }
      if (rest.includes('--rebuild-meta')) {
        // Backfill/repair per-session meta.json (the archive layer) by streaming each existing shard.
        const t0 = Date.now();
        const res = await rebuildMeta(outDir);
        console.log(`shard: rebuilt meta for ${res.sessions} sessions (${res.records} records${res.malformed ? `, ${res.malformed} malformed line(s) not counted` : ''}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        for (const e of res.errors) console.error(`shard: meta.json of ${e.session} left as it was — ${e.file} could not be read in full: ${e.reason}`);
        if (res.errors.length) process.exitCode = 1;
        break;
      }
      const watch = rest.includes('--watch');
      const every = Number(flag('--interval', 5)) * 1000;

      const run = async () => {
        const t0 = Date.now();
        const res = await shardOnce({ file, outDir });
        if (res.missing) { console.error(`shard: no such capture: ${file}`); return res; }
        // Report rotation loudly: it means the watermark was discarded and the whole file re-read.
        if (res.rotated) console.log(`shard: capture ${res.reason} — re-read from 0`);
        if (res.records || !watch) {
          const secs = ((Date.now() - t0) / 1000).toFixed(1);
          console.log(
            `shard: +${res.records} records (${(res.bytes / 1e6).toFixed(1)} MB) from offset `
            + `${res.resumedFrom} → ${res.offset} in ${secs}s`
            + (res.unassigned ? `, ${res.unassigned} without a session header` : '')
            + (res.unkeyed ? `, ${res.unkeyed} inference calls keyed outside the headers (→ _unkeyed/)` : '')
            + (res.partial ? ', trailing partial record left for next run' : ''),
          );
        }
        return res;
      };

      if (!watch) { await run(); break; }
      // D38 L-13: a round that fails is a line in ~/.asight/logs/mitm-events.ndjson (the board's 采集健康 shows it),
      // once per distinct error — the same one again is not re-written until a round succeeds
      const { appendLegacyEvent, failureOf } = await import(r('src', 'capture', 'events.mjs'));
      console.log(`shard: watching ${file} → ${outDir} every ${every / 1000}s`);
      let lastErr = null;
      for (;;) {
        try { await run(); lastErr = null; } catch (e) {
          const key = `${e && e.code}|${e && e.message}`;
          if (key !== lastErr) appendLegacyEvent(failureOf('shard', e, 'shard-failed', { file, reason: `asight shard --watch failed (${(e && e.message) || e}): new sessions in ${file} do not reach ${outDir} until it succeeds` }));
          else console.error(`shard: ${(e && e.message) || e}`);
          lastErr = key;
        }
        await new Promise((res2) => setTimeout(res2, every));
      }
    }
    case 'raw': {
      // D35 (RFC 4.2 §原始层封存). Every outcome that is not plain success is also written to the raw
      // journal (~/.asight/raw/journal.jsonl) — `asight raw journal` shows it.
      const sub = positional(0), target = positional(1);
      const mod = (m) => import(r('src', 'raw', m));
      const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
      const usage = 'usage: asight raw seal <closed-shard> [--sessions <dir>]\n'
        + '       asight raw seal --legacy <file|dir> [--dry-run] [--delete-original] [--quiet <seconds>]\n'
        + '       asight raw verify <sealed|dir> [--against <original>]\n'
        + '       asight raw compare <dir> [--list]\n'
        + '       asight raw export <session-id|file.sealed> [--sessions <dir>] [--out <dir|file>]\n'
        + '       asight raw journal [--tail <n>]';
      if (sub === 'seal') {
        if (!target) die(usage);
        try {
          if (rest.includes('--legacy')) {
            const { sealLegacy, failureState } = await mod('legacy.mjs');
            const deleteOriginal = rest.includes('--delete-original');
            const q = flag('--quiet', undefined);
            const dryRun = rest.includes('--dry-run');
            const res = await sealLegacy(path.resolve(target), { deleteOriginal, dryRun, quietMs: q === undefined ? undefined : Number(q) * 1000,
              onFile: (f) => console.log(`  ${f}`) });
            // what is not sealed is said, never passed over (review 3 F5): each odd file with its reason,
            // the known markers as a count
            const pre = dryRun ? 'would skip' : 'skipped ';
            for (const x of res.skipped) console.log(`${pre} ${x.file}: ${x.reason}`);
            const kinds = Object.entries(res.known).sort(([a], [b]) => (a < b ? -1 : 1));
            if (kinds.length) console.log(`not a record stream (left as they are): ${kinds.map(([k, n]) => `${n} ${k}`).join(', ')}`);
            if (dryRun) {
              // nothing written: list what a real run would do, and why anything would be refused
              // which case each file is (review 3 F6): seal and keep, or check against its copy and delete
              for (const x of res.plan) console.log(x.action === 'seal'
                ? `would seal (keep original)  ${x.file}  ${mb(fs.statSync(x.file).size)}`
                : `would check byte for byte against ${x.copies.map((c) => path.basename(c)).join(', ')}, then delete original  ${x.file}  ${mb(fs.statSync(x.file).size)}`);
              for (const x of res.refused) console.error(`would refuse ${x.file}: ${x.reason}`);
              for (const x of [...res.locks, ...res.claims]) console.log(`would remove ${x.file}: ${x.reason}`);
              console.log(`dry run: ${res.plan.length} file(s) ready${deleteOriginal ? ' to delete' : ''}, ${res.refused.length} refused, ${res.skipped.length} skipped — nothing was written`);
              if (res.refused.length) process.exitCode = 1;
              break;
            }
            const raw = res.sealed.reduce((a, x) => a + x.bytes, 0), sealed = res.sealed.reduce((a, x) => a + x.sealedBytes, 0);
            console.log(`sealed ${res.sealed.length} file(s): ${mb(raw)} → ${mb(sealed)}${raw ? ` (${(sealed / raw * 100).toFixed(2)} %)` : ''}`);
            if (res.deletedOnly.length) console.log(`deleted ${res.deletedOnly.length} original(s) after a byte-for-byte check against their sealed copy`);
            for (const x of [...res.locks, ...res.claims]) console.log(`${x.outcome === 'removed' ? 'removed ' : 'FAILED  '} ${x.file}: ${x.reason}`);
            for (const x of res.refused) console.error(`refused  ${x.file}: ${x.reason}`);
            for (const x of res.failed) console.error(`FAILED   ${x.file}: ${x.reason} (${failureState(x)})`);
            if (!deleteOriginal && res.sealed.length) console.log('originals KEPT — both copies now exist and readers use the originals. Check with `asight raw verify '
              + target + '`, then run this again with --delete-original to delete each original after a byte-for-byte check.');
            if (res.refused.length || res.failed.length || [...res.locks, ...res.claims].some((x) => x.outcome === 'failed')) process.exitCode = 1;
          } else {
            const { sealShard } = await mod('seal.mjs');
            const res = await sealShard(path.resolve(target), { sessionsRoot: path.resolve(flag('--sessions', path.join(asightHome(), 'sessions'))) });
            console.log(`sealed ${res.records} records: ${mb(res.bytes)} → ${mb(res.sealedBytes)} in ${res.outputs.length} file(s); original deleted after verification`);
            if (res.unsafeKeys) console.log(`  ${res.unsafeKeys} line(s) carried a session key that is not a safe directory name — filed in the per-shard file`);
            for (const o of res.outputs) console.log(`  ${o.path}${o.session ? '' : '  (no session key)'}`);
          }
        } catch (e) { console.error(e.message); process.exitCode = 1; }
        break;
      }
      if (sub === 'verify') {
        if (!target) die(usage);
        const { runVerify } = await mod('verify.mjs');
        const against = flag('--against', null);
        let results;
        try { results = runVerify({ target: path.resolve(target), against: against && path.resolve(against) }); } catch (e) { console.error(`verify failed: ${e.message}`); process.exitCode = 1; break; }
        // a copy of only the first bytes of a file that grew says so ("prefix"), never a plain ok
        for (const x of results) {
          if (x.mode === 'unreadable') { console.log(`FAILED (unreadable) ${x.original} — ${x.reason}`); continue; }
          if (x.mode === 'empty') { console.log(`empty  ${x.sealed[0]} — ${x.note}`); continue; }
          console.log(`${x.ok ? (x.covers === 'prefix' ? 'ok (prefix)' : 'ok    ') : 'FAILED'} ${x.mode === 'self' ? '(by itself) ' : ''}${x.sealed.join(', ')}${x.original ? ' vs ' + x.original : ''}${x.ok ? ` · ${x.records} records` : ' — ' + x.reason}`);
          if (x.note) console.log(`       note: ${x.note}`);
        }
        if (!results.length) console.error('no sealed files found');
        if (!results.length || results.some((x) => !x.ok)) process.exitCode = 1;
        break;
      }
      if (sub === 'compare') {
        // Before deleting originals (review 3 F1): per session and control class, the readers' output
        // over the originals vs over the sealed copies alone — in-process, through the readers' own
        // functions. Exit 1 on any difference, or when nothing was compared.
        if (!target) die(usage);
        const { runCompare } = await import(r('src', 'query', 'raw-compare.mjs'));
        const t0 = Date.now();
        let res;
        try { res = await runCompare({ root: path.resolve(target), onGroup: (g) => {
          if (g.status === 'same') console.log(`same        ${g.group} · ${g.records} records, ${g.resolver.checked} ids resolved alike${g.uncovered.length ? ` · not covered (no sealed copy, would not be deleted): ${g.uncovered.map((f) => path.basename(f)).join(', ')}` : ''}`);
          else if (g.status === 'diff') console.log(`DIFF        ${g.group} · ${g.diff.at != null ? `record ${g.diff.at}: ${g.diff.what} — now ${g.diff.before}, after deletion ${g.diff.after}` : g.diff.what}`);
          else if (g.status === 'not-covered') console.log(`not covered ${g.group} · no original here has a sealed copy: ${g.uncovered.map((f) => path.basename(f)).join(', ')} (not compared, would not be deleted)`);
          if (g.notCompared) for (const f of g.notCompared) console.log(`  NOT COMPARED, yet --delete-original would delete it: ${f}`);
          for (const n of g.notes) console.log(`  note: ${n}`);
        } }); } catch (e) { console.error(`compare failed: ${e.message} — nothing compared`); process.exitCode = 1; break; }
        const n = (s) => res.groups.filter((g) => g.status === s).length;
        // --list: one line per original, for the cross-check against `seal --legacy --delete-original --dry-run`
        if (rest.includes('--list')) for (const g of res.groups) {
          if (g.status === 'same' || g.status === 'diff') for (const f of g.deletable) console.log(`compared-original ${f}`);
          for (const f of g.uncovered) console.log(`not-covered ${f}`);
          for (const f of g.notCompared || []) console.log(`not-compared ${f}`);
        }
        // counted per original, not per group: a group can mix covered and uncovered originals
        const del = res.groups.reduce((a, g) => a + g.deletable.length, 0), lost = res.groups.reduce((a, g) => a + (g.notCompared || []).length, 0);
        const unc = res.groups.reduce((a, g) => a + g.uncovered.length, 0);
        console.log(`compared ${res.compared} records in ${res.groups.filter((g) => g.kind !== 'not-compared' && (g.status === 'same' || g.status === 'diff')).length} groups (${res.groups.filter((g) => g.kind === 'session' && g.status !== 'not-covered' && g.status !== 'sealed-only').length} sessions): ${n('diff')} differ, ${unc} original(s) not covered, ${n('sealed-only')} sealed only · ${del + lost} original(s) --delete-original would delete, ${lost ? `${lost} of them NOT compared` : 'all of them compared'} · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
        if (!res.compared) console.error('nothing compared: no original here has a sealed copy — seal first (`asight raw seal --legacy <dir>`)');
        if (!res.ok) process.exitCode = 1;
        break;
      }
      if (sub === 'export') {
        if (!target) die(usage);
        const { runExport } = await mod('export.mjs');
        const out = flag('--out', undefined);
        try {
          const res = runExport({ target, sessionsRoot: path.resolve(flag('--sessions', path.join(asightHome(), 'sessions'))), out: out && path.resolve(out) });
          console.log(`exported ${res.records} records (${mb(res.bytes)}) → ${res.out}${res.outputs.length > 1 || res.out !== res.outputs[0].file ? `/ (${res.outputs.length} file(s), one per segment, 0600)` : ' (0600)'}`);
          for (const o of res.outputs) if (o.file !== res.out) console.log(`  ${o.file} · ${o.records} records`);
        } catch (e) { console.error(e.message); process.exitCode = 1; }
        break;
      }
      if (sub === 'journal') {
        const { readJournal, defaultJournalPath } = await mod('journal.mjs');
        let all;
        try { all = readJournal(); } catch (e) { console.error(`cannot read the raw journal ${defaultJournalPath()}: ${e.message}`); process.exitCode = 1; break; }
        const n = Number(flag('--tail', 50));
        console.log(`${defaultJournalPath()} · ${all.length} entries`);
        for (const e of all.slice(-n)) console.log(JSON.stringify(e));
        break;
      }
      die(usage);
      break;
    }
  }
}
