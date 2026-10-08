// ==UserScript==
// @name         Comic Owl Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://owl-comic.jp/favicon.ico
// @description  Tải ảnh đọc thử manga trên Comic Owl.
// @author       anonymous & AI
// @match        https://owl-comic.jp/titles/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      owl-comic.jp
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/OwlComicDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/OwlComicDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function owlComicUniversalDownloader() {
  'use strict';

  const CONFIG = {
    MAX_CONCURRENT: 6
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    pages: [],
    ui: null
  };

  /* =========================================================================
   * 1. GIAO DIỆN UNIVERSAL UI (THEME COMIC OWL / FUNGUILD)
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "owl-dl",
        title: "Comic Owl",        
        engine: "FUNGUILD",
        themeColor: "#D22428",       
        themeBg: "#283769",          
        titleColor: "#ffffff",
        btnBg: "#D22428",           
        btnColor: "#ffffff",
        topOffset: "140px",
        defaultJpgText: "Xuất file JPG (ảnh gốc là JPG)",
        onDownload: startDownload
      };

      state.ui = createUI(uiConfig);

      // Khóa cứng nhãn ảnh gốc JPEG (Zero-Copy)
      if (typeof state.ui?.updateFormatUI === 'function') {
        state.ui.updateFormatUI('jpg');
      }

      // Header 2 tầng (Dòng 1: Comic Owl, Dòng 2: FUNGUILD)
      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:${uiConfig.titleColor};letter-spacing:0.2px;">${uiConfig.title}</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px;visibility:hidden;">${uiConfig.engine}</div>
          `;
        }
      }
    }
    return state.ui;
  }

  /* =========================================================================
   * 2. XỬ LÝ CHUỖI & TIÊU ĐỀ CHUẨN (GOLDEN RULES)
   * ========================================================================= */
  function isTargetUrl() {
    return /\/titles\/[^\/]+/.test(WIN.location.pathname);
  }

  function getSlugId() {
    const match = WIN.location.pathname.match(/\/titles\/([^\/]+)/);
    return match ? decodeURIComponent(match[1]) : "owl_preview";
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

  function getCleanTitle() {
    try {
      const titleEl = DOC.querySelector('.book_title, .title_txt_area h2, h2.book_title');
      let bookTitle = titleEl ? titleEl.textContent.trim() : "";
      if (!bookTitle) {
        bookTitle = (DOC.title || "").split(/[|｜]/)[0].replace(/^.*?:/g, '').trim();
      }
      return `${cleanString(bookTitle) || 'ComicOwl'} - 試し読み`;
    } catch (e) {
      return `${cleanString(getSlugId())} - 試し読み`;
    }
  }

  /* =========================================================================
   * 3. BÓC TÁCH LINK ẢNH TỪ SWIPER DOM (LỌC TRÙNG ZERO-DUPLICATE)
   * ========================================================================= */
  function extractPages() {
    const imgs = DOC.querySelectorAll('.trial_wrapper .swiper-child .swiper-slide img, .trial_wrapper img');
    const seen = new Set();
    const pages = [];

    for (const img of imgs) {
      let src = img.getAttribute('src') || img.src || '';
      if (!src || src.startsWith('data:') || !src.includes('/uploads/')) continue;
      if (src.startsWith('//')) src = 'https:' + src;

      // Lọc bỏ slide ảo nhân bản do Swiper loop tạo ra
      if (seen.has(src)) continue;
      seen.add(src);
      pages.push(src);
    }
    return pages;
  }

  /* =========================================================================
   * 4. TIẾN TRÌNH TẢI CHÍNH (ZERO-COPY 0MS VÀO ZIP)
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      if (!state.pages || !state.pages.length) {
        state.pages = extractPages();
      }
      const totalPages = state.pages.length;
      if (!totalPages) throw new Error("Không tìm thấy trang đọc thử.");

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file định danh ID gốc ZIP
      const slugId = cleanString(getSlugId());
      zip.addFile(`${slugId}.txt`, new Uint8Array(0));

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = state.pages.map((url, idx) => async () => {
        const rawBuffer = await Utils.fetchBuffer(url);
        const ext = Utils.detectExt(rawBuffer) || 'jpg';
        return {
          fileName: `${idx + 1}.${ext}`,
          data: new Uint8Array(rawBuffer) // Zero-Copy: ghi thẳng mảng byte
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

      const zipName = `${getCleanTitle()}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[owl-dl] Error:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * 5. KHỞI CHẠY (BOOT) & ĐỒNG BỘ TRẠNG THÁI
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(30);
    const ui = getUI();

    if (!isTargetUrl()) {
      if (ui?.panel) ui.panel.style.display = "none";
      return;
    }

    if (ui?.panel) ui.panel.style.display = "block";
    if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });

    let pages = [];
    for (let i = 0; i < 20; i++) {
      pages = extractPages();
      if (pages.length > 0) break;
      await sleep(150);
    }

    state.pages = pages;
    await sleep(80); // Micro-delay chuẩn Golden Rule 3

    if (ui) {
      ui.updateProgress({
        completed: 0,
        total: pages.length,
        status: "Sẵn sàng."
      });
    }
  }

  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute(() => {
      state.pages = [];
      state.running = false;
      const ui = getUI();
      if (ui) {
        ui.setBusy(false);
        ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
      }
      boot();
    });
  }

  if (DOC.readyState === "loading") {
    DOC.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();