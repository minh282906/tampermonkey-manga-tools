// ==UserScript==
// @name         MANGA Plus Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://mangaplus.shueisha.co.jp/favicon.ico
// @description  Tải manga chất lượng High (cao nhất) trên MANGA Plus by SHUEISHA.
// @author       anonymous & AI
// @match        https://mangaplus.shueisha.co.jp/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      mangaplus.shueisha.co.jp
// @connect      jumpg-webapi.tokyo-cdn.com
// @connect      *.tokyo-cdn.com
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function mangaPlusUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * 1. CẤU HÌNH & KHỞI TẠO HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6,   // 6 luồng tải song song
    JPEG_QUALITY: 0.95   // Chất lượng xuất JPG nếu chuyển đổi
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(r => WIN.setTimeout(r, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("mplus-dl:convert-jpeg") === '1',
    detectedSourceFormat: 'jpg',
    chapterData: null,
    capturedPayloadRaw: null,
    capturedChapterId: null,
    ui: null,
    lastUrl: ""
  };

  /* =========================================================================
   * 2. MAIN-WORLD DIRECT HOOK: ĐỒNG BỘ TRỰC TIẾP TRÊN UNSAFEWINDOW
   * ========================================================================= */
  function handleViewerPayload(rawBuffer, url) {
    if (!rawBuffer) return;
    state.capturedPayloadRaw = rawBuffer;
    const cid = getChapterId();
    if (cid) {
      state.capturedChapterId = cid;
      try {
        const uint8 = new Uint8Array(rawBuffer);
        sessionStorage.setItem(`mplus_raw_${cid}`, JSON.stringify(Array.from(uint8)));
      } catch (e) {}
    }

    if (isEpisodeUrl() && !state.running) {
      syncChapterData();
    }
  }

  function installDirectHooks() {
    const isViewerReq = u => {
      const s = String(u || '');
      return s.includes('/api/manga_viewer') || (s.includes('tokyo-cdn.com') && s.includes('viewer'));
    };

    const toSuperHigh = u => String(u).replace(/img_quality=(?:low|medium|high)/g, 'img_quality=super_high');

    // Hook WIN.fetch
    const origFetch = WIN.fetch;
    if (typeof origFetch === 'function' && !origFetch.__mplus_hooked) {
      WIN.fetch = async function(...args) {
        let u = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        if (isViewerReq(u)) {
          u = toSuperHigh(u);
          if (typeof args[0] === 'string') args[0] = u;
          else if (args[0]?.url) args[0].url = u;
        }
        const res = await origFetch.apply(this, args);
        if (isViewerReq(u)) {
          try {
            const clone = res.clone();
            const buf = await clone.arrayBuffer();
            handleViewerPayload(buf, u);
          } catch (e) {}
        }
        return res;
      };
      WIN.fetch.__mplus_hooked = true;
    }

    // Hook WIN.XMLHttpRequest
    const origOpen = WIN.XMLHttpRequest?.prototype?.open;
    const origSend = WIN.XMLHttpRequest?.prototype?.send;
    if (origOpen && origSend && !origOpen.__mplus_hooked) {
      WIN.XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        if (isViewerReq(url)) {
          url = toSuperHigh(url);
        }
        this._mplus_url = url;
        return origOpen.call(this, method, url, ...rest);
      };

      WIN.XMLHttpRequest.prototype.send = function(...args) {
        this.addEventListener('load', () => {
          if (this._mplus_url && isViewerReq(this._mplus_url)) {
            try {
              let raw = (this.responseType === '' || this.responseType === 'text') ? this.responseText : this.response;
              if (raw) handleViewerPayload(raw, this._mplus_url);
            } catch (e) {}
          }
        });
        return origSend.apply(this, args);
      };
      origOpen.__mplus_hooked = true;
    }
  }

  installDirectHooks();

  /* =========================================================================
   * 3. GIAO DIỆN UNIVERSAL UI CHUẨN 2 TẦNG
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "mplus-dl",
        title: "MANGA Plus",
        engine: "SHUEISHA",
        themeColor: "#d32f2f",
        themeBg: "#18181b",
        titleColor: "#ef4444",
        topOffset: "88px",
        defaultJpgText: "Xuất file JPG (ảnh gốc là JPG)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("mplus-dl:convert-jpeg", checked ? '1' : '0');
        }
      };

      state.ui = createUI(uiConfig);
      state.ui.updateFormatUI(state.detectedSourceFormat);

      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:${uiConfig.titleColor};letter-spacing:0.2px;">${uiConfig.title}</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:1px;visibility:hidden;">${uiConfig.engine}</div>
          `;
        }
      }
    }
    return state.ui;
  }

  /* =========================================================================
   * 4. BỘ HỖ TRỢ XỬ LÝ CHUỖI & TÊN FILE
   * ========================================================================= */
  function isEpisodeUrl() {
    return /\/viewer\/\d+/i.test(WIN.location.pathname);
  }

  function getChapterId() {
    const match = WIN.location.pathname.match(/\/viewer\/(\d+)/i);
    return match ? match[1] : "";
  }

  function cleanString(str) {
    if (!str) return "";
    return str
      .replace(/[\uFFFD\u0000-\u001F\u007F-\u009F\u00AD]/g, '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/【[^】]*】/g, '')
      .replace(/[\\/*?:"<>|]/g, ' ')
      .replace(/^['"‘’“”`\s]+|['"‘’“”`\s]+$/g, '')
      .trim();
  }

  function getCleanTitle(meta) {
    let series = cleanString(meta?.titleName);
    let chapNum = cleanString(meta?.chapterName);
    let chapSub = cleanString(meta?.chapterSubTitle);

    if (!series || !chapNum) {
      const rawOg = (DOC.querySelector('meta[property="og:title"]')?.getAttribute('content') || DOC.title || "").split(/[|｜]/)[0].trim();
      let cleanOg = rawOg.replace(/MANGA\s*Plus\s*(?:by\s*SHUEISHA)?/gi, '').trim();

      const kMatch = cleanOg.match(/^\[(#?\d+)\]\s*(.*)$/);
      if (kMatch) {
        if (!chapNum) chapNum = cleanString(kMatch[1]);
        if (!series) series = cleanString(kMatch[2]);
      } else {
        if (!series) series = cleanString(cleanOg);
      }
    }

    if (!chapSub) {
      const domSub = DOC.querySelector('[class*="chapter_title"], [class*="chapterTitle"], [class*="Viewer-module_chapter"], [class*="subTitle"]');
      if (domSub) chapSub = cleanString(domSub.textContent);
    }

    series = cleanString(series);
    chapNum = cleanString(chapNum);
    chapSub = cleanString(chapSub);

    let episodeFull = chapNum;
    if (chapSub && chapSub !== chapNum) {
      episodeFull = episodeFull ? `${episodeFull} ${chapSub}` : chapSub;
    }

    episodeFull = cleanString(episodeFull);

    if (series && episodeFull) {
      if (episodeFull.startsWith(series)) {
        episodeFull = cleanString(episodeFull.substring(series.length));
      }
      episodeFull = episodeFull.replace(/^[-－–—\s・:]+/, '').trim();
      return `${series} - ${episodeFull}`;
    }

    return series || episodeFull || `MangaPlus_${getChapterId()}`;
  }

  function getExtensionFromUrl(url, defaultExt = 'jpg') {
    try {
      const match = url.split('?')[0].match(/\.([a-zA-Z0-9]+)$/);
      if (match && match[1]) {
        const ext = match[1].toLowerCase();
        if (['jpg', 'jpeg', 'png', 'webp', 'avif'].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext;
      }
    } catch (e) {}
    return defaultExt;
  }

  function unhex(hexString) {
    const arr = new Uint8Array(hexString.length / 2);
    for (let i = 0; i < hexString.length; i += 2) {
      arr[i / 2] = parseInt(hexString.substring(i, i + 2), 16);
    }
    return arr;
  }

  /* =========================================================================
   * 5. THUẬT TOÁN GIẢI MÃ CYCLIC XOR (64-BYTE KEY / 128 HEX CHARS)
   * ========================================================================= */
  function decryptMangaPlusXor(uint8Array, hexKey) {
    if (!hexKey || hexKey.length < 2) return uint8Array;

    const keyBytes = unhex(hexKey);
    const keyLen = keyBytes.length;
    const decrypted = new Uint8Array(uint8Array.length);

    for (let i = 0; i < uint8Array.length; i++) {
      decrypted[i] = uint8Array[i] ^ keyBytes[i % keyLen];
    }
    return decrypted;
  }

  /* =========================================================================
   * 6. BÓC TÁCH PROTOBUF UTF-8 CHÍNH XÁC
   * ========================================================================= */
  function parseProtobufData(rawInput) {
    if (!rawInput) return null;

    let uint8;
    if (rawInput instanceof ArrayBuffer) uint8 = new Uint8Array(rawInput);
    else if (ArrayBuffer.isView(rawInput)) uint8 = new Uint8Array(rawInput.buffer, rawInput.byteOffset, rawInput.byteLength);
    else if (Array.isArray(rawInput)) uint8 = new Uint8Array(rawInput);
    else return null;

    const textLatin1 = new TextDecoder('latin1').decode(uint8);
    const textUtf8 = new TextDecoder('utf-8', { fatal: false }).decode(uint8);

    const keyMatch = textLatin1.match(/[0-9a-f]{128}/i);
    const globalKey = keyMatch ? keyMatch[0] : "";

    const textWithoutKey = globalKey ? textLatin1.split(globalKey).join('') : textLatin1;
    const tokenMatches = [...textWithoutKey.matchAll(/\b([0-9a-f]{32})\b/gi)].map(m => m[1]);
    const vwToken = tokenMatches.length > 0 ? tokenMatches[tokenMatches.length - 1] : "";

    const pages = [];
    const urlRegex = /https?:\/\/jumpg-assets[^\s"'<>\x00-\x1f]+?\/manga_page\/[^\s"'<>\x00-\x1f]+/gi;
    let match;
    const seenUrls = new Set();

    while ((match = urlRegex.exec(textLatin1)) !== null) {
      let imgUrl = match[0];
      if (seenUrls.has(imgUrl)) continue;
      seenUrls.add(imgUrl);

      pages.push({
        pageNo: pages.length + 1,
        url: imgUrl,
        key: globalKey
      });
    }

    if (pages.length === 0) return null;

    let titleName = "";
    let chapterName = "";
    let chapterSubTitle = "";

    try {
      const cMatch = textUtf8.match(/#\d{3,4}/);
      if (cMatch) chapterName = cMatch[0];

      const subMatch = textUtf8.match(/(\d+:\s*[A-Za-z0-9\s,.\-–—!'?\u3000-\u30ff\u4e00-\u9faf\u00c0-\u024f]+)/);
      if (subMatch) chapterSubTitle = cleanString(subMatch[1]);
    } catch (e) {}

    return {
      pages,
      globalKey,
      vwToken,
      titleName,
      chapterName,
      chapterSubTitle
    };
  }

  /* =========================================================================
   * 7. DUAL-FLIGHT SCANNER & ĐỒNG BỘ TIẾN TRÌNH UI
   * ========================================================================= */
  async function fetchManifestDirect(chapterId) {
    let targetUrl = "";

    if (typeof WIN.performance?.getEntriesByType === 'function') {
      const entries = WIN.performance.getEntriesByType('resource');
      const vEntry = entries.find(r => r.name && (r.name.includes('/api/manga_viewer') || (r.name.includes('tokyo-cdn.com') && r.name.includes('viewer'))));
      if (vEntry) {
        targetUrl = vEntry.name.replace(/img_quality=(?:low|medium|high)/g, 'img_quality=super_high');
      }
    }

    if (!targetUrl) {
      targetUrl = `https://jumpg-webapi.tokyo-cdn.com/api/manga_viewer_v3?chapter_id=${chapterId}&split=yes&img_quality=super_high&viewer_mode=horizontal&clang=eng`;
    }

    try {
      const res = await WIN.fetch(targetUrl, { mode: 'cors' });
      if (res.ok) {
        const buf = await res.arrayBuffer();
        if (buf && buf.byteLength > 100) return buf;
      }
    } catch (e) {}

    try {
      return await new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "GET",
          url: targetUrl,
          responseType: "arraybuffer",
          headers: {
            "Origin": "https://mangaplus.shueisha.co.jp",
            "Referer": `https://mangaplus.shueisha.co.jp/viewer/${chapterId}`,
            "Accept": "*/*"
          },
          timeout: 15000,
          onload: res => (res.status >= 200 && res.status < 300 && res.response) ? resolve(res.response) : reject(new Error(`HTTP ${res.status}`)),
          onerror: reject,
          ontimeout: () => reject(new Error("Timeout"))
        });
      });
    } catch (e) {}

    return null;
  }

  async function syncChapterData() {
    const currentChapterId = getChapterId();
    if (!currentChapterId) return;

    let rawBuffer = state.capturedPayloadRaw;

    if (!rawBuffer) {
      try {
        const cachedStr = sessionStorage.getItem(`mplus_raw_${currentChapterId}`);
        if (cachedStr) {
          const arr = JSON.parse(cachedStr);
          if (Array.isArray(arr)) rawBuffer = new Uint8Array(arr).buffer;
        }
      } catch (e) {}
    }

    if (!rawBuffer) {
      rawBuffer = await fetchManifestDirect(currentChapterId);
      if (rawBuffer) state.capturedPayloadRaw = rawBuffer;
    }

    if (!rawBuffer) return;

    const parsed = parseProtobufData(rawBuffer);
    if (!parsed || parsed.pages.length === 0) return;

    state.chapterData = {
      chapterId: currentChapterId,
      pages: parsed.pages,
      vwToken: parsed.vwToken,
      globalKey: parsed.globalKey,
      titleName: parsed.titleName,
      chapterName: parsed.chapterName,
      chapterSubTitle: parsed.chapterSubTitle
    };

    const ui = getUI();
    if (ui && !state.running) {
      const firstExt = getExtensionFromUrl(parsed.pages[0]?.url || "", 'jpg');
      state.detectedSourceFormat = firstExt;
      if (ui.updateFormatUI) ui.updateFormatUI(firstExt);

      await sleep(80);

      ui.updateProgress({
        completed: 0,
        total: parsed.pages.length,
        status: "Sẵn sàng."
      });
    }
  }

  /* =========================================================================
   * 8. TẢI ẢNH SIÊU TỐC QUA GM_XHR KÈM TOKEN
   * ========================================================================= */
  function fetchImageGM(url, token) {
    return new Promise((resolve, reject) => {
      const headers = {
        "Referer": "https://mangaplus.shueisha.co.jp/",
        "Origin": "https://mangaplus.shueisha.co.jp",
        "User-Agent": navigator.userAgent,
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
      };
      if (token) headers["Cookie"] = `plus_vw_token=${token}`;

      GM_xmlhttpRequest({
        method: "GET",
        url: url,
        responseType: "arraybuffer",
        headers: headers,
        cookie: token ? `plus_vw_token=${token}` : undefined,
        timeout: 20000,
        onload: (res) => (res.status >= 200 && res.status < 300 && res.response) ? resolve(res.response) : reject(new Error(`HTTP ${res.status}`)),
        onerror: () => reject(new Error("Lỗi mạng GM_xhr")),
        ontimeout: () => reject(new Error("Timeout CDN"))
      });
    });
  }

  async function processMangaPlusImage(pageObj, token, forceJpg) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    let rawBuffer = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        rawBuffer = await fetchImageGM(pageObj.url, token);
        if (rawBuffer && rawBuffer.byteLength > 100) break;
      } catch (err) {
        if (attempt === 3) throw err;
      }
    }

    if (!rawBuffer) throw new Error(`Trang ${pageObj.pageNo} lỗi`);

    let uint8 = new Uint8Array(rawBuffer);
    if (pageObj.key) {
      uint8 = decryptMangaPlusXor(uint8, pageObj.key);
    }

    let ext = 'jpg';
    if (uint8[0] === 0x52 && uint8[1] === 0x49 && uint8[2] === 0x46 && uint8[3] === 0x46) ext = 'webp';
    else if (uint8[0] === 0x89 && uint8[1] === 0x50 && uint8[2] === 0x4E && uint8[3] === 0x47) ext = 'png';
    else if (uint8[0] === 0xFF && uint8[1] === 0xD8 && uint8[2] === 0xFF) ext = 'jpg';

    if (!forceJpg || ext === 'jpg') {
      return {
        pageNo: pageObj.pageNo,
        fileName: `${pageObj.pageNo}.${ext}`,
        data: uint8
      };
    }

    const img = await Utils.loadImage(uint8, `image/${ext}`);
    const canvas = DOC.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);

    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', CONFIG.JPEG_QUALITY));
    canvas.width = 0;
    canvas.height = 0;

    return {
      pageNo: pageObj.pageNo,
      fileName: `${pageObj.pageNo}.jpg`,
      data: new Uint8Array(await blob.arrayBuffer())
    };
  }

  /* =========================================================================
   * 9. TIẾN TRÌNH TẢI CHÍNH (6 LUỒNG TRONG RAM)
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    const chapterId = getChapterId();
    if (!chapterId) {
      if (ui) ui.updateProgress({ status: "Lỗi: Không tìm thấy ID chương." });
      return;
    }

    if (!state.chapterData?.pages?.length) {
      await syncChapterData();
    }

    if (!state.chapterData?.pages?.length) {
      if (ui) ui.updateProgress({ status: "Lỗi: Không có dữ liệu trang." });
      return;
    }

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      const data = state.chapterData;
      const { pages, vwToken } = data;
      const totalPages = pages.length;
      const forceJpg = Boolean(state.convertJpeg);

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      zip.addFile(`${chapterId}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const resultMap = new Map();

      const tasks = pages.map((pageObj) => async () => {
        try {
          const res = await processMangaPlusImage(pageObj, vwToken, forceJpg);
          if (res?.data) {
            resultMap.set(pageObj.pageNo, res);
          }
        } catch (e) {}
      });

      await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, () => {
        if (ui) ui.updateProgress({ completed: resultMap.size, total: totalPages, status: "Đang tải..." });
      });

      if (resultMap.size < totalPages) {
        if (ui) ui.updateProgress({ completed: resultMap.size, total: totalPages, status: "Đang tải bù các trang sót..." });
        for (const pageObj of pages) {
          if (!resultMap.has(pageObj.pageNo)) {
            try {
              const res = await processMangaPlusImage(pageObj, vwToken, forceJpg);
              if (res?.data) resultMap.set(pageObj.pageNo, res);
            } catch (e) {}
          }
        }
      }

      if (resultMap.size < totalPages) {
        throw new Error(`Tải thiếu ${totalPages - resultMap.size}/${totalPages} trang. Vui lòng bấm Tải lại!`);
      }

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      const sortedPages = Array.from(resultMap.values()).sort((a, b) => a.pageNo - b.pageNo);
      for (const res of sortedPages) {
        zip.addFile(res.fileName, res.data);
      }

      const zipName = `${getCleanTitle(data)}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[mplus-dl] Error:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * 10. KHỞI TẠO & THEO DÕI ĐIỀU HƯỚNG SPA
   * ========================================================================= */
  function ensureUIPresence() {
    if (!isEpisodeUrl()) {
      if (state.ui?.panel) state.ui.panel.style.display = "none";
      return;
    }
    const ui = getUI();
    if (ui?.panel) {
      ui.panel.style.display = "block";
      if (!DOC.body.contains(ui.panel)) DOC.body.appendChild(ui.panel);
    }
  }

  async function boot() {
    while (!DOC.body) await sleep(30);

    ensureUIPresence();
    const ui = getUI();

    if (!isEpisodeUrl()) return;
    if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });

    let retries = 0;
    while (retries < 25) {
      await syncChapterData();
      if (state.chapterData?.pages?.length > 0) break;
      await sleep(150);
      retries++;
    }

    if (!state.chapterData?.pages?.length) {
      if (ui) ui.updateProgress({ status: "Sẵn sàng." });
    }
  }

  setInterval(() => {
    if (isEpisodeUrl() && DOC.body) ensureUIPresence();
  }, 500);

  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute((newUrl) => {
      if (newUrl === state.lastUrl) return;
      state.lastUrl = newUrl;

      state.chapterData = null;
      state.capturedPayloadRaw = null;
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