import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBuildNumberOffset, validateFlutterVersion, validatePrivateGitDependencies } from './config.mjs';

test('privateGitDependencies is optional and defaults to none', () => {
  assert.deepEqual(validatePrivateGitDependencies({}), []);
  assert.deepEqual(validatePrivateGitDependencies({ privateGitDependencies: [] }), []);
  assert.deepEqual(validatePrivateGitDependencies({ privateGitDependencies: ['OTERA-Co-Ltd/otera-packages', 'a_b/c.d'] }), ['OTERA-Co-Ltd/otera-packages', 'a_b/c.d']);
});

test('privateGitDependencies rejects anything but owner/repo strings', () => {
  const bad = ['owner/repo', {}, [1], [''], ['owner'], ['owner/repo/extra'], ['https://github.com/owner/repo'], ['owner/re po'], ['owner/repo\n[core]'], ['owner/repo"'], ['../repo'], ['owner/..'], ['owner/repo', 'OWNER/Repo'], Array.from({ length: 21 }, (_, index) => `owner/repo${index}`)];
  for (const value of bad) assert.throws(() => validatePrivateGitDependencies({ privateGitDependencies: value }), /privateGitDependencies/, JSON.stringify(value));
  assert.equal(validatePrivateGitDependencies({ privateGitDependencies: Array.from({ length: 20 }, (_, index) => `owner/repo${index}`) }).length, 20);
});

test('flutterVersion is optional and defaults to empty', () => {
  assert.equal(validateFlutterVersion({}), '');
  assert.equal(validateFlutterVersion({ flutterVersion: '3.41.9' }), '3.41.9');
  assert.equal(validateFlutterVersion({ flutterVersion: '3.41.0-0.1.pre' }), '3.41.0-0.1.pre');
});

test('flutterVersion rejects anything but an exact version string', () => {
  const bad = ['', '3.41', '3.x', 'stable', 'v3.41.9', ' 3.41.9', '3.41.9\n', '3.41.9; echo x', '3.41.9 $(id)', '3.41.9"', 341, null, {}, ['3.41.9'], `3.41.9-${'a'.repeat(64)}`];
  for (const value of bad) assert.throws(() => validateFlutterVersion({ flutterVersion: value }), /flutterVersion/, JSON.stringify(value));
});

test('buildNumberOffset is optional, defaults to 0 and accepts only non-negative integers', () => {
  assert.equal(validateBuildNumberOffset({}), 0);
  assert.equal(validateBuildNumberOffset({ buildNumberOffset: 0 }), 0);
  assert.equal(validateBuildNumberOffset({ buildNumberOffset: 250 }), 250);
  for (const value of [-1, 1.5, '10', null, NaN, Infinity, {}, [1], 1_000_000_001]) assert.throws(() => validateBuildNumberOffset({ buildNumberOffset: value }), /buildNumberOffset/, String(value));
});
