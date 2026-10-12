// ==UserScript==
// @name         Mecha Comic Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      2.0.0
// @icon         https://www.google.com/s2/favicons?domain=mechacomic.jp&sz=128
// @description  Tải manga trên Mecha Comic (mechacomic.jp) All-in-One.
// @author       anonymous & AI
// @match        https://mechacomic.jp/viewer/*
// @match        https://mechacomic.jp/books/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      mechacomic.jp
// @connect      *.mechacomic.jp
// @connect      *.cnt.mechacomic.jp
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function mechaComicUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6   // 6 luồng kịch trần TCP Socket
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    chapterData: null,
    ui: null,
    lastUrl: "",
    lastIdentifier: ""
  };

  /* =========================================================================
   * 1. GIAO DIỆN UNIVERSAL UI CHUẨN 2 TẦNG
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "mechacomic-dl",
        title: "Mecha Comic",
        engine: "AMUTUS",
        themeColor: "#ea3878",
        themeBg: "#ffffff",
        titleColor: "#25529a",
        btnBg: "#ea3878",
        btnColor: "#ffffff",
        topOffset: "100px",
        onDownload: startDownload,
      };

      state.ui = createUI(uiConfig);
      state.ui.setBusy(true);

      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:${uiConfig.titleColor};letter-spacing:0.2px;">${uiConfig.title}</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px;">${uiConfig.engine}</div>
          `;
        }
      }
    }
    return state.ui;
  }

  /* =========================================================================
   * 2. BỘ HỖ TRỢ XỬ LÝ CHUỖI & TÊN FILE
   * ========================================================================= */
  function isViewerUrl() {
    return WIN.location.pathname.includes('/viewer/') && WIN.location.search.includes('directory=');
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

  function getBookId() {
    try {
      const urlParams = new URLSearchParams(WIN.location.search);
      const gaParamsStr = urlParams.get('ga_params');
      if (gaParamsStr) {
        const ga = JSON.parse(gaParamsStr);
        if (ga.bid) return String(ga.bid);
      }
      const returnTo = urlParams.get('return_to') || urlParams.get('back_path') || '';
      const bMatch = returnTo.match(/\/books\/(\d+)/);
      if (bMatch) return bMatch[1];
    } catch (e) {}
    return null;
  }

  function getIdentifier() {
    try {
      const urlParams = new URLSearchParams(WIN.location.search);
      const gaParamsStr = urlParams.get('ga_params');
      if (gaParamsStr) {
        const ga = JSON.parse(gaParamsStr);
        if (ga.bid && ga.vno) return `bid_${ga.bid}_vol_${ga.vno}`;
        if (ga.bid && ga.cno) return `bid_${ga.bid}_chap_${ga.cno}`;
      }
      const mUrl = urlParams.get('manifest_url') || urlParams.get('cryptokey') || '';
      const mMatch = mUrl.match(/\/(?:volume|chapter|free_chapter)\/([a-zA-Z0-9_-]+)/);
      if (mMatch) return mMatch[1];
    } catch (e) {}
    return "Mecha_Episode";
  }

  async function fetchRealSeriesTitle(bid) {
    if (!bid) return "";
    try {
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const htmlBuffer = await Utils.fetchBuffer(`https://mechacomic.jp/books/${bid}`);
      const html = new TextDecoder().decode(htmlBuffer);

      const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      if (h1Match && h1Match[1]) {
        let h1Clean = cleanString(h1Match[1].replace(/<[^>]+>/g, ''));
        h1Clean = h1Clean.replace(/\s*[-|｜]\s*めちゃコミック.*$/i, '').trim();
        if (h1Clean && h1Clean !== 'めちゃコミック') return h1Clean;
      }

      const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
      if (titleMatch && titleMatch[1]) {
        let t = titleMatch[1].split(/[|｜]/)[0].trim();
        t = t.replace(/【[^】]*】/g, '').trim();
        t = t.replace(/\s*[-|｜]?\s*めちゃコミック.*$/i, '').trim();
        if (t && t !== 'めちゃコミック') return cleanString(t);
      }
    } catch (e) {}
    return "";
  }

  function getCleanTitle(manifestTitle, extraSeriesTitle) {
    try {
      let seriesTitle = extraSeriesTitle || manifestTitle || "";
      let episodeTitle = "";

      const urlParams = new URLSearchParams(WIN.location.search);
      const gaParamsStr = urlParams.get('ga_params');
      if (gaParamsStr) {
        try {
          const ga = JSON.parse(gaParamsStr);
          if (ga.vno) episodeTitle = `第${ga.vno}巻`;
          else if (ga.cno) episodeTitle = `第${ga.cno}話`;
        } catch (e) {}
      }

      let s = cleanString(seriesTitle);
      let e = cleanString(episodeTitle);

      s = s.replace(/（[^）]*(?:コミック|文庫|レーベル|出版|COMIC|WEB)[^）]*）$/i, '').trim();
      s = s.replace(/\([^)]*(?:コミック|文庫|レーベル|出版|COMIC|WEB)[^)]*\)$/i, '').trim();
      if (s === 'めちゃコミック') s = '';

      if (s && e && e.startsWith(s)) {
        e = cleanString(e.substring(s.length));
      }
      e = e.replace(/^[・･\s\-_:：\u3000]+/, '').trim();

      if (s && e && !s.includes(e)) {
        return `${s} - ${e}`;
      } else if (s && e) {
        return e;
      } else if (s) {
        return s;
      } else if (e) {
        return `${getIdentifier()} - ${e}`;
      }
    } catch (e) {}

    return `MechaComic_${getIdentifier()}`;
  }

  /* =========================================================================
   * 3. GIẢI MÃ PHẦN CỨNG AES-128-CBC (ZERO-DEPENDENCY)
   * ========================================================================= */
  function hexToBytes(hex) {
    const clean = String(hex || '').trim().replace(/[^0-9a-fA-F]/g, '');
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }

  async function decryptMechaAesCbc(encryptedBuffer, keyHex) {
    const subtle = WIN.crypto?.subtle || window.crypto?.subtle;
    const keyBytes = hexToBytes(keyHex);
    const cryptoKey = await subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["decrypt"]);
    
    // 16 bytes đầu tiên của file .webp.enc là IV
    const iv = new Uint8Array(encryptedBuffer.slice(0, 16));
    const cipherText = encryptedBuffer.slice(16);
    return await subtle.decrypt({ name: "AES-CBC", iv: iv }, cryptoKey, cipherText);
  }

  /* =========================================================================
   * 4. BÓC TÁCH MANIFEST & ĐIỀU PHỐI MODE TRANG CHUẨN
   * ========================================================================= */
  async function fetchMechaComicManifest() {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    if (!Utils) throw new Error("Chưa nạp đủ MangaUtils.");

    const urlParams = new URLSearchParams(WIN.location.search);

    let directory = urlParams.get('directory') || "";
    let contentsPageUrl = urlParams.get('contents_page') || "";
    let manifestPath = urlParams.get('manifest_url') || urlParams.get('cryptokey') || "";
    const ver = urlParams.get('ver') || "";

    if (!directory) throw new Error("Không tìm thấy tham số directory trên URL.");

    // ÉP TẤT CẢ CÁC MODE (KOMATATE / KOMATAPPU) VỀ CHẾ ĐỘ TRANG CHUẨN (_pg)
    let isSwitchedToPg = false;
    if (!contentsPageUrl || directory.includes('_sp')) {
      const pgDirectory = directory.replace('/viewer/data/', '/page/data/').replace(/_sp\/?$/, '_pg/');
      const pgContentsUrl = `${pgDirectory}contents_page.json`;

      try {
        const checkBuf = await Utils.fetchBuffer(pgContentsUrl);
        if (checkBuf && checkBuf.byteLength > 20) {
          directory = pgDirectory;
          contentsPageUrl = pgContentsUrl;
          isSwitchedToPg = true; // Đánh dấu đã ép sang bản trang chuẩn
          if (manifestPath && !manifestPath.includes('page_flag=1')) {
            manifestPath += (manifestPath.includes('?') ? '&' : '?') + 'page_flag=1';
          }
        }
      } catch (e) {}
    }

    if (!contentsPageUrl) {
      contentsPageUrl = urlParams.get('contents_vertical') || urlParams.get('contents') || `${directory}contents_page.json`;
    }

    if (!manifestPath) throw new Error("Không tìm thấy tham số manifest_url hoặc cryptokey.");

    // 1. Kéo file contents_page.json
    const scriptBuffer = await Utils.fetchBuffer(contentsPageUrl);
    const scriptJson = JSON.parse(new TextDecoder().decode(scriptBuffer));
    
    const rawImages = scriptJson.images || scriptJson.pages || {};
    const keys = Array.isArray(rawImages) 
      ? rawImages.map((_, i) => i) 
      : Object.keys(rawImages).sort((a, b) => (parseInt(String(a).replace(/\D/g, ''), 10) || 0) - (parseInt(String(b).replace(/\D/g, ''), 10) || 0));

    if (keys.length === 0) throw new Error("Không tìm thấy danh sách trang trong contents_page.json.");

    const dir = directory.endsWith('/') ? directory : `${directory}/`;

    // Nếu vừa chuyển từ _sp sang _pg, KHÔNG dùng ver của _sp vì sẽ gây lệch chữ ký CDN (HTTP 404)
    const activeVer = isSwitchedToPg ? "" : (ver ? `?ver=${ver}` : "");

    let defaultEncExt = '.webp.enc';
    const firstSample = rawImages[keys[0]];
    const sampleRawName = String(typeof firstSample === 'string' ? firstSample : (firstSample?.src || firstSample?.file || firstSample?.path || ''));
    const encMatch = sampleRawName.match(/\.([a-zA-Z0-9]+)(?:\.enc)?$/i);
    if (encMatch) {
      defaultEncExt = `.${encMatch[1].toLowerCase()}.enc`;
    }

    const pages = keys.map((k, idx) => {
      const item = rawImages[k] || {};
      const rawName = typeof item === 'string' ? item : (item.src || item.file || item.path || item.url || item.name || "");
      const cleanRaw = String(rawName || '').replace(/^\/+/, '').trim();

      const padName = `${String(idx + 1).padStart(3, '0')}${defaultEncExt}`;
      const originalKeyName = cleanRaw ? (cleanRaw.endsWith('.enc') ? cleanRaw : `${cleanRaw}${defaultEncExt}`) : `${k}${defaultEncExt}`;

      return {
        pageNo: idx + 1,
        fileName: padName,
        originalKeyName: originalKeyName,
        baseDir: dir,
        verSuffix: activeVer,
        url: `${dir}${padName}${activeVer}`,
        padIndex: String(idx + 1).padStart(3, '0'),
        cleanRawName: cleanRaw || String(k)
      };
    });

    // 2. Kéo API lấy khóa giải mã cryptokey
    const manifestApiUrl = manifestPath.startsWith('http') ? manifestPath : `${WIN.location.origin}${manifestPath}`;
    const manifestBuffer = await Utils.fetchBuffer(manifestApiUrl);
    const manifestText = new TextDecoder().decode(manifestBuffer);

    let keyHex = "";
    let contentTitle = "";

    try {
      const manifestJson = JSON.parse(manifestText);
      keyHex = manifestJson.cryptokey || manifestJson.key || (typeof manifestJson === 'string' ? manifestJson : "");
      contentTitle = manifestJson.contentMeta?.title || manifestJson.contentMeta?.name || manifestJson.title || "";
    } catch (e) {
      keyHex = manifestText.trim();
    }

    keyHex = keyHex.replace(/[^0-9a-fA-F]/g, '');
    if (!keyHex || keyHex.length < 32) {
      throw new Error(`Khóa cryptokey không hợp lệ (Độ dài: ${keyHex.length} ký tự).`);
    }

    // 3. Truy vết Tên truyện gốc thông qua Book ID
    let realSeriesTitle = "";
    const bid = getBookId();
    if (bid) {
      realSeriesTitle = await fetchRealSeriesTitle(bid);
    }

    return {
      keyHex,
      title: realSeriesTitle || contentTitle,
      pages: pages,
      identifier: getIdentifier()
    };
  }

  /* =========================================================================
   * 5. XỬ LÝ ẢNH ZERO-COPY TRONG RAM
   * ========================================================================= */
  async function processMechaImage(pageObj, keyHex) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;

    try {
      // Lưới danh sách link thử nghiệm chống lỗi 404 (triệt tiêu lệch ver và lệch index 001 vs 115)
      const candidateUrls = [
        pageObj.url,                                                      // 1. Link chính kèm ver
        `${pageObj.baseDir}${pageObj.fileName}`,                         // 2. Tên 001 sạch không ver
        `${pageObj.baseDir}${pageObj.originalKeyName}${pageObj.verSuffix}`, // 3. Tên 115 kèm ver
        `${pageObj.baseDir}${pageObj.originalKeyName}`,                  // 4. Tên 115 sạch không ver
        // PHÒNG THỦ DỰ PHÒNG: NẾU BẢN WEBP 404, THỬ SANG ĐUÔI JPG.ENC:
        `${pageObj.baseDir}${pageObj.padIndex}.jpg.enc${pageObj.verSuffix}`,
        `${pageObj.baseDir}${pageObj.padIndex}.jpg.enc`
      ];

      let rawBuffer = null;
      let lastErr = null;

      for (const testUrl of candidateUrls) {
        try {
          rawBuffer = await Utils.fetchBuffer(testUrl);
          if (rawBuffer && rawBuffer.byteLength > 100) break; // Tải thành công!
        } catch (e) {
          lastErr = e;
        }
      }

      if (!rawBuffer) throw lastErr || new Error(`HTTP 404 trên tất cả các link dự phòng`);

      // 1. Giải mã phần cứng AES-128-CBC
      const decryptedBuffer = await decryptMechaAesCbc(rawBuffer, keyHex);
      const decryptedUint8 = new Uint8Array(decryptedBuffer);

      // 2. Nhận diện Magic Bytes thực tế
      const ext = Utils.detectExt(decryptedBuffer);

      return { fileName: `${pageObj.pageNo}.${ext}`, data: decryptedUint8 };

    } catch (err) {
      console.error(`[mechacomic-dl] Lỗi xử lý trang ${pageObj.pageNo} (${pageObj.url}):`, err);
      throw err;
    }
  }

  /* =========================================================================
   * 6. TIẾN TRÌNH TẢI CHÍNH (6 LUỒNG SONG SONG TRONG RAM)
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let data = state.chapterData;
      if (!data) {
        data = await fetchMechaComicManifest();
        state.chapterData = data;
      }

      const { pages, keyHex, identifier, title } = data;
      const totalPages = pages.length;
      if (!totalPages) throw new Error("Không có lát cắt hợp lệ để tải.");

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      zip.addFile(`${identifier}.txt`, new Uint8Array(0));

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map((pageObj) => () => processMechaImage(pageObj, keyHex));

      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      let savedCount = 0;
      for (const res of results) {
        if (res?.data) {
          zip.addFile(res.fileName, res.data);
          savedCount++;
        }
      }

      if (savedCount === 0) {
        throw new Error(`Toàn bộ ${totalPages} trang đều giải mã thất bại! Xem Console F12.`);
      }

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      const zipName = `${getCleanTitle(title)}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[mechacomic-dl] Download error:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * 7. KHỞI CHẠY VÀ THEO DÕI SPA ROUTE
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(20);
    const ui = getUI();

    if (!isViewerUrl()) {
      if (ui?.panel) ui.panel.style.display = "none";
      return;
    }

    if (ui?.panel) {
      ui.panel.style.display = "block";
      ui.setBusy(true);
      ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
    }

    try {
      let data = null;
      let retries = 0;
      while (retries < 25) {
        try {
          data = await fetchMechaComicManifest();
          if (data && data.pages?.length > 0) break;
        } catch (e) {}
        await sleep(150);
        retries++;
      }

      if (!data || !data.pages?.length) {
        throw new Error("Không lấy được danh sách trang.");
      }
      state.chapterData = data;

      // 3. Tải thử trang 1 & giải mã AES-128-CBC để soi Magic Bytes thực tế
      const firstPage = data.pages[0]; // bên này dùng data.pages[0]
      if (!firstPage?.url) throw new Error("URL trang 1 không hợp lệ.");

      const Utils = window.MangaUtils || globalThis.MangaUtils;
      let rawBuf = null;

      const candidateUrls = [
        firstPage.url,
        `${firstPage.baseDir}${firstPage.fileName}`,
        `${firstPage.baseDir}${firstPage.originalKeyName}${firstPage.verSuffix}`,
        `${firstPage.baseDir}${firstPage.originalKeyName}`,
        `${firstPage.baseDir}${firstPage.padIndex}.jpg.enc${firstPage.verSuffix}`,
        `${firstPage.baseDir}${firstPage.padIndex}.jpg.enc`
      ];

      for (const testUrl of candidateUrls) {
        try {
          rawBuf = await Utils.fetchBuffer(testUrl);
          if (rawBuf && rawBuf.byteLength > 100) break;
        } catch (e) {}
      }

      if (!rawBuf) throw new Error("Không thể tải trang 1 từ CDN (404 trên toàn bộ lưới).");

      const decBuf = await decryptMechaAesCbc(rawBuf, data.keyHex);
      const realExt = Utils.detectExt(decBuf); // Soi Magic Bytes thật sau giải mã
      if (!realExt) throw new Error("Không thể nhận diện Magic Bytes ảnh.");

      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: data.pages.length,
          status: "Sẵn sàng.",
          format: realExt
        });
        ui.setBusy(false);
      }
    } catch (e) {
      console.error("[mechacomic-dl] Boot error:", e);
      if (ui) {
        ui.updateProgress({ status: "Lỗi: " + (e?.message || "không thể tải trang.") });
        ui.setBusy(true);
      }
    }
  }

  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute((newUrl) => {

      // 1. Nếu rời khỏi trang đọc truyện (ra trang giới thiệu sách /books/...) -> Ẩn panel ngay
      if (!isViewerUrl()) {
        const ui = getUI();
        if (ui?.panel) ui.panel.style.display = "none";
        state.chapterData = null;
        state.lastIdentifier = "";
        state.lastUrl = "";
        state.running = false;
        return;
      }

      const currentId = getIdentifier();
      if (state.lastIdentifier && state.lastIdentifier === currentId) return;

      state.lastUrl = newUrl;
      state.lastIdentifier = currentId;
      state.chapterData = null;
      state.running = false;

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