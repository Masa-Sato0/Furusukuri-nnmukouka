'use strict';
// Genuine extension installation smoke test. Never modifies enterprise policy.
const {chromium} = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fws-extension-smoke-'));
  let context;
  try {
    const extension = path.resolve(__dirname, '..');
    context = await chromium.launchPersistentContext(profile, {
      executablePath: process.env.CHROMIUM_PATH || undefined, channel: 'chromium', headless: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--no-sandbox', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: 10000});
    if (!worker.url().endsWith('/background.js')) throw new Error('Expected extension service worker was not found.');
    const result = await worker.evaluate(async () => {
      await ready;
      const scripts = await chrome.scripting.getRegisteredContentScripts();
      const commands = await chrome.commands.getAll();
      return {version: chrome.runtime.getManifest().version, commands, scripts: scripts.length};
    });
    console.log('EXTENSION SMOKE PASS', JSON.stringify(result));
  } catch (error) {
    console.error('EXTENSION SMOKE NOT VERIFIED: 拡張機能を読み込めませんでした。管理ポリシー、ブラウザの対応状況、Chrome拡張機能のエラーを確認してください。制限の回避は行いません。');
    console.error(error.message); process.exitCode = 1;
  } finally {
    await context?.close(); fs.rmSync(profile, {recursive:true,force:true});
  }
})();
