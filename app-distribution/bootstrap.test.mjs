import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { bootstrap, pairApps, PairingError, parsePairSpecs } from './bootstrap.mjs';
import { detectPrivateDependencies, githubGitDependencies, provisionDependencyCredential } from './private-dependencies.mjs';

const ios = [
  { appId: '1:000000000000:ios:abc', displayName: 'Example Coach iOS dev', bundleId: 'com.example.coach' },
  { appId: '1:000000000000:ios:def', displayName: 'Unpaired iOS', bundleId: 'com.example.unpaired' },
];
const android = [
  { appId: '1:000000000000:android:abc', displayName: 'Example Coach Android dev', packageName: 'com.example.shell.coach' },
  { appId: '1:000000000000:android:def', displayName: 'Other Android', packageName: 'com.example.other' },
];

test('pairs only unique iOS and Android apps and preserves confirmed build settings', async () => {
  const old = [{ id: 'coach', iosBundleId: 'com.example.coach', flavor: 'coach', target: 'lib/main_coach.dart', appleAccount: 'old' }];
  // The unmatched iOS/Android leftovers used to be dropped silently; now they must be decided.
  await assert.rejects(() => pairApps(ios, android, old, 'example', { interactive: false }), PairingError);
  const pairs = await pairApps(ios, android, old, 'example', { interactive: true, ask: async () => 's' });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].flavor, 'coach');
  assert.equal(pairs[0].target, 'lib/main_coach.dart');
  assert.equal(pairs[0].appleAccount, 'old');
  assert.deepEqual(pairs[0].firebaseAppIds, { ios: ios[0].appId, android: android[0].appId });
});

test('rerun keeps the confirmed app list and display names unless new apps are requested', async () => {
  const extraIos = { appId: '1:000000000000:ios:ghi', displayName: 'Legacy iOS', bundleId: 'com.example.legacy' };
  const extraAndroid = { appId: '1:000000000000:android:ghi', displayName: 'Legacy Android', packageName: 'com.example.legacy' };
  const old = [{ id: 'coach', displayName: 'Example Coach', iosBundleId: 'com.example.coach', flavor: 'coach', target: 'lib/main_coach.dart', appleAccount: 'example' }];
  const original = console.log;
  console.log = () => {};
  try {
    const kept = await pairApps([ios[0], extraIos], [android[0], extraAndroid], old, 'example', { includeNew: false });
    assert.deepEqual(kept.map((app) => app.id), ['coach']);
    assert.equal(kept[0].displayName, 'Example Coach');
    const widened = await pairApps([ios[0], extraIos], [android[0], extraAndroid], old, 'example', { includeNew: true });
    assert.deepEqual(widened.map((app) => app.id), ['coach', 'legacy']);
    assert.equal(widened[1].flavor, 'TODO');
  } finally { console.log = original; }
});

test('dry run discovers apps without writing config or printing the OAuth token', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'app-kit-bootstrap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = join(dir, 'apps.json');
  const calls = [];
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await bootstrap({ project: 'example-dev', repo: 'example/app', appleAccount: 'example', out, dryRun: true }, {
      callerDir: dir, interactive: false,
      gcloud: (args) => {
        calls.push(args);
        if (args[0] === 'projects') return '000000000000';
        if (args[0] === 'services') return '';
        if (args[0] === 'auth') return 'private-token';
        throw new Error(`unexpected gcloud command: ${args.join(' ')}`);
      },
      ensureResource: () => {},
      grantAppleAccount: () => {},
      fetch: async (url, options) => {
        assert.equal(options.headers['x-goog-user-project'], 'example-dev');
        assert.equal(options.headers.Authorization, 'Bearer private-token');
        return { ok: true, json: async () => ({ apps: String(url).includes('/iosApps') ? [ios[0]] : [android[0]] }) };
      },
    });
  } finally { console.log = original; }
  await assert.rejects(() => readFile(out), { code: 'ENOENT' });
  assert.equal(calls.filter((args) => args[0] === 'auth').length, 1);
  assert.ok(!lines.join('\n').includes('private-token'));
});

test('bootstrap writes caller config and checks both Firebase distributions', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'app-kit-bootstrap-write-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = join(dir, 'apps.json');
  const releaseUrls = [];
  const bindings = [];
  const original = console.log;
  console.log = () => {};
  let config;
  try { config = await bootstrap({ project: 'example-dev', repo: 'example/app', appleAccount: 'example', out }, {
    callerDir: dir, interactive: false,
    gcloud: (args) => {
      if (args[0] === 'projects' && args[1] === 'describe') return '000000000000';
      if (args[0] === 'services' && args[1] === 'list') return ['iam', 'iamcredentials', 'sts', 'firebaseappdistribution', 'firebase'].map((api) => `${api}.googleapis.com`).join('\n');
      if (args[0] === 'auth') return 'private-token';
      if (args.includes('add-iam-policy-binding')) { bindings.push(args); return ''; }
      throw new Error(`unexpected gcloud command: ${args.join(' ')}`);
    },
    ensureResource: () => {},
    grantAppleAccount: () => {},
    fetch: async (url, options) => {
      assert.equal(options.headers['x-goog-user-project'], 'example-dev');
      if (String(url).includes('/iosApps')) return { ok: true, json: async () => ({ apps: [ios[0]] }) };
      if (String(url).includes('/androidApps')) return { ok: true, json: async () => ({ apps: [android[0]] }) };
      releaseUrls.push(String(url));
      return { status: 200 };
    },
  }); } finally { console.log = original; }
  assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), config);
  assert.equal(config.apps[0].flavor, 'TODO');
  assert.equal(releaseUrls.length, 2);
  assert.equal(bindings.length, 2);
  for (const args of bindings) assert.ok(args.includes('--condition=None'), 'IAM bindings must work on policies that already contain conditions');
  assert.ok(!(await readFile(out, 'utf8')).includes('private-token'));
});

test('bootstrap rerun keeps privateGitDependencies and flutterVersion from the existing config', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'app-kit-bootstrap-git-deps-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = join(dir, 'apps.json');
  await writeFile(out, JSON.stringify({ privateGitDependencies: ['owner/private-repo'], flutterVersion: '3.41.9' }));
  const original = console.log;
  console.log = () => {};
  let config;
  try { config = await bootstrap({ project: 'example-dev', repo: 'example/app', appleAccount: 'example', out }, {
    callerDir: dir, interactive: false,
    gcloud: (args) => {
      if (args[0] === 'projects' && args[1] === 'describe') return '000000000000';
      if (args[0] === 'services' && args[1] === 'list') return ['iam', 'iamcredentials', 'sts', 'firebaseappdistribution', 'firebase'].map((api) => `${api}.googleapis.com`).join('\n');
      if (args[0] === 'auth') return 'private-token';
      if (args.includes('add-iam-policy-binding')) return '';
      throw new Error(`unexpected gcloud command: ${args.join(' ')}`);
    },
    ensureResource: () => {},
    grantAppleAccount: () => {},
    fetch: async (url) => {
      if (String(url).includes('/iosApps')) return { ok: true, json: async () => ({ apps: [ios[0]] }) };
      if (String(url).includes('/androidApps')) return { ok: true, json: async () => ({ apps: [android[0]] }) };
      return { status: 200 };
    },
  }); } finally { console.log = original; }
  assert.deepEqual(config.privateGitDependencies, ['owner/private-repo']);
  assert.deepEqual(JSON.parse(await readFile(out, 'utf8')).privateGitDependencies, ['owner/private-repo']);
  assert.equal(config.flutterVersion, '3.41.9');
  assert.equal(JSON.parse(await readFile(out, 'utf8')).flutterVersion, '3.41.9');
});

// ---- pairing ----
const quiet = async (fn) => {
  const original = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = original; }
};
const ambiguousIos = [
  { appId: '1:1:ios:alpha', displayName: 'Alpha iOS', bundleId: 'com.x.alpha' },
  { appId: '1:1:ios:beta', displayName: 'Beta iOS', bundleId: 'com.x.beta' },
];
const ambiguousAndroid = [
  { appId: '1:1:android:gamma', displayName: 'Gamma Android', packageName: 'com.y.gamma' },
  { appId: '1:1:android:delta', displayName: 'Delta Android', packageName: 'com.y.delta' },
];

test('ambiguous pairing stops non-interactively with exit code 2, candidates and the --pair hint', async () => {
  await assert.rejects(() => quiet(() => pairApps(ambiguousIos, ambiguousAndroid, [], 'example', { interactive: false })), (error) => {
    assert.ok(error instanceof PairingError);
    assert.equal(error.exitCode, 2);
    for (const text of ['com.x.alpha', '1:1:ios:beta', 'com.y.gamma', '1:1:android:delta', '--pair ios=<firebaseAppId>,android=<firebaseAppId>', '--pair ios=1:1:ios:alpha,android=1:1:android:gamma']) assert.ok(error.message.includes(text), text);
    return true;
  });
});

test('ambiguous pairing prompts on a TTY and allows skipping', async () => {
  const questions = [];
  const answers = ['x', '2', 's'];
  const pairs = await quiet(() => pairApps(ambiguousIos, ambiguousAndroid, [], 'example', { interactive: true, ask: async (question) => { questions.push(question); return answers.shift(); } }));
  assert.equal(questions.length, 3);
  assert.deepEqual(pairs.map((app) => [app.iosBundleId, app.androidPackage]), [['com.x.alpha', 'com.y.delta']]);
});

test('--pair decides ambiguous apps and rejects unknown or duplicate ids', async () => {
  const specs = parsePairSpecs(['ios=1:1:ios:alpha,android=1:1:android:delta', 'ios=1:1:ios:beta,android=1:1:android:gamma']);
  const pairs = await quiet(() => pairApps(ambiguousIos, ambiguousAndroid, [], 'example', { interactive: false, pairs: specs }));
  assert.deepEqual(pairs.map((app) => app.androidPackage), ['com.y.delta', 'com.y.gamma']);
  await assert.rejects(() => pairApps(ambiguousIos, ambiguousAndroid, [], 'example', { pairs: [{ ios: 'nope', android: '1:1:android:gamma' }] }), /--pair/);
  await assert.rejects(() => pairApps(ambiguousIos, ambiguousAndroid, [], 'example', { pairs: parsePairSpecs(['ios=1:1:ios:alpha,android=1:1:android:delta', 'ios=1:1:ios:beta,android=1:1:android:delta']) }), /重複/);
  assert.throws(() => parsePairSpecs(['ios=a']), /--pair/);
  assert.throws(() => parsePairSpecs(['android=a,ios=b']), /--pair/);
});

test('pairs already decided in apps.json are kept without asking', async () => {
  const old = [{ id: 'alpha', displayName: 'Alpha', iosBundleId: 'com.x.alpha', firebaseAppIds: { ios: '1:1:ios:alpha', android: '1:1:android:delta' }, flavor: 'alpha', target: 'lib/a.dart', appleAccount: 'example' }];
  const pairs = await quiet(() => pairApps([ambiguousIos[0]], ambiguousAndroid, old, 'example', { interactive: false, includeNew: false }));
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].androidPackage, 'com.y.delta');
  assert.equal(pairs[0].flavor, 'alpha');
});

// ---- bootstrap wiring: caller templates, private dependencies, offset ----
const gcloudStub = (args) => {
  if (args[0] === 'projects' && args[1] === 'describe') return '000000000000';
  if (args[0] === 'services' && args[1] === 'list') return ['iam', 'iamcredentials', 'sts', 'firebaseappdistribution', 'firebase'].map((api) => `${api}.googleapis.com`).join('\n');
  if (args[0] === 'auth') return 'private-token';
  if (args.includes('add-iam-policy-binding')) return '';
  throw new Error(`unexpected gcloud command: ${args.join(' ')}`);
};
const fetchStub = async (url) => {
  if (String(url).includes('/iosApps')) return { ok: true, json: async () => ({ apps: [ios[0]] }) };
  if (String(url).includes('/androidApps')) return { ok: true, json: async () => ({ apps: [android[0]] }) };
  return { status: 200 };
};

test('cross-owner repos get the explicit-secrets caller templates written; same-owner keeps print-only', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'app-kit-callers-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = { gcloud: gcloudStub, ensureResource: () => {}, grantAppleAccount: () => {}, fetch: fetchStub, interactive: false, detectPrivateDependencies: async () => ({ repos: [] }) };
  const crossDir = join(dir, 'cross'), sameDir = join(dir, 'same');
  await quiet(() => bootstrap({ project: 'example-dev', repo: 'example/app', appleAccount: 'example', out: join(dir, 'a.json') }, { ...base, callerDir: crossDir }));
  const build = await readFile(join(crossDir, 'app-distribution.yml'), 'utf8');
  assert.ok(!build.includes('secrets: inherit') && build.includes('APP_STORE_CONNECT_KEY_P8: ${{ secrets.APP_STORE_CONNECT_KEY_P8 }}'));
  assert.ok((await readFile(join(crossDir, 'app-distribution-check.yml'), 'utf8')).includes('GIT_DEPENDENCY_TOKEN: ${{ secrets.GIT_DEPENDENCY_TOKEN }}'));
  await quiet(() => bootstrap({ project: 'example-dev', repo: 'koikenosalmon/app', appleAccount: 'example', out: join(dir, 'b.json') }, { ...base, callerDir: sameDir }));
  assert.equal(existsSync(sameDir), false);
  // a hand-edited caller without inherit is left alone; one with inherit is replaced
  await mkdir(join(dir, 'edit'));
  await writeFile(join(dir, 'edit/app-distribution.yml'), 'name: mine\njobs:\n  x:\n    secrets:\n      A: ${{ secrets.A }}\n');
  await writeFile(join(dir, 'edit/app-distribution-check.yml'), 'jobs:\n  x:\n    secrets: inherit\n');
  await quiet(() => bootstrap({ project: 'example-dev', repo: 'example/app', appleAccount: 'example', out: join(dir, 'c.json') }, { ...base, callerDir: join(dir, 'edit') }));
  assert.equal(await readFile(join(dir, 'edit/app-distribution.yml'), 'utf8'), 'name: mine\njobs:\n  x:\n    secrets:\n      A: ${{ secrets.A }}\n');
  assert.ok(!(await readFile(join(dir, 'edit/app-distribution-check.yml'), 'utf8')).includes('inherit'));
});

test('bootstrap adds detected private dependencies, keeps buildNumberOffset and rejects a bad one', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'app-kit-deps-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = join(dir, 'apps.json');
  await writeFile(out, JSON.stringify({ buildNumberOffset: 100, privateGitDependencies: ['a/one'] }));
  const provisioned = [];
  const base = { gcloud: gcloudStub, ensureResource: () => {}, grantAppleAccount: () => {}, fetch: fetchStub, interactive: false, callerDir: dir, detectPrivateDependencies: async () => ({ repos: ['A/ONE', 'b/two'] }), run: (command, args) => { provisioned.push([command, ...args]); return { status: 0, stdout: 'GIT_DEPENDENCY_TOKEN\n', stderr: '' }; } };
  const config = await quiet(() => bootstrap({ project: 'example-dev', repo: 'example/app', appleAccount: 'example', out }, base));
  assert.deepEqual(config.privateGitDependencies, ['a/one', 'b/two']);
  assert.equal(config.buildNumberOffset, 100);
  assert.equal(JSON.parse(await readFile(out, 'utf8')).buildNumberOffset, 100);
  assert.deepEqual(provisioned.map((call) => call.slice(0, 3).join(' ')), ['gh secret list']);
  await writeFile(out, JSON.stringify({ buildNumberOffset: -1 }));
  await assert.rejects(() => quiet(() => bootstrap({ project: 'example-dev', repo: 'example/app', appleAccount: 'example', out }, base)), /buildNumberOffset/);
});

// ---- private dependency detection and deploy key ----
test('pubspec parsing finds GitHub git dependencies in every URL form', () => {
  const pubspec = ['dependencies:', '  a:', '    git:', '      url: https://github.com/Org/private-a.git', '      ref: main', '  b:', '    git: git@github.com:org/private-b.git', '  c:', '    git:', '      url: "ssh://git@github.com/org/private-c"', '  d:', '    git:', '      url: https://gitlab.com/org/other.git', '  # git: https://github.com/org/commented.git', '  e:', '    git: https://github.com/Org/private-a'].join('\n');
  assert.deepEqual(githubGitDependencies(pubspec), ['Org/private-a', 'org/private-b', 'org/private-c']);
});

test('detection keeps only private dependencies owned by other repos', async () => {
  const calls = [];
  const run = (command, args) => { calls.push(args[1]); return args[1] === 'repos/org/public' ? { status: 0, stdout: 'false\n', stderr: '' } : args[1] === 'repos/org/hidden' ? { status: 1, stdout: '', stderr: 'Not Found' } : { status: 0, stdout: 'true\n', stderr: '' }; };
  const pubspec = 'x:\n  git: https://github.com/org/private\ny:\n  git: https://github.com/org/public\nz:\n  git: https://github.com/org/hidden\nself:\n  git: https://github.com/EXAMPLE/app\n';
  const result = await quiet(() => detectPrivateDependencies({ appRepo: 'example/app', appDir: 'native', run, readPubspec: (path) => { assert.equal(path, 'native/pubspec.yaml'); return pubspec; } }));
  assert.deepEqual(result.repos, ['org/private']);
  assert.deepEqual(calls, ['repos/org/private', 'repos/org/public', 'repos/org/hidden']);
  assert.deepEqual((await detectPrivateDependencies({ appRepo: 'a/b', appDir: 'x', readPubspec: () => { throw new Error('none'); } })).repos, []);
});

function deployKeyHarness({ addFailure } = {}) {
  const calls = [];
  const dirs = [];
  const secretInputs = [];
  const run = (command, args, options = {}) => {
    calls.push([command, ...args]);
    if (command === 'gh' && args[0] === 'secret' && args[1] === 'list') return { status: 0, stdout: 'OTHER\n', stderr: '' };
    if (command === 'ssh-keygen') { writeFileSync(args[args.indexOf('-f') + 1], 'PRIVATE-KEY-MATERIAL\n'); writeFileSync(`${args[args.indexOf('-f') + 1]}.pub`, 'ssh-ed25519 PUBLIC\n'); return { status: 0, stdout: '', stderr: '' }; }
    if (command === 'gh' && args[1] === 'deploy-key') return addFailure ? { status: 1, stdout: '', stderr: addFailure } : { status: 0, stdout: 'ok', stderr: '' };
    if (command === 'gh' && args[0] === 'secret' && args[1] === 'set') { secretInputs.push(options.input); return { status: 0, stdout: '', stderr: '' }; }
    throw new Error(`unexpected: ${command} ${args.join(' ')}`);
  };
  return { calls, dirs, secretInputs, run, makeTempDir: () => { const directory = mkdtempSync(join(tmpdir(), 'deploy-key-test-')); dirs.push(directory); return directory; } };
}

test('single private dependency: read-only deploy key is created, stored as a secret and wiped without printing key material', async () => {
  const h = deployKeyHarness();
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  let outcome;
  try { outcome = provisionDependencyCredential({ appRepo: 'example/app', repos: ['org/private'], run: h.run, makeTempDir: h.makeTempDir }); } finally { console.log = original; }
  assert.equal(outcome, 'created');
  const add = h.calls.find((call) => call[1] === 'repo');
  assert.deepEqual(add.slice(0, 4), ['gh', 'repo', 'deploy-key', 'add']);
  assert.ok(add.includes('org/private') && !add.includes('--allow-write'));
  assert.deepEqual(h.calls.find((call) => call[3] === 'GIT_DEPENDENCY_SSH_KEY').slice(0, 5), ['gh', 'secret', 'set', 'GIT_DEPENDENCY_SSH_KEY', '--repo']);
  assert.deepEqual(h.secretInputs, ['PRIVATE-KEY-MATERIAL\n']);
  assert.equal(h.dirs.length, 1);
  assert.equal(existsSync(h.dirs[0]), false);
  assert.ok(!lines.join('\n').includes('PRIVATE-KEY-MATERIAL') && !lines.join('\n').includes('PUBLIC'));
});

test('disabled deploy keys fall back to token guidance and still wipe the temp key', () => {
  const h = deployKeyHarness({ addFailure: 'gh: Deploy keys are disabled for this repository (HTTP 422)' });
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  let outcome;
  try { outcome = provisionDependencyCredential({ appRepo: 'example/app', repos: ['org/private'], run: h.run, makeTempDir: h.makeTempDir }); } finally { console.log = original; }
  assert.equal(outcome, 'disabled');
  assert.ok(lines.join('\n').includes('GIT_DEPENDENCY_TOKEN') && lines.join('\n').includes('Contents: Read'));
  assert.equal(h.calls.some((call) => call[3] === 'GIT_DEPENDENCY_SSH_KEY'), false);
  assert.equal(existsSync(h.dirs[0]), false);
});

test('other deploy-key failures, dry runs, existing secrets and multiple dependencies never create a key', () => {
  const quietRun = (fn) => { const original = console.log; console.log = () => {}; try { return fn(); } finally { console.log = original; } };
  const failing = deployKeyHarness({ addFailure: 'HTTP 404' });
  assert.equal(quietRun(() => provisionDependencyCredential({ appRepo: 'e/a', repos: ['o/p'], run: failing.run, makeTempDir: failing.makeTempDir })), 'failed');
  assert.equal(existsSync(failing.dirs[0]), false);
  const dry = deployKeyHarness();
  assert.equal(quietRun(() => provisionDependencyCredential({ appRepo: 'e/a', repos: ['o/p'], dryRun: true, run: dry.run, makeTempDir: dry.makeTempDir })), 'dry-run');
  assert.equal(dry.dirs.length, 0);
  const multiple = deployKeyHarness();
  assert.equal(quietRun(() => provisionDependencyCredential({ appRepo: 'e/a', repos: ['o/p', 'o/q'], run: multiple.run, makeTempDir: multiple.makeTempDir })), 'multiple');
  assert.equal(multiple.dirs.length, 0);
  const existing = (command, args) => (args[0] === 'secret' ? { status: 0, stdout: 'GIT_DEPENDENCY_TOKEN\n', stderr: '' } : (() => { throw new Error('must not run'); })());
  assert.equal(quietRun(() => provisionDependencyCredential({ appRepo: 'e/a', repos: ['o/p'], run: existing })), 'exists');
  assert.equal(provisionDependencyCredential({ appRepo: 'e/a', repos: [], run: existing }), 'none');
});
