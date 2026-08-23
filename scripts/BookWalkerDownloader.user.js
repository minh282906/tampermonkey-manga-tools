// ==UserScript==
// @name         BookWalker Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      2.0.0
// @icon         https://bookwalker.jp/favicon.ico
// @description  Tải manga chất lượng gốc trên BookWalker.
// @author       anonymous & AI
// @match        https://viewer.bookwalker.jp/*/viewer.html*
// @match        https://viewer-trial.bookwalker.jp/*/viewer.html*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      bookwalker.jp
// @connect      *.bookwalker.jp
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function bookWalkerUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 4,
    JPEG_QUALITY: 0.95
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("bw-dl:convert-jpeg") === '1',
    episodeData: null,
    ui: null
  };

  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "bw-dl",
        title: "BookWalker",
        engine: "PUBLUS",
        themeColor: "#0284c7",
        themeBg: "#ffffff",
        titleColor: "#0284c7",
        topOffset: "44px",
        defaultJpgText: "Xuất file JPG (mặc định PNG)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("bw-dl:convert-jpeg", checked ? '1' : '0');
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
   * HẰNG SỐ NỘI BỘ VÀ BỘ HỖ TRỢ NFBR (PUBLUS)
   * ========================================================================= */
  const FALLBACK_WIDTH  = 1440;
  const FALLBACK_HEIGHT = 2048;
  const FRAME_TIMEOUT   = 45000;

  function isEpisodeUrl() {
    return /\/viewer\.html/.test(WIN.location.pathname) || WIN.location.search.includes('cid=');
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
      const match = WIN.location.search.match(/[?&]cid=([^&#]+)/);
      if (match && match[1]) return decodeURIComponent(match[1]);
    } catch (e) {}
    const rt = getNFBRRuntime(WIN);
    return getModelProperty(rt?.model, "contentId") || "BookWalker_Manga";
  }

  function getCleanTitle() {
    try {
      const rt = getNFBRRuntime(WIN);
      let title = rt?.menu?.getContentTitle?.() || "";
      if (!title) {
        const headerEl = DOC.querySelector('.p-viewer__title, .title, header h1, [class*="title"]');
        if (headerEl) title = headerEl.textContent.trim();
      }
      if (!title) title = DOC.title || "";

      let raw = title.replace(/[\/|]\s*BOOK\*WALKER.*/i, '').trim();
      raw = raw.replace(/【[^】]*(?:期間限定|無料|お試し|デジタル版限定特典)[^】]*】/g, '').trim();
      raw = raw.replace(/^公式\s*[-－_]?\s*/i, '').trim();

      const match = raw.match(/^(.*?)(?:\s+[-－–—/]\s+|\s+)((?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\s\-\–\—\ー\~〜\.]+(?:話|巻|章|節|部|エピソード|分冊版|単話|前編|中編|後編)?.*)$/i);
      if (match) {
        return `${cleanString(match[1])} - ${cleanString(match[2])}`;
      }

      return cleanString(raw) || `BookWalker_${getEpisodeId()}`;
    } catch (e) {}

    return `BookWalker_${getEpisodeId()}`;
  }

  function getNFBRRuntime(targetWin = WIN) {
    try {
      const init = targetWin.NFBR?.a6G?.Initializer?.T1V || targetWin.NFBR?.a6G?.Initial?.T1V;
      if (!init) return null;
      const menu = init.menu?.a6l || init.a6l;
      const renderer = init.renderer;
      const model = menu?.model || renderer?.model;
      if (!menu || !renderer || !model) return null;
      return { win: targetWin, init, menu, renderer, model };
    } catch (e) {
      return null;
    }
  }

  function getModelProperty(obj, key) {
    try {
      if (typeof obj?.get === "function") return obj.get(key);
    } catch (e) {}
    return obj?.attributes?.[key];
  }

  function parsePositiveInt(val, fallback = 0) {
    const n = Number(val);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  }

  function getTotalPages(rt) {
    const model = rt?.model;
    const total = Number(getModelProperty(model, "total")) || 0;
    return Math.max(0, Math.floor(total));
  }

  function getPageDimensionFromLinkInfo(fileData) {
    const page = fileData?.PageLinkInfo?.[0]?.Page;
    const sizeObj = page?.Size || page?.size || page?.PageSize;
    return {
      width: parsePositiveInt(sizeObj?.width, 0),
      height: parsePositiveInt(sizeObj?.height, 0)
    };
  }

  function getTargetPageDimensions(pageObj, defaultDim = { width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT }) {
    return {
      width: parsePositiveInt(pageObj?.width, defaultDim.width),
      height: parsePositiveInt(pageObj?.height, defaultDim.height)
    };
  }

  function addPageToMap(pageMap, pageData, index, fileData) {
    if (!pageData && !Number.isFinite(index)) return;
    const pageIdx = Number.isFinite(Number(pageData?.index)) ? Number(pageData.index) : Number(index);
    if (!Number.isFinite(pageIdx) || pageIdx < 0) return;

    const linkDim = getPageDimensionFromLinkInfo(fileData);
    const w = parsePositiveInt(pageData?.width, linkDim.width || FALLBACK_WIDTH);
    const h = parsePositiveInt(pageData?.height, linkDim.height || FALLBACK_HEIGHT);

    const existing = pageMap.get(pageIdx) || {};
    pageMap.set(pageIdx, {
      ...existing,
      index: pageIdx,
      width: parsePositiveInt(existing.width, w),
      height: parsePositiveInt(existing.height, h),
      file: pageData?.file || existing.file || ""
    });
  }

  function getPageListFromNFBR(rt) {
    const model = rt.model;
    const a2u = getModelProperty(model, "a2u") || {};
    const content = getModelProperty(model, "content") || {};
    const configContents = content.configuration?.contents || [];
    const files = content.files || [];

    const pageMap = new Map();

    if (Array.isArray(a2u.r8q)) {
      for (const spread of a2u.r8q) {
        addPageToMap(pageMap, spread.left, spread.left?.index, files[spread.left?.index]);
        addPageToMap(pageMap, spread.right, spread.right?.index, files[spread.right?.index]);
      }
    }

    configContents.forEach((cItem, idx) => {
      addPageToMap(pageMap, { index: idx, file: cItem.file }, idx, files[idx]);
    });

    const totalPages = getTotalPages(rt) || configContents.length || pageMap.size;
    for (let i = 0; i < totalPages; i++) {
      if (!pageMap.has(i)) {
        addPageToMap(pageMap, { index: i }, i, files[i]);
      }
    }

    const list = Array.from(pageMap.values())
      .filter(p => Number.isFinite(p.index) && p.index >= 0)
      .sort((a, b) => a.index - b.index)
      .map(p => ({
        ...p,
        width: parsePositiveInt(p.width, FALLBACK_WIDTH),
        height: parsePositiveInt(p.height, FALLBACK_HEIGHT)
      }));

    if (!list.length) throw new Error("Không tìm thấy danh mục trang BookWalker.");
    return list;
  }

  function getCurrentPageIndex(rt) {
    const p = Number(getModelProperty(rt?.model, "viewerPage"));
    if (Number.isFinite(p) && p >= 0) return Math.floor(p);

    const spread = getModelProperty(rt?.model, "viewerSpread");
    const idx = Number(spread?.pageIndex ?? spread?.left?.index ?? spread?.right?.index);
    return Number.isFinite(idx) && idx >= 0 ? Math.floor(idx) : 0;
  }

  function getPageSide(spread, pageIndex) {
    if (!spread) return null;
    if (Number(spread.left?.index) === Number(pageIndex)) return "left";
    if (Number(spread.right?.index) === Number(pageIndex)) return "right";
    if (Number(spread.pageIndex) === Number(pageIndex) && spread.left) return "left";
    return null;
  }

  /* =========================================================================
   * SILENT IFRAME WORKER VÀ QUY TRÌNH CHỤP ẢNH CANVAS
   * ========================================================================= */
  function updateIframeSize(iframeEl, pageDim) {
    const targetW = parsePositiveInt(pageDim?.width, FALLBACK_WIDTH);
    const targetH = parsePositiveInt(pageDim?.height, FALLBACK_HEIGHT);
    iframeEl.width = String(targetW);
    iframeEl.height = String(targetH);
    iframeEl.style.width = targetW + "px";
    iframeEl.style.height = targetH + "px";
  }

  async function resizeIframeAndTrigger(iframeEl, pageObj) {
    updateIframeSize(iframeEl, getTargetPageDimensions(pageObj));
    try {
      const win = iframeEl.contentWindow;
      win.dispatchEvent(new win.CustomEvent("resize"));
    } catch (e) {}
    await sleep(60);
  }

  function createWorkerIframe(initialPage) {
    DOC.getElementById("bw-worker-iframe")?.remove();

    const url = new URL(WIN.location.href);
    url.hash = "tm-bookwalker-downloader-silent";

    const iframe = DOC.createElement("iframe");
    iframe.id = "bw-worker-iframe";
    iframe.src = url.href;
    iframe.setAttribute("aria-hidden", "true");
    iframe.tabIndex = -1;
    iframe.style.position = "fixed";
    iframe.style.left = "0px";
    iframe.style.top = "0px";
    iframe.style.opacity = "0.01";
    iframe.style.pointerEvents = "none";
    iframe.style.zIndex = "2147483646";

    updateIframeSize(iframe, getTargetPageDimensions(initialPage));

    (DOC.body || DOC.documentElement).appendChild(iframe);
    return iframe;
  }

  async function waitForRender(iframeEl, pageIndex, timeoutMs = FRAME_TIMEOUT) {
    const startTime = Date.now();
    let retryCount = 0;

    while (Date.now() - startTime < timeoutMs) {
      const win = iframeEl.contentWindow;
      const rt = getNFBRRuntime(win);
      if (!rt) {
        await sleep(100);
        continue;
      }

      const screen = rt.renderer?.currentScreen;
      const spread = getModelProperty(rt.model, "viewerSpread");
      const side = getPageSide(spread, pageIndex);
      const drawn = side === "right" ? screen?.rightIsDrawn : screen?.leftIsDrawn;
      const canvas = screen?.canvas;

      if (side && drawn === true && canvas && canvas.width > 0 && canvas.height > 0) {
        await new Promise(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));
        await sleep(90);
        return { runtime: rt, screen, side };
      }

      if (Date.now() - startTime > 1500 * (retryCount + 1)) {
        retryCount++;
        try {
          const menu = rt.menu;
          if (typeof menu?.moveToPage === "function") {
            menu.moveToPage(Number(pageIndex));
          } else if (typeof menu?.a6l?.moveToPage === "function") {
            menu.a6l.moveToPage(Number(pageIndex));
          }
        } catch (e) {}
      }

      await sleep(90);
    }

    throw new Error(`Render trang ${pageIndex + 1} timeout.`);
  }

  async function navigateToPage(iframeEl, pageIndex) {
    const startTime = Date.now();
    let rt = null;

    while (Date.now() - startTime < FRAME_TIMEOUT) {
      const win = iframeEl.contentWindow;
      rt = getNFBRRuntime(win);
      if (rt && (typeof rt.menu?.moveToPage === "function" || typeof rt.menu?.a6l?.moveToPage === "function")) {
        break;
      }
      await sleep(100);
    }

    if (!rt) throw new Error("Không tìm thấy hàm điều khiển trang BookWalker.");

    const menu = rt.menu;
    if (typeof menu.moveToPage === "function") {
      menu.moveToPage(Number(pageIndex));
    } else if (typeof menu.a6l?.moveToPage === "function") {
      menu.a6l.moveToPage(Number(pageIndex));
    }

    return await waitForRender(iframeEl, Number(pageIndex));
  }

  async function renderCanvasToBlob(iframeEl, pageObj, renderResult, isJpg) {
    const screen = renderResult.screen || renderResult.runtime?.renderer?.currentScreen;
    const srcCanvas = screen?.canvas;

    if (!srcCanvas || srcCanvas.width === 0 || srcCanvas.height === 0) {
      throw new Error("Canvas nguồn chưa sẵn sàng.");
    }

    const canvasDim = { width: srcCanvas.width, height: srcCanvas.height };
    const targetDim = getTargetPageDimensions(pageObj, canvasDim);

    const outCanvas = DOC.createElement("canvas");
    outCanvas.width = targetDim.width;
    outCanvas.height = targetDim.height;

    const ctx = outCanvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Không thể tạo Context 2D.");

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, outCanvas.width, outCanvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    ctx.drawImage(
      srcCanvas,
      0, 0, srcCanvas.width, srcCanvas.height,
      0, 0, targetDim.width, targetDim.height
    );

    const mimeType = isJpg ? 'image/jpeg' : 'image/png';
    const quality = isJpg ? CONFIG.JPEG_QUALITY : undefined;

    const blob = await new Promise((resolve, reject) => {
      outCanvas.toBlob(b => b ? resolve(b) : reject(new Error("Lỗi toBlob")), mimeType, quality);
    });

    outCanvas.width = 0;
    outCanvas.height = 0;

    const arrayBuffer = await blob.arrayBuffer();
    return {
      data: new Uint8Array(arrayBuffer),
      ext: isJpg ? 'jpg' : 'png'
    };
  }

  /* =========================================================================
   * TIẾN TRÌNH TẢI CHÍNH
   * ========================================================================= */
  async function startDownload() {
    if (state.running || !state.episodeData) return;
    const ui = getUI();

    state.running = true;
    if (ui) ui.setBusy(true);

    let workerIframe = null;
    let initialPageIndex = 0;

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });

      const { rt: mainRt, pagesList } = state.episodeData;
      const totalPages = pagesList.length;

      if (!totalPages) throw new Error("Không tìm thấy trang truyện.");

      initialPageIndex = getCurrentPageIndex(mainRt);
      const useJpeg = Boolean(state.convertJpeg);
      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const zip = new ZipClass();

      // Đính kèm file txt định danh ID tập
      const episodeId = getEpisodeId();
      zip.addFile(`${episodeId}.txt`, new Uint8Array(0));

      workerIframe = createWorkerIframe(pagesList[0]);
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      for (let i = 0; i < totalPages; i++) {
        const pageObj = pagesList[i];
        await resizeIframeAndTrigger(workerIframe, pageObj);
        const renderResult = await navigateToPage(workerIframe, pageObj.index);
        const capture = await renderCanvasToBlob(workerIframe, pageObj, renderResult, useJpeg);

        zip.addFile(`${i + 1}.${capture.ext}`, capture.data);

        if (ui) {
          ui.updateProgress({
            completed: i + 1,
            total: totalPages,
            status: "Đang tải..."
          });
        }

        await sleep(60);
      }

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      const zipName = `${getCleanTitle()}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[bw-dl] Download failed", err);
    } finally {
      if (workerIframe) {
        try {
          const win = workerIframe.contentWindow;
          const rt = getNFBRRuntime(win);
          if (rt && typeof rt.menu?.moveToPage === "function") {
            rt.menu.moveToPage(initialPageIndex);
          }
        } catch (e) {}
        try { workerIframe.remove(); } catch (e) {}
      }
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

    let rt = null;
    let pagesList = [];
    let attempts = 0;

    while (attempts < 100) {
      rt = getNFBRRuntime(WIN);
      if (rt) {
        try {
          pagesList = getPageListFromNFBR(rt);
          if (pagesList.length > 0) break;
        } catch (e) {}
      }
      await sleep(200);
      attempts++;
    }

    if (pagesList.length > 0) {
      state.episodeData = { rt, pagesList };
      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: pagesList.length,
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
      state.episodeData = null;
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