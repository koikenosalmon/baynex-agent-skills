import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeBuildNumber } from './build-number.mjs';

test('build number is run_number plus the optional offset', () => {
  assert.equal(computeBuildNumber({}, '42'), 42);
  assert.equal(computeBuildNumber({ buildNumberOffset: 0 }, '42'), 42);
  assert.equal(computeBuildNumber({ buildNumberOffset: 1000 }, '42'), 1042);
});

test('build number rejects a bad run number, a bad offset and Android overflow', () => {
  for (const run of [undefined, '', '0', '-1', '1.5', 'abc', '42; echo x']) assert.throws(() => computeBuildNumber({}, run), /RUN_NUMBER/, String(run));
  assert.throws(() => computeBuildNumber({ buildNumberOffset: -5 }, '1'), /buildNumberOffset/);
  assert.throws(() => computeBuildNumber({ buildNumberOffset: 1_000_000_000 }, '2000000000'), /上限/);
});

test('the CLI prints only the number and reads --config', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'build-number-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, 'apps.json');
  await writeFile(config, JSON.stringify({ buildNumberOffset: 7 }));
  const script = new URL('./build-number.mjs', import.meta.url).pathname;
  assert.equal(execFileSync('node', [script, '--config', config], { env: { ...process.env, RUN_NUMBER: '3' }, encoding: 'utf8' }), '10\n');
});
