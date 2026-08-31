#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const root = new URL('../', import.meta.url);
const skillsRoot = new URL('../skills/', import.meta.url);
const expectedSkills = new Set([
  'baynex-read-specifications',
  'baynex-update-specifications',
  'baynex-manage-ui-definitions',
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

process.stdout.write('Distribution validation passed.\n');
