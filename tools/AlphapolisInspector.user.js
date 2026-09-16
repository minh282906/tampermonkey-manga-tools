// ==UserScript==
// @name         Alphapolis Inspector
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      2.0.0
// @description  Inspector soi ma trận Steganography, gọt đệm 1px và đối chiếu ảnh gốc vs giải mã cho Alphapolis.
// @author       anonymous & AI
// @match        https://www.alphapolis.co.jp/manga/*
// @match        https://alphapolis.co.jp/manga/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-start
//
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/decoders/AlphapolisTools.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/InspectorUI.js
// ==/UserScript==

(function alphapolisInspector() {
  'use strict';
  const WIN = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const DOC = WIN.document;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  if (WIN.top !== WIN.self) return;

  function isEpisodeUrl() {
    const p = location.pathname;
    return /\/manga\/(?:official\/)?\d+\/\d+/.test(p) || /\/manga\/\d+\/episode\/\d+/.test(p);
  }

  function getCookie(name) {
    const value = `; ${DOC.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return decodeURIComponent(parts.pop().split(';').shift());
    return null;
  }

  function getUrlParams() {
    const pathParts = location.pathname.split('/').filter(Boolean);
    const chapterId = parseInt(pathParts.at(-1), 10);
    let mangaId = parseInt(pathParts.at(-2), 10);

    if (pathParts.includes('episode')) {
      mangaId = parseInt(pathParts[pathParts.indexOf('episode') - 1], 10);
    }
    return { chapterId, mangaId };
  }

  async function fetchManifestData() {
    const { chapterId, mangaId } = getUrlParams();
    if (!chapterId || isNaN(chapterId)) return null;

    const xsrfToken = getCookie('XSRF-TOKEN');
    const csrfMeta = DOC.querySelector('meta[name="csrf-token"]')?.getAttribute('content');

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest'
    };
    if (xsrfToken) headers['X-XSRF-TOKEN'] = xsrfToken;
    if (csrfMeta) headers['X-CSRF-TOKEN'] = csrfMeta;

    const apiUrl = location.pathname.includes('/official/')
      ? 'https://www.alphapolis.co.jp/manga/official/viewer.json'
      : `https://www.alphapolis.co.jp${location.pathname}/viewer.json`;

    const payload = JSON.stringify({
      episode_no: chapterId,
      manga_sele_id: mangaId,
      hide_page: false,
      preview: false,
      resolution: 'full_hd'
    });

    let rawJson = null;
    try {
      const res = await WIN.fetch(apiUrl, {
        method: 'POST',
        headers: headers,
        credentials: 'include',
        body: payload
      });
      if (res.ok) rawJson = await res.json();
    } catch (e) {}

    if (!rawJson) return null;

    const imagesData = rawJson?.page?.images;
    const placeholder = rawJson?.page?.placeholder;
    if (!imagesData || !Array.isArray(imagesData)) return null;

    const Tools = WIN.AlphapolisTools || window.AlphapolisTools;
    const keys = Tools.extractKeys(placeholder);

    return imagesData.map((img, idx) => ({
      pageNo: idx + 1,
      url: img.url,
      keyBytes: keys ? keys[idx] : null
    }));
  }

  async function loadCleanBitmap(rawBuffer) {
    const Utils = WIN.MangaUtils || window.MangaUtils;
    const mime = Utils ? Utils.detectMimeType(rawBuffer) : 'image/jpeg';
    const blob = new Blob([rawBuffer], { type: mime });
    return await createImageBitmap(blob, {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none'
    });
  }

  // Worker ngầm để xuất ảnh không bị lỗi của trang
  const workerScript = `
    self.onmessage = async function(e) {
      try {
        const { buffer, keyBytes, isJpg, quality } = e.data;
        if (!keyBytes || keyBytes.byteLength < 8) {
          self.postMessage({ success: true, buffer: buffer, ext: isJpg ? 'jpg' : 'png' }, [buffer]);
          return;
        }

        const blob = new Blob([buffer]);
        const img = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
        const key = new DataView(keyBytes.buffer, keyBytes.byteOffset, keyBytes.byteLength);

        const firstValue = key.getInt32(0, true);
        const secondValue = key.getInt32(4, true);
        const tileSize = (secondValue >>> 24) & 0xFF;
        const paddingWidth = (firstValue >>> 27) & 7;

        if (tileSize === 0) {
          self.postMessage({ success: true, buffer: buffer, ext: isJpg ? 'jpg' : 'png' }, [buffer]);
          return;
        }

        const cols = Math.ceil(img.width / tileSize);
        const rows = Math.ceil(img.height / tileSize);
        const doublePadding = paddingWidth * 2;
        const baseTileSize = tileSize - doublePadding;
        const outW = img.width - (cols * doublePadding);
        const outH = img.height - (rows * doublePadding);
        const lastCol = cols - 1;
        const lastRow = rows - 1;

        const canvas = new OffscreenCanvas(outW, outH);
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.imageSmoothingEnabled = false;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, outW, outH);

        const tileCount = Math.floor(key.byteLength / 8);
        for (let idx = 0; idx < tileCount; idx++) {
          const offset = idx * 8;
          const tileConfigV = key.getInt32(offset, true);
          const tileConfigHa = key.getInt32(offset + 4, true);

          const isMirrored = (tileConfigV & 1) !== 0;
          const rotationSteps = (tileConfigV >>> 1) & 3;
          const destTop = (tileConfigV >>> 3) & 4095;
          const destLeft = (tileConfigV >>> 15) & 4095;
          const sourceRow = (tileConfigHa >>> 8) & 0xFF;
          const sourceCol = (tileConfigHa >>> 16) & 0xFF;

          const currentTileWidth = (baseTileSize !== 0 && Math.floor(destLeft / baseTileSize) === lastCol ? outW - destLeft : baseTileSize) + doublePadding;
          const currentTileHeight = (baseTileSize !== 0 && Math.floor(destTop / baseTileSize) === lastRow ? outH - destTop : baseTileSize) + doublePadding;

          const drawWidth = (rotationSteps % 2 === 1) ? currentTileHeight : currentTileWidth;
          const drawHeight = (rotationSteps % 2 === 1) ? currentTileWidth : currentTileHeight;

          const drawX = destLeft - paddingWidth;
          const drawY = destTop - paddingWidth;

          const sourceX = Math.max(0, Math.min(sourceCol * tileSize, img.width));
          const sourceY = Math.max(0, Math.min(sourceRow * tileSize, img.height));
          const cropWidth = Math.max(0, Math.min(drawWidth, img.width - sourceX));
          const cropHeight = Math.max(0, Math.min(drawHeight, img.height - sourceY));

          if (cropWidth <= 0 || cropHeight <= 0) continue;

          ctx.save();
          ctx.translate(drawX + drawWidth / 2, drawY + drawHeight / 2);
          ctx.rotate(-90 * rotationSteps * Math.PI / 180);
          if (isMirrored) ctx.scale(-1, 1);
          ctx.drawImage(img, sourceX, sourceY, cropWidth, cropHeight, -cropWidth / 2, -cropHeight / 2, cropWidth, cropHeight);
          ctx.restore();
        }

        const mimeType = isJpg ? 'image/jpeg' : 'image/png';
        const encodeOpts = { type: mimeType };
        if (isJpg) encodeOpts.quality = quality;

        const finalBlob = await canvas.convertToBlob(encodeOpts);
        const ab = await finalBlob.arrayBuffer();
        self.postMessage({ success: true, buffer: ab, ext: isJpg ? 'jpg' : 'png' }, [ab]);
      } catch (err) {
        self.postMessage({ success: false, error: err.message || String(err) });
      }
    };
  `;

  let inspectorWorkerUrl = null;
  function getInspectorWorkerUrl() {
    if (!inspectorWorkerUrl) {
      const blob = new Blob([workerScript], { type: 'application/javascript' });
      inspectorWorkerUrl = URL.createObjectURL(blob);
    }
    return inspectorWorkerUrl;
  }

  function exportCleanBlobWithWorker(rawBuffer, keyBytes, isJpg, quality) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(getInspectorWorkerUrl());
      worker.onmessage = (e) => {
        worker.terminate();
        if (e.data.success) {
          const mime = isJpg ? 'image/jpeg' : 'image/png';
          resolve({ blob: new Blob([e.data.buffer], { type: mime }), buffer: e.data.buffer, ext: e.data.ext });
        } else {
          reject(new Error(e.data.error || "Lỗi giải mã"));
        }
      };
      worker.onerror = (err) => {
        worker.terminate();
        reject(err);
      };
      worker.postMessage({ buffer: rawBuffer, keyBytes, isJpg, quality });
    });
  }

  async function descrambleAlphapolisInspector(rawBuf, pageObj) {
    const Utils = WIN.MangaUtils || window.MangaUtils;
    const Tools = WIN.AlphapolisTools || window.AlphapolisTools;

    const ext = Utils.detectExt(rawBuf);
    const img = await loadCleanBitmap(rawBuf);

    const rawW = img.width;
    const rawH = img.height;

    // 1. Tính toán ma trận lát cắt từ AlphapolisTools
    const coordsMeta = Tools.getAlphapolisCoords(rawW, rawH, pageObj.keyBytes);
    const { outW, outH, coords, isScrambled } = coordsMeta;

    // 2. sharpCanvas (Bản giải mã sạch đúng kích thước outW x outH để hiển thị)
    const sharpCanvas = DOC.createElement('canvas');
    sharpCanvas.width = outW;
    sharpCanvas.height = outH;
    const sCtx = sharpCanvas.getContext('2d', { alpha: false });
    sCtx.imageSmoothingEnabled = false;
    sCtx.mozImageSmoothingEnabled = false;
    sCtx.webkitImageSmoothingEnabled = false;
    sCtx.msImageSmoothingEnabled = false;
    sCtx.fillStyle = '#ffffff';
    sCtx.fillRect(0, 0, outW, outH);

    if (!isScrambled || !coords || coords.length === 0) {
      sCtx.drawImage(img, 0, 0);
    } else {
      for (let i = 0; i < coords.length; i++) {
        const c = coords[i];
        sCtx.save();
        sCtx.translate(c.drawX + c.drawWidth / 2, c.drawY + c.drawHeight / 2);
        sCtx.rotate(-90 * c.rotationSteps * Math.PI / 180);
        if (c.isMirrored) sCtx.scale(-1, 1);
        sCtx.drawImage(img, c.sourceX, c.sourceY, c.cropWidth, c.cropHeight, -c.cropWidth / 2, -c.cropHeight / 2, c.cropWidth, c.cropHeight);
        sCtx.restore();
      }
    }

    // 3. rawCanvas (Bản ảnh xáo trộn thô)
    const rawCanvas = DOC.createElement('canvas');
    rawCanvas.width = rawW; rawCanvas.height = rawH;
    const rCtx = rawCanvas.getContext('2d', { alpha: false });
    rCtx.imageSmoothingEnabled = false;
    rCtx.drawImage(img, 0, 0);

    // 4. visualCanvas (Khung container rawW x rawH)
    const visualCanvas = DOC.createElement('canvas');
    visualCanvas.width = rawW; visualCanvas.height = rawH;
    const vCtx = visualCanvas.getContext('2d', { alpha: false });
    vCtx.imageSmoothingEnabled = false;
    vCtx.fillStyle = '#ff007f';
    vCtx.fillRect(0, 0, rawW, rawH);
    vCtx.drawImage(sharpCanvas, 0, 0);

    // Viền Cyan 4px CHỈ vẽ ở mép ngoài cùng của toàn container (rawW x rawH)
    // Sau padding là chi tiết tranh thật, tuyệt đối KHÔNG có viền nào ngăn cách ở giữa!
    vCtx.strokeStyle = '#00ffff';
    vCtx.lineWidth = 4;
    vCtx.strokeRect(0, 0, rawW, rawH);

    const padW = rawW - outW;
    const padH = rawH - outH;
    const dummyText = (padW > 0 || padH > 0)
      ? `Vùng đệm bỏ: Dư ${padW}px phải, ${padH}px đáy (Đã gọt sạch)`
      : `Khớp 100% không có viền thừa`;

    return {
      rawW, rawH, gridW: outW, gridH: outH,
      dummyText,
      sharpCanvas, visualCanvas, rawCanvas, img,
      rawExt: ext.toUpperCase(), rawBuf,
      isScrambled
    };
  }

  /* =========================================================================
   * KHỞI CHẠY GIAO DIỆN INSPECTORUI
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(50);
    if (!isEpisodeUrl()) return;

    let pages = null;
    for (let i = 0; i < 30; i++) {
      pages = await fetchManifestData();
      if (pages && pages.length > 0) break;
      await sleep(150);
    }
    if (!pages || !pages.length) return;

    const createUI = window.createInspectorUI || globalThis.createInspectorUI;

    createUI({
      title: "ALPHAPOLIS INSPECTOR",
      totalPages: pages.length,
      onPreview: async (pNo, onSuccess, onError) => {
        const pageObj = pages[pNo - 1];
        if (!pageObj) return onError("Trang không tồn tại!");
        try {
          const Utils = WIN.MangaUtils || window.MangaUtils;
          const rawBuf = await Utils.fetchBuffer(pageObj.url);
          const res = await descrambleAlphapolisInspector(rawBuf, pageObj);
          onSuccess(res, pNo);
        } catch (e) {
          onError(e?.message || String(e));
        }
      },
      onDownload: async (pageArray, fmt, quality, statusText, btn) => {
        btn.disabled = true;
        try {
          const Utils = WIN.MangaUtils || window.MangaUtils;
          const isJpg = (fmt === 'jpg');

          if (pageArray.length === 1) {
            const pNo = pageArray[0];
            const pageObj = pages[pNo - 1];
            const rawBuf = await Utils.fetchBuffer(pageObj.url);
            const ext = Utils.detectExt(rawBuf);

            // Xuất file sạch qua Worker (tránh lỗi của trang)
            const cleanRes = await exportCleanBlobWithWorker(rawBuf, pageObj.keyBytes, isJpg, quality);

            const a1 = DOC.createElement('a'); a1.href = URL.createObjectURL(new Blob([rawBuf], { type: 'image/jpeg' }));
            a1.download = `Alphapolis_Trang_${pNo}_raw.${ext}`; a1.click();

            const a2 = DOC.createElement('a');
            a2.href = URL.createObjectURL(cleanRes.blob);
            a2.download = `Alphapolis_Trang_${pNo}_decoded.${fmt}`; a2.click();

            statusText.textContent = `✅ Đã tải xong 2 bản trang ${pNo}!`;
          } else {
            const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
            const zip = new ZipClass();

            for (let i = 0; i < pageArray.length; i++) {
              const pNo = pageArray[i];
              statusText.textContent = `Đang giải mã: ${i + 1}/${pageArray.length} (Trang ${pNo})...`;
              const pageObj = pages[pNo - 1];
              const rawBuf = await Utils.fetchBuffer(pageObj.url);
              const ext = Utils.detectExt(rawBuf);

              const cleanRes = await exportCleanBlobWithWorker(rawBuf, pageObj.keyBytes, isJpg, quality);

              zip.addFile(`1_raw/${pNo}.${ext}`, new Uint8Array(rawBuf));
              zip.addFile(`2_decoded/${pNo}.${fmt}`, new Uint8Array(cleanRes.buffer));
            }

            statusText.textContent = `Đang đóng gói file ZIP...`;
            await sleep(60);
            zip.download(`Alphapolis_Compare_${pageArray[0]}-${pageArray[pageArray.length - 1]}.zip`);
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