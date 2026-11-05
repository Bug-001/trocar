// src/dissect/shell-reads.mjs — the files one shell command reads, with their real paths (spec 2.4,
// fidelity boundary items 6 and 7). A small lexer into simple commands plus a sequential interpreter that
// tracks what the command itself settles: literal variables, the current directory, `for` values.
// Not a shell: anything the run decides stays exactly as written, with a closed-set `runtime` code
// (output · read · earlier · cwd). Paths are never invented. Pure leaf: no I/O, nothing imported.

// Which words of a command are its files; 2.4 fidelity boundary item 7 is the boundary. takes: short flags followed by a value ·
// long: long flags and how many words they take · script: the first operand is no file, unless a flag matching `given` carries it ·
// max: how many operands are files · need / not: a flag that makes it a read / keeps it from being one · ranges: [pattern on the joined line, label] · range: else this.
const LINES = { takes: 'nc', long: { '--lines': 1, '--bytes': 1 } }, LINE_COUNT = /(?:^| )(?:-n? ?|--lines[= ])(\d+)\b/, BYTE_COUNT = /(?:^| )(?:-c ?|--bytes[= ])(\d+)\b/;
const SED_N = '(?:^| )-[a-zA-Z]*n[a-zA-Z]*(?: -[a-zA-Z]+)* ?';
const READS = {
  cat: {}, tac: {}, more: {}, less: { takes: 'p' },
  nl: { takes: 'bdfhilnpsvw' }, bat: { takes: 'lrHm', long: { '--line-range': 1, '--language': 1, '--style': 1 } },
  xxd: { takes: 'cglos', max: 1 }, od: { takes: 'AjNStw' }, strings: { takes: 'nte' },
  head: { ...LINES, ranges: [[LINE_COUNT, 'L1–$1'], [BYTE_COUNT, 'first $1 bytes']] },
  tail: { ...LINES, ranges: [[LINE_COUNT, 'tail $1'], [BYTE_COUNT, 'last $1 bytes']] },
  sed: { script: true, given: /^-[a-zA-Z]*[ef]$|^--(expression|file)/, takes: 'efl', long: { '--expression': 1, '--file': 1 }, need: /^-[a-zA-Z]*n|^--(quiet|silent)$/, not: /^-[a-zA-Z]*i|^--in-place/, range: 'matching lines',
    ranges: [[/(?:^| )-[a-zA-Z]*e .* -[a-zA-Z]*e /, 'matching lines'], [new RegExp(`${SED_N}(\\d+),(\\d+)\\s*p(?: |$)`), 'L$1–$2'], [new RegExp(`${SED_N}(\\d+)\\s*p(?: |$)`), 'L$1']] },
  grep: { script: true, given: /^-[a-zA-Z]*[ef]$|^--(regexp|file)/, takes: 'ABCDdefm', long: { '--regexp': 1, '--file': 1, '--context': 1, '--after-context': 1, '--before-context': 1, '--max-count': 1, '--include': 1, '--exclude': 1, '--exclude-dir': 1 },
    not: /^-[a-zA-Z]*[rRlLcq]|^--(recursive|dereference-recursive|files-with-matches|files-without-match|count|quiet|silent)/, range: 'matching lines' },
  awk: { script: true, given: /^-[a-zA-Z]*f$|^--file/, takes: 'Ffv', long: { '--file': 1 }, range: 'filtered' },
  jq: { script: true, given: /^-[a-zA-Z]*f$|^--from-file/, takes: 'fL', long: { '--from-file': 1, '--arg': 2, '--argjson': 2, '--slurpfile': 2, '--rawfile': 2, '--argfile': 2, '--indent': 1 }, range: 'filtered' },
};
// commands that run the command behind them; operands: their own, before it
const PREFIX = { sudo: { takes: 'ugUCDhprtT', long: { '--user': 1, '--group': 1 } }, env: { takes: 'uCS', long: { '--unset': 1, '--chdir': 1 } }, time: { takes: 'fo' }, nohup: {}, nice: { takes: 'n' },
  timeout: { takes: 'ks', operands: 1, long: { '--signal': 1, '--kill-after': 1 } } };
const rowOf = (table, name) => (Object.hasOwn(table, name) ? table[name] : null); // a command can be called `constructor`
const DECLARE = /^(export|local|declare|readonly|typeset)$/;
const KEYWORDS = new Set(['while', 'until', 'if', 'elif', 'do', 'then', 'else', 'fi', 'done', '{', '}', '!']);
const GLOB = /[*?{}[\]]/;
const NAME = /^[A-Za-z_]\w*$/;
const ASSIGN = /^([A-Za-z_]\w*)(\+?)=/;
const BREAK = /[\s;&|()<>]/;
const REDIRECT = /(\d*)(&>>|&>|<<<|<<-|<<|>>|>&|>\||<&|<>|>|<)/y;
const VAR = /[A-Za-z_]\w*/y;
const MARK = '\0'; // stands for the home directory inside values, so `..` resolves once it is known
const ROOTED = /^(?:[/\0]|~[^/]|[A-Za-z]:[\\/])/;
const MAX_LOOP = 64; // values of one `for`, and `for`s inside one another
const MAX_STEPS = 4096; // what a loop's expansion may walk, and the reads one command may give: a literal list stays whole below it

// The index just past the construct opened right before i: `(`, `{` (of `${`), `"` or a backtick.
// A stack, not recursion: captured commands can nest as deep as they like.
function closeOf(s, i, open) {
  const stack = [open];
  for (; i < s.length && stack.length; i++) {
    const c = s[i];
    const top = stack[stack.length - 1];
    if (c === '\\') i++;
    else if (top === '`') { if (c === '`') stack.pop(); }
    else if (s.startsWith('$(', i) || s.startsWith('${', i)) stack.push(s[++i]);
    else if (c === '`') stack.push(c);
    else if (top === '"') { if (c === '"') stack.pop(); }
    else if (c === '"') stack.push(c);
    else if (c === "'") { i = s.indexOf("'", i + 1); if (i < 0) return s.length; }
    else if (c === '(' && top === '(') stack.push(c);
    else if ((c === ')' && top === '(') || (c === '}' && top === '{')) stack.pop();
  }
  return Math.min(i, s.length);
}

// One word from i: { raw, quotes, parts, end }. A part is { lit, q }, { name, q } or { why }.
function lexWord(s, i) {
  const start = i;
  const parts = [];
  let quotes = 0;
  const lit = (text, q) => {
    const last = parts[parts.length - 1];
    if (last?.lit !== undefined && last.q === q) last.lit += text;
    else parts.push({ lit: text, q });
  };
  const expansion = (j, q) => { // the $… or backtick at j; returns the index past it
    if (s[j] === '`') { parts.push({ why: 'output' }); return closeOf(s, j + 1, '`'); }
    if (s[j + 1] === '(') { parts.push({ why: 'output' }); return closeOf(s, j + 2, '('); }
    if (s[j + 1] === '{') {
      const end = closeOf(s, j + 2, '{');
      const name = s.slice(j + 2, end - 1);
      parts.push(NAME.test(name) ? { name, q } : { why: 'output' });
      return end;
    }
    VAR.lastIndex = j + 1;
    const m = VAR.exec(s);
    if (m) { parts.push({ name: m[0], q }); return j + 1 + m[0].length; }
    if (/[0-9@*#]/.test(s[j + 1] ?? '')) { parts.push({ why: 'earlier' }); return j + 2; }
    if (/[?$!-]/.test(s[j + 1] ?? '')) { parts.push({ why: 'output' }); return j + 2; }
    lit('$', q);
    return j + 1;
  };
  while (i < s.length && !BREAK.test(s[i])) {
    const c = s[i];
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      lit(s.slice(i + 1, end < 0 ? s.length : end), true);
      quotes++;
      i = end < 0 ? s.length : end + 1;
    } else if (c === '"') {
      quotes++;
      for (i++; i < s.length && s[i] !== '"';) {
        if (s[i] === '\\' && '$`"\\\n'.includes(s[i + 1] ?? ' ')) { if (s[i + 1] !== '\n') lit(s[i + 1], true); i += 2; }
        else if (s[i] === '$' || s[i] === '`') i = expansion(i, true);
        else lit(s[i++], true);
      }
      i++;
    } else if (c === '\\') {
      if (s[i + 1] !== '\n') lit(s[i + 1] ?? '', true);
      i += 2;
    } else if (c === '$' || c === '`') i = expansion(i, false);
    else { lit(c, false); i++; }
  }
  const end = Math.min(i, s.length);
  return { raw: s.slice(start, end), quotes, parts, end };
}

// The command as simple commands in order: { words, redirs }, with { paren } items between them.
function lex(s) {
  const items = [];
  const heredocs = [];
  let cur = { words: [], redirs: [] };
  const flush = () => {
    if (cur.words.length || cur.redirs.length) items.push(cur);
    cur = { words: [], redirs: [] };
  };
  const skipHeredocs = (i) => {
    for (const { end, tabs } of heredocs.splice(0)) {
      while (i < s.length) {
        const nl = s.indexOf('\n', i) < 0 ? s.length : s.indexOf('\n', i);
        const line = s.slice(i, nl);
        i = nl + 1;
        if ((tabs ? line.replace(/^\t+/, '') : line) === end) break;
      }
    }
    return i;
  };
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '\n') { flush(); i = skipHeredocs(i + 1); continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '\\' && s[i + 1] === '\n') { i += 2; continue; }
    if (c === '#') { const nl = s.indexOf('\n', i); i = nl < 0 ? s.length : nl; continue; }
    REDIRECT.lastIndex = i;
    const r = REDIRECT.exec(s);
    if (r) {
      i += r[0].length;
      while (s[i] === ' ' || s[i] === '\t') i++;
      const w = lexWord(s, i);
      i = w.end;
      if (r[2] === '<<' || r[2] === '<<-') heredocs.push({ end: w.parts.map((p) => p.lit ?? '').join(''), tabs: r[2] === '<<-' });
      cur.redirs.push({ fd: r[1], op: r[2], w });
    } else if (';&|'.includes(c)) { flush(); i++; }
    else if (s.startsWith('((', i)) { // arithmetic: one run-time word, so `i=1` inside it assigns nothing
      const end = closeOf(s, i + 1, '(');
      cur.words.push({ raw: s.slice(i, end), quotes: 0, parts: [{ why: 'output' }] });
      i = end;
    } else if (c === '(' || c === ')') { flush(); items.push({ paren: c }); i++; }
    else { const w = lexWord(s, i); cur.words.push(w); i = w.end; }
  }
  flush();
  return items;
}

function assignment(word) {
  const first = word.parts[0];
  const m = first?.lit !== undefined && !first.q && ASSIGN.exec(first.lit);
  return m ? { name: m[1], append: m[2] === '+', parts: [{ lit: first.lit.slice(m[0].length), q: false }, ...word.parts.slice(1)] } : null;
}

const firstOf = (item) => item.words?.[0]?.raw;

// A flag word by its row: `name`, and `value` the words it takes after it. A short cluster reads left to right and the first letter
// that takes a value ends it: `-A3` and `-vn=f` carry their value. `--x=y` does too, so it takes none.
function flagOf(word, { takes = '', long = {} }) {
  if (word[0] !== '-' || word[1] === '-') return { name: word, value: Object.hasOwn(long, word) ? long[word] : 0 };
  let at = 1;
  while (at < word.length && !takes.includes(word[at])) at++;
  return { name: word.slice(0, at + 1), value: at === word.length - 1 ? 1 : 0 };
}

// the word as the command spells it, outer quotes off
function writtenOf({ raw, quotes }) {
  return quotes === 1 && raw.length > 1 && `'"`.includes(raw[0]) && raw[raw.length - 1] === raw[0] ? raw.slice(1, -1) : raw;
}

// stdout into a file: `>`, `>>`, `1>`, `&>`. A descriptor target (`>&2`) is no file.
const isWrite = ({ fd, op, w }) => op[0] === '&' || (op[0] === '>' && (!fd || fd === '1') && !(op === '>&' && /^(\d+|-)$/.test(w.raw)));

export function parseBashReads(command, { home = null } = {}) {
  if (!command || typeof command !== 'string') return [];
  const items = lex(command);
  const out = [];
  const stack = [];
  const doneOf = new Map(); // item of each `do` → item of its `done`
  let vars = new Map([['HOME', { v: MARK }]]);
  let dir = null; // the in-command directory: a value, relative while the command only `cd`s relatively
  let lost = null; // the runtime code once a `cd` went somewhere unknown
  let steps = 0;
  let nesting = 0;
  // a relative value on the in-command directory: known once that directory is absolute
  const against = (rel) => {
    if (lost) return { why: lost };
    const full = [dir, rel].filter(Boolean).join('/');
    return ROOTED.test(full) ? { v: full } : { why: 'cwd', rel: full };
  };

  // { v } when the command settles the word, { why } when the run does
  const expand = (parts) => {
    let v = '';
    for (const [k, p] of parts.entries()) {
      if (p.why) return { why: p.why };
      if (p.lit !== undefined) {
        v += k === 0 && !p.q && /^~(\/|$)/.test(p.lit) ? MARK + p.lit.slice(1) : p.lit;
        continue;
      }
      const x = p.name === 'PWD' ? against('') : vars.get(p.name) ?? { why: 'earlier' };
      if (x.why) return x;
      if (!p.q && /\s/.test(x.v)) return { why: 'output' }; // the shell splits it: no longer this one word
      v += x.v;
    }
    return { v };
  };

  // normalise under the first segment, which `..` never climbs out of
  const finish = (v) => {
    const full = v[0] === MARK ? (home || '~') + v.slice(1) : v;
    const cut = full.indexOf('/');
    const root = cut < 0 ? full : full.slice(0, cut);
    const segments = [];
    for (const part of (cut < 0 ? '' : full.slice(cut)).split('/')) {
      if (part === '..') segments.pop();
      else if (part && part !== '.') segments.push(part);
    }
    return `${root}/${segments.join('/')}`.replace(/(.)\/$/, '$1');
  };

  const locate = ({ v, why, text }) => {
    const x = why ? { why } : ROOTED.test(v) ? { v } : against(v);
    if (x.v !== undefined) return { path: finish(x.v) };
    return { path: x.rel ?? text, runtime: x.why };
  };

  const view = (word) => ({ ...expand(word.parts), text: writtenOf(word) });

  const said = (word) => { const { v, text } = view(word); return v ?? text; };

  // words from `from` as flags and operands, stopping at the operand past `limit`: `next` is where it stopped
  const walk = (words, from, row, limit = Infinity) => {
    const flags = [];
    const operands = [];
    let ended = false; // `--` ends the flags
    let k = from;
    for (; k < words.length; k++) {
      const word = said(words[k]);
      if (!ended && word === '--') ended = true;
      else if (!ended && /^[-+]/.test(word)) {
        const flag = flagOf(word, row);
        flags.push(flag);
        k += flag.value;
      } else if (operands.length === limit) break;
      else operands.push(words[k]);
    }
    return { flags, operands, next: k };
  };

  const readsOf = (name, args, inputs) => {
    const row = rowOf(READS, name);
    if (!row) return;
    const { flags, operands } = walk(args, 0, row);
    if (row.need && !flags.some((f) => row.need.test(f.name))) return;
    if (row.not && flags.some((f) => row.not.test(f.name))) return;
    const line = args.map(said).join(' ');
    const hit = row.ranges?.find(([re]) => re.test(line));
    const range = hit ? line.match(hit[0])[0].replace(hit[0], hit[1]) : row.range ?? 'full file';
    const scripted = row.script && !flags.some((f) => row.given.test(f.name));
    for (const word of [...operands.slice(scripted ? 1 : 0, row.max), ...inputs]) {
      const w = view(word);
      const spelled = w.v ?? w.text;
      if (!spelled || /^https?:/i.test(spelled) || (!w.why && GLOB.test(spelled))) continue;
      if (out.length < MAX_STEPS) out.push({ ...locate(w), range });
    }
  };

  const nameOf = (word) => word && expand(word.parts).v?.split('/').pop();

  // the index of the command behind the prefixes at k
  const pastPrefixes = (words, k) => {
    for (let row; (row = rowOf(PREFIX, nameOf(words[k])));) {
      k = walk(words, k + 1, row, row.operands ?? 0).next;
      while (k < words.length && assignment(words[k])) k++;
    }
    return k;
  };

  const assign = ({ name, append, parts }) => vars.set(name, append ? { why: 'output' } : expand(parts));

  const changeDir = (args) => {
    const word = args.find((w) => !/^-./.test(w.raw));
    const x = word ? expand(word.parts) : { v: MARK };
    if (x.why || x.v === '-') lost = x.why ?? 'earlier'; // `cd -` goes to a directory set before this command
    else if (ROOTED.test(x.v)) { dir = x.v; lost = null; }
    else if (!lost) dir = dir ? `${dir}/${x.v}` : x.v;
  };

  const simple = (words, redirs) => {
    let k = 0;
    const sets = [];
    for (let a; k < words.length && (a = assignment(words[k])); k++) sets.push(a);
    if (k === words.length) { sets.forEach(assign); return; } // with a command after them they are its environment only
    const [head, ...args] = words.slice(k);
    if (head.raw === 'cd') changeDir(args);
    else if (DECLARE.test(head.raw)) args.map(assignment).filter(Boolean).forEach(assign);
    else if (head.raw === 'read') { for (const w of args) if (NAME.test(w.raw)) vars.set(w.raw, { why: 'read' }); }
    else if (!redirs.some(isWrite)) {
      const at = pastPrefixes(words, k);
      readsOf(nameOf(words[at]), words.slice(at + 1), redirs.filter((r) => r.op === '<').map((r) => r.w));
    }
  };

  // the `for` at item `at`: the body once per literal value, or once with the variable unknown
  const loop = (at, [name, keyword, ...list]) => {
    let open = at + 1;
    while (open < items.length && firstOf(items[open]) !== 'do') open++;
    const end = doneOf.get(open) ?? items.length;
    if (nesting === MAX_LOOP) return end;
    const values = keyword?.raw === 'in' ? list.map((w) => expand(w.parts)) : [{ why: 'output' }];
    const literal = values.every((x) => !x.why && !GLOB.test(x.v));
    for (const x of literal ? values.slice(0, MAX_LOOP) : [{ why: 'output' }]) {
      vars.set(name?.raw, x);
      nesting++;
      run(at + 1, end);
      nesting--;
    }
    return end;
  };

  const open = [];
  items.forEach((item, i) => {
    if (firstOf(item) === 'do') open.push(i);
    else if (firstOf(item) === 'done' && open.length) doneOf.set(open.pop(), i);
  });

  const run = (from, to) => {
    for (let i = from; i < to; i++) {
      if (out.length >= MAX_STEPS || ++steps > MAX_STEPS) return;
      const { paren, words, redirs } = items[i];
      if (paren === '(') stack.push({ vars: new Map(vars), dir, lost });
      else if (paren === ')') { if (stack.length) ({ vars, dir, lost } = stack.pop()); }
      else {
        let k = 0;
        while (k < words.length && KEYWORDS.has(words[k].raw)) k++;
        if (words[k]?.raw === 'for') i = loop(i, words.slice(k + 1));
        else simple(words.slice(k), redirs);
      }
    }
  };

  run(0, items.length);
  return out;
}
