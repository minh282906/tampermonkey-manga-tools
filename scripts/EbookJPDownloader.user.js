// ==UserScript==
// @name         EbookJapan Downloader
// @namespace    https://ebookjapan.yahoo.co.jp/
// @icon         https://play-lh.googleusercontent.com/_y6g7elu9JUiyApYhxYikneQZjxPrhIXdz4nuB6y8TreLY1wyhbhRi6WzexLR-mPLP01CYs_T8IElkxWndTNh4k=w240-h480-rw
// @version      1.0
// @description  Tải truyện trên EbookJapan.
// @author       anonymous & AI
// @match        https://ebookjapan.yahoo.co.jp/bviewer*
// @match        https://ebookjapan.yahoo.co.jp/viewer/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      prod-contents-br-page.akamaized.net
// ==/UserScript==

(function ebookJapanUniversalDownloader() {
  'use strict';

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  // Chỉ chạy duy nhất trong iframe /bviewer (nơi chứa Reader và Canvas thật)
  if (!WIN.location.pathname.startsWith('/bviewer')) {
    return;
  }

  // Lưu lại prototype gốc trước khi script của EbookJapan can thiệp
  const nativeCanvasToBlob = WIN.HTMLCanvasElement?.prototype?.toBlob || HTMLCanvasElement?.prototype?.toBlob;
  const nativeDrawImage = WIN.CanvasRenderingContext2D?.prototype?.drawImage || CanvasRenderingContext2D?.prototype?.drawImage;

  /* =========================================================================
   * 1. BỘ ĐÓNG GÓI ZIP NGUYÊN BẢN (PURE ZIP WRITER)
   * ========================================================================= */
  class PureZipWriter {
    constructor() {
      this.files = [];
    }

    addFile(filename, uint8Array) {
      this.files.push({ name: filename, data: uint8Array });
    }

    static crc32(data) {
      let crc = -1;
      for (let i = 0; i < data.length; i++) {
        crc = (crc >>> 8) ^ PureZipWriter.crcTable[(crc ^ data[i]) & 0xFF];
      }
      return (crc ^ -1) >>> 0;
    }

    generateBlob() {
      const parts = [];
      const centralEntries = [];
      let offset = 0;
      const enc = new TextEncoder();

      for (const file of this.files) {
        const nameBytes = enc.encode(file.name);
        const dataBytes = file.data;
        const crc = PureZipWriter.crc32(dataBytes);
        const size = dataBytes.length;

        // Local File Header
        const header = new Uint8Array(30 + nameBytes.length);
        const view = new DataView(header.buffer);
        view.setUint32(0, 0x04034b50, true);
        view.setUint16(4, 20, true);
        view.setUint16(6, 0, true);
        view.setUint16(8, 0, true);
        view.setUint16(10, 0, true);
        view.setUint16(12, 0, true);
        view.setUint32(14, crc, true);
        view.setUint32(18, size, true);
        view.setUint32(22, size, true);
        view.setUint16(26, nameBytes.length, true);
        view.setUint16(28, 0, true);
        header.set(nameBytes, 30);

        parts.push(header);
        parts.push(dataBytes);

        // Central Directory Header
        const cent = new Uint8Array(46 + nameBytes.length);
        const cview = new DataView(cent.buffer);
        cview.setUint32(0, 0x02014b50, true);
        cview.setUint16(4, 20, true);
        cview.setUint16(6, 20, true);
        cview.setUint16(8, 0, true);
        cview.setUint16(10, 0, true);
        cview.setUint16(12, 0, true);
        cview.setUint16(14, 0, true);
        cview.setUint32(16, crc, true);
        cview.setUint32(20, size, true);
        cview.setUint32(24, size, true);
        cview.setUint16(28, nameBytes.length, true);
        cview.setUint16(30, 0, true);
        cview.setUint16(32, 0, true);
        cview.setUint16(34, 0, true);
        cview.setUint16(36, 0, true);
        cview.setUint32(38, 0, true);
        cview.setUint32(42, offset, true);
        cent.set(nameBytes, 46);

        centralEntries.push(cent);
        offset += header.length + size;
      }

      let centralSize = 0;
      for (const cent of centralEntries) {
        parts.push(cent);
        centralSize += cent.length;
      }

      const eocd = new Uint8Array(22);
      const eview = new DataView(eocd.buffer);
      eview.setUint32(0, 0x06054b50, true);
      eview.setUint16(4, 0, true);
      eview.setUint16(6, 0, true);
      eview.setUint16(8, this.files.length, true);
      eview.setUint16(10, this.files.length, true);
      eview.setUint32(12, centralSize, true);
      eview.setUint32(16, offset, true);
      eview.setUint16(20, 0, true);

      parts.push(eocd);

      return new Blob(parts, { type: 'application/zip' });
    }
  }

  PureZipWriter.crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    PureZipWriter.crcTable[i] = c;
  }

  /* =========================================================================
   * 2. STATE & CẤU HÌNH ĐỊNH DẠNG
   * ========================================================================= */
  const FORMATS = {
    png: { extension: "png", type: "image/png" },
    jpg: { extension: "jpg", type: "image/jpeg", quality: 0.95 },
    jpeg: { extension: "jpeg", type: "image/jpeg", quality: 0.95 },
    webp: { extension: "webp", type: "image/webp", quality: 1 },
    avif: { extension: "avif", type: "image/avif", quality: 1 }
  };

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("ej-dl:convert-jpeg") === '1',
    readerData: null, // Lưu cố định { reader, pages } trong RAM
    pageLoads: new WeakMap(),
    ui: null,
    lastProgress: { completed: 0, total: 0, percent: 0, status: "Đang kiểm tra..." }
  };

  function getBookCode(validPages = []) {
    try {
      if (Array.isArray(validPages) && validPages.length > 0) {
        for (const p of validPages) {
          const rawSrc = p.data?.currentSrc || p.data?.src || '';
          const match = rawSrc.match(/([A-Za-z0-9]+)-\d+\.(?:jpg|png|webp|jpeg)/i);
          if (match && match[1]) return match[1].toUpperCase();
        }
      }
      const url = new URL(WIN.location.href);
      const code = url.searchParams.get("code") || url.pathname.split('/').filter(Boolean).pop() || '';
      const codeMatch = code.match(/([A-Za-z0-9]+)/);
      if (codeMatch && codeMatch[1]) return codeMatch[1].toUpperCase();
    } catch {}
    return "B00000000000";
  }

  function sanitizeTitle(str) {
    if (!str || typeof str !== 'string') return '';
    return str
      .replace(/【[^】]*】/g, '') // Xóa sạch các tag như 【デジタル版限定特典付き】, 【期間限定】...
      .replace(/[\\/*?:"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function getCleanMangaTitle() {
    try {
      const reader = state.readerData?.reader || findReader();
      if (reader) {
        const pd = reader.paperDesign || reader.loader || {};
        const candidate = pd.volumeName || pd.title || pd.bookTitle || pd.name || pd.seriesTitle;
        if (typeof candidate === "string" && candidate.trim().length > 2 && !candidate.includes("無料") && !candidate.includes("電子書籍")) {
          return sanitizeTitle(candidate);
        }
      }

      let nuxtEl = null;
      const docsToSearch = [DOC];
      try { if (WIN.parent?.document) docsToSearch.push(WIN.parent.document); } catch {}
      try { if (WIN.top?.document) docsToSearch.push(WIN.top.document); } catch {}

      for (const doc of docsToSearch) {
        try {
          nuxtEl = doc.getElementById("__NUXT_DATA__");
          if (nuxtEl) break;
        } catch {}
      }

      if (nuxtEl?.textContent) {
        try {
          const arr = JSON.parse(nuxtEl.textContent);
          if (Array.isArray(arr)) {
            const resolve = x => (typeof x === "number" && arr[x] !== undefined) ? arr[x] : x;
            for (const item of arr) {
              if (item && typeof item === "object" && (item.publicationCd !== undefined || item.goods !== undefined)) {
                const nameStr = resolve(item.name);
                const volStr = resolve(item.volumeName);
                const titleObj = resolve(item.title);
                const titleNameStr = (titleObj && typeof titleObj === "object") ? resolve(titleObj.name) : resolve(titleObj);
                for (const cand of [nameStr, titleNameStr, volStr]) {
                  if (typeof cand === "string") {
                    const trimmed = cand.trim();
                    if (trimmed.length > 2 && !/^\d+$/.test(trimmed) && !trimmed.includes("無料漫画")) {
                      return sanitizeTitle(trimmed);
                    }
                  }
                }
              }
            }
          }
        } catch (e) {}
      }

      for (const doc of docsToSearch) {
        try {
          const titleEl = doc.querySelector(".header__title, h2.header__title, .heading h2, header h2, h2");
          if (titleEl?.textContent) {
            const txt = titleEl.textContent.trim();
            if (txt.length > 2 && !txt.includes("無料") && !txt.includes("電子書籍")) return sanitizeTitle(txt);
          }
          if (doc.title) {
            let raw = doc.title.replace(/【[^】]*】/g, '').replace(/無料漫画.*/g, '').trim();
            let parts = raw.split(/[｜|\-]/).map(p => p.trim()).filter(Boolean);
            for (let p of parts) {
              if (!/無料|電子書籍|ebookjapan/i.test(p) && p.length > 2) return sanitizeTitle(p);
            }
          }
        } catch {}
      }
    } catch {}
    return "EbookJapan_Manga";
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
   * 3. REACT FIBER TRAVERSAL (TRÍCH XUẤT READER TRONG RAM)
   * ========================================================================= */
  function findLargestCanvas() {
    let largest = null;
    let maxArea = 0;
    for (const canvas of DOC.querySelectorAll("canvas")) {
      if (canvas.width <= 0 || canvas.height <= 0) continue;
      const rect = canvas.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height) || canvas.width * canvas.height;
      if (area > maxArea) {
        largest = canvas;
        maxArea = area;
      }
    }
    return largest;
  }

  function extractReaderFromFiber(domNode) {
    if (!domNode) return null;
    const fiberKey = Object.keys(domNode).find(k => k.startsWith("__reactFiber"));
    let fiber = fiberKey ? domNode[fiberKey] : null;

    for (let depth = 0; fiber && depth < 50; fiber = fiber.return, depth++) {
      let memState = fiber.memoizedState;
      for (let hookDepth = 0; memState && hookDepth < 80; memState = memState.next, hookDepth++) {
        const candidate = memState.memoizedState;
        if (candidate && typeof candidate === "object" && candidate.loader && candidate.paperDesign && Array.isArray(candidate.loader.pages)) {
          return candidate;
        }
      }
    }
    return null;
  }

  function findReader() {
    const fromLargest = extractReaderFromFiber(findLargestCanvas());
    if (fromLargest) return fromLargest;

    for (const canvas of DOC.querySelectorAll("canvas")) {
      const fromAny = extractReaderFromFiber(canvas);
      if (fromAny) return fromAny;
    }
    return null;
  }

  function filterValidPages(readerInstance = findReader()) {
    const pages = readerInstance?.loader?.pages;
    if (!Array.isArray(pages)) return [];
    return pages.filter(p => p && !p.isInvalidPage && Number(p.width) > 0 && Number(p.height) > 0 && p.loader && typeof p.loader.shuffle === "function")
                .sort((a, b) => (Number(a.page) || 0) - (Number(b.page) || 0));
  }

  async function waitForReaderAndPages(timeoutMs = 45000) {
    if (state.readerData?.pages?.length > 0) {
      return state.readerData;
    }

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
    throw new Error("Không tìm thấy reader/pages của EbookJapan viewer. Hãy reload trang bviewer rồi thử lại.");
  }

  function get1BasedPageNum(pageObj, fallbackIndex = 0) {
    const p = Number(pageObj?.page);
    return Number.isFinite(p) ? p + 1 : fallbackIndex + 1;
  }

  function waitForImageElementLoad(imgElement) {
    if (!imgElement) return Promise.resolve();
    if (imgElement.complete && imgElement.naturalWidth > 0 && imgElement.naturalHeight > 0) return Promise.resolve();
    if (typeof imgElement.decode === "function") {
      return imgElement.decode().catch(() => undefined);
    }
    return new Promise((resolve, reject) => {
      imgElement.addEventListener("load", resolve, { once: true });
      imgElement.addEventListener("error", () => reject(new Error("Lỗi nạp ảnh.")), { once: true });
    });
  }

  function getUrlExtension(srcUrl) {
    const str = String(srcUrl || '');
    if (!str) return '';
    try {
      const u = new URL(str, WIN.location.href);
      return /\.([a-z0-9]+)$/i.exec(u.pathname)?.[1]?.toLowerCase() || '';
    } catch {
      return /\.([a-z0-9]+)(?=([?#]|$))/i.exec(str)?.[1]?.toLowerCase() || '';
    }
  }

  function changeUrlExtension(srcUrl, newExt) {
    const str = String(srcUrl || '');
    const cleanExt = String(newExt || '').replace(/^\./, '').toLowerCase();
    if (!str || !cleanExt) return str;
    try {
      const u = new URL(str, WIN.location.href);
      u.pathname = u.pathname.replace(/\.([a-z0-9]+)$/i, '.' + cleanExt);
      return u.href;
    } catch {
      return str.replace(/\.([a-z0-9]+)(?=([?#]|$))/i, '.' + cleanExt);
    }
  }

  function generateCandidateUrls(srcUrl) {
    const str = String(srcUrl || '');
    if (!str) return [];
    const list = [];
    const pushUnique = u => { if (u && !list.includes(u)) list.push(u); };

    if (getUrlExtension(str) === "webp") {
      pushUnique(changeUrlExtension(str, "jpg"));
    }
    pushUnique(str);
    return list;
  }

  function getFormatFromUrl(srcUrl, fallback = FORMATS.png) {
    return FORMATS[getUrlExtension(srcUrl)] || fallback;
  }

  function fetchRawImageBlob(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === "function") {
        GM_xmlhttpRequest({
          method: "GET",
          url: url,
          responseType: "blob",
          timeout: 45000,
          onload: res => {
            if (res.status >= 200 && res.status < 300 && res.response) {
              resolve(new Blob([res.response]));
            } else {
              reject(new Error("GM_xmlhttpRequest HTTP " + res.status));
            }
          },
          onerror: () => reject(new Error("Lỗi tải ảnh.")),
          ontimeout: () => reject(new Error("Timeout tải ảnh."))
        });
        return;
      }

      WIN.fetch(url, { credentials: "include", mode: "cors" })
        .then(r => r.ok ? r.blob() : Promise.reject(new Error("fetch HTTP " + r.status)))
        .then(resolve)
        .catch(reject);
    });
  }

  async function loadCleanImage(url) {
    const blob = await fetchRawImageBlob(url);
    const objUrl = WIN.URL.createObjectURL(blob);
    const img = new WIN.Image();
    img.decoding = "async";
    img.src = objUrl;
    try {
      await waitForImageElementLoad(img);
      return {
        image: img,
        revoke: () => WIN.URL.revokeObjectURL(objUrl)
      };
    } catch (err) {
      WIN.URL.revokeObjectURL(objUrl);
      throw err;
    }
  }

  function ensurePageImageLoaded(pageObj) {
    if (!pageObj) return Promise.reject(new Error("Thiếu trang Viewer."));
    let loadPromise = state.pageLoads.get(pageObj);
    if (!loadPromise) {
      loadPromise = (async () => {
        try {
          if ((!pageObj.done || (!pageObj.data && !pageObj.bmp)) && typeof pageObj.getImage === "function") {
            await pageObj.getImage();
          }
          if (pageObj.data) {
            await waitForImageElementLoad(pageObj.data);
          }
          if (!pageObj.data && !pageObj.bmp) {
            throw new Error("Không load được ảnh cho trang " + get1BasedPageNum(pageObj));
          }
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

  function getPageDimensions(pageObj) {
    const w = Number(pageObj.width) || Number(pageObj.bmp?.width) || Number(pageObj.data?.width) || 1200;
    const h = Number(pageObj.height) || Number(pageObj.bmp?.height) || Number(pageObj.data?.height) || 1800;
    return { width: Math.max(1, Math.floor(w)), height: Math.max(1, Math.floor(h)) };
  }

  function get0BasedPageIndex(pageObj) {
    const p = Number(pageObj?.page);
    return Number.isFinite(p) ? p : Math.max(0, get1BasedPageNum(pageObj) - 1);
  }

  /* =========================================================================
   * 4. THUẬT TOÁN ĐÀM PHÁN THAM SỐ OPENPARAM & SHUFFLE GỐC
   * ========================================================================= */
  function buildOpenParamArgs(loader, overrides = {}) {
    const dpr = Number(WIN.devicePixelRatio) || 1;
    const availH = Number(WIN.screen?.availHeight) || Number(WIN.innerHeight) || 1200;
    const thresh = Number(loader?.resizeThreashold) || 1.25;
    const maxSz = Number(loader?.resizeMax) || 1200;
    const fResize = Number(loader?.forceResize) || 0;
    return {
      dpr,
      limit: Math.floor(availH * dpr * thresh),
      size: maxSz,
      flag: fResize,
      ...overrides
    };
  }

  function getFullSizeProfile(pageObj) {
    const loader = pageObj?.loader;
    if (typeof loader?.funcs?.openParam !== "function") return null;

    const baseArgs = buildOpenParamArgs(loader);
    const fullArgs = buildOpenParamArgs(loader, { flag: 1 });
    try {
      const result = loader.funcs.openParam(fullArgs);
      const pageInfo = result?.pages?.[get0BasedPageIndex(pageObj)];
      const w = Math.floor(Number(pageInfo?.width) || 0);
      const h = Math.floor(Number(pageInfo?.height) || 0);
      if (!w || !h) return null;

      const curDim = getPageDimensions(pageObj);
      if (w <= curDim.width || h <= curDim.height) return null;

      return {
        name: "full-size-openParam",
        args: fullArgs,
        restoreArgs: baseArgs,
        width: w,
        height: h
      };
    } catch {
      return null;
    } finally {
      try { loader.funcs.openParam(baseArgs); } catch {}
    }
  }

  function getViewerProfile(pageObj) {
    const dim = getPageDimensions(pageObj);
    const loader = pageObj?.loader;
    const hasFn = typeof loader?.funcs?.openParam === "function";
    return {
      name: "viewer-openParam",
      args: hasFn ? buildOpenParamArgs(loader) : null,
      restoreArgs: hasFn ? buildOpenParamArgs(loader) : null,
      width: dim.width,
      height: dim.height
    };
  }

  function withOpenParamProfile(loader, profile, callback) {
    if (!profile?.args || typeof loader?.funcs?.openParam !== "function") {
      return callback();
    }
    loader.funcs.openParam(profile.args);
    try {
      return callback();
    } finally {
      if (profile.restoreArgs && typeof loader?.funcs?.openParam === "function") {
        try { loader.funcs.openParam(profile.restoreArgs); } catch {}
      }
    }
  }

  function buildResolutionProfiles(pageObj) {
    const curSrc = pageObj.data?.currentSrc || pageObj.data?.src || '';
    const fullSrc = curSrc.replace(/_s(\.[a-z0-9]+)(?=([?#]|$))/i, '$1');
    const isThumb = /_s\.[a-z0-9]+(?=([?#]|$))/i.test(curSrc);
    const profiles = [];

    // Ưu tiên 1: Link Full HD bỏ _s
    if (curSrc && fullSrc && fullSrc !== curSrc && isThumb && /^https?:/.test(fullSrc)) {
      const fullProf = getFullSizeProfile(pageObj);
      if (fullProf) {
        for (const u of generateCandidateUrls(fullSrc)) {
          if (!/^https?:/.test(u)) continue;
          profiles.push({
            url: u,
            format: getFormatFromUrl(u),
            profile: fullProf,
            source: getUrlExtension(u) === "jpg" ? "clean-shuffle-full-jpg" : "clean-shuffle-full"
          });
        }
      }
    }

    // Ưu tiên 2: Link Viewer hiện tại
    if (curSrc && /^https?:/.test(curSrc)) {
      for (const u of generateCandidateUrls(curSrc)) {
        if (!/^https?:/.test(u)) continue;
        profiles.push({
          url: u,
          format: getFormatFromUrl(u),
          profile: getViewerProfile(pageObj),
          source: getUrlExtension(u) === "jpg" ? "clean-shuffle-viewer-jpg" : "clean-shuffle-viewer"
        });
      }
    }

    return profiles;
  }

  function runNativeShuffle(ctx, pageObj, imageElement) {
    pageObj.loader.shuffle({
      ctx,
      x: 0,
      y: 0,
      data: { image: imageElement },
      autographed: pageObj.autographed,
      page: get0BasedPageIndex(pageObj)
    });
  }

  /* =========================================================================
   * 5. CƠ CHẾ XUẤT ẢNH CANVAS VÀ CẦU NỐI PROTOTYPE GỐC
   * ========================================================================= */
  function createMemoryCanvas(width, height, useOffscreen = true) {
    if (useOffscreen && typeof WIN.OffscreenCanvas === "function") {
      try {
        const off = new WIN.OffscreenCanvas(width, height);
        const ctx = off.getContext('2d');
        if (ctx) {
          return { canvas: off, ctx, offscreen: true, width, height };
        }
      } catch {}
    }
    const domCanvas = DOC.createElement("canvas");
    domCanvas.width = width;
    domCanvas.height = height;
    const ctx = domCanvas.getContext('2d');
    if (!ctx) throw new Error("Không tạo được context 2D.");
    return { canvas: domCanvas, ctx, offscreen: false, width, height };
  }

  function drawSourceToContext(ctx, sourceImage, width, height) {
    const drawFn = typeof ctx.drawImage === "function" ? ctx.drawImage : nativeDrawImage;
    if (typeof drawFn !== "function") throw new Error("Context không hỗ trợ drawImage.");
    drawFn.call(ctx, sourceImage, 0, 0, width, height);
  }

  function canvasToBlobPromise(canvas, mimeType, quality, errorMsg) {
    return new Promise((resolve, reject) => {
      const toBlobFn = nativeCanvasToBlob || canvas.toBlob;
      if (typeof toBlobFn !== "function") {
        reject(new Error("Không tìm thấy hàm toBlob trên trình duyệt."));
        return;
      }
      try {
        toBlobFn.call(canvas, blob => {
          if (blob && blob.size > 0) resolve(blob);
          else reject(new Error(errorMsg));
        }, mimeType, quality);
      } catch (err) {
        reject(err);
      }
    });
  }

  async function exportCanvasBlob(canvasObj, formatObj = FORMATS.png) {
    const fmt = formatObj || FORMATS.png;
    const opts = { type: fmt.type };
    if (Number.isFinite(fmt.quality)) opts.quality = fmt.quality;

    if (canvasObj.offscreen && typeof canvasObj.canvas.convertToBlob === "function") {
      const b = await canvasObj.canvas.convertToBlob(opts);
      if (b && b.size > 0) return b;
      throw new Error("OffscreenCanvas trả về ảnh rỗng.");
    }

    if (canvasObj.offscreen && typeof canvasObj.canvas.transferToImageBitmap === "function") {
      const bmp = canvasObj.canvas.transferToImageBitmap();
      const domCanvas = createMemoryCanvas(canvasObj.width, canvasObj.height, false);
      try {
        drawSourceToContext(domCanvas.ctx, bmp, canvasObj.width, canvasObj.height);
        return await exportCanvasBlob(domCanvas, fmt);
      } finally {
        if (typeof bmp.close === "function") bmp.close();
      }
    }

    return await canvasToBlobPromise(
      canvasObj.canvas,
      fmt.type,
      fmt.quality,
      "Canvas trả về ảnh rỗng."
    );
  }

  async function createImageSourceFromBlob(blob) {
    if (typeof WIN.createImageBitmap === "function") {
      try {
        const bmp = await WIN.createImageBitmap(blob);
        return {
          source: bmp,
          width: bmp.width,
          height: bmp.height,
          cleanup: () => { if (typeof bmp.close === "function") bmp.close(); }
        };
      } catch {}
    }

    const objUrl = WIN.URL.createObjectURL(blob);
    const img = new WIN.Image();
    img.decoding = "async";
    img.src = objUrl;
    try {
      await waitForImageElementLoad(img);
      return {
        source: img,
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
        cleanup: () => WIN.URL.revokeObjectURL(objUrl)
      };
    } catch (err) {
      WIN.URL.revokeObjectURL(objUrl);
      throw err;
    }
  }

  async function convertBlobToTargetFormat(sourceBlob, targetFormat) {
    const fmt = targetFormat || FORMATS.png;
    if (fmt.type === FORMATS.png.type) return sourceBlob;

    const imgSource = await createImageSourceFromBlob(sourceBlob);
    try {
      const w = Math.floor(imgSource.width);
      const h = Math.floor(imgSource.height);
      const memCanvas = createMemoryCanvas(w, h, true);

      if (fmt.type === "image/jpeg") {
        memCanvas.ctx.fillStyle = "#ffffff";
        memCanvas.ctx.fillRect(0, 0, w, h);
      }

      drawSourceToContext(memCanvas.ctx, imgSource.source, w, h);
      return await exportCanvasBlob(memCanvas, fmt);
    } finally {
      imgSource.cleanup();
    }
  }

  async function descrambleCandidateProfile(pageObj, candidate) {
    const { width: targetW, height: targetH } = candidate.profile;
    const cleanImg = await loadCleanImage(candidate.url);
    const memCanvas = createMemoryCanvas(targetW, targetH, true);
    try {
      if (candidate.profile.name === "full-size-openParam" &&
          Number(cleanImg.image.naturalWidth || cleanImg.image.width) === Number(pageObj.data?.naturalWidth) &&
          Number(cleanImg.image.naturalHeight || cleanImg.image.height) === Number(pageObj.data?.naturalHeight)) {
        throw new Error("URL bỏ _s vẫn trả về ảnh nhỏ.");
      }

      withOpenParamProfile(pageObj.loader, candidate.profile, () => {
        runNativeShuffle(memCanvas.ctx, pageObj, cleanImg.image);
      });

      return {
        blob: await exportCanvasBlob(memCanvas, FORMATS.png),
        format: candidate.format
      };
    } finally {
      cleanImg.revoke();
    }
  }

  async function descramblePage(pageObj) {
    const candidateList = buildResolutionProfiles(pageObj);
    for (const cand of candidateList) {
      try {
        return await descrambleCandidateProfile(pageObj, cand);
      } catch {}
    }

    // Dự phòng: Giải mã ảnh hiện tại của viewer
    const { width: curW, height: curH } = getPageDimensions(pageObj);
    const curSrc = pageObj.data?.currentSrc || pageObj.data?.src || '';
    const memCanvas = createMemoryCanvas(curW, curH, true);

    if (!pageObj.data) throw new Error("Trang chưa có ảnh.");

    withOpenParamProfile(pageObj.loader, getViewerProfile(pageObj), () => {
      runNativeShuffle(memCanvas.ctx, pageObj, pageObj.data);
    });

    return {
      blob: await exportCanvasBlob(memCanvas, FORMATS.png),
      format: getFormatFromUrl(curSrc)
    };
  }

  function preloadUpcomingPages(pagesList, startIndex) {
    const limit = Math.min(pagesList.length, startIndex + 4);
    for (let i = startIndex; i < limit; i++) {
      ensurePageImageLoaded(pagesList[i]).catch(() => {});
    }
  }

  function triggerDownload(blob, fileName) {
    const url = WIN.URL.createObjectURL(blob);
    const a = DOC.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = "noopener";
    a.style.display = "none";
    DOC.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => WIN.URL.revokeObjectURL(url), 60000);
  }

  /* =========================================================================
   * 6. GIAO DIỆN UI (ĐỎ EBOOKJAPAN #eb394f)
   * ========================================================================= */
  function updateProgressUI(data = {}) {
    const total = Number.isFinite(data.total) ? data.total : state.lastProgress.total;
    const completed = Number.isFinite(data.completed) ? data.completed : state.lastProgress.completed;
    const pct = total > 0 ? Math.max(0, Math.min(100, Math.round(completed / total * 100))) : 0;

    state.lastProgress = {
      completed,
      total,
      percent: pct,
      status: data.status || state.lastProgress.status
    };

    const ui = state.ui;
    if (!ui) return;

    ui.count.textContent = total ? Math.min(completed, total) + '/' + total : "0/0";
    ui.percent.textContent = pct + '%';
    ui.fill.style.transform = "scaleX(" + (total > 0 ? pct / 100 : 0) + ')';
    ui.status.textContent = state.lastProgress.status;
  }

  function setUiBusy(isBusy) {
    const ui = state.ui;
    if (!ui) return;
    if (ui.button) {
      ui.button.disabled = Boolean(isBusy);
      ui.button.textContent = "Download";
      ui.button.style.opacity = isBusy ? "0.72" : '1';
      ui.button.style.cursor = isBusy ? "progress" : "pointer";
    }
    if (ui.jpgInput) {
      ui.jpgInput.disabled = Boolean(isBusy);
    }
  }

  function createUI() {
    if (state.ui || !DOC.body || DOC.getElementById("ej-canvas-dl")) return;

    const PANEL_WIDTH = 220;
    const TAB_WIDTH = 14;
    let isCollapsed = WIN.localStorage.getItem("ej-dl:collapsed") === '1';

    const panel = DOC.createElement("div");
    panel.id = "ej-canvas-dl";
    panel.style.cssText = [
      "all:initial",
      "position:fixed",
      "right:0px",
      "top:55px",
      "z-index:2147483647",
      "box-sizing:border-box",
      `width:${PANEL_WIDTH}px`,
      "padding:10px 14px",
      "border:1px solid #eb394f",
      "border-right:none",
      "border-radius:12px 0 0 12px",
      "background:#1c070a",
      "color:#ffffff",
      "font:12px/1.3 system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif",
      "user-select:none",
      "box-shadow:0 8px 24px rgba(0,0,0,0.85)",
      "transition:transform 0.22s cubic-bezier(0.16, 1, 0.3, 1)",
      `transform:${isCollapsed ? `translateX(calc(100% - ${TAB_WIDTH}px))` : "translateX(0)"}`,
      "display:block",
      "overflow:hidden"
    ].join(';');

    const collapsedStrip = DOC.createElement("div");
    collapsedStrip.style.cssText = [
      "all:initial",
      "position:absolute",
      "left:0px",
      "top:0px",
      `width:${TAB_WIDTH}px`,
      "height:100%",
      "background:#eb394f",
      "cursor:pointer",
      "transition:opacity 0.15s, background 0.15s",
      `opacity:${isCollapsed ? "1" : "0"}`,
      `pointer-events:${isCollapsed ? "auto" : "none"}`
    ].join(';');
    collapsedStrip.title = "Mở bảng tải";
    collapsedStrip.onmouseenter = () => { collapsedStrip.style.background = "#ff576c"; };
    collapsedStrip.onmouseleave = () => { collapsedStrip.style.background = "#eb394f"; };

    const mainContent = DOC.createElement("div");
    mainContent.style.cssText = [
      "all:initial",
      "display:block",
      "transition:opacity 0.2s",
      `opacity:${isCollapsed ? "0" : "1"}`,
      `pointer-events:${isCollapsed ? "none" : "auto"}`
    ].join(';');

    const collapseBtn = DOC.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.textContent = "▶";
    collapseBtn.title = "Thu gọn";
    collapseBtn.style.cssText = [
      "all:initial",
      "position:absolute",
      "left:0px",
      "top:0px",
      "width:24px",
      "height:24px",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "border-radius:12px 0 8px 0",
      "background:#eb394f",
      "color:#ffffff",
      "font:900 10px system-ui,sans-serif",
      "cursor:pointer",
      "transition:background 0.15s ease",
      "z-index:2"
    ].join(';');
    collapseBtn.onmouseenter = () => { collapseBtn.style.background = "#ff576c"; };
    collapseBtn.onmouseleave = () => { collapseBtn.style.background = "#eb394f"; };

    const title = DOC.createElement("div");
    title.textContent = "EbookJapan Downloader";
    title.style.cssText = "all:initial;display:block;color:#ff8595;font:800 13px system-ui;margin-bottom:8px;text-align:center;padding-left:14px;";

    const btn = DOC.createElement("button");
    btn.type = "button";
    btn.textContent = "Download";
    btn.style.cssText = [
      "all:initial",
      "display:block",
      "box-sizing:border-box",
      "width:100%",
      "padding:8px 0",
      "border:0",
      "border-radius:6px",
      "background:#eb394f",
      "color:#ffffff",
      "font:800 14px/1.2 system-ui,sans-serif",
      "text-align:center",
      "cursor:pointer",
      "box-shadow:0 3px 10px rgba(235, 57, 79, 0.35)"
    ].join(';');

    btn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      if (!state.running) startDownload();
    });

    const label = DOC.createElement("label");
    label.style.cssText = "all:initial;display:inline-flex;align-items:center;gap:6px;margin-top:8px;color:#fecdd3;font:700 11px system-ui;cursor:pointer;";

    const jpgInput = DOC.createElement("input");
    jpgInput.type = "checkbox";
    jpgInput.checked = state.convertJpeg;
    jpgInput.style.cssText = "all:initial;appearance:auto;width:14px;height:14px;accent-color:#eb394f;cursor:pointer;";
    jpgInput.addEventListener("change", () => {
      state.convertJpeg = jpgInput.checked;
      try { WIN.localStorage.setItem("ej-dl:convert-jpeg", state.convertJpeg ? '1' : '0'); } catch {}
    });

    const spanJpg = DOC.createElement("span");
    spanJpg.textContent = "Xuất file JPG (mặc định PNG)";
    spanJpg.style.cssText = "all:initial;color:#fecdd3;font:700 11px system-ui;";
    label.append(jpgInput, spanJpg);

    const progressRow = DOC.createElement("div");
    progressRow.style.cssText = "all:initial;display:flex;justify-content:space-between;align-items:center;margin-top:10px;color:#ffffff;font:800 12px system-ui;";

    const countText = DOC.createElement("span");
    countText.textContent = "0/0";
    countText.style.cssText = "all:initial;color:#ffffff;font:800 12px system-ui;";

    const percentText = DOC.createElement("span");
    percentText.textContent = "0%";
    percentText.style.cssText = "all:initial;color:#ffffff;font:800 12px system-ui;";

    progressRow.append(countText, percentText);

    const track = DOC.createElement("div");
    track.style.cssText = "all:initial;display:block;height:6px;overflow:hidden;border-radius:3px;background:#4c0519;margin-top:6px;";

    const fill = DOC.createElement("div");
    fill.style.cssText = "all:initial;display:block;width:100%;height:100%;background:#ff4d66;transform:scaleX(0);transform-origin:left center;transition:transform .22s ease;";
    track.appendChild(fill);

    const statusText = DOC.createElement("div");
    statusText.textContent = state.lastProgress.status;
    statusText.style.cssText = "all:initial;display:block;margin-top:8px;color:#fecdd3;font:11px system-ui;word-break:break-word;";

    mainContent.append(collapseBtn, title, btn, label, progressRow, track, statusText);
    panel.append(collapsedStrip, mainContent);

    function setCollapsedState(collapsed) {
      isCollapsed = collapsed;
      WIN.localStorage.setItem("ej-dl:collapsed", isCollapsed ? '1' : '0');

      panel.style.transform = isCollapsed ? `translateX(calc(100% - ${TAB_WIDTH}px))` : "translateX(0)";
      collapsedStrip.style.opacity = isCollapsed ? "1" : "0";
      collapsedStrip.style.pointerEvents = isCollapsed ? "auto" : "none";
      mainContent.style.opacity = isCollapsed ? "0" : "1";
      mainContent.style.pointerEvents = isCollapsed ? "none" : "auto";
    }

    collapseBtn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      setCollapsedState(true);
    });

    panel.addEventListener("click", () => {
      if (isCollapsed) setCollapsedState(false);
    });

    DOC.body.appendChild(panel);

    state.ui = {
      panel,
      button: btn,
      jpgInput,
      count: countText,
      percent: percentText,
      fill,
      status: statusText
    };

    updateProgressUI(state.lastProgress);
  }

  /* =========================================================================
   * 7. CHƯƠNG TRÌNH TẢI CHÍNH
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    state.running = true;
    setUiBusy(true);

    try {
      updateProgressUI({ completed: 0, total: 0, status: "Đang tải..." });

      const { pages: pagesList } = await waitForReaderAndPages();
      const selectedPages = pagesList.slice(0, 1000);
      const totalPages = selectedPages.length;
      if (!totalPages) {
        throw new Error("Viewer không có trang hợp lệ để tải.");
      }

      const useJpeg = Boolean(state.convertJpeg);
      const zip = new PureZipWriter();

      // Mã sách -> File TXT rỗng trong ZIP
      const bookCode = getBookCode(selectedPages);
      zip.addFile(`${bookCode}.txt`, new Uint8Array(0));

      const mangaTitle = getCleanMangaTitle();
      preloadUpcomingPages(selectedPages, 0);

      updateProgressUI({ completed: 0, total: totalPages, status: "Đang tải..." });

      for (let i = 0; i < totalPages; i++) {
        const pageObj = selectedPages[i];
        const pageNum = get1BasedPageNum(pageObj, i);

        preloadUpcomingPages(selectedPages, i + 1);

        await ensurePageImageLoaded(pageObj);
        const descrambled = await descramblePage(pageObj);

        let outputBlob = descrambled.blob;
        let ext = 'png';

        if (useJpeg) {
          outputBlob = await convertBlobToTargetFormat(outputBlob, FORMATS.jpg);
          if (!outputBlob.size) throw new Error("Blob JPG rỗng ở trang " + pageNum + '.');
          ext = 'jpg';
        } else {
          outputBlob = await convertBlobToTargetFormat(outputBlob, FORMATS.png);
          if (!outputBlob.size) throw new Error("Blob PNG rỗng ở trang " + pageNum + '.');
          ext = 'png';
        }

        const arrayBuffer = await outputBlob.arrayBuffer();
        zip.addFile(`${pageNum}.${ext}`, new Uint8Array(arrayBuffer));

        updateProgressUI({ completed: i + 1, total: totalPages, status: "Đang tải..." });
        await sleep(40);
      }

      updateProgressUI({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      const zipBlob = zip.generateBlob();
      const zipFileName = `${mangaTitle}.zip`;
      triggerDownload(zipBlob, zipFileName);

      updateProgressUI({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      const msg = err?.message || String(err);
      updateProgressUI({ status: "Lỗi: " + msg });
      console.error("[ej-dl] Download failed", err);
    } finally {
      state.running = false;
      setUiBusy(false);
      updateProgressUI(state.lastProgress);
    }
  }

  /* =========================================================================
   * 8. KHỞI TẠO VÀ BOOT
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) {
      await sleep(100);
    }
    ensureSinglePageVerticalMode();
    createUI();
    updateProgressUI({ completed: 0, total: 0, status: "Đang kiểm tra..." });

    try {
      const { pages } = await waitForReaderAndPages();
      updateProgressUI({ completed: 0, total: pages.length, status: "Sẵn sàng." });
    } catch (err) {
      updateProgressUI({ completed: 0, total: 0, status: "Lỗi: " + (err?.message || err) });
    }
  }

  if (DOC.readyState === "loading") {
    DOC.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();