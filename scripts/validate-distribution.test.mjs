import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
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
