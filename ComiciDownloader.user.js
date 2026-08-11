// ==UserScript==
// @name         Comici+ Universal Downloader
// @version      1.1
// @description  Tải và giải mã chuẩn truyện trên nền tảng Comici+, có đóng gói ZIP, lưu tên trang theo số thứ tự tăng dần và một file txt lưu tên mã truyện tương ứng (Champion Cross, Comic Growl, Young Champion, Young Animal, Hana to Yume, Big Comics, Rimacomi+, HERO'S Web, Takecomic, Hayacomic, MAGKAN, COMIC MeDu, Comic PASH!, KimiComi, Comic Room Base, Comirela, BiBiBi Comic, Mangalt, Comici Comic).
// @author       anonymous & AI
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      *.comics.comici.jp
// @connect      *.championcross.jp
// @connect      *.comic-growl.com
// @connect      *.youngchampion.jp
// @connect      *.younganimal.com
// @connect      *.hanayume.com
// @connect      *.bigcomics.jp
// @connect      *.heros-web.com
// @connect      *.takecomic.jp
// @connect      *.hayacomic.jp
// @connect      *.kansai.mag-garden.co.jp
// @connect      *.g-comi.jp
// @connect      *.comicpash.jp
// @connect      *.kimicomi.com
// @connect      *.comic-room-base.com
// @connect      *.comirela.com
// @connect      *.bibibi-comic.com
// @connect      *.mangalt.jp
// @connect      *.rimacomiplus.jp
// @match        https://championcross.jp/*
// @match        https://comic-growl.com/*
// @match        https://youngchampion.jp/*
// @match        https://younganimal.com/*
// @match        https://hanayume.com/*
// @match        https://bigcomics.jp/*
// @match        https://heros-web.com/*
// @match        https://takecomic.jp/*
// @match        https://hayacomic.jp/*
// @match        https://kansai.mag-garden.co.jp/*
// @match        https://g-comi.jp/*
// @match        https://comicpash.jp/*
// @match        https://kimicomi.com/*
// @match        https://comic-room-base.com/*
// @match        https://comirela.com/*
// @match        https://bibibi-comic.com/*
// @match        https://mangalt.jp/*
// @match        https://comics.comici.jp/*
// @match        https://rimacomiplus.jp/*
// @preserve
// ==/UserScript==

(function comiciUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG COMICI+
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 4, // Số lượng trang ảnh tải song song cùng lúc
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  /* =========================================================================
   * 1. BỘ ĐÓNG GÓI ZIP NGUYÊN BẢN (PURE ZIP WRITER)
   * ========================================================================= */
  class PureZipWriter {
    constructor() {
      this.files = [];
    }

    addFile(filename, uint8Array) {
      this.files.push({ name: filename, data: uint8Array });
    }

    static crc32(data) {
      let crc = -1;
      for (let i = 0; i < data.length; i++) {
        crc = (crc >>> 8) ^ PureZipWriter.crcTable[(crc ^ data[i]) & 0xFF];
      }
      return (crc ^ -1) >>> 0;
    }

    generateBlob() {
      const parts = [];
      const centralEntries = [];
      let offset = 0;
      const enc = new TextEncoder();

      for (const file of this.files) {
        const nameBytes = enc.encode(file.name);
        const dataBytes = file.data;
        const crc = PureZipWriter.crc32(dataBytes);
        const size = dataBytes.length;

        const header = new Uint8Array(30 + nameBytes.length);
        const view = new DataView(header.buffer);
        view.setUint32(0, 0x04034b50, true);
        view.setUint16(4, 20, true);
        view.setUint16(6, 0, true);
        view.setUint16(8, 0, true);
        view.setUint16(10, 0, true);
        view.setUint16(12, 0, true);
        view.setUint32(14, crc, true);
        view.setUint32(18, size, true);
        view.setUint32(22, size, true);
        view.setUint16(26, nameBytes.length, true);
        view.setUint16(28, 0, true);
        header.set(nameBytes, 30);

        parts.push(header);
        parts.push(dataBytes);

        const cent = new Uint8Array(46 + nameBytes.length);
        const cview = new DataView(cent.buffer);
        cview.setUint32(0, 0x02014b50, true);
        cview.setUint16(4, 20, true);
        cview.setUint16(6, 20, true);
        cview.setUint16(8, 0, true);
        cview.setUint16(10, 0, true);
        cview.setUint16(12, 0, true);
        cview.setUint16(14, 0, true);
        cview.setUint32(16, crc, true);
        cview.setUint32(20, size, true);
        cview.setUint32(24, size, true);
        cview.setUint16(28, nameBytes.length, true);
        cview.setUint16(30, 0, true);
        cview.setUint16(32, 0, true);
        cview.setUint16(34, 0, true);
        cview.setUint16(36, 0, true);
        cview.setUint32(38, 0, true);
        cview.setUint32(42, offset, true);
        cent.set(nameBytes, 46);

        centralEntries.push(cent);
        offset += header.length + size;
      }

      let centralSize = 0;
      for (const cent of centralEntries) {
        parts.push(cent);
        centralSize += cent.length;
      }

      const eocd = new Uint8Array(22);
      const eview = new DataView(eocd.buffer);
      eview.setUint32(0, 0x06054b50, true);
      eview.setUint16(4, 0, true);
      eview.setUint16(6, 0, true);
      eview.setUint16(8, this.files.length, true);
      eview.setUint16(10, this.files.length, true);
      eview.setUint32(12, centralSize, true);
      eview.setUint32(16, offset, true);
      eview.setUint16(20, 0, true);

      parts.push(eocd);

      return new Blob(parts, { type: 'application/zip' });
    }
  }

  PureZipWriter.crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    PureZipWriter.crcTable[i] = c;
  }

  /* =========================================================================
   * 2. STATE & HELPER FUNCTIONS
   * ========================================================================= */
  const state = {
    running: false,
    convertJpeg: localStorage.getItem("comici-dl:convert-jpeg") === '1',
    cachedPages: [],
    ui: null,
    lastProgress: { completed: 0, total: 0, percent: 0, status: "Đang kiểm tra trang..." }
  };

  function isEpisodeUrl() {
    return WIN.location.pathname.includes('/episodes/') || WIN.location.pathname.includes('/episode/');
  }

  function saveJpegPref(val) {
    try {
      WIN.localStorage.setItem("comici-dl:convert-jpeg", val ? '1' : '0');
    } catch {}
  }

  function getEpisodeId() {
    try {
      const match = WIN.location.pathname.match(/\/episodes?\/([a-zA-Z0-9_-]+)/);
      if (match && match[1]) return match[1];
    } catch (e) {}
    return "Comici_Episode";
  }

  // TẠO TÊN FILE ZIP ĐÚNG CHUẨN: "Tên Truyện - Tên Chap"
  function getCleanTitle() {
    try {
      let seriesTitle = "";
      let episodeTitle = "";

      // 1. Lấy Tên Tựa Truyện
      const viewerEl = DOC.getElementById('comici-viewer') || DOC.querySelector('[data-comic-title]');
      if (viewerEl) {
        seriesTitle = viewerEl.getAttribute('data-comic-title') || "";
      }

      if (!seriesTitle) {
        const sEl = DOC.querySelector('.episode-header-series-title, .series-header-title, [class*="series-title"]');
        if (sEl) seriesTitle = sEl.textContent.trim();
      }

      // 2. Lấy Tên Chap (VD: "第2話")
      const eEl = DOC.querySelector('.episode-header-title, [class*="episode-title"], .ep-title');
      if (eEl) {
        episodeTitle = eEl.textContent.trim();
      }

      // 3. Dự phòng lấy từ document.title
      if ((!seriesTitle || !episodeTitle) && DOC.title) {
        const parts = DOC.title.split(/[｜|・]/);
        if (parts.length >= 2) {
          if (!seriesTitle) seriesTitle = parts[0].trim();
          if (!episodeTitle) episodeTitle = parts[1].trim();
        }
      }

      seriesTitle = seriesTitle.replace(/[\\/*?:"<>|]/g, '').trim();
      episodeTitle = episodeTitle.replace(/[\\/*?:"<>|]/g, '').trim();

      if (seriesTitle && episodeTitle && !seriesTitle.includes(episodeTitle)) {
        return `${seriesTitle} - ${episodeTitle}`;
      } else if (seriesTitle) {
        return seriesTitle;
      } else if (episodeTitle) {
        return episodeTitle;
      }
    } catch (e) {}

    return `Comici_${getEpisodeId()}`;
  }

  function getExtensionFromUrl(url, defaultExt = 'jpg') {
    try {
      const pathname = new URL(url, WIN.location.href).pathname;
      const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
      if (match && match[1]) {
        const ext = match[1].toLowerCase();
        if (['jpg', 'jpeg', 'png', 'webp', 'avif'].includes(ext)) {
          return ext === 'jpeg' ? 'jpg' : ext;
        }
      }
    } catch (e) {}
    return defaultExt;
  }

  // Quét LẤY TẤT CẢ Ảnh PR / Quảng Cáo TOÀN TRANG (Lọc bỏ các icon logo nhỏ)
  async function getAllPrImages(timeoutMs = 400) {
    const selectors = [
      '.-cv-pr-img-wrap img',
      '#xCVTopPr figure img',
      '.mode-top-pr img',
      '.x-cv-pr-img'
    ];
    
    const startTime = Date.now();
    const prList = [];

    while (Date.now() - startTime < timeoutMs) {
      const imgs = DOC.querySelectorAll(selectors.join(', '));
      for (const img of imgs) {
        let src = img.getAttribute('data-src') || img.getAttribute('src') || '';
        if (!src || src.startsWith('data:')) continue;

        // BỘ LỌC KÍCH THƯỚC: Bỏ qua các ảnh icon logo nhỏ (< 300px height hoặc dạng ảnh nằm ngang w/h > 1.8)
        const w = img.naturalWidth || parseInt(img.getAttribute('width') || '0', 10);
        const h = img.naturalHeight || parseInt(img.getAttribute('height') || '0', 10);

        if ((w > 0 && h > 0) && (h < 300 || (w / h) > 1.8)) {
          continue; // Bỏ qua logo nút bấm
        }

        if (src.startsWith('//')) src = 'https:' + src;
        if (!prList.includes(src)) {
          prList.push(src);
        }
      }
      if (prList.length > 0) break;
      await sleep(100);
    }
    return prList;
  }

  async function fetchComiciPages() {
    if (state.cachedPages && state.cachedPages.length > 0) {
      return state.cachedPages;
    }

    const el = DOC.getElementById('comici-viewer') || DOC.querySelector('[data-comici-viewer-id]');
    if (!el) {
      throw new Error("Chưa nạp viewer.");
    }

    const viewerId = el.getAttribute('data-comici-viewer-id');
    if (!viewerId) {
      throw new Error("Chưa có ID viewer.");
    }

    const contentId = el.getAttribute('data-content-id') || '';
    const contentParam = contentId ? `&contentId=${encodeURIComponent(contentId)}` : '';

    // BƯỚC 1: Gọi API Init
    const initUrl = `${WIN.location.origin}/api/book/contentsInfo?user-id=&comici-viewer-id=${viewerId}&page-from=0&page-to=1${contentParam}`;

    const initRes = await new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: initUrl,
        headers: { "Accept": "application/json" },
        onload: r => {
          if (r.status === 200) {
            try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(e); }
          } else {
            reject(new Error(`API Init HTTP ${r.status}`));
          }
        },
        onerror: () => reject(new Error("Lỗi kết nối API"))
      });
    });

    if (!initRes || typeof initRes.totalPages !== 'number') {
      throw new Error("Không lấy được tổng số trang.");
    }

    const totalPages = initRes.totalPages;

    // BƯỚC 2: Gọi API Full lấy toàn bộ danh sách trang
    const fullUrl = `${WIN.location.origin}/api/book/contentsInfo?user-id=&comici-viewer-id=${viewerId}&page-from=0&page-to=${totalPages}${contentParam}`;

    const fullRes = await new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: fullUrl,
        headers: { "Accept": "application/json" },
        onload: r => {
          if (r.status === 200) {
            try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(e); }
          } else {
            reject(new Error(`API Full HTTP ${r.status}`));
          }
        },
        onerror: () => reject(new Error("Lỗi mạng API Full"))
      });
    });

    if (!fullRes || !Array.isArray(fullRes.result)) {
      throw new Error("API lỗi dữ liệu trang.");
    }

    const resultPages = [];
    let prCount = 0;
    let mainPageNo = 1;

    // 1. Quét LẤY TẤT CẢ Ảnh PR / Quảng cáo toàn trang từ DOM
    const prSrcs = await getAllPrImages(400);
    for (const prSrc of prSrcs) {
      prCount++;
      resultPages.push({
        isPR: true,
        prNo: prCount,
        url: prSrc,
        scramble: null
      });
    }

    // 2. Nạp các trang truyện chính từ API (Đánh số từ 1, 2, 3...)
    for (let i = 0; i < fullRes.result.length; i++) {
      const item = fullRes.result[i];
      let imgUrl = item.imageUrl || item.src || item.url;
      if (!imgUrl) continue;
      if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;

      // Tránh lặp trang PR đã bắt từ DOM
      const alreadyInPR = prSrcs.some(ps => imgUrl.includes(ps.split('?')[0]));
      if (alreadyInPR) continue;

      let scramble = item.scramble || item.scramble_key || item.scrambleKey;
      if (typeof scramble === 'string') {
        try { scramble = JSON.parse(scramble); } catch (e) { scramble = null; }
      }

      resultPages.push({
        isPR: false,
        pageNo: mainPageNo++, // Luôn xuất phát từ trang 1
        url: imgUrl,
        scramble: scramble
      });
    }

    // Đánh dấu thuộc tính singlePR nếu chỉ có đúng 1 ảnh PR
    resultPages.forEach(p => {
      if (p.isPR) {
        p.singlePR = (prCount === 1);
      }
    });

    state.cachedPages = resultPages;
    return resultPages;
  }

  function fetchImageBlob(url) {
    return new Promise((resolve, reject) => {
      let fullUrl = url;
      if (fullUrl.startsWith('//')) fullUrl = 'https:' + fullUrl;

      GM_xmlhttpRequest({
        method: "GET",
        url: fullUrl,
        headers: {
          "Referer": WIN.location.href,
          "Origin": WIN.location.origin,
          "User-Agent": WIN.navigator.userAgent,
          "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
        },
        responseType: "blob",
        timeout: 25000,
        onload: res => {
          if (res.status >= 200 && res.status < 300 && res.response && res.response.size > 0) {
            resolve(res.response);
          } else {
            reject(new Error(`HTTP ${res.status}`));
          }
        },
        onerror: () => reject(new Error("Lỗi tải ảnh")),
        ontimeout: () => reject(new Error("Timeout tải ảnh"))
      });
    });
  }

  /* =========================================================================
   * 3. THUẬT TOÁN GIẢI MÃ MA TRẬN 4x4
   * ========================================================================= */
  async function unscrambleComiciBlob(rawBlob, scrambleArray, isJpg) {
    const objUrl = WIN.URL.createObjectURL(rawBlob);
    const img = new WIN.Image();
    img.decoding = "async";

    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("Lỗi nạp ảnh"));
      img.src = objUrl;
    });
    WIN.URL.revokeObjectURL(objUrl);

    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;

    const canvas = DOC.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: !isJpg });

    if (isJpg) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
    }

    const cellWidth = Math.floor(width / 4);
    const cellHeight = Math.floor(height / 4);

    if (!scrambleArray || !Array.isArray(scrambleArray) || scrambleArray.length < 16) {
      ctx.drawImage(img, 0, 0, width, height, 0, 0, width, height);
    } else {
      const pos = [];
      for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
          pos.push([col, row]);
        }
      }

      const v = scrambleArray.map(idx => pos[idx]);

      let f = 0;
      for (let p = 0; p < 4; p++) {
        for (let h = 0; h < 4; h++) {
          if (v[f]) {
            const srcCol = v[f][0];
            const srcRow = v[f][1];

            ctx.drawImage(
              img,
              srcCol * cellWidth, srcRow * cellHeight, cellWidth, cellHeight,
              p * cellWidth, h * cellHeight, cellWidth, cellHeight
            );
          }
          f++;
        }
      }
    }

    const mimeType = isJpg ? 'image/jpeg' : 'image/png';
    const quality = isJpg ? 0.95 : undefined;

    const blob = await new Promise(resolve => canvas.toBlob(resolve, mimeType, quality));

    canvas.width = 0;
    canvas.height = 0;

    const buffer = await blob.arrayBuffer();

    return {
      uint8Array: new Uint8Array(buffer),
      ext: isJpg ? 'jpg' : 'png'
    };
  }

  /* =========================================================================
   * 4. TIẾN TRÌNH TẢI SONG SONG
   * ========================================================================= */
  async function runParallelQueue(tasks, limit, onProgress) {
    const results = new Array(tasks.length);
    let completed = 0;
    let index = 0;

    const workers = Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
      while (index < tasks.length) {
        const currentIndex = index++;
        try {
          results[currentIndex] = await tasks[currentIndex]();
        } catch (err) {
          console.error(`[comici-dl] Lỗi trang ${currentIndex + 1}:`, err);
          results[currentIndex] = null;
        } finally {
          completed++;
          onProgress(completed, tasks.length);
        }
      }
    });

    await Promise.all(workers);
    return results;
  }

  function triggerDownload(blob, fileName) {
    const url = WIN.URL.createObjectURL(blob);
    const a = DOC.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = "noopener";
    a.style.display = "none";
    DOC.documentElement.appendChild(a);
    a.click();
    a.remove();
    WIN.setTimeout(() => WIN.URL.revokeObjectURL(url), 60000);
  }

  function updateProgressUI(data = {}) {
    const total = Number.isFinite(data.total) ? data.total : state.lastProgress.total;
    const completed = Number.isFinite(data.completed) ? data.completed : state.lastProgress.completed;
    const pct = total > 0 ? Math.max(0, Math.min(100, Math.round(completed / total * 100))) : 0;

    state.lastProgress = {
      completed,
      total,
      percent: pct,
      status: data.status || state.lastProgress.status
    };

    const ui = state.ui;
    if (!ui) return;

    ui.count.textContent = completed + '/' + total;
    ui.percent.textContent = pct + '%';
    ui.fill.style.transform = "scaleX(" + pct / 100 + ')';
    ui.status.textContent = state.lastProgress.status;
  }

  function setUiBusy(isBusy) {
    const ui = state.ui;
    if (!ui) return;
    ui.button.disabled = Boolean(isBusy);
    ui.button.textContent = isBusy ? "Đang xử lý..." : "Download";
    ui.button.style.opacity = isBusy ? "0.72" : '1';
    ui.button.style.cursor = isBusy ? "progress" : "pointer";
    ui.jpgInput.disabled = Boolean(isBusy);
  }

  /* =========================================================================
   * 5. CHƯƠNG TRÌNH CHÍNH
   * ========================================================================= */
  async function startDownload() {
    state.running = true;
    setUiBusy(true);

    try {
      updateProgressUI({ completed: 0, total: 0, status: "Đang tải dữ liệu..." });

      const pages = await fetchComiciPages();
      const totalPages = pages.length;

      if (!totalPages) {
        throw new Error("Không tìm thấy trang truyện.");
      }

      const useJpeg = Boolean(state.convertJpeg);
      const zip = new PureZipWriter();
      const episodeId = getEpisodeId();

      zip.addFile(`${episodeId}.txt`, new Uint8Array(0));

      updateProgressUI({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map((pageObj) => async () => {
        const rawBlob = await fetchImageBlob(pageObj.url);

        // Ảnh PR / Bìa / Quảng cáo: Giữ nguyên 100% định dạng gốc, không qua Canvas
        if (pageObj.isPR) {
          let ext = getExtensionFromUrl(pageObj.url);
          if (!ext && rawBlob.type) {
            ext = rawBlob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
          }
          const arrayBuffer = await rawBlob.arrayBuffer();
          const fileName = pageObj.singlePR ? `PR.${ext}` : `PR_${pageObj.prNo}.${ext}`;
          return {
            fileName: fileName,
            data: new Uint8Array(arrayBuffer)
          };
        }

        // Trang truyện chính (1.png, 2.png...): LUÔN GIẢI MÃ MA TRẬN 4x4
        const decoded = await unscrambleComiciBlob(rawBlob, pageObj.scramble, useJpeg);
        return {
          fileName: `${pageObj.pageNo}.${decoded.ext}`,
          data: decoded.uint8Array
        };
      });

      const results = await runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        updateProgressUI({
          completed,
          total,
          status: "Đang tải..."
        });
      });

      updateProgressUI({ completed: totalPages, total: totalPages, status: "Đang đóng gói ZIP..." });
      await sleep(50);

      let savedCount = 0;
      for (const res of results) {
        if (res && res.data && res.data.length > 0) {
          zip.addFile(res.fileName, res.data);
          savedCount++;
        }
      }

      if (savedCount === 0) {
        throw new Error("Lỗi đưa ảnh vào ZIP.");
      }

      const zipBlob = zip.generateBlob();
      const zipFileName = `${getCleanTitle()}.zip`;
      triggerDownload(zipBlob, zipFileName);

      updateProgressUI({ completed: totalPages, total: totalPages, status: `Hoàn tất!` });
    } catch (err) {
      const msg = err?.message || String(err);
      updateProgressUI({ status: "Lỗi: " + msg });
      console.error("[comici-dl] Error:", err);
    } finally {
      state.running = false;
      setUiBusy(false);
      updateProgressUI(state.lastProgress);
    }
  }

  /* =========================================================================
   * 6. GIAO DIỆN UI
   * ========================================================================= */
  function createUI() {
    if (state.ui) return;

    const panel = DOC.createElement("div");
    panel.id = "comici-dl-panel";

    panel.style.cssText = [
      "all:initial",
      "position:fixed",
      "right:0px",
      "top:62px",
      "z-index:2147483647",
      "box-sizing:border-box",
      "width:220px",
      "padding:10px 14px",
      "border:1px solid #059669",
      "border-radius:10px",
      "background:#064e3b",
      "color:#ffffff",
      "font:12px/1.3 system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif",
      "user-select:none",
      "box-shadow:0 8px 24px rgba(0,0,0,0.85)",
      "display:none"
    ].join(';');

    const title = DOC.createElement("div");
    title.textContent = "Comici+ Downloader";
    title.style.cssText = "all:initial;display:block;color:#34d399;font:800 13px system-ui;margin-bottom:8px;text-align:center;";

    const btn = DOC.createElement("button");
    btn.type = "button";
    btn.textContent = "Download";
    btn.style.cssText = [
      "all:initial",
      "display:block",
      "box-sizing:border-box",
      "width:100%",
      "padding:8px 0",
      "border:0",
      "border-radius:6px",
      "background:#10b981",
      "color:#ffffff",
      "font:700 14px/1.2 system-ui,sans-serif",
      "text-align:center",
      "cursor:pointer",
      "box-shadow:0 3px 10px rgba(16, 185, 129, 0.3)"
    ].join(';');

    btn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      startDownload();
    });

    const label = DOC.createElement("label");
    label.style.cssText = "all:initial;display:inline-flex;align-items:center;gap:6px;margin-top:8px;color:#d1d8eb;font:700 11px system-ui;cursor:pointer;";

    const jpgInput = DOC.createElement("input");
    jpgInput.type = "checkbox";
    jpgInput.checked = state.convertJpeg;
    jpgInput.style.cssText = "all:initial;appearance:auto;width:14px;height:14px;accent-color:#10b981;cursor:pointer;";
    jpgInput.addEventListener("change", e => {
      state.convertJpeg = jpgInput.checked;
      saveJpegPref(state.convertJpeg);
    });

    const spanJpg = DOC.createElement("span");
    spanJpg.textContent = "Xuất file JPG (mặc định PNG)";
    spanJpg.style.cssText = "all:initial;color:#d1d8eb;font:700 11px system-ui;";
    label.append(jpgInput, spanJpg);

    const progressRow = DOC.createElement("div");
    progressRow.style.cssText = "all:initial;display:flex;justify-content:space-between;align-items:center;margin-top:10px;color:#ffffff;font:800 12px system-ui;";

    const countText = DOC.createElement("span");
    countText.textContent = "0/0";
    countText.style.cssText = "all:initial;color:#ffffff;font:800 12px system-ui;";

    const percentText = DOC.createElement("span");
    percentText.textContent = "0%";
    percentText.style.cssText = "all:initial;color:#ffffff;font:800 12px system-ui;";

    progressRow.append(countText, percentText);

    const track = DOC.createElement("div");
    track.style.cssText = "all:initial;display:block;height:6px;overflow:hidden;border-radius:3px;background:#065f46;margin-top:6px;";

    const fill = DOC.createElement("div");
    fill.style.cssText = "all:initial;display:block;width:100%;height:100%;background:#34d399;transform:scaleX(0);transform-origin:left center;transition:transform .22s ease;";
    track.appendChild(fill);

    const statusText = DOC.createElement("div");
    statusText.textContent = state.lastProgress.status;
    statusText.style.cssText = "all:initial;display:block;margin-top:8px;color:#a7f3d0;font:11px system-ui;word-break:break-word;";

    panel.append(title, btn, label, progressRow, track, statusText);

    const attachUI = () => {
      if (DOC.body && !DOC.getElementById("comici-dl-panel")) {
        DOC.body.appendChild(panel);
      }
    };
    attachUI();

    state.ui = {
      panel,
      button: btn,
      jpgInput,
      count: countText,
      percent: percentText,
      fill,
      status: statusText
    };

    updateProgressUI(state.lastProgress);
  }

  /* =========================================================================
   * 7. BỘ LẮNG NGHE CHUYỂN CHAP TỰ ĐỘNG
   * ========================================================================= */
  function initRouteWatcher() {
    let lastUrl = WIN.location.href;

    const onUrlChange = () => {
      const currentUrl = WIN.location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;

        state.cachedPages = [];
        state.running = false;
        setUiBusy(false);

        boot();
      }
    };

    const origPush = WIN.history.pushState;
    WIN.history.pushState = function(...args) {
      origPush.apply(this, args);
      onUrlChange();
    };

    const origReplace = WIN.history.replaceState;
    WIN.history.replaceState = function(...args) {
      origReplace.apply(this, args);
      onUrlChange();
    };

    WIN.addEventListener("popstate", onUrlChange);
    WIN.addEventListener("hashchange", onUrlChange);
    WIN.setInterval(onUrlChange, 600);
  }

  async function boot() {
    while (!DOC.body) {
      await sleep(100);
    }
    createUI();

    if (!isEpisodeUrl()) {
      if (state.ui && state.ui.panel) {
        state.ui.panel.style.display = "none";
      }
      return;
    }

    if (state.ui && state.ui.panel) {
      state.ui.panel.style.display = "block";
    }

    updateProgressUI({ completed: 0, total: 0, status: "Đang kiểm tra trang..." });

    let pages = [];
    let retries = 0;
    let lastError = null;

    while (retries < 25) {
      if (!isEpisodeUrl()) return;
      try {
        pages = await fetchComiciPages();
        if (pages.length > 0) break;
      } catch (e) {
        lastError = e;
      }
      await sleep(200);
      retries++;
    }

    if (pages.length > 0 && isEpisodeUrl()) {
      updateProgressUI({
        completed: 0,
        total: pages.length,
        status: "Sẵn sàng."
      });
    } else if (isEpisodeUrl()) {
      updateProgressUI({
        completed: 0,
        total: 0,
        status: lastError ? `${lastError.message || lastError}` : "Không nạp được trang."
      });
    }
  }

  initRouteWatcher();

  if (DOC.readyState === "loading") {
    DOC.addEventListener("DOMContentLoaded", () => boot());
  } else {
    boot();
  }
})();