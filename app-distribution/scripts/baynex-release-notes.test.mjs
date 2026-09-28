import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const script = resolve('app-distribution/scripts/baynex-release-notes.sh');
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'distribution-notes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const bare = join(root, 'remote.git');
  git(root, 'init', '--bare', bare);
  git(root, 'init', '-b', 'qa', repo);
  git(repo, 'config', 'user.name', 'CI Test');
  git(repo, 'config', 'user.email', 'ci@example.test');
  git(repo, 'remote', 'add', 'origin', bare);
  commit(repo, 'Initial app');
  git(repo, 'push', '-u', 'origin', 'qa');
  return repo;
}
function commit(repo, subject, body) {
  git(repo, 'commit', '--allow-empty', '-m', subject, ...(body ? ['-m', body] : []));
}
function notes(repo, branch = git(repo, 'branch', '--show-current'), extra = {}) {
  return execFileSync('bash', [script], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REF_NAME: branch, GITHUB_SHA: git(repo, 'rev-parse', 'HEAD'),
      GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'example/app',
      GITHUB_RUN_ID: '42', ...extra },
  });
}
function tail(repo, branch, extra) {
  return notes(repo, branch, extra).split('[baynex]\n')[1];
}

test('qa emits exact tester changes and metadata', (t) => {
  const repo = fixture(t);
  commit(repo, 'Fix login');
  assert.equal(notes(repo), `最近の変更:\n- Fix login\n- Initial app\n\n[baynex]\nbranch: qa\ncommit: ${git(repo, 'rev-parse', 'HEAD')}\nrun: https://github.com/example/app/actions/runs/42\n`);
});

test('feature branch extracts Implement task ID', (t) => {
  const repo = fixture(t);
  git(repo, 'switch', '-c', 'ai/feature-x');
  commit(repo, 'Implement task_123');
  assert.equal(notes(repo), `最近の変更:\n- Implement task_123\n- Initial app\n\n[baynex]\nbranch: ai/feature-x\ncommit: ${git(repo, 'rev-parse', 'HEAD')}\nrun: https://github.com/example/app/actions/runs/42\ntasks: task_123\n`);
});

test('release tracks merged, advanced, deleted, and squash themes', (t) => {
  const repo = fixture(t);
  const base = git(repo, 'rev-parse', 'HEAD');
  for (const name of ['ai/feature-contained', 'feature/advanced', 'epic/deleted', 'ai/feature-squashed']) {
    git(repo, 'switch', '-c', name, base);
    commit(repo, `Work on ${name}`);
    git(repo, 'push', '-u', 'origin', name);
  }
  git(repo, 'switch', '-c', 'release/1.2.0', base);
  git(repo, 'merge', '--no-ff', '-m', 'Merge pull request #12 from org/ai/feature-contained', 'ai/feature-contained');
  git(repo, 'merge', '--no-ff', '-m', "Merge branch 'feature/advanced'", 'feature/advanced');
  git(repo, 'merge', '--no-ff', '-m', "Merge branch 'epic/deleted'", 'epic/deleted');
  git(repo, 'merge', '--squash', 'ai/feature-squashed');
  commit(repo, 'Squash theme', 'Baynex-Theme: ai/feature-squashed');
  git(repo, 'push', 'origin', '--delete', 'epic/deleted', 'ai/feature-squashed');
  git(repo, 'switch', 'feature/advanced');
  commit(repo, 'New work after merge');
  git(repo, 'push', 'origin', 'feature/advanced');
  git(repo, 'switch', 'release/1.2.0');
  assert.equal(tail(repo, 'release/1.2.0'), `branch: release/1.2.0\ncommit: ${git(repo, 'rev-parse', 'HEAD')}\nrun: https://github.com/example/app/actions/runs/42\nversion: 1.2.0\nmerged: ai/feature-contained,ai/feature-squashed,epic/deleted\nchanged-after-merge: feature/advanced\n`);
});

test('values are bounded and cannot add metadata lines', (t) => {
  const repo = fixture(t);
  commit(repo, 'X'.repeat(300));
  const text = notes(repo, `qa\nversion: injected${'x'.repeat(220)}`, {
    GITHUB_SERVER_URL: 'https://malicious.example', GITHUB_RUN_ID: '42\nversion: injected',
  });
  assert.match(text, /^最近の変更:\n- X{160}\n- Initial app\n\n\[baynex\]\n/m);
  const block = text.split('[baynex]\n')[1];
  assert.equal(block, `branch: ${`qa version: injected${'x'.repeat(220)}`.slice(0, 200)}\ncommit: ${git(repo, 'rev-parse', 'HEAD')}\n`);
  assert.ok(Buffer.byteLength(text) < 2000);
});

test('squash trailer with a Baynex ID emits theme metadata', (t) => {
  const repo = fixture(t);
  git(repo, 'switch', '-c', 'release/2.0.0');
  commit(repo, 'Squashed theme', 'Baynex-Theme: theme_456');
  assert.equal(tail(repo), `branch: release/2.0.0\ncommit: ${git(repo, 'rev-parse', 'HEAD')}\nrun: https://github.com/example/app/actions/runs/42\nversion: 2.0.0\ntheme: theme_456\n`);
});

test('shallow clone still emits valid available history', (t) => {
  const repo = fixture(t);
  commit(repo, 'Latest change');
  git(repo, 'push', 'origin', 'qa');
  const shallow = join(repo, '..', 'shallow');
  git(repo, 'clone', '--depth=1', `file://${join(repo, '..', 'remote.git')}`, '-b', 'qa', shallow);
  assert.equal(notes(shallow), `最近の変更:\n- Latest change\n\n[baynex]\nbranch: qa\ncommit: ${git(shallow, 'rev-parse', 'HEAD')}\nrun: https://github.com/example/app/actions/runs/42\n`);
});
