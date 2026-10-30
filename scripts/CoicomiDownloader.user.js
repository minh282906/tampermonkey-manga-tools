// ==UserScript==
// @name         Coicomi Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://viewer.coicomi.com/images/favicon.ico
// @description  Tải manga trên Coicomi (coicomi.com).
// @author       anonymous & AI
// @match        https://viewer.coicomi.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      coicomi.com
// @connect      viewer.coicomi.com
// @connect      viewer-api.coicomi.com
// @connect      relay.coicomi.com
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/decoders/CoicomiTools.js
// ==/UserScript==

(function coicomiUniversalDownloader() {
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
    convertJpeg: localStorage.getItem("coicomi-dl:convert-jpeg") === "1",
    chapterData: null,
    ui: null,
    lastUrl: "",
    lastUid: "",
  };

  /* =========================================================================
   * 1. GIAO DIỆN THEME: HỒNG ĐỎ COICOMI (#E0386A) - NỀN TRẮNG SÁNG
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI =
      window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "coicomi-dl",
        title: "コイコミ",
        engine: "DISEL",
        themeColor: "#e0386a",
        themeBg: "#ffffff",
        titleColor: "#e0386a",
        btnBg: "#e0386a",
        btnColor: "#ffffff",
        tabBg: "#e0386a",
        tabColor: "#ffffff",
        topOffset: "60px",
        defaultJpgText: "Xuất file JPG (mặc định PNG)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("coicomi-dl:convert-jpeg", checked ? "1" : "0");
        },
      };

      state.ui = createUI(uiConfig);
      state.ui.setBusy(true);

      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector(
          '[style*="font: 800 13px"], [style*="font:800 13px"]'
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
      WIN.location.hostname.includes("viewer.coicomi.com") &&
      WIN.location.pathname.includes("reader.php")
    );
  }

  function getBookUid() {
    const sp = new URLSearchParams(WIN.location.search);
    return (
      WIN.uid ||
      sp.get("uid") ||
      DOC.querySelector('input[name="uid"]')?.value ||
      "Coicomi_Book"
    );
  }

  function cleanString(str) {
    if (!str) return "";
    return str
      .replace(/[\r\n\t]+/g, " ")
      .replace(/【(?!(?:フルカラー版|カラー版|完全版|特装版))[^】]*】/gi, " ")
      .replace(/[［\[【](?:ばら売り|分冊版|単話版)[］\]】]/gi, " ")
      .replace(/[\\/*?:"<>|]/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  async function getCleanTitle(manifestTitle, uid) {
    const Utils = WIN.MangaUtils || window.MangaUtils;

    // 1. ƯU TIÊN SỐ 1: Bóc tách từ API Backend BookInterface/get (Sạch 100% không rác SEO)
    if (uid && Utils?.fetchBuffer) {
      try {
        const apiUrl = `https://www.coicomi.com/api/BookInterface/get?uid=${encodeURIComponent(uid)}`;
        const rawBuf = await Utils.fetchBuffer(apiUrl, {
          Referer: "https://viewer.coicomi.com/",
        });
        const resText = new TextDecoder().decode(rawBuf);
        const bookList = JSON.parse(resText);

        if (Array.isArray(bookList) && bookList.length > 0) {
          const item = bookList[0];
          const seriesName = cleanString(item.series_name01 || item.title_value || "");
          const seriesIndex = cleanString(item.series_index || "");

          if (seriesName && seriesIndex) {
            return `${seriesName} - 第${seriesIndex}巻`;
          }
          if (seriesName) return seriesName;
        }
      } catch (e) {}
    }

    // 2. ƯU TIÊN SỐ 2: Bóc tách từ trường title của gói info.php
    if (manifestTitle) {
      let title = cleanString(manifestTitle);
      const mVol = title.match(/^(.*?)\s+([0-9０-９]+)$/);
      if (mVol) {
        return `${cleanString(mVol[1])} - 第${mVol[2]}巻`;
      }
      if (title.length > 2) return title;
    }

    // 3. ƯU TIÊN SỐ 3: Bóc tách từ DOM
    const rawDomTitle =
      DOC.getElementById("booktitle")?.textContent?.trim() || DOC.title || "";
    if (rawDomTitle) {
      let t = cleanString(rawDomTitle.replace(/\s*[-|｜]\s*コイコミ.*$/i, ""));
      const mVol = t.match(/^(.*?)\s+([0-9０-９]+)$/);
      if (mVol) {
        return `${cleanString(mVol[1])} - 第${mVol[2]}巻`;
      }
      if (t.length > 2) return t;
    }

    return `Coicomi_${uid ? uid.slice(0, 16) : "Book"}`;
  }

  /* =========================================================================
   * 3. BÓC TÁCH DỮ LIỆU SÁCH TRỰC TIẾP TỪ RAM CỦA WEB (0MS)
   * ========================================================================= */
  async function resolveCoicomiBookData() {
    let baseData = null;
    let v = null;

    // Chờ cỗ máy viewer_ nạp xong ĐẦY ĐỦ 100% trang trong RAM (không lấy gói mồi rỗng)
    for (let i = 0; i < 60; i++) {
      v = WIN.viewer || WIN.viewer_ || WIN[DOC.viewerObjName];
      if (v) {
        const list = v.pageInfoListAll?.zip_100;
        if (Array.isArray(list) && list.length > 0) {
          const validList = list.filter(Boolean);
          // Chỉ nhận khi toàn bộ mảng đã có link thật (valid === total)
          if (validList.length === list.length && validList.length > 0) {
            baseData = v.pageInfoListAll;
            break;
          }
        }
      }
      await sleep(150);
    }

    // Fallback: nếu sau 9s web chỉ có ít trang thật sự (truyện ngắn)
    if (!baseData) {
      const list = v?.pageInfoListAll?.zip_100 || v?.pageInfoList;
      if (Array.isArray(list)) {
        baseData = {
          title: v?.pageInfoListAll?.title || DOC.title,
          zip_100: list.filter(Boolean),
          cover_width: v?.cover_width,
          cover_height: v?.cover_height,
          tArray: v?.tArray,
        };
      }
    }

    if (
      !baseData ||
      !Array.isArray(baseData.zip_100) ||
      baseData.zip_100.length === 0
    ) {
      return null;
    }

    const uid = v?.uid || getBookUid();
    const cleanTitle = await getCleanTitle(baseData.title, uid);

    return {
      uid: uid,
      title: cleanTitle,
      pageUrls: baseData.zip_100.filter(Boolean),
      coverWidth: Number(v?.cover_width || baseData.cover_width) || 1444,
      coverHeight: Number(v?.cover_height || baseData.cover_height) || 2048,
      tArray: v?.tArray || baseData.tArray,
    };
  }

  /* =========================================================================
   * 4. GIẢI MÃ MA TRẬN 256 Ô CANVAS PIXEL-PERFECT
   * ========================================================================= */
  async function descramblePage(pageIndex, pageUrl, options, isJpg) {
    const Utils = WIN.MangaUtils || window.MangaUtils;
    const Tools = WIN.CoicomiTools || window.CoicomiTools;

    // 1. Tải mảng byte nhị phân thô từ CDN
    const rawBuf = await Utils.fetchBuffer(pageUrl, {
      Referer: "https://viewer.coicomi.com/",
    });

    // 2. Nhận diện MIME type thực tế qua Magic Bytes
    const mime = Utils.detectMimeType(rawBuf);

    // 3. Nạp ảnh không suy hao màu sắc qua createImageBitmap
    const img = await Utils.loadImage(rawBuf, mime);

    // 4. Giải mã ma trận 256 ô siêu vi mô bằng CoicomiTools
    const res = Tools.descrambleCoicomiCanvas(img, pageUrl, options);
    const canvas = res.sharpCanvas;

    // 5. Xuất mảng byte vào ZIP (Mặc định PNG Lossless / Checkbox JPG)
    const outMime = isJpg ? "image/jpeg" : "image/png";
    const outExt = isJpg ? "jpg" : "png";
    const blob = await new Promise((r) =>
      canvas.toBlob(r, outMime, CONFIG.JPEG_QUALITY)
    );

    canvas.width = 0;
    canvas.height = 0;

    return {
      fileName: `${pageIndex + 1}.${outExt}`,
      data: new Uint8Array(await blob.arrayBuffer()),
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
        data = await resolveCoicomiBookData();
        state.chapterData = data;
      }

      if (!data || !data.pageUrls?.length) {
        throw new Error("Không thể lấy dữ liệu tập truyện.");
      }

      const { pageUrls, title, uid, coverWidth, coverHeight, tArray } = data;
      const totalPages = pageUrls.length;
      const useJpeg = Boolean(state.convertJpeg);

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file txt định danh ID sách theo Golden Rule 2
      zip.addFile(`${uid}.txt`, new Uint8Array(0));
      if (ui)
        ui.updateProgress({
          completed: 0,
          total: totalPages,
          status: "Đang tải...",
        });

      const options = {
        coverWidth: coverWidth,
        coverHeight: coverHeight,
        gutter: 4,
        tArray: tArray,
      };

      // 6 luồng tải song song Zero-Copy trong RAM
      const tasks = pageUrls.map(
        (url, idx) => () => descramblePage(idx, url, options, useJpeg)
      );
      const results = await Utils.runParallelQueue(
        tasks,
        CONFIG.MAX_CONCURRENT,
        (completed, total) => {
          if (ui)
            ui.updateProgress({ completed, total, status: "Đang tải..." });
        }
      );

      let savedCount = 0;
      for (const res of results) {
        if (res?.data) {
          zip.addFile(res.fileName, res.data);
          savedCount++;
        }
      }

      if (savedCount === 0) {
        throw new Error(
          "Giải mã thất bại toàn bộ các trang ảnh! Hãy kiểm tra kết nối."
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
      console.error("[coicomi-dl] Download error:", err);
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
      const data = await resolveCoicomiBookData();
      if (!data || !data.pageUrls?.length) {
        throw new Error(
          "Không thể trích xuất dữ liệu truyện (Chương bị khóa hoặc chưa mở)."
        );
      }

      state.chapterData = data;

      if (ui) {
        await sleep(80);
        ui.updateProgress({
          completed: 0,
          total: data.pageUrls.length,
          status: "Sẵn sàng.",
        });
        ui.setBusy(false);
      }
    } catch (err) {
      console.error("[coicomi-dl] Boot error:", err);
      if (ui) {
        ui.updateProgress({
          status: "Lỗi: " + (err?.message || "Không thể tải trang."),
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