// ==UserScript==
// @name         X Mutual Follow Badge
// @namespace    https://lichuanyang.top/
// @version      1.8
// @description  Mark your follow relationship with every tweet author on X: blue check for mutual follows, green check when you don't follow them, red cross when they never followed back.
// @author       流沙 (Liusha)
// @match        https://x.com/*
// @match        https://twitter.com/*
// @icon         https://abs.twimg.com/favicons/twitter.3.ico
// @homepageURL  https://github.com/lcy362/monkey-scripts
// @supportURL   https://github.com/lcy362/monkey-scripts/issues
// @grant        GM_addStyle
// @grant        unsafeWindow
// @run-at       document-start
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  /* ============ 可调参数 ============ */
  const CONFIG = {
    showUnfollowed: true,               // 是否显示「双方互不关注」的绿勾，关掉可减少干扰
    cacheTTL: 6 * 60 * 60 * 1000,       // 关注关系缓存时长
    errorTTL: 10 * 60 * 1000,           // 请求失败后的冷却时长（期间不重试）
    concurrency: 2,                     // 并发请求数
    minInterval: 400,                   // 两次接口请求的最小间隔（毫秒）
    rateLimitPause: 2 * 60 * 1000,      // 被 429 限流后暂停时长
  };

  const DEBUG = false;
  const CACHE_KEY = 'xmb:relations:v1';
  const QID_KEY = 'xmb:queryids:v1';

  // 抓不到真实 Bearer 时的兜底值（X 网页端公开的默认 Bearer）
  const BEARER_FALLBACK = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
  // queryId 兜底值，仅在前面的自动嗅探/扫描都失败时才会用到，失效会自动丢弃
  const QID_FALLBACKS = ['sLVLhk0bGj3MVFEKTdax1w', 'G3KGOASz96M-Qu0nwmGXNg'];

  const FEATURES = {
    hidden_profile_subscriptions_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    subscriptions_verification_info_is_identity_verified_enabled: true,
    subscriptions_verification_info_verified_since_enabled: true,
    highlights_tweets_tab_ui_enabled: true,
    responsive_web_twitter_article_notes_tab_enabled: true,
    subscriptions_feature_can_gift_premium: true,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true,
  };

  const HANDLE_RE = /^\/([A-Za-z0-9_]{1,15})$/;
  const RESERVED = new Set([
    'home', 'explore', 'notifications', 'messages', 'i', 'search', 'settings',
    'compose', 'login', 'signup', 'tos', 'privacy', 'hashtag',
  ]);

  // 文案兜底：优先取 X 自己的语言包，取不到才用这里
  const BUILTIN_MESSAGES = {
    zh: { follow: '关注', following: '正在关注', followsYou: '关注了你', followBack: '回关' },
    'zh-hant': { follow: '追蹤', following: '正在追蹤', followsYou: '追蹤了你', followBack: '回追' },
    ja: { follow: 'フォロー', following: 'フォロー中', followsYou: 'あなたをフォローしています', followBack: 'フォローする' },
    en: { follow: 'Follow', following: 'Following', followsYou: 'Follows you', followBack: 'Follow back' },
  };

  const pageWin = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
  const origin = location.origin;

  const debug = (...args) => { if (DEBUG) console.log('[互浇助手]', ...args); };

  /* ============ 本地缓存 ============ */
  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 忽略 */ }
  }

  const relations = readJSON(CACHE_KEY, {});
  const queryIds = readJSON(QID_KEY, {});
  let persistTimer = 0;

  function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const cutoff = Date.now() - CONFIG.cacheTTL;
      Object.keys(relations).forEach(k => {
        if (!relations[k] || relations[k].t < cutoff) delete relations[k];
      });
      writeJSON(CACHE_KEY, relations);
    }, 500);
  }

  function saveRelation(handle, rel) {
    relations[handle] = { f: !!rel.following, b: !!rel.followedBy, t: Date.now() };
    persist();
  }

  function saveError(handle) {
    relations[handle] = { err: 1, t: Date.now() };
    persist();
  }

  function readRelation(handle) {
    const item = relations[handle];
    if (!item || item.err) return null;
    return Date.now() - item.t > CONFIG.cacheTTL ? null : item;
  }

  function shouldRequest(handle) {
    const item = relations[handle];
    if (!item) return true;
    const age = Date.now() - item.t;
    return item.err ? age > CONFIG.errorTTL : age > CONFIG.cacheTTL;
  }

  /* ============ 文案：优先取 X 自己的语言包 ============ */
  const MSG_KEY = 'xmb:messages:v1';
  const URL_KEY = 'xmb:i18nurls:v1';
  const MSG_TTL = 7 * 24 * 60 * 60 * 1000;   // 语言包解析结果缓存一周

  // X 网页版的文案 key，按可能性从高到低排列（不同版本命名有差异）
  const MSG_KEYS = {
    follow: ['follow', 'Follow'],
    following: ['following', 'Following'],
    followsYou: ['follows_you', 'followsYou', 'Follows you'],
    followBack: ['follow_back', 'followBack', 'Follow back'],
  };

  const savedUrls = readJSON(URL_KEY, []);
  let i18nUrls = Array.isArray(savedUrls) ? savedUrls : [];
  let bundleMessages = null;   // 从语言包里解析出来的文案（非空才代表真的取到了）
  let messages = null;
  let messagesPromise = null;
  let reloadTimer = 0;

  function currentLang() {
    const html = document.documentElement;
    const lang = (html && html.getAttribute('lang')) || navigator.language || 'en';
    return String(lang).toLowerCase();
  }

  function langBucket(lang) {
    const l = String(lang || 'en').toLowerCase();
    if (l.indexOf('zh') === 0) return /hant|tw|hk|mo/.test(l) ? 'zh-hant' : 'zh';
    if (l.indexOf('ja') === 0) return 'ja';
    return 'en';
  }

  function langMessages(lang) {
    return BUILTIN_MESSAGES[langBucket(lang)] || BUILTIN_MESSAGES.en;
  }

  function sameLang(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.split('-')[0] !== b.split('-')[0]) return false;
    // 同主干但都带地区/字形变体时视为不同语言（zh-Hans ≠ zh-Hant）
    return a.indexOf('-') === -1 || b.indexOf('-') === -1;
  }

  function urlLang(url) {
    // 形如 .../i18n/en.2a4a2baa.js 或 .../i18n-rweb/zh.322c7be4.js，取第一个点之前的语言名
    const m = String(url).match(/\/i18n[^/]*\/([^/?#.]+)[^/?#]*\.js/i);
    return m ? m[1].toLowerCase() : '';
  }

  function rememberI18nUrl(url) {
    if (!url || url.indexOf('/i18n') === -1) return false;
    if (i18nUrls.indexOf(url) !== -1) return false;
    i18nUrls = [url].concat(i18nUrls).slice(0, 8);
    writeJSON(URL_KEY, i18nUrls);
    return true;
  }

  function collectI18nUrls() {
    const nodes = document.querySelectorAll('link[href*="/i18n"], script[src*="/i18n"]');
    for (let i = 0; i < nodes.length; i += 1) {
      rememberI18nUrl(nodes[i].href || nodes[i].src);
    }
  }

  // 从语言包文本里抠出 "key":"值"，不用管它是 JSON 还是 window.xxx={...} 的 JS
  function grabMessage(text, key) {
    const safe = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('["\']?' + safe + '["\']?\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"');
    const m = text.match(re);
    if (!m) return '';
    try {
      return JSON.parse('"' + m[1] + '"');
    } catch (e) {
      return m[1];
    }
  }

  function extractMessages(text) {
    const out = {};
    let hit = 0;
    Object.keys(MSG_KEYS).forEach(name => {
      const keys = MSG_KEYS[name];
      for (let i = 0; i < keys.length; i += 1) {
        const value = grabMessage(text, keys[i]).trim();
        if (value) {
          out[name] = value;
          hit += 1;
          break;
        }
      }
    });
    return hit ? out : null;
  }

  // 界面上已经渲染出来的原生文案，作为语言包解析失败时的兜底
  function domMessages() {
    const out = {};
    const pick = el => (el && el.textContent ? el.textContent.trim() : '');
    const followsYou = pick(document.querySelector('[data-testid="userFollowIndicator"]'));
    if (followsYou && followsYou.length < 30) out.followsYou = followsYou;
    const follow = pick(document.querySelector('[data-testid$="-follow"]'));
    if (follow && follow.length < 30) out.follow = follow;
    const following = pick(document.querySelector('[data-testid$="-unfollow"]'));
    if (following && following.length < 30) out.following = following;
    return out;
  }

  async function fetchI18nMessages(lang) {
    collectI18nUrls();
    const candidates = i18nUrls.filter(url => {
      const ul = urlLang(url);
      return !ul || sameLang(ul, lang);
    });
    let merged = null;
    for (let i = 0; i < candidates.length; i += 1) {
      try {
        const res = await pageWin.fetch(candidates[i]);
        if (!res.ok) continue;
        const parsed = extractMessages(await res.text());
        if (!parsed) continue;
        merged = Object.assign(merged || {}, parsed);
        if (merged.follow && merged.following && merged.followsYou) break;
      } catch (e) { /* 换下一个 */ }
    }
    return merged;
  }

  async function loadMessages() {
    const lang = currentLang();
    const cache = readJSON(MSG_KEY, {});
    const entry = cache[lang];
    const builtin = langMessages(lang);
    if (entry && entry.m && entry.m.followsYou && Date.now() - (entry.t || 0) < MSG_TTL) {
      bundleMessages = entry.m;
      return Object.assign({}, builtin, entry.m);
    }
    const fromBundle = await fetchI18nMessages(lang);
    const merged = Object.assign({}, builtin, domMessages(), fromBundle || {});
    if (fromBundle) {
      bundleMessages = fromBundle;
      cache[lang] = { m: merged, t: Date.now() };
      writeJSON(MSG_KEY, cache);
    }
    return merged;
  }

  function ensureMessages(force) {
    if (force) messagesPromise = null;
    if (!messagesPromise) {
      messagesPromise = loadMessages().then(result => {
        messages = result;
        refreshBadges();
        return result;
      }, () => {
        messages = messages || langMessages(currentLang());
      });
    }
    return messagesPromise;
  }

  function scheduleMessagesReload() {
    if (bundleMessages) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => { ensureMessages(true); }, 800);
  }

  // 色块本身不显示文字，原生文案放进悬浮提示
  function titleFor(rel) {
    const m = messages || langMessages(currentLang());
    if (rel.f && rel.b) return m.following + ' · ' + m.followsYou;
    if (!rel.f && rel.b) return m.followBack ? m.followsYou + ' · ' + m.followBack : m.followsYou;
    if (rel.f) return m.following;
    return m.follow;
  }

  function refreshBadges() {
    const badges = document.querySelectorAll('.xmb-badge');
    for (let i = 0; i < badges.length; i += 1) {
      const raw = badges[i].dataset.rel || '';
      if (raw.length === 2) {
        applyVisual(badges[i], { f: raw[0] === '1', b: raw[1] === '1' });
      }
    }
  }

  // 先用内置文案占位，语言包解析完成后 refreshBadges() 会自动改写
  messages = Object.assign({}, langMessages(currentLang()));

  /* ============ 嗅探主页自身请求（Bearer / queryId） ============ */
  let bearer = null;
  let internalRequest = false;

  function headerValue(headers, name) {
    if (!headers) return '';
    try {
      if (typeof headers.get === 'function') return headers.get(name) || '';
      if (Array.isArray(headers)) {
        const hit = headers.find(pair => String(pair[0]).toLowerCase() === name);
        return hit ? String(hit[1]) : '';
      }
      const key = Object.keys(headers).find(k => k.toLowerCase() === name);
      return key ? String(headers[key]) : '';
    } catch (e) {
      return '';
    }
  }

  function sniffRequest(url, init) {
    if (internalRequest || !url) return;
    if (url.indexOf('/i18n') !== -1 && rememberI18nUrl(url)) scheduleMessagesReload();
    if (url.indexOf('/i/api/graphql/') === -1) return;
    const m = url.match(/\/i\/api\/graphql\/([^/]+)\/([A-Za-z0-9_]+)/);
    if (!m) return;
    const qid = m[1];
    const op = m[2];
    if (queryIds[op] !== qid) {
      queryIds[op] = qid;
      writeJSON(QID_KEY, queryIds);
      debug('捕获 queryId', op, qid);
    }
    if (!bearer) {
      const auth = headerValue(init && init.headers, 'authorization');
      if (auth && auth.indexOf('Bearer ') === 0 && auth.length > 30) {
        bearer = auth.slice(7);
        debug('捕获 bearer');
      }
    }
  }

  // X 自己请求 UserByScreenName（比如你悬停用户名、点开主页）时，顺手把结果收进缓存
  function harvest(data, url) {
    try {
      const handle = parsedVariables(url).screen_name;
      const result = data && data.data && data.data.user && data.data.user.result;
      const rel = pickRelation(result);
      if (handle && rel) {
        const key = String(handle).toLowerCase();
        saveRelation(key, rel);
        paint(key);
      }
    } catch (e) { /* 忽略 */ }
  }

  function parsedVariables(url) {
    try {
      const qs = url.split('?')[1] || '';
      const raw = new URLSearchParams(qs).get('variables');
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  (function hookFetch() {
    const origFetch = pageWin.fetch;
    if (typeof origFetch !== 'function') return;
    pageWin.fetch = function (input, init) {
      let url = '';
      try {
        url = typeof input === 'string' ? input : (input && input.url) || '';
        sniffRequest(url, init);
      } catch (e) { /* 忽略 */ }
      const p = origFetch.apply(pageWin, arguments);
      if (url && url.indexOf('UserByScreenName') !== -1 && !internalRequest) {
        try {
          p.then(res => {
            try {
              res.clone().json().then(data => harvest(data, url)).catch(() => {});
            } catch (e) { /* 忽略 */ }
          }).catch(() => {});
        } catch (e) { /* 忽略 */ }
      }
      return p;
    };
  })();

  /* ============ 关注关系接口 ============ */
  function pickRelation(userResult) {
    if (!userResult) return null;
    const rp = userResult.relationship_perspectives || {};
    const legacy = userResult.legacy || {};
    const following = typeof rp.following === 'boolean' ? rp.following
      : (typeof legacy.following === 'boolean' ? legacy.following : undefined);
    const followedBy = typeof rp.followed_by === 'boolean' ? rp.followed_by
      : (typeof legacy.followed_by === 'boolean' ? legacy.followed_by : undefined);
    if (following === undefined && followedBy === undefined) return null;
    return { following: !!following, followedBy: !!followedBy };
  }

  function csrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
    return m ? m[1] : '';
  }

  function matchQueryId(text) {
    const patterns = [
      /queryId:"([A-Za-z0-9_-]{15,})",operationName:"UserByScreenName"/,
      /operationName:"UserByScreenName",queryId:"([A-Za-z0-9_-]{15,})"/,
    ];
    for (let i = 0; i < patterns.length; i += 1) {
      const m = text.match(patterns[i]);
      if (m) return m[1];
    }
    return null;
  }

  let qidPromise = null;

  async function discoverQueryId() {
    // 1) 扫描页面已有的脚本包，找 UserByScreenName 的 queryId
    const srcs = Array.prototype.map.call(
      document.querySelectorAll('script[src]'),
      s => s.src
    ).filter(u => u && u.indexOf('/responsive-web/client-web/') !== -1).slice(0, 8);

    for (let i = 0; i < srcs.length; i += 1) {
      try {
        const text = await (await pageWin.fetch(srcs[i])).text();
        const found = matchQueryId(text);
        if (found) {
          queryIds.UserByScreenName = found;
          writeJSON(QID_KEY, queryIds);
          debug('扫描到 queryId', found);
          return found;
        }
      } catch (e) { /* 换下一个 */ }
    }

    // 2) 兜底
    for (let i = 0; i < QID_FALLBACKS.length; i += 1) {
      if (QID_FALLBACKS[i]) {
        queryIds.UserByScreenName = QID_FALLBACKS[i];
        return QID_FALLBACKS[i];
      }
    }
    throw new Error('未找到 UserByScreenName 的 queryId');
  }

  function ensureQueryId() {
    if (queryIds.UserByScreenName) return Promise.resolve(queryIds.UserByScreenName);
    if (!qidPromise) {
      qidPromise = discoverQueryId().then(id => { qidPromise = null; return id; },
        err => { qidPromise = null; throw err; });
    }
    return qidPromise;
  }

  function invalidateQueryId() {
    delete queryIds.UserByScreenName;
    writeJSON(QID_KEY, queryIds);
  }

  // 接口偶尔会新增必填 feature，报错里会列出缺失项，这里自动补齐后重试一次
  const FEATURES_KEY = 'xmb:features:v1';
  Object.assign(FEATURES, readJSON(FEATURES_KEY, {}));

  function absorbMissingFeatures(body) {
    let changed = false;
    try {
      ((body && body.errors) || []).forEach(e => {
        const m = String(e.message || '').match(/cannot be null:\s*([A-Za-z0-9_,\s]+)/);
        if (!m) return;
        m[1].split(',').forEach(name => {
          const key = name.trim();
          if (key && key !== 'null') {
            FEATURES[key] = true;
            changed = true;
          }
        });
      });
      if (changed) writeJSON(FEATURES_KEY, FEATURES);
    } catch (e) { /* 忽略 */ }
    return changed;
  }

  async function fetchRelation(handle, retried) {
    const qid = await ensureQueryId();
    const variables = { screen_name: handle, withSafetyModeUserFields: true };
    const fieldToggles = { withAuxiliaryUserLabels: true };
    const url = origin + '/i/api/graphql/' + qid + '/UserByScreenName'
      + '?variables=' + encodeURIComponent(JSON.stringify(variables))
      + '&features=' + encodeURIComponent(JSON.stringify(FEATURES))
      + '&fieldToggles=' + encodeURIComponent(JSON.stringify(fieldToggles));

    internalRequest = true;
    let res;
    try {
      res = await pageWin.fetch(url, {
        credentials: 'include',
        headers: {
          authorization: 'Bearer ' + (bearer || BEARER_FALLBACK),
          'x-csrf-token': csrfToken(),
          'x-twitter-active-user': 'yes',
          'x-twitter-auth-type': 'OAuth2Session',
          'x-twitter-client-language': 'zh-cn',
          'content-type': 'application/json',
        },
      });
    } finally {
      internalRequest = false;
    }

    if (res.status === 429) {
      pausedUntil = Date.now() + CONFIG.rateLimitPause;
      throw new Error('被限流');
    }
    if (res.status === 400 && !retried) {
      const body = await res.json().catch(() => null);
      if (absorbMissingFeatures(body)) return fetchRelation(handle, true);
      invalidateQueryId();
      throw new Error('接口返回 400（queryId 可能已失效）');
    }
    if (res.status === 404 || res.status === 400) {
      invalidateQueryId();
      throw new Error('接口返回 ' + res.status + '（queryId 可能已失效）');
    }
    if (!res.ok) throw new Error('接口返回 ' + res.status);

    const data = await res.json();
    const rel = pickRelation(data && data.data && data.data.user && data.data.user.result);
    if (!rel) throw new Error('账号不可用或缺少关注关系字段');
    return rel;
  }

  /* ============ 请求队列 ============ */
  const waiting = new Map();   // handle -> Set<article>
  const queue = [];
  let active = 0;
  let lastStart = 0;
  let pausedUntil = 0;
  let pumpTimer = 0;

  function enqueue(handle) {
    if (queue.indexOf(handle) === -1) queue.push(handle);
    pump();
  }

  function pump() {
    if (pausedUntil > Date.now()) {
      if (!pumpTimer) {
        pumpTimer = setTimeout(() => { pumpTimer = 0; pump(); }, pausedUntil - Date.now());
      }
      return;
    }
    while (active < CONFIG.concurrency && queue.length) {
      const handle = queue.shift();
      const wait = Math.max(0, lastStart + CONFIG.minInterval - Date.now());
      lastStart = Date.now() + wait;
      active += 1;
      setTimeout(() => { run(handle); }, wait);
    }
  }

  async function run(handle) {
    try {
      const rel = await fetchRelation(handle);
      saveRelation(handle, rel);
    } catch (err) {
      debug('查询失败', handle, err && err.message);
      saveError(handle);
    } finally {
      active -= 1;
      paint(handle);
      pump();
    }
  }

  /* ============ 角标渲染（蓝勾 / 绿勾 / 红叉） ============ */
  const ICON_CHECK = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" '
    + 'stroke-width="4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 12.5l5 5 10-11"/></svg>';
  const ICON_CROSS = '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" '
    + 'stroke-width="4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  // 互关 → 蓝勾；你还没关注对方 → 绿勾；你关注了但对方没回关 → 红叉
  function visualOf(rel) {
    if (rel.f && rel.b) return 'blue';
    if (!rel.f) return 'green';
    return 'red';
  }

  function applyVisual(badge, rel) {
    const visual = visualOf(rel);
    const hideUntracked = visual === 'green' && !rel.b && !CONFIG.showUnfollowed;

    badge.dataset.state = visual;
    badge.dataset.rel = (rel.f ? '1' : '0') + (rel.b ? '1' : '0');
    badge.className = 'xmb-badge xmb-' + visual;
    badge.title = titleFor(rel);
    badge.innerHTML = visual === 'red' ? ICON_CROSS : ICON_CHECK;
    badge.style.display = hideUntracked ? 'none' : '';
    badge.style.cursor = (!rel.f && rel.b) ? 'pointer' : 'default';
  }

  function paintArticle(article, handle) {
    if (!article.isConnected) return;
    const badge = article.querySelector('.xmb-badge');
    if (!badge) return;
    const rel = readRelation(handle);
    // 只拿得到「TA 关注了你」这一半信息时不猜颜色，等接口结果
    if (rel) applyVisual(badge, rel);
  }

  function paint(handle) {
    const set = waiting.get(handle);
    if (!set) return;
    set.forEach(article => {
      if (!article.isConnected) {
        set.delete(article);
        return;
      }
      paintArticle(article, handle);
    });
  }

  function extractHandle(userName) {
    const links = userName.querySelectorAll('a[href^="/"]');
    for (let i = 0; i < links.length; i += 1) {
      const href = (links[i].getAttribute('href') || '').split('?')[0].split('/status/')[0];
      const m = href.match(HANDLE_RE);
      if (m) {
        const handle = m[1].toLowerCase();
        if (!RESERVED.has(handle)) return handle;
      }
    }
    return null;
  }

  function attachBadge(article, userName, handle) {
    if (article.querySelector('.xmb-badge')) return;
    const children = userName.children;
    const row = children.length > 1 ? children[1] : userName;
    const badge = document.createElement('span');
    badge.className = 'xmb-badge';
    badge.style.display = 'none';
    badge.dataset.handle = handle;
    badge.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      // 只有「TA 关注了你、你还没关注」时点击才去主页回关
      if (badge.dataset.rel === '01') {
        window.open(origin + '/' + handle, '_blank', 'noopener');
      }
    });
    row.appendChild(badge);
  }

  let ownHandle = null;

  // 从左侧账号按钮里取自己的用户名，避免给自己的帖子打角标
  function myHandle() {
    if (ownHandle) return ownHandle;
    const btn = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    const m = btn && (btn.textContent || '').match(/@([A-Za-z0-9_]{1,15})/);
    if (m) ownHandle = m[1].toLowerCase();
    return ownHandle;
  }

  function processArticle(article) {
    if (!article) return;
    const badge = article.querySelector('.xmb-badge');
    // 已经处理过、且角标还在（X 重渲染可能把它冲掉，这时需要重挂）
    if (article.dataset.xmbScan === '1' && badge) return;
    const userName = article.querySelector('[data-testid="User-Name"]');
    if (!userName) return;
    const handle = extractHandle(userName);
    if (!handle) return;
    if (handle === myHandle()) {
      article.dataset.xmbScan = '1';
      return;
    }

    article.dataset.xmbScan = '1';
    article.dataset.xmbHandle = handle;

    attachBadge(article, userName, handle);

    let set = waiting.get(handle);
    if (!set) {
      set = new Set();
      waiting.set(handle, set);
    }
    set.add(article);

    if (readRelation(handle)) {
      paintArticle(article, handle);
    } else if (shouldRequest(handle)) {
      enqueue(handle);
    } else {
      paintArticle(article, handle);
    }
  }

  function scan() {
    const list = document.querySelectorAll('article[data-testid="tweet"]');
    for (let i = 0; i < list.length; i += 1) processArticle(list[i]);
  }

  /* ============ 启动 ============ */
  function injectStyle() {
    const css = `
      .xmb-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        align-self: center;
        flex: 0 0 auto;
        width: 15px;
        height: 15px;
        margin-left: 5px;
        border-radius: 4px;
        color: #fff;
        line-height: 0;
        vertical-align: middle;
      }
      .xmb-badge svg { display: block; }
      .xmb-badge.xmb-blue { background: #1d9bf0; }
      .xmb-badge.xmb-green { background: #00ba7c; }
      .xmb-badge.xmb-red { background: #f4212e; }
    `;
    if (typeof GM_addStyle === 'function') {
      GM_addStyle(css);
    } else {
      const style = document.createElement('style');
      style.textContent = css;
      (document.head || document.documentElement).appendChild(style);
    }
  }

  let scanTimer = 0;

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      scan();
    }, 250);
  }

  function start() {
    injectStyle();
    ensureMessages();
    scan();
    const root = document.body || document.documentElement;
    if (root) {
      new MutationObserver(mutations => {
        for (let i = 0; i < mutations.length; i += 1) {
          if (mutations[i].addedNodes.length) {
            scheduleScan();
            return;
          }
        }
      }).observe(root, { childList: true, subtree: true });
    }
    // 兜底：X 的虚拟列表偶尔不会触发新增节点
    setInterval(scan, 2000);
    debug('已启动');
  }

  if (document.body) {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  }
})();
