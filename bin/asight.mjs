#!/usr/bin/env node
// bin/asight.mjs — the asight CLI (D23 `npx asight`). Subcommands:
//   serve   — start the loopback read-only dashboard server (4.4)
//   etl     — populate the derived DuckDB store from an NDJSON capture (4.2)
//   on      — onboard: generate CA + install user-level trust + steer CC-CLI (D22)
//   off     — revert steer (+ optional --remove-ca)
//   verify  — assert the CA is in the user-level trust store (no machine trust)
//   doctor  — onboard self-check: deps probe + 「测试」四问 (4.1:61 / 4.5:41,77)
import path from 'node:path'
import { asightHome, captureOut, mitmOut, serveSource } from '../src/paths.mjs';
import { parseArgs } from '../src/cli-args.mjs';
import os from 'node:os';
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
    case 'shard': {
      // Per-session sharding of the capture stream (RFC 4.2 / D20: capture stays a pure tee, this
      // grouping is ETL). One week of real use produced a 7.58 GB single file that `asight serve`
      // could not open; sharded, the board reads only the session being viewed.
      const { shardOnce } = await import(r('src', 'etl', 'shard.mjs'));
      const file = positional() || flag('--file', mitmOut());
      const outDir = flag('--out', path.join(asightHome(), 'sessions'));
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
            + (res.partial ? ', trailing partial record left for next run' : ''),
          );
        }
        return res;
      };

      await run();
      if (watch) {
        console.log(`shard: watching ${file} → ${outDir} every ${every / 1000}s`);
        for (;;) {
          await new Promise((res2) => setTimeout(res2, every));
          try { await run(); } catch (e) { console.error(`shard: ${e.message}`); }
        }
      }
      break;
    }
    case 'capture': {
      // base_url tee (RFC 4.1 采集源#1): transparent reverse-proxy → append D10 envelopes to a
      // source NDJSON. OBSERVE-only: forwards client bytes verbatim, records on a side-copy.
      const { createReverseProxy } = await import(r('src', 'capture', 'reverse-proxy.mjs'));
      const port = Number(flag('--port', process.env.ASIGHT_CAPTURE_PORT || 8899));
      const target = flag('--target', 'https://api.anthropic.com');
      const upstreamProxy = flag('--upstream', process.env.HTTPS_PROXY || process.env.https_proxy || '');
      const out = flag('--out', process.env.ASIGHT_SOURCE || captureOut());
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
    case 'mitm': {
      // MITM source (RFC 4.1 采集源#2 · D20 纯 tee): CONNECT proxy that TLS-terminates ONLY the
      // target host (blind-tunnels every other host — 采集安全#1), and appends D10 envelopes to a
      // source NDJSON — same envelope builder as the reverse-proxy tee, differing only in
      // capture:'mitm'. This is the product runner for CC-Desktop, whose base_url is force-
      // overwritten (4.1:19) so a reverse-proxy can't reach it: steer Desktop→here via a Clash rule.
      const { createMitmProxy } = await import(r('src', 'capture', 'mitm.mjs'));
      const { generateCa } = await import(r('src', 'capture', 'onboard.mjs'));
      const { caDir } = await import(r('src', 'paths.mjs'));
      const port = Number(flag('--port', process.env.ASIGHT_MITM_PORT || 9899));
      const targetHost = flag('--host', 'api.anthropic.com');
      const upstreamProxy = flag('--upstream', process.env.ATRACE_UPSTREAM_PROXY || 'http://127.0.0.1:7897');
      const out = flag('--out', process.env.ASIGHT_SOURCE || mitmOut());
      // Leaf/CA MUST live in the D27 canonical dir (paths.caDir() → ~/.asight/ca), not onboard's
      // legacy DEFAULT_CA_DIR (~/.atrace/ca). generateCa defaulting to the legacy dir is what let a
      // SECOND same-CN CA exist in two places — the collision that broke every steered TLS handshake
      // on 2026-07-21. Pinning the dir here keeps
      // the leaf the mitm presents and the CA in NODE_EXTRA_CA_CERTS the SAME file.
      const ca = generateCa({ hosts: [targetHost], caDir: caDir() }); // leaf must cover the host we terminate
      const leaf = { key: fs.readFileSync(ca.leafKey), cert: fs.readFileSync(ca.leafCrt) };
      const keepRawSse = rest.includes('--raw-sse') || process.env.ASIGHT_RAW_SSE === '1';
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const sink = fs.createWriteStream(out, { flags: 'a' });
      let n = 0;
      const server = createMitmProxy({ targetHost, leaf, upstreamProxy, keepRawSse, onEnvelope: (env) => { sink.write(JSON.stringify(env) + '\n'); if (++n % 10 === 0) console.log(`  … ${n} envelopes captured`); } });
      server.on('error', (e) => { console.error('mitm error:', e.message); if (e.code === 'EADDRINUSE') process.exit(1); });
      server.listen(port, '127.0.0.1', () => console.log(`asight mitm (CONNECT · TLS-terminate ${targetHost}, blind-tunnel rest) → ${out}\n  listening http://127.0.0.1:${port}  · upstream ${upstreamProxy}\n  steer CC-Desktop here via a Clash rule (4.1) — run: asight desktop on --port ${port}`));
      break;
    }
    case 'desktop': {
      // macOS-only Clash-Verge steer for CC-Desktop capture (4.1:61 · D22). Durable global-Script
      // splice (survives Verge regen) + one hot mihomo reload so it goes live now. Never touches the
      // system proxy. --port MUST match the `asight mitm` port the traffic is steered into.
      const { getDesktopSteer } = await import(r('src', 'capture', 'desktop-steer.mjs'));
      const sub = positional() || 'status';
      const port = Number(flag('--port', process.env.ASIGHT_MITM_PORT || 9899));
      const steer = getDesktopSteer();
      if (sub === 'on') {
        const out = await steer.on({ port });
        if (out.reserved) { console.log('desktop steer:', out.reason); break; }
        console.log(`desktop steer ON → CC-Desktop's claude-code → api.anthropic.com routed to asight mitm :${out.port}`);
        console.log('  durable: global Script.js spliced (survives Verge regen) ·', out.scriptPath);
        console.log('  mihomo reload:', out.reload.status === 204 || out.reload.status === 200 ? 'OK' : `status ${out.reload.status}${out.reload.error ? ' ' + out.reload.error : ''}`);
        console.log('  live now:', out.status.live === true ? 'yes ✓' : out.status.live === false ? `NO — is \`asight mitm --port ${port}\` running?` : 'unknown');
        console.log(`  ⚠ Desktop must trust the atrace CA (run \`asight on\` / \`asight monitor on\`) or it refuses the leaf.`);
      } else if (sub === 'off') {
        const out = await steer.off();
        if (out.reserved) { console.log('desktop steer:', out.reason); break; }
        console.log('desktop steer OFF → global Script.js restored + runtime splice removed + mihomo reloaded (zero residual)');
        console.log('  mihomo reload:', out.reload.status === 204 || out.reload.status === 200 ? 'OK' : `status ${out.reload.status}`);
      } else {
        console.log(JSON.stringify(await steer.status(), null, 2));
      }
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
      // Resolve the source the SAME way the board does. `serveSource()` returns an ARRAY of roots
      // (D27), and a root is usually a DIRECTORY — `fs.statSync(array)` throws ERR_INVALID_ARG_TYPE,
      // the catch below swallowed it, and doctor then certified a capture it had read nothing from.
      // One resolver, shared: src/server.mjs::sourceFiles.
      const sources = [].concat(flag('--source', process.env.ASIGHT_SOURCE || serveSource())).filter(Boolean);
      const LIMIT = 5000;
      let srcMeta = { exists: false, bytes: 0 }, records = [];
      const readErrors = [];
      let files = [];
      for (const root of sources) {
        try {
          const part = (await import(r('src', 'server.mjs'))).sourceFiles(root);
          files.push(...part.files);
        } catch (e) { readErrors.push(`${root}: ${e.message}`); }
      }
      if (files.length) {
        let bytes = 0;
        for (const f of files) { try { bytes += fs.statSync(f).size; } catch {} }
        srcMeta = { exists: true, bytes, mtimeMs: Date.now() };
        for (const f of files) {
          if (records.length >= LIMIT) break;
          try { for (const rec of await readRecords(f, { limit: LIMIT - records.length })) records.push(rec); }
          catch (e) { readErrors.push(`${f}: ${e.message}`); }
        }
      }
      // A read failure MUST be visible: a silently-swallowed error is what let ③ pass vacuously.
      for (const e of readErrors) console.error('read error:', e);
      const source = sources.join(', ') || '(none)';
      const deps = st.checkDeps({ has });
      const res = st.runSelfTest({ records, srcMeta, deps, files, verify: () => ob.verifyUserTrustOnly() });
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
      console.log(`  ${mark(res.q4b.ok)} ④b 采集文件仅属主可读 — ${res.q4b.note}`);
      if (res.hardFail) { console.error('\n✗ credential leak detected — the redact firewall MUST be fixed before capturing further.'); process.exit(1); }
      console.log('\n✓ 采集文件仅属主可读;凭据逐字存储 = 设计如此。(①②③④ 供你核对 — 见上方说明)');
      break;
    }
    default:
      console.log(`asight — transparent, byte-faithful tracer of what an agent app sends the LLM

usage:
  asight serve [--port 9800] [--db <path>] [--source <ndjson|dir>]
  asight etl <ndjson> [--db <path>] [--rebuild]
  asight capture [--port 8899] [--target https://api.anthropic.com] [--out <ndjson>] [--upstream <proxy>] [--raw-sse]
  asight mitm    [--port 9899] [--host api.anthropic.com] [--out <ndjson>] [--upstream <proxy>]   CC-Desktop MITM source (D10 tee)
  asight desktop {on|off|status} [--port 9899]  macOS-only: steer CC-Desktop's claude-code→anthropic into asight mitm (durable, reversible)
  asight on   [--proxy http://127.0.0.1:8899]   generate CA + install (user-level) + steer CC-CLI
  asight off  [--remove-ca]
  asight uninstall                              one-step revert: remove CA + clear steer
  asight verify
  asight doctor [--source <ndjson>]             self-check: deps probe + 「测试」四问 (是否真在抓/抓得对/凭据没漏/没弱化全机 TLS)
  asight --version`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
