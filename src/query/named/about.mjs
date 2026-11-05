// src/query/named/about.mjs — the description text several named queries share (RFC 1.6 §4.1): each query's own summary and parameter
// lines sit beside its declaration, and spread these in by name.
//
// Imports nothing, and must stay that way: the query modules and index.mjs import each other, so a module's top-level `about` runs before
// index.mjs's own consts exist. This file is the one thing it can safely read, which is why the page sizes live here.

/** `--limit`'s default and most, on the list queries (1.6 §4.1). */
export const LIMIT_DEFAULT = 50, LIMIT_MAX = 500;

const TIME = 'ISO 8601, or a relative 30m, 24h or 7d.';
/** The time window. */
export const WINDOW = Object.freeze({
  since: `Start of the time window: ${TIME}`,
  until: `End of the time window: ${TIME}`,
});
/** One page of a list. */
export const PAGE = Object.freeze({
  limit: `The most rows on one page: a whole number, ${LIMIT_DEFAULT} if not given, ${LIMIT_MAX} at most.`,
  after: 'Where the page starts: the next field of the previous answer. Without it, the first page.',
});
/** `--harness` where it picks rows of the answer; `status` and `doctor` take the agents' CLI names instead. */
export const HARNESS = 'Only these agents: comma-separated values of the harness field of this answer. Without it, every agent.';
