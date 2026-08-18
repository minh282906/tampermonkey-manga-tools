// ==UserScript==
// @name         Amazon Kindle Manga Downloader
// @namespace    https://read.amazon.co.jp/
// @version      1.0
// @icon         https://www.amazon.co.jp/favicon.ico
// @description  Tải manga trên Amazon Kindle Web Reader.
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
    RENDER_WAIT_MS: 480, // Thời gian chờ Kindle vẽ xong trang ảnh (ms)
    MIN_IMAGE_DIM: 300   // Kích thước tối thiểu (px) để lọc bỏ icon UI
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
    lastVerifiedPageWidth: 0,
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
        t = t.replace(/【[^】]*】/g, '').replace(/[\\/*?:"<>|]/g, '').trim();
        if (t) return t;
      }
    } catch (e) {}

    try {
      let title = DOC.title || "";
      title = title.replace(/^Kindle\s*-\s*/i, '');
      title = title.split('｜')[0].split('|')[0].trim();
      title = title.replace(/【[^】]*】/g, '').replace(/[\\/*?:"<>|]/g, '').trim();
      if (title) return title;
    } catch (e) {}

    return `Amazon_${getAsin()}`;
  }

  function getPageInfo() {
    let current = 0;
    let total = 0;

    const curEl = DOC.getElementById('pageInfoCurrentPage');
    const totEl = DOC.getElementById('pageInfoTotalPage');

    if (totEl?.textContent) {
      total = parseInt(totEl.textContent.trim(), 10) || 0;
    }
    if (curEl?.textContent) {
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

  let wasFullscreen = false;
  async function handleFullscreenStart() {
    wasFullscreen = Boolean(DOC.fullscreenElement);
    if (!wasFullscreen && typeof DOC.documentElement.requestFullscreen === "function") {
      try {
        await DOC.documentElement.requestFullscreen();
        await sleep(500);
      } catch (e) {}
    }
  }

  async function handleFullscreenEnd() {
    if (!wasFullscreen && DOC.fullscreenElement && typeof DOC.exitFullscreen === "function") {
      try {
        await DOC.exitFullscreen();
        await sleep(250);
      } catch (e) {}
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
    } catch (e) {}
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
      const curInfo = getPageInfo();
      if (curInfo.current === 1) {
        updateProgressUI({ status: "Đang tải..." });
        await sleep(600);
        setInteractionLock(true);
        return true;
      }

      const slider = DOC.getElementById('sliderBar');
      if (slider && retries === 0) {
        triggerSliderJump(slider, 1);
        await sleep(400);
      }

      const rightChevron = DOC.querySelector('.kr-chevron-container-right');
      if (rightChevron) {
        dispatchFullClick(rightChevron);
      } else {
        sendKey("ArrowRight", 39);
      }

      await sleep(200);
      retries++;
    }
    setInteractionLock(true);
    return getPageInfo().current === 1;
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
   * 3. THUẬT TOÁN DÒ VẠCH PHÂN CHIA TƯƠNG PHẢN & XÉN MÉP NGOÀI
   * ========================================================================= */
  function isColumnPureBlack(x, w, h, data) {
    for (let y = Math.floor(h * 0.05); y < Math.floor(h * 0.95); y += 3) {
      const idx = (y * w + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const a = data[idx + 3];
      if ((r > 2 || g > 2 || b > 2) && a > 10) {
        return false;
      }
    }
    return true;
  }

  // Dò vạch phân chia tương phản giữa 2 trang quanh tâm Canvas
  function findContrastSeamX(canvas, searchRadius = 25, minContrast = 25) {
    const w = canvas.width;
    const h = canvas.height;
    const midX = Math.floor(w / 2);
    const ctx = canvas.getContext('2d');
    const startSearch = Math.max(1, midX - searchRadius);
    const endSearch = Math.min(w - 2, midX + searchRadius);

    try {
      const imgData = ctx.getImageData(startSearch - 1, 0, endSearch - startSearch + 3, h);
      const data = imgData.data;
      const dataW = endSearch - startSearch + 3;

      let bestX = midX;
      let maxScore = 0;

      for (let x = startSearch; x <= endSearch; x++) {
        let totalDiff = 0;
        let count = 0;

        for (let y = Math.floor(h * 0.05); y < Math.floor(h * 0.95); y += 4) {
          const localX1 = x - startSearch + 1;
          const localX2 = localX1 + 1;

          const idx1 = (y * dataW + localX1) * 4;
          const idx2 = (y * dataW + localX2) * 4;

          const lum1 = 0.299 * data[idx1] + 0.587 * data[idx1 + 1] + 0.114 * data[idx1 + 2];
          const lum2 = 0.299 * data[idx2] + 0.587 * data[idx2 + 1] + 0.114 * data[idx2 + 2];

          totalDiff += Math.abs(lum1 - lum2);
          count++;
        }

        const avgScore = count > 0 ? totalDiff / count : 0;
        if (avgScore > maxScore) {
          maxScore = avgScore;
          bestX = x;
        }
      }

      if (maxScore >= minContrast) {
        return bestX + 1;
      }
    } catch (e) {}

    return midX;
  }

  // 1. Xử lý Nửa Trang Trái
  function cropLeftHalf(leftCanvas, h) {
    const w = leftCanvas.width;
    const ctx = leftCanvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;

    let firstNonBlackX = -1;
    for (let x = 0; x < w; x++) {
      if (!isColumnPureBlack(x, w, h, data)) {
        firstNonBlackX = x;
        break;
      }
    }

    let cropStartX = 0;
    let isValid = false;

    if (firstNonBlackX !== -1) {
      const candidateX = firstNonBlackX + 1; // Bỏ cột mờ (+1)
      const pageW = w - candidateX;
      if (pageW >= Math.floor(w * 0.4) && pageW <= w) {
        cropStartX = candidateX;
        isValid = true;
      }
    }

    if (!isValid) {
      if (state.lastVerifiedPageWidth && state.lastVerifiedPageWidth <= w) {
        cropStartX = w - state.lastVerifiedPageWidth;
      } else {
        cropStartX = 0;
      }
    } else {
      state.lastVerifiedPageWidth = w - cropStartX;
    }

    const outW = w - cropStartX;
    const outCanvas = DOC.createElement('canvas');
    outCanvas.width = outW;
    outCanvas.height = h;
    const outCtx = outCanvas.getContext('2d', { alpha: false });
    outCtx.fillStyle = '#ffffff';
    outCtx.fillRect(0, 0, outW, h);
    outCtx.drawImage(leftCanvas, cropStartX, 0, outW, h, 0, 0, outW, h);
    return outCanvas;
  }

  // 2. Xử lý Nửa Trang Phải
  function cropRightHalf(rightCanvas, h) {
    const w = rightCanvas.width;
    const ctx = rightCanvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;

    let lastNonBlackX = -1;
    for (let x = w - 1; x >= 0; x--) {
      if (!isColumnPureBlack(x, w, h, data)) {
        lastNonBlackX = x;
        break;
      }
    }

    let cropEndX = w - 1;
    let isValid = false;

    if (lastNonBlackX !== -1) {
      const candidateX = lastNonBlackX - 1; // Bỏ cột mờ (-1)
      const pageW = candidateX + 1;
      if (pageW >= Math.floor(w * 0.4) && pageW <= w) {
        cropEndX = candidateX;
        isValid = true;
      }
    }

    if (!isValid) {
      if (state.lastVerifiedPageWidth && state.lastVerifiedPageWidth <= w) {
        cropEndX = state.lastVerifiedPageWidth - 1;
      } else {
        cropEndX = w - 1;
      }
    } else {
      state.lastVerifiedPageWidth = Math.max(state.lastVerifiedPageWidth || 0, cropEndX + 1);
    }

    const outW = cropEndX + 1;
    const outCanvas = DOC.createElement('canvas');
    outCanvas.width = outW;
    outCanvas.height = h;
    const outCtx = outCanvas.getContext('2d', { alpha: false });
    outCtx.fillStyle = '#ffffff';
    outCtx.fillRect(0, 0, outW, h);
    outCtx.drawImage(rightCanvas, 0, 0, outW, h, 0, 0, outW, h);
    return outCanvas;
  }

  // 3. Xử lý Trang Bìa / Trang Đơn
  function cropSingleCoverPage(srcCanvas, h) {
    const w = srcCanvas.width;
    const ctx = srcCanvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;

    let firstNonBlackX = 0;
    for (let x = 0; x < w; x++) {
      if (!isColumnPureBlack(x, w, h, data)) {
        firstNonBlackX = x;
        break;
      }
    }

    let lastNonBlackX = w - 1;
    for (let x = w - 1; x >= firstNonBlackX; x--) {
      if (!isColumnPureBlack(x, w, h, data)) {
        lastNonBlackX = x;
        break;
      }
    }

    const startX = Math.min(w - 1, firstNonBlackX + 1);
    const endX = Math.max(startX, lastNonBlackX - 1);
    const outW = endX - startX + 1;

    if (outW < CONFIG.MIN_IMAGE_DIM) return srcCanvas;

    const outCanvas = DOC.createElement('canvas');
    outCanvas.width = outW;
    outCanvas.height = h;
    const outCtx = outCanvas.getContext('2d', { alpha: false });
    outCtx.fillStyle = '#ffffff';
    outCtx.fillRect(0, 0, outW, h);
    outCtx.drawImage(srcCanvas, startX, 0, outW, h, 0, 0, outW, h);
    return outCanvas;
  }

  async function processAndSplitCanvas(srcCanvas, useJpeg) {
    const w = srcCanvas.width;
    const h = srcCanvas.height;
    const results = [];
    const mimeType = useJpeg ? 'image/jpeg' : 'image/png';
    const quality = useJpeg ? 0.95 : undefined;

    // Đo sơ bộ bề rộng nét vẽ
    const ctx = srcCanvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    let minX = 0, maxX = w - 1;
    for (let x = 0; x < w; x++) {
      if (!isColumnPureBlack(x, w, h, data)) { minX = x; break; }
    }
    for (let x = w - 1; x >= minX; x--) {
      if (!isColumnPureBlack(x, w, h, data)) { maxX = x; break; }
    }
    const contentW = maxX - minX + 1;
    const contentRatio = contentW / h;

    if (contentRatio >= 1.05) {
      // 1. TRANG ĐÔI: Dò vạch phân chia tương phản (hoặc chia đôi tâm W/2)
      const splitX = findContrastSeamX(srcCanvas, 25, 25);

      const leftRawCanvas = DOC.createElement('canvas');
      leftRawCanvas.width = splitX;
      leftRawCanvas.height = h;
      const lCtx = leftRawCanvas.getContext('2d', { alpha: false });
      lCtx.drawImage(srcCanvas, 0, 0, splitX, h, 0, 0, splitX, h);

      const rightRawCanvas = DOC.createElement('canvas');
      rightRawCanvas.width = w - splitX;
      rightRawCanvas.height = h;
      const rCtx = rightRawCanvas.getContext('2d', { alpha: false });
      rCtx.drawImage(srcCanvas, splitX, 0, w - splitX, h, 0, 0, w - splitX, h);

      const rightFinalCanvas = cropRightHalf(rightRawCanvas, h);
      const leftFinalCanvas = cropLeftHalf(leftRawCanvas, h);

      const rightBlob = await new Promise(res => rightFinalCanvas.toBlob(res, mimeType, quality));
      const leftBlob = await new Promise(res => leftFinalCanvas.toBlob(res, mimeType, quality));

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
      // 2. TRANG ĐƠN (Trang bìa): Xén 2 bên mép, KHÔNG CẮT ĐÔI
      const singleFinalCanvas = cropSingleCoverPage(srcCanvas, h);
      const blob = await new Promise(res => singleFinalCanvas.toBlob(res, mimeType, quality));
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

    // Chỉ bắt đúng canvas hoặc ảnh trang truyện của Kindle (loại bỏ quảng cáo/popup cuối sách)
    const elements = Array.from(container.querySelectorAll('.kg-full-page-img img, img[src^="blob:"], #bookContainer canvas, .kw-rd-view canvas'));
    const visibleElements = [];

    const viewW = WIN.innerWidth;
    const viewH = WIN.innerHeight;

    for (const el of elements) {
      // Bỏ qua các phần tử thuộc popup quảng cáo/gợi ý cuối sách
      if (el.closest('.sponsored, [class*="recommend"], [class*="ad-"], #kr-end-actions-container')) continue;

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

        // Luôn chuyển sang Canvas 2D mới để sao chép chuẩn 100% (bất kể WebGL hay IMG)
        const rawCanvas = DOC.createElement('canvas');
        const elemW = item.el.naturalWidth || item.el.width || item.w;
        const elemH = item.el.naturalHeight || item.el.height || item.h;
        rawCanvas.width = elemW;
        rawCanvas.height = elemH;

        const ctx = rawCanvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, elemW, elemH);
        ctx.drawImage(item.el, 0, 0, elemW, elemH);

        const splitPages = await processAndSplitCanvas(rawCanvas, useJpeg);
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
    setTimeout(() => WIN.URL.revokeObjectURL(url), 60000);
  }

  /* =========================================================================
   * 4. GIAO DIỆN UI (TÔNG MÀU CAM AMAZON #f97316)
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
    if (state.ui || !DOC.body || DOC.getElementById("amazon-dl-panel")) return;

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
      "background:#f97316",
      "cursor:pointer",
      "transition:opacity 0.15s, background 0.15s",
      `opacity:${isCollapsed ? "1" : "0"}`,
      `pointer-events:${isCollapsed ? "auto" : "none"}`
    ].join(';');
    collapsedStrip.title = "Mở bảng tải";
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
   * 5. CHƯƠNG TRÌNH TẢI CHÍNH (CHẠY TRÊN TAB CHÍNH + AUTO FULLSCREEN)
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
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

    // 1. Tự động chuyển Fullscreen (nếu chưa bật)
    await handleFullscreenStart();

    const useJpeg = Boolean(state.convertJpeg);
    const zip = new PureZipWriter();
    const hashesSet = new Set();
    let savedCount = 0;

    try {
      const asin = getAsin();
      zip.addFile(`${asin}.txt`, new Uint8Array(0));

      // 2. Quay về trang đầu (tự động khóa chuột sau khi về trang 1)
      await ensureAtPage1();

      // 3. Reset bộ đệm
      hashesSet.clear();
      savedCount = 0;
      state.lastVerifiedPageWidth = 0;
      await sleep(CONFIG.RENDER_WAIT_MS + 200);

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

        // ĐÃ ĐẾN TRANG CUỐI CÙNG -> THOÁT NGAY ĐỂ ĐÓNG GÓI, KHÔNG LẬT TIẾP VÀO POPUP QUẢNG CÁO
        if (curInfo.current >= totalPages) {
          break;
        }

        const hasNext = await stepToNextPage();
        // Nếu không thể lật tiếp và đang ở trang áp chót/trang cuối
        if (!hasNext && curInfo.current >= totalPages - 1) {
          // Chụp vét lần cuối rồi thoát
          const lastImages = await captureActivePageElements(useJpeg);
          for (const imgObj of lastImages) {
            const hash = calculateBufferHash(imgObj.uint8Array);
            if (!hashesSet.has(hash)) {
              hashesSet.add(hash);
              savedCount++;
              zip.addFile(`${savedCount}.${imgObj.ext}`, imgObj.uint8Array);
            }
          }
          break;
        }

        await sleep(CONFIG.RENDER_WAIT_MS);
      }

      if (savedCount === 0) {
        throw new Error("Không thể bóc tách trang truyện.");
      }

      updateProgressUI({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(60);

      const zipBlob = zip.generateBlob();
      const zipFileName = `${getCleanTitle()}.zip`;
      triggerDownload(zipBlob, zipFileName);

      updateProgressUI({ completed: totalPages, total: totalPages, status: "Hoàn tất." });

    } catch (err) {
      const msg = err?.message || String(err);
      updateProgressUI({ status: "Lỗi: " + msg });
      console.error("[amazon-dl] Download failed:", err);
    } finally {
      // 1. Đưa người dùng về lại trang cũ
      try {
        await jumpToPage(initialPage);
      } catch (e) {}

      // 2. Mở khóa chuột
      setInteractionLock(false);

      // 3. Thoát Fullscreen (nếu ban đầu chưa bật)
      await handleFullscreenEnd();

      state.running = false;
      setUiBusy(false);
      updateProgressUI(state.lastProgress);
    }
  }

  /* =========================================================================
   * 6. KHỞI TẠO VÀ BOOT
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) {
      await sleep(100);
    }
    createUI();
    updateProgressUI({ completed: 0, total: 0, status: "Đang kiểm tra..." });

    let retries = 0;
    while (retries < 50) {
      const info = getPageInfo();
      if (info.total > 0) {
        updateProgressUI({
          completed: 0,
          total: info.total,
          status: "Sẵn sàng."
        });
        return;
      }
      await sleep(200);
      retries++;
    }
  }

  if (DOC.readyState === "loading") {
    DOC.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();