// src/query/stored.mjs — the stored answer (RFC 3.5 §谁执行它「存下的答案」): the last answer of a name that declares `stored(params)`
// in QUERIES, kept by the query worker as the gzip of the compact JSON of `{...doc, stored: {at}}`. The one place its file is named:
// the worker writes through writeStored, the daemon reads storedFile (0.1 §2).
import nodeFs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { putFile } from './ctx-files.mjs';

/** How many stored answers the directory keeps: every `after` value leaves one, this bounds them. */
export const STORED_MAX = 64;

const dirOf = (home) => path.join(home, 'index', 'stored');
const canonical = (params) => Object.keys(params).sort().map((k) => [k, Array.isArray(params[k]) ? params[k].map(String) : String(params[k])]);

/** storedFile(home, name, params) → `<home>/index/stored/<name>.<first 16 hex of sha1 of the canonical params>.json.gz`. */
export const storedFile = (home, name, params = {}) =>
  path.join(dirOf(home), `${name}.${createHash('sha1').update(JSON.stringify(canonical(params))).digest('hex').slice(0, 16)}.json.gz`);

/** writeStored(home, name, params, doc, fs): temp file + same-directory rename, then only the STORED_MAX newest files (by mtime) stay. */
export function writeStored(home, name, params, doc, fs = nodeFs) {
  putFile(fs, storedFile(home, name, params), gzipSync(Buffer.from(JSON.stringify(doc), 'utf8')));
  const dir = dirOf(home);
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.json.gz'))
    .map((f) => { try { return { f, t: fs.statSync(path.join(dir, f)).mtimeMs }; } catch { return null; } }).filter(Boolean)
    .sort((a, b) => b.t - a.t);
  for (const { f } of all.slice(STORED_MAX)) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* gone */ } }
}
