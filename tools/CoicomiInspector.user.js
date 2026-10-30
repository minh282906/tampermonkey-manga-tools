// ==UserScript==
// @name         Coicomi Inspector
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.1.0
// @description  Inspector soi ma trận 256 ô siêu vi mô, gọt đệm 4px và đối chiếu 2 bản ảnh cho Coicomi (viewer.coicomi.com).
// @author       anonymous & AI
// @match        https://viewer.coicomi.com/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      relay.coicomi.com
// @run-at       document-start
//
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/decoders/CoicomiTools.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/InspectorUI.js
// ==/UserScript==

(function coicomiInspector() {
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
      if (!el || el.__coicomi_isolated) return;
      el.__coicomi_isolated = true;
      const evts = ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend'];
      evts.forEach(evt => {
        el.addEventListener(evt, e => e.stopPropagation(), false);
      });
    }

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) {
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
   * 1. HOOK MẠNG ĐÓN GÓI TIN INFO.PHP (ĐỢT HOÀN CHỈNH) TẠI DOCUMENT-START
   * ========================================================================= */
  let capturedFullList = null;

  const origXhrOpen = WIN.XMLHttpRequest?.prototype?.open;
  const origXhrSend = WIN.XMLHttpRequest?.prototype?.send;
  if (origXhrOpen && origXhrSend) {
    WIN.XMLHttpRequest.prototype.open = function(method, url) {
      this._coicomiUrl = typeof url === 'string' ? url : String(url);
      return origXhrOpen.apply(this, arguments);
    };

    WIN.XMLHttpRequest.prototype.send = function() {
      this.addEventListener('load', () => {
        try {
          if (this._coicomiUrl && this._coicomiUrl.includes('info.php')) {
            const data = JSON.parse(this.responseText);
            // Chỉ bắt khi gói tin đã có đầy đủ danh sách trang (không còn chuỗi rỗng)
            if (Array.isArray(data.zip_100) && data.zip_100.length > 0) {
              const valid = data.zip_100.filter(Boolean);
              if (valid.length === data.zip_100.length) {
                capturedFullList = valid;
              }
            }
          }
        } catch (e) {}
      });
      return origXhrSend.apply(this, arguments);
    };
  }

  /* =========================================================================
   * 2. KHỞI CHẠY BOOT VÀ KẾT NỐI INSPECTORUI
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(50);
    DOC.getElementById('manga-inspector-root')?.remove();

    let pageUrls = [];
    let coverWidth = 0;
    let coverHeight = 0;
    let tArray = null;

    // Chờ cỗ máy viewer_ nạp xong ĐẦY ĐỦ 100% trang trong RAM (không lấy gói mồi rỗng)
    for (let i = 0; i < 60; i++) {
      const v = WIN.viewer || WIN.viewer_ || WIN[DOC.viewerObjName];
      if (v) {
        tArray = v.tArray || tArray;
        coverWidth = Number(v.cover_width) || coverWidth;
        coverHeight = Number(v.cover_height) || coverHeight;

        const rawList = v.pageInfoListAll?.zip_100;
        if (Array.isArray(rawList) && rawList.length > 0) {
          const validList = rawList.filter(Boolean);
          // 👉 CHỐT CHẶN: Chỉ nhận khi toàn bộ mảng đã có link thật (valid === total)
          if (validList.length === rawList.length && validList.length > 6) {
            pageUrls = validList;
            break;
          }
        }
      }

      if (capturedFullList && capturedFullList.length > 6) {
        pageUrls = capturedFullList;
        break;
      }

      await sleep(150);
    }

    // Fallback: nếu sau 9s web chỉ có ít trang thật sự (truyện ngắn < 6 trang)
    if (!pageUrls.length) {
      const v = WIN.viewer || WIN.viewer_ || WIN[DOC.viewerObjName];
      const rawList = v?.pageInfoListAll?.zip_100 || v?.pageInfoList;
      if (Array.isArray(rawList)) pageUrls = rawList.filter(Boolean);
    }

    if (!pageUrls.length) return;

    const Tools = WIN.CoicomiTools || window.CoicomiTools;
    const Utils = WIN.MangaUtils || window.MangaUtils;
    const createUI = window.createInspectorUI || globalThis.createInspectorUI;

    const options = {
      coverWidth: coverWidth || 1444,
      coverHeight: coverHeight || 2048,
      gutter: 4,
      tArray: tArray
    };

    createUI({
      title: "COICOMI INSPECTOR",
      totalPages: pageUrls.length,
      onPreview: async (pNo, onSuccess, onError) => {
        try {
          const imgUrl = pageUrls[pNo - 1];
          if (!imgUrl) return onError("Trang không tồn tại!");

          const rawBuf = await Utils.fetchBuffer(imgUrl, { "Referer": "https://viewer.coicomi.com/" });
          
          // Nhận diện định dạng nhị phân nguyên bản qua Magic Bytes
          const ext = Utils.detectExt(rawBuf);
          const mime = Utils.detectMimeType(rawBuf);

          const img = await Utils.loadImage(rawBuf, mime);
          const res = Tools.descrambleCoicomiCanvas(img, imgUrl, options);

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

            const rawBuf = await Utils.fetchBuffer(imgUrl, { "Referer": "https://viewer.coicomi.com/" });
            const ext = Utils.detectExt(rawBuf);
            const mime = Utils.detectMimeType(rawBuf);

            const img = await Utils.loadImage(rawBuf, mime);
            const res = Tools.descrambleCoicomiCanvas(img, imgUrl, options);

            // 1. Tải bản RAW xáo trộn gốc
            const a1 = DOC.createElement('a');
            a1.href = URL.createObjectURL(new Blob([rawBuf], { type: mime }));
            a1.download = `Coicomi_Trang_${pNo}_raw.${ext}`;
            a1.click();

            // 2. Tải bản ĐÃ GHÉP giải mã sắc đanh 100%
            const a2 = DOC.createElement('a');
            a2.href = URL.createObjectURL(await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality)));
            a2.download = `Coicomi_Trang_${pNo}_decoded.${fmt}`;
            a2.click();

            statusText.textContent = `✅ Đã tải xong 2 bản trang ${pNo}!`;
          } else {
            const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
            const zip = new ZipClass();

            for (let i = 0; i < pageArray.length; i++) {
              const pNo = pageArray[i];
              statusText.textContent = `Đang xử lý: ${i + 1}/${pageArray.length} (Trang ${pNo})...`;
              const imgUrl = pageUrls[pNo - 1];

              const rawBuf = await Utils.fetchBuffer(imgUrl, { "Referer": "https://viewer.coicomi.com/" });
              const ext = Utils.detectExt(rawBuf);
              const mime = Utils.detectMimeType(rawBuf);

              const img = await Utils.loadImage(rawBuf, mime);
              const res = Tools.descrambleCoicomiCanvas(img, imgUrl, options);

              const sharpBlob = await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality));
              zip.addFile(`1_raw/${pNo}.${ext}`, new Uint8Array(rawBuf));
              zip.addFile(`2_decoded/${pNo}.${fmt}`, new Uint8Array(await sharpBlob.arrayBuffer()));
            }

            statusText.textContent = `Đang đóng gói file ZIP...`;
            await sleep(60);
            zip.download(`Coicomi_Compare_${pageArray[0]}-${pageArray[pageArray.length - 1]}.zip`);
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
   * 3. THEO DÕI ĐỔI TRANG (SPA WATCHER)
   * ========================================================================= */
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      capturedFullList = null;
      boot();
    }
  }, 400);

  boot();
})();