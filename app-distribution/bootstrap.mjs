#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { accountNames, ensureResource, gcloud, parseArgs, projectPattern, report, slugPattern } from './cloud.mjs';
import { grantAppleAccount } from './grant-apple-account.mjs';
import { ensureStarted } from './scripts/firebase-activate.mjs';
import { validateApps } from './scripts/app-store-connect.mjs';

const apis = ['iam.googleapis.com', 'iamcredentials.googleapis.com', 'sts.googleapis.com', 'firebaseappdistribution.googleapis.com', 'firebase.googleapis.com'];
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function pairApps(ios, android, oldApps = [], appleAccount, { includeNew = true } = {}) {
  const key = (row, platform) => {
    const display = String(row.displayName || '').toLowerCase().replace(/\b(ios|android|dev|qa)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const identifier = String(platform === 'ios' ? row.bundleId : row.packageName);
    return { display, suffix: identifier.split('.').at(-1)?.toLowerCase() };
  };
  const used = new Set();
  const paired = [];
  for (const i of ios) {
    const a = key(i, 'ios');
    let matches = android.filter((d) => !used.has(d.appId) && a.display && key(d, 'android').display === a.display);
    if (matches.length !== 1) matches = android.filter((d) => !used.has(d.appId) && a.suffix && key(d, 'android').suffix === a.suffix);
    if (matches.length !== 1) { report('⚠️', `${i.displayName || i.bundleId}: Android と一意に対応せず除外`); continue; }
    const d = matches[0]; used.add(d.appId);
    const old = oldApps.find((row) => row.firebaseAppIds?.ios === i.appId || row.iosBundleId === i.bundleId);
    if (!old && !includeNew) { report('⚠️', `${i.displayName || i.bundleId}: 新しい候補です。追加するときは --include-new を付けて再実行してください`); continue; }
    const suffix = a.suffix?.replace(/[^a-z0-9-]/g, '-') || '';
    const id = old?.id || (/^[a-z]/.test(suffix) ? suffix : `app-${suffix || paired.length + 1}`);
    paired.push({ id, displayName: old?.displayName || i.displayName || d.displayName || id,
      flavor: old?.flavor || 'TODO', target: old?.target || 'TODO',
      iosBundleId: i.bundleId, androidPackage: d.packageName,
      firebaseAppIds: { ios: i.appId, android: d.appId }, appleAccount: old?.appleAccount || appleAccount,
      ...(old?.appleTeamId ? { appleTeamId: old.appleTeamId } : {}) });
  }
  for (const d of android) if (!used.has(d.appId)) report('⚠️', `${d.displayName || d.packageName}: iOS と対応せず除外`);
  return paired;
}

async function listFirebaseApps(project, platform, token, fetchImpl = fetch) {
  const apps = [];
  let pageToken = '';
  const seen = new Set();
  do {
    if (seen.has(pageToken) || seen.size >= 100) throw new Error('Firebase アプリ一覧のページングが不正です');
    seen.add(pageToken);
    const url = new URL(`https://firebase.googleapis.com/v1beta1/projects/${project}/${platform}Apps`);
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, 'x-goog-user-project': project, Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Firebase ${platform} アプリの取得に失敗しました（HTTP ${response.status}）`);
    const body = await response.json();
    if (body.apps !== undefined && !Array.isArray(body.apps)) throw new Error('Firebase アプリ一覧の形式が不正です');
    apps.push(...(body.apps || []));
    pageToken = body.nextPageToken || '';
    if (apps.length > 1000) throw new Error('Firebase アプリ数が上限を超えました');
  } while (pageToken);
  return apps;
}

export async function bootstrap({ project, repo, appleAccount, short, appDir, out = 'distribution/apps.json', dryRun = false, includeNew = false }, deps = {}) {
  if (!projectPattern.test(project || '') || !repoPattern.test(repo || '') || !slugPattern.test(appleAccount || '')) throw new Error('project、repo、apple-account を確認してください');
  short ||= project.replace(/-(dev|prod|staging|qa)$/, '');
  if (!slugPattern.test(short) || short.length > 18) throw new Error('short は 2～18 文字の小文字・数字・ハイフンにしてください');
  if ((appDir && (!/^[A-Za-z0-9_./-]+$/.test(appDir) || appDir.includes('..'))) || !/^[A-Za-z0-9_./-]+\.json$/.test(out) || out.includes('..')) throw new Error('app-dir または out が不正です');
  const run = deps.gcloud || gcloud;
  const fetchImpl = deps.fetch || fetch;
  const number = run(['projects', 'describe', project, '--format=value(projectNumber)']);
  if (!/^\d+$/.test(number)) throw new Error('GCP プロジェクト番号を取得できません');
  const enabled = new Set(run(['services', 'list', '--enabled', `--project=${project}`, '--format=value(config.name)']).split(/\s+/));
  for (const api of apis) {
    if (enabled.has(api)) report('✅', `${api}: 有効`);
    else if (dryRun) report('⚠️', `${api}: 有効化予定`);
    else { run(['services', 'enable', api, `--project=${project}`, '--quiet']); report('✅', `${api}: 有効化しました`); }
  }
  const pool = `${short}-github`, saId = `${short}-ci-uploader`;
  const provider = `projects/${number}/locations/global/workloadIdentityPools/${pool}/providers/github`;
  const serviceAccount = `${saId}@${project}.iam.gserviceaccount.com`;
  const ensure = deps.ensureResource || ensureResource;
  ensure('Workload Identity pool', ['iam', 'workload-identity-pools', 'describe', pool, `--project=${project}`, '--location=global', '--format=value(name)'], ['iam', 'workload-identity-pools', 'create', pool, `--project=${project}`, '--location=global', '--display-name=GitHub Actions', '--quiet'], dryRun);
  ensure('GitHub OIDC provider', ['iam', 'workload-identity-pools', 'providers', 'describe', 'github', `--workload-identity-pool=${pool}`, `--project=${project}`, '--location=global', '--format=value(name)'], ['iam', 'workload-identity-pools', 'providers', 'create-oidc', 'github', `--workload-identity-pool=${pool}`, `--project=${project}`, '--location=global', '--issuer-uri=https://token.actions.githubusercontent.com', '--attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository', `--attribute-condition=assertion.repository=='${repo}'`, '--quiet'], dryRun);
  ensure('CI uploader', ['iam', 'service-accounts', 'describe', serviceAccount, `--project=${project}`, '--format=value(email)'], ['iam', 'service-accounts', 'create', saId, `--project=${project}`, '--display-name=App Distribution CI uploader', '--quiet'], dryRun);
  const principal = `principalSet://iam.googleapis.com/projects/${number}/locations/global/workloadIdentityPools/${pool}/attribute.repository/${repo}`;
  if (dryRun) report('⚠️', 'Firebase 管理者と WIF 利用権限を付与予定');
  else {
    run(['projects', 'add-iam-policy-binding', project, `--member=serviceAccount:${serviceAccount}`, '--role=roles/firebaseappdistro.admin', '--condition=None', '--quiet', '--format=none']);
    run(['iam', 'service-accounts', 'add-iam-policy-binding', serviceAccount, `--project=${project}`, `--member=${principal}`, '--role=roles/iam.workloadIdentityUser', '--condition=None', '--quiet', '--format=none']);
    report('✅', 'Firebase 管理者と WIF 利用権限を確認しました');
  }
  if (deps.grantAppleAccount) deps.grantAppleAccount({ slug: appleAccount, serviceAccount, dryRun });
  else grantAppleAccount({ slug: appleAccount, serviceAccount, dryRun });
  const token = run(['auth', 'print-access-token']);
  if (!token) throw new Error('gcloud ログインが必要です');
  const ios = await listFirebaseApps(project, 'ios', token, fetchImpl);
  const android = await listFirebaseApps(project, 'android', token, fetchImpl);
  let previous = {};
  try { previous = JSON.parse(await readFile(out, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  appDir ||= previous.appDir || 'native';
  if (!/^[A-Za-z0-9_./-]+$/.test(appDir) || appDir.includes('..')) throw new Error('app-dir が不正です');
  const apps = pairApps(ios, android, previous.apps, appleAccount, { includeNew: includeNew || !previous.apps?.length });
  if (!apps.length) throw new Error('iOS と Android のペアが見つかりません');
  if (new Set(apps.map((app) => app.id)).size !== apps.length) throw new Error('アプリ ID が重複しています。識別子の組を確認してください');
  const config = { appDir, firebaseProject: project, gcp: { workloadIdentityProvider: provider, uploaderServiceAccount: serviceAccount }, apps,
    appleAccounts: { ...(previous.appleAccounts || {}), [appleAccount]: accountNames(appleAccount) },
    ...(previous.privateGitDependencies === undefined ? {} : { privateGitDependencies: previous.privateGitDependencies }),
    ...(previous.flutterVersion === undefined ? {} : { flutterVersion: previous.flutterVersion }) };
  validateApps(config);
  if (dryRun) report('⚠️', `${out}: ${apps.length} アプリを書き込み予定`);
  else { await mkdir(dirname(out), { recursive: true }); await writeFile(out, `${JSON.stringify(config, null, 2)}\n`, { flag: 'w' }); report('✅', `${out}: ${apps.length} アプリを書き込みました`); }
  for (const app of apps) for (const platform of ['ios', 'android']) {
    if (dryRun) { report('⚠️', `${app.id} ${platform}: App Distribution の開始を確認予定`); continue; }
    const state = await ensureStarted({ appId: app.firebaseAppIds[platform], token,
      fetch: (url, options) => fetchImpl(url, { ...options, headers: { ...options.headers, 'x-goog-user-project': project } }) });
    report('✅', `${app.id} ${platform}: ${state === 'started' ? 'App Distribution を開始' : '開始済み'}`);
  }
  if (apps.some((app) => app.flavor === 'TODO' || app.target === 'TODO')) report('⚠️', 'apps.json の flavor / target の TODO をアプリチームと確認してください。');
  report('⚠️', 'IAM の反映には約 5 分かかることがあります。');
  for (const [template, destination] of [
    ['caller-app-distribution.yml', '.github/workflows/app-distribution.yml'],
    ['caller-app-distribution-check.yml', '.github/workflows/app-distribution-check.yml'],
  ]) {
    console.log(`✅ 追加する caller workflow: ${destination}\n${await readFile(new URL(`templates/${template}`, import.meta.url), 'utf8')}`);
  }
  report('✅', '確認コマンド: gh workflow run app-distribution-check.yml --ref qa -f ensure_bundle_ids=true -f register_devices=false');
  return config;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2), { '--project': 'string', '--repo': 'string', '--apple-account': 'string', '--short': 'string', '--app-dir': 'string', '--out': 'string', '--dry-run': 'boolean', '--include-new': 'boolean' });
    await bootstrap({ project: args.project, repo: args.repo, appleAccount: args['apple-account'], short: args.short, appDir: args['app-dir'], out: args.out, dryRun: args['dry-run'], includeNew: args['include-new'] });
  } catch (error) { report('❌', error.message); process.exitCode = 1; }
}
