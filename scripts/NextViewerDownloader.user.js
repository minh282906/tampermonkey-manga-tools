// ==UserScript==
// @name         NextViewer Universal Downloader (Manga Kingdom)
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://comic.k-manga.jp/favicon.ico
// @description  Tải manga trên まんが王国 / Manga Kingdom (comic.k-manga.jp).
// @author       anonymous & AI
// @match        https://comic.k-manga.jp/viewer/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      k-manga.jp
// @connect      *.k-manga.jp
// @connect      ws.viewer.k-manga.jp
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN ---
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/NextViewerDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/NextViewerDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/decoders/NextViewerTools.js
// ==/UserScript==

(function nextViewerUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    JPEG_QUALITY: 1.0    // Chất lượng xuất JPG nếu người dùng chọn
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("nextviewer-dl:convert-jpeg") === '1',
    chapterData: null,
    ui: null,
    lastUrl: "",
    lastParamsKey: ""
  };

  /* =========================================================================
   * 1. GIAO DIỆN THEME: CAM MANGA KINGDOM (#FF7000) - NỀN TRẮNG SÁNG
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "nextviewer-dl",
        title: "まんが王国",
        engine: "NEXTVIEWER",
        themeColor: "#FF7000",      
        themeBg: "#ffffff",         
        titleColor: "#E65A00",      
        btnBg: "#FF7000",           
        btnColor: "#ffffff",      
        tabBg: "#FF7000",
        tabColor: "#ffffff",
        topOffset: "55px",
        defaultJpgText: "Xuất file JPG (mặc định PNG)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("nextviewer-dl:convert-jpeg", checked ? '1' : '0');
        }
      };

      state.ui = createUI(uiConfig);
      state.ui.setBusy(true);

      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:${uiConfig.titleColor};letter-spacing:0.3px;">${uiConfig.title}</div>
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
  function isEpisodeUrl() {
    return WIN.location.pathname.includes('/viewer/') && WIN.location.search.includes('p0=');
  }

  function getUrlParams() {
    const sp = new URLSearchParams(WIN.location.search);
    return {
      t: sp.get('p0'),
      o: sp.get('p1'),
      bookId: sp.get('p3') || 'book',
      chapId: sp.get('p4') || '1'
    };
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

  async function getCleanTitle(bookId, chapId) {
    try {
      // 1. Quét thanh điều hướng tiêu đề của web nếu có
      let seriesTitle = cleanString(DOC.querySelector('#ic-title')?.textContent);

      // 2. Kéo trực tiếp tên series chuẩn xác từ trang chi tiết tác phẩm
      if (!seriesTitle && bookId) {
        try {
          const titleHtml = await WIN.fetch(`https://comic.k-manga.jp/title/${bookId}`).then(r => r.text());
          const m = titleHtml.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) 
                 || titleHtml.match(/<title>([^<|｜]+)/i);
          if (m && m[1]) {
            seriesTitle = cleanString(m[1].replace(/\s*[-|｜]\s*無料・試し読み.*$/i, '').replace(/[-|｜]\s*まんが王国.*$/i, ''));
          }
        } catch (e) {}
      }

      if (!seriesTitle) {
        seriesTitle = cleanString(DOC.title.split(/[|｜]/)[0].replace(/[-|｜]\s*まんが王国.*$/i, ''));
      }

      const volumeStr = chapId ? `第${chapId}巻` : "";

      if (seriesTitle && volumeStr) {
        if (seriesTitle.endsWith(volumeStr)) return seriesTitle;
        return `${seriesTitle} - ${volumeStr}`;
      }

      return seriesTitle || volumeStr || `MangaKingdom_${bookId}_${chapId}`;
    } catch (e) {}

    return `MangaKingdom_${bookId || 'Book'}`;
  }

  /* =========================================================================
   * 3. KẾT NỐI WEBSOCKET BCP & LẤY MANIFEST
   * ========================================================================= */
  function fetchManifestViaWs(params) {
    const Tools = WIN.NextViewerTools || window.NextViewerTools;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket('wss://ws.viewer.k-manga.jp/');
      ws.binaryType = 'arraybuffer';
      let stage = 0;

      const timer = setTimeout(() => {
        try { ws.close(); } catch(e){}
        reject(new Error("Timeout kết nối WebSocket"));
      }, 15000);

      ws.onmessage = (e) => {
        try {
          const frame = Tools.parseBcpFrame(e.data);
          // Đợi nhận BCP000 greeting -> mới gửi REQUEST HEADER
          if (stage === 0 && frame.isGreeting) {
            stage = 1;
            ws.send(`REQUEST HEADER\nt=${params.t}&fn=64kb_QVGA_h&o=${params.o}`);
            return;
          }
          if (stage === 1) {
            clearTimeout(timer);
            ws.close();
            resolve(frame.body);
          }
        } catch (err) {
          clearTimeout(timer);
          ws.close();
          reject(err);
        }
      };

      ws.onerror = (err) => {
        clearTimeout(timer);
        reject(err);
      };
    });
  }

  /* =========================================================================
   * 4. TIẾN TRÌNH TẢI CHÍNH & GIẢI MÃ MA TRẬN LCG CANVAS VÀO ZIP
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    const params = getUrlParams();
    if (!params.t || !params.o) {
      if (ui) ui.updateProgress({ status: "Lỗi: Không tìm thấy tham số phiên đọc." });
      return;
    }

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let data = state.chapterData;
      if (!data || !data.chunks?.length) {
        const manifest = await fetchManifestViaWs(params);
        const total = manifest.numOfScenes || manifest.contentInfos?.length || 0;
        const chunks = manifest.contentInfos.slice().sort((a, b) => Number(a.startSceneNo) - Number(b.startSceneNo));
        data = { manifest, chunks, total };
        state.chapterData = data;
      }

      const { manifest, chunks, total } = data;
      if (!total) throw new Error("Không có trang hợp lệ để tải.");

      const useJpeg = Boolean(state.convertJpeg);
      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const Tools = window.NextViewerTools || globalThis.NextViewerTools;
      const zip = new ZipClass();

      // Đính kèm file định danh ID sách theo Golden Rule 2
      zip.addFile(`${params.bookId}_${params.chapId}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total, status: "Đang tải..." });

      let completedPages = 0;

      // Mở 1 kết nối WebSocket truyền phát tuần tự các gói chunk
      await new Promise((resolve, reject) => {
        const ws = new WebSocket('wss://ws.viewer.k-manga.jp/');
        ws.binaryType = 'arraybuffer';
        let chunkIdx = 0;
        let isWaitingData = false;

        ws.onopen = () => {};

        ws.onmessage = async (e) => {
          try {
            const frame = Tools.parseBcpFrame(e.data);

            // 1. Nhận BCP000 greeting -> Gửi request chunk đầu tiên
            if (frame.isGreeting) {
              if (chunkIdx < chunks.length) {
                isWaitingData = true;
                ws.send(`REQUEST DATA\nt=${params.t}&fn=${chunks[chunkIdx].name}&o=${params.o}&dk=${manifest.dk}`);
              }
              return;
            }

            // 2. Nhận dữ liệu đa tầng của chunk
            if (isWaitingData && frame.chunks) {
              isWaitingData = false;
              const scenes = frame.body?.scenes || [];

              // Xử lý toàn bộ các trang ảnh có trong gói chunk
              for (let sIdx = 0; sIdx < scenes.length; sIdx++) {
                const scene = scenes[sIdx];
                const rawChunk = frame.chunks[sIdx];
                if (!scene || !rawChunk) continue;

                // 🎯 ZERO-TRUST: Dùng slice() cô lập mảng JPEG sạch, nhận diện MIME thực tế
                const cleanBytes = rawChunk.slice();
                const mime = Utils.detectMimeType(cleanBytes);
                const img = await Utils.loadImage(cleanBytes, mime);

                const imageMeta = scene.images?.[0] || {};
                const isScrambled = Number(imageMeta.key) > 0;
                let finalCanvas;

                if (isScrambled) {
                  // Ráp ma trận LCG + Gutter 2px
                  const res = Tools.descrambleCanvas(img, imageMeta.width, imageMeta.height, imageMeta.key);
                  finalCanvas = res.canvas;
                } else {
                  // Trang không xáo trộn (như trang lót trắng): Vẽ 1:1
                  finalCanvas = DOC.createElement('canvas');
                  finalCanvas.width = img.naturalWidth || img.width;
                  finalCanvas.height = img.naturalHeight || img.height;
                  const cCtx = finalCanvas.getContext('2d', { alpha: false });
                  cCtx.imageSmoothingEnabled = false;
                  cCtx.drawImage(img, 0, 0);
                }

                // Xuất mảng byte vào ZIP (Mặc định PNG Lossless / Checkbox JPG)
                const mimeType = useJpeg ? 'image/jpeg' : 'image/png';
                const outExt = useJpeg ? 'jpg' : 'png';
                const blob = await new Promise(r => finalCanvas.toBlob(r, mimeType, CONFIG.JPEG_QUALITY));

                finalCanvas.width = 0;
                finalCanvas.height = 0;

                const pageNo = scene.sceneNo || (completedPages + 1);
                zip.addFile(`${pageNo}.${outExt}`, new Uint8Array(await blob.arrayBuffer()));

                completedPages++;
                if (ui) ui.updateProgress({ completed: completedPages, total, status: "Đang tải..." });
              }

              // Gửi tiếp request cho chunk kế tiếp
              chunkIdx++;
              if (chunkIdx < chunks.length) {
                isWaitingData = true;
                ws.send(`REQUEST DATA\nt=${params.t}&fn=${chunks[chunkIdx].name}&o=${params.o}&dk=${manifest.dk}`);
              } else {
                ws.close();
                resolve();
              }
            }
          } catch (err) {
            ws.close();
            reject(err);
          }
        };

        ws.onerror = (err) => {
          try { ws.close(); } catch(e){}
          reject(err);
        };
      });

      if (completedPages === 0) {
        throw new Error("Không thể tải bất kỳ trang ảnh nào từ WebSocket.");
      }

      if (ui) ui.updateProgress({ completed: total, total, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      // Đặt tên ZIP chuẩn: [Tên Truyện] - [Tên Tập/Chap].zip
      const title = await getCleanTitle(params.bookId, params.chapId);
      const finalFileName = `${title}.zip`;
      zip.download(finalFileName);

      if (ui) {
        ui.updateProgress({ completed: total, total, status: "Hoàn tất." });
        ui.setBusy(false);
      }
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[nextviewer-dl] Download error:", err);
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

    if (!isEpisodeUrl()) {
      if (ui?.panel) ui.panel.style.display = "none";
      return;
    }

    if (ui?.panel) {
      ui.panel.style.display = "block";
      ui.setBusy(true);
      // Giai đoạn 1 chuẩn Golden Rule 3: Khóa cứng 0/0
      ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
    }

    const params = getUrlParams();
    if (!params.t || !params.o) return;

    try {
      let manifest = null;
      let retries = 0;

      while (retries < 25) {
        try {
          manifest = await fetchManifestViaWs(params);
          if (manifest && (manifest.numOfScenes || manifest.contentInfos?.length)) break;
        } catch (e) {}
        await sleep(150);
        retries++;
      }

      if (!manifest) throw new Error("Không thể kết nối máy chủ WebSocket Beaglee.");

      const total = manifest.numOfScenes || manifest.contentInfos?.length || 0;
      const chunks = manifest.contentInfos.slice().sort((a, b) => Number(a.startSceneNo) - Number(b.startSceneNo));
      state.chapterData = { manifest, chunks, total };

      if (ui) {
        await sleep(80);
        ui.updateProgress({
          completed: 0,
          total: total,
          status: "Sẵn sàng."
        });
        ui.setBusy(false);
      }
    } catch (err) {
      console.error("[nextviewer-dl] Boot error:", err);
      if (ui) {
        ui.updateProgress({ status: "Lỗi: " + (err?.message || "Không thể tải trang.") });
        ui.setBusy(true);
      }
    }
  }

  // Hook SPA History & RouteWatcher
  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute((newUrl) => {
      if (!isEpisodeUrl()) {
        const ui = getUI();
        if (ui?.panel) ui.panel.style.display = "none";
        state.chapterData = null;
        state.lastParamsKey = "";
        state.lastUrl = "";
        state.running = false;
        return;
      }

      const params = getUrlParams();
      const currentKey = `${params.bookId}_${params.chapId}_${params.t}`;
      if (state.lastParamsKey && state.lastParamsKey === currentKey) return;

      state.lastUrl = newUrl;
      state.lastParamsKey = currentKey;
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