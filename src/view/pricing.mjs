// src/view/pricing.mjs — editable unit-price config (RFC 2.2 / D14). Price is an EXTERNAL,
// user-editable variable (providers return token usage, never $ price); cost = usage × price is a
// derived local estimate and MUST NOT enter the normalized model. So pricing lives in a config the
// user can edit (TROCAR_PRICING or ~/.trocar/pricing.json), served to the board; absent → defaults.
// Shape: { <modelKey>: [input, output, cache_write, cache_read] } in $/Mtok.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

// Built-in prices: the vendor's (Anthropic) model price list as of 2026-10-06, in $/Mtok
// [input, output, cache_write, cache_read]; cache write = 1.25x input (the 5-minute TTL), cache read =
// 0.1x input unless the vendor lists a figure. The board picks the LONGEST key contained in the model id,
// so each family key is that family's current price and a longer key only marks a generation that differs.
// Haiku 5.5's row is its tier for prompts up to 100K tokens.
export const DEFAULT_PRICING = {
  opus: [5, 25, 6.25, 0.5], // Opus 5 / 4.8 / 4.7 / 4.6 / 4.5
  'opus-5-5': [4, 20, 5, 0.2],
  'opus-4-1': [15, 75, 18.75, 1.5],
  'opus-4-2025': [15, 75, 18.75, 1.5], // Opus 4.0 (dated id claude-opus-4-YYYYMMDD)
  sonnet: [3, 15, 3.75, 0.3], // Sonnet 4.6 and older
  'sonnet-5': [2, 10, 2.5, 0.2], // Sonnet 5 / 5.5
  haiku: [1, 5, 1.25, 0.1], // Haiku 4.5
  'haiku-5': [0.1, 0.5, 0.125, 0.01], // Haiku 5.5
};

// Names the built-in table inside a price identity: a new release with new prices is a new identity even when no price file changed.
export const PRICING_DIGEST = createHash('sha1').update(JSON.stringify(DEFAULT_PRICING)).digest('hex').slice(0, 16);

const isRow = (v) => Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number' && n >= 0);

// loadPricing(p) → { pricing, source }. Merges a valid config file over the defaults (each row must
// be [4 non-negative numbers]); malformed rows are ignored (defaults win) so a typo can't zero a cost.
export function loadPricing(p) {
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
