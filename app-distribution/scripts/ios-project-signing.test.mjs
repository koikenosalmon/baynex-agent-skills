import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('./ios-project-signing.rb', import.meta.url));
const source = await readFile(path, 'utf8');

test('ruby script parses', (t) => {
  const result = spawnSync('ruby', ['-c', path], { encoding: 'utf8' });
  if (result.error) return t.skip('ruby がありません');
  assert.equal(result.status, 0, result.stderr);
});

test('signs only through per-target settings, never automatic or command-line overrides', () => {
  assert.match(source, /CODE_SIGN_STYLE'\] = 'Manual'/);
  assert.match(source, /PROVISIONING_PROFILE_SPECIFIER'\] = name/);
  assert.match(source, /IDENTITY = 'Apple Distribution'/);
  assert.doesNotMatch(source, /Automatic|allowProvisioningUpdates/);
  assert.match(source, /application/);
  assert.match(source, /app-extension/);
});
