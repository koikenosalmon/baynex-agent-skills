#!/usr/bin/env node
// Decides which platform jobs run. Automatic runs (push, schedule) build only the automatic platforms:
// Baynex's distribution-config `platforms.automatic`, else iOS. Android is built only on a manual
// workflow_dispatch: `platform` ios | android | both; a dispatch without the input (an older caller) builds both.
import { appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const PLATFORMS = ['ios', 'android'];
export const DEFAULT_AUTOMATIC = ['ios'];
const REQUESTS = { ios: ['ios'], android: ['android'], both: ['ios', 'android'] };

/** Automatic platforms from the effective config; anything unknown or empty falls back to iOS only. */
export function automaticPlatforms(config) {
  const value = config?.baynex?.platforms?.automatic;
  if (!Array.isArray(value)) return DEFAULT_AUTOMATIC;
  const picked = PLATFORMS.filter((platform) => value.includes(platform));
  return picked.length ? picked : DEFAULT_AUTOMATIC;
}

/** Returns { ios, android, trigger } for this run. An unknown dispatch value is an error, never a guess. */
export function selectPlatforms({ eventName, requested = '', automatic = DEFAULT_AUTOMATIC }) {
  const manual = eventName === 'workflow_dispatch';
  const choice = String(requested || '').trim();
  let selected;
  if (manual) {
    if (choice && !REQUESTS[choice]) throw new Error(`platform は ios / android / both のいずれかです（${choice}）`);
    selected = choice ? REQUESTS[choice] : REQUESTS.both;
  } else {
    selected = automatic;
  }
  return { ios: selected.includes('ios'), android: selected.includes('android'), trigger: manual ? 'manual' : 'automatic' };
}

const label = (selection) => PLATFORMS.filter((platform) => selection[platform]).map((platform) => (platform === 'ios' ? 'iOS' : 'Android')).join(' / ');

export async function runCli(env = process.env) {
  const config = env.DISTRIBUTION_CONFIG ? JSON.parse(await readFile(env.DISTRIBUTION_CONFIG, 'utf8')) : {};
  const selection = selectPlatforms({ eventName: env.GITHUB_EVENT_NAME, requested: env.PLATFORM_INPUT, automatic: automaticPlatforms(config) });
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `build_ios=${selection.ios}\nbuild_android=${selection.android}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    const skipped = selection.android ? '' : '（Android は手動実行: Run workflow → platform: android）';
    appendFileSync(env.GITHUB_STEP_SUMMARY, `- 配布する OS（${selection.trigger === 'manual' ? '手動' : '自動'}）: ${label(selection)}${skipped}\n`);
  }
  return selection;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runCli(); }
  catch (error) { console.error(`エラー: ${error.message}`); process.exitCode = 1; }
}
