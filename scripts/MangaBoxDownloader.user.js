// ==UserScript==
// @name         MangaBox Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://image.cdn.mangabox.me/static/assets/favicon.ico
// @description  Tải manga trên MangaBox (mangabox.me).
// @author       anonymous & AI
// @match        https://www.mangabox.me/reader/*
// @match        https://mangabox.me/reader/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      mangabox.me
// @connect      www.mangabox.me
// @connect      *.mangabox.me
// @connect      image-a.mangabox.me
// @connect      image-c.cdn.mangabox.me
// @connect      *.cdn.mangabox.me
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN ---
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/MangaBoxDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/MangaBoxDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function mangaBoxUniversalDownloader() {
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
    lastEpisodeId: ""
  };

  /* =========================================================================
   * 1. GIAO DIỆN UNIVERSAL UI CHUẨN THEME MANGABOX (#379ABC - NỀN TRẮNG SÁNG)
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "mangabox-dl",
        title: "Manga Box",
        engine: "MANGABOX",
        themeColor: "#379ABC",      // Xanh Cyan MangaBox chính thức
        themeBg: "#ffffff",         // Nền trắng sáng
        titleColor: "#379ABC",      // Tiêu đề xanh Cyan
        btnBg: "#379ABC",           // Nút bấm xanh Cyan
        btnColor: "#ffffff",        // Chữ nút trắng
        tabBg: "#379ABC",
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
   * 2. BỘ HỖ TRỢ XỬ LÝ CHUỖI, URL & TIÊU ĐỀ
   * ========================================================================= */
  function isEpisodeUrl() {
    return /\/reader\/\d+\/episodes\/\d+/i.test(WIN.location.pathname);
  }

  function getEpisodeId() {
    const m = WIN.location.pathname.match(/\/episodes\/(\d+)/i);
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

  function getCleanTitle(mangaTitle, episodeId) {
    try {
      let seriesTitle = cleanString(mangaTitle);
      let chapterTitle = "";

      // 1. Quét DOM tiêu đề chương Nuxt (thẻ chứa class _title__sub_)
      const subEl = DOC.querySelector('[class*="_title__sub_"], [class*="titleSub"], [class*="episodeTitle"]');
      if (subEl) {
        chapterTitle = cleanString(subEl.textContent);
      }

      // 2. Bóc tách từ thẻ <title> nếu DOM chưa kịp nạp
      if (!chapterTitle) {
        const rawTitle = DOC.title || "";
        const m = rawTitle.match(/((?:第\s*[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\.]+\s*(?:話|回|巻|章|節|部|エピソード|分冊版|単話)?)|特別編|番外編)/i);
        if (m) chapterTitle = cleanString(m[1]);
      }

      // 3. Dự phòng tên series từ <title> nếu API không trả về
      if (!seriesTitle) {
        const rawTitle = DOC.title || "";
        const parts = rawTitle.split(/[|｜]/).map(p => cleanString(p));
        seriesTitle = parts[0]?.replace(/^マンガボックス\s*[\/／]\s*/i, '').trim();
      }

      if (seriesTitle && chapterTitle) {
        if (chapterTitle.startsWith(seriesTitle)) {
          chapterTitle = cleanString(chapterTitle.substring(seriesTitle.length));
        }
        chapterTitle = chapterTitle.replace(/^[・･\s-]+/, '').trim();
        return `${seriesTitle} - ${chapterTitle}`;
      }

      return seriesTitle || chapterTitle || `MangaBox_${episodeId || 'Episode'}`;
    } catch (e) {}

    return `MangaBox_${episodeId || 'Episode'}`;
  }

  /* =========================================================================
   * 3. MẬT MÃ HỌC MANGABOX: BITWISE 1-BYTE XOR NỘI SUY TRONG RAM
   * ========================================================================= */
  function decryptMangaBox(rawBuffer, mask) {
    const raw = new Uint8Array(rawBuffer);
    const decrypted = new Uint8Array(raw.length);
    const byteMask = mask & 0xFF; // Chuẩn hóa về mặt nạ 8-bit unsigned (0..255)

    // Vòng lặp XOR giải mã siêu tốc 0ms trên CPU RAM
    for (let i = 0; i < raw.length; i++) {
      decrypted[i] = raw[i] ^ byteMask;
    }

    return decrypted;
  }

  /* =========================================================================
   * 4. BÓC TÁCH GÓI TIN MANIFEST TỪ API HONSHI
   * ========================================================================= */
  async function fetchMangaBoxManifest(episodeId) {
    const apiUrl = `https://www.mangabox.me/api/honshi/episode/${episodeId}/images`;
    const Utils = window.MangaUtils || globalThis.MangaUtils;

    // Dual-Flight API Caller: fetch tab trước -> GM_xmlhttpRequest dự phòng
    let json = null;
    try {
      const res = await WIN.fetch(apiUrl, { credentials: "include" });
      if (res.ok) json = await res.json();
    } catch (e) {}

    if (!json) {
      const buf = await Utils.fetchBuffer(apiUrl, { "Referer": WIN.location.href });
      json = JSON.parse(new TextDecoder().decode(buf));
    }

    if (!json || !Array.isArray(json.imageUrls) || json.imageUrls.length === 0) {
      throw new Error("Không thể bóc tách danh sách ảnh từ máy chủ MangaBox.");
    }

    return {
      episodeId: String(episodeId),
      mangaTitle: json.manga?.title || "",
      mask: Number(json.mask || 0),
      imageUrls: json.imageUrls
    };
  }

  async function decryptAndFormatImage(url, mask, pageNo) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;

    // 1. Kéo mảng byte nhị phân qua GM_xmlhttpRequest
    const rawBuffer = await Utils.fetchBuffer(url, { "Referer": "https://www.mangabox.me/" });

    // 2. Giải mã nhị phân 1-byte XOR trực tiếp trong RAM (0ms)
    const decryptedBytes = decryptMangaBox(rawBuffer, mask);

    // 🎯 3. ZERO-TRUST MAGIC BYTES: Nhận diện định dạng thực tế từ mảng byte sau giải mã
    const ext = Utils.detectExt(decryptedBytes.buffer);

    return {
      fileName: `${pageNo}.${ext}`,
      data: decryptedBytes
    };
  }

  /* =========================================================================
   * 5. TIẾN TRÌNH TẢI CHÍNH & ZERO-COPY 0MS VÀO ZIP
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
      if (!data || !data.imageUrls?.length) {
        data = await fetchMangaBoxManifest(episodeId);
        state.chapterData = data;
      }

      const { imageUrls, mask, mangaTitle } = data;
      const totalPages = imageUrls.length;
      if (!totalPages) throw new Error("Không có trang hợp lệ để tải.");

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file định danh ID chương
      zip.addFile(`${episodeId}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      // 6 luồng tải song song Zero-Copy trong RAM
      const tasks = imageUrls.map((url, idx) => () => decryptAndFormatImage(url, mask, idx + 1));
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
      const finalTitle = getCleanTitle(mangaTitle, episodeId);
      const finalFileName = `${finalTitle}.zip`;
      zip.download(finalFileName);

      if (ui) {
        ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
        ui.setBusy(false);
      }
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[mangabox-dl] Download error:", err);
    } finally {
      state.running = false;
    }
  }

  /* =========================================================================
   * 6. KHỞI CHẠY (BOOT) & ĐỒNG BỘ TRẠNG THÁI
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

    const episodeId = getEpisodeId();
    if (!episodeId) return;

    try {
      let data = null;
      let retries = 0;

      while (retries < 25) {
        try {
          data = await fetchMangaBoxManifest(episodeId);
          if (data && data.imageUrls?.length > 0) break;
        } catch (e) {}
        await sleep(150);
        retries++;
      }

      if (!data || !data.imageUrls?.length) {
        throw new Error("Không thể trích xuất danh sách trang từ máy chủ.");
      }
      state.chapterData = data;

      // 🎯 ZERO-TRUST MAGIC BYTES CHECK:
      // Tải và giải mã thử trang 1, dùng MangaUtils.detectExt soi Magic Bytes thực tế
      const firstPageUrl = data.imageUrls[0];
      if (!firstPageUrl) throw new Error("URL trang 1 không hợp lệ.");

      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const testRawBuf = await Utils.fetchBuffer(firstPageUrl, { "Referer": "https://www.mangabox.me/" });
      const testDecrypted = decryptMangaBox(testRawBuf, data.mask);

      // Nhận diện định dạng bằng hàm lõi detectExt (không đọc từ đuôi URL)
      const realExt = Utils.detectExt(testDecrypted.buffer);
      if (!realExt) throw new Error("Không thể nhận diện Magic Bytes ảnh.");

      if (ui) {
        await sleep(80); // Micro-delay chuẩn Golden Rule 5
        ui.updateProgress({
          completed: 0,
          total: data.imageUrls.length,
          status: "Sẵn sàng.",
          format: realExt // Khóa cứng nhãn UI "Ảnh gốc là EXT" theo chuẩn Zero-Copy
        });
        ui.setBusy(false);
      }
    } catch (err) {
      console.error("[mangabox-dl] Boot error:", err);
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