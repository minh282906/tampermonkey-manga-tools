// ==UserScript==
// @name         Jumptoon Inspector
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.4.0
// @description  Inspector soi ma trận dải dọc và tải đối chiếu 2 bản ảnh cho Shueisha Jumptoon (jumptoon.com).
// @author       anonymous & AI
// @match        https://jumptoon.com/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-start
//
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/decoders/JumptoonTools.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/InspectorUI.js
// ==/UserScript==

(function jumptoonInspector() {
  'use strict';
  const WIN = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const DOC = WIN.document;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  if (WIN.top !== WIN.self) return;

  let capturedContent = null;
  let lastCleanUrl = "";

  /* =========================================================================
   * 1. BỘ LỌC ĐỊNH TUYẾN URL THÔNG MINH & TRÍCH XUẤT CONTEXT
   * ========================================================================= */
  function getCleanUrl() {
    return location.origin + location.pathname + location.search;
  }

  function getCurrentContext() {
    const p = location.pathname;
    const s = location.search;

    if (p === '/' || p === '') return { isReader: false };
    if (s.includes('type=episodes') || s.includes('type=comics')) return { isReader: false };
    if (/\/series\/[^\/]+\/episodes\/?$/.test(p) || /\/series\/[^\/]+\/comics\/?$/.test(p)) return { isReader: false };

    const sMatch = p.match(/\/series\/([A-Za-z0-9_-]+)/);
    const seriesId = sMatch ? sMatch[1] : null;

    const epMatch = p.match(/\/episodes\/(\d+)/);
    const episodeId = epMatch ? epMatch[1] : null;
    const isTrial = p.includes('/trial/');

    return {
      isReader: Boolean(seriesId),
      seriesId,
      episodeId,
      isTrial
    };
  }

  function unescapeRscString(str) {
    if (!str) return '';
    return str.replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
  }

  /* =========================================================================
   * 2. BỘ BÓC TÁCH VẠN NĂNG (BRACKET PARSER: HỖ TRỢ ĐỦ 3 DẠNG VIEWER)
   * ========================================================================= */
  function extractObjectByKey(cleanStr, keyName) {
    const keyStr = `"${keyName}":`;
    const idx = cleanStr.indexOf(keyStr);
    if (idx === -1) return null;
    const braceStart = cleanStr.indexOf('{', idx + keyStr.length);
    if (braceStart === -1) return null;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = braceStart; i < cleanStr.length; i++) {
      const ch = cleanStr[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }

      if (!inString) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            const jsonStr = cleanStr.slice(braceStart, i + 1);
            try {
              return JSON.parse(jsonStr);
            } catch (e) {
              return null;
            }
          }
        }
      }
    }
    return null;
  }

  function parseRscChunk(rawStr, ctx) {
    if (!rawStr || !rawStr.includes('pageList')) return null;

    try {
      const clean = rawStr.replace(/\\"/g, '"').replace(/\\u0026/g, '&');

      // PHÂN LẬP KEY THEO ĐÚNG NGỮ CẢNH TRANG ĐANG XEM:
      let candidateKeys = [];
      if (ctx.isTrial) {
        // Đang ở Tankobon Trial -> CHỈ LẤY seriesComicsContent
        candidateKeys = ['seriesComicsContent'];
      } else if (ctx.episodeId) {
        // Đang ở trang đọc Chap chính thức -> CHỈ LẤY seriesEpisodeContent (CẤM LẤY previewContent!)
        candidateKeys = ['seriesEpisodeContent'];
      } else {
        // Đang ở trang Series -> MỚI ĐƯỢC LẤY previewContent
        candidateKeys = ['previewContent'];
      }

      for (const k of candidateKeys) {
        if (clean.includes(`"${k}"`)) {
          const content = extractObjectByKey(clean, k);
          if (content?.pageList && Array.isArray(content.pageList) && content.pageList.length > 0) {
            // Khóa ID truyện
            if (content.seriesId && ctx.seriesId && String(content.seriesId) !== String(ctx.seriesId)) {
              continue;
            }
            return content;
          }
        }
      }
    } catch (e) {}
    return null;
  }

  async function resolveFreshContent(ctx) {
    const scripts = Array.from(DOC.querySelectorAll('script'));
    for (const s of scripts) {
      const txt = s.textContent || '';
      if (txt.includes('pageList')) {
        const parsed = parseRscChunk(txt, ctx); // Truyền ctx vào đây
        if (parsed) return parsed;
      }
    }

    // Nếu script DOM không có (vì vừa chuyển từ Series vào Chap), tự động kéo ?_rsc=1 tươi mới
    try {
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const rscUrl = `${location.pathname}?_rsc=1`;
      const buf = await Utils.fetchBuffer(rscUrl, { 'RSC': '1', 'Referer': location.href });
      const txt = new TextDecoder().decode(buf);
      const parsed = parseRscChunk(txt, ctx); // Truyền ctx vào đây
      if (parsed) return parsed;
    } catch (e) {}

    return null;
  }

  /* =========================================================================
   * 3. RENDER CANVAS POINT SAMPLING
   * ========================================================================= */
  function descrambleJumptoon(img, pageObj, seed, algoType) {
    const rawW = img.naturalWidth || img.width;
    const rawH = img.naturalHeight || img.height;
    const targetW = Number(pageObj.width) || rawW;
    const targetH = Number(pageObj.height) || rawH;

    const Tools = WIN.JumptoonTools || window.JumptoonTools;
    const geom = Tools.calculateCoords(seed, algoType, targetW, rawW, targetH);

    const sharpCanvas = DOC.createElement('canvas');
    sharpCanvas.width = targetW;
    sharpCanvas.height = targetH;
    const sCtx = sharpCanvas.getContext('2d', { alpha: false });
    sCtx.imageSmoothingEnabled = false;
    sCtx.mozImageSmoothingEnabled = false;
    sCtx.webkitImageSmoothingEnabled = false;
    sCtx.msImageSmoothingEnabled = false;

    for (const c of geom.coords) {
      sCtx.drawImage(
        img,
        c.srcX, c.srcY, c.width, c.height,
        c.destX, c.destY, c.width, c.height
      );
    }

    const visualCanvas = DOC.createElement('canvas');
    visualCanvas.width = rawW;
    visualCanvas.height = rawH;
    const vCtx = visualCanvas.getContext('2d', { alpha: false });
    vCtx.imageSmoothingEnabled = false;
    vCtx.mozImageSmoothingEnabled = false;
    vCtx.webkitImageSmoothingEnabled = false;
    vCtx.msImageSmoothingEnabled = false;

    vCtx.fillStyle = '#ff007f';
    vCtx.fillRect(0, 0, rawW, rawH);
    vCtx.drawImage(sharpCanvas, 0, 0);

    vCtx.strokeStyle = '#00ffff';
    vCtx.lineWidth = 4;
    vCtx.strokeRect(0, 0, targetW, targetH);

    const dummyText = `Gọt rãnh đệm: Dư ${rawW - targetW}px ngang (Đã gọt sạch ${geom.numSlices} dải cột)`;

    return {
      rawW,
      rawH,
      gridW: targetW,
      gridH: targetH,
      dummyText,
      visualCanvas,
      sharpCanvas,
      img
    };
  }

  /* =========================================================================
   * 4. KHỞI CHẠY (BOOT) - ẨN MẶC ĐỊNH & KHÔNG CHỚP NHÁY
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(50);

    DOC.getElementById('manga-inspector-root')?.remove();
    const ctx = getCurrentContext();

    if (!ctx.isReader) return;

    capturedContent = null;
    capturedContent = await resolveFreshContent(ctx);

    if (!capturedContent || !capturedContent.pageList || !capturedContent.pageList.length) {
      return;
    }

    if (!DOC.getElementById('jumptoon-insp-css-reset')) {
      const styleReset = DOC.createElement('style');
      styleReset.id = 'jumptoon-insp-css-reset';
      styleReset.textContent = `
        #manga-inspector-root * {
          box-sizing: border-box !important;
          margin: 0 !important;
          line-height: normal !important;
        }
        #manga-inspector-root button {
          box-sizing: border-box !important;
          display: inline-flex !important;
          align-items: center !important;
          justify-content: center !important;
          min-width: 0 !important;
          min-height: 0 !important;
          height: 28px !important;
        }
        #manga-inspector-root #insp-fmt-group button {
          height: 24px !important;
        }
        #manga-inspector-root input[type="text"] {
          box-sizing: border-box !important;
          height: 28px !important;
          line-height: 28px !important;
        }
      `;
      DOC.head.appendChild(styleReset);
    }

    const content = capturedContent;
    const pages = content.pageList;
    const Tools = WIN.JumptoonTools || window.JumptoonTools;
    if (!Tools) return;

    const seed = Tools.computeSeed(content.seriesId, content.number || '1');
    const algoType = content.scrambleAlgorithmType || 'V2';

    const createUI = window.createInspectorUI || globalThis.createInspectorUI;
    createUI({
      title: content.seriesEpisodeEdge ? "JUMPTOON (WEBTOON)" : "JUMPTOON (COMICS)",
      totalPages: pages.length,

      onPreview: async (pNo, onSuccess, onError) => {
        const pageObj = pages[pNo - 1];
        if (!pageObj || !pageObj.imageUrl) return onError("Trang không tồn tại!");

        try {
          const Utils = window.MangaUtils || globalThis.MangaUtils;
          const cleanUrl = unescapeRscString(pageObj.imageUrl);
          const rawBuf = await Utils.fetchBuffer(cleanUrl, { "Referer": "https://jumptoon.com/" });
          const ext = Utils.detectExt(rawBuf);
          const mime = Utils.detectMimeType(rawBuf);
          const img = await Utils.loadImage(rawBuf, mime);

          const res = descrambleJumptoon(img, pageObj, seed, algoType);
          onSuccess({ ...res, rawExt: ext.toUpperCase(), rawBuf }, pNo);
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
            const cleanUrl = unescapeRscString(pageObj.imageUrl);
            const rawBuf = await Utils.fetchBuffer(cleanUrl, { "Referer": "https://jumptoon.com/" });
            const ext = Utils.detectExt(rawBuf);
            const mime = Utils.detectMimeType(rawBuf);
            const img = await Utils.loadImage(rawBuf, mime);
            const res = descrambleJumptoon(img, pageObj, seed, algoType);

            const a1 = DOC.createElement('a');
            a1.href = URL.createObjectURL(new Blob([rawBuf], { type: mime }));
            a1.download = `Jumptoon_Trang_${pNo}_raw.${ext}`;
            a1.click();

            const a2 = DOC.createElement('a');
            a2.href = URL.createObjectURL(await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality)));
            a2.download = `Jumptoon_Trang_${pNo}_decoded.${fmt}`;
            a2.click();

            statusText.textContent = `✅ Đã tải xong 2 bản trang ${pNo}!`;
          } else {
            const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
            const zip = new ZipClass();

            for (let i = 0; i < pageArray.length; i++) {
              const pNo = pageArray[i];
              statusText.textContent = `Đang giải mã: ${i + 1}/${pageArray.length} (Trang ${pNo})...`;
              const pageObj = pages[pNo - 1];
              const cleanUrl = unescapeRscString(pageObj.imageUrl);
              const rawBuf = await Utils.fetchBuffer(cleanUrl, { "Referer": "https://jumptoon.com/" });
              const ext = Utils.detectExt(rawBuf);
              const mime = Utils.detectMimeType(rawBuf);
              const img = await Utils.loadImage(rawBuf, mime);
              const res = descrambleJumptoon(img, pageObj, seed, algoType);

              const sharpBlob = await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality));
              zip.addFile(`1_raw/${pNo}.${ext}`, new Uint8Array(rawBuf));
              zip.addFile(`2_decoded/${pNo}.${fmt}`, new Uint8Array(await sharpBlob.arrayBuffer()));
            }

            statusText.textContent = `Đang đóng gói file ZIP...`;
            await sleep(60);
            zip.download(`Jumptoon_Compare_${pageArray[0]}-${pageArray[pageArray.length - 1]}.zip`);
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
   * 5. THEO DÕI ĐỔI URL SPA (BỎ QUA HASH #1, #2)
   * ========================================================================= */
  lastCleanUrl = getCleanUrl();
  setInterval(() => {
    const cur = getCleanUrl();
    if (cur !== lastCleanUrl) {
      lastCleanUrl = cur;
      boot();
    }
  }, 350);

  boot();
})();