/*
 * local/shim.js — account-free, offline-first layer for Hexpane.
 *
 * Loaded as a classic script before the app bundle, so it can install its
 * hooks while the module graph is still deferred. What it does:
 *
 *   1. Writes a fake ACCESS_TOKEN, so the app takes its "signed in" path and
 *      asks for `viewer { ... }` instead of the guest-only `default*` fields.
 *   2. Overrides window.fetch. Every GraphQL operation that touches `viewer`
 *      (or the auth mutations) is answered locally out of chrome.storage.local;
 *      everything else — wallpapers catalogue, weather, search suggestions —
 *      is forwarded to the real API untouched.
 *   3. Indexes every object the API sends back, so layouts can be rehydrated
 *      without the network once an app has been seen.
 *   4. Keeps uploaded images (wallpapers, custom icons, avatar) in IndexedDB
 *      and hands the app blob: URLs for them.
 *
 * No account, no personal data leaving the browser.
 */
(function () {
  'use strict';

  var STORE_KEY = 'ihp:local:v1';
  // Bumped whenever local/seed.json changes in a way that must replace an
  // existing store. A store stamped with an older number is rebuilt from the
  // seed on the next load, so a new layout does not need a manual reset.
  var SEED_VERSION = 9;
  var TOKEN_KEY = 'lscache-ACCESS_TOKEN'; // the app's own storage helper prefixes with lscache-
  var IMG_PREFIX = 'ihplocal:';           // stands in for an image kept in IndexedDB
  var REAL_FETCH = window.fetch.bind(window);
  // Set localStorage['ihp:debug'] = '1' to get a console trace of every operation.
  var DEBUG = (function () {
    try { return localStorage.getItem('ihp:debug') === '1'; } catch (e) { return false; }
  })();

  // Telemetry endpoints. Blocked outright rather than merely disabled, so a
  // stray call from a code path we missed still goes nowhere.
  var BLOCKED_HOST = /(^|\.)(amplitude\.com|clarity\.ms|sentry\.io|qbox\.me)$/i;

  function log() {
    if (DEBUG) console.log.apply(console, ['[ihp-local]'].concat([].slice.call(arguments)));
  }

  // Every operation we see, and how it was split. Always recorded (it is small
  // and bounded) so a misbehaving page can be diagnosed after the fact.
  var TRACE = [];
  function trace(rec) {
    TRACE.push(rec);
    if (TRACE.length > 200) TRACE.shift();
    log(rec.op, 'local:', rec.local.join(',') || '-', 'remote:', rec.remote.join(',') || '-');
    return rec;
  }

  // Pretend we are signed in. Has to happen synchronously, before the bundle runs.
  try {
    if (!localStorage.getItem(TOKEN_KEY)) localStorage.setItem(TOKEN_KEY, JSON.stringify('ihp-local'));
  } catch (e) { /* private mode */ }

  var WALLPAPER_KEY = 'lscache-USER_WALLPAPER';
  var PREVIEW_KEY = 'ihp-wallpaper-preview';
  var PREVIEW_EDGE = 1600;
  var PREVIEW_QUALITY = 0.7;

  try {
    var storedWallpaper = localStorage.getItem(WALLPAPER_KEY) || '';
    if (storedWallpaper.indexOf('blob:') >= 0) {
      var wallpaperEntry = JSON.parse(storedWallpaper);
      var wallpaperPreview = JSON.parse(localStorage.getItem(PREVIEW_KEY) || 'null');
      if (wallpaperPreview && wallpaperEntry.wallpaper && wallpaperPreview.id === wallpaperEntry.wallpaper._id) {
        ['key', 'large', 'original', 'thumbnail', 'small'].forEach(function (f) {
          wallpaperEntry.wallpaper.image[f] = wallpaperPreview.src;
        });
        wallpaperEntry.updated_at = 1;
        localStorage.setItem(WALLPAPER_KEY, JSON.stringify(wallpaperEntry));
      } else {
        localStorage.removeItem(WALLPAPER_KEY);
      }
    }
  } catch (e) { /* private mode */ }

  // The app clears the token whenever it thinks the session died. Under debug,
  // record who did it — otherwise the blank-page symptom has no visible cause.
  if (DEBUG) {
    var realRemove = localStorage.removeItem.bind(localStorage);
    var realClear = localStorage.clear.bind(localStorage);
    localStorage.removeItem = function (k) {
      if (k === TOKEN_KEY) console.warn('[ihp-local] token removed by', new Error('stack').stack);
      return realRemove(k);
    };
    localStorage.clear = function () {
      console.warn('[ihp-local] localStorage cleared by', new Error('stack').stack);
      return realClear();
    };
  }

  /* ------------------------------------------------------------------ *
   * GraphQL: lexer / parser / printer
   * ------------------------------------------------------------------ */

  var PUNCT = '{}()[]:=$@!|&';

  function lex(src) {
    var toks = [], i = 0, n = src.length;
    while (i < n) {
      var c = src[i];
      if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === ',' || c === '﻿') { i++; continue; }
      if (c === '.' && src.substr(i, 3) === '...') { toks.push({ t: '...' }); i += 3; continue; }
      if (PUNCT.indexOf(c) >= 0) { toks.push({ t: c }); i++; continue; }
      if (c === '"') {
        if (src.substr(i, 3) === '"""') {
          var end = src.indexOf('"""', i + 3);
          if (end < 0) throw new Error('unterminated block string');
          toks.push({ t: 'str', v: src.slice(i + 3, end) });
          i = end + 3; continue;
        }
        var sm = /^"(?:[^"\\]|\\.)*"/.exec(src.slice(i));
        if (!sm) throw new Error('unterminated string');
        toks.push({ t: 'str', v: JSON.parse(sm[0]) });
        i += sm[0].length; continue;
      }
      var nm = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i));
      if (nm && /[-0-9]/.test(c)) {
        toks.push({ t: 'num', v: Number(nm[0]) });
        i += nm[0].length; continue;
      }
      var im = /^[_A-Za-z][_0-9A-Za-z]*/.exec(src.slice(i));
      if (im) { toks.push({ t: 'name', v: im[0] }); i += im[0].length; continue; }
      throw new Error('unexpected character ' + JSON.stringify(c));
    }
    return toks;
  }

  function parseDocument(src) {
    var toks = lex(src), p = 0;

    function peek() { return toks[p]; }
    function next() { return toks[p++]; }
    function eat(t) { if (peek() && peek().t === t) { p++; return true; } return false; }
    function expect(t) {
      var x = next();
      if (!x || x.t !== t) throw new Error('expected ' + t + ' at token ' + (p - 1));
      return x;
    }
    function expectName() { return expect('name').v; }
    function isName(v) { return peek() && peek().t === 'name' && (v === undefined || peek().v === v); }

    function parseType() {
      var out;
      if (eat('[')) { out = '[' + parseType() + ']'; expect(']'); }
      else out = expectName();
      if (eat('!')) out += '!';
      return out;
    }

    function parseValue() {
      var tk = next();
      if (!tk) throw new Error('unexpected end of value');
      if (tk.t === '$') return { k: 'var', name: expectName() };
      if (tk.t === 'str' || tk.t === 'num') return { k: 'const', v: tk.v };
      if (tk.t === '[') {
        var items = [];
        while (peek() && peek().t !== ']') items.push(parseValue());
        expect(']');
        return { k: 'list', items: items };
      }
      if (tk.t === '{') {
        var fields = [];
        while (peek() && peek().t !== '}') {
          var key = expectName(); expect(':');
          fields.push([key, parseValue()]);
        }
        expect('}');
        return { k: 'obj', fields: fields };
      }
      if (tk.t === 'name') {
        if (tk.v === 'true') return { k: 'const', v: true };
        if (tk.v === 'false') return { k: 'const', v: false };
        if (tk.v === 'null') return { k: 'const', v: null };
        return { k: 'enum', v: tk.v };
      }
      throw new Error('bad value token ' + tk.t);
    }

    function parseArgs() {
      if (!eat('(')) return null;
      var args = [];
      while (peek() && peek().t !== ')') {
        var name = expectName(); expect(':');
        args.push([name, parseValue()]);
      }
      expect(')');
      return args;
    }

    function parseDirectives() {
      var dirs = null;
      while (peek() && peek().t === '@') {
        next();
        var d = { name: expectName(), args: parseArgs() };
        (dirs || (dirs = [])).push(d);
      }
      return dirs;
    }

    function parseSelectionSet() {
      expect('{');
      var sels = [];
      while (peek() && peek().t !== '}') {
        if (eat('...')) {
          if (isName('on')) {
            next();
            var on = expectName(), idirs = parseDirectives();
            sels.push({ kind: 'inline', on: on, dirs: idirs, sel: parseSelectionSet() });
          } else if (peek().t === '{') {
            sels.push({ kind: 'inline', on: null, dirs: null, sel: parseSelectionSet() });
          } else {
            var fname = expectName();
            sels.push({ kind: 'spread', name: fname, dirs: parseDirectives() });
          }
          continue;
        }
        var alias = null, name = expectName();
        if (eat(':')) { alias = name; name = expectName(); }
        var args = parseArgs(), dirs = parseDirectives();
        var sub = peek() && peek().t === '{' ? parseSelectionSet() : null;
        sels.push({ kind: 'field', alias: alias, name: name, args: args, dirs: dirs, sel: sub });
      }
      expect('}');
      return sels;
    }

    var ops = [], frags = {};
    while (p < toks.length) {
      if (peek().t === '{') { ops.push({ op: 'query', name: null, vars: [], sel: parseSelectionSet() }); continue; }
      var kw = expectName();
      if (kw === 'fragment') {
        var fn = expectName();
        expect('name'); // `on`
        var tc = expectName();
        frags[fn] = { on: tc, dirs: parseDirectives(), sel: parseSelectionSet() };
        continue;
      }
      if (kw !== 'query' && kw !== 'mutation' && kw !== 'subscription') throw new Error('unknown definition ' + kw);
      var opName = isName() ? expectName() : null;
      var varDefs = [];
      if (eat('(')) {
        while (peek() && peek().t !== ')') {
          expect('$');
          var vn = expectName(); expect(':');
          var vt = parseType(), def = null;
          if (eat('=')) def = parseValue();
          varDefs.push({ name: vn, type: vt, def: def });
        }
        expect(')');
      }
      parseDirectives();
      ops.push({ op: kw, name: opName, vars: varDefs, sel: parseSelectionSet() });
    }
    return { ops: ops, frags: frags };
  }

  function printValueNode(v) {
    switch (v.k) {
      case 'var': return '$' + v.name;
      case 'const': return JSON.stringify(v.v);
      case 'enum': return v.v;
      case 'list': return '[' + v.items.map(printValueNode).join(' ') + ']';
      case 'obj': return '{' + v.fields.map(function (f) { return f[0] + ':' + printValueNode(f[1]); }).join(' ') + '}';
    }
    return 'null';
  }

  function printArgs(args) {
    if (!args || !args.length) return '';
    return '(' + args.map(function (a) { return a[0] + ':' + printValueNode(a[1]); }).join(' ') + ')';
  }

  function printDirectives(dirs) {
    if (!dirs || !dirs.length) return '';
    return ' ' + dirs.map(function (d) { return '@' + d.name + printArgs(d.args); }).join(' ');
  }

  function printSelections(sels) {
    return '{ ' + sels.map(function (s) {
      if (s.kind === 'spread') return '...' + s.name + printDirectives(s.dirs);
      if (s.kind === 'inline') return '...' + (s.on ? ' on ' + s.on : '') + printDirectives(s.dirs) + ' ' + printSelections(s.sel);
      return (s.alias ? s.alias + ':' : '') + s.name + printArgs(s.args) + printDirectives(s.dirs) +
        (s.sel ? ' ' + printSelections(s.sel) : '');
    }).join(' ') + ' }';
  }

  /** fragment names referenced (transitively) by a selection set */
  function collectFragments(sels, frags, acc) {
    acc = acc || {};
    (sels || []).forEach(function (s) {
      if (s.kind === 'spread') {
        if (!acc[s.name] && frags[s.name]) { acc[s.name] = true; collectFragments(frags[s.name].sel, frags, acc); }
        return;
      }
      if (s.sel) collectFragments(s.sel, frags, acc);
    });
    return acc;
  }

  function collectVarsFromValue(v, acc) {
    if (!v) return;
    if (v.k === 'var') acc[v.name] = true;
    else if (v.k === 'list') v.items.forEach(function (x) { collectVarsFromValue(x, acc); });
    else if (v.k === 'obj') v.fields.forEach(function (f) { collectVarsFromValue(f[1], acc); });
  }

  /** variable names referenced by a selection set (including the fragments it uses) */
  function collectVars(sels, frags, acc, seenFrags) {
    acc = acc || {}; seenFrags = seenFrags || {};
    (sels || []).forEach(function (s) {
      (s.args || []).forEach(function (a) { collectVarsFromValue(a[1], acc); });
      (s.dirs || []).forEach(function (d) { (d.args || []).forEach(function (a) { collectVarsFromValue(a[1], acc); }); });
      if (s.kind === 'spread') {
        if (!seenFrags[s.name] && frags[s.name]) { seenFrags[s.name] = true; collectVars(frags[s.name].sel, frags, acc, seenFrags); }
        return;
      }
      if (s.sel) collectVars(s.sel, frags, acc, seenFrags);
    });
    return acc;
  }

  /* ------------------------------------------------------------------ *
   * Schema helpers (local/schema.json — introspection, trimmed down)
   * ------------------------------------------------------------------ */

  var SCHEMA = null, CANON = null;

  function typeInfo(name) { return SCHEMA[name]; }
  function fieldInfo(typeName, field) {
    var t = SCHEMA[typeName];
    return t && t.f ? t.f[field] : null;
  }
  /** does concrete type `c` satisfy type condition `cond`? */
  function typeMatches(c, cond) {
    if (!cond || c === cond) return true;
    var t = SCHEMA[cond];
    return !!(t && t.p && t.p.indexOf(c) >= 0);
  }

  /* ------------------------------------------------------------------ *
   * Persistence
   * ------------------------------------------------------------------ */

  var DB = null;
  var storageArea = (function () {
    try { return chrome.storage && chrome.storage.local ? chrome.storage.local : null; } catch (e) { return null; }
  })();

  function loadStore() {
    return new Promise(function (resolve) {
      if (!storageArea) {
        try { resolve(JSON.parse(localStorage.getItem(STORE_KEY) || 'null')); } catch (e) { resolve(null); }
        return;
      }
      storageArea.get([STORE_KEY], function (r) { resolve((r && r[STORE_KEY]) || null); });
    });
  }

  var saveTimer = null, storeFrozen = false;
  var TAB_ID = uid();
  function freezeStore() {
    storeFrozen = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
  }
  function save() {
    if (storeFrozen) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(writeStore, 200);
  }
  function writeStore() {
    saveTimer = null;
    try {
      if (storageArea) {
        DB.writer = TAB_ID;
        var o = {}; o[STORE_KEY] = DB;
        storageArea.set(o);
      } else {
        localStorage.setItem(STORE_KEY, JSON.stringify(DB));
      }
    } catch (e) { console.warn('[ihp-local] save failed', e); }
  }
  if (storageArea && storageArea.onChanged) {
    storageArea.onChanged.addListener(function (changes) {
      var next = changes[STORE_KEY] && changes[STORE_KEY].newValue;
      if (!next || !DB || storeFrozen || saveTimer) return;
      if (next.writer === TAB_ID || next.v !== DB.v) return;
      DB = next;
      loadImages();
    });
  }
  window.addEventListener('pagehide', function () {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    writeStore();
  });

  function uid() {
    var b = new Uint8Array(12);
    (window.crypto || window.msCrypto).getRandomValues(b);
    return Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }

  function now() { return Date.now(); }

  /** strip the zzq_<Type>_ aliases the canonical selections use to dodge union field conflicts */
  function unalias(o) {
    if (Array.isArray(o)) return o.map(unalias);
    if (!o || typeof o !== 'object') return o;
    var out = {};
    Object.keys(o).forEach(function (k) {
      var nk = k;
      if (k.indexOf('zzq_') === 0) nk = k.split('_').slice(2).join('_');
      out[nk] = unalias(o[k]);
    });
    return out;
  }

  var CACHEABLE = { Website: 1, Widget: 1, App: 1, RSS: 1, Wallpaper: 1, Search: 1, Translate: 1 };
  var OBJECT_CAP = 2500;

  /** remember every addressable object the API hands us, so layouts survive offline */
  function indexObjects(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(indexObjects); return; }
    var tn = node.__typename;
    if (tn && CACHEABLE[tn] && node._id) {
      var prev = DB.objects[node._id];
      var merged = prev ? Object.assign({}, prev, node) : node;
      if (prev && /^(\/local\/|data:|ihplocal:)/.test(prev.icon || '')) {
        merged.icon = prev.icon;
        if (prev.iconKey !== undefined) merged.iconKey = prev.iconKey;
        if (prev.icon_key !== undefined) merged.icon_key = prev.icon_key;
      }
      DB.objects[node._id] = merged;
    }
    Object.keys(node).forEach(function (k) { indexObjects(node[k]); });
  }

  function trimObjects() {
    var keys = Object.keys(DB.objects);
    if (keys.length <= OBJECT_CAP) return;
    var keep = {}, inUse = {};
    (DB.apps || []).forEach(function (row) {
      row.forEach(function (it) {
        if (it.app_id) inUse[it.app_id] = 1;
        (it.app_ids || []).forEach(function (c) { inUse[c.app_id] = 1; });
      });
    });
    keys.slice(-OBJECT_CAP).forEach(function (k) { keep[k] = 1; });
    Object.keys(inUse).forEach(function (k) { keep[k] = 1; });
    keys.forEach(function (k) { if (!keep[k]) delete DB.objects[k]; });
  }

  /* ------------------------------------------------------------------ *
   * Uploaded images: IndexedDB + blob: URLs
   * ------------------------------------------------------------------ */

  var IMG_URLS = {};
  var SEARCH_CATALOG = {};

  function idb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('ihp-local-img', 1);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains('img')) req.result.createObjectStore('img');
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbTx(mode, fn) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('img', mode), store = tx.objectStore('img'), out;
        out = fn(store);
        tx.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function loadImages() {
    return idbTx('readonly', function (s) { return s.getAll ? s.getAll() : null; }).then(function (rows) {
      return idbTx('readonly', function (s) { return s.getAllKeys ? s.getAllKeys() : null; }).then(function (keys) {
        (keys || []).forEach(function (k, i) {
          var blob = rows[i];
          if (blob && !IMG_URLS[k]) IMG_URLS[k] = URL.createObjectURL(blob) + '#ihp.png';
        });
      });
    }).catch(function (e) { console.warn('[ihp-local] image load failed', e); });
  }

  /**
   * Kucuk gorseller (ikonlar) IndexedDB yerine dogrudan data: URL olarak
   * saklanir. Sebep: ihplocal: isaretcisi disari verilirken oturuma ozel bir
   * blob: URL'e cozuluyor, uygulama da bu degeri localStorage'daki
   * lscache-USER_APPS ve CACHE-PERSIST kopyalarina yaziyor. Sonraki acilista o
   * blob: URL olu oldugu icin <img> hata veriyor ve dosme siyah kalıyordu.
   * Duvar kagidi gibi buyuk gorseller IndexedDB'de kalir (depoyu sismeye
   * birakmamak icin) — onlar zaten her acilista sorgudan taze geliyor.
   */
  var INLINE_MAX_EDGE = 512;              // bundan buyugu artik ikon degil
  var INLINE_MAX_BYTES = 512 * 1024;

  function inlineImage(blob) {
    var type = (blob && blob.type) || '';
    if (!blob || type.indexOf('image/') !== 0 || blob.size > INLINE_MAX_BYTES) {
      return Promise.resolve(null);
    }
    if (type.indexOf('svg') >= 0) return blobToDataURL(blob).catch(function () { return null; });
    return measureBlob(blob, 0).then(function (c) {
      return (c.w && c.h && Math.max(c.w, c.h) <= INLINE_MAX_EDGE) ? c.src : null;
    }).catch(function () { return null; });
  }

  function putImage(blob) {
    var id = uid();
    return idbTx('readwrite', function (s) { s.put(blob, id); }).then(function () {
      IMG_URLS[id] = URL.createObjectURL(blob) + '#ihp.png';
      return IMG_PREFIX + id;
    });
  }

  function saveImage(blob) {
    return inlineImage(blob).then(function (data) {
      if (data) return data;               // kendi kendine yeten, kalici deger
      return putImage(blob);
    });
  }

  function dropImage(ref) {
    if (typeof ref !== 'string' || ref.indexOf(IMG_PREFIX) !== 0) return;
    if (JSON.stringify(DB).indexOf(ref) >= 0) return;
    var id = ref.slice(IMG_PREFIX.length), url = IMG_URLS[id];
    idbTx('readwrite', function (s) { s.delete(id); }).then(function () {
      delete IMG_URLS[id];
      if (url) URL.revokeObjectURL(url.split('#')[0]);
    }).catch(function (e) { console.warn('[ihp-local] image delete failed', e); });
  }

  function migrateDataWallpapers() {
    var FIELDS = ['key', 'large', 'original', 'thumbnail', 'small'];
    var holders = (DB.wallpapers || []).slice();
    Object.keys(DB.objects || {}).forEach(function (k) {
      if (DB.objects[k] && DB.objects[k].__typename === 'Wallpaper') holders.push(DB.objects[k]);
    });
    if (DB.userWallpaper && DB.userWallpaper.wallpaper) holders.push(DB.userWallpaper.wallpaper);
    var urls = {};
    holders.forEach(function (w) {
      var large = w.image && w.image.large;
      if (typeof large === 'string' && large.indexOf('data:image/') === 0) urls[large] = 1;
    });
    var list = Object.keys(urls);
    if (!list.length) return Promise.resolve(0);
    var map = {};
    return Promise.all(list.map(function (u) {
      return putImage(dataURLToBlob(u)).then(function (ref) { map[u] = ref; });
    })).then(function () {
      holders.forEach(function (w) {
        FIELDS.forEach(function (f) {
          if (w.image && map[w.image[f]]) w.image[f] = map[w.image[f]];
        });
      });
      if (DB.userWallpaper) DB.userWallpaper.updated_at = now();
      save();
      return list.length;
    });
  }

  /**
   * Once kaydedilmis kucuk ikonlari (ihplocal: isaretcisi) data: URL'e cevirir.
   * Yalnizca ikon alanlarina dokunur; duvar kagitlari isaretci olarak kalir.
   * Bir sey degistiyse appsUpdatedAt tazelenir, boylece uygulama izgarayi
   * localStorage kopyasindan degil bizden yeniden okur.
   */
  function migrateInlineIcons() {
    var ICON_FIELDS = ['icon', 'iconKey', 'icon_key'];
    var holders = [];
    var push = function (o) { if (o && typeof o === 'object') holders.push(o); };
    (DB.websites || []).forEach(push);
    (DB.searchs || []).forEach(push);
    Object.keys(DB.aliases || {}).forEach(function (k) { push(DB.aliases[k]); });
    Object.keys(DB.objects || {}).forEach(function (k) { push(DB.objects[k]); });
    (DB.websites || []).forEach(function (w) { push(w.aliasWebsite); push(w.alias_website); });

    var ids = {};
    holders.forEach(function (o) {
      ICON_FIELDS.forEach(function (f) {
        var v = o[f];
        if (typeof v === 'string' && v.indexOf(IMG_PREFIX) === 0) ids[v.slice(IMG_PREFIX.length)] = 1;
      });
    });
    var list = Object.keys(ids);
    if (!list.length) return Promise.resolve(0);

    var map = {};
    return Promise.all(list.map(function (id) {
      return idbTx('readonly', function (s) { return s.get(id); }).then(function (blob) {
        if (!blob) return;
        return inlineImage(blob).then(function (data) { if (data) map[id] = data; });
      }).catch(function () { });
    })).then(function () {
      var hits = 0;
      holders.forEach(function (o) {
        ICON_FIELDS.forEach(function (f) {
          var v = o[f];
          if (typeof v !== 'string' || v.indexOf(IMG_PREFIX) !== 0) return;
          var data = map[v.slice(IMG_PREFIX.length)];
          if (data) { o[f] = data; hits++; }
        });
      });
      if (!hits) return 0;
      DB.appsUpdatedAt = now();
      save();
      log('inlined', hits, 'icon fields');
      return hits;
    });
  }

  function storedIcon(v) {
    if (typeof v !== 'string') return v;
    if (v.indexOf('img/') === 0) return '/local/' + v;
    if (v.indexOf('blob:') === 0) {
      var id = Object.keys(IMG_URLS).filter(function (k) { return IMG_URLS[k] === v; })[0];
      return id ? IMG_PREFIX + id : v;
    }
    return v;
  }

  function refreshWallpaperPreview() {
    var w = DB.userWallpaper && DB.userWallpaper.wallpaper;
    var key = w && w.image && w.image.large;
    if (typeof key !== 'string' || key.indexOf(IMG_PREFIX) !== 0) {
      try { localStorage.removeItem(PREVIEW_KEY); } catch (e) { /* private mode */ }
      return Promise.resolve(false);
    }
    try {
      var current = JSON.parse(localStorage.getItem(PREVIEW_KEY) || 'null');
      if (current && current.id === w._id) return Promise.resolve(false);
    } catch (e) { /* bozuk kayit yeniden uretilir */ }
    return idbTx('readonly', function (s) { return s.get(key.slice(IMG_PREFIX.length)); }).then(function (blob) {
      return blob ? createImageBitmap(blob) : null;
    }).then(function (bmp) {
      if (!bmp) return false;
      var scale = Math.min(1, PREVIEW_EDGE / Math.max(bmp.width, bmp.height));
      var cv = document.createElement('canvas');
      cv.width = Math.round(bmp.width * scale);
      cv.height = Math.round(bmp.height * scale);
      cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
      bmp.close();
      localStorage.setItem(PREVIEW_KEY, JSON.stringify({
        id: w._id, src: cv.toDataURL('image/jpeg', PREVIEW_QUALITY) + '#ihp.jpg'
      }));
      return true;
    }).catch(function (e) { log('wallpaper preview failed', e); return false; });
  }

  function migrateRemoteIcons() {
    var names = {};
    (SEARCH_CATALOG.localIcons || []).forEach(function (n) { names[n] = 1; });
    var localize = function (o) {
      if (!o || typeof o.icon !== 'string') return false;
      var m = /^https?:\/\/res\.ihomepage\.cn\/(?:[^?#]*\/)?([^\/?#]+)/.exec(o.icon);
      if (!m || !names[m[1]]) return false;
      o.icon = '/local/img-default/' + m[1];
      return true;
    };
    var hits = 0;
    Object.keys(DB.objects || {}).forEach(function (k) { if (localize(DB.objects[k])) hits++; });
    (DB.searchs || []).forEach(function (o) { if (localize(o)) hits++; });
    var us = DB.userSearch, searchHit = false;
    if (us) {
      if (localize(us.main_search)) searchHit = true;
      (us.search || []).forEach(function (o) { if (localize(o)) searchHit = true; });
      if (searchHit) { us.updated_at = now(); hits++; }
    }
    if (DB.userTranslate && localize(DB.userTranslate.translate)) {
      DB.userTranslate.updated_at = now();
      hits++;
    }
    if (hits) {
      DB.appsUpdatedAt = now();
      save();
    }
    return hits;
  }

  function migrateIconPaths() {
    var holders = [];
    var push = function (o) { if (o && typeof o === 'object') holders.push(o); };
    (DB.websites || []).forEach(function (w) { push(w); push(w.aliasWebsite); push(w.alias_website); });
    (DB.searchs || []).forEach(push);
    Object.keys(DB.aliases || {}).forEach(function (k) { push(DB.aliases[k]); });
    Object.keys(DB.objects || {}).forEach(function (k) {
      var o = DB.objects[k];
      push(o);
      if (o) { push(o.aliasWebsite); push(o.alias_website); }
    });
    var hits = 0;
    holders.forEach(function (o) {
      if (typeof o.icon === 'string' && o.icon.indexOf('img/') === 0) {
        o.icon = storedIcon(o.icon);
        hits++;
      }
    });
    if (hits) {
      DB.appsUpdatedAt = now();
      save();
    }
    return hits;
  }

  /** swap ihplocal: markers for this session's blob URLs on the way out */
  function resolveImages(node) {
    if (typeof node === 'string') {
      return node.indexOf(IMG_PREFIX) === 0 ? (IMG_URLS[node.slice(IMG_PREFIX.length)] || node) : node;
    }
    if (Array.isArray(node)) return node.map(resolveImages);
    if (node && typeof node === 'object') {
      var out = {};
      Object.keys(node).forEach(function (k) { out[k] = resolveImages(node[k]); });
      return out;
    }
    return node;
  }

  function imageObject(url) {
    return {
      __typename: 'Image', key: url, large: url, original: url,
      thumbnail: url, small: url, srcset: '', sizes: ''
    };
  }

  /* ------------------------------------------------------------------ *
   * Talking to the real API
   * ------------------------------------------------------------------ */

  var ENDPOINT = 'https://ihomepage.yazhua.com/graphql';
  var lastHeaders = null; // reuse whatever the app last sent (client id, language, ...)

  // The app authenticates with an x-client-token header. Ours is a local
  // stand-in the API knows nothing about, so anything we forward has to go out
  // anonymously — the catalogue queries (wallpapers, widgets, icons, version
  // checks) are all public anyway.
  var AUTH_HEADER = /^(x-client-token|authorization)$/i;

  function anonHeaders(h) {
    var out = {}, hasType = false;
    Object.keys(h || {}).forEach(function (k) {
      if (AUTH_HEADER.test(k)) return;
      if (k.toLowerCase() === 'content-type') hasType = true;
      out[k] = h[k];
    });
    if (!hasType) out['content-type'] = 'application/json';
    return out;
  }

  /**
   * Drop "identity not verified" errors (code B00007) from an upstream result.
   * The app's error link reacts to that code by clearing localStorage, showing
   * a "session expired" alert and reloading — which would wipe the local store
   * and put the page in a reload loop.
   */
  function scrubAuthErrors(r) {
    if (r && r.errors && r.errors.length) {
      var kept = r.errors.filter(function (e) {
        return !(e && e.extensions && e.extensions.code === 'B00007');
      });
      if (kept.length !== r.errors.length) log('dropped upstream auth error', r.errors);
      if (kept.length) r.errors = kept; else delete r.errors;
    }
    return r;
  }

  function markSubscriptions(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(markSubscriptions); return; }
    if (node.__typename === 'RSS' && node._id && 'subscription' in node) {
      node.subscription = (DB.rss.subscribed.indexOf(node._id) >= 0) ? {
        __typename: 'RSSSubscription', is_subscribed: true, is_read: true
      } : null;
    }
    Object.keys(node).forEach(function (k) { markSubscriptions(node[k]); });
  }

  function remote(query, variables) {
    var headers = Object.assign({}, anonHeaders(lastHeaders), { 'content-type': 'application/json' });
    return REAL_FETCH(ENDPOINT, {
      method: 'POST', headers: headers,
      body: JSON.stringify({ query: query, variables: variables || {} })
    }).then(function (r) { return r.json(); }).then(function (j) {
      scrubAuthErrors(j);
      if (j && j.data) { markSubscriptions(j.data); indexObjects(unalias(j.data)); save(); }
      return j;
    });
  }

  /**
   * Run one root field against the real API, reusing the caller's own
   * selection set, arguments and variables verbatim.
   */
  function forwardField(rootField, sel, ctx, extraArgs) {
    var args = (sel.args || []).slice();
    if (extraArgs) args = args.concat(extraArgs);
    var usedFrags = collectFragments(sel.sel || [], ctx.frags);
    var usedVars = collectVars([{ kind: 'field', args: args, sel: sel.sel }], ctx.frags);
    var defs = ctx.varDefs.filter(function (d) { return usedVars[d.name]; });
    var header = defs.length ? '(' + defs.map(function (d) { return '$' + d.name + ':' + d.type; }).join(' ') + ')' : '';
    var body = 'query IHPFwd' + header + ' { ' + rootField + printArgs(args) +
      (sel.sel ? ' ' + printSelections(sel.sel) : '') + ' }';
    Object.keys(usedFrags).forEach(function (f) {
      body += ' fragment ' + f + ' on ' + ctx.frags[f].on + ' ' + printSelections(ctx.frags[f].sel);
    });
    var vars = {};
    defs.forEach(function (d) { vars[d.name] = ctx.vars[d.name]; });
    return remote(body, vars).then(function (j) {
      return j && j.data ? unalias(j.data)[rootField] : null;
    });
  }

  /* ------------------------------------------------------------------ *
   * Layout hydration (InputUnionApp[][] -> UnionApp[][])
   * ------------------------------------------------------------------ */

  function folderId(item) {
    var key = 'F|' + (item.folder_name || '') + '|' + (item.app_ids || []).map(function (a) { return a.app_id; }).join(',');
    if (!DB.folderIds[key]) { DB.folderIds[key] = uid(); save(); }
    return DB.folderIds[key];
  }

  function withPosition(obj, item) {
    if (!item.app_grid_position) return obj;
    return Object.assign({}, obj, {
      app_grid_position: {
        __typename: 'AppGridPosition',
        x: item.app_grid_position.x, y: item.app_grid_position.y
      }
    });
  }

  function hydrateLayout(rows) {
    rows = rows || [];
    var missing = false;

    var out = rows.map(function (row) {
      return (row || []).map(function (item) {
        if (item.type === 'Folder') {
          var kids = (item.app_ids || []).map(function (c) {
            var o = DB.objects[c.app_id];
            if (!o) missing = true;
            return o || null;
          }).filter(Boolean);
          var id = folderId(item);
          var cached = DB.objects[id];
          return withPosition({
            __typename: 'Folder', _id: id, folder_name: item.folder_name || '',
            type: 'Folder', size: (cached && cached.size) || 'S', apps: kids
          }, item);
        }
        var obj = DB.objects[item.app_id];
        if (!obj) { missing = true; return null; }
        return withPosition(obj, item);
      });
    });

    if (!missing) return Promise.resolve(out.map(function (r) { return r.filter(Boolean); }));

    // Something in the layout was never seen before — ask the API to resolve it.
    log('layout hydration falling back to the API');
    var q = 'query IHPSync($apps:[[InputUnionApp!]!]!){ syncUserApps(apps:$apps){ apps ' + CANON.UnionApp + ' } }';
    return remote(q, { apps: rows }).then(function (j) {
      var apps = j && j.data && j.data.syncUserApps ? unalias(j.data.syncUserApps).apps : null;
      if (!apps) return out.map(function (r) { return r.filter(Boolean); });
      return apps;
    }).catch(function (e) {
      console.warn('[ihp-local] layout hydration failed, showing what we have', e);
      return out.map(function (r) { return r.filter(Boolean); });
    });
  }

  /* ------------------------------------------------------------------ *
   * Pagination helper
   * ------------------------------------------------------------------ */

  function connection(list, args, typename) {
    var first = args.first == null ? list.length : args.first;
    var start = args.after ? parseInt(args.after, 10) || 0 : 0;
    var slice = list.slice(start, start + first);
    var end = start + slice.length;
    return {
      __typename: typename,
      edges: slice,
      page_info: { __typename: 'PageInfo', end_cursor: String(end), has_next_page: end < list.length },
      total_count: list.length,
      totalCount: list.length
    };
  }

  /* ------------------------------------------------------------------ *
   * Local resolvers
   * ------------------------------------------------------------------ */

  var VIEWER = {}, MUT_VIEWER = {};

  function categories(type) {
    if (!DB.categories[type]) DB.categories[type] = [];
    return DB.categories[type];
  }

  var RESOLVERS = {
    Query: {
      allSearch: function () { return SEARCH_CATALOG.allSearch || []; },
      defaultMainSearch: function () { return SEARCH_CATALOG.defaultMainSearch || null; },
      defaultSearch: function () { return SEARCH_CATALOG.defaultSearch || []; },
      search: function (_p, args) {
        return (SEARCH_CATALOG.allSearch || []).filter(function (x) { return x.name === args.name; })[0] || null;
      },
      viewer: function () { return VIEWER; },
      // Guncellenecek bir sey yok. Uygulama surum karsilastirmasi yapmiyor:
      //   const e = await query(newVersion); e.data?.newVersion && em(...)
      // yani bos olmayan HER yanit guncelleme bandini ve dislideki kirmizi
      // noktayi aciyor. Dogru cevap null.
      // Guncelleme diye bir sey yok. Ama null da donulemiyor: uygulama null
      // gelince acilis zincirini tamamlamiyor, splash ekraninda kaliyor.
      // Bant su kosulla aciliyor:
      //   Ko(newVersion.new_version, we.VERSION) === 1   (yani "daha yeni")
      // Manifest surumunu bildirmek kirilgan, cunku sayfa JS'i her sekmede
      // yenilenirken manifest yalnizca eklenti yeniden yuklenince guncelleniyor;
      // ikisi ayrisinca bant kendiliginden aciliyordu. 0.0.0 her surumden kucuk
      // oldugu icin karsilastirma hicbir kosulda 1 donduremez.
      newVersion: function () {
        return { __typename: 'NewVersion', title: '', description: '', install_url: '',
                 is_must_upgrade: false, new_version: '0.0.0', updated_at: 0 };
      },
      // Guest-mode counterpart of viewer.userWallpaper; same stored value.
      defaultUserWallpaper: function () { return DB.userWallpaper; },
      syncUserApps: function (_p, args) {
        return hydrateLayout(args.apps).then(function (apps) {
          return { __typename: 'SyncUserApps', apps: apps };
        });
      }
    },

    Mutation: {
      viewer: function () { return MUT_VIEWER; },
      login: function () { return { __typename: 'LoginAndRegister', user_id: DB.userinfo._id, access_token: 'ihp-local' }; },
      register: function () { return { __typename: 'LoginAndRegister', user_id: DB.userinfo._id, access_token: 'ihp-local' }; },
      oauth: function () { return { __typename: 'OAuth', user_id: DB.userinfo._id, access_token: 'ihp-local', is_new: false }; },
      resetPassword: function () { return true; },
      createCaptcha: function () { return { __typename: 'CreateCaptcha', success: true, _id: uid(), url: null, code: null }; },
      syncUserSearch: function (_p, args) { return setUserSearch(args.main_search_id, args.search_ids); }
    },

    QueryViewer: {
      test: function () { return true; },
      auths: function () { return []; },
      backupUserApps: function () { return []; },
      userinfo: function () { return DB.userinfo; },
      userApps: function () {
        return {
          __typename: 'UserApps', _id: 'local-user-apps',
          created_at: DB.createdAt, updated_at: DB.appsUpdatedAt
        };
      },
      userWallpaper: function () { return DB.userWallpaper; },
      userSearch: function () { return DB.userSearch; },
      userUnits: function () { return DB.userUnits; },
      userControlCenter: function () { return DB.userControlCenter; },
      userDateAndTime: function () { return DB.userDateAndTime; },
      userLanguageAndRegion: function () { return DB.userLanguageAndRegion; },
      userTranslate: function () { return DB.userTranslate; },
      userQuickNavigation: function () { return DB.userQuickNavigation; },
      userCity: function () { return DB.userCity; },
      userCookiePreferences: function () { return DB.userCookiePreferences; },
      userEmailSubscription: function () { return DB.userEmailSubscription; },

      searchs: function () { return DB.searchs; },
      search: function (_p, args) {
        return DB.searchs.filter(function (s) { return s._id === args._id; })[0] || null;
      },

      websites: function (_p, args) { return connection(DB.websites, args, 'Websites'); },
      website: function (_p, args) {
        return DB.websites.filter(function (w) { return w._id === args._id; })[0] || DB.objects[args._id] || null;
      },
      allWebsiteUrls: function () { return DB.websites.map(function (w) { return w.url; }); },
      getWebsiteInfo: function (_p, args) { return websiteInfo(args.url); },

      wallpapers: function (_p, args) { return connection(DB.wallpapers, args, 'Wallpapers'); },

      userCategories: function (_p, args) { return connection(categories(args.type), args, 'UserCategoryListInfo'); },
      userCategory: function (_p, args) {
        var all = [];
        Object.keys(DB.categories).forEach(function (k) { all = all.concat(DB.categories[k]); });
        return all.filter(function (c) { return c._id === args._id; })[0] || null;
      },

      userReadingList: function (_p, args) {
        var list = DB.readingList.slice();
        if (args.user_category_id) {
          list = list.filter(function (r) { return r.user_category && r.user_category._id === args.user_category_id; });
        }
        if (args.search) {
          var q = String(args.search).toLowerCase();
          list = list.filter(function (r) {
            return (r.title || '').toLowerCase().indexOf(q) >= 0 || (r.url || '').toLowerCase().indexOf(q) >= 0;
          });
        }
        return connection(list, args, 'UserReadingListInfo');
      },
      getUserReadingList: function (_p, args) {
        return DB.readingList.filter(function (r) { return r._id === args._id; })[0] || null;
      },

      notes: function (_p, args) {
        return { __typename: 'Notes', edges: connection(DB.notes, args, 'Notes').edges, total: DB.notes.length };
      },

      // RSS: subscriptions live here, the feeds themselves come from the API
      RSSList: function (_p, args, ctx, sel) { return rssList(args, ctx, sel); },
      latestRSSList: function (_p, args, ctx, sel) {
        return rssByIds(DB.rss.subscribed, sel.sel, ctx);
      },
      RSSFeedList: function (_p, args, ctx, sel) {
        return args.rss_id ? forwardField('RSSFeedList', sel, ctx) : subscribedFeeds(args, ctx, sel);
      },
      newRSSFeedCount: function () { return 0; },
      unreadUserRSSSubscriptionTotal: function () { return 0; },
      playground: function () { return null; }
    },

    MutationViewer: {
      test: function () { return true; },

      updateUserApps: function (_p, args) {
        DB.apps = normalizeLayout(args.apps);
        DB.appsUpdatedAt = now();
        save();
        return true;
      },
      updatePlayground: function (_p, args) {
        DB.apps = normalizeLayout(args.apps);
        DB.appsUpdatedAt = now();
        save();
        return true;
      },

      updateUserWallpaper: function (_p, args) {
        var w = DB.objects[args.wallpaper_id] ||
          DB.wallpapers.filter(function (x) { return x._id === args.wallpaper_id; })[0];
        if (w) {
          var prevW = DB.userWallpaper && DB.userWallpaper.wallpaper;
          DB.userWallpaper = {
            __typename: 'UserWallpaper', wallpaper: w,
            opacity: args.opacity, blur: args.blur, updated_at: now()
          };
          if (prevW && prevW._id !== w._id && prevW.image) dropImage(prevW.image.large);
        } else if (DB.userWallpaper) {
          DB.userWallpaper = Object.assign({}, DB.userWallpaper, {
            opacity: args.opacity, blur: args.blur, updated_at: now()
          });
        }
        save();
        refreshWallpaperPreview();
        return true;
      },
      createWallpaper: function (_p, args) {
        var stored = String(args.url).indexOf('data:image/') === 0
          ? putImage(dataURLToBlob(args.url)) : Promise.resolve(args.url);
        return stored.then(function (url) {
          var w = { __typename: 'Wallpaper', _id: uid(), image: imageObject(url) };
          DB.wallpapers.unshift(w);
          DB.objects[w._id] = w;
          save();
          return w;
        });
      },
      removeWallpaper: function (_p, args) {
        var gone = DB.wallpapers.filter(function (w) { return w._id === args._id; })[0];
        DB.wallpapers = DB.wallpapers.filter(function (w) { return w._id !== args._id; });
        delete DB.objects[args._id];
        if (gone && gone.image) dropImage(gone.image.large);
        save();
        return true;
      },

      createWebsite: function (_p, args) {
        var newIcon = storedIcon(args.icon) || '';
        var w = {
          __typename: 'Website', _id: uid(), name: args.name, url: args.url,
          size: 'S', description: args.description || null, icon: newIcon,
          iconKey: newIcon, icon_key: newIcon, type: 'Website',
          user_id: DB.userinfo._id, aliasWebsite: null, alias_website: null,
          is_affiliate_ad: false, is_deleted: false, app_grid_position: null
        };
        DB.websites.unshift(w);
        DB.objects[w._id] = w;
        save();
        return w;
      },
      updateWebsite: function (_p, args) {
        var u = Object.assign({}, args.update || {});
        if (u.icon != null) u.icon = storedIcon(u.icon);
        [DB.websites].forEach(function (list) {
          list.forEach(function (w, i) {
            if (w._id !== args._id) return;
            list[i] = Object.assign({}, w, {
              name: u.name != null ? u.name : w.name,
              url: u.url != null ? u.url : w.url,
              icon: u.icon != null ? u.icon : w.icon,
              iconKey: u.icon != null ? u.icon : w.iconKey,
              icon_key: u.icon != null ? u.icon : w.icon_key,
              description: u.description !== undefined ? u.description : w.description
            });
            DB.objects[w._id] = list[i];
          });
        });
        save();
        return true;
      },
      removeWebsite: function (_p, args) {
        DB.websites = DB.websites.filter(function (w) { return w._id !== args._id; });
        DB.apps = (DB.apps || []).map(function (row) {
          return row.filter(function (it) { return it.app_id !== args._id; }).map(function (it) {
            if (it.app_ids) it.app_ids = it.app_ids.filter(function (c) { return c.app_id !== args._id; });
            return it;
          });
        });
        delete DB.objects[args._id];
        save();
        return true;
      },

      createAliasWebsite: function (_p, args) {
        var aliasIcon = storedIcon(args.icon);
        var a = {
          __typename: 'AliasWebsite', _id: uid(), name: args.name,
          url: args.url, icon: aliasIcon, iconKey: aliasIcon, icon_key: aliasIcon
        };
        DB.aliases[args.website_id] = a;
        var base = DB.objects[args.website_id];
        if (base) DB.objects[args.website_id] = Object.assign({}, base, { aliasWebsite: a, alias_website: a });
        save();
        return a;
      },
      updateAliasWebsite: function (_p, args) {
        var aliasUpdate = Object.assign({}, args.update || {});
        if (aliasUpdate.icon != null) {
          aliasUpdate.icon = storedIcon(aliasUpdate.icon);
          aliasUpdate.iconKey = aliasUpdate.icon_key = aliasUpdate.icon;
        }
        Object.keys(DB.aliases).forEach(function (wid) {
          if (DB.aliases[wid]._id !== args._id) return;
          DB.aliases[wid] = Object.assign({}, DB.aliases[wid], aliasUpdate);
          var base = DB.objects[wid];
          if (base) DB.objects[wid] = Object.assign({}, base, { aliasWebsite: DB.aliases[wid], alias_website: DB.aliases[wid] });
        });
        save();
        return true;
      },

      createSearch: function (_p, args) {
        var s = {
          __typename: 'ViewerSearch', _id: uid(), name: args.name,
          icon: args.icon || '', icon_key: args.icon || '',
          urls: { __typename: 'SearchUrl', web: args.urls.web, images: null, videos: null, maps: null, news: null }
        };
        DB.searchs.unshift(s);
        DB.objects[s._id] = Object.assign({}, s, { __typename: 'Search' });
        save();
        return { __typename: 'CreateResult', success: true, _id: s._id };
      },
      updateSearch: function (_p, args) {
        DB.searchs.forEach(function (s, i) {
          if (s._id !== args._id) return;
          var u = args.update || {};
          DB.searchs[i] = Object.assign({}, s, {
            name: u.name != null ? u.name : s.name,
            icon: u.icon != null ? u.icon : s.icon,
            icon_key: u.icon != null ? u.icon : s.icon_key,
            urls: u.urls ? Object.assign({}, s.urls, { web: u.urls.web }) : s.urls
          });
          DB.objects[s._id] = Object.assign({}, DB.searchs[i], { __typename: 'Search' });
          refreshUserSearch(s._id, DB.objects[s._id]);
        });
        save();
        return true;
      },
      removeSearch: function (_p, args) {
        DB.searchs = DB.searchs.filter(function (s) { return s._id !== args._id; });
        delete DB.objects[args._id];
        refreshUserSearch(args._id, null);
        save();
        return true;
      },
      updateUserSearch: function (_p, args) { setUserSearch(args.main_search_id, args.search_ids); return true; },

      updateUser: function (_p, args) {
        if (args.nickname != null) DB.userinfo.nickname = args.nickname;
        if (args.avatar != null) {
          DB.userinfo.avatar = args.avatar;
          DB.userinfo.avatar_images = imageObject(args.avatar);
        }
        save();
        return true;
      },
      logout: function () { return true; },
      deleteAccount: function () { resetStore(); return true; },
      bindAuth: function () { return true; },
      unbindAuth: function () { return true; },
      bindEmail: function (_p, args) { DB.userinfo.email = args.email; save(); return true; },
      changeEmail: function (_p, args) { DB.userinfo.email = args.new_email; save(); return true; },
      createCaptcha: function () { return { __typename: 'CreateCaptcha', success: true, _id: uid(), url: null, code: null }; },
      getQiniuToken: function () {
        return { __typename: 'QiniuToken', token: 'ihp-local', key: 'ihp-local', url: 'ihp-local' };
      },

      createUserCategory: function (_p, args) {
        var c = {
          __typename: 'UserCategory', _id: uid(), name: args.name,
          type: args.type, created_at: now(), updated_at: now()
        };
        categories(args.type).push(c);
        save();
        return c;
      },
      updateUserCategory: function (_p, args) {
        Object.keys(DB.categories).forEach(function (t) {
          DB.categories[t].forEach(function (c, i) {
            if (c._id === args._id) DB.categories[t][i] = Object.assign({}, c, { name: args.name, updated_at: now() });
          });
        });
        save();
        return true;
      },
      removeUserCategory: function (_p, args) {
        Object.keys(DB.categories).forEach(function (t) {
          DB.categories[t] = DB.categories[t].filter(function (c) { return c._id !== args._id; });
        });
        DB.readingList.forEach(function (r) {
          if (r.user_category && r.user_category._id === args._id) r.user_category = null;
        });
        save();
        return true;
      },
      sortUserCategoryList: function (_p, args) {
        var order = {};
        (args.list || []).forEach(function (p, i) { order[p._id] = p.position != null ? p.position : i; });
        Object.keys(DB.categories).forEach(function (t) {
          DB.categories[t].sort(function (a, b) {
            return (order[a._id] == null ? 1e9 : order[a._id]) - (order[b._id] == null ? 1e9 : order[b._id]);
          });
        });
        save();
        return true;
      },

      createUserReadingList: function (_p, args) {
        var cat = null;
        if (args.user_category_id) {
          Object.keys(DB.categories).forEach(function (t) {
            DB.categories[t].forEach(function (c) { if (c._id === args.user_category_id) cat = c; });
          });
        }
        var r = {
          __typename: 'UserReadingList', _id: uid(), title: args.title, url: args.url,
          image: args.image ? imageObject(args.image) : null,
          description: args.description || null, is_read: false,
          is_pinned: false, updated_at: now(), user_category: cat
        };
        DB.readingList.unshift(r);
        save();
        return r;
      },
      updateUserReadingList: function (_p, args) {
        DB.readingList.forEach(function (r, i) {
          if (r._id !== args._id) return;
          var cat = r.user_category;
          if (args.user_category_id !== undefined) {
            cat = null;
            Object.keys(DB.categories).forEach(function (t) {
              DB.categories[t].forEach(function (c) { if (c._id === args.user_category_id) cat = c; });
            });
          }
          DB.readingList[i] = Object.assign({}, r, {
            title: args.title != null ? args.title : r.title,
            url: args.url != null ? args.url : r.url,
            is_pinned: args.is_pinned != null ? args.is_pinned : r.is_pinned,
            user_category: cat, updated_at: now()
          });
        });
        save();
        return true;
      },
      readUserReadingList: function (_p, args) {
        DB.readingList.forEach(function (r) { if (r._id === args._id) r.is_read = true; });
        save();
        return true;
      },
      removeUserReadingList: function (_p, args) {
        DB.readingList = DB.readingList.filter(function (r) { return r._id !== args._id; });
        save();
        return true;
      },

      createNote: function (_p, args) {
        var n = {
          __typename: 'Note', _id: uid(), content: args.content,
          position: DB.notes.length, created_at: now(), updated_at: now()
        };
        DB.notes.push(n);
        save();
        return n;
      },
      updateNote: function (_p, args) {
        DB.notes.forEach(function (n, i) {
          if (n._id === args._id) DB.notes[i] = Object.assign({}, n, args.update || {}, { updated_at: now() });
        });
        save();
        return true;
      },
      removeNote: function (_p, args) {
        DB.notes = DB.notes.filter(function (n) { return n._id !== args._id; });
        save();
        return true;
      },

      updateUserCity: function (_p, args) {
        DB.userCity = {
          __typename: 'UserCity', _id: DB.userCity ? DB.userCity._id : uid(),
          qweather_city_id: args.qweather_city_id, lon: args.lon, lat: args.lat,
          timezone: args.timezone, name: args.name,
          created_at: DB.userCity ? DB.userCity.created_at : now(), updated_at: now()
        };
        save();
        return true;
      },
      updateUserControlCenter: function (_p, args) { return merge('userControlCenter', args); },
      updateUserDateAndTime: function (_p, args) { return merge('userDateAndTime', args); },
      updateUserLanguageAndRegion: function (_p, args) { return merge('userLanguageAndRegion', args); },
      updateUserEmailSubscription: function (_p, args) { return merge('userEmailSubscription', args); },
      updateUserUnits: function (_p, args) { return merge('userUnits', args); },
      updateUserCookiePreferences: function (_p, args) {
        // usage analytics stays off no matter what the UI asks for
        return merge('userCookiePreferences', Object.assign({}, args, { is_enable_usage_analysis: false }));
      },
      updateUserQuickNavigation: function (_p, args) {
        DB.userQuickNavigation = {
          __typename: 'UserQuickNavigation',
          quick_navigation_ids: args.quick_navigation_ids || [], updated_at: now()
        };
        save();
        return true;
      },
      updateUserTranslate: function (_p, args) {
        var t = DB.objects[args.translate_id];
        if (t) { DB.userTranslate = { __typename: 'UserTranslate', translate: t, updated_at: now() }; save(); }
        return true;
      },

      updateUserRSSSubscription: function (_p, args) {
        var list = DB.rss.subscribed.filter(function (id) { return id !== args.rss_id; });
        if (args.is_subscribed !== false) list.unshift(args.rss_id);
        DB.rss.subscribed = list;
        save();
        return true;
      },
      readUserRSSSubscription: function (_p, args) { DB.rss.read[args.rss_id] = now(); save(); return true; }
    },

    // `apps` is resolved lazily so a layout only gets hydrated when asked for
    UserApps: {
      apps: function () { return hydrateLayout(DB.apps); }
    }
  };

  function merge(key, args) {
    var target = DB[key] || {};
    var patch = {};
    Object.keys(args).forEach(function (k) { if (args[k] !== undefined && args[k] !== null) patch[k] = args[k]; });
    DB[key] = Object.assign({}, target, patch, { updated_at: now() });
    save();
    return true;
  }

  function normalizeLayout(rows) {
    return (rows || []).map(function (row) {
      return (row || []).map(function (it) {
        var out = { type: it.type };
        if (it.app_id != null) out.app_id = it.app_id;
        if (it.folder_name != null) out.folder_name = it.folder_name;
        if (it.app_ids) out.app_ids = it.app_ids.map(function (c) { return { type: c.type, app_id: c.app_id }; });
        if (it.app_grid_position) out.app_grid_position = { x: it.app_grid_position.x, y: it.app_grid_position.y };
        return out;
      });
    });
  }

  function refreshUserSearch(id, live) {
    var us = DB.userSearch;
    if (!us) return;
    var inList = (us.search || []).some(function (s) { return s._id === id; });
    var isMain = us.main_search && us.main_search._id === id;
    if (!inList && !isMain) return;
    var list = [];
    (us.search || []).forEach(function (s) {
      if (s._id !== id) list.push(s);
      else if (live) list.push(live);
    });
    var main = us.main_search;
    if (isMain) {
      main = live || list[0] || Object.keys(DB.objects).map(function (k) { return DB.objects[k]; })
        .filter(function (o) { return o && o.__typename === 'Search'; })[0] || main;
    }
    DB.userSearch = Object.assign({}, us, { main_search: main, search: list, updated_at: now() });
  }

  function setUserSearch(mainId, ids) {
    var pick = function (id) {
      var o = DB.objects[id] || DB.searchs.filter(function (s) { return s._id === id; })[0] ||
        (SEARCH_CATALOG.allSearch || []).filter(function (s) { return s._id === id; })[0];
      return o ? Object.assign({}, o, { __typename: 'Search' }) : null;
    };
    var list = (ids || []).map(pick).filter(Boolean);
    var main = (mainId && pick(mainId)) || list[0] || (DB.userSearch && DB.userSearch.main_search);
    DB.userSearch = { __typename: 'UserSearch', main_search: main, search: list, updated_at: now() };
    save();
    return DB.userSearch;
  }

  /* ------------------------------------------------------------------ *
   * Favicon cozumu
   *
   * Uygulamanin ikon hatti bir gorseli canvas'a cizip toDataURL ile
   * okuyor. Uzak bir favicon adresi bu hattan gecemiyor: crossOrigin ile
   * yuklenmiyor (favicon servisleri ACAO gondermiyor), crossOrigin'siz
   * yuklenince de canvas "tainted" olup toDataURL SecurityError atiyor.
   * Bu yuzden ikonu burada indirip **data: URL** olarak veriyoruz — ayni
   * kokenli oldugu icin ne CORS ne taint sorunu kaliyor.
   *
   * Kaynak secimi "ilk basarili" degil "en buyugu kazanir": her sitede farkli
   * bir servis daha iyisini veriyor (music.youtube gstatic'te 128, gemini
   * DuckDuckGo'da 512, github ikisinde de 32 ama kendi sitesinde 512).
   * Cikan ikon fix_icons.py'nin urettigi bicime normalize ediliyor: 128x128
   * opak, logo kontrast bir kartin ortasinda. Uygulama dosemeye zemin
   * uygulamiyor (index-DYZBvkyo.css), o yuzden seffaf ikon duvar kagidinin
   * ustunde ciplak duruyor. Istek yalnizca kisayol eklenirken atilir.
   * ------------------------------------------------------------------ */

  var FAVICON_SOURCES = [
    function (host) {
      return 'https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON' +
        '&fallback_opts=TYPE,SIZE,URL&size=128&url=' + encodeURIComponent('https://' + host);
    },
    function (host) { return 'https://icons.duckduckgo.com/ip3/' + host + '.ico'; }
  ];

  // fix_icons.py ile birebir esiklerin hepsi (SIZE, MIN_OK, PAD ve dostlari)
  var ICON_SIZE = 128;
  var ICON_MIN_OK = 64;                                        // altindaki upscale sayilir
  var ICON_PAD = 0.14;
  var ICON_INNER = Math.floor(ICON_SIZE * (1 - 2 * ICON_PAD)); // 92
  var ICON_SRC_MAX = 512;                                      // getImageData maliyet siniri
  var ALPHA_TRIM = 8;
  var ALPHA_LUM = 40;
  var OPAQUE_MIN_A = 250;
  var CORNER_K_DIV = 32;
  var CORNER_SPREAD = 12;
  var BLEED_DIFF = 40;
  var BLEED_COVER = 0.92;
  var LUM_LIGHT = 150;
  var BG_DARK = [28, 28, 30];
  var BG_LIGHT = [255, 255, 255];
  var ASPECT_TOL = 0.05;
  var BADGE_MARK = "data-ihp='badge'";

  var ICON_FAST_MS = 2000;    // gstatic / ddg / _favicon basina
  var ICON_HTML_MS = 2500;    // sitenin kok HTML'i
  var ICON_FILE_MS = 2500;    // aday dosya basina
  var ICON_SITE_MS = 4000;    // site dalinin toplam butcesi

  function blobToDataURL(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error || new Error('read failed')); };
      fr.readAsDataURL(blob);
    });
  }

  function withTimeout(p, ms, ac) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        if (ac) { try { ac.abort(); } catch (e) { /* yoksay */ } }
        reject(new Error('timeout'));
      }, ms);
      p.then(function (v) { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
        function (e) { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    });
  }

  /** reddetmeyen sarmalayici: hata yerine null doner */
  function settled(p) {
    return p.then(function (v) { return v; }, function () { return null; });
  }

  /** indirir; gorsel degilse/bossa/gec kalirsa reddeder */
  function fetchImage(url, ms) {
    var ac = window.AbortController ? new AbortController() : null;
    var opts = { credentials: 'omit' };
    if (ac) opts.signal = ac.signal;
    return withTimeout(REAL_FETCH(url, opts).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);   // 404'te de gorsel dondururler
      return r.blob();
    }).then(function (b) {
      if (!b || b.size < 100 || (b.type || '').indexOf('image') !== 0) throw new Error('not an image');
      return b;
    }), ms || ICON_FAST_MS, ac);
  }

  function fetchImageDataURL(url, ms) {
    return fetchImage(url, ms).then(blobToDataURL);
  }

  /** alan adindan turetilen renkte harf rozeti — base64, cunku kn() atob bekliyor */
  function letterBadge(name, host) {
    var ch = ((name || host || '?').trim()[0] || '?').toUpperCase();
    var seed = 0;
    for (var i = 0; i < (host || '').length; i++) seed = (seed * 31 + host.charCodeAt(i)) >>> 0;
    var rgb = hsvToRgb((seed % 360) / 360, 0.55, 0.72);
    var svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128' " + BADGE_MARK + ">" +
      "<rect width='128' height='128' rx='28' fill='rgb(" + rgb.join(',') + ")'/>" +
      "<text x='64' y='64' fill='white' font-family='-apple-system,Segoe UI,sans-serif' " +
      "font-size='68' font-weight='600' text-anchor='middle' dominant-baseline='central'>" +
      ch.replace(/&/g, '&amp;').replace(/</g, '&lt;') + "</text></svg>";
    return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
  }

  function hsvToRgb(h, s, v) {
    var i = Math.floor(h * 6), f = h * 6 - i;
    var p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    var r = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
    return r.map(function (x) { return Math.round(x * 255); });
  }

  /**
   * Chrome'un kendi favicon deposu: `_favicon/` ayni kokenli oldugu icin
   * CORS'a hic takilmaz ve ag istegi de gerektirmez — yalnizca manifest'teki
   * "favicon" izni. Tarayicinin ziyaret ettigin sitelerin ikonunu tuttugu yer,
   * dolayisiyla host izinleri calismasa bile gercek logo gelir.
   * Bilinmeyen site icin jenerik bir kure donduruyor; onu ayirmak icin bir
   * kez sahte adresle sorup sonucu karsilastiriyoruz.
   */
  var CHROME_FAVICON_FALLBACK = null;

  function chromeFaviconURL(pageUrl) {
    return chrome.runtime.getURL('_favicon/?pageUrl=' + encodeURIComponent(pageUrl) + '&size=128');
  }

  function faviconViaChrome(url) {
    if (!(window.chrome && chrome.runtime && chrome.runtime.getURL)) {
      return Promise.reject(new Error('no chrome api'));
    }
    // getURL senkron patlarsa (izin yok) zincirin tamami cokmesin
    try { chromeFaviconURL(url); } catch (e) { return Promise.reject(e); }
    var probe = CHROME_FAVICON_FALLBACK !== null
      ? Promise.resolve(CHROME_FAVICON_FALLBACK)
      : fetchImageDataURL(chromeFaviconURL('https://ihp-local-unknown.invalid/'))
        .catch(function () { return ''; })
        .then(function (d) { CHROME_FAVICON_FALLBACK = d; return d; });
    return probe.then(function (generic) {
      return fetchImageDataURL(chromeFaviconURL(url)).then(function (d) {
        if (generic && d === generic) throw new Error('chrome has no icon for this site');
        return d;
      });
    });
  }

  /* ---------------- adaylari olcup en buyugunu secme ---------------- */

  function decodeImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var timer = setTimeout(function () { reject(new Error('decode timeout')); }, 5000);
      img.onload = function () { clearTimeout(timer); resolve(img); };
      img.onerror = function () { clearTimeout(timer); reject(new Error('decode failed')); };
      img.src = src;
    });
  }

  /** {src, w, h, mime, order} — blob: uzerinden decode, base64 sismesi yok */
  function measureBlob(blob, order) {
    var objURL = URL.createObjectURL(blob);
    var free = function () { URL.revokeObjectURL(objURL); };
    return decodeImage(objURL).then(function (img) {
      var w = img.naturalWidth || 0, h = img.naturalHeight || 0;
      return blobToDataURL(blob).then(function (data) {
        return { src: data, w: w, h: h, mime: blob.type || '', order: order };
      });
    }).then(function (c) { free(); return c; }, function (e) { free(); throw e; });
  }

  function measureDataURL(data, order) {
    return decodeImage(data).then(function (img) {
      return {
        src: data, w: img.naturalWidth || 0, h: img.naturalHeight || 0,
        mime: (data.split(';')[0] || '').split(':')[1] || '', order: order
      };
    });
  }

  /** vektor her rasteri yener; digerlerinde en uzun kenar */
  function iconScore(c) {
    if (!c) return -1;
    if ((c.mime || '').indexOf('svg') >= 0) return 1000;
    return Math.max(c.w, c.h);
  }

  function pickBest(list) {
    var best = null;
    list.forEach(function (c) {
      if (!c) return;
      if (!best) { best = c; return; }
      var a = iconScore(c), b = iconScore(best);
      if (a > b || (a === b && c.order < best.order)) best = c;
    });
    return best;
  }

  /* ---------------- fix_icons.py'nin canvas portu ---------------- */

  function makeCanvas(w, h) {
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    return cv;
  }

  function ctx2d(cv) {
    var c = cv.getContext('2d', { willReadFrequently: true });
    c.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in c) c.imageSmoothingQuality = 'high';
    return c;
  }

  /**
   * LANCZOS'un karsiligi: tek adimli bilinear buyuk kucultmelerde (512 -> 92)
   * aliasing yapiyor, o yuzden hedefin iki katina inene kadar yarilayarak
   * kucultup son cizimi oyle yapiyoruz.
   */
  function drawScaled(src, sx, sy, sw, sh, dctx, dx, dy, dw, dh) {
    var cur = src, cx = sx, cy = sy, cw = sw, ch = sh;
    while (cw > dw * 2 && ch > dh * 2) {
      var nw = Math.max(dw, Math.floor(cw / 2)), nh = Math.max(dh, Math.floor(ch / 2));
      var tmp = makeCanvas(nw, nh);
      ctx2d(tmp).drawImage(cur, cx, cy, cw, ch, 0, 0, nw, nh);
      cur = tmp; cx = 0; cy = 0; cw = nw; ch = nh;
    }
    dctx.drawImage(cur, cx, cy, cw, ch, dx, dy, dw, dh);
  }

  /** kaynagi dogal boyutunda (en fazla ICON_SRC_MAX) rasterlestirir */
  function rasterOf(img) {
    var w = img.naturalWidth || 0, h = img.naturalHeight || 0;
    if (!w || !h) { w = ICON_SRC_MAX; h = ICON_SRC_MAX; }   // ic boyutu olmayan SVG
    var s = Math.min(1, ICON_SRC_MAX / Math.max(w, h));
    var rw = Math.max(1, Math.round(w * s)), rh = Math.max(1, Math.round(h * s));
    var cv = makeCanvas(rw, rh), c = ctx2d(cv);
    c.drawImage(img, 0, 0, rw, rh);
    return { cv: cv, w: rw, h: rh, data: c.getImageData(0, 0, rw, rh).data };
  }

  function minAlpha(d) {
    var m = 255;
    for (var i = 3; i < d.length; i += 4) {
      if (d[i] < m) { m = d[i]; if (!m) return 0; }
    }
    return m;
  }

  /** PIL getbbox() gibi: sag/alt sinir haric */
  function alphaBBox(d, w, h, thr) {
    var x0 = w, y0 = h, x1 = 0, y1 = 0, found = false, x, y;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > thr) {
          found = true;
          if (x < x0) x0 = x;
          if (x >= x1) x1 = x + 1;
          if (y < y0) y0 = y;
          if (y >= y1) y1 = y + 1;
        }
      }
    }
    return found ? [x0, y0, x1, y1] : null;
  }

  /** dort kosenin ortalamasi ve sapmasi (corner_bg portu) */
  function cornerBG(d, w, h) {
    var k = Math.min(w, h, Math.max(2, Math.floor(w / CORNER_K_DIV)));
    var pts = [[0, 0], [w - k, 0], [0, h - k], [w - k, h - k]];
    var cs = pts.map(function (p) {
      var sr = 0, sg = 0, sb = 0, n = 0, x, y, i;
      for (y = p[1]; y < p[1] + k; y++) {
        for (x = p[0]; x < p[0] + k; x++) {
          i = (y * w + x) * 4; sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; n++;
        }
      }
      return [Math.floor(sr / n), Math.floor(sg / n), Math.floor(sb / n)];
    });
    var avg = [0, 1, 2].map(function (ch) {
      return Math.floor((cs[0][ch] + cs[1][ch] + cs[2][ch] + cs[3][ch]) / 4);
    });
    var spread = 0;
    cs.forEach(function (c) {
      [0, 1, 2].forEach(function (ch) {
        var v = Math.abs(c[ch] - avg[ch]);
        if (v > spread) spread = v;
      });
    });
    return { bg: avg, spread: spread };
  }

  /** PIL'in L cevrimi 601 agirlikli — max kanal farki kullanilmaz */
  function diffBBox(d, w, h, bg, thr) {
    var x0 = w, y0 = h, x1 = 0, y1 = 0, found = false, x, y, i, dl;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = (y * w + x) * 4;
        dl = 0.299 * Math.abs(d[i] - bg[0]) + 0.587 * Math.abs(d[i + 1] - bg[1]) +
          0.114 * Math.abs(d[i + 2] - bg[2]);
        if (dl > thr) {
          found = true;
          if (x < x0) x0 = x;
          if (x >= x1) x1 = x + 1;
          if (y < y0) y0 = y;
          if (y >= y1) y1 = y + 1;
        }
      }
    }
    return found ? [x0, y0, x1, y1] : null;
  }

  /** gorunur piksellerin ortalama parlakligi (~40x40 orneklem, ham sRGB) */
  function sampleLuminance(d, w, x0, y0, cw, ch) {
    var stepY = Math.max(1, Math.floor(ch / 40)), stepX = Math.max(1, Math.floor(cw / 40));
    var tot = 0, n = 0, x, y, i;
    for (y = 0; y < ch; y += stepY) {
      for (x = 0; x < cw; x += stepX) {
        i = ((y0 + y) * w + (x0 + x)) * 4;
        if (d[i + 3] > ALPHA_LUM) {
          tot += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          n++;
        }
      }
    }
    return n ? tot / n : 0;
  }

  /** tile()/pad_onto() ortak kuyrugu: 92'lik kutuya sigdir, karta ortala */
  function paste(srcCv, sx, sy, sw, sh, bg) {
    var scale = Math.min(ICON_INNER / sw, ICON_INNER / sh);   // kisitsiz: kucuk cizim buyur
    var dw = Math.max(1, Math.floor(sw * scale)), dh = Math.max(1, Math.floor(sh * scale));
    var out = makeCanvas(ICON_SIZE, ICON_SIZE), o = ctx2d(out);
    o.fillStyle = 'rgb(' + bg.join(',') + ')';
    o.fillRect(0, 0, ICON_SIZE, ICON_SIZE);
    drawScaled(srcCv, sx, sy, sw, sh, o,
      Math.floor((ICON_SIZE - dw) / 2), Math.floor((ICON_SIZE - dh) / 2), dw, dh);
    return out;
  }

  /** opak kaynagi 128 kareye getirir; kare degilse kenar rengiyle doldurur */
  function squareOpaque(r) {
    var cv = makeCanvas(ICON_SIZE, ICON_SIZE), c = ctx2d(cv);
    if (Math.abs(r.w / r.h - 1) <= ASPECT_TOL) {
      drawScaled(r.cv, 0, 0, r.w, r.h, c, 0, 0, ICON_SIZE, ICON_SIZE);
    } else {
      // object-fit: cover kare olmayani kirpardi, biz zemine oturtuyoruz
      var cb = cornerBG(r.data, r.w, r.h);
      var bg = cb.spread <= CORNER_SPREAD ? cb.bg
        : (sampleLuminance(r.data, r.w, 0, 0, r.w, r.h) > LUM_LIGHT ? BG_DARK : BG_LIGHT);
      c.fillStyle = 'rgb(' + bg.join(',') + ')';
      c.fillRect(0, 0, ICON_SIZE, ICON_SIZE);
      var s = Math.min(ICON_INNER / r.w, ICON_INNER / r.h);
      var dw = Math.max(1, Math.floor(r.w * s)), dh = Math.max(1, Math.floor(r.h * s));
      drawScaled(r.cv, 0, 0, r.w, r.h, c,
        Math.floor((ICON_SIZE - dw) / 2), Math.floor((ICON_SIZE - dh) / 2), dw, dh);
    }
    return { cv: cv, data: c.getImageData(0, 0, ICON_SIZE, ICON_SIZE).data };
  }

  function isLetterBadge(u) {
    if (!u || u.indexOf('data:image/svg+xml;base64,') !== 0) return false;
    try { return atob(u.split(',')[1]).indexOf(BADGE_MARK) >= 0; } catch (e) { return false; }
  }

  /**
   * Her ikonu fix_icons.py'nin urettigi bicime getirir: 128x128, tamamen opak,
   * logo 92'lik kutunun ortasinda. Seffaf ikon kontrast bir karta oturur,
   * cerceveye dayanan opak ikon kendi kenar rengiyle yeniden ortalanir,
   * fotograf/desen olanlar yalnizca yeniden olceklenir.
   */
  function normalizeIcon(src) {
    if (isLetterBadge(src)) return Promise.resolve(src);   // rozet zaten kartin kendisi
    return decodeImage(src).then(function (img) {
      var r = rasterOf(img);
      if (minAlpha(r.data) < OPAQUE_MIN_A) {
        var bb = alphaBBox(r.data, r.w, r.h, ALPHA_TRIM);
        if (!bb) throw new Error('empty image');
        var lum = sampleLuminance(r.data, r.w, bb[0], bb[1], bb[2] - bb[0], bb[3] - bb[1]);
        return paste(r.cv, bb[0], bb[1], bb[2] - bb[0], bb[3] - bb[1],
          lum > LUM_LIGHT ? BG_DARK : BG_LIGHT).toDataURL('image/png');
      }
      var sq = squareOpaque(r);
      var cb = cornerBG(sq.data, ICON_SIZE, ICON_SIZE);
      if (cb.spread > CORNER_SPREAD) return sq.cv.toDataURL('image/png');   // foto/desen
      var bb2 = diffBBox(sq.data, ICON_SIZE, ICON_SIZE, cb.bg, BLEED_DIFF);
      if (!bb2) return sq.cv.toDataURL('image/png');
      var cov = Math.max((bb2[2] - bb2[0]) / ICON_SIZE, (bb2[3] - bb2[1]) / ICON_SIZE);
      if (cov < BLEED_COVER) return sq.cv.toDataURL('image/png');
      return paste(sq.cv, bb2[0], bb2[1], bb2[2] - bb2[0], bb2[3] - bb2[1], cb.bg)
        .toDataURL('image/png');
    });
  }

  function normalizeOrKeep(src) {
    return normalizeIcon(src).catch(function () { return src; });
  }

  /* ---------------- sitenin kendi ikonlari (best_from_site portu) ---------------- */

  function siteIconCandidates(html, root) {
    var out = [], re = /<link[^>]+>/gi, m, tag, hm, sm, score, href;
    while ((m = re.exec(html))) {
      tag = m[0];
      if (!/rel=["']?[^"'>]*icon/i.test(tag)) continue;
      hm = /href=["']([^"']+)/i.exec(tag);
      if (!hm) continue;
      sm = /sizes=["']?(\d+)/i.exec(tag);
      score = sm ? (parseInt(sm[1], 10) || 0)
        : (tag.toLowerCase().indexOf('apple-touch') >= 0 ? 180 : 0);
      try { href = new URL(hm[1], root).href; } catch (e) { continue; }
      out.push({ score: score, url: href });
    }
    out.sort(function (a, b) { return b.score - a.score; });
    out.push({ score: 0, url: root + 'apple-touch-icon.png' });
    out.push({ score: 0, url: root + 'apple-touch-icon-precomposed.png' });
    return out.slice(0, 6);
  }

  function bestFromSite(host) {
    var root = 'https://' + host + '/';
    var ac = window.AbortController ? new AbortController() : null;
    var opts = { credentials: 'omit' };
    if (ac) opts.signal = ac.signal;
    var deadline = Date.now() + ICON_SITE_MS;
    return withTimeout(REAL_FETCH(root, opts).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.text();
    }), ICON_HTML_MS, ac).then(function (html) {
      var cands = siteIconCandidates(html.slice(0, 200000), root);
      var i = 0;
      var next = function () {
        if (i >= cands.length || Date.now() > deadline) return null;
        var u = cands[i++].url;
        return fetchImage(u, ICON_FILE_MS).then(function (b) {
          return measureBlob(b, 0);
        }).then(function (c) {
          return iconScore(c) >= ICON_MIN_OK ? c : next();
        }).catch(next);
      };
      return Promise.resolve().then(next);
    });
  }

  /* ---------------- iki asamali cozucu ---------------- */

  function fastCandidates(url, host) {
    return [
      settled(fetchImage(FAVICON_SOURCES[0](host), ICON_FAST_MS).then(function (b) { return measureBlob(b, 0); })),
      settled(fetchImage(FAVICON_SOURCES[1](host), ICON_FAST_MS).then(function (b) { return measureBlob(b, 1); })),
      settled(faviconViaChrome(url).then(function (d) { return measureDataURL(d, 2); }))
    ];
  }

  /**
   * Bir sitenin ikonunu data: URL olarak verir; hicbir kosulda reddetmez.
   * Asama 1: gstatic + DuckDuckGo + Chrome deposu paralel, en buyugu kazanir.
   * Asama 2: kazanan 64 px'in altindaysa sitenin kendi <link rel=icon>'lari
   * (fix_icons.py da yalnizca dusuk cozunurluklu olanlari boyle yukseltiyor).
   * onUpgrade verilirse asama 2 arkada kosar, form beklemez.
   */
  function faviconDataURL(url, name, onUpgrade) {
    var host;
    try { host = new URL(url).hostname; } catch (e) { return Promise.resolve(letterBadge(name, url || '?')); }
    var deliver = function (c) {
      return c ? normalizeOrKeep(c.src) : Promise.resolve(letterBadge(name, host));
    };
    return Promise.all(fastCandidates(url, host)).then(function (list) {
      var best = pickBest(list);
      if (iconScore(best) >= ICON_MIN_OK) return deliver(best);
      var better = settled(bestFromSite(host)).then(function (c) {
        return c && iconScore(c) > iconScore(best) ? c : best;
      });
      if (typeof onUpgrade === 'function' && best) {
        better.then(function (c) {
          if (c && c !== best) deliver(c).then(function (d) { onUpgrade(d); });
        });
        return deliver(best);
      }
      return withTimeout(better, ICON_SITE_MS, null)
        .catch(function () { return best; })
        .then(deliver);
    }).catch(function () { return letterBadge(name, host); });
  }

  /** hangi kaynak ne veriyor — konsoldan hata ayiklamak icin */
  function iconProbe(url) {
    var host;
    try { host = new URL(url).hostname; } catch (e) { return Promise.resolve({ error: 'bad url' }); }
    var fmt = function (c) { return c ? c.w + 'x' + c.h + ' ' + c.mime : null; };
    return Promise.all(fastCandidates(url, host)).then(function (list) {
      var out = {
        gstatic: fmt(list[0]), duckduckgo: fmt(list[1]), chrome: fmt(list[2]),
        best: fmt(pickBest(list))
      };
      if (iconScore(pickBest(list)) >= ICON_MIN_OK) { out.site = 'skipped'; return out; }
      return settled(bestFromSite(host)).then(function (c) {
        out.site = fmt(c);
        if (c && iconScore(c) > iconScore(pickBest(list))) out.best = fmt(c) + ' (site)';
        return out;
      });
    });
  }

  /**
   * Uygulamanin canvas'li yardimcisinin yerine gecer (bkz. index-B2QeqLFd.js).
   * Popup ve sag tik menusunun gonderdigi favIconUrl buradan geciyor; o da
   * 16-32 px ve cogu zaman seffaf oldugu icin normalize ediliyor.
   */
  function toDataURL(src, name) {
    if (!src) return faviconDataURL(src, name);
    if (isLetterBadge(src)) return Promise.resolve(src);
    var raw = /^data:/.test(src) ? Promise.resolve(src)
      : (/^blob:/.test(src) ? REAL_FETCH(src).then(function (r) { return r.blob(); }).then(blobToDataURL)
        : fetchImageDataURL(src, ICON_FILE_MS));
    return raw.then(normalizeOrKeep).catch(function () { return faviconDataURL(src, name); });
  }

  function dataURLToBlob(u) {
    var head = u.split(',')[0], type = head.split(':')[1].split(';')[0];
    var bin = atob(u.split(',')[1]), arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: type });
  }

  /**
   * Ikonsuz kalmis kisayollari toplu doldurur (konsoldan:
   * `await window.__ihpLocal.repairIcons()`). Yalnizca ikonu bos olanlara
   * dokunur, mevcut ikonlarin ustune yazmaz.
   */
  function repairIcons() {
    var targets = DB.websites.filter(function (w) { return !w.icon && w.url; });
    var done = 0;
    var chain = Promise.resolve();
    targets.forEach(function (w) {
      chain = chain.then(function () {
        return faviconDataURL(w.url, w.name).then(function (data) {
          return saveImage(dataURLToBlob(data));
        }).then(function (marker) {
          w.icon = w.iconKey = w.icon_key = marker;
          DB.objects[w._id] = Object.assign({}, DB.objects[w._id] || {}, w);
          done++;
        }).catch(function (e) { log('icon repair failed for', w.url, e); });
      });
    });
    return chain.then(function () {
      save();
      return { candidates: targets.length, repaired: done };
    });
  }

  /** best-effort metadata for the "add website" form, without any server help */
  function websiteInfo(url) {
    var host;
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return { __typename: 'GetWebsiteInfo', title: null, desc: null, img: null }; }
    var name = host.split('.')[0];
    name = name.charAt(0).toUpperCase() + name.slice(1);
    return pageTitle(url).catch(function () { return ''; }).then(function (title) {
      return { __typename: 'GetWebsiteInfo', title: title || name, desc: null, img: null };
    });
  }

  function pageTitle(url) {
    var ac = window.AbortController ? new AbortController() : null;
    var opts = { credentials: 'omit' };
    if (ac) opts.signal = ac.signal;
    return withTimeout(REAL_FETCH(url, opts).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      var type = r.headers.get('content-type') || '';
      return r.arrayBuffer().then(function (buf) {
        var head = new TextDecoder('latin1').decode(buf.slice(0, 4096));
        var cs = /charset=["']?([\w-]+)/i.exec(type) || /charset=["']?([\w-]+)/i.exec(head);
        var text;
        try { text = new TextDecoder(cs ? cs[1] : 'utf-8').decode(buf); }
        catch (e) { text = new TextDecoder('utf-8').decode(buf); }
        return new DOMParser().parseFromString(text, 'text/html').title.replace(/\s+/g, ' ').trim();
      });
    }), ICON_SITE_MS, ac);
  }

  function rssList(args, ctx, sel) {
    var edgesSel = findField(sel.sel, 'edges', ctx);
    var start = args.after ? parseInt(args.after, 10) || 0 : 0;
    var ids = DB.rss.subscribed.slice(start, start + (args.first || 50));
    var end = start + ids.length;
    return rssByIds(ids, edgesSel ? edgesSel.sel : null, ctx).then(function (edges) {
      return {
        __typename: 'RSSList', edges: edges,
        page_info: { __typename: 'PageInfo', end_cursor: String(end), has_next_page: end < DB.rss.subscribed.length }
      };
    });
  }

  function subscribedFeeds(args, ctx, sel) {
    var empty = {
      __typename: 'RSSFeedListInfo', edges: [],
      page_info: { __typename: 'PageInfo', end_cursor: null, has_next_page: false }
    };
    var cursors = {};
    try { if (args.after) cursors = JSON.parse(atob(args.after)); } catch (e) { cursors = {}; }
    var ids = DB.rss.subscribed.filter(function (id) { return !args.after || cursors[id]; });
    if (!ids.length || !sel.sel) return Promise.resolve(empty);
    var perFeed = Math.max(5, Math.ceil((args.first || 20) / ids.length));
    var usedFrags = collectFragments(sel.sel, ctx.frags);
    var body = 'query IHPFeeds { ' + ids.map(function (id, i) {
      return 'f' + i + ': RSSFeedList(first:' + perFeed +
        (args.after ? ' after:' + JSON.stringify(cursors[id]) : '') +
        ' rss_id:' + JSON.stringify(id) + ') ' + printSelections(sel.sel);
    }).join(' ') + ' }';
    Object.keys(usedFrags).forEach(function (f) {
      body += ' fragment ' + f + ' on ' + ctx.frags[f].on + ' ' + printSelections(ctx.frags[f].sel);
    });
    var when = function (f) { return new Date(f.public_at || f.created_at || 0).getTime() || 0; };
    return remote(body, {}).then(function (j) {
      var d = (j && j.data) || {}, edges = [], next = {}, more = false;
      ids.forEach(function (id, i) {
        var part = d['f' + i];
        if (!part) return;
        edges = edges.concat(part.edges || []);
        var info = part.page_info;
        if (info && info.has_next_page && info.end_cursor) { next[id] = info.end_cursor; more = true; }
      });
      edges.sort(function (a, b) { return when(b) - when(a); });
      return {
        __typename: 'RSSFeedListInfo', edges: edges,
        page_info: { __typename: 'PageInfo', end_cursor: more ? btoa(JSON.stringify(next)) : null, has_next_page: more }
      };
    }).catch(function () { return empty; });
  }

  /** resolve subscribed feed ids through the public RSS(_id:) field */
  function rssByIds(ids, subSel, ctx) {
    if (!ids || !ids.length || !subSel) return Promise.resolve([]);
    var usedFrags = collectFragments(subSel, ctx.frags);
    var body = 'query IHPRss { ' + ids.map(function (id, i) {
      return 'r' + i + ': RSS(_id:' + JSON.stringify(id) + ') ' + printSelections(subSel);
    }).join(' ') + ' }';
    Object.keys(usedFrags).forEach(function (f) {
      body += ' fragment ' + f + ' on ' + ctx.frags[f].on + ' ' + printSelections(ctx.frags[f].sel);
    });
    return remote(body, {}).then(function (j) {
      var d = (j && j.data) || {};
      return ids.map(function (_, i) { return d['r' + i]; }).filter(Boolean);
    }).catch(function () { return []; });
  }

  /** find a named field inside a selection set, looking through fragments */
  function findField(sels, name, ctx) {
    var found = null;
    (sels || []).some(function (s) {
      if (s.kind === 'field' && s.name === name) { found = s; return true; }
      if (s.kind === 'inline') { found = findField(s.sel, name, ctx); return !!found; }
      if (s.kind === 'spread' && ctx.frags[s.name]) { found = findField(ctx.frags[s.name].sel, name, ctx); return !!found; }
      return false;
    });
    return found;
  }

  /* ------------------------------------------------------------------ *
   * Executor
   * ------------------------------------------------------------------ */

  function directiveOk(dirs, vars) {
    if (!dirs) return true;
    for (var i = 0; i < dirs.length; i++) {
      var d = dirs[i];
      if (d.name !== 'include' && d.name !== 'skip') continue;
      var arg = (d.args || []).filter(function (a) { return a[0] === 'if'; })[0];
      if (!arg) continue;
      var v = arg[1].k === 'var' ? vars[arg[1].name] : arg[1].v;
      if (d.name === 'include' && !v) return false;
      if (d.name === 'skip' && v) return false;
    }
    return true;
  }

  function argValue(node, vars) {
    switch (node.k) {
      case 'var': return vars[node.name];
      case 'const': return node.v;
      case 'enum': return node.v;
      case 'list': return node.items.map(function (x) { return argValue(x, vars); });
      case 'obj': {
        var o = {};
        node.fields.forEach(function (f) { o[f[0]] = argValue(f[1], vars); });
        return o;
      }
    }
    return null;
  }

  function argsOf(sel, vars) {
    var out = {};
    (sel.args || []).forEach(function (a) { out[a[0]] = argValue(a[1], vars); });
    return out;
  }

  function execSelections(sels, parentType, obj, ctx) {
    var out = {};
    var chain = Promise.resolve();
    (sels || []).forEach(function (s) {
      chain = chain.then(function () {
        if (!directiveOk(s.dirs, ctx.vars)) return;

        if (s.kind === 'spread') {
          var f = ctx.frags[s.name];
          if (!f || !typeMatches(parentType, f.on)) return;
          return execSelections(f.sel, parentType, obj, ctx).then(function (r) { Object.assign(out, r); });
        }
        if (s.kind === 'inline') {
          if (!typeMatches(parentType, s.on)) return;
          return execSelections(s.sel, parentType, obj, ctx).then(function (r) { Object.assign(out, r); });
        }

        var key = s.alias || s.name;
        if (s.name === '__typename') { out[key] = parentType; return; }

        var fi = fieldInfo(parentType, s.name);
        var res = RESOLVERS[parentType] && RESOLVERS[parentType][s.name];
        var value;
        if (res) value = res(obj, argsOf(s, ctx.vars), ctx, s);
        else value = obj == null ? null : obj[s.name];

        return Promise.resolve(value).then(function (v) {
          return complete(v, fi ? (fi.l || 0) : 0, fi, s, ctx);
        }).then(function (v) { out[key] = v; });
      });
    });
    return chain.then(function () { return out; });
  }

  function complete(value, depth, fi, sel, ctx) {
    if (value === undefined || value === null) {
      return Promise.resolve(fi && fi.l && fi.n ? [] : null);
    }
    if (depth > 0) {
      if (!Array.isArray(value)) return Promise.resolve(null);
      var acc = [];
      var chain = Promise.resolve();
      value.forEach(function (item) {
        chain = chain.then(function () {
          return complete(item, depth - 1, fi, sel, ctx).then(function (r) { acc.push(r); });
        });
      });
      return chain.then(function () { return acc; });
    }
    if (!sel.sel) return Promise.resolve(value);

    var concrete = (value && typeof value === 'object' && value.__typename && SCHEMA[value.__typename])
      ? value.__typename
      : (fi ? fi.t : null);
    if (!concrete) return Promise.resolve(null);
    return execSelections(sel.sel, concrete, value, ctx);
  }

  /* ------------------------------------------------------------------ *
   * Routing: which operations do we answer ourselves?
   * ------------------------------------------------------------------ */

  var LOCAL_ROOTS = {
    Query: { viewer: 1, syncUserApps: 1, newVersion: 1, defaultUserWallpaper: 1, allSearch: 1, defaultMainSearch: 1, defaultSearch: 1, search: 1 },
    Mutation: { viewer: 1, login: 1, register: 1, oauth: 1, resetPassword: 1, createCaptcha: 1, syncUserSearch: 1 }
  };

  function pickOperation(doc, name) {
    if (name) {
      var m = doc.ops.filter(function (o) { return o.name === name; });
      if (m.length) return m[0];
    }
    return doc.ops[0];
  }

  function splitRoots(op, frags) {
    var rootType = op.op === 'mutation' ? 'Mutation' : 'Query';
    var local = [], remoteSels = [];
    function walk(sels) {
      (sels || []).forEach(function (s) {
        if (s.kind === 'field') {
          (LOCAL_ROOTS[rootType][s.name] ? local : remoteSels).push(s);
        } else if (s.kind === 'inline') {
          walk(s.sel);
        } else if (s.kind === 'spread' && frags[s.name]) {
          walk(frags[s.name].sel);
        }
      });
    }
    walk(op.sel);
    return { rootType: rootType, local: local, remote: remoteSels };
  }

  function buildRemoteBody(op, sels, doc) {
    var usedFrags = collectFragments(sels, doc.frags);
    var usedVars = collectVars(sels, doc.frags);
    var defs = op.vars.filter(function (d) { return usedVars[d.name]; });
    var header = defs.length ? '(' + defs.map(function (d) { return '$' + d.name + ':' + d.type + (d.def ? '=' + printValueNode(d.def) : ''); }).join(' ') + ')' : '';
    var body = op.op + ' ' + (op.name || 'IHPSplit') + header + ' ' + printSelections(sels);
    Object.keys(usedFrags).forEach(function (f) {
      body += ' fragment ' + f + ' on ' + doc.frags[f].on + ' ' + printSelections(doc.frags[f].sel);
    });
    return { body: body, defs: defs };
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  function defaults(seed) {
    return {
      v: SEED_VERSION,
      createdAt: now(),
      userinfo: {
        __typename: 'Userinfo', _id: uid(), nickname: 'Local', email: null,
        avatar: null, avatar_images: null, locale: null, use_days_count: 1,
        created_at: now(), last_login_at: now(), has_password: false
      },
      apps: seed.apps,
      appsUpdatedAt: seed.appsUpdatedAt,
      objects: seed.objects || {},
      folderIds: {},
      aliases: {},
      userWallpaper: seed.userWallpaper,
      userSearch: seed.userSearch,
      userUnits: seed.userUnits,
      userControlCenter: seed.userControlCenter,
      userDateAndTime: seed.userDateAndTime,
      userLanguageAndRegion: seed.userLanguageAndRegion,
      userTranslate: seed.userTranslate,
      userQuickNavigation: seed.userQuickNavigation,
      userCity: null,
      userCookiePreferences: {
        __typename: 'UserCookiePreferences',
        is_enable_functionality_and_performance: true,
        is_enable_usage_analysis: false, updated_at: now()
      },
      userEmailSubscription: {
        __typename: 'UserEmailSubscription',
        recommended: false, product_update: false, event: false, promotional: false
      },
      websites: [], wallpapers: [], searchs: [], notes: [], readingList: [],
      categories: { READING_LIST: [] },
      rss: { subscribed: [], read: {} }
    };
  }

  var seedCache = null;
  function loadJSON(path) {
    return REAL_FETCH(chrome.runtime.getURL(path)).then(function (r) {
      if (!r.ok) throw new Error(path + ' -> HTTP ' + r.status);
      return r.json();
    });
  }

  /**
   * Kisisel duzen local/seed.json'da ve depoya girmiyor (.gitignore).
   * Depodan klonlanmis bir kurulumda o dosya yoktur; orada ornek seed devreye
   * girer ve eklenti varsayilan duzenle acilir.
   */
  function loadSeed() {
    return loadJSON('local/seed.json').catch(function () {
      log('local/seed.json yok, ornek seed kullaniliyor');
      return loadJSON('local/seed.example.json');
    });
  }

  function resetStore() {
    return loadSeed().then(function (seed) {
      DB = defaults(seed);
      save();
    });
  }

  var RESTORE_SIGNAL = 'ihp:restored-at';
  var STORE_CACHES = [
    'lscache-USER_APPS', 'lscache-USER_APPS_LOCAL_UPDATE_AT', 'lscache-USER_WALLPAPER',
    'lscache-USER_SEARCH', 'lscache-USERINFO', 'lscache-USER_COOKIE_PREFERENCES', 'CACHE-PERSIST'
  ];

  function validStore(d) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
    if (!d.objects || typeof d.objects !== 'object' || Array.isArray(d.objects)) return false;
    if (!Array.isArray(d.apps) || !d.apps.length) return false;
    return d.apps.every(function (row) {
      return Array.isArray(row) && row.every(function (it) {
        return it && typeof it === 'object' && typeof it.type === 'string';
      });
    });
  }

  function validImages(images) {
    if (typeof images !== 'object' || Array.isArray(images)) return false;
    return Object.keys(images).every(function (id) {
      return /^[0-9a-f]+$/.test(id) && typeof images[id] === 'string' && /^data:[^,]*,/.test(images[id]);
    });
  }

  function exportImages(store) {
    var seen = {}, out = {};
    (JSON.stringify(store).match(/ihplocal:[0-9a-f]+/g) || []).forEach(function (m) {
      seen[m.slice(IMG_PREFIX.length)] = 1;
    });
    return Promise.all(Object.keys(seen).map(function (id) {
      return idbTx('readonly', function (s) { return s.get(id); }).then(function (blob) {
        if (!blob) return;
        return blobToDataURL(blob).then(function (data) { out[id] = data; });
      });
    })).then(function () { return out; });
  }

  function importImages(images) {
    var ids = Object.keys(images);
    if (!ids.length) return Promise.resolve();
    return Promise.all(ids.map(function (id) {
      return REAL_FETCH(images[id]).then(function (r) { return r.blob(); });
    })).then(function (blobs) {
      return idbTx('readwrite', function (s) {
        ids.forEach(function (id, i) { s.put(blobs[i], id); });
      });
    });
  }

  var ready = Promise.all([
    loadJSON('local/schema.json'), loadStore(), loadImages(),
    loadJSON('local/search-catalog.json').catch(function () { return {}; })
  ])
    .then(function (r) {
      SEARCH_CATALOG = r[3];
      SCHEMA = r[0].t;
      CANON = r[0].canon;
      DB = r[1];
      if (DB && DB.v === SEED_VERSION) return;
      return loadSeed().then(function (seed) {
        seedCache = seed;
        DB = defaults(seed);
        save();
      });
    })
    .then(function () { return migrateInlineIcons().catch(function () { }); })
    .then(function () { migrateIconPaths(); migrateRemoteIcons(); })
    .then(function () { return migrateDataWallpapers().catch(function (e) { console.warn('[ihp-local] wallpaper migration failed', e); }); })
    .then(function () { refreshWallpaperPreview(); })
    .catch(function (e) { console.error('[ihp-local] init failed', e); });

  /* ------------------------------------------------------------------ *
   * fetch override
   * ------------------------------------------------------------------ */

  function jsonResponse(payload) {
    return new Response(JSON.stringify(payload), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  }

  function handleEntry(entry) {
    var doc;
    try { doc = parseDocument(entry.query); }
    catch (e) {
      console.warn('[ihp-local] could not parse an operation, forwarding it', e);
      return null;
    }
    var op = pickOperation(doc, entry.operationName);
    if (!op) return null;

    var split = splitRoots(op, doc.frags);
    var names = function (s) { return s.map(function (f) { return f.name; }); };
    var rec = trace({
      op: entry.operationName || op.name || '(anonymous)', kind: op.op,
      local: names(split.local), remote: names(split.remote), status: 'pending'
    });
    if (!split.local.length) { // nothing for us — let it go to the API
      rec.status = 'forwarded';
      return null;
    }

    var ctx = { vars: entry.variables || {}, frags: doc.frags, varDefs: op.vars };
    var work = execSelections(op.sel, split.rootType, split.rootType === 'Query' ? {} : {}, ctx);

    // A mixed operation still needs the remote half.
    var remotePart = split.remote.length
      ? (function () {
        var built = buildRemoteBody(op, split.remote, doc);
        var vars = {};
        built.defs.forEach(function (d) { vars[d.name] = ctx.vars[d.name]; });
        return remote(built.body, vars).then(function (j) { return (j && j.data) || {}; })
          .catch(function () { return {}; });
      })()
      : Promise.resolve(null);

    return Promise.all([work, remotePart]).then(function (r) {
      var data = resolveImages(r[0]);
      if (r[1]) Object.assign(data, r[1]);
      rec.status = 'local';
      return { data: data };
    }).catch(function (e) {
      rec.status = 'error';
      rec.error = String(e && e.message || e);
      console.error('[ihp-local] local execution failed', e, entry.query);
      return { data: null, errors: [{ message: String(e && e.message || e) }] };
    });
  }

  function handleGraphQL(url, init) {
    var body;
    try { body = JSON.parse(init.body); } catch (e) { return REAL_FETCH(url, init); }
    if (init.headers) lastHeaders = normalizeHeaders(init.headers);

    var batched = Array.isArray(body);
    var entries = batched ? body : [body];

    return ready.then(function () {
      var results = new Array(entries.length);
      var pending = [], remoteIdx = [];

      entries.forEach(function (entry, i) {
        var handled = handleEntry(entry);
        if (handled) pending.push(handled.then(function (r) { results[i] = r; }));
        else remoteIdx.push(i);
      });

      var remoteCall = Promise.resolve();
      if (remoteIdx.length) {
        var payload = remoteIdx.map(function (i) { return entries[i]; });
        remoteCall = REAL_FETCH(url, Object.assign({}, init, {
          headers: anonHeaders(normalizeHeaders(init.headers)),
          body: JSON.stringify(batched ? payload : payload[0])
        })).then(function (res) {
          return res.json().then(function (j) {
            var arr = Array.isArray(j) ? j : [j];
            arr.forEach(function (r, k) {
              scrubAuthErrors(r);
              if (r && r.data) { markSubscriptions(r.data); indexObjects(unalias(r.data)); }
              results[remoteIdx[k]] = r;
            });
            trimObjects();
            save();
          });
        }).catch(function (e) {
          console.warn('[ihp-local] upstream request failed', e);
          remoteIdx.forEach(function (i) {
            results[i] = { data: null, errors: [{ message: 'offline' }] };
          });
        });
      }

      return Promise.all(pending.concat([remoteCall])).then(function () {
        // A hole in `results` would serialise as JSON null, and Apollo reads
        // `extensions` off every entry — so make sure each slot is an object.
        for (var i = 0; i < results.length; i++) {
          if (!results[i]) {
            console.warn('[ihp-local] no result produced for entry', i, entries[i] && entries[i].operationName);
            results[i] = { data: null, errors: [{ message: 'no result produced locally' }] };
          }
        }
        return jsonResponse(batched ? results : results[0]);
      });
    });
  }

  function normalizeHeaders(h) {
    var out = {};
    if (!h) return out;
    if (typeof h.forEach === 'function' && !Array.isArray(h)) { h.forEach(function (v, k) { out[k] = v; }); return out; }
    if (Array.isArray(h)) { h.forEach(function (p) { out[p[0]] = p[1]; }); return out; }
    Object.keys(h).forEach(function (k) { out[k] = h[k]; });
    return out;
  }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var host = '';
    try { host = new URL(url, location.href).hostname; } catch (e) { }

    if (host && BLOCKED_HOST.test(host)) {
      log('blocked', url);
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    }

    if (url.indexOf('/graphql') >= 0 && init && init.body && typeof init.body === 'string') {
      return handleGraphQL(url, init);
    }
    return REAL_FETCH(input, init);
  };

  // Amplitude also ships over sendBeacon.
  var realBeacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
  if (realBeacon) {
    navigator.sendBeacon = function (url, data) {
      var host = '';
      try { host = new URL(url, location.href).hostname; } catch (e) { }
      if (host && BLOCKED_HOST.test(host)) return true;
      return realBeacon(url, data);
    };
  }

  /* ------------------------------------------------------------------ *
   * Public surface (used by the patched upload helper)
   * ------------------------------------------------------------------ */

  window.__ihpLocal = {
    ready: ready,
    saveImage: function (blob) { return saveImage(blob); },
    favicon: function (url, name, onUpgrade) { return faviconDataURL(url, name, onUpgrade); },
    toDataURL: function (src, name) { return toDataURL(src, name); },
    normalize: function (src) { return normalizeIcon(src); },
    iconProbe: function (url) { return iconProbe(url); },
    repairIcons: function () { return repairIcons(); },
    reset: function () { return resetStore().then(function () { location.reload(); }); },
    dump: function () { return DB; },
    trace: function () { return TRACE; },

    /**
     * iCloud'daki aynadan geri yukleme. Hem aynanin tamamini
     * ({app, storage: {...}}) hem de dogrudan store nesnesini kabul eder.
     * Yazma tamamlanmadan sayfayi yenilemiyoruz — save() 200ms geciktirmeli.
     */
    exportImages: function () { return exportImages(DB); },
    restore: function (payload) {
      var data = payload && payload.storage ? payload.storage[STORE_KEY] : payload;
      var images = (payload && payload.images) || {};
      if (!validStore(data) || !validImages(images)) {
        return Promise.reject(new Error('beklenen bicimde bir yedek degil'));
      }
      return importImages(images).then(loadSeed).then(function (seed) {
        data = Object.assign(defaults(seed), data);
        data.v = SEED_VERSION;
        data.appsUpdatedAt = now();
        freezeStore();
        DB = data;
        return new Promise(function (resolve, reject) {
          try {
            if (storageArea) {
              var o = {}; o[STORE_KEY] = DB;
              storageArea.set(o, function () { resolve(); });
            } else {
              localStorage.setItem(STORE_KEY, JSON.stringify(DB));
              resolve();
            }
          } catch (e) { reject(e); }
        });
      }).then(function () {
        try {
          STORE_CACHES.forEach(function (k) { localStorage.removeItem(k); });
          localStorage.setItem(RESTORE_SIGNAL, String(now()));
        } catch (e) { /* private mode */ }
        location.reload();
      });
    }
  };

  window.addEventListener('storage', function (e) {
    if (e.key !== RESTORE_SIGNAL || !e.newValue) return;
    freezeStore();
    location.reload();
  });
})();
