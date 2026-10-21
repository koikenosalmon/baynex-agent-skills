import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const workflow = await readFile(new URL('../../.github/workflows/app-distribution.yml', import.meta.url), 'utf8');
const start = workflow.indexOf('          case "$IOS_APNS_ENVIRONMENT" in');
const end = workflow.indexOf('          args=(--release', start);
assert.ok(start > 0 && end > start);
const branch = workflow.slice(start, end).replace(/^          /gm, '');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'development signing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'scripts/build.sh'), 'echo "artifact=development.ipa" > "$GITHUB_OUTPUT"\n');
  return root;
}

function execute(root, environment, script = 'scripts/build.sh') {
  return spawnSync('bash', ['-c', `set -euo pipefail\n${branch}\necho production-path`], {
    encoding: 'utf8', env: { ...process.env, GITHUB_WORKSPACE: root,
      GITHUB_OUTPUT: join(root, 'output'), IOS_APNS_ENVIRONMENT: environment,
      IOS_DEVELOPMENT_BUILD_SCRIPT: script },
  });
}

test('explicit development runs the repo builder and cannot enter the Ad Hoc path', async (t) => {
  const root = await fixture(t);
  const result = execute(root, 'development');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /production-path/);
  assert.equal(await readFile(join(root, 'output'), 'utf8'), 'artifact=development.ipa\n');
});

test('development build failure propagates without a distribution fallback', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'scripts/build.sh'), 'exit 17\n');
  const result = execute(root, 'development');
  assert.equal(result.status, 17);
  assert.doesNotMatch(result.stdout, /production-path/);
});

test('missing, escaping and external-symlink builders fail closed', async (t) => {
  const root = await fixture(t);
  await symlink('/bin/true', join(root, 'scripts/outside.sh'));
  for (const script of ['', '../outside.sh', 'scripts/missing.sh', 'scripts/outside.sh']) {
    const result = execute(root, 'development', script);
    assert.notEqual(result.status, 0, script);
    assert.doesNotMatch(result.stdout, /production-path/);
  }
});

test('unknown environments are rejected and existing production callers keep their path', async (t) => {
  const root = await fixture(t);
  assert.notEqual(execute(root, 'Development').status, 0);
  const result = execute(root, 'production');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /production-path/);
  assert.match(workflow, /ios-apns-environment:\n\s+type: string\n\s+default: production/);
});
