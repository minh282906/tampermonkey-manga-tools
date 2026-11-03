// ==UserScript==
// @name         U-Next Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.2.0
// @icon         https://video.unext.jp/apple-touch-icon.png
// @description  Tải manga trên U-NEXT (video.unext.jp).
// @author       anonymous & AI
// @match        https://video.unext.jp/book/view/*
// @match        https://*.unext.jp/book/view/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      unext.jp
// @connect      *.unext.jp
// @connect      *.nxtv.jp
// @connect      cc.unext.jp
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function unextUniversalDownloader() {
  'use strict';

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  // Bộ nhớ đệm vĩnh viễn theo bookCode/sakuhinCode (Không bao giờ bị xóa khi chuyển trang)
  const cosmoCache = new Map();
  let lastCapturedCosmo = null;

  const state = {
    running: false,
    ui: null,
    lastUrl: "",
    lastBookCode: ""
  };

  /* =========================================================================
   * MÔ HÌNH 3: SINGLE-FLIGHT PASSIVE HOOK ĐÓN GÓI TIN COSMO_BOOKVIEWER (0ms)
   * ========================================================================= */
  function parseCosmoPayload(text) {
    try {
      if (typeof text === 'string' && text.includes('bookTitle') && text.includes('sakuhinCode')) {
        const json = JSON.parse(text);
        const bt = json?.data?.bookTitle;
        if (bt) {
          const data = {
            seriesTitle: bt.name || "",
            episodeTitle: bt.book?.name || "",
            sakuhinCode: bt.sakuhinCode || "",
            bookCode: bt.book?.code || ""
          };
          if (data.bookCode) cosmoCache.set(data.bookCode, data);
          if (data.sakuhinCode) cosmoCache.set(data.sakuhinCode, data);
          lastCapturedCosmo = data;
        }
      }
    } catch (e) {}
  }

  const origFetch = WIN.fetch;
  if (typeof origFetch === 'function') {
    WIN.fetch = async function(...args) {
      const res = await origFetch.apply(this, args);
      try {
        const u = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        if (u.includes('cosmo_bookViewer')) {
          res.clone().text().then(parseCosmoPayload).catch(() => {});
        }
      } catch (e) {}
      return res;
    };
  }

  const origXhrOpen = WIN.XMLHttpRequest?.prototype?.open;
  const origXhrSend = WIN.XMLHttpRequest?.prototype?.send;
  if (origXhrOpen && origXhrSend) {
    WIN.XMLHttpRequest.prototype.open = function(method, url) {
      this._reqUrl = typeof url === 'string' ? url : String(url);
      return origXhrOpen.apply(this, arguments);
    };
    WIN.XMLHttpRequest.prototype.send = function() {
      this.addEventListener('load', () => {
        if (this._reqUrl && this._reqUrl.includes('cosmo_bookViewer')) {
          parseCosmoPayload(this.responseText);
        }
      });
      return origXhrSend.apply(this, arguments);
    };
  }

  /* =========================================================================
   * 1. GIAO DIỆN THEME U-NEXT
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "unext-dl",
        title: "U-NEXT",
        engine: "MEDIADO UBOOK",
        themeColor: "#000A17",
        themeBg: "#000A17",     
        titleColor: "#ffffff",  
        btnBg: "#141E2B",
        btnColor: "#ffffff",
        tabBg: "#141E2B",
        tabColor: "#ffffff",
        topOffset: "76px",
        onDownload: startDownload
      };

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
   * 2. BỘ HỖ TRỢ XỬ LÝ CHUỖI & TIÊU ĐỀ
   * ========================================================================= */
  function isReaderUrl() {
    return WIN.location.pathname.includes('/book/view/');
  }

  function getBookCodes() {
    const m = WIN.location.pathname.match(/\/book\/view\/([^/?#]+)\/([^/?#]+)/i);
    return {
      sakuhinCode: m ? m[1] : "",
      bookCode: m ? m[2] : ""
    };
  }

  function cleanString(str) {
    if (!str) return "";
    return str
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/【(?!(?:フルカラー版|カラー版|完全版|特装版))[^】]*】/gi, ' ')
      .replace(/[\\/*?:"<>|]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  // Tách ghép tiêu đề
  function buildFinalTitle(manager, bookCode, sakuhinCode) {
    const cosmo = (bookCode && cosmoCache.get(bookCode)) || 
                  (sakuhinCode && cosmoCache.get(sakuhinCode)) || 
                  lastCapturedCosmo;

    let series = cleanString(cosmo?.seriesTitle);
    let episode = cleanString(cosmo?.episodeTitle);

    // 1. Ưu tiên bóc tách từ gói tin mạng cosmo_bookViewer (Chuẩn 100% mọi NXB)
    if (series && episode) {
      if (episode.startsWith(series)) {
        episode = cleanString(episode.substring(series.length).replace(/^[\s\-_:：\u3000・･]+/, ''));
      }
      return episode ? `${series} - ${episode}` : series;
    }

    if (series && !episode) return series;

    // 2. Dự phòng nếu file ubook có sẵn tiêu đề (Square Enix)
    const raw = cleanString(manager?.book?.metadata?.title || DOC.title || "");
    const m = raw.match(/^(.*?)(?:[\s\u3000]+)((?:(?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\.]+\s*(?:話|回|巻|章|節|部|エピソード|分冊版|単話)?.*)|(?:TRIGGER|CHAPTER|EPISODE|ACT|ROUND|VOL)[\.\s]*\d+.*)$/i);
    if (m && m[1].trim() && m[2].trim()) {
      return `${cleanString(m[1])} - ${cleanString(m[2])}`;
    }

    return raw || `UNext_${bookCode || 'Book'}`;
  }

  /* =========================================================================
   * 3. REACT FIBER TRAVERSAL & MỒI KHÓA DRM TRONG RAM
   * ========================================================================= */
  function findManager() {
    const swiperEl = DOC.querySelector('.swiper');
    if (!swiperEl) return null;

    const fiberKey = Object.keys(swiperEl).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    if (!fiberKey) return null;

    let curr = swiperEl[fiberKey];
    while (curr) {
      if (curr.memoizedProps?.manager) {
        return curr.memoizedProps.manager;
      }
      curr = curr.return;
    }
    return null;
  }

  // Nhận diện chương bị khóa / chưa mua
  function checkPaywall() {
    if (DOC.querySelector('.swiper')) return false;

    const bodyText = DOC.body?.innerText || "";
    const isLocked = bodyText.includes("回復待ち") || 
                     bodyText.includes("で購入") || 
                     bodyText.includes("初回購入特典") || 
                     bodyText.includes("選択して購入");

    const hasPaywallBtn = Boolean(DOC.querySelector('[data-testid*="purchase"], button[class*="purchase"]'));
    return isLocked || hasPaywallBtn;
  }

  async function ensureAllKeysLoaded(manager) {
    const parser = manager?.parser;
    const drmContext = parser?.drmContext;
    const fileList = parser?.drmParser?.drmHeader?.encryptedFileList;
    if (!fileList || !drmContext) return;

    const requiredKeyIds = new Set();
    const keyIdToFilePath = {};

    for (const [path, info] of Object.entries(fileList)) {
      if (info.keyId) {
        requiredKeyIds.add(info.keyId);
        if (!keyIdToFilePath[info.keyId]) keyIdToFilePath[info.keyId] = path;
      }
    }

    const loadedKeys = Object.keys(drmContext.keys || {});
    const missingKeyIds = [...requiredKeyIds].filter(k => !loadedKeys.includes(k));

    if (missingKeyIds.length > 0) {
      await Promise.all(missingKeyIds.map(async (kid) => {
        const sampleFile = keyIdToFilePath[kid];
        try {
          await parser.getBinaryObject(sampleFile);
        } catch (e) {}
      }));
    }
  }

  function base64ToUint8Array(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  /* =========================================================================
   * 4. BỘ PARSE .UBOOK NGUYÊN KHỐI (PKZIP) TRONG RAM
   * ========================================================================= */
  function parseUbookArchive(buffer) {
    const view = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    const len = buffer.byteLength;

    let eocd = -1;
    for (let i = len - 22; i >= Math.max(0, len - 65558); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd === -1) throw new Error("Gói .ubook không hợp lệ.");

    const totalEntries = view.getUint16(eocd + 10, true);
    const cdOffset = view.getUint32(eocd + 16, true);
    let cur = cdOffset;
    const dec = new TextDecoder('utf-8');
    const entryMap = new Map();

    for (let i = 0; i < totalEntries; i++) {
      if (view.getUint32(cur, true) !== 0x02014b50) break;
      const method = view.getUint16(cur + 10, true);
      const compSize = view.getUint32(cur + 20, true);
      const nameLen = view.getUint16(cur + 28, true);
      const extraLen = view.getUint16(cur + 30, true);
      const commentLen = view.getUint16(cur + 32, true);
      const localOffset = view.getUint32(cur + 42, true);

      const name = dec.decode(u8.subarray(cur + 46, cur + 46 + nameLen));
      entryMap.set(name, { name, method, compSize, localOffset });

      cur += 46 + nameLen + extraLen + commentLen;
    }

    function getEntryBytes(entry) {
      const locNameLen = view.getUint16(entry.localOffset + 26, true);
      const locExtraLen = view.getUint16(entry.localOffset + 28, true);
      const start = entry.localOffset + 30 + locNameLen + locExtraLen;
      return u8.subarray(start, start + entry.compSize);
    }

    return { entryMap, getEntryBytes };
  }

  // Tải ubook bắt sự kiện tiến trình (onProgress) phục vụ Giai đoạn 1 (0 -> N/2)
  function fetchUbookWithProgress(url, onProgress) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: url,
        responseType: "arraybuffer",
        headers: { "Referer": WIN.location.href },
        onprogress: (pe) => {
          if (pe.lengthComputable && onProgress) {
            onProgress(pe.loaded, pe.total);
          }
        },
        onload: res => (res.status >= 200 && res.status < 300 && res.response) ? resolve(res.response) : reject(new Error(`HTTP ${res.status}`)),
        onerror: () => reject(new Error("Lỗi tải tệp .ubook")),
        ontimeout: () => reject(new Error("Timeout tải .ubook"))
      });
    });
  }

  /* =========================================================================
   * 5. TIẾN TRÌNH TẢI CHÍNH (TIẾN TRÌNH KÉP CỦA KOBO & ZERO-COPY 0ms)
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    const manager = findManager();
    if (!manager) {
      if (ui) ui.updateProgress({ status: "Lỗi: Không tìm thấy U-Next manager." });
      return;
    }

    const pageList = manager.pages || [];
    const totalPages = pageList.length;
    if (!totalPages) return;

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const { bookCode, sakuhinCode } = getBookCodes();
      const parser = manager.parser;
      const bookUrl = parser?.url;
      if (!bookUrl) throw new Error("Không tìm thấy đường dẫn ubook.");

      await ensureAllKeysLoaded(manager);

      const context = parser.drmContext;
      const keys = context?.keys || {};
      const keyIds = Object.keys(keys);
      if (keyIds.length === 0) throw new Error("Chưa nạp được khóa DRM.");

      const keyMap = {};
      for (const kid of keyIds) {
        const cryptoKey = keys[kid];
        const rawKey = await WIN.crypto.subtle.exportKey("raw", cryptoKey);
        keyMap[kid] = await WIN.crypto.subtle.importKey("raw", rawKey, { name: "AES-CBC" }, false, ["decrypt"]);
      }

      // GIAI ĐOẠN 1 (0 -> N/2): Tải file .ubook ngầm, thanh số nhảy mượt theo lượng byte
      const halfPages = Math.floor(totalPages / 2);
      const ubookBuffer = await fetchUbookWithProgress(bookUrl, (loaded, totalBytes) => {
        if (totalBytes > 0 && ui) {
          const count = Math.min(halfPages, Math.floor((loaded / totalBytes) * halfPages));
          ui.updateProgress({ completed: count, total: totalPages, status: "Đang tải..." });
        }
      });

      // GIAI ĐOẠN 2 (N/2 -> N): Giải mã AES-CBC đồng loạt trong RAM
      const { entryMap, getEntryBytes } = parseUbookArchive(ubookBuffer);
      const encryptedFileList = parser.drmParser?.drmHeader?.encryptedFileList || {};

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = WIN.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file định danh ${bookCode}.txt ở gốc ZIP
      zip.addFile(`${bookCode || 'book'}.txt`, new Uint8Array(0));

      for (let i = 0; i < totalPages; i++) {
        const pageItem = pageList[i];
        const filePath = pageItem?.image?.src;
        if (!filePath) continue;

        const info = encryptedFileList[filePath];
        const entry = entryMap.get(filePath);
        if (!entry) continue;

        let cleanBytes = null;

        if (info && info.keyId && keyMap[info.keyId]) {
          const encryptedBytes = getEntryBytes(entry);
          const iv = base64ToUint8Array(info.iv);
          const aesKey = keyMap[info.keyId];

          const decryptedBuf = await WIN.crypto.subtle.decrypt(
            { name: "AES-CBC", iv },
            aesKey,
            encryptedBytes
          );

          cleanBytes = new Uint8Array(decryptedBuf);
          if (info.originalFileSize && cleanBytes.length > info.originalFileSize) {
            cleanBytes = cleanBytes.slice(0, info.originalFileSize);
          }
        } else {
          cleanBytes = getEntryBytes(entry);
        }

        const ext = Utils.detectExt(cleanBytes.buffer);
        zip.addFile(`${i + 1}.${ext}`, cleanBytes);

        // Thanh tiến trình tịnh tiến mượt mà từ N/2 -> N
        if (ui) {
          const currentCount = halfPages + Math.floor(((i + 1) / totalPages) * (totalPages - halfPages));
          ui.updateProgress({ completed: Math.min(currentCount, totalPages), total: totalPages, status: "Đang tải..." });
        }
      }

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      // Đặt tên ZIP chuẩn: [Tên Bộ Truyện] - [Tên Chap].zip
      const finalTitle = buildFinalTitle(manager, bookCode, sakuhinCode);
      const zipName = `${finalTitle}.zip`;

      zip.download(zipName);

      if (ui) {
        ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
        ui.setBusy(false);
      }
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[unext-dl] Download error:", err);
    } finally {
      state.running = false;
    }
  }

  /* =========================================================================
   * 6. KHỞI CHẠY (BOOT) & THEO DÕI SPA
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
      ui.setBusy(true);
      ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
    }

    const { bookCode } = getBookCodes();
    if (!bookCode) return;

    try {
      // 1. VÒNG LẶP KIÊN NHẪN TÌM MANAGER TRƯỚC (Bảo vệ hoàn hảo thao tác Forward/Back)
      let manager = null;
      for (let i = 0; i < 40; i++) {
        manager = findManager();
        if (manager?.parser?.url && manager?.pages?.length > 0) break;
        await sleep(200);
      }

      // 2. CHỈ KHI SAU 8 GIÂY KHÔNG THẤY MANAGER MỚI KIỂM TRA XEM CÓ PHẢI CHƯƠNG BẮT MUA KHÔNG
      if (!manager || !manager.parser?.url) {
        if (checkPaywall()) {
          if (ui) {
            ui.updateProgress({ completed: 0, total: 0, status: "Lỗi: Bạn chưa mua hoặc chưa sở hữu chương này." });
            ui.setBusy('error');
          }
          return;
        }
        throw new Error("Không tìm thấy trình đọc sách.");
      }

      const totalPages = manager.pages.length;
      if (totalPages <= 0) throw new Error("Số trang truyện không hợp lệ.");

      await ensureAllKeysLoaded(manager);

      const firstPageSrc = manager.pages[0]?.image?.src || "";
      let realExt = 'webp';
      if (firstPageSrc.endsWith('.jpg') || firstPageSrc.endsWith('.jpeg')) realExt = 'jpg';
      else if (firstPageSrc.endsWith('.png')) realExt = 'png';

      if (ui) {
        await sleep(80);
        ui.updateProgress({
          completed: 0,
          total: totalPages,
          status: "Sẵn sàng.",
          format: realExt
        });
        ui.setBusy(false);
      }
    } catch (err) {
      console.error("[unext-dl] Boot error:", err);
      if (ui) {
        ui.updateProgress({ status: "Lỗi: " + (err?.message || "Không thể tải trang.") });
        ui.setBusy('error');
      }
    }
  }

  // Hook theo dõi SPA: Giữ nguyên cosmoCache, không bao giờ xóa bộ nhớ tiêu đề
  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute((newUrl) => {
      if (!isReaderUrl()) {
        const ui = getUI();
        if (ui?.panel) ui.panel.style.display = "none";
        state.lastBookCode = "";
        state.lastUrl = "";
        state.running = false;
        return;
      }

      const { bookCode } = getBookCodes();
      if (state.lastBookCode && state.lastBookCode === bookCode) return;

      state.lastUrl = newUrl;
      state.lastBookCode = bookCode;
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