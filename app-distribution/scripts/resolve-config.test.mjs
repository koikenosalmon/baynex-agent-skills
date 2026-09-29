import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeConfig, resolveConfig, runCli } from './resolve-config.mjs';
import { validateApps } from './app-store-connect.mjs';
import { fakeFetch, json, oidcEnv } from './baynex-test-helpers.mjs';

const account = { secretProject: 'baynex-shared', keyP8Secret: 'apple-example-key-p8', keyIdSecret: 'apple-example-key-id', issuerIdSecret: 'apple-example-issuer-id' };
const repoApp = { id: 'coach', displayName: 'Repo Coach', flavor: 'coach', target: 'lib/main_coach.dart', appleAccount: 'example', iosBundleId: 'com.repo.coach', firebaseAppIds: { ios: '1:1:ios:repo', android: '1:1:android:repo' } };
const repo = { appDir: 'mobile', flutterVersion: '3.10.0', privateGitDependencies: ['repo/dep'], gcp: { workloadIdentityProvider: 'projects/1/providers/x', uploaderServiceAccount: 'ci@p.iam.gserviceaccount.com' }, appleAccounts: { example: account }, apps: [repoApp] };
const remote = (extra = {}) => ({
  schemaVersion: 1, productId: 'prod_1', revision: 7, mode: 'baynex', appDir: '', firebaseProject: 'baynex-fb', flutterVersion: '3.41.9', privateGitDependencies: ['org/private'],
  releaseBranchPatterns: ['release/*'], apple: { name: 'Baynex Apple', available: true, cloudSigning: true }, buildNumber: { offset: 500, suggestedOffset: 600 }, branch: { kind: 'qa', version: null },
  apps: [{ id: 'coach', channel: 'qa', displayName: 'Baynex Coach', iosBundleId: 'com.baynex.coach', androidPackage: 'com.baynex.coach', firebaseAppIds: { ios: '1:1:ios:bx', android: '1:1:android:bx' }, flavor: '', target: null }],
  ...extra,
});

test('mode baynex: Baynex infra facts win, repo keeps what Baynex lacks', () => {
  const merged = mergeConfig(repo, remote());
  assert.equal(merged.appDir, 'mobile', 'empty Baynex appDir keeps the repo value');
  assert.equal(merged.flutterVersion, '3.41.9');
  assert.deepEqual(merged.privateGitDependencies, ['org/private']);
  assert.equal(merged.buildNumberOffset, 500);
  assert.equal(merged.firebaseProject, 'baynex-fb');
  const [app] = merged.apps;
  assert.equal(app.iosBundleId, 'com.baynex.coach');
  assert.deepEqual(app.firebaseAppIds, { ios: '1:1:ios:bx', android: '1:1:android:bx' });
  assert.equal(app.flavor, 'coach');
  assert.equal(app.target, 'lib/main_coach.dart');
  assert.equal(app.appleAccount, 'example');
  assert.deepEqual(merged.gcp, repo.gcp);
  assert.deepEqual(merged.baynex.apple, { name: 'Baynex Apple', available: true, cloudSigning: true });
  assert.equal(merged.baynex.productId, 'prod_1');
  assert.equal(repo.apps[0].iosBundleId, 'com.repo.coach', 'input is not mutated');
});

test('mode baynex: an empty Baynex dependency list keeps the repo list; extra Baynex apps are appended', () => {
  const merged = mergeConfig(repo, remote({ privateGitDependencies: [], apps: [...remote().apps, { id: 'extra', displayName: 'Extra', iosBundleId: 'com.baynex.extra', firebaseAppIds: { ios: 'i', android: 'a' }, flavor: 'extra', target: 'lib/main_extra.dart' }] }));
  assert.deepEqual(merged.privateGitDependencies, ['repo/dep']);
  assert.deepEqual(merged.apps.map((app) => app.id), ['coach', 'extra']);
});

test('mode repo: apps.json is untouched except a missing buildNumberOffset', () => {
  const repoMode = remote({ mode: 'repo' });
  const merged = mergeConfig(repo, repoMode);
  assert.equal(merged.buildNumberOffset, 500);
  assert.equal(merged.flutterVersion, '3.10.0');
  assert.equal(merged.apps[0].iosBundleId, 'com.repo.coach');
  assert.deepEqual(merged.privateGitDependencies, ['repo/dep']);
  assert.equal(mergeConfig({ ...repo, buildNumberOffset: 12 }, repoMode).buildNumberOffset, 12);
  assert.equal(mergeConfig({ ...repo, buildNumberOffset: 0 }, repoMode).buildNumberOffset, 0);
});

test('without apps.json the effective config is generated from Baynex, in either mode', () => {
  for (const mode of ['baynex', 'repo']) {
    const merged = mergeConfig(undefined, remote({ mode, appDir: 'app' }));
    assert.equal(merged.appDir, 'app');
    assert.equal(merged.apps[0].iosBundleId, 'com.baynex.coach');
    assert.equal(merged.buildNumberOffset, 500);
  }
  assert.equal(mergeConfig(repo, null).baynex, undefined);
});

test('appleAccount / appleAccounts are optional only when Baynex provides Apple credentials', () => {
  const generated = mergeConfig(undefined, remote({ apps: [{ ...remote().apps[0], flavor: 'coach', target: 'lib/main.dart' }] }));
  assert.equal(validateApps(generated).length, 1);
  const noApple = mergeConfig(undefined, remote({ apple: { name: '', available: false, cloudSigning: false } }));
  assert.throws(() => validateApps(noApple), /appleAccounts/);
  assert.throws(() => validateApps({ ...generated, baynex: undefined }), /appleAccounts/);
  const withRepoAccount = { ...generated, appleAccounts: { example: account } };
  assert.throws(() => validateApps({ ...withRepoAccount, apps: [{ ...generated.apps[0], appleAccount: 'missing' }] }), /Apple アカウント参照/);
});

test('denied, unreachable and unsupported responses fall back to apps.json with a status', async () => {
  for (const [respond, status] of [[() => json({ error: 'ci_denied' }, 403), 'denied'], [() => json({ error: 'ci_unavailable' }, 503), 'unreachable'], [() => { throw new Error('offline'); }, 'unreachable'], [() => json({ schemaVersion: 2 }), 'unreachable']]) {
    const { fetch } = fakeFetch(respond);
    const result = await resolveConfig({ repoConfig: repo, env: oidcEnv, fetch, print: () => {} });
    assert.equal(result.status, status);
    assert.deepEqual(result.config, repo);
    assert.ok(result.warning);
  }
  const noOidc = await resolveConfig({ repoConfig: repo, env: {}, fetch: async () => { throw new Error('no fetch'); }, print: () => {} });
  assert.equal(noOidc.status, 'unreachable');
});

test('the CLI writes the effective config, points DISTRIBUTION_CONFIG at it and never prints tokens', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'resolve-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'apps.json'), JSON.stringify(repo));
  await writeFile(join(dir, 'env'), '');
  const { fetch } = fakeFetch(() => json(remote()));
  const out = [];
  const err = [];
  const env = { ...oidcEnv, RUNNER_TEMP: dir, GITHUB_ENV: join(dir, 'env') };
  const result = await runCli(['--config', join(dir, 'apps.json')], env, fetch, (l) => out.push(l), (l) => err.push(l));
  const written = JSON.parse(await readFile(result.target, 'utf8'));
  assert.equal(written.flutterVersion, '3.41.9');
  const githubEnv = await readFile(join(dir, 'env'), 'utf8');
  assert.match(githubEnv, new RegExp(`DISTRIBUTION_CONFIG=${result.target}\\nBAYNEX_CI_STATUS=ok\\nBAYNEX_CI_MODE=baynex\\n`));
  assert.ok((await stat(result.target)).isFile());
  assert.ok(![...out.filter((l) => !l.startsWith('::add-mask::')), ...err].join('\n').includes('oidc-token'));
});

test('the CLI fails when neither apps.json nor Baynex can supply apps, and warns when denied with apps.json', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'resolve-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const denied = fakeFetch(() => json({ error: 'ci_denied' }, 403)).fetch;
  await assert.rejects(() => runCli(['--config', join(dir, 'missing.json')], { ...oidcEnv, RUNNER_TEMP: dir }, denied, () => {}, () => {}), /Baynex からもアプリを取得できません/);
  await writeFile(join(dir, 'apps.json'), JSON.stringify(repo));
  const err = [];
  const result = await runCli(['--config', join(dir, 'apps.json')], { ...oidcEnv, RUNNER_TEMP: dir }, denied, () => {}, (l) => err.push(l));
  assert.equal(result.status, 'denied');
  assert.match(err.join('\n'), /拒否/);
  const generated = await runCli(['--config', join(dir, 'missing.json')], { ...oidcEnv, RUNNER_TEMP: dir }, fakeFetch(() => json(remote({ apps: [{ ...remote().apps[0], flavor: 'coach', target: 'lib/main.dart' }] }))).fetch, () => {}, () => {});
  assert.equal(JSON.parse(await readFile(generated.target, 'utf8')).apps[0].flavor, 'coach');
});
