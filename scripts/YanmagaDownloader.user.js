// ==UserScript==
// @name         Yanmaga Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      3.0.0
// @icon         https://www.google.com/s2/favicons?domain=yanmaga.jp&sz=128
// @description  Tải manga trên Yanmaga Web siêu tốc qua API trực tiếp & giải mã CoordDecoder.
// @author       anonymous & AI
// @match        https://yanmaga.jp/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      yanmaga.jp
// @connect      *.yanmaga.jp
//
// --- GỌI CÁC MODULE DÙNG CHUNG TỪ REPO CỦA BẠN ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/core/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/core/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/core/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/decoders/SpeedReaderTools.js
// ==/UserScript==

(function yanmagaUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH & KHỞI TẠO
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6,   // 6 luồng tải và giải mã song song
    JPEG_QUALITY: 0.95   // Chất lượng xuất JPG nếu chuyển đổi
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("yanmaga-dl:convert-jpeg") === '1',
    chapterData: null
  };

  // Khởi tạo UI đa năng dùng chung từ core/UniversalUI.js
  const ui = (window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI)({
    storagePrefix: "yanmaga-dl",
    title: "Yanmaga Downloader",
    themeColor: "#eab308",
    themeBg: "#18181b",
    titleColor: "#fde047",
    topOffset: "76px",
    defaultJpgText: "Xuất file JPG (mặc định PNG)",
    onDownload: startDownload,
    onJpgChange: (checked) => { state.convertJpeg = checked; }
  });

  /* =========================================================================
   * HELPER FUNCTIONS
   * ========================================================================= */
  function isEpisodeUrl() {
    return /^\/viewer\/comics\//.test(WIN.location.pathname);
  }

  function getCleanMangaTitle() {
    try {
      let rawTitle = DOC.title || "";
      let clean = rawTitle.split('｜')[0].split('|')[0].trim();
      clean = clean.replace(/[\\/*?:"<>|]/g, '').trim();
      return clean || getCidPrefix() || "Yanmaga_Manga";
    } catch (e) {
      return getCidPrefix() || "Yanmaga_Manga";
    }
  }

  function getCidPrefix() {
    try {
      const contentEl = DOC.getElementById('content');
      const cid = contentEl?.getAttribute('data-ptbinb-cid') || contentEl?.dataset?.ptbinbCid;
      if (cid) return cid.trim();
    } catch (e) {}
    const cid = new URLSearchParams(WIN.location.search).get("cid");
    if (cid) return cid;
    const match = WIN.location.href.match(/([a-zA-Z0-9_-]{8,})/);
    return match ? match[1] : "Yanmaga_Episode";
  }

  async function waitForCid(timeoutMs = 15000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const cid = getCidPrefix();
      if (cid && cid !== "Yanmaga_Episode") return cid;
      await sleep(100);
    }
    return getCidPrefix();
  }

  /* =========================================================================
   * API CLIENT SPEEDBINB & GIẢI MÃ MA TRẬN
   * ========================================================================= */
  async function fetchSpeedBinbManifest(cid) {
    const Tools = window.SpeedReaderTools || globalThis.SpeedReaderTools;
    const randomString = Tools.generateRandomString32(cid);
    const infoUrl = `https://yanmaga.jp/viewer/bibGetCntntInfo?cid=${cid}&dmytime=${Date.now()}&k=${randomString}&type=comics`;

    // 1. Lấy thông tin cấu hình từ bibGetCntntInfo
    const infoRes = await new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: infoUrl,
        responseType: "json",
        timeout: 15000,
        onload: res => {
          if (res.status >= 200 && res.status < 300 && res.response?.items?.[0]) {
            resolve(res.response.items[0]);
          } else {
            reject(new Error(`bibGetCntntInfo HTTP ${res.status}`));
          }
        },
        onerror: () => reject(new Error("Lỗi kết nối API")),
        ontimeout: () => reject(new Error("Timeout kết nối API"))
      });
    });

    const config = {
      title: infoRes.Title,
      contentServer: infoRes.ContentsServer,
      ctbl: Tools.getDecryptedTable(cid, randomString, infoRes.ctbl),
      ptbl: Tools.getDecryptedTable(cid, randomString, infoRes.ptbl)
    };

    // 2. Lấy cấu trúc trang TTX
    const ttxRes = await new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: `${config.contentServer}/content`,
        responseType: "json",
        timeout: 15000,
        onload: res => {
          if (res.status >= 200 && res.status < 300 && res.response?.ttx) {
            resolve(res.response.ttx);
          } else {
            reject(new Error(`TTX HTTP ${res.status}`));
          }
        },
        onerror: () => reject(new Error("Lỗi tải cấu trúc TTX")),
        ontimeout: () => reject(new Error("Timeout tải TTX"))
      });
    });

    // 3. Lọc danh sách trang duy nhất qua Set (chất lượng gốc ?q=1)
    const matchResult = ttxRes.matchAll(/(pages\/[a-zA-Z0-9_]*.jpg)[^A-Z]*orgwidth="(\d*)" orgheight="(\d*)"/gm);
    const seen = new Set();
    const files = [];

    for (const match of matchResult) {
      const filename = match[1];
      if (!seen.has(filename)) {
        seen.add(filename);
        files.push({
          pageNo: files.length + 1,
          filename: filename,
          width: parseInt(match[2], 10),
          height: parseInt(match[3], 10),
          src: `${config.contentServer}/img/${filename}?q=1`
        });
      }
    }

    return { config, files };
  }

  function fetchImageArrayBuffer(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: url,
        responseType: "arraybuffer",
        timeout: 25000,
        onload: res => {
          if (res.status >= 200 && res.status < 300 && res.response) {
            resolve(res.response);
          } else {
            reject(new Error(`HTTP ${res.status}`));
          }
        },
        onerror: () => reject(new Error("Lỗi tải ảnh")),
        ontimeout: () => reject(new Error("Timeout tải ảnh"))
      });
    });
  }

  async function descrambleAndFormatImage(fileObj, config, isJpg) {
    const Tools = window.SpeedReaderTools || globalThis.SpeedReaderTools;
    const rawBuffer = await fetchImageArrayBuffer(fileObj.src);
    const blob = new Blob([rawBuffer], { type: 'image/jpeg' });
    const objUrl = WIN.URL.createObjectURL(blob);

    const img = new WIN.Image();
    img.decoding = "async";

    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = objUrl;
    });
    WIN.URL.revokeObjectURL(objUrl);

    const canvas = DOC.createElement('canvas');
    canvas.width = fileObj.width;
    canvas.height = fileObj.height;

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, fileObj.width, fileObj.height);

    // Giải mã mảnh ghép bằng CoordDecoder
    const key = Tools.getDecryptionKey(fileObj.filename, config.ctbl, config.ptbl);
    const decoder = new Tools.CoordDecoder(key[0], key[1]);
    const coords = decoder.getCoords(img);

    for (const { srcX, srcY, destX, destY, width, height } of coords) {
      ctx.drawImage(img, srcX, srcY, width, height, destX, destY, width, height);
    }

    const mimeType = isJpg ? 'image/jpeg' : 'image/png';
    const quality = isJpg ? CONFIG.JPEG_QUALITY : undefined;
    const outExt = isJpg ? 'jpg' : 'png';

    const outBlob = await new Promise(resolve => canvas.toBlob(resolve, mimeType, quality));
    const outBuffer = await outBlob.arrayBuffer();

    canvas.width = 0;
    canvas.height = 0;

    return {
      fileName: `${fileObj.pageNo}.${outExt}`,
      data: new Uint8Array(outBuffer)
    };
  }

  /* =========================================================================
   * TIẾN TRÌNH TẢI SONG SONG
   * ========================================================================= */
  async function runParallelQueue(tasks, limit, onProgress) {
    const results = new Array(tasks.length);
    let completed = 0;
    let index = 0;

    const workers = Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
      while (index < tasks.length) {
        const currentIndex = index++;
        try {
          results[currentIndex] = await tasks[currentIndex]();
        } catch (err) {
          console.error(`[yanmaga-dl] Lỗi trang ${currentIndex + 1}:`, err);
          results[currentIndex] = null;
        } finally {
          completed++;
          onProgress(completed, tasks.length);
        }
      }
    });

    await Promise.all(workers);
    return results;
  }

  function triggerDownload(blob, fileName) {
    const url = WIN.URL.createObjectURL(blob);
    const a = DOC.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = "noopener";
    a.style.display = "none";
    DOC.documentElement.appendChild(a);
    a.click();
    a.remove();
    WIN.setTimeout(() => WIN.URL.revokeObjectURL(url), 60000);
  }

  /* =========================================================================
   * CHƯƠNG TRÌNH TẢI CHÍNH
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;

    const cid = await waitForCid(5000);
    if (!cid || cid === "Yanmaga_Episode") {
      ui.updateProgress({ status: "Lỗi: Không tìm thấy CID." });
      return;
    }

    state.running = true;
    ui.setBusy(true);

    try {
      ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let data = state.chapterData;
      if (!data || !data.files?.length) {
        data = await fetchSpeedBinbManifest(cid);
        state.chapterData = data;
      }

      const { config, files } = data;
      const totalPages = files.length;
      if (!totalPages) throw new Error("Không tìm thấy trang truyện.");

      const useJpeg = Boolean(state.convertJpeg);
      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const zip = new ZipClass();

      zip.addFile(`${cid}.txt`, new Uint8Array(0));
      ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = files.map((fileObj) => async () => {
        return await descrambleAndFormatImage(fileObj, config, useJpeg);
      });

      const results = await runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      let savedCount = 0;
      for (const res of results) {
        if (res && res.data) {
          zip.addFile(res.fileName, res.data);
          savedCount++;
        }
      }

      if (savedCount === 0) throw new Error("Lỗi đóng gói ảnh vào ZIP.");

      const zipBlob = zip.generateBlob();
      const zipFileName = `${getCleanMangaTitle()}.zip`;
      triggerDownload(zipBlob, zipFileName);

      ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      ui.updateProgress({ status: "Lỗi: " + (err?.message || String(err)) });
      console.error("[yanmaga-dl] Error:", err);
    } finally {
      state.running = false;
      ui.setBusy(false);
    }
  }

  /* =========================================================================
   * KHỞI CHẠY VÀ SPA WATCHER
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(50);

    if (!isEpisodeUrl()) {
      if (ui?.panel) ui.panel.style.display = "none";
      return;
    }

    if (ui?.panel) ui.panel.style.display = "block";
    ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });

    const cid = await waitForCid(10000);
    if (!cid || cid === "Yanmaga_Episode") return;

    try {
      const data = await fetchSpeedBinbManifest(cid);
      state.chapterData = data;
      ui.updateProgress({
        completed: 0,
        total: data.files.length,
        status: "Sẵn sàng."
      });
    } catch (err) {
      ui.updateProgress({
        completed: 0,
        total: 0,
        status: "Đang kiểm tra..."
      });
    }
  }

  // Khởi động SPA Route Watcher từ core/RouteWatcher.js
  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute(() => {
      state.chapterData = null;
      state.running = false;
      ui.setBusy(false);
      boot();
    });
  }

  if (DOC.readyState === "loading") {
    DOC.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();