'use strict';
const status = document.getElementById('status');
(async () => {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  const key = `status:${tab?.id}`;
  const stored = await chrome.storage.session.get(key);
  const commands = await chrome.commands.getAll();
  const shortcut = commands.find(c => c.name === 'toggle-search')?.shortcut || '未割り当て（設定で変更）';
  status.textContent = stored[key]?.text || `ショートカット：${shortcut}`;
})().catch(() => { status.textContent = '状態を取得できません。設定を確認してください。'; });
document.getElementById('toggle').addEventListener('click', async () => {
  try {
    const response = await chrome.runtime.sendMessage({type: 'FWS_UI_TOGGLE'});
    if (response?.ok) window.close();
    else status.textContent = response?.error || '表示できません。サイトの許可を確認してください。';
  } catch { status.textContent = '拡張機能へ接続できません。再読み込みしてください。'; }
});
document.getElementById('options').addEventListener('click', () => chrome.runtime.openOptionsPage().catch(() => { status.textContent = 'chrome://extensions から拡張機能のオプションを開いてください。'; }));
