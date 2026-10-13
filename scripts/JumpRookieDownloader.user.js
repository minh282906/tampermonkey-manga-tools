// ==UserScript==
// @name         Jump Rookie Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      2.0.0
// @icon         https://www.google.com/s2/favicons?domain=rookie.shonenjump.com&sz=128
// @description  Tải manga trên Shonen Jump Rookie (rookie.shonenjump.com).
// @author       anonymous & AI
// @match        https://rookie.shonenjump.com/series/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      rookie.shonenjump.com
// @connect      cdn-img.rookie.shonenjump.com
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/JumpRookieDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/JumpRookieDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function jumpRookieUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6   // 6 luồng tải song song
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    chapterData: null,
    ui: null,
    lastUrl: "",
    lastEpisodeId: ""
  };

  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "jumprookie-dl",
        title: "Jump Rookie",
        engine: "SHUEISHA",
        themeColor: "#1F8CDE",
        themeBg: "#ffffff",
        titleColor: "#1F8CDE",
        topOffset: "50px",
        onDownload: startDownload
      };

      state.ui = createUI(uiConfig);
      state.ui.setBusy(true);

      // Tiêu đề 2 tầng (ẩn tầng 2 bằng visibility: hidden để cố định khoảng trống)
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
   * BỘ HỖ TRỢ XỬ LÝ CHUỖI & TÊN FILE CHUẨN
   * ========================================================================= */
  function isEpisodeUrl() {
    return /\/series\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+/.test(WIN.location.pathname);
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

  function getEpisodeId() {
    try {
      const match = WIN.location.pathname.match(/\/series\/[a-zA-Z0-9_-]+\/([a-zA-Z0-9_-]+)/);
      if (match && match[1]) return match[1];

      const sec = DOC.querySelector('section[data-episode-id]');
      if (sec?.getAttribute('data-episode-id')) return sec.getAttribute('data-episode-id');
    } catch (e) {}
    return "Rookie_Episode";
  }

  // BẮT BUỘC CHUẨN: [Tên Truyện] - [Tên Tập/Chap].zip
  function getCleanTitle() {
    const s = DOC.querySelector('.series-title')?.textContent?.trim() || "";
    const e = DOC.querySelector('.episode-number')?.textContent?.trim() || "";
    const clean = str => str.replace(/[\\/*?:"<>|]/g, '').trim();

    if (s && e) return `${clean(s)} - ${clean(e)}`;
    return clean(s) || `Rookie_${getEpisodeId()}`;
  }

  /* =========================================================================
   * BÓC TÁCH DANH SÁCH TRANG TỪ DOM (SHONEN JUMP ROOKIE)
   * ========================================================================= */
  function fetchRookiePages() {
    const imgEls = Array.from(DOC.querySelectorAll('.js-page-image, .image-container img, .page-area img, .page-container img'));
    const resultPages = [];
    const seenUrls = new Set();
    let pageNo = 1;

    for (const img of imgEls) {
      let src = img.getAttribute('src') || img.getAttribute('data-src') || '';
      if (!src || src.startsWith('data:')) continue;
      if (src.startsWith('//')) src = 'https:' + src;

      // Lọc bỏ 100% vùng chứa banner quảng cáo rác
      if (img.closest('#page-favorite-ad-area, .js-ad-area, .js-back-matter-area, .ad-area')) continue;

      if (!seenUrls.has(src)) {
        seenUrls.add(src);
        resultPages.push({
          pageNo: pageNo++,
          src: src
        });
      }
    }

    return resultPages;
  }

  /* =========================================================================
   * XỬ LÝ ẢNH ZERO-COPY (GIỮ NGUYÊN BYTES GỐC)
   * ========================================================================= */
  async function processRookieImage(pageObj) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    const buffer = await Utils.fetchBuffer(pageObj.src);
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

      let pages = state.chapterData;
      if (!pages || pages.length === 0) {
        pages = fetchRookiePages();
        state.chapterData = pages;
      }

      const totalPages = pages.length;
      if (!totalPages) throw new Error("Không tìm thấy trang truyện.");

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file txt định danh ID tập vào thư mục gốc ZIP
      const episodeId = getEpisodeId();
      zip.addFile(`${episodeId}.txt`, new Uint8Array(0));

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map(pageObj => () => processRookieImage(pageObj));
      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res?.data) zip.addFile(res.fileName, res.data);
      }

      const zipName = `${getCleanTitle()}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[jumprookie-dl] Error:", err);
    } finally {
      state.running = false;
    }
  }

  /* =========================================================================
   * KHỞI CHẠY VÀ THEO DÕI SPA
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
        pages = fetchRookiePages();
        if (pages.length > 0) break;
        await sleep(150);
        retries++;
      }

      if (!pages || pages.length === 0) {
        throw new Error("Không tìm thấy trang truyện.");
      }
      state.chapterData = pages;

      const testUrl = pages[0]?.src; // bên này dùng pages[0].src
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
      console.error("[jumprookie-dl] Boot error:", e);
      if (ui) {
        ui.updateProgress({ status: "Lỗi: " + (e?.message || "không thể tải trang.") });
        ui.setBusy(true);
      }
    }
  }

  // Khởi động SPA Route Watcher
  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {

    watchRoute((newUrl) => {
      if (!isEpisodeUrl()) {
        const ui = getUI();
        if (ui?.panel) ui.panel.style.display = "none";
        state.chapterData = null;
        state.lastEpisodeId = "";
        state.lastUrl = "";
        state.running = false;
        return;
      }

      const currentEpId = getEpisodeId();
      if (state.lastEpisodeId && state.lastEpisodeId === currentEpId) return;

      state.lastUrl = newUrl;
      state.lastEpisodeId = currentEpId;
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