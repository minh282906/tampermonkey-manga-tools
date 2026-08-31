// ==UserScript==
// @name         EbookJapan Inspector
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      4.4.0
// @description  Inspector soi ma trận Yahoo Wasm và trích xuất Canvas Iframe cho EbookJapan.
// @author       anonymous & AI
// @match        https://ebookjapan.yahoo.co.jp/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-start
//
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/InspectorUI.js
// ==/UserScript==

(function ebookJapanInspector() {
  'use strict';
  const WIN = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const DOC = WIN.document;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  if (WIN.top !== WIN.self) return;

  function bufferToDataUrl(buffer, mimeType) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i += 16384) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 16384, len)));
    }
    return `data:${mimeType || 'image/webp'};base64,${btoa(binary)}`;
  }

  /* =========================================================================
   * 1. CẦU NỐI MAIN-WORLD BRIDGE (VƯỢT RÀO XÓA PROTOTYPE & LỖI CONVERTTOBLOB)
   * ========================================================================= */
  function ensureEbookJapanBridge(ownerWin) {
    const targetWin = ownerWin || WIN;
    if (targetWin.__ej_inspector_bridge) return;
    try {
      targetWin.eval(`
        (function() {
          // Lấy toDataURL sạch từ iframe ẩn tạm thời (chống Yahoo xóa prototype)
          var pristineToDataURL = null;
          try {
            var iframe = document.createElement('iframe');
            iframe.style.display = 'none';
            document.body.appendChild(iframe);
            pristineToDataURL = iframe.contentWindow.HTMLCanvasElement.prototype.toDataURL;
            document.body.removeChild(iframe);
          } catch(e) {}

          function canvasToArrayBuffer(canvas, mimeType, quality) {
            return new Promise(function(resolve, reject) {
              try {
                var hasConvertToBlob = typeof OffscreenCanvas === 'function' &&
                                       canvas instanceof OffscreenCanvas &&
                                       typeof canvas.convertToBlob === 'function';
                if (hasConvertToBlob) {
                  var opts = { type: mimeType || 'image/png' };
                  if (typeof quality === 'number') opts.quality = quality;
                  canvas.convertToBlob(opts).then(function(blob) {
                    var reader = new FileReader();
                    reader.onload = function() { resolve(reader.result); };
                    reader.onerror = reject;
                    reader.readAsArrayBuffer(blob);
                  }).catch(function() {
                    fallbackDataUrl();
                  });
                  return;
                }
                fallbackDataUrl();
              } catch(err) {
                fallbackDataUrl();
              }

              // Fallback an toàn tuyệt đối 100%: Dùng toDataURL -> ArrayBuffer
              function fallbackDataUrl() {
                try {
                  var toData = pristineToDataURL || HTMLCanvasElement.prototype.toDataURL;
                  var dataUri = toData.call(canvas, mimeType || 'image/png', quality);
                  var base64 = dataUri.split(',')[1];
                  var bin = atob(base64);
                  var ab = new ArrayBuffer(bin.length);
                  var ua = new Uint8Array(ab);
                  for (var i = 0; i < bin.length; i++) {
                    ua[i] = bin.charCodeAt(i);
                  }
                  resolve(ab);
                } catch(e) {
                  reject(e);
                }
              }
            });
          }

          window.__ej_inspector_bridge = {
            render: function(dataUrl, w, h, pageObj, pIdx, mimeType, quality) {
              return new Promise(function(resolve, reject) {
                var img = new Image();
                img.decoding = 'async';
                img.onload = function() {
                  try {
                    var realW = w || img.naturalWidth || 1031;
                    var realH = h || img.naturalHeight || 1456;

                    // 1. sharpCanvas sạch 100% để xuất file tải về
                    var sharpCanvas = document.createElement('canvas');
                    sharpCanvas.width = realW; sharpCanvas.height = realH;
                    var ctx = sharpCanvas.getContext('2d', { alpha: false });
                    ctx.imageSmoothingEnabled = false;
                    ctx.mozImageSmoothingEnabled = false;
                    ctx.webkitImageSmoothingEnabled = false;
                    ctx.msImageSmoothingEnabled = false;
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, 0, realW, realH);

                    // 2. visualCanvas có viền Cyan #00ffff bao quanh để soi live
                    var visualCanvas = document.createElement('canvas');
                    visualCanvas.width = realW; visualCanvas.height = realH;
                    var vCtx = visualCanvas.getContext('2d', { alpha: false });
                    vCtx.imageSmoothingEnabled = false;
                    vCtx.mozImageSmoothingEnabled = false;
                    vCtx.webkitImageSmoothingEnabled = false;
                    vCtx.msImageSmoothingEnabled = false;
                    vCtx.fillStyle = '#ffffff';
                    vCtx.fillRect(0, 0, realW, realH);

                    if (pageObj && pageObj.loader && typeof pageObj.loader.shuffle === 'function') {
                      var shuffleParams = {
                        x: 0, y: 0,
                        data: { image: img },
                        autographed: pageObj ? pageObj.autographed : undefined,
                        page: Number(pIdx) || 0
                      };
                      pageObj.loader.shuffle(Object.assign({ ctx: ctx }, shuffleParams));
                      pageObj.loader.shuffle(Object.assign({ ctx: vCtx }, shuffleParams));
                    } else {
                      ctx.drawImage(img, 0, 0, realW, realH);
                      vCtx.drawImage(img, 0, 0, realW, realH);
                    }

                    // Đóng viền Cyan bao quanh khung ma trận cho visualCanvas
                    vCtx.strokeStyle = '#00ffff';
                    vCtx.lineWidth = 4;
                    vCtx.strokeRect(0, 0, realW, realH);

                    canvasToArrayBuffer(sharpCanvas, mimeType, quality).then(function(ab) {
                      resolve({
                        sharpCanvas: sharpCanvas,
                        visualCanvas: visualCanvas,
                        arrayBuffer: ab,
                        width: realW,
                        height: realH,
                        img: img
                      });
                    }).catch(reject);
                  } catch(err) {
                    reject(err);
                  }
                };
                img.onerror = function() {
                  reject(new Error("Lỗi nạp ảnh Data-URL trong Iframe"));
                };
                img.src = dataUrl;
              });
            }
          };
        })();
      `);
    } catch (e) {
      console.error('[EbookJPInspector] Bridge Init Error:', e);
    }
  }

  /* =========================================================================
   * 2. DÒ TÌM REACT FIBER TRÊN CẢ TRANG CHÍNH VÀ CÁC IFRAME CON
   * ========================================================================= */
  function findReaderInfo() {
    for (const c of DOC.querySelectorAll("canvas")) {
      const k = Object.keys(c).find(x => x.startsWith("__reactFiber"));
      let f = k ? c[k] : null;
      for (let d = 0; f && d < 50; f = f.return, d++) {
        let m = f.memoizedState;
        for (let h = 0; m && h < 80; m = m.next, h++) {
          if (m.memoizedState?.loader?.pages) return { reader: m.memoizedState, ownerWin: WIN };
        }
      }
    }
    for (const iframe of DOC.querySelectorAll("iframe")) {
      try {
        const ifWin = iframe.contentWindow;
        const ifDoc = iframe.contentDocument || ifWin?.document;
        if (ifDoc && ifWin) {
          for (const c of ifDoc.querySelectorAll("canvas")) {
            const k = Object.keys(c).find(x => x.startsWith("__reactFiber"));
            let f = k ? c[k] : null;
            for (let d = 0; f && d < 50; f = f.return, d++) {
              let m = f.memoizedState;
              for (let h = 0; m && h < 80; m = m.next, h++) {
                if (m.memoizedState?.loader?.pages) return { reader: m.memoizedState, ownerWin: ifWin };
              }
            }
          }
        }
      } catch(e) {}
    }
    return null;
  }

  function resolveEjUrl(pObj, loader) {
    const pIdx = Number(pObj.page) || 0;
    let src = pObj.data?.image?.currentSrc || pObj.data?.image?.src || pObj.data?.currentSrc || pObj.data?.src || pObj.src || '';
    if (!src && typeof loader?.funcs?.getUrl === 'function') {
      try { src = loader.funcs.getUrl(pIdx); } catch(e) {}
    }
    return src ? src.replace(/_s(\.[a-z0-9]+)(?=([?#]|$))/i, '$1') : '';
  }

  /* =========================================================================
   * 3. KHỞI CHẠY VÀ XỬ LÝ GIAO DIỆN INSPECTOR
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(50);
    let readerInfo = null, pages = [];
    for (let i = 0; i < 40; i++) {
      readerInfo = findReaderInfo();
      const rawPages = readerInfo?.reader?.loader?.pages;
      if (Array.isArray(rawPages)) {
        pages = rawPages.filter(p => p && !p.isInvalidPage && Number(p.width) > 0 && typeof p.loader?.shuffle === "function")
                        .sort((a, b) => (Number(a.page) || 0) - (Number(b.page) || 0));
      }
      if (pages.length) break;
      await sleep(150);
    }
    if (!pages.length) return;

    const ownerWin = readerInfo.ownerWin || WIN;
    ensureEbookJapanBridge(ownerWin);

    const createUI = window.createInspectorUI || globalThis.createInspectorUI;
    createUI({
      title: "EBOOKJAPAN INSPECTOR",
      totalPages: pages.length,
      onPreview: async (pNo, onSuccess, onError) => {
        const pageObj = pages[pNo - 1];
        if (!pageObj) return onError("Trang không tồn tại!");
        try {
          let src = resolveEjUrl(pageObj, readerInfo.reader.loader);
          if (!src && typeof pageObj.getImage === "function") {
            try { const p = pageObj.getImage(); if (p?.then) await p; } catch(e){}
            src = resolveEjUrl(pageObj, readerInfo.reader.loader);
          }

          let waitCount = 0;
          while (!src && waitCount < 20) {
            await sleep(50);
            src = resolveEjUrl(pageObj, readerInfo.reader.loader);
            waitCount++;
          }

          if (!src) throw new Error("Không lấy được link ảnh CDN.");

          const Utils = window.MangaUtils || globalThis.MangaUtils;
          const rawBuf = await Utils.fetchBuffer(src);
          const mime = Utils.detectMimeType(rawBuf);
          const ext = Utils.detectExt(rawBuf);
          const dataUrl = bufferToDataUrl(rawBuf, mime);
          const w = Number(pageObj.width) || 1031;
          const h = Number(pageObj.height) || 1456;

          // 1. Nhận visualCanvas (có viền Cyan 4px) và sharpCanvas (sạch) từ Bridge
          const { sharpCanvas, visualCanvas, width: finalW, height: finalH, img: rawImg } =
            await ownerWin.__ej_inspector_bridge.render(dataUrl, w, h, pageObj, pNo - 1, 'image/png');

          // 2. Tạo rawCanvas sạch từ ảnh thô CDN
          const rawCanvas = DOC.createElement('canvas');
          rawCanvas.width = rawImg.naturalWidth || rawImg.width;
          rawCanvas.height = rawImg.naturalHeight || rawImg.height;
          const rCtx = rawCanvas.getContext('2d', { alpha: false });
          rCtx.imageSmoothingEnabled = false;
          rCtx.drawImage(rawImg, 0, 0);

          // 3. Tính toán phần chênh lệch khối đệm đen của Wasm
          const diffW = rawCanvas.width - finalW;
          const diffH = rawCanvas.height - finalH;
          const dummyText = (diffW > 0 || diffH > 0)
            ? `Khối đệm Wasm: +${diffW}px ngang, +${diffH}px dọc (Đã lọc sạch)`
            : `Khớp 100% không có viền thừa`;

          onSuccess({
            rawW: rawCanvas.width,
            rawH: rawCanvas.height,
            gridW: finalW,
            gridH: finalH,
            dummyText: dummyText,
            sharpCanvas: sharpCanvas,
            visualCanvas: visualCanvas,
            rawCanvas: rawCanvas,
            img: rawImg,
            rawExt: ext.toUpperCase(),
            rawBuf: rawBuf
          }, pNo);
        } catch (e) {
          onError(e?.message || String(e));
        }
      },
      onDownload: async (pageArray, fmt, quality, statusText, btn) => {
        btn.disabled = true;
        try {
          const Utils = window.MangaUtils || globalThis.MangaUtils;
          const mimeType = fmt === 'png' ? 'image/png' : (fmt === 'webp' ? 'image/webp' : 'image/jpeg');

          if (pageArray.length === 1) {
            const pNo = pageArray[0];
            const pageObj = pages[pNo - 1];
            let src = resolveEjUrl(pageObj, readerInfo.reader.loader);
            if (!src && typeof pageObj.getImage === "function") {
              try { const p = pageObj.getImage(); if (p?.then) await p; } catch(e){}
              src = resolveEjUrl(pageObj, readerInfo.reader.loader);
            }

            const rawBuf = await Utils.fetchBuffer(src);
            const ext = Utils.detectExt(rawBuf);
            const mime = Utils.detectMimeType(rawBuf);
            const dataUrl = bufferToDataUrl(rawBuf, mime);
            const w = Number(pageObj.width) || 1031;
            const h = Number(pageObj.height) || 1456;

            statusText.textContent = `Đang giải mã trang ${pNo}...`;
            const { arrayBuffer: decodedBuffer } =
              await ownerWin.__ej_inspector_bridge.render(dataUrl, w, h, pageObj, pNo - 1, mimeType, quality);

            // Tải bản 1: Raw xáo trộn gốc từ CDN Akamai (1664x2176)
            const a1 = DOC.createElement('a');
            a1.href = URL.createObjectURL(new Blob([rawBuf], { type: mime }));
            a1.download = `EbookJP_Trang_${pNo}_raw.${ext}`;
            a1.click();

            // Tải bản 2: Giải mã hoàn chỉnh từ Wasm (1350x1920, sạch không có viền)
            const a2 = DOC.createElement('a');
            a2.href = URL.createObjectURL(new Blob([decodedBuffer], { type: mimeType }));
            a2.download = `EbookJP_Trang_${pNo}_decoded.${fmt}`;
            a2.click();

            statusText.textContent = `✅ Đã tải xong 2 bản trang ${pNo}!`;
          } else {
            const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
            const zip = new ZipClass();

            for (let i = 0; i < pageArray.length; i++) {
              const pNo = pageArray[i];
              statusText.textContent = `Đang giải mã Wasm: ${i + 1}/${pageArray.length} (Trang ${pNo})...`;
              const pageObj = pages[pNo - 1];
              let src = resolveEjUrl(pageObj, readerInfo.reader.loader);
              if (!src && typeof pageObj.getImage === "function") {
                try { const p = pageObj.getImage(); if (p?.then) await p; } catch(e){}
                src = resolveEjUrl(pageObj, readerInfo.reader.loader);
              }

              const rawBuf = await Utils.fetchBuffer(src);
              const ext = Utils.detectExt(rawBuf);
              const mime = Utils.detectMimeType(rawBuf);
              const dataUrl = bufferToDataUrl(rawBuf, mime);
              const w = Number(pageObj.width) || 1031;
              const h = Number(pageObj.height) || 1456;

              const { arrayBuffer: decodedBuffer } =
                await ownerWin.__ej_inspector_bridge.render(dataUrl, w, h, pageObj, pNo - 1, mimeType, quality);

              zip.addFile(`1_raw/${pNo}.${ext}`, new Uint8Array(rawBuf));
              zip.addFile(`2_decoded/${pNo}.${fmt}`, new Uint8Array(decodedBuffer));
            }

            statusText.textContent = `Đang đóng gói file ZIP...`;
            await sleep(60);
            zip.download(`EbookJP_Compare_${pageArray[0]}-${pageArray[pageArray.length - 1]}.zip`);
            statusText.textContent = `✅ Đã xuất xong file ZIP đối chiếu!`;
          }
        } catch (e) {
          statusText.textContent = `❌ ${e?.message || String(e)}`;
        } finally {
          btn.disabled = false;
        }
      }
    });
  }

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      boot();
    }
  }, 500);

  boot();
})();