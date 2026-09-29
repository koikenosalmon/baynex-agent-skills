import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateKitLayout } from './validate-distribution.mjs';

test('kit validator rejects a missing caller workflow template', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kit-layout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(new URL('../app-distribution/', import.meta.url), join(directory, 'kit'), { recursive: true });
  await cp(new URL('../.github/workflows/', import.meta.url), join(directory, 'workflows'), { recursive: true });
  await rm(join(directory, 'kit/templates/caller-app-distribution-check.yml'));
  await assert.rejects(() => validateKitLayout(pathToFileURL(`${directory}/kit/`), pathToFileURL(`${directory}/workflows/`)), { code: 'ENOENT' });
});

test('kit validator rejects a workflow that puts app config into the matrix or detect outputs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kit-matrix-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(new URL('../app-distribution/', import.meta.url), join(directory, 'kit'), { recursive: true });
  await cp(new URL('../.github/workflows/', import.meta.url), join(directory, 'workflows'), { recursive: true });
  const kit = pathToFileURL(`${directory}/kit/`), workflows = pathToFileURL(`${directory}/workflows/`);
  await validateKitLayout(kit, workflows);
  const file = join(directory, 'workflows/app-distribution.yml');
  const original = await readFile(file, 'utf8');
  const broken = {
    'a matrix.app reference': original.replace('name: Android / app ${{ matrix.index }}', 'name: Android / ${{ matrix.app.displayName }}'),
    'a config value in detect outputs': original.replace('      app_present:', '      app_dir: ${{ steps.config.outputs.app_dir }}\n      app_present:'),
    'a config value read from outputs': original.replace('working-directory: ${{ env.APP_DIR }}', 'working-directory: ${{ needs.detect.outputs.app_dir }}'),
    'the run number as build number': original.replace('--build-number="$build_number"', '--build-number="$RUN_NUMBER"'),
  };
  for (const [label, content] of Object.entries(broken)) {
    assert.notEqual(content, original, label);
    await writeFile(file, content);
    await assert.rejects(() => validateKitLayout(kit, workflows), /app-distribution\.yml/, label);
  }
});
