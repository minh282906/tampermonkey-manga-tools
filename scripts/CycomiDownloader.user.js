// ==UserScript==
// @name         Cycomi Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://cycomi.com/favicon.ico
// @description  Tải manga trên Cycomi.
// @author       anonymous & AI
// @match        https://cycomi.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      cycomi.com
// @connect      web.cycomi.com
// @connect      contents.cycomi.com
// @connect      assets-web-prd.akamaized.net
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function cycomiUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6 // 6 luồng TCP Socket
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
   * 1. GIAO DIỆN UNIVERSAL UI CHUẨN THEME CYCOMI (CAM ĐẬM #F97303 - TRẮNG)
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "cycomi-dl",
        title: "Cycomi",
        engine: "CYGAMES",
        themeColor: "#F97303",      // Cam thương hiệu Cycomi
        themeBg: "#ffffff",         // Nền bảng trắng sáng
        titleColor: "#F97303",      // Tiêu đề cam
        btnBg: "#F97303",           // Nút tải cam
        btnColor: "#ffffff",        // Chữ nút trắng
        tabBg: "#F97303",
        tabColor: "#ffffff",
        topOffset: "40px",
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
    return /\/viewer\/chapter\/\d+/i.test(WIN.location.pathname);
  }

  function getChapterId() {
    const match = WIN.location.pathname.match(/\/viewer\/chapter\/(\d+)/i);
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

  // Dual-Flight API Caller: fetch tab trước -> GM_xmlhttpRequest dự phòng
  async function fetchJsonApi(url, method = "GET", bodyData = null) {
    try {
      const opts = {
        method,
        credentials: "include",
        headers: { "Accept": "application/json" }
      };
      if (bodyData) {
        opts.headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(bodyData);
      }
      const res = await WIN.fetch(url, opts);
      if (res.ok) return await res.json();
    } catch (e) {}

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        data: bodyData ? JSON.stringify(bodyData) : undefined,
        headers: {
          "Accept": "application/json",
          "Content-Type": bodyData ? "application/json" : undefined,
          "Referer": "https://cycomi.com/"
        },
        responseType: "json",
        onload: res => (res.status >= 200 && res.status < 300 && res.response) ? resolve(res.response) : reject(new Error(`HTTP ${res.status}`)),
        onerror: () => reject(new Error("Lỗi kết nối API Cycomi")),
        ontimeout: () => reject(new Error("Timeout kết nối API Cycomi"))
      });
    });
  }

  // Bóc tách Context: titleId, titleName, chapterName
  async function resolveCycomiContext(chapterId) {
    let chapterDetail = null;

    // 1. Quét nhanh từ __NEXT_DATA__ (0ms)
    try {
      const fallback = WIN.__NEXT_DATA__?.props?.pageProps?.fallback;
      if (fallback) {
        for (const key of Object.keys(fallback)) {
          if (key.includes('/api/chapter/detail') && fallback[key]?.data) {
            const d = fallback[key].data;
            if (String(d.id) === String(chapterId)) {
              chapterDetail = d;
              break;
            }
          }
        }
      }
    } catch (e) {}

    // 2. Dự phòng: Gọi API backend
    if (!chapterDetail) {
      try {
        const json = await fetchJsonApi(`https://web.cycomi.com/api/chapter/detail?chapterId=${chapterId}`);
        if (json?.resultCode === 1 && json.data) {
          chapterDetail = json.data;
        }
      } catch (e) {}
    }

    if (!chapterDetail) return null;

    const titleId = chapterDetail.titleId;
    const seriesTitle = cleanString(chapterDetail.titleName || "");
    const mainName = cleanString(chapterDetail.name || "");
    const subName = cleanString(chapterDetail.subName || "");

    const chapterFull = (mainName && subName) ? `${mainName} ${subName}` : (mainName || subName);
    const fullTitle = (seriesTitle && chapterFull) ? `${seriesTitle} - ${chapterFull}` : (seriesTitle || chapterFull || `Cycomi_${chapterId}`);

    return {
      chapterId: String(chapterId),
      titleId: String(titleId),
      title: fullTitle
    };
  }

  /* =========================================================================
   * 3. MẬT MÃ HỌC CYCOMI: RC4 STREAM CIPHER (0MS TRONG RAM)
   * ========================================================================= */
  function decryptCycomiRc4(encryptedBuffer, keyStr) {
    const raw = encryptedBuffer instanceof Uint8Array ? encryptedBuffer : new Uint8Array(encryptedBuffer);
    const s = new Uint8Array(256);
    for (let i = 0; i < 256; i++) s[i] = i;

    // KSA (Key Scheduling Algorithm)
    let j = 0;
    const keyLen = keyStr.length;
    for (let i = 0; i < 256; i++) {
      j = (j + s[i] + keyStr.charCodeAt(i % keyLen)) & 255;
      const temp = s[i]; s[i] = s[j]; s[j] = temp;
    }

    // PRGA (Pseudo-Random Generation Algorithm) + Bitwise XOR Keystream
    const decrypted = new Uint8Array(raw.length);
    let i = 0, k = 0;
    for (let idx = 0; idx < raw.length; idx++) {
      i = (i + 1) & 255;
      k = (k + s[i]) & 255;
      const temp = s[i]; s[i] = s[k]; s[k] = temp;
      const keyByte = s[(s[i] + s[k]) & 255];
      decrypted[idx] = raw[idx] ^ keyByte;
    }

    return decrypted; // Trả về Magic Bytes gốc: 0xFF 0xD8 (JPEG) hoặc RIFF (WebP)
  }

  /* =========================================================================
   * 4. BÓC TÁCH MANIFEST TỪ API PAGE LIST
   * ========================================================================= */
  async function fetchCycomiManifest(titleId, chapterId) {
    const json = await fetchJsonApi("https://web.cycomi.com/api/chapter/page/list", "POST", {
      titleId: Number(titleId),
      chapterId: Number(chapterId)
    });

    if (json?.resultCode !== 1 || !json.data?.pages) {
      throw new Error("Không thể bóc tách danh sách ảnh từ máy chủ Cycomi.");
    }

    const pages = [];
    const hashRegex = /\/(?<hash>[0-9a-zA-Z]{32})\//;

    for (const item of json.data.pages) {
      if (!item.image || typeof item.image !== 'string') continue;

      // Lọc bỏ banner quảng cáo cuối chương, chỉ lấy trang có hash 32 ký tự hợp lệ
      const match = item.image.match(hashRegex);
      if (match && match.groups?.hash) {
        pages.push({
          pageNo: pages.length + 1,
          url: item.image,
          key: match.groups.hash
        });
      }
    }

    if (pages.length === 0) {
      throw new Error("Không tìm thấy trang truyện hợp lệ trong gói tin.");
    }

    return pages;
  }

  async function decryptAndFormatImage(pageItem) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;

    // 1. Tải mảng byte nhị phân qua GM_xmlhttpRequest
    const encryptedBuffer = await Utils.fetchBuffer(pageItem.url, { "Referer": "https://cycomi.com/" });

    // 2. Giải mã RC4 trực tiếp trong RAM (0ms)
    const decryptedBytes = decryptCycomiRc4(encryptedBuffer, pageItem.key);

    // 3. Nhận diện Magic Bytes chuẩn xác
    const ext = Utils.detectExt(decryptedBytes.buffer);

    return {
      fileName: `${pageItem.pageNo}.${ext}`,
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
        const ctx = await resolveCycomiContext(chapterId);
        if (!ctx) throw new Error("Không lấy được thông tin tác phẩm.");

        const pages = await fetchCycomiManifest(ctx.titleId, ctx.chapterId);
        data = { pages, title: ctx.title, chapterId: ctx.chapterId };
        state.chapterData = data;
      }

      const { pages, title } = data;
      const totalPages = pages.length;
      if (!totalPages) throw new Error("Không có trang hợp lệ để tải.");

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
      const finalFileName = `${cleanString(title)}.zip`;
      zip.download(finalFileName);

      if (ui) {
        ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
        ui.setBusy(false);
      }
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[cycomi-dl] Download error:", err);
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
      let ctx = null;
      let retries = 0;

      // Chờ đợi nạp context metadata
      while (retries < 25) {
        ctx = await resolveCycomiContext(chapterId);
        if (ctx && ctx.titleId) break;
        await sleep(150);
        retries++;
      }

      if (!ctx || !ctx.titleId) throw new Error("Không tìm thấy thông tin chương truyện.");

      const pages = await fetchCycomiManifest(ctx.titleId, ctx.chapterId);
      if (!pages || !pages.length) {
        throw new Error("Không lấy được danh sách trang.");
      }
      state.chapterData = { pages, title: ctx.title, chapterId: ctx.chapterId };

      // SOI MAGIC BYTES TRỰC TIẾP TRANG 1 SAU KHI GIẢI MÃ RC4 (ZERO-TRUST)
      const firstPage = pages[0]; // bên này dùng pages[0].url
      if (!firstPage?.url) throw new Error("URL trang 1 không hợp lệ.");

      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const encBuf = await Utils.fetchBuffer(firstPage.url, { "Referer": "https://cycomi.com/" });
      const decBytes = decryptCycomiRc4(encBuf, firstPage.key);
      const realExt = Utils.detectExt(decBytes.buffer);

      if (!realExt) throw new Error("Không thể nhận diện Magic Bytes ảnh.");

      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: pages.length,
          status: "Sẵn sàng.",
          format: realExt
        });
        ui.setBusy(false);
      }
    } catch (err) {
      console.error("[cycomi-dl] Boot error:", err);
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