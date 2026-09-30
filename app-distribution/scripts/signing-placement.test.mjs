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
  assert.ok(command.includes('$target_bundle_id'), 'ターゲットごとの bundle identifier を渡していない');
  assert.ok(workflow.includes('ios-project-signing.rb" list'), 'ターゲット（拡張を含む）の bundle ID を列挙していない');
});

// 使い捨ての runner で -allowProvisioningUpdates を使うと、Apple Development 証明書が毎回 API で作られる
// (秘密鍵は runner と一緒に消える)。チームの上限に達すると archive が失敗する。
// 配布証明書とプロファイルがあるときの経路には、その手段を一切置かない。
const branch = (start, end) => {
  const from = lines.findIndex((line) => line.includes(start));
  assert.ok(from > 0, `${start} が見つからない`);
  const to = lines.findIndex((line, index) => index > from && line.trim() === end);
  assert.ok(to > from, `${end} が見つからない`);
  return lines.slice(from, to).join('\n');
};

test('手動署名の素材があるときの archive / export は開発証明書を作れない形にする', () => {
  const manual = branch('if [[ "$manual_material" == true ]]; then', 'else');
  assert.match(manual, /xcodebuild archive /);
  assert.match(manual, /ios-project-signing\.rb" apply/, 'ターゲットごとの手動署名を設定していない');
  assert.doesNotMatch(manual.replace(/^\s*#.*$/gm, ''), /allowProvisioningUpdates|authenticationKey|CODE_SIGN_STYLE=Automatic/);
  assert.match(manual, /-exportOptionsPlist/);
});

test('-allowProvisioningUpdates は配布証明書が無い cloud signing の経路にだけある', () => {
  const elseAt = lines.findIndex((line, index) => index > at('if [[ "$manual_material" == true ]]; then') && line.trim() === 'else');
  const uses = lines.map((line, index) => ({ line, index })).filter(({ line }) => /allowProvisioningUpdates/.test(line) && !line.trim().startsWith('#'));
  assert.ok(uses.length > 0);
  for (const { index } of uses) assert.ok(index > elseAt, `${index + 1} 行目が手動署名の経路にある`);
});

test('cloud signing の経路では開発証明書の蓄積を警告する', () => {
  assert.ok(workflow.includes('app-store-connect.mjs" development-certificates'), '件数の確認が無い');
  assert.ok(at('app-store-connect.mjs" development-certificates') < at('xcodebuild archive -workspace ios/Runner.xcworkspace -scheme "$FLAVOR" -archivePath "$RUNNER_TEMP/Runner.xcarchive" "${auth[@]}"'), 'archive より後で確認している');
});

test('ExportOptions は手動署名の素材があるときアプリと拡張すべてのプロファイルを名指しする', () => {
  assert.ok(workflow.includes("options['provisioningProfiles'] = json.load(handle)"));
  assert.ok(workflow.includes("options['signingStyle'] = 'manual'"));
});
