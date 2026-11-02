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
      state.catalog = { offline: true, updatedAt: 0, nextRefreshAt: 0, lastAdded: [], categories: [], storeCategories: [], store: [], books: recs.filter(r => r.en).map(r => r.meta) };
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
          <div class="rise" style="--d:2"><span class="badge">Miễn phí</span>${isNew ? '<span class="badge solid">Mới</span>' : ''}${dl ? `<span class="badge">Offline ${dl.en ? 'EN' : ''}${dl.vi ? ' · VI' : ''}</span>` : ''}</div>
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
        history.replaceState(null, '', state.filter === 'saved' ? '#/library' : '#/');
        setActiveNav(state.filter === 'saved' ? 'library' : 'home');
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
          <div class="rise" style="--d:2"><span class="badge${a.solid ? ' solid' : ''}">${a.label}</span>${dl ? '<span class="badge">Offline</span>' : ''}</div>
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

  // ---------- reader ----------
  let readerCleanup = null;

  async function viewReader(id, startAt) {
    setActiveNav('');
    app.innerHTML = `<div class="page"><div class="loading">Đang mở sách</div></div>`;
    const rec = await db.get(id).catch(() => null);
    let en;
    try {
      en = (rec && rec.en) || await fetchEn(id);
    } catch {
      app.innerHTML = `<div class="page"><div class="empty">Sách chưa được tải xuống và bạn đang ngoại tuyến.<br><br><a class="btn" href="#/">← Về thư viện</a></div></div>`;
      return;
    }
    const meta = (rec && rec.meta && !state.catalog.books.some(b => b.id === id) ? rec.meta : null)
      || await bookMeta(id).catch(() => null) || (rec && rec.meta) || { title: 'Sách', authors: [] };
    const lang = state.lang;
    const L = localized(meta);
    const vi = rec && rec.vi ? rec.vi.slice() : [];   // sparse VI paragraphs by index
    const offline = lang === 'vi' ? !!(rec && rec.vi) : !!rec;
    const progressKey = `folio-progress-${id}`;
    const saved = startAt ?? (+localStorage.getItem(progressKey) || 0);
    const dl = state.downloaded.get(id);

    app.innerHTML = `
      <div class="reader-bar">
        <a class="btn" href="#/">← thư viện</a>
        <div class="t">${esc(L.title)} <span class="label">· ${offline ? 'ngoại tuyến' : 'trực tuyến'}</span></div>
        <div class="tools">
          <button class="btn" data-r="smaller" aria-label="Chữ nhỏ hơn">A−</button>
          <button class="btn" data-r="bigger" aria-label="Chữ lớn hơn">A+</button>
          <button class="btn" data-r="theme">sáng/tối</button>
          <button class="btn" data-r="dl">${dl && dl[lang] ? `✓ đã tải ${LANG[lang]}` : `tải xuống ${LANG[lang]}`}</button>
          <span class="label" id="pct">0%</span>
        </div>
        <div class="progress" id="bar"></div>
      </div>
      <div class="reader">
        <aside class="reader-side"><div class="stick">
          <span class="square"></span>
          <p>${esc(authorName(meta))}</p>
          <p>${en.length.toLocaleString('vi-VN')} đoạn</p>
          ${L.original ? `<p>${esc(L.original)}</p>` : ''}
        </div></aside>
        <article class="reader-text" id="rt" lang="${lang}">
          <h1 class="r-title">${esc(L.title)}</h1>
          <div class="r-author">${esc(authorName(meta))}</div>
          ${meta.lang === 'vi' ? '<div class="mt-note">Sách tiếng Việt gốc từ Wikisource.</div>' : ''}
          ${meta.scanned ? '<div class="mt-note">Văn bản được nhận dạng từ bản scan (OCR) nên có thể có lỗi. Xem bản scan gốc trên Internet Archive nếu cần.</div>' : ''}
          ${lang === 'vi' && meta.lang !== 'vi' ? '<div class="mt-note">Bản tiếng Việt được dịch máy (Google Translate) từ bản gốc tiếng Anh, có thể chưa sát nghĩa. Chuyển EN ở góc trên để đọc bản gốc.</div>' : ''}
        </article>
        <aside class="reader-side"></aside>
      </div>`;

    const rt = document.getElementById('rt');
    const sentinel = document.createElement('div');
    sentinel.className = 'more';
    rt.appendChild(sentinel);
    let rendered = 0;
    let busy = false;
    let alive = true;

    async function ensureVi(from, to) {
      let i = from;
      while (i < to && vi[i] != null) i++;
      if (i >= to) return;
      sentinel.textContent = 'Đang dịch…';
      const got = await fetchVi(id, i, to);
      got.forEach((p, k) => { vi[i + k] = p; });
    }

    async function renderUpTo(n) {
      n = Math.min(n, en.length);
      if (busy || rendered >= n) return;
      busy = true;
      try {
        if (lang === 'vi') await ensureVi(rendered, n);
        if (!alive) return;
        const frag = document.createDocumentFragment();
        for (; rendered < n; rendered++) {
          const p = (lang === 'vi' && vi[rendered]) || en[rendered];
          const el = document.createElement(p.h ? 'h2' : 'p');
          el.textContent = p.t;
          el.dataset.i = rendered;
          frag.appendChild(el);
        }
        rt.insertBefore(frag, sentinel);
        sentinel.textContent = rendered >= en.length ? '— Hết —' : '';
      } catch (e) {
        sentinel.innerHTML = `Không tải được bản dịch (${esc(e.message)}). <button class="btn" data-r="retry">Thử lại</button>`;
      } finally {
        busy = false;
      }
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

    const bar = document.getElementById('bar');
    const pct = document.getElementById('pct');
    let current = saved;
    const onScroll = () => {
      const els = rt.querySelectorAll('[data-i]');
      let lo = 0, hi = els.length - 1, idx = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (els[mid].getBoundingClientRect().top < 120) { idx = mid; lo = mid + 1; } else hi = mid - 1;
      }
      current = els[idx] ? +els[idx].dataset.i : 0;
      const p = Math.min(100, Math.round((current / Math.max(1, en.length - 1)) * 100));
      bar.style.width = p + '%';
      pct.textContent = p + '%';
      clearTimeout(onScroll._t);
      onScroll._t = setTimeout(() => localStorage.setItem(progressKey, current), 300);
    };
    window.addEventListener('scroll', onScroll, { passive: true });

    const size = () => +getComputedStyle(document.documentElement).getPropertyValue('--reader-size').replace('px', '');
    const setSize = s => { document.documentElement.style.setProperty('--reader-size', s + 'px'); localStorage.setItem('folio-size', s); };
    app.addEventListener('click', onReaderClick);
    async function onReaderClick(e) {
      const b = e.target.closest('[data-r]');
      if (!b) return;
      const r = b.dataset.r;
      if (r === 'smaller') setSize(Math.max(14, size() - 1));
      if (r === 'bigger') setSize(Math.min(30, size() + 1));
      if (r === 'retry') renderUpTo(rendered + CHUNK);
      if (r === 'theme') { document.body.classList.toggle('dark'); localStorage.setItem('folio-dark', document.body.classList.contains('dark') ? '1' : ''); }
      if (r === 'dl') {
        const d = state.downloaded.get(id);
        if (d && d[lang]) return;
        b.disabled = true;
        try {
          await downloadBook(id, lang, p => { b.textContent = `đang dịch ${p}%`; });
          b.textContent = `✓ đã tải ${LANG[lang]}`;
          toast('Đã lưu để đọc ngoại tuyến');
        } catch (err) { b.textContent = `tải xuống ${LANG[lang]}`; toast(err.message); }
        b.disabled = false;
      }
    }

    readerCleanup = { at: () => current, stop: () => { alive = false; obs.disconnect(); window.removeEventListener('scroll', onScroll); app.removeEventListener('click', onReaderClick); } };
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

  // ---------- global events ----------
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
    if (h.startsWith('#/library')) return viewDeck('free', 'saved');
    if (h.startsWith('#/about')) { currentDeck = null; return viewAbout(); }
    return viewDeck('free', null, true);
  }

  function updateNet() {
    const n = document.getElementById('net');
    n.textContent = navigator.onLine ? 'online' : 'offline';
    n.classList.toggle('off', !navigator.onLine);
  }

  // ---------- boot ----------
  if (localStorage.getItem('folio-dark')) document.body.classList.add('dark');
  const sz = localStorage.getItem('folio-size');
  if (sz) document.documentElement.style.setProperty('--reader-size', sz + 'px');
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
