#!/usr/bin/env node
// Re-reads one app from apps.json by matrix index and exports it through $GITHUB_ENV.
// Config values (project ids, bundle ids, ...) never travel through job outputs, because GitHub
// drops any output that contains a masked secret value as a substring.
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateApps } from './app-store-connect.mjs';
import { readConfig, splitConfigArgs, validateFlutterVersion } from './config.mjs';

function fileProductId(path) {
  try { const value = JSON.parse(readFileSync(path, 'utf8')).productId; return typeof value === 'string' ? value : ''; } catch { return ''; }
}

export function appEnvironment(config, index, env = {}, productConfigPath = 'baynex/config.json') {
  const apps = validateApps(config);
  if (!/^\d{1,2}$/.test(String(index)) || Number(index) >= apps.length) throw new Error('アプリの index が不正です');
  const app = apps[Number(index)];
  const values = {
    APP_DIR: config.appDir || 'native',
    PRODUCT_ID: env.PRODUCT_ID_OVERRIDE || fileProductId(productConfigPath) || config.baynex?.productId || '',
    WIF_PROVIDER: env.WIF_PROVIDER_OVERRIDE || config.gcp?.workloadIdentityProvider || '',
    WIF_SERVICE_ACCOUNT: env.WIF_SERVICE_ACCOUNT_OVERRIDE || config.gcp?.uploaderServiceAccount || '',
    FLUTTER_VERSION: validateFlutterVersion(config),
    APP_ID: app.id,
    APP_DISPLAY_NAME: app.displayName,
    APP_FLAVOR: app.flavor ?? '',
    APP_TARGET: app.target ?? '',
    APP_IOS_BUNDLE_ID: app.iosBundleId ?? '',
    APP_APPLE_ACCOUNT: app.appleAccount ?? '',
    APP_APPLE_TEAM_ID: app.appleTeamId ?? '',
    FIREBASE_APP_ID_IOS: app.firebaseAppIds?.ios ?? '',
    FIREBASE_APP_ID_ANDROID: app.firebaseAppIds?.android ?? '',
  };
  for (const [name, value] of Object.entries(values)) if (typeof value !== 'string' || /[\x00-\x1f]/.test(value)) throw new Error(`apps.json の値に制御文字が含まれます: ${name}`);
  return values;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const parsed = splitConfigArgs(process.argv.slice(2));
    if (parsed.args.length !== 1) throw new Error('使い方: load-app.mjs <index> [--config <apps.json>]');
    const values = appEnvironment(await readConfig(parsed.env), parsed.args[0], parsed.env);
    if (!parsed.env.GITHUB_ENV) throw new Error('GITHUB_ENV がありません');
    appendFileSync(parsed.env.GITHUB_ENV, `${Object.entries(values).map(([name, value]) => `${name}=${value}`).join('\n')}\n`);
  } catch (error) { console.error(`エラー: ${error.message}`); process.exitCode = 1; }
}
