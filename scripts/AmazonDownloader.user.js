// ==UserScript==
// @name         Amazon Kindle Manga Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://www.amazon.co.jp/favicon.ico
// @description  Tải manga trên Amazon Kindle Web Reader.
// @author       anonymous & AI
// @match        https://read.amazon.co.jp/manga/*
// @match        https://read.amazon.co.jp/sample/*
// @match        https://read.amazon.com/manga/*
// @match        https://read.amazon.com/sample/*
// @match        https://read.amazon.de/manga/*
// @match        https://read.amazon.de/sample/*
// @match        https://read.amazon.co.uk/manga/*
// @match        https://read.amazon.co.uk/sample/*
// @match        https://www.amazon.co.jp/*
// @match        https://www.amazon.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN ---
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/AmazonDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/AmazonDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function amazonKindleMangaUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    NAV_BATCH_SIZE: 6,     // Số trang gom cụm trong mỗi lệnh createNavigationOptions
    OPERATION_TIMEOUT: 60000 // Timeout tối đa chờ giải mã 1 trang (ms)
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  // 1. Nếu đang ở Trang Mẹ (www.amazon) -> Đứng chờ nhận file ZIP từ Iframe để tải xuống ổ cứng!
  if (WIN.top === WIN.self && !WIN.location.hostname.includes('read.amazon')) {    
    WIN.addEventListener('message', (e) => {
      if (e.data?.action === 'AMAZON_KINDLE_DOWNLOAD' && e.data.buffer) {
        const blob = new Blob([e.data.buffer], { type: 'application/zip' });
        const url = URL.createObjectURL(blob);
        const a = DOC.createElement('a');
        a.href = url;
        a.download = e.data.fileName;
        (DOC.body || DOC.documentElement).appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
    });
    return; // Dừng lại ở trang mẹ, không hiện UI rác!
  }

  const state = {
    running: false,
    ui: null,
    runtime: null,
    bookMetadata: null,
    totalImages: 0,
    detectedFormat: null,
    lastAsin: "",
    lastUrl: ""
  };

  /* =========================================================================
   * 1. GIAO DIỆN UNIVERSAL UI CHUẨN 2 TẦNG
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {

      const isSample = WIN.location.pathname.includes('/sample/');
      const topOffset = isSample ? "110px" : "97px";


      const uiConfig = {
        storagePrefix: "amazon-dl",
        title: "Amazon",
        engine: "KINDLE WEB READER",
        themeColor: "#ED6C2D",
        themeBg: "#1c1917",
        titleColor: "#fdba74",
        btnBg: "#ED6C2D",
        btnColor: "#ffffff",
        topOffset: topOffset,
        onDownload: startDownload
      };

      state.ui = createUI(uiConfig);
      state.ui.setBusy(true);

      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:${uiConfig.titleColor};letter-spacing:0.2px;">${uiConfig.title}</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px;">${uiConfig.engine}</div>
          `;
        }
      }
    }
    return state.ui;
  }

  /* =========================================================================
   * 2. BỘ HỖ TRỢ XỬ LÝ CHUỖI, URL & METADATA
   * ========================================================================= */
  function getAsin() {
    try {
      const match = WIN.location.pathname.match(/\/(?:manga|sample)\/([A-Z0-9]{10})/i);
      if (match && match[1]) return match[1];
      const url = new URL(WIN.location.href);
      const qAsin = url.searchParams.get("asin");
      if (qAsin && /^[A-Z0-9]{10}$/i.test(qAsin)) return qAsin;
    } catch (e) {}
    return "AMAZON_MANGA";
  }

  function isEpisodeUrl() {
    return /\/(?:manga|sample)\/[A-Z0-9]{10}/i.test(WIN.location.pathname) || WIN.location.search.includes("asin=");
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

  function getCleanTitle(metadata) {
    try {
      let bookTitle = metadata?.bookTitle || "";
      if (!bookTitle) {
        const titleEl = DOC.getElementById('readerChromeTitle') || DOC.querySelector('.kw-rd-chrome-book-title');
        if (titleEl && titleEl.textContent) bookTitle = titleEl.textContent;
      }
      if (!bookTitle) {
        let t = DOC.title || "";
        t = t.replace(/^Kindle\s*-\s*/i, '');
        bookTitle = t.split(/[|｜]/)[0].trim();
      }

      bookTitle = cleanString(bookTitle);

      // Tách tự động tên truyện và số tập/chương: 第...巻, 第...話, Vol..., Chapter...
      const m = bookTitle.match(/^(.*?)(?:[\s\u3000]+)((?:第\s*[0-9０-９一二三四五六七八九十百千万]+[巻話回].*)|(?:Vol|Volume|Chapter|Ch)\.?\s*\d+.*)$/i);
      if (m) {
        const s = cleanString(m[1]);
        const e = cleanString(m[2]);
        if (s && e) return `${s} - ${e}`;
      }

      if (bookTitle) return bookTitle;
    } catch (e) {}

    return `Kindle_${getAsin()}`;
  }

  /* =========================================================================
   * 3. REACT FIBER TRAVERSAL (BẮT RUNTIME KARAMEL TRONG 0MS)
   * ========================================================================= */
  function findRuntime() {
    // Ưu tiên quét các thẻ thực sự chứa React Fiber của Karamel
    const candidates = [
      DOC.getElementById('reader'),
      DOC.getElementById('renderer-container'),
      DOC.querySelector('.litb-reading-area'),
      DOC.getElementById('mainContainer'),
      DOC.getElementById('root')
    ].filter(Boolean);

    for (const root of candidates) {
      const fiberKey = Object.keys(root).find(name => name.startsWith('__reactContainer') || name.startsWith('__reactFiber'));
      if (!fiberKey) continue; // Bỏ qua nếu thẻ này không có React Fiber, tìm tiếp thẻ khác!

      const fiber = root?._reactRootContainer?._internalRoot?.current 
                 || root?.[fiberKey]?.stateNode?.current 
                 || root?.[fiberKey];

      if (!fiber) continue;

      const pending = [fiber];
      for (let count = 0; pending.length && count < 10000; count++) {
        const node = pending.pop();
        if (!node) continue;
        if (node.sibling) pending.push(node.sibling);
        if (node.child) pending.push(node.child);

        let hook = node.memoizedState;
        for (let index = 0; hook && index < 150; index++, hook = hook.next) {
          const reader = hook.memoizedState?.current;
          const factory = reader?.options?.bookProviderFactory;
          const controller = reader?.client?.options?.rendererController;

          if (reader && typeof factory?.get === 'function' &&
              typeof controller?.getRenderSettings === 'function' &&
              typeof controller?.createNavigationOptions === 'function' &&
              typeof reader.client?.getMetadata === 'function') {
            return { reader, factory, controller };
          }
        }
      }
    }
    return null;
  }

  function getEstimatedTotalPages(runtime) {
    try {
      const client = runtime?.reader?.client;
      if (client?.getManifest?.()?.bookType === 'FixedFormat') {
        const locations = client.getLocationMap?.()?.locations;
        if (Array.isArray(locations) && locations.length > 0) {
          const isSample = WIN.location.pathname.includes('/sample/');
          // Sample: trừ 1 trang HTML mua hàng ở cuối -> hiện đúng 37! Purchased: giữ nguyên!
          return isSample ? (locations.length - 1) : locations.length;
        }
      }
    } catch (e) {}
    return null;
  }

  /* =========================================================================
   * 4. BÓC TÁCH MẢNG ID ẢNH (BREADTH-FIRST SEARCH GIỮ NGUYÊN THỨ TỰ TRANG)
   * ========================================================================= */
  function extractImageReferences(page) {
    const refs = [];
    const queue = [page];

    while (queue.length) {
      const node = queue.shift();
      if (!node || typeof node !== 'object') continue;

      if (typeof node.imageReference === 'string') {
        if (/^resource\/[a-z0-9_.-]+$/i.test(node.imageReference)) {
          refs.push(node.imageReference);
        }
      }

      if (Array.isArray(node.children)) {
        queue.push(...node.children);
      }
    }
    return refs;
  }

  function withTimeout(promise, ms, errorMsg) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = WIN.setTimeout(() => reject(new Error(errorMsg)), ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => WIN.clearTimeout(timer));
  }

  /* =========================================================================
   * 5. TIẾN TRÌNH TẢI CHÍNH (IN-MEMORY NATIVE DECRYPT & ZERO-COPY ZIP)
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    const runtime = state.runtime || findRuntime();
    if (!runtime) {
      if (ui) ui.updateProgress({ status: "Lỗi: Không tìm thấy Kindle reader runtime." });
      return;
    }

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      const { reader, factory, controller } = runtime;
      const { asin, revision } = reader.options;
      const metadata = await withTimeout(Promise.resolve(reader.client.getMetadata()), 15000, "Timeout đọc Metadata.");

      const firstPos = metadata.firstPositionId;
      const lastPos = metadata.lastPositionId;
      if (!Number.isSafeInteger(firstPos) || !Number.isSafeInteger(lastPos) || firstPos < 0 || lastPos < firstPos) {
        throw new Error("Reader không cung cấp phạm vi vị trí hợp lệ.");
      }

      const totalEstimated = state.totalImages || getEstimatedTotalPages(runtime) || (lastPos - firstPos + 1);
      if (ui) ui.updateProgress({ completed: 0, total: totalEstimated, status: "Đang tải..." });

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file định danh ASIN
      zip.addFile(`${asin}.txt`, new Uint8Array(0));

      const settings = { ...controller.getRenderSettings() };
      const seenRefs = new Set();
      let cursor = firstPos;
      let completed = 0;

      while (cursor <= lastPos) {
        const navigation = controller.createNavigationOptions(cursor, 0, 'Forward', CONFIG.NAV_BATCH_SIZE);
        let providers = null;

        try {
          providers = await withTimeout(
            factory.get(asin, revision, navigation, settings),
            CONFIG.OPERATION_TIMEOUT,
            `Timeout tải gói tin tại vị trí ${cursor}.`
          );
        } catch (err) {
          throw new Error(`Không tải được dữ liệu tại vị trí ${cursor}: ${err?.message}`);
        }

        if (!Array.isArray(providers) || !providers.length) {
          break;
        }

        // Đọc cấu trúc từng trang trong batch
        const pagesData = await Promise.all(providers.map(async (provider) => ({
          provider,
          page: await withTimeout(provider.getPage(), 20000, "Timeout đọc thông tin trang.")
        })));

        // Sắp xếp tăng dần theo startPositionId để bảo tồn 100% thứ tự đọc
        pagesData.sort((a, b) => (Number(a.page?.startPositionId) || 0) - (Number(b.page?.startPositionId) || 0));

        let end = cursor - 1;

        for (const { provider, page } of pagesData) {
          const refs = extractImageReferences(page);

          for (const ref of refs) {
            if (seenRefs.has(ref)) continue;
            seenRefs.add(ref);

            // GỌI NATIVE DECRYPTION: Kindle runtime tự tải CDN và tự giải mã qua imageDecipher trong RAM
            const blob = await withTimeout(
              provider.getImage(ref),
              CONFIG.OPERATION_TIMEOUT,
              `Timeout giải mã ảnh ${ref}.`
            );

            if (!blob || blob.size === 0) {
              throw new Error(`Ảnh giải mã ${ref} bị rỗng.`);
            }

            const arrayBuffer = await blob.arrayBuffer();
            const uint8 = new Uint8Array(arrayBuffer);

            // Nhận diện đuôi mở rộng thực tế qua Magic Bytes (JPEG, PNG, WEBP)
            const ext = Utils.detectExt(arrayBuffer);

            completed++;
            zip.addFile(`${completed}.${ext}`, uint8);

            if (ui) {
              const displayTotal = Math.max(completed, totalEstimated);
              ui.updateProgress({
                completed,
                total: displayTotal,
                status: "Đang tải..."
              });
            }
          }

          if (Number.isSafeInteger(page?.endPositionId)) {
            end = Math.max(end, page.endPositionId);
          }
        }

        if (end < cursor) {
          // Tránh vòng lặp vô tận nếu reader không tịnh tiến được vị trí
          cursor += 1;
        } else {
          cursor = end + 1;
        }
      }

      if (completed === 0) {
        throw new Error("Không giải mã được bất kỳ ảnh nào trong cuốn sách.");
      }

      if (ui) ui.updateProgress({ completed, total: completed, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      // Đặt tên ZIP chuẩn: [Tên Truyện] - [Tên Tập].zip
      const finalTitle = getCleanTitle(metadata);
      const zipName = `${finalTitle}.zip`;
      const blob = zip.generateBlob();

      // Nếu đang trong Iframe đọc thử -> Chuyển sang mảng byte và bắn sang trang mẹ www.amazon
      if (WIN.top !== WIN.self) {
        try {
          const buf = await blob.arrayBuffer();
          WIN.parent.postMessage({
            action: 'AMAZON_KINDLE_DOWNLOAD',
            buffer: buf,
            fileName: zipName
          }, '*');
        } catch (postErr) {
        }
      } else {
        // Bản Purchased toàn màn hình -> tải trực tiếp
        zip.download(zipName);
      }

      if (ui) {
        ui.updateProgress({ completed, total: completed, status: "Hoàn tất." });
        ui.setBusy(false);
      }
    } catch (err) {
      console.error("[amazon-dl] Download error:", err);
      if (ui) {
        ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
        ui.setBusy(true);
      }
    } finally {
      state.running = false;
    }
  }

  /* =========================================================================
   * 6. KHỞI CHẠY & THEO DÕI ĐIỀU HƯỚNG SPA
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
      // 1. Polling tìm React Fiber Runtime & KIÊN NHẪN CHỜ ĐỢT RENDER ĐẦU TIÊN
      let runtime = null;
      let metadata = null;

      for (let i = 0; i < 60; i++) {
        runtime = findRuntime();
        if (runtime?.reader?.client) {
          try {
            // Thử lấy metadata, nếu Kindle chưa render xong nó sẽ văng lỗi vào catch và tiếp tục đợi
            metadata = await runtime.reader.client.getMetadata();
            if (metadata && metadata.firstPositionId !== undefined) {
              break; // ĐÃ RENDER XONG VÀ CÓ METADATA!
            }
          } catch (metaErr) {
            // Nuốt lỗi "Metadata is not available before rendering" khi web đang dựng trang
          }
        }
        await sleep(300);
      }

      if (!runtime || !metadata) {
        throw new Error("Chưa nhận diện được Kindle reader. Vui lòng chờ sách nạp xong.");
      }

      state.runtime = runtime;
      state.bookMetadata = metadata;
      const { reader, factory, controller } = runtime;
      const { asin, revision } = reader.options;

      // 2. Đếm số trang dự kiến
      const totalEstimated = getEstimatedTotalPages(runtime) || (metadata.lastPositionId ? (metadata.lastPositionId - metadata.firstPositionId + 1) : 0);
      state.totalImages = totalEstimated;

      // 3. SOI MAGIC BYTES TRANG 1 QUA IN-MEMORY NATIVE CALL:
      const settings = { ...controller.getRenderSettings() };
      const navFirst = controller.createNavigationOptions(metadata.firstPositionId, 0, 'Forward', 1);
      const providers = await withTimeout(factory.get(asin, revision, navFirst, settings), 15000, "Timeout nạp trang 1.");

      let realExt = null;
      if (Array.isArray(providers) && providers.length > 0) {
        const page1 = await providers[0].getPage();
        const refs = extractImageReferences(page1);
        if (refs.length > 0) {
          const testBlob = await providers[0].getImage(refs[0]);
          if (testBlob && testBlob.size > 0) {
            const Utils = window.MangaUtils || globalThis.MangaUtils;
            const buf = await testBlob.slice(0, 32).arrayBuffer();
            realExt = Utils.detectExt(buf);
          }
        }
      }
      state.detectedFormat = realExt;

      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: totalEstimated || 1,
          status: "Sẵn sàng.",
          format: realExt
        });
        ui.setBusy(false);
      }
    } catch (err) {
      console.error("[amazon-dl] Boot error:", err);
      if (ui) {
        ui.updateProgress({ status: "Lỗi: " + (err?.message || "Không thể tải trang.") });
        ui.setBusy(true);
      }
    }
  }

  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute((newUrl) => {
      if (!isEpisodeUrl()) {
        const ui = getUI();
        if (ui?.panel) ui.panel.style.display = "none";
        state.runtime = null;
        state.bookMetadata = null;
        state.lastAsin = "";
        state.lastUrl = "";
        state.running = false;
        return;
      }

      const currentAsin = getAsin();
      if (state.lastAsin && state.lastAsin === currentAsin) return;

      state.lastUrl = newUrl;
      state.lastAsin = currentAsin;
      state.runtime = null;
      state.bookMetadata = null;
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