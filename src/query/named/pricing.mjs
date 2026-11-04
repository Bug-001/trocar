// src/query/named/pricing.mjs — `trocar query pricing` (RFC 1.6 §4.1, 附录 C.5).
//
// The unit prices a cost estimate is made with, and where they came from. Price is an external,
// user-editable fact (providers report tokens, never money — src/view/pricing.mjs, D14), so the
// document always says its source: the built-in table, or the file that replaced it.
import path from 'node:path';
import { loadPricing, PRICING_DIGEST } from '../../view/pricing.mjs';
import { statKey } from '../warm.mjs';

export const params = Object.freeze([]);
const UNIT = '$/Mtok';

/** The one file the prices come from: `TROCAR_PRICING`, else ~/.trocar/pricing.json (the built-in table when it is
 *  absent). `priceTable` and `pricingId` both ask this, so they cannot disagree about which file the answer depends on. */
const pricingFile = ({ home, env }) => (env ?? process.env).TROCAR_PRICING || path.join(home, 'pricing.json');

/** The table an answer prices with, and where it came from. */
export function priceTable({ home, env }) {
  const { pricing, source } = loadPricing(pricingFile({ home, env }));
  return { table: pricing, source };
}

/** The price identity (4.4 §条件 GET): which file, that file's identity, and the built-in table, which changes with a version
 *  while the file does not. */
export function pricingId({ home, fs, env }) {
  const f = pricingFile({ home, env });
  return [f, statKey(f, fs), PRICING_DIGEST];
}

export async function run({ home, env }) {
  const { table, source } = priceTable({ home, env });
  return {
    models: Object.entries(table).map(([model, [input, output, cache_write, cache_read]]) =>
      ({ model, input, output, cache_read, cache_write, unit: UNIT })),
    source,
  };
}
