// ==UserScript==
// @name         SugoiWeb Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://sugoiweb.jp/favicon.ico
// @description  Tải manga trên 宝島すごい！WEB (sugoiweb.jp) chuẩn Laymic Swiper Direct Clean Assets Zero-Copy 0ms.
// @author       anonymous & AI
// @match        https://sugoiweb.jp/comic/lineup/*
// @match        https://www.sugoiweb.jp/comic/lineup/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      sugoiweb.jp
// @connect      www.sugoiweb.jp
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/SugoiWebDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/SugoiWebDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function sugoiWebUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6   // 6 luồng tải song song từ máy chủ tĩnh
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    chapterData: null,
    chapterCache: new Map(),
    ui: null,
    lastUrl: "",
    lastViewerId: "",
    thumbsObserverInstalled: false,
    shieldInstalled: false 
  };

  /* =========================================================================
   * 1. GIAO DIỆN THEME THEO NÚT 読む (CAM VÀNG #E59828 - NỀN TRẮNG)
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "sugoiweb-dl",
        title: "Sugoi Web",
        engine: "TAKARAJIMASHA",
        themeColor: "#E59828",      // Màu cam vàng thương hiệu của nút 読む
        themeBg: "#ffffff",         // Nền bảng trắng sáng
        titleColor: "#E59828",      // Tiêu đề cam vàng
        btnBg: "#E59828",           // Nút tải cam vàng
        btnColor: "#ffffff",        // Chữ nút trắng
        tabBg: "#E59828",
        tabColor: "#ffffff",
        topOffset: "63.98px",
        onDownload: startDownload
      };

      state.ui = createUI(uiConfig);
      state.ui.setBusy(true);

      // Header 2 tầng (Dòng 1: Sugoi Web, Dòng 2: TAKARAJIMASHA)
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
   * 2. BẢO VỆ CHỐNG THOÁT VIEWER, TỰ ĐỘNG NỔI FULLSCREEN & ĐIỀU PHỐI ẨN/HIỆN 0MS
   * ========================================================================= */
  function setupThumbsWatcher(ui) {
    if (!ui?.panel) return;

    // Gắn class "laymic_ui" để nằm trong Whitelist của Laymic
    ui.panel.classList.add('laymic_ui');

    if (!state.thumbsObserverInstalled) {
      state.thumbsObserverInstalled = true;

      const syncUIState = () => {
        const viewerId = getActiveViewerId();

        // 1. Nếu viewer đã đóng -> Ẩn UI ngay lập tức ở 0ms
        if (!viewerId) {
          ui.panel.style.display = 'none';
          return;
        }

        // 2. Kiểm tra xem lưới thumbnail có đang mở không
        const isThumbsOpen = Array.from(DOC.querySelectorAll('.laymic_root')).some(
          r => r.classList.contains('laymic_isShowThumbs')
        );

        // Mở thumbnail thì ẩn UI; đóng thumbnail thì hiện lại
        ui.panel.style.display = isThumbsOpen ? 'none' : 'block';
      };

      // A. Theo dõi DOM Mutation
      const obs = new MutationObserver(syncUIState);
      obs.observe(DOC.body, { attributes: true, subtree: true, attributeFilter: ['class', 'style', 'aria-expanded'] });

      // B. 🎯 FIX VẤN ĐỀ 1: Bắt sự kiện Fullscreen của web (phím 'f' hoặc nút toàn màn hình)
      DOC.addEventListener('fullscreenchange', () => {
        const fsEl = DOC.fullscreenElement;
        if (fsEl && ui.panel) {
          fsEl.appendChild(ui.panel); // Bay lên Top Layer cùng web khi fullscreen
        } else if (ui.panel) {
          DOC.body.appendChild(ui.panel); // 🎯 LUÔN TRẢ VỀ LÀM CON TRỰC TIẾP CỦA BODY!
        }
      });

      // C. 🎯 FIX VẤN ĐỀ 2: Bắt sự kiện thoát viewer tức thì ở 0ms (chống trễ 2s và không cần lăn chuột)
      DOC.addEventListener('transitionend', e => {
        if (e.target?.classList?.contains('laymic_root')) syncUIState();
      });
      DOC.addEventListener('click', () => WIN.requestAnimationFrame(syncUIState));
      WIN.addEventListener('keydown', e => {
        if (e.key === 'Escape' || e.key === 'f' || e.key === 'F') WIN.requestAnimationFrame(syncUIState);
      });
    }
  }

  /* =========================================================================
   * 3. BỘ HỖ TRỢ XỬ LÝ CHUỖI, URL & TIÊU ĐỀ
   * ========================================================================= */
  function isLineupPage() {
    return /\/comic\/lineup\/\d+/i.test(WIN.location.pathname);
  }

  function getActiveViewerId() {
    // 🎯 TẦNG 1: Nếu URL không có #laymic và không có ?slide= -> Đang ở ngoài trang danh sách, đóng 100%!
    if (!WIN.location.hash.includes('laymic') && !WIN.location.search.includes('slide=')) {
      return null;
    }

    // 1. Ưu tiên bóc ID từ URL Hash nếu có (#laymic01, #laymic02...)
    const hashMatch = WIN.location.hash.match(/#(laymic\d+)/i);
    if (hashMatch) return hashMatch[1];

    // 🎯 TẦNG 2: Tìm .laymic_root thực sự đang mở (KHÔNG bị display:none, KHÔNG bị hidden, KHÔNG bị opacity:0)
    const roots = Array.from(DOC.querySelectorAll('.laymic_root'));
    const activeIdx = roots.findIndex(r => {
      return r.style.display !== 'none' && 
             r.style.visibility !== 'hidden' && 
             r.style.opacity !== '0';
    });

    if (activeIdx !== -1) {
      const templates = Array.from(DOC.querySelectorAll('.laymic_template'));
      const activeTpl = templates[activeIdx];
      return activeTpl?.dataset?.viewerId || activeTpl?.getAttribute('data-viewer-id') || null;
    }

    return null;
  }

  function getLineupId() {
    const m = WIN.location.pathname.match(/\/comic\/lineup\/(\d+)/i);
    return m ? m[1] : "sugoi_lineup";
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

  function getCleanTitle(viewerId) {
    try {
      // 1. Tên Bộ Truyện từ thẻ meta og:title
      const rawTitle = DOC.querySelector('meta[property="og:title"]')?.getAttribute('content') || DOC.title || "";
      let seriesTitle = rawTitle.split(/[|｜]/)[0].replace(/^【.*?】\s*/, '').trim();
      seriesTitle = cleanString(seriesTitle);

      // 2. 🎯 Bóc Tên Chương: Ánh xạ chuẩn chỉ mục Template <-> Hàng có nút đọc (.btnText01)
      let chapterTitle = "";
      if (viewerId) {
        const templates = Array.from(DOC.querySelectorAll('.laymic_template'));
        const tplIndex = templates.findIndex(t => (t.dataset?.viewerId || t.getAttribute('data-viewer-id')) === viewerId);

        const rows = Array.from(DOC.querySelectorAll('.btnText01')).map(btn => btn.closest('li, div[class*="episode"], div[class*="item"]')).filter(Boolean);
        const targetRow = (tplIndex !== -1 && rows[tplIndex]) ? rows[tplIndex] : rows[0];

        if (targetRow) {
          const rawTexts = Array.from(targetRow.querySelectorAll('h3, h4, p')).map(e => cleanString(e.textContent)).filter(Boolean);
          // 🎯 LỌC BỎ 100% RÁC: Nút "読む", chữ "最新話" và ngày tháng "掲載期間: 2026..."
          const cleanParts = rawTexts.map(t => t.replace(/最新話/g, '').trim()).filter(t => {
            if (!t || t === '読む') return false;
            if (/掲載期間|公開期間|期間|20\d{2}\./i.test(t)) return false;
            return true;
          });
          chapterTitle = Array.from(new Set(cleanParts)).join(' ').trim();
        }
      }

      if (seriesTitle && chapterTitle) {
        return chapterTitle.startsWith(seriesTitle) ? chapterTitle : `${seriesTitle} - ${chapterTitle}`;
      }
      return seriesTitle || chapterTitle || `SugoiWeb_${viewerId}`;
    } catch (e) {}

    return `SugoiWeb_${viewerId || getLineupId()}`;
  }

  /* =========================================================================
   * 4. BÓC TÁCH LINK ẢNH TỪ TEMPLATE (LỌC 100% ẢNH HƯỚNG DẪN VUỐT TAY)
   * ========================================================================= */
  function extractLaymicPages(viewerId) {
    if (!viewerId) return null;

    // Tìm đúng container template của chương đang đọc: <div class="laymic_template" data-viewer-id="...">
    const tpl = DOC.querySelector(`.laymic_template[data-viewer-id="${viewerId}"]`);
    if (!tpl) return null;

    const imgEls = Array.from(tpl.querySelectorAll('img'));
    if (!imgEls.length) return null;

    const urls = [];
    const seen = new Set();

    for (const img of imgEls) {
      // Ưu tiên data-src (lazy-load) rồi mới đến src
      let src = img.getAttribute('data-src') || img.getAttribute('src') || img.src || '';
      if (!src || src.startsWith('data:image') || !src.includes('/uploads/')) continue;

      // 🎯 LỌC BỎ ẢNH ĐỆM HƯỚNG DẪN VUỐT TAY (swipe-1.jpg, swipe-end.jpg...)
      if (/swipe[-_]/i.test(src)) continue;

      const absUrl = new URL(src, WIN.location.origin).href;
      if (!seen.has(absUrl)) {
        seen.add(absUrl);
        urls.push(absUrl);
      }
    }

    if (urls.length === 0) return null;

    return {
      viewerId: viewerId,
      lineupId: getLineupId(),
      title: getCleanTitle(viewerId),
      urls: urls
    };
  }

  /* =========================================================================
   * 5. TIẾN TRÌNH TẢI CHÍNH & ZERO-COPY 0MS VÀO ZIP
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    const viewerId = getActiveViewerId();
    if (!viewerId) {
      if (ui) ui.updateProgress({ status: "Lỗi: Không tìm thấy trình đọc đang mở." });
      return;
    }

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let data = state.chapterData;
      if (!data || data.viewerId !== viewerId || !data.urls?.length) {
        data = extractLaymicPages(viewerId);
        state.chapterData = data;
      }

      if (!data || !data.urls?.length) throw new Error("Không tìm thấy danh sách trang truyện.");

      const { urls, title, viewerId: vId, lineupId } = data;
      const totalPages = urls.length;
      if (!totalPages) throw new Error("Không có trang hợp lệ để tải.");

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file định danh ID theo Golden Rule 2
      zip.addFile(`${lineupId}_${vId}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      // Hàng đợi 6 luồng tải song song Zero-Copy từ máy chủ tĩnh
      const tasks = urls.map((url, idx) => async () => {
        const rawBuffer = await Utils.fetchBuffer(url, { "Referer": WIN.location.href });
        const rawUint8 = new Uint8Array(rawBuffer);
        const ext = Utils.detectExt(rawBuffer) || 'jpg';

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

      const zipName = `${title || getCleanTitle(vId)}.zip`;
      const blob = zip.generateBlob();
      const blobUrl = URL.createObjectURL(blob);
      const safeAnchor = DOC.createElement('a');
      safeAnchor.className = 'laymic_ui';
      safeAnchor.href = blobUrl;
      safeAnchor.download = zipName;
      safeAnchor.rel = 'noopener';
      safeAnchor.style.display = 'none';
      DOC.body.appendChild(safeAnchor);
      safeAnchor.click();
      safeAnchor.remove();
      WIN.setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);

      if (ui) {
        ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
        ui.setBusy(false);
      }
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[sugoiweb-dl] Download error:", err);
    } finally {
      state.running = false;
    }
  }

  /* =========================================================================
   * 6. KHỞI CHẠY (BOOT) & ĐIỀU PHỐI HIỂN THỊ UI
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(20);
    const ui = getUI();

    if (!DOC.fullscreenElement && ui?.panel && ui.panel.parentElement !== DOC.body) {
      DOC.body.appendChild(ui.panel);
    }

    const viewerId = getActiveViewerId();
    if (!isLineupPage() || !viewerId) {
      if (ui?.panel) ui.panel.style.display = "none";
      return;
    }

    setupThumbsWatcher(ui);

    if (ui?.panel) {
      ui.panel.style.display = "block";
    }

    // 🎯 FIX VẤN ĐỀ 2: Nếu chapter này đã nạp rồi -> Bốc từ RAM hiện ngay "Sẵn sàng." ở 0ms!
    if (state.chapterCache.has(viewerId)) {
      const cached = state.chapterCache.get(viewerId);
      state.chapterData = cached;
      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: cached.urls.length,
          status: "Sẵn sàng.",
          format: cached.format || 'jpg'
        });
        ui.setBusy(false);
      }
      return;
    }

    // Nếu là chapter MỚI -> Mới đặt trạng thái Đang kiểm tra...
    if (ui) {
      ui.setBusy(true);
      ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
    }

    try {
      let data = null;
      for (let i = 0; i < 25; i++) {
        data = extractLaymicPages(viewerId);
        if (data && data.urls?.length > 0) break;
        await sleep(150);
      }

      if (!data || !data.urls?.length) {
        throw new Error("Không đọc được số trang của chương.");
      }

      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const testUrl = data.urls[0];
      if (!testUrl) throw new Error("URL trang 1 không hợp lệ.");

      const testBuf = await Utils.fetchBuffer(testUrl, { "Referer": WIN.location.href });
      const realExt = Utils.detectExt(testBuf) || 'jpg';

      data.format = realExt;
      state.chapterData = data;
      state.chapterCache.set(viewerId, data); // 🎯 Lưu vào RAM Cache cho các lần sau

      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: data.urls.length,
          status: "Sẵn sàng.",
          format: realExt
        });
        ui.setBusy(false);
      }
    } catch (e) {
      console.error("[sugoiweb-dl] Boot error:", e);
      if (ui) {
        ui.updateProgress({ status: "Lỗi: " + (e?.message || "không thể tải trang.") });
        ui.setBusy(true);
      }
    }
  }

  // Lắng nghe thay đổi Hash (#laymic01...) và URL khi người dùng bấm mở/đóng viewer
  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute((newUrl) => {
      const viewerId = getActiveViewerId();

      if (!isLineupPage() || !viewerId) {
        const ui = getUI();
        if (ui?.panel) ui.panel.style.display = "none";
        state.chapterData = null;
        state.lastViewerId = "";
        state.lastUrl = "";
        state.running = false;
        return;
      }

      if (state.lastViewerId && state.lastViewerId === viewerId) return;

      state.lastUrl = newUrl;
      state.lastViewerId = viewerId;
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

  // Theo dõi thêm sự kiện hashchange của window để bắt nhịp click mở modal tức thì
  WIN.addEventListener('hashchange', () => {
    const viewerId = getActiveViewerId();
    if (viewerId && viewerId !== state.lastViewerId) {
      state.lastViewerId = viewerId;
      state.chapterData = null;
      boot();
    } else if (!viewerId) {
      const ui = getUI();
      if (ui?.panel) ui.panel.style.display = "none";
    }
  });

  if (DOC.readyState === "loading") {
    DOC.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();