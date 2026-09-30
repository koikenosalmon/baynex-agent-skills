import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DEFAULT_FETCH_TIMEOUT_MS, timedFetch } from './http.mjs';

test('timedFetch adds a deadline unless the caller brought one', async () => {
  const seen = [];
  const fake = async (url, options) => { seen.push(options); return { ok: true }; };
  await timedFetch('https://example.test', { method: 'POST' }, { fetchImpl: fake });
  assert.equal(seen[0].method, 'POST');
  assert.ok(seen[0].signal instanceof AbortSignal);
  const own = new AbortController().signal;
  await timedFetch('https://example.test', { signal: own }, { fetchImpl: fake });
  assert.equal(seen[1].signal, own);
  assert.ok(DEFAULT_FETCH_TIMEOUT_MS > 0 && DEFAULT_FETCH_TIMEOUT_MS <= 60000);
});

test('timedFetch gives up on a server that never answers', async (t) => {
  const sockets = new Set();
  const server = createServer(() => { /* never respond */ });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const started = Date.now();
  await assert.rejects(timedFetch(`http://127.0.0.1:${server.address().port}/`, {}, { timeoutMs: 200 }), (error) => error.name === 'TimeoutError' || error.name === 'AbortError');
  assert.ok(Date.now() - started < 5000);
});
