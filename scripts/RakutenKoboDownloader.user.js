// ==UserScript==
// @name         Rakuten Kobo Manga Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      3.0.0
// @icon         https://www.google.com/s2/favicons?domain=kobo.com&sz=128
// @description  Tải manga trên Rakuten Kobo Web Reader
// @author       anonymous & AI
// @match        https://readnow.kobo.com/*
// @match        https://*.kobo.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      readnow.kobo.com
// @connect      getbook.kobo.com
// @connect      readingservices.kobo.com
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/RakutenKoboDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/RakutenKoboDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function rakutenKoboUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    CHUNK_SIZE: 5 * 1024 * 1024, // Dải chunk 5MB tối ưu I/O mạng
    CHUNK_DELAY_MS: 250,         // Delay 250ms chống Cloudflare rate-limit
    JPEG_QUALITY: 0.95
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("kobo-dl:convert-jpeg") === '1',
    bookMetadata: null,
    totalImages: 0,
    ui: null
  };

  /* =========================================================================
   * 1. GIAO DIỆN UNIVERSAL UI CHUẨN RAKUTEN KOBO (THEME ĐỎ #bf0000)
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "kobo-dl",
        title: "Rakuten Kobo",
        engine: "RAKUTEN",
        themeColor: "#bf0000",              // Đỏ thương hiệu Rakuten Kobo
        themeBg: "#ffffff",                 // Nền trắng sáng
        titleColor: "#bf0000",              // Chữ đỏ đậm
        btnBg: "#bf0000",
        btnColor: "#ffffff",
        topOffset: "55px",
        defaultJpgText: "Xuất file JPG (ảnh gốc là JPG)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("kobo-dl:convert-jpeg", checked ? '1' : '0');
        }
      };

      state.ui = createUI(uiConfig);
      state.ui.updateFormatUI('jpg');

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
   * 2. BỘ HỖ TRỢ XỬ LÝ CHUỖI & TÊN FILE THEO GOLDEN RULE 1 & 2
   * ========================================================================= */
  function isReaderUrl() {
    return WIN.location.hostname.includes('readnow.kobo.com') || WIN.location.pathname.length > 20;
  }

  function getProductId() {
    const match = WIN.location.pathname.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
    return match ? match[1] : "kobo_book";
  }

  function getCleanSessionId() {
    try {
      // Đọc trực tiếp document.cookie của tab (vượt qua rào cản sandbox của unsafeWindow)
      const cookieStr = String((typeof document !== 'undefined' ? document.cookie : '') + '; ' + (DOC?.cookie || ''));
      
      const match = cookieStr.match(/sessionId=([a-f0-9-]+)/i)
                 || cookieStr.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);

      if (match && match[1]) {
        return match[1].replace(/-/g, '').trim().toLowerCase();
      }

      if (WIN.__kobo_clean_session_id) return WIN.__kobo_clean_session_id;
    } catch (e) {
      console.error("[kobo-dl] Lỗi đọc cookie session:", e);
    }
    return null;
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

  function getCleanTitle(meta) {
    try {
      let series = meta?.productMetadata?.series || "";
      let seriesNum = meta?.productMetadata?.seriesNumber;
      let rawTitle = meta?.productMetadata?.title || meta?.title || "";

      // 1. Ưu tiên bóc tách từ Metadata chính thức của NXB
      if (series && seriesNum !== undefined && seriesNum !== null) {
        return `${cleanString(series)} - ${seriesNum}`;
      }

      // 2. Phân tích từ rawTitle
      if (!rawTitle) {
        const titleEl = DOC.querySelector('[data-test-id="reader-headerBar-title"], .RXHeaderBar_title h1, h1');
        if (titleEl) rawTitle = titleEl.textContent.trim();
      }
      if (!rawTitle) rawTitle = DOC.title || "";

      rawTitle = rawTitle.replace(/\s*[-|｜]\s*Rakuten\s*Kobo.*$/i, '').trim();
      rawTitle = rawTitle.replace(/\[電子書籍版\]/gi, '').trim();

      const match = rawTitle.match(/^(.*?)(?:[\s:：]+[-－–—/]?[\s:：]*|[\s:：]+|[（\(])((?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\.]+\s*(?:話|巻|章|節|部|エピソード|分冊版|単話)?.*)[）\)]?$/i);
      if (match && match[1] && match[2]) {
        const s = cleanString(match[1]);
        const e = cleanString(match[2]).replace(/^[（\(]|[）\)]$/g, '').trim();
        if (s && e) return `${s} - ${e}`;
      }

      return cleanString(rawTitle) || `Kobo_${getProductId()}`;
    } catch (e) {}

    return `Kobo_${getProductId()}`;
  }

  /* =========================================================================
   * 3. API READCONTENT & NẠP WASM TỰ ĐỘNG
   * ========================================================================= */
  async function fetchBookMetadata(productId) {
    const apiUrl = `https://readingservices.kobo.com/ReadContent/${productId}`;
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: apiUrl,
        headers: { "Accept": "application/json", "Referer": WIN.location.href },
        responseType: "json",
        onload: (res) => {
          if (res.status >= 200 && res.status < 300 && res.response) {
            resolve(res.response);
          } else {
            reject(new Error(`Lỗi tải Metadata (HTTP ${res.status})`));
          }
        },
        onerror: reject,
        ontimeout: () => reject(new Error("Timeout tải Metadata"))
      });
    });
  }

  async function getWasmInstance(productId) {
    // 1. Ưu tiên lấy trực tiếp máy ảo Wasm đã được trang web khởi tạo sẵn
    if (WIN.wasm_bindgen && typeof WIN.wasm_bindgen.get === 'function') {
      return WIN.wasm_bindgen;
    }

    // 2. Dự phòng: Tự kéo gói gjp và biên dịch trong RAM (0ms)
    const gjpUrl = `https://readingservices.kobo.com/ReadContent/${productId}/gjp`;
    const gjpRes = await new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: gjpUrl,
        headers: { "Accept": "application/json", "Referer": WIN.location.href },
        responseType: "json",
        onload: (r) => (r.status === 200 && r.response?.gjp) ? resolve(r.response) : reject(new Error(`HTTP ${r.status}`)),
        onerror: reject
      });
    });

    let b64 = gjpRes.gjp.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const wasmBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));

    if (typeof WIN.wasm_bindgen === 'function') {
      await WIN.wasm_bindgen(wasmBytes);
      return WIN.wasm_bindgen;
    }

    throw new Error("Không thể khởi tạo máy ảo Wasm giải mã.");
  }

  /* =========================================================================
   * 4. BỘ TẢI CHUNKED RANGE & PARSE ZIP THUẦN JS TRONG RAM
   * ========================================================================= */
  function downloadEpubChunked(url, onProgress) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "HEAD",
        url: url,
        headers: { "Referer": WIN.location.href },
        onload: async (headRes) => {
          const totalSize = parseInt(headRes.responseHeaders.match(/content-length:\s*(\d+)/i)?.[1] || "75000000", 10);
          const fullBuffer = new Uint8Array(totalSize);
          let downloaded = 0;

          while (downloaded < totalSize) {
            const end = Math.min(downloaded + CONFIG.CHUNK_SIZE - 1, totalSize - 1);

            await new Promise((resChunk, rejChunk) => {
              GM_xmlhttpRequest({
                method: "GET",
                url: url,
                headers: {
                  "Range": `bytes=${downloaded}-${end}`,
                  "Cache-Control": "no-cache",
                  "Referer": WIN.location.href
                },
                responseType: "arraybuffer",
                onload: (res) => {
                  if (res.status === 206 || res.status === 200) {
                    const chunk = new Uint8Array(res.response);
                    fullBuffer.set(chunk, downloaded);
                    downloaded += chunk.length;
                    if (onProgress) onProgress(downloaded, totalSize);
                    resChunk();
                  } else {
                    rejChunk(new Error(`HTTP ${res.status}`));
                  }
                },
                onerror: rejChunk,
                ontimeout: () => rejChunk(new Error("Timeout chunk tải EPUB"))
              });
            });

            await sleep(CONFIG.CHUNK_DELAY_MS);
          }

          resolve(fullBuffer.buffer);
        },
        onerror: reject
      });
    });
  }

  async function parseEpubZipInMemory(epubBuffer) {
    const view = new DataView(epubBuffer);
    const uint8 = new Uint8Array(epubBuffer);
    const len = epubBuffer.byteLength;

    // 1. Tìm End of Central Directory (0x06054b50)
    let eocd = -1;
    for (let i = len - 22; i >= Math.max(0, len - 65558); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd === -1) throw new Error("File EPUB hỏng (không tìm thấy ZIP EOCD).");

    const totalEntries = view.getUint16(eocd + 10, true);
    const cdOffset = view.getUint32(eocd + 16, true);

    let cur = cdOffset;
    const dec = new TextDecoder('utf-8');
    const imageFiles = [];

    // 2. Duyệt qua Central Directory bóc tách các file ảnh
    for (let i = 0; i < totalEntries; i++) {
      if (view.getUint32(cur, true) !== 0x02014b50) break;
      const method = view.getUint16(cur + 10, true);
      const compSize = view.getUint32(cur + 20, true);
      const nameLen = view.getUint16(cur + 28, true);
      const extraLen = view.getUint16(cur + 30, true);
      const commentLen = view.getUint16(cur + 32, true);
      const localOffset = view.getUint32(cur + 42, true);

      const name = dec.decode(uint8.subarray(cur + 46, cur + 46 + nameLen));

      if (/\.(jpe?g|png|webp)$/i.test(name)) {
        const locNameLen = view.getUint16(localOffset + 26, true);
        const locExtraLen = view.getUint16(localOffset + 28, true);
        const dataStart = localOffset + 30 + locNameLen + locExtraLen;
        imageFiles.push({
          path: name,
          method: method,
          bytes: uint8.subarray(dataStart, dataStart + compSize)
        });
      }
      cur += 46 + nameLen + extraLen + commentLen;
    }

    // 3. GOLDEN RULE 2: GHIM BÌA TRUYỆN (COVER) LÊN ĐẦU, SAU ĐÓ XẾP THEO THỨ TỰ TỰ NHIÊN
    imageFiles.sort((a, b) => {
      const aIsCover = /cover/i.test(a.path);
      const bIsCover = /cover/i.test(b.path);
      if (aIsCover && !bIsCover) return -1;
      if (!aIsCover && bIsCover) return 1;
      return a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' });
    });

    return imageFiles;
  }

  /* =========================================================================
   * 5. TIẾN TRÌNH TẢI CHÍNH
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      const totalPagesEst = state.totalImages || DOC.querySelectorAll('#ReadingOrderView .ReadingItem, [id^="p_"], #p-cover').length || 180;
      if (ui) ui.updateProgress({ completed: 0, total: totalPagesEst, status: "Đang tải..." });

      const productId = getProductId();

      // 1. Lấy Session ID (32 hex)
      const cleanSessionId = getCleanSessionId();
      if (!cleanSessionId) {
        throw new Error("Không tìm thấy Session ID trong cookie. Vui lòng thử lật 1 trang rồi bấm Tải lại!");
      }

      // 2. Lấy Metadata và Link tải EPUB
      if (!state.bookMetadata) {
        state.bookMetadata = await fetchBookMetadata(productId);
      }
      const meta = state.bookMetadata;
      const epubUrl = meta?.contentDownloadInfo?.downloadUrl;
      if (!epubUrl) throw new Error("Không lấy được đường dẫn tải EPUB từ API.");

      // 3. Nạp Wasm giải mã
      const wasm = await getWasmInstance(productId);

      // 4. Giai đoạn 1: Tải EPUB ngầm
      const halfPages = Math.floor(totalPagesEst / 2);
      const epubBuffer = await downloadEpubChunked(epubUrl, (downloaded, totalBytes) => {
        const currentCount = Math.min(halfPages, Math.floor((downloaded / totalBytes) * halfPages));
        if (ui) ui.updateProgress({ completed: currentCount, total: totalPagesEst, status: "Đang tải..." });
      });

      // 5. Giải nén danh sách file ảnh trong RAM (cover luôn là trang 1)
      const imageFiles = await parseEpubZipInMemory(epubBuffer);
      const totalPages = imageFiles.length;
      if (!totalPages) throw new Error("Không tìm thấy file ảnh nào trong gói EPUB.");

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const zip = new ZipClass();

      // GOLDEN RULE 2: Luôn có 1 file .txt rỗng mang tên ID định danh ở thư mục gốc
      zip.addFile(`${productId}.txt`, new Uint8Array(0));

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      // 6. Chạy vòng lặp giải mã Wasm đồng loạt toàn bộ ảnh trong RAM
      for (let i = 0; i < totalPages; i++) {
        const file = imageFiles[i];
        let encryptedBytes = file.bytes;

        // Giải nén Deflate nếu cần
        if (file.method === 8) {
          const ds = new DecompressionStream('deflate-raw');
          const writer = ds.writable.getWriter();
          writer.write(encryptedBytes);
          writer.close();
          const decompressedBuf = await new Response(ds.readable).arrayBuffer();
          encryptedBytes = new Uint8Array(decompressedBuf);
        }

        // Dò đường dẫn khớp với wasm
        const pathVariants = [
          file.path,
          file.path.replace(/^OEBPS\//i, ''),
          file.path.split('/').pop()
        ];
        const matchedPath = pathVariants.find(p => wasm.should_get && wasm.should_get(p)) || file.path;

        // GIẢI MÃ TOÀN BỘ CÁC FILE ẢNH (KỂ CẢ COVER.JPG) QUA WASM
        let decryptedBytes = encryptedBytes;
        try {
          decryptedBytes = wasm.get(cleanSessionId, matchedPath, encryptedBytes);
        } catch(e) {
          try {
            decryptedBytes = wasm.get(cleanSessionId, matchedPath, encryptedBytes.buffer);
          } catch(err2) {
            decryptedBytes = encryptedBytes;
          }
        }

        // Nhận diện đuôi file thực tế qua Magic Bytes (FF D8 là JPG)
        const Utils = window.MangaUtils || globalThis.MangaUtils;
        const ext = Utils?.detectExt(decryptedBytes.buffer) || 'jpg';

        zip.addFile(`${i + 1}.${ext}`, decryptedBytes);

        if (ui) {
          const decryptProgress = halfPages + Math.floor(((i + 1) / totalPages) * (totalPages - halfPages));
          ui.updateProgress({ completed: Math.min(decryptProgress, totalPages), total: totalPages, status: "Đang tải..." });
        }
      }

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      const zipName = `${getCleanTitle(meta)}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[kobo-dl] Download error:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * 6. KHỞI CHẠY VÀ THEO DÕI SPA
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(20);
    const ui = getUI();

    if (!isReaderUrl()) {
      if (ui?.panel) ui.panel.style.display = "none";
      return;
    }

    if (ui?.panel) {
      ui.panel.style.display = "block";
      ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
    }

    const productId = getProductId();

    try {
      state.bookMetadata = await fetchBookMetadata(productId);
    } catch(e) {}

    // Chờ Kobo dựng xong danh sách trang trong DOM để lấy số trang thật của cuốn truyện này
    let realTotal = 0;
    for (let r = 0; r < 35; r++) {
      realTotal = DOC.querySelectorAll('#ReadingOrderView .ReadingItem, [id^="p_"], #p-cover').length;
      if (realTotal > 0) break;
      await sleep(150);
    }

    if (realTotal > 0) {
      state.totalImages = realTotal;
      if (ui) ui.updateProgress({ completed: 0, total: realTotal, status: "Sẵn sàng." });
    } else {
      if (ui) ui.updateProgress({ status: "Sẵn sàng." });
    }
  }

  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute(() => {
      state.running = false;
      state.bookMetadata = null;
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