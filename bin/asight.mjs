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
import { runLegacyCommand, LEGACY_COMMANDS } from '../src/cli/legacy-commands.mjs';
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
  if (LEGACY_COMMANDS.has(cmd)) { process.exitCode = await runLegacyCommand(cmd, rest); return; } // the commands whose bodies moved to src/cli/legacy-commands.mjs, unchanged
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
