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
  * BỘ TÍNH TOÁN HÌNH HỌC VÙNG ĐỆM ĐỘNG (PADDING) - CHUẨN ĐẶC TẢ 100%
  * ========================================================================= */
  function calcPaddingGeometry(rawW, rawH, targetW, targetH, flag = null, pIdx = 0, rectX = null, rectY = null) {
    const diffW = Math.max(0, rawW - targetW);
    const diffH = Math.max(0, rawH - targetH);

    let cropX = 0;
    let cropY = (typeof rectY === 'number' && rectY !== null) ? rectY : 0;

    if (diffW > 0) {
      if (typeof rectX === 'number' && rectX !== null) {
        // 1. NHÁNH DMM: Đọc thẳng tọa độ từ file JSON manifest
        cropX = rectX;
      } else if (flag === 2) {
        // 2. NHÁNH PIXIV/BW: Cờ flag = 2 (Trang đơn / Bìa căn giữa)
        cropX = Math.ceil(diffW / 2);
      } else if (flag === 1) {
        // 3. NHÁNH PIXIV/BW: Cờ flag = 1 (Trang đôi bên Trái)
        cropX = diffW;
      } else {
        // 4. NHÁNH PIXIV/BW: Cờ flag = 0 (Trang đôi bên Phải)
        cropX = 0;
      }
    }

    const padLeft   = cropX;
    const padRight  = Math.max(0, rawW - (cropX + targetW));
    const padTop    = cropY;
    const padBottom = Math.max(0, diffH - padTop);
    const hasPadding = padLeft > 0 || padRight > 0 || padTop > 0 || padBottom > 0;

    let dummyText = "Khớp 100% không có viền thừa";
    if (hasPadding) {
      const parts = [];
      if (padLeft > 0 && padRight > 0) parts.push(`${padLeft}px trái, ${padRight}px phải`);
      else if (padLeft > 0) parts.push(`${padLeft}px trái`);
      else if (padRight > 0) parts.push(`${padRight}px phải`);

      if (padTop > 0 && padBottom > 0) parts.push(`${padTop}px trên, ${padBottom}px đáy`);
      else if (padTop > 0) parts.push(`${padTop}px trên`);
      else if (padBottom > 0) parts.push(`${padBottom}px đáy`);

      dummyText = `Vùng đệm bỏ: Dư ${parts.join(' | ')} (Đã gọt sạch)`;
    }

    return { cropX, cropY, padLeft, padRight, padTop, padBottom, hasPadding, dummyText };
  }

  /* =========================================================================
   * 1. HOOK MAIN-WORLD CHO BOOKWALKER & PIXIV STORE (CÔ LẬP & ĐỐI CHIẾU FILE GỐC)
   * ========================================================================= */
  if (!isDmm) {
    try {
      WIN.eval(`
        (function() {
          window.__bw_inspector_store = new Map();
          var isBW = window.location.hostname.includes('bookwalker.jp');
          var currentPIdx = 0;
          var currentPageMeta = null;

          // =====================================================================
          // BẮT LINK CDN ĐỐI CHIẾU CHÍNH XÁC THEO TÊN FILE (CHỐNG LỖI PRELOAD TRANG)
          // =====================================================================
          if (isBW) {
            function getPageIndexFromUrl(url) {
              try {
                var init = window.NFBR?.a6G?.Initializer?.T1V || window.NFBR?.a6G?.Initial?.T1V;
                var model = init?.menu?.model || init?.model;
                var content = model?.get?.('content') || model?.attributes?.content || {};
                var contents = content.configuration?.contents || content.contents || [];

                for (var i = 0; i < contents.length; i++) {
                  var f = contents[i]?.file || contents[i]?.src || '';
                  var baseName = f.split('/').pop().replace(/\\.[^.]+$/, '');
                  if (baseName && url.includes(baseName)) {
                    return i;
                  }
                }
              } catch(e) {}
              return -1;
            }

            var origPost = Worker.prototype.postMessage;
            if (!origPost.__bw_raw_sniff) {
              Worker.prototype.postMessage = function(data) {
                try {
                  if (data && data.url && data.url.includes('bookwalker.jp')) {
                    // Đối chiếu đúng trang sở hữu file này (không dùng currentPIdx)
                    var targetIdx = getPageIndexFromUrl(data.url);
                    if (targetIdx >= 0) {
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

                          var existing = window.__bw_inspector_store.get(targetIdx) || {};
                          window.__bw_inspector_store.set(targetIdx, {
                            ...existing,
                            pIdx: targetIdx,
                            rawCanvas: rawC,
                            rawW: img.naturalWidth,
                            rawH: img.naturalHeight,
                            rawUrl: data.url
                          });
                        } catch(e) {}
                      };
                      img.src = data.url;
                    }
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
                    // =================================================================
                    // 1. HÀM 15 THAM SỐ (X3V / x1e): Bắt Master Canvas sạch 100% từ Web Worker
                    // =================================================================
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

                        var existing = window.__bw_inspector_store.get(pIdx) || {};
                        var flag = existing.flag ?? (pIdx === 0 ? 2 : 0);
                        var diffW = dummyCanvas.width > targetW ? (dummyCanvas.width - targetW) : 0;
                        var cropX = (flag === 2 || pIdx === 0) ? Math.ceil(diffW / 2) : (flag === 1 ? diffW : 0);

                        // 1. CLONE masterCanvas ĐỘC LẬP TRONG RAM (Chống bị BookWalker clearRect xoá đen trên UI)
                        var masterC = document.createElement('canvas');
                        masterC.width = dummyCanvas.width;
                        masterC.height = dummyCanvas.height;
                        var mCtx = masterC.getContext('2d', { alpha: false });
                        mCtx.imageSmoothingEnabled = false;
                        mCtx.drawImage(dummyCanvas, 0, 0);

                        // 2. TẠO sharpCanvas ĐÃ GỌT SẠCH PADDING ĐỂ TẢI VỀ
                        var sharpC = document.createElement('canvas');
                        sharpC.width = targetW; sharpC.height = targetH;
                        var sCtx = sharpC.getContext('2d', { alpha: false });
                        sCtx.imageSmoothingEnabled = false;
                        sCtx.drawImage(masterC, cropX, 0, targetW, targetH, 0, 0, targetW, targetH);

                        window.__bw_inspector_store.set(pIdx, {
                          ...existing,
                          pIdx: pIdx,
                          sharpCanvas: sharpC,
                          masterCanvas: masterC, // Đã lưu bản clone an toàn!
                          rawCanvas: existing.rawCanvas || sharpC,
                          width: targetW, height: targetH,
                          rawW: existing.rawW || dummyCanvas.width,
                          rawH: existing.rawH || dummyCanvas.height,
                          flag: flag,
                          isScrambled: true
                        });
                      }
                      return res;
                    }

                    // =================================================================
                    // 2. HÀM 5 THAM SỐ (e1p / i3n): Theo dõi số trang, cờ flag và bắt ảnh thô
                    // Tuyệt đối KHÔNG gọi orig.call để tránh bị dính Watermark/Barcode 2px
                    // =================================================================
                    if (fnLen === 5) {
                      var page = args[1];
                      var imgSource = args[2];
                      var flag = args[4];

                      if (page && typeof page.index === 'number') {
                        currentPIdx = page.index;
                        currentPageMeta = page;

                        var existing = window.__bw_inspector_store.get(page.index) || {};
                        if (flag !== undefined) existing.flag = flag;

                        var isRealDrawable = imgSource && (
                          imgSource instanceof HTMLImageElement ||
                          imgSource instanceof HTMLCanvasElement ||
                          (typeof ImageBitmap !== 'undefined' && imgSource instanceof ImageBitmap) ||
                          imgSource.tagName === 'IMG' ||
                          imgSource.tagName === 'CANVAS'
                        );

                        if (isRealDrawable) {
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

                            existing.rawCanvas = rawC;
                            existing.rawW = srcW;
                            existing.rawH = srcH;

                            // Đối với trang bìa / trang không xáo trộn (không đi qua hàm 15 tham số)
                            // Lưu trực tiếp rawC làm Master sạch nguyên bản, không qua xử lý co rút
                            if (!existing.sharpCanvas) {
                              existing.sharpCanvas = rawC;
                              existing.masterCanvas = rawC;
                              existing.width = srcW;
                              existing.height = srcH;
                              existing.isScrambled = false;
                            }
                          }
                        }

                        window.__bw_inspector_store.set(page.index, {
                          ...existing,
                          pIdx: page.index
                        });
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

    // 3. visualCanvas (Dán tranh sạch tại geo.cropX, geo.cropY + Tô hồng dải padding)
    const geo = calcPaddingGeometry(rawW, rawH, targetW, targetH, null, pageObj.pageNo - 1, cropX, cropY);

    const visualCanvas = DOC.createElement('canvas');
    visualCanvas.width = rawW;
    visualCanvas.height = rawH;
    const vCtx = visualCanvas.getContext('2d', { alpha: false });
    vCtx.imageSmoothingEnabled = false;
    vCtx.mozImageSmoothingEnabled = false;
    vCtx.webkitImageSmoothingEnabled = false;
    vCtx.msImageSmoothingEnabled = false;
    
    // Dán tranh sạch vào đúng tọa độ gốc
    vCtx.drawImage(sharpCanvas, geo.cropX, geo.cropY);

    // Tô hồng dải padding thừa (Tuyệt đối không vẽ strokeRect đè lên tranh)
    vCtx.fillStyle = '#ff007f';
    if (geo.padLeft > 0) vCtx.fillRect(0, 0, geo.padLeft, rawH);
    if (geo.padRight > 0) vCtx.fillRect(rawW - geo.padRight, 0, geo.padRight, rawH);
    if (geo.padTop > 0) vCtx.fillRect(0, 0, rawW, geo.padTop);
    if (geo.padBottom > 0) vCtx.fillRect(0, rawH - geo.padBottom, rawW, geo.padBottom);

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

    return {
      rawW, rawH, gridW: targetW, gridH: targetH,
      dummyText: geo.dummyText,
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

    // 1. Phản hồi 0ms nếu đã có sẵn trong RAM
    if (store?.has(pIdx) && (store.get(pIdx).sharpCanvas || store.get(pIdx).rawCanvas)) {
      const item = store.get(pIdx);
      if (!item.rawCanvas) item.rawCanvas = item.sharpCanvas;
      if (!item.sharpCanvas) item.sharpCanvas = item.rawCanvas;
      return item;
    }

    const liveRt = rt || getNFBRRuntime(WIN);
    const menu = liveRt?.menu;
    const model = liveRt?.model;

    // 2. Kích hoạt lật trang (Nếu đang đứng sẵn ở trang đó thì ép viewer nạp lại)
    try {
      const currentViewerPage = Number(model?.get?.('viewerPage') ?? -1);
      if (typeof menu?.moveToPage === 'function') {
        if (currentViewerPage === pIdx) {
          // Đang ở sẵn trang này -> chuyển nhẹ sang trang khác rồi quay lại ngay để kích hoạt nạp
          menu.moveToPage(pIdx === 0 ? 1 : 0);
          await sleep(60);
          menu.moveToPage(pIdx);
        } else {
          menu.moveToPage(pIdx);
        }
      } else if (typeof menu?.a6l?.moveToPage === 'function') {
        menu.a6l.moveToPage(pIdx);
      } else if (typeof model?.set === 'function') {
        model.set('viewerPage', pIdx);
      }
    } catch(e) {}

    // 3. Vòng lặp chờ nạp
    const start = Date.now();
    while (Date.now() - start < 8000) {
      if (store?.has(pIdx) && (store.get(pIdx).sharpCanvas || store.get(pIdx).rawCanvas)) {
        await sleep(60);
        const item = store.get(pIdx);
        if (!item.rawCanvas) item.rawCanvas = item.sharpCanvas;
        if (!item.sharpCanvas) item.sharpCanvas = item.rawCanvas;
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
            const pIdx = pNo - 1;

            // Tính toán tọa độ động từ flag của engine
            const geo = calcPaddingGeometry(rawW, rawH, targetW, targetH, res.flag, pIdx);

            // visualCanvas: Dán tranh sạch tại geo.cropX, geo.cropY + Tô hồng dải padding
            const visualCanvas = DOC.createElement('canvas');
            visualCanvas.width = rawW;
            visualCanvas.height = rawH;
            const vCtx = visualCanvas.getContext('2d', { alpha: false });
            vCtx.imageSmoothingEnabled = false;
            vCtx.mozImageSmoothingEnabled = false;
            vCtx.webkitImageSmoothingEnabled = false;
            vCtx.msImageSmoothingEnabled = false;

            // Dán tranh sạch vào đúng tọa độ gốc
            vCtx.drawImage(res.sharpCanvas, geo.cropX, geo.cropY);

            // Tô hồng dải padding thừa (Tuyệt đối không vẽ strokeRect đè lên tranh)
            vCtx.fillStyle = '#ff007f';
            if (geo.padLeft > 0) vCtx.fillRect(0, 0, geo.padLeft, rawH);
            if (geo.padRight > 0) vCtx.fillRect(rawW - geo.padRight, 0, geo.padRight, rawH);
            if (geo.padTop > 0) vCtx.fillRect(0, 0, rawW, geo.padTop);
            if (geo.padBottom > 0) vCtx.fillRect(0, rawH - geo.padBottom, rawW, geo.padBottom);

            const validRawCanvas = res.rawCanvas || res.sharpCanvas;

            // Tự động nhận diện trang không xáo trộn (Bìa / Trial / Trang không qua X3V)
            const isScrambled = Boolean(res.isScrambled ?? (!isBookWalker || pNo > 1));

            onSuccess({
              rawW: rawW, rawH: rawH, gridW: targetW, gridH: targetH,
              dummyText: geo.dummyText,
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