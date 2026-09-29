import { readFile } from 'node:fs/promises';

export function configPath(env = process.env) {
  return env.DISTRIBUTION_CONFIG || 'distribution/apps.json';
}

export function splitConfigArgs(args, env = process.env) {
  const index = args.indexOf('--config');
  if (index < 0) return { args, env };
  if (!args[index + 1] || args[index + 1].startsWith('--') || args.lastIndexOf('--config') !== index) throw new Error('--config のパスが不正です');
  return { args: args.filter((_, position) => position !== index && position !== index + 1), env: { ...env, DISTRIBUTION_CONFIG: args[index + 1] } };
}

export async function readConfig(env = process.env) {
  return JSON.parse(await readFile(configPath(env), 'utf8'));
}

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function validatePrivateGitDependencies(config) {
  const repos = config?.privateGitDependencies;
  if (repos === undefined) return [];
  if (!Array.isArray(repos) || repos.length > 20 || repos.some((repo) => typeof repo !== 'string' || !repoPattern.test(repo) || repo.split('/').some((part) => part === '.' || part === '..'))) throw new Error('apps.json の privateGitDependencies が不正です（"owner/repo" の配列、最大 20 件）');
  if (new Set(repos.map((repo) => repo.toLowerCase())).size !== repos.length) throw new Error('apps.json の privateGitDependencies に重複があります');
  return repos;
}

const flutterVersionPattern = /^\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?$/;

export function validateFlutterVersion(config) {
  const version = config?.flutterVersion;
  if (version === undefined) return '';
  if (typeof version !== 'string' || version.length > 64 || !flutterVersionPattern.test(version)) throw new Error('apps.json の flutterVersion が不正です（"3.41.9" のようなバージョン文字列）');
  return version;
}

export function validateBuildNumberOffset(config) {
  const offset = config?.buildNumberOffset;
  if (offset === undefined) return 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000_000) throw new Error('apps.json の buildNumberOffset が不正です（0 以上の整数）');
  return offset;
}
