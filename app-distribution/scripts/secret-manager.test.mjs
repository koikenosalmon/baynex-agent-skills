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
