#!/usr/bin/env node
import { createPrivateKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { validateAppleAccounts } from './secret-manager.mjs';
import { readConfig, splitConfigArgs } from './config.mjs';

const BASE = 'https://api.appstoreconnect.apple.com';
const bundlePattern = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const udidPattern = /^(?:[A-Fa-f0-9]{40}|[A-Fa-f0-9]{8}-[A-Fa-f0-9]{16})$/;
const teamPattern = /^[A-Z0-9]{10}$/;
export function validateUdid(udid) {
  if (typeof udid !== 'string' || !udidPattern.test(udid)) throw new Error('UDID の形式が正しくありません');
  return udid.toUpperCase();
}
export function validateApps(config) {
  if (!config || !Array.isArray(config.apps) || config.apps.length === 0 || config.apps.length > 20) throw new Error('apps.json の apps が不正です');
  const accounts = validateAppleAccounts(config);
  return config.apps.map((app) => {
    if (!app || typeof app.id !== 'string' || !/^[a-z][a-z0-9-]{0,30}$/.test(app.id) || typeof app.iosBundleId !== 'string' || !bundlePattern.test(app.iosBundleId) || typeof app.displayName !== 'string' || app.displayName.length < 1 || app.displayName.length > 80 || (app.appleTeamId !== undefined && !teamPattern.test(app.appleTeamId))) throw new Error('apps.json の iOS 設定が不正です');
    if (typeof app.appleAccount !== 'string' || !Object.hasOwn(accounts, app.appleAccount)) throw new Error(`apps.json の Apple アカウント参照が不正です: ${app.id}`);
    return app;
  });
}
export function createJwt({ issuerId, keyId, keyP8, now = Date.now() }) {
  if (!/^[a-fA-F0-9-]{36}$/.test(issuerId || '') || !/^[A-Z0-9]{10}$/.test(keyId || '') || typeof keyP8 !== 'string') throw new Error('App Store Connect キーの設定が不正です');
  let privateKey;
  try { privateKey = createPrivateKey(keyP8); } catch { throw new Error('App Store Connect .p8 キーを読み取れません'); }
  if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('App Store Connect キーは ES256 が必要です');
  const iat = Math.floor(now / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'ES256', kid: keyId, typ: 'JWT' })}.${encode({ iss: issuerId, iat, exp: iat + 1190, aud: 'appstoreconnect-v1' })}`;
  return `${unsigned}.${sign('sha256', Buffer.from(unsigned), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
export function createClient(credentials, fetchImpl = fetch) {
  const jwt = createJwt(credentials);
  async function request(path, options = {}) {
    const response = await fetchImpl(new URL(path, BASE), { ...options, headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error(`Apple API ${response.status}: キーが無効か、アクセスが『管理』ではありません`);
      if (response.status === 409) throw new Error('Apple API 409: 識別子または端末が既に登録されているか、登録上限に達しています');
      throw new Error(`Apple API ${response.status}: リクエストに失敗しました`);
    }
    const body = await response.json();
    if (!body || typeof body !== 'object') throw new Error('Apple API の応答が不正です');
    return body;
  }
  async function list(path) {
    const result = [];
    let next = new URL(path, BASE).href;
    const seen = new Set();
    while (next) {
      if (seen.has(next) || seen.size >= 20 || !next.startsWith(`${BASE}/v1/`)) throw new Error('Apple API のページングが不正です');
      seen.add(next);
      const page = await request(next);
      if (!Array.isArray(page.data)) throw new Error('Apple API の一覧応答が不正です');
      result.push(...page.data);
      if (result.length > 4000) throw new Error('Apple API の件数が上限を超えました');
      next = page.links?.next || null;
    }
    return result;
  }
  return { request, list };
}
export async function bundleStatus(client, apps, ensure = false) {
  const known = await client.list('/v1/bundleIds?limit=200&filter%5Bplatform%5D=IOS');
  const rows = [];
  let teamId = null;
  for (const app of apps) {
    let item = known.find((entry) => entry.attributes?.identifier === app.iosBundleId);
    let created = false;
    if (!item && ensure) {
      const body = { data: { type: 'bundleIds', attributes: { name: app.displayName, identifier: app.iosBundleId, platform: 'IOS' } } };
      try {
        const response = await client.request('/v1/bundleIds', { method: 'POST', body: JSON.stringify(body) });
        item = response.data;
        created = true;
      } catch (error) {
        if (!error.message.startsWith('Apple API 409:')) throw error;
        item = (await client.list(`/v1/bundleIds?limit=200&filter%5Bidentifier%5D=${encodeURIComponent(app.iosBundleId)}`)).find((entry) => entry.attributes?.identifier === app.iosBundleId);
        if (!item) throw error;
      }
    }
    const seedId = item?.attributes?.seedId;
    if (seedId && !teamPattern.test(seedId)) throw new Error('Apple API の Team ID が不正です');
    const resolved = app.appleTeamId || seedId || null;
    if (teamId && resolved && teamId !== resolved) throw new Error('アプリ間で Apple Team ID が一致しません');
    if (resolved) teamId = resolved;
    rows.push({ id: app.id, bundleId: app.iosBundleId, exists: !!item, created, teamId: resolved });
  }
  return { keyWorks: true, teamId, bundleIds: rows };
}
export async function registerDevices(client, devices) {
  if (!Array.isArray(devices) || devices.length > 100) throw new Error('端末一覧は最大 100 件です');
  const requested = new Map();
  for (const device of devices) {
    const udid = validateUdid(device?.udid);
    if (device.platform && device.platform !== 'IOS') throw new Error('iOS 以外の端末が含まれています');
    const name = typeof device.name === 'string' && device.name.trim() ? device.name.trim() : `Firebase ${udid.slice(0, 8)}`;
    if (name.length > 100 || /[\r\n\x00-\x1f]/.test(name)) throw new Error('端末名が不正です');
    requested.set(udid, { udid, name });
  }
  const registered = await client.list('/v1/devices?limit=200&filter%5Bplatform%5D=IOS');
  const existing = new Set(registered.map((item) => item.attributes?.udid?.toUpperCase()).filter(Boolean));
  let created = 0;
  for (const device of requested.values()) {
    if (existing.has(device.udid)) continue;
    try {
      await client.request('/v1/devices', { method: 'POST', body: JSON.stringify({ data: { type: 'devices', attributes: { name: device.name, platform: 'IOS', udid: device.udid } } }) });
    } catch (error) {
      if (!error.message.startsWith('Apple API 409:')) throw error;
      const found = await client.list(`/v1/devices?limit=200&filter%5Budid%5D=${encodeURIComponent(device.udid)}`);
      if (found.some((item) => item.attributes?.udid?.toUpperCase() === device.udid)) { existing.add(device.udid); continue; }
      throw error;
    }
    existing.add(device.udid);
    created++;
  }
  return { requested: requested.size, existing: requested.size - created, created, remaining: null };
}
export async function runCli(args, env = process.env, fetchImpl = fetch) {
  ({ args, env } = splitConfigArgs(args, env));
  const [command, argument] = args;
  if (!['check', 'ensure-bundle-ids', 'register-devices'].includes(command) || (command === 'register-devices' ? !argument || args.length !== 2 : args.length > 2)) throw new Error('使い方: app-store-connect.mjs check|ensure-bundle-ids [app-id]|register-devices <file>');
  const keyP8 = env.APP_STORE_CONNECT_KEY_P8_FILE ? await readFile(env.APP_STORE_CONNECT_KEY_P8_FILE, 'utf8') : env.APP_STORE_CONNECT_KEY_P8;
  const keyId = env.APP_STORE_CONNECT_KEY_ID_FILE ? await readFile(env.APP_STORE_CONNECT_KEY_ID_FILE, 'utf8') : env.APP_STORE_CONNECT_KEY_ID;
  const issuerId = env.APP_STORE_CONNECT_ISSUER_ID_FILE ? await readFile(env.APP_STORE_CONNECT_ISSUER_ID_FILE, 'utf8') : env.APP_STORE_CONNECT_ISSUER_ID;
  const client = createClient({ issuerId: issuerId?.trim(), keyId: keyId?.trim(), keyP8 }, fetchImpl);
  if (command === 'register-devices') return registerDevices(client, JSON.parse(await readFile(argument, 'utf8')));
  const config = await readConfig(env);
  const apps = validateApps(config);
  const selected = argument ? apps.filter((app) => app.id === argument) : apps;
  if (!selected.length) throw new Error(`アプリがありません: ${argument}`);
  if (new Set(selected.map((app) => app.appleAccount)).size !== 1) throw new Error('Apple アカウントを指定してアプリを選択してください');
  return bundleStatus(client, selected, command === 'ensure-bundle-ids');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runCli(process.argv.slice(2)))); }
  catch (error) { console.error(`エラー: ${error.message}`); process.exitCode = 1; }
}
