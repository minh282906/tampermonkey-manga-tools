// ==UserScript==
// @name         MangaZenkan Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://www.mangazenkan.com/favicon.svg
// @description  Tải manga trên 漫画全巻ドットコム (mangazenkan.com).
// @author       anonymous & AI
// @match        https://www.mangazenkan.com/viewer/*
// @match        https://mangazenkan.com/viewer/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      mangazenkan.com
// @connect      *.mangazenkan.com
// @connect      ebook.mangazenkan.com
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/decoders/MangaZenkanTools.js
// ==/UserScript==

(function mangaZenkanUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6, // 6 luồng TCP Socket
    JPEG_QUALITY: 1.0  // Chất lượng xuất JPG nếu người dùng chọn
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("mangazenkan-dl:convert-jpeg") === "1",
    chapterData: null,
    ui: null,
    lastUrl: "",
    lastContentsId: ""
  };

  /* =========================================================================
   * 1. GIAO DIỆN THEME: ĐỎ MANGAZENKAN (#E71F18) - NỀN TRẮNG SÁNG
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "mangazenkan-dl",
        title: "漫画全巻",
        engine: "MEDIADO PUBRIDGE",
        themeColor: "#E71F18",
        themeBg: "#ffffff",
        titleColor: "#E71F18",
        btnBg: "#E71F18",
        btnColor: "#ffffff",
        tabBg: "#E71F18",
        tabColor: "#ffffff",
        topOffset: "48px",
        defaultJpgText: "Xuất file JPG (mặc định PNG)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("mangazenkan-dl:convert-jpeg", checked ? "1" : "0");
        }
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
  function isViewerUrl() {
    return WIN.location.pathname.includes('/viewer/');
  }

  function getContentsId() {
    const m = WIN.location.pathname.match(/\/viewer\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : null;
  }

  function cleanString(str) {
    if (!str) return "";
    return str
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/【(?!(?:フルカラー版|カラー版|完全版|特装版))[^】]*】/gi, ' ')
      .replace(/[［\[【](?:ばら売り|分冊版|単話版)[］\]】]/gi, ' ')
      .replace(/[\\/*?:"<>|]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function formatTitle(rawName) {
    if (!rawName) return "MangaZenkan_Book";
    let clean = cleanString(rawName);

    // Chuẩn hóa số toàn giác trong ngoặc: （１） -> （1）
    clean = clean.replace(/（([０-９]+)）/g, (_, n) => {
      const half = n.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
      return `（${half}）`;
    });

    return clean;
  }

  /* =========================================================================
   * 3. BÓC TÁCH MANIFEST TỪ API V2 CONTENT
   * ========================================================================= */
  async function fetchMangaZenkanManifest(contentsId) {
    const sp = new URLSearchParams(WIN.location.search);
    const trialParam = sp.get('trial') || '1';
    const apiUrl = `https://www.mangazenkan.com/api/v2/ebook/content/?contents_id_20=${contentsId}&trial=${trialParam}`;

    const res = await WIN.fetch(apiUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (!data?.page_list?.length) {
      throw new Error("Không nhận được danh sách trang hợp lệ.");
    }

    const cleanTitle = formatTitle(data.title);

    return {
      contentsId,
      title: cleanTitle,
      blockLen: data.BLOCKLEN || 128,
      baseCdn: data.image_cdn_url_base,
      pages: data.page_list
    };
  }

  /* =========================================================================
   * 4. GIẢI MÃ MA TRẬN 128px TRÊN CANVAS PIXEL-PERFECT
   * ========================================================================= */
  async function descramblePage(pageIndex, pageObj, baseCdn, blockLen, isJpg) {
    const Utils = WIN.MangaUtils || window.MangaUtils;
    const Tools = WIN.MangaZenkanTools || window.MangaZenkanTools;

    const fullUrl = `${baseCdn}${pageObj.url}`;
    const rawBuf = await Utils.fetchBuffer(fullUrl, { "Referer": WIN.location.href });

    // Nhận diện MIME type thực tế qua Magic Bytes (Tuyệt đối không hardcode)
    const mime = Utils.detectMimeType(rawBuf);
    const img = await Utils.loadImage(rawBuf, mime);

    // Giải mã ma trận qua MangaZenkanTools
    const res = Tools.descrambleMangaZenkanCanvas(img, pageObj.shuffle_map, blockLen);
    const canvas = res.sharpCanvas;

    // Xuất mảng byte vào ZIP (Mặc định PNG Lossless / Checkbox JPG)
    const outMime = isJpg ? "image/jpeg" : "image/png";
    const outExt = isJpg ? "jpg" : "png";
    const blob = await new Promise(r => canvas.toBlob(r, outMime, CONFIG.JPEG_QUALITY));

    canvas.width = 0;
    canvas.height = 0;

    return {
      fileName: `${pageIndex + 1}.${outExt}`,
      data: new Uint8Array(await blob.arrayBuffer())
    };
  }

  /* =========================================================================
   * 5. TIẾN TRÌNH TẢI CHÍNH & ĐÓNG GÓI PUREZIPWRITER (6 LUỒNG TRONG RAM)
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
        const contentsId = getContentsId();
        if (!contentsId) throw new Error("Không tìm thấy Contents ID.");
        data = await fetchMangaZenkanManifest(contentsId);
        state.chapterData = data;
      }

      const { pages, baseCdn, blockLen, title, contentsId } = data;
      const totalPages = pages.length;
      const useJpeg = Boolean(state.convertJpeg);

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file định danh ${contentsId}.txt
      zip.addFile(`${contentsId}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      // 6 luồng tải song song Zero-Copy trong RAM
      const tasks = pages.map((pageObj, idx) => () => descramblePage(idx, pageObj, baseCdn, blockLen, useJpeg));
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
        throw new Error("Giải mã thất bại toàn bộ các trang ảnh! Hãy kiểm tra kết nối.");
      }

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      const finalFileName = `${title}.zip`;
      zip.download(finalFileName);

      if (ui) {
        ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
        ui.setBusy(false);
      }
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[mangazenkan-dl] Download error:", err);
    } finally {
      state.running = false;
    }
  }

  /* =========================================================================
   * 6. KHỞI CHẠY & THEO DÕI ĐIỀU HƯỚNG SPA
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(20);
    const ui = getUI();

    if (!isViewerUrl()) {
      if (ui?.panel) ui.panel.style.display = "none";
      return;
    }

    if (ui?.panel) {
      ui.panel.style.display = "block";
      ui.setBusy(true);
      ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
    }

    const contentsId = getContentsId();
    if (!contentsId) return;

    try {
      let data = null;
      for (let i = 0; i < 30; i++) {
        try {
          data = await fetchMangaZenkanManifest(contentsId);
          if (data && data.pages?.length > 0) break;
        } catch (e) {}
        await sleep(150);
      }

      if (!data || !data.pages?.length) {
        throw new Error("Không thể trích xuất danh sách trang.");
      }

      state.chapterData = data;

      if (ui) {
        await sleep(80);
        ui.updateProgress({
          completed: 0,
          total: data.pages.length,
          status: "Sẵn sàng."
        });
        ui.setBusy(false);
      }
    } catch (err) {
      console.error("[mangazenkan-dl] Boot error:", err);
      if (ui) {
        ui.updateProgress({ status: "Lỗi: " + (err?.message || "Không thể tải trang.") });
      }
    }
  }

  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute((newUrl) => {
      if (!isViewerUrl()) {
        const ui = getUI();
        if (ui?.panel) ui.panel.style.display = "none";
        state.chapterData = null;
        state.lastContentsId = "";
        state.lastUrl = "";
        state.running = false;
        return;
      }

      const currentContentsId = getContentsId();
      if (state.lastContentsId && state.lastContentsId === currentContentsId) return;

      state.lastUrl = newUrl;
      state.lastContentsId = currentContentsId;
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