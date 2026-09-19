// ==UserScript==
// @name         YanJan! (YNJN) Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://www.google.com/s2/favicons?domain=ynjn.jp&sz=128
// @description  Tải manga trên nền tảng YanJan!.
// @author       anonymous & AI
// @match        https://ynjn.jp/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      ynjn.jp
// @connect      *.ynjn.jp
// @connect      public.ynjn.jp
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/YanJanDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/YanJanDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function ynjnUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH & KHỞI TẠO
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6,   // 6 luồng tải song song qua API
    JPEG_QUALITY: 0.95   // Chất lượng xuất JPG nếu chọn
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("ynjn-dl:convert-jpeg") === '1',
    chapterData: null,
    ui: null,
    lastEpId: null
  };

  // BẮT TRỰC TIẾP REQUEST VIEWER CỦA WEB (KỂ CẢ KHI ĐANG Ở /title/:id)
  let capturedViewerData = null;
  let capturedEpisodeId = null;

  function handleViewerResponse(url, json) {
    if (json?.data?.pages && Array.isArray(json.data.pages)) {
      capturedViewerData = json.data;
      const u = new URL(url, WIN.location.href);
      const ep = u.searchParams.get('episodeId') || u.searchParams.get('episode_id');
      if (ep) capturedEpisodeId = ep;
    }
  }

  const origFetch = WIN.fetch;
  if (typeof origFetch === 'function') {
    WIN.fetch = async function(...args) {
      const res = await origFetch.apply(this, args);
      try {
        const u = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        if (u.includes('webapi.ynjn.jp/viewer')) {
          res.clone().json().then(json => handleViewerResponse(u, json)).catch(() => {});
        }
      } catch (e) {}
      return res;
    };
  }

  /* =========================================================================
   * GIAO DIỆN UNIVERSAL UI 2 TẦNG
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "ynjn-dl",
        title: "YanJan!",
        engine: "SHUEISHA",
        themeColor: "#1d5ec9",      // Đổi thành Xanh Royal Blue YanJan+
        themeBg: "#18181b",         
        titleColor: "#ffffff",      
        btnBg: "#1d5ec9",           // Thêm dòng này để nút tải cùng màu xanh
        btnColor: "#ffffff",
        topOffset: "120px",
        defaultJpgText: "Xuất file JPG (mặc định PNG)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("ynjn-dl:convert-jpeg", checked ? '1' : '0');
        }
      };

      state.ui = createUI(uiConfig);

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
   * BỘ HỖ TRỢ XỬ LÝ CHUỖI & TÊN FILE
   * ========================================================================= */
  
  function isEpisodeUrl() {
    const path = WIN.location.pathname;
    return /\/viewer\/\d+\/\d+/.test(path) || /\/title\/\d+/.test(path);
  }

  function cleanString(str) {
    if (!str) return "";
    return str
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/【(?:無料|期間限定|試し読み|デジタル版|電子版|公式)[^】]*】/gi, '') // CHỈ XÓA TAG RÁC, GIỮ NGUYÊN FURIGANA
      .replace(/[\\/*?:"<>|]/g, '')
      .trim();
  }

  function getUrlParams() {
    const path = WIN.location.pathname;
    let titleId = "";
    let episodeId = "";

    // 1. Nếu URL là dạng chuẩn /viewer/:titleId/:episodeId
    const vMatch = path.match(/\/viewer\/(\d+)\/(\d+)/);
    if (vMatch) {
      titleId = vMatch[1];
      episodeId = vMatch[2];
    }

    // 2. Nếu URL là dạng trang tiêu đề /title/:titleId
    if (!titleId) {
      const tMatch = path.match(/\/title\/(\d+)/);
      if (tMatch) titleId = tMatch[1];
    }

    // 3. Nếu chưa có episodeId (đang ở trang /title/):
    if (!episodeId) {
      // Ưu tiên A: Lấy từ Hook mạng vừa bắt được
      if (capturedEpisodeId) {
        episodeId = capturedEpisodeId;
      }
      
      if (!episodeId && typeof WIN.performance?.getEntriesByType === 'function') {
        const entries = WIN.performance.getEntriesByType('resource');
        const vEntry = entries.find(r => r.name && r.name.includes('webapi.ynjn.jp/viewer'));
        if (vEntry) {
          try {
            const u = new URL(vEntry.name);
            episodeId = u.searchParams.get('episodeId') || u.searchParams.get('episode_id') || "";
            if (!titleId) titleId = u.searchParams.get('titleId') || u.searchParams.get('title_id') || "";
          } catch (e) {}
        }
      }

      if (!episodeId) {
        const firstEpLink = DOC.querySelector('a[href*="/viewer/"]');
        if (firstEpLink) {
          const m = firstEpLink.getAttribute('href').match(/\/viewer\/\d+\/(\d+)/);
          if (m) episodeId = m[1];
        }
      }
    }

    return { titleId, episodeId };
  }

  // BẮT BUỘC: [Tên Truyện] - [Tên Tập/Chap].zip
  function getCleanTitle(manifestChapterName) {
    try {
      let seriesTitle = "";
      let episodeTitle = cleanString(manifestChapterName);

      // 1. Quét tên truyện dưới ảnh bìa
      const domSeriesEl = DOC.querySelector('h2, [class*="SeriesTitle"], [class*="title_name"], h1');
      if (domSeriesEl) {
        const txt = cleanString(domSeriesEl.textContent);
        if (txt && !txt.includes('第') && !txt.includes('話')) seriesTitle = txt;
      }

      // 2. Quét tiêu đề đầy đủ từ header hoặc document.title
      let fullHeaderTitle = DOC.querySelector('[class*="ViewerHeader"], [class*="episode_title"], h1, h2')?.textContent || DOC.title || "";
      fullHeaderTitle = cleanString(fullHeaderTitle.split(/[|｜]/)[0].replace(/[-－–—\s]*ヤンジャン.*$/i, ''));

      // 3. Phân tách: match[1] = Tên truyện, match[2] = Tên chap + Phụ đề
      if (fullHeaderTitle) {
        const match = fullHeaderTitle.match(/^(.*?)(?:\s+[-－–—]\s+|\s+)((?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\s\-\–\—\ー\~〜\.]+(?:話|巻|章|節|部|エピソード)?.*)$/i);
        if (match) {
          if (!seriesTitle) seriesTitle = cleanString(match[1]);
          episodeTitle = cleanString(match[2]);
        }
      }

      // 4. Cắt bỏ tên truyện nếu bị lặp ở đầu tên chap
      if (seriesTitle && episodeTitle) {
        if (episodeTitle.startsWith(seriesTitle)) {
          episodeTitle = cleanString(episodeTitle.substring(seriesTitle.length));
        }
        episodeTitle = episodeTitle.replace(/^[・･\s-]+/, '').trim();
        return `${seriesTitle} - ${episodeTitle}`;
      } else if (episodeTitle) {
        return episodeTitle;
      }
    } catch (e) {}

    const { episodeId } = getUrlParams();
    return `YanJan_${episodeId || Date.now()}`;
  }

  /* =========================================================================
   * BÓC TÁCH DANH SÁCH TRANG TỪ API YANJAN!
   * ========================================================================= */
  async function fetchYnjnPages() {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    const { titleId, episodeId } = getUrlParams();
    if (!titleId) throw new Error("Không tìm thấy ID truyện YNJN.");

    let data = null;

    // 1. Tận dụng gói tin Hook mạng nếu có sẵn (0ms)
    if (capturedViewerData && (!episodeId || String(capturedEpisodeId) === String(episodeId))) {
      data = capturedViewerData;
    }

    // 2. Nếu chưa có, gửi request API
    if (!data) {
      if (!episodeId) throw new Error("Chưa xác định được Episode ID (Vui lòng đợi web nạp tập 1).");
      const apiUrl = `https://webapi.ynjn.jp/viewer?title_id=${titleId}&episode_id=${episodeId}&viewerOnly=0`;
      const headers = {
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://ynjn.jp",
        "Referer": "https://ynjn.jp/"
      };

      const rawBuffer = await Utils.fetchBuffer(apiUrl, headers);
      const json = JSON.parse(new TextDecoder().decode(rawBuffer));
      data = json?.data;
    }

    if (!data || !Array.isArray(data.pages)) throw new Error("API YNJN không trả về dữ liệu trang.");

    const pages = [];
    for (let i = 0; i < data.pages.length; i++) {
      const item = data.pages[i];
      const p = item.manga_page;
      if (!p || !p.page_image_url) continue;

      pages.push({
        pageNo: pages.length + 1,
        url: p.page_image_url,
        width: Number(p.image_horizontal_size || 0),
        height: Number(p.image_vertical_size || 0)
      });
    }

    return {
      chapterName: data.viewer_navigation?.name || "第1話",
      episodeId: episodeId || "ep1",
      pages
    };
  }

  /* =========================================================================
   * GIẢI MÃ MA TRẬN CHUYỂN VỊ 4x4 (MATRIX TRANSPOSE)
   * ========================================================================= */
  async function descrambleYnjnImage(rawBuffer, pageObj, isJpg) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    const img = await Utils.loadImage(rawBuffer);

    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;

    const targetW = pageObj.width || w;
    const targetH = pageObj.height || h;

    const canvas = DOC.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = false;
    ctx.mozImageSmoothingEnabled = false;
    ctx.webkitImageSmoothingEnabled = false;
    ctx.msImageSmoothingEnabled = false;

    const pieceW = Math.floor(w / 4);
    const pieceH = Math.floor(h / 4);

    // 16 ô hoán vị lật đường chéo chính (Matrix Transpose)
    for (let i = 0; i < 16; i++) {
      const srcCol = i % 4;
      const srcRow = Math.floor(i / 4);
      const srcX = srcCol * pieceW;
      const srcY = srcRow * pieceH;

      const j = srcCol * 4 + srcRow;
      const destCol = j % 4;
      const destRow = Math.floor(j / 4);
      const destX = destCol * pieceW;
      const destY = destRow * pieceH;

      ctx.drawImage(img, srcX, srcY, pieceW, pieceH, destX, destY, pieceW, pieceH);
    }

    // Bảo vệ mép viền nếu có phần dư (dưới 4px)
    const remainderW = w - pieceW * 4;
    const remainderH = h - pieceH * 4;
    if (remainderW > 0) {
      ctx.drawImage(img, pieceW * 4, 0, remainderW, h, pieceW * 4, 0, remainderW, h);
    }
    if (remainderH > 0) {
      ctx.drawImage(img, 0, pieceH * 4, w, remainderH, 0, pieceH * 4, w, remainderH);
    }

    const mimeType = isJpg ? 'image/jpeg' : 'image/png';
    const outExt = isJpg ? 'jpg' : 'png';
    const blob = await new Promise(r => canvas.toBlob(r, mimeType, CONFIG.JPEG_QUALITY));

    canvas.width = 0;
    canvas.height = 0;

    return {
      fileName: `${pageObj.pageNo}.${outExt}`,
      data: new Uint8Array(await blob.arrayBuffer())
    };
  }

  /* =========================================================================
   * TIẾN TRÌNH TẢI CHÍNH (6 LUỒNG TRONG RAM)
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let data = state.chapterData;
      if (!data) {
        data = await fetchYnjnPages();
        state.chapterData = data;
      }

      const { pages, chapterName, episodeId } = data;
      const totalPages = pages.length;
      if (!totalPages) throw new Error("Không có trang hợp lệ.");

      const useJpeg = Boolean(state.convertJpeg);
      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file txt định danh
      zip.addFile(`${episodeId}.txt`, new Uint8Array(0));

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map((pageObj) => async () => {
        const rawBuffer = await Utils.fetchBuffer(pageObj.url);
        return await descrambleYnjnImage(rawBuffer, pageObj, useJpeg);
      });

      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res?.data) zip.addFile(res.fileName, res.data);
      }

      const zipName = `${getCleanTitle(chapterName)}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[ynjn-dl] Error:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * KHỞI CHẠY VÀ THEO DÕI SPA
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(30);
    const ui = getUI();

    if (!isEpisodeUrl()) {
      if (ui?.panel) ui.panel.style.display = "none";
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
      return;
    }

    if (ui?.panel) ui.panel.style.display = "block";
    if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });

    const { episodeId } = getUrlParams();
    let data = null;
    let retries = 0;

    while (retries < 25) {
      try {
        if (episodeId && episodeId === state.lastEpId && retries < 15) {
          await sleep(150);
          retries++;
          continue;
        }

        data = await fetchYnjnPages();
        if (data && data.pages?.length > 0) {
          state.lastEpId = episodeId;
          break;
        }
      } catch (e) {}
      await sleep(150);
      retries++;
    }

    if (data && data.pages?.length > 0) {
      state.chapterData = data;
      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: data.pages.length,
          status: "Sẵn sàng."
        });
      }
    } else {
      if (ui) ui.updateProgress({ status: "Sẵn sàng." });
    }
  }

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