// ==UserScript==
// @name         MangaMeets Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://manga-meets.jp/favicon.ico
// @description  Tải manga trên MangaMeets (manga-meets.jp) chuẩn Database JSON:API Zero-Copy 0ms.
// @author       anonymous & AI
// @match        https://manga-meets.jp/comics/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      manga-meets.jp
// @connect      *.manga-meets.jp
// @connect      res.cloudinary.com
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function mangaMeetsUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6   // 6 luồng Cloudinary CDN
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    chapterData: null,
    ui: null,
    lastUrl: "",
    lastEpisodeKey: ""
  };

  /* =========================================================================
   * 1. GIAO DIỆN THEME MANGAMEETS (HỒNG CORAL - TRẮNG SÁNG)
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "mangameets-dl",
        title: "MangaMeets",
        engine: "SHUEISHA",
        themeColor: "#ef9fc2",     
        themeBg: "#ffffff",         
        titleColor: "#ef9fc2",
        btnBg: "#ef9fc2",          
        btnColor: "#ffffff",
        topOffset: "188px",
        onDownload: startDownload
      }
      
      state.ui = createUI(uiConfig);
      state.ui.setBusy(true);

      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:${uiConfig.titleColor};letter-spacing:0.3px;">${uiConfig.title}</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px;visibility:hidden;">${uiConfig.engine}</div>
          `;
        }
      }
    }
    return state.ui;
  }

  /* =========================================================================
   * 2. BỘ HỖ TRỢ XỬ LÝ CHUỖI, URL & TIÊU ĐỀ
   * ========================================================================= */
  function isEpisodeUrl() {
    return /\/comics\/[^\/]+\/\d+/i.test(WIN.location.pathname);
  }

  function getRouteParams() {
    const parts = WIN.location.pathname.replace(/^\/comics\//i, '').split('/').filter(Boolean);
    const comicId = parts[0] || null;
    const episodeNo = parts[1] || null;
    return { comicId, episodeNo };
  }

  function cleanString(str) {
    if (!str) return "";
    return str
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/【(?!(?:フルカラー版|カラー版|完全版|特装版))[^】]*】/gi, '')
      .replace(/[\\/*?:"<>|]/g, '')
      .trim();
  }

  /* =========================================================================
   * 3. PHƯƠNG ÁN B: BÓC TÁCH CHUẨN JSON:API GỐC TỪ DATABASE (ORDER_INDEX)
   * ========================================================================= */
  function parseJsonApiPackage(json) {
    if (!json?.data) return null;
    const data = json.data;
    const included = json.included || [];

    // 1. Lấy Tên Bộ Truyện từ đối tượng comic trong included
    let seriesTitle = "";
    const comicItem = included.find(item => item.type === "comic");
    if (comicItem?.attributes?.title) {
      seriesTitle = cleanString(comicItem.attributes.title);
    }

    // 2. Lấy Tên Tập / Chap (kết hợp volume và title)
    const volume = cleanString(data.attributes?.volume || "");
    const epTitle = cleanString(data.attributes?.title || "");
    let chapterTitle = (volume && epTitle) ? `${volume} ${epTitle}` : (volume || epTitle || "");

    // 3. Tạo Map lưu trữ ID ảnh -> URL gốc thô trong Database (đổi http -> https)
    const imageMap = new Map();
    for (const item of included) {
      if (item.type === "image" && item.attributes?.url) {
        const rawUrl = item.attributes.url.replace(/^http:\/\//i, 'https://');
        imageMap.set(item.id, rawUrl);
      }
    }

    // 4. Ánh xạ các trang episode_page theo đúng trường order_index của tác giả
    const pageItems = [];
    for (const item of included) {
      if (item.type === "episode_page") {
        const imgId = item.relationships?.image?.data?.id;
        const order = Number(item.attributes?.order_index || 0);
        const url = imageMap.get(imgId);
        if (url) {
          pageItems.push({ order, url });
        }
      }
    }

    // Sắp xếp số học chuẩn: đảm bảo trang 1 -> 2 -> 3 chuẩn 100% không bao giờ bị đảo
    pageItems.sort((a, b) => a.order - b.order);

    const urls = pageItems.map(p => p.url);
    if (urls.length === 0) return null;

    let finalTitle = "";
    if (seriesTitle && chapterTitle) {
      if (seriesTitle === chapterTitle) finalTitle = seriesTitle;
      else finalTitle = `${seriesTitle} - ${chapterTitle}`;
    } else {
      finalTitle = seriesTitle || chapterTitle || `MangaMeets_${data.id || 'Episode'}`;
    }

    return {
      episodeId: data.id || "episode",
      seriesTitle,
      chapterTitle,
      title: finalTitle,
      urls
    };
  }

  async function fetchMangaMeetsManifest() {
    const { comicId, episodeNo } = getRouteParams();
    if (!comicId || !episodeNo) return null;

    const Utils = window.MangaUtils || globalThis.MangaUtils;
    let targetJson = null;

    // 1. FAST PATH 0ms: Đọc trực tiếp từ bộ nhớ RAM nếu có sẵn trong __NEXT_DATA__
    const pageProps = WIN.__NEXT_DATA__?.props?.pageProps;
    if (pageProps?.data?.type === "episode" && pageProps?.included) {
      targetJson = pageProps;
    }

    // 2. Kéo trực tiếp file [number].json từ API nội bộ (chuẩn 100% không qua proxy)
    if (!targetJson) {
      const endpoints = [
        `https://manga-meets.jp/api/comics/${comicId}/episodes/${episodeNo}.json`,
        `https://manga-meets.jp/comics/${comicId}/${episodeNo}.json`
      ];

      for (const url of endpoints) {
        try {
          const buf = await Utils.fetchBuffer(url, { "Accept": "application/json" });
          const parsed = JSON.parse(new TextDecoder().decode(buf));
          if (parsed?.data && parsed?.included) {
            targetJson = parsed;
            break;
          }
        } catch (e) {}
      }
    }

    // 3. Fallback qua viewer.json nếu 2 endpoint trên bị chặn
    if (!targetJson) {
      try {
        const buf = await Utils.fetchBuffer(`https://manga-meets.jp/api/comics/${comicId}/episodes/${episodeNo}/viewer.json`);
        const vJson = JSON.parse(new TextDecoder().decode(buf));
        if (vJson?.episode_pages?.length) {
          // Bóc tách theo viewer.json và gọt bỏ mọi tham số Cloudinary
          const cleanUrls = vJson.episode_pages.map(p => {
            const raw = p.image?.original_url || p.image?.pc_url || "";
            return raw.replace(/\/image\/upload\/.*?\/(v\d+\/)/, '/image/upload/$1').replace(/^http:\/\//i, 'https://');
          }).filter(Boolean);

          const vol = cleanString(vJson.volume || "");
          const epT = cleanString(vJson.title || "");
          const cTitle = (vol && epT) ? `${vol} ${epT}` : (vol || epT);
          const sTitle = cleanString(vJson.comic?.title || "");

          return {
            episodeId: vJson.id || episodeNo,
            title: (sTitle && cTitle) ? `${sTitle} - ${cTitle}` : (sTitle || cTitle),
            urls: cleanUrls
          };
        }
      } catch (e) {}
    }

    return parseJsonApiPackage(targetJson);
  }

  /* =========================================================================
   * 4. TIẾN TRÌNH TẢI CHÍNH & ZERO-COPY 0MS VÀO ZIP
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let data = state.chapterData;
      if (!data || !data.urls?.length) {
        data = await fetchMangaMeetsManifest();
        state.chapterData = data;
      }

      if (!data || !data.urls?.length) throw new Error("Không thể trích xuất danh sách trang.");

      const { urls, title, episodeId } = data;
      const totalPages = urls.length;

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // File định danh ID chương theo
      zip.addFile(`${episodeId}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      // Hàng đợi tải 6 luồng từ Cloudinary
      const tasks = urls.map((url, idx) => async () => {
        let rawBuffer = null;

        try {
          const res = await WIN.fetch(url);
          if (res.ok) rawBuffer = await res.arrayBuffer();
        } catch (e) {}

        if (!rawBuffer) {
          rawBuffer = await Utils.fetchBuffer(url, { "Referer": "https://manga-meets.jp/" });
        }

        const rawUint8 = new Uint8Array(rawBuffer);
        const ext = Utils.detectExt(rawBuffer);

        return { fileName: `${idx + 1}.${ext}`, data: rawUint8 };
      });

      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res?.data) zip.addFile(res.fileName, res.data);
      }

      const zipName = `${title}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[mangameets-dl] Download error:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * 5. KHỞI CHẠY & THEO DÕI ĐIỀU HƯỚNG SPA
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
      ui.setBusy(true);
      ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
    }

    try {
      const { comicId, episodeNo } = getRouteParams();
      if (!comicId || !episodeNo) {
        throw new Error("Không tìm thấy ID chương.");
      }

      const data = await fetchMangaMeetsManifest();
      if (!data || !data.urls?.length) {
        throw new Error("Không lấy được danh sách trang.");
      }
      state.chapterData = data;

      const testUrl = data.urls[0]; // bên này dùng data.urls[0]
      if (!testUrl) throw new Error("URL trang 1 không hợp lệ.");

      const Utils = window.MangaUtils || globalThis.MangaUtils;
      let testBuf = null;
      try {
        const res = await WIN.fetch(testUrl);
        if (res.ok) testBuf = await res.arrayBuffer();
      } catch (e) {}

      if (!testBuf) {
        testBuf = await Utils.fetchBuffer(testUrl, { "Referer": "https://manga-meets.jp/" });
      }

      const realExt = Utils.detectExt(testBuf);
      if (!realExt) {
        throw new Error("Không thể nhận diện Magic Bytes ảnh.");
      }
      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: data.urls.length,
          status: "Sẵn sàng.",
          format: realExt
        });
        ui.setBusy(false)
      }
    } catch (e) {
      console.error("[mangameets-dl] Boot error:", e);
      if (ui) {
        ui.updateProgress({ status: "Lỗi: " + (e?.message || "không thể tải trang.") });
        ui.setBusy(true);
      }
    }
  }

  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute((newUrl) => {

      // Thoát ra ngoài trang đọc -> Ẩn panel
      if (!isEpisodeUrl()) {
        const ui = getUI();
        if (ui?.panel) ui.panel.style.display = "none";
        state.chapterData = null;
        state.lastEpisodeKey = "";
        state.lastUrl = "";
        state.running = false;
        return;
      }

      const { comicId, episodeNo } = getRouteParams();
      const currentKey = `${comicId}/${episodeNo}`;

      if (state.lastEpisodeKey && state.lastEpisodeKey === currentKey) return;

      state.lastUrl = newUrl;
      state.lastEpisodeKey = currentKey;
      state.chapterData = null;
      state.running = false;

      const ui = getUI();
      if (ui) {
        ui.setBusy(true);
        ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
      }
      boot();
    });
  }
  boot();
})();