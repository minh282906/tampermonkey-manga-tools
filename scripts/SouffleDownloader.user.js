// ==UserScript==
// @name         Souffle Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://souffle.life/assets/img/favicon.ico
// @description  Tải manga trên Souffle & Petit Princess (souffle.life) chuẩn Direct Clean Assets Zero-Copy 0ms.
// @author       anonymous & AI
// @match        https://souffle.life/manga/*/*
// @match        https://souffle.life/petitprincess/*/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      souffle.life
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function souffleUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6,   // 6 luồng tải song song
    JPEG_QUALITY: 1.0    // Chất lượng nếu người dùng chọn ép xuất JPG
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("souffle-dl:convert-jpeg") === '1',
    detectedSourceFormat: 'jpg',
    chapterData: null,
    ui: null,
    lastUrl: ""
  };

  /* =========================================================================
   * 1. GIAO DIỆN THEME THEO LOGO SOUFFLE (ĐEN TỐI GIẢN - NỀN TRẮNG SÁNG)
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const isPetit = WIN.location.pathname.includes('/petitprincess/');
      const brandTitle = isPetit ? "Petit Princess" : "Souffle";

      state.ui = createUI({
        storagePrefix: "souffle-dl",
        title: brandTitle,
        engine: "AKITA SHOTEN",
        themeColor: "#18181b",      // Đen theo logo Souffle
        themeBg: "#ffffff",         // Nền panel trắng sáng đồng bộ Header
        titleColor: "#18181b",      // Tiêu đề đen đậm
        btnBg: "#18181b",           // Nút Download màu đen
        btnColor: "#ffffff",        // Chữ trắng đậm
        topOffset: "60px",
        defaultJpgText: "Xuất file JPG (ảnh gốc là JPG)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("souffle-dl:convert-jpeg", checked ? '1' : '0');
        }
      });

      state.ui.updateFormatUI(state.detectedSourceFormat);

      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:#18181b;letter-spacing:0.3px;">${brandTitle}</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px;visibility:hidden;">AKITA SHOTEN</div>
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
    return /\/(?:manga|petitprincess)\/[^\/]+\/[^\/]+/i.test(WIN.location.pathname);
  }

  function getEpisodeSlug() {
    const parts = WIN.location.pathname.split('/').filter(Boolean);
    return parts.length >= 2 ? parts[parts.length - 1] : "Souffle_Episode";
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

  function getCleanTitle() {
    try {
      // 1. Bóc Tên Truyện: Bắt nội dung bên trong dấu ngoặc kép 『...』
      let seriesTitle = "";
      const bookNameEl = DOC.querySelector('.sf-content_book_name a, .sf-content_book_name');
      if (bookNameEl) {
        const rawText = bookNameEl.textContent || "";
        const m = rawText.match(/『(.*?)』/);
        if (m && m[1]) {
          seriesTitle = cleanString(m[1]);
        } else {
          // Nếu không có ngoặc 『』, lọc bỏ thông tin tác giả
          let s = rawText.split(/\s*(?:原作|漫画|キャラクター原案|作画|著|イラスト)[：:]/)[0].trim();
          seriesTitle = cleanString(s);
        }
      }

      // 2. Bóc Tên Chương: Nằm trong thẻ h1
      let episodeTitle = "";
      const h1El = DOC.querySelector('.sf-content_header h1, h1');
      if (h1El) {
        episodeTitle = cleanString(h1El.textContent);
      }

      // Dự phòng từ document.title
      if (!seriesTitle || !episodeTitle) {
        const rawTitle = cleanString((DOC.title || "").split(/[|｜]/)[0]);
        if (!seriesTitle) seriesTitle = rawTitle;
        if (!episodeTitle) episodeTitle = getEpisodeSlug();
      }

      // Khử trùng lặp tiêu đề
      if (seriesTitle && episodeTitle && !seriesTitle.includes(episodeTitle)) {
        return `${seriesTitle} - ${episodeTitle}`;
      }
      if (seriesTitle && episodeTitle) return episodeTitle;
      if (seriesTitle) return `${seriesTitle} - ${getEpisodeSlug()}`;
    } catch (e) {}

    return `Souffle_${getEpisodeSlug()}`;
  }

  /* =========================================================================
   * 3. BÓC TÁCH DANH SÁCH ẢNH TỪ DOM TRUYỀN THỐNG (.sf-content_img)
   * ========================================================================= */
  function extractSoufflePages() {
    const imgContainer = DOC.querySelector('.sf-content_img');
    if (!imgContainer) return null;

    const imgEls = Array.from(imgContainer.querySelectorAll('img'));
    if (imgEls.length === 0) return null;

    const urls = [];
    for (const img of imgEls) {
      const srcAttr = img.getAttribute('src') || img.src || '';
      if (!srcAttr || srcAttr.startsWith('data:')) continue;

      // BỎ QUA 100% ẢNH DUMMY ĐỆM TRANG (Ở CẢ ĐẦU VÀ CUỐI, BÌNH THƯỜNG LẪN TOÀN MÀN HÌNH)
      if (srcAttr.toLowerCase().includes('dummy') || (typeof img.className === 'string' && img.className.includes('Dummy'))) {
        continue;
      }

      // Chuẩn hóa đường dẫn tương đối (/assets/img/...) thành URL tuyệt đối
      const absoluteUrl = new URL(srcAttr, WIN.location.origin).href;
      if (!urls.includes(absoluteUrl)) {
        urls.push(absoluteUrl);
      }
    }

    if (urls.length === 0) return null;

    // Nhận diện định dạng thực tế
    let detectedFormat = 'jpg';
    const firstUrl = urls[0].toLowerCase();
    if (firstUrl.endsWith('.webp')) detectedFormat = 'webp';
    else if (firstUrl.endsWith('.png')) detectedFormat = 'png';

    return {
      slug: getEpisodeSlug(),
      title: getCleanTitle(),
      urls: urls,
      format: detectedFormat
    };
  }

  /* =========================================================================
   * 4. TIẾN TRÌNH TẢI CHÍNH & ZERO-COPY 0MS VÀO ZIP
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let data = state.chapterData;
      if (!data || !data.urls?.length) {
        data = extractSoufflePages();
        state.chapterData = data;
      }

      if (!data || !data.urls?.length) throw new Error("Không tìm thấy danh sách ảnh trang truyện.");

      const { urls, title, slug, format } = data;
      const totalPages = urls.length;
      if (!totalPages) throw new Error("Không có trang hợp lệ để tải.");

      const useJpeg = Boolean(state.convertJpeg);
      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file định danh ID chương
      zip.addFile(`${slug}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      // Hàng đợi tải 6 luồng song song từ máy chủ tĩnh
      const tasks = urls.map((url, idx) => async () => {
        const rawBuffer = await Utils.fetchBuffer(url, { "Referer": WIN.location.href });
        const rawUint8 = new Uint8Array(rawBuffer);
        const ext = Utils.detectExt(rawBuffer);

        // ZERO-COPY: Ghi thẳng mảng byte JPEG gốc vào ZIP (0ms, không qua Canvas)
        if (!useJpeg || ext === 'jpg') {
          return { fileName: `${idx + 1}.${ext}`, data: rawUint8 };
        }

        // Chuyển sang JPG nếu người dùng tick chọn
        const img = await Utils.loadImage(rawBuffer, `image/${ext}`);
        const canvas = DOC.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;

        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.imageSmoothingEnabled = false;
        ctx.mozImageSmoothingEnabled = false;
        ctx.webkitImageSmoothingEnabled = false;
        ctx.msImageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0);

        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', CONFIG.JPEG_QUALITY));
        canvas.width = 0; canvas.height = 0;

        return { fileName: `${idx + 1}.jpg`, data: new Uint8Array(await blob.arrayBuffer()) };
      });

      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res?.data) zip.addFile(res.fileName, res.data);
      }

      const zipName = `${title || getCleanTitle()}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[souffle-dl] Download error:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * 5. KHỞI CHẠY & THEO DÕI DOM
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
      ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
    }

    let data = null;
    for (let i = 0; i < 25; i++) {
      data = extractSoufflePages();
      if (data && data.urls?.length > 0) break;
      await sleep(150);
    }

    if (data && data.urls?.length > 0) {
      state.chapterData = data;
      state.detectedSourceFormat = data.format;

      if (data.format === 'jpg') {
        state.convertJpeg = true;
      }

      if (ui?.updateFormatUI) ui.updateFormatUI(data.format);

      await sleep(80);
      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: data.urls.length,
          status: "Sẵn sàng."
        });
      }
    } else {
      if (ui) ui.updateProgress({ status: "Sẵn sàng." });
    }
  }

  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute((newUrl) => {
      if (!isEpisodeUrl()) {
        const ui = getUI();
        if (ui?.panel) ui.panel.style.display = "none";
        state.chapterData = null;
        state.running = false;
        return;
      }

      if (newUrl === state.lastUrl) return;
      state.lastUrl = newUrl;
      state.chapterData = null;
      state.running = false;

      const ui = getUI();
      if (ui) {
        ui.setBusy(false);
        ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
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