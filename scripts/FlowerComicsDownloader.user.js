// ==UserScript==
// @name         Flower Comics Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://flowercomics.jp/assets/app-icon/favicon.png
// @description  Tải manga trên Flower Comics / フラコミlike! (flowercomics.jp) giải mã AES-256-CBC Zero-Copy 0ms.
// @author       anonymous & AI
// @match        https://flowercomics.jp/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      flowercomics.jp
// @connect      *.flowercomics.jp
// @connect      img.flowercomics.jp
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function flowerComicsUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6   // 6 luồng TCP Socket kịch trần
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
    lastChapterId: ""
  };

  /* =========================================================================
   * 1. GIAO DIỆN THEME: HỒNG HOA FLOWER COMICS (#E54D80) - NỀN TRẮNG SÁNG
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "flowercomics-dl",
        title: "フラコミlike!",
        engine: "SHOGAKUKAN",
        themeColor: "#5CC2D0",      
        themeBg: "#ffffff",         
        titleColor: "#d9af24",      
        btnBg: "#5CC2D0",          
        btnColor: "#ffffff",        
        tabBg: "#5CC2D0",
        tabColor: "#ffffff",
        topOffset: "46px",
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
   * 2. BỘ HỖ TRỢ XỬ LÝ CHUỖI, URL & METADATA
   * ========================================================================= */
  function isEpisodeUrl() {
    return /\/chapter\/\d+\/viewer/i.test(WIN.location.pathname);
  }

  function getChapterId() {
    const match = WIN.location.pathname.match(/\/chapter\/(\d+)\/viewer/i);
    return match ? match[1] : null;
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

  function unescapeRscString(str) {
    if (!str) return '';
    return str
      .replace(/\\u0026/g, '&')
      .replace(/&amp;/g, '&')
      .replace(/\\"/g, '"')
      .replace(/\\\//g, '/')
      .replace(/\\\\/g, '\\');
  }

  function hexToBytes(hex) {
    const clean = String(hex || '').trim().replace(/[^0-9a-fA-F]/g, '');
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  /* =========================================================================
   * 3. BÓC TÁCH BRACKET PARSER TỪ LUỒNG REACT SERVER COMPONENTS (NEXT.JS)
   * ========================================================================= */
  function extractViewerSection(rawStr) {
    if (!rawStr || !rawStr.includes('viewerSection')) return null;

    const keyStr = '"viewerSection":';
    const idx = rawStr.indexOf(keyStr);
    if (idx === -1) return null;
    const braceStart = rawStr.indexOf('{', idx + keyStr.length);
    if (braceStart === -1) return null;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = braceStart; i < rawStr.length; i++) {
      const ch = rawStr[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }

      if (!inString) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            const jsonStr = rawStr.slice(braceStart, i + 1);
            try {
              return JSON.parse(jsonStr);
            } catch (e) {
              return null;
            }
          }
        }
      }
    }
    return null;
  }

  async function fetchFlowerComicsManifest(chapterId) {
    let viewerData = null;

    // 1. Quét nhanh từ mảng stream window.__next_f trong RAM (0ms)
    if (Array.isArray(WIN.__next_f)) {
      for (const item of WIN.__next_f) {
        if (Array.isArray(item) && typeof item[1] === 'string' && item[1].includes('viewerSection')) {
          viewerData = extractViewerSection(item[1]);
          if (viewerData?.pages?.length) break;
        }
      }
    }

    // 2. Dự phòng quét các thẻ script trong DOM
    if (!viewerData || !viewerData.pages?.length) {
      const scripts = DOC.querySelectorAll('script');
      for (const s of scripts) {
        const txt = s.textContent || '';
        if (txt.includes('viewerSection')) {
          viewerData = extractViewerSection(txt);
          if (viewerData?.pages?.length) break;
        }
      }
    }

    // 3. Dự phòng SPA: Kéo gói stream tươi mới qua URL với header RSC: 1
    if (!viewerData || !viewerData.pages?.length) {
      try {
        const Utils = window.MangaUtils || globalThis.MangaUtils;
        const buf = await Utils.fetchBuffer(WIN.location.href, { 'RSC': '1', 'Referer': WIN.location.href });
        const txt = new TextDecoder().decode(buf);
        viewerData = extractViewerSection(txt);
      } catch (e) {}
    }

    if (!viewerData || !viewerData.pages?.length) {
      throw new Error("Không thể bóc tách cấu trúc viewerSection từ gói tin Next.js.");
    }

    // Phân loại: Trang truyện chính vs Banner quảng cáo cuối chương theo Golden Rule 2
    const mangaPages = [];
    const bannerPages = [];

    for (const item of viewerData.pages) {
      if (!item.src) continue;
      const cleanUrl = unescapeRscString(item.src);

      if (item.crypto?.key && item.crypto?.iv) {
        mangaPages.push({
          url: cleanUrl,
          key: item.crypto.key,
          iv: item.crypto.iv,
          isEncrypted: true
        });
      } else if (cleanUrl.includes('/banner/')) {
        bannerPages.push({
          url: cleanUrl,
          isEncrypted: false
        });
      }
    }

    // Đánh số thứ tự chuẩn Golden Rules:
    // Trang truyện chính: 1.webp, 2.webp...
    // Trang banner PR: PR.webp (nếu 1 ảnh) hoặc PR_1.webp, PR_2.webp...
    mangaPages.forEach((p, idx) => {
      p.baseName = String(idx + 1);
    });
    bannerPages.forEach((p, idx) => {
      p.baseName = bannerPages.length === 1 ? 'PR' : `PR_${idx + 1}`;
    });

    const allPages = [...mangaPages, ...bannerPages];
    if (allPages.length === 0) {
      throw new Error("Không tìm thấy trang truyện hợp lệ để tải.");
    }

    // Tiêu đề chuẩn: [Tên Truyện] - [Tên Chap].zip
    const seriesTitle = cleanString(viewerData.titleName || "");
    const chapterName = cleanString(viewerData.currentChapterName || "");
    let fullTitle = "";

    if (seriesTitle && chapterName) {
      fullTitle = chapterName.startsWith(seriesTitle)
        ? chapterName
        : `${seriesTitle} - ${chapterName}`;
    } else {
      fullTitle = seriesTitle || chapterName || `FlowerComics_${chapterId}`;
    }

    return {
      chapterId: String(chapterId),
      title: fullTitle,
      pages: allPages
    };
  }

  /* =========================================================================
   * 4. MẬT MÃ HỌC SHOGAKUKAN: GIẢI MÃ PHẦN CỨNG AES-256-CBC
   * ========================================================================= */
  async function decryptAndFormatImage(pageItem) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;

    // 1. Kéo mảng byte nhị phân thô qua GM_xmlhttpRequest
    let buffer = await Utils.fetchBuffer(pageItem.url, { "Referer": "https://flowercomics.jp/" });

    // 2. Giải mã phần cứng AES-256-CBC trong RAM nếu là ảnh truyện bị mã hóa
    if (pageItem.isEncrypted && pageItem.key && pageItem.iv) {
      const cryptoKey = await WIN.crypto.subtle.importKey(
        "raw",
        hexToBytes(pageItem.key),
        { name: "AES-CBC" },
        false,
        ["decrypt"]
      );

      buffer = await WIN.crypto.subtle.decrypt(
        { name: "AES-CBC", iv: hexToBytes(pageItem.iv) },
        cryptoKey,
        buffer
      );
    }

    const decryptedBytes = new Uint8Array(buffer);
    const ext = Utils.detectExt(decryptedBytes.buffer);

    return {
      fileName: `${pageItem.baseName}.${ext}`,
      data: decryptedBytes
    };
  }

  /* =========================================================================
   * 5. TIẾN TRÌNH TẢI CHÍNH & ZERO-COPY 0MS VÀO ZIP
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    const chapterId = getChapterId();
    if (!chapterId) {
      if (ui) ui.updateProgress({ status: "Lỗi: Không tìm thấy ID chương." });
      return;
    }

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let data = state.chapterData;
      if (!data || !data.pages?.length) {
        data = await fetchFlowerComicsManifest(chapterId);
        state.chapterData = data;
      }

      const { pages, title } = data;
      const totalPages = pages.length;
      if (!totalPages) throw new Error("Không có trang hợp lệ để tải.");

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file định danh ID chương theo Golden Rules
      zip.addFile(`${chapterId}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      // 6 luồng tải song song Zero-Copy trong RAM
      const tasks = pages.map(pageItem => () => decryptAndFormatImage(pageItem));
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
        throw new Error("Giải mã thất bại toàn bộ các trang ảnh! Hãy kiểm tra lại kết nối.");
      }

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      // Đặt tên ZIP chuẩn: [Tên Truyện] - [Tên Chap].zip
      const finalFileName = `${cleanString(title)}.zip`;
      zip.download(finalFileName);

      if (ui) {
        ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
        ui.setBusy(false);
      }
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[flowercomics-dl] Download error:", err);
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

    if (!isEpisodeUrl()) {
      if (ui?.panel) ui.panel.style.display = "none";
      return;
    }

    if (ui?.panel) {
      ui.panel.style.display = "block";
      ui.setBusy(true);
      ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
    }

    const chapterId = getChapterId();
    if (!chapterId) return;

    try {
      let data = null;
      let retries = 0;

      while (retries < 25) {
        try {
          data = await fetchFlowerComicsManifest(chapterId);
          if (data && data.pages?.length > 0) break;
        } catch (e) {}
        await sleep(150);
        retries++;
      }

      if (!data || !data.pages?.length) {
        throw new Error("Không lấy được danh sách trang truyện.");
      }
      state.chapterData = data;

      // SOI MAGIC BYTES TRỰC TIẾP TRANG 1 SAU KHI GIẢI MÃ AES-CBC (ZERO-TRUST)
      const firstPage = data.pages[0]; // bên này dùng data.pages[0].url
      if (!firstPage?.url) throw new Error("URL trang 1 không hợp lệ.");

      const Utils = window.MangaUtils || globalThis.MangaUtils;
      let testBuf = await Utils.fetchBuffer(firstPage.url, { "Referer": "https://flowercomics.jp/" });

      if (firstPage.isEncrypted && firstPage.key && firstPage.iv) {
        const cryptoKey = await WIN.crypto.subtle.importKey(
          "raw",
          hexToBytes(firstPage.key),
          { name: "AES-CBC" },
          false,
          ["decrypt"]
        );
        testBuf = await WIN.crypto.subtle.decrypt(
          { name: "AES-CBC", iv: hexToBytes(firstPage.iv) },
          cryptoKey,
          testBuf
        );
      }

      const realExt = Utils.detectExt(testBuf);
      if (!realExt) throw new Error("Không thể nhận diện Magic Bytes ảnh.");

      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: data.pages.length,
          status: "Sẵn sàng.",
          format: realExt
        });
        ui.setBusy(false);
      }
    } catch (err) {
      console.error("[flowercomics-dl] Boot error:", err);
      if (ui) {
        ui.updateProgress({ status: "Lỗi: " + (err?.message || "không thể tải trang.") });
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
        state.lastChapterId = "";
        state.lastUrl = "";
        state.running = false;
        return;
      }

      const currentChapterId = getChapterId();
      if (state.lastChapterId && state.lastChapterId === currentChapterId) return;

      state.lastUrl = newUrl;
      state.lastChapterId = currentChapterId;
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