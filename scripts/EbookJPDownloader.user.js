// ==UserScript==
// @name         EbookJapan Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      3.0.0
// @icon         https://ebookjapan.yahoo.co.jp/favicon.ico
// @description  Tải manga trên EbookJapan.
// @author       anonymous & AI
// @match        https://ebookjapan.yahoo.co.jp/bviewer*
// @match        https://ebookjapan.yahoo.co.jp/viewer/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      ebookjapan.yahoo.co.jp
// @connect      prod-contents-br-page.akamaized.net
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/EbookJPDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/EbookJPDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function ebookJapanUniversalDownloader() {
  'use strict';

  const CONFIG = { JPEG_QUALITY: 0.95 };
  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (!WIN.location.pathname.startsWith('/bviewer')) return;

  const FORMATS = {
    png: { extension: "png", type: "image/png" },
    jpg: { extension: "jpg", type: "image/jpeg", quality: CONFIG.JPEG_QUALITY }
  };

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("ej-dl:convert-jpeg") === '1',
    readerData: null,
    pageLoads: new WeakMap(),
    ui: null
  };

  /* =========================================================================
   * MAIN-WORLD BRIDGE (BYPASS ANTI-SCRAPING & GIẢI MÃ WASM)
   * ========================================================================= */
  function ensureMainWorldBridge() {
    if (WIN.__ej_bridge) return true;
    try {
      WIN.eval(`
        (function() {
          // Khôi phục cơ chế lấy hàm xuất ảnh gốc (pristine) bị EbookJapan chặn
          var pristineToDataURL;
          try {
            var iframe = document.createElement('iframe');
            iframe.style.display = 'none';
            document.body.appendChild(iframe);
            pristineToDataURL = iframe.contentWindow.HTMLCanvasElement.prototype.toDataURL;
            document.body.removeChild(iframe);
          } catch(e) {}

          window.__ej_bridge = {
            render: function(dataUrl, w, h, loader, pageObj, pageIndex, mimeType, quality, openParamArgs) {
              return new Promise(function(resolve, reject) {
                var img = new Image();
                img.decoding = 'async';
                img.onload = function() {
                  try {
                    var useOffscreen = typeof OffscreenCanvas === 'function' && typeof OffscreenCanvas.prototype.convertToBlob === 'function';
                    var canvas = useOffscreen ? new OffscreenCanvas(w, h) : document.createElement('canvas');
                    if (!useOffscreen) { canvas.width = w; canvas.height = h; }
                    
                    var ctx = canvas.getContext('2d', { alpha: false });
                    ctx.imageSmoothingEnabled = false;
                    ctx.mozImageSmoothingEnabled = false;
                    ctx.webkitImageSmoothingEnabled = false;
                    ctx.msImageSmoothingEnabled = false;

                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, 0, w, h);

                    if (openParamArgs && loader?.funcs?.openParam) {
                      try { loader.funcs.openParam(openParamArgs); } catch (e) {}
                    }

                    loader.shuffle({ ctx: ctx, x: 0, y: 0, data: { image: img }, autographed: pageObj.autographed, page: pageIndex });

                    if (useOffscreen) {
                      var opts = { type: mimeType };
                      if (typeof quality === 'number') opts.quality = quality;
                      canvas.convertToBlob(opts).then(function(blob) {
                        var reader = new FileReader();
                        reader.onload = function() { resolve(reader.result); };
                        reader.onerror = reject;
                        reader.readAsArrayBuffer(blob);
                      }).catch(reject);
                    } else {
                      // Fallback an toàn thay cho toBlob bị lỗi
                      var toData = pristineToDataURL || HTMLCanvasElement.prototype.toDataURL;
                      var dataUri = toData.call(canvas, mimeType, quality);
                      var byteString = atob(dataUri.split(',')[1]);
                      var ab = new ArrayBuffer(byteString.length);
                      var ia = new Uint8Array(ab);
                      for (var i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
                      resolve(ab);
                    }
                  } catch (err) { reject(err); }
                };
                img.onerror = reject;
                img.src = dataUrl;
              });
            }
          };
        })();
      `);
      return true;
    } catch (e) {
      console.error('[ej-dl] Lỗi khởi tạo Main-World Bridge:', e);
      return false;
    }
  }

  /* =========================================================================
   * GIAO DIỆN UNIVERSAL UI CHUẨN V2.1
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "ej-dl",
        title: "EbookJapan",
        engine: "YAHOO",
        themeColor: "#F8485E",
        themeBg: "#ffffff",
        titleColor: "#F8485E",
        topOffset: "60px",
        defaultJpgText: "Xuất file JPG (mặc định PNG)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("ej-dl:convert-jpeg", checked ? '1' : '0');
        }
      };

      state.ui = createUI(uiConfig);

      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:${uiConfig.titleColor};letter-spacing:0.2px;">${uiConfig.title}</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:1px;visibility:hidden;">${uiConfig.engine}</div>
          `;
        }
      }
    }
    return state.ui;
  }

  /* =========================================================================
   * BỘ XỬ LÝ CHUỖI & TÊN FILE [Tên Truyện] - [Tên Chap]
   * ========================================================================= */
  function cleanString(str) {
    if (!str || typeof str !== 'string') return '';
    return str.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').replace(/【[^】]*】/g, '').replace(/[\\/*?:"<>|]/g, '').trim();
  }

  function getBookCode(validPages = []) {
    try {
      if (Array.isArray(validPages)) {
        for (const p of validPages) {
          const rawSrc = p.data?.currentSrc || p.data?.src || '';
          const match = rawSrc.match(/([A-Za-z0-9]+)-\d+\.(?:jpg|png|webp|jpeg)/i);
          if (match?.[1]) return match[1].toUpperCase();
        }
      }
      const url = new URL(WIN.location.href);
      const code = url.searchParams.get("code") || url.pathname.split('/').filter(Boolean).pop() || '';
      const match = code.match(/([A-Za-z0-9]+)/);
      if (match?.[1]) return match[1].toUpperCase();
    } catch {}
    return "EBOOKJAPAN_BOOK";
  }

  function getCleanTitle() {
    let mangaTitle = "", chapterTitle = "";
    try {
      const reader = state.readerData?.reader || findReader();
      if (reader) {
        const pd = reader.paperDesign || reader.loader || {};
        mangaTitle = pd.seriesTitle || pd.title || pd.bookTitle || "";
        chapterTitle = pd.volumeName || pd.name || "";
      }

      let nuxtEl = null;
      const docs = [DOC];
      try { if (WIN.parent?.document) docs.push(WIN.parent.document); } catch {}
      try { if (WIN.top?.document) docs.push(WIN.top.document); } catch {}

      for (const d of docs) {
        nuxtEl = d.getElementById("__NUXT_DATA__");
        if (nuxtEl) break;
      }

      if (nuxtEl?.textContent && (!mangaTitle || !chapterTitle)) {
        const arr = JSON.parse(nuxtEl.textContent);
        if (Array.isArray(arr)) {
          const resolve = x => (typeof x === "number" && arr[x] !== undefined) ? arr[x] : x;
          for (const item of arr) {
            if (item && typeof item === "object" && (item.publicationCd !== undefined || item.goods !== undefined)) {
              const nameStr = resolve(item.name);
              const volStr = resolve(item.volumeName);
              const titleObj = resolve(item.title);
              const titleStr = (titleObj && typeof titleObj === "object") ? resolve(titleObj.name) : resolve(titleObj);
              if (!mangaTitle && typeof titleStr === "string") mangaTitle = titleStr;
              if (!chapterTitle && typeof volStr === "string") chapterTitle = volStr;
              if (!chapterTitle && typeof nameStr === "string") chapterTitle = nameStr;
            }
          }
        }
      }

      mangaTitle = cleanString(mangaTitle);
      chapterTitle = cleanString(chapterTitle);

      if (mangaTitle && chapterTitle && chapterTitle.startsWith(mangaTitle)) {
        chapterTitle = cleanString(chapterTitle.substring(mangaTitle.length).replace(/^[\s\-_:：]+/, ''));
      }

      if (mangaTitle && chapterTitle) return `${mangaTitle} - ${chapterTitle}`;
      if (mangaTitle) return mangaTitle;
    } catch {}
    return `EbookJapan_${getBookCode()}`;
  }

  function ensureSinglePageVerticalMode() {
    try {
      const rawCfg = WIN.localStorage.getItem("brconfig");
      const cfg = rawCfg ? JSON.parse(rawCfg) : {};
      if (!cfg.viewer) cfg.viewer = {};
      cfg.viewer.spread = false;
      cfg.viewer.vertical = true;
      cfg.viewer.divid = 0;
      WIN.localStorage.setItem("brconfig", JSON.stringify(cfg));
    } catch {}
  }

  /* =========================================================================
   * REACT FIBER TRAVERSAL (TRÍCH XUẤT INSTANCE TRONG RAM)
   * ========================================================================= */
  function extractReaderFromFiber(domNode) {
    if (!domNode) return null;
    const fiberKey = Object.keys(domNode).find(k => k.startsWith("__reactFiber"));
    let fiber = fiberKey ? domNode[fiberKey] : null;

    for (let depth = 0; fiber && depth < 50; fiber = fiber.return, depth++) {
      let mem = fiber.memoizedState;
      for (let hDepth = 0; mem && hDepth < 80; mem = mem.next, hDepth++) {
        const candidate = mem.memoizedState;
        if (candidate && typeof candidate === "object" && candidate.loader?.pages && candidate.paperDesign) {
          return candidate;
        }
      }
    }
    return null;
  }

  function findReader() {
    for (const canvas of DOC.querySelectorAll("canvas")) {
      const r = extractReaderFromFiber(canvas);
      if (r) return r;
    }
    return null;
  }

  function filterValidPages(reader = findReader()) {
    const pages = reader?.loader?.pages;
    if (!Array.isArray(pages)) return [];
    return pages.filter(p => p && !p.isInvalidPage && Number(p.width) > 0 && Number(p.height) > 0 && typeof p.loader?.shuffle === "function")
                .sort((a, b) => (Number(a.page) || 0) - (Number(b.page) || 0));
  }

  async function waitForReaderAndPages(timeoutMs = 45000) {
    if (state.readerData?.pages?.length > 0) return state.readerData;
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const reader = findReader();
      const pages = filterValidPages(reader);
      if (reader && pages.length > 0) {
        state.readerData = { reader, pages };
        return state.readerData;
      }
      await sleep(200);
    }
    throw new Error("Không tìm thấy reader của EbookJapan.");
  }

  /* =========================================================================
   * BỘ TẢI ẢNH & PRELOAD NGẦM (BACKGROUND LAZY-LOAD)
   * ========================================================================= */
  function ensurePageImageLoaded(pageObj, timeoutMs = 20000) {
    if (!pageObj) return Promise.reject(new Error("Thiếu trang Viewer."));
    let loadPromise = state.pageLoads.get(pageObj);

    if (!loadPromise) {
      loadPromise = (async () => {
        try {
          if ((!pageObj.done || (!pageObj.data && !pageObj.bmp)) && typeof pageObj.getImage === "function") {
            const p = pageObj.getImage();
            if (p?.then) await p;
          }

          const start = Date.now();
          while (Date.now() - start < timeoutMs) {
            if (pageObj.data?.currentSrc || pageObj.data?.src) return pageObj;
            await sleep(50);
          }

          if (!pageObj.data && !pageObj.bmp) throw new Error(`Không nạp được URL trang ${(Number(pageObj.page) || 0) + 1}`);
          return pageObj;
        } catch (err) {
          state.pageLoads.delete(pageObj);
          throw err;
        }
      })();
      state.pageLoads.set(pageObj, loadPromise);
    }
    return loadPromise;
  }

  function preloadUpcomingPages(pagesList, startIndex) {
    const limit = Math.min(pagesList.length, startIndex + 4);
    for (let i = startIndex; i < limit; i++) ensurePageImageLoaded(pagesList[i]).catch(() => {});
  }

  function fetchRawImageBuffer(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: url,
        responseType: "arraybuffer",
        timeout: 30000,
        headers: { 'Referer': WIN.location.href, 'Origin': WIN.location.origin },
        onload: res => (res.status >= 200 && res.status < 300 && res.response) ? resolve(res.response) : reject(new Error(`HTTP ${res.status}`)),
        onerror: () => reject(new Error("Lỗi mạng")),
        ontimeout: () => reject(new Error("Timeout tải ảnh"))
      });
    });
  }

  function arrayBufferToDataUrl(buffer, mimeType = 'image/webp') {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i += 16384) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 16384, len)));
    }
    return `data:${mimeType};base64,${btoa(binary)}`;
  }

  /* =========================================================================
   * THUẬT TOÁN ĐÀM PHÁN KÍCH THƯỚC & GIẢI MÃ WASM
   * ========================================================================= */
  function buildOpenParamArgs(loader, overrides = {}) {
    const dpr = Number(WIN.devicePixelRatio) || 1;
    const availH = Number(WIN.screen?.availHeight) || Number(WIN.innerHeight) || 1200;
    return {
      dpr,
      limit: Math.floor(availH * dpr * (Number(loader?.resizeThreashold) || 1.25)),
      size: Number(loader?.resizeMax) || 1200,
      flag: Number(loader?.forceResize) || 0,
      ...overrides
    };
  }

  function getTargetProfile(pageObj) {
    const loader = pageObj?.loader;
    const curSrc = pageObj.data?.currentSrc || pageObj.data?.src || '';
    const fullSrc = curSrc.replace(/_s(\.[a-z0-9]+)(?=([?#]|$))/i, '$1');
    const pIdx = Number(pageObj.page) || 0;

    if (curSrc && fullSrc && fullSrc !== curSrc && typeof loader?.funcs?.openParam === "function") {
      try {
        const baseArgs = buildOpenParamArgs(loader);
        const fullArgs = buildOpenParamArgs(loader, { flag: 1 });
        const res = loader.funcs.openParam(fullArgs);
        const pInfo = res?.pages?.[pIdx];
        const w = Math.floor(Number(pInfo?.width) || 0);
        const h = Math.floor(Number(pInfo?.height) || 0);
        loader.funcs.openParam(baseArgs);
        if (w > 0 && h > 0) return { url: fullSrc, width: w, height: h, args: fullArgs };
      } catch {}
    }

    const w = Number(pageObj.width) || Number(pageObj.bmp?.width) || Number(pageObj.data?.width) || 1200;
    const h = Number(pageObj.height) || Number(pageObj.bmp?.height) || Number(pageObj.data?.height) || 1800;
    return {
      url: curSrc,
      width: Math.floor(w),
      height: Math.floor(h),
      args: typeof loader?.funcs?.openParam === "function" ? buildOpenParamArgs(loader) : null
    };
  }

  async function descramblePage(pageObj, targetFormat) {
    ensureMainWorldBridge();
    const prof = getTargetProfile(pageObj);
    const pIdx = Number(pageObj.page) || 0;

    const buffer = await fetchRawImageBuffer(prof.url);
    const dataUrl = arrayBufferToDataUrl(buffer, 'image/webp');

    return await WIN.__ej_bridge.render(
      dataUrl,
      prof.width,
      prof.height,
      pageObj.loader,
      pageObj,
      pIdx,
      targetFormat.type,
      targetFormat.quality,
      prof.args
    );
  }

  /* =========================================================================
   * TIẾN TRÌNH TẢI CHÍNH
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });

      const { pages } = await waitForReaderAndPages();
      const totalPages = pages.length;
      if (!totalPages) throw new Error("Không có trang hợp lệ.");

      const useJpeg = Boolean(state.convertJpeg);
      const targetFormat = useJpeg ? FORMATS.jpg : FORMATS.png;
      const fileExt = targetFormat.extension;

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const zip = new ZipClass();

      // File TXT rỗng định danh mã sách tại root ZIP
      const bookCode = getBookCode(pages);
      zip.addFile(`${bookCode}.txt`, new Uint8Array(0));

      const mangaTitle = getCleanTitle();
      preloadUpcomingPages(pages, 0);

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      let savedCount = 0;

      for (let i = 0; i < totalPages; i++) {
        const pageObj = pages[i];
        preloadUpcomingPages(pages, i + 1);

        await ensurePageImageLoaded(pageObj);

        const arrayBuffer = await descramblePage(pageObj, targetFormat);
        zip.addFile(`${i + 1}.${fileExt}`, new Uint8Array(arrayBuffer));
        savedCount++;

        if (ui) {
          ui.updateProgress({
            completed: i + 1,
            total: totalPages,
            status: "Đang tải..."
          });
        }

        await sleep(30);
      }

      if (savedCount === 0) throw new Error("Lỗi nén ảnh vào ZIP.");

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      zip.download(`${mangaTitle}.zip`);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || String(err)) });
      console.error("[ej-dl] Download failed:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * KHỞI TẠO VÀ BOOT
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(30);
    ensureSinglePageVerticalMode();
    const ui = getUI();

    if (ui?.panel) ui.panel.style.display = "block";
    if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });

    try {
      const { pages } = await waitForReaderAndPages();
      if (ui) ui.updateProgress({ completed: 0, total: pages.length, status: "Sẵn sàng." });
    } catch {
      if (ui) ui.updateProgress({ status: "Sẵn sàng." });
    }
  }

  if (DOC.readyState === "loading") {
    DOC.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();