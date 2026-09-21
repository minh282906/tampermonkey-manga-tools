// ==UserScript==
// @name         EbookJapan Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      4.0.0
// @icon         https://ebookjapan.yahoo.co.jp/favicon.ico
// @description  Tải manga trên EbookJapan
// @author       anonymous & AI
// @match        https://ebookjapan.yahoo.co.jp/viewer/*
// @match        https://ebookjapan.yahoo.co.jp/bviewer*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      ebookjapan.yahoo.co.jp
// @connect      prod-contents-br-page.akamaized.net
//
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/EbookJPDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/EbookJPDownloader.user.js
//
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function ebookJapanUniversalDownloader() {
  'use strict';

  const CONFIG = {
    PRELOAD_COUNT: 4,      // Số trang mạng kéo trước vào RAM (Pipeline đa luồng)
    JPEG_QUALITY: 1.0,     // Chất lượng nén khi người dùng chọn xuất JPG
    DECODE_DELAY: 15       // Micro-delay nhường nhịp Event Loop sau mỗi trang (ms)
  };

  const WIN = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (!WIN.location.pathname.startsWith('/bviewer') && !WIN.location.pathname.startsWith('/viewer')) return;

  const state = {
    running: false,
    booting: false,
    engineMode: WIN.location.pathname.startsWith('/viewer') ? 'LIBER NUXT' : 'BUNCHVIEWER',
    convertJpeg: localStorage.getItem("ej-dl:convert-jpeg") === '1',
    readerData: null,          // Cho BViewer (React Fiber)
    loader: null,              // Cho Liber Nuxt (WasmFactory)
    publication: null,         // Cho Liber Nuxt
    ui: null
  };

  /* =========================================================================
   * GIAO DIỆN UNIVERSAL UI (ĐỔI TÊN ENGINE ĐỘNG THEO NUXT / BVIEWER)
   * ========================================================================= */
  function getUI(engineName = state.engineMode) {
    if (state.ui) {
      // Cập nhật nhãn engine nếu chế độ thay đổi
      const engineSubEl = state.ui.panel?.querySelector('#ej-engine-sub');
      if (engineSubEl) engineSubEl.textContent = engineName;
      return state.ui;
    }

    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      state.ui = createUI({
        storagePrefix: "ej-dl",
        title: "EbookJapan",
        engine: engineName,
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
      });

      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:#F8485E;letter-spacing:0.2px;">EbookJapan</div>
            <div id="ej-engine-sub" style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px;">${engineName}</div>
          `;
        }
      }
    }
    return state.ui;
  }

  /* =========================================================================
   * BỘ HỖ TRỢ XỬ LÝ CHUỖI & TÊN FILE CHUẨN
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
    let rawName = "";
    let mangaTitle = "", chapterTitle = "";

    try {
      const reader = state.readerData?.reader || findReader();
      const loader = state.loader || reader?.loader || reader?.Loader || reader?.paperDesign?.loader;
      // Lấy từ state.publication (Nuxt) hoặc loader.currentBook (BViewer)
      const pub = state.publication || loader?.currentBook?.publication || loader?.bookInfo?.publication;

      // 1. Trích xuất trực tiếp từ publication.name (Vị trí chuẩn xác của BViewer)
      if (pub?.name) {
        rawName = pub.name;
      } else if (reader?.paperDesign) {
        const pd = reader.paperDesign;
        mangaTitle = pd.seriesTitle || pd.title || pd.bookTitle || "";
        chapterTitle = pd.volumeName || pd.name || pd.storyName || "";
      }
    } catch (e) {}

    // 2. Tách tên truyện và tên tập/chap theo Golden Rule 1
    if (rawName) {
      rawName = cleanString(rawName);
      // Tách tự động nếu có chứa mốc số tập/chương: 第...巻, 第...話, #..., Chapter...
      const splitMatch = rawName.match(/^(.*?)(?:[\s\u3000]+)(第[0-9０-９一二三四五六七八九十]+[巻話回].*|#\d+.*|Chapter\s*\d+.*)$/i);
      if (splitMatch) {
        mangaTitle = cleanString(splitMatch[1]);
        chapterTitle = cleanString(splitMatch[2]);
      } else {
        mangaTitle = rawName;
      }
    }

    // 3. Fallback qua __NUXT_DATA__ nếu có nhúng trong iframe
    if (!mangaTitle) {
      try {
        let nuxtEl = DOC.getElementById("__NUXT_DATA__");
        if (!nuxtEl) {
          try { nuxtEl = WIN.parent?.document?.getElementById("__NUXT_DATA__"); } catch {}
          try { if (!nuxtEl) nuxtEl = WIN.top?.document?.getElementById("__NUXT_DATA__"); } catch {}
        }
        if (nuxtEl?.textContent) {
          const arr = JSON.parse(nuxtEl.textContent);
          if (Array.isArray(arr)) {
            const resolve = idx => (typeof idx === "number" && arr[idx] !== undefined) ? arr[idx] : idx;
            const meta = arr.find(x => x && typeof x === "object" && (x.totalPage !== undefined || x.bookCd !== undefined));
            if (meta) {
              const rawTitleObj = resolve(meta.title);
              let sTitle = "";
              if (typeof rawTitleObj === "object" && rawTitleObj !== null) {
                sTitle = resolve(rawTitleObj.name || rawTitleObj.title || "");
              } else if (typeof rawTitleObj === "string") {
                sTitle = rawTitleObj;
              }
              const epTitle = resolve(meta.name || meta.storyName || meta.volumeName || "");
              if (sTitle) mangaTitle = sTitle;
              if (epTitle) chapterTitle = epTitle;
            }
          }
        }
      } catch (e) {}
    }

    // Khử trùng lặp tiêu đề
    if (mangaTitle && chapterTitle && chapterTitle.startsWith(mangaTitle)) {
      chapterTitle = cleanString(chapterTitle.substring(mangaTitle.length).replace(/^[\s\-_:：]+/, ""));
    }

    if (mangaTitle && chapterTitle) return `${mangaTitle} - ${chapterTitle}`;
    if (mangaTitle) return mangaTitle;
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

    // 1. Ưu tiên cao nhất: OffscreenCanvas native (Bypass 100% DOM prototype)
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
   * THUẬT TOÁN LẤY KÍCH THƯỚC SHARP & TỌA ĐỘ
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
        if (w > 0 && h > 0) return { rawSrc: fullSrc, width: w, height: h, args: fullArgs };
      } catch {}
    }

    const w = Number(pageObj.width) || Number(pageObj.bmp?.width) || Number(pageObj.data?.width) || 1200;
    const h = Number(pageObj.height) || Number(pageObj.bmp?.height) || Number(pageObj.data?.height) || 1800;
    return {
      rawSrc: fullSrc || curSrc,
      width: Math.floor(w),
      height: Math.floor(h),
      args: typeof loader?.funcs?.openParam === "function" ? buildOpenParamArgs(loader) : null
    };
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
   * KHỞI TẠO BUNCHVIEWER & MỞ SÁCH BẰNG WASM FACTORY (TỰ ĐỘNG HÓA 100%)
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
        if (f?.constructor?.name === 'WasmFactory' || f?.create?.toString().includes('BunchVIEWER')) {
          factory = f;
          break;
        }
      } catch (e) {}
    }
    if (!factory) factory = mod.n(2);

    // 4. Khởi tạo BunchVIEWER và mở sách Sharp Master
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

  /* ==========================================================================================
   * TIẾN TRÌNH TẢI CHÍNH TỰ ĐỘNG NUXT HOẶC BVIEWER (PRELOAD PIPELINE, SHARP MASTER JPG, ZERO TAINT)
   * ========================================================================================== */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      const isNuxt = (state.engineMode === 'LIBER NUXT');

      if (isNuxt) { if (!state.loader) await ensureBookInitialized(); }
      else { if (!state.readerData) await waitForReaderAndPages(15000); }

      const totalPages = isNuxt ? state.loader.pages.length : state.readerData.pages.length;
      const pages = isNuxt ? state.loader.pages : state.readerData.pages;

      const useJpeg = Boolean(state.convertJpeg);
      const fileExt = useJpeg ? 'jpg' : 'png';

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      const bookCode = getBookCode(pages);
      zip.addFile(`${bookCode}.txt`, new Uint8Array(0));

      const mangaTitle = getCleanTitle();
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      // BỘ ĐỆM PRELOAD DÙNG CHUNG CHO CẢ 2 BÊN
      const bufferCache = new Map();

      async function fetchCleanPage(pageObj, idx) {
        if (bufferCache.has(idx)) return bufferCache.get(idx);

        const task = (async () => {
          let fullUrl = "";
          let prof = null;

          if (isNuxt) {
            // Nhánh 1: Nuxt lấy qua getDDD
            const rawImg = await state.loader.getDDD(idx);
            const rawUrl = rawImg?.currentSrc || rawImg?.src || '';
            const baseNoExt = rawUrl.replace(/_s(\.[a-z0-9]+)(?=([?#]|$))/i, '$1');
            fullUrl = baseNoExt.replace(/\.(webp|avif)(?=([?#]|$))/i, '.jpg');
          } else {
            // Nhánh 2 & 3: BViewer lấy qua getTargetProfile
            if (!pageObj.data?.currentSrc && !pageObj.data?.src && typeof pageObj.getImage === "function") {
              const p = pageObj.getImage();
              if (p?.then) await p;
            }
            prof = getTargetProfile(pageObj);
            const baseNoExt = prof.rawSrc.replace(/_s(\.[a-z0-9]+)(?=([?#]|$))/i, '$1');
            fullUrl = baseNoExt.replace(/\.(webp|avif)(?=([?#]|$))/i, '.jpg');
          }

          let buffer = null;
          try {
            buffer = await Utils.fetchBuffer(fullUrl);
          } catch (e) {
            // Fallback WebP nếu cuốn đó không có file JPG
            const webpUrl = fullUrl.replace(/\.jpg(?=([?#]|$))/i, '.webp');
            buffer = await Utils.fetchBuffer(webpUrl);
          }

          const mime = Utils.detectMimeType(buffer);
          const cleanBlob = new Blob([buffer], { type: mime });

          const cleanBitmap = await createImageBitmap(cleanBlob, {
            colorSpaceConversion: 'none',
            premultiplyAlpha: 'none'
          });

          return { cleanBitmap, prof };
        })();

        bufferCache.set(idx, task);
        return task;
      }

      function preloadUpcoming(currentIdx) {
        const limit = Math.min(totalPages, currentIdx + CONFIG.PRELOAD_COUNT);
        for (let j = currentIdx + 1; j < limit; j++) {
          fetchCleanPage(pages[j], j).catch(() => {});
        }
      }

      preloadUpcoming(0);

      for (let i = 0; i < totalPages; i++) {
        const pageObj = pages[i];
        const pIdx = isNuxt ? i : (Number(pageObj.page) || 0);

        preloadUpcoming(i);

        const { cleanBitmap, prof } = await fetchCleanPage(pageObj, i);
        bufferCache.delete(i);

        // Kích thước chuẩn: BViewer lấy prof.width, Nuxt lấy pageObj.width
        const targetW = isNuxt ? (pageObj.width || 1440) : (prof?.width || pageObj.width || 1350);
        const targetH = isNuxt ? (pageObj.height || 2048) : (prof?.height || pageObj.height || 1920);

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

        const loaderInstance = isNuxt ? state.loader : pageObj.loader;

        // BViewer nạp tham số Sharp vào Wasm trước khi shuffle
        if (!isNuxt && prof?.args && loaderInstance?.funcs?.openParam) {
          try { loaderInstance.funcs.openParam(prof.args); } catch (e) {}
        }

        const autographed = isNuxt
          ? (typeof loaderInstance.getAutographed === 'function' ? await loaderInstance.getAutographed(i) : false)
          : pageObj.autographed;

        loaderInstance.shuffle({
          ctx: ctx,
          x: 0,
          y: 0,
          data: { image: cleanBitmap },
          autographed: autographed,
          page: pIdx
        });

        const arrayBuffer = await canvasToArrayBuffer(canvas, useJpeg, CONFIG.JPEG_QUALITY);
        zip.addFile(`${i + 1}.${fileExt}`, new Uint8Array(arrayBuffer));

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
      console.error("[ej-dl] Lỗi tải truyện:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * KHỞI TẠO VÀ BOOT
   * ========================================================================= */
  async function boot() {
    if (state.booting) return;
    state.booting = true;

    try {
      while (!DOC.body) await sleep(30);
      ensureSinglePageVerticalMode();

      const ui = getUI();
      if (ui?.panel) ui.panel.style.display = "block";
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });

      const isViewerPath = WIN.location.pathname.startsWith('/viewer');
      let foundBViewer = false;

      // Nếu ở /bviewer: Quét tối đa 4 giây (20 nhịp)
      // Nếu ở /viewer: Chỉ quét nhanh 2 nhịp (300ms) để bắt Trường hợp 3 (vỏ viewer ruột bviewer)
      const maxChecks = isViewerPath ? 2 : 20;
      let checkCount = 0;

      while (checkCount < maxChecks) {
        const reader = findReader();
        const pages = filterValidPages(reader);
        if (reader && pages.length > 0) {
          state.readerData = { reader, pages };
          state.engineMode = 'BUNCHVIEWER';
          getUI('BUNCHVIEWER');
          foundBViewer = true;
          await sleep(80);
          if (ui) ui.updateProgress({ completed: 0, total: pages.length, status: "Sẵn sàng." });
          return;
        }
        await sleep(150);
        checkCount++;
      }

      // Chạy Liber Nuxt Engine
      if (!foundBViewer) {
        state.engineMode = 'LIBER NUXT';
        getUI('LIBER NUXT');
        try {
          const loader = await ensureBookInitialized();
          if (loader?.pages?.length > 0) {
            await sleep(80);
            if (ui) ui.updateProgress({ completed: 0, total: loader.pages.length, status: "Sẵn sàng." });
            return;
          }
        } catch(e) {}
      }

      if (ui) ui.updateProgress({ status: "Sẵn sàng." });
    } finally {
      state.booting = false;
    }
  }

  // Lắng nghe đổi route ngầm (SPA Watcher)
  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute(() => {
      state.readerData = null;
      state.loader = null;
      state.publication = null;
      state.running = false;
      state.engineMode = WIN.location.pathname.startsWith('/viewer') ? 'LIBER NUXT' : 'BUNCHVIEWER';
      const ui = getUI(state.engineMode);
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