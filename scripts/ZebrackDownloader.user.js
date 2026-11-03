// ==UserScript==
// @name         Zebrack Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://zebrack-comic.com/icons/icon-192x192.png
// @description  Tải manga trên Zebrack (zebrack-comic.shueisha.co.jp).
// @author       anonymous & AI
// @match        https://zebrack-comic.shueisha.co.jp/*
// @match        https://*.zebrack-comic.shueisha.co.jp/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      zebrack-comic.shueisha.co.jp
// @connect      api2.zebrack-comic.com
// @connect      api.zebrack-comic.com
// @connect      asset.zebrack-comic.com
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// ==/UserScript==

(function zebrackUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6   // 6 luồng tải song song
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
    lastEpisodeId: "",
    capturedRawPayload: null
  };

  /* =========================================================================
   * 1. MÔ HÌNH 3: SINGLE-FLIGHT PASSIVE HOOK ĐÓN GÓI TIN PROTOBUF VIEWER (0ms)
   * ========================================================================= */
  function isViewerEndpoint(url) {
    const s = String(url || '');
    return s.includes('chapter_viewer') || s.includes('manga_volume_viewer') || s.includes('magazine_viewer') || s.includes('gravure_viewer');
  }

  function handleViewerResponse(url, bufferOrText) {
    if (!bufferOrText) return;
    state.capturedRawPayload = bufferOrText;
    const epId = getEpisodeId();
    if (epId) {
      try {
        if (bufferOrText instanceof ArrayBuffer) {
          const arr = Array.from(new Uint8Array(bufferOrText));
          sessionStorage.setItem(`zebrack_raw_${epId}`, JSON.stringify(arr));
        }
      } catch (e) {}
    }

    if (isEpisodeUrl() && !state.running) {
      boot();
    }
  }

  const origFetch = WIN.fetch;
  if (typeof origFetch === 'function') {
    WIN.fetch = async function(...args) {
      const res = await origFetch.apply(this, args);
      try {
        const u = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        if (isViewerEndpoint(u)) {
          res.clone().arrayBuffer().then(buf => handleViewerResponse(u, buf)).catch(() => {});
        }
      } catch (e) {}
      return res;
    };
  }

  const origXhrOpen = WIN.XMLHttpRequest?.prototype?.open;
  const origXhrSend = WIN.XMLHttpRequest?.prototype?.send;
  if (origXhrOpen && origXhrSend) {
    WIN.XMLHttpRequest.prototype.open = function(method, url) {
      this._reqUrl = url;
      return origXhrOpen.apply(this, arguments);
    };
    WIN.XMLHttpRequest.prototype.send = function() {
      this.addEventListener('load', () => {
        if (this._reqUrl && isViewerEndpoint(this._reqUrl)) {
          let raw = (this.responseType === '' || this.responseType === 'text') ? this.responseText : this.response;
          handleViewerResponse(this._reqUrl, raw);
        }
      });
      return origXhrSend.apply(this, arguments);
    };
  }

  /* =========================================================================
   * 2. GIAO DIỆN THEME: XANH MINT ZEBRACK (#26BEB1) - NỀN TỐI SANG TRỌNG (#18181B)
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {
      const uiConfig = {
        storagePrefix: "zebrack-dl",
        title: "ゼブラック",
        engine: "SHUEISHA",
        themeColor: "#26beb1",      
        themeBg: "#18181b",       
        titleColor: "#26beb1",      
        btnBg: "#26beb1",          
        btnColor: "#ffffff",        
        tabBg: "#26beb1",
        tabColor: "#ffffff",
        topOffset: "50px",
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
   * 3. BỘ HỖ TRỢ XỬ LÝ CHUỖI, URL & TIÊU ĐỀ
   * ========================================================================= */
  function isEpisodeUrl() {
    return /\/viewer(?:\/|$)/i.test(WIN.location.pathname);
  }

  function getEpisodeId() {
    // 1. Phân hệ Chapter lẻ: /title/:titleId/chapter/:chapterId/viewer
    const mChap = WIN.location.pathname.match(/\/chapter\/(\d+)\/viewer/i);
    if (mChap) return mChap[1];

    // 2. Phân hệ Tankobon Volume: /title/:titleId/volume/:volumeId/viewer
    const mVol = WIN.location.pathname.match(/\/volume\/(\d+)\/viewer/i);
    if (mVol) return mVol[1];

    // 3. Phân hệ Magazine: /magazine/:magId/issue/:issueId/viewer
    const mIssue = WIN.location.pathname.match(/\/issue\/(\d+)\/viewer/i);
    if (mIssue) return mIssue[1];

    // 4. Phân hệ Gravure: /gravure/:id/viewer
    const mGravure = WIN.location.pathname.match(/\/gravure\/(\d+)\/viewer/i);
    if (mGravure) return mGravure[1];

    return "chapter";
  }

  function cleanString(str) {
    if (!str) return "";
    return str
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/【(?!(?:フルカラー版|カラー版|完全版|特装版|デジタル限定[^】]*))[^】]*】/gi, '')
      .replace(/[\\/*?:"<>|]/g, '')
      .trim();
  }

  async function getCleanTitle(fallbackId) {
    try {
      let raw = DOC.title || "";
      raw = raw.split(/[|｜]/)[0].trim();
      raw = raw.replace(/を漫画アプリで読む.*$/i, '').trim();

      // 0. Nhánh Gravure: Bóc trọn vẹn chuỗi trong cặp ngoặc kép 『...』
      if (WIN.location.pathname.includes('/gravure/')) {
        let gTitle = "";
        if (state.capturedRawPayload) {
          const txt = new TextDecoder('utf-8', { fatal: false }).decode(state.capturedRawPayload);
          const m = txt.match(/『(.*?)』/);
          if (m) gTitle = m[1].trim();
        }
        if (!gTitle) {
          const gid = WIN.location.pathname.match(/\/gravure\/(\d+)/)?.[1];
          if (gid) {
            try {
              const res = await WIN.fetch(`https://api2.zebrack-comic.com/api/v3/gravure_viewer?os=browser&gravure_id=${gid}&is_trial=1`);
              if (res.ok) {
                const txt = new TextDecoder('utf-8', { fatal: false }).decode(await res.arrayBuffer());
                const m = txt.match(/『(.*?)』/);
                if (m) gTitle = m[1].trim();
              }
            } catch (e) {}
          }
        }
        if (gTitle) return cleanString(gTitle);
      }

      // 1. TH1: Chap lẻ có ngoặc 「...」
      const bracketMatch = raw.match(/「(.*?)」\s*(.*)$/);
      if (bracketMatch) {
        const series = cleanString(bracketMatch[1]);
        let ep = cleanString(bracketMatch[2]);
        if (series && ep) {
          if (ep.startsWith(series)) ep = cleanString(ep.substring(series.length));
          return `${series} - ${ep}`;
        }
        return series || ep;
      }

      // 2. TH2: Tankobon Volume (Kết thúc bằng số tập)
      const volMatch = raw.match(/^(.*?)(?:[\s\u3000]+)((?:第\s*)?[0-9０-９]+(?:\.[0-9]+)?\s*巻?)$/);
      if (volMatch) {
        const series = cleanString(volMatch[1]);
        let volNum = volMatch[2].trim();
        return `${series} - ${volNum}`;
      }

      // 3. TH3: Tạp chí Magazine (Giải mã Protobuf chuẩn xác 100% & Khử trùng lặp)
      const cleanRaw = cleanString(raw);
      if (cleanRaw) {
        const mMag = WIN.location.pathname.match(/\/magazine\/(\d+)\/issue\/(\d+)/i);
        if (mMag) {
          try {
            const year = new Date().getFullYear();
            const res = await WIN.fetch(`https://api2.zebrack-comic.com/api/browser/magazine_backnumbers?os=browser&magazine_id=${mMag[1]}&year=${year}`);
            if (res.ok) {
              const u8 = new Uint8Array(await res.arrayBuffer());
              const dec = new TextDecoder('utf-8');
              const targetId = Number(mMag[2]);

              function parseProtobuf(buffer) {
                const fields = [];
                let pos = 0;
                function readVarint() {
                  let r = 0, s = 0;
                  while (pos < buffer.length) {
                    const b = buffer[pos++];
                    r += (b & 0x7f) * Math.pow(2, s);
                    if (!(b & 0x80)) break;
                    s += 7;
                  }
                  return r;
                }
                while (pos < buffer.length) {
                  const tag = readVarint();
                  const wt = tag & 0x07, fn = tag >>> 3;
                  if (fn === 0) break;
                  if (wt === 0) fields.push({ fn, val: readVarint() });
                  else if (wt === 2) {
                    const len = readVarint();
                    fields.push({ fn, bytes: buffer.subarray(pos, pos + len) });
                    pos += len;
                  } else if (wt === 1) pos += 8;
                  else if (wt === 5) pos += 4;
                  else break;
                }
                return fields;
              }

              // Root -> Field 52 (magazineData) -> Field 3 (magazineList) -> Magazine { Field 1: issueId, Field 4: title }
              const rootFields = parseProtobuf(u8);
              const magDataBytes = rootFields.find(f => f.fn === 52)?.bytes;
              if (magDataBytes) {
                const entries = parseProtobuf(magDataBytes).filter(f => f.fn === 3);
                for (const entry of entries) {
                  const mFields = parseProtobuf(entry.bytes);
                  const id = mFields.find(f => f.fn === 1)?.val;
                  const titleBytes = mFields.find(f => f.fn === 4)?.bytes;
                  if (id === targetId && titleBytes) {
                    let issueTitle = dec.decode(titleBytes).trim();
                    if (issueTitle.startsWith(cleanRaw)) {
                      issueTitle = issueTitle.substring(cleanRaw.length).trim();
                    }
                    return issueTitle ? `${cleanRaw} - ${issueTitle}` : cleanRaw;
                  }
                }
              }
            }
          } catch (e) {}
          return `${cleanRaw} - Issue_${mMag[2]}`;
        }
        return cleanRaw;
      }
    } catch (e) {}

    return `Zebrack_${fallbackId || 'Episode'}`;
  }

  /* =========================================================================
   * 4. MẬT MÃ HỌC SHUEISHA: CYCLIC XOR 64-BYTE (128-HEX KEY)
   * ========================================================================= */
  function hexToBytes(hex) {
    const clean = String(hex || '').trim().replace(/[^0-9a-fA-F]/g, '');
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  function decryptZebrackXor(encryptedBuffer, hexKey) {

    if (!hexKey) return new Uint8Array(encryptedBuffer);

    const keyBytes = hexToBytes(hexKey);
    const keyLen = keyBytes.length; // 64 bytes
    const rawBytes = new Uint8Array(encryptedBuffer);
    const decrypted = new Uint8Array(rawBytes.length);

    for (let i = 0; i < rawBytes.length; i++) {
      decrypted[i] = rawBytes[i] ^ keyBytes[i % keyLen];
    }
    return decrypted;
  }

  /* =========================================================================
   * 5. BÓC TÁCH PROTOBUF: LỌC SẠCH ICON & TÁCH CHUẨN TRANG TRUYỆN VS PR
   * ========================================================================= */
  function parseProtobufManifest(rawInput) {
    if (!rawInput) return null;

    let textLatin1 = "";
    if (typeof rawInput === 'string') {
      textLatin1 = rawInput;
    } else {
      const u8 = rawInput instanceof Uint8Array ? rawInput : new Uint8Array(rawInput);
      textLatin1 = new TextDecoder('latin1').decode(u8);
    }

    const urlRegex = /https?:\/\/asset\.zebrack-comic\.com\/[^\s"',\x00-\x1f]+?\.(?:jpe?g|webp|png)\?[^\s"',\x00-\x1f]*?expires=\d+/gi;
    const matches = [...textLatin1.matchAll(urlRegex)];
    if (matches.length === 0) return null;

    const mainPages = [];
    const prPages = [];
    const seenUrls = new Set();

    for (let i = 0; i < matches.length; i++) {
      const imgUrl = matches[i][0];
      // 1. Lọc bỏ toàn bộ icon rác mục lục (override_icon, icon/)
      if (seenUrls.has(imgUrl) || imgUrl.includes('icon') || imgUrl.includes('override')) continue;
      seenUrls.add(imgUrl);

      const startPos = matches[i].index + imgUrl.length;
      const endPos = (i + 1 < matches.length) ? Math.min(matches[i + 1].index, startPos + 160) : startPos + 160;
      const chunk = textLatin1.slice(startPos, endPos);

      const keyMatch = chunk.match(/[0-9a-fA-F]{128}/);
      const key = keyMatch ? keyMatch[0] : null;

      // 2. Trang truyện thật bắt buộc có phân đoạn /page/ hoặc /p/
      if (imgUrl.includes('/page/') || imgUrl.includes('/p/')) {
        mainPages.push({ url: imgUrl, key, isPR: false });
      } else if (imgUrl.includes('thumbnail') || imgUrl.includes('/thumb/')) {
        // Ảnh bìa / quảng bá xếp vào PR
        prPages.push({ url: imgUrl, key, isPR: true });
      }
    }

    // Đánh số trang truyện: 1, 2, 3...
    mainPages.forEach((p, idx) => { p.pageNo = String(idx + 1); });
    // Đánh số ảnh PR: PR (nếu 1 ảnh) hoặc PR_1, PR_2...
    prPages.forEach((p, idx) => { p.pageNo = prPages.length === 1 ? 'PR' : `PR_${idx + 1}`; });

    const allPages = [...mainPages, ...prPages];
    return allPages.length > 0 ? allPages : null;
  }

  /* =========================================================================
   * 6. TIẾN TRÌNH TẢI CHÍNH (6 LUỒNG TRONG RAM - ZERO-COPY 0MS)
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    const episodeId = getEpisodeId();
    if (!episodeId) {
      if (ui) ui.updateProgress({ status: "Lỗi: Không tìm thấy ID chương." });
      return;
    }

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      const pages = state.chapterData?.pages;
      if (!pages || !pages.length) {
        throw new Error("Không có dữ liệu trang truyện để tải.");
      }

      const totalPages = pages.length;
      const Utils = WIN.MangaUtils || globalThis.MangaUtils;
      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const zip = new ZipClass();

      // Đính kèm file định danh ${episodeId}.txt ở thư mục gốc ZIP
      zip.addFile(`${episodeId}.txt`, new Uint8Array(0));
      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      // 6 luồng tải và giải mã XOR đồng thời trong RAM
      const tasks = pages.map((pageItem) => async () => {
        const rawBuffer = await Utils.fetchBuffer(pageItem.url, { "Referer": "https://zebrack-comic.shueisha.co.jp/" });
        const decryptedBytes = decryptZebrackXor(rawBuffer, pageItem.key);
        const ext = Utils.detectExt(decryptedBytes.buffer);

        return { fileName: `${pageItem.pageNo}.${ext}`, data: decryptedBytes };
      });

      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      for (const res of results) {
        if (res?.data) zip.addFile(res.fileName, res.data);
      }

      // Đặt tên ZIP chuẩn: [Tên Truyện] - [Tên Chap].zip
      const finalFileName = `${await getCleanTitle(episodeId)}.zip`;
      zip.download(finalFileName);

      if (ui) {
        ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
        ui.setBusy(false);
      }
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[zebrack-dl] Download error:", err);
    } finally {
      state.running = false;
    }
  }

  /* =========================================================================
   * GỌI API CHỦ ĐỘNG KHI HOOK ĐẾN MUỘN (FALLBACK CHO LINK MỞ TRỰC TIẾP)
   * ========================================================================= */
  async function fetchZebrackManifestFallback() {
    const p = WIN.location.pathname;
    const Utils = WIN.MangaUtils || globalThis.MangaUtils;
    let apiUrl = "", method = "GET", body = null;

    // 1. Nhánh Chapter lẻ: POST /v3/chapter_viewer
    const mChap = p.match(/\/title\/(\d+)\/chapter\/(\d+)/i);
    if (mChap) {
      apiUrl = "https://api2.zebrack-comic.com/api/v3/chapter_viewer";
      method = "POST";
      body = `os=browser&title_id=${mChap[1]}&chapter_id=${mChap[2]}&type=normal`;
    }

    // 2. Nhánh Volume Tankobon: GET /v3/manga_volume_viewer
    const mVol = p.match(/\/title\/(\d+)\/volume\/(\d+)/i);
    if (mVol) {
      apiUrl = `https://api2.zebrack-comic.com/api/v3/manga_volume_viewer?os=browser&title_id=${mVol[1]}&volume_id=${mVol[2]}&is_trial=1`;
    }

    // 3. Nhánh Tạp chí Magazine: GET /browser/magazine_viewer
    const mIssue = p.match(/\/magazine\/(\d+)\/issue\/(\d+)/i);
    if (mIssue) {
      apiUrl = `https://api.zebrack-comic.com/api/browser/magazine_viewer?os=browser&magazine_id=${mIssue[1]}&magazine_issue_id=${mIssue[2]}&is_trial=1`;
    }

    // 4. Nhánh Gravure: GET /v3/gravure_viewer
    const mGravure = p.match(/\/gravure\/(\d+)/i);
    if (mGravure) {
      apiUrl = `https://api2.zebrack-comic.com/api/v3/gravure_viewer?os=browser&gravure_id=${mGravure[1]}&is_trial=1`;
    }

    if (!apiUrl) return null;

    try {
      if (method === "POST") {
        const res = await WIN.fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "*/*" },
          body: body
        });
        if (res.ok) return await res.arrayBuffer();
      } else {
        const buf = await Utils.fetchBuffer(apiUrl);
        if (buf && buf.byteLength > 100) return buf;
      }
    } catch (e) {}

    return null;
  }

  /* =========================================================================
   * 7. KHỞI CHẠY (BOOT) & THEO DÕI ĐIỀU HƯỚNG SPA
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

    const episodeId = getEpisodeId();
    if (!episodeId) return;

    try {

      let rawPayload = state.capturedRawPayload;

      if (!rawPayload) {
        try {
          const cachedStr = sessionStorage.getItem(`zebrack_raw_${episodeId}`);
          if (cachedStr) {
            const arr = JSON.parse(cachedStr);
            if (Array.isArray(arr)) rawPayload = new Uint8Array(arr).buffer;
          }
        } catch (e) {}
      }

      // 2. Chờ gói tin tự nhiên từ hook trong 1.5s
      if (!rawPayload) {
        for (let i = 0; i < 10; i++) {
          if (state.capturedRawPayload) {
            rawPayload = state.capturedRawPayload;
            break;
          }
          await sleep(150);
        }
      }

      // 3. NẾU HOOK ĐẾN MUỘN (MỞ TAB TRỰC TIẾP): Chủ động gọi API ngay lập tức!
      if (!rawPayload) {
        rawPayload = await fetchZebrackManifestFallback();
      }

      state.capturedRawPayload = rawPayload;

      if (!rawPayload) {
        throw new Error("Không lấy được dữ liệu trang truyện.");
      }

      const pages = parseProtobufManifest(rawPayload);
      if (!pages || !pages.length) {
        throw new Error("Không thể bóc tách danh sách trang.");
      }

      state.chapterData = { episodeId, pages };

      // 3. Soi Magic Bytes thực tế của trang 1 sau giải mã XOR (Zero-Trust)
      const firstPage = pages[0];
      const Utils = WIN.MangaUtils || globalThis.MangaUtils;
      const testBuf = await Utils.fetchBuffer(firstPage.url, { "Referer": "https://zebrack-comic.shueisha.co.jp/" });
      const decryptedBytes = decryptZebrackXor(testBuf, firstPage.key);
      const realExt = Utils.detectExt(decryptedBytes.buffer);

      if (!realExt) throw new Error("Không thể nhận diện Magic Bytes ảnh.");

      if (ui) {
        await sleep(80);
        ui.updateProgress({
          completed: 0,
          total: pages.length,
          status: "Sẵn sàng.",
          format: realExt
        });
        ui.setBusy(false);
      }
    } catch (err) {
      console.error("[zebrack-dl] Boot error:", err);
      if (ui) {
        ui.updateProgress({ status: "Lỗi: " + (err?.message || "Không thể tải trang.") });
      }
    }
  }

  // Hook theo dõi SPA History
  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute((newUrl) => {
      if (!isEpisodeUrl()) {
        const ui = getUI();
        if (ui?.panel) ui.panel.style.display = "none";
        state.chapterData = null;
        state.lastEpisodeId = "";
        state.lastUrl = "";
        state.capturedRawPayload = null;
        state.running = false;
        return;
      }

      const currentEpId = getEpisodeId();
      if (state.lastEpisodeId && state.lastEpisodeId === currentEpId) return;

      state.lastUrl = newUrl;
      state.lastEpisodeId = currentEpId;
      state.chapterData = null;
      state.capturedRawPayload = null;
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