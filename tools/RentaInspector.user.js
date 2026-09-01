// ==UserScript==
// @name         Renta! Inspector
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      2.1.0
// @description  Inspector soi ma trận 49 mảnh (7x7) và đối chiếu ảnh gốc vs giải mã cho Renta! DRE Viewer (Tích hợp bẻ khóa F12/Ctrl+R/Input).
// @author       anonymous & AI
// @match        https://dre-viewer.papy.co.jp/sc/view_jsimg5/*
// @match        https://*.papy.co.jp/*
// @match        https://renta.papy.co.jp/*
// @match        https://*.ebookrenta.com/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-start
//
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/InspectorUI.js
// ==/UserScript==

(function rentaInspector() {
  'use strict';
  const WIN = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const DOC = WIN.document;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  if (WIN.top !== WIN.self) return;

  /* =========================================================================
   * BỘ KHIÊN BẺ KHÓA PHÍM & MỞ QUYỀN GÕ TEXT (HOTKEY & INPUT UNLOCKER)
   * ========================================================================= */
  (function unlockKeyboardAndDevTools() {
    function shieldHandler(e) {
      const target = e.target;

      // 1. MỞ KHÓA GÕ PHÍM: Nếu đang click hoặc focus vào bất kỳ ô input / UI nào
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.closest('#manga-inspector-root') || target.closest('[id*="inspector"]'))) {
        e.stopImmediatePropagation();
        return; // Cho phép trình duyệt gõ chữ bình thường
      }

      // 2. MỞ KHÓA DEVTOOLS & RELOAD: F12, Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+R, F5
      const isDevTools = e.key === 'F12' || 
                        ((e.ctrlKey || e.metaKey) && e.shiftKey && ['i', 'I', 'j', 'J', 'c', 'C'].includes(e.key)) ||
                        ((e.altKey || e.metaKey) && ['i', 'I'].includes(e.key));
      const isReload = e.key === 'F5' || ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R'));

      if (isDevTools || isReload) {
        e.stopImmediatePropagation(); // Tước quyền chặn của Renta, trả lại quyền cho trình duyệt
      }
    }

    // Cài đặt ở Capture Phase (chạy trước mọi listener của Renta)
    WIN.addEventListener('keydown', shieldHandler, true);
    WIN.addEventListener('keyup', shieldHandler, true);
    WIN.addEventListener('keypress', shieldHandler, true);
    WIN.addEventListener('contextmenu', (e) => {
      if (e.target?.closest('#manga-inspector-root')) e.stopImmediatePropagation();
    }, true);
  })();

  const CONFIG = {
    PAGE_WAIT_TIMEOUT_MS: 40000,
    POLL_INTERVAL_MS: 100
  };

  /* =========================================================================
   * 1. KIỂM TRA RUNTIME DRE VIEWER & NẠP DỮ LIỆU TRANG TRONG RAM
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

  function preloadNearbyPages(currentPage, maxPage) {
    const limit = Math.min(maxPage, currentPage + 2);
    for (let p = currentPage + 1; p <= limit; p++) {
      if (!WIN.arChara?.[p] && typeof WIN.getImageData === 'function') {
        try { WIN.getImageData(p); } catch(e) {}
      }
    }
  }

  async function ensurePageData(pageNo) {
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
      while (Date.now() - start < CONFIG.PAGE_WAIT_TIMEOUT_MS) {
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
   * 2. GIẢI MÃ MA TRẬN 49 MẢNH VÀ TÁI TẠO ĐỒ HỌA THEO TAXONOMY NHÓM 2
   * ========================================================================= */
  function descrambleRentaInspector(pageNo) {
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

    const gridW = tileW * split;
    const gridH = tileH * split;
    const canvasW = Number(chara.mWidth) || (diffWVal + gridW);
    const canvasH = Number(chara.mHeight) || (diffHVal + gridH);

    // -------------------------------------------------------------
    // 1. sharpCanvas (Bản giải mã sạch 100% xuất file)
    // -------------------------------------------------------------
    const sharpCanvas = DOC.createElement('canvas');
    sharpCanvas.width = canvasW;
    sharpCanvas.height = canvasH;
    const sCtx = sharpCanvas.getContext('2d', { alpha: false });
    sCtx.imageSmoothingEnabled = false;
    sCtx.mozImageSmoothingEnabled = false;
    sCtx.webkitImageSmoothingEnabled = false;
    sCtx.msImageSmoothingEnabled = false;
    sCtx.fillStyle = '#ffffff';
    sCtx.fillRect(0, 0, canvasW, canvasH);

    if (diffWVal > 0 || diffHVal > 0) {
      if (diffWVal > 0 && diffHVal === 0) {
        sCtx.drawImage(diffW, 0, 0, diffWVal, canvasH, 0, 0, diffWVal, canvasH);
      } else if (diffWVal === 0 && diffHVal > 0) {
        sCtx.drawImage(diffH, 0, 0, canvasW, diffHVal, 0, 0, canvasW, diffHVal);
      } else {
        let diffWOffset = diffWVal;
        if (diffWVal + gridW === diffHVal) diffWOffset = 0;
        sCtx.drawImage(diffW, 0, 0, diffWVal, canvasH, 0, 0, diffWVal, canvasH);
        sCtx.drawImage(diffH, 0, 0, canvasW, diffHVal, diffWOffset, 0, canvasW, diffHVal);
      }
    }

    for (let i = 0; i < totalTiles; i++) {
      const tileImg = chara.img[i];
      const pos = chara.didx[i]; // [cột, dòng]
      const dx = Number(pos[0]) * tileW + diffWVal;
      const dy = Number(pos[1]) * tileH + diffHVal;
      sCtx.drawImage(tileImg, 0, 0, tileW, tileH, dx, dy, tileW, tileH);
    }

    // -------------------------------------------------------------
    // 2. visualCanvas (Soi Live: Viền Cyan toàn ảnh + Khung Hồng vùng 7x7)
    // -------------------------------------------------------------
    const visualCanvas = DOC.createElement('canvas');
    visualCanvas.width = canvasW;
    visualCanvas.height = canvasH;
    const vCtx = visualCanvas.getContext('2d', { alpha: false });
    vCtx.imageSmoothingEnabled = false;
    vCtx.drawImage(sharpCanvas, 0, 0);

    // Khung Hồng nét liền bao quanh vùng ma trận 7x7 xáo trộn
    if (diffWVal > 0 || diffHVal > 0) {
      vCtx.strokeStyle = '#ff007f';
      vCtx.lineWidth = 2;
      vCtx.strokeRect(diffWVal, diffHVal, gridW, gridH);
    }

    // Viền Cyan nét liền 4px bao quanh toàn bộ bức tranh
    vCtx.strokeStyle = '#00ffff';
    vCtx.lineWidth = 4;
    vCtx.strokeRect(0, 0, canvasW, canvasH);

    // -------------------------------------------------------------
    // 3. rawCanvas (Ảnh thô xáo trộn ban đầu trước khi xếp lại)
    // -------------------------------------------------------------
    const rawCanvas = DOC.createElement('canvas');
    rawCanvas.width = canvasW;
    rawCanvas.height = canvasH;
    const rCtx = rawCanvas.getContext('2d', { alpha: false });
    rCtx.imageSmoothingEnabled = false;
    rCtx.fillStyle = '#ffffff';
    rCtx.fillRect(0, 0, canvasW, canvasH);

    if (diffWVal > 0 || diffHVal > 0) {
      if (diffWVal > 0 && diffHVal === 0) {
        rCtx.drawImage(diffW, 0, 0, diffWVal, canvasH, 0, 0, diffWVal, canvasH);
      } else if (diffWVal === 0 && diffHVal > 0) {
        rCtx.drawImage(diffH, 0, 0, canvasW, diffHVal, 0, 0, canvasW, diffHVal);
      } else {
        let diffWOffset = diffWVal;
        if (diffWVal + gridW === diffHVal) diffWOffset = 0;
        rCtx.drawImage(diffW, 0, 0, diffWVal, canvasH, 0, 0, diffWVal, canvasH);
        rCtx.drawImage(diffH, 0, 0, canvasW, diffHVal, diffWOffset, 0, canvasW, diffHVal);
      }
    }

    for (let i = 0; i < totalTiles; i++) {
      const tileImg = chara.img[i];
      const rawCol = i % split;
      const rawRow = Math.floor(i / split);
      const rx = rawCol * tileW + diffWVal;
      const ry = rawRow * tileH + diffHVal;
      rCtx.drawImage(tileImg, 0, 0, tileW, tileH, rx, ry, tileW, tileH);
    }

    const dummyText = (diffWVal > 0 || diffHVal > 0)
      ? `Mép giữ nguyên: ${diffWVal}px ngang, ${diffHVal}px dọc (Không xáo trộn)`
      : `Khớp 100% không có viền thừa`;

    return {
      rawW: canvasW,
      rawH: canvasH,
      gridW: gridW,
      gridH: gridH,
      dummyText: dummyText,
      sharpCanvas: sharpCanvas,
      visualCanvas: visualCanvas,
      rawCanvas: rawCanvas,
      img: rawCanvas,
      rawExt: "JPG"
    };
  }

  /* =========================================================================
   * 3. KHỞI CHẠY GIAO DIỆN INSPECTORUI
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(50);

    let maxPage = 0;
    for (let i = 0; i < 35; i++) {
      if (isRuntimeReady()) {
        maxPage = Number(WIN.max_page);
        break;
      }
      await sleep(150);
    }
    if (!maxPage || maxPage <= 0) return;

    const isEnglish = WIN.location.hostname.includes("ebookrenta.com");
    const inspectorTitle = isEnglish ? "RENTA! GLOBAL INSPECTOR" : "RENTA! INSPECTOR";

    const createUI = window.createInspectorUI || globalThis.createInspectorUI;
    createUI({
      title: inspectorTitle,
      totalPages: maxPage,
      onPreview: async (pNo, onSuccess, onError) => {
        try {
          preloadNearbyPages(pNo, maxPage);
          await ensurePageData(pNo);
          const res = descrambleRentaInspector(pNo);
          onSuccess(res, pNo);
        } catch (e) {
          onError(e?.message || String(e));
        }
      },
      onDownload: async (pageArray, fmt, quality, statusText, btn) => {
        btn.disabled = true;
        try {
          const mimeType = fmt === 'png' ? 'image/png' : (fmt === 'webp' ? 'image/webp' : 'image/jpeg');

          if (pageArray.length === 1) {
            const pNo = pageArray[0];
            await ensurePageData(pNo);
            const res = descrambleRentaInspector(pNo);

            const rawBlob = await new Promise(r => res.rawCanvas.toBlob(r, 'image/jpeg', 0.98));
            const sharpBlob = await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality));

            const a1 = DOC.createElement('a');
            a1.href = URL.createObjectURL(rawBlob);
            a1.download = `Renta_Trang_${pNo}_raw.jpg`;
            a1.click();

            const a2 = DOC.createElement('a');
            a2.href = URL.createObjectURL(sharpBlob);
            a2.download = `Renta_Trang_${pNo}_decoded.${fmt}`;
            a2.click();

            statusText.textContent = `✅ Đã tải xong 2 bản trang ${pNo}!`;
          } else {
            const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
            const zip = new ZipClass();

            for (let i = 0; i < pageArray.length; i++) {
              const pNo = pageArray[i];
              statusText.textContent = `Đang giải mã: ${i + 1}/${pageArray.length} (Trang ${pNo})...`;
              preloadNearbyPages(pNo, maxPage);

              await ensurePageData(pNo);
              const res = descrambleRentaInspector(pNo);

              const rawBlob = await new Promise(r => res.rawCanvas.toBlob(r, 'image/jpeg', 0.98));
              const sharpBlob = await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality));

              zip.addFile(`1_raw/${pNo}.jpg`, new Uint8Array(await rawBlob.arrayBuffer()));
              zip.addFile(`2_decoded/${pNo}.${fmt}`, new Uint8Array(await sharpBlob.arrayBuffer()));
            }

            statusText.textContent = `Đang đóng gói file ZIP...`;
            await sleep(60);
            zip.download(`Renta_Compare_${pageArray[0]}-${pageArray[pageArray.length - 1]}.zip`);
            statusText.textContent = `✅ Đã xuất xong file ZIP đối chiếu!`;
          }
        } catch (e) {
          statusText.textContent = `❌ ${e?.message || String(e)}`;
        } finally {
          btn.disabled = false;
        }
      }
    });
  }

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      boot();
    }
  }, 500);

  boot();
})();