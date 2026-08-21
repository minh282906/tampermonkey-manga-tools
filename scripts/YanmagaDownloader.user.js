// ==UserScript==
// @name         Yanmaga Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      2.0.0
// @icon         https://www.google.com/s2/favicons?domain=yanmaga.jp&sz=128
// @description  Tải manga trên Yanmaga Web siêu tốc qua API trực tiếp & giải mã SpeedBinbTools.
// @author       anonymous & AI
// @match        https://yanmaga.jp/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      yanmaga.jp
// @connect      *.yanmaga.jp
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/decoders/SpeedBinbTools.js
// ==/UserScript==

(function yanmagaUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH & KHỞI TẠO
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6,   // 6 luồng tải song song
    JPEG_QUALITY: 0.95   // Chất lượng xuất JPG nếu chuyển đổi
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("yanmaga-dl:convert-jpeg") === '1',
    chapterData: null,
    ui: null
  };

  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;
    if (typeof createUI === "function" && DOC.body) {
      state.ui = createUI({
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
    }
    return state.ui;
  }

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
      return clean.replace(/[\\/*?:"<>|]/g, '').trim() || "Yanmaga_Manga";
    } catch (e) {
      return "Yanmaga_Manga";
    }
  }

  async function waitForCid(timeoutMs = 15000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const contentEl = DOC.getElementById('content');
      const cid = contentEl?.getAttribute('data-ptbinb-cid') || contentEl?.dataset?.ptbinbCid || new URLSearchParams(WIN.location.search).get("cid");
      if (cid && cid.trim()) return cid.trim();
      await sleep(100);
    }
    return null;
  }

  /* =========================================================================
   * API CLIENT SPEEDBINB & GIẢI MÃ MA TRẬN
   * ========================================================================= */
  async function fetchSpeedBinbManifest(cid) {
    const Tools = window.SpeedBinbTools || globalThis.SpeedBinbTools;
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    if (!Tools || !Utils) throw new Error("Chưa nạp xong SpeedBinbTools/MangaUtils.");

    const randomString = Tools.generateRandomString32(cid);
    const infoUrl = `https://yanmaga.jp/viewer/bibGetCntntInfo?cid=${cid}&dmytime=${Date.now()}&k=${randomString}&type=comics`;

    const infoBuffer = await Utils.fetchBuffer(infoUrl);
    const infoRes = JSON.parse(new TextDecoder().decode(infoBuffer)).items[0];

    const config = {
      title: infoRes.Title,
      contentServer: infoRes.ContentsServer,
      ctbl: Tools.getDecryptedTable(cid, randomString, infoRes.ctbl),
      ptbl: Tools.getDecryptedTable(cid, randomString, infoRes.ptbl)
    };

    const ttxBuffer = await Utils.fetchBuffer(`${config.contentServer}/content`);
    const ttxText = JSON.parse(new TextDecoder().decode(ttxBuffer)).ttx;

    const seen = new Set();
    const files = [];

    for (const match of ttxText.matchAll(/(pages\/[a-zA-Z0-9_]*.jpg)[^A-Z]*orgwidth="(\d*)" orgheight="(\d*)"/gm)) {
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

  async function descrambleAndFormatImage(fileObj, config, isJpg) {
    const Tools = window.SpeedBinbTools || globalThis.SpeedBinbTools;
    const Utils = window.MangaUtils || globalThis.MangaUtils;

    const rawBuffer = await Utils.fetchBuffer(fileObj.src);
    const img = await Utils.loadImage(rawBuffer);

    const canvas = DOC.createElement('canvas');
    canvas.width = fileObj.width;
    canvas.height = fileObj.height;

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, fileObj.width, fileObj.height);

    const key = Tools.getDecryptionKey(fileObj.filename, config.ctbl, config.ptbl);
    const decoder = new Tools.CoordDecoder(key[0], key[1]);
    const coords = decoder.getCoords(img);

    for (const { srcX, srcY, destX, destY, width, height } of coords) {
      ctx.drawImage(img, srcX, srcY, width, height, destX, destY, width, height);
    }

    const mimeType = isJpg ? 'image/jpeg' : 'image/png';
    const outExt = isJpg ? 'jpg' : 'png';
    const blob = await new Promise(r => canvas.toBlob(r, mimeType, CONFIG.JPEG_QUALITY));

    canvas.width = 0;
    canvas.height = 0;

    return {
      fileName: `${fileObj.pageNo}.${outExt}`,
      data: new Uint8Array(await blob.arrayBuffer())
    };
  }

  /* =========================================================================
   * CHƯƠNG TRÌNH TẢI CHÍNH
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    const cid = await waitForCid(5000);
    if (!cid) {
      if (ui) ui.updateProgress({ status: "Lỗi: Không tìm thấy CID." });
      return;
    }

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let data = state.chapterData || await fetchSpeedBinbManifest(cid);
      state.chapterData = data;

      const { config, files } = data;
      const totalPages = files.length;
      if (!totalPages) throw new Error("Không tìm thấy trang truyện.");

      const useJpeg = Boolean(state.convertJpeg);
      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      zip.addFile(`${cid}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = files.map(fileObj => () => descrambleAndFormatImage(fileObj, config, useJpeg));
      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res?.data) zip.addFile(res.fileName, res.data);
      }

      zip.download(`${getCleanMangaTitle()}.zip`);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[yanmaga-dl] Error:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * KHỞI CHẠY VÀ SPA WATCHER
   * ========================================================================= */
  async function boot() {
    // Đảm bảo document.body ĐÃ XUẤT HIỆN 100% trước khi vẽ UI
    while (!DOC.body) await sleep(30);

    const ui = getUI();

    if (!isEpisodeUrl()) {
      if (ui?.panel) ui.panel.style.display = "none";
      return;
    }

    if (ui?.panel) ui.panel.style.display = "block";
    if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });

    const cid = await waitForCid(15000);
    if (!cid) {
      if (ui) ui.updateProgress({ status: "Lỗi: Không tìm thấy CID." });
      return;
    }

    try {
      const data = await fetchSpeedBinbManifest(cid);
      state.chapterData = data;
      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: data.files.length,
          status: "Sẵn sàng."
        });
      }
    } catch (e) {
      console.error("[yanmaga-dl] Boot error:", e);
      if (ui) ui.updateProgress({ status: "Lỗi: " + (e?.message || e) });
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