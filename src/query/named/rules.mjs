// src/query/named/rules.mjs — `trocar query rules` (RFC 1.6 §4.1, 附录 C.5). Four small files and no audit stream, so the cost goes with the number of
// rules and the answer needs no daemon. What the stats could not say is 'unknown', never 0.
import { QueryArgError } from './index.mjs';
import { readRules } from '../../rules/file.mjs';
import { buffersOf, resendOk, ruleSha256, summaryOf, tierOfRule } from '../../rules/describe.mjs';
import { armedStatOf, isArmed, readRuleFacts, ruleState, statOf, stoppedOn } from '../../rules/state.mjs';
import { normalizeRule, scriptOf } from '../../rules/validate.mjs';

export const about = Object.freeze({
  summary: 'The rules, each with what it does, whether it runs now and what it has done.',
  params: Object.freeze({
    rule: 'Only this rule: its name, with the rule as written in the rule field of the answer. Without it, every rule.',
  }),
});
export const params = Object.freeze(Object.keys(about.params));

function rowOf(rule, facts, known) {
  const { on, match } = normalizeRule(rule);
  const stat = known ? statOf(rule, facts.stats) : {}, armedStat = armedStatOf(rule, facts.stats);
  const by = stat.not_applied_by ?? {};
  const tally = (n) => (known ? n : 'unknown');
  return {
    name: rule.name, note: rule.note ?? null, summary: summaryOf(rule), on, on_error: rule.on_error, harness: match.harness,
    state: ruleState(rule, facts), stopped_on: stoppedOn(rule, facts), armed_at: rule.armed_at ?? null,
    tier: tierOfRule(rule), buffers: buffersOf(rule), script: scriptOf(rule) !== null, resend_ok: resendOk(rule), sha256: ruleSha256(rule),
    limit: { times: rule.limit?.times ?? null, used: tally(armedStat.limit_used ?? 0), until: rule.limit?.until ?? null },
    changes: tally(stat.changes ?? 0), last_change: stat.last_change ?? null,
    not_applied: tally(Object.values(by).reduce((sum, n) => sum + n, 0)), not_applied_by: by, last_not_applied: stat.last_not_applied ?? null,
    resting_until: armedStat.resting_until ?? null,
  };
}

export function run({ home, fs, now, params: p, errors }) {
  const file = readRules({ home, fs });
  if (file.problem) errors.push({ where: 'rules.json', code: file.problem.code, reason: file.problem.reason });
  const { facts, errors: own, statsRead, statsAt } = readRuleFacts({ home, fs, now });
  errors.push(...own);
  const named = p.rule == null ? null : file.doc.rules.find((r) => r.name === p.rule);
  if (p.rule != null && !named && file.state !== 'bad') throw new QueryArgError(`trocar query rules: --rule ${JSON.stringify(p.rule)} names no rule (\`trocar query rules\` lists them)`);
  const rules = p.rule == null ? file.doc.rules : named ? [named] : [];
  const known = (rule) => statsRead === 'ok' || (statsRead === 'absent' && !isArmed(rule));
  if (statsRead === 'absent' && rules.some(isArmed)) errors.push({ where: 'rules-stats.json', reason: 'there is no such file, and a rule is on: its counts are not known' });
  return {
    rules: rules.map((rule) => rowOf(rule, facts, known(rule))),
    ...(p.rule == null ? {} : { rule: named ?? null }),
    max_delay_ms: file.doc.max_delay_ms, stats_at: statsAt, tripped: facts.tripped,
  };
}
