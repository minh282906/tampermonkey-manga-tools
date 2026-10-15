// ==UserScript==
// @name         Drecomi+ Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://drecomi-plus.jp/favicon.ico
// @description  Tải manga trên Drecomi+ (drecomi-plus.jp).
// @author       anonymous & AI
// @match        https://drecomi-plus.jp/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      drecomi-plus.jp
// @connect      api.drecomi-plus.jp
// @connect      cdn.drecomi-plus.jp
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN ---
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/DrecomiDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/DrecomiDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function drecomiUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6 // 6 luồng tải TCP Socket
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
    lastTargetCode: ""
  };

  /* =========================================================================
   * 1. GIAO DIỆN UNIVERSAL UI HỢP THEME DRECOMI+ (CAM #EA7A24 - TRẮNG)
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "drecomi-dl",
        title: "Drecomi+",
        engine: "DRECOMI VIEWER",
        themeColor: "#EA7A24",     
        themeBg: "#ffffff",        
        titleColor: "#EA7A24",     
        btnBg: "#EA7A24",          
        btnColor: "#ffffff",       
        tabBg: "#EA7A24",         
        tabColor: "#ffffff",
        topOffset: "60px",
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
   * 2. BỘ HỖ TRỢ XỬ LÝ CHUỖI, URL & ROUTING
   * ========================================================================= */
  function isEpisodeUrl() {
    return /\/series\/[^\/]+\/(episodes|volumes)\/([^\/?#]+)/i.test(WIN.location.pathname);
  }

  function getReaderParams() {
    const match = WIN.location.pathname.match(/\/series\/([^\/]+)\/(episodes|volumes)\/([^\/?#]+)/i);
    if (!match) return null;

    const seriesCode = match[1];
    const type = match[2]; // "episodes" hoặc "volumes"
    const targetCode = match[3];
    const isTrial = WIN.location.pathname.includes('/trial') || WIN.location.search.includes('trial=true');

    return { seriesCode, type, targetCode, isTrial };
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

  function base64ToBytes(base64Str) {
    const cleanB64 = String(base64Str || '').trim();
    const binStr = WIN.atob(cleanB64);
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) {
      bytes[i] = binStr.charCodeAt(i);
    }
    return bytes;
  }

  /* =========================================================================
   * 3. BÓC TÁCH DỮ LIỆU TỪ DRECOMI+ SESSION API
   * ========================================================================= */
  async function fetchDrecomiSession(params) {
    const { type, targetCode, isTrial } = params;
    const apiUrl = `https://api.drecomi-plus.jp/api/v1/app/viewer/${type}/${targetCode}/${isTrial ? 'trial-' : ''}session`;

    let json = null;
    try {
      const res = await WIN.fetch(apiUrl, {
        method: "POST",
        credentials: "include",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json"
        }
      });
      if (res.ok) json = await res.json();
    } catch (e) {}

    // Fallback qua GM_xmlhttpRequest nếu bị chặn CORS
    if (!json) {
      json = await new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "POST",
          url: apiUrl,
          headers: {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Referer": WIN.location.href
          },
          responseType: "json",
          onload: res => (res.status >= 200 && res.status < 300 && res.response) ? resolve(res.response) : reject(new Error(`HTTP ${res.status}`)),
          onerror: () => reject(new Error("Lỗi kết nối API Drecomi+")),
          ontimeout: () => reject(new Error("Timeout kết nối API Drecomi+"))
        });
      });
    }

    if (!json?.pages || !json.session_key) {
      throw new Error("Dữ liệu phiên đọc trả về không hợp lệ hoặc chương bị khóa.");
    }

    // 1. Tên truyện từ API
    const seriesTitle = cleanString(json.series_name || "");
    const { seriesCode } = params;

    let subTitle = "";

    // 2. PHÂN NHÁNH BÓC TÁCH TÊN TẬP / TÊN CHAP THẬT (KHÔNG HARDCODE)
    if (type === 'episodes') {
      // Nhánh chương lẻ: json.episode_name luôn có sẵn ví dụ "第1話（2）"
      subTitle = cleanString(json.episode_name || "");
    } else {
      // Nhánh Tankobon (volumes):
      // Nấc 1: Khóa chính xác thẻ của tập hiện tại trong DOM qua targetCode (CD20001-001)
      try {
        const activeLink = DOC.querySelector(`[data-testid="volume-list-item"][href*="${targetCode}"]`)
                        || DOC.querySelector(`a[href*="${targetCode}"]`);
        if (activeLink) {
          const pEl = activeLink.querySelector('p.text-fg-neutral-primary') || activeLink.querySelector('p');
          if (pEl && pEl.textContent) {
            subTitle = cleanString(pEl.textContent); // Bắt trọn vẹn "第1巻", "上巻", "特装版"...
          }
        }
      } catch (e) {}

      // Nấc 2 (Dự phòng nếu DOM chưa kịp render): Gọi ngầm API danh sách volumes của series
      if (!subTitle && seriesCode) {
        try {
          const vRes = await WIN.fetch(`https://api.drecomi-plus.jp/api/v1/app/series/${seriesCode}/volumes`);
          if (vRes.ok) {
            const vJson = await vRes.json();
            const vList = vJson.volumes || vJson.data || vJson;
            if (Array.isArray(vList)) {
              const matched = vList.find(v => (v.volume_code === targetCode || v.code === targetCode || String(v.id) === targetCode));
              if (matched?.name) subTitle = cleanString(matched.name);
            }
          }
        } catch (e) {}
      }

      // Nấc 3 (Dự phòng cuối cùng qua json.volume_name nếu cả DOM và API volumes đều trượt)
      if (!subTitle) {
        let rawVol = cleanString(json.volume_name || "");
        if (seriesTitle && rawVol.startsWith(seriesTitle)) {
          rawVol = cleanString(rawVol.substring(seriesTitle.length));
        }
        subTitle = rawVol;
      }
    }

    // Gọt bỏ ký tự nối thừa nếu có ở đầu
    subTitle = subTitle.replace(/^[\s\-_:：\u3000・･]+/, '').trim();

    // 3. Ghép nối chuẩn: [Tên Truyện] - [Tên Tập/Chap Thật].zip
    const fullTitle = (seriesTitle && subTitle && !seriesTitle.includes(subTitle))
      ? `${seriesTitle} - ${subTitle}`
      : (seriesTitle || subTitle || `Drecomi_${targetCode}`);

    return {
      title: fullTitle,
      targetCode,
      sessionKeyBytes: base64ToBytes(json.session_key),
      pages: json.pages.map(p => ({
        pageNo: p.page_number,
        url: p.image_url,
        ivBytes: base64ToBytes(p.iv)
      }))
    };
  }

  /* =========================================================================
   * 4. GIẢI MÃ PHẦN CỨNG AES-256-CBC TRONG RAM (ZERO-COPY)
   * ========================================================================= */
  async function decryptDrecomiImage(pageItem, sessionKeyBytes) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;

    // 1. Tải mảng byte nhị phân thô từ CloudFront / S3
    const encryptedBuffer = await Utils.fetchBuffer(pageItem.url, { "Referer": "https://drecomi-plus.jp/" });

    // 2. Nạp khóa 256-bit vào Web Crypto API
    const cryptoKey = await WIN.crypto.subtle.importKey(
      "raw",
      sessionKeyBytes,
      { name: "AES-CBC" },
      false,
      ["decrypt"]
    );

    // 3. Giải mã khối phần cứng trong RAM
    const decryptedBuffer = await WIN.crypto.subtle.decrypt(
      { name: "AES-CBC", iv: pageItem.ivBytes },
      cryptoKey,
      encryptedBuffer
    );
    const decryptedBytes = new Uint8Array(decryptedBuffer);

    // 4. Nhận diện Magic Bytes thực tế (WebP gốc 1440x2048)
    const ext = Utils.detectExt(decryptedBuffer);

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

    const params = getReaderParams();
    if (!params) {
      if (ui) ui.updateProgress({ status: "Lỗi: Không tìm thấy tham số chương." });
      return;
    }

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let data = state.chapterData;
      if (!data || !data.pages?.length) {
        data = await fetchDrecomiSession(params);
        state.chapterData = data;
      }

      const { pages, sessionKeyBytes, title, targetCode } = data;
      const totalPages = pages.length;
      if (!totalPages) throw new Error("Không có trang hợp lệ để tải.");

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file định danh ID chương theo Golden Rule 2
      zip.addFile(`${targetCode}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      // 6 luồng tải song song Zero-Copy trong RAM
      const tasks = pages.map(pageItem => () => decryptDrecomiImage(pageItem, sessionKeyBytes));
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
      console.error("[drecomi-dl] Download error:", err);
    } finally {
      state.running = false;
    }
  }

  /* =========================================================================
   * 6. KHỞI CHẠY & THEO DÕI ROUTE NEXT.JS SPA
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
      const params = getReaderParams();
      if (!params) throw new Error("Không lấy được mã chương.");

      let data = null;
      let retries = 0;

      while (retries < 25) {
        try {
          data = await fetchDrecomiSession(params);
          if (data && data.pages?.length > 0) break;
        } catch (e) {}
        await sleep(150);
        retries++;
      }

      if (!data || !data.pages || !data.pages.length) {
        throw new Error("Không lấy được danh sách trang (truyện trả phí hoặc chưa đăng nhập).");
      }
      state.chapterData = data;

      // SOI MAGIC BYTES THỰC TẾ TRANG 1 (GIẢI MÃ AES-256-CBC TRONG RAM)
      const firstPage = data.pages[0]; // bên này dùng data.pages[0].url
      if (!firstPage?.url) throw new Error("URL trang 1 không hợp lệ.");

      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const encBuf = await Utils.fetchBuffer(firstPage.url, { "Referer": "https://drecomi-plus.jp/" });
      const cryptoKey = await WIN.crypto.subtle.importKey(
        "raw",
        data.sessionKeyBytes,
        { name: "AES-CBC" },
        false,
        ["decrypt"]
      );
      const decBuf = await WIN.crypto.subtle.decrypt(
        { name: "AES-CBC", iv: firstPage.ivBytes },
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
      console.error("[drecomi-dl] Boot error:", err);
      if (ui) {
        ui.updateProgress({ status: "Lỗi: " + (err?.message || "không thể tải trang.") });
        ui.setBusy(true);
      }
    }
  }

  // Hook SPA Navigation
  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute((newUrl) => {
      if (!isEpisodeUrl()) {
        const ui = getUI();
        if (ui?.panel) ui.panel.style.display = "none";
        state.chapterData = null;
        state.lastTargetCode = "";
        state.lastUrl = "";
        state.running = false;
        return;
      }

      const params = getReaderParams();
      const currentCode = params?.targetCode || WIN.location.pathname;
      if (state.lastTargetCode && state.lastTargetCode === currentCode) return;

      state.lastUrl = newUrl;
      state.lastTargetCode = currentCode;
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