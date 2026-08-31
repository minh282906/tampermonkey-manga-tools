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
   * 1. HOOK MAIN-WORLD CHO BOOKWALKER & PIXIV STORE
   * ========================================================================= */
  if (!isDmm) {
    try {
      WIN.eval(`
        (function() {
          window.__bw_inspector_store = new Map();
          try {
            var nativeImg = window.Image;
            window.Image = class extends nativeImg {
              constructor(w, h) { super(w, h); this.crossOrigin = 'anonymous'; }
            };
          } catch(e) {}

          var isBW = window.location.hostname.includes('bookwalker.jp');

          function hookNFBR() {
            var proto = window.NFBR?.a6G?.a5x?.prototype;
            if (!proto || proto.__bw_hooked) return;
            proto.__bw_hooked = true;

            for (var key in proto) {
              if (key === 'initialize' || key === 'constructor' || typeof proto[key] !== 'function') continue;
              if (!isBW && proto[key].length !== 5) continue;

              (function(methodName) {
                var orig = proto[methodName];
                proto[methodName] = function() {
                  var args = Array.prototype.slice.call(arguments);
                  var page = args[1], image = args[2], flag = args[4];

                  if (image && (image.naturalWidth || image.width) && (image.naturalHeight || image.height)) {
                    var imgW = image.naturalWidth || image.width;
                    var imgH = image.naturalHeight || image.height;

                    if (imgW > 100 && imgH > 100) {
                      try {
                        var pIdx = 0;
                        if (page && typeof page.index === 'number') pIdx = page.index;
                        else if (page && typeof page.No === 'number') pIdx = page.No - 1;
                        else {
                          var init = window.NFBR?.a6G?.Initializer?.T1V || window.NFBR?.a6G?.Initializer?.F7F || window.NFBR?.a6G?.Initial?.T1V;
                          pIdx = Number(init?.menu?.model?.get?.('viewerPage') ?? init?.model?.get?.('viewerPage') ?? 0);
                        }

                        var rawCanvas = document.createElement('canvas');
                        rawCanvas.width = imgW; rawCanvas.height = imgH;
                        var rawCtx = rawCanvas.getContext('2d', { alpha: false });
                        rawCtx.imageSmoothingEnabled = false;
                        rawCtx.drawImage(image, 0, 0, imgW, imgH);

                        var sharpCanvas = document.createElement('canvas');
                        sharpCanvas.width = imgW; sharpCanvas.height = imgH;
                        var sharpCtx = sharpCanvas.getContext('2d', { alpha: false });
                        sharpCtx.imageSmoothingEnabled = false;
                        sharpCtx.mozImageSmoothingEnabled = false;
                        sharpCtx.webkitImageSmoothingEnabled = false;
                        sharpCtx.msImageSmoothingEnabled = false;
                        sharpCtx.fillStyle = '#ffffff'; sharpCtx.fillRect(0, 0, imgW, imgH);
                        orig.call(this, sharpCanvas, page, image, { x: 0, y: 0, width: imgW, height: imgH }, flag);

                        window.__bw_inspector_store.set(pIdx, {
                          pIdx: pIdx, rawCanvas: rawCanvas, sharpCanvas: sharpCanvas, width: imgW, height: imgH
                        });
                      } catch (e) {}
                    }
                  }
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
   * 2. NHÁNH DMM & FANZA BOOKS (THUẦN TOÁN HỌC QUA API & PUBLUSTOOLS)
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

        pages.push({
          pageNo: pages.length + 1,
          url: `${cdnBaseUrl}${fileSubPath}?${authQuery}`,
          pattern: Tools.computePattern(`${filename}/${idx}`),
          width: pageLinkList[idx]?.Page?.Size?.Width || FALLBACK_WIDTH,
          height: pageLinkList[idx]?.Page?.Size?.Height || FALLBACK_HEIGHT
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

    // 1. sharpCanvas (sạch 100% để xuất tải về)
    const sharpCanvas = DOC.createElement('canvas');
    sharpCanvas.width = pageObj.width;
    sharpCanvas.height = pageObj.height;
    const sCtx = sharpCanvas.getContext('2d', { alpha: false });
    sCtx.imageSmoothingEnabled = false;
    sCtx.mozImageSmoothingEnabled = false;
    sCtx.webkitImageSmoothingEnabled = false;
    sCtx.msImageSmoothingEnabled = false;
    sCtx.fillStyle = '#ffffff';
    sCtx.fillRect(0, 0, sharpCanvas.width, sharpCanvas.height);

    const coords = Tools.PublusCoordsGenerator(img.width, img.height, 64, 64, pageObj.pattern);
    for (const piece of coords) {
      sCtx.drawImage(img, piece.destX, piece.destY, piece.width, piece.height, piece.srcX, piece.srcY, piece.width, piece.height);
    }

    // 2. visualCanvas (Soi Live: viền Cyan #00ffff 4px)
    const visualCanvas = DOC.createElement('canvas');
    visualCanvas.width = pageObj.width;
    visualCanvas.height = pageObj.height;
    const vCtx = visualCanvas.getContext('2d', { alpha: false });
    vCtx.imageSmoothingEnabled = false;
    vCtx.drawImage(sharpCanvas, 0, 0);
    vCtx.strokeStyle = '#00ffff';
    vCtx.lineWidth = 4;
    vCtx.strokeRect(0, 0, visualCanvas.width, visualCanvas.height);

    // 3. rawCanvas (ảnh thô CDN xáo trộn)
    const rawCanvas = DOC.createElement('canvas');
    rawCanvas.width = img.width;
    rawCanvas.height = img.height;
    const rCtx = rawCanvas.getContext('2d', { alpha: false });
    rCtx.imageSmoothingEnabled = false;
    rCtx.drawImage(img, 0, 0);

    return {
      rawW: img.width, rawH: img.height, gridW: pageObj.width, gridH: pageObj.height,
      dummyText: "Khớp 100% không có viền thừa",
      sharpCanvas, visualCanvas, rawCanvas, img,
      rawExt: ext.toUpperCase(), rawBuf: rawBuffer
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

    if (store?.has(pIdx) && store.get(pIdx).rawCanvas) {
      return store.get(pIdx);
    }

    const liveRt = rt || getNFBRRuntime(WIN);
    const menu = liveRt?.menu;
    const model = liveRt?.model;

    try {
      if (typeof menu?.moveToPage === 'function') menu.moveToPage(pIdx);
      else if (typeof menu?.a6l?.moveToPage === 'function') menu.a6l.moveToPage(pIdx);
      else if (typeof model?.set === 'function') model.set('viewerPage', pIdx);
    } catch(e) {}

    const start = Date.now();
    while (Date.now() - start < 8000) {
      if (store?.has(pIdx) && store.get(pIdx).rawCanvas) {
        await sleep(60);
        return store.get(pIdx);
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

          // Tạo visualCanvas có viền Cyan 4px
          const visualCanvas = DOC.createElement('canvas');
          visualCanvas.width = res.width;
          visualCanvas.height = res.height;
          const vCtx = visualCanvas.getContext('2d', { alpha: false });
          vCtx.imageSmoothingEnabled = false;
          vCtx.drawImage(res.sharpCanvas, 0, 0);
          vCtx.strokeStyle = '#00ffff';
          vCtx.lineWidth = 4;
          vCtx.strokeRect(0, 0, visualCanvas.width, visualCanvas.height);

          onSuccess({
            rawW: res.width, rawH: res.height, gridW: res.width, gridH: res.height,
            dummyText: "Khớp 100% không có viền thừa",
            sharpCanvas: res.sharpCanvas, visualCanvas: visualCanvas, rawCanvas: res.rawCanvas, img: res.rawCanvas,
            rawExt: "JPG"
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