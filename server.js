// Folio — online/offline ebook reader server.
// No dependencies: Node 18+ (built-in fetch). Run: node server.js
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const TEXT_DIR = path.join(DATA_DIR, 'texts');
const COVER_DIR = path.join(DATA_DIR, 'covers');
const VI_DIR = path.join(DATA_DIR, 'vi');
const CATALOG_FILE = path.join(DATA_DIR, 'catalog.json');

const REFRESH_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const CHECK_EVERY_MS = 60 * 60 * 1000;               // check hourly
const CATALOG_VERSION = 2;                           // bump to force a rebuild with new sources
const PER_CATEGORY_INITIAL = 4;                      // Gutenberg books per category on first build
const PER_CATEGORY_REFRESH = 2;                      // ...and on every 3-day refresh
const SE_INITIAL = 6;                                // Standard Ebooks new releases
const SE_REFRESH = 4;
const STORE_PER_GENRE = 10;                          // paid books per store section
const MIN_WORDS = 8000;                              // skip pamphlets/speeches
const MAX_BOOKS = 400;

const { CATEGORIES, STORE_GENRES, makeSources } = require('./sources');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

let catalog = { updatedAt: 0, nextRefreshAt: 0, books: [], store: [], skipped: [] };
let refreshing = null;
let sources;

// ---------- helpers ----------
async function fetchWithTimeout(url, ms = 30000, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', ...opts, headers: { 'User-Agent': 'FolioReader/1.0', ...(opts.headers || {}) } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); } catch (e) { out[idx] = null; console.warn('  !', e.message); }
    }
  });
  await Promise.all(workers);
  return out;
}

// Strip the Project Gutenberg licence header/footer.
function stripGutenberg(raw) {
  let text = raw.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  const start = text.search(/^\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG.*$/im);
  if (start !== -1) text = text.slice(text.indexOf('\n', start) + 1);
  const end = text.search(/^\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG/im);
  if (end !== -1) text = text.slice(0, end);
  return text.trim();
}

// Reader paragraphs: [{h: isHeading, t: text}]. Indices are shared by EN and VI.
function parseParas(text) {
  return toParagraphs(text)
    .filter(p => !/^\[Illustration[^\]]*\]?$/i.test(p))
    .map(p => ({
      h: p.length < 70 && (/^(CHAPTER|Chapter|BOOK|Book|PART|Part|PREFACE|Preface|INTRODUCTION|Introduction|PROLOGUE|EPILOGUE|LETTER|Letter|STAVE|ACT)\b/.test(p)
        || (p === p.toUpperCase() && /[A-Z]{3}/.test(p) && p.length < 50)),
      t: p,
    }));
}

const parasCache = new Map(); // id -> paras (small LRU)
async function getParas(book) {
  if (parasCache.has(book.id)) return parasCache.get(book.id);
  const paras = parseParas(await getBookText(book));
  parasCache.set(book.id, paras);
  if (parasCache.size > 8) parasCache.delete(parasCache.keys().next().value);
  return paras;
}

// ---------- translation (EN -> VI, Google's free endpoint) ----------
// sl=auto: search can open books in any language, not only English.
const TRANSLATE_URL = 'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=vi';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function translateBatch(strings) {
  // The endpoint changes its response shape for a single q, so always send at least two.
  const qs = strings.length === 1 ? [...strings, '.'] : strings;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchWithTimeout(TRANSLATE_URL, 45000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: qs.map(s => 'q=' + encodeURIComponent(s)).join('&'),
      });
      const out = await res.json();
      if (!Array.isArray(out) || out.length !== qs.length) throw new Error('Translation length mismatch');
      return out.slice(0, strings.length).map(x => (Array.isArray(x) ? x[0] : x));
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

// Split into requests of <= 120 items / ~15k chars.
async function translateMany(strings) {
  const groups = [];
  let cur = [], size = 0;
  for (const s of strings) {
    if (cur.length && (cur.length >= 120 || size + s.length > 15000)) { groups.push(cur); cur = []; size = 0; }
    cur.push(s); size += s.length;
  }
  if (cur.length) groups.push(cur);
  const results = await mapLimit(groups, 2, g => translateBatch(g));
  if (results.some(r => !r)) throw new Error('Dịch thất bại, thử lại sau');
  return results.flat();
}

const viCache = new Map();  // id -> {index: text}
const viLocks = new Map();  // id -> promise chain, so one book never translates the same range twice
async function loadVi(id) {
  if (!viCache.has(id)) {
    let data = {};
    try { data = JSON.parse(await fsp.readFile(path.join(VI_DIR, `${safeName(id)}.json`), 'utf8')); } catch {}
    viCache.set(id, data);
  }
  return viCache.get(id);
}

async function getViRange(book, start, end) {
  if (book.lang === 'vi') {
    // Vietnamese originals (Wikisource) need no translation.
    const paras = await getParas(book);
    return { total: paras.length, start, paras: paras.slice(start, Math.min(end, paras.length)) };
  }
  const prev = viLocks.get(book.id) || Promise.resolve();
  const job = prev.catch(() => {}).then(async () => {
    const paras = await getParas(book);
    end = Math.min(end, paras.length);
    const vi = await loadVi(book.id);
    const missing = [];
    for (let i = start; i < end; i++) if (vi[i] == null) missing.push(i);
    if (missing.length) {
      const out = await translateMany(missing.map(i => paras[i].t));
      missing.forEach((i, k) => { vi[i] = out[k]; });
      await fsp.writeFile(path.join(VI_DIR, `${safeName(book.id)}.json`), JSON.stringify(vi), 'utf8');
    }
    const list = [];
    for (let i = start; i < end; i++) list.push({ h: paras[i].h, t: vi[i] });
    return { total: paras.length, start, paras: list };
  });
  viLocks.set(book.id, job);
  return job;
}

// Title, preface (or store description) and subjects in Vietnamese for the slides.
async function translateMeta(book) {
  const intro = book.preface || book.description || '';
  const subjects = book.subjects || [];
  const [title, introVi, ...rest] = await translateMany([book.title, intro || '.', ...subjects]);
  book.titleVi = title;
  if (book.preface) book.prefaceVi = introVi; else book.descriptionVi = introVi;
  book.subjectsVi = rest;
  book.translated = true;
}

function toParagraphs(text) {
  return text
    .split(/\n\s*\n/)
    .map(p => p.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').replace(/_/g, '').trim())
    .filter(Boolean);
}

// Find the book's opening words: preface/introduction if present, else chapter one.
function extractPreface(text) {
  const head = text.slice(0, Math.floor(text.length * 0.35));
  const patterns = [
    [/^[ \t]*(PREFACE|Preface|FOREWORD|Foreword|INTRODUCTION|Introduction|PROLOGUE|Prologue|TO THE READER)\.?[ \t]*$/m, null],
    [/^[ \t]*(CHAPTER|Chapter)\s+(I|1|ONE|One)\b.*$/m, 'Chapter I'],
  ];
  let startIdx = -1;
  let label = 'Opening';
  // A real heading is followed by prose; a table-of-contents entry is followed by more short lines.
  const followedByProse = idx => text.slice(idx, idx + 700).split('\n').some(l => l.trim().length > 60);
  for (const [re, fixed] of patterns) {
    const m = [...head.matchAll(new RegExp(re.source, 'gm'))].find(m => followedByProse(m.index + m[0].length));
    if (m) {
      startIdx = m.index + m[0].length;
      label = fixed || m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
      break;
    }
  }
  const body = startIdx >= 0 ? text.slice(startIdx) : text;
  // Drop blocks made of short lines (contents lists, verse epigraphs, title pages).
  const blocks = body.split(/\n\s*\n/).filter(b => {
    const lines = b.split('\n').filter(l => l.trim());
    return lines.length < 3 || lines.reduce((s, l) => s + l.trim().length, 0) / lines.length > 45;
  });
  const paras = toParagraphs(blocks.join('\n\n')).filter(p => p.length > 140 && !/^\[?Illustration/i.test(p) && !/^(CHAPTER|Chapter)\s+[IVXLC\d]+\b/.test(p));
  let out = '';
  for (const p of paras) {
    out += (out ? '\n\n' : '') + p;
    if (out.length > 900) break;
  }
  if (out.length > 1100) {
    const cut = out.slice(0, 1100);
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('." '), cut.lastIndexOf('? '));
    out = (lastStop > 500 ? cut.slice(0, lastStop + 1) : cut) + ' …';
  }
  return { label, text: out };
}

// Gutenberg files go through the mirror fallback; everything else is fetched directly.
const fetchSource = (url, ms) => (sources.isGutenbergUrl(url) ? sources.fetchGutenberg(url, ms) : fetchWithTimeout(url, ms));

// Ids can contain Vietnamese letters, spaces, "/"… — make them safe as file names.
const safeName = id => encodeURIComponent(id).replace(/[%*]/g, '_');

async function getBookText(book) {
  const file = path.join(TEXT_DIR, `${safeName(book.id)}.txt`);
  try { return await fsp.readFile(file, 'utf8'); } catch {}
  let text;
  if (book.text != null) {
    text = book.text;                          // Wikisource: fetched with the book record
  } else {
    if (!book.textUrl) throw new Error(`No text for book ${book.id}`);
    const raw = await (await fetchSource(book.textUrl, 120000)).text();
    text = book.source === 'standardebooks' ? sources.seHtmlToText(raw)
      : book.source === 'internetarchive' ? sources.iaTextToText(raw)
      : stripGutenberg(raw);
  }
  await fsp.writeFile(file, text, 'utf8');
  return text;
}

// Any readable book by id: the curated catalog first, then built on demand from the open sources.
const adhoc = new Map();
async function findBook(id) {
  const inCatalog = catalog.books.find(b => b.id === id);
  if (inCatalog) return inCatalog;
  if (adhoc.has(id)) return adhoc.get(id);
  let book = null;
  if (/^\d+$/.test(id)) book = sources.pgBook(+id);
  else if (id.startsWith('ia~')) book = await sources.iaBook(id.slice(3));
  else if (id.startsWith('ws~')) {
    const ws = await sources.wsBook(id);
    // The page may redirect; store the text under the id the client asked for.
    book = { ...ws, id };
  }
  if (!book) return null;
  adhoc.set(id, book);
  if (adhoc.size > 200) adhoc.delete(adhoc.keys().next().value);
  return book;
}

// Preface/word count for an on-demand book, plus a Vietnamese preface if asked.
async function bookMeta(book, lang) {
  if (!book.preface) {
    const text = await getBookText(book);
    const pre = extractPreface(text);
    book.preface = pre.text;
    book.prefaceLabel = pre.label;
    book.words = text.split(/\s+/).length;
  }
  if (lang === 'vi' && book.lang !== 'vi' && !book.translated && book.preface) await translateMeta(book);
  const { text, textUrl, coverUrl, ...meta } = book;
  return { ...meta, cover: (coverUrl || book.source === 'gutenberg') ? `/api/cover/${encodeURIComponent(book.id)}` : null };
}

// ---------- search ----------
const SEARCH_PAGE = 20;
const detailsCache = new Map();

async function search({ q, scope, page, cat }) {
  const counts = {};
  let hasMore = false;
  const open = b => ({ ...b, access: 'open', cover: b.coverUrl ? `/api/cover/${encodeURIComponent(b.id)}` : null });

  // No query: browse the whole Gutenberg category.
  if (!q) {
    const r = sources.pgSearch('', { category: cat || 'classics', offset: (page - 1) * SEARCH_PAGE, limit: SEARCH_PAGE });
    return { results: r.items.map(open), hasMore: page * SEARCH_PAGE < r.total, counts: { gutenberg: r.total } };
  }

  const results = [];
  const jobs = [];
  if (scope !== 'buy') {
    const pg = sources.pgSearch(q, { category: cat, offset: (page - 1) * 8, limit: 8 });
    counts.gutenberg = pg.total;
    if (page * 8 < pg.total) hasMore = true;
    results.push(...pg.items.map(open));
    if (!cat) {
      jobs.push(sources.wsSearch(q, { offset: (page - 1) * 6, limit: 6 }).then(r => {
        counts.wikisource = r.total;
        if (page * 6 < r.total) hasMore = true;
        return r.items;
      }).catch(e => { console.warn('Wikisource search:', e.message); return []; }));
    }
  }
  if (!cat) {
    jobs.push(sources.olSearch(q, { page, limit: SEARCH_PAGE, openOnly: scope === 'open' }).then(r => {
      counts.openlibrary = r.total;
      if (page * SEARCH_PAGE < r.total) hasMore = true;
      return r.items.map(b => ({ ...b, cover: b.coverUrl }));
    }).catch(e => { console.warn('Open Library search:', e.message); return []; }));
  }
  const [first = [], second = []] = await Promise.all(jobs);
  const ws = scope === 'buy' || cat ? [] : first;
  const ol = scope === 'buy' || cat ? first : second;

  // Skip Open Library entries that duplicate a Gutenberg result we can already read.
  const key = b => sources.normTitle(b.title) + '|' + sources.normTitle((b.authors[0] || {}).name || '').split(' ').pop();
  const seen = new Set(results.map(key));
  results.push(...ws, ...ol.filter(b => !seen.has(key(b))));
  return { results, hasMore, counts };
}

// Description + a market price for a search result (cached).
async function details({ key, title, author, lang }) {
  const ck = [key, title, author, lang].join('|');
  if (detailsCache.has(ck)) return detailsCache.get(ck);
  const [description, offer] = await Promise.all([
    key ? sources.olDescription(key).catch(() => '') : '',
    title ? sources.applePrice(title, author).catch(() => null) : null,
  ]);
  const clean = description.replace(/\(\[source\]\[\d+\]\)|\[\d+\]: \S+|-{3,}[\s\S]*$/g, '').trim();
  let descriptionVi = '';
  if (lang === 'vi' && clean) descriptionVi = (await translateMany([clean]).catch(() => ['']))[0];
  const out = { description: clean, descriptionVi, offer };
  detailsCache.set(ck, out);
  if (detailsCache.size > 500) detailsCache.delete(detailsCache.keys().next().value);
  return out;
}

// ---------- catalog refresh ----------
async function loadCatalog() {
  try {
    catalog = JSON.parse(await fsp.readFile(CATALOG_FILE, 'utf8'));
    console.log(`Loaded catalog: ${catalog.books.length} books, updated ${new Date(catalog.updatedAt).toISOString()}`);
  } catch {
    console.log('No catalog yet.');
  }
}

async function saveCatalog() {
  await fsp.writeFile(CATALOG_FILE, JSON.stringify(catalog, null, 2), 'utf8');
}

// Bring a v1 catalog (Gutendex, numeric ids) up to the current shape.
function migrateCatalog() {
  catalog.store = catalog.store || [];
  const seeds = new Set(CATEGORIES.flatMap(c => c.seeds.map(String)));
  catalog.skipped = (catalog.skipped || []).filter(id => !seeds.has(id));
  for (const b of catalog.books) {
    b.id = String(b.id);
    b.source = b.source || 'gutenberg';
    if (b.source === 'gutenberg') {
      b.sourceUrl = b.sourceUrl || `https://www.gutenberg.org/ebooks/${b.id}`;
      b.categories = sources.pgCategories(b.id);
    }
    if (b.prefaceVi) b.translated = true;
  }
}

async function addFreeBooks(isFirst) {
  const known = new Set([...catalog.books.map(b => b.id), ...catalog.skipped]);
  const fresh = [];
  for (const cat of CATEGORIES) fresh.push(...sources.pgPick(cat, isFirst ? PER_CATEGORY_INITIAL : PER_CATEGORY_REFRESH, known));
  try { fresh.push(...await sources.seLatest(isFirst ? SE_INITIAL : SE_REFRESH, known)); }
  catch (e) { console.warn('Standard Ebooks unavailable:', e.message); }
  console.log(`Fetching ${fresh.length} new books…`);

  const now = Date.now();
  const withPreface = await mapLimit(fresh, 4, async book => {
    const text = await getBookText(book);
    const words = text.split(/\s+/).length;
    const pre = extractPreface(text);
    // Hand-picked seeds are kept even when short (e.g. "As a Man Thinketh").
    if ((words < MIN_WORDS && !book.seed) || !pre.text) { catalog.skipped.push(book.id); return null; }
    console.log(`  + [${book.categories.join(',')}] ${book.id} ${book.title.slice(0, 50)}`);
    const { seed, ...rest } = book;
    return { ...rest, preface: pre.text, prefaceLabel: pre.label, words, addedAt: now };
  });
  return withPreface.filter(Boolean);
}

// Paid section: replaced on each refresh with the current Apple Books charts.
async function refreshStore() {
  const old = new Map(catalog.store.map(b => [b.id, b]));
  const next = [];
  for (const g of STORE_GENRES) {
    try {
      for (const item of await sources.storeChart(g, STORE_PER_GENRE)) {
        if (next.some(b => b.id === item.id)) continue;
        const prev = old.get(item.id);
        // Keep earlier translations; flag books that just entered the chart.
        next.push(prev ? { ...item, titleVi: prev.titleVi, descriptionVi: prev.descriptionVi, translated: prev.translated, isNew: false }
                       : { ...item, isNew: old.size > 0 });
      }
    } catch (e) {
      console.warn(`Store chart ${g.key} unavailable:`, e.message);
      next.push(...catalog.store.filter(b => b.category === g.key && !next.some(x => x.id === b.id)));
    }
  }
  if (next.length) catalog.store = next;
  console.log(`Store: ${catalog.store.length} paid books`);
}

async function refreshCatalog() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    await sources.loadPgIndex(REFRESH_INTERVAL_MS);
    migrateCatalog();
    const isFirst = catalog.books.length === 0;
    const isUpgrade = catalog.version !== CATALOG_VERSION;
    console.log(`Refreshing catalog${isUpgrade ? ' (upgrade to new sources)' : ''}…`);

    const added = await addFreeBooks(isFirst || isUpgrade);
    catalog.books = [...added, ...catalog.books].slice(0, MAX_BOOKS);
    await refreshStore();

    const now = Date.now();
    catalog.version = CATALOG_VERSION;
    catalog.updatedAt = now;
    catalog.nextRefreshAt = now + REFRESH_INTERVAL_MS;
    // The very first batch is the base library, not "new".
    catalog.lastAdded = isFirst ? [] : added.map(b => b.id);
    await saveCatalog();
    console.log(`Catalog refreshed: +${added.length}, total ${catalog.books.length}. Next refresh ${new Date(catalog.nextRefreshAt).toISOString()}`);
    await Promise.all([ensureViMeta(), ensureCovers()]);
  })().catch(e => console.error('Refresh failed:', e.message)).finally(() => { refreshing = null; });
  return refreshing;
}

// Download covers ahead of time so slides don't wait on the upstream image servers.
async function getCover(book) {
  const file = path.join(COVER_DIR, `${safeName(book.id)}.jpg`);
  try { return await fsp.readFile(file); } catch {}
  const data = Buffer.from(await (await fetchSource(book.coverUrl, 30000)).arrayBuffer());
  await fsp.writeFile(file, data);
  return data;
}

async function ensureCovers() {
  await mapLimit([...catalog.books, ...catalog.store].filter(b => b.coverUrl), 6, getCover);
  console.log('Covers cached.');
}

// Backfill Vietnamese titles/prefaces/descriptions for anything not translated yet.
async function ensureViMeta() {
  const todo = [...catalog.books, ...catalog.store].filter(b => !b.translated);
  if (!todo.length) return;
  console.log(`Translating ${todo.length} entries to Vietnamese…`);
  // Save as we go so the client sees translations appear progressively.
  let done = 0;
  await mapLimit(todo, 3, async b => { await translateMeta(b); if (++done % 10 === 0) await saveCatalog(); });
  await saveCatalog();
  console.log('Vietnamese metadata ready.');
}

function maybeRefresh() {
  if (!catalog.books.length || catalog.version !== CATALOG_VERSION || Date.now() >= (catalog.nextRefreshAt || 0)) return refreshCatalog();
}

// ---------- http ----------
function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}
function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' });
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  try {
    const data = await fsp.readFile(file);
    send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  } catch {
    // SPA fallback
    const data = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'));
    send(res, 200, data, { 'Content-Type': MIME['.html'] });
  }
}

// Per-IP rate limits, so a public deployment can't be used to hammer the upstream APIs.
const LIMITS = { search: 40, translate: 40, api: 400 };   // requests per minute
const hits = new Map();
function rateLimited(req, bucket) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const key = `${bucket}|${ip}`;
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now - h.start > 60000) { hits.set(key, { start: now, n: 1 }); return false; }
  return ++h.n > LIMITS[bucket];
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now - h.start > 60000) hits.delete(k); }, 60000).unref();

const isLoopback = req => /^(::1|127\.|::ffff:127\.)/.test(req.socket.remoteAddress || '') && !req.headers['x-forwarded-for'];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  if (p.startsWith('/api/')) {
    const bucket = p === '/api/search' || p === '/api/details' ? 'search' : /\/vi$|\/meta$|^\/api\/translate$/.test(p) ? 'translate' : 'api';
    if (rateLimited(req, bucket)) return sendJson(res, 429, { error: 'Quá nhiều yêu cầu, thử lại sau một phút.' });
  }
  try {
    if (p === '/api/catalog') {
      if (!catalog.books.length && refreshing) await refreshing;
      const withCover = ({ textUrl, coverUrl, ...b }) => ({ ...b, cover: `/api/cover/${encodeURIComponent(b.id)}` });
      return sendJson(res, 200, {
        updatedAt: catalog.updatedAt,
        nextRefreshAt: catalog.nextRefreshAt,
        lastAdded: catalog.lastAdded || [],
        refreshing: !!refreshing,
        categories: CATEGORIES.map(({ key, vi, en }) => ({ key, vi, en })),
        storeCategories: STORE_GENRES.map(({ key, vi, en }) => ({ key, vi, en })),
        books: catalog.books.map(withCover),
        store: (catalog.store || []).map(withCover),
      });
    }

    if (p === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
      const scope = ['all', 'open', 'buy'].includes(url.searchParams.get('scope')) ? url.searchParams.get('scope') : 'all';
      const page = Math.max(1, Math.min(50, parseInt(url.searchParams.get('page'), 10) || 1));
      const cat = url.searchParams.get('cat') || '';
      return sendJson(res, 200, await search({ q, scope, page, cat: CATEGORIES.some(c => c.key === cat) ? cat : '' }));
    }

    // Translate paragraphs sent by the client (imported books, selected passages). Nothing is stored.
    if (p === '/api/translate' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 120000) return sendJson(res, 413, { error: 'Đoạn văn quá dài' });
      }
      let texts;
      try { texts = JSON.parse(body).texts; } catch { return sendJson(res, 400, { error: 'Bad JSON' }); }
      if (!Array.isArray(texts) || !texts.length || texts.length > 400 || texts.some(t => typeof t !== 'string')) return sendJson(res, 400, { error: 'texts must be 1–400 strings' });
      return sendJson(res, 200, { texts: await translateMany(texts.map(t => t || '.')) });
    }

    if (p === '/api/details') {
      const g = k => (url.searchParams.get(k) || '').slice(0, 300);
      const key = /^\/works\/OL\d+W$/.test(g('key')) ? g('key') : '';
      return sendJson(res, 200, await details({ key, title: g('title'), author: g('author'), lang: g('lang') }));
    }

    let m = p.match(/^\/api\/books\/([^/]+)\/(text|paras|vi|meta)$/);
    if (m) {
      const book = await findBook(decodeURIComponent(m[1]));
      if (!book) return sendJson(res, 404, { error: 'Book not found' });
      if (m[2] === 'meta') return sendJson(res, 200, await bookMeta(book, url.searchParams.get('lang')));
      if (m[2] === 'text') {
        const text = await getBookText(book);
        return send(res, 200, text, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
      }
      if (m[2] === 'paras') {
        const paras = await getParas(book);
        return sendJson(res, 200, { total: paras.length, paras });
      }
      // /vi?start=0&end=200 — translated on demand, cached on disk.
      const start = Math.max(0, parseInt(url.searchParams.get('start'), 10) || 0);
      const end = Math.min(start + 400, parseInt(url.searchParams.get('end'), 10) || start + 100);
      return sendJson(res, 200, await getViRange(book, start, end));
    }

    m = p.match(/^\/api\/cover\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const book = (catalog.store || []).find(b => b.id === id) || await findBook(id).catch(() => null);
      if (!book || !book.coverUrl) return send(res, 404, 'No cover');
      const data = await getCover(book);
      return send(res, 200, data, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800' });
    }

    if (p === '/api/refresh' && req.method === 'POST') {
      // Public deployments need the REFRESH_TOKEN; locally it's open to this machine only.
      const token = process.env.REFRESH_TOKEN;
      if (token ? req.headers['x-refresh-token'] !== token : !isLoopback(req)) return sendJson(res, 403, { error: 'Forbidden' });
      catalog.nextRefreshAt = 0;
      refreshCatalog();
      return sendJson(res, 202, { ok: true });
    }

    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
    return serveStatic(req, res, p);
  } catch (e) {
    console.error(e);
    sendJson(res, 502, { error: e.message });
  }
});

(async () => {
  for (const d of [DATA_DIR, TEXT_DIR, COVER_DIR, VI_DIR]) await fsp.mkdir(d, { recursive: true });
  sources = makeSources({ fetchWithTimeout, DATA_DIR });
  await loadCatalog();
  try { await sources.loadPgIndex(REFRESH_INTERVAL_MS, { offline: true }); migrateCatalog(); }
  catch (e) { console.warn('Gutenberg catalog unavailable:', e.message); }

  // `node server.js --refresh-once`: rebuild the catalog snapshot and exit (used by the GitHub Action).
  if (process.argv.includes('--refresh-once')) {
    const before = catalog.updatedAt;
    // Always rebuild the committed Gutenberg index here (the checkout's file times are not its age).
    await sources.loadPgIndex(0).catch(e => console.warn('Gutenberg index:', e.message));
    await refreshCatalog();
    if (catalog.updatedAt === before) { console.error('Refresh did not complete.'); process.exit(1); }
    process.exit(0);
  }

  if (!maybeRefresh()) {
    ensureViMeta().catch(e => console.error('Translate failed:', e.message));
    ensureCovers().catch(e => console.error('Covers failed:', e.message));
  }
  setInterval(maybeRefresh, CHECK_EVERY_MS);
  server.listen(PORT, () => console.log(`Folio running at http://localhost:${PORT}`));
})();
