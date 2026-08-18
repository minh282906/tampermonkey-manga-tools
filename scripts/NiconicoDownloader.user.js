// ==UserScript==
// @name         Niconico Manga Downloader
// @namespace    https://sp.manga.nicovideo.jp/
// @version      1.0
// @icon         https://sp.manga.nicovideo.jp/favicon.ico
// @description  Tải truyện Niconico Manga
// @author       anonymous & AI
// @match        https://sp.manga.nicovideo.jp/watch/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      *.nicovideo.jp
// @connect      *.nicoseiga.jp
// @connect      *.nicomanga.jp
// ==/UserScript==

(function niconicoMangaUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 4, // Số lượng trang tải song song vào RAM
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  /* =========================================================================
   * 1. BỘ ĐÓNG GÓI ZIP NGUYÊN BẢN TRONG RAM (PURE ZIP WRITER)
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
    convertJpeg: localStorage.getItem("nico-dl:convert-jpeg") === '1',
    cachedPages: [],
    ui: null,
    lastProgress: { completed: 0, total: 0, percent: 0, status: "Đang kiểm tra..." }
  };

  function isEpisodeUrl() {
    return /\/watch\/(mg\d+|\d+)/.test(WIN.location.pathname);
  }

  function saveJpegPref(val) {
    try {
      WIN.localStorage.setItem("nico-dl:convert-jpeg", val ? '1' : '0');
    } catch {}
  }

  function getEpisodeId() {
    try {
      const match = WIN.location.pathname.match(/\/watch\/(mg\d+|\d+)/);
      if (match && match[1]) {
        return match[1].startsWith('mg') ? match[1] : `mg${match[1]}`;
      }
    } catch (e) {}
    return "mg_episode";
  }

  function getCleanMangaTitle() {
    try {
      let raw = DOC.title || "";
      raw = raw.replace(/\s*[-|｜]\s*ニコニコ漫画.*/i, '').trim();
      raw = raw.split(/\s*\/\s*原作/)[0].trim();
      raw = raw.replace(/【[^】]*】/g, '').trim();

      const episodeMatch = raw.match(/(第\s*\d+[\d\w\.\s\-話③②①④⑤⑥⑦⑧⑨⑩]*|\b\d+話\b.*)/);
      if (episodeMatch) {
        const epIndex = raw.indexOf(episodeMatch[0]);
        if (epIndex > 0) {
          const seriesPart = raw.substring(0, epIndex).trim().replace(/[\\/*?:"<>|]/g, '');
          const epPart = raw.substring(epIndex).trim().replace(/[\\/*?:"<>|]/g, '');
          if (seriesPart && epPart) {
            return `${seriesPart} - ${epPart}`;
          }
        }
      }

      const clean = raw.replace(/[\\/*?:"<>|]/g, '').trim();
      if (clean) return clean;
    } catch (e) {}

    return `Niconico_${getEpisodeId()}`;
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

  async function getDomPrImages(timeoutMs = 300) {
    const selectors = [
      '.episode-end-banner img',
      '.next-episode-banner img',
      '.recommend-banner img',
      '[class*="endBanner"] img',
      '[class*="recommend"] img'
    ];

    const startTime = Date.now();
    const prList = [];

    while (Date.now() - startTime < timeoutMs) {
      const imgs = DOC.querySelectorAll(selectors.join(', '));
      for (const img of imgs) {
        let src = img.getAttribute('data-src') || img.getAttribute('src') || '';
        if (!src || src.startsWith('data:')) continue;

        const w = img.naturalWidth || parseInt(img.getAttribute('width') || '0', 10);
        const h = img.naturalHeight || parseInt(img.getAttribute('height') || '0', 10);

        if (w > 0 && h > 0 && (h < 300 || (w / h) > 1.8)) {
          continue;
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

  /* =========================================================================
   * 3. THUẬT TOÁN GIẢI MÃ DRM NICONICO (CYCLIC 8-BYTE XOR DECRYPTION)
   * ========================================================================= */
  function extractDrmHashFromUrl(url) {
    if (!url) return null;
    const match = url.match(/\/image\/([a-f0-9]+_\d+|[a-f0-9]{30,})/i);
    return match ? match[1] : null;
  }

  function decryptNiconicoXor(uint8Array, drmHash) {
    if (!drmHash || typeof drmHash !== 'string' || drmHash.length < 16) {
      return uint8Array;
    }

    try {
      const hexKey = drmHash.substring(0, 16);
      const keyBytes = new Uint8Array(8);
      for (let i = 0; i < 8; i++) {
        keyBytes[i] = parseInt(hexKey.substring(i * 2, i * 2 + 2), 16);
      }

      if (isNaN(keyBytes[0])) return uint8Array;

      const decrypted = new Uint8Array(uint8Array.length);
      for (let i = 0; i < uint8Array.length; i++) {
        decrypted[i] = uint8Array[i] ^ keyBytes[i % 8];
      }
      return decrypted;
    } catch (e) {
      return uint8Array;
    }
  }

  async function convertToGenuinePng(uint8Array) {
    const blob = new Blob([uint8Array]);
    const objUrl = WIN.URL.createObjectURL(blob);
    const img = new WIN.Image();
    img.decoding = "async";

    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("Lỗi nạp ảnh Canvas"));
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
    ctx.drawImage(img, 0, 0, width, height);

    const pngBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    canvas.width = 0;
    canvas.height = 0;

    const buffer = await pngBlob.arrayBuffer();
    return new Uint8Array(buffer);
  }

  async function processImageBytes(rawUint8Array, isJpgRequested, drmHashFromObj, imgUrl) {
    const finalHash = drmHashFromObj || extractDrmHashFromUrl(imgUrl);
    let decryptedBytes = decryptNiconicoXor(rawUint8Array, finalHash);
    const isNativeJpg = (decryptedBytes[0] === 0xFF && decryptedBytes[1] === 0xD8 && decryptedBytes[2] === 0xFF);

    if (isJpgRequested) {
      return {
        uint8Array: decryptedBytes,
        ext: 'jpg'
      };
    } else {
      if (isNativeJpg) {
        try {
          const pngBytes = await convertToGenuinePng(decryptedBytes);
          return { uint8Array: pngBytes, ext: 'png' };
        } catch (e) {
          return { uint8Array: decryptedBytes, ext: 'jpg' };
        }
      }
      return { uint8Array: decryptedBytes, ext: 'png' };
    }
  }

  /* =========================================================================
   * 4. BÓC TÁCH API TRỰC TIẾP VÀO RAM
   * ========================================================================= */
  function extractImageUrlsFromScriptPayload() {
    const foundItems = [];
    try {
      const scripts = DOC.querySelectorAll('script');
      for (const script of scripts) {
        const content = script.textContent || '';
        if (content.includes('self.__next_f') || content.includes('http')) {
          const matches = content.match(/https?:\\?\/\\?\/[^\s"',\\]+?\d+p\?[^\s"',\\]+/g);
          if (matches) {
            for (let m of matches) {
              m = m.replace(/\\/g, '');
              if (!foundItems.some(i => i.url === m)) {
                foundItems.push({ url: m, drmHash: extractDrmHashFromUrl(m) });
              }
            }
          }
        }
      }
    } catch (e) {}
    return foundItems;
  }

  async function fetchNiconicoApiPages() {
    if (state.cachedPages && state.cachedPages.length > 0) {
      return state.cachedPages;
    }

    const resultPages = [];
    let prCount = 0;
    let mainPageNo = 1;

    // 1. Quét PR Bìa Quảng cáo từ DOM nếu có
    const domPrs = await getDomPrImages(300);
    for (const prUrl of domPrs) {
      prCount++;
      resultPages.push({
        isPR: true,
        prNo: prCount,
        url: prUrl
      });
    }

    // 2. Bóc tách danh sách URL ảnh gốc từ RAM Payload
    let mainItems = extractImageUrlsFromScriptPayload();

    if (mainItems.length === 0) {
      const imgEls = DOC.querySelectorAll('img[src*="p?"], [data-src*="p?"]');
      for (const img of imgEls) {
        let src = img.getAttribute('data-src') || img.getAttribute('src') || '';
        if (src && !src.startsWith('data:')) {
          if (src.startsWith('//')) src = 'https:' + src;
          if (!mainItems.some(i => i.url === src)) {
            mainItems.push({ url: src, drmHash: extractDrmHashFromUrl(src) });
          }
        }
      }
    }

    for (const item of mainItems) {
      resultPages.push({
        isPR: false,
        pageNo: mainPageNo++,
        url: item.url,
        drmHash: item.drmHash
      });
    }

    resultPages.forEach(p => {
      if (p.isPR) p.singlePR = (prCount === 1);
    });

    state.cachedPages = resultPages;
    return resultPages;
  }

  function fetchImageArrayBuffer(url) {
    return new Promise((resolve, reject) => {
      let fullUrl = url;
      if (fullUrl.startsWith('//')) fullUrl = 'https:' + fullUrl;

      GM_xmlhttpRequest({
        method: "GET",
        url: fullUrl,
        headers: {
          "Referer": WIN.location.href,
          "User-Agent": WIN.navigator.userAgent,
          "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"
        },
        responseType: "arraybuffer",
        timeout: 25000,
        onload: res => {
          if (res.status >= 200 && res.status < 300 && res.response) {
            resolve(new Uint8Array(res.response));
          } else {
            reject(new Error(`HTTP ${res.status}`));
          }
        },
        onerror: () => reject(new Error("Lỗi mạng")),
        ontimeout: () => reject(new Error("Timeout"))
      });
    });
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
          console.error(`[nico-dl] Lỗi trang ${currentIndex + 1}:`, err);
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
   * 6. GIAO DIỆN UI (TÔNG MÀU XANH LÁ NICONICO #78b334)
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

    ui.count.textContent = completed + '/' + total;
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
    if (state.ui || !DOC.body || DOC.getElementById("nico-dl-panel")) return;

    const PANEL_WIDTH = 220;
    const TAB_WIDTH = 14;
    let isCollapsed = localStorage.getItem("nico-dl:collapsed") === '1';

    const panel = DOC.createElement("div");
    panel.id = "nico-dl-panel";
    panel.style.cssText = [
      "all:initial",
      "position:fixed",
      "right:0px",
      "top:48px",
      "z-index:2147483647",
      "box-sizing:border-box",
      `width:${PANEL_WIDTH}px`,
      "padding:10px 14px",
      "border:1px solid #84cc16",
      "border-right:none",
      "border-radius:12px 0 0 12px",
      "background: #d0e4a3",
      "color:#14532d",
      "font:12px/1.3 system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif",
      "user-select:none",
      "box-shadow:0 8px 24px rgba(0,0,0,0.15)",
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
      "background:#78b334",
      "cursor:pointer",
      "transition:opacity 0.15s, background 0.15s",
      `opacity:${isCollapsed ? "1" : "0"}`,
      `pointer-events:${isCollapsed ? "auto" : "none"}`
    ].join(';');
    collapsedStrip.title = "Mở bảng tải";
    collapsedStrip.onmouseenter = () => { collapsedStrip.style.background = "#84cc16"; };
    collapsedStrip.onmouseleave = () => { collapsedStrip.style.background = "#78b334"; };

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
      "background:#78b334",
      "color:#ffffff",
      "font:900 10px system-ui,sans-serif",
      "cursor:pointer",
      "transition:background 0.15s ease",
      "z-index:2"
    ].join(';');
    collapseBtn.onmouseenter = () => { collapseBtn.style.background = "#84cc16"; };
    collapseBtn.onmouseleave = () => { collapseBtn.style.background = "#78b334"; };

    const title = DOC.createElement("div");
    title.textContent = "Niconico Downloader";
    title.style.cssText = "all:initial;display:block;color:#365314;font:800 13px system-ui;margin-bottom:8px;text-align:center;padding-left:14px;";

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
      "background:#78b334",
      "color:#ffffff",
      "font:800 14px/1.2 system-ui,sans-serif",
      "text-align:center",
      "cursor:pointer",
      "box-shadow:0 3px 10px rgba(120, 179, 52, 0.35)"
    ].join(';');

    btn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      if (!state.running) startDownload();
    });

    const label = DOC.createElement("label");
    label.style.cssText = "all:initial;display:inline-flex;align-items:center;gap:6px;margin-top:8px;color:#3f6212;font:700 11px system-ui;cursor:pointer;";

    const jpgInput = DOC.createElement("input");
    jpgInput.type = "checkbox";
    jpgInput.checked = state.convertJpeg;
    jpgInput.style.cssText = "all:initial;appearance:auto;width:14px;height:14px;accent-color:#78b334;cursor:pointer;";
    jpgInput.addEventListener("change", () => {
      state.convertJpeg = jpgInput.checked;
      saveJpegPref(state.convertJpeg);
    });

    const spanJpg = DOC.createElement("span");
    spanJpg.textContent = "Xuất file JPG (mặc định PNG)";
    spanJpg.style.cssText = "all:initial;color:#3f6212;font:700 11px system-ui;";
    label.append(jpgInput, spanJpg);

    const progressRow = DOC.createElement("div");
    progressRow.style.cssText = "all:initial;display:flex;justify-content:space-between;align-items:center;margin-top:10px;color:#14532d;font:800 12px system-ui;";

    const countText = DOC.createElement("span");
    countText.textContent = "0/0";
    countText.style.cssText = "all:initial;color:#14532d;font:800 12px system-ui;";

    const percentText = DOC.createElement("span");
    percentText.textContent = "0%";
    percentText.style.cssText = "all:initial;color:#14532d;font:800 12px system-ui;";

    progressRow.append(countText, percentText);

    const track = DOC.createElement("div");
    track.style.cssText = "all:initial;display:block;height:6px;overflow:hidden;border-radius:3px;background:#d9f99d;margin-top:6px;";

    const fill = DOC.createElement("div");
    fill.style.cssText = "all:initial;display:block;width:100%;height:100%;background:#65a30d;transform:scaleX(0);transform-origin:left center;transition:transform .22s ease;";
    track.appendChild(fill);

    const statusText = DOC.createElement("div");
    statusText.textContent = state.lastProgress.status;
    statusText.style.cssText = "all:initial;display:block;margin-top:8px;color:#4d7c0f;font:11px system-ui;word-break:break-word;";

    mainContent.append(collapseBtn, title, btn, label, progressRow, track, statusText);
    panel.append(collapsedStrip, mainContent);

    function setCollapsedState(collapsed) {
      isCollapsed = collapsed;
      localStorage.setItem("nico-dl:collapsed", isCollapsed ? '1' : '0');

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

      const pages = await fetchNiconicoApiPages();
      const totalPages = pages.length;

      if (!totalPages) {
        throw new Error("Không tìm thấy trang truyện.");
      }

      const useJpeg = Boolean(state.convertJpeg);
      const zip = new PureZipWriter();
      const episodeId = getEpisodeId();

      // Đính kèm file txt định danh ID tập
      zip.addFile(`${episodeId}.txt`, new Uint8Array(0));

      updateProgressUI({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map((pageObj) => async () => {
        const rawBuffer = await fetchImageArrayBuffer(pageObj.url);

        // 1. Ảnh PR: Giữ nguyên định dạng gốc
        if (pageObj.isPR) {
          let ext = getExtensionFromUrl(pageObj.url);
          const fileName = pageObj.singlePR ? `PR.${ext}` : `PR_${pageObj.prNo}.${ext}`;
          return {
            fileName: fileName,
            data: rawBuffer
          };
        }

        // 2. Trang truyện chính: GIẢI MÃ DRM XOR VỚI KHÓA 8-BYTE CYCLIC
        const processed = await processImageBytes(rawBuffer, useJpeg, pageObj.drmHash, pageObj.url);
        return {
          fileName: `${pageObj.pageNo}.${processed.ext}`,
          data: processed.uint8Array
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
        if (res && res.data && res.data.length > 0) {
          zip.addFile(res.fileName, res.data);
          savedCount++;
        }
      }

      if (savedCount === 0) {
        throw new Error("Lỗi nạp file vào ZIP.");
      }

      const zipBlob = zip.generateBlob();
      const zipFileName = `${getCleanMangaTitle()}.zip`;
      triggerDownload(zipBlob, zipFileName);

      updateProgressUI({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      const msg = err?.message || String(err);
      updateProgressUI({ status: "Lỗi: " + msg });
      console.error("[nico-dl] Download Error:", err);
    } finally {
      state.running = false;
      setUiBusy(false);
      updateProgressUI(state.lastProgress);
    }
  }

  /* =========================================================================
   * 8. ROUTE WATCHER & BOOT
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
      if (state.ui?.panel) {
        state.ui.panel.style.display = "none";
      }
      return;
    }

    if (state.ui?.panel) {
      state.ui.panel.style.display = "block";
    }

    updateProgressUI({ completed: 0, total: 0, status: "Đang kiểm tra..." });

    let pages = [];
    let retries = 0;
    let lastError = null;

    while (retries < 25) {
      if (!isEpisodeUrl()) return;
      try {
        pages = await fetchNiconicoApiPages();
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
        status: lastError ? `${lastError.message || lastError}` : "Đang kiểm tra..."
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