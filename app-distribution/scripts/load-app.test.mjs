import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appEnvironment } from './load-app.mjs';

const account = { secretProject: 'baynex-shared', keyP8Secret: 'apple-example-key-p8', keyIdSecret: 'apple-example-key-id', issuerIdSecret: 'apple-example-issuer-id' };
const config = {
  appDir: 'mobile', flutterVersion: '3.41.9', gcp: { workloadIdentityProvider: 'projects/1/providers/github', uploaderServiceAccount: 'ci@p.iam.gserviceaccount.com' },
  appleAccounts: { example: account },
  apps: ['one', 'two'].map((id, index) => ({ id, displayName: `App ${id}`, flavor: id, target: `lib/main_${id}.dart`, appleAccount: 'example', iosBundleId: `com.example.${id}`, firebaseAppIds: { ios: `1:1:ios:${index}`, android: `1:1:android:${index}` } })),
};

test('an app is re-read by index with its config values', () => {
  const values = appEnvironment(config, '1', {}, '/nonexistent');
  assert.equal(values.APP_ID, 'two');
  assert.equal(values.APP_DIR, 'mobile');
  assert.equal(values.FLUTTER_VERSION, '3.41.9');
  assert.equal(values.FIREBASE_APP_ID_IOS, '1:1:ios:1');
  assert.equal(values.FIREBASE_APP_ID_ANDROID, '1:1:android:1');
  assert.equal(values.APP_FLAVOR, 'two');
  assert.equal(values.WIF_PROVIDER, 'projects/1/providers/github');
  assert.equal(values.PRODUCT_ID, '');
});

test('variables override config and defaults apply', () => {
  const values = appEnvironment({ ...config, appDir: undefined, flutterVersion: undefined }, 0, { WIF_PROVIDER_OVERRIDE: 'override', PRODUCT_ID_OVERRIDE: 'prod-1' }, '/nonexistent');
  assert.equal(values.APP_DIR, 'native');
  assert.equal(values.FLUTTER_VERSION, '');
  assert.equal(values.WIF_PROVIDER, 'override');
  assert.equal(values.PRODUCT_ID, 'prod-1');
});

test('bad indices and values that could inject environment lines are rejected', () => {
  for (const index of ['2', '-1', 'x', '', '1e1', '001x']) assert.throws(() => appEnvironment(config, index), /index/, index);
  const injected = { ...config, apps: [{ ...config.apps[0], flavor: 'a\nPATH=/evil' }] };
  assert.throws(() => appEnvironment(injected, 0), /制御文字/);
});

test('the CLI appends the app to GITHUB_ENV', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'load-app-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'apps.json'), JSON.stringify(config));
  await writeFile(join(dir, 'env'), '');
  const script = new URL('./load-app.mjs', import.meta.url).pathname;
  execFileSync('node', [script, '1', '--config', join(dir, 'apps.json')], { env: { ...process.env, GITHUB_ENV: join(dir, 'env') } });
  const lines = (await readFile(join(dir, 'env'), 'utf8')).trim().split('\n');
  assert.ok(lines.includes('APP_ID=two') && lines.includes('APP_DIR=mobile'));
});

test('appleAccount may be absent and the product id can come from Baynex', () => {
  const { appleAccounts, ...rest } = config;
  const app = { ...rest.apps[0] };
  delete app.appleAccount;
  const values = appEnvironment({ ...rest, apps: [app], baynex: { productId: 'prod_9', apple: { available: true } } }, 0, {}, '/nonexistent');
  assert.equal(values.APP_APPLE_ACCOUNT, '');
  assert.equal(values.PRODUCT_ID, 'prod_9');
  assert.equal(appEnvironment({ ...rest, apps: [app], baynex: { productId: 'prod_9', apple: { available: true } } }, 0, { PRODUCT_ID_OVERRIDE: 'override' }, '/nonexistent').PRODUCT_ID, 'override');
});

// 署名でプロファイルを引くには bundle identifier が要る。設定にはあるのに
// ビルドへ渡っていなかった。
test('iOS の bundle identifier をビルドへ渡す', () => {
  const values = appEnvironment({ ...config, apps: [{ ...config.apps[0], iosBundleId: 'com.example.app' }] }, 0);
  assert.equal(values.APP_IOS_BUNDLE_ID, 'com.example.app');
});
