// ==UserScript==
// @name         GigaViewer Inspector
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      2.0.0
// @description  Inspector soi ma trận và đối chiếu ảnh gốc CDN vs Giải mã cho 25+ web GigaViewer.
// @author       anonymous & AI
// @match        https://shonenjumpplus.com/*
// @match        https://tonarinoyj.jp/*
// @match        https://www.sunday-webry.com/*
// @match        https://sunday-webry.com/*
// @match        https://comic-days.com/*
// @match        https://kuragebunch.com/*
// @match        https://magcomi.com/*
// @match        https://comic-gardo.com/*
// @match        https://comic-zenon.com/*
// @match        https://comic-action.com/*
// @match        https://andsofa.com/*
// @match        https://morningtwo.com/*
// @match        https://getsumagakichi.com/*
// @match        https://bibliosirius.com/*
// @match        https://comicbunch-kai.com/*
// @match        https://feelweb.jp/*
// @match        https://comic-earthstar.com/*
// @match        https://comicborder.com/*
// @match        https://comic-ogyaaa.com/*
// @match        https://comic-seasons.com/*
// @match        https://comic-y-ours.com/*
// @match        https://ichicomi.com/*
// @match        https://mangatime-square.com/*
// @match        https://ourfeel.jp/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-start
//
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/InspectorUI.js
// ==/UserScript==

(function gigaViewerInspector() {
  'use strict';
  const WIN = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const DOC = WIN.document;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  if (WIN.top !== WIN.self) return;

  function descrambleGigaViewer(img) {
    const w = img.naturalWidth, h = img.naturalHeight;
    const cellW = Math.floor(w / 32) * 8, cellH = Math.floor(h / 32) * 8;
    const gridW = cellW * 4, gridH = cellH * 4;
    const dummyW = w - gridW, dummyH = h - gridH;

    // 1. visualCanvas (Soi Live: Viền Cyan toàn ảnh + Khung Hồng ma trận 4x4)
    const visualCanvas = DOC.createElement('canvas');
    visualCanvas.width = w; visualCanvas.height = h;
    const vCtx = visualCanvas.getContext('2d', { alpha: false });
    vCtx.imageSmoothingEnabled = false;
    vCtx.fillStyle = '#ffffff';
    vCtx.fillRect(0, 0, w, h);
    for (let e = 0; e < 16; e++) {
      vCtx.drawImage(img, (e % 4) * cellW, Math.floor(e / 4) * cellH, cellW, cellH, Math.floor(e / 4) * cellW, (e % 4) * cellH, cellW, cellH);
    }
    if (dummyW > 0) vCtx.drawImage(img, gridW, 0, dummyW, h, gridW, 0, dummyW, h);
    if (dummyH > 0) vCtx.drawImage(img, 0, gridH, w, dummyH, 0, gridH, w, dummyH);

    // Khung Hồng nét liền bao quanh vùng ma trận 4x4 (nếu có dải dư)
    if (dummyW > 0 || dummyH > 0) {
      vCtx.strokeStyle = '#ff007f';
      vCtx.lineWidth = 2;
      vCtx.strokeRect(0, 0, gridW, gridH);
    }
    // Viền Cyan nét liền bao quanh toàn bộ tranh
    vCtx.strokeStyle = '#00ffff';
    vCtx.lineWidth = 4;
    vCtx.strokeRect(0, 0, w, h);

    // 2. sharpCanvas (Xuất file sạch 100%)
    const sharpCanvas = DOC.createElement('canvas');
    sharpCanvas.width = w; sharpCanvas.height = h;
    const sCtx = sharpCanvas.getContext('2d', { alpha: false });
    sCtx.imageSmoothingEnabled = false;
    sCtx.fillStyle = '#ffffff';
    sCtx.fillRect(0, 0, w, h);
    for (let e = 0; e < 16; e++) {
      sCtx.drawImage(img, (e % 4) * cellW, Math.floor(e / 4) * cellH, cellW, cellH, Math.floor(e / 4) * cellW, (e % 4) * cellH, cellW, cellH);
    }
    if (dummyW > 0) sCtx.drawImage(img, gridW, 0, dummyW, h, gridW, 0, dummyW, h);
    if (dummyH > 0) sCtx.drawImage(img, 0, gridH, w, dummyH, 0, gridH, w, dummyH);

    const dummyText = (dummyW > 0 || dummyH > 0)
      ? `Mép giữ nguyên: ${dummyW}px phải, ${dummyH}px đáy (Không xáo trộn)`
      : `Khớp ma trận 100% (Không có phần dư)`;

    return { rawW: w, rawH: h, gridW, gridH, dummyText, visualCanvas, sharpCanvas, img };
  }

  async function boot() {
    while (!DOC.body) await sleep(50);
    let pages = [];
    for (let i = 0; i < 35; i++) {
      const el = DOC.getElementById('episode-json') || DOC.getElementById('volume-json') || DOC.querySelector('script[id$="-json"]');
      if (el) {
        let raw = el.getAttribute('data-value') || el.textContent || '';
        if (raw.includes('&quot;') || raw.includes('&amp;')) {
          const txt = DOC.createElement('textarea'); txt.innerHTML = raw; raw = txt.value;
        }
        try {
          const json = JSON.parse(raw);
          const readable = json.readableProduct || json.episode || json.volume || json.trial || {};
          const rPages = readable.pageStructure?.pages || json.pageStructure?.pages || json.pages || [];
          if (rPages.length) { pages = rPages.filter(p => (p.src || p.image?.src || p.url)); break; }
        } catch(e){}
      }
      await sleep(150);
    }
    if (!pages.length) return;

    const createUI = window.createInspectorUI || globalThis.createInspectorUI;
    createUI({
      title: "GIGAVIEWER INSPECTOR",
      totalPages: pages.length,
      onPreview: async (pNo, onSuccess, onError) => {
        const pageObj = pages[pNo - 1];
        if (!pageObj) return onError("Trang không tồn tại!");
        try {
          let src = pageObj.src || pageObj.image?.src || pageObj.url || '';
          if (src.startsWith('//')) src = 'https:' + src;

          const Utils = window.MangaUtils || globalThis.MangaUtils;
          const rawBuf = await Utils.fetchBuffer(src);
          const ext = Utils.detectExt(rawBuf);
          const mime = Utils.detectMimeType(rawBuf);
          const img = await Utils.loadImage(rawBuf, mime);
          const res = descrambleGigaViewer(img);

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
            let src = pageObj.src || pageObj.image?.src || pageObj.url || '';
            if (src.startsWith('//')) src = 'https:' + src;

            const rawBuf = await Utils.fetchBuffer(src);
            const ext = Utils.detectExt(rawBuf);
            const mime = Utils.detectMimeType(rawBuf);
            const img = await Utils.loadImage(rawBuf, mime);
            const res = descrambleGigaViewer(img);

            const a1 = DOC.createElement('a'); a1.href = URL.createObjectURL(new Blob([rawBuf], { type: mime }));
            a1.download = `GigaViewer_Trang_${pNo}_raw.${ext}`; a1.click();

            const a2 = DOC.createElement('a');
            a2.href = URL.createObjectURL(await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality)));
            a2.download = `GigaViewer_Trang_${pNo}_decoded.${fmt}`; a2.click();

            statusText.textContent = `✅ Đã tải xong 2 bản trang ${pNo}!`;
          } else {
            const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
            const zip = new ZipClass();

            for (let i = 0; i < pageArray.length; i++) {
              const pNo = pageArray[i];
              statusText.textContent = `Đang giải mã: ${i + 1}/${pageArray.length} (Trang ${pNo})...`;
              const pageObj = pages[pNo - 1];
              let src = pageObj.src || pageObj.image?.src || pageObj.url || '';
              if (src.startsWith('//')) src = 'https:' + src;

              const rawBuf = await Utils.fetchBuffer(src);
              const ext = Utils.detectExt(rawBuf);
              const mime = Utils.detectMimeType(rawBuf);
              const img = await Utils.loadImage(rawBuf, mime);
              const res = descrambleGigaViewer(img);

              const sharpBlob = await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality));
              zip.addFile(`1_raw/${pNo}.${ext}`, new Uint8Array(rawBuf));
              zip.addFile(`2_decoded/${pNo}.${fmt}`, new Uint8Array(await sharpBlob.arrayBuffer()));
            }

            statusText.textContent = `Đang đóng gói file ZIP...`;
            await sleep(60);
            zip.download(`GigaViewer_Compare_${pageArray[0]}-${pageArray[pageArray.length - 1]}.zip`);
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