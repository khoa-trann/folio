// Folio client: slide deck of books, reader (EN / machine-translated VI), offline downloads (IndexedDB).
(() => {
  const app = document.getElementById('app');
  const CHUNK = 120;       // paragraphs rendered per reader step
  const VI_STEP = 300;     // paragraphs translated per request when downloading VI

  const state = {
    catalog: null,
    filter: 'all',          // all | new | saved
    category: 'all',        // free-library category key
    storeCategory: 'all',   // paid-store section key
    query: '',
    lang: localStorage.getItem('folio-lang') === 'vi' ? 'vi' : 'en',
    downloaded: new Map(),  // id -> { en: bool, vi: bool }
    metaCache: new Map(),   // id -> meta of books opened from search
    resultMap: new Map(),   // id -> search result on screen (for "+ Muốn đọc")
    savedMeta: new Map(),   // id -> meta of books stored in IndexedDB
    slide: 0,               // active slide index on the home deck
  };

  // ---------- utilities ----------
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = ts => ts ? new Date(ts).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
  const authorName = b => (b.authors && b.authors[0] ? b.authors[0].name.split(', ').reverse().join(' ') : 'Khuyết danh');
  const pad = n => String(n).padStart(2, '0');
  const LANG = { en: 'EN', vi: 'VI' };

  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // Book text in the active language; VI falls back to EN until the server has translated it.
  function localized(b) {
    const vi = state.lang === 'vi' && b.translated;
    return {
      title: vi ? b.titleVi : b.title,
      original: vi ? b.title : '',
      preface: vi ? b.prefaceVi : b.preface,
      description: vi ? b.descriptionVi : b.description,
      subjects: (vi && b.subjectsVi) || b.subjects || [],
    };
  }

  const SOURCE_NAMES = { gutenberg: 'Project Gutenberg', standardebooks: 'Standard Ebooks', applebooks: 'Apple Books' };
  const catName = (list, key) => {
    const c = (list || []).find(x => x.key === key);
    return c ? (state.lang === 'vi' ? c.vi : c.en) : key;
  };

  // ---------- IndexedDB ----------
  const db = (() => {
    let dbp;
    const open = () => dbp || (dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('folio', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('books', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
    const tx = async (mode, fn) => {
      const d = await open();
      return new Promise((resolve, reject) => {
        const t = d.transaction('books', mode);
        const r = fn(t.objectStore('books'));
        t.oncomplete = () => resolve(r && r.result);
        t.onerror = () => reject(t.error);
      });
    };
    return {
      get: id => tx('readonly', s => s.get(id)),
      put: rec => tx('readwrite', s => s.put(rec)),
      del: id => tx('readwrite', s => s.delete(id)),
      all: () => tx('readonly', s => s.getAll()),
    };
  })();

  async function loadDownloaded() {
    const recs = await db.all().catch(() => []);
    state.downloaded = new Map(recs.filter(r => r.en).map(r => [r.id, { en: true, vi: !!r.vi }]));
    state.savedMeta = new Map(recs.filter(r => r.en).map(r => [r.id, r.meta]));
    return recs;
  }

  // ---------- data ----------
  async function loadCatalog() {
    const recs = await loadDownloaded();
    try {
      const res = await fetch('/api/catalog');
      if (!res.ok) throw new Error(res.status);
      state.catalog = await res.json();
    } catch {
      // Fully offline with no cached catalog: build one from downloads.
      state.catalog = { offline: true, updatedAt: 0, nextRefreshAt: 0, lastAdded: [], categories: [], storeCategories: [], store: [], books: recs.filter(r => r.en && r.meta.source !== 'local').map(r => r.meta) };
    }
    updateSync();
    return state.catalog;
  }

  function updateSync() {
    const c = state.catalog;
    document.getElementById('sync').textContent = c && c.updatedAt
      ? `cập nhật ${fmtDate(c.updatedAt)} · lần tới ${fmtDate(c.nextRefreshAt)}`
      : (c && c.offline ? 'chế độ ngoại tuyến' : 'đang đồng bộ…');
  }

  async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Không kết nối được máy chủ');
    return res.json();
  }

  const fetchEn = async id => (await fetchJson(`/api/books/${encodeURIComponent(id)}/paras`)).paras;
  const fetchVi = async (id, start, end) => (await fetchJson(`/api/books/${encodeURIComponent(id)}/vi?start=${start}&end=${end}`)).paras;

  async function downloadBook(id, lang, onProgress = () => {}) {
    const book = await bookMeta(id);
    const rec = await db.get(id).catch(() => null);
    const en = (rec && rec.en) || await fetchEn(id);
    let vi = (rec && rec.vi) || null;
    if (lang === 'vi' && !vi) {
      vi = [];
      for (let start = 0; start < en.length; start += VI_STEP) {
        onProgress(Math.round((start / en.length) * 100));
        vi.push(...await fetchVi(id, start, start + VI_STEP));
      }
    }
    if ('caches' in window && book.cover) {
      try { const c = await caches.open('folio-covers'); await c.add(book.cover); } catch {}
    }
    await db.put({ id, meta: book, en, vi, savedAt: Date.now() });
    state.downloaded.set(id, { en: true, vi: !!vi });
  }

  async function removeBook(id) {
    await db.del(id);
    state.downloaded.delete(id);
  }

  // ---------- nav ----------
  function setActiveNav(name) {
    document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === name));
  }
  function syncLangButtons() {
    document.querySelectorAll('[data-lang]').forEach(b => b.classList.toggle('active', b.dataset.lang === state.lang));
  }

  // ---------- slide decks: free library & paid store ----------
  const matches = (q, fields) => !q || fields.filter(Boolean).join(' ').toLowerCase().includes(q);

  function filteredBooks() {
    const c = state.catalog;
    const q = state.query.trim().toLowerCase();
    const lastAdded = new Set(c.lastAdded || []);
    return c.books.filter(b => {
      if (state.filter === 'new' && !lastAdded.has(b.id)) return false;
      if (state.filter === 'saved' && !state.downloaded.has(b.id)) return false;
      if (state.category !== 'all' && !(b.categories || []).includes(state.category)) return false;
      return matches(q, [b.title, b.titleVi, ...b.authors.map(a => a.name), ...(b.subjects || []), ...(b.subjectsVi || [])]);
    });
  }

  function filteredStore() {
    const q = state.query.trim().toLowerCase();
    return (state.catalog.store || []).filter(b =>
      (state.storeCategory === 'all' || b.category === state.storeCategory)
      && matches(q, [b.title, b.titleVi, ...b.authors.map(a => a.name), ...(b.genres || [])]));
  }

  function chipsHTML(list, active, attr) {
    return `<button data-${attr}="all">Tất cả</button>`
      + list.map(c => `<button data-${attr}="${c.key}">${esc(c.vi)}</button>`).join('');
  }

  function introHTML(c, mode) {
    const store = mode === 'store';
    const stats = store
      ? `<div class="stat rise" style="--d:2"><b>${(c.store || []).length}</b><span>sách trả phí</span><p>Bán chạy trên Apple Books (Mỹ).</p></div>
         <div class="stat rise" style="--d:3"><b>${(c.storeCategories || []).length}</b><span>chuyên mục</span><p>Theo bảng xếp hạng từng thể loại.</p></div>
         <div class="stat rise" style="--d:4"><b>3</b><span>ngày / lần cập nhật</span><p>Lần tới: ${fmtDate(c.nextRefreshAt)}.</p></div>`
      : `<div class="stat rise" style="--d:2"><b>${c.books.length}</b><span>đầu sách miễn phí</span><p>Project Gutenberg · Standard Ebooks.</p></div>
         <div class="stat rise" style="--d:3"><b>3</b><span>ngày / lần cập nhật</span><p>Lần tới: ${fmtDate(c.nextRefreshAt)}.</p></div>
         <div class="stat rise" style="--d:4"><b>${state.downloaded.size}</b><span>đã tải xuống</span><p>Đọc được khi ngoại tuyến.</p></div>`;
    return `
      <section class="slide intro" data-slide="intro">
        <div>
          <h1 class="hero-word rise${store ? ' long' : ''}">${store ? 'Shop.' : 'Fo.'}</h1>
          <p class="hero-note rise" style="--d:2">${store
            ? 'Sách trả phí bán chạy, giới thiệu trước để bạn quyết định. Thanh toán và đọc trên Apple Books.'
            : 'Sách miễn phí, hết bản quyền. Đọc trực tuyến, hoặc tải về để đọc khi không có mạng. Chuyển EN / VI ở góc trên.'}</p>
          ${store ? '' : continueHTML()}
        </div>
        <div>
          <p class="hero-statement rise" style="--d:1">${store
            ? 'Những cuốn sách đáng đầu tư—chọn từ bảng xếp hạng, đọc phần giới thiệu trước khi mua.'
            : 'Đọc là một quá trình chậm lại—gạt bỏ tiếng ồn cho đến khi chỉ còn ý nghĩa ở lại.'}</p>
        </div>
        <div class="stats">${stats}</div>
        <div class="toolbar">
          <div class="filters">${store
            ? '<span class="label">Bảng xếp hạng Apple Books</span>'
            : '<button data-filter="all">Tất cả</button><button data-filter="new">Mới cập nhật</button><button data-filter="saved">Đã tải</button>'}</div>
          <input class="search" type="search" placeholder="Tìm tên sách, tác giả${store ? '' : ', chủ đề'}…" value="${esc(state.query)}" aria-label="Tìm kiếm">
          <div class="scroll-hint label"><span id="count"></span><span>cuộn xuống <span class="arrow">↓</span></span></div>
        </div>
        <div class="cats">${store ? chipsHTML(c.storeCategories || [], state.storeCategory, 'scat') : chipsHTML(c.categories || [], state.category, 'cat')}</div>
      </section>`;
  }

  function wantBtn(id) {
    const s = shelf.get(id);
    const on = s && s.status === 'want';
    return s && s.status !== 'want' ? '' : `<button class="badge want${on ? ' on' : ''}" data-want="${esc(id)}">${on ? '✓ Muốn đọc' : '+ Muốn đọc'}</button>`;
  }

  // "Continue reading" line for the home intro slide.
  function continueHTML() {
    const last = Object.entries(shelf.all()).map(([id, e]) => ({ id, ...e }))
      .filter(e => e.status === 'reading' && e.meta).sort((a, b) => (b.lastRead || 0) - (a.lastRead || 0))[0];
    if (!last) return '';
    return `<a class="continue rise" style="--d:3" href="#/read/${encodeURIComponent(last.id)}"><span class="label">Tiếp tục đọc</span>
      <b>${esc(localized(last.meta).title)}</b><span class="sc-progress"><i style="width:${last.pct || 0}%"></i></span><span class="label">${last.pct || 0}% →</span></a>`;
  }

  function prefaceHeading(b) {
    if (state.lang === 'vi') return b.prefaceLabel === 'Chapter I' ? 'Chương I' : b.prefaceLabel === 'Opening' ? 'Mở đầu' : 'Lời mở đầu';
    return b.prefaceLabel === 'Opening' ? 'The Opening' : b.prefaceLabel;
  }

  function bookSlideHTML(b, i, total) {
    const L = localized(b);
    const isNew = (state.catalog.lastAdded || []).includes(b.id);
    const dl = state.downloaded.get(b.id);
    const hasLang = dl && dl[state.lang];
    const author = authorName(b);
    const a0 = b.authors[0];
    const life = a0 && (a0.birth || a0.death) ? `${a0.birth ?? '?'}–${a0.death ?? ''}` : '';
    const preface = (L.preface || '').split(/\n\n/).map(p => `<p>${esc(p)}</p>`).join('');
    const cats = (b.categories || []).map(k => catName(state.catalog.categories, k));
    const href = `#/read/${encodeURIComponent(b.id)}`;
    return `
      <section class="slide book" data-slide="${i}" data-id="${esc(b.id)}">
        <a class="cover-panel" href="${href}" aria-label="${esc(L.title)}">
          <span class="no rise">${pad(i + 1)} / ${pad(total)}</span>
          <img class="book-cover reveal" style="--d:1" src="${b.cover}" alt="Bìa sách ${esc(L.title)}" loading="lazy" onerror="this.style.visibility='hidden'">
        </a>
        <div class="book-main">
          <div class="book-title-wrap">
            <h2 class="book-title rise" style="--d:1"><a href="${href}">${esc(L.title)}</a></h2>
            ${L.original ? `<div class="book-orig rise" style="--d:2">${esc(L.original)}</div>` : ''}
          </div>
          <div class="book-sub">
            <h3 class="rise" style="--d:2">${esc(prefaceHeading(b))}<br><span class="label">${esc(author)}</span></h3>
            <div class="preface rise" style="--d:3">${preface || '<p>—</p>'}</div>
          </div>
          <div class="book-actions rise" style="--d:4">
            <button class="btn" data-action="${hasLang ? 'remove' : 'download'}" data-id="${esc(b.id)}">${hasLang ? `(Xoá bản tải ${LANG[state.lang]})` : `(Tải xuống · ${LANG[state.lang]})`}</button>
            <a class="btn read-now" href="${href}">(Đọc ngay) <span class="square"></span></a>
          </div>
        </div>
        <dl class="book-meta">
          <div class="rise" style="--d:2"><span class="badge">Miễn phí</span>${isNew ? '<span class="badge solid">Mới</span>' : ''}${dl ? `<span class="badge">Offline ${dl.en ? 'EN' : ''}${dl.vi ? ' · VI' : ''}</span>` : ''}${wantBtn(b.id)}</div>
          <div class="rise" style="--d:3"><dt>Tác giả</dt><dd>${esc(author)}${life ? `<br><span style="color:var(--muted)">${esc(life)}</span>` : ''}</dd></div>
          ${cats.length ? `<div class="rise" style="--d:4"><dt>Thể loại</dt><dd>${cats.map(esc).join('<br>')}</dd></div>` : ''}
          ${L.subjects.length ? `<div class="rise" style="--d:4"><dt>Chủ đề</dt><dd>${L.subjects.slice(0, 2).map(s => esc(s.split(' -- ')[0])).join('<br>')}</dd></div>` : ''}
          ${b.words ? `<div class="rise" style="--d:5"><dt>Độ dài</dt><dd>${b.words.toLocaleString('vi-VN')} từ · ~${Math.max(1, Math.round(b.words / 230 / 60))} giờ</dd></div>` : ''}
          <div class="rise" style="--d:6"><dt>Nguồn</dt><dd>${b.sourceUrl ? `<a class="btn" href="${esc(b.sourceUrl)}" target="_blank" rel="noopener">${esc(SOURCE_NAMES[b.source] || b.source)} ↗</a>` : esc(SOURCE_NAMES[b.source] || '')}</dd></div>
        </dl>
      </section>`;
  }

  function storeSlideHTML(b, i, total) {
    const L = localized(b);
    const author = (b.authors[0] && b.authors[0].name) || '—';
    const desc = (L.description || '').split(/\n+/).filter(Boolean).map(p => `<p>${esc(p)}</p>`).join('');
    const r = Math.round(b.rating || 0);
    const link = `href="${esc(b.url)}" target="_blank" rel="noopener"`;
    return `
      <section class="slide book store-book" data-slide="${i}" data-id="${esc(b.id)}">
        <a class="cover-panel" ${link} aria-label="${esc(L.title)}">
          <span class="no rise">${pad(i + 1)} / ${pad(total)}</span>
          <span class="price-tag rise" style="--d:3">${esc(b.price)}</span>
          <img class="book-cover reveal" style="--d:1" src="${b.cover}" alt="Bìa sách ${esc(L.title)}" loading="lazy" onerror="this.style.visibility='hidden'">
        </a>
        <div class="book-main">
          <div class="book-title-wrap">
            <h2 class="book-title rise" style="--d:1"><a ${link}>${esc(L.title)}</a></h2>
            ${L.original ? `<div class="book-orig rise" style="--d:2">${esc(L.original)}</div>` : ''}
          </div>
          <div class="book-sub">
            <h3 class="rise" style="--d:2">Giới thiệu<br><span class="label">${esc(author)}</span></h3>
            <div class="preface rise" style="--d:3">${desc || '<p>—</p>'}</div>
          </div>
          <div class="book-actions rise" style="--d:4">
            <a class="btn" ${link}>(Đọc thử trên Apple Books ↗)</a>
            <a class="btn buy" ${link}>Mua · ${esc(b.price)} <span class="square"></span></a>
          </div>
        </div>
        <dl class="book-meta">
          <div class="rise" style="--d:2"><span class="badge solid">Trả phí</span>${b.isNew ? '<span class="badge">Mới vào BXH</span>' : ''}</div>
          <div class="rise" style="--d:3"><dt>Xếp hạng</dt><dd>#${b.rank} · ${esc(catName(state.catalog.storeCategories, b.category))}</dd></div>
          <div class="rise" style="--d:3"><dt>Tác giả</dt><dd>${esc(author)}</dd></div>
          <div class="rise" style="--d:4"><dt>Giá</dt><dd>${esc(b.price)} <span style="color:var(--muted)">${esc(b.currency)}</span></dd></div>
          ${b.rating ? `<div class="rise" style="--d:5"><dt>Đánh giá</dt><dd><span class="stars">${'★'.repeat(r)}${'☆'.repeat(5 - r)}</span> ${b.rating}/5<br><span style="color:var(--muted)">${(b.ratingCount || 0).toLocaleString('vi-VN')} lượt</span></dd></div>` : ''}
          ${b.releaseDate ? `<div class="rise" style="--d:6"><dt>Phát hành</dt><dd>${fmtDate(Date.parse(b.releaseDate))}</dd></div>` : ''}
          <div class="rise" style="--d:6"><dt>Bán tại</dt><dd>Apple Books (Mỹ)</dd></div>
        </dl>
      </section>`;
  }

  function outroHTML(mode) {
    const store = mode === 'store';
    return `
      <section class="slide outro" data-slide="outro">
        <div><span class="square rise"></span></div>
        <div><h2 class="rise" style="--d:1">${store ? 'Ủng hộ tác giả<br>bạn yêu thích.' : 'Sẵn sàng để<br>bắt đầu đọc?'}</h2></div>
        <div><p class="rise" style="--d:2">${store
          ? 'Giá và bảng xếp hạng lấy từ Apple Books, làm mới mỗi 3 ngày. Việc thanh toán diễn ra trên Apple Books — Folio không lưu thông tin thanh toán.'
          : 'Kho sách tự làm mới mỗi 3 ngày. Sách bạn đã tải vẫn ở lại máy, kể cả khi không có mạng.'}</p>
        <p class="rise" style="--d:3"><button class="btn" data-go="0">↑ Về đầu</button>
        ${store ? '<br><br><a class="btn" href="#/">→ Thư viện miễn phí</a>' : '<br><br><a class="btn" href="#/store">→ Sách trả phí</a>'}</p></div>
      </section>`;
  }

  let deckCleanup = null;
  let currentDeck = null;   // { mode, filter } of the deck on screen

  // Shared slide-deck mechanics: snap scrolling, active slide detection, rail, keyboard.
  function mountDeck({ nav, introHTML, outroHTML, emptyHTML, onActivate, onNearEnd }) {
    setActiveNav(nav);
    document.body.classList.add('deck-mode');
    app.innerHTML = `<div class="deck" id="deck">${introHTML}<div id="slides"></div>${outroHTML}</div>
      <nav class="rail" aria-label="Điều hướng slide">
        <button data-step="-1" aria-label="Slide trước">↑</button>
        <span id="rail-no">00 / 00</span>
        <span class="bar"><i id="rail-bar"></i></span>
        <button data-step="1" aria-label="Slide sau">↓</button>
      </nav>`;
    const deck = document.getElementById('deck');
    const slidesEl = document.getElementById('slides');
    const railNo = document.getElementById('rail-no');
    const railBar = document.getElementById('rail-bar');
    let slides = [];
    let total = 0;

    const updateRail = () => {
      const no = Math.min(total, Math.max(0, state.slide));
      railNo.textContent = `${pad(no)} / ${pad(total)}`;
      railBar.style.width = `${total ? (no / total) * 100 : 0}%`;
    };

    // A slide is "active" once most of it is on screen; leaving resets it so the drop-in replays.
    const activeObs = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (e.isIntersecting && e.intersectionRatio >= 0.55) {
          e.target.classList.add('active');
          state.slide = slides.indexOf(e.target);
          updateRail();
          if (onActivate) onActivate(e.target);
          if (onNearEnd && state.slide >= slides.length - 4) onNearEnd();
        } else if (e.intersectionRatio < 0.05) {
          e.target.classList.remove('active');
        }
      }
    }, { root: deck, threshold: [0, 0.05, 0.55] });

    const collect = () => {
      activeObs.disconnect();
      slides = [...deck.querySelectorAll('.slide')];
      slides.forEach(s => activeObs.observe(s));
      updateRail();
    };

    const goTo = (i, smooth = true) => {
      i = Math.max(0, Math.min(slides.length - 1, i));
      deck.scrollTo({ top: slides[i].offsetTop, behavior: smooth ? 'smooth' : 'auto' });
    };

    app.querySelector('.rail').addEventListener('click', e => {
      const b = e.target.closest('[data-step]');
      if (b) goTo(state.slide + +b.dataset.step);
    });
    deck.addEventListener('click', e => { const g = e.target.closest('[data-go]'); if (g) goTo(+g.dataset.go); });

    const onKey = e => {
      if (e.target.matches('input, textarea')) return;
      if (['ArrowDown', 'PageDown', ' ', 'j'].includes(e.key)) { e.preventDefault(); goTo(state.slide + 1); }
      if (['ArrowUp', 'PageUp', 'k'].includes(e.key)) { e.preventDefault(); goTo(state.slide - 1); }
      if (e.key === 'Home') goTo(0);
      if (e.key === 'End') goTo(slides.length - 1);
    };
    window.addEventListener('keydown', onKey);
    deckCleanup = () => { activeObs.disconnect(); window.removeEventListener('keydown', onKey); document.body.classList.remove('deck-mode'); };

    return {
      deck,
      goTo,
      set(html, count) {
        total = count;
        slidesEl.innerHTML = count ? html : `<section class="slide"><div class="empty">${emptyHTML()}</div></section>`;
        collect();
      },
      append(html, count) { total = count; slidesEl.insertAdjacentHTML('beforeend', html); collect(); },
      start(keepSlide, jumpToFirst) {
        if (keepSlide && state.slide) goTo(state.slide, false);
        else if (jumpToFirst && total) goTo(1, false);
        else { state.slide = 0; slides[0].classList.add('active'); }
      },
    };
  }

  function viewDeck(mode, filter, keepSlide) {
    const store = mode === 'store';
    if (!store) state.filter = filter || (state.filter === 'saved' ? 'all' : state.filter);
    if (!currentDeck || currentDeck.mode !== mode) { keepSlide = false; state.query = ''; }
    currentDeck = { mode, filter: store ? null : state.filter };
    const c = state.catalog;
    let items = [];
    const d = mountDeck({
      nav: store ? 'store' : state.filter === 'saved' ? 'library' : 'home',
      introHTML: introHTML(c, mode),
      outroHTML: outroHTML(mode),
      emptyHTML: () => (store
        ? (c.offline ? 'Cửa hàng cần kết nối mạng.' : 'Không có sách trong chuyên mục này.')
        : state.filter === 'saved' ? 'Bạn chưa tải cuốn sách nào. Nhấn “(Tải xuống)” trên một slide để đọc ngoại tuyến.'
        : `Không tìm thấy sách phù hợp. <a class="btn" href="#/search?q=${encodeURIComponent(state.query)}">Tìm trong toàn bộ kho sách mở →</a>`),
    });
    const deck = d.deck;

    const renderSlides = () => {
      items = store ? filteredStore() : filteredBooks();
      document.getElementById('count').textContent = `${items.length} cuốn`;
      d.set(items.map((b, i) => (store ? storeSlideHTML : bookSlideHTML)(b, i, items.length)).join(''), items.length);
    };

    const syncChips = () => {
      deck.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b.dataset.filter === state.filter));
      deck.querySelectorAll('[data-cat]').forEach(b => b.classList.toggle('active', b.dataset.cat === state.category));
      deck.querySelectorAll('[data-scat]').forEach(b => b.classList.toggle('active', b.dataset.scat === state.storeCategory));
    };
    syncChips();
    deck.querySelector('.intro').addEventListener('click', e => {
      const b = e.target.closest('[data-filter], [data-cat], [data-scat]');
      if (!b) return;
      if (b.dataset.filter) {
        state.filter = b.dataset.filter;
        currentDeck.filter = state.filter;
        history.replaceState(null, '', state.filter === 'saved' ? '#/saved' : '#/');
      }
      if (b.dataset.cat) state.category = b.dataset.cat;
      if (b.dataset.scat) state.storeCategory = b.dataset.scat;
      syncChips(); renderSlides();
    });
    const search = deck.querySelector('.search');
    search.addEventListener('input', () => { state.query = search.value; clearTimeout(search._t); search._t = setTimeout(renderSlides, 200); });
    search.addEventListener('keydown', e => { if (e.key === 'Enter' && items.length) d.goTo(1); });

    renderSlides();
    d.start(keepSlide, filter === 'saved');
  }

  // ---------- search: every open source + the book market ----------
  const SEARCH_EXAMPLES = ['Atomic Habits', 'Nhà giả kim', 'Nam Cao', 'Stoicism', 'Truyện Kiều', 'Sherlock Holmes', 'Dale Carnegie', 'Đắc nhân tâm'];
  const ACCESS = {
    open: { label: 'Đọc miễn phí', solid: true },
    scan: { label: 'Bản scan miễn phí', solid: true },
    borrow: { label: 'Mượn miễn phí', solid: false },
    buy: { label: 'Có bán', solid: false },
  };
  const LANG_NAMES = { eng: 'Anh', vie: 'Việt', fre: 'Pháp', ger: 'Đức', spa: 'Tây Ban Nha', ita: 'Ý', rus: 'Nga', chi: 'Trung', jpn: 'Nhật', por: 'Bồ Đào Nha', kor: 'Hàn' };

  // Where to buy: store search pages built from the title (no API needed).
  function buyLinks(r) {
    const q = encodeURIComponent(`${r.title} ${(r.authors[0] || {}).name || ''}`.trim());
    const qt = encodeURIComponent(r.title);
    return [
      ['Tiki', `https://tiki.vn/search?q=${qt}`],
      ['Fahasa', `https://www.fahasa.com/searchengine?q=${qt}`],
      ['Shopee', `https://shopee.vn/search?keyword=${qt}`],
      ['Google Play Sách', `https://play.google.com/store/search?q=${q}&c=books`],
      ['Amazon Kindle', `https://www.amazon.com/s?k=${q}&i=digital-text`],
    ];
  }

  // Typographic stand-in when a book has no cover (echoes the black hardcover look).
  const genCover = r => `<div class="gen-cover reveal" style="--d:1"><b>${esc(r.title)}</b><span>${esc((r.authors[0] || {}).name || '')}</span></div>`;

  function resultSlideHTML(r, i) {
    const a = ACCESS[r.access] || ACCESS.buy;
    const readable = r.access === 'open' || r.access === 'scan';
    if (readable) state.resultMap.set(r.id, r);
    const author = r.authors[0] ? authorName(r) : '—';
    const href = readable ? `#/read/${encodeURIComponent(r.id)}` : r.sourceUrl;
    const ext = readable ? '' : 'target="_blank" rel="noopener"';
    const dl = readable && state.downloaded.get(r.id);
    const langs = (r.languages || []).map(l => LANG_NAMES[l] || l).join(', ');
    const sourceName = { gutenberg: 'Project Gutenberg', wikisource: 'Wikisource tiếng Việt', openlibrary: r.access === 'scan' ? 'Internet Archive' : 'Open Library' }[r.source] || r.source;
    const sourceUrl = r.access === 'scan' && r.ia ? `https://archive.org/details/${r.ia}` : r.sourceUrl;
    return `
      <section class="slide book result" data-i="${i}">
        <a class="cover-panel" href="${esc(href)}" ${ext} aria-label="${esc(r.title)}" data-gen="${esc(genCover(r))}">
          <span class="no rise">${pad(i + 1)}</span>
          ${r.cover ? `<img class="book-cover reveal" style="--d:1" src="${esc(r.cover)}" alt="Bìa sách ${esc(r.title)}" loading="lazy" onerror="this.outerHTML=this.parentNode.dataset.gen">` : genCover(r)}
        </a>
        <div class="book-main">
          <div class="book-title-wrap">
            <h2 class="book-title rise" style="--d:1"><a href="${esc(href)}" ${ext} data-title>${esc(r.title)}</a></h2>
            <div class="book-orig rise" style="--d:2" data-orig>${r.year ? `${r.year} · ` : ''}${esc(author)}</div>
          </div>
          <div class="book-sub">
            <h3 class="rise" style="--d:2">${readable ? 'Lời mở đầu' : 'Giới thiệu'}<br><span class="label">${esc(author)}</span></h3>
            <div class="preface rise" style="--d:3" data-intro>${r.excerpt ? `<p>${esc(r.excerpt)}…</p>` : ''}<p class="label">Đang tải…</p></div>
          </div>
          <div class="book-actions rise" style="--d:4" data-actions>
            ${readable ? `
              ${r.access === 'scan' ? `<a class="btn" href="${esc(sourceUrl)}" target="_blank" rel="noopener">(Xem bản scan gốc ↗)</a>` : ''}
              <button class="btn" data-action="${dl && dl[state.lang] ? 'remove' : 'download'}" data-id="${esc(r.id)}">${dl && dl[state.lang] ? `(Xoá bản tải ${LANG[state.lang]})` : `(Tải xuống · ${LANG[state.lang]})`}</button>
              <a class="btn read-now" href="${esc(href)}">(Đọc ngay) <span class="square"></span></a>`
            : `
              <span class="buy-links">${r.access === 'borrow' ? `<a class="btn" href="${esc(r.sourceUrl)}" target="_blank" rel="noopener">Mượn trên Open Library ↗</a>` : ''}
              ${buyLinks(r).map(([n, u]) => `<a class="btn" href="${esc(u)}" target="_blank" rel="noopener">${n} ↗</a>`).join('')}</span>
              <span data-offer></span>`}
          </div>
        </div>
        <dl class="book-meta">
          <div class="rise" style="--d:2"><span class="badge${a.solid ? ' solid' : ''}">${a.label}</span>${dl ? '<span class="badge">Offline</span>' : ''}${readable ? wantBtn(r.id) : ''}</div>
          <div class="rise" style="--d:3"><dt>Tác giả</dt><dd data-author>${esc(r.authors.map(x => x.name).join(', ') || '—')}</dd></div>
          ${r.year ? `<div class="rise" style="--d:3"><dt>Xuất bản lần đầu</dt><dd>${r.year}</dd></div>` : ''}
          ${r.pages ? `<div class="rise" style="--d:4"><dt>Số trang</dt><dd>~${r.pages}</dd></div>` : ''}
          ${r.editions > 1 ? `<div class="rise" style="--d:4"><dt>Ấn bản</dt><dd>${r.editions}</dd></div>` : ''}
          ${langs ? `<div class="rise" style="--d:5"><dt>Ngôn ngữ</dt><dd>${esc(langs)}</dd></div>` : ''}
          <div class="rise" style="--d:5" data-words></div>
          <div class="rise" style="--d:6"><dt>Nguồn</dt><dd><a class="btn" href="${esc(sourceUrl)}" target="_blank" rel="noopener">${esc(sourceName)} ↗</a></dd></div>
          ${r.access === 'scan' ? '<div class="rise" style="--d:6"><dt>Lưu ý</dt><dd style="color:var(--muted)">Văn bản nhận dạng từ bản scan (OCR), có thể có lỗi.</dd></div>' : ''}
        </dl>
      </section>`;
  }

  // Fill a result slide with its preface/description (and price) once it is on screen.
  async function loadResultDetails(slide, r) {
    if (slide.dataset.loaded) return;
    slide.dataset.loaded = '1';
    const intro = slide.querySelector('[data-intro]');
    const paras = s => (s || '').split(/\n+/).filter(Boolean).map(p => `<p>${esc(p)}</p>`).join('');
    try {
      if (r.access === 'open' || r.access === 'scan') {
        const m = await fetchJson(`/api/books/${encodeURIComponent(r.id)}/meta?lang=${state.lang}`);
        state.metaCache.set(r.id, m);
        const L = localized(m);
        intro.innerHTML = paras(L.preface || m.preface) || '<p>—</p>';
        if (L.original) slide.querySelector('[data-title]').textContent = L.title;
        if (m.authors && m.authors.length) slide.querySelector('[data-author]').textContent = m.authors.map(x => x.name).join(', ');
        if (m.words) slide.querySelector('[data-words]').innerHTML = `<dt>Độ dài</dt><dd>${m.words.toLocaleString('vi-VN')} từ · ~${Math.max(1, Math.round(m.words / 230 / 60))} giờ</dd>`;
      } else {
        const author = (r.authors[0] || {}).name || '';
        const det = await fetchJson(`/api/details?key=${encodeURIComponent(r.key || '')}&title=${encodeURIComponent(r.title)}&author=${encodeURIComponent(author)}&lang=${state.lang}`);
        const text = (state.lang === 'vi' && det.descriptionVi) || det.description;
        intro.innerHTML = paras(text) || '<p style="color:var(--muted)">Chưa có phần giới thiệu cho cuốn này. Xem nơi bán bên dưới.</p>';
        if (det.offer) {
          slide.querySelector('[data-offer]').innerHTML = `<a class="btn buy" href="${esc(det.offer.url)}" target="_blank" rel="noopener">${det.offer.free ? 'Miễn phí' : 'Mua'} · ${esc(det.offer.price)} <span class="square"></span></a>`;
        }
      }
    } catch (e) {
      intro.innerHTML = `<p style="color:var(--muted)">Không tải được thông tin (${esc(e.message)}).</p>`;
      delete slide.dataset.loaded;
    }
  }

  function parseSearchHash() {
    const qs = new URLSearchParams((location.hash.split('?')[1]) || '');
    return { q: qs.get('q') || '', scope: qs.get('scope') || 'all', cat: qs.get('cat') || '' };
  }

  function viewSearch() {
    currentDeck = { mode: 'search' };
    const s = parseSearchHash();
    const c = state.catalog;
    let results = [], page = 1, hasMore = false, loading = false, token = 0;

    const d = mountDeck({
      nav: 'search',
      introHTML: `
        <section class="slide intro" data-slide="intro">
          <div>
            <h1 class="hero-word long rise">Tìm.</h1>
            <p class="hero-note rise" style="--d:2">Tìm trong mọi nguồn sách mở. Cuốn nào còn bản quyền thì Folio chỉ đường tới nơi bán.</p>
          </div>
          <div>
            <form class="search-form rise" style="--d:1" role="search">
              <input class="search big" name="q" type="search" autocomplete="off" placeholder="Tên sách, tác giả, chủ đề…" value="${esc(s.q)}" aria-label="Tìm sách">
              <button class="btn buy" type="submit">Tìm <span class="square"></span></button>
            </form>
            <p class="examples rise" style="--d:2"><span class="label">Thử:</span> ${SEARCH_EXAMPLES.map(x => `<button type="button" data-ex="${esc(x)}">${esc(x)}</button>`).join('')}</p>
          </div>
          <div class="stats">
            <div class="stat rise" style="--d:2"><b>78K</b><span>sách Gutenberg</span><p>Đọc trọn trong app, tải về offline.</p></div>
            <div class="stat rise" style="--d:3"><b>20M+</b><span>đầu sách Open Library</span><p>Bản scan miễn phí, sách mượn và sách đang bán.</p></div>
            <div class="stat rise" style="--d:4"><b>VI</b><span>Wikisource tiếng Việt</span><p>Văn học Việt Nam hết bản quyền.</p></div>
          </div>
          <div class="toolbar">
            <div class="filters">
              <button data-scope="all">Tất cả</button>
              <button data-scope="open">Chỉ sách đọc miễn phí</button>
              <button data-scope="buy">Sách trên thị trường</button>
            </div>
            <div class="label" id="search-sum" style="align-self:center"></div>
            <div class="scroll-hint label"><span id="count"></span><span>cuộn xuống <span class="arrow">↓</span></span></div>
          </div>
          <div class="cats"><span class="label" style="align-self:center;margin-right:6px">Duyệt kho mở:</span>${(c.categories || []).map(x => `<button data-browse="${x.key}">${esc(x.vi)}</button>`).join('')}</div>
        </section>`,
      outroHTML: `
        <section class="slide outro" data-slide="outro">
          <div><span class="square rise"></span></div>
          <div><h2 class="rise" style="--d:1">Không thấy<br>cuốn bạn cần?</h2></div>
          <div><p class="rise" style="--d:2">Thử từ khoá ngắn hơn, tên tác giả, hoặc tên tiếng Anh của sách. Sách còn bản quyền có link tới Tiki, Fahasa, Shopee, Google Play Sách, Amazon và Apple Books.</p>
          <p class="rise" style="--d:3"><button class="btn" data-go="0">↑ Tìm lại</button></p></div>
        </section>`,
      emptyHTML: () => (s.q || s.cat ? 'Không tìm thấy kết quả. Thử từ khoá khác hoặc tên tiếng Anh.' : 'Nhập tên sách, tác giả hoặc chủ đề ở trên — hoặc chọn một thể loại để duyệt toàn bộ kho sách mở.'),
      onActivate: slide => {
        const i = slide.dataset.i;
        if (i != null && results[+i]) loadResultDetails(slide, results[+i]);
      },
      onNearEnd: () => { if (hasMore && !loading) fetchPage(page + 1); },
    });
    const deck = d.deck;
    const sum = document.getElementById('search-sum');
    const count = document.getElementById('count');

    const syncChips = () => {
      deck.querySelectorAll('[data-scope]').forEach(b => b.classList.toggle('active', b.dataset.scope === s.scope));
      deck.querySelectorAll('[data-browse]').forEach(b => b.classList.toggle('active', !s.q && b.dataset.browse === s.cat));
    };

    async function fetchPage(p) {
      const my = ++token;
      loading = true;
      if (p === 1) { sum.textContent = 'Đang tìm…'; count.textContent = ''; }
      try {
        const qs = new URLSearchParams({ q: s.q, scope: s.scope, page: p });
        if (s.cat) qs.set('cat', s.cat);
        const res = await fetchJson(`/api/search?${qs}`);
        if (my !== token) return;
        const start = results.length;
        results = p === 1 ? res.results : results.concat(res.results);
        page = p; hasMore = res.hasMore;
        const html = res.results.map((r, k) => resultSlideHTML(r, (p === 1 ? 0 : start) + k)).join('');
        if (p === 1) d.set(html, results.length); else d.append(html, results.length);
        const n = res.counts || {};
        const parts = [];
        if (n.gutenberg != null) parts.push(`${n.gutenberg.toLocaleString('vi-VN')} Gutenberg`);
        if (n.wikisource) parts.push(`${n.wikisource.toLocaleString('vi-VN')} Wikisource`);
        if (n.openlibrary != null) parts.push(`${n.openlibrary.toLocaleString('vi-VN')} Open Library`);
        if (p === 1) sum.textContent = parts.length ? 'Kết quả: ' + parts.join(' · ') : '';
        count.textContent = `${results.length}${hasMore ? '+' : ''} cuốn`;
      } catch (e) {
        if (my === token) { sum.textContent = navigator.onLine ? `Lỗi: ${e.message}` : 'Cần kết nối mạng để tìm kiếm.'; }
      } finally {
        if (my === token) loading = false;
      }
    }

    const run = (jump) => {
      history.replaceState(null, '', '#/search?' + new URLSearchParams(Object.entries(s).filter(([, v]) => v && v !== 'all')));
      syncChips();
      results = []; page = 1; hasMore = false;
      if (!s.q && !s.cat) { sum.textContent = ''; count.textContent = ''; d.set('', 0); return; }
      fetchPage(1).then(() => { if (jump && results.length) d.goTo(1); });
    };

    const input = deck.querySelector('.search');
    deck.querySelector('.search-form').addEventListener('submit', e => {
      e.preventDefault();
      s.q = input.value.trim(); s.cat = '';
      input.blur();
      run(true);
    });
    deck.querySelector('.intro').addEventListener('click', e => {
      const b = e.target.closest('[data-scope], [data-browse], [data-ex]');
      if (!b) return;
      if (b.dataset.scope) { s.scope = b.dataset.scope; if (s.q) run(false); else syncChips(); }
      if (b.dataset.browse) { s.cat = b.dataset.browse; s.q = ''; input.value = ''; run(true); }
      if (b.dataset.ex) { s.q = b.dataset.ex; s.cat = ''; input.value = s.q; run(true); }
    });

    d.set('', 0);
    d.start(false);
    syncChips();
    if (s.q || s.cat) run(false); else setTimeout(() => input.focus(), 300);
  }

  // Re-render the deck on screen in place (language switch, new data).
  function rerenderDeck() {
    if (!deckCleanup || !currentDeck) return;
    deckCleanup(); deckCleanup = null;
    if (currentDeck.mode === 'search') viewSearch();
    else viewDeck(currentDeck.mode, currentDeck.filter, true);
  }

  // Meta for any readable book: curated catalog, a search result already seen, or the server.
  async function bookMeta(id) {
    const inCatalog = state.catalog && state.catalog.books.find(b => b.id === id);
    if (inCatalog) return inCatalog;
    if (state.metaCache.has(id)) return state.metaCache.get(id);
    const m = await fetchJson(`/api/books/${encodeURIComponent(id)}/meta?lang=${state.lang}`);
    state.metaCache.set(id, m);
    return m;
  }

  // ---------- personal data: shelf, marks, reading stats, reader settings (per device) ----------
  const store = {
    get(key, fallback) { try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
  };

  // Shelf entry: { meta, idx, total, pct, lastRead, status: reading|want|finished, addedAt }
  const shelf = {
    all: () => store.get('folio-shelf', {}),
    get: id => shelf.all()[id] || null,
    put(id, patch) {
      const all = shelf.all();
      all[id] = { addedAt: Date.now(), ...(all[id] || {}), ...patch };
      store.set('folio-shelf', all);
      return all[id];
    },
    remove(id) { const all = shelf.all(); delete all[id]; store.set('folio-shelf', all); },
  };

  // Small, display-only copy of a book's meta for shelf cards.
  const liteMeta = m => ({
    id: m.id, title: m.title, titleVi: m.titleVi, translated: m.translated, authors: (m.authors || []).slice(0, 2),
    cover: m.cover && !String(m.cover).startsWith('data:') ? m.cover : null, source: m.source, lang: m.lang,
  });

  function toggleWant(id, meta) {
    const s = shelf.get(id);
    if (s && s.status === 'want') { shelf.remove(id); toast('Đã bỏ khỏi “Muốn đọc”'); return false; }
    if (s && s.status !== 'want') { toast(s.status === 'finished' ? 'Bạn đã đọc xong cuốn này' : 'Cuốn này đang ở “Đang đọc”'); return true; }
    shelf.put(id, { meta: liteMeta(meta), status: 'want', idx: 0, pct: 0 });
    toast('Đã thêm vào “Muốn đọc”');
    return true;
  }

  // Bookmarks and highlights per book: { bookmarks: [{idx, text, at}], highlights: [{id, idx, lang, start, end, text, color, note, at}] }
  const marks = {
    get: id => store.get(`folio-marks-${id}`, { bookmarks: [], highlights: [] }),
    set: (id, v) => store.set(`folio-marks-${id}`, v),
  };

  // Reading time per day, for the daily goal and streak.
  const stats = {
    get: () => store.get('folio-stats', { goal: 15, days: {} }),
    today: () => new Date().toLocaleDateString('sv-SE'),
    add(seconds) {
      const s = stats.get();
      const d = stats.today();
      const before = s.days[d] || 0;
      s.days[d] = before + seconds;
      store.set('folio-stats', s);
      if (before < s.goal * 60 && s.days[d] >= s.goal * 60) toast(`🎉 Bạn đã đạt mục tiêu ${s.goal} phút đọc hôm nay!`);
    },
    streak() {
      const s = stats.get();
      let n = 0;
      const day = new Date();
      // Today counts once the goal is met; otherwise the streak runs through yesterday.
      if ((s.days[stats.today()] || 0) < s.goal * 60) day.setDate(day.getDate() - 1);
      for (;;) {
        const key = day.toLocaleDateString('sv-SE');
        if ((s.days[key] || 0) >= s.goal * 60) { n++; day.setDate(day.getDate() - 1); } else break;
      }
      return n;
    },
  };

  const READER_DEFAULTS = { theme: 'light', font: 'serif', size: 20, leading: 1.65, width: 'normal', justify: true };
  const FONTS = {
    serif: { label: 'Newsreader', css: "'Newsreader', Georgia, serif" },
    sans: { label: 'Inter Tight', css: "'Inter Tight', 'Helvetica Neue', Arial, sans-serif" },
    georgia: { label: 'Georgia', css: "Georgia, 'Times New Roman', serif" },
    system: { label: 'Hệ thống', css: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" },
  };
  const WIDTHS = { narrow: 560, normal: 680, wide: 820 };
  const THEMES = { light: 'Sáng', sepia: 'Giấy', dark: 'Tối', black: 'Đen' };

  function readerSettings() {
    const s = { ...READER_DEFAULTS, ...store.get('folio-reader', {}) };
    // Carry over the settings from earlier versions.
    if (!localStorage.getItem('folio-reader')) {
      if (localStorage.getItem('folio-size')) s.size = +localStorage.getItem('folio-size');
      if (localStorage.getItem('folio-dark')) s.theme = 'dark';
    }
    return s;
  }
  function applyReaderSettings(s = readerSettings()) {
    const root = document.documentElement.style;
    root.setProperty('--reader-size', s.size + 'px');
    root.setProperty('--reader-leading', s.leading);
    root.setProperty('--reader-font', FONTS[s.font].css);
    root.setProperty('--measure', WIDTHS[s.width] + 'px');
    root.setProperty('--reader-align', s.justify ? 'justify' : 'left');
    // Reading themes apply inside the reader only; the rest of the app keeps its own look.
    document.body.classList.remove('dark', 'sepia', 'black');
    if (document.body.classList.contains('reading')) {
      if (s.theme === 'dark' || s.theme === 'black') document.body.classList.add('dark');
      if (s.theme === 'sepia' || s.theme === 'black') document.body.classList.add(s.theme);
    }
    document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.body).backgroundColor;
  }
  function saveReaderSettings(patch) {
    const s = { ...readerSettings(), ...patch };
    store.set('folio-reader', s);
    applyReaderSettings(s);
    return s;
  }

  // Translate arbitrary paragraphs (imported books have no server-side copy).
  async function translateTexts(texts) {
    const res = await fetch('/api/translate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texts }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Không dịch được');
    return (await res.json()).texts;
  }

  // ---------- reader ----------
  let readerCleanup = null;
  const HL_COLORS = { yellow: 'Vàng', green: 'Xanh lá', blue: 'Xanh dương', pink: 'Hồng' };
  const wordsOf = p => (p.t.match(/\S+/g) || []).length;

  async function viewReader(id, startAt) {
    setActiveNav('');
    app.innerHTML = `<div class="page"><div class="loading">Đang mở sách</div></div>`;
    const rec = await db.get(id).catch(() => null);
    let en;
    try {
      en = (rec && rec.en) || await fetchEn(id);
    } catch {
      app.innerHTML = `<div class="page"><div class="empty">Sách chưa được tải xuống và bạn đang ngoại tuyến.<br><br><a class="btn" href="#/library">← Tủ sách</a></div></div>`;
      return;
    }
    const meta = (rec && rec.meta && !state.catalog.books.some(b => b.id === id) ? rec.meta : null)
      || await bookMeta(id).catch(() => null) || (rec && rec.meta) || { id, title: 'Sách', authors: [] };
    const local = meta.source === 'local';
    const original = meta.lang === 'vi';                  // Vietnamese originals: never translated
    const lang = original ? 'vi' : state.lang;
    const translating = lang === 'vi' && !original;
    const L = localized(meta);
    const vi = rec && rec.vi ? rec.vi.slice() : [];        // sparse VI paragraphs by index
    const offline = translating ? !!(rec && rec.vi) : !!rec;
    const shelfEntry = shelf.get(id);
    const legacy = +localStorage.getItem(`folio-progress-${id}`) || 0;
    const saved = startAt ?? (shelfEntry ? shelfEntry.idx || 0 : legacy);
    const dl = state.downloaded.get(id);
    const settings = readerSettings();

    // Chapters = heading paragraphs; words per paragraph for time estimates.
    const toc = [];
    en.forEach((p, i) => { if (p.h) toc.push({ i, t: p.t }); });
    const words = en.map(wordsOf);
    const chapterAt = i => { let c = -1; for (let k = 0; k < toc.length && toc[k].i <= i; k++) c = k; return c; };

    shelf.put(id, { meta: liteMeta(meta), status: shelfEntry && shelfEntry.status === 'finished' ? 'finished' : 'reading', total: en.length, lastRead: Date.now() });

    app.innerHTML = `
      <div class="reader-bar">
        <a class="btn" href="#/library">← tủ sách</a>
        <div class="t">${esc(L.title)} <span class="label">· ${local ? 'sách của tôi' : offline ? 'ngoại tuyến' : 'trực tuyến'}</span></div>
        <div class="tools">
          <button class="icon-btn" data-r="toc" title="Mục lục, đánh dấu, ghi chú" aria-label="Mục lục">☰</button>
          <button class="icon-btn" data-r="find" title="Tìm trong sách" aria-label="Tìm trong sách">⌕</button>
          <button class="icon-btn" data-r="settings" title="Giao diện đọc" aria-label="Giao diện đọc">Aa</button>
          <button class="icon-btn" data-r="bookmark" title="Đánh dấu trang" aria-label="Đánh dấu trang" id="bm-btn">☆</button>
          ${local ? '' : `<button class="btn" data-r="dl">${dl && dl[lang] ? `✓ đã tải ${LANG[lang]}` : `tải ${LANG[lang]}`}</button>`}
        </div>
      </div>
      <div class="reader">
        <aside class="reader-side"><div class="stick">
          <span class="square"></span>
          <p>${esc(authorName(meta))}</p>
          <p>${toc.length ? `${toc.length} chương · ` : ''}${Math.max(1, Math.round(words.reduce((a, b) => a + b, 0) / 230 / 60))} giờ đọc</p>
          ${L.original ? `<p>${esc(L.original)}</p>` : ''}
        </div></aside>
        <article class="reader-text" id="rt" lang="${lang}">
          <h1 class="r-title">${esc(L.title)}</h1>
          <div class="r-author">${esc(authorName(meta))}</div>
          ${original ? `<div class="mt-note">${local ? 'Sách tiếng Việt của bạn.' : 'Sách tiếng Việt gốc từ Wikisource.'}</div>` : ''}
          ${meta.scanned ? '<div class="mt-note">Văn bản được nhận dạng từ bản scan (OCR) nên có thể có lỗi. Xem bản scan gốc trên Internet Archive nếu cần.</div>' : ''}
          ${translating ? '<div class="mt-note">Bản tiếng Việt được dịch máy (Google Translate) từ bản gốc, có thể chưa sát nghĩa. Chuyển EN ở góc trên để đọc bản gốc.</div>' : ''}
        </article>
        <aside class="reader-side"></aside>
      </div>
      <div class="reader-status" id="status"><span id="st-left"></span><span id="st-right">0%</span><i id="bar"></i></div>
      <div class="sel-pop" id="selpop" hidden></div>
      <div class="scrim" id="scrim" hidden></div>
      <aside class="drawer" id="drawer" hidden>
        <div class="drawer-tabs">
          <button data-tab="toc">Mục lục</button><button data-tab="marks">Đánh dấu</button>
          <button data-tab="notes">Ghi chú</button><button data-tab="find">Tìm</button>
          <button class="icon-btn" data-r="close" aria-label="Đóng">✕</button>
        </div>
        <div class="drawer-body" id="drawer-body"></div>
      </aside>
      <div class="popover" id="settings" hidden></div>
      <dialog class="note-dialog" id="note-dialog">
        <form method="dialog">
          <p class="label">Ghi chú</p>
          <blockquote id="note-quote"></blockquote>
          <textarea id="note-text" rows="5" placeholder="Viết suy nghĩ của bạn…"></textarea>
          <div class="note-actions"><button value="cancel" class="btn">Huỷ</button><button value="save" class="btn buy">Lưu <span class="square"></span></button></div>
        </form>
      </dialog>`;
    document.body.classList.add('reading');
    applyReaderSettings();

    const rt = document.getElementById('rt');
    const sentinel = document.createElement('div');
    sentinel.className = 'more';
    rt.appendChild(sentinel);
    let rendered = 0;
    let alive = true;
    let current = saved;
    let M = marks.get(id);

    // ----- rendering -----
    async function ensureVi(from, to) {
      let i = from;
      while (i < to && vi[i] != null) i++;
      if (i >= to) return;
      sentinel.textContent = 'Đang dịch…';
      if (local) {
        for (let s = i; s < to; s += 150) {
          const out = await translateTexts(en.slice(s, Math.min(to, s + 150)).map(p => p.t));
          out.forEach((t, k) => { vi[s + k] = { h: en[s + k].h, t }; });
        }
        // Keep what was translated so it reads offline next time.
        if (rec) { rec.vi = vi; db.put(rec).catch(() => {}); }
      } else {
        // The server translates at most 400 paragraphs per request.
        for (let s = i; s < to; s += 300) {
          const got = await fetchVi(id, s, Math.min(to, s + 300));
          got.forEach((p, k) => { vi[s + k] = p; });
        }
      }
    }

    const textAt = i => ((translating && vi[i]) || en[i]).t;

    // Paint a paragraph with its highlights for the language on screen.
    function paint(el) {
      const i = +el.dataset.i;
      const text = textAt(i);
      const list = M.highlights.filter(h => h.idx === i && h.lang === lang).sort((a, b) => a.start - b.start);
      if (!list.length) { el.textContent = text; return; }
      let html = '', pos = 0;
      for (const h of list) {
        if (h.start < pos || h.end > text.length) continue;
        html += esc(text.slice(pos, h.start)) + `<mark class="hl hl-${h.color}${h.note ? ' has-note' : ''}" data-hl="${h.id}">${esc(text.slice(h.start, h.end))}</mark>`;
        pos = h.end;
      }
      el.innerHTML = html + esc(text.slice(pos));
    }

    // Renders are queued so a jump waits for an in-flight render instead of being dropped.
    let queue = Promise.resolve();
    const renderUpTo = n => (queue = queue.then(() => renderNow(n)));

    async function renderNow(n) {
      n = Math.min(n, en.length);
      if (rendered >= n) return;

      try {
        if (translating) await ensureVi(rendered, n);
        if (!alive) return;
        const frag = document.createDocumentFragment();
        for (; rendered < n; rendered++) {
          const el = document.createElement(en[rendered].h ? 'h2' : 'p');
          el.dataset.i = rendered;
          paint(el);
          frag.appendChild(el);
        }
        rt.insertBefore(frag, sentinel);
        sentinel.textContent = rendered >= en.length ? '— Hết —' : '';
      } catch (e) {
        sentinel.innerHTML = `Không tải được bản dịch (${esc(e.message)}). <button class="btn" data-r="retry">Thử lại</button>`;
      } finally {

      }
    }

    async function jumpTo(i, smooth) {
      await renderUpTo(Math.max(rendered, i + 40));
      const el = rt.querySelector(`[data-i="${i}"]`);
      if (!el) return;
      const y = el.getBoundingClientRect().top + window.scrollY - 110;
      const far = Math.abs(y - window.scrollY) > window.innerHeight * 3;
      window.scrollTo({ top: y, behavior: smooth && !far ? 'smooth' : 'auto' });
      setTimeout(onScroll, smooth && !far ? 700 : 50);
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1600);
    }

    const obs = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) renderUpTo(rendered + CHUNK); }, { rootMargin: '1500px' });
    await renderUpTo(Math.max(CHUNK, saved + 20));
    obs.observe(sentinel);
    if (saved > 3) {
      const target = rt.querySelector(`[data-i="${saved}"]`);
      if (target) requestAnimationFrame(() => { target.scrollIntoView(); window.scrollBy(0, -110); if (startAt == null) toast('Tiếp tục từ chỗ bạn đọc dở'); });
    } else {
      window.scrollTo(0, 0);
    }

    // ----- progress, status line, immersive chrome -----
    const bar = document.getElementById('bar');
    const stLeft = document.getElementById('st-left');
    const stRight = document.getElementById('st-right');
    const bmBtn = document.getElementById('bm-btn');
    let lastY = window.scrollY;
    let finishedShown = shelfEntry && shelfEntry.status === 'finished';

    function updateStatus() {
      const p = Math.min(100, Math.round((current / Math.max(1, en.length - 1)) * 100));
      bar.style.width = p + '%';
      const c = chapterAt(current);
      const end = c + 1 < toc.length ? toc[c + 1].i : en.length;
      let left = 0;
      for (let k = current; k < end; k++) left += words[k];
      const mins = Math.max(1, Math.round(left / 230));
      const chapter = c >= 0 ? (translating && vi[toc[c].i] ? vi[toc[c].i].t : toc[c].t) : '';
      stLeft.textContent = `${chapter ? chapter.slice(0, 40) + ' · ' : ''}còn ${mins} phút ${c >= 0 && end < en.length ? 'trong chương' : 'là hết sách'}`;
      stRight.textContent = p + '%';
      const near = M.bookmarks.some(b => b.idx >= current && b.idx <= current + 2);
      bmBtn.textContent = near ? '★' : '☆';
      bmBtn.classList.toggle('on', near);
    }

    const onScroll = () => {
      const els = rt.querySelectorAll('[data-i]');
      let lo = 0, hi = els.length - 1, idx = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (els[mid].getBoundingClientRect().top < 120) { idx = mid; lo = mid + 1; } else hi = mid - 1;
      }
      current = els[idx] ? +els[idx].dataset.i : 0;
      updateStatus();
      // Hide the bars while reading down, bring them back when scrolling up.
      const y = window.scrollY;
      if (Math.abs(y - lastY) > 30) {
        document.body.classList.toggle('chrome-hidden', y > lastY && y > 300 && document.getElementById('drawer').hidden);
        lastY = y;
      }
      activity = Date.now();
      clearTimeout(onScroll._t);
      onScroll._t = setTimeout(() => {
        const pct = Math.round((current / Math.max(1, en.length - 1)) * 100);
        const patch = { idx: current, pct, total: en.length, lastRead: Date.now() };
        if (pct >= 98 && !finishedShown) {
          finishedShown = true;
          patch.status = 'finished';
          patch.finishedAt = Date.now();
          toast('🎉 Bạn đã đọc xong cuốn sách này!');
        }
        shelf.put(id, patch);
      }, 400);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    updateStatus();

    // Count reading time: only while the tab is visible and the reader was active in the last 2 minutes.
    let activity = Date.now();
    const onActive = () => { activity = Date.now(); };
    ['pointerdown', 'keydown', 'touchstart'].forEach(ev => window.addEventListener(ev, onActive, { passive: true }));
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && Date.now() - activity < 120000) stats.add(15);
    }, 15000);

    // ----- drawer: contents, bookmarks, notes, search -----
    const drawer = document.getElementById('drawer');
    const scrim = document.getElementById('scrim');
    const body = document.getElementById('drawer-body');
    let tab = 'toc';

    function openDrawer(t) {
      tab = t;
      drawer.hidden = false; scrim.hidden = false;
      document.body.classList.remove('chrome-hidden');
      drawer.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
      renderDrawer();
    }
    function closePanels() {
      drawer.hidden = true; scrim.hidden = true;
      document.getElementById('settings').hidden = true;
    }

    const snippet = (t, n = 140) => esc(t.length > n ? t.slice(0, n) + '…' : t);

    function renderDrawer() {
      if (tab === 'toc') {
        const c = chapterAt(current);
        body.innerHTML = toc.length
          ? `<ol class="toc">${toc.map((x, k) => `<li class="${k === c ? 'here' : ''}"><button data-jump="${x.i}">${esc((translating && vi[x.i] ? vi[x.i].t : x.t).slice(0, 80))}</button><span>${Math.round((x.i / en.length) * 100)}%</span></li>`).join('')}</ol>`
          : '<p class="drawer-empty">Sách này không chia chương. Dùng thanh tiến độ hoặc tìm trong sách.</p>';
        const here = body.querySelector('.here');
        if (here) here.scrollIntoView({ block: 'center' });
      }
      if (tab === 'marks') {
        body.innerHTML = M.bookmarks.length
          ? `<ul class="mark-list">${M.bookmarks.slice().sort((a, b) => a.idx - b.idx).map(b => `
              <li><button data-jump="${b.idx}"><b>${Math.round((b.idx / en.length) * 100)}%</b> ${snippet(b.text)}</button>
              <button class="icon-btn" data-unbm="${b.idx}" aria-label="Xoá đánh dấu">✕</button></li>`).join('')}</ul>`
          : '<p class="drawer-empty">Chưa có đánh dấu. Nhấn ☆ trên thanh công cụ để đánh dấu chỗ đang đọc.</p>';
      }
      if (tab === 'notes') {
        const list = M.highlights.slice().sort((a, b) => a.idx - b.idx || a.start - b.start);
        body.innerHTML = list.length
          ? `<p class="drawer-tools"><button class="btn" data-r="export">Xuất ghi chú (.txt) ↓</button></p><ul class="mark-list">${list.map(h => `
              <li class="hl-item"><button data-jump="${h.idx}"><span class="swatch hl-${h.color}"></span>${snippet(h.text, 220)}${h.note ? `<em>${esc(h.note)}</em>` : ''}${h.lang !== lang ? `<small>(${LANG[h.lang]})</small>` : ''}</button>
              <button class="icon-btn" data-delhl="${h.id}" aria-label="Xoá">✕</button></li>`).join('')}</ul>`
          : '<p class="drawer-empty">Bôi đen một đoạn văn để tô sáng hoặc ghi chú.</p>';
      }
      if (tab === 'find') {
        body.innerHTML = `<form class="find-form"><input type="search" id="find-q" placeholder="Tìm từ hoặc cụm từ…" autocomplete="off"><button class="btn">Tìm</button></form><div id="find-res"></div>`;
        const q = document.getElementById('find-q');
        body.querySelector('form').addEventListener('submit', e => { e.preventDefault(); runFind(q.value); });
        setTimeout(() => q.focus(), 50);
        if (runFind.last) { q.value = runFind.last; runFind(runFind.last); }
      }
    }

    function runFind(q) {
      runFind.last = q;
      const out = document.getElementById('find-res');
      const needle = q.trim().toLowerCase();
      if (needle.length < 2) { out.innerHTML = ''; return; }
      const hits = [];
      for (let i = 0; i < en.length && hits.length < 200; i++) {
        const t = translating ? (vi[i] ? vi[i].t : null) : en[i].t;
        if (t == null) continue;
        const at = t.toLowerCase().indexOf(needle);
        if (at !== -1) hits.push({ i, t, at });
      }
      out.innerHTML = `<p class="label">${hits.length}${hits.length === 200 ? '+' : ''} kết quả${translating && vi.filter(Boolean).length < en.length ? ' · chỉ tìm trong phần đã dịch' : ''}</p>`
        + `<ul class="mark-list">${hits.map(h => {
          const s = Math.max(0, h.at - 50);
          return `<li><button data-jump="${h.i}"><b>${Math.round((h.i / en.length) * 100)}%</b> ${s ? '…' : ''}${esc(h.t.slice(s, h.at))}<mark>${esc(h.t.slice(h.at, h.at + needle.length))}</mark>${esc(h.t.slice(h.at + needle.length, h.at + 120))}…</button></li>`;
        }).join('')}</ul>`;
    }

    // ----- appearance popover -----
    function renderSettings() {
      const s = readerSettings();
      const pop = document.getElementById('settings');
      pop.innerHTML = `
        <div class="set-row themes">${Object.entries(THEMES).map(([k, v]) => `<button class="theme-dot t-${k}${s.theme === k ? ' active' : ''}" data-set-theme="${k}">${v}</button>`).join('')}</div>
        <div class="set-row size"><button data-set-size="-1" aria-label="Chữ nhỏ hơn">A</button><span>${s.size}px</span><button data-set-size="1" aria-label="Chữ lớn hơn" class="big">A</button></div>
        <div class="set-row"><span class="label">Phông chữ</span><div class="seg">${Object.entries(FONTS).map(([k, f]) => `<button data-set-font="${k}" class="${s.font === k ? 'active' : ''}" style="font-family:${f.css}">${f.label}</button>`).join('')}</div></div>
        <div class="set-row"><span class="label">Giãn dòng</span><div class="seg">${[[1.45, 'Hẹp'], [1.65, 'Vừa'], [1.9, 'Rộng']].map(([v, n]) => `<button data-set-leading="${v}" class="${s.leading === v ? 'active' : ''}">${n}</button>`).join('')}</div></div>
        <div class="set-row"><span class="label">Khổ chữ</span><div class="seg">${[['narrow', 'Hẹp'], ['normal', 'Vừa'], ['wide', 'Rộng']].map(([v, n]) => `<button data-set-width="${v}" class="${s.width === v ? 'active' : ''}">${n}</button>`).join('')}</div></div>
        <div class="set-row"><span class="label">Căn đều hai bên</span><div class="seg"><button data-set-justify="1" class="${s.justify ? 'active' : ''}">Bật</button><button data-set-justify="0" class="${!s.justify ? 'active' : ''}">Tắt</button></div></div>`;
    }
    // Keep the reading position when text reflows.
    const keepPlace = fn => { const at = current; fn(); requestAnimationFrame(() => jumpTo(at, false)); };

    // ----- bookmarks & highlights -----
    function toggleBookmark() {
      const near = M.bookmarks.find(b => b.idx >= current && b.idx <= current + 2);
      if (near) { M.bookmarks = M.bookmarks.filter(b => b !== near); toast('Đã bỏ đánh dấu'); }
      else { M.bookmarks.push({ idx: current, text: textAt(current).slice(0, 200), at: Date.now() }); toast('Đã đánh dấu trang'); }
      marks.set(id, M);
      updateStatus();
    }

    const selpop = document.getElementById('selpop');
    let pending = null;   // { idx, start, end, text } for a new selection, or { hl } for an existing highlight

    function showPop(rect, html) {
      selpop.innerHTML = html;
      selpop.hidden = false;
      const w = selpop.offsetWidth;
      const left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.left + rect.width / 2 - w / 2));
      const top = rect.top > 70 ? rect.top - selpop.offsetHeight - 10 : rect.bottom + 10;
      selpop.style.left = left + 'px';
      selpop.style.top = top + 'px';
    }
    const hidePop = () => { selpop.hidden = true; pending = null; };

    const colorBtns = active => Object.keys(HL_COLORS).map(c => `<button class="swatch-btn hl-${c}${active === c ? ' active' : ''}" data-hlc="${c}" aria-label="${HL_COLORS[c]}"></button>`).join('');

    function onSelection() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      const pEl = (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement).closest('#rt [data-i]');
      if (!pEl) return;
      // Clamp to the first paragraph of the selection.
      const pre = document.createRange();
      pre.selectNodeContents(pEl);
      pre.setEnd(range.startContainer, range.startOffset);
      const start = pre.toString().length;
      let end;
      if (pEl.contains(range.endContainer)) {
        const pre2 = document.createRange();
        pre2.selectNodeContents(pEl);
        pre2.setEnd(range.endContainer, range.endOffset);
        end = pre2.toString().length;
      } else end = pEl.textContent.length;
      if (end - start < 1) return;
      const idx = +pEl.dataset.i;
      pending = { idx, start, end, text: textAt(idx).slice(start, end) };
      showPop(range.getBoundingClientRect(), `${colorBtns()}<span class="sep"></span>
        <button data-pop="note">Ghi chú</button><button data-pop="copy">Sao chép</button>
        ${!original ? `<button data-pop="translate">${lang === 'vi' ? 'Bản gốc' : 'Dịch'}</button>` : ''}`);
    }

    function addHighlight(color, note) {
      const { idx, start, end, text } = pending;
      // A new highlight replaces any it overlaps.
      M.highlights = M.highlights.filter(h => !(h.idx === idx && h.lang === lang && h.start < end && h.end > start));
      const h = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), idx, lang, start, end, text, color, note: note || '', at: Date.now() };
      M.highlights.push(h);
      marks.set(id, M);
      const el = rt.querySelector(`[data-i="${idx}"]`);
      if (el) paint(el);
      window.getSelection().removeAllRanges();
      return h;
    }

    function editNote(h) {
      const dlg = document.getElementById('note-dialog');
      document.getElementById('note-quote').textContent = h.text;
      const ta = document.getElementById('note-text');
      ta.value = h.note || '';
      dlg.onclose = () => {
        if (dlg.returnValue !== 'save') return;
        h.note = ta.value.trim();
        marks.set(id, M);
        const el = rt.querySelector(`[data-i="${h.idx}"]`);
        if (el) paint(el);
        if (!drawer.hidden) renderDrawer();
        toast(h.note ? 'Đã lưu ghi chú' : 'Đã xoá nội dung ghi chú');
      };
      dlg.returnValue = '';
      dlg.showModal();
      ta.focus();
    }

    async function popAction(a) {
      if (!pending) return;
      if (pending.hl) {
        const h = pending.hl;
        if (a === 'note') { hidePop(); return editNote(h); }
        if (a === 'copy') { navigator.clipboard && navigator.clipboard.writeText(h.text); toast('Đã sao chép'); }
        if (a === 'delete') {
          M.highlights = M.highlights.filter(x => x !== h);
          marks.set(id, M);
          const el = rt.querySelector(`[data-i="${h.idx}"]`);
          if (el) paint(el);
          toast('Đã xoá tô sáng');
        }
        return hidePop();
      }
      if (a === 'note') { const h = addHighlight('yellow'); hidePop(); return editNote(h); }
      if (a === 'copy') { navigator.clipboard && navigator.clipboard.writeText(pending.text); toast('Đã sao chép'); window.getSelection().removeAllRanges(); return hidePop(); }
      if (a === 'translate') {
        const { idx, text } = pending;
        try {
          const other = lang === 'vi'
            ? en[idx].t
            : (await translateTexts([text]))[0];
          selpop.innerHTML = `<div class="pop-translation"><p class="label">${lang === 'vi' ? 'Bản gốc (cả đoạn)' : 'Bản dịch'}</p><p>${esc(other)}</p></div>`;
        } catch (e) { toast(e.message); hidePop(); }
      }
    }

    function onReaderPointerUp(e) {
      const target = e.target instanceof Element ? e.target : document.body;
      if (target.closest('#selpop, .drawer, .popover, dialog, .reader-bar')) return;
      const mark = target.closest('mark[data-hl]');
      setTimeout(() => {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) return onSelection();
        if (mark) {
          const h = M.highlights.find(x => x.id === mark.dataset.hl);
          if (!h) return;
          pending = { hl: h };
          showPop(mark.getBoundingClientRect(), `${colorBtns(h.color)}<span class="sep"></span>
            <button data-pop="note">${h.note ? 'Sửa ghi chú' : 'Ghi chú'}</button><button data-pop="copy">Sao chép</button><button data-pop="delete">Xoá</button>
            ${h.note ? `<div class="pop-note">${esc(h.note)}</div>` : ''}`);
          return;
        }
        if (!selpop.hidden) hidePop();
      }, 10);
    }
    document.addEventListener('pointerup', onReaderPointerUp);

    // ----- clicks -----
    app.addEventListener('click', onReaderClick);
    async function onReaderClick(e) {
      const t = e.target;
      const tabBtn = t.closest('[data-tab]');
      if (tabBtn) { openDrawer(tabBtn.dataset.tab); return; }
      const jump = t.closest('[data-jump]');
      if (jump) { closePanels(); jumpTo(+jump.dataset.jump, true); return; }
      const unbm = t.closest('[data-unbm]');
      if (unbm) { M.bookmarks = M.bookmarks.filter(b => b.idx !== +unbm.dataset.unbm); marks.set(id, M); renderDrawer(); updateStatus(); return; }
      const delhl = t.closest('[data-delhl]');
      if (delhl) {
        const h = M.highlights.find(x => x.id === delhl.dataset.delhl);
        M.highlights = M.highlights.filter(x => x !== h); marks.set(id, M);
        const el = h && rt.querySelector(`[data-i="${h.idx}"]`); if (el) paint(el);
        renderDrawer(); return;
      }
      const hlc = t.closest('[data-hlc]');
      if (hlc && pending) {
        if (pending.hl) { pending.hl.color = hlc.dataset.hlc; marks.set(id, M); const el = rt.querySelector(`[data-i="${pending.hl.idx}"]`); if (el) paint(el); }
        else addHighlight(hlc.dataset.hlc);
        hidePop(); return;
      }
      const pop = t.closest('[data-pop]');
      if (pop) { popAction(pop.dataset.pop); return; }
      if (t.closest('[data-set-theme]')) { saveReaderSettings({ theme: t.closest('[data-set-theme]').dataset.setTheme }); renderSettings(); return; }
      if (t.closest('[data-set-size]')) { const s = readerSettings(); keepPlace(() => saveReaderSettings({ size: Math.max(14, Math.min(32, s.size + +t.closest('[data-set-size]').dataset.setSize)) })); renderSettings(); return; }
      if (t.closest('[data-set-font]')) { keepPlace(() => saveReaderSettings({ font: t.closest('[data-set-font]').dataset.setFont })); renderSettings(); return; }
      if (t.closest('[data-set-leading]')) { keepPlace(() => saveReaderSettings({ leading: +t.closest('[data-set-leading]').dataset.setLeading })); renderSettings(); return; }
      if (t.closest('[data-set-width]')) { keepPlace(() => saveReaderSettings({ width: t.closest('[data-set-width]').dataset.setWidth })); renderSettings(); return; }
      if (t.closest('[data-set-justify]')) { saveReaderSettings({ justify: t.closest('[data-set-justify]').dataset.setJustify === '1' }); renderSettings(); return; }
      if (t.id === 'scrim') { closePanels(); return; }

      const b = t.closest('[data-r]');
      if (!b) return;
      const r = b.dataset.r;
      if (r === 'toc') openDrawer('toc');
      if (r === 'find') openDrawer('find');
      if (r === 'close') closePanels();
      if (r === 'bookmark') toggleBookmark();
      if (r === 'retry') renderUpTo(rendered + CHUNK);
      if (r === 'settings') {
        const pop = document.getElementById('settings');
        pop.hidden = !pop.hidden; scrim.hidden = pop.hidden;
        if (!pop.hidden) renderSettings();
      }
      if (r === 'export') {
        const lines = [`${L.title} — ${authorName(meta)}`, ''];
        M.highlights.slice().sort((a, b2) => a.idx - b2.idx).forEach(h => { lines.push(`“${h.text}”`); if (h.note) lines.push(`  → ${h.note}`); lines.push(''); });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }));
        a.download = `ghi-chu-${(meta.title || 'sach').slice(0, 40).replace(/[^\p{L}\p{N}]+/gu, '-')}.txt`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      }
      if (r === 'dl') {
        const d = state.downloaded.get(id);
        if (d && d[lang]) return;
        b.disabled = true;
        try {
          await downloadBook(id, lang, p => { b.textContent = `đang dịch ${p}%`; });
          b.textContent = `✓ đã tải ${LANG[lang]}`;
          toast('Đã lưu để đọc ngoại tuyến');
        } catch (err) { b.textContent = `tải ${LANG[lang]}`; toast(err.message); }
        b.disabled = false;
      }
    }

    const onKey = e => {
      if (e.target.matches('input, textarea')) return;
      if (e.key === 'Escape') { closePanels(); hidePop(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); openDrawer('find'); }
      if (e.key === 'b' && !e.ctrlKey && !e.metaKey) toggleBookmark();
    };
    window.addEventListener('keydown', onKey);

    readerCleanup = {
      at: () => current,
      stop: () => {
        alive = false;
        obs.disconnect();
        clearInterval(timer);
        window.removeEventListener('scroll', onScroll);
        window.removeEventListener('keydown', onKey);
        ['pointerdown', 'keydown', 'touchstart'].forEach(ev => window.removeEventListener(ev, onActive));
        document.removeEventListener('pointerup', onReaderPointerUp);
        app.removeEventListener('click', onReaderClick);
        document.body.classList.remove('reading', 'chrome-hidden');
        applyReaderSettings();
        shelf.put(id, { idx: current, lastRead: Date.now() });
      },
    };
  }

  function viewAbout() {
    setActiveNav('about');
    app.innerHTML = `
      <div class="page">
        <section class="about">
          <div><span class="label">Giới thiệu</span></div>
          <div>
            <h2>Một thư viện nhỏ, đọc được ở mọi nơi.</h2>
            <p>Folio lấy sách hết bản quyền từ Project Gutenberg và Standard Ebooks, chia theo thể loại — phát triển bản thân, văn học kinh điển, triết học, trinh thám, viễn tưởng, thiếu nhi, lịch sử, thơ & kịch. Mỗi cuốn là một slide với bìa và lời mở đầu, để bạn nắm được tinh thần của sách trước khi đọc.</p>
            <p>Mục <b>Sách trả phí</b> giới thiệu sách bán chạy theo bảng xếp hạng Apple Books (giá USD). Nút “Mua” mở trang sách trên Apple Books — thanh toán và đọc diễn ra ở đó, Folio không xử lý tiền.</p>
            <p>Chuyển <b>EN / VI</b> ở góc trên: bản tiếng Việt được dịch máy từ bản gốc tiếng Anh, dịch dần khi bạn đọc và lưu lại trên máy chủ.</p>
            <p>Máy chủ tự động bổ sung sách mới sau mỗi 3 ngày. Nhấn “Tải xuống” để lưu sách (theo ngôn ngữ đang chọn) vào trình duyệt và đọc tiếp khi mất mạng. Vị trí đọc được ghi nhớ cho từng cuốn.</p>
            <p>Phím tắt trên danh sách: ↑ ↓ hoặc PageUp / PageDown để chuyển slide.</p>
          </div>
          <div>
            <div class="stat"><b>${state.catalog ? state.catalog.books.length : '—'}</b><span>đầu sách</span></div>
            <div class="stat"><b>${state.downloaded.size}</b><span>đã tải</span></div>
          </div>
        </section>
      </div>`;
  }

  // ---------- my library (tủ sách) ----------
  const ago = ts => {
    if (!ts) return '';
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 60) return m <= 1 ? 'vừa xong' : `${m} phút trước`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} giờ trước`;
    const d = Math.round(h / 24);
    return d === 1 ? 'hôm qua' : `${d} ngày trước`;
  };

  // Cover for a shelf card: shelf copy, then the saved record (imported covers live there), then a typographic stand-in.
  function cardCover(meta) {
    const saved = state.savedMeta && state.savedMeta.get(meta.id);
    const src = meta.cover || (saved && saved.cover);
    const L = localized(meta);
    const gen = `<div class="gen-cover small"><b>${esc(L.title)}</b><span>${esc((meta.authors[0] || {}).name || '')}</span></div>`;
    return src ? `<img src="${esc(src)}" alt="Bìa sách ${esc(L.title)}" loading="lazy" onerror="this.outerHTML=this.parentNode.dataset.gen">` : gen;
  }

  function shelfCard(meta, entry, extra = '') {
    const L = localized(meta);
    const pct = entry ? entry.pct || 0 : 0;
    const gen = `<div class="gen-cover small"><b>${esc(L.title)}</b><span>${esc((meta.authors[0] || {}).name || '')}</span></div>`;
    return `
      <article class="shelf-card" data-id="${esc(meta.id)}">
        <a class="sc-cover" href="#/read/${encodeURIComponent(meta.id)}" data-gen="${esc(gen)}">${cardCover(meta)}</a>
        <div class="sc-body">
          <a class="sc-title" href="#/read/${encodeURIComponent(meta.id)}">${esc(L.title)}</a>
          <span class="sc-author">${esc(meta.authors[0] ? authorName(meta) : '')}</span>
          ${entry && entry.status !== 'want' ? `<span class="sc-progress"><i style="width:${pct}%"></i></span><span class="label">${entry.status === 'finished' ? 'Đã đọc xong' : pct + '%'}${entry.lastRead ? ' · ' + ago(entry.lastRead) : ''}</span>` : ''}
          ${extra}
          <span class="sc-actions">
            ${entry ? `<button class="btn" data-shelf-del="${esc(meta.id)}">Bỏ khỏi tủ</button>` : ''}
            ${entry && entry.status === 'finished' ? `<button class="btn" data-shelf-reread="${esc(meta.id)}">Đọc lại</button>` : ''}
          </span>
        </div>
      </article>`;
  }

  async function importFiles(files) {
    let ok = 0;
    for (const file of files) {
      try {
        toast(`Đang nhập “${file.name}”…`);
        const book = await window.FolioImport.parse(file);
        // Stable id per file content size + name, so re-importing replaces instead of duplicating.
        const id = 'my~' + (file.name + file.size).split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36);
        const meta = { id, source: 'local', title: book.title, authors: book.authors, lang: book.lang, cover: book.cover, fileName: file.name };
        await db.put({ id, meta, en: book.paras, vi: null, savedAt: Date.now() });
        state.downloaded.set(id, { en: true, vi: false });
        state.savedMeta.set(id, meta);
        shelf.put(id, { meta: { ...liteMeta(meta), cover: null }, status: 'reading', idx: 0, pct: 0, total: book.paras.length });
        ok++;
      } catch (e) {
        toast(`${file.name}: ${e.message}`);
        await new Promise(r => setTimeout(r, 2500));
      }
    }
    if (ok) toast(`Đã thêm ${ok} sách vào tủ`);
    return ok;
  }

  async function viewLibrary() {
    setActiveNav('library');
    currentDeck = null;
    await loadDownloaded();
    const all = shelf.all();
    const entries = Object.entries(all).map(([id, e]) => ({ id, ...e })).filter(e => e.meta);
    const reading = entries.filter(e => e.status === 'reading').sort((a, b) => (b.lastRead || 0) - (a.lastRead || 0));
    const want = entries.filter(e => e.status === 'want').sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    const finished = entries.filter(e => e.status === 'finished').sort((a, b) => (b.finishedAt || b.lastRead || 0) - (a.finishedAt || a.lastRead || 0));
    const mine = [...state.savedMeta.values()].filter(m => m.source === 'local');
    const offline = [...state.savedMeta.values()].filter(m => m.source !== 'local');
    const noted = entries.map(e => ({ e, m: marks.get(e.id) })).filter(x => x.m.highlights.length || x.m.bookmarks.length);
    const st = stats.get();
    const todayMin = Math.floor((st.days[stats.today()] || 0) / 60);
    const streak = stats.streak();
    const last = reading[0];

    const row = (title, sub, cards, empty) => `
      <section class="shelf">
        <div class="shelf-label"><h3>${title}</h3><span class="label">${sub}</span></div>
        <div class="shelf-row">${cards || `<p class="shelf-empty">${empty}</p>`}</div>
      </section>`;

    const lastL = last && localized(last.meta);
    app.innerHTML = `
      <div class="page library">
        <section class="lib-hero">
          <div>
            <h1 class="hero-word long">Tủ sách.</h1>
            <p class="hero-note">Sách đang đọc, muốn đọc, đã đọc xong và sách của riêng bạn. Lưu trên thiết bị này.</p>
          </div>
          <div class="lib-continue">
            ${last ? `
              <a class="lc-cover" href="#/read/${encodeURIComponent(last.id)}" data-gen="${esc(`<div class="gen-cover small"><b>${esc(lastL.title)}</b></div>`)}">${cardCover(last.meta)}</a>
              <div class="lc-body">
                <span class="label">Tiếp tục đọc</span>
                <h2>${esc(lastL.title)}</h2>
                <p class="sc-author">${esc(last.meta.authors[0] ? authorName(last.meta) : '')}</p>
                <span class="sc-progress big"><i style="width:${last.pct || 0}%"></i></span>
                <p class="label">${last.pct || 0}% · ${ago(last.lastRead)}</p>
                <a class="btn buy" href="#/read/${encodeURIComponent(last.id)}">Đọc tiếp <span class="square"></span></a>
              </div>`
            : `<div class="lc-body"><span class="label">Bắt đầu</span><h2>Chưa có sách nào đang đọc.</h2>
                <p><a class="btn" href="#/">→ Mở thư viện miễn phí</a><br><a class="btn" href="#/search">→ Tìm sách</a></p></div>`}
          </div>
          <div class="lib-goal">
            <span class="label">Mục tiêu hôm nay</span>
            <div class="goal-num"><b>${todayMin}</b><span>/ ${st.goal} phút</span></div>
            <span class="sc-progress big"><i style="width:${Math.min(100, (todayMin / st.goal) * 100)}%"></i></span>
            <div class="seg goal-seg">${[5, 15, 30, 60].map(g => `<button data-goal="${g}" class="${st.goal === g ? 'active' : ''}">${g}′</button>`).join('')}</div>
            <div class="goal-stats">
              <div><b>${streak}</b><span class="label">ngày liên tiếp</span></div>
              <div><b>${finished.length}</b><span class="label">cuốn đã đọc xong</span></div>
            </div>
            <div class="week">${[...Array(7)].map((_, k) => {
              const d = new Date(); d.setDate(d.getDate() - (6 - k));
              const s = st.days[d.toLocaleDateString('sv-SE')] || 0;
              return `<span title="${d.toLocaleDateString('vi-VN')}: ${Math.floor(s / 60)} phút"><i style="height:${Math.min(100, (s / 60 / st.goal) * 100)}%"></i><em>${'CN T2 T3 T4 T5 T6 T7'.split(' ')[d.getDay()]}</em></span>`;
            }).join('')}</div>
          </div>
        </section>
        <section class="toolbar lib-toolbar">
          <div class="filters"><span class="label">Thêm sách của bạn</span></div>
          <div class="import-zone" id="import-zone">
            <label class="btn buy">Chọn file EPUB / TXT <span class="square"></span><input type="file" id="import-file" accept=".epub,.txt,application/epub+zip,text/plain" multiple hidden></label>
            <span class="label">hoặc kéo thả vào đây · chỉ file không khoá DRM · file được giữ trên máy bạn</span>
          </div>
          <div class="scroll-hint label"><span>${entries.length + mine.filter(m => !all[m.id]).length} cuốn trong tủ</span></div>
        </section>
        ${row('Đang đọc', `${reading.length} cuốn`, reading.map(e => shelfCard(e.meta, e)).join(''), 'Mở một cuốn sách bất kỳ, nó sẽ xuất hiện ở đây.')}
        ${row('Muốn đọc', `${want.length} cuốn`, want.map(e => shelfCard(e.meta, e)).join(''), 'Nhấn “+ Muốn đọc” trên slide một cuốn sách để để dành.')}
        ${row('Sách của tôi', `${mine.length} file đã nhập`, mine.map(m => shelfCard(m, all[m.id] ? { id: m.id, ...all[m.id] } : null, `<button class="btn" data-local-del="${esc(m.id)}">Xoá file</button>`)).join(''), 'Nhập file EPUB/TXT bạn đã mua (không khoá DRM) bằng nút ở trên.')}
        ${row('Đã tải xuống', `${offline.length} cuốn · đọc được khi mất mạng`, offline.map(m => shelfCard(m, all[m.id] ? { id: m.id, ...all[m.id] } : null)).join(''), 'Nhấn “(Tải xuống)” trên slide để đọc ngoại tuyến.')}
        ${row('Đã đọc xong', `${finished.length} cuốn`, finished.map(e => shelfCard(e.meta, e)).join(''), 'Đọc tới cuối một cuốn sách để thêm vào đây.')}
        ${row('Ghi chú & đánh dấu', `${noted.reduce((s, x) => s + x.m.highlights.length, 0)} ghi chú · ${noted.reduce((s, x) => s + x.m.bookmarks.length, 0)} đánh dấu`,
          noted.map(x => shelfCard(x.e.meta, x.e, `<span class="label">${x.m.highlights.length} tô sáng · ${x.m.bookmarks.length} đánh dấu</span>`)).join(''),
          'Bôi đen câu chữ khi đọc để tô sáng và ghi chú.')}
      </div>`;

    const input = document.getElementById('import-file');
    input.addEventListener('change', async () => { if (input.files.length && await importFiles([...input.files])) viewLibrary(); });
    const zone = document.getElementById('import-zone');
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
    zone.addEventListener('drop', async e => {
      e.preventDefault(); zone.classList.remove('drag');
      if (e.dataTransfer.files.length && await importFiles([...e.dataTransfer.files])) viewLibrary();
    });
  }

  // ---------- global events ----------
  // Shelf actions (library page and "+ Muốn đọc" on slides).
  app.addEventListener('click', async e => {
    const t = e.target;
    const want = t.closest('[data-want]');
    if (want) {
      const id = want.dataset.want;
      const meta = (state.catalog.books.find(b => b.id === id)) || state.resultMap.get(id) || state.metaCache.get(id);
      if (!meta) return;
      const on = toggleWant(id, meta);
      const s = shelf.get(id);
      want.textContent = on && s && s.status === 'want' ? '✓ Muốn đọc' : '+ Muốn đọc';
      want.classList.toggle('on', !!(on && s && s.status === 'want'));
      return;
    }
    const goal = t.closest('[data-goal]');
    if (goal) { const s = stats.get(); s.goal = +goal.dataset.goal; store.set('folio-stats', s); viewLibrary(); return; }
    const del = t.closest('[data-shelf-del]');
    if (del) { shelf.remove(del.dataset.shelfDel); toast('Đã bỏ khỏi tủ sách'); viewLibrary(); return; }
    const reread = t.closest('[data-shelf-reread]');
    if (reread) { shelf.put(reread.dataset.shelfReread, { status: 'reading', idx: 0, pct: 0 }); location.hash = `#/read/${encodeURIComponent(reread.dataset.shelfReread)}`; return; }
    const ldel = t.closest('[data-local-del]');
    if (ldel) {
      const id = ldel.dataset.localDel;
      if (!confirm('Xoá file sách này khỏi thiết bị? Ghi chú và vị trí đọc cũng bị xoá.')) return;
      await removeBook(id);
      shelf.remove(id);
      localStorage.removeItem(`folio-marks-${id}`);
      viewLibrary();
    }
  });

  app.addEventListener('click', async e => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const id = b.dataset.id;
    const lang = state.lang;
    b.disabled = true;
    try {
      if (b.dataset.action === 'download') {
        b.textContent = '(Đang tải…)';
        await downloadBook(id, lang, p => { b.textContent = `(Đang dịch ${p}%)`; });
        toast(`Đã lưu bản ${LANG[lang]} để đọc ngoại tuyến`);
      } else {
        await removeBook(id);
        toast('Đã xoá bản tải');
      }
      if (state.filter === 'saved' && !state.downloaded.has(id)) return rerenderDeck();
      // Update this slide in place so it stays put.
      const has = state.downloaded.get(id);
      b.dataset.action = has && has[lang] ? 'remove' : 'download';
      b.textContent = has && has[lang] ? `(Xoá bản tải ${LANG[lang]})` : `(Tải xuống · ${LANG[lang]})`;
      b.disabled = false;
    } catch (err) {
      toast(err.message || 'Có lỗi xảy ra');
      b.disabled = false;
      b.textContent = `(Tải xuống · ${LANG[lang]})`;
    }
  });

  document.querySelector('.lang').addEventListener('click', e => {
    const b = e.target.closest('[data-lang]');
    if (!b || b.dataset.lang === state.lang) return;
    state.lang = b.dataset.lang;
    localStorage.setItem('folio-lang', state.lang);
    syncLangButtons();
    // Re-render the current view in place.
    if (readerCleanup) {
      const at = readerCleanup.at();
      readerCleanup.stop(); readerCleanup = null;
      return viewReader(readerId(), at);
    }
    rerenderDeck();
  });

  const readerId = () => { const m = location.hash.match(/^#\/read\/([^/?]+)/); return m && decodeURIComponent(m[1]); };

  async function route() {
    if (readerCleanup) { readerCleanup.stop(); readerCleanup = null; }
    if (deckCleanup) { deckCleanup(); deckCleanup = null; }
    if (!state.catalog) {
      app.innerHTML = `<div class="page"><div class="loading">Đang tải thư viện</div></div>`;
      await loadCatalog();
    }
    const h = location.hash || '#/';
    if (readerId()) { currentDeck = null; return viewReader(readerId()); }
    window.scrollTo(0, 0);
    if (h.startsWith('#/search')) return viewSearch();
    if (h.startsWith('#/store')) return viewDeck('store', null, true);
    if (h.startsWith('#/library')) return viewLibrary();
    if (h.startsWith('#/saved')) return viewDeck('free', 'saved');
    if (h.startsWith('#/about')) { currentDeck = null; return viewAbout(); }
    return viewDeck('free', null, true);
  }

  function updateNet() {
    const n = document.getElementById('net');
    n.textContent = navigator.onLine ? 'online' : 'offline';
    n.classList.toggle('off', !navigator.onLine);
  }

  // ---------- boot ----------
  applyReaderSettings();
  syncLangButtons();
  window.addEventListener('hashchange', route);
  window.addEventListener('online', () => { updateNet(); toast('Đã kết nối lại'); });
  window.addEventListener('offline', () => { updateNet(); toast('Bạn đang ngoại tuyến — sách đã tải vẫn đọc được'); });
  updateNet();
  route();

  // Poll while the server is still building the catalog or translating prefaces.
  (async function poll() {
    await new Promise(r => setTimeout(r, 5000));
    const c = state.catalog;
    const all = cat => [...cat.books, ...(cat.store || [])];
    const pending = c && !c.offline && (c.refreshing || all(c).some(b => !b.translated));
    if (!pending) return;
    if (navigator.onLine) {
      const shape = cat => JSON.stringify(all(cat).map(b => [b.id, !!b.translated]));
      const before = shape(c);
      await loadCatalog();
      const ids = cat => all(cat).map(b => b.id).join();
      const visibleChange = state.lang === 'vi' || ids(c) !== ids(state.catalog);
      if (shape(state.catalog) !== before && visibleChange && currentDeck && currentDeck.mode !== 'search') rerenderDeck();
    }
    poll();
  })();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
