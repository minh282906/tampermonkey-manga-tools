// ==UserScript==
// @name         SpeedBinb Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      3.0.0
// @icon         https://www.voyager.co.jp/products/pt/images/service_logo_01.jpg
// @description  Tải manga trên các nền tảng SpeedBinb (Booklive, Comic Cmoa, Yanmaga, GauGau Monster+, ...).
// @author       anonymous & AI
// @match        https://kirapo.jp/pt/*
// @match        https://www.123hon.com/vw/*
// @match        https://comic-porta.com/p_data/*
// @match        https://televikun-super-hero-comics.com/rensai/*/*/
// @match        https://www.cmoa.jp/bib/speedreader/*
// @match        https://yanmaga.jp/*
// @match        https://gaugau.futabanet.jp/*
// @match        https://booklive.jp/*
// @match        https://*.booklive.jp/*
// @match        https://voltage-comics.com/*
// @match        https://*.voltage-comics.com/*
// @match        https://www.yomonga.com/*
// @match        https://yomonga.com/*
// @match        https://binb.bricks.pub/contents/*
// @match        https://*.bookhodai.jp/speedreader/*
// @match        https://e-comi.shogakukan.co.jp/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      kirapo.jp
// @connect      *.kirapo.jp
// @connect      123hon.com
// @connect      *.123hon.com
// @connect      comic-porta.com
// @connect      *.comic-porta.com
// @connect      televikun-super-hero-comics.com
// @connect      *.televikun-super-hero-comics.com
// @connect      cmoa.jp
// @connect      *.cmoa.jp
// @connect      *.akamaized.net
// @connect      yanmaga.jp
// @connect      *.yanmaga.jp
// @connect      gaugau.futabanet.jp
// @connect      *.futabanet.jp
// @connect      booklive.jp
// @connect      *.booklive.jp
// @connect      voltage-comics.com
// @connect      *.voltage-comics.com
// @connect      yomonga.com
// @connect      *.yomonga.com
// @connect      binb.bricks.pub
// @connect      *.bricks.pub
// @connect      bookhodai.jp
// @connect      *.bookhodai.jp
// @connect      e-comi.shogakukan.co.jp
// @connect      *.e-comi.shogakukan.co.jp
// @connect      sbc.e-comi.shogakukan.co.jp
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/SpeedBinbDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/SpeedBinbDownloader.user.js
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
    JPEG_QUALITY: 1.0    // Chất lượng xuất JPG nếu tick chọn
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
   * BỘ HỖ TRỢ XỬ LÝ CHUỖI & TÊN FILE
   * ========================================================================= */
  function cleanString(str) {
    if (!str) return "";
    return str
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/【(?!(?:フルカラー版|カラー版|完全版|特装版))[^】]*】/gi, '') // 👈 Giữ lại nhãn bản màu
      .replace(/[\\/*?:"<>|]/g, '')
      .trim();
  }

  function cleanBaseSeriesTitle(raw) {
    if (!raw) return "";
    let s = raw.split(/[|｜]/)[0].trim();
    s = s.replace(/^(?:無料・試し読みページ|無料・試し読み|無料版|試し読み|公式\s*[-－_]?)\s*/i, '').trim();
    s = s.replace(/【(?!(?:フルカラー版|カラー版|完全版|特装版))[^】]*】/gi, '').trim(); // 👈 Giữ lại nhãn bản màu
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
        raw = raw.replace(/【(?!(?:フルカラー版|カラー版|完全版|特装版))[^】]*】/gi, '').trim(); // 👈 Giữ lại nhãn bản màu

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

  // 3. GauGau Monster Plus (gaugau.futabanet.jp)
  const GaugauAdapter = {
    id: "gaugau",
    name: "GauGau Monster+",
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
        raw = raw.replace(/【(?!(?:フルカラー版|カラー版|完全版|特装版))[^】]*】/gi, '').trim(); // 👈 Giữ lại nhãn bản màu

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

  // 5. VOLTAGE COMICS (voltage-comics.com)
  const VoltageAdapter = {
    id: "voltage",
    name: "Voltage Comics",
    theme: { color: "#559d99", bg: "#ffffff", text: "#559d99", top: "43px" },

    isMatch: (url) => url.includes("voltage-comics.com") && (
      url.includes("/viewer/") ||
      Boolean(new URL(url, WIN.location.origin).searchParams.get('cid')) ||
      Boolean(DOC.getElementById('content')?.getAttribute('data-ptbinb-cid'))
    ),

    getCid: () => {
      try {
        const cid = new URL(WIN.location.href).searchParams.get('cid');
        if (cid && cid.trim()) return cid.trim();
      } catch (e) {}
      const attr = DOC.getElementById('content')?.getAttribute('data-ptbinb-cid') || DOC.getElementById('content')?.dataset?.ptbinbCid;
      return (attr && attr.trim()) ? attr.trim() : "Voltage_Episode";
    },

    fetchManifest: async function(cid, Tools, Utils) {
      const randomString = Tools.generateRandomString32(cid);
      const infoUrl = `https://voltage-comics.com/sws/bibGetCntntInfo?cid=${cid}&dmytime=${Date.now()}&k=${randomString}`;

      const infoBuffer = await Utils.fetchBuffer(infoUrl);
      const infoJson = JSON.parse(new TextDecoder().decode(infoBuffer));
      const data = infoJson.items?.[0];
      if (!data?.ContentsServer) throw new Error("Không lấy được ContentsServer từ Voltage Comics.");

      const config = {
        title: data.Title || data.title || "",
        subTitle: data.SubTitle || data.subtitle || "",
        contentServer: data.ContentsServer || data.contentsServer,
        ctbl: Tools.getDecryptedTable(cid, randomString, data.ctbl),
        ptbl: Tools.getDecryptedTable(cid, randomString, data.ptbl)
      };

      const contentUrl = `${config.contentServer}content`;
      const contentBuffer = await Utils.fetchBuffer(contentUrl);
      const rawText = new TextDecoder().decode(contentBuffer);
      const contentJson = JSON.parse(rawText);
      const ttx = contentJson.ttx || "";

      // BÓC TÁCH TIÊU ĐỀ THẬT TỪ FILE TTX HOẶC METADATA CỦA VOYAGER
      let ttxTitle = "";
      const ttxMatch = ttx.match(/<title>([^<]+)<\/title>/i) || ttx.match(/title=["']([^"']+)["']/i);
      if (ttxMatch) ttxTitle = ttxMatch[1];

      config.title = data.Title || contentJson.title || contentJson.Title || ttxTitle || "";
      config.subTitle = data.SubTitle || contentJson.subTitle || "";

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
            src: `${config.contentServer}img/${filename}?q=1`
          });
        }
      }

      return { config, files };
    },

    getTitle: function(config, cid) {
      let raw = config.title || "";

      // 1. Dò tìm trên DOM hoặc document.title
      if (!raw) {
        const domTitle = DOC.querySelector('h1, h2, .title, [class*="title"], #contentTitle')?.textContent;
        if (domTitle) raw = domTitle;
      }
      if (!raw && DOC.title && !DOC.title.includes("speed.html") && !DOC.title.includes("BinB")) {
        raw = DOC.title;
      }

      // 2. Dò tìm từ Referrer / Breadcrumbs nếu mở từ trang truyện sang
      if (!raw && DOC.referrer && DOC.referrer.includes("voltage-comics.com")) {
        try {
          const matchRef = DOC.referrer.match(/\/title\/([^\/?#]+)/);
          if (matchRef) raw = decodeURIComponent(matchRef[1]);
        } catch(e) {}
      }

      raw = raw.split(/[|｜]/)[0].trim();
      raw = raw.replace(/[-－–—\s]*(?:ボルテージ|Voltage|ぼるコミ).*$/gi, '').trim();

      // 3. Phân tách Tên truyện và Số tập (Ví dụ: "...とろあまセックス〜 1" hoặc "キスでふさいで、バレないで。 1")
      let series = "";
      let episode = "";

      if (config.subTitle) {
        series = raw;
        episode = cleanString(config.subTitle);
      } else {
        const match = raw.match(/^(.*?)(?:\s+[-－–—/]\s+|\s+)(\d+|[0-9０-９]+)$/);
        if (match) {
          series = match[1];
          episode = match[2];
        } else {
          const numMatch = raw.match(/^(.*?)\s+((?:第\s*)?\d+.*)$/);
          if (numMatch) {
            series = numMatch[1];
            episode = numMatch[2];
          } else {
            series = raw;
          }
        }
      }

      return resolveCleanFileName(series, episode, cid);
    }
  };

  // 6. YOMONGA (yomonga.com)
  const YomongaAdapter = {
    id: "yomonga",
    name: "Yomonga",
    theme: { color: "#F55070", bg: "#ffffff", text: "#F55070", top: "115px" },

    isMatch: (url) => url.includes("yomonga.com") && (
      url.includes("/titles/") ||
      Boolean(new URL(url, WIN.location.origin).searchParams.get('cid')) ||
      Boolean(DOC.getElementById('content')?.getAttribute('data-ptbinb-cid'))
    ),

    getCid: () => {
      try {
        const cid = new URL(WIN.location.href).searchParams.get('cid');
        if (cid && cid.trim()) return cid.trim();
      } catch (e) {}
      const attr = DOC.getElementById('content')?.getAttribute('data-ptbinb-cid') || DOC.getElementById('content')?.dataset?.ptbinbCid;
      return (attr && attr.trim()) ? attr.trim() : "Yomonga_Episode";
    },

    fetchManifest: async function(cid, Tools, Utils) {
      const randomString = Tools.generateRandomString32(cid);
      const infoUrl = `https://www.yomonga.com/binb/sws/apis/bibGetCntntInfo.php?cid=${cid}&dmytime=${Date.now()}&k=${randomString}`;

      const infoBuffer = await Utils.fetchBuffer(infoUrl);
      const infoJson = JSON.parse(new TextDecoder().decode(infoBuffer));
      const data = infoJson.items?.[0];
      if (!data?.ContentsServer) throw new Error("Không lấy được ContentsServer từ Yomonga.");

      const config = {
        title: data.Title || "",
        contentServer: data.ContentsServer,
        ctbl: Tools.getDecryptedTable(cid, randomString, data.ctbl),
        ptbl: Tools.getDecryptedTable(cid, randomString, data.ptbl)
      };

      const contentUrl = `${config.contentServer}content`;
      const contentBuffer = await Utils.fetchBuffer(contentUrl);
      const { ttx } = JSON.parse(new TextDecoder().decode(contentBuffer));

      const seen = new Set();
      const files = [];
      // Yomonga dùng images/...jpg thay vì pages/...jpg
      for (const match of ttx.matchAll(/(images\/[a-zA-Z0-9_]*.jpg)[^A-Z]*orgwidth="(\d*)" orgheight="(\d*)"/gm)) {
        const filename = match[1];
        if (!seen.has(filename)) {
          seen.add(filename);
          files.push({
            pageNo: files.length + 1,
            filename: filename,
            width: parseInt(match[2], 10),
            height: parseInt(match[3], 10),
            src: `${config.contentServer}img/${filename}?q=1`
          });
        }
      }

      return { config, files };
    },

    getTitle: function(config, cid) {
      let raw = config.title || DOC.title || "";
      raw = raw.split(/[|｜]/)[0].trim();
      raw = raw.replace(/[-－–—\s]*(?:よもんが|Yomonga|マンガよもんが).*$/gi, '').trim();

      let series = "";
      let episode = "";

      // Tách chuỗi: [Tên truyện] [Chapter... / 第...話 / ...巻]
      const match = raw.match(/^(.*?)\s+((?:Chapter|第|Vol|[0-9０-９]+)[\s\S]*)$/i);
      if (match) {
        series = match[1];
        episode = match[2];
      } else {
        series = raw;
      }

      return resolveCleanFileName(series, episode, cid);
    }
  };

  // 7. OHTA WEB COMIC / BRICKS (binb.bricks.pub)
  const BricksAdapter = {
    id: "bricks",
    name: "Ohta Web Comic",
    theme: { color: "#EA4736", bg: "#ffffff", text: "#EA4736", top: "43px" },

    isMatch: (url) => (url.includes("bricks.pub") || url.includes("ohtawebcomic.com")) && (url.includes("/speed_reader") || url.includes("/contents/")),

    getCid: () => {
      const match = WIN.location.pathname.match(/\/contents\/([^\/?#]+)/);
      if (match && match[1]) return match[1];
      const attr = DOC.getElementById('content')?.getAttribute('data-ptbinb-cid') || DOC.getElementById('content')?.dataset?.ptbinbCid;
      return (attr && attr.trim()) ? attr.trim() : "Ohta_Episode";
    },

    fetchManifest: async function(cid, Tools, Utils) {
      const contentEl = DOC.getElementById('content');
      const ptbinb = contentEl?.dataset?.ptbinb || "https://console.binb.bricks.pub/bibGetCntntInfo";
      const randomString = Tools.generateRandomString32(cid);

      // Giữ nguyên toàn bộ query (u0, ...) của console.binb.bricks.pub
      const apiUrlObj = new URL(ptbinb, WIN.location.href);
      apiUrlObj.searchParams.set("cid", cid);
      apiUrlObj.searchParams.set("k", randomString);
      apiUrlObj.searchParams.set("dmytime", Date.now());

      const infoBuf = await Utils.fetchBuffer(apiUrlObj.href);
      const infoJson = JSON.parse(new TextDecoder().decode(infoBuf));
      const data = infoJson.items?.[0];
      if (!data?.ContentsServer) throw new Error("Không lấy được ContentsServer từ Bricks Pub.");

      const serverBase = data.ContentsServer.replace(/\/?$/, '/');

      const config = {
        title: data.Title || "",
        contentServer: serverBase,
        ctbl: data.ctbl ? Tools.getDecryptedTable(cid, randomString, data.ctbl) : null,
        ptbl: data.ptbl ? Tools.getDecryptedTable(cid, randomString, data.ptbl) : null
      };

      // CHUẨN S3: Kéo content.js (có fallback sang content nếu server đổi dạng)
      let ttx = "";
      try {
        const contentUrl = `${serverBase}content.js?dmytime=${Date.now()}`;
        const contentBuffer = await Utils.fetchBuffer(contentUrl);
        const rawText = new TextDecoder().decode(contentBuffer);
        const cleanJson = rawText.replace(/^DataGet_Content\(/, '').replace(/\);?\s*$/, '');
        ttx = JSON.parse(cleanJson).ttx || "";
      } catch (e) {
        const contentUrl = `${serverBase}content`;
        const contentBuffer = await Utils.fetchBuffer(contentUrl);
        ttx = JSON.parse(new TextDecoder().decode(contentBuffer)).ttx || "";
      }

      const seen = new Set();
      const files = [];
      for (const match of ttx.matchAll(/<(?:t-img|img)[^>]+src=["']?([^"'\s>]+)["']?[^>]*>/gi)) {
        const filename = match[1];
        if (filename && !seen.has(filename)) {
          seen.add(filename);
          const wMatch = match[0].match(/orgwidth=["']?(\d+)["']?/i);
          const hMatch = match[0].match(/orgheight=["']?(\d+)["']?/i);

          const imgSrc = filename.includes('M_H.jpg') 
            ? `${serverBase}${filename}` 
            : `${serverBase}${filename}/M_H.jpg`;

          files.push({
            pageNo: files.length + 1,
            filename: filename,
            width: wMatch ? parseInt(wMatch[1], 10) : 0,
            height: hMatch ? parseInt(hMatch[1], 10) : 0,
            src: imgSrc
          });
        }
      }

      return { config, files };
    },

    getTitle: function(config, cid) {
      let raw = config.title || DOC.title || "";
      raw = raw.split(/[|｜]/)[0].trim();
      raw = raw.replace(/[-－–—\s]*(?:Ohta Web Comic|太田出版|FLB BinB).*$/gi, '').trim();

      const match = raw.match(/^(.*?)(?:\s+[-－–—/]\s+|\s+)(第?\s*\d+\s*話?.*)$/i);
      if (match) {
        return resolveCleanFileName(match[1], match[2], cid);
      }
      return resolveCleanFileName(raw, "", cid);
    }
  };

  // 8. BOOKHODAI (viewer.bookhodai.jp)
  const BookhodaiAdapter = {
    id: "bookhodai",
    name: "Bookhodai",
    theme: { color: "#3F9339", bg: "#ffffff", text: "#3F9339", top: "43px" },

    isMatch: (url) => url.includes("bookhodai.jp") && (
      url.includes("/speedreader/") ||
      Boolean(new URL(url, WIN.location.origin).searchParams.get('cid')) ||
      Boolean(DOC.getElementById('content')?.getAttribute('data-ptbinb-cid'))
    ),

    getCid: () => {
      try {
        const cid = new URL(WIN.location.href).searchParams.get('cid');
        if (cid && cid.trim()) return cid.trim();
      } catch (e) {}
      const attr = DOC.getElementById('content')?.getAttribute('data-ptbinb-cid') || DOC.getElementById('content')?.dataset?.ptbinbCid;
      return (attr && attr.trim()) ? attr.trim() : "Bookhodai_Episode";
    },

    fetchManifest: async function(cid, Tools, Utils) {
      const contentEl = DOC.getElementById('content');
      const ptbinb = contentEl?.dataset?.ptbinb || "https://viewer.bookhodai.jp/sws/apis/bibGetCntntInfo.php";
      const randomString = Tools.generateRandomString32(cid);

      const apiUrl = new URL(ptbinb, WIN.location.href);
      apiUrl.searchParams.set("cid", cid);
      apiUrl.searchParams.set("k", randomString);
      apiUrl.searchParams.set("dmytime", Date.now());

      for (const [k, v] of new URL(WIN.location.href).searchParams.entries()) {
        if (!apiUrl.searchParams.has(k)) apiUrl.searchParams.set(k, v);
      }

      const infoBuf = await Utils.fetchBuffer(apiUrl.href);
      const infoJson = JSON.parse(new TextDecoder().decode(infoBuf));
      const data = infoJson.items?.[0];
      if (!data?.ContentsServer) throw new Error("Không lấy được ContentsServer từ Bookhodai.");

      const serverBase = data.ContentsServer.replace(/\/?$/, '/');

      const config = {
        title: data.Title || "",
        subTitle: data.SubTitle || "",
        contentServer: serverBase,
        ctbl: data.ctbl ? Tools.getDecryptedTable(cid, randomString, data.ctbl) : null,
        ptbl: data.ptbl ? Tools.getDecryptedTable(cid, randomString, data.ptbl) : null
      };

      // Kéo file cấu hình content.js trên máy chủ tĩnh binbcontents
      let ttx = "";
      try {
        const cntntUrl = `${serverBase}content.js?dmytime=${Date.now()}`;
        const cntntBuf = await Utils.fetchBuffer(cntntUrl);
        const rawText = new TextDecoder().decode(cntntBuf);
        ttx = JSON.parse(rawText.replace(/^DataGet_Content\(/, '').replace(/\);?\s*$/, '')).ttx || "";
      } catch (e) {
        const cntntUrl = `${serverBase}content`;
        const cntntBuf = await Utils.fetchBuffer(cntntUrl);
        ttx = JSON.parse(new TextDecoder().decode(cntntBuf)).ttx || "";
      }

      const seen = new Set();
      const files = [];
      for (const match of ttx.matchAll(/<(?:t-img|img)[^>]+src=["']?([^"'\s>]+)["']?[^>]*>/gi)) {
        const filename = match[1];
        if (filename && !seen.has(filename)) {
          seen.add(filename);
          const wMatch = match[0].match(/orgwidth=["']?(\d+)["']?/i);
          const hMatch = match[0].match(/orgheight=["']?(\d+)["']?/i);

          // LINK ẢNH THẬT TRÊN BINBCONTENTS: Trỏ trực tiếp vào file M_H.jpg
          const src = filename.includes('M_H.jpg')
            ? `${serverBase}${filename}`
            : `${serverBase}${filename}/M_H.jpg`;

          files.push({
            pageNo: files.length + 1,
            filename: filename,
            width: wMatch ? parseInt(wMatch[1], 10) : 0,
            height: hMatch ? parseInt(hMatch[1], 10) : 0,
            src: src
          });
        }
      }

      return { config, files };
    },

    getTitle: function(config, cid) {
      let raw = config.title || DOC.title || "";
      raw = raw.split(/[|｜]/)[0].trim();
      raw = raw.replace(/【[^】]*】/g, '').trim(); // Lọc tag rác quảng cáo trong ngoặc vuông
      raw = raw.replace(/[-－–—\s]*(?:ブック放題|Bookhodai).*$/gi, '').trim();

      let series = "";
      let episode = cleanString(config.subTitle || "");

      if (!episode) {
        // 1. Nếu có sẵn chữ 話 / 回 / 章 / 巻 (Ví dụ: "幸せは腹から満たせ 第1話" hoặc "... 1話")
        const epMatch = raw.match(/^(.*?)\s+((?:第\s*)?[0-9０-９]+(?:\.[0-9]+)?\s*(?:話|回|章|巻|話目|エピソード).*)$/i);
        if (epMatch) {
          series = epMatch[1];
          episode = epMatch[2]; // Giữ nguyên đúng chữ của web (話 hay 巻)
        } else {
          // 2. Nếu tên chỉ để số trong ngoặc (Ví dụ: "... コミック版 (1) (1)" hoặc "（１）")
          const volMatch = raw.match(/[（\(]([0-9０-９]+)[）\)]/);
          if (volMatch) {
            episode = `${volMatch[1]}巻`;
            // Cắt sạch các cụm số (1) lặp lại ở đuôi
            series = raw.replace(/[（\(\s\u3000]+[0-9０-９]+[）\)]*/g, '').trim();
          } else {
            series = raw;
          }
        }
      } else {
        series = raw;
      }

      return resolveCleanFileName(series, episode, cid);
    }
  };

  // 9. SHOGAKUKAN E-COMI (e-comi.shogakukan.co.jp)
  const EcomiAdapter = {
    id: "ecomi",
    name: "e-Comic Store",
    theme: { color: "#E6004B", bg: "#ffffff", text: "#E6004B", top: "43px" },

    isMatch: (url) => url.includes("e-comi.shogakukan.co.jp") && (
      url.includes("/speedreader") ||
      Boolean(new URL(url, WIN.location.origin).searchParams.get('cid')) ||
      Boolean(DOC.getElementById('content')?.getAttribute('data-ptbinb-cid'))
    ),

    getCid: () => {
      try {
        const cid = new URL(WIN.location.href).searchParams.get('cid');
        if (cid && cid.trim()) return cid.trim();
      } catch (e) {}
      const attr = DOC.getElementById('content')?.getAttribute('data-ptbinb-cid') || DOC.getElementById('content')?.dataset?.ptbinbCid;
      return (attr && attr.trim()) ? attr.trim() : "Ecomi_Episode";
    },

    fetchManifest: async function(cid, Tools, Utils) {
      const contentEl = DOC.getElementById('content');
      const ptbinb = contentEl?.dataset?.ptbinb || contentEl?.getAttribute('data-ptbinb') || "/sws/apis/bibGetCntntInfo";
      const randomString = Tools.generateRandomString32(cid);

      const apiUrl = new URL(ptbinb, WIN.location.href);
      apiUrl.searchParams.set("cid", cid);
      apiUrl.searchParams.set("k", randomString);
      apiUrl.searchParams.set("dmytime", Date.now());

      // Kế thừa toàn bộ tham số phân quyền u0..u9 từ URL
      const uParams = Array.from({ length: 10 }, (_, i) => {
        const val = new URL(WIN.location.href).searchParams.get(`u${i}`);
        return val ? `&u${i}=${encodeURIComponent(val)}` : '';
      }).join('');

      // 1. Kéo API lấy khóa và máy chủ tài nguyên sbc.e-comi.shogakukan.co.jp
      const infoBuf = await Utils.fetchBuffer(apiUrl.href);
      const infoJson = JSON.parse(new TextDecoder().decode(infoBuf));
      const data = infoJson.items?.[0];
      if (!data?.ContentsServer || !data?.p) throw new Error("Không lấy được phiên đọc từ e-comi.");

      const serverBase = data.ContentsServer.replace(/\/?$/, '/');
      const config = {
        title: data.Title || data.title || "",
        subTitle: data.SubTitle || data.subtitle || "",
        contentServer: serverBase,
        p: data.p,
        ctbl: Tools.getDecryptedTable(cid, randomString, data.ctbl),
        ptbl: Tools.getDecryptedTable(cid, randomString, data.ptbl)
      };

      // 2. Kéo cấu hình TTX chuẩn sbcGetCntnt.php với cờ vm=2
      const cntntUrl = `${serverBase}sbcGetCntnt.php?cid=${cid}&p=${config.p}&vm=2&dmytime=${Date.now()}${uParams}`;
      const cntntBuf = await Utils.fetchBuffer(cntntUrl);
      const { ttx } = JSON.parse(new TextDecoder().decode(cntntBuf));

      // 3. Bóc tách ảnh qua sbcGetImg.php với cờ vm=2 và bọc encodeURIComponent(filename)
      const seen = new Set();
      const files = [];
      for (const match of ttx.matchAll(/<(?:t-img|img)[^>]+src=["']?([^"'\s>]+)["']?[^>]*>/gi)) {
        const filename = match[1];
        if (filename && !seen.has(filename)) {
          seen.add(filename);
          const wMatch = match[0].match(/orgwidth=["']?(\d+)["']?/i);
          const hMatch = match[0].match(/orgheight=["']?(\d+)["']?/i);

          const imgSrc = `${serverBase}sbcGetImg.php?cid=${cid}&src=${encodeURIComponent(filename)}&p=${config.p}&vm=2${uParams}`;

          files.push({
            pageNo: files.length + 1,
            filename: filename,
            width: wMatch ? parseInt(wMatch[1], 10) : 0,
            height: hMatch ? parseInt(hMatch[1], 10) : 0,
            src: imgSrc
          });
        }
      }

      return { config, files };
    },

    getTitle: function(config, cid) {
      let raw = config.title || DOC.title || "";
      raw = raw.split(/[|｜]/)[0].trim();
      raw = raw.replace(/【[^】]*】/g, '').trim();
      raw = raw.replace(/[-－–—\s]*(?:小学館eコミックストア|小学館|eコミ|e-Comix).*$/gi, '').trim();

      let series = raw;
      let episode = cleanString(config.subTitle || "");

      const match = raw.match(/^(.*?)(?:\s+[-－–—/]\s+|\s+)(第?\s*\d+\s*(?:話|巻|章|節|部|エピソード).*)$/i);
      if (match) {
        series = match[1];
        if (!episode) episode = match[2];
      }

      return resolveCleanFileName(series, episode, cid);
    }
  };

  // 10. SPEEDBINB PTIMG PACKAGE (Comic Polca, Kirapo, Comic Porta, Super Hero Comics)
  const PTImgAdapter = {
    id: "ptimg",

    // Nhận diện Brand Name và màu sắc theo đúng Header bạn cung cấp
    get brandInfo() {
      const href = WIN.location.href.toLowerCase();

      // A. COMIC POLCA (123hon.com/polca) - Nền Xanh đậm (#005BAC), chữ trắng
      if (href.includes('123hon.com')) {
        return { name: "Comic Polca", color: "#2563eb", bg: "#ffffff", text: "#1d4ed8", top: "43px" };
      }

      // B. COMIC PORTA (comic-porta.com) - Nền Cam (#FF9800), chữ đen (#18181b)
      if (href.includes('comic-porta.com')) {
        return { name: "Comic Porta", color: "#FF9800", bg: "#ffffff", text: "#18181b", top: "43px" };
      }

      // C. SUPER HERO COMICS (televikun) - Nền Đỏ (#E11D48), chữ trắng
      if (href.includes('televikun')) {
        return { name: "Super Hero Comics", color: "#000000", bg: "#ffffff", text: "#000000", top: "43px" };
      }

      // D. KIRAPO (kirapo.jp) - Theme Trắng/Đen Monochrome thống nhất toàn sàn
      if (href.includes('kirapo.jp')) {
        let labelName = "Kirapo";
        if (href.includes('/zulet/'))   labelName = "Zulet!";
        if (href.includes('/meteor/'))  labelName = "Comic Meteor";
        if (href.includes('/polaris/')) labelName = "Comic Polaris";
        if (href.includes('/ambre/'))   labelName = "Comic Ambre";
        if (href.includes('/etoile/'))  labelName = "Comic Etoile";
        if (href.includes('/astir/'))   labelName = "Comic Astir";

        return { 
          name: labelName, 
          color: "#FC4679", 
          bg: "#ffffff", 
          text: "#18181b", 
          top: "43px" 
        };
      }

      return { name: "PTImg Viewer", color: "#0284C7", bg: "#0F172A", text: "#38BDF8", top: "60px" };
    },

    get name() { return this.brandInfo.name; },
    get theme() { return this.brandInfo; },

    // KHÓA CHẶT: Chỉ trả về true khi thực sự đang ở trang đọc truyện (tránh hiện UI ở trang chủ / list)
    isMatch: (url) => {
      try {
        const u = new URL(url, WIN.location.href);
        const p = u.pathname;
        if (u.hostname.includes('123hon.com')) return /\/vw\//.test(p);
        if (u.hostname.includes('kirapo.jp')) return /\/pt\//.test(p);
        if (u.hostname.includes('comic-porta.com')) return /\/p_data\//.test(p);
        if (u.hostname.includes('televikun-super-hero-comics.com')) {
          const segs = p.split('/').filter(Boolean);
          return segs.length >= 3 && segs[0] === 'rensai';
        }
      } catch (e) {}
      return false;
    },

    getBaseUrl: () => {
      let base = WIN.location.href.split('?')[0].split('#')[0];
      if (base.endsWith('index.html')) base = base.slice(0, -10);
      if (base.includes('kirapo.jp')) base = base.replace(/\/viewer\/?$/, '/').replace(/viewer$/, '');
      if (!base.endsWith('/')) base = base.substring(0, base.lastIndexOf('/') + 1);
      return base;
    },

    getCid: () => {
      try {
        const cid = new URLSearchParams(WIN.location.search).get('cid');
        if (cid && cid.trim()) return cid.trim();
      } catch (e) {}
      const pathSegments = WIN.location.pathname.split('/').filter(Boolean);
      // Lấy định danh từ 2 phân đoạn cuối của URL
      if (pathSegments.length >= 2) {
        const last = pathSegments[pathSegments.length - 1];
        const prev = pathSegments[pathSegments.length - 2];
        if (last === 'viewer' && pathSegments.length >= 3) {
          return `${pathSegments[pathSegments.length - 3]}_${prev}`;
        }
        return `${prev}_${last}`.replace(/index\.html$/, '');
      }
      return pathSegments[0] || "PTImg_Episode";
    },

    fetchManifest: async function(cid, Tools, Utils) {
      const baseUrl = this.getBaseUrl();
      const htmlBuf = await Utils.fetchBuffer(WIN.location.href);
      const html = new TextDecoder().decode(htmlBuf);

      const jsonMatches = html.match(/data\/\d+\.ptimg\.json/gm);
      if (!jsonMatches || jsonMatches.length === 0) {
        throw new Error("Không tìm thấy cấu trúc data/*.ptimg.json trên trang này.");
      }

      // Sắp xếp số học chuẩn: 0, 1, 2, ... 10, 11 (tránh bẫy sắp xếp chữ: 0, 1, 10, 2)
      const uniqueJsons = [...new Set(jsonMatches)].sort((a, b) => {
        const numA = parseInt(a.match(/\d+/)?.[0] || 0, 10);
        const numB = parseInt(b.match(/\d+/)?.[0] || 0, 10);
        return numA - numB;
      });

      const files = uniqueJsons.map((jsonRelPath, idx) => ({
        pageNo: idx + 1,
        isPTImg: true,
        baseUrl: baseUrl,
        jsonUrl: `${baseUrl}${jsonRelPath}`
      }));

      return {
        config: { isPTImg: true, title: DOC.title },
        files: files
      };
    },

    getTitle: function(config, cid) {
      let raw = DOC.title || "";
      raw = raw.split(/[|｜]/)[0].trim();
      raw = raw.replace(/^【.*?】\s*/g, '').trim();
      raw = raw.replace(/[-－–—\s]*(?:きら星ポータル|KIRAPO|コミックポルカ|コミックポルタ|テレびくん).*$/gi, '').trim();
      return resolveCleanFileName(raw, "", cid);
    }
  };

  const ADAPTERS = [CmoaAdapter, YanmagaAdapter, GaugauAdapter, BookliveAdapter, VoltageAdapter, YomongaAdapter, BricksAdapter, BookhodaiAdapter, PTImgAdapter, EcomiAdapter];

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

    let coords = [];
    let destW = 0, destH = 0;
    let imgSrc = fileObj.src;

    // 1. NẾU LÀ NHÁNH PTIMG TĨNH (Kirapo, Valkyrie, 123hon...)
    if (config.isPTImg || fileObj.isPTImg) {
      const ptBuf = await Utils.fetchBuffer(fileObj.jsonUrl);
      const ptData = JSON.parse(new TextDecoder().decode(ptBuf));
      imgSrc = `${fileObj.baseUrl}data/${ptData.resources.i.src}`;
      destW = ptData.views[0].width;
      destH = ptData.views[0].height;
      coords = ptData.views[0].coords.map(c => Tools.parsePTImgCoords(c)).filter(Boolean);
    }

    const rawBuffer = await Utils.fetchBuffer(imgSrc);
    const img = await Utils.loadImage(rawBuffer);

    // 2. NẾU LÀ NHÁNH SPEEDBINB ĐỘNG (BookLive, Cmoa, Yanmaga, Gaugau)
    if (!config.isPTImg && !fileObj.isPTImg) {
      const key = Tools.getDecryptionKey(fileObj.filename, config.ctbl, config.ptbl);
      const decoder = new Tools.CoordDecoder(key[0], key[1]);
      coords = decoder.getCoords(img);

      for (const { destX, destY, width, height } of coords) {
        if (destX + width > destW) destW = destX + width;
        if (destY + height > destH) destH = destY + height;
      }
    }

    // 3. TÁI TẠO ĐỒ HỌA PIXEL-PERFECT TRÊN CANVAS (DÙNG CHUNG)
    const canvas = DOC.createElement('canvas');
    canvas.width = destW || img.width;
    canvas.height = destH || img.height;

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = false;
    ctx.mozImageSmoothingEnabled = false;
    ctx.webkitImageSmoothingEnabled = false;
    ctx.msImageSmoothingEnabled = false;

    for (const { srcX, srcY, destX, destY, width, height } of coords) {
      ctx.drawImage(img, srcX, srcY, width, height, destX, destY, width, height);
    }

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