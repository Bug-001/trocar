// src/capture/selftest.mjs — onboard 自检:依赖探测 + 「测试」四问(RFC 4.1:61 / 4.1:4 / 4.5:41,77;
// 1.1 六要素#5「把委派代价压到最小」)。这是 demo `run-selftest.sh` + `verify.mjs` 的 §验收 check 的
// CLI 化(`trocar doctor`)——受众是人,核对四问:**是否真在抓 · 抓得对 · 凭据没漏 · 没弱化全机 TLS**。
// 全为纯函数(probe / records / trust 皆注入)→ 离线可单测,不碰真实信任库/网络。
import fsMod from 'node:fs';
import { isSecretHeader } from './redact.mjs';
import { isLlmCall } from '../dissect/endpoints.mjs';

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
    note: !srcMeta || !srcMeta.exists ? 'no capture source found — run `trocar on`, then an agent session'
      : n === 0 ? 'source exists but holds 0 records (nothing captured yet)'
      : `${n} record(s) captured` };
}

// ② 抓得对:LLM call 有 verbatim req_body(string,非空)+ 一个重建出的 resp(usage/text/tool_calls 或标 error)。
// D40: a call the operator set to 「只记日志」 (body_retention:'log', `trocar keep`) has no body BY CHOICE: it is counted apart (`logged`), never
// as a missing verbatim req_body (it reported ✗ for a setting that was working). src/capture may not import src/dissect, so the field is read here.
export function qCorrect(records) {
  let llm = 0, good = 0, badReq = 0, badResp = 0, logged = 0;
  for (const r of records) {
    if (!isLlmCall(r.endpoint || '')) continue;
    if (r.body_retention === 'log') { logged++; continue; }
    llm++;
    const hasReq = typeof r.req_body === 'string' && r.req_body.length > 0;
    const resp = r.resp || {};
    const hasResp = !!(resp.usage || resp.text || resp.tool_calls || resp.kind === 'error' || r.error);
    if (!hasReq) badReq++;
    if (!hasResp) badResp++;
    if (hasReq && hasResp) good++;
  }
  // ok = 有 LLM call 且没有一条丢了 verbatim 请求体(缺响应体可能是 interrupted,归 warn 不判死)。
  const keptNote = logged ? ` · ${logged} LLM call(s) kept as a log line only (log line only, set with \`trocar keep\`): no body by choice, not a capture failure` : '';
  return { ok: llm > 0 && badReq === 0, llm, good, badReq, badResp, logged,
    note: (llm === 0 ? (logged ? 'no LLM call kept a body to validate' : 'no LLM calls to validate (capture a /v1/messages turn)')
      : `${good}/${llm} LLM call(s) carry verbatim req_body + a reconstructed response`
        + (badReq ? ` · ✗ ${badReq} missing verbatim req_body` : '') + (badResp ? ` · ⚠ ${badResp} missing response (interrupted?)` : '')) + keptNote };
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
      note: 'x no records were examined, so nothing can be reported. '
        + 'The capture source resolved to zero readable records (wrong --source, an unreadable '
        + 'directory, or a capture that has not started).' };
  }
  let withCreds = 0; const tokens = [];
  for (const r of records) {
    const h = r.req_headers || r.request_headers || {};
    if (Object.keys(h).some((k) => isSecretHeader(k) && h[k] && h[k] !== '<redacted>')) withCreds++;
    const body = typeof r.req_body === 'string' ? r.req_body : '';
    const m = body.match(ANT_TOKEN); if (m) tokens.push(m[0].slice(0, 10) + '…');
  }
  return { ok: true, examined: records.length, withCreds, tokens: tokens.slice(0, 10), tokenCount: tokens.length,
    note: `${withCreds}/${records.length} record(s) carry credential headers - stored verbatim, by design `
      + '(trocar records what really went over the wire; the protection is file permissions, see ④b)'
      + (tokens.length ? ` · ${tokens.length} sk-ant token-shaped string(s) inside request bodies` : '') };
}

// ④b 采集文件不可被他人读取(**新硬红线**)。凭据现在就在这些字节里,所以唯一还成立的保证是
// 「只有属主读得到」。一次 stat,取代原来那套改写防火墙。三种结果,不混:
//   bad         mode 里有 group / other 的位 → 失败(退出 1),文案「采集文件可被他人读取」;
//   unreadable  stat 不出来(权限、竞态删除…) → 不知道(退出 3),带文件与 errno:读不到的文件不是「被他人读取」,也不是「没问题」(R11);
//   checked 0   一个文件也没核 → 不知道,什么都没认证。
const shq = (f) => `'${String(f).replace(/'/g, `'\\''`)}'`;
export function qFilePerms(files, { platform = process.platform } = {}) {
  if (!files || files.length === 0) {
    return { ok: false, checked: 0, bad: [], unreadable: [],
      note: '? no capture files were examined, so permissions cannot be certified (undetermined).' };
  }
  // Mode bits are POSIX: Windows reports a synthesized 0666 / 0444 for every file, and who may read one is the ACL of the
  // profile it lies in (a Windows test machine 2026-10-18: six backups of a healthy machine came out as "readable by others", with a chmod fix)
  if (platform === 'win32') return { ok: true, checked: files.length, bad: [], unreadable: [], note: 'on Windows the profile folder\'s access list decides who reads these files; there are no mode bits to check' };
  const bad = [], unreadable = [];
  for (const f of files) {
    try {
      const st = fsMod.statSync(f);
      const mode = st.mode & 0o777;
      if (mode & 0o077) bad.push({ file: f, mode: '0' + mode.toString(8) });
    } catch (e) { unreadable.push({ file: f, error: (e && (e.code || e.message)) || String(e) }); }
  }
  const parts = [];
  if (bad.length) parts.push(`x capture files others can read: ${bad.length} [${bad.map((b) => `${b.file.split('/').pop()} ${b.mode}`).join(', ')}] — capture file(s) readable by group/others; these bytes contain live API credentials. Fix: chmod 600 ${bad.map((b) => shq(b.file)).join(' ')}`);
  if (unreadable.length) parts.push(`? unknown: the permissions of ${unreadable.length} file(s) could not be read [${unreadable.map((u) => `${u.file}: ${u.error}`).join('; ')}] — cannot say they are owner-only`);
  return { ok: bad.length === 0 && unreadable.length === 0, checked: files.length, bad, unreadable,
    note: parts.length ? parts.join(' · ') : `all ${files.length} capture file(s) are owner-only (0600)` };
}

// ④ was 「CA 只在用户级信任库」: it asked a SECOND trust-store check of its own, which on Windows threw an internal
// "not implemented (D22 reserved …)" at the person reading `doctor` (a Windows test machine 2026-10-18). There is one check for
// 「is the root trusted」 — the collector's root store, the one `status` and `install` use — and `doctor` reads its verdict
// (src/cli/doctor.mjs undeterminedOf, from `status`'s `cert.root`).

// 组装四问 + 依赖探测为一个结构化结果。三个结局(R4),不混:
//   failed        有采集文件可被他人读取(④b `bad`)→ 退出 1。唯一不可谈判的安全红线;其余是给人核对的诊断。已发现的问题压过「判不了」。
//   undetermined  什么也没核到 / 核不全 → 退出 3(「无法判定」),不是过:零条记录、零个文件、读不出权限的文件、读失败的采集文件。
//                 「核到零条」报「过」会让人以为权限已经核过(0.1 §3 「测试必须能变红」;这条守卫曾经缺席)。
//   否则 ok → 0。
// `hardFail` = failed:旧名字,只表示「必须以非 0 退出的失败」;`undetermined` 另走自己的退出码。
export function runSelfTest({ records = [], srcMeta = null, deps = [], files = [], readErrors = [], platform = process.platform } = {}) {
  const q1 = qCapturing(records, srcMeta);
  const q2 = qCorrect(records);
  const q3 = qNoLeak(records);
  // The red line MOVED (2026-07-20): credentials are stored verbatim by design, so the failure is no
  // longer "a secret is present" but "the file holding it is readable by someone else". q3 still
  // refuses to certify a VACUOUS scan — reading nothing must never certify anything.
  const q4b = qFilePerms(files, { platform });
  const depsMissing = deps.filter((d) => !d.present);
  const failed = q4b.bad.length > 0;
  const why = [];
  if (!q3.ok) why.push('no records were examined, so neither the credentials nor the file permissions can be reported');
  if (q4b.checked === 0) why.push('no capture file was examined, so no permissions were checked');
  if (q4b.unreadable.length) why.push(`the permissions of ${q4b.unreadable.length} file(s) could not be read`);
  if (readErrors.length) why.push(`${readErrors.length} capture file(s) could not be read in full`);
  const undetermined = !failed && why.length > 0;
  return { deps, depsMissing, q1, q2, q3, q4b, failed, undetermined, undeterminedWhy: why, hardFail: failed, sampled: records.length };
}
