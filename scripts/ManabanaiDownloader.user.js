// ==UserScript==
// @name         Manabanai Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://manabanai.opinet.jp/favicon.ico
// @description  Tải manga trên 週刊マナバナイ (manabanai.opinet.jp) chuẩn Zero-Copy 0ms.
// @author       anonymous & AI
// @match        https://manabanai.opinet.jp/comic/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      manabanai.opinet.jp
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN ---
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/ManabanaiDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/ManabanaiDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function manabanaiUniversalDownloader() {
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
    lastSlug: ""
  };

  /* =========================================================================
   * 1. GIAO DIỆN THEME: ĐỎ CHU SA (#000000) - NỀN TRẮNG SÁNG
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "manabanai-dl",
        title: "週刊マナバナイ",
        engine: "INDIE MANGA",
        themeColor: "#000000",     
        themeBg: "#ffffff",       
        titleColor: "#000000",     
        btnBg: "#000000",         
        btnColor: "#ffffff",      
        tabBg: "#000000",
        tabColor: "#ffffff",
        topOffset: "90px",
        onDownload: startDownload
      };

      state.ui = createUI(uiConfig);
      state.ui.setBusy(true);

      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:${uiConfig.titleColor};letter-spacing:0.3px;">${uiConfig.title}</div>
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
  function isEpisodeUrl() {
    return /\/comic\/[^\/?#]+/i.test(WIN.location.pathname);
  }

  function getChapterSlug() {
    const m = WIN.location.pathname.match(/\/comic\/([^\/?#]+)/i);
    return m ? m[1] : "manabanai_chapter";
  }

  function cleanString(str) {
    if (!str) return "";
    return str
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/:/g, '：')          // Chuyển colon nửa góc thành toàn giác để Windows không cấm
      .replace(/【(?!(?:フルカラー版|カラー版|完全版|特装版))[^】]*】/gi, '')
      .replace(/[\\/*?"<>|]/g, '')  // Lọc ký tự cấm hệ điều hành
      .trim();
  }

  function getCleanTitle() {
    try {
      // 1. Tên truyện: Bóc từ Breadcrumb (phần tử thứ 2)
      let seriesTitle = "";
      const breadcrumbSeries = DOC.querySelector('#bread_crumb li:nth-child(2) a, #bread_crumb a[href*="wizard"], #bread_crumb a:not([href*="index"])');
      if (breadcrumbSeries && breadcrumbSeries.textContent) {
        seriesTitle = cleanString(breadcrumbSeries.textContent);
      }

      // 2. Tên chương: Bóc từ thẻ <h3> trong vùng đọc
      let chapterTitle = "";
      const h3El = DOC.querySelector('#comic_page h3, h3');
      if (h3El && h3El.textContent) {
        chapterTitle = cleanString(h3El.textContent);
      }

      // 3. Dự phòng: Phân tách từ thẻ <title> nếu DOM thiếu thông tin
      if (!seriesTitle || !chapterTitle) {
        const rawTitle = DOC.title || "";
        const parts = rawTitle.split(/[|｜]/).map(p => cleanString(p));
        if (parts.length >= 2) {
          if (!chapterTitle) chapterTitle = parts[0];
          if (!seriesTitle) seriesTitle = parts[1];
        }
      }

      if (seriesTitle && chapterTitle) {
        return `${seriesTitle} - ${chapterTitle}`;
      }
      return seriesTitle || chapterTitle || `Manabanai_${getChapterSlug()}`;
    } catch (e) {}

    return `Manabanai_${getChapterSlug()}`;
  }

  /* =========================================================================
   * 3. BÓC TÁCH DANH SÁCH ẢNH 0MS TỪ DOM TĨNH (ZERO-NETWORK EXTRACTION)
   * ========================================================================= */
  function fetchManabanaiManifest() {
    const imgEls = DOC.querySelectorAll('#comic_page img, #comic_page ul li img');
    const urls = [];

    imgEls.forEach(img => {
      const rawSrc = img.getAttribute('src');
      if (rawSrc && !rawSrc.startsWith('data:')) {
        try {
          const fullUrl = new URL(rawSrc, WIN.location.href).href;
          if (!urls.includes(fullUrl)) {
            urls.push(fullUrl);
          }
        } catch (e) {}
      }
    });

    if (urls.length === 0) return null;

    const pages = urls.map((url, idx) => ({
      pageNo: idx + 1,
      url: url
    }));

    return {
      slug: getChapterSlug(),
      title: getCleanTitle(),
      pages: pages
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
      if (!data || !data.pages?.length) {
        data = fetchManabanaiManifest();
        state.chapterData = data;
      }

      if (!data || !data.pages?.length) throw new Error("Không tìm thấy danh sách trang tranh.");

      const { pages, title, slug } = data;
      const totalPages = pages.length;

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file định danh ID tập truyện theo Golden Rule 2
      zip.addFile(`${slug}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      // 6 luồng tải song song Zero-Copy trong RAM
      const tasks = pages.map(pageObj => async () => {
        const rawBuffer = await Utils.fetchBuffer(pageObj.url, { "Referer": WIN.location.href });

        // 🎯 ZERO-TRUST MAGIC BYTES: Nhận diện định dạng nhị phân thực tế
        const ext = Utils.detectExt(rawBuffer);

        return {
          fileName: `${pageObj.pageNo}.${ext}`,
          data: new Uint8Array(rawBuffer)
        };
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

      // Đặt tên ZIP chuẩn: [Tên Truyện] - [Tên Chap].zip
      const finalFileName = `${title}.zip`;
      zip.download(finalFileName);

      if (ui) {
        ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
        ui.setBusy(false);
      }
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[manabanai-dl] Download error:", err);
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

    if (!isEpisodeUrl()) {
      if (ui?.panel) ui.panel.style.display = "none";
      return;
    }

    if (ui?.panel) {
      ui.panel.style.display = "block";
      ui.setBusy(true);
      ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
    }

    try {
      let data = null;
      let retries = 0;

      // Chờ các thẻ <img> được render đầy đủ vào cây DOM
      while (retries < 25) {
        data = fetchManabanaiManifest();
        if (data && data.pages?.length > 0) break;
        await sleep(100);
        retries++;
      }

      if (!data || !data.pages?.length) {
        throw new Error("Không thể bóc tách danh sách trang tranh từ DOM.");
      }
      state.chapterData = data;

      // 🎯 ZERO-TRUST MAGIC BYTES CHECK TRANG 1:
      const firstPageUrl = data.pages[0]?.url;
      if (!firstPageUrl) throw new Error("URL trang 1 không hợp lệ.");

      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const testRawBuf = await Utils.fetchBuffer(firstPageUrl, { "Referer": WIN.location.href });
      const realExt = Utils.detectExt(testRawBuf);

      if (!realExt) throw new Error("Không thể nhận diện Magic Bytes ảnh.");

      if (ui) {
        await sleep(80);
        ui.updateProgress({
          completed: 0,
          total: data.pages.length,
          status: "Sẵn sàng.",
          format: realExt // Khóa cứng nhãn UI "Ảnh gốc là EXT" theo chuẩn Zero-Copy
        });
        ui.setBusy(false);
      }
    } catch (err) {
      console.error("[manabanai-dl] Boot error:", err);
      if (ui) {
        ui.updateProgress({ status: "Lỗi: " + (err?.message || "Không thể tải trang.") });
        ui.setBusy(true);
      }
    }
  }

  // Hook SPA History & RouteWatcher
  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute((newUrl) => {
      if (!isEpisodeUrl()) {
        const ui = getUI();
        if (ui?.panel) ui.panel.style.display = "none";
        state.chapterData = null;
        state.lastSlug = "";
        state.lastUrl = "";
        state.running = false;
        return;
      }

      const currentSlug = getChapterSlug();
      if (state.lastSlug && state.lastSlug === currentSlug) return;

      state.lastUrl = newUrl;
      state.lastSlug = currentSlug;
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

  boot();
})();