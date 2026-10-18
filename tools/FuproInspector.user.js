// ==UserScript==
// @name         Fupro Comics Inspector
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @description  Inspector soi ma trận 2x2, đảo màu âm bản và đối chiếu 2 bản ảnh cho Fupro Comics / Comicbox (viewer.fupro-comics.com).
// @author       anonymous & AI
// @match        https://viewer.fupro-comics.com/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      d79boba150po0.cloudfront.net
// @connect      d3bfjqszfw85dv.cloudfront.net
// @connect      cloudfront.net
// @run-at       document-start
//
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/decoders/FuproTools.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/InspectorUI.js
// ==/UserScript==

(function fuproInspector() {
  'use strict';
  const WIN = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const DOC = WIN.document;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  if (WIN.top !== WIN.self) return;

  /* =========================================================================
   * BỘ CÁCH LY SỰ KIỆN CHUỘT: Chống click trên Inspector bị lọt xuống lật trang
   * ========================================================================= */
  (function isolateInspectorEvents() {
    function stopLeak(el) {
      if (!el || el.__fupro_isolated) return;
      el.__fupro_isolated = true;
      const evts = ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend'];
      evts.forEach(evt => {
        el.addEventListener(evt, e => e.stopPropagation(), false);
      });
    }

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) {
            // Chặn nổi bọt trên cả Bảng điều khiển Inspector lẫn Khung ảnh Soi Live
            if (node.id === 'manga-inspector-root' || node.querySelector?.('#insp-wrap') || node.style?.zIndex >= 2147483640) {
              stopLeak(node);
            }
          }
        }
      }
    });
    observer.observe(DOC.documentElement, { childList: true, subtree: true });
  })();

  /* =========================================================================
   * 1. HOOK MẠNG ĐÓN GÓI TIN GET_BASE_INFO_READER_FUPRO.PHP TẠI DOCUMENT-START
   * ========================================================================= */
  let capturedBaseInfo = null;

  const origXhrOpen = WIN.XMLHttpRequest?.prototype?.open;
  const origXhrSend = WIN.XMLHttpRequest?.prototype?.send;
  if (origXhrOpen && origXhrSend) {
    WIN.XMLHttpRequest.prototype.open = function(method, url) {
      this._fuproUrl = typeof url === 'string' ? url : String(url);
      return origXhrOpen.apply(this, arguments);
    };

    WIN.XMLHttpRequest.prototype.send = function() {
      this.addEventListener('load', () => {
        try {
          if (this._fuproUrl && this._fuproUrl.includes('get_base_info')) {
            const data = JSON.parse(this.responseText);
            if (data && Array.isArray(data.zip_100) && data.zip_100.length > 0) {
              capturedBaseInfo = data;
            }
          }
        } catch (e) {}
      });
      return origXhrSend.apply(this, arguments);
    };
  }

  /* =========================================================================
   * 2. TÁI TẠO ĐỒ HỌA THEO CHUẨN PIXEL-PERFECT (CANVAS 2X2 & ĐẢO MÀU ÂM BẢN)
   * ========================================================================= */
  function descrambleFuproImage(img, isCover, rebuildConfig) {
    const Tools = WIN.FuproTools || window.FuproTools;
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;

    // 1. sharpCanvas (Bản xuất file sạch 100% xuất PNG)
    const sharpCanvas = DOC.createElement('canvas');
    sharpCanvas.width = w;
    sharpCanvas.height = h;

    // Khóa willReadFrequently: true để tối ưu GPU/RAM cho việc thao tác pixel getImageData
    const sCtx = sharpCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
    sCtx.imageSmoothingEnabled = false;
    sCtx.mozImageSmoothingEnabled = false;
    sCtx.webkitImageSmoothingEnabled = false;
    sCtx.msImageSmoothingEnabled = false;

    // A. Nếu là trang Bìa (Cover): Ảnh gốc sạch 100%, vẽ thẳng 1:1 không xáo trộn, không đảo màu
    if (isCover) {
      sCtx.drawImage(img, 0, 0);
      return {
        rawW: w,
        rawH: h,
        gridW: w,
        gridH: h,
        dummyText: "Bìa gốc nguyên bản (Không xáo trộn, không âm bản)",
        isScrambled: false,
        visualCanvas: sharpCanvas,
        sharpCanvas: sharpCanvas,
        img: img
      };
    }

    // B. Nếu là trang truyện chính: Thực hiện 2 bước giải mã
    const geom = Tools.calculateCoords(w, h, rebuildConfig);

    // BƯỚC 1: Hoán vị 4 góc phần tư về vị trí đúng
    for (const c of geom.coords) {
      sCtx.drawImage(
        img,
        c.srcX, c.srcY, c.srcW, c.srcH,
        c.destX, c.destY, c.width, c.height
      );
    }

    // BƯỚC 2: Đảo ngược màu sắc từ âm bản về màu sắc nguyên bản (255 - RGB)
    const imgData = sCtx.getImageData(0, 0, w, h);
    Tools.invertRgbPixels(imgData.data);
    sCtx.putImageData(imgData, 0, 0);

    // 2. visualCanvas (Bản Soi Live: Viền Cyan toàn ảnh + Chữ thập Hồng tâm 4 góc)
    const visualCanvas = DOC.createElement('canvas');
    visualCanvas.width = w;
    visualCanvas.height = h;
    const vCtx = visualCanvas.getContext('2d', { alpha: false });
    vCtx.imageSmoothingEnabled = false;
    vCtx.drawImage(sharpCanvas, 0, 0);

    // Vẽ chữ thập Hồng nét liền tại điểm tâm (midX, midY) để soi đường cắt 4 góc phần tư
    vCtx.strokeStyle = '#ff007f';
    vCtx.lineWidth = 2;
    vCtx.beginPath();
    vCtx.moveTo(geom.midX, 0);
    vCtx.lineTo(geom.midX, h);
    vCtx.moveTo(0, geom.midY);
    vCtx.lineTo(w, geom.midY);
    vCtx.stroke();

    // Viền Cyan nét liền bao quanh toàn bộ khung tranh
    vCtx.strokeStyle = '#00ffff';
    vCtx.lineWidth = 4;
    vCtx.strokeRect(0, 0, w, h);

    return {
      rawW: w,
      rawH: h,
      gridW: w,
      gridH: h,
      dummyText: "Khớp ma trận 2x2 (Đã đảo màu âm bản & hoán vị 4 góc)",
      isScrambled: true,
      visualCanvas: visualCanvas,
      sharpCanvas: sharpCanvas,
      img: img
    };
  }

  /* =========================================================================
   * 3. KHỞI CHẠY BOOT VÀ KẾT NỐI INSPECTORUI
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(50);
    DOC.getElementById('manga-inspector-root')?.remove();

    let baseData = capturedBaseInfo;
    for (let i = 0; i < 35 && !baseData; i++) {
      // Đọc trực tiếp từ RAM của cỗ máy Fupro (0ms)
      const worker = WIN[DOC.viewerObjName || "viewer_"] || WIN.viewer_;
      if (worker?.pageInfoListAll?.zip_100?.length > 0) {
        baseData = worker.pageInfoListAll;
        break;
      }
      if (WIN.FUPRO?.data?.zip_100?.length > 0) {
        baseData = WIN.FUPRO.data;
        break;
      }
      await sleep(150);
    }

    if (!baseData || !Array.isArray(baseData.zip_100) || baseData.zip_100.length === 0) {
      return;
    }

    // Danh sách trang: Trang bìa (cover) luôn là trang 1, từ trang 2 trở đi là zip_100[1..]
    const coverUrl = baseData.cover || baseData.cover_origin || baseData.zip_100[0];
    const pageUrls = [coverUrl, ...baseData.zip_100.slice(1)];
    const rebuildConfig = baseData.rebuild;

    const createUI = window.createInspectorUI || globalThis.createInspectorUI;
    const Utils = WIN.MangaUtils || window.MangaUtils;

    createUI({
      title: "FUPRO COMICS INSPECTOR",
      totalPages: pageUrls.length,
      onPreview: async (pNo, onSuccess, onError) => {
        try {
          const imgUrl = pageUrls[pNo - 1];
          if (!imgUrl) return onError("Trang không tồn tại!");

          const isCover = (pNo === 1);
          const rawBuf = await Utils.fetchBuffer(imgUrl, { "Referer": "https://viewer.fupro-comics.com/" });
          const ext = Utils.detectExt(rawBuf);
          const mime = Utils.detectMimeType(rawBuf);

          const img = await Utils.loadImage(rawBuf, mime);
          const res = descrambleFuproImage(img, isCover, rebuildConfig);

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
            const imgUrl = pageUrls[pNo - 1];
            const isCover = (pNo === 1);

            const rawBuf = await Utils.fetchBuffer(imgUrl, { "Referer": "https://viewer.fupro-comics.com/" });
            const ext = Utils.detectExt(rawBuf);
            const mime = Utils.detectMimeType(rawBuf);

            const img = await Utils.loadImage(rawBuf, mime);
            const res = descrambleFuproImage(img, isCover, rebuildConfig);

            // 1. Tải bản RAW chưa xử lý (đen sì và bị đảo góc)
            const a1 = DOC.createElement('a');
            a1.href = URL.createObjectURL(new Blob([rawBuf], { type: mime }));
            a1.download = `Fupro_Trang_${pNo}_raw.${ext}`;
            a1.click();

            // 2. Tải bản ĐÃ GHÉP giải mã sáng rõ sạch 100%
            const a2 = DOC.createElement('a');
            a2.href = URL.createObjectURL(await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality)));
            a2.download = `Fupro_Trang_${pNo}_decoded.${fmt}`;
            a2.click();

            statusText.textContent = `✅ Đã tải xong 2 bản trang ${pNo}!`;
          } else {
            const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
            const zip = new ZipClass();

            for (let i = 0; i < pageArray.length; i++) {
              const pNo = pageArray[i];
              statusText.textContent = `Đang xử lý: ${i + 1}/${pageArray.length} (Trang ${pNo})...`;
              const imgUrl = pageUrls[pNo - 1];
              const isCover = (pNo === 1);

              const rawBuf = await Utils.fetchBuffer(imgUrl, { "Referer": "https://viewer.fupro-comics.com/" });
              const ext = Utils.detectExt(rawBuf);
              const mime = Utils.detectMimeType(rawBuf);

              const img = await Utils.loadImage(rawBuf, mime);
              const res = descrambleFuproImage(img, isCover, rebuildConfig);

              const sharpBlob = await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality));
              zip.addFile(`1_raw/${pNo}.${ext}`, new Uint8Array(rawBuf));
              zip.addFile(`2_decoded/${pNo}.${fmt}`, new Uint8Array(await sharpBlob.arrayBuffer()));
            }

            statusText.textContent = `Đang đóng gói file ZIP...`;
            await sleep(60);
            zip.download(`Fupro_Compare_${pageArray[0]}-${pageArray[pageArray.length - 1]}.zip`);
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
   * 4. THEO DÕI ĐỔI TRANG (SPA WATCHER)
   * ========================================================================= */
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      capturedBaseInfo = null;
      boot();
    }
  }, 400);

  boot();
})();