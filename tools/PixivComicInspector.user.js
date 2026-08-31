// ==UserScript==
// @name         Pixiv Comic Inspector
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @description  Inspector soi ma trận Grid Shuffle 128-bit PRNG và đối chiếu ảnh gốc CDN vs Giải mã cho Pixiv Comic (comic.pixiv.net).
// @author       anonymous & AI
// @match        https://comic.pixiv.net/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      comic.pixiv.net
// @connect      *.pixiv.net
// @connect      *.pximg.net
// @run-at       document-start
//
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/InspectorUI.js
// ==/UserScript==

(function pixivComicInspector() {
  'use strict';
  const WIN = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const DOC = WIN.document;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  if (WIN.top !== WIN.self) return;

  const state = {
    capturedApiData: null
  };

  /* =========================================================================
   * 1. HOOK BẮT GÓI TIN TỰ NHIÊN CỦA WEB KHI CHUYỂN TRANG
   * ========================================================================= */
  function installFetchHook() {
    const origFetch = WIN.fetch;
    if (!origFetch || origFetch.__manga_hooked) return;

    const hookedFetch = async function(...args) {
      const response = await origFetch.apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        if (url.includes('/api/app/episodes/') && url.includes('/read_v4')) {
          const clone = response.clone();
          clone.json().then(data => {
            const epData = data?.data?.reading_episode;
            if (epData && Array.isArray(epData.pages) && epData.pages.length > 0) {
              state.capturedApiData = epData;
            }
          }).catch(() => {});
        }
      } catch (e) {}
      return response;
    };

    hookedFetch.__manga_hooked = true;
    WIN.fetch = hookedFetch;
  }

  installFetchHook();

  /* =========================================================================
   * 2. BỘ HỖ TRỢ XỬ LÝ CHUỖI & XÁC THỰC API (WEB CRYPTO API)
   * ========================================================================= */
  function isEpisodeUrl() {
    return /\/viewer\/stories\/[a-zA-Z0-9_-]+/.test(WIN.location.pathname);
  }

  function getEpisodeId() {
    const match = WIN.location.pathname.match(/\/viewer\/stories\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : "pixiv_episode";
  }

  async function sha256Hex(str) {
    const buf = new TextEncoder().encode(str);
    const digest = await WIN.crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function getPixivSalt(episodeId, timeoutMs = 6000) {
    let salt = WIN.__NEXT_DATA__?.props?.pageProps?.salt;
    if (salt) return salt;

    const buildId = WIN.__NEXT_DATA__?.buildId;
    if (buildId && episodeId) {
      try {
        const nextDataUrl = `https://comic.pixiv.net/_next/data/${buildId}/viewer/stories/${episodeId}.json`;
        const res = await fetch(nextDataUrl);
        const json = await res.json();
        salt = json?.pageProps?.salt;
        if (salt) return salt;
      } catch(e) {}
    }

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      salt = WIN.__NEXT_DATA__?.props?.pageProps?.salt;
      if (salt) return salt;
      await sleep(100);
    }
    throw new Error("Không tìm thấy Salt xác thực của Pixiv Comic.");
  }

  async function fetchPixivPages() {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    const episodeId = getEpisodeId();

    let episodeData = state.capturedApiData;

    if (!episodeData || (episodeData.id && String(episodeData.id) !== String(episodeId))) {
      const salt = await getPixivSalt(episodeId);

      const now = new Date();
      const year = now.getFullYear();
      const month = (now.getMonth() + 1).toString().padStart(2, '0');
      const date = now.getDate().toString().padStart(2, '0');
      const hour = now.getHours().toString().padStart(2, '0');
      const minute = now.getMinutes().toString().padStart(2, '0');
      const second = now.getSeconds().toString().padStart(2, '0');
      const timeStr = `${year}-${month}-${date}T${hour}:${minute}:${second}+08:00`;

      const hash = await sha256Hex(`${timeStr}${salt}`);
      const apiUrl = `https://comic.pixiv.net/api/app/episodes/${episodeId}/read_v4`;
      const apiHeaders = {
        'x-client-time': timeStr,
        'x-client-hash': hash,
        'x-requested-with': 'pixivcomic',
        'Accept': 'application/json'
      };

      const resBuf = await Utils.fetchBuffer(apiUrl, apiHeaders);
      const json = JSON.parse(new TextDecoder().decode(resBuf));
      episodeData = json?.data?.reading_episode;
    }

    if (!episodeData || !Array.isArray(episodeData.pages) || episodeData.pages.length === 0) {
      throw new Error("Không có dữ liệu trang truyện từ API Pixiv.");
    }

    return episodeData.pages.map((p, idx) => ({
      pageNo: idx + 1,
      url: p.url,
      key: p.key,
      width: Number(p.width) || 0,
      height: Number(p.height) || 0,
      gridsize: Number(p.gridsize) || 50
    }));
  }

  /* =========================================================================
   * 3. THUẬT TOÁN GIẢI MÃ MA TRẬN GRID SHUFFLE (128-BIT PRNG)
   * ========================================================================= */
  const PIXIV_STATIC_SALT = "4wXCKprMMoxnyJ3PocJFs4CYbfnbazNe";

  function tE(e, t) {
    return ((e << (t %= 32)) >>> 0 | (e >>> (32 - t))) >>> 0;
  }

  class PixivPRNG {
    constructor(seedWords) {
      if (seedWords.length !== 4) throw new Error("Seed length phải bằng 4 words (128-bit).");
      this.s = new Uint32Array(seedWords);
      if (this.s[0] === 0 && this.s[1] === 0 && this.s[2] === 0 && this.s[3] === 0) {
        this.s[0] = 1;
      }
    }
    next() {
      let e = (9 * tE((5 * this.s[1]) >>> 0, 7)) >>> 0;
      let t = (this.s[1] << 9) >>> 0;
      this.s[2] = (this.s[2] ^ this.s[0]) >>> 0;
      this.s[3] = (this.s[3] ^ this.s[1]) >>> 0;
      this.s[1] = (this.s[1] ^ this.s[2]) >>> 0;
      this.s[0] = (this.s[0] ^ this.s[3]) >>> 0;
      this.s[2] = (this.s[2] ^ t) >>> 0;
      this.s[3] = tE(this.s[3], 11);
      return e;
    }
  }

  async function unscramblePixivPixelArray(pixelBytes, width, height, blockSizeH, blockSizeV, pageKey) {
    const bytesPerPixel = 4;
    const totalRows = Math.ceil(height / blockSizeV);
    const totalCols = Math.floor(width / blockSizeH);

    const seedBuffer = new TextEncoder().encode(PIXIV_STATIC_SALT + pageKey);
    const hashBuffer = await WIN.crypto.subtle.digest("SHA-256", seedBuffer);
    const seedWords = new Uint32Array(hashBuffer, 0, 4);
    const prng = new PixivPRNG(seedWords);

    for (let i = 0; i < 100; i++) prng.next();

    const permutationTable = Array(totalRows).fill(null).map(() => Array.from(Array(totalCols).keys()));
    for (let r = 0; r < totalRows; r++) {
      const rowCols = permutationTable[r];
      for (let c = totalCols - 1; c >= 1; c--) {
        const randIdx = prng.next() % (c + 1);
        const temp = rowCols[c];
        rowCols[c] = rowCols[randIdx];
        rowCols[randIdx] = temp;
      }
    }

    for (let r = 0; r < totalRows; r++) {
      const rowCols = permutationTable[r];
      const inv = rowCols.map((_, idx) => rowCols.indexOf(idx));
      permutationTable[r] = inv;
    }

    const outBytes = new Uint8ClampedArray(pixelBytes.length);

    for (let y = 0; y < height; y++) {
      const blockRow = Math.floor(y / blockSizeV);
      const rowMapping = permutationTable[blockRow];

      for (let col = 0; col < totalCols; col++) {
        const srcCol = rowMapping[col];
        const destXOffset = col * blockSizeH;
        const destByteIdx = (y * width + destXOffset) * bytesPerPixel;
        const srcXOffset = srcCol * blockSizeH;
        const srcByteIdx = (y * width + srcXOffset) * bytesPerPixel;
        const copyByteLength = blockSizeH * bytesPerPixel;

        for (let b = 0; b < copyByteLength; b++) {
          outBytes[destByteIdx + b] = pixelBytes[srcByteIdx + b];
        }
      }

      const remainderStartByte = (totalCols * blockSizeH);
      const startIdx = (y * width + remainderStartByte) * bytesPerPixel;
      const endIdx = (y * width + width) * bytesPerPixel;
      for (let b = startIdx; b < endIdx; b++) {
        outBytes[b] = pixelBytes[b];
      }
    }

    return outBytes;
  }

  /* =========================================================================
   * 4. TÁI TẠO ĐỒ HỌA VISUAL & SHARP CANVAS
   * ========================================================================= */
  async function descramblePixivInspector(img, pageObj) {
    const w = pageObj.width || img.naturalWidth;
    const h = pageObj.height || img.naturalHeight;
    const blockSize = pageObj.gridsize || 50;

    const totalCols = Math.floor(w / blockSize);
    const gridW = totalCols * blockSize;
    const dummyW = w - gridW;

    // 1. Giải mã mảng pixel thô
    const canvas = DOC.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, w, h);

    const rawImageData = ctx.getImageData(0, 0, w, h);
    const decodedBytes = await unscramblePixivPixelArray(
      rawImageData.data,
      w,
      h,
      blockSize,
      blockSize,
      pageObj.key
    );

    // 2. sharpCanvas (Xuất file sạch 100%)
    const sharpCanvas = DOC.createElement('canvas');
    sharpCanvas.width = w;
    sharpCanvas.height = h;
    const sCtx = sharpCanvas.getContext('2d', { alpha: false });
    sCtx.imageSmoothingEnabled = false;
    sCtx.putImageData(new ImageData(decodedBytes, w, h), 0, 0);

    // 3. visualCanvas (Soi Live: Viền Cyan toàn ảnh + Khung Hồng vùng Grid Shuffle)
    const visualCanvas = DOC.createElement('canvas');
    visualCanvas.width = w;
    visualCanvas.height = h;
    const vCtx = visualCanvas.getContext('2d', { alpha: false });
    vCtx.imageSmoothingEnabled = false;
    vCtx.drawImage(sharpCanvas, 0, 0);

    // Khung Hồng nét liền bao quanh vùng ma trận bị xáo trộn (nếu có dải dư mép phải)
    if (dummyW > 0) {
      vCtx.strokeStyle = '#ff007f';
      vCtx.lineWidth = 2;
      vCtx.strokeRect(0, 0, gridW, h);
    }
    // Viền Cyan nét liền bao quanh toàn bộ bức tranh
    vCtx.strokeStyle = '#00ffff';
    vCtx.lineWidth = 4;
    vCtx.strokeRect(0, 0, w, h);

    const dummyText = (dummyW > 0)
      ? `Mép giữ nguyên: ${dummyW}px phải, 0px đáy (Không xáo trộn)`
      : `Khớp ma trận 100% (Không có phần dư)`;

    return {
      rawW: w,
      rawH: h,
      gridW: gridW,
      gridH: h,
      dummyText: dummyText,
      sharpCanvas: sharpCanvas,
      visualCanvas: visualCanvas,
      img: img
    };
  }

  /* =========================================================================
   * 5. KHỞI CHẠY GIAO DIỆN INSPECTORUI
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(50);

    if (!isEpisodeUrl()) return;

    let pages = [];
    for (let i = 0; i < 30; i++) {
      try {
        pages = await fetchPixivPages();
        if (pages.length > 0) break;
      } catch (e) {}
      await sleep(150);
    }
    if (!pages.length) return;

    const createUI = window.createInspectorUI || globalThis.createInspectorUI;
    createUI({
      title: "PIXIV COMIC INSPECTOR",
      totalPages: pages.length,
      onPreview: async (pNo, onSuccess, onError) => {
        const pageObj = pages[pNo - 1];
        if (!pageObj) return onError("Trang không tồn tại!");
        try {
          const Utils = window.MangaUtils || globalThis.MangaUtils;
          const rawBuf = await Utils.fetchBuffer(pageObj.url, {
            'X-Cobalt-Thumber-Parameter-Gridshuffle-Key': pageObj.key
          });

          const ext = Utils.detectExt(rawBuf);
          const mime = Utils.detectMimeType(rawBuf);
          const img = await Utils.loadImage(rawBuf, mime);
          const res = await descramblePixivInspector(img, pageObj);

          onSuccess({ ...res, rawExt: ext.toUpperCase(), rawBuf }, pNo);
        } catch (e) {
          onError(e?.message || String(e));
        }
      },
      onDownload: async (pageArray, fmt, quality, statusText, btn) => {
        btn.disabled = true;
        try {
          const Utils = window.MangaUtils || globalThis.MangaUtils;
          const mimeType = fmt === 'png' ? 'image/png' : (fmt === 'webp' ? 'image/webp' : 'image/jpeg');

          if (pageArray.length === 1) {
            const pNo = pageArray[0];
            const pageObj = pages[pNo - 1];
            const rawBuf = await Utils.fetchBuffer(pageObj.url, {
              'X-Cobalt-Thumber-Parameter-Gridshuffle-Key': pageObj.key
            });

            const ext = Utils.detectExt(rawBuf);
            const mime = Utils.detectMimeType(rawBuf);
            const img = await Utils.loadImage(rawBuf, mime);
            const res = await descramblePixivInspector(img, pageObj);

            // 1. Tải bản Raw xáo trộn gốc từ CDN
            const a1 = DOC.createElement('a');
            a1.href = URL.createObjectURL(new Blob([rawBuf], { type: mime }));
            a1.download = `Pixiv_Trang_${pNo}_raw.${ext}`;
            a1.click();

            // 2. Tải bản Giải mã sạch 100% (không viền)
            const a2 = DOC.createElement('a');
            a2.href = URL.createObjectURL(await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality)));
            a2.download = `Pixiv_Trang_${pNo}_decoded.${fmt}`;
            a2.click();

            statusText.textContent = `✅ Đã tải xong 2 bản trang ${pNo}!`;
          } else {
            const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
            const zip = new ZipClass();

            for (let i = 0; i < pageArray.length; i++) {
              const pNo = pageArray[i];
              statusText.textContent = `Đang giải mã: ${i + 1}/${pageArray.length} (Trang ${pNo})...`;
              const pageObj = pages[pNo - 1];
              const rawBuf = await Utils.fetchBuffer(pageObj.url, {
                'X-Cobalt-Thumber-Parameter-Gridshuffle-Key': pageObj.key
              });

              const ext = Utils.detectExt(rawBuf);
              const mime = Utils.detectMimeType(rawBuf);
              const img = await Utils.loadImage(rawBuf, mime);
              const res = await descramblePixivInspector(img, pageObj);

              const sharpBlob = await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality));
              zip.addFile(`1_raw/${pNo}.${ext}`, new Uint8Array(rawBuf));
              zip.addFile(`2_decoded/${pNo}.${fmt}`, new Uint8Array(await sharpBlob.arrayBuffer()));
            }

            statusText.textContent = `Đang đóng gói file ZIP...`;
            await sleep(60);
            zip.download(`PixivComic_Compare_${pageArray[0]}-${pageArray[pageArray.length - 1]}.zip`);
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
      state.capturedApiData = null;
      boot();
    }
  }, 500);

  boot();
})();