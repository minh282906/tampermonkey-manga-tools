// ==UserScript==
// @name         Manga-One Downloader
// @namespace    https://manga-one.com/
// @version      1.0.0
// @icon         https://www.google.com/s2/favicons?domain=manga-one.com&sz=128
// @description  Tải manga trên Manga-One
// @author       anonymous & AI
// @match        https://manga-one.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      manga-one.com
// @connect      *.manga-one.com
// @connect      app.manga-one.com
// ==/UserScript==

(function mangaOneUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6,   // Số luồng tải và giải mã song song
    JPEG_QUALITY: 0.95   // Chất lượng xuất JPG nếu chuyển đổi
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) {
    return;
  }

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
    convertJpeg: localStorage.getItem("mangaone-dl:convert-jpeg") === '1',
    detectedSourceFormat: 'webp', // 'jpg' | 'png' | 'webp'
    chapterData: null,
    ui: null,
    lastProgress: { completed: 0, total: 0, percent: 0, status: "Đang kiểm tra..." }
  };

  function isEpisodeUrl() {
    return /\/manga\/\d+\/chapter\/\d+/.test(WIN.location.pathname);
  }

  function saveJpegPref(val) {
    try {
      WIN.localStorage.setItem("mangaone-dl:convert-jpeg", val ? '1' : '0');
    } catch {}
  }

  function getIdsFromUrl() {
    try {
      const match = WIN.location.pathname.match(/\/manga\/(\d+)\/chapter\/(\d+)/);
      if (match) {
        return { titleId: match[1], chapterId: match[2] };
      }
    } catch (e) {}
    return { titleId: null, chapterId: null };
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

  function getCleanTitle() {
    try {
      let seriesTitle = "";
      let episodeTitle = "";

      const ogTitle = DOC.querySelector('meta[property="og:title"]')?.getAttribute('content');
      let rawTitle = ogTitle || DOC.title || "";
      rawTitle = rawTitle.split('｜')[0].split('|')[0].trim();

      const match = rawTitle.match(/^(.*?)\s+(第?\s*\d+\s*(?:話|曲|局|話目|限目|時限目|部|エピソード)?.*)$/i);
      if (match) {
        seriesTitle = match[1].trim();
        episodeTitle = match[2].trim();
      } else {
        seriesTitle = rawTitle;
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

    const { chapterId } = getIdsFromUrl();
    return `MangaOne_${chapterId || 'Episode'}`;
  }

  /* =========================================================================
   * 3. API CLIENT V2 & GIẢI MÃ AES-CBC
   * ========================================================================= */
  async function fetchChapterConfig(titleId, chapterId) {
    const apiUrl = `https://manga-one.com/api/client?rq=viewer_v2&title_id=${titleId}&chapter_id=${chapterId}`;

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: apiUrl,
        headers: {
          "Accept": "*/*",
          "Origin": "https://manga-one.com",
          "Referer": WIN.location.href
        },
        onload: res => {
          if (res.status >= 200 && res.status < 300) {
            resolve(res.responseText);
          } else {
            reject(new Error(`API Error HTTP ${res.status}`));
          }
        },
        onerror: () => reject(new Error("Lỗi kết nối API MangaOne.")),
        ontimeout: () => reject(new Error("Timeout kết nối API MangaOne."))
      });
    });
  }

  function parseConfigString(configString, chapterId) {
    const urlRegex = new RegExp(`https:\\/\\/app\\.manga-one\\.com\\/.*\\/${chapterId}\\/.*expires=\\d{10}`, 'g');
    const matchedUrls = configString.match(urlRegex);

    if (!matchedUrls || matchedUrls.length === 0) {
      throw new Error("Không tìm thấy danh sách ảnh trong API.");
    }

    // Nhận diện nhanh định dạng từ URL trên CDN
    if (matchedUrls[0].includes('/webp/') || matchedUrls[0].includes('.webp')) {
      state.detectedSourceFormat = 'webp';
    } else if (matchedUrls[0].includes('/png/') || matchedUrls[0].includes('.png')) {
      state.detectedSourceFormat = 'png';
    } else if (matchedUrls[0].includes('/jpg/') || matchedUrls[0].includes('.jpg') || matchedUrls[0].includes('.jpeg')) {
      state.detectedSourceFormat = 'jpg';
    }

    updateFormatUI(state.detectedSourceFormat);

    const cryptoMatch = configString.match(/(?<key>[0-9a-f]{64}).*(?<iv>[0-9a-f]{32})/);
    const cryptoData = cryptoMatch ? cryptoMatch.groups : null;

    const pages = matchedUrls.map((url, idx) => {
      const isEncrypted = url.includes('.enc?');
      return {
        pageNo: idx + 1,
        url: url,
        isEncrypted: isEncrypted,
        crypto: isEncrypted ? cryptoData : null
      };
    });

    return pages;
  }

  function unhex(hexString) {
    const arr = new Uint8Array(hexString.length / 2);
    for (let i = 0; i < hexString.length; i += 2) {
      arr[i / 2] = parseInt(hexString.substring(i, i + 2), 16);
    }
    return arr;
  }

  function fetchEncryptedArrayBuffer(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: url,
        responseType: "arraybuffer",
        timeout: 25000,
        headers: {
          "Referer": "https://manga-one.com/"
        },
        onload: res => {
          if (res.status >= 200 && res.status < 300 && res.response) {
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

  async function decryptAndFormatImage(rawArrayBuffer, pageItem, forceJpg) {
    let finalBuffer = rawArrayBuffer;

    // 1. GIẢI MÃ AES-CBC
    if (pageItem.isEncrypted && pageItem.crypto?.key && pageItem.crypto?.iv) {
      const keyBytes = unhex(pageItem.crypto.key);
      const ivBytes = unhex(pageItem.crypto.iv);

      const cryptoKey = await WIN.crypto.subtle.importKey(
        'raw',
        keyBytes,
        { name: 'AES-CBC' },
        false,
        ['decrypt']
      );

      finalBuffer = await WIN.crypto.subtle.decrypt(
        { name: 'AES-CBC', iv: ivBytes },
        cryptoKey,
        rawArrayBuffer
      );
    }

    const uint8 = new Uint8Array(finalBuffer);

    // 2. NHẬN DIỆN MAGIC BYTES CHÍNH XÁC
    let ext = 'jpg';
    if (uint8[0] === 0x52 && uint8[1] === 0x49 && uint8[2] === 0x46 && uint8[3] === 0x46) {
      ext = 'webp';
    } else if (uint8[0] === 0x89 && uint8[1] === 0x50 && uint8[2] === 0x4E && uint8[3] === 0x47) {
      ext = 'png';
    } else if (uint8[0] === 0xFF && uint8[1] === 0xD8 && uint8[2] === 0xFF) {
      ext = 'jpg';
    }

    if (state.detectedSourceFormat !== ext) {
      state.detectedSourceFormat = ext;
      updateFormatUI(ext);
    }

    const fileName = `${String(pageItem.pageNo).padStart(3, '0')}.${forceJpg ? 'jpg' : ext}`;

    // Không cần ép JPG hoặc ảnh vốn là JPG
    if (ext === 'jpg' || !forceJpg) {
      return {
        fileName: fileName,
        data: uint8
      };
    }

    // 3. CHUYỂN ĐỔI SANG JPG KHI ĐƯỢC YÊU CẦU
    const blob = new Blob([uint8], { type: `image/${ext}` });
    const objUrl = WIN.URL.createObjectURL(blob);
    const img = new WIN.Image();
    img.decoding = "async";

    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = objUrl;
    });
    WIN.URL.revokeObjectURL(objUrl);

    const canvas = DOC.createElement('canvas');
    canvas.width = img.naturalWidth || 720;
    canvas.height = img.naturalHeight || 1020;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);

    const jpgBlob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', CONFIG.JPEG_QUALITY));
    const jpgBuffer = await jpgBlob.arrayBuffer();

    canvas.width = 0;
    canvas.height = 0;

    return {
      fileName: fileName,
      data: new Uint8Array(jpgBuffer)
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
          console.error(`[mangaone-dl] Lỗi tải trang ${currentIndex + 1}:`, err);
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
   * 5. GIAO DIỆN UI (THEME HỒNG MAGENTA MANGA-ONE #e52865)
   * ========================================================================= */
  function updateFormatUI(format) {
    const ui = state.ui;
    if (!ui || !ui.jpgInput || !ui.jpgSpan) return;

    if (format === 'jpg') {
      ui.jpgInput.checked = true;
      ui.jpgInput.disabled = true;
      ui.jpgSpan.textContent = "Xuất file JPG (ảnh gốc là JPG)";
    } else if (format === 'webp') {
      ui.jpgInput.disabled = false;
      ui.jpgInput.checked = state.convertJpeg;
      ui.jpgSpan.textContent = "Xuất file JPG (ảnh gốc là WebP)";
    } else if (format === 'png') {
      ui.jpgInput.disabled = false;
      ui.jpgInput.checked = state.convertJpeg;
      ui.jpgSpan.textContent = "Xuất file JPG (ảnh gốc là PNG)";
    }
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

    ui.count.textContent = total ? `${Math.min(completed, total)}/${total}` : "0/0";
    ui.percent.textContent = `${pct}%`;
    ui.fill.style.transform = `scaleX(${total > 0 ? pct / 100 : 0})`;
    ui.status.textContent = state.lastProgress.status;
  }

  function setUiBusy(isBusy) {
    const ui = state.ui;
    if (!ui) return;
    ui.button.disabled = Boolean(isBusy);
    ui.button.textContent = "Download";
    ui.button.style.opacity = isBusy ? "0.72" : '1';
    ui.button.style.cursor = isBusy ? "progress" : "pointer";
    if (state.detectedSourceFormat !== 'jpg') {
      ui.jpgInput.disabled = Boolean(isBusy);
    }
  }

  function createUI() {
    if (state.ui || !DOC.body || DOC.getElementById("mangaone-dl-panel")) return;

    const PANEL_WIDTH = 220;
    const TAB_WIDTH = 14;
    let isCollapsed = localStorage.getItem("mangaone-dl:collapsed") === '1';

    const panel = DOC.createElement("div");
    panel.id = "mangaone-dl-panel";
    panel.style.cssText = [
      "all:initial",
      "position:fixed",
      "right:0px",
      "top:70px",
      "z-index:2147483647",
      "box-sizing:border-box",
      `width:${PANEL_WIDTH}px`,
      "padding:10px 14px",
      "border:1px solid #e52865",
      "border-right:none",
      "border-radius:12px 0 0 12px",
      "background:#171113",
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
      "background:#e52865",
      "cursor:pointer",
      "transition:opacity 0.15s, background 0.15s",
      `opacity:${isCollapsed ? "1" : "0"}`,
      `pointer-events:${isCollapsed ? "auto" : "none"}`
    ].join(';');
    collapsedStrip.title = "Mở bảng tải";
    collapsedStrip.onmouseenter = () => { collapsedStrip.style.background = "#f0437e"; };
    collapsedStrip.onmouseleave = () => { collapsedStrip.style.background = "#e52865"; };

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
      "background:#e52865",
      "color:#ffffff",
      "font:900 10px system-ui,sans-serif",
      "cursor:pointer",
      "transition:background 0.15s ease",
      "z-index:2"
    ].join(';');
    collapseBtn.onmouseenter = () => { collapseBtn.style.background = "#f0437e"; };
    collapseBtn.onmouseleave = () => { collapseBtn.style.background = "#e52865"; };

    const title = DOC.createElement("div");
    title.textContent = "MangaOne Downloader";
    title.style.cssText = "all:initial;display:block;color:#f472b6;font:800 13px system-ui;margin-bottom:8px;text-align:center;padding-left:14px;";

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
      "background:#e52865",
      "color:#ffffff",
      "font:800 14px/1.2 system-ui,sans-serif",
      "text-align:center",
      "cursor:pointer",
      "box-shadow:0 3px 10px rgba(229, 40, 101, 0.35)"
    ].join(';');

    btn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      if (!state.running) startDownload();
    });

    const label = DOC.createElement("label");
    label.style.cssText = "all:initial;display:inline-flex;align-items:center;gap:6px;margin-top:8px;color:#fbcfe8;font:700 11px system-ui;cursor:pointer;";

    const jpgInput = DOC.createElement("input");
    jpgInput.type = "checkbox";
    jpgInput.checked = state.convertJpeg;
    jpgInput.style.cssText = "all:initial;appearance:auto;width:14px;height:14px;accent-color:#e52865;cursor:pointer;";
    jpgInput.addEventListener("change", () => {
      if (state.detectedSourceFormat !== 'jpg') {
        state.convertJpeg = jpgInput.checked;
        saveJpegPref(state.convertJpeg);
      }
    });

    const spanJpg = DOC.createElement("span");
    spanJpg.textContent = "Xuất file JPG (ảnh gốc là WebP)";
    spanJpg.style.cssText = "all:initial;color:#fbcfe8;font:700 11px system-ui;";
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
    track.style.cssText = "all:initial;display:block;height:6px;overflow:hidden;border-radius:3px;background:#4c0519;margin-top:6px;";

    const fill = DOC.createElement("div");
    fill.style.cssText = "all:initial;display:block;width:100%;height:100%;background:#f43f5e;transform:scaleX(0);transform-origin:left center;transition:transform .22s ease;";
    track.appendChild(fill);

    const statusText = DOC.createElement("div");
    statusText.textContent = state.lastProgress.status;
    statusText.style.cssText = "all:initial;display:block;margin-top:8px;color:#fbcfe8;font:11px system-ui;word-break:break-word;";

    mainContent.append(collapseBtn, title, btn, label, progressRow, track, statusText);
    panel.append(collapsedStrip, mainContent);

    function setCollapsedState(collapsed) {
      isCollapsed = collapsed;
      localStorage.setItem("mangaone-dl:collapsed", isCollapsed ? '1' : '0');

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
      jpgSpan: spanJpg,
      count: countText,
      percent: percentText,
      fill,
      status: statusText
    };

    updateFormatUI(state.detectedSourceFormat);
    updateProgressUI(state.lastProgress);
  }

  /* =========================================================================
   * 6. CHƯƠNG TRÌNH TẢI CHÍNH
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;

    const { titleId, chapterId } = getIdsFromUrl();
    if (!titleId || !chapterId) {
      updateProgressUI({ status: "Lỗi: Không xác định được ID chương." });
      return;
    }

    state.running = true;
    setUiBusy(true);

    try {
      updateProgressUI({ completed: 0, total: 0, status: "Đang tải..." });

      let pages = state.chapterData;
      if (!pages || pages.length === 0) {
        const configText = await fetchChapterConfig(titleId, chapterId);
        pages = parseConfigString(configText, chapterId);
        state.chapterData = pages;
      }

      const totalPages = pages.length;
      if (!totalPages) {
        throw new Error("Không có trang hợp lệ.");
      }

      const forceJpg = Boolean(state.convertJpeg) || (state.detectedSourceFormat === 'jpg');
      const zip = new PureZipWriter();

      // Đính kèm file txt định danh ID tập
      zip.addFile(`${chapterId}.txt`, new Uint8Array(0));

      updateProgressUI({ completed: 0, total: totalPages, status: "Đang tải..." });

      // Tải và giải mã song song 4 luồng
      const tasks = pages.map((pageItem) => async () => {
        const rawBuffer = await fetchEncryptedArrayBuffer(pageItem.url);
        return await decryptAndFormatImage(rawBuffer, pageItem, forceJpg);
      });

      const results = await runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        updateProgressUI({ completed, total, status: "Đang tải..." });
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
        throw new Error("Lỗi đóng gói ảnh vào ZIP.");
      }

      const zipBlob = zip.generateBlob();
      const zipFileName = `${getCleanTitle()}.zip`;
      triggerDownload(zipBlob, zipFileName);

      updateProgressUI({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      const msg = err?.message || String(err);
      updateProgressUI({ status: "Lỗi: " + msg });
      console.error("[mangaone-dl] Error:", err);
    } finally {
      state.running = false;
      setUiBusy(false);
      updateProgressUI(state.lastProgress);
    }
  }

  /* =========================================================================
   * 7. SPA ROUTE WATCHER & BOOT
   * ========================================================================= */
  function initRouteWatcher() {
    let lastUrl = WIN.location.href;

    const onUrlChange = () => {
      const currentUrl = WIN.location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        state.chapterData = null;
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
      await sleep(50);
    }
    createUI();

    if (!isEpisodeUrl()) {
      if (state.ui?.panel) state.ui.panel.style.display = "none";
      return;
    }

    if (state.ui?.panel) state.ui.panel.style.display = "block";
    updateProgressUI({ completed: 0, total: 0, status: "Đang kiểm tra..." });

    const { titleId, chapterId } = getIdsFromUrl();
    if (!titleId || !chapterId) return;

    try {
      const configText = await fetchChapterConfig(titleId, chapterId);
      const pages = parseConfigString(configText, chapterId);
      state.chapterData = pages;

      updateProgressUI({
        completed: 0,
        total: pages.length,
        status: "Sẵn sàng."
      });
    } catch (err) {
      updateProgressUI({
        completed: 0,
        total: 0,
        status: "Sẵn sàng."
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