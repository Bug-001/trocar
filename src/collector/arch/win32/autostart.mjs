// autostart.mjs — how the Windows collector is started and kept up, and what it refuses to start under (RFC 4.8 §7; acceptance W24 W25). The daemon is `node <asight> daemon`, started at login by one Task Scheduler task per user,
// supervised by a small parent that brings it back when it dies. Tools (`schtasks`, `reg`) run only through execTool, so a test injects the runner; the helper, the spawn and the clock are parameters too, and every piece runs on
// any OS against a temp directory. Node built-ins and src/off/exec.mjs only (this file never imports a harness, 4.6 §结构).

/** The oldest Node `on` accepts (package.json `engines`; a test holds the two equal). Older than that and the daemon would exit at every login with an error nobody sees (4.8 §7). */
export const NODE_MIN_MAJOR = 20

/**
 * The Node preflight of `on` (4.8 §7): → `{ ok: true, have, min }` or `{ ok: false, have, min, doctor }`. `doctor` is the line to print: what was found and what is needed. A version that cannot be read is not a pass (it names
 * itself as such): a daemon on an unknown Node is the one that exits at login. `versions` is `process.versions`.
 */
export function nodePreflight({ versions = process.versions } = {}) {
  const have = versions && versions.node
  const major = typeof have === 'string' && /^\d+(\.|$)/.test(have) ? Number(have.split('.')[0]) : null
  if (major === null) return { ok: false, have: have ?? null, min: NODE_MIN_MAJOR, doctor: `读不到 Node 的版本(${JSON.stringify(have ?? null)}):asight 在 Windows 上要 Node ≥ ${NODE_MIN_MAJOR}。确认 \`node --version\` 之后再 asight on` }
  if (major < NODE_MIN_MAJOR) return { ok: false, have, min: NODE_MIN_MAJOR, doctor: `Node ${have} 太旧:asight 在 Windows 上要 Node ≥ ${NODE_MIN_MAJOR}(守护进程每次登录都由这个 Node 拉起,更老的版本起不来)。升级 Node 之后再 asight on` }
  return { ok: true, have, min: NODE_MIN_MAJOR }
}

/**
 * R7 on Windows (4.8 §7): asight never runs with an elevated token or as SYSTEM. → `null` (go on) or `{ code: 'elevated-token', reason, token }`, which `on` and `daemon` turn into the refusal and the `start` failure record.
 * The check is the helper's own token (`token` verb: `{elevated, elevationType, integrity, system}`; `elevated` is "integrity High or above"). A token that cannot be read (the helper is down, native code did not compile, an answer
 * that is not booleans) is NOT a refusal (the helper's own failure is recorded where it happens); `onUnknown(reason)` says why it is unknown (R11).
 */
export async function refuseElevated({ helper, onUnknown = () => {} } = {}) {
  let t
  try { t = await helper.call('token') } catch (e) { onUnknown(`the token could not be read: ${(e && e.code) || ''} ${(e && e.message) || e}`.replace(/\s+/g, ' ').trim()); return null }
  if (!t || typeof t !== 'object' || typeof t.elevated !== 'boolean' || typeof t.system !== 'boolean') { onUnknown(`the token answer is not {elevated, system} booleans: ${JSON.stringify(t)}`.slice(0, 300)); return null }
  if (!t.elevated && !t.system) return null
  return {
    code: 'elevated-token',
    reason: `用你自己的账号跑,不要「以管理员身份运行」,也不要用 SYSTEM(R7:asight 不以提升的令牌运行;这个令牌是${t.system ? ' SYSTEM' : '高完整性级别'})`,
    token: { elevated: t.elevated, system: t.system, integrity: t.integrity ?? null },
  }
}
