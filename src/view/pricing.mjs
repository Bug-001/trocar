// src/view/pricing.mjs — editable unit-price config (RFC 2.2 / D14). Price is an EXTERNAL,
// user-editable variable (providers return token usage, never $ price); cost = usage × price is a
// derived local estimate and MUST NOT enter the normalized model. So pricing lives in a config the
// user can edit (TROCAR_PRICING or ~/.atrace/pricing.json), served to the board; absent → defaults.
// Shape: { <modelKey>: [input, output, cache_write, cache_read] } in $/Mtok.
import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PRICING = {
  opus: [15, 75, 18.75, 1.5],
  sonnet: [3, 15, 3.75, 0.3],
  haiku: [1, 5, 1.25, 0.1],
};

export const DEFAULT_PRICING_PATH = process.env.TROCAR_PRICING || path.join(os.homedir(), '.atrace', 'pricing.json');

const isRow = (v) => Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number' && n >= 0);

// loadPricing(p?) → { pricing, source }. Merges a valid config file over the defaults (each row must
// be [4 non-negative numbers]); malformed rows are ignored (defaults win) so a typo can't zero a cost.
export function loadPricing(p = DEFAULT_PRICING_PATH) {
  const out = { ...DEFAULT_PRICING };
  let source = 'default';
  try {
    if (p && existsSync(p)) {
      const cfg = JSON.parse(readFileSync(p, 'utf8'));
      if (cfg && typeof cfg === 'object') {
        for (const [k, v] of Object.entries(cfg)) if (isRow(v)) out[k] = v;
        source = p;
      }
    }
  } catch { /* malformed file → defaults */ }
  return { pricing: out, source };
}
