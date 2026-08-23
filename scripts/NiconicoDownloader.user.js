// ==UserScript==
// @name         Niconico Manga Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      2.0.0
// @icon         https://sp.manga.nicovideo.jp/favicon.ico
// @description  Tải manga trên Niconico Manga (Hỗ trợ PC WebP & Mobile JPG).
// @author       anonymous & AI
// @match        https://sp.manga.nicovideo.jp/watch/*
// @match        https://manga.nicovideo.jp/watch/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      nicovideo.jp
// @connect      *.nicovideo.jp
// @connect      *.nicoseiga.jp
// @connect      *.nicomanga.jp
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function niconicoMangaUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6,   // 6 luồng tải song song
    JPEG_QUALITY: 0.95   // Chất lượng xuất JPG nếu chọn
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const isMobileSp = WIN.location.hostname.startsWith('sp.');

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("nico-dl:convert-jpeg") === '1',
    detectedSourceFormat: isMobileSp ? 'jpg' : 'webp',
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
      const defaultText = isMobileSp ? "Xuất file JPG (ảnh gốc là JPG)" : "Xuất file JPG (ảnh gốc là WebP)";

      const uiConfig = {
        storagePrefix: "nico-dl",
        title: "Niconico",
        engine: "DWANGO",
        themeColor: "#77C238",
        themeBg: "#ffffff",
        titleColor: "#77C238",
        topOffset: "48px",
        defaultJpgText: defaultText,
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("nico-dl:convert-jpeg", checked ? '1' : '0');
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
   * 2. BỘ HỖ TRỢ XỬ LÝ CHUỖI & TÊN FILE CHUẨN
   * ========================================================================= */
  function isEpisodeUrl() {
    return /\/watch\/(mg\d+|\d+)/.test(WIN.location.pathname);
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

  function getEpisodeId() {
    try {
      const match = WIN.location.pathname.match(/\/watch\/(mg\d+|\d+)/);
      if (match && match[1]) {
        return match[1].startsWith('mg') ? match[1] : `mg${match[1]}`;
      }
    } catch (e) {}
    return "mg_episode";
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

  // BẮT BUỘC: [Tên Truyện] - [Tên Tập/Chap].zip
  function getCleanTitle() {
    try {
      let seriesTitle = "";
      let episodeTitle = "";

      // 1. Quét DOM (PC & Mobile)
      const sEl = DOC.querySelector('.manga_title, .manga-title, .title-text, .series-title, h1.title, [class*="series-title"], [class*="manga-title"]');
      if (sEl) seriesTitle = sEl.textContent.trim();

      const eEl = DOC.querySelector('.episode_title, .episode-title, .sub-title, .episode-name, [class*="episode-title"], [class*="sub-title"]');
      if (eEl) episodeTitle = eEl.textContent.trim();

      // 2. Dự phòng: Quét document.title
      if (!seriesTitle || !episodeTitle) {
        let raw = DOC.title || "";
        raw = raw.replace(/\s*[-|｜]\s*ニコニコ漫画.*/i, '').trim();
        raw = raw.split(/\s*\/\s*/)[0].trim();
        raw = raw.replace(/【[^】]*】/g, '').trim();

        const match = raw.match(/^(.*?)(?:\s+[-－–—]\s+|\s+)((?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\s\-\–\—\ー\~〜\.]+(?:話|巻|章|節|部|エピソード|分冊版|単話|前編|中編|後編)?.*)$/i);
        if (match) {
          if (!seriesTitle) seriesTitle = match[1];
          if (!episodeTitle) episodeTitle = match[2];
        } else {
          if (!seriesTitle) seriesTitle = raw;
          if (!episodeTitle) episodeTitle = getEpisodeId();
        }
      }

      let cleanSeries = cleanString(seriesTitle);
      cleanSeries = cleanSeries.replace(/（[^）]*(?:コミック|文庫|レーベル|出版|COMIC|WEB)[^）]*）$/i, '').trim();
      cleanSeries = cleanSeries.replace(/\([^)]*(?:コミック|文庫|レーベル|出版|COMIC|WEB)[^)]*\)$/i, '').trim();
      cleanSeries = cleanSeries.replace(/\s*\([^)]*(?:著者|原作|作画|漫画)[^)]*\)/gi, '').trim();

      let cleanEpisode = cleanString(episodeTitle);
      cleanEpisode = cleanEpisode.replace(/\s*\([^)]*(?:著者|原作|作画|漫画)[^)]*\)/gi, '').trim();

      // Cắt bỏ phần tên truyện nếu bị lặp lại trong tên chap
      let baseWithoutVol = cleanSeries.replace(/\s*[0-9０-９]+\s*巻.*$/i, '').trim();
      if (baseWithoutVol && cleanEpisode.startsWith(baseWithoutVol)) {
        cleanEpisode = cleanString(cleanEpisode.substring(baseWithoutVol.length));
      }

      if (cleanSeries && cleanEpisode && cleanEpisode !== getEpisodeId() && !cleanSeries.includes(cleanEpisode)) {
        return `${cleanSeries} - ${cleanEpisode}`;
      } else if (cleanSeries && cleanEpisode && cleanEpisode !== getEpisodeId()) {
        return cleanEpisode;
      } else if (cleanSeries) {
        return `${cleanSeries} - ${getEpisodeId()}`;
      }
    } catch (e) {}

    return `Niconico_${getEpisodeId()}`;
  }

  /* =========================================================================
   * 3. BÓC TÁCH CHÍNH XÁC ẢNH
   * ========================================================================= */
  function extractPrUrlsFromDom() {
    const list = [];

    // 1. NẾU LÀ TRÊN PC: Quét CHỈ bên trong #book_promotion_banners
    const pcContainer = DOC.getElementById('book_promotion_banners') || DOC.querySelector('.book_promotion_banners');
    if (pcContainer) {
      const imgs = pcContainer.querySelectorAll('img');
      for (const img of imgs) {
        let src = img.getAttribute('data-original') || img.getAttribute('data-src') || img.getAttribute('src') || '';
        if (!src || src.startsWith('data:')) continue;
        if (src.startsWith('//')) src = 'https:' + src;

        const lower = src.toLowerCase();
        const parentA = img.closest('a');
        const href = (parentA?.getAttribute('href') || '').toLowerCase();
        const alt = (img.getAttribute('alt') || '').toLowerCase();

        // Chặn 2 nút tải App Store & Google Play
        if (
          href.includes('apple.com') || href.includes('itunes') || href.includes('play.google.com') ||
          lower.includes('appstore') || lower.includes('googleplay') || lower.includes('badge') ||
          alt.includes('app store') || alt.includes('google play')
        ) {
          continue;
        }

        if (!list.includes(src)) list.push(src);
      }
      if (list.length > 0) return list;
    }

    // 2. NẾU LÀ TRÊN MOBILE: Quét CHỈ bên trong khung thẻ <li> (div.mt-4.px-5 ul li)
    const mobileContainer = DOC.querySelector('main div[class*="mt-4"][class*="px-5"] ul, main .mt-4.px-5 ul');
    if (mobileContainer) {
      const imgs = mobileContainer.querySelectorAll('li img');
      for (const img of imgs) {
        let src = img.getAttribute('data-original') || img.getAttribute('data-src') || img.getAttribute('src') || '';
        if (!src || src.startsWith('data:')) continue;
        if (src.startsWith('//')) src = 'https:' + src;

        const lower = src.toLowerCase();
        const parentA = img.closest('a');
        const href = (parentA?.getAttribute('href') || '').toLowerCase();
        const alt = (img.getAttribute('alt') || '').toLowerCase();

        // Chặn nút tải App
        if (
          href.includes('apple.com') || href.includes('itunes') || href.includes('play.google.com') ||
          lower.includes('appstore') || lower.includes('googleplay') || lower.includes('badge') ||
          alt.includes('app store') || alt.includes('google play')
        ) {
          continue;
        }

        if (!list.includes(src)) list.push(src);
      }
      if (list.length > 0) return list;
    }

    return list;
  }

  /* =========================================================================
   * 4. THUẬT TOÁN GIẢI MÃ DRM NICONICO (CYCLIC 8-BYTE XOR DECRYPTION)
   * ========================================================================= */
  function extractDrmHashFromUrl(url) {
    if (!url) return null;
    const match = url.match(/\/image\/([a-f0-9]+_\d+|[a-f0-9]{30,}|[a-z0-9_]+)/i);
    if (!match) return null;
    return match[1].split('_')[0];
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

  /* =========================================================================
   * 5. BỘ TỔNG HỢP TOÀN DIỆN
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

  function buildResultPages(mainItems, prUrls) {
    const resultPages = [];
    let prCount = 0;

    // 1. Nạp ảnh PR thương mại chính thức
    for (const prUrl of prUrls) {
      prCount++;
      resultPages.push({
        isPR: true,
        prNo: prCount,
        url: prUrl
      });
    }

    // 2. Nạp các trang truyện chính
    let mainPageNo = 1;
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

    return resultPages;
  }

  async function waitForCompleteEpisodeData(maxWaitMs = 2500) {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      let mainItems = [];

      // 1. Lấy danh sách trang truyện chính
      if (WIN.args?.pages && Array.isArray(WIN.args.pages)) {
        mainItems = WIN.args.pages.map(p => ({
          url: p.url,
          drmHash: extractDrmHashFromUrl(p.url)
        }));
      }

      if (mainItems.length === 0) {
        mainItems = extractImageUrlsFromScriptPayload();
      }

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

      // 2. Lấy danh sách ảnh PR chính thức
      const prUrls = extractPrUrlsFromDom();

      if (mainItems.length > 0) {
        if (prUrls.length > 0) {
          return buildResultPages(mainItems, prUrls);
        }
        if (Date.now() - startTime > 1500) {
          return buildResultPages(mainItems, prUrls);
        }
      }

      await sleep(150);
    }

    return null;
  }

  /* =========================================================================
   * 6. GIẢI MÃ XOR VÀ XỬ LÝ ĐỊNH DẠNG ẢNH
   * ========================================================================= */
  async function processNiconicoImage(pageObj, forceJpg) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    const rawBuffer = await Utils.fetchBuffer(pageObj.url);
    const rawUint8 = new Uint8Array(rawBuffer);

    // 1. Giải mã XOR nếu có khóa DRM
    const finalHash = pageObj.drmHash || extractDrmHashFromUrl(pageObj.url);
    const isDrmUrl = pageObj.url.includes('/image/') || pageObj.url.startsWith('https://drm.cdn');
    const decryptedBytes = (isDrmUrl && finalHash) ? decryptNiconicoXor(rawUint8, finalHash) : rawUint8;

    // 2. Nhận diện định dạng qua Magic Bytes thực tế
    let ext = 'jpg';
    if (decryptedBytes[0] === 0x52 && decryptedBytes[1] === 0x49 && decryptedBytes[2] === 0x46 && decryptedBytes[3] === 0x46) ext = 'webp';
    else if (decryptedBytes[0] === 0x89 && decryptedBytes[1] === 0x50 && decryptedBytes[2] === 0x4E && decryptedBytes[3] === 0x47) ext = 'png';
    else if (decryptedBytes[0] === 0xFF && decryptedBytes[1] === 0xD8 && decryptedBytes[2] === 0xFF) ext = 'jpg';

    // 3. Xuất trực tiếp byte gốc (Zero-Copy) nếu không yêu cầu đổi format
    if (!forceJpg || ext === 'jpg') {
      return {
        fileName: `${pageObj.pageNo}.${ext}`,
        data: decryptedBytes
      };
    }

    // 4. Chuyển đổi JPG nếu người dùng chọn
    const img = await Utils.loadImage(decryptedBytes, `image/${ext}`);
    const canvas = DOC.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d', { alpha: false });
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
   * 7. TIẾN TRÌNH TẢI CHÍNH
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    if (!state.chapterData || state.chapterData.length === 0) {
      if (ui) ui.updateProgress({ status: "Chưa có dữ liệu trang." });
      return;
    }

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      const pages = state.chapterData;
      const totalPages = pages.length;
      const forceJpg = Boolean(state.convertJpeg);
      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // File rỗng ID định danh tại thư mục gốc ZIP
      const episodeId = getEpisodeId();
      zip.addFile(`${episodeId}.txt`, new Uint8Array(0));

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map((pageObj) => async () => {
        // Ảnh PR: Giữ nguyên bytes gốc zero-copy
        if (pageObj.isPR) {
          const rawBuffer = await Utils.fetchBuffer(pageObj.url);
          const ext = getExtensionFromUrl(pageObj.url);
          const fileName = pageObj.singlePR ? `PR.${ext}` : `PR_${pageObj.prNo}.${ext}`;
          return { fileName, data: new Uint8Array(rawBuffer) };
        }

        return await processNiconicoImage(pageObj, forceJpg);
      });

      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res?.data) zip.addFile(res.fileName, res.data);
      }

      const zipName = `${getCleanTitle()}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[nico-dl] Error:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * 8. KHỞI CHẠY VÀ THEO DÕI SPA
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(30);
    const ui = getUI();

    if (!isEpisodeUrl()) {
      if (ui?.panel) ui.panel.style.display = "none";
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
      return;
    }

    if (ui?.panel) ui.panel.style.display = "block";
    if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });

    const pages = await waitForCompleteEpisodeData(2500);

    if (pages && pages.length > 0) {
      state.chapterData = pages;

      try {
        const Utils = window.MangaUtils || globalThis.MangaUtils;
        const samplePage = pages.find(p => !p.isPR) || pages[0];
        const testBuffer = await Utils.fetchBuffer(samplePage.url);
        const testUint8 = new Uint8Array(testBuffer);
        const finalHash = samplePage.drmHash || extractDrmHashFromUrl(samplePage.url);
        const isDrmUrl = samplePage.url.includes('/image/') || samplePage.url.startsWith('https://drm.cdn');
        const dec = (isDrmUrl && finalHash) ? decryptNiconicoXor(testUint8, finalHash) : testUint8;

        let detected = 'jpg';
        if (dec[0] === 0x52 && dec[1] === 0x49) detected = 'webp';
        else if (dec[0] === 0x89 && dec[1] === 0x50) detected = 'png';
        else if (dec[0] === 0xFF && dec[1] === 0xD8) detected = 'jpg';

        state.detectedSourceFormat = detected;
        if (ui) ui.updateFormatUI(detected);
      } catch (e) {}

      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: pages.length,
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