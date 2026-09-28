import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchTesterUdids } from './firebase-udids.mjs';

const appId = '1:000000000000:ios:6a42d839567625d15ee239';
const response = (data, status = 200) => ({ ok: status < 300, status, json: async () => data });

test('fetches the documented v1alpha app endpoint and validates testerUdids', async () => {
  const udid = 'a'.repeat(40);
  const devices = await fetchTesterUdids(appId, 'token', async (url, options) => {
    assert.equal(url, `https://firebaseappdistribution.googleapis.com/v1alpha/apps/${encodeURIComponent(appId)}/testers:getTesterUdids`);
    assert.equal(options.headers.Authorization, 'Bearer token');
    return response({ testerUdids: [{ udid, name: 'iPhone', platform: 'IOS' }, { udid, name: 'iPhone', platform: 'IOS' }] });
  });
  assert.deepEqual(devices, [{ udid: udid.toUpperCase(), name: 'iPhone', platform: 'IOS' }]);
});

test('rejects malformed responses and does not expose access token', async () => {
  await assert.rejects(() => fetchTesterUdids(appId, 'sensitive-token', async () => response({}, 403)), (error) => !error.message.includes('sensitive-token') && /403/.test(error.message));
  await assert.rejects(() => fetchTesterUdids(appId, 'token', async () => response({ testerUdids: [{ udid: 'wrong' }] })), /UDID/);
  await assert.rejects(() => fetchTesterUdids(appId, 'token', async () => response({ testerUdids: {} })), /応答/);
});
