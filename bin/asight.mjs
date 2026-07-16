#!/usr/bin/env node
// bin/asight.mjs — the asight CLI (D23 `npx asight`). Subcommands:
//   serve   — start the loopback read-only dashboard server (4.4)
//   etl     — populate the derived DuckDB store from an NDJSON capture (4.2)
//   on      — onboard: generate CA + install user-level trust + steer CC-CLI (D22)
//   off     — revert steer (+ optional --remove-ca)
//   verify  — assert the CA is in the user-level trust store (no machine trust)
//   doctor  — onboard self-check: deps probe + 「测试」四问 (4.1:61 / 4.5:41,77)
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, ...rest] = process.argv.slice(2);
const die = (m) => { console.error(m); process.exit(1); };
const flag = (name, def) => { const i = rest.indexOf(name); return i >= 0 ? (rest[i + 1] ?? true) : def; };
const positional = () => rest.find((a) => !a.startsWith('--'));
const r = (...p) => path.join(ROOT, ...p);

async function main() {
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    console.log(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
    return;
  }
  switch (cmd) {
    case 'serve': {
      const { createServer } = await import(r('src', 'server.mjs'));
      const port = Number(flag('--port', process.env.ASIGHT_PORT || 9800));
      const control = rest.includes('--control') || process.env.ASIGHT_CONTROL === '1'; // D26 opt-in
      const { server } = await createServer({
        dbPath: flag('--db', process.env.ASIGHT_DB || undefined),
        sourcePath: flag('--source', process.env.ASIGHT_SOURCE || null),
        control,
        captureTarget: flag('--capture-target', undefined),
        proxyUrl: flag('--proxy', undefined),
      });
      server.on('error', (e) => { console.error('server error:', e.message); if (e.code === 'EADDRINUSE') process.exit(1); });
      server.listen(port, '127.0.0.1', () => console.log(`asight serving http://127.0.0.1:${port}${control ? '  (control plane ON — /control/* enabled)' : ''}`));
      break;
    }
    // D26: transparent-monitoring on/off/status — the CLI face of the control plane (web toggle maps here).
    case 'monitor': {
      const ctl = await import(r('src', 'capture', 'control.mjs'));
      const sub = positional() || 'status';
      const opts = { proxyUrl: flag('--proxy', undefined), captureTarget: flag('--capture-target', undefined) };
      if (sub === 'on') { const out = ctl.monitoringOn({ ...opts, withAutostart: !rest.includes('--no-autostart') }); console.log('monitoring ON:', JSON.stringify(out.status, null, 2)); console.log('CA:', out.onboard.install.ok ? 'user-level trust OK' : 'FAILED', '· autostart:', out.autostart ? (out.autostart.ok ? out.autostart.plistPath : out.autostart.reason) : 'skipped'); }
      else if (sub === 'off') { const out = ctl.monitoringOff({ ...opts, removeCa: rest.includes('--remove-ca') }); console.log('monitoring OFF:', JSON.stringify(out.status, null, 2)); }
      else { console.log(JSON.stringify(ctl.monitoringStatus(opts), null, 2)); }
      break;
    }
    case 'etl': {
      const { etlFile } = await import(r('src', 'etl', 'cli.mjs'));
      const file = positional();
      if (!file) die('usage: asight etl <ndjson> [--db <path>] [--rebuild]');
      const out = await etlFile(file, { dbPath: flag('--db', undefined), rebuild: rest.includes('--rebuild') });
      console.log(`ETL: ${out.records} records from ${out.file} → ${out.dbPath}`, JSON.stringify(out.stats));
      break;
    }
    case 'capture': {
      // base_url tee (RFC 4.1 采集源#1): transparent reverse-proxy → append D10 envelopes to a
      // source NDJSON. OBSERVE-only: forwards client bytes verbatim, records on a side-copy.
      const { createReverseProxy } = await import(r('src', 'capture', 'reverse-proxy.mjs'));
      const port = Number(flag('--port', process.env.ASIGHT_CAPTURE_PORT || 8899));
      const target = flag('--target', 'https://api.anthropic.com');
      const upstreamProxy = flag('--upstream', process.env.HTTPS_PROXY || process.env.https_proxy || '');
      const out = flag('--out', process.env.ASIGHT_SOURCE || path.join(os.homedir(), '.atrace', 'capture.ndjson'));
      // --raw-sse: retain the verbatim streamed events in resp.raw_sse. REQUIRED for providers whose
      // SSE the reconstructor doesn't yet parse (it's Anthropic-shaped) — e.g. OpenAI Responses (Codex):
      // without it the reconstructed resp is empty and the events are LOST (invariant 2 · source truth).
      const keepRawSse = rest.includes('--raw-sse') || process.env.ASIGHT_RAW_SSE === '1';
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const sink = fs.createWriteStream(out, { flags: 'a' });
      let n = 0;
      const server = createReverseProxy({ target, upstreamProxy, keepRawSse, onEnvelope: (env) => { sink.write(JSON.stringify(env) + '\n'); if (++n % 10 === 0) console.log(`  … ${n} envelopes captured`); } });
      server.on('error', (e) => { console.error('capture error:', e.message); if (e.code === 'EADDRINUSE') process.exit(1); });
      server.listen(port, '127.0.0.1', () => console.log(`asight capture (reverse-proxy tee) → ${target}\n  listening http://127.0.0.1:${port}  → ${out}\n  point the harness at it: HTTPS_PROXY / base_url → http://127.0.0.1:${port} (or run: asight on)`));
      break;
    }
    case 'uninstall': {
      // one-step revert (4.5 §C): drop CA from the user trust store + clear the CC-CLI steer.
      const ob = await import(r('src', 'capture', 'onboard.mjs'));
      ob.atraceOff({ removeCa: true });
      console.log('asight uninstalled: CA removed from the user-level trust store + CC-CLI steer cleared. (data/db left intact)');
      break;
    }
    case 'on': {
      const ob = await import(r('src', 'capture', 'onboard.mjs'));
      const out = ob.atraceOn({ proxyUrl: flag('--proxy', 'http://127.0.0.1:8899') });
      console.log('CA:', out.ca.caCrt, out.ca.existed ? '(already existed)' : '(generated)');
      console.log('trust install:', out.install.ok ? 'OK — user-level, NO machine-wide trust' : 'FAILED', JSON.stringify(out.install.result));
      console.log('CC-CLI steer: HTTPS_PROXY →', out.steer.HTTPS_PROXY, '(run a CC-CLI session to capture in byte-exact D10)');
      console.log('verify:', ob.verifyUserTrustOnly() ? 'CA present in user trust store ✓' : 'not found ✗');
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
      console.log(ob.verifyUserTrustOnly()
        ? 'CA present in user-level trust store, no machine-wide trust ✓'
        : 'CA not installed ✗ (run: asight on)');
      break;
    }
    case 'doctor': case 'test': {
      // onboard 自检:依赖探测 + 「测试」四问(4.1:61 / 4.5:41,77). Human reviews the four answers;
      // exit non-zero ONLY on a credential leak (the one non-negotiable security red line).
      const { spawnSync } = await import('node:child_process');
      const { readRecords } = await import(r('src', 'etl', 'ingest.mjs'));
      const st = await import(r('src', 'capture', 'selftest.mjs'));
      const ob = await import(r('src', 'capture', 'onboard.mjs'));
      const has = (bin) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' }).status === 0;
      const source = flag('--source', process.env.ASIGHT_SOURCE || path.join(os.homedir(), '.atrace', 'capture.ndjson'));
      const LIMIT = 5000;
      let srcMeta = null, records = [];
      try { const s = fs.statSync(source); srcMeta = { exists: true, bytes: s.size, mtimeMs: s.mtimeMs }; } catch { srcMeta = { exists: false }; }
      if (srcMeta.exists) { try { records = await readRecords(source, { limit: LIMIT }); } catch (e) { console.error('read error:', e.message); } }
      const deps = st.checkDeps({ has });
      const res = st.runSelfTest({ records, srcMeta, deps, verify: () => ob.verifyUserTrustOnly() });
      const mark = (b, warn) => (b ? '✓' : warn ? '⚠' : '✗');
      console.log('asight doctor — onboard 自检(依赖探测 + 「测试」四问)\n');
      console.log('deps:');
      for (const d of deps) console.log(`  ${mark(d.present, true)} ${d.bin} — ${d.present ? 'found' : 'MISSING · ' + d.hint} (${d.why})`);
      console.log(`\n源:${source}${srcMeta.exists ? ` · ${(srcMeta.bytes / 1024).toFixed(0)} KB${records.length >= LIMIT ? ` · sampled first ${LIMIT} records` : ''}` : ' · (not found)'}\n`);
      console.log('四问(人核对):');
      console.log(`  ${mark(res.q1.ok, true)} ① 是否真在抓   — ${res.q1.note}`);
      console.log(`  ${mark(res.q2.ok, res.q2.llm === 0)} ② 抓得对       — ${res.q2.note}`);
      console.log(`  ${mark(res.q3.ok)} ③ 凭据没漏     — ${res.q3.note}`);
      console.log(`  ${mark(res.q4.ok, true)} ④ 没弱化全机 TLS — ${res.q4.note}`);
      if (res.hardFail) { console.error('\n✗ credential leak detected — the redact firewall MUST be fixed before capturing further.'); process.exit(1); }
      console.log('\n✓ no credential leak. (①②④ are for your review — see notes above.)');
      break;
    }
    default:
      console.log(`asight — transparent, byte-faithful tracer of what an agent app sends the LLM

usage:
  asight serve [--port 9800] [--db <path>] [--source <ndjson|dir>]
  asight etl <ndjson> [--db <path>] [--rebuild]
  asight capture [--port 8899] [--target https://api.anthropic.com] [--out <ndjson>] [--upstream <proxy>] [--raw-sse]
  asight on   [--proxy http://127.0.0.1:8899]   generate CA + install (user-level) + steer CC-CLI
  asight off  [--remove-ca]
  asight uninstall                              one-step revert: remove CA + clear steer
  asight verify
  asight doctor [--source <ndjson>]             self-check: deps probe + 「测试」四问 (是否真在抓/抓得对/凭据没漏/没弱化全机 TLS)
  asight --version`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
