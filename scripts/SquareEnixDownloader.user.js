// ==UserScript==
// @name         Square Enix Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      2.3.0
// @icon         https://magazine.jp.square-enix.com/favicon.ico
// @description  Tải manga trên toàn bộ hệ sinh thái Square Enix (Gangan ONLINE, Manga UP, Shounen Gangan, GFantasy, Young Gangan, Big Gangan, Gangan Joker, ComiWeb, MANGA UP! Global).
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
   * 1. CẤU HÌNH & KHỞI TẠO HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6,   // 6 luồng tải song song qua CDN
    JPEG_QUALITY: 0.95   // Chất lượng xuất JPG nếu chuyển đổi
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("sqex-dl:convert-jpeg") === '1',
    chapterData: null,
    ui: null,
    lastUrl: "",
    globalMupViewerRaw: ""
  };

  /* =========================================================================
   * 2. CẦU NỐI MAIN-WORLD HOOK (BẮT GÓI VIEWER_V2 CỦA MANGA UP GLOBAL)
   * ========================================================================= */
  function handleViewerV2(url, text) {
    if (typeof text === 'string' && (text.includes('.webp.enc') || text.includes('page_high') || text.includes('KEE/') || text.includes('KFF/'))) {
      state.globalMupViewerRaw = text;
      const chapId = getEpisodeId();
      if (chapId) sessionStorage.setItem(`mup_global_raw_${chapId}`, text);
      if (isEpisodeUrl() && !state.running) boot();
    }
  }

  // Hook Fetch & XHR trên unsafeWindow
  const _fetch = WIN.fetch;
  if (typeof _fetch === 'function') {
    WIN.fetch = function(...args) {
      const p = _fetch.apply(this, args);
      p.then(res => {
        try {
          const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
          if (String(url).includes('viewer_v2')) {
            res.clone().text().then(txt => handleViewerV2(url, txt));
          }
        } catch (e) {}
      }).catch(() => {});
      return p;
    };
  }

  const _xhrOpen = WIN.XMLHttpRequest?.prototype?.open;
  const _xhrSend = WIN.XMLHttpRequest?.prototype?.send;
  if (_xhrOpen && _xhrSend) {
    WIN.XMLHttpRequest.prototype.open = function(method, url) {
      this._reqUrl = url;
      return _xhrOpen.apply(this, arguments);
    };
    WIN.XMLHttpRequest.prototype.send = function() {
      this.addEventListener('load', () => {
        if (this._reqUrl && String(this._reqUrl).includes('viewer_v2')) {
          handleViewerV2(this._reqUrl, this.responseText);
        }
      });
      return _xhrSend.apply(this, arguments);
    };
  }

  // Bơm Main World Bridge kèm MutationObserver chống miss gói tin tại document-start
  function injectMainWorld() {
    if (DOC.getElementById('__sqex_mup_bridge')) return;
    const s = DOC.createElement('script');
    s.id = '__sqex_mup_bridge';
    s.textContent = `
      (function() {
        function emit(u, t) {
          if (t && (t.includes('page_high') || t.includes('.webp.enc') || t.includes('KEE/') || t.includes('KFF/'))) {
            window.postMessage({ type: '__MUP_GLOBAL_V2_DATA__', url: String(u), text: t }, '*');
          }
        }
        const of = window.fetch;
        if (of) {
          window.fetch = async function(...a) {
            const u = typeof a[0] === 'string' ? a[0] : (a[0]?.url || '');
            const r = await of.apply(this, a);
            if (String(u).includes('viewer_v2')) {
              try { r.clone().text().then(t => emit(u, t)); } catch(e){}
            }
            return r;
          };
        }
        const ox = window.XMLHttpRequest;
        if (ox) {
          const oo = ox.prototype.open, os = ox.prototype.send;
          ox.prototype.open = function(m, u) { this._u = u; return oo.apply(this, arguments); };
          ox.prototype.send = function() {
            this.addEventListener('load', () => {
              if (String(this._u).includes('viewer_v2')) emit(this._u, this.responseText);
            });
            return os.apply(this, arguments);
          };
        }
      })();
    `;
    (DOC.head || DOC.documentElement).appendChild(s);
  }

  injectMainWorld();
  if (!DOC.documentElement) {
    const obs = new MutationObserver(() => {
      if (DOC.documentElement) { injectMainWorld(); obs.disconnect(); }
    });
    obs.observe(DOC, { childList: true });
  }

  WIN.addEventListener('message', (e) => {
    if (e.data?.type === '__MUP_GLOBAL_V2_DATA__' && e.data.text) {
      handleViewerV2(e.data.url, e.data.text);
    }
  });

  /* =========================================================================
   * 3. BẢNG CẤU HÌNH THEME & GIAO DIỆN UNIVERSAL UI
   * ========================================================================= */
  const SITE_THEMES = {
    "ganganonline.com":    { name: "Gangan ONLINE",  top: "50px",   color: "#6EC2EE", bg: "#ffffff", text: "#6EC2EE", sub: "SQUARE ENIX" },
    "manga-up.com":        { name: "Manga UP!",      top: "143px",  color: "#FF5500", bg: "#ffffff", text: "#FF5500", sub: "SQUARE ENIX" },
    "/gangan/":            { name: "Shounen Gangan", top: "70px",   color: "#38b6e6", bg: "#ffffff", text: "#0284c7", sub: "SQUARE ENIX" },
    "/gfantasy/":          { name: "GFantasy",       top: "70px",   color: "#a855f7", bg: "#18181b", text: "#c084fc", sub: "SQUARE ENIX" },
    "/joker/":             { name: "Gangan Joker",   top: "70px",   color: "#18181b", bg: "#ffffff", text: "#18181b", sub: "SQUARE ENIX" },
    "/yg/":                { name: "Young Gangan",   top: "110px",  color: "#e11d48", bg: "#ffffff", text: "#e11d48", sub: "SQUARE ENIX" },
    "/biggangan/":         { name: "Big Gangan",     top: "80px",   color: "#78be20", bg: "#ffffff", text: "#4c7c13", sub: "SQUARE ENIX" },
    "/comiweb/":           { name: "Comiweb",        top: "70px",   color: "#e60012", bg: "#18181b", text: "#fca5a5", sub: "SQUARE ENIX" },
    "global.manga-up.com": { name: "MANGAUP!",       top: "64px",   color: "#0D44B6", bg: "#ffffff", text: "#0D44B6", sub: "SQUARE ENIX" }
  };

  function resolveSiteTheme() {
    const host = WIN.location.hostname.toLowerCase();
    if (host === 'global.manga-up.com') return SITE_THEMES["global.manga-up.com"];

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
   * 4. BỘ HỖ TRỢ XỬ LÝ CHUỖI, ĐỊNH DẠNG & MÃ HÓA
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

  // Bộ lọc làm sạch tên truyện tổng hợp (xóa sạch tag SEO, NXB và tác giả)
  function cleanBaseTitle(raw) {
    if (!raw) return "";
    let s = raw.split(/[|｜]/)[0].trim();
    s = s.replace(/（[^）]*）/g, '')
         .replace(/\([^)]*\)/g, '')
         .replace(/【[^】]*】/g, '')
         .replace(/[-－–—\s]*(?:ガンガンJOKER|ガンガンジョーカー|月刊少年ガンガン|少年ガンガン|Gファンタジー|ビッグガンガン|ヤングガンガン|月刊ガンガン|Comiweb|SQUARE\s*ENIX|マンガＵＰ！?|MANGA\s*UP!)[-－–—\s]*/gi, '')
         .replace(/(?:を無料で読むなら|無料版|無料|試し読み|特別試し読み)/g, '')
         .replace(/[-－–—\s]+$/, '')
         .trim();
    return cleanString(s);
  }

  function getCleanTitle(manifestSeriesTitle, manifestEpisodeTitle) {
    let seriesTitle = cleanBaseTitle(manifestSeriesTitle);
    let episodeTitle = cleanBaseTitle(manifestEpisodeTitle);

    // Chuyển đổi ngoặc 「...」 hoặc [...] thành khoảng trắng toàn giác \u3000
    seriesTitle = seriesTitle.replace(/[「\[]([^」\]]+)[」\]]/g, '\u3000$1').trim();
    episodeTitle = episodeTitle.replace(/[「\[]([^」\]]+)[」\]]/g, '\u3000$1').trim();

    // Nếu trong seriesTitle đã có sẵn số chương (ví dụ: "宵明けの魔女 第1話" -> tách thành "宵明けの魔女" và "第1話")
    const sMatch = seriesTitle.match(/^(.+?)(?:\s+[-－–—]\s+|\s+)((?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\s\-\–\—\ー\~〜\.]+(?:話|局|曲|話目|限目|時限目|部|エピソード|分冊版|単話|前編|中編|後編|本目).*)$/i);
    if (sMatch) {
      seriesTitle = cleanString(sMatch[1]);
      if (!episodeTitle) episodeTitle = cleanString(sMatch[2]);
    }

    // Cắt bỏ phần tên truyện nếu bị lặp lại ở đầu tên chap
    if (seriesTitle && episodeTitle) {
      if (episodeTitle.startsWith(seriesTitle)) {
        episodeTitle = cleanString(episodeTitle.substring(seriesTitle.length));
      }
      episodeTitle = episodeTitle.replace(/^[-－–—\s・:]+/, '').trim();
    }

    // Lọc sạch rác còn sót trong episodeTitle
    if (episodeTitle) {
      episodeTitle = episodeTitle
        .replace(/(?:試し読み|無料版|無料|特別試し読み)/g, '')
        .replace(/[-－–—\s]*(?:ガンガンJOKER|ガンガンジョーカー|月刊少年ガンガン|少年ガンガン|Gファンタジー|ビッグガンガン|ヤングガンガン|月刊ガンガン|Comiweb|SQUARE\s*ENIX|マンガＵＰ！?|MANGA\s*UP!)[-－–—\s]*/gi, '')
        .replace(/[-－–—\s]+$/, '')
        .trim();
    }

    if (seriesTitle && episodeTitle && episodeTitle !== seriesTitle) {
      return `${seriesTitle} - ${episodeTitle}`;
    }
    return seriesTitle || episodeTitle || `SquareEnix_${getEpisodeId()}`;
  }

  function getExtensionFromUrl(url, defaultExt = 'jpg') {
    try {
      const pathname = new URL(url, WIN.location.href).pathname;
      const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
      if (match && match[1]) {
        const ext = match[1].toLowerCase();
        if (['jpg', 'jpeg', 'png', 'webp', 'avif'].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext;
      }
    } catch (e) {}
    return defaultExt;
  }

  function unhex(hexString) {
    const arr = new Uint8Array(hexString.length / 2);
    for (let i = 0; i < hexString.length; i += 2) arr[i / 2] = parseInt(hexString.substring(i, i + 2), 16);
    return arr;
  }

  function unescapeRscString(str) {
    if (!str) return '';
    return str.replace(/\\u0026/g, '&').replace(/&amp;/g, '&').replace(/\\"/g, '"').replace(/\\\//g, '/').replace(/\\/g, '');
  }

  function isEpisodeUrl() {
    const host = WIN.location.hostname;
    const path = WIN.location.pathname;

    if (host === 'global.manga-up.com') return /\/manga\/\d+\/\d+/i.test(path) || /\/chapters?\/[^\/]+/i.test(path);
    if (host.includes('manga-up.com')) return /\/titles?\/\d+/i.test(path) || /\/manga\/\d+/i.test(path) || /\/chapters?\//i.test(path);
    if (host.includes('ganganonline.com')) return /\/title\/[^\/]+\/chapter\/[^\/]+/i.test(path);
    if (host.includes('square-enix.com')) {
      const cleanPath = path.replace(/\/index\.html?$/i, '').replace(/\/$/, '');
      if (cleanPath.startsWith('/yg/')) return /\/yg\/introduction\/[a-zA-Z0-9_-]+$/i.test(cleanPath);
      return /\/(?:tcym|tachiyomi|viewer|browse|series|introduction)\/[a-zA-Z0-9_-]+/i.test(cleanPath);
    }
    return false;
  }

  function getEpisodeId() {
    const cleanPath = WIN.location.pathname.replace(/\/index\.html?$/i, '').replace(/\/$/, '');
    const globalMatch = cleanPath.match(/\/manga\/\d+\/([a-zA-Z0-9_-]+)/i);
    if (globalMatch) return globalMatch[1];
    const mupMatch = cleanPath.match(/\/chapters?\/([a-zA-Z0-9_-]+)/i);
    if (mupMatch) return mupMatch[1];
    const titleMatch = cleanPath.match(/\/titles?\/([a-zA-Z0-9_-]+)/i);
    if (titleMatch) return `title_${titleMatch[1]}`;
    const ggoMatch = cleanPath.match(/\/chapter\/([a-zA-Z0-9_-]+)/i);
    if (ggoMatch) return ggoMatch[1];
    const tcymMatch = cleanPath.match(/\/(?:tcym|tachiyomi|viewer|browse|series|introduction)\/([a-zA-Z0-9_-]+)$/i);
    if (tcymMatch) return tcymMatch[1];
    return "SquareEnix_Episode";
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
   * 5. BÓC TÁCH MANIFEST: TẠP CHÍ SQUARE ENIX
   * ========================================================================= */
  async function extractSquareEnixMagazine() {
    const cleanPath = WIN.location.pathname.replace(/\/index\.html?$/i, '').replace(/\/?$/, '/');
    const origin = WIN.location.origin;
    const currentBaseUrl = `${origin}${cleanPath}`;

    let rawTitle = cleanBaseTitle(DOC.title || "");
    rawTitle = rawTitle.replace(/[「\[]([^」\]]+)[」\]]/g, '\u3000$1').trim();

    let seriesTitle = "";
    let episodeTitle = "";

    const titleMatch = rawTitle.match(/^(.+?)(?:\s+[-－–—]\s+|\s+)((?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\s\-\–\—\ー\~〜\.]+(?:話|局|曲|話目|限目|時限目|部|エピソード|分冊版|単話|前編|中編|後編|本目).*)$/i);
    if (titleMatch) {
      seriesTitle = cleanString(titleMatch[1]);
      episodeTitle = cleanString(titleMatch[2]);
    } else {
      seriesTitle = cleanBaseTitle(DOC.querySelector('h1, h2, .series_ttl h2, .title, #title')?.textContent) || rawTitle;
      const domEpEl = DOC.querySelector('.content_inner p.title, #tachiyomi p.title, p.title');
      if (domEpEl) {
        let epText = cleanBaseTitle(domEpEl.textContent).replace(/[「\[]([^」\]]+)[」\]]/g, '\u3000$1').trim();
        const mEp = epText.match(/(?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\s\-\–\—\ー\~〜\.]+(?:話|局|曲|話目|限目|時限目|部|エピソード|分冊版|単話|前編|中編|後編|本目).*/i);
        if (mEp) episodeTitle = cleanString(mEp[0]);
      }
    }

    const pages = [];

    // Quét ảnh Artwork / Character / Cover từ DOM
    const artworkImgs = DOC.querySelectorAll('img[src*="cover/"], img[src*="main.jpg"], img[src*="image_sam"], img[src*="character_"], img[src*="img_character"], #adBox img, #series_main img, .character_img img');
    for (const img of artworkImgs) {
      let src = img.getAttribute('src') || '';
      if (src) {
        const lower = src.toLowerCase();
        if (lower.includes('_.gif') || lower.includes('bg.') || lower.includes('share') || lower.includes('line.png') || lower.includes('twitter') || lower.includes('common/images') || /img\d+\.(png|jpg)/i.test(lower)) continue;
        const fullUrl = new URL(src, WIN.location.href).href;
        const fileName = fullUrl.split('/').pop().split('?')[0];
        if (!pages.some(p => p.url === fullUrl)) {
          pages.push({ url: fullUrl, customName: fileName });
        }
      }
    }

    // Engine Fotorama
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
      let pagesBaseUrl = resolvedDir.startsWith('http') ? resolvedDir : (resolvedDir.startsWith('/') ? `${origin}${resolvedDir}` : `${currentBaseUrl}${resolvedDir}`);
      if (!pagesBaseUrl.endsWith('/')) pagesBaseUrl += '/';
      const cacheQuery = (fotoramaImgVal && fotoramaImgVal !== "0" && fotoramaImgVal !== 0) ? `?${fotoramaImgVal}` : '';

      for (let i = 1; i <= fotoramaPageNum; i++) {
        pages.push({ pageNo: i, url: `${pagesBaseUrl}${String(i).padStart(3, '0')}.jpg${cacheQuery}`, customName: null });
      }
      return { seriesTitle: seriesTitle || "Gangan_Series", episodeTitle, pages };
    }

    // Trang Series tĩnh
    const test001 = `${currentBaseUrl}images/browse/001.jpg`;
    if (await probeUrlExists(test001, 250)) {
      const checkpoints = [10, 20, 30, 40, 50, 60, 70, 80];
      const checkResults = await Promise.all(checkpoints.map(async (cp) => ({ cp, ok: await probeUrlExists(`${currentBaseUrl}images/browse/${String(cp).padStart(3, '0')}.jpg`, 250) })));
      let maxCp = 1;
      for (const res of checkResults) { if (res.ok) maxCp = res.cp; else break; }

      const fineChecks = Array.from({ length: 11 }, (_, idx) => maxCp + idx);
      const fineResults = await Promise.all(fineChecks.map(async (p) => ({ p, ok: await probeUrlExists(`${currentBaseUrl}images/browse/${String(p).padStart(3, '0')}.jpg`, 250) })));
      let maxPage = 1;
      for (const res of fineResults) { if (res.ok) maxPage = res.p; }

      for (let i = 1; i <= maxPage; i++) {
        pages.push({ pageNo: i, url: `${currentBaseUrl}images/browse/${String(i).padStart(3, '0')}.jpg`, customName: null });
      }
    }

    return pages.length > 0 ? { seriesTitle: seriesTitle || "Gangan_Series", episodeTitle, pages } : null;
  }

  /* =========================================================================
   * 6. BÓC TÁCH MANIFEST: GANGAN ONLINE
   * ========================================================================= */
  async function extractGanganOnline() {
    const target = DOC.getElementById('__NEXT_DATA__');
    let nextJson = null;
    if (target) { try { nextJson = JSON.parse(target.textContent); } catch (e) {} }

    let chapterData = nextJson?.props?.pageProps?.data || nextJson?.props?.pageProps?.chapter;
    const currentChapId = getEpisodeId();
    const dataChapId = String(chapterData?.chapterId || chapterData?.id || '');

    // Kéo Next.js data route khi chuyển trang SPA
    if ((!chapterData || !chapterData.pages || (dataChapId && dataChapId !== currentChapId)) && nextJson?.buildId) {
      const match = WIN.location.pathname.match(/\/title\/([^\/]+)\/chapter\/([^\/]+)/i);
      if (match) {
        try {
          const nextDataUrl = `${WIN.location.origin}/_next/data/${nextJson.buildId}/title/${match[1]}/chapter/${match[2]}.json`;
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
   * 7. BÓC TÁCH MANIFEST: MANGA UP! (BẢN NHẬT)
   * ========================================================================= */
  async function extractMangaUp() {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    const currentPath = WIN.location.pathname;
    let rscText = "";

    if (currentPath.includes('/titles/') || currentPath.includes('/chapters/') || currentPath.includes('/manga/')) {
      try {
        const rscUrl = `${WIN.location.origin}${currentPath}?_rsc=1`;
        const buf = await Utils.fetchBuffer(rscUrl, { 'RSC': '1' });
        rscText = new TextDecoder().decode(buf);
      } catch (e) {}
    }

    if (!rscText && Array.isArray(WIN.self?.__next_f)) {
      for (const item of WIN.self.__next_f) {
        if (Array.isArray(item) && typeof item[1] === 'string') rscText += item[1];
      }
    }

    // 1. Tên truyện siêu sạch từ document.title
    let rawTitle = (DOC.querySelector('meta[property="og:title"]')?.getAttribute('content') || DOC.title || "").split(/[|｜]/)[0];
    let seriesTitle = cleanBaseTitle(rawTitle);

    // 2. Bóc tách Tên chương trực tiếp từ <h1> và thẻ phụ ngay dưới <h1>
    let episodeTitle = "";
    const h1El = DOC.querySelector('h1');

    if (h1El) {
      let h1Text = cleanString(h1El.textContent);
      let part1 = (seriesTitle && h1Text.startsWith(seriesTitle)) ? cleanString(h1Text.substring(seriesTitle.length)) : (h1Text !== seriesTitle ? h1Text : "");
      let part2 = "";

      const subEl = h1El.nextElementSibling || h1El.parentElement?.querySelector('p, div[class*="text-"]');
      if (subEl) {
        let subText = cleanString(subEl.textContent);
        if (subText && subText !== seriesTitle && !subText.includes('更新') && !subText.includes('著者') && !subText.includes('コメント')) {
          part2 = subText;
        }
      }

      episodeTitle = (part1 && part2 && !part1.includes(part2)) ? `${part1} ${part2}` : (part1 || part2);
    }

    // 3. Trích xuất danh sách link ảnh
    const cleanText = unescapeRscString(rscText);
    const matches = cleanText.match(/https?:\/\/ja-img\.manga-up\.com\/[^\s"',]+\.webp\?hash=[^\s"',&]+&expires=\d+/gi) || [];

    const pageMap = new Map();
    for (const url of matches) {
      const pMatch = url.match(/_(\d{3})\.webp/i);
      if (pMatch) {
        const pIndex = parseInt(pMatch[1], 10);
        if (!pageMap.has(pIndex)) pageMap.set(pIndex, url);
      }
    }

    const sortedIndices = Array.from(pageMap.keys()).sort((a, b) => a - b);
    const pages = sortedIndices.map((pIdx, idx) => ({ pageNo: idx + 1, url: pageMap.get(pIdx), customName: null }));

    return pages.length > 0 ? { seriesTitle: seriesTitle || "MangaUP_Series", episodeTitle: episodeTitle || "第1話", pages } : null;
  }

  /* =========================================================================
   * 8. BÓC TÁCH MANIFEST: MANGA UP! GLOBAL (global.manga-up.com)
   * ========================================================================= */
  async function extractMangaUpGlobal() {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    const path = WIN.location.pathname;
    const pathParts = path.match(/\/manga\/(\d+)(?:\/(\d+))?/i);
    const mangaId = pathParts ? pathParts[1] : "";
    const chapId = pathParts && pathParts[2] ? pathParts[2] : getEpisodeId();

    // 1. Dò tìm gói tin viewer_v2 từ Hook, Cache hoặc Performance API
    let rawConfig = state.globalMupViewerRaw || (chapId ? sessionStorage.getItem(`mup_global_raw_${chapId}`) : "");

    if (!rawConfig && typeof window.performance?.getEntriesByType === 'function') {
      const v2Entry = window.performance.getEntriesByType('resource').find(r => r.name && r.name.includes('viewer_v2'));
      if (v2Entry) {
        try {
          const res = await WIN.fetch(v2Entry.name);
          if (res.ok) {
            rawConfig = await res.text();
            handleViewerV2(v2Entry.name, rawConfig);
          }
        } catch (e) {}
      }
    }

    if (!rawConfig) {
      for (let i = 0; i < 20; i++) {
        await sleep(100);
        rawConfig = state.globalMupViewerRaw || (chapId ? sessionStorage.getItem(`mup_global_raw_${chapId}`) : "");
        if (rawConfig) break;
      }
    }

    // 2. Lấy Tên truyện và Tên chương từ trang chi tiết / __NEXT_DATA__
    let seriesTitle = mangaId ? sessionStorage.getItem(`mup_global_manga_${mangaId}`) || "" : "";
    let episodeTitle = "";

    if ((!seriesTitle || !episodeTitle) && mangaId) {
      try {
        const res = await WIN.fetch(`https://global.manga-up.com/manga/${mangaId}`);
        if (res.ok) {
          const html = await res.text();
          const doc = new DOMParser().parseFromString(html, 'text/html');
          
          if (!seriesTitle) {
            const h1 = doc.querySelector('h1');
            if (h1) {
              seriesTitle = cleanString(h1.textContent);
              sessionStorage.setItem(`mup_global_manga_${mangaId}`, seriesTitle);
            }
          }

          const nextData = doc.getElementById('__NEXT_DATA__');
          if (nextData) {
            const json = JSON.parse(nextData.textContent);
            const chapters = json.props?.pageProps?.data?.chapters || [];
            const curChap = chapters.find(c => String(c.id) === String(chapId));
            if (curChap) {
              const mainN = cleanString(curChap.mainName || "");
              const subN = cleanString(curChap.subName || "");
              episodeTitle = (mainN && subN && !mainN.includes(subN)) ? `${mainN} ${subN}` : (mainN || subN);
            }
          }
        }
      } catch (e) {}
    }

    // Dự phòng tên chương từ dòng 1 của viewer_v2
    if (!episodeTitle && rawConfig) {
      const lines = rawConfig.split(/[\r\n]+/);
      for (const l of lines) {
        const cleanL = cleanString(l);
        if (cleanL && !cleanL.includes('.webp') && !cleanL.includes('*@')) {
          episodeTitle = cleanL;
          break;
        }
      }
    }

    // 3. Bóc tách danh sách ảnh và cặp Key/IV AES-CBC
    if (rawConfig) {
      const pages = [];
      const lines = rawConfig.split(/[\r\n]+/);

      for (const line of lines) {
        if (!line.includes('.webp.enc') && !line.includes('.enc')) continue;
        const atParts = line.split('*@');
        if (atParts.length < 2) continue;

        const pathMatch = atParts[0].match(/([A-Za-z0-9_/-]+\.webp\.enc\?[^\s*]+)/);
        if (!pathMatch) continue;

        let rawPath = pathMatch[1].replace(/^[A-Z]\//i, '');
        const relPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
        const fullUrl = `https://global-img.manga-up.com${relPath}`;

        const cryptoText = atParts[1].trim();
        const hexParts = cryptoText.match(/[0-9a-f]{32,66}/gi) || [];
        if (hexParts.length < 2) continue;

        pages.push({
          pageNo: pages.length + 1,
          url: fullUrl,
          isEncrypted: true,
          crypto: { key: hexParts[0].substring(0, 64), iv: hexParts[1].substring(0, 32) },
          customName: null
        });
      }

      if (pages.length > 0) {
        return {
          seriesTitle: seriesTitle || "MangaUP_Global",
          episodeTitle: episodeTitle || (chapId ? `Chapter_${chapId}` : ""),
          pages: pages
        };
      }
    }

    return null;
  }

  async function fetchSquareEnixPages() {
    const host = WIN.location.hostname;
    if (host === 'global.manga-up.com') return await extractMangaUpGlobal();
    if (host.includes('manga-up.com')) return await extractMangaUp();
    if (host.includes('ganganonline.com')) return await extractGanganOnline();
    if (host.includes('square-enix.com')) return await extractSquareEnixMagazine();
    return null;
  }

  /* =========================================================================
   * 9. TIẾN TRÌNH TẢI CHÍNH & GIẢI MÃ PHẦN CỨNG AES-CBC (6 LUỒNG TRONG RAM)
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

      zip.addFile(`${getEpisodeId()}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map((pageObj) => async () => {
        let rawBuffer = null;

        try {
          const res = await WIN.fetch(pageObj.url);
          if (res.ok) rawBuffer = await res.arrayBuffer();
        } catch (e) {}

        if (!rawBuffer) rawBuffer = await Utils.fetchBuffer(pageObj.url);

        // Giải mã phần cứng AES-CBC (MANGA UP! Global)
        if (pageObj.isEncrypted && pageObj.crypto?.key && pageObj.crypto?.iv) {
          const cryptoKey = await WIN.crypto.subtle.importKey('raw', unhex(pageObj.crypto.key), { name: 'AES-CBC' }, false, ['decrypt']);
          rawBuffer = await WIN.crypto.subtle.decrypt({ name: 'AES-CBC', iv: unhex(pageObj.crypto.iv) }, cryptoKey, rawBuffer);
        }

        const originalExt = getExtensionFromUrl(pageObj.url, 'webp');

        if (pageObj.customName) {
          return { fileName: pageObj.customName, data: new Uint8Array(rawBuffer) };
        }

        // Zero-Copy nếu không ép JPG hoặc ảnh gốc đã là JPG
        if (!useJpeg || originalExt === 'jpg') {
          return { fileName: `${pageObj.pageNo}.${originalExt}`, data: new Uint8Array(rawBuffer) };
        }

        // Chuyển đổi sang JPG nếu người dùng chọn
        const img = await Utils.loadImage(rawBuffer, `image/${originalExt}`);
        const canvas = DOC.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;

        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);

        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', CONFIG.JPEG_QUALITY));
        canvas.width = 0; canvas.height = 0;

        return { fileName: `${pageObj.pageNo}.jpg`, data: new Uint8Array(await blob.arrayBuffer()) };
      });

      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res?.data) zip.addFile(res.fileName, res.data);
      }

      zip.download(`${getCleanTitle(data.seriesTitle, data.episodeTitle)}.zip`);
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

    let data = null;
    let retries = 0;

    while (retries < 6) {
      try {
        data = await fetchSquareEnixPages();
        if (data && data.pages?.length > 0) break;
      } catch (e) {}
      await sleep(100);
      retries++;
    }

    if (data && data.pages?.length > 0) {
      await sleep(100);
      state.chapterData = data;

      const firstUrl = data.pages[0]?.url || "";
      const originalExt = getExtensionFromUrl(firstUrl, 'webp');
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
    if (isEpisodeUrl() && DOC.body) ensureUIPresence();
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