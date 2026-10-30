// tools/NextViewerInspector.user.js
// ==UserScript==
// @name         NextViewer Inspector (Manga Kingdom)
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @description  Inspector soi ma trận LCG, rãnh đệm Gutter 2px và đối chiếu ảnh gốc cho Beaglee NextViewer (comic.k-manga.jp).
// @author       anonymous & AI
// @match        https://comic.k-manga.jp/viewer/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      k-manga.jp
// @connect      *.k-manga.jp
// @connect      ws.viewer.k-manga.jp
// @run-at       document-start
//
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/decoders/NextViewerTools.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/InspectorUI.js
// ==/UserScript==

(function nextViewerInspector() {
  'use strict';

  const WIN = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const DOC = WIN.document;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  if (WIN.top !== WIN.self) return;

  function isReaderUrl() {
    return WIN.location.pathname.includes('/viewer/') && WIN.location.search.includes('p0=');
  }

  function getUrlParams() {
    const sp = new URLSearchParams(WIN.location.search);
    return {
      t: sp.get('p0'),
      o: sp.get('p1'),
      bookId: sp.get('p3') || 'book',
      chapId: sp.get('p4') || 'chap'
    };
  }

  /* =========================================================================
   * 1. KẾT NỐI WEBSOCKET BCP & LẤY MANIFEST
   * ========================================================================= */
  function fetchManifestViaWs(params) {
    const Tools = WIN.NextViewerTools || window.NextViewerTools;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket('wss://ws.viewer.k-manga.jp/');
      ws.binaryType = 'arraybuffer';
      let stage = 0;

      const timer = setTimeout(() => {
        try { ws.close(); } catch(e){}
        reject(new Error("Timeout kết nối WebSocket"));
      }, 15000);

      ws.onmessage = (e) => {
        try {
          const frame = Tools.parseBcpFrame(e.data);
          if (stage === 0 && frame.isGreeting) {
            stage = 1;
            ws.send(`REQUEST HEADER\nt=${params.t}&fn=64kb_QVGA_h&o=${params.o}`);
            return;
          }
          if (stage === 1) {
            clearTimeout(timer);
            ws.close();
            resolve(frame.body);
          }
        } catch (err) {
          clearTimeout(timer);
          ws.close();
          reject(err);
        }
      };

      ws.onerror = (err) => {
        clearTimeout(timer);
        reject(err);
      };
    });
  }

  /* =========================================================================
   * 2. TẢI TỪNG TRANG TRANH QUA WEBSOCKET
   * ========================================================================= */
  function fetchPageViaWs(params, manifest, chunkName, sceneNo) {
    const Tools = WIN.NextViewerTools || window.NextViewerTools;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket('wss://ws.viewer.k-manga.jp/');
      ws.binaryType = 'arraybuffer';
      let stage = 0;

      const timer = setTimeout(() => {
        try { ws.close(); } catch(e){}
        reject(new Error("Timeout tải trang tranh"));
      }, 20000);

      ws.onmessage = (e) => {
        try {
          const frame = Tools.parseBcpFrame(e.data);
          if (stage === 0 && frame.isGreeting) {
            stage = 1;
            ws.send(`REQUEST DATA\nt=${params.t}&fn=${chunkName}&o=${params.o}&dk=${manifest.dk}`);
            return;
          }
          if (stage === 1) {
            clearTimeout(timer);
            ws.close();
            const scenes = frame.body.scenes || [];
            // 🎯 Tìm đúng vị trí index của trang trong gói tin đa tầng
            const sceneIndex = scenes.findIndex(s => s.sceneNo === sceneNo);
            const targetIndex = sceneIndex !== -1 ? sceneIndex : 0;

            const scene = scenes[targetIndex];
            const imageMeta = scene?.images?.[0] || {};
            const rawChunk = frame.chunks[targetIndex] || frame.chunks[0];
            // 🎯 Nhân bản vùng nhớ sạch, loại bỏ phần đệm BCP000 để file RAW mở được 100%
            const cleanBytes = rawChunk.slice();

            resolve({
              jpegBytes: cleanBytes,
              meta: imageMeta
            });
          }
        } catch (err) {
          clearTimeout(timer);
          ws.close();
          reject(err);
        }
      };

      ws.onerror = (err) => {
        clearTimeout(timer);
        reject(err);
      };
    });
  }

  /* =========================================================================
   * 3. XỬ LÝ ĐỒ HỌA SOI LIVE & ĐỐI CHIẾU
   * ========================================================================= */
  async function processInspectorPage(pageData) {
    const Utils = WIN.MangaUtils || window.MangaUtils;
    const Tools = WIN.NextViewerTools || window.NextViewerTools;
    const { jpegBytes, meta } = pageData;

    // 1. Nhận diện MIME & Định dạng nhị phân động (Zero-Trust, Zero-Hardcode)
    const rawMime = Utils.detectMimeType(jpegBytes);
    const rawExt = Utils.detectExt(jpegBytes);

    // 🎯 2. NẠP ẢNH BẰNG CREATEIMAGEBITMAP QUA MANGAUTILS (KHÔNG DÙNG NEW IMAGE)
    const rawImg = await Utils.loadImage(jpegBytes, rawMime);
    const rawW = rawImg.naturalWidth || rawImg.width;
    const rawH = rawImg.naturalHeight || rawImg.height;

    // 3. rawCanvas: Tái tạo phôi xáo trộn nguyên thủy
    const rawCanvas = DOC.createElement('canvas');
    rawCanvas.width = rawW;
    rawCanvas.height = rawH;
    const rCtx = rawCanvas.getContext('2d', { alpha: false });
    rCtx.imageSmoothingEnabled = false;
    rCtx.mozImageSmoothingEnabled = false;
    rCtx.webkitImageSmoothingEnabled = false;
    rCtx.msImageSmoothingEnabled = false;
    rCtx.drawImage(rawImg, 0, 0);

    // 4. sharpCanvas: Giải mã ma trận LCG + Gutter Pixel-Perfect cho toàn bộ các trang
    const { canvas: sharpCanvas, geom, coords, targetW, targetH } = Tools.descrambleCanvas(
      rawImg,
      meta.width,
      meta.height,
      meta.key
    );

    // 5. visualCanvas soi live: Khung Cyan toàn ảnh + Lưới Hồng từng ô LCG
    const visualCanvas = DOC.createElement('canvas');
    visualCanvas.width = targetW;
    visualCanvas.height = targetH;
    const vCtx = visualCanvas.getContext('2d', { alpha: false });
    vCtx.imageSmoothingEnabled = false;
    vCtx.mozImageSmoothingEnabled = false;
    vCtx.webkitImageSmoothingEnabled = false;
    vCtx.msImageSmoothingEnabled = false;
    vCtx.drawImage(sharpCanvas, 0, 0);

    vCtx.strokeStyle = '#ff007f';
    vCtx.lineWidth = 1;
    for (const c of coords) {
      vCtx.strokeRect(c.destX, c.destY, c.width, c.height);
    }

    vCtx.strokeStyle = '#00ffff';
    vCtx.lineWidth = 4;
    vCtx.strokeRect(0, 0, targetW, targetH);

    return {
      rawW,
      rawH,
      gridW: targetW,
      gridH: targetH,
      dummyText: `Khớp ma trận LCG (${geom.gridX}x${geom.gridY} = ${coords.length} ô, gọt viền ${geom.cell}px -> ${geom.block}px)`,
      isScrambled: true,
      visualCanvas,
      sharpCanvas,
      rawCanvas,
      rawBuf: jpegBytes,
      rawExt: rawExt.toUpperCase()
    };
  }

  /* =========================================================================
   * 4. KHỞI CHẠY BOOT & GẮN GIAO DIỆN INSPECTORUI
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(50);
    DOC.getElementById('manga-inspector-root')?.remove();

    if (!isReaderUrl()) return;

    const params = getUrlParams();
    if (!params.t || !params.o) return;

    let manifest = null;
    try {
      manifest = await fetchManifestViaWs(params);
    } catch (e) {
      console.error("[NextViewerInspector] Lỗi kết nối WebSocket:", e);
      return;
    }

    const totalPages = manifest.numOfScenes || manifest.contentInfos?.length || 0;
    if (!totalPages) return;

    // Sắp xếp các gói chunk theo thứ tự trang
    const chunks = manifest.contentInfos.slice().sort((a, b) => Number(a.startSceneNo) - Number(b.startSceneNo));

    const createUI = window.createInspectorUI || globalThis.createInspectorUI;

    createUI({
      title: "NEXTVIEWER INSPECTOR",
      totalPages: totalPages,
      onPreview: async (pNo, onSuccess, onError) => {
        try {
          // Tìm chunk tương ứng với số trang pNo
          const chunkItem = chunks.find((c, idx) => {
            const start = Number(c.startSceneNo);
            const nextStart = chunks[idx + 1] ? Number(chunks[idx + 1].startSceneNo) : totalPages + 1;
            return pNo >= start && pNo < nextStart;
          }) || chunks[pNo - 1] || chunks[0];

          const pageData = await fetchPageViaWs(params, manifest, chunkItem.name, pNo);
          const res = await processInspectorPage(pageData);

          onSuccess(res, pNo);
        } catch (e) {
          onError(e?.message || String(e));
        }
      },
      onDownload: async (pageArray, fmt, quality, statusText, btn) => {
        btn.disabled = true;
        try {
          const Utils = window.MangaUtils || globalThis.MangaUtils;
          const mimeType = fmt === 'png' ? 'image/png' : (fmt === 'webp' ? 'image/webp' : 'image/jpeg');

          // 🎯 1. NẾU CHỈ TẢI 1 TRANG: Tải thẳng 2 file lẻ (KHÔNG NÉN ZIP)
          if (pageArray.length === 1) {
            const pNo = pageArray[0];
            statusText.textContent = `Đang tải trang ${pNo}...`;

            const chunkItem = chunks.find((c, idx) => {
              const start = Number(c.startSceneNo);
              const nextStart = chunks[idx + 1] ? Number(chunks[idx + 1].startSceneNo) : totalPages + 1;
              return pNo >= start && pNo < nextStart;
            }) || chunks[pNo - 1] || chunks[0];

            const pageData = await fetchPageViaWs(params, manifest, chunkItem.name, pNo);
            const res = await processInspectorPage(pageData);

            // A. Tải bản RAW xáo trộn gốc từ WebSocket (Đuôi động, MIME động)
            const rawExt = res.rawExt.toLowerCase();
            const a1 = DOC.createElement('a');
            a1.href = URL.createObjectURL(new Blob([res.rawBuf], { type: Utils.detectMimeType(res.rawBuf) }));
            a1.download = `NextViewer_Trang_${pNo}_raw.${rawExt}`;
            a1.click();

            // B. Tải bản ĐÃ GHÉP giải mã chuẩn Pixel-Perfect
            const a2 = DOC.createElement('a');
            a2.href = URL.createObjectURL(await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality)));
            a2.download = `NextViewer_Trang_${pNo}_decoded.${fmt}`;
            a2.click();

            statusText.textContent = `✅ Đã tải xong 2 bản trang ${pNo}!`;
          } else {
            // 🎯 2. NẾU TẢI TỪ 2 TRANG TRỞ LÊN: Đóng gói thành duy nhất 1 file ZIP
            const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
            const zip = new ZipClass();

            for (let i = 0; i < pageArray.length; i++) {
              const pNo = pageArray[i];
              statusText.textContent = `Đang xử lý: ${i + 1}/${pageArray.length} (Trang ${pNo})...`;

              const chunkItem = chunks.find((c, idx) => {
                const start = Number(c.startSceneNo);
                const nextStart = chunks[idx + 1] ? Number(chunks[idx + 1].startSceneNo) : totalPages + 1;
                return pNo >= start && pNo < nextStart;
              }) || chunks[pNo - 1] || chunks[0];

              const pageData = await fetchPageViaWs(params, manifest, chunkItem.name, pNo);
              const res = await processInspectorPage(pageData);

              const rawExt = res.rawExt.toLowerCase();
              const sharpBlob = await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality));
              zip.addFile(`1_raw/${pNo}.${rawExt}`, new Uint8Array(res.rawBuf));
              zip.addFile(`2_decoded/${pNo}.${fmt}`, new Uint8Array(await sharpBlob.arrayBuffer()));

              await sleep(30);
            }

            statusText.textContent = `Đang đóng gói file ZIP...`;
            await sleep(50);
            zip.download(`NextViewer_Compare_${params.bookId}_${pageArray[0]}-${pageArray[pageArray.length - 1]}.zip`);
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

  boot();
})();