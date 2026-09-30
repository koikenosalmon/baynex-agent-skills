#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { timedFetch } from './http.mjs';

const base = 'https://firebaseappdistribution.googleapis.com';
const probe = new TextEncoder().encode('invalid Firebase App Distribution probe');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function ensureStarted({ appId, token, fetch: fetchImpl = timedFetch, sleep = pause, now = () => performance.now() }) {
  const match = /^1:(\d+):(ios|android):[A-Za-z0-9]+$/.exec(appId || '');
  if (!match) throw new Error('Firebase アプリ ID が不正です');
  if (!token) throw new Error('Firebase のアクセストークンがありません');
  const [, project, platform] = match;
  const app = `projects/${project}/apps/${encodeURIComponent(appId)}`;
  const releasesUrl = `${base}/v1/${app}/releases?pageSize=1`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const request = async (url, options) => {
    try { return await fetchImpl(url, options); }
    catch { throw new Error('Firebase App Distribution API に接続できません'); }
  };
  const status = await request(releasesUrl, { headers });
  if (status.status === 200) return 'already';
  if (status.status !== 404) throw new Error(`Firebase App Distribution の開始確認に失敗しました（HTTP ${status.status}）`);

  // Observed Firebase behavior: an invalid raw upload starts App Distribution,
  // although its operation fails with INVALID_ARGUMENT and creates no release.
  const upload = await request(`${base}/upload/v1/${app}/releases:upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'X-Goog-Upload-Protocol': 'raw',
      'X-Goog-Upload-File-Name': platform === 'ios' ? 'probe.ipa' : 'probe.apk',
      'Content-Type': 'application/octet-stream',
    },
    body: probe,
  });
  if (upload.status !== 200) throw new Error(`Firebase App Distribution の自動開始に失敗しました（probe HTTP ${upload.status}）`);
  let operation;
  try { operation = await upload.json(); }
  catch { throw new Error('Firebase App Distribution の probe 応答が不正です'); }
  const name = operation?.name;
  if (typeof name !== 'string' || !/^projects\/[^/?#]+\/apps\/[^/?#]+\/(?:[^/?#]+\/)*operations\/[^/?#]+$/.test(name)) {
    throw new Error('Firebase App Distribution の操作名が不正です');
  }

  const deadline = now() + 10_000;
  let completed = false;
  for (let poll = 0; poll < 5; poll++) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    const result = await request(`${base}/v1/${name}`, {
      headers,
      signal: AbortSignal.timeout(Math.max(1, Math.ceil(remaining))),
    });
    if (result.status !== 200) throw new Error(`Firebase App Distribution の操作確認に失敗しました（HTTP ${result.status}）`);
    let body;
    try { body = await result.json(); }
    catch { throw new Error('Firebase App Distribution の操作応答が不正です'); }
    if (body?.done === true) {
      if (body.error?.code !== 3) throw new Error('Firebase App Distribution の probe が想定外の結果で終了しました');
      completed = true;
      break;
    }
    if (poll < 4) await sleep(Math.min(2_000, Math.max(0, deadline - now())));
  }
  if (!completed) throw new Error('Firebase App Distribution の自動開始がタイムアウトしました');
  const confirmed = await request(releasesUrl, { headers });
  if (confirmed.status !== 200) throw new Error(`Firebase App Distribution の開始を確認できません（HTTP ${confirmed.status}）`);
  return 'started';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('使い方: firebase-activate.mjs <Firebase App ID>');
    const result = await ensureStarted({ appId: process.argv[2], token: process.env.GOOGLE_OAUTH_ACCESS_TOKEN });
    console.log(result === 'started' ? 'Firebase App Distribution を自動で開始しました' : 'Firebase App Distribution は開始済みです');
  } catch (error) { console.error(`エラー: ${error.message}`); process.exitCode = 1; }
}
