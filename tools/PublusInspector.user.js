// ==UserScript==
// @name         PUBLUS Inspector
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      4.2.0
// @description  Inspector soi ma trận ACCESS PUBLUS / NFBR cho BookWalker, Pixiv Comic Store, FANZA Books và DMM Books.
// @author       anonymous & AI
// @match        https://viewer.bookwalker.jp/*/viewer.html*
// @match        https://viewer-trial.bookwalker.jp/*/viewer.html*
// @match        https://comic-store-viewer.pixiv.net/static/viewer*
// @match        https://book.dmm.com/*
// @match        https://book.dmm.co.jp/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-start
//
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/decoders/PublusTools.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/InspectorUI.js
// ==/UserScript==

(function publusInspector() {
  'use strict';
  const WIN = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const DOC = WIN.document;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  if (WIN.top !== WIN.self) return;

  const isDmm = location.hostname.includes('dmm.com') || location.hostname.includes('dmm.co.jp');
  const isFanza = location.hostname.includes('dmm.co.jp');
  const isBookWalker = location.hostname.includes('bookwalker.jp');
  const FALLBACK_WIDTH = 1440;
  const FALLBACK_HEIGHT = 2048;

    /* =========================================================================
   * 1. HOOK MAIN-WORLD CHO BOOKWALKER & PIXIV STORE (CHUẨN HOÁ SIGNATURE BẤT BIẾN)
   * ========================================================================= */
  if (!isDmm) {
    try {
      WIN.eval(`
        (function() {
          window.__bw_inspector_store = new Map();
          var isBW = window.location.hostname.includes('bookwalker.jp');
          var currentPIdx = 0;
          var currentPageMeta = null;

          // Bắt link ảnh xáo trộn từ CDN trên BookWalker qua Worker
          if (isBW) {
            var origPost = Worker.prototype.postMessage;
            if (!origPost.__bw_raw_sniff) {
              Worker.prototype.postMessage = function(data) {
                try {
                  if (data && data.url && data.url.includes('bookwalker.jp')) {
                    var pIdx = currentPIdx;
                    var img = new window.Image();
                    img.crossOrigin = 'anonymous';
                    img.onload = function() {
                      try {
                        var rawC = document.createElement('canvas');
                        rawC.width = img.naturalWidth; rawC.height = img.naturalHeight;
                        var rCtx = rawC.getContext('2d', { alpha: false });
                        rCtx.imageSmoothingEnabled = false;
                        rCtx.mozImageSmoothingEnabled = false;
                        rCtx.webkitImageSmoothingEnabled = false;
                        rCtx.msImageSmoothingEnabled = false;
                        rCtx.drawImage(img, 0, 0);

                        var existing = window.__bw_inspector_store.get(pIdx) || {};
                        window.__bw_inspector_store.set(pIdx, {
                          ...existing,
                          pIdx: pIdx,
                          rawCanvas: rawC,
                          rawW: img.naturalWidth,
                          rawH: img.naturalHeight,
                          rawUrl: data.url
                        });
                      } catch(e) {}
                    };
                    img.src = data.url;
                  }
                } catch(e) {}
                return origPost.apply(this, arguments);
              };
              origPost.__bw_raw_sniff = true;
            }
          }

          function hookNFBR() {
            var proto = window.NFBR?.a6G?.a5x?.prototype;
            if (!proto || proto.__bw_hooked) return;
            proto.__bw_hooked = true;

            for (var key in proto) {
              if (key === 'initialize' || key === 'constructor' || typeof proto[key] !== 'function') continue;

              (function(methodName) {
                var orig = proto[methodName];
                var fnLen = orig.length;

                proto[methodName] = function() {
                  var args = Array.prototype.slice.call(arguments);

                  try {
                    // 1. NHẬN DIỆN HÀM MASTER 15 THAM SỐ (X3V trên BW, x1e trên Pixiv)
                    if (fnLen === 15) {
                      var res = orig.apply(this, arguments);
                      var dummyCanvas = args[1];
                      var masterW = args[3] || 1440;
                      var masterH = args[4] || 2048;

                      if (dummyCanvas && (dummyCanvas instanceof HTMLCanvasElement || dummyCanvas.tagName === 'CANVAS') && dummyCanvas.width >= 500) {
                        var pIdx = currentPIdx;
                        var page = currentPageMeta || {};
                        var targetW = (page && typeof page.width === 'number' && page.width > 0) ? page.width : (args[3] || dummyCanvas.width);
                        var targetH = (page && typeof page.height === 'number' && page.height > 0) ? page.height : (args[4] || dummyCanvas.height);
                        
                        // Đọc chính xác toạ độ cắt từ metadata (page.rect / ContentArea / crop)
                        var rectObj = page.rect || page.Rect || page.contentArea || page.ContentArea || page.crop || {};
                        var cropX = Number(rectObj.X ?? rectObj.x ?? (masterW > targetW ? masterW - targetW : 0));
                        var cropY = Number(rectObj.Y ?? rectObj.y ?? 0);

                        var sharpC = document.createElement('canvas');
                        sharpC.width = targetW; sharpC.height = targetH;
                        var sCtx = sharpC.getContext('2d', { alpha: false });
                        sCtx.imageSmoothingEnabled = false;
                        sCtx.mozImageSmoothingEnabled = false;
                        sCtx.webkitImageSmoothingEnabled = false;
                        sCtx.msImageSmoothingEnabled = false;
                        sCtx.drawImage(dummyCanvas, cropX, cropY, targetW, targetH, 0, 0, targetW, targetH);

                        var existing = window.__bw_inspector_store.get(pIdx) || {};
                        window.__bw_inspector_store.set(pIdx, {
                          ...existing,
                          pIdx: pIdx,
                          sharpCanvas: sharpC,
                          rawCanvas: existing.rawCanvas || sharpC,
                          width: targetW, height: targetH,
                          rawW: existing.rawW || dummyCanvas.width,
                          rawH: existing.rawH || dummyCanvas.height,
                          cropX: cropX, cropY: cropY,
                          isScrambled: isBW ? (pIdx > 0) : true
                        });
                      }
                      return res;
                    }

                    // 2. NHẬN DIỆN HÀM ĐIỀU PHỐI 5 THAM SỐ (e1p trên BW, i3n trên Pixiv)
                    var page = args[1];
                    var imgSource = args[2];

                    if (page && typeof page.index === 'number') {
                      currentPIdx = page.index;
                      currentPageMeta = page;

                      if (imgSource && (imgSource instanceof ImageBitmap || imgSource instanceof HTMLImageElement || (imgSource.width >= 500 && imgSource.height >= 500))) {
                        var srcW = imgSource.naturalWidth || imgSource.width || 0;
                        var srcH = imgSource.naturalHeight || imgSource.height || 0;

                        if (srcW >= 500 && srcH >= 500) {
                          var rawC = document.createElement('canvas');
                          rawC.width = srcW; rawC.height = srcH;
                          var rCtx = rawC.getContext('2d', { alpha: false });
                          rCtx.imageSmoothingEnabled = false;
                          rCtx.mozImageSmoothingEnabled = false;
                          rCtx.webkitImageSmoothingEnabled = false;
                          rCtx.msImageSmoothingEnabled = false;
                          rCtx.drawImage(imgSource, 0, 0);

                          var existing = window.__bw_inspector_store.get(page.index) || {};
                          window.__bw_inspector_store.set(page.index, {
                            ...existing,
                            pIdx: page.index,
                            rawCanvas: rawC,
                            rawW: srcW,
                            rawH: srcH,
                            isScrambled: isBW ? (page.index > 0) : true
                          });
                        }
                      }
                    }
                  } catch(e) {}

                  return orig.apply(this, arguments);
                };
              })(key);
            }
          }

          hookNFBR();
          setInterval(hookNFBR, 150);
        })();
      `);
    } catch(e) {}
  }

  /* =========================================================================
   * 2. NHÁNH DMM & FANZA BOOKS (ĐỌC RECT.X TỪ API & GIẢI MÃ 64PX)
   * ========================================================================= */
  async function fetchDmmManifest() {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    const Tools = window.PublusTools || globalThis.PublusTools;
    const params = new URLSearchParams(WIN.location.search);
    let cid = params.get('cid');
    let lin = params.get('lin') || '1';

    if (!cid) {
      const match = WIN.location.pathname.match(/\/product\/\d+\/([a-zA-Z0-9_-]+)/);
      if (match) cid = match[1];
    }
    if (!cid) return null;

    const authUrl = `https://${WIN.location.host}/viewerapi/auth/?cid=${encodeURIComponent(cid)}&lin=${encodeURIComponent(lin)}`;
    const authBuffer = await Utils.fetchBuffer(authUrl, {
      "Accept": "application/json, text/plain, */*",
      "X-Requested-With": "XMLHttpRequest"
    });

    const rawAuth = JSON.parse(new TextDecoder().decode(authBuffer));
    const authData = rawAuth?.data || rawAuth?.result || rawAuth;

    if (!authData?.url && !authData?.base_url) return null;

    const cdnBaseUrl = (authData.url || authData.base_url).replace(/\/?$/, '/');
    const authInfo = authData.auth_info || authData.authInfo || {};
    const authQuery = typeof authInfo === 'string' ? authInfo : new URLSearchParams(authInfo).toString();

    let configData = null;
    let isNeedNormalDefault = false;

    try {
      const buf = await Utils.fetchBuffer(`${cdnBaseUrl}configuration_pack.json?${authQuery}`);
      configData = JSON.parse(new TextDecoder().decode(buf));
    } catch (e) {
      const buf = await Utils.fetchBuffer(`${cdnBaseUrl}normal_default/configuration_pack.json?${authQuery}`);
      configData = JSON.parse(new TextDecoder().decode(buf));
      isNeedNormalDefault = true;
    }

    if (!configData?.configuration?.contents) return null;

    const pages = [];
    for (const content of configData.configuration.contents) {
      const filename = content.file;
      const isShareFile = filename.includes('../');
      const fileData = configData[filename] || configData[filename.replace('../', '')];
      const fileInfo = fileData?.FileLinkInfo;
      const pageCount = fileInfo?.PageCount || 1;
      const pageLinkList = fileInfo?.PageLinkInfoList || [];

      for (let idx = 0; idx < pageCount; idx++) {
        const fileSubPath = isNeedNormalDefault
          ? `normal_default/${isShareFile ? filename.replace('../', '') : filename}/${idx}.jpeg`
          : `${filename}/${idx}.jpeg`;

        const pageData = pageLinkList[idx]?.Page || {};
        const size = pageData.Size || { Width: FALLBACK_WIDTH, Height: FALLBACK_HEIGHT };
        const rect = pageData.Rect || pageData.ContentArea || {};

        pages.push({
          pageNo: pages.length + 1,
          url: `${cdnBaseUrl}${fileSubPath}?${authQuery}`,
          pattern: Tools.computePattern(`${filename}/${idx}`),
          width: Number(size.Width || size.width || FALLBACK_WIDTH),
          height: Number(size.Height || size.height || FALLBACK_HEIGHT),
          rectX: Number(rect.X ?? rect.x ?? 0),
          rectY: Number(rect.Y ?? rect.y ?? 0)
        });
      }
    }

    const isFanzaSite = WIN.location.hostname.includes('dmm.co.jp');
    const brandTitle = isFanzaSite ? "FANZA Books" : "DMM Books";
    return { title: authData.cti || rawAuth.cti || brandTitle, pages };
  }

  async function processDmmInspectorPage(pageObj) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    const Tools = window.PublusTools || globalThis.PublusTools;

    const rawBuffer = await Utils.fetchBuffer(pageObj.url);
    const ext = Utils.detectExt(rawBuffer);
    const mime = Utils.detectMimeType(rawBuffer);
    const img = await Utils.loadImage(rawBuffer, mime);

    const rawW = img.width;
    const rawH = img.height;
    const targetW = pageObj.width;
    const targetH = pageObj.height;

    // Tọa độ cắt đọc trực tiếp từ Page.Rect.X của manifest JSON
    const cropX = Number(pageObj.rectX ?? 0);
    const cropY = Number(pageObj.rectY ?? 0);

    // 1. tempCanvas: Giải mã toàn bộ container rawW x rawH (KHÔNG lót nền trắng)
    const tempCanvas = DOC.createElement('canvas');
    tempCanvas.width = rawW;
    tempCanvas.height = rawH;
    const tCtx = tempCanvas.getContext('2d', { alpha: false });
    tCtx.imageSmoothingEnabled = false;
    tCtx.mozImageSmoothingEnabled = false;
    tCtx.webkitImageSmoothingEnabled = false;
    tCtx.msImageSmoothingEnabled = false;

    const coords = Tools.PublusCoordsGenerator(rawW, rawH, 64, 64, pageObj.pattern);
    for (const piece of coords) {
      tCtx.drawImage(img, piece.destX, piece.destY, piece.width, piece.height, piece.srcX, piece.srcY, piece.width, piece.height);
    }

    // 2. sharpCanvas: Bản xuất tải về sạch đúng targetW x targetH (Đã gọt chuẩn theo Rect.X)
    const sharpCanvas = DOC.createElement('canvas');
    sharpCanvas.width = targetW;
    sharpCanvas.height = targetH;
    const sCtx = sharpCanvas.getContext('2d', { alpha: false });
    sCtx.imageSmoothingEnabled = false;
    sCtx.mozImageSmoothingEnabled = false;
    sCtx.webkitImageSmoothingEnabled = false;
    sCtx.msImageSmoothingEnabled = false;
    sCtx.drawImage(tempCanvas, cropX, cropY, targetW, targetH, 0, 0, targetW, targetH);

    // 3. visualCanvas (HIỂN THỊ LIVE: rawW x rawH + Viền Cyan 4px toàn ảnh + Khung Hồng 2px vùng tranh)
    const visualCanvas = DOC.createElement('canvas');
    visualCanvas.width = rawW;
    visualCanvas.height = rawH;
    const vCtx = visualCanvas.getContext('2d', { alpha: false });
    vCtx.imageSmoothingEnabled = false;
    vCtx.mozImageSmoothingEnabled = false;
    vCtx.webkitImageSmoothingEnabled = false;
    vCtx.msImageSmoothingEnabled = false;
    vCtx.drawImage(tempCanvas, 0, 0);

    // Viền Cyan 4px toàn bộ ảnh gốc container
    vCtx.strokeStyle = '#00ffff';
    vCtx.lineWidth = 4;
    vCtx.strokeRect(0, 0, rawW, rawH);

    // Khung Hồng 2px ôm sát vùng tranh thật theo đúng toạ độ cropX
    const diffW = rawW - targetW;
    const diffH = rawH - targetH;
    if (diffW > 0 || diffH > 0 || cropX > 0 || cropY > 0) {
      vCtx.strokeStyle = '#ff007f';
      vCtx.lineWidth = 2;
      vCtx.strokeRect(cropX, cropY, targetW, targetH);
    }

    // 4. rawCanvas: Bản ảnh xáo trộn thô từ CDN
    const rawCanvas = DOC.createElement('canvas');
    rawCanvas.width = rawW;
    rawCanvas.height = rawH;
    const rCtx = rawCanvas.getContext('2d', { alpha: false });
    rCtx.imageSmoothingEnabled = false;
    rCtx.mozImageSmoothingEnabled = false;
    rCtx.webkitImageSmoothingEnabled = false;
    rCtx.msImageSmoothingEnabled = false;
    rCtx.drawImage(img, 0, 0);

    const dummyText = (diffW > 0 || diffH > 0)
      ? `Vùng đệm bỏ: Dư ${diffW}px ngang, ${diffH}px dọc (Đã gọt sạch)`
      : `Khớp 100% không có viền thừa`;

    return {
      rawW, rawH, gridW: targetW, gridH: targetH,
      dummyText,
      sharpCanvas, visualCanvas, rawCanvas, img,
      rawExt: ext.toUpperCase(), rawBuf: rawBuffer,
      isScrambled: true
    };
  }

  /* =========================================================================
   * 3. NHÁNH BOOKWALKER & PIXIV STORE (RUNTIME HOOK)
   * ========================================================================= */
  function getNFBRRuntime(targetWin = WIN) {
    try {
      const a6G = targetWin.NFBR?.a6G;
      if (!a6G) return null;

      let obj = isBookWalker ? (a6G.Initializer?.T1V || a6G.Initial?.T1V) : (a6G.Initializer?.F7F || a6G.Initial?.F7F);
      if (!obj && a6G.Initializer) {
        for (const k of Object.keys(a6G.Initializer)) {
          const cand = a6G.Initializer[k];
          if (cand && (cand.menu || cand.renderer || cand.model)) { obj = cand; break; }
        }
      }
      if (!obj) return null;

      const menu = obj.menu?.a6l || obj.a6l || obj.menu || (typeof obj.moveToPage === 'function' ? obj : null);
      const renderer = obj.renderer || menu?.renderer || obj.viewer_;
      const model = renderer?.model || obj.viewer_?.model || obj.model || menu?.model;

      return { init: obj, menu, renderer, model };
    } catch (e) { return null; }
  }

  function getModelProperty(obj, key) {
    try { if (typeof obj?.get === "function") return obj.get(key); } catch (e) {}
    return obj?.attributes?.[key];
  }

  function parsePositiveInt(val, fallback = 0) {
    const n = Number(val);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  }

  function addPageToMap(pageMap, pageData, index) {
    if (!pageData && !Number.isFinite(index)) return;
    const pageIdx = Number.isFinite(Number(pageData?.index)) ? Number(pageData.index) : Number(index);
    if (!Number.isFinite(pageIdx) || pageIdx < 0) return;

    const w = parsePositiveInt(pageData?.width, FALLBACK_WIDTH);
    const h = parsePositiveInt(pageData?.height, FALLBACK_HEIGHT);

    const existing = pageMap.get(pageIdx) || {};
    pageMap.set(pageIdx, {
      ...existing,
      index: pageIdx,
      width: parsePositiveInt(existing.width, w),
      height: parsePositiveInt(existing.height, h)
    });
  }

  function getPageListFromNFBR(rt) {
    const model = rt.model;
    const attr = model?.attributes || model || {};
    const a2u = getModelProperty(model, "a2u") || attr.a2u || {};
    const content = getModelProperty(model, "content") || attr.content || attr.configuration || {};
    const configContents = content.configuration?.contents || content.contents || attr.contents || [];
    const files = content.files || attr.files || [];

    const pageMap = new Map();
    const spreadsList = a2u.r8q || a2u.L3Y || a2u.l3Y || attr.viewerWideScreenSpreads || [];

    if (Array.isArray(spreadsList)) {
      for (const spread of spreadsList) {
        if (spread.left) addPageToMap(pageMap, spread.left, spread.left?.index);
        if (spread.right) addPageToMap(pageMap, spread.right, spread.right?.index);
        if (Number.isFinite(spread.pageIndex)) addPageToMap(pageMap, spread, spread.pageIndex);
      }
    }

    if (Array.isArray(configContents)) {
      configContents.forEach((cItem, idx) => addPageToMap(pageMap, cItem, idx));
    }
    if (Array.isArray(files)) {
      files.forEach((fItem, idx) => addPageToMap(pageMap, fItem, idx));
    }

    return Array.from(pageMap.values())
      .filter(p => Number.isFinite(p.index) && p.index >= 0)
      .sort((a, b) => a.index - b.index);
  }

  async function fetchBwPage(pNo, rt) {
    const pIdx = pNo - 1;
    const store = WIN.__bw_inspector_store;

    // 1. Phản hồi 0ms nếu RAM đã nạp xong
    if (store?.has(pIdx) && store.get(pIdx).sharpCanvas) {
      const item = store.get(pIdx);
      if (!item.rawCanvas) item.rawCanvas = item.sharpCanvas;
      return item;
    }

    const liveRt = rt || getNFBRRuntime(WIN);
    const menu = liveRt?.menu;
    const model = liveRt?.model;

    // 2. Kích hoạt lật trang
    try {
      if (typeof menu?.moveToPage === 'function') menu.moveToPage(pIdx);
      else if (typeof menu?.a6l?.moveToPage === 'function') menu.a6l.moveToPage(pIdx);
      else if (typeof model?.set === 'function') model.set('viewerPage', pIdx);
    } catch(e) {}

    // 3. Vòng lặp chờ nạp
    const start = Date.now();
    while (Date.now() - start < 8000) {
      if (store?.has(pIdx) && store.get(pIdx).sharpCanvas) {
        await sleep(60);
        const item = store.get(pIdx);
        if (!item.rawCanvas) item.rawCanvas = item.sharpCanvas;
        return item;
      }
      await sleep(100);
    }

    throw new Error(`Chưa tải được trang ${pNo}. Hãy lật đến trang đó trên viewer rồi bấm lại.`);
  }

  /* =========================================================================
   * 4. KHỞI CHẠY GIAO DIỆN INSPECTORUI
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(50);

    const createUI = window.createInspectorUI || globalThis.createInspectorUI;

    // ==========================================
    // NHÁNH A: DMM & FANZA BOOKS (CÓ RETRY LOOP)
    // ==========================================
    if (isDmm) {
      let dmmData = null;
      let retries = 0;

      while (retries < 25) {
        try {
          dmmData = await fetchDmmManifest();
          if (dmmData?.pages?.length) break;
        } catch (e) {}
        await sleep(150);
        retries++;
      }
      if (!dmmData?.pages?.length) return;

      const titleName = isFanza ? "PUBLUS INSPECTOR (FANZA BOOKS)" : "PUBLUS INSPECTOR (DMM BOOKS)";

      createUI({
        title: titleName,
        totalPages: dmmData.pages.length,
        onPreview: async (pNo, onSuccess, onError) => {
          const pageObj = dmmData.pages[pNo - 1];
          if (!pageObj) return onError("Trang không tồn tại!");
          try {
            const res = await processDmmInspectorPage(pageObj);
            onSuccess(res, pNo);
          } catch (e) { onError(e?.message || String(e)); }
        },
        onDownload: async (pageArray, fmt, quality, statusText, btn) => {
          btn.disabled = true;
          try {
            const mimeType = fmt === 'png' ? 'image/png' : (fmt === 'webp' ? 'image/webp' : 'image/jpeg');

            if (pageArray.length === 1) {
              const pNo = pageArray[0];
              const pageObj = dmmData.pages[pNo - 1];
              const res = await processDmmInspectorPage(pageObj);

              const a1 = DOC.createElement('a'); a1.href = URL.createObjectURL(new Blob([res.rawBuf], { type: 'image/jpeg' }));
              a1.download = `DMM_Trang_${pNo}_raw.jpg`; a1.click();

              const a2 = DOC.createElement('a');
              a2.href = URL.createObjectURL(await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality)));
              a2.download = `DMM_Trang_${pNo}_decoded.${fmt}`; a2.click();
              statusText.textContent = `✅ Đã tải xong 2 bản trang ${pNo}!`;
            } else {
              const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
              const zip = new ZipClass();

              for (let i = 0; i < pageArray.length; i++) {
                const pNo = pageArray[i];
                statusText.textContent = `Đang giải mã: ${i + 1}/${pageArray.length} (Trang ${pNo})...`;
                const pageObj = dmmData.pages[pNo - 1];
                const res = await processDmmInspectorPage(pageObj);

                const sharpBlob = await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality));
                zip.addFile(`1_raw/${pNo}.jpg`, new Uint8Array(res.rawBuf));
                zip.addFile(`2_decoded/${pNo}.${fmt}`, new Uint8Array(await sharpBlob.arrayBuffer()));
              }

              statusText.textContent = `Đang đóng gói file ZIP...`;
              await sleep(60);
              zip.download(`DMM_Compare_${pageArray[0]}-${pageArray[pageArray.length - 1]}.zip`);
              statusText.textContent = `✅ Đã xuất xong file ZIP đối chiếu!`;
            }
          } catch (e) {
            statusText.textContent = `❌ ${e?.message || String(e)}`;
          } finally {
            btn.disabled = false;
          }
        }
      });
      return;
    }

    // ==========================================
    // NHÁNH B: BOOKWALKER & PIXIV STORE
    // ==========================================
    let rt = null;
    let pagesList = [];
    let attempts = 0;

    while (attempts < 60) {
      rt = getNFBRRuntime(WIN);
      if (rt) {
        try {
          pagesList = getPageListFromNFBR(rt);
          if (pagesList.length > 0) break;
        } catch (e) {}
      }
      await sleep(150);
      attempts++;
    }

    if (!pagesList.length) return;

    const siteTitle = isBookWalker ? "PUBLUS INSPECTOR (BOOKWALKER)" : "PUBLUS INSPECTOR (PIXIVCOMIC)";

    createUI({
      title: siteTitle,
      totalPages: pagesList.length,
      onPreview: async (pNo, onSuccess, onError) => {
          try {
            const res = await fetchBwPage(pNo, rt);

            const rawW = res.rawW || res.width;
            const rawH = res.rawH || res.height;
            const targetW = res.width;
            const targetH = res.height;
            const cropX = Number(res.cropX ?? (rawW > targetW ? rawW - targetW : 0));
            const cropY = Number(res.cropY ?? (rawH > targetH ? rawH - targetH : 0));

            // visualCanvas (HIỂN THỊ LIVE: rawW x rawH + Viền Cyan 4px + Khung Hồng 2px)
            const visualCanvas = DOC.createElement('canvas');
            visualCanvas.width = rawW;
            visualCanvas.height = rawH;
            const vCtx = visualCanvas.getContext('2d', { alpha: false });
            vCtx.imageSmoothingEnabled = false;
            vCtx.mozImageSmoothingEnabled = false;
            vCtx.webkitImageSmoothingEnabled = false;
            vCtx.msImageSmoothingEnabled = false;

            // Vẽ ảnh giải mã lên nền container
            vCtx.drawImage(res.sharpCanvas, cropX, cropY);

            // Viền Cyan 4px toàn bộ ảnh container
            vCtx.strokeStyle = '#00ffff';
            vCtx.lineWidth = 4;
            vCtx.strokeRect(0, 0, rawW, rawH);

            const diffW = rawW - targetW;
            const diffH = rawH - targetH;

            // Khung Hồng 2px ôm sát đúng vùng tranh thật theo toạ độ cropX
            if (diffW > 0 || diffH > 0 || cropX > 0 || cropY > 0) {
              vCtx.strokeStyle = '#ff007f';
              vCtx.lineWidth = 2;
              vCtx.strokeRect(cropX, cropY, targetW, targetH);
            }

            const dummyText = (diffW > 0 || diffH > 0)
              ? `Vùng đệm bỏ: Dư ${diffW}px ngang, ${diffH}px dọc (Đã gọt sạch)`
              : `Khớp 100% không có viền thừa`;

            const validRawCanvas = res.rawCanvas || res.sharpCanvas;
            const isScrambled = Boolean(res.isScrambled ?? (pNo > 1 || !isBookWalker));

            onSuccess({
              rawW: rawW, rawH: rawH, gridW: targetW, gridH: targetH,
              dummyText: dummyText,
              sharpCanvas: res.sharpCanvas,
              visualCanvas: visualCanvas,
              rawCanvas: validRawCanvas,
              img: validRawCanvas,
              rawExt: "JPG",
              isScrambled: isScrambled
            }, pNo);
          } catch (e) { onError(e?.message || String(e)); }
        },
      onDownload: async (pageArray, fmt, quality, statusText, btn) => {
        btn.disabled = true;
        try {
          const mimeType = fmt === 'png' ? 'image/png' : (fmt === 'webp' ? 'image/webp' : 'image/jpeg');

          if (pageArray.length === 1) {
            const pNo = pageArray[0];
            const res = await fetchBwPage(pNo, rt);
            const rawBlob = await new Promise(r => res.rawCanvas.toBlob(r, 'image/jpeg', 0.98));
            const sharpBlob = await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality));

            const a1 = DOC.createElement('a'); a1.href = URL.createObjectURL(rawBlob); a1.download = `Publus_Trang_${pNo}_raw.jpg`; a1.click();
            const a2 = DOC.createElement('a'); a2.href = URL.createObjectURL(sharpBlob); a2.download = `Publus_Trang_${pNo}_decoded.${fmt}`; a2.click();
            statusText.textContent = `✅ Đã tải xong 2 bản trang ${pNo}!`;
          } else {
            const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
            const zip = new ZipClass();
            for (let i = 0; i < pageArray.length; i++) {
              const pNo = pageArray[i];
              statusText.textContent = `Đang tải: ${i + 1}/${pageArray.length} (Trang ${pNo})...`;
              const res = await fetchBwPage(pNo, rt);
              const rawBlob = await new Promise(r => res.rawCanvas.toBlob(r, 'image/jpeg', 0.98));
              const sharpBlob = await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality));

              zip.addFile(`1_raw/${pNo}.jpg`, new Uint8Array(await rawBlob.arrayBuffer()));
              zip.addFile(`2_decoded/${pNo}.${fmt}`, new Uint8Array(await sharpBlob.arrayBuffer()));
            }
            statusText.textContent = `Đang đóng gói file ZIP...`;
            await sleep(60);
            zip.download(`Publus_Compare_${pageArray[0]}-${pageArray[pageArray.length - 1]}.zip`);
            statusText.textContent = `✅ Đã xuất xong file ZIP đối chiếu!`;
          }
        } catch (e) { statusText.textContent = `❌ ${e?.message || String(e)}`; } finally { btn.disabled = false; }
      }
    });
  }

  let lastUrl = location.href;
  setInterval(() => { if (location.href !== lastUrl) { lastUrl = location.href; boot(); } }, 500);
  boot();
})();