#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { accountNames, ensureResource, gcloud, parseArgs, projectPattern, report, slugPattern } from './cloud.mjs';
import { grantAppleAccount } from './grant-apple-account.mjs';
import { ensureStarted } from './scripts/firebase-activate.mjs';
import { validateApps } from './scripts/app-store-connect.mjs';
import { defaultRun, detectPrivateDependencies, mergeDependencies, provisionDependencyCredential } from './private-dependencies.mjs';

const kitOwner = 'koikenosalmon';

const apis = ['iam.googleapis.com', 'iamcredentials.googleapis.com', 'sts.googleapis.com', 'firebaseappdistribution.googleapis.com', 'firebase.googleapis.com'];
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class PairingError extends Error {
  constructor(message) { super(message); this.exitCode = 2; }
}

const pairPattern = /^ios=([^,\s]+),android=([^,\s]+)$/;
const labelIos = (row) => `"${row.displayName || row.bundleId}" (${row.bundleId}, ${row.appId})`;
const labelAndroid = (row) => `"${row.displayName || row.packageName}" (${row.packageName}, ${row.appId})`;

export function parsePairSpecs(values = []) {
  return values.map((value) => {
    const match = pairPattern.exec(value);
    if (!match) throw new Error(`--pair の形式が不正です: ${value}（ios=<firebaseAppId>,android=<firebaseAppId>）`);
    return { ios: match[1], android: match[2] };
  });
}

async function promptLine(question) {
  const { createInterface } = await import('node:readline/promises');
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try { return await readline.question(question); } finally { readline.close(); }
}

// Pairs Firebase iOS and Android apps. Decided pairs (apps.json, --pair) and unique name matches are used as is;
// anything else is asked (TTY) or rejected with exit code 2 (non-interactive). It never guesses.
export async function pairApps(ios, android, oldApps = [], appleAccount, { includeNew = true, pairs = [], interactive = false, ask = promptLine } = {}) {
  const key = (row, platform) => {
    const display = String(row.displayName || '').toLowerCase().replace(/\b(ios|android|dev|qa)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const identifier = String(platform === 'ios' ? row.bundleId : row.packageName);
    return { display, suffix: identifier.split('.').at(-1)?.toLowerCase() };
  };
  const findOld = (i) => oldApps.find((row) => row.firebaseAppIds?.ios === i.appId || row.iosBundleId === i.bundleId);
  const chosen = new Map();
  const used = new Set();
  const forced = new Set();
  const assign = (i, d) => { chosen.set(i.appId, d); used.add(d.appId); };
  for (const pair of pairs) {
    const i = ios.find((row) => row.appId === pair.ios), d = android.find((row) => row.appId === pair.android);
    if (!i || !d) throw new Error(`--pair のアプリ ID が Firebase にありません: ios=${pair.ios},android=${pair.android}`);
    if (chosen.has(i.appId) || used.has(d.appId)) throw new Error(`--pair が重複しています: ios=${pair.ios},android=${pair.android}`);
    assign(i, d); forced.add(i.appId);
  }
  for (const i of ios) {
    if (chosen.has(i.appId)) continue;
    const d = android.find((row) => row.appId === findOld(i)?.firebaseAppIds?.android && !used.has(row.appId));
    if (d) assign(i, d);
  }
  const pending = [];
  for (const i of ios) {
    if (chosen.has(i.appId)) continue;
    const a = key(i, 'ios');
    let matches = android.filter((d) => !used.has(d.appId) && a.display && key(d, 'android').display === a.display);
    if (matches.length !== 1) matches = android.filter((d) => !used.has(d.appId) && a.suffix && key(d, 'android').suffix === a.suffix);
    if (matches.length === 1) assign(i, matches[0]);
    else pending.push(i);
  }
  const skipped = new Set();
  const undecided = [];
  for (const i of pending) {
    if (!findOld(i) && !includeNew) report('⚠️', `${i.displayName || i.bundleId}: 新しい候補です。追加するときは --include-new を付けて再実行してください`);
    else undecided.push(i);
  }
  const available = () => android.filter((d) => !used.has(d.appId));
  const missing = undecided.filter((i) => !available().length);
  for (const i of missing) report('⚠️', `${labelIos(i)}: 対応する Android アプリがありません`);
  const ambiguous = undecided.filter((i) => !missing.includes(i));
  if (ambiguous.length && !interactive) {
    const example = `--pair ios=${ambiguous[0].appId},android=${available()[0].appId}`;
    throw new PairingError(['iOS と Android の対応が一意に決まらないため、推測せずに停止しました。',
      ...ambiguous.flatMap((i) => [`- iOS ${labelIos(i)} の候補:`, ...available().map((d) => `    - Android ${labelAndroid(d)}`)]),
      `対応を --pair ios=<firebaseAppId>,android=<firebaseAppId> で指定して再実行してください（複数回指定できます）。例: ${example}`].join('\n'));
  }
  for (const i of ambiguous) {
    const candidates = available();
    if (!candidates.length) { report('⚠️', `${labelIos(i)}: 対応する Android アプリがありません`); skipped.add(i.appId); continue; }
    console.log(`iOS ${labelIos(i)} に対応する Android アプリを選んでください:`);
    candidates.forEach((d, index) => console.log(`  ${index + 1}) ${labelAndroid(d)}`));
    console.log('  s) このアプリは追加しない');
    for (;;) {
      const answer = String(await ask(`番号 [1-${candidates.length}/s]: `)).trim().toLowerCase();
      if (answer === 's') { skipped.add(i.appId); break; }
      if (/^\d+$/.test(answer) && Number(answer) >= 1 && Number(answer) <= candidates.length) { assign(i, candidates[Number(answer) - 1]); break; }
      console.log('番号か s を入力してください。');
    }
  }
  const paired = [];
  for (const i of ios) {
    const d = chosen.get(i.appId);
    if (!d || skipped.has(i.appId)) continue;
    const old = findOld(i);
    if (!old && !includeNew && !forced.has(i.appId)) { report('⚠️', `${i.displayName || i.bundleId}: 新しい候補です。追加するときは --include-new を付けて再実行してください`); continue; }
    const suffix = key(i, 'ios').suffix?.replace(/[^a-z0-9-]/g, '-') || '';
    const id = old?.id || (/^[a-z]/.test(suffix) ? suffix : `app-${suffix || paired.length + 1}`);
    paired.push({ id, displayName: old?.displayName || i.displayName || d.displayName || id,
      flavor: old?.flavor || 'TODO', target: old?.target || 'TODO',
      iosBundleId: i.bundleId, androidPackage: d.packageName,
      firebaseAppIds: { ios: i.appId, android: d.appId }, appleAccount: old?.appleAccount || appleAccount,
      ...(old?.appleTeamId ? { appleTeamId: old.appleTeamId } : {}) });
  }
  for (const d of android) if (!used.has(d.appId)) report('⚠️', `${labelAndroid(d)}: iOS と対応せず除外（追加するなら --pair を使います）`);
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

// Prints the numbers Baynex needs to register this repository for CI access (GitHub OIDC), and the settings URL.
export async function reportBaynexRegistration({ repo, run = defaultRun, productConfigPath = 'baynex/config.json' }) {
  const result = run('gh', ['api', `repos/${repo}`, '--jq', '[.id,.owner.id]|@tsv']);
  const [repositoryId, ownerId] = result.status === 0 ? result.stdout.trim().split(/\s+/) : [];
  let productId = '';
  try { const value = JSON.parse(await readFile(productConfigPath, 'utf8')).productId; if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)) productId = value; } catch { /* no product yet */ }
  if (/^\d+$/.test(repositoryId || '') && /^\d+$/.test(ownerId || '')) report('✅', `Baynex の CI アクセス登録に必要な値: repositoryId=${repositoryId} ownerId=${ownerId}（${repo}）`);
  else report('⚠️', `${repo}: repositoryId / ownerId を取得できません。gh api repos/${repo} --jq '.id,.owner.id' で確認してください`);
  if (productId) report('✅', `Baynex の設定画面（CI アクセスを登録）: https://preview.baynex.jp/products/${productId}?view=apps`);
  else report('⚠️', 'baynex/config.json に productId がありません。Baynex の製品ページの「アプリ」設定から CI アクセスを登録してください');
  return { repositoryId, ownerId, productId };
}

export async function bootstrap({ project, repo, appleAccount, short, appDir, out = 'distribution/apps.json', dryRun = false, includeNew = false, pairs = [] }, deps = {}) {
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
  const interactive = deps.interactive ?? (!!process.stdin.isTTY && !!process.stdout.isTTY);
  const apps = await pairApps(ios, android, previous.apps, appleAccount, { includeNew: includeNew || !previous.apps?.length || pairs.length > 0, pairs, interactive, ...(deps.ask ? { ask: deps.ask } : {}) });
  if (!apps.length) throw new Error('iOS と Android のペアが見つかりません');
  if (new Set(apps.map((app) => app.id)).size !== apps.length) throw new Error('アプリ ID が重複しています。識別子の組を確認してください');
  const commandRun = deps.run || defaultRun;
  const detected = await (deps.detectPrivateDependencies || detectPrivateDependencies)({ appRepo: repo, appDir, run: commandRun });
  const privateGitDependencies = mergeDependencies(previous.privateGitDependencies, detected.repos);
  const config = { appDir, firebaseProject: project, gcp: { workloadIdentityProvider: provider, uploaderServiceAccount: serviceAccount }, apps,
    appleAccounts: { ...(previous.appleAccounts || {}), [appleAccount]: accountNames(appleAccount) },
    ...(previous.privateGitDependencies === undefined && !privateGitDependencies.length ? {} : { privateGitDependencies }),
    ...(previous.flutterVersion === undefined ? {} : { flutterVersion: previous.flutterVersion }),
    ...(previous.buildNumberOffset === undefined ? {} : { buildNumberOffset: previous.buildNumberOffset }) };
  validateApps(config);
  if (dryRun) report('⚠️', `${out}: ${apps.length} アプリを書き込み予定`);
  else { await mkdir(dirname(out), { recursive: true }); await writeFile(out, `${JSON.stringify(config, null, 2)}\n`, { flag: 'w' }); report('✅', `${out}: ${apps.length} アプリを書き込みました`); }
  provisionDependencyCredential({ appRepo: repo, repos: privateGitDependencies, dryRun, run: commandRun, ...(deps.makeTempDir ? { makeTempDir: deps.makeTempDir } : {}) });
  for (const app of apps) for (const platform of ['ios', 'android']) {
    if (dryRun) { report('⚠️', `${app.id} ${platform}: App Distribution の開始を確認予定`); continue; }
    const state = await ensureStarted({ appId: app.firebaseAppIds[platform], token,
      fetch: (url, options) => fetchImpl(url, { ...options, headers: { ...options.headers, 'x-goog-user-project': project } }) });
    report('✅', `${app.id} ${platform}: ${state === 'started' ? 'App Distribution を開始' : '開始済み'}`);
  }
  if (apps.some((app) => app.flavor === 'TODO' || app.target === 'TODO')) report('⚠️', 'apps.json の flavor / target の TODO をアプリチームと確認してください。');
  report('⚠️', 'IAM の反映には約 5 分かかることがあります。');
  const crossOwner = repo.split('/')[0].toLowerCase() !== kitOwner;
  const callerDir = deps.callerDir || '.github/workflows';
  for (const name of ['app-distribution', 'app-distribution-check']) {
    const template = `caller-${name}${crossOwner ? '-cross-owner' : ''}.yml`;
    const content = await readFile(new URL(`templates/${template}`, import.meta.url), 'utf8');
    const destination = join(callerDir, `${name}.yml`);
    if (!crossOwner) { console.log(`✅ 追加する caller workflow: ${destination}\n${content}`); continue; }
    let existing = null;
    try { existing = await readFile(destination, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing === content) report('✅', `${destination}: 別オーナー用 caller は最新です`);
    else if (existing !== null && !/^\s*secrets:\s*inherit\s*(?:#.*)?$/m.test(existing)) report('⚠️', `${destination}: 既存の caller を残しました。別オーナーのため secrets を ${template} のように明示してください`);
    else if (dryRun) report('⚠️', `${destination}: 別オーナー用 caller（${template}）を書き込み予定`);
    else { await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, content); report('✅', `${destination}: 別オーナー用 caller（${template}）を書き込みました`); }
  }
  await reportBaynexRegistration({ repo, run: deps.ghApi || defaultRun, ...(deps.productConfigPath ? { productConfigPath: deps.productConfigPath } : {}) });
  report('✅', '確認コマンド: gh workflow run app-distribution-check.yml --ref qa -f ensure_bundle_ids=true -f register_devices=false');
  return config;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2), { '--project': 'string', '--repo': 'string', '--apple-account': 'string', '--short': 'string', '--app-dir': 'string', '--out': 'string', '--dry-run': 'boolean', '--include-new': 'boolean', '--pair': 'multi' });
    await bootstrap({ project: args.project, repo: args.repo, appleAccount: args['apple-account'], short: args.short, appDir: args['app-dir'], out: args.out, dryRun: args['dry-run'], includeNew: args['include-new'], pairs: parsePairSpecs(args.pair) });
  } catch (error) { report('❌', error.message); process.exitCode = error.exitCode || 1; }
}
