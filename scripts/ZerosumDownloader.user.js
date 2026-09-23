// ==UserScript==
// @name         ZERO-SUM ONLINE Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://zerosumonline.com/favicon.ico
// @description  Tải manga trên ZERO-SUM ONLINE (zerosumonline.com) chuẩn Zero-Copy 0ms.
// @author       anonymous & AI
// @match        https://zerosumonline.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      zerosumonline.com
// @connect      *.zerosumonline.com
// @connect      api.zerosumonline.com
// @connect      contents.zerosumonline.com
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function zerosumUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6,   // 6 luồng kịch trần TCP Socket
    JPEG_QUALITY: 1.0    // Chất lượng nếu người dùng tick chọn ép xuất JPG
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("zerosum-dl:convert-jpeg") === '1',
    detectedSourceFormat: 'webp',
    chapterData: null,
    ui: null,
    lastUrl: ""
  };

  /* =========================================================================
   * 1. HOOK MẠNG ĐÁNH CHẶN API /api/v1/viewer (0ms, KHỬ 100% LỖI 0/0 SPA)
   * ========================================================================= */
  let capturedChapterId = null;
  let capturedApiText = null;

  function handleViewerResponse(url, text) {
    if (typeof text === 'string' && text.includes('contents.zerosumonline.com')) {
      const m = url.match(/chapter_id=(\d+)/);
      if (m) capturedChapterId = m[1];
      capturedApiText = text;
      if (isEpisodeUrl() && !state.running) boot();
    }
  }

  const origFetch = WIN.fetch;
  if (typeof origFetch === 'function') {
    WIN.fetch = async function(...args) {
      const res = await origFetch.apply(this, args);
      try {
        const u = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        if (u.includes('/api/v1/viewer')) {
          res.clone().text().then(txt => handleViewerResponse(u, txt)).catch(() => {});
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
        if (this._reqUrl && String(this._reqUrl).includes('/api/v1/viewer')) {
          handleViewerResponse(this._reqUrl, this.responseText);
        }
      });
      return origXhrSend.apply(this, arguments);
    };
  }

  /* =========================================================================
   * 2. GIAO DIỆN UNIVERSAL UI CHUẨN ZERO-SUM (TÍM HOA CÀ - TRẮNG SÁNG)
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      state.ui = createUI({
        storagePrefix: "zerosum-dl",
        title: "ZERO-SUM ONLINE",
        engine: "ICHIJINSHA",
        themeColor: "#b078b4",     
        themeBg: "#ffffff",         
        titleColor: "#a86fa8",      
        btnBg: "#b078b4",           
        btnColor: "#ffffff",        
        topOffset: "57px",
        defaultJpgText: "Xuất file JPG (ảnh gốc là WebP)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("zerosum-dl:convert-jpeg", checked ? '1' : '0');
        }
      });

      state.ui.updateFormatUI(state.detectedSourceFormat);

      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:#a86fa8;letter-spacing:0.3px;">ZERO-SUM ONLINE</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px;visibility:hidden;">ICHIJINSHA</div>
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
    const p = WIN.location.pathname;
    return p.includes('/chapter/') && p.includes('/episode/');
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

  function getCleanTitle() {
    try {
      const rawTitle = DOC.title || DOC.querySelector('meta[property="og:title"]')?.getAttribute('content') || "";
      
      // Tách các vế qua dấu gạch dọc (| hoặc ｜) và lọc sạch tên sàn
      const parts = rawTitle
        .split(/[|｜]/)
        .map(p => cleanString(p))
        .filter(p => p && !/(?:ゼロサム|ZERO-SUM|ゼロサムオンライン|一迅社)/i.test(p));

      if (parts.length >= 2) {
        const isChap = str => /^(?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\.]+\s*(?:話|回|巻|章|節|部|エピソード|分冊版|単話)/i.test(str);

        let seriesTitle  = isChap(parts[0]) ? parts[1] : parts[0];
        let episodeTitle = isChap(parts[0]) ? parts[0] : parts[1];

        // 1. Xử lý Oneshot: Nếu tên chap trùng khít tên truyện -> Chỉ xuất [Tên Truyện].zip
        if (seriesTitle === episodeTitle || !episodeTitle) {
          return seriesTitle;
        }

        // 2. Khử trùng lặp nếu tên chap vô tình chứa lại tên truyện ở đầu
        if (episodeTitle.startsWith(seriesTitle)) {
          episodeTitle = cleanString(episodeTitle.substring(seriesTitle.length).replace(/^[\s\-_:：\u3000・･]+/, ''));
        }

        if (seriesTitle && episodeTitle && seriesTitle !== episodeTitle) {
          return `${seriesTitle} - ${episodeTitle}`;
        }
        return seriesTitle || episodeTitle;
      }

      if (parts.length === 1) {
        return parts[0];
      }
    } catch (e) {}

    return `ZeroSum_${capturedChapterId || 'Episode'}`;
  }

  /* =========================================================================
   * 4. BÓC TÁCH CHAPTER ID & MANIFEST TỪ API VIEWER
   * ========================================================================= */
  function extractDecodedChapterIdFromDOM() {
    // 1. Quét thẳng toàn bộ HTML bằng Regex miễn nhiễm với ký tự escape \" của Next.js App Router
    const html = DOC.documentElement?.innerHTML || DOC.body?.innerHTML || "";
    const m = html.match(/decodedChapterId[^\d]*(\d+)/i);
    if (m && m[1]) return m[1];

    // 2. Dự phòng quét trong các khối thẻ script
    const scripts = DOC.querySelectorAll('script');
    for (const s of scripts) {
      const txt = s.textContent || '';
      if (txt.includes('decodedChapterId')) {
        const sm = txt.match(/decodedChapterId[^\d]*(\d+)/i);
        if (sm && sm[1]) return sm[1];
      }
    }

    return null;
  }

  async function resolveChapterId() {
    if (capturedChapterId) return capturedChapterId;

    let id = extractDecodedChapterIdFromDOM();
    if (id) return id;

    // Polling chờ DOM Next.js nạp dữ liệu
    for (let i = 0; i < 25; i++) {
      await sleep(150);
      if (capturedChapterId) return capturedChapterId;
      id = extractDecodedChapterIdFromDOM();
      if (id) return id;
    }
    return null;
  }

  async function fetchZerosumManifest(chapterId) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    let responseText = capturedApiText;

    // Nếu hook chưa bắt được gói tin tự nhiên thì gửi request API trực tiếp
    if (!responseText) {
      const apiUrl = `https://api.zerosumonline.com/api/v1/viewer?chapter_id=${chapterId}`;
      responseText = await new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "POST",
          url: apiUrl,
          headers: {
            "Accept": "*/*",
            "Origin": "https://zerosumonline.com",
            "Referer": WIN.location.href
          },
          responseType: "text",
          onload: res => (res.status >= 200 && res.status < 300) ? resolve(res.responseText) : reject(new Error(`HTTP ${res.status}`)),
          onerror: () => reject(new Error("Lỗi kết nối API Zero-Sum")),
          ontimeout: () => reject(new Error("Timeout kết nối API Zero-Sum"))
        });
      });
    }

    if (!responseText) throw new Error("Không nhận được dữ liệu từ API Viewer.");

    // 1. Quét toàn bộ link trang truyện chính: /chapter_page/{chapterId}/{page}.webp
    const pageMatches = responseText.match(/https:\/\/contents\.zerosumonline\.com\/chapter_page\/\d+\/\d+\.webp/g) || [];
    const uniquePageUrls = Array.from(new Set(pageMatches));

    // Sắp xếp số học chuẩn: 1.webp -> 2.webp -> ... -> 46.webp
    uniquePageUrls.sort((a, b) => {
      const numA = parseInt(a.match(/\/(\d+)\.webp$/)?.[1] || 0, 10);
      const numB = parseInt(b.match(/\/(\d+)\.webp$/)?.[1] || 0, 10);
      return numA - numB;
    });

    if (uniquePageUrls.length === 0) {
      throw new Error("Không tìm thấy danh sách ảnh trang truyện.");
    }

    // 2. Quét ảnh quảng cáo kết thúc chương (viewer_ad_ending) nếu có
    const adMatches = responseText.match(/https:\/\/contents\.zerosumonline\.com\/viewer_ad_ending\/\d+\.webp/g) || [];
    const adUrl = adMatches.length > 0 ? adMatches[0] : null;

    // Xây dựng danh sách tải: Trang chính đánh số 1..N, ảnh PR đặt tên PR.webp
    const downloadQueue = uniquePageUrls.map((url, idx) => ({
      url: url,
      fileName: `${idx + 1}`
    }));

    if (adUrl) {
      downloadQueue.push({
        url: adUrl,
        fileName: "PR"
      });
    }

    return {
      chapterId: chapterId,
      queue: downloadQueue,
      format: 'webp'
    };
  }

  /* =========================================================================
   * 5. TIẾN TRÌNH TẢI CHÍNH & ZERO-COPY 0MS VÀO ZIP
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    const chapterId = await resolveChapterId();
    if (!chapterId) {
      if (ui) ui.updateProgress({ status: "Lỗi: Không tìm thấy Chapter ID." });
      return;
    }

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let data = state.chapterData;
      if (!data || !data.queue?.length) {
        data = await fetchZerosumManifest(chapterId);
        state.chapterData = data;
      }

      const { queue } = data;
      const totalPages = queue.length;
      if (!totalPages) throw new Error("Không có trang hợp lệ để tải.");

      const useJpeg = Boolean(state.convertJpeg);
      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file định danh ID chương theo Golden Rule 2
      zip.addFile(`${chapterId}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      // Hàng đợi tải 6 luồng song song qua CDN CloudFront / S3
      const tasks = queue.map((item) => async () => {
        let rawBuffer = null;

        // Thử fetch trực tiếp trong tab trước (0ms), fallback sang GM_xhr nếu bị chặn CORS
        try {
          const res = await WIN.fetch(item.url);
          if (res.ok) rawBuffer = await res.arrayBuffer();
        } catch (e) {}

        if (!rawBuffer) {
          rawBuffer = await Utils.fetchBuffer(item.url, { "Referer": "https://zerosumonline.com/" });
        }

        const rawUint8 = new Uint8Array(rawBuffer);
        const ext = Utils.detectExt(rawBuffer);

        // ZERO-COPY: Ghi thẳng mảng byte WebP sạch vào ZIP
        if (!useJpeg || ext === 'jpg') {
          return { fileName: `${item.fileName}.${ext}`, data: rawUint8 };
        }

        // Chuyển sang JPG nếu người dùng tick chọn
        const img = await Utils.loadImage(rawBuffer, `image/${ext}`);
        const canvas = DOC.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;

        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.imageSmoothingEnabled = false;
        ctx.mozImageSmoothingEnabled = false;
        ctx.webkitImageSmoothingEnabled = false;
        ctx.msImageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0);

        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', CONFIG.JPEG_QUALITY));
        canvas.width = 0; canvas.height = 0;

        return { fileName: `${item.fileName}.jpg`, data: new Uint8Array(await blob.arrayBuffer()) };
      });

      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res?.data) zip.addFile(res.fileName, res.data);
      }

      const zipName = `${getCleanTitle()}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[zerosum-dl] Download error:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * 6. KHỞI CHẠY & THEO DÕI ĐIỀU HƯỚNG NEXT.JS SPA
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
      ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
    }

    const chapterId = await resolveChapterId();
    if (!chapterId) {
      if (ui) ui.updateProgress({ status: "Lỗi: Không tìm thấy ID chương." });
      return;
    }

    try {
      const data = await fetchZerosumManifest(chapterId);
      if (data && data.queue?.length > 0) {
        state.chapterData = data;
        state.detectedSourceFormat = data.format;

        // Cập nhật UI: Mở checkbox cho người dùng tùy chọn convert sang JPG
        if (ui?.updateFormatUI) ui.updateFormatUI(data.format);

        if (ui) {
          ui.updateProgress({
            completed: 0,
            total: data.queue.length,
            status: "Sẵn sàng."
          });
        }
      }
    } catch (e) {
      if (ui) ui.updateProgress({ status: "Sẵn sàng." });
    }
  }

  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute((newUrl) => {
      if (newUrl === state.lastUrl) return;
      state.lastUrl = newUrl;
      state.chapterData = null;
      capturedChapterId = null;
      capturedApiText = null;
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