// ==UserScript==
// @name         GigaViewer Universal Downloader
// @version      1.0
// @icon         https://files.catbox.moe/tpd5zq.png
// @description  Tải truyện từ 20 trang web GigaViewer (ShonenJump+, Tonari no Young Jump, Sunday Webry, Comic Days, Kurage Bunch, MAGCOMI, Comic Gardo, Comic Zenon, Web Action, Comic Trail, Feel Web, Comic Earth Star, Comic Border, COMIC OGYAAA!!, Comic Seasons, COMIC Y-OURS, Ichicomi, Manga Time Square, OUR FEEL, HERO'S Web), nén ZIP tên truyện, lưu ảnh theo thứ tự và tự động xuất file txt lưu mã truyện tương ứng.
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
    convertJpeg: localStorage.getItem("giga-dl:convert-jpeg") === '1',
    ui: null,
    lastProgress: { completed: 0, total: 0, percent: 0, status: "Đang kiểm tra trang..." }
  };

  function isEpisodeUrl() {
    return /\/episode\/\d+/.test(WIN.location.pathname);
  }

  function saveJpegPref(val) {
    try {
      WIN.localStorage.setItem("giga-dl:convert-jpeg", val ? '1' : '0');
    } catch {}
  }

  function getEpisodeId() {
    try {
      const match = WIN.location.pathname.match(/\/episode\/(\d+)/);
      if (match && match[1]) return match[1];
    } catch (e) {}
    return "GigaViewer_Episode";
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
      console.error("[giga-dl] JSON Parse Error", e);
      return null;
    }
  }

  // TẠO TÊN FILE ZIP ĐÚNG ĐỊNH DẠNG: "Tên Truyện - Tên Chap"
  function getCleanMangaTitle() {
    try {
      const json = getParsedEpisodeJson();
      let seriesTitle = "";
      let episodeTitle = "";

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

      seriesTitle = seriesTitle.replace(/[\\/*?:"<>|]/g, '').trim();
      episodeTitle = episodeTitle.replace(/[\\/*?:"<>|]/g, '').trim();

      if (seriesTitle && episodeTitle) {
        return `${seriesTitle} - ${episodeTitle}`;
      } else if (episodeTitle) {
        return episodeTitle;
      } else if (seriesTitle) {
        return seriesTitle;
      }
    } catch (e) {}

    try {
      let t = DOC.title || '';
      t = t.split('｜')[0].split('|')[0].replace(/【[^】]*】/g, '').trim();
      t = t.replace(/[\\/*?:"<>|]/g, '').trim();
      if (t) return t;
    } catch (e) {}

    return `GigaViewer_${getEpisodeId()}`;
  }

  // Quét LẤY TẤT CẢ các trang Bìa Mở Đầu / PR (front-page1, front-page2...) từ DOM
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
        if (!srcList.includes(src)) {
          srcList.push(src);
        }
      }
    }
    return srcList;
  }

  // Quét tìm Ảnh Quảng Cáo/Bìa Cuối Trang từ DOM
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

  // Quét TOÀN BỘ trang ảnh (Tất cả Ảnh PR Mở đầu + Truyện chính + Ảnh PR Cuối)
  function getEpisodePages() {
    try {
      const json = getParsedEpisodeJson();
      if (!json) return [];
      const rawPages = json?.readableProduct?.pageStructure?.pages || json?.pageStructure?.pages || [];
      
      const resultPages = [];
      let prCount = 0;
      let mainPageNo = 1;

      // 1. Quét LẤY TẤT CẢ Ảnh Bìa Mở Đầu từ DOM (front-page1, front-page2...)
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

      // 2. Duyệt từng trang từ JSON
      for (const p of rawPages) {
        const imgSrc = p.src || p.banner?.src || p.image?.src || p.url || '';
        if (!imgSrc) continue;

        // Tránh lặp trang bìa mở đầu đã lấy ở DOM
        const alreadyInFront = frontSrcs.some(fs => imgSrc.includes(fs.split('?')[0]));
        if (alreadyInFront) continue;

        // BẢN CHẤT GIGAVIEWER: Nếu p.type !== 'main' hoặc link-slot/banner -> Là ảnh PR/Quảng cáo
        const isPRType = (p.type && p.type !== 'main') || imgSrc.includes('/link-slot/') || imgSrc.includes('/public/link-slot-series/') || imgSrc.includes('/banner/');

        if (isPRType) {
          prCount++;
          resultPages.push({
            isPR: true,
            isRaw: true, // Ảnh thường không đảo ma trận 4x4
            prNo: prCount,
            src: imgSrc
          });
        } else {
          // BẮT BUỘC LUÔN GIẢI MÃ 4x4 DÀNH CHO TRUYỆN CHÍNH
          resultPages.push({
            isPR: false,
            isRaw: false, // Trang chính mã hóa 4x4
            pageNo: mainPageNo++, // Đánh số trang 1, 2, 3...
            src: imgSrc
          });
        }
      }

      // 3. Quét bổ sung Ảnh Quảng Cáo/Bìa Cuối từ DOM nếu JSON chưa có
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

      // Đánh dấu thuộc tính singlePR nếu chỉ có đúng 1 ảnh PR trong cả tập
      resultPages.forEach(p => {
        if (p.isPR) {
          p.singlePR = (prCount === 1);
        }
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
              reject(new Error(`HTTP ${res.status}`));
            }
          },
          onerror: () => reject(new Error("Lỗi mạng")),
          ontimeout: () => reject(new Error("Timeout"))
        });
        return;
      }

      fetch(url, { credentials: "include" })
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.blob();
        })
        .then(resolve)
        .catch(reject);
    });
  }

  /* =========================================================================
   * 3. THUẬT TOÁN GIẢI MÃ MA TRẬN CHUYỂN VỊ (MATRIX TRANSPOSE 4x4)
   * ========================================================================= */
  async function unscrambleBlob(rawBlob, isJpg) {
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

    // TỐI ƯU: Tắt alpha để xuất 24-bit RGB PNG
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    const cellWidth = Math.floor(width / (CONFIG.DIVIDE_NUM * CONFIG.MULTIPLE)) * CONFIG.MULTIPLE;
    const cellHeight = Math.floor(height / (CONFIG.DIVIDE_NUM * CONFIG.MULTIPLE)) * CONFIG.MULTIPLE;

    // ĐÃ XÓA LỆNH ctx.drawImage(img...) DƯ THỪA Ở ĐÂY

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
          console.error(`Lỗi tải trang ${currentIndex + 1}:`, err);
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
    ui.jpgInput.style.cursor = isBusy ? "default" : "pointer";
  }

  /* =========================================================================
   * 5. CHƯƠNG TRÌNH CHÍNH
   * ========================================================================= */
  async function startDownload() {
    state.running = true;
    setUiBusy(true);

    try {
      updateProgressUI({ completed: 0, total: 0, status: "Đang đọc dữ liệu..." });

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

        // 1. Ảnh PR / Bìa / Quảng cáo: Giữ nguyên định dạng gốc, đặt tên PR.ext hoặc PR_1.ext, PR_2.ext
        if (pageObj.isRaw || pageObj.isPR) {
          let ext = getExtensionFromUrl(pageObj.src);
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

        // 2. Trang truyện chính (1.png, 2.png...): LUÔN GIẢI MÃ MA TRẬN 4x4
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

      updateProgressUI({ completed: totalPages, total: totalPages, status: "Đang đóng gói ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res && res.data) {
          zip.addFile(res.fileName, res.data);
        }
      }

      const zipBlob = zip.generateBlob();
      const zipFileName = `${getCleanMangaTitle()}.zip`;
      triggerDownload(zipBlob, zipFileName);

      updateProgressUI({ completed: totalPages, total: totalPages, status: "Hoàn tất!" });
    } catch (err) {
      const msg = err?.message || String(err);
      updateProgressUI({ status: "Lỗi: " + msg });
      console.error("[giga-dl] Download failed", err);
    } finally {
      state.running = false;
      setUiBusy(false);
      updateProgressUI(state.lastProgress);
    }
  }

  /* =========================================================================
   * 6. GIAO DIỆN UI (TÔNG MÀU XANH INDIGO)
   * ========================================================================= */
  function createUI() {
    if (state.ui || !DOC.body) return;

    const panel = DOC.createElement("div");
    panel.id = "giga-dl-panel";

    panel.style.cssText = [
      "all:initial",
      "position:fixed",
      "right:0px",
      "top:62px",
      "z-index:2147483647",
      "box-sizing:border-box",
      "width:220px",
      "padding:10px 14px",
      "border:1px solid #4338ca",
      "border-radius:10px",
      "background:#0f172a",
      "color:#ffffff",
      "font:12px/1.3 system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif",
      "user-select:none",
      "box-shadow:0 8px 24px rgba(0,0,0,0.85)",
      "display:none"
    ].join(';');

    const title = DOC.createElement("div");
    title.textContent = "GigaViewer Downloader";
    title.style.cssText = "all:initial;display:block;color:#818cf8;font:800 13px system-ui;margin-bottom:8px;text-align:center;";

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
      "background:#6366f1",
      "color:#ffffff",
      "font:700 14px/1.2 system-ui,sans-serif",
      "text-align:center",
      "cursor:pointer",
      "box-shadow:0 3px 10px rgba(99, 102, 241, 0.35)"
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
    jpgInput.style.cssText = "all:initial;appearance:auto;width:14px;height:14px;accent-color:#6366f1;cursor:pointer;";
    jpgInput.addEventListener("change", e => {
      e.stopPropagation();
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
    track.style.cssText = "all:initial;display:block;height:6px;overflow:hidden;border-radius:3px;background:#1e1b4b;margin-top:6px;";

    const fill = DOC.createElement("div");
    fill.style.cssText = "all:initial;display:block;width:100%;height:100%;background:#818cf8;transform:scaleX(0);transform-origin:left center;transition:transform .22s ease;";
    track.appendChild(fill);

    const statusText = DOC.createElement("div");
    statusText.textContent = state.lastProgress.status;
    statusText.style.cssText = "all:initial;display:block;margin-top:8px;color:#c7d2fe;font:11px system-ui;word-break:break-word;";

    panel.append(title, btn, label, progressRow, track, statusText);

    const attachUI = () => {
      if (DOC.body && !DOC.getElementById("giga-dl-panel")) {
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
      track,
      fill,
      status: statusText
    };

    updateProgressUI(state.lastProgress);
  }

  /* =========================================================================
   * 7. BỘ LẮNG NGHE CHUYỂN CHAP TỰ ĐỘNG (SPA ROUTE WATCHER)
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
      if (state.ui && state.ui.panel) {
        state.ui.panel.style.display = "none";
      }
      return;
    }

    if (state.ui && state.ui.panel) {
      state.ui.panel.style.display = "block";
    }

    updateProgressUI({ completed: 0, total: 0, status: "Đang kiểm tra trang..." });

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
        status: "Chờ dữ liệu trang..."
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
