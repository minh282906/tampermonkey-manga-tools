// ==UserScript==
// @name         Pixiv Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://www.pixiv.net/favicon.ico
// @description  Tải tranh và manga chất lượng gốc (Original) trên Pixiv (pixiv.net).
// @author       anonymous & AI
// @match        https://www.pixiv.net/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      pixiv.net
// @connect      *.pixiv.net
// @connect      *.pximg.net
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function pixivUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6 // 6 luồng kịch trần TCP Socket của trình duyệt
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    detectedSourceFormat: 'jpg',
    chapterData: null,
    preloadingId: null,
    preloadedBuffer: null,
    preloadedExt: null,
    ui: null
  };

  /* =========================================================================
   * 1. GIAO DIỆN UNIVERSAL UI 2 TẦNG (THEME XANH PIXIV #0096f9)
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "pixiv-dl",
        title: "pixiv",                      // Sửa thành pixiv theo yêu cầu của bạn
        engine: "PIXIV",
        themeColor: "#0096f9",              // Xanh thương hiệu Pixiv
        themeBg: "#ffffff",                 // Nền trắng sáng
        titleColor: "#0096f9",
        btnBg: "#0096f9",
        btnColor: "#ffffff",
        topOffset: "64px",
        defaultJpgText: "Ảnh gốc là JPG",
        onDownload: startDownload
      };

      state.ui = createUI(uiConfig);

      // Ẩn hoàn toàn ô checkbox, chỉ giữ lại nhãn chữ hiển thị định dạng gốc
      if (state.ui?.jpgInput) {
        state.ui.jpgInput.style.display = "none";
        state.ui.jpgInput.disabled = true;
      }
      if (state.ui?.jpgSpan) {
        state.ui.jpgSpan.style.cursor = "default";
        state.ui.jpgSpan.textContent = `Ảnh gốc là ${state.detectedSourceFormat.toUpperCase()}`;
      }

      // Header 2 tầng: Dòng 1 "pixiv", Dòng 2 tàng hình giữ nguyên khung
      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:${uiConfig.titleColor};letter-spacing:0.2px;">${uiConfig.title}</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px;visibility:hidden;">${uiConfig.engine}</div>
          `;
        }
      }
    }
    return state.ui;
  }

  /* =========================================================================
   * 2. BỘ XỬ LÝ CHUỖI & TÊN FILE THÔNG MINH (TỰ ĐỘNG LỌC TRÙNG VÀ BỎ #NUMBER)
   * ========================================================================= */
  function isArtworkUrl() {
    return /\/artworks\/(\d+)/i.test(WIN.location.pathname);
  }

  function getIllustId() {
    const match = WIN.location.pathname.match(/\/artworks\/(\d+)/i);
    return match ? match[1] : null;
  }

  function cleanString(str) {
    if (!str) return "";
    return str
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/【(?:期間限定|無料|試し読み|お試し|特別).*?】/gi, '')
      .replace(/[\\/*?:"<>|]/g, '')
      .replace(/[【】]/g, '') // Gọt sạch dấu ngoặc vuông Nhật Bản 【 】
      .trim();
  }

  // Phát hiện tiêu đề đã chứa số chương rõ ràng (1話, 第1話, 01, Ch.1, Ep.1...)
  function hasExplicitChapterNumber(str) {
    if (!str) return false;
    const pattern = /(?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\.]+\s*(?:話|巻|章|節|部|エピソード|分冊版|単話|本目|曲|局)|^(?:#?\s*[0-9０-９]+(?:\.[0-9]+)?|[Cc]h(?:apter)?\.?\s*\d+|[Ee]p(?:isode)?\.?\s*\d+)(?:\s+|$)/i;
    return pattern.test(str.trim());
  }

  function resolvePixivTitle(body, illustId) {
    const author = cleanString(body.userName);
    let workTitle = cleanString(body.title);
    const series = body.seriesNavData;

    // TRƯỜNG HỢP A: Manga thuộc Series
    if (series && series.title) {
      const sTitle = cleanString(series.title);

      // Cắt bỏ phần tên series nếu bị lặp lại ở đầu workTitle
      if (sTitle && workTitle.startsWith(sTitle)) {
        workTitle = cleanString(workTitle.substring(sTitle.length));
      }

      // Nếu đã có số chương rõ ràng (như "1話") -> BỎ QUA #order
      // Nếu chưa có số chương (như "旅先で縁ができた奥さん") -> GIỮ LẠI #125 để xếp thứ tự Explorer
      const hasChapNum = hasExplicitChapterNumber(workTitle);
      let orderPart = "";
      if (!hasChapNum && series.order) {
        orderPart = `#${series.order}`;
      }

      if (orderPart && workTitle) {
        return `${sTitle} ${orderPart} - ${workTitle}`;
      } else if (orderPart) {
        return `${sTitle} ${orderPart}`;
      } else if (workTitle) {
        return `${sTitle} - ${workTitle}`;
      }
      return sTitle || `Pixiv_${illustId}`;
    }

    // TRƯỜNG HỢP B: Tranh độc lập (Có Tên Tác Giả ở đầu)
    if (workTitle && !workTitle.startsWith(author)) {
      return `${author} - ${workTitle}`;
    }
    return workTitle || `${author} - ${illustId}`;
  }

  function getExtensionFromUrl(url, defaultExt = 'jpg') {
    try {
      const match = url.split('?')[0].match(/\.([a-zA-Z0-9]+)$/);
      if (match && match[1]) {
        const ext = match[1].toLowerCase();
        if (['jpg', 'jpeg', 'png', 'webp', 'avif'].includes(ext)) {
          return ext === 'jpeg' ? 'jpg' : ext;
        }
      }
    } catch (e) {}
    return defaultExt;
  }

  function downloadSingleFile(uint8Array, fileName, mimeType) {
    const blob = new Blob([uint8Array], { type: mimeType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = DOC.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = "noopener";
    a.style.display = "none";
    (DOC.body || DOC.documentElement).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /* =========================================================================
   * 3. BÓC TÁCH DỮ LIỆU METADATA & LINK ẢNH GỐC
   * ========================================================================= */
  async function fetchPixivArtworkData(illustId) {
    const detailRes = await WIN.fetch(`https://www.pixiv.net/ajax/illust/${illustId}?lang=en`, {
      headers: { 'Accept': 'application/json' }
    });
    const detailJson = await detailRes.json();
    if (detailJson.error || !detailJson.body) {
      throw new Error(detailJson.message || "Không lấy được thông tin tác phẩm từ Pixiv.");
    }

    const body = detailJson.body;
    const pageCount = body.pageCount || 1;
    const finalTitle = resolvePixivTitle(body, illustId);

    let pages = [];

    if (pageCount === 1) {
      const originalUrl = body.urls?.original;
      if (!originalUrl) throw new Error("Không tìm thấy link ảnh Original.");
      const ext = getExtensionFromUrl(originalUrl, 'jpg');
      pages.push({ pageNo: 1, url: originalUrl, ext });
    } else {
      const pagesRes = await WIN.fetch(`https://www.pixiv.net/ajax/illust/${illustId}/pages?lang=en`, {
        headers: { 'Accept': 'application/json' }
      });
      const pagesJson = await pagesRes.json();
      if (pagesJson.error || !Array.isArray(pagesJson.body) || pagesJson.body.length === 0) {
        throw new Error(pagesJson.message || "Không lấy được danh sách trang từ Pixiv.");
      }
      pages = pagesJson.body.map((item, idx) => {
        const url = item.urls?.original || "";
        const ext = getExtensionFromUrl(url, 'jpg');
        return { pageNo: idx + 1, url, ext };
      });
    }

    return {
      illustId,
      title: finalTitle,
      pageCount,
      pages
    };
  }

  /* =========================================================================
   * 4. TẢI ẢNH ZERO-COPY 0MS (KÈM REFERER VƯỢT 403 CDN)
   * ========================================================================= */
  async function processImage(pageObj) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;

    const rawBuffer = await Utils.fetchBuffer(pageObj.url, {
      "Referer": "https://www.pixiv.net/"
    });

    const realExt = Utils.detectExt(rawBuffer) || pageObj.ext || 'jpg';

    return {
      pageNo: pageObj.pageNo,
      ext: realExt,
      data: new Uint8Array(rawBuffer)
    };
  }

  /* =========================================================================
   * 5. TIẾN TRÌNH TẢI CHÍNH (6 LUỒNG TRONG RAM + TẬN DỤNG PRELOAD 0MS)
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    const illustId = getIllustId();
    if (!illustId) {
      if (ui) ui.updateProgress({ status: "Lỗi: Không tìm thấy ID tác phẩm." });
      return;
    }

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let data = state.chapterData;
      if (!data || data.illustId !== illustId) {
        data = await fetchPixivArtworkData(illustId);
        state.chapterData = data;
      }

      const { pages, title, pageCount } = data;
      const totalPages = pages.length;
      if (!totalPages) throw new Error("Không có trang hợp lệ để tải.");

      const Utils = window.MangaUtils || globalThis.MangaUtils;

      // =======================================================================
      // NHÁNH A: 1 ẢNH (TẬN DỤNG PRELOAD ĐỂ TẢI VỀ TỨC THÌ 0MS)
      // =======================================================================
      if (pageCount === 1) {
        if (ui) ui.updateProgress({ completed: 0, total: 1, status: "Đang tải..." });

        let imageBytes = null;
        let finalExt = pages[0].ext;

        // Nếu đã có mảng byte preload sẵn trong RAM từ lúc boot -> nhả file ngay 0ms!
        if (state.preloadedBuffer && state.preloadingId === illustId) {
          imageBytes = new Uint8Array(state.preloadedBuffer);
          finalExt = state.preloadedExt || finalExt;
        } else {
          const res = await processImage(pages[0]);
          imageBytes = res.data;
          finalExt = res.ext;
        }

        await sleep(50);

        const fileName = `${title}.${finalExt}`;
        const mime = finalExt === 'jpg' ? 'image/jpeg' : `image/${finalExt}`;
        downloadSingleFile(imageBytes, fileName, mime);

        if (ui) ui.updateProgress({ completed: 1, total: 1, status: "Hoàn tất." });
        return;
      }

      // =======================================================================
      // NHÁNH B: NHIỀU ẢNH (ĐÓNG GÓI ZIP DUY NHẤT TRONG RAM)
      // =======================================================================
      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const zip = new ZipClass();

      // Golden Rule 2: Luôn có 1 file .txt rỗng mang tên ID định danh ở thư mục gốc
      zip.addFile(`${illustId}.txt`, new Uint8Array(0));

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map((pageObj) => () => processImage(pageObj));
      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res?.data) {
          zip.addFile(`${res.pageNo}.${res.ext}`, res.data);
        }
      }

      const zipName = `${title}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[pixiv-dl] Download error:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * 6. KHỞI CHẠY, THEO DÕI SPA VÀ KÍCH HOẠT PRELOAD NGẦM
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(20);
    const ui = getUI();

    if (!isArtworkUrl()) {
      if (ui?.panel) ui.panel.style.display = "none";
      return;
    }

    if (ui?.panel) {
      ui.panel.style.display = "block";
      if (!DOC.body.contains(ui.panel)) DOC.body.appendChild(ui.panel);
    }

    const illustId = getIllustId();
    if (!illustId) return;

    if (state.chapterData && state.chapterData.illustId === illustId) {
      return;
    }

    if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });

    try {
      const data = await fetchPixivArtworkData(illustId);
      state.chapterData = data;

      const firstExt = (data.pages[0]?.ext || 'jpg').toUpperCase();
      state.detectedSourceFormat = firstExt;
      if (ui?.jpgSpan) {
        ui.jpgSpan.textContent = `Ảnh gốc là ${firstExt}`;
      }

      // KÍCH HOẠT PRELOAD NGẦM CHO BÀI VIẾT 1 ẢNH (CHỈ TẢI ĐÚNG LINK ORIGINAL)
      if (data.pageCount === 1) {
        state.preloadingId = illustId;
        const Utils = window.MangaUtils || globalThis.MangaUtils;
        Utils.fetchBuffer(data.pages[0].url, { "Referer": "https://www.pixiv.net/" })
          .then(buf => {
            if (state.preloadingId === illustId) {
              state.preloadedBuffer = buf;
              state.preloadedExt = Utils.detectExt(buf) || data.pages[0].ext;
            }
          })
          .catch(() => {});
      }

      await sleep(80);

      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: data.pages.length,
          status: "Sẵn sàng."
        });
      }
    } catch (err) {
      console.error("[pixiv-dl] Boot error:", err);
      if (ui) ui.updateProgress({ status: "Sẵn sàng." });
    }
  }

  // Hook theo dõi chuyển trang SPA
  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute(() => {
      const illustId = getIllustId();
      
      if (!state.chapterData || state.chapterData.illustId !== illustId) {
        state.chapterData = null;
        state.preloadingId = null;
        state.preloadedBuffer = null;
        state.preloadedExt = null;
        state.running = false;
        const ui = getUI();
        if (ui) {
          ui.setBusy(false);
          ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
        }
      }
      boot();
    });
  }

  if (DOC.readyState === "loading") {
    DOC.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();