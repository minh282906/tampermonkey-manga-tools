// ==UserScript==
// @name         Manga Mee Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://manga-mee.jp/favicon.ico
// @description  Tải manga trên Manga Mee (manga-mee.jp).
// @author       anonymous & AI
// @match        https://manga-mee.jp/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      manga-mee.jp
// @connect      *.manga-mee.jp
// @connect      prod2-android.manga-mee.jp
// @connect      prod-img.manga-mee.jp
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function mangaMeeUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6,   // 6 luồng TCP Socket
    JPEG_QUALITY: 1.0    // Chất lượng nếu người dùng chọn ép xuất JPG
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("mangamee-dl:convert-jpeg") === '1',
    detectedSourceFormat: 'webp',
    chapterData: null,
    ui: null,
    lastUrl: "",
    lastEpisodeId: ""
  };

  /* =========================================================================
   * 1. HOOK MẠNG ĐÓN ĐẦU GÓI TIN TITLE_DETAIL
   * ========================================================================= */
  let capturedApiText = null;
  let capturedEpisodeId = null;

  function handleTitleDetail(url, text) {
    if (typeof text === 'string' && text.includes('prod-img.manga-mee.jp')) {
      capturedApiText = text;
      
      const mUrl = url.match(/episode_id=(\d+)/);
      if (mUrl) {
        capturedEpisodeId = mUrl[1];
      } else {
        const mImg = text.match(/\/chapter\/(\d+)\//);
        if (mImg) capturedEpisodeId = mImg[1];
      }

      if (isEpisodeUrl() && !state.running) boot();
    }
  }

  const origFetch = WIN.fetch;
  if (typeof origFetch === 'function') {
    WIN.fetch = async function(...args) {
      const res = await origFetch.apply(this, args);
      try {
        const u = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        if (u.includes('title_detail')) {
          res.clone().text().then(txt => handleTitleDetail(u, txt)).catch(() => {});
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
        if (this._reqUrl && String(this._reqUrl).includes('title_detail')) {
          handleTitleDetail(this._reqUrl, this.responseText);
        }
      });
      return origXhrSend.apply(this, arguments);
    };
  }

  /* =========================================================================
   * 2. GIAO DIỆN THEME: HỒNG SAN HÔ (#FF6E99) - NỀN TRẮNG SÁNG
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      state.ui = createUI({
        storagePrefix: "mangamee-dl",
        title: "マンガMee",
        engine: "by SHUEISHA",
        themeColor: "#FF6E99",      
        themeBg: "#ffffff",         
        titleColor: "#FF6E99",      
        btnBg: "#FF6E99",           
        btnColor: "#ffffff",       
        topOffset: "95.17px",
        defaultJpgText: "Xuất file JPG (ảnh gốc là WebP)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("mangamee-dl:convert-jpeg", checked ? '1' : '0');
        }
      });

      state.ui.updateFormatUI(state.detectedSourceFormat);

      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:#FF6E99;letter-spacing:0.3px;">マンガMee</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#9ca3af;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px;visibility:hidden;">by SHUEISHA</div>
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
    return /\/detail\/\d+/i.test(WIN.location.pathname);
  }

  function getUrlContext() {
    const pathMatch = WIN.location.pathname.match(/\/detail\/(\d+)/i);
    const titleId = pathMatch ? pathMatch[1] : null;

    let episodeId = new URLSearchParams(WIN.location.search).get('episodeId');
    
    if (!episodeId) {
      const ogUrl = DOC.querySelector('meta[property="og:url"]')?.getAttribute('content');
      const m = ogUrl?.match(/episodeId=(\d+)/);
      if (m) episodeId = m[1];
    }

    if (!episodeId && capturedEpisodeId) {
      episodeId = capturedEpisodeId;
    }

    if (!episodeId) {
      const firstEpEl = DOC.querySelector('a[href*="episodeId="]');
      const m = firstEpEl?.getAttribute('href')?.match(/episodeId=(\d+)/);
      if (m) episodeId = m[1];
    }

    return { titleId, episodeId };
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

  function getCleanTitle(episodeId) {
    try {
      // 1. Tên Truyện: Bắt trực tiếp từ thẻ <h2> chuẩn DOM (hoặc meta og:title)
      let seriesTitle = cleanString(DOC.querySelector('h2.text-greyish-brown, h2')?.textContent || "");
      if (!seriesTitle) {
        let rawTitle = DOC.querySelector('meta[property="og:title"]')?.getAttribute('content') || DOC.title || "";
        rawTitle = rawTitle.replace(/[-－–—\s]*[|/|｜]\s*マンガMee.*$/i, '').trim();
        rawTitle = rawTitle.split(/\s*[-－–—/|｜]\s*(?:無料|公式)/)[0].trim();
        seriesTitle = cleanString(rawTitle);
      }

      // 2. Tên Chương: Bắt trực tiếp từ thẻ <h1> chuẩn DOM
      let episodeTitle = cleanString(DOC.querySelector('h1.text-greyish-brown, h1')?.textContent || "");
      
      // Dự phòng nếu không có h1
      if (!episodeTitle) {
        const epEl = DOC.querySelector('div[class*="bg-pale-green-weak"] > p, [class*="ChapterTitle"], [class*="episode_name"]');
        if (epEl) episodeTitle = cleanString(epEl.textContent);
      }

      // 3. Khử trùng lặp và ghép nối chuẩn
      if (seriesTitle && episodeTitle) {
        if (seriesTitle === episodeTitle) return seriesTitle;
        if (episodeTitle.startsWith(seriesTitle)) {
          episodeTitle = cleanString(episodeTitle.substring(seriesTitle.length).replace(/^[\s\-_:：\u3000・･]+/, ''));
        }
        return `${seriesTitle} - ${episodeTitle}`;
      }

      if (seriesTitle) return `${seriesTitle} - Chapter_${episodeId || 'Episode'}`;
    } catch (e) {}

    return `MangaMee_${episodeId || 'Episode'}`;
  }

  /* =========================================================================
   * 4. MẬT MÃ HỌC SHUEISHA: CYCLIC XOR 64-BYTE (KHÓA 128-HEX)
   * ========================================================================= */
  function hexToBytes(hex) {
    const clean = String(hex || '').trim().replace(/[^0-9a-fA-F]/g, '');
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  function decryptMangaMeeXor(encryptedBuffer, hexKey) {
    const keyBytes = hexToBytes(hexKey);
    const keyLen = keyBytes.length;
    const rawBytes = new Uint8Array(encryptedBuffer);
    const decrypted = new Uint8Array(rawBytes.length);

    for (let i = 0; i < rawBytes.length; i++) {
      decrypted[i] = rawBytes[i] ^ keyBytes[i % keyLen];
    }
    return decrypted; // Trả về Magic Bytes gốc: RIFF (WebP)
  }

  /* =========================================================================
   * 5. BÓC TÁCH MANIFEST TỪ API TITLE_DETAIL
   * ========================================================================= */
  async function fetchMangaMeeManifest(titleId, episodeId) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    let responseText = capturedApiText;

    if (!responseText) {
      let apiUrl = `https://manga-mee.jp/web/v1/title_detail?title_id=${titleId}`;
      if (episodeId) apiUrl += `&episode_id=${episodeId}`;

      try {
        const buf = await Utils.fetchBuffer(apiUrl);
        responseText = new TextDecoder().decode(buf);
      } catch (e) {
        const androidUrl = `https://prod2-android.manga-mee.jp/web/v1/title_detail?title_id=${titleId}` + (episodeId ? `&episode_id=${episodeId}` : '');
        const buf = await Utils.fetchBuffer(androidUrl);
        responseText = new TextDecoder().decode(buf);
      }
    }

    if (!responseText) throw new Error("Không nhận được dữ liệu từ API Manga Mee.");

    const regex = /(https:\/\/prod-img\.manga-mee\.jp\/[^\s"',]+?\/manga_page_web[^\s"',]*?expires=\d{10}).*?([0-9a-fA-F]{128})/gi;
    const pages = [];
    let match;

    while ((match = regex.exec(responseText)) !== null) {
      if (episodeId && !match[1].includes(`/chapter/${episodeId}/`) && !match[1].includes(`/${episodeId}/`)) {
        continue;
      }

      pages.push({
        pageNo: pages.length + 1,
        url: match[1],
        key: match[2]
      });
    }

    if (pages.length === 0) {
      throw new Error("Không tìm thấy trang truyện trong gói tin.");
    }

    return {
      episodeId: episodeId || "chapter",
      pages: pages,
      format: 'webp'
    };
  }

  /* =========================================================================
   * 6. TIẾN TRÌNH TẢI CHÍNH & ZERO-COPY 0MS VÀO ZIP
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    const { titleId, episodeId } = getUrlContext();
    if (!titleId) {
      if (ui) ui.updateProgress({ status: "Lỗi: Không tìm thấy Title ID." });
      return;
    }

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let data = state.chapterData;
      if (!data || !data.pages?.length) {
        data = await fetchMangaMeeManifest(titleId, episodeId);
        state.chapterData = data;
      }

      const { pages, format } = data;
      const totalPages = pages.length;
      if (!totalPages) throw new Error("Lỗi: Không có trang hợp lệ để tải.");

      const useJpeg = Boolean(state.convertJpeg);
      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      const epId = episodeId || data.episodeId;
      zip.addFile(`${epId}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map((pageItem) => async () => {
        const encryptedBuffer = await Utils.fetchBuffer(pageItem.url, { "Referer": "https://manga-mee.jp/" });
        const decryptedBytes = decryptMangaMeeXor(encryptedBuffer, pageItem.key);
        const ext = Utils.detectExt(decryptedBytes.buffer);

        // ZERO-COPY: Ghi thẳng mảng byte WebP sạch vào ZIP
        if (!useJpeg || ext === 'jpg') {
          return { fileName: `${pageItem.pageNo}.${ext}`, data: decryptedBytes };
        }

        // Chuyển sang JPG nếu người dùng tick chọn
        const img = await Utils.loadImage(decryptedBytes, `image/${ext}`);
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

        return { fileName: `${pageItem.pageNo}.jpg`, data: new Uint8Array(await blob.arrayBuffer()) };
      });

      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res?.data) zip.addFile(res.fileName, res.data);
      }

      const zipName = `${getCleanTitle(epId)}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[mangamee-dl] Download error:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * 7. KHỞI CHẠY & THEO DÕI ĐIỀU HƯỚNG SPA
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

    let titleId = null, episodeId = null;
    for (let i = 0; i < 25; i++) {
      const ctx = getUrlContext();
      titleId = ctx.titleId;
      episodeId = ctx.episodeId;
      if (titleId && (episodeId || capturedApiText)) break;
      await sleep(150);
    }

    if (!titleId) {
      if (ui) ui.updateProgress({ status: "Lỗi: Không tìm thấy ID truyện." });
      return;
    }

    try {
      const data = await fetchMangaMeeManifest(titleId, episodeId);
      if (data && data.pages?.length > 0) {
        state.chapterData = data;
        state.detectedSourceFormat = data.format;

        if (ui?.updateFormatUI) ui.updateFormatUI(data.format);

        await sleep(80);
        if (ui) {
          ui.updateProgress({
            completed: 0,
            total: data.pages.length,
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

      if (!isEpisodeUrl()) {
        const ui = getUI();
        if (ui?.panel) ui.panel.style.display = "none";
        state.chapterData = null;
        state.lastEpisodeId = null;
        state.running = false;
        return;
      }

      const { episodeId } = getUrlContext();
      if (state.lastEpisodeId && state.lastEpisodeId === episodeId) return;

      state.lastUrl = newUrl;
      state.lastEpisodeId = episodeId;
      state.chapterData = null;
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