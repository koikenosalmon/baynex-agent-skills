import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePrivateGitDependencies } from './config.mjs';

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
