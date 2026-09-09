// ==UserScript==
// @name         Bambi Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://pocket.shonenmagazine.com/img/favicon.ico
// @description  Tải manga trên toàn bộ hệ sinh thái Link-U Bambi Engine (Pocket Shonen Magazine, K MANGA, Ciao Plus).
// @author       anonymous & AI
// @match        https://pocket.shonenmagazine.com/*
// @match        https://kmanga.kodansha.com/*
// @match        https://ciao.shogakukan.co.jp/comics/title/*/episode/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      pocket.shonenmagazine.com
// @connect      api.pocket.shonenmagazine.com
// @connect      se-api.pocket.shonenmagazine.com
// @connect      mgpk-cdn.magazinepocket.com
// @connect      kmanga.kodansha.com
// @connect      api.kmanga.kodansha.com
// @connect      se-api.kmanga.kodansha.com
// @connect      cdn.kmanga.kodansha.com
// @connect      ciao.shogakukan.co.jp
// @connect      api.ciao.shogakukan.co.jp
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/BambiDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/BambiDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/decoders/BambiTools.js
// ==/UserScript==

(function bambiUniversalDownloader() {
  'use strict';

  const CONFIG = {
    MAX_CONCURRENT: 4,   // 4 luồng an toàn (tối ưu CPU & tránh WAF Kodansha)
    JPEG_QUALITY: 0.95   // Chất lượng nếu xuất file JPG
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("bambi-dl:convert-jpeg") === '1',
    chapterData: null,
    capturedApiData: null,
    ui: null,
    currentAdapter: null
  };

  /* =========================================================================
   * 1. SINGLE-FLIGHT HOOK ĐÓN GÓI TIN CHUNG CHO CẢ 3 TRANG (/web/episode/viewer)
   * ========================================================================= */
  function installFetchHook() {
    const origFetch = WIN.fetch;
    if (!origFetch || origFetch.__bambi_hooked) return;

    const hookedFetch = async function(...args) {
      const response = await origFetch.apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        if (url.includes('/web/episode/viewer')) {
          const clone = response.clone();
          clone.json().then(data => {
            // Nếu phát hiện máy chủ trả về mã lỗi 3106
            if (data?.error_code === 3106 || data?.status === 3106) {
              console.warn('[Bambi] Phát hiện máy chủ phản hồi lỗi 3106.');
              getUI()?.updateProgress({ status: "Máy chủ bận (3106). Đang tự phục hồi..." });
              return;
            }

            const rawPages = data?.page_list || data?.pages || data?.data?.page_list;
            if (data && Array.isArray(rawPages) && rawPages.length > 0) {
              state.capturedApiData = data;
              // Tự động nhận diện adapter nếu chưa kịp gán
              if (!state.currentAdapter) state.currentAdapter = resolveSiteAdapter();
              syncChapterData();
            }
          }).catch(() => {});
        }
      } catch (e) {}
      return response;
    };

    hookedFetch.__bambi_hooked = true;
    WIN.fetch = hookedFetch;
  }

  installFetchHook();

  /* =========================================================================
   * 2. BỘ BĂM HASH THUẦN WEB CRYPTO API (ZERO-DEPENDENCY)
   * ========================================================================= */
  async function sha256Hex(str) {
    const buf = new TextEncoder().encode(str);
    const digest = await WIN.crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function sha512Hex(str) {
    const buf = new TextEncoder().encode(str);
    const digest = await WIN.crypto.subtle.digest('SHA-512', buf);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function cleanString(str) {
    if (!str) return "";
    return str.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').replace(/【[^】]*】/g, '').replace(/[\\/*?:"<>|]/g, '').trim();
  }

  function resolveCleanFileName(seriesTitle, episodeTitle, fallbackId) {
    let cleanSeries = cleanString(seriesTitle);
    cleanSeries = cleanSeries.replace(/（[^）]*(?:コミック|文庫|レーベル|出版|COMIC|WEB)[^）]*）$/i, '').trim();
    cleanSeries = cleanSeries.replace(/\([^)]*(?:コミック|文庫|レーベル|出版|COMIC|WEB)[^)]*\)$/i, '').trim();

    let cleanEpisode = cleanString(episodeTitle);
    let baseWithoutVol = cleanSeries.replace(/\s*[0-9０-９]+\s*巻.*$/i, '').trim();
    if (baseWithoutVol && cleanEpisode.startsWith(baseWithoutVol)) {
      cleanEpisode = cleanString(cleanEpisode.substring(baseWithoutVol.length));
    }
    cleanEpisode = cleanEpisode.replace(/^[・･\s\-_:：\u3000]+/, '').trim();

    if (cleanSeries && cleanEpisode && cleanEpisode !== fallbackId && !cleanSeries.includes(cleanEpisode)) {
      return `${cleanSeries} - ${cleanEpisode}`;
    } else if (cleanSeries && cleanEpisode && cleanEpisode !== fallbackId) {
      return cleanEpisode;
    } else if (cleanSeries) {
      return `${cleanSeries} - ${fallbackId}`;
    }
    return `Bambi_${fallbackId}`;
  }

  /* =========================================================================
   * 3. HỆ THỐNG ADAPTERS CHO 3 NỀN TẢNG (MAGAPOKE, K MANGA, CIAO PLUS)
   * ========================================================================= */

  // A. MAGAPOKE (Pocket Shonen Magazine - Kodansha JP)
  const MagaPokeAdapter = {
    id: "magapoke",
    name: "MagaPoke",
    engine: "BAMBI ENGINE",
    theme: { color: "#2563eb", bg: "#0b1739", text: "#ffffff", top: "92px" },

    isMatch: (url) => url.includes("pocket.shonenmagazine.com") && /\/episode\/\d+/.test(new URL(url, WIN.location.href).pathname),

    getEpisodeId: () => WIN.location.pathname.match(/\/episode\/(\d+)/)?.[1] || "pocket_episode",

    resolveSeed: (rawSeed, mangaId, episodeId, Tools) => {
      const charset = mangaId % 2 === 0 ? Tools.CHARSETS.MAGAPOKE_EVEN : Tools.CHARSETS.MAGAPOKE_ODD;
      return Tools.parseCharsetSeed(rawSeed, charset, mangaId, episodeId);
    },

    fetchApiFallback: async (episodeId, Utils) => {
      const keys = ['episode_id'].sort();
      const kHash = await sha256Hex('episode_id');
      const vHash = await sha512Hex(String(episodeId));
      const part1 = await sha256Hex(`${kHash}_${vHash}`);
      const empty256 = await sha256Hex('');
      const empty512 = await sha512Hex('');
      const hash = await sha512Hex(`${part1}${empty256}_${empty512}`);

      const apiUrl = `https://se-api.pocket.shonenmagazine.com/web/episode/viewer?episode_id=${episodeId}`;
      const buf = await Utils.fetchBuffer(apiUrl, {
        'Accept': 'application/json',
        'X-Manga-Hash': hash,
        'X-Manga-Is-Crawler': 'false',
        'X-Manga-Platform': '3'
      });
      return JSON.parse(new TextDecoder().decode(buf));
    },

    getTitle: (fallbackId) => {
      // Bóc tách trực tiếp từ thẻ meta twitter:title / og:title
      const metaTitle = DOC.querySelector('meta[name="twitter:title"]')?.getAttribute('content')
                     || DOC.querySelector('meta[property="og:title"]')?.getAttribute('content')
                     || DOC.title || "";

      if (metaTitle.includes('|')) {
        const parts = metaTitle.split('|').map(p => p.trim());
        const s = parts[0] || ""; // "となりの黒川さん"
        
        // parts[1]: "【第1話】彼女はヒロイン？ / マガポケ..."
        let e = (parts[1] || "").split('/')[0].trim();
        // Chuyển 【第1話】 thành "第1話 "
        e = e.replace(/【\s*((?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\.]+\s*(?:話|巻|章|節|部|エピソード|分冊版|単話)?)\s*】/gi, '$1 ')
             .replace(/[【】\[\]「」『』]/g, '')
             .trim(); // "第1話 彼女はヒロイン？"
        if (s && e) {
          return resolveCleanFileName(s, e, fallbackId);
        }
      }
      return resolveCleanFileName(s, e, fallbackId);
    }
  };

  // B. K MANGA (Kodansha US)
  const KMangaAdapter = {
    id: "kmanga",
    name: "K MANGA",
    engine: "BAMBI ENGINE",
    theme: { color: "#2563eb", bg: "#0b1739", text: "#ffffff", top: "92px" },

    isMatch: (url) => url.includes("kmanga.kodansha.com") && /\/episode\/\d+/.test(new URL(url, WIN.location.href).pathname),

    getEpisodeId: () => WIN.location.pathname.match(/\/episode\/(\d+)/)?.[1] || "kmanga_episode",

    resolveSeed: (rawSeed, mangaId, episodeId, Tools) => {
      const charset = mangaId % 2 === 0 ? Tools.CHARSETS.KMANGA_EVEN : Tools.CHARSETS.KMANGA_ODD;
      return Tools.parseCharsetSeed(rawSeed, charset, mangaId, episodeId);
    },

    fetchApiFallback: async (episodeId, Utils) => {
      const P_ = async (e, t) => `${await sha256Hex(String(e ?? ""))}_${await sha512Hex(String(t ?? ""))}`;
      const n = await sha256Hex([await P_('episode_id', episodeId)].join(','));
      let bVal = "", eVal = "";
      try {
        const item = DOC.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('birthday='));
        if (item) {
          const parsed = JSON.parse(decodeURIComponent(item.substring(9)));
          bVal = String(parsed.value ?? parsed.id ?? "");
          eVal = parsed.expires ? String(parsed.expires) : "";
        }
      } catch (e) {}
      const hash = await sha512Hex(`${n}${await P_(bVal, eVal)}`);

      const apiUrl = `https://se-api.kmanga.kodansha.com/web/episode/viewer?episode_id=${episodeId}`;
      const buf = await Utils.fetchBuffer(apiUrl, {
        'Accept': '*/*',
        'X-Kmanga-Hash': hash,
        'X-Kmanga-Is-Crawler': 'false',
        'X-Kmanga-Platform': '3',
        'Origin': 'https://kmanga.kodansha.com',
        'Referer': WIN.location.href
      });
      return JSON.parse(new TextDecoder().decode(buf));
    },

    getTitle: (fallbackId) => {
      const headerTtl = DOC.querySelector('h1.p-episode__header-ttl, .p-episode__header-ttl')?.textContent?.trim();
      return headerTtl ? cleanString(headerTtl) : `KManga_${fallbackId}`;
    }
  };

  // C. CIAO PLUS (Shogakukan)
  const CiaoPlusAdapter = {
    id: "ciaoplus",
    name: "Ciao Plus",
    engine: "BAMBI ENGINE",
    theme: { color: "#E84386", bg: "#ffffff", text: "#7D93D3", top: "89px" },

    isMatch: (url) => url.includes("ciao.shogakukan.co.jp") && /\/comics\/title\/\d+\/episode\/\d+/.test(new URL(url, WIN.location.href).pathname),

    getEpisodeId: () => WIN.location.pathname.match(/\/episode\/(\d+)/)?.[1] || "ciao_episode",

    resolveSeed: (rawSeed) => Number(rawSeed) >>> 0, // Ciao Plus dùng số nguyên trực tiếp

    fetchApiFallback: async (episodeId, Utils) => {
      const params = { version: "6.0.0", platform: "3", episode_id: String(episodeId) };
      const keys = Object.keys(params).sort();
      const arr = [];
      for (const k of keys) {
        arr.push(`${await sha256Hex(k)}_${await sha512Hex(String(params[k]))}`);
      }
      const hash = await sha512Hex(await sha256Hex(arr.join(',')));

      const apiUrl = `https://api.ciao.shogakukan.co.jp/web/episode/viewer?${new URLSearchParams(params).toString()}`;
      const buf = await Utils.fetchBuffer(apiUrl, {
        'Accept': 'application/json',
        'X-Bambi-Hash': hash,
        'X-Bambi-Is-Crawler': 'false'
      });
      return JSON.parse(new TextDecoder().decode(buf));
    },

    getTitle: (fallbackId) => {
      const s = DOC.querySelector('.p-episode__comic-ttl')?.textContent?.trim() || "";
      const e = DOC.querySelector('.p-episode__header-ttl')?.textContent?.trim() || "";
      return resolveCleanFileName(s, e, fallbackId);
    }
  };

  const ADAPTERS = [MagaPokeAdapter, KMangaAdapter, CiaoPlusAdapter];

  function resolveSiteAdapter() {
    const currentUrl = WIN.location.href;
    for (const adapter of ADAPTERS) {
      if (adapter.isMatch(currentUrl)) return adapter;
    }
    return null;
  }

  /* =========================================================================
   * 4. GIAO DIỆN UNIVERSAL UI 2 TẦNG
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;
    const adapter = state.currentAdapter || resolveSiteAdapter();

    if (typeof createUI === "function" && DOC.body && adapter) {
      const { theme, name, engine } = adapter;
      state.ui = createUI({
        storagePrefix: "bambi-dl",
        title: name,
        themeColor: theme.color,
        themeBg: theme.bg,
        titleColor: theme.text,
        topOffset: theme.top,
        defaultJpgText: "Xuất file JPG (mặc định PNG)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("bambi-dl:convert-jpeg", checked ? '1' : '0');
        }
      });

      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:${theme.text};letter-spacing:0.2px;">${name}</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px;">${engine}</div>
          `;
        }
      }
    }
    return state.ui;
  }

  /* =========================================================================
   * 5. ĐỒNG BỘ DANH MỤC TRANG & GIẢI MÃ TẬP TRUNG QUA BAMBITOOLS
   * ========================================================================= */
  async function syncChapterData() {
    const adapter = state.currentAdapter || resolveSiteAdapter();
    if (!adapter) return;
    state.currentAdapter = adapter;

    const currentEpId = adapter.getEpisodeId();
    if (!currentEpId || currentEpId.includes("episode")) return;

    // Chỉ xóa cache nếu data cũ không khớp với chương hiện tại
    if (state.capturedApiData && String(state.capturedApiData.episode_id) !== String(currentEpId)) {
      state.capturedApiData = null;
    }

    let apiData = state.capturedApiData;

    // =========================================================================
    // NGUYÊN TẮC VÀNG CHỐNG LỖI 3106: CHỜ GÓI TIN TỰ NHIÊN CỦA WEB TRONG 1500ms
    // Tuyệt đối KHÔNG tự ý gọi fetchApiFallback khi web đang tải!
    // =========================================================================
    if (!apiData) {
      const startWait = Date.now();
      while (Date.now() - startWait < 1500) {
        apiData = state.capturedApiData;
        if (apiData && String(apiData.episode_id) === String(currentEpId)) break;
        await sleep(100);
      }

      // CHỈ KHI NÀO SAU 1.5 GIÂY MÀ WEB VẪN CHƯA GỌI THÌ MỚI DÙNG FALLBACK
      if (!apiData || String(apiData.episode_id) !== String(currentEpId)) {
        const Utils = window.MangaUtils || globalThis.MangaUtils;
        try {
          apiData = await adapter.fetchApiFallback(currentEpId, Utils);
          if (apiData) state.capturedApiData = apiData;
        } catch (e) {}
      }
    }

    const rawPages = apiData?.page_list || apiData?.pages || apiData?.data?.page_list;
    if (!apiData || !Array.isArray(rawPages) || rawPages.length === 0) return;

    const allPages = [];
    const seenUrls = new Set();
    let prCount = 0;
    let mainPageNo = 1;

    // Ảnh quảng cáo trước chương
    const prevAds = apiData.previous_advertisement_list || [];
    if (Array.isArray(prevAds)) {
      for (const ad of prevAds) {
        const u = ad.image_url || ad.url || ad.src || ad.image;
        if (u && !seenUrls.has(u)) { seenUrls.add(u); prCount++; allPages.push({ isPR: true, prNo: prCount, url: u }); }
      }
    }

    // Trang chính
    for (const url of rawPages) {
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      if (url.includes('/static/ads/') || url.includes('/ads/')) {
        prCount++;
        allPages.push({ isPR: true, prNo: prCount, url });
      } else {
        allPages.push({ isPR: false, pageNo: mainPageNo++, url });
      }
    }

    // Ảnh quảng cáo sau chương
    const postAds = apiData.post_advertisement_list || [];
    if (Array.isArray(postAds)) {
      for (const ad of postAds) {
        const u = ad.image_url || ad.url || ad.src || ad.image;
        if (u && !seenUrls.has(u)) { seenUrls.add(u); prCount++; allPages.push({ isPR: true, prNo: prCount, url: u }); }
      }
    }

    allPages.forEach(p => { if (p.isPR) p.singlePR = (prCount === 1); });

    const Tools = window.BambiTools || globalThis.BambiTools;
    const mangaId = apiData.title_id || apiData.mangaId || 0;
    const finalSeed = adapter.resolveSeed(apiData.scramble_seed, mangaId, currentEpId, Tools);

    state.chapterData = {
      episodeId: String(currentEpId),
      seed: finalSeed,
      ver: apiData.scramble_ver ?? 2,
      pages: allPages
    };

    const ui = getUI();
    if (ui && !state.running) {
      ui.updateProgress({ completed: 0, total: allPages.length, status: "Sẵn sàng." });
    }
  }

  async function processBambiImage(item, seed, ver, isJpg) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    const Tools = window.BambiTools || globalThis.BambiTools;

    const rawBuffer = await Utils.fetchBuffer(item.url);

    // 1. Ảnh PR: Giữ nguyên mảng byte gốc từ CDN
    if (item.isPR) {
      const ext = Utils.detectExt(rawBuffer);
      const fileName = item.singlePR ? `PR.${ext}` : `PR_${item.prNo}.${ext}`;
      return { fileName, data: new Uint8Array(rawBuffer) };
    }

    // 2. Trang truyện chính: Dùng bộ giải mã BambiTools
    if (seed) {
      const img = await Utils.loadImage(rawBuffer);
      const { canvas } = Tools.descrambleBambiCanvas(img, seed, ver);
      const mimeType = isJpg ? 'image/jpeg' : 'image/png';
      const outExt = isJpg ? 'jpg' : 'png';
      const blob = await new Promise(r => canvas.toBlob(r, mimeType, CONFIG.JPEG_QUALITY));
      canvas.width = 0; canvas.height = 0;
      return { fileName: `${item.pageNo}.${outExt}`, data: new Uint8Array(await blob.arrayBuffer()) };
    }

    const ext = isJpg ? 'jpg' : 'png';
    return { fileName: `${item.pageNo}.${ext}`, data: new Uint8Array(rawBuffer) };
  }

  /* =========================================================================
   * 6. TIẾN TRÌNH TẢI CHÍNH (4 LUỒNG TRONG RAM)
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const adapter = state.currentAdapter;
    const ui = getUI();

    if (!adapter) return;
    if (!state.chapterData?.pages?.length) await syncChapterData();
    if (!state.chapterData?.pages?.length) {
      if (ui) ui.updateProgress({ status: "Lỗi: Không lấy được dữ liệu trang." });
      return;
    }

    state.running = true;
    if (ui) ui.setBusy(true);

    const { pages, seed, ver, episodeId } = state.chapterData;
    const totalPages = pages.length;
    const useJpeg = Boolean(state.convertJpeg);

    try {
      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      zip.addFile(`${episodeId}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map(item => () => processBambiImage(item, seed, ver, useJpeg));
      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res?.data) zip.addFile(res.fileName, res.data);
      }

      const zipName = `${adapter.getTitle(episodeId)}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (e) {
      console.error("[bambi-dl] Download failed:", e);
      if (ui) ui.updateProgress({ status: `Lỗi: ${e?.message || e}` });
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * 7. KHỞI CHẠY VÀ THEO DÕI SPA ROUTE
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

    await syncChapterData();
  }

  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute(() => {
      state.chapterData = null;
      state.running = false;

      // Nhận diện adapter của trang đích
      const adapter = resolveSiteAdapter();
      state.currentAdapter = adapter;
      const curEpId = adapter?.getEpisodeId();

      // Chỉ xóa capturedApiData nếu nó là của tập cũ, không xóa nhầm gói tin mới vừa hứng được
      if (state.capturedApiData && curEpId && String(state.capturedApiData.episode_id) !== String(curEpId)) {
        state.capturedApiData = null;
      }

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