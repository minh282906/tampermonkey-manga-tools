// ==UserScript==
// @name         GigaViewer Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      2.0.0
// @icon         https://files.catbox.moe/tpd5zq.png
// @description  Tải manga trên hơn 25 nền tảng GigaViewer (Hatena).
// @author       anonymous & AI
// @match        https://comic-action.com/*
// @match        https://comic-days.com/*
// @match        https://comic-earthstar.com/*
// @match        https://comic-gardo.com/*
// @match        https://comic-ogyaaa.com/*
// @match        https://comic-seasons.com/*
// @match        https://comic-trail.com/*
// @match        https://comic-y-ours.com/*
// @match        https://comic-zenon.com/*
// @match        https://comicborder.com/*
// @match        https://feelweb.jp/*
// @match        https://ichicomi.com/*
// @match        https://kuragebunch.com/*
// @match        https://magcomi.com/*
// @match        https://mangatime-square.com/*
// @match        https://ourfeel.jp/*
// @match        https://shonenjumpplus.com/*
// @match        https://tonarinoyj.jp/*
// @match        https://www.sunday-webry.com/*
// @match        https://sunday-webry.com/*
// @match        https://andsofa.com/*
// @match        https://morningtwo.com/*
// @match        https://getsumagakichi.com/*
// @match        https://bibliosirius.com/*
// @match        https://comicbunch-kai.com/*
// @match        https://heros-web.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      *.comic-action.com
// @connect      *.comic-days.com
// @connect      *.comic-earthstar.com
// @connect      *.comic-gardo.com
// @connect      *.comic-ogyaaa.com
// @connect      *.comic-seasons.com
// @connect      *.comic-trail.com
// @connect      *.comic-y-ours.com
// @connect      *.comic-zenon.com
// @connect      *.comicborder.com
// @connect      *.feelweb.jp
// @connect      *.ichicomi.com
// @connect      *.kuragebunch.com
// @connect      *.magcomi.com
// @connect      *.mangatime-square.com
// @connect      *.ourfeel.jp
// @connect      *.shonenjumpplus.com
// @connect      *.tonarinoyj.jp
// @connect      *.sunday-webry.com
// @connect      *.andsofa.com
// @connect      *.morningtwo.com
// @connect      *.getsumagakichi.com
// @connect      *.bibliosirius.com
// @connect      *.comicbunch-kai.com
// @connect      *.heros-web.com
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function gigaViewerUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH & KHỞI TẠO
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6,   // 6 luồng tải song song qua API
    JPEG_QUALITY: 0.95   // Chất lượng xuất JPG nếu chọn
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("giga-dl:convert-jpeg") === '1',
    chapterData: null,
    ui: null
  };

  /* =========================================================================
   * BẢNG CẤU HÌNH THEME THEO TỪNG WEBSITE (PHƯƠNG ÁN 2)
   * ========================================================================= */
  const SITE_THEMES = {
    "shonenjumpplus.com":      { name: "Jump+",           sub: "GIGAVIEWER", top: "58px", color: "#eb544b", bg: "#1c0d0e", text: "#fca5a5" },
    "tonarinoyj.jp":           { name: "Tonari no YJ",    sub: "GIGAVIEWER", top: "56px", color: "#0284c7", bg: "#082f49", text: "#7dd3fc" },
    "sunday-webry.com":        { name: "Sunday Webry",    sub: "GIGAVIEWER", top: "76px", color: "#f59e0b", bg: "#451a03", text: "#fde68a" },
    "comic-days.com":          { name: "Comic Days",      sub: "GIGAVIEWER", top: "80px", color: "#dc2626", bg: "#450a0a", text: "#fca5a5" },
    "kuragebunch.com":         { name: "Kurage Bunch",    sub: "GIGAVIEWER", top: "68px", color: "#06b6d4", bg: "#083344", text: "#67e8f9" },
    "magcomi.com":             { name: "MAGCOMI",         sub: "GIGAVIEWER", top: "70px", color: "#8b5cf6", bg: "#2e1065", text: "#c4b5fd" },
    "comic-gardo.com":         { name: "Comic Gardo",     sub: "GIGAVIEWER", top: "68px", color: "#e11d48", bg: "#4c0519", text: "#fda4af" },
    "comic-zenon.com":         { name: "Comic Zenon",     sub: "GIGAVIEWER", top: "68px", color: "#ea580c", bg: "#431407", text: "#fdba74" },
    "comic-action.com":        { name: "Web Action",      sub: "GIGAVIEWER", top: "68px", color: "#2563eb", bg: "#0b1739", text: "#93c5fd" },
    "comic-trail.com":         { name: "Comic Trail",     sub: "GIGAVIEWER", top: "68px", color: "#059669", bg: "#022c22", text: "#6ee7b7" },
    "feelweb.jp":              { name: "Feel Web",        sub: "GIGAVIEWER", top: "68px", color: "#db2777", bg: "#500724", text: "#f472b6" },
    "comic-earthstar.com":     { name: "Earth Star",      sub: "GIGAVIEWER", top: "68px", color: "#10b981", bg: "#022c22", text: "#6ee7b7" },
    "comicborder.com":         { name: "Comic Border",    sub: "GIGAVIEWER", top: "68px", color: "#d97706", bg: "#451a03", text: "#fcd34d" },
    "comic-ogyaaa.com":        { name: "COMIC OGYAAA!!",  sub: "GIGAVIEWER", top: "68px", color: "#f43f5e", bg: "#4c0519", text: "#fda4af" },
    "comic-seasons.com":       { name: "Comic Seasons",   sub: "GIGAVIEWER", top: "68px", color: "#ec4899", bg: "#500724", text: "#f472b6" },
    "comic-y-ours.com":        { name: "COMIC Y-OURS",    sub: "GIGAVIEWER", top: "68px", color: "#6366f1", bg: "#1e1b4b", text: "#a5b4fc" },
    "ichicomi.com":            { name: "Ichicomi",        sub: "GIGAVIEWER", top: "68px", color: "#0284c7", bg: "#082f49", text: "#7dd3fc" },
    "mangatime-square.com":    { name: "MangaTime Square",sub: "GIGAVIEWER", top: "72px", color: "#f97316", bg: "#431407", text: "#fed7aa" },
    "ourfeel.jp":              { name: "OUR FEEL",        sub: "GIGAVIEWER", top: "68px", color: "#e11d48", bg: "#4c0519", text: "#fda4af" },
    "andsofa.com":             { name: "&Sofa",           sub: "GIGAVIEWER", top: "68px", color: "#0d9488", bg: "#042f2e", text: "#5eead4" },
    "morningtwo.com":          { name: "Morning Two",     sub: "GIGAVIEWER", top: "68px", color: "#ef4444", bg: "#450a0a", text: "#fca5a5" },
    "getsumagakichi.com":      { name: "GetsuMagakichi",  sub: "GIGAVIEWER", top: "68px", color: "#3b82f6", bg: "#0b1739", text: "#93c5fd" },
    "bibliosirius.com":        { name: "Sirius",          sub: "GIGAVIEWER", top: "68px", color: "#6366f1", bg: "#1e1b4b", text: "#a5b4fc" },
    "comicbunch-kai.com":      { name: "ComicBunch Kai",  sub: "GIGAVIEWER", top: "68px", color: "#0ea5e9", bg: "#082f49", text: "#7dd3fc" },
    "heros-web.com":           { name: "HERO'S Web",      sub: "GIGAVIEWER", top: "68px", color: "#e11d48", bg: "#4c0519", text: "#fda4af" }
  };

  function getActiveTheme() {
    const host = WIN.location.hostname;
    for (const domain in SITE_THEMES) {
      if (host.includes(domain)) return SITE_THEMES[domain];
    }
    return { name: "GigaViewer", sub: "GIGAVIEWER", top: "70px", color: "#eb544b", bg: "#1c0d0e", text: "#fca5a5" };
  }

  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;
    if (typeof createUI === "function" && DOC.body) {
      const theme = getActiveTheme();
      state.ui = createUI({
        storagePrefix: "giga-dl",
        title: theme.name,
        themeColor: theme.color,
        themeBg: theme.bg,
        titleColor: theme.text,
        topOffset: theme.top,
        defaultJpgText: "Xuất file JPG (mặc định PNG)",
        onDownload: startDownload,
        onJpgChange: (checked) => { state.convertJpeg = checked; }
      });

      // Áp dụng Tiêu đề 2 tầng (Brand Name + Tag GigaViewer)
      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:${theme.text};letter-spacing:0.2px;">${theme.name}</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px;">${theme.sub}</div>
          `;
        }
      }
    }
    return state.ui;
  }

  /* =========================================================================
   * HELPER FUNCTIONS & XỬ LÝ TIÊU ĐỀ CHUẨN
   * ========================================================================= */
  function isEpisodeUrl() {
    return /\/episode\/\d+/.test(WIN.location.pathname);
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
      const match = WIN.location.pathname.match(/\/episode\/(\d+)/);
      if (match && match[1]) return match[1];
    } catch (e) {}
    return "GigaViewer_Episode";
  }

  function getExtensionFromUrl(url, defaultExt = 'jpg') {
    try {
      const pathname = new URL(url, WIN.location.href).pathname;
      const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
      if (match && match[1]) {
        const ext = match[1].toLowerCase();
        if (['jpg', 'jpeg', 'png', 'webp', 'avif'].includes(ext)) {
          return ext === 'jpeg' ? 'jpg' : ext;
        }
      }
    } catch (e) {}
    return defaultExt;
  }

  function getParsedEpisodeJson() {
    try {
      const el = DOC.getElementById('episode-json');
      if (!el) return null;

      let raw = el.getAttribute('data-value') || el.textContent || '';
      if (raw.includes('&quot;') || raw.includes('&amp;')) {
        const txt = DOC.createElement('textarea');
        txt.innerHTML = raw;
        raw = txt.value;
      }
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  // BẮT BUỘC: [Tên Truyện] - [Tên Tập/Chap].zip
  function getCleanTitle(manifestTitle, manifestSeriesTitle) {
    try {
      let seriesTitle = cleanString(manifestSeriesTitle);
      let episodeTitle = cleanString(manifestTitle);

      // 1. Phân tích bóc tách từ DOM nếu manifest bị trống
      if (!seriesTitle) {
        const sEl = DOC.querySelector('.series-header-title, .series-title, [class*="series-title"], .series-title-text');
        if (sEl) seriesTitle = cleanString(sEl.textContent);
      }

      if (!episodeTitle) {
        const eEl = DOC.querySelector('.episode-header-title, .episode-title, [class*="episode-title"], .episode-header-title-text');
        if (eEl) episodeTitle = cleanString(eEl.textContent);
      }

      // 2. Dự phòng phân tích từ document.title
      if (!seriesTitle || !episodeTitle) {
        let raw = (DOC.title || "").split(/[|｜]/)[0].trim();
        raw = raw.replace(/【[^】]*】/g, '').trim();

        // Nhận diện cả số tiếng Anh lẫn số tiếng Nhật (０-９) và số La Mã
        const match = raw.match(/^(.*?)\s+((?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万]+\s*(?:話|巻|章|節|部|エピソード|前編|中編|後編)?.*)$/i);
        if (match) {
          if (!seriesTitle) seriesTitle = cleanString(match[1]);
          if (!episodeTitle) episodeTitle = cleanString(match[2]);
        } else {
          if (!seriesTitle) seriesTitle = cleanString(raw);
          if (!episodeTitle) episodeTitle = getEpisodeId();
        }
      }

      // 3. Tự động cắt bỏ tên truyện nếu nó bị lặp lại bên trong episodeTitle
      let baseSeries = seriesTitle.replace(/\s*[0-9０-９]+\s*巻.*$/i, '').trim();
      if (baseSeries && episodeTitle.startsWith(baseSeries)) {
        episodeTitle = cleanString(episodeTitle.substring(baseSeries.length));
      }

      if (seriesTitle && episodeTitle && !seriesTitle.includes(episodeTitle)) {
        return `${seriesTitle} - ${episodeTitle}`;
      } else if (seriesTitle && episodeTitle) {
        return episodeTitle;
      } else if (seriesTitle) {
        return `${seriesTitle} - ${getEpisodeId()}`;
      }
    } catch (e) {}

    return `GigaViewer_${getEpisodeId()}`;
  }

  function getFrontCoverImages() {
    const selectors = ['.js-front-link-page .link-slot img', '.front-link-page img', '.link-slot img', '.js-front-link-page img'];
    const imgs = DOC.querySelectorAll(selectors.join(', '));
    const srcList = [];
    for (const img of imgs) {
      let src = img.getAttribute('data-src') || img.getAttribute('src') || '';
      if (src && !src.startsWith('data:')) {
        if (src.startsWith('//')) src = 'https:' + src;
        if (!srcList.includes(src)) srcList.push(src);
      }
    }
    return srcList;
  }

  function getEndAdImages() {
    const selectors = [
      '.js-viewer-end img', '.viewer-end img', '.last-page img', '.js-last-page img',
      '.episode-end img', '.end-banner img', '.js-back-link-page img', '.back-link-page img'
    ];
    const found = [];
    for (const sel of selectors) {
      const imgs = DOC.querySelectorAll(sel);
      for (const img of imgs) {
        let src = img.getAttribute('data-src') || img.getAttribute('src') || '';
        if (src && !src.startsWith('data:') && !found.includes(src)) {
          if (src.startsWith('//')) src = 'https:' + src;
          found.push(src);
        }
      }
    }
    return found;
  }

  /* =========================================================================
   * BÓC TÁCH DANH SÁCH TRANG TỪ JSON MANIFEST
   * ========================================================================= */
  function fetchEpisodeData() {
    const json = getParsedEpisodeJson();
    if (!json) return null;

    const readable = json.readableProduct || json.episode || {};
    const series = json.series || readable.series || {};
    const rawPages = readable.pageStructure?.pages || json.pageStructure?.pages || [];

    const resultPages = [];
    let prCount = 0;
    let mainPageNo = 1;

    // 1. Ảnh bìa mở đầu từ DOM
    const frontSrcs = getFrontCoverImages();
    for (const fSrc of frontSrcs) {
      prCount++;
      resultPages.push({ isPR: true, isRaw: true, prNo: prCount, src: fSrc });
    }

    // 2. Trang truyện chính từ JSON Manifest
    for (const p of rawPages) {
      const imgSrc = p.src || p.banner?.src || p.image?.src || p.url || '';
      if (!imgSrc) continue;

      const alreadyInFront = frontSrcs.some(fs => imgSrc.includes(fs.split('?')[0]));
      if (alreadyInFront) continue;

      const isPRType = (p.type && p.type !== 'main') || imgSrc.includes('/link-slot/') || imgSrc.includes('/banner/');
      if (isPRType) {
        prCount++;
        resultPages.push({ isPR: true, isRaw: true, prNo: prCount, src: imgSrc });
      } else {
        resultPages.push({ isPR: false, isRaw: false, pageNo: mainPageNo++, src: imgSrc });
      }
    }

    // 3. Ảnh quảng cáo cuối trang từ DOM
    const endAdSrcs = getEndAdImages();
    for (const adSrc of endAdSrcs) {
      const alreadyAdded = resultPages.some(item => item.src.includes(adSrc.split('?')[0]));
      if (!alreadyAdded) {
        prCount++;
        resultPages.push({ isPR: true, isRaw: true, prNo: prCount, src: adSrc });
      }
    }

    resultPages.forEach(p => {
      if (p.isPR) p.singlePR = (prCount === 1);
    });

    return {
      title: readable.title || "",
      seriesTitle: series.title || series.name || "",
      pages: resultPages
    };
  }

  /* =========================================================================
   * GIẢI MÃ MA TRẬN 4x4 GIGAVIEWER
   * ========================================================================= */
  async function descrambleGigaImage(rawBuffer, isJpg) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    const img = await Utils.loadImage(rawBuffer);

    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;

    const canvas = DOC.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    // HẰNG SỐ GIẢI MÃ TẠI ĐÂY
    const DIVIDE_NUM = 4;   // Thuật toán ma trận 4x4
    const MULTIPLE = 8;     // Bội số lưới 8px

    const cellWidth = Math.floor(width / (DIVIDE_NUM * MULTIPLE)) * MULTIPLE;
    const cellHeight = Math.floor(height / (DIVIDE_NUM * MULTIPLE)) * MULTIPLE;

    for (let e = 0; e < DIVIDE_NUM * DIVIDE_NUM; e++) {
      const srcRow = Math.floor(e / DIVIDE_NUM);
      const srcCol = e % DIVIDE_NUM;

      const sx = srcCol * cellWidth;
      const sy = srcRow * cellHeight;

      const dx = srcRow * cellWidth;
      const dy = srcCol * cellHeight;

      ctx.drawImage(img, sx, sy, cellWidth, cellHeight, dx, dy, cellWidth, cellHeight);
    }

    const mimeType = isJpg ? 'image/jpeg' : 'image/png';
    const outExt = isJpg ? 'jpg' : 'png';
    const blob = await new Promise(r => canvas.toBlob(r, mimeType, CONFIG.JPEG_QUALITY));

    canvas.width = 0;
    canvas.height = 0;

    return {
      ext: outExt,
      data: new Uint8Array(await blob.arrayBuffer())
    };
  }

  /* =========================================================================
   * TIẾN TRÌNH TẢI CHÍNH (6 LUỒNG TRONG RAM)
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
        data = fetchEpisodeData();
        state.chapterData = data;
      }

      if (!data || !data.pages?.length) throw new Error("Không tìm thấy trang truyện.");

      const pages = data.pages;
      const totalPages = pages.length;
      const useJpeg = Boolean(state.convertJpeg);

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file txt định danh ID tập
      const epId = getEpisodeId();
      zip.addFile(`${epId}.txt`, new Uint8Array(0));

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map((pageObj) => async () => {
        const rawBuffer = await Utils.fetchBuffer(pageObj.src);

        // 1. Ảnh PR / Quảng cáo: Giữ nguyên file gốc từ CDN
        if (pageObj.isPR) {
          let ext = getExtensionFromUrl(pageObj.src);
          const fileName = pageObj.singlePR ? `PR.${ext}` : `PR_${pageObj.prNo}.${ext}`;
          return { fileName, data: new Uint8Array(rawBuffer) };
        }

        // 2. Trang truyện GigaViewer chuẩn: Giải mã ma trận 4x4
        const decoded = await descrambleGigaImage(rawBuffer, useJpeg);
        return {
          fileName: `${pageObj.pageNo}.${decoded.ext}`,
          data: decoded.data
        };
      });

      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res?.data) zip.addFile(res.fileName, res.data);
      }

      const zipName = `${getCleanTitle(data.title, data.seriesTitle)}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[giga-dl] Error:", err);
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

    let data = null;
    let retries = 0;

    while (retries < 25) {
      data = fetchEpisodeData();
      if (data && data.pages?.length > 0) break;
      await sleep(150);
      retries++;
    }

    if (data && data.pages?.length > 0) {
      state.chapterData = data;

      if (ui) {
        // GigaViewer chuẩn là web CÓ MÃ HÓA -> TUYỆT ĐỐI KHÔNG gọi updateFormatUI, giữ nguyên mặc định PNG
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