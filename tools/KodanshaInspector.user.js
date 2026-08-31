// ==UserScript==
// @name         Kodansha Inspector
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      2.0.0
// @description  Inspector soi ma trận PRNG Xorshift 4x4 cho MagaPoke và K MANGA.
// @author       anonymous & AI
// @match        https://pocket.shonenmagazine.com/*
// @match        https://kmanga.kodansha.com/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-start
//
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/InspectorUI.js
// ==/UserScript==

(function kodanshaInspector() {
  'use strict';
  const WIN = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const DOC = WIN.document;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  if (WIN.top !== WIN.self) return;

  let capturedApi = null;
  const origFetch = WIN.fetch;
  if (typeof origFetch === 'function') {
    WIN.fetch = async function(...args) {
      const res = await origFetch.apply(this, args);
      try {
        const u = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        if (u.includes('/web/episode/viewer')) {
          res.clone().json().then(d => {
            if (d?.page_list || d?.pages || d?.data?.page_list) capturedApi = d;
          }).catch(() => {});
        }
      } catch (e) {}
      return res;
    };
  }

  function* xorshift(seed) {
    const x = Uint32Array.of(seed);
    while (true) {
      x[0] ^= x[0] << 13; x[0] ^= x[0] >>> 17; x[0] ^= x[0] << 5;
      yield x[0];
    }
  }

  function generateMapping(gridSize, seed) {
    const t = xorshift(seed);
    const indices = [...Array(gridSize ** 2)].map((_, r) => r);
    const shuffled = indices.map(r => [t.next().value, r]).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(r => r[1]);
    return shuffled.map((s, r) => ({
      source: { x: s % gridSize, y: Math.floor(s / gridSize) },
      dest: { x: r % gridSize, y: Math.floor(r / gridSize) }
    }));
  }

  function descrambleKodansha(img, seed, mangaId, episodeId, isKManga) {
    const w = img.naturalWidth, h = img.naturalHeight;
    const blockW = Math.floor(Math.floor(w / 8) / 4) * 8;
    const blockH = Math.floor(Math.floor(h / 8) / 4) * 8;
    const gridW = blockW * 4, gridH = blockH * 4;
    const dummyW = w - gridW, dummyH = h - gridH;

    let finalSeed = seed;
    if (typeof seed === "string") {
      const charset = isKManga ? (mangaId % 2 === 0 ? "we7ru3ty8i" : "h4xm9bqz1p") : (mangaId % 2 === 0 ? "svdk0m7acl" : "q6jtf2xnog");
      let parsedInt = 0n;
      for (const ch of seed) {
        const idx = charset.indexOf(ch);
        if (idx !== -1) parsedInt = parsedInt * 10n + BigInt(idx); else break;
      }
      finalSeed = ((Number(parsedInt & 0xffffffffn)) ^ ((mangaId >>> 0) + (episodeId >>> 0))) >>> 0;
    }

    const mapping = generateMapping(4, finalSeed);

    // 1. visualCanvas (Soi Live: Viền Cyan toàn ảnh + Khung Hồng ma trận 4x4)
    const visualCanvas = DOC.createElement('canvas');
    visualCanvas.width = w; visualCanvas.height = h;
    const vCtx = visualCanvas.getContext('2d', { alpha: false });
    vCtx.imageSmoothingEnabled = false;
    vCtx.fillStyle = '#ffffff';
    vCtx.fillRect(0, 0, w, h);
    vCtx.drawImage(img, 0, 0); // Giữ nguyên toàn bộ tranh gốc
    for (const c of mapping) {
      vCtx.drawImage(img, c.source.x * blockW, c.source.y * blockH, blockW, blockH, c.dest.x * blockW, c.dest.y * blockH, blockW, blockH);
    }
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
    sCtx.drawImage(img, 0, 0);
    for (const c of mapping) {
      sCtx.drawImage(img, c.source.x * blockW, c.source.y * blockH, blockW, blockH, c.dest.x * blockW, c.dest.y * blockH, blockW, blockH);
    }

    const dummyText = (dummyW > 0 || dummyH > 0)
      ? `Mép giữ nguyên: ${dummyW}px phải, ${dummyH}px đáy (Không xáo trộn)`
      : `Khớp ma trận 100% (Không có phần dư)`;

    return { rawW: w, rawH: h, gridW, gridH, dummyText, visualCanvas, sharpCanvas, img };
  }

  async function boot() {
    while (!DOC.body) await sleep(50);
    const isKManga = location.hostname.includes('kmanga.kodansha.com');
    const mMatch = location.pathname.match(/\/episode\/(\d+)/);
    const epId = mMatch ? mMatch[1] : "";
    if (!epId) return;

    let apiData = capturedApi;
    for (let i = 0; i < 30; i++) {
      if (capturedApi?.page_list || capturedApi?.pages) { apiData = capturedApi; break; }
      await sleep(150);
    }
    const rawPages = apiData?.page_list || apiData?.pages || apiData?.data?.page_list || [];
    if (!rawPages.length) return;

    const createUI = window.createInspectorUI || globalThis.createInspectorUI;
    createUI({
      title: isKManga ? "K MANGA INSPECTOR" : "MAGAPOKE INSPECTOR",
      totalPages: rawPages.length,
      onPreview: async (pNo, onSuccess, onError) => {
        const imgUrl = rawPages[pNo - 1];
        if (!imgUrl) return onError("Trang không tồn tại!");
        try {
          const Utils = window.MangaUtils || globalThis.MangaUtils;
          const rawBuf = await Utils.fetchBuffer(imgUrl);
          const ext = Utils.detectExt(rawBuf);
          const mime = Utils.detectMimeType(rawBuf);
          const img = await Utils.loadImage(rawBuf, mime);
          const res = descrambleKodansha(img, apiData.scramble_seed || apiData.seed || "", Number(apiData.title_id || 0), Number(epId || 0), isKManga);

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
            const imgUrl = rawPages[pNo - 1];
            const rawBuf = await Utils.fetchBuffer(imgUrl);
            const ext = Utils.detectExt(rawBuf);
            const mime = Utils.detectMimeType(rawBuf);
            const img = await Utils.loadImage(rawBuf, mime);
            const res = descrambleKodansha(img, apiData.scramble_seed || apiData.seed || "", Number(apiData.title_id || 0), Number(epId || 0), isKManga);

            const a1 = DOC.createElement('a'); a1.href = URL.createObjectURL(new Blob([rawBuf], { type: mime }));
            a1.download = `Kodansha_Trang_${pNo}_raw.${ext}`; a1.click();

            const a2 = DOC.createElement('a');
            a2.href = URL.createObjectURL(await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality)));
            a2.download = `Kodansha_Trang_${pNo}_decoded.${fmt}`; a2.click();

            statusText.textContent = `✅ Đã tải xong 2 bản trang ${pNo}!`;
          } else {
            const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
            const zip = new ZipClass();

            for (let i = 0; i < pageArray.length; i++) {
              const pNo = pageArray[i];
              statusText.textContent = `Đang giải mã: ${i + 1}/${pageArray.length} (Trang ${pNo})...`;
              const imgUrl = rawPages[pNo - 1];
              const rawBuf = await Utils.fetchBuffer(imgUrl);
              const ext = Utils.detectExt(rawBuf);
              const mime = Utils.detectMimeType(rawBuf);
              const img = await Utils.loadImage(rawBuf, mime);
              const res = descrambleKodansha(img, apiData.scramble_seed || apiData.seed || "", Number(apiData.title_id || 0), Number(epId || 0), isKManga);

              const sharpBlob = await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality));
              zip.addFile(`1_raw/${pNo}.${ext}`, new Uint8Array(rawBuf));
              zip.addFile(`2_decoded/${pNo}.${fmt}`, new Uint8Array(await sharpBlob.arrayBuffer()));
            }

            statusText.textContent = `Đang đóng gói file ZIP...`;
            await sleep(60);
            zip.download(`Kodansha_Compare_${pageArray[0]}-${pageArray[pageArray.length - 1]}.zip`);
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