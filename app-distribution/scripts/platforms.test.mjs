import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { automaticPlatforms, runCli, selectPlatforms } from './platforms.mjs';

test('automatic runs build iOS only by default; Android waits for a manual dispatch', () => {
  assert.deepEqual(selectPlatforms({ eventName: 'push' }), { ios: true, android: false, trigger: 'automatic' });
  assert.deepEqual(selectPlatforms({ eventName: 'schedule' }), { ios: true, android: false, trigger: 'automatic' });
  assert.deepEqual(selectPlatforms({ eventName: 'schedule', requested: 'both', automatic: ['ios'] }), { ios: true, android: false, trigger: 'automatic' }, 'a schedule ignores the dispatch input');
  assert.deepEqual(selectPlatforms({ eventName: 'schedule', automatic: ['ios', 'android'] }), { ios: true, android: true, trigger: 'automatic' }, 'a schedule follows Baynex automatic platforms');
  assert.deepEqual(selectPlatforms({ eventName: 'push', requested: 'android' }), { ios: true, android: false, trigger: 'automatic' }, 'a push ignores the dispatch input');
});

test('a manual dispatch builds the chosen platform; without the input (older caller) it builds both', () => {
  assert.deepEqual(selectPlatforms({ eventName: 'workflow_dispatch', requested: 'android' }), { ios: false, android: true, trigger: 'manual' });
  assert.deepEqual(selectPlatforms({ eventName: 'workflow_dispatch', requested: 'ios' }), { ios: true, android: false, trigger: 'manual' });
  assert.deepEqual(selectPlatforms({ eventName: 'workflow_dispatch', requested: 'both' }), { ios: true, android: true, trigger: 'manual' });
  assert.deepEqual(selectPlatforms({ eventName: 'workflow_dispatch', requested: '' }), { ios: true, android: true, trigger: 'manual' });
  assert.throws(() => selectPlatforms({ eventName: 'workflow_dispatch', requested: 'web' }), /ios \/ android \/ both/);
});

test('Baynex automatic platforms are honoured; unknown or empty values fall back to iOS', () => {
  assert.deepEqual(automaticPlatforms({ baynex: { platforms: { automatic: ['ios'], manual: ['android'] } } }), ['ios']);
  assert.deepEqual(automaticPlatforms({ baynex: { platforms: { automatic: ['android', 'ios'] } } }), ['ios', 'android']);
  assert.deepEqual(automaticPlatforms({ baynex: { platforms: { automatic: [] } } }), ['ios']);
  assert.deepEqual(automaticPlatforms({ baynex: { platforms: { automatic: ['web'] } } }), ['ios']);
  assert.deepEqual(automaticPlatforms({}), ['ios']);
  assert.deepEqual(automaticPlatforms(undefined), ['ios']);
});

test('the CLI writes build_ios / build_android outputs and a summary line', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'kit-platforms-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, 'effective-apps.json');
  await writeFile(config, JSON.stringify({ apps: [], baynex: { platforms: { automatic: ['ios'], manual: ['android'] } } }));
  const output = join(dir, 'output');
  const summary = join(dir, 'summary');
  await writeFile(output, '');
  await writeFile(summary, '');
  await runCli({ DISTRIBUTION_CONFIG: config, GITHUB_EVENT_NAME: 'push', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary });
  assert.equal(await readFile(output, 'utf8'), 'build_ios=true\nbuild_android=false\n');
  assert.match(await readFile(summary, 'utf8'), /自動）: iOS（Android は手動実行/);
  await writeFile(output, '');
  await runCli({ DISTRIBUTION_CONFIG: config, GITHUB_EVENT_NAME: 'workflow_dispatch', PLATFORM_INPUT: 'android', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary });
  assert.equal(await readFile(output, 'utf8'), 'build_ios=false\nbuild_android=true\n');
});
