#!/usr/bin/env node
// Builds the effective distribution config for this job and points DISTRIBUTION_CONFIG at it.
// Baynex (distribution-config over GitHub OIDC) supplies infra facts; apps.json stays the fallback.
//   mode 'baynex': Baynex values are merged over apps.json; anything Baynex lacks is kept from apps.json.
//   mode 'repo'  : apps.json is used as is; only buildNumber.offset is taken when apps.json has no buildNumberOffset.
//   unreachable / denied: warn and use apps.json. Without apps.json, Baynex must supply the apps.
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BaynexError, postBaynex, toStderr } from './baynex-oidc.mjs';
import { configPath, splitConfigArgs } from './config.mjs';

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const validOffset = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;

function mergeApp(repoApp = {}, remote = {}) {
  const merged = { ...repoApp };
  for (const key of ['id', 'displayName', 'iosBundleId', 'androidPackage', 'flavor', 'target', 'channel']) {
    const value = text(remote[key]);
    if (value !== undefined) merged[key] = value;
  }
  const ids = { ...(repoApp.firebaseAppIds || {}) };
  for (const platform of ['ios', 'android']) {
    const value = text(remote.firebaseAppIds?.[platform]);
    if (value !== undefined) ids[platform] = value;
  }
  if (Object.keys(ids).length) merged.firebaseAppIds = ids;
  return merged;
}

export function mergeConfig(repoConfig, remote) {
  const base = repoConfig ? structuredClone(repoConfig) : {};
  if (!remote) return base;
  const remoteApps = Array.isArray(remote.apps) ? remote.apps.filter((app) => text(app?.id)) : [];
  const info = { mode: remote.mode, revision: remote.revision, productId: text(remote.productId), apple: remote.apple && typeof remote.apple === 'object' ? { name: text(remote.apple.name), available: remote.apple.available === true, cloudSigning: remote.apple.cloudSigning === true } : undefined, branch: remote.branch && typeof remote.branch === 'object' ? { kind: remote.branch.kind, version: remote.branch.version } : undefined };
  base.baynex = JSON.parse(JSON.stringify(info));
  const generated = !repoConfig;
  if (remote.mode !== 'baynex' && !generated) {
    if (base.buildNumberOffset === undefined && validOffset(remote.buildNumber?.offset)) base.buildNumberOffset = remote.buildNumber.offset;
    return base;
  }
  for (const key of ['appDir', 'firebaseProject', 'flutterVersion']) {
    const value = text(remote[key]);
    if (value !== undefined) base[key] = value;
  }
  if (Array.isArray(remote.privateGitDependencies) && remote.privateGitDependencies.length) base.privateGitDependencies = remote.privateGitDependencies.filter((repo) => typeof repo === 'string');
  if (validOffset(remote.buildNumber?.offset)) base.buildNumberOffset = remote.buildNumber.offset;
  const repoApps = Array.isArray(base.apps) ? base.apps : [];
  const apps = repoApps.map((app) => mergeApp(app, remoteApps.find((candidate) => candidate.id === app.id)));
  for (const app of remoteApps) if (!repoApps.some((candidate) => candidate.id === app.id)) apps.push(mergeApp({}, app));
  if (apps.length) base.apps = apps;
  return base;
}

// Returns { config, status: 'ok'|'denied'|'unreachable', mode, warning }.
export async function resolveConfig({ repoConfig, env = process.env, fetch: fetchImpl = fetch, print = toStderr }) {
  let remote = null;
  let status = 'ok';
  let warning = '';
  try {
    remote = await postBaynex('/ci/v1/distribution-config', {}, { env, fetch: fetchImpl, print });
    if (remote.schemaVersion !== 1) { remote = null; status = 'unreachable'; warning = 'Baynex の distribution-config の schemaVersion が未対応です'; }
  } catch (error) {
    status = error instanceof BaynexError && error.denied ? 'denied' : 'unreachable';
    warning = status === 'denied' ? 'Baynex が CI アクセスを拒否しました（リポジトリ未登録の可能性があります）' : `Baynex の設定を取得できません（${error.message}）`;
  }
  const config = mergeConfig(repoConfig, remote);
  return { config, status, mode: remote?.mode || '', warning };
}

export async function runCli(args, env = process.env, fetchImpl = fetch, print = toStderr, warn = toStderr) {
  ({ args, env } = splitConfigArgs(args, env));
  if (args.length) throw new Error('使い方: resolve-config.mjs [--config <apps.json>]');
  const source = configPath(env);
  let repoConfig;
  try { repoConfig = JSON.parse(await readFile(source, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const result = await resolveConfig({ repoConfig, env, fetch: fetchImpl, print });
  if (result.warning) warn(`警告: ${result.warning}。${repoConfig ? `${source} を使います` : ''}`);
  if (!result.config.apps?.length) throw new Error(`${source} がなく、Baynex からもアプリを取得できません`);
  const directory = env.RUNNER_TEMP || tmpdir();
  await mkdir(directory, { recursive: true });
  const target = resolve(join(directory, 'effective-apps.json'));
  await writeFile(target, `${JSON.stringify(result.config, null, 2)}\n`);
  const origin = result.mode ? `Baynex（mode=${result.mode}${result.config.baynex?.revision !== undefined ? ` revision=${result.config.baynex.revision}` : ''}）` : source;
  print(`配布設定: ${origin}${repoConfig && result.mode ? ` + ${source}` : ''} -> ${target}`);
  if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, `DISTRIBUTION_CONFIG=${target}\nBAYNEX_CI_STATUS=${result.status}\nBAYNEX_CI_MODE=${result.mode}\n`);
  return { ...result, target };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runCli(process.argv.slice(2)); }
  catch (error) { console.error(`エラー: ${error.message}`); process.exitCode = 1; }
}
