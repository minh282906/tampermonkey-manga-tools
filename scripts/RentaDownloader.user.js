// ==UserScript==
// @name         Renta! Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://renta.papy.co.jp/favicon.ico
// @description  Tải manga trên Renta! DRE Viewer (dre-viewer.papy.co.jp).
// @author       Afang & anonymous & AI
// @match        https://dre-viewer.papy.co.jp/sc/view_jsimg5/*
// @match        https://*.papy.co.jp/*
// @match        https://renta.papy.co.jp/*
// @match        https://*.ebookrenta.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      papy.co.jp
// @connect      *.papy.co.jp
// @connect      ebookrenta.com
// @connect      *.ebookrenta.com
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/RentaDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/RentaDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function rentaUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    PAGE_WAIT_TIMEOUT_MS: 45000,
    POLL_INTERVAL_MS: 100,
    JPEG_QUALITY: 0.95 // Chất lượng nếu xuất ảnh JPG
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("renta-dl:convert-jpeg") === '1',
    chapterData: null,
    ui: null
  };

  /* =========================================================================
   * 1. GIAO DIỆN UNIVERSAL UI CHUẨN 2 TẦNG
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const isEnglish = WIN.location.hostname.includes("ebookrenta.com");
      const brandName = isEnglish ? "Renta! Global" : "Renta!";

      const uiConfig = {
        storagePrefix: "renta-dl",
        title: brandName,
        engine: "PAPYS DRE",
        themeColor: "#72b024",
        themeBg: "#0f172a",
        titleColor: "#a3e635",
        btnBg: "#72b024",
        btnColor: "#ffffff",
        topOffset: "88px",
        defaultJpgText: "Xuất file JPG (mặc định PNG)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("renta-dl:convert-jpeg", checked ? '1' : '0');
        }
      };

      state.ui = createUI(uiConfig);

      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:${uiConfig.titleColor};letter-spacing:0.2px;">${uiConfig.title}</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px;">${uiConfig.engine}</div>
          `;
        }
      }
    }
    return state.ui;
  }

  /* =========================================================================
   * 2. BỘ HỖ TRỢ XỬ LÝ URL & TIÊU ĐỀ
   * ========================================================================= */
  function isViewerUrl() {
    return /\/sc\/view_jsimg5\//.test(WIN.location.pathname) || WIN.location.href.includes("view_jsimg5");
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

  function getWorkId() {
    try {
      if (WIN.prd_ser) return String(WIN.prd_ser).trim();
      const match = WIN.location.href.match(/[\/=]([A-Za-z0-9_-]{6,16})(?:[&#?]|$)/);
      if (match) return match[1];
    } catch (e) {}
    return "renta_work";
  }

  function getCleanTitle() {
    try {
      let raw = "";
      if (WIN.prdName) raw = String(WIN.prdName);
      if (!raw) {
        const titleEl = DOC.querySelector('h1, .title, [class*="titleText"], .p-header__title');
        if (titleEl) raw = titleEl.textContent.trim();
      }
      if (!raw) raw = DOC.title || "";

      raw = raw.replace(/\s*[-|｜]\s*(?:Renta!|コミック|電子書籍|レンタル).*/i, '').trim();
      raw = raw.replace(/【[^】]*】/g, '').trim();
      raw = raw.replace(/^公式\s*[-－_]?\s*/i, '').trim();

      return cleanString(raw) || `Renta_${getWorkId()}`;
    } catch (e) {}

    return `Renta_${getWorkId()}`;
  }

  /* =========================================================================
   * 3. BẮT TAY RUNTIME DRE VIEWER TRONG RAM & PRELOAD TĂNG TỐC
   * ========================================================================= */
  function isRuntimeReady() {
    return Boolean(
      typeof WIN.getImageData === 'function' &&
      WIN.arChara &&
      typeof WIN.arChara === 'object' &&
      Number.isInteger(Number(WIN.max_page)) &&
      Number(WIN.max_page) > 0
    );
  }

  async function waitForViewerRuntime(timeoutMs = 40000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (isRuntimeReady()) {
        return {
          maxPage: Number(WIN.max_page),
          split: Number(WIN.imageSplit) || 7
        };
      }
      await sleep(CONFIG.POLL_INTERVAL_MS);
    }
    throw new Error("Không tìm thấy Runtime của Papy DRE Viewer.");
  }

  function isImageElementLoaded(img) {
    if (!img || typeof img !== 'object') return false;
    const w = Number(img.naturalWidth || img.width || 0);
    const h = Number(img.naturalHeight || img.height || 0);
    return Boolean(img.complete && w > 0 && h > 0);
  }

  function isPageImagesReady(pageNo) {
    const chara = WIN.arChara?.[pageNo];
    const split = Number(WIN.imageSplit) || 7;
    const totalTiles = split * split; // 49 mảnh

    if (!chara?.comp || !Array.isArray(chara.img) || !Array.isArray(chara.didx)) return false;
    if (chara.img.length < totalTiles || chara.didx.length < totalTiles) return false;

    for (let i = 0; i < totalTiles; i++) {
      if (!isImageElementLoaded(chara.img[i])) return false;
      if (!Array.isArray(chara.didx[i]) || chara.didx[i].length < 2) return false;
    }

    return true;
  }

  function preloadUpcomingPages(currentPage, maxPage) {
    const limit = Math.min(maxPage, currentPage + 3);
    for (let p = currentPage + 1; p <= limit; p++) {
      if (!WIN.arChara?.[p] && typeof WIN.getImageData === 'function') {
        try { WIN.getImageData(p); } catch(e) {}
      }
    }
  }

  async function ensurePageData(pageNo, timeoutMs = CONFIG.PAGE_WAIT_TIMEOUT_MS) {
    const total = Number(WIN.max_page) || 1;
    if (pageNo < 1 || pageNo > total) throw new Error(`Số trang không hợp lệ: ${pageNo}`);

    for (let attempt = 0; attempt < 2; attempt++) {
      if (!isPageImagesReady(pageNo)) {
        try {
          WIN.getImageData(pageNo);
        } catch (err) {
          throw new Error(`Lỗi gọi nạp trang ${pageNo}: ${err?.message || err}`);
        }
      }

      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (isPageImagesReady(pageNo)) {
          return WIN.arChara[pageNo];
        }
        await sleep(CONFIG.POLL_INTERVAL_MS);
      }

      if (attempt === 0) {
        try {
          delete WIN.arChara?.[pageNo];
          delete WIN.arWait?.[pageNo];
        } catch (e) {}
      }
    }

    throw new Error(`Timeout khi chờ viewer giải mã trang ${pageNo}.`);
  }

  /* =========================================================================
   * 4. TÁI TẠO MA TRẬN 49 MẢNH (7x7) TRÊN CANVAS (PIXEL-PERFECT POINT SAMPLING)
   * ========================================================================= */
  function renderRentaCanvas(pageNo) {
    const chara = WIN.arChara?.[pageNo];
    if (!chara?.comp) throw new Error(`Dữ liệu trang ${pageNo} chưa hoàn tất.`);

    const split = Number(WIN.imageSplit) || 7;
    const totalTiles = split * split; // 49 mảnh
    const tileSample = chara.img[0];

    const tileW = Number(tileSample.naturalWidth || tileSample.width || 0);
    const tileH = Number(tileSample.naturalHeight || tileSample.height || 0);

    const diffW = chara.diff?.wImg || null;
    const diffH = chara.diff?.hImg || null;

    const diffWVal = Number(diffW?.naturalWidth || diffW?.width || 0);
    const diffHVal = Number(diffH?.naturalHeight || diffH?.height || 0);

    const canvasW = Number(chara.mWidth) || (diffWVal + tileW * split);
    const canvasH = Number(chara.mHeight) || (diffHVal + tileH * split);

    const canvas = DOC.createElement('canvas');
    canvas.width = canvasW;
    canvas.height = canvasH;

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = false;
    ctx.mozImageSmoothingEnabled = false;
    ctx.webkitImageSmoothingEnabled = false;
    ctx.msImageSmoothingEnabled = false;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvasW, canvasH);

    // 1. Vẽ 2 dải đệm biên (nếu có)
    if (diffWVal > 0 || diffHVal > 0) {
      if (diffWVal > 0 && diffHVal === 0) {
        ctx.drawImage(diffW, 0, 0, diffWVal, canvasH, 0, 0, diffWVal, canvasH);
      } else if (diffWVal === 0 && diffHVal > 0) {
        ctx.drawImage(diffH, 0, 0, canvasW, diffHVal, 0, 0, canvasW, diffHVal);
      } else {
        let diffWOffset = diffWVal;
        if (diffWVal + tileW * split === diffHVal) diffWOffset = 0;
        ctx.drawImage(diffW, 0, 0, diffWVal, canvasH, 0, 0, diffWVal, canvasH);
        ctx.drawImage(diffH, 0, 0, canvasW, diffHVal, diffWOffset, 0, canvasW, diffHVal);
      }
    }

    // 2. Ráp 49 mảnh ô vuông theo mảng tọa độ didx trong RAM
    for (let i = 0; i < totalTiles; i++) {
      const tileImg = chara.img[i];
      const pos = chara.didx[i]; // [cột, dòng]
      const dx = Number(pos[0]) * tileW + diffWVal;
      const dy = Number(pos[1]) * tileH + diffHVal;

      ctx.drawImage(
        tileImg,
        0, 0, tileW, tileH,
        dx, dy, tileW, tileH
      );
    }

    return canvas;
  }

  async function processPageBlob(canvas, forceJpg) {
    const mimeType = forceJpg ? 'image/jpeg' : 'image/png';
    const ext = forceJpg ? 'jpg' : 'png';
    const quality = forceJpg ? CONFIG.JPEG_QUALITY : undefined;

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(b => {
        if (b && b.size > 0) resolve(b);
        else reject(new Error("Lỗi xuất Blob từ Canvas."));
      }, mimeType, quality);
    });

    canvas.width = 0;
    canvas.height = 0;

    return {
      ext,
      data: new Uint8Array(await blob.arrayBuffer())
    };
  }

  /* =========================================================================
   * 5. TIẾN TRÌNH TẢI CHÍNH (3 luồng trong RAM)
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      const runtime = await waitForViewerRuntime();
      const totalPages = runtime.maxPage;
      if (!totalPages || totalPages <= 0) throw new Error("Viewer chưa sẵn sàng hoặc không có trang.");

      const forceJpg = Boolean(state.convertJpeg);
      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const zip = new ZipClass();

      // Đính kèm file txt định danh tác phẩm vào thư mục gốc ZIP
      const workId = getWorkId();
      zip.addFile(`${workId}.txt`, new Uint8Array(0));

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      for (let pageNo = 1; pageNo <= totalPages; pageNo++) {
        preloadUpcomingPages(pageNo, totalPages);

        await ensurePageData(pageNo);
        const canvas = renderRentaCanvas(pageNo);
        const output = await processPageBlob(canvas, forceJpg);

        zip.addFile(`${pageNo}.${output.ext}`, output.data);

        if (ui) {
          ui.updateProgress({
            completed: pageNo,
            total: totalPages,
            status: "Đang tải..."
          });
        }

        await sleep(20);
      }

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      const zipName = `${getCleanTitle()}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[renta-dl] Error:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * 6. KHỞI CHẠY VÀ THEO DÕI SPA ROUTE
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(30);
    const ui = getUI();

    if (!isViewerUrl()) {
      if (ui?.panel) ui.panel.style.display = "none";
      return;
    }

    if (ui?.panel) {
      ui.panel.style.display = "block";
      ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
    }

    let runtime = null;
    let retries = 0;

    while (retries < 30) {
      if (isRuntimeReady()) {
        runtime = {
          maxPage: Number(WIN.max_page),
          split: Number(WIN.imageSplit) || 7
        };
        break;
      }
      await sleep(150);
      retries++;
    }

    if (runtime && runtime.maxPage > 0) {
      state.chapterData = runtime;
      await sleep(80);

      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: runtime.maxPage,
          status: "Sẵn sàng."
        });
      }
    } else {
      if (ui) ui.updateProgress({ status: "Sẵn sàng." });
    }
  }

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