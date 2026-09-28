#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { validateUdid } from './app-store-connect.mjs';

export async function fetchTesterUdids(appId, token, fetchImpl = fetch) {
  if (!/^1:\d+:ios:[a-fA-F0-9]+$/.test(appId || '')) throw new Error('Firebase iOS App ID が不正です');
  if (typeof token !== 'string' || !token.trim()) throw new Error('Google OAuth アクセストークンがありません');
  const url = `https://firebaseappdistribution.googleapis.com/v1alpha/apps/${encodeURIComponent(appId)}/testers:getTesterUdids`;
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Firebase UDID API ${response.status}: 端末一覧を取得できません`);
  const body = await response.json();
  if (!body || (body.testerUdids !== undefined && !Array.isArray(body.testerUdids))) throw new Error('Firebase UDID API の応答が不正です');
  const items = body.testerUdids || [];
  if (items.length > 1000) throw new Error('Firebase UDID の件数が上限を超えました');
  const unique = new Map();
  for (const item of items) {
    if (item?.platform && !['IOS', 'ios'].includes(item.platform)) continue;
    const udid = validateUdid(item?.udid);
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : `Firebase ${udid.slice(0, 8)}`;
    if (name.length > 100 || /[\r\n\x00-\x1f]/.test(name)) throw new Error('Firebase の端末名が不正です');
    unique.set(udid, { udid, name, platform: 'IOS' });
  }
  return [...unique.values()];
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('使い方: firebase-udids.mjs <Firebase iOS App ID>');
    console.log(JSON.stringify(await fetchTesterUdids(process.argv[2], process.env.GOOGLE_OAUTH_ACCESS_TOKEN)));
  } catch (error) { console.error(`エラー: ${error.message}`); process.exitCode = 1; }
}
