'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LogParser, ArtifactScanner, resolveRoot, artifactId, addToRegistry, readRegistry } = require('../lib/artifacts');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-art-'));
const call = (id, input, cwd = '/work/proj') => ({ cwd, message: { content: [{ type: 'tool_use', name: 'Artifact', id, input }] } });
const result = (id, toolUseResult, extra = {}) => ({
  timestamp: '2026-10-22T10:00:00.000Z', toolUseResult,
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Updated the Artifact', ...extra }] },
});

test('artifactId takes the last segment of either URL form', () => {
  assert.strictEqual(artifactId('https://claude.ai/artifact/4FA6YXSRCds94P9ZrYvyrx'), '4FA6YXSRCds94P9ZrYvyrx');
  assert.strictEqual(artifactId('https://claude.ai/code/artifact/0b1c-22'), '0b1c-22');
  assert.strictEqual(artifactId('https://example.com/x'), undefined);
});

test('resolveRoot: file folder, project/ parent, explicit root, relative to cwd', () => {
  const cwd = path.resolve('/work/proj');
  assert.deepStrictEqual(resolveRoot({ file_path: 'out/page.html' }, cwd), { root: path.join(cwd, 'out'), entry: 'page.html' });
  assert.deepStrictEqual(resolveRoot({ file_path: 'd/project/canvas.json' }, cwd), { root: path.join(cwd, 'd'), entry: 'project/canvas.json' });
  assert.deepStrictEqual(resolveRoot({ root: 'site', file_path: 'site/a/index.html' }, cwd), { root: path.join(cwd, 'site'), entry: 'a/index.html' });
  assert.deepStrictEqual(resolveRoot({ root: 'site', file_path: 'other/x.html' }, cwd), { root: path.join(cwd, 'site'), entry: 'x.html' });
  assert.strictEqual(resolveRoot({ type_url: 'https://claude.ai/artifact/T' }, cwd), null);
});

test('LogParser pairs a call with its result across separate feeds', () => {
  const p = new LogParser();
  assert.deepStrictEqual(p.feed(call('t1', { file_path: '/work/proj/a.html' }), 'Work'), []);
  const out = p.feed(result('t1', { url: 'https://claude.ai/artifact/ABC', title: 'Page' }), 'Work');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, 'ABC');
  assert.strictEqual(out[0].title, 'Page');
  assert.strictEqual(out[0].account, 'Work');
  assert.strictEqual(out[0].entry, 'a.html');
});

test('LogParser ignores refused, failed, non-publish and file-less calls', () => {
  const p = new LogParser();
  p.feed(call('a', { file_path: 'x.html' }));
  assert.deepStrictEqual(p.feed(result('a', 'Error: refused')), []);
  p.feed(call('b', { file_path: 'x.html' }));
  assert.deepStrictEqual(p.feed(result('b', { url: 'https://claude.ai/artifact/B' }, { is_error: true })), []);
  p.feed(call('c', { action: 'read', url: 'https://claude.ai/artifact/C' }));
  assert.deepStrictEqual(p.feed(result('c', { url: 'https://claude.ai/artifact/C' })), []);
  p.feed(call('d', { type_url: 'https://claude.ai/artifact/T', title: 'New' }));
  assert.deepStrictEqual(p.feed(result('d', { url: 'https://claude.ai/artifact/D' })), []);
  assert.deepStrictEqual(p.feed(result('zzz', { url: 'https://claude.ai/artifact/Z' })), []); // no matching call
});

test('ArtifactScanner: init reads existing logs, poll picks up appended lines only', async () => {
  const dir = tmp();
  const file = path.join(dir, 'proj', 's.jsonl');
  fs.mkdirSync(path.dirname(file));
  const line = (o) => JSON.stringify(o) + '\n';
  fs.writeFileSync(file, line({ type: 'user', message: { content: 'hi' } }) + line(call('t1', { file_path: '/w/a.html' }, '/w')) + line(result('t1', { url: 'https://claude.ai/artifact/A1' })));
  const s = new ArtifactScanner(() => [{ dir, account: 'Personal' }]);
  const first = await s.init();
  assert.deepStrictEqual(first.map((r) => r.id), ['A1']);
  assert.deepStrictEqual(await s.poll(), []);
  fs.appendFileSync(file, line(call('t2', { file_path: '/w/b.html' }, '/w')));
  assert.deepStrictEqual(await s.poll(), []); // result not written yet
  fs.appendFileSync(file, line(result('t2', { url: 'https://claude.ai/artifact/B2' })));
  assert.deepStrictEqual((await s.poll()).map((r) => r.id), ['B2']);
});

test('registry merges by id and keeps the newest first', () => {
  const file = path.join(tmp(), 'artifacts.json');
  addToRegistry(file, [{ id: 'A', title: 'Old', updatedAt: '2026-01-01' }, { id: 'B', title: 'B', updatedAt: '2026-01-02' }]);
  addToRegistry(file, [{ id: 'A', title: '', updatedAt: '2026-01-03', root: '/r' }]);
  const items = readRegistry(file);
  assert.deepStrictEqual(items.map((i) => i.id), ['A', 'B']);
  assert.strictEqual(items[0].title, 'Old'); // a republish without a title keeps the old one
  assert.strictEqual(items[0].root, '/r');
});
