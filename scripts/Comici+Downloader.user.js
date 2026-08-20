// ==UserScript==
// @name         Comici+ Universal Downloader
// @version      1.2.0
// @icon         https://www.google.com/s2/favicons?domain=comici.jp&sz=128
// @description  Tải truyện trên nền tảng Comici+, có đóng gói ZIP, lưu tên trang theo số thứ tự tăng dần và một file txt lưu tên mã truyện tương ứng (Champion Cross, Comic Growl, Young Champion, Young Animal, Hana to Yume, Big Comics, Rimacomi+, HERO'S Web, Takecomic, Hayacomic, MAGKAN, COMIC MeDu, Comic PASH!, KimiComi, Comic Room Base, Comirela, BiBiBi Comic, Mangalt, Comici Comic và bổ sung thêm comici.jp).
// @author       anonymous & AI
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      comici.jp
// @connect      *.comici.jp
// @connect      cdn.comici.jp
// @connect      cdn-public.comici.jp
// @connect      *.comics.comici.jp
// @connect      *.championcross.jp
// @connect      *.comic-growl.com
// @connect      *.youngchampion.jp
// @connect      *.younganimal.com
// @connect      *.hanayume.com
// @connect      *.bigcomics.jp
// @connect      *.heros-web.com
// @connect      *.takecomic.jp
// @connect      *.hayacomic.jp
// @connect      *.kansai.mag-garden.co.jp
// @connect      *.g-comi.jp
// @connect      *.comicpash.jp
// @connect      *.kimicomi.com
// @connect      *.comic-room-base.com
// @connect      *.comirela.com
// @connect      *.bibibi-comic.com
// @connect      *.mangalt.jp
// @connect      *.rimacomiplus.jp

// @match        https://championcross.jp/*
// @match        https://comic-growl.com/*
// @match        https://youngchampion.jp/*
// @match        https://younganimal.com/*
// @match        https://hanayume.com/*
// @match        https://bigcomics.jp/*
// @match        https://heros-web.com/*
// @match        https://takecomic.jp/*
// @match        https://hayacomic.jp/*
// @match        https://kansai.mag-garden.co.jp/*
// @match        https://g-comi.jp/*
// @match        https://comicpash.jp/*
// @match        https://kimicomi.com/*
// @match        https://comic-room-base.com/*
// @match        https://comirela.com/*
// @match        https://bibibi-comic.com/*
// @match        https://mangalt.jp/*
// @match        https://comics.comici.jp/*
// @match        https://rimacomiplus.jp/*
// @match        https://comici.jp/*
// ==/UserScript==

(function comiciUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6, // Số lượng trang ảnh tải song song
    JPEG_QUALITY: 0.95 // Chất lượng xuất JPG
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  /* =========================================================================
   * 1. BỘ ĐÓNG GÓI ZIP NGUYÊN BẢN (PURE ZIP WRITER)
   * ========================================================================= */
  class PureZipWriter {
    constructor() {
      this.files = [];
    }

    addFile(filename, uint8Array) {
      this.files.push({ name: filename, data: uint8Array });
    }

    static crc32(data) {
      let crc = -1;
      for (let i = 0; i < data.length; i++) {
        crc = (crc >>> 8) ^ PureZipWriter.crcTable[(crc ^ data[i]) & 0xFF];
      }
      return (crc ^ -1) >>> 0;
    }

    generateBlob() {
      const parts = [];
      const centralEntries = [];
      let offset = 0;
      const enc = new TextEncoder();

      for (const file of this.files) {
        const nameBytes = enc.encode(file.name);
        const dataBytes = file.data;
        const crc = PureZipWriter.crc32(dataBytes);
        const size = dataBytes.length;

        const header = new Uint8Array(30 + nameBytes.length);
        const view = new DataView(header.buffer);
        view.setUint32(0, 0x04034b50, true);
        view.setUint16(4, 20, true);
        view.setUint16(6, 0, true);
        view.setUint16(8, 0, true);
        view.setUint16(10, 0, true);
        view.setUint16(12, 0, true);
        view.setUint32(14, crc, true);
        view.setUint32(18, size, true);
        view.setUint32(22, size, true);
        view.setUint16(26, nameBytes.length, true);
        view.setUint16(28, 0, true);
        header.set(nameBytes, 30);

        parts.push(header);
        parts.push(dataBytes);

        const cent = new Uint8Array(46 + nameBytes.length);
        const cview = new DataView(cent.buffer);
        cview.setUint32(0, 0x02014b50, true);
        cview.setUint16(4, 20, true);
        cview.setUint16(6, 20, true);
        cview.setUint16(8, 0, true);
        cview.setUint16(10, 0, true);
        cview.setUint16(12, 0, true);
        cview.setUint16(14, 0, true);
        cview.setUint32(16, crc, true);
        cview.setUint32(20, size, true);
        cview.setUint32(24, size, true);
        cview.setUint16(28, nameBytes.length, true);
        cview.setUint16(30, 0, true);
        cview.setUint16(32, 0, true);
        cview.setUint16(34, 0, true);
        cview.setUint16(36, 0, true);
        cview.setUint32(38, 0, true);
        cview.setUint32(42, offset, true);
        cent.set(nameBytes, 46);

        centralEntries.push(cent);
        offset += header.length + size;
      }

      let centralSize = 0;
      for (const cent of centralEntries) {
        parts.push(cent);
        centralSize += cent.length;
      }

      const eocd = new Uint8Array(22);
      const eview = new DataView(eocd.buffer);
      eview.setUint32(0, 0x06054b50, true);
      eview.setUint16(4, 0, true);
      eview.setUint16(6, 0, true);
      eview.setUint16(8, this.files.length, true);
      eview.setUint16(10, this.files.length, true);
      eview.setUint32(12, centralSize, true);
      eview.setUint32(16, offset, true);
      eview.setUint16(20, 0, true);

      parts.push(eocd);

      return new Blob(parts, { type: 'application/zip' });
    }
  }

  PureZipWriter.crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    PureZipWriter.crcTable[i] = c;
  }

  /* =========================================================================
   * 2. STATE & HELPER FUNCTIONS
   * ========================================================================= */
  const state = {
    running: false,
    convertJpeg: localStorage.getItem("comici-dl:convert-jpeg") === '1',
    cachedPages: [],
    ui: null,
    lastProgress: { completed: 0, total: 0, percent: 0, status: "Đang kiểm tra..." }
  };

  function isEpisodeUrl() {
    const p = WIN.location.pathname;
    return /\/(?:episodes?|articles?)\//.test(p);
  }

  function saveJpegPref(val) {
    try {
      WIN.localStorage.setItem("comici-dl:convert-jpeg", val ? '1' : '0');
    } catch {}
  }

  function getEpisodeId() {
    try {
      const sessionEl = DOC.getElementById('sessionId');
      if (sessionEl && sessionEl.textContent.trim()) {
        return sessionEl.textContent.trim();
      }
      const match = WIN.location.pathname.match(/\/(?:episodes?|articles?)\/([a-zA-Z0-9_-]+)/);
      if (match && match[1]) return match[1];
    } catch (e) {}
    return "Comici_Episode";
  }

  function cleanString(str) {
    if (!str) return "";
    return str
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/【[^】]*】/g, '')
      .replace(/[\\/*?:"<>|]/g, '')
      .trim();
  }

  // TẠO TÊN FILE ZIP CHUẨN: "Tên Truyện - Tên Chap"
  function getCleanTitle() {
    try {
      let seriesTitle = "";
      let episodeTitle = "";

      // 1. Lấy tên truyện
      const viewerEl = DOC.getElementById('comici-viewer') || DOC.querySelector('[data-comic-title]');
      if (viewerEl) {
        seriesTitle = viewerEl.getAttribute('data-comic-title') || "";
      }
      if (!seriesTitle) {
        const sEl = DOC.querySelector('.a-series-title, .series-title-wrapper a, .episode-header-series-title, .series-header-title, [class*="series-title"]');
        if (sEl) seriesTitle = sEl.textContent.trim();
      }

      // 2. Lấy tên tập / chap
      const eEl = DOC.querySelector('.title-line2, .article-title-box .title-line2, .episode-header-title, [class*="episode-title"], .ep-title');
      if (eEl) episodeTitle = eEl.textContent.trim();

      // 3. Dự phòng document.title
      if ((!seriesTitle || !episodeTitle) && DOC.title) {
        const parts = DOC.title.split(/[｜|・-]/);
        if (parts.length >= 2) {
          if (!seriesTitle) seriesTitle = parts[0].trim();
          if (!episodeTitle) episodeTitle = parts[1].trim();
        }
      }

      seriesTitle = cleanString(seriesTitle);
      episodeTitle = cleanString(episodeTitle);

      if (seriesTitle && episodeTitle && !seriesTitle.includes(episodeTitle)) {
        return `${seriesTitle} - ${episodeTitle}`;
      } else if (seriesTitle) {
        return seriesTitle;
      } else if (episodeTitle) {
        return episodeTitle;
      }
    } catch (e) {}

    return `Comici_${getEpisodeId()}`;
  }

  function getExtensionFromUrl(url, defaultExt = 'jpg') {
    try {
      const pathname = new URL(url, WIN.location.href).pathname;
      const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
      if (match && match[1]) {
        const ext = match[1].toLowerCase();
        if (['jpg', 'jpeg', 'png', 'webp', 'avif'].includes(ext)) {
          return ext === 'jpeg' ? 'jpg' : ext;
        }
      }
    } catch (e) {}
    return defaultExt;
  }

  /* =========================================================================
   * 3. BƯỚC TIỀN XỬ LÝ (PREPROCESSING CONTEXT)
   * Tách biệt rõ ràng giữa Comici+ Tạp chí bản quyền và Rimacomi+ / Comics.comici
   * ========================================================================= */
  function preprocessViewerContext(viewerEl) {
    const hostname = WIN.location.hostname;
    // Kiểm tra trang có thuộc nhóm cấu trúc đặc thù (rimacomiplus hoặc comics.comici)
    const isSpecialComici = hostname.includes('rimacomiplus.jp') || hostname.includes('comics.comici.jp');

    let contentId = '';
    let seriesTitle = '';
    let prSelectors = [];

    if (isSpecialComici) {
      /* -------------------------------------------------------------
       * [XỬ LÝ ĐẶC THÙ] rimacomiplus.jp & comics.comici.jp
       * ------------------------------------------------------------- */
      // Bắt buộc lấy data-content-id để API không trả về mảng rỗng
      contentId = viewerEl.getAttribute('data-content-id') || '';

      // Tên truyện được lưu trực tiếp trong thuộc tính data-comic-title của Viewer
      seriesTitle = viewerEl.getAttribute('data-comic-title') || '';

      // Bộ selector ảnh thương mại PR đặc thù của Rimacomi+ & Comics.comici
      prSelectors = [
        '#xCVTopPr figure img',
        '.mode-top-pr img',
        '.-cv-pr-img-wrap img'
      ];
    } else {
      /* -------------------------------------------------------------
       * [XỬ LÝ CHUẨN] Comici+ Tạp chí phổ thông (Champion Cross, Young Animal...)
       * ------------------------------------------------------------- */
      contentId = viewerEl.getAttribute('data-content-id') || '';

      const sEl = DOC.querySelector('.episode-header-series-title, .series-header-title, [class*="series-title"]');
      if (sEl) seriesTitle = sEl.textContent.trim();

      // Bộ selector ảnh PR tạp chí Comici+ thông thường
      prSelectors = [
        '.-cv-pr-img-wrap img',
        '.x-cv-pr-img'
      ];
    }

    return {
      viewerId: viewerEl.getAttribute('data-comici-viewer-id') || '',
      contentId,
      seriesTitle,
      prSelectors
    };
  }

  // Quét ảnh PR / Quảng Cáo toàn trang theo bộ Selectors đã tiền xử lý
  async function getAllPrImages(prSelectors = [], timeoutMs = 400) {
    const defaultSelectors = [
      '.-cv-pr-img-wrap img',
      '#xCVTopPr figure img',
      '.mode-top-pr img',
      '.x-cv-pr-img'
    ];
    const selectorsToQuery = (prSelectors && prSelectors.length > 0) ? prSelectors : defaultSelectors;

    const startTime = Date.now();
    const prList = [];

    while (Date.now() - startTime < timeoutMs) {
      const imgs = DOC.querySelectorAll(selectorsToQuery.join(', '));
      for (const img of imgs) {
        let src = img.getAttribute('data-src') || img.getAttribute('src') || '';
        if (!src || src.startsWith('data:')) continue;

        // BỘ LỌC KÍCH THƯỚC: Bỏ qua icon logo nhỏ (chiều cao < 500px)
        const w = img.naturalWidth || parseInt(img.getAttribute('width') || '0', 10);
        const h = img.naturalHeight || parseInt(img.getAttribute('height') || '0', 10);

        if (w > 0 && h > 0 && h < 500) {
          continue;
        }

        if (src.startsWith('//')) src = 'https:' + src;
        if (!prList.includes(src)) {
          prList.push(src);
        }
      }
      if (prList.length > 0) break;
      await sleep(100);
    }
    return prList;
  }

  /* =========================================================================
   * 4. TRÍCH XUẤT DANH SÁCH TRANG (COMICI+ & COMICI.JP ENGINES)
   * ========================================================================= */
  async function fetchComiciPlusPages(viewerEl) {
    const ctx = preprocessViewerContext(viewerEl);
    if (!ctx.viewerId) {
      throw new Error("Chưa có ID viewer.");
    }

    const contentParam = ctx.contentId ? `&contentId=${encodeURIComponent(ctx.contentId)}` : '';

    // BƯỚC 1: Gọi API Init lấy tổng số trang
    const initUrl = `${WIN.location.origin}/api/book/contentsInfo?user-id=&comici-viewer-id=${ctx.viewerId}&page-from=0&page-to=1${contentParam}`;

    const initRes = await new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: initUrl,
        headers: { "Accept": "application/json" },
        onload: r => {
          if (r.status === 200) {
            try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(e); }
          } else {
            reject(new Error(`API Init HTTP ${r.status}.`));
          }
        },
        onerror: () => reject(new Error("Lỗi kết nối API."))
      });
    });

    if (!initRes || typeof initRes.totalPages !== 'number') {
      throw new Error("Không lấy được tổng số trang.");
    }

    const totalPages = initRes.totalPages;

    // BƯỚC 2: Gọi API lấy toàn bộ danh sách trang
    const fullUrl = `${WIN.location.origin}/api/book/contentsInfo?user-id=&comici-viewer-id=${ctx.viewerId}&page-from=0&page-to=${totalPages}${contentParam}`;

    const fullRes = await new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: fullUrl,
        headers: { "Accept": "application/json" },
        onload: r => {
          if (r.status === 200) {
            try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(e); }
          } else {
            reject(new Error(`API Full HTTP ${r.status}.`));
          }
        },
        onerror: () => reject(new Error("Lỗi mạng API Full."))
      });
    });

    if (!fullRes || !Array.isArray(fullRes.result)) {
      throw new Error("API lỗi dữ liệu trang.");
    }

    const resultPages = [];
    let prCount = 0;
    let mainPageNo = 1;

    // 1. Quét Ảnh PR Thương Mại theo đúng bộ Selector đã tiền xử lý
    const prSrcs = await getAllPrImages(ctx.prSelectors, 400);
    for (const prSrc of prSrcs) {
      prCount++;
      resultPages.push({
        isPR: true,
        prNo: prCount,
        url: prSrc,
        scramble: null
      });
    }

    // 2. Nạp các trang truyện chính (1.png, 2.png...)
    for (let i = 0; i < fullRes.result.length; i++) {
      const item = fullRes.result[i];
      let imgUrl = item.imageUrl || item.src || item.url;
      if (!imgUrl) continue;
      if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;

      // Tránh lặp trang PR đã bắt từ DOM
      const alreadyInPR = prSrcs.some(ps => imgUrl.includes(ps.split('?')[0]));
      if (alreadyInPR) continue;

      let scramble = item.scramble || item.scramble_key || item.scrambleKey;
      if (typeof scramble === 'string') {
        try { scramble = JSON.parse(scramble); } catch (e) { scramble = null; }
      }

      resultPages.push({
        isPR: false,
        pageNo: mainPageNo++,
        url: imgUrl,
        scramble: scramble
      });
    }

    resultPages.forEach(p => {
      if (p.isPR) p.singlePR = (prCount === 1);
    });

    return resultPages;
  }

  // Engine quét dành riêng cho comici.jp dạng bài viết cuộn (Articles)
  async function fetchComiciJpArticlePages() {
    const resultPages = [];
    const foundUrls = new Set();

    function extractUrlsFromText(rawText) {
      if (!rawText) return;
      let text = rawText;
      try { text = decodeURIComponent(text); } catch {}
      text = text.replace(/\\\//g, '/').replace(/\\"/g, '"');

      // Quét Slate JSON: {"type":"image",...,"url":"..."}
      const slateRegex = /"type"\s*:\s*"image"[^}]*?"url"\s*:\s*"([^"]+)"/gi;
      let sMatch;
      while ((sMatch = slateRegex.exec(text)) !== null) {
        let u = sMatch[1].trim();
        if (u.startsWith('//')) u = 'https:' + u;
        if (u.startsWith('http')) foundUrls.add(u);
      }

      // Quét CDN bài viết: cdn.comici.jp/articles/...
      const cdnRegex = /(?:https?:)?\/\/(?:cdn|cdn-public)\.comici\.jp\/articles\/\d+\/default\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|webp|avif)/gi;
      let cMatch;
      while ((cMatch = cdnRegex.exec(text)) !== null) {
        let u = cMatch[0].trim();
        if (u.startsWith('//')) u = 'https:' + u;
        foundUrls.add(u);
      }
    }

    // 1. Tải HTML server bóc Slate JSON
    const serverHtml = await new Promise(resolve => {
      GM_xmlhttpRequest({
        method: "GET",
        url: WIN.location.href,
        headers: { "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
        timeout: 10000,
        onload: res => resolve(res.status >= 200 && res.status < 300 ? res.responseText : null),
        onerror: () => resolve(null),
        ontimeout: () => resolve(null)
      });
    });

    if (serverHtml) extractUrlsFromText(serverHtml);
    if (DOC.documentElement) extractUrlsFromText(DOC.documentElement.innerHTML);

    // 2. Quét thuộc tính Lazy-load
    const lazyImgs = DOC.querySelectorAll('img, [data-src], [data-original], [data-lazy], [data-lazy-src], [data-bg], [data-url], [srcset]');
    for (const el of lazyImgs) {
      const candidates = [
        el.getAttribute('data-src'),
        el.getAttribute('data-original'),
        el.getAttribute('data-lazy-src'),
        el.getAttribute('data-lazy'),
        el.getAttribute('data-url'),
        el.getAttribute('data-bg'),
        el.getAttribute('src')
      ];

      for (let src of candidates) {
        if (!src || src.startsWith('data:')) continue;
        if (src.includes('cdn.comici.jp/articles/')) {
          if (src.startsWith('//')) src = 'https:' + src;
          foundUrls.add(src);
        }
      }
    }

    let pageNo = 1;
    for (const u of foundUrls) {
      resultPages.push({
        isPR: false,
        pageNo: pageNo++,
        url: u,
        scramble: null // comici.jp bài viết là ảnh nguyên bản, không bị scramble
      });
    }

    return resultPages;
  }

  async function fetchComiciPages() {
    if (state.cachedPages && state.cachedPages.length > 0) {
      return state.cachedPages;
    }

    const viewerEl = DOC.getElementById('comici-viewer') || DOC.querySelector('[data-comici-viewer-id]');
    let pages = [];

    if (viewerEl) {
      // NHÁNH 1: Comici+ Tạp chí & Rimacomi+ & Comics.comici (Viewer chuẩn)
      pages = await fetchComiciPlusPages(viewerEl);
    } else {
      // NHÁNH 2: comici.jp bài viết cuộn (Articles / Slate JSON)
      pages = await fetchComiciJpArticlePages();
    }

    state.cachedPages = pages;
    return pages;
  }

  function fetchImageBlob(url) {
    return new Promise((resolve, reject) => {
      let fullUrl = url;
      if (fullUrl.startsWith('//')) fullUrl = 'https:' + fullUrl;

      GM_xmlhttpRequest({
        method: "GET",
        url: fullUrl,
        headers: {
          "Referer": WIN.location.href,
          "Origin": WIN.location.origin,
          "User-Agent": WIN.navigator.userAgent,
          "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
        },
        responseType: "blob",
        timeout: 25000,
        onload: res => {
          if (res.status >= 200 && res.status < 300 && res.response && res.response.size > 0) {
            resolve(res.response);
          } else {
            reject(new Error(`HTTP ${res.status}.`));
          }
        },
        onerror: () => reject(new Error("Lỗi tải ảnh.")),
        ontimeout: () => reject(new Error("Timeout tải ảnh."))
      });
    });
  }

  /* =========================================================================
   * 5. THUẬT TOÁN GIẢI MÃ MA TRẬN 4x4
   * ========================================================================= */
  async function unscrambleComiciBlob(rawBlob, scrambleArray, isJpg) {
    const isIdentity = !scrambleArray || (Array.isArray(scrambleArray) && scrambleArray.length === 16 && scrambleArray.every((val, idx) => val === idx));
    const rawType = rawBlob.type || '';

    // TỐI ƯU HÓA: Bỏ qua Canvas nếu không cần giải mã để tiết kiệm RAM & CPU
    if (isIdentity) {
      if (isJpg && (rawType.includes('jpeg') || rawType.includes('jpg'))) {
        const buffer = await rawBlob.arrayBuffer();
        return { uint8Array: new Uint8Array(buffer), ext: 'jpg' };
      }
      if (!isJpg && rawType.includes('png')) {
        const buffer = await rawBlob.arrayBuffer();
        return { uint8Array: new Uint8Array(buffer), ext: 'png' };
      }
    }

    const objUrl = WIN.URL.createObjectURL(rawBlob);
    const img = new WIN.Image();
    img.decoding = "async";

    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("Lỗi nạp ảnh."));
      img.src = objUrl;
    });
    WIN.URL.revokeObjectURL(objUrl);

    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;

    const canvas = DOC.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    const cellWidth = Math.floor(width / 4);
    const cellHeight = Math.floor(height / 4);

    if (isIdentity || !Array.isArray(scrambleArray) || scrambleArray.length < 16) {
      ctx.drawImage(img, 0, 0, width, height, 0, 0, width, height);
    } else {
      const pos = [];
      for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
          pos.push([col, row]);
        }
      }

      const v = scrambleArray.map(idx => pos[idx]);
      let f = 0;
      for (let p = 0; p < 4; p++) {
        for (let h = 0; h < 4; h++) {
          if (v[f]) {
            const srcCol = v[f][0];
            const srcRow = v[f][1];
            ctx.drawImage(
              img,
              srcCol * cellWidth, srcRow * cellHeight, cellWidth, cellHeight,
              p * cellWidth, h * cellHeight, cellWidth, cellHeight
            );
          }
          f++;
        }
      }
    }

    const mimeType = isJpg ? 'image/jpeg' : 'image/png';
    const quality = isJpg ? CONFIG.JPEG_QUALITY : undefined;

    const blob = await new Promise(resolve => canvas.toBlob(resolve, mimeType, quality));

    canvas.width = 0;
    canvas.height = 0;

    const buffer = await blob.arrayBuffer();
    return {
      uint8Array: new Uint8Array(buffer),
      ext: isJpg ? 'jpg' : 'png'
    };
  }

  /* =========================================================================
   * 6. TIẾN TRÌNH TẢI SONG SONG
   * ========================================================================= */
  async function runParallelQueue(tasks, limit, onProgress) {
    const results = new Array(tasks.length);
    let completed = 0;
    let index = 0;

    const workers = Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
      while (index < tasks.length) {
        const currentIndex = index++;
        try {
          results[currentIndex] = await tasks[currentIndex]();
        } catch (err) {
          console.error(`[comici-dl] Lỗi trang ${currentIndex + 1}:`, err);
          results[currentIndex] = null;
        } finally {
          completed++;
          onProgress(completed, tasks.length);
        }
      }
    });

    await Promise.all(workers);
    return results;
  }

  function triggerDownload(blob, fileName) {
    const url = WIN.URL.createObjectURL(blob);
    const a = DOC.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = "noopener";
    a.style.display = "none";
    DOC.documentElement.appendChild(a);
    a.click();
    a.remove();
    WIN.setTimeout(() => WIN.URL.revokeObjectURL(url), 60000);
  }

  /* =========================================================================
   * 7. GIAO DIỆN UI (THEME ĐỎ COMICI #c8232c)
   * ========================================================================= */
  function updateProgressUI(data = {}) {
    const total = Number.isFinite(data.total) ? data.total : state.lastProgress.total;
    const completed = Number.isFinite(data.completed) ? data.completed : state.lastProgress.completed;
    const pct = total > 0 ? Math.max(0, Math.min(100, Math.round(completed / total * 100))) : 0;

    state.lastProgress = {
      completed,
      total,
      percent: pct,
      status: data.status || state.lastProgress.status
    };

    const ui = state.ui;
    if (!ui) return;

    ui.count.textContent = total ? Math.min(completed, total) + '/' + total : "0/0";
    ui.percent.textContent = pct + '%';
    ui.fill.style.transform = "scaleX(" + (total > 0 ? pct / 100 : 0) + ')';
    ui.status.textContent = state.lastProgress.status;
  }

  function setUiBusy(isBusy) {
    const ui = state.ui;
    if (!ui) return;
    ui.button.disabled = Boolean(isBusy);
    ui.button.textContent = "Download";
    ui.button.style.opacity = isBusy ? "0.72" : '1';
    ui.button.style.cursor = isBusy ? "progress" : "pointer";
    ui.jpgInput.disabled = Boolean(isBusy);
  }

  function createUI() {
    if (state.ui || !DOC.body || DOC.getElementById("comici-dl-panel")) return;

    const PANEL_WIDTH = 220;
    const TAB_WIDTH = 14;
    let isCollapsed = localStorage.getItem("comici-dl:collapsed") === '1';

    const panel = DOC.createElement("div");
    panel.id = "comici-dl-panel";
    panel.style.cssText = [
      "all:initial",
      "position:fixed",
      "right:0px",
      "top:61px",
      "z-index:2147483647",
      "box-sizing:border-box",
      `width:${PANEL_WIDTH}px`,
      "padding:10px 14px",
      "border:1px solid #c8232c",
      "border-right:none",
      "border-radius:12px 0 0 12px",
      "background:#1c070a",
      "color:#ffffff",
      "font:12px/1.3 system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif",
      "user-select:none",
      "box-shadow:0 8px 24px rgba(0,0,0,0.85)",
      "transition:transform 0.22s cubic-bezier(0.16, 1, 0.3, 1)",
      `transform:${isCollapsed ? `translateX(calc(100% - ${TAB_WIDTH}px))` : "translateX(0)"}`,
      "display:block",
      "overflow:hidden"
    ].join(';');

    const collapsedStrip = DOC.createElement("div");
    collapsedStrip.style.cssText = [
      "all:initial",
      "position:absolute",
      "left:0px",
      "top:0px",
      `width:${TAB_WIDTH}px`,
      "height:100%",
      "background:#c8232c",
      "cursor:pointer",
      "transition:opacity 0.15s, background 0.15s",
      `opacity:${isCollapsed ? "1" : "0"}`,
      `pointer-events:${isCollapsed ? "auto" : "none"}`
    ].join(';');
    collapsedStrip.title = "Mở bảng tải";
    collapsedStrip.onmouseenter = () => { collapsedStrip.style.background = "#e11d48"; };
    collapsedStrip.onmouseleave = () => { collapsedStrip.style.background = "#c8232c"; };

    const mainContent = DOC.createElement("div");
    mainContent.style.cssText = [
      "all:initial",
      "display:block",
      "transition:opacity 0.2s",
      `opacity:${isCollapsed ? "0" : "1"}`,
      `pointer-events:${isCollapsed ? "none" : "auto"}`
    ].join(';');

    const collapseBtn = DOC.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.textContent = "▶";
    collapseBtn.title = "Thu gọn";
    collapseBtn.style.cssText = [
      "all:initial",
      "position:absolute",
      "left:0px",
      "top:0px",
      "width:24px",
      "height:24px",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "border-radius:12px 0 8px 0",
      "background:#c8232c",
      "color:#ffffff",
      "font:900 10px system-ui,sans-serif",
      "cursor:pointer",
      "transition:background 0.15s ease",
      "z-index:2"
    ].join(';');
    collapseBtn.onmouseenter = () => { collapseBtn.style.background = "#e11d48"; };
    collapseBtn.onmouseleave = () => { collapseBtn.style.background = "#c8232c"; };

    const title = DOC.createElement("div");
    title.textContent = "Comici+ Downloader";
    title.style.cssText = "all:initial;display:block;color:#fca5a5;font:800 13px system-ui;margin-bottom:8px;text-align:center;padding-left:14px;";

    const btn = DOC.createElement("button");
    btn.type = "button";
    btn.textContent = "Download";
    btn.style.cssText = [
      "all:initial",
      "display:block",
      "box-sizing:border-box",
      "width:100%",
      "padding:8px 0",
      "border:0",
      "border-radius:6px",
      "background:#c8232c",
      "color:#ffffff",
      "font:800 14px/1.2 system-ui,sans-serif",
      "text-align:center",
      "cursor:pointer",
      "box-shadow:0 3px 10px rgba(200, 35, 44, 0.35)"
    ].join(';');

    btn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      if (!state.running) startDownload();
    });

    const label = DOC.createElement("label");
    label.style.cssText = "all:initial;display:inline-flex;align-items:center;gap:6px;margin-top:8px;color:#fecaca;font:700 11px system-ui;cursor:pointer;";

    const jpgInput = DOC.createElement("input");
    jpgInput.type = "checkbox";
    jpgInput.checked = state.convertJpeg;
    jpgInput.style.cssText = "all:initial;appearance:auto;width:14px;height:14px;accent-color:#c8232c;cursor:pointer;";
    jpgInput.addEventListener("change", () => {
      state.convertJpeg = jpgInput.checked;
      saveJpegPref(state.convertJpeg);
    });

    const spanJpg = DOC.createElement("span");
    spanJpg.textContent = "Xuất file JPG (mặc định PNG)";
    spanJpg.style.cssText = "all:initial;color:#fecaca;font:700 11px system-ui;";
    label.append(jpgInput, spanJpg);

    const progressRow = DOC.createElement("div");
    progressRow.style.cssText = "all:initial;display:flex;justify-content:space-between;align-items:center;margin-top:10px;color:#ffffff;font:800 12px system-ui;";

    const countText = DOC.createElement("span");
    countText.textContent = "0/0";
    countText.style.cssText = "all:initial;color:#ffffff;font:800 12px system-ui;";

    const percentText = DOC.createElement("span");
    percentText.textContent = "0%";
    percentText.style.cssText = "all:initial;color:#ffffff;font:800 12px system-ui;";

    progressRow.append(countText, percentText);

    const track = DOC.createElement("div");
    track.style.cssText = "all:initial;display:block;height:6px;overflow:hidden;border-radius:3px;background:#451a1a;margin-top:6px;";

    const fill = DOC.createElement("div");
    fill.style.cssText = "all:initial;display:block;width:100%;height:100%;background:#f87171;transform:scaleX(0);transform-origin:left center;transition:transform .22s ease;";
    track.appendChild(fill);

    const statusText = DOC.createElement("div");
    statusText.textContent = state.lastProgress.status;
    statusText.style.cssText = "all:initial;display:block;margin-top:8px;color:#fecaca;font:11px system-ui;word-break:break-word;";

    mainContent.append(collapseBtn, title, btn, label, progressRow, track, statusText);
    panel.append(collapsedStrip, mainContent);

    function setCollapsedState(collapsed) {
      isCollapsed = collapsed;
      localStorage.setItem("comici-dl:collapsed", isCollapsed ? '1' : '0');

      panel.style.transform = isCollapsed ? `translateX(calc(100% - ${TAB_WIDTH}px))` : "translateX(0)" ;
      collapsedStrip.style.opacity = isCollapsed ? "1" : "0";
      collapsedStrip.style.pointerEvents = isCollapsed ? "auto" : "none";
      mainContent.style.opacity = isCollapsed ? "0" : "1";
      mainContent.style.pointerEvents = isCollapsed ? "none" : "auto";
    }

    collapseBtn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      setCollapsedState(true);
    });

    panel.addEventListener("click", () => {
      if (isCollapsed) setCollapsedState(false);
    });

    DOC.body.appendChild(panel);

    state.ui = {
      panel,
      button: btn,
      jpgInput,
      count: countText,
      percent: percentText,
      fill,
      status: statusText
    };

    updateProgressUI(state.lastProgress);
  }

  /* =========================================================================
   * 8. CHƯƠNG TRÌNH TẢI CHÍNH
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    state.running = true;
    setUiBusy(true);

    try {
      updateProgressUI({ completed: 0, total: 0, status: "Đang tải dữ liệu..." });

      const pages = await fetchComiciPages();
      const totalPages = pages.length;

      if (!totalPages) {
        throw new Error("Không tìm thấy trang truyện.");
      }

      const useJpeg = Boolean(state.convertJpeg);
      const zip = new PureZipWriter();
      const episodeId = getEpisodeId();

      zip.addFile(`${episodeId}.txt`, new Uint8Array(0));

      updateProgressUI({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map((pageObj) => async () => {
        const rawBlob = await fetchImageBlob(pageObj.url);

        // Ảnh PR Thương Mại: giữ nguyên file gốc từ CDN
        if (pageObj.isPR) {
          let ext = getExtensionFromUrl(pageObj.url);
          if (!ext && rawBlob.type) {
            ext = rawBlob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
          }
          const arrayBuffer = await rawBlob.arrayBuffer();
          const fileName = pageObj.singlePR ? `PR.${ext}` : `PR_${pageObj.prNo}.${ext}`;
          return {
            fileName: fileName,
            data: new Uint8Array(arrayBuffer)
          };
        }

        // Trang truyện chính: giải mã 4x4
        const decoded = await unscrambleComiciBlob(rawBlob, pageObj.scramble, useJpeg);
        return {
          fileName: `${pageObj.pageNo}.${decoded.ext}`,
          data: decoded.uint8Array
        };
      });

      const results = await runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        updateProgressUI({
          completed,
          total,
          status: "Đang tải..."
        });
      });

      updateProgressUI({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      let savedCount = 0;
      for (const res of results) {
        if (res && res.data && res.data.length > 0) {
          zip.addFile(res.fileName, res.data);
          savedCount++;
        }
      }

      if (savedCount === 0) {
        throw new Error("Lỗi đưa ảnh vào ZIP.");
      }

      const zipBlob = zip.generateBlob();
      const zipFileName = `${getCleanTitle()}.zip`;
      triggerDownload(zipBlob, zipFileName);

      updateProgressUI({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      const msg = err?.message || String(err);
      updateProgressUI({ status: "Lỗi: " + msg });
      console.error("[comici-dl] Error:", err);
    } finally {
      state.running = false;
      setUiBusy(false);
      updateProgressUI(state.lastProgress);
    }
  }

  /* =========================================================================
   * 9. BỘ LẮNG NGHE CHUYỂN TRANG (SPA ROUTE WATCHER) & BOOT
   * ========================================================================= */
  function initRouteWatcher() {
    let lastUrl = WIN.location.href;

    const onUrlChange = () => {
      const currentUrl = WIN.location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;

        state.cachedPages = [];
        state.running = false;
        setUiBusy(false);

        boot();
      }
    };

    const origPush = WIN.history.pushState;
    WIN.history.pushState = function(...args) {
      origPush.apply(this, args);
      onUrlChange();
    };

    const origReplace = WIN.history.replaceState;
    WIN.history.replaceState = function(...args) {
      origReplace.apply(this, args);
      onUrlChange();
    };

    WIN.addEventListener("popstate", onUrlChange);
    WIN.addEventListener("hashchange", onUrlChange);
    WIN.setInterval(onUrlChange, 600);
  }

  async function boot() {
    while (!DOC.body) {
      await sleep(100);
    }
    createUI();

    if (!isEpisodeUrl()) {
      if (state.ui?.panel) state.ui.panel.style.display = "none";
      return;
    }

    if (state.ui?.panel) state.ui.panel.style.display = "block";

    updateProgressUI({ completed: 0, total: 0, status: "Đang kiểm tra..." });

    let pages = [];
    let retries = 0;
    let lastError = null;

    while (retries < 25) {
      if (!isEpisodeUrl()) return;
      try {
        pages = await fetchComiciPages();
        if (pages.length > 0) break;
      } catch (e) {
        lastError = e;
      }
      await sleep(200);
      retries++;
    }

    if (pages.length > 0 && isEpisodeUrl()) {
      updateProgressUI({
        completed: 0,
        total: pages.length,
        status: "Sẵn sàng."
      });
    } else if (isEpisodeUrl()) {
      updateProgressUI({
        completed: 0,
        total: 0,
        status: lastError ? `${lastError.message || lastError}` : "Không nạp được trang."
      });
    }
  }

  initRouteWatcher();

  if (DOC.readyState === "loading") {
    DOC.addEventListener("DOMContentLoaded", () => boot());
  } else {
    boot();
  }
})();