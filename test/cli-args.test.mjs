import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, VALUED_FLAGS } from '../src/cli-args.mjs';

// A FLAG'S VALUE IS NOT A POSITIONAL ARGUMENT.
//
// The CLI's positional() was `rest.find(a => !a.startsWith('--'))` — the first argument that isn't
// a flag NAME. The value of every valued flag qualifies. Observed live: `asight shard --watch
// --interval 10` treated "10" as the capture path and the watcher sat there printing
// "no such capture: 10" every ten seconds while the real capture grew unsharded.
//
// The same bug is latent in every other subcommand that mixes a positional with a valued flag:
// `asight etl --db /tmp/x.db` hands "/tmp/x.db" to etlFile as the SOURCE, i.e. it would try to
// ingest the database it was told to write. Nothing catches that today.
//
// Parsing has to know which flags take a value. It cannot be inferred: `--rebuild file.ndjson` and
// `--db file.db` are the same shape and mean opposite things.

test('a valued flag consumes its value, so it is not seen as positional', () => {
  const a = parseArgs(['--watch', '--interval', '10']);
  assert.equal(a.positional(), undefined,
    "a flag's value was returned as a positional argument — this is the bug that made the shard "
    + 'watcher poll a file named "10"');
  assert.equal(a.flag('--interval'), '10');
  assert.equal(a.bool('--watch'), true);
});

test('a boolean switch does NOT swallow the argument after it', () => {
  const a = parseArgs(['--rebuild', 'capture.ndjson']);
  assert.equal(a.positional(), 'capture.ndjson',
    'a boolean switch consumed the real positional — the opposite failure, equally silent');
  assert.equal(a.bool('--rebuild'), true);
});

test('the positional is found wherever it sits', () => {
  for (const argv of [
    ['capture.ndjson', '--db', 'x.db'],
    ['--db', 'x.db', 'capture.ndjson'],
    ['--rebuild', '--db', 'x.db', 'capture.ndjson'],
  ]) {
    assert.equal(parseArgs(argv).positional(), 'capture.ndjson', `argv: ${argv.join(' ')}`);
  }
});

test('the real reported invocation parses correctly', () => {
  const a = parseArgs(['--watch', '--interval', '10']);
  assert.equal(a.positional() ?? '(default)', '(default)');
  assert.equal(a.flag('--interval', 5), '10');
});

test('etl no longer mistakes its output database for its input', () => {
  const a = parseArgs(['--db', '/tmp/out.db', '--rebuild']);
  assert.equal(a.positional(), undefined,
    'etl would have ingested the database it was asked to write into');
  assert.equal(a.flag('--db'), '/tmp/out.db');
});

test('a valued flag at the end of argv does not read past the array', () => {
  const a = parseArgs(['--port']);
  assert.equal(a.flag('--port', 9810), true, 'a bare valued flag keeps the legacy true sentinel');
  assert.equal(a.positional(), undefined);
});

test('every flag the CLI reads with a value is declared', () => {
  // The declaration is the whole mechanism; a flag missing from it silently reintroduces the bug
  // for that one command. This pins the list so adding a flag without declaring it is caught here
  // rather than by a user watching a watcher poll nothing.
  for (const f of ['--interval', '--db', '--file', '--out', '--port', '--source', '--target',
    '--host', '--proxy', '--upstream', '--capture-target', '--sessions', '--quiet', '--against', '--tail']) {
    assert.ok(VALUED_FLAGS.has(f), `${f} takes a value but is not declared`);
  }
  for (const b of ['--watch', '--rebuild', '--control', '--raw-sse', '--remove-ca', '--no-autostart', '--legacy', '--delete-original', '--dry-run']) {
    assert.ok(!VALUED_FLAGS.has(b), `${b} is a boolean switch but is declared as valued`);
  }
});
