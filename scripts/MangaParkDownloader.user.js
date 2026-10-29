// ==UserScript==
// @name         Manga Park Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://manga-park.com/favicon.ico
// @description  Tải manga trên Manga Park (manga-park.com).
// @author       anonymous & AI
// @match        https://manga-park.com/*
// @match        https://www.manga-park.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      manga-park.com
// @connect      www.manga-park.com
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN ---
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/MangaParkDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/MangaParkDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function mangaParkUniversalDownloader() {
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
    isTransitioning: false,
    chapterData: null,
    activeChapterId: null,
    ui: null,
    lastUrl: ""
  };

  /* =========================================================================
   * 1. HOOK MẠNG ĐÁNH CHẶN API /api/chapter/{id} (0ms, BẮT CHUYỂN CHƯƠNG SPA)
   * ========================================================================= */
  function handleChapterResponse(url, responseText) {
    const m = String(url).match(/\/api\/chapter\/(\d+)/);
    if (m && responseText) {
      try {
        const json = typeof responseText === 'string' ? JSON.parse(responseText) : responseText;
        if (json?.data?.chapter) {
          onChapterLoaded(m[1], json.data);
        }
      } catch (e) {}
    }
  }

  const origFetch = WIN.fetch;
  if (typeof origFetch === 'function') {
    WIN.fetch = async function(...args) {
      const res = await origFetch.apply(this, args);
      try {
        const u = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        if (String(u).includes('/api/chapter/')) {
          res.clone().text().then(txt => handleChapterResponse(u, txt)).catch(() => {});
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
        if (this._reqUrl && String(this._reqUrl).includes('/api/chapter/')) {
          handleChapterResponse(this._reqUrl, this.responseText);
        }
      });
      return origXhrSend.apply(this, arguments);
    };
  }

  /* =========================================================================
   * 2. GIAO DIỆN UNIVERSAL UI CHUẨN THEME MANGA PARK (XANH NGỌC - NỀN TRẮNG SÁNG)
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "mangapark-dl",
        title: "マンガPark",
        engine: "HAKUSENSHA",
        themeColor: "#50BFCC",      
        themeBg: "#ffffff",        
        titleColor: "#2FA4B0",     
        btnBg: "#50BFCC",           
        btnColor: "#ffffff",        
        tabBg: "#50BFCC",
        tabColor: "#ffffff",
        topOffset: "70px",        
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
   * 3. BỘ HỖ TRỢ XỬ LÝ CHUỖI, URL & TIÊU ĐỀ
   * ========================================================================= */
  function cleanString(str) {
    if (!str) return "";
    return str
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/【(?!(?:フルカラー版|カラー版|完全版|特装版))[^】]*】/gi, '')
      .replace(/[\\/*?:"<>|]/g, '')
      .trim();
  }

  function getCleanTitle(chapterId) {
    try {
      // 1. Tên Bộ Truyện từ <title> hoặc meta og:title
      let seriesTitle = "";
      const rawTitle = DOC.querySelector('meta[property="og:title"]')?.getAttribute('content') || DOC.title || "";
      const parts = rawTitle.split(/[|｜]/).map(p => cleanString(p));
      seriesTitle = parts[0]?.replace(/\s*[-－–—]?\s*(?:マンガPark|マンガパーク|白泉社).*$/i, '').trim();

      // 2. Tên Chương: Bóc trực tiếp từ thanh header của chính trình đọc
      let chapterTitle = "";
      const headerTitleEl = DOC.querySelector('.viewer .header .title-name, .header .title-name');
      if (headerTitleEl && headerTitleEl.textContent) {
        chapterTitle = cleanString(headerTitleEl.textContent);
      }

      // Dự phòng từ thẻ li danh sách nếu viewer chưa mở header
      if (!chapterTitle && chapterId) {
        const liEl = DOC.querySelector(`li[data-chapter-id="${chapterId}"]`);
        if (liEl) {
          chapterTitle = cleanString(liEl.querySelector('.chapterTitle, .chapter_title, [class*="title"]')?.textContent);
        }
      }

      if (seriesTitle && chapterTitle) {
        if (chapterTitle.startsWith(seriesTitle)) {
          chapterTitle = cleanString(chapterTitle.substring(seriesTitle.length));
        }
        chapterTitle = chapterTitle.replace(/^[・･\s-]+/, '').trim();
        return `${seriesTitle} - ${chapterTitle}`;
      }

      return seriesTitle || chapterTitle || `MangaPark_${chapterId || 'Episode'}`;
    } catch (e) {}

    return `MangaPark_${chapterId || 'Episode'}`;
  }

  /* =========================================================================
   * 4. MẬT MÃ HỌC MANGAPARK: BITWISE CYCLIC 16-BYTE XOR TRONG RAM (0MS)
   * ========================================================================= */
  function parseBase64Key(keyBase64) {
    const binary = atob(keyBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function decryptMangaPark(rawBuffer, keyBase64) {
    const raw = new Uint8Array(rawBuffer);
    const keyBytes = parseBase64Key(keyBase64);
    const decrypted = new Uint8Array(raw.length);
    const keyLen = keyBytes.length || 16;

    // Vòng lặp XOR chu kỳ 16 byte siêu tốc trên CPU RAM
    for (let i = 0; i < raw.length; i++) {
      decrypted[i] = raw[i] ^ keyBytes[i % keyLen];
    }
    return decrypted;
  }

  async function decryptAndFormatImage(pageItem) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;

    // 1. Tải mảng byte nhị phân qua GM_xmlhttpRequest
    const rawBuffer = await Utils.fetchBuffer(pageItem.url, { "Referer": "https://manga-park.com/" });

    // 2. Giải mã Cyclic 16-byte XOR trực tiếp trong RAM (0ms)
    const decryptedBytes = decryptMangaPark(rawBuffer, pageItem.key);

    // 🎯 3. ZERO-TRUST MAGIC BYTES: Nhận diện định dạng nhị phân thực tế của từng trang
    const ext = Utils.detectExt(decryptedBytes.buffer);

    return {
      fileName: `${pageItem.pageNo}.${ext}`,
      data: decryptedBytes
    };
  }

  /* =========================================================================
   * 5. TIẾN TRÌNH TẢI CHÍNH (6 LUỒNG TRONG RAM & ZERO-COPY ZIP)
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    const chapterId = state.activeChapterId;
    if (!chapterId || !state.chapterData?.pages?.length) {
      if (ui) ui.updateProgress({ status: "Lỗi: Không tìm thấy dữ liệu chương." });
      return;
    }

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      const { pages } = state.chapterData;
      const totalPages = pages.length;

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file định danh ID chương
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
      const finalFileName = `${getCleanTitle(chapterId)}.zip`;
      zip.download(finalFileName);

      if (ui) {
        ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
        ui.setBusy(false);
      }
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[mangapark-dl] Download error:", err);
    } finally {
      state.running = false;
    }
  }

  /* =========================================================================
   * 6. ĐIỀU PHỐI DỮ LIỆU CHƯƠNG & CHỐNG CHỚP UI KHI CHUYỂN CHAP
   * ========================================================================= */
  async function onChapterLoaded(chapterId, apiData) {
    if (!apiData?.chapter || !Array.isArray(apiData.chapter)) return;

    const pages = [];
    for (let i = 0; i < apiData.chapter.length; i++) {
      const item = apiData.chapter[i];
      const img = item.images?.[0];
      if (img?.path && img?.key) {
        pages.push({
          pageNo: i + 1,
          url: img.path,
          key: img.key
        });
      }
    }

    if (pages.length === 0) return;

    // 🔒 KHÓA BẢO VỆ: Đang nạp chap, cấm tuyệt đối watcher giật lệnh ẩn UI!
    state.isTransitioning = true;
    state.activeChapterId = String(chapterId);
    state.chapterData = { chapterId: String(chapterId), pages };

    const ui = getUI();
    if (ui?.panel) {
      ui.panel.style.display = "block"; // Bật hiển thị ngay lập tức
      ui.setBusy(true);

      // Reset số trang và trạng thái mượt mà (không làm chớp tắt giao diện)
      ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
    }

    // 🎯 ZERO-TRUST MAGIC BYTES CHECK TRANG 1:
    try {
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const firstPage = pages[0];
      const testBuf = await Utils.fetchBuffer(firstPage.url, { "Referer": "https://manga-park.com/" });
      const decrypted = decryptMangaPark(testBuf, firstPage.key);

      const realExt = Utils.detectExt(decrypted.buffer);
      if (!realExt) throw new Error("Không thể nhận diện Magic Bytes ảnh.");

      if (ui) {
        await sleep(80);
        ui.updateProgress({
          completed: 0,
          total: pages.length,
          status: "Sẵn sàng.",
          format: realExt // Khóa cứng nhãn UI "Ảnh gốc là EXT" theo chuẩn Zero-Copy
        });
        ui.setBusy(false);
      }
    } catch (e) {
      if (ui) {
        ui.updateProgress({ status: "Sẵn sàng." });
        ui.setBusy(false);
      }
    } finally {
      state.isTransitioning = false; // Đã nạp xong xuôi, mở khóa watcher
    }
  }

  /* =========================================================================
   * 7. GIÁM SÁT TRẠNG THÁI VIEWER & BẮT SỰ KIỆN NÚT X ĐÓNG TRÌNH ĐỌC
   * ========================================================================= */
  function watchViewerState() {
    let missingCount = 0;

    setInterval(() => {
      const ui = state.ui;
      if (!ui?.panel) return;

      // 🎯 BẮT SỰ KIỆN CLICK NÚT X ĐÓNG VIEWER: Ẩn ngay lập tức trong 0ms
      const closeBtn = DOC.querySelector('.viewer .header .close, .header .close, .closeBtn');
      if (closeBtn && !closeBtn.__mp_hooked) {
        closeBtn.__mp_hooked = true;
        closeBtn.addEventListener('click', () => {
          ui.panel.style.display = "none";
          state.chapterData = null;
          state.activeChapterId = null;
          state.isTransitioning = false;
        });
      }

      // 🎯 CHỈ NHẬN DIỆN VIEWER QUA #minobi HOẶC .viewer (TUYỆT ĐỐI BỎ QUA .viewer-base)
      const isViewerOpen = Boolean(DOC.getElementById('minobi') || DOC.querySelector('.viewer'));

      if (isViewerOpen) {
        missingCount = 0;
        return; // Đang xem truyện bình thường -> Không làm gì cả
      }

      // Nếu viewer biến mất khỏi DOM (đã thoát ra danh sách chương):
      // Chỉ ẩn UI khi vắng mặt 3 chu kỳ liên tiếp (~1.2s) để tránh giật lúc chuyển chap
      if (!state.running && !state.isTransitioning && state.activeChapterId) {
        missingCount++;
        if (missingCount >= 3) {
          if (ui.panel.style.display !== "none") {
            ui.panel.style.display = "none";
            state.chapterData = null;
            state.activeChapterId = null;
          }
          missingCount = 0;
        }
      }
    }, 400);
  }

  watchViewerState();
})();