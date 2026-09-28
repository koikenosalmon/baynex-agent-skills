# Baynex Agent Skills

Baynex仕様書、実装タスク、HTML UI定義をAIエージェントから安全に扱うための、ポータブルな[Agent Skills](https://agentskills.io/)とMCPアダプターです。

Skillのソースコードは公開されていますが、Baynexの仕様書データは公開されません。実データへのアクセスと更新は、Cloudflare AccessとBaynex MCPの認証・権限によって制御されます。

## Skills

必要なSkillだけをimportできます。

| Skill | 用途 | 書き込み |
| --- | --- | --- |
| `baynex-read-specifications` | 仕様、構造、カタログ、保証、タスク、関連UIの参照 | なし |
| `baynex-update-specifications` | Slack監査付きの仕様・構造・カタログ・保証・タスク更新 | あり |
| `baynex-manage-ui-definitions` | 画面、状態、HTML、仕様リンクの参照・更新 | あり |
| `baynex-app-distribution-setup` | アプリリポジトリの Baynex「アプリ配布」設定と確認 | GCP / GitHub 設定 |

## Import

リポジトリを取得し、利用するSkillディレクトリだけをクライアントのSkill探索場所へコピーまたは同期してください。

```sh
git clone --depth 1 https://github.com/koikenosalmon/baynex-agent-skills.git
mkdir -p .agents/skills
cp -R baynex-agent-skills/skills/baynex-read-specifications .agents/skills/
```

書き込みが必要なプロジェクトだけ、追加のSkillをimportします。

```sh
cp -R baynex-agent-skills/skills/baynex-update-specifications .agents/skills/
cp -R baynex-agent-skills/skills/baynex-manage-ui-definitions .agents/skills/
cp -R baynex-agent-skills/skills/baynex-app-distribution-setup .agents/skills/
```

`.agents/skills` を探索しないクライアントでは、そのクライアント固有のSkillディレクトリへ同じフォルダを配置してください。Claude Codeでは `.claude/skills` が一般的です。Skill機構を持たないエージェントでは、選択した `SKILL.md` をプロジェクト指示としてimportし、相対参照される `references/` も一緒に渡します。

リリースタグをcheckoutして固定すると、プロジェクト間で同じ手順を再現できます。

## MCP connection

Node.js 20以上を用意し、認証情報をクライアントのsecret managerまたは起動環境へ設定します。値をリポジトリやMCP設定ファイルへ直接書かないでください。

```sh
export BAYNEX_MCP_ACCESS_CLIENT_ID='...'
export BAYNEX_MCP_ACCESS_CLIENT_SECRET='...'
export BAYNEX_MCP_TOKEN='...'
```

stdio MCPに対応するクライアントでは、次の設定をクライアント固有のMCP設定へimportします。`args` はclone先の絶対パスへ変更してください。

```json
{
  "mcpServers": {
    "baynex-specifications": {
      "command": "node",
      "args": ["/absolute/path/baynex-agent-skills/scripts/baynex-mcp-stdio.mjs"]
    }
  }
}
```

接続確認:

```sh
node scripts/baynex-mcp-stdio.mjs --verify
```

リポジトリルートはCodex pluginとしても利用できます。`.codex-plugin/plugin.json` と `.mcp.json` がSkillと同じstdioアダプターを登録します。

## App Distribution kit

別の Flutter アプリを Baynex「アプリ配布」に接続する手順と再利用可能な GitHub Actions workflow は [app-distribution/README.md](app-distribution/README.md) にあります。

## Mutation policy

- 管理対象の仕様書やUI定義は、認可されたBaynex MCP writerだけで更新します。
- ブラウザ編集、汎用REST、D1、プロバイダーコンソールをwrite fallbackにしません。
- Slack監査元の準備に失敗した場合は、管理成果物へ一切書き込みません。
- 更新後は同じMCP接続からcanonical readbackを行います。
- UIの状態は別画面へ複製せず、同一screenの`states[]`として管理します。

## Development

```sh
npm run check
npm test
```

License: MIT
