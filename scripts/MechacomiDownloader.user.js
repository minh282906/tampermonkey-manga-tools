// ==UserScript==
// @name         Mechacomi Universal Downloader (Manga Saison)
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://mechacomi.jp/assets/images/favicon.ico
// @description  Tải manga trên まんがセゾン / Mechacomi (mechacomi.jp).
// @author       anonymous & AI
// @match        https://mechacomi.jp/viewer/mdviewer/browser/*
// @match        https://*.mechacomi.jp/viewer/mdviewer/browser/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      mechacomi.jp
// @connect      *.mechacomi.jp
// @connect      mediadotech.com
// @connect      *.mediadotech.com
// @connect      api.distribution.mediadotech.com
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function mechacomiUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * HẰNG SỐ MẬT MÃ HỌC MEDIADO UNIZON (B2 EXTENSION)
   * ========================================================================= */
  const CHUNK4 = new Uint8Array([
    0x98, 0xb8, 0x93, 0x7f, 0xf9, 0xfe, 0x8a, 0xa8,
    0x77, 0xd0, 0xa0, 0x68, 0x7b, 0x90, 0xb1, 0x29,
    0x94, 0x0b, 0x5e, 0x8f, 0xbf, 0xeb, 0xd7, 0x30,
    0xd6, 0x25, 0x59, 0xb1, 0xf1, 0x66, 0xfc, 0x76
  ]);

  const IMAGE_IV = new Uint8Array([
    0x06, 0x9a, 0xba, 0xf7, 0x68, 0x65, 0x50, 0xa1,
    0xa7, 0x8c, 0x9b, 0xde, 0x60, 0xb8, 0x13, 0xe4
  ]);

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    bookData: null,
    ui: null,
    lastUrl: "",
    lastDistId: ""
  };

  /* =========================================================================
   * HOOK ĐÓN GÓI TIN ACCESS-PROVIDER TẠI DOCUMENT-START (TỰ ĐỘNG TÓM TOKEN)
   * ========================================================================= */
  let capturedAccess = null;

  function captureProviderJson(url, text) {
    try {
      if (typeof text === 'string' && text.includes('token') && text.includes('url')) {
        const data = JSON.parse(text);
        if (data.token && data.url) {
          capturedAccess = data;
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
        if (u.includes('/access-provider/')) {
          res.clone().text().then(txt => captureProviderJson(u, txt)).catch(() => {});
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
        if (this._reqUrl && this._reqUrl.includes('/access-provider/')) {
          captureProviderJson(this._reqUrl, this.responseText);
        }
      });
      return origXhrSend.apply(this, arguments);
    };
  }

  /* =========================================================================
   * 1. GIAO DIỆN UNIVERSAL UI CHUẨN MANGA SAISON (XANH DƯƠNG #007AD9)
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "mechacomi-dl",
        title: "まんがセゾン",
        engine: "MEDIADO UNIZON",
        themeColor: "#007ad9",
        themeBg: "#ffffff",
        titleColor: "#007ad9",
        btnBg: "#007ad9",
        btnColor: "#ffffff",
        tabBg: "#007ad9",
        tabColor: "#ffffff",
        topOffset: "72px",
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
  function isViewerUrl() {
    return WIN.location.pathname.includes('/viewer/mdviewer/browser/');
  }

  function getDistributionId() {
    const m = WIN.location.pathname.match(/\/browser\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : null;
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

  function formatTitle(rawName) {
    if (!rawName) return "Mechacomi_Manga";
    const clean = cleanString(rawName);

    // Chuẩn hóa dấu ngoặc toàn giác: （１） -> （1）
    const normalized = clean.replace(/（([０-９]+)）/g, (_, n) => {
      const half = n.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
      return `（${half}）`;
    });

    // Tách vế tiêu đề nếu có phân đoạn số tập / 分冊版 / 第...巻
    const m = normalized.match(/^(.*?)(?:[ \u3000]+)(分冊版.*|第?[0-9IVXLCDM一二三四五六七八九十百千万\.]+[話回巻章].*)$/i);
    if (m && m[1] && m[2]) {
      return `${cleanString(m[1])} - ${cleanString(m[2])}`;
    }

    return normalized;
  }

  /* =========================================================================
   * 3. MẬT MÃ HỌC MEDIADO: BÓC TÁCH IMAGE KEY BẰNG WEB CRYPTO API
   * ========================================================================= */
  function b64UrlToBytes(str) {
    let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  }

  async function resolveImageKey(token) {
    const parts = token.split('.');
    if (parts.length < 4) throw new Error("Cấu trúc Token không hợp lệ.");

    const material = b64UrlToBytes(parts[1]);
    const origin = b64UrlToBytes(parts[2]);
    const contentId = b64UrlToBytes(parts[3]);

    // masterKey = SHA-256(material[0:8] + origin + contentId + CHUNK4)
    const seed = new Uint8Array(8 + origin.length + contentId.length + CHUNK4.length);
    seed.set(material.subarray(0, 8), 0);
    seed.set(origin, 8);
    seed.set(contentId, 8 + origin.length);
    seed.set(CHUNK4, 8 + origin.length + contentId.length);

    const masterKeyHash = await WIN.crypto.subtle.digest("SHA-256", seed);

    // Unwrap AES-128-CBC với IV = 16 byte 0
    const masterCryptoKey = await WIN.crypto.subtle.importKey(
      "raw", masterKeyHash, { name: "AES-CBC" }, false, ["decrypt"]
    );

    const cipher = material.subarray(8);
    const unwrappedBuf = await WIN.crypto.subtle.decrypt(
      { name: "AES-CBC", iv: new Uint8Array(16) },
      masterCryptoKey,
      cipher
    );
    const unwrapped = new Uint8Array(unwrappedBuf);

    // image_key = NOT(unwrapped[16:32])
    const imageKey = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      imageKey[i] = (~unwrapped[16 + i]) & 0xFF;
    }
    return imageKey;
  }

  /* =========================================================================
   * 4. BỘ PHÂN TÍCH GÓI .UZE (PKZIP) TRONG RAM THUẦN STREAM
   * ========================================================================= */
  async function parseUzeArchive(buffer) {
    const view = new DataView(buffer);
    const uint8 = new Uint8Array(buffer);
    const len = buffer.byteLength;

    // 1. Tìm End of Central Directory (0x06054b50)
    let eocd = -1;
    for (let i = len - 22; i >= Math.max(0, len - 65558); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd === -1) throw new Error("Gói .uze không hợp lệ (không tìm thấy ZIP EOCD).");

    const totalEntries = view.getUint16(eocd + 10, true);
    const cdOffset = view.getUint32(eocd + 16, true);

    let cur = cdOffset;
    const dec = new TextDecoder('utf-8');
    const entriesMap = new Map();
    let packageJsonEntry = null;

    // 2. Quét Central Directory
    for (let i = 0; i < totalEntries; i++) {
      if (view.getUint32(cur, true) !== 0x02014b50) break;
      const method = view.getUint16(cur + 10, true);
      const compSize = view.getUint32(cur + 20, true);
      const nameLen = view.getUint16(cur + 28, true);
      const extraLen = view.getUint16(cur + 30, true);
      const commentLen = view.getUint16(cur + 32, true);
      const localOffset = view.getUint32(cur + 42, true);

      const name = dec.decode(uint8.subarray(cur + 46, cur + 46 + nameLen));
      const entryObj = { name, method, compSize, localOffset };
      entriesMap.set(name, entryObj);

      if (name === "META-INF/package.json" || name.endsWith("package.json")) {
        packageJsonEntry = entryObj;
      }

      cur += 46 + nameLen + extraLen + commentLen;
    }

    // Hàm lấy mảng byte của 1 entry trong ZIP
    function getEntryBytes(entry) {
      const locNameLen = view.getUint16(entry.localOffset + 26, true);
      const locExtraLen = view.getUint16(entry.localOffset + 28, true);
      const dataStart = entry.localOffset + 30 + locNameLen + locExtraLen;
      return uint8.subarray(dataStart, dataStart + entry.compSize);
    }

    // 3. Đọc META-INF/package.json để lấy đúng thứ tự trang (Spine)
    let orderedImageEntries = [];
    if (packageJsonEntry) {
      try {
        let pkgBytes = getEntryBytes(packageJsonEntry);
        if (packageJsonEntry.method === 8) {
          const ds = new DecompressionStream('deflate-raw');
          const writer = ds.writable.getWriter();
          writer.write(pkgBytes);
          writer.close();
          pkgBytes = new Uint8Array(await new Response(ds.readable).arrayBuffer());
        }
        const pkgData = JSON.parse(dec.decode(pkgBytes));
        const spine = pkgData?.spine || [];

        for (const item of spine) {
          const href = item.href;
          if (!href) continue;
          const found = entriesMap.get(href) || entriesMap.get(`item/${href}`) || entriesMap.get(`OEBPS/${href}`);
          if (found) {
            orderedImageEntries.push({ ...found, bytes: getEntryBytes(found) });
          }
        }
      } catch (e) {
        console.warn("[mechacomi-dl] Lỗi đọc package.json, chuyển sang quét tự nhiên:", e);
      }
    }

    // Dự phòng nếu không có package.json: Lọc toàn bộ file ảnh và sắp xếp số học
    if (orderedImageEntries.length === 0) {
      const imgList = Array.from(entriesMap.values()).filter(e => /\.(jpe?g|png|webp|bin)$/i.test(e.name));
      imgList.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
      orderedImageEntries = imgList.map(e => ({ ...e, bytes: getEntryBytes(e) }));
    }

    return orderedImageEntries;
  }

  /* =========================================================================
   * 5. TIẾN TRÌNH TẢI CHÍNH & ZERO-COPY 0MS VÀO ZIP
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    const distId = getDistributionId();
    if (!distId) {
      if (ui) ui.updateProgress({ status: "Lỗi: Không tìm thấy Distribution ID." });
      return;
    }

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let bookData = state.bookData;
      if (!bookData || !bookData.uzeUrl || !bookData.token) {
        throw new Error("Chưa nạp được liên kết tải sách.");
      }

      const { uzeUrl, token, title, contentId } = bookData;
      const Utils = WIN.MangaUtils || globalThis.MangaUtils;

      // 1. Giải mã token lấy Image Key (16 bytes)
      const imageKey = await resolveImageKey(token);

      // 2. Kéo gói .uze nguyên khối vào RAM
      const uzeBuffer = await Utils.fetchBuffer(uzeUrl, { "Referer": WIN.location.href });

      // 3. Parse ZIP lấy danh sách các file ảnh mã hóa
      const imageEntries = await parseUzeArchive(uzeBuffer);
      const totalPages = imageEntries.length;
      if (!totalPages) throw new Error("Không tìm thấy trang tranh nào trong file .uze.");

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const zip = new ZipClass();

      // Đính kèm file định danh ${contentId}.txt theo Golden Rule 2
      zip.addFile(`${contentId}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      // 4. Chuẩn bị cỗ máy giải mã AES-128-CBC
      const cryptoKey = await WIN.crypto.subtle.importKey(
        "raw", imageKey, { name: "AES-CBC" }, false, ["decrypt"]
      );

      // 5. Giải mã tuần tự từng trang tranh trực tiếp trên RAM (Zero-Copy 0ms)
      for (let i = 0; i < totalPages; i++) {
        const entry = imageEntries[i];
        let decryptedBuf;

        try {
          decryptedBuf = await WIN.crypto.subtle.decrypt(
            { name: "AES-CBC", iv: IMAGE_IV },
            cryptoKey,
            entry.bytes
          );
        } catch (decryptErr) {
          // Dự phòng nếu có trang không bị mã hóa
          decryptedBuf = entry.bytes.buffer;
        }

        const decryptedBytes = new Uint8Array(decryptedBuf);
        const ext = Utils.detectExt(decryptedBytes.buffer);

        // Ghi thẳng mảng byte nhị phân vào ZIP Store Mode Level 0 (Zero-Copy)
        zip.addFile(`${i + 1}.${ext}`, decryptedBytes);

        if (ui) {
          ui.updateProgress({ completed: i + 1, total: totalPages, status: "Đang tải..." });
        }
      }

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      // Đặt tên ZIP chuẩn mực
      const finalFileName = `${title}.zip`;
      zip.download(finalFileName);

      if (ui) {
        ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
        ui.setBusy(false);
      }
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[mechacomi-dl] Download error:", err);
    } finally {
      state.running = false;
    }
  }

  /* =========================================================================
   * 6. KHỞI CHẠY & THEO DÕI ĐIỀU HƯỚNG
   * ========================================================================= */
  async function boot() {
    while (!DOC.body) await sleep(20);
    const ui = getUI();

    if (!isViewerUrl()) {
      if (ui?.panel) ui.panel.style.display = "none";
      return;
    }

    if (ui?.panel) {
      ui.panel.style.display = "block";
      ui.setBusy(true);
      ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
    }

    const distId = getDistributionId();
    if (!distId) return;

    try {
      // 1. Kéo Content Metadata
      const contentRes = await WIN.fetch(`https://mechacomi.jp/api/v1/mdviewer/content?distributionId=${distId}`).then(r => r.json());
      if (!contentRes?.contentId) throw new Error("Không thể lấy thông tin tác phẩm.");

      const cleanTitle = formatTitle(contentRes.contentName);

      // 2. Kéo Access Provider lấy link .uze và token
      let access = capturedAccess;
      if (!access || !access.url || !access.token) {
        const cType = contentRes.contentType === 'free' ? 'free' : (contentRes.contentType || 'free');
        access = await WIN.fetch(`https://mechacomi.jp/api/v1/mdviewer/access-provider/${cType}?contentId=${contentRes.contentId}&distributionId=${distId}`).then(r => r.json());
      }

      if (!access?.url || !access?.token) throw new Error("Không lấy được phiên đọc sách.");

      // 3. Test giải mã khóa ngay lập tức trong RAM
      const imageKey = await resolveImageKey(access.token);
      const cryptoKey = await WIN.crypto.subtle.importKey(
        "raw", imageKey, { name: "AES-CBC" }, false, ["decrypt"]
      );

      // 4. Tải gói .uze ngầm để chốt cứng số trang tranh thật (Khử triệt để bẫy Kobo)
      const Utils = WIN.MangaUtils || globalThis.MangaUtils;
      const uzeBuffer = await Utils.fetchBuffer(access.url, { "Referer": WIN.location.href });
      const imageEntries = await parseUzeArchive(uzeBuffer);

      if (!imageEntries.length) throw new Error("Không có trang hợp lệ.");

      // Soi Magic Bytes thực tế của trang 1 (Zero-Trust)
      let testDecrypted;
      try {
        testDecrypted = await WIN.crypto.subtle.decrypt(
          { name: "AES-CBC", iv: IMAGE_IV },
          cryptoKey,
          imageEntries[0].bytes
        );
      } catch (e) {
        testDecrypted = imageEntries[0].bytes.buffer;
      }

      const realExt = Utils.detectExt(testDecrypted);

      state.bookData = {
        distId,
        contentId: contentRes.contentId,
        title: cleanTitle,
        uzeUrl: access.url,
        token: access.token,
        imageEntries
      };

      if (ui) {
        await sleep(80);
        ui.updateProgress({
          completed: 0,
          total: imageEntries.length,
          status: "Sẵn sàng.",
          format: realExt
        });
        ui.setBusy(false);
      }
    } catch (err) {
      console.error("[mechacomi-dl] Boot error:", err);
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
      if (!isViewerUrl()) {
        const ui = getUI();
        if (ui?.panel) ui.panel.style.display = "none";
        state.bookData = null;
        state.lastDistId = "";
        state.lastUrl = "";
        state.running = false;
        return;
      }

      const currentDistId = getDistributionId();
      if (state.lastDistId && state.lastDistId === currentDistId) return;

      state.lastUrl = newUrl;
      state.lastDistId = currentDistId;
      state.bookData = null;
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