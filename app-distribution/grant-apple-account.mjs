#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { accountNames, distP12SecretName, gcloud, parseArgs, report, serviceAccountPattern } from './cloud.mjs';

export function grantAppleAccount({ slug, serviceAccount, sharedProject = 'baynex-shared', dryRun = false }) {
  const account = accountNames(slug, sharedProject);
  if (!serviceAccountPattern.test(serviceAccount || '')) throw new Error('サービスアカウントが不正です');
  for (const name of [account.keyP8Secret, account.keyIdSecret, account.issuerIdSecret]) {
    if (gcloud(['secrets', 'describe', name, `--project=${sharedProject}`, '--format=value(name)'], { allowFailure: true }) === null) {
      report('❌', `${name}: Secret Manager にありません。先に add-apple-account.mjs を実行してください`);
      throw new Error(`secret がありません: ${name}`);
    }
    if (dryRun) { report('⚠️', `${name}: secretAccessor を付与予定`); continue; }
    gcloud(['secrets', 'add-iam-policy-binding', name, `--project=${sharedProject}`, `--member=serviceAccount:${serviceAccount}`, '--role=roles/secretmanager.secretAccessor', '--condition=None', '--quiet', '--format=none']);
    report('✅', `${name}: 読み取り権限を確認しました`);
  }
  // ad-hoc manual-signing fallback: CI reads the stored certificate and adds a version only when it has to create one.
  const distName = distP12SecretName(slug);
  if (gcloud(['secrets', 'describe', distName, `--project=${sharedProject}`, '--format=value(name)'], { allowFailure: true }) === null) {
    report('⚠️', `${distName}: Secret Manager にありません。add-apple-account.mjs を再実行すると作成されます（ad-hoc 手動署名フォールバックに必要）`);
  } else if (dryRun) report('⚠️', `${distName}: secretAccessor / secretVersionAdder を付与予定`);
  else {
    for (const role of ['secretAccessor', 'secretVersionAdder']) gcloud(['secrets', 'add-iam-policy-binding', distName, `--project=${sharedProject}`, `--member=serviceAccount:${serviceAccount}`, `--role=roles/secretmanager.${role}`, '--condition=None', '--quiet', '--format=none']);
    report('✅', `${distName}: 読み取りと新バージョン追加の権限を確認しました`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2), { '--slug': 'string', '--service-account': 'string', '--shared-project': 'string', '--dry-run': 'boolean' });
    grantAppleAccount({ slug: args.slug, serviceAccount: args['service-account'], sharedProject: args['shared-project'], dryRun: args['dry-run'] });
  } catch (error) { report('❌', error.message); process.exitCode = 1; }
}
