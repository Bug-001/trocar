// web/vite.config.mjs — builds the board (web/) into the committed src/web/board/, which the daemon serves (4.4 §静态面, D75).
// Fixed names, no hashes: the build is committed and a rebuild of unchanged sources is byte-identical. CSS is not minified, so the
// cascade the hand-written sheets define is the one the page gets.
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

export default {
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  publicDir: 'public',
  plugins: [react(), firstAhead],
  build: {
    outDir: fileURLToPath(new URL('../src/web/board/', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    cssMinify: false,
    license: { fileName: 'assets/licenses.md' },
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
