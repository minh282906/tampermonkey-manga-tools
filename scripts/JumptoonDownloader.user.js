// ==UserScript==
// @name         Jumptoon Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://jumptoon.com/favicon.ico
// @description  Tải manga và webtoon trên Jumptoon.
// @author       anonymous & AI
// @match        https://jumptoon.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      jumptoon.com
// @connect      contents.jumptoon.com
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/JumptoonDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/JumptoonDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/decoders/JumptoonTools.js
// ==/UserScript==

(function jumptoonUniversalDownloader() {
  'use strict';

  const CONFIG = {
    MAX_CONCURRENT: 6,
    JPEG_QUALITY: 1.0
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("jumptoon-dl:convert-jpeg") === '1',
    chapterData: null,
    ui: null,
    lastCleanUrl: "",
    lastEpisodeKey: ""
  };

  /* =========================================================================
   * 1. GIAO DIỆN UNIVERSAL UI
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "jumptoon-dl",
        title: "ジャンプTOON",
        engine: "SHUEISHA",
        themeColor: "#e5283b",
        themeBg: "#18181b",
        titleColor: "#ffffff",
        btnBg: "#e5283b",
        btnColor: "#ffffff",
        topOffset: "96px",
        defaultJpgText: "Xuất file JPG (mặc định PNG)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("jumptoon-dl:convert-jpeg", checked ? '1' : '0');
        }
      };

      state.ui = createUI(uiConfig);
      state.ui.setBusy(true);

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
   * 2. BỘ LỌC ĐỊNH TUYẾN URL THÔNG MINH
   * ========================================================================= */
  function getCurrentContext() {
    const p = WIN.location.pathname;
    const s = WIN.location.search;

    if (p === '/' || p === '') return { isReader: false };
    if (s.includes('type=episodes') || s.includes('type=comics')) return { isReader: false };
    if (/\/series\/[^\/]+\/episodes\/?$/.test(p) || /\/series\/[^\/]+\/comics\/?$/.test(p)) return { isReader: false };

    const sMatch = p.match(/\/series\/([A-Za-z0-9_-]+)/);
    const seriesId = sMatch ? sMatch[1] : null;

    const epMatch = p.match(/\/episodes\/(\d+)/);
    const episodeId = epMatch ? epMatch[1] : null;
    const isTrial = p.includes('/trial/');

    return {
      isReader: Boolean(seriesId),
      seriesId,
      episodeId,
      isTrial
    };
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

  function unescapeRscString(str) {
    if (!str) return '';
    return str.replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
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
    return `Jumptoon_${fallbackId}`;
  }

  /* =========================================================================
   * 3. BÓC TÁCH DỮ LIỆU CÓ KHÓA ID HAI CHIỀU (BRACKET PARSER)
   * ========================================================================= */
  function extractObjectByKey(cleanStr, keyName) {
    const keyStr = `"${keyName}":`;
    const idx = cleanStr.indexOf(keyStr);
    if (idx === -1) return null;
    const braceStart = cleanStr.indexOf('{', idx + keyStr.length);
    if (braceStart === -1) return null;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = braceStart; i < cleanStr.length; i++) {
      const ch = cleanStr[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }

      if (!inString) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            const jsonStr = cleanStr.slice(braceStart, i + 1);
            try {
              return JSON.parse(jsonStr);
            } catch (e) {
              return null;
            }
          }
        }
      }
    }
    return null;
  }

  function parseRscChunk(rawStr, ctx) {
    if (!rawStr || !rawStr.includes('pageList')) return null;

    try {
      const clean = rawStr.replace(/\\"/g, '"').replace(/\\u0026/g, '&');

      // PHÂN LẬP KEY THEO ĐÚNG NGỮ CẢNH TRANG ĐANG XEM:
      let candidateKeys = [];
      if (ctx.isTrial) {
        // Đang ở Tankobon Trial -> CHỈ LẤY seriesComicsContent (Chưa rõ purchased sẽ là gì)
        candidateKeys = ['seriesComicsContent'];
      } else if (ctx.episodeId) {
        // Đang ở trang đọc Chap chính thức -> CHỈ LẤY seriesEpisodeContent (CẤM LẤY previewContent!)
        candidateKeys = ['seriesEpisodeContent'];
      } else {
        // Đang ở trang Series -> MỚI ĐƯỢC LẤY previewContent
        candidateKeys = ['previewContent'];
      }

      for (const k of candidateKeys) {
        if (clean.includes(`"${k}"`)) {
          const content = extractObjectByKey(clean, k);
          if (content?.pageList && Array.isArray(content.pageList) && content.pageList.length > 0) {
            // Khóa ID truyện
            if (content.seriesId && ctx.seriesId && String(content.seriesId) !== String(ctx.seriesId)) {
              continue;
            }
            if (ctx.episodeId && content.id && String(content.id) !== String(ctx.episodeId)) {
              continue;
            }
            return content;
          }
        }
      }
    } catch (e) {}
    return null;
  }

  async function resolveFreshContent(ctx) {
    const scripts = Array.from(DOC.querySelectorAll('script'));
    for (const s of scripts) {
      const txt = s.textContent || '';
      if (txt.includes('pageList')) {
        const parsed = parseRscChunk(txt, ctx); // Truyền ctx vào đây
        if (parsed) return parsed;
      }
    }

    // Nếu script DOM không có (vì vừa chuyển từ Series vào Chap), tự động kéo ?_rsc=1 tươi mới
    try {
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const rscUrl = `${WIN.location.pathname}?_rsc=1`;
      const buf = await Utils.fetchBuffer(rscUrl, { 'RSC': '1', 'Referer': WIN.location.href });
      const txt = new TextDecoder().decode(buf);
      const parsed = parseRscChunk(txt, ctx); // Truyền ctx vào đây
      if (parsed) return parsed;
    } catch (e) {}

    return null;
  }

  async function syncChapterData() {
    const ctx = getCurrentContext();
    if (!ctx.isReader) return null;

    const content = await resolveFreshContent(ctx);
    if (!content || !content.pageList || !content.pageList.length) return null;

    const Tools = WIN.JumptoonTools || window.JumptoonTools;
    const seed = Tools.computeSeed(content.seriesId, content.number || '1');
    const algoType = content.scrambleAlgorithmType || 'V2';

    let episodeName = "";

    // 1. Nếu ở trang Tankobon Comics Trial (/trial/)
    if (ctx.isTrial) {
      episodeName = `第${content.number || 1}巻 (Trial)`;
    }
    // 2. Nếu ở trang Series (không có /episodes/) -> ĐÂY LÀ BẢN PREVIEW CHAP 1!
    else if (!ctx.episodeId) {
      const epNum = content.number || 1;
      const epSubTitle = content.seriesEpisodeEdge?.node?.title || "";
      // Gắn nhãn (Preview) đảm bảo 100% luôn chạy vào đây khi tải từ trang Series:
      episodeName = `第${epNum}話 ${epSubTitle} (Preview)`.replace(/\s{2,}/g, ' ').trim();
    }
    // 3. Nếu ở trang đọc chap chính thức (/episodes/...) -> Lấy tên chap đầy đủ
    else if (content.seriesEpisodeEdge?.node) {
      const node = content.seriesEpisodeEdge.node;
      episodeName = `${node.notation || `第${content.number || 1}話`} ${node.title || ''}`.trim();
    } else {
      episodeName = `第${content.number || 1}話`;
    }

    // Lấy tên truyện sạch từ h1/h2
    let seriesTitle = "";

    // 1. Nếu đang ở trang đọc chap (/episodes/): Tên truyện nằm trong thẻ meta title (gọt bỏ 【第X話】 và | ジャンプTOON)
    if (ctx.episodeId) {
      const metaTitle = DOC.querySelector('meta[property="og:title"]')?.getAttribute('content') || DOC.title || "";
      seriesTitle = metaTitle.split(/[|｜]/)[0].replace(/^【.*?】\s*/g, '').trim();
    } 
    // 2. Nếu đang ở trang Series: Tên truyện nằm ở h1/h2 của trang
    else {
      seriesTitle = DOC.querySelector('h1, h2')?.textContent?.trim() || "";
      if (!seriesTitle) {
        const metaTitle = DOC.querySelector('meta[property="og:title"]')?.getAttribute('content') || DOC.title || "";
        seriesTitle = metaTitle.split(/[|｜]/)[0].replace(/^【.*?】\s*/g, '').trim();
      }
    }

    return {
      seriesTitle,
      episodeTitle: episodeName,
      episodeId: `${content.seriesId}_${content.number || '1'}`,
      seed,
      algoType,
      pages: content.pageList
    };
  }

  /* =========================================================================
   * 4. GIẢI MÃ MA TRẬN DẢI DỌC TRÊN CANVAS
   * ========================================================================= */
  async function descrambleJumptoonPage(rawBuffer, pageObj, seed, algoType, pageNo, isJpg) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    const Tools = WIN.JumptoonTools || window.JumptoonTools;

    const rawExt = Utils.detectExt(rawBuffer) || 'webp';
    const img = await Utils.loadImage(rawBuffer, `image/${rawExt}`);

    const rawW = img.naturalWidth || img.width;
    const rawH = img.naturalHeight || img.height;
    const targetW = Number(pageObj.width) || rawW;
    const targetH = Number(pageObj.height) || rawH;

    const geom = Tools.calculateCoords(seed, algoType, targetW, rawW, targetH);

    const canvas = DOC.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = false;
    ctx.mozImageSmoothingEnabled = false;
    ctx.webkitImageSmoothingEnabled = false;
    ctx.msImageSmoothingEnabled = false;

    for (const c of geom.coords) {
      ctx.drawImage(
        img,
        c.srcX, c.srcY, c.width, c.height,
        c.destX, c.destY, c.width, c.height
      );
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
   * 5. TIẾN TRÌNH TẢI CHÍNH (6 LUỒNG SONG SONG TRONG RAM)
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

      const { pages, seriesTitle, episodeTitle, episodeId, seed, algoType } = data;
      const totalPages = pages.length;
      const useJpeg = Boolean(state.convertJpeg);

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      zip.addFile(`${episodeId}.txt`, new Uint8Array(0));

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map((pageObj, idx) => async () => {
        const cleanUrl = unescapeRscString(pageObj.imageUrl);
        const rawBuffer = await Utils.fetchBuffer(cleanUrl, { "Referer": "https://jumptoon.com/" });
        return await descrambleJumptoonPage(rawBuffer, pageObj, seed, algoType, idx + 1, useJpeg);
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
      console.error("[jumptoon-dl] Error:", err);
    } finally {
      state.running = false;
    }
  }

  /* =========================================================================
   * 6. KHỞI CHẠY (BOOT) - ẨN MẶC ĐỊNH & KHÔNG CHỚP NHÁY
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(20);
    const ui = getUI();

    const ctx = getCurrentContext();

    if (!ctx.isReader) {
      if (ui?.panel) ui.panel.style.display = "none";
      return;
    }

    // 1. Phân lập giao diện ban đầu:
    // - Trang đọc chap chính thức (/episodes/ hoặc /trial/): Hiện "Đang kiểm tra..." vì chắc chắn có truyện
    // - Trang Series tổng quan: Tạm thời giấu panel, chỉ hiện khi ĐÃ XÁC NHẬN có preview thật
    if (ctx.episodeId || ctx.isTrial) {
      if (ui?.panel) {
        ui.panel.style.display = "block";
        ui.setBusy(true);
        ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
      }
    } else {
      if (ui?.panel) ui.panel.style.display = "none";
    }

    try {
      state.chapterData = null;

      let data = null;
      let retries = 0;
      const maxRetries = (ctx.episodeId || ctx.isTrial) ? 25 : 8; // Trang series chỉ cần đợi tối đa ~800ms

      while (retries < maxRetries) {
        data = await syncChapterData();
        if (data && data.pages && data.pages.length > 0) break;
        await sleep(100);
        retries++;
      }
      
      // 3. Nếu không có trang truyện nào:
      if (!data || !data.pages || !data.pages.length) {

        if (ctx.episodeId || ctx.isTrial) {
          if (ui?.panel) ui.panel.style.display = "block";
          throw new Error("Không thể trích xuất trang truyện hoặc chưa mở.");
        }

        if (ui?.panel) ui.panel.style.display = "none";
        return;
      }

      state.chapterData = data;
      if (ui?.panel) ui.panel.style.display = "block";

      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: data.pages.length,
          status: "Sẵn sàng."
        });
        ui.setBusy(false); 
      }
    } catch (err) {
      console.error("[jumptoon-dl] Boot error:", err);
      if (ui) {
        ui.updateProgress({ status: "Lỗi: " + (err?.message || "Không thể tải trang.") });
        ui.setBusy(true); 
      }
    }
  }

  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute((newUrl) => {
      const ctx = getCurrentContext();

      if (!ctx.isReader) {
        const ui = getUI();
        if (ui?.panel) ui.panel.style.display = "none";
        state.chapterData = null;
        state.lastEpisodeKey = "";
        state.lastCleanUrl = "";
        state.running = false;
        return;
      }

      const isExitingFromReader = Boolean(state.lastEpisodeKey && state.lastEpisodeKey.includes('_') && !state.lastEpisodeKey.endsWith('_preview') && !ctx.episodeId && !ctx.isTrial);
      if (isExitingFromReader) {
        const ui = getUI();
        if (ui?.panel) ui.panel.style.display = "none";
        state.chapterData = null;
        state.lastEpisodeKey = "";
        state.lastCleanUrl = "";
        state.running = false;
        return;
      }

      const cleanUrl = newUrl.split('#')[0];
      const currentKey = `${ctx.seriesId}_${ctx.episodeId || (ctx.isTrial ? 'trial' : 'preview')}`;

      if (state.lastEpisodeKey && state.lastEpisodeKey === currentKey && cleanUrl === state.lastCleanUrl) return;

      state.lastCleanUrl = cleanUrl;
      state.lastEpisodeKey = currentKey;
      state.chapterData = null;
      state.running = false;

      const ui = getUI();
      if (ui) {
        ui.setBusy(true); 
        if (!ctx.episodeId && !ctx.isTrial) {
          if (ui.panel) ui.panel.style.display = "none";
        } else {
          ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
        }
      }
      boot();
    });
  }
  boot();
})();