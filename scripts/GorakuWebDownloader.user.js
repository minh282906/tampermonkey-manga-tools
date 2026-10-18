// ==UserScript==
// @name         Gorakuweb Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://gorakuweb.com/favicon.ico
// @description  Tải manga trên Gorakuweb / ゴラクうぇぶ！ (gorakuweb.com) giải mã AES-128-CBC Zero-Copy 0ms.
// @author       anonymous & AI
// @match        https://gorakuweb.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      gorakuweb.com
// @connect      *.gorakuweb.com
// @connect      gorakuweb-content.akamaized.net
// @connect      gorakuweb-asset.akamaized.net
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function gorakuwebUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6 // 6 luồng tải song song (TCP Socket)
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
   * 1. GIAO DIỆN THEME: XANH LÁ GORAKUWEB (#20A462) - NỀN TRẮNG SÁNG
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "goraku-dl",
        title: "Goraku Web!",
        engine: "NIHON BUNGEISHA",
        themeColor: "#20A462",      
        themeBg: "#ffffff",     
        titleColor: "#20A462",   
        btnBg: "#20A462",        
        btnColor: "#ffffff", 
        tabBg: "#20A462",
        tabColor: "#ffffff",
        topOffset: "68.57px",
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
   * 2. BỘ HỖ TRỢ XỬ LÝ CHUỖI, URL & HEX BYTES
   * ========================================================================= */
  function isEpisodeUrl() {
    return /\/episode\/\d+/i.test(WIN.location.pathname);
  }

  function getEpisodeIds() {
    const match = WIN.location.pathname.match(/\/episode\/(\d+)(?:\/(\d+))?/i);
    return {
      titleId: match ? match[1] : null,
      episodeId: match && match[2] ? match[2] : null
    };
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

  function hexToBytes(hex) {
    const clean = String(hex || '').trim().replace(/[^0-9a-fA-F]/g, '');
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  /* =========================================================================
   * 3. BÓC TÁCH CẤU TRÚC JSON TỪ LUỒNG REACT SERVER COMPONENTS (NEXT.JS)
   * ========================================================================= */
  function extractGorakuSection(rawStr, targetId = null) {
    if (!rawStr || typeof rawStr !== 'string' || !rawStr.includes('keyBytes')) return null;

    // [ID-LOCKING] Nếu có targetId mà chuỗi không chứa ID này -> Từ chối ngay lập tức để chống lấy nhầm chap cũ!
    if (targetId && !rawStr.includes(String(targetId))) return null;

    const keyIdx = rawStr.indexOf('keyBytes');
    if (keyIdx === -1) return null;

    let startIdx = rawStr.lastIndexOf('{"titleId"', keyIdx);
    if (startIdx === -1) startIdx = rawStr.lastIndexOf('{\\"titleId\\"', keyIdx);
    if (startIdx === -1) startIdx = rawStr.lastIndexOf('{', keyIdx);
    if (startIdx === -1) return null;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = startIdx; i < rawStr.length; i++) {
      const ch = rawStr[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }

      if (!inString) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            let jsonSnippet = rawStr.slice(startIdx, i + 1);

            if (jsonSnippet.includes('\\"')) {
              jsonSnippet = jsonSnippet
                .replace(/\\"/g, '"')
                .replace(/\\\\/g, '\\')
                .replace(/\\n/g, '\n')
                .replace(/\\r/g, '\r')
                .replace(/\\t/g, '\t');
            }

            try {
              const parsed = JSON.parse(jsonSnippet);
              if (parsed.keyBytes && parsed.ivBytes && parsed.base && parsed.metadata?.pages) {
                // Kiểm tra ID trong JSON có khớp với ID trên thanh URL không
                if (targetId) {
                  const pEp = String(parsed.episodeId || '');
                  const pTi = String(parsed.titleId || '');
                  if (pEp !== String(targetId) && pTi !== String(targetId)) return null;
                }
                return parsed;
              }
            } catch (e) {}
            break;
          }
        }
      }
    }
    return null;
  }

  async function fetchGorakuManifest(targetId = null) {
    let viewerData = null;

    // 1. Quét từ window.__next_f theo thứ tự TỪ MỚI VỀ CŨ (Reverse Loop)
    if (Array.isArray(WIN.__next_f)) {
      for (let i = WIN.__next_f.length - 1; i >= 0; i--) {
        const item = WIN.__next_f[i];
        if (Array.isArray(item) && typeof item[1] === 'string' && item[1].includes('keyBytes')) {
          viewerData = extractGorakuSection(item[1], targetId);
          if (viewerData?.metadata?.pages?.length) break;
        }
      }
    }

    // 2. Dự phòng: Quét các thẻ script trong DOM (có kiểm tra targetId)
    if (!viewerData || !viewerData.metadata?.pages?.length) {
      const scripts = DOC.querySelectorAll('script');
      for (const s of scripts) {
        const txt = s.textContent || '';
        if (txt.includes('keyBytes')) {
          viewerData = extractGorakuSection(txt, targetId);
          if (viewerData?.metadata?.pages?.length) break;
        }
      }
    }

    // 3. VƯỢT BẪY SPA: Nếu RAM chỉ toàn chunk cũ, kéo trực tiếp RSC tươi mới từ server
    if (!viewerData || !viewerData.metadata?.pages?.length) {
      try {
        const Utils = window.MangaUtils || globalThis.MangaUtils;
        const buf = await Utils.fetchBuffer(WIN.location.href, { 'RSC': '1', 'Referer': WIN.location.href });
        const txt = new TextDecoder().decode(buf);
        viewerData = extractGorakuSection(txt, targetId);
      } catch (e) {}
    }

    if (!viewerData || !viewerData.metadata?.pages?.length) {
      return null;
    }

    const { base, accessKey, keyBytes, ivBytes, metadata, titleId, episodeId } = viewerData;

    const pages = metadata.pages.map((p, idx) => ({
      pageNo: idx + 1,
      filename: p.filename || String(p.page),
      url: `${base}/${p.filename || p.page}?__token__=${accessKey}`,
      key: keyBytes,
      iv: ivBytes
    }));

    let seriesTitle = cleanString(viewerData.seriesTitle || "");
    let chapterTitle = cleanString(viewerData.title || "");

    if (!seriesTitle) {
      const sEl = DOC.querySelector('h1[class*="textStyle_bold.15"], [class*="grid-area_seriesHeader"] h1, h1');
      if (sEl) seriesTitle = cleanString(sEl.textContent);
    }
    if (!chapterTitle) {
      const cEl = DOC.querySelector('h1.grid-area_title, [class*="grid-area_title"], .title');
      if (cEl) chapterTitle = cleanString(cEl.textContent);
    }

    let fullTitle = "";
    if (seriesTitle && chapterTitle) {
      fullTitle = chapterTitle.startsWith(seriesTitle)
        ? chapterTitle
        : `${seriesTitle} - ${chapterTitle}`;
    } else {
      fullTitle = seriesTitle || chapterTitle || `Goraku_${episodeId || titleId}`;
    }

    return {
      titleId: String(titleId || ""),
      episodeId: String(episodeId || titleId || "chapter"),
      title: fullTitle,
      pages: pages
    };
  }

  /* =========================================================================
   * 4. MẬT MÃ HỌC: GIẢI MÃ PHẦN CỨNG AES-128-CBC TRONG RAM (ZERO-COPY)
   * ========================================================================= */
  async function decryptAndFormatImage(pageItem) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;

    // 1. Tải mảng byte nhị phân thô từ Akamai CDN
    const encryptedBuffer = await Utils.fetchBuffer(pageItem.url, { "Referer": "https://gorakuweb.com/" });

    // 2. Giải mã khối phần cứng AES-128-CBC trong RAM
    const cryptoKey = await WIN.crypto.subtle.importKey(
      "raw",
      hexToBytes(pageItem.key),
      { name: "AES-CBC" },
      false,
      ["decrypt"]
    );

    const decryptedBuffer = await WIN.crypto.subtle.decrypt(
      { name: "AES-CBC", iv: hexToBytes(pageItem.iv) },
      cryptoKey,
      encryptedBuffer
    );

    const decryptedBytes = new Uint8Array(decryptedBuffer);

    // 3. Nhận diện Magic Bytes thực tế (WebP hoặc JPEG)
    const ext = Utils.detectExt(decryptedBytes.buffer);

    return {
      fileName: `${pageItem.pageNo}.${ext}`,
      data: decryptedBytes
    };
  }

  /* =========================================================================
   * 5. TIẾN TRÌNH TẢI CHÍNH & ĐÓNG GÓI PUREZIPWRITER
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
        data = await fetchGorakuManifest();
        state.chapterData = data;
      }

      const { pages, title, episodeId } = data;
      const totalPages = pages.length;
      if (!totalPages) throw new Error("Không có trang hợp lệ để tải.");

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file định danh ID chương theo Golden Rule 2
      zip.addFile(`${episodeId}.txt`, new Uint8Array(0));
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
      const finalFileName = `${title}.zip`;
      zip.download(finalFileName);

      if (ui) {
        ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
        ui.setBusy(false);
      }
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[goraku-dl] Download error:", err);
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

    const { titleId, episodeId } = getEpisodeIds();
    const currentTargetId = episodeId || titleId;

    try {
      let data = null;
      let retries = 0;

      while (retries < 3) {
        try {
          data = await fetchGorakuManifest(currentTargetId);
          if (data && data.pages?.length > 0) break;
        } catch (e) {}
        await sleep(150);
        retries++;
      }

      if (!data || !data.pages?.length) {
        throw new Error("Không lấy được danh sách trang truyện (hoặc chương đã bị đóng).");
      }
      state.chapterData = data;

      // SOI MAGIC BYTES TRỰC TIẾP TRANG 1 SAU KHI GIẢI MÃ PHẦN CỨNG AES-128-CBC (ZERO-TRUST)
      const firstPage = data.pages[0]; // bên này dùng data.pages[0].url
      if (!firstPage?.url) throw new Error("URL trang 1 không hợp lệ.");

      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const encBuf = await Utils.fetchBuffer(firstPage.url, { "Referer": "https://gorakuweb.com/" });
      const cryptoKey = await WIN.crypto.subtle.importKey(
        "raw",
        hexToBytes(firstPage.key),
        { name: "AES-CBC" },
        false,
        ["decrypt"]
      );
      const decBuf = await WIN.crypto.subtle.decrypt(
        { name: "AES-CBC", iv: hexToBytes(firstPage.iv) },
        cryptoKey,
        encBuf
      );

      const realExt = Utils.detectExt(decBuf);
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
      console.error("[goraku-dl] Boot error:", err);
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
        state.lastEpisodeId = "";
        state.lastUrl = "";
        state.running = false;
        return;
      }

      const { titleId, episodeId } = getEpisodeIds();
      const currentMarker = episodeId || titleId || WIN.location.pathname;
      if (state.lastEpisodeId && state.lastEpisodeId === currentMarker) return;

      state.lastUrl = newUrl;
      state.lastEpisodeId = currentMarker;
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