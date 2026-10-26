// Unit tests for server.properties parse/merge/validate — pure helpers, run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeProperties,
  parseProperties,
  safeLevelName,
  validateProperties,
} from '../../services/properties';
import { appError } from '../../services/store';

test('parseProperties: comments, blanks, CRLF and unknown keys are preserved as data', () => {
  const text = [
    '# comment',
    'motd=Hello=World',
    'max-players=20',
    'unknown-key=kept',
    '',
    'difficulty=hard',
  ].join('\r\n');
  const { entries, values } = parseProperties(text);
  assert.equal(values.motd, 'Hello=World');
  assert.equal(values['unknown-key'], 'kept');
  assert.equal(values.difficulty, 'hard');
  const unknown = entries.find((entry) => entry.key === 'unknown-key');
  assert.equal(unknown?.known, false);
  assert.equal(unknown?.kind, 'string');
  const maxPlayers = entries.find((entry) => entry.key === 'max-players');
  assert.equal(maxPlayers?.known, true);
  assert.equal(maxPlayers?.kind, 'int');
  assert.equal(maxPlayers?.min, 1);
  assert.equal(maxPlayers?.max, 1000);
});

test('parseProperties: a separator-less line is a key with an empty value (java.util.Properties)', () => {
  const { values } = parseProperties('no-equals-line\nempty=\n=novalue\n# x\n');
  assert.deepEqual(values, { 'no-equals-line': '', empty: '' });
});

test('mergeProperties: replaces only requested keys and preserves comments, order and unknown keys', () => {
  const original = '# header\nmotd=old\nunknown=keep-me\nmax-players=20\n';
  const merged = mergeProperties(original, { motd: 'new' });
  assert.match(merged, /^# header/m);
  assert.match(merged, /motd=new/);
  assert.match(merged, /unknown=keep-me/);
  assert.match(merged, /max-players=20/);
  assert.equal(merged.indexOf('motd=new') < merged.indexOf('unknown=keep-me'), true);
});

test('mergeProperties: appends missing keys and keeps the file newline style', () => {
  const merged = mergeProperties('motd=a\n', { difficulty: 'hard' });
  assert.equal(merged, 'motd=a\ndifficulty=hard\n');
  const noTrailing = mergeProperties('motd=a', { difficulty: 'hard' });
  assert.equal(noTrailing, 'motd=a\ndifficulty=hard');
});

test('mergeProperties: empty file writes all keys', () => {
  const merged = mergeProperties('', { motd: 'x', 'max-players': '10' });
  assert.equal(merged, 'motd=x\nmax-players=10\n');
});

test('validateProperties: accepts valid values and rejects each rule class with validation code', () => {
  validateProperties({
    'server-port': '25565',
    'max-players': '20',
    difficulty: 'hard',
    gamemode: 'creative',
    'online-mode': 'true',
    motd: 'hello',
  });
  const cases: Record<string, string>[] = [
    { 'server-port': '70000' },
    { 'max-players': 'not-a-number' },
    { difficulty: 'impossible' },
    { 'online-mode': 'yes' },
    { motd: 'x'.repeat(301) },
  ];
  for (const values of cases) {
    assert.throws(() => validateProperties(values), (error: unknown) => {
      return (error as { code?: string }).code === 'validation';
    });
  }
});

test('safeLevelName: rejects traversal/absolute names and falls back to world', () => {
  assert.equal(safeLevelName('my_world'), 'my_world');
  assert.equal(safeLevelName('..'), 'world');
  assert.equal(safeLevelName('../escape'), 'world');
  assert.equal(safeLevelName('C:\\x'), 'world');
  assert.equal(safeLevelName(''), 'world');
  assert.equal(safeLevelName(undefined), 'world');
});

test('appError: carries the code consumed by the IPC error envelope', () => {
  const error = appError('conflict', 'nope');
  assert.equal((error as { code?: string }).code, 'conflict');
  assert.equal(error.message, 'nope');
});

test('Java properties escapes: unicode, tabs, separators and line continuation (M-22)', () => {
  const { values } = parseProperties([
    'motd=\\u00a7aHello \\u00a7rWorld',
    'level-name=my\\ world',
    'tabbed=a\\tb',
    'continued=first\\',
    '   second',
    'colons=a\\:b',
  ].join('\n'));
  assert.equal(values.motd, '\u00a7aHello \u00a7rWorld');
  assert.equal(values['level-name'], 'my world');
  assert.equal(values.tabbed, 'a\tb');
  assert.equal(values.continued, 'firstsecond');
  assert.equal(values.colons, 'a:b');
});

test('mergeProperties escapes written values and preserves comments/unknown keys (M-22)', () => {
  const merged = mergeProperties('# head\nmotd=old\nunknown=keep\n', {
    motd: '§aHello\n"quoted" \\ backslash',
    'level-name': 'my world',
  });
  assert.match(merged, /^# head/m);
  assert.match(merged, /unknown=keep/);
  assert.match(merged, /motd=\\u00a7aHello\\n"quoted" \\\\ backslash/);
  assert.match(merged, /level-name=my world/);
  // Round-trip: parsing what we wrote returns the original values.
  const roundTrip = parseProperties(merged).values;
  assert.equal(roundTrip.motd, '§aHello\n"quoted" \\ backslash');
  assert.equal(roundTrip['level-name'], 'my world');
});

test('mergeProperties keeps CRLF line endings when appending missing keys (M-22)', () => {
  const merged = mergeProperties('motd=a\r\n', { difficulty: 'hard' });
  assert.equal(merged, 'motd=a\r\ndifficulty=hard\r\n');
  const noTrailing = mergeProperties('motd=a\r\nmax-players=20', { difficulty: 'hard' });
  assert.equal(noTrailing, 'motd=a\r\nmax-players=20\ndifficulty=hard');
});

