// ==UserScript==
// @name         Comici+ Inspector
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      2.0.0
// @description  Inspector soi ma trận hoán vị 16 ô cho ~30 tạp chí Comici+.
// @author       anonymous & AI
// @match        https://championcross.jp/*
// @match        https://comic-growl.com/*
// @match        https://youngchampion.jp/*
// @match        https://younganimal.com/*
// @match        https://hanayume.com/*
// @match        https://bigcomics.jp/*
// @match        https://heros-web.com/*
// @match        https://takecomic.jp/*
// @match        https://hayacomic.jp/*
// @match        https://kansai.mag-garden.co.jp/*
// @match        https://g-comi.jp/*
// @match        https://comicpash.jp/*
// @match        https://kimicomi.com/*
// @match        https://comic-room-base.com/*
// @match        https://comirela.com/*
// @match        https://bibibi-comic.com/*
// @match        https://mangalt.jp/*
// @match        https://comics.comici.jp/*
// @match        https://rimacomiplus.jp/*
// @match        https://comicride.jp/*
// @match        https://comics.manga-bang.com/*
// @match        https://mangaspa.nikkan-spa.jp/*
// @match        https://asacomi.jp/*
// @match        https://namicomic.jp/*
// @match        https://piacomic.jp/*
// @match        https://comic.j-nbooks.jp/*
// @match        https://studio.booklista.co.jp/*
// @match        https://manga-zegra.com/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-start
//
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/InspectorUI.js
// ==/UserScript==

(function comiciInspector() {
  'use strict';
  const WIN = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const DOC = WIN.document;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  if (WIN.top !== WIN.self) return;

  function descrambleComici(img, scrambleArray) {
    const w = img.naturalWidth, h = img.naturalHeight;
    const cellW = Math.floor(w / 4), cellH = Math.floor(h / 4);
    const gridW = cellW * 4, gridH = cellH * 4;
    const dummyW = w - gridW, dummyH = h - gridH;

    const pos = [];
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) pos.push([c, r]);
    const map = (scrambleArray && scrambleArray.length === 16) ? scrambleArray.map(idx => pos[idx]) : pos;

    // 1. visualCanvas (Soi Live: Viền Cyan toàn ảnh + Khung Hồng ma trận 4x4)
    const visualCanvas = DOC.createElement('canvas');
    visualCanvas.width = w; visualCanvas.height = h;
    const vCtx = visualCanvas.getContext('2d', { alpha: false });
    vCtx.imageSmoothingEnabled = false;
    vCtx.fillStyle = '#ffffff';
    vCtx.fillRect(0, 0, w, h);
    let f = 0;
    for (let p = 0; p < 4; p++) {
      for (let row = 0; row < 4; row++) {
        if (map[f]) vCtx.drawImage(img, map[f][0] * cellW, map[f][1] * cellH, cellW, cellH, p * cellW, row * cellH, cellW, cellH);
        f++;
      }
    }
    if (dummyW > 0) vCtx.drawImage(img, gridW, 0, dummyW, h, gridW, 0, dummyW, h);
    if (dummyH > 0) vCtx.drawImage(img, 0, gridH, w, dummyH, 0, gridH, w, dummyH);

    // Khung Hồng nét liền bao quanh vùng ma trận 4x4
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
    f = 0;
    for (let p = 0; p < 4; p++) {
      for (let row = 0; row < 4; row++) {
        if (map[f]) sCtx.drawImage(img, map[f][0] * cellW, map[f][1] * cellH, cellW, cellH, p * cellW, row * cellH, cellW, cellH);
        f++;
      }
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
    let vId = null, cleanDomain = `${location.host}/api`, contentId = '';
    for (let i = 0; i < 40; i++) {
      const viewerEl = DOC.getElementById('comici-viewer') || DOC.querySelector('[data-comici-viewer-id]');
      if (viewerEl) {
        vId = viewerEl.getAttribute('data-comici-viewer-id') || viewerEl.dataset?.comiciViewerId;
        contentId = viewerEl.getAttribute('data-content-id') || '';
        let apiDomain = viewerEl.getAttribute('data-api-domain') || viewerEl.dataset?.apiDomain || '/api';
        apiDomain = apiDomain.trim();
        if (apiDomain.startsWith('/')) apiDomain = `${location.host}${apiDomain}`;
        cleanDomain = apiDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
        if (vId) break;
      }
      await sleep(150);
    }
    if (!vId) return;

    try {
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const headers = { "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" };
      const initUrl = `${location.protocol}//${cleanDomain}/book/contentsInfo?comici-viewer-id=${vId}&page-from=0&page-to=1${contentId ? `&contentId=${contentId}` : ''}`;
      const initBuf = await Utils.fetchBuffer(initUrl, headers);
      const initJson = JSON.parse(new TextDecoder().decode(initBuf));
      const total = initJson.totalPages || 50;

      const createUI = window.createInspectorUI || globalThis.createInspectorUI;
      createUI({
        title: "COMICI+ INSPECTOR",
        totalPages: total,
        onPreview: async (pNo, onSuccess, onError) => {
          try {
            const pUrl = `${location.protocol}//${cleanDomain}/book/contentsInfo?comici-viewer-id=${vId}&page-from=${pNo - 1}&page-to=${pNo}${contentId ? `&contentId=${contentId}` : ''}`;
            const pBuf = await Utils.fetchBuffer(pUrl, headers);
            const pJson = JSON.parse(new TextDecoder().decode(pBuf));
            const item = pJson.result?.[0];
            let imgUrl = item.imageUrl || item.src || item.url;
            if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;

            let scramble = item.scramble || item.scramble_key;
            if (typeof scramble === 'string') { try { scramble = JSON.parse(scramble); } catch(e){} }

            const rawBuf = await Utils.fetchBuffer(imgUrl);
            const ext = Utils.detectExt(rawBuf);
            const mime = Utils.detectMimeType(rawBuf);
            const img = await Utils.loadImage(rawBuf, mime);
            const res = descrambleComici(img, scramble);

            onSuccess({ ...res, rawExt: ext.toUpperCase(), rawBuf }, pNo);
          } catch (e) { onError(e?.message || String(e)); }
        },
        onDownload: async (pageArray, fmt, quality, statusText, btn) => {
          btn.disabled = true;
          try {
            const mimeType = fmt === 'png' ? 'image/png' : (fmt === 'webp' ? 'image/webp' : 'image/jpeg');

            if (pageArray.length === 1) {
              const pNo = pageArray[0];
              const pUrl = `${location.protocol}//${cleanDomain}/book/contentsInfo?comici-viewer-id=${vId}&page-from=${pNo - 1}&page-to=${pNo}${contentId ? `&contentId=${contentId}` : ''}`;
              const pBuf = await Utils.fetchBuffer(pUrl, headers);
              const pJson = JSON.parse(new TextDecoder().decode(pBuf));
              const item = pJson.result?.[0];
              let imgUrl = item.imageUrl || item.src || item.url;
              if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;

              let scramble = item.scramble || item.scramble_key;
              if (typeof scramble === 'string') { try { scramble = JSON.parse(scramble); } catch(e){} }

              const rawBuf = await Utils.fetchBuffer(imgUrl);
              const ext = Utils.detectExt(rawBuf);
              const mime = Utils.detectMimeType(rawBuf);
              const img = await Utils.loadImage(rawBuf, mime);
              const res = descrambleComici(img, scramble);

              const a1 = DOC.createElement('a'); a1.href = URL.createObjectURL(new Blob([rawBuf], { type: mime }));
              a1.download = `Comici_Trang_${pNo}_raw.${ext}`; a1.click();

              const a2 = DOC.createElement('a');
              a2.href = URL.createObjectURL(await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality)));
              a2.download = `Comici_Trang_${pNo}_decoded.${fmt}`; a2.click();

              statusText.textContent = `✅ Đã tải xong 2 bản trang ${pNo}!`;
            } else {
              const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
              const zip = new ZipClass();

              for (let i = 0; i < pageArray.length; i++) {
                const pNo = pageArray[i];
                statusText.textContent = `Đang giải mã: ${i + 1}/${pageArray.length} (Trang ${pNo})...`;
                const pUrl = `${location.protocol}//${cleanDomain}/book/contentsInfo?comici-viewer-id=${vId}&page-from=${pNo - 1}&page-to=${pNo}${contentId ? `&contentId=${contentId}` : ''}`;
                const pBuf = await Utils.fetchBuffer(pUrl, headers);
                const pJson = JSON.parse(new TextDecoder().decode(pBuf));
                const item = pJson.result?.[0];
                let imgUrl = item.imageUrl || item.src || item.url;
                if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;

                let scramble = item.scramble || item.scramble_key;
                if (typeof scramble === 'string') { try { scramble = JSON.parse(scramble); } catch(e){} }

                const rawBuf = await Utils.fetchBuffer(imgUrl);
                const ext = Utils.detectExt(rawBuf);
                const mime = Utils.detectMimeType(rawBuf);
                const img = await Utils.loadImage(rawBuf, mime);
                const res = descrambleComici(img, scramble);

                const sharpBlob = await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality));
                zip.addFile(`1_raw/${pNo}.${ext}`, new Uint8Array(rawBuf));
                zip.addFile(`2_decoded/${pNo}.${fmt}`, new Uint8Array(await sharpBlob.arrayBuffer()));
              }

              statusText.textContent = `Đang đóng gói file ZIP...`;
              await sleep(60);
              zip.download(`Comici_Compare_${pageArray[0]}-${pageArray[pageArray.length - 1]}.zip`);
              statusText.textContent = `✅ Đã xuất xong file ZIP đối chiếu!`;
            }
          } catch (e) {
            statusText.textContent = `❌ ${e?.message || String(e)}`;
          } finally {
            btn.disabled = false;
          }
        }
      });
    } catch (e) {}
  }

  let lastUrl = location.href;
  setInterval(() => { if (location.href !== lastUrl) { lastUrl = location.href; boot(); } }, 500);
  boot();
})();