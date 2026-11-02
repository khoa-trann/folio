// Book sources and categories.
//  - Project Gutenberg: official CSV catalog (no third-party API), plain-text books
//  - Standard Ebooks: new-releases Atom feed, single-page XHTML books
//  - Apple Books (US store): top-paid charts per genre, for the paid "store" section
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// Free-library categories. `seeds` are hand-picked Gutenberg IDs shown first;
// `pg` matches the Gutenberg CSV (subjects + bookshelves) for later refreshes.
const CATEGORIES = [
  { key: 'self', vi: 'Phát triển bản thân', en: 'Self-improvement',
    seeds: [4507, 59844, 2274, 935, 368, 455, 16317, 45109, 10661, 2944, 205, 148],
    pg: /(^|; )(Success|Conduct of life|Self-(help|culture|realization|actualization)[^;]*|Happiness|Mental discipline|Will|Thought and thinking|Success in business|Character)(;|$)/i },
  { key: 'classics', vi: 'Văn học kinh điển', en: 'Classics',
    seeds: [1400, 768, 158, 76, 2600, 1399, 135, 28054, 5200, 2814, 1952, 215, 120],
    pg: /Category: Classics of Literature/ },
  { key: 'philosophy', vi: 'Triết học', en: 'Philosophy',
    seeds: [2680, 1497, 4363, 1998, 5827, 8438, 34901, 1232, 132, 3207],
    pg: /Category: Philosophy & Ethics/ },
  { key: 'mystery', vi: 'Trinh thám', en: 'Mystery',
    seeds: [244, 2852, 1661, 108, 155, 863, 1872, 834],
    pg: /Crime, Thrillers and Mystery|Detective and mystery stories/ },
  { key: 'scifi', vi: 'Viễn tưởng', en: 'Sci-fi & fantasy',
    seeds: [84, 35, 36, 164, 5230, 159, 62, 18857],
    pg: /Category: Science-Fiction & Fantasy/ },
  { key: 'children', vi: 'Thiếu nhi', en: 'Children',
    seeds: [11, 16, 55, 113, 271, 12, 236, 74],
    pg: /Category: Children & Young Adult Reading/ },
  { key: 'history', vi: 'Lịch sử & tiểu sử', en: 'History & biography',
    seeds: [23, 148, 3300, 1404, 10630],
    pg: /Category: History - |Category: Biographies/ },
  { key: 'poetry', vi: 'Thơ & kịch', en: 'Poetry & drama',
    seeds: [1524, 1513, 1041, 1322, 8800, 6130, 16328, 844],
    pg: /Category: Poetry|Category: Plays\/Films\/Dramas/ },
];

// Paid store sections → Apple Books (US) genre charts.
const STORE_GENRES = [
  { key: 'self', vi: 'Phát triển bản thân', en: 'Self-improvement', genre: 9025 },
  { key: 'business', vi: 'Kinh doanh', en: 'Business', genre: 9009 },
  { key: 'fiction', vi: 'Tiểu thuyết', en: 'Fiction', genre: 9031 },
  { key: 'mystery', vi: 'Trinh thám', en: 'Mystery & thriller', genre: 9032 },
  { key: 'science', vi: 'Khoa học', en: 'Science', genre: 9019 },
  { key: 'parenting', vi: 'Nuôi dạy con', en: 'Parenting', genre: 9030 },
];

function makeSources({ fetchWithTimeout, DATA_DIR }) {
  // ---------- Project Gutenberg ----------
  const PG_CSV = 'https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv';
  const PG_FILE = path.join(DATA_DIR, 'pg_catalog.csv');
  let pgIndex = null;

  function parseCsv(text) {
    const rows = [];
    let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
      else field += ch;
    }
    return rows;
  }

  // "Austen, Jane, 1775-1817; Thomson, Hugh, 1860-1920 [Illustrator]" -> [{name, birth, death}]
  function parseAuthors(s) {
    return (s || '').split(/;\s*/).filter(a => a && !/\[/.test(a)).map(a => {
      const m = a.match(/^(.*?),\s*(?:active\s.*|(-?\d{1,4})\??\s*(?:BCE?)?\s*-\s*(\d{1,4})?.*)$/);
      return m ? { name: m[1].trim(), birth: m[2] ? +m[2] : null, death: m[3] ? +m[3] : null } : { name: a.trim(), birth: null, death: null };
    });
  }

  async function loadPgIndex(maxAgeMs) {
    let stale = true;
    try { stale = Date.now() - (await fsp.stat(PG_FILE)).mtimeMs > maxAgeMs; } catch {}
    if (pgIndex && !stale) return pgIndex;
    if (stale) {
      console.log('Downloading Gutenberg catalog CSV…');
      const res = await fetchWithTimeout(PG_CSV, 120000);
      await fsp.writeFile(PG_FILE, await res.text(), 'utf8');
    }
    const rows = parseCsv(await fsp.readFile(PG_FILE, 'utf8'));
    pgIndex = new Map();
    for (const r of rows.slice(1)) {
      if (r[1] !== 'Text') continue;
      pgIndex.set(+r[0], { id: +r[0], title: r[3], lang: r[4], authors: r[5], subjects: r[6], shelves: r[8] });
    }
    console.log(`Gutenberg catalog: ${pgIndex.size} texts`);
    return pgIndex;
  }

  function pgCategories(id) {
    const r = pgIndex && pgIndex.get(+id);
    const hay = r ? `${r.subjects}; ${r.shelves}` : '';
    return CATEGORIES.filter(c => c.seeds.includes(+id) || (r && c.pg.test(c.key === 'self' ? r.subjects : hay)))
      .filter(c => !(c.key === 'self' && r && /fiction|drama/i.test(r.subjects) && !c.seeds.includes(+id)))
      .map(c => c.key);
  }

  function pgBook(id) {
    const r = pgIndex.get(+id);
    if (!r) return null;
    return {
      id: String(id),
      source: 'gutenberg',
      sourceUrl: `https://www.gutenberg.org/ebooks/${id}`,
      title: r.title.replace(/\s*\n\s*/g, ': ').replace(/\s+/g, ' ').trim(),
      authors: parseAuthors(r.authors),
      subjects: r.subjects.split(/;\s*/).filter(Boolean).slice(0, 4),
      categories: pgCategories(id),
      coverUrl: `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`,
      textUrl: `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`,
    };
  }

  // Up to `n` unseen books for a category: seeds first, then CSV matches (oldest IDs = best-known classics).
  function pgPick(cat, n, known) {
    const out = [];
    const take = id => { if (out.length < n && !known.has(String(id)) && pgIndex.has(id)) { out.push(id); known.add(String(id)); } };
    cat.seeds.forEach(take);
    if (out.length < n) {
      for (const r of pgIndex.values()) {
        if (out.length >= n) break;
        if (r.lang !== 'en') continue;
        if (pgCategories(r.id).includes(cat.key)) take(r.id);
      }
    }
    return out.map(id => ({ ...pgBook(id), seed: cat.seeds.includes(id) })).filter(b => b.title);
  }

  // ---------- Standard Ebooks ----------
  const SE_FEED = 'https://standardebooks.org/feeds/atom/new-releases';
  const decode = s => s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

  function seCategories(terms) {
    const t = terms.join(' | ');
    const keys = [];
    if (/Conduct of life|Spirituality|Self-help|Success/i.test(t)) keys.push('self');
    if (/Philosophy|Ethics/i.test(t)) keys.push('philosophy');
    if (/Mystery|Detective|Crime/i.test(t)) keys.push('mystery');
    if (/Science fiction|Fantasy/i.test(t)) keys.push('scifi');
    if (/Children/i.test(t)) keys.push('children');
    if (/Memoir|Biography|History|World War/i.test(t)) keys.push('history');
    if (/Poetry|Drama/i.test(t)) keys.push('poetry');
    if (/\bFiction\b/.test(t) && !keys.length) keys.push('classics');
    return keys;
  }

  async function seLatest(n, known) {
    const xml = await (await fetchWithTimeout(SE_FEED, 45000)).text();
    const out = [];
    for (const [entry] of xml.matchAll(/<entry>[\s\S]*?<\/entry>/g)) {
      if (out.length >= n) break;
      const url = (entry.match(/<id>([^<]+)<\/id>/) || [])[1];
      if (!url) continue;
      const slug = url.replace('https://standardebooks.org/ebooks/', '');
      const id = 'se~' + slug.replace(/\//g, '~');
      if (known.has(id)) continue;
      const terms = [...entry.matchAll(/<category[^>]*term="([^"]+)"/g)].map(m => decode(m[1]));
      const author = decode((entry.match(/<author>\s*<name>([^<]+)<\/name>/) || [])[1] || '');
      const parts = author.split(' ');
      out.push({
        id,
        source: 'standardebooks',
        sourceUrl: url,
        title: decode((entry.match(/<title>([^<]+)<\/title>/) || [])[1] || slug),
        // Store as "Last, First" like Gutenberg so the client formats both the same way.
        authors: [{ name: parts.length > 1 ? `${parts.slice(-1)[0]}, ${parts.slice(0, -1).join(' ')}` : author, birth: null, death: null }],
        subjects: terms.filter(x => !/^(Fiction|Nonfiction|Shorts)$/.test(x)).map(x => x.replace(/--/g, ' -- ')).slice(0, 4),
        categories: seCategories(terms),
        coverUrl: (entry.match(/<media:thumbnail[^>]*url="([^"]+)"/) || [])[1] || null,
        textUrl: `${url}/text/single-page`,
      });
      known.add(id);
    }
    return out;
  }

  // XHTML → plain text in the same shape as a Gutenberg body (blank-line paragraphs, CAPS headings).
  function seHtmlToText(html) {
    const skip = /titlepage|imprint|halftitlepage|toc|colophon|copyright-page|endnotes|loi/;
    const body = html.replace(/<section[^>]*epub:type="([^"]*)"[^>]*>/g, (m, type) => (skip.test(type) ? '\u0000SKIP' : '\u0000KEEP'));
    // Segment 0 is the site chrome before the first <section>.
    const keep = body.split('\u0000').slice(1).filter(s => !s.startsWith('SKIP')).join('\n');
    return decode(keep
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/g, '')
      .replace(/<hgroup[^>]*>([\s\S]*?)<\/hgroup>/g, (m, inner) => '\n\n' + inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase() + '\n\n')
      .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/g, (m, inner) => '\n\n' + inner.replace(/<[^>]+>/g, '').trim().toUpperCase() + '\n\n')
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/<\/(p|blockquote|li|div|tr)>/g, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/^KEEP|^SKIP/gm, '')
      .replace(/⁠/g, ''))
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ---------- Apple Books store (paid) ----------
  const stripHtml = s => decode(String(s || '').replace(/<br\s*\/?>/g, '\n').replace(/<\/p>/g, '\n\n').replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n').trim();

  async function storeChart(g, limit) {
    const url = `https://itunes.apple.com/us/rss/toppaidebooks/limit=${limit}/genre=${g.genre}/json`;
    const json = await (await fetchWithTimeout(url, 45000)).json();
    const entries = (json.feed && json.feed.entry) || [];
    const list = Array.isArray(entries) ? entries : [entries];
    const ids = list.map(e => e.id.attributes['im:id']);
    // The lookup API adds descriptions, ratings and bigger artwork.
    const details = new Map();
    if (ids.length) {
      const lk = await (await fetchWithTimeout(`https://itunes.apple.com/lookup?country=us&id=${ids.join(',')}`, 45000)).json();
      for (const r of lk.results || []) details.set(String(r.trackId), r);
    }
    return list.map((e, rank) => {
      const id = e.id.attributes['im:id'];
      const d = details.get(id) || {};
      const img = (d.artworkUrl100 || (e['im:image'] || []).slice(-1)[0]?.label || '').replace(/\/\d+x\d+bb\./, '/600x900bb.');
      return {
        id: 'ap-' + id,
        source: 'applebooks',
        category: g.key,
        rank: rank + 1,
        title: e['im:name'].label,
        authors: [{ name: e['im:artist'] ? e['im:artist'].label : (d.artistName || ''), birth: null, death: null }],
        price: d.formattedPrice || e['im:price'].label,
        priceAmount: +(e['im:price'].attributes?.amount ?? d.price ?? 0),
        currency: e['im:price'].attributes?.currency || d.currency || 'USD',
        coverUrl: img,
        url: d.trackViewUrl || e.link?.attributes?.href || e.id.label,
        description: stripHtml(d.description || e.summary?.label || ''),
        genres: d.genres || [],
        rating: d.averageUserRating || null,
        ratingCount: d.userRatingCount || 0,
        releaseDate: d.releaseDate || null,
      };
    }).filter(b => b.title && b.coverUrl);
  }

  // ---------- Search: Gutenberg (local CSV) ----------
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

  // Score every CSV row against the query words; title hits weigh most.
  function pgSearch(q, { category, offset = 0, limit = 10 } = {}) {
    if (!pgIndex) return { total: 0, items: [] };
    const words = norm(q).split(' ').filter(w => w.length > 1);
    const cat = category && CATEGORIES.find(c => c.key === category);
    const hits = [];
    for (const r of pgIndex.values()) {
      if (cat && !(cat.seeds.includes(r.id) || cat.pg.test(cat.key === 'self' ? r.subjects : `${r.subjects}; ${r.shelves}`))) continue;
      if (!words.length) { if (cat) hits.push([cat.seeds.includes(r.id) ? 1e6 - cat.seeds.indexOf(r.id) : -r.id, r.id]); continue; }
      const title = norm(r.title);
      const tw = title.split(' '), aw = norm(r.authors).split(' '), sw = norm(r.subjects).split(' ');
      // Match whole words, or word prefixes for longer query words ("stoic" → "stoicism").
      const has = (list, w) => list.some(x => x === w || (w.length >= 4 && x.startsWith(w)));
      let score = 0, all = true;
      for (const w of words) {
        const t = has(tw, w), a = has(aw, w), s = has(sw, w);
        if (!t && !a && !s) { all = false; break; }
        score += t ? 10 : a ? 7 : 2;
      }
      if (!all) continue;
      if (title.startsWith(norm(q))) score += 15;
      if (r.lang === 'en') score += 6;
      hits.push([score - r.id / 1e6, r.id]);
    }
    hits.sort((a, b) => b[0] - a[0]);
    return { total: hits.length, items: hits.slice(offset, offset + limit).map(([, id]) => pgBook(id)) };
  }

  // ---------- Search: Open Library (everything, incl. books still in copyright) ----------
  const OL_FIELDS = 'key,title,subtitle,author_name,first_publish_year,cover_i,ebook_access,ia,language,number_of_pages_median,edition_count,subject,isbn';
  async function olSearch(q, { page = 1, limit = 20, openOnly = false } = {}) {
    const query = openOnly ? `${q} ebook_access:public` : q;
    const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&fields=${OL_FIELDS}&limit=${limit}&page=${page}`;
    const j = await (await fetchWithTimeout(url, 30000)).json();
    return {
      total: j.numFound || 0,
      items: (j.docs || []).map(d => {
        const access = d.ebook_access === 'public' && d.ia && d.ia.length ? 'scan' : d.ebook_access === 'borrowable' ? 'borrow' : 'buy';
        return {
          id: access === 'scan' ? 'ia~' + d.ia[0] : null,
          key: d.key,
          source: 'openlibrary',
          access,
          title: d.subtitle ? `${d.title}: ${d.subtitle}` : d.title,
          authors: (d.author_name || []).slice(0, 3).map(name => ({ name, birth: null, death: null })),
          year: d.first_publish_year || null,
          pages: d.number_of_pages_median || null,
          editions: d.edition_count || 0,
          languages: (d.language || []).slice(0, 4),
          subjects: (d.subject || []).slice(0, 4),
          isbn: (d.isbn || [])[0] || null,
          ia: (d.ia || [])[0] || null,
          coverUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : null,
          sourceUrl: `https://openlibrary.org${d.key}`,
        };
      }),
    };
  }

  async function olDescription(key) {
    const j = await (await fetchWithTimeout(`https://openlibrary.org${key}.json`, 30000)).json();
    const d = j.description;
    return (typeof d === 'string' ? d : d && d.value) || '';
  }

  // ---------- Internet Archive (public-domain scans with OCR text) ----------
  async function iaBook(ident) {
    const m = await (await fetchWithTimeout(`https://archive.org/metadata/${encodeURIComponent(ident)}`, 45000)).json();
    if (!m.metadata) throw new Error('Không tìm thấy sách trên Internet Archive');
    if (m.metadata['access-restricted-item'] === 'true') throw new Error('Sách này không mở công khai');
    const txt = (m.files || []).find(f => /_djvu\.txt$/.test(f.name));
    if (!txt) throw new Error('Sách này không có bản văn bản');
    const one = v => (Array.isArray(v) ? v[0] : v) || '';
    const creator = one(m.metadata.creator);
    return {
      id: 'ia~' + ident,
      source: 'internetarchive',
      sourceUrl: `https://archive.org/details/${ident}`,
      title: one(m.metadata.title) || ident,
      authors: creator ? [{ name: creator.replace(/,\s*\d{3,4}-?\d{0,4}\.?$/, ''), birth: null, death: null }] : [],
      subjects: [].concat(m.metadata.subject || []).slice(0, 4),
      categories: [],
      coverUrl: `https://archive.org/services/img/${ident}`,
      textUrl: `https://archive.org/download/${ident}/${encodeURIComponent(txt.name)}`,
      year: parseInt(one(m.metadata.date), 10) || null,
      scanned: true,
    };
  }

  // OCR text is hard-wrapped page by page; rebuild paragraphs from line endings.
  function iaTextToText(raw) {
    const lines = raw.replace(/\r\n?/g, '\n').split('\n').map(l => l.trim());
    const lens = lines.filter(Boolean).map(l => l.length).sort((a, b) => a - b);
    const median = lens[Math.floor(lens.length / 2)] || 60;
    const out = [];
    let cur = '';
    for (const l of lines) {
      if (!l) { if (cur) { out.push(cur); cur = ''; } continue; }
      if (/^\d{1,4}$/.test(l)) continue;                 // page numbers
      cur = cur ? (cur.endsWith('-') ? cur.slice(0, -1) + l : cur + ' ' + l) : l;
      if (/[.!?"”’]$/.test(l) && l.length < median * 0.8) { out.push(cur); cur = ''; }
    }
    if (cur) out.push(cur);
    return out.join('\n\n');
  }

  // ---------- Wikisource tiếng Việt ----------
  const WS_API = 'https://vi.wikisource.org/w/api.php';
  async function wsSearch(q, { offset = 0, limit = 6 } = {}) {
    const run = async term => (await (await fetchWithTimeout(
      `${WS_API}?action=query&list=search&srsearch=${encodeURIComponent(term)}&srnamespace=0&srlimit=${limit}&sroffset=${offset}&format=json`, 30000)).json());
    // Multi-word queries are usually names/titles: try the exact phrase first.
    let j = q.includes(' ') ? await run(`"${q}"`) : null;
    if (!j || !(j.query && j.query.searchinfo.totalhits)) j = await run(q);
    return {
      total: (j.query && j.query.searchinfo.totalhits) || 0,
      items: ((j.query && j.query.search) || []).filter(x => x.wordcount > 300 || !x.title.includes('/')).map(x => ({
        id: 'ws~' + x.title.replace(/ /g, '_'),
        source: 'wikisource',
        access: 'open',
        title: x.title.replace(/\//g, ' — '),
        authors: [],
        words: x.wordcount,
        excerpt: decode(x.snippet.replace(/<[^>]+>/g, '')),
        sourceUrl: `https://vi.wikisource.org/wiki/${encodeURIComponent(x.title.replace(/ /g, '_'))}`,
        lang: 'vi',
      })),
    };
  }

  // Remove whole elements (with nesting) whose opening tag matches `re`.
  function dropElements(html, re) {
    let out = html;
    for (let guard = 0; guard < 200; guard++) {
      const m = re.exec(out);
      if (!m) break;
      const tag = m[1];
      let depth = 0, i = m.index, end = -1;
      const tagRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g');
      tagRe.lastIndex = i;
      for (let t; (t = tagRe.exec(out));) {
        depth += t[1] ? -1 : 1;
        if (depth === 0) { end = t.index + t[0].length; break; }
      }
      out = out.slice(0, m.index) + out.slice(end === -1 ? m.index + m[0].length : end);
      re.lastIndex = 0;
    }
    return out;
  }

  function wsHtmlToText(html) {
    let h = html.replace(/<(style|script)[\s\S]*?<\/\1>/g, '');
    h = dropElements(h, /<(div|table|span|sup|ol)\b[^>]*(class="[^"]*(ws-noexport|ws-header|wst-header|header_|licenseContainer|reference|mw-editsection|noprint|navbox)[^"]*"|id="(headertemplate|headerContainer)")[^>]*>/);
    h = dropElements(h, /<(table)\b[^>]*>/);
    return decode(h
      .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/g, (m, inner) => '\n\n' + inner.replace(/<[^>]+>/g, '').trim().toUpperCase() + '\n\n')
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/<\/(p|div|li|dd|blockquote)>/g, '\n\n')
      .replace(/<[^>]+>/g, ''))
      .replace(/​/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // A work is either one page or an index linking to "Title/Chapter" subpages.
  async function wsBook(id) {
    const title = id.slice(3);
    const parse = async t => (await (await fetchWithTimeout(`${WS_API}?action=parse&page=${encodeURIComponent(t)}&prop=text&format=json&formatversion=2&redirects=1`, 45000)).json()).parse;
    const p = await parse(title);
    if (!p) throw new Error('Không tìm thấy trang trên Wikisource');
    let text = wsHtmlToText(p.text);
    const prefix = `/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}/`;
    const subs = [...new Set([...p.text.matchAll(/href="(\/wiki\/[^"#?]+)"/g)].map(m => m[1]).filter(h => h.startsWith(prefix)))].slice(0, 80);
    if (subs.length && text.split(/\s+/).length < 3000) {
      const parts = await Promise.all(subs.map(async (h, i) => {
        await new Promise(r => setTimeout(r, i * 120));  // be gentle with the API
        try { return wsHtmlToText((await parse(decodeURIComponent(h.slice(6)))).text); } catch { return ''; }
      }));
      text = [text, ...parts].filter(Boolean).join('\n\n');
    }
    const author = (p.text.match(/href="\/wiki\/(?:T%C3%A1c_gia|Tác_gia):([^"#]+)"/) || [])[1];
    return {
      id: 'ws~' + p.title.replace(/ /g, '_'),
      source: 'wikisource',
      sourceUrl: `https://vi.wikisource.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`,
      title: p.title.replace(/\//g, ' — '),
      authors: author ? [{ name: decodeURIComponent(author).replace(/_/g, ' '), birth: null, death: null }] : [],
      subjects: [],
      categories: [],
      coverUrl: null,
      lang: 'vi',
      text,
    };
  }

  // ---------- Market: best Apple Books match for a title ----------
  async function applePrice(title, author) {
    const term = `${title} ${author || ''}`.trim();
    const j = await (await fetchWithTimeout(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=ebook&country=us&limit=6`, 20000)).json();
    const want = norm(title).slice(0, 24);
    const hit = (j.results || []).find(r => norm(r.trackName).includes(want) || want.includes(norm(r.trackName).slice(0, 24)));
    return hit ? { store: 'Apple Books', price: hit.formattedPrice, url: hit.trackViewUrl, free: !hit.price } : null;
  }

  return {
    loadPgIndex, pgPick, pgBook, pgCategories, seLatest, seHtmlToText, storeChart,
    pgSearch, olSearch, olDescription, iaBook, iaTextToText, wsSearch, wsBook, applePrice,
    normTitle: norm,
  };
}

module.exports = { CATEGORIES, STORE_GENRES, makeSources };
