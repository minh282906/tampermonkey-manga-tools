// ==UserScript==
// @name         GigaViewer Universal Downloader
// @version      1.1
// @icon         https://files.catbox.moe/tpd5zq.png
// @description  Tải truyện từ hơn 20 trang web GigaViewer & Shonen Jump Rookie (ShonenJump+, Tonari no Young Jump, Jump Rookie, Sunday Webry, Comic Days, Kurage Bunch, MAGCOMI, Comic Gardo, Comic Zenon, Web Action, Comic Trail, Feel Web, Comic Earth Star, Comic Border, COMIC OGYAAA!!, Comic Seasons, COMIC Y-OURS, Ichicomi, Manga Time Square, OUR FEEL, HERO'S Web), nén ZIP tên truyện, lưu ảnh theo thứ tự và tự động xuất file txt lưu mã truyện.
// @author       anonymous & AI
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      *.comic-action.com
// @connect      *.comic-days.com
// @connect      *.comic-earthstar.com
// @connect      *.comic-gardo.com
// @connect      *.comic-ogyaaa.com
// @connect      *.comic-seasons.com
// @connect      *.comic-trail.com
// @connect      *.comic-y-ours.com
// @connect      *.comic-zenon.com
// @connect      *.comicborder.com
// @connect      *.feelweb.jp
// @connect      *.ichicomi.com
// @connect      *.kuragebunch.com
// @connect      *.magcomi.com
// @connect      *.mangatime-square.com
// @connect      *.ourfeel.jp
// @connect      *.shonenjumpplus.com
// @connect      *.tonarinoyj.jp
// @connect      *.sunday-webry.com
// @connect      rookie.shonenjump.com
// @connect      cdn-img.rookie.shonenjump.com

// @match        https://comic-action.com/*
// @match        https://comic-days.com/*
// @match        https://comic-earthstar.com/*
// @match        https://comic-gardo.com/*
// @match        https://comic-ogyaaa.com/*
// @match        https://comic-seasons.com/*
// @match        https://comic-trail.com/*
// @match        https://comic-y-ours.com/*
// @match        https://comic-zenon.com/*
// @match        https://comicborder.com/*
// @match        https://feelweb.jp/*
// @match        https://ichicomi.com/*
// @match        https://kuragebunch.com/*
// @match        https://magcomi.com/*
// @match        https://mangatime-square.com/*
// @match        https://ourfeel.jp/*
// @match        https://shonenjumpplus.com/*
// @match        https://tonarinoyj.jp/*
// @match        https://www.sunday-webry.com/*
// @match        https://rookie.shonenjump.com/series/*
// ==/UserScript==

(function gigaViewerUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG GIGAVIEWER
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 4, // Số lượng trang tải song song tối ưu
    DIVIDE_NUM: 4,     // Thuật toán ma trận 4x4
    MULTIPLE: 8,       // Bội số ô vuông 8px
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
    convertJpeg: localStorage.getItem("giga-dl:convert-jpeg") === '1',
    ui: null,
    lastProgress: { completed: 0, total: 0, percent: 0, status: "Đang kiểm tra..." }
  };

  const isRookie = WIN.location.hostname === 'rookie.shonenjump.com';

  function isEpisodeUrl() {
    if (isRookie) {
      return /\/series\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+/.test(WIN.location.pathname);
    }
    return /\/episode\/\d+/.test(WIN.location.pathname);
  }

  function saveJpegPref(val) {
    try {
      WIN.localStorage.setItem("giga-dl:convert-jpeg", val ? '1' : '0');
    } catch {}
  }

  function getEpisodeId() {
    try {
      if (isRookie) {
        const match = WIN.location.pathname.match(/\/series\/[a-zA-Z0-9_-]+\/([a-zA-Z0-9_-]+)/);
        if (match && match[1]) return match[1];
        const sec = DOC.querySelector('section[data-episode-id]');
        if (sec) {
          const epId = sec.getAttribute('data-episode-id');
          if (epId) return epId;
        }
        return "Rookie_Episode";
      }

      const match = WIN.location.pathname.match(/\/episode\/(\d+)/);
      if (match && match[1]) return match[1];
    } catch (e) {}
    return "GigaViewer_Episode";
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

  function getParsedEpisodeJson() {
    try {
      const el = DOC.getElementById('episode-json');
      if (!el) return null;

      let raw = el.getAttribute('data-value') || el.textContent || '';
      if (raw.includes('&quot;') || raw.includes('&amp;')) {
        const txt = DOC.createElement('textarea');
        txt.innerHTML = raw;
        raw = txt.value;
      }
      return JSON.parse(raw);
    } catch (e) {
      console.error("[giga-dl] JSON Parse Error:", e);
      return null;
    }
  }

  // TẠO TÊN FILE ZIP CHUẨN: "Tên Truyện - Tên Chap"
  function getCleanMangaTitle() {
    try {
      let seriesTitle = "";
      let episodeTitle = "";

      if (isRookie) {
        const sEl = DOC.querySelector('.series-title, .header-series-title, [class*="series-title"], .js-series-title');
        if (sEl) seriesTitle = sEl.textContent.trim();

        const eEl = DOC.querySelector('.episode-title, .header-episode-title, [class*="episode-title"], .js-episode-title');
        if (eEl) episodeTitle = eEl.textContent.trim();

        if ((!seriesTitle || !episodeTitle) && DOC.title) {
          let raw = DOC.title.replace(/\s*[-|｜]\s*ジャンプルーキー！.*/i, '').trim();
          const parts = raw.split(/[/\-|｜・]/);
          if (parts.length >= 2) {
            if (!episodeTitle) episodeTitle = parts[0].trim();
            if (!seriesTitle) seriesTitle = parts[1].trim();
          } else if (raw) {
            if (!seriesTitle) seriesTitle = raw;
          }
        }
      } else {
        const json = getParsedEpisodeJson();
        if (json) {
          const ep = json.readableProduct || json.episode || {};
          const series = json.series || ep.series || {};
          seriesTitle = series.title || series.name || "";
          episodeTitle = ep.title || ep.name || "";
        }

        if (!seriesTitle) {
          const sEl = DOC.querySelector('.series-header-title, .series-title, [class*="series-title"], .series-title-text');
          if (sEl) seriesTitle = sEl.textContent.trim();
        }

        if (!episodeTitle) {
          const eEl = DOC.querySelector('.episode-header-title, .episode-title, [class*="episode-title"], .episode-header-title-text');
          if (eEl) episodeTitle = eEl.textContent.trim();
        }

        if ((!seriesTitle || !episodeTitle) && DOC.title) {
          let t = DOC.title.split('｜')[0].split('|')[0].trim();
          const parts = t.split(/[/\-|・]/);
          if (parts.length >= 2) {
            if (!seriesTitle) seriesTitle = parts[0].trim();
            if (!episodeTitle) episodeTitle = parts[1].trim();
          } else if (t) {
            if (!seriesTitle) seriesTitle = t;
          }
        }
      }

      seriesTitle = cleanString(seriesTitle);
      episodeTitle = cleanString(episodeTitle);

      if (seriesTitle && episodeTitle) {
        if (episodeTitle.includes(seriesTitle)) return episodeTitle;
        if (seriesTitle.includes(episodeTitle)) return seriesTitle;
        return `${seriesTitle} - ${episodeTitle}`;
      } else if (seriesTitle) {
        return seriesTitle;
      } else if (episodeTitle) {
        return episodeTitle;
      }
    } catch (e) {}

    return isRookie ? `Rookie_${getEpisodeId()}` : `GigaViewer_${getEpisodeId()}`;
  }

  function getFrontCoverImages() {
    const selectors = [
      '.js-front-link-page .link-slot img',
      '.front-link-page img',
      '.link-slot img',
      '.js-front-link-page img'
    ];
    const imgs = DOC.querySelectorAll(selectors.join(', '));
    const srcList = [];
    for (const img of imgs) {
      let src = img.getAttribute('data-src') || img.getAttribute('src') || '';
      if (src && !src.startsWith('data:')) {
        if (src.startsWith('//')) src = 'https:' + src;
        if (!srcList.includes(src)) srcList.push(src);
      }
    }
    return srcList;
  }

  function getEndAdImages() {
    const selectors = [
      '.js-viewer-end img',
      '.viewer-end img',
      '.last-page img',
      '.js-last-page img',
      '.episode-end img',
      '.end-banner img',
      '.js-back-link-page img',
      '.back-link-page img'
    ];
    const found = [];
    for (const sel of selectors) {
      const imgs = DOC.querySelectorAll(sel);
      for (const img of imgs) {
        let src = img.getAttribute('data-src') || img.getAttribute('src') || '';
        if (src && !src.startsWith('data:') && !found.includes(src)) {
          if (src.startsWith('//')) src = 'https:' + src;
          found.push(src);
        }
      }
    }
    return found;
  }

  /* =========================================================================
   * 3. BÓC TÁCH DANH SÁCH TRANG (GIGAVIEWER & JUMP ROOKIE)
   * ========================================================================= */
  function getEpisodePages() {
    try {
      // -------------------------------------------------------------
      // NHÁNH 1: SHONEN JUMP ROOKIE (Ảnh gốc không bị xáo trộn 4x4)
      // -------------------------------------------------------------
      if (isRookie) {
        const imgEls = Array.from(DOC.querySelectorAll('.js-page-image, .image-container img, .page-area img'));
        const resultPages = [];
        const seenUrls = new Set();
        let pageNo = 1;

        for (const img of imgEls) {
          let src = img.getAttribute('src') || img.getAttribute('data-src') || '';
          if (!src || src.startsWith('data:')) continue;
          if (src.startsWith('//')) src = 'https:' + src;

          if (img.closest('#page-favorite-ad-area, .js-ad-area, .js-back-matter-area')) continue;

          if (!seenUrls.has(src)) {
            seenUrls.add(src);
            resultPages.push({
              isPR: false,
              isRaw: true, // Jump Rookie là ảnh gốc, bỏ qua Canvas giải mã
              pageNo: pageNo++,
              src: src
            });
          }
        }
        return resultPages;
      }

      // -------------------------------------------------------------
      // NHÁNH 2: GIGAVIEWER THƯƠNG MẠI (Giải mã ma trận 4x4)
      // -------------------------------------------------------------
      const json = getParsedEpisodeJson();
      if (!json) return [];
      const rawPages = json?.readableProduct?.pageStructure?.pages || json?.pageStructure?.pages || [];

      const resultPages = [];
      let prCount = 0;
      let mainPageNo = 1;

      // 1. Ảnh Bìa Mở Đầu từ DOM
      const frontSrcs = getFrontCoverImages();
      for (const fSrc of frontSrcs) {
        prCount++;
        resultPages.push({
          isPR: true,
          isRaw: true,
          prNo: prCount,
          src: fSrc
        });
      }

      // 2. Trang truyện từ JSON
      for (const p of rawPages) {
        const imgSrc = p.src || p.banner?.src || p.image?.src || p.url || '';
        if (!imgSrc) continue;

        const alreadyInFront = frontSrcs.some(fs => imgSrc.includes(fs.split('?')[0]));
        if (alreadyInFront) continue;

        const isPRType = (p.type && p.type !== 'main') || imgSrc.includes('/link-slot/') || imgSrc.includes('/public/link-slot-series/') || imgSrc.includes('/banner/');

        if (isPRType) {
          prCount++;
          resultPages.push({
            isPR: true,
            isRaw: true,
            prNo: prCount,
            src: imgSrc
          });
        } else {
          resultPages.push({
            isPR: false,
            isRaw: false,
            pageNo: mainPageNo++,
            src: imgSrc
          });
        }
      }

      // 3. Ảnh Quảng Cáo Cuối từ DOM
      const endAdSrcs = getEndAdImages();
      for (const adSrc of endAdSrcs) {
        const alreadyAdded = resultPages.some(item => item.src.includes(adSrc.split('?')[0]));
        if (!alreadyAdded) {
          prCount++;
          resultPages.push({
            isPR: true,
            isRaw: true,
            prNo: prCount,
            src: adSrc
          });
        }
      }

      resultPages.forEach(p => {
        if (p.isPR) p.singlePR = (prCount === 1);
      });

      return resultPages;
    } catch (e) {
      return [];
    }
  }

  function fetchImageBlob(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === "function") {
        GM_xmlhttpRequest({
          method: "GET",
          url: url,
          responseType: "blob",
          timeout: 25000,
          onload: res => {
            if (res.status >= 200 && res.status < 300 && res.response) {
              resolve(res.response);
            } else {
              reject(new Error(`HTTP ${res.status}.`));
            }
          },
          onerror: () => reject(new Error("Lỗi mạng.")),
          ontimeout: () => reject(new Error("Timeout tải ảnh."))
        });
        return;
      }

      fetch(url, { credentials: "include" })
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}.`);
          return res.blob();
        })
        .then(resolve)
        .catch(reject);
    });
  }

  /* =========================================================================
   * 4. THUẬT TOÁN GIẢI MÃ MA TRẬN CHUYỂN VỊ (MATRIX TRANSPOSE 4x4)
   * ========================================================================= */
  async function unscrambleBlob(rawBlob, isJpg) {
    const objUrl = WIN.URL.createObjectURL(rawBlob);
    const img = new WIN.Image();
    img.decoding = "async";

    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("Lỗi nạp ảnh."));
      img.src = objUrl;
    });
    WIN.URL.revokeObjectURL(objUrl);

    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;

    const canvas = DOC.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    const cellWidth = Math.floor(width / (CONFIG.DIVIDE_NUM * CONFIG.MULTIPLE)) * CONFIG.MULTIPLE;
    const cellHeight = Math.floor(height / (CONFIG.DIVIDE_NUM * CONFIG.MULTIPLE)) * CONFIG.MULTIPLE;

    for (let e = 0; e < CONFIG.DIVIDE_NUM * CONFIG.DIVIDE_NUM; e++) {
      const srcRow = Math.floor(e / CONFIG.DIVIDE_NUM);
      const srcCol = e % CONFIG.DIVIDE_NUM;

      const sx = srcCol * cellWidth;
      const sy = srcRow * cellHeight;

      const dx = srcRow * cellWidth;
      const dy = srcCol * cellHeight;

      ctx.drawImage(
        img,
        sx, sy, cellWidth, cellHeight,
        dx, dy, cellWidth, cellHeight
      );
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
   * 5. TIẾN TRÌNH TẢI SONG SONG
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
          console.error(`[giga-dl] Lỗi trang ${currentIndex + 1}:`, err);
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

  /* =========================================================================
   * 6. GIAO DIỆN UI (TÔNG MÀU ĐỎ SAN HÔ GIGAVIEWER #eb544b)
   * ========================================================================= */
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

    ui.count.textContent = total ? Math.min(completed, total) + '/' + total : "0/0";
    ui.percent.textContent = pct + '%';
    ui.fill.style.transform = "scaleX(" + (total > 0 ? pct / 100 : 0) + ')';
    ui.status.textContent = state.lastProgress.status;
  }

  function setUiBusy(isBusy) {
    const ui = state.ui;
    if (!ui) return;
    ui.button.disabled = Boolean(isBusy);
    ui.button.textContent = "Download";
    ui.button.style.opacity = isBusy ? "0.72" : '1';
    ui.button.style.cursor = isBusy ? "progress" : "pointer";
    ui.jpgInput.disabled = Boolean(isBusy);
  }

  function createUI() {
    if (state.ui || !DOC.body || DOC.getElementById("giga-dl-panel")) return;

    const PANEL_WIDTH = 220;
    const TAB_WIDTH = 14;
    let isCollapsed = localStorage.getItem("giga-dl:collapsed") === '1';

    const panel = DOC.createElement("div");
    panel.id = "giga-dl-panel";
    panel.style.cssText = [
      "all:initial",
      "position:fixed",
      "right:0px",
      "top:90px",
      "z-index:2147483647",
      "box-sizing:border-box",
      `width:${PANEL_WIDTH}px`,
      "padding:10px 14px",
      "border:1px solid #eb544b",
      "border-right:none",
      "border-radius:12px 0 0 12px",
      "background:#1c0d0e",
      "color:#ffffff",
      "font:12px/1.3 system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif",
      "user-select:none",
      "box-shadow:0 8px 24px rgba(0,0,0,0.85)",
      "transition:transform 0.22s cubic-bezier(0.16, 1, 0.3, 1)",
      `transform:${isCollapsed ? `translateX(calc(100% - ${TAB_WIDTH}px))` : "translateX(0)"}`,
      "display:block",
      "overflow:hidden"
    ].join(';');

    const collapsedStrip = DOC.createElement("div");
    collapsedStrip.style.cssText = [
      "all:initial",
      "position:absolute",
      "left:0px",
      "top:0px",
      `width:${TAB_WIDTH}px`,
      "height:100%",
      "background:#eb544b",
      "cursor:pointer",
      "transition:opacity 0.15s, background 0.15s",
      `opacity:${isCollapsed ? "1" : "0"}`,
      `pointer-events:${isCollapsed ? "auto" : "none"}`
    ].join(';');
    collapsedStrip.title = "Mở bảng tải";
    collapsedStrip.onmouseenter = () => { collapsedStrip.style.background = "#f0645c"; };
    collapsedStrip.onmouseleave = () => { collapsedStrip.style.background = "#eb544b"; };

    const mainContent = DOC.createElement("div");
    mainContent.style.cssText = [
      "all:initial",
      "display:block",
      "transition:opacity 0.2s",
      `opacity:${isCollapsed ? "0" : "1"}`,
      `pointer-events:${isCollapsed ? "none" : "auto"}`
    ].join(';');

    const collapseBtn = DOC.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.textContent = "▶";
    collapseBtn.title = "Thu gọn";
    collapseBtn.style.cssText = [
      "all:initial",
      "position:absolute",
      "left:0px",
      "top:0px",
      "width:24px",
      "height:24px",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "border-radius:12px 0 8px 0",
      "background:#eb544b",
      "color:#ffffff",
      "font:900 10px system-ui,sans-serif",
      "cursor:pointer",
      "transition:background 0.15s ease",
      "z-index:2"
    ].join(';');
    collapseBtn.onmouseenter = () => { collapseBtn.style.background = "#f0645c"; };
    collapseBtn.onmouseleave = () => { collapseBtn.style.background = "#eb544b"; };

    const title = DOC.createElement("div");
    title.textContent = isRookie ? "JumpRookie Downloader" : "GigaViewer Downloader";
    title.style.cssText = "all:initial;display:block;color:#fca5a5;font:800 13px system-ui;margin-bottom:8px;text-align:center;padding-left:14px;";

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
      "background:#eb544b",
      "color:#ffffff",
      "font:800 14px/1.2 system-ui,sans-serif",
      "text-align:center",
      "cursor:pointer",
      "box-shadow:0 3px 10px rgba(235, 84, 75, 0.35)"
    ].join(';');

    btn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      if (!state.running) startDownload();
    });

    const label = DOC.createElement("label");
    label.style.cssText = "all:initial;display:inline-flex;align-items:center;gap:6px;margin-top:8px;color:#fecaca;font:700 11px system-ui;cursor:pointer;";

    const jpgInput = DOC.createElement("input");
    jpgInput.type = "checkbox";
    jpgInput.checked = state.convertJpeg;
    jpgInput.style.cssText = "all:initial;appearance:auto;width:14px;height:14px;accent-color:#eb544b;cursor:pointer;";
    jpgInput.addEventListener("change", e => {
      e.stopPropagation();
      state.convertJpeg = jpgInput.checked;
      saveJpegPref(state.convertJpeg);
    });

    const spanJpg = DOC.createElement("span");
    spanJpg.textContent = "Xuất file JPG (mặc định PNG)";
    spanJpg.style.cssText = "all:initial;color:#fecaca;font:700 11px system-ui;";
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
    track.style.cssText = "all:initial;display:block;height:6px;overflow:hidden;border-radius:3px;background:#451a1a;margin-top:6px;";

    const fill = DOC.createElement("div");
    fill.style.cssText = "all:initial;display:block;width:100%;height:100%;background:#f87171;transform:scaleX(0);transform-origin:left center;transition:transform .22s ease;";
    track.appendChild(fill);

    const statusText = DOC.createElement("div");
    statusText.textContent = state.lastProgress.status;
    statusText.style.cssText = "all:initial;display:block;margin-top:8px;color:#fecaca;font:11px system-ui;word-break:break-word;";

    mainContent.append(collapseBtn, title, btn, label, progressRow, track, statusText);
    panel.append(collapsedStrip, mainContent);

    function setCollapsedState(collapsed) {
      isCollapsed = collapsed;
      localStorage.setItem("giga-dl:collapsed", isCollapsed ? '1' : '0');

      panel.style.transform = isCollapsed ? `translateX(calc(100% - ${TAB_WIDTH}px))` : "translateX(0)";
      collapsedStrip.style.opacity = isCollapsed ? "1" : "0";
      collapsedStrip.style.pointerEvents = isCollapsed ? "auto" : "none";
      mainContent.style.opacity = isCollapsed ? "0" : "1";
      mainContent.style.pointerEvents = isCollapsed ? "none" : "auto";
    }

    collapseBtn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      setCollapsedState(true);
    });

    panel.addEventListener("click", () => {
      if (isCollapsed) setCollapsedState(false);
    });

    DOC.body.appendChild(panel);

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
   * 7. CHƯƠNG TRÌNH TẢI CHÍNH
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    state.running = true;
    setUiBusy(true);

    try {
      updateProgressUI({ completed: 0, total: 0, status: "Đang tải..." });

      const epPages = getEpisodePages();
      const totalPages = epPages.length;

      if (!totalPages) {
        throw new Error("Không tìm thấy trang truyện.");
      }

      const useJpeg = Boolean(state.convertJpeg);
      const zip = new PureZipWriter();
      const episodeId = getEpisodeId();

      zip.addFile(`${episodeId}.txt`, new Uint8Array(0));

      updateProgressUI({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = epPages.map((pageObj) => async () => {
        const rawBlob = await fetchImageBlob(pageObj.src);

        // Ảnh gốc / Ảnh PR / Jump Rookie: Giữ nguyên 100% byte gốc từ CDN
        if (pageObj.isRaw || pageObj.isPR) {
          let ext = getExtensionFromUrl(pageObj.src);
          if (!ext && rawBlob.type) {
            ext = rawBlob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
          }
          const arrayBuffer = await rawBlob.arrayBuffer();
          const fileName = pageObj.singlePR ? `PR.${ext}` : (pageObj.isPR ? `PR_${pageObj.prNo}.${ext}` : `${pageObj.pageNo}.${ext}`);
          return {
            fileName: fileName,
            data: new Uint8Array(arrayBuffer)
          };
        }

        // Trang truyện GigaViewer chuẩn: Giải mã ma trận 4x4
        const decoded = await unscrambleBlob(rawBlob, useJpeg);
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

      updateProgressUI({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      let savedCount = 0;
      for (const res of results) {
        if (res && res.data) {
          zip.addFile(res.fileName, res.data);
          savedCount++;
        }
      }

      if (savedCount === 0) {
        throw new Error("Lỗi đưa ảnh vào file ZIP.");
      }

      const zipBlob = zip.generateBlob();
      const zipFileName = `${getCleanMangaTitle()}.zip`;
      triggerDownload(zipBlob, zipFileName);

      updateProgressUI({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      const msg = err?.message || String(err);
      updateProgressUI({ status: "Lỗi: " + msg });
      console.error("[giga-dl] Download failed:", err);
    } finally {
      state.running = false;
      setUiBusy(false);
      updateProgressUI(state.lastProgress);
    }
  }

  /* =========================================================================
   * 8. BỘ LẮNG NGHE CHUYỂN TRANG (SPA ROUTE WATCHER) & BOOT
   * ========================================================================= */
  function initRouteWatcher() {
    let lastUrl = WIN.location.href;

    const onUrlChange = () => {
      const currentUrl = WIN.location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
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
      if (state.ui?.panel) state.ui.panel.style.display = "none";
      return;
    }

    if (state.ui?.panel) state.ui.panel.style.display = "block";

    updateProgressUI({ completed: 0, total: 0, status: "Đang kiểm tra..." });

    let epPages = [];
    let retries = 0;
    while (epPages.length === 0 && retries < 25) {
      if (!isEpisodeUrl()) return;
      await sleep(150);
      epPages = getEpisodePages();
      retries++;
    }

    const total = epPages.length;
    if (total > 0 && isEpisodeUrl()) {
      updateProgressUI({
        completed: 0,
        total: total,
        status: "Sẵn sàng."
      });
    } else if (isEpisodeUrl()) {
      updateProgressUI({
        completed: 0,
        total: 0,
        status: "Đang kiểm tra..."
      });
    }
  }

  initRouteWatcher();

  if (DOC.readyState === "loading") {
    DOC.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();