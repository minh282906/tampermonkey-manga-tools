// ==UserScript==
// @name         PocketShonenMagazine Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      2.0.0
// @icon         https://pocket.shonenmagazine.com/img/favicon.ico
// @description  Tải manga trên MagaPoke (pocket.shonenmagazine.com) - Single-Flight Fetch Hook, X-Manga-Hash & PRNG Xorshift 4x4.
// @author       Fuku & anonymous & AI
// @match        https://pocket.shonenmagazine.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      pocket.shonenmagazine.com
// @connect      api.pocket.shonenmagazine.com
// @connect      se-api.pocket.shonenmagazine.com
// @connect      mgpk-cdn.magazinepocket.com
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function pocketShonenDownloader() {
  "use strict";

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 4,   // 4 luồng tải song song
    JPEG_QUALITY: 0.95   // Chất lượng xuất JPG nếu chọn
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("pocket-dl:convert-jpeg") === '1',
    chapterData: null,
    capturedApiData: null,
    ui: null,
    lastEpisodeId: null
  };

  /* =========================================================================
   * 1. SINGLE-FLIGHT FETCH HOOK (CHỐNG LỖI 3106)
   * ========================================================================= */
  function installFetchHook() {
    const targetWindow = WIN;
    const origFetch = targetWindow.fetch;
    if (!origFetch || origFetch.__manga_hooked) return;

    const hookedFetch = async function(...args) {
      const response = await origFetch.apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        if (url.includes('/web/episode/viewer')) {
          const clone = response.clone();
          clone.json().then(data => {
            if (data && Array.isArray(data.page_list) && data.page_list.length > 0) {
              state.capturedApiData = data;
              const curId = getEpisodeId();
              // Chỉ kích hoạt sync khi ID gói tin khớp với URL hiện tại
              if (String(data.episode_id) === String(curId)) {
                syncChapterData();
              }
            }
          }).catch(() => {});
        }
      } catch (e) {}
      return response;
    };

    hookedFetch.__manga_hooked = true;
    targetWindow.fetch = hookedFetch;
  }

  installFetchHook();

  /* =========================================================================
   * 2. GIAO DIỆN UNIVERSAL UI 2 TẦNG
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;
    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "pocket-dl",
        title: "MagaPoke",
        engine: "KODANSHA",
        themeColor: "#2563eb",
        themeBg: "#0b1739",
        titleColor: "#ffffff",
        topOffset: "92px",
        defaultJpgText: "Xuất file JPG (mặc định PNG)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("pocket-dl:convert-jpeg", checked ? '1' : '0');
        }
      };

      state.ui = createUI(uiConfig);

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
   * 3. BỘ BĂM X-MANGA-HASH DỰ PHÒNG (NATIVE CRYPTO.SUBTLE)
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

  async function computeMangaHash(params) {
    const keys = Object.keys(params).sort();
    const arr = [];
    for (const key of keys) {
      const kHash = await sha256Hex(key);
      const vHash = await sha512Hex(String(params[key]));
      arr.push(`${kHash}_${vHash}`);
    }
    const part1 = await sha256Hex(arr.join(','));
    const empty256 = await sha256Hex('');
    const empty512 = await sha512Hex('');
    const part2 = `${empty256}_${empty512}`;
    return await sha512Hex(`${part1}${part2}`);
  }

  async function fetchDirectApiFallback(episodeId) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    if (!Utils) return null;

    const apiUrl = `https://se-api.pocket.shonenmagazine.com/web/episode/viewer?episode_id=${episodeId}`;
    const hash = await computeMangaHash({ episode_id: episodeId });

    const apiHeaders = {
      'Accept': 'application/json',
      'X-Manga-Hash': hash,
      'X-Manga-Is-Crawler': 'false',
      'X-Manga-Platform': '3'
    };

    try {
      const buffer = await Utils.fetchBuffer(apiUrl, apiHeaders);
      return JSON.parse(new TextDecoder().decode(buffer));
    } catch (e) {
      return null;
    }
  }

  /* =========================================================================
   * 4. BỘ XỬ LÝ CHUỖI & TIÊU ĐỀ CHUẨN [Tên Truyện] - [Tên Chap]
   * ========================================================================= */
  function isEpisodeUrl() {
    return /\/episode\/\d+/.test(WIN.location.pathname);
  }

  function cleanString(str) {
    if (!str) return "";
    return str
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/[\\/*?:"<>|]/g, '')
      .trim();
  }

  function getEpisodeId() {
    const match = WIN.location.pathname.match(/\/episode\/(\d+)/);
    return match ? match[1] : "pocket_episode";
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

  function getCleanTitle() {
    try {
      let seriesTitle = "";
      let episodeTitle = "";

      const sEl = DOC.querySelector('.p-episode__comic-ttl, .p-episode__header-series-ttl, .p-series__ttl, [class*="series-ttl"], .p-episode__series-title');
      if (sEl) seriesTitle = sEl.textContent.trim();

      const eEl = DOC.querySelector('h2.p-episode__header-ttl, .p-episode__header-ttl, [class*="episode-ttl"], .p-episode__title');
      if (eEl) episodeTitle = eEl.textContent.trim();

      if (!seriesTitle || !episodeTitle) {
        let raw = (DOC.title || "").split(/[|｜]/)[0].trim();
        raw = raw.replace(/^公式\s*[-－_]?\s*/i, '').trim();

        const match = raw.match(/^(.*?)(?:\s+[-－–—]\s+|\s+)((?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\s\-\–\—\ー\~〜\.]+(?:話|巻|章|節|部|エピソード|分冊版|単話|前編|中編|後編)?.*)$/i);
        if (match) {
          if (!seriesTitle) seriesTitle = match[1];
          if (!episodeTitle) episodeTitle = match[2];
        } else {
          if (!seriesTitle) seriesTitle = raw;
          if (!episodeTitle) episodeTitle = getEpisodeId();
        }
      }

      episodeTitle = episodeTitle.replace(/【(?:期間限定|無料|マガポケ限定|単行本|デジタル版)[^】]*】/gi, '').trim();

      episodeTitle = episodeTitle
        .replace(/【\s*((?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\.]+\s*(?:話|巻|章|節|部|エピソード|分冊版|単話)?)\s*】/gi, '$1\u3000')
        .replace(/[\[\]「」『』【】]/g, '')
        .trim();

      let cleanSeries = cleanString(seriesTitle);
      cleanSeries = cleanSeries.replace(/（[^）]*(?:コミック|文庫|レーベル|出版|COMIC|WEB)[^）]*）$/i, '').trim();
      cleanSeries = cleanSeries.replace(/\([^)]*(?:コミック|文庫|レーベル|出版|COMIC|WEB)[^)]*\)$/i, '').trim();

      let cleanEpisode = cleanString(episodeTitle);

      // Cắt bỏ phần tên truyện nếu bị lặp lại bên trong episodeTitle
      let baseWithoutVol = cleanSeries.replace(/\s*[0-9０-９]+\s*巻.*$/i, '').trim();
      if (baseWithoutVol && cleanEpisode.startsWith(baseWithoutVol)) {
        cleanEpisode = cleanString(cleanEpisode.substring(baseWithoutVol.length));
      }

      cleanEpisode = cleanEpisode.replace(/^[・･\s\-_:：\u3000]+/, '').trim();

      if (cleanSeries && cleanEpisode && cleanEpisode !== getEpisodeId() && !cleanSeries.includes(cleanEpisode)) {
        return `${cleanSeries} - ${cleanEpisode}`;
      } else if (cleanSeries && cleanEpisode && cleanEpisode !== getEpisodeId()) {
        return cleanEpisode;
      } else if (cleanSeries) {
        return `${cleanSeries} - ${getEpisodeId()}`;
      }
    } catch (e) {}

    return `Pocket_${getEpisodeId()}`;
  }

  /* =========================================================================
   * 5. BÓC TÁCH TOÀN BỘ ẢNH PR (ĐỢI RENDER ĐỦ 100%)
   * ========================================================================= */
  async function waitForAllDomPrImages(maxWaitMs = 2500) {
    const startTime = Date.now();
    let prList = [];

    while (Date.now() - startTime < maxWaitMs) {
      // 1. Ảnh quảng cáo thương mại đầu trang
      const topEls = DOC.querySelectorAll('.c-viewer__comic img, img[src*="/static/ads/"], img[src*="/ads/"]');

      // 2. Toàn bộ ảnh thương mại & banner cuối trang (c-viewer__last-items)
      const endEls = DOC.querySelectorAll('.c-viewer__last-items img, .c-viewer__recommend-item img, .c-viewer__last img, .p-episode__end-banner img, .p-viewer__end img');

      const currentList = [];
      for (const img of [...topEls, ...endEls]) {
        let src = img.getAttribute('data-src') || img.getAttribute('src') || '';
        if (!src || src.startsWith('data:')) continue;
        if (src.startsWith('//')) src = 'https:' + src;
        if (!currentList.includes(src)) currentList.push(src);
      }

      // ĐIỀU KIỆN CHỐNG THOÁT SỚM: Phải có cụm cuối (endEls >= 3 ảnh) VÀ tổng số PR >= 4 ảnh
      if (endEls.length >= 3 && currentList.length >= 4) {
        return currentList;
      }

      prList = currentList;
      await sleep(150);
    }

    // Dự phòng sau 2.5s nếu chương thực sự không có cụm cuối
    return prList;
  }

  /* =========================================================================
   * 6. TỔNG HỢP TRANG TRUYỆN
   * ========================================================================= */
  async function syncChapterData() {
    const currentEpId = getEpisodeId();
    if (!currentEpId || currentEpId.includes("episode")) return;

    // Kiểm tra tính hợp lệ của API Data (tránh dính ID của chap cũ khi đổi URL)
    if (state.capturedApiData && String(state.capturedApiData.episode_id) !== String(currentEpId)) {
      state.capturedApiData = null;
    }

    let apiData = state.capturedApiData;

    // Nếu hook chưa bắt được, đợi 1s rồi gọi fallback bằng X-Manga-Hash
    if (!apiData) {
      await sleep(1000);
      apiData = state.capturedApiData;
      if (!apiData || String(apiData.episode_id) !== String(currentEpId)) {
        apiData = await fetchDirectApiFallback(currentEpId);
        if (apiData) state.capturedApiData = apiData;
      }
    }

    if (!apiData || !Array.isArray(apiData.page_list) || apiData.page_list.length === 0) return;

    // Đợi DOM render đủ 100% cụm ảnh PR
    const domPrs = await waitForAllDomPrImages(2500);

    const allPages = [];
    let prCount = 0;
    let mainPageNo = 1;

    // 1. Nạp ảnh PR thương mại
    for (const prUrl of domPrs) {
      const inMain = apiData.page_list.some(pUrl => pUrl.includes(prUrl.split('?')[0]));
      if (!inMain) {
        prCount++;
        allPages.push({ isPR: true, prNo: prCount, url: prUrl });
      }
    }

    // 2. Nạp trang truyện chính từ API
    for (const url of apiData.page_list) {
      const isAdUrl = url.includes('/static/ads/') || url.includes('/ads/');
      if (isAdUrl) {
        prCount++;
        allPages.push({ isPR: true, prNo: prCount, url: url });
      } else {
        allPages.push({ isPR: false, pageNo: mainPageNo++, url: url });
      }
    }

    allPages.forEach(p => {
      if (p.isPR) p.singlePR = (prCount === 1);
    });

    state.chapterData = {
      episodeId: apiData.episode_id || currentEpId,
      mangaId: apiData.title_id,
      seed: apiData.scramble_seed,
      ver: apiData.scramble_ver,
      pages: allPages
    };

    state.lastEpisodeId = currentEpId;

    const ui = getUI();
    if (ui && !state.running) {
      ui.updateProgress({
        completed: 0,
        total: allPages.length,
        status: "Sẵn sàng."
      });
    }
  }

  /* =========================================================================
   * 7. THUẬT TOÁN GIẢI MÃ MA TRẬN PRNG XORSHIFT32
   * ========================================================================= */
  const CHARSET_EVEN = "svdk0m7acl";
  const CHARSET_ODD = "q6jtf2xnog";
  const MULTIPLE_NUM = 8;
  const GRID_SIZE = 4;

  function* xorshift(seed) {
    const x = Uint32Array.of(seed);
    while (true) {
      x[0] ^= x[0] << 13;
      x[0] ^= x[0] >>> 17;
      x[0] ^= x[0] << 5;
      yield x[0];
    }
  }

  function ShuffleArrayWithPRNG(array, seed) {
    const t = xorshift(seed);
    return array
      .map((r) => [t.next().value, r])
      .sort((r, i) => +(r[0] > i[0]) - +(i[0] > r[0]))
      .map((r) => r[1]);
  }

  function GenerateScrambleMapping(gridSize, seed) {
    const indices = [...Array(gridSize ** 2)].map((_, r) => r);
    const shuffled = ShuffleArrayWithPRNG(indices, seed);

    return shuffled.map((s, r) => ({
      source: { x: s % gridSize, y: Math.floor(s / gridSize) },
      dest: { x: r % gridSize, y: Math.floor(r / gridSize) },
    }));
  }

  function ComputeGridBlockDimensions(width, height, gridSize) {
    if (width < gridSize * MULTIPLE_NUM || height < gridSize * MULTIPLE_NUM) return null;
    const s = Math.floor(width / MULTIPLE_NUM);
    const r = Math.floor(height / MULTIPLE_NUM);
    const i = Math.floor(s / gridSize);
    const c = Math.floor(r / gridSize);
    return {
      width: i * MULTIPLE_NUM,
      height: c * MULTIPLE_NUM,
    };
  }

  function ComputeSeed32(seed, charset, titleId, episodeId) {
    let parsedInt = 0n;
    for (const char of seed) {
      const index = charset.indexOf(char);
      if (index !== -1) {
        parsedInt = parsedInt * 10n + BigInt(index);
      } else {
        break;
      }
    }
    const parsedUInt32 = Number(parsedInt & 0xffffffffn);
    const combined = (titleId >>> 0) + (episodeId >>> 0);
    return (parsedUInt32 ^ combined) >>> 0;
  }

  async function descramblePocketImage(rawBuffer, seed, ver, mangaId, episodeId, isJpg) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    const img = await Utils.loadImage(rawBuffer);

    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;

    const canvas = DOC.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    let finalSeed = seed;
    if (typeof seed === "string") {
      const charset = mangaId % 2 === 0 ? CHARSET_EVEN : CHARSET_ODD;
      finalSeed = ComputeSeed32(seed, charset, mangaId, episodeId);
    }

    const dimensions = ComputeGridBlockDimensions(width, height, GRID_SIZE);

    if (!dimensions) {
      ctx.drawImage(img, 0, 0);
    } else {
      ctx.drawImage(img, 0, 0);
      const mapping = GenerateScrambleMapping(GRID_SIZE, finalSeed);

      for (const c of mapping) {
        ctx.drawImage(
          img,
          c.source.x * dimensions.width,
          c.source.y * dimensions.height,
          dimensions.width,
          dimensions.height,
          c.dest.x * dimensions.width,
          c.dest.y * dimensions.height,
          dimensions.width,
          dimensions.height
        );
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
   * 8. TIẾN TRÌNH TẢI CHÍNH (4 LUỒNG TRONG RAM)
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    if (!state.chapterData?.pages?.length) {
      await syncChapterData();
    }

    if (!state.chapterData?.pages?.length) {
      if (ui) ui.updateProgress({ status: "Chưa có dữ liệu trang." });
      return;
    }

    state.running = true;
    if (ui) ui.setBusy(true);

    const { pages, seed, ver, mangaId, episodeId } = state.chapterData;
    const totalPages = pages.length;
    const useJpeg = Boolean(state.convertJpeg);

    try {
      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // File rỗng ID định danh tại thư mục gốc ZIP
      const currentEpId = getEpisodeId();
      zip.addFile(`${currentEpId}.txt`, new Uint8Array(0));

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map((item) => async () => {
        const rawBuffer = await Utils.fetchBuffer(item.url);

        // 1. Ảnh PR: Giữ nguyên bytes gốc zero-copy từ CDN
        if (item.isPR) {
          const ext = getExtensionFromUrl(item.url);
          const fileName = item.singlePR ? `PR.${ext}` : `PR_${item.prNo}.${ext}`;
          return { fileName, data: new Uint8Array(rawBuffer) };
        }

        // 2. Trang truyện chính: Giải mã ma trận hoán vị PRNG Xorshift 4x4
        if (seed) {
          const decoded = await descramblePocketImage(rawBuffer, seed, ver, mangaId, episodeId, useJpeg);
          return {
            fileName: `${item.pageNo}.${decoded.ext}`,
            data: decoded.data
          };
        } else {
          const ext = useJpeg ? 'jpg' : 'png';
          return {
            fileName: `${item.pageNo}.${ext}`,
            data: new Uint8Array(rawBuffer)
          };
        }
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
    } catch (e) {
      console.error("[pocket-dl] Download failed", e);
      if (ui) ui.updateProgress({ status: `Lỗi: ${e?.message || e}` });
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * 9. KHỞI CHẠY VÀ THEO DÕI SPA ROUTE
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

    await syncChapterData();
  }

  // Hook SPA History Change
  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute(() => {
      state.chapterData = null;
      state.capturedApiData = null;
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