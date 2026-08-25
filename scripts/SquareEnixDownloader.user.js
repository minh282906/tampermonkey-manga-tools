// ==UserScript==
// @name         Square Enix Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://magazine.jp.square-enix.com/favicon.ico
// @description  Tải manga siêu tốc trên toàn bộ hệ sinh thái Square Enix (Gangan ONLINE, Manga UP, Shounen Gangan, GFantasy, Young Gangan, Big Gangan, Gangan Joker, ComiWeb).
// @author       anonymous & AI
// @match        https://magazine.jp.square-enix.com/*
// @match        https://www.ganganonline.com/*
// @match        https://ganganonline.com/*
// @match        https://www.manga-up.com/*
// @match        https://manga-up.com/*
// @match        https://global.manga-up.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      *.square-enix.com
// @connect      *.ganganonline.com
// @connect      *.manga-up.com
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function squareEnixUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH & KHỞI TẠO HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6,   // 6 luồng tải song song qua CDN
    JPEG_QUALITY: 0.95   // Chất lượng xuất JPG nếu chuyển đổi
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("sqex-dl:convert-jpeg") === '1',
    chapterData: null,
    ui: null,
    lastUrl: ""
  };

  /* =========================================================================
   * BẢNG CẤU HÌNH THEME ĐỘNG
   * ========================================================================= */
  const SITE_THEMES = {
      
      // Gangan ONLINE
      "ganganonline.com":       { name: "Gangan ONLINE",  top: "50px",  color: "#56b4e9", bg: "#ffffff", text: "#0284c7", sub: "SQUARE ENIX" },
      
      // Manga UP!
      "manga-up.com":           { name: "Manga UP!",      top: "143px",  color: "#FF5500", bg: "#ffffff", text: "#FF5500", sub: "SQUARE ENIX" },
    
      // Vẫn thuộc web của Square Enix
      "/gangan/":               { name: "Shounen Gangan", top: "70px",  color: "#38b6e6", bg: "#ffffff", text: "#0284c7", sub: "SQUARE ENIX" },
      "/gfantasy/":             { name: "G Fantasy",      top: "70px",  color: "#a855f7", bg: "#18181b", text: "#c084fc", sub: "SQUARE ENIX" },
      "/joker/":                { name: "Gangan Joker",   top: "70px",  color: "#18181b", bg: "#ffffff", text: "#18181b", sub: "SQUARE ENIX" },
      "/yg/":                   { name: "Young Gangan",   top: "110px", color: "#e11d48", bg: "#ffffff", text: "#e11d48", sub: "SQUARE ENIX" },
      "/biggangan/":            { name: "Big Gangan",     top: "80px",  color: "#78be20", bg: "#ffffff", text: "#4c7c13", sub: "SQUARE ENIX" },
      "/comiweb/":              { name: "Comiweb",        top: "70px",  color: "#e60012", bg: "#18181b", text: "#fca5a5", sub: "SQUARE ENIX" },

    };

  function resolveSiteTheme() {
    const href = WIN.location.href.toLowerCase();
    for (const key in SITE_THEMES) {
      if (href.includes(key)) return SITE_THEMES[key];
    }
    return { name: "Square Enix", top: "70px", color: "#e60012", bg: "#18181b", text: "#fca5a5", sub: "SQUARE ENIX" };
  }

  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const theme = resolveSiteTheme();
      const host = WIN.location.hostname;

      const isSquareMagazine = host.includes('square-enix.com');
      const defaultFormat = isSquareMagazine ? 'jpg' : 'webp';
      const defaultText = isSquareMagazine ? "Xuất file JPG (ảnh gốc là JPG)" : "Xuất file JPG (ảnh gốc là WebP)";

      state.ui = createUI({
        storagePrefix: "sqex-dl",
        title: theme.name,
        themeColor: theme.color,
        themeBg: theme.bg,
        titleColor: theme.text,
        topOffset: theme.top,
        defaultJpgText: defaultText,
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("sqex-dl:convert-jpeg", checked ? '1' : '0');
        }
      });

      state.ui.updateFormatUI(defaultFormat);

      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:${theme.text};letter-spacing:0.2px;">${theme.name}</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px;">${theme.sub}</div>
          `;
        }
      }
    }
    return state.ui;
  }

  /* =========================================================================
   * BỘ HỖ TRỢ XỬ LÝ CHUỖI & TÊN FILE
   * ========================================================================= */
  function cleanString(str) {
    if (!str) return "";
    return str
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/【[^】]*】/g, '')
      .replace(/[\\/*?:"<>|]/g, '')
      .trim();
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

  // KIỂM TRA ĐỊNH TUYẾN CHUẨN XÁC
  function isEpisodeUrl() {
        const host = WIN.location.hostname;
        const path = WIN.location.pathname;

        // 1. Manga UP!
        if (host.includes('manga-up.com')) {
        return /\/titles?\/\d+/i.test(path) || /\/manga\/\d+/i.test(path) || /\/chapters?\//i.test(path);
        }

        // 2. Gangan Online
        if (host.includes('ganganonline.com')) {
        return /\/title\/[^\/]+\/chapter\/[^\/]+/i.test(path);
        }

        // 3. Tạp chí Square Enix
        if (host.includes('square-enix.com')) {
        const cleanPath = path.replace(/\/index\.html?$/i, '').replace(/\/$/, '');

        // Young Gangan (yg): CHỈ HIỆN KHI Ở TRANG INTRODUCTION
        if (cleanPath.startsWith('/yg/')) {
        return /\/yg\/introduction\/[a-zA-Z0-9_-]+$/i.test(cleanPath);
        }

        // Các tạp chí khác: Chấp nhận introduction, tachiyomi, tcym, browse, series (bắt buộc có tên truyện)
        if (/\/(?:tcym|tachiyomi|viewer|browse)\/[a-zA-Z0-9_-]+/i.test(cleanPath)) return true;
        if (/\/(?:series|introduction)\/[a-zA-Z0-9_-]+$/i.test(cleanPath)) return true;
        }
    return false;
  }

  function getEpisodeId() {
    const cleanPath = WIN.location.pathname.replace(/\/index\.html?$/i, '').replace(/\/$/, '');

    const mupChapMatch = cleanPath.match(/\/chapters?\/([a-zA-Z0-9_-]+)/i);
    if (mupChapMatch) return mupChapMatch[1];

    const ggoMatch = cleanPath.match(/\/chapter\/([a-zA-Z0-9_-]+)/i);
    if (ggoMatch) return ggoMatch[1];

    const tcymMatch = cleanPath.match(/\/(?:tcym|tachiyomi|viewer|browse|series|introduction)\/([a-zA-Z0-9_-]+)$/i);
    if (tcymMatch) return tcymMatch[1];

    return "SquareEnix_Episode";
  }

  // [Tên Truyện] - [Tên Tập/Chap].zip (hoặc [Tên Truyện].zip nếu không có chap)
  function getCleanTitle(manifestSeriesTitle, manifestEpisodeTitle) {
    try {
      let seriesTitle = cleanString(manifestSeriesTitle);
      let episodeTitle = cleanString(manifestEpisodeTitle);

      if (!seriesTitle) {
        let raw = (DOC.title || "").split(/[|｜]/)[0].trim();
        raw = raw
          .replace(/【[^】]*】/g, '')
          .replace(/試し読み/g, '')
          .replace(/ガンガンJOKER.*$/gi, '')
          .replace(/ガンガンジョーカー.*$/gi, '')
          .replace(/月刊少年ガンガン.*$/gi, '')
          .replace(/Gファンタジー.*$/gi, '')
          .replace(/ビッグガンガン.*$/gi, '')
          .replace(/ヤングガンガン.*$/gi, '')
          .replace(/SQUARE\s*ENIX.*$/gi, '')
          .replace(/マンガＵＰ！.*$/gi, '')
          .replace(/[-－–—]\s*$/g, '')
          .trim();

        const match = raw.match(/^(.*?)(?:\s+[-－–—]\s+|\s+)((?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\s\-\–\—\ー\~〜\.]+(?:話|巻|章|節|部|エピソード|分冊版|単話|前編|中編|後編)?.*)$/i);
        if (match) {
          seriesTitle = cleanString(match[1]);
          if (!episodeTitle) episodeTitle = cleanString(match[2]);
        } else {
          seriesTitle = cleanString(raw);
        }
      }

      // Khử sạch tag tạp chí còn sót trong tên truyện
      seriesTitle = seriesTitle
        .replace(/ガンガンJOKER.*$/gi, '')
        .replace(/ガンガンジョーカー.*$/gi, '')
        .replace(/月刊少年ガンガン.*$/gi, '')
        .replace(/Gファンタジー.*$/gi, '')
        .replace(/ビッグガンガン.*$/gi, '')
        .replace(/ヤングガンガン.*$/gi, '')
        .replace(/SQUARE\s*ENIX.*$/gi, '')
        .replace(/[-－–—]\s*$/g, '')
        .trim();

      if (seriesTitle && episodeTitle) {
        let baseSeries = seriesTitle.replace(/\s*[0-9０-９]+\s*巻.*$/i, '').trim();
        if (baseSeries && episodeTitle.startsWith(baseSeries)) {
          episodeTitle = cleanString(episodeTitle.substring(baseSeries.length));
        }
        episodeTitle = episodeTitle.replace(/^[・･\s-]+/, '').trim();

        if (episodeTitle && !seriesTitle.includes(episodeTitle)) {
          return `${seriesTitle} - ${episodeTitle}`;
        }
      }

      return seriesTitle || `SquareEnix_${getEpisodeId()}`;
    } catch (e) {}

    return `SquareEnix_${getEpisodeId()}`;
  }

  function probeUrlExists(url, timeout = 350) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "HEAD",
        url: url,
        timeout: timeout,
        onload: (res) => resolve(res.status >= 200 && res.status < 300),
        onerror: () => resolve(false),
        ontimeout: () => resolve(false)
      });
    });
  }

  /* =========================================================================
   * BÓC TÁCH MANIFEST: TẠP CHÍ SQUARE ENIX
   * ========================================================================= */
  async function extractSquareEnixMagazine() {
    const cleanPath = WIN.location.pathname.replace(/\/index\.html?$/i, '').replace(/\/?$/, '/');
    const origin = WIN.location.origin;
    const currentBaseUrl = `${origin}${cleanPath}`;

    let rawTitle = (DOC.title || "").split(/[|｜]/)[0].trim();
    rawTitle = rawTitle
      .replace(/【[^】]*】/g, '')
      .replace(/試し読み/g, '')
      .replace(/ガンガンJOKER.*$/gi, '')
      .replace(/ガンガンジョーカー.*$/gi, '')
      .replace(/月刊少年ガンガン.*$/gi, '')
      .replace(/Gファンタジー.*$/gi, '')
      .replace(/ビッグガンガン.*$/gi, '')
      .replace(/ヤングガンガン.*$/gi, '')
      .replace(/SQUARE\s*ENIX.*$/gi, '')
      .replace(/[-－–—]\s*$/g, '')
      .trim();

    let seriesTitle = DOC.querySelector('h1, h2, .series_ttl h2, .title, #title')?.textContent?.trim() || "";
    seriesTitle = seriesTitle
      .replace(/ガンガンJOKER.*$/gi, '')
      .replace(/ガンガンジョーカー.*$/gi, '')
      .replace(/SQUARE\s*ENIX.*$/gi, '')
      .replace(/[-－–—]\s*$/g, '')
      .trim();

    let episodeTitle = "";

    const titleMatch = rawTitle.match(/^(.*?)(?:\s+[-－–—]\s+|\s+)((?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\s\-\–\—\ー\~〜\.]+(?:話|巻|章|節|部|エピソード|分冊版|単話|前編|中編|後編)?.*)$/i);
    if (titleMatch) {
      if (!seriesTitle) seriesTitle = cleanString(titleMatch[1]);
      episodeTitle = cleanString(titleMatch[2]);
    } else {
      if (!seriesTitle) seriesTitle = cleanString(rawTitle);

      const domEpEl = DOC.querySelector('.content_inner p.title, .fr_container ~ *, #tachiyomi p.title, p.title');
      if (domEpEl) {
        const epText = domEpEl.textContent || "";
        const mEp = epText.match(/(?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\s\-\–\—\ー\~〜\.]+(?:話|巻|章|節|部|エピソード|分冊版|単話|前編|中編|後編)/i);
        if (mEp) episodeTitle = cleanString(mEp[0]);
      }
    }

    const pages = [];

    // 1. Quét toàn bộ ảnh Artwork / Character / Cover từ DOM (Lọc sạch 100% share.jpg, share.png, icon rác)
    const artworkImgs = DOC.querySelectorAll('img[src*="cover/"], img[src*="main.jpg"], img[src*="image_sam"], img[src*="character_"], img[src*="img_character"], #adBox img, #adBox_free img, .ad_inner img, #series_main img, #series_character img, .character_img img, .mainBody img');
    for (const img of artworkImgs) {
      let src = img.getAttribute('src') || '';
      if (src) {
        const lower = src.toLowerCase();
        // Bộ lọc chặn triệt để icon rác và nút share
        if (
          lower.includes('_.gif') || lower.includes('bg.png') || lower.includes('bg.jpg') || lower.includes('bg_ttl') ||
          lower.includes('share') || lower.includes('yaji') || lower.includes('line.png') ||
          lower.includes('twitter') || lower.includes('facebook') || lower.includes('common/images') ||
          lower.includes('amazon') || lower.includes('rakuten') || lower.includes('seven') || lower.includes('digital') ||
          /img\d+\.(png|jpg)/i.test(lower)
        ) {
          continue;
        }

        const fullAdUrl = new URL(src, WIN.location.href).href;
        const fileName = fullAdUrl.split('/').pop().split('?')[0];

        if (!pages.some(p => p.url === fullAdUrl)) {
          pages.push({ url: fullAdUrl, customName: fileName });
        }
      }
    }

    // 2. FOTORAMA ENGINE (Xử lý cả đường dẫn tương đối và tuyệt đối)
    let fotoramaPageNum = WIN.fr_pagenum;
    let fotoramaImgVal = WIN.fr_imgval;
    let fotoramaDir = WIN.fr_dir;

    if (!fotoramaPageNum) {
      const scripts = DOC.querySelectorAll('script');
      for (const s of scripts) {
        const txt = s.textContent || "";
        const mPage = txt.match(/fr_pagenum\s*=\s*(\d+)/);
        if (mPage) fotoramaPageNum = parseInt(mPage[1], 10);
        const mVal = txt.match(/fr_imgval\s*=\s*['"]?([a-zA-Z0-9_-]*)['"]?/);
        if (mVal) fotoramaImgVal = mVal[1];
        const mDir = txt.match(/fr_dir\s*=\s*['"]([^'"]+)['"]/);
        if (mDir) fotoramaDir = mDir[1];
      }
    }

    if (fotoramaPageNum && fotoramaPageNum > 0) {
      let resolvedDir = fotoramaDir || "img/";
      let pagesBaseUrl = "";
      if (resolvedDir.startsWith('http')) {
        pagesBaseUrl = resolvedDir;
      } else if (resolvedDir.startsWith('/')) {
        pagesBaseUrl = `${origin}${resolvedDir}`;
      } else {
        pagesBaseUrl = `${currentBaseUrl}${resolvedDir}`;
      }

      if (!pagesBaseUrl.endsWith('/')) pagesBaseUrl += '/';

      const cacheQuery = (fotoramaImgVal && fotoramaImgVal !== "0" && fotoramaImgVal !== 0) ? `?${fotoramaImgVal}` : '';

      for (let i = 1; i <= fotoramaPageNum; i++) {
        const padNum = String(i).padStart(3, '0');
        pages.push({
          pageNo: i,
          url: `${pagesBaseUrl}${padNum}.jpg${cacheQuery}`,
          customName: null
        });
      }

      return {
        seriesTitle: seriesTitle || "Gangan_Series",
        episodeTitle: episodeTitle,
        pages
      };
    }

    // 3. Dự phòng kiểm tra các ảnh Character / Artwork / Cover qua HEAD request (không cần thiết, và nó cũng không đủ)
    const seriesId = getEpisodeId();
    const extraImages = [
      { file: `images/cover/${seriesId}.jpg`, name: `${seriesId}.jpg` },
      { file: 'images/cover/cover.jpg', name: 'cover.jpg' },
      { file: 'images/main.jpg', name: 'main.jpg' },
      { file: 'images/image_sam.jpg', name: 'image_sam.jpg' },
      { file: 'images/image_sam2.jpg', name: 'image_sam2.jpg' },
      { file: 'images/character_01.jpg', name: 'character_1.jpg' },
      { file: 'images/character_02.jpg', name: 'character_2.jpg' },
      { file: 'images/character_03.jpg', name: 'character_3.jpg' },
      { file: 'images/character_04.jpg', name: 'character_4.jpg' },
      { file: 'images/img_character_01.jpg', name: 'img_character_1.jpg' },
      { file: 'images/img_character_02.jpg', name: 'img_character_2.jpg' }
    ];

    const extraChecks = await Promise.all(extraImages.map(async (item) => {
      const fullUrl = currentBaseUrl + item.file;
      const exists = await probeUrlExists(fullUrl, 250);
      return exists ? { url: fullUrl, customName: item.name } : null;
    }));

    for (const res of extraChecks) {
      if (res && !pages.some(p => p.customName === res.customName)) {
        pages.push(res);
      }
    }

    // 4. TRANG SERIES TĨNH KHÔNG DÙNG FOTORAMA
    const test001 = `${currentBaseUrl}images/browse/001.jpg`;
    const exists001 = await probeUrlExists(test001, 250);

    if (exists001) {
      const checkpoints = [10, 20, 30, 40, 50, 60, 70, 80];
      const checkResults = await Promise.all(checkpoints.map(async (cp) => {
        const ok = await probeUrlExists(`${currentBaseUrl}images/browse/${String(cp).padStart(3, '0')}.jpg`, 250);
        return { cp, ok };
      }));

      let maxCheckpoint = 1;
      for (const res of checkResults) {
        if (res.ok) maxCheckpoint = res.cp;
        else break;
      }

      const fineChecks = [];
      for (let i = maxCheckpoint; i <= maxCheckpoint + 10; i++) fineChecks.push(i);

      const fineResults = await Promise.all(fineChecks.map(async (p) => {
        const ok = await probeUrlExists(`${currentBaseUrl}images/browse/${String(p).padStart(3, '0')}.jpg`, 250);
        return { p, ok };
      }));

      let maxPage = 1;
      for (const res of fineResults) {
        if (res.ok) maxPage = res.p;
      }

      for (let i = 1; i <= maxPage; i++) {
        pages.push({
          pageNo: i,
          url: `${currentBaseUrl}images/browse/${String(i).padStart(3, '0')}.jpg`,
          customName: null
        });
      }
    }

    if (pages.length > 0) {
      return {
        seriesTitle: seriesTitle || "Gangan_Series",
        episodeTitle: episodeTitle,
        pages
      };
    }

    return null;
  }

  /* =========================================================================
   * BÓC TÁCH MANIFEST: GANGAN ONLINE
   * ========================================================================= */
  async function extractGanganOnline() {
    const target = DOC.getElementById('__NEXT_DATA__');
    let nextJson = null;
    if (target) {
      try { nextJson = JSON.parse(target.textContent); } catch (e) {}
    }

    let chapterData = nextJson?.props?.pageProps?.data || nextJson?.props?.pageProps?.chapter;
    
    // Lấy ID chương từ URL hiện tại và ID trong state cũ
    const currentChapId = getEpisodeId();
    const dataChapId = String(chapterData?.chapterId || chapterData?.id || '');

    // NẾU LÀ CHUYỂN TRANG SPA (State cũ không khớp URL hiện tại) HOẶC CHƯA CÓ DATA:
    // -> Kéo trực tiếp gói Next.js data route của đúng chương hiện tại (~30ms)
    if ((!chapterData || !chapterData.pages || (dataChapId && dataChapId !== currentChapId)) && nextJson?.buildId) {
      const match = WIN.location.pathname.match(/\/title\/([^\/]+)\/chapter\/([^\/]+)/i);
      if (match) {
        const [, titleId, chapterId] = match;
        try {
          const nextDataUrl = `${WIN.location.origin}/_next/data/${nextJson.buildId}/title/${titleId}/chapter/${chapterId}.json`;
          const Utils = window.MangaUtils || globalThis.MangaUtils;
          const buf = await Utils.fetchBuffer(nextDataUrl);
          const fetchedJson = JSON.parse(new TextDecoder().decode(buf));
          chapterData = fetchedJson?.pageProps?.data || fetchedJson?.pageProps?.chapter;
        } catch (err) {}
      }
    }

    if (!chapterData || !Array.isArray(chapterData.pages)) return null;

    const seriesTitle = chapterData.titleName || chapterData.seriesTitle || chapterData.title || "";
    const episodeTitle = chapterData.chapterName || chapterData.subTitle || "第1話";
    const origin = WIN.location.origin;

    const pages = [];
    let pageNo = 1;

    for (const p of chapterData.pages) {
      const imgObj = p.image || p.linkImage || p;
      let url = imgObj.imageUrl || imgObj.url || imgObj.src;
      if (!url) continue;

      if (!url.startsWith('http')) url = origin + (url.startsWith('/') ? '' : '/') + url;

      pages.push({ pageNo: pageNo++, url, customName: null });
    }

    return { seriesTitle, episodeTitle, pages };
  }

  /* =========================================================================
   * BÓC TÁCH MANIFEST: MANGA UP!
   * ========================================================================= */
  function unescapeRscString(str) {
    if (!str) return '';
    return str
      .replace(/\\u0026/g, '&')
      .replace(/&amp;/g, '&')
      .replace(/\\"/g, '"')
      .replace(/\\\//g, '/')
      .replace(/\\/g, '');
  }

  async function extractMangaUp() {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    const currentPath = WIN.location.pathname;
    let rscText = "";

    // 1. Kéo gói dữ liệu RSC của chương hiện tại
    if (currentPath.includes('/chapters/')) {
      try {
        const rscUrl = `${WIN.location.origin}${currentPath}?_rsc=1`;
        const buf = await Utils.fetchBuffer(rscUrl, { 'RSC': '1' });
        rscText = new TextDecoder().decode(buf);
      } catch (e) {}
    }

    // Dự phòng khi mở trang trực tiếp
    if (!rscText) {
      if (Array.isArray(WIN.self?.__next_f)) {
        for (const item of WIN.self.__next_f) {
          if (Array.isArray(item) && typeof item[1] === 'string') {
            rscText += item[1];
          }
        }
      }
      const scripts = DOC.querySelectorAll('script');
      for (const s of scripts) {
        rscText += s.textContent || "";
      }
    }

    // 2. Bóc tách tên truyện và tên chương
    const h1El = DOC.querySelector('h1');
    let seriesTitle = cleanString(h1El?.textContent);
    let episodeTitle = "";

    // Đọc từ phần tử hiển thị chương hiện tại trên DOM
    const activeEpDiv = h1El?.nextElementSibling || h1El?.parentElement?.querySelector('div[class*="text-on_background"], div[class*="text-title"]');
    if (activeEpDiv) {
      const txt = activeEpDiv.textContent?.trim() || "";
      if (/(?:第\s*)?[0-9０-９]+\s*話/i.test(txt)) {
        episodeTitle = cleanString(txt);
      }
    }

    // Dò theo ID chương hiện tại trong dữ liệu RSC
    const currentChapId = getEpisodeId();
    if (!episodeTitle && rscText && currentChapId) {
      const chapIdx = rscText.indexOf(currentChapId);
      if (chapIdx !== -1) {
        const subRsc = rscText.substring(Math.max(0, chapIdx - 300), chapIdx + 600);
        const rscTitleMatch = subRsc.match(/\"(?:name|chapterName|chapter_name|title)\"\s*:\s*\"([^\"]*第\s*[0-9０-９]+[^\"]*)\"/);
        if (rscTitleMatch) {
          episodeTitle = cleanString(unescapeRscString(rscTitleMatch[1]));
        }
      }
    }

    // Dự phòng quét các phần tử tiêu đề khác
    if (!episodeTitle) {
      const domEpEl = DOC.querySelector('div[class*="text-title"], div.text-on_background_high, h2, [class*="chapter"]');
      const epText = domEpEl?.textContent || "";
      const mEp = epText.match(/(?:第\s*)?[0-9０-９]+\s*話[^\n\r]*/);
      if (mEp) episodeTitle = cleanString(mEp[0]);
    }

    if (!seriesTitle) {
      const rawTitle = (DOC.title || "").split(/[|｜\-–—]/)[0].trim();
      const m = rawTitle.match(/^(.*?)(?:\s+[-－–—]\s+|\s+)((?:第\s*)?[0-9０-９]+\s*話.*)$/i);
      if (m) {
        seriesTitle = cleanString(m[1]);
        if (!episodeTitle) episodeTitle = cleanString(m[2]);
      } else {
        seriesTitle = cleanString(rawTitle);
      }
    }

    // 3. Trích xuất danh sách link ảnh
    const cleanText = unescapeRscString(rscText);
    const matches = cleanText.match(/https?:\/\/ja-img\.manga-up\.com\/[^\s"',]+\.webp\?hash=[^\s"',&]+&expires=\d+/gi) || [];

    const pageMap = new Map();
    for (const url of matches) {
      const pMatch = url.match(/_(\d{3})\.webp/i);
      if (pMatch) {
        const pIndex = parseInt(pMatch[1], 10);
        if (!pageMap.has(pIndex)) {
          pageMap.set(pIndex, url);
        }
      }
    }

    const sortedIndices = Array.from(pageMap.keys()).sort((a, b) => a - b);
    const pages = [];

    if (sortedIndices.length > 0) {
      sortedIndices.forEach((pIdx, idx) => {
        pages.push({
          pageNo: idx + 1,
          url: pageMap.get(pIdx),
          customName: null
        });
      });
    }

    if (pages.length > 0) {
      return {
        seriesTitle: seriesTitle || "MangaUP_Series",
        episodeTitle: episodeTitle || "",
        pages: pages
      };
    }

    return null;
  }

  async function fetchSquareEnixPages() {
    const host = WIN.location.hostname;
    if (host.includes('manga-up.com')) return await extractMangaUp();
    if (host.includes('ganganonline.com')) return await extractGanganOnline();
    if (host.includes('square-enix.com')) return await extractSquareEnixMagazine();
    return null;
  }

  /* =========================================================================
   * TIẾN TRÌNH TẢI CHÍNH (ZERO-COPY / 6 LUỒNG TRONG RAM)
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
        data = await fetchSquareEnixPages();
        state.chapterData = data;
      }

      if (!data || !data.pages?.length) throw new Error("Không tìm thấy dữ liệu trang.");

      const pages = data.pages;
      const totalPages = pages.length;
      const useJpeg = Boolean(state.convertJpeg);

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      const epId = getEpisodeId();
      zip.addFile(`${epId}.txt`, new Uint8Array(0));

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map((pageObj) => async () => {
        const rawBuffer = await Utils.fetchBuffer(pageObj.url, {
            "Referer": "https://www.manga-up.com/",
            "Origin": "https://www.manga-up.com"
        });
        const originalExt = getExtensionFromUrl(pageObj.url, 'jpg');

        // 1. Ảnh Artwork/Bìa/Cover: Giữ nguyên tên file gốc
        if (pageObj.customName) {
          return { fileName: pageObj.customName, data: new Uint8Array(rawBuffer) };
        }

        // 2. Zero-Copy nếu không ép JPG hoặc ảnh gốc đã là JPG
        if (!useJpeg || originalExt === 'jpg') {
          return {
            fileName: `${pageObj.pageNo}.${originalExt}`,
            data: new Uint8Array(rawBuffer)
          };
        }

        // 3. Chuyển đổi sang JPG nếu người dùng chọn
        const img = await Utils.loadImage(rawBuffer, `image/${originalExt}`);
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
          fileName: `${pageObj.pageNo}.jpg`,
          data: new Uint8Array(await blob.arrayBuffer())
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

      const zipName = `${getCleanTitle(data.seriesTitle, data.episodeTitle)}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[sqex-dl] Error:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * KHỞI TẠO & THEO DÕI SPA
   * ========================================================================= */
  function ensureUIPresence() {
    if (!isEpisodeUrl()) {
      if (state.ui?.panel) state.ui.panel.style.display = "none";
      return;
    }
    const ui = getUI();
    if (ui?.panel) {
      ui.panel.style.display = "block";
      if (!DOC.body.contains(ui.panel)) {
        DOC.body.appendChild(ui.panel);
      }
    }
  }

  async function boot() {
    while (!DOC.body) await sleep(30);

    ensureUIPresence();
    const ui = getUI();

    if (!isEpisodeUrl()) return;
    if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });

    let data = null;
    let retries = 0;

    while (retries < 10) {
      try {
        data = await fetchSquareEnixPages();
        if (data && data.pages?.length > 0) break;
      } catch (e) {}
      await sleep(50);
      retries++;
    }

    if (data && data.pages?.length > 0) {
      // Micro-delay 100ms để tạo hiệu ứng chuyển trạng thái mượt mà 0/0 -> 0/n
      await sleep(100);

      state.chapterData = data;

      const firstUrl = data.pages[0]?.url || "";
      const originalExt = getExtensionFromUrl(firstUrl, 'jpg');
      if (ui?.updateFormatUI) ui.updateFormatUI(originalExt);

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

  setInterval(() => {
    if (isEpisodeUrl() && DOC.body) {
      ensureUIPresence();
    }
  }, 500);

  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute((newUrl) => {
      if (newUrl === state.lastUrl) return;
      state.lastUrl = newUrl;

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