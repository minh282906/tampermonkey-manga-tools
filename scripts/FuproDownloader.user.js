// ==UserScript==
// @name         Fupro Comics Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://viewer.fupro-comics.com/images/favicon.ico
// @description  Tải manga trên Fupro Comics.
// @author       anonymous & AI
// @match        https://viewer.fupro-comics.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      d79boba150po0.cloudfront.net
// @connect      d3bfjqszfw85dv.cloudfront.net
// @connect      cloudfront.net
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/decoders/FuproTools.js
// ==/UserScript==

(function fuproUniversalDownloader() {
  "use strict";

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6, // 6 luồng TCP Socket
    JPEG_QUALITY: 1.0, // Chất lượng xuất JPG nếu người dùng chọn
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = (ms) => new Promise((resolve) => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("fupro-dl:convert-jpeg") === "1",
    chapterData: null,
    ui: null,
    lastUrl: "",
    lastUid: "",
  };

  /* =========================================================================
   * 1. GIAO DIỆN THEME: ĐEN / TRẮNG THEO HEADER FUPRO COMICS
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI =
      window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "fupro-dl",
        title: "ふゅーぷろComics",
        engine: "FUSION PRODUCT",
        themeColor: "#010101",
        themeBg: "#ffffff",
        titleColor: "#010101",
        btnBg: "#010101",
        btnColor: "#ffffff",
        tabBg: "#010101",
        tabColor: "#ffffff",
        topOffset: "40px", // Khóa cứng 40px theo Header web
        defaultJpgText: "Xuất file JPG (mặc định PNG)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("fupro-dl:convert-jpeg", checked ? "1" : "0");
        },
      };

      state.ui = createUI(uiConfig);
      state.ui.setBusy(true);

      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector(
          '[style*="font: 800 13px"], [style*="font:800 13px"]',
        );
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:${uiConfig.titleColor};letter-spacing:0.3px;">${uiConfig.title}</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px;visibility:hidden;">${uiConfig.engine}</div>
          `;
        }
      }
    }
    return state.ui;
  }

  /* =========================================================================
   * 2. BỘ HỖ TRỢ XỬ LÝ CHUỖI, URL & TIÊU ĐỀ
   * ========================================================================= */
  function isEpisodeUrl() {
    return (
      WIN.location.hostname.includes("viewer.fupro-comics.com") &&
      WIN.location.pathname.includes("reader_fupro")
    );
  }

  function getBookUid() {
    return (
      WIN.uid ||
      new URLSearchParams(WIN.location.search).get("uid") ||
      "Comicbox_Fupro"
    );
  }

  function cleanString(str) {
    if (!str) return "";
    return str
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/【(?!(?:フルカラー版|カラー版|完全版|特装版))[^】]*】/gi, ' ')
      .replace(/[［\[【](?:ばら売り|分冊版|単話版)[］\]】]/gi, ' ')
      .replace(/[\\/*?:"<>|]/g, '')
      .replace(/\s{2,}/g, ' ') // Thu gọn nhiều khoảng trắng thành 1
      .trim();
  }

  function getCleanTitle(manifestTitle) {
    try {
      // Ưu tiên số 1: Lấy tên đầy đủ từ thẻ booktitle hoặc document.title
      let rawTitle =
        DOC.getElementById("booktitle")?.textContent?.trim() || DOC.title || "";

      // Nếu document.title bị rỗng thì mới dùng đến mã slug manifestTitle
      if (!rawTitle || /fupro|reader/i.test(rawTitle)) {
        rawTitle = manifestTitle || "";
      }

      rawTitle = rawTitle.replace(/\s*[-|｜]\s*ふゅーぷろ.*$/i, "").trim();
      rawTitle = cleanString(rawTitle);
      rawTitle = rawTitle.replace(/([\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff])([0-9０-９]+)$/, '$1 $2');

      // Tách " - " nếu là "1巻", "第1話", hoặc số tập đứng riêng " 1", " 2"...
      // (TRỪ trường hợp số trong ngoặc đơn (1), (2) thì giữ nguyên cạnh tên)
      const mVolChap = rawTitle.match(/^(.*?)\s+((?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\.]+(?:\s*(?:話|回|巻|章|節|部|エピソード|分冊版|単話).*)?)$/i);
      if (mVolChap && !/^\([0-9０-９]+\)$/.test(mVolChap[2])) {
        return `${cleanString(mVolChap[1])} - ${cleanString(mVolChap[2])}`;
      }

      if (rawTitle && rawTitle.length > 2) return rawTitle;
    } catch (e) {}

    return `Fupro_${getBookUid().slice(0, 16)}`;
  }

  /* =========================================================================
   * 3. BÓC TÁCH DỮ LIỆU SÁCH TRỰC TIẾP TỪ RAM CỦA WEB (0MS)
   * ========================================================================= */
  async function resolveFuproBookData() {
    let baseData = null;

    // Quét trực tiếp đối tượng worker trong RAM của web (0ms)
    for (let i = 0; i < 30; i++) {
      const worker = WIN[DOC.viewerObjName || "viewer_"] || WIN.viewer_;
      if (worker?.pageInfoListAll?.zip_100?.length > 0) {
        baseData = worker.pageInfoListAll;
        break;
      }
      await sleep(100);
    }

    if (
      !baseData ||
      !Array.isArray(baseData.zip_100) ||
      baseData.zip_100.length === 0
    ) {
      return null;
    }

    // Trang bìa là trang 1 (không xáo trộn, không đảo màu), từ trang 2 là zip_100[1..]
    const coverUrl =
      baseData.cover || baseData.cover_origin || baseData.zip_100[0];
    const pageUrls = [coverUrl, ...baseData.zip_100.slice(1)];
    const rebuildConfig = baseData.rebuild;

    return {
      title: getCleanTitle(baseData.title),
      bookUid: getBookUid(),
      pageUrls: pageUrls,
      rebuildConfig: rebuildConfig,
    };
  }

  /* =========================================================================
   * 4. GIẢI MÃ MA TRẬN 2x2 & BẢO TỒN ĐỊNH DẠNG BÌA GỐC (GOLDEN RULE 2 & 4)
   * ========================================================================= */
  async function descramblePage(
    pageIndex,
    pageUrl,
    isCover,
    rebuildConfig,
    isJpg,
  ) {
    const Utils = WIN.MangaUtils || window.MangaUtils;
    const Tools = WIN.FuproTools || window.FuproTools;

    const rawBuf = await Utils.fetchBuffer(pageUrl, {
      Referer: "https://viewer.fupro-comics.com/",
    });
    const rawExt = Utils.detectExt(rawBuf);
    const rawBytes = new Uint8Array(rawBuf);

    // -------------------------------------------------------------
    // TRANG BÌA (COVER - TRANG 1): KHÔNG XÁO TRỘN, KHÔNG ÂM BẢN
    // -------------------------------------------------------------
    if (isCover) {
      // TH 1: Người dùng chọn xuất JPG -> Giữ nguyên định dạng gốc CDN (Zero-Copy 0ms)
      if (isJpg) {
        return {
          files: [{ fileName: `1.${rawExt}`, data: rawBytes }],
        };
      }

      // TH 2: Người dùng để mặc định PNG -> Xuất song song cả 1.(ext) gốc và 1.png Master
      const files = [{ fileName: `1.${rawExt}`, data: rawBytes }];

      // Nếu file gốc chưa phải PNG thì xuất thêm bản 1.png
      if (rawExt !== "png") {
        const mime = Utils.detectMimeType(rawBuf);
        const img = await Utils.loadImage(rawBuf, mime);
        const canvas = DOC.createElement("canvas");
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext("2d", { alpha: false });
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0);
        const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
        canvas.width = 0;
        canvas.height = 0;
        files.push({
          fileName: `1.png`,
          data: new Uint8Array(await blob.arrayBuffer()),
        });
      }

      return { files };
    }

    // -------------------------------------------------------------
    // CÁC TRANG RUỘT (TRANG 2..N: XÁO TRỘN 2x2 & ÂM BẢN)
    // -------------------------------------------------------------
    const mime = Utils.detectMimeType(rawBuf);
    const img = await Utils.loadImage(rawBuf, mime);

    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;

    const canvas = DOC.createElement("canvas");
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext("2d", {
      alpha: false,
      willReadFrequently: true,
    });
    ctx.imageSmoothingEnabled = false;
    ctx.mozImageSmoothingEnabled = false;
    ctx.webkitImageSmoothingEnabled = false;
    ctx.msImageSmoothingEnabled = false;

    const geom = Tools.calculateCoords(w, h, rebuildConfig);

    // BƯỚC A: Hoán vị 4 góc phần tư
    for (const c of geom.coords) {
      ctx.drawImage(
        img,
        c.srcX,
        c.srcY,
        c.srcW,
        c.srcH,
        c.destX,
        c.destY,
        c.width,
        c.height,
      );
    }

    // BƯỚC B: Đảo ngược màu sắc từ âm bản về màu sắc nguyên bản (255 - RGB)
    const imgData = ctx.getImageData(0, 0, w, h);
    Tools.invertRgbPixels(imgData.data);
    ctx.putImageData(imgData, 0, 0);

    const outMime = isJpg ? "image/jpeg" : "image/png";
    const outExt = isJpg ? "jpg" : "png";
    const blob = await new Promise((r) =>
      canvas.toBlob(r, outMime, CONFIG.JPEG_QUALITY),
    );

    canvas.width = 0;
    canvas.height = 0;

    return {
      files: [
        {
          fileName: `${pageIndex + 1}.${outExt}`,
          data: new Uint8Array(await blob.arrayBuffer()),
        },
      ],
    };
  }

  /* =========================================================================
   * 5. TIẾN TRÌNH TẢI CHÍNH & ĐÓNG GÓI PUREZIPWRITER (6 LUỒNG TRONG RAM)
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui)
        ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let data = state.chapterData;
      if (!data || !data.pageUrls?.length) {
        data = await resolveFuproBookData();
        state.chapterData = data;
      }

      if (!data || !data.pageUrls?.length)
        throw new Error("Không thể lấy dữ liệu tập truyện.");

      const { pageUrls, title, bookUid, rebuildConfig } = data;
      const totalPages = pageUrls.length;
      const useJpeg = Boolean(state.convertJpeg);

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file txt định danh theo Golden Rule 2
      zip.addFile(`${bookUid}.txt`, new Uint8Array(0));
      if (ui)
        ui.updateProgress({
          completed: 0,
          total: totalPages,
          status: "Đang tải...",
        });

      // 6 luồng tải song song Zero-Copy trong RAM
      const tasks = pageUrls.map(
        (url, idx) => () =>
          descramblePage(idx, url, idx === 0, rebuildConfig, useJpeg),
      );
      const results = await Utils.runParallelQueue(
        tasks,
        CONFIG.MAX_CONCURRENT,
        (completed, total) => {
          if (ui)
            ui.updateProgress({ completed, total, status: "Đang tải..." });
        },
      );

      let savedCount = 0;
      for (const res of results) {
        if (res?.files) {
          for (const f of res.files) {
            zip.addFile(f.fileName, f.data);
          }
          savedCount++;
        }
      }

      if (savedCount === 0) {
        throw new Error(
          "Giải mã thất bại toàn bộ các trang ảnh! Hãy kiểm tra kết nối.",
        );
      }

      if (ui)
        ui.updateProgress({
          completed: totalPages,
          total: totalPages,
          status: "Đang đóng gói file ZIP...",
        });
      await sleep(50);

      const finalFileName = `${title}.zip`;
      zip.download(finalFileName);

      if (ui) {
        ui.updateProgress({
          completed: totalPages,
          total: totalPages,
          status: "Hoàn tất.",
        });
        ui.setBusy(false);
      }
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[fupro-dl] Download error:", err);
    } finally {
      state.running = false;
    }
  }

  /* =========================================================================
   * 6. KHỞI CHẠY & THEO DÕI ĐIỀU HƯỚNG SPA
   * ========================================================================= */
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

    try {
      const data = await resolveFuproBookData();
      if (!data || !data.pageUrls?.length) {
        throw new Error(
          "Không thể trích xuất dữ liệu truyện (Chương bị khóa hoặc chưa mở).",
        );
      }

      state.chapterData = data;

      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: data.pageUrls.length,
          status: "Sẵn sàng.",
        });
        ui.setBusy(false);
      }
    } catch (err) {
      console.error("[fupro-dl] Boot error:", err);
      if (ui) {
        ui.updateProgress({
          status: "Lỗi: " + (err?.message || "Không thể tải trang."),
        });
        ui.setBusy(true);
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
        state.lastUid = "";
        state.lastUrl = "";
        state.running = false;
        return;
      }

      const currentUid = getBookUid();
      if (state.lastUid && state.lastUid === currentUid) return;

      state.lastUrl = newUrl;
      state.lastUid = currentUid;
      state.chapterData = null;
      state.running = false;

      const ui = getUI();
      if (ui) {
        ui.setBusy(true);
        ui.updateProgress({
          completed: 0,
          total: 0,
          status: "Đang kiểm tra...",
        });
      }
      boot();
    });
  }

  boot();
})();
