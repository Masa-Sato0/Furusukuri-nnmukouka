'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const shared = fs.readFileSync(path.join(root, 'shared.js'), 'utf8');
const coreContext = vm.createContext({URL, URLSearchParams}); vm.runInContext(shared, coreContext);
const Core = coreContext.FWSCore;
const event = () => ({addListener() {}, removeListener() {}});
function worker(fetchImpl = async () => new Response(JSON.stringify({query: {}, web: {results: []}}))) {
  const local = {sites: ['https://example.com/*'], apiKey: 'unit-test-only'};
  const access = [];
  const storage = {get: async keys => typeof keys === 'string' ? {[keys]: local[keys]} : {...local},
    set: async values => Object.assign(local, values), remove: async key => { delete local[key]; },
    setAccessLevel: async level => access.push(level.accessLevel)};
  const chrome = {runtime: {id: 'unit-extension', getURL: name => `chrome-extension://unit-extension/${name}`, onMessage: event(), openOptionsPage: async () => {}},
    storage: {local: storage, session: {...storage}, onChanged: event()},
    scripting: {getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, updateContentScripts: async () => {}},
    permissions: {contains: async () => true, onRemoved: event()}, tabs: {query: async () => [], onRemoved: event()},
    webNavigation: {onHistoryStateUpdated: event(), onReferenceFragmentUpdated: event(), onCommitted: event()},
    action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}}, commands: {onCommand: event()}};
  const ctx = vm.createContext({URL, URLSearchParams, AbortController, setTimeout, clearTimeout, chrome,
    fetch: fetchImpl, Response, console, importScripts: () => vm.runInContext(shared, ctx)});
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), ctx);
  return {ctx, local, access, chrome, handle: (message, sender = {id: 'unit-extension', tab: {id: 7}, frameId: 0, url: 'https://example.com/a'}) => vm.runInContext('handle', ctx)(message, sender)};
}
const request = (query = '日本語 検索', page = 0) => ({type: 'FWS_SEARCH', requestId: 'request-1', query, page});
test('manifest uses MV3, service worker, commands and optional site permissions', () => {
  const m = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
  assert.equal(m.manifest_version, 3); assert.equal(m.background.service_worker, 'background.js');
  assert.deepEqual(m.host_permissions, ['https://api.search.brave.com/*']);
  assert.equal(m.commands['toggle-search'].suggested_key.chromeos, 'Ctrl+Shift+Y');
  assert.equal(m.content_scripts, undefined); assert.equal(m.web_accessible_resources, undefined);
});
test('site patterns are exact by scheme and host; port semantics are explicit', () => {
  assert.equal(Core.originPattern('https://example.com:8443/a'), 'https://example.com/*');
  assert.equal(Core.permitted('https://sub.example.com/', ['https://example.com/*']), false);
  assert.equal(Core.permitted('http://example.com/', ['https://example.com/*']), false);
  assert.equal(Core.permitted('https://example.com.evil.test/', ['https://example.com/*']), false);
  for (const url of ['file:///a', 'chrome://settings', 'javascript:alert(1)', 'https://u:p@example.com', 'https://*.example.com']) assert.throws(() => Core.originPattern(url));
});
test('result URLs reject active schemes, credentials and malformed strings', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///a', 'https://u:p@example.com', '/relative']) assert.equal(Core.safeURL(url), null);
  assert.equal(Core.safeURL('https://example.com/?q=日本語'), 'https://example.com/?q=%E6%97%A5%E6%9C%AC%E8%AA%9E');
});
test('query validation and Brave Japanese parameters / page offsets', () => {
  const p = Core.searchParams(' 日本語 検索 ', 9);
  assert.equal(p.get('q'), '日本語 検索'); assert.equal(p.get('offset'), '9'); assert.equal(p.get('count'), '10');
  assert.equal(p.get('search_lang'), 'jp'); assert.equal(p.get('ui_lang'), 'ja-JP');
  for (const page of [-1, 10, .1, '0']) assert.throws(() => Core.searchParams('test', page));
  for (const q of ['', ' ', 'a'.repeat(401), null]) assert.throws(() => Core.searchParams(q, 0));
});
test('normalization limits results and leaves HTML inert strings', () => {
  const value = Core.normalizeResults({query: {more_results_available: true}, web: {results: Array.from({length: 12}, () => ({title: '<script>bad()</script>', url: 'https://example.com/', description: '<img onerror=bad()>'}))}});
  assert.equal(value.results.length, 10); assert.equal(value.more, true); assert.equal(value.results[0].title, '<script>bad()</script>');
  assert.equal(Core.normalizeResults({query: {}, web: {results: [{url: 'javascript:bad()'}]}}).results.length, 0);
  assert.equal(Core.normalizeResults({query: {}}).results.length, 0); assert.throws(() => Core.normalizeResults({error: 'bad'}));
});
test('API key storage is restricted to trusted contexts before boot', async () => {
  const w = worker(async () => new Response('shadow css'));
  const response = await w.handle({type: 'FWS_BOOT'});
  assert.deepEqual(w.access, ['TRUSTED_CONTEXTS', 'TRUSTED_CONTEXTS']);
  assert.equal(response.css, 'shadow css'); assert.equal('apiKey' in response, false);
});
test('missing key does not make a request', async () => {
  let calls = 0; const w = worker(async () => { calls++; }); delete w.local.apiKey;
  assert.equal((await w.handle(request())).code, 'NO_KEY'); assert.equal(calls, 0);
});
test('unauthorized frames and foreign senders cannot search', async () => {
  const w = worker();
  await assert.rejects(w.handle(request(), {id: 'unit-extension', tab: {id: 7}, frameId: 0, url: 'https://other.test/'}));
  await assert.rejects(w.handle(request(), {id: 'another-extension', tab: {id: 7}, frameId: 0, url: 'https://example.com/'}));
  w.chrome.permissions.contains = async () => false; await assert.rejects(w.handle(request()));
});
test('worker fetch excludes cookies, referrer, redirects and uses only the fixed API', async () => {
  let observed; const w = worker(async (url, options) => { observed = {url, options}; return new Response(JSON.stringify({query: {more_results_available: true}, web: {results: [{url: 'https://example.org/', title: '日本語'}]}})); });
  const result = await w.handle(request()); assert.equal(result.ok, true); assert.equal(result.more, true);
  assert.match(observed.url, /^https:\/\/api.search.brave.com\/res\/v1\/web\/search\?/);
  assert.equal(new URL(observed.url).searchParams.get('q'), '日本語 検索');
  assert.equal(observed.options.credentials, 'omit'); assert.equal(observed.options.referrerPolicy, 'no-referrer');
  assert.equal(observed.options.redirect, 'error'); assert.equal(observed.options.headers['X-Subscription-Token'], 'unit-test-only');
  assert.equal('apiKey' in result, false);
});
for (const [status, code] of [[401, 'AUTH'], [403, 'AUTH'], [500, 'HTTP']]) {
  test(`HTTP ${status} returns actionable error and recovers`, async () => {
    let fail = true; const w = worker(async () => fail ? new Response('{}', {status}) : new Response(JSON.stringify({query: {}})));
    assert.equal((await w.handle(request())).code, code); fail = false; assert.equal((await w.handle(request())).ok, true);
  });
}
test('429 honors bounded Retry-After and suppresses immediate retries', async () => {
  let calls = 0; const w = worker(async () => { calls++; return new Response('{}', {status: 429, headers: {'Retry-After': '7'}}); });
  assert.match((await w.handle(request())).error, /7秒/); assert.equal((await w.handle(request())).code, 'RATE_LIMIT'); assert.equal(calls, 1);
});
test('network / malformed JSON recover on next request', async () => {
  let calls = 0; const w = worker(async () => { calls++; if (calls === 1) throw new Error('private provider text'); return new Response(calls === 2 ? 'invalid' : JSON.stringify({query: {}})); });
  const a = await w.handle(request()); assert.equal(a.code, 'NETWORK'); assert.equal(a.error.includes('private provider text'), false);
  assert.equal((await w.handle(request())).code, 'NETWORK'); assert.equal((await w.handle(request())).ok, true);
});
test('max page has no next page and no history is saved', async () => {
  const w = worker(async () => new Response(JSON.stringify({query: {more_results_available: true}, web: {results: []}})));
  assert.equal((await w.handle(request('last', 9))).more, false);
  assert.deepEqual(Object.keys(w.local).sort(), ['apiKey', 'sites']);
});
test('cancel aborts only the matching request and releases the job', async () => {
  let started; const start = new Promise(r => { started = r; });
  const w = worker((_url, options) => new Promise((_resolve, reject) => {
    started(); options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  const pending = w.handle(request()); await start;
  await w.handle({type: 'FWS_CANCEL', requestId: 'wrong'}); assert.equal(vm.runInContext('jobs.size', w.ctx), 1);
  await w.handle({type: 'FWS_CANCEL', requestId: 'request-1'});
  assert.equal((await pending).code, 'CANCELLED'); assert.equal(vm.runInContext('jobs.size', w.ctx), 0);
});
test('result is denied after site permission is removed during request', async () => {
  let release; const w = worker(() => new Promise(r => { release = r; }));
  const pending = w.handle(request()); while (!release) await new Promise(r => setImmediate(r));
  w.local.sites = []; release(new Response(JSON.stringify({query: {}})));
  assert.equal((await pending).code, 'DENIED');
});
test('dynamic registration is ISOLATED, document_start, all frames and restricted to the allowlist', async () => {
  const w = worker(); await vm.runInContext('ready', w.ctx);
  const registered = [];
  w.chrome.scripting.registerContentScripts = async specs => registered.push(...specs);
  await w.handle({type: 'FWS_SYNC'}, {id: 'unit-extension', url: 'chrome-extension://unit-extension/options.html', tab: {id: 2}});
  assert.equal(registered.length, 1);
  assert.equal(registered[0].runAt, 'document_start'); assert.equal(registered[0].world, 'ISOLATED');
  assert.equal(registered[0].allFrames, true); assert.equal(registered[0].matches.join(), 'https://example.com/*');
});
test('disallowed document cannot impersonate extension settings', async () => {
  const w = worker();
  await assert.rejects(w.handle({type: 'FWS_SYNC'}, {id: 'unit-extension', url: 'https://other.test/options.html'}));
});
async function routeFixture(frames, states, sites = ['https://example.com/*']) {
  const w = worker(); await vm.runInContext('ready', w.ctx); w.local.sites = sites;
  const toggles = [], closes = [];
  w.chrome.webNavigation.getAllFrames = async () => frames;
  w.chrome.tabs.sendMessage = async (_tabId, message, options) => {
    if (message.type === 'FWS_PROBE') return states[options.frameId];
    if (message.type === 'FWS_CLOSE') { closes.push(options.frameId); return {ok: true}; }
    if (message.type === 'FWS_TOGGLE') { toggles.push(options.frameId); return {ok: true}; }
  };
  return {...w, toggles, closes, toggle: () => vm.runInContext('toggle', w.ctx)(7)};
}
const topFrame = {frameId: 0, parentFrameId: -1, url: 'https://example.com/'};
const childFrame = {frameId: 2, parentFrameId: 0, url: 'https://child.test/'};
test('normal pages toggle the top frame and close stale child panels', async () => {
  const w = await routeFixture([topFrame, childFrame], {0:{fullscreen:false,open:false},2:{fullscreen:false,open:true}}, ['https://example.com/*','https://child.test/*']);
  assert.equal((await w.toggle()).ok,true);assert.deepEqual(w.toggles,[0]);assert.deepEqual(w.closes,[2]);
});
test('fullscreen iframe selects the deepest authorized fullscreen document', async () => {
  const w = await routeFixture([topFrame, childFrame], {0:{fullscreen:true,blocked:'iframe'},2:{fullscreen:true,blocked:'',open:false}}, ['https://example.com/*','https://child.test/*']);
  assert.equal((await w.toggle()).ok,true);assert.deepEqual(w.toggles,[2]);
});
test('unauthorized fullscreen iframe is rejected with a reason, without a toggle', async () => {
  const w = await routeFixture([topFrame, childFrame], {0:{fullscreen:true,blocked:'iframe permission required'},2:{fullscreen:true}});
  const reply=await w.toggle();assert.equal(reply.ok,false);assert.match(reply.error,/iframe/);assert.deepEqual(w.toggles,[]);
});
test('fullscreen on a prohibited top site is never delegated to a permitted child', async () => {
  const w = await routeFixture([{...topFrame,url:'https://other.test/'},childFrame], {2:{fullscreen:true}}, ['https://child.test/*']);
  assert.equal((await w.toggle()).ok,false);assert.deepEqual(w.toggles,[]);
});
test('opaque sandbox origins cannot boot or search even when their URL host is allowed', async () => {
  const w = worker();
  const sender = {id:'unit-extension',tab:{id:7},frameId:2,url:'https://example.com/frame',origin:'null'};
  await assert.rejects(w.handle({type:'FWS_BOOT'},sender));
  await assert.rejects(w.handle(request(),sender));
});
