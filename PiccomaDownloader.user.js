// ==UserScript==
// @name         Piccoma Downloader
// @version      1.0
// @icon         https://www.google.com/s2/favicons?domain=piccoma.com&sz=128
// @description  Tải truyện trên nền tảng Piccoma.
// @author       anonymous & AI
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      *.piccoma.com
// @connect      piccoma.com
// @connect      *.kakaocdn.net
// @connect      pcm.kakaocdn.net
// @connect      piccoma.kakaocdn.net
// @match        https://piccoma.com/web/viewer/*
// @match        https://jp.piccoma.com/web/viewer/*
// ==/UserScript==

(function piccomaUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG PICCOMA
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 4,
    TILE_SIZE: 50,
      JPEG_QUALITY: 0.95
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  // BẮT GIỮ _pdata_ TRỰC TIẾP TỪ RAM
  let capturedPData = null;
  try {
    Object.defineProperty(WIN, '_pdata_', {
      configurable: true,
      enumerable: true,
      get() { return capturedPData; },
      set(v) { capturedPData = v; }
    });
  } catch (e) {}

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
    convertJpeg: localStorage.getItem("piccoma-dl:convert-jpeg") === '1',
    cachedData: null,
    ui: null,
    lastProgress: { completed: 0, total: 0, percent: 0, status: "Đang kiểm tra..." }
  };

  function isEpisodeUrl() {
    return /\/viewer\/\d+\/\d+/.test(WIN.location.pathname);
  }

  function saveJpegPref(val) {
    try {
      WIN.localStorage.setItem("piccoma-dl:convert-jpeg", val ? '1' : '0');
    } catch {}
  }

  function getEpisodeId() {
    try {
      const match = WIN.location.pathname.match(/\/viewer\/\d+\/(\d+)/);
      if (match && match[1]) return match[1];
      if (state.cachedData?.episode_id) return String(state.cachedData.episode_id);
    } catch (e) {}
    return "piccoma_episode";
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
      let episodeTitle = state.cachedData?.title || "";

      if (DOC.title) {
        const parts = DOC.title.split(/[｜|]/);
        if (parts.length >= 2) {
          if (!episodeTitle) episodeTitle = parts[0];
          seriesTitle = parts[1].replace(/\([^)]*\)/g, '');
        }
      }

      seriesTitle = cleanString(seriesTitle);
      episodeTitle = cleanString(episodeTitle);

      if (seriesTitle && episodeTitle && !episodeTitle.includes(seriesTitle)) {
        return `${seriesTitle} - ${episodeTitle}`;
      } else if (episodeTitle) {
        return episodeTitle;
      } else if (seriesTitle) {
        return seriesTitle;
      }
    } catch (e) {}

    return `Piccoma_${getEpisodeId()}`;
  }

  /* =========================================================================
   * 3. BÓC TÁCH DỮ LIỆU _pdata_ (CHỈ LẤY ĐÚNG ẢNH TRUYỆN THẬT, WEB KHÔNG CÓ ẢNH THƯƠNG MẠI)
   * ========================================================================= */
  function extractPData() {
    if (capturedPData?.img?.length > 0) return capturedPData;
    if (WIN._pdata_?.img?.length > 0) return WIN._pdata_;

    const scripts = DOC.querySelectorAll('script:not([src])');
    for (const s of scripts) {
      const text = s.textContent || '';
      if (text.includes('_pdata_') && text.includes('img')) {
        const start = text.indexOf('{', text.indexOf('_pdata_'));
        if (start === -1) continue;
        let depth = 0, inStr = false, q = '', end = -1;
        for (let i = start; i < text.length; i++) {
          const ch = text[i];
          if (inStr) {
            if (ch === q && text[i - 1] !== '\\') inStr = false;
          } else {
            if (ch === '"' || ch === "'") { inStr = true; q = ch; }
            else if (ch === '{') depth++;
            else if (ch === '}') {
              depth--;
              if (depth === 0) { end = i; break; }
            }
          }
        }
        if (end !== -1) {
          try {
            const data = new Function('return (' + text.substring(start, end + 1) + ');')();
            if (data?.img?.length > 0) {
              capturedPData = data;
              return data;
            }
          } catch (e) {}
        }
      }
    }
    return null;
  }

  function fetchPiccomaPages() {
    const pdata = extractPData();
    if (!pdata || !Array.isArray(pdata.img) || pdata.img.length === 0) {
      return [];
    }

    state.cachedData = pdata;
    if (!WIN._pdata_) WIN._pdata_ = pdata;

    const isScrambled = Boolean(pdata.isScrambled);
    const validPages = [];
    let pageNo = 1;

    // BỘ LỌC CHẶT CHẼ: Chỉ lấy các trang truyện thật trên CDN
    for (let i = 0; i < pdata.img.length; i++) {
      const item = pdata.img[i];
      let url = item.path || item.src || item.url || '';
      if (!url) continue;
      if (url.startsWith('//')) url = 'https:' + url;

      // Loại bỏ hoàn toàn trang kết thúc (end-slot / heart / ad)
      if (!url.includes('/dna/') && !/\.(?:jpg|jpeg|png|webp)/i.test(url)) {
        continue;
      }

      validPages.push({
        pageNo: pageNo++,
        url: url,
        width: item.width || 0,
        height: item.height || 0,
        isScrambled: isScrambled
      });
    }

    return validPages;
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
          "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"
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
        onerror: () => reject(new Error("Lỗi kết nối tải ảnh")),
        ontimeout: () => reject(new Error("Timeout tải ảnh"))
      });
    });
  }

  /* =========================================================================
   * 4. THUẬT TOÁN GIẢI MÃ MA TRẬN PICCOMA TRONG RAM (ENGINE GỐC)
   * ========================================================================= */
  function getChecksum(url) {
    try {
      const clean = url.split('?')[0];
      const parts = clean.split('/');
      return parts[parts.length - 2] || '';
    } catch { return ''; }
  }

  function getSeed(checksum, expires) {
    if (!expires || !checksum) return checksum;
    let sum = 0;
    for (let i = 0; i < expires.length; i++) {
      const digit = parseInt(expires[i], 10);
      if (!isNaN(digit)) sum += digit;
    }
    const shift = sum % checksum.length;
    if (shift === 0) return checksum;
    return checksum.slice(-shift) + checksum.slice(0, -shift);
  }

  async function computeImageSeed(url) {
    const checksum = getChecksum(url);
    const match = url.match(/[?&]expires=([0-9]+)/);
    const expires = match ? match[1] : '';
    const rawSeed = getSeed(checksum, expires);

    // Gọi WebAssembly window.dd
    let attempts = 0;
    while (attempts < 30) {
      if (typeof WIN.dd === "function") {
        try {
          return WIN.dd(rawSeed);
        } catch (e) {
          console.warn("[piccoma-dl] wasm dd error:", e);
        }
      }
      await sleep(50);
      attempts++;
    }
    return rawSeed;
  }

  async function processPiccomaImage(rawBlob, pageObj, isJpg) {
    if (!pageObj.isScrambled) {
      const rawType = rawBlob.type || '';
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
      img.onerror = () => reject(new Error("Lỗi nạp ảnh vào RAM"));
      img.src = objUrl;
    });
    WIN.URL.revokeObjectURL(objUrl);

    let unscrambledCanvas = null;

    if (pageObj.isScrambled) {
      const seed = await computeImageSeed(pageObj.url);

      if (!WIN._pdata_ && state.cachedData) {
        WIN._pdata_ = state.cachedData;
      }

      let attempts = 0;
      while (attempts < 30 && typeof WIN.unscrambleImg !== "function") {
        await sleep(50);
        attempts++;
      }

      if (typeof WIN.unscrambleImg === "function") {
        const res = WIN.unscrambleImg(img, CONFIG.TILE_SIZE, seed);
        unscrambledCanvas = Array.isArray(res) ? res[0] : res;
      }
    }

    const outWidth = unscrambledCanvas ? unscrambledCanvas.width : (img.naturalWidth || img.width);
    const outHeight = unscrambledCanvas ? unscrambledCanvas.height : (img.naturalHeight || img.height);

    if (outWidth === 0 || outHeight === 0) {
      throw new Error("Kích thước ảnh không hợp lệ (0x0).");
    }

    const outCanvas = DOC.createElement('canvas');
    outCanvas.width = outWidth;
    outCanvas.height = outHeight;

    const ctx = outCanvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, outWidth, outHeight);

    if (unscrambledCanvas) {
      ctx.drawImage(unscrambledCanvas, 0, 0);
      unscrambledCanvas.width = 0;
      unscrambledCanvas.height = 0;
    } else {
      ctx.drawImage(img, 0, 0, outWidth, outHeight);
    }

    const mimeType = isJpg ? 'image/jpeg' : 'image/png';
    const quality = isJpg ? CONFIG.JPEG_QUALITY : undefined;

    const outBlob = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("toBlob timeout")), 8000);
      outCanvas.toBlob(b => {
        clearTimeout(timer);
        if (b) resolve(b);
        else reject(new Error("toBlob trả về null"));
      }, mimeType, quality);
    });

    outCanvas.width = 0;
    outCanvas.height = 0;

    const buffer = await outBlob.arrayBuffer();
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
          console.error(`[piccoma-dl] Lỗi tải trang ${currentIndex + 1}:`, err);
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
    ui.fill.style.transform = "scaleX(" + (total > 0 ? pct / 100 : 0) + ')';
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
      updateProgressUI({ completed: 0, total: 0, status: "Đang kiểm tra..." });

      const pages = fetchPiccomaPages();
      const totalPages = pages.length;

      if (!totalPages) {
        throw new Error("Không tìm thấy.");
      }

      const useJpeg = Boolean(state.convertJpeg);
      const zip = new PureZipWriter();
      const episodeId = getEpisodeId();

      // Đính kèm file txt định danh ID tập
      zip.addFile(`${episodeId}.txt`, new Uint8Array(0));

      updateProgressUI({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map((pageObj) => async () => {
        const rawBlob = await fetchImageBlob(pageObj.url);

        // Giải mã ma trận 100% trong RAM
        const decoded = await processPiccomaImage(rawBlob, pageObj, useJpeg);
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
        throw new Error("Lỗi nạp ảnh vào ZIP.");
      }

      const zipBlob = zip.generateBlob();
      const zipFileName = `${getCleanTitle()}.zip`;
      triggerDownload(zipBlob, zipFileName);

      updateProgressUI({ completed: totalPages, total: totalPages, status: `Hoàn tất!` });
    } catch (err) {
      const msg = err?.message || String(err);
      updateProgressUI({ status: "Lỗi: " + msg });
      console.error("[piccoma-dl] Download failed:", err);
    } finally {
      state.running = false;
      setUiBusy(false);
      updateProgressUI(state.lastProgress);
    }
  }

  /* =========================================================================
   * 7. GIAO DIỆN UI (THEME VÀNG PICCOMA + BOOKMARK 14PX)
   * ========================================================================= */
  function createUI() {
    if (state.ui || !DOC.body) return;

    const PANEL_WIDTH = 220;
    const TAB_WIDTH = 14;
    let isCollapsed = localStorage.getItem("piccoma-dl:collapsed") === '1';

    const panel = DOC.createElement("div");
    panel.id = "piccoma-dl-panel";
    panel.style.cssText = [
      "all:initial",
      "position:fixed",
      "right:0px",
      "top:52px",
      "z-index:2147483647",
      "box-sizing:border-box",
      `width:${PANEL_WIDTH}px`,
      "padding:10px 14px",
      "border:1px solid #ca8a04",
      "border-right:none",
      "border-radius:12px 0 0 12px",
      "background:#0f172a",
      "color:#ffffff",
      "font:12px/1.3 system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif",
      "user-select:none",
      "box-shadow:0 8px 24px rgba(0,0,0,0.85)",
      "transition:transform 0.22s cubic-bezier(0.16, 1, 0.3, 1)",
      `transform:${isCollapsed ? `translateX(calc(100% - ${TAB_WIDTH}px))` : "translateX(0)"}`,
      "display:none",
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
      "background:#eab308",
      "cursor:pointer",
      "transition:opacity 0.15s, background 0.15s",
      `opacity:${isCollapsed ? "1" : "0"}`,
      `pointer-events:${isCollapsed ? "auto" : "none"}`
    ].join(';');
    collapsedStrip.title = "Bấm để mở bảng tải";
    collapsedStrip.onmouseenter = () => { collapsedStrip.style.background = "#facc15"; };
    collapsedStrip.onmouseleave = () => { collapsedStrip.style.background = "#eab308"; };

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
      "background:#eab308",
      "color:#000000",
      "font:900 10px system-ui,sans-serif",
      "cursor:pointer",
      "transition:background 0.15s ease",
      "z-index:2"
    ].join(';');
    collapseBtn.onmouseenter = () => { collapseBtn.style.background = "#facc15"; };
    collapseBtn.onmouseleave = () => { collapseBtn.style.background = "#eab308"; };

    const title = DOC.createElement("div");
    title.textContent = "Piccoma Downloader";
    title.style.cssText = "all:initial;display:block;color:#fde047;font:800 13px system-ui;margin-bottom:8px;text-align:center;padding-left:14px;";

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
      "background:#eab308",
      "color:#000000",
      "font:800 14px/1.2 system-ui,sans-serif",
      "text-align:center",
      "cursor:pointer",
      "box-shadow:0 3px 10px rgba(234, 179, 8, 0.35)"
    ].join(';');

    btn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      startDownload();
    });

    const label = DOC.createElement("label");
    label.style.cssText = "all:initial;display:inline-flex;align-items:center;gap:6px;margin-top:8px;color:#fef08a;font:700 11px system-ui;cursor:pointer;";

    const jpgInput = DOC.createElement("input");
    jpgInput.type = "checkbox";
    jpgInput.checked = state.convertJpeg;
    jpgInput.style.cssText = "all:initial;appearance:auto;width:14px;height:14px;accent-color:#eab308;cursor:pointer;";
    jpgInput.addEventListener("change", () => {
      state.convertJpeg = jpgInput.checked;
      saveJpegPref(state.convertJpeg);
    });

    const spanJpg = DOC.createElement("span");
    spanJpg.textContent = "Xuất file JPG (mặc định PNG)";
    spanJpg.style.cssText = "all:initial;color:#fef08a;font:700 11px system-ui;";
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
    track.style.cssText = "all:initial;display:block;height:6px;overflow:hidden;border-radius:3px;background:#451a03;margin-top:6px;";

    const fill = DOC.createElement("div");
    fill.style.cssText = "all:initial;display:block;width:100%;height:100%;background:#facc15;transform:scaleX(0);transform-origin:left center;transition:transform .22s ease;";
    track.appendChild(fill);

    const statusText = DOC.createElement("div");
    statusText.textContent = state.lastProgress.status;
    statusText.style.cssText = "all:initial;display:block;margin-top:8px;color:#fde68a;font:11px system-ui;word-break:break-word;";

    mainContent.append(collapseBtn, title, btn, label, progressRow, track, statusText);
    panel.append(collapsedStrip, mainContent);

    function setCollapsedState(collapsed) {
      isCollapsed = collapsed;
      localStorage.setItem("piccoma-dl:collapsed", isCollapsed ? '1' : '0');

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

    const attachUI = () => {
      if (DOC.body && !DOC.getElementById("piccoma-dl-panel")) {
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

        state.cachedData = null;
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

    while (retries < 30) {
      if (!isEpisodeUrl()) return;
      pages = fetchPiccomaPages();
      if (pages.length > 0) break;
      await sleep(150);
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
        status: "Đang kiểm tra..."
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