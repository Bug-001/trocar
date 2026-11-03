// web/vite.config.mjs — builds the board (web/) into the committed src/web/board/, which the daemon serves (4.4 §静态面, D75).
// Fixed names, no hashes: the build is committed and a rebuild of unchanged sources is byte-identical. CSS is not minified, so the
// cascade the hand-written sheets define is the one the page gets.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'

const FIRST = './assets/first.js'

// 1.2 #24: a cold replay open sends its first read before the main graph has loaded. core/first.mjs is its own input, and its
// script tag goes ahead of the entry, async, so it runs as soon as its own small closure (http.mjs, router.mjs) is in.
const firstAhead = {
  name: 'trocar-first-ahead',
  transformIndexHtml: {
    order: 'post',
    handler(html) {
      const at = html.indexOf('<script type="module"')
      if (at < 0) throw new Error('index.html: no module entry to put first.js ahead of')
      return `${html.slice(0, at)}<script type="module" async src="${FIRST}"></script>\n${html.slice(at)}`
    },
  },
}

// The bundled packages' license notices ship whole, except the contact addresses beside a holder's name: a published file
// carries no one's email, and the holder, the year and the license text are the notice. The note says where the addresses are.
const LICENSES = 'assets/licenses.md'
const noticesNoEmail = {
  name: 'trocar-notices-no-email',
  generateBundle: {
    order: 'post',
    handler(_, bundle) {
      const a = bundle[LICENSES]
      if (!a) throw new Error(`${LICENSES}: not in the bundle`)
      a.source = String(a.source).replace(/ ?<[^<>\s@]+@[^<>\s]+>/g, '')
        .replace(/\n\n/, '\n\nContact addresses are left out of the notices below; each package\'s own license file has them.\n\n')
    },
  },
}

// The harness icons (D76) live beside the registry in src/off/harness-icons/; every file there but its SOURCES.md ships at
// assets/harness/<file>, byte for byte, which is where core/chips.mjs harnessIconUrl() points.
const ICONS = new URL('../src/off/harness-icons/', import.meta.url)
const harnessIcons = {
  name: 'trocar-harness-icons',
  generateBundle() {
    for (const f of fs.readdirSync(ICONS).filter((f) => f !== 'SOURCES.md').sort())
      this.emitFile({ type: 'asset', fileName: 'assets/harness/' + f, source: fs.readFileSync(new URL(f, ICONS)) })
  },
}

export default {
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  publicDir: 'public',
  plugins: [react(), firstAhead, noticesNoEmail, harnessIcons],
  build: {
    outDir: fileURLToPath(new URL('../src/web/board/', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    cssMinify: false,
    license: { fileName: LICENSES },
    rolldownOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        first: fileURLToPath(new URL('./legacy/core/first.mjs', import.meta.url)),
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
}
