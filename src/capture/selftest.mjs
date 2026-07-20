// src/capture/selftest.mjs — onboard 自检:依赖探测 + 「测试」四问(RFC 4.1:61 / 4.1:4 / 4.5:41,77;
// 1.1 六要素#5「把委派代价压到最小」)。这是 demo `run-selftest.sh` + `verify.mjs` 的 §验收 check 的
// CLI 化(`asight doctor`)——受众是人,核对四问:**是否真在抓 · 抓得对 · 凭据没漏 · 没弱化全机 TLS**。
// 全为纯函数(probe / records / trust 皆注入)→ 离线可单测,不碰真实信任库/网络。
import fsMod from 'node:fs';
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

// ③ 凭据(2026-07-20 起改义)。**旧契约**:secret header MUST 为 `<redacted>`,泄漏 = 硬失败。
// **新契约**:采集逐字存 header —— 凭据在采集里是**设计如此**(见 envelope.mjs 的说明),所以"存在
// 凭据"不再是失败,否则这条红线每次都喊狼来了、从此没人看。风险搬到了 ④b:**持有凭据的文件不得被
// 他人读取**。本问退化为"报告实情"+ 保留空扫描守卫。
const ANT_TOKEN = /sk-ant-[A-Za-z0-9._-]{6,}/;
export function qNoLeak(records) {
  // EXAMINED NOTHING ≠ FOUND NOTHING —— 这条守卫比它守的那个契约活得更久,别删。
  // 它曾经让 doctor 在读到零条记录时打印「✓ 凭据没漏」并退出 0。
  if (!records || records.length === 0) {
    return { ok: false, examined: 0, withCreds: 0, tokens: [], tokenCount: 0,
      note: '✗ 没有检查任何记录 — no records were examined, so nothing can be reported. '
        + 'The capture source resolved to zero readable records (wrong --source, an unreadable '
        + 'directory, or a capture that has not started).' };
  }
  let withCreds = 0; const tokens = [];
  for (const r of records) {
    const h = r.req_headers || r.request_headers || {};
    if (Object.keys(h).some((k) => SECRET_HEADERS.has(k.toLowerCase()) && h[k] && h[k] !== '<redacted>')) withCreds++;
    const body = typeof r.req_body === 'string' ? r.req_body : '';
    const m = body.match(ANT_TOKEN); if (m) tokens.push(m[0].slice(0, 10) + '…');
  }
  return { ok: true, examined: records.length, withCreds, tokens: tokens.slice(0, 10), tokenCount: tokens.length,
    note: `${withCreds}/${records.length} record(s) carry credential headers — 逐字存储,by design `
      + '(asight records what really went over the wire; the protection is file permissions, see ④b)'
      + (tokens.length ? ` · ${tokens.length} sk-ant token-shaped string(s) inside request bodies` : '') };
}

// ④b 采集文件不可被他人读取(**新硬红线**)。凭据现在就在这些字节里,所以唯一还成立的保证是
// 「只有属主读得到」。一次 stat,取代原来那套改写防火墙。
export function qFilePerms(files) {
  if (!files || files.length === 0) {
    return { ok: false, checked: 0, bad: [],
      note: '✗ 没有检查任何文件 — no capture files were examined, so permissions cannot be certified.' };
  }
  const bad = [];
  for (const f of files) {
    try {
      const st = fsMod.statSync(f);
      const mode = st.mode & 0o777;
      if (mode & 0o077) bad.push({ file: f, mode: '0' + mode.toString(8) });
    } catch (e) { bad.push({ file: f, mode: 'unreadable: ' + e.message }); }
  }
  return { ok: bad.length === 0, checked: files.length, bad,
    note: bad.length
      ? `✗ ${bad.length} capture file(s) readable by group/others [${bad.map((b) => `${b.file.split('/').pop()} ${b.mode}`).join(', ')}] — these bytes contain live API credentials. Fix: chmod 600`
      : `all ${files.length} capture file(s) are owner-only (0600)` };
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
export function runSelfTest({ records = [], srcMeta = null, deps = [], verify = null, files = [] } = {}) {
  const q1 = qCapturing(records, srcMeta);
  const q2 = qCorrect(records);
  const q3 = qNoLeak(records);
  const q4 = qUserTrustOnly(verify);
  // The red line MOVED (2026-07-20): credentials are stored verbatim by design, so the failure is no
  // longer "a secret is present" but "the file holding it is readable by someone else". q3 still
  // hard-fails on a VACUOUS scan — reading nothing must never certify anything.
  const q4b = qFilePerms(files);
  const depsMissing = deps.filter((d) => !d.present);
  return { deps, depsMissing, q1, q2, q3, q4, q4b, hardFail: !q3.ok || !q4b.ok, sampled: records.length };
}
