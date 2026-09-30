#!/usr/bin/env node
// Redacts credentials from build logs in place before they are uploaded as a workflow artifact.
//   scrub-log.mjs [--env NAME]... <file-or-directory>...
// Values of the named environment variables (every line of a multi-line value) and common credential
// shapes are replaced with ***. Prints nothing on stdout.
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MIN_SECRET_LENGTH = 4;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const patterns = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '***'],
  [/(x-access-token:)[^@\s/]+@/gi, '$1***@'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '***'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '***'],
  [/(authorization["']?\s*[:=]\s*["']?(?:bearer|basic)\s+)[^\s"']+/gi, '$1***'],
  [/\b((?:store|key)Password\s*[=:]\s*)\S+/g, '$1***'],
  [/\b(ACTIONS_ID_TOKEN_REQUEST_TOKEN\s*[=:]\s*)\S+/g, '$1***'],
];

export function secretValues(names, env = process.env) {
  const values = new Set();
  for (const name of names) {
    const value = env[name];
    if (typeof value !== 'string') continue;
    for (const candidate of [value.trim(), ...value.split(/\r?\n/).map((line) => line.trim())]) if (candidate.length >= MIN_SECRET_LENGTH) values.add(candidate);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

export function scrubText(text, secrets = []) {
  let result = text;
  for (const secret of secrets) result = result.split(secret).join('***');
  for (const [pattern, replacement] of patterns) result = result.replace(pattern, replacement);
  return result;
}

export function scrubPath(path, secrets) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return 0;
  if (stat.isDirectory()) return readdirSync(path).reduce((count, entry) => count + scrubPath(join(path, entry), secrets), 0);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return 0;
  const before = readFileSync(path, 'utf8');
  const after = scrubText(before, secrets);
  if (after !== before) writeFileSync(path, after);
  return 1;
}

export function runCli(args, env = process.env) {
  const names = [];
  const paths = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--env') {
      if (!args[index + 1]) throw new Error('--env には環境変数名が必要です');
      names.push(args[++index]);
    } else paths.push(args[index]);
  }
  if (!paths.length) throw new Error('使い方: scrub-log.mjs [--env NAME]... <file-or-directory>...');
  const secrets = secretValues(names, env);
  return paths.reduce((count, path) => count + scrubPath(path, secrets), 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { runCli(process.argv.slice(2)); }
  catch (error) { console.error(`エラー: ${error.message}`); process.exitCode = 1; }
}
