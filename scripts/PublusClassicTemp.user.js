// ==UserScript==
// @name         Publus Classic Temp Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @description  Bản DEV tạm thời kiểm tra 4 nền tảng Publus Classic (Comic Nettai, Pash Up, Comic Boost, Docomo Anime Store).
// @author       anonymous & AI
// @match        https://www.comicnettai.com/*/viewer.html*
// @match        https://comicnettai.com/*/viewer.html*
// @match        https://pash-up.jp/*/viewer.html*
// @match        https://comic-boost.com/viewer/viewer.html*
// @match        https://animestore.docomo.ne.jp/animestore/comic_viewer/viewer.html*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
//
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/decoders/PublusTools.js
// ==/UserScript==

(function publusClassicTempDownloader() {
  'use strict';

  const CONFIG = {
    MAX_CONCURRENT: 6,
    JPEG_QUALITY: 0.95
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(r => WIN.setTimeout(r, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("publus-classic-dl:convert-jpeg") === '1',
    chapterData: null,
    ui: null
  };

  /* =========================================================================
   * BẢNG THEME 4 TRANG
   * ========================================================================= */
  function getSiteTheme() {
    const h = WIN.location.hostname;
    if (h.includes('comicnettai.com')) return { name: "Comic Nettai", color: "#e11d48", top: "50px" };
    if (h.includes('pash-up.jp'))      return { name: "Pash Up!",     color: "#f59e0b", top: "50px" };
    if (h.includes('comic-boost.com')) return { name: "Comic Boost",  color: "#3b82f6", top: "50px" };
    if (h.includes('docomo.ne.jp'))    return { name: "d Anime Store", color: "#ea580c", top: "50px" };
    return { name: "Publus Classic", color: "#6366f1", top: "50px" };
  }

  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const theme = getSiteTheme();
      state.ui = createUI({
        storagePrefix: "publus-classic-dl",
        title: theme.name,
        engine: "PUBLUS",
        themeColor: theme.color,
        themeBg: "#18181b",
        titleColor: "#ffffff",
        topOffset: theme.top,
        defaultJpgText: "Xuất file JPG (mặc định PNG)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("publus-classic-dl:convert-jpeg", checked ? '1' : '0');
        }
      });
    }
    return state.ui;
  }

  function cleanString(str) {
    if (!str) return "";
    return str.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').replace(/[\\/*?:"<>|]/g, '').trim();
  }

  function getCleanTitle(manifestTitle) {
    let title = manifestTitle || "";
    if (!title) {
      const el = DOC.querySelector('#pagetitle .titleText, #pagetitle, header h1, h1');
      if (el) title = el.getAttribute('title') || el.textContent;
    }
    if (!title && DOC.title) title = DOC.title.split(/[|｜]/)[0];
    return cleanString(title) || `PublusClassic_${Date.now()}`;
  }

  /* =========================================================================
   * BỘ BÓC TÁCH AUTH CHO 4 TRANG
   * ========================================================================= */
  async function fetchSiteAuth() {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    const h = WIN.location.hostname;
    const search = WIN.location.search;

    // 1. PASH UP!
    if (h.includes('pash-up.jp')) {
      const authUrl = `https://pash-up.jp/pageapi/viewer/c.php${search}`;
      const buf = await Utils.fetchBuffer(authUrl);
      const data = JSON.parse(new TextDecoder().decode(buf));
      let base = data.url.replace(/\/?$/, '/');
      if (!base.includes('normal_default')) base += 'normal_default/';
      return { baseUrl: base, authInfo: data.auth_info || "", title: data.cti || "" };
    }

    // 2. COMIC NETTAI
    if (h.includes('comicnettai.com')) {
      const authUrl = `https://www.comicnettai.com/api/viewer/c${search}`;
      const buf = await Utils.fetchBuffer(authUrl);
      const data = JSON.parse(new TextDecoder().decode(buf));
      let base = data.url.replace(/\/?$/, '/');
      return { baseUrl: base, authInfo: data.auth_info || "", title: data.cti || "" };
    }

    // 3. COMIC BOOST
    if (h.includes('comic-boost.com')) {
      const cid = new URL(WIN.location.href).searchParams.get('cid');
      const authUrl = `https://comic-boost.com/pageapi/viewer/c.php?cid=${encodeURIComponent(cid)}`;
      const buf = await Utils.fetchBuffer(authUrl);
      const data = JSON.parse(new TextDecoder().decode(buf));
      let base = data.url.replace(/\/?$/, '/');
      return { baseUrl: base, authInfo: data.auth_info || "", title: data.cti || "" };
    }

    // 4. DOCOMO ANIME STORE
    if (h.includes('docomo.ne.jp')) {
      const cid = new URLSearchParams(search).get('cid');
      const authUrl = `https://api.book.animestore.docomo.ne.jp/api/publus/approval?cid=${cid}`;
      const buf = await Utils.fetchBuffer(authUrl);
      const data = JSON.parse(new TextDecoder().decode(buf));
      let base = data.url.replace(/\/?$/, '/');
      return { baseUrl: base, authInfo: data.auth_info || {}, title: data.cti || "", isDocomo: true };
    }

    throw new Error("Không nhận diện được trang Publus Classic.");
  }

  /* =========================================================================
   * BÓC TÁCH CONFIGURATION PACK & TRANG TRUYỆN
   * ========================================================================= */
  async function fetchClassicPages() {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    const Tools = window.PublusTools || globalThis.PublusTools;

    console.log("[Publus Classic Temp] 🔍 Bắt đầu lấy Auth...");
    const auth = await fetchSiteAuth();
    console.log("[Publus Classic Temp] ✅ Auth thành công:", auth);

    const authQuery = typeof auth.authInfo === 'string' ? auth.authInfo : new URLSearchParams(auth.authInfo).toString();
    const configPackUrl = `${auth.baseUrl}configuration_pack.json?${authQuery}`;

    console.log("[Publus Classic Temp] 📦 Đang kéo configuration_pack.json:", configPackUrl);
    const configBuf = await Utils.fetchBuffer(configPackUrl);
    const configJson = JSON.parse(new TextDecoder().decode(configBuf));

    let config = null, key1 = null, key2 = null, key3 = null;

    // A. NHÁNH MÃ HÓA 9 TẦNG (Comic Nettai, Pash Up, Comic Boost)
    if (configJson.data && typeof configJson.data === 'string') {
      console.log("[Publus Classic Temp] 🔓 Phát hiện gói tin 9 tầng. Đang giải mã...");
      const decrypted = Tools.decryptConfigurationPack(configJson.data);
      config = decrypted.config;
      key1 = decrypted.key1;
      key2 = decrypted.key2;
      key3 = decrypted.key3;
    } 
    // B. NHÁNH DOCOMO (Nhúng sẵn ct, st, et)
    else if (configJson.ct && configJson.st && configJson.et) {
      console.log("[Publus Classic Temp] 🔓 Phát hiện khóa ct, st, et của Docomo...");
      config = configJson;
      const unhex = (hex) => {
        const arr = [];
        for (let i = 0; i < hex.length; i += 2) arr.push(parseInt(hex.substr(i, 2), 16));
        return arr;
      };
      key1 = unhex(configJson.ct);
      key2 = unhex(configJson.st);
      key3 = unhex(configJson.et);
    } else {
      config = configJson;
    }

    const rawContents = config.configuration?.contents || [];
    const fileNameVersion = config.configuration?.['file-name-version'];
    const pages = [];
    let pageIndex = 0;

    for (let i = 0; i < rawContents.length; i++) {
      const item = rawContents[i];
      const fileInfo = config[item.file];
      if (!fileInfo || fileInfo.Linear === 0) continue;

      const pageList = fileInfo.FileLinkInfo?.PageLinkInfoList || [];
      const pageCount = fileInfo.FileLinkInfo?.PageCount || pageList.length;

      for (let pIdx = 0; pIdx < pageCount; pIdx++) {
        const pageObj = pageList[pIdx]?.Page;
        if (!pageObj) continue;

        pageObj.imgName = item.file;
        if (key1 && key2 && key3) {
          Tools.calcU2F(pageObj, key1, key2, key3);
        }

        const pNo = (pageObj.No !== undefined && pageObj.No !== null) ? String(pageObj.No) : "0";
        const imgHash = (key1 && key2 && key3 && fileNameVersion === "1.0")
          ? Tools.getImgURLHash(pNo, item.file, key1, key2, key3, fileNameVersion)
          : pNo;

        const subPath = `${item.file}/${imgHash}.jpeg`;
        const targetW = Number(pageObj.Size?.Width || 1440);
        const targetH = Number(pageObj.Size?.Height || 2048);

        pages.push({
          pageNo: pageIndex + 1,
          url: `${auth.baseUrl}${subPath}?${authQuery}`,
          width: targetW,
          height: targetH,
          pageInfo: pageObj,
          isScrambled: Boolean(pageObj.BlockWidth)
        });

        pageIndex++;
      }
    }

    console.log(`[Publus Classic Temp] 📚 Đã bóc tách thành công ${pages.length} trang.`);
    return {
      title: auth.title || config.configuration?.title || "",
      pages
    };
  }

  /* =========================================================================
   * RENDER CANVAS & TIẾN TRÌNH TẢI
   * ========================================================================= */
  async function renderPublusCanvas(img, coords, targetW, targetH, isJpg, pageNo) {
    const canvas = DOC.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = false;

    if (!coords || coords.length === 0) {
      ctx.drawImage(img, 0, 0, targetW, targetH, 0, 0, targetW, targetH);
    } else {
      for (let i = 0; i < coords.length; i++) {
        const b = coords[i];
        ctx.drawImage(img, b.destX, b.destY, b.width, b.height, b.srcX, b.srcY, b.width, b.height);
      }
    }

    const mimeType = isJpg ? 'image/jpeg' : 'image/png';
    const outExt = isJpg ? 'jpg' : 'png';
    const blob = await new Promise(r => canvas.toBlob(r, mimeType, CONFIG.JPEG_QUALITY));
    return {
      fileName: `${pageNo}.${outExt}`,
      data: new Uint8Array(await blob.arrayBuffer())
    };
  }

  async function startDownload() {
    if (state.running) return;
    const ui = getUI();
    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });
      let data = state.chapterData;
      if (!data) {
        data = await fetchClassicPages();
        state.chapterData = data;
      }

      const { pages, title } = data;
      const totalPages = pages.length;
      if (!totalPages) throw new Error("Không có trang hợp lệ.");

      const useJpeg = Boolean(state.convertJpeg);
      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const Tools = window.PublusTools || globalThis.PublusTools;
      const zip = new ZipClass();

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map((pageObj) => async () => {
        const rawBuffer = await Utils.fetchBuffer(pageObj.url);
        const img = await Utils.loadImage(rawBuffer, 'image/jpeg');
        const coords = pageObj.isScrambled ? Tools.getBlocks(pageObj.pageInfo, img.width, img.height) : null;
        return await renderPublusCanvas(img, coords, pageObj.width, pageObj.height, useJpeg, pageObj.pageNo);
      });

      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res?.data) zip.addFile(res.fileName, res.data);
      }

      zip.download(`${getCleanTitle(title)}.zip`);
      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[Publus Classic Temp] Lỗi:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  async function boot() {
    while (!DOC.body) await sleep(30);
    const ui = getUI();
    if (ui?.panel) ui.panel.style.display = "block";
    if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });

    try {
      const data = await fetchClassicPages();
      if (data && data.pages?.length > 0) {
        state.chapterData = data;
        if (ui) ui.updateProgress({ completed: 0, total: data.pages.length, status: "Sẵn sàng." });
      }
    } catch (e) {
      console.error("[Publus Classic Temp] Boot error:", e);
      if (ui) ui.updateProgress({ status: "Sẵn sàng." });
    }
  }

  if (DOC.readyState === "loading") {
    DOC.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();