#!/usr/bin/env node
// bin/trocar.mjs — the trocar CLI: `trocar help` lists the commands. The commands, their aliases, the help and the exit codes are src/cli/commands.mjs and src/cli/main.mjs (RFC 1.6 §2);
// this file only runs them and leaves with the code they return. An error nothing caught is printed whole and exits 1.
// A Node older than package.json's `engines` floor cannot even load src/ (an export it lacks is a SyntaxError at link time), so the floor
// is checked first and src/ is imported only after it (RFC 1.6 §3.8).
import fs from 'node:fs';

const floor = Number(/\d+/.exec(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).engines.node)[0]);
if (!(Number(process.versions.node.split('.')[0]) >= floor)) {
  console.error(`trocar needs Node ${floor} or newer; this is Node ${process.versions.node}.`);
  process.exit(2);
}
const { runCli } = await import('../src/cli/main.mjs');

runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e); process.exit(1); });
