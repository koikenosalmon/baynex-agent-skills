// mamomiru の Android ビルドが 35 分以上止まり、手動キャンセルまでログも残らなかった。
// 二度と「無言で止まる」状態に戻らないよう、workflow 側の防御を固定する。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflow = await readFile(join(root, '.github/workflows/app-distribution.yml'), 'utf8');
const lines = workflow.split('\n');

// The text of the step whose "name:" line contains `name`, up to the next step.
function step(name) {
  const start = lines.findIndex((line) => /^\s+(?:- )?name:/.test(line) && line.includes(name));
  assert.ok(start >= 0, `step not found: ${name}`);
  let from = start;
  while (!lines[from].startsWith('      - ')) from--;
  let to = start + 1;
  while (to < lines.length && !lines[to].startsWith('      - ') && !/^  \w/.test(lines[to])) to++;
  return lines.slice(from, to).join('\n');
}
const minutes = (text) => Number(/timeout-minutes: (\d+)/.exec(text)?.[1]);

test('Build APK is bounded and cannot stop to ask a question', () => {
  const build = step('Build APK');
  assert.ok(minutes(build) > 0 && minutes(build) <= 30, 'timeout-minutes');
  assert.match(build, /GIT_TERMINAL_PROMPT: '0'/);
  assert.match(build, /set -euo pipefail/);
  assert.match(build, /flutter build apk --verbose .*\| tee "\$log_dir\/flutter-build\.log"/);
  assert.match(build, /artifact=\$PWD\/\$artifact/, 'the artifact output contract');
  assert.match(build, /android-gradle-setup\.sh/);
  assert.match(build, /build-diagnostics\.sh" sample "\$log_dir" 60 &/);
});

test('Gradle memory is bounded, lint-vital skipped, swap best effort, memory sampled to stdout', async () => {
  const setup = await readFile(join(root, 'app-distribution/scripts/android-gradle-setup.sh'), 'utf8');
  for (const property of ['org.gradle.vfs.watch=false', 'org.gradle.daemon=false', 'org.gradle.parallel=false', 'org.gradle.workers.max=2', 'kotlin.daemon.jvmargs=-Xmx2g']) assert.ok(setup.includes(property), property);
  assert.match(setup, /org\.gradle\.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1g/);
  assert.ok(setup.includes("startsWith('lintVital') }.configureEach { enabled = false }"));
  assert.match(setup, /sudo -n fallocate/);
  const diagnostics = await readFile(join(root, 'app-distribution/scripts/build-diagnostics.sh'), 'utf8');
  assert.match(diagnostics, /free -m[\s\S]*tee -a "\$directory\/memory-samples\.log"/);
});

test('logs of a failed or cancelled Android build are scrubbed and uploaded', () => {
  const collect = step('Collect Android build logs');
  assert.match(collect, /if: failure\(\) \|\| cancelled\(\)/);
  assert.match(collect, /scrub-log\.mjs/);
  for (const name of ['STORE_PASSWORD', 'KEY_PASSWORD', 'GIT_DEPENDENCY_TOKEN', 'GIT_DEPENDENCY_SSH_KEY']) assert.match(collect, new RegExp(`--env ${name}\\b`));
  const upload = step('Upload Android build logs');
  assert.match(upload, /if: failure\(\) \|\| cancelled\(\)/);
  assert.match(upload, /name: android-build-logs/);
  assert.ok(workflow.indexOf('Collect Android build logs') < workflow.indexOf('Upload Android build logs'), 'scrub before upload');
});

test('every iOS build step and both jobs have a timeout', () => {
  for (const name of ['Load Apple account key', 'Install dependencies', 'Register bundle ID and tester devices', 'Build cloud-signed IPA']) {
    assert.ok(minutes(step(name)) > 0, `${name} has no timeout-minutes`);
  }
  assert.ok(minutes(step('Build cloud-signed IPA')) <= 45);
  assert.match(step('Build cloud-signed IPA'), /GIT_TERMINAL_PROMPT: '0'/);
  assert.match(workflow, /runs-on: ubuntu-latest\n    timeout-minutes: \d+/);
  assert.match(workflow, /runs-on: macos-latest\n    timeout-minutes: \d+/);
});
