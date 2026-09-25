// ==UserScript==
// @name         Corona EX Inspector
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @description  Inspector soi ma trận hoán vị Base64 và tải đối chiếu 2 bản ảnh cho Corona EX (to-corona-ex.com).
// @author       anonymous & AI
// @match        https://to-corona-ex.com/episodes/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-start
//
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/InspectorUI.js
// ==/UserScript==

(function coronaExInspector() {
  'use strict';
  const WIN = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const DOC = WIN.document;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  if (WIN.top !== WIN.self) return;

  let capturedData = null;

  /* =========================================================================
   * 1. HOOK MẠNG BẮT /begin_reading (ĐÓN ĐẦU CẢ KHI CHUYỂN CHƯƠNG SPA)
   * ========================================================================= */
  const origFetch = WIN.fetch;
  if (typeof origFetch === 'function') {
    WIN.fetch = async function(...args) {
      const res = await origFetch.apply(this, args);
      try {
        const u = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        if (u.includes('/begin_reading')) {
          res.clone().json().then(data => {
            if (data?.pages && Array.isArray(data.pages)) {
              capturedData = data;
            }
          }).catch(() => {});
        }
      } catch (e) {}
      return res;
    };
  }

  /* =========================================================================
   * 2. THUẬT TOÁN GIẢI MÃ MA TRẬN CORONA EX (INLINE CHUẨN PIXEL-PERFECT)
   * ========================================================================= */
  function descrambleCoronaEx(img, drmHash) {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;

    // Phân tích chuỗi drm_hash Base64
    let cols = 4, rows = 4, mapping = null;
    if (drmHash && typeof drmHash === 'string') {
      try {
        const bin = atob(drmHash.trim());
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        if (bytes.length >= 2) {
          cols = bytes[0];
          rows = bytes[1];
          if (bytes.length >= 2 + cols * rows) {
            mapping = bytes.subarray(2, 2 + cols * rows);
          }
        }
      } catch (e) {}
    }

    // Tính kích thước ô lưới theo bội số 8px chuẩn xác của NXB
    const cellW = Math.floor((w - (w % 8)) / cols);
    const cellH = Math.floor((h - (h % 8)) / rows);
    const gridW = cellW * cols;
    const gridH = cellH * rows;
    const dummyW = w - gridW;
    const dummyH = h - gridH;

    // 1. sharpCanvas (Xuất file sạch 100% không suy hao)
    const sharpCanvas = DOC.createElement('canvas');
    sharpCanvas.width = w;
    sharpCanvas.height = h;
    const sCtx = sharpCanvas.getContext('2d', { alpha: false });
    sCtx.imageSmoothingEnabled = false;
    sCtx.mozImageSmoothingEnabled = false;
    sCtx.webkitImageSmoothingEnabled = false;
    sCtx.msImageSmoothingEnabled = false;

    // Bước 1: Vẽ lót nền ảnh gốc 1:1 bảo tồn trọn vẹn 100% viền ngoài (Golden Rule 4)
    sCtx.drawImage(img, 0, 0, w, h);

    // Bước 2: Dán đè các ô hoán vị ở vùng trung tâm
    if (mapping) {
      for (let j = 0; j < cols * rows; j++) {
        const srcIdx = mapping[j];
        const srcCol = srcIdx % cols;
        const srcRow = Math.floor(srcIdx / cols);

        const destCol = j % cols;
        const destRow = Math.floor(j / cols);

        sCtx.drawImage(
          img,
          srcCol * cellW, srcRow * cellH, cellW, cellH,
          destCol * cellW, destRow * cellH, cellW, cellH
        );
      }
    }

    // 2. visualCanvas (Soi Live: Viền Cyan toàn ảnh + Khung Hồng ma trận)
    const visualCanvas = DOC.createElement('canvas');
    visualCanvas.width = w;
    visualCanvas.height = h;
    const vCtx = visualCanvas.getContext('2d', { alpha: false });
    vCtx.imageSmoothingEnabled = false;
    vCtx.mozImageSmoothingEnabled = false;
    vCtx.webkitImageSmoothingEnabled = false;
    vCtx.msImageSmoothingEnabled = false;

    vCtx.drawImage(sharpCanvas, 0, 0);

    // Khung Hồng nét liền (2px) bao quanh vùng ma trận (nếu có dải dư)
    if (dummyW > 0 || dummyH > 0) {
      vCtx.strokeStyle = '#ff007f';
      vCtx.lineWidth = 2;
      vCtx.strokeRect(0, 0, gridW, gridH);
    }
    // Viền Cyan nét liền (4px) bao quanh toàn bộ bức tranh
    vCtx.strokeStyle = '#00ffff';
    vCtx.lineWidth = 4;
    vCtx.strokeRect(0, 0, w, h);

    const dummyText = (dummyW > 0 || dummyH > 0)
      ? `Mép giữ nguyên: ${dummyW}px phải, ${dummyH}px đáy (Không xáo trộn)`
      : `Khớp ma trận 100% (Không có phần dư)`;

    return { rawW: w, rawH: h, gridW, gridH, dummyText, visualCanvas, sharpCanvas, img };
  }

  /* =========================================================================
   * 3. BÓC TÁCH DỮ LIỆU TỪ SSR __NEXT_DATA__
   * ========================================================================= */
  function extractNextData() {
    try {
      const el = DOC.getElementById('__NEXT_DATA__');
      if (el && el.textContent) {
        const json = JSON.parse(el.textContent);
        const pp = json.props?.pageProps;
        if (pp?.metaInfo?.pages?.length) return pp.metaInfo;
        if (pp?.episode?.pages?.length) return pp.episode;
        if (pp?.pages?.length) return pp;
      }
    } catch (e) {}
    return null;
  }

  /* =========================================================================
   * 4. HÀM KHỞI CHẠY (BOOT)
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(50);

    let data = capturedData || extractNextData();

    // Chờ tối đa 3 giây nếu trang đang nạp ngầm
    for (let i = 0; i < 30 && (!data || !data.pages?.length); i++) {
      await sleep(100);
      data = capturedData || extractNextData();
    }

    if (!data || !data.pages || !data.pages.length) return;

    // Xóa panel UI cũ nếu có để làm mới
    DOC.getElementById('manga-inspector-root')?.remove();

    const pages = data.pages;
    const createUI = window.createInspectorUI || globalThis.createInspectorUI;

    createUI({
      title: "CORONA EX INSPECTOR",
      totalPages: pages.length,

      // --- CHẾ ĐỘ 1: SOI LIVE TRỰC QUAN ---
      onPreview: async (pNo, onSuccess, onError) => {
        const pageObj = pages[pNo - 1];
        if (!pageObj || !pageObj.page_image_url) return onError("Trang không tồn tại!");

        try {
          const Utils = window.MangaUtils || globalThis.MangaUtils;
          const rawBuf = await Utils.fetchBuffer(pageObj.page_image_url);
          const ext = Utils.detectExt(rawBuf);
          const mime = Utils.detectMimeType(rawBuf);
          const img = await Utils.loadImage(rawBuf, mime);

          const res = descrambleCoronaEx(img, pageObj.drm_hash);
          onSuccess({ ...res, rawExt: ext.toUpperCase(), rawBuf }, pNo);
        } catch (e) {
          onError(e?.message || String(e));
        }
      },

      // --- CHẾ ĐỘ 2: TẢI ĐỐI CHIẾU 2 BẢN ẢNH ---
      onDownload: async (pageArray, fmt, quality, statusText, btn) => {
        btn.disabled = true;
        try {
          const Utils = window.MangaUtils || globalThis.MangaUtils;
          const mimeType = fmt === 'png' ? 'image/png' : (fmt === 'webp' ? 'image/webp' : 'image/jpeg');

          if (pageArray.length === 1) {
            const pNo = pageArray[0];
            const pageObj = pages[pNo - 1];
            const rawBuf = await Utils.fetchBuffer(pageObj.page_image_url);
            const ext = Utils.detectExt(rawBuf);
            const mime = Utils.detectMimeType(rawBuf);
            const img = await Utils.loadImage(rawBuf, mime);
            const res = descrambleCoronaEx(img, pageObj.drm_hash);

            const a1 = DOC.createElement('a');
            a1.href = URL.createObjectURL(new Blob([rawBuf], { type: mime }));
            a1.download = `CoronaEx_Trang_${pNo}_raw.${ext}`;
            a1.click();

            const a2 = DOC.createElement('a');
            a2.href = URL.createObjectURL(await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality)));
            a2.download = `CoronaEx_Trang_${pNo}_decoded.${fmt}`;
            a2.click();

            statusText.textContent = `✅ Đã tải xong 2 bản trang ${pNo}!`;
          } else {
            const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
            const zip = new ZipClass();

            for (let i = 0; i < pageArray.length; i++) {
              const pNo = pageArray[i];
              statusText.textContent = `Đang giải mã: ${i + 1}/${pageArray.length} (Trang ${pNo})...`;
              const pageObj = pages[pNo - 1];
              const rawBuf = await Utils.fetchBuffer(pageObj.page_image_url);
              const ext = Utils.detectExt(rawBuf);
              const mime = Utils.detectMimeType(rawBuf);
              const img = await Utils.loadImage(rawBuf, mime);
              const res = descrambleCoronaEx(img, pageObj.drm_hash);

              const sharpBlob = await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality));
              zip.addFile(`1_raw/${pNo}.${ext}`, new Uint8Array(rawBuf));
              zip.addFile(`2_decoded/${pNo}.${fmt}`, new Uint8Array(await sharpBlob.arrayBuffer()));
            }

            statusText.textContent = `Đang đóng gói file ZIP...`;
            await sleep(60);
            zip.download(`CoronaEx_Compare_${pageArray[0]}-${pageArray[pageArray.length - 1]}.zip`);
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
   * 5. THEO DÕI CHUYỂN ROUTE TRÌNH DUYỆT (SPA)
   * ========================================================================= */
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      boot();
    }
  }, 400);

  boot();
})();