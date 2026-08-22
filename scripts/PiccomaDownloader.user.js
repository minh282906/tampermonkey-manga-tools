// ==UserScript==
// @name         Piccoma Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      2.0.0
// @icon         https://www.google.com/s2/favicons?domain=piccoma.com&sz=128
// @description  Tải manga trên Piccoma.
// @author       anonymous & AI
// @match        https://piccoma.com/web/viewer/*
// @match        https://jp.piccoma.com/web/viewer/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      piccoma.com
// @connect      *.piccoma.com
// @connect      *.kakaocdn.net
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function piccomaUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 4,   // 4 luồng tải song song (chuẩn an toàn cho web giải mã Wasm/Canvas)
    JPEG_QUALITY: 0.95   // Chất lượng xuất JPG nếu chọn
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  // Bắt giữ _pdata_ trực tiếp từ RAM ngay khi web khởi tạo
  let capturedPData = null;
  try {
    Object.defineProperty(WIN, '_pdata_', {
      configurable: true,
      enumerable: true,
      get() { return capturedPData; },
      set(v) { capturedPData = v; }
    });
  } catch (e) {}

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("piccoma-dl:convert-jpeg") === '1',
    cachedData: null,
    ui: null
  };

  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "piccoma-dl",
        title: "Piccoma",
        engine: "KAKAO",
        themeColor: "#eab308",
        themeBg: "#0f172a",
        titleColor: "#fde047",
        topOffset: "52px",
        defaultJpgText: "Xuất file JPG (mặc định PNG)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("piccoma-dl:convert-jpeg", checked ? '1' : '0');
        }
      };

      state.ui = createUI(uiConfig);

      // Tiêu đề 2 tầng (ẩn tầng 2 bằng visibility: hidden để cố định khoảng trống)
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
   * BỘ HỖ TRỢ XỬ LÝ CHUỖI & TÊN FILE CHUẨN
   * ========================================================================= */
  function isEpisodeUrl() {
    return /\/viewer\/(?:[a-zA-Z]+\/)?\d+\/\d+/.test(WIN.location.pathname);
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

  function getEpisodeId() {
    try {
      const match = WIN.location.pathname.match(/\/viewer\/(?:[a-zA-Z]+\/)?\d+\/(\d+)/);
      if (match && match[1]) return match[1];
      if (state.cachedData?.episode_id) return String(state.cachedData.episode_id);
    } catch (e) {}
    return "piccoma_episode";
  }

  // BẮT BUỘC: [Tên Truyện] - [Tên Tập/Chap].zip
  function getCleanTitle() {
    try {
      let seriesTitle = "";
      let episodeTitle = state.cachedData?.title || "";

      if (DOC.title) {
        let raw = DOC.title.replace(/\s*[-|｜]\s*ピッコマ.*/i, '').trim();
        raw = raw.replace(/^公式\s*[-－_]?\s*/i, '').trim();
        raw = raw.replace(/【[^】]*】/g, '').trim();

        const parts = raw.split(/[｜|]/);
        if (parts.length >= 2) {
          if (!episodeTitle) episodeTitle = parts[0];
          seriesTitle = parts[1].replace(/\([^)]*\)/g, '');
        } else {
          const match = raw.match(/^(.*?)(?:\s+[-－–—/]\s+|\s+)((?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\s\-\–\—\ー\~〜\.]+(?:話|巻|章|節|部|エピソード|分冊版|単話|前編|中編|後編)?.*)$/i);
          if (match) {
            seriesTitle = match[1];
            if (!episodeTitle) episodeTitle = match[2];
          } else if (!seriesTitle) {
            seriesTitle = raw;
          }
        }
      }

      let cleanSeries = cleanString(seriesTitle);
      cleanSeries = cleanSeries.replace(/（[^）]*(?:コミック|文庫|レーベル|出版|COMIC|WEB)[^）]*）$/i, '').trim();
      cleanSeries = cleanSeries.replace(/\([^)]*(?:コミック|文庫|レーベル|出版|COMIC|WEB)[^)]*\)$/i, '').trim();

      let cleanEpisode = cleanString(episodeTitle);

      // Cắt bỏ phần tên truyện nếu bị lặp lại trong tên chap
      let baseWithoutVol = cleanSeries.replace(/\s*[0-9０-９]+\s*巻.*$/i, '').trim();
      if (baseWithoutVol && cleanEpisode.startsWith(baseWithoutVol)) {
        cleanEpisode = cleanString(cleanEpisode.substring(baseWithoutVol.length));
      }

      if (cleanSeries && cleanEpisode && cleanEpisode !== getEpisodeId() && !cleanSeries.includes(cleanEpisode)) {
        return `${cleanSeries} - ${cleanEpisode}`;
      } else if (cleanSeries && cleanEpisode && cleanEpisode !== getEpisodeId()) {
        return cleanEpisode;
      } else if (cleanSeries) {
        return `${cleanSeries} - ${getEpisodeId()}`;
      }
    } catch (e) {}

    return `Piccoma_${getEpisodeId()}`;
  }

  /* =========================================================================
   * BÓC TÁCH DỮ LIỆU _pdata_
   * ========================================================================= */
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
          if (inStr) {
            if (ch === q && text[i - 1] !== '\\') inStr = false;
          } else {
            if (ch === '"' || ch === "'") { inStr = true; q = ch; }
            else if (ch === '{') depth++;
            else if (ch === '}') {
              depth--;
              if (depth === 0) { end = i; break; }
            }
          }
        }
        if (end !== -1) {
          try {
            const data = new Function('return (' + text.substring(start, end + 1) + ');')();
            if (data?.img?.length > 0) {
              capturedPData = data;
              return data;
            }
          } catch (e) {}
        }
      }
    }
    return null;
  }

  function fetchPiccomaPages() {
    const pdata = extractPData();
    if (!pdata || !Array.isArray(pdata.img) || pdata.img.length === 0) {
      return [];
    }

    state.cachedData = pdata;
    if (!WIN._pdata_) WIN._pdata_ = pdata;

    const isScrambled = Boolean(pdata.isScrambled);
    const validPages = [];
    let pageNo = 1;

    for (let i = 0; i < pdata.img.length; i++) {
      const item = pdata.img[i];
      let url = item.path || item.src || item.url || '';
      if (!url) continue;
      if (url.startsWith('//')) url = 'https:' + url;

      // Loại bỏ ảnh rác kết thúc
      if (!url.includes('/dna/') && !/\.(?:jpg|jpeg|png|webp)/i.test(url)) {
        continue;
      }

      validPages.push({
        pageNo: pageNo++,
        url: url,
        width: item.width || 0,
        height: item.height || 0,
        isScrambled: isScrambled
      });
    }

    return validPages;
  }

  /* =========================================================================
   * THUẬT TOÁN GIẢI MÃ MA TRẬN 50PX TILE TRONG RAM (WASM ENGINE)
   * ========================================================================= */
  function getChecksum(url) {
    try {
      const clean = url.split('?')[0];
      const parts = clean.split('/');
      return parts[parts.length - 2] || '';
    } catch { return ''; }
  }

  function getSeed(checksum, expires) {
    if (!expires || !checksum) return checksum;
    let sum = 0;
    for (let i = 0; i < expires.length; i++) {
      const digit = parseInt(expires[i], 10);
      if (!isNaN(digit)) sum += digit;
    }
    const shift = sum % checksum.length;
    if (shift === 0) return checksum;
    return checksum.slice(-shift) + checksum.slice(0, -shift);
  }

  async function computeImageSeed(url) {
    const checksum = getChecksum(url);
    const match = url.match(/[?&]expires=([0-9]+)/);
    const expires = match ? match[1] : '';
    const rawSeed = getSeed(checksum, expires);

    // Gọi hàm WebAssembly dd của Piccoma
    let attempts = 0;
    while (attempts < 30) {
      if (typeof WIN.dd === "function") {
        try {
          return WIN.dd(rawSeed);
        } catch (e) {}
      }
      await sleep(50);
      attempts++;
    }
    return rawSeed;
  }

  async function processPiccomaImage(rawBuffer, pageObj, isJpg) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    const TILE_SIZE = 50; // Hằng số ma trận cắt mảnh 50px

    if (!pageObj.isScrambled) {
      const uint8 = new Uint8Array(rawBuffer);
      let ext = 'jpg';
      if (uint8[0] === 0x89 && uint8[1] === 0x50) ext = 'png';
      else if (uint8[0] === 0x52 && uint8[1] === 0x49) ext = 'webp';

      if (!isJpg || ext === 'jpg') {
        return { fileName: `${pageObj.pageNo}.${ext}`, data: uint8 };
      }
    }

    const img = await Utils.loadImage(rawBuffer);
    let unscrambledCanvas = null;

    if (pageObj.isScrambled) {
      const seed = await computeImageSeed(pageObj.url);

      if (!WIN._pdata_ && state.cachedData) {
        WIN._pdata_ = state.cachedData;
      }

      let attempts = 0;
      while (attempts < 30 && typeof WIN.unscrambleImg !== "function") {
        await sleep(50);
        attempts++;
      }

      if (typeof WIN.unscrambleImg === "function") {
        const res = WIN.unscrambleImg(img, TILE_SIZE, seed);
        unscrambledCanvas = Array.isArray(res) ? res[0] : res;
      }
    }

    const outWidth = unscrambledCanvas ? unscrambledCanvas.width : (img.naturalWidth || img.width);
    const outHeight = unscrambledCanvas ? unscrambledCanvas.height : (img.naturalHeight || img.height);

    if (outWidth === 0 || outHeight === 0) {
      throw new Error("Kích thước ảnh không hợp lệ.");
    }

    const outCanvas = DOC.createElement('canvas');
    outCanvas.width = outWidth;
    outCanvas.height = outHeight;

    const ctx = outCanvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, outWidth, outHeight);

    if (unscrambledCanvas) {
      ctx.drawImage(unscrambledCanvas, 0, 0);
      unscrambledCanvas.width = 0;
      unscrambledCanvas.height = 0;
    } else {
      ctx.drawImage(img, 0, 0, outWidth, outHeight);
    }

    const mimeType = isJpg ? 'image/jpeg' : 'image/png';
    const outExt = isJpg ? 'jpg' : 'png';
    const blob = await new Promise(r => outCanvas.toBlob(r, mimeType, CONFIG.JPEG_QUALITY));

    outCanvas.width = 0;
    outCanvas.height = 0;

    return {
      fileName: `${pageObj.pageNo}.${outExt}`,
      data: new Uint8Array(await blob.arrayBuffer())
    };
  }

  /* =========================================================================
   * TIẾN TRÌNH TẢI CHÍNH (4 LUỒNG TRONG RAM)
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let pages = state.chapterData;
      if (!pages || pages.length === 0) {
        pages = fetchPiccomaPages();
        state.chapterData = pages;
      }

      const totalPages = pages.length;
      if (!totalPages) throw new Error("Không tìm thấy dữ liệu trang.");

      const useJpeg = Boolean(state.convertJpeg);
      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file txt định danh ID tập vào thư mục gốc ZIP
      const episodeId = getEpisodeId();
      zip.addFile(`${episodeId}.txt`, new Uint8Array(0));

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map((pageObj) => async () => {
        const rawBuffer = await Utils.fetchBuffer(pageObj.url);
        return await processPiccomaImage(rawBuffer, pageObj, useJpeg);
      });

      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res?.data) zip.addFile(res.fileName, res.data);
      }

      const zipName = `${getCleanTitle()}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[piccoma-dl] Error:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * KHỞI CHẠY VÀ THEO DÕI SPA
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(30);
    const ui = getUI();

    if (!isEpisodeUrl()) {
      if (ui?.panel) ui.panel.style.display = "none";
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
      return;
    }

    if (ui?.panel) ui.panel.style.display = "block";
    if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });

    let pages = [];
    let retries = 0;

    while (retries < 30) {
      pages = fetchPiccomaPages();
      if (pages.length > 0) break;
      await sleep(150);
      retries++;
    }

    if (pages.length > 0) {
      state.chapterData = pages;
      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: pages.length,
          status: "Sẵn sàng."
        });
      }
    } else {
      if (ui) ui.updateProgress({ status: "Sẵn sàng." });
    }
  }

  // Khởi động SPA Route Watcher
  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute(() => {
      state.cachedData = null;
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