#!/usr/bin/env node
// Managed manual signing for iOS ad-hoc exports.
//
// Xcode cloud signing (-allowProvisioningUpdates + API key) is documented for App Store Connect / Developer ID /
// Enterprise distribution. For ad-hoc / release-testing exports it fails in CI with "Cloud signing permission error" and
// "No signing certificate 'iOS Distribution' found". This script is the fallback: it keeps ONE Apple Distribution
// certificate per Apple account (private key stored as a p12 bundle in Secret Manager, like fastlane match), builds a fresh
// IOS_APP_ADHOC profile per bundle ID with every enabled device, and writes a manual-signing ExportOptions.plist.
//
// Rules: never revoke a certificate; create one only when no stored one is still valid on Apple; stdout is a single JSON
// document without secrets (paths and public IDs only); diagnostics go to stderr.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { toStderr } from './baynex-oidc.mjs';
import { createClient } from './app-store-connect.mjs';
import { readSecretOptional, ensureSecret, addSecretVersion, canAddSecretVersion } from './secret-manager.mjs';
import { readConfig, splitConfigArgs } from './config.mjs';
import { timedFetch } from './http.mjs';

const run = promisify(execFile);
const bundlePattern = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const teamPattern = /^[A-Z0-9]{10}$/;
const methods = new Set(['ad-hoc', 'release-testing']);
const CERT_TYPES = ['DISTRIBUTION', 'IOS_DISTRIBUTION'];
export const PROFILE_PREFIX = 'Baynex AdHoc';
// Errors from xcodebuild -exportArchive that mean "cloud signing cannot sign this export": fall back to managed signing.
// Keep identical to `cloud_failure` in .github/workflows/app-distribution.yml (a test enforces it).
export const CLOUD_SIGNING_FAILURE = 'Cloud signing permission error|No signing certificate .?(iOS|Apple) Distribution.? found|No profiles for .+ were found';

export function profileName(bundleId) { return `${PROFILE_PREFIX} ${bundleId}`; }
export function distSecretName(slug) { return `apple-${slug}-dist-p12`; }

async function openssl(args, env = {}) {
  try { await run('openssl', args, { env: { ...process.env, ...env }, maxBuffer: 10 * 1024 * 1024 }); }
  catch (error) { throw new Error(`openssl ${args[0]} に失敗しました`); }
}

// RSA key + CSR. The key never leaves `dir` (0700, removed by the caller).
export async function generateCsr(dir) {
  const keyPath = join(dir, 'key.pem');
  const csrPath = join(dir, 'request.csr');
  await openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', csrPath, '-subj', '/CN=Baynex CI Distribution/O=Baynex/C=JP']);
  await chmod(keyPath, 0o600);
  return { keyPath, csr: await readFile(csrPath, 'utf8') };
}

const pem = (der) => `-----BEGIN CERTIFICATE-----\n${Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;

// 3DES/SHA1 keeps the p12 importable by macOS `security import` whichever openssl (LibreSSL or OpenSSL 3) built it.
export async function buildP12({ dir, keyPath, certDer, password }) {
  const certPath = join(dir, 'cert.pem');
  const p12Path = join(dir, 'bundle.p12');
  await writeFile(certPath, pem(certDer), { mode: 0o600 });
  await openssl(['pkcs12', '-export', '-inkey', keyPath, '-in', certPath, '-out', p12Path, '-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES', '-macalg', 'sha1', '-passout', 'env:P12_PASSWORD'], { P12_PASSWORD: password });
  await chmod(p12Path, 0o600);
  return readFile(p12Path);
}

export function parseBundle(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('保存済みの配布証明書データが JSON ではありません'); }
  if (!value || value.version !== 1 || typeof value.certificateId !== 'string' || typeof value.p12Base64 !== 'string' || typeof value.password !== 'string' || !value.p12Base64 || !value.password) throw new Error('保存済みの配布証明書データの形式が不正です');
  return value;
}

async function certificateStillValid(client, bundle, now) {
  let response;
  try { response = await client.request(`/v1/certificates/${encodeURIComponent(bundle.certificateId)}`); }
  catch (error) { if (/Apple API 404/.test(error.message)) return false; throw error; }
  const attrs = response.data?.attributes;
  if (!attrs || !CERT_TYPES.includes(attrs.certificateType)) return false;
  if (attrs.expirationDate && Date.parse(attrs.expirationDate) <= now) return false;
  return true;
}

// Returns { bundle, created }. Creates a certificate only when nothing valid is stored and the secret can be written.
export async function ensureCertificate({ client, secret, fetch: fetchImpl, token, dir, now = Date.now(), print = toStderr }) {
  let stored;
  try { stored = await readSecretOptional({ ...secret, token, fetch: fetchImpl }); }
  catch (error) {
    throw new Error(`管理された配布証明書 ${secret.name} を読めません（${error.message}）。既存の配布証明書を使う場合は apps.json の appleAccounts に distributionP12Secret / distributionP12PasswordSecret / secretProject を設定してください。管理された証明書を使う場合は ${secret.name} の読み取りと追加の権限を CI サービスアカウントに付与してください`);
  }
  if (stored) {
    const bundle = parseBundle(stored);
    if (await certificateStillValid(client, bundle, now)) { print(`保存済みの Apple Distribution 証明書を再利用します（ID ${bundle.certificateId}）`); return { bundle, created: false }; }
    print(`保存済みの証明書 ${bundle.certificateId} は Apple 上で無効です。新しい証明書を作成します（既存の証明書は失効させません）`);
  }
  // Writing must work BEFORE we create anything on Apple, otherwise the new private key would be lost and the team's certificate quota wasted.
  await ensureSecret({ ...secret, token, fetch: fetchImpl });
  if (!(await canAddSecretVersion({ ...secret, token, fetch: fetchImpl }))) throw new Error(`${secret.name} に新しいバージョンを追加する権限がありません（CI サービスアカウントに roles/secretmanager.secretVersionAdder が必要です）。証明書は作成していません`);
  const { keyPath, csr } = await generateCsr(dir);
  let created;
  try {
    created = await client.request('/v1/certificates', { method: 'POST', body: JSON.stringify({ data: { type: 'certificates', attributes: { certificateType: 'DISTRIBUTION', csrContent: csr } } }) });
  } catch (error) {
    throw new Error(`Apple Distribution 証明書を作成できません（${error.message}${error.appleDetail ? `: ${error.appleDetail}` : ''}）。チームの配布証明書が上限の場合は、使われていない証明書を Apple Developer で手動で失効させてください（このツールは失効させません）`);
  }
  const certificateId = created.data?.id;
  const content = created.data?.attributes?.certificateContent;
  if (typeof certificateId !== 'string' || typeof content !== 'string') throw new Error('Apple API の証明書応答が不正です');
  const password = randomBytes(24).toString('base64url');
  const p12 = await buildP12({ dir, keyPath, certDer: Buffer.from(content, 'base64'), password });
  const bundle = { version: 1, certificateId, p12Base64: p12.toString('base64'), password };
  try { await addSecretVersion({ ...secret, token, fetch: fetchImpl, value: JSON.stringify(bundle) }); }
  catch (error) { throw new Error(`Apple Distribution 証明書 ${certificateId} は作成しましたが、秘密鍵を ${secret.name} に保存できませんでした（${error.message}）。この証明書は使えないため、Apple Developer で確認してください`); }
  print(`新しい Apple Distribution 証明書を作成し、${secret.name} に保存しました（ID ${certificateId}）`);
  // Concurrent jobs may both create one; the last stored bundle wins so every later run agrees.
  try {
    const latest = await readSecretOptional({ ...secret, token, fetch: fetchImpl });
    if (latest && latest !== JSON.stringify(bundle)) {
      const winner = parseBundle(latest);
      print(`別のジョブが同時に証明書を保存しました。保存済みの ${winner.certificateId} を使います（${certificateId} は未使用のまま残ります）`);
      return { bundle: winner, created: true };
    }
  } catch { /* keep our own bundle */ }
  return { bundle, created: true };
}

export async function ensureProfile({ client, bundleId, certificateId, deviceIds }) {
  const bundles = await client.list(`/v1/bundleIds?limit=200&filter%5Bidentifier%5D=${encodeURIComponent(bundleId)}&filter%5Bplatform%5D=IOS`);
  const bundleResource = bundles.find((entry) => entry.attributes?.identifier === bundleId);
  if (!bundleResource) throw new Error(`Bundle ID が Apple に登録されていません: ${bundleId}`);
  const name = profileName(bundleId);
  const existing = await client.list(`/v1/profiles?limit=200&filter%5Bname%5D=${encodeURIComponent(name)}`);
  // Only profiles this tool created (exact name) are replaced; profiles made by humans or Xcode are left alone.
  for (const profile of existing.filter((entry) => entry.attributes?.name === name)) await client.request(`/v1/profiles/${encodeURIComponent(profile.id)}`, { method: 'DELETE' });
  const body = { data: { type: 'profiles', attributes: { name, profileType: 'IOS_APP_ADHOC' }, relationships: {
    bundleId: { data: { type: 'bundleIds', id: bundleResource.id } },
    certificates: { data: [{ type: 'certificates', id: certificateId }] },
    devices: { data: deviceIds.map((id) => ({ type: 'devices', id })) } } } };
  const response = await client.request('/v1/profiles', { method: 'POST', body: JSON.stringify(body) });
  const attrs = response.data?.attributes;
  if (!attrs?.profileContent || !attrs.uuid || !/^[A-Fa-f0-9-]{36}$/.test(attrs.uuid)) throw new Error('Apple API のプロファイル応答が不正です');
  return { bundleId, name, uuid: attrs.uuid, content: Buffer.from(attrs.profileContent, 'base64') };
}

const xml = (text) => String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
export function exportOptionsPlist({ method, teamId, profiles }) {
  if (!methods.has(method) || !teamPattern.test(teamId)) throw new Error('ExportOptions の method / Team ID が不正です');
  const entries = profiles.map((profile) => `      <key>${xml(profile.bundleId)}</key>\n      <string>${xml(profile.name)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>method</key>\n  <string>${method}</string>\n  <key>signingStyle</key>\n  <string>manual</string>\n  <key>signingCertificate</key>\n  <string>Apple Distribution</string>\n  <key>teamID</key>\n  <string>${teamId}</string>\n  <key>provisioningProfiles</key>\n  <dict>\n${entries}\n  </dict>\n</dict>\n</plist>\n`;
}

export async function prepare({ client, secret, token, fetch: fetchImpl = timedFetch, out, teamId, method, bundleIds, now, print = toStderr }) {
  if (!teamPattern.test(teamId || '') || !methods.has(method)) throw new Error('--team / --method が不正です');
  if (!Array.isArray(bundleIds) || !bundleIds.length || bundleIds.length > 20 || bundleIds.some((id) => !bundlePattern.test(id))) throw new Error('--bundle-ids が不正です');
  const work = await mkdtemp(join(tmpdir(), 'ios-signing-'));
  try {
    const { bundle, created } = await ensureCertificate({ client, secret, fetch: fetchImpl, token, dir: work, now, print });
    const devices = await client.list('/v1/devices?limit=200&filter%5Bplatform%5D=IOS&filter%5Bstatus%5D=ENABLED');
    if (!devices.length) throw new Error('Apple に有効な iOS 端末が登録されていません');
    const profiles = [];
    for (const bundleId of [...new Set(bundleIds)]) profiles.push(await ensureProfile({ client, bundleId, certificateId: bundle.certificateId, deviceIds: devices.map((device) => device.id) }));
    await mkdir(join(out, 'profiles'), { recursive: true, mode: 0o700 });
    const p12Path = join(out, 'signing.p12');
    const passwordPath = join(out, 'p12-password');
    await writeFile(p12Path, Buffer.from(bundle.p12Base64, 'base64'), { mode: 0o600 });
    await writeFile(passwordPath, bundle.password, { mode: 0o600 });
    const files = [];
    for (const profile of profiles) {
      const path = join(out, 'profiles', `${profile.uuid}.mobileprovision`);
      await writeFile(path, profile.content, { mode: 0o600 });
      files.push({ bundleId: profile.bundleId, name: profile.name, uuid: profile.uuid, path });
    }
    const plistPath = join(out, 'ExportOptions.plist');
    await writeFile(plistPath, exportOptionsPlist({ method, teamId, profiles }), { mode: 0o600 });
    return { certificateId: bundle.certificateId, certificateCreated: created, devices: devices.length, p12Path, passwordPath, exportOptions: plistPath, profiles: files };
  } finally { await rm(work, { recursive: true, force: true }); }
}

export function resolveSecret(config, env, slug) {
  const account = slug && config?.appleAccounts?.[slug];
  const project = env.IOS_SIGNING_SECRET_PROJECT || account?.secretProject || (slug ? 'baynex-shared' : '');
  const name = env.IOS_SIGNING_SECRET_NAME || account?.distP12Secret || (slug ? distSecretName(slug) : '');
  if (!project || !name) throw new Error('配布証明書の保存先が決まりません。apps.json の appleAccount を指定するか、IOS_SIGNING_SECRET_PROJECT / IOS_SIGNING_SECRET_NAME を設定してください');
  return { project, name };
}

export async function runCli(argv, env = process.env, fetchImpl = timedFetch) {
  ({ args: argv, env } = splitConfigArgs(argv, env));
  const [command, ...rest] = argv;
  if (command !== 'prepare') throw new Error('使い方: ios-signing.mjs prepare --out <dir> --team <TEAM> --method ad-hoc|release-testing --bundle-ids a,b [--account <slug>]');
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i]?.startsWith('--') || rest[i + 1] === undefined) throw new Error('引数が不正です');
    options[rest[i].slice(2)] = rest[i + 1];
  }
  if (!options.out) throw new Error('--out がありません');
  let config;
  try { config = await readConfig(env); } catch { config = undefined; }
  const secret = resolveSecret(config, env, options.account ?? '');
  const read = async (fileVar, valueVar) => (env[fileVar] ? readFile(env[fileVar], 'utf8') : env[valueVar]);
  const keyP8 = await read('APP_STORE_CONNECT_KEY_P8_FILE', 'APP_STORE_CONNECT_KEY_P8');
  const keyId = (await read('APP_STORE_CONNECT_KEY_ID_FILE', 'APP_STORE_CONNECT_KEY_ID'))?.trim();
  const issuerId = (await read('APP_STORE_CONNECT_ISSUER_ID_FILE', 'APP_STORE_CONNECT_ISSUER_ID'))?.trim();
  const client = createClient({ issuerId, keyId, keyP8 }, fetchImpl);
  return prepare({ client, secret, token: env.GOOGLE_OAUTH_ACCESS_TOKEN, fetch: fetchImpl, out: options.out, teamId: options.team, method: options.method, bundleIds: (options['bundle-ids'] || '').split(',').filter(Boolean) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runCli(process.argv.slice(2)))); }
  catch (error) { console.error(`エラー: ${error.message}`); process.exitCode = 1; }
}
