import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accessSecret, runCli } from './secret-manager.mjs';

const response = (data, status = 200) => ({ ok: status < 300, status, json: async () => data });
const secret = (value, crc) => response({ payload: { data: Buffer.from(value).toString('base64'), ...(crc === undefined ? {} : { dataCrc32c: crc }) } });
async function configFile(directory) {
  const path = join(directory, 'apps.json');
  await writeFile(path, JSON.stringify({ appleAccounts: { example: { secretProject: 'baynex-shared', keyP8Secret: 'apple-example-key-p8', keyIdSecret: 'apple-example-key-id', issuerIdSecret: 'apple-example-issuer-id' } } }));
  return path;
}

test('accesses and verifies Secret Manager payload', async () => {
  const value = await accessSecret({ project: 'baynex-shared', name: 'apple-example-key-id', token: 'private-token', fetch: async (url, options) => {
    assert.equal(url, 'https://secretmanager.googleapis.com/v1/projects/baynex-shared/secrets/apple-example-key-id/versions/latest:access');
    assert.equal(options.headers.Authorization, 'Bearer private-token');
    return secret('123456789', '3808858755');
  } });
  assert.equal(value, '123456789');
});

test('maps 404 and 403 to actionable messages without token exposure', async () => {
  for (const [status, pattern] of [[404, /値がまだありません（Secret Manager で新しいバージョンを追加してください）/], [403, /読む権限がありません/]]) {
    await assert.rejects(() => accessSecret({ project: 'baynex-shared', name: 'apple-example-key-id', token: 'private-token', fetch: async () => response({}, status) }), (error) => pattern.test(error.message) && !error.message.includes('private-token'));
  }
});

test('rejects CRC mismatch and oversized payloads', async () => {
  await assert.rejects(() => accessSecret({ project: 'baynex-shared', name: 'key', token: 'token', fetch: async () => secret('123456789', '1') }), /CRC32C/);
  await assert.rejects(() => accessSecret({ project: 'baynex-shared', name: 'key', token: 'token', fetch: async () => secret('x'.repeat(1024 * 1024 + 1)) }), /サイズ|不正/);
});

test('CLI writes account files with 0600 and masks identifiers only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'apple-account-test-'));
  const config = await configFile(directory);
  const lines = [];
  const values = { 'apple-example-key-p8': 'private-p8', 'apple-example-key-id': 'ABC1234567', 'apple-example-issuer-id': '12345678-1234-1234-1234-123456789abc' };
  try {
    await runCli(['load-account', 'example', directory, '--config', config], { GOOGLE_OAUTH_ACCESS_TOKEN: 'token' }, async (url) => secret(values[url.split('/')[7]]), (line) => lines.push(line));
    for (const [name, expected] of [['app-store-connect.p8', values['apple-example-key-p8']], ['app-store-connect-key-id', values['apple-example-key-id']], ['app-store-connect-issuer-id', values['apple-example-issuer-id']]]) {
      const path = join(directory, name);
      assert.equal(await readFile(path, 'utf8'), expected);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
    assert.deepEqual(lines, [`::add-mask::${values['apple-example-key-id']}`, `::add-mask::${values['apple-example-issuer-id']}`]);
    assert.ok(!lines.join('\n').includes('private-p8'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('legacy fallback requires all three values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'apple-legacy-test-'));
  const config = await configFile(directory);
  try {
    await assert.rejects(() => runCli(['load-account', 'example', directory], { DISTRIBUTION_CONFIG: config, APP_STORE_CONNECT_KEY_ID: 'ABC1234567' }, async () => { throw new Error('fetch must not run'); }, () => {}), /3 件そろった/);
    await runCli(['load-account', 'example', directory], { DISTRIBUTION_CONFIG: config, APP_STORE_CONNECT_KEY_P8: 'legacy-p8', APP_STORE_CONNECT_KEY_ID: 'ABC1234567', APP_STORE_CONNECT_ISSUER_ID: 'issuer-id' }, async () => { throw new Error('fetch must not run'); }, () => {});
    assert.equal(await readFile(join(directory, 'app-store-connect.p8'), 'utf8'), 'legacy-p8');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// 配布証明書。cloud signing は Xcode 自身が作った証明書の秘密鍵が手元にある前提で
// 動くので、まっさらな runner では成立しない。秘密鍵ごと Secret Manager から渡す。
// 設定していないリポジトリの挙動は変えてはいけない。
async function configWithDistribution(directory) {
  const path = join(directory, 'apps.json');
  await writeFile(path, JSON.stringify({ appleAccounts: { example: { secretProject: 'baynex-shared', keyP8Secret: 'apple-example-key-p8', keyIdSecret: 'apple-example-key-id', issuerIdSecret: 'apple-example-issuer-id', distributionP12Secret: 'apple-example-distribution-p12' } } }));
  return path;
}

test('配布証明書を設定したときだけ取りに行き、p12 として書き出す', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kit-dist-'));
  try {
    const config = await configWithDistribution(directory);
    const asked = [];
    await runCli(['load-account', 'example', directory], { DISTRIBUTION_CONFIG: config, GOOGLE_OAUTH_ACCESS_TOKEN: 'token' }, async (url) => {
      asked.push(url.split('/secrets/')[1].split('/')[0]);
      if (url.includes('distribution-p12')) return secret(Buffer.from('p12-bytes').toString('base64'));
      return secret('value');
    }, () => {});
    assert.ok(asked.includes('apple-example-distribution-p12'), '配布証明書を取りに行っていない');
    const written = await readFile(join(directory, 'distribution.p12'));
    assert.equal(written.toString('utf8'), 'p12-bytes', 'base64 を解いて書き出していない');
    assert.equal((await stat(join(directory, 'distribution.p12'))).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('配布証明書を設定していないリポジトリでは取りに行かず、ファイルも作らない', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kit-nodist-'));
  try {
    const config = await configFile(directory);
    const asked = [];
    await runCli(['load-account', 'example', directory], { DISTRIBUTION_CONFIG: config, GOOGLE_OAUTH_ACCESS_TOKEN: 'token' }, async (url) => {
      asked.push(url); return secret('value');
    }, () => {});
    assert.ok(!asked.some((url) => url.includes('distribution')), '設定が無いのに取りに行っている');
    await assert.rejects(() => stat(join(directory, 'distribution.p12')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('配布証明書の secret 名が不正な設定は受け付けない', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kit-baddist-'));
  try {
    const path = join(directory, 'apps.json');
    await writeFile(path, JSON.stringify({ appleAccounts: { example: { secretProject: 'baynex-shared', keyP8Secret: 'a', keyIdSecret: 'b', issuerIdSecret: 'c', distributionP12Secret: 'bad name!' } } }));
    await assert.rejects(() => runCli(['load-account', 'example', directory], { DISTRIBUTION_CONFIG: path, GOOGLE_OAUTH_ACCESS_TOKEN: 'token' }, async () => secret('value'), () => {}), /Apple アカウント設定が不正/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('配布証明書の中身はログに出さない', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kit-mask-'));
  try {
    const config = await configWithDistribution(directory);
    const printed = [];
    await runCli(['load-account', 'example', directory], { DISTRIBUTION_CONFIG: config, GOOGLE_OAUTH_ACCESS_TOKEN: 'token' }, async (url) => {
      if (url.includes('distribution-p12')) return secret(Buffer.from('secret-key-material').toString('base64'));
      return secret('value');
    }, (line) => printed.push(line));
    assert.ok(!printed.join('\n').includes('secret-key-material'), '秘密鍵がログに出ている');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// macOS の security は空パスワードの PKCS12 を取り込めない（MAC verification failed）。
// 証明書にはパスワードが要り、それも秘密なので同じ経路で運ぶ。
test('配布証明書のパスワードも取りに行き、読めない権限で書き出す', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kit-pw-'));
  try {
    const path = join(directory, 'apps.json');
    await writeFile(path, JSON.stringify({ appleAccounts: { example: { secretProject: 'baynex-shared', keyP8Secret: 'a', keyIdSecret: 'b', issuerIdSecret: 'c', distributionP12Secret: 'd', distributionP12PasswordSecret: 'e' } } }));
    const printed = [];
    await runCli(['load-account', 'example', directory], { DISTRIBUTION_CONFIG: path, GOOGLE_OAUTH_ACCESS_TOKEN: 'token' }, async (url) => {
      if (url.endsWith('/e/versions/latest:access')) return secret('p12-password');
      if (url.endsWith('/d/versions/latest:access')) return secret(Buffer.from('p12').toString('base64'));
      return secret('value');
    }, (line) => printed.push(line));
    assert.equal(await readFile(join(directory, 'distribution.p12.password'), 'utf8'), 'p12-password');
    assert.equal((await stat(join(directory, 'distribution.p12.password'))).mode & 0o777, 0o600);
    assert.ok(!printed.join('\n').includes('p12-password'), 'パスワードがログに出ている');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('パスワードの設定が無ければパスワードファイルも作らない', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kit-nopw-'));
  try {
    const config = await configWithDistribution(directory);
    await runCli(['load-account', 'example', directory], { DISTRIBUTION_CONFIG: config, GOOGLE_OAUTH_ACCESS_TOKEN: 'token' }, async (url) => {
      if (url.includes('distribution-p12')) return secret(Buffer.from('p12').toString('base64'));
      return secret('value');
    }, () => {});
    await assert.rejects(() => stat(join(directory, 'distribution.p12.password')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
