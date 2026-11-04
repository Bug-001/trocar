// src/query/stamp.mjs — what a name's answer depends on, as file identities (RFC 4.4 §条件 GET; the ETag value).
//
// Stat only: the raw/ name list and `statKey` of each file, never a byte of a record and never through a warm cache
// (a cache would answer with what IT last saw, and the point of a stamp is to notice that the disk moved).
import path from 'node:path';
import { statKey } from './warm.mjs';
import { segStamp } from './index-build.mjs';
import { namesStamp } from './rows.mjs';
import { classesFile, classesLog } from '../paths.mjs';
import { pricingId } from './named/pricing.mjs';
import { usageFile } from './usage.mjs';
import { titlesFile } from './titles.mjs';

const segmentsOf = ({ home, fs }) => {
  const names = namesStamp(home, fs);
  return { names, segs: [...new Set(names.split('\n').filter(Boolean).map((f) => f.replace(/\.(ndjson|sealed)$/, '')))] };
};
const corpusOf = ({ home, fs }, { names, segs }) => [names, ...segs.map((s) => segStamp(home, s, fs))];

/** The segment name list + each segment's plaintext and sealed file. */
export const corpus = (ctx) => corpusOf(ctx, segmentsOf(ctx));

/** The corpus + each segment's usage sidecar (its coverage grows when the worker fills one, 4.2 §用量旁注). */
export function usage(ctx) {
  const list = segmentsOf(ctx);
  return [...corpusOf(ctx, list), ...list.segs.map((s) => statKey(usageFile(ctx.home, s), ctx.fs))];
}

/** `overview`: `usage` + the price identity (its cost reads the table). */
export const overview = (ctx) => [...usage(ctx), ...pricingId(ctx)];

/** `sessions`: the corpus + the title table (a table written moves the stamp, so a new title is never held back by a 304). */
export const titles = (ctx) => [...corpus(ctx), statKey(titlesFile(ctx.home), ctx.fs)];

/** `analysis`: the corpus + the price identity (its money reads the table). */
export const analysis = (ctx) => [...corpus(ctx), ...pricingId(ctx)];

/** `classes`: the corpus + the user's table and the classification log. */
export const classes = (ctx) => [...corpus(ctx), statKey(classesFile(ctx.home), ctx.fs), statKey(classesLog(ctx.home), ctx.fs)];

/** `pricing`: the price identity alone. */
export const pricing = pricingId;
