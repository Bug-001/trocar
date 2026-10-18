// src/classes/table.mjs — the traffic-class table (D60).
//
// shortcut: T6's stand-in with only what the READ side needs (readTable + the builtin list);
// T4 owns this file — the endpoint-derived builtin rules, classify/keepOf and the copy-on-write
// editor — and replaces this when it merges.
import nodeFs from 'node:fs';
import path from 'node:path';
import { TRAFFIC_CLASSES } from '../capture/envelope.mjs';
import { asightHome } from '../paths.mjs';

export const BUILTIN = Object.freeze(TRAFFIC_CLASSES.map((c) => Object.freeze({ class: c, keep: 'full', builtin: true, rules: [] })));

export const classesFile = (home = asightHome()) => path.join(home, 'classes.json');

/** → `{ classes, file, lastChange, problems }`. No file (or an unreadable one) = the builtin table, and the reason is in `problems`. */
export function readTable({ home = asightHome(), fs = nodeFs } = {}) {
  const file = classesFile(home), problems = [];
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (!(e && e.code === 'ENOENT')) problems.push({ where: file, reason: String((e && e.message) || e) });
    return { classes: BUILTIN, file: null, lastChange: null, problems };
  }
  try {
    const doc = JSON.parse(text);
    if (!Array.isArray(doc.classes)) throw new Error('classes.json names no class list');
    return { classes: doc.classes, file, lastChange: doc.last_change ?? null, problems };
  } catch (e) {
    problems.push({ where: file, reason: `${String((e && e.message) || e)} — the builtin table is used` });
    return { classes: BUILTIN, file, lastChange: null, problems };
  }
}
