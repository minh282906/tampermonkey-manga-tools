// ==UserScript==
// @name         Manga-no Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://manga-no.com/favicon.ico
// @description  Tải manga trên Manga-no (manga-no.com).
// @author       anonymous & AI
// @match        https://manga-no.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      manga-no.com
// @connect      *.manga-no.com
// @connect      img.manga-no.com
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function mangaNoUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6   // 6 luồng S3
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
    lastEpisodeId: ""
  };

  /* =========================================================================
   * 1. GIAO DIỆN THEME: ĐEN LOGO CLOUD - NỀN TRẮNG SÁNG
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "mangano-dl",
        title: "マンガノ",
        engine: "HATENA",
        themeColor: "#262626",      
        themeBg: "#ffffff",         
        titleColor: "#262626",      
        btnBg: "#262626",           
        btnColor: "#ffffff",        
        topOffset: "64px",
        onDownload: startDownload
      }
      
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
    return /\/episodes\/[a-zA-Z0-9_-]+/i.test(WIN.location.pathname);
  }

  function getEpisodeId() {
    const match = WIN.location.pathname.match(/\/episodes\/([a-zA-Z0-9_-]+)/i);
    return match ? match[1] : "MangaNo_Episode";
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

  function getCleanTitle(manifestTitle) {
    if (manifestTitle) return manifestTitle;

    try {
      const rawTitle = DOC.title || DOC.querySelector('meta[property="og:title"]')?.getAttribute('content') || "";
      let clean = cleanString(rawTitle.replace(/[-－–—\s]*マンガノ.*$/i, ''));

      // Tách cấu trúc: [Tên Chap] ([Tên Truyện] / [Tác Giả])
      const m = clean.match(/^(.*?)\s*[\(（](.*?)(?:\s*[/／]\s*.*?)?[\)）]$/);
      if (m && m[1] && m[2]) {
        const ep = cleanString(m[1]);
        const ser = cleanString(m[2]);
        if (ser === ep) return ser;
        return `${ser} - ${ep}`;
      }

      if (clean) return clean;
    } catch (e) {}

    return `MangaNo_${getEpisodeId()}`;
  }

  // CẤM TUYỆT ĐỐI FALLBACK: Bắt buộc phải là link gốc S3, không được thì ném lỗi
  function extractTrueOriginUrl(url) {
    if (!url || typeof url !== 'string') throw new Error("URL ảnh không hợp lệ.");

    if (url.startsWith('https://img.manga-no.com/')) return url;

    // Bóc tách URL S3 gốc được mã hóa ở đuôi proxy cdn-scissors
    const match = url.match(/https%3A%2F%2Fimg\.manga-no\.com%2F[^\s"';&?]+/i);
    if (match) {
      return decodeURIComponent(match[0]);
    }

    const directMatch = url.match(/https:\/\/img\.manga-no\.com\/[^\s"';&?]+/i);
    if (directMatch) return directMatch[0];

    // Ném lỗi ngay lập tức, tuyệt đối KHÔNG trả về link cdn-scissors nén quality=80
    throw new Error(`Phát hiện link không thuộc máy chủ gốc S3: ${url}`);
  }

  /* =========================================================================
   * 3. BÓC TÁCH MANIFEST: TRỊ DỨT ĐIỂM BẪY 0/1 KHI CHUYỂN TRANG SPA
   * ========================================================================= */
  function parseApolloState(apolloState, episodeId) {
    if (!apolloState) return null;

    const epNodeKey = Object.keys(apolloState).find(k => k === `Episode:${episodeId}` || k.includes(episodeId));
    const epData = apolloState[epNodeKey];
    if (!epData) return null;

    // KIỂM TRA TÍNH TOÀN VẸN: Nếu là cache cũ từ trang danh sách, edges sẽ bị thiếu so với totalCount
    const expectedTotal = epData.pages?.totalCount || 0;
    const edges = epData.pages?.edges || [];

    if (expectedTotal > 1 && edges.length <= 1) {
      return null; // Từ chối cache cũ từ trang danh sách truyện
    }

    let seriesTitle = "";
    const workRef = epData.work?.__ref;
    if (workRef && apolloState[workRef]) {
      seriesTitle = cleanString(apolloState[workRef].title || "");
    }

    const episodeTitle = cleanString(epData.title || "");
    let finalTitle = "";
    if (seriesTitle && episodeTitle && seriesTitle !== episodeTitle) {
      finalTitle = `${seriesTitle} - ${episodeTitle}`;
    } else {
      finalTitle = seriesTitle || episodeTitle;
    }

    const urls = [];
    for (const edge of edges) {
      const pageRef = edge?.node?.__ref;
      const pageData = apolloState[pageRef];
      const imgRef = pageData?.image?.__ref;
      const imgData = apolloState[imgRef];

      if (imgData?.url) {
        urls.push(extractTrueOriginUrl(imgData.url));
      }
    }

    return urls.length > 0 ? { urls, title: finalTitle } : null;
  }

  function extractFromGigaViewerDOM() {
    const gigaViewer = DOC.querySelector('giga-viewer[page-structure]');
    if (!gigaViewer) return null;

    try {
      const rawJson = gigaViewer.getAttribute('page-structure');
      const data = JSON.parse(rawJson || '{}');
      const mainPages = (data.pages || []).filter(p => p.type === 'main' || !p.type);

      const urls = mainPages.map(p => extractTrueOriginUrl(p.src || p.url)).filter(Boolean);
      return urls.length > 0 ? { urls, title: "" } : null;
    } catch (e) {
      return null;
    }
  }

  async function fetchMangaNoManifest(episodeId) {
    let manifest = null;

    // 1. GIẢI PHÁP VƯỢT BẪY SPA (0/1): Kéo trực tiếp Next.js data route tươi mới khi chuyển trang
    const buildId = WIN.__NEXT_DATA__?.buildId;
    if (buildId) {
      try {
        const res = await WIN.fetch(`https://manga-no.com/_next/data/${buildId}/episodes/${episodeId}.json`);
        if (res.ok) {
          const json = await res.json();
          const freshApollo = json?.pageProps?.initialApolloState;
          if (freshApollo) {
            manifest = parseApolloState(freshApollo, episodeId);
          }
        }
      } catch (e) {}
    }

    // 2. Nếu là lần F5 tải trang đầu tiên -> Đọc Apollo State trong RAM (chỉ nhận nếu đầy đủ trang)
    if (!manifest || manifest.urls.length <= 1) {
      const ramApollo = WIN.__NEXT_DATA__?.props?.pageProps?.initialApolloState;
      if (ramApollo) {
        const ramManifest = parseApolloState(ramApollo, episodeId);
        if (ramManifest && ramManifest.urls.length > 1) {
          manifest = ramManifest;
        }
      }
    }

    // 3. Dự phòng đợi Web Component <giga-viewer> mount xong trên DOM
    if (!manifest || manifest.urls.length <= 1) {
      for (let i = 0; i < 20; i++) {
        const domManifest = extractFromGigaViewerDOM();
        if (domManifest && domManifest.urls.length > 1) {
          manifest = domManifest;
          break;
        }
        await sleep(150);
      }
    }

    if (!manifest || !manifest.urls?.length) {
      throw new Error("Không thể trích xuất danh sách ảnh chương Manga-no.");
    }

    return {
      episodeId: episodeId,
      urls: manifest.urls,
      title: manifest.title || getCleanTitle("")
    };
  }

  /* =========================================================================
   * 4. TIẾN TRÌNH TẢI CHÍNH & ZERO-COPY 0MS VÀO ZIP
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    const episodeId = getEpisodeId();
    if (!episodeId) {
      if (ui) ui.updateProgress({ status: "Lỗi: Không tìm thấy ID chương." });
      return;
    }

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let data = state.chapterData;
      if (!data || !data.urls?.length) {
        data = await fetchMangaNoManifest(episodeId);
        state.chapterData = data;
      }

      const { urls, title } = data;
      const totalPages = urls.length;
      if (!totalPages) throw new Error("Không có trang hợp lệ để tải.");

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // File định danh ID chương
      zip.addFile(`${episodeId}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      // Hàng đợi tải 6 luồng từ kho S3 gốc img.manga-no.com
      const tasks = urls.map((url, idx) => async () => {
        let rawBuffer = null;

        try {
          const res = await WIN.fetch(url);
          if (res.ok) rawBuffer = await res.arrayBuffer();
        } catch (e) {}

        if (!rawBuffer) {
          rawBuffer = await Utils.fetchBuffer(url, { "Referer": "https://manga-no.com/" });
        }

        const rawUint8 = new Uint8Array(rawBuffer);
        const ext = Utils.detectExt(rawBuffer);

        return { fileName: `${idx + 1}.${ext}`, data: rawUint8 };
      });

      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res?.data) zip.addFile(res.fileName, res.data);
      }

      const zipName = `${title}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[mangano-dl] Download error:", err);
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
      ui.setBusy(true);
      ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
    }
    
    try {
      const episodeId = getEpisodeId();
      if (!episodeId) {
        throw new Error("Không tìm thấy ID chương.");
      }

      const data = await fetchMangaNoManifest(episodeId);
      if (!data || !data.urls?.length) {
        throw new Error("Không lấy được danh sách trang.");
      }
      state.chapterData = data;

      const testUrl = data.urls[0]; // bên này dùng data.urls[0]
      if (!testUrl) throw new Error("URL trang 1 không hợp lệ.");

      const Utils = window.MangaUtils || globalThis.MangaUtils;
      let testBuf = null;
      try {
        const res = await WIN.fetch(testUrl);
        if (res.ok) testBuf = await res.arrayBuffer();
      } catch (e) {}

      if (!testBuf) {
        testBuf = await Utils.fetchBuffer(testUrl, { "Referer": "https://manga-no.com/" });
      }

      const realExt = Utils.detectExt(testBuf);
      if (!realExt) {
        throw new Error("Không thể nhận diện Magic Bytes ảnh.");
      }

      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: data.urls.length,
          status: "Sẵn sàng.",
          format: realExt
        });
        ui.setBusy(false);
      }
    } catch (e) {
      console.error("[mangano-dl] Boot error:", e);
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
        state.lastEpisodeId = "";
        state.lastUrl = ""; 
        state.running = false;
        return;
      }

      const currentEpisodeId = getEpisodeId();
      if (state.lastEpisodeId && state.lastEpisodeId === currentEpisodeId) return;

      state.lastUrl = newUrl;
      state.lastEpisodeId = currentEpisodeId;
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