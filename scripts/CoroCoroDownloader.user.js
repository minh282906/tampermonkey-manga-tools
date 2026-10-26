// ==UserScript==
// @name         CoroCoro Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://www.corocoro.jp/favicon.ico
// @description  Tải manga trên CoroCoro Online / 週刊コロコロコミック (corocoro.jp).
// @author       anonymous & AI
// @match        https://www.corocoro.jp/chapter/*
// @match        https://corocoro.jp/chapter/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      corocoro.jp
// @connect      www.corocoro.jp
// @connect      img.www.corocoro.jp
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/CorocoroDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/CorocoroDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function corocoroUniversalDownloader() {
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
    lastChapterId: ""
  };

  /* =========================================================================
   * 1. HOOK MẠNG ĐÁNH CHẶN API /api/csr (0ms, KHỬ 100% LỖI 500 DOUBLE-FETCH)
   * ========================================================================= */
  let capturedChapterId = null;
  let capturedApiText = null;

  function handleViewerResponse(url, text) {
    if (typeof text === 'string' && text.includes('chapter_page') && text.includes('enc')) {
      const m = url.match(/chapter_id=(\d+)/);
      if (m) capturedChapterId = m[1];
      capturedApiText = text;
    }
  }

  const origFetch = WIN.fetch;
  if (typeof origFetch === 'function') {
    WIN.fetch = async function(...args) {
      const res = await origFetch.apply(this, args);
      try {
        const u = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        if (String(u).includes('rq=chapter/viewer') || String(u).includes('chapter_id=')) {
          res.clone().text().then(txt => handleViewerResponse(String(u), txt)).catch(() => {});
        }
      } catch (e) {}
      return res;
    };
  }

  const origXhrOpen = WIN.XMLHttpRequest?.prototype?.open;
  const origXhrSend = WIN.XMLHttpRequest?.prototype?.send;
  if (origXhrOpen && origXhrSend) {
    WIN.XMLHttpRequest.prototype.open = function(method, url) {
      this._reqUrl = url;
      return origXhrOpen.apply(this, arguments);
    };
    WIN.XMLHttpRequest.prototype.send = function() {
      this.addEventListener('load', () => {
        if (this._reqUrl && (String(this._reqUrl).includes('rq=chapter/viewer') || String(this._reqUrl).includes('chapter_id='))) {
          handleViewerResponse(this._reqUrl, this.responseText);
        }
      });
      return origXhrSend.apply(this, arguments);
    };
  }

  /* =========================================================================
   * 2. GIAO DIỆN THEME COROCORO: ĐỎ LỬA (#E60013) - NỀN TRẮNG SÁNG
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "corocoro-dl",
        title: "CoroCoro Comic",
        engine: "SHOGAKUKAN",
        themeColor: "#E60013",      // Đỏ cờ CoroCoro huyền thoại
        themeBg: "#FFF000",         // Nền trắng sáng nguyên bản
        titleColor: "#01A0E9",      // Chữ tiêu đề đỏ
        btnBg: "#E60013",           // Nút bấm nền đỏ
        btnColor: "#ffffff",        // Chữ nút trắng
        tabBg: "#E60013",
        tabColor: "#ffffff",
        topOffset: "42px",
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
   * 3. BỘ HỖ TRỢ XỬ LÝ CHUỖI, URL & TIÊU ĐỀ
   * ========================================================================= */
  function isEpisodeUrl() {
    return /\/chapter\/\d+(?:\/viewer)?/i.test(WIN.location.pathname);
  }

  function getChapterId() {
    const m = WIN.location.pathname.match(/\/chapter\/(\d+)/i);
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

  function unhex(hexString) {
    const clean = String(hexString || '').trim().replace(/[^0-9a-fA-F]/g, '');
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  function getCleanTitle(rawText = "") {
    try {
      const chapterId = getChapterId();
      let seriesTitle = "";
      let chapterTitle = "";

      // 1. 🎯 ƯU TIÊN SỐ 1: Bóc trực tiếp từ cặp <p> và <h3> của Header DOM (Chuẩn 100% mọi loại chap: +スクープ, 番外編...)
      const colEl = Array.from(DOC.querySelectorAll('div.flex-col')).find(el => el.querySelector('p') && el.querySelector('h3'));
      if (colEl) {
        seriesTitle = cleanString(colEl.querySelector('p')?.textContent);
        chapterTitle = cleanString(colEl.querySelector('h3')?.textContent);
      }

      // 2. DỰ PHÒNG TỪ GÓI TIN RAWTEXT: Bóc trọn vẹn chuỗi giữa ", và " のXページ"
      if (!seriesTitle || !chapterTitle) {
        if (rawText) {
          const lineM = rawText.match(/",([^\r\n]+?)[　\s]+の\d+ページ/);
          if (lineM) {
            const fullText = lineM[1].trim(); // "デュエル・マスターズRX 第14話＋スクープ25" hoặc "デュエル・マスターズRX スクープ2"
            if (seriesTitle && fullText.startsWith(seriesTitle)) {
              chapterTitle = cleanString(fullText.substring(seriesTitle.length));
            } else {
              // Tách theo khoảng trắng trước các từ khóa chương: 第, スクープ, 特別, 番外...
              const splitM = fullText.match(/^(.*?)\s+((?:第|スクープ|特別|番外|[0-9０-９]+).*)$/i);
              if (splitM) {
                if (!seriesTitle) seriesTitle = cleanString(splitM[1]);
                if (!chapterTitle) chapterTitle = cleanString(splitM[2]);
              } else if (!seriesTitle) {
                seriesTitle = cleanString(fullText);
              }
            }
          }
        }
      }

      // 3. DỰ PHÒNG CUỐI: Từ thẻ og:title
      if (!seriesTitle || !chapterTitle) {
        const rawTitle = DOC.querySelector('meta[property="og:title"]')?.getAttribute('content') || DOC.title || "";
        const mainPart = rawTitle.split(/[|｜]/)[0].trim().replace(/\s+[^\s]+,[^\s]+$/, '');
        const splitM = mainPart.match(/^(.*?)\s+((?:第|スクープ|特別|番外|[0-9０-９]+).*)$/i);
        if (splitM) {
          if (!seriesTitle) seriesTitle = cleanString(splitM[1]);
          if (!chapterTitle) chapterTitle = cleanString(splitM[2]);
        }
      }

      if (seriesTitle && chapterTitle) {
        return chapterTitle.startsWith(seriesTitle) ? chapterTitle : `${seriesTitle} - ${chapterTitle}`;
      }
      return seriesTitle || chapterTitle || `CoroCoro_${chapterId}`;
    } catch (e) {}

    return `CoroCoro_${getChapterId() || 'Episode'}`;
  }

  /* =========================================================================
   * KÉO GÓI TIN CHỦ ĐỘNG BẰNG HTTP METHOD PUT
   * ========================================================================= */
  async function fetchChapterConfig(chapterId) {
    const apiUrl = `https://www.corocoro.jp/api/csr?rq=chapter/viewer&chapter_id=${chapterId}&use_ticket=0&event_point=0&paid_point=0`;
    
    // 1. Ưu tiên fetch native của tab (nhanh 0ms)
    try {
      const res = await WIN.fetch(apiUrl, { method: 'PUT', credentials: 'include' });
      if (res.ok) return await res.text();
    } catch (e) {}

    // 2. Dự phòng qua GM_xmlhttpRequest nếu tab bị vướng
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "PUT",
        url: apiUrl,
        headers: {
          "Referer": WIN.location.href,
          "Origin": "https://www.corocoro.jp"
        },
        onload: res => (res.status >= 200 && res.status < 300) ? resolve(res.responseText) : reject(new Error(`HTTP ${res.status}`)),
        onerror: () => reject(new Error("Lỗi kết nối API Corocoro")),
        ontimeout: () => reject(new Error("Timeout kết nối API Corocoro"))
      });
    });
  }

  /* =========================================================================
   * 4. BÓC TÁCH GÓI TIN MANIFEST, KEY VÀ IV
   * ========================================================================= */
  async function resolveChapterData(chapterId) {
    let rawText = capturedApiText;
    if (!rawText) {
      rawText = await fetchChapterConfig(chapterId);
      capturedApiText = rawText;
    }

    if (!rawText) throw new Error("Không lấy được gói tin khởi tạo từ máy chủ CoroCoro.");

    // 1. Bóc tách Key (64-hex) và IV (32-hex)
    const cryptoMatch = rawText.match(/@?(?<key>[0-9a-fA-F]{64}).*?(?<iv>[0-9a-fA-F]{32})/);
    if (!cryptoMatch || !cryptoMatch.groups?.key || !cryptoMatch.groups?.iv) {
      throw new Error("Không tìm thấy cặp khóa AES-CBC hợp lệ trong gói tin.");
    }
    const { key, iv } = cryptoMatch.groups;

    // 2. Bóc tách danh sách ảnh truyện chính .webp.enc
    const urlRegex = new RegExp(`https:\\/\\/img\\.www\\.corocoro\\.jp\\/chapter_page\\/${chapterId}\\/\\d+\\.(?:webp|jpe?g|png|avif)\\.enc\\?[^\\s"'\\x00-\\x1f,]+`, 'gi');
    const matchedUrls = rawText.match(urlRegex) || [];
    const uniqueUrls = Array.from(new Set(matchedUrls));

    uniqueUrls.sort((a, b) => {
      const numA = parseInt(a.match(/\/(\d+)\.webp\.enc/i)?.[1] || 0, 10);
      const numB = parseInt(b.match(/\/(\d+)\.webp\.enc/i)?.[1] || 0, 10);
      return numA - numB;
    });

    const mangaPages = uniqueUrls.map((url, idx) => ({
      pageNo: idx + 1,
      baseName: String(idx + 1),
      url: url,
      key: key,
      iv: iv,
      isEncrypted: true
    }));

    // 3. TÁCH RIÊNG ẢNH PR THƯƠNG MẠI (/banner/)
    const bannerRegex = /https:\/\/img\.www\.corocoro\.jp\/banner\/\d+\.webp\?h=[^&\s"'\*]+&e=\d+/gi;
    const bannerMatches = rawText.match(bannerRegex) || [];
    const uniqueBanners = Array.from(new Set(bannerMatches));

    const prPages = uniqueBanners.map((url, idx) => ({
      pageNo: mangaPages.length + idx + 1,
      baseName: uniqueBanners.length === 1 ? 'PR' : `PR_${idx + 1}`,
      url: url,
      isEncrypted: false
    }));

    const allPages = [...mangaPages, ...prPages];

    return {
      chapterId: String(chapterId),
      title: getCleanTitle(rawText),
      pages: allPages
    };
  }

  /* =========================================================================
   * 5. MẬT MÃ HỌC SHOGAKUKAN: GIẢI MÃ PHẦN CỨNG AES-256-CBC ZERO-COPY
   * ========================================================================= */
  async function decryptAndFormatImage(pageItem) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;

    // Kéo mảng byte nhị phân thô từ CDN Akamai
    let buffer = await Utils.fetchBuffer(pageItem.url, { "Referer": "https://www.corocoro.jp/" });

    // Chỉ giải mã AES-256-CBC nếu là ảnh truyện chính bị mã hóa (.webp.enc)
    if (pageItem.isEncrypted && pageItem.key && pageItem.iv) {
      const cryptoKey = await WIN.crypto.subtle.importKey(
        "raw",
        unhex(pageItem.key),
        { name: "AES-CBC" },
        false,
        ["decrypt"]
      );

      buffer = await WIN.crypto.subtle.decrypt(
        { name: "AES-CBC", iv: unhex(pageItem.iv) },
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
   * 6. TIẾN TRÌNH TẢI CHÍNH & ZERO-COPY 0MS VÀO ZIP
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
        data = await resolveChapterData(chapterId);
        state.chapterData = data;
      }

      const { pages, title } = data;
      const totalPages = pages.length;
      if (!totalPages) throw new Error("Không có trang hợp lệ để tải.");

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file định danh ID chương theo Golden Rule 2
      zip.addFile(`${chapterId}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      // Hàng đợi 6 luồng tải song song Zero-Copy trong RAM
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
      const finalFileName = `${cleanString(title || getCleanTitle())}.zip`;
      zip.download(finalFileName);

      if (ui) {
        ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
        ui.setBusy(false);
      }
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[corocoro-dl] Download error:", err);
    } finally {
      state.running = false;
    }
  }

  /* =========================================================================
   * 7. KHỞI CHẠY (BOOT) & ĐỒNG BỘ TRẠNG THÁI
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

      while (retries < 30) {
        try {
          data = await resolveChapterData(chapterId);
          if (data && data.pages?.length > 0) break;
        } catch (e) {}
        await sleep(150);
        retries++;
      }

      if (!data || !data.pages?.length) {
        throw new Error("Không lấy được danh sách trang truyện.");
      }
      state.chapterData = data;

      // Soi Magic Bytes trực tiếp trang 1 sau khi giải mã AES-256-CBC
      const firstPage = data.pages[0];
      if (!firstPage?.url) throw new Error("URL trang 1 không hợp lệ.");

      const Utils = window.MangaUtils || globalThis.MangaUtils;
      let testBuf = await Utils.fetchBuffer(firstPage.url, { "Referer": "https://www.corocoro.jp/" });

      const cryptoKey = await WIN.crypto.subtle.importKey(
        "raw",
        unhex(firstPage.key),
        { name: "AES-CBC" },
        false,
        ["decrypt"]
      );
      testBuf = await WIN.crypto.subtle.decrypt(
        { name: "AES-CBC", iv: unhex(firstPage.iv) },
        cryptoKey,
        testBuf
      );

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
      console.error("[corocoro-dl] Boot error:", err);
      if (ui) {
        ui.updateProgress({ status: "Lỗi: " + (err?.message || "không thể tải trang.") });
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
        capturedChapterId = null;
        capturedApiText = null;
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
      capturedChapterId = null;
      capturedApiText = null;
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