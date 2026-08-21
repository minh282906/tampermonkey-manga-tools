// ==UserScript==
// @name         Gaugau Futabanet Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      2.0.0
// @icon         https://www.google.com/s2/favicons?domain=gaugau.futabanet.jp&sz=128
// @description  Tải truyện trên Gaugau Futabanet.
// @author       anonymous & AI
// @match        https://gaugau.futabanet.jp/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      gaugau.futabanet.jp
// @connect      *.futabanet.jp
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/decoders/SpeedBinbTools.js
// ==/UserScript==

(function gaugauUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH & KHỞI TẠO
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6,   // 6 luồng tải và giải mã song song qua API
    JPEG_QUALITY: 0.95   // Chất lượng xuất JPG nếu chuyển đổi
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("gaugau-dl:convert-jpeg") === '1',
    chapterData: null,
    ui: null
  };

  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;
    if (typeof createUI === "function" && DOC.body) {
      state.ui = createUI({
        storagePrefix: "gaugau-dl",
        title: "Gaugau Downloader",
        themeColor: "#06b6d4",
        themeBg: "#083344",
        titleColor: "#67e8f9",
        topOffset: "75px",
        defaultJpgText: "Xuất file JPG (mặc định PNG)",
        onDownload: startDownload,
        onJpgChange: (checked) => { state.convertJpeg = checked; }
      });
    }
    return state.ui;
  }

  /* =========================================================================
   * HELPER FUNCTIONS & XỬ LÝ TIÊU ĐỀ CHUẨN
   * ========================================================================= */
  function isEpisodeUrl() {
    return /\/(?:episodes|viewer|list\/work\/[^\/]+\/episodes)\//.test(WIN.location.pathname) ||
           Boolean(DOC.getElementById('content')?.dataset?.ptbinbCid) ||
           Boolean(DOC.querySelector('.works_tateyomi__img'));
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
      const contentEl = DOC.getElementById('content');
      const cid = contentEl?.dataset?.ptbinbCid || contentEl?.getAttribute('data-ptbinb-cid');
      if (cid && cid.trim()) return cid.trim();

      const match = WIN.location.pathname.match(/episodes\/([a-zA-Z0-9_-]+)/);
      if (match && match[1]) return match[1];
    } catch (e) {}
    return "Gaugau_Episode";
  }

  // BẮT BUỘC: [Tên Truyện] - [Tên Tập/Chap].zip
  function getCleanTitle() {
    try {
      let seriesTitle = "";
      let episodeTitle = "";

      // 1. Ưu tiên lấy từ DOM nếu có
      const sEl = DOC.querySelector('.works_detail__title, .episode_header__title, .c-series-title, .works_tateyomi__title');
      if (sEl) seriesTitle = cleanString(sEl.textContent);

      const eEl = DOC.querySelector('.episode_detail__title, .episode_header__sub_title, .c-episode-title, .works_tateyomi__sub-title');
      if (eEl) episodeTitle = cleanString(eEl.textContent);

      // 2. Phân tích bóc tách từ document.title
      if (!seriesTitle || !episodeTitle) {
        let raw = DOC.title || "";
        
        // Bỏ toàn bộ phần slogan sau dấu ｜ hoặc |
        raw = raw.split(/[|｜]/)[0].trim();
        raw = raw.replace(/^公式\s*[-－_]?\s*/i, '').trim();
        raw = raw.replace(/【[^】]*】/g, '').trim();

        // Tách: [Tên truyện] [Tên chap] -> Group 1: Truyện, Group 2: Chap
        const match = raw.match(/^(.*?)\s+(第?\s*\d+\s*(?:話|章|節|部|エピソード|前編|中編|後編)?.*)$/i);
        if (match) {
          seriesTitle = cleanString(match[1]);
          episodeTitle = cleanString(match[2]);
        } else {
          seriesTitle = cleanString(raw);
          episodeTitle = getEpisodeId();
        }
      }

      if (seriesTitle && episodeTitle) {
        return `${seriesTitle} - ${episodeTitle}`;
      }
    } catch (e) {}

    return `Gaugau_${getEpisodeId()}`;
  }

  async function detectReaderInfo(timeoutMs = 15000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const contentEl = DOC.getElementById('content');
      const cid = contentEl?.dataset?.ptbinbCid || contentEl?.getAttribute('data-ptbinb-cid');
      const ptbinb = contentEl?.dataset?.ptbinb || contentEl?.getAttribute('data-ptbinb');

      if (cid && ptbinb) {
        return { type: 'binb', cid: cid.trim(), ptbinb: ptbinb.trim() };
      }

      const tateyomiImgs = DOC.querySelectorAll('.works_tateyomi__img img');
      if (tateyomiImgs.length > 0) {
        const validUrls = Array.from(tateyomiImgs)
          .map(img => img.getAttribute('data-src') || img.src)
          .filter(u => u && !u.startsWith('data:'));
        if (validUrls.length > 0) {
          return { type: 'tateyomi', urls: validUrls };
        }
      }

      await sleep(100);
    }
    return null;
  }

  /* =========================================================================
   * SPEEDBINB API CLIENT & GIẢI MÃ MA TRẬN TRỰC TIẾP
   * ========================================================================= */
  async function fetchBinbManifest(cid, ptbinb) {
    const Tools = window.SpeedBinbTools || globalThis.SpeedBinbTools;
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    if (!Tools || !Utils) throw new Error("Chưa nạp xong SpeedBinbTools/MangaUtils.");

    const randomString = Tools.generateRandomString32(cid);
    const delimiter = ptbinb.includes('?') ? '&' : '?';
    const apiUrl = `${WIN.location.origin}${ptbinb}${delimiter}dmytime=${Date.now()}&cid=${cid}&k=${randomString}`;

    const infoBuffer = await Utils.fetchBuffer(apiUrl);
    const infoJson = JSON.parse(new TextDecoder().decode(infoBuffer));
    const data = infoJson.items?.[0];
    if (!data || !data.ContentsServer) throw new Error("Không lấy được cấu hình ContentsServer.");

    const config = {
      title: data.Title || data.SubTitle || "",
      contentServer: data.ContentsServer,
      ctbl: Tools.getDecryptedTable(cid, randomString, data.ctbl),
      ptbl: Tools.getDecryptedTable(cid, randomString, data.ptbl)
    };

    const contentUrl = `${config.contentServer}/content.js?dmytime=${Date.now()}`;
    const contentBuffer = await Utils.fetchBuffer(contentUrl);
    const rawText = new TextDecoder().decode(contentBuffer);
    const cleanJson = rawText.replace(/^DataGet_Content\(/, '').replace(/\);?\s*$/, '');
    const { ttx } = JSON.parse(cleanJson);

    const seen = new Set();
    const files = [];

    for (const match of ttx.matchAll(/(pages\/[a-zA-Z0-9_]*.jpg)[^A-Z]*orgwidth="(\d*)" orgheight="(\d*)"/gm)) {
      const filename = match[1];
      if (!seen.has(filename)) {
        seen.add(filename);
        files.push({
          pageNo: files.length + 1,
          filename: filename,
          width: parseInt(match[2], 10),
          height: parseInt(match[3], 10),
          src: `${config.contentServer}/${filename}/M_L.jpg`
        });
      }
    }

    return { type: 'binb', config, files };
  }

  async function descrambleBinbImage(fileObj, config, isJpg) {
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

  async function processTateyomiImage(imgUrl, pageNo, isJpg) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    const rawBuffer = await Utils.fetchBuffer(imgUrl);
    const img = await Utils.loadImage(rawBuffer);

    const canvas = DOC.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);

    const mimeType = isJpg ? 'image/jpeg' : 'image/png';
    const outExt = isJpg ? 'jpg' : 'png';
    const blob = await new Promise(r => canvas.toBlob(r, mimeType, CONFIG.JPEG_QUALITY));

    canvas.width = 0; 
    canvas.height = 0;

    return {
      fileName: `${pageNo}.${outExt}`,
      data: new Uint8Array(await blob.arrayBuffer())
    };
  }

  /* =========================================================================
   * TIẾN TRÌNH TẢI CHÍNH (ĐA LUỒNG TRONG RAM)
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let readerData = state.chapterData;
      if (!readerData) {
        const info = await detectReaderInfo(10000);
        if (!info) throw new Error("Không phát hiện được viewer đọc truyện.");

        if (info.type === 'binb') {
          readerData = await fetchBinbManifest(info.cid, info.ptbinb);
        } else {
          readerData = { type: 'tateyomi', files: info.urls.map((u, i) => ({ pageNo: i + 1, src: u })) };
        }
        state.chapterData = readerData;
      }

      const files = readerData.files;
      const totalPages = files.length;
      if (!totalPages) throw new Error("Không có trang hợp lệ để tải.");

      const useJpeg = Boolean(state.convertJpeg);
      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file txt định danh ID tập
      const idPrefix = getEpisodeId();
      zip.addFile(`${idPrefix}.txt`, new Uint8Array(0));

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      let tasks = [];
      if (readerData.type === 'binb') {
        tasks = files.map(fileObj => () => descrambleBinbImage(fileObj, readerData.config, useJpeg));
      } else {
        tasks = files.map(fileObj => () => processTateyomiImage(fileObj.src, fileObj.pageNo, useJpeg));
      }

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
      console.error("[gaugau-dl] Error:", err);
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

    try {
      const info = await detectReaderInfo(12000);
      if (!info) {
        if (ui) ui.updateProgress({ status: "Sẵn sàng." });
        return;
      }

      let data;
      if (info.type === 'binb') {
        data = await fetchBinbManifest(info.cid, info.ptbinb);
      } else {
        data = { type: 'tateyomi', files: info.urls.map((u, i) => ({ pageNo: i + 1, src: u })) };
      }
      state.chapterData = data;

      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: data.files.length,
          status: "Sẵn sàng."
        });
      }
    } catch (e) {
      console.error("[gaugau-dl] Boot error:", e);
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