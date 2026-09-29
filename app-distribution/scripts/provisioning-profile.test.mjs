// Xcode の cloud signing は、Xcode 自身が作った証明書と、自分で作り直せる
// プロファイルが揃っている前提で動く。証明書を持ち込む構成ではその前提が崩れ、
// API 上に ACTIVE なプロファイルがあっても「見つからない」と言って止まる。
// プロファイルも API から取って手元に置き、署名を自前で完結させる。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDistributionProfile, profileUuid } from './provisioning-profile.mjs';

const profilePlist = (uuid) => Buffer.from(`<?xml version="1.0"?><plist><dict><key>UUID</key><string>${uuid}</string></dict></plist>`);

function client({ profiles = [], devices = [{ id: 'D1' }], created = null, calls = [] } = {}) {
  return {
    calls,
    list: async (path) => {
      calls.push(['list', path]);
      if (path.includes('/v1/profiles')) return profiles;
      if (path.includes('/v1/devices')) return devices;
      if (path.includes('/v1/bundleIds')) return [{ id: 'B1', attributes: { identifier: 'com.example.app' } }];
      return [];
    },
    request: async (path, options) => {
      calls.push(['request', path, options?.method]);
      if (options?.method === 'POST') return { data: created };
      return { data: created };
    },
  };
}

test('使えるプロファイルがあれば作り直さない', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'prof-'));
  try {
    const existing = { id: 'P1', attributes: { name: 'Baynex AdHoc', profileType: 'IOS_APP_ADHOC', profileState: 'ACTIVE', profileContent: profilePlist('UU-1').toString('base64') }, relationships: { bundleId: { data: { id: 'B1' } } } };
    const c = client({ profiles: [existing] });
    const result = await ensureDistributionProfile(c, { bundleIdentifier: 'com.example.app', certificateId: 'C1', directory });
    assert.equal(result.name, 'Baynex AdHoc');
    assert.ok(!c.calls.some(([kind, , method]) => kind === 'request' && method === 'POST'), '作り直している');
    assert.equal((await readFile(join(directory, 'UU-1.mobileprovision'))).toString().includes('UU-1'), true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('無効なプロファイルは使わず作り直す', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'prof2-'));
  try {
    const stale = { id: 'P1', attributes: { name: '古い', profileType: 'IOS_APP_ADHOC', profileState: 'INVALID', profileContent: profilePlist('UU-old').toString('base64') }, relationships: { bundleId: { data: { id: 'B1' } } } };
    const fresh = { id: 'P2', attributes: { name: '新しい', profileType: 'IOS_APP_ADHOC', profileState: 'ACTIVE', profileContent: profilePlist('UU-new').toString('base64') } };
    const c = client({ profiles: [stale], created: fresh });
    const result = await ensureDistributionProfile(c, { bundleIdentifier: 'com.example.app', certificateId: 'C1', directory });
    assert.equal(result.name, '新しい');
    assert.ok(c.calls.some(([kind, , method]) => kind === 'request' && method === 'POST'), '作り直していない');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('プロファイルは他人に読めない権限で置く', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'prof3-'));
  try {
    const existing = { id: 'P1', attributes: { name: 'n', profileType: 'IOS_APP_ADHOC', profileState: 'ACTIVE', profileContent: profilePlist('UU-2').toString('base64') }, relationships: { bundleId: { data: { id: 'B1' } } } };
    await ensureDistributionProfile(client({ profiles: [existing] }), { bundleIdentifier: 'com.example.app', certificateId: 'C1', directory });
    assert.equal((await stat(join(directory, 'UU-2.mobileprovision'))).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('UUID を読み出せない中身は受け付けない', () => {
  assert.equal(profileUuid(Buffer.from('<plist><dict></dict></plist>')), null);
  assert.equal(profileUuid(profilePlist('ABC-123')), 'ABC-123');
});
