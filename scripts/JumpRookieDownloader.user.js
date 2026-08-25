// ==UserScript==
// @name         Jump Rookie Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://rookie.shonenjump.com/resources/images/common/favicon.ico
// @description  Tải manga chất lượng gốc trên Shonen Jump Rookie (rookie.shonenjump.com).
// @author       anonymous & AI
// @match        https://rookie.shonenjump.com/series/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      rookie.shonenjump.com
// @connect      cdn-img.rookie.shonenjump.com
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
    MAX_CONCURRENT: 6,   // 6 luồng tải song song
    JPEG_QUALITY: 0.95   // Chất lượng xuất JPG nếu chuyển đổi
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("jumprookie-dl:convert-jpeg") === '1',
    detectedSourceFormat: 'webp',
    chapterData: null,
    ui: null
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
        defaultJpgText: "Xuất file JPG (ảnh gốc là WebP)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("jumprookie-dl:convert-jpeg", checked ? '1' : '0');
        }
      };

      state.ui = createUI(uiConfig);

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

    // Nhận diện định dạng ảnh gốc từ URL
    if (resultPages.length > 0) {
      const firstExt = getExtensionFromUrl(resultPages[0].src, 'webp');
      state.detectedSourceFormat = firstExt;
      const ui = getUI();
      if (ui) ui.updateFormatUI(state.detectedSourceFormat);
    }

    return resultPages;
  }

  /* =========================================================================
   * XỬ LÝ ẢNH ZERO-COPY (GIỮ NGUYÊN BYTES GỐC HOẶC CHUYỂN JPG NẾU CHỌN)
   * ========================================================================= */
  async function processRookieImage(pageObj, forceJpg) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    let buffer = await Utils.fetchBuffer(pageObj.src);
    const uint8 = new Uint8Array(buffer);

    // 1. Nhận diện định dạng qua Magic Bytes thực tế
    let ext = 'jpg';
    if (uint8[0] === 0x52 && uint8[1] === 0x49 && uint8[2] === 0x46 && uint8[3] === 0x46) ext = 'webp';
    else if (uint8[0] === 0x89 && uint8[1] === 0x50 && uint8[2] === 0x4E && uint8[3] === 0x47) ext = 'png';
    else if (uint8[0] === 0xFF && uint8[1] === 0xD8 && uint8[2] === 0xFF) ext = 'jpg';
    else ext = getExtensionFromUrl(pageObj.src, 'jpg');

    // 2. Nếu không yêu cầu đổi sang JPG -> Xuất trực tiếp byte gốc (Zero-Copy)
    if (!forceJpg || ext === 'jpg') {
      return {
        fileName: `${pageObj.pageNo}.${ext}`,
        data: uint8
      };
    }

    // 3. Nếu người dùng chọn chuyển đổi JPG -> Vẽ qua Canvas
    const img = await Utils.loadImage(uint8, `image/${ext}`);
    const canvas = DOC.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);

    const jpgBlob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', CONFIG.JPEG_QUALITY));
    canvas.width = 0;
    canvas.height = 0;

    return {
      fileName: `${pageObj.pageNo}.jpg`,
      data: new Uint8Array(await jpgBlob.arrayBuffer())
    };
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

      const forceJpg = Boolean(state.convertJpeg);
      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file txt định danh ID tập vào thư mục gốc ZIP
      const episodeId = getEpisodeId();
      zip.addFile(`${episodeId}.txt`, new Uint8Array(0));

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map(pageObj => () => processRookieImage(pageObj, forceJpg));
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
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * KHỞI CHẠY VÀ THEO DÕI SPA
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(30);
    const ui = getUI();

    if (!isEpisodeUrl()) {
      if (ui?.panel) ui.panel.style.display = "none";
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
      return;
    }

    if (ui?.panel) ui.panel.style.display = "block";
    if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });

    let pages = [];
    let retries = 0;

    while (retries < 25) {
      pages = fetchRookiePages();
      if (pages.length > 0) break;
      await sleep(150);
      retries++;
    }

    if (pages.length > 0) {
      await sleep(100);
      state.chapterData = pages;
      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: pages.length,
          status: "Sẵn sàng."
        });
      }
    } else {
      if (ui) ui.updateProgress({ status: "Sẵn sàng." });
    }
  }

  // Khởi động SPA Route Watcher
  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute(() => {
      state.chapterData = null;
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