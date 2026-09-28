#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createClient, validateApps, bundleStatus, registerDevices } from './app-store-connect.mjs';
import { accessSecret } from './secret-manager.mjs';
import { fetchTesterUdids } from './firebase-udids.mjs';
import { ensureStarted } from './firebase-activate.mjs';
import { readConfig, splitConfigArgs } from './config.mjs';

export const distributionNotStarted = '自動開始に失敗しました。Firebase コンソールの App Distribution で『使ってみる』を押してください';
const fields = { keyP8: 'keyP8Secret', keyId: 'keyIdSecret', issuerId: 'issuerIdSecret' };
const clean = (value) => String(value).replace(/[|\r\n\x00-\x1f]/g, ' ').slice(0, 160);

export async function runCheck({ config, env = process.env, fetch: fetchImpl = fetch, print = console.log } = {}) {
  const apps = validateApps(config);
  const rows = [];
  let failed = false;
  function row(section, item, status, detail) {
    rows.push(`| ${clean(section)} | ${clean(item)} | ${status} | ${clean(detail)} |`);
    if (status === '❌') failed = true;
  }
  const googleReady = !!env.WIF_PROVIDER && !!env.WIF_SERVICE_ACCOUNT;
  let token = env.GOOGLE_OAUTH_ACCESS_TOKEN;
  for (const [name, value] of [['WIF provider', env.WIF_PROVIDER], ['Uploader service account', env.WIF_SERVICE_ACCOUNT]]) row('設定', name, value ? '✅' : '⚠️', value ? '設定済み' : '未設定');
  if (!googleReady) row('Google Cloud', 'WIF 認証', '⚠️', '設定値なし');
  else if (env.AUTH_OUTCOME !== 'success' || !token) { row('Google Cloud', 'WIF 認証', '❌', '認証失敗'); token = null; }
  else row('Google Cloud', 'WIF 認証', '✅', 'アクセストークン取得済み');

  const accountClients = new Map();
  const usedAccounts = [...new Set(apps.map((app) => app.appleAccount))];
  for (const slug of usedAccounts) {
    const account = config.appleAccounts[slug];
    const accountApps = apps.filter((app) => app.appleAccount === slug);
    const unavailable = () => {
      row(`Apple ${slug}`, 'Team ID', '⚠️', 'キー認証待ち');
      for (const app of accountApps) row(`Apple ${slug}`, app.iosBundleId, '⚠️', 'キー認証待ち');
    };
    const values = {};
    const legacy = { keyP8: env.APP_STORE_CONNECT_KEY_P8, keyId: env.APP_STORE_CONNECT_KEY_ID, issuerId: env.APP_STORE_CONNECT_ISSUER_ID };
    const completeLegacy = Object.values(legacy).every((value) => typeof value === 'string' && value.length > 0);
    for (const [key, field] of Object.entries(fields)) {
      if (token) {
        try {
          values[key] = await accessSecret({ project: account.secretProject, name: account[field], token, fetch: fetchImpl });
          row(`Apple ${slug}`, account[field], '✅', '値あり');
        } catch (error) {
          const noValue = error.message.includes('に値がまだありません');
          row(`Apple ${slug}`, account[field], noValue ? '⚠️' : '❌', noValue ? '値なし — Secret Manager で新しいバージョンを追加してください' : error.message);
        }
      } else if (completeLegacy) {
        values[key] = legacy[key];
        row(`Apple ${slug}`, account[field], '✅', '値あり（旧 GitHub Secrets）');
      } else row(`Apple ${slug}`, account[field], '⚠️', '値なし');
    }
    if (Object.keys(values).length !== 3) { row(`Apple ${slug}`, 'キー', '⚠️', 'キーを確認できません'); unavailable(); continue; }
    try {
      const client = createClient({ issuerId: values.issuerId.trim(), keyId: values.keyId.trim(), keyP8: values.keyP8 }, fetchImpl);
      // One request proves the key; paging through every bundle ID one at a time would hit the page cap.
      await client.request('/v1/bundleIds?limit=1');
      accountClients.set(slug, client);
      row(`Apple ${slug}`, 'キー', '✅', '認証成功');
      const result = await bundleStatus(client, accountApps, env.ENSURE_BUNDLE_IDS === 'true');
      for (const item of result.bundleIds) row(`Apple ${slug}`, item.bundleId, item.exists ? '✅' : '❌', item.created ? '作成済み' : item.exists ? '存在します' : '未登録');
      row(`Apple ${slug}`, 'Team ID', result.teamId ? '✅' : '❌', result.teamId || '取得できません');
    } catch (error) { row(`Apple ${slug}`, 'App Store Connect', '❌', error.message); unavailable(); }
  }

  async function releases(appId) {
    const projectNumber = appId.split(':')[1];
    let next = `https://firebaseappdistribution.googleapis.com/v1/projects/${projectNumber}/apps/${encodeURIComponent(appId)}/releases?pageSize=100`;
    let count = 0;
    let newest = null;
    const seen = new Set();
    while (next) {
      if (seen.has(next) || seen.size >= 20) throw new Error('Firebase リリースのページ数が上限を超えました');
      seen.add(next);
      const response = await fetchImpl(next, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
      if (response.status === 404) return { notStarted: true };
      if (!response.ok) throw new Error(`Firebase リリース API ${response.status}`);
      const body = await response.json();
      if (body.releases !== undefined && !Array.isArray(body.releases)) throw new Error('Firebase リリース応答が不正です');
      const page = body.releases || [];
      if (!newest && page.length) newest = `${page[0].displayVersion || '?'} (${page[0].buildVersion || '?'})`;
      count += page.length;
      next = body.nextPageToken ? `https://firebaseappdistribution.googleapis.com/v1/projects/${projectNumber}/apps/${encodeURIComponent(appId)}/releases?pageSize=100&pageToken=${encodeURIComponent(body.nextPageToken)}` : null;
    }
    return { count, newest };
  }
  const udidsByApp = new Map();
  for (const app of apps) {
    for (const platform of ['ios', 'android']) {
      if (!token) { row('Firebase リリース', `${app.id} ${platform}`, googleReady ? '❌' : '⚠️', 'WIF 認証なし'); continue; }
      try {
        const result = await releases(app.firebaseAppIds[platform]);
        if (result.notStarted) {
          try {
            await ensureStarted({ appId: app.firebaseAppIds[platform], token, fetch: fetchImpl });
            row('Firebase リリース', `${app.id} ${platform}`, '✅', '自動で開始しました');
          } catch (error) {
            row('Firebase リリース', `${app.id} ${platform}`, '❌', `${error.message}。${distributionNotStarted}`);
          }
        }
        else row('Firebase リリース', `${app.id} ${platform}`, '✅', `${result.count} 件、最新: ${result.newest || 'なし'}`);
      } catch (error) { row('Firebase リリース', `${app.id} ${platform}`, '❌', error.message); }
    }
    if (!token) { row('Firebase UDID', app.id, googleReady ? '❌' : '⚠️', 'WIF 認証なし'); continue; }
    try {
      const devices = await fetchTesterUdids(app.firebaseAppIds.ios, token, fetchImpl);
      udidsByApp.set(app.id, devices);
      row('Firebase UDID', app.id, '✅', `${devices.length} 台`);
    } catch (error) { row('Firebase UDID', app.id, '❌', error.message); }
  }
  if (env.REGISTER_DEVICES === 'true') {
    for (const slug of usedAccounts) {
      const accountApps = apps.filter((app) => app.appleAccount === slug);
      const client = accountClients.get(slug);
      if (!client || !token) row(`Apple ${slug}`, '端末登録', '⚠️', 'Apple または Google の認証が必要です');
      else if (accountApps.some((app) => !udidsByApp.has(app.id))) row(`Apple ${slug}`, '端末登録', '❌', 'Firebase UDID をすべて取得できませんでした');
      else {
        try {
          const devices = accountApps.flatMap((app) => udidsByApp.get(app.id));
          const result = await registerDevices(client, devices);
          row(`Apple ${slug}`, '端末登録', '✅', `対象 ${result.requested} 台、既存 ${result.existing} 台、新規 ${result.created} 台、残枠: API 非公開`);
        } catch (error) { row(`Apple ${slug}`, '端末登録', '❌', error.message); }
      }
    }
  }
  const summary = ['## アプリ配布の認証確認', '', '| 区分 | 項目 | 結果 | 内容 |', '| --- | --- | --- | --- |', ...rows, ''].join('\n');
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, summary);
  print(summary);
  return { summary, failed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const parsed = splitConfigArgs(process.argv.slice(2));
    if (parsed.args.length) throw new Error('使い方: distribution-check.mjs [--config <apps.json>]');
    const config = await readConfig(parsed.env);
    const result = await runCheck({ config, env: parsed.env });
    if (result.failed) process.exitCode = 1;
  } catch (error) { console.error(`エラー: ${error.message}`); process.exitCode = 1; }
}
