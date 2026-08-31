// ==UserScript==
// @name         SpeedBinb Inspector
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      2.3.0
// @description  Inspector soi ma trận, rãnh đệm Gutter và tải đối chiếu 2 bản ảnh cho BookLive, Cmoa, Yanmaga, Gaugau.
// @author       anonymous & AI
// @match        https://booklive.jp/*
// @match        https://*.booklive.jp/*
// @match        https://www.cmoa.jp/bib/speedreader/*
// @match        https://yanmaga.jp/*
// @match        https://gaugau.futabanet.jp/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-start
//
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/decoders/SpeedBinbTools.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/InspectorUI.js
// ==/UserScript==

(function speedBinbInspector() {
  'use strict';
  const WIN = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const DOC = WIN.document;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  if (WIN.top !== WIN.self) return;

  async function resolveSpeedBinbManifest(Tools, Utils) {
    const url = location.href, origin = location.origin;

    // A. BOOKLIVE
    if (url.includes('booklive.jp')) {
      let cid = new URL(url).searchParams.get('cid') || DOC.getElementById('content')?.dataset?.ptbinbCid || DOC.getElementById('content')?.getAttribute('data-ptbinb-cid');
      if (!cid) { const m = location.pathname.match(/bviewer\/(?:s\/)?([0-9a-zA-Z_-]+)/); if (m && m[1] !== 's' && m[1] !== 'index') cid = m[1]; }
      if (!cid) return null;

      const k = Tools.generateRandomString32(cid);
      const infoBuf = await Utils.fetchBuffer(`https://booklive.jp/bib-api/bibGetCntntInfo?cid=${cid}&dmytime=${Date.now()}&k=${k}`);
      const info = JSON.parse(new TextDecoder().decode(infoBuf));
      const item = info.items?.[0]; if (!item?.ContentsServer) return null;

      const server = item.ContentsServer, isTrial = server.includes('trial') || !item.p, p = item.p || "";
      const ctbl = Tools.getDecryptedTable(cid, k, item.ctbl), ptbl = Tools.getDecryptedTable(cid, k, item.ptbl);
      let ttx = "";
      if (isTrial) {
        const jsBuf = await Utils.fetchBuffer(`${server}/content.js?dmytime=${Date.now()}`);
        const js = new TextDecoder().decode(jsBuf);
        ttx = JSON.parse(js.slice(js.indexOf('{'), js.lastIndexOf('}') + 1)).ttx || "";
      } else {
        const cntntBuf = await Utils.fetchBuffer(`${server}/sbcGetCntnt.php?cid=${cid}&p=${p}&vm=1&dmytime=${Date.now()}`);
        ttx = JSON.parse(new TextDecoder().decode(cntntBuf)).ttx || "";
      }
      const files = [], seen = new Set();
      for (const m of ttx.matchAll(/<(?:t-img|img)[^>]+src=["']?([^"'\s>]+)["']?[^>]*>/gi)) {
        if (m[1] && !seen.has(m[1])) {
          seen.add(m[1]);
          files.push({ filename: m[1], src: isTrial ? `${server}/${m[1]}/M_H.jpg` : `${server}/sbcGetImg.php?cid=${cid}&src=${encodeURIComponent(m[1])}&p=${p}&vm=1&q=1` });
        }
      }
      return { site: "BookLive", cid, ctbl, ptbl, files };
    }

    // B. COMIC CMOA
    if (url.includes('cmoa.jp')) {
      const params = new URL(url).searchParams;
      let cid = params.get('cid') || DOC.getElementById('content')?.getAttribute('data-ptbinb-cid');
      if (!cid) return null;

      const uParams = Array.from({ length: 10 }, (_, i) => params.get(`u${i}`) ? `&u${i}=${encodeURIComponent(params.get(`u${i}`))}` : '').join('');
      const k = Tools.generateRandomString32(cid);
      const infoBuf = await Utils.fetchBuffer(`https://www.cmoa.jp/bib/sws/bibGetCntntInfo.php?cid=${cid}&dmytime=${Date.now()}&k=${k}${uParams}`);
      const info = JSON.parse(new TextDecoder().decode(infoBuf));
      const item = info.items?.[0]; if (!item?.ContentsServer) return null;

      const server = item.ContentsServer;
      const ctbl = Tools.getDecryptedTable(cid, k, item.ctbl), ptbl = Tools.getDecryptedTable(cid, k, item.ptbl);
      const cntntBuf = await Utils.fetchBuffer(`${server}/sbcGetCntnt.php?cid=${cid}&p=${item.p}&dmytime=${Date.now()}${uParams}`);
      const cntnt = JSON.parse(new TextDecoder().decode(cntntBuf));
      const files = [], seen = new Set();
      for (const m of cntnt.ttx.matchAll(/<(?:t-img|img)[^>]+src=["']?([^"'\s>]+)["']?[^>]*>/gi)) {
        if (m[1] && !seen.has(m[1])) {
          seen.add(m[1]);
          files.push({ filename: m[1], src: `${server}/sbcGetImg.php?cid=${cid}&src=${encodeURIComponent(m[1])}&p=${item.p}&q=1` });
        }
      }
      return { site: "Comic Cmoa", cid, ctbl, ptbl, files };
    }

    // C. YANMAGA WEB
    if (url.includes('yanmaga.jp')) {
      const contentEl = DOC.getElementById('content') || DOC.querySelector('[data-ptbinb-cid]');
      let cid = new URLSearchParams(location.search).get("cid") || contentEl?.getAttribute('data-ptbinb-cid') || contentEl?.dataset?.ptbinbCid || location.pathname.match(/\/viewer\/comics\/[^\/]+\/([a-zA-Z0-9_-]+)/)?.[1];
      if (!cid) return null;

      const k = Tools.generateRandomString32(cid);
      const action = location.pathname.match(/\/viewer\/comics\/[^\/]+\/([a-zA-Z0-9_-]+)/)?.[1] || "";
      const actionParam = action ? `&random_identification=${action}` : '';
      const infoBuf = await Utils.fetchBuffer(`https://yanmaga.jp/viewer/bibGetCntntInfo?cid=${cid}&dmytime=${Date.now()}&k=${k}${actionParam}&type=comics`);
      const info = JSON.parse(new TextDecoder().decode(infoBuf));
      const item = info.items?.[0]; if (!item?.ContentsServer) return null;

      const server = item.ContentsServer;
      const ctbl = Tools.getDecryptedTable(cid, k, item.ctbl), ptbl = Tools.getDecryptedTable(cid, k, item.ptbl);
      let ttxJson = null;
      try {
        const ttxBuf = await Utils.fetchBuffer(`${server}/content`);
        ttxJson = JSON.parse(new TextDecoder().decode(ttxBuf));
      } catch(e) {
        const ttxBuf = await Utils.fetchBuffer(`${server.replace(/\/\d+$/, '')}/content`);
        ttxJson = JSON.parse(new TextDecoder().decode(ttxBuf));
      }
      const files = [], seen = new Set();
      for (const m of ttxJson.ttx.matchAll(/pages\/[a-zA-Z0-9_.-]+\.(?:jpg|jpeg|png|webp)/gi)) {
        if (m[0] && !seen.has(m[0])) { seen.add(m[0]); files.push({ filename: m[0], src: `${server}/img/${m[0]}?q=1` }); }
      }
      return { site: "Yanmaga Web", cid, ctbl, ptbl, files };
    }

    // D. GAUGAU FUTABANET (Hỗ trợ URL dạng work/.../episodes/... và chuẩn M_H.jpg)
    if (url.includes('futabanet.jp')) {
      let contentEl = DOC.getElementById('content');
      let cid = contentEl?.dataset?.ptbinbCid || contentEl?.getAttribute('data-ptbinb-cid');
      if (!cid) {
        const m = location.pathname.match(/episodes\/([a-zA-Z0-9_-]+)/);
        if (m) cid = m[1];
      }
      if (!cid) return null;

      const ptbinb = contentEl?.dataset?.ptbinb || "/api/bibGetCntntInfo";
      const delimiter = ptbinb.includes('?') ? '&' : '?';
      const k = Tools.generateRandomString32(cid);

      const infoBuf = await Utils.fetchBuffer(`${origin}${ptbinb}${delimiter}dmytime=${Date.now()}&cid=${cid}&k=${k}`);
      const info = JSON.parse(new TextDecoder().decode(infoBuf));
      const item = info.items?.[0]; if (!item?.ContentsServer) return null;

      const server = item.ContentsServer;
      const ctbl = Tools.getDecryptedTable(cid, k, item.ctbl), ptbl = Tools.getDecryptedTable(cid, k, item.ptbl);
      const rawBuf = await Utils.fetchBuffer(`${server}/content.js?dmytime=${Date.now()}`);
      const raw = new TextDecoder().decode(rawBuf);
      const ttxJson = JSON.parse(raw.replace(/^DataGet_Content\(/, '').replace(/\);?\s*$/, ''));
      const files = [], seen = new Set();
      for (const m of ttxJson.ttx.matchAll(/(pages\/[a-zA-Z0-9_]*.jpg)/gm)) {
        if (m[1] && !seen.has(m[1])) {
          seen.add(m[1]);
          // Chuẩn M_H.jpg của Gaugau Futabanet theo SpeedBinbDownloader.user.js
          files.push({ filename: m[1], src: `${server}/${m[1]}/M_H.jpg` });
        }
      }
      return { site: "Gaugau Futabanet", cid, ctbl, ptbl, files };
    }
    return null;
  }

  async function processSpeedBinbPage(fileObj, ctbl, ptbl, Tools, Utils) {
    const rawBuffer = await Utils.fetchBuffer(fileObj.src);
    const rawExt = Utils.detectExt(rawBuffer);
    const img = await Utils.loadImage(rawBuffer);

    const key = Tools.getDecryptionKey(fileObj.filename, ctbl, ptbl);
    const decoder = new Tools.CoordDecoder(key[0], key[1]);
    const coords = decoder.getCoords(img);

    let destW = 0, destH = 0;
    for (const { destX, destY, width, height } of coords) {
      if (destX + width > destW) destW = destX + width;
      if (destY + height > destH) destH = destY + height;
    }

    const sharpCanvas = DOC.createElement('canvas');
    sharpCanvas.width = destW; sharpCanvas.height = destH;
    const sharpCtx = sharpCanvas.getContext('2d', { alpha: false });
    sharpCtx.imageSmoothingEnabled = false; sharpCtx.fillStyle = '#ffffff'; sharpCtx.fillRect(0, 0, destW, destH);
    for (const { srcX, srcY, destX, destY, width, height } of coords) {
      sharpCtx.drawImage(img, srcX, srcY, width, height, destX, destY, width, height);
    }

    const visualCanvas = DOC.createElement('canvas');
    visualCanvas.width = img.naturalWidth; visualCanvas.height = img.naturalHeight;
    const visualCtx = visualCanvas.getContext('2d', { alpha: false });
    visualCtx.imageSmoothingEnabled = false; visualCtx.fillStyle = '#ff007f'; visualCtx.fillRect(0, 0, visualCanvas.width, visualCanvas.height);
    for (const { srcX, srcY, destX, destY, width, height } of coords) {
      visualCtx.drawImage(img, srcX, srcY, width, height, destX, destY, width, height);
    }
    visualCtx.strokeStyle = '#00ffff'; visualCtx.lineWidth = 4; visualCtx.strokeRect(0, 0, destW, destH);

    const padW = img.naturalWidth - destW;
    const padH = img.naturalHeight - destH;
    const dummyText = (padW > 0 || padH > 0)
      ? `Vùng đệm bỏ: Dư ${padW}px phải, ${padH}px đáy (Đã gọt sạch)`
      : `Khớp 100% không có viền thừa`;

    return {
      rawBuffer, sharpCanvas, visualCanvas,
      destW, destH, rawW: img.naturalWidth, rawH: img.naturalHeight, img,
      gridW: destW, gridH: destH,
      dummyText: dummyText,
      rawExt: rawExt
    };
  }

  async function boot() {
    while (!DOC.body) await sleep(50);
    const Tools = WIN.SpeedBinbTools || window.SpeedBinbTools;
    const Utils = WIN.MangaUtils || window.MangaUtils;
    if (!Tools || !Utils) return;

    let manifest = null;
    // Chờ DOM gắn thẻ #content trên Gaugau và BookLive
    for (let i = 0; i < 50; i++) {
      try { manifest = await resolveSpeedBinbManifest(Tools, Utils); if (manifest?.files?.length) break; } catch(e){}
      await sleep(150);
    }
    if (!manifest?.files?.length) return;

    const createUI = window.createInspectorUI || globalThis.createInspectorUI;
    createUI({
      title: `SPEEDBINB (${manifest.site.toUpperCase()})`,
      totalPages: manifest.files.length,
      onPreview: async (pNo, onSuccess, onError) => {
        const fileObj = manifest.files[pNo - 1];
        if (!fileObj) return onError("Trang không tồn tại!");
        try {
          const res = await processSpeedBinbPage(fileObj, manifest.ctbl, manifest.ptbl, Tools, Utils);
          onSuccess(res, pNo);
        } catch (e) { onError(e.message); }
      },
      onDownload: async (pageArray, fmt, quality, statusText, btn) => {
        btn.disabled = true;
        try {
          if (pageArray.length === 1) {
            const pNo = pageArray[0];
            const fileObj = manifest.files[pNo - 1];
            const res = await processSpeedBinbPage(fileObj, manifest.ctbl, manifest.ptbl, Tools, Utils);
            const mimeType = fmt === 'png' ? 'image/png' : (fmt === 'webp' ? 'image/webp' : 'image/jpeg');

            const a1 = DOC.createElement('a'); a1.href = URL.createObjectURL(new Blob([res.rawBuffer], { type: 'image/jpeg' })); a1.download = `SpeedBinb_Trang_${pNo}_raw.jpg`; a1.click();
            const a2 = DOC.createElement('a'); a2.href = URL.createObjectURL(await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality))); a2.download = `SpeedBinb_Trang_${pNo}_decoded.${fmt}`; a2.click();
            statusText.textContent = `✅ Đã tải xong 2 bản trang ${pNo}!`;
          } else {
            const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
            const zip = new ZipClass();
            for (let i = 0; i < pageArray.length; i++) {
              const pNo = pageArray[i];
              statusText.textContent = `Đang giải mã: ${i + 1}/${pageArray.length} (Trang ${pNo})...`;
              const fileObj = manifest.files[pNo - 1];
              const res = await processSpeedBinbPage(fileObj, manifest.ctbl, manifest.ptbl, Tools, Utils);
              const mimeType = fmt === 'png' ? 'image/png' : (fmt === 'webp' ? 'image/webp' : 'image/jpeg');

              const sharpBlob = await new Promise(r => res.sharpCanvas.toBlob(r, mimeType, quality));
              zip.addFile(`1_raw/${pNo}.jpg`, new Uint8Array(res.rawBuffer));
              zip.addFile(`2_decoded/${pNo}.${fmt}`, new Uint8Array(await sharpBlob.arrayBuffer()));
            }
            statusText.textContent = `Đang đóng gói file ZIP...`;
            await sleep(60);
            zip.download(`SpeedBinb_Compare_${manifest.site}_${pageArray[0]}-${pageArray[pageArray.length - 1]}.zip`);
            statusText.textContent = `✅ Đã xuất xong file ZIP đối chiếu!`;
          }
        } catch (e) { statusText.textContent = `❌ ${e.message}`; } finally { btn.disabled = false; }
      }
    });
  }

  let lastUrl = location.href;
  setInterval(() => { if (location.href !== lastUrl) { lastUrl = location.href; boot(); } }, 500);
  boot();
})();