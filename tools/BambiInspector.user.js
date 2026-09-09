// ==UserScript==
// @name         Bambi Inspector
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      3.0.0
// @description  Inspector soi ma trận hoán vị 4x4 PRNG Xorshift32 và tải đối chiếu 2 bản ảnh cho toàn bộ hệ sinh thái Bambi Engine (MagaPoke, K MANGA, Ciao Plus).
// @author       anonymous & AI
// @match        https://pocket.shonenmagazine.com/*
// @match        https://kmanga.kodansha.com/*
// @match        https://ciao.shogakukan.co.jp/comics/title/*/episode/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-start
//
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/decoders/BambiTools.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/InspectorUI.js
// ==/UserScript==

(function bambiInspector() {
  'use strict';
  const WIN = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const DOC = WIN.document;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  if (WIN.top !== WIN.self) return;

  let capturedApi = null;

  /* =========================================================================
   * 1. HOOK THUẦN TÚY NHƯ KODANSHA-INSPECTOR GỐC (0% XUNG ĐỘT MẠNG)
   * ========================================================================= */
  const origFetch = WIN.fetch;
  if (typeof origFetch === 'function') {
    WIN.fetch = async function(...args) {
      const res = await origFetch.apply(this, args);
      try {
        const u = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        if (u.includes('/web/episode/viewer')) {
          const epMatch = u.match(/[?&]episode_id=(\d+)/);
          res.clone().json().then(d => {
            if (d?.page_list || d?.pages || d?.data?.page_list) {
              const targetId = String(d.episode_id || (epMatch ? epMatch[1] : '') || '');
              if (targetId) {
                d.episode_id = targetId;
                // Lưu vào cache theo đúng ID để F5 có ngay tại 0ms
                try { sessionStorage.setItem(`bambi_insp_cache_${targetId}`, JSON.stringify(d)); } catch(e) {}
              }
              capturedApi = d;
            }
          }).catch(() => {});
        }
      } catch (e) {}
      return res;
    };
  }

  /* =========================================================================
   * 2. BỘ CẤU HÌNH CHO 3 NỀN TẢNG (MAGAPOKE, K MANGA, CIAO PLUS)
   * ========================================================================= */
  function getSiteInfo() {
    const host = location.hostname;
    const path = location.pathname;
    const m = path.match(/\/episode\/(\d+)/);
    const epId = m ? m[1] : "";

    if (host.includes('pocket.shonenmagazine.com') && epId) {
      return { id: "magapoke", title: "BAMBI ENGINE (MAGAPOKE)", epId, isKManga: false, isCiao: false };
    }
    if (host.includes('kmanga.kodansha.com') && epId) {
      return { id: "kmanga", title: "BAMBI ENGINE (K MANGA)", epId, isKManga: true, isCiao: false };
    }
    if (host.includes('ciao.shogakukan.co.jp') && path.includes('/comics/title/')) {
      return { id: "ciaoplus", title: "BAMBI ENGINE (CIAO PLUS)", epId, isKManga: false, isCiao: true };
    }
    return null;
  }

  /* =========================================================================
   * 3. TÁI TẠO ĐỒ HỌA THEO TAXONOMY NHÓM 2 (GIỮ VIỀN NGUYÊN VẸN)
   * ========================================================================= */
  function descrambleBambiInspector(img, seed, ver = 2) {
    const Tools = WIN.BambiTools || window.BambiTools;
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;

    const { canvas: sharpCanvas, blockDim, gridW, gridH } = Tools.descrambleBambiCanvas(img, seed, ver);
    const dummyW = w - gridW;
    const dummyH = h - gridH;

    const visualCanvas = DOC.createElement('canvas');
    visualCanvas.width = w; visualCanvas.height = h;
    const vCtx = visualCanvas.getContext('2d', { alpha: false });
    vCtx.imageSmoothingEnabled = false;
    vCtx.drawImage(sharpCanvas, 0, 0);

    if (dummyW > 0 || dummyH > 0) {
      vCtx.strokeStyle = '#ff007f';
      vCtx.lineWidth = 2;
      vCtx.strokeRect(0, 0, gridW, gridH);
    }

    vCtx.strokeStyle = '#00ffff';
    vCtx.lineWidth = 4;
    vCtx.strokeRect(0, 0, w, h);

    const dummyText = (dummyW > 0 || dummyH > 0)
      ? `Mép giữ nguyên: ${dummyW}px phải, ${dummyH}px đáy (Không xáo trộn)`
      : `Khớp 100% không có viền thừa`;

    return {
      rawW: w, rawH: h, gridW, gridH, dummyText,
      visualCanvas, sharpCanvas, img
    };
  }

  /* =========================================================================
   * 4. HÀM BOOT: ĐỢI ĐÚNG GÓI TIN CỦA TẬP ĐANG MỞ (FIX DỨT ĐIỂM CHẬM 1 NHỊP)
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(50);
    const site = getSiteInfo();
    if (!site || !site.epId) return;

    let apiData = null;

    // 1. Kiểm tra RAM: Nếu capturedApi trùng đúng tập hiện tại
    if (capturedApi && String(capturedApi.episode_id || '') === String(site.epId)) {
      apiData = capturedApi;
    }

    // 2. [CỨU TINH F5 - 0ms]: Đọc ngay từ sessionStorage nếu vừa bấm F5
    if (!apiData) {
      try {
        const cached = sessionStorage.getItem(`bambi_insp_cache_${site.epId}`);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (parsed?.page_list || parsed?.pages || parsed?.data?.page_list) {
            apiData = parsed;
            capturedApi = parsed;
          }
        }
      } catch(e) {}
    }

    // 3. Nếu chuyển sang tập mới chưa có cache: Đợi đúng gói tin của tập đó
    if (!apiData) {
      for (let i = 0; i < 30; i++) {
        if (capturedApi && String(capturedApi.episode_id || '') === String(site.epId)) {
          apiData = capturedApi;
          break;
        }
        await sleep(150);
      }
    }

    const rawPages = apiData?.page_list || apiData?.pages || apiData?.data?.page_list || [];
    if (!rawPages.length) return;

    // Xóa UI cũ để cập nhật số trang mới
    DOC.getElementById('manga-inspector-root')?.remove();

    const Tools = WIN.BambiTools || window.BambiTools;
    const mangaId = Number(apiData.title_id || apiData.mangaId || 0);
    const rawSeed = apiData.scramble_seed || apiData.seed || "";
    let finalSeed = 0;

    if (site.isCiao) {
      finalSeed = Number(rawSeed) >>> 0;
    } else {
      const charset = site.isKManga
        ? (mangaId % 2 === 0 ? Tools.CHARSETS.KMANGA_EVEN : Tools.CHARSETS.KMANGA_ODD)
        : (mangaId % 2 === 0 ? Tools.CHARSETS.MAGAPOKE_EVEN : Tools.CHARSETS.MAGAPOKE_ODD);
      finalSeed = Tools.parseCharsetSeed(rawSeed, charset, mangaId, site.epId);
    }

    const ver = apiData.scramble_ver ?? 2;

    const createUI = window.createInspectorUI || globalThis.createInspectorUI;
    createUI({
      title: site.title,
      totalPages: rawPages.length,
      onPreview: async (pNo, onSuccess, onError) => {
        const imgUrl = rawPages[pNo - 1];
        if (!imgUrl) return onError("Trang không tồn tại!");
        try {
          const Utils = WIN.MangaUtils || window.MangaUtils;
          const rawBuf = await Utils.fetchBuffer(imgUrl);
          const ext = Utils.detectExt(rawBuf);
          const mime = Utils.detectMimeType(rawBuf);
          const img = await Utils.loadImage(rawBuf, mime);
          const res = descrambleBambiInspector(img, finalSeed, ver);

          onSuccess({ ...res, rawExt: ext.toUpperCase(), rawBuf }, pNo);
        } catch (e) { onError(e?.message || String(e)); }
      },
      onDownload: async (pageArray, fmt, quality, statusText, btn) => {
        btn.disabled = true;
        try {
          const Utils = WIN.MangaUtils || window.MangaUtils;
          const mimeType = fmt === 'png' ? 'image/png' : (fmt === 'webp' ? 'image/webp' : 'image/jpeg');

          if (pageArray.length === 1) {
            const pNo = pageArray[0];
            const imgUrl = rawPages[pNo - 1];
            const rawBuf = await Utils.fetchBuffer(imgUrl);
            const ext = Utils.detectExt(rawBuf);
            const mime = Utils.detectMimeType(rawBuf);
            const img = await Utils.loadImage(rawBuf, mime);
            const res = descrambleBambiInspector(img, finalSeed, ver);

            const a1 = DOC.createElement('a'); a1.href = URL.createObjectURL(new Blob([rawBuf], { type: mime }));
            a1.download = `Bambi_Trang_${pNo}_raw.${ext}`; a1.click();

            const a2 = DOC.createElement('a');
            a2.href = URL.createObjectURL(await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality)));
            a2.download = `Bambi_Trang_${pNo}_decoded.${fmt}`; a2.click();

            statusText.textContent = `✅ Đã tải xong 2 bản trang ${pNo}!`;
          } else {
            const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
            const zip = new ZipClass();

            for (let i = 0; i < pageArray.length; i++) {
              const pNo = pageArray[i];
              statusText.textContent = `Đang giải mã: ${i + 1}/${pageArray.length} (Trang ${pNo})...`;
              const imgUrl = rawPages[pNo - 1];
              const rawBuf = await Utils.fetchBuffer(imgUrl);
              const ext = Utils.detectExt(rawBuf);
              const mime = Utils.detectMimeType(rawBuf);
              const img = await Utils.loadImage(rawBuf, mime);
              const res = descrambleBambiInspector(img, finalSeed, ver);

              const sharpBlob = await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality));
              zip.addFile(`1_raw/${pNo}.${ext}`, new Uint8Array(rawBuf));
              zip.addFile(`2_decoded/${pNo}.${fmt}`, new Uint8Array(await sharpBlob.arrayBuffer()));
            }

            statusText.textContent = `Đang đóng gói file ZIP...`;
            await sleep(60);
            zip.download(`Bambi_Compare_${site.id}_${pageArray[0]}-${pageArray[pageArray.length - 1]}.zip`);
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
   * 5. THEO DÕI ĐỔI URL (SPA) Y HỆT BẢN GỐC
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