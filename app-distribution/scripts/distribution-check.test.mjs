import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeFetch, json as jsonResponse, oidcEnv } from './baynex-test-helpers.mjs';
import { runCheck, distributionNotStarted, findInheritingCallers, findSecretCollisions } from './distribution-check.mjs';

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
  const spawn = () => ({ status: 0 });
  const run = (config, env) => runCheck({ config: { appleAccounts: accounts, apps, ...config }, env: { AUTH_OUTCOME: 'failure', ...env }, print: () => {}, spawn, fetch: async () => response({}, 404) });
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

test('check reports the pinned Flutter version and rejects a malformed one', async () => {
  const run = (config) => runCheck({ config: { appleAccounts: accounts, apps, ...config }, env: { AUTH_OUTCOME: 'failure' }, print: () => {}, fetch: async () => response({}, 404) });
  assert.ok(!(await run({})).summary.includes('Flutter バージョン'));
  assert.match((await run({ flutterVersion: '3.41.9' })).summary, /Flutter バージョン \| ✅ \| CI は 3\.41\.9 に固定/);
  await assert.rejects(() => run({ flutterVersion: 'stable' }), /flutterVersion/);
});

const oneApp = [apps[0]];
const oneAccount = { example: accounts.example };
function fullFetch({ usersStatus = 200, buildVersions = [] } = {}) {
  return async (url, options) => {
    const address = String(url);
    if (address.includes('secretmanager.googleapis.com')) return response({ payload: { data: Buffer.from(values[address.split('/')[7]]).toString('base64') } });
    if (address.includes('/v1/users')) return response({ data: [] }, usersStatus);
    if (address.includes('api.appstoreconnect.apple.com')) {
      if (address.includes('limit=1')) return response({ data: [] });
      return response({ data: [{ attributes: { identifier: 'com.example.example', seedId: 'ABCDE12345' } }] });
    }
    if (address.includes('/releases?')) return response({ releases: buildVersions.map((buildVersion) => ({ displayVersion: '1.0.0', buildVersion: String(buildVersion) })) });
    if (address.includes('testers:getTesterUdids')) return response({ testerUdids: [] });
    throw new Error(`Unexpected URL: ${address}`);
  };
}
const googleEnv = { WIF_PROVIDER: 'provider', WIF_SERVICE_ACCOUNT: 'service-account', AUTH_OUTCOME: 'success', GOOGLE_OAUTH_ACCESS_TOKEN: 'token' };
const runFull = (options, env = {}, config = {}) => runCheck({ config: { appleAccounts: oneAccount, apps: oneApp, ...config }, env: { ...googleEnv, ...env }, print: () => {}, fetch: fullFetch(options) });

test('check reports which declared secrets arrived, by presence only', async () => {
  const result = await runCheck({ config: { appleAccounts: accounts, apps }, env: { AUTH_OUTCOME: 'failure', ANDROID_KEY_ALIAS: 'upload-alias-value', GIT_DEPENDENCY_TOKEN_SET: 'true' }, print: () => {}, fetch: async () => response({}, 404) });
  assert.match(result.summary, /GitHub Secrets \| ANDROID_KEY_ALIAS \| ✅/);
  assert.match(result.summary, /GitHub Secrets \| GIT_DEPENDENCY_TOKEN \| ✅/);
  assert.match(result.summary, /GitHub Secrets \| APP_STORE_CONNECT_KEY_P8 \| ⚠️ \| 受信していません/);
  assert.ok(!result.summary.includes('upload-alias-value'));
});

test('check flags secrets: inherit only when the caller owner differs from the kit owner', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'caller-workflows-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'app-distribution.yml'), 'jobs:\n  distribute:\n    uses: koikenosalmon/baynex-agent-skills/.github/workflows/app-distribution.yml@v1\n    with:\n      kit-ref: v1\n    secrets: inherit\n');
  await writeFile(join(dir, 'other.yaml'), 'jobs:\n  a:\n    uses: someone/else/.github/workflows/x.yml@v1\n    secrets: inherit\n  b:\n    uses: koikenosalmon/baynex-agent-skills/.github/workflows/app-distribution-check.yml@v1\n    secrets:\n      A: ${{ secrets.A }}\n');
  await writeFile(join(dir, 'commented.yml'), 'jobs:\n  a:\n    uses: koikenosalmon/baynex-agent-skills/.github/workflows/app-distribution.yml@v1\n    # secrets: inherit\n');
  assert.deepEqual(await findInheritingCallers(dir), ['app-distribution.yml']);
  const run = (env) => runCheck({ config: { appleAccounts: accounts, apps }, env: { AUTH_OUTCOME: 'failure', ...env }, workflowsDir: dir, print: () => {}, fetch: async () => response({}, 404) });
  const cross = await run({ CALLER_OWNER: 'OTERA-Co-Ltd' });
  assert.equal(cross.failed, true);
  assert.match(cross.summary, /Caller \| app-distribution\.yml \| ❌ .*secrets: inherit.*cross-owner/);
  assert.ok(!/Caller \| (other|commented)/.test(cross.summary));
  const same = await run({ CALLER_OWNER: 'KoikenoSalmon' });
  assert.ok(!same.summary.includes('| Caller |'));
  assert.deepEqual(await findInheritingCallers(join(dir, 'missing')), []);
  await rm(join(dir, 'app-distribution.yml'));
  assert.match((await run({ CALLER_OWNER: 'OTERA-Co-Ltd' })).summary, /Caller \| 別オーナーからの呼び出し \| ✅/);
});

test('masked-value collisions name the secret and config key but never the value', async () => {
  const config = { appleAccounts: accounts, apps: [{ ...apps[0], displayName: 'Zq9top Coach' }, apps[1]], gcp: { uploaderServiceAccount: 'ci@example.iam.gserviceaccount.com' } };
  assert.deepEqual(findSecretCollisions({ ANDROID_KEY_ALIAS: 'Zq9top', SHORT: 'ab', BLANK: '' }, config), [{ secret: 'ANDROID_KEY_ALIAS', path: 'apps[0].displayName' }]);
  assert.deepEqual(findSecretCollisions({ A: 'first-line-none\nci@example' }, config), [{ secret: 'A', path: 'gcp.uploaderServiceAccount' }]);
  const result = await runCheck({ config, env: { AUTH_OUTCOME: 'failure', ANDROID_KEY_ALIAS: 'Zq9top', APP_STORE_CONNECT_KEY_ID: 'ab' }, print: () => {}, fetch: async () => response({}, 404) });
  assert.equal(result.failed, true);
  assert.match(result.summary, /Secret マスク \| ANDROID_KEY_ALIAS \| ❌ .*apps\[0\]\.displayName/);
  assert.ok(!result.summary.includes('Zq9top'));
  assert.ok(!/Secret マスク \| APP_STORE_CONNECT_KEY_ID/.test(result.summary));
  const clean = await runCheck({ config: { appleAccounts: accounts, apps }, env: { AUTH_OUTCOME: 'failure', ANDROID_KEY_ALIAS: 'unrelated-alias' }, print: () => {}, fetch: async () => response({}, 404) });
  assert.match(clean.summary, /Secret マスク \| apps\.json との衝突 \| ✅/);
});

test('Apple cloud-signing permission maps /v1/users 200, 403 and other statuses', async () => {
  const ok = await runFull({ usersStatus: 200 });
  assert.match(ok.summary, /Apple example \| クラウド署名の権限 \| ✅/);
  const forbidden = await runFull({ usersStatus: 403 });
  assert.equal(forbidden.failed, true);
  assert.match(forbidden.summary, /クラウド署名の権限 \| ❌ \| Admin のチームキーが必要/);
  const unknown = await runFull({ usersStatus: 500 });
  assert.match(unknown.summary, /クラウド署名の権限 \| ⚠️ \| 判定できません（HTTP 500）/);
});

test('private dependency rows run git ls-remote with the configured credential and fail on errors', async () => {
  const calls = [];
  let keyFile;
  const spawn = (command, args, options) => {
    calls.push({ command, args, env: options.env });
    if (options.env.GIT_SSH_COMMAND) { keyFile = options.env.GIT_SSH_COMMAND.match(/-i '([^']+)'/)[1]; assert.ok(existsSync(keyFile)); }
    return { status: args[1].includes('broken') ? 128 : 0 };
  };
  const run = (env, repos) => runCheck({ config: { appleAccounts: accounts, apps, privateGitDependencies: repos }, env: { AUTH_OUTCOME: 'failure', ...env }, spawn, print: () => {}, fetch: async () => response({}, 404) });
  const token = await run({ GIT_DEPENDENCY_TOKEN: 'ghp_secretvalue' }, ['org/private', 'org/broken']);
  assert.match(token.summary, /org\/private 到達性 \| ✅ \| git ls-remote 成功（トークン）/);
  assert.match(token.summary, /org\/broken 到達性 \| ❌ \| git ls-remote に失敗（終了コード 128）/);
  assert.equal(token.failed, true);
  assert.ok(!token.summary.includes('ghp_secretvalue'));
  for (const call of calls) {
    assert.equal(call.command, 'git');
    assert.ok(!call.args.join(' ').includes('ghp_secretvalue'), 'token must not appear in argv');
    assert.match(call.env.GIT_CONFIG_VALUE_0, /^AUTHORIZATION: basic /);
  }
  const ssh = await run({ GIT_DEPENDENCY_SSH_KEY: '-----BEGIN KEY-----\nabc\n-----END KEY-----', GIT_DEPENDENCY_TOKEN: 'ghp_x' }, ['org/private']);
  assert.match(ssh.summary, /org\/private 到達性 \| ✅ \| git ls-remote 成功（SSH 鍵）/);
  assert.equal(calls.at(-1).args[1], 'git@github.com:org/private.git');
  assert.equal(existsSync(keyFile), false);
  const before = calls.length;
  const none = await run({}, ['org/private']);
  assert.equal(calls.length, before);
  assert.ok(!none.summary.includes('到達性'));
});

test('build number row warns when run_number + offset is lower than the newest Firebase build', async () => {
  const low = await runFull({ buildVersions: [7, 50, 12] }, { RUN_NUMBER: '10' });
  assert.match(low.summary, /ビルド番号 \| example ios \| ⚠️ \| .*= 10、Firebase の最大 50/);
  assert.equal(low.failed, false);
  const offset = await runFull({ buildVersions: [7, 50, 12] }, { RUN_NUMBER: '10' }, { buildNumberOffset: 100 });
  assert.match(offset.summary, /ビルド番号 \| example android \| ✅ \| .*= 110、Firebase の最大 50/);
  const none = await runFull({ buildVersions: [] }, { RUN_NUMBER: '10' });
  assert.ok(!none.summary.includes('ビルド番号'));
  assert.ok(!(await runFull({ buildVersions: [50] })).summary.includes('ビルド番号'));
  await assert.rejects(() => runFull({}, {}, { buildNumberOffset: -1 }), /buildNumberOffset/);
});

const bxToken = 'eyJhbGciOiJFUzI1NiJ9.baynex-check.signature-value';
function baynexRun(baynex, env = {}, config = { appleAccounts: accounts, apps }) {
  const inner = fakeFetch(baynex);
  const seen = [];
  const fetch = async (url, options) => {
    const address = String(url);
    if (address.includes('api.appstoreconnect.apple.com')) { seen.push(options.headers.Authorization); return jsonResponse({ data: address.includes('limit=1') ? [] : [{ attributes: { identifier: 'com.example.example', seedId: 'ABCDE12345' } }] }); }
    if (address.includes('secretmanager.googleapis.com')) return jsonResponse({ payload: { data: Buffer.from(values[address.split('/')[7]]).toString('base64') } });
    if (address.includes('firebaseappdistribution') || address.includes('testers')) return jsonResponse({}, 404);
    return inner.fetch(url, options);
  };
  return runCheck({ config, env: { ...oidcEnv, ...env }, print: () => {}, fetch }).then((result) => ({ result, seen }));
}

test('check shows Baynex OIDC as the key route and the CI access row', async () => {
  const { result, seen } = await baynexRun(() => jsonResponse({ token: bxToken, teamId: 'ABCDE12345', expiresAt: 'x' }), { BAYNEX_CI_STATUS: 'ok', BAYNEX_CI_MODE: 'baynex' }, { apps: [{ ...apps[0], appleAccount: undefined }], baynex: { revision: 3, apple: { name: 'Baynex Apple', available: true } } });
  assert.match(result.summary, /Baynex \| CI アクセス \| ✅ \| 許可されています（mode=baynex、revision 3）/);
  assert.match(result.summary, /鍵の取得経路 \| Apple \| ✅ \| Baynex OIDC/);
  assert.match(result.summary, /Apple Baynex Apple \| キー \| ✅/);
  assert.ok(seen.length && seen.every((value) => value === `Bearer ${bxToken}`));
  assert.ok(!result.summary.includes(bxToken) && !result.summary.includes('oidc-token'));
});

test('check shows denied Baynex access and the Secret Manager or GitHub Secrets route', async () => {
  const denied = () => jsonResponse({ error: 'ci_denied' }, 403);
  const smRun = await baynexRun(denied, { BAYNEX_CI_STATUS: 'denied', AUTH_OUTCOME: 'success', GOOGLE_OAUTH_ACCESS_TOKEN: 'token', WIF_PROVIDER: 'p', WIF_SERVICE_ACCOUNT: 's' });
  assert.match(smRun.result.summary, /Baynex \| CI アクセス \| ⚠️ \| 拒否されました（ci_denied）/);
  assert.match(smRun.result.summary, /鍵の取得経路 \| Apple \| ✅ \| Secret Manager/);
  assert.equal(smRun.result.summary.includes('Baynex OIDC'), false);
  const legacy = await baynexRun(denied, { APP_STORE_CONNECT_KEY_P8: keyP8, APP_STORE_CONNECT_KEY_ID: 'ABC1234567', APP_STORE_CONNECT_ISSUER_ID: '12345678-1234-1234-1234-123456789abc' });
  assert.match(legacy.result.summary, /Baynex \| CI アクセス \| ⚠️ \| 未確認/);
  assert.match(legacy.result.summary, /鍵の取得経路 \| Apple \| ✅ \| GitHub Secrets/);
  assert.ok(!legacy.result.summary.includes('MIG'));
});

test('a Baynex asc-token failure (429) falls back to the next key route', async () => {
  const { result } = await baynexRun(() => jsonResponse({ error: 'ci_rate_limited' }, 429), { BAYNEX_CI_STATUS: 'ok', BAYNEX_CI_MODE: 'repo' });
  assert.match(result.summary, /鍵の取得経路 \| Apple \| ⚠️ \| 取得できる経路がありません/);
});

test('check warns when many Apple Development certificates were created via the API', async () => {
  const run = (certificates) => runCheck({
    config: { appleAccounts: { example: accounts.example }, apps: [apps[0]] },
    env: { AUTH_OUTCOME: 'success', GOOGLE_OAUTH_ACCESS_TOKEN: 'token', WIF_PROVIDER: 'p', WIF_SERVICE_ACCOUNT: 's' },
    print: () => {},
    fetch: async (url) => {
      const address = String(url);
      if (address.includes('secretmanager.googleapis.com')) return response({ payload: { data: Buffer.from(values[address.split('/')[7]]).toString('base64') } });
      if (address.includes('/v1/certificates')) return response({ data: certificates });
      if (address.includes('api.appstoreconnect.apple.com')) return response({ data: address.includes('limit=1') ? [] : [{ attributes: { identifier: 'com.example.example', seedId: 'ABCDE12345' } }] });
      return response({}, 404);
    },
  });
  const made = (count) => Array.from({ length: count }, () => ({ attributes: { certificateType: 'IOS_DEVELOPMENT', name: 'Created via API' } }));
  const few = await run(made(4));
  assert.match(few.summary, /API 作成の Development 証明書 \| ✅ \| 4 件/);
  const many = await run(made(5));
  assert.match(many.summary, /API 作成の Development 証明書 \| ⚠️ \| .*5 件/);
  assert.ok(!/API 作成の Development 証明書 \| ❌/.test(many.summary));
});
