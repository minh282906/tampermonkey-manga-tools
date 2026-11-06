// ==UserScript==
// @name         Sai-Zen-Sen Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://sai-zen-sen.jp/favicon.ico
// @description  Tải manga trên 最前線 / Sai-Zen-Sen (sai-zen-sen.jp).
// @author       anonymous & AI
// @match        https://sai-zen-sen.jp/comics/twi4/*
// @match        https://sai-zen-sen.jp/works/comics/*
// @match        https://sai-zen-sen.jp/special/4pages-comics/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      sai-zen-sen.jp
// @connect      www.sai-zen-sen.jp
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN ---
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/SaiZenSenDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/SaiZenSenDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function saiZenSenUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6   // 6 luồng tải song song (TCP Socket)
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
    lastRouteKey: ""
  };

  /* =========================================================================
   * 1. GIAO DIỆN THEME THEO PHÂN NHÁNH (TWI4 XANH CYAN VS BIBI ĐỎ SEIKAISHA)
   * ========================================================================= */
  function resolveTheme() {
    const p = WIN.location.pathname;
    if (p.includes('/comics/twi4/')) {
      return {
        title: "ツイ４",
        engine: "SEIKAISHA",
        color: "#479EE3",
        bg: "#ffffff",
        text: "#479EE3",
        top: "50px",
        prefix: "twi4-dl"
      };
    }
    if (p.includes('/special/4pages-comics/')) {
      return {
        title: "4PAGES",
        engine: "SEIKAISHA",
        color: "#F4C852",
        bg: "#ffffff",
        text: "#78C5F8",
        top: "70px",
        prefix: "4pcomics-dl"
      };
    }
    return {
      title: "最前線 Comics",
      engine: "SEIKAISHA",
      color: "#D02F2E",
      bg: "#ffffff",
      text: "#D02F2E",
      top: "70px",
      prefix: "saizenshen-dl"
    };
  }

  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const theme = resolveTheme();

      const uiConfig = {
        storagePrefix: theme.prefix,
        title: theme.title,
        engine: theme.engine,
        themeColor: theme.color,
        themeBg: theme.bg,
        titleColor: theme.text,
        btnBg: theme.color,
        btnColor: "#ffffff",
        tabBg: theme.color,
        tabColor: "#ffffff",
        topOffset: theme.top,
        onDownload: startDownload
      };

      state.ui = createUI(uiConfig);
      state.ui.setBusy(true);

      // Header 2 tầng (Dòng 1: Tên Phân Hệ, Dòng 2: SEIKAISHA)
      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:900 13px/1.2 system-ui,sans-serif;color:${uiConfig.titleColor};letter-spacing:0.3px;">${uiConfig.title}</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px;">${uiConfig.engine}</div>
          `;
        }
      }
    }
    return state.ui;
  }

  /* =========================================================================
   * 2. BỘ HỖ TRỢ XỬ LÝ CHUỖI, URL & TIÊU ĐỀ
   * ========================================================================= */
  function isSupportedUrl() {
    const p = WIN.location.pathname;

    // 1. Chặn trang danh mục Twi4 (không có slug truyện)
    if (/^\/comics\/twi4\/?$/i.test(p)) return false;

    // 2. Nhánh Twi4 Reader (bắt buộc có slug phía sau)
    if (/\/comics\/twi4\/[^\/?#]+/i.test(p)) return true;

    // 3. Nhánh BiBi & Legacy Reader
    if (/\/works\/comics\/[^\/]+\/\d+\/\d+\.html/i.test(p)) return true;

    // 4. Nhánh 4-Pages Comics Special
    if (/\/special\/4pages-comics\/[^\/]+\/\d+\.html/i.test(p)) return true;

    return false;
  }

  function getTwi4Slug(urlStr) {
    const pathname = urlStr ? new URL(urlStr, WIN.location.origin).pathname : WIN.location.pathname;
    const m = pathname.match(/\/comics\/twi4\/([^\/?#]+)/i);
    return m ? m[1] : null;
  }

  function cleanString(str) {
    if (!str) return "";
    return str
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/【(?!(?:フルカラー版|カラー版|完全版|特装版))[^】]*】/gi, '')
      .replace(/[\\/*?:"<>|]/g, '')  // Lọc sạch ký tự cấm hệ điều hành
      .trim();
  }

  /* =========================================================================
   * 3A. BÓC TÁCH PHÂN NHÁNH 1: TWI4 (TWITTER 4-KOMA)
   * ========================================================================= */
  async function fetchTwi4Manifest(slug) {
    let meta = WIN.t4?.Meta;

    // Dự phòng kéo trực tiếp index.js nếu script của trang chưa kịp nạp vào RAM
    if (!meta || meta.ID !== slug) {
      try {
        const res = await WIN.fetch(`https://sai-zen-sen.jp/comics/twi4/${slug}/index.js`, { cache: 'no-store' });
        if (res.ok) {
          const code = await res.text();
          const metaFn = new Function(`let t4 = {}; ${code}; return t4.Meta;`);
          meta = metaFn();
        }
      } catch (e) {}
    }

    if (!meta || !Array.isArray(meta.Items) || !meta.Items.length) {
      throw new Error("Không lấy được dữ liệu cấu hình t4.Meta từ index.js.");
    }

    const { Title, ID, TotalEpisodes, PublishingRange, Items } = meta;
    const startSide = Number(PublishingRange?.StartSide) || 0;
    const endSide = Number(PublishingRange?.EndSide) || 0;
    const total = Number(TotalEpisodes) || Items.length;

    const pages = [];

    // Ánh xạ mảng Items: Chỉ bốc các tập còn mở quyền đọc (bỏ qua dải đã đóng paywall)
    Items.forEach((item, idx) => {
      let epNum = idx + 1;
      if (startSide > 0 && endSide > 0) {
        const isStartRange = idx < startSide;
        const isEndRange = idx >= (Items.length - endSide);
        if (!isStartRange && !isEndRange) return; // Bỏ qua dải hết hạn
      }

      const epPad = String(epNum).padStart(4, '0');
      const url = `https://sai-zen-sen.jp/comics/twi4/${ID}/works/${epPad}${item.Suffix}.jpg`;

      pages.push({
        epNum,
        epPad,
        title: cleanString(item.Title || `#${epPad}`),
        url
      });
    });

    if (!pages.length) {
      throw new Error("Không có tập nào đang mở đọc.");
    }

    const firstEp = pages[0].epPad;
    const lastEp = pages[pages.length - 1].epPad;
    const seriesTitle = cleanString(Title || ID);
    const fullTitle = `${seriesTitle} - ${firstEp}-${lastEp} (最新#${lastEp})`;

    return {
      type: 'twi4',
      id: ID,
      title: fullTitle,
      rangeText: `${firstEp}-${lastEp}`,
      pages
    };
  }

  /* =========================================================================
   * 3B. BÓC TÁCH PHÂN NHÁNH COMICS (KÉO HTML GỐC SERVER - BỎ QUA LIVE DOM)
   * ========================================================================= */
  async function fetchBibiManifest() {
    // 1. Kéo trực tiếp HTML gốc từ máy chủ
    const res = await WIN.fetch(WIN.location.href, { cache: "force-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status} khi lấy cấu trúc chương.`);
    const rawHtml = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(rawHtml, "text/html");

    // 2. Bóc tách Tên Truyện & Tên Chương
    let seriesTitle = "";
    let episodeTitle = "";

    // TH A: Tác phẩm Legacy (có sẵn window.Book)
    if (WIN.Book?.title?.[0]) {
      seriesTitle = cleanString(WIN.Book.title[0]);
      episodeTitle = cleanString(WIN.Book.voltitle?.[0] || "");
    }

    // TH B: Bóc từ H1 / Meta Title của trang (Vạn năng cho mọi kiểu đặt tên chương)
    if (!seriesTitle) {
      const rawTitle = doc.querySelector('h1')?.textContent || doc.querySelector('meta[property="og:title"]')?.getAttribute('content') || doc.title || "";
      const mBook = rawTitle.match(/『(.*?)』/);
      if (mBook) {
        seriesTitle = cleanString(mBook[1].split('/')[0]);

        // 🎯 Lấy toàn bộ chuỗi sau dấu 』 đến trước danh sách tác giả/credit
        const afterBook = rawTitle.substring(rawTitle.indexOf('』') + 1);
        let epRaw = afterBook.split(/\s*(?:著者|原案|作画|原作|キャラクターデザイン原案|キャラクター原案|イラスト|Art|Story|漫画)[：:／/]|\s*[|｜]/)[0].trim();
        
        // Chuẩn hóa dấu gạch chéo thành khoảng trắng để Windows không cấm đặt tên file
        epRaw = epRaw.replace(/\s*[\/／]\s*/g, ' ').replace(/^[-\s・:：]+/, '').trim();
        if (epRaw) episodeTitle = cleanString(epRaw);
      }
    }

    if (!seriesTitle) {
      const parts = WIN.location.pathname.split('/').filter(Boolean);
      seriesTitle = parts.length >= 2 ? cleanString(parts[parts.length - 2]) : "Comics";
    }
    if (!episodeTitle) {
      const parts = WIN.location.pathname.split('/').filter(Boolean);
      episodeTitle = parts.length ? parts[parts.length - 1].replace(/\.html$/i, '') : "Episode";
    }

    const fullTitle = `${seriesTitle} - ${episodeTitle}`;

    // 3. Bóc tách danh sách ảnh theo đúng thứ tự đọc (Phân luồng Selector chuẩn xác)
    const urls = [];
    const seen = new Set();

    function addUrl(rawSrc) {
      if (!rawSrc || typeof rawSrc !== 'string') return;
      if (/spacer|amazon|banner|continue|logo|webclip|icon|\/bg\.(?:png|jpe?g|webp)/i.test(rawSrc)) return;
      const abs = new URL(rawSrc, WIN.location.origin).href;
      if (!seen.has(abs)) {
        seen.add(abs);
        urls.push(abs);
      }
    }

    // NẤC 1: Phân hệ 4-Pages Comics (Marine Yumi, Panjosan... có mảng Sources.ja trong script)
    const szsrMatch = rawHtml.match(/SZSR\["4pComics"\]\s*=\s*\{[\s\S]*?"ja":\s*\[([\s\S]*?)\]/);
    if (szsrMatch && szsrMatch[1]) {
      const pathMatches = szsrMatch[1].match(/"([^"]+\.(?:png|jpe?g|webp))"/g) || [];
      for (const m of pathMatches) addUrl(m.replace(/"/g, ''));
    }

    // NẤC 2: Phân hệ Legacy Reader (Seishun Rikon: CHỈ bốc ảnh trong section truyện, BỎ QUA header giới thiệu)
    if (!urls.length) {
      const legacyImgs = doc.querySelectorAll('#book-body section.book-page-spread p.image img');
      if (legacyImgs.length > 0) {
        legacyImgs.forEach(img => addUrl(img.getAttribute('src')));
      }
    }

    // NẤC 3: Phân hệ BiBi Reader Comics (Kara no Kyoukai, Tsuki no Sango: ảnh nằm trong article.book noscript)
    if (!urls.length) {
      const noscripts = doc.querySelectorAll('article.book noscript, .spread-box noscript');
      noscripts.forEach(ns => {
        const m = (ns.textContent || '').match(/src=["']([^"']+\.(?:png|jpe?g|webp))["']/i);
        if (m && m[1]) addUrl(m[1]);
      });
    }

    // NẤC 4: Dự phòng cuối cùng
    if (!urls.length) {
      const regex = /(?:\/(?:works\/comics|special\/4pages-comics)\/[^\s"'<>]+\.(?:png|jpe?g|webp))/gi;
      const matches = rawHtml.match(regex) || [];
      for (const raw of matches) addUrl(raw);
    }

    if (!urls.length) return null;

    const parts = WIN.location.pathname.split('/').filter(Boolean);
    const idTag = parts.slice(-3).join('_').replace(/\.html$/i, '');

    return {
      type: 'comics',
      id: idTag,
      title: fullTitle,
      pages: urls.map((u, idx) => ({ pageNo: idx + 1, url: u }))
    };
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
      if (!data || !data.pages?.length) {
        if (WIN.location.pathname.includes('/comics/twi4/')) {
          const slug = getTwi4Slug();
          data = await fetchTwi4Manifest(slug);
        } else {
          data = await fetchBibiManifest();
        }
        state.chapterData = data;
      }

      if (!data || !data.pages?.length) throw new Error("Không tìm thấy danh sách ảnh trang truyện.");

      const { pages, title, id } = data;
      const totalPages = pages.length;

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file định danh ID
      zip.addFile(`${id}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      // Hàng đợi 6 luồng tải song song Zero-Copy từ máy chủ
      const tasks = pages.map((pageObj, idx) => async () => {
        const rawBuffer = await Utils.fetchBuffer(pageObj.url, { "Referer": WIN.location.href });
        const rawUint8 = new Uint8Array(rawBuffer);

        // 🎯 ZERO-TRUST MAGIC BYTES
        const ext = Utils.detectExt(rawBuffer);
        if (!ext) throw new Error(`Không thể nhận diện Magic Bytes của trang ${idx + 1}`);

        const fileNum = pageObj.epNum || (idx + 1);
        return { fileName: `${fileNum}.${ext}`, data: rawUint8 };
      });

      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      let savedCount = 0;
      for (const res of results) {
        if (res?.data) {
          zip.addFile(res.fileName, res.data);
          savedCount++;
        }
      }

      if (savedCount === 0) {
        throw new Error("Không thể tải bất kỳ trang ảnh nào. Hãy kiểm tra lại kết nối.");
      }

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      // Đặt tên ZIP chuẩn: [Tên Truyện] - [Tên Chap].zip
      const finalFileName = `${title}.zip`;
      zip.download(finalFileName);

      if (ui) {
        ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
        ui.setBusy(false);
      }
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[saizensen-dl] Download error:", err);
    } finally {
      state.running = false;
    }
  }

  /* =========================================================================
   * 5. KHỞI CHẠY (BOOT) & ĐỒNG BỘ TRẠNG THÁI
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(20);
    const ui = getUI();

    if (!isSupportedUrl()) {
      if (ui?.panel) ui.panel.style.display = "none";
      return;
    }

    while (DOC.readyState === "loading") await sleep(50);

    if (ui?.panel) {
      ui.panel.style.display = "block";
      ui.setBusy(true);
      ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
    }

    try {
      let data = null;
      let retries = 0;
      const isTwi4 = WIN.location.pathname.includes('/comics/twi4/');

      while (retries < 25) {
        try {
          if (isTwi4) {
            const slug = getTwi4Slug();
            if (slug) data = await fetchTwi4Manifest(slug);
          } else {
            data = await fetchBibiManifest();
          }
          if (data && data.pages?.length > 0) break;
        } catch (e) {}
        await sleep(150);
        retries++;
      }

      if (!data || !data.pages?.length) {
        throw new Error("Không lấy được danh sách tập truyện từ máy chủ.");
      }
      state.chapterData = data;

      // 🎯 ZERO-TRUST MAGIC BYTES CHECK TRANG 1:
      const firstPageUrl = data.pages[0].url;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const testBuf = await Utils.fetchBuffer(firstPageUrl, { "Referer": WIN.location.href });
      const realExt = Utils.detectExt(testBuf);

      if (!realExt) {
        throw new Error("Không thể nhận diện Magic Bytes ảnh.");
      }

      data.format = realExt;

      if (ui) {
        await sleep(80);
        ui.updateProgress({
          completed: 0,
          total: data.pages.length,
          status: "Sẵn sàng.",
          format: realExt
        });
        ui.setBusy(false);
      }

      if (isTwi4) {
        state.lastRouteKey = `twi4_${getTwi4Slug()}`;
      } else {
        state.lastRouteKey = WIN.location.pathname;
      }
    } catch (err) {
      console.error("[saizensen-dl] Boot error:", err);
      if (ui) {
        ui.updateProgress({ status: "Lỗi: " + (err?.message || "Không thể tải trang.") });
        ui.setBusy(true);
      }
    }
  }

  // Hook RouteWatcher: KHÓA TUYẾN ĐƯỜNG ĐỘC LẬP THEO PHÂN HỆ
  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute((newUrl) => {

      if (state.running) return;

      if (!isSupportedUrl()) {
        const ui = getUI();
        if (ui?.panel) ui.panel.style.display = "none";
        state.chapterData = null;
        state.lastRouteKey = "";
        state.lastUrl = "";
        return;
      }

      let currentKey = "";
      if (newUrl.includes('/comics/twi4/')) {
        currentKey = `twi4_${getTwi4Slug(newUrl)}`;
      } else {
        currentKey = new URL(newUrl, WIN.location.origin).pathname;
      }

      if (state.lastRouteKey && state.lastRouteKey === currentKey) return;

      state.lastUrl = newUrl;
      state.lastRouteKey = currentKey;
      state.chapterData = null;

      const ui = getUI();
      if (ui) {
        ui.setBusy(true);
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