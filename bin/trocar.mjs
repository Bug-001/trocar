#!/usr/bin/env node
// bin/trocar.mjs — the trocar CLI: `trocar help` lists the commands. The commands, their aliases, the help and the exit codes are src/cli/commands.mjs and src/cli/main.mjs (RFC 1.6 §2);
// this file only runs them and leaves with the code they return. An error nothing caught is printed whole and exits 1.
// A Node older than package.json's `engines` floor cannot even load src/ (an export it lacks is a SyntaxError at link time), so the floor
// is checked first and src/ is imported only after it (RFC 1.6 §3.8).
import fs from 'node:fs';

const floor = /\d+\.\d+/.exec(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).engines.node)[0];
const [needMajor, needMinor] = floor.split('.').map(Number);
const [major, minor] = process.versions.node.split('.').map(Number);
if (!(major > needMajor || (major === needMajor && minor >= needMinor))) {
  console.error(`trocar needs Node ${floor} or newer; this is Node ${process.versions.node}.`);
  process.exit(2);
}
const { runCli } = await import('../src/cli/main.mjs');

// A reader that left (`trocar rules | head -1`) breaks no command: what it was doing finishes unprinted and leaves with its own code, so a switch is never cut in half by a pager.
// A write to the closed pipe fails on the stream, and with no listener there that is an uncaught exception and a stack on the screen.
for (const stream of [process.stdout, process.stderr]) stream.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });

runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e); process.exit(1); });
