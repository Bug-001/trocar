// src/dissect/project.mjs — a session's project (RFC 3.4 §工作目录(项目), D83): the working directory the request itself states.
// The rules are DATA on each harness row (`cwd`, src/dissect/harnesses.mjs): where the harness writes it and how, so no harness
// branch lives here (invariant 3); a row with no rules states none. Only an inference call's body is read (bodyOf, D40). The
// process cwd is never a fallback: the envelope names pid / exe / agent only, and one daemon serves many sessions. Leaf module.
import { createHash } from 'node:crypto';
import { harnessOf, bodyOf } from './harnesses.mjs';
import { systemPartsOf, systemItemsOf, userTextsOf } from './synth-key.mjs';

const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;
const valid = (p) => ABSOLUTE.test(p) && p.length <= 1024 && !/[\x00-\x1f\x7f]/.test(p);

/** The absolute working directory `rec` states, verbatim; null when it states none. */
export function projectOf(rec) {
  const row = harnessOf(rec).row;
  if (!row || !row.cwd || !row.cwd.length) return null;
  const body = bodyOf(rec);
  if (!body) return null;
  for (const rule of row.cwd) {
    for (const text of rule.in === 'system' ? [...systemPartsOf(body), ...systemItemsOf(body)] : userTextsOf(body)) {
      const m = rule.re.exec(text);
      if (m && valid(m[1].trim())) return m[1].trim();
    }
  }
  return null;
}

/** The document fields of a project path (1.6 C.5): the one home of the `_unresolved` sentinel and the slug rule. */
export function projectFields(path) {
  if (path == null) return { project_slug: '_unresolved', project_path: null };
  return { project_slug: createHash('sha256').update(path, 'utf8').digest('hex').slice(0, 12), project_path: path };
}
