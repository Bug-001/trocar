// legacy-commands.mjs — the commands that keep the bodies they had when bin/asight.mjs held them all (RFC 1.6 §2, D39): `serve`, `etl`, `raw` and the transitional `capture`, `mitm`,
// `desktop`, `monitor`, `shard`. The bodies are moved here unchanged; the table of src/cli/commands.mjs calls `runLegacyCommand(name, rest)`. They print with console.* and
// set process.exitCode, as they always did.
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { asightHome, captureOut, mitmOut, serveSource } from '../paths.mjs'
import { parseArgs } from '../cli-args.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const die = (m) => { console.error(m); process.exit(1) }
const r = (...p) => path.join(ROOT, ...p)

export const LEGACY_COMMANDS = new Set(['serve', 'monitor', 'etl', 'shard', 'capture', 'mitm', 'desktop'])

/** Runs one of LEGACY_COMMANDS with the arguments after its name; false when `cmd` is not one of them. */
export async function runLegacyCommand(cmd, rest) {
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
    // D26: transparent-monitoring on/off/status — the CLI face of the control plane (web toggle maps here).
    case 'monitor': {
      const ctl = await import(r('src', 'capture', 'control.mjs'));
      const sub = positional() || 'status';
      const opts = { proxyUrl: flag('--proxy', undefined), captureTarget: flag('--capture-target', undefined) };
      if (sub === 'on') {
        const { appendLegacyEvent } = await import(r('src', 'capture', 'events.mjs'));
        const out = ctl.monitoringOn({ ...opts, withAutostart: !rest.includes('--no-autostart'), onEvent: (e) => appendLegacyEvent(e) });
        console.log('monitoring ON:', JSON.stringify(out.status, null, 2));
        console.log('CA:', out.onboard.install.ok ? 'user-level trust OK' : 'FAILED', '· autostart:', out.autostart ? (out.autostart.ok ? out.autostart.plistPath : `⚠ ${out.autostart.loadError || out.autostart.reason}`) : 'skipped');
        if (!out.ok) process.exitCode = 1;
      }
      else if (sub === 'off') { const out = ctl.monitoringOff({ ...opts, removeCa: rest.includes('--remove-ca') }); console.log('monitoring OFF:', JSON.stringify(out.status, null, 2)); }
      else { console.log(JSON.stringify(ctl.monitoringStatus(opts), null, 2)); }
      break;
    }
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
      // D38 (RFC 4.1 过渡期): a write that fails never crashes the proxy; failures and start / stop are lines in
      // ~/.asight/logs/mitm-events.ndjson (src/capture/legacy-run.mjs, events.mjs)
      const { createCaptureSink, legacyLifecycle } = await import(r('src', 'capture', 'legacy-run.mjs'));
      const { appendLegacyEvent, failureOf } = await import(r('src', 'capture', 'events.mjs'));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const sink = createCaptureSink(out);
      const life = legacyLifecycle({ source: 'proxy', port, out });
      let n = 0;
      const server = createReverseProxy({ target, upstreamProxy, keepRawSse, onEvent: (e) => appendLegacyEvent(e), onEnvelope: (env) => { if (sink.write(env) && ++n % 10 === 0) console.log(`  … ${n} envelopes captured`); } });
      server.on('error', (e) => { appendLegacyEvent(failureOf('proxy', e, 'start-failed')); if (e.code === 'EADDRINUSE') process.exit(1); });
      server.listen(port, '127.0.0.1', () => { life.started(server.address().port); console.log(`asight capture (reverse-proxy tee) → ${target}\n  listening http://127.0.0.1:${port}  → ${out}\n  point the harness at it: HTTPS_PROXY / base_url → http://127.0.0.1:${port} (or run: asight on)`); });
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
      // D38 (RFC 4.1 过渡期): refused leaves, cut upstreams, failed writes, start / stop → mitm-events.ndjson
      const { createCaptureSink, legacyLifecycle } = await import(r('src', 'capture', 'legacy-run.mjs'));
      const { appendLegacyEvent, failureOf } = await import(r('src', 'capture', 'events.mjs'));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const sink = createCaptureSink(out);
      let n = 0;
      const server = createMitmProxy({ targetHost, leaf, upstreamProxy, keepRawSse, onEvent: (e) => appendLegacyEvent(e), log: (m) => console.error(m), onEnvelope: (env) => { if (sink.write(env) && ++n % 10 === 0) console.log(`  … ${n} envelopes captured`); } });
      // given its server, a SIGTERM (what `launchctl unload` makes launchd send) drains: no new connections, the open ones get 10 s to end, then `mitm-stop` says how many were cut (RFC 1.6 §4)
      const life = legacyLifecycle({ source: 'mitm', port, out, server });
      server.on('error', (e) => { appendLegacyEvent(failureOf('mitm', e, 'start-failed')); if (e.code === 'EADDRINUSE') process.exit(1); });
      // D38 L-12: the Desktop steer this MITM serves is checked at start and every 60 s; losing it is a line
      if (process.platform === 'darwin') {
        const { getDesktopSteer } = await import(r('src', 'capture', 'desktop-steer.mjs'));
        const { createSteerWatch, legacyOffPending } = await import(r('src', 'capture', 'steer-watch.mjs'));
        const steer = getDesktopSteer();
        // while `asight off` is between stripping the block and unloading this MITM (~/.asight/legacy-off.pending names its live pid), the block going away is its doing, not a failure
        const check = createSteerWatch({ status: () => steer.status(), pending: () => legacyOffPending() });
        check(); setInterval(check, 60000).unref();
      }
      server.listen(port, '127.0.0.1', () => { life.started(server.address().port); console.log(`asight mitm (CONNECT · TLS-terminate ${targetHost}, blind-tunnel rest) → ${out}\n  listening http://127.0.0.1:${port}  · upstream ${upstreamProxy}\n  steer CC-Desktop here via a Clash rule (4.1) — run: asight desktop on --port ${port}`); });
      break;
    }
    case 'desktop': {
      // macOS-only Clash-Verge steer for CC-Desktop capture (4.1:61 · D22). Durable global-Script
      // splice (survives Verge regen) + one hot mihomo reload so it goes live now. Never touches the
      // system proxy. --port MUST match the `asight mitm` port the traffic is steered into.
      const { getDesktopSteer } = await import(r('src', 'capture', 'desktop-steer.mjs'));
      const { installCaptureAgents, removeCaptureAgents, statusCaptureAgents, MITM_LABEL, ENV_LABEL } = await import(r('src', 'capture', 'capture-agents.mjs'));
      const { caDir } = await import(r('src', 'paths.mjs'));
      const sub = positional() || 'status';
      const port = Number(flag('--port', process.env.ASIGHT_MITM_PORT || 9898));
      const steer = getDesktopSteer();
      if (sub === 'on') {
        const out = await steer.on({ port });
        if (out.reserved) { console.log('desktop steer:', out.reason); break; }
        // Desktop capture = Clash steer (routing) + the durable mitm + the NODE_EXTRA_CA_CERTS primer
        // (trust). All three are now product-managed together so `desktop off` / `uninstall` clean up
        // — the 2026-07-21 incident happened because the last two were hand-made and unmanaged.
        // Ensure the CA exists first: the env primer points NODE_EXTRA_CA_CERTS at atrace-ca.crt, and
        // on a fresh machine nothing else has created it yet (F5, 2026-07-21 review).
        const { generateCa } = await import(r('src', 'capture', 'onboard.mjs'));
        generateCa({ hosts: [flag('--host', 'api.anthropic.com')], caDir: caDir() });
        const agents = installCaptureAgents({
          caPath: path.join(caDir(), 'atrace-ca.crt'), port, out: mitmOut(),
          asightBin: r('bin', 'asight.mjs'), // the file the LaunchAgent runs: bin/asight.mjs, not this one
        });
        console.log(out.ok
          ? `desktop steer ON → CC-Desktop's claude-code → api.anthropic.com routed to asight mitm :${out.port}`
          : `desktop steer INSTALLED (durable) but NOT live yet → claude-code → api.anthropic.com will route to asight mitm :${out.port} after Verge regenerates`);
        console.log('  durable: global Script.js spliced (survives Verge regen) ·', out.scriptPath);
        console.log('  mihomo reload:', out.reload.status === 204 || out.reload.status === 200 ? `OK (${out.status.mihomoSock || 'socket'})` : `status ${out.reload.status}${out.reload.error ? ' ' + out.reload.error : ''}`);
        if (agents.reserved) console.log('  capture agents:', agents.reason);
        else console.log(`  capture agents: mitm(${MITM_LABEL}) + CA-trust primer(${ENV_LABEL}) installed → ${agents.mitm.plistPath}, ${agents.env.plistPath}`);
        // D38 L-7: an agent that did not load is said and recorded — the MITM is not running, whatever the plist says
        if (!agents.reserved && !agents.ok) {
          const { appendLegacyEvent } = await import(r('src', 'capture', 'events.mjs'));
          for (const [label, a] of [[MITM_LABEL, agents.mitm], [ENV_LABEL, agents.env]]) {
            if (!a.loadError) continue;
            console.log(`  ⚠ ${label} did NOT load: ${a.loadError}`);
            appendLegacyEvent({ event: 'failure', where: 'autostart', code: 'autostart-load-failed', file: a.plistPath, reason: `${label}: ${a.loadError}` });
          }
          process.exitCode = 1;
        }
        // the immediate step failed → say why and how to apply it by hand (D29), never just a status code
        if (!out.ok) console.log('  ⚠ route NOT live now:', out.reason);
        else console.log('  route live in mihomo:', out.status.live === true ? 'yes ✓' : out.status.live === false ? 'NO' : 'unknown');
        console.log('  ⚠ FULLY quit + reopen Claude Desktop so it inherits NODE_EXTRA_CA_CERTS (a new conversation is not enough).');
      } else if (sub === 'off') {
        const out = await steer.off();
        const agents = removeCaptureAgents();
        if (out.reserved) { console.log('desktop steer:', out.reason); }
        else if (!out.ok) {
          console.log('⚠ desktop steer NOT fully off:', out.reason);
        } else {
          console.log('desktop steer OFF → atrace block stripped from global Script.js (the rest kept as-is) + runtime splice removed + mihomo reloaded');
          console.log('  mihomo reload:', out.reload.status === 204 || out.reload.status === 200 ? 'OK' : `status ${out.reload.status}`);
        }
        if (!agents.reserved) console.log('  capture agents removed:', MITM_LABEL, '+', ENV_LABEL);
      } else {
        console.log(JSON.stringify({ steer: await steer.status(), agents: statusCaptureAgents() }, null, 2));
      }
      break;
    }
    default:
      return false
  }
  return true
}
