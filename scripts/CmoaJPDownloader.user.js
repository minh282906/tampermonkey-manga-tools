// ==UserScript==
// @name         CmoaJP Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      2.0.0
// @icon         https://c-cmoa.akamaized.net/sol/pcc/images/webclipicon/icon_cmoa.png
// @description  Tải manga trên Comic Cmoa.
// @author       anonymous & AI
// @match        https://www.cmoa.jp/bib/speedreader/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      cmoa.jp
// @connect      *.cmoa.jp
// @connect      *.akamaized.net
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/decoders/SpeedBinbTools.js
// ==/UserScript==

(function cmoaUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH & KHỞI TẠO
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6,   // 6 luồng tải song song qua API
    JPEG_QUALITY: 0.95   // Chất lượng xuất JPG nếu chọn
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("cmoa-dl:convert-jpeg") === '1',
    chapterData: null,
    ui: null
  };

  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;
    if (typeof createUI === "function" && DOC.body) {
      state.ui = createUI({
        storagePrefix: "cmoa-dl",
        title: "Cmoa Downloader",
        themeColor: "#ea580c",
        themeBg: "#1c1917",
        titleColor: "#fdba74",
        topOffset: "43px",
        defaultJpgText: "Xuất file JPG (mặc định PNG)",
        onDownload: startDownload,
        onJpgChange: (checked) => { state.convertJpeg = checked; }
      });
    }
    return state.ui;
  }

  /* =========================================================================
   * HELPER FUNCTIONS & XỬ LÝ TIÊU ĐỀ CHUẨN
   * ========================================================================= */
  function isEpisodeUrl() {
    return /\/bib\/speedreader\//.test(WIN.location.pathname) ||
           Boolean(new URL(WIN.location.href).searchParams.get('cid')) ||
           Boolean(DOC.getElementById('content')?.getAttribute('data-ptbinb-cid'));
  }

  function cleanString(str) {
    if (!str) return "";
    return str
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/【[^】]*】/g, '')
      .replace(/[\\/*?:"<>|]/g, '')
      .trim();
  }

  function getCid() {
    const params = new URL(WIN.location.href).searchParams;
    const cidParam = params.get('cid');
    if (cidParam) return cidParam.trim();

    const contentEl = DOC.getElementById('content');
    const cidAttr = contentEl?.getAttribute('data-ptbinb-cid');
    if (cidAttr) return cidAttr.trim();

    return "Cmoa_Episode";
  }

  function getUParams() {
    const params = new URL(WIN.location.href).searchParams;
    return Array.from({ length: 10 }, (_, i) => {
      const val = params.get(`u${i}`);
      return val ? `&u${i}=${encodeURIComponent(val)}` : '';
    }).join('');
  }

  // BẮT BUỘC CHUẨN: [Tên Truyện] - [Tên Tập/Chap].zip
  function getCleanTitle(manifestTitle, manifestSubTitle) {
    try {
      let raw = manifestTitle || DOC.title || "";

      // 1. Logic cũ của bạn: Cắt lấy vế đầu tiên trước dấu ｜ hoặc |
      raw = raw.split(/[|｜]/)[0].trim();

      // 2. Xóa sạch các tiền tố rác của Cmoa
      raw = raw.replace(/^(?:無料・試し読みページ|無料・試し読み|無料版|試し読み|公式)\s*/i, '').trim();
      raw = raw.replace(/【[^】]*】/g, '').trim();

      // 3. Xóa nhãn NXB ở cuối (ví dụ: （GAコミック）, (コロナ・コミックス)...)
      raw = raw.replace(/（[^）]*(?:コミック|文庫|レーベル|出版|COMIC)[^）]*）$/i, '').trim();
      raw = raw.replace(/\([^)]*(?:コミック|文庫|レーベル|出版|COMIC)[^)]*\)$/i, '').trim();

      let seriesTitle = cleanString(raw);

      // 4. Bóc tách tên chap từ manifestSubTitle (ví dụ: "イマリさんは旅上戸（コミック）　１話" -> "１話")
      let episodeTitle = "";
      if (manifestSubTitle) {
        let sub = cleanString(manifestSubTitle);
        sub = sub.replace(/【[^】]*】/g, '').trim();
        
        // Nếu SubTitle có chứa cả tên truyện, chỉ lấy phần số tập / số chap ở đuôi
        const epMatch = sub.match(/(第?\s*\d+\s*(?:話|巻|章|節|部|エピソード|分冊版|単話)?.*)$/i);
        if (epMatch) {
          episodeTitle = cleanString(epMatch[1]);
        } else {
          episodeTitle = sub;
        }
      }

      if (!episodeTitle) {
        episodeTitle = getCid();
      }

      // Ghép theo đúng chuẩn: [Tên Truyện] - [Tên Tập/Chap]
      if (seriesTitle && episodeTitle && !seriesTitle.includes(episodeTitle)) {
        return `${seriesTitle} - ${episodeTitle}`;
      } else if (seriesTitle) {
        return `${seriesTitle} - ${getCid()}`;
      }
    } catch (e) {}

    return `Cmoa_${getCid()}`;
  }

  /* =========================================================================
   * CMOA SPEEDBINB API CLIENT & GIẢI MÃ MA TRẬN
   * ========================================================================= */
  async function fetchCmoaManifest(cid) {
    const Tools = window.SpeedBinbTools || globalThis.SpeedBinbTools;
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    if (!Tools || !Utils) throw new Error("Chưa nạp xong SpeedBinbTools/MangaUtils.");

    const randomString = Tools.generateRandomString32(cid);
    const uParams = getUParams();
    const infoUrl = `https://www.cmoa.jp/bib/sws/bibGetCntntInfo.php?cid=${cid}&dmytime=${Date.now()}&k=${randomString}${uParams}`;

    let manifestData = null;
    let attempts = 0;

    while (attempts < 5) {
      const infoBuffer = await Utils.fetchBuffer(infoUrl);
      const infoJson = JSON.parse(new TextDecoder().decode(infoBuffer));
      const data = infoJson.items?.[0];
      if (data && data.p && data.ContentsServer) {
        manifestData = data;
        break;
      }
      await sleep(200);
      attempts++;
    }

    if (!manifestData) throw new Error("Không lấy được phiên đọc từ máy chủ Cmoa.");

    const config = {
      title: manifestData.Title || "",
      subTitle: manifestData.SubTitle || "",
      contentServer: manifestData.ContentsServer,
      p: manifestData.p,
      ctbl: Tools.getDecryptedTable(cid, randomString, manifestData.ctbl),
      ptbl: Tools.getDecryptedTable(cid, randomString, manifestData.ptbl)
    };

    // Tải cấu hình trang TTX
    const contentUrl = `${config.contentServer}/sbcGetCntnt.php?cid=${cid}&p=${config.p}&dmytime=${Date.now()}${uParams}`;
    const contentBuffer = await Utils.fetchBuffer(contentUrl);
    const contentJson = JSON.parse(new TextDecoder().decode(contentBuffer));
    const ttx = contentJson.ttx || "";

    const seen = new Set();
    const files = [];

    for (const match of ttx.matchAll(/(?<filename>(?:pages|images)\/[a-zA-Z0-9_]*\.jpg)[^A-Z]*orgwidth="(?<width>\d*)" orgheight="(?<height>\d*)"/gm)) {
      const filename = match.groups.filename;
      if (!seen.has(filename)) {
        seen.add(filename);
        files.push({
          pageNo: files.length + 1,
          filename: filename,
          width: parseInt(match.groups.width, 10),
          height: parseInt(match.groups.height, 10),
          src: `${config.contentServer}/sbcGetImg.php?cid=${cid}&src=${filename}&p=${config.p}&q=1`
        });
      }
    }

    return { config, files };
  }

  async function descrambleCmoaImage(fileObj, config, isJpg) {
    const Tools = window.SpeedBinbTools || globalThis.SpeedBinbTools;
    const Utils = window.MangaUtils || globalThis.MangaUtils;

    const rawBuffer = await Utils.fetchBuffer(fileObj.src);
    const img = await Utils.loadImage(rawBuffer);

    const canvas = DOC.createElement('canvas');
    canvas.width = fileObj.width;
    canvas.height = fileObj.height;

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, fileObj.width, fileObj.height);

    const key = Tools.getDecryptionKey(fileObj.filename, config.ctbl, config.ptbl);
    const decoder = new Tools.CoordDecoder(key[0], key[1]);
    const coords = decoder.getCoords(img);

    for (const { srcX, srcY, destX, destY, width, height } of coords) {
      ctx.drawImage(img, srcX, srcY, width, height, destX, destY, width, height);
    }

    const mimeType = isJpg ? 'image/jpeg' : 'image/png';
    const outExt = isJpg ? 'jpg' : 'png';
    const blob = await new Promise(r => canvas.toBlob(r, mimeType, CONFIG.JPEG_QUALITY));

    canvas.width = 0;
    canvas.height = 0;

    return {
      fileName: `${fileObj.pageNo}.${outExt}`,
      data: new Uint8Array(await blob.arrayBuffer())
    };
  }

  /* =========================================================================
   * TIẾN TRÌNH TẢI CHÍNH
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    const cid = getCid();
    if (!cid || cid === "Cmoa_Episode") {
      if (ui) ui.updateProgress({ status: "Lỗi: Không tìm thấy CID." });
      return;
    }

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let data = state.chapterData;
      if (!data) {
        data = await fetchCmoaManifest(cid);
        state.chapterData = data;
      }

      const { config, files } = data;
      const totalPages = files.length;
      if (!totalPages) throw new Error("Không có trang hợp lệ.");

      const useJpeg = Boolean(state.convertJpeg);
      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file txt định danh
      zip.addFile(`${cid}.txt`, new Uint8Array(0));

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = files.map(fileObj => () => descrambleCmoaImage(fileObj, config, useJpeg));
      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res?.data) zip.addFile(res.fileName, res.data);
      }

      const zipName = `${getCleanTitle(config.title, config.subTitle)}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[cmoa-dl] Error:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * KHỞI CHẠY VÀ SPA WATCHER
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(30);

    const ui = getUI();

    if (!isEpisodeUrl()) {
      if (ui?.panel) ui.panel.style.display = "none";
      return;
    }

    if (ui?.panel) ui.panel.style.display = "block";
    if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });

    const cid = getCid();
    if (!cid || cid === "Cmoa_Episode") {
      if (ui) ui.updateProgress({ status: "Sẵn sàng." });
      return;
    }

    try {
      const data = await fetchCmoaManifest(cid);
      state.chapterData = data;

      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: data.files.length,
          status: "Sẵn sàng."
        });
      }
    } catch (e) {
      console.error("[cmoa-dl] Boot error:", e);
      if (ui) ui.updateProgress({ status: "Sẵn sàng." });
    }
  }

  // Khởi động SPA Route Watcher
  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute(() => {
      state.chapterData = null;
      state.running = false;
      const ui = getUI();
      if (ui) ui.setBusy(false);
      boot();
    });
  }

  if (DOC.readyState === "loading") {
    DOC.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();