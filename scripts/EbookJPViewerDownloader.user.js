// ==UserScript==
// @name         EbookJapan Viewer (Liber Nuxt) Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://ebookjapan.yahoo.co.jp/favicon.ico
// @description  Tải manga trên EbookJapan.
// @author       anonymous & AI
// @match        https://ebookjapan.yahoo.co.jp/viewer/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      ebookjapan.yahoo.co.jp
// @connect      prod-contents-br-page.akamaized.net
// @connect      *.akamaized.net
//
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function ebookJapanLiberViewerDownloader() {
  'use strict';

  const CONFIG = {
    PRELOAD_COUNT: 4,      // Số trang mạng kéo trước vào RAM (Sliding Window Pipeline)
    JPEG_QUALITY: 0.95,    // Chất lượng nén khi người dùng chọn xuất JPG
    DECODE_DELAY: 15       // Micro-delay nhường nhịp Event Loop sau mỗi trang (ms)
  };

  const WIN = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const DOC = WIN.document;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  if (!WIN.location.pathname.startsWith('/viewer')) return;

  const state = {
    running: false,
    booting: false,
    convertJpeg: localStorage.getItem("ej-liber-dl:convert-jpeg") === '1',
    ui: null,
    loader: null,
    publication: null,
    totalPages: 0
  };

  /* =========================================================================
   * BỘ XUẤT CANVAS CHỐNG TAINTED & BYPASS PROTOTYPE STRIPPING
   * ========================================================================= */
  const OffscreenClass = WIN.OffscreenCanvas || window.OffscreenCanvas || globalThis.OffscreenCanvas;

  function getPristineCanvasMethods() {
    try {
      const ifr = DOC.createElement('iframe');
      ifr.style.display = 'none';
      DOC.body.appendChild(ifr);
      const pToBlob = ifr.contentWindow?.HTMLCanvasElement?.prototype?.toBlob;
      const pToDataURL = ifr.contentWindow?.HTMLCanvasElement?.prototype?.toDataURL;
      ifr.remove();
      return { toBlob: pToBlob, toDataURL: pToDataURL };
    } catch (e) {
      return {};
    }
  }

  let pristine = null;

  async function canvasToArrayBuffer(canvas, isJpg, quality = 0.95) {
    const mimeType = isJpg ? 'image/jpeg' : 'image/png';

    // 1. Ưu tiên cao nhất: OffscreenCanvas convertToBlob
    if (typeof canvas.convertToBlob === 'function') {
      const opts = { type: mimeType };
      if (isJpg) opts.quality = quality;
      const blob = await canvas.convertToBlob(opts);
      return await blob.arrayBuffer();
    }

    if (!pristine) pristine = getPristineCanvasMethods();

    // 2. Fallback: Pristine toBlob từ iframe ẩn
    const toBlobFn = pristine.toBlob || canvas.toBlob;
    if (typeof toBlobFn === 'function') {
      const blob = await new Promise((resolve, reject) => {
        try {
          toBlobFn.call(canvas, b => b ? resolve(b) : reject(new Error("toBlob null")), mimeType, isJpg ? quality : undefined);
        } catch(e) { reject(e); }
      });
      return await blob.arrayBuffer();
    }

    // 3. Fallback: Pristine toDataURL
    const toDataURLFn = pristine.toDataURL || canvas.toDataURL;
    if (typeof toDataURLFn === 'function') {
      const dataUrl = toDataURLFn.call(canvas, mimeType, isJpg ? quality : undefined);
      const base64 = dataUrl.split(',')[1];
      const binStr = atob(base64);
      const len = binStr.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = binStr.charCodeAt(i);
      return bytes.buffer;
    }

    throw new Error("Không thể xuất ảnh từ Canvas.");
  }

  /* =========================================================================
   * GIAO DIỆN UNIVERSAL UI
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      state.ui = createUI({
        storagePrefix: "ej-liber-dl",
        title: "EbookJapan",
        engine: "LIBER NUXT",
        themeColor: "#F8485E",
        themeBg: "#ffffff",
        titleColor: "#F8485E",
        topOffset: "60px",
        defaultJpgText: "Xuất file JPG (mặc định PNG)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("ej-liber-dl:convert-jpeg", checked ? '1' : '0');
        }
      });

      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:#F8485E;letter-spacing:0.2px;">EbookJapan</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:1px;">LIBER NUXT</div>
          `;
        }
      }
    }
    return state.ui;
  }

  /* =========================================================================
   * BÓC TÁCH TIÊU ĐỀ THEO GOLDEN RULE 1
   * ========================================================================= */
  function cleanString(str) {
    if (!str || typeof str !== 'string') return '';
    return str
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/【(?:期間限定|無料|試し読み|お試し|特別|デジタル版限定特典|単話).*?】/gi, '')
      .replace(/\s*\([^)]*(?:漫画|原作|作画|著|イラスト)[^)]*\)/g, '')
      .replace(/[\\/*?:"<>|]/g, '')
      .trim();
  }

  function getBookCode() {
    const pub = state.publication;
    if (pub?.code) return String(pub.code).toUpperCase();
    const match = WIN.location.pathname.match(/\/viewer\/(?:story|free)\/([a-zA-Z0-9_-]+)/i);
    return match ? match[1].toUpperCase() : "EBOOKJP_BOOK";
  }

  function getCleanTitle() {
    let mangaTitle = "", chapterTitle = "";
    const pub = state.publication;

    if (pub?.name) {
      mangaTitle = pub.name;
    }

    const nuxtEl = DOC.getElementById('__NUXT_DATA__');
    if (nuxtEl?.textContent) {
      try {
        const arr = JSON.parse(nuxtEl.textContent);
        const resolve = idx => (typeof idx === 'number' && arr[idx] !== undefined) ? arr[idx] : idx;
        const meta = arr.find(x => x && typeof x === 'object' && x.totalPage !== undefined);
        if (meta) {
          const rawTitleObj = resolve(meta.title);
          let sTitle = "";
          if (typeof rawTitleObj === 'object' && rawTitleObj !== null) {
            sTitle = resolve(rawTitleObj.name || rawTitleObj.title || "");
          } else if (typeof rawTitleObj === 'string') {
            sTitle = rawTitleObj;
          }
          let epTitle = resolve(meta.name || meta.storyName || meta.volumeName || "");

          if (sTitle) mangaTitle = sTitle;
          if (epTitle) chapterTitle = epTitle;
        }
      } catch (e) {}
    }

    mangaTitle = cleanString(mangaTitle);
    chapterTitle = cleanString(chapterTitle);

    if (mangaTitle && chapterTitle && chapterTitle.startsWith(mangaTitle)) {
      chapterTitle = cleanString(chapterTitle.substring(mangaTitle.length).replace(/^[\s\-_:：]+/, ''));
    }

    if (mangaTitle && chapterTitle) return `${mangaTitle} - ${chapterTitle}`;
    return mangaTitle || chapterTitle || `EbookJapan_${getBookCode()}`;
  }

  /* =========================================================================
   * BỘ DÒ MODULE WASM ĐỘNG (CHỐNG LỖI KHI YAHOO ĐỔI TÊN FILE BUILD)
   * ========================================================================= */
  async function resolveWasmFactoryModule() {
    if (state.cachedModule) return state.cachedModule;

    // Nấc 1: Fast-Path 0ms với hash hiện tại
    const currentChunkUrl = 'https://ebookjapan.yahoo.co.jp/_nuxt/C5rFXX3l2.js';
    try {
      const mod = await import(currentChunkUrl);
      if (typeof mod?.n === 'function' && mod.n.toString().includes('LoaderType')) {
        state.cachedModule = mod;
        return mod;
      }
    } catch (e) {}

    // Nấc 2: Tự hồi phục (Quét động toàn bộ modulepreload khi Yahoo đổi tên file)
    const links = Array.from(DOC.querySelectorAll('link[rel="modulepreload"][href*="/_nuxt/"], script[src*="/_nuxt/"]'));
    const urls = links.map(el => el.href || el.src).filter(Boolean);

    for (const url of urls) {
      try {
        const candidate = await import(url);
        // Dấu vân tay: Export hàm createFactory quản lý LoaderType
        if (typeof candidate?.n === 'function' && candidate.n.toString().includes('LoaderType')) {
          console.log(`[ej-liber-dl] 🔄 Đã tự động nhận diện module Wasm mới: ${url}`);
          state.cachedModule = candidate;
          return candidate;
        }
      } catch (err) {}
    }

    throw new Error("Không tìm thấy module WasmFactory trên trang EbookJapan.");
  }

  /* =========================================================================
   * KHỞI TẠO BUNCHLOADER & MỞ SÁCH BẰNG WASM FACTORY
   * ========================================================================= */
  /* =========================================================================
   * KHỞI TẠO BUNCHLOADER & MỞ SÁCH BẰNG WASM FACTORY (TỰ ĐỘNG HÓA 100%)
   * ========================================================================= */
  async function ensureBookInitialized() {
    if (state.loader?.pages?.length) return state.loader;

    // 1. Phân tích URL động (Bắt mọi loại route: /free/, /story/, /sample/, /volume/...)
    const pathParts = WIN.location.pathname.split('/').filter(Boolean); // ['viewer', 'story', 'B00...']
    const routeType = pathParts[1] || 'story';
    const routeCode = pathParts[2] || getBookCode();
    const urlSsid = new URLSearchParams(WIN.location.search).get('ssid') || '';

    // 2. Trích xuất metadata từ Pinia Store
    const app = DOC.getElementById('__nuxt')?.__vue_app__;
    const prov = app?._context?.provides || {};
    let pinia = null;
    for (const s of Object.getOwnPropertySymbols(prov)) {
      if (prov[s]?.state?.value) { pinia = prov[s]; break; }
    }

    let pub = pinia?.state?.value?.['viewer-liber']?.bookInfo?.publication;

    // Fallback qua NUXT_DATA nếu Pinia chưa hydrate
    if (!pub) {
      const nuxtEl = DOC.getElementById('__NUXT_DATA__');
      if (nuxtEl?.textContent) {
        try {
          const arr = JSON.parse(nuxtEl.textContent);
          const meta = arr.find(x => x && typeof x === 'object' && x.totalPage !== undefined);
          if (meta) {
            const resolve = idx => (typeof idx === 'number' && arr[idx] !== undefined) ? arr[idx] : idx;
            pub = {
              type: routeType,
              code: resolve(meta.bookCd || meta.storyCd || routeCode),
              ssid: urlSsid,
              name: resolve(meta.name || '')
            };
          }
        } catch(e) {}
      }
    }

    if (!pub?.code) {
      pub = { type: routeType, code: routeCode, ssid: urlSsid };
    }

    state.publication = pub;

    // 3. Nạp WasmFactory động và tự dò enum Factory
    const mod = await resolveWasmFactoryModule();
    let factory = null;
    for (const type of [2, 0, 1, 3]) {
      try {
        const f = mod.n(type);
        if (f?.constructor?.name === 'WasmFactory' || f?.create?.toString().includes('BunchLoader')) {
          factory = f;
          break;
        }
      } catch (e) {}
    }
    if (!factory) factory = mod.n(2);

    // 4. Khởi tạo BunchLoader và mở sách Sharp Master
    const loader = await factory.createLoader("", void 0, undefined, false);
    await loader.open({
      type: pub.type || routeType,
      code: pub.code || routeCode,
      ssid: pub.ssid || urlSsid,
      forceResize: 1 // CHẾ ĐỘ SHARP
    });

    if (!loader.pages?.length) {
      throw new Error("Không thể khởi tạo danh sách trang từ máy chủ.");
    }

    state.loader = loader;
    state.totalPages = loader.pages.length;
    return loader;
  }

  /* =========================================================================
   * TIẾN TRÌNH TẢI CHÍNH (ZERO TAINT, PIXEL-PERFECT, ZERO COLOR LOSS)
   * ========================================================================= */
  /* =========================================================================
   * TIẾN TRÌNH TẢI CHÍNH (PRELOAD PIPELINE, SHARP MASTER JPG, ZERO TAINT)
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      const loader = await ensureBookInitialized();
      const totalPages = loader.pages.length;
      const useJpeg = Boolean(state.convertJpeg);
      const fileExt = useJpeg ? 'jpg' : 'png';

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // File TXT rỗng định danh mã sách tại root ZIP (Golden Rule 2)
      const bookCode = getBookCode();
      zip.addFile(`${bookCode}.txt`, new Uint8Array(0));

      const mangaTitle = getCleanTitle();
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      // BỘ ĐỆM PRELOAD (MẠNG KÉO SONG SONG TRONG KHI WASM GIẢI MÃ TUẦN TỰ)
      const bufferCache = new Map();

      async function fetchCleanPage(idx) {
        if (bufferCache.has(idx)) return bufferCache.get(idx);
        const task = (async () => {
          const rawImg = await loader.getDDD(idx);
          const rawUrl = rawImg?.currentSrc || rawImg?.src || '';
          if (!rawUrl) throw new Error(`Không lấy được URL trang ${idx + 1}`);

          // Tạo 2 URL ứng viên: Ưu tiên JPG Master, dự phòng WebP Sharp
          const baseNoExt = rawUrl.replace(/_s(\.[a-z0-9]+)(?=([?#]|$))/i, '$1');
          const jpgUrl = baseNoExt.replace(/\.(webp|avif)(?=([?#]|$))/i, '.jpg');
          const webpUrl = baseNoExt.replace(/\.(jpe?g|avif)(?=([?#]|$))/i, '.webp');

          let buffer = null;
          try {
            // Thử nấc 1: Kéo bản JPEG Master gốc của NXB
            buffer = await Utils.fetchBuffer(jpgUrl);
          } catch (e) {
            // Fallback nấc 2: Nếu NXB không có bản JPG -> lấy WebP Sharp
            buffer = await Utils.fetchBuffer(webpUrl);
          }

          const mime = Utils.detectMimeType(buffer);
          const cleanBlob = new Blob([buffer], { type: mime });

          return await createImageBitmap(cleanBlob, {
            colorSpaceConversion: 'none',
            premultiplyAlpha: 'none'
          });
        })();
        bufferCache.set(idx, task);
        return task;
      }

      function preloadUpcoming(currentIdx) {
        const limit = Math.min(totalPages, currentIdx + CONFIG.PRELOAD_COUNT);
        for (let j = currentIdx + 1; j < limit; j++) {
          fetchCleanPage(j).catch(() => {});
        }
      }

      // Kích hoạt kéo trước các trang đầu
      preloadUpcoming(0);

      for (let i = 0; i < totalPages; i++) {
        const pageObj = loader.pages[i];

        // 1. Kích hoạt preload PRELOAD_COUNT trang kế tiếp trong lúc Wasm làm việc
        preloadUpcoming(i);

        // 2. Lấy ImageBitmap sạch (nếu mạng đã tải xong trước đó -> trễ 0ms)
        const cleanBitmap = await fetchCleanPage(i);
        bufferCache.delete(i); // Xóa ngay khỏi cache để bảo toàn RAM

        // 3. Khởi tạo Canvas chuẩn
        const targetW = pageObj.width || 1440;
        const targetH = pageObj.height || 2048;

        const canvas = (OffscreenClass && typeof OffscreenClass.prototype.convertToBlob === 'function')
          ? new OffscreenClass(targetW, targetH)
          : DOC.createElement('canvas');

        if (!('convertToBlob' in canvas)) {
          canvas.width = targetW;
          canvas.height = targetH;
        }

        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.imageSmoothingEnabled = false;
        ctx.mozImageSmoothingEnabled = false;
        ctx.webkitImageSmoothingEnabled = false;
        ctx.msImageSmoothingEnabled = false;

        // 4. Giải xáo trộn bằng Wasm (1 luồng an toàn tuyệt đối, không đụng RAM)
        const autographed = typeof loader.getAutographed === 'function' ? await loader.getAutographed(i) : false;

        loader.shuffle({
          ctx: ctx,
          x: 0,
          y: 0,
          data: { image: cleanBitmap },
          autographed: autographed,
          page: i
        });

        // 5. Xuất mảng byte vào file ZIP
        const arrayBuffer = await canvasToArrayBuffer(canvas, useJpeg, CONFIG.JPEG_QUALITY);
        zip.addFile(`${i + 1}.${fileExt}`, new Uint8Array(arrayBuffer));

        // 6. Dọn dẹp VRAM ngay lập tức
        if (cleanBitmap && typeof cleanBitmap.close === 'function') {
          try { cleanBitmap.close(); } catch(e) {}
        }
        if (typeof pageObj.release === 'function') {
          try { pageObj.release(); } catch(e) {}
        }

        if (ui) {
          ui.updateProgress({
            completed: i + 1,
            total: totalPages,
            status: "Đang tải..."
          });
        }

        await sleep(CONFIG.DECODE_DELAY);
      }

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      zip.download(`${mangaTitle}.zip`);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || String(err)) });
      console.error("[ej-liber-dl] Lỗi tải truyện:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * KHỞI TẠO NON-BLOCKING BOOT
   * ========================================================================= */
  async function boot() {
    if (state.booting) return;
    state.booting = true;

    try {
      while (!DOC.body) await sleep(30);
      const ui = getUI();

      if (ui?.panel) ui.panel.style.display = "block";
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });

      let waitCount = 0;
      while (waitCount < 30) {
        try {
          const loader = await ensureBookInitialized();
          if (loader?.pages?.length > 0) {
            await sleep(80);
            if (ui) {
              ui.updateProgress({
                completed: 0,
                total: loader.pages.length,
                status: "Sẵn sàng."
              });
            }
            return;
          }
        } catch (e) {}
        await sleep(200);
        waitCount++;
      }

      if (ui) ui.updateProgress({ status: "Sẵn sàng." });
    } finally {
      state.booting = false;
    }
  }

  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute(() => {
      state.loader = null;
      state.publication = null;
      state.totalPages = 0;
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