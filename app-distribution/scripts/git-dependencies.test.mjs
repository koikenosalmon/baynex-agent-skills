import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGitConfig, cleanup, githubHostKeys, knownHostsContent, missingCredentialsMessage, setup } from './git-dependencies.mjs';

const config = { privateGitDependencies: ['OTERA-Co-Ltd/otera-packages'] };
const url = 'https://github.com/OTERA-Co-Ltd/otera-packages.git';

function sandbox(t, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'git-deps-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { RUNNER_TEMP: join(root, 'temp'), GITHUB_ENV: join(root, 'env'), GITHUB_STEP_SUMMARY: join(root, 'summary'), ...extra };
  spawnSync('mkdir', ['-p', env.RUNNER_TEMP]);
  for (const file of [env.GITHUB_ENV, env.GITHUB_STEP_SUMMARY]) writeFileSync(file, '');
  return { root, env, output: [], print(line) { this.output.push(line); } };
}
const exported = (env) => Object.fromEntries(readFileSync(env.GITHUB_ENV, 'utf8').trim().split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const resolveUrl = (env, target) => spawnSync('git', ['ls-remote', '--get-url', target], { env: { PATH: process.env.PATH, HOME: env.RUNNER_TEMP, GIT_CONFIG_NOSYSTEM: '1', ...exported(env) }, encoding: 'utf8' }).stdout.trim();

test('pinned GitHub host keys match the published fingerprints', () => {
  assert.deepEqual(githubHostKeys.map((entry) => entry.type), ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ssh-rsa']);
  for (const { key, fingerprint } of githubHostKeys) assert.equal(`SHA256:${createHash('sha256').update(Buffer.from(key, 'base64')).digest('base64').replace(/=+$/, '')}`, fingerprint);
  assert.equal(knownHostsContent().split('\n').filter(Boolean).length, 3);
});

test('nothing is configured without privateGitDependencies', (t) => {
  const box = sandbox(t, { GIT_DEPENDENCY_TOKEN: 'ghp_secret' });
  assert.deepEqual(setup({ config: {}, env: box.env, print: (line) => box.print(line) }), { mode: 'none' });
  assert.equal(readFileSync(box.env.GITHUB_ENV, 'utf8'), '');
  assert.equal(existsSync(join(box.env.RUNNER_TEMP, 'git-dependency')), false);
  assert.deepEqual(cleanup({ env: box.env }), { cleaned: false });
});

test('missing credentials are reported in Japanese in the job summary and never block', (t) => {
  const box = sandbox(t);
  assert.deepEqual(setup({ config, env: box.env, print: (line) => box.print(line) }), { mode: 'missing' });
  const summary = readFileSync(box.env.GITHUB_STEP_SUMMARY, 'utf8');
  assert.match(summary, /`GIT_DEPENDENCY_SSH_KEY` か `GIT_DEPENDENCY_TOKEN` を設定してください/);
  assert.ok(summary.includes(missingCredentialsMessage));
  assert.equal(readFileSync(box.env.GITHUB_ENV, 'utf8'), '');
});

test('token mode rewrites only the listed repository, masks the token and keeps files private', (t) => {
  const box = sandbox(t, { GIT_DEPENDENCY_TOKEN: 'github_pat_SECRET123\n' });
  assert.equal(setup({ config, env: box.env, print: (line) => box.print(line) }).mode, 'token');
  assert.deepEqual(box.output, ['::add-mask::github_pat_SECRET123']);
  const values = exported(box.env);
  assert.equal(values.GIT_CONFIG_COUNT, '1');
  assert.equal(values.GIT_CONFIG_KEY_0, 'include.path');
  assert.ok(!readFileSync(box.env.GITHUB_ENV, 'utf8').includes('SECRET123'));
  assert.ok(!readFileSync(box.env.GITHUB_STEP_SUMMARY, 'utf8').includes('SECRET123'));
  assert.equal(statSync(values.GIT_CONFIG_VALUE_0).mode & 0o777, 0o600);
  assert.equal(resolveUrl(box.env, url), 'https://x-access-token:github_pat_SECRET123@github.com/OTERA-Co-Ltd/otera-packages.git');
  assert.equal(resolveUrl(box.env, url.replace(/\.git$/, '')), 'https://x-access-token:github_pat_SECRET123@github.com/OTERA-Co-Ltd/otera-packages');
  assert.equal(resolveUrl(box.env, 'https://github.com/OTERA-Co-Ltd/other.git'), 'https://github.com/OTERA-Co-Ltd/other.git');
  assert.equal(resolveUrl(box.env, 'https://github.com/someone/otera-packages.git'), 'https://github.com/someone/otera-packages.git');
  cleanup({ env: box.env });
  assert.equal(existsSync(join(box.env.RUNNER_TEMP, 'git-dependency')), false);
  assert.equal(resolveUrl(box.env, url), url);
  assert.equal(exported(box.env).GIT_CONFIG_COUNT, '0');
});

test('token mode rejects malformed tokens without echoing them', (t) => {
  const box = sandbox(t, { GIT_DEPENDENCY_TOKEN: 'bad token@evil' });
  assert.throws(() => setup({ config, env: box.env, print: (line) => box.print(line) }), (error) => /GIT_DEPENDENCY_TOKEN/.test(error.message) && !error.message.includes('evil'));
  assert.equal(existsSync(join(box.env.RUNNER_TEMP, 'git-dependency')), false);
});

test('existing GIT_CONFIG entries are preserved and restored', (t) => {
  const box = sandbox(t, { GIT_DEPENDENCY_TOKEN: 'tok', GIT_CONFIG_COUNT: '2' });
  setup({ config, env: box.env, print: (line) => box.print(line) });
  const values = exported(box.env);
  assert.equal(values.GIT_CONFIG_COUNT, '3');
  assert.equal(values.GIT_CONFIG_KEY_2, 'include.path');
  cleanup({ env: box.env });
  assert.equal(exported(box.env).GIT_CONFIG_COUNT, '2');
});

test('ssh mode builds a pinned known_hosts config and prefers the key over the token', (t) => {
  const calls = [];
  const box = sandbox(t, { GIT_DEPENDENCY_SSH_KEY: '-----BEGIN OPENSSH PRIVATE KEY-----\r\nabc\r\n-----END OPENSSH PRIVATE KEY-----', GIT_DEPENDENCY_TOKEN: 'tok' });
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'ssh-agent' && args[0] === '-s') return { status: 0, stdout: 'SSH_AUTH_SOCK=/tmp/ssh-x/agent.1; export SSH_AUTH_SOCK;\nSSH_AGENT_PID=4242; export SSH_AGENT_PID;\necho Agent pid 4242;\n' };
    return { status: 0, stdout: '' };
  };
  assert.equal(setup({ config, env: box.env, spawn, print: (line) => box.print(line) }).mode, 'ssh');
  assert.deepEqual(box.output, []);
  const add = calls.find((call) => call.command === 'ssh-add');
  assert.deepEqual(add.args, ['-']);
  assert.equal(add.options.input, '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n');
  assert.equal(add.options.env.SSH_AUTH_SOCK, '/tmp/ssh-x/agent.1');
  const values = exported(box.env);
  assert.equal(values.SSH_AUTH_SOCK, '/tmp/ssh-x/agent.1');
  assert.equal(values.SSH_AGENT_PID, '4242');
  const directory = join(box.env.RUNNER_TEMP, 'git-dependency');
  assert.equal(readFileSync(join(directory, 'known_hosts'), 'utf8'), knownHostsContent());
  assert.ok(!readdirNames(directory).some((name) => /id_|key/.test(name)), 'the private key must never be written to disk');
  assert.ok(!readFileSync(values.GIT_CONFIG_VALUE_0, 'utf8').includes('tok'));
  assert.equal(resolveUrl(box.env, url), 'git@github.com:OTERA-Co-Ltd/otera-packages.git');
  assert.equal(resolveUrl(box.env, url.replace(/\.git$/, '')), 'git@github.com:OTERA-Co-Ltd/otera-packages.git');
  assert.equal(resolveUrl(box.env, 'https://github.com/OTERA-Co-Ltd/other.git'), 'https://github.com/OTERA-Co-Ltd/other.git');
  const gitConfig = readFileSync(values.GIT_CONFIG_VALUE_0, 'utf8');
  assert.match(gitConfig, /StrictHostKeyChecking=yes/);
  assert.match(gitConfig, /GlobalKnownHostsFile=\/dev\/null/);
  calls.length = 0;
  cleanup({ env: box.env, spawn });
  assert.deepEqual(calls.map((call) => [call.command, call.args, call.options.env.SSH_AGENT_PID]), [['ssh-agent', ['-k'], '4242']]);
  assert.equal(existsSync(directory), false);
});

test('a key that ssh-add rejects fails the step and tears the agent down', (t) => {
  const calls = [];
  const box = sandbox(t, { GIT_DEPENDENCY_SSH_KEY: 'not a key' });
  const spawn = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'ssh-agent' && args[0] === '-s') return { status: 0, stdout: 'SSH_AUTH_SOCK=/tmp/s; export SSH_AUTH_SOCK;\nSSH_AGENT_PID=7; export SSH_AGENT_PID;\n' };
    return { status: command === 'ssh-add' ? 1 : 0, stdout: '' };
  };
  assert.throws(() => setup({ config, env: box.env, spawn, print: (line) => box.print(line) }), /ssh-agent に追加できません/);
  assert.deepEqual(calls.at(-1), ['ssh-agent', '-k']);
  assert.equal(existsSync(join(box.env.RUNNER_TEMP, 'git-dependency')), false);
});

test('ssh mode works with a real ssh-agent and never leaves an agent or key behind', (t) => {
  const box = sandbox(t);
  const keyPath = join(box.root, 'id');
  if (spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath]).status !== 0 || spawnSync('ssh-agent', ['-h']).error) return t.skip('OpenSSH is not available');
  box.env.GIT_DEPENDENCY_SSH_KEY = readFileSync(keyPath, 'utf8').trimEnd();
  setup({ config, env: box.env, print: (line) => box.print(line) });
  const { SSH_AUTH_SOCK: socket, SSH_AGENT_PID: pid } = exported(box.env);
  const listed = spawnSync('ssh-add', ['-l'], { env: { ...process.env, SSH_AUTH_SOCK: socket }, encoding: 'utf8' });
  assert.equal(listed.status, 0);
  assert.match(listed.stdout, /ED25519/);
  cleanup({ env: { ...box.env, PATH: process.env.PATH } });
  assert.throws(() => process.kill(Number(pid), 0), { code: 'ESRCH' });
});

test('buildGitConfig escapes values written to the git config', () => {
  const text = buildGitConfig({ repos: ['o/r'], mode: 'ssh', knownHostsPath: '/tmp/a b/known_hosts' });
  assert.match(text, /UserKnownHostsFile='\/tmp\/a b\/known_hosts'/);
  assert.throws(() => buildGitConfig({ repos: ['o/r'], mode: 'ssh', knownHostsPath: "/tmp/it's" }), /RUNNER_TEMP/);
});

function readdirNames(directory) {
  return spawnSync('ls', ['-A', directory], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
}
