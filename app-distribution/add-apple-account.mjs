#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { accountNames, ensureResource, parseArgs, report } from './cloud.mjs';

export function addAppleAccount({ slug, sharedProject = 'baynex-shared', dryRun = false }) {
  const account = accountNames(slug, sharedProject);
  for (const [name, instruction] of [
    [account.keyP8Secret, '.p8 ファイルをアップロード'],
    [account.keyIdSecret, 'Key ID を貼り付け'],
    [account.issuerIdSecret, 'Issuer ID を貼り付け'],
  ]) {
    ensureResource(name,
      ['secrets', 'describe', name, `--project=${sharedProject}`, '--format=value(name)'],
      ['secrets', 'create', name, `--project=${sharedProject}`, '--replication-policy=automatic', `--labels=apple-account=${slug}`, '--quiet', '--format=none'], dryRun);
    report('⚠️', `${instruction}: https://console.cloud.google.com/security/secret-manager/secret/${name}/versions?project=${sharedProject}`);
  }
  report('⚠️', 'App Store Connect → ユーザとアクセス → 統合 → App Store Connect API で Team Key を作成してください。権限は Admin、名前は baynex-ci です。');
  report('⚠️', 'キーの値はチャットに貼らず、上記 Secret Manager の新しいバージョンに直接登録してください。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2), { '--slug': 'string', '--shared-project': 'string', '--dry-run': 'boolean' });
    addAppleAccount({ slug: args.slug, sharedProject: args['shared-project'], dryRun: args['dry-run'] });
  } catch (error) { report('❌', error.message); process.exitCode = 1; }
}
