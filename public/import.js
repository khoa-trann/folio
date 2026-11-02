// Folio: import the reader's own DRM-free EPUB / TXT files, entirely in the browser.
// Exposes window.FolioImport.parse(file) -> { title, authors, lang, cover (data URL|null), paras: [{h, t}] }
(() => {
  // ---------- minimal ZIP reader (central directory + DecompressionStream) ----------
  async function unzip(buf) {
    const dv = new DataView(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('File EPUB bị hỏng (không đọc được nội dung nén).');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = new Map();
    const dec = new TextDecoder();
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = dec.decode(new Uint8Array(buf, p + 46, nameLen));
      entries.set(name, { method, csize, local });
      p += 46 + nameLen + extraLen + commentLen;
    }
    async function read(name) {
      const e = entries.get(name) || entries.get(decodeURIComponent(name));
      if (!e) return null;
      const lnLen = dv.getUint16(e.local + 26, true);
      const lxLen = dv.getUint16(e.local + 28, true);
      const data = new Uint8Array(buf, e.local + 30 + lnLen + lxLen, e.csize);
      if (e.method === 0) return data;
      if (e.method !== 8) throw new Error('EPUB dùng kiểu nén không hỗ trợ.');
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    return { names: [...entries.keys()], read, text: async name => { const b = await read(name); return b && dec.decode(b); } };
  }

  // ---------- helpers ----------
  const clean = s => s.replace(/\s+/g, ' ').trim();
  const resolve = (base, href) => {
    const parts = (base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : '').concat(href.split('#')[0]).split('/');
    const out = [];
    for (const s of parts) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); }
    return out.join('/');
  };
  const parseXml = (s, type = 'application/xml') => {
    let doc = new DOMParser().parseFromString(s, type);
    if (doc.querySelector('parsererror')) doc = new DOMParser().parseFromString(s, 'text/html');
    return doc;
  };
  const byLocal = (root, name) => [...root.getElementsByTagName('*')].filter(e => e.localName === name);
  const HEADING = /^(CHAPTER|Chapter|CHƯƠNG|Chương|PART|Part|PHẦN|Phần|BOOK|Book|HỒI|Hồi|PROLOGUE|EPILOGUE|PREFACE|Preface|LỜI NÓI ĐẦU|Lời nói đầu|LỜI GIỚI THIỆU)\b/;

  async function toDataUrl(bytes, type) {
    return new Promise(res => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.readAsDataURL(new Blob([bytes], { type }));
    });
  }

  // Shrink big covers so the library stays light in IndexedDB.
  async function shrink(dataUrl) {
    try {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const scale = Math.min(1, 600 / img.height);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.85);
    } catch { return dataUrl; }
  }

  // ---------- EPUB ----------
  async function parseEpub(file) {
    const zip = await unzip(await file.arrayBuffer());
    const enc = await zip.text('META-INF/encryption.xml');
    if (enc) {
      // Font obfuscation is fine; anything else means the book content is DRM-protected.
      const algs = [...enc.matchAll(/Algorithm="([^"]+)"/g)].map(m => m[1]);
      const drm = algs.some(a => !/idpf\.org\/2008\/embedding|ns\.adobe\.com\/pdf\/enc#RC/i.test(a));
      if (drm || /adobe\.com\/adept|fairplay/i.test(enc)) throw new Error('Sách này có khoá bản quyền (DRM) nên không mở được. Hãy đọc trong ứng dụng của cửa hàng đã bán sách.');
    }
    const container = await zip.text('META-INF/container.xml');
    if (!container) throw new Error('Không phải file EPUB hợp lệ.');
    const opfPath = (container.match(/full-path="([^"]+)"/) || [])[1];
    const opf = parseXml(await zip.text(opfPath));
    const meta = byLocal(opf, 'metadata')[0] || opf;
    const dc = n => { const e = byLocal(meta, n)[0]; return e ? clean(e.textContent) : ''; };
    const items = new Map(byLocal(opf, 'item').map(i => [i.getAttribute('id'), {
      href: resolve(opfPath, i.getAttribute('href')), type: i.getAttribute('media-type') || '', props: i.getAttribute('properties') || '',
    }]));
    const spine = byLocal(opf, 'itemref').map(r => items.get(r.getAttribute('idref'))).filter(i => i && /html|xml/.test(i.type));

    // Cover: EPUB 3 "cover-image", EPUB 2 <meta name="cover">, or a file named like a cover.
    let coverItem = [...items.values()].find(i => /cover-image/.test(i.props));
    if (!coverItem) {
      const m = byLocal(meta, 'meta').find(x => x.getAttribute('name') === 'cover');
      if (m) coverItem = items.get(m.getAttribute('content'));
    }
    if (!coverItem) coverItem = [...items.values()].find(i => /^image\//.test(i.type) && /cover/i.test(i.href));
    let cover = null;
    if (coverItem) {
      const bytes = await zip.read(coverItem.href);
      if (bytes) cover = await shrink(await toDataUrl(bytes, coverItem.type || 'image/jpeg'));
    }

    const paras = [];
    for (const it of spine) {
      const src = await zip.text(it.href);
      if (!src) continue;
      const doc = parseXml(src, 'application/xhtml+xml');
      const body = doc.body || byLocal(doc, 'body')[0];
      if (!body) continue;
      const blocks = [...body.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,dt,dd')]
        // Skip blocks nested in another block we already take (e.g. <p> inside <blockquote>).
        .filter(el => !el.parentElement.closest('p,li,blockquote,pre,dd'));
      for (const el of blocks) {
        const t = clean(el.textContent);
        if (!t) continue;
        const h = /^h[1-6]$/i.test(el.localName) || (t.length < 70 && HEADING.test(t));
        paras.push({ h, t });
      }
    }
    if (!paras.length) throw new Error('Không tìm thấy nội dung văn bản trong file này.');
    const creators = byLocal(meta, 'creator').map(e => clean(e.textContent)).filter(Boolean);
    return {
      title: dc('title') || file.name.replace(/\.epub$/i, ''),
      authors: creators.map(name => ({ name, birth: null, death: null })),
      lang: (dc('language') || '').toLowerCase().startsWith('vi') ? 'vi' : 'en',
      cover,
      paras,
    };
  }

  // ---------- TXT ----------
  async function parseTxt(file) {
    const buf = await file.arrayBuffer();
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.includes('�')) text = new TextDecoder('windows-1258').decode(buf);   // older Vietnamese files
    text = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
    const paras = text.split(/\n\s*\n/).map(clean).filter(Boolean).map(t => ({
      h: t.length < 70 && (HEADING.test(t) || (t === t.toUpperCase() && /\p{Lu}{3}/u.test(t))),
      t,
    }));
    if (!paras.length) throw new Error('File trống.');
    return {
      title: file.name.replace(/\.txt$/i, ''),
      authors: [],
      lang: /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(text.slice(0, 5000)) ? 'vi' : 'en',
      cover: null,
      paras,
    };
  }

  async function parse(file) {
    if (/\.epub$/i.test(file.name) || file.type === 'application/epub+zip') return parseEpub(file);
    if (/\.txt$/i.test(file.name) || file.type === 'text/plain') return parseTxt(file);
    if (/\.pdf$/i.test(file.name)) throw new Error('Chưa hỗ trợ PDF. Hãy dùng EPUB hoặc TXT.');
    if (/\.(azw3?|kfx|mobi|acsm)$/i.test(file.name)) throw new Error('File Kindle/ACSM có khoá DRM hoặc chưa được hỗ trợ. Chỉ nhập được EPUB/TXT không khoá.');
    throw new Error('Định dạng chưa hỗ trợ. Hãy chọn file .epub hoặc .txt.');
  }

  window.FolioImport = { parse };
})();
