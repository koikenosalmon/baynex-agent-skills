import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROFILE_TYPE = 'IOS_APP_ADHOC';

export const profileDirectory = () => join(homedir(), 'Library', 'MobileDevice', 'Provisioning Profiles');

/**
 * A .mobileprovision is a signed blob with a plist inside. Xcode matches the file
 * to a profile by the UUID that plist carries, so a profile whose UUID cannot be
 * read is one Xcode cannot be told to use.
 */
export function profileUuid(content) {
  const text = Buffer.isBuffer(content) ? content.toString('latin1') : String(content);
  const match = /<key>UUID<\/key>\s*<string>([-0-9A-Za-z]+)<\/string>/.exec(text);
  return match ? match[1] : null;
}

/**
 * Put a usable ad-hoc profile on disk and say what it is called.
 *
 * Cloud signing expects Xcode to manage profiles itself, which it cannot do for
 * an account whose certificate came from elsewhere: it reports none found even
 * while the API lists an active one. Fetching the profile and naming it in the
 * export options takes Xcode's guesswork out of the build.
 *
 * An existing profile is reused only while Apple still calls it ACTIVE — a
 * profile goes invalid when a device or certificate changes under it, and
 * signing with one that has quietly expired fails later and less clearly.
 */
export async function ensureDistributionProfile(client, { bundleIdentifier, certificateId, directory = profileDirectory(), name } = {}) {
  if (!bundleIdentifier || !certificateId) throw new Error('bundle identifier と証明書が必要です');
  const bundles = await client.list(`/v1/bundleIds?limit=200&filter%5Bidentifier%5D=${encodeURIComponent(bundleIdentifier)}`);
  const bundle = bundles.find((entry) => entry.attributes?.identifier === bundleIdentifier);
  if (!bundle) throw new Error(`Bundle ID がありません: ${bundleIdentifier}`);

  const profiles = await client.list('/v1/profiles?limit=200&include=bundleId');
  const usable = profiles.find((entry) => entry.attributes?.profileType === PROFILE_TYPE
    && entry.attributes?.profileState === 'ACTIVE'
    && entry.relationships?.bundleId?.data?.id === bundle.id);

  let profile = usable;
  if (!profile) {
    const devices = await client.list('/v1/devices?limit=200&filter%5Bstatus%5D=ENABLED');
    const body = { data: { type: 'profiles',
      attributes: { name: name || `Baynex ${bundleIdentifier} AdHoc`, profileType: PROFILE_TYPE },
      relationships: {
        bundleId: { data: { type: 'bundleIds', id: bundle.id } },
        certificates: { data: [{ type: 'certificates', id: certificateId }] },
        devices: { data: devices.map((device) => ({ type: 'devices', id: device.id })) },
      } } };
    const created = await client.request('/v1/profiles', { method: 'POST', body: JSON.stringify(body) });
    profile = created.data;
  }

  const content = Buffer.from(profile.attributes.profileContent, 'base64');
  const uuid = profileUuid(content);
  if (!uuid) throw new Error('プロファイルの UUID を読み出せません');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${uuid}.mobileprovision`), content, { mode: 0o600, flag: 'w' });
  return { name: profile.attributes.name, uuid };
}
