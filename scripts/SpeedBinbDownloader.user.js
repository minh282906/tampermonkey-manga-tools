// ==UserScript==
// @name         SpeedBinb Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      2.2.0
// @icon         https://www.voyager.co.jp/products/pt/images/service_logo_01.jpg
// @description  Tải manga trên các nền tảng SpeedBinb (Booklive, Comic Cmoa, Yanmaga, Gaugau Futabanet, ...).
// @author       anonymous & AI
// @match        https://www.cmoa.jp/bib/speedreader/*
// @match        https://yanmaga.jp/*
// @match        https://gaugau.futabanet.jp/*
// @match        https://booklive.jp/*
// @match        https://*.booklive.jp/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      cmoa.jp
// @connect      *.cmoa.jp
// @connect      *.akamaized.net
// @connect      yanmaga.jp
// @connect      *.yanmaga.jp
// @connect      gaugau.futabanet.jp
// @connect      *.futabanet.jp
// @connect      booklive.jp
// @connect      *.booklive.jp
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/decoders/SpeedBinbTools.js
// ==/UserScript==

(function speedBinbUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH TOÀN CỤC & BIẾN MÔI TRƯỜNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6,   // 6 luồng tải & giải mã song song qua API
    JPEG_QUALITY: 0.95   // Chất lượng xuất JPG nếu tick chọn
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("speedbinb-dl:convert-jpeg") === '1',
    chapterData: null,
    ui: null,
    currentAdapter: null
  };

  /* =========================================================================
   * BỘ HỖ TRỢ XỬ LÝ CHUỖI & TÊN FILE CHUẨN (GOLDEN RULES)
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

  function cleanBaseSeriesTitle(raw) {
    if (!raw) return "";
    let s = raw.split(/[|｜]/)[0].trim();
    s = s.replace(/^(?:無料・試し読みページ|無料・試し読み|無料版|試し読み|公式\s*[-－_]?)\s*/i, '').trim();
    s = s.replace(/【[^】]*】/g, '').trim();
    // Xóa nhãn NXB ở cuối: （...コミック）, (コロナ・コミックス)...
    s = s.replace(/（[^）]*(?:コミック|文庫|レーベル|出版|COMIC|WEB)[^）]*）$/i, '').trim();
    s = s.replace(/\([^)]*(?:コミック|文庫|レーベル|出版|COMIC|WEB)[^)]*\)$/i, '').trim();
    return cleanString(s);
  }

  function resolveCleanFileName(seriesTitle, episodeTitle, fallbackId) {
    let cleanSeries = cleanBaseSeriesTitle(seriesTitle);
    let cleanEpisode = cleanString(episodeTitle);

    // Cắt bỏ phần tên truyện nếu bị dính lặp ở đầu tên chap
    if (cleanSeries && cleanEpisode) {
      let baseWithoutVol = cleanSeries.replace(/\s*[0-9０-９]+\s*巻.*$/i, '').trim();
      if (baseWithoutVol && cleanEpisode.startsWith(baseWithoutVol)) {
        cleanEpisode = cleanString(cleanEpisode.substring(baseWithoutVol.length));
      }
    }

    // 1. Có cả tên truyện và tên chap -> [Tên Truyện] - [Tên Chap]
    if (cleanSeries && cleanEpisode && !cleanSeries.includes(cleanEpisode)) {
      return `${cleanSeries} - ${cleanEpisode}`;
    } else if (cleanSeries && cleanEpisode) {
      return cleanEpisode;
    } else if (cleanSeries) {
      // 2. Tankobon nguyên cuốn (có số 1, số tập,...) -> Giữ nguyên tên sạch 100%
      return cleanSeries;
    }
    return `SpeedBinb_${fallbackId}`;
  }

  /* =========================================================================
   * BỘ ADAPTERS CHO TỪNG NỀN TẢNG (SITE PROVIDERS)
   * ========================================================================= */

  // 1. COMIC CMOA (cmoa.jp)
  const CmoaAdapter = {
    id: "cmoa",
    name: "Comic Cmoa",
    theme: { color: "#ea580c", bg: "#1c1917", text: "#fdba74", top: "43px" },

    isMatch: (url) => url.includes("cmoa.jp") && (
      /\/bib\/speedreader\//.test(url) ||
      Boolean(new URL(url).searchParams.get('cid')) ||
      Boolean(DOC.getElementById('content')?.getAttribute('data-ptbinb-cid'))
    ),

    getCid: () => {
      const params = new URL(WIN.location.href).searchParams;
      const cid = params.get('cid');
      if (cid) return cid.trim();
      const attr = DOC.getElementById('content')?.getAttribute('data-ptbinb-cid');
      if (attr) return attr.trim();
      return "Cmoa_Episode";
    },

    getUParams: () => {
      const params = new URL(WIN.location.href).searchParams;
      return Array.from({ length: 10 }, (_, i) => {
        const val = params.get(`u${i}`);
        return val ? `&u${i}=${encodeURIComponent(val)}` : '';
      }).join('');
    },

    fetchManifest: async function(cid, Tools, Utils) {
      const randomString = Tools.generateRandomString32(cid);
      const uParams = this.getUParams();
      const infoUrl = `https://www.cmoa.jp/bib/sws/bibGetCntntInfo.php?cid=${cid}&dmytime=${Date.now()}&k=${randomString}${uParams}`;

      let manifestData = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const infoBuffer = await Utils.fetchBuffer(infoUrl);
          const infoJson = JSON.parse(new TextDecoder().decode(infoBuffer));
          const data = infoJson.items?.[0];
          if (data?.p && data?.ContentsServer) {
            manifestData = data;
            break;
          }
        } catch (e) {}
        await sleep(200);
      }

      if (!manifestData) throw new Error("Không lấy được phiên đọc từ Cmoa.");

      const config = {
        title: manifestData.Title || "",
        subTitle: manifestData.SubTitle || "",
        contentServer: manifestData.ContentsServer,
        p: manifestData.p,
        ctbl: Tools.getDecryptedTable(cid, randomString, manifestData.ctbl),
        ptbl: Tools.getDecryptedTable(cid, randomString, manifestData.ptbl)
      };

      const contentUrl = `${config.contentServer}/sbcGetCntnt.php?cid=${cid}&p=${config.p}&dmytime=${Date.now()}${uParams}`;
      const contentBuffer = await Utils.fetchBuffer(contentUrl);
      const { ttx } = JSON.parse(new TextDecoder().decode(contentBuffer));

      const seen = new Set();
      const files = [];

      // 1. Quét linh hoạt mọi thẻ <t-img> hoặc <img> bất chấp thứ tự orgwidth đứng trước hay sau src
      for (const match of ttx.matchAll(/<(?:t-img|img)[^>]+src=["']?([^"'\s>]+)["']?[^>]*>/gi)) {
        const tagStr = match[0];
        const filename = match[1];
        const wMatch = tagStr.match(/orgwidth=["']?(\d+)["']?/i) || tagStr.match(/width=["']?(\d+)["']?/i);
        const hMatch = tagStr.match(/orgheight=["']?(\d+)["']?/i) || tagStr.match(/height=["']?(\d+)["']?/i);

        if (filename && !seen.has(filename)) {
          seen.add(filename);
          const w = wMatch ? parseInt(wMatch[1], 10) : 0;
          const h = hMatch ? parseInt(hMatch[1], 10) : 0;

          // 2. Bọc encodeURIComponent(filename) an toàn cho đường link ảnh
          files.push({
            pageNo: files.length + 1,
            filename: filename,
            width: w,
            height: h,
            src: `${config.contentServer}/sbcGetImg.php?cid=${cid}&src=${encodeURIComponent(filename)}&p=${config.p}&q=1`
          });
        }
      }

      return { config, files };
    },

    getTitle: function(config, cid) {
      let series = config.title || "";
      let episode = config.subTitle || "";

      if (episode) {
        const epMatch = episode.match(/((?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万]+\s*(?:話|巻|章|節|部|エピソード|分冊版|単話)?.*)$/i);
        if (epMatch) episode = epMatch[1];
      }

      return resolveCleanFileName(series, episode, cid);
    }
  };

  // 2. YANMAGA WEB (yanmaga.jp)
  const YanmagaAdapter = {
    id: "yanmaga",
    name: "Yanmaga Web",
    theme: { color: "#eab308", bg: "#18181b", text: "#fde047", top: "76px" },

    isMatch: (url) => url.includes("yanmaga.jp") && /\/viewer\/comics\//.test(new URL(url).pathname),

    getCid: () => {
      const contentEl = DOC.getElementById('content') || DOC.querySelector('[data-ptbinb-cid]');
      const cid = contentEl?.getAttribute('data-ptbinb-cid') || contentEl?.dataset?.ptbinbCid || new URLSearchParams(WIN.location.search).get("cid");
      return (cid && cid.trim()) ? cid.trim() : "Yanmaga_Episode";
    },

    fetchManifest: async function(cid, Tools, Utils) {
      const randomString = Tools.generateRandomString32(cid);
      const infoUrl = `https://yanmaga.jp/viewer/bibGetCntntInfo?cid=${cid}&dmytime=${Date.now()}&k=${randomString}&type=comics`;

      // Vòng lặp thử lại tối đa 5 lần nếu server phản hồi chậm
      let infoRes = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const infoBuffer = await Utils.fetchBuffer(infoUrl);
          const json = JSON.parse(new TextDecoder().decode(infoBuffer));
          const data = json.items?.[0];
          if (data?.ContentsServer) {
            infoRes = data;
            break;
          }
        } catch (e) {}
        await sleep(200);
      }

      if (!infoRes?.ContentsServer) throw new Error("Không lấy được ContentsServer từ Yanmaga.");

      const config = {
        title: infoRes.Title || "",
        contentServer: infoRes.ContentsServer,
        ctbl: Tools.getDecryptedTable(cid, randomString, infoRes.ctbl),
        ptbl: Tools.getDecryptedTable(cid, randomString, infoRes.ptbl)
      };

      const ttxBuffer = await Utils.fetchBuffer(`${config.contentServer}/content`);
      const { ttx } = JSON.parse(new TextDecoder().decode(ttxBuffer));

      const seen = new Set();
      const files = [];
      for (const match of ttx.matchAll(/(pages\/[a-zA-Z0-9_]*.jpg)[^A-Z]*orgwidth="(\d*)" orgheight="(\d*)"/gm)) {
        const filename = match[1];
        if (!seen.has(filename)) {
          seen.add(filename);
          files.push({
            pageNo: files.length + 1,
            filename: filename,
            width: parseInt(match[2], 10),
            height: parseInt(match[3], 10),
            src: `${config.contentServer}/img/${filename}?q=1`
          });
        }
      }

      return { config, files };
    },

    getTitle: function(config, cid) {
      let series = "";
      let episode = "";

      // 1. Quét DOM viewer (2 tầng tiêu đề trực quan của Yanmaga)
      const seriesEl = DOC.querySelector('.mod-viewer-header__title, .viewer-header__title, [class*="viewer-header"] [class*="title"]:not([class*="sub"])');
      const epEl = DOC.querySelector('.mod-viewer-header__sub-title, .viewer-header__sub-title, [class*="viewer-header"] [class*="sub-title"], [class*="viewer-header"] [class*="subtitle"]');

      if (seriesEl) series = seriesEl.textContent;
      if (epEl) episode = epEl.textContent;

      // 2. Dự phòng phân tích từ document.title hoặc Manifest
      if (!series || !episode) {
        let raw = DOC.title || config.title || "";
        raw = raw.split(/[|｜]/)[0].trim();
        raw = raw.replace(/【[^】]*】/g, '').trim();

        const match = raw.match(/^(.*?)(?:\s+[-－–—]\s+|\s+)((?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\s\-\–\—\ー\~〜\.]+(?:話|巻|章|節|部|エピソード|分冊版|単話|前編|中編|後編)?.*)$/i);
        if (match) {
          if (!series) series = match[1];
          if (!episode) episode = match[2];
        } else {
          if (!series) series = raw;
          if (!episode) episode = cid;
        }
      }

      return resolveCleanFileName(series, episode, cid);
    }
  };

  // 3. GAUGAU FUTABANET (gaugau.futabanet.jp)
  const GaugauAdapter = {
    id: "gaugau",
    name: "Gaugau Futabanet",
    theme: { color: "#06b6d4", bg: "#083344", text: "#67e8f9", top: "100px" },

    isMatch: (url) => url.includes("futabanet.jp") && (
      /\/(?:episodes|viewer|list\/work\/[^\/]+\/episodes)\//.test(new URL(url).pathname) ||
      Boolean(DOC.getElementById('content')?.dataset?.ptbinbCid) ||
      Boolean(DOC.getElementById('content')?.getAttribute('data-ptbinb-cid'))
    ),

    getCid: () => {
      const contentEl = DOC.getElementById('content');
      const cid = contentEl?.dataset?.ptbinbCid || contentEl?.getAttribute('data-ptbinb-cid');
      if (cid && cid.trim()) return cid.trim();
      const match = WIN.location.pathname.match(/episodes\/([a-zA-Z0-9_-]+)/);
      return (match && match[1]) ? match[1] : "Gaugau_Episode";
    },

    fetchManifest: async function(cid, Tools, Utils) {
      const contentEl = DOC.getElementById('content');
      const ptbinb = contentEl?.dataset?.ptbinb || contentEl?.getAttribute('data-ptbinb') || "/api/bibGetCntntInfo";

      const randomString = Tools.generateRandomString32(cid);
      const delimiter = ptbinb.includes('?') ? '&' : '?';
      const apiUrl = `${WIN.location.origin}${ptbinb}${delimiter}dmytime=${Date.now()}&cid=${cid}&k=${randomString}`;

      const infoBuffer = await Utils.fetchBuffer(apiUrl);
      const infoJson = JSON.parse(new TextDecoder().decode(infoBuffer));
      const data = infoJson.items?.[0];
      if (!data?.ContentsServer) throw new Error("Không lấy được ContentsServer từ Gaugau.");

      const config = {
        title: data.Title || data.SubTitle || "",
        contentServer: data.ContentsServer,
        ctbl: Tools.getDecryptedTable(cid, randomString, data.ctbl),
        ptbl: Tools.getDecryptedTable(cid, randomString, data.ptbl)
      };

      const contentUrl = `${config.contentServer}/content.js?dmytime=${Date.now()}`;
      const contentBuffer = await Utils.fetchBuffer(contentUrl);
      const rawText = new TextDecoder().decode(contentBuffer);
      const cleanJson = rawText.replace(/^DataGet_Content\(/, '').replace(/\);?\s*$/, '');
      const { ttx } = JSON.parse(cleanJson);

      const seen = new Set();
      const files = [];
      for (const match of ttx.matchAll(/(pages\/[a-zA-Z0-9_]*.jpg)[^A-Z]*orgwidth="(\d*)" orgheight="(\d*)"/gm)) {
        const filename = match[1];
        if (!seen.has(filename)) {
          seen.add(filename);
          files.push({
            pageNo: files.length + 1,
            filename: filename,
            width: parseInt(match[2], 10),
            height: parseInt(match[3], 10),
            src: `${config.contentServer}/${filename}/M_H.jpg`
          });
        }
      }

      return { config, files };
    },

    getTitle: function(config, cid) {
      let series = "";
      let episode = "";

      const sEl = DOC.querySelector('.works_detail__title, .episode_header__title, .c-series-title, .works_tateyomi__title');
      const eEl = DOC.querySelector('.episode_detail__title, .episode_header__sub_title, .c-episode-title, .works_tateyomi__sub-title');

      if (sEl) series = sEl.textContent;
      if (eEl) episode = eEl.textContent;

      if (!series || !episode) {
        let raw = DOC.title || config.title || "";
        raw = raw.split(/[|｜]/)[0].trim();
        raw = raw.replace(/^公式\s*[-－_]?\s*/i, '').trim();
        raw = raw.replace(/【[^】]*】/g, '').trim();

        const match = raw.match(/^(.*?)\s+(第?\s*\d+\s*(?:話|章|節|部|エピソード|前編|中編|後編)?.*)$/i);
        if (match) {
          if (!series) series = match[1];
          if (!episode) episode = match[2];
        } else {
          if (!series) series = raw;
          if (!episode) episode = cid;
        }
      }

      return resolveCleanFileName(series, episode, cid);
    }
  };

  // 4. BOOKLIVE (booklive.jp)
  const BookliveAdapter = {
    id: "booklive",
    name: "BookLive",
    theme: { color: "#D44C00", bg: "#ffffff", text: "#D44C00", top: "43px" },

    isMatch: (url) => {
      if (!url.includes("booklive.jp")) return false;
      return (
        url.includes("/bviewer") ||
        url.includes("cid=") ||
        Boolean(new URL(url, WIN.location.origin).searchParams.get('cid')) ||
        Boolean(DOC.getElementById('content')?.getAttribute('data-ptbinb-cid'))
      );
    },

    getCid: () => {
      try {
        const urlObj = new URL(WIN.location.href);
        const cid = urlObj.searchParams.get('cid');
        if (cid && cid.trim()) return cid.trim();
      } catch (e) {}

      const attr = DOC.getElementById('content')?.getAttribute('data-ptbinb-cid') || DOC.getElementById('content')?.dataset?.ptbinbCid;
      if (attr && attr.trim()) return attr.trim();

      const pathMatch = WIN.location.pathname.match(/bviewer\/(?:s\/)?([0-9a-zA-Z_-]+)/);
      if (pathMatch && pathMatch[1] && pathMatch[1] !== 's' && pathMatch[1] !== 'index') {
        return pathMatch[1].trim();
      }

      return "Booklive_Episode";
    },

    fetchManifest: async function(cid, Tools, Utils) {
      const randomString = Tools.generateRandomString32(cid);
      const infoUrl = `https://booklive.jp/bib-api/bibGetCntntInfo?cid=${cid}&dmytime=${Date.now()}&k=${randomString}`;

      const infoBuffer = await Utils.fetchBuffer(infoUrl);
      const infoJson = JSON.parse(new TextDecoder().decode(infoBuffer));
      const data = infoJson.items?.[0];
      if (!data?.ContentsServer) throw new Error("Không lấy được ContentsServer từ BookLive.");

      // Bắt buộc phân nhánh: Trial đọc content.js trên CloudFront, Full đọc sbcGetCntnt.php
      const isTrial = data.ContentsServer.includes('trial') || !data.p;
      const config = {
        title: data.Title || "",
        subTitle: data.SubTitle || "",
        contentServer: data.ContentsServer,
        p: data.p || "",
        isTrial: isTrial,
        ctbl: Tools.getDecryptedTable(cid, randomString, data.ctbl),
        ptbl: Tools.getDecryptedTable(cid, randomString, data.ptbl)
      };

      let ttx = "";
      if (isTrial) {
        // Bản Trial: Kéo file tĩnh content.js (100% Thành công)
        const contentUrl = `${config.contentServer}/content.js?dmytime=${Date.now()}`;
        const contentBuffer = await Utils.fetchBuffer(contentUrl);
        const rawText = new TextDecoder().decode(contentBuffer);
        const jsonMatch = rawText.slice(rawText.indexOf('{'), rawText.lastIndexOf('}') + 1);
        const contentData = JSON.parse(jsonMatch);
        ttx = contentData.ttx || "";
      } else {
        // Bản Mua Full: Kéo API động sbcGetCntnt.php (vm=1)
        const contentUrl = `${config.contentServer}/sbcGetCntnt.php?cid=${cid}&p=${config.p}&vm=1&dmytime=${Date.now()}`;
        const contentBuffer = await Utils.fetchBuffer(contentUrl);
        const contentData = JSON.parse(new TextDecoder().decode(contentBuffer));
        ttx = contentData.ttx || "";
      }

      const seen = new Set();
      const files = [];

      // Quét TTX bằng Regex 1-pass sạch gọn
      for (const match of ttx.matchAll(/<(?:t-img|img)[^>]+src=["']?([^"'\s>]+)["']?[^>]*>/gi)) {
        const tagStr = match[0];
        const filename = match[1];
        const wMatch = tagStr.match(/orgwidth=["']?(\d+)["']?/i) || tagStr.match(/width=["']?(\d+)["']?/i);
        const hMatch = tagStr.match(/orgheight=["']?(\d+)["']?/i) || tagStr.match(/height=["']?(\d+)["']?/i);

        if (filename && !seen.has(filename)) {
          seen.add(filename);
          const w = wMatch ? parseInt(wMatch[1], 10) : 0;
          const h = hMatch ? parseInt(hMatch[1], 10) : 0;

          const src = isTrial
            ? `${config.contentServer}/${filename}/M_H.jpg`
            : `${config.contentServer}/sbcGetImg.php?cid=${cid}&src=${encodeURIComponent(filename)}&p=${config.p}&vm=1&q=1`;

          files.push({
            pageNo: files.length + 1,
            filename: filename,
            width: w,
            height: h,
            src: src
          });
        }
      }

      return { config, files };
    },

    getTitle: function(config, cid) {
      let series = config.title || "";
      let episode = config.subTitle || "";

      if (!series) {
        let raw = DOC.title || "";
        raw = raw.split(/[|｜]/)[0].trim();
        raw = raw.replace(/^【.*?】\s*/g, '').trim();
        series = raw;
      }

      if (episode) {
        const epMatch = episode.match(/((?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万]+\s*(?:話|巻|章|節|部|エピソード|分冊版|単話)?.*)$/i);
        if (epMatch) episode = epMatch[1];
      }

      return resolveCleanFileName(series, episode, cid);
    }
  };

  const ADAPTERS = [CmoaAdapter, YanmagaAdapter, GaugauAdapter, BookliveAdapter];

  function resolveSiteAdapter() {
    const currentUrl = WIN.location.href;
    for (const adapter of ADAPTERS) {
      if (adapter.isMatch(currentUrl)) {
        return adapter;
      }
    }
    return null;
  }

  /* =========================================================================
   * GIAO DIỆN UI UNIVERSAL 2 TẦNG (TÊN BRAND + SPEEDBINB)
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;
    const adapter = state.currentAdapter || resolveSiteAdapter();

    if (typeof createUI === "function" && DOC.body && adapter) {
      const { theme, name } = adapter;
      state.ui = createUI({
        storagePrefix: "speedbinb-dl",
        title: name,
        themeColor: theme.color,
        themeBg: theme.bg,
        titleColor: theme.text,
        topOffset: theme.top,
        defaultJpgText: "Xuất file JPG (mặc định PNG)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("speedbinb-dl:convert-jpeg", checked ? '1' : '0');
        }
      });

      // Tùy biến Header 2 tầng: Dòng 1 Brand (13px Bold), Dòng 2 SPEEDBINB (9px Uppercase)
      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:${theme.text};letter-spacing:0.2px;">${name}</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px;">SPEEDBINB</div>
          `;
        }
      }
    }
    return state.ui;
  }

  /* =========================================================================
   * LÕI GIẢI MÃ MA TRẬN SPEEDBINB TRÊN CANVAS (DÙNG CHUNG)
   * ========================================================================= */
  async function descrambleSpeedBinbImage(fileObj, config, isJpg) {
    const Tools = window.SpeedBinbTools || globalThis.SpeedBinbTools;
    const Utils = window.MangaUtils || globalThis.MangaUtils;

    const rawBuffer = await Utils.fetchBuffer(fileObj.src);
    const img = await Utils.loadImage(rawBuffer);

    const key = Tools.getDecryptionKey(fileObj.filename, config.ctbl, config.ptbl);
    const decoder = new Tools.CoordDecoder(key[0], key[1]);
    const coords = decoder.getCoords(img);

    // Kích thước chuẩn xác 100% tính từ ma trận tọa độ giải mã
    let destW = 0, destH = 0;
    for (const { destX, destY, width, height } of coords) {
      if (destX + width > destW) destW = destX + width;
      if (destY + height > destH) destH = destY + height;
    }

    const canvas = DOC.createElement('canvas');
    canvas.width = destW || img.width;
    canvas.height = destH || img.height;

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (const { srcX, srcY, destX, destY, width, height } of coords) {
      ctx.drawImage(img, srcX, srcY, width, height, destX, destY, width, height);
    }

    // Xuất thẳng Blob chuẩn (Kích thước destW x destH đã là kích thước gốc chuẩn 100%)
    const mimeType = isJpg ? 'image/jpeg' : 'image/png';
    const outExt = isJpg ? 'jpg' : 'png';
    const blob = await new Promise(r => canvas.toBlob(r, mimeType, CONFIG.JPEG_QUALITY));

    canvas.width = 0;
    canvas.height = 0;

    return {
      fileName: `${fileObj.pageNo}.${outExt}`,
      data: new Uint8Array(await blob.arrayBuffer())
    };
  }

  /* =========================================================================
   * TIẾN TRÌNH TẢI CHÍNH (6 LUỒNG SONG SONG TRONG RAM)
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const adapter = state.currentAdapter;
    const ui = getUI();

    if (!adapter) {
      if (ui) ui.updateProgress({ status: "Lỗi: Không tìm thấy adapter phù hợp." });
      return;
    }

    const cid = adapter.getCid();
    if (!cid || cid.includes("Episode")) {
      if (ui) ui.updateProgress({ status: "Lỗi: Không tìm thấy CID." });
      return;
    }

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let data = state.chapterData;
      if (!data) {
        const Tools = window.SpeedBinbTools || globalThis.SpeedBinbTools;
        const Utils = window.MangaUtils || globalThis.MangaUtils;
        data = await adapter.fetchManifest(cid, Tools, Utils);
        state.chapterData = data;
      }

      const { config, files } = data;
      const totalPages = files.length;
      if (!totalPages) throw new Error("Không có trang hợp lệ để tải.");

      const useJpeg = Boolean(state.convertJpeg);
      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file txt định danh ID tập vào thư mục gốc ZIP
      zip.addFile(`${cid}.txt`, new Uint8Array(0));

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = files.map(fileObj => () => descrambleSpeedBinbImage(fileObj, config, useJpeg));
      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res?.data) zip.addFile(res.fileName, res.data);
      }

      const zipName = `${adapter.getTitle(config, cid)}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[speedbinb-dl] Error:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * KHỞI CHẠY VÀ THEO DÕI ĐIỀU HƯỚNG SPA (ROUTE WATCHER)
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(30);

    const adapter = resolveSiteAdapter();
    state.currentAdapter = adapter;
    const ui = getUI();

    if (!adapter) {
      if (ui?.panel) ui.panel.style.display = "none";
      return;
    }

    if (ui?.panel) ui.panel.style.display = "block";
    if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });

    // CHỜ DOM HYDRATE (Nếu chưa có CID, chờ tối đa 2 giây để web kịp gắn #content vào DOM)
    let cid = adapter.getCid();
    if (!cid || cid.includes("Episode")) {
      for (let i = 0; i < 20; i++) {
        await sleep(100);
        cid = adapter.getCid();
        if (cid && !cid.includes("Episode")) break;
      }
    }

    if (!cid || cid.includes("Episode")) {
      if (ui) ui.updateProgress({ status: "Sẵn sàng." });
      return;
    }

    try {
      const Tools = window.SpeedBinbTools || globalThis.SpeedBinbTools;
      const Utils = window.MangaUtils || globalThis.MangaUtils;

      const data = await adapter.fetchManifest(cid, Tools, Utils);
      state.chapterData = data;

      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: data.files.length,
          status: "Sẵn sàng."
        });
      }
    } catch (e) {
      console.error("[speedbinb-dl] Boot error:", e);
      if (ui) ui.updateProgress({ status: "Sẵn sàng." });
    }
  }

  // Hook SPA History
  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute(() => {
      state.chapterData = null;
      state.running = false;
      const ui = getUI();
      if (ui) ui.setBusy(false);
      boot();
    });
  }

  if (DOC.readyState === "loading") {
    DOC.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();