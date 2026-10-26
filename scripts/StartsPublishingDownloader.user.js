// ==UserScript==
// @name         Starts Publishing Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://novema.jp/assets/1.0.996/img/apple-touch-icon.png
// @description  Tải manga trên toàn bộ hệ sinh thái Starts Publishing (Novema, No-Ichigo, Berry's Cafe).
// @author       anonymous & AI
// @match        https://novema.jp/comic/serial/*
// @match        https://www.no-ichigo.jp/comic/serial/*
// @match        https://no-ichigo.jp/comic/serial/*
// @match        https://www.berrys-cafe.jp/comic/serial/*
// @match        https://berrys-cafe.jp/comic/serial/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      novema.jp
// @connect      *.novema.jp
// @connect      no-ichigo.jp
// @connect      *.no-ichigo.jp
// @connect      berrys-cafe.jp
// @connect      *.berrys-cafe.jp
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN ---
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/StartsPublishingDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/StartsPublishingDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/decoders/StartsPublishingTools.js
// ==/UserScript==

(function startsPublishingUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6,   // 6 luồng tải và giải mã song song
    JPEG_QUALITY: 1.0    // Chất lượng xuất JPG nếu người dùng chọn
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("starts-dl:convert-jpeg") === '1',
    chapterData: null,
    ui: null,
    lastUrl: "",
    lastChapterKey: ""
  };

  /* =========================================================================
   * BẢNG MÀU NHẬN DIỆN THƯƠNG HIỆU TỪNG NHÃN (THEO CHUẨN HEADER THỰC TẾ)
   * ========================================================================= */
  function resolveSiteTheme(comicData) {
    const host = WIN.location.hostname;
    const labelId = Number(comicData?.serial_comic_label_id);

    // 1. Nhóm No-Ichigo (no-ichigo.jp) (Tên chính thức: noicomi COMICS)
    if (host.includes('no-ichigo.jp') || labelId === 2) {
      return { name: "noicomi COMICS", top: "39.98px", color: "#FA8296", bg: "#ffffff", text: "#FA8296", engine: "STARTS PUBLISHING" };
    }

    // 2. Nhóm Berry's Cafe (berrys-cafe.jp): Tách biệt rõ 1 (Hiện đại) và 3 (Dị giới)
    if (host.includes('berrys-cafe.jp') || labelId === 1 || labelId === 3) {
      if (labelId === 3) {
        // ID 3: Berry's Fantasy (Dị giới / Chuyển sinh) -> Tím rượu vang
        return { name: "Berry's Fantasy", top: "39.98px", color: "#00C8D2", bg: "#ffffff", text: "#00C8D2", engine: "STARTS PUBLISHING" };
      }
      // ID 1 (hoặc mặc định Berry's): comic Berry's (Hiện đại / Tổng tài) -> Hồng đào
      return { name: "comic Berry's", top: "39.98px", color: "#FF99A8", bg: "#ffffff", text: "#FF99A8", engine: "STARTS PUBLISHING" };
    }

    // 3. Nhóm Novema (Khóa chuẩn 100% theo ID)
    if (labelId === 4) {
      return { name: "comic Grast", top: "39.98px", color: "#363232", bg: "#ffffff", text: "#363232", engine: "STARTS PUBLISHING" };
    }
    if (labelId === 7) {
      return { name: "BeLuck COMICS", top: "39.98px", color: "#F089B4", bg: "#ffffff", text: "#7ECDF5", engine: "STARTS PUBLISHING" };
    }
    if (labelId === 5) {
      return { name: "OZcomics", top: "39.98px", color: "#000000", bg: "#ffffff", text: "#000000", engine: "STARTS PUBLISHING" };
    }
    if (labelId === 2) {
      return { name: "Starts Bunko", top: "39.98px", color: "#43BDD8", bg: "#ffffff", text: "#43BDD8", engine: "STARTS PUBLISHING" };
    }

    return { name: "Novema!", top: "39.98px", color: "#2b2b2b", bg: "#ffffff", text: "#2b2b2b", engine: "STARTS PUBLISHING" };
  }

  /* =========================================================================
   * 1. GIAO DIỆN UNIVERSAL UI 2 TẦNG
   * ========================================================================= */
  function getUI(comicData) {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const theme = resolveSiteTheme(comicData);

      const uiConfig = {
        storagePrefix: "starts-dl",
        title: theme.name,
        engine: theme.engine,
        themeColor: theme.color,
        themeBg: theme.bg,
        titleColor: theme.text,
        btnBg: theme.color,
        btnColor: "#ffffff",
        tabBg: theme.color,
        tabColor: "#ffffff",
        topOffset: theme.top,
        defaultJpgText: "Xuất file JPG (mặc định PNG)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("starts-dl:convert-jpeg", checked ? '1' : '0');
        }
      };

      state.ui = createUI(uiConfig);
      state.ui.setBusy(true);

      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:${uiConfig.titleColor};letter-spacing:0.3px;">${uiConfig.title}</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px;">${uiConfig.engine}</div>
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
    return /\/comic\/serial\/(?:n)?\d+\/(?:n)?\d+/i.test(WIN.location.pathname);
  }

  function getSerialAndChapter() {
    const m = WIN.location.pathname.match(/\/comic\/serial\/(?:n)?(\d+)\/(?:n)?(\d+)/i);
    return m ? { serialId: m[1], chapterId: m[2] } : null;
  }

  function getComicData() {
    try {
      const el = DOC.getElementById('comic-data');
      if (el && el.textContent) return JSON.parse(el.textContent);
    } catch (e) {}
    return null;
  }

  function cleanString(str) {
    if (!str) return "";
    return str
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/【(?!(?:フルカラー版|カラー版|完全版|特装版))[^】]*】/gi, '')
      .replace(/[\\/*?:"<>|]/g, '')
      .trim();
  }

  function getCleanTitle(comicData) {
    try {
      const ids = getSerialAndChapter();
      let rawTitle = DOC.querySelector('meta[property="og:title"]')?.getAttribute('content') || DOC.title || "";
      rawTitle = cleanString(rawTitle.split(/[|｜]/)[0]);

      let storyTitle = cleanString(comicData?.story_title || "");
      let seriesTitle = "";

      if (storyTitle && rawTitle.includes(storyTitle)) {
        seriesTitle = cleanString(rawTitle.replace(storyTitle, ''));
      } else {
        const m = rawTitle.match(/^(.*?)(?:\s+[-－–—]\s+|\s+)((?:第\s*[0-9０-９一二三四五六七八九十百千万]+[^\s]*|[0-9０-９]+話.*|TRIGGER.*).*)$/i);
        if (m) {
          seriesTitle = cleanString(m[1]);
          if (!storyTitle) storyTitle = cleanString(m[2]);
        } else {
          seriesTitle = rawTitle;
        }
      }

      seriesTitle = seriesTitle.replace(/（[^）]*(?:コミック|文庫|レーベル|出版|COMIC|WEB)[^）]*）$/i, '').trim();
      seriesTitle = seriesTitle.replace(/\([^)]*(?:コミック|文庫|レーベル|出版|COMIC|WEB)[^)]*\)$/i, '').trim();

      if (seriesTitle && storyTitle) {
        if (storyTitle.startsWith(seriesTitle)) {
          storyTitle = cleanString(storyTitle.substring(seriesTitle.length));
        }
        storyTitle = storyTitle.replace(/^[・･\s-]+/, '').trim();
        return `${seriesTitle} - ${storyTitle}`;
      }

      return seriesTitle || storyTitle || `Starts_${ids?.serialId || 'Comic'}_${ids?.chapterId || 'Episode'}`;
    } catch (e) {}

    return `Starts_Comic`;
  }

  /* =========================================================================
   * 3. BÓC TÁCH FILE INDEX.JSON TĨNH TỪ CDN
   * ========================================================================= */
  async function fetchChapterManifest(serialId, chapterId, comicData) {
    const Utils = WIN.MangaUtils || window.MangaUtils;
    const origin = WIN.location.origin;
    const cacheBuster = comicData?.story_updated_at || Date.now();
    const jsonUrl = `${origin}/img/serial-comic/${serialId}/${chapterId}/content/index.json?t=${cacheBuster}`;

    const buf = await Utils.fetchBuffer(jsonUrl, { "Referer": WIN.location.href });
    const rawText = new TextDecoder().decode(buf);
    const items = JSON.parse(rawText);

    if (!Array.isArray(items) || items.length === 0) {
      throw new Error("Không thể đọc danh sách trang từ index.json.");
    }

    const pages = items.map((it, idx) => ({
      pageNo: idx + 1,
      fileName: it.name,
      seed: it.seed,
      size: it.size || 4,
      url: `${origin}/img/serial-comic/${serialId}/${chapterId}/content/${it.name}?t=${cacheBuster}`
    }));

    return pages;
  }

  /* =========================================================================
   * 4. GIẢI MÃ MA TRẬN TRÊN CANVAS (BẢO TỒN NÉT VẼ 100%)
   * ========================================================================= */
  async function processStartsPage(pageItem, isJpg) {
    const Utils = WIN.MangaUtils || window.MangaUtils;
    const Tools = WIN.StartsPublishingTools || window.StartsPublishingTools;

    // 1. Kéo mảng byte nhị phân qua GM_xmlhttpRequest
    const rawBuffer = await Utils.fetchBuffer(pageItem.url, { "Referer": WIN.location.href });

    // 2. Nạp ảnh phần cứng bằng createImageBitmap
    const mime = Utils.detectMimeType(rawBuffer);
    const img = await Utils.loadImage(rawBuffer, mime);

    // 3. Giải mã ma trận bằng StartsPublishingTools (truyền sizeParam động)
    const { canvas } = Tools.descrambleCanvas(img, pageItem.seed, pageItem.size || 4);

    // 4. Xuất mảng byte định dạng đích
    const mimeType = isJpg ? 'image/jpeg' : 'image/png';
    const outExt = isJpg ? 'jpg' : 'png';
    const blob = await new Promise(r => canvas.toBlob(r, mimeType, CONFIG.JPEG_QUALITY));

    canvas.width = 0;
    canvas.height = 0;

    return {
      fileName: `${pageItem.pageNo}.${outExt}`,
      data: new Uint8Array(await blob.arrayBuffer())
    };
  }

  /* =========================================================================
   * 5. TIẾN TRÌNH TẢI CHÍNH (6 LUỒNG TRONG RAM & ĐÓNG GÓI ZIP)
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const comicData = getComicData();
    const ui = getUI(comicData);

    const ids = getSerialAndChapter();
    if (!ids) {
      if (ui) ui.updateProgress({ status: "Lỗi: Không tìm thấy ID chương." });
      return;
    }

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let data = state.chapterData;
      if (!data || !data.pages?.length) {
        const pages = await fetchChapterManifest(ids.serialId, ids.chapterId, comicData);
        data = { pages, comicData };
        state.chapterData = data;
      }

      const { pages } = data;
      const totalPages = pages.length;
      if (!totalPages) throw new Error("Không có trang hợp lệ để tải.");

      const useJpeg = Boolean(state.convertJpeg);
      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file txt định danh ID chương theo Golden Rule 2
      zip.addFile(`n${ids.serialId}_n${ids.chapterId}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      // 6 luồng tải song song và giải mã trong RAM
      const tasks = pages.map(pageItem => () => processStartsPage(pageItem, useJpeg));
      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      let savedCount = 0;
      for (const res of results) {
        if (res?.data) {
          zip.addFile(res.fileName, res.data);
          savedCount++;
        }
      }

      if (savedCount === 0) {
        throw new Error("Giải mã thất bại toàn bộ các trang ảnh! Hãy kiểm tra lại kết nối.");
      }

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      // Đặt tên ZIP chuẩn: [Tên Truyện] - [Tên Chap].zip
      const finalTitle = getCleanTitle(comicData);
      const finalFileName = `${finalTitle}.zip`;
      zip.download(finalFileName);

      if (ui) {
        ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
        ui.setBusy(false);
      }
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[starts-dl] Download error:", err);
    } finally {
      state.running = false;
    }
  }

  /* =========================================================================
   * 6. KHỞI CHẠY & THEO DÕI ĐIỀU HƯỚNG SPA
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(20);

    if (!isEpisodeUrl()) {
      if (state.ui?.panel) state.ui.panel.style.display = "none";
      return;
    }

    const comicData = getComicData();
    const ui = getUI(comicData);

    if (ui?.panel) {
      ui.panel.style.display = "block";
      ui.setBusy(true);
      ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
    }

    const ids = getSerialAndChapter();
    if (!ids) return;

    try {
      let pages = null;
      let retries = 0;

      while (retries < 25) {
        try {
          pages = await fetchChapterManifest(ids.serialId, ids.chapterId, comicData);
          if (pages && pages.length > 0) break;
        } catch (e) {}
        await sleep(150);
        retries++;
      }

      if (!pages || !pages.length) {
        throw new Error("Không thể trích xuất danh sách trang từ máy chủ.");
      }

      state.chapterData = { pages, comicData };

      if (ui) {
        await sleep(80);
        ui.updateProgress({
          completed: 0,
          total: pages.length,
          status: "Sẵn sàng."
        });
        ui.setBusy(false);
      }
    } catch (err) {
      console.error("[starts-dl] Boot error:", err);
      if (ui) {
        ui.updateProgress({ status: "Lỗi: " + (err?.message || "Không thể tải trang.") });
        ui.setBusy(true);
      }
    }
  }

  // Hook SPA History & RouteWatcher: Khóa ID hai chiều theo Chapter
  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute((newUrl) => {
      if (!isEpisodeUrl()) {
        const ui = getUI();
        if (ui?.panel) ui.panel.style.display = "none";
        state.chapterData = null;
        state.lastChapterKey = "";
        state.lastUrl = "";
        state.running = false;
        return;
      }

      const ids = getSerialAndChapter();
      if (!ids) return;

      const currentChapterKey = `${ids.serialId}_${ids.chapterId}`;
      // Nếu chỉ lật trang bên trong cùng một chương (/1 -> /2) -> Đứng yên không reload UI!
      if (state.lastChapterKey && state.lastChapterKey === currentChapterKey) return;

      state.lastUrl = newUrl;
      state.lastChapterKey = currentChapterKey;
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