// ==UserScript==
// @name         Sharp EBLIEVA Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://comic.jp/favicon.ico
// @description  Tải manga trên hệ thống Sharp EBLIEVA (comic.jp, music-book.jp, galapagosstore.com).
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
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/decoders/SharpEblievaTools.js
// ==/UserScript==

(function sharpEblievaDownloader() {
  'use strict';

  const CONFIG = {
    MAX_CONCURRENT: 6,
    JPEG_QUALITY: 1.0 // Chất lượng xuất JPG nếu người dùng chọn
  };

  const WIN = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const DOC = WIN.document;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("eblieva-dl:convert-jpeg") === '1',
    chapterData: null,
    ui: null,
    lastUrl: ""
  };

  function isEpisodeUrl() {
    const p = WIN.location.pathname;
    return p.includes('/comic/bv/') || p.includes('/resource/browser/');
  }

  function getBrandTheme() {
    const h = WIN.location.hostname;
    if (h.includes('galapagos')) {
      return {
        title: "COCORO BOOKS",
        engine: "SHARP EBLIEVA",
        themeColor: "#C0007B",
        themeBg: "#ffffff",
        titleColor: "#C0007B",
        btnColor: "#ffffff",
        btnBg: "#C0007B",
        tabBg: "#C0007B",
        tabColor: "#ffffff",
        topOffset: "50px"
      };
    }
    if (h.includes('music-book')) {
      return {
        title: "music.jp",
        engine: "SHARP EBLIEVA",
        themeColor: "#C7302A",
        themeBg: "#ffffff",
        titleColor: "#C7302A",
        btnColor: "#ffffff",
        btnBg: "#C7302A",
        tabBg: "#C7302A",
        tabColor: "#ffffff",
        topOffset: "50px"
      };
    }
    if (h.includes('comic')) {
      return {
      title: "コミック.jp",
      engine: "SHARP EBLIEVA",
      themeColor: "#FED703",
      themeBg: "#ffffff",
      titleColor: "#000000",
      btnColor: "#000000",
      btnBg: "#FED703",
      tabBg: "#FED703",
      tabColor: "#000000",
      topOffset: "50px"
      };
    }
  }

  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const b = getBrandTheme();
      const uiConfig = {
        storagePrefix: "eblieva-dl",
        title: b.title,
        engine: b.engine,
        themeColor: b.themeColor,
        themeBg: b.themeBg,
        titleColor: b.titleColor,
        btnBg: b.btnBg,
        btnColor: b.btnColor,
        tabBg: b.tabBg,
        tabColor: b.tabColor,
        topOffset: b.topOffset,
        defaultJpgText: "Xuất file JPG (mặc định PNG)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("eblieva-dl:convert-jpeg", checked ? '1' : '0');
        }
      };

      state.ui = createUI(uiConfig);
      state.ui.setBusy(true);

      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:${b.titleColor};letter-spacing:0.3px;text-align:left;">${b.title}</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px;visibility:hidden;">${b.engine}</div>
          `;
        }
      }
    }
    return state.ui;
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

  function getKeyItem(master, pNo) {
    if (WIN.location.hostname.includes('galapagos')) {
      const keys = master.d?.Ay?.Dy || [];
      return keys.find(k => pNo <= k.oy) || keys[keys.length - 1];
    }
    const branch = master.d?.By || master.d?.ky || Object.values(master.d || {})[0];
    const list = branch?.by || branch?.Dy || [];
    return list.find(k => pNo <= (k.ny?.Iy || k.ny || k.oy || 0)) || list[list.length - 1];
  }

  function extractParamList(master) {
    if (WIN.location.hostname.includes('galapagos')) {
      const keys = master.d?.Ay?.Dy || [];
      return keys.map(item => ({ coords: item.sy || "", lastPage: item.oy || 0 }));
    }
    const branch = master.d?.By || master.d?.ky || Object.values(master.d || {})[0];
    const list = branch?.by || branch?.Dy || [];
    return list.map(item => ({
      coords: item.ey || item.sy || "",
      lastPage: Number(item.ny?.Iy || item.ny || item.oy || 0)
    }));
  }

  function formatCleanTitle(rawTitle) {
    if (!rawTitle) return "Manga";
    let t = rawTitle
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/【(?!(?:フルカラー版|カラー版|完全版|特装版))[^】]*】/gi, ' ')
      .replace(/[［\[【](?:ばら売り|分冊版|単話版)[］\]】]/gi, ' ')
      .replace(/[\\/*?:"<>|]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    // 1. Nếu có ngoặc đơn ở đuôi như (1), （1） -> GIỮ NGUYÊN 100%
    if (/[（\(][0-9０-９]+[）\)]\s*$/i.test(t)) return t;
    if (/\s+[-－–—]\s+/.test(t)) return t;

    // 2. Tách nếu là số tập/chương trần ở đuôi (như " 1", " 2", " 第13巻", " 第1話")
    const m = t.match(/^(.*?)(?:\s+)((?:(?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\.]+\s*(?:話|回|巻|章|節|部|エピソード|分冊版|単話)?)|(?:TRIGGER|CHAPTER|EPISODE|ACT|ROUND|VOL)[\.\s]*\d+.*)$/i);
    if (m && m[1].trim() && m[2].trim()) {
      return `${m[1].trim()} - ${m[2].trim()}`;
    }
    return t;
  }

  // Dual-Flight Fetch kèm tự động thử lại
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

  function safeDownloadZip(zip, fileName) {
    const blob = zip.generateBlob();
    const url = URL.createObjectURL(blob);
    const a = DOC.createElement('a');
    a.href = url;
    a.download = fileName;
    a.style.display = 'none';

    a.addEventListener('click', e => {
      e.stopPropagation();
      e.stopImmediatePropagation();
    }, true);

    DOC.body.appendChild(a);
    a.dispatchEvent(new MouseEvent('click', { bubbles: false, cancelable: true }));
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /* =========================================================================
   * TIẾN TRÌNH TẢI CHÍNH (6 luồng trong RAM)
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();
    if (!state.chapterData) return;

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      const { master, layoutUrl, totalPages, title, cid, isCleanTrial } = state.chapterData;
      const isGalapagos = WIN.location.hostname.includes('galapagos');
      const useJpeg = Boolean(state.convertJpeg || isCleanTrial);

      const Tools = WIN.SharpEblievaTools || window.SharpEblievaTools;
      const Utils = WIN.MangaUtils || window.MangaUtils;
      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const zip = new ZipClass();

      zip.addFile(`${cid}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = Array.from({ length: totalPages }, (_, idx) => async () => {
        const pNo = idx + 1;
        const fileStem = String(pNo).padStart(5, '0');
        const keyItem = getKeyItem(master, pNo);
        let sharpCanvas;

        if (isGalapagos) {
          const jsonpUrl = `${layoutUrl}/${fileStem}.jsonp?store_code=sharpbvs&pid=sh`;
          const rawBuf = await fetchBufferDualFlight(jsonpUrl, Utils);
          if (!rawBuf) throw new Error(`Lỗi tải trang ${pNo}`);

          const text = new TextDecoder().decode(rawBuf);
          const pageData = Tools.decryptGalapagosJsonp(text, keyItem);
          const res = await Tools.stitchGalapagosCanvas(pageData, Utils);
          sharpCanvas = res.sharpCanvas;
        } else {
          const imgUrl = `${layoutUrl}/${fileStem}.jpg`;
          const b1Url  = `${layoutUrl}/${fileStem}_b1.png`;
          const b2Url  = `${layoutUrl}/${fileStem}_b2.png`;

          const [rawBuf, b1Buf, b2Buf] = await Promise.all([
            fetchBufferDualFlight(imgUrl, Utils),
            fetchBufferDualFlight(b1Url, Utils),
            fetchBufferDualFlight(b2Url, Utils)
          ]);
          if (!rawBuf) throw new Error(`Lỗi tải trang ${pNo}`);

          const mime = Utils.detectMimeType(rawBuf);
          const mainImg = await Utils.loadImage(rawBuf, mime);
          const b1Img   = b1Buf ? await Utils.loadImage(b1Buf, 'image/png') : null;
          const b2Img   = b2Buf ? await Utils.loadImage(b2Buf, 'image/png') : null;

          const coordStr = keyItem?.ey || keyItem?.sy || "";
          const res = Tools.descrambleVariantA(mainImg, coordStr, b1Img, b2Img);
          sharpCanvas = res.sharpCanvas;
        }

        const ext = useJpeg ? 'jpg' : 'png';
        const mime = useJpeg ? 'image/jpeg' : 'image/png';
        const quality = useJpeg ? CONFIG.JPEG_QUALITY : undefined;

        const blob = await new Promise(r => sharpCanvas.toBlob(r, mime, quality));
        const buf = await blob.arrayBuffer();
        return { fileName: `${pNo}.${ext}`, data: new Uint8Array(buf) };
      });

      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res?.data) zip.addFile(res.fileName, res.data);
      }

      safeDownloadZip(zip, `${title}.zip`);

      if (ui) {
        ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
        ui.setBusy(false);
      }
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[eblieva-dl] Download error:", err);
    } finally {
      state.running = false;
    }
  }

  async function boot() {
    while (!DOC.body) await sleep(20);
    const ui = getUI();

    if (!isEpisodeUrl()) {
      if (ui?.panel) ui.panel.style.display = "none";
      return;
    }

    if (ui?.panel) {
      ui.panel.style.display = "block";
      ui.setBusy(true);
      ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
    }

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

    if (!master || !master.layout_url || totalPages <= 0) {
      if (ui) {
        ui.updateProgress({ completed: 0, total: 0, status: "Lỗi: Không tìm thấy dữ liệu sách." });
        ui.setBusy('error');
      }
      return;
    }

    // CHẶN VÀ LOG LỖI LIGHT NOVEL
    if (Number(master.char_size) > 0) {
      if (ui) {
        ui.updateProgress({ completed: 0, total: 0, status: "Lỗi: Đây là Light Novel." });
        ui.setBusy('error');
      }
      return;
    }

    let layoutUrl = master.layout_url.trim();
    if (layoutUrl.startsWith('//')) layoutUrl = 'https:' + layoutUrl;

    const rawTitle = bv.bookInfo?.contents_info?.title || DOC.title || "Manga";
    const cleanTitle = formatCleanTitle(rawTitle);
    const cid = bv.bookInfo?.contents_info?.contents_id || "book";

    const isGalapagos = WIN.location.hostname.includes('galapagos');
    const isCleanTrial = isGalapagos && WIN.location.hash.includes('sample=true');

    state.chapterData = {
      master,
      layoutUrl,
      totalPages,
      title: cleanTitle,
      cid,
      isCleanTrial
    };

    if (ui) {
      await sleep(80);
      ui.setBusy(false);

      if (isCleanTrial) {
        ui.updateProgress({
          completed: 0,
          total: totalPages,
          status: "Sẵn sàng.",
          format: "JPG"
        });
      } else {
        ui.updateProgress({
          completed: 0,
          total: totalPages,
          status: "Sẵn sàng."
        });
      }
    }
  }

  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute((newUrl) => {
      if (!isEpisodeUrl()) {
        const ui = getUI();
        if (ui?.panel) ui.panel.style.display = "none";
        state.chapterData = null;
        state.lastUrl = "";
        state.running = false;
        return;
      }
      if (state.lastUrl && state.lastUrl === newUrl) return;

      state.lastUrl = newUrl;
      state.chapterData = null;
      state.running = false;

      const ui = getUI();
      if (ui) {
        ui.setBusy(true);
        ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
      }
      boot();
    });
  }

  boot();
})();