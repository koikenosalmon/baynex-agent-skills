# Baynex アプリ配布キット

Flutter アプリの GitHub リポジトリを Baynex「アプリ配布」に接続します。`bootstrap.mjs` が GCP API、GitHub OIDC 用 Workload Identity、CI サービスアカウントの権限、Firebase アプリの検出、`distribution/apps.json` の生成、Firebase App Distribution の開始を行います。CI は Android APK と iOS のクラウド署名 Ad Hoc IPA を作り、Firebase にアップロードします。リリースノート末尾の `[baynex]` に branch、commit、run、必要に応じて version / theme / tasks を記録します。テスターグループと通知は Baynex が管理します。

所有者にお願いする操作は Google ログインと、Apple アカウントごとに一度のキー登録だけです。ほかのクラウド操作はキットが行います。

1. オペレーターが `gcloud auth login --no-launch-browser` で Google にログインする。コードは自分の端末に入力します。
2. Apple アカウントごとに一度、所有者が App Store Connect の Team Key（Admin、名前 `baynex-ci`）を作り、Secret Manager に `.p8`、Key ID、Issuer ID の 3 バージョンを登録する。値はチャットに貼りません。

生成された `flavor` と `target` の確認はアプリの既存コードと照合して行います。判断できない場合だけアプリチームに聞いてください。

## 新しいプロジェクト

Node.js 20 以上と `gcloud` を用意します。Firebase iOS / Android アプリが属する GCP プロジェクトで操作権限が必要です。アプリリポジトリのルートから、キットを隣のディレクトリに clone して実行します。

```sh
gcloud auth login --no-launch-browser
git clone --depth 1 --branch v1 https://github.com/koikenosalmon/baynex-agent-skills.git ../baynex-agent-skills
node ../baynex-agent-skills/app-distribution/add-apple-account.mjs --slug example
node ../baynex-agent-skills/app-distribution/bootstrap.mjs --project example-dev --repo example/app --apple-account example --app-dir native
```

`add-apple-account.mjs` は既存のアカウントなら省略できます。出力された Secret Manager の 3 リンクで、所有者が `.p8` をアップロードし、Key ID と Issuer ID を貼り付けます。`bootstrap.mjs` は secret の読み取り権限を CI サービスアカウントに付与します。作成内容を確認するには `--dry-run` を使えます。既存設定は再利用し、再実行できます。既に `apps.json` がある場合は、登録済みのアプリと表示名、flavor / target をそのまま残します。Firebase で見つかった新しいアプリは候補として表示するだけで、追加するときは `--include-new` を付けて再実行します。`--short` で pool とサービスアカウントの接頭辞、`--out` で JSON の出力先を変えられます。

生成された `distribution/apps.json` を開き、iOS / Android の組を確認してください。対応が一意でないプラットフォームは除外されます。各アプリの `flavor: "TODO"` と `target: "TODO"` を実際の Flutter flavor と Dart エントリポイントに直してください。`target` は `lib/main_example.dart` のように指定します。

次にテンプレートをアプリリポジトリへコピーします。

```sh
mkdir -p .github/workflows
cp ../baynex-agent-skills/app-distribution/templates/caller-app-distribution.yml .github/workflows/app-distribution.yml
cp ../baynex-agent-skills/app-distribution/templates/caller-app-distribution-check.yml .github/workflows/app-distribution-check.yml
```

両 caller は `permissions: contents: read, id-token: write` と `secrets: inherit` を含みます。`config-path` を変更した場合は `distribution/apps.json` の場所に合わせます。テンプレートの `@v1` と `kit-ref: v1` はキットのリリースブランチ `v1` を指します。キットの修正は `main` にマージしたあと `v1` を同じコミットまで進めると、全プロジェクトの次の実行に反映されます（`git push origin origin/main:v1`）。互換性のない変更は `v2` ブランチで出します。

`apps.json` と caller workflow 2 件をコミットしてから、確認 workflow を実行します。

```sh
gh workflow run app-distribution-check.yml --ref qa -f ensure_bundle_ids=true -f register_devices=false
```

Run log または Summary の表で WIF、Apple の 3 secret、Team ID、bundle ID、Firebase リリース、UDID を確認します。必要なら `register_devices=true` で端末を Apple に登録します。続いてアプリを `qa` に push し、Android / iOS のビルド、Firebase アップロード、Baynex リンクを確認します。`<appDir>/pubspec.yaml` がなければビルドは Summary に理由を表示してスキップします。`BAYNEX_PRODUCT_ID` 変数または `baynex/config.json` の `productId` があれば Baynex リンクが出ます。

CI に署名済み Android APK が必要な場合は、`ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD` を GitHub Actions Secrets に設定し、Gradle で `android/key.properties` を読むようにします。Apple 鍵は共有プロジェクト `baynex-shared` の Secret Manager から読み、CI の一時ファイルは 0600 で作成し終了時に消します。

## 別の組織から呼ぶとき

`secrets: inherit` は同じ組織（または Enterprise）内の呼び出しでしか secrets を渡しません。キットの所有者（`koikenosalmon`）と異なるアカウントや組織のリポジトリから呼ぶと、reusable workflow 側の `secrets.*` がすべて空になります。その場合は `caller-app-distribution-cross-owner.yml` と `caller-app-distribution-check-cross-owner.yml` をコピーしてください。各 secret を `NAME: ${{ secrets.NAME }}` で明示的に渡します。キットは使う secret を `on.workflow_call.secrets` に宣言しているため、同じ組織の caller は従来どおり `secrets: inherit` を使えます。キットに secret が増えたときは、別の組織の caller のマッピングにも追加します。

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

認証情報は Actions Secrets に登録します（caller の `secrets: inherit` で渡ります）。両方ある場合は SSH 鍵を使います。

| Secret | 内容 |
| --- | --- |
| `GIT_DEPENDENCY_SSH_KEY` | 依存リポジトリの Deploy key（パスフレーズなしの秘密鍵）。ssh-agent に読み込み、github.com は GitHub 公開のホスト鍵で検証します。 |
| `GIT_DEPENDENCY_TOKEN` | 依存リポジトリの Contents: Read を持つトークン（fine-grained PAT または GitHub App のトークン）。 |

Android / iOS の `flutter pub get` の前に設定し、同じジョブの `flutter build` でも有効です。書き換えは `privateGitDependencies` に列挙したリポジトリの `https://github.com/<owner>/<repo>` だけが対象で、`pubspec.yaml` と同じ表記で書いてください。git の設定は `$RUNNER_TEMP` の 0600 ファイルに置き、`GIT_CONFIG_COUNT` の環境変数で読み込むだけで、グローバルの git 設定は変更しません。ssh-agent、鍵、設定ファイルはジョブ終了時に必ず削除します。`privateGitDependencies` が空なら何もしません。値がどちらもない場合は Summary に設定のお願いを表示し、`flutter pub get` は従来どおり失敗します。`app-distribution-check.yml` の Summary で設定の有無（値は表示しません）を確認できます。

最小権限のために、Deploy key は依存リポジトリごとに作り、書き込み権限なし（read-only）にします。トークンを使う場合は fine-grained PAT で対象を依存リポジトリだけに絞り、Repository permissions は Contents: Read-only のみにして、有効期限を設定してください。Deploy key は 1 リポジトリに 1 つしか登録できません。複数の依存リポジトリがあるときはトークンが扱いやすいです。

## Flutter のバージョン固定

CI は既定で Flutter の `stable` 最新版を入れます。アプリが最新版に対応していない場合（例: Gradle の最低バージョンが上がったとき）は、`distribution/apps.json` の最上位に、チームが使っている Flutter のバージョンを `3.41.9` のような形式で指定します（任意）。

```json
{ "flutterVersion": "3.41.9" }
```

指定すると、Android / iOS の両ジョブがそのバージョンを `subosito/flutter-action` に渡します（`channel: stable` は維持）。未指定なら従来どおり `stable` の最新版です。`3.41` や `3.x` のような曖昧な指定は受け付けません。チームが Flutter をアップグレードしたときは、この値も更新してください。`bootstrap.mjs` を再実行しても値は保持されます。

## 問題があるとき

| 症状 | 対処 |
| --- | --- |
| Firebase リリース一覧が 404 | bootstrap と workflow が probe upload で自動開始します。失敗時は API と `roles/firebaseappdistro.admin` を確認します。 |
| GitHub WIF 認証に失敗 | IAM 反映に約 5 分かかることがあります。待って再実行し、repo 条件と `roles/iam.workloadIdentityUser` を確認します。 |
| Apple secret が空または読めない | 所有者に console で新しいバージョンを登録してもらい、`secretAccessor` を確認します。 |
| `Cloud billing quota exceeded` | GCP プロジェクト作成時の課金枠です。所有者に枠の解消を依頼し、勝手に別プロジェクトへ変更しません。 |
| `flavor` / `target` が `TODO` | アプリチームに実際の Flutter 設定を確認します。 |
| `flutter pub get` が `git clone ... exit 128` で失敗 | 非公開の Git 依存です。上の「非公開の Git 依存」を設定します。 |
| Baynex にリリースが出ない | Firebase リリースとリリースノート末尾の `[baynex]`、40 桁の commit を確認します。 |

終了後は `gcloud auth revoke` を実行します。トークンや Apple キーはリポジトリやチャットに置きません。キットの YAML は [actionlint](https://github.com/rhysd/actionlint) で検証できます: `actionlint .github/workflows/app-distribution*.yml app-distribution/templates/*.yml`。

CI が使うスクリプトは呼び出し元の `distribution/apps.json` を読みます。別の場所に置く場合は caller の `config-path` を変更します。ローカル実行では `DISTRIBUTION_CONFIG=path/to/apps.json`、または `app-store-connect.mjs` / `secret-manager.mjs` / `distribution-check.mjs` の `--config path/to/apps.json` を使えます。
