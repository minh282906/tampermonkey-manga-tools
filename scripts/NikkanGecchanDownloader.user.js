// ==UserScript==
// @name         Nikkan Gecchan Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://nikkangecchan.jp/favicon.ico
// @description  Tải manga trên 日刊月チャン (nikkangecchan.jp).
// @author       anonymous & AI
// @match        https://nikkangecchan.jp/comics/*
// @match        https://www.nikkangecchan.jp/comics/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      nikkangecchan.jp
// @connect      www.nikkangecchan.jp
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN ---
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/NikkanGecchanDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/NikkanGecchanDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function nikkanGecchanUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6   // 6 luồng tải song song (Kịch trần TCP Socket)
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    chapterData: null,
    ui: null,
    lastUrl: "",
    lastSeriesSlug: ""
  };

  /* =========================================================================
   * 1. GIAO DIỆN THEME THEO HEADER: VÀNG GECCHAN (#FFEF02 / #EAB308) - NỀN TRẮNG
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "gecchan-dl",
        title: "日刊月チャン",
        engine: "AKITA SHOTEN",
        themeColor: "#18181b",      
        themeBg: "#ffffff",         
        titleColor: "#18181b",
        btnBg: "#FFEF02",           
        btnColor: "#18181b",        
        tabBg: "#FFEF02",
        tabColor: "#18181b",
        topOffset: "87px",          
        onDownload: startDownload
      };

      state.ui = createUI(uiConfig);
      state.ui.setBusy(true);

      // Header 2 tầng (Dòng 1: 日刊月チャン, Dòng 2: AKITA SHOTEN)
      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:900 13px/1.2 system-ui,sans-serif;color:${uiConfig.titleColor};letter-spacing:0.3px;">${uiConfig.title}</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px;visibility:hidden;">${uiConfig.engine}</div>
          `;
        }
      }
    }
    return state.ui;
  }

  /* =========================================================================
   * 2. BỘ HỖ TRỢ XỬ LÝ CHUỖI, URL & TIÊU ĐỀ
   * ========================================================================= */
  function isComicUrl() {
    return /\/comics\/[^\/?#]+/i.test(WIN.location.pathname);
  }

  function getSeriesSlug(urlStr) {
    const pathname = urlStr ? new URL(urlStr, WIN.location.origin).pathname : WIN.location.pathname;
    const m = pathname.match(/\/comics\/([^\/?#]+)/i);
    return m ? m[1] : null;
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

  /* =========================================================================
   * 3. BÓC TÁCH TOÀN BỘ DANH MỤC TRANG QUA SSR GỐC (PHÁ VỠ DOM VIRTUALIZATION)
   * ========================================================================= */
  async function fetchFullSeriesManifest(seriesSlug) {
    // Kéo trực tiếp HTML gốc từ máy chủ để lấy toàn bộ các tập chưa bị JS xóa
    const res = await WIN.fetch(`https://nikkangecchan.jp/comics/${seriesSlug}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status} khi lấy cấu trúc truyện.`);

    const rawHtml = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(rawHtml, "text/html");

    // 1. Trích xuất tên bộ truyện
    let seriesTitle = doc.querySelector('#comicDetail .detailBox h3, h3')?.textContent?.trim() || "";
    if (!seriesTitle) {
      const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute("content") || doc.title || "";
      seriesTitle = ogTitle.split(/[|｜]/)[0].trim();
    }
    seriesTitle = cleanString(seriesTitle) || seriesSlug;

    // 2. Bóc tách danh sách toàn bộ các tập (episodeBox)
    const boxes = Array.from(doc.querySelectorAll('.episodeBox'));
    if (!boxes.length) {
      throw new Error("Không tìm thấy danh sách tập truyện trong mã nguồn máy chủ.");
    }

    const pages = [];
    const seenUrls = new Set();

    for (const box of boxes) {
      const epTitleEl = box.querySelector('h4.episodeTitle');
      const epTitle = cleanString(epTitleEl?.textContent || "");

      const img = box.querySelector('img.episode-page, img[src*="/image"], img[data-src*="/image"]');
      if (!img) continue;

      let src = img.getAttribute('data-src') || img.getAttribute('src') || '';
      if (!src || src.startsWith('data:image')) continue;

      const absUrl = new URL(src, WIN.location.origin).href;
      if (!seenUrls.has(absUrl)) {
        seenUrls.add(absUrl);
        pages.push({
          epTitle: epTitle || String(pages.length + 1),
          url: absUrl
        });
      }
    }

    if (!pages.length) {
      throw new Error("Không trích xuất được liên kết ảnh nào hợp lệ.");
    }

    const firstEp = pages[0].epTitle;
    const lastEp = pages[pages.length - 1].epTitle;
    const episodeRange = (firstEp && lastEp && firstEp !== lastEp) ? `${firstEp}-${lastEp}` : (lastEp || `${pages.length}話`);
    const fullTitle = `${seriesTitle} - ${episodeRange}`;

    return {
      seriesSlug,
      seriesTitle,
      episodeRange,
      title: fullTitle,
      pages
    };
  }

  /* =========================================================================
   * 4. TIẾN TRÌNH TẢI CHÍNH & ZERO-COPY 0MS VÀO ZIP
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    const seriesSlug = getSeriesSlug();
    if (!seriesSlug) {
      if (ui) ui.updateProgress({ status: "Lỗi: Không tìm thấy định danh truyện." });
      return;
    }

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let data = state.chapterData;
      if (!data || data.seriesSlug !== seriesSlug || !data.pages?.length) {
        data = await fetchFullSeriesManifest(seriesSlug);
        state.chapterData = data;
      }

      const { pages, title, seriesSlug: sSlug, episodeRange } = data;
      const totalPages = pages.length;
      if (!totalPages) throw new Error("Không có trang hợp lệ để tải.");

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file định danh ID
      zip.addFile(`${sSlug}_${episodeRange}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      // Hàng đợi 6 luồng tải song song Zero-Copy từ máy chủ
      const tasks = pages.map((pageObj, idx) => async () => {
        const rawBuffer = await Utils.fetchBuffer(pageObj.url, { "Referer": WIN.location.href });
        const rawUint8 = new Uint8Array(rawBuffer);

        // 🎯 ZERO-TRUST MAGIC BYTES: Tuyệt đối không fallback chuỗi rỗng/hardcode
        const ext = Utils.detectExt(rawBuffer);
        if (!ext) throw new Error(`Không thể nhận diện Magic Bytes của trang ${idx + 1}`);

        return { fileName: `${idx + 1}.${ext}`, data: rawUint8 };
      });

      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      let savedCount = 0;
      for (const res of results) {
        if (res?.data) {
          zip.addFile(res.fileName, res.data);
          savedCount++;
        }
      }

      if (savedCount === 0) {
        throw new Error("Không thể tải bất kỳ trang ảnh nào. Hãy kiểm tra lại kết nối.");
      }

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      // Đặt tên ZIP chuẩn: [Tên Truyện] - [Dải Tập].zip
      const finalFileName = `${title}.zip`;
      zip.download(finalFileName);

      if (ui) {
        ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
        ui.setBusy(false);
      }
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[gecchan-dl] Download error:", err);
    } finally {
      state.running = false;
    }
  }

  /* =========================================================================
   * 5. KHỞI CHẠY (BOOT) & ĐỒNG BỘ TRẠNG THÁI
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(20);
    const ui = getUI();

    if (!isComicUrl()) {
      if (ui?.panel) ui.panel.style.display = "none";
      return;
    }

    if (ui?.panel) {
      ui.panel.style.display = "block";
      ui.setBusy(true);
      ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
    }

    const seriesSlug = getSeriesSlug();
    if (!seriesSlug) return;

    try {
      let data = null;
      let retries = 0;

      while (retries < 25) {
        try {
          data = await fetchFullSeriesManifest(seriesSlug);
          if (data && data.pages?.length > 0) break;
        } catch (e) {}
        await sleep(150);
        retries++;
      }

      if (!data || !data.pages?.length) {
        throw new Error("Không lấy được danh sách tập truyện từ máy chủ.");
      }
      state.chapterData = data;

      // 🎯 ZERO-TRUST MAGIC BYTES CHECK TRANG 1:
      const firstPageUrl = data.pages[0].url;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const testBuf = await Utils.fetchBuffer(firstPageUrl, { "Referer": WIN.location.href });
      const realExt = Utils.detectExt(testBuf);

      if (!realExt) {
        throw new Error("Không thể nhận diện Magic Bytes ảnh.");
      }

      data.format = realExt;

      if (ui) {
        await sleep(80);
        ui.updateProgress({
          completed: 0,
          total: data.pages.length,
          status: "Sẵn sàng.",
          format: realExt
        });
        ui.setBusy(false);
      }
    } catch (err) {
      console.error("[gecchan-dl] Boot error:", err);
      if (ui) {
        ui.updateProgress({ status: "Lỗi: " + (err?.message || "Không thể tải trang.") });
        ui.setBusy(true);
      }
    }
  }

  // Hook RouteWatcher: KHÓA SLUG TRUYỆN (CHỐNG GIẬT UI KHI CUỘN TRANG ĐỔI URL)
  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute((newUrl) => {
      if (!isComicUrl()) {
        const ui = getUI();
        if (ui?.panel) ui.panel.style.display = "none";
        state.chapterData = null;
        state.lastSeriesSlug = "";
        state.lastUrl = "";
        state.running = false;
        return;
      }

      const currentSlug = getSeriesSlug(newUrl);
      if (state.lastSeriesSlug && state.lastSeriesSlug === currentSlug) return;

      state.lastUrl = newUrl;
      state.lastSeriesSlug = currentSlug;
      state.chapterData = null;
      state.running = false;

      const ui = getUI();
      if (ui) {
        ui.setBusy(true);
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