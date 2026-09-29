// 署名用の keychain は iOS のビルドでしか意味がない。一度 Android の Build APK 側へ
// 入れてしまい、iOS は何も変わらないまま「直した」ことになっていた。
// 置き場所そのものを固定する。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflow = await readFile(join(root, '.github/workflows/app-distribution.yml'), 'utf8');
const lines = workflow.split('\n');
const at = (needle) => lines.findIndex((line) => line.includes(needle));

test('配布証明書の取り込みは iOS のビルドの中にある', () => {
  const ipa = at('Build cloud-signed IPA');
  const apk = at('Build APK');
  const keychain = at('security create-keychain');
  const buildIos = at('flutter build ios');
  assert.ok(ipa > 0 && apk > 0 && keychain > 0 && buildIos > 0, '目印が見つからない');
  assert.ok(keychain > ipa, 'iOS のビルドより前にある');
  assert.ok(keychain < buildIos, 'iOS のビルドより後にある');
  assert.ok(!(apk < keychain && keychain < ipa), 'Android の Build APK の中にある');
});

test('一時 keychain は run の終わりに必ず消す', () => {
  assert.ok(workflow.includes('security delete-keychain'), '後始末が無い');
  assert.ok(at('security delete-keychain') > at('security create-keychain'), '作る前に消している');
});

test('配布証明書の中身をログに出さない', () => {
  assert.ok(!/echo .*distribution\.p12"/.test(workflow), 'p12 の中身を出している');
  assert.ok(!workflow.includes('cat "$RUNNER_TEMP/apple-account/distribution.p12"'), 'p12 を表示している');
});

// install-profile は App Store Connect を叩くので、鍵が env に無いと
// 署名の判断に入る前に落ちる。一度それで一往復した。
test('iOS のビルドに App Store Connect の鍵が渡っている', () => {
  const ipa = at('Build cloud-signed IPA');
  const run = lines.findIndex((line, index) => index > ipa && line.trim() === 'run: |');
  const block = lines.slice(ipa, run).join('\n');
  for (const name of ['APP_STORE_CONNECT_KEY_P8_FILE', 'APP_STORE_CONNECT_KEY_ID_FILE', 'APP_STORE_CONNECT_ISSUER_ID_FILE']) {
    assert.ok(block.includes(name), `${name} が iOS のビルドに渡っていない`);
  }
});

test('プロファイルの取得には bundle identifier を渡す', () => {
  const command = lines.find((line) => line.includes('install-profile "$'));
  assert.ok(command, 'install-profile の呼び出しが無い');
  assert.ok(command.includes('$APP_IOS_BUNDLE_ID'), 'bundle identifier を渡していない');
});
