// markdown.test.tsx — the Readable markdown (2.3 #37, #17): what the rules leave as written, which links are links, the tag lines, and
// that the slices of a document are the document.
import { describe, expect, it } from 'vitest'
import { check } from '../../../../test/helpers/cell-html.mjs'
import { renderKind } from '../../../legacy/replay/kinds.mjs'
import { draw } from './markdown.mjs'

const whole = (src: string, file = false) => draw(src, { from: 0, budget: Infinity, file }).html
const dom = (src: string, file = false) => { const d = document.createElement('div'); d.innerHTML = whole(src, file); return d }
const slices = (src: string, budget: number) => {
  const out: { html: string, from: number }[] = []
  for (let from: number | null = 0; from != null;) {
    const s: { html: string, more: number | null } = draw(src, { from, budget, file: false })
    out.push({ html: s.html, from })
    expect(s.more === null || s.more > from).toBe(true)
    from = s.more
  }
  return out
}

describe('what the source wrote stays', () => {
  it('leaves backslashes, entities, a line above ---, an indented line and a definition line as words', () => {
    for (const src of ['a \\"b\\" \\\\d \\*e', 'x &gt; y &amp; z &#65;', '    indented line', '[1]: http://x.io/a "t"']) expect(dom(src).textContent).toContain(src.trim())
    const above = dom('Title\n---')
    expect(above.querySelector('h1,h2')).toBeNull()
    expect(above.textContent).toContain('Title')
    expect(dom('    indented line').querySelector('pre')).toBeNull()
  })
  it('numbers each list item as the source did', () => {
    expect([...dom('1. a\n7. b\n').querySelectorAll('li')].map((li) => li.getAttribute('value'))).toEqual(['1', '7'])
    expect([...dom('3. a\n\n   x\n\n9. b\n').querySelectorAll('ol > li')].map((li) => li.getAttribute('value'))).toEqual(['3', '9'])
  })
  it('draws html in the source as text', () => {
    const d = dom('a <b onclick="x">c</b> d\n\n<div>\nline two\n</div> tail')
    expect(d.querySelector('b,[onclick]')).toBeNull()
    expect(d.textContent).toContain('<b onclick="x">c</b>')
  })
  it('makes bold out of Chinese text that ends in punctuation', () => {
    expect(dom('**根因：**服务端').querySelector('strong')?.textContent).toBe('根因：')
  })
  it('breaks lines as written in messages and leaves them to the paragraph in files, whichever is read first', () => {
    const src = 'one\ntwo'
    expect(dom(src).querySelector('br')).not.toBeNull()
    expect(dom(src, true).querySelector('br')).toBeNull()
    expect(dom(src).querySelector('br')).not.toBeNull()
  })
})

describe('links, images, tables', () => {
  it('links only to absolute http, https and mailto, and keeps the words of every other link', () => {
    for (const url of ['http://x.io/a', 'https://x.io/a?b=1', 'mailto:a@x.io', 'HTTPS://X.IO']) {
      const a = dom(`see [the words](${url})`).querySelector('a')
      expect(a?.getAttribute('href')).toBe(url)
      expect(a?.getAttribute('target')).toBe('_blank')
      expect(a?.getAttribute('rel')?.split(' ').sort()).toEqual(['noopener', 'noreferrer'])
      expect(a?.getAttribute('title')).toBe(url)
    }
    for (const url of ['docs/a.md', '../a.md', '#/x', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', '//evil.io/a', 'file:///etc/passwd', 'data:text/html,x', 'http:x']) {
      const d = dom(`see [the words](${url}) and on`)
      expect(d.querySelector('a')).toBeNull()
      expect(d.querySelector('.md-link')?.textContent).toBe('the words')
      expect(d.querySelector('.md-link')?.getAttribute('title')).toBe(url)
      expect(d.textContent).toContain('see the words and on')
    }
  })
  it('links a bare URL with a scheme and nothing that only looks like one', () => {
    const d = dom('at https://x.io/a/%E4%B8%AD then')
    expect(d.querySelector('a')?.getAttribute('href')).toBe('https://x.io/a/%E4%B8%AD')
    expect(d.querySelector('a')?.textContent).toBe('https://x.io/a/%E4%B8%AD')
    for (const src of ['read CLAUDE.md first', 'a.io is up', 'mail a@x.io', 'javascript:alert(1)', 'www.x.io']) {
      expect(dom(src).querySelector('a')).toBeNull()
      expect(dom(src).textContent).toContain(src)
    }
  })
  it('shows an image as its alt and URL and loads nothing', () => {
    const d = dom('![the alt](https://x.io/a.png) and ![two](b.png)')
    expect(d.querySelector('img')).toBeNull()
    const seen = [...d.querySelectorAll('.md-img')].map((x) => x.textContent)
    expect(seen[0]).toContain('the alt')
    expect(seen[0]).toContain('https://x.io/a.png')
    expect(seen[1]).toContain('b.png')
  })
  it('aligns table cells by class inside .md-table', () => {
    const d = dom('| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |')
    expect(d.querySelector('.md-table table')).not.toBeNull()
    expect(d.querySelector('[style]')).toBeNull()
    const cells = [...d.querySelectorAll('tbody td')]
    expect(new Set(cells.map((c) => c.className)).size).toBe(3)
    expect([...d.querySelectorAll('thead th')].map((c) => c.className)).toEqual(cells.map((c) => c.className))
  })
})

describe('tag lines', () => {
  it('draws the two whole-line shapes as tags and keeps the attributes', () => {
    const line = dom('<system-reminder kind="a b">\nbody\n</system-reminder>')
    expect([...line.querySelectorAll('.md-tag')].map((x) => x.textContent)).toEqual(['<system-reminder kind="a b">', '</system-reminder>'])
    const pair = dom('<total_tokens>123</total_tokens>\n<task-id>a*b*c</task-id>').querySelectorAll('.md-tagv')
    expect(pair.length).toBe(2)
    expect(pair[0].querySelector('.md-tag')?.textContent).toContain('total_tokens')
    expect(pair[0].textContent).toContain('123')
    expect(pair[0].textContent).not.toContain('</total_tokens>')
    expect(pair[1].textContent).toContain('a*b*c')
  })
  it('leaves generics, inline tags and a tag with words after it alone', () => {
    for (const src of ['Foo<T>', 'a <b>c</b> d', '<a href="x">y</a> tail', '<T> is a param', '    <indented>']) {
      const d = dom(src)
      expect(d.querySelector('.md-tag,.md-tagv')).toBeNull()
      expect(d.textContent).toContain(src.trim())
    }
  })
  it('ends a paragraph, a list and a quote, so a closing tag stays out of them', () => {
    for (const src of ['text\n</wrap>', '- a\n- b\n</wrap>', '1. a\n</wrap>', '> a\n</wrap>', '| a |\n|---|\n| 1 |\n</wrap>']) {
      const tag = dom(src).querySelector('.md-tag')
      expect(tag?.textContent).toBe('</wrap>')
      expect(tag?.closest('p,li,blockquote,table')).toBeNull()
    }
    expect(dom('- a\n<k>v</k>').querySelector('.md-tagv')?.closest('li')).toBeNull()
  })
})

describe('slices', () => {
  const long = 'word '.repeat(3000).trim()
  const SHAPES = [
    'a paragraph\nof two lines', '# heading', '- a\n- b\n\n  still b\n- c', '1. one\n\n   ```\n   code\n   ```\n\n2. two', '```js\nlet a\n\nlet b\n```', '~~~\nnever closed',
    '| a | b |\n|---|---|\n| 1 | 2 |', '> quote\n>\n> more', '---', '<wrap kind="x">', '</wrap>', '<k>v **b**</k>', long, '\n\n\n', '    indented', '![a](b.png) [c](d)',
  ]
  const docs = [...SHAPES, ...SHAPES.flatMap((a, i) => SHAPES.map((b, j) => [a, b, SHAPES[(i + j) % SHAPES.length]].join('\n\n')))]
  it('joins into the whole document at every budget, each slice starting past the last and ending on a block', () => {
    for (const src of docs.flatMap((d) => [d, `\n\n${d}\n`, d.replace(/\n/g, '\r\n')])) {
      const all = whole(src)
      for (const budget of [1, 7, 40, 300, 20000]) expect(slices(src, budget).map((s) => s.html).join('')).toBe(all)
    }
  })
  it('spends the budget on whole blocks: one block past it is a slice of its own', () => {
    const para = (n: number) => `${String(n).repeat(40)}\n\n`
    const src = para(1) + para(2) + long + '\n\n' + para(3)
    const s = slices(src, 100)
    expect(s.map((x) => x.from)).toEqual([0, 84, 84 + long.length + 2])
    expect(s[1].html).toContain(long)
  })
  it('counts offsets in the source, CRLF included', () => {
    const src = 'a\r\n\r\nb\r\rc'
    expect(draw(src, { from: 0, budget: 1, file: false }).more).toBe(src.indexOf('b'))
  })
  it('has nothing to draw in an empty document', () => {
    expect(draw('', { from: 0, budget: 100, file: false })).toEqual({ html: '', more: null })
    expect(draw('\n \n', { from: 0, budget: 100, file: false })).toEqual({ html: '', more: null })
  })
})

it('is what kinds.mjs draws a markdown block with', () => {
  const out = renderKind({ as: 'markdown' }, '**a**', { from: 0, budget: 100 })
  expect(out.as).toBe('markdown')
  expect(out.html).toContain('<strong>a</strong>')
})

it('emits only the allowed markup for hostile text (2.3 #17)', () => {
  const BAD = ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', 'javascript:alert(1)', '"><svg onload=x>', '</pre></div>', '\u0000\u0001\u001b[31m \u007f', '&lt;script&gt;', "' onmouseover='x", '`']
  const FORMS = (x: string) => [x, `# ${x}`, `- ${x}`, `1. ${x}`, `> ${x}`, `**${x}**`, `\`${x}\``, `[${x}](${x})`, `[a](<${x}>)`, `[a](http://x.io/${x})`, `[a](http://x.io "${x}")`, `![${x}](${x})`, `![a](http://x.io/${x})`,
    `\`\`\`${x}\n${x}\n\`\`\``, `| ${x} | b |\n|---|---|\n| c | ${x} |`, `<${x}>`, `<k ${x}>`, `<k>${x}</k>`, `<a b="${x}">`, `https://x.io/${x}`]
  for (const x of BAD) for (const src of FORMS(x)) for (const file of [false, true]) {
    const { html } = draw(src, { from: 0, budget: 20000, file })
    check(html, JSON.stringify(src))
    const d = document.createElement('div')
    d.innerHTML = html
    for (const a of d.querySelectorAll('a')) expect(a.protocol).toMatch(/^(?:https?|mailto):$/)
  }
})
