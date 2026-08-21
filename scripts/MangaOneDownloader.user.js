// ==UserScript==
// @name         Manga-One Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      2.0.0
// @icon         https://www.google.com/s2/favicons?domain=manga-one.com&sz=128
// @description  Tải manga trên Manga-One.
// @author       anonymous & AI
// @match        https://manga-one.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      manga-one.com
// @connect      *.manga-one.com
// @connect      app.manga-one.com
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function mangaOneUniversalDownloader() {
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
    convertJpeg: localStorage.getItem("mangaone-dl:convert-jpeg") === '1',
    detectedSourceFormat: 'webp',
    chapterData: null,
    ui: null
  };

  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;
    if (typeof createUI === "function" && DOC.body) {
      state.ui = createUI({
        storagePrefix: "mangaone-dl",
        title: "MangaOne Downloader",
        themeColor: "#e52865",
        themeBg: "#171113",
        titleColor: "#f472b6",
        topOffset: "70px",
        defaultJpgText: "Xuất file JPG (ảnh gốc là WebP)",
        onDownload: startDownload,
        onJpgChange: (checked) => { state.convertJpeg = checked; }
      });
    }
    return state.ui;
  }

  /* =========================================================================
   * HELPER FUNCTIONS
   * ========================================================================= */
  function isEpisodeUrl() {
    return /\/manga\/\d+\/chapter\/\d+/.test(WIN.location.pathname);
  }

  function getIdsFromUrl() {
    try {
      const match = WIN.location.pathname.match(/\/manga\/(\d+)\/chapter\/(\d+)/);
      if (match) return { titleId: match[1], chapterId: match[2] };
    } catch (e) {}
    return { titleId: null, chapterId: null };
  }

  function cleanString(str) {
    if (!str) return "";
    return str.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').replace(/【[^】]*】/g, '').replace(/[\\/*?:"<>|]/g, '').trim();
  }

  function getCleanTitle() {
    try {
      let seriesTitle = "";
      let episodeTitle = "";

      const ogTitle = DOC.querySelector('meta[property="og:title"]')?.getAttribute('content');
      let rawTitle = (ogTitle || DOC.title || "").split('｜')[0].split('|')[0].trim();

      const match = rawTitle.match(/^(.*?)\s+(第?\s*\d+\s*(?:話|曲|局|話目|限目|時限目|部|エピソード)?.*)$/i);
      if (match) {
        seriesTitle = cleanString(match[1]);
        episodeTitle = cleanString(match[2]);
      } else {
        seriesTitle = cleanString(rawTitle);
      }

      if (seriesTitle && episodeTitle && !seriesTitle.includes(episodeTitle)) {
        return `${seriesTitle} - ${episodeTitle}`;
      }
      return seriesTitle || episodeTitle || `MangaOne_${getIdsFromUrl().chapterId}`;
    } catch (e) {
      return `MangaOne_${getIdsFromUrl().chapterId || 'Episode'}`;
    }
  }

  /* =========================================================================
   * API CLIENT V2 & GIẢI MÃ AES-CBC PHẦN CỨNG
   * ========================================================================= */
  async function fetchChapterConfig(titleId, chapterId) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    const apiUrl = `https://manga-one.com/api/client?rq=viewer_v2&title_id=${titleId}&chapter_id=${chapterId}`;
    
    // Gửi POST request lấy chuỗi cấu hình
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: apiUrl,
        headers: { "Accept": "*/*", "Origin": "https://manga-one.com", "Referer": WIN.location.href },
        onload: res => (res.status >= 200 && res.status < 300) ? resolve(res.responseText) : reject(new Error(`HTTP ${res.status}`)),
        onerror: () => reject(new Error("Lỗi kết nối API MangaOne.")),
        ontimeout: () => reject(new Error("Timeout kết nối API."))
      });
    });
  }

  function parseConfigString(configString, chapterId) {
    const urlRegex = new RegExp(`https:\\/\\/app\\.manga-one\\.com\\/.*\\/${chapterId}\\/.*expires=\\d{10}`, 'g');
    const matchedUrls = configString.match(urlRegex);
    if (!matchedUrls || matchedUrls.length === 0) throw new Error("Không tìm thấy danh sách ảnh.");

    if (matchedUrls[0].includes('/webp/') || matchedUrls[0].includes('.webp')) {
      state.detectedSourceFormat = 'webp';
    } else if (matchedUrls[0].includes('/png/') || matchedUrls[0].includes('.png')) {
      state.detectedSourceFormat = 'png';
    } else if (matchedUrls[0].includes('/jpg/') || matchedUrls[0].includes('.jpg') || matchedUrls[0].includes('.jpeg')) {
      state.detectedSourceFormat = 'jpg';
    }

    const ui = getUI();
    if (ui) ui.updateFormatUI(state.detectedSourceFormat);

    const cryptoMatch = configString.match(/(?<key>[0-9a-f]{64}).*(?<iv>[0-9a-f]{32})/);
    const cryptoData = cryptoMatch ? cryptoMatch.groups : null;

    return matchedUrls.map((url, idx) => {
      const isEncrypted = url.includes('.enc?');
      return {
        pageNo: idx + 1,
        url: url,
        isEncrypted: isEncrypted,
        crypto: isEncrypted ? cryptoData : null
      };
    });
  }

  function unhex(hexString) {
    const arr = new Uint8Array(hexString.length / 2);
    for (let i = 0; i < hexString.length; i += 2) arr[i / 2] = parseInt(hexString.substring(i, i + 2), 16);
    return arr;
  }

  async function decryptAndFormatImage(pageItem, forceJpg) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    let buffer = await Utils.fetchBuffer(pageItem.url, { "Referer": "https://manga-one.com/" });

    // 1. Giải mã AES-CBC nếu có cờ .enc
    if (pageItem.isEncrypted && pageItem.crypto?.key && pageItem.crypto?.iv) {
      const cryptoKey = await WIN.crypto.subtle.importKey('raw', unhex(pageItem.crypto.key), { name: 'AES-CBC' }, false, ['decrypt']);
      buffer = await WIN.crypto.subtle.decrypt({ name: 'AES-CBC', iv: unhex(pageItem.crypto.iv) }, cryptoKey, buffer);
    }

    const uint8 = new Uint8Array(buffer);

    // 2. Nhận diện Magic Bytes
    let ext = 'jpg';
    if (uint8[0] === 0x52 && uint8[1] === 0x49 && uint8[2] === 0x46 && uint8[3] === 0x46) ext = 'webp';
    else if (uint8[0] === 0x89 && uint8[1] === 0x50 && uint8[2] === 0x4E && uint8[3] === 0x47) ext = 'png';
    else if (uint8[0] === 0xFF && uint8[1] === 0xD8 && uint8[2] === 0xFF) ext = 'jpg';

    const fileName = `${pageItem.pageNo}.${forceJpg ? 'jpg' : ext}`;
    if (ext === 'jpg' || !forceJpg) return { fileName, data: uint8 };

    // 3. Chuyển sang JPG nếu người dùng chọn
    const img = await Utils.loadImage(uint8, `image/${ext}`);
    const canvas = DOC.createElement('canvas');
    canvas.width = img.naturalWidth || 720;
    canvas.height = img.naturalHeight || 1020;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);

    const jpgBlob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', CONFIG.JPEG_QUALITY));
    canvas.width = 0; canvas.height = 0;

    return { fileName, data: new Uint8Array(await jpgBlob.arrayBuffer()) };
  }

  /* =========================================================================
   * CHƯƠNG TRÌNH TẢI CHÍNH
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    const { titleId, chapterId } = getIdsFromUrl();
    if (!titleId || !chapterId) {
      if (ui) ui.updateProgress({ status: "Lỗi: Không tìm thấy ID chương." });
      return;
    }

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let pages = state.chapterData;
      if (!pages || pages.length === 0) {
        const configText = await fetchChapterConfig(titleId, chapterId);
        pages = parseConfigString(configText, chapterId);
        state.chapterData = pages;
      }

      const totalPages = pages.length;
      if (!totalPages) throw new Error("Không có trang hợp lệ.");

      const forceJpg = Boolean(state.convertJpeg) || (state.detectedSourceFormat === 'jpg');
      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      zip.addFile(`${chapterId}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      // Tải và giải mã song song 6 luồng
      const tasks = pages.map(pageItem => () => decryptAndFormatImage(pageItem, forceJpg));
      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res?.data) zip.addFile(res.fileName, res.data);
      }

      zip.download(`${getCleanTitle()}.zip`);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[mangaone-dl] Error:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * KHỞI CHẠY VÀ SPA WATCHER
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

    const { titleId, chapterId } = getIdsFromUrl();
    if (!titleId || !chapterId) return;

    try {
      const configText = await fetchChapterConfig(titleId, chapterId);
      const pages = parseConfigString(configText, chapterId);
      state.chapterData = pages;

      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: pages.length,
          status: "Sẵn sàng."
        });
      }
    } catch (err) {
      console.error("[mangaone-dl] Boot error:", err);
      if (ui) ui.updateProgress({ status: "Sẵn sàng." });
    }
  }

  // Khởi động SPA Route Watcher
  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute(() => {
      state.chapterData = null;
      state.running = false;
      const ui = getUI();
      if (ui) ui.setBusy(false);
      boot();
    });
  }

  if (DOC.readyState === "loading") {
    DOC.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();