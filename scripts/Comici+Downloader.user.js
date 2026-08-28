// ==UserScript==
// @name         Comici+ Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      3.0.0
// @icon         https://files.catbox.moe/tpd5zq.png
// @description  Tải manga trên ~30 nền tảng SaaS Comici+ (Champion Cross, Comic Growl, Young Champion, Young Animal, Hana to Yume, Big Comics, HERO'S Web, Take Comic!, Hayacomic, MAG Garden, G-comi, Comic PASH! neo, KimiComi, COMIC ROOM BASE, Comic Rela, Bibibi Comic, Mangalt, comici MANGA, Rimacomi+, Comic Ride, Manga BANG Comics, Manga SPA!, Asacomi, Nami Comic, Pia Comic, COMIC Ruelle & COMIC Jardin, booklistaSTUDIOweb, Manga Zegra).
// @author       anonymous & AI
// @match        https://championcross.jp/*
// @match        https://comic-growl.com/*
// @match        https://youngchampion.jp/*
// @match        https://younganimal.com/*
// @match        https://hanayume.com/*
// @match        https://bigcomics.jp/*
// @match        https://heros-web.com/*
// @match        https://takecomic.jp/*
// @match        https://hayacomic.jp/*
// @match        https://kansai.mag-garden.co.jp/*
// @match        https://g-comi.jp/*
// @match        https://comicpash.jp/*
// @match        https://kimicomi.com/*
// @match        https://comic-room-base.com/*
// @match        https://comirela.com/*
// @match        https://bibibi-comic.com/*
// @match        https://mangalt.jp/*
// @match        https://comics.comici.jp/*
// @match        https://rimacomiplus.jp/*
// @match        https://comicride.jp/*
// @match        https://comics.manga-bang.com/*
// @match        https://mangaspa.nikkan-spa.jp/*
// @match        https://asacomi.jp/*
// @match        https://namicomic.jp/*
// @match        https://piacomic.jp/*
// @match        https://comic.j-nbooks.jp/*
// @match        https://studio.booklista.co.jp/*
// @match        https://manga-zegra.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *

// @connect      *.championcross.jp
// @connect      *.comic-growl.com
// @connect      *.youngchampion.jp
// @connect      *.younganimal.com
// @connect      *.hanayume.com
// @connect      *.bigcomics.jp
// @connect      *.heros-web.com
// @connect      *.takecomic.jp
// @connect      *.hayacomic.jp
// @connect      *.mag-garden.co.jp
// @connect      *.g-comi.jp
// @connect      *.comicpash.jp
// @connect      *.kimicomi.com
// @connect      *.comic-room-base.com
// @connect      *.comirela.com
// @connect      *.bibibi-comic.com
// @connect      *.mangalt.jp
// @connect      *.rimacomiplus.jp
// @connect      *.comics.comici.jp
// @connect      *.comicride.jp
// @connect      *.manga-bang.com
// @connect      *.nikkan-spa.jp
// @connect      *.asacomi.jp
// @connect      *.namicomic.jp
// @connect      *.piacomic.jp
// @connect      *.j-nbooks.jp
// @connect      *.booklista.co.jp
// @connect      *.manga-zegra.com
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/Comici+Downloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/Comici+Downloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function comiciUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH & KHỞI TẠO
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6,   // 6 luồng tải song song
    JPEG_QUALITY: 0.95   // Chất lượng xuất JPG nếu chọn
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("comici-dl:convert-jpeg") === '1',
    chapterData: null,
    ui: null,
    lastViewerId: null
  };

  /* =========================================================================
   * BẢNG CẤU HÌNH THEME TỪNG TẠP CHÍ COMICI+ (~30 NỀN TẢNG)
   * ========================================================================= */
  const SITE_THEMES = {
    "championcross.jp":       { name: "Champion Cross",       top: "60px", color: "#e5283b", bg: "#ffffff", text: "#e5283b" },
    "comic-growl.com":        { name: "Comic Growl",          top: "60px", color: "#38b2ac", bg: "#ffffff", text: "#2c9c96" },
    "youngchampion.jp":       { name: "Young Champion",       top: "60px", color: "#00A5FF", bg: "#ffffff", text: "#00A5FF" },
    "younganimal.com":        { name: "Young Animal",         top: "60px", color: "#E90100", bg: "#ffffff", text: "#E90100" },
    "hanayume.com":           { name: "Hana to Yume",         top: "60px", color: "#d94132", bg: "#080707", text: "#d94132" },
    "bigcomics.jp":           { name: "Big Comics",           top: "60px", color: "#E50111", bg: "#ffffff", text: "#E50111" },
    "heros-web.com":          { name: "HERO'S Web",           top: "60px", color: "#D12D35", bg: "#18181b", text: "#fca5a5" },
    "takecomic.jp":           { name: "Takecomic",            top: "60px", color: "#78be20", bg: "#ffffff", text: "#558b2f" },
    "hayacomic.jp":           { name: "Hayacomic",            top: "60px", color: "#00E6FF", bg: "#080C32", text: "#ffffff" }, // đẹp
    "kansai.mag-garden.co.jp":{ name: "MAGKAN",               top: "61px", color: "#E6001E", bg: "#ffffff", text: "#E6001E" },
    "g-comi.jp":              { name: "G-Comi",               top: "60px", color: "#eb4d27", bg: "#ffffff", text: "#eb4d27" },
    "comicpash.jp":           { name: "Comic PASH! neo",      top: "60px", color: "#38bdf8", bg: "#ffffff", text: "#E8364B" },
    "kimicomi.com":           { name: "KimiComi",             top: "60px", color: "#37DC94", bg: "#ffffff", text: "#FA5C64" },
    "comic-room-base.com":    { name: "Comic Room Base",      top: "60px", color: "#FF7800", bg: "#ffffff", text: "#000000" },
    "comirela.com":           { name: "Comirela",             top: "60px", color: "#61D4E0", bg: "#e6fbfc", text: "#ff7bc3" },
    "bibibi-comic.com":       { name: "BiBiBi Comic",         top: "60px", color: "#E6FF03", bg: "#18181b", text: "#E6FF03" },
    "mangalt.jp":             { name: "Mangalt",              top: "60px", color: "#A38E18", bg: "#ffffff", text: "#A38E18" },
    "comicride.jp":           { name: "Comic Ride",           top: "60px", color: "#3b9ea1", bg: "#ffffff", text: "#000000" },
    "manga-bang.com":         { name: "Manga Bang",           top: "60px", color: "#EE001E", bg: "#ffffff", text: "#140700" },
    "nikkan-spa.jp":          { name: "Manga SPA!",           top: "60px", color: "#FF0000", bg: "#ffffff", text: "#FF0000" },
    "asacomi.jp":             { name: "Asacomi",              top: "60px", color: "#E60013", bg: "#ffffff", text: "#E60013" },
    "namicomic.jp":           { name: "Namicomi",             top: "60px", color: "#3b95f6", bg: "#323232", text: "#EE7801" },
    "piacomic.jp":            { name: "Pia Comic",            top: "60px", color: "#E267A6", bg: "#ffffff", text: "#4F6DC4" },
    "j-nbooks.jp":            { name: "Comic J-N",            top: "60px", color: "#16a34a", bg: "#E6F871", text: "#15803d" },
    "booklista.co.jp":        { name: "booklista STUDIO web", top: "60px", color: "#B10000", bg: "#ffffff", text: "#F8606F" },
    "manga-zegra.com":        { name: "Manga Zegra",          top: "60px", color: "#1A63FF", bg: "#ffffff", text: "#F50100" },
    // Nhóm đặc thù
    "rimacomiplus.jp":        { name: "Rimacomi+",            top: "60px", color: "#F389CF", bg: "#ffffff", text: "#FF4486" },
    "comics.comici.jp":       { name: "comic Bro",            top: "60px", color: "#D80C25", bg: "#ffffff", text: "#D80C25" },
  };

  function resolveSiteTheme() {
    const host = WIN.location.hostname;
    for (const domain in SITE_THEMES) {
      if (host.includes(domain)) return SITE_THEMES[domain];
    }
    return { name: "Comici+", top: "60px", color: "#c8232c", bg: "#1c070a", text: "#fca5a5" };
  }

  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;
    if (typeof createUI === "function" && DOC.body) {
      const theme = resolveSiteTheme();
      state.ui = createUI({
        storagePrefix: "comici-dl",
        title: theme.name,
        themeColor: theme.color,
        themeBg: theme.bg,
        titleColor: theme.text,
        topOffset: theme.top,
        defaultJpgText: "Xuất file JPG (mặc định PNG)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("comici-dl:convert-jpeg", checked ? '1' : '0');
        }
      });

      // Tùy biến Header 2 tầng căn trái chuẩn mực
      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:${theme.text};letter-spacing:0.2px;">${theme.name}</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:1px;">COMICI+</div>
          `;
        }
      }
    }
    return state.ui;
  }

  /* =========================================================================
   * BỘ HỖ TRỢ XỬ LÝ CHUỖI & TÊN FILE CHUẨN
   * ========================================================================= */
  function isEpisodeUrl() {
    return /\/(?:episodes?|articles?)\/[a-zA-Z0-9_-]+/.test(WIN.location.pathname);
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
      const sessionEl = DOC.getElementById('sessionId');
      if (sessionEl?.textContent?.trim()) return sessionEl.textContent.trim();

      const match = WIN.location.pathname.match(/\/(?:episodes?|articles?)\/([a-zA-Z0-9_-]+)/);
      if (match && match[1]) return match[1];
    } catch (e) {}
    return "Comici_Episode";
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

  // BẮT BUỘC CHUẨN: [Tên Truyện] - [Tên Tập/Chap].zip
  function getCleanTitle(manifestSeriesTitle) {
    try {
      let seriesTitle = manifestSeriesTitle || "";
      let episodeTitle = "";

      // 1. Quét DOM bóc tách
      const viewerEl = DOC.getElementById('comici-viewer') || DOC.querySelector('[data-comic-title]');
      if (!seriesTitle && viewerEl) {
        seriesTitle = viewerEl.getAttribute('data-comic-title') || "";
      }

      const sEl = DOC.querySelector('.a-series-title, .series-title-wrapper a, .episode-header-series-title, .series-header-title, [class*="series-title"]');
      if (!seriesTitle && sEl) seriesTitle = sEl.textContent;

      const eEl = DOC.querySelector('.title-line2, .article-title-box .title-line2, .episode-header-title, .article-title, .ep-main-h-h, [class*="episode-title"], .ep-title');
      if (eEl) episodeTitle = eEl.textContent;

      // 2. Dự phòng lấy từ document.title nếu thiếu
      if (!seriesTitle || !episodeTitle) {
        let raw = (DOC.title || "").split(/[|｜]/)[0].trim();
        raw = raw.replace(/^公式\s*[-－_]?\s*/i, '').trim();
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

      // 3. XỬ LÝ RIÊNG CHAMPION CROSS / COMICI+: Tách dấu chấm giữa "・" hoặc "･" nếu tên bị gộp một cục
      if (seriesTitle && (seriesTitle.includes('・') || seriesTitle.includes('･'))) {
        const dotMatch = seriesTitle.match(/^(.*?)[・･\s]+((?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\s\-\–\—\ー\~〜\.]+(?:話|巻|章|節|部|エピソード|分冊版|単話|前編|中編|後編)?.*)$/i);
        if (dotMatch) {
          seriesTitle = dotMatch[1];
          episodeTitle = dotMatch[2];
        }
      }

      let cleanSeries = cleanString(seriesTitle);
      cleanSeries = cleanSeries.replace(/（[^）]*(?:コミック|文庫|レーベル|出版|COMIC|WEB)[^）]*）$/i, '').trim();
      cleanSeries = cleanSeries.replace(/\([^)]*(?:コミック|文庫|レーベル|出版|COMIC|WEB)[^)]*\)$/i, '').trim();

      let cleanEpisode = cleanString(episodeTitle);

      // Cắt bỏ phần tên truyện nếu nó bị dính lặp bên trong episodeTitle
      let baseWithoutVol = cleanSeries.replace(/\s*[0-9０-９]+\s*巻.*$/i, '').trim();
      if (baseWithoutVol && cleanEpisode.startsWith(baseWithoutVol)) {
        cleanEpisode = cleanString(cleanEpisode.substring(baseWithoutVol.length));
      }

      // Khử dấu chấm giữa còn sót ở đầu tên chap
      cleanEpisode = cleanEpisode.replace(/^[・･\s-]+/, '').trim();

      if (cleanSeries && cleanEpisode && cleanEpisode !== getEpisodeId() && !cleanSeries.includes(cleanEpisode)) {
        return `${cleanSeries} - ${cleanEpisode}`;
      } else if (cleanSeries && cleanEpisode && cleanEpisode !== getEpisodeId()) {
        return cleanEpisode;
      } else if (cleanSeries) {
        return `${cleanSeries} - ${getEpisodeId()}`;
      }
    } catch (e) {}

    return `Comici_${getEpisodeId()}`;
  }

  /* =========================================================================
   * BƯỚC TIỀN XỬ LÝ CONTEXT (HỖ TRỢ API DOMAIN ĐỘNG & USER ID ĐĂNG NHẬP)
   * ========================================================================= */
  function preprocessViewerContext(viewerEl) {
    const host = WIN.location.hostname;
    const isSpecial = host.includes('rimacomiplus.jp') || host.includes('comics.comici.jp');

    // 1. Lấy ID viewer
    const viewerId = viewerEl.getAttribute('data-comici-viewer-id') ||
                     viewerEl.getAttribute('comici-viewer-id') ||
                     viewerEl.dataset?.comiciViewerId || '';

    // 2. Lấy Content ID (bắt buộc với Rimacomi+ & Comics.comici)
    const contentId = viewerEl.getAttribute('data-content-id') ||
                      viewerEl.getAttribute('content-id') ||
                      viewerEl.dataset?.contentId || '';

    // 3. Lấy API Domain động nếu có cấu hình riêng
    let apiDomain = viewerEl.getAttribute('data-api-domain') || viewerEl.dataset?.apiDomain || '';
    if (apiDomain) {
      if (apiDomain.startsWith('/')) apiDomain = `${WIN.location.host}${apiDomain}`;
    } else {
      apiDomain = `${WIN.location.host}/api`;
    }

    // 4. Lấy User ID tài khoản đã đăng nhập (hỗ trợ đọc chap mua/thuê)
    const userId = DOC.getElementById('login_user_id')?.textContent?.trim() ||
                   DOC.getElementById('xAnalyticLoggerUid')?.textContent?.trim() || '';

    // 5. Tên truyện và Selector PR
    let seriesTitle = '';
    let prSelectors = [];

    if (isSpecial) {
      seriesTitle = viewerEl.getAttribute('data-comic-title') || '';
      prSelectors = ['#xCVTopPr figure img', '.mode-top-pr img', '.-cv-pr-img-wrap img'];
    } else {
      const sEl = DOC.querySelector('.episode-header-series-title, .series-header-title, [class*="series-title"]');
      if (sEl) seriesTitle = sEl.textContent.trim();
      prSelectors = ['.-cv-pr-img-wrap img', '.x-cv-pr-img', '.mode-top-pr img'];
    }

    return {
      viewerId,
      contentId,
      apiDomain,
      userId,
      seriesTitle,
      prSelectors
    };
  }

  async function getAllPrImages(prSelectors = []) {
    const defaultSelectors = ['.-cv-pr-img-wrap img', '#xCVTopPr figure img', '.mode-top-pr img', '.x-cv-pr-img'];
    const selectors = (prSelectors && prSelectors.length > 0) ? prSelectors : defaultSelectors;
    const prList = [];

    const imgs = DOC.querySelectorAll(selectors.join(', '));
    for (const img of imgs) {
      let src = img.getAttribute('data-src') || img.getAttribute('src') || '';
      if (!src || src.startsWith('data:')) continue;

      // Bộ lọc kích thước: Loại bỏ icon/logo nhỏ (< 400px)
      const w = img.naturalWidth || parseInt(img.getAttribute('width') || '0', 10);
      const h = img.naturalHeight || parseInt(img.getAttribute('height') || '0', 10);
      if ((w > 0 && w < 400) && (h > 0 && h < 400)) continue;

      if (src.startsWith('//')) src = 'https:' + src;
      if (!prList.includes(src)) prList.push(src);
    }
    return prList;
  }

  /* =========================================================================
   * BÓC TÁCH DANH SÁCH TRANG TỪ API COMICI+
   * ========================================================================= */
  async function fetchComiciPages() {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    if (!Utils) throw new Error("Chưa nạp xong MangaUtils.");

    const viewerEl = DOC.getElementById('comici-viewer') || DOC.querySelector('[data-comici-viewer-id]');
    if (!viewerEl) throw new Error("Không tìm thấy phần tử viewer Comici+.");

    const ctx = preprocessViewerContext(viewerEl);
    if (!ctx.viewerId) throw new Error("Chưa lấy được ID viewer.");

    const apiHeaders = {
      "Accept": "application/json",
      "X-Requested-With": "XMLHttpRequest"
    };

    const buildUrl = (from, to) => {
      const params = new URLSearchParams();
      params.append('user-id', (ctx.userId && ctx.userId !== '0') ? ctx.userId : '');
      params.append('comici-viewer-id', ctx.viewerId);
      params.append('page-from', from);
      params.append('page-to', to);
      if (ctx.contentId) params.append('contentId', ctx.contentId);

      const baseProtocol = WIN.location.protocol;
      const cleanDomain = ctx.apiDomain.replace(/^https?:\/\//, '');
      return `${baseProtocol}//${cleanDomain}/book/contentsInfo?${params.toString()}`;
    };

    // Bước 1: Lấy tổng số trang
    const initBuffer = await Utils.fetchBuffer(buildUrl(0, 1), apiHeaders);
    const initRes = JSON.parse(new TextDecoder().decode(initBuffer));

    if (!initRes || typeof initRes.totalPages !== 'number') {
      throw new Error("Không lấy được tổng số trang từ API.");
    }
    const totalPages = initRes.totalPages;

    // Bước 2: Lấy toàn bộ danh sách trang
    const fullBuffer = await Utils.fetchBuffer(buildUrl(0, totalPages), apiHeaders);
    const fullRes = JSON.parse(new TextDecoder().decode(fullBuffer));

    if (!fullRes || !Array.isArray(fullRes.result)) {
      throw new Error("Dữ liệu trang từ API không hợp lệ.");
    }

    const resultPages = [];
    let prCount = 0;
    let mainPageNo = 1;

    // 1. Quét Ảnh PR thương mại (giữ nguyên file gốc CDN)
    const prSrcs = await getAllPrImages(ctx.prSelectors);
    for (const prSrc of prSrcs) {
      prCount++;
      resultPages.push({ isPR: true, prNo: prCount, url: prSrc, scramble: null });
    }

    // 2. Nạp các trang truyện chính (1, 2, 3...)
    for (const item of fullRes.result) {
      let imgUrl = item.imageUrl || item.src || item.url;
      if (!imgUrl) continue;
      if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;

      // Tránh lặp lại ảnh PR
      if (prSrcs.some(ps => imgUrl.includes(ps.split('?')[0]))) continue;

      let scramble = item.scramble || item.scramble_key || item.scrambleKey;
      if (typeof scramble === 'string') {
        try { scramble = JSON.parse(scramble); } catch (e) { scramble = null; }
      }

      resultPages.push({
        isPR: false,
        pageNo: mainPageNo++,
        url: imgUrl,
        scramble: scramble
      });
    }

    resultPages.forEach(p => {
      if (p.isPR) p.singlePR = (prCount === 1);
    });

    return {
      seriesTitle: ctx.seriesTitle,
      pages: resultPages
    };
  }

  /* =========================================================================
   * GIẢI MÃ MA TRẬN 4x4 TRÊN CANVAS
   * ========================================================================= */
  async function unscrambleComiciImage(rawBuffer, scrambleArray, isJpg) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    const img = await Utils.loadImage(rawBuffer);

    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;

    const canvas = DOC.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = false;
    ctx.mozImageSmoothingEnabled = false;
    ctx.webkitImageSmoothingEnabled = false;
    ctx.msImageSmoothingEnabled = false;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    const isIdentity = !scrambleArray || (Array.isArray(scrambleArray) && scrambleArray.length === 16 && scrambleArray.every((val, idx) => val === idx));

    if (isIdentity || !Array.isArray(scrambleArray) || scrambleArray.length < 16) {
      ctx.drawImage(img, 0, 0, width, height, 0, 0, width, height);
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
    const outExt = isJpg ? 'jpg' : 'png';
    const blob = await new Promise(r => canvas.toBlob(r, mimeType, CONFIG.JPEG_QUALITY));

    canvas.width = 0;
    canvas.height = 0;

    return {
      ext: outExt,
      data: new Uint8Array(await blob.arrayBuffer())
    };
  }

  /* =========================================================================
   * TIẾN TRÌNH TẢI CHÍNH (6 LUỒNG TRONG RAM)
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
        data = await fetchComiciPages();
        state.chapterData = data;
      }

      const { pages, seriesTitle } = data;
      const totalPages = pages.length;
      if (!totalPages) throw new Error("Không có trang hợp lệ.");

      const useJpeg = Boolean(state.convertJpeg);
      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file txt định danh
      const episodeId = getEpisodeId();
      zip.addFile(`${episodeId}.txt`, new Uint8Array(0));

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map((pageObj) => async () => {
        const rawBuffer = await Utils.fetchBuffer(pageObj.url);

        // 1. Ảnh PR: Giữ nguyên bytes gốc zero-copy từ CDN
        if (pageObj.isPR) {
          const ext = getExtensionFromUrl(pageObj.url);
          const fileName = pageObj.singlePR ? `PR.${ext}` : `PR_${pageObj.prNo}.${ext}`;
          return { fileName, data: new Uint8Array(rawBuffer) };
        }

        // 2. Trang truyện chính: Giải mã ma trận 4x4
        const decoded = await unscrambleComiciImage(rawBuffer, pageObj.scramble, useJpeg);
        return {
          fileName: `${pageObj.pageNo}.${decoded.ext}`,
          data: decoded.data
        };
      });

      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res?.data) zip.addFile(res.fileName, res.data);
      }

      const zipName = `${getCleanTitle(seriesTitle)}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[comici-dl] Error:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * KHỞI CHẠY VÀ THEO DÕI SPA
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

    let data = null;
    let retries = 0;

    while (retries < 25) {
      try {
        const viewerEl = DOC.getElementById('comici-viewer') || DOC.querySelector('[data-comici-viewer-id]');
        if (viewerEl) {
          const ctx = preprocessViewerContext(viewerEl);
          
          // NẾU LÀ CHUYỂN CHAP: Đợi Vue cập nhật ID mới, không lấy lại ID cũ của chap trước
          if (ctx.viewerId && ctx.viewerId === state.lastViewerId && retries < 15) {
            await sleep(150);
            retries++;
            continue;
          }

          data = await fetchComiciPages();
          if (data && data.pages?.length > 0) {
            state.lastViewerId = ctx.viewerId; // Lưu lại ID của chap hiện tại
            break;
          }
        }
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

  // Khởi động SPA Route Watcher
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