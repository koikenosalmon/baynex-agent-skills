import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureStarted } from './firebase-activate.mjs';

const appId = '1:000000000000:android:abc123';
const app = 'projects/000000000000/apps/1%3A000000000000%3Aandroid%3Aabc123';
const releasesUrl = `https://firebaseappdistribution.googleapis.com/v1/${app}/releases?pageSize=1`;
const uploadUrl = `https://firebaseappdistribution.googleapis.com/upload/v1/${app}/releases:upload`;
const operationName = 'projects/000000000000/apps/1:000000000000:android:abc123/releases/probe/operations/123';
const operationUrl = `https://firebaseappdistribution.googleapis.com/v1/${operationName}`;
const auth = { Authorization: 'Bearer private-token', Accept: 'application/json' };
const response = (data, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => data });

test('already started checks the exact releases URL and authorization', async () => {
  let calls = 0;
  const result = await ensureStarted({ appId, token: 'private-token', fetch: async (url, options) => {
    calls++;
    assert.equal(url, releasesUrl);
    assert.deepEqual(options, { headers: auth });
    return response({ releases: [] });
  } });
  assert.equal(result, 'already');
  assert.equal(calls, 1);
});

test('404 starts Android with an invalid raw probe, polls, and confirms', async () => {
  const calls = [];
  const result = await ensureStarted({ appId, token: 'private-token', sleep: async () => {}, fetch: async (url, options) => {
    calls.push(url);
    if (url === releasesUrl) {
      assert.deepEqual(options, { headers: auth });
      return response({}, calls.length === 4 ? 200 : 404);
    }
    if (url === uploadUrl) {
      assert.equal(options.method, 'POST');
      assert.deepEqual(options.headers, { ...auth, 'X-Goog-Upload-Protocol': 'raw', 'X-Goog-Upload-File-Name': 'probe.apk', 'Content-Type': 'application/octet-stream' });
      assert.deepEqual(options.body, new TextEncoder().encode('invalid Firebase App Distribution probe'));
      return response({ name: operationName });
    }
    assert.equal(url, operationUrl);
    assert.deepEqual(options.headers, auth);
    assert.ok(options.signal instanceof AbortSignal);
    return response(calls.length === 3 ? { done: true, error: { code: 3 } } : { done: false });
  } });
  assert.equal(result, 'started');
  assert.deepEqual(calls, [releasesUrl, uploadUrl, operationUrl, releasesUrl]);
});

test('probe 403 produces a Japanese error without leaking the token', async () => {
  let calls = 0;
  await assert.rejects(() => ensureStarted({ appId: appId.replace(':android:', ':ios:'), token: 'private-token', fetch: async (url, options) => {
    calls++;
    if (calls === 1) return response({}, 404);
    assert.equal(url, uploadUrl.replaceAll('android', 'ios'));
    assert.equal(options.headers['X-Goog-Upload-File-Name'], 'probe.ipa');
    return response({}, 403);
  } }), (error) => /自動開始.*403/.test(error.message) && !error.message.includes('private-token'));
  assert.equal(calls, 2);
});

test('unfinished operation stops after five polls', async () => {
  let polls = 0;
  await assert.rejects(() => ensureStarted({ appId, token: 'private-token', sleep: async () => {}, now: () => 0, fetch: async (url) => {
    if (url === releasesUrl) return response({}, 404);
    if (url === uploadUrl) return response({ name: operationName });
    assert.equal(url, operationUrl);
    polls++;
    return response({ done: false });
  } }), /タイムアウト/);
  assert.equal(polls, 5);
});
