/* Shared validation. Loaded only in extension / ISOLATED contexts. */
(() => {
  'use strict';
  function originPattern(value) {
    const url = new URL(String(value).trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hostname.includes('*')) {
      throw new Error('http / https の正確なサイトURLを入力してください。');
    }
    // Chrome match patterns do not restrict ports. Keep this explicit in the UI.
    return `${url.protocol}//${url.hostname}/*`;
  }
  function permitted(url, patterns = []) {
    try { return patterns.includes(originPattern(url)); } catch { return false; }
  }
  function safeURL(value) {
    try {
      const u = new URL(value);
      return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : null;
    } catch { return null; }
  }
  function searchParams(query, page) {
    if (typeof query !== 'string' || !query.trim() || query.trim().length > 400) {
      throw new Error('検索語は1〜400文字で入力してください。');
    }
    if (!Number.isInteger(page) || page < 0 || page > 9) throw new Error('ページ番号が不正です。');
    return new URLSearchParams({q: query.trim(), count: '10', offset: String(page),
      search_lang: 'jp', ui_lang: 'ja-JP', country: 'JP', text_decorations: 'false', safesearch: 'moderate'});
  }
  function normalizeResults(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.web?.results)) {
      if (data && typeof data === 'object' && !data.web && data.query) return {results: [], more: false};
      throw new Error('検索APIの応答形式が不正です。');
    }
    const results = data.web.results.slice(0, 10).flatMap(r => {
      const url = safeURL(r?.url);
      return url ? [{url, title: String(r.title || url).slice(0, 600), description: String(r.description || '').slice(0, 2000)}] : [];
    });
    return {results, more: data.query?.more_results_available === true};
  }
  globalThis.FWSCore = Object.freeze({originPattern, permitted, safeURL, searchParams, normalizeResults});
})();
