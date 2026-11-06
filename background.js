'use strict';
importScripts('shared.js');
const Core = globalThis.FWSCore;
const SCRIPT_ID = 'fws-permitted-sites';
const API = 'https://api.search.brave.com/res/v1/web/search';
const jobs = new Map();
let cssPromise;
let syncChain = Promise.resolve();
let cooldownUntil = 0;

async function initialize() {
  await chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
  await chrome.storage.session.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
  await syncScripts();
}
const ready = initialize();
ready.catch(() => {});

async function allowed(url) {
  const {sites = []} = await chrome.storage.local.get('sites');
  if (!Core.permitted(url, sites)) return false;
  return chrome.permissions.contains({origins: [Core.originPattern(url)]});
}
async function syncScripts() {
  const {sites = []} = await chrome.storage.local.get('sites');
  const matches = [];
  for (const site of sites) {
    try { if (Core.originPattern(site) === site && await chrome.permissions.contains({origins: [site]})) matches.push(site); } catch {}
  }
  const existing = (await chrome.scripting.getRegisteredContentScripts()).find(s => s.id === SCRIPT_ID);
  if (!matches.length) {
    if (existing) await chrome.scripting.unregisterContentScripts({ids: [SCRIPT_ID]});
  } else {
    const spec = {id: SCRIPT_ID, matches, js: ['shared.js', 'content.js'], runAt: 'document_start',
      allFrames: true, world: 'ISOLATED', persistAcrossSessions: true};
    if (existing) await chrome.scripting.updateContentScripts([spec]);
    else await chrome.scripting.registerContentScripts([spec]);
  }
  for (const tab of await chrome.tabs.query({})) {
    if (!tab.id) continue;
    const frames = await chrome.webNavigation.getAllFrames({tabId: tab.id}).catch(() => []) || [];
    for (const frame of frames) {
      if (await allowed(frame.url)) {
        await chrome.scripting.executeScript({target: {tabId: tab.id, frameIds: [frame.frameId]},
          files: ['shared.js', 'content.js'], world: 'ISOLATED'}).catch(() => {});
      } else {
        await chrome.tabs.sendMessage(tab.id, {type: 'FWS_DISABLE'}, {frameId: frame.frameId}).catch(() => {});
        cancelJob(`${tab.id}:${frame.frameId}`);
      }
    }
  }
}
function scheduleSync() {
  syncChain = syncChain.catch(() => {}).then(() => ready).then(syncScripts);
  return syncChain;
}
chrome.permissions.onRemoved.addListener(() => { scheduleSync().catch(() => {}); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.sites) scheduleSync().catch(() => {});
  if (changes.apiKey) { for (const key of jobs.keys()) cancelJob(key); cooldownUntil = 0; }
});
function cancelJob(key) {
  const old = jobs.get(key);
  if (old) { old.controller.abort(); jobs.delete(key); }
}
async function report(tabId, text) {
  await chrome.storage.session.set({[`status:${tabId}`]: {text, time: Date.now()}});
  await chrome.action.setBadgeText({tabId, text: text ? '!' : ''}).catch(() => {});
  if (text) await chrome.action.setBadgeBackgroundColor({tabId, color: '#b45309'}).catch(() => {});
}
async function search(message, sender) {
  const key = `${sender.tab.id}:${sender.frameId}`;
  const params = Core.searchParams(message.query, message.page);
  const {apiKey = ''} = await chrome.storage.local.get('apiKey');
  if (!apiKey) return {ok: false, code: 'NO_KEY', error: 'APIキーが未設定です。「設定」でBrave Search APIキーを保存してください。'};
  if (Date.now() < cooldownUntil) return {ok: false, code: 'RATE_LIMIT', error: `API利用制限中です。約${Math.ceil((cooldownUntil - Date.now()) / 1000)}秒後に再試行してください。`};
  cancelJob(key);
  const job = {controller: new AbortController(), requestId: message.requestId, timedOut: false};
  jobs.set(key, job);
  const timeout = setTimeout(() => { job.timedOut = true; job.controller.abort(); }, 15000);
  try {
    const response = await fetch(`${API}?${params}`, {
      method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error',
      headers: {'Accept': 'application/json', 'X-Subscription-Token': apiKey}, signal: job.controller.signal
    });
    if (response.status === 429) {
      const retry = response.headers.get('Retry-After');
      const seconds = /^\d+$/.test(retry || '') ? Number(retry) : Math.ceil((Date.parse(retry) - Date.now()) / 1000);
      const delay = Number.isFinite(seconds) ? Math.max(1, Math.min(3600, seconds)) : 30;
      cooldownUntil = Date.now() + delay * 1000;
      return {ok: false, code: 'RATE_LIMIT', error: `APIの利用制限に達しました。${delay}秒後に再試行してください。`};
    }
    if ([401, 403].includes(response.status)) return {ok: false, code: 'AUTH', error: 'APIキーまたはBraveの契約・利用権限を確認してください。'};
    if (!response.ok) return {ok: false, code: 'HTTP', error: `検索APIがエラーを返しました（HTTP ${response.status}）。時間を置いて再試行してください。`};
    const result = Core.normalizeResults(await response.json());
    if (!await allowed(sender.url)) return {ok: false, code: 'DENIED', error: 'このサイトの許可が解除されました。'};
    return {ok: true, ...result, more: result.more && message.page < 9};
  } catch (error) {
    if (job.controller.signal.aborted) return {ok: false, code: 'CANCELLED', error: job.timedOut ? '検索がタイムアウトしました。再試行してください。' : '検索を中断しました。'};
    return {ok: false, code: 'NETWORK', error: '検索に失敗しました。ネットワーク、APIの状態、応答形式を確認し、再試行してください。'};
  } finally {
    clearTimeout(timeout);
    if (jobs.get(key) === job) jobs.delete(key);
  }
}
function trustedUI(sender) {
  return [chrome.runtime.getURL('options.html'), chrome.runtime.getURL('popup.html')].includes(sender.url);
}
async function handle(message, sender) {
  await ready;
  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') throw new Error('不正なメッセージです。');
  if (trustedUI(sender)) {
    if (message.type === 'FWS_SYNC') { await scheduleSync(); return {ok: true}; }
    if (message.type === 'FWS_UI_TOGGLE') {
      const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
      if (!tab?.id) throw new Error('対象タブがありません。');
      return toggle(tab.id);
    }
  }
  if (!sender.tab || sender.origin === 'null' || !await allowed(sender.url)) throw new Error('このページは許可されていません。設定でサイトを追加してください。');
  switch (message.type) {
    case 'FWS_BOOT':
      cssPromise ||= fetch(chrome.runtime.getURL('styles.css')).then(r => { if (!r.ok) throw new Error(); return r.text(); });
      return {ok: true, css: await cssPromise};
    case 'FWS_SEARCH': return search(message, sender);
    case 'FWS_CANCEL': {
      const key = `${sender.tab.id}:${sender.frameId}`;
      if (jobs.get(key)?.requestId === message.requestId) cancelJob(key);
      return {ok: true};
    }
    case 'FWS_REPORT':
      await report(sender.tab.id, String(message.error || '').slice(0, 500)); return {ok: true};
    case 'FWS_OPTIONS': await chrome.runtime.openOptionsPage(); return {ok: true};
    default: throw new Error('未対応の操作です。');
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handle(message, sender).then(respond, () => respond({ok: false, error: '操作できません。このサイトの許可、拡張機能の状態を確認してください。'}));
  return true;
});
async function toggle(tabId) {
  await ready;
  const frames = await chrome.webNavigation.getAllFrames({tabId}).catch(() => null);
  const top = frames?.find(f => f.frameId === 0);
  if (!top || !await allowed(top.url)) {
    const error = 'このページは対象外です。設定でhttp/httpsのサイトを許可してください。chrome://、Web Store、管理者が禁止したページ等では動作できません。';
    await report(tabId, error); return {ok: false, error};
  }
  const probes = (await Promise.all(frames.map(async frame => {
    if (!await allowed(frame.url)) return null;
    try {
      const state = await chrome.tabs.sendMessage(tabId, {type: 'FWS_PROBE'}, {frameId: frame.frameId});
      return {...frame, ...state};
    } catch { return null; }
  }))).filter(Boolean);
  const root = probes.find(p => p.frameId === 0);
  if (!root) {
    const error = 'ページに接続できません。ページを再読み込みしてください。サイトの制限や管理ポリシーで実行できない場合もあります。';
    await report(tabId, error); return {ok: false, error};
  }
  let target = root;
  if (root.fullscreen) {
    const depth = p => {
      let n = 0, f = p;
      while (f && f.parentFrameId !== -1 && n < 100) { n++; f = frames.find(x => x.frameId === f.parentFrameId); }
      return n;
    };
    const candidates = probes.filter(p => p.fullscreen).sort((a, b) => depth(b) - depth(a));
    target = candidates[0] || root;
  }
  if (target.blocked) { await report(tabId, target.blocked); return {ok: false, error: target.blocked}; }
  await Promise.all(probes.filter(p => p.frameId !== target.frameId && p.open).map(p =>
    chrome.tabs.sendMessage(tabId, {type: 'FWS_CLOSE'}, {frameId: p.frameId}).catch(() => {})));
  try {
    const response = await chrome.tabs.sendMessage(tabId, {type: 'FWS_TOGGLE'}, {frameId: target.frameId});
    await report(tabId, response?.error || '');
    return response;
  } catch {
    const error = 'ページが切り替わりました。もう一度ショートカットを押してください。';
    await report(tabId, error); return {ok: false, error};
  }
}
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'toggle-search') return;
  (async () => {
    const target = tab?.id ? tab : (await chrome.tabs.query({active: true, currentWindow: true}))[0];
    if (target?.id) await toggle(target.id);
  })().catch(() => {});
});
for (const event of [chrome.webNavigation.onHistoryStateUpdated, chrome.webNavigation.onReferenceFragmentUpdated]) {
  event.addListener(details => {
    (async () => {
      if (await allowed(details.url)) await chrome.tabs.sendMessage(details.tabId, {type: 'FWS_ROUTE_CHANGED'}, {frameId: details.frameId});
    })().catch(() => {});
  }, {url: [{schemes: ['http', 'https']}]});
}
chrome.webNavigation.onCommitted.addListener(({tabId, frameId}) => cancelJob(`${tabId}:${frameId}`));
chrome.tabs.onRemoved.addListener(tabId => {
  for (const key of jobs.keys()) if (key.startsWith(`${tabId}:`)) cancelJob(key);
  chrome.storage.session.remove(`status:${tabId}`).catch(() => {});
});
