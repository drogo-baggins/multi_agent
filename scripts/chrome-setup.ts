#!/usr/bin/env tsx
/**
 * Human Mode セットアップ確認スクリプト
 *
 * Chrome が正しく起動して CDP に接続できるか検証します。
 * 使用方法: npm run chrome-setup
 */
import { existsSync } from "node:fs";

import {
  CDP_PORT,
  ensureChromeReady,
  findChromeExecutable,
  getUserDataDir,
} from "../src/search/browser-launcher.js";

async function main(): Promise<void> {
  console.log("=== Human Mode セットアップ確認 ===\n");

  // 1. Chrome 実行ファイルの確認
  const exe = findChromeExecutable();
  if (!existsSync(exe)) {
    console.error(`✗ Chrome が見つかりません: ${exe}`);
    console.error("  環境変数 CHROME_PATH に Chrome のパスを設定してください。");
    console.error('  例: CHROME_PATH="C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe"');
    process.exit(1);
  }
  console.log(`✓ Chrome: ${exe}`);

  // 2. User data ディレクトリ
  const dataDir = getUserDataDir();
  console.log(`✓ プロファイルディレクトリ: ${dataDir}`);

  // 3. CDP 接続 / Chrome 起動
  console.log(`\nCDP ポート ${CDP_PORT} への接続を確認しています...`);
  try {
    const wsUrl = await ensureChromeReady(CDP_PORT);
    console.log(`✓ CDP 接続 OK: ${wsUrl}`);
  } catch {
    console.error(`\n✗ Chrome の起動または CDP 接続に失敗しました。`);
    console.error(`  手動で以下のコマンドを実行してください:\n`);
    console.error(
      `  "${exe}" --remote-debugging-port=${CDP_PORT} --user-data-dir="${dataDir}" --no-first-run --no-default-browser-check`
    );
    process.exit(1);
  }

  console.log("\n✓ Human Mode の準備ができました。");
  console.log("  .env に SEARCH_MODE=human を追加してエージェントを起動してください。");
  console.log("  例: echo 'SEARCH_MODE=human' >> .env\n");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
