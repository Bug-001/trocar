// src/capture/selftest.mjs — onboard 自检:依赖探测 + 「测试」四问(RFC 4.1:61 / 4.1:4 / 4.5:41,77;
// 1.1 六要素#5「把委派代价压到最小」)。这是 demo `run-selftest.sh` + `verify.mjs` 的 §验收 check 的
// CLI 化(`asight doctor`)——受众是人,核对四问:**是否真在抓 · 抓得对 · 凭据没漏 · 没弱化全机 TLS**。
// 全为纯函数(probe / records / trust 皆注入)→ 离线可单测,不碰真实信任库/网络。
import { SECRET_HEADERS } from './redact.mjs';
import { isLlmCall } from './envelope.mjs';

// 依赖探测(4.5:41,77):openssl(全平台,生成 CA/叶证)+ certutil(仅 Linux,装用户 NSS 库)。
// 缺则给「装它的一行提示」而非静默失败。has=(bin)->bool 注入(CLI 用 which/where 实测)。
export function checkDeps({ platform = process.platform, has } = {}) {
  const needs = [{ bin: 'openssl', why: 'generate the capture CA / leaf cert', hint: { darwin: 'ships with macOS (xcode-select --install if missing)', linux: 'apt install openssl · dnf install openssl', win32: 'winget install ShiningLight.OpenSSL' } }];
  if (platform === 'linux') needs.push({ bin: 'certutil', why: 'install the CA into the user NSS trust store (~/.pki/nssdb)', hint: { linux: 'apt install libnss3-tools · dnf install nss-tools' } });
  return needs.map((d) => ({ bin: d.bin, present: !!(has && has(d.bin)), why: d.why, hint: d.hint[platform] || d.hint.linux }));
}

// ① 是否真在抓:源存在 + 有记录。srcMeta = {exists, bytes, mtimeMs} | null。
export function qCapturing(records, srcMeta) {
  const n = records.length;
  const ok = !!(srcMeta && srcMeta.exists && n > 0);
  return { ok, n, bytes: (srcMeta && srcMeta.bytes) || 0, mtimeMs: (srcMeta && srcMeta.mtimeMs) || null,
    note: !srcMeta || !srcMeta.exists ? 'no capture source found — run `asight capture`, then a CC-CLI session'
      : n === 0 ? 'source exists but holds 0 records (nothing captured yet)'
      : `${n} record(s) captured` };
}

// ② 抓得对:LLM call 有 verbatim req_body(string,非空)+ 一个重建出的 resp(usage/text/tool_calls 或标 error)。
export function qCorrect(records) {
  let llm = 0, good = 0, badReq = 0, badResp = 0;
  for (const r of records) {
    if (!isLlmCall(r.endpoint || '')) continue;
    llm++;
    const hasReq = typeof r.req_body === 'string' && r.req_body.length > 0;
    const resp = r.resp || {};
    const hasResp = !!(resp.usage || resp.text || resp.tool_calls || resp.kind === 'error' || r.error);
    if (!hasReq) badReq++;
    if (!hasResp) badResp++;
    if (hasReq && hasResp) good++;
  }
  // ok = 有 LLM call 且没有一条丢了 verbatim 请求体(缺响应体可能是 interrupted,归 warn 不判死)。
  return { ok: llm > 0 && badReq === 0, llm, good, badReq, badResp,
    note: llm === 0 ? 'no LLM calls to validate (capture a /v1/messages turn)'
      : `${good}/${llm} LLM call(s) carry verbatim req_body + a reconstructed response`
        + (badReq ? ` · ✗ ${badReq} missing verbatim req_body` : '') + (badResp ? ` · ⚠ ${badResp} missing response (interrupted?)` : '') };
}

// ③ 凭据没漏(硬红线):每条记录的 secret header MUST 为 `<redacted>`(redact 防火墙的验收面);
// 另扫存储字节里的裸 `sk-ant-` token 形(高置信 Anthropic 前缀,正常内容不会撞)→ 记为告警。
const ANT_TOKEN = /sk-ant-[A-Za-z0-9._-]{6,}/;
export function qNoLeak(records) {
  const unredacted = new Set(), tokens = [];
  for (const r of records) {
    const h = r.req_headers || r.request_headers || {};
    for (const k of Object.keys(h)) {
      const v = h[k];
      if (SECRET_HEADERS.has(k.toLowerCase()) && v != null && v !== '' && v !== '<redacted>') unredacted.add(k.toLowerCase());
    }
    const body = typeof r.req_body === 'string' ? r.req_body : '';
    const m = body.match(ANT_TOKEN); if (m) tokens.push(m[0].slice(0, 10) + '…');
  }
  // ok gates ONLY on the firewall's job (header redaction). A token-shaped string in a request BODY is
  // the user's own sent content or a firewall miss → surfaced as a warning, not a hard fail on its own.
  const ur = [...unredacted];
  return { ok: ur.length === 0, unredacted: ur, tokens: tokens.slice(0, 10), tokenCount: tokens.length,
    note: ur.length ? `✗ ${ur.length} un-redacted secret header(s) [${ur.join(', ')}] — redact firewall breached`
      : 'all secret headers redacted' + (tokens.length ? ` · ⚠ ${tokens.length} sk-ant token-shaped string(s) inside request bodies (user-sent content or a firewall miss — inspect)` : ' · no raw token bytes in bodies') };
}

// ④ 没弱化全机 TLS:CA 只在用户级信任库(import-only,D22 — asight 从不写全机信任)。verify=()->bool 注入。
export function qUserTrustOnly(verify) {
  let ok = false, err = null;
  try { ok = !!(verify && verify()); } catch (e) { err = e && e.message; }
  return { ok, err,
    note: ok ? 'CA present in the USER trust store; asight never writes machine-wide trust (import-only, D22)'
      : err ? 'trust check errored: ' + err
      : 'CA not found in the user trust store — not onboarded yet (run: asight on). asight only ever installs user-level.' };
}

// 组装四问 + 依赖探测为一个结构化结果。hardFail = 凭据泄漏(唯一不可谈判的安全红线;其余是给人核对的诊断)。
export function runSelfTest({ records = [], srcMeta = null, deps = [], verify = null } = {}) {
  const q1 = qCapturing(records, srcMeta);
  const q2 = qCorrect(records);
  const q3 = qNoLeak(records);
  const q4 = qUserTrustOnly(verify);
  const depsMissing = deps.filter((d) => !d.present);
  return { deps, depsMissing, q1, q2, q3, q4, hardFail: !q3.ok, sampled: records.length };
}
