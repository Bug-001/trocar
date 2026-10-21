#!/usr/bin/env node
// scripts/cli-shot.mjs — a photo of what the CLI actually looks like (D58⑥).
//
//   node scripts/cli-shot.mjs [--out f.png] [--cols 80] [--title t] -- node bin/trocar.mjs help
//   node scripts/cli-shot.mjs --text sample.txt [--out f.png]
//
// String assertions cannot see layout, alignment or colour, so the agents that design, build and
// test CLI output render it and LOOK at it. The command runs with FORCE_COLOR=1 and COLUMNS=<cols>;
// stderr is rendered after stdout in a warmer colour. Rendering is Playwright if it resolves,
// else the installed Google Chrome in headless mode. No new dependency either way.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const BASE = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5']
const BRIGHT = ['#7f7f7f', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff']
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** xterm-256 index → #rrggbb (0-7 base, 8-15 bright, 16-231 the 6x6x6 cube, 232-255 greys). */
function color256(n) {
  if (n < 8) return BASE[n]
  if (n < 16) return BRIGHT[n - 8]
  if (n < 232) {
    const c = n - 16, step = (v) => (v === 0 ? 0 : 55 + v * 40)
    return rgb(step(Math.floor(c / 36)), step(Math.floor(c / 6) % 6), step(c % 6))
  }
  const g = 8 + (n - 232) * 10
  return rgb(g, g, g)
}
const rgb = (r, g, b) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('')

/** One SGR parameter string applied to {bold, dim, fg}. Unknown parameters are ignored, not guessed. */
function applySgr(st, params) {
  const codes = (params === '' ? '0' : params).split(';').map(Number)
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]
    if (c === 0) { st.bold = false; st.dim = false; st.fg = null }
    else if (c === 1) st.bold = true
    else if (c === 2) st.dim = true
    else if (c === 22) { st.bold = false; st.dim = false }
    else if (c >= 30 && c <= 37) st.fg = BASE[c - 30]
    else if (c >= 90 && c <= 97) st.fg = BRIGHT[c - 90]
    else if (c === 39) st.fg = null
    else if (c === 38) {
      if (codes[i + 1] === 5) { st.fg = color256(codes[i + 2] || 0); i += 2 }
      else if (codes[i + 1] === 2) { st.fg = rgb(codes[i + 2], codes[i + 3], codes[i + 4]); i += 4 }
    }
  }
}

/** ANSI text → HTML for a <pre>. Supports reset/bold/dim and 8/16/256/truecolor foregrounds; every other escape is dropped. */
export function ansiToHtml(text) {
  const st = { bold: false, dim: false, fg: null }
  let out = '', open = false, last = 0, m
  const style = () => [st.bold && 'font-weight:700', st.dim && 'opacity:.62', st.fg && `color:${st.fg}`].filter(Boolean).join(';')
  // an SGR sequence (captured), or any other escape: CSI, OSC, or a two-character one — all dropped
  const re = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[\s\S]/g
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index))
    last = re.lastIndex
    if (m[1] === undefined) continue
    if (open) { out += '</span>'; open = false }
    applySgr(st, m[1])
    const s = style()
    if (s) { out += `<span style="${s}">`; open = true }
  }
  out += esc(text.slice(last))
  return out + (open ? '</span>' : '')
}

// 16px/0.6em advance holds for Menlo, Consolas and DejaVu Sans Mono within a few px over 80 columns;
// the slack below keeps the last column off the edge rather than pretending to know the metrics.
const CW = 9.7, LH = 22, PAD = 14, BAR = 28
// CJK and fullwidth forms take two cells in a terminal and two advances in the browser
const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u

/** How many terminal rows `text` (raw, with ANSI) occupies at `cols` columns, wrapping long lines the way a terminal does. */
export function rowsNeeded(text, cols) {
  let rows = 0
  for (const line of text.split('\n')) {
    let w = 0
    for (const ch of line.replace(/\x1b\[[0-9;?]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[\s\S]/g, '')) w += WIDE.test(ch) ? 2 : 1
    rows += Math.max(1, Math.ceil(w / cols))
  }
  return rows
}

function html({ body, cols, title, lines }) {
  const w = Math.round(cols * CW + PAD * 2)
  const h = Math.round(lines * LH + PAD * 2 + (title ? BAR : 0))
  const bar = title ? `<div class=bar>${esc(title)}</div>` : ''
  return { w, h, doc: `<!doctype html><meta charset=utf-8><style>
html,body{margin:0;background:#12141a}
body{width:${w}px}
.bar{height:${BAR}px;line-height:${BAR}px;background:#22252e;color:#9aa3b2;font:12px/-apple-system,system-ui,sans-serif;text-align:center}
pre{margin:0;padding:${PAD}px;color:#d6dae3;background:#12141a;font:16px/${LH}px Menlo,Consolas,"DejaVu Sans Mono",monospace;
    font-variant-ligatures:none;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:8}
</style>${bar}<pre>${body}</pre>` }
}

async function playwright() {
  const pick = (m) => (m && (m.chromium || (m.default && m.default.chromium))) || null
  try { const m = await import('playwright'); if (pick(m)) return pick(m) } catch { /* not in the repo */ }
  if (!process.env.TROCAR_PLAYWRIGHT) return null
  try { return pick(await import(pathToFileURL(path.join(process.env.TROCAR_PLAYWRIGHT, 'playwright', 'index.js')).href)) } catch { return null }
}

const CHROMES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
]

async function shoot({ doc, w, h, out }) {
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const chromium = await playwright()
  if (chromium) {
    const b = await chromium.launch()
    const page = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 })
    await page.setContent(doc)
    await page.screenshot({ path: out })
    await b.close()
    return
  }
  const bin = CHROMES.find((p) => fs.existsSync(p))
  if (!bin) throw new Error('no renderer: install playwright (or set TROCAR_PLAYWRIGHT=<node_modules>) or Google Chrome')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trocar-shot-'))
  try {
    const page = path.join(tmp, 'shot.html')
    fs.writeFileSync(page, doc)
    const r = spawnSync(bin, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
      `--window-size=${w},${h}`, `--screenshot=${out}`, '--virtual-time-budget=1000', `--user-data-dir=${tmp}/p`,
      pathToFileURL(page).href], { encoding: 'utf8', timeout: 30000 }) // headless Chrome 154 on macOS 27 can stay up after writing the png
    if (!fs.existsSync(out)) throw new Error(`chrome did not write the png: ${(r.stderr || r.error?.message || '').trim().split('\n').pop()}`)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
}

async function main(argv) {
  const opt = { cols: 80, out: path.join(os.tmpdir(), 'cli-shot.png') }
  const dash = argv.indexOf('--')
  const cmd = dash === -1 ? [] : argv.slice(dash + 1)
  for (let i = 0; i < (dash === -1 ? argv.length : dash); i++) {
    const [k, v] = [argv[i], argv[i + 1]]
    if (k === '--out' || k === '--cols' || k === '--title' || k === '--text') { opt[k.slice(2)] = v; i++ }
    else throw new Error(`unknown option ${k} (--out --cols --title --text -- <command>)`)
  }
  opt.cols = Number(opt.cols)
  let text
  if (opt.text) text = fs.readFileSync(opt.text, 'utf8')
  else if (cmd.length) {
    const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '1', COLUMNS: String(opt.cols) } })
    text = (r.stdout || '') + (r.stderr ? `\x1b[38;2;255;170;120m${r.stderr}\x1b[0m` : '')
  } else throw new Error('nothing to render: pass --text <file> or -- <command> [args...]')
  const flat = text.replace(/\n$/, '')
  const page = html({ body: ansiToHtml(flat), cols: opt.cols, title: opt.title, lines: rowsNeeded(flat, opt.cols) })
  await shoot({ ...page, out: path.resolve(opt.out) })
  console.log(path.resolve(opt.out))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => { console.error(`cli-shot: ${e.message}`); process.exit(1) })
}
