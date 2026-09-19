// ==UserScript==
// @name         YanJan! (YNJN) Inspector
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @description  Inspector soi ma trận chuyển vị 4x4 và tải đối chiếu 2 bản ảnh cho YanJan! (ynjn.jp).
// @author       anonymous & AI
// @match        https://ynjn.jp/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-start
//
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/InspectorUI.js
// ==/UserScript==

(function ynjnInspector() {
  'use strict';
  const WIN = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const DOC = WIN.document;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  if (WIN.top !== WIN.self) return;

  function descrambleYnjn(img, targetW, targetH) {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const outW = targetW || w;
    const outH = targetH || h;

    const pieceW = Math.floor(w / 4);
    const pieceH = Math.floor(h / 4);
    const gridW = pieceW * 4;
    const gridH = pieceH * 4;
    const dummyW = w - gridW;
    const dummyH = h - gridH;

    // 1. visualCanvas (Soi Live: Viền Cyan toàn ảnh + Khung Hồng ma trận)
    const visualCanvas = DOC.createElement('canvas');
    visualCanvas.width = outW; visualCanvas.height = outH;
    const vCtx = visualCanvas.getContext('2d', { alpha: false });
    vCtx.imageSmoothingEnabled = false;

    for (let i = 0; i < 16; i++) {
      const srcCol = i % 4;
      const srcRow = Math.floor(i / 4);
      const j = srcCol * 4 + srcRow;
      const destCol = j % 4;
      const destRow = Math.floor(j / 4);

      vCtx.drawImage(img, srcCol * pieceW, srcRow * pieceH, pieceW, pieceH, destCol * pieceW, destRow * pieceH, pieceW, pieceH);
    }

    if (dummyW > 0) vCtx.drawImage(img, gridW, 0, dummyW, h, gridW, 0, dummyW, h);
    if (dummyH > 0) vCtx.drawImage(img, 0, gridH, w, dummyH, 0, gridH, w, dummyH);

    if (dummyW > 0 || dummyH > 0) {
      vCtx.strokeStyle = '#ff007f';
      vCtx.lineWidth = 2;
      vCtx.strokeRect(0, 0, gridW, gridH);
    }
    vCtx.strokeStyle = '#00ffff';
    vCtx.lineWidth = 4;
    vCtx.strokeRect(0, 0, outW, outH);

    // 2. sharpCanvas (Xuất file sạch 100%)
    const sharpCanvas = DOC.createElement('canvas');
    sharpCanvas.width = outW; sharpCanvas.height = outH;
    const sCtx = sharpCanvas.getContext('2d', { alpha: false });
    sCtx.imageSmoothingEnabled = false;

    for (let i = 0; i < 16; i++) {
      const srcCol = i % 4;
      const srcRow = Math.floor(i / 4);
      const j = srcCol * 4 + srcRow;
      const destCol = j % 4;
      const destRow = Math.floor(j / 4);

      sCtx.drawImage(img, srcCol * pieceW, srcRow * pieceH, pieceW, pieceH, destCol * pieceW, destRow * pieceH, pieceW, pieceH);
    }

    if (dummyW > 0) sCtx.drawImage(img, gridW, 0, dummyW, h, gridW, 0, dummyW, h);
    if (dummyH > 0) sCtx.drawImage(img, 0, gridH, w, dummyH, 0, gridH, w, dummyH);

    const dummyText = (dummyW > 0 || dummyH > 0)
      ? `Mép giữ nguyên: ${dummyW}px phải, ${dummyH}px đáy`
      : `Khớp ma trận 100% (Không có phần dư)`;

    return { rawW: w, rawH: h, gridW, gridH, dummyText, visualCanvas, sharpCanvas, img };
  }

  function getUrlParams() {
    const path = WIN.location.pathname;
    let titleId = "", episodeId = "";

    const vMatch = path.match(/\/viewer\/(\d+)\/(\d+)/);
    if (vMatch) { titleId = vMatch[1]; episodeId = vMatch[2]; }

    if (!titleId) {
      const tMatch = path.match(/\/title\/(\d+)/);
      if (tMatch) titleId = tMatch[1];
    }

    // Tự động bắt episodeId qua Performance API nếu đang ở trang /title/
    if (!episodeId && typeof WIN.performance?.getEntriesByType === 'function') {
      const entries = WIN.performance.getEntriesByType('resource');
      const vEntry = entries.find(r => r.name && r.name.includes('webapi.ynjn.jp/viewer'));
      if (vEntry) {
        try {
          const u = new URL(vEntry.name);
          episodeId = u.searchParams.get('episodeId') || u.searchParams.get('episode_id') || "";
          if (!titleId) titleId = u.searchParams.get('titleId') || u.searchParams.get('title_id') || "";
        } catch (e) {}
      }
    }
    return { titleId, episodeId };
  }

  async function boot() {
    while (!DOC.body) await sleep(50);
    
    // Đợi trang nạp và bắt được episodeId (tối đa 2 giây nếu ở trang /title/)
    let { titleId, episodeId } = getUrlParams();
    if (!titleId) return;

    for (let i = 0; i < 20 && !episodeId; i++) {
      await sleep(100);
      episodeId = getUrlParams().episodeId;
    }
    if (!episodeId) return;

    DOC.getElementById('manga-inspector-root')?.remove();

    try {
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const apiUrl = `https://webapi.ynjn.jp/viewer?title_id=${titleId}&episode_id=${episodeId}&viewerOnly=0`;
      const headers = {
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://ynjn.jp",
        "Referer": "https://ynjn.jp/"
      };

      const rawBuf = await Utils.fetchBuffer(apiUrl, headers);
      const json = JSON.parse(new TextDecoder().decode(rawBuf));
      const pages = json?.data?.pages?.filter(p => p.manga_page?.page_image_url) || [];
      if (!pages.length) return;

      const createUI = window.createInspectorUI || globalThis.createInspectorUI;
      createUI({
        title: "YANJAN! (YNJN) INSPECTOR",
        totalPages: pages.length,
        onPreview: async (pNo, onSuccess, onError) => {
          try {
            const pageItem = pages[pNo - 1]?.manga_page;
            if (!pageItem) return onError("Trang không tồn tại!");

            const imgBuf = await Utils.fetchBuffer(pageItem.page_image_url);
            const ext = Utils.detectExt(imgBuf);
            const mime = Utils.detectMimeType(imgBuf);
            const img = await Utils.loadImage(imgBuf, mime);

            const res = descrambleYnjn(img, pageItem.image_horizontal_size, pageItem.image_vertical_size);
            onSuccess({ ...res, rawExt: ext.toUpperCase(), rawBuf: imgBuf }, pNo);
          } catch (e) { onError(e?.message || String(e)); }
        },
        onDownload: async (pageArray, fmt, quality, statusText, btn) => {
          btn.disabled = true;
          try {
            const mimeType = fmt === 'png' ? 'image/png' : (fmt === 'webp' ? 'image/webp' : 'image/jpeg');

            if (pageArray.length === 1) {
              const pNo = pageArray[0];
              const pageItem = pages[pNo - 1]?.manga_page;
              const imgBuf = await Utils.fetchBuffer(pageItem.page_image_url);
              const ext = Utils.detectExt(imgBuf);
              const mime = Utils.detectMimeType(imgBuf);
              const img = await Utils.loadImage(imgBuf, mime);
              const res = descrambleYnjn(img, pageItem.image_horizontal_size, pageItem.image_vertical_size);

              const a1 = DOC.createElement('a'); a1.href = URL.createObjectURL(new Blob([imgBuf], { type: mime }));
              a1.download = `Ynjn_Trang_${pNo}_raw.${ext}`; a1.click();

              const a2 = DOC.createElement('a');
              a2.href = URL.createObjectURL(await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality)));
              a2.download = `Ynjn_Trang_${pNo}_decoded.${fmt}`; a2.click();

              statusText.textContent = `✅ Đã tải xong 2 bản trang ${pNo}!`;
            } else {
              const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
              const zip = new ZipClass();

              for (let i = 0; i < pageArray.length; i++) {
                const pNo = pageArray[i];
                statusText.textContent = `Đang giải mã: ${i + 1}/${pageArray.length} (Trang ${pNo})...`;
                const pageItem = pages[pNo - 1]?.manga_page;
                const imgBuf = await Utils.fetchBuffer(pageItem.page_image_url);
                const ext = Utils.detectExt(imgBuf);
                const mime = Utils.detectMimeType(imgBuf);
                const img = await Utils.loadImage(imgBuf, mime);
                const res = descrambleYnjn(img, pageItem.image_horizontal_size, pageItem.image_vertical_size);

                const sharpBlob = await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality));
                zip.addFile(`1_raw/${pNo}.${ext}`, new Uint8Array(imgBuf));
                zip.addFile(`2_decoded/${pNo}.${fmt}`, new Uint8Array(await sharpBlob.arrayBuffer()));
              }

              statusText.textContent = `Đang đóng gói file ZIP...`;
              await sleep(60);
              zip.download(`Ynjn_Compare_${pageArray[0]}-${pageArray[pageArray.length - 1]}.zip`);
              statusText.textContent = `✅ Đã xuất xong file ZIP đối chiếu!`;
            }
          } catch (e) {
            statusText.textContent = `❌ ${e?.message || String(e)}`;
          } finally {
            btn.disabled = false;
          }
        }
      });
    } catch (e) {
      console.error("[ynjn-inspector] Boot error:", e);
    }
  }

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      boot();
    }
  }, 400);

  boot();
})();