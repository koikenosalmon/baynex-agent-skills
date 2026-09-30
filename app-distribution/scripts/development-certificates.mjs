// Xcode cloud signing (-allowProvisioningUpdates) on an ephemeral runner mints a new "Apple Development" certificate
// through the App Store Connect API on every run: the private key dies with the runner, so Xcode never reuses it.
// Apple caps the number of certificates per team; once it is reached, archive fails with "Choose a certificate to revoke".
// This module only COUNTS them. It never revokes anything.
export const DEV_CERT_WARN_THRESHOLD = 5;
export const API_CERT_NAME = 'Created via API';
const DEVELOPMENT_TYPES = new Set(['DEVELOPMENT', 'IOS_DEVELOPMENT']);

export async function countApiDevelopmentCertificates(client) {
  const certificates = await client.list('/v1/certificates?limit=200&filter%5BcertificateType%5D=DEVELOPMENT,IOS_DEVELOPMENT');
  const development = certificates.filter((entry) => DEVELOPMENT_TYPES.has(entry.attributes?.certificateType));
  const api = development.filter((entry) => (entry.attributes?.name ?? entry.attributes?.displayName) === API_CERT_NAME);
  return { development: development.length, api: api.length, warn: api.length >= DEV_CERT_WARN_THRESHOLD, threshold: DEV_CERT_WARN_THRESHOLD };
}

export function developmentCertificateAdvice({ api }) {
  return `Apple Development 証明書が API 経由で ${api} 件作られています（-allowProvisioningUpdates を使う cloud signing は runner ごとに新規作成し、秘密鍵を失います）。上限に達すると archive が失敗します。apps.json の appleAccounts に distributionP12Secret を設定して手動署名に切り替え、不要な証明書は Apple Developer で手動で失効させてください（このツールは失効させません）`;
}
