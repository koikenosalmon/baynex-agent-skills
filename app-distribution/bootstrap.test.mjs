import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrap, pairApps } from './bootstrap.mjs';

const ios = [
  { appId: '1:000000000000:ios:abc', displayName: 'Example Coach iOS dev', bundleId: 'com.example.coach' },
  { appId: '1:000000000000:ios:def', displayName: 'Unpaired iOS', bundleId: 'com.example.unpaired' },
];
const android = [
  { appId: '1:000000000000:android:abc', displayName: 'Example Coach Android dev', packageName: 'com.example.shell.coach' },
  { appId: '1:000000000000:android:def', displayName: 'Other Android', packageName: 'com.example.other' },
];

test('pairs only unique iOS and Android apps and preserves confirmed build settings', () => {
  const old = [{ id: 'coach', iosBundleId: 'com.example.coach', flavor: 'coach', target: 'lib/main_coach.dart', appleAccount: 'old' }];
  const pairs = pairApps(ios, android, old, 'example');
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].flavor, 'coach');
  assert.equal(pairs[0].target, 'lib/main_coach.dart');
  assert.equal(pairs[0].appleAccount, 'old');
  assert.deepEqual(pairs[0].firebaseAppIds, { ios: ios[0].appId, android: android[0].appId });
});

test('rerun keeps the confirmed app list and display names unless new apps are requested', () => {
  const extraIos = { appId: '1:000000000000:ios:ghi', displayName: 'Legacy iOS', bundleId: 'com.example.legacy' };
  const extraAndroid = { appId: '1:000000000000:android:ghi', displayName: 'Legacy Android', packageName: 'com.example.legacy' };
  const old = [{ id: 'coach', displayName: 'Example Coach', iosBundleId: 'com.example.coach', flavor: 'coach', target: 'lib/main_coach.dart', appleAccount: 'example' }];
  const original = console.log;
  console.log = () => {};
  try {
    const kept = pairApps([ios[0], extraIos], [android[0], extraAndroid], old, 'example', { includeNew: false });
    assert.deepEqual(kept.map((app) => app.id), ['coach']);
    assert.equal(kept[0].displayName, 'Example Coach');
    const widened = pairApps([ios[0], extraIos], [android[0], extraAndroid], old, 'example', { includeNew: true });
    assert.deepEqual(widened.map((app) => app.id), ['coach', 'legacy']);
    assert.equal(widened[1].flavor, 'TODO');
  } finally { console.log = original; }
});

test('dry run discovers apps without writing config or printing the OAuth token', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'app-kit-bootstrap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = join(dir, 'apps.json');
  const calls = [];
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await bootstrap({ project: 'example-dev', repo: 'example/app', appleAccount: 'example', out, dryRun: true }, {
      gcloud: (args) => {
        calls.push(args);
        if (args[0] === 'projects') return '000000000000';
        if (args[0] === 'services') return '';
        if (args[0] === 'auth') return 'private-token';
        throw new Error(`unexpected gcloud command: ${args.join(' ')}`);
      },
      ensureResource: () => {},
      grantAppleAccount: () => {},
      fetch: async (url, options) => {
        assert.equal(options.headers['x-goog-user-project'], 'example-dev');
        assert.equal(options.headers.Authorization, 'Bearer private-token');
        return { ok: true, json: async () => ({ apps: String(url).includes('/iosApps') ? [ios[0]] : [android[0]] }) };
      },
    });
  } finally { console.log = original; }
  await assert.rejects(() => readFile(out), { code: 'ENOENT' });
  assert.equal(calls.filter((args) => args[0] === 'auth').length, 1);
  assert.ok(!lines.join('\n').includes('private-token'));
});

test('bootstrap writes caller config and checks both Firebase distributions', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'app-kit-bootstrap-write-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = join(dir, 'apps.json');
  const releaseUrls = [];
  const bindings = [];
  const original = console.log;
  console.log = () => {};
  let config;
  try { config = await bootstrap({ project: 'example-dev', repo: 'example/app', appleAccount: 'example', out }, {
    gcloud: (args) => {
      if (args[0] === 'projects' && args[1] === 'describe') return '000000000000';
      if (args[0] === 'services' && args[1] === 'list') return ['iam', 'iamcredentials', 'sts', 'firebaseappdistribution', 'firebase'].map((api) => `${api}.googleapis.com`).join('\n');
      if (args[0] === 'auth') return 'private-token';
      if (args.includes('add-iam-policy-binding')) { bindings.push(args); return ''; }
      throw new Error(`unexpected gcloud command: ${args.join(' ')}`);
    },
    ensureResource: () => {},
    grantAppleAccount: () => {},
    fetch: async (url, options) => {
      assert.equal(options.headers['x-goog-user-project'], 'example-dev');
      if (String(url).includes('/iosApps')) return { ok: true, json: async () => ({ apps: [ios[0]] }) };
      if (String(url).includes('/androidApps')) return { ok: true, json: async () => ({ apps: [android[0]] }) };
      releaseUrls.push(String(url));
      return { status: 200 };
    },
  }); } finally { console.log = original; }
  assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), config);
  assert.equal(config.apps[0].flavor, 'TODO');
  assert.equal(releaseUrls.length, 2);
  assert.equal(bindings.length, 2);
  for (const args of bindings) assert.ok(args.includes('--condition=None'), 'IAM bindings must work on policies that already contain conditions');
  assert.ok(!(await readFile(out, 'utf8')).includes('private-token'));
});
