import { execFileSync } from 'node:child_process';

export const slugPattern = /^[a-z][a-z0-9-]{1,30}$/;
export const projectPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
export const serviceAccountPattern = /^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\.iam\.gserviceaccount\.com$/;

export function parseArgs(args, options) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!Object.hasOwn(options, key)) throw new Error(`不明な引数: ${key}`);
    if (options[key] === 'boolean') result[key.slice(2)] = true;
    else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
      if (options[key] === 'multi') (result[key.slice(2)] ||= []).push(args[++i]);
      else result[key.slice(2)] = args[++i];
    }
    else throw new Error(`${key} の値がありません`);
  }
  return result;
}

export function gcloud(args, { allowFailure = false } = {}) {
  try { return execFileSync('gcloud', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 }).trim(); }
  catch (error) {
    if (allowFailure) return null;
    const detail = String(error.stderr || '').trim().split('\n').at(-1);
    throw new Error(`gcloud ${args[0]} に失敗しました: ${detail || error.message}`);
  }
}

export function report(icon, message) { console.log(`${icon} ${message}`); }

export function ensureResource(label, describeArgs, createArgs, dryRun = false) {
  if (gcloud(describeArgs, { allowFailure: true }) !== null) { report('✅', `${label}: 設定済み`); return; }
  if (dryRun) { report('⚠️', `${label}: 作成予定`); return; }
  try { gcloud(createArgs); }
  catch (error) {
    if (gcloud(describeArgs, { allowFailure: true }) === null) throw error;
  }
  report('✅', `${label}: 作成済み`);
}

export function accountNames(slug, project = 'baynex-shared') {
  if (!slugPattern.test(slug)) throw new Error('Apple アカウント slug が不正です');
  if (!projectPattern.test(project)) throw new Error('共有 GCP プロジェクト ID が不正です');
  return {
    secretProject: project,
    keyP8Secret: `apple-${slug}-key-p8`,
    keyIdSecret: `apple-${slug}-key-id`,
    issuerIdSecret: `apple-${slug}-issuer-id`,
  };
}
