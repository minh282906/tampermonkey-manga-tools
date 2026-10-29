// ==UserScript==
// @name         Arc Akitashoten Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://arc.akitashoten.co.jp/favicon.ico
// @description  Tải manga trên Akitashoten (arc.akitashoten.co.jp).
// @author       anonymous & AI
// @match        https://arc.akitashoten.co.jp/comics/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      arc.akitashoten.co.jp
// @connect      *.akitashoten.co.jp
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN ---
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/ArcAkitaDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/ArcAkitaDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function arcAkitaUniversalDownloader() {
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
    lastKey: ""
  };

  /* =========================================================================
   * 1. GIAO DIỆN THEME: ĐỎ AKITA SHOTEN (#BA3A30) - NỀN TRẮNG SÁNG
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "arcakita-dl",
        title: "秋田書店",
        engine: "ARC VIEWER",
        themeColor: "#BA3A30",      
        themeBg: "#ffffff",        
        titleColor: "#BA3A30",      
        btnBg: "#BA3A30",           
        btnColor: "#ffffff",       
        tabBg: "#BA3A30",
        tabColor: "#ffffff",
        topOffset: "60px",
        onDownload: startDownload
      };

      state.ui = createUI(uiConfig);
      state.ui.setBusy(true);

      // Cài đặt Header 2 tầng
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
    return /\/comics\/[^\/]+\/\d+/i.test(WIN.location.pathname);
  }

  function getSlugAndVolume() {
    const m = WIN.location.pathname.match(/\/comics\/([^\/?#]+)\/(\d+)/i);
    return m ? { slug: m[1], volume: m[2] } : null;
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

  function getCleanTitle(manifestData) {
    try {
      const ids = getSlugAndVolume();
      let seriesTitle = cleanString(manifestData?.comic?.title || manifestData?.title || "");

      // 1. Quét DOM nếu JSON thiếu tên truyện
      if (!seriesTitle) {
        const titleEl = DOC.querySelector('.comic_data__title, .header .comic_data__title');
        if (titleEl) seriesTitle = cleanString(titleEl.textContent);
      }

      // 2. Dự phòng qua thẻ <title>
      if (!seriesTitle) {
        const rawTitle = DOC.title || "";
        seriesTitle = cleanString(rawTitle.split(/[|｜]/)[0].replace(/[-－–—\s]*秋田書店.*/i, ''));
      }

      // 3. Số tập (Volume)
      let volumeStr = "";
      const volNum = manifestData?.volume || manifestData?.sort_volume || ids?.volume;
      if (volNum) {
        volumeStr = `第${volNum}巻`; // hard code
      }

      if (seriesTitle && volumeStr) {
        if (volumeStr && seriesTitle.endsWith(volumeStr)) {
          return seriesTitle;
        }
        return `${seriesTitle} - ${volumeStr}`;
      }

      return seriesTitle || volumeStr || `Akita_${ids?.slug || 'Comic'}_${ids?.volume || 'Vol'}`;
    } catch (e) {}

    return `Akita_${getSlugAndVolume()?.slug || 'Comic'}`;
  }

  /* =========================================================================
   * 3. BÓC TÁCH MANIFEST TỪ DATA-EPISODE-PATH HOẶC JSON DIRECT
   * ========================================================================= */
  async function fetchArcManifest() {
    const ids = getSlugAndVolume();
    if (!ids) return null;

    const origin = WIN.location.origin;
    const container = DOC.querySelector('.comic[data-episode-path]');
    const path = container?.getAttribute('data-episode-path') || `/comics/${ids.slug}/${ids.volume}.json`;
    const jsonUrl = new URL(path, origin).href;

    const Utils = window.MangaUtils || globalThis.MangaUtils;
    let json = null;

    try {
      const res = await WIN.fetch(jsonUrl);
      if (res.ok) json = await res.json();
    } catch (e) {}

    if (!json) {
      const buf = await Utils.fetchBuffer(jsonUrl, { "Referer": WIN.location.href });
      json = JSON.parse(new TextDecoder().decode(buf));
    }

    if (!json || !Array.isArray(json.episode_pages) || json.episode_pages.length === 0) {
      throw new Error("Không lấy được danh sách trang tranh từ JSON.");
    }

    // 🎯 CHẮC CHẮN LẤY ORIGINAL_URL NGUYÊN BẢN (KHÔNG LẤY BẢN PC RESIZE)
    const pages = json.episode_pages.map((p, idx) => ({
      pageNo: idx + 1,
      url: p.image?.original_url
    })).filter(p => Boolean(p.url));

    return {
      slug: ids.slug,
      volume: ids.volume,
      title: getCleanTitle(json),
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
        data = await fetchArcManifest();
        state.chapterData = data;
      }

      if (!data || !data.pages?.length) throw new Error("Không có trang hợp lệ để tải.");

      const { pages, title, slug, volume } = data;
      const totalPages = pages.length;

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file định danh ID tập truyện
      zip.addFile(`${slug}_${volume}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      // 6 luồng tải song song Zero-Copy trong RAM
      const tasks = pages.map(pageObj => async () => {
        const rawBuffer = await Utils.fetchBuffer(pageObj.url, { "Referer": WIN.location.href });

        // 🎯 ZERO-TRUST MAGIC BYTES: Nhận diện định dạng nhị phân thực tế của từng trang
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

      // Đặt tên ZIP chuẩn: [Tên Truyện] - [Tên Tập].zip
      const finalFileName = `${title}.zip`;
      zip.download(finalFileName);

      if (ui) {
        ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
        ui.setBusy(false);
      }
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[arcakita-dl] Download error:", err);
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

      while (retries < 25) {
        try {
          data = await fetchArcManifest();
          if (data && data.pages?.length > 0) break;
        } catch (e) {}
        await sleep(100);
        retries++;
      }

      if (!data || !data.pages?.length) {
        throw new Error("Không thể lấy danh sách trang từ máy chủ.");
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
          format: realExt
        });
        ui.setBusy(false);
      }
    } catch (err) {
      console.error("[arcakita-dl] Boot error:", err);
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
        state.lastKey = "";
        state.lastUrl = "";
        state.running = false;
        return;
      }

      const ids = getSlugAndVolume();
      const currentKey = ids ? `${ids.slug}_${ids.volume}` : "";
      if (state.lastKey && state.lastKey === currentKey) return;

      state.lastUrl = newUrl;
      state.lastKey = currentKey;
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