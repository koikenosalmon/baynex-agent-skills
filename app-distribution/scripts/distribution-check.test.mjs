import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { runCheck, distributionNotStarted } from './distribution-check.mjs';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const keyP8 = privateKey.export({ type: 'pkcs8', format: 'pem' });
const accounts = Object.fromEntries(['example', 'other'].map((slug) => [slug, { secretProject: 'baynex-shared', keyP8Secret: `apple-${slug}-key-p8`, keyIdSecret: `apple-${slug}-key-id`, issuerIdSecret: `apple-${slug}-issuer-id` }]));
const apps = ['example', 'other'].map((slug, index) => ({ id: slug, displayName: slug, appleAccount: slug, iosBundleId: `com.example.${slug}`, firebaseAppIds: { ios: `1:000000000000:ios:${index + 1}`, android: `1:000000000000:android:${index + 1}` } }));
const response = (data, status = 200) => ({ ok: status < 300, status, json: async () => data });
const values = {};
for (const slug of Object.keys(accounts)) {
  values[accounts[slug].keyP8Secret] = keyP8;
  values[accounts[slug].keyIdSecret] = slug === 'example' ? 'ABC1234567' : 'DEF1234567';
  values[accounts[slug].issuerIdSecret] = '12345678-1234-1234-1234-123456789abc';
}

test('check starts apps on releases 404 and reports probe failure with console fallback', async () => {
  const appleKeys = new Set();
  const output = [];
  const releaseCalls = new Map();
  const result = await runCheck({
    config: { appleAccounts: accounts, apps },
    env: { WIF_PROVIDER: 'provider', WIF_SERVICE_ACCOUNT: 'service-account', AUTH_OUTCOME: 'success', GOOGLE_OAUTH_ACCESS_TOKEN: 'token' },
    print: (line) => output.push(line),
    fetch: async (url, options) => {
      const address = String(url);
      if (address.includes('secretmanager.googleapis.com')) return response({ payload: { data: Buffer.from(values[address.split('/')[7]]).toString('base64') } });
      if (address.includes('api.appstoreconnect.apple.com')) {
        const jwtHeader = JSON.parse(Buffer.from(options.headers.Authorization.split(' ')[1].split('.')[0], 'base64url'));
        appleKeys.add(jwtHeader.kid);
        if (address.includes('limit=1')) return response({ data: [] });
        const slug = jwtHeader.kid === 'ABC1234567' ? 'example' : 'other';
        return response({ data: [{ attributes: { identifier: `com.example.${slug}`, seedId: slug === 'example' ? 'ABCDE12345' : 'FGHIJ12345' } }] });
      }
      if (address.includes('/releases?')) {
        const count = (releaseCalls.get(address) || 0) + 1;
        releaseCalls.set(address, count);
        return response({}, count === 2 && address.includes('pageSize=1') ? 200 : 404);
      }
      if (address.includes('/releases:upload')) {
        assert.equal(options.method, 'POST');
        assert.equal(options.headers['X-Goog-Upload-Protocol'], 'raw');
        if (address.includes('android%3A2')) return response({}, 403);
        const appId = decodeURIComponent(address.match(/\/apps\/([^/]+)\/releases:upload$/)[1]);
        return response({ name: `projects/000000000000/apps/${appId}/releases/probe/operations/123` });
      }
      if (address.includes('/operations/123')) return response({ done: true, error: { code: 3 } });
      if (address.includes('testers:getTesterUdids')) return response({ testerUdids: [] });
      throw new Error(`Unexpected URL: ${address}`);
    },
  });
  assert.equal(result.failed, true);
  assert.deepEqual([...appleKeys].sort(), ['ABC1234567', 'DEF1234567']);
  for (const slug of Object.keys(accounts)) {
    assert.match(result.summary, new RegExp(`Apple ${slug}.*キー.*✅`));
    assert.match(result.summary, new RegExp(`Apple ${slug}.*Team ID.*✅`));
  }
  assert.equal((result.summary.match(/✅ \| 自動で開始しました/g) || []).length, 3, result.summary);
  assert.match(result.summary, new RegExp(`❌ \\| .*403.*${distributionNotStarted}`));
  assert.ok(!result.summary.includes(keyP8));
  assert.ok(!result.summary.includes(values[accounts.example.keyIdSecret]));
  assert.equal(output.length, 1);
});

test('check reports private Git dependency credentials by presence only', async () => {
  const run = (config, env) => runCheck({ config: { appleAccounts: accounts, apps, ...config }, env: { AUTH_OUTCOME: 'failure', ...env }, print: () => {}, fetch: async () => response({}, 404) });
  const none = await run({}, {});
  assert.ok(!none.summary.includes('非公開 Git 依存'));
  const missing = await run({ privateGitDependencies: ['owner/private-repo'] }, {});
  assert.match(missing.summary, /非公開 Git 依存 \| owner\/private-repo \| ⚠️ \| GIT_DEPENDENCY_SSH_KEY か GIT_DEPENDENCY_TOKEN を設定してください/);
  const token = await run({ privateGitDependencies: ['owner/private-repo'] }, { GIT_DEPENDENCY_TOKEN_SET: 'true', GIT_DEPENDENCY_TOKEN: 'ghp_secret' });
  assert.match(token.summary, /owner\/private-repo \| ✅ \| トークン（GIT_DEPENDENCY_TOKEN）が設定済み/);
  assert.ok(!token.summary.includes('ghp_secret'));
  const key = await run({ privateGitDependencies: ['owner/private-repo'] }, { GIT_DEPENDENCY_SSH_KEY_SET: 'true', GIT_DEPENDENCY_TOKEN_SET: 'true' });
  assert.match(key.summary, /owner\/private-repo \| ✅ \| SSH 鍵（GIT_DEPENDENCY_SSH_KEY）が設定済み/);
  await assert.rejects(() => run({ privateGitDependencies: ['not a repo'] }, {}), /privateGitDependencies/);
});
