#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url);
const skillsRoot = new URL('../skills/', import.meta.url);
const expectedSkills = new Set([
  'baynex-read-specifications',
  'baynex-update-specifications',
  'baynex-manage-ui-definitions',
  'baynex-app-distribution-setup',
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseFrontmatter(contents, path) {
  const match = contents.match(/^---\n([\s\S]*?)\n---\n/);
  assert(match, `${path}: missing YAML frontmatter`);
  const fields = Object.fromEntries(match[1].split('\n').map((line) => {
    const separator = line.indexOf(':');
    assert(separator > 0, `${path}: malformed frontmatter`);
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }));
  return fields;
}

const entries = (await readdir(skillsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
assert(entries.length === expectedSkills.size, 'unexpected number of skill directories');
for (const entry of entries) {
  const name = basename(entry.name);
  assert(expectedSkills.has(name), `unexpected skill: ${name}`);
  const skillUrl = new URL(`${name}/SKILL.md`, skillsRoot);
  const contents = await readFile(skillUrl, 'utf8');
  const fields = parseFrontmatter(contents, skillUrl.pathname);
  assert(Object.keys(fields).sort().join(',') === 'description,name', `${name}: frontmatter must contain only name and description`);
  assert(fields.name === name, `${name}: frontmatter name mismatch`);
  assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && name.length <= 64, `${name}: invalid skill name`);
  assert(fields.description.length > 0 && fields.description.length <= 1024, `${name}: invalid description length`);
  assert(!contents.includes('TODO'), `${name}: unresolved TODO`);
  const openai = await readFile(new URL(`${name}/agents/openai.yaml`, skillsRoot), 'utf8');
  assert(openai.includes(`$${name}`), `${name}: default prompt must mention the skill`);
}

const plugin = JSON.parse(await readFile(new URL('.codex-plugin/plugin.json', root), 'utf8'));
assert(plugin.name === 'baynex-agent-skills' && plugin.version === '0.1.0', 'invalid plugin identity');
assert(plugin.skills === './skills/' && plugin.mcpServers === './.mcp.json', 'plugin paths are not portable');
const mcp = JSON.parse(await readFile(new URL('.mcp.json', root), 'utf8'));
const server = mcp.mcpServers?.['baynex-specifications'];
assert(server?.command === 'node' && server.args?.[0] === './scripts/baynex-mcp-stdio.mjs', 'invalid MCP adapter config');
assert(server.env_vars?.length === 3, 'MCP config must declare only canonical credential names');

export async function validateKitLayout(kitRoot = new URL('../app-distribution/', import.meta.url), workflowRoot = new URL('../.github/workflows/', import.meta.url)) {
  const scripts = ['config.mjs', 'app-store-connect.mjs', 'secret-manager.mjs', 'firebase-activate.mjs', 'firebase-udids.mjs', 'distribution-check.mjs', 'git-dependencies.mjs', 'baynex-release-notes.sh', 'build-number.mjs', 'load-app.mjs'];
  for (const file of scripts) {
    const source = await readFile(new URL(`scripts/${file}`, kitRoot), 'utf8');
    assert(source.length > 0, `${file}: empty kit script`);
    if (file !== 'config.mjs') {
      const test = await readFile(new URL(`scripts/${file.replace(/\.(mjs|sh)$/, '.test.mjs')}`, kitRoot), 'utf8');
      assert(test.includes("node:test"), `${file}: missing node:test suite`);
    }
  }
  const build = await readFile(new URL('app-distribution.yml', workflowRoot), 'utf8');
  assert((build.match(/git-dependencies\.mjs setup/g) || []).length === 2 && (build.match(/git-dependencies\.mjs cleanup/g) || []).length === 2, 'app-distribution.yml: Android and iOS jobs must set up and clean up private Git dependencies');
  assert((build.match(/scripts\/load-app\.mjs/g) || []).length === 2, 'app-distribution.yml: Android and iOS jobs must re-read their app from apps.json by matrix index');
  assert((build.match(/scripts\/build-number\.mjs/g) || []).length === 2 && !/--build-number="\$RUN_NUMBER"/.test(build), 'app-distribution.yml: both jobs must take the build number from build-number.mjs');
  assert(!/matrix\.app\b/.test(build) && /index: \$\{\{ fromJSON\(needs\.detect\.outputs\.matrix\) \}\}/.test(build), 'app-distribution.yml: the matrix must carry only app indices');
  const detectOutputs = build.match(/^  detect:[\s\S]*?\n    outputs:\n([\s\S]*?)\n    steps:/m)?.[1] || '';
  assert([...detectOutputs.matchAll(/^ {6}([a-z_]+):/gm)].map((m) => m[1]).sort().join() === 'android_signing,app_present,matrix,wif_ready', 'app-distribution.yml: detect outputs must be flags and indices only, never config values');
  assert(!/needs\.detect\.outputs\.(?:app_dir|product_id|wif_provider|wif_service_account|flutter_version)/.test(build), 'app-distribution.yml: config values must not be read from job outputs');
  assert(!/git config --global|persist-credentials: true/.test(build), 'app-distribution.yml: credentials must not be persisted in global git config');
  for (const file of ['bootstrap.mjs', 'add-apple-account.mjs', 'grant-apple-account.mjs', 'README.md']) assert((await readFile(new URL(file, kitRoot), 'utf8')).length > 0, `missing ${file}`);
  for (const file of ['app-distribution.yml', 'app-distribution-check.yml']) {
    const workflow = await readFile(new URL(file, workflowRoot), 'utf8');
    assert(workflow.includes('workflow_call:'), `${file}: reusable workflow missing`);
    assert(workflow.includes('kit-ref:'), `${file}: kit-ref input missing`);
    assert(workflow.includes('DISTRIBUTION_CONFIG:'), `${file}: caller config input missing`);
    assert(!/--testers\b|--groups\b/.test(workflow), `${file}: uploads must leave tester groups to Baynex`);
    const caller = await readFile(new URL(`templates/caller-${file}`, kitRoot), 'utf8');
    assert(caller.includes('id-token: write') && caller.includes(`workflows/${file}@v1`), `${file}: caller template invalid`);
    const referenced = [...new Set([...workflow.matchAll(/\bsecrets\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]))].sort();
    const declared = [...workflow.matchAll(/^ {6}([A-Z][A-Z0-9_]*):\n {8}required: false$/gm)].map((m) => m[1]).sort();
    assert(referenced.length > 0 && referenced.join() === declared.join(), `${file}: declared workflow_call secrets must equal referenced secrets`);
    const crossOwner = await readFile(new URL(`templates/caller-${file.replace(/\.yml$/, '')}-cross-owner.yml`, kitRoot), 'utf8');
    assert(!crossOwner.includes('secrets: inherit') && crossOwner.includes(`workflows/${file}@v1`), `${file}: cross-owner template invalid`);
    for (const name of declared) assert(crossOwner.includes(`${name}: \${{ secrets.${name} }}`), `${file}: cross-owner template must pass ${name}`);
  }
}
await validateKitLayout();

process.stdout.write('Distribution validation passed.\n');
