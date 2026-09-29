#!/usr/bin/env node
// Prints the build number for this run: github.run_number + apps.json buildNumberOffset.
import { pathToFileURL } from 'node:url';
import { readConfig, splitConfigArgs, validateBuildNumberOffset } from './config.mjs';

export function computeBuildNumber(config, runNumber) {
  const run = Number(runNumber);
  if (typeof runNumber !== 'string' || !/^[1-9]\d{0,9}$/.test(runNumber) || !Number.isSafeInteger(run)) throw new Error('RUN_NUMBER が不正です');
  const value = run + validateBuildNumberOffset(config);
  if (value > 2_100_000_000) throw new Error('ビルド番号が Android の上限（2100000000）を超えます');
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const parsed = splitConfigArgs(process.argv.slice(2));
    if (parsed.args.length) throw new Error('使い方: build-number.mjs [--config <apps.json>]（RUN_NUMBER 環境変数が必要）');
    process.stdout.write(`${computeBuildNumber(await readConfig(parsed.env), process.env.RUN_NUMBER)}\n`);
  } catch (error) { console.error(`エラー: ${error.message}`); process.exitCode = 1; }
}
