// ==UserScript==
// @name         Manga Shinchan Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://manga-shinchan.com/favicon.ico
// @description  Tải manga trên まんがクレヨンしんちゃん.
// @author       anonymous & AI
// @match        https://manga-shinchan.com/*/episode/*
// @match        https://www.manga-shinchan.com/*/episode/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      manga-shinchan.com
// @connect      www.manga-shinchan.com
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/MangaShinchanDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/MangaShinchanDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function mangaShinchanUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6   // 6 luồng tải song song qua máy chủ gốc
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
    lastArticleId: ""
  };

  /* =========================================================================
   * 1. GIAO DIỆN THEME THEO NHẬN DIỆN CRAYON SHIN-CHAN (VÀNG CHÂN PHỐI ĐEN)
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "shinchan-dl",
        title: "Manga Shinchan",
        engine: "FUTABASHA",
        themeColor: "#FCEF4F",     
        themeBg: "#ffffff",        
        titleColor: "#18181b",     
        btnBg: "#FCEF4F",         
        btnColor: "#18181b",      
        topOffset: "189.98px",
        onDownload: startDownload
      };

      state.ui = createUI(uiConfig);
      state.ui.setBusy(true);

      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:${uiConfig.titleColor};letter-spacing:0.3px;">${uiConfig.title}</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px;visibility:hidden;">FUTABASHA</div>
          `;
        }
      }
    }
    return state.ui;
  }

  /* =========================================================================
   * 2. BỘ HỖ TRỢ XỬ LÝ CHUỖI, URL & TIÊU ĐỀ (GOLDEN RULE 1)
   * ========================================================================= */
  function isEpisodeUrl() {
    return /\/episode\/[^\/]+/i.test(WIN.location.pathname);
  }

  function getArticleId() {
    const m = WIN.location.pathname.match(/\/episode\/([^\/?#]+)/i);
    if (m && m[1]) return decodeURIComponent(m[1]);
    const metaId = DOC.querySelector('meta[name="cxenseParse:articleid"]')?.getAttribute('content');
    return metaId ? metaId.trim() : "Shinchan_Episode";
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
      const articleId = getArticleId();

      // 1. Bóc Tên Truyện: Ưu tiên thẻ meta ftb-category (chuẩn 100% không dính Menu)
      let seriesTitle = "";
      const metaCat = DOC.querySelector('meta[name="cxenseParse:ftb-category"]')?.getAttribute('content');
      if (metaCat) {
        seriesTitle = cleanString(metaCat.replace(/\([^)]*\)/g, ''));
      }

      // Dự phòng từ vế 2 của document.title hoặc thẻ h2 nằm CHÍNH XÁC trong item__list-lists
      if (!seriesTitle) {
        const rawTitle = DOC.title || "";
        const parts = rawTitle.split(/[|｜]/);
        if (parts.length >= 2) {
          let sPart = parts[1].replace(/最新話.*$/i, '').trim();
          seriesTitle = cleanString(sPart);
        }
      }
      if (!seriesTitle) {
        const h2El = DOC.querySelector('.item__list-lists h2, div.item__list-lists h2');
        if (h2El) {
          let rawH2 = h2El.textContent || "";
          rawH2 = rawH2.replace(/^[■□◆◇●○★☆・\s]+/, '').replace(/最新話.*$/i, '');
          seriesTitle = cleanString(rawH2);
        }
      }

      // 2. Bóc Tên Chương: Ưu tiên vế 1 của document.title hoặc .ep_blog_titles h1
      let episodeSubTitle = "";
      const rawTitle = DOC.title || "";
      if (rawTitle.includes('|') || rawTitle.includes('｜')) {
        episodeSubTitle = cleanString(rawTitle.split(/[|｜]/)[0]);
      }
      if (!episodeSubTitle) {
        const h1El = DOC.querySelector('.ep_blog_titles h1, .-title h1');
        if (h1El) {
          episodeSubTitle = cleanString(h1El.textContent.replace(/^["'\s\u3000]+|["'\s\u3000]+$/g, ''));
        }
      }

      // 3. Bóc Số Hiệu Chap từ Slug URL (131-hiroshi-... -> 第131話)
      let epNumberPrefix = "";
      const numMatch = articleId.match(/^(\d+)/);
      if (numMatch && numMatch[1]) {
        epNumberPrefix = `第${parseInt(numMatch[1], 10)}話`;
      }

      // 4. Ghép tên chương đầy đủ: 第131話 讃岐うどんの流儀
      let fullEpisodeTitle = "";
      if (epNumberPrefix && episodeSubTitle) {
        fullEpisodeTitle = `${epNumberPrefix} ${episodeSubTitle}`;
      } else {
        fullEpisodeTitle = epNumberPrefix || episodeSubTitle || articleId;
      }

      // 5. Ghép chuẩn Golden Rule 1: [Tên Truyện] - [Tên Chap].zip
      if (seriesTitle && fullEpisodeTitle && !seriesTitle.includes(fullEpisodeTitle)) {
        return `${seriesTitle} - ${fullEpisodeTitle}`;
      }
      if (seriesTitle && fullEpisodeTitle) return fullEpisodeTitle;
      if (seriesTitle) return `${seriesTitle} - ${articleId}`;
    } catch (e) {}

    return `MangaShinchan_${getArticleId()}`;
  }

  /* =========================================================================
   * 3. BÓC TÁCH LINK ẢNH TRUYỆN & ẢNH PR THƯƠNG MẠI (GOLDEN RULE 2)
   * ========================================================================= */
  function extractShinchanPages() {
    const articleId = getArticleId();
    const seen = new Set();

    // A. Bóc tách ảnh truyện chính: /book_data/article_data/
    const mainImgEls = Array.from(DOC.querySelectorAll('.item__list-lists figure img, div.item__list-lists img'));
    const mainUrls = [];

    for (const img of mainImgEls) {
      let src = img.getAttribute('data-src') || img.getAttribute('src') || img.src || '';
      if (!src || src.startsWith('data:') || !src.includes('/book_data/article_data/')) continue;
      const absoluteUrl = new URL(src, WIN.location.origin).href;
      if (!seen.has(absoluteUrl)) {
        seen.add(absoluteUrl);
        mainUrls.push(absoluteUrl);
      }
    }

    if (mainUrls.length === 0) return null;

    // B. Bóc tách ảnh quảng bá thương mại (Additional / PR Pages): /additional_pages/
    const prImgEls = Array.from(DOC.querySelectorAll('.box.-praria img, div.box.-praria img, div.box img'));
    const prUrls = [];

    for (const img of prImgEls) {
      let src = img.getAttribute('data-src') || img.getAttribute('src') || img.src || '';
      if (!src || src.startsWith('data:') || !src.includes('/additional_pages/')) continue;
      const absoluteUrl = new URL(src, WIN.location.origin).href;
      if (!seen.has(absoluteUrl)) {
        seen.add(absoluteUrl);
        prUrls.push(absoluteUrl);
      }
    }

    // C. Xây dựng hàng đợi tải theo chuẩn Golden Rule 2
    // Trang chính: 1..N
    const downloadQueue = mainUrls.map((url, idx) => ({
      url: url,
      fileName: `${idx + 1}`
    }));

    // Trang PR: PR hoặc PR_1, PR_2...
    if (prUrls.length === 1) {
      downloadQueue.push({ url: prUrls[0], fileName: "PR" });
    } else if (prUrls.length > 1) {
      prUrls.forEach((url, idx) => {
        downloadQueue.push({ url: url, fileName: `PR_${idx + 1}` });
      });
    }

    return {
      articleId: articleId,
      title: getCleanTitle(),
      queue: downloadQueue
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
      if (!data || !data.queue?.length) {
        data = extractShinchanPages();
        state.chapterData = data;
      }

      if (!data || !data.queue?.length) throw new Error("Không tìm thấy danh sách ảnh trang truyện.");

      const { queue, title, articleId } = data;
      const totalPages = queue.length;
      if (!totalPages) throw new Error("Không có trang hợp lệ để tải.");

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file định danh ID chương theo Golden Rule 2
      zip.addFile(`${articleId}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      // Hàng đợi tải 6 luồng song song từ máy chủ gốc
      const tasks = queue.map((item) => async () => {
        const rawBuffer = await Utils.fetchBuffer(item.url, { "Referer": WIN.location.href });
        const rawUint8 = new Uint8Array(rawBuffer);
        const ext = Utils.detectExt(rawBuffer) || 'jpg';

        return { fileName: `${item.fileName}.${ext}`, data: rawUint8 };
      });

      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res?.data) zip.addFile(res.fileName, res.data);
      }

      const zipName = `${title || getCleanTitle()}.zip`;
      zip.download(zipName);

      if (ui) {
        ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
        ui.setBusy(false);
      }
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[shinchan-dl] Download error:", err);
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
        data = extractShinchanPages();
        if (data && data.queue?.length > 0) break;
        await sleep(150);
      }

      if (!data || !data.queue?.length) {
        throw new Error("Không đọc được số trang.");
      }
      state.chapterData = data;

      // Kiểm tra Magic Bytes thực tế của trang 1
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const testUrl = data.queue[0]?.url;
      if (!testUrl) throw new Error("URL trang 1 không hợp lệ.");

      const testBuf = await Utils.fetchBuffer(testUrl, { "Referer": WIN.location.href });
      const realExt = Utils.detectExt(testBuf);
      if (!realExt) {
        throw new Error("Không thể nhận diện Magic Bytes ảnh.");
      }

      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: data.queue.length,
          status: "Sẵn sàng.",
          format: realExt
        });
        ui.setBusy(false);
      }
    } catch (e) {
      console.error("[shinchan-dl] Boot error:", e);
      if (ui) {
        ui.updateProgress({ status: "Lỗi: " + (e?.message || "không thể tải trang.") });
        ui.setBusy(true);
      }
    }
  }

  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute((newUrl) => {
      if (!isEpisodeUrl()) {
        const ui = getUI();
        if (ui?.panel) ui.panel.style.display = "none";
        state.chapterData = null;
        state.lastArticleId = "";
        state.lastUrl = "";
        state.running = false;
        return;
      }

      const currentArticleId = getArticleId();
      if (state.lastArticleId && state.lastArticleId === currentArticleId) return;

      state.lastUrl = newUrl;
      state.lastArticleId = currentArticleId;
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