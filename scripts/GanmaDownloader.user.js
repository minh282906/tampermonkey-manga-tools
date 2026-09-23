// ==UserScript==
// @name         GANMA! Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://ganma.jp/favicon.ico
// @description  Tải manga trên GANMA! (ganma.jp).
// @author       anonymous & AI
// @match        https://ganma.jp/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      ganma.jp
// @connect      *.ganma.jp
// @connect      *.cloudfront.net
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function ganmaUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6,   // 6 luồng CloudFront
    JPEG_QUALITY: 1.0
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("ganma-dl:convert-jpeg") === '1',
    detectedSourceFormat: 'jpg',
    chapterData: null,
    ui: null,
    lastUrl: ""
  };

  /* =========================================================================
   * 1. GIAO DIỆN UNIVERSAL UI CHUẨN THEME GANMA! (HEADER VÀNG - TRẮNG)
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      state.ui = createUI({
        storagePrefix: "ganma-dl",
        title: "GANMA!",
        engine: "COMICSMART",
        themeColor: "#F8B500",      
        themeBg: "#ffffff",       
        titleColor: "#F8B500",     
        btnBg: "#F8B500",          
        btnColor: "#ffffff",     
        topOffset: "60px",

        defaultJpgText: "Xuất file JPG (ảnh gốc là JPG)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("ganma-dl:convert-jpeg", checked ? '1' : '0');
        }
      });

      state.ui.updateFormatUI(state.detectedSourceFormat);

      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:#F8B500;letter-spacing:0.2px;">GANMA!</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px;visibility:hidden;">COMICSMART</div>
          `;
        }
      }
    }
    return state.ui;
  }

  /* =========================================================================
   * 2. BỘ HỖ TRỢ XỬ LÝ CHUỖI, URL & TIÊU ĐỀ
   * ========================================================================= */
  function isEpisodeUrl() {
    return /\/web\/reader\/[^\/]+\/[a-f0-9-]+/i.test(WIN.location.pathname);
  }

  function getStoryId() {
    const match = WIN.location.pathname.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
    return match ? match[1] : "Ganma_Episode";
  }

  function cleanString(str) {
    if (!str) return "";
    return str
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/【(?!(?:フルカラー版|カラー版|完全版|特装版))[^】]*】/gi, '')
      .replace(/[\\/*?:"<>|]/g, '')
      .trim();
  }

  function getCleanTitle() {
    try {
      const rawTitle = DOC.title || DOC.querySelector('meta[property="og:title"]')?.getAttribute('content') || "";
      
      const parts = rawTitle
        .split(/[|｜]/)
        .map(p => cleanString(p))
        .filter(p => p && !/(?:無料|ウェブトゥーン|読むなら|GANMA|ガンマ)/i.test(p));

      if (parts.length >= 2) {
        const isChap = str => /^(?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\.]+\s*(?:話|回|巻|章|節|部|エピソード|分冊版|単話)/i.test(str);

        const seriesTitle  = isChap(parts[0]) ? parts[1] : parts[0];
        let episodeTitle = isChap(parts[0]) ? parts[0] : parts[1];

        // 1. Xử lý Oneshot: Nếu tên chap trùng khít tên truyện -> Chỉ xuất duy nhất [Tên Truyện].zip
        if (seriesTitle === episodeTitle || !episodeTitle) {
          return seriesTitle;
        }

        // 2. Khử trùng lặp nếu tên chap vô tình chứa lại tên truyện ở đầu
        if (episodeTitle.startsWith(seriesTitle)) {
          episodeTitle = cleanString(episodeTitle.substring(seriesTitle.length).replace(/^[\s\-_:：\u3000・･]+/, ''));
        }

        if (seriesTitle && episodeTitle && seriesTitle !== episodeTitle) {
          return `${seriesTitle} - ${episodeTitle}`;
        }
        return seriesTitle || episodeTitle;
      }

      if (parts.length === 1) {
        const dashMatch = parts[0].match(/^(.*?)(?:\s*[-－–—]\s*)((?:第\s*)?[0-9０-９]+.*)$/);
        if (dashMatch) return `${cleanString(dashMatch[1])} - ${cleanString(dashMatch[2])}`;
        return parts[0];
      }
    } catch (e) {}

    return `Ganma_${getStoryId()}`;
  }

  // ÉP ĐỘ PHÂN GIẢI MASTER: Gọt bỏ tham số &w=\d+ để CloudFront trả file gốc không nén
  function stripWidthParam(url) {
    if (!url || typeof url !== 'string') return '';
    return url
      .replace(/([?&])w=\d+(&?)/, (match, p1, p2) => (p1 === '?' && p2 ? '?' : ''))
      .replace(/[?&]$/, '');
  }

  function unescapeRscString(str) {
    if (!str) return '';
    return str
      .replace(/\\u0026/g, '&')
      .replace(/&amp;/g, '&')
      .replace(/\\"/g, '"')
      .replace(/\\\//g, '/')
      .replace(/\\\\/g, '\\');
  }

  /* =========================================================================
   * 3. BÓC TÁCH 0MS TỪ LUỒNG REACT SERVER COMPONENTS (NEXT.JS APP ROUTER)
   * ========================================================================= */
  async function fetchGanmaManifest() {
    let rscText = "";

    // 1. Thử đọc nhanh từ RAM nếu là lần đầu F5
    if (Array.isArray(WIN.self?.__next_f)) {
      for (const item of WIN.self.__next_f) {
        if (Array.isArray(item) && typeof item[1] === 'string' && item[1].includes('singleModeDisplayUnits')) {
          rscText += item[1];
        }
      }
    }

    // 2. GIẢI PHÁP VƯỢT BẪY SPA: Kéo luồng RSC tươi mới nếu chuyển trang từ trang chủ
    if (!rscText) {
      try {
        const currentPath = WIN.location.pathname;
        const Utils = window.MangaUtils || globalThis.MangaUtils;
        const buf = await Utils.fetchBuffer(`${WIN.location.origin}${currentPath}?_rsc=1`, { 'RSC': '1' });
        rscText = new TextDecoder().decode(buf);
      } catch (e) {}
    }

    // 3. Dự phòng quét DOM
    if (!rscText) {
      const scripts = DOC.querySelectorAll('script');
      for (const s of scripts) {
        const txt = s.textContent || '';
        if (txt.includes('singleModeDisplayUnits')) rscText += txt;
      }
    }

    if (!rscText) return null;

    const unescaped = unescapeRscString(rscText);

    // Bóc tách mảng singleModeDisplayUnits
    const unitsMatch = unescaped.match(/"singleModeDisplayUnits"\s*:\s*(\[[^\]]+\])/);
    let urls = [];

    if (unitsMatch) {
      try {
        const rawUnits = JSON.parse(unitsMatch[1]);
        urls = rawUnits.map(item => stripWidthParam(item.url || item)).filter(u => u && u.startsWith('http'));
      } catch (e) {
        const urlMatches = unescaped.match(/https:\/\/[^"\s\\]+cloudfront\.net\/[^"\s\\]+/g) || [];
        urls = Array.from(new Set(urlMatches.map(u => stripWidthParam(u))));
      }
    }

    // =========================================================================
    // BÓC TÁCH AFTERWORD (TỰ ĐỘNG THU THẬP TẤT CẢ VÀO MẢNG)
    // =========================================================================
    const afterwordUrls = [];
    const seenAfPaths = new Set(); // Dùng Set để khóa chặt đường dẫn file

    // 1. Quét link /story_afterwordImage/
    const afMatches = unescaped.match(/https:\/\/[^"\s\\]*cloudfront\.net\/story_afterwordImage\/[^"\s\\]+/gi) || [];
    for (const rawAf of afMatches) {
      const cleanAf = stripWidthParam(rawAf);
      const baseFilePath = cleanAf.split('?')[0]; // Chỉ lấy phần đường dẫn file gốc
      if (cleanAf && !seenAfPaths.has(baseFilePath)) {
        seenAfPaths.add(baseFilePath);
        afterwordUrls.push(cleanAf);
      }
    }

    // 2. Dự phòng quét DOM
    if (afterwordUrls.length === 0) {
      const domAfs = DOC.querySelectorAll('img[src*="story_afterwordImage"], img[srcset*="story_afterwordImage"]');
      for (const domEl of domAfs) {
        const rawSrc = domEl.getAttribute('src') || domEl.getAttribute('srcset') || '';
        const m = rawSrc.match(/https:\/\/[^\s"',]+cloudfront\.net\/story_afterwordImage\/[^\s"',]+/i);
        if (m) {
          const cleanAf = stripWidthParam(m[0]);
          const baseFilePath = cleanAf.split('?')[0];
          if (cleanAf && !seenAfPaths.has(baseFilePath)) {
            seenAfPaths.add(baseFilePath);
            afterwordUrls.push(cleanAf);
          }
        }
      }
    }

    if (urls.length === 0) return null;

    // Nhận diện định dạng thực tế từ URL
    let detectedFormat = 'jpg';
    const firstClean = urls[0].split('?')[0].toLowerCase();
    if (firstClean.endsWith('.webp')) detectedFormat = 'webp';
    else if (firstClean.endsWith('.png')) detectedFormat = 'png';

    return { 
      urls, 
      afterwords: afterwordUrls,
      format: detectedFormat 
    };
  }

  /* =========================================================================
   * 4. TIẾN TRÌNH TẢI CHÍNH & ZERO-COPY 0MS VÀO ZIP
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let data = state.chapterData;
      if (!data || !data.urls?.length) {
        data = await fetchGanmaManifest();
        state.chapterData = data;
      }

      if (!data || !data.urls?.length) throw new Error("Không tìm thấy danh sách ảnh chương.");

      const { urls, afterwords, format } = data;
      const useJpeg = Boolean(state.convertJpeg);

      // 1. Tạo danh sách tải: Trang truyện chính đánh số 1, 2, 3...
      const downloadQueue = [];
      urls.forEach((url, idx) => {
        downloadQueue.push({ url, baseName: `${idx + 1}` });
      });

      // 2. Trang lời bạt:đặt tên là "afterword"
      if (afterwords && afterwords.length > 0) {
        afterwords.forEach((url, idx) => {
          const name = (afterwords.length === 1) ? "afterword" : `afterword (${idx})`;
          downloadQueue.push({ url, baseName: name });
        });
      }

      const totalPages = downloadQueue.length;

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // File định danh ID chương
      const storyId = getStoryId();
      zip.addFile(`${storyId}.txt`, new Uint8Array(0));

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      // 3. Hàng đợi tải 6 luồng CloudFront
      const tasks = downloadQueue.map((item) => async () => {
        let rawBuffer = null;

        try {
          const res = await WIN.fetch(item.url);
          if (res.ok) rawBuffer = await res.arrayBuffer();
        } catch (e) {}

        if (!rawBuffer) {
          rawBuffer = await Utils.fetchBuffer(item.url, { "Referer": "https://ganma.jp/" });
        }

        const rawUint8 = new Uint8Array(rawBuffer);
        const ext = Utils.detectExt(rawBuffer);

        // ZERO-COPY: Ghi thẳng mảng byte ảnh Master vào ZIP
        if (!useJpeg || ext === 'jpg') {
          return { fileName: `${item.baseName}.${ext}`, data: rawUint8 };
        }

        // Chuyển sang JPG nếu người dùng tick chọn
        const img = await Utils.loadImage(rawBuffer, `image/${ext}`);
        const canvas = DOC.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;

        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.imageSmoothingEnabled = false;
        ctx.mozImageSmoothingEnabled = false;
        ctx.webkitImageSmoothingEnabled = false;
        ctx.msImageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0);

        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', CONFIG.JPEG_QUALITY));
        canvas.width = 0; canvas.height = 0;

        return { fileName: `${item.baseName}.jpg`, data: new Uint8Array(await blob.arrayBuffer()) };
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
      console.error("[ganma-dl] Download error:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * 5. KHỞI CHẠY & THEO DÕI ĐIỀU HƯỚNG SPA
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(20);
    const ui = getUI();

    if (!isEpisodeUrl()) {
      if (ui?.panel) ui.panel.style.display = "none";
      return;
    }

    if (ui?.panel) {
      ui.panel.style.display = "block";
      ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
    }

    let data = null;
    let retries = 0;

    while (retries < 25) {
      try {
        data = await fetchGanmaManifest();
        if (data && data.urls?.length > 0) break;
      } catch (e) {}
      await sleep(150);
      retries++;
    }

    if (data && data.urls?.length > 0) {
      state.chapterData = data;
      state.detectedSourceFormat = data.format;

      // Nếu gốc là JPG -> ép convertJpeg = true
      if (data.format === 'jpg') {
        state.convertJpeg = true;
      }

      // Tự động cập nhật UI:
      // - Nếu gốc JPG: Khóa tick [x] "Xuất file JPG (ảnh gốc là JPG)"
      // - Nếu gốc WebP: Mở tick [ ] "Xuất file JPG (ảnh gốc là WebP)" cho người dùng tự chọn
      if (ui?.updateFormatUI) ui.updateFormatUI(data.format);

      const totalCount = data.urls.length + (data.afterwords?.length || 0);

      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: totalCount,
          status: "Sẵn sàng."
        });
      }
    } else {
      if (ui) ui.updateProgress({ status: "Sẵn sàng." });
    }
  }

  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute((newUrl) => {
      const currentStoryId = getStoryId();
      if (state.lastStoryId && state.lastStoryId === currentStoryId) return;

      state.lastUrl = newUrl;
      state.lastStoryId = currentStoryId;
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