'use strict';
const $ = id => document.getElementById(id);
const feedback = text => { $('feedback').textContent = text; };
let changing = false;
async function refresh() {
  const {sites = [], apiKey = ''} = await chrome.storage.local.get(['sites', 'apiKey']);
  $('key-state').textContent = apiKey ? 'APIキー：保存済み' : 'APIキー：未設定';
  $('sites').replaceChildren();
  for (const site of sites) {
    const li = document.createElement('li');
    const label = document.createElement('span'); label.textContent = site;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary';
    remove.textContent = '許可を解除'; remove.setAttribute('aria-label', `${site}の許可を解除`);
    remove.addEventListener('click', () => change(async () => {
      const {sites: current = []} = await chrome.storage.local.get('sites');
      await chrome.storage.local.set({sites: current.filter(s => s !== site)});
      await chrome.permissions.remove({origins: [site]});
      await synchronize(); feedback('サイトの許可を解除しました。');
    }));
    li.append(label, remove); $('sites').append(li);
  }
  if (!sites.length) { const li = document.createElement('li'); li.textContent = 'まだ許可したサイトはありません。'; $('sites').append(li); }
  const commands = await chrome.commands.getAll();
  $('shortcut').textContent = `現在の割り当て：${commands.find(c => c.name === 'toggle-search')?.shortcut || '未割り当て'}`;
}
async function synchronize() {
  const reply = await chrome.runtime.sendMessage({type: 'FWS_SYNC'});
  if (!reply?.ok) throw new Error('設定の反映に失敗しました。拡張機能を再読み込みしてください。');
}
async function change(fn) {
  if (changing) return;
  changing = true;
  for (const b of document.querySelectorAll('button')) b.disabled = true;
  try { await fn(); await refresh(); }
  catch (error) { feedback(error.message || '設定を保存できませんでした。'); }
  finally { changing = false; for (const b of document.querySelectorAll('button')) b.disabled = false; }
}
$('key-form').addEventListener('submit', event => {
  event.preventDefault();
  const apiKey = $('api-key').value.trim();
  if (!apiKey || !/^[\x21-\x7e]{1,512}$/.test(apiKey)) { feedback('空白や改行を含まないAPIキーを入力してください。'); return; }
  change(async () => {
    await chrome.storage.local.set({apiKey}); $('api-key').value = ''; feedback('APIキーを保存しました。');
  });
});
$('delete-key').addEventListener('click', () => change(async () => {
  await chrome.storage.local.remove('apiKey'); $('api-key').value = ''; feedback('APIキーを削除しました。');
}));
$('site-form').addEventListener('submit', event => {
  event.preventDefault();
  if (changing) return;
  let pattern;
  try { pattern = FWSCore.originPattern($('site-url').value); } catch (error) { feedback(error.message); return; }
  const grant = chrome.permissions.request({origins: [pattern]});
  change(async () => {
    if (!await grant) { feedback('サイトの権限が許可されませんでした。'); return; }
    const {sites = []} = await chrome.storage.local.get('sites');
    await chrome.storage.local.set({sites: [...new Set([...sites, pattern])]});
    await synchronize(); $('site-url').value = ''; feedback('許可サイトを保存しました。開いているページにも反映しました。');
  });
});
$('shortcuts').addEventListener('click', () => chrome.tabs.create({url: 'chrome://extensions/shortcuts'}).catch(() => feedback('chrome://extensions/shortcuts をアドレスバーで開いてください。')));
refresh().catch(() => feedback('設定を読み込めません。拡張機能を再読み込みしてください。'));
