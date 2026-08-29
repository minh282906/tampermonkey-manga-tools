// ==UserScript==
// @name         PixivComic Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://comic.pixiv.net/static/images/icons/icon-192x192.png
// @description  Tải manga trên Pixiv Comic (comic.pixiv.net).
// @author       anonymous & AI
// @match        https://comic.pixiv.net/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      comic.pixiv.net
// @connect      *.pixiv.net
// @connect      *.pximg.net
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/PixivComicDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/PixivComicDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function pixivComicUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6,   // 6 luồng tải và giải mã song song trong RAM
    JPEG_QUALITY: 0.95   // Chất lượng xuất JPG nếu người dùng chọn
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("pixiv-dl:convert-jpeg") === '1',
    chapterData: null,
    ui: null
  };

  /* =========================================================================
   * HOOK TỰ ĐỘNG BẮT GÓI TIN KHI CHUYỂN TRANG SPA
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
              if (isEpisodeUrl()) boot();
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
   * 1. GIAO DIỆN UNIVERSAL UI CHUẨN 2 TẦNG
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "pixiv-dl",
        title: "Pixiv Comic",
        engine: "PIXIV",
        themeColor: "#0096fa",              // Màu xanh Pixiv
        themeBg: "#ffffff",
        titleColor: "#0096fa",
        topOffset: "64px",
        defaultJpgText: "Xuất file JPG (mặc định PNG)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("pixiv-dl:convert-jpeg", checked ? '1' : '0');
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
   * 2. BỘ HỖ TRỢ XỬ LÝ CHUỖI & TÊN FILE CHUẨN (GOLDEN RULES)
   * ========================================================================= */
  function isEpisodeUrl() {
    return /\/viewer\/stories\/[a-zA-Z0-9_-]+/.test(WIN.location.pathname);
  }

  function getEpisodeId() {
    const match = WIN.location.pathname.match(/\/viewer\/stories\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : "pixiv_episode";
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

  function getCleanTitle(manifestSeriesTitle, manifestEpisodeTitle) {
    try {
      let series = manifestSeriesTitle || "";
      let episode = manifestEpisodeTitle || "";

      // 1. Quét DOM Header tìm Tên Truyện chính thức
      if (!series) {
        const seriesEl = DOC.querySelector('header a[href*="/works/"], a[class*="workTitle"], .work-title, [class*="WorkHeader"] [class*="title"], [class*="Header_workTitle"], h1');
        if (seriesEl) series = seriesEl.textContent.trim();
      }

      // 2. Dự phòng phân tích từ document.title
      if (!series || !episode) {
        let raw = (DOC.title || "").replace(/[-|｜]\s*pixivコミック.*$/i, '').trim();
        raw = raw.replace(/【[^】]*】/g, '').trim();

        const parts = raw.split(/[|｜]/);
        if (parts.length >= 2) {
          if (!episode) episode = parts[0].trim();
          if (!series) series = parts[1].trim();
        } else {
          const match = raw.match(/^(.*?)(?:\s+[-－–—]\s+|\s+)((?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\s\-\–\—\ー\~〜\.]+(?:話|巻|章|節|部|エピソード|分冊版|単話|前編|中編|後編)?.*)$/i);
          if (match) {
            if (!series) series = match[1];
            if (!episode) episode = match[2];
          } else {
            if (!series) series = raw;
            if (!episode) episode = getEpisodeId();
          }
        }
      }

      let s = cleanString(series);
      let e = cleanString(episode);

      // Xóa nhãn xuất bản ở cuối tên truyện
      s = s.replace(/（[^）]*(?:コミック|文庫|レーベル|出版|COMIC|WEB)[^）]*）$/i, '').trim();
      s = s.replace(/\([^)]*(?:コミック|文庫|レーベル|出版|COMIC|WEB)[^)]*\)$/i, '').trim();

      // Cắt bỏ phần tên truyện nếu bị dính lặp ở đầu tên chap
      let baseWithoutVol = s.replace(/\s*[0-9０-９]+\s*巻.*$/i, '').trim();
      if (baseWithoutVol && e.startsWith(baseWithoutVol)) {
        e = cleanString(e.substring(baseWithoutVol.length));
      }
      e = e.replace(/^[・･\s\-_:：\u3000]+/, '').trim();

      if (s && e && e !== getEpisodeId() && !s.includes(e)) {
        return `${s} - ${e}`;
      } else if (s && e && e !== getEpisodeId()) {
        return e;
      } else if (s) {
        return `${s} - ${getEpisodeId()}`;
      }
    } catch (err) {}

    return `PixivComic_${getEpisodeId()}`;
  }

  /* =========================================================================
   * 3. BĂM CHỮ KÝ XÁC THỰC THUẦN WEB CRYPTO API (ZERO-DEPENDENCY)
   * ========================================================================= */
  async function sha256Hex(str) {
    const buf = new TextEncoder().encode(str);
    const digest = await WIN.crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function getPixivSalt(episodeId, timeoutMs = 6000) {
    // 1. Kiểm tra trực tiếp trên window
    let salt = WIN.__NEXT_DATA__?.props?.pageProps?.salt;
    if (salt) return salt;

    // 2. Kéo salt ngầm qua Next.js Data API nếu chuyển trang SPA
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

  /* =========================================================================
   * 4. BÓC TÁCH DANH SÁCH TRANG TỪ API READ_V4
   * ========================================================================= */
  async function fetchPixivPages() {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    if (!Utils) throw new Error("Chưa nạp xong MangaUtils.");

    const episodeId = getEpisodeId();

    // 1. Dùng ngay dữ liệu đã bắt được từ Hook (0ms khi chuyển trang SPA)
    let episodeData = state.capturedApiData;

    // 2. Nếu chưa có từ hook, gọi API trực tiếp
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

    const seriesTitle = episodeData.work?.title || episodeData.series?.title || episodeData.work_title || "";
    const episodeTitle = episodeData.title || "";

    return {
      episodeId,
      seriesTitle,
      episodeTitle,
      pages: episodeData.pages.map((p, idx) => ({
        pageNo: idx + 1,
        url: p.url,
        key: p.key,
        width: Number(p.width) || 0,
        height: Number(p.height) || 0,
        gridsize: Number(p.gridsize) || 50
      }))
    };
  }

  /* =========================================================================
   * 5. THUẬT TOÁN GIẢI MÃ MA TRẬN GRID SHUFFLE PIXIV
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
    const bytesPerPixel = 4; // RGBA
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
   * 6. TIẾN TRÌNH GIẢI MÃ VÀ XUẤT ẢNH TRÊN CANVAS
   * ========================================================================= */
  async function processPixivImage(pageObj, isJpg) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;

    const rawBuffer = await Utils.fetchBuffer(pageObj.url, {
      'X-Cobalt-Thumber-Parameter-Gridshuffle-Key': pageObj.key
    });

    const img = await Utils.loadImage(rawBuffer, 'image/jpeg');
    const w = pageObj.width || img.naturalWidth;
    const h = pageObj.height || img.naturalHeight;

    const canvas = DOC.createElement('canvas');
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    ctx.mozImageSmoothingEnabled = false;
    ctx.webkitImageSmoothingEnabled = false;
    ctx.msImageSmoothingEnabled = false;

    ctx.drawImage(img, 0, 0, w, h);

    const rawImageData = ctx.getImageData(0, 0, w, h);
    const decodedBytes = await unscramblePixivPixelArray(
      rawImageData.data,
      w,
      h,
      pageObj.gridsize,
      pageObj.gridsize,
      pageObj.key
    );

    ctx.putImageData(new ImageData(decodedBytes, w, h), 0, 0);

    const mimeType = isJpg ? 'image/jpeg' : 'image/png';
    const outExt = isJpg ? 'jpg' : 'png';
    const blob = await new Promise(r => canvas.toBlob(r, mimeType, CONFIG.JPEG_QUALITY));

    canvas.width = 0;
    canvas.height = 0;

    return {
      fileName: `${pageObj.pageNo}.${outExt}`,
      data: new Uint8Array(await blob.arrayBuffer())
    };
  }

  /* =========================================================================
   * 7. TIẾN TRÌNH TẢI CHÍNH (6 LUỒNG TRONG RAM)
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let data = state.chapterData;
      if (!data) {
        data = await fetchPixivPages();
        state.chapterData = data;
      }

      const { pages, seriesTitle, episodeTitle, episodeId } = data;
      const totalPages = pages.length;
      if (!totalPages) throw new Error("Không tìm thấy trang truyện hợp lệ.");

      const useJpeg = Boolean(state.convertJpeg);
      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      zip.addFile(`${episodeId}.txt`, new Uint8Array(0));

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map((pageObj) => () => processPixivImage(pageObj, useJpeg));

      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res?.data) zip.addFile(res.fileName, res.data);
      }

      const zipName = `${getCleanTitle(seriesTitle, episodeTitle)}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[pixiv-dl] Error:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * 8. KHỞI CHẠY VÀ THEO DÕI ĐIỀU HƯỚNG SPA
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(30);
    const ui = getUI();

    if (!isEpisodeUrl()) {
      if (ui?.panel) ui.panel.style.display = "none";
      return;
    }

    if (ui?.panel) ui.panel.style.display = "block";
    
    if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });

    let data = null;
    let retries = 0;

    while (retries < 30) {
      try {
        data = await fetchPixivPages();
        if (data && data.pages?.length > 0) break;
      } catch (e) {}
      await sleep(150);
      retries++;
    }

    if (data && data.pages?.length > 0) {
      state.chapterData = data;
      
      await sleep(80);

      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: data.pages.length,
          status: "Sẵn sàng."
        });
      }
    } else {
      if (ui) ui.updateProgress({ status: "Sẵn sàng." });
    }
  }

  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute(() => {
      state.chapterData = null;
      state.running = false;
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