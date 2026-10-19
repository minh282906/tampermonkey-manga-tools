// ==UserScript==
// @name         Clip Studio Reader Inspector
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      2.2.0
// @description  Inspector soi ma trận, viền dư và đối chiếu 2 bản ảnh cho CLIP STUDIO READER / CSR Engine (Firecross, Hakusensha BS, ComicDC, Drecom Media, MobileBook, ComicFesta).
// @author       anonymous & AI
// @match        https://firecross.jp/reader/*
// @match        https://*.firecross.jp/reader/*
// @match        https://comic-viewer.iowl.jp/*
// @match        https://drecom-media.jp/viewer/*
// @match        https://bsreader.hakusensha-e.net/*
// @match        https://bs.comicdc.jp/*
// @match        https://mbj-bs.pf.mobilebook.jp/*
// @match        https://bs.web-viewer.honto.jp/*
// @match        https://bsreader.handycomic.jp/*
// @match        https://api.distribution.mediadotech.com/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-start
//
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/decoders/ClipStudioTools.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/InspectorUI.js
// ==/UserScript==

(function clipStudioInspector() {
  'use strict';
  const WIN = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const DOC = WIN.document;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  if (WIN.top !== WIN.self) return;

  /* =========================================================================
   * [QUAN TRỌNG: BẺ KHÓA BÀN PHÍM CAPTURE PHASE]
   * Tước bỏ quyền chặn F12 / Ctrl+R của Celsys và mở khóa gõ phím ô Input số trang
   * ========================================================================= */
  (function unlockKeyboardMouseAndDevTools() {
    // 1. Tiêm CSS ép cho phép bôi đen text trên ô Input (đè bẹp CSS cấm copy của MobileBook)
    const style = DOC.createElement('style');
    style.textContent = `
      #manga-inspector-root input, #manga-inspector-root textarea {
        -webkit-user-select: text !important;
        -moz-user-select: text !important;
        -ms-user-select: text !important;
        user-select: text !important;
        pointer-events: auto !important;
      }
    `;
    (DOC.head || DOC.documentElement).appendChild(style);

    // 2. Mở khóa chuột: cho phép click đặt trỏ và kéo chuột quét khối bôi đen
    function mouseShieldHandler(e) {
      if (e.target?.closest('#manga-inspector-root') || e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') {
        e.stopImmediatePropagation(); // Tước quyền chặn selectstart & mousedown của MobileBook
      }
    }
    WIN.addEventListener('selectstart', mouseShieldHandler, true);
    WIN.addEventListener('mousedown', mouseShieldHandler, true);
    WIN.addEventListener('pointerdown', mouseShieldHandler, true);

    // 3. Mở khóa phím F12, F5, Ctrl+R
    function keyShieldHandler(e) {
      const target = e.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.closest('#manga-inspector-root'))) {
        e.stopImmediatePropagation();
        return;
      }
      const isDevTools = e.key === 'F12' || 
                        ((e.ctrlKey || e.metaKey) && e.shiftKey && ['i', 'I', 'j', 'J', 'c', 'C'].includes(e.key)) ||
                        ((e.altKey || e.metaKey) && ['i', 'I'].includes(e.key));
      const isReload = e.key === 'F5' || ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R'));

      if (isDevTools || isReload) {
        e.stopImmediatePropagation();
      }
    }
    WIN.addEventListener('keydown', keyShieldHandler, true);
    WIN.addEventListener('keyup', keyShieldHandler, true);
    WIN.addEventListener('keypress', keyShieldHandler, true);
    WIN.addEventListener('contextmenu', (e) => {
      if (e.target?.closest('#manga-inspector-root')) e.stopImmediatePropagation();
    }, true);
  })();

  /* =========================================================================
   * 1. BÓC TÁCH THÔNG SỐ VIEWER (TẢI MẠNG ĐÚNG 1 LẦN DUY NHẤT)
   * ========================================================================= */
  async function fetchViewerNetworkContext() {
    const urlParams = new URLSearchParams(WIN.location.search);
    const paramInput = DOC.querySelector('input[name="param"]');
    const cgiInput = DOC.querySelector('input[name="cgi"]');

    const rawParam = paramInput ? paramInput.value.trim() : (urlParams.get('param') || '').trim();
    const rawCgi = cgiInput ? cgiInput.value.trim() : (urlParams.get('cgi') || '').trim();
    if (!rawParam || !rawCgi) return null;

    let baseUrl = rawCgi;
    if (baseUrl.startsWith('/')) baseUrl = `${location.origin}${baseUrl}`;
    let param = encodeURIComponent(rawParam);

    let vm = urlParams.get('vm');
    const isVertical = urlParams.get('viewer_type') === 'vertical' || urlParams.has('webtoon_margin');
    if (!vm) vm = isVertical ? '2' : '4';

    const Utils = WIN.MangaUtils || window.MangaUtils;
    const Tools = WIN.ClipStudioTools || window.ClipStudioTools;

    // Handshake 999 (nếu có)
    try {
      const handshakeUrl = `${baseUrl}?mode=999&file=&reqtype=1&vm=${vm}&param=${param}&time=${Date.now()}`;
      const hsBuf = await Utils.fetchBuffer(handshakeUrl);
      const mToken = new TextDecoder().decode(hsBuf).match(/<Content>([^<]+)<\/Content>/i);
      if (mToken && mToken[1]) param = encodeURIComponent(mToken[1].trim());
    } catch (e) {}

    // Kéo face.xml (chỉ 1 lần duy nhất)
    let faceTotalPages = null;
    let gridCols = 4, gridRows = 4;
    try {
      const manifestFile = urlParams.get('file') || 'face.xml';
      const manifestUrl = `${baseUrl}?mode=7&file=${manifestFile}&reqtype=0&vm=${vm}&param=${param}&time=${Date.now()}`;
      const buf = await Utils.fetchBuffer(manifestUrl);
      const faceConfig = Tools.parseFaceXml(new TextDecoder().decode(buf));
      if (faceConfig.totalPages) faceTotalPages = faceConfig.totalPages;
      if (faceConfig.cols) gridCols = faceConfig.cols;
      if (faceConfig.rows) gridRows = faceConfig.rows;
    } catch (e) {}

    return { baseUrl, param, vm, isVertical, faceTotalPages, gridCols, gridRows };
  }

  function getDomPageCount() {
    const nombreEl = DOC.getElementById("menu_nombre_total")
                  || DOC.getElementById("paging_slider_nombre_total")
                  || DOC.querySelector('[class*="nombre_total"], .total-pages');
    if (nombreEl) {
      const parsed = parseInt(nombreEl.textContent.trim(), 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return null;
  }

  /* =========================================================================
   * 2. TÁI TẠO ĐỒ HỌA TAXONOMY NHÓM 3 (BẢO TỒN VIỀN DƯ UNTOUCHED REMAINDER)
   * ========================================================================= */
  function descrambleClipStudioCanvas(img, scramblePattern, cols, rows) {
    const Tools = WIN.ClipStudioTools || window.ClipStudioTools;
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;

    const geom = Tools.calculateCoords(w, h, scramblePattern, cols, rows);

    // 1. sharpCanvas (Bản xuất file sạch 100%)
    const sharpCanvas = DOC.createElement('canvas');
    sharpCanvas.width = w;
    sharpCanvas.height = h;
    const sCtx = sharpCanvas.getContext('2d', { alpha: false });
    sCtx.imageSmoothingEnabled = false;
    sCtx.mozImageSmoothingEnabled = false;
    sCtx.webkitImageSmoothingEnabled = false;
    sCtx.msImageSmoothingEnabled = false;

    // [QUAN TRỌNG: GOLDEN RULE 4] Vẽ lót nền 1:1 bảo tồn 100% nét vẽ mép viền dư của họa sĩ
    sCtx.drawImage(img, 0, 0);

    // Dán đè các ô hoán vị
    for (const c of geom.coords) {
      sCtx.drawImage(
        img,
        c.srcX, c.srcY, c.width, c.height,
        c.destX, c.destY, c.width, c.height
      );
    }

    // 2. visualCanvas (Bản Soi Live: Viền Cyan toàn ảnh + Khung Hồng ma trận)
    const visualCanvas = DOC.createElement('canvas');
    visualCanvas.width = w;
    visualCanvas.height = h;
    const vCtx = visualCanvas.getContext('2d', { alpha: false });
    vCtx.imageSmoothingEnabled = false;
    vCtx.drawImage(sharpCanvas, 0, 0);

    if (geom.dummyW > 0 || geom.dummyH > 0) {
      vCtx.strokeStyle = '#ff007f';
      vCtx.lineWidth = 2;
      vCtx.strokeRect(0, 0, geom.gridW, geom.gridH);
    }

    vCtx.strokeStyle = '#00ffff';
    vCtx.lineWidth = 4;
    vCtx.strokeRect(0, 0, w, h);

    const dummyText = (geom.dummyW > 0 || geom.dummyH > 0)
      ? `Mép giữ nguyên: ${geom.dummyW}px phải, ${geom.dummyH}px đáy (Không xáo trộn)`
      : `Khớp ma trận 100% (${geom.cols}x${geom.rows} ô)`;

    return {
      rawW: w,
      rawH: h,
      gridW: geom.gridW,
      gridH: geom.gridH,
      dummyText,
      visualCanvas,
      sharpCanvas,
      img
    };
  }

  /* =========================================================================
   * 3. KHỞI CHẠY BOOT VÀ KẾT NỐI INSPECTORUI
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(50);
    DOC.getElementById('manga-inspector-root')?.remove();

    // 1. Kéo dữ liệu mạng (chỉ chạy 1 lần)
    let netCtx = null;
    for (let r = 0; r < 15; r++) {
      netCtx = await fetchViewerNetworkContext();
      if (netCtx) break;
      await sleep(100);
    }
    if (!netCtx) return;

    // 2. Chờ DOM nạp số trang đọc thử (chỉ lặp trong RAM, 0ms mạng)
    let totalPages = null;
    if (!netCtx.isVertical) {
      for (let w = 0; w < 10; w++) {
        totalPages = getDomPageCount();
        if (totalPages) break;
        await sleep(80);
      }
    }

    // Nếu là Webtoon hoặc hết 800ms DOM không có -> Chốt faceTotalPages
    if (!totalPages) totalPages = netCtx.faceTotalPages;
    if (!totalPages || isNaN(totalPages)) return;

    const ctx = { ...netCtx, totalPages };
    const { baseUrl, param, vm, gridCols, gridRows } = ctx;
    const Tools = WIN.ClipStudioTools || window.ClipStudioTools;
    const Utils = WIN.MangaUtils || window.MangaUtils;
    const createUI = window.createInspectorUI || globalThis.createInspectorUI;

    createUI({
      title: "CLIP STUDIO INSPECTOR",
      totalPages: totalPages,
      onPreview: async (pNo, onSuccess, onError) => {
        try {
          const pageStr = (pNo - 1).toString().padStart(4, '0');

          const xmlUrl = `${baseUrl}?mode=8&file=${pageStr}.xml&reqtype=0&vm=${vm}&param=${param}&time=${Date.now()}`;
          const xmlBuf = await Utils.fetchBuffer(xmlUrl);
          const pattern = Tools.parseScrambleXml(new TextDecoder().decode(xmlBuf));

          const modeImg = baseUrl.includes('handycomic') ? 3 : 1;
          const imgUrl = `${baseUrl}?mode=${modeImg}&file=${pageStr}_0000.bin&reqtype=0&vm=${vm}&param=${param}&time=${Date.now()}`;
          const rawBin = await Utils.fetchBuffer(imgUrl);

          const cleanBytes = Tools.decryptBinary(rawBin);
          const ext = Utils.detectExt(cleanBytes.buffer);
          const mime = Utils.detectMimeType(cleanBytes.buffer);

          const img = await Utils.loadImage(cleanBytes.buffer, mime);
          const res = descrambleClipStudioCanvas(img, pattern, gridCols, gridRows);

          onSuccess({ ...res, rawExt: ext.toUpperCase(), rawBuf: cleanBytes.buffer }, pNo);
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
            const pageStr = (pNo - 1).toString().padStart(4, '0');

            const xmlUrl = `${baseUrl}?mode=8&file=${pageStr}.xml&reqtype=0&vm=${vm}&param=${param}&time=${Date.now()}`;
            const xmlBuf = await Utils.fetchBuffer(xmlUrl);
            const pattern = Tools.parseScrambleXml(new TextDecoder().decode(xmlBuf));

            const modeImg = baseUrl.includes('handycomic') ? 3 : 1;
            const imgUrl = `${baseUrl}?mode=${modeImg}&file=${pageStr}_0000.bin&reqtype=0&vm=${vm}&param=${param}&time=${Date.now()}`;
            const rawBin = await Utils.fetchBuffer(imgUrl);
            const cleanBytes = Tools.decryptBinary(rawBin);
            const ext = Utils.detectExt(cleanBytes.buffer);
            const mime = Utils.detectMimeType(cleanBytes.buffer);

            const img = await Utils.loadImage(cleanBytes.buffer, mime);
            const res = descrambleClipStudioCanvas(img, pattern, gridCols, gridRows);

            const a1 = DOC.createElement('a');
            a1.href = URL.createObjectURL(new Blob([cleanBytes], { type: mime }));
            a1.download = `ClipStudio_Trang_${pNo}_raw.${ext}`;
            a1.click();

            const a2 = DOC.createElement('a');
            a2.href = URL.createObjectURL(await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality)));
            a2.download = `ClipStudio_Trang_${pNo}_decoded.${fmt}`;
            a2.click();

            statusText.textContent = `✅ Đã tải xong 2 bản trang ${pNo}!`;
          } else {
            const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
            const zip = new ZipClass();

            for (let i = 0; i < pageArray.length; i++) {
              const pNo = pageArray[i];
              statusText.textContent = `Đang xử lý: ${i + 1}/${pageArray.length} (Trang ${pNo})...`;
              const pageStr = (pNo - 1).toString().padStart(4, '0');

              const xmlUrl = `${baseUrl}?mode=8&file=${pageStr}.xml&reqtype=0&vm=${vm}&param=${param}&time=${Date.now()}`;
              const xmlBuf = await Utils.fetchBuffer(xmlUrl);
              const pattern = Tools.parseScrambleXml(new TextDecoder().decode(xmlBuf));

              const modeImg = baseUrl.includes('handycomic') ? 3 : 1;
              const imgUrl = `${baseUrl}?mode=${modeImg}&file=${pageStr}_0000.bin&reqtype=0&vm=${vm}&param=${param}&time=${Date.now()}`;
              const rawBin = await Utils.fetchBuffer(imgUrl);
              const cleanBytes = Tools.decryptBinary(rawBin);
              const ext = Utils.detectExt(cleanBytes.buffer);
              const mime = Utils.detectMimeType(cleanBytes.buffer);

              const img = await Utils.loadImage(cleanBytes.buffer, mime);
              const res = descrambleClipStudioCanvas(img, pattern, gridCols, gridRows);

              const sharpBlob = await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality));
              zip.addFile(`1_raw/${pNo}.${ext}`, cleanBytes);
              zip.addFile(`2_decoded/${pNo}.${fmt}`, new Uint8Array(await sharpBlob.arrayBuffer()));
            }

            statusText.textContent = `Đang đóng gói file ZIP...`;
            await sleep(60);
            zip.download(`ClipStudio_Compare_${pageArray[0]}-${pageArray[pageArray.length - 1]}.zip`);
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
      boot();
    }
  }, 400);

  boot();
})();