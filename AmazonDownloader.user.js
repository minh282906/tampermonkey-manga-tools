// ==UserScript==
// @name         Amazon Kindle Manga Downloader
// @namespace    https://read.amazon.co.jp/
// @version      1.0
// @icon         https://www.amazon.co.jp/favicon.ico
// @description  Tải và nén ZIP truyện Manga trên Amazon Kindle Web Reader.
// @author       anonymous & AI
// @match        https://read.amazon.co.jp/manga/*
// @match        https://read.amazon.com/manga/*
// @match        https://read.amazon.de/manga/*
// @match        https://read.amazon.co.uk/manga/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

(function amazonKindleMangaDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG AMAZON KINDLE
   * ========================================================================= */
  const CONFIG = {
    RENDER_WAIT_MS: 550, // Thời gian chờ Kindle vẽ xong trang ảnh (ms)
    MIN_IMAGE_DIM: 300 // Kích thước tối thiểu (px) để lọc bỏ icon UI
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
    convertJpeg: localStorage.getItem("amazon-dl:convert-jpeg") === '1',
    ui: null,
    lastProgress: { completed: 0, total: 0, percent: 0, status: "Đang kiểm tra..." }
  };

  function saveJpegPref(val) {
    try {
      WIN.localStorage.setItem("amazon-dl:convert-jpeg", val ? '1' : '0');
    } catch {}
  }

  function getAsin() {
    try {
      const match = WIN.location.pathname.match(/\/manga\/([A-Z0-9]{10})/i);
      if (match && match[1]) return match[1];
    } catch (e) {}
    return "AMAZON_MANGA";
  }

  function getCleanTitle() {
    try {
      const titleEl = DOC.getElementById('readerChromeTitle') || DOC.querySelector('.kw-rd-chrome-book-title');
      if (titleEl && titleEl.textContent) {
        let t = titleEl.textContent.trim();
        t = t.replace(/[\\/*?:"<>|]/g, '').trim();
        if (t) return t;
      }
    } catch (e) {}

    try {
      let title = DOC.title || "";
      title = title.replace(/^Kindle\s*-\s*/i, '');
      title = title.split('｜')[0].split('|')[0].trim();
      title = title.replace(/[\\/*?:"<>|]/g, '').trim();
      if (title) return title;
    } catch (e) {}

    return `Amazon_${getAsin()}`;
  }

  function getPageInfo() {
    let current = 0;
    let total = 0;

    const curEl = DOC.getElementById('pageInfoCurrentPage');
    const totEl = DOC.getElementById('pageInfoTotalPage');

    if (totEl && totEl.textContent) {
      total = parseInt(totEl.textContent.trim(), 10) || 0;
    }
    if (curEl && curEl.textContent) {
      current = parseInt(curEl.textContent.trim(), 10) || 0;
    }

    if (!total || !current) {
      const slider = DOC.getElementById('sliderBar');
      if (slider) {
        if (!total && slider.max) total = parseInt(slider.max, 10) || 0;
        if (!current && slider.value) current = parseInt(slider.value, 10) || 0;
      }
    }

    return { current: current || 1, total: total || 0 };
  }

  function setInteractionLock(locked) {
    let mask = DOC.getElementById('amazon-dl-mask');
    if (locked) {
      if (!mask) {
        mask = DOC.createElement('div');
        mask.id = 'amazon-dl-mask';
        mask.style.cssText = "position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,0.05);cursor:wait;pointer-events:auto;";
        DOC.body.appendChild(mask);
      }
    } else {
      if (mask) mask.remove();
    }
  }

  function sendKey(keyName, keyCode) {
    const opts = { key: keyName, code: keyName, keyCode: keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true };
    const targets = [DOC.activeElement, DOC.body, WIN, DOC.getElementById('bookContainer'), DOC.getElementById('readerContainer')].filter(Boolean);
    for (const target of targets) {
      target.dispatchEvent(new KeyboardEvent('keydown', opts));
      target.dispatchEvent(new KeyboardEvent('keyup', opts));
    }
  }

  function triggerSliderJump(slider, targetValue) {
    if (!slider) return;
    try {
      const tracker = slider._valueTracker;
      if (tracker) tracker.setValue(targetValue);

      const nativeSetter = Object.getOwnPropertyDescriptor(WIN.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(slider, targetValue);

      const opts = { bubbles: true, cancelable: true, view: WIN };
      slider.dispatchEvent(new MouseEvent('pointerdown', opts));
      slider.dispatchEvent(new MouseEvent('mousedown', opts));
      slider.dispatchEvent(new Event('input', opts));
      slider.dispatchEvent(new Event('change', opts));
      slider.dispatchEvent(new MouseEvent('pointerup', opts));
      slider.dispatchEvent(new MouseEvent('mouseup', opts));
    } catch (e) {
      console.error("[amazon-dl] Slider jump error:", e);
    }
  }

  function dispatchFullClick(el) {
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, view: WIN };
    el.dispatchEvent(new MouseEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  }

  async function ensureAtPage1() {
    updateProgressUI({ status: "Đang về trang đầu..." });
    setInteractionLock(false);

    let retries = 0;
    while (retries < 35) {
      const curEl = DOC.getElementById('pageInfoCurrentPage');
      const curNum = curEl ? parseInt(curEl.textContent.trim(), 10) : 0;

      if (curNum === 1) {
        updateProgressUI({ status: "Đang tải..." });
        await sleep(800);
        setInteractionLock(true);
        return true;
      }

      const slider = DOC.getElementById('sliderBar');
      if (slider && retries === 0) {
        triggerSliderJump(slider, 1);
        await sleep(500);
      }

      const rightChevron = DOC.querySelector('.kr-chevron-container-right');
      if (rightChevron) {
        dispatchFullClick(rightChevron);
      } else {
        sendKey("ArrowRight", 39);
      }

      await sleep(250);
      retries++;
    }

    setInteractionLock(true);
    return false;
  }

  async function stepToNextPage() {
    const startPage = getPageInfo().current;

    const leftChevron = DOC.querySelector('.kr-chevron-container-left');
    if (leftChevron) {
      dispatchFullClick(leftChevron);
    } else {
      sendKey("ArrowLeft", 37);
    }

    let startTime = Date.now();
    while (Date.now() - startTime < 400) {
      if (getPageInfo().current !== startPage) return true;
      await sleep(30);
    }

    sendKey("ArrowLeft", 37);

    startTime = Date.now();
    while (Date.now() - startTime < 400) {
      if (getPageInfo().current !== startPage) return true;
      await sleep(30);
    }

    return false;
  }

  async function jumpToPage(targetPage) {
    const slider = DOC.getElementById('sliderBar');
    if (slider) {
      triggerSliderJump(slider, targetPage);
    }

    let startTime = Date.now();
    while (Date.now() - startTime < 800) {
      if (getPageInfo().current === targetPage) return true;
      await sleep(40);
    }
    return false;
  }

  function calculateBufferHash(uint8Array) {
    let hash = 0;
    const len = uint8Array.length;
    const step = Math.max(1, Math.floor(len / 1000));
    for (let i = 0; i < len; i += step) {
      hash = ((hash << 5) - hash) + uint8Array[i];
      hash |= 0;
    }
    return `${len}_${hash}`;
  }

  /* =========================================================================
   * 3. LOGIC XỬ LÝ ẢNH CHUẨN (CẮT LỀ ĐEN VÀ CHIA ĐÔI 50/50 TOÁN HỌC)
   * ========================================================================= */

  function smartCropMangaCanvas(srcCanvas) {
    const w = srcCanvas.width;
    const h = srcCanvas.height;
    const ctx = srcCanvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;

    function isColumnContent(x) {
      let minLum = 255, maxLum = 0;
      for (let y = Math.floor(h * 0.05); y < Math.floor(h * 0.95); y += 3) {
        const idx = (y * w + x) * 4;
        const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
        if (lum < minLum) minLum = lum;
        if (lum > maxLum) maxLum = lum;
        if (lum > 22) return true;
      }
      return (maxLum - minLum) > 12;
    }

    let minX = 0;
    for (let x = 0; x < w; x++) {
      if (isColumnContent(x)) { minX = x; break; }
    }

    let maxX = w - 1;
    for (let x = w - 1; x >= minX; x--) {
      if (isColumnContent(x)) { maxX = x; break; }
    }

    function isRowContent(y) {
      for (let x = minX; x <= maxX; x += 4) {
        const idx = (y * w + x) * 4;
        const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
        if (lum > 22) return true;
      }
      return false;
    }

    let minY = 0;
    for (let y = 0; y < h; y++) {
      if (isRowContent(y)) { minY = y; break; }
    }

    let maxY = h - 1;
    for (let y = h - 1; y >= minY; y--) {
      if (isRowContent(y)) { maxY = y; break; }
    }

    const cropW = maxX - minX + 1;
    const cropH = maxY - minY + 1;

    if (cropW < CONFIG.MIN_IMAGE_DIM || cropH < CONFIG.MIN_IMAGE_DIM) {
      return srcCanvas;
    }

    const outCanvas = DOC.createElement('canvas');
    outCanvas.width = cropW;
    outCanvas.height = cropH;
    const outCtx = outCanvas.getContext('2d', { alpha: false });
    outCtx.fillStyle = '#000000';
    outCtx.fillRect(0, 0, cropW, cropH);
    outCtx.drawImage(srcCanvas, minX, minY, cropW, cropH, 0, 0, cropW, cropH);

    return outCanvas;
  }

  async function processAndSplitCanvas(croppedCanvas, useJpeg) {
    const w = croppedCanvas.width;
    const h = croppedCanvas.height;
    const ratio = w / h;

    const results = [];
    const mimeType = useJpeg ? 'image/jpeg' : 'image/png';
    const quality = useJpeg ? 0.95 : undefined;

    if (ratio > 1.1) {
      // DÙNG PHÉP CHIA CHÍNH GIỮA 50/50 TOÁN HỌC THUẦN TÚY (CHUẨN tuyệt đối 100%)
      const splitX = Math.floor(w / 2);

      const rightW = w - splitX;
      const rightCanvas = DOC.createElement('canvas');
      rightCanvas.width = rightW;
      rightCanvas.height = h;
      const rCtx = rightCanvas.getContext('2d', { alpha: false });
      rCtx.fillStyle = '#000000';
      rCtx.fillRect(0, 0, rightW, h);
      rCtx.drawImage(croppedCanvas, splitX, 0, rightW, h, 0, 0, rightW, h);

      const leftW = splitX;
      const leftCanvas = DOC.createElement('canvas');
      leftCanvas.width = leftW;
      leftCanvas.height = h;
      const lCtx = leftCanvas.getContext('2d', { alpha: false });
      lCtx.fillStyle = '#000000';
      lCtx.fillRect(0, 0, leftW, h);
      lCtx.drawImage(croppedCanvas, 0, 0, leftW, h, 0, 0, leftW, h);

      const rightBlob = await new Promise(res => rightCanvas.toBlob(res, mimeType, quality));
      const leftBlob = await new Promise(res => leftCanvas.toBlob(res, mimeType, quality));

      if (rightBlob) {
        results.push({
          uint8Array: new Uint8Array(await rightBlob.arrayBuffer()),
          ext: useJpeg ? 'jpg' : 'png'
        });
      }
      if (leftBlob) {
        results.push({
          uint8Array: new Uint8Array(await leftBlob.arrayBuffer()),
          ext: useJpeg ? 'jpg' : 'png'
        });
      }
    } else {
      const blob = await new Promise(res => croppedCanvas.toBlob(res, mimeType, quality));
      if (blob) {
        results.push({
          uint8Array: new Uint8Array(await blob.arrayBuffer()),
          ext: useJpeg ? 'jpg' : 'png'
        });
      }
    }

    return results;
  }

  async function captureActivePageElements(useJpeg) {
    const container = DOC.getElementById('bookContainer') || DOC.getElementById('readerContainer') || DOC.body;
    if (!container) return [];

    const elements = Array.from(container.querySelectorAll('.kg-full-page-img img, img[src^="blob:"], canvas'));
    const visibleElements = [];

    const viewW = WIN.innerWidth;
    const viewH = WIN.innerHeight;

    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      const w = el.naturalWidth || el.width || rect.width;
      const h = el.naturalHeight || el.height || rect.height;

      if (w < CONFIG.MIN_IMAGE_DIM || h < CONFIG.MIN_IMAGE_DIM) continue;

      if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < viewH && rect.right > 0 && rect.left < viewW) {
        const style = WIN.getComputedStyle(el);
        if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
          visibleElements.push({ el, rect, w, h });
        }
      }
    }

    visibleElements.sort((a, b) => b.rect.left - a.rect.left);

    const capturedBlobs = [];
    for (const item of visibleElements) {
      try {
        if (item.el.tagName.toLowerCase() === 'img') {
          if (!item.el.complete || item.el.naturalWidth === 0) {
            await new Promise(res => {
              item.el.onload = res;
              item.el.onerror = res;
              setTimeout(res, 250);
            });
          }
        }

        let rawCanvas;
        if (item.el.tagName.toLowerCase() === 'canvas') {
          rawCanvas = item.el;
        } else {
          rawCanvas = DOC.createElement('canvas');
          rawCanvas.width = item.el.naturalWidth || item.w;
          rawCanvas.height = item.el.naturalHeight || item.h;
          const ctx = rawCanvas.getContext('2d', { alpha: false });
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, rawCanvas.width, rawCanvas.height);
          ctx.drawImage(item.el, 0, 0, rawCanvas.width, rawCanvas.height);
        }

        const croppedCanvas = smartCropMangaCanvas(rawCanvas);
        const splitPages = await processAndSplitCanvas(croppedCanvas, useJpeg);
        for (const sp of splitPages) {
          capturedBlobs.push(sp);
        }

      } catch (e) {
        console.error("[amazon-dl] Error processing canvas:", e);
      }
    }

    return capturedBlobs;
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
    ui.button.textContent = isBusy ? "Đang xử lý..." : "Download";
    ui.button.style.opacity = isBusy ? "0.72" : '1';
    ui.button.style.cursor = isBusy ? "progress" : "pointer";
    ui.jpgInput.disabled = Boolean(isBusy);
  }

  /* =========================================================================
   * 4. CHƯƠNG TRÌNH TẢI CHÍNH
   * ========================================================================= */
  async function startDownload() {
    state.running = true;
    setUiBusy(true);

    const initialInfo = getPageInfo();
    const initialPage = initialInfo.current || 1;
    const totalPages = initialInfo.total;

    if (!totalPages) {
      updateProgressUI({ status: "Lỗi: Không lấy được số trang." });
      setUiBusy(false);
      state.running = false;
      return;
    }

    const useJpeg = Boolean(state.convertJpeg);
    const zip = new PureZipWriter();
    const hashesSet = new Set();
    let savedCount = 0;

    try {
      const asin = getAsin();
      zip.addFile(`${asin}.txt`, new Uint8Array(0));

      await ensureAtPage1();

      updateProgressUI({ completed: 0, total: totalPages, status: "Đang tải..." });

      let attempts = 0;
      const maxAttempts = totalPages * 3;

      while (state.running && attempts < maxAttempts) {
        attempts++;
        const curInfo = getPageInfo();

        const pageImages = await captureActivePageElements(useJpeg);

        for (const imgObj of pageImages) {
          const hash = calculateBufferHash(imgObj.uint8Array);
          if (!hashesSet.has(hash)) {
            hashesSet.add(hash);
            savedCount++;
            zip.addFile(`${savedCount}.${imgObj.ext}`, imgObj.uint8Array);
          }
        }

        updateProgressUI({
          completed: Math.min(curInfo.current, totalPages),
          total: totalPages,
          status: "Đang tải..."
        });

        if (curInfo.current >= totalPages) {
          break;
        }

        await stepToNextPage();
        await sleep(CONFIG.RENDER_WAIT_MS);
      }

      if (savedCount === 0) {
        throw new Error("Không thể bóc tách trang truyện.");
      }

      updateProgressUI({ completed: totalPages, total: totalPages, status: "Đang đóng gói ZIP..." });
      await sleep(60);

      const zipBlob = zip.generateBlob();
      const zipFileName = `${getCleanTitle()}.zip`;
      triggerDownload(zipBlob, zipFileName);

      updateProgressUI({ completed: totalPages, total: totalPages, status: "Hoàn tất!" });

    } catch (err) {
      const msg = err?.message || String(err);
      updateProgressUI({ status: "Lỗi: " + msg });
      console.error("[amazon-dl] Download failed:", err);
    } finally {
      try {
        await jumpToPage(initialPage);
      } catch (e) {}

      setInteractionLock(false);
      state.running = false;
      setUiBusy(false);
      updateProgressUI(state.lastProgress);
    }
  }

  /* =========================================================================
   * 5. GIAO DIỆN UI (TÔNG MÀU AMAZON AMBER / SLATE)
   * ========================================================================= */
  function createUI() {
    if (state.ui || !DOC.body) return;

    const PANEL_WIDTH = 220;
    const TAB_WIDTH = 14;
    let isCollapsed = localStorage.getItem("amazon-dl:collapsed") === '1';

    const panel = DOC.createElement("div");
    panel.id = "amazon-dl-panel";
    panel.style.cssText = [
      "all:initial",
      "position:fixed",
      "right:0px",
      "top:97px",
      "z-index:2147483647",
      "box-sizing:border-box",
      `width:${PANEL_WIDTH}px`,
      "padding:10px 14px",
      "border:1px solid #ea580c",
      "border-right:none",
      "border-radius:12px 0 0 12px",
      "background:#1c1917",
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
      "background:#f97316",
      "cursor:pointer",
      "transition:opacity 0.15s, background 0.15s",
      `opacity:${isCollapsed ? "1" : "0"}`,
      `pointer-events:${isCollapsed ? "auto" : "none"}`
    ].join(';');
    collapsedStrip.title = "Bấm để mở bảng tải";
    collapsedStrip.onmouseenter = () => { collapsedStrip.style.background = "#fb923c"; };
    collapsedStrip.onmouseleave = () => { collapsedStrip.style.background = "#f97316"; };

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
      "background:#f97316",
      "color:#0f172a",
      "font:900 10px system-ui,sans-serif",
      "cursor:pointer",
      "transition:background 0.15s ease",
      "z-index:2"
    ].join(';');
    collapseBtn.onmouseenter = () => { collapseBtn.style.background = "#fb923c"; };
    collapseBtn.onmouseleave = () => { collapseBtn.style.background = "#f97316"; };

    const title = DOC.createElement("div");
    title.textContent = "Kindle Downloader";
    title.style.cssText = "all:initial;display:block;color:#fdba74;font:800 13px system-ui;margin-bottom:8px;text-align:center;padding-left:14px;";

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
      "background:#f97316",
      "color:#0f172a",
      "font:800 14px/1.2 system-ui,sans-serif",
      "text-align:center",
      "cursor:pointer",
      "box-shadow:0 3px 10px rgba(249, 115, 22, 0.35)"
    ].join(';');

    btn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      if (!state.running) startDownload();
    });

    const label = DOC.createElement("label");
    label.style.cssText = "all:initial;display:inline-flex;align-items:center;gap:6px;margin-top:8px;color:#fed7aa;font:700 11px system-ui;cursor:pointer;";

    const jpgInput = DOC.createElement("input");
    jpgInput.type = "checkbox";
    jpgInput.checked = state.convertJpeg;
    jpgInput.style.cssText = "all:initial;appearance:auto;width:14px;height:14px;accent-color:#f97316;cursor:pointer;";
    jpgInput.addEventListener("change", () => {
      state.convertJpeg = jpgInput.checked;
      saveJpegPref(state.convertJpeg);
    });

    const spanJpg = DOC.createElement("span");
    spanJpg.textContent = "Xuất file JPG (mặc định PNG)";
    spanJpg.style.cssText = "all:initial;color:#fed7aa;font:700 11px system-ui;";
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
    track.style.cssText = "all:initial;display:block;height:6px;overflow:hidden;border-radius:3px;background:#441a06;margin-top:6px;";

    const fill = DOC.createElement("div");
    fill.style.cssText = "all:initial;display:block;width:100%;height:100%;background:#fb923c;transform:scaleX(0);transform-origin:left center;transition:transform .22s ease;";
    track.appendChild(fill);

    const statusText = DOC.createElement("div");
    statusText.textContent = state.lastProgress.status;
    statusText.style.cssText = "all:initial;display:block;margin-top:8px;color:#fed7aa;font:11px system-ui;word-break:break-word;";

    mainContent.append(collapseBtn, title, btn, label, progressRow, track, statusText);
    panel.append(collapsedStrip, mainContent);

    function setCollapsedState(collapsed) {
      isCollapsed = collapsed;
      localStorage.setItem("amazon-dl:collapsed", isCollapsed ? '1' : '0');

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
      if (DOC.body && !DOC.getElementById("amazon-dl-panel")) {
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
   * 6. KHỞI TẠO VÀ CHỜ XÁC NHẬN TỔNG SỐ TRANG MỚI HIỂN THỊ UI
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) {
      await sleep(100);
    }
    createUI();

    let retries = 0;
    while (retries < 50) {
      const info = getPageInfo();
      if (info.total > 0) {
        updateProgressUI({
          completed: 0,
          total: info.total,
          status: "Sẵn sàng."
        });

        if (state.ui && state.ui.panel) {
          state.ui.panel.style.display = "block";
        }
        return;
      }
      await sleep(200);
      retries++;
    }
  }

  if (DOC.readyState === "loading") {
    DOC.addEventListener("DOMContentLoaded", () => boot());
  } else {
    boot();
  }
})();