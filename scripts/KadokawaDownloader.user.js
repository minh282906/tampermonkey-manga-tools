// ==UserScript==
// @name         Kadokawa Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://www.google.com/s2/favicons?domain=kadokawa.co.jp&sz=128
// @description  Tải manga trên toàn bộ hệ sinh thái Kadokawa & Dwango (ComicWalker / KadoComi, Niconico Manga PC & Mobile).
// @author       anonymous & AI
// @match        https://comic-walker.com/*
// @match        https://sp.manga.nicovideo.jp/watch/*
// @match        https://manga.nicovideo.jp/watch/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      comic-walker.com
// @connect      *.comic-walker.com
// @connect      cdn.comic-walker.com
// @connect      nicovideo.jp
// @connect      *.nicovideo.jp
// @connect      *.nicoseiga.jp
// @connect      *.nicomanga.jp
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/KadokawaDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/KadokawaDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/decoders/KadokawaTools.js
// ==/UserScript==

(function kadokawaUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6,   // 6 luồng tải song song (Kịch trần TCP Socket)
    JPEG_QUALITY: 0.95   // Chất lượng xuất JPG nếu chuyển đổi
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(r => WIN.setTimeout(r, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: false,
    detectedSourceFormat: 'webp',
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
      .replace(/【(?!(?:フルカラー版|カラー版|完全版|特装版))[^】]*】/gi, '')
      .replace(/[\\/*?:"<>|]/g, '')
      .trim();
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
   * ADAPTER 1: COMICWALKER (KADOCOMI)
   * ========================================================================= */
  const ComicWalkerAdapter = {
    id: "comicwalker",
    name: "ComicWalker",
    engine: "KADOKAWA",
    storagePrefix: "cw-dl",
    theme: { color: "#18181b", bg: "#ffffff", text: "#000000", top: "31px" },

    isMatch: (url) => {
      if (!url.includes("comic-walker.com")) return false;
      const path = new URL(url, WIN.location.origin).pathname;
      return /\/detail\/[^\/?#]+/.test(path) || /\/contents\/viewer/.test(path);
    },

    getDefaultFormat: () => 'webp',
    getDefaultJpgText: () => "Xuất file JPG (ảnh gốc là WebP)",

    getUrlCodes: () => {
      const epIdMatch = WIN.location.search.match(/[?&]episodeId=([a-zA-Z0-9_-]+)/);
      if (epIdMatch) return { workCode: "", episodeCode: "", episodeId: epIdMatch[1] };

      const match = WIN.location.pathname.match(/\/detail\/([^\/]+)\/episodes\/([^\/?#]+)/);
      if (match) return { workCode: match[1], episodeCode: match[2], episodeId: "" };

      const workMatch = WIN.location.pathname.match(/\/detail\/([^\/?#]+)/);
      if (workMatch) return { workCode: workMatch[1], episodeCode: "", episodeId: "" };

      return { workCode: "", episodeCode: "", episodeId: "" };
    },

    getEpisodeIdMarker: function(meta) {
      const { episodeCode, episodeId } = this.getUrlCodes();
      return episodeCode || episodeId || meta?.episodeId || "cw_episode";
    },

    getCleanTitle: function(meta) {
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

        if (s && e && e !== this.getEpisodeIdMarker(meta) && !s.includes(e)) {
          return `${s} - ${e}`;
        } else if (s && e && e !== this.getEpisodeIdMarker(meta)) {
          return e;
        } else if (s) {
          return s;
        }
      } catch (e) {}

      return `ComicWalker_${this.getEpisodeIdMarker(meta)}`;
    },

    fetchPages: async function(Tools, Utils) {
      const { workCode, episodeCode, episodeId: rawEpId } = this.getUrlCodes();
      let targetEpisodeId = rawEpId;
      let targetEpisodeCode = episodeCode;
      const epTypeParam = new URLSearchParams(WIN.location.search).get('episodeType');

      let seriesTitle = "";
      let episodeTitle = "";

      // 1. Kéo API episode
      if (!targetEpisodeId && workCode) {
        // NGUYÊN TẮC VÀNG: Nếu URL có mã tập con (Chap 1, Chap 2...), ép epType = 'latest' và BẮT BUỘC ghép &episodeCode
        // Tuyệt đối không để ?episodeType=first trên URL ghi đè làm mất episodeCode!
        const epType = targetEpisodeCode ? 'latest' : (epTypeParam || 'first');
        let epApiUrl = `https://comic-walker.com/api/contents/details/episode?workCode=${workCode}&episodeType=${epType}`;
        if (targetEpisodeCode) epApiUrl += `&episodeCode=${targetEpisodeCode}`;

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
            const allEps = json?.episodes || w?.episodes || [];
            
            // Tìm đúng tập theo targetEpisodeCode nếu có
            const matchedEp = targetEpisodeCode 
              ? allEps.find(e => e?.code === targetEpisodeCode || e?.id === targetEpisodeCode)
              : null;
            const selectedEp = matchedEp || json?.firstEpisode || w?.firstEpisode || allEps[0];
            
            if (!targetEpisodeId) targetEpisodeId = selectedEp?.id || selectedEp?.episodeId || "";
            if (!episodeTitle) episodeTitle = selectedEp?.title || "";
            if (!seriesTitle) seriesTitle = w?.title || json?.title || "";
          } catch (e) {}
        }
      }

      // 3. Dự phòng cấp 3: Bắt thẳng episodeId mà web viewer vừa gọi trên Performance API
      if (!targetEpisodeId && typeof WIN.performance?.getEntriesByType === 'function') {
        const vEntries = WIN.performance.getEntriesByType('resource')
          .filter(r => r.name && r.name.includes('/api/contents/viewer?episodeId='));
        if (vEntries.length > 0) {
          const lastUrl = vEntries[vEntries.length - 1].name;
          const m = lastUrl.match(/[?&]episodeId=([a-zA-Z0-9_-]+)/);
          if (m && m[1]) targetEpisodeId = m[1];
        }
      }

      if (!targetEpisodeId) throw new Error("Không thể xác định Episode ID của chương truyện.");

      // 4. KÉO API VIEWER LẤY DANH SÁCH ẢNH (Đoạn này vừa rồi bị cắt mất dẫn đến lỗi viewerData is not defined) [1]
      const viewerApiUrl = `https://comic-walker.com/api/contents/viewer?episodeId=${targetEpisodeId}&imageSizeType=width%3A1284`;
      const viewerBuf = await Utils.fetchBuffer(viewerApiUrl);
      const viewerData = JSON.parse(new TextDecoder().decode(viewerBuf));

      if (!viewerData || !Array.isArray(viewerData.manuscripts) || viewerData.manuscripts.length === 0) {
        throw new Error("Dữ liệu trang từ API ComicWalker không hợp lệ.");
      }

      // 5. Bổ sung tên truyện nếu thiếu
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
  };

  /* =========================================================================
   * ADAPTER 2: NICONICO MANGA (PC & MOBILE SP)
   * ========================================================================= */
  const NiconicoAdapter = {
    id: "niconico",
    name: "Niconico",
    engine: "DWANGO",
    storagePrefix: "nico-dl",
    theme: { color: "#77C238", bg: "#ffffff", text: "#77C238", top: "48px" },

    isMobile: () => WIN.location.hostname.startsWith('sp.'),

    isMatch: (url) => {
      if (!url.includes("nicovideo.jp")) return false;
      return /\/watch\/(mg\d+|\d+)/.test(new URL(url, WIN.location.origin).pathname);
    },

    getDefaultFormat: function() {
      return this.isMobile() ? 'jpg' : 'webp';
    },

    getDefaultJpgText: function() {
      return this.isMobile() ? "Xuất file JPG (ảnh gốc là JPG)" : "Xuất file JPG (ảnh gốc là WebP)";
    },

    getEpisodeId: () => {
      try {
        const match = WIN.location.pathname.match(/\/watch\/(mg\d+|\d+)/);
        if (match && match[1]) {
          return match[1].startsWith('mg') ? match[1] : `mg${match[1]}`;
        }
      } catch (e) {}
      return "mg_episode";
    },

    getCleanTitle: function() {
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
          raw = raw.replace(/【(?!(?:フルカラー版|カラー版|完全版|特装版))[^】]*】/gi, '').trim();

          const match = raw.match(/^(.*?)(?:\s+[-－–—]\s+|\s+)((?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\s\-\–\—\ー\~〜\.]+(?:話|巻|章|節|部|エピソード|分冊版|単話|前編|中編|後編)?.*)$/i);
          if (match) {
            if (!seriesTitle) seriesTitle = match[1];
            if (!episodeTitle) episodeTitle = match[2];
          } else {
            if (!seriesTitle) seriesTitle = raw;
            if (!episodeTitle) episodeTitle = this.getEpisodeId();
          }
        }

        let cleanSeries = cleanString(seriesTitle);
        cleanSeries = cleanSeries.replace(/（[^）]*(?:コミック|文庫|レーベル|出版|COMIC|WEB)[^）]*）$/i, '').trim();
        cleanSeries = cleanSeries.replace(/\([^)]*(?:コミック|文庫|レーベル|出版|COMIC|WEB)[^)]*\)$/i, '').trim();
        cleanSeries = cleanSeries.replace(/\s*\([^)]*(?:著者|原作|作画|漫画)[^)]*\)/gi, '').trim();

        let cleanEpisode = cleanString(episodeTitle);
        cleanEpisode = cleanEpisode.replace(/\s*\([^)]*(?:著者|原作|作画|漫画)[^)]*\)/gi, '').trim();

        if (cleanSeries && cleanEpisode) {
          let baseWithoutVol = cleanSeries.replace(/\s*[0-9０-９]+\s*巻.*$/i, '').trim();
          if (baseWithoutVol && cleanEpisode.startsWith(baseWithoutVol)) {
            cleanEpisode = cleanString(cleanEpisode.substring(baseWithoutVol.length));
          }
        }

        if (cleanSeries && cleanEpisode && cleanEpisode !== this.getEpisodeId() && !cleanSeries.includes(cleanEpisode)) {
          return `${cleanSeries} - ${cleanEpisode}`;
        } else if (cleanSeries && cleanEpisode && cleanEpisode !== this.getEpisodeId()) {
          return cleanEpisode;
        } else if (cleanSeries) {
          return `${cleanSeries} - ${this.getEpisodeId()}`;
        }
      } catch (e) {}

      return `Niconico_${this.getEpisodeId()}`;
    },

    extractPrUrlsFromDom: function() {
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

      // 2. NẾU LÀ TRÊN MOBILE: Quét CHỈ bên trong khung thẻ <li>
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
    },

    extractImageUrlsFromScriptPayload: function(Tools) {
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
                  foundItems.push({ url: m, drmHash: Tools.extractDrmHashFromUrl(m) });
                }
              }
            }
          }
        }
      } catch (e) {}
      return foundItems;
    },

    fetchPages: async function(Tools) {
      const maxWaitMs = 2500;
      const startTime = Date.now();
      let mainItems = [];

      while (Date.now() - startTime < maxWaitMs) {
        // 1. Lấy danh sách trang truyện chính
        if (WIN.args?.pages && Array.isArray(WIN.args.pages)) {
          mainItems = WIN.args.pages.map(p => ({
            url: p.url,
            drmHash: Tools.extractDrmHashFromUrl(p.url)
          }));
        }

        if (mainItems.length === 0) {
          mainItems = this.extractImageUrlsFromScriptPayload(Tools);
        }

        if (mainItems.length === 0) {
          const imgEls = DOC.querySelectorAll('img[src*="p?"], [data-src*="p?"]');
          for (const img of imgEls) {
            let src = img.getAttribute('data-src') || img.getAttribute('src') || '';
            if (src && !src.startsWith('data:')) {
              if (src.startsWith('//')) src = 'https:' + src;
              if (!mainItems.some(i => i.url === src)) {
                mainItems.push({ url: src, drmHash: Tools.extractDrmHashFromUrl(src) });
              }
            }
          }
        }

        // 2. Lấy danh sách ảnh PR chính thức
        const prUrls = this.extractPrUrlsFromDom();

        if (mainItems.length > 0) {
          if (prUrls.length > 0 || (Date.now() - startTime > 1500)) {
            const resultPages = [];
            let prCount = 0;

            // Niconico đưa ảnh PR lên đầu
            for (const prUrl of prUrls) {
              prCount++;
              resultPages.push({
                isPR: true,
                prNo: prCount,
                url: prUrl
              });
            }

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

            return {
              episodeId: this.getEpisodeId(),
              seriesTitle: "",
              episodeTitle: "",
              pages: resultPages
            };
          }
        }

        await sleep(150);
      }

      return null;
    }
  };

  const ADAPTERS = [ComicWalkerAdapter, NiconicoAdapter];

  function resolveSiteAdapter() {
    const currentUrl = WIN.location.href;
    for (const adapter of ADAPTERS) {
      if (adapter.isMatch(currentUrl)) return adapter;
    }
    return null;
  }

  /* =========================================================================
   * GIAO DIỆN UNIVERSAL UI CHUẨN 2 TẦNG
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;
    const adapter = state.currentAdapter || resolveSiteAdapter();

    if (typeof createUI === "function" && DOC.body && adapter) {
      state.convertJpeg = localStorage.getItem(`${adapter.storagePrefix}:convert-jpeg`) === '1';

      state.ui = createUI({
        storagePrefix: adapter.storagePrefix,
        title: adapter.name,
        themeColor: adapter.theme.color,
        themeBg: adapter.theme.bg,
        titleColor: adapter.theme.text,
        topOffset: adapter.theme.top,
        defaultJpgText: adapter.getDefaultJpgText(),
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem(`${adapter.storagePrefix}:convert-jpeg`, checked ? '1' : '0');
        }
      });

      state.ui.updateFormatUI(state.detectedSourceFormat);

      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:${adapter.theme.text};letter-spacing:0.2px;">${adapter.name}</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px;">${adapter.engine}</div>
          `;
        }
      }
    }
    return state.ui;
  }

  /* =========================================================================
   * XỬ LÝ ẢNH DÙNG CHUNG: GIẢI MÃ XOR & ZERO-COPY THUẦN RAM
   * ========================================================================= */
  async function processKadokawaImage(pageObj, forceJpg) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    const Tools = window.KadokawaTools || globalThis.KadokawaTools;

    const rawBuffer = await Utils.fetchBuffer(pageObj.url);
    const rawUint8 = new Uint8Array(rawBuffer);

    // 1. Ảnh PR: Giữ nguyên file ảnh gốc từ CDN (Zero-Copy)
    if (pageObj.isPR) {
      const ext = getExtensionFromUrl(pageObj.url, 'jpg');
      const fileName = pageObj.singlePR ? `PR.${ext}` : `PR_${pageObj.prNo}.${ext}`;
      return { fileName, data: rawUint8 };
    }

    // 2. Trang truyện chính: Giải mã Cyclic 8-byte XOR
    const finalHash = pageObj.drmHash || Tools.extractDrmHashFromUrl(pageObj.url);
    const isDrm = Boolean(finalHash) || pageObj.url.includes('/image/') || pageObj.url.startsWith('https://drm.cdn');
    const decryptedBytes = (isDrm && finalHash) ? Tools.decryptKadokawaXor(rawUint8, finalHash) : rawUint8;

    // 3. Nhận diện Magic Bytes thực tế
    const ext = Utils.detectExt(decryptedBytes.buffer);

    // 4. ZERO-COPY: Nếu không ép JPG hoặc ảnh vốn là JPG -> Ghi thẳng vào ZIP
    if (!forceJpg || ext === 'jpg') {
      return {
        fileName: `${pageObj.pageNo}.${ext}`,
        data: decryptedBytes
      };
    }

    // 5. Nếu tick chọn xuất JPG -> Vẽ Canvas Point Sampling không làm mượt
    const img = await Utils.loadImage(decryptedBytes.buffer, `image/${ext}`);
    const canvas = DOC.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = false;
    ctx.mozImageSmoothingEnabled = false;
    ctx.webkitImageSmoothingEnabled = false;
    ctx.msImageSmoothingEnabled = false;

    ctx.drawImage(img, 0, 0);

    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', CONFIG.JPEG_QUALITY));
    canvas.width = 0;
    canvas.height = 0;

    return {
      fileName: `${pageObj.pageNo}.jpg`,
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

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let data = state.chapterData;
      if (!data) {
        const Tools = window.KadokawaTools || globalThis.KadokawaTools;
        const Utils = window.MangaUtils || globalThis.MangaUtils;
        data = await adapter.fetchPages(Tools, Utils);
        state.chapterData = data;
      }

      if (!data || !data.pages?.length) throw new Error("Không tìm thấy trang truyện hợp lệ.");

      const { pages } = data;
      const totalPages = pages.length;
      const forceJpg = Boolean(state.convertJpeg);

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đặt file định danh rỗng tại root ZIP
      const epMarker = adapter.id === "comicwalker" ? adapter.getEpisodeIdMarker(data) : adapter.getEpisodeId();
      zip.addFile(`${epMarker}.txt`, new Uint8Array(0));

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map((pageObj) => () => processKadokawaImage(pageObj, forceJpg));

      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res?.data) zip.addFile(res.fileName, res.data);
      }

      const zipName = `${adapter.id === "comicwalker" ? adapter.getCleanTitle(data) : adapter.getCleanTitle()}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[kadokawa-dl] Error:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * KHỞI CHẠY VÀ THEO DÕI ĐIỀU HƯỚNG SPA
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

    state.detectedSourceFormat = adapter.getDefaultFormat();
    if (ui) ui.updateFormatUI(state.detectedSourceFormat);

    let data = null;
    let retries = 0;
    const Tools = window.KadokawaTools || globalThis.KadokawaTools;
    const Utils = window.MangaUtils || globalThis.MangaUtils;

    while (retries < 25) {
      try {
        data = await adapter.fetchPages(Tools, Utils);
        if (data && data.pages?.length > 0) break;
      } catch (e) {}
      await sleep(150);
      retries++;
    }

    if (data && data.pages?.length > 0) {
      state.chapterData = data;

      // Nhận diện định dạng thực tế từ trang truyện đầu tiên
      try {
        const sample = data.pages.find(p => !p.isPR) || data.pages[0];
        const testBuf = await Utils.fetchBuffer(sample.url);
        const testUint8 = new Uint8Array(testBuf);
        const finalHash = sample.drmHash || Tools.extractDrmHashFromUrl(sample.url);
        const isDrm = Boolean(finalHash) || sample.url.includes('/image/') || sample.url.startsWith('https://drm.cdn');
        const dec = (isDrm && finalHash) ? Tools.decryptKadokawaXor(testUint8, finalHash) : testUint8;
        const detected = Utils.detectExt(dec.buffer);
        state.detectedSourceFormat = detected;
        if (ui) ui.updateFormatUI(detected);
      } catch (e) {}

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