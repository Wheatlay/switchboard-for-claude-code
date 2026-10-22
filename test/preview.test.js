'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createPreviewServer, safeResolve } = require('../lib/preview');

test('safeResolve rejects traversal, absolute paths and hidden files', () => {
  const root = path.resolve('/srv/art');
  assert.strictEqual(safeResolve(root, 'index.html'), path.join(root, 'index.html'));
  assert.strictEqual(safeResolve(root, 'project/a.html'), path.join(root, 'project', 'a.html'));
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'a\\b', '.env', 'a/.git/config', '']) {
    assert.strictEqual(safeResolve(root, bad), null, bad);
  }
});

function get(port, p, host = `127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: { Host: host } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on('error', reject);
  });
}

test('server: serves artifacts, canvas, blocks bad Host and dotfiles', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-prev-'));
  fs.writeFileSync(path.join(root, 'page.html'), '<html><body><h1>Hello</h1></body></html>');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
  const canvasRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-canvas-'));
  fs.mkdirSync(path.join(canvasRoot, 'project'));
  fs.writeFileSync(path.join(canvasRoot, 'project', 'canvas.json'), JSON.stringify({ title: 'Boards', boards: {} }));
  const items = [
    { id: 'PAGE', title: 'Page', root, entry: 'page.html', url: 'https://claude.ai/artifact/PAGE' },
    { id: 'CANVAS', title: 'Canvas', root: canvasRoot, entry: 'project/canvas.json' },
  ];
  let misses = 0;
  const srv = createPreviewServer({
    port: 0, health: 'switchboard test', listItems: () => items,
    findItem: async (id) => items.find((i) => i.id === id) || (misses++, null),
  });
  assert.strictEqual(await srv.listen(), 'listening');
  t.after(() => srv.close());
  const port = srv.server.address().port;

  assert.strictEqual((await get(port, '/health')).body, 'switchboard test');
  const index = await get(port, '/');
  assert.match(index.body, /Page/);
  assert.match(index.body, /Canvas/);

  const pageRes = await get(port, '/a/PAGE/');
  assert.strictEqual(pageRes.status, 200);
  assert.match(pageRes.body, /<h1>Hello<\/h1>/);
  assert.match(pageRes.body, /EventSource/); // live reload injected

  assert.strictEqual((await get(port, '/a/PAGE')).status, 302);
  assert.strictEqual((await get(port, '/a/PAGE/f/.env')).status, 403);
  assert.strictEqual((await get(port, '/a/PAGE/f/..%2F..%2Fx')).status, 403);

  const canvas = await get(port, '/a/CANVAS/');
  assert.match(canvas.body, /id="world"/);
  assert.strictEqual(JSON.parse((await get(port, '/a/CANVAS/canvas.json')).body).title, 'Boards');

  assert.strictEqual((await get(port, '/a/NOPE/')).status, 404);
  assert.strictEqual(misses, 1);

  assert.strictEqual((await get(port, '/', 'evil.example:80')).status, 403);
  assert.strictEqual((await get(port, '/', `localhost:${port}`)).status, 200);
});

test('server: reports a taken port instead of throwing', async (t) => {
  const a = createPreviewServer({ port: 0, health: 'x', listItems: () => [], findItem: async () => null });
  await a.listen();
  t.after(() => a.close());
  const b = createPreviewServer({ port: a.server.address().port, health: 'x', listItems: () => [], findItem: async () => null });
  assert.strictEqual(await b.listen(), 'in-use');
});
