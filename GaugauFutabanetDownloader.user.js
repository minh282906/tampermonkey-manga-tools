// ==UserScript==
// @name         Gaugau Futabanet Downloader
// @namespace    https://gaugau.futabanet.jp/
// @version      1.0
// @icon         https://www.google.com/s2/favicons?domain=gaugau.futabanet.jp/&sz=128
// @description  Tải truyện trên Gaugau Futabanet, tự động ghép mảnh CSS inset, đóng gói ZIP.
// @author       anonymous & AI
// @match        https://gaugau.futabanet.jp/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      gaugau.futabanet.jp
// @connect      *
// ==/UserScript==

(function gaugauFutabanetDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 4, // Số lượng trang tải song song cùng lúc
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  // Kiểm tra chỉ chạy UI trên cửa sổ chính (bỏ qua nếu là Iframe ngầm)
  const isTopWindow = (() => {
    try { return WIN.top === WIN.self; } catch { return true; }
  })();

  if (!isTopWindow) {
    if (WIN.location.hash.includes("tm-silent-reader-")) {
      try {
        WIN.Storage.prototype.setItem = function() {};
        WIN.Storage.prototype.removeItem = function() {};
        WIN.Storage.prototype.clear = function() {};
      } catch(e) {}
    }
    return;
  }

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
    convertJpeg: localStorage.getItem("gaugau-dl:convert-jpeg") === '1',
    ui: null,
    lastProgress: { completed: 0, total: 0, percent: 0, status: "Đang kiểm tra..." }
  };

  function saveJpegPref(val) {
    try {
      WIN.localStorage.setItem("gaugau-dl:convert-jpeg", val ? '1' : '0');
    } catch {}
  }

  function getCleanMangaTitle() {
    try {
      let rawTitle = DOC.title || "";
      let clean = rawTitle.split('｜')[0].split('|')[0].trim();
      
      clean = clean.replace(/^公式\s*[-－_]?\s*/i, '').trim();
      clean = clean.replace(/【[^】]*】/g, '').trim();
      clean = clean.replace(/[\\/*?:"<>|]/g, '').trim();
      
      return clean || getCidPrefix() || "Gaugau_Manga";
    } catch (e) {
      return getCidPrefix() || "Gaugau_Manga";
    }
  }

  function getCidPrefix() {
    try {
      const contentEl = DOC.getElementById('content');
      if (contentEl) {
        const cid = contentEl.getAttribute('data-ptbinb-cid');
        if (cid) return cid.trim();
      }
    } catch (e) {}

    const search = new URLSearchParams(WIN.location.search);
    const cid = search.get("cid") || '';
    if (cid) return cid;

    const match = WIN.location.href.match(/([a-zA-Z0-9_-]{8,})/);
    return match ? match[1] : "Gaugau_Episode";
  }

  function getReader() {
    try { return WIN.SpeedBinb?.getInstance?.("content") || null; } catch { return null; }
  }

  function getCurrentPageIndex(reader) {
    if (!reader) return -1;
    try {
      if (typeof reader.getViewIndex === 'function') return reader.getViewIndex();
      if (typeof reader.p === 'number' && reader.p >= 0) return reader.p;
      if (typeof reader.currentP === 'number' && reader.currentP >= 0) return reader.currentP;
    } catch (e) {}
    return -1;
  }

  async function waitForReader(timeoutMs = 45000) {
    const endTime = (WIN.performance?.now?.() || Date.now()) + timeoutMs;
    while ((WIN.performance?.now?.() || Date.now()) < endTime) {
      const reader = getReader();
      if (Boolean(reader && reader.isContentLoaded && reader.content && Array.isArray(reader.content.page) && reader.content.page.length > 0)) {
        return reader;
      }
      await sleep(120);
    }
    throw new Error("Không tìm thấy viewer đã tải xong.");
  }

  function getSilentFrameUrl() {
    const url = new URL(WIN.location.href);
    url.hash = "tm-silent-reader-" + Date.now();
    return url.href;
  }

  async function createSilentFrame(timeoutMs = 45000) {
    if (!DOC.body) throw new Error("Trang chưa sẵn sàng.");
    DOC.getElementById("gaugau-dl-silent-frame")?.remove();

    const frame = DOC.createElement("iframe");
    frame.id = "gaugau-dl-silent-frame";
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.src = getSilentFrameUrl();
    frame.style.cssText = "position:fixed;left:-20000px;top:0;width:1280px;height:1800px;border:0;opacity:0;pointer-events:none;z-index:-1";

    DOC.body.appendChild(frame);

    const cleanup = () => { try { frame.remove(); } catch {} };
    const endTime = (WIN.performance?.now?.() || Date.now()) + timeoutMs;

    try {
      while ((WIN.performance?.now?.() || Date.now()) < endTime) {
        let win = null, doc = null;
        try {
          win = frame.contentWindow;
          doc = frame.contentDocument || win?.document || null;
        } catch { win = null; doc = null; }
        const reader = win?.SpeedBinb?.getInstance?.("content") || null;
        if (win && doc && Boolean(reader && reader.isContentLoaded && reader.content && Array.isArray(reader.content.page) && reader.content.page.length > 0)) {
          return { frame, W: win, D: doc, reader, cleanup };
        }
        await sleep(150);
      }
    } catch (err) {
      cleanup();
      throw err;
    }

    cleanup();
    throw new Error("Không tạo được viewer ẩn.");
  }

  /* =========================================================================
   * 3. LẤY DANH SÁCH TRANG TRUYỆN CHÍNH (LỌC BỎ ADS/BANNER)
   * ========================================================================= */
  function getPageList(reader) {
    const rawPages = Array.isArray(reader?.content?.page) ? reader.content.page : [];
    const mangaPages = [];
    let pageNo = 1;

    for (let index = 0; index < rawPages.length; index++) {
      const page = rawPages[index];
      const domId = page?.id || ("content-p" + (index + 1));
      const isAd = /^(ads|recommend|banners|rental|r-banner)/i.test(domId) || domId.includes('banner');

      if (!isAd) {
        mangaPages.push({
          page,
          index,
          domId,
          pageNo: pageNo++
        });
      }
    }

    return mangaPages;
  }

  /* =========================================================================
   * 4. THUẬT TOÁN BÓC TÁCH & PHÂN TÍCH CSS INSET
   * ========================================================================= */
  function parseSliceRect(styleStr) {
    if (!styleStr) return { top: 0, right: 0, bottom: 0, left: 0 };

    const insetMatch = styleStr.match(/inset:\s*([^;]+)/i);
    if (insetMatch) {
      const parts = insetMatch[1].trim().split(/\s+/).map(v => parseFloat(v) || 0);
      let top = 0, right = 0, bottom = 0, left = 0;

      if (parts.length === 1) {
        top = right = bottom = left = parts[0];
      } else if (parts.length === 2) {
        top = bottom = parts[0];
        right = left = parts[1];
      } else if (parts.length === 3) {
        top = parts[0];
        right = left = parts[1];
        bottom = parts[2];
      } else if (parts.length >= 4) {
        top = parts[0];
        right = parts[1];
        bottom = parts[2];
        left = parts[3];
      }
      return { top, right, bottom, left };
    }

    let top = 0, right = 0, bottom = 0, left = 0;
    const topMatch = styleStr.match(/top:\s*([\d\.-]+)/i);
    const rightMatch = styleStr.match(/right:\s*([\d\.-]+)/i);
    const bottomMatch = styleStr.match(/bottom:\s*([\d\.-]+)/i);
    const leftMatch = styleStr.match(/left:\s*([\d\.-]+)/i);
    const widthMatch = styleStr.match(/width:\s*([\d\.-]+)/i);
    const heightMatch = styleStr.match(/height:\s*([\d\.-]+)/i);

    if (topMatch) top = parseFloat(topMatch[1]);
    if (leftMatch) left = parseFloat(leftMatch[1]);
    if (rightMatch) right = parseFloat(rightMatch[1]);
    else if (widthMatch) right = 100 - left - parseFloat(widthMatch[1]);

    if (bottomMatch) bottom = parseFloat(bottomMatch[1]);
    else if (heightMatch && heightMatch[1]) bottom = 100 - top - parseFloat(heightMatch[1]);

    return { top, right, bottom, left };
  }

  async function stitchPageToUint8Array(pageDiv, isJpg) {
    const ptImg = pageDiv.querySelector('.pt-img') || pageDiv;
    const sliceDivs = Array.from(ptImg.children).filter(d => d.querySelector('img'));
    if (sliceDivs.length === 0) return null;

    const sliceData = [];
    let maxFullH = 0, maxFullW = 0;

    for (const div of sliceDivs) {
      const img = div.querySelector('img');
      if (!img || !img.complete || img.naturalWidth === 0 || !img.src.startsWith('blob:')) return null;

      const styleStr = div.getAttribute('style') || '';
      const inset = parseSliceRect(styleStr);

      const spanH = (100 - inset.bottom - inset.top) / 100;
      if (spanH > 0) {
        const estH = img.naturalHeight / spanH;
        if (estH > maxFullH) maxFullH = estH;
      }

      const spanW = (100 - inset.left - inset.right) / 100;
      if (spanW > 0) {
        const estW = img.naturalWidth / spanW;
        if (estW > maxFullW) maxFullW = estW;
      }

      sliceData.push({ img, inset });
    }

    if (sliceData.length === 0 || maxFullW === 0 || maxFullH === 0) return null;

    const targetW = Math.round(maxFullW);
    const targetH = Math.round(maxFullH);

    const canvas = DOC.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetW, targetH);

    for (const item of sliceData) {
      const dx = Math.round((item.inset.left / 100) * targetW);
      const dy = Math.round((item.inset.top / 100) * targetH);
      const dw = Math.round(((100 - item.inset.left - item.inset.right) / 100) * targetW);
      const dh = Math.round(((100 - item.inset.top - item.inset.bottom) / 100) * targetH);

      ctx.drawImage(item.img, 0, 0, item.img.naturalWidth, item.img.naturalHeight, dx, dy, dw, dh);
    }

    const mimeType = isJpg ? 'image/jpeg' : 'image/png';
    const quality = isJpg ? 0.95 : undefined;

    const blob = await new Promise(resolve => canvas.toBlob(resolve, mimeType, quality));
    const arrayBuffer = await blob.arrayBuffer();

    return {
      uint8Array: new Uint8Array(arrayBuffer),
      ext: isJpg ? 'jpg' : 'png'
    };
  }

  async function waitForRenderedPageAndStitch(pageObj, frameDoc, isJpg, timeoutMs = 4000) {
    const endTime = (WIN.performance?.now?.() || Date.now()) + timeoutMs;
    while ((WIN.performance?.now?.() || Date.now()) < endTime) {
      const pageDiv = frameDoc.getElementById(pageObj.domId) || frameDoc.querySelector(`#content-p${pageObj.pageNo}`);
      if (pageDiv) {
        const result = await stitchPageToUint8Array(pageDiv, isJpg);
        if (result) return result;
      }
      await sleep(100);
    }
    return null;
  }

  /* =========================================================================
   * 5. TIẾN TRÌNH TẢI SONG SONG
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
          console.error(`[gaugau-dl] Lỗi trang ${currentIndex + 1}:`, err);
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
   * 6. GIAO DIỆN UI (TÔNG MÀU CYAN #06b6d4)
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
    if (state.ui || !DOC.body || DOC.getElementById("gaugau-dl-panel")) return;

    const PANEL_WIDTH = 220;
    const TAB_WIDTH = 14;
    let isCollapsed = localStorage.getItem("gaugau-dl:collapsed") === '1';

    const panel = DOC.createElement("div");
    panel.id = "gaugau-dl-panel";
    panel.style.cssText = [
      "all:initial",
      "position:fixed",
      "right:0px",
      "top:97px",
      "z-index:2147483647",
      "box-sizing:border-box",
      `width:${PANEL_WIDTH}px`,
      "padding:10px 14px",
      "border:1px solid #0891b2",
      "border-right:none",
      "border-radius:12px 0 0 12px",
      "background:#083344",
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
      "background:#06b6d4",
      "cursor:pointer",
      "transition:opacity 0.15s, background 0.15s",
      `opacity:${isCollapsed ? "1" : "0"}`,
      `pointer-events:${isCollapsed ? "auto" : "none"}`
    ].join(';');
    collapsedStrip.title = "Mở bảng tải";
    collapsedStrip.onmouseenter = () => { collapsedStrip.style.background = "#22d3ee"; };
    collapsedStrip.onmouseleave = () => { collapsedStrip.style.background = "#06b6d4"; };

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
      "background:#06b6d4",
      "color:#083344",
      "font:900 10px system-ui,sans-serif",
      "cursor:pointer",
      "transition:background 0.15s ease",
      "z-index:2"
    ].join(';');
    collapseBtn.onmouseenter = () => { collapseBtn.style.background = "#22d3ee"; };
    collapseBtn.onmouseleave = () => { collapseBtn.style.background = "#06b6d4"; };

    const title = DOC.createElement("div");
    title.textContent = "Gaugau Downloader";
    title.style.cssText = "all:initial;display:block;color:#67e8f9;font:800 13px system-ui;margin-bottom:8px;text-align:center;padding-left:14px;";

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
      "background:#06b6d4",
      "color:#083344",
      "font:800 14px/1.2 system-ui,sans-serif",
      "text-align:center",
      "cursor:pointer",
      "box-shadow:0 3px 10px rgba(6, 182, 212, 0.35)"
    ].join(';');

    btn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      if (!state.running) startDownload();
    });

    const label = DOC.createElement("label");
    label.style.cssText = "all:initial;display:inline-flex;align-items:center;gap:6px;margin-top:8px;color:#cffaff;font:700 11px system-ui;cursor:pointer;";

    const jpgInput = DOC.createElement("input");
    jpgInput.type = "checkbox";
    jpgInput.checked = state.convertJpeg;
    jpgInput.style.cssText = "all:initial;appearance:auto;width:14px;height:14px;accent-color:#06b6d4;cursor:pointer;";
    jpgInput.addEventListener("change", () => {
      state.convertJpeg = jpgInput.checked;
      saveJpegPref(state.convertJpeg);
    });

    const spanJpg = DOC.createElement("span");
    spanJpg.textContent = "Xuất file JPG (mặc định PNG)";
    spanJpg.style.cssText = "all:initial;color:#cffaff;font:700 11px system-ui;";
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
    track.style.cssText = "all:initial;display:block;height:6px;overflow:hidden;border-radius:3px;background:#164e63;margin-top:6px;";

    const fill = DOC.createElement("div");
    fill.style.cssText = "all:initial;display:block;width:100%;height:100%;background:#22d3ee;transform:scaleX(0);transform-origin:left center;transition:transform .22s ease;";
    track.appendChild(fill);

    const statusText = DOC.createElement("div");
    statusText.textContent = state.lastProgress.status;
    statusText.style.cssText = "all:initial;display:block;margin-top:8px;color:#cffaff;font:11px system-ui;word-break:break-word;";

    mainContent.append(collapseBtn, title, btn, label, progressRow, track, statusText);
    panel.append(collapsedStrip, mainContent);

    function setCollapsedState(collapsed) {
      isCollapsed = collapsed;
      localStorage.setItem("gaugau-dl:collapsed", isCollapsed ? '1' : '0');

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
   * 7. CHƯƠNG TRÌNH TẢI CHÍNH
   * ========================================================================= */
  let readerLock = Promise.resolve();
  function withReaderLock(fn) {
    const next = readerLock.then(fn, fn);
    readerLock = next;
    return next;
  }

  async function startDownload() {
    if (state.running) return;
    state.running = true;
    setUiBusy(true);
    let silentFrameObj = null;

    const mainReader = getReader();
    const initialPageIndex = getCurrentPageIndex(mainReader);

    try {
      updateProgressUI({ completed: 0, total: 0, status: "Đang tải..." });
      await waitForReader();
      silentFrameObj = await createSilentFrame();

      const reader = silentFrameObj.reader;
      const pages = getPageList(reader);
      const totalPages = pages.length;

      if (!totalPages) {
        throw new Error("Không có trang hợp lệ để tải.");
      }

      const useJpeg = Boolean(state.convertJpeg);
      const zip = new PureZipWriter();
      const cidPrefix = getCidPrefix();

      zip.addFile(`${cidPrefix}.txt`, new Uint8Array(0));

      updateProgressUI({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map((pageObj) => async () => {
        return withReaderLock(async () => {
          silentFrameObj.reader.moveTo(pageObj.index, false);
          const stitched = await waitForRenderedPageAndStitch(pageObj, silentFrameObj.D, useJpeg, 4000);
          if (stitched) {
            return {
              fileName: `${pageObj.pageNo}.${stitched.ext}`,
              data: stitched.uint8Array
            };
          }
          return null;
        });
      });

      const results = await runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        updateProgressUI({ completed, total, status: "Đang tải..." });
      });

      updateProgressUI({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      let savedCount = 0;
      for (const res of results) {
        if (res && res.data) {
          zip.addFile(res.fileName, res.data);
          savedCount++;
        }
      }

      if (savedCount === 0) {
        throw new Error("Lỗi nạp trang truyện.");
      }

      const zipBlob = zip.generateBlob();
      const zipFileName = `${getCleanMangaTitle()}.zip`;
      triggerDownload(zipBlob, zipFileName);

      updateProgressUI({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      const msg = err?.message || String(err);
      updateProgressUI({ status: "Lỗi: " + msg });
      console.error("[gaugau-dl] Download failed", err);
    } finally {
      if (silentFrameObj) silentFrameObj.cleanup();

      try {
        const curMainReader = getReader();
        if (curMainReader && typeof curMainReader.moveTo === 'function' && initialPageIndex >= 0) {
          curMainReader.moveTo(initialPageIndex, false);
        }
      } catch (e) {}

      state.running = false;
      setUiBusy(false);
      updateProgressUI(state.lastProgress);
    }
  }

  /* =========================================================================
   * 8. KHỞI TẠO VÀ BOOT
   * ========================================================================= */
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
    while (!DOC.body) {
      await sleep(100);
    }
    createUI();
    updateProgressUI({ completed: 0, total: 0, status: "Đang kiểm tra..." });

    try {
      const reader = await waitForReader();
      const pages = getPageList(reader);
      updateProgressUI({
        completed: 0,
        total: pages.length,
        status: "Sẵn sàng."
      });
    } catch (err) {
      updateProgressUI({
        completed: 0,
        total: 0,
        status: "Lỗi: " + (err?.message || err)
      });
    }
  }

  initRouteWatcher();

  if (DOC.readyState === "loading") {
    DOC.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();