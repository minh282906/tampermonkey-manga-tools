// tools/StartsPublishingInspector.user.js
// ==UserScript==
// @name         Starts Publishing Inspector
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.1
// @description  Inspector soi ma trận, đối chiếu ảnh gốc và giải mã Pixel-Perfect cho hệ thống Starts Publishing (Novema, No-Ichigo, Berry's Cafe).
// @author       anonymous & AI
// @match        https://novema.jp/comic/serial/*
// @match        https://www.no-ichigo.jp/comic/serial/*
// @match        https://no-ichigo.jp/comic/serial/*
// @match        https://www.berrys-cafe.jp/comic/serial/*
// @match        https://berrys-cafe.jp/comic/serial/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      novema.jp
// @connect      *.novema.jp
// @connect      no-ichigo.jp
// @connect      *.no-ichigo.jp
// @connect      berrys-cafe.jp
// @connect      *.berrys-cafe.jp
// @run-at       document-start
//
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/decoders/StartsPublishingTools.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/InspectorUI.js
// ==/UserScript==

(function startsPublishingInspector() {
  'use strict';

  const WIN = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const DOC = WIN.document;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  if (WIN.top !== WIN.self) return;

  function isReaderUrl() {
    return /\/comic\/serial\/(?:n)?\d+\/(?:n)?\d+/i.test(WIN.location.pathname);
  }

  function getSerialAndChapter() {
    const m = WIN.location.pathname.match(/\/comic\/serial\/(?:n)?(\d+)\/(?:n)?(\d+)/i);
    return m ? { serialId: m[1], chapterId: m[2] } : null;
  }

  /* =========================================================================
   * 1. BÓC TÁCH FILE INDEX.JSON TĨNH TỪ CDN
   * ========================================================================= */
  async function fetchChapterManifest(serialId, chapterId) {
    const Utils = WIN.MangaUtils || window.MangaUtils;
    const origin = WIN.location.origin;
    const jsonUrl = `${origin}/img/serial-comic/${serialId}/${chapterId}/content/index.json?t=${Date.now()}`;

    const buf = await Utils.fetchBuffer(jsonUrl, { "Referer": WIN.location.href });
    const rawText = new TextDecoder().decode(buf);
    const items = JSON.parse(rawText);

    if (!Array.isArray(items) || items.length === 0) {
      throw new Error("Không thể đọc danh sách trang từ index.json.");
    }

    const pages = items.map((it, idx) => ({
      pageNo: idx + 1,
      fileName: it.name,
      seed: it.seed,
      size: it.size || 4,
      url: `${origin}/img/serial-comic/${serialId}/${chapterId}/content/${it.name}?t=${Date.now()}`
    }));

    return pages;
  }

  /* =========================================================================
   * 2. TÁI TẠO ĐỒ HỌA SOI LIVE & ĐỐI CHIẾU
   * ========================================================================= */
  function processInspectorPage(img, pageObj) {
    const Tools = WIN.StartsPublishingTools || window.StartsPublishingTools;
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;

    // 1. sharpCanvas sạch 100% xuất file (dùng sizeParam động)
    const { canvas: sharpCanvas, geom } = Tools.descrambleCanvas(img, pageObj.seed, pageObj.size || 4);

    // 2. visualCanvas soi live: Khung Cyan toàn ảnh + Lưới Hồng từng ô
    const visualCanvas = DOC.createElement('canvas');
    visualCanvas.width = w;
    visualCanvas.height = h;
    const vCtx = visualCanvas.getContext('2d', { alpha: false });
    vCtx.imageSmoothingEnabled = false;
    vCtx.drawImage(sharpCanvas, 0, 0);

    // Vẽ lưới Hồng bao quanh từng lát cắt đã ghép
    vCtx.strokeStyle = '#ff007f';
    vCtx.lineWidth = 1;
    for (const c of geom.coords) {
      vCtx.strokeRect(c.destX, c.destY, c.width, c.height);
    }

    // Viền Cyan 4px bao quanh toàn bộ khung tranh
    vCtx.strokeStyle = '#00ffff';
    vCtx.lineWidth = 4;
    vCtx.strokeRect(0, 0, w, h);

    return {
      rawW: w,
      rawH: h,
      gridW: w,
      gridH: h,
      dummyText: `Khớp ma trận ${geom.tileSize}px (${geom.coords.length} lát cắt, seed: ${pageObj.seed})`,
      isScrambled: true,
      visualCanvas: visualCanvas,
      sharpCanvas: sharpCanvas,
      img: img
    };
  }

  /* =========================================================================
   * 3. KHỞI CHẠY BOOT & GẮN GIAO DIỆN INSPECTORUI
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(50);
    DOC.getElementById('manga-inspector-root')?.remove();

    if (!isReaderUrl()) return;

    const ids = getSerialAndChapter();
    if (!ids) return;

    let pages = null;
    try {
      pages = await fetchChapterManifest(ids.serialId, ids.chapterId);
    } catch (e) {
      console.error("[StartsInspector] Lỗi kéo manifest:", e);
      return;
    }

    const createUI = window.createInspectorUI || globalThis.createInspectorUI;
    const Utils = WIN.MangaUtils || window.MangaUtils;

    createUI({
      title: "STARTS PUBLISHING INSPECTOR",
      totalPages: pages.length,
      onPreview: async (pNo, onSuccess, onError) => {
        try {
          const pageObj = pages[pNo - 1];
          if (!pageObj) return onError("Trang không tồn tại!");

          const rawBuf = await Utils.fetchBuffer(pageObj.url, { "Referer": WIN.location.href });
          const ext = Utils.detectExt(rawBuf);
          const mime = Utils.detectMimeType(rawBuf);

          const img = await Utils.loadImage(rawBuf, mime);
          const res = processInspectorPage(img, pageObj);

          onSuccess({ ...res, rawExt: ext.toUpperCase(), rawBuf }, pNo);
        } catch (e) {
          onError(e?.message || String(e));
        }
      },
      onDownload: async (pageArray, fmt, quality, statusText, btn) => {
        btn.disabled = true;
        try {
          const mimeType = fmt === 'png' ? 'image/png' : (fmt === 'webp' ? 'image/webp' : 'image/jpeg');

          if (pageArray.length === 1) {
            const pNo = pageArray[0];
            const pageObj = pages[pNo - 1];

            const rawBuf = await Utils.fetchBuffer(pageObj.url, { "Referer": WIN.location.href });
            const ext = Utils.detectExt(rawBuf);
            const mime = Utils.detectMimeType(rawBuf);

            const img = await Utils.loadImage(rawBuf, mime);
            const res = processInspectorPage(img, pageObj);

            // 1. Tải bản RAW xáo trộn gốc từ CDN
            const a1 = DOC.createElement('a');
            a1.href = URL.createObjectURL(new Blob([rawBuf], { type: mime }));
            a1.download = `Starts_Trang_${pNo}_raw.${ext}`;
            a1.click();

            // 2. Tải bản ĐÃ GHÉP giải mã chuẩn Pixel-Perfect
            const a2 = DOC.createElement('a');
            a2.href = URL.createObjectURL(await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality)));
            a2.download = `Starts_Trang_${pNo}_decoded.${fmt}`;
            a2.click();

            statusText.textContent = `✅ Đã tải xong 2 bản trang ${pNo}!`;
          } else {
            const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
            const zip = new ZipClass();

            for (let i = 0; i < pageArray.length; i++) {
              const pNo = pageArray[i];
              statusText.textContent = `Đang xử lý: ${i + 1}/${pageArray.length} (Trang ${pNo})...`;
              const pageObj = pages[pNo - 1];

              const rawBuf = await Utils.fetchBuffer(pageObj.url, { "Referer": WIN.location.href });
              const ext = Utils.detectExt(rawBuf);
              const mime = Utils.detectMimeType(rawBuf);

              const img = await Utils.loadImage(rawBuf, mime);
              const res = processInspectorPage(img, pageObj);

              const sharpBlob = await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality));
              zip.addFile(`1_raw/${pNo}.${ext}`, new Uint8Array(rawBuf));
              zip.addFile(`2_decoded/${pNo}.${fmt}`, new Uint8Array(await sharpBlob.arrayBuffer()));

              await sleep(25);
            }

            statusText.textContent = `Đang đóng gói file ZIP...`;
            await sleep(60);
            zip.download(`Starts_Compare_${pageArray[0]}-${pageArray[pageArray.length - 1]}.zip`);
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

  /* =========================================================================
   * 4. THEO DÕI ĐỔI ROUTE NGẦM (CHỈ CHẠY LẠI KHI ĐỔI CHƯƠNG)
   * ========================================================================= */
  let lastChapterKey = "";

  function checkRoute() {
    if (!isReaderUrl()) {
      lastChapterKey = "";
      DOC.getElementById('manga-inspector-root')?.remove();
      return;
    }

    const ids = getSerialAndChapter();
    if (!ids) return;

    // Khóa định danh theo Series + Chapter (Bỏ qua số trang /1, /2, /4 ở đuôi)
    const currentChapterKey = `${ids.serialId}_${ids.chapterId}`;
    if (currentChapterKey !== lastChapterKey) {
      lastChapterKey = currentChapterKey;
      boot();
    }
  }

  setInterval(checkRoute, 400);
  checkRoute();
})();