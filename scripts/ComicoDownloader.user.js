// ==UserScript==
// @name         Comico Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://www.google.com/s2/favicons?domain=comico.jp&sz=128
// @description  Tải manga trên Comico.
// @author       anonymous & AI
// @match        https://www.comico.jp/*
// @match        https://comico.jp/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      comico.jp
// @connect      *.comico.jp
// @connect      api.comico.jp
// @connect      images.comico.io
// @connect      *.comico.io
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/ComicoDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/ComicoDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function comicoUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH & HẰNG SỐ MẬT MÃ
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6
  };

  // Khóa tĩnh giải mã URL đối xứng của Comico (IMPORTANT)
  const STATIC_AES_KEY = 'a7fc9dc89f2c873d79397f8a0028a4cd';

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    chapterData: null,
    ui: null,
    cachedWebKey: null,
    lastUrl: "",
    lastChapterId: ""
  };

  /* =========================================================================
   * GIAO DIỆN UNIVERSAL UI CHUẨN 2 TẦNG
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const isPocket = WIN.location.hostname.includes('pocketcomics.com');
      const titleName = isPocket ? "Pocket Comics" : "Comico";

      const uiConfig = {
        storagePrefix: "comico-dl",
        title: titleName,
        engine: "COMICO VIEWER",
        themeColor: "#F40008",      
        themeBg: "#ffffff",         
        titleColor: "#F40008",
        btnBg: "#F40008",
        btnColor: "#ffffff",
        topOffset: "60px",
        defaultJpgText: "Xuất file JPG (ảnh gốc là JPG)",
        onDownload: startDownload,
      }

      state.ui = createUI(uiConfig);
      state.ui.setBusy(true);

      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:${uiConfig.titleColor};letter-spacing:0.2px;">${titleName}</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px;visibility:hidden;">${uiConfig.engine}</div>
          `;
        }
      }
    }
    return state.ui;
  }

  /* =========================================================================
   * BỘ HỖ TRỢ XỬ LÝ CHUỖI & ĐẶT TÊN
   * ========================================================================= */
  function isEpisodeUrl() {
    return /\/(?:comic|magazine_comic)\/\d+\/chapter\/\d+/i.test(WIN.location.pathname);
  }

  function cleanString(str) {
    if (!str) return "";
    return str
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/【(?!(?:フルカラー版|カラー版|完全版|特装版))[^】]*】/gi, '')
      .replace(/[\\/*?:"<>|]/g, '')
      .trim();
  }

  function getEpisodeId() {
    const match = WIN.location.pathname.match(/\/chapter\/(\d+)/i);
    return match ? match[1] : "Comico_Chapter";
  }

  function getCleanTitle(data) {
    try {
      let series = cleanString(data?.seriesName);
      let episode = cleanString(data?.chapterName);

      if (!series) {
        const sEl = DOC.querySelector('h1[class*="title"], [class*="comic-title"], .article-title, h1');
        if (sEl) series = cleanString(sEl.textContent);
      }

      if (!series || !episode) {
        let raw = (DOC.title || "").split(/[|｜]/)[0].trim();
        raw = raw.replace(/[-－–—\s]*(?:comico|コミコ|Pocket Comics).*$/gi, '').trim();

        const match = raw.match(/^(.*?)(?:\s+[-－–—]\s+|\s+)((?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\s\-\–\—\ー\~〜\.]+(?:話|巻|章)?.*)$/i);
        if (match) {
          if (!series) series = cleanString(match[1]);
          if (!episode) episode = cleanString(match[2]);
        } else if (!series) {
          series = cleanString(raw);
        }
      }

      if (series && episode) {
        if (episode.startsWith(series)) {
          episode = cleanString(episode.substring(series.length));
        }
        episode = episode.replace(/^[・･\s-]+/, '').trim();
      }

      if (series && episode && !series.includes(episode)) {
        return `${series} - ${episode}`;
      } else if (episode) {
        return episode;
      } else if (series) {
        return series;
      }
    } catch (e) {}

    return `Comico_${getEpisodeId()}`;
  }

  /* =========================================================================
   * THUẬT TOÁN MẬT MÃ: NATIVE WEB CRYPTO API
   * ========================================================================= */
  async function decryptAesUrl(base64Ciphertext) {
    const keyBytes = new TextEncoder().encode(STATIC_AES_KEY);
    const cryptoKey = await WIN.crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'AES-CBC' },
      false,
      ['decrypt']
    );

    const binary = atob(base64Ciphertext);
    const cipherBytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) cipherBytes[i] = binary.charCodeAt(i);

    const iv = new Uint8Array(16); // Vector IV 16 bytes số 0 chuẩn AES-CBC
    const decryptedBuffer = await WIN.crypto.subtle.decrypt(
      { name: 'AES-CBC', iv },
      cryptoKey,
      cipherBytes
    );

    return new TextDecoder().decode(decryptedBuffer);
  }

  async function computeCheckSum(webKey, timestamp) {
    const msg = `${webKey}0.0.0.0${timestamp}`;
    const msgBytes = new TextEncoder().encode(msg);
    const hashBuf = await WIN.crypto.subtle.digest('SHA-256', msgBytes);
    return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function getWebKey(Utils) {
    if (state.cachedWebKey) return state.cachedWebKey;
    const cached = sessionStorage.getItem('comico_web_key');
    if (cached) {
      state.cachedWebKey = cached;
      return cached;
    }

    const scriptEls = Array.from(DOC.querySelectorAll('link[rel="modulepreload"], script[src*="_nuxt/"], script[type="module"]'));
    for (const el of scriptEls) {
      const src = el.getAttribute('href') || el.getAttribute('src');
      if (!src) continue;
      try {
        const fullUrl = new URL(src, WIN.location.origin).href;
        const buf = await Utils.fetchBuffer(fullUrl);
        const txt = new TextDecoder().decode(buf);
        const m = txt.match(/"([0-9a-f]{32})"\s*\+\s*[a-zA-Z0-9_$]+\s*\+\s*[a-zA-Z0-9_$]+/);
        if (m && m[1]) {
          const k = m[1];
          sessionStorage.setItem('comico_web_key', k);
          state.cachedWebKey = k;
          return k;
        }
      } catch (e) {}
    }
    return "";
  }

  /* =========================================================================
   * BÓC TÁCH DANH SÁCH ẢNH TỪ COMICO API
   * ========================================================================= */
  async function fetchComicoPages() {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    const path = WIN.location.pathname;
    const isMagazine = path.includes('magazine_comic');

    const webKey = await getWebKey(Utils);
    const timestamp = Math.round(Date.now() / 1000);
    const checkSum = await computeCheckSum(webKey, timestamp);

    let cleanPath = path.replace(/\/product\/?$/, '').replace(/\/$/, '');
    const apiOrigin = WIN.location.origin.replace('www.', 'api.');
    const apiUrl = `${apiOrigin}${cleanPath}/product`;

    const headers = {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'ja-JP',
      'X-comico-check-sum': checkSum,
      'X-comico-client-accept-mature': 'Y',
      'X-comico-client-immutable-uid': '0.0.0.0',
      'X-comico-client-os': 'other',
      'X-comico-client-platform': 'web',
      'X-comico-client-store': 'other',
      'X-comico-request-time': String(timestamp),
      'X-comico-timezone-id': 'Asia/Tokyo'
    };

    let json = null;
    try {
      const res = await WIN.fetch(apiUrl, { headers, credentials: 'include' });
      json = await res.json();
    } catch (fetchErr) {
      const resBuf = await Utils.fetchBuffer(apiUrl, headers);
      json = JSON.parse(new TextDecoder().decode(resBuf));
    }

    const chapter = json?.data?.chapter || json?.data?.product?.chapter || json?.data;
    const content = json?.data?.content || json?.data?.product?.content;
    if (!chapter) throw new Error("API Comico không trả về dữ liệu chương.");

    // Bắt chính xác tên truyện và tên tập theo đúng cấu trúc JSON
    const seriesName = content?.name || chapter?.comicName || "";
    const chapterName = chapter?.name || "";

    const pages = [];

    // 1. NHÁNH MAGAZINE COMIC (EPUB FIXED-LAYOUT QUA STANDARD.OPF)
    const epubData = chapter.epub || json?.data?.epub;
    if (epubData?.chapterEpubIncludedFile) {
      const epubConfig = epubData.chapterEpubIncludedFile;
      const decryptedBase = await decryptAesUrl(epubConfig.url);
      const opfUrl = `${decryptedBase}${epubConfig.rootPath}${epubConfig.rootFileName}?${epubConfig.parameter}`;

      const opfBuf = await Utils.fetchBuffer(opfUrl);
      const opfXml = new TextDecoder().decode(opfBuf);
      const xmlDoc = new DOMParser().parseFromString(opfXml, 'text/xml');

      const items = xmlDoc.querySelectorAll('item[media-type="image/jpeg"], item[media-type="image/png"], item[media-type="image/webp"]');
      const opt = epubConfig.m2Parameter?.optimize || '/dims/optimize';

      items.forEach((item, idx) => {
        const href = item.getAttribute('href');
        if (href) {
          pages.push({
            pageNo: idx + 1,
            url: `${decryptedBase}${epubConfig.rootPath}${href}${opt}?${epubConfig.parameter}`
          });
        }
      });
    }
    // 2. NHÁNH WEBTOON CUỘN DỌC (COMIC THƯỜNG)
    else if (Array.isArray(chapter.images)) {
      for (let idx = 0; idx < chapter.images.length; idx++) {
        const imgObj = chapter.images[idx];
        const decryptedUrl = await decryptAesUrl(imgObj.url);
        const param = imgObj.parameter ? `?${imgObj.parameter}` : '';
        pages.push({
          pageNo: idx + 1,
          url: `${decryptedUrl}${param}`
        });
      }
    }

    return {
      seriesName,
      chapterName,
      pages
    };
  }

  /* =========================================================================
   * TIẾN TRÌNH TẢI CHÍNH (6 LUỒNG SONG SONG TRONG RAM - ZERO-COPY)
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let data = state.chapterData;
      if (!data) {
        data = await fetchComicoPages();
        state.chapterData = data;
      }

      const { pages } = data;
      const totalPages = pages.length;
      if (!totalPages) throw new Error("Không có trang hợp lệ để tải.");

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file định danh ID tập
      const epId = getEpisodeId();
      zip.addFile(`${epId}.txt`, new Uint8Array(0));

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map((pageObj) => async () => {
        let rawBuffer = null;
        try {
          // Tải trực tiếp trong tab (cực nhanh, không qua cầu nối trung gian)
          const res = await WIN.fetch(pageObj.url);
          if (res.ok) rawBuffer = await res.arrayBuffer();
        } catch (e) {}

        // Fallback sang GM_xhr nếu bị chặn CORS
        if (!rawBuffer) rawBuffer = await Utils.fetchBuffer(pageObj.url);
        const ext = Utils.detectExt(rawBuffer);

        return {
          fileName: `${pageObj.pageNo}.${ext}`,
          data: new Uint8Array(rawBuffer)
        };
      });

      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res?.data) zip.addFile(res.fileName, res.data);
      }

      const zipName = `${getCleanTitle(data)}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[comico-dl] Error:", err);
    } finally {
      state.running = false;
    }
  }

  /* =========================================================================
   * KHỞI CHẠY VÀ THEO DÕI ĐIỀU HƯỚNG SPA
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(20);
    const ui = getUI();

    if (!isEpisodeUrl()) {
      if (ui?.panel) ui.panel.style.display = "none";
      return;
    }

    if (ui?.panel) {
      ui.panel.style.display = "block";
      ui.setBusy(true);
      ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
    }

    try {
      let data = null;
      let retries = 0;

      while (retries < 25) {
        try {
          data = await fetchComicoPages();
          if (data && data.pages?.length > 0) break;
        } catch (e) {}
        await sleep(150);
        retries++;
      }

      if (!data || !data.pages || !data.pages.length) {
        throw new Error("Không lấy được danh sách trang.");
      }
      state.chapterData = data;

      // SOI MAGIC BYTES THỰC TẾ TRANG 1 (ZERO-TRUST):
      const testUrl = data.pages[0]?.url; // bên này dùng data.pages[0].url
      if (!testUrl) throw new Error("URL trang 1 không hợp lệ.");

      const Utils = window.MangaUtils || globalThis.MangaUtils;
      let testBuf = null;
      try {
        const res = await WIN.fetch(testUrl);
        if (res.ok) testBuf = await res.arrayBuffer();
      } catch (e) {}

      if (!testBuf) {
        testBuf = await Utils.fetchBuffer(testUrl);
      }

      const realExt = Utils.detectExt(testBuf);
      if (!realExt) throw new Error("Không thể nhận diện Magic Bytes ảnh.");

      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: data.pages.length,
          status: "Sẵn sàng.",
          format: realExt
        });
        ui.setBusy(false);
      }
    } catch (err) {
      console.error("[comico-dl] Boot error:", err);
      if (ui) {
        ui.updateProgress({ status: "Lỗi: " + (err?.message || "không thể tải trang.") });
        ui.setBusy(true);
      }
    }
  }

  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute((newUrl) => {

      if (!isEpisodeUrl()) {
        const ui = getUI();
        if (ui?.panel) ui.panel.style.display = "none";
        state.chapterData = null;
        state.lastChapterId = "";
        state.lastUrl = "";
        state.running = false;
        return;
      }

      const currentCid = getEpisodeId();
      if (state.lastChapterId && state.lastChapterId === currentCid) return;

      state.lastUrl = newUrl;
      state.lastChapterId = currentCid;
      state.chapterData = null;
      state.running = false;

      const ui = getUI();
      if (ui) {
        ui.setBusy(true);
        ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
      }
      boot();
    });
  }
  boot();
})();