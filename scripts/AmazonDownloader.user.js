// ==UserScript==
// @name         Amazon Kindle Manga Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      2.0.0
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
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function amazonKindleMangaUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG AMAZON KINDLE
   * ========================================================================= */
  const CONFIG = {
    RENDER_WAIT_MS: 480, // Thời gian chờ Kindle vẽ xong trang ảnh (ms)
    MIN_IMAGE_DIM: 300,  // Kích thước tối thiểu (px) để lọc bỏ icon UI
    JPEG_QUALITY: 0.95   // Chất lượng xuất JPG nếu chọn
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("amazon-dl:convert-jpeg") === '1',
    lastVerifiedPageWidth: 0,
    ui: null
  };

  /* =========================================================================
   * 1. GIAO DIỆN UNIVERSAL UI CHUẨN 2 TẦNG
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "amazon-dl",
        title: "Kindle",
        engine: "AMAZON",
        themeColor: "#f97316",
        themeBg: "#1c1917",
        titleColor: "#fdba74",
        topOffset: "97px",
        defaultJpgText: "Xuất file JPG (mặc định PNG)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("amazon-dl:convert-jpeg", checked ? '1' : '0');
        }
      };

      state.ui = createUI(uiConfig);

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
   * 2. BỘ HỖ TRỢ XỬ LÝ CHUỖI & TÊN FILE CHUẨN
   * ========================================================================= */
  function getAsin() {
    try {
      const match = WIN.location.pathname.match(/\/manga\/([A-Z0-9]{10})/i);
      if (match && match[1]) return match[1];
    } catch (e) {}
    return "AMAZON_MANGA";
  }

  function isEpisodeUrl() {
    return /\/manga\/[A-Z0-9]{10}/i.test(WIN.location.pathname);
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
      const titleEl = DOC.getElementById('readerChromeTitle') || DOC.querySelector('.kw-rd-chrome-book-title');
      if (titleEl && titleEl.textContent) {
        let t = cleanString(titleEl.textContent);
        if (t) return t;
      }
    } catch (e) {}

    try {
      let title = DOC.title || "";
      title = title.replace(/^Kindle\s*-\s*/i, '');
      title = title.split('｜')[0].split('|')[0].trim();
      let t = cleanString(title);
      if (t) return t;
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
    const ui = getUI();
    if (ui) ui.updateProgress({ status: "Đang về trang đầu..." });
    setInteractionLock(false);

    let retries = 0;
    while (retries < 35) {
      const curInfo = getPageInfo();
      if (curInfo.current === 1) {
        if (ui) ui.updateProgress({ status: "Đang tải..." });
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
      const candidateX = firstNonBlackX + 1;
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
      const candidateX = lastNonBlackX - 1;
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
    const quality = useJpeg ? CONFIG.JPEG_QUALITY : undefined;

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
      // 1. TRANG ĐÔI: Dò seam tương phản và xén mép riêng từng nửa
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
      // 2. TRANG ĐƠN (Bìa): Xén 2 mép ngoài, không cắt đôi
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

    const elements = Array.from(container.querySelectorAll('.kg-full-page-img img, img[src^="blob:"], #bookContainer canvas, .kw-rd-view canvas'));
    const visibleElements = [];

    const viewW = WIN.innerWidth;
    const viewH = WIN.innerHeight;

    for (const el of elements) {
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

  /* =========================================================================
   * 4. TIẾN TRÌNH TẢI CHÍNH (AUTO FULLSCREEN + ĐÓNG GÓI ZIP)
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    const initialInfo = getPageInfo();
    const initialPage = initialInfo.current || 1;
    const totalPages = initialInfo.total;

    if (!totalPages) {
      if (ui) ui.updateProgress({ status: "Lỗi: Không lấy được số trang." });
      return;
    }

    state.running = true;
    if (ui) ui.setBusy(true);

    // 1. Tự động chuyển Fullscreen để đạt độ phân giải tối đa
    await handleFullscreenStart();

    const useJpeg = Boolean(state.convertJpeg);
    const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
    const zip = new ZipClass();
    const hashesSet = new Set();
    let savedCount = 0;

    try {
      const asin = getAsin();
      zip.addFile(`${asin}.txt`, new Uint8Array(0));

      // 2. Quay về trang đầu
      await ensureAtPage1();

      hashesSet.clear();
      savedCount = 0;
      state.lastVerifiedPageWidth = 0;
      await sleep(CONFIG.RENDER_WAIT_MS + 200);

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

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

        if (ui) {
          ui.updateProgress({
            completed: Math.min(curInfo.current, totalPages),
            total: totalPages,
            status: "Đang tải..."
          });
        }

        if (curInfo.current >= totalPages) {
          break;
        }

        const hasNext = await stepToNextPage();
        if (!hasNext && curInfo.current >= totalPages - 1) {
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

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(60);

      const zipName = `${getCleanTitle()}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });

    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || String(err)) });
      console.error("[amazon-dl] Download failed:", err);
    } finally {
      try {
        await jumpToPage(initialPage);
      } catch (e) {}

      setInteractionLock(false);
      await handleFullscreenEnd();

      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * 5. KHỞI CHẠY VÀ THEO DÕI SPA
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(100);
    const ui = getUI();

    if (!isEpisodeUrl()) {
      if (ui?.panel) ui.panel.style.display = "none";
      return;
    }

    if (ui?.panel) ui.panel.style.display = "block";
    if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });

    let retries = 0;
    while (retries < 50) {
      const info = getPageInfo();
      if (info.total > 0) {
        if (ui) {
          ui.updateProgress({
            completed: 0,
            total: info.total,
            status: "Sẵn sàng."
          });
        }
        return;
      }
      await sleep(200);
      retries++;
    }

    if (ui) ui.updateProgress({ status: "Sẵn sàng." });
  }

  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute(() => {
      state.running = false;
      state.lastVerifiedPageWidth = 0;
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