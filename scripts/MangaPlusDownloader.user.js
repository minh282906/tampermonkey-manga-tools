// ==UserScript==
// @name         MANGA Plus Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      2.0.1
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
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/MangaPlusDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/MangaPlusDownloader.user.js
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
    MAX_CONCURRENT: 6   // 6 luồng tải song song
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(r => WIN.setTimeout(r, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    chapterData: null,
    capturedPayloadRaw: null,
    capturedChapterId: null,
    ui: null,
    lastUrl: "",
    lastChapterId: "",
    bootGeneration: 0
  };

  /* =========================================================================
   * BỘ ĐỆM CACHE BASE64 (TƯƠNG THÍCH CẢ ARRAY CŨ LẪN BASE64 MỚI)
   * ========================================================================= */
  function encodeArrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return WIN.btoa(binary);
  }

  function decodeBase64ToArrayBuffer(b64) {
    const binary = WIN.atob(b64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  function loadCachedBuffer(cid) {
    try {
      const rawStr = sessionStorage.getItem(`mplus_raw_${cid}`);
      if (rawStr) return decodeBase64ToArrayBuffer(rawStr);
    } catch (e) {}
    return null;
  }

  /* =========================================================================
   * 2. MAIN-WORLD DIRECT HOOK: ĐỒNG BỘ TRỰC TIẾP TRÊN UNSAFEWINDOW
   * ========================================================================= */
  function handleViewerPayload(rawBuffer, reqUrl) {
    if (!rawBuffer) return;
    const urlCid = (typeof reqUrl === 'string') ? reqUrl.match(/chapter_id=(\d+)/i)?.[1] : null;
    const cid = urlCid || getChapterId();
    if (!cid) return;

    // Nếu đã có dữ liệu hoàn chỉnh của đúng chương này thì bỏ qua (tránh re-boot khi web tải muộn)
    if (state.chapterData && String(state.chapterData.chapterId) === String(cid)) {
      return;
    }

    // Kiểm tra tính hợp lệ của Protobuf trước khi nhận (chống bắt nhầm payload lỗi / account banned)
    const parsed = parseProtobufData(rawBuffer);
    if (!parsed || !parsed.pages || parsed.pages.length === 0) return;

    state.capturedPayloadRaw = rawBuffer;
    state.capturedChapterId = cid;

    try {
      sessionStorage.setItem(`mplus_raw_${cid}`, encodeArrayBufferToBase64(rawBuffer));
    } catch (e) {}

    state.chapterData = {
      chapterId: cid,
      ...parsed
    };

    if (isEpisodeUrl() && !state.running) {
      boot();
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
        onDownload: startDownload
      };

      state.ui = createUI(uiConfig);
      state.ui.setBusy(true);

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
    try {
      if (rawInput instanceof Uint8Array) {
        uint8 = rawInput;
      } else if (rawInput.byteLength !== undefined && rawInput.buffer !== undefined) {
        uint8 = new Uint8Array(rawInput.buffer, rawInput.byteOffset || 0, rawInput.byteLength);
      } else if (rawInput.byteLength !== undefined) {
        uint8 = new Uint8Array(rawInput);
      } else if (Array.isArray(rawInput)) {
        uint8 = new Uint8Array(rawInput);
      } else if (typeof rawInput === 'string') {
        uint8 = new TextEncoder().encode(rawInput);
      } else {
        uint8 = new Uint8Array(rawInput);
      }
    } catch (e) {
      return null;
    }

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

  function getSessionId() {
    try {
      const v = localStorage.getItem("SESSION_ID_KEY") || WIN.localStorage?.getItem("SESSION_ID_KEY");
      if (v) return v;
    } catch (e) {}

    const newId = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : (WIN.crypto?.randomUUID ? WIN.crypto.randomUUID() : (Math.random().toString(36).substring(2) + Date.now().toString(36)));

    try { localStorage.setItem("SESSION_ID_KEY", newId); } catch (e) {}
    try { WIN.localStorage?.setItem("SESSION_ID_KEY", newId); } catch (e) {}
    return newId;
  }

  /* =========================================================================
   * 7. DUAL-FLIGHT SCANNER & ĐỒNG BỘ TIẾN TRÌNH UI
   * ========================================================================= */
  async function fetchManifestDirect(chapterId) {
    const targetUrl = `https://jumpg-webapi.tokyo-cdn.com/api/manga_viewer_v3?chapter_id=${chapterId}&split=yes&img_quality=super_high&viewer_mode=horizontal&clang=eng`;
    const sessionId = getSessionId();

    try {
      const res = await WIN.fetch(targetUrl, {
        mode: 'cors',
        headers: {
          "SESSION-TOKEN": sessionId
        }
      });
      if (res.ok) {
        const buf = await res.arrayBuffer();
        if (buf && buf.byteLength > 100) {
          const parsed = parseProtobufData(buf);
          if (parsed && parsed.pages?.length > 0) return buf;
        }
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
            "SESSION-TOKEN": sessionId,
            "User-Agent": navigator.userAgent,
            "Accept": "*/*"
          },
          timeout: 15000,
          onload: res => {
            if (res.status >= 200 && res.status < 300 && res.response) {
              const parsed = parseProtobufData(res.response);
              if (parsed && parsed.pages?.length > 0) return resolve(res.response);
            }
            reject(new Error(`HTTP ${res.status} hoặc payload không hợp lệ`));
          },
          onerror: reject,
          ontimeout: () => reject(new Error("Timeout"))
        });
      });
    } catch (e) {}

    return null;
  }

  let syncPromise = null;
  async function syncChapterData() {
    if (syncPromise) return syncPromise;
    syncPromise = (async () => {
      try {
        const currentChapterId = getChapterId();
        if (!currentChapterId) return;

        // 1. Nếu đã có dữ liệu hoàn chỉnh của đúng chương này thì bỏ qua
        if (state.chapterData && String(state.chapterData.chapterId) === String(currentChapterId) && state.chapterData.pages?.length > 0) {
          return;
        }

        // 2. [CỨU TINH F5 - 0ms]: Kiểm tra bộ nhớ đệm sessionStorage hoặc gói tin vừa hứng
        let rawBuffer = (state.capturedPayloadRaw && String(state.capturedChapterId) === String(currentChapterId))
          ? state.capturedPayloadRaw
          : loadCachedBuffer(currentChapterId);

        // 3. TỰ CHỦ LẤY MANIFEST SIÊU TỐC (~200ms) BẰNG SESSION-TOKEN
        // Thay vì bị động chờ web viewer 4.5s (dễ bị timeout khi cold paste),
        // chủ động gọi fetchManifestDirect ngay để sẵn sàng lập tức trong 200ms!
        if (!rawBuffer) {
          rawBuffer = await fetchManifestDirect(currentChapterId);
          if (rawBuffer) {
            state.capturedPayloadRaw = rawBuffer;
            state.capturedChapterId = currentChapterId;
            try {
              sessionStorage.setItem(`mplus_raw_${currentChapterId}`, encodeArrayBufferToBase64(rawBuffer));
            } catch (e) {}
          }
        }

        // 4. DỰ PHÒNG: Nếu direct fetch chưa về (mạng chập chờn), đợi tối đa 1500ms gói tin tự nhiên từ web
        if (!rawBuffer) {
          const startWait = Date.now();
          while (Date.now() - startWait < 1500) {
            if (state.capturedPayloadRaw && String(state.capturedChapterId) === String(currentChapterId)) {
              rawBuffer = state.capturedPayloadRaw;
              break;
            }
            await sleep(100);
          }
        }

        if (!rawBuffer) return;

        const parsed = parseProtobufData(rawBuffer);
        if (!parsed || !parsed.pages || parsed.pages.length === 0) return;

        state.chapterData = {
          chapterId: currentChapterId,
          pages: parsed.pages,
          vwToken: parsed.vwToken,
          globalKey: parsed.globalKey,
          titleName: parsed.titleName,
          chapterName: parsed.chapterName,
          chapterSubTitle: parsed.chapterSubTitle
        };
      } finally {
        syncPromise = null;
      }
    })();
    return syncPromise;
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

  async function processMangaPlusImage(pageObj, token) {
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

    const ext = Utils.detectExt(uint8.buffer);

    return {
      pageNo: pageObj.pageNo,
      fileName: `${pageObj.pageNo}.${ext}`,
      data: uint8
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

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      zip.addFile(`${chapterId}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map((pageObj) => async () => {
        return await processMangaPlusImage(pageObj, vwToken);
      });

      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res?.data) zip.addFile(res.fileName, res.data);
      }

      const zipName = `${getCleanTitle(data)}.zip`;
      zip.download(zipName);

      if (ui) {
        ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
        ui.setBusy(false);
      }
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[mplus-dl] Error:", err);
    } finally {
      state.running = false;
    }
  }

  /* =========================================================================
   * 10. KHỞI TẠO & THEO DÕI ĐIỀU HƯỚNG SPA
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(20);
    const ui = getUI();

    if (!isEpisodeUrl()) {
      if (ui?.panel) ui.panel.style.display = "none";
      return;
    }

    const currentCid = getChapterId();
    if (!currentCid) {
      if (ui?.panel) ui.panel.style.display = "none";
      return;
    }

    // Đánh dấu ngay ID và URL hiện tại để chặn RouteWatcher kích hoạt nhầm khi Vue hydration
    state.lastChapterId = currentCid;
    state.lastUrl = WIN.location.href;

    const currentToken = ++state.bootGeneration;

    if (ui?.panel) {
      ui.panel.style.display = "block";
      // Nếu đã có sẵn chapterData của đúng tập này (ví dụ F5 hoặc vừa bắt gói tin), không giật UI về "Đang kiểm tra..."
      if (!state.chapterData || String(state.chapterData.chapterId) !== String(currentCid)) {
        ui.setBusy(true);
        ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
      }
    }

    try {
      await syncChapterData();
      if (currentToken !== state.bootGeneration) return; // Đã có phiên boot mới hơn, dừng lại

      if (!state.chapterData?.pages?.length) {
        throw new Error("Không lấy được dữ liệu trang.");
      }

      const data = state.chapterData;

      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const testBuf = await fetchImageGM(data.pages[0].url, data.vwToken); // bên này dùng data.pages[0].url
      if (!testBuf) throw new Error("Không thể tải ảnh trang 1.");

      const dec = decryptMangaPlusXor(new Uint8Array(testBuf), data.globalKey);
      const realExt = Utils.detectExt(dec.buffer);
      if (!realExt) throw new Error("Không thể nhận diện Magic Bytes ảnh.");

      if (currentToken !== state.bootGeneration) return;

      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: data.pages.length,
          status: "Sẵn sàng.",
          format: realExt
        });
        ui.setBusy(false);
      }
    } catch (err) {
      if (currentToken !== state.bootGeneration) return;
      console.error("[mplus-dl] Boot error:", err);
      if (ui && !state.chapterData?.pages?.length) {
        ui.updateProgress({ status: "Lỗi: " + (err?.message || "không thể tải trang.") });
      }
    }
  }

  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute((newUrl) => {
      if (!isEpisodeUrl()) {
        const ui = getUI();
        if (ui?.panel) ui.panel.style.display = "none";
        state.chapterData = null;
        state.lastChapterId = "";
        state.lastUrl = ""; 
        state.capturedPayloadRaw = null;
        state.capturedChapterId = null;
        state.running = false;
        return;
      }

      const currentCid = getChapterId();
      if (!currentCid) return;

      // Tuyệt đối không reset hay chạy lại boot nếu vẫn đang ở cùng 1 chương (tránh nuốt gói tin khi Vue hydration)
      if (state.lastChapterId === currentCid || (state.chapterData && String(state.chapterData.chapterId) === String(currentCid))) {
        state.lastUrl = newUrl;
        return;
      }

      state.lastUrl = newUrl;
      state.lastChapterId = currentCid;
      state.chapterData = null;
      state.running = false;

      // Chỉ xóa capturedPayloadRaw nếu nó là của tập cũ, không xóa nhầm gói tin mới vừa hứng được
      if (state.capturedChapterId && String(state.capturedChapterId) !== String(currentCid)) {
        state.capturedPayloadRaw = null;
        state.capturedChapterId = null;
      }

      const ui = getUI();
      if (ui) {
        ui.setBusy(true);
        ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
      }
      boot();
    });
  }
  boot();
})();