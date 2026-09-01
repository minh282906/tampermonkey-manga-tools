// ==UserScript==
// @name         DLsite / Comipo Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://www.google.com/s2/favicons?domain=dlsite.com&sz=128
// @description  Tải manga trên toàn bộ hệ sinh thái DLsite Play (bao gồm Comipo)
// @author       Afang & anonymous & AI
// @match        https://play.dlsite.com/*
// @match        https://play.comipo.app/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      play.dlsite.com
// @connect      play.dl.dlsite.com
// @connect      play.comipo.app
// @connect      dl.comipo.app
//
// --- TỰ ĐỘNG TẢI VÀ UPDATE PHIÊN BẢN
// @updateURL    https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/DLsiteDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/minh282906/tampermonkey-manga-tools/main/scripts/DLsiteDownloader.user.js
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function dlsiteUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6,   // 6 luồng tải song song
    JPEG_QUALITY: 0.95   // Chất lượng xuất JPG nếu tick chọn
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  /* =========================================================================
   * BỘ BẪY WEB WORKER TỰ ĐỘNG (BẮT KHÓA DÀNH RIÊNG CHO COMIPO FREE CÓ THỜI HẠN)
   * ========================================================================= */
  let capturedWorkerKey = null;
  let workerKeyResolver = null;
  const keyReadyPromise = new Promise(resolve => { workerKeyResolver = resolve; });

  try {
    if (typeof WIN.Worker !== 'undefined') {
      const origPostMessage = WIN.Worker.prototype.postMessage;
      WIN.Worker.prototype.postMessage = function(msg, ...rest) {
        if (msg && typeof msg === 'object' && msg.param && msg.param.key) {
          capturedWorkerKey = String(msg.param.key).trim();
          if (workerKeyResolver) {
            workerKeyResolver(capturedWorkerKey);
            workerKeyResolver = null;
          }
        }
        return origPostMessage.apply(this, [msg, ...rest]);
      };
    }
  } catch (e) {}

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("dlsite-dl:convert-jpeg") === '1',
    detectedSourceFormat: 'webp',
    chapterData: null,
    ui: null
  };

  /* =========================================================================
   * BỘ ADAPTER THEME TỰ ĐỘNG (DLSITE PLAY VS COMIPO PLAY)
   * ========================================================================= */
  const SITE_PROFILES = {
    "play.dlsite.com": {
      name: "DLsite Play",
      engine: "DLSITE PLAY",
      themeColor: "#0284c7",
      themeBg: "#0f172a",
      titleColor: "#ffffff",
      btnBg: "#0284c7",
      btnColor: "#ffffff",
      top: "80px",
      appOrigin: "https://play.dlsite.com",
      downloadOrigin: "https://play.dl.dlsite.com",
      apiPrefix: "/api/v3"
    },
  
    "play.comipo.app": {
      name: "Comipo Play",
      engine: "DLSITE PLAY",
      themeColor: "#16a34a",
      themeBg: "#0f172a",
      titleColor: "#ffffff",
      btnBg: "#16a34a",
      btnColor: "#ffffff",
      top: "80px",
      appOrigin: "https://play.comipo.app",
      downloadOrigin: "https://dl.comipo.app",
      apiPrefix: "/api/comipo/v3"
    }
  };

  function currentProfile() {
    const host = WIN.location.hostname;
    return SITE_PROFILES[host] || SITE_PROFILES["play.dlsite.com"];
  }

  /* =========================================================================
   * 1. GIAO DIỆN UNIVERSAL UI CHUẨN 2 TẦNG
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const profile = currentProfile();
      const uiConfig = {
        storagePrefix: "dlsite-dl",
        title: profile.name,
        engine: profile.engine,
        themeColor: profile.themeColor,
        themeBg: profile.themeBg,
        titleColor: profile.titleColor,
        topOffset: profile.top,
        defaultJpgText: "Xuất file JPG (ảnh gốc là WebP)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("dlsite-dl:convert-jpeg", checked ? '1' : '0');
        }
      };

      state.ui = createUI(uiConfig);
      state.ui.updateFormatUI(state.detectedSourceFormat);

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
   * 2. BỘ HỖ TRỢ XỬ LÝ URL, WORKNO & TIÊU ĐỀ
   * ========================================================================= */
  function isEpisodeUrl() {
    const path = WIN.location.pathname;
    return /\/work\/[^/]+\/viewer/i.test(path) || 
           /\/viewer\/(?:sample|free)\/[^/]+/i.test(path) || 
           path.includes('/viewer');
  }

  function parseWorkNo() {
    const match = WIN.location.pathname.match(/\/(?:work|sample|free)\/([A-Za-z0-9_-]+)/i) || 
                  WIN.location.href.match(/([BVR]J\d{6,8})/i);
    return match ? match[1].trim() : "dlsite_work";
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

  function getCleanTitle(manifestTitle) {
    try {
      let raw = manifestTitle || "";

      // 1. Quét thẻ h1 chứa tên truyện trên cả DLsite & Comipo
      if (!raw) {
        const h1El = DOC.querySelector('h1, [class*="_titleText"], [class*="titleText"]');
        if (h1El && h1El.textContent.trim()) {
          raw = h1El.textContent.trim();
        }
      }

      // 2. Dự phòng lấy từ document.title
      if (!raw) raw = DOC.title || "";

      // 3. Lọc sạch rác SEO & tên sàn
      raw = raw.replace(/\s*[-|｜]\s*(?:DLsite|Comipo|コミポ|無料試し読み|立ち読み|無料版|期間限定).*/i, '').trim();
      raw = raw.replace(/【[^】]*】/g, '').trim();
      raw = raw.replace(/^公式\s*[-－_]?\s*/i, '').trim();

      return cleanString(raw) || `DLsite_${parseWorkNo()}`;
    } catch (e) {}

    return `DLsite_${parseWorkNo()}`;
  }

  /* =========================================================================
   * 3. MẬT MÃ BẤT ĐỐI XỨNG RSA-OAEP 4096-BIT (SỬ DỤNG WEB CRYPTO API)
   * ========================================================================= */
  function binaryFromBytes(bytes) {
    let output = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      output += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return output;
  }

  function arrayBufferToBase64(buffer) {
    return btoa(binaryFromBytes(new Uint8Array(buffer)));
  }

  function base64ToArrayBuffer(text) {
    const binary = atob(String(text || ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
    return bytes.buffer;
  }

  async function createRsaPair() {
    const pair = await WIN.crypto.subtle.generateKey({
      name: 'RSA-OAEP',
      modulusLength: 4096,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    }, true, ['encrypt', 'decrypt']);

    const exported = await WIN.crypto.subtle.exportKey('spki', pair.publicKey);
    return { pair, publicKey: arrayBufferToBase64(exported) };
  }

  async function decryptViewerKey(pair, encryptedKeyBase64) {
    const decrypted = await WIN.crypto.subtle.decrypt(
      { name: 'RSA-OAEP' },
      pair.privateKey,
      base64ToArrayBuffer(encryptedKeyBase64)
    );
    return binaryFromBytes(new Uint8Array(decrypted));
  }

  function hexToBytes(hex) {
    const clean = String(hex || '').trim();
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  /* =========================================================================
   * 4. BÓC TÁCH CẤU HÌNH MANIFEST TỪ DLSITE PLAY API
   * ========================================================================= */
  function flattenTree(nodes, output = []) {
    if (!Array.isArray(nodes)) return output;
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      if (node.type === 'file' && node.hashname) output.push(node);
      if (Array.isArray(node.children)) flattenTree(node.children, output);
      if (Array.isArray(node.tree)) flattenTree(node.tree, output);
    }
    return output;
  }

  function selectPlayableFile(ziptree) {
    const playfile = ziptree?.playfile;
    if (!playfile || typeof playfile !== 'object') throw new Error("File ziptree thiếu playfile.");

    const files = flattenTree(ziptree.tree);
    for (const file of files) {
      const entry = playfile[file.hashname];
      if (entry && /(ebook|sample)/i.test(String(entry.type || ''))) {
        return { hashname: file.hashname, entry };
      }
    }

    for (const [hashname, entry] of Object.entries(playfile)) {
      if (entry && /(ebook|sample)/i.test(String(entry.type || ''))) return { hashname, entry };
    }

    const firstHash = Object.keys(playfile)[0];
    if (firstHash) return { hashname: firstHash, entry: playfile[firstHash] };

    throw new Error("Không tìm thấy dữ liệu nội dung trong ziptree.");
  }

  /* =========================================================================
   * BỘ GỌI API DUAL-FLIGHT (TỰ ĐỘNG GỬI COOKIE HTTPONLY)
   * ========================================================================= */
  async function fetchJsonApi(url, method = "GET", body = null) {
    const profile = currentProfile();
    const headers = {
      "Accept": "application/json, text/plain, */*",
      "Referer": WIN.location.href,
      "Origin": profile.appOrigin
    };
    if (body) headers["Content-Type"] = "application/json";

    // 1. Thử gọi bằng fetch của tab để gửi kèm 100% Cookie phiên đọc
    try {
      const res = await WIN.fetch(url, {
        method: method,
        credentials: "include",
        mode: "cors",
        headers: headers,
        body: body
      });
      if (res.ok) {
        const text = await res.text();
        if (text && text.trim()) return JSON.parse(text);
      }
    } catch (e) {}

    // 2. Fallback qua GM_xmlhttpRequest (để Tampermonkey tự động gửi Cookie HttpOnly gốc)
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: method,
        url: url,
        headers: headers,
        data: body,
        timeout: 30000,
        anonymous: false, // Bắt buộc false để trình duyệt tự đính kèm cookie HttpOnly
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            try {
              const rawText = res.responseText || (typeof res.response === 'string' ? res.response : '');
              if (!rawText || !rawText.trim()) return reject(new Error("Response JSON rỗng"));
              resolve(JSON.parse(rawText));
            } catch (err) {
              reject(new Error(`Lỗi parse JSON: ${err.message}`));
            }
          } else {
            reject(new Error(`HTTP ${res.status}`));
          }
        },
        onerror: () => reject(new Error("Lỗi kết nối mạng")),
        ontimeout: () => reject(new Error("Timeout kết nối API"))
      });
    });
  }
  
  async function fetchDlsiteManifest() {
    const profile = currentProfile();
    const workno = parseWorkNo();
    const isSampleOrFree = /\/(?:sample|free)\//i.test(WIN.location.pathname) || WIN.location.href.includes('/sample') || WIN.location.href.includes('/free');

    // =========================================================================
    // LUỒNG 1: ĐỌC THỬ SAMPLE HOẶC BẢN FREE CÓ HẠN (Lấy trực tiếp qua CDN)
    // =========================================================================
    if (isSampleOrFree) {
      let metaUrl = null;
      for (let i = 0; i < 35; i++) {
        const res = WIN.performance?.getEntriesByType?.("resource") || [];
        const found = res.find(r => r.name && r.name.includes('/viewer/ebook_fixed/v2/'));
        if (found) { metaUrl = found.name; break; }
        await sleep(100);
      }

      if (!metaUrl) throw new Error("Chưa tải xong dữ liệu CDN viewer.");

      const base = metaUrl.substring(0, metaUrl.lastIndexOf('/') + 1);
      const query = metaUrl.includes('?') ? metaUrl.substring(metaUrl.indexOf('?')) : '';

      // 1. Kéo viewer-meta.json
      const meta = await fetchJsonApi(metaUrl);

      // 2. Kéo decryption.key (Trial) hoặc lấy từ Web Worker Hook (Free)
      let keyHex = "";
      try {
        const keyRes = await WIN.fetch(`${base}decryption.key${query}`);
        if (keyRes.ok) keyHex = (await keyRes.text()).trim();
      } catch (e) {}

      if (!keyHex) {
        if (capturedWorkerKey) {
          keyHex = capturedWorkerKey;
        } else {
          keyHex = await Promise.race([
            keyReadyPromise,
            sleep(3000).then(() => null)
          ]);
        }
      }

      if (!keyHex) throw new Error("Chưa bắt được khóa giải mã từ Web Worker. Vui lòng lật 1 trang rồi thử lại.");

      const keyBytes = hexToBytes(keyHex);

      const rawPages = Array.isArray(meta?.pages) ? meta.pages : [];
      if (!rawPages.length) throw new Error("Danh sách trang sample/free rỗng.");

      const pages = rawPages.map((p, idx) => ({
        pageNo: idx + 1,
        url: `${base}${p.src}${query}`,
        width: Number(p.view_box?.width) || 0,
        height: Number(p.view_box?.height) || 0
      }));

      // Kéo tên tác phẩm từ API info (hỗ trợ name.ja_JP) hoặc thẻ H1
      let workTitle = "";
      try {
        const workInfo = await fetchJsonApi(`${profile.appOrigin}/api/viewer/work/${encodeURIComponent(workno)}`);
        workTitle = workInfo?.name?.ja_JP || (typeof workInfo?.name === 'string' ? workInfo.name : '') || workInfo?.work_name || "";
      } catch(e) {}

      if (!workTitle) {
        const h1El = DOC.querySelector('h1, [class*="_titleText"], [class*="titleText"]');
        if (h1El) workTitle = h1El.textContent.trim();
      } 

      return {
        workno,
        title: workTitle || meta.meta_data?.title || meta.title || "",
        keyBytes,
        pages
      };
    }

    // =========================================================================
    // LUỒNG 2: BẢN QUYỀN MUA FULL (Bắt tay RSA-OAEP 4096-bit)
    // =========================================================================
    let sign = null;
    const signCandidates = [
      `${profile.downloadOrigin}${profile.apiPrefix}/download/sign/cookie?workno=${encodeURIComponent(workno)}`,
      `${profile.appOrigin}${profile.apiPrefix}/download/sign/cookie?workno=${encodeURIComponent(workno)}`
    ];
    for (const sUrl of signCandidates) {
      try { sign = await fetchJsonApi(sUrl); if (sign?.url) break; } catch (e) {}
    }
    if (!sign?.url) throw new Error("Chưa đăng nhập hoặc tài khoản chưa mua truyện (HTTP 401/402).");

    const cdnBase = sign.url.replace(/\/?$/, '/');
    const minuteTimestamp = Math.floor(Date.now() / 1000) - (Math.floor(Date.now() / 1000) % 60);
    const ziptree = await fetchJsonApi(`${cdnBase}ziptree.json?v=${minuteTimestamp}`);
    const selected = selectPlayableFile(ziptree);
    const revision = String(ziptree.revision || '1');

    const rsa = await createRsaPair();
    const token = await fetchJsonApi(`${profile.appOrigin}${profile.apiPrefix}/viewer/token/${encodeURIComponent(workno)}`, "POST", JSON.stringify({
      play_type: selected.entry?.type || 'ebook_fixed',
      revision: revision,
      public_key: rsa.publicKey
    }));

    const keyHex = await decryptViewerKey(rsa.pair, token.key);
    const keyBytes = hexToBytes(keyHex);

    const query = new URLSearchParams();
    Object.entries(token.parameters || {}).forEach(([k, v]) => { if (v != null) query.set(k, String(v)); });
    query.set('v', revision);

    const contentBase = `${token.prefix.replace(/\/?$/, '/')}${selected.hashname}/`;
    const meta = await fetchJsonApi(`${contentBase}viewer-meta.json?${query.toString()}`);
    const rawPages = Array.isArray(meta?.pages) ? meta.pages : [];

    const pages = rawPages.filter(p => p && p.src).map((p, idx) => ({
      pageNo: idx + 1,
      url: `${contentBase}${p.src}?${query.toString()}`,
      width: Number(p.width) || 0,
      height: Number(p.height) || 0
    }));

    return {
      workno,
      title: meta.title || meta.meta_data?.title || "",
      keyBytes,
      pages
    };
  }

  /* =========================================================================
   * 5. GIẢI MÃ BITWISE XOR TRONG RAM (ZERO-COPY 0ms)
   * ========================================================================= */
  async function processDlsiteImage(pageObj, keyBytes, forceJpg) {
    const Utils = window.MangaUtils || globalThis.MangaUtils;
    const rawBuffer = await Utils.fetchBuffer(pageObj.url);
    const rawUint8 = new Uint8Array(rawBuffer);

    // 1. Chạy vòng lặp Cyclic XOR trên CPU (0ms)
    const keyLen = keyBytes.length;
    const decryptedBytes = new Uint8Array(rawUint8.length);
    for (let i = 0; i < rawUint8.length; i++) {
      decryptedBytes[i] = rawUint8[i] ^ keyBytes[i % keyLen];
    }

    // 2. Nhận diện Magic Bytes thực tế
    const ext = Utils.detectExt(decryptedBytes.buffer);

    // 3. ZERO-COPY: Nếu không ép JPG hoặc ảnh đã là JPG -> ghi thẳng mảng byte vào ZIP
    if (!forceJpg || ext === 'jpg') {
      return {
        fileName: `${pageObj.pageNo}.${ext}`,
        data: decryptedBytes
      };
    }

    // 4. Nếu người dùng tick chọn xuất JPG -> vẽ qua Canvas
    const img = await Utils.loadImage(decryptedBytes.buffer, `image/${ext}`);
    const canvas = DOC.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = false;
    ctx.mozImageSmoothingEnabled = false;
    ctx.webkitImageSmoothingEnabled = false;
    ctx.msImageSmoothingEnabled = false;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);

    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', CONFIG.JPEG_QUALITY));
    canvas.width = 0;
    canvas.height = 0;

    return {
      fileName: `${pageObj.pageNo}.jpg`,
      data: new Uint8Array(await blob.arrayBuffer())
    };
  }

  /* =========================================================================
   * 6. TIẾN TRÌNH TẢI CHÍNH (6 LUỒNG TRONG RAM)
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let data = state.chapterData;
      if (!data) {
        data = await fetchDlsiteManifest();
        state.chapterData = data;
      }

      const { pages, keyBytes, workno, title } = data;
      const totalPages = pages.length;
      if (!totalPages) throw new Error("Không tìm thấy trang hợp lệ.");

      const forceJpg = Boolean(state.convertJpeg);
      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // Đính kèm file rỗng ID định danh vào root ZIP
      zip.addFile(`${workno}.txt`, new Uint8Array(0));

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      const tasks = pages.map((pageObj) => () => processDlsiteImage(pageObj, keyBytes, forceJpg));

      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res?.data) zip.addFile(res.fileName, res.data);
      }

      const zipName = `${getCleanTitle(title)}.zip`;
      zip.download(zipName);

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[dlsite-dl] Error:", err);
    } finally {
      state.running = false;
      if (ui) ui.setBusy(false);
    }
  }

  /* =========================================================================
   * 7. KHỞI CHẠY VÀ THEO DÕI SPA
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
      ui.updateProgress({ completed: 0, total: 0, status: "Đang kiểm tra..." });
    }

    let data = null;
    let retries = 0;

    // Retry loop 25 lần chờ Cookie / Auth sẵn sàng
    while (retries < 25) {
      try {
        data = await fetchDlsiteManifest();
        if (data && data.pages?.length > 0) break;
      } catch (e) {}
      await sleep(150);
      retries++;
    }

    if (data && data.pages?.length > 0) {
      state.chapterData = data;

      // Nhận diện định dạng gốc từ trang đầu tiên
      try {
        const Utils = window.MangaUtils || globalThis.MangaUtils;
        const testBuf = await Utils.fetchBuffer(data.pages[0].url);
        const testRaw = new Uint8Array(testBuf);
        const dec = new Uint8Array(testRaw.length);
        for (let i = 0; i < testRaw.length; i++) dec[i] = testRaw[i] ^ data.keyBytes[i % data.keyBytes.length];
        const detectedExt = Utils.detectExt(dec.buffer);
        state.detectedSourceFormat = detectedExt;
        if (ui) ui.updateFormatUI(detectedExt);
      } catch (e) {}

      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: data.pages.length,
          status: "Sẵn sàng."
        });
      }
    } else {
      if (ui) ui.updateProgress({ status: "Sẵn sàng." });
    }
  }

  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute(() => {
      state.chapterData = null;
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