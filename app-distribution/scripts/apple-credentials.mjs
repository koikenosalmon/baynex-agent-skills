#!/usr/bin/env node
// Loads the Apple signing key for the iOS job. Order: Baynex OIDC (cloud-signing) -> Secret Manager -> legacy GitHub secrets.
// The files land where the workflow already expects them (app-store-connect.p8 and the key/issuer id files, mode 0600).
import { appendFileSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { postBaynex, toStderr } from './baynex-oidc.mjs';
import { readConfig, splitConfigArgs } from './config.mjs';
import { writeAccountFiles, writeDistributionFiles } from './secret-manager.mjs';

const keyIdPattern = /^[A-Z0-9]{10}$/;
const issuerPattern = /^[a-fA-F0-9-]{36}$/;
const files = { keyP8: 'app-store-connect.p8', keyId: 'app-store-connect-key-id', issuerId: 'app-store-connect-issuer-id' };
export const sourceLabels = { baynex: 'Baynex OIDC', 'secret-manager': 'Secret Manager', 'github-secrets': 'GitHub Secrets' };

function maskAll(values, print) {
  for (const value of values) for (const line of String(value).split(/\r?\n/)) if (line.trim() && !line.startsWith('-----')) print(`::add-mask::${line.trim()}`);
}

export async function fetchAscToken(options = {}) {
  const data = await postBaynex('/ci/v1/apple-credentials', { purpose: 'asc-token' }, options);
  if (typeof data.token !== 'string' || data.token.length < 20 || /\s/.test(data.token)) throw new Error('Baynex の asc-token 応答が不正です');
  (options.print || toStderr)(`::add-mask::${data.token}`);
  return { token: data.token, teamId: typeof data.teamId === 'string' ? data.teamId : '', expiresAt: data.expiresAt };
}

export async function fetchCloudSigning(options = {}) {
  const data = await postBaynex('/ci/v1/apple-credentials', { purpose: 'cloud-signing' }, options);
  if (!keyIdPattern.test(data.keyId || '') || !issuerPattern.test(data.issuerId || '') || typeof data.privateKey !== 'string' || !data.privateKey.includes('PRIVATE KEY')) throw new Error('Baynex の cloud-signing 応答が不正です');
  maskAll([data.keyId, data.issuerId, data.privateKey], options.print || toStderr);
  return { keyId: data.keyId, issuerId: data.issuerId, keyP8: data.privateKey };
}

export async function writeCredentialFiles(directory, values) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [key, filename] of Object.entries(files)) {
    const path = join(directory, filename);
    await writeFile(path, values[key], { mode: 0o600, flag: 'w' });
    await chmod(path, 0o600);
  }
}

export async function loadAppleCredentials({ slug = '', directory, config, env = process.env, fetch: fetchImpl = fetch, print = toStderr, warn = toStderr, loadFallback = writeAccountFiles }) {
  if (!directory) throw new Error('出力先ディレクトリがありません');
  const skipBaynex = config?.baynex?.apple?.available === false;
  let baynexOk = false;
  if (!skipBaynex) {
    try {
      const values = await fetchCloudSigning({ env, fetch: fetchImpl, print });
      await writeCredentialFiles(directory, values);
      print(`Apple 鍵の取得経路: ${sourceLabels.baynex}`);
      baynexOk = true;
    } catch (error) {
      warn(`Baynex OIDC で Apple 鍵を取得できませんでした（${error.message}）。Secret Manager / GitHub Secrets にフォールバックします`);
    }
  }
  if (baynexOk) {
    // Baynex only supplies the ASC API key. The repo's appleAccount still owns the distribution certificate (any resolve mode),
    // so the manual-signing path stays selected instead of falling to cloud signing and the managed fallback.
    await writeDistributionFiles({ account: slug ? config?.appleAccounts?.[slug] : undefined, directory, token: env.GOOGLE_OAUTH_ACCESS_TOKEN, fetch: fetchImpl, print });
    return 'baynex';
  }
  if (!slug) throw new Error('Baynex から Apple 鍵を取得できず、apps.json に appleAccount もありません。Baynex の CI アクセスを登録するか、appleAccount / appleAccounts を設定してください');
  let source = 'github-secrets';
  await loadFallback({
    config: config || await readConfig(env), slug, directory, token: env.GOOGLE_OAUTH_ACCESS_TOKEN,
    fallback: { keyP8: env.APP_STORE_CONNECT_KEY_P8, keyId: env.APP_STORE_CONNECT_KEY_ID, issuerId: env.APP_STORE_CONNECT_ISSUER_ID },
    fetch: fetchImpl, print, onSource: (name) => { source = name; },
  });
  print(`Apple 鍵の取得経路: ${sourceLabels[source]}`);
  return source;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { args, env } = splitConfigArgs(process.argv.slice(2));
    if (args.length !== 3 || args[0] !== 'load') throw new Error('使い方: apple-credentials.mjs load <account または空文字> <directory> [--config <apps.json>]');
    let config;
    try { config = await readConfig(env); } catch { config = undefined; }
    const source = await loadAppleCredentials({ slug: args[1], directory: args[2], config, env });
    if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, `APPLE_KEY_SOURCE=${source}\n`);
  } catch (error) { console.error(`エラー: ${error.message}`); process.exitCode = 1; }
}
