#!/usr/bin/env node
// bin/asight.mjs — the asight CLI: `asight help` lists the commands. The commands, their aliases, the help and the exit codes are src/cli/commands.mjs and src/cli/main.mjs (RFC 1.6 §2);
// this file only runs them and leaves with the code they return. An error nothing caught is printed whole and exits 1.
import module from 'node:module';
import { runCli } from '../src/cli/main.mjs';

// V8's compiled code for this CLI's modules, kept in node's own cache directory (1.6 §3.1, D62): every command is a cold process, and
// compiling the same hundred modules again is the floor's biggest part where the file system is slow (Windows). It changes nothing a command
// answers; a node without it, or a cache it may not write, is no cache and no error.
try { module.enableCompileCache?.(); } catch { /* no cache, the same answers */ }

runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e); process.exit(1); });
