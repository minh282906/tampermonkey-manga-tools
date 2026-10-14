// ==UserScript==
// @name         ComiciJP Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      2.0.0
// @icon         https://www.google.com/s2/favicons?domain=comici.jp&sz=128
// @description  Tải manga trên comici.jp
// @author       anonymous & AI
// @match        https://comici.jp/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      comici.jp
// @connect      *.comici.jp
// @connect      cdn.comici.jp
// @connect      cdn-public.comici.jp
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/ComiciJPDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/ComiciJPDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function comiciJPDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(r => WIN.setTimeout(r, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    chapterData: null,
    ui: null,
    lastUrl: "",
    lastArticleId: ""
  };

  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "comicijp-dl",
        title: "ComiciJP",
        engine: "COMICI.JP",
        themeColor: "#FA6C7A",
        themeBg: "#ffffff",
        titleColor: "#000000",
        topOffset: "59px",
        onDownload: startDownload
      };

      state.ui = createUI(uiConfig);
      state.ui.setBusy(true);

      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:${uiConfig.titleColor};letter-spacing:0.2px;">${uiConfig.title}</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:1px;visibility:hidden;">${uiConfig.engine}</div>
          `;
        }
      }
    }
    return state.ui;
  }

  /* =========================================================================
   * BỘ HỖ TRỢ XỬ LÝ URL & TIÊU ĐỀ
   * ========================================================================= */
  function isEpisodeUrl() {
    return /\/(?:episodes?|articles?)\/[a-zA-Z0-9_-]+/.test(WIN.location.pathname);
  }

  function getArticleId() {
    return WIN.location.pathname.match(/\/(?:episodes?|articles?)\/([a-zA-Z0-9_-]+)/)?.[1] || "article";
  }

  function getCleanTitle() {
    const alt = DOC.querySelector('img.manga2-img, img[id^="manga-img-"]')?.getAttribute('alt') || "";
    const clean = str => str.replace(/【[^】]*】|\s*by\s+.*|\s*nc-\d+.*|[\\/*?:"<>|]/g, '').trim();

    if (alt.includes('・') || alt.includes('･')) {
      const [s, ...e] = alt.split(/[・･]/);
      return `${clean(s)} - ${clean(e.join(' '))}`;
    }

    let t = clean((DOC.title || "").split(/[|｜]/)[0].replace(/^公式\s*/i, ''));
    return t || `ComiciJP_${getArticleId()}`;
  }

  /* =========================================================================
   * BÓC TÁCH DANH SÁCH ẢNH RAW
   * ========================================================================= */
  function fetchPages() {
    const imgs = DOC.querySelectorAll('img.manga2-img, img.imgGuard, img[id^="manga-img-"], img[src*="/articles/"]');
    const urls = new Set();

    for (const img of imgs) {
      let src = img.getAttribute('data-src') || img.getAttribute('src') || '';
      if (src && !src.startsWith('data:') && !src.includes('/users/') && !src.includes('/avatars/') && !src.includes('/icons/')) {
        urls.add(src.startsWith('//') ? 'https:' + src : src);
      }
    }

    return Array.from(urls).map((u, i) => ({ pageNo: i + 1, url: u }));
  }

  /* =========================================================================
   * ZERO-COPY XỬ LÝ ẢNH
   * ========================================================================= */
  async function processImage(pageObj) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    const buffer = await Utils.fetchBuffer(pageObj.url);
    const uint8 = new Uint8Array(buffer);
    const ext = Utils.detectExt(buffer);

    return { fileName: `${pageObj.pageNo}.${ext}`, data: uint8 };
  }

  /* =========================================================================
   * TIẾN TRÌNH TẢI CHÍNH (6 LUỒNG TRONG RAM)
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let pages = state.chapterData || fetchPages();
      state.chapterData = pages;

      const total = pages.length;
      if (!total) throw new Error("Không tìm thấy ảnh truyện.");

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      zip.addFile(`${getArticleId()}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total, status: "Đang tải..." });

      const tasks = pages.map(pageObj => () => processImage(pageObj));
      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      if (ui) ui.updateProgress({ completed: total, total, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res?.data) zip.addFile(res.fileName, res.data);
      }

      zip.download(`${getCleanTitle()}.zip`);
      if (ui) {
        ui.updateProgress({ completed: totalPages, total, status: "Hoàn tất." });
        ui.setBusy(false);
      }
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
    } finally {
      state.running = false;
    }
  }

  /* =========================================================================
   * KHỞI CHẠY & SPA WATCHER
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
      let pages = [];
      let retries = 0;
      while (retries < 25) {
        pages = fetchPages();
        if (pages.length > 0) break;
        await sleep(150);
        retries++;
      }
      if (!pages || pages.length === 0) {
        throw new Error("Không tìm thấy ảnh truyện.");
      }
      state.chapterData = pages;

      const testUrl = pages[0]?.url; // bên này dùng pages[0].url
      if (!testUrl) throw new Error("URL trang 1 không hợp lệ.");

      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const testBuf = await Utils.fetchBuffer(testUrl);
      const realExt = Utils.detectExt(testBuf);

      if (!realExt) {
        throw new Error("Không thể nhận diện Magic Bytes ảnh.");
      }

      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: pages.length,
          status: "Sẵn sàng.",
          format: realExt
        });
        ui.setBusy(false);
      }
    } catch (e) {
      console.error("[comicijp-dl] Boot error:", e);
      if (ui) {
        ui.updateProgress({ status: "Lỗi: " + (e?.message || "không thể tải trang.") });
        ui.setBusy(true); // Khóa nút cứng khi gặp lỗi
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
        state.lastArticleId = "";
        state.lastUrl = "";
        state.running = false;
        return;
      }

      const currentId = getArticleId();
      if (state.lastArticleId && state.lastArticleId === currentId) return;

      state.lastUrl = newUrl;
      state.lastArticleId = currentId;
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

// Trang web comici.jp đã chính thức đóng cửa vào ngày 30/09/2026