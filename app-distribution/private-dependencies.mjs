// Detects private GitHub `git:` dependencies in <appDir>/pubspec.yaml and prepares their credential:
// a read-only deploy key stored as the app repo secret GIT_DEPENDENCY_SSH_KEY. Key material is generated in a
// temporary directory, handed to `gh` and removed; it is never printed.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { report } from './cloud.mjs';

export const sshSecretName = 'GIT_DEPENDENCY_SSH_KEY';
export const tokenSecretName = 'GIT_DEPENDENCY_TOKEN';

export function defaultRun(command, args, { input } = {}) {
  const result = spawnSync(command, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 });
  return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || (result.error ? result.error.message : '') };
}

const lastLine = (text) => String(text).trim().split('\n').at(-1).slice(0, 200);
const githubUrl = /^(?:url:|git:)\s*['"]?(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?['"]?\s*(?:#.*)?$/;

export function githubGitDependencies(pubspec) {
  const repos = [];
  for (const line of String(pubspec).split(/\r?\n/)) {
    const match = line.trim().match(githubUrl);
    if (match && ![match[1], match[2]].some((part) => part === '.' || part === '..')) repos.push(`${match[1]}/${match[2]}`);
  }
  return [...new Map(repos.map((repo) => [repo.toLowerCase(), repo])).values()];
}

export function tokenGuidance(repo) {
  return `GIT_DEPENDENCY_TOKEN を使ってください。fine-grained PAT を作り（対象は依存リポジトリのみ、Repository permissions は Contents: Read-only、有効期限あり）、\`gh secret set ${tokenSecretName} --repo ${repo}\` で登録します。`;
}

export async function detectPrivateDependencies({ appRepo, appDir, run = defaultRun, readPubspec = (path) => readFileSync(path, 'utf8') }) {
  let pubspec;
  try { pubspec = readPubspec(join(appDir, 'pubspec.yaml')); } catch { return { repos: [] }; }
  const repos = [];
  for (const dependency of githubGitDependencies(pubspec)) {
    if (dependency.toLowerCase() === String(appRepo).toLowerCase()) continue;
    const result = run('gh', ['api', `repos/${dependency}`, '--jq', '.private']);
    if (result.status !== 0) report('⚠️', `${dependency}: 公開か非公開かを確認できません（gh の権限を確認してください）。非公開なら privateGitDependencies に手動で追加します`);
    else if (result.stdout.trim() === 'true') { repos.push(dependency); report('✅', `${dependency}: 非公開の Git 依存を検出`); }
    else report('✅', `${dependency}: 公開リポジトリのため対象外`);
  }
  return { repos };
}

export function mergeDependencies(existing = [], detected = []) {
  const merged = [...existing];
  for (const repo of detected) if (!merged.some((item) => item.toLowerCase() === repo.toLowerCase())) merged.push(repo);
  return merged;
}

// Returns one of: none, exists, dry-run, multiple, created, disabled, failed.
export function provisionDependencyCredential({ appRepo, repos, dryRun = false, run = defaultRun, makeTempDir = () => mkdtempSync(join(tmpdir(), 'baynex-deploy-key-')) }) {
  if (!repos.length) return 'none';
  const secrets = run('gh', ['secret', 'list', '--repo', appRepo, '--json', 'name', '--jq', '.[].name']);
  if (secrets.status !== 0) { report('⚠️', `${appRepo}: secrets を確認できません。gh の権限を確認し、${sshSecretName} か ${tokenSecretName} を手動で設定してください`); return 'failed'; }
  const names = secrets.stdout.split(/\s+/);
  if (names.includes(sshSecretName) || names.includes(tokenSecretName)) { report('✅', `${appRepo}: 非公開 Git 依存の認証情報は設定済み`); return 'exists'; }
  if (repos.length > 1) { report('⚠️', `非公開 Git 依存が ${repos.length} 件あります。Deploy key は 1 件しか使えないため ${tokenGuidance(appRepo)}`); return 'multiple'; }
  const dependency = repos[0];
  if (dryRun) { report('⚠️', `${dependency}: 読み取り専用 Deploy key を作成し ${appRepo} の ${sshSecretName} に設定予定`); return 'dry-run'; }
  const directory = makeTempDir();
  try {
    const key = join(directory, 'key');
    const generated = run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', `baynex-ci ${appRepo}`, '-f', key, '-q']);
    if (generated.status !== 0) { report('❌', `ssh-keygen に失敗しました: ${lastLine(generated.stderr)}`); return 'failed'; }
    // gh adds deploy keys read-only unless --allow-write is given.
    const added = run('gh', ['repo', 'deploy-key', 'add', `${key}.pub`, '--repo', dependency, '--title', `baynex-ci ${appRepo}`]);
    if (added.status !== 0) {
      if (/deploy keys are disabled/i.test(`${added.stderr}${added.stdout}`)) { report('⚠️', `${dependency}: 組織の設定で Deploy key が無効です（HTTP 422）。${tokenGuidance(appRepo)}`); return 'disabled'; }
      report('❌', `${dependency}: Deploy key を追加できません（依存リポジトリの管理者権限が必要です）: ${lastLine(added.stderr)}`);
      return 'failed';
    }
    const stored = run('gh', ['secret', 'set', sshSecretName, '--repo', appRepo], { input: readFileSync(key, 'utf8') });
    if (stored.status !== 0) { report('❌', `${appRepo}: ${sshSecretName} を設定できません。${dependency} に追加した Deploy key（タイトル: baynex-ci ${appRepo}）を確認してください: ${lastLine(stored.stderr)}`); return 'failed'; }
    report('✅', `${dependency}: 読み取り専用 Deploy key を作成し、${appRepo} の ${sshSecretName} に設定しました`);
    return 'created';
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
