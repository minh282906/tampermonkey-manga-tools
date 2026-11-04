// ==UserScript==
// @name         Yawaspi Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://yawaspi.com/favicon.ico
// @description  Tải manga trên やわらかスピリッツ (yawaspi.com).
// @author       anonymous & AI
// @match        https://yawaspi.com/*/comic/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      yawaspi.com
// @connect      cdn.yawaspi.com
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN ---
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/YawaspiDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/YawaspiDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function yawaspiUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6   // 6 luồng tải song song (TCP Socket)
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
    lastChapterSlug: ""
  };

  /* =========================================================================
   * 1. GIAO DIỆN THEME THEO THANH ĐIỀU HƯỚNG DỌC ( #EC6749 - NỀN TRẮNG)
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "yawaspi-dl",
        title: "やわらかスピリッツ",
        engine: "SHOGAKUKAN",
        themeColor: "#EC6749",
        themeBg: "#ffffff",   
        titleColor: "#EC6749",
        btnBg: "#EC6749",     
        btnColor: "#ffffff",  
        tabBg: "#EC6749",
        tabColor: "#ffffff",
        topOffset: "117px",
        onDownload: startDownload
      };

      state.ui = createUI(uiConfig);
      state.ui.setBusy(true);

      // Header 2 tầng (Dòng 1: やわらかスピリッツ, Dòng 2: SHOGAKUKAN)
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
    return /\/[^\/]+\/comic\/[^\/?#]+\.html/i.test(WIN.location.pathname);
  }

  function getUrlSlugs() {
    const match = WIN.location.pathname.match(/\/([^\/]+)\/comic\/([^\/?#]+)\.html/i);
    return {
      seriesSlug: match ? match[1] : "yawaspi_series",
      chapterSlug: match ? match[2] : "yawaspi_chapter"
    };
  }

  function cleanString(str) {
    if (!str) return "";
    return str
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/【(?!(?:フルカラー版|カラー版|完全版|特装版))[^】]*】/gi, '')
      .replace(/[\\/*?:"<>|]/g, '')  // Lọc sạch ký tự cấm của hệ điều hành
      .trim();
  }

  function getCleanTitle() {
    const { seriesSlug, chapterSlug } = getUrlSlugs();

    try {
      // 1. Tên Bộ Truyện: Bóc từ thẻ h2 trong header trang
      let seriesTitle = DOC.querySelector('.page__header h2')?.textContent?.trim() || "";

      // Dự phòng: Bóc từ thẻ meta og:title (lấy phần ruột trong ngoặc kép 『...』)
      if (!seriesTitle) {
        const ogTitle = DOC.querySelector('meta[property="og:title"]')?.getAttribute('content') || "";
        const m = ogTitle.match(/『(.*?)』/);
        if (m && m[1]) {
          seriesTitle = cleanString(m[1]);
        } else {
          seriesTitle = cleanString(DOC.title.split('|')[1] || seriesSlug);
        }
      } else {
        seriesTitle = cleanString(seriesTitle);
      }

      // 2. Tên Chương: Bóc từ thẻ h3
      let chapterTitle = DOC.querySelector('.page__header h3')?.textContent?.trim() || "";
      if (!chapterTitle) {
        chapterTitle = cleanString(DOC.title.split('|')[0] || chapterSlug);
      } else {
        chapterTitle = cleanString(chapterTitle);
      }

      // XỬ LÝ RIÊNG CHO NHÁNH GIẢI THƯỞNG (shu1_result)
      if (seriesSlug === 'shu1_result' || seriesTitle.includes('週イチ漫画賞')) {
        const bookMatch = chapterTitle.match(/『(.*?)』/);
        if (bookMatch) {
          const workName = bookMatch[1].trim();
          const awardInfo = cleanString(chapterTitle.replace(/『.*?』/g, ''));
          seriesTitle = workName;
          chapterTitle = awardInfo ? `週イチ漫画賞 ${awardInfo}` : `週イチ漫画賞`;
        }
      }

      // Khử trùng lặp tiêu đề
      if (seriesTitle && chapterTitle && !seriesTitle.includes(chapterTitle)) {
        return `${seriesTitle} - ${chapterTitle}`;
      }
      return seriesTitle || chapterTitle || `Yawaspi_${seriesSlug}_${chapterSlug}`;
    } catch (e) {}

    return `Yawaspi_${seriesSlug}_${chapterSlug}`;
  }

  /* =========================================================================
   * 3. BÓC TÁCH DANH SÁCH ẢNH 0MS TỪ DOM TĨNH (ZERO-NETWORK EXTRACTION)
   * ========================================================================= */
  function extractYawaspiPages() {
    const imgEls = Array.from(DOC.querySelectorAll('.page__detail__vertical .vertical__inner ul li img, .vertical__inner ul li img'));
    if (!imgEls.length) return null;

    const urls = [];
    const seen = new Set();

    for (const img of imgEls) {
      let src = img.getAttribute('src') || img.src || '';
      if (!src || src.startsWith('data:image')) continue;

      const absUrl = new URL(src, WIN.location.origin).href;
      if (!seen.has(absUrl)) {
        seen.add(absUrl);
        urls.push(absUrl);
      }
    }

    if (urls.length === 0) return null;

    const { seriesSlug, chapterSlug } = getUrlSlugs();

    return {
      seriesSlug,
      chapterSlug,
      title: getCleanTitle(),
      urls: urls
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
        data = extractYawaspiPages();
        state.chapterData = data;
      }

      if (!data || !data.urls?.length) throw new Error("Không tìm thấy danh sách trang tranh.");

      const { urls, title, seriesSlug, chapterSlug } = data;
      const totalPages = urls.length;
      if (!totalPages) throw new Error("Không có trang hợp lệ để tải.");

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file định danh ID theo Golden Rule 2
      zip.addFile(`${seriesSlug}_${chapterSlug}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      // Hàng đợi 6 luồng tải song song Zero-Copy từ máy chủ CDN tĩnh
      const tasks = urls.map((url, idx) => async () => {
        const rawBuffer = await Utils.fetchBuffer(url, { "Referer": WIN.location.href });
        const rawUint8 = new Uint8Array(rawBuffer);

        // 🎯 ZERO-TRUST MAGIC BYTES: Nhận diện định dạng nhị phân thực tế của từng trang
        const ext = Utils.detectExt(rawBuffer);

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

      // Đặt tên ZIP chuẩn: [Tên Truyện] - [Tên Chap].zip
      const finalFileName = `${title}.zip`;
      zip.download(finalFileName);

      if (ui) {
        ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
        ui.setBusy(false);
      }
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[yawaspi-dl] Download error:", err);
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
      for (let i = 0; i < 25; i++) {
        data = extractYawaspiPages();
        if (data && data.urls?.length > 0) break;
        await sleep(150);
      }

      if (!data || !data.urls?.length) {
        throw new Error("Không đọc được danh sách trang tranh từ DOM.");
      }
      state.chapterData = data;

      // 🎯 ZERO-TRUST MAGIC BYTES CHECK TRANG 1:
      const firstPageUrl = data.urls[0];
      if (!firstPageUrl) throw new Error("URL trang 1 không hợp lệ.");

      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const testBuf = await Utils.fetchBuffer(firstPageUrl, { "Referer": WIN.location.href });
      const realExt = Utils.detectExt(testBuf);

      data.format = realExt;

      if (ui) {
        await sleep(80);
        ui.updateProgress({
          completed: 0,
          total: data.urls.length,
          status: "Sẵn sàng.",
          format: realExt
        });
        ui.setBusy(false);
      }
    } catch (err) {
      console.error("[yawaspi-dl] Boot error:", err);
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
        state.lastChapterSlug = "";
        state.lastUrl = "";
        state.running = false;
        return;
      }

      const { chapterSlug } = getUrlSlugs();
      if (state.lastChapterSlug && state.lastChapterSlug === chapterSlug) return;

      state.lastUrl = newUrl;
      state.lastChapterSlug = chapterSlug;
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