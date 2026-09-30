import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from './app-store-connect.mjs';
import { CLOUD_SIGNING_FAILURE, exportOptionsPlist, parseBundle, prepare, profileName, resolveSecret, runCli } from './ios-signing.mjs';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const credentials = { issuerId: '12345678-1234-1234-1234-123456789abc', keyId: 'ABC1234567', keyP8: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const secret = { project: 'baynex-shared', name: 'apple-example-dist-p12' };
const json = (data, status = 200) => ({ ok: status < 300, status, json: async () => data });
const FUTURE = '2099-01-01T00:00:00.000+0000';

// A tiny CA so the fake Apple can turn the CSR sent by the tool into a certificate that matches its private key.
async function makeCa(dir) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'ca.key'), '-out', join(dir, 'ca.pem'), '-subj', '/CN=Fake Apple CA', '-days', '30'], { stdio: 'ignore' });
}
function signCsr(dir, csr) {
  const csrPath = join(dir, `req-${Math.random().toString(36).slice(2)}.csr`);
  const outPath = `${csrPath}.der`;
  return writeFile(csrPath, csr).then(() => {
    execFileSync('openssl', ['x509', '-req', '-in', csrPath, '-CA', join(dir, 'ca.pem'), '-CAkey', join(dir, 'ca.key'), '-CAcreateserial', '-days', '30', '-outform', 'DER', '-out', outPath], { stdio: 'ignore' });
    return readFile(outPath);
  });
}

// Fake Apple + Secret Manager. `state` is mutable so tests can inspect every write.
function world(dir, overrides = {}) {
  const state = { stored: overrides.stored ?? null, certs: overrides.certs ?? {}, calls: [], profiles: overrides.profiles ?? [], canAdd: overrides.canAdd ?? true, secretExists: overrides.secretExists ?? true, versions: [] };
  const fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    state.calls.push(`${method} ${u.host}${u.pathname}`);
    if (u.host === 'secretmanager.googleapis.com') {
      if (u.pathname.endsWith('versions/latest:access')) {
        if (state.stored === null) return json({}, 404);
        return json({ payload: { data: Buffer.from(state.stored).toString('base64') } });
      }
      if (u.pathname.endsWith(':testIamPermissions')) return json({ permissions: state.canAdd ? body.permissions : [] });
      if (u.pathname.endsWith(':addVersion')) { state.stored = Buffer.from(body.payload.data, 'base64').toString(); state.versions.push(state.stored); return json({}); }
      if (u.pathname.endsWith(`/secrets/${secret.name}`)) return state.secretExists ? json({}) : json({}, 404);
      if (u.pathname.endsWith('/secrets')) { state.secretExists = true; return json({}); }
    }
    if (u.host === 'api.appstoreconnect.apple.com') {
      if (u.pathname === '/v1/certificates' && method === 'POST') {
        const der = await signCsr(dir, body.data.attributes.csrContent);
        assert.equal(body.data.attributes.certificateType, 'DISTRIBUTION');
        state.certs.NEWCERT = { attributes: { certificateType: 'DISTRIBUTION', expirationDate: FUTURE } };
        return json({ data: { id: 'NEWCERT', attributes: { certificateContent: der.toString('base64') } } }, 201);
      }
      const cert = u.pathname.match(/^\/v1\/certificates\/(.+)$/);
      if (cert) { if (method !== 'GET') throw new Error(`certificates must never be ${method}d`); return state.certs[cert[1]] ? json({ data: { id: cert[1], ...state.certs[cert[1]] } }) : json({ errors: [{ detail: 'not found' }] }, 404); }
      if (u.pathname === '/v1/bundleIds') return json({ data: u.searchParams.get('filter[identifier]') === 'com.example.coach' ? [{ id: 'BUNDLE1', attributes: { identifier: 'com.example.coach' } }] : [] });
      if (u.pathname === '/v1/devices') return json({ data: [{ id: 'DEV1' }, { id: 'DEV2' }] });
      if (u.pathname === '/v1/profiles' && method === 'GET') return json({ data: state.profiles });
      if (u.pathname === '/v1/profiles' && method === 'POST') { state.profileBody = body; return json({ data: { id: 'PROF-NEW', attributes: { name: body.data.attributes.name, uuid: '11111111-2222-3333-4444-555555555555', profileContent: Buffer.from('profile-bytes').toString('base64') } } }, 201); }
      const profile = u.pathname.match(/^\/v1\/profiles\/(.+)$/);
      if (profile && method === 'DELETE') { state.deleted = [...(state.deleted || []), profile[1]]; return { ok: true, status: 204, json: async () => { throw new Error('no body'); } }; }
    }
    throw new Error(`unexpected request ${method} ${url}`);
  };
  return { state, fetch };
}

async function setup(t, overrides) {
  const dir = await mkdtemp(join(tmpdir(), 'ios-signing-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await makeCa(dir);
  const out = join(dir, 'out');
  const w = world(dir, overrides);
  const client = createClient(credentials, w.fetch);
  const run = (extra = {}) => prepare({ client, secret, token: 'gcp-token', fetch: w.fetch, out, teamId: 'ABCDE12345', method: 'ad-hoc', bundleIds: ['com.example.coach'], print: () => {}, ...extra });
  return { dir, out, w, run };
}

test('creates one Apple Distribution certificate, stores the p12 bundle, and builds an ad-hoc profile with every device', async (t) => {
  const { out, w, run } = await setup(t);
  const result = await run();
  assert.equal(result.certificateId, 'NEWCERT');
  assert.equal(result.certificateCreated, true);
  assert.equal(result.devices, 2);
  assert.equal(w.state.versions.length, 1);
  const bundle = parseBundle(w.state.stored);
  assert.equal(bundle.certificateId, 'NEWCERT');
  assert.deepEqual(w.state.profileBody.data.relationships.devices.data, [{ type: 'devices', id: 'DEV1' }, { type: 'devices', id: 'DEV2' }]);
  assert.deepEqual(w.state.profileBody.data.relationships.certificates.data, [{ type: 'certificates', id: 'NEWCERT' }]);
  assert.equal(w.state.profileBody.data.attributes.profileType, 'IOS_APP_ADHOC');
  const plist = await readFile(result.exportOptions, 'utf8');
  assert.match(plist, /<key>signingStyle<\/key>\s*<string>manual<\/string>/);
  assert.match(plist, /<key>com\.example\.coach<\/key>\s*<string>Baynex AdHoc com\.example\.coach<\/string>/);
  for (const file of [result.p12Path, result.passwordPath, result.exportOptions, result.profiles[0].path]) assert.equal((await stat(file)).mode & 0o077, 0);
  // Nothing on stdout may carry key material: the JSON holds ids and paths only.
  const printed = JSON.stringify(result);
  assert.ok(!printed.includes(bundle.password) && !printed.includes(bundle.p12Base64));
  assert.ok(!w.state.calls.some((call) => call.startsWith('DELETE') || /certificates\/.+/.test(call) && !call.startsWith('GET')));
  assert.ok(out);
});

test('reuses the stored certificate when Apple still has it (idempotent, nothing created)', async (t) => {
  const first = await setup(t);
  await first.run();
  const stored = first.w.state.stored;
  const { w, run } = await setup(t, { stored, certs: { NEWCERT: { attributes: { certificateType: 'DISTRIBUTION', expirationDate: FUTURE } } } });
  const result = await run();
  assert.equal(result.certificateCreated, false);
  assert.equal(w.state.versions.length, 0);
  assert.ok(!w.state.calls.includes('POST api.appstoreconnect.apple.com/v1/certificates'));
});

test('creates a new certificate when the stored one is gone or expired, without touching the old one', async (t) => {
  const first = await setup(t);
  await first.run();
  for (const certs of [{}, { NEWCERT: { attributes: { certificateType: 'DISTRIBUTION', expirationDate: '2001-01-01T00:00:00.000+0000' } } }]) {
    const { w, run } = await setup(t, { stored: first.w.state.stored, certs });
    const result = await run();
    assert.equal(result.certificateCreated, true);
    assert.equal(w.state.versions.length, 1);
    assert.ok(!w.state.calls.some((call) => call.startsWith('DELETE api.appstoreconnect.apple.com/v1/certificates')));
  }
});

test('does not create a certificate when the secret cannot be written', async (t) => {
  const { w, run } = await setup(t, { canAdd: false });
  await assert.rejects(run(), /secretVersionAdder.*作成していません/);
  assert.ok(!w.state.calls.includes('POST api.appstoreconnect.apple.com/v1/certificates'));
});

test('creates the secret container when missing, then stores the bundle', async (t) => {
  const { w, run } = await setup(t, { secretExists: false });
  await run();
  assert.equal(w.state.secretExists, true);
  assert.equal(w.state.versions.length, 1);
});

test('only profiles with the exact tool-managed name are replaced', async (t) => {
  const first = await setup(t);
  await first.run();
  const profiles = [{ id: 'MINE', attributes: { name: profileName('com.example.coach') } }, { id: 'HUMAN', attributes: { name: 'Hand made adhoc' } }];
  const { w, run } = await setup(t, { stored: first.w.state.stored, certs: { NEWCERT: { attributes: { certificateType: 'DISTRIBUTION', expirationDate: FUTURE } } }, profiles });
  await run();
  assert.deepEqual(w.state.deleted, ['MINE']);
});

test('an unregistered bundle ID is reported', async (t) => {
  const { run } = await setup(t);
  await assert.rejects(run({ bundleIds: ['com.example.unknown'] }), /登録されていません: com\.example\.unknown/);
});

test('Apple certificate creation errors are reported with the manual-revoke hint and never revoke', async (t) => {
  const { w, dir } = await setup(t);
  const failing = async (url, options = {}) => (new URL(String(url)).pathname === '/v1/certificates' && options.method === 'POST' ? { ok: false, status: 409, json: async () => ({ errors: [{ detail: 'certificate limit reached' }] }) } : w.fetch(url, options));
  const client = createClient(credentials, failing);
  await assert.rejects(prepare({ client, secret, token: 't', fetch: failing, out: join(dir, 'o'), teamId: 'ABCDE12345', method: 'ad-hoc', bundleIds: ['com.example.coach'], print: () => {} }), /certificate limit reached.*失効させません/);
  assert.equal(w.state.versions.length, 0);
});

test('ExportOptions escape values and reject bad input', () => {
  const plist = exportOptionsPlist({ method: 'release-testing', teamId: 'ABCDE12345', profiles: [{ bundleId: 'com.example.a', name: 'A & <B>' }] });
  assert.match(plist, /A &amp; &lt;B&gt;/);
  assert.throws(() => exportOptionsPlist({ method: 'app-store', teamId: 'ABCDE12345', profiles: [] }), /不正/);
});

test('secret location comes from the account, an override, or the default name', () => {
  assert.deepEqual(resolveSecret({ appleAccounts: { example: { secretProject: 'proj-shared-1', distP12Secret: 'custom' } } }, {}, 'example'), { project: 'proj-shared-1', name: 'custom' });
  assert.deepEqual(resolveSecret(undefined, {}, 'example'), { project: 'baynex-shared', name: 'apple-example-dist-p12' });
  assert.deepEqual(resolveSecret(undefined, { IOS_SIGNING_SECRET_PROJECT: 'p-abcde', IOS_SIGNING_SECRET_NAME: 'n' }, ''), { project: 'p-abcde', name: 'n' });
  assert.throws(() => resolveSecret(undefined, {}, ''), /保存先が決まりません/);
});

test('the fallback trigger matches the known xcodebuild failures and the workflow uses the same expression', async () => {
  const pattern = new RegExp(CLOUD_SIGNING_FAILURE);
  for (const line of ['error: exportArchive Cloud signing permission error', 'error: exportArchive No signing certificate "iOS Distribution" found', "error: exportArchive No profiles for 'com.mamoruba.app.dev' were found"]) assert.match(line, pattern);
  assert.doesNotMatch('error: exportArchive The operation couldn’t be completed', pattern);
  const workflow = await readFile(new URL('../../.github/workflows/app-distribution.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes(`cloud_failure='${CLOUD_SIGNING_FAILURE}'`));
});

test('CLI keeps stdout to a single JSON document', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ios-signing-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'preload.mjs'), `globalThis.fetch = async () => { throw new Error('offline'); };`);
  const result = spawnSync(process.execPath, ['--import', join(dir, 'preload.mjs'), new URL('./ios-signing.mjs', import.meta.url).pathname, 'prepare', '--out', join(dir, 'o'), '--team', 'ABCDE12345', '--method', 'ad-hoc', '--bundle-ids', 'com.example.coach', '--account', 'example'], { encoding: 'utf8', env: { ...process.env, GOOGLE_OAUTH_ACCESS_TOKEN: 'x', APP_STORE_CONNECT_KEY_P8: credentials.keyP8, APP_STORE_CONNECT_KEY_ID: credentials.keyId, APP_STORE_CONNECT_ISSUER_ID: credentials.issuerId } });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /エラー/);
  assert.ok(!result.stderr.includes(credentials.keyP8));
  assert.ok(runCli);
});

test('the p12 is importable by macOS security (real keychain, skipped elsewhere)', { skip: process.platform !== 'darwin' }, async (t) => {
  const { out, run } = await setup(t);
  const result = await run();
  const keychain = join(out, 'test.keychain-db');
  const password = await readFile(result.passwordPath, 'utf8');
  execFileSync('security', ['create-keychain', '-p', 'pw', keychain]);
  t.after(() => { try { execFileSync('security', ['delete-keychain', keychain]); } catch { /* already gone */ } });
  execFileSync('security', ['import', result.p12Path, '-k', keychain, '-P', password, '-f', 'pkcs12', '-A'], { stdio: 'pipe' });
  assert.match(execFileSync('security', ['find-identity', '-p', 'basic', keychain], { encoding: 'utf8' }), /1 identities found|1 valid identities found|CN=/);
});
