// ==UserScript==
// @name         Alphapolis Manga Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://www.alphapolis.co.jp/favicon.ico
// @description  Tải manga trên Alphapolis (alphapolis.co.jp)
// @author       anonymous & AI
// @match        https://www.alphapolis.co.jp/manga/*
// @match        https://alphapolis.co.jp/manga/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      www.alphapolis.co.jp
// @connect      *.alphapolis.co.jp
// @connect      alphapolis.co.jp
// @connect      cdn-image.alphapolis.co.jp
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/decoders/AlphapolisTools.js
// ==/UserScript==

(function alphapolisUniversalDownloader() {
  'use strict';

  const CONFIG = {
    MAX_CONCURRENT: 6,
    JPEG_QUALITY: 0.95
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("alphapolis-dl:convert-jpeg") === '1',
    chapterData: null,
    ui: null
  };

  /* =========================================================================
   * 1. GIAO DIỆN UNIVERSAL UI
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "alphapolis-dl",
        title: "Alphapolis",
        engine: "ALPHAPOLIS",
        themeColor: "#F6A826",
        themeBg: "#ffffff",
        titleColor: "#18181b",
        btnBg: "#F6A826",
        btnColor: "#ffffff",
        topOffset: "72px",
        defaultJpgText: "Xuất file JPG (mặc định PNG)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("alphapolis-dl:convert-jpeg", checked ? '1' : '0');
        }
      };

      state.ui = createUI(uiConfig);

      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:${uiConfig.titleColor};letter-spacing:0.2px;">${uiConfig.title}</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px;visibility:hidden">${uiConfig.engine}</div>
          `;
        }
      }
    }
    return state.ui;
  }

  /* =========================================================================
   * 2. BỘ HỖ TRỢ XỬ LÝ URL & TIÊU ĐỀ
   * ========================================================================= */
  function isEpisodeUrl() {
    const p = WIN.location.pathname;
    return /\/manga\/(?:official\/)?\d+\/\d+/.test(p) || /\/manga\/\d+\/episode\/\d+/.test(p);
  }

  function getUrlParams() {
    const pathParts = WIN.location.pathname.split('/').filter(Boolean);
    const chapterId = parseInt(pathParts.at(-1), 10);
    let mangaId = parseInt(pathParts.at(-2), 10);

    if (pathParts.includes('episode')) {
      mangaId = parseInt(pathParts[pathParts.indexOf('episode') - 1], 10);
    }
    return { chapterId, mangaId };
  }

  function getCookie(name) {
    const value = `; ${DOC.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return decodeURIComponent(parts.pop().split(';').shift());
    return null;
  }

  function cleanPart(str) {
    if (!str) return "";
    return str
      .replace(/[\r\n\t]+/g, '')
      // CHỈ lọc tag quảng cáo khuyến mãi, GIỮ NGUYÊN dấu cách tiếng Nhật \u3000 và ngoặc 【...】
      .replace(/【(?:期間限定|無料|試し読み|お試し|特別|デジタル版限定特典|単話).*?】/gi, '')
      // Lọc thông tin tác giả trong ngoặc tròn ở cuối: (貝原黎音/漫画 柊彼方/原作)
      .replace(/\s*\([^)]*(?:漫画|原作|作画|著|イラスト)[^)]*\)/g, '')
      // Chặn các nút điều hướng nếu bắt nhầm
      .replace(/^(?:前の話|次の話|目次|TOP)\s*/gi, '')
      // Lọc ký tự cấm của hệ điều hành: \ / * ? : " < > |
      .replace(/[\\/*?:"<>|]/g, '')
      .trim();
  }

  function getCleanTitle(manifestSeriesTitle, manifestEpisodeTitle) {
    let seriesTitle = "";
    let episodeTitle = "";

    // 1. Lấy từ thẻ meta của server (chứa đầy đủ tên truyện và tên chap có subtitle)
    const metaTitle = DOC.querySelector('meta[property="og:title"]')?.getAttribute('content')
                   || DOC.querySelector('meta[name="twitter:title"]')?.getAttribute('content')
                   || (DOC.title.includes('|') ? DOC.title : "");

    if (metaTitle) {
      // Lọc bỏ phần đuôi thương hiệu Alphapolis
      const parts = metaTitle.split(/[|｜]/).map(p => p.trim()).filter(Boolean);
      const filtered = parts.filter(p => !/(?:公式Web漫画|Web漫画|アルファポリス|Alphapolis)/i.test(p));

      // TRƯỜNG HỢP A: Tên truyện và Tên chap nằm chung 1 chuỗi (ngăn cách bằng khoảng trắng trước 第...話/回)
      const targetStr = filtered[0] || "";
      const epMatch = targetStr.match(/^(.*?)(?:[\s\u3000]+)((?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\.]+\s*(?:話|回|巻|章|節|部|エピソード|分冊版|単話).*)$/i);

      if (epMatch) {
        seriesTitle = cleanPart(epMatch[1]);
        episodeTitle = cleanPart(epMatch[2]);
      } else if (filtered.length >= 2) {
        // TRƯỜNG HỢP B: Tách biệt qua dấu |
        const p0 = cleanPart(filtered[0]);
        const p1 = cleanPart(filtered[1]);
        const p0HasEp = /(?:第\s*[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\.]+\s*(?:話|回|巻|章|節|部|エピソード|分冊版|単話)|^[#＃]?\d+)/.test(p0);

        if (p0HasEp) {
          episodeTitle = p0;
          seriesTitle = p1;
        } else {
          seriesTitle = p0;
          episodeTitle = p1;
        }
      }
    }

    // Chặn triệt để nút điều hướng "前の話" nếu bộ lọc trước bị lọt
    if (seriesTitle === "前の話" || seriesTitle === "次の話") seriesTitle = "";

    // 2. Dự phòng quét DOM
    if (!seriesTitle) {
      const sEl = DOC.querySelector('.manga-title, .series-title, .c-manga-detail__title, header h1');
      if (sEl) seriesTitle = cleanPart(sEl.textContent);
    }

    if (!seriesTitle) seriesTitle = cleanPart(manifestSeriesTitle);
    if (!episodeTitle) episodeTitle = cleanPart(manifestEpisodeTitle);

    const { chapterId } = getUrlParams();
    const fallbackId = String(chapterId || "Episode");

    if (seriesTitle && episodeTitle && !seriesTitle.includes(episodeTitle)) {
      return `${seriesTitle} - ${episodeTitle}`;
    } else if (seriesTitle && episodeTitle) {
      return episodeTitle;
    } else if (seriesTitle) {
      return `${seriesTitle} - ${fallbackId}`;
    }
    return `Alphapolis_${fallbackId}`;
  }

  /* =========================================================================
   * 3. BÓC TÁCH DỮ LIỆU TỪ VIEWER.JSON
   * ========================================================================= */
  async function fetchAlphapolisManifest() {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    const Tools = window.AlphapolisTools || globalThis.AlphapolisTools;

    const { chapterId, mangaId } = getUrlParams();
    if (!chapterId || isNaN(chapterId)) throw new Error("Không thể xác định chapterId từ URL.");

    const xsrfToken = getCookie('XSRF-TOKEN');
    const csrfMeta = DOC.querySelector('meta[name="csrf-token"]')?.getAttribute('content');

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest'
    };
    if (xsrfToken) headers['X-XSRF-TOKEN'] = xsrfToken;
    if (csrfMeta) headers['X-CSRF-TOKEN'] = csrfMeta;

    const apiUrl = WIN.location.pathname.includes('/official/')
      ? 'https://www.alphapolis.co.jp/manga/official/viewer.json'
      : `https://www.alphapolis.co.jp${WIN.location.pathname}/viewer.json`;

    const payload = JSON.stringify({
      episode_no: chapterId,
      manga_sele_id: mangaId,
      hide_page: false,
      preview: false,
      resolution: 'full_hd'
    });

    let rawJson = null;
    try {
      const res = await WIN.fetch(apiUrl, {
        method: 'POST',
        headers: headers,
        credentials: 'include',
        body: payload
      });
      if (res.ok) rawJson = await res.json();
    } catch (e) {}

    if (!rawJson) {
      rawJson = await new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'POST',
          url: apiUrl,
          headers: headers,
          data: payload,
          timeout: 20000,
          onload: res => {
            if (res.status >= 200 && res.status < 300) {
              try { resolve(JSON.parse(res.responseText)); } catch (err) { reject(err); }
            } else {
              reject(new Error(`HTTP ${res.status}`));
            }
          },
          onerror: () => reject(new Error("Lỗi mạng khi gọi viewer.json")),
          ontimeout: () => reject(new Error("Timeout khi gọi viewer.json"))
        });
      });
    }

    const imagesData = rawJson?.page?.images;
    const placeholder = rawJson?.page?.placeholder;

    if (!imagesData || !Array.isArray(imagesData) || imagesData.length === 0) {
      throw new Error("API không trả về danh sách ảnh hợp lệ.");
    }

    const keys = Tools.extractKeys(placeholder);
    const pages = imagesData.map((img, idx) => ({
      pageNo: idx + 1,
      url: img.url,
      keyBytes: keys ? keys[idx] : null
    }));

    return {
      chapterId: String(chapterId),
      mangaId: String(mangaId),
      seriesTitle: rawJson.manga?.title || rawJson.manga_title || "",
      episodeTitle: rawJson.episode?.title || rawJson.title || "",
      pages: pages
    };
  }

  /* =========================================================================
   * 4. WORKER NGẦM CÔ LẬP GIẢI MÃ BẰNG OFFSCREENCANVAS & IMAGEBITMAP
   * ========================================================================= */
  const workerScript = `
    self.onmessage = async function(e) {
      try {
        const { buffer, keyBytes, isJpg, quality } = e.data;
        if (!keyBytes || keyBytes.byteLength < 8) {
          self.postMessage({ success: true, buffer: buffer, ext: isJpg ? 'jpg' : 'png' }, [buffer]);
          return;
        }

        const blob = new Blob([buffer]);
        const img = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
        const key = new DataView(keyBytes.buffer, keyBytes.byteOffset, keyBytes.byteLength);

        const firstValue = key.getInt32(0, true);
        const secondValue = key.getInt32(4, true);
        const tileSize = (secondValue >>> 24) & 0xFF;
        const paddingWidth = (firstValue >>> 27) & 7;

        if (tileSize === 0) {
          self.postMessage({ success: true, buffer: buffer, ext: isJpg ? 'jpg' : 'png' }, [buffer]);
          return;
        }

        const cols = Math.ceil(img.width / tileSize);
        const rows = Math.ceil(img.height / tileSize);
        const doublePadding = paddingWidth * 2;
        const baseTileSize = tileSize - doublePadding;
        const outW = img.width - (cols * doublePadding);
        const outH = img.height - (rows * doublePadding);
        const lastCol = cols - 1;
        const lastRow = rows - 1;

        const canvas = new OffscreenCanvas(outW, outH);
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.imageSmoothingEnabled = false;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, outW, outH);

        const tileCount = Math.floor(key.byteLength / 8);
        for (let idx = 0; idx < tileCount; idx++) {
          const offset = idx * 8;
          const tileConfigV = key.getInt32(offset, true);
          const tileConfigHa = key.getInt32(offset + 4, true);

          const isMirrored = (tileConfigV & 1) !== 0;
          const rotationSteps = (tileConfigV >>> 1) & 3;
          const destTop = (tileConfigV >>> 3) & 4095;
          const destLeft = (tileConfigV >>> 15) & 4095;
          const sourceRow = (tileConfigHa >>> 8) & 0xFF;
          const sourceCol = (tileConfigHa >>> 16) & 0xFF;

          const currentTileWidth = (baseTileSize !== 0 && Math.floor(destLeft / baseTileSize) === lastCol ? outW - destLeft : baseTileSize) + doublePadding;
          const currentTileHeight = (baseTileSize !== 0 && Math.floor(destTop / baseTileSize) === lastRow ? outH - destTop : baseTileSize) + doublePadding;

          const drawWidth = (rotationSteps % 2 === 1) ? currentTileHeight : currentTileWidth;
          const drawHeight = (rotationSteps % 2 === 1) ? currentTileWidth : currentTileHeight;

          const drawX = destLeft - paddingWidth;
          const drawY = destTop - paddingWidth;

          const sourceX = Math.max(0, Math.min(sourceCol * tileSize, img.width));
          const sourceY = Math.max(0, Math.min(sourceRow * tileSize, img.height));
          const cropWidth = Math.max(0, Math.min(drawWidth, img.width - sourceX));
          const cropHeight = Math.max(0, Math.min(drawHeight, img.height - sourceY));

          if (cropWidth <= 0 || cropHeight <= 0) continue;

          ctx.save();
          ctx.translate(drawX + drawWidth / 2, drawY + drawHeight / 2);
          ctx.rotate(-90 * rotationSteps * Math.PI / 180);
          if (isMirrored) ctx.scale(-1, 1);
          ctx.drawImage(img, sourceX, sourceY, cropWidth, cropHeight, -cropWidth / 2, -cropHeight / 2, cropWidth, cropHeight);
          ctx.restore();
        }

        const mimeType = isJpg ? 'image/jpeg' : 'image/png';
        const encodeOpts = { type: mimeType };
        if (isJpg) encodeOpts.quality = quality;

        const finalBlob = await canvas.convertToBlob(encodeOpts);
        const ab = await finalBlob.arrayBuffer();
        self.postMessage({ success: true, buffer: ab, ext: isJpg ? 'jpg' : 'png' }, [ab]);
      } catch (err) {
        self.postMessage({ success: false, error: err.message || String(err) });
      }
    };
  `;

  let workerUrl = null;
  function getWorkerUrl() {
    if (!workerUrl) {
      const blob = new Blob([workerScript], { type: 'application/javascript' });
      workerUrl = URL.createObjectURL(blob);
    }
    return workerUrl;
  }

  function renderInWorker(rawBuffer, keyBytes, isJpg, quality) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(getWorkerUrl());
      worker.onmessage = (e) => {
        worker.terminate();
        if (e.data.success) resolve(e.data);
        else reject(new Error(e.data.error || "Lỗi giải mã trong Worker"));
      };
      worker.onerror = (err) => {
        worker.terminate();
        reject(err);
      };
      worker.postMessage({ buffer: rawBuffer, keyBytes, isJpg, quality });
    });
  }

  async function processAlphapolisImage(pageObj, isJpg) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;

    // 1. Kéo mảng byte nhị phân trực tiếp bằng GM_xmlhttpRequest
    const rawBuffer = await Utils.fetchBuffer(pageObj.url);

    // 2. Giải mã bằng Worker ngầm (OffscreenCanvas + ImageBitmap)
    const decoded = await renderInWorker(rawBuffer, pageObj.keyBytes, isJpg, CONFIG.JPEG_QUALITY);

    return {
      fileName: `${pageObj.pageNo}.${decoded.ext}`,
      data: new Uint8Array(decoded.buffer)
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
      if (!data) {
        data = await fetchAlphapolisManifest();
        state.chapterData = data;
      }

      const { pages, chapterId, seriesTitle, episodeTitle } = data;
      const totalPages = pages.length;
      if (!totalPages) throw new Error("Không có trang hợp lệ để tải.");

      const useJpeg = Boolean(state.convertJpeg);
      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // File ID định danh .txt ở thư mục gốc
      zip.addFile(`${chapterId}.txt`, new Uint8Array(0));

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map((pageObj) => () => processAlphapolisImage(pageObj, useJpeg));

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
        throw new Error("Không thể trích xuất ảnh nào vào ZIP.");
      }

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      const zipName = `${getCleanTitle(seriesTitle, episodeTitle)}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[alphapolis-dl] Lỗi tải truyện:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * 6. KHỞI CHẠY VÀ THEO DÕI SPA
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

    let data = null;
    let retries = 0;

    while (retries < 25) {
      try {
        data = await fetchAlphapolisManifest();
        if (data && data.pages?.length > 0) break;
      } catch (e) {}
      await sleep(150);
      retries++;
    }

    if (data && data.pages?.length > 0) {
      state.chapterData = data;
      await sleep(80);

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