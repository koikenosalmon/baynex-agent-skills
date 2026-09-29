// The workflow captures stdout of several kit scripts (jq, $(...), redirects into JSON files).
// These tests run the real CLIs with a stubbed fetch and assert stdout carries only the payload,
// whatever Baynex answers. Diagnostics and ::add-mask:: commands must stay on stderr.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scripts = new URL('.', import.meta.url).pathname;
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const p8 = privateKey.export({ type: 'pkcs8', format: 'pem' });
const ascToken = 'eyJhbGciOiJFUzI1NiJ9.baynex-asc.token-signature';
const account = { secretProject: 'baynex-shared', keyP8Secret: 'a-p8', keyIdSecret: 'a-id', issuerIdSecret: 'a-issuer' };
const config = { appleAccounts: { example: account }, apps: [{ id: 'coach', displayName: 'Coach', flavor: 'coach', target: 'lib/main.dart', appleAccount: 'example', iosBundleId: 'com.example.coach', firebaseAppIds: { ios: '1:1:ios:a', android: '1:1:android:a' } }] };

// Preloaded into each CLI: GitHub OIDC, Baynex (status from BAYNEX_STATUS) and Apple are all answered locally.
const preload = `
const json = (data, status = 200) => ({ ok: status < 300, status, json: async () => data });
globalThis.fetch = async (url) => {
  url = String(url);
  if (url.startsWith('https://token.actions.test/')) return json({ value: 'oidc-secret-value' });
  if (url.startsWith('https://api.baynex.jp/')) {
    const status = Number(process.env.BAYNEX_STATUS);
    if (status !== 200) return json({ error: status === 401 ? 'ci_denied' : 'ci_unavailable' }, status);
    if (url.endsWith('apple-credentials')) return json({ token: '${ascToken}', teamId: 'ABCDE12345', expiresAt: 'x' });
    return json({ schemaVersion: 1, mode: 'baynex', revision: 1, apps: [] });
  }
  if (url.includes('api.appstoreconnect.apple.com')) return json({ data: [{ attributes: { identifier: 'com.example.coach', seedId: 'ABCDE12345' } }] });
  throw new Error('unexpected fetch ' + url);
};`;

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cli-stdout-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'preload.mjs'), preload);
  await writeFile(join(dir, 'apps.json'), JSON.stringify(config));
  await writeFile(join(dir, 'key.p8'), p8);
  await writeFile(join(dir, 'key-id'), 'ABC1234567');
  await writeFile(join(dir, 'issuer-id'), '12345678-1234-1234-1234-123456789abc');
  return dir;
}
const run = (dir, script, args, status, extra = {}) => spawnSync('node', ['--import', join(dir, 'preload.mjs'), join(scripts, script), ...args], {
  encoding: 'utf8',
  env: { PATH: process.env.PATH, RUNNER_TEMP: dir, BAYNEX_STATUS: String(status), ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.test/oidc?api=1', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-secret', DISTRIBUTION_CONFIG: join(dir, 'apps.json'), APP_STORE_CONNECT_KEY_P8_FILE: join(dir, 'key.p8'), APP_STORE_CONNECT_KEY_ID_FILE: join(dir, 'key-id'), APP_STORE_CONNECT_ISSUER_ID_FILE: join(dir, 'issuer-id'), ...extra },
});

for (const status of [200, 401, 503]) {
  test(`app-store-connect stdout is pure JSON when Baynex answers ${status}`, async (t) => {
    const dir = await setup(t);
    const result = run(dir, 'app-store-connect.mjs', ['ensure-bundle-ids', 'coach'], status);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.bundleIds[0].bundleId, 'com.example.coach');
    assert.ok(!result.stdout.includes('::add-mask::') && !result.stdout.includes('asc-token'));
    if (status === 200) assert.match(result.stderr, /::add-mask::/, 'the mask command is emitted on stderr');
    else assert.match(result.stderr, /Baynex asc-token を使えません/);
  });

  test(`app-store-connect register-devices stdout is pure JSON when Baynex answers ${status}`, async (t) => {
    const dir = await setup(t);
    await writeFile(join(dir, 'udids.json'), '[]');
    const result = run(dir, 'app-store-connect.mjs', ['register-devices', join(dir, 'udids.json')], status);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(Object.keys(JSON.parse(result.stdout)).sort(), ['created', 'existing', 'remaining', 'requested']);
    assert.ok(!result.stdout.includes('::add-mask::'));
  });

  test(`resolve-config and apple-credentials keep stdout empty when Baynex answers ${status}`, async (t) => {
    const dir = await setup(t);
    const resolved = run(dir, 'resolve-config.mjs', [], status);
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.equal(resolved.stdout, '');
    const credentials = run(dir, 'apple-credentials.mjs', ['load', '', join(dir, 'apple-account')], status);
    assert.equal(credentials.stdout, '');
    assert.ok(!credentials.stdout.includes('oidc-secret-value') && !resolved.stdout.includes('oidc-secret-value'));
  });
}
