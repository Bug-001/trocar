// Spec 2.4 #11, pure half: one file's spellings inside one shell command resolve to one path, and a
// path that needs the run to be known stays as written with a closed-set runtime code. The axes are
// generated; the real-shaped seeds at the end carry expected values written from the rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBashReads } from '../../src/dissect/shell-reads.mjs';


// the verbs that read, each with the range it means
const READERS = [
  ['cat', 'full file'], ['nl', 'full file'], ['/usr/bin/less', 'full file'],
  ['head -n 7', 'L1–7'], ['head -7', 'L1–7'], ['tail -n 7', 'tail 7'], ['tail -7', 'tail 7'],
  ["sed -n '3,9p'", 'L3–9'], ['sed -n 3,9p', 'L3–9'],
];
const TARGETS = [['/data/run/logs', 'a.log'], ['/repo/spec', 'b.md'], ['/x', 'y.tar.gz'], ['/deep/er/still', 'noext/z']];

// every way of writing dir + base that the command itself settles
const SPELLINGS = (r, d, b) => [
  `${r} ${d}/${b}`,
  `${r} "${d}/${b}"`,
  `${r} '${d}/${b}'`,
  `${r} ${d}//./gone/../${b}`,
  `P=${d}; ${r} $P/${b}`,
  `P=${d}\n${r} $P/${b}`,
  `P="${d}"; ${r} "$P/${b}"`,
  `P=${d}; ${r} \${P}/${b}`,
  `P=${d}; ${r} "\${P}"/${b}`,
  `P=${d}; Q=$P/${b}; ${r} "$Q"`,
  ...['export', 'local', 'declare', 'readonly', 'typeset'].map((w) => `${w} P=${d}; ${r} $P/${b}`),
  `export A=1 P=${d}; ${r} $P/${b}`,
  `cd ${d} && ${r} ${b}`,
  `cd ${d}; ${r} ${b}`,
  `cd ${d}\n${r} ${b}`,
  `cd ${d} && ${r} ./${b}`,
  `(cd ${d} && ${r} ${b})`,
  `cd / && cd ${d.slice(1)} && ${r} ${b}`,
  `cd ${d}/gone && ${r} ../${b}`,
  `cd ${d} && ${r} $PWD/${b}`,
  `for f in ${b}; do ${r} ${d}/$f; done`,
  `for d in ${d}; do ${r} "$d/${b}"; done`,
  `for d in ${d}\ndo\n  ${r} $d/${b}\ndone`,
  `if true; then ${r} ${d}/${b}; fi`,
  `{ ${r} ${d}/${b}; }`,
  `LC_ALL=C ${r} ${d}/${b}`,
  `# ${r} /not/a.read\n${r} ${d}/${b}`,
  `${r} ${d}/${b} 2>/dev/null`,
  `${r} ${d}/${b} 2>&1 | grep -v x`,
];

test('every spelling of a target resolves to one path, with no runtime code and no $', () => {
  for (const [r, range] of READERS) {
    for (const [d, b] of TARGETS) {
      for (const cmd of SPELLINGS(r, d, b)) {
        assert.deepEqual(parseBashReads(cmd, { home: '/Users/u' }), [{ path: `${d}/${b}`, range }], cmd);
      }
    }
  }
});

test('real-shaped seeds', () => {
  assert.deepEqual(parseBashReads('P=/data/run; for f in a.log b.log; do tail -n 5 $P/logs/$f; done'), [
    { path: '/data/run/logs/a.log', range: 'tail 5' }, { path: '/data/run/logs/b.log', range: 'tail 5' },
  ]);
  assert.deepEqual(parseBashReads('cd /repo; sed -n 101,103p spec/a.md'), [{ path: '/repo/spec/a.md', range: 'L101–103' }]);
  const word = '~/x/logs/$(ls -t ~/x/logs | head -1)';
  for (const ctx of [{}, { home: '/Users/u' }]) {
    assert.deepEqual(parseBashReads(`tail -n 3 ${word}`, ctx), [{ path: word, range: 'tail 3', runtime: 'output' }]);
  }
});
