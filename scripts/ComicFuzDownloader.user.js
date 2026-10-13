// ==UserScript==
// @name         Comic-Fuz Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @description  Tải manga trên Comic-Fuz (comic-fuz.com).
// @author       anonymous & AI
// @match        https://comic-fuz.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      comic-fuz.com
// @connect      api.comic-fuz.com
// @connect      img.comic-fuz.com
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function comicFuzUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6
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
    lastChapterId: ""
  };

  /* =========================================================================
   * 1. GIAO DIỆN UNIVERSAL UI 2 TẦNG
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      
      const uiConfig = {
        storagePrefix: "comicfuz-dl",
        title: "COMIC FUZ",
        engine: "HOUBUNSHA",
        themeColor: "#ffffff",      
        themeBg: "#000000",         
        titleColor: "#ffffff",     
        btnBg: "#ffffff",          
        btnColor: "#000000",
        tabBg: "#ffffff", 
        tabColor: "#000000",
        tabBorder: "none", 
        topOffset: "98px", 
        onDownload: startDownload
      }

      state.ui = createUI(uiConfig);
      state.ui.setBusy(true);

      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:900 13px/1.2 system-ui,sans-serif;color:${uiConfig.titleColor};letter-spacing:0.5px;">${uiConfig.title}</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px;visibility:hidden;">${uiConfig.engine}</div>
          `;
        }
      }
    }
    return state.ui;
  }

  /* =========================================================================
   * 2. BỘ HỖ TRỢ XỬ LÝ CHUỖI & METADATA NEXT.JS CHUẨN XÁC
   * ========================================================================= */
  function cleanString(str) {
    if (!str) return "";
    return str
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/【(?!(?:フルカラー版|カラー版|完全版|特装版))[^】]*】/gi, '')
      .replace(/[\\/*?:"<>|]/g, '') // Lọc ký tự cấm của hệ điều hành
      .trim();
  }

  function isEpisodeUrl() {
    return /\/(?:manga|book|magazine)\/(?:viewer\/)?\d+/i.test(WIN.location.pathname);
  }

  // Hàm điều phối lấy toàn bộ Metadata (Chapter ID, Tên truyện, Tên chap đầy đủ)
  async function resolveComicFuzContext() {
    const path = WIN.location.pathname;

    // TH1: Đang ở trang đọc trực tiếp (/manga/viewer/:chapterId)
    const viewerMatch = path.match(/\/(?:manga|book|magazine)\/viewer\/(\d+)/);
    if (viewerMatch) {
      const chapterId = viewerMatch[1];
      const pageProps = WIN.__NEXT_DATA__?.props?.pageProps;

      // 1. Ưu tiên lấy trực tiếp từ Next.js Data nếu có
      const seriesFromNext = cleanString(pageProps?.manga?.mangaName || pageProps?.chapter?.mangaName || "");
      const mainFromNext   = cleanString(pageProps?.chapter?.chapterMainName || "");
      const subFromNext    = cleanString(pageProps?.chapter?.chapterSubName || "");

      if (seriesFromNext && mainFromNext) {
        const chapFull = subFromNext ? `${mainFromNext} ${subFromNext}` : mainFromNext;
        return { chapterId, title: `${seriesFromNext} - ${chapFull}` };
      }

      // 2. Lấy chuỗi tiêu đề từ meta og:title
      const metaOg = DOC.querySelector('meta[property="og:title"]')?.getAttribute('content') || DOC.title || "";
      let clean = cleanString(metaOg.replace(/[-－–—\s]*COMIC\s*FUZ.*$/i, ''));

      // 3. Tách bằng tên truyện từ link quay lại trang manga: <a href="/manga/3274">花唄メモワール</a>
      const mangaLinkEl = DOC.querySelector('a[href^="/manga/"]:not([href*="viewer"])');
      const seriesFromDom = cleanString(mangaLinkEl?.textContent || "");

      if (seriesFromDom && clean.startsWith(seriesFromDom)) {
        let epPart = cleanString(clean.substring(seriesFromDom.length));
        if (epPart) {
          return { chapterId, title: `${seriesFromDom} - ${epPart}` };
        }
      }

      // 4. Regex vạn năng: Bắt chữ "第" + mọi danh từ đơn vị (唄, 話, 局, 曲...) hoặc các từ khóa tiếng Anh
      const m = clean.match(/^(.*?)(?:\s+[-－–—]\s+|\s+)((?:(?:第\s*[0-9０-９一二三四五六七八九十百千万]+[^\s]*)|(?:TRIGGER|CHAPTER|EPISODE|ACT|ROUND|VOL)[\.\s]*\d+).*)$/i);
      if (m) {
        return { chapterId, title: `${cleanString(m[1])} - ${cleanString(m[2])}` };
      }

      return { chapterId, title: clean || `ComicFuz_${chapterId}` };
    }

    // TH2: Đang ở trang manga nhúng viewer (/manga/:mangaId)
    const mangaMatch = path.match(/\/manga\/(\d+)/);
    if (!mangaMatch) return null;
    const mangaId = mangaMatch[1];

    let pageProps = null;

    // 1. Thử lấy từ __NEXT_DATA__ nếu ID trùng khớp
    if (WIN.__NEXT_DATA__?.props?.pageProps?.manga?.mangaId === Number(mangaId)) {
      pageProps = WIN.__NEXT_DATA__.props.pageProps;
    } else {
      // 2. Nếu chuyển trang ngầm (SPA), kéo trực tiếp Next.js data route của manga đó
      const buildId = WIN.__NEXT_DATA__?.buildId;
      if (buildId) {
        try {
          const res = await WIN.fetch(`/_next/data/${buildId}/manga/${mangaId}.json${WIN.location.search || ''}`);
          if (res.ok) {
            const json = await res.json();
            pageProps = json.pageProps;
          }
        } catch (e) {}
      }
    }

    if (pageProps) {
      const seriesName = cleanString(pageProps.manga?.mangaName || "");
      
      // Lấy từ viewButton.chapter (chính là chương 1 đang hiển thị trên viewer)
      const targetChap = pageProps.viewButton?.chapter;
      if (targetChap && targetChap.chapterId) {
        const mainName = cleanString(targetChap.chapterMainName || "");
        const subName  = cleanString(targetChap.chapterSubName || "");
        const chapterFull = (mainName && subName) ? `${mainName} ${subName}` : (mainName || subName);
        const fullTitle = (seriesName && chapterFull) ? `${seriesName} - ${chapterFull}` : (seriesName || chapterFull);
        return { chapterId: String(targetChap.chapterId), title: fullTitle };
      }

      // Dự phòng nếu có mảng chapters phân nhóm
      const groupChapters = pageProps.chapters?.reduce((acc, cur) => acc.concat(cur.chapters || []), []) || [];
      if (groupChapters.length > 0) {
        const firstC = groupChapters[0];
        const mainName = cleanString(firstC.chapterMainName || "");
        const subName  = cleanString(firstC.chapterSubName || "");
        const chapterFull = (mainName && subName) ? `${mainName} ${subName}` : (mainName || subName);
        return { chapterId: String(firstC.chapterId), title: `${seriesName} - ${chapterFull}` };
      }
    }

    // 4. Polling dự phòng quét DOM nếu Next.js chưa kịp nạp dữ liệu
    for (let i = 0; i < 15; i++) {
      await sleep(200);
      const shareLink = DOC.querySelector('a[href*="share.comic-fuz.com/chapter/"], a[href*="/chapter/"]');
      if (shareLink) {
        const m = (shareLink.getAttribute('href') || '').match(/chapter\/(\d+)/);
        if (m) {
          const metaTitle = cleanString(DOC.querySelector('meta[property="og:title"]')?.getAttribute('content') || DOC.title || "");
          return { chapterId: m[1], title: metaTitle || `ComicFuz_${m[1]}` };
        }
      }
    }

    return null;
  }

  /* =========================================================================
   * 3. PROTOBUF ENCODER & GIẢI MÃ PHẦN CỨNG AES-CBC
   * ========================================================================= */
  function encodeProtobufRequest(chapterId) {
    const bytes = [];
    function writeVarint(val) {
      val >>>= 0;
      while (val >= 0x80) { bytes.push((val & 0x7F) | 0x80); val >>>= 7; }
      bytes.push(val);
    }
    bytes.push(0x0a, 0x02, 0x18, 0x02); // deviceInfo: { deviceType: 2 }
    bytes.push(0x10);                   // chapterId tag
    writeVarint(Number(chapterId));
    bytes.push(0x18, 0x00);             // useTicket: false
    bytes.push(0x22, 0x04, 0x08, 0x00, 0x10, 0x00); // consumePoint: { event: 0, paid: 0 }
    return new Uint8Array(bytes);
  }

  function hexToBytes(hex) {
    const clean = String(hex || '').trim().replace(/[^0-9a-fA-F]/g, '');
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  async function fetchComicFuzManifest(chapterId) {
    const body = encodeProtobufRequest(chapterId);

    const responseText = await new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: "https://api.comic-fuz.com/v1/manga_viewer",
        data: body,
        headers: { "Content-Type": "application/x-protobuf" },
        responseType: "text",
        onload: res => (res.status >= 200 && res.status < 300) ? resolve(res.responseText) : reject(new Error(`HTTP ${res.status}`)),
        onerror: () => reject(new Error("Lỗi kết nối API Comic-Fuz")),
        ontimeout: () => reject(new Error("Timeout kết nối API Comic-Fuz"))
      });
    });

    // Bóc tách URL CDN (bảo toàn trọn vẹn cả &ct=1), IV 32-hex và Key 64-hex (IV (32-hex) + "@ + Key (64-hex))
    const regex = /(\/[fkh].*?&e=\d{10}[^\s"'\x00-\x1f]*).*?([0-9a-fA-F]{32})"@([0-9a-fA-F]{64})/g;
    const pages = [];
    let match;

    while ((match = regex.exec(responseText)) !== null) {
      pages.push({
        pageNo: pages.length + 1,
        url: `https://img.comic-fuz.com${match[1]}`,
        iv: match[2],
        key: match[3]
      });
    }

    if (pages.length === 0) {
      throw new Error("Không thể bóc tách danh sách ảnh từ API Comic-Fuz.");
    }

    return pages;
  }

  async function decryptComicFuzImage(pageItem) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;

    // 1. Tải mảng byte nhị phân qua GM_xmlhttpRequest
    const encryptedBuffer = await Utils.fetchBuffer(pageItem.url, { "Referer": "https://comic-fuz.com/" });

    // 2. Giải mã khối phần cứng AES-CBC trong RAM
    const cryptoKey = await WIN.crypto.subtle.importKey(
      "raw",
      hexToBytes(pageItem.key),
      { name: "AES-CBC" },
      false,
      ["decrypt"]
    );

    const decryptedBuffer = await WIN.crypto.subtle.decrypt(
      { name: "AES-CBC", iv: hexToBytes(pageItem.iv) },
      cryptoKey,
      encryptedBuffer
    );
    const decryptedBytes = new Uint8Array(decryptedBuffer);

    // 3. Nhận diện định dạng thực tế từ Magic Bytes (chống giả mạo đuôi URL)
    const ext = Utils.detectExt(decryptedBuffer);

    return {
        fileName: `${pageItem.pageNo}.${ext}`,
        data: decryptedBytes
      };
  }

  /* =========================================================================
   * 4. TIẾN TRÌNH TẢI CHÍNH & ĐÓNG GÓI PUREZIPWRITER
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    const ctx = await resolveComicFuzContext();
    if (!ctx || !ctx.chapterId) {
      if (ui) ui.updateProgress({ status: "Lỗi: Không tìm thấy ID chương." });
      return;
    }

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let pages = state.chapterData?.pages;
      if (!pages || !pages.length) {
        pages = await fetchComicFuzManifest(ctx.chapterId);
        state.chapterData = { pages, title: ctx.title };
      }

      const totalPages = pages.length;
      if (!totalPages) throw new Error("Không có trang hợp lệ để tải.");

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file định danh ID chương theo Golden Rules
      zip.addFile(`${ctx.chapterId}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      // 6 luồng tải song song Zero-Copy trong RAM
      const tasks = pages.map(pageItem => () => decryptComicFuzImage(pageItem));
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
        throw new Error("Giải mã thất bại toàn bộ các trang ảnh! Hãy kiểm tra lại kết nối.");
      }

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      // Đặt tên ZIP chuẩn: [Tên Truyện] - [Tên Chap].zip
      const finalFileName = `${state.chapterData?.title || ctx.title}.zip`;
      zip.download(finalFileName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[comicfuz-dl] Download error:", err);
    } finally {
      state.running = false;
    }
  }

  /* =========================================================================
   * KHỞI CHẠY & THEO DÕI ROUTE NEXT.JS SPA
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
      const ctx = await resolveComicFuzContext();
      if (!ctx || !ctx.chapterId) throw new Error("Không tìm thấy chương truyện.");

      const pages = await fetchComicFuzManifest(ctx.chapterId);
      if (!pages || !pages.length) {
        throw new Error("Không lấy được danh sách trang.");
      }
      state.chapterData = { pages, title: ctx.title };

      // SOI MAGIC BYTES THỰC TẾ TRANG 1 SAU KHI GIẢI MÃ PHẦN CỨNG AES-256-CBC:
      const firstPage = pages[0]; // bên này dùng pages[0].url
      if (!firstPage?.url) throw new Error("URL trang 1 không hợp lệ.");

      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const encryptedBuf = await Utils.fetchBuffer(firstPage.url, { "Referer": "https://comic-fuz.com/" });
      const cryptoKey = await WIN.crypto.subtle.importKey(
        "raw",
        hexToBytes(firstPage.key),
        { name: "AES-CBC" },
        false,
        ["decrypt"]
      );
      const decryptedBuf = await WIN.crypto.subtle.decrypt(
        { name: "AES-CBC", iv: hexToBytes(firstPage.iv) },
        cryptoKey,
        encryptedBuf
      );

      const realExt = Utils.detectExt(decryptedBuf);
      if (!realExt) throw new Error("Không thể nhận diện Magic Bytes ảnh.");

      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: pages.length,
          status: "Sẵn sàng.",
          format: realExt
        });
        ui.setBusy(false);
      }
    } catch (err) {
      console.error("[comicfuz-dl] Boot error:", err);
      if (ui) {
        ui.updateProgress({ status: "Lỗi: " + (err?.message || "không thể tải trang.") });
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
        state.chapterData = null;
        state.lastChapterId = "";
        state.lastUrl = "";
        state.running = false;
        return;
      }

      const pathMatch = WIN.location.pathname.match(/\/(?:manga|book|magazine)\/(?:viewer\/)?(\d+)/i);
      const currentCid = pathMatch ? pathMatch[1] : WIN.location.pathname;

      if (state.lastChapterId && state.lastChapterId === currentCid) return;

      state.lastUrl = newUrl;
      state.lastChapterId = currentCid;
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