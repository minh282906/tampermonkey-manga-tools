// ==UserScript==
// @name         ComicWalker Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.2
// @icon         https://comic-walker.com/favicon.ico
// @description  Tải manga chất lượng gốc trên ComicWalker.
// @author       anonymous & AI
// @match        https://comic-walker.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      comic-walker.com
// @connect      *.comic-walker.com
// @connect      cdn.comic-walker.com
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function comicWalkerUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
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
    convertJpeg: localStorage.getItem("cw-dl:convert-jpeg") === '1',
    detectedSourceFormat: 'webp',
    chapterData: null,
    ui: null
  };

  /* =========================================================================
   * 1. GIAO DIỆN UNIVERSAL UI CHUẨN 2 TẦNG
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "cw-dl",
        title: "ComicWalker",
        engine: "KADOKAWA",
        themeColor: "#18181b", 
        themeBg: "#ffffff",
        titleColor: "#000000",
        topOffset: "31px",
        defaultJpgText: "Xuất file JPG (ảnh gốc là WebP)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("cw-dl:convert-jpeg", checked ? '1' : '0');
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
   * 2. BỘ HỖ TRỢ XỬ LÝ CHUỖI & TÊN FILE
   * ========================================================================= */
  function isEpisodeUrl() {
    return /\/detail\/[^\/?#]+/.test(WIN.location.pathname) || /\/contents\/viewer/.test(WIN.location.pathname);
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

  function getUrlCodes() {
    const epIdMatch = WIN.location.search.match(/[?&]episodeId=([a-zA-Z0-9_-]+)/);
    if (epIdMatch) return { workCode: "", episodeCode: "", episodeId: epIdMatch[1] };

    const match = WIN.location.pathname.match(/\/detail\/([^\/]+)\/episodes\/([^\/?#]+)/);
    if (match) return { workCode: match[1], episodeCode: match[2], episodeId: "" };

    const workMatch = WIN.location.pathname.match(/\/detail\/([^\/?#]+)/);
    if (workMatch) return { workCode: workMatch[1], episodeCode: "", episodeId: "" };

    return { workCode: "", episodeCode: "", episodeId: "" };
  }

  function getEpisodeIdMarker(meta) {
    const { episodeCode, episodeId } = getUrlCodes();
    return episodeCode || episodeId || meta?.episodeId || "cw_episode";
  }

  function getCleanTitle(meta) {
    try {
      let seriesTitle = meta?.seriesTitle || "";
      let episodeTitle = meta?.episodeTitle || "";

      // 1. Bóc tách từ title/og:title nếu có dạng 【Tên Chap】 Tên Truyện
      const rawTitle = DOC.querySelector('meta[property="og:title"]')?.getAttribute('content') || DOC.title || "";
      const kadoMatch = rawTitle.match(/【(.*?)】\s*([^|｜]+)/);
      if (kadoMatch) {
        if (!episodeTitle) episodeTitle = kadoMatch[1];
        if (!seriesTitle) seriesTitle = kadoMatch[2];
      }

      // 2. Dự phòng lấy Tên truyện từ title gốc (cắt bỏ phần đuôi カドコミ)
      if (!seriesTitle) {
        let sRaw = rawTitle.split(/[|｜]/)[0].trim();
        seriesTitle = sRaw.replace(/カドコミ.*$/gi, '').replace(/コミックウォーカー.*$/gi, '').trim();
      }

      // 3. Dự phòng lấy từ DOM
      if (!seriesTitle) {
        const sEl = DOC.querySelector('h1[class*="WorkTitle"], [class*="SeriesTitle"], [class*="work-title"], .comic-title, h1');
        if (sEl) seriesTitle = sEl.textContent.trim();
      }
      if (!episodeTitle) {
        const eEl = DOC.querySelector('h2[class*="EpisodeTitle"], [class*="episode-title"], [class*="EpisodeItem"] [class*="title"], a[href*="/episodes/"]');
        if (eEl) episodeTitle = eEl.textContent.trim();
      }

      let s = cleanString(seriesTitle);
      let e = cleanString(episodeTitle);

      s = s.replace(/[\s\u3000]*[0-9０-９]+$/i, '').trim();
      s = s.replace(/（[^）]*(?:コミック|文庫|レーベル|出版|COMIC|WEB)[^）]*）$/i, '').trim();
      s = s.replace(/\([^)]*(?:コミック|文庫|レーベル|出版|COMIC|WEB)[^)]*\)$/i, '').trim();

      if (s && e.startsWith(s)) {
        e = cleanString(e.substring(s.length));
      }
      e = e.replace(/^[・･\s\-_:：\u3000]+/, '').trim();

      // Nếu có cả tên truyện và tên chap -> ghép chuẩn Golden Rule
      if (s && e && e !== getEpisodeIdMarker(meta) && !s.includes(e)) {
        return `${s} - ${e}`;
      } else if (s && e && e !== getEpisodeIdMarker(meta)) {
        return e;
      } else if (s) {
        return s; // Giữ nguyên tên truyện sạch, không nối UUID
      }
    } catch (e) {}

    return `ComicWalker_${getEpisodeIdMarker(meta)}`;
  }

  function getExtensionFromUrl(url, defaultExt = 'jpg') {
    try {
      const match = url.split('?')[0].match(/\.([a-zA-Z0-9]+)$/);
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
   * 3. THUẬT TOÁN GIẢI MÃ DRM CYCLIC 8-BYTE XOR
   * ========================================================================= */
  function decryptComicWalkerXor(uint8Array, hash) {
    if (!hash || hash.length < 16) return uint8Array;
    const key = new Uint8Array(8);
    for (let i = 0; i < 8; i++) {
      key[i] = parseInt(hash.substr(i * 2, 2), 16);
    }
    if (isNaN(key[0])) return uint8Array;

    const decrypted = new Uint8Array(uint8Array.length);
    for (let i = 0; i < uint8Array.length; i++) {
      decrypted[i] = uint8Array[i] ^ key[i % 8];
    }
    return decrypted;
  }

  /* =========================================================================
   * 4. BÓC TÁCH DỮ LIỆU TỪ DIRECT API COMIC-WALKER
   * ========================================================================= */
  async function fetchComicWalkerPages() {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    if (!Utils) throw new Error("MangaUtils chưa sẵn sàng.");

    const { workCode, episodeCode, episodeId: rawEpId } = getUrlCodes();
    let targetEpisodeId = rawEpId;
    let targetEpisodeCode = episodeCode;
    const epTypeParam = new URLSearchParams(WIN.location.search).get('episodeType');

    let seriesTitle = "";
    let episodeTitle = "";

    // 1. Kéo API episode (Nếu có episodeType=first thì ưu tiên lấy chuẩn chương đầu tiên)
    if (!targetEpisodeId && workCode) {
      const epType = epTypeParam || (targetEpisodeCode ? 'latest' : 'first');
      let epApiUrl = `https://comic-walker.com/api/contents/details/episode?workCode=${workCode}&episodeType=${epType}`;
      if (targetEpisodeCode && !epTypeParam) epApiUrl += `&episodeCode=${targetEpisodeCode}`;

      try {
        const buf = await Utils.fetchBuffer(epApiUrl);
        const json = JSON.parse(new TextDecoder().decode(buf));
        const ep = json?.episode || json?.data?.episode || json;
        targetEpisodeId = ep?.id || ep?.episodeId || json?.id || "";
        episodeTitle = ep?.title || json?.title || "";
        seriesTitle = json?.work?.title || ep?.work?.title || json?.latestComic?.title || json?.title || "";
      } catch (e) {}
    }

    // 2. Dự phòng API work nếu thiếu thông tin
    if (!targetEpisodeId || !seriesTitle || !episodeTitle) {
      if (workCode) {
        const workApiUrl = `https://comic-walker.com/api/contents/details/work?workCode=${workCode}`;
        try {
          const buf = await Utils.fetchBuffer(workApiUrl);
          const json = JSON.parse(new TextDecoder().decode(buf));
          const w = json?.work || json?.data?.work || json;
          const firstEp = json?.firstEpisode || w?.firstEpisode || json?.episodes?.[0] || w?.episodes?.[0];
          
          if (!targetEpisodeId) targetEpisodeId = firstEp?.id || firstEp?.episodeId || "";
          if (!episodeTitle) episodeTitle = firstEp?.title || "";
          if (!seriesTitle) seriesTitle = w?.title || json?.title || "";
        } catch (e) {}
      }
    }

    if (!targetEpisodeId) throw new Error("Không thể xác định Episode ID của chương truyện.");

    // 3. Kéo danh sách trang truyện từ API Viewer
    const viewerApiUrl = `https://comic-walker.com/api/contents/viewer?episodeId=${targetEpisodeId}&imageSizeType=width%3A1284`;
    const viewerBuf = await Utils.fetchBuffer(viewerApiUrl);
    const viewerData = JSON.parse(new TextDecoder().decode(viewerBuf));

    if (!viewerData || !Array.isArray(viewerData.manuscripts) || viewerData.manuscripts.length === 0) {
      throw new Error("Dữ liệu trang từ API ComicWalker không hợp lệ.");
    }

    // 4. Bổ sung tên truyện nếu còn thiếu
    try {
      const jumpApiUrl = `https://comic-walker.com/api/contents/viewer-jump-forward?episodeId=${targetEpisodeId}`;
      const jumpBuf = await Utils.fetchBuffer(jumpApiUrl);
      const jumpData = JSON.parse(new TextDecoder().decode(jumpBuf));
      if (jumpData && !seriesTitle) {
        seriesTitle = jumpData.latestComic?.title || jumpData.title || "";
      }
    } catch (e) {}

    const allPages = [];
    let mainPageNo = 1;
    let prCount = 0;

    // A. Trang truyện chính (XOR)
    for (const item of viewerData.manuscripts) {
      const imgUrl = item.drmImageUrl || item.url || item.src;
      if (!imgUrl) continue;

      allPages.push({
        isPR: false,
        pageNo: mainPageNo++,
        url: imgUrl,
        drmHash: item.drmHash || "",
        drmMode: item.drmMode || "xor"
      });
    }

    // B. Ảnh PR cuối chương
    const promoAds = viewerData.promotionsEnd || viewerData.data?.promotionsEnd;
    if (Array.isArray(promoAds)) {
      for (const promo of promoAds) {
        const adUrl = promo.imageUrl || promo.url || promo.src || promo.image;
        if (adUrl && !allPages.some(p => p.url === adUrl)) {
          prCount++;
          allPages.push({
            isPR: true,
            prNo: prCount,
            url: adUrl,
            drmHash: "",
            drmMode: "none"
          });
        }
      }
    }

    allPages.forEach(p => {
      if (p.isPR) p.singlePR = (prCount === 1);
    });

    return {
      episodeId: targetEpisodeId,
      seriesTitle: seriesTitle,
      episodeTitle: episodeTitle,
      pages: allPages
    };
  }

  /* =========================================================================
   * 5. GIẢI MÃ XOR VÀ XỬ LÝ ĐỊNH DẠNG ẢNH (ZERO-COPY THUẦN RAM)
   * ========================================================================= */
  async function processComicWalkerImage(pageObj, forceJpg) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    const rawBuffer = await Utils.fetchBuffer(pageObj.url);
    const rawUint8 = new Uint8Array(rawBuffer);

    // 1. Ảnh PR: Giữ nguyên file ảnh gốc từ CDN
    if (pageObj.isPR) {
      const ext = getExtensionFromUrl(pageObj.url, 'jpg');
      const fileName = pageObj.singlePR ? `PR.${ext}` : `PR_${pageObj.prNo}.${ext}`;
      return { fileName, data: rawUint8 };
    }

    // 2. Trang truyện chính: Giải mã XOR 8-byte
    const decryptedBytes = pageObj.drmHash ? decryptComicWalkerXor(rawUint8, pageObj.drmHash) : rawUint8;

    // 3. Nhận diện Magic Bytes thực tế
    let ext = 'webp';
    if (decryptedBytes[0] === 0x52 && decryptedBytes[1] === 0x49 && decryptedBytes[2] === 0x46 && decryptedBytes[3] === 0x46) ext = 'webp';
    else if (decryptedBytes[0] === 0xFF && decryptedBytes[1] === 0xD8 && decryptedBytes[2] === 0xFF) ext = 'jpg';
    else if (decryptedBytes[0] === 0x89 && decryptedBytes[1] === 0x50 && decryptedBytes[2] === 0x4E && decryptedBytes[3] === 0x47) ext = 'png';

    // 4. ZERO-COPY: Nếu không yêu cầu chuyển JPG -> ghi trực tiếp byte vào ZIP
    if (!forceJpg || ext === 'jpg') {
      return {
        fileName: `${pageObj.pageNo}.${ext}`,
        data: decryptedBytes
      };
    }

    // 5. Nếu chọn chuyển sang JPG -> vẽ qua Canvas
    const img = await Utils.loadImage(decryptedBytes, `image/${ext}`);
    const canvas = DOC.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = false;
    ctx.mozImageSmoothingEnabled = false;
    ctx.webkitImageSmoothingEnabled = false;
    ctx.msImageSmoothingEnabled = false;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);

    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', CONFIG.JPEG_QUALITY));
    canvas.width = 0; canvas.height = 0;

    return {
      fileName: `${pageObj.pageNo}.jpg`,
      data: new Uint8Array(await blob.arrayBuffer())
    };
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
        data = await fetchComicWalkerPages();
        state.chapterData = data;
      }

      const { pages, seriesTitle, episodeTitle, episodeId } = data;
      const totalPages = pages.length;
      if (!totalPages) throw new Error("Không tìm thấy trang truyện hợp lệ.");

      const forceJpg = Boolean(state.convertJpeg);
      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      zip.addFile(`${getEpisodeIdMarker(data)}.txt`, new Uint8Array(0));

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map((pageObj) => () => processComicWalkerImage(pageObj, forceJpg));

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

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[cw-dl] Error:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * 7. KHỞI CHẠY VÀ THEO DÕI SPA
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(30);
    const ui = getUI();

    if (!isEpisodeUrl()) {
      if (ui?.panel) ui.panel.style.display = "none";
      return;
    }

    if (ui?.panel) ui.panel.style.display = "block";
    if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });

    let data = null;
    let retries = 0;

    while (retries < 30) {
      try {
        data = await fetchComicWalkerPages();
        if (data && data.pages?.length > 0) break;
      } catch (e) {}
      await sleep(150);
      retries++;
    }

    if (data && data.pages?.length > 0) {
      state.chapterData = data;
      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: data.pages.length,
          status: "Sẵn sàng."
        });
      }
    } else {
      if (ui) ui.updateProgress({ status: "Sẵn sàng." });
    }
  }

  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute(() => {
      state.chapterData = null;
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