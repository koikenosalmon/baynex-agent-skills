#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readConfig, splitConfigArgs } from './config.mjs';

const slugPattern = /^[a-z][a-z0-9-]{1,30}$/;
const projectPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const secretPattern = /^[A-Za-z0-9_-]{1,255}$/;
const MAX_BYTES = 1024 * 1024;
const fields = { keyP8: 'keyP8Secret', keyId: 'keyIdSecret', issuerId: 'issuerIdSecret' };

export function validateAppleAccounts(config) {
  const accounts = config?.appleAccounts;
  if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts) || !Object.keys(accounts).length) throw new Error('apps.json の appleAccounts が不正です');
  for (const [slug, account] of Object.entries(accounts)) {
    if (!slugPattern.test(slug) || !account || typeof account !== 'object' || Array.isArray(account) || !projectPattern.test(account.secretProject || '') || Object.values(fields).some((field) => !secretPattern.test(account[field] || ''))) throw new Error(`apps.json の Apple アカウント設定が不正です: ${slug}`);
  }
  return accounts;
}

function crc32c(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function accessSecret({ project, name, token, fetch: fetchImpl = fetch }) {
  if (!projectPattern.test(project || '') || !secretPattern.test(name || '')) throw new Error('Secret Manager の設定が不正です');
  if (!token) throw new Error('Google OAuth アクセストークンがありません');
  const url = `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${name}/versions/latest:access`;
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (response.status === 404) throw new Error(`${name} に値がまだありません（Secret Manager で新しいバージョンを追加してください）`);
  if (response.status === 403) throw new Error(`${name} を読む権限がありません`);
  if (!response.ok) throw new Error(`${name} の取得に失敗しました（Secret Manager ${response.status}）`);
  let body;
  try { body = await response.json(); } catch { throw new Error(`${name} の応答が不正です`); }
  const encoded = body?.payload?.data;
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_BYTES / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error(`${name} の値が不正です`);
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error(`${name} の値のサイズが不正です`);
  const expected = body.payload.dataCrc32c;
  if (expected !== undefined && (!/^\d+$/.test(String(expected)) || BigInt(expected) !== BigInt(crc32c(bytes)))) throw new Error(`${name} の CRC32C が一致しません`);
  return bytes.toString('utf8');
}

const API = 'https://secretmanager.googleapis.com/v1';
async function smRequest({ url, token, fetch: fetchImpl, method = 'GET', body }) {
  if (!token) throw new Error('Google OAuth アクセストークンがありません');
  return fetchImpl(url, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
function checkSecretRef(project, name) {
  if (!projectPattern.test(project || '') || !secretPattern.test(name || '')) throw new Error('Secret Manager の設定が不正です');
}

// Latest version as text, or null when the secret or its first version does not exist yet.
export async function readSecretOptional({ project, name, token, fetch: fetchImpl = fetch }) {
  try { return await accessSecret({ project, name, token, fetch: fetchImpl }); }
  catch (error) { if (/値がまだありません/.test(error.message)) return null; throw error; }
}

export async function ensureSecret({ project, name, token, fetch: fetchImpl = fetch }) {
  checkSecretRef(project, name);
  const found = await smRequest({ url: `${API}/projects/${project}/secrets/${name}`, token, fetch: fetchImpl });
  if (found.ok) return false;
  if (found.status !== 404) throw new Error(`${name} を確認できません（Secret Manager ${found.status}）`);
  const created = await smRequest({ url: `${API}/projects/${project}/secrets?secretId=${name}`, token, fetch: fetchImpl, method: 'POST', body: { replication: { automatic: {} }, labels: { 'baynex-purpose': 'ios-dist-p12' } } });
  if (!created.ok && created.status !== 409) throw new Error(`${name} を作成できません（Secret Manager ${created.status}）`);
  return true;
}

export async function canAddSecretVersion({ project, name, token, fetch: fetchImpl = fetch }) {
  checkSecretRef(project, name);
  const permission = 'secretmanager.versions.add';
  const response = await smRequest({ url: `${API}/projects/${project}/secrets/${name}:testIamPermissions`, token, fetch: fetchImpl, method: 'POST', body: { permissions: [permission] } });
  if (!response.ok) return false;
  const body = await response.json().catch(() => ({}));
  return Array.isArray(body.permissions) && body.permissions.includes(permission);
}

export async function addSecretVersion({ project, name, token, value, fetch: fetchImpl = fetch }) {
  checkSecretRef(project, name);
  const bytes = Buffer.from(String(value), 'utf8');
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error(`${name} に保存する値のサイズが不正です`);
  const response = await smRequest({ url: `${API}/projects/${project}/secrets/${name}:addVersion`, token, fetch: fetchImpl, method: 'POST', body: { payload: { data: bytes.toString('base64'), dataCrc32c: String(crc32c(bytes)) } } });
  if (!response.ok) throw new Error(`Secret Manager ${response.status}`);
}

export async function loadAccount(account, token, fetchImpl = fetch) {
  const values = {};
  for (const [key, field] of Object.entries(fields)) values[key] = await accessSecret({ project: account.secretProject, name: account[field], token, fetch: fetchImpl });
  return values;
}

export async function writeAccountFiles({ config, slug, directory, token, fallback, fetch: fetchImpl = fetch, print = console.log, onSource }) {
  const accounts = validateAppleAccounts(config);
  if (!Object.hasOwn(accounts, slug)) throw new Error(`Apple アカウントがありません: ${slug}`);
  if (!directory) throw new Error('出力先ディレクトリがありません');
  const completeFallback = ['keyP8', 'keyId', 'issuerId'].every((key) => typeof fallback?.[key] === 'string' && fallback[key].length > 0);
  let values;
  let source = 'github-secrets';
  if (token) {
    try { values = await loadAccount(accounts[slug], token, fetchImpl); source = 'secret-manager'; }
    catch (error) { if (!completeFallback) throw error; values = fallback; }
  } else if (completeFallback) values = fallback;
  if (!values) throw new Error('Secret Manager の認証、または 3 件そろった旧 GitHub Secrets が必要です');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [key, filename] of Object.entries({ keyP8: 'app-store-connect.p8', keyId: 'app-store-connect-key-id', issuerId: 'app-store-connect-issuer-id' })) {
    await writeFile(join(directory, filename), values[key], { mode: 0o600, flag: 'w' });
  }
  onSource?.(source);
  print(`::add-mask::${values.keyId}`);
  print(`::add-mask::${values.issuerId}`);
  return values;
}

export async function runCli(args, env = process.env, fetchImpl = fetch, print = console.log) {
  ({ args, env } = splitConfigArgs(args, env));
  if (args.length !== 3 || args[0] !== 'load-account') throw new Error('使い方: secret-manager.mjs load-account <account> <directory>');
  const config = await readConfig(env);
  await writeAccountFiles({ config, slug: args[1], directory: args[2], token: env.GOOGLE_OAUTH_ACCESS_TOKEN, fallback: { keyP8: env.APP_STORE_CONNECT_KEY_P8, keyId: env.APP_STORE_CONNECT_KEY_ID, issuerId: env.APP_STORE_CONNECT_ISSUER_ID }, fetch: fetchImpl, print });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runCli(process.argv.slice(2)); }
  catch (error) { console.error(`エラー: ${error.message}`); process.exitCode = 1; }
}
