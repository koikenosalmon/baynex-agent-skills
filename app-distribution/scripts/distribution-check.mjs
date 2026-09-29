#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { appendFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient, validateApps, bundleStatus, registerDevices } from './app-store-connect.mjs';
import { fetchAscToken } from './apple-credentials.mjs';
import { accessSecret } from './secret-manager.mjs';
import { fetchTesterUdids } from './firebase-udids.mjs';
import { ensureStarted } from './firebase-activate.mjs';
import { knownHostsContent } from './git-dependencies.mjs';
import { readConfig, splitConfigArgs, validateBuildNumberOffset, validateFlutterVersion, validatePrivateGitDependencies } from './config.mjs';

export const distributionNotStarted = '自動開始に失敗しました。Firebase コンソールの App Distribution で『使ってみる』を押してください';
const fields = { keyP8: 'keyP8Secret', keyId: 'keyIdSecret', issuerId: 'issuerIdSecret' };
export const declaredSecrets = ['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD', 'APP_STORE_CONNECT_KEY_P8', 'APP_STORE_CONNECT_KEY_ID', 'APP_STORE_CONNECT_ISSUER_ID', 'GIT_DEPENDENCY_SSH_KEY', 'GIT_DEPENDENCY_TOKEN'];
const kitRepository = 'koikenosalmon/baynex-agent-skills';
const clean = (value) => String(value).replace(/[|\r\n\x00-\x1f]/g, ' ').slice(0, 160);

function stringLeaves(value, path = '', found = []) {
  if (typeof value === 'string') found.push({ path, value });
  else if (Array.isArray(value)) value.forEach((item, index) => stringLeaves(item, `${path}[${index}]`, found));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) stringLeaves(item, path ? `${path}.${key}` : key, found);
  return found;
}

// GitHub masks every occurrence of a secret value, line by line, so a config string that merely contains
// a short secret value loses that part in logs and job outputs. Returns names and config keys only.
export function findSecretCollisions(secrets, config) {
  const leaves = stringLeaves(config);
  const found = [];
  for (const [name, raw] of Object.entries(secrets)) {
    const candidates = [...new Set([raw, ...String(raw).split(/\r?\n/)].map((part) => part.trim()).filter((part) => part.length >= 3))];
    for (const leaf of leaves) if (candidates.some((candidate) => leaf.value.includes(candidate))) found.push({ secret: name, path: leaf.path });
  }
  return found;
}

// Finds caller workflows that use the kit with `secrets: inherit`.
export async function findInheritingCallers(directory) {
  let names;
  try { names = (await readdir(directory)).filter((name) => /\.ya?ml$/.test(name)); } catch { return []; }
  const files = [];
  for (const name of names.sort()) {
    const lines = (await readFile(join(directory, name), 'utf8')).split(/\r?\n/).map((line) => line.replace(/\s+#.*$/, ''));
    const indentOf = (line) => line.match(/^ */)[0].length;
    const hit = lines.some((line, index) => {
      if (!/^\s*secrets:\s*inherit\s*$/.test(line)) return false;
      const indent = indentOf(line);
      const siblings = [];
      for (let i = index; i >= 0 && (!lines[i].trim() || indentOf(lines[i]) >= indent); i--) siblings.push(lines[i]);
      for (let i = index; i < lines.length && (!lines[i].trim() || indentOf(lines[i]) >= indent); i++) siblings.push(lines[i]);
      return siblings.some((sibling) => indentOf(sibling) === indent && new RegExp(`^\\s*uses:\\s*${kitRepository}/`).test(sibling));
    });
    if (hit) files.push(name);
  }
  return files;
}

function probeGitDependency(repo, env, spawn) {
  const sshKey = String(env.GIT_DEPENDENCY_SSH_KEY || '').replace(/\r\n?/g, '\n').trim();
  const token = String(env.GIT_DEPENDENCY_TOKEN || '').trim();
  if (!sshKey && !token) return null;
  const directory = mkdtempSync(join(tmpdir(), 'git-probe-'));
  try {
    const environment = { PATH: process.env.PATH, HOME: directory, GIT_TERMINAL_PROMPT: '0' };
    let url = `https://github.com/${repo}.git`;
    if (sshKey) {
      const keyFile = join(directory, 'key'), knownHosts = join(directory, 'known_hosts');
      writeFileSync(keyFile, `${sshKey}\n`, { mode: 0o600 });
      writeFileSync(knownHosts, knownHostsContent(), { mode: 0o600 });
      environment.GIT_SSH_COMMAND = `ssh -i '${keyFile}' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o GlobalKnownHostsFile=/dev/null -o UserKnownHostsFile='${knownHosts}'`;
      url = `git@github.com:${repo}.git`;
    } else Object.assign(environment, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` });
    const result = spawn('git', ['ls-remote', url, 'HEAD'], { env: environment, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: result.status === 0, status: result.status, method: sshKey ? 'SSH 鍵' : 'トークン' };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export async function runCheck({ config, env = process.env, fetch: fetchImpl = fetch, print = console.log, spawn = spawnSync, workflowsDir = '.github/workflows' } = {}) {
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
  const flutterVersion = validateFlutterVersion(config);
  if (flutterVersion) row('設定', 'Flutter バージョン', '✅', `CI は ${flutterVersion} に固定`);
  const gitDependencies = validatePrivateGitDependencies(config);
  if (gitDependencies.length) {
    const method = env.GIT_DEPENDENCY_SSH_KEY_SET === 'true' ? 'SSH 鍵（GIT_DEPENDENCY_SSH_KEY）' : env.GIT_DEPENDENCY_TOKEN_SET === 'true' ? 'トークン（GIT_DEPENDENCY_TOKEN）' : null;
    row('非公開 Git 依存', gitDependencies.join(', '), method ? '✅' : '⚠️', method ? `${method}が設定済み` : 'GIT_DEPENDENCY_SSH_KEY か GIT_DEPENDENCY_TOKEN を設定してください');
    for (const repo of gitDependencies) {
      let probe = null;
      try { probe = probeGitDependency(repo, env, spawn); } catch (error) { probe = { ok: false, status: 'error', method: '認証情報' }; }
      if (probe) row('非公開 Git 依存', `${repo} 到達性`, probe.ok ? '✅' : '❌', probe.ok ? `git ls-remote 成功（${probe.method}）` : `git ls-remote に失敗（終了コード ${probe.status}）。Deploy key が ${repo} に登録されているか、トークンに Contents: Read があるか確認してください`);
    }
  }
  const received = {};
  for (const name of declaredSecrets) {
    const value = typeof env[name] === 'string' ? env[name] : '';
    const present = value.length > 0 || env[`${name}_SET`] === 'true';
    if (value) received[name] = value;
    row('GitHub Secrets', name, present ? '✅' : '⚠️', present ? '受信しました（値は表示しません）' : '受信していません — 未設定か、caller から渡っていません（任意の secret なら問題ありません）');
  }
  const callerOwner = String(env.CALLER_OWNER || ''), kitOwner = String(env.KIT_OWNER || kitRepository.split('/')[0]);
  if (callerOwner && callerOwner.toLowerCase() !== kitOwner.toLowerCase()) {
    const inheriting = await findInheritingCallers(workflowsDir);
    for (const file of inheriting) row('Caller', file, '❌', `secrets: inherit は別オーナー（${callerOwner}）のリポジトリから呼ぶと secrets を渡しません。NAME: \${{ secrets.NAME }} で明示する cross-owner テンプレート（caller-*-cross-owner.yml）を使ってください`);
    if (!inheriting.length) row('Caller', '別オーナーからの呼び出し', '✅', 'secrets: inherit は使われていません');
  }
  const collisions = findSecretCollisions(received, config);
  for (const item of collisions) row('Secret マスク', item.secret, '❌', `値が apps.json の ${item.path} に含まれるため、GitHub がログとジョブ出力でその部分をマスクします。secret の値を変えてください`);
  if (!collisions.length) row('Secret マスク', 'apps.json との衝突', '✅', '衝突なし');
  if (!googleReady) row('Google Cloud', 'WIF 認証', '⚠️', '設定値なし');
  else if (env.AUTH_OUTCOME !== 'success' || !token) { row('Google Cloud', 'WIF 認証', '❌', '認証失敗'); token = null; }
  else row('Google Cloud', 'WIF 認証', '✅', 'アクセストークン取得済み');

  const ciStatus = env.BAYNEX_CI_STATUS;
  if (ciStatus === 'ok') row('Baynex', 'CI アクセス', '✅', `許可されています（mode=${env.BAYNEX_CI_MODE || '?'}${config.baynex?.revision !== undefined ? `、revision ${config.baynex.revision}` : ''}）`);
  else if (ciStatus === 'denied') row('Baynex', 'CI アクセス', '⚠️', '拒否されました（ci_denied）。Baynex の製品設定でこのリポジトリの CI アクセスを登録してください。当面は Secret Manager / GitHub Secrets を使います');
  else if (ciStatus === 'unreachable') row('Baynex', 'CI アクセス', '⚠️', 'Baynex に接続できませんでした。apps.json と旧経路で続行します');
  else row('Baynex', 'CI アクセス', '⚠️', '未確認です（resolve-config が実行されていないか、id-token: write がありません）');

  // Key route: Baynex OIDC first, then Secret Manager, then legacy GitHub secrets.
  let baynexAsc = null;
  if (env.ACTIONS_ID_TOKEN_REQUEST_URL && ciStatus !== 'denied') {
    try { baynexAsc = await fetchAscToken({ env, fetch: fetchImpl, print: () => {} }); } catch { baynexAsc = null; }
  }
  const legacyComplete = [env.APP_STORE_CONNECT_KEY_P8, env.APP_STORE_CONNECT_KEY_ID, env.APP_STORE_CONNECT_ISSUER_ID].every((value) => typeof value === 'string' && value.length > 0);
  if (baynexAsc) row('鍵の取得経路', 'Apple', '✅', 'Baynex OIDC（asc-token を取得できました）');
  else if (token) row('鍵の取得経路', 'Apple', '✅', 'Secret Manager');
  else if (legacyComplete) row('鍵の取得経路', 'Apple', '✅', 'GitHub Secrets（旧経路。Baynex での CI 連携を推奨します）');
  else row('鍵の取得経路', 'Apple', '⚠️', '取得できる経路がありません（Baynex OIDC / Secret Manager / GitHub Secrets）');

  const accountClients = new Map();
  const slugOf = (app) => app.appleAccount ?? config.baynex?.apple?.name ?? 'baynex';
  const usedAccounts = [...new Set(apps.map(slugOf))];
  for (const slug of usedAccounts) {
    const account = config.appleAccounts?.[slug];
    const accountApps = apps.filter((app) => slugOf(app) === slug);
    const unavailable = () => {
      row(`Apple ${slug}`, 'Team ID', '⚠️', 'キー認証待ち');
      for (const app of accountApps) row(`Apple ${slug}`, app.iosBundleId, '⚠️', 'キー認証待ち');
    };
    const values = {};
    const legacy = { keyP8: env.APP_STORE_CONNECT_KEY_P8, keyId: env.APP_STORE_CONNECT_KEY_ID, issuerId: env.APP_STORE_CONNECT_ISSUER_ID };
    const completeLegacy = Object.values(legacy).every((value) => typeof value === 'string' && value.length > 0);
    if (!baynexAsc && account) for (const [key, field] of Object.entries(fields)) {
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
    if (!baynexAsc && Object.keys(values).length !== 3) { row(`Apple ${slug}`, 'キー', '⚠️', 'キーを確認できません'); unavailable(); continue; }
    try {
      const client = createClient(baynexAsc ? { token: baynexAsc.token } : { issuerId: values.issuerId.trim(), keyId: values.keyId.trim(), keyP8: values.keyP8 }, fetchImpl);
      // One request proves the key; paging through every bundle ID one at a time would hit the page cap.
      await client.request('/v1/bundleIds?limit=1');
      accountClients.set(slug, client);
      row(`Apple ${slug}`, 'キー', '✅', '認証成功');
      // With a Baynex-issued token the key belongs to Baynex, so the Admin-role probe applies only to our own keys.
      if (!baynexAsc) try {
        await client.request('/v1/users?limit=1');
        row(`Apple ${slug}`, 'クラウド署名の権限', '✅', 'チームキーの権限は十分です（/v1/users 200）');
      } catch (error) {
        const status = error.message.match(/^Apple API (\d{3})/)?.[1];
        if (status === '403') row(`Apple ${slug}`, 'クラウド署名の権限', '❌', 'Admin のチームキーが必要です（/v1/users 403）。App Store Connect で Admin 権限のチームキーを作り直してください');
        else row(`Apple ${slug}`, 'クラウド署名の権限', '⚠️', `判定できません（${status ? `HTTP ${status}` : '通信エラー'}）`);
      }
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
    let maxBuild = null;
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
      for (const release of page) if (/^\d{1,10}$/.test(String(release.buildVersion))) maxBuild = Math.max(maxBuild ?? 0, Number(release.buildVersion));
      count += page.length;
      next = body.nextPageToken ? `https://firebaseappdistribution.googleapis.com/v1/projects/${projectNumber}/apps/${encodeURIComponent(appId)}/releases?pageSize=100&pageToken=${encodeURIComponent(body.nextPageToken)}` : null;
    }
    return { count, newest, maxBuild };
  }
  const runNumber = /^[1-9]\d{0,9}$/.test(String(env.RUN_NUMBER || '')) ? Number(env.RUN_NUMBER) : null;
  const nextBuild = runNumber === null ? null : runNumber + validateBuildNumberOffset(config);
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
        else {
          row('Firebase リリース', `${app.id} ${platform}`, '✅', `${result.count} 件、最新: ${result.newest || 'なし'}`);
          if (nextBuild !== null && result.maxBuild !== null) {
            const lower = nextBuild < result.maxBuild;
            row('ビルド番号', `${app.id} ${platform}`, lower ? '⚠️' : '✅', `この check の run_number + offset = ${nextBuild}、Firebase の最大 ${result.maxBuild}${lower ? '。配布のビルド番号が小さいと端末で更新できません。buildNumberOffset を増やしてください（配布 workflow の run_number は別なので目安です）' : ''}`);
          }
        }
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
      const accountApps = apps.filter((app) => slugOf(app) === slug);
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
