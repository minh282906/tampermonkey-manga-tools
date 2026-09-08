// ==UserScript==
// @name         PUBLUS Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      4.0.0
// @icon         http://www.google.com/s2/favicons?domain=publus.jp&sz=128
// @description  Tải manga trên toàn bộ hệ sinh thái ACCESS PUBLUS Reader / NFBR (BookWalker, Pixiv Comic Store, DMM Books).
// @author       anonymous & AI
// @match        https://viewer.bookwalker.jp/*/viewer.html*
// @match        https://viewer-trial.bookwalker.jp/*/viewer.html*
// @match        https://comic-store-viewer.pixiv.net/static/viewer*
// @match        https://book.dmm.com/*
// @match        https://book.dmm.co.jp/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      bookwalker.jp
// @connect      *.bookwalker.jp
// @connect      pixiv.net
// @connect      *.pixiv.net
// @connect      *.pximg.net
// @connect      dmm.com
// @connect      *.dmm.com
// @connect      dmm.co.jp
// @connect      *.dmm.co.jp
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/PublusDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/PublusDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/decoders/PublusTools.js
// ==/UserScript==

(function publusUniversalDownloader() {
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

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("publus-dl:convert-jpeg") === '1',
    episodeData: null,
    dmmData: null,
    bwData: null,
    ui: null
  };

  /* =========================================================================
   * BỘ ADAPTER THEME TỰ ĐỘNG
   * ========================================================================= */
  const SITE_THEMES = {
    "bookwalker.jp": {
      name: "BookWalker", color: "#0284c7", bg: "#ffffff", text: "#0284c7", btnBg: "#ffffff",
      btnColor: "#0284c7", btnBorder: "1px solid #0284c7", tabBg: "#ffffff", 
      tabColor: "#0284c7", tabBorder: "1px solid #0284c7", top: "44px"
    },
    "pixiv.net": { 
      name: "Pixiv Comic", color: "#0096fa", bg: "#ffffff", text: "#0096fa", btnBg: "#0096fa",
      btnColor: "#ffffff", btnBorder: "0", tabBg: "#0096fa", tabColor: "#ffffff",
      tabBorder: "none", top: "44px"
    },
    // FANZA Books (book.dmm.co.jp):
    "dmm.co.jp": {
      name: "FANZA Books", color: "#cc1835", bg: "#ffffff", text: "#000000", btnBg: "#cc1835",
      btnColor: "#ffffff", btnBorder: "0", tabBg: "#cc1835", tabColor: "#ffffff",
      tabBorder: "none", top: "64px"
    },
    // DMM Books (book.dmm.com):
    "dmm.com": {
      name: "DMM Books", color: "#00a4bd", bg: "#ffffff", text: "#000000", btnBg: "#00a4bd",
      btnColor: "#ffffff", btnBorder: "0", tabBg: "#00a4bd", tabColor: "#ffffff",
      tabBorder: "none", top: "64px"
    }
  };

  function isBookWalker() {
    return WIN.location.hostname.includes("bookwalker.jp");
  }

  function isPixivStore() {
    return WIN.location.hostname.includes("comic-store-viewer.pixiv.net");
  }
  
  function isDmm() {
    return WIN.location.hostname.includes("dmm.co.jp") || WIN.location.hostname.includes("dmm.com");
  }

  // Xử lý webtoon
  // Quét toàn bộ từ khóa đọc dọc (Katakana, Hiragana, Kanji, Romaji)
  function isDmmWebtoon() {
    try {
      const fullText = (
        (DOC.title || '') + ' ' +
        (DOC.querySelector('meta[property="og:title"]')?.content || '') + ' ' +
        (state.dmmData?.title || '') + ' ' +
        (DOC.querySelector('h1, .title, [class*="title"]')?.textContent || '') + ' ' +
        WIN.location.href
      ).toLowerCase();

      return fullText.includes('タテヨミ') || 
             fullText.includes('たてよみ') || 
             fullText.includes('縦読み') || 
             fullText.includes('tateyomi') || 
             fullText.includes('webtoon');
    } catch (e) {
      return false;
    }
  }

  // Nếu là Tateyomi -> Luôn trả về 44px; Nếu là Manga thường -> Trả về top trong SITE_THEMES
  function getDmmTopOffset(defaultTop = "44px") {
    if (isDmmWebtoon()) return "44px";
    return defaultTop;
  }

  function resolveSiteTheme() {
    const host = WIN.location.hostname.toLowerCase();

    if (host.includes("dmm.com")) {
      const t = Object.assign({}, SITE_THEMES["dmm.com"]);
      t.top = getDmmTopOffset(t.top);
      return t;
    }
    if (host.includes("dmm.co.jp")) {
      const t = Object.assign({}, SITE_THEMES["dmm.co.jp"]);
      t.top = getDmmTopOffset(t.top);
      return t;
    }
    if (host.includes("pixiv.net")) return SITE_THEMES["pixiv.net"];
    if (host.includes("bookwalker.jp")) return SITE_THEMES["bookwalker.jp"];

    return { name: "PUBLUS Reader", color: "#0284c7", bg: "#ffffff", text: "#0284c7", top: "44px" };
  }

  /* =========================================================================
   * 1. GIAO DIỆN UNIVERSAL UI 2 TẦNG
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const theme = resolveSiteTheme();
      const isBwTrial = WIN.location.hostname.includes("viewer-trial.bookwalker.jp") || WIN.location.href.includes("viewer-trial");

      const uiConfig = {
        storagePrefix: "publus-dl",
        title: theme.name,
        engine: "PUBLUS",
        themeColor: theme.color,
        themeBg: theme.bg,
        titleColor: theme.text,
        btnBg: theme.btnBg,
        btnColor: theme.btnColor,
        btnBorder: theme.btnBorder,
        tabBg: theme.tabBg,
        tabColor: theme.tabColor,
        tabBorder: theme.tabBorder,
        topOffset: theme.top,
        defaultJpgText: isBwTrial ? "Xuất file JPG (ảnh gốc là JPG)" : "Xuất file JPG (mặc định PNG)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("publus-dl:convert-jpeg", checked ? '1' : '0');
        }
      };

      state.ui = createUI(uiConfig);

      // Khóa cứng định dạng JPG gốc ngay từ đầu cho BookWalker Trial
      if (isBwTrial && state.ui?.updateFormatUI) {
        state.ui.updateFormatUI('jpg');
      }

      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:${uiConfig.titleColor};letter-spacing:0.2px;">${uiConfig.title}</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px;">PUBLUS READER</div>
          `;
        }
      }
    }
    return state.ui;
  }

  /* =========================================================================
   * 2. BỘ HỖ TRỢ XỬ LÝ CHUỖI VÀ URL
   * ========================================================================= */
  
  // Dành cho Iframe BookWalker và Pixiv Comic Store
  const FALLBACK_WIDTH  = 1440;
  const FALLBACK_HEIGHT = 2048;
  const FRAME_TIMEOUT   = 45000;

  function isEpisodeUrl() {
    const path = WIN.location.pathname;
    const search = WIN.location.search;
    if (isDmm()) {
      return search.includes('cid=') || /\/(?:product|streaming)\//.test(path);
    }
    return /\/viewer\.html/.test(path) || /\/static\/viewer/.test(path) || search.includes('cid=');
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
      const match = WIN.location.search.match(/[?&]cid=([^&#]+)/);
      if (match && match[1]) return decodeURIComponent(match[1]);
    } catch (e) {}
    const rt = getNFBRRuntime(WIN);
    return getModelProperty(rt?.model, "contentId") || "Publus_Manga";
  }

  function getCleanTitle() {
    try {
      if (isDmm() && state.dmmData?.title) {
        let raw = state.dmmData.title.replace(/〜/g, ' ').replace(/【[^】]*】/g, '').trim();
        return cleanString(raw) || `DMM_${getEpisodeId()}`;
      }

      const rt = getNFBRRuntime(WIN);
      let title = state.bwData?.title || "";

      // 1. Quét DOM chuẩn xác theo thẻ của Pixiv Store (#pagetitle) và BookWalker (.p-viewer__title)
      if (!title) {
        const headerEl = DOC.querySelector('#pagetitle .titleText, #pagetitle, .p-viewer__title, header h1');
        if (headerEl) title = headerEl.getAttribute('title') || headerEl.textContent.trim();
      }
      if (!title) title = rt?.menu?.getContentTitle?.() || "";
      if (!title && DOC.title && !DOC.title.includes("PUBLUS Reader")) {
        title = DOC.title;
      }

      let raw = title.replace(/[\/|]\s*BOOK\*WALKER.*/i, '')
                     .replace(/[-|｜]\s*pixiv.*$/i, '')
                     .trim();

      // 2. Lọc sạch tag rác khuyến mãi (giữ lại các bản đặc biệt)
      raw = raw.replace(/【(?!(?:フルカラー版|カラー版|完全版|特装版))[^】]*】/gi, '').trim();
      raw = raw.replace(/\[[^\]]*\]/g, '').trim();
      raw = raw.replace(/^公式\s*[-－_]?\s*/i, '').trim();
      raw = raw.replace(/\u3000+/g, ' ').replace(/\s{2,}/g, ' ').trim();

      // 3. Phân tách Tên Truyện - Tên Tập
      const match = raw.match(/^(.*?)(?:[\s:：]+[-－–—/]?[\s:：]*|[\s:：]+)((?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万]+(?:\.[0-9]+)?\s*(?:話|巻|章|節|部|エピソード|分冊版|単話|前編|中編|後編)?.*)$/i);
      if (match && match[1] && match[2]) {
        return `${cleanString(match[1])} - ${cleanString(match[2])}`;
      }

      return cleanString(raw) || `Publus_${getEpisodeId()}`;
    } catch (e) {}

    return `Publus_${getEpisodeId()}`;
  }

  /* =========================================================================
   * 3.A NHÁNH DMM BOOKS
   * ========================================================================= */
  async function fetchDmmManifest() {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    const Tools = window.PublusTools || globalThis.PublusTools;
    if (!Utils || !Tools) throw new Error("Chưa nạp đủ MangaUtils và PublusTools.");

    const params = new URLSearchParams(WIN.location.search);
    let cid = params.get('cid');
    let lin = params.get('lin') || '1'; // Nếu URL không có lin thì tự fallback về 1

    if (!cid) {
      const match = WIN.location.pathname.match(/\/product\/\d+\/([a-zA-Z0-9_-]+)/);
      if (match) cid = match[1];
    }
    if (!cid) throw new Error("Không tìm thấy CID trên trang DMM.");

    const authUrl = `https://${WIN.location.host}/viewerapi/auth/?cid=${encodeURIComponent(cid)}&lin=${encodeURIComponent(lin)}`;
    const authBuffer = await Utils.fetchBuffer(authUrl, {
      "Accept": "application/json, text/plain, */*",
      "X-Requested-With": "XMLHttpRequest"
    });

    const rawAuth = JSON.parse(new TextDecoder().decode(authBuffer));
    const authData = rawAuth?.data || rawAuth?.result || rawAuth;

    if (!authData || (!authData.url && !authData.base_url)) {
      const msg = rawAuth?.message || rawAuth?.error || "Auth response rỗng";
      throw new Error(`DMM Auth lỗi: ${msg}`);
    }

    const cdnBaseUrl = (authData.url || authData.base_url).replace(/\/?$/, '/');
    const authInfo = authData.auth_info || authData.authInfo || {};
    const authQuery = typeof authInfo === 'string' ? authInfo : new URLSearchParams(authInfo).toString();

    // Thử tải configuration_pack.json
    let configData = null;
    let isNeedNormalDefault = false;

    try {
      const buf = await Utils.fetchBuffer(`${cdnBaseUrl}configuration_pack.json?${authQuery}`);
      configData = JSON.parse(new TextDecoder().decode(buf));
    } catch (e) {
      const buf = await Utils.fetchBuffer(`${cdnBaseUrl}normal_default/configuration_pack.json?${authQuery}`);
      configData = JSON.parse(new TextDecoder().decode(buf));
      isNeedNormalDefault = true;
    }

    if (!configData || !configData.configuration?.contents) {
      throw new Error("Không lấy được cấu hình configuration_pack.json của DMM.");
    }

    const pages = [];
    const contents = configData.configuration.contents;

    for (const content of contents) {
      const filename = content.file;
      const isShareFile = filename.includes('../');
      const fileData = configData[filename] || configData[filename.replace('../', '')];
      const fileInfo = fileData?.FileLinkInfo;
      const pageCount = fileInfo?.PageCount || 1;
      const pageLinkList = fileInfo?.PageLinkInfoList || [];

      for (let idx = 0; idx < pageCount; idx++) {
        const fileSubPath = isNeedNormalDefault
          ? `normal_default/${isShareFile ? filename.replace('../', '') : filename}/${idx}.jpeg`
          : `${filename}/${idx}.jpeg`;

        const pageData = pageLinkList[idx]?.Page || {};
        const size = pageData.Size || { Width: FALLBACK_WIDTH, Height: FALLBACK_HEIGHT };
        const rect = pageData.Rect || pageData.ContentArea || {};

        pages.push({
          pageNo: pages.length + 1,
          url: `${cdnBaseUrl}${fileSubPath}?${authQuery}`,
          pattern: Tools.computePattern(`${filename}/${idx}`),
          width: Number(size.Width || size.width || FALLBACK_WIDTH),
          height: Number(size.Height || size.height || FALLBACK_HEIGHT),
          rectX: Number(rect.X ?? rect.x ?? 0),
          rectY: Number(rect.Y ?? rect.y ?? 0)
        });
      }
    }

    return {
      title: authData.cti || rawAuth.cti || "DMM Books",
      cid: cid,
      pages: pages
    };
  }

  /* =========================================================================
   * 3.B NHÁNH BOOKWALKER
   * ========================================================================= */
  async function getBookWalkerDynamicChallenge() {
    const isTrial = WIN.location.hostname.includes("viewer-trial.bookwalker.jp") || WIN.location.href.includes("viewer-trial");
    if (isTrial) return null;

    let reqUrl = '/browserWebApi/03/getLoader';
    const scripts = Array.from(DOC.head.querySelectorAll('script[src*="/browserWebApi/"]'));
    if (scripts.length > 0) reqUrl = scripts[0].getAttribute('src');

    const res = await WIN.fetch(reqUrl);
    const text = await res.text();

    const match = text.match(/(\w+)\s*=\s*function\(\)\s*\{([^{}]*toFixed[^{}]*)\}/);
    if (!match) throw new Error("Không giải mã được hàm getLoader.");

    const fn = new Function(match[2]);
    return fn();
  }

  async function fetchBookWalkerManifest(cid) {
    const Tools = window.PublusTools || globalThis.PublusTools;
    const isTrial = WIN.location.hostname.includes("viewer-trial.bookwalker.jp") || WIN.location.href.includes("viewer-trial");
    const challengeNum = await getBookWalkerDynamicChallenge();

    let bid = localStorage.getItem('NFBR.Global/BrowserId');
    if (!bid) {
      bid = Date.now() + ("00000000" + Math.floor(Math.random() * 100000000)).slice(-8) + 'NFBR';
      localStorage.setItem('NFBR.Global/BrowserId', bid);
    }

    const params = new URLSearchParams({ cid: cid, BID: bid });
    if (challengeNum) params.set('cr', challengeNum);

    const cookieMatch = DOC.cookie.match(/(?:^| )u1=([^;]+)/);
    if (cookieMatch) params.set('u1', cookieMatch[1]);
    const u2Match = DOC.cookie.match(/(?:^| )u2=([^;]+)/);
    if (u2Match) params.set('u2', u2Match[1]);

    const authApi = isTrial ? '/trial-page/c' : '/browserWebApi/c';
    const authRes = await WIN.fetch(`${authApi}?${params.toString()}`);
    const authData = await authRes.json();

    if (!authData.url || !authData.auth_info) {
      throw new Error(`Xác thực BookWalker thất bại (${authData.status || '401/Expired'})`);
    }

    const cdnBase = authData.url.replace(/\/?$/, '/');

    let authQuery = "";
    if (typeof authData.auth_info === 'string') {
      authQuery = authData.auth_info.replace(/^\?/, '');
    } else if (authData.auth_info && typeof authData.auth_info === 'object') {
      const info = authData.auth_info;
      const parts = [];
      for (const k of Object.keys(info)) {
        if (info[k] !== undefined && info[k] !== null) {
          parts.push(`${k}=${info[k]}`);
        }
      }
      authQuery = parts.join('&');
    }

    const configRes = await WIN.fetch(`${cdnBase}configuration_pack.json?${authQuery}`);
    const configJson = await configRes.json();

    let config, fileNameVersion, key1 = null, key2 = null, key3 = null;
    if (configJson.data && typeof configJson.data === 'string') {
      const decryptedPack = Tools.decryptConfigurationPack(configJson.data);
      config = decryptedPack.config;
      fileNameVersion = config.configuration?.['file-name-version'];
      key1 = decryptedPack.key1;
      key2 = decryptedPack.key2;
      key3 = decryptedPack.key3;
    } else {
      config = configJson;
      fileNameVersion = config.configuration?.['file-name-version'];
    }

    const rawContents = config.configuration?.contents || [];
    const pages = [];
    let pageIndex = 0;

    for (let i = 0; i < rawContents.length; i++) {
      const item = rawContents[i];
      const fileInfo = config[item.file];
      if (!fileInfo || fileInfo.Linear === 0) continue;

      const pageList = fileInfo.FileLinkInfo?.PageLinkInfoList || [];
      const pageCount = fileInfo.FileLinkInfo?.PageCount || pageList.length;

      for (let pIdx = 0; pIdx < pageCount; pIdx++) {
        const pageObj = pageList[pIdx]?.Page;
        if (!pageObj) continue;

        pageObj.imgName = item.file;
        if (key1 && key2 && key3) {
          Tools.calcU2F(pageObj, key1, key2, key3);
        }

        const pNo = (pageObj.No !== undefined && pageObj.No !== null) ? String(pageObj.No) : "0";
        const imgHash = (key1 && key2 && key3)
          ? Tools.getImgURLHash(pNo, item.file, key1, key2, key3, fileNameVersion)
          : pNo;

        const isCover = (pageIndex === 0);
        let fileName = `${imgHash}.jpeg`;
        if (!isTrial && isCover) fileName += 'bvCoverImage';

        const subPath = `${item.file}/${fileName}`;
        const dummyW = Number(pageObj.DummyWidth || 0);
        const dummyH = Number(pageObj.DummyHeight || 0);
        const targetW = Number(pageObj.Size?.Width || 1440);
        const targetH = Number(pageObj.Size?.Height || 2048);

        pages.push({
          pageNo: pageIndex + 1,
          url: `${cdnBase}${subPath}?${authQuery}`,
          width: targetW,
          height: targetH,
          rawW: targetW + dummyW,
          rawH: targetH + dummyH,
          pageInfo: pageObj,
          isCover: isCover,
          isScrambled: Boolean(pageObj.BlockWidth)
        });

        pageIndex++;
      }
    }

    return {
      title: authData.cti || config.configuration?.title || "",
      cid: cid,
      pages: pages
    };
  }

  /* =========================================================================
   * 3.C NHÁNH PIXIV COMIC STORE
   * ========================================================================= */
  async function fetchPixivStoreManifest(cid) {
    const Tools = window.PublusTools || globalThis.PublusTools;
    let configUrl = "";
    for (let i = 0; i < 30; i++) {
      const entry = WIN.performance?.getEntriesByType?.('resource')?.find(r => r.name.includes('configuration_pack.json'));
      if (entry && entry.name) {
        configUrl = entry.name;
        break;
      }
      await sleep(100);
    }

    if (!configUrl) {
      throw new Error("Chưa bắt được gói tin cấu hình Pixiv Comic Store.");
    }

    const cdnBase = configUrl.substring(0, configUrl.indexOf('configuration_pack.json'));
    const authQuery = configUrl.includes('?') ? configUrl.substring(configUrl.indexOf('?') + 1) : "";

    const configRes = await WIN.fetch(configUrl);
    const configJson = await configRes.json();

    let config, key1 = null, key2 = null, key3 = null;
    if (configJson.data && typeof configJson.data === 'string') {
      const decryptedPack = Tools.decryptConfigurationPack(configJson.data);
      config = decryptedPack.config;
      key1 = decryptedPack.key1;
      key2 = decryptedPack.key2;
      key3 = decryptedPack.key3;
    } else {
      config = configJson;
    }

    const rawContents = config.configuration?.contents || [];
    const pages = [];
    let pageIndex = 0;

    for (let i = 0; i < rawContents.length; i++) {
      const item = rawContents[i];
      const fileInfo = config[item.file];
      if (!fileInfo || fileInfo.Linear === 0) continue;

      const pageList = fileInfo.FileLinkInfo?.PageLinkInfoList || [];
      const pageCount = fileInfo.FileLinkInfo?.PageCount || pageList.length;

      for (let pIdx = 0; pIdx < pageCount; pIdx++) {
        const pageObj = pageList[pIdx]?.Page;
        if (!pageObj) continue;

        pageObj.imgName = item.file;
        if (key1 && key2 && key3) {
          Tools.calcU2F(pageObj, key1, key2, key3);
        }

        const pNo = (pageObj.No !== undefined && pageObj.No !== null) ? String(pageObj.No) : "0";
        const subPath = `${item.file}/${pNo}.jpeg`;

        const dummyW = Number(pageObj.DummyWidth || 0);
        const dummyH = Number(pageObj.DummyHeight || 0);
        const targetW = Number(pageObj.Size?.Width || 1440);
        const targetH = Number(pageObj.Size?.Height || 2048);

        pages.push({
          pageNo: pageIndex + 1,
          url: `${cdnBase}${subPath}?${authQuery}`,
          width: targetW,
          height: targetH,
          rawW: targetW + dummyW,
          rawH: targetH + dummyH,
          pageInfo: pageObj,
          isCover: (pageIndex === 0),
          isScrambled: Boolean(pageObj.BlockWidth)
        });

        pageIndex++;
      }
    }

    let realTitle = "";
    const domTitleEl = DOC.querySelector('#pagetitle .titleText, #pagetitle');
    if (domTitleEl) realTitle = domTitleEl.getAttribute('title') || domTitleEl.textContent.trim();
    if (!realTitle) {
      const firstFile = rawContents[0]?.file;
      realTitle = config[firstFile]?.Title || config.configuration?.title || "";
    }

    return {
      title: realTitle,
      cid: cid,
      pages: pages
    };
  }

  /* =========================================================================
   * 4. PRE-NAVIGATION HOOK & IFRAME (FALLBACK CHO BOOKWALKER VÀ PIXIV COMIC STORE)
   * ========================================================================= */
  function getNFBRRuntime(targetWin = WIN) {
    try {
      let wins = [targetWin];
      if (targetWin.document) {
        const iframes = targetWin.document.querySelectorAll('iframe');
        for (const f of iframes) {
          try { if (f.contentWindow) wins.push(f.contentWindow); } catch(e){}
        }
      }

      for (const w of wins) {
        const a6G = w.NFBR?.a6G;
        if (!a6G) continue;

        const containers = [a6G.Initializer, a6G.Initial, a6G];
        for (const container of containers) {
          if (!container || typeof container !== 'object') continue;
          
          for (const key of Object.keys(container)) {
            const obj = container[key];
            if (!obj || typeof obj !== 'object') continue;

            const menu = obj.menu?.a6l || obj.a6l || obj.menu || (typeof obj.moveToPage === 'function' ? obj : null);
            const renderer = obj.renderer || menu?.renderer || obj.viewer_;
            
            const modelCandidates = [
              renderer?.model,
              obj.viewer_?.model,
              obj.model,
              menu?.model,
              menu?.renderer?.model
            ];

            let model = null;
            for (const m of modelCandidates) {
              if (!m) continue;
              const attr = m.attributes || m;
              if (attr.content || attr.configuration || attr.contents || attr.files || attr.total) {
                model = m;
                break;
              }
            }
            if (!model) model = renderer?.model || menu?.model || obj.model;

            if (menu || renderer || model) {
              return { win: w, init: obj, menu, renderer, model };
            }
          }
        }
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  function getModelProperty(obj, key) {
    try {
      if (typeof obj?.get === "function") return obj.get(key);
    } catch (e) {}
    return obj?.attributes?.[key];
  }

  function parsePositiveInt(val, fallback = 0) {
    const n = Number(val);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  }

  function getTotalPages(rt) {
    const model = rt?.model;
    const attr = model?.attributes || model || {};
    const a2u = attr.a2u || {};
    const isTrial = WIN.location.hostname.includes("viewer-trial.bookwalker.jp") || WIN.location.href.includes("viewer-trial");

    // Nếu là bản Trial: Ưu tiên số lượng trang nội dung thật từ configuration contents
    if (isTrial && attr.content?.configuration?.contents?.length) {
      return attr.content.configuration.contents.length;
    }

    const total = Number(
      getModelProperty(model, "total") ||
      attr.total ||
      a2u.X9U ||
      attr.content?.configuration?.contents?.length ||
      attr.content?.files?.length ||
      (Array.isArray(a2u.L3Y) ? a2u.L3Y.length * 2 : 0) ||
      (Array.isArray(attr.viewerWideScreenSpreads) ? attr.viewerWideScreenSpreads.length * 2 : 0) ||
      0
    );
    return Math.max(0, Math.floor(total));
  }

  function getPageDimensionFromLinkInfo(fileData) {
    const page = fileData?.PageLinkInfo?.[0]?.Page;
    const sizeObj = page?.Size || page?.size || page?.PageSize;
    return {
      width: parsePositiveInt(sizeObj?.width, 0),
      height: parsePositiveInt(sizeObj?.height, 0)
    };
  }

  function getTargetPageDimensions(pageObj, defaultDim = { width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT }) {
    return {
      width: parsePositiveInt(pageObj?.width, defaultDim.width),
      height: parsePositiveInt(pageObj?.height, defaultDim.height)
    };
  }

  function addPageToMap(pageMap, pageData, index, fileData) {
    if (!pageData && !Number.isFinite(index)) return;
    const pageIdx = Number.isFinite(Number(pageData?.index)) ? Number(pageData.index) : Number(index);
    if (!Number.isFinite(pageIdx) || pageIdx < 0) return;

    const linkDim = getPageDimensionFromLinkInfo(fileData);
    const w = parsePositiveInt(pageData?.width, linkDim.width || FALLBACK_WIDTH);
    const h = parsePositiveInt(pageData?.height, linkDim.height || FALLBACK_HEIGHT);

    const existing = pageMap.get(pageIdx) || {};
    pageMap.set(pageIdx, {
      ...existing,
      index: pageIdx,
      width: parsePositiveInt(existing.width, w),
      height: parsePositiveInt(existing.height, h),
      file: pageData?.file || existing.file || ""
    });
  }

  function getPageListFromNFBR(rt) {
    const model = rt.model;
    const attr = model?.attributes || model || {};
    const a2u = getModelProperty(model, "a2u") || attr.a2u || {};
    const content = getModelProperty(model, "content") || attr.content || attr.configuration || {};
    const configContents = content.configuration?.contents || content.contents || attr.contents || [];
    const files = content.files || attr.files || [];

    const pageMap = new Map();
    const spreadsList = a2u.r8q || a2u.L3Y || a2u.l3Y || attr.viewerWideScreenSpreads || attr.viewerWideScreenImageModels || [];

    if (Array.isArray(spreadsList)) {
      for (const spread of spreadsList) {
        if (spread.left) addPageToMap(pageMap, spread.left, spread.left?.index, files[spread.left?.index]);
        if (spread.right) addPageToMap(pageMap, spread.right, spread.right?.index, files[spread.right?.index]);
        if (Number.isFinite(spread.pageIndex)) {
          addPageToMap(pageMap, { index: spread.pageIndex, width: spread.width, height: spread.height }, spread.pageIndex, files[spread.pageIndex]);
        }
      }
    }

    if (Array.isArray(configContents)) {
      configContents.forEach((cItem, idx) => {
        addPageToMap(pageMap, { index: idx, file: cItem?.file || cItem?.src }, idx, files[idx]);
      });
    }

    const totalPages = getTotalPages(rt) || pageMap.size || configContents.length || files.length;
    for (let i = 0; i < totalPages; i++) {
      // Chỉ bổ sung nếu index đó thực sự có file tương ứng, tránh nhồi trang ma vượt quá số trang thật
      if (!pageMap.has(i) && (files[i] || configContents[i])) {
        addPageToMap(pageMap, { index: i }, i, files[i]);
      }
    }

    const list = Array.from(pageMap.values())
      .filter(p => Number.isFinite(p.index) && p.index >= 0)
      .sort((a, b) => a.index - b.index)
      .map(p => ({
        ...p,
        width: parsePositiveInt(p.width, FALLBACK_WIDTH),
        height: parsePositiveInt(p.height, FALLBACK_HEIGHT)
      }));

    if (!list.length) throw new Error("Không tìm thấy danh mục trang PUBLUS.");
    return list;
  }

  function getCurrentPageIndex(rt) {
    const p = Number(getModelProperty(rt?.model, "viewerPage"));
    if (Number.isFinite(p) && p >= 0) return Math.floor(p);

    const spread = getModelProperty(rt?.model, "viewerSpread");
    const idx = Number(spread?.pageIndex ?? spread?.left?.index ?? spread?.right?.index);
    return Number.isFinite(idx) && idx >= 0 ? Math.floor(idx) : 0;
  }

  function getPageSide(spread, pageIndex) {
    if (!spread) return null;
    if (Number(spread.left?.index) === Number(pageIndex)) return "left";
    if (Number(spread.right?.index) === Number(pageIndex)) return "right";
    if (Number(spread.pageIndex) === Number(pageIndex) && spread.left) return "left";
    return null;
  }

  function ensureIframeBridge(win) {
    if (win.__bw_bridge) return;
    try {
      win.eval(`
        (function() {
          var capturedMasters = new Map();
          var currentPIdx = 0;
          var currentPageMeta = null;

          try {
            var nativeImg = window.Image;
            window.Image = class extends nativeImg {
              constructor(w, h) {
                super(w, h);
                this.crossOrigin = 'anonymous';
              }
            };
          } catch(e) {}

          function installNFBRHook() {
            var proto = window.NFBR?.a6G?.a5x?.prototype;
            if (!proto || proto.__bw_hooked) return;
            proto.__bw_hooked = true;

            for (var key in proto) {
              if (key === 'initialize' || key === 'constructor' || typeof proto[key] !== 'function') continue;

              (function(methodName) {
                var orig = proto[methodName];
                var fnLen = orig.length;

                proto[methodName] = function() {
                  var args = Array.prototype.slice.call(arguments);

                  try {
                    // ===============================================================
                    // 1. HÀM 15 THAM SỐ (X3V / x1e): Bắt Master Canvas sạch 100% từ Web Worker
                    // ===============================================================
                    if (fnLen === 15) {
                      var res = orig.apply(this, arguments);
                      var dummyCanvas = args[1];
                      var masterW = args[3] || 1440;
                      var masterH = args[4] || 2048;

                      if (dummyCanvas && (dummyCanvas instanceof HTMLCanvasElement || dummyCanvas.tagName === 'CANVAS') && dummyCanvas.width >= 500) {
                        var pIdx = currentPIdx;
                        var page = currentPageMeta || {};
                        var targetW = (page && typeof page.width === 'number' && page.width > 0) ? page.width : (args[3] || dummyCanvas.width);
                        var targetH = (page && typeof page.height === 'number' && page.height > 0) ? page.height : (args[4] || dummyCanvas.height);

                        var existing = capturedMasters.get(pIdx) || {};
                        var flag = existing.flag ?? (pIdx === 0 ? 2 : 0);
                        var diffW = dummyCanvas.width > targetW ? (dummyCanvas.width - targetW) : 0;
                        var cropX = (flag === 2 || pIdx === 0) ? Math.ceil(diffW / 2) : (flag === 1 ? diffW : 0);

                        // Clone Master Canvas sạch 100% (chưa hề qua e1p bóp méo hay F0Y chèn Barcode)
                        var sharpC = document.createElement('canvas');
                        sharpC.width = targetW;
                        sharpC.height = targetH;
                        var sCtx = sharpC.getContext('2d', { alpha: false });
                        sCtx.imageSmoothingEnabled = false;
                        sCtx.mozImageSmoothingEnabled = false;
                        sCtx.webkitImageSmoothingEnabled = false;
                        sCtx.msImageSmoothingEnabled = false;
                        sCtx.drawImage(dummyCanvas, cropX, 0, targetW, targetH, 0, 0, targetW, targetH);

                        capturedMasters.set(pIdx, {
                          ...existing,
                          pIdx: pIdx,
                          sharpCanvas: sharpC,
                          width: targetW,
                          height: targetH,
                          flag: flag,
                          isScrambled: true
                        });
                      }
                      return res;
                    }

                    // ===============================================================
                    // 2. HÀM 5 THAM SỐ (e1p / i3n): Theo dõi trang, cờ flag và bắt ảnh thô
                    // Tuyệt đối KHÔNG gọi orig.call để tránh bị dính Watermark/Barcode 2px
                    // ===============================================================
                    if (fnLen === 5) {
                      var page = args[1];
                      var imgSource = args[2];
                      var flag = args[4];

                      if (page && typeof page.index === 'number') {
                        currentPIdx = page.index;
                        currentPageMeta = page;

                        var existing = capturedMasters.get(page.index) || {};
                        if (flag !== undefined) existing.flag = flag;

                        var isRealDrawable = imgSource && (
                          imgSource instanceof HTMLImageElement ||
                          imgSource instanceof HTMLCanvasElement ||
                          (typeof ImageBitmap !== 'undefined' && imgSource instanceof ImageBitmap) ||
                          imgSource.tagName === 'IMG' ||
                          imgSource.tagName === 'CANVAS'
                        );

                        if (isRealDrawable) {
                          var srcW = imgSource.naturalWidth || imgSource.width || 0;
                          var srcH = imgSource.naturalHeight || imgSource.height || 0;

                          if (srcW >= 500 && srcH >= 500) {
                            var rawC = document.createElement('canvas');
                            rawC.width = srcW;
                            rawC.height = srcH;
                            var rCtx = rawC.getContext('2d', { alpha: false });
                            rCtx.imageSmoothingEnabled = false;
                            rCtx.mozImageSmoothingEnabled = false;
                            rCtx.webkitImageSmoothingEnabled = false;
                            rCtx.msImageSmoothingEnabled = false;
                            rCtx.drawImage(imgSource, 0, 0);

                            existing.rawCanvas = rawC;
                            existing.rawW = srcW;
                            existing.rawH = srcH;

                            // Đối với trang bìa / trang không xáo trộn (không đi qua hàm 15 tham số)
                            // Lưu trực tiếp rawC làm Master sạch 1:1, không qua xử lý bóp méo
                            if (!existing.sharpCanvas) {
                              existing.sharpCanvas = rawC;
                              existing.width = srcW;
                              existing.height = srcH;
                              existing.isScrambled = false;
                            }
                          }
                        }

                        capturedMasters.set(page.index, {
                          ...existing,
                          pIdx: page.index
                        });
                      }
                    }
                  } catch(e) {}

                  return orig.apply(this, arguments);
                };
              })(key);
            }
          }

          installNFBRHook();
          var timer = setInterval(function() {
            if (window.NFBR?.a6G?.a5x?.prototype) {
              installNFBRHook();
              if (window.NFBR?.a6G?.a5x?.prototype.__bw_hooked) clearInterval(timer);
            }
          }, 30);

          window.__bw_bridge = {
            capturedMasters: capturedMasters,
            capture: function(pIdx, mimeType, quality) {
              return new Promise(function(resolve, reject) {
                try {
                  var item = capturedMasters.get(Number(pIdx));
                  var canvas = item?.sharpCanvas;
                  var rawCanvas = item?.rawCanvas;

                  if (!canvas) {
                    var init = window.NFBR?.a6G?.Initializer?.T1V || window.NFBR?.a6G?.Initializer?.F7F || window.NFBR?.a6G?.Initial?.T1V;
                    var menu = init?.menu?.a6l || init?.a6l || init?.menu;
                    var renderer = init?.renderer || menu?.renderer;
                    var screen = renderer?.currentScreen;
                    canvas = screen?.canvas;
                  }

                  if (!canvas || !canvas.width || !canvas.height) {
                    return reject(new Error("Canvas chưa sẵn sàng để xuất ảnh."));
                  }

                  function exportBlob(c, mType, qVal) {
                    return new Promise(function(res, rej) {
                      if (typeof c.toBlob === 'function') {
                        c.toBlob(function(blob) {
                          if (!blob) return rej(new Error("toBlob null"));
                          var reader = new FileReader();
                          reader.onload = function() { res(new Uint8Array(reader.result)); };
                          reader.onerror = rej;
                          reader.readAsArrayBuffer(blob);
                        }, mType, qVal);
                      } else {
                        var dataUrl = c.toDataURL(mType, qVal);
                        var base64 = dataUrl.split(',')[1];
                        var bin = atob(base64);
                        var ab = new ArrayBuffer(bin.length);
                        var ua = new Uint8Array(ab);
                        for (var i = 0; i < bin.length; i++) ua[i] = bin.charCodeAt(i);
                        res(ua);
                      }
                    });
                  }

                  exportBlob(canvas, mimeType, quality).then(function(cleanBytes) {
                    if (item && item.isScrambled === false && rawCanvas) {
                      // Trang không xáo trộn: Xuất cả bản raw JPG gốc
                      exportBlob(rawCanvas, 'image/jpeg', 0.98).then(function(rawBytes) {
                        resolve({
                          cleanData: cleanBytes,
                          rawData: rawBytes,
                          isScrambled: false
                        });
                      }).catch(function() {
                        resolve({ cleanData: cleanBytes, rawData: null, isScrambled: false });
                      });
                    } else {
                      resolve({ cleanData: cleanBytes, rawData: null, isScrambled: true });
                    }
                  }).catch(reject);

                } catch (err) {
                  reject(err);
                }
              });
            }
          };
        })();
      `);
    } catch (e) {
      console.error("[publus-dl] Lỗi khởi tạo Main-World Bridge:", e);
    }
  }

  function updateIframeSize(iframeEl, pageDim) {
    const targetW = parsePositiveInt(pageDim?.width, FALLBACK_WIDTH);
    const targetH = parsePositiveInt(pageDim?.height, FALLBACK_HEIGHT);
    iframeEl.width = String(targetW);
    iframeEl.height = String(targetH);
    iframeEl.style.width = targetW + "px";
    iframeEl.style.height = targetH + "px";
  }

  async function resizeIframeAndTrigger(iframeEl, pageObj) {
    updateIframeSize(iframeEl, getTargetPageDimensions(pageObj));
    try {
      const win = iframeEl.contentWindow;
      win.dispatchEvent(new win.CustomEvent("resize"));
    } catch (e) {}
    await sleep(60);
  }

  function createWorkerIframe(initialPage) {
    DOC.getElementById("publus-worker-iframe")?.remove();

    const url = new URL(WIN.location.href);
    url.hash = "tm-publus-downloader-silent";

    const iframe = DOC.createElement("iframe");
    iframe.id = "publus-worker-iframe";
    iframe.src = url.href;
    iframe.setAttribute("aria-hidden", "true");
    iframe.tabIndex = -1;
    iframe.style.position = "fixed";
    iframe.style.left = "0px";
    iframe.style.top = "0px";
    iframe.style.opacity = "0.01";
    iframe.style.pointerEvents = "none";
    iframe.style.zIndex = "2147483646";

    updateIframeSize(iframe, getTargetPageDimensions(initialPage));

    iframe.addEventListener('load', () => {
      try {
        ensureIframeBridge(iframe.contentWindow);
      } catch (e) {}
    });

    (DOC.body || DOC.documentElement).appendChild(iframe);
    return iframe;
  }

  async function waitForRender(iframeEl, pageIndex, timeoutMs = FRAME_TIMEOUT) {
    const startTime = Date.now();
    let retryCount = 0;

    while (Date.now() - startTime < timeoutMs) {
      const win = iframeEl.contentWindow;
      const rt = getNFBRRuntime(win);
      if (!rt) {
        await sleep(100);
        continue;
      }

      ensureIframeBridge(win);

      if (win.__bw_bridge?.capturedMasters?.has(Number(pageIndex))) {
        await sleep(40);
        return { runtime: rt, fromHook: true };
      }

      const screen = rt.renderer?.currentScreen;
      const spread = getModelProperty(rt.model, "viewerSpread");
      const side = getPageSide(spread, pageIndex);
      const drawn = side === "right" ? screen?.rightIsDrawn : screen?.leftIsDrawn;
      const canvas = screen?.canvas;

      if (side && drawn === true && canvas && canvas.width > 0 && canvas.height > 0) {
        await new Promise(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));
        await sleep(80);
        return { runtime: rt, screen, side };
      }

      if (Date.now() - startTime > 1500 * (retryCount + 1)) {
        retryCount++;
        try {
          const menu = rt.menu;
          if (typeof menu?.moveToPage === "function") {
            menu.moveToPage(Number(pageIndex));
          } else if (typeof menu?.a6l?.moveToPage === "function") {
            menu.a6l.moveToPage(Number(pageIndex));
          }
        } catch (e) {}
      }

      await sleep(80);
    }

    throw new Error(`Render trang ${pageIndex + 1} timeout.`);
  }

  async function navigateToPage(iframeEl, pageIndex) {
    const startTime = Date.now();
    let rt = null;

    while (Date.now() - startTime < FRAME_TIMEOUT) {
      const win = iframeEl.contentWindow;
      rt = getNFBRRuntime(win);
      if (rt) {
        ensureIframeBridge(win);
        break;
      }
      await sleep(100);
    }

    if (!rt) throw new Error("Không tìm thấy hàm điều khiển trang PUBLUS.");

    const menu = rt.menu;
    const model = rt.model;
    try {
      if (typeof menu?.moveToPage === "function") {
        menu.moveToPage(Number(pageIndex));
      } else if (typeof menu?.a6l?.moveToPage === "function") {
        menu.a6l.moveToPage(Number(pageIndex));
      } else if (typeof model?.set === "function") {
        model.set("viewerPage", Number(pageIndex));
      }
    } catch (e) {}

    return await waitForRender(iframeEl, Number(pageIndex));
  }

  async function renderCanvasToBlob(iframeEl, pageObj, renderResult, isJpg) {
    const win = iframeEl.contentWindow;
    ensureIframeBridge(win);

    const mimeType = isJpg ? 'image/jpeg' : 'image/png';
    const quality = isJpg ? CONFIG.JPEG_QUALITY : undefined;

    if (win.__bw_bridge?.capture) {
      const res = await win.__bw_bridge.capture(pageObj.index, mimeType, quality);
      return {
        cleanData: res.cleanData,
        rawData: res.rawData,
        isScrambled: res.isScrambled,
        ext: isJpg ? 'jpg' : 'png'
      };
    } else {
      throw new Error("Không thể kết nối tới Bridge trích xuất ảnh sạch.");
    }
  }

  /* =========================================================================
   * 5. RENDER CANVAS
   * ========================================================================= */
  async function renderPublusCanvas(img, coords, targetW, targetH, cropX = 0, cropY = 0, isJpg = false, pageNo = 1) {
    const canvas = DOC.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = false;
    ctx.mozImageSmoothingEnabled = false;
    ctx.webkitImageSmoothingEnabled = false;
    ctx.msImageSmoothingEnabled = false;

    if (!coords || coords.length === 0) {
      ctx.drawImage(img, cropX, cropY, targetW, targetH, 0, 0, targetW, targetH);
    } else {
      for (let i = 0; i < coords.length; i++) {
        const b = coords[i];
        ctx.drawImage(
          img,
          b.destX, b.destY, b.width, b.height,
          b.srcX - cropX, b.srcY - cropY, b.width, b.height
        );
      }
    }

    const mimeType = isJpg ? 'image/jpeg' : 'image/png';
    const outExt = isJpg ? 'jpg' : 'png';
    const blob = await new Promise(r => canvas.toBlob(r, mimeType, CONFIG.JPEG_QUALITY));

    canvas.width = 0;
    canvas.height = 0;

    return {
      fileName: `${pageNo}.${outExt}`,
      data: new Uint8Array(await blob.arrayBuffer())
    };
  }

  /* =========================================================================
   * 6. TIẾN TRÌNH TẢI CHÍNH
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      const isBwTrial = WIN.location.hostname.includes("viewer-trial.bookwalker.jp") || WIN.location.href.includes("viewer-trial");
      const useJpeg = isBwTrial ? true : Boolean(state.convertJpeg);

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const tools = window.PublusTools || globalThis.PublusTools;
      const zip = new ZipClass();

      // ==========================================
      // NHÁNH A: DMM BOOKS (6 LUỒNG SONG SONG)
      // ==========================================
      if (isDmm()) {
        let dmmData = state.dmmData;
        if (!dmmData) {
          dmmData = await fetchDmmManifest();
          state.dmmData = dmmData;
        }

        const pages = dmmData.pages;
        const totalPages = pages.length;
        if (!totalPages) throw new Error("Không tìm thấy trang truyện DMM.");

        zip.addFile(`${dmmData.cid}.txt`, new Uint8Array(0));
        if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

        const tasks = pages.map(pageObj => async () => {
          await sleep(40);
          const rawBuffer = await Utils.fetchBuffer(pageObj.url);
          const img = await Utils.loadImage(rawBuffer, 'image/jpeg');
          const coords = tools.PublusCoordsGenerator(img.width, img.height, 64, 64, pageObj.pattern);
          const cropX = Number(pageObj.rectX ?? 0);
          const cropY = Number(pageObj.rectY ?? 0);
          return await renderPublusCanvas(img, coords, pageObj.width, pageObj.height, cropX, cropY, useJpeg, pageObj.pageNo);
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
        return;
      }

      // =======================================================================
      // NHÁNH B: BOOKWALKER & PIXIV (6 LUỒNG SONG SONG)
      // =======================================================================
      let bwData = state.bwData;
      if (!bwData) {
        if (isBookWalker()) bwData = await fetchBookWalkerManifest(getEpisodeId());
        else if (isPixivStore()) bwData = await fetchPixivStoreManifest(getEpisodeId());
        state.bwData = bwData;
      }

      if (bwData?.pages?.length > 0) {
        const pages = bwData.pages;
        const totalPages = pages.length;

        zip.addFile(`${bwData.cid}.txt`, new Uint8Array(0));
        if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

        let currentAuthQuery = null;

        const tasks = pages.map(pageObj => async () => {
          let retryCount = 0;
          while (retryCount < 3) {
            try {
              let fetchUrl = pageObj.url;
              if (currentAuthQuery) {
                fetchUrl = pageObj.url.split('?')[0] + '?' + currentAuthQuery;
              }

              const res = await WIN.fetch(fetchUrl, {
                method: "GET",
                mode: "cors",
                credentials: "omit",
                referrer: ""
              });

              // Tự động gia hạn token nếu bị 403 giữa chừng
              if (res.status === 403) {
                const freshData = isBookWalker() ? await fetchBookWalkerManifest(getEpisodeId()) : await fetchPixivStoreManifest(getEpisodeId());
                if (freshData?.pages?.[0]?.url) {
                  currentAuthQuery = freshData.pages[0].url.split('?')[1];
                  retryCount++;
                  await sleep(300);
                  continue;
                }
              }

              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const rawBuffer = await res.arrayBuffer();

              // Trang không xáo trộn (Bìa / Trial) -> Ghi mảng byte gốc vào ZIP
              if (!pageObj.isScrambled) {
                const uint8 = new Uint8Array(rawBuffer);
                if (isBwTrial || useJpeg) {
                  return { pageNo: pageObj.pageNo, fileName: `${pageObj.pageNo}.jpg`, data: uint8, rawData: uint8, isScrambled: false };
                }
              }

              const img = await Utils.loadImage(rawBuffer, 'image/jpeg');
              const pageInfo = pageObj.pageInfo || {};
              const cropX = Number(pageInfo.ContentArea?.X || pageInfo.Rect?.X || 0);
              const cropY = Number(pageInfo.ContentArea?.Y || pageInfo.Rect?.Y || 0);
              const coords = pageObj.isScrambled ? tools.getBlocks(pageInfo, img.width, img.height) : null;
              const decoded = await renderPublusCanvas(img, coords, pageObj.width, pageObj.height, cropX, cropY, useJpeg, pageObj.pageNo);

              return {
                pageNo: pageObj.pageNo,
                fileName: decoded.fileName,
                data: decoded.data,
                rawData: new Uint8Array(rawBuffer),
                isScrambled: pageObj.isScrambled
              };
            } catch (err) {
              if (retryCount >= 2) throw err;
              retryCount++;
              await sleep(500);
            }
          }
        });

        const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
          if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
        });

        if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
        await sleep(50);

        for (const res of results) {
          if (res?.data) {
            zip.addFile(res.fileName, res.data);
            if (!isBwTrial && res.pageNo === 1 && res.isScrambled === false && res.rawData && !res.fileName.endsWith('.jpg')) {
              zip.addFile(`1.jpg`, res.rawData);
            }
          }
        }

        const zipName = `${getCleanTitle()}.zip`;
        zip.download(zipName);

        if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
        return;
      }

      // ==========================================
      // NHÁNH C: BOOKWALKER & PIXIV STORE (IFRAME)
      // ==========================================
      if (!state.episodeData) return;
      const { rt: mainRt, pagesList } = state.episodeData;
      const totalPages = pagesList.length;

      if (!totalPages) throw new Error("Không tìm thấy trang truyện.");

      const initialPageIndex = getCurrentPageIndex(mainRt);
      const episodeId = getEpisodeId();
      zip.addFile(`${episodeId}.txt`, new Uint8Array(0));

      const workerIframe = createWorkerIframe(pagesList[0]);
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      try {
        for (let i = 0; i < totalPages; i++) {
          const pageObj = pagesList[i];
          await resizeIframeAndTrigger(workerIframe, pageObj);
          const renderResult = await navigateToPage(workerIframe, pageObj.index);
          const capture = await renderCanvasToBlob(workerIframe, pageObj, renderResult, useJpeg);

          // 1. Lưu bản Master sạch (PNG hoặc JPG theo tùy chọn)
          zip.addFile(`${i + 1}.${capture.ext}`, capture.cleanData);

          // 2. NẾU LÀ TRANG KHÔNG XÁO TRỘN TRONG BỘ TRUYỆN MÃ HÓA (ví dụ ảnh bìa bản Mua)
          // -> Tự động lưu kèm file JPG gốc từ CDN (1.jpg song song với 1.png)
          if (capture.isScrambled === false && capture.rawData && capture.ext !== 'jpg') {
            zip.addFile(`${i + 1}.jpg`, capture.rawData);
          }

          if (ui) {
            ui.updateProgress({
              completed: i + 1,
              total: totalPages,
              status: "Đang tải..."
            });
          }

          await sleep(50);
        }

        if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
        await sleep(50);

        const zipName = `${getCleanTitle()}.zip`;
        zip.download(zipName);

        if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
      } finally {
        if (workerIframe) {
          try {
            const win = workerIframe.contentWindow;
            const rt = getNFBRRuntime(win);
            if (rt && typeof rt.menu?.moveToPage === "function") {
              rt.menu.moveToPage(initialPageIndex);
            }
          } catch (e) {}
          try { workerIframe.remove(); } catch (e) {}
        }
      }
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[publus-dl] Download failed", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * 7. KHỞI CHẠY VÀ THEO DÕI SPA
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(20);
    const ui = getUI();

    if (!isEpisodeUrl()) {
      if (ui?.panel) ui.panel.style.display = "none";
      return;
    }

    if (ui?.panel) {
      ui.panel.style.display = "block";
      ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
    }

    // ==========================================
    // A. NHÁNH DMM & FANZA BOOKS (CÓ RETRY LOOP)
    // ==========================================
    if (isDmm()) {
      let dmmData = null;
      let retries = 0;

      // Vòng lặp chờ Cookie và Auth API sẵn sàng (tối đa 25 lần x 150ms)
      while (retries < 25) {
        try {
          dmmData = await fetchDmmManifest();
          if (dmmData && dmmData.pages?.length > 0) break;
        } catch (e) {}
        await sleep(150);
        retries++;
      }

      if (dmmData && dmmData.pages?.length > 0) {
        state.dmmData = dmmData;

        // Cập nhật lại top chính xác nếu phát hiện タテヨミ từ tiêu đề vừa lấy
        if (ui?.panel) {
          ui.panel.style.top = getDmmTopOffset(resolveSiteTheme().top);
        }

        // Micro-delay chuẩn 80ms mượt mà
        await sleep(80);

        if (ui) {
          ui.updateProgress({
            completed: 0,
            total: dmmData.pages.length,
            status: "Sẵn sàng."
          });
        }
      } else {
        console.error("[publus-dl] Không thể lấy dữ liệu DMM sau 25 lần thử.");
        if (ui) ui.updateProgress({ status: "Sẵn sàng." });
      }
      return;
    }

    // ==========================================
    // B. NHÁNH BOOKWALKER & PIXIV COMIC STORE
    // ==========================================
    const isBwTrial = WIN.location.hostname.includes("viewer-trial.bookwalker.jp") || WIN.location.href.includes("viewer-trial");
    const cid = getEpisodeId();

    const tools = window.PublusTools || globalThis.PublusTools;

    // Ưu tiên số 1: Tải trực tiếp 9 tầng BookWalker
    if (isBookWalker() && cid && !cid.includes("Publus")) {
      try {
        const bwData = await fetchBookWalkerManifest(cid);
        if (bwData?.pages?.length > 0) {
          state.bwData = bwData;
          if (isBwTrial) {
            state.convertJpeg = true;
            if (ui?.updateFormatUI) ui.updateFormatUI('jpg');
          }
          await sleep(80);
          if (ui) ui.updateProgress({ completed: 0, total: bwData.pages.length, status: "Sẵn sàng." });
          return;
        }
      } catch (e) {}
    }

    if (isPixivStore() && cid) {
      try {
        const pixivData = await fetchPixivStoreManifest(cid);
        if (pixivData?.pages?.length > 0) {
          state.bwData = pixivData;
          await sleep(80);
          if (ui) ui.updateProgress({ completed: 0, total: pixivData.pages.length, status: "Sẵn sàng." });
          return;
        }
      } catch (e) {}
    }

    // 2. Dự phòng an toàn (Iframe fallback)
    let rt = null;
    let pagesList = [];
    let attempts = 0;

    while (attempts < 100) {
      rt = getNFBRRuntime(WIN);
      if (rt) {
        try {
          pagesList = getPageListFromNFBR(rt);
          if (pagesList.length > 0) break;
        } catch (e) {}
      }
      await sleep(150);
      attempts++;
    }

    if (pagesList.length > 0) {
      state.episodeData = { rt, pagesList };
      
      //NHẬN DIỆN BOOKWALKER TRIAL ĐỂ CHUYỂN SANG ZERO-COPY JPG
      const isBwTrial = WIN.location.hostname.includes("viewer-trial.bookwalker.jp") || WIN.location.href.includes("viewer-trial");
      if (isBwTrial && ui?.updateFormatUI) {
        ui.updateFormatUI('jpg');
      }

      await sleep(80);

      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: pagesList.length,
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
      state.episodeData = null;
      state.dmmData = null;
      state.bwData = null;
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