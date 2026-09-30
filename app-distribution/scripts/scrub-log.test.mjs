import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, scrubText, secretValues } from './scrub-log.mjs';

test('named secrets and credential shapes are redacted', () => {
  const secrets = secretValues(['STORE_PASSWORD', 'SSH_KEY', 'UNSET'], { STORE_PASSWORD: 'hunter2-pass', SSH_KEY: 'line-one-secret\nline-two-secret', UNSET: undefined });
  const text = [
    'storePassword=hunter2-pass done',
    'key: line-two-secret',
    'git clone https://x-access-token:ghs_abcdefghijklmnopqrstuv@github.com/o/r',
    'Authorization: Bearer abc.def.ghi',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2ln',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----',
    'keyPassword: another',
    'plain line stays',
  ].join('\n');
  const scrubbed = scrubText(text, secrets);
  for (const leaked of ['hunter2-pass', 'line-two-secret', 'ghs_abcdefghijklmnopqrstuv', 'abc.def.ghi', 'eyJzdWIi', 'AAAA', 'another']) assert.ok(!scrubbed.includes(leaked), leaked);
  assert.ok(scrubbed.includes('plain line stays'));
});

test('short values are not treated as secrets so ordinary words survive', () => {
  assert.deepEqual(secretValues(['A'], { A: 'ab' }), []);
});

test('directories are scrubbed in place and symbolic links are left alone', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'scrub-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'logs', 'nested'), { recursive: true });
  writeFileSync(join(root, 'logs', 'a.log'), 'value=SECRETVALUE');
  writeFileSync(join(root, 'logs', 'nested', 'b.log'), 'again SECRETVALUE');
  writeFileSync(join(root, 'outside.txt'), 'SECRETVALUE');
  symlinkSync(join(root, 'outside.txt'), join(root, 'logs', 'link'));
  assert.equal(runCli(['--env', 'TOKEN', join(root, 'logs')], { TOKEN: 'SECRETVALUE' }), 2);
  assert.equal(readFileSync(join(root, 'logs', 'a.log'), 'utf8'), 'value=***');
  assert.equal(readFileSync(join(root, 'logs', 'nested', 'b.log'), 'utf8'), 'again ***');
  assert.equal(readFileSync(join(root, 'outside.txt'), 'utf8'), 'SECRETVALUE');
});

test('usage errors are explicit', () => {
  assert.throws(() => runCli([]), /使い方/);
  assert.throws(() => runCli(['--env']), /環境変数名/);
});
