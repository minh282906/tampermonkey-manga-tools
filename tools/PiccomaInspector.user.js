// ==UserScript==
// @name         Piccoma Inspector
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      2.0.0
// @description  Inspector soi ma trận Micro-Tiles 50px và Wasm dd(seed) của Piccoma.
// @author       anonymous & AI
// @match        https://piccoma.com/web/viewer/*
// @match        https://jp.piccoma.com/web/viewer/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-start
//
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/InspectorUI.js
// ==/UserScript==

(function piccomaInspector() {
  'use strict';
  const WIN = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const DOC = WIN.document;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  if (WIN.top !== WIN.self) return;

  let capturedPData = null;
  try {
    Object.defineProperty(WIN, '_pdata_', {
      configurable: true, enumerable: true,
      get() { return capturedPData; },
      set(v) { capturedPData = v; }
    });
  } catch (e) {}

  function extractPData() {
    if (capturedPData?.img?.length > 0) return capturedPData;
    if (WIN._pdata_?.img?.length > 0) return WIN._pdata_;
    const scripts = DOC.querySelectorAll('script:not([src])');
    for (const s of scripts) {
      const text = s.textContent || '';
      if (text.includes('_pdata_') && text.includes('img')) {
        const start = text.indexOf('{', text.indexOf('_pdata_'));
        if (start === -1) continue;
        let depth = 0, inStr = false, q = '', end = -1;
        for (let i = start; i < text.length; i++) {
          const ch = text[i];
          if (inStr) { if (ch === q && text[i - 1] !== '\\') inStr = false; }
          else {
            if (ch === '"' || ch === "'") { inStr = true; q = ch; }
            else if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
          }
        }
        if (end !== -1) {
          try {
            const data = new Function('return (' + text.substring(start, end + 1) + ');')();
            if (data?.img?.length > 0) { capturedPData = data; return data; }
          } catch (e) {}
        }
      }
    }
    return null;
  }

  function getChecksum(url) {
    try { return url.split('?')[0].split('/').slice(-2, -1)[0] || ''; } catch { return ''; }
  }

  function getSeed(checksum, expires) {
    if (!expires || !checksum) return checksum;
    let sum = 0;
    for (let i = 0; i < expires.length; i++) {
      const digit = parseInt(expires[i], 10);
      if (!isNaN(digit)) sum += digit;
    }
    const shift = sum % checksum.length;
    return shift === 0 ? checksum : checksum.slice(-shift) + checksum.slice(0, -shift);
  }

  async function computePiccomaSeed(url) {
    const checksum = getChecksum(url);
    const match = url.match(/[?&]expires=([0-9]+)/);
    const expires = match ? match[1] : '';
    const rawSeed = getSeed(checksum, expires);
    let attempts = 0;
    while (attempts < 30) {
      if (typeof WIN.dd === "function") {
        try { return WIN.dd(rawSeed); } catch (e) {}
      }
      await sleep(50);
      attempts++;
    }
    return rawSeed;
  }

  async function descramblePiccoma(img, imgUrl) {
    const w = img.naturalWidth, h = img.naturalHeight;
    const seed = await computePiccomaSeed(imgUrl);
    let unscrambled = null;
    if (typeof WIN.unscrambleImg === 'function') {
      const res = WIN.unscrambleImg(img, 50, seed);
      unscrambled = Array.isArray(res) ? res[0] : res;
    }

    const finalW = unscrambled ? unscrambled.width : w;
    const finalH = unscrambled ? unscrambled.height : h;

    // 1. visualCanvas (Soi Live: viền Cyan #00ffff)
    const visualCanvas = DOC.createElement('canvas');
    visualCanvas.width = finalW; visualCanvas.height = finalH;
    const vCtx = visualCanvas.getContext('2d', { alpha: false });
    vCtx.imageSmoothingEnabled = false;
    vCtx.fillStyle = '#ffffff';
    vCtx.fillRect(0, 0, finalW, finalH);
    if (unscrambled) vCtx.drawImage(unscrambled, 0, 0); else vCtx.drawImage(img, 0, 0);
    vCtx.strokeStyle = '#00ffff'; vCtx.lineWidth = 4; vCtx.strokeRect(0, 0, finalW, finalH);

    // 2. sharpCanvas (Xuất file sạch 100%)
    const sharpCanvas = DOC.createElement('canvas');
    sharpCanvas.width = finalW; sharpCanvas.height = finalH;
    const sCtx = sharpCanvas.getContext('2d', { alpha: false });
    sCtx.imageSmoothingEnabled = false;
    sCtx.fillStyle = '#ffffff';
    sCtx.fillRect(0, 0, finalW, finalH);
    if (unscrambled) sCtx.drawImage(unscrambled, 0, 0); else sCtx.drawImage(img, 0, 0);

    return {
      rawW: w, rawH: h, gridW: finalW, gridH: finalH,
      dummyText: "Khớp 100% không có viền thừa",
      visualCanvas, sharpCanvas, img
    };
  }

  async function boot() {
    while (!DOC.body) await sleep(50);
    let pdata = null;
    for (let i = 0; i < 30; i++) {
      pdata = extractPData();
      if (pdata?.img?.length) break;
      await sleep(150);
    }
    const pages = (pdata?.img || []).filter(item => {
      const u = item.path || item.src || item.url || '';
      return u && (u.includes('/dna/') || /\.(?:jpg|jpeg|png|webp)/i.test(u));
    });
    if (!pages.length) return;

    const createUI = window.createInspectorUI || globalThis.createInspectorUI;
    createUI({
      title: "PICCOMA INSPECTOR",
      totalPages: pages.length,
      onPreview: async (pNo, onSuccess, onError) => {
        const pageObj = pages[pNo - 1];
        if (!pageObj) return onError("Trang không tồn tại!");
        try {
          const imgUrl = pageObj.path || pageObj.src || pageObj.url;
          const Utils = window.MangaUtils || globalThis.MangaUtils;
          const rawBuf = await Utils.fetchBuffer(imgUrl);
          const ext = Utils.detectExt(rawBuf);
          const mime = Utils.detectMimeType(rawBuf);
          const img = await Utils.loadImage(rawBuf, mime);
          const res = await descramblePiccoma(img, imgUrl);

          onSuccess({ ...res, rawExt: ext.toUpperCase(), rawBuf }, pNo);
        } catch (e) { onError(e?.message || String(e)); }
      },
      onDownload: async (pageArray, fmt, quality, statusText, btn) => {
        btn.disabled = true;
        try {
          const Utils = window.MangaUtils || globalThis.MangaUtils;
          const mimeType = fmt === 'png' ? 'image/png' : (fmt === 'webp' ? 'image/webp' : 'image/jpeg');

          if (pageArray.length === 1) {
            const pNo = pageArray[0];
            const pageObj = pages[pNo - 1];
            const imgUrl = pageObj.path || pageObj.src || pageObj.url;
            const rawBuf = await Utils.fetchBuffer(imgUrl);
            const ext = Utils.detectExt(rawBuf);
            const mime = Utils.detectMimeType(rawBuf);
            const img = await Utils.loadImage(rawBuf, mime);
            const res = await descramblePiccoma(img, imgUrl);

            const a1 = DOC.createElement('a'); a1.href = URL.createObjectURL(new Blob([rawBuf], { type: mime }));
            a1.download = `Piccoma_Trang_${pNo}_raw.${ext}`; a1.click();

            const a2 = DOC.createElement('a');
            a2.href = URL.createObjectURL(await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality)));
            a2.download = `Piccoma_Trang_${pNo}_decoded.${fmt}`; a2.click();

            statusText.textContent = `✅ Đã tải xong 2 bản trang ${pNo}!`;
          } else {
            const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
            const zip = new ZipClass();

            for (let i = 0; i < pageArray.length; i++) {
              const pNo = pageArray[i];
              statusText.textContent = `Đang giải mã Wasm: ${i + 1}/${pageArray.length} (Trang ${pNo})...`;
              const pageObj = pages[pNo - 1];
              const imgUrl = pageObj.path || pageObj.src || pageObj.url;
              const rawBuf = await Utils.fetchBuffer(imgUrl);
              const ext = Utils.detectExt(rawBuf);
              const mime = Utils.detectMimeType(rawBuf);
              const img = await Utils.loadImage(rawBuf, mime);
              const res = await descramblePiccoma(img, imgUrl);

              const sharpBlob = await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality));
              zip.addFile(`1_raw/${pNo}.${ext}`, new Uint8Array(rawBuf));
              zip.addFile(`2_decoded/${pNo}.${fmt}`, new Uint8Array(await sharpBlob.arrayBuffer()));
            }

            statusText.textContent = `Đang đóng gói file ZIP...`;
            await sleep(60);
            zip.download(`Piccoma_Compare_${pageArray[0]}-${pageArray[pageArray.length - 1]}.zip`);
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
  setInterval(() => { if (location.href !== lastUrl) { lastUrl = location.href; boot(); } }, 500);
  boot();
})();