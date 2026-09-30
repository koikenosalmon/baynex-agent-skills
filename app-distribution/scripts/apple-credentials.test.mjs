import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchAscToken, fetchCloudSigning, loadAppleCredentials } from './apple-credentials.mjs';
import { fakeFetch, json, oidcEnv } from './baynex-test-helpers.mjs';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const p8 = privateKey.export({ type: 'pkcs8', format: 'pem' });
const cloud = { issuerId: '12345678-1234-1234-1234-123456789abc', keyId: 'ABC1234567', privateKey: p8 };
const account = { secretProject: 'baynex-shared', keyP8Secret: 'apple-example-key-p8', keyIdSecret: 'apple-example-key-id', issuerIdSecret: 'apple-example-issuer-id' };
const config = { appleAccounts: { example: account }, apps: [] };
const smValues = { 'apple-example-key-p8': p8, 'apple-example-key-id': 'SMK1234567', 'apple-example-issuer-id': '87654321-1234-1234-1234-123456789abc' };
const secretManager = (url) => json({ payload: { data: Buffer.from(smValues[url.split('/')[7]]).toString('base64') } });

function harness(baynex, extra = {}) {
  const { fetch, calls } = fakeFetch((url, options) => (url.includes('secretmanager.googleapis.com') ? secretManager(url) : baynex(url, options)));
  const out = [];
  const err = [];
  return { calls, out, err, args: { config, env: { ...oidcEnv, ...extra.env }, fetch, print: (l) => out.push(String(l)), warn: (l) => err.push(String(l)) } };
}
const visible = (h) => [...h.out.filter((l) => !l.startsWith('::add-mask::')), ...h.err].join('\n');

test('Baynex cloud-signing is preferred: files are 0600, values masked, nothing else printed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'apple-cred-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const directory = join(dir, 'apple-account');
  const h = harness((url, options) => { assert.equal(JSON.parse(options.body).purpose, 'cloud-signing'); return json(cloud); });
  assert.equal(await loadAppleCredentials({ slug: 'example', directory, ...h.args }), 'baynex');
  assert.equal(await readFile(join(directory, 'app-store-connect.p8'), 'utf8'), p8);
  assert.equal(await readFile(join(directory, 'app-store-connect-key-id'), 'utf8'), 'ABC1234567');
  assert.equal(await readFile(join(directory, 'app-store-connect-issuer-id'), 'utf8'), cloud.issuerId);
  for (const name of ['app-store-connect.p8', 'app-store-connect-key-id', 'app-store-connect-issuer-id']) assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600, name);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const masks = h.out.filter((l) => l.startsWith('::add-mask::')).map((l) => l.slice(12));
  assert.ok(masks.includes('ABC1234567') && masks.includes(cloud.issuerId) && masks.includes('oidc-token-1'));
  assert.ok(masks.includes(p8.split('\n')[1]), 'private key body lines are masked');
  assert.ok(!masks.some((m) => m.startsWith('-----')));
  const shown = visible(h);
  assert.match(shown, /Apple 鍵の取得経路: Baynex OIDC/);
  for (const secret of ['ABC1234567', cloud.issuerId, p8.split('\n')[1], 'oidc-token']) assert.ok(!shown.includes(secret), secret);
  assert.equal(h.calls.baynex.length, 1, 'Secret Manager must not be consulted');
});

test('files are rewritten to 0600 even when they already exist with looser modes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'apple-cred-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { writeCredentialFiles } = await import('./apple-credentials.mjs');
  const { writeFile, chmod } = await import('node:fs/promises');
  await writeFile(join(dir, 'app-store-connect.p8'), 'old', { mode: 0o644 });
  await chmod(join(dir, 'app-store-connect.p8'), 0o644);
  await writeCredentialFiles(dir, { keyP8: p8, keyId: 'ABC1234567', issuerId: cloud.issuerId });
  assert.equal((await stat(join(dir, 'app-store-connect.p8'))).mode & 0o777, 0o600);
});

test('denied, missing and unreachable Baynex fall back to Secret Manager', async (t) => {
  for (const respond of [() => json({ error: 'ci_denied' }, 403), () => json({ error: 'ci_denied' }, 401), () => json({}, 404), () => { throw new Error('offline'); }, () => json({ keyId: 'bad' })]) {
    const dir = await mkdtemp(join(tmpdir(), 'apple-cred-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const h = harness(respond, { env: { GOOGLE_OAUTH_ACCESS_TOKEN: 'google-token' } });
    assert.equal(await loadAppleCredentials({ slug: 'example', directory: join(dir, 'a'), ...h.args }), 'secret-manager');
    assert.equal(await readFile(join(dir, 'a', 'app-store-connect-key-id'), 'utf8'), 'SMK1234567');
    assert.match(h.out.join('\n'), /Apple 鍵の取得経路: Secret Manager/);
    assert.match(h.err.join('\n'), /Baynex OIDC で Apple 鍵を取得できませんでした/);
    assert.ok(!visible(h).includes('SECRET'));
  }
});

test('legacy GitHub secrets are the last resort, and the source says so', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'apple-cred-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const legacy = { APP_STORE_CONNECT_KEY_P8: p8, APP_STORE_CONNECT_KEY_ID: 'LEG1234567', APP_STORE_CONNECT_ISSUER_ID: '11111111-1234-1234-1234-123456789abc' };
  const h = harness(() => json({ error: 'ci_denied' }, 403), { env: legacy });
  assert.equal(await loadAppleCredentials({ slug: 'example', directory: join(dir, 'a'), ...h.args }), 'github-secrets');
  assert.equal(await readFile(join(dir, 'a', 'app-store-connect-key-id'), 'utf8'), 'LEG1234567');
  assert.match(h.out.join('\n'), /取得経路: GitHub Secrets/);
  // Secret Manager failure with legacy secrets present also lands here.
  const failing = harness(() => json({ error: 'ci_denied' }, 403), { env: { ...legacy, GOOGLE_OAUTH_ACCESS_TOKEN: 'google-token' } });
  failing.args.fetch = (url, options) => (String(url).includes('secretmanager') ? Promise.resolve(json({}, 403)) : fakeFetch(() => json({ error: 'ci_denied' }, 403)).fetch(url, options));
  assert.equal(await loadAppleCredentials({ slug: 'example', directory: join(dir, 'b'), ...failing.args }), 'github-secrets');
});

test('without a slug and without Baynex there is nothing to fall back to', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'apple-cred-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(() => json({ error: 'ci_denied' }, 403));
  await assert.rejects(() => loadAppleCredentials({ slug: '', directory: dir, ...h.args }), /appleAccount/);
});

test('an account without appleAccount works through Baynex alone; unavailable Baynex Apple skips the call', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'apple-cred-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(() => json(cloud));
  assert.equal(await loadAppleCredentials({ slug: '', directory: join(dir, 'a'), ...h.args, config: { apps: [] } }), 'baynex');
  const skipped = harness(() => { throw new Error('must not call Baynex'); }, { env: { GOOGLE_OAUTH_ACCESS_TOKEN: 'google-token' } });
  skipped.args.config = { ...config, baynex: { apple: { available: false } } };
  assert.equal(await loadAppleCredentials({ slug: 'example', directory: join(dir, 'b'), ...skipped.args }), 'secret-manager');
  assert.equal(skipped.calls.baynex.filter((c) => c.url.startsWith('https://api.baynex.jp')).length, 0);
  assert.equal(skipped.calls.oidc.length, 0);
});

test('asc-token is fetched with its purpose, masked and validated', async () => {
  const lines = [];
  const token = 'eyJhbGciOiJFUzI1NiJ9.payload.signature-value';
  const h = harness((url, options) => { assert.equal(JSON.parse(options.body).purpose, 'asc-token'); return json({ token, teamId: 'ABCDE12345', expiresAt: '2030-01-01T00:00:00Z' }); });
  const result = await fetchAscToken({ ...h.args, print: (l) => lines.push(l) });
  assert.equal(result.token, token);
  assert.equal(result.teamId, 'ABCDE12345');
  assert.ok(lines.includes(`::add-mask::${token}`));
  const bad = harness(() => json({ token: 'short' }));
  await assert.rejects(() => fetchAscToken(bad.args), /asc-token/);
  const badCloud = harness(() => json({ keyId: 'ABC1234567', issuerId: 'nope', privateKey: 'x' }));
  await assert.rejects(() => fetchCloudSigning(badCloud.args), /cloud-signing/);
});

// Real scenario: the repo is registered in Baynex CI access (ASC key from Baynex OIDC) while apps.json keeps
// appleAccount "ci-cd" with an existing distribution certificate. Manual signing must stay selected.
const ciCd = { secretProject: 'baynex-shared', distributionP12Secret: 'apple-ci-cd-distribution-p12', distributionP12PasswordSecret: 'apple-ci-cd-distribution-p12-password' };
const ciCdConfig = { appleAccount: 'ci-cd', appleAccounts: { 'ci-cd': ciCd }, apps: [], baynex: { mode: 'repo', apple: { available: true, cloudSigning: true } } };
const p12Bytes = Buffer.from('fake-p12-bytes');

function ciCdHarness(status = 200) {
  const requested = [];
  const { fetch, calls } = fakeFetch(() => json(cloud));
  const wrapped = async (url, options) => {
    if (!String(url).includes('secretmanager.googleapis.com')) return fetch(url, options);
    const name = String(url).split('/')[7];
    requested.push(name);
    if (status !== 200) return json({}, status);
    return json({ payload: { data: Buffer.from(name.endsWith('password') ? 'p12-pass' : p12Bytes.toString('base64')).toString('base64') } });
  };
  const out = [];
  const err = [];
  return { requested, calls, out, err, args: { config: ciCdConfig, env: { ...oidcEnv, GOOGLE_OAUTH_ACCESS_TOKEN: 'google-token' }, fetch: wrapped, print: (l) => out.push(String(l)), warn: (l) => err.push(String(l)) } };
}

test('Baynex OIDC key + apps.json distributionP12Secret: the configured p12 is written for manual signing, no dist-p12 secret is touched', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'apple-cred-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const directory = join(dir, 'apple-account');
  const h = ciCdHarness();
  assert.equal(await loadAppleCredentials({ slug: 'ci-cd', directory, ...h.args }), 'baynex');
  assert.equal(await readFile(join(directory, 'app-store-connect-key-id'), 'utf8'), 'ABC1234567');
  assert.deepEqual(await readFile(join(directory, 'distribution.p12')), p12Bytes);
  assert.equal(await readFile(join(directory, 'distribution.p12.password'), 'utf8'), 'p12-pass');
  assert.equal((await stat(join(directory, 'distribution.p12'))).mode & 0o777, 0o600);
  assert.deepEqual(h.requested, ['apple-ci-cd-distribution-p12', 'apple-ci-cd-distribution-p12-password']);
  assert.ok(!h.requested.some((name) => name.endsWith('-dist-p12')), 'the managed dist-p12 secret is never read or created');
});

test('Baynex OIDC key without a configured distribution p12 writes no p12 (cloud signing path) and needs no Secret Manager', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'apple-cred-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = ciCdHarness();
  h.args.config = { ...ciCdConfig, appleAccounts: { 'ci-cd': { secretProject: 'baynex-shared' } } };
  assert.equal(await loadAppleCredentials({ slug: 'ci-cd', directory: join(dir, 'a'), ...h.args }), 'baynex');
  await assert.rejects(() => stat(join(dir, 'a', 'distribution.p12')), /ENOENT/);
  assert.deepEqual(h.requested, []);
  const none = ciCdHarness();
  none.args.config = { apps: [] };
  assert.equal(await loadAppleCredentials({ slug: '', directory: join(dir, 'b'), ...none.args }), 'baynex');
});

test('a configured distribution p12 that cannot be read stops with a clear message instead of falling back', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'apple-cred-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const denied = ciCdHarness(403);
  await assert.rejects(() => loadAppleCredentials({ slug: 'ci-cd', directory: join(dir, 'a'), ...denied.args }), /配布証明書を Secret Manager から読めません.*apple-ci-cd-distribution-p12 を読む権限がありません.*自動作成には切り替えません/);
  const noToken = ciCdHarness();
  delete noToken.args.env.GOOGLE_OAUTH_ACCESS_TOKEN;
  await assert.rejects(() => loadAppleCredentials({ slug: 'ci-cd', directory: join(dir, 'b'), ...noToken.args }), /アクセストークンがありません/);
});
