#!/usr/bin/env node
// bin/asight.mjs — the asight CLI: `asight help` lists the commands. The commands, their aliases, the help and the exit codes are src/cli/commands.mjs and src/cli/main.mjs (RFC 1.6 §2);
// this file only runs them and leaves with the code they return. An error nothing caught is printed whole and exits 1.
import { runCli } from '../src/cli/main.mjs';

runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e); process.exit(1); });
