import test from 'node:test';
import assert from 'node:assert/strict';
import { BaynexError, fetchOidcToken, postBaynex } from './baynex-oidc.mjs';
import { fakeFetch, json, oidcEnv } from './baynex-test-helpers.mjs';

test('OIDC token is requested with the audience, masked and never printed otherwise', async () => {
  const lines = [];
  const { fetch, calls } = fakeFetch(() => json({}));
  const token = await fetchOidcToken('https://api.baynex.jp/ci/v1/distribution-config', { env: oidcEnv, fetch, print: (line) => lines.push(line) });
  assert.equal(token, 'oidc-token-1');
  assert.equal(calls.oidc[0].url, 'https://token.actions.test/oidc?api=1&audience=https%3A%2F%2Fapi.baynex.jp%2Fci%2Fv1%2Fdistribution-config');
  assert.equal(calls.oidc[0].headers.Authorization, 'Bearer request-secret');
  assert.deepEqual(lines, ['::add-mask::oidc-token-1']);
});

test('missing id-token permission is a clear, non-denied error', async () => {
  await assert.rejects(() => fetchOidcToken('x', { env: {}, fetch: async () => { throw new Error('no fetch'); } }), (error) => error instanceof BaynexError && error.status === 0 && error.code === 'oidc_unavailable' && !error.denied && /id-token: write/.test(error.message));
});

test('every Baynex call uses a fresh single-use token with the endpoint URL as audience', async () => {
  const { fetch, calls } = fakeFetch(() => json({ ok: true }));
  const lines = [];
  await postBaynex('/ci/v1/distribution-config', {}, { env: oidcEnv, fetch, print: (l) => lines.push(l) });
  await postBaynex('/ci/v1/apple-credentials', { purpose: 'asc-token' }, { env: oidcEnv, fetch, print: (l) => lines.push(l) });
  assert.equal(calls.oidc.length, 2);
  assert.match(calls.oidc[0].url, /audience=https%3A%2F%2Fapi\.baynex\.jp%2Fci%2Fv1%2Fdistribution-config$/);
  assert.match(calls.oidc[1].url, /audience=https%3A%2F%2Fapi\.baynex\.jp%2Fci%2Fv1%2Fapple-credentials$/);
  assert.deepEqual(calls.baynex.map((c) => c.options.headers.Authorization), ['Bearer oidc-token-1', 'Bearer oidc-token-2']);
  assert.equal(calls.baynex[1].options.body, '{"purpose":"asc-token"}');
  assert.equal(calls.baynex[0].url, 'https://api.baynex.jp/ci/v1/distribution-config');
  assert.ok(lines.every((line) => line.startsWith('::add-mask::')));
});

test('HTTP errors keep only the status and a short code, never the body', async () => {
  for (const [status, error, denied] of [[401, 'ci_denied', true], [403, 'ci_denied', true], [429, 'ci_rate_limited', false], [503, 'ci_unavailable', false]]) {
    const { fetch } = fakeFetch(() => json({ error, detail: 'SECRET-BODY-DETAIL' }, status));
    await assert.rejects(() => postBaynex('/ci/v1/distribution-config', {}, { env: oidcEnv, fetch, print: () => {} }), (e) => e.status === status && e.code === error && e.denied === denied && !e.message.includes('SECRET-BODY-DETAIL') && !e.message.includes('oidc-token'));
  }
  const { fetch } = fakeFetch(() => json({ error: 'Not A Code: SECRET' }, 500));
  await assert.rejects(() => postBaynex('/ci/v1/distribution-config', {}, { env: oidcEnv, fetch, print: () => {} }), (e) => e.code === '' && !e.message.includes('SECRET'));
});

test('network failures and timeouts become status 0 errors', async () => {
  const failing = fakeFetch(() => { throw new Error('connect ECONNREFUSED oidc-token-1'); });
  await assert.rejects(() => postBaynex('/ci/v1/distribution-config', {}, { env: oidcEnv, fetch: failing.fetch, print: () => {} }), (e) => e.status === 0 && e.code === 'network' && !e.denied && !e.message.includes('oidc-token'));
  const hanging = fakeFetch((url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))));
  const keepAlive = setInterval(() => {}, 1000); // AbortSignal.timeout timers are unref'd
  try { await assert.rejects(() => postBaynex('/ci/v1/distribution-config', {}, { env: oidcEnv, fetch: hanging.fetch, print: () => {}, timeoutMs: 20 }), (e) => e.code === 'network'); } finally { clearInterval(keepAlive); }
});

test('only Baynex CI paths are accepted', async () => {
  await assert.rejects(() => postBaynex('/other', {}, { env: oidcEnv, fetch: async () => { throw new Error('unreachable'); } }), /パス/);
});
