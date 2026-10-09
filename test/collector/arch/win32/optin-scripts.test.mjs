// test/collector/arch/win32/optin-scripts.test.mjs — W64's static scan of the fixed opt-in scripts (4.8 §2.4「执行」: 每种一份固定脚本,
// 只写它自己那一项,先备份). These .ps1 files are DATA here — they first run for real on Windows — so what this
// test can hold them to is their TEXT: every write each script performs sits in its own item's allowlist (its registry key and value, its
// certificate store, its file paths), the verbs asight has decided never to use are in none of them, and the one registry key that IS written
// is the very key the harness data declares (a data edit that leaves the script behind is red here first). The scanner is a function of the
// text, so a planted violation is red too — the scan is not a rubber stamp of the current files.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { SCRIPTS_DIR, OPTIN_ITEMS } from '../../../../src/collector/arch/win32/optin.mjs'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { groupsOf } from '../../../../src/collector/arch/win32/route-plan.mjs'

const GROUPS = groupsOf(await loadHarnesses())
const textOf = (f) => fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8')

/** PowerShell `#` comment lines out (the scripts hold no `#` inside a string; the ASCII check below still sees the whole file). */
const codeOf = (src) => src.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n')

// Verbs none of the opt-in scripts may use, anywhere in code: setx (1024-char truncation), anything machine-level (the machine items are
// elevate.mjs's one self-contained step, never a script), any delete (the undos are src/off's inline functions, apply only here), any
// network, any process start. 4.8 §2.4「执行」· §6.3; 1.6 §1.7「点名也不做」(a login-env proxy variable is not written by any item).
const FORBIDDEN = Object.freeze(['setx', 'HKLM', 'LocalMachine', 'MachineKeys', '-delstore', 'Remove-', 'netsh', 'schtasks', 'Register-',
  'Invoke-WebRequest', 'Net.WebClient', 'DownloadFile', 'Start-Process', 'Import-Certificate', 'Set-Content', 'Add-Content', 'Clear-Content',
  'Delete', 'Move-Item', 'Copy-Item', 'Invoke-Item', 'Invoke-Expression', 'Out-File', 'New-Service', 'net user', 'HTTPS_PROXY', 'HTTP_PROXY'])

/** One item's write plan: which writes (registry, store, files, directories, shortcut repoints) are this script's own — everything else is a
 * violation. `reg` holds whole command fragments as they must appear; `writeBytes` the exact first arguments of WriteAllBytes calls. */
const WRITE_PLAN = Object.freeze({
  'user-path.ps1': { writeBytes: ["(Join-Path $BinDir ($Command + '.cmd'))"], newItems: ['-Path $BinDir'], certutil: [], reg: [], repoints: 0, guards: [/\$Command -notmatch/] },
  'shortcut.ps1': { writeBytes: ['$Launcher'], newItems: ['-Path $d'], certutil: [], reg: [], repoints: 1, guards: [] },
  'cert-user.ps1': { writeBytes: [], newItems: [], certutil: ['-user -addstore Root $CertFile'], reg: [], repoints: 0, guards: [] },
  'claude-policy.ps1': { writeBytes: [], newItems: [], certutil: [], reg: null /* the harness data's own policy key, checked by test */, repoints: 0, guards: [/\$Url -notmatch/] },
  'vscode.ps1': { writeBytes: ['$Settings', '$Launcher'], newItems: ['-Path $d'], certutil: [], reg: [], repoints: 1, guards: [] },
  'zcode-desktop.ps1': { writeBytes: ['$File'], newItems: ['-Path $d'], certutil: [], reg: [], repoints: 0, guards: [] },
})

/** The violations of one script text against its plan (W64: 每份 optin/*.ps1 只写它自己那一项). `plan.reg === null` means the allowed reg
 * add is handed in by the caller (claude-policy's key is the harness data's own — the equality is a test of its own below). */
export function violationsOf(name, rawSrc, plan = WRITE_PLAN[name] || null, allowedReg = []) {
  const out = []
  if (!plan) return [`no write plan for ${name} (a new script without a scan is not a script)`]
  const src = codeOf(rawSrc)
  if (src.includes('$ErrorActionPreference') === false || /ErrorActionPreference\s*=\s*'Stop'/.test(src) === false) out.push('no $ErrorActionPreference = \'Stop\' (a script that limps on is worse than one that stops)')
  for (const bad of FORBIDDEN) if (src.includes(bad)) out.push(`forbidden text in code: ${bad}`)
  const certutilCalls = [...src.matchAll(/certutil[^\r\n]*/g)].map((m) => m[0].trim())
  const allowedCert = plan.certutil.map((c) => `certutil ${c}`)
  for (const c of certutilCalls) if (!allowedCert.includes(c)) out.push(`a certutil call outside its own item: ${c}`)
  if (certutilCalls.length !== allowedCert.length) out.push(`expected ${allowedCert.length} certutil call(s), found ${certutilCalls.length}`)
  const regCalls = [...src.matchAll(/\breg\s+add[^\r\n]*/g)].map((m) => m[0].trim())
  for (const r of regCalls) if (!allowedReg.includes(r)) out.push(`a reg add outside its own item: ${r}`)
  if (regCalls.length !== allowedReg.length) out.push(`expected ${allowedReg.length} reg add(s), found ${regCalls.length}`)
  const writes = [...src.matchAll(/\[IO\.File\]::WriteAllBytes\((.*?),\s*\[Convert\]::FromBase64String\(/g)].map((m) => m[1].trim())
  for (const w of writes) if (!plan.writeBytes.includes(w)) out.push(`a file write outside its own paths: WriteAllBytes(${w}, …)`)
  if (writes.length !== plan.writeBytes.length) out.push(`expected ${plan.writeBytes.length} WriteAllBytes call(s), found ${writes.length}`)
  for (const w of [...src.matchAll(/\[[A-Za-z.]+\]::(Write(?!AllBytes)|Append|Copy|Move|Delete)\w*\(/g)].map((m) => m[0])) out.push(`a .NET write verb outside WriteAllBytes: ${w}`)
  const newItems = [...src.matchAll(/New-Item[^\r\n]*/g)].map((m) => m[0].trim())
  for (const n of newItems) if (!plan.newItems.some((a) => n.includes(a))) out.push(`a directory created outside its own paths: ${n}`)
  const repoints = (src.match(/\$lnk\.TargetPath = /g) || []).length
  if (repoints !== plan.repoints) out.push(`expected ${plan.repoints} shortcut repoint(s), found ${repoints}`)
  if (/TargetPath = (?! \$Launcher)/.test(src.replace('$lnk.TargetPath = $Launcher', ''))) out.push('a shortcut repointed somewhere other than the script\'s own launcher')
  for (const g of plan.guards) if (!g.test(src)) out.push(`a guard is missing: ${g}`)
  return out
}

test('the fixed scripts are exactly the catalog\'s six, each ASCII, each writing only its own item (W64\'s static scan)', () => {
  const files = fs.readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.ps1')).sort()
  const named = [...new Set(Object.values(OPTIN_ITEMS).flatMap((d) => d.parts.map((p) => p.script).filter(Boolean)))].sort()
  assert.deepEqual(files, named, 'every script the catalog names exists, and nothing else lives in optin/ (a script without a catalog item is dead weight)')
  // claude-policy's one reg add is the harness data's own policy key — the plan is handed it from the data, so a data edit that leaves the
  // script behind (or a script edit that leaves the data behind) is red here
  const policy = GROUPS.find((x) => x.g === 'claude-code.desktop').group.proxyEntry
  const allowedReg = [`reg add '${policy.hive}\\${policy.key}' /v ${policy.name} /t REG_SZ /d $Url /f`]
  for (const f of files) {
    const src = textOf(f)
    assert.match(src, /^# /, `${f}: a header comment saying what it is`)
    assert.ok(/^[\x20-\x7e\r\n\t]*$/.test(src), `${f}: plain ASCII only (PowerShell 5.1 reads a BOM-less .ps1 as ANSI)`)
    assert.ok(!src.startsWith('﻿'), `${f}: no BOM`)
    assert.deepEqual(violationsOf(f, src, WRITE_PLAN[f], f === 'claude-policy.ps1' ? allowedReg : []), [], `${f}: only its own writes`)
  }
})

test('claude-policy.ps1 writes the very key the claude-code data declares, value egressProxyUrl, REG_SZ, an http address only (the data and the script are one contract)', () => {
  const src = codeOf(textOf('claude-policy.ps1'))
  const policy = GROUPS.find((x) => x.g === 'claude-code.desktop').group.proxyEntry
  assert.deepEqual([policy.hive, policy.key, policy.name], ['HKCU', 'SOFTWARE\\Policies\\Claude', 'egressProxyUrl'], 'the harness data (lab L2/L3)')
  assert.ok(src.includes(`reg add '${policy.hive}\\${policy.key}' /v ${policy.name} /t REG_SZ /d $Url /f`), 'the script writes exactly that one value')
  assert.ok(src.includes("'^https?://[^\\s\"]+$'"), 'and only an http address is accepted as the value (no credentials: the listener takes none)')
})

test('the scanner is not a rubber stamp: a planted violation in each category is red (the scan reads like the reviewer, not like the file)', () => {
  const base = textOf('user-path.ps1')
  const planted = (extra) => `${base}\n${extra}\n`
  assert.ok(violationsOf('user-path.ps1', planted("reg add 'HKCU\\Environment' /v HTTPS_PROXY /t REG_SZ /d http://x /f"), undefined, []).some((v) => /reg add outside/.test(v)), 'a login-env proxy write is a violation (1.6 §1.7: never, even named)')
  assert.ok(violationsOf('user-path.ps1', planted("[IO.File]::WriteAllBytes('C:\\Windows\\evil.dll', [Convert]::FromBase64String($ShimB64))")).some((v) => /file write outside/.test(v)), 'a write outside its own paths')
  assert.ok(violationsOf('user-path.ps1', planted('certutil -user -addstore TrustedPublisher $CertFile')).some((v) => /certutil/.test(v)), 'a store outside its own item')
  assert.ok(violationsOf('user-path.ps1', planted('setx HTTPS_PROXY http://x')).some((v) => /setx/.test(v)), 'setx is forbidden outright')
  assert.ok(violationsOf('shortcut.ps1', textOf('shortcut.ps1').replace('WriteAllBytes($Launcher,', "WriteAllBytes($Env:TEMP + '\\x',")).some((v) => /file write outside/.test(v)), 'a rewritten target argument is a violation')
  assert.deepEqual(violationsOf('zcode-desktop.ps1', textOf('zcode-desktop.ps1'), WRITE_PLAN['zcode-desktop.ps1'], []), [], 'the untouched file stays clean (the mutations above really were what went red)')
  assert.deepEqual(violationsOf('no-such.ps1', ''), ['no write plan for no-such.ps1 (a new script without a scan is not a script)'], 'a script without a plan is itself a violation')
})

test('each script\'s parameters are its whole surface: named, mandatory where the item needs them, no positional extras', () => {
  const PARAMS = {
    'user-path.ps1': [['BinDir', true], ['Command', true], ['ShimB64', true]],
    'shortcut.ps1': [['Launcher', true], ['LauncherB64', true], ['Shortcut', true]],
    'cert-user.ps1': [['CertFile', true]],
    'claude-policy.ps1': [['Url', true]],
    'vscode.ps1': [['Settings', true], ['SettingsB64', true], ['Launcher', true], ['LauncherB64', true], ['Shortcut', false]],
    'zcode-desktop.ps1': [['File', true], ['ContentB64', true]],
  }
  assert.deepEqual(Object.keys(PARAMS).sort(), Object.keys(WRITE_PLAN).sort(), 'the parameter table and the write plan name the same six scripts')
  for (const [f, params] of Object.entries(PARAMS)) {
    const src = textOf(f)
    const block = /param\(([\s\S]*?)\n\)/.exec(src)
    assert.ok(block, `${f}: a param block`)
    const names = [...block[1].matchAll(/\[[\w.[\]]+\]\$(\w+)/g)].map((m) => m[1])
    assert.deepEqual(names, params.map(([n]) => n), `${f}: exactly the parameters of its plan`)
    const mandatory = [...block[1].matchAll(/\[Parameter\(Mandatory = \$true\)\][^\r\n]*\$(\w+)/g)].map((m) => m[1])
    assert.deepEqual(mandatory, params.filter(([, m]) => m).map(([n]) => n), `${f}: mandatory where the item needs them (the optional ones have a default, never a prompt)`)
  }
})
