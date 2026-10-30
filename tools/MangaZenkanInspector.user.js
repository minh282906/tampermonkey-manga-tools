// ==UserScript==
// @name         MangaZenkan Inspector
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @description  Inspector soi ma trận Pubridge 128px, dải đáy 64px và đối chiếu 2 bản ảnh cho MangaZenkan (mangazenkan.com).
// @author       anonymous & AI
// @match        https://www.mangazenkan.com/viewer/*
// @match        https://mangazenkan.com/viewer/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      ebook.mangazenkan.com
// @run-at       document-start
//
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/decoders/MangaZenkanTools.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/InspectorUI.js
// ==/UserScript==

(function mangaZenkanInspector() {
  'use strict';
  const WIN = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const DOC = WIN.document;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  if (WIN.top !== WIN.self) return;

  function isViewerUrl() {
    return WIN.location.pathname.includes('/viewer/');
  }

  function getContentsId() {
    const m = WIN.location.pathname.match(/\/viewer\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : null;
  }

  async function fetchManifest(contentsId) {
    const sp = new URLSearchParams(WIN.location.search);
    const trialParam = sp.get('trial') || '1';
    const apiUrl = `https://www.mangazenkan.com/api/v2/ebook/content/?contents_id_20=${contentsId}&trial=${trialParam}`;

    const res = await WIN.fetch(apiUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }

  async function boot() {
    while (!DOC.body) await sleep(50);
    DOC.getElementById('manga-inspector-root')?.remove();

    if (!isViewerUrl()) return;

    const contentsId = getContentsId();
    if (!contentsId) return;

    let manifest = null;
    for (let i = 0; i < 30; i++) {
      try {
        manifest = await fetchManifest(contentsId);
        if (manifest?.page_list?.length > 0) break;
      } catch (e) {}
      await sleep(150);
    }

    if (!manifest?.page_list?.length) return;

    const pages = manifest.page_list;
    const baseCdn = manifest.image_cdn_url_base;
    const blockLen = manifest.BLOCKLEN || 128;

    const Tools = WIN.MangaZenkanTools || window.MangaZenkanTools;
    const Utils = WIN.MangaUtils || window.MangaUtils;
    const createUI = window.createInspectorUI || globalThis.createInspectorUI;

    createUI({
      title: "MANGAZENKAN INSPECTOR",
      totalPages: pages.length,
      onPreview: async (pNo, onSuccess, onError) => {
        try {
          const pageObj = pages[pNo - 1];
          if (!pageObj) return onError("Trang không tồn tại!");

          const fullUrl = `${baseCdn}${pageObj.url}`;
          const rawBuf = await Utils.fetchBuffer(fullUrl, { "Referer": WIN.location.href });

          // Nhận diện định dạng nhị phân nguyên bản từ Magic Bytes
          const ext = Utils.detectExt(rawBuf);
          const mime = Utils.detectMimeType(rawBuf);

          const img = await Utils.loadImage(rawBuf, mime);
          const res = Tools.descrambleMangaZenkanCanvas(img, pageObj.shuffle_map, blockLen);

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
            const fullUrl = `${baseCdn}${pageObj.url}`;

            const rawBuf = await Utils.fetchBuffer(fullUrl, { "Referer": WIN.location.href });
            const ext = Utils.detectExt(rawBuf);
            const mime = Utils.detectMimeType(rawBuf);

            const img = await Utils.loadImage(rawBuf, mime);
            const res = Tools.descrambleMangaZenkanCanvas(img, pageObj.shuffle_map, blockLen);

            // 1. Tải bản RAW xáo trộn gốc
            const a1 = DOC.createElement('a');
            a1.href = URL.createObjectURL(new Blob([rawBuf], { type: mime }));
            a1.download = `MangaZenkan_Trang_${pNo}_raw.${ext}`;
            a1.click();

            // 2. Tải bản ĐÃ GHÉP giải mã sắc đanh
            const a2 = DOC.createElement('a');
            a2.href = URL.createObjectURL(await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality)));
            a2.download = `MangaZenkan_Trang_${pNo}_decoded.${fmt}`;
            a2.click();

            statusText.textContent = `✅ Đã tải xong 2 bản trang ${pNo}!`;
          } else {
            const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
            const zip = new ZipClass();

            for (let i = 0; i < pageArray.length; i++) {
              const pNo = pageArray[i];
              statusText.textContent = `Đang xử lý: ${i + 1}/${pageArray.length} (Trang ${pNo})...`;
              const pageObj = pages[pNo - 1];
              const fullUrl = `${baseCdn}${pageObj.url}`;

              const rawBuf = await Utils.fetchBuffer(fullUrl, { "Referer": WIN.location.href });
              const ext = Utils.detectExt(rawBuf);
              const mime = Utils.detectMimeType(rawBuf);

              const img = await Utils.loadImage(rawBuf, mime);
              const res = Tools.descrambleMangaZenkanCanvas(img, pageObj.shuffle_map, blockLen);

              const sharpBlob = await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality));
              zip.addFile(`1_raw/${pNo}.${ext}`, new Uint8Array(rawBuf));
              zip.addFile(`2_decoded/${pNo}.${fmt}`, new Uint8Array(await sharpBlob.arrayBuffer()));
            }

            statusText.textContent = `Đang đóng gói file ZIP...`;
            await sleep(60);
            zip.download(`MangaZenkan_Compare_${pageArray[0]}-${pageArray[pageArray.length - 1]}.zip`);
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
  }, 400);

  boot();
})();