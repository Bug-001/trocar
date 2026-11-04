// Spec 2.4 #11, pure half: one file's spellings inside one shell command resolve to one path, and a
// path that needs the run to be known stays as written with a closed-set runtime code. The axes are
// generated; the real-shaped seeds at the end carry expected values written from the rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBashReads } from '../../src/dissect/shell-reads.mjs';

const RUNTIME = new Set(['output', 'read', 'earlier', 'cwd']);
const paths = (cmd, ctx) => parseBashReads(cmd, ctx).map((r) => r.path);

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

test('~ and $HOME are one spelling: the home when known, ~/rest when not', () => {
  const HOME_SPELLINGS = (d, b) => [
    `cat ~/${d}/${b}`, `cat $HOME/${d}/${b}`, `cat \${HOME}/${d}/${b}`, `cat "$HOME/${d}/${b}"`,
    `P=~/${d}; cat $P/${b}`, `P=$HOME/${d}; cat "$P/${b}"`, `export P="$HOME/${d}"; cat $P/${b}`,
    `cd ~/${d} && cat ${b}`, `cd $HOME/${d}; cat ${b}`, `(cd "$HOME/${d}" && cat ${b})`,
    `cd && cat ${d}/${b}`, `cd ~; cat ${d}/${b}`, `for f in ${b}; do cat ~/${d}/$f; done`,
    `cat ~/${d}/gone/../${b}`,
  ];
  for (const [d, b] of [['x/logs', 'a.log'], ['.config/tool', 'settings.json']]) {
    for (const cmd of HOME_SPELLINGS(d, b)) {
      for (const [ctx, want] of [
        [{ home: '/Users/u' }, `/Users/u/${d}/${b}`],
        [{ home: '/home/u' }, `/home/u/${d}/${b}`],
        [{}, `~/${d}/${b}`],
      ]) {
        assert.deepEqual(parseBashReads(cmd, ctx), [{ path: want, range: 'full file' }], cmd);
      }
    }
  }
  assert.deepEqual(paths('cat ~other/a.txt', { home: '/Users/u' }), ['~other/a.txt']);
  assert.deepEqual(paths('cat ~/a/b.txt', { home: 'C:\\Users\\u' }), ['C:\\Users\\u/a/b.txt']);
  assert.deepEqual(paths('cat ~/../v/b.txt', { home: '/Users/u' }), ['/Users/v/b.txt']);
});

test('a relative path stays as written with cwd, unless the command cds to an absolute directory', () => {
  for (const [cmd, word, tail] of [['cat a/b.txt', 'a/b.txt', 'a/b.txt'], ['cat ./b.txt', './b.txt', 'b.txt'], ['P=a/b.txt; cat $P', 'a/b.txt', 'a/b.txt']]) {
    assert.deepEqual(parseBashReads(cmd), [{ path: word, range: 'full file', runtime: 'cwd' }], cmd);
    assert.deepEqual(parseBashReads(`cd /c; ${cmd}`), [{ path: `/c/${tail}`, range: 'full file' }], cmd);
  }
  assert.deepEqual(parseBashReads('cd sub && cat ../b.txt').map((r) => r.runtime), ['cwd']);
  assert.deepEqual(parseBashReads('cd sub && cat b.txt').map((r) => [r.path, r.runtime]), [['sub/b.txt', 'cwd']]);
  // a caller's stated directory is no input: the same answer with one offered
  assert.deepEqual(parseBashReads('cat a/b.txt', { cwd: '/w' }).map((r) => [r.path, r.runtime]), [['a/b.txt', 'cwd']]);
});

// [the command, the word as it stands in the command with outer quotes off, the code]
const RUN_TIME = (r) => [
  [`${r} $(ls -t logs | head -1)`, '$(ls -t logs | head -1)', 'output'],
  [`${r} "$(ls -t 'a)b' | head -1)"`, `$(ls -t 'a)b' | head -1)`, 'output'],
  [`${r} logs/$(ls -t "$(pwd)/logs" | head -1).txt`, 'logs/$(ls -t "$(pwd)/logs" | head -1).txt', 'output'],
  [`${r} \`ls -t | head -1\``, '`ls -t | head -1`', 'output'],
  [`${r} /a/\`pick\`/b`, '/a/`pick`/b', 'output'],
  [`P=$(pick); ${r} $P/a.log`, '$P/a.log', 'output'],
  [`P=\`pick\`; ${r} "$P/a.log"`, '$P/a.log', 'output'],
  [`P=$(pick); Q=$P/x; ${r} $Q/a.log`, '$Q/a.log', 'output'],
  [`P=$(pick); ${r} \${P}`, '${P}', 'output'],
  [`${r} \${D:-/x}/a.log`, '${D:-/x}/a.log', 'output'],
  [`${r} \${D%/*}/a.log`, '${D%/*}/a.log', 'output'],
  [`${r} $?.log`, '$?.log', 'output'],
  [`for f in $(ls logs); do ${r} logs/$f; done`, 'logs/$f', 'output'],
  [`for f in \`ls\`; do ${r} "$f"; done`, '$f', 'output'],
  [`for f in logs/*.log; do ${r} $f; done`, '$f', 'output'],
  [`for f in $UNSET; do ${r} $f; done`, '$f', 'output'],
  [`cd $(pick) && ${r} a.log`, 'a.log', 'output'],
  [`cd "$(pick)"; ${r} a.log`, 'a.log', 'output'],
  [`cd $(pick) && cd sub; ${r} a.log`, 'a.log', 'output'],
  [`while read f; do ${r} "$f"; done`, '$f', 'read'],
  [`ls | while IFS= read -r f; do ${r} $f; done`, '$f', 'read'],
  [`read a b; ${r} $b/x.log`, '$b/x.log', 'read'],
  [`${r} $DIR/a.log`, '$DIR/a.log', 'earlier'],
  [`${r} \${DIR}/a.log`, '${DIR}/a.log', 'earlier'],
  [`${r} "$DIR"`, '$DIR', 'earlier'],
  [`${r} $DIR`, '$DIR', 'earlier'],
  [`${r} $1/a.log`, '$1/a.log', 'earlier'],
  [`P=$DIR; ${r} $P/a.log`, '$P/a.log', 'earlier'],
  [`cd $DIR && ${r} a.log`, 'a.log', 'earlier'],
];

test('a run-time form keeps its word byte for byte, with the expected code, whatever the context', () => {
  for (const r of ['cat', 'tail -n 3', 'head -3', "sed -n '1,2p'"]) {
    for (const [cmd, word, code] of RUN_TIME(r)) {
      for (const ctx of [{}, { home: '/Users/u' }]) {
        const got = parseBashReads(cmd, ctx);
        assert.deepEqual(got.map((x) => [x.path, x.runtime]), [[word, code]], cmd);
        assert.ok(RUNTIME.has(got[0].runtime));
      }
    }
  }
});

test('an unknown directory leaves absolute paths alone, and a known cd takes over from it', () => {
  assert.deepEqual(parseBashReads('cd $(pick) && cat /a/b.txt ~/c.txt', { home: '/h' }).map((r) => [r.path, r.runtime]),
    [['/a/b.txt', undefined], ['/h/c.txt', undefined]]);
  assert.deepEqual(parseBashReads('cd $(pick); cd /a; cat b.txt').map((r) => [r.path, r.runtime]), [['/a/b.txt', undefined]]);
  assert.deepEqual(parseBashReads('cd $(pick); cat $PWD/b.txt').map((r) => [r.path, r.runtime]), [['$PWD/b.txt', 'output']]);
  assert.deepEqual(parseBashReads('cat $PWD/b.txt').map((r) => [r.path, r.runtime]), [['$PWD/b.txt', 'cwd']]);
});

test('bounds: scope and order of the command decide, and what is not a read stays out', () => {
  // a subshell's cd and variables end at its close paren
  assert.deepEqual(paths('(cd /a && cat x.txt); cat y.txt'), ['/a/x.txt', 'y.txt']);
  assert.deepEqual(paths('cd /b; (cd /a; (cd /c); cat x.txt); cat y.txt'), ['/a/x.txt', '/b/y.txt']);
  assert.deepEqual(parseBashReads('(P=/a); cat $P/x.txt').map((r) => r.runtime), ['earlier']);
  // a later reassignment wins, also for the same word read twice
  assert.deepEqual(paths('P=/a; cat $P/x.txt; P=/b; cat $P/x.txt'), ['/a/x.txt', '/b/x.txt']);
  assert.deepEqual(parseBashReads('P=/a; P=$(pick); cat $P/x.txt').map((r) => r.runtime), ['output']);
  // a prefix assignment sets nothing for the words of its own command
  assert.deepEqual(parseBashReads('P=/a cat $P/x.txt').map((r) => r.runtime), ['earlier']);
  assert.deepEqual(parseBashReads('P=/a true; cat $P/x.txt').map((r) => r.runtime), ['earlier']);
  // single quotes are literal; a value with spaces does not become one invented path
  assert.deepEqual(parseBashReads(`cat '/a/$b.txt'`), [{ path: '/a/$b.txt', range: 'full file' }]);
  assert.deepEqual(parseBashReads('F="/a/x.txt /a/y.txt"; cat $F').map((r) => [r.path, r.runtime]), [['$F', 'output']]);
  // arithmetic is no assignment
  assert.deepEqual(parseBashReads('for ((i=1;i<3;i++)); do cat /a/$i.txt; done').map((r) => r.runtime), ['earlier']);
  // for runs its body per value, bounded; the loop variable keeps its last value
  assert.deepEqual(paths('for f in a.txt b.txt; do cat /d/$f; done; cat /e/$f'), ['/d/a.txt', '/d/b.txt', '/e/b.txt']);
  const many = Array.from({ length: 100 }, (_, i) => `f${i}.txt`).join(' ');
  assert.ok(paths(`for f in ${many}; do cat /d/$f; done`).length <= 64);
  assert.ok(paths(`for a in ${many}; do for b in ${many}; do cat /d/$a/$b; done; done`).length <= 4096);
  assert.deepEqual(parseBashReads('for a in 1 2; do '.repeat(30000)), []);
  assert.ok(paths(Array.from({ length: 5000 }, (_, i) => `cat /d/${i}.txt`).join('; ')).length <= 4096);

  const NOT_READS = [
    // heredoc lines are not commands, and the command after the terminator is
    `cat <<EOF\ncat /in/doc.txt\nEOF`, `cat > /out/a.md <<'EOF'\ncat /in/doc.txt\nEOF`, `python3 - <<-X\n\tcat /in/doc.txt\n\tX`,
    // writes are not reads
    'cat /a/x.txt > /b/y.txt', 'cat /a/x.txt >> /b/y.txt', 'cat /a/x.txt 1> /b/y.txt', 'cat /a/x.txt &> /b/y.txt',
    'cat /a/x.txt >/dev/null 2>&1', 'tail -n 2 /a/x.txt >/b/y.txt',
    // no reader, or a reader the command does not reach
    'ls /a/x.txt', 'echo "cat /a/x.txt"', 'grep x /a/y.txt', 'bash -c "cat /a/x.txt"', `ssh h 'cat /a/x.txt'`,
    'echo $(cat /a/x.txt)', 'P=$(cat /a/x.txt)', '# cat /a/x.txt', 'sed -i s/a/b/ /a/x.txt', 'sed s/a/b/ /a/x.txt',
    `sed -n '/a/p' /a/x.txt`,
    // words that are not paths
    'cat https://a.example/x.txt', 'cat /a/*.log', 'cat /a/{x,y}.txt', 'cat /a/?.txt', 'cat README', 'cat -n',
    'P=/a; cat $P/*.log', 'head -n $N', 'tail -c $(n)', 'xxd -l $N', '',
  ];
  for (const cmd of NOT_READS) assert.deepEqual(parseBashReads(cmd), [], cmd);
  assert.deepEqual(parseBashReads(undefined), []);

  assert.deepEqual(paths(`cat <<EOF\nnot a command\nEOF\ncat /a/x.txt`), ['/a/x.txt']);
  assert.deepEqual(paths(`cat <<'E'; cat /a/x.txt\ncat /in/doc.txt\nE\ncat /a/y.txt`), ['/a/x.txt', '/a/y.txt']);
  assert.deepEqual(paths('cat /a/x.txt 2>&1 >&2'), ['/a/x.txt']);
  assert.deepEqual(paths('cat /a/x.txt 2>/tmp/err'), ['/a/x.txt']);
  assert.deepEqual(paths('cat < /a/x.txt'), ['/a/x.txt']);
  assert.deepEqual(paths('cat /a/b\\ c.txt "/a/d e.txt"'), ['/a/b c.txt', '/a/d e.txt']);
  assert.deepEqual(paths(`sed -n '1,2p;/x/q' /a/x.txt`), ['/a/x.txt']);
  assert.deepEqual(paths('cat /a/x.txt && cat /b/y.txt || cat /c/z.txt & cat /d/w.txt | cat'), ['/a/x.txt', '/b/y.txt', '/c/z.txt', '/d/w.txt']);
  // a run-time word right after a two-character flag is that flag's value, for the commands that take one
  assert.deepEqual(paths('head -n $N /a/x.txt'), ['/a/x.txt']);
  assert.deepEqual(parseBashReads('head -n1 $F').map((r) => r.path), ['$F']);
  assert.deepEqual(parseBashReads('cat -n $F').map((r) => r.path), ['$F']);
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
