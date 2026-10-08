// ==UserScript==
// @name         Jumptoon NEXT! Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.1.0
// @icon         https://jumptoon-next.com/favicon.ico
// @description  Tải webtoon gốc không nén trên Shueisha Jumptoon NEXT! (jumptoon-next.com).
// @author       anonymous & AI
// @match        https://jumptoon-next.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      jumptoon-next.com
// @connect      cdn.jumptoon-next.com
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/JumptoonNextDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/JumptoonNextDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function jumptoonNextUniversalDownloader() {
  'use strict';

  const CONFIG = {
    MAX_CONCURRENT: 6,   // 6 luồng tải song song Zero-Copy
    JPEG_QUALITY: 1.0    // Chất lượng nếu người dùng chọn convert JPG
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("jnext-dl:convert-jpeg") === '1',
    chapterData: null,
    ui: null,
    lastCleanUrl: null
  };

  /* =========================================================================
   * 1. GIAO DIỆN UNIVERSAL UI
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "jnext-dl",
        title: "ジャンプTOON NEXT!",
        engine: "SHUEISHA UGC",
        themeColor: "#f97316",       // Cam tươi sáng năng động theo phong cách Indie
        themeBg: "#18181b",          // Nền tối sang trọng
        titleColor: "#ffffff",
        btnBg: "#f97316",
        btnColor: "#ffffff",
        topOffset: "64px",
        defaultJpgText: "Xuất file JPG (ảnh gốc là PNG)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("jnext-dl:convert-jpeg", checked ? '1' : '0');
        }
      };

      state.ui = createUI(uiConfig);

      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:${uiConfig.titleColor};letter-spacing:0.2px;">${uiConfig.title}</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px;">${uiConfig.engine}</div>
          `;
        }
      }
    }
    return state.ui;
  }

  /* =========================================================================
   * 2. XỬ LÝ CHUỖI & TIÊU ĐỀ CHUẨN
   * ========================================================================= */
  function getCleanUrl() {
    return WIN.location.origin + WIN.location.pathname;
  }

  function isEpisodeUrl() {
    return /\/e\/[a-zA-Z0-9_-]+/.test(WIN.location.pathname);
  }

  function getEpisodeId() {
    const m = WIN.location.pathname.match(/\/e\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : "JNext_Episode";
  }

  function cleanString(str) {
    if (!str) return "";
    return str
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/【[^】]*】/g, '')
      .replace(/[\\/*?:"<>|]/g, '')
      .trim();
  }

  function toOriginMasterUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    const clean = rawUrl.split('?')[0];
    return clean.replace('/OPTIMIZED/', '/');
  }

  function getCleanTitle(seriesTitle, episodeTitle, fallbackId) {
    let cleanSeries = cleanString(seriesTitle);
    let cleanEpisode = cleanString(episodeTitle);

    cleanSeries = cleanSeries.replace(/（[^）]*(?:コミック|文庫|レーベル|出版|COMIC|WEB)[^）]*）$/i, '').trim();
    cleanSeries = cleanSeries.replace(/\([^)]*(?:コミック|文庫|レーベル|出版|COMIC|WEB)[^)]*\)$/i, '').trim();

    if (cleanSeries && cleanEpisode.startsWith(cleanSeries)) {
      cleanEpisode = cleanString(cleanEpisode.substring(cleanSeries.length));
    }
    cleanEpisode = cleanEpisode.replace(/^[・･\s\-_:：\u3000]+/, '').trim();

    if (cleanSeries && cleanEpisode) {
      return `${cleanSeries} - ${cleanEpisode}`;
    } else if (cleanEpisode) {
      return cleanEpisode;
    } else if (cleanSeries) {
      return `${cleanSeries} - ${fallbackId}`;
    }
    return `JumptoonNext_${fallbackId}`;
  }

  /* =========================================================================
   * 3. BÓC TÁCH DỮ LIỆU & SO KHỚP CHẶT CHẼ THEO TARGET EPISODE ID
   * ========================================================================= */
  function findEpisodeNodeById(obj, targetId) {
    if (!obj || typeof obj !== 'object') return null;
    // BẮT BUỘC TRÙNG KHỚP ID TẬP ĐANG XEM (CHỐNG BỐC PHẢI TẬP CŨ)
    if (obj.__typename === 'Episode' && String(obj.id) === String(targetId) && Array.isArray(obj.pages)) {
      return obj;
    }
    for (const k in obj) {
      const found = findEpisodeNodeById(obj[k], targetId);
      if (found) return found;
    }
    return null;
  }

  function extractFromUrqlMemory(targetId) {
    try {
      const sym = Symbol.for("urql_transport");
      const arr = WIN[sym];
      if (Array.isArray(arr)) {
        for (const item of arr) {
          const ep = findEpisodeNodeById(item, targetId);
          if (ep) return ep;
        }
      }
    } catch (e) {}

    const scripts = DOC.querySelectorAll('script');
    for (const s of scripts) {
      const txt = s.textContent || '';
      if (txt.includes('urql_transport') && txt.includes(targetId)) {
        try {
          const match = txt.match(/\.push\(({.+?})\);?/s);
          if (match && match[1]) {
            const ep = findEpisodeNodeById(JSON.parse(match[1]), targetId);
            if (ep) return ep;
          }
        } catch (e) {}
      }
    }
    return null;
  }

  function extractFromDom() {
    const imgs = DOC.querySelectorAll('section img[alt*="Page"], main img[alt*="Page"]');
    const pages = [];
    const seen = new Set();

    for (const img of imgs) {
      const alt = img.getAttribute('alt') || '';
      if (!/^Page \d+/i.test(alt.trim())) continue;

      const src = img.getAttribute('src') || img.src || '';
      if (src.includes('cdn.jumptoon-next.com')) {
        const masterUrl = toOriginMasterUrl(src);
        if (masterUrl && !seen.has(masterUrl)) {
          seen.add(masterUrl);
          pages.push(masterUrl);
        }
      }
    }
    return pages;
  }

  async function syncChapterData() {
    const epId = getEpisodeId();
    let rawPages = [];

    // 1. Lấy từ urql transport và SO KHỚP ĐÚNG ID TẬP
    const urqlEp = extractFromUrqlMemory(epId);
    if (urqlEp && Array.isArray(urqlEp.pages) && urqlEp.pages.length > 0) {
      rawPages = urqlEp.pages.map(p => `https://cdn.jumptoon-next.com/${p.image?.objectKey || ''}`).filter(u => !u.endsWith('/'));
    }

    // 2. Nếu chưa có, chủ động kéo ?_rsc=1 tươi mới chống bẫy F5
    if (!rawPages.length) {
      try {
        const Utils = window.MangaUtils || globalThis.MangaUtils;
        const rscUrl = `${WIN.location.pathname}?_rsc=1`;
        const buf = await Utils.fetchBuffer(rscUrl, { 'RSC': '1', 'Referer': WIN.location.href });
        const txt = new TextDecoder().decode(buf);
        
        // CHỈ QUÉT BÊN TRONG KHỐI "pages":[...] (LOẠI BỎ KHỐI user.icon CHỨA AVATAR):
        const pagesBlockMatch = txt.match(/"pages":\s*\[(.*?)\]\s*,\s*"work"/s) || txt.match(/"pages":\s*\[(.*?)\]/s);
        if (pagesBlockMatch && pagesBlockMatch[1]) {
          const m = pagesBlockMatch[1].match(/"objectKey":"([A-Za-z0-9_.-]+)"/g);
          if (m && m.length > 0) {
            const keys = m.map(k => k.match(/"objectKey":"([A-Za-z0-9_.-]+)"/)[1]);
            rawPages = Array.from(new Set(keys)).map(k => `https://cdn.jumptoon-next.com/${k}`);
          }
        }
      } catch (e) {}
    }

    // 3. Fallback bóc tách từ DOM
    if (!rawPages.length) {
      for (let i = 0; i < 20 && !rawPages.length; i++) {
        await sleep(100);
        rawPages = extractFromDom();
      }
    }

    if (!rawPages.length) return null;

    let seriesTitle = "";
    let episodeTitle = "";
    const rawMetaTitle = DOC.querySelector('meta[property="og:title"]')?.getAttribute('content') || DOC.title || "";
    const cleanFull = rawMetaTitle.split(/[|｜]/)[0].trim();
    const match = cleanFull.match(/^(.*?)\s+((?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\.]+\s*(?:話|巻|章|節|部|エピソード)?.*)$/i);

    if (match) {
      seriesTitle = match[1];
      episodeTitle = match[2];
    } else {
      seriesTitle = cleanFull;
      episodeTitle = epId;
    }

    return {
      seriesTitle,
      episodeTitle,
      episodeId: epId,
      pages: rawPages
    };
  }

  /* =========================================================================
   * 4. TIẾN TRÌNH TẢI CHÍNH (ZERO-COPY 0MS VÀO ZIP)
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
        data = await syncChapterData();
        state.chapterData = data;
      }

      if (!data || !data.pages?.length) throw new Error("Không thể trích xuất danh sách trang.");

      const { pages, seriesTitle, episodeTitle, episodeId } = data;
      const totalPages = pages.length;
      const useJpeg = Boolean(state.convertJpeg);

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      zip.addFile(`${episodeId}.txt`, new Uint8Array(0));

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map((url, idx) => async () => {
        const rawBuffer = await Utils.fetchBuffer(url, { "Referer": "https://jumptoon-next.com/" });
        const ext = Utils.detectExt(rawBuffer) || 'png';

        if (!useJpeg || ext === 'jpg') {
          return {
            fileName: `${idx + 1}.${ext}`,
            data: new Uint8Array(rawBuffer)
          };
        }

        const img = await Utils.loadImage(rawBuffer, `image/${ext}`);
        const canvas = DOC.createElement('canvas');
        canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0);

        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', CONFIG.JPEG_QUALITY));
        canvas.width = 0; canvas.height = 0;
        return {
          fileName: `${idx + 1}.jpg`,
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

      const zipName = `${getCleanTitle(seriesTitle, episodeTitle, episodeId)}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[jnext-dl] Error:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * 5. KHỞI CHẠY (BOOT) - ẨN MẶC ĐỊNH & SPA ROUTE WATCHER
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(30);
    const ui = getUI();

    // 1. Luôn giấu UI lúc đầu (CHỐNG CHỚP NHÁY / FLICKER)
    if (ui?.panel) ui.panel.style.display = "none";

    // 2. Chỉ phục vụ trang đọc chương /e/
    if (!isEpisodeUrl()) {
      return;
    }

    state.chapterData = null;
    const data = await syncChapterData();
    state.chapterData = data;

    // 3. CHỈ KHI NÀO CÓ TRANG TRANH THÌ MỚI HIỆN UI!
    if (!data || !data.pages || !data.pages.length) {
      return;
    }

    if (ui?.panel) ui.panel.style.display = "block";
    await sleep(80); // Micro-delay chuẩn Golden Rule 3

    if (ui) {
      ui.updateFormatUI('png');
      ui.updateProgress({
        completed: 0,
        total: data.pages.length,
        status: "Sẵn sàng."
      });
    }
  }

  state.lastCleanUrl = getCleanUrl();
  setInterval(() => {
    const cur = getCleanUrl();
    if (cur !== state.lastCleanUrl) {
      state.lastCleanUrl = cur;
      state.chapterData = null;
      state.running = false;
      boot();
    }
  }, 400);

  if (DOC.readyState === "loading") {
    DOC.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();