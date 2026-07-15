// src/model/schema.mjs — apply the 3.2 normalized-model DDL and map provider
// usage into canonical roles. Owns nothing provider-native beyond this file.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DDL = join(HERE, 'ddl.sql');

// Run every statement in the DDL file on a @duckdb/node-api connection.
// FIX (verify blocker): strip '--' line comments BEFORE splitting on ';', so a
// ';' inside a comment does not create a bogus split point. The DDL contains no
// ';' inside string literals, so splitting the comment-free text on ';' is safe.
export async function applyDDL(connection, ddlPath = DEFAULT_DDL) {
  const sql = await readFile(ddlPath, 'utf8');
  const statements = sql
    .replace(/--[^\n]*/g, '') // remove -- line comments (to end of line) FIRST
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) await connection.run(stmt);
  return statements.length;
}

const num = (x) => (x == null ? 0 : Number(x));

// Canonical usage mapping (RFC 3.2 "provider -> canonical" table).
// Phase 1 = Anthropic/CC column only; other providers land in Phase 4.
export function mapUsage(provider, raw = {}) {
  if (provider !== 'anthropic' && provider !== 'cc') {
    throw new Error(
      `mapUsage: no canonical mapping for provider '${provider}' (Phase 1 = anthropic/cc only)`,
    );
  }
  const input_uncached = num(raw.input_tokens);
  const cache_read = num(raw.cache_read_input_tokens);
  const cache_write = num(raw.cache_creation_input_tokens); // Anthropic always reports -> 0, not null
  const output = num(raw.output_tokens);
  const reasoning = raw.output_tokens_details?.thinking_tokens ?? null;
  const total_input = input_uncached + cache_read + cache_write;

  // Faithfulness (invariant 2): every raw key not consumed above survives in extra.
  const extra = { ...raw };
  delete extra.input_tokens;
  delete extra.cache_read_input_tokens;
  delete extra.cache_creation_input_tokens;
  delete extra.output_tokens;
  if (extra.output_tokens_details) {
    const { thinking_tokens, ...rest } = extra.output_tokens_details;
    if (Object.keys(rest).length > 0) extra.output_tokens_details = rest;
    else delete extra.output_tokens_details;
  }
  return { input_uncached, cache_read, cache_write, output, reasoning, total_input, extra };
}
