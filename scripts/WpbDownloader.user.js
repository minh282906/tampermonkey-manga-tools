// ==UserScript==
// @name         WPB Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://wpb.shueisha.co.jp/favicon.ico
// @description  Tải manga trên 週プレNEWS.
// @author       anonymous & AI
// @match        https://wpb.cdn.cloudpublisher.jp/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      wpb.cdn.cloudpublisher.jp
// @connect      *.cloudpublisher.jp
// @connect      wpb.shueisha.co.jp
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN ---
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/WpbDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/WpbDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function wpbUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6   // 6 luồng TCP Socket
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
    lastUid: ""
  };

  /* =========================================================================
   * 1. GIAO DIỆN THEME: ĐỎ CỜ 週プレNEWS (#C53125) - NỀN TRẮNG SÁNG
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "wpb-dl",
        title: "週プレNEWS",
        engine: "SHUEISHA",
        themeColor: "#C53125",     
        themeBg: "#ffffff",        
        titleColor: "#C53125",      
        btnBg: "#C53125",          
        btnColor: "#ffffff",      
        tabBg: "#C53125",
        tabColor: "#ffffff",
        topOffset: "50px",
        onDownload: startDownload
      };

      state.ui = createUI(uiConfig);
      state.ui.setBusy(true);

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
  function isReaderUrl() {
    return /view\d*\.php/i.test(WIN.location.pathname) || WIN.location.search.includes('p=');
  }

  function getUid() {
    const uidInput = DOC.getElementById('viewerUid');
    if (uidInput && uidInput.value) return uidInput.value.trim();
    const sp = new URLSearchParams(WIN.location.search);
    return sp.get('p') || "WPB_Manga";
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

  function getCleanTitle(configTitle) {
    try {
      let rawTitle = configTitle || DOC.title || "";
      rawTitle = cleanString(rawTitle.replace(/\s*[-|｜]\s*(?:週プレNEWS|週刊プレイボーイ|集英社).*$/i, ''));

      // Tự động phân tách: [Tên Truyện] - [Tên Chap]
      const m = rawTitle.match(/^(.*?)(?:[\s\u3000]+)((?:第\s*[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\.]+\s*(?:話|回|巻|章|節|部)?).*)$/i);
      if (m) {
        const series = cleanString(m[1]);
        const chapter = cleanString(m[2]);
        if (series && chapter) return `${series} - ${chapter}`;
      }

      if (rawTitle) return rawTitle;
    } catch (e) {}

    return `WPB_${getUid()}`;
  }

  /* =========================================================================
   * 3. BÓC TÁCH MANIFEST 0MS (ZERO-NETWORK EXTRACTION)
   * ========================================================================= */
  function fetchWpbManifest() {
    const uid = getUid();
    const filesEl = DOC.getElementById('viewerFiles');
    const configEl = DOC.getElementById('viewerConfig');

    let fileList = [];
    let title = "";

    // 1. Ưu tiên bóc tách từ các thẻ hidden input của server (0ms)
    if (filesEl && filesEl.value) {
      try {
        const parsed = JSON.parse(filesEl.value);
        if (Array.isArray(parsed?.files)) fileList = parsed.files;
      } catch (e) {}
    }

    if (configEl && configEl.value) {
      try {
        const parsedCfg = JSON.parse(configEl.value);
        if (parsedCfg?.title) title = cleanString(parsedCfg.title);
      } catch (e) {}
    }

    // 2. Dự phòng quét thẻ ảnh trực tiếp trong DOM (nếu server không in input)
    if (fileList.length === 0) {
      const imgEls = DOC.querySelectorAll('ul.items li[data-type="item"] img, img.image.item');
      imgEls.forEach(img => {
        const src = img.getAttribute('src');
        if (src && src.includes('f.php?f=')) {
          const match = src.match(/f=([a-zA-Z0-9_-]+)/);
          if (match && match[1]) {
            // Tách phần tên file phía sau uid
            const rawFileName = match[1].replace(uid, '');
            if (rawFileName && !fileList.includes(rawFileName)) {
              fileList.push(rawFileName);
            }
          }
        }
      });
    }

    if (fileList.length === 0) return null;

    const origin = WIN.location.origin;
    const pages = fileList.map((fileName, idx) => ({
      pageNo: idx + 1,
      fileName: fileName,
      url: `${origin}/s/f.php?f=${uid}${fileName}`
    }));

    return {
      uid,
      title: getCleanTitle(title),
      pages
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
        data = fetchWpbManifest();
        state.chapterData = data;
      }

      if (!data || !data.pages?.length) throw new Error("Không tìm thấy danh sách trang tranh.");

      const { pages, title, uid } = data;
      const totalPages = pages.length;

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file định danh UID
      zip.addFile(`${uid}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      // 6 luồng tải song song Zero-Copy trong RAM
      const tasks = pages.map(pageItem => async () => {
        const rawBuffer = await Utils.fetchBuffer(pageItem.url, { "Referer": WIN.location.href });
        
        // 🎯 ZERO-TRUST MAGIC BYTES: Nhận diện định dạng nhị phân thực tế của từng trang
        const ext = Utils.detectExt(rawBuffer);

        return {
          fileName: `${pageItem.pageNo}.${ext}`,
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
      console.error("[wpb-dl] Download error:", err);
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

    if (!isReaderUrl()) {
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
        data = fetchWpbManifest();
        if (data && data.pages?.length > 0) break;
        await sleep(100);
        retries++;
      }

      if (!data || !data.pages?.length) {
        throw new Error("Không thể bóc tách danh sách trang từ máy chủ.");
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
      console.error("[wpb-dl] Boot error:", err);
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
      if (!isReaderUrl()) {
        const ui = getUI();
        if (ui?.panel) ui.panel.style.display = "none";
        state.chapterData = null;
        state.lastUid = "";
        state.lastUrl = "";
        state.running = false;
        return;
      }

      const currentUid = getUid();
      if (state.lastUid && state.lastUid === currentUid) return;

      state.lastUrl = newUrl;
      state.lastUid = currentUid;
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