// ==UserScript==
// @name         K MANGA Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      2.3.2
// @icon         https://kmanga.kodansha.com/favicon.ico
// @description  Tải manga chất lượng gốc trên K MANGA (Kodansha US) - Reverse-engineered SP(e) Hash & PRNG Xorshift 4x4.
// @author       anonymous & AI
// @match        https://kmanga.kodansha.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      kmanga.kodansha.com
// @connect      api.kmanga.kodansha.com
// @connect      se-api.kmanga.kodansha.com
// @connect      cdn.kmanga.kodansha.com
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function kMangaUniversalDownloader() {
  "use strict";

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 4,   // 4 luồng tải song song (chuẩn an toàn Kodansha)
    JPEG_QUALITY: 0.95   // Chất lượng xuất JPG nếu chọn
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("kmanga-dl:convert-jpeg") === '1',
    chapterData: null,
    capturedApiData: null,
    ui: null,
    lastEpisodeId: null
  };

  /* =========================================================================
   * 1. HOOK MAIN-WORLD ĐÓN ĐẦU GÓI TIN KHI CHUYỂN CHƯƠNG
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
            const rawPages = data?.page_list || data?.pages || data?.data?.page_list;
            if (data && Array.isArray(rawPages) && rawPages.length > 0) {
              state.capturedApiData = data;
              syncChapterData();
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
   * 2. GIAO DIỆN UNIVERSAL UI CHUẨN 2 TẦNG (TÔNG XANH KODANSHA)
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;
    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "kmanga-dl",
        title: "K MANGA",
        engine: "KODANSHA",
        themeColor: "#2563eb",
        themeBg: "#0b1739",
        titleColor: "#ffffff",
        topOffset: "92px",
        defaultJpgText: "Xuất file JPG (mặc định PNG)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("kmanga-dl:convert-jpeg", checked ? '1' : '0');
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
   * 3. BỘ BĂM X-KMANGA-HASH CHUẨN GỐC TỪ FILE entry-BYoa0u-R.js (SP & P_)
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

  async function P_(e, t) {
    const h1 = await sha256Hex(String(e ?? ""));
    const h2 = await sha512Hex(String(t ?? ""));
    return `${h1}_${h2}`;
  }

  function getCookieBirthdayExpires() {
    try {
      const cookies = DOC.cookie.split(';');
      for (const c of cookies) {
        const item = c.trim();
        if (item.startsWith('birthday=')) {
          const raw = decodeURIComponent(item.substring(9));
          const parsed = JSON.parse(raw);
          return {
            bVal: String(parsed.value ?? parsed.id ?? ""),
            eVal: parsed.expires ? String(parsed.expires) : ""
          };
        }
      }
    } catch (e) {}
    return { bVal: "", eVal: "" };
  }

  // Sao chép nguyên bản 100% thuật toán function SP(e) của K MANGA
  async function computeKmangaHash(params) {
    const t = Object.keys(params).sort();
    const r = [];
    for (const u of t) {
      r.push(await P_(u, params[u]));
    }
    const n = await sha256Hex(r.join(',')); // r.toString() trong JS tương đương r.join(',')

    const { bVal, eVal } = getCookieBirthdayExpires();
    const c = await P_(bVal, eVal);

    return await sha512Hex(`${n}${c}`);
  }

  async function fetchDirectApiFallback(episodeId) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    if (!Utils) return null;

    const hash = await computeKmangaHash({ episode_id: String(episodeId) });

    const apiHeaders = {
      'Accept': '*/*',
      'X-Kmanga-Hash': hash,
      'X-Kmanga-Is-Crawler': 'false',
      'X-Kmanga-Platform': '3',
      'Origin': 'https://kmanga.kodansha.com',
      'Referer': WIN.location.href
    };

    const apiUrl = `https://se-api.kmanga.kodansha.com/web/episode/viewer?episode_id=${episodeId}`;

    try {
      const buffer = await Utils.fetchBuffer(apiUrl, apiHeaders);
      const data = JSON.parse(new TextDecoder().decode(buffer));
      const rawPages = data?.page_list || data?.pages || data?.data?.page_list;
      if (Array.isArray(rawPages) && rawPages.length > 0) {
        return data;
      }
    } catch (e) {}

    return null;
  }

  /* =========================================================================
   * 4. BỘ HỖ TRỢ XỬ LÝ CHUỖI & TÊN FILE TIẾNG ANH CHUẨN
   * ========================================================================= */
  function isEpisodeUrl() {
    return /\/title\/\d+\/episode\/\d+/.test(WIN.location.pathname) || /\/episode\/\d+/.test(WIN.location.pathname);
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
    const match = WIN.location.pathname.match(/\/episode\/(\d+)/);
    return match ? match[1] : "kmanga_episode";
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

  // BẮT BUỘC: [Tên Truyện] - [Tên Tập/Chap].zip (Ví dụ: Witch Hat Atelier - Chapter 3.zip)
  function getCleanTitle() {
    try {
      const headerTtl = DOC.querySelector('h1.p-episode__header-ttl, .p-episode__header-ttl')?.textContent?.trim();
      if (headerTtl) {
        return cleanString(headerTtl);
      }
    } catch (e) {}
    return `KManga_${getEpisodeId()}`;
  }

  /* =========================================================================
   * 5. TỔNG HỢP DANH SÁCH TRANG TỪ API (0MS TỨC THÌ)
   * ========================================================================= */
  async function syncChapterData() {
    const currentEpId = getEpisodeId();
    if (!currentEpId || currentEpId.includes("episode")) return;

    const ui = getUI();

    try {
      if (state.capturedApiData && String(state.capturedApiData.episode_id) !== String(currentEpId)) {
        state.capturedApiData = null;
      }

      let apiData = state.capturedApiData;

      // 1. Kéo trực tiếp từ API bằng hàm băm chuẩn gốc SP(e) nếu chưa có data từ hook
      if (!apiData) {
        apiData = await fetchDirectApiFallback(currentEpId);
        if (apiData) state.capturedApiData = apiData;
      }

      // 2. Dự phòng ngắn 800ms nếu mạng đang tải
      if (!apiData) {
        await sleep(800);
        apiData = state.capturedApiData;
        if (!apiData || String(apiData.episode_id) !== String(currentEpId)) {
          apiData = await fetchDirectApiFallback(currentEpId);
          if (apiData) state.capturedApiData = apiData;
        }
      }

      const rawPages = apiData?.page_list || apiData?.pages || apiData?.data?.page_list;
      if (!apiData || !Array.isArray(rawPages) || rawPages.length === 0) return;

      const allPages = [];
      let prCount = 0;
      let mainPageNo = 1;

      // Nạp toàn bộ trang truyện chính từ API
      for (const url of rawPages) {
        const isAdUrl = url.includes('/static/ads/') || url.includes('/ads/');
        if (isAdUrl) {
          prCount++;
          allPages.push({ isPR: true, prNo: prCount, url });
        } else {
          allPages.push({ isPR: false, pageNo: mainPageNo++, url });
        }
      }

      // Nạp ảnh quảng cáo thương mại từ post_advertisement_list nếu có
      const postAds = apiData.post_advertisement_list || data.data?.post_advertisement_list;
      if (Array.isArray(postAds)) {
        for (const ad of postAds) {
          const adUrl = ad.image_url || ad.url || ad.src || ad.image;
          if (adUrl && !allPages.some(p => p.url === adUrl)) {
            prCount++;
            allPages.push({ isPR: true, prNo: prCount, url: adUrl });
          }
        }
      }

      allPages.forEach(p => {
        if (p.isPR) p.singlePR = (prCount === 1);
      });

      state.chapterData = {
        episodeId: String(apiData.episode_id || currentEpId),
        mangaId: apiData.title_id || apiData.mangaId || 0,
        seed: apiData.scramble_seed || apiData.seed || "",
        ver: apiData.scramble_ver ?? -1,
        pages: allPages
      };

      state.lastEpisodeId = currentEpId;

      if (ui && !state.running) {
        // CẬP NHẬT TRỰC TIẾP 0MS KHI CÓ DỮ LIỆU
        ui.updateProgress({
          completed: 0,
          total: allPages.length,
          status: "Sẵn sàng."
        });
      }
    } catch (err) {
      console.error("[kmanga-dl] syncChapterData error:", err);
    }
  }

  /* =========================================================================
   * 6. THUẬT TOÁN GIẢI MÃ MA TRẬN PRNG XORSHIFT32 CHO K MANGA
   * ========================================================================= */
  const CHARSET_EVEN = "we7ru3ty8i"; // Bảng mã đặc thù K MANGA
  const CHARSET_ODD  = "h4xm9bqz1p"; // Bảng mã đặc thù K MANGA
  const MULTIPLE_NUM = 8;
  const GRID_SIZE    = 4;

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

  async function descrambleKMangaImage(rawBuffer, seed, ver, mangaId, episodeId, isJpg) {
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
   * 7. TIẾN TRÌNH TẢI CHÍNH (4 LUỒNG TRONG RAM)
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    if (!state.chapterData?.pages?.length) {
      await syncChapterData();
    }

    if (!state.chapterData?.pages?.length) {
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

      const currentEpId = getEpisodeId();
      zip.addFile(`${currentEpId}.txt`, new Uint8Array(0));

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map((item) => async () => {
        const rawBuffer = await Utils.fetchBuffer(item.url);

        if (item.isPR) {
          const ext = getExtensionFromUrl(item.url);
          const fileName = item.singlePR ? `PR.${ext}` : `PR_${item.prNo}.${ext}`;
          return { fileName, data: new Uint8Array(rawBuffer) };
        }

        if (seed) {
          const decoded = await descrambleKMangaImage(rawBuffer, seed, ver, mangaId, episodeId, useJpeg);
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
      console.error("[kmanga-dl] Download failed", e);
      if (ui) ui.updateProgress({ status: `Lỗi: ${e?.message || e}` });
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * 8. KHỞI CHẠY VÀ THEO DÕI SPA ROUTE
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

  // Hook SPA Router (Tự động reset 0/0 Đang kiểm tra... khi đổi URL chương)
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