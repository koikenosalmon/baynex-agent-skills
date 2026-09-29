import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { createJwt, createClient, bundleStatus, registerDevices, validateApps } from './app-store-connect.mjs';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const credentials = { issuerId: '12345678-1234-1234-1234-123456789abc', keyId: 'ABC1234567', keyP8: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const app = { id: 'coach', displayName: 'Example Coach dev', iosBundleId: 'com.example.coach', appleAccount: 'example' };
const account = { secretProject: 'baynex-shared', keyP8Secret: 'apple-example-key-p8', keyIdSecret: 'apple-example-key-id', issuerIdSecret: 'apple-example-issuer-id' };
const config = (apps) => ({ apps, appleAccounts: { example: account } });
const response = (data, status = 200) => ({ ok: status < 300, status, json: async () => data });

test('ES256 JWT has Apple claims and a valid P-256 signature', () => {
  const jwt = createJwt({ ...credentials, now: 1_700_000_000_000 });
  const [header, payload, signature] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: credentials.keyId, typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.deepEqual(claims, { iss: credentials.issuerId, iat: 1_700_000_000, exp: 1_700_001_190, aud: 'appstoreconnect-v1' });
  assert.ok(verify('sha256', Buffer.from(`${header}.${payload}`), { key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
});

test('bundle registration discovers Team ID and is idempotent', async () => {
  const calls = [];
  const client = createClient(credentials, async (url, options) => {
    calls.push([url.pathname, options.method || 'GET']);
    if (options.method === 'POST') {
      assert.deepEqual(JSON.parse(options.body), { data: { type: 'bundleIds', attributes: { name: app.displayName, identifier: app.iosBundleId, platform: 'IOS' } } });
      return response({ data: { attributes: { identifier: app.iosBundleId, seedId: 'ABCDE12345' } } }, 201);
    }
    return response({ data: [] });
  });
  const result = await bundleStatus(client, validateApps(config([app])), true);
  assert.equal(result.teamId, 'ABCDE12345');
  assert.equal(result.bundleIds[0].created, true);
  assert.deepEqual(calls, [['/v1/bundleIds', 'GET'], ['/v1/bundleIds', 'POST']]);
});

test('existing devices are skipped and new ones use IOS', async () => {
  let posts = 0;
  const first = 'A'.repeat(40), second = 'B'.repeat(40);
  const client = createClient(credentials, async (url, options) => {
    if (options.method === 'POST') {
      posts++;
      assert.deepEqual(JSON.parse(options.body).data.attributes, { name: 'Firebase BBBBBBBB', platform: 'IOS', udid: second });
      return response({ data: {} }, 201);
    }
    assert.equal(url.pathname, '/v1/devices');
    return response({ data: [{ attributes: { udid: first } }] });
  });
  const result = await registerDevices(client, [{ udid: first }, { udid: second }, { udid: second }]);
  assert.deepEqual(result, { requested: 2, existing: 1, created: 1, remaining: null });
  assert.equal(posts, 1);
});

test('a concurrent device registration conflict is accepted only after lookup', async () => {
  const udid = 'C'.repeat(40);
  const client = createClient(credentials, async (url, options) => {
    if (options.method === 'POST') return response({}, 409);
    if (url.searchParams.has('filter[udid]')) return response({ data: [{ attributes: { udid } }] });
    return response({ data: [] });
  });
  assert.deepEqual(await registerDevices(client, [{ udid }]), { requested: 1, existing: 1, created: 0, remaining: null });
});

test('invalid data and Apple permission errors are safe', async () => {
  assert.throws(() => createJwt({ ...credentials, keyP8: 'bad' }), /p8/);
  await assert.rejects(() => registerDevices(createClient(credentials, async () => response({}, 403)), [{ udid: 'A'.repeat(40) }]), /キーが無効か、アクセスが『管理』ではありません/);
  await assert.rejects(() => registerDevices(createClient(credentials), [{ udid: 'bad' }]), /UDID/);
  assert.throws(() => validateApps(config([{ ...app, iosBundleId: 'bad id' }])), /不正/);
});

test('every app references a valid Apple account', () => {
  assert.throws(() => validateApps(config([{ ...app, appleAccount: 'other' }])), /アカウント参照/);
  assert.throws(() => validateApps(config([{ ...app, appleAccount: 'toString' }])), /アカウント参照/);
  assert.throws(() => validateApps({ apps: [app], appleAccounts: { 'A': account } }), /アカウント設定/);
  assert.throws(() => validateApps({ apps: [app], appleAccounts: { example: { ...account, secretProject: 'Bad_Project' } } }), /アカウント設定/);
});

test('apps.json accepts optional flutterVersion and rejects malformed ones', () => {
  assert.equal(validateApps({ ...config([app]), flutterVersion: '3.41.9' }).length, 1);
  assert.throws(() => validateApps({ ...config([app]), flutterVersion: 'stable' }), /flutterVersion/);
});

test('apps.json accepts optional privateGitDependencies and rejects malformed ones', () => {
  assert.equal(validateApps({ ...config([app]), privateGitDependencies: ['OTERA-Co-Ltd/otera-packages'] }).length, 1);
  assert.throws(() => validateApps({ ...config([app]), privateGitDependencies: ['https://github.com/OTERA-Co-Ltd/otera-packages'] }), /privateGitDependencies/);
  assert.throws(() => validateApps({ ...config([app]), privateGitDependencies: 'OTERA-Co-Ltd/otera-packages' }), /privateGitDependencies/);
});
