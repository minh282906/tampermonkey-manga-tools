// ==UserScript==
// @name         Comici.jp Downloader
// @version      1.1
// @icon         https://www.google.com/s2/favicons?domain=comici.jp&sz=128
// @description  Tải truyện trên nền tảng comici.jp, khắc phục triệt để lazy loading, đóng gói ZIP chuẩn Tên Truyện - Tên Chap, lưu mã tập .txt, xuất PNG/JPG.
// @author       anonymous & AI
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      comici.jp
// @connect      *.comici.jp
// @connect      cdn.comici.jp
// @connect      cdn-public.comici.jp
// @match        https://comici.jp/*
// ==/UserScript==

(function comiciJpDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 4, // 4 luồng tải song song tối ưu
    JPEG_QUALITY: 0.95 // Chất lượng JPG 95%
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
    convertJpeg: localStorage.getItem("comici-jp-dl:convert-jpeg") === '1',
    cachedPages: [],
    ui: null,
    lastProgress: { completed: 0, total: 0, percent: 0, status: "Đang kiểm tra trang..." }
  };

  function isEpisodeUrl() {
    const p = WIN.location.pathname;
    return p.includes('/episodes/') || p.includes('/episode/') || p.includes('/articles/') || p.includes('/article/');
  }

  function saveJpegPref(val) {
    try {
      WIN.localStorage.setItem("comici-jp-dl:convert-jpeg", val ? '1' : '0');
    } catch {}
  }

  function getEpisodeId() {
    try {
      const sessionEl = DOC.getElementById('sessionId');
      if (sessionEl && sessionEl.textContent.trim()) {
        return sessionEl.textContent.trim();
      }
      const match = WIN.location.pathname.match(/\/(?:episodes?|articles?)\/([a-zA-Z0-9_-]+)/);
      if (match && match[1]) return match[1];
    } catch (e) {}
    return "comici_episode";
  }

  function cleanString(str) {
    if (!str) return "";
    return str
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/[\\/*?:"<>|]/g, '')
      .trim();
  }

  // TẠO TÊN FILE ZIP ĐÚNG CHUẨN: "Tên Truyện - Tên Chap"
  function getCleanTitle() {
    try {
      let seriesTitle = "";
      let episodeTitle = "";

      // 1. Tên Truyện
      const sEl = DOC.querySelector('.a-series-title, .series-title-wrapper a, [data-comic-title]');
      if (sEl) {
        seriesTitle = sEl.getAttribute('data-comic-title') || sEl.textContent || "";
      }
      if (!seriesTitle) {
        const altSEl = DOC.querySelector('.series-header-title, [class*="series-title"]');
        if (altSEl) seriesTitle = altSEl.textContent || "";
      }

      // 2. Tên Chap
      const eEl = DOC.querySelector('.title-line2, .article-title-box .title-line2, .episode-header-title, [class*="episode-title"]');
      if (eEl) {
        episodeTitle = eEl.textContent || "";
      }

      // 3. Dự phòng lấy từ document.title
      if ((!seriesTitle || !episodeTitle) && DOC.title) {
        const parts = DOC.title.split(/[｜|・-]/);
        if (parts.length >= 2) {
          if (!seriesTitle) seriesTitle = parts[0];
          if (!episodeTitle) episodeTitle = parts[1];
        }
      }

      seriesTitle = cleanString(seriesTitle);
      episodeTitle = cleanString(episodeTitle);

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

  /* =========================================================================
   * 3. TRÍCH XUẤT ẢNH THÔNG MINH (TRỊ TRIỆT ĐỂ LAZY LOADING)
   * ========================================================================= */
  function extractUrlsFromText(rawText, targetSet) {
    if (!rawText) return;

    let text = rawText;
    try { text = decodeURIComponent(text); } catch {}
    text = text.replace(/\\\//g, '/').replace(/\\"/g, '"');

    // 1. Quét Slate JSON: {"type":"image",...,"url":"..."}
    const slateRegex = /"type"\s*:\s*"image"[^}]*?"url"\s*:\s*"([^"]+)"/gi;
    let sMatch;
    while ((sMatch = slateRegex.exec(text)) !== null) {
      let u = sMatch[1].trim();
      if (u.startsWith('//')) u = 'https:' + u;
      if (u.startsWith('http')) targetSet.add(u);
    }

    // 2. Quét mọi đường dẫn CDN bài viết: cdn.comici.jp/articles/...
    const cdnRegex = /(?:https?:)?\/\/(?:cdn|cdn-public)\.comici\.jp\/articles\/\d+\/default\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|webp|avif)/gi;
    let cMatch;
    while ((cMatch = cdnRegex.exec(text)) !== null) {
      let u = cMatch[0].trim();
      if (u.startsWith('//')) u = 'https:' + u;
      targetSet.add(u);
    }
  }

  async function fetchServerHtml(url) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: url,
        headers: {
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        },
        timeout: 10000,
        onload: res => {
          if (res.status >= 200 && res.status < 300 && res.responseText) {
            resolve(res.responseText);
          } else {
            resolve(null);
          }
        },
        onerror: () => resolve(null),
        ontimeout: () => resolve(null)
      });
    });
  }

  async function fetchComiciJpPages() {
    if (state.cachedPages && state.cachedPages.length > 0) {
      return state.cachedPages;
    }

    const resultPages = [];
    const foundUrls = new Set();

    // CHIẾN LƯỢC 1: COMICI VIEWER API (Nếu trang dùng viewer chuẩn)
    const viewerEl = DOC.getElementById('comici-viewer') || DOC.querySelector('[data-comici-viewer-id]');
    if (viewerEl) {
      const viewerId = viewerEl.getAttribute('data-comici-viewer-id');
      if (viewerId) {
        const contentId = viewerEl.getAttribute('data-content-id') || '';
        const contentParam = contentId ? `&contentId=${encodeURIComponent(contentId)}` : '';
        const initUrl = `${WIN.location.origin}/api/book/contentsInfo?user-id=&comici-viewer-id=${viewerId}&page-from=0&page-to=1${contentParam}`;

        const initRes = await new Promise((resolve) => {
          GM_xmlhttpRequest({
            method: "GET",
            url: initUrl,
            headers: { "Accept": "application/json" },
            onload: r => {
              try { resolve(JSON.parse(r.responseText)); } catch { resolve(null); }
            },
            onerror: () => resolve(null)
          });
        });

        if (initRes && typeof initRes.totalPages === 'number') {
          const fullUrl = `${WIN.location.origin}/api/book/contentsInfo?user-id=&comici-viewer-id=${viewerId}&page-from=0&page-to=${initRes.totalPages}${contentParam}`;
          const fullRes = await new Promise((resolve) => {
            GM_xmlhttpRequest({
              method: "GET",
              url: fullUrl,
              headers: { "Accept": "application/json" },
              onload: r => {
                try { resolve(JSON.parse(r.responseText)); } catch { resolve(null); }
              },
              onerror: () => resolve(null)
            });
          });

          if (fullRes && Array.isArray(fullRes.result)) {
            let pNo = 1;
            for (const item of fullRes.result) {
              let imgUrl = item.imageUrl || item.src || item.url;
              if (!imgUrl) continue;
              if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;

              let scramble = item.scramble || item.scramble_key || item.scrambleKey;
              if (typeof scramble === 'string') {
                try { scramble = JSON.parse(scramble); } catch { scramble = null; }
              }

              resultPages.push({
                isPR: false,
                pageNo: pNo++,
                url: imgUrl,
                scramble: scramble
              });
            }
            if (resultPages.length > 0) {
              state.cachedPages = resultPages;
              return resultPages;
            }
          }
        }
      }
    }

    // CHIẾN LƯỢC 2: TẢI TRỰC TIẾP HTML GỐC TỪ SERVER (Trị sạch Lazy Loading)
    const serverHtml = await fetchServerHtml(WIN.location.href);
    if (serverHtml) {
      extractUrlsFromText(serverHtml, foundUrls);
    }

    // CHIẾN LƯỢC 3: QUÉT TOÀN BỘ SCRIPT VÀ DOM HIỆN TẠI
    if (DOC.documentElement) {
      extractUrlsFromText(DOC.documentElement.innerHTML, foundUrls);
    }

    // CHIẾN LƯỢC 4: QUÉT CÁC THUỘC TÍNH LAZY LOAD TRÊN DOM
    const lazyImgs = DOC.querySelectorAll('img, [data-src], [data-original], [data-lazy], [data-lazy-src], [data-bg], [data-url], [srcset]');
    for (const el of lazyImgs) {
      const candidates = [
        el.getAttribute('data-src'),
        el.getAttribute('data-original'),
        el.getAttribute('data-lazy-src'),
        el.getAttribute('data-lazy'),
        el.getAttribute('data-url'),
        el.getAttribute('data-bg'),
        el.getAttribute('src')
      ];

      for (let src of candidates) {
        if (!src || src.startsWith('data:')) continue;
        if (src.includes('cdn.comici.jp/articles/')) {
          if (src.startsWith('//')) src = 'https:' + src;
          foundUrls.add(src);
        }
      }

      // Xử lý srcset nếu có
      const srcset = el.getAttribute('srcset') || el.getAttribute('data-srcset');
      if (srcset) {
        const parts = srcset.split(',');
        for (const part of parts) {
          const itemUrl = part.trim().split(' ')[0];
          if (itemUrl && itemUrl.includes('cdn.comici.jp/articles/')) {
            foundUrls.add(itemUrl.startsWith('//') ? 'https:' + itemUrl : itemUrl);
          }
        }
      }
    }

    // Sắp xếp và chuyển thành danh sách trang hoàn chỉnh
    let pageNo = 1;
    for (const u of foundUrls) {
      resultPages.push({
        isPR: false,
        pageNo: pageNo++,
        url: u,
        scramble: null
      });
    }

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
   * 4. BỘ XỬ LÝ ẢNH TRONG BỘ NHỚ RAM (CANVAS / UNSCRAMBLE / CONVERT)
   * ========================================================================= */
  async function processImageBlob(rawBlob, scrambleArray, isJpg) {
    const isIdentity = !scrambleArray || (Array.isArray(scrambleArray) && scrambleArray.length === 16 && scrambleArray.every((val, idx) => val === idx));
    const rawType = rawBlob.type || '';

    // TỐI ƯU HÓA BYTE TRỰC TIẾP (Bỏ qua Canvas nếu không cần thiết để tiết kiệm RAM & CPU)
    if (isIdentity) {
      if (isJpg && (rawType.includes('jpeg') || rawType.includes('jpg'))) {
        const buffer = await rawBlob.arrayBuffer();
        return { uint8Array: new Uint8Array(buffer), ext: 'jpg' };
      }
      if (!isJpg && rawType.includes('png')) {
        const buffer = await rawBlob.arrayBuffer();
        return { uint8Array: new Uint8Array(buffer), ext: 'png' };
      }
    }

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

    // Tắt alpha để xuất ảnh 24-bit RGB chuẩn dung lượng nhẹ
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    if (isIdentity || !Array.isArray(scrambleArray) || scrambleArray.length < 16) {
      ctx.drawImage(img, 0, 0, width, height);
    } else {
      const cellWidth = Math.floor(width / 4);
      const cellHeight = Math.floor(height / 4);
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
    const quality = isJpg ? CONFIG.JPEG_QUALITY : undefined;

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
          console.error(`[comici-jp-dl] Lỗi trang ${currentIndex + 1}:`, err);
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
   * 6. CHƯƠNG TRÌNH CHÍNH
   * ========================================================================= */
  async function startDownload() {
    state.running = true;
    setUiBusy(true);

    try {
      updateProgressUI({ completed: 0, total: 0, status: "Đang nạp dữ liệu..." });

      const pages = await fetchComiciJpPages();
      const totalPages = pages.length;

      if (!totalPages) {
        throw new Error("Không tìm thấy trang ảnh nào.");
      }

      const useJpeg = Boolean(state.convertJpeg);
      const zip = new PureZipWriter();
      const episodeId = getEpisodeId();

      // Đính kèm file định danh ID tập
      zip.addFile(`${episodeId}.txt`, new Uint8Array(0));

      updateProgressUI({ completed: 0, total: totalPages, status: "Đang tải ảnh..." });

      const tasks = pages.map((pageObj) => async () => {
        const rawBlob = await fetchImageBlob(pageObj.url);

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

        const processed = await processImageBlob(rawBlob, pageObj.scramble, useJpeg);
        return {
          fileName: `${pageObj.pageNo}.${processed.ext}`,
          data: processed.uint8Array
        };
      });

      const results = await runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        updateProgressUI({
          completed,
          total,
          status: "Đang tải ảnh..."
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
        throw new Error("Lỗi đưa ảnh vào file ZIP.");
      }

      const zipBlob = zip.generateBlob();
      const zipFileName = `${getCleanTitle()}.zip`;
      triggerDownload(zipBlob, zipFileName);

      updateProgressUI({ completed: totalPages, total: totalPages, status: `Hoàn tất!` });
    } catch (err) {
      const msg = err?.message || String(err);
      updateProgressUI({ status: "Lỗi: " + msg });
      console.error("[comici-jp-dl] Error:", err);
    } finally {
      state.running = false;
      setUiBusy(false);
      updateProgressUI(state.lastProgress);
    }
  }

  /* =========================================================================
   * 7. GIAO DIỆN UI
   * ========================================================================= */
  function createUI() {
    if (state.ui) return;

    const panel = DOC.createElement("div");
    panel.id = "comici-jp-dl-panel";

    panel.style.cssText = [
      "all:initial",
      "position:fixed",
      "right:0px",
      "top:62px",
      "z-index:2147483647",
      "box-sizing:border-box",
      "width:220px",
      "padding:10px 14px",
      "border:1px solid #0284c7",
      "border-radius:10px",
      "background:#0c4a6e",
      "color:#ffffff",
      "font:12px/1.3 system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif",
      "user-select:none",
      "box-shadow:0 8px 24px rgba(0,0,0,0.85)",
      "display:none"
    ].join(';');

    const title = DOC.createElement("div");
    title.textContent = "Comici Downloader";
    title.style.cssText = "all:initial;display:block;color:#38bdf8;font:800 13px system-ui;margin-bottom:8px;text-align:center;";

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
      "background:#0284c7",
      "color:#ffffff",
      "font:700 14px/1.2 system-ui,sans-serif",
      "text-align:center",
      "cursor:pointer",
      "box-shadow:0 3px 10px rgba(2, 132, 199, 0.4)"
    ].join(';');

    btn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      startDownload();
    });

    const label = DOC.createElement("label");
    label.style.cssText = "all:initial;display:inline-flex;align-items:center;gap:6px;margin-top:8px;color:#e0f2fe;font:700 11px system-ui;cursor:pointer;";

    const jpgInput = DOC.createElement("input");
    jpgInput.type = "checkbox";
    jpgInput.checked = state.convertJpeg;
    jpgInput.style.cssText = "all:initial;appearance:auto;width:14px;height:14px;accent-color:#0284c7;cursor:pointer;";
    jpgInput.addEventListener("change", () => {
      state.convertJpeg = jpgInput.checked;
      saveJpegPref(state.convertJpeg);
    });

    const spanJpg = DOC.createElement("span");
    spanJpg.textContent = "Xuất file JPG (mặc định PNG)";
    spanJpg.style.cssText = "all:initial;color:#e0f2fe;font:700 11px system-ui;";
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
    track.style.cssText = "all:initial;display:block;height:6px;overflow:hidden;border-radius:3px;background:#082f49;margin-top:6px;";

    const fill = DOC.createElement("div");
    fill.style.cssText = "all:initial;display:block;width:100%;height:100%;background:#38bdf8;transform:scaleX(0);transform-origin:left center;transition:transform .22s ease;";
    track.appendChild(fill);

    const statusText = DOC.createElement("div");
    statusText.textContent = state.lastProgress.status;
    statusText.style.cssText = "all:initial;display:block;margin-top:8px;color:#bae6fd;font:11px system-ui;word-break:break-word;";

    panel.append(title, btn, label, progressRow, track, statusText);

    const attachUI = () => {
      if (DOC.body && !DOC.getElementById("comici-jp-dl-panel")) {
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
   * 8. BỘ LẮNG NGHE CHUYỂN TRANG (SPA ROUTE WATCHER)
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

    updateProgressUI({ completed: 0, total: 0, status: "Đang kiểm tra..." });

    let pages = [];
    let retries = 0;
    let lastError = null;

    while (retries < 25) {
      if (!isEpisodeUrl()) return;
      try {
        pages = await fetchComiciJpPages();
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