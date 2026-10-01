# Baynex アプリ配布キット

Flutter アプリの GitHub リポジトリを Baynex「アプリ配布」に接続します。`bootstrap.mjs` が GCP API、GitHub OIDC 用 Workload Identity、CI サービスアカウントの権限、Firebase アプリの検出、`distribution/apps.json` の生成、Firebase App Distribution の開始を行います。CI は Android APK と iOS のクラウド署名 Ad Hoc IPA を作り、Firebase にアップロードします。リリースノート末尾の `[baynex]` に branch、commit、run、必要に応じて version / theme / tasks を記録します。テスターグループと通知は Baynex が管理します。

所有者にお願いする操作は Google ログインと、Apple アカウントごとに一度のキー登録だけです。ほかのクラウド操作はキットが行います。

1. オペレーターが `gcloud auth login --no-launch-browser` で Google にログインする。コードは自分の端末に入力します。
2. Apple アカウントごとに一度、所有者が App Store Connect の Team Key（Admin、名前 `baynex-ci`）を作り、Secret Manager に `.p8`、Key ID、Issuer ID の 3 バージョンを登録する。値はチャットに貼りません。

生成された `flavor` と `target` の確認はアプリの既存コードと照合して行います。判断できない場合だけアプリチームに聞いてください。

## Baynex で CI 連携を有効にする（推奨）

Baynex の製品にこのリポジトリの CI アクセスを登録すると、CI は GitHub Actions の OIDC トークンで `https://api.baynex.jp/ci/v1/*` に問い合わせ、Apple 鍵と配布設定を Baynex から受け取ります。Secret Manager の Apple 鍵や GitHub Secrets の `APP_STORE_CONNECT_*` を用意しなくても、iOS のクラウド署名と bundle ID / 端末登録が動きます。

1. `bootstrap.mjs` の出力（またはその末尾）に表示される `repositoryId` と `ownerId` を控えます。手動なら `gh api repos/<owner>/<repo> --jq '.id,.owner.id'` です。
2. Baynex の製品ページ `https://preview.baynex.jp/products/<productId>?view=apps`（`baynex/config.json` の `productId` から `bootstrap.mjs` が表示します）で、CI アクセスにそのリポジトリを登録して有効にします。
3. `app-distribution-check.yml` を実行し、Summary の `Baynex | CI アクセス` が ✅、`鍵の取得経路 | Apple` が `Baynex OIDC` になっていることを確認します。

Baynex は、kit の reusable workflow（`app-distribution.yml` / `app-distribution-check.yml`）を `main`、`vN`、`vN*` タグの参照で呼んだ、GitHub ホストランナー上の `push` / `workflow_dispatch` / `schedule` の実行だけを受け付けます。登録済みで有効なリポジトリであることも必要です。OIDC トークンは 1 回限りなので、呼び出しごとに新しいトークンを取得します（値はログに出さず `::add-mask::` で隠します）。caller には `id-token: write` が必要です（テンプレートには含まれています）。

配布設定の扱い（`scripts/resolve-config.mjs`、detect ジョブと各ジョブの冒頭で実行）:

| Baynex の mode | 動作 |
| --- | --- |
| `baynex` | Firebase の ID、bundle ID、`flutterVersion`、`privateGitDependencies`（空でなければ）、ビルド番号のオフセットを Baynex の値で `apps.json` に上書きします。Baynex が値を持たない項目（`flavor`、`target`、`appDir` など）は `apps.json` のまま残ります。 |
| `repo` | `apps.json` をそのまま使います。`buildNumberOffset` が `apps.json` にないときだけ Baynex の値を取り込みます。 |
| 拒否・未到達 | 警告を出して `apps.json` を使います（従来どおり）。 |

`distribution/apps.json` がなく Baynex がアプリを返す場合は、`$RUNNER_TEMP/effective-apps.json` に実効設定を生成して使います。Baynex が Apple 鍵を提供できるとき、`appleAccount` と `appleAccounts` は省略できます（名前を二重に管理しません）。

Apple 鍵の取得順（iOS ジョブ、`scripts/apple-credentials.mjs`）:

1. Baynex OIDC の `cloud-signing`（QA / release の ref だけ）。`.p8` と Key ID / Issuer ID を `$RUNNER_TEMP/apple-account/` に 0600 で書きます。
2. 401 / 403 / 404 / 通信エラーなどのときは Secret Manager（`secret-manager.mjs` の `load-account`）。
3. それも使えなければ、旧 GitHub Secrets（`APP_STORE_CONNECT_KEY_P8` / `_KEY_ID` / `_ISSUER_ID`）。

どの経路を使ったかはログと Summary に出ます（値は出しません）。bundle ID の登録・端末登録・check の App Store Connect API 呼び出しは、まず Baynex の `asc-token`（約 20 分有効の JWT）を使い、取得できなければ読み込んだ鍵から JWT を作ります。

## Baynex を使わない場合（従来の経路）

CI アクセスを登録しなくても、これまでの手順（Secret Manager に Apple 鍵を登録、`distribution/apps.json` に設定を持つ）でそのまま動きます。Baynex への問い合わせが拒否されても workflow は失敗せず、警告を出して従来の経路にフォールバックします。

## 新しいプロジェクト

Node.js 20 以上と `gcloud` を用意します。Firebase iOS / Android アプリが属する GCP プロジェクトで操作権限が必要です。アプリリポジトリのルートから、キットを隣のディレクトリに clone して実行します。

```sh
gcloud auth login --no-launch-browser
git clone --depth 1 --branch v1 https://github.com/koikenosalmon/baynex-agent-skills.git ../baynex-agent-skills
node ../baynex-agent-skills/app-distribution/add-apple-account.mjs --slug example
node ../baynex-agent-skills/app-distribution/bootstrap.mjs --project example-dev --repo example/app --apple-account example --app-dir native
```

`add-apple-account.mjs` は既存のアカウントなら省略できます。出力された Secret Manager の 3 リンクで、所有者が `.p8` をアップロードし、Key ID と Issuer ID を貼り付けます。`bootstrap.mjs` は secret の読み取り権限を CI サービスアカウントに付与します。作成内容を確認するには `--dry-run` を使えます。既存設定は再利用し、再実行できます。既に `apps.json` がある場合は、登録済みのアプリと表示名、flavor / target をそのまま残します。Firebase で見つかった新しいアプリは候補として表示するだけで、追加するときは `--include-new` を付けて再実行します。`--short` で pool とサービスアカウントの接頭辞、`--out` で JSON の出力先を変えられます。

生成された `distribution/apps.json` を開き、iOS / Android の組を確認してください。

### iOS / Android の対応付け

対応は推測で決めず、黙って除外もしません。`apps.json` に登録済みの組と、表示名・識別子の末尾で一意に決まる組はそのまま使います。一意に決まらない iOS アプリがあるときは次のように動きます。

- 端末（TTY）で実行: 候補を番号付きで表示して選びます（`s` でそのアプリを追加しない）。
- 非対話（CI やパイプ）: 候補を一覧してから終了コード 2 で止まります。表示された ID を `--pair` で指定して再実行します（複数回指定できます）。

```sh
node ../baynex-agent-skills/app-distribution/bootstrap.mjs --project example-dev --repo example/app --apple-account example \
  --pair ios=1:111:ios:aaa,android=1:111:android:bbb --pair ios=1:111:ios:ccc,android=1:111:android:ddd
```

`--pair` で指定したアプリは `--include-new` なしでも追加されます。各アプリの `flavor: "TODO"` と `target: "TODO"` を実際の Flutter flavor と Dart エントリポイントに直してください。`target` は `lib/main_example.dart` のように指定します。

次にテンプレートをアプリリポジトリへコピーします。

```sh
mkdir -p .github/workflows
cp ../baynex-agent-skills/app-distribution/templates/caller-app-distribution.yml .github/workflows/app-distribution.yml
cp ../baynex-agent-skills/app-distribution/templates/caller-app-distribution-check.yml .github/workflows/app-distribution-check.yml
```

両 caller は `permissions: contents: read, id-token: write` と `secrets: inherit` を含みます。`--repo` の所有者がキットの所有者（`koikenosalmon`）と異なる場合、`bootstrap.mjs` は上の代わりに別オーナー用テンプレート（後述）を `.github/workflows/` へ自動で書き込みます（既存ファイルは `secrets: inherit` を含むときだけ置き換え、手で直した明示マッピング版は残します。`--dry-run` では書きません）。`config-path` を変更した場合は `distribution/apps.json` の場所に合わせます。テンプレートの `@v1` と `kit-ref: v1` はキットのリリースブランチ `v1` を指します。キットの修正は `main` にマージしたあと `v1` を同じコミットまで進めると、全プロジェクトの次の実行に反映されます（`git push origin origin/main:v1`）。互換性のない変更は `v2` ブランチで出します。

`apps.json` と caller workflow 2 件をコミットしてから、確認 workflow を実行します。

```sh
gh workflow run app-distribution-check.yml --ref qa -f ensure_bundle_ids=true -f register_devices=false
```

Run log または Summary の表で WIF、Apple の 3 secret、Team ID、bundle ID、Firebase リリース、UDID を確認します。必要なら `register_devices=true` で端末を Apple に登録します。続いてアプリを `qa` に push し、Android / iOS のビルド、Firebase アップロード、Baynex リンクを確認します。`<appDir>/pubspec.yaml` がなければビルドは Summary に理由を表示してスキップします。`BAYNEX_PRODUCT_ID` 変数または `baynex/config.json` の `productId` があれば Baynex リンクが出ます。

CI に署名済み Android APK が必要な場合は、`ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD` を GitHub Actions Secrets に設定し、Gradle で `android/key.properties` を読むようにします。Apple 鍵は共有プロジェクト `baynex-shared` の Secret Manager から読み、CI の一時ファイルは 0600 で作成し終了時に消します。

## 別の組織から呼ぶとき

`secrets: inherit` は同じ組織（または Enterprise）内の呼び出しでしか secrets を渡しません。キットの所有者（`koikenosalmon`）と異なるアカウントや組織のリポジトリから呼ぶと、reusable workflow 側の `secrets.*` がすべて空になります。その場合は `caller-app-distribution-cross-owner.yml` と `caller-app-distribution-check-cross-owner.yml` をコピーしてください。各 secret を `NAME: ${{ secrets.NAME }}` で明示的に渡します。キットは使う secret を `on.workflow_call.secrets` に宣言しているため、同じ組織の caller は従来どおり `secrets: inherit` を使えます。キットに secret が増えたときは、別の組織の caller のマッピングにも追加します。今回 check 用にも `ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD` を宣言したため、既存の別オーナー caller は check 側のマッピングに同 4 件を足すと、Android 署名 secret の到達も確認できます（足さなくても動き、その secret は『受信していません』と表示されるだけです）。

別オーナーの caller が `secrets: inherit` のままだと、check workflow が `Caller` 行で ❌ を出し、cross-owner テンプレートを使うよう案内します。

## check workflow が確認すること

Summary の表に次の行が追加されます（secret の値は表示しません）。

| 区分 | 内容 |
| --- | --- |
| Baynex | `CI アクセス`。resolve-config の結果（許可 ✅ / 拒否・未到達 ⚠️）。 |
| 鍵の取得経路 | Apple の鍵を Baynex OIDC / Secret Manager / GitHub Secrets のどれで取れるか（この順に優先）。 |
| GitHub Secrets | 宣言した 9 件の secret が実際に届いたか（有無のみ）。任意の secret は未受信でも ⚠️ です。 |
| Caller | 別オーナーの caller が `secrets: inherit` を使っていれば ❌。 |
| Secret マスク | 受信した secret の値（3 文字以上）が `apps.json` の文字列に含まれると ❌。secret 名と `apps.json` のキーだけを表示します（下の『マスクの衝突』参照）。 |
| Apple クラウド署名の権限 | ASC キーで `GET /v1/users?limit=1`。200 なら ✅、403 なら ❌『Admin のチームキーが必要』、その他は ⚠️ 判定不能。 |
| 非公開 Git 依存 `<repo> 到達性` | 設定した認証情報で `git ls-remote` を実行し、失敗したら ❌。 |
| ビルド番号 | この check の `run_number + buildNumberOffset` が Firebase の最大ビルド番号より小さいと ⚠️。配布 workflow の `run_number` とは別なので目安です。 |

### マスクの衝突

GitHub Actions は secret の値を含む文字列をログとジョブ出力から取り除きます（部分一致）。たとえば `ANDROID_KEY_ALIAS` が `app` だと、`example-app` を含む出力が空になります。配布 workflow は detect ジョブの出力に設定値を載せず、matrix には `apps.json` のインデックスだけを渡して、各ジョブが `apps.json` を読み直します（ジョブ名は `Android / app 0` のようにインデックス表記です）。残る衝突は check の `Secret マスク` 行で見つかるので、secret の値を変えてください。

## Apple アカウントを追加・変更

```sh
node ../baynex-agent-skills/app-distribution/add-apple-account.mjs --slug another
node ../baynex-agent-skills/app-distribution/grant-apple-account.mjs --slug another --service-account example-ci-uploader@example-dev.iam.gserviceaccount.com
```

`add-apple-account.mjs` は 3 件の空 secret を作り、所有者が値を登録する console link を表示します。`grant-apple-account.mjs` は対象 CI サービスアカウントに各 secret の読み取り権限を付けます。別の共有プロジェクトなら両コマンドに `--shared-project` を指定してください。`apps.json` の `appleAccounts` に新しい slug と 3 secret 名を追加し、切り替えるアプリの `appleAccount` をその slug に変更します。再度 check workflow を実行します。

## 非公開の Git 依存

アプリの `pubspec.yaml` が別の非公開 GitHub リポジトリを `git:` 依存にしていると、呼び出し元の `GITHUB_TOKEN` では読めず `flutter pub get` が失敗します。`distribution/apps.json` の最上位に、その依存リポジトリを `owner/repo` の配列で指定します（任意、最大 20 件）。

```json
{ "privateGitDependencies": ["OTERA-Co-Ltd/otera-packages"] }
```

`bootstrap.mjs` は `<appDir>/pubspec.yaml` の GitHub `git:` 依存を調べ、`gh api repos/<owner>/<repo>` で非公開と分かった別リポジトリを `privateGitDependencies` に追加します。依存が 1 件で、アプリリポジトリに `GIT_DEPENDENCY_SSH_KEY` / `GIT_DEPENDENCY_TOKEN` がまだないときは、一時ディレクトリで `ssh-keygen` した鍵を読み取り専用の Deploy key として依存リポジトリに登録し（`gh repo deploy-key add`）、秘密鍵を `gh secret set GIT_DEPENDENCY_SSH_KEY` でアプリリポジトリに設定し、一時ファイルを削除します（鍵は表示しません）。依存リポジトリの管理者権限と `gh` のログインが必要です。組織が Deploy key を無効にしている場合（422 `Deploy keys are disabled`）と、依存が複数ある場合は Deploy key を作らず、下記のトークンを案内します。`--dry-run` では作成せず予定だけ表示します。

認証情報は Actions Secrets に登録します（caller の `secrets: inherit` で渡ります）。両方ある場合は SSH 鍵を使います。

| Secret | 内容 |
| --- | --- |
| `GIT_DEPENDENCY_SSH_KEY` | 依存リポジトリの Deploy key（パスフレーズなしの秘密鍵）。ssh-agent に読み込み、github.com は GitHub 公開のホスト鍵で検証します。 |
| `GIT_DEPENDENCY_TOKEN` | 依存リポジトリの Contents: Read を持つトークン（fine-grained PAT または GitHub App のトークン）。 |

Android / iOS の `flutter pub get` の前に設定し、同じジョブの `flutter build` でも有効です。書き換えは `privateGitDependencies` に列挙したリポジトリの `https://github.com/<owner>/<repo>` だけが対象で、`pubspec.yaml` と同じ表記で書いてください。git の設定は `$RUNNER_TEMP` の 0600 ファイルに置き、`GIT_CONFIG_COUNT` の環境変数で読み込むだけで、グローバルの git 設定は変更しません。ssh-agent、鍵、設定ファイルはジョブ終了時に必ず削除します。`privateGitDependencies` が空なら何もしません。値がどちらもない場合は Summary に設定のお願いを表示し、`flutter pub get` は従来どおり失敗します。`app-distribution-check.yml` の Summary で設定の有無（値は表示しません）を確認できます。

最小権限のために、Deploy key は依存リポジトリごとに作り、書き込み権限なし（read-only）にします。トークンを使う場合は fine-grained PAT で対象を依存リポジトリだけに絞り、Repository permissions は Contents: Read-only のみにして、有効期限を設定してください。Deploy key は 1 リポジトリに 1 つしか登録できません。複数の依存リポジトリがあるときはトークンが扱いやすいです。

## ビルド番号のオフセット

ビルド番号は既定で `github.run_number` です。他の CI から移行した、リポジトリを作り直したなど、Firebase に既に大きなビルド番号があるときは、`distribution/apps.json` の最上位に 0 以上の整数を指定します（任意）。

```json
{ "buildNumberOffset": 1000 }
```

Android / iOS の両ジョブが `--build-number` に `run_number + buildNumberOffset` を渡します（`scripts/build-number.mjs`）。未指定は 0 で従来どおりです。`bootstrap.mjs` を再実行しても値は保持されます。

## Flutter のバージョン固定

CI は既定で Flutter の `stable` 最新版を入れます。アプリが最新版に対応していない場合（例: Gradle の最低バージョンが上がったとき）は、`distribution/apps.json` の最上位に、チームが使っている Flutter のバージョンを `3.41.9` のような形式で指定します（任意）。

```json
{ "flutterVersion": "3.41.9" }
```

指定すると、Android / iOS の両ジョブがそのバージョンを `subosito/flutter-action` に渡します（`channel: stable` は維持）。未指定なら従来どおり `stable` の最新版です。`3.41` や `3.x` のような曖昧な指定は受け付けません。チームが Flutter をアップグレードしたときは、この値も更新してください。`bootstrap.mjs` を再実行しても値は保持されます。

## iOS を自前の Mac で動かす

iOS ジョブは既定で GitHub の `macos-latest` で動きます。自前の Mac（self-hosted runner）で動かすときは、呼び出し側で `ios-runs-on` に `runs-on` の JSON を渡します（任意）。

```yaml
    uses: koikenosalmon/baynex-agent-skills/.github/workflows/app-distribution.yml@v1
    with:
      ios-runs-on: '["self-hosted","macOS","ARM64"]'
```

self-hosted のときは、ビルド前に `/opt/homebrew/bin` を PATH に加え、`xcodebuild`、`pod`、`jq`、`python3`、`openssl` と Ruby の `xcodeproj` gem があるかを確認します。足りないものがあれば Summary に名前を出して止まります（runner のサービスは PATH を引き継がないため、Homebrew の道具が見えないことがあります）。常駐の Mac では Flutter をツールキャッシュに残すので、GitHub のキャッシュには保存しません。署名用の keychain と鍵はジョブの最後に削除します。

## iOS の署名（cloud signing と手動署名フォールバック）

iOS ジョブの署名経路は 2 つです。

- **配布証明書（p12）がある場合（推奨）**: 一時 keychain に配布証明書を入れ、アプリと拡張の各ターゲットの Bundle ID ごとに `IOS_APP_ADHOC` プロファイルを API で取得します。`scripts/ios-project-signing.rb` が CI のチェックアウト上の各ターゲットだけを手動署名（Apple Distribution + ターゲット専用のプロファイル）に書き換え、`-allowProvisioningUpdates` も API キーも渡さずに archive と export を行います。Apple Development 証明書を作る手段が無いため、使い捨て runner で証明書が溜まりません。archive を署名なし（`CODE_SIGNING_ALLOWED=NO`）にしないのは、署名なしの archive には entitlements（`aps-environment` など）が残らず、export の再署名でも復元されないためです。プロファイル指定をコマンドラインの `PROVISIONING_PROFILE_SPECIFIER` にしないのは、Pods を含む全ターゲットに掛かり `does not support provisioning profiles` で失敗するためです（fastlane の `update_code_signing_settings` と同じ考え方です）。
- **配布証明書が無い場合**: 最初に Xcode の cloud signing（`-allowProvisioningUpdates` と App Store Connect API キー）で ad-hoc / release-testing を export します。cloud signing は runner ごとに Apple Development 証明書を API で新規作成し（秘密鍵は runner と一緒に消えます）、チームの上限に達すると `Choose a certificate to revoke` で archive が失敗します。archive 前に API 作成の Development 証明書が 5 件以上あると警告します。`apps.json` の `distributionP12Secret` を設定して上の経路に移ることを推奨します。この経路で `Cloud signing permission error` / `No signing certificate "iOS Distribution" found` / `No profiles for ... were found` により export が失敗したときだけ、自動で管理された手動署名に切り替えます（それ以外の失敗ではフォールバックしません）。

`distribution-check` は Apple アカウントごとに「API 作成の Development 証明書」の件数を表示し、5 件以上で ⚠️ にします（このツールは証明書を失効させません。不要なものは Apple Developer で手動で失効させてください）。

- `scripts/ios-signing.mjs prepare` が Apple Distribution 証明書を 1 つだけ管理します。秘密鍵と証明書は p12 として Secret Manager の `apple-<slug>-dist-p12`（`appleAccounts.<slug>.distP12Secret` で変更可）に JSON で保存し、Apple 上でまだ有効なら再利用します。保存済みが無い、または Apple 上で失効・期限切れのときだけ新規作成します。証明書は失効させません。
- 保存できることを先に確認してから証明書を作るため、鍵を失って枠を消費することはありません。書き込み権限が無いときは何も作らずに止まります（`grant-apple-account.mjs` が `secretVersionAdder` を付与します）。
- Bundle ID ごとに `Baynex AdHoc <bundleId>` という名前の `IOS_APP_ADHOC` プロファイルを、有効な iOS 端末すべてで作り直します。同名（このツールが作ったもの）だけを置き換え、人や Xcode が作ったプロファイルには触れません。
- `scripts/ios-keychain.sh` が一時 keychain とプロファイルを入れ、ジョブ最後に必ず削除します。`ExportOptions.plist` は `signingStyle: manual` と `provisioningProfiles` を使います。
- Apple の配布証明書には上限があります。作成が 409 で断られたら、使われていない証明書を Apple Developer で手動で失効させてから再実行してください。
- 同じ Apple アカウントのアプリを複数同時に初回実行すると、証明書が重複して作られることがあります。初回は 1 アプリずつ実行してください。
- リポジトリ変数 `BAYNEX_IOS_SIGNING` で `auto`（既定）/ `cloud`（フォールバックなし）/ `manual`（最初から手動署名）を選べます。

## 問題があるとき

| 症状 | 対処 |
| --- | --- |
| Firebase リリース一覧が 404 | bootstrap と workflow が probe upload で自動開始します。失敗時は API と `roles/firebaseappdistro.admin` を確認します。 |
| GitHub WIF 認証に失敗 | IAM 反映に約 5 分かかることがあります。待って再実行し、repo 条件と `roles/iam.workloadIdentityUser` を確認します。 |
| check の Baynex CI アクセスが ⚠️ 拒否 | Baynex の製品設定でこのリポジトリ（`repositoryId` / `ownerId`）を登録して有効にします。未登録でも従来の経路で動きます。 |
| archive が `Choose a certificate to revoke` / `No profiles for ... iOS App Development` で失敗する | API 作成の Development 証明書がチームの上限に達しています。Apple Developer で不要な `Created via API` の Development 証明書を手動で失効させ、`distributionP12Secret` を設定して手動署名の経路に移ります。 |
| iOS export が cloud signing で失敗する | 自動で手動署名に切り替わります。`apple-<slug>-dist-p12` の書き込み権限（`secretVersionAdder`）と Apple の配布証明書の上限を確認します。 |
| Apple secret が空または読めない | 所有者に console で新しいバージョンを登録してもらい、`secretAccessor` を確認します。 |
| `Cloud billing quota exceeded` | GCP プロジェクト作成時の課金枠です。所有者に枠の解消を依頼し、勝手に別プロジェクトへ変更しません。 |
| `flavor` / `target` が `TODO` | アプリチームに実際の Flutter 設定を確認します。 |
| bootstrap が終了コード 2 で止まる | iOS / Android の対応が一意でありません。表示された候補から `--pair` で指定します。 |
| ジョブ出力が空になる、値が `***` になる | secret の値が `apps.json` の文字列に含まれています。check の `Secret マスク` 行で secret 名を確認し、値を変えます。 |
| 別オーナーの repo で secrets が空 | caller が `secrets: inherit` です。cross-owner テンプレートに置き換えます。 |
| `flutter pub get` が `git clone ... exit 128` で失敗 | 非公開の Git 依存です。上の「非公開の Git 依存」を設定します。 |
| Baynex にリリースが出ない | Firebase リリースとリリースノート末尾の `[baynex]`、40 桁の commit を確認します。 |

終了後は `gcloud auth revoke` を実行します。トークンや Apple キーはリポジトリやチャットに置きません。キットの YAML は [actionlint](https://github.com/rhysd/actionlint) で検証できます: `actionlint .github/workflows/app-distribution*.yml app-distribution/templates/*.yml`。

CI が使うスクリプトは呼び出し元の `distribution/apps.json` を読みます。別の場所に置く場合は caller の `config-path` を変更します。ローカル実行では `DISTRIBUTION_CONFIG=path/to/apps.json`、または `app-store-connect.mjs` / `secret-manager.mjs` / `distribution-check.mjs` の `--config path/to/apps.json` を使えます。
