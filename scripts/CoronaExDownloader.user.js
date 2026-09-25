// ==UserScript==
// @name         Corona EX Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://to-corona-ex.com/favicon.ico
// @description  Tải manga trên nền tảng Corona EX (to-corona-ex.com).
// @author       anonymous & AI
// @match        https://to-corona-ex.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      to-corona-ex.com
// @connect      api.to-corona-ex.com
// @connect      cdn.to-corona-ex.com
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/CoronaExDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/CoronaExDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function coronaExUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH & KHỞI TẠO
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6,   // 6 luồng TCP Socket
    JPEG_QUALITY: 1.0    // Chất lượng xuất JPG nếu người dùng chọn
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("corona-dl:convert-jpeg") === '1',
    chapterData: null,
    ui: null,
    lastEpId: null
  };

  // Biến lưu trữ dữ liệu bắt được từ Hook mạng
  let capturedData = null;
  let capturedEpId = null;

  /* =========================================================================
   * 1. SINGLE-FLIGHT HOOK ĐÓN GÓI TIN /begin_reading (0ms & CHỐNG LỆCH NHỊP SPA)
   * ========================================================================= */
  const origFetch = WIN.fetch;
  if (typeof origFetch === 'function') {
    WIN.fetch = async function (...args) {
      const res = await origFetch.apply(this, args);
      try {
        const u = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        if (u.includes('/begin_reading')) {
          res.clone().json().then(data => {
            if (data) {
              capturedData = data;
              const epMatch = u.match(/\/episodes\/([a-zA-Z0-9_-]+)/);
              if (epMatch) capturedEpId = epMatch[1];
              syncChapterData();
            }
          }).catch(() => {});
        }
      } catch (e) {}
      return res;
    };
  }

  /* =========================================================================
   * 2. GIAO DIỆN UNIVERSAL UI 2 TẦNG
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "corona-dl",
        title: "CORONA EX",
        engine: "TO BOOKS",
        themeColor: "#F5A319",       
        themeBg: "#18181b",          
        titleColor: "#ffffff",
        btnBg: "#F5A319",
        btnColor: "#ffffff",
        topOffset: "54px",          
        defaultJpgText: "Xuất file JPG (mặc định PNG)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("corona-dl:convert-jpeg", checked ? '1' : '0');
        }
      };

      state.ui = createUI(uiConfig);

      // Tùy biến Header 2 tầng (Dòng 1: CORONA EX, Dòng 2: TO BOOKS)
      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:${uiConfig.titleColor};letter-spacing:0.2px;">${uiConfig.title}</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px;visibility:hidden;">${uiConfig.engine}</div>
          `;
        }
      }
    }
    return state.ui;
  }

  /* =========================================================================
   * 3. BỘ HỖ TRỢ XỬ LÝ CHUỖI & TÊN FILE CHUẨN
   * ========================================================================= */
  function isEpisodeUrl() {
    return /\/episodes\/[a-zA-Z0-9_-]+/.test(WIN.location.pathname);
  }

  function getEpisodeId() {
    const match = WIN.location.pathname.match(/\/episodes\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : (capturedEpId || "CoronaEx_Episode");
  }

  function cleanString(str) {
    if (!str) return "";
    return str
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/【(?:無料|期間限定|試し読み|デジタル版|電子版|公式)[^】]*】/gi, '')
      .replace(/[\\/*?:"<>|]/g, '')
      .trim();
  }

  // BẮT BUỘC CHUẨN: [Tên Truyện] - [Tên Tập/Chap].zip
  function getCleanTitle(comicTitle, episodeTitle) {
    try {
      let cleanSeries = cleanString(comicTitle);
      let cleanEpisode = cleanString(episodeTitle);

      cleanSeries = cleanSeries.replace(/（[^）]*(?:コミック|文庫|レーベル|出版|COMIC|WEB)[^）]*）$/i, '').trim();
      cleanSeries = cleanSeries.replace(/\([^)]*(?:コミック|文庫|レーベル|出版|COMIC|WEB)[^)]*\)$/i, '').trim();

      let baseWithoutVol = cleanSeries.replace(/\s*[0-9０-９]+\s*巻.*$/i, '').trim();
      if (baseWithoutVol && cleanEpisode.startsWith(baseWithoutVol)) {
        cleanEpisode = cleanString(cleanEpisode.substring(baseWithoutVol.length));
      }

      cleanEpisode = cleanEpisode.replace(/^[・･\s\-_:：\u3000]+/, '').trim();

      if (cleanSeries && cleanEpisode) {
        return `${cleanSeries} - ${cleanEpisode}`;
      } else if (cleanEpisode) {
        return cleanEpisode;
      } else if (cleanSeries) {
        return `${cleanSeries} - ${getEpisodeId()}`;
      }
    } catch (e) {}

    return `CoronaEx_${getEpisodeId()}`;
  }

  /* =========================================================================
   * 4. BÓC TÁCH DỮ LIỆU TỪ SSR __NEXT_DATA__ HOẶC API (NHẬN BIẾT CHAP KHÓA 0ms)
   * ========================================================================= */
  function extractNextData() {
    try {
      const el = DOC.getElementById('__NEXT_DATA__');
      if (el && el.textContent) {
        const json = JSON.parse(el.textContent);
        const pp = json.props?.pageProps;
        return pp?.metaInfo || pp?.episode || (pp?.pages ? pp : null);
      }
    } catch (e) {}
    return null;
  }

  async function fetchChapterData() {
    const curEpId = getEpisodeId();

    // 1. Tận dụng dữ liệu từ Hook mạng nếu trùng khớp ID chương hiện tại
    if (capturedData && String(capturedEpId) === String(curEpId)) {
      const hasPages = Array.isArray(capturedData.pages) && capturedData.pages.length > 0;
      return {
        comicTitle: capturedData.comic_title || "",
        episodeTitle: capturedData.episode_title || "",
        episodeId: curEpId,
        pages: hasPages ? capturedData.pages : [],
        isLocked: !hasPages
      };
    }

    // 2. Tận dụng dữ liệu render sẵn từ Next.js SSR (0ms)
    const ssrData = extractNextData();
    const ssrEpId = String(ssrData?.episode_id || ssrData?.episodeId || "");
    if (ssrData && ssrEpId === String(curEpId)) {
      const hasPages = Array.isArray(ssrData.pages) && ssrData.pages.length > 0;
      // Nhận diện chap khóa ngay trong RAM, không retry vô nghĩa
      return {
        comicTitle: ssrData.comic_title || "",
        episodeTitle: ssrData.episode_title || "",
        episodeId: curEpId,
        pages: hasPages ? ssrData.pages : [],
        isLocked: !hasPages
      };
    }

    // 3. Dự phòng gọi API trực tiếp
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    const apiUrl = `https://api.to-corona-ex.com/episodes/${curEpId}/begin_reading`;
    const headers = {
      "Accept": "application/json, text/plain, */*",
      "Referer": WIN.location.href,
      "x-api-environment-key": "K4FWy7Iqott9mrw37hDKfZ2gcLOwO-kiLHTwXT8ad1E="
    };

    try {
      const buf = await Utils.fetchBuffer(apiUrl, headers);
      const json = JSON.parse(new TextDecoder().decode(buf));
      const hasPages = Array.isArray(json?.pages) && json.pages.length > 0;

      return {
        comicTitle: json?.comic_title || "",
        episodeTitle: json?.episode_title || "",
        episodeId: curEpId,
        pages: hasPages ? json.pages : [],
        isLocked: !hasPages
      };
    } catch (err) {
      // Chap trả phí chưa mua (HTTP 401, 402, 403, 404): Nhận diện bị khóa ngay lập tức!
      return {
        comicTitle: "",
        episodeTitle: "",
        episodeId: curEpId,
        pages: [],
        isLocked: true
      };
    }
  }

  async function syncChapterData() {
    if (!isEpisodeUrl()) return;
    const curEpId = getEpisodeId();

    try {
      const data = await fetchChapterData();
      if (data) {
        state.chapterData = data;
        state.lastEpId = curEpId;

        const ui = getUI();
        if (ui && !state.running) {
          await sleep(80); // Micro-delay
          ui.updateProgress({
            completed: 0,
            total: data.pages?.length || 0,
            status: "Sẵn sàng."
          });
        }
      }
    } catch (e) {}
  }

  /* =========================================================================
   * 5. GIẢI MÃ MA TRẬN CORONA EX
   * ========================================================================= */
  async function descrambleCoronaExImage(rawBuffer, drmHash, pageNo, isJpg) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    const img = await Utils.loadImage(rawBuffer);

    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;

    // Phân tích drm_hash Base64
    let cols = 4, rows = 4, mapping = null;
    if (drmHash && typeof drmHash === 'string') {
      try {
        const bin = atob(drmHash.trim());
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        if (bytes.length >= 2) {
          cols = bytes[0];
          rows = bytes[1];
          if (bytes.length >= 2 + cols * rows) {
            mapping = bytes.subarray(2, 2 + cols * rows);
          }
        }
      } catch (e) {}
    }

    // Bội số 8px chuẩn xác của NXB
    const cellW = Math.floor((w - (w % 8)) / cols);
    const cellH = Math.floor((h - (h % 8)) / rows);

    const canvas = DOC.createElement('canvas');
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = false;
    ctx.mozImageSmoothingEnabled = false;
    ctx.webkitImageSmoothingEnabled = false;
    ctx.msImageSmoothingEnabled = false;

    // BƯỚC 1: Vẽ lót nền ảnh gốc 1:1 bảo tồn trọn vẹn 100% dải viền ngoài (Golden Rule 4)
    ctx.drawImage(img, 0, 0, w, h);

    // BƯỚC 2: Dán đè các ô hoán vị ở vùng trung tâm
    if (mapping) {
      for (let j = 0; j < cols * rows; j++) {
        const srcIdx = mapping[j];
        const srcCol = srcIdx % cols;
        const srcRow = Math.floor(srcIdx / cols);

        const destCol = j % cols;
        const destRow = Math.floor(j / cols);

        ctx.drawImage(
          img,
          srcCol * cellW, srcRow * cellH, cellW, cellH,
          destCol * cellW, destRow * cellH, cellW, cellH
        );
      }
    }

    const mimeType = isJpg ? 'image/jpeg' : 'image/png';
    const outExt = isJpg ? 'jpg' : 'png';
    const blob = await new Promise(r => canvas.toBlob(r, mimeType, CONFIG.JPEG_QUALITY));

    canvas.width = 0;
    canvas.height = 0;

    return {
      fileName: `${pageNo}.${outExt}`,
      data: new Uint8Array(await blob.arrayBuffer())
    };
  }

  /* =========================================================================
   * 6. TIẾN TRÌNH TẢI CHÍNH (6 LUỒNG SONG SONG TRONG RAM)
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
        data = await fetchChapterData();
        state.chapterData = data;
      }

      if (data?.isLocked || !data?.pages?.length) {
        throw new Error("Chương truyện này chưa mở khóa.");
      }

      const { pages, comicTitle, episodeTitle, episodeId } = data;
      const totalPages = pages.length;

      const useJpeg = Boolean(state.convertJpeg);
      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file txt định danh tập truyện
      zip.addFile(`${episodeId}.txt`, new Uint8Array(0));

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map((pageObj, idx) => async () => {
        const rawBuffer = await Utils.fetchBuffer(pageObj.page_image_url);
        return await descrambleCoronaExImage(rawBuffer, pageObj.drm_hash, idx + 1, useJpeg);
      });

      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res?.data) zip.addFile(res.fileName, res.data);
      }

      const zipName = `${getCleanTitle(comicTitle, episodeTitle)}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[corona-dl] Error:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * 7. KHỞI CHẠY VÀ THEO DÕI SPA ROUTE
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(30);
    const ui = getUI();

    if (!isEpisodeUrl()) {
      if (ui?.panel) ui.panel.style.display = "none";
      return;
    }

    if (ui?.panel) ui.panel.style.display = "block";
    if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });

    const curEpId = getEpisodeId();
    let retries = 0;

    while (retries < 20) {
      try {
        if (curEpId && curEpId === state.lastEpId && retries < 10) {
          await sleep(150);
          retries++;
          continue;
        }

        const data = await fetchChapterData();
        if (data) {
          state.chapterData = data;
          state.lastEpId = curEpId;

          // NẾU LÀ CHAP BỊ KHÓA: Dừng ngay lập tức, không đợi 20 vòng!
          if (data.isLocked || !data.pages?.length) break;

          // Nếu có trang: Lấy thành công và dừng
          if (data.pages.length > 0) break;
        }
      } catch (e) {}
      await sleep(150);
      retries++;
    }

    await sleep(80);

    const totalPages = state.chapterData?.pages?.length || 0;
    if (ui) {
      ui.updateProgress({
        completed: 0,
        total: totalPages,
        status: "Sẵn sàng."
      });
    }
  }

  // Khởi động SPA Route Watcher
  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute(() => {
      state.chapterData = null;
      state.running = false;
      const ui = getUI();
      if (ui) {
        ui.setBusy(false);
        ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
      }
      boot();
    });
  }

  if (DOC.readyState === "loading") {
    DOC.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();