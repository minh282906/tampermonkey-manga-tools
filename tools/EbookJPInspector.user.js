// ==UserScript==
// @name         EbookJapan Inspector
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      5.0.0
// @description  Inspector soi ma trận Yahoo Wasm và trích xuất Canvas đối chiếu chuẩn Pixel-Perfect cho EbookJapan.
// @author       anonymous & AI
// @match        https://ebookjapan.yahoo.co.jp/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      ebookjapan.yahoo.co.jp
// @connect      prod-contents-br-page.akamaized.net
// @connect      *.akamaized.net
// @run-at       document-start
//
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/InspectorUI.js
// ==/UserScript==

(function ebookJapanInspector() {
  "use strict";

  const WIN = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const DOC = WIN.document;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (WIN.top !== WIN.self) return;

  const state = {
    booting: false,
    engineMode: WIN.location.pathname.startsWith("/viewer")
      ? "LIBER NUXT"
      : "BUNCHVIEWER",
    readerData: null, // Cho BViewer (React Fiber)
    loader: null, // Cho Liber Nuxt (WasmFactory)
    publication: null, // Cho Liber Nuxt
    totalPages: 0,
    cachedModule: null,
  };

  /* =========================================================================
   * 1. BỘ XUẤT CANVAS CHỐNG TAINTED & BYPASS PROTOTYPE STRIPPING
   * ========================================================================= */
  const OffscreenClass =
    WIN.OffscreenCanvas || window.OffscreenCanvas || globalThis.OffscreenCanvas;

  function getPristineCanvasMethods() {
    try {
      const ifr = DOC.createElement("iframe");
      ifr.style.display = "none";
      DOC.body.appendChild(ifr);
      const pToBlob = ifr.contentWindow?.HTMLCanvasElement?.prototype?.toBlob;
      const pToDataURL =
        ifr.contentWindow?.HTMLCanvasElement?.prototype?.toDataURL;
      ifr.remove();
      return { toBlob: pToBlob, toDataURL: pToDataURL };
    } catch (e) {
      return {};
    }
  }

  let pristine = null;

  async function canvasToArrayBuffer(
    canvas,
    mimeType = "image/png",
    quality = 0.95,
  ) {
    if (typeof canvas.convertToBlob === "function") {
      const opts = { type: mimeType };
      if (typeof quality === "number") opts.quality = quality;
      const blob = await canvas.convertToBlob(opts);
      return await blob.arrayBuffer();
    }

    if (!pristine) pristine = getPristineCanvasMethods();

    const toBlobFn = pristine.toBlob || canvas.toBlob;
    if (typeof toBlobFn === "function") {
      const blob = await new Promise((resolve, reject) => {
        try {
          toBlobFn.call(
            canvas,
            (b) => (b ? resolve(b) : reject(new Error("toBlob null"))),
            mimeType,
            quality,
          );
        } catch (e) {
          reject(e);
        }
      });
      return await blob.arrayBuffer();
    }

    const toDataURLFn = pristine.toDataURL || canvas.toDataURL;
    if (typeof toDataURLFn === "function") {
      const dataUrl = toDataURLFn.call(canvas, mimeType, quality);
      const base64 = dataUrl.split(",")[1];
      const binStr = atob(base64);
      const len = binStr.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = binStr.charCodeAt(i);
      return bytes.buffer;
    }

    throw new Error("Không thể xuất ảnh từ Canvas.");
  }

  /* =========================================================================
   * 2. NHẬN DIỆN VÀ TRÍCH XUẤT REACT FIBER (BVIEWER ENGINE)
   * ========================================================================= */
  function extractReaderFromFiber(domNode) {
    if (!domNode) return null;
    const fiberKey = Object.keys(domNode).find((k) =>
      k.startsWith("__reactFiber"),
    );
    let fiber = fiberKey ? domNode[fiberKey] : null;

    for (let depth = 0; fiber && depth < 50; fiber = fiber.return, depth++) {
      let mem = fiber.memoizedState;
      for (let hDepth = 0; mem && hDepth < 80; mem = mem.next, hDepth++) {
        const candidate = mem.memoizedState;
        if (
          candidate &&
          typeof candidate === "object" &&
          candidate.loader?.pages &&
          candidate.paperDesign
        ) {
          return candidate;
        }
      }
    }
    return null;
  }

  function findReaderInfo() {
    for (const canvas of DOC.querySelectorAll("canvas")) {
      const r = extractReaderFromFiber(canvas);
      if (r) return { reader: r, ownerWin: WIN };
    }
    for (const iframe of DOC.querySelectorAll("iframe")) {
      try {
        const ifWin = iframe.contentWindow;
        const ifDoc = iframe.contentDocument || ifWin?.document;
        if (ifDoc && ifWin) {
          for (const canvas of ifDoc.querySelectorAll("canvas")) {
            const r = extractReaderFromFiber(canvas);
            if (r) return { reader: r, ownerWin: ifWin };
          }
        }
      } catch (e) {}
    }
    return null;
  }

  function filterValidPages(reader) {
    const pages = reader?.loader?.pages;
    if (!Array.isArray(pages)) return [];
    return pages
      .filter(
        (p) =>
          p &&
          !p.isInvalidPage &&
          Number(p.width) > 0 &&
          typeof p.loader?.shuffle === "function",
      )
      .sort((a, b) => (Number(a.page) || 0) - (Number(b.page) || 0));
  }

  function buildOpenParamArgs(loader, overrides = {}) {
    const dpr = Number(WIN.devicePixelRatio) || 1;
    const availH =
      Number(WIN.screen?.availHeight) || Number(WIN.innerHeight) || 1200;
    return {
      dpr,
      limit: Math.floor(
        availH * dpr * (Number(loader?.resizeThreashold) || 1.25),
      ),
      size: Number(loader?.resizeMax) || 1200,
      flag: Number(loader?.forceResize) || 0,
      ...overrides,
    };
  }

  function getTargetProfile(pageObj) {
    const loader = pageObj?.loader;
    const curSrc = pageObj.data?.currentSrc || pageObj.data?.src || "";
    const fullSrc = curSrc.replace(/_s(\.[a-z0-9]+)(?=([?#]|$))/i, "$1");
    const pIdx = Number(pageObj.page) || 0;

    if (
      curSrc &&
      fullSrc &&
      fullSrc !== curSrc &&
      typeof loader?.funcs?.openParam === "function"
    ) {
      try {
        const baseArgs = buildOpenParamArgs(loader);
        const fullArgs = buildOpenParamArgs(loader, { flag: 1 });
        const res = loader.funcs.openParam(fullArgs);
        const pInfo = res?.pages?.[pIdx];
        const w = Math.floor(Number(pInfo?.width) || 0);
        const h = Math.floor(Number(pInfo?.height) || 0);
        loader.funcs.openParam(baseArgs);
        if (w > 0 && h > 0)
          return { rawSrc: fullSrc, width: w, height: h, args: fullArgs };
      } catch {}
    }

    const w =
      Number(pageObj.width) ||
      Number(pageObj.bmp?.width) ||
      Number(pageObj.data?.width) ||
      1200;
    const h =
      Number(pageObj.height) ||
      Number(pageObj.bmp?.height) ||
      Number(pageObj.data?.height) ||
      1800;
    return {
      rawSrc: fullSrc || curSrc,
      width: Math.floor(w),
      height: Math.floor(h),
      args:
        typeof loader?.funcs?.openParam === "function"
          ? buildOpenParamArgs(loader)
          : null,
    };
  }

  /* =========================================================================
   * 3. BỘ DÒ MODULE WASM ĐỘNG & KHỞI TẠO NUXT (LIBER NUXT ENGINE)
   * ========================================================================= */
  async function resolveWasmFactoryModule() {
    if (state.cachedModule) return state.cachedModule;

    const currentChunkUrl = "https://ebookjapan.yahoo.co.jp/_nuxt/C5rFXX3l2.js";
    try {
      const mod = await import(currentChunkUrl);
      if (
        typeof mod?.n === "function" &&
        mod.n.toString().includes("LoaderType")
      ) {
        state.cachedModule = mod;
        return mod;
      }
    } catch (e) {}

    const links = Array.from(
      DOC.querySelectorAll(
        'link[rel="modulepreload"][href*="/_nuxt/"], script[src*="/_nuxt/"]',
      ),
    );
    const urls = links.map((el) => el.href || el.src).filter(Boolean);

    for (const url of urls) {
      try {
        const candidate = await import(url);
        if (
          typeof candidate?.n === "function" &&
          candidate.n.toString().includes("LoaderType")
        ) {
          console.log(
            `[EbookJPInspector] 🔄 Tự động nhận diện Wasm module: ${url}`,
          );
          state.cachedModule = candidate;
          return candidate;
        }
      } catch (err) {}
    }

    throw new Error("Không tìm thấy module WasmFactory trên trang EbookJapan.");
  }

  function getBookCode() {
    const pathParts = WIN.location.pathname.split("/").filter(Boolean);
    return pathParts[2] || "EBOOKJP_BOOK";
  }

  async function ensureNuxtBookInitialized() {
    if (state.loader?.pages?.length) return state.loader;

    const pathParts = WIN.location.pathname.split("/").filter(Boolean);
    const routeType = pathParts[1] || "story";
    const routeCode = pathParts[2] || getBookCode();
    const urlSsid = new URLSearchParams(WIN.location.search).get("ssid") || "";

    const app = DOC.getElementById("__nuxt")?.__vue_app__;
    const prov = app?._context?.provides || {};
    let pinia = null;
    for (const s of Object.getOwnPropertySymbols(prov)) {
      if (prov[s]?.state?.value) {
        pinia = prov[s];
        break;
      }
    }

    let pub = pinia?.state?.value?.["viewer-liber"]?.bookInfo?.publication;

    if (!pub) {
      const nuxtEl = DOC.getElementById("__NUXT_DATA__");
      if (nuxtEl?.textContent) {
        try {
          const arr = JSON.parse(nuxtEl.textContent);
          const meta = arr.find(
            (x) => x && typeof x === "object" && x.totalPage !== undefined,
          );
          if (meta) {
            const resolve = (idx) =>
              typeof idx === "number" && arr[idx] !== undefined
                ? arr[idx]
                : idx;
            pub = {
              type: routeType,
              code: resolve(meta.bookCd || meta.storyCd || routeCode),
              ssid: urlSsid,
              name: resolve(meta.name || ""),
            };
          }
        } catch (e) {}
      }
    }

    if (!pub?.code) {
      pub = { type: routeType, code: routeCode, ssid: urlSsid };
    }

    state.publication = pub;

    const mod = await resolveWasmFactoryModule();
    let factory = null;
    for (const type of [2, 0, 1, 3]) {
      try {
        const f = mod.n(type);
        if (
          f?.constructor?.name === "WasmFactory" ||
          f?.create?.toString().includes("BunchLoader")
        ) {
          factory = f;
          break;
        }
      } catch (e) {}
    }
    if (!factory) factory = mod.n(2);

    const loader = await factory.createLoader("", void 0, undefined, false);
    await loader.open({
      type: pub.type || routeType,
      code: pub.code || routeCode,
      ssid: pub.ssid || urlSsid,
      forceResize: 1,
    });

    if (!loader.pages?.length) {
      throw new Error("Không thể khởi tạo danh sách trang từ máy chủ.");
    }

    state.loader = loader;
    state.totalPages = loader.pages.length;
    return loader;
  }

  /* =========================================================================
   * 4. HÀM GIẢI MÃ CHUNG (ZERO TAINT, ZERO COLOR LOSS, DUAL-CANDIDATE FETCH)
   * ========================================================================= */
  async function processInspectorPage(pNo) {
    const isNuxt = state.engineMode === "LIBER NUXT";
    const idx = pNo - 1;
    const Utils = window.MangaUtils || globalThis.MangaUtils;

    let pageObj = null;
    let fullUrl = "";
    let prof = null;
    let loaderInstance = null;

    if (isNuxt) {
      loaderInstance = state.loader;
      pageObj = loaderInstance.pages[idx];
      const rawImg = await loaderInstance.getDDD(idx);
      const rawUrl = rawImg?.currentSrc || rawImg?.src || "";
      const baseNoExt = rawUrl.replace(/_s(\.[a-z0-9]+)(?=([?#]|$))/i, "$1");
      fullUrl = baseNoExt.replace(/\.(webp|avif)(?=([?#]|$))/i, ".jpg");
    } else {
      pageObj = state.readerData.pages[idx];
      loaderInstance = pageObj.loader;
      if (
        !pageObj.data?.currentSrc &&
        !pageObj.data?.src &&
        typeof pageObj.getImage === "function"
      ) {
        const p = pageObj.getImage();
        if (p?.then) await p;
      }
      prof = getTargetProfile(pageObj);
      const baseNoExt = prof.rawSrc.replace(
        /_s(\.[a-z0-9]+)(?=([?#]|$))/i,
        "$1",
      );
      fullUrl = baseNoExt.replace(/\.(webp|avif)(?=([?#]|$))/i, ".jpg");
    }

    // Lưới tải 2 nấc: Ưu tiên kéo JPG Master gốc, fallback WebP Sharp
    let rawBuf = null;
    try {
      rawBuf = await Utils.fetchBuffer(fullUrl);
    } catch (e) {
      const webpUrl = fullUrl.replace(/\.jpg(?=([?#]|$))/i, ".webp");
      rawBuf = await Utils.fetchBuffer(webpUrl);
    }

    const mime = Utils.detectMimeType(rawBuf);
    const ext = Utils.detectExt(rawBuf);

    // Tạo ImageBitmap sạch 100% trong RAM (Không Tainted)
    const cleanBitmap = await createImageBitmap(
      new Blob([rawBuf], { type: mime }),
      {
        colorSpaceConversion: "none",
        premultiplyAlpha: "none",
      },
    );

    const targetW = isNuxt
      ? pageObj.width || 1440
      : prof?.width || pageObj.width || 1350;
    const targetH = isNuxt
      ? pageObj.height || 2048
      : prof?.height || pageObj.height || 1920;

    // 1. sharpCanvas sạch 100% để xuất file tải về
    const sharpCanvas = DOC.createElement("canvas");
    sharpCanvas.width = targetW;
    sharpCanvas.height = targetH;
    const sCtx = sharpCanvas.getContext("2d", { alpha: false });
    sCtx.imageSmoothingEnabled = false;
    sCtx.mozImageSmoothingEnabled = false;
    sCtx.webkitImageSmoothingEnabled = false;
    sCtx.msImageSmoothingEnabled = false;

    // 2. visualCanvas có viền Cyan #00ffff bao quanh để soi live
    const visualCanvas = DOC.createElement("canvas");
    visualCanvas.width = targetW;
    visualCanvas.height = targetH;
    const vCtx = visualCanvas.getContext("2d", { alpha: false });
    vCtx.imageSmoothingEnabled = false;
    vCtx.mozImageSmoothingEnabled = false;
    vCtx.webkitImageSmoothingEnabled = false;
    vCtx.msImageSmoothingEnabled = false;

    // BViewer nạp cấu hình Sharp trước khi shuffle
    if (!isNuxt && prof?.args && loaderInstance?.funcs?.openParam) {
      try {
        loaderInstance.funcs.openParam(prof.args);
      } catch (e) {}
    }

    const pIdx = isNuxt ? idx : Number(pageObj.page) || 0;
    const autographed = isNuxt
      ? typeof loaderInstance.getAutographed === "function"
        ? await loaderInstance.getAutographed(idx)
        : false
      : pageObj.autographed;

    loaderInstance.shuffle({
      ctx: sCtx,
      x: 0,
      y: 0,
      data: { image: cleanBitmap },
      autographed,
      page: pIdx,
    });
    loaderInstance.shuffle({
      ctx: vCtx,
      x: 0,
      y: 0,
      data: { image: cleanBitmap },
      autographed,
      page: pIdx,
    });

    // Đóng viền Cyan bao quanh khung ma trận cho visualCanvas
    vCtx.strokeStyle = "#00ffff";
    vCtx.lineWidth = 4;
    vCtx.strokeRect(0, 0, targetW, targetH);

    // 3. rawCanvas hiển thị ảnh thô CDN (có các khối đệm đen của Yahoo)
    const rawCanvas = DOC.createElement("canvas");
    rawCanvas.width = cleanBitmap.width;
    rawCanvas.height = cleanBitmap.height;
    const rCtx = rawCanvas.getContext("2d", { alpha: false });
    rCtx.imageSmoothingEnabled = false;
    rCtx.mozImageSmoothingEnabled = false;
    rCtx.webkitImageSmoothingEnabled = false;
    rCtx.msImageSmoothingEnabled = false;
    rCtx.drawImage(cleanBitmap, 0, 0);

    // 4. Tính toán phần chênh lệch khối đệm đen Wasm (Taxonomy Nhóm 4)
    const diffW = rawCanvas.width - targetW;
    const diffH = rawCanvas.height - targetH;
    const dummyText =
      diffW > 0 || diffH > 0
        ? `Khối đệm Wasm: +${diffW}px ngang, +${diffH}px dọc (Đã lọc sạch)`
        : `Khớp 100% không có viền thừa`;

    return {
      rawW: rawCanvas.width,
      rawH: rawCanvas.height,
      gridW: targetW,
      gridH: targetH,
      dummyText: dummyText,
      sharpCanvas: sharpCanvas,
      visualCanvas: visualCanvas,
      rawCanvas: rawCanvas,
      rawExt: ext.toUpperCase(),
      rawBuf: rawBuf,
      cleanBitmap: cleanBitmap,
      pageObj: pageObj,
    };
  }

  /* =========================================================================
   * 5. KHỞI CHẠY VÀ GẮN GIAO DIỆN INSPECTORUI
   * ========================================================================= */
  async function boot() {
    if (state.booting) return;
    state.booting = true;

    try {
      while (!DOC.body) await sleep(50);

      const isViewerPath = WIN.location.pathname.startsWith("/viewer");
      let foundBViewer = false;

      // Quét BViewer (hoặc trường hợp vỏ viewer ruột bviewer)
      const maxChecks = isViewerPath ? 2 : 20;
      let checkCount = 0;

      while (checkCount < maxChecks) {
        const readerInfo = findReaderInfo();
        const pages = filterValidPages(readerInfo?.reader);
        if (readerInfo && pages.length > 0) {
          state.readerData = { reader: readerInfo.reader, pages };
          state.engineMode = "BVIEWER";
          state.totalPages = pages.length;
          foundBViewer = true;
          break;
        }
        await sleep(150);
        checkCount++;
      }

      // Quét Liber Nuxt Engine
      if (!foundBViewer) {
        state.engineMode = "LIBER NUXT";
        try {
          const loader = await ensureNuxtBookInitialized();
          if (loader?.pages?.length > 0) {
            state.totalPages = loader.pages.length;
          }
        } catch (e) {}
      }

      if (!state.totalPages) return;

      const createUI = window.createInspectorUI || globalThis.createInspectorUI;
      createUI({
        title: `EBOOKJP INSPECTOR (${state.engineMode})`,
        totalPages: state.totalPages,

        onPreview: async (pNo, onSuccess, onError) => {
          try {
            const data = await processInspectorPage(pNo);
            onSuccess(data, pNo);
          } catch (e) {
            onError(e?.message || String(e));
          }
        },

        onDownload: async (pageArray, fmt, quality, statusText, btn) => {
          btn.disabled = true;
          try {
            const mimeType =
              fmt === "png"
                ? "image/png"
                : fmt === "webp"
                  ? "image/webp"
                  : "image/jpeg";

            if (pageArray.length === 1) {
              const pNo = pageArray[0];
              statusText.textContent = `Đang giải mã trang ${pNo}...`;

              const data = await processInspectorPage(pNo);
              const isJpg = fmt === "jpg";
              const decodedBuffer = await canvasToArrayBuffer(
                data.sharpCanvas,
                mimeType,
                quality,
              );

              // Tải bản 1: Raw xáo trộn gốc từ CDN Akamai (có khối đệm đen)
              const a1 = DOC.createElement("a");
              a1.href = URL.createObjectURL(new Blob([data.rawBuf]));
              a1.download = `EbookJP_Trang_${pNo}_raw.${data.rawExt.toLowerCase()}`;
              a1.click();

              // Tải bản 2: Giải mã hoàn chỉnh sạch 100% từ Wasm
              const a2 = DOC.createElement("a");
              a2.href = URL.createObjectURL(
                new Blob([decodedBuffer], { type: mimeType }),
              );
              a2.download = `EbookJP_Trang_${pNo}_decoded.${fmt}`;
              a2.click();

              statusText.textContent = `✅ Đã tải xong 2 bản trang ${pNo}!`;
            } else {
              const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
              const zip = new ZipClass();

              for (let i = 0; i < pageArray.length; i++) {
                const pNo = pageArray[i];
                statusText.textContent = `Đang xử lý: ${i + 1}/${pageArray.length} (Trang ${pNo})...`;

                const data = await processInspectorPage(pNo);
                const decodedBuffer = await canvasToArrayBuffer(
                  data.sharpCanvas,
                  mimeType,
                  quality,
                );

                zip.addFile(
                  `1_raw/${pNo}.${data.rawExt.toLowerCase()}`,
                  new Uint8Array(data.rawBuf),
                );
                zip.addFile(
                  `2_decoded/${pNo}.${fmt}`,
                  new Uint8Array(decodedBuffer),
                );

                if (
                  data.cleanBitmap &&
                  typeof data.cleanBitmap.close === "function"
                ) {
                  try {
                    data.cleanBitmap.close();
                  } catch (e) {}
                }
                if (typeof data.pageObj?.release === "function") {
                  try {
                    data.pageObj.release();
                  } catch (e) {}
                }

                await sleep(25);
              }

              statusText.textContent = `Đang đóng gói file ZIP...`;
              await sleep(60);
              zip.download(
                `EbookJP_Compare_${pageArray[0]}-${pageArray[pageArray.length - 1]}.zip`,
              );
              statusText.textContent = `✅ Đã xuất xong file ZIP đối chiếu!`;
            }
          } catch (e) {
            statusText.textContent = `❌ ${e?.message || String(e)}`;
          } finally {
            btn.disabled = false;
          }
        },
      });

      let fontShield = DOC.getElementById('ej-inspector-font-shield');
        if (!fontShield) {
          fontShield = DOC.createElement('style');
          fontShield.id = 'ej-inspector-font-shield';
          fontShield.textContent = `
            #manga-inspector-root,
            #manga-inspector-root * {
              font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif !important;
              -webkit-font-smoothing: antialiased !important;
              -moz-osx-font-smoothing: grayscale !important;
            }
            #manga-inspector-root b,
            #manga-inspector-root strong,
            #manga-inspector-root [style*="bold"] {
              font-weight: 700 !important;
            }
          `;
          (DOC.head || DOC.documentElement).appendChild(fontShield);
        }

    } finally {
      state.booting = false;
    }
  }

  // Theo dõi đổi route ngầm
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      state.readerData = null;
      state.loader = null;
      state.publication = null;
      state.totalPages = 0;
      boot();
    }
  }, 500);

  boot();
})();