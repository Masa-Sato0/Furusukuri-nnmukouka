(() => {
  'use strict';
  if (globalThis.origin === 'null') return;
  const SLOT = '__fullscreenWebSearchV1';
  if (globalThis[SLOT]) { globalThis[SLOT].refresh(); return; }
  const Core = globalThis.FWSCore;
  const lifetime = new AbortController();
  const state = {open: false, host: null, shadow: null, ui: null, css: '', ready: false,
    disposed: false, sequence: 0, requestId: null, page: 0, query: '', busy: false, more: false,
    previousFocus: null, scheduled: false, checking: false, relocations: [], lastURL: location.href};
  const observer = new MutationObserver(() => schedulePlacement());
  const send = message => chrome.runtime.sendMessage(message);
  function tell(error) { send({type: 'FWS_REPORT', error}).catch(() => {}); }
  function fullscreenTarget() {
    let target = document.fullscreenElement;
    while (target?.shadowRoot?.fullscreenElement) target = target.shadowRoot.fullscreenElement;
    return target;
  }
  function blockedReason(target = fullscreenTarget()) {
    if (!target) return '';
    if (target.localName === 'iframe') return '全画面のiframe内へ配置できません。子フレームのサイト許可とFullscreen APIの利用を確認してください。未許可・サンドボックス化・アクセス不能のフレームには介入しません。';
    if (['video', 'audio', 'canvas', 'img', 'input', 'textarea', 'select', 'embed', 'object'].includes(target.localName)) {
      return `${target.localName}要素自体の全画面には検索UIを配置できません。サイトが対応している場合は、その要素を含むコンテナーを全画面表示してください。`;
    }
    return '';
  }
  function node(tag, text, attributes = {}) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, value);
    return el;
  }
  function listen(target, type, fn, options = {}) { target.addEventListener(type, fn, {...options, signal: lifetime.signal}); }
  function build() {
    if (state.host) return;
    const host = node('div');
    host.dataset.fullscreenWebSearch = 'panel';
    host.setAttribute('popover', 'manual');
    const rules = {all: 'initial', position: 'fixed', inset: '0 0 auto auto', display: 'block',
      width: 'min(480px, 100vw)', height: '100dvh', 'max-height': '100dvh', 'max-width': '100vw',
      margin: '0', padding: '0', border: '0', 'box-sizing': 'border-box', 'z-index': '2147483647',
      visibility: 'visible', opacity: '1', transform: 'none', 'pointer-events': 'auto',
      'color-scheme': 'dark', direction: 'ltr'};
    for (const [key, value] of Object.entries(rules)) host.style.setProperty(key, value, 'important');
    const shadow = host.attachShadow({mode: 'open'});
    const style = node('style', state.css);
    const panel = node('section', undefined, {class: 'panel', role: 'dialog', 'aria-label': 'Web検索', lang: 'ja'});
    const header = node('header');
    const heading = node('div');
    heading.append(node('h2', 'Web検索'), node('span', 'BRAVE SEARCH', {class: 'eyebrow'}));
    const closeButton = node('button', '×', {type: 'button', class: 'close', 'aria-label': '検索パネルを閉じる'});
    closeButton.addEventListener('click', () => close());
    header.append(heading, closeButton);
    const mode = node('p', '', {class: 'mode'});
    const form = node('form', undefined, {role: 'search'});
    const label = node('label', '検索キーワード', {for: 'fws-query'});
    const fieldRow = node('div', undefined, {class: 'field-row'});
    const input = node('input', undefined, {id: 'fws-query', type: 'search', placeholder: 'Webを検索', maxlength: '400',
      autocomplete: 'off', spellcheck: 'false', required: '', 'aria-label': '検索キーワード'});
    const submit = node('button', '検索', {type: 'submit', class: 'primary'});
    fieldRow.append(input, submit); form.append(label, fieldRow);
    form.addEventListener('submit', event => { event.preventDefault(); runSearch(input.value.trim(), 0); });
    const status = node('p', '検索語を入力してください。', {role: 'status', 'aria-live': 'polite', class: 'status'});
    const spinner = node('span', undefined, {class: 'spinner', 'aria-hidden': 'true'}); spinner.hidden = true;
    const results = node('ol', undefined, {class: 'results', 'aria-label': '検索結果'});
    const scroll = node('div', undefined, {class: 'scroll'}); scroll.append(spinner, status, results);
    const pagination = node('nav', undefined, {class: 'pagination', 'aria-label': '検索結果のページ'});
    const prev = node('button', '← 前へ', {type: 'button'});
    const pageLabel = node('span', '1 / 最大10ページ');
    const next = node('button', '次へ →', {type: 'button'});
    prev.disabled = true; next.disabled = true;
    prev.addEventListener('click', () => runSearch(state.query, state.page - 1));
    next.addEventListener('click', () => runSearch(state.query, state.page + 1));
    pagination.append(prev, pageLabel, next);
    const footer = node('footer');
    const note = node('p', 'リンクは別タブで開きます。全画面表示が解除される場合があります。検索履歴は保存しません。');
    const options = node('button', '設定 / APIキー', {type: 'button', class: 'text-button'});
    options.addEventListener('click', () => send({type: 'FWS_OPTIONS'}).catch(() => { if (state.open) status.textContent = '設定を開けません。拡張機能メニューから開いてください。'; }));
    footer.append(note, options);
    panel.append(header, mode, form, scroll, pagination, footer); shadow.append(style, panel);
    for (const type of ['keydown', 'keyup', 'click', 'pointerdown', 'pointerup', 'wheel']) {
      shadow.addEventListener(type, event => event.stopPropagation());
    }
    state.host = host; state.shadow = shadow;
    state.ui = {panel, input, submit, results, status, spinner, prev, next, pageLabel, mode, scroll};
  }
  function observe() {
    observer.disconnect();
    if (!state.open) return;
    observer.observe(document, {childList: true, subtree: true});
    let target = fullscreenTarget();
    while (target) {
      const root = target.getRootNode();
      if (!(root instanceof ShadowRoot)) break;
      observer.observe(root, {childList: true, subtree: true});
      target = root.host;
    }
  }
  function place() {
    if (!state.open || state.disposed) return;
    const fullscreen = fullscreenTarget();
    const reason = blockedReason(fullscreen);
    if (reason) { close(false); tell(reason); return; }
    const parent = fullscreen || document.body;
    if (!parent?.isConnected) return;
    try {
      if (state.host.parentNode !== parent) {
        const now = Date.now();
        state.relocations = state.relocations.filter(time => now - time < 2000);
        if (state.relocations.length >= 8) {
          close(false); tell('ページが検索UIを繰り返し削除しています。競合を避けるため表示を中止しました。'); return;
        }
        state.relocations.push(now);
        const focused = state.shadow.activeElement;
        observer.disconnect();
        parent.append(state.host);
        if (!state.host.matches(':popover-open')) state.host.showPopover();
        focused?.focus({preventScroll: true});
        observe();
      }
      if (!state.host.matches(':popover-open')) state.host.showPopover();
      state.ui.mode.textContent = fullscreen ? 'Fullscreen API：全画面表示の中に配置' : '通常ページ / ブラウザ全画面：ページ内に配置';
      if (!state.checking) {
        state.checking = true;
        requestAnimationFrame(() => {
          state.checking = false;
          if (!state.open) return;
          const rect = state.ui.panel.getBoundingClientRect();
          if (!rect.width || !rect.height || !state.host.isConnected) {
            close(false); tell('検索UIを表示できません。アクセス不能のShadow DOM、非表示・inertな祖先要素、ページの描画制限を確認してください。');
          }
        });
      }
    } catch {
      close(false); tell('このページの全画面要素内に検索UIを配置できません。ページの制約を回避せず処理を中止しました。');
    }
  }
  function schedulePlacement() {
    if (!state.open || state.scheduled) return;
    state.scheduled = true;
    queueMicrotask(() => { state.scheduled = false; place(); });
  }
  function setBusy(busy) {
    state.busy = busy;
    if (!state.ui) return;
    state.ui.results.setAttribute('aria-busy', String(busy));
    state.ui.spinner.hidden = !busy;
    state.ui.prev.disabled = busy || !state.query || state.page === 0;
    state.ui.next.disabled = busy || !state.more || state.page === 9;
  }
  function cancel() {
    state.sequence++;
    if (state.requestId) send({type: 'FWS_CANCEL', requestId: state.requestId}).catch(() => {});
    state.requestId = null;
    setBusy(false);
  }
  async function copyURL(url, button) {
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(url); button.textContent = 'コピー済み'; return; }
    } catch {}
    if (!state.open || !button.isConnected) return;
    button.parentElement.querySelector('.copy-fallback')?.remove();
    const field = node('textarea', url, {'aria-label': 'コピーするURL', readonly: '', class: 'copy-fallback'});
    button.after(field); field.focus(); field.select();
    try {
      if (document.execCommand('copy')) { field.remove(); button.textContent = 'コピー済み'; button.focus(); return; }
    } catch {}
    if (state.ui) state.ui.status.textContent = '自動コピーできません。表示されたURLを選択し、Ctrl+Cでコピーしてください。';
  }
  async function runSearch(query, page) {
    if (!state.open) return;
    try { Core.searchParams(query, page); } catch (e) { state.ui.status.textContent = e.message; return; }
    cancel();
    const sequence = state.sequence;
    state.requestId = crypto.randomUUID();
    state.query = query; state.page = page; state.more = false;
    state.ui.results.replaceChildren(); state.ui.status.textContent = '検索しています…';
    state.ui.pageLabel.textContent = `${page + 1} / 最大10ページ`; setBusy(true);
    try {
      const response = await send({type: 'FWS_SEARCH', query, page, requestId: state.requestId});
      if (sequence !== state.sequence || !state.open) return;
      if (!response?.ok) { state.ui.status.textContent = response?.error || '検索できません。再試行してください。'; return; }
      state.more = response.more === true;
      for (const result of response.results.slice(0, 10)) {
        const url = Core.safeURL(result.url); if (!url) continue;
        const item = node('li', undefined, {class: 'result'});
        const anchor = node('a', result.title, {href: url, target: '_blank', rel: 'noopener noreferrer', referrerpolicy: 'no-referrer'});
        const title = node('h3'); title.append(anchor);
        const address = node('p', url, {class: 'url'});
        const description = node('p', result.description, {class: 'description'});
        const copy = node('button', 'URLをコピー', {type: 'button', class: 'copy', 'aria-label': `${result.title}のURLをコピー`});
        copy.addEventListener('click', () => copyURL(url, copy));
        item.append(title, address, description, copy); state.ui.results.append(item);
      }
      state.ui.status.textContent = response.results.length ? `${page + 1}ページ目・${state.ui.results.children.length}件` : '結果がありません。検索語を変えてください。';
      state.ui.scroll.scrollTop = 0;
    } catch { if (sequence === state.sequence && state.open) state.ui.status.textContent = '拡張機能に接続できません。ページを再読み込みしてください。'; }
    finally {
      if (sequence === state.sequence) { state.requestId = null; setBusy(false); }
    }
  }
  function close(restoreFocus = true) {
    if (!state.open) return;
    state.open = false; observer.disconnect(); cancel();
    try { if (state.host?.matches(':popover-open')) state.host.hidePopover(); } catch {}
    state.host?.remove();
    state.host = null; state.shadow = null; state.ui = null; state.query = ''; state.page = 0; state.more = false;
    if (restoreFocus && state.previousFocus?.isConnected && typeof state.previousFocus.focus === 'function') {
      state.previousFocus.focus({preventScroll: true});
    }
    state.previousFocus = null;
  }
  function open() {
    const reason = blockedReason();
    if (reason) return {ok: false, error: reason};
    if (!state.ready || !document.body) return {ok: false, error: 'ページの準備中です。読み込み後にもう一度お試しください。'};
    state.previousFocus = document.activeElement;
    state.relocations = [];
    build(); state.open = true; observe(); place();
    if (!state.open) return {ok: false, error: '検索UIを配置できません。拡張機能の状態表示を確認してください。'};
    state.ui.input.focus({preventScroll: true});
    if (state.shadow.activeElement !== state.ui.input) {
      close(false);
      return {ok: false, error: '入力欄にフォーカスできません。inert属性など、ページの操作制限を確認してください。'};
    }
    return {ok: true, open: true};
  }
  function routeChanged() {
    if (state.lastURL !== location.href) {
      state.lastURL = location.href;
      if (state.open) close(false);
    }
    schedulePlacement();
  }
  function dispose() {
    close(false); state.disposed = true; observer.disconnect(); lifetime.abort();
    chrome.runtime.onMessage.removeListener(onMessage);
    delete globalThis[SLOT];
  }
  function onMessage(message, _sender, respond) {
    switch (message?.type) {
      case 'FWS_PROBE': respond({fullscreen: Boolean(document.fullscreenElement), blocked: blockedReason(), open: state.open}); break;
      case 'FWS_TOGGLE':
        if (state.open) { close(); respond({ok: true, open: false}); }
        else respond(open()); break;
      case 'FWS_CLOSE': close(false); respond({ok: true}); break;
      case 'FWS_ROUTE_CHANGED': routeChanged(); respond({ok: true}); break;
      case 'FWS_DISABLE': dispose(); respond({ok: true}); break;
      default: return false;
    }
    return false;
  }
  globalThis[SLOT] = {refresh: schedulePlacement, dispose};
  chrome.runtime.onMessage.addListener(onMessage);
  listen(document, 'fullscreenchange', schedulePlacement, {capture: true});
  listen(document, 'DOMContentLoaded', schedulePlacement, {once: true});
  listen(window, 'popstate', routeChanged); listen(window, 'hashchange', routeChanged);
  listen(window, 'pageshow', () => { state.lastURL = location.href; schedulePlacement(); });
  listen(window, 'pagehide', () => close(false));
  listen(document, 'keydown', event => {
    if (!state.open) return;
    if (event.key === 'Escape' && !event.isComposing) {
      event.preventDefault(); event.stopImmediatePropagation(); close();
    } else if (event.key === 'Tab') {
      const items = [...state.shadow.querySelectorAll('button:not(:disabled), input, a[href], textarea')].filter(el => !el.hidden && el.getClientRects().length);
      const index = items.indexOf(state.shadow.activeElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && index === items.length - 1) { event.preventDefault(); items[0]?.focus(); }
    }
  }, {capture: true});
  // Do not return a Promise to executeScript; boot may await worker initialization.
  send({type: 'FWS_BOOT'}).then(response => {
    if (state.disposed) return;
    if (!response?.ok || typeof response.css !== 'string') { dispose(); return; }
    state.css = response.css; state.ready = true;
  }).catch(dispose);
})();
