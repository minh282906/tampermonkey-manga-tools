// ==UserScript==
// @name         Sharp EBLIEVA Inspector
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @description  Inspector soi ma trận không đều, tự động săn nấc Master 1920p và vá dải Seam b1/b2 cho hệ thống Sharp EBLIEVA (comic.jp, music-book.jp, galapagosstore.com).
// @author       anonymous & AI
// @match        https://comic.jp/comic/bv/*
// @match        https://music-book.jp/comic/bv/*
// @match        https://galapagosstore.com/resource/browser/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      img.comic.jp
// @connect      cdn.eblieva.com
// @run-at       document-start
//
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/decoders/SharpEblievaTools.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/InspectorUI.js
// ==/UserScript==

(function sharpEblievaInspector() {
  'use strict';

  const WIN = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const DOC = WIN.document;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  if (WIN.top !== WIN.self) return;

  (function isolateInspectorEvents() {
    function stopLeak(el) {
      if (!el || el.__eblieva_isolated) return;
      el.__eblieva_isolated = true;
      const evts = ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend'];
      evts.forEach(evt => {
        el.addEventListener(evt, e => e.stopPropagation(), false);
      });
    }

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) {
            if (node.id === 'manga-inspector-root' || node.querySelector?.('#insp-wrap') || node.id === 'insp-wrap' || (node.style?.zIndex >= 2147483640)) {
              stopLeak(node);
            }
          }
        }
      }
    });
    observer.observe(DOC.documentElement, { childList: true, subtree: true });
  })();

  function isReaderUrl() {
    const p = WIN.location.pathname;
    return p.includes('/comic/bv/') || p.includes('/resource/browser/');
  }

  function resolveMasterSetting(bookInfo) {
    if (!bookInfo?.Ny) return null;
    const ny = bookInfo.Ny;
    const candidates = Array.isArray(ny) ? ny : (ny.i_width ? [ny] : Object.values(ny));
    if (!candidates.length) return null;

    let master = candidates[0];
    let maxPixels = (master.i_width || 0) * (master.i_height || 0);

    for (let i = 1; i < candidates.length; i++) {
      const cur = candidates[i];
      const pixels = (cur.i_width || 0) * (cur.i_height || 0);
      if (pixels > maxPixels) {
        maxPixels = pixels;
        master = cur;
      }
    }
    return master;
  }

  function getPageLimit(k) {
    if (typeof k.oy === 'number' && k.oy > 0) return k.oy;
    if (typeof k.ny === 'number' && k.ny > 0) return k.ny;
    if (typeof k.ny?.Iy === 'number') return k.ny.Iy;
    return Number(k.lastPage || k.p || 0);
  }

  function getKeyItem(master, pNo) {
    const list = master.d?.Ay?.Dy || master.d?.By?.by || master.d?.ky?.by || [];
    return list.find(k => pNo <= getPageLimit(k)) || list[list.length - 1];
  }

  function extractParamList(master) {
    const list = master.d?.Ay?.Dy || master.d?.By?.by || master.d?.ky?.by || [];
    return list.map(item => ({
      coords: item.ey || item.sy || "",
      lastPage: getPageLimit(item)
    }));
  }

  async function fetchBufferDualFlight(url, Utils) {
    if (!url) return null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await WIN.fetch(url, { headers: { 'Referer': WIN.location.href } });
        if (res.ok) {
          const buf = await res.arrayBuffer();
          if (buf && buf.byteLength > 0) return buf;
        }
      } catch (e) {}

      try {
        const buf = await Utils.fetchBuffer(url, { "Referer": WIN.location.href });
        if (buf && buf.byteLength > 0) return buf;
      } catch (e) {}

      await sleep(150 * attempt);
    }
    return null;
  }

  let isBooting = false;

  async function boot() {
    // 🎯 PHỤC HỒI DÒNG LỆNH SỐNG CÒN: ĐỢI BODY NẠP XONG ĐỂ GẮN UI
    while (!DOC.body) await sleep(50);

    if (isBooting) return;
    if (DOC.getElementById('manga-inspector-root')) return;
    if (!isReaderUrl()) return;

    isBooting = true;
    try {
      let bv = null, master = null, totalPages = 0;

      for (let i = 0; i < 60; i++) {
        bv = WIN.BV?.bookViewer;
        if (bv?.bookInfo) {
          master = resolveMasterSetting(bv.bookInfo);
          if (master?.layout_url) {
            totalPages = Number(bv.currentLayoutData?.Vk || bv.currentLayoutData?.yS || bv.currentLayoutData?.end || 0);
            if (!totalPages) {
              const pList = extractParamList(master);
              if (pList.length > 0) totalPages = pList[pList.length - 1].lastPage;
            }
            if (totalPages > 0) break;
          }
        }
        await sleep(150);
      }

      if (!master || !master.layout_url || totalPages <= 0) return;
      if (Number(master.char_size) > 0) return;

      let layoutUrl = master.layout_url.trim();
      if (layoutUrl.startsWith('//')) layoutUrl = 'https:' + layoutUrl;

      // 🎯 NHẬN DIỆN 0MS QUA PERFORMANCE API (TRIỆT TIÊU 100% RỦI RO ĐOÁN MÒ)
      const recentReqs = WIN.performance?.getEntriesByType?.('resource') || [];
      let isJsonp = recentReqs.some(r => r.name.includes(layoutUrl) && r.name.includes('.jsonp'));

      // Dự phòng an toàn nếu mở trang quá nhanh:
      if (!isJsonp && !recentReqs.some(r => r.name.includes(layoutUrl) && r.name.includes('.jpg'))) {
        const firstP = String(bv.currentLayoutData?.start || 1).padStart(5, '0');
        try {
          const res = await WIN.fetch(`${layoutUrl}/${firstP}.jsonp${WIN.location.search}`, { method: 'HEAD' });
          isJsonp = (res.status === 200);
        } catch(e) {}
      }

      const Tools = WIN.SharpEblievaTools || window.SharpEblievaTools;
      const Utils = WIN.MangaUtils || window.MangaUtils;
      const createUI = window.createInspectorUI || globalThis.createInspectorUI;

      const isGalapagos = WIN.location.hostname.includes('galapagos');
      const isMusicBook = WIN.location.hostname.includes('music-book');
      const titleName = isGalapagos
        ? "COCORO BOOKS INSPECTOR"
        : (isMusicBook ? "MUSIC.JP INSPECTOR" : "COMIC.JP INSPECTOR");

      createUI({
        title: titleName,
        totalPages: totalPages,

        onPreview: async (pNo, onSuccess, onError) => {
          try {
            const fileStem = String(pNo).padStart(5, '0');
            const keyItem = getKeyItem(master, pNo);

            if (isJsonp) {
              const jsonpUrl = `${layoutUrl}/${fileStem}.jsonp?store_code=sharpbvs&pid=sh`;
              const res = await fetchBufferDualFlight(jsonpUrl, Utils);
              if (!res) return onError(`Không thể tải trang ${pNo} từ CDN!`);

              const text = new TextDecoder().decode(res);
              const pageData = Tools.decryptGalapagosJsonp(text, keyItem);
              const renderResult = await Tools.stitchGalapagosCanvas(pageData, Utils);

              onSuccess({ ...renderResult, rawExt: "JPG", rawBuf: res }, pNo);
              return;
            }

            // 🎯 PHÂN NHÁNH 2: COMIC.JP & MUSIC-BOOK.JP
            const imgUrl = `${layoutUrl}/${fileStem}.jpg`;
            const b1Url  = `${layoutUrl}/${fileStem}_b1.png`;
            const b2Url  = `${layoutUrl}/${fileStem}_b2.png`;

            const [rawBuf, b1Buf, b2Buf] = await Promise.all([
              fetchBufferDualFlight(imgUrl, Utils),
              fetchBufferDualFlight(b1Url, Utils),
              fetchBufferDualFlight(b2Url, Utils)
            ]);

            if (!rawBuf) return onError(`Không thể tải trang ${pNo} từ CDN!`);

            const ext = Utils.detectExt(rawBuf);
            const mime = Utils.detectMimeType(rawBuf);

            const mainImg = await Utils.loadImage(rawBuf, mime);
            const b1Img   = b1Buf ? await Utils.loadImage(b1Buf, 'image/png') : null;
            const b2Img   = b2Buf ? await Utils.loadImage(b2Buf, 'image/png') : null;

            const coordStr = keyItem?.ey || keyItem?.sy || "";
            const res = Tools.descrambleVariantA(mainImg, coordStr, b1Img, b2Img);

            onSuccess({ ...res, rawExt: ext.toUpperCase(), rawBuf }, pNo);
          } catch (e) {
            onError(e?.message || String(e));
          }
        },

        onDownload: async (pageArray, fmt, quality, statusText, btn) => {
          btn.disabled = true;
          try {
            const mimeType = fmt === 'png' ? 'image/png' : (fmt === 'webp' ? 'image/webp' : 'image/jpeg');

            // Hàm tải trực tiếp file lẻ (chống ăn xuyên lật trang)
            function triggerDownload(blobOrBuf, fileName, mime = 'image/jpeg') {
              const blob = (blobOrBuf instanceof Blob) ? blobOrBuf : new Blob([blobOrBuf], { type: mime });
              const url = URL.createObjectURL(blob);
              const a = DOC.createElement('a');
              a.href = url;
              a.download = fileName;
              a.style.display = 'none';
              a.addEventListener('click', e => { e.stopPropagation(); e.stopImmediatePropagation(); }, true);
              DOC.body.appendChild(a);
              a.dispatchEvent(new MouseEvent('click', { bubbles: false, cancelable: true }));
              a.remove();
              setTimeout(() => URL.revokeObjectURL(url), 60000);
            }

            // =========================================================================
            // 🎯 TRƯỜNG HỢP 1: TẢI ĐÚNG 1 TRANG -> TẢI THẲNG FILE ẢNH LẺ (KHÔNG NÉN ZIP)
            // =========================================================================
            if (pageArray.length === 1) {
              const pNo = pageArray[0];
              statusText.textContent = `Đang tải các bản của trang ${pNo}...`;
              const fileStem = String(pNo).padStart(5, '0');
              const keyItem = getKeyItem(master, pNo);

              if (isJsonp) {
                // Nhánh JSONP (Galapagos): Tải 9 lát cắt RAW + 1 bản Đã ghép
                const jsonpUrl = `${layoutUrl}/${fileStem}.jsonp?store_code=sharpbvs&pid=sh`;
                const rawBuf = await fetchBufferDualFlight(jsonpUrl, Utils);
                const text = new TextDecoder().decode(rawBuf);
                const pageData = Tools.decryptGalapagosJsonp(text, keyItem);
                const res = await Tools.stitchGalapagosCanvas(pageData, Utils);

                if (Array.isArray(res.sliceBuffers)) {
                  for (let sIdx = 0; sIdx < res.sliceBuffers.length; sIdx++) {
                    triggerDownload(res.sliceBuffers[sIdx], `Eblieva_Trang_${pNo}_slice_${sIdx + 1}.jpg`, 'image/jpeg');
                    await sleep(40);
                  }
                }
                const sharpBlob = await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality));
                triggerDownload(sharpBlob, `Eblieva_Trang_${pNo}_decoded.${fmt}`, mimeType);

              } else {
                // Nhánh JPG (Comic/Music): Tải RAW.jpg + b1.png + b2.png + 1 bản Đã ghép
                const imgUrl = `${layoutUrl}/${fileStem}.jpg`;
                const b1Url  = `${layoutUrl}/${fileStem}_b1.png`;
                const b2Url  = `${layoutUrl}/${fileStem}_b2.png`;

                const [bImg, b1, b2] = await Promise.all([
                  fetchBufferDualFlight(imgUrl, Utils),
                  fetchBufferDualFlight(b1Url, Utils),
                  fetchBufferDualFlight(b2Url, Utils)
                ]);
                const ext = Utils.detectExt(bImg);
                const mime = Utils.detectMimeType(bImg);
                const mainImg = await Utils.loadImage(bImg, mime);
                const b1Img   = b1 ? await Utils.loadImage(b1, 'image/png') : null;
                const b2Img   = b2 ? await Utils.loadImage(b2, 'image/png') : null;

                const coordStr = keyItem?.ey || keyItem?.sy || "";
                const res = Tools.descrambleVariantA(mainImg, coordStr, b1Img, b2Img);

                triggerDownload(bImg, `Eblieva_Trang_${pNo}_raw.${ext}`, mime);
                if (b1) { await sleep(40); triggerDownload(b1, `Eblieva_Trang_${pNo}_b1.png`, 'image/png'); }
                if (b2) { await sleep(40); triggerDownload(b2, `Eblieva_Trang_${pNo}_b2.png`, 'image/png'); }

                const sharpBlob = await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality));
                await sleep(40);
                triggerDownload(sharpBlob, `Eblieva_Trang_${pNo}_decoded.${fmt}`, mimeType);
              }

              statusText.textContent = `✅ Đã tải xong các file lẻ trang ${pNo}!`;

            } else {
              // =========================================================================
              // 🎯 TRƯỜNG HỢP 2: TỪ 2 TRANG TRỞ LÊN -> ĐÓNG GÓI DUY NHẤT 1 FILE ZIP
              // =========================================================================
              const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
              const zip = new ZipClass();

              for (let i = 0; i < pageArray.length; i++) {
                const pNo = pageArray[i];
                statusText.textContent = `Đang xử lý: ${i + 1}/${pageArray.length} (Trang ${pNo})...`;
                const fileStem = String(pNo).padStart(5, '0');
                const keyItem = getKeyItem(master, pNo);

                if (isJsonp) {
                  const jsonpUrl = `${layoutUrl}/${fileStem}.jsonp?store_code=sharpbvs&pid=sh`;
                  const rawBuf = await fetchBufferDualFlight(jsonpUrl, Utils);
                  if (!rawBuf) continue;
                  const text = new TextDecoder().decode(rawBuf);
                  const pageData = Tools.decryptGalapagosJsonp(text, keyItem);
                  const res = await Tools.stitchGalapagosCanvas(pageData, Utils);

                  if (Array.isArray(res.sliceBuffers)) {
                    res.sliceBuffers.forEach((buf, sIdx) => {
                      zip.addFile(`1_raw/${pNo}_slice_${sIdx + 1}.jpg`, buf);
                    });
                  }
                  const sharpBlob = await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality));
                  zip.addFile(`2_decoded/${pNo}.${fmt}`, new Uint8Array(await sharpBlob.arrayBuffer()));

                } else {
                  const imgUrl = `${layoutUrl}/${fileStem}.jpg`;
                  const b1Url  = `${layoutUrl}/${fileStem}_b1.png`;
                  const b2Url  = `${layoutUrl}/${fileStem}_b2.png`;

                  const [bImg, b1, b2] = await Promise.all([
                    fetchBufferDualFlight(imgUrl, Utils),
                    fetchBufferDualFlight(b1Url, Utils),
                    fetchBufferDualFlight(b2Url, Utils)
                  ]);
                  if (!bImg) continue;

                  const ext = Utils.detectExt(bImg);
                  const mime = Utils.detectMimeType(bImg);
                  const mainImg = await Utils.loadImage(bImg, mime);
                  const b1Img   = b1 ? await Utils.loadImage(b1, 'image/png') : null;
                  const b2Img   = b2 ? await Utils.loadImage(b2, 'image/png') : null;

                  const coordStr = keyItem?.ey || keyItem?.sy || "";
                  const res = Tools.descrambleVariantA(mainImg, coordStr, b1Img, b2Img);

                  zip.addFile(`1_raw/${pNo}.${ext}`, new Uint8Array(bImg));
                  if (b1) zip.addFile(`1_raw/${pNo}_b1.png`, new Uint8Array(b1));
                  if (b2) zip.addFile(`1_raw/${pNo}_b2.png`, new Uint8Array(b2));

                  const sharpBlob = await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality));
                  zip.addFile(`2_decoded/${pNo}.${fmt}`, new Uint8Array(await sharpBlob.arrayBuffer()));
                }

                await sleep(25);
              }

              statusText.textContent = `Đang đóng gói file ZIP...`;
              await sleep(50);
              const zipName = `Eblieva_Compare_${pageArray[0]}-${pageArray[pageArray.length - 1]}.zip`;
              zip.download(zipName);
              statusText.textContent = `✅ Đã xuất xong file ZIP đối chiếu!`;
            }
          } catch (e) {
            statusText.textContent = `❌ ${e?.message || String(e)}`;
          } finally {
            btn.disabled = false;
          }
        }
      });
    } finally {
      isBooting = false;
    }
  }

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      DOC.getElementById('manga-inspector-root')?.remove();
      boot();
    } else if (!DOC.getElementById('manga-inspector-root') && isReaderUrl()) {
      boot();
    }
  }, 400);

  boot();
})();