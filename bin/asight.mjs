#!/usr/bin/env node
// bin/asight.mjs — the asight CLI (D23 `npx asight`). Subcommands:
//   serve   — start the loopback read-only dashboard server (4.4)
//   etl     — populate the derived DuckDB store from an NDJSON capture (4.2)
//   on      — onboard: generate CA + install user-level trust + steer CC-CLI (D22)
//   off     — revert steer (+ optional --remove-ca)
//   verify  — assert the CA is in the user-level trust store (no machine trust)
//   doctor  — onboard self-check: deps probe + 「测试」四问 (4.1:61 / 4.5:41,77)
//   raw     — D35 sealed raw logs: seal (closed shards, or --legacy pre-D35 files) · verify · compare · export · journal
import path from 'node:path'
import { asightHome, captureOut, mitmOut, serveSource } from '../src/paths.mjs';
import { parseArgs } from '../src/cli-args.mjs';
import { runLegacyCommand } from '../src/cli/legacy-commands.mjs';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, ...rest] = process.argv.slice(2);
const die = (m) => { console.error(m); process.exit(1); };
// Parsing lives in src/cli-args.mjs so it can be tested: `positional()` used to return the first
// non-flag-NAME argument, i.e. the VALUE of any valued flag (`--interval 10` → "10" as the file).
const args = parseArgs(rest);
const flag = args.flag;
const positional = args.positional;
const r = (...p) => path.join(ROOT, ...p);

async function main() {
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    console.log(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
    return;
  }
  if (await runLegacyCommand(cmd, rest)) return; // the commands whose bodies moved to src/cli/legacy-commands.mjs, unchanged
  switch (cmd) {
    case 'collector': { // per-user transparent collector (RFC 4.6, D36): install / start / on / off / status / uninstall
      const { runCollector } = await import(r('src', 'collector', 'cli.mjs'));
      process.exitCode = await runCollector(rest);
      break;
    }
    case 'setup-helper': { // machine-wide, once, with sudo: the capability helper (RFC 4.6 §特权助手, D36)
      const { runSetupHelper } = await import(r('src', 'collector', 'cli.mjs'));
      process.exitCode = await runSetupHelper(rest);
      break;
    }
    case 'uninstall': {
      // one-step revert (4.5 §C): drop CA from the user trust store + clear the CC-CLI steer + tear
      // down the Desktop Clash steer AND the two capture agents (durable mitm + NODE_EXTRA_CA_CERTS
      // primer). Before this landed, uninstall left the agents running — the orphan problem the
      // 2026-07-21 incident exposed. Everything asight installs, asight removes.
      const ob = await import(r('src', 'capture', 'onboard.mjs'));
      const { removeCaptureAgents } = await import(r('src', 'capture', 'capture-agents.mjs'));
      ob.atraceOff({ removeCa: true });
      // D38 L-11: a steer that could not be reverted is printed and recorded, never "n/a" (steer-watch.mjs)
      const { getDesktopSteer } = await import(r('src', 'capture', 'desktop-steer.mjs'));
      const { uninstallSteer } = await import(r('src', 'capture', 'steer-watch.mjs'));
      const steerLine = await uninstallSteer({ getSteer: getDesktopSteer });
      const agents = removeCaptureAgents();
      console.log('asight uninstalled:');
      console.log('  · CA removed from the user-level trust store + CC-CLI settings.json steer cleared');
      console.log('  · Desktop Clash steer:', steerLine);
      console.log('  · capture agents:', agents.reserved ? 'n/a' : 'removed (com.asight.mitm + com.asight.env)');
      console.log('  · data/db left intact. NOTE: NODE_EXTRA_CA_CERTS in the live login session persists until logout (run: launchctl unsetenv NODE_EXTRA_CA_CERTS).');
      break;
    }
    case 'on': {
      const ob = await import(r('src', 'capture', 'onboard.mjs'));
      const out = ob.atraceOn({ proxyUrl: flag('--proxy', 'http://127.0.0.1:8899') });
      console.log('CA:', out.ca.caCrt, out.ca.existed ? '(already existed)' : '(generated)');
      console.log('trust install:', out.install.ok ? 'OK — user-level, NO machine-wide trust' : 'FAILED', JSON.stringify(out.install.result));
      console.log('CC-CLI steer: HTTPS_PROXY →', out.steer.HTTPS_PROXY, '(run a CC-CLI session to capture in byte-exact D10)');
      let v; try { v = ob.verifyUserTrustOnly() ? 'CA present in user trust store ✓' : 'not found ✗'; } catch (e) { v = `? ${e.message}`; } // not checkable is said
      console.log('verify:', v);
      break;
    }
    case 'off': {
      const ob = await import(r('src', 'capture', 'onboard.mjs'));
      ob.atraceOff({ removeCa: rest.includes('--remove-ca') });
      console.log('steer reverted;', rest.includes('--remove-ca') ? 'CA removed from trust store' : 'CA kept (use --remove-ca to remove)');
      break;
    }
    case 'verify': {
      const ob = await import(r('src', 'capture', 'onboard.mjs'));
      let v; try { v = ob.verifyUserTrustOnly(); } catch (e) { console.log(`CA trust ? ${e.message}`); process.exitCode = 1; break; } // never "not installed" for "could not check"
      console.log(v
        ? 'CA present in user-level trust store, no machine-wide trust ✓'
        : 'CA not installed ✗ (run: asight on)');
      break;
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
    case 'doctor': case 'test': { // `test` is doctor's old alias (1.6 §2 drops it with the command table, Task 11)
      const { runDoctor } = await import(r('src', 'cli', 'doctor.mjs'));
      const { makeIo } = await import(r('src', 'off', 'io.mjs'));
      process.exitCode = await runDoctor(rest, { io: makeIo({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }) });
      break;
    }
    default:
      console.log(`asight — transparent, byte-faithful tracer of what an agent app sends the LLM

usage:
  asight serve [--port 9800] [--db <path>] [--source <ndjson|dir>]
  asight etl <ndjson|sealed|dir> [--db <path>] [--rebuild]
  asight capture [--port 8899] [--target https://api.anthropic.com] [--out <ndjson>] [--upstream <proxy>] [--raw-sse]
  asight mitm    [--port 9899] [--host api.anthropic.com] [--out <ndjson>] [--upstream <proxy>]   CC-Desktop MITM source (D10 tee)
  asight desktop {on|off|status} [--port 9899]  macOS-only: steer CC-Desktop's claude-code→anthropic into asight mitm (durable, reversible)
  asight on   [--proxy http://127.0.0.1:8899]   generate CA + install (user-level) + steer CC-CLI
  asight off  [--remove-ca]
  asight uninstall                              one-step revert: remove CA + clear steer
  asight verify
  asight doctor [--source <ndjson>]             self-check: deps probe + 「测试」四问 (是否真在抓/抓得对/凭据没漏/没弱化全机 TLS)
  asight raw seal <closed-shard> [--sessions <dir>]                     D35: seal a CLOSED shard (needs <shard>.closed), per session
  asight raw seal --legacy <file|dir> [--dry-run] [--delete-original] [--quiet <s>]  seal pre-D35 files/trees nothing writes; keeps originals by default
  asight raw verify <sealed|dir> [--against <original>]                 decode sealed copies, compare byte for byte with the original
  asight raw compare <dir> [--list]                                     readers' output over the originals vs the sealed copies alone, per session (before deleting)
  asight raw export <session-id|file.sealed> [--out <dir|file>]         sealed → plain NDJSON, one file per segment (0600, default ~/.asight/export/<session>/)
  asight raw journal [--tail <n>]                                       the durable record of refusals, failures, deletions
  asight --version`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
