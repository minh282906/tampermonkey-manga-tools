// ==UserScript==
// @name         MANGA UP! Global Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      2.0.0
// @icon         https://global.manga-up.com/favicon.ico
// @description  Tải manga siêu tốc trên MANGA UP! Global (Bản quốc tế của Square Enix), giải mã phần cứng AES-CBC Zero-Copy.
// @author       anonymous & AI
// @match        https://global.manga-up.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      global.manga-up.com
// @connect      global-api.manga-up.com
// @connect      global-img.manga-up.com
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function mangaUpGlobalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH TOÀN CỤC
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6,   // 6 luồng tải và giải mã song song trong RAM
    JPEG_QUALITY: 0.95   // Chất lượng xuất JPG nếu tick chọn
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("mup-global:convert-jpeg") === '1',
    chapterData: null,
    ui: null,
    lastUrl: "",
    rawViewerConfig: ""
  };

  /* =========================================================================
   * BỘ HỖ TRỢ XỬ LÝ CHUỖI & TÊN FILE CHUẨN (GOLDEN RULES)
   * ========================================================================= */
  function cleanString(str) {
    if (!str) return "";
    return str
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/【[^】]*】/g, '')
      .replace(/[\\/*?:"<>|]/g, '')
      .trim();
  }

  function isEpisodeUrl() {
    const path = WIN.location.pathname;
    // Bắt buộc định dạng đọc truyện: /manga/(id_truyen)/(id_chuong)
    return /\/manga\/\d+\/\d+/i.test(path) || /\/chapters?\/[^\/]+/i.test(path);
  }

  function getEpisodeId() {
    const cleanPath = WIN.location.pathname.replace(/\/index\.html?$/i, '').replace(/\/$/, '');
    const globalMatch = cleanPath.match(/\/manga\/\d+\/([a-zA-Z0-9_-]+)/i);
    if (globalMatch) return globalMatch[1];
    const chapMatch = cleanPath.match(/\/chapters?\/([a-zA-Z0-9_-]+)/i);
    if (chapMatch) return chapMatch[1];
    return "MUP_Episode";
  }

  function getCleanTitle(manifestSeries, manifestEpisode) {
    let seriesTitle = cleanString(manifestSeries);
    let episodeTitle = cleanString(manifestEpisode);

    if (!seriesTitle) {
      const h1El = DOC.querySelector('h1, [class*="Header_title"], [class*="Header"] p');
      if (h1El) seriesTitle = cleanString(h1El.textContent);
    }

    if (!seriesTitle || !episodeTitle) {
      let rawDoc = (DOC.title || "").split(/[|｜]/)[0].trim();
      const tMatch = rawDoc.match(/^(.*?)(?:\s+[-–—]\s+)(Chapter\s*[\d.]+|[\d.]+\w*|Episode\s*[\d.]+|Part\s*[\d.]+.*)$/i);
      if (tMatch) {
        if (!seriesTitle) seriesTitle = cleanString(tMatch[1]);
        if (!episodeTitle) episodeTitle = cleanString(tMatch[2]);
      } else {
        if (!seriesTitle) seriesTitle = cleanString(rawDoc.replace(/MANGA\s*UP!.*$/gi, '').replace(/SQUARE\s*ENIX.*$/gi, ''));
      }
    }

    if (seriesTitle && episodeTitle && !seriesTitle.includes(episodeTitle)) {
      return `${seriesTitle} - ${episodeTitle}`;
    }
    return seriesTitle || `MANGAUP_${getEpisodeId()}`;
  }

  function unhex(hexStr) {
    const arr = new Uint8Array(hexStr.length / 2);
    for (let i = 0; i < hexStr.length; i += 2) arr[i / 2] = parseInt(hexStr.substring(i, i + 2), 16);
    return arr;
  }

  /* =========================================================================
   * GIAO DIỆN UI UNIVERSAL 2 TẦNG (MANGAUP! / SQUARE ENIX)
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      state.ui = createUI({
        storagePrefix: "mup-global",
        title: "MANGAUP!",
        themeColor: "#1900ff",
        themeBg: "#ffffff",
        titleColor: "#0015ff",
        topOffset: "143px",
        defaultJpgText: "Xuất file JPG (ảnh gốc là WebP)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("mup-global:convert-jpeg", checked ? '1' : '0');
        }
      });

      state.ui.updateFormatUI('webp');

      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:#0015ff;letter-spacing:0.2px;">MANGAUP!</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px;">SQUARE ENIX</div>
          `;
        }
      }
    }
    return state.ui;
  }

  /* =========================================================================
   * BÓC TÁCH DỮ LIỆU TỪ GÓI VIEWER_V2
   * ========================================================================= */
  function parseViewerV2(rawText) {
    if (!rawText) return null;
    const pages = [];
    const lines = rawText.split(/[\r\n]+/);

    let episodeName = "";
    if (lines.length > 0 && !lines[0].includes('.webp')) {
      episodeName = cleanString(lines[0]);
    }

    for (const line of lines) {
      if (!line.includes('.webp.enc') && !line.includes('.enc')) continue;

      const atParts = line.split('*@');
      if (atParts.length < 2) continue;

      const pathMatch = atParts[0].match(/([A-Za-z0-9_/-]+\.webp\.enc\?[^\s*]+)/);
      if (!pathMatch) continue;

      let rawPath = pathMatch[1].replace(/^[A-Z]\//i, '');
      const relPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
      const fullUrl = `https://global-img.manga-up.com${relPath}`;

      const cryptoText = atParts[1].trim();
      const hexParts = cryptoText.match(/[0-9a-f]{32,66}/gi) || [];
      if (hexParts.length < 2) continue;

      const rawKeyHex = hexParts[0];
      const ivHex = hexParts[1].substring(0, 32);
      const keyHex = rawKeyHex.substring(0, 64);

      pages.push({
        pageNo: pages.length + 1,
        url: fullUrl,
        key: keyHex,
        iv: ivHex
      });
    }

    if (pages.length > 0) {
      return {
        episodeTitle: episodeName,
        pages: pages
      };
    }
    return null;
  }

  function applyViewerData(rawText) {
    state.rawViewerConfig = rawText;
    const parsed = parseViewerV2(rawText);
    if (parsed && parsed.pages?.length > 0) {
      state.chapterData = parsed;
      const ui = getUI();
      if (ui && isEpisodeUrl()) {
        ui.updateProgress({
          completed: 0,
          total: parsed.pages.length,
          status: "Sẵn sàng."
        });
      }
    }
  }

  /* =========================================================================
   * CẦU NỐI MAIN-WORLD BRIDGE ĐA TẦNG (BẮT GÓI MẠNG 0ms)
   * ========================================================================= */
  // 1. Hook Fetch & XHR trực tiếp
  const _fetch = WIN.fetch;
  if (typeof _fetch === 'function') {
    WIN.fetch = function (...args) {
      const p = _fetch.apply(this, args);
      p.then(res => {
        try {
          const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
          if (String(url).includes('viewer_v2')) {
            res.clone().text().then(txt => applyViewerData(txt));
          }
        } catch (e) {}
      }).catch(() => {});
      return p;
    };
  }

  const _xhrOpen = WIN.XMLHttpRequest?.prototype?.open;
  const _xhrSend = WIN.XMLHttpRequest?.prototype?.send;
  if (_xhrOpen && _xhrSend) {
    WIN.XMLHttpRequest.prototype.open = function (method, url) {
      this._reqUrl = url;
      return _xhrOpen.apply(this, arguments);
    };
    WIN.XMLHttpRequest.prototype.send = function () {
      this.addEventListener('load', () => {
        if (this._reqUrl && String(this._reqUrl).includes('viewer_v2')) {
          applyViewerData(this.responseText);
        }
      });
      return _xhrSend.apply(this, arguments);
    };
  }

  // 2. Bơm Main World Bridge kèm MutationObserver
  function injectMainWorld() {
    if (DOC.getElementById('__mup_global_bridge_script')) return;
    const s = DOC.createElement('script');
    s.id = '__mup_global_bridge_script';
    s.textContent = `
      (function() {
        function emit(u, t) {
          if (t && (t.includes('page_high') || t.includes('.webp.enc') || t.includes('KEE/') || t.includes('KFF/'))) {
            window.postMessage({ type: '__MUP_GLOBAL_READY__', url: String(u), text: t }, '*');
          }
        }
        const of = window.fetch;
        if (of) {
          window.fetch = async function(...args) {
            const u = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
            const res = await of.apply(this, args);
            if (String(u).includes('viewer_v2')) {
              try { res.clone().text().then(t => emit(u, t)); } catch(e){}
            }
            return res;
          };
        }
        const ox = window.XMLHttpRequest;
        if (ox) {
          const oo = ox.prototype.open, os = ox.prototype.send;
          ox.prototype.open = function(m, u) { this._u = u; return oo.apply(this, arguments); };
          ox.prototype.send = function() {
            this.addEventListener('load', () => {
              if (String(this._u).includes('viewer_v2')) emit(this._u, this.responseText);
            });
            return os.apply(this, arguments);
          };
        }
      })();
    `;
    (DOC.head || DOC.documentElement).appendChild(s);
  }

  injectMainWorld();
  if (!DOC.documentElement) {
    const obs = new MutationObserver(() => {
      if (DOC.documentElement) {
        injectMainWorld();
        obs.disconnect();
      }
    });
    obs.observe(DOC, { childList: true });
  }

  WIN.addEventListener('message', (e) => {
    if (e.data?.type === '__MUP_GLOBAL_READY__' && e.data.text) {
      applyViewerData(e.data.text);
    }
  });

  /* =========================================================================
   * TIẾN TRÌNH TẢI & GIẢI MÃ PHẦN CỨNG AES-CBC (6 LUỒNG TRONG RAM)
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
        data = parseViewerV2(state.rawViewerConfig);
        state.chapterData = data;
      }

      if (!data || !data.pages?.length) throw new Error("Chưa nhận được gói dữ liệu trang.");

      const pages = data.pages;
      const totalPages = pages.length;
      const useJpeg = Boolean(state.convertJpeg);

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      const epId = getEpisodeId();
      zip.addFile(`${epId}.txt`, new Uint8Array(0));

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map((pageObj) => async () => {
        let rawBuffer = null;

        // 1. Tải ảnh trực tiếp bằng window.fetch của trình duyệt (vượt rào CORS)
        try {
          const res = await WIN.fetch(pageObj.url);
          if (res.ok) rawBuffer = await res.arrayBuffer();
        } catch (e) {}

        if (!rawBuffer) {
          rawBuffer = await Utils.fetchBuffer(pageObj.url);
        }

        // 2. Giải mã phần cứng AES-CBC qua crypto.subtle
        const cryptoKey = await WIN.crypto.subtle.importKey('raw', unhex(pageObj.key), { name: 'AES-CBC' }, false, ['decrypt']);
        rawBuffer = await WIN.crypto.subtle.decrypt({ name: 'AES-CBC', iv: unhex(pageObj.iv) }, cryptoKey, rawBuffer);

        // 3. Zero-Copy WebP gốc vào ZIP (không qua Canvas)
        if (!useJpeg) {
          return {
            fileName: `${pageObj.pageNo}.webp`,
            data: new Uint8Array(rawBuffer)
          };
        }

        // 4. Chuyển sang JPG nếu người dùng tick chọn
        const img = await Utils.loadImage(rawBuffer, 'image/webp');
        const canvas = DOC.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;

        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);

        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', CONFIG.JPEG_QUALITY));
        canvas.width = 0;
        canvas.height = 0;

        return {
          fileName: `${pageObj.pageNo}.jpg`,
          data: new Uint8Array(await blob.arrayBuffer())
        };
      });

      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res?.data) zip.addFile(res.fileName, res.data);
      }

      const zipName = `${getCleanTitle("", data.episodeTitle)}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[mup-global] Error:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * KHỞI TẠO & THEO DÕI ĐIỀU HƯỚNG SPA
   * ========================================================================= */
  function ensureUIPresence() {
    if (!isEpisodeUrl()) {
      if (state.ui?.panel) state.ui.panel.style.display = "none";
      return;
    }
    const ui = getUI();
    if (ui?.panel) {
      ui.panel.style.display = "block";
      if (!DOC.body.contains(ui.panel)) {
        DOC.body.appendChild(ui.panel);
      }
    }
  }

  async function boot() {
    while (!DOC.body) await sleep(30);

    ensureUIPresence();
    const ui = getUI();

    if (!isEpisodeUrl()) return;

    if (state.chapterData && state.chapterData.pages?.length > 0) {
      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: state.chapterData.pages.length,
          status: "Sẵn sàng."
        });
      }
    } else {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
    }
  }

  setInterval(() => {
    if (isEpisodeUrl() && DOC.body) {
      ensureUIPresence();
    }
  }, 500);

  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute((newUrl) => {
      if (newUrl === state.lastUrl) return;
      state.lastUrl = newUrl;

      state.chapterData = null;
      state.rawViewerConfig = "";
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