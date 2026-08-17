// ==UserScript==
// @name         BookWalker Manga Downloader
// @namespace    https://viewer.bookwalker.jp/
// @version      1.0
// @icon         https://bookwalker.jp//favicon.ico
// @description  Tải truyện Manga từ BookWalker
// @match        https://viewer.bookwalker.jp/*/viewer.html*
// @match        https://viewer-trial.bookwalker.jp/*/viewer.html*
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

(function bookWalkerUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    PAGE_LIMIT: null,
    FALLBACK_WIDTH: 1275,
    FALLBACK_HEIGHT: 1801,
    FRAME_TIMEOUT: 45000
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) {
    return;
  }

  /* =========================================================================
   * 1. BỘ ĐÓNG GÓI ZIP (PURE ZIP WRITER)
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
    convertJpeg: localStorage.getItem("bw-dl:convert-jpeg") === '1',
    ui: null,
    episodeData: null,
    lastProgress: { completed: 0, total: 0, percent: 0, status: "Đang kiểm tra..." }
  };

  function saveJpegPref(val) {
    try {
      WIN.localStorage.setItem("bw-dl:convert-jpeg", val ? '1' : '0');
    } catch {}
  }

  function getEpisodeId() {
    try {
      const match = WIN.location.search.match(/[?&]cid=([^&#]+)/);
      if (match && match[1]) return decodeURIComponent(match[1]);
    } catch (e) {}
    const rt = getNFBRRuntime(WIN);
    return getModelProperty(rt?.model, "contentId") || "BookWalker_Manga";
  }

  function getCleanMangaTitle() {
    try {
      const rt = getNFBRRuntime(WIN);
      let title = rt?.menu?.getContentTitle?.() || "";
      if (!title) {
        const headerEl = DOC.querySelector('.p-viewer__title, .title, header h1, [class*="title"]');
        if (headerEl) title = headerEl.textContent.trim();
      }
      if (!title) title = DOC.title || "";

      let clean = title.replace(/[\/|]\s*BOOK\*WALKER.*/i, '').trim();
      clean = clean.replace(/【[^】]*(?:期間限定|無料|お試し)[^】]*】/g, '').trim();
      clean = clean.replace(/[\\/*?:"<>|]/g, '').trim();

      if (clean) return clean;
    } catch (e) {}

    return `BookWalker_${getEpisodeId()}`;
  }

  /* =========================================================================
   * 3. BÓC TÁCH RUNTIME NFBR & METADATA
   * ========================================================================= */
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
      if (typeof obj?.get === "function") {
        return obj.get(key);
      }
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

  function getTargetPageDimensions(pageObj, defaultDim = { width: CONFIG.FALLBACK_WIDTH, height: CONFIG.FALLBACK_HEIGHT }) {
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
    const w = parsePositiveInt(pageData?.width, linkDim.width || CONFIG.FALLBACK_WIDTH);
    const h = parsePositiveInt(pageData?.height, linkDim.height || CONFIG.FALLBACK_HEIGHT);

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
        width: parsePositiveInt(p.width, CONFIG.FALLBACK_WIDTH),
        height: parsePositiveInt(p.height, CONFIG.FALLBACK_HEIGHT)
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
   * 4. WORKER IFRAME & QUY TRÌNH CHỤP ẢNH FULL CANVAS CHUẨN XÁC
   * ========================================================================= */
  function updateIframeSize(iframeEl, pageDim) {
    const targetW = parsePositiveInt(pageDim?.width, CONFIG.FALLBACK_WIDTH);
    const targetH = parsePositiveInt(pageDim?.height, CONFIG.FALLBACK_HEIGHT);
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

  async function waitForRender(iframeEl, pageIndex, timeoutMs = CONFIG.FRAME_TIMEOUT) {
    const startTime = Date.now();
    let lastState = null;
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

      lastState = { pageIndex, side, drawn, canvasW: canvas?.width, canvasH: canvas?.height };

      if (side && drawn === true && canvas && canvas.width > 0 && canvas.height > 0) {
        await new Promise(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));
        await sleep(90);
        return { runtime: rt, screen, side };
      }

      // Tự động phát lại lệnh chuyển trang nếu ban đầu Iframe khởi động vào trang khác
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

    console.error("[bw-dl] Render Timeout State:", lastState);
    throw new Error(`Thời gian chờ render trang ${pageIndex + 1} quá lâu.`);
  }

  async function navigateToPage(iframeEl, pageIndex) {
    const startTime = Date.now();
    let rt = null;

    while (Date.now() - startTime < CONFIG.FRAME_TIMEOUT) {
      const win = iframeEl.contentWindow;
      rt = getNFBRRuntime(win);
      if (rt && (typeof rt.menu?.moveToPage === "function" || typeof rt.menu?.a6l?.moveToPage === "function")) {
        break;
      }
      await sleep(100);
    }

    if (!rt) {
      throw new Error("Không tìm thấy hàm điều khiển trang BookWalker.");
    }

    const menu = rt.menu;
    if (typeof menu.moveToPage === "function") {
      menu.moveToPage(Number(pageIndex));
    } else if (typeof menu.a6l?.moveToPage === "function") {
      menu.a6l.moveToPage(Number(pageIndex));
    }

    return await waitForRender(iframeEl, Number(pageIndex));
  }

  /**
   * BÓC TÁCH TOÀN BỘ 100% CANVAS NGUỒN VÀ THU NHỎ VỀ KÍCH THƯỚC METADATA (TRUE DOWNSCALE)
   */
  async function renderCanvasToBlob(iframeEl, pageObj, renderResult, isJpg) {
    const screen = renderResult.screen || renderResult.runtime?.renderer?.currentScreen;
    const srcCanvas = screen?.canvas;

    if (!srcCanvas || srcCanvas.width === 0 || srcCanvas.height === 0) {
      throw new Error("Canvas nguồn chưa sẵn sàng.");
    }

    const canvasDim = { width: srcCanvas.width, height: srcCanvas.height };
    const targetDim = getTargetPageDimensions(pageObj, canvasDim);

    // Tạo canvas xuất file theo đúng kích thước metadata của trang
    const outCanvas = DOC.createElement("canvas");
    outCanvas.width = targetDim.width;
    outCanvas.height = targetDim.height;

    const ctx = outCanvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Không thể tạo Context 2D.");

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, outCanvas.width, outCanvas.height);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    // Thu nhỏ toàn bộ 100% Canvas GPU về kích thước targetDim
    ctx.drawImage(
      srcCanvas,
      0, 0, srcCanvas.width, srcCanvas.height,
      0, 0, targetDim.width, targetDim.height
    );

    const mimeType = isJpg ? 'image/jpeg' : 'image/png';
    const quality = isJpg ? 0.95 : undefined;

    const blob = await new Promise((resolve, reject) => {
      if (typeof outCanvas.toBlob === "function") {
        outCanvas.toBlob(b => b ? resolve(b) : reject(new Error("Lỗi toBlob")), mimeType, quality);
      } else {
        try {
          const dataUrl = outCanvas.toDataURL(mimeType, quality);
          const parts = dataUrl.split(",");
          const byteStr = WIN.atob(parts[1]);
          const arr = new Uint8Array(byteStr.length);
          for (let i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i);
          resolve(new Blob([arr], { type: mimeType }));
        } catch (e) {
          reject(e);
        }
      }
    });

    outCanvas.width = 0;
    outCanvas.height = 0;

    const arrayBuffer = await blob.arrayBuffer();

    return {
      data: new Uint8Array(arrayBuffer),
      ext: isJpg ? 'jpg' : 'png'
    };
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
   * 5. GIAO DIỆN UI (VIOLET THEME & TRẠNG THÁI GIGAVIEWER)
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

    ui.count.textContent = completed + '/' + total;
    ui.percent.textContent = pct + '%';
    ui.fill.style.transform = "scaleX(" + pct / 100 + ')';
    ui.status.textContent = state.lastProgress.status;
  }

  function setUiBusy(isBusy) {
    const ui = state.ui;
    if (!ui) return;
    ui.button.disabled = Boolean(isBusy);
    ui.button.textContent = isBusy ? "Đang xử lý..." : "Download";
    ui.button.style.opacity = isBusy ? "0.72" : '1';
    ui.button.style.cursor = isBusy ? "progress" : "pointer";
    ui.jpgInput.disabled = Boolean(isBusy);
    ui.jpgInput.style.cursor = isBusy ? "default" : "pointer";
  }

  function createUI() {
    if (state.ui || !DOC.body) return;

    const PANEL_WIDTH = 220;
    const TAB_WIDTH = 14;
    let isCollapsed = localStorage.getItem("bw-dl:collapsed") === '1';

    const panel = DOC.createElement("div");
    panel.id = "bw-dl-panel";
    panel.style.cssText = [
      "all:initial",
      "position:fixed",
      "right:0px",
      "top:45px",
      "z-index:2147483647",
      "box-sizing:border-box",
      `width:${PANEL_WIDTH}px`,
      "padding:10px 14px",
      "border:1px solid #3730a3",
      "border-right:none",
      "border-radius:12px 0 0 12px",
      "background:#1e1b4b",
      "color:#ffffff",
      "font:12px/1.3 system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif",
      "user-select:none",
      "box-shadow:0 8px 24px rgba(0,0,0,0.85)",
      "transition:transform 0.22s cubic-bezier(0.16, 1, 0.3, 1)",
      `transform:${isCollapsed ? `translateX(calc(100% - ${TAB_WIDTH}px))` : "translateX(0)"}`,
      "display:none",
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
      "background:#4f46e5",
      "cursor:pointer",
      "transition:opacity 0.15s, background 0.15s",
      `opacity:${isCollapsed ? "1" : "0"}`,
      `pointer-events:${isCollapsed ? "auto" : "none"}`
    ].join(';');
    collapsedStrip.title = "Bấm để mở bảng tải";
    collapsedStrip.onmouseenter = () => { collapsedStrip.style.background = "#6366f1"; };
    collapsedStrip.onmouseleave = () => { collapsedStrip.style.background = "#4f46e5"; };

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
      "background:#4f46e5",
      "color:#ffffff",
      "font:900 10px system-ui,sans-serif",
      "cursor:pointer",
      "transition:background 0.15s ease",
      "z-index:2"
    ].join(';');
    collapseBtn.onmouseenter = () => { collapseBtn.style.background = "#6366f1"; };
    collapseBtn.onmouseleave = () => { collapseBtn.style.background = "#4f46e5"; };

    const title = DOC.createElement("div");
    title.textContent = "BookWalker Downloader";
    title.style.cssText = "all:initial;display:block;color:#a5b4fc;font:800 13px system-ui;margin-bottom:8px;text-align:center;padding-left:14px;";

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
      "background:#4f46e5",
      "color:#ffffff",
      "font:700 14px/1.2 system-ui,sans-serif",
      "text-align:center",
      "cursor:pointer",
      "box-shadow:0 3px 10px rgba(79, 70, 229, 0.35)"
    ].join(';');

    btn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      startDownload();
    });

    const label = DOC.createElement("label");
    label.style.cssText = "all:initial;display:inline-flex;align-items:center;gap:6px;margin-top:8px;color:#c7d2fe;font:700 11px system-ui;cursor:pointer;";

    const jpgInput = DOC.createElement("input");
    jpgInput.type = "checkbox";
    jpgInput.checked = state.convertJpeg;
    jpgInput.style.cssText = "all:initial;appearance:auto;width:14px;height:14px;accent-color:#4f46e5;cursor:pointer;";
    jpgInput.addEventListener("change", e => {
      e.stopPropagation();
      state.convertJpeg = jpgInput.checked;
      saveJpegPref(state.convertJpeg);
    });

    const spanJpg = DOC.createElement("span");
    spanJpg.textContent = "Xuất file JPG (mặc định PNG)";
    spanJpg.style.cssText = "all:initial;color:#c7d2fe;font:700 11px system-ui;";
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
    track.style.cssText = "all:initial;display:block;height:6px;overflow:hidden;border-radius:3px;background:#312e81;margin-top:6px;";

    const fill = DOC.createElement("div");
    fill.style.cssText = "all:initial;display:block;width:100%;height:100%;background:#818cf8;transform:scaleX(0);transform-origin:left center;transition:transform .22s ease;";
    track.appendChild(fill);

    const statusText = DOC.createElement("div");
    statusText.textContent = state.lastProgress.status;
    statusText.style.cssText = "all:initial;display:block;margin-top:8px;color:#c7d2fe;font:11px system-ui;word-break:break-word;";

    mainContent.append(collapseBtn, title, btn, label, progressRow, track, statusText);
    panel.append(collapsedStrip, mainContent);

    function setCollapsedState(collapsed) {
      isCollapsed = collapsed;
      localStorage.setItem("bw-dl:collapsed", isCollapsed ? '1' : '0');

      panel.style.transform = isCollapsed ? `translateX(calc(100% - ${TAB_WIDTH}px))` : "translateX(0)";
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

    const attachUI = () => {
      if (DOC.body && !DOC.getElementById("bw-dl-panel")) {
        DOC.body.appendChild(panel);
      }
    };
    attachUI();

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
   * 6. CHƯƠNG TRÌNH TẢI CHÍNH
   * ========================================================================= */
  async function startDownload() {
    if (state.running || !state.episodeData) return;
    state.running = true;
    setUiBusy(true);

    let workerIframe = null;
    let initialPageIndex = 0;

    try {
      updateProgressUI({ completed: 0, total: 0, status: "Đang đọc dữ liệu..." });

      const { rt: mainRt, pagesList } = state.episodeData;

      // Giới hạn 15 trang
      const selectedPages = CONFIG.PAGE_LIMIT ? pagesList.slice(0, CONFIG.PAGE_LIMIT) : pagesList;
      const totalPages = selectedPages.length;

      if (!totalPages) {
        throw new Error("Không tìm thấy trang truyện.");
      }

      initialPageIndex = getCurrentPageIndex(mainRt);
      const useJpeg = Boolean(state.convertJpeg);
      const zip = new PureZipWriter();
      const episodeId = getEpisodeId();

      // Xuất file txt lưu mã truyện
      zip.addFile(`${episodeId}.txt`, new Uint8Array(0));

      updateProgressUI({ completed: 0, total: totalPages, status: "Đang mở Trình xem ngầm..." });

      // 1. Tạo Iframe ngầm
      workerIframe = createWorkerIframe(selectedPages[0]);

      // 2. Chạy tải tuần tự từng trang từ trang 1 (index 0)
      updateProgressUI({ completed: 0, total: totalPages, status: "Đang tải..." });

      for (let i = 0; i < totalPages; i++) {
        const pageObj = selectedPages[i];

        // A. Thay đổi kích thước Iframe theo kích thước động của trang
        await resizeIframeAndTrigger(workerIframe, pageObj);

        // B. Điều hướng tới trang cần tải và chờ render hoàn tất
        const renderResult = await navigateToPage(workerIframe, pageObj.index);

        // C. Render Canvas và trích xuất Blob (mặc định PNG, hoặc JPG 0.95)
        const capture = await renderCanvasToBlob(workerIframe, pageObj, renderResult, useJpeg);

        // D. Lưu ảnh theo thứ tự 1.png, 2.png, ...
        zip.addFile(`${i + 1}.${capture.ext}`, capture.data);

        updateProgressUI({
          completed: i + 1,
          total: totalPages,
          status: "Đang tải..."
        });

        await sleep(60);
      }

      updateProgressUI({ completed: totalPages, total: totalPages, status: "Đang đóng gói ZIP..." });
      await sleep(50);

      const zipBlob = zip.generateBlob();
      const zipFileName = `${getCleanMangaTitle()}.zip`;
      triggerDownload(zipBlob, zipFileName);

      updateProgressUI({ completed: totalPages, total: totalPages, status: "Hoàn tất!" });
    } catch (err) {
      const msg = err?.message || String(err);
      updateProgressUI({ status: "Lỗi: " + msg });
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
      setUiBusy(false);
      updateProgressUI(state.lastProgress);
    }
  }

  /* =========================================================================
   * 7. KHỞI CHẠY & BỘ LẮNG NGHE ĐỔI ROUTE (SPA COMPATIBLE)
   * ========================================================================= */
  function resetState() {
    state.running = false;
    state.episodeData = null;
    if (state.ui?.panel) {
      state.ui.panel.style.display = "none";
    }
  }

  function initRouteWatcher() {
    let lastUrl = WIN.location.href;

    const onUrlChange = () => {
      const currentUrl = WIN.location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;

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
    while (!DOC.body) await sleep(100);

    createUI();

    let rt = null;
    let pagesList = [];
    let attempts = 0;

    // Chờ Runtime BookWalker sẵn sàng
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
      if (state.ui?.panel) state.ui.panel.style.display = "block";

      const total = CONFIG.PAGE_LIMIT ? Math.min(pagesList.length, CONFIG.PAGE_LIMIT) : pagesList.length;
      updateProgressUI({
        completed: 0,
        total: total,
        status: "Sẵn sàng."
      });
    } else {
      if (state.ui?.panel) state.ui.panel.style.display = "none";
    }
  }

  initRouteWatcher();

  if (DOC.readyState === "loading") {
    DOC.addEventListener("DOMContentLoaded", () => boot());
  } else {
    boot();
  }
})();