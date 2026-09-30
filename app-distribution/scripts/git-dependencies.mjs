#!/usr/bin/env node
// Lets `flutter pub get` / `flutter build` read the private GitHub repositories listed in
// apps.json `privateGitDependencies`. Credentials stay in $RUNNER_TEMP and are removed by `cleanup`.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readConfig, validatePrivateGitDependencies } from './config.mjs';

// Published at https://api.github.com/meta and
// https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
export const githubHostKeys = [
  { type: 'ssh-ed25519', key: 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl', fingerprint: 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU' },
  { type: 'ecdsa-sha2-nistp256', key: 'AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=', fingerprint: 'SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM' },
  { type: 'ssh-rsa', key: 'AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=', fingerprint: 'SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s' },
];

export const missingCredentialsMessage = '非公開 Git 依存が設定されていますが認証情報がありません。`GIT_DEPENDENCY_SSH_KEY` か `GIT_DEPENDENCY_TOKEN` を設定してください（`flutter pub get` は失敗する可能性があります）。';
const spawnTimeoutMs = 15_000;
const tokenPattern = /^[A-Za-z0-9_.-]{1,255}$/;

const quote = (value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function buildGitConfig({ repos, mode, token, knownHostsPath }) {
  const lines = [];
  if (mode === 'ssh') {
    if (/['\n\r]/.test(knownHostsPath)) throw new Error('RUNNER_TEMP のパスに使えない文字があります');
    const command = `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o GlobalKnownHostsFile=/dev/null -o UserKnownHostsFile='${knownHostsPath}'`;
    lines.push('[core]', `\tsshCommand = ${quote(command)}`);
  }
  for (const repo of repos) {
    if (mode === 'ssh') lines.push(`[url ${quote(`git@github.com:${repo}.git`)}]`, `\tinsteadOf = https://github.com/${repo}.git`, `\tinsteadOf = https://github.com/${repo}`);
    else lines.push(`[url ${quote(`https://x-access-token:${token}@github.com/${repo}`)}]`, `\tinsteadOf = https://github.com/${repo}`);
  }
  return `${lines.join('\n')}\n`;
}

export function knownHostsContent() {
  return `${githubHostKeys.map(({ type, key }) => `github.com ${type} ${key}`).join('\n')}\n`;
}

function appendLines(file, lines) {
  if (file) appendFileSync(file, `${lines.join('\n')}\n`);
}

export function setup({ config, env = process.env, spawn = spawnSync, print = console.log } = {}) {
  const repos = validatePrivateGitDependencies(config);
  if (!repos.length) return { mode: 'none' };
  const sshKey = (env.GIT_DEPENDENCY_SSH_KEY || '').replace(/\r\n?/g, '\n').trim();
  const token = (env.GIT_DEPENDENCY_TOKEN || '').trim();
  if (!sshKey && !token) {
    appendLines(env.GITHUB_STEP_SUMMARY, [`- ${missingCredentialsMessage}`]);
    print(`::warning::${missingCredentialsMessage}`);
    return { mode: 'missing' };
  }
  if (!env.RUNNER_TEMP) throw new Error('RUNNER_TEMP がありません');
  const directory = join(env.RUNNER_TEMP, 'git-dependency');
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { mode: 0o700 });
  const previous = { GIT_CONFIG_COUNT: env.GIT_CONFIG_COUNT, SSH_AUTH_SOCK: env.SSH_AUTH_SOCK, SSH_AGENT_PID: env.SSH_AGENT_PID };
  const state = { previous };
  const configPath = join(directory, 'gitconfig');
  const exports = [];
  try {
    let mode;
    if (sshKey) {
      mode = 'ssh';
      const knownHostsPath = join(directory, 'known_hosts');
      writeFileSync(knownHostsPath, knownHostsContent(), { mode: 0o600 });
      const started = spawn('ssh-agent', ['-s'], { encoding: 'utf8', timeout: spawnTimeoutMs });
      const socket = /SSH_AUTH_SOCK=([^;]+);/.exec(started.stdout || '')?.[1];
      const pid = /SSH_AGENT_PID=(\d+);/.exec(started.stdout || '')?.[1];
      if (started.status !== 0 || !socket || !pid) throw new Error('ssh-agent を起動できません');
      state.agent = { socket, pid };
      writeFileSync(join(directory, 'state.json'), JSON.stringify(state), { mode: 0o600 });
      const added = spawn('ssh-add', ['-'], { input: `${sshKey}\n`, encoding: 'utf8', timeout: spawnTimeoutMs, env: { ...env, SSH_AUTH_SOCK: socket } });
      if (added.status !== 0) throw new Error('GIT_DEPENDENCY_SSH_KEY を ssh-agent に追加できません（パスフレーズなしの OpenSSH 形式の秘密鍵が必要です）');
      writeFileSync(configPath, buildGitConfig({ repos, mode, knownHostsPath }), { mode: 0o600 });
      exports.push(`SSH_AUTH_SOCK=${socket}`, `SSH_AGENT_PID=${pid}`);
    } else {
      mode = 'token';
      if (!tokenPattern.test(token)) throw new Error('GIT_DEPENDENCY_TOKEN の形式が不正です');
      print(`::add-mask::${token}`);
      writeFileSync(configPath, buildGitConfig({ repos, mode, token }), { mode: 0o600 });
    }
    writeFileSync(join(directory, 'state.json'), JSON.stringify(state), { mode: 0o600 });
    const base = Number.parseInt(env.GIT_CONFIG_COUNT || '0', 10) || 0;
    // Never let git (pub get, gradle plugins, flutter tooling) stop to ask for a username or password.
    exports.push('GIT_TERMINAL_PROMPT=0', `GIT_CONFIG_COUNT=${base + 1}`, `GIT_CONFIG_KEY_${base}=include.path`, `GIT_CONFIG_VALUE_${base}=${configPath}`);
    appendLines(env.GITHUB_ENV, exports);
    appendLines(env.GITHUB_STEP_SUMMARY, [`- 非公開 Git 依存: ${mode === 'ssh' ? 'SSH 鍵（GIT_DEPENDENCY_SSH_KEY）' : 'トークン（GIT_DEPENDENCY_TOKEN）'}で ${repos.join(', ')} を取得します。`]);
    return { mode, repos };
  } catch (error) {
    cleanup({ env, spawn });
    throw error;
  }
}

export function cleanup({ env = process.env, spawn = spawnSync } = {}) {
  if (!env.RUNNER_TEMP) return { cleaned: false };
  const directory = join(env.RUNNER_TEMP, 'git-dependency');
  let state;
  try { state = JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')); } catch { state = null; }
  if (state?.agent) spawn('ssh-agent', ['-k'], { env: { ...env, SSH_AUTH_SOCK: state.agent.socket, SSH_AGENT_PID: state.agent.pid }, stdio: 'ignore', timeout: spawnTimeoutMs });
  rmSync(directory, { recursive: true, force: true });
  if (state) {
    appendLines(env.GITHUB_ENV, [`GIT_CONFIG_COUNT=${state.previous?.GIT_CONFIG_COUNT ?? '0'}`, `SSH_AUTH_SOCK=${state.previous?.SSH_AUTH_SOCK ?? ''}`, `SSH_AGENT_PID=${state.previous?.SSH_AGENT_PID ?? ''}`]);
  }
  return { cleaned: !!state };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, ...rest] = process.argv.slice(2);
    if (rest.length || !['setup', 'cleanup'].includes(command)) throw new Error('使い方: git-dependencies.mjs setup|cleanup');
    if (command === 'cleanup') cleanup();
    else setup({ config: await readConfig() });
  } catch (error) { console.error(`エラー: ${error.message}`); process.exitCode = 1; }
}
