// ==UserScript==
// @name         EbookJapan Downloader
// @namespace    https://ebookjapan.yahoo.co.jp/
// @icon         https://play-lh.googleusercontent.com/_y6g7elu9JUiyApYhxYikneQZjxPrhIXdz4nuB6y8TreLY1wyhbhRi6WzexLR-mPLP01CYs_T8IElkxWndTNh4k=w240-h480-rw
// @version      1.0
// @description  Giải mã và tải chuẩn 100% ảnh truyện bị xáo trộn trên EbookJapan, có đóng gói ZIP, lưu tên trang theo số thứ tự tăng dần và một file txt lưu tên mã truyện tương ứng.
// @author       anonymous & AI
// @match        https://ebookjapan.yahoo.co.jp/bviewer*
// @match        https://ebookjapan.yahoo.co.jp/viewer/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      prod-contents-br-page.akamaized.net
// ==/UserScript==

(function protectedUserscript() {
  (function ebookJapanCanvasDownloader() {
    'use strict';

    const _0x291164 = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
    const _0x36383f = _0x291164.document;

    // =========================================================================
    // 1. BỘ ĐÓNG GÓI ZIP NGUYÊN BẢN (PURE ZIP WRITER)
    // =========================================================================
    class PureZipWriter {
      constructor() {
        this.files = [];
      }

      addFile(filename, uint8Array) {
        this.files.push({ name: filename, data: uint8Array });
      }

      static crc32(data) {
        let crc = -1;
        for (let i = 0; i < data.length; i++) {
          crc = (crc >>> 8) ^ PureZipWriter.crcTable[(crc ^ data[i]) & 0xFF];
        }
        return (crc ^ -1) >>> 0;
      }

      generateBlob() {
        const parts = [];
        const centralEntries = [];
        let offset = 0;
        const enc = new TextEncoder();

        for (const file of this.files) {
          const nameBytes = enc.encode(file.name);
          const dataBytes = file.data;
          const crc = PureZipWriter.crc32(dataBytes);
          const size = dataBytes.length;

          // Local File Header
          const header = new Uint8Array(30 + nameBytes.length);
          const view = new DataView(header.buffer);
          view.setUint32(0, 0x04034b50, true);
          view.setUint16(4, 20, true);
          view.setUint16(6, 0, true);
          view.setUint16(8, 0, true); // STORE mode
          view.setUint16(10, 0, true);
          view.setUint16(12, 0, true);
          view.setUint32(14, crc, true);
          view.setUint32(18, size, true);
          view.setUint32(22, size, true);
          view.setUint16(26, nameBytes.length, true);
          view.setUint16(28, 0, true);
          header.set(nameBytes, 30);

          parts.push(header);
          parts.push(dataBytes);

          // Central Directory Header
          const cent = new Uint8Array(46 + nameBytes.length);
          const cview = new DataView(cent.buffer);
          cview.setUint32(0, 0x02014b50, true);
          cview.setUint16(4, 20, true);
          cview.setUint16(6, 20, true);
          cview.setUint16(8, 0, true);
          cview.setUint16(10, 0, true);
          cview.setUint16(12, 0, true);
          cview.setUint16(14, 0, true);
          cview.setUint32(16, crc, true);
          cview.setUint32(20, size, true);
          cview.setUint32(24, size, true);
          cview.setUint16(28, nameBytes.length, true);
          cview.setUint16(30, 0, true);
          cview.setUint16(32, 0, true);
          cview.setUint16(34, 0, true);
          cview.setUint16(36, 0, true);
          cview.setUint32(38, 0, true);
          cview.setUint32(42, offset, true);
          cent.set(nameBytes, 46);

          centralEntries.push(cent);
          offset += header.length + size;
        }

        let centralSize = 0;
        for (const cent of centralEntries) {
          parts.push(cent);
          centralSize += cent.length;
        }

        // End of Central Directory Record
        const eocd = new Uint8Array(22);
        const eview = new DataView(eocd.buffer);
        eview.setUint32(0, 0x06054b50, true);
        eview.setUint16(4, 0, true);
        eview.setUint16(6, 0, true);
        eview.setUint16(8, this.files.length, true);
        eview.setUint16(10, this.files.length, true);
        eview.setUint32(12, centralSize, true);
        eview.setUint32(16, offset, true);
        eview.setUint16(20, 0, true);

        parts.push(eocd);

        return new Blob(parts, { type: 'application/zip' });
      }
    }

    PureZipWriter.crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      PureZipWriter.crcTable[i] = c;
    }

    function getBookCode(validPages = []) {
      try {
        if (Array.isArray(validPages) && validPages.length > 0) {
          for (const p of validPages) {
            const rawSrc = p.data?.currentSrc || p.data?.src || '';
            const match = rawSrc.match(/([A-Za-z0-9]+)-\d+\.(?:jpg|png|webp|jpeg)/i);
            if (match && match[1]) {
              return match[1].toUpperCase();
            }
          }
        }
        const url = new URL(_0x291164.location.href);
        const code = url.searchParams.get("code") || url.pathname.split('/').filter(Boolean).pop() || '';
        const codeMatch = code.match(/([A-Za-z0-9]+)/);
        if (codeMatch && codeMatch[1]) {
          return codeMatch[1].toUpperCase();
        }
        return "B00000000000";
      } catch {
        return "B00000000000";
      }
    }

    function sanitizeTitle(str) {
      if (!str || typeof str !== 'string') return '';
      return str.replace(/[\\/*?:"<>|]/g, '').replace(/\s+/g, ' ').trim();
    }

    function getCleanMangaTitle() {
      try {
        // 1. Lấy từ React Fiber Reader (RAM) nếu khả thi
        const reader = _0x260073();
        if (reader) {
          const pd = reader.paperDesign || reader.loader || {};
          const candidate = pd.volumeName || pd.title || pd.bookTitle || pd.name || pd.seriesTitle;
          if (typeof candidate === "string" && candidate.trim().length > 2 && !candidate.includes("無料") && !candidate.includes("電子書籍")) {
            return sanitizeTitle(candidate);
          }
        }

        // 2. Trích xuất chuẩn xác từ thẻ __NUXT_DATA__ (Duyệt cả trang hiện tại, parent và top window)
        let nuxtEl = null;
        const docsToSearch = [_0x36383f];
        try { if (_0x291164.parent && _0x291164.parent.document) docsToSearch.push(_0x291164.parent.document); } catch {}
        try { if (_0x291164.top && _0x291164.top.document) docsToSearch.push(_0x291164.top.document); } catch {}

        for (const doc of docsToSearch) {
          try {
            nuxtEl = doc.getElementById("__NUXT_DATA__");
            if (nuxtEl) break;
          } catch {}
        }

        if (nuxtEl && nuxtEl.textContent) {
          try {
            const arr = JSON.parse(nuxtEl.textContent);
            if (Array.isArray(arr)) {
              // Hàm giải nén index của Nuxt 3
              const resolve = x => (typeof x === "number" && arr[x] !== undefined) ? arr[x] : x;

              // 2.1. Quét đối tượng xuất bản
              for (const item of arr) {
                if (item && typeof item === "object" && (item.publicationCd !== undefined || item.goods !== undefined)) {
                  const nameStr = resolve(item.name);
                  const volStr = resolve(item.volumeName);
                  const titleObj = resolve(item.title);
                  const titleNameStr = (titleObj && typeof titleObj === "object") ? resolve(titleObj.name) : resolve(titleObj);

                  const candidates = [nameStr, titleNameStr, volStr];
                  for (const cand of candidates) {
                    if (typeof cand === "string") {
                      const trimmed = cand.trim();
                      if (trimmed.length > 2 && !/^\d+$/.test(trimmed) && !trimmed.includes("無料漫画")) {
                        return sanitizeTitle(trimmed);
                      }
                    }
                  }
                }
              }

              // 2.2. Dự phòng: Quét chuỗi Tiếng Nhật dài nhất trong mảng __NUXT_DATA__ (Giống 100% Python)
              for (const item of arr) {
                if (typeof item === "string") {
                  const str = item.trim();
                  if (
                    str.length > 5 &&
                    !str.startsWith("http") &&
                    !str.includes("2026") &&
                    !str.includes("PayPay") &&
                    !str.includes("ログイン") &&
                    !str.includes("お知らせ") &&
                    /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(str)
                  ) {
                    return sanitizeTitle(str);
                  }
                }
              }
            }
          } catch (e) {
            console.warn("[ej-canvas-dl] Lỗi parse __NUXT_DATA__:", e);
          }
        }

        // 3. Dự phòng từ DOM / Document Title
        for (const doc of docsToSearch) {
          try {
            const titleEl = doc.querySelector(".header__title, h2.header__title, .heading h2, header h2, h2");
            if (titleEl && titleEl.textContent) {
              const txt = titleEl.textContent.trim();
              if (txt && txt.length > 2 && !txt.includes("無料") && !txt.includes("電子書籍")) {
                return sanitizeTitle(txt);
              }
            }
            if (doc.title) {
              let raw = doc.title.replace(/【[^】]*】/g, '').replace(/無料漫画.*/g, '').trim();
              let parts = raw.split(/[｜|\-]/).map(p => p.trim()).filter(Boolean);
              for (let p of parts) {
                if (!/無料|電子書籍|ebookjapan/i.test(p) && p.length > 2) {
                  return sanitizeTitle(p);
                }
              }
            }
          } catch {}
        }

        return "EbookJapan_Manga";
      } catch {
        return "EbookJapan_Manga";
      }
    }

    // =========================================================================
    // 2. TOÀN BỘ CÁC HÀM GIẢI XÁO TRỘN GỐC CỦA EBOOKJAPAN (GIỮ NGUYÊN 100%)
    // =========================================================================
    const _0x36f0fb = {
      extension: "png",
      type: "image/png",
      quality: undefined
    };
    _0x36f0fb.label = "PNG";
    const _0x556adf = {
      extension: "jpg",
      type: "image/jpeg",
      quality: 0.95,
      label: "JPG"
    };
    const _0x4b7db3 = {
      extension: "jpeg",
      type: "image/jpeg",
      quality: 0.95,
      label: "JPEG"
    };
    const _0x5e2519 = {
      extension: "webp",
      type: "image/webp",
      quality: 1,
      label: "WEBP"
    };
    const _0x519599 = {
      extension: "avif",
      type: "image/avif",
      quality: 1,
      label: "AVIF"
    };
    const _0x283fe1 = Object.freeze({
      'png': Object.freeze(_0x36f0fb),
      'jpg': Object.freeze(_0x556adf),
      'jpeg': Object.freeze(_0x4b7db3),
      'webp': Object.freeze(_0x5e2519),
      'avif': Object.freeze(_0x519599)
    });
    const _0x40a243 = _0x283fe1.png;
    const _0x37892f = _0x56e72c => new Promise(_0x33db7e => setTimeout(_0x33db7e, _0x56e72c));
    function _0x27e5f4(_0x28be9f) {
      try {
        return _0x291164.localStorage.getItem(_0x28be9f) === '1';
      } catch (_0x484ec4) {
        return false;
      }
    }
    function _0x375fac(_0x351cc9, _0x180434) {
      try {
        _0x291164.localStorage.setItem(_0x351cc9, _0x180434 ? '1' : '0');
      } catch (_0x1c22dd) {}
    }
    const _0x13e7db = {
      canvasToBlob: _0x291164.HTMLCanvasElement?.["prototype"]?.["toBlob"],
      contextDrawImage: _0x291164.CanvasRenderingContext2D?.["prototype"]?.["drawImage"]
    };
    const _0x5bf2d4 = {
      completed: 0x0,
      total: 0x0,
      stage: 0x0,
      percent: 0x0,
      status: "Đang chờ viewer..."
    };
    const _0x369466 = {
      'running': false,
      'convertJpeg': _0x27e5f4("ej-canvas-dl:convert-jpeg"),
      'pageLoads': new WeakMap(),
      'ui': null,
      'lastProgress': _0x5bf2d4
    };
    function _0x2327d0(_0x60a160, _0x47ce12) {
      return _0x47ce12.split('/').reduce((_0x1957da, _0x1cf7c5) => {
        if (!_0x1957da || typeof _0x1957da !== "object") {
          return undefined;
        }
        return _0x1957da[_0x1cf7c5];
      }, _0x60a160);
    }
    function _0x34f4dd(_0x255c47, _0x18a4f6, _0x5dd60c) {
      const _0x3df4d0 = _0x18a4f6.split('/');
      let _0x42a403 = _0x255c47;
      for (let _0x42789c = 0; _0x42789c < _0x3df4d0.length - 1; _0x42789c += 1) {
        const _0x23f49c = _0x3df4d0[_0x42789c];
        if (!_0x42a403[_0x23f49c] || typeof _0x42a403[_0x23f49c] !== "object") {
          _0x42a403[_0x23f49c] = {};
        }
        _0x42a403 = _0x42a403[_0x23f49c];
      }
      const _0x4d49bd = _0x3df4d0[_0x3df4d0.length - 1];
      const _0x4e0bfe = _0x42a403[_0x4d49bd] !== _0x5dd60c;
      _0x42a403[_0x4d49bd] = _0x5dd60c;
      return _0x4e0bfe;
    }
    function _0x4556cc(_0x2df232) {
      if (!_0x2df232) {
        return {};
      }
      const _0xda458d = JSON.parse(_0x2df232);
      return _0xda458d && typeof _0xda458d === "object" ? _0xda458d : {};
    }
    function _0x15db78(_0x31fdd5, _0xab8ce9) {
      try {
        const _0x33e81c = typeof _0x291164.StorageEvent === "function" ? new _0x291164.StorageEvent("storage", {
          'key': "brconfig",
          'oldValue': _0x31fdd5,
          'newValue': _0xab8ce9,
          'url': _0x291164.location.href,
          'storageArea': _0x291164.localStorage
        }) : new _0x291164.Event("storage");
        _0x291164.dispatchEvent(_0x33e81c);
      } catch {}
    }
    function _0x266741() {
      try {
        const _0x3895cd = _0x4556cc(_0x291164.localStorage.getItem("brconfig"));
        return {
          'spread': _0x2327d0(_0x3895cd, "viewer/spread") === true || _0x2327d0(_0x3895cd, "viewer/spread") === "true" || _0x2327d0(_0x3895cd, "viewer/spread") === 1 || _0x2327d0(_0x3895cd, "viewer/spread") === '1',
          'vertical': _0x2327d0(_0x3895cd, "viewer/vertical") === true || _0x2327d0(_0x3895cd, "viewer/vertical") === "true" || _0x2327d0(_0x3895cd, "viewer/vertical") === 1 || _0x2327d0(_0x3895cd, "viewer/vertical") === '1',
          'divid': _0x2327d0(_0x3895cd, "viewer/divid") ?? null
        };
      } catch {
        return null;
      }
    }
    function _0x224e25() {
      try {
        const _0x3711ce = _0x291164.localStorage.getItem("brconfig");
        let _0x56767e;
        try {
          _0x56767e = _0x4556cc(_0x3711ce);
        } catch {
          _0x56767e = {};
        }
        const _0x812745 = [_0x34f4dd(_0x56767e, "viewer/spread", false), _0x34f4dd(_0x56767e, "viewer/vertical", true), _0x34f4dd(_0x56767e, "viewer/divid", 0x0)].some(Boolean);
        if (_0x812745) {
          const _0x2f6040 = JSON.stringify(_0x56767e);
          _0x291164.localStorage.setItem("brconfig", _0x2f6040);
          _0x15db78(_0x3711ce, _0x2f6040);
        }
        return {
          'ok': true,
          'changed': _0x812745,
          'mode': _0x266741()
        };
      } catch (_0x18f69a) {
        console.warn("[ej-canvas-dl] Không thể ép chế độ đọc dọc 1 ảnh", _0x18f69a);
        return {
          'ok': false,
          'changed': false,
          'error': _0x18f69a?.["message"] || String(_0x18f69a),
          'mode': null
        };
      }
    }
    function _0x13a92c() {
      let _0x536aae = null;
      let _0x32b40e = 0;
      for (const _0x497808 of _0x36383f.querySelectorAll("canvas")) {
        if (_0x497808.width <= 0 || _0x497808.height <= 0) {
          continue;
        }
        const _0x56416d = _0x497808.getBoundingClientRect();
        const _0x54cd04 = Math.max(0, _0x56416d.width) * Math.max(0, _0x56416d.height) || _0x497808.width * _0x497808.height;
        if (_0x54cd04 > _0x32b40e) {
          _0x536aae = _0x497808;
          _0x32b40e = _0x54cd04;
        }
      }
      return _0x536aae;
    }
    function _0x11fc37(_0x314f0e) {
      if (!_0x314f0e) {
        return null;
      }
      const _0x15d329 = Object.keys(_0x314f0e).find(_0x7b094e => _0x7b094e.startsWith("__reactFiber"));
      let _0x2c2a5b = _0x15d329 ? _0x314f0e[_0x15d329] : null;
      for (let _0x23f446 = 0; _0x2c2a5b && _0x23f446 < 50; _0x2c2a5b = _0x2c2a5b["return"], _0x23f446 += 1) {
        let _0x109980 = _0x2c2a5b.memoizedState;
        for (let _0x4e6935 = 0; _0x109980 && _0x4e6935 < 80; _0x109980 = _0x109980.next, _0x4e6935 += 1) {
          const _0x4037ce = _0x109980.memoizedState;
          if (_0x4037ce && typeof _0x4037ce === "object" && _0x4037ce.loader && _0x4037ce.paperDesign && Array.isArray(_0x4037ce.loader.pages)) {
            return _0x4037ce;
          }
        }
      }
      return null;
    }
    function _0x260073() {
      const _0x906c46 = _0x11fc37(_0x13a92c());
      if (_0x906c46) {
        return _0x906c46;
      }
      for (const _0x594ba9 of _0x36383f.querySelectorAll("canvas")) {
        const _0x4ed462 = _0x11fc37(_0x594ba9);
        if (_0x4ed462) {
          return _0x4ed462;
        }
      }
      return null;
    }
    function _0x5400fc(_0x77f125 = _0x260073()) {
      const _0x86b980 = _0x77f125?.["loader"]?.["pages"];
      if (!Array.isArray(_0x86b980)) {
        return [];
      }
      return _0x86b980.filter(_0x381d4c => _0x381d4c && !_0x381d4c.isInvalidPage && Number(_0x381d4c.width) > 0 && Number(_0x381d4c.height) > 0 && _0x381d4c.loader && typeof _0x381d4c.loader.shuffle === "function").sort((_0xad7e0c, _0x2d9cff) => (Number(_0xad7e0c.page) || 0) - (Number(_0x2d9cff.page) || 0));
    }
    async function _0x46fbf4(_0x54066f = 20000) {
      const _0x570010 = Date.now();
      while (Date.now() - _0x570010 < _0x54066f) {
        const _0x357e51 = _0x260073();
        const _0x5d8eb6 = _0x5400fc(_0x357e51);
        if (_0x357e51 && _0x5d8eb6.length > 0) {
          return {
            'reader': _0x357e51,
            'pages': _0x5d8eb6
          };
        }
        _0xba03cc({ status: "Đang tải...", completed: 0, total: 0, stage: 0 });
        await _0x37892f(200);
      }
      throw new Error("Không tìm thấy reader/pages của EbookJapan viewer. Hãy reload trang bviewer rồi thử lại.");
    }
    function _0x20bc2c(_0x2a319b, _0x5938ad = 0) {
      const _0x4ef6d0 = Number(_0x2a319b?.["page"]);
      return Number.isFinite(_0x4ef6d0) ? _0x4ef6d0 + 1 : _0x5938ad + 1;
    }
    function _0x37d956(_0x3c91e7) {
      if (!_0x3c91e7) {
        return Promise.resolve();
      }
      if (_0x3c91e7.complete && _0x3c91e7.naturalWidth > 0 && _0x3c91e7.naturalHeight > 0) {
        return Promise.resolve();
      }
      if (typeof _0x3c91e7.decode === "function") {
        return _0x3c91e7.decode()["catch"](() => undefined);
      }
      return new Promise((_0x4852c3, _0x28f2d4) => {
        const _0x55e103 = {
          once: true
        };
        _0x3c91e7.addEventListener("load", _0x4852c3, _0x55e103);
        const _0x2af3b7 = {
          once: true
        };
        _0x3c91e7.addEventListener("error", () => _0x28f2d4(new Error("Raw image load failed.")), _0x2af3b7);
      });
    }
    function _0x35b542(_0x53117b) {
      const _0x2a8e49 = String(_0x53117b || '');
      if (!_0x2a8e49) {
        return '';
      }
      try {
        const _0x24b1ec = new URL(_0x2a8e49, _0x291164.location.href);
        _0x24b1ec.pathname = _0x24b1ec.pathname.replace(/_s(\.[^/.?#]+)$/i, '$1');
        return _0x24b1ec.href;
      } catch {
        return _0x2a8e49.replace(/_s(\.[a-z0-9]+)(?=([?#]|$))/i, '$1');
      }
    }
    function _0x44ebf0(_0x3b2499) {
      const _0x2f8f19 = String(_0x3b2499 || '');
      if (!_0x2f8f19) {
        return false;
      }
      try {
        return /_s\.[^/.?#]+$/i.test(new URL(_0x2f8f19, _0x291164.location.href).pathname);
      } catch {
        return /_s\.[a-z0-9]+(?=([?#]|$))/i.test(_0x2f8f19);
      }
    }
    function _0x49e87e(_0x5c1031) {
      const _0x6b79f8 = String(_0x5c1031 || '');
      if (!_0x6b79f8) {
        return '';
      }
      try {
        const _0x4dd1ad = new URL(_0x6b79f8, _0x291164.location.href);
        return /\.([a-z0-9]+)$/i.exec(_0x4dd1ad.pathname)?.[1]?.["toLowerCase"]() || '';
      } catch {
        return /\.([a-z0-9]+)(?=([?#]|$))/i.exec(_0x6b79f8)?.[1]?.["toLowerCase"]() || '';
      }
    }
    function _0x24bf34(_0x3d8360, _0x4b9919) {
      const _0xfb18f8 = String(_0x3d8360 || '');
      const _0x17f49f = String(_0x4b9919 || '').replace(/^\./, '').toLowerCase();
      if (!_0xfb18f8 || !_0x17f49f) {
        return _0xfb18f8;
      }
      try {
        const _0x17a373 = new URL(_0xfb18f8, _0x291164.location.href);
        _0x17a373.pathname = _0x17a373.pathname.replace(/\.([a-z0-9]+)$/i, '.' + _0x17f49f);
        return _0x17a373.href;
      } catch {
        return _0xfb18f8.replace(/\.([a-z0-9]+)(?=([?#]|$))/i, '.' + _0x17f49f);
      }
    }
    function _0x4bc7ad(_0x50719c) {
      const _0x1c9bc6 = String(_0x50719c || '');
      if (!_0x1c9bc6) {
        return [];
      }
      const _0x39e487 = [];
      const _0x2021e2 = _0x516586 => {
        if (_0x516586 && !_0x39e487.includes(_0x516586)) {
          _0x39e487.push(_0x516586);
        }
      };
      if (_0x49e87e(_0x1c9bc6) === "webp") {
        _0x2021e2(_0x24bf34(_0x1c9bc6, "jpg"));
      }
      _0x2021e2(_0x1c9bc6);
      return _0x39e487;
    }
    function _0xf45af9(_0x311437, _0x4ca1a5 = _0x40a243) {
      return _0x283fe1[_0x49e87e(_0x311437)] || _0x4ca1a5;
    }
    function _0x1423b2(_0x35b147) {
      try {
        const _0x423340 = new URL(_0x35b147, _0x291164.location.href);
        return /^https?:$/.test(_0x423340.protocol);
      } catch {
        return false;
      }
    }
    function _0x400c0b(_0x1da18d = '') {
      return /content-type:\s*([^\r\n;]+)/i.exec(_0x1da18d)?.[1]?.["trim"]() || '';
    }
    function _0x54704b(_0x4de178) {
      return new Promise((_0x2a11f6, _0x51d31a) => {
        const _0x32f7ba = _0xf45af9(_0x4de178, null)?.["type"] || '';
        if (typeof GM_xmlhttpRequest === "function") {
          GM_xmlhttpRequest({
            'method': "GET",
            'url': _0x4de178,
            'responseType': "blob",
            'timeout': 0xafc8,
            'onload': _0x428c9e => {
              if (_0x428c9e.status < 200 || _0x428c9e.status >= 300) {
                _0x51d31a(new Error("GM_xmlhttpRequest " + _0x428c9e.status + " khi tải ảnh raw."));
                return;
              }
              const _0x397c9d = _0x400c0b(_0x428c9e.responseHeaders);
              const _0x212b18 = _0x397c9d || _0x428c9e.response?.["type"] || _0x32f7ba || "application/octet-stream";
              const _0x18903c = {
                type: _0x212b18
              };
              const _0x13b97a = new Blob([_0x428c9e.response], _0x18903c);
              if (_0x13b97a.size > 0) {
                _0x2a11f6(_0x13b97a);
              } else {
                _0x51d31a(new Error("GM_xmlhttpRequest trả về ảnh raw rỗng."));
              }
            },
            'onerror': () => _0x51d31a(new Error("GM_xmlhttpRequest lỗi khi tải ảnh raw.")),
            'ontimeout': () => _0x51d31a(new Error("GM_xmlhttpRequest timeout khi tải ảnh raw."))
          });
          return;
        }
        const _0x15c12d = {
          credentials: "include",
          "mode": "cors"
        };
        _0x291164.fetch(_0x4de178, _0x15c12d).then(_0x289ca0 => {
          if (!_0x289ca0.ok) {
            throw new Error("fetch " + _0x289ca0.status + " khi tải ảnh raw.");
          }
          return _0x289ca0.blob();
        }).then(_0x29ba3c => {
          const _0x37d78e = _0x32f7ba && _0x29ba3c.type !== _0x32f7ba ? new Blob([_0x29ba3c], {
            'type': _0x32f7ba
          }) : _0x29ba3c;
          if (_0x37d78e.size > 0) {
            _0x2a11f6(_0x37d78e);
          } else {
            _0x51d31a(new Error("fetch trả về ảnh raw rỗng."));
          }
        })["catch"](_0x43ff75 => {
          _0x51d31a(new Error("Không có GM_xmlhttpRequest hoặc CORS để làm sạch ảnh raw: " + (_0x43ff75?.["message"] || _0x43ff75)));
        });
      });
    }
    async function _0x2e93aa(_0x55c744) {
      const _0x3db943 = await _0x54704b(_0x55c744);
      const _0x491319 = _0x291164.URL.createObjectURL(_0x3db943);
      const _0x236e7a = new _0x291164.Image();
      _0x236e7a.decoding = "async";
      _0x236e7a.src = _0x491319;
      try {
        await _0x37d956(_0x236e7a);
        return {
          'image': _0x236e7a,
          'revoke': () => _0x291164.URL.revokeObjectURL(_0x491319)
        };
      } catch (_0x3775a7) {
        _0x291164.URL.revokeObjectURL(_0x491319);
        throw _0x3775a7;
      }
    }
    function _0xeed374(_0x647c23) {
      if (!_0x647c23) {
        return Promise.reject(new Error("Viewer page is missing."));
      }
      let _0x34d76b = _0x369466.pageLoads.get(_0x647c23);
      if (!_0x34d76b) {
        _0x34d76b = (async () => {
          try {
            if ((!_0x647c23.done || !_0x647c23.data && !_0x647c23.bmp) && typeof _0x647c23.getImage === "function") {
              await _0x647c23.getImage();
            }
            if (_0x647c23.data) {
              await _0x37d956(_0x647c23.data);
            }
            if (!_0x647c23.data && !_0x647c23.bmp) {
              throw new Error("Không load được ảnh raw cho page " + _0x20bc2c(_0x647c23) + '.');
            }
            return _0x647c23;
          } catch (_0xf863aa) {
            _0x369466.pageLoads["delete"](_0x647c23);
            throw _0xf863aa;
          }
        })();
        _0x369466.pageLoads.set(_0x647c23, _0x34d76b);
      }
      return _0x34d76b;
    }
    function _0x540fc4(_0x371331) {
      const _0x8ceccc = Number(_0x371331.width) || Number(_0x371331.bmp?.["width"]) || Number(_0x371331.data?.["width"]) || 1;
      const _0x1e0f85 = Number(_0x371331.height) || Number(_0x371331.bmp?.["height"]) || Number(_0x371331.data?.["height"]) || 1;
      return {
        'width': Math.max(1, Math.floor(_0x8ceccc)),
        'height': Math.max(1, Math.floor(_0x1e0f85))
      };
    }
    function _0x118e02(_0x2671ae, _0x18eba2, _0x9a8e94 = true) {
      if (_0x9a8e94 && typeof _0x291164.OffscreenCanvas === "function") {
        try {
          const _0xbe5e2b = new _0x291164.OffscreenCanvas(_0x2671ae, _0x18eba2);
          const _0x39130d = _0xbe5e2b.getContext('2d');
          if (_0x39130d) {
            return {
              'canvas': _0xbe5e2b,
              'ctx': _0x39130d,
              'offscreen': true,
              'width': _0x2671ae,
              'height': _0x18eba2
            };
          }
        } catch {}
      }
      const _0x4ceab4 = _0x36383f.createElement("canvas");
      _0x4ceab4.width = _0x2671ae;
      _0x4ceab4.height = _0x18eba2;
      const _0xb6578c = _0x4ceab4.getContext('2d');
      if (!_0xb6578c) {
        throw new Error("Không tạo được canvas xuất ảnh.");
      }
      const _0x57da66 = {
        canvas: _0x4ceab4,
        ctx: _0xb6578c,
        offscreen: false,
        width: _0x2671ae,
        height: _0x18eba2
      };
      return _0x57da66;
    }
    function _0x3c5a10(_0x1cbb75, _0x379280, _0x119886, _0x5b0125) {
      const _0x2858c3 = typeof _0x1cbb75.drawImage === "function" ? _0x1cbb75.drawImage : _0x13e7db.contextDrawImage;
      if (typeof _0x2858c3 !== "function") {
        throw new Error("Canvas context không hỗ trợ drawImage.");
      }
      _0x2858c3.call(_0x1cbb75, _0x379280, 0, 0, _0x119886, _0x5b0125);
    }
    function _0x2d746f(_0x261c21) {
      const _0x1fc486 = Number(_0x261c21?.["page"]);
      return Number.isFinite(_0x1fc486) ? _0x1fc486 : Math.max(0, _0x20bc2c(_0x261c21) - 1);
    }
    function _0x35cbe0(_0x5943ff, _0x447ce6 = {}) {
      const _0x3e6bbf = Number(_0x291164.devicePixelRatio) || 1;
      const _0x4876d9 = Number(_0x291164.screen?.["availHeight"]) || Number(_0x291164.innerHeight) || 1200;
      const _0x4b71ea = Number(_0x5943ff?.["resizeThreashold"]) || 1.25;
      const _0x37e0d6 = Number(_0x5943ff?.["resizeMax"]) || 1200;
      const _0x20b977 = Number(_0x5943ff?.["forceResize"]) || 0;
      return {
        'dpr': _0x3e6bbf,
        'limit': Math.floor(_0x4876d9 * _0x3e6bbf * _0x4b71ea),
        'size': _0x37e0d6,
        'flag': _0x20b977,
        ..._0x447ce6
      };
    }
    function _0x595179(_0x5124bb, _0x3316c4) {
      const _0x51ef95 = _0x5124bb?.["pages"]?.[_0x2d746f(_0x3316c4)];
      const _0x4ee19c = Math.floor(Number(_0x51ef95?.["width"]) || 0);
      const _0x34f319 = Math.floor(Number(_0x51ef95?.["height"]) || 0);
      if (_0x4ee19c > 0 && _0x34f319 > 0) {
        return {
          'width': _0x4ee19c,
          'height': _0x34f319
        };
      }
      return null;
    }
    function _0x153016(_0x14aaf7, _0x34503b) {
      if (!_0x34503b || !(typeof _0x14aaf7?.["funcs"]?.["openParam"] === "function")) {
        return;
      }
      try {
        _0x14aaf7.funcs.openParam(_0x34503b);
      } catch {}
    }
    function _0x3b2527(_0x245bff) {
      const _0x58d5ac = _0x245bff?.["loader"];
      if (!(typeof _0x58d5ac?.["funcs"]?.["openParam"] === "function")) {
        return null;
      }
      const _0x5057e2 = _0x35cbe0(_0x58d5ac);
      const _0x152c19 = {
        flag: 0x1
      };
      const _0x3e9e18 = _0x35cbe0(_0x58d5ac, _0x152c19);
      try {
        const _0x5443ae = _0x58d5ac.funcs.openParam(_0x3e9e18);
        const _0x506bbf = _0x595179(_0x5443ae, _0x245bff);
        if (!_0x506bbf) {
          return null;
        }
        const _0x525099 = _0x540fc4(_0x245bff);
        if (_0x506bbf.width <= _0x525099.width || _0x506bbf.height <= _0x525099.height) {
          return null;
        }
        return {
          'name': "full-size-openParam",
          'args': _0x3e9e18,
          'restoreArgs': _0x5057e2,
          'width': _0x506bbf.width,
          'height': _0x506bbf.height,
          'imageTypes': Number(_0x5443ae?.["image_types"]) || 0
        };
      } catch {
        return null;
      } finally {
        _0x153016(_0x58d5ac, _0x5057e2);
      }
    }
    function _0x554d46(_0x5c8e76) {
      const _0x4a25a8 = _0x540fc4(_0x5c8e76);
      const _0x25caa5 = _0x5c8e76?.["loader"];
      return {
        'name': "viewer-openParam",
        'args': typeof _0x25caa5?.["funcs"]?.["openParam"] === "function" ? _0x35cbe0(_0x25caa5) : null,
        'restoreArgs': typeof _0x25caa5?.["funcs"]?.["openParam"] === "function" ? _0x35cbe0(_0x25caa5) : null,
        'width': _0x4a25a8.width,
        'height': _0x4a25a8.height,
        'imageTypes': Number(_0x25caa5?.["types"]) || 0
      };
    }
    function _0x16e3ac(_0x3cb965, _0x2c4f1e, _0x6234c) {
      if (!_0x2c4f1e?.["args"] || !(typeof _0x3cb965?.["funcs"]?.["openParam"] === "function")) {
        return _0x6234c();
      }
      _0x3cb965.funcs.openParam(_0x2c4f1e.args);
      try {
        return _0x6234c();
      } finally {
        _0x153016(_0x3cb965, _0x2c4f1e.restoreArgs);
      }
    }
    function _0x477fd4(_0x364711) {
      const _0x26a23d = _0x364711.data?.["currentSrc"] || _0x364711.data?.["src"] || '';
      const _0x329ea0 = _0x35b542(_0x26a23d);
      const _0x25926d = [];
      if (_0x26a23d && _0x329ea0 && _0x329ea0 !== _0x26a23d && _0x44ebf0(_0x26a23d) && _0x1423b2(_0x329ea0)) {
        const _0x3fccad = _0x3b2527(_0x364711);
        if (_0x3fccad) {
          for (const _0x95c607 of _0x4bc7ad(_0x329ea0)) {
            if (!_0x1423b2(_0x95c607)) {
              continue;
            }
            _0x25926d.push({
              'url': _0x95c607,
              'outputUrl': _0x95c607,
              'format': _0xf45af9(_0x95c607),
              'profile': _0x3fccad,
              'source': _0x49e87e(_0x95c607) === "jpg" ? "clean-shuffle-full-jpg" : "clean-shuffle-full"
            });
          }
        }
      }
      if (_0x26a23d && _0x1423b2(_0x26a23d)) {
        for (const _0x1c3fca of _0x4bc7ad(_0x26a23d)) {
          if (!_0x1423b2(_0x1c3fca)) {
            continue;
          }
          _0x25926d.push({
            'url': _0x1c3fca,
            'outputUrl': _0x1c3fca,
            'format': _0xf45af9(_0x1c3fca),
            'profile': _0x554d46(_0x364711),
            'source': _0x49e87e(_0x1c3fca) === "jpg" ? "clean-shuffle-viewer-jpg" : "clean-shuffle-viewer"
          });
        }
      }
      return _0x25926d;
    }
    function _0x40bc9c(_0x450107, _0x419233, _0x1e7fa9) {
      const _0x2c3238 = {
        image: _0x1e7fa9
      };
      _0x419233.loader.shuffle({
        'ctx': _0x450107,
        'x': 0x0,
        'y': 0x0,
        'data': _0x2c3238,
        'autographed': _0x419233.autographed,
        'page': _0x2d746f(_0x419233)
      });
    }
    function _0x314e23(_0x771481, _0x4775e4) {
      if (!_0x771481 || _0x771481.size <= 0) {
        throw new Error("Canvas trả về " + (_0x4775e4?.["label"] || String(_0x4775e4?.["type"] || "ảnh").replace(/^image\//, '').toUpperCase()) + " rỗng.");
      }
      const _0x5eb43a = String(_0x771481.type || '').toLowerCase();
      const _0x1738ce = String(_0x4775e4?.["type"] || '').toLowerCase();
      if (_0x5eb43a && _0x1738ce && _0x5eb43a !== _0x1738ce) {
        throw new Error("Trình duyệt không hỗ trợ export " + (_0x4775e4?.["label"] || String(_0x4775e4?.["type"] || "ảnh").replace(/^image\//, '').toUpperCase()) + "; canvas trả về " + _0x5eb43a + '.');
      }
      return _0x771481;
    }
    function _0x5e5de1(_0x30ca26, _0x377def, _0x439e3e, _0x3c2141) {
      return new Promise((_0x4af01f, _0x19f806) => {
        const _0x36b044 = _0x13e7db.canvasToBlob || _0x30ca26.toBlob;
        if (typeof _0x36b044 !== "function") {
          _0x19f806(new Error("Không có hàm export canvas " + _0x377def.replace(/^image\//, '').toUpperCase() + '.'));
          return;
        }
        try {
          _0x36b044.call(_0x30ca26, _0x1aef00 => {
            if (_0x1aef00 && _0x1aef00.size > 0) {
              _0x4af01f(_0x1aef00);
            } else {
              _0x19f806(new Error(_0x3c2141));
            }
          }, _0x377def, _0x439e3e);
        } catch (_0x43cdfb) {
          _0x19f806(_0x43cdfb);
        }
      });
    }
    async function _0x1ecdb3(_0x112c6f, _0x53ca0e = _0x40a243) {
      const _0xe059d5 = _0x53ca0e || _0x40a243;
      const _0x5e8a0c = {
        type: _0xe059d5.type
      };
      if (Number.isFinite(_0xe059d5.quality)) {
        _0x5e8a0c.quality = _0xe059d5.quality;
      }
      if (_0x112c6f.offscreen && typeof _0x112c6f.canvas.convertToBlob === "function") {
        const _0x541916 = await _0x112c6f.canvas.convertToBlob(_0x5e8a0c);
        return _0x314e23(_0x541916, _0xe059d5);
      }
      if (_0x112c6f.offscreen && typeof _0x112c6f.canvas.transferToImageBitmap === "function") {
        const _0x4c3725 = _0x112c6f.canvas.transferToImageBitmap();
        const _0x37f0b7 = _0x118e02(_0x112c6f.width, _0x112c6f.height, false);
        try {
          _0x3c5a10(_0x37f0b7.ctx, _0x4c3725, _0x112c6f.width, _0x112c6f.height);
          return await _0x1ecdb3(_0x37f0b7, _0xe059d5);
        } finally {
          if (typeof _0x4c3725.close === "function") {
            _0x4c3725.close();
          }
        }
      }
      const _0x2714b3 = await _0x5e5de1(_0x112c6f.canvas, _0xe059d5.type, _0xe059d5.quality, "Canvas trả về " + (_0xe059d5?.["label"] || String(_0xe059d5?.["type"] || "ảnh").replace(/^image\//, '').toUpperCase()) + " rỗng.");
      return _0x314e23(_0x2714b3, _0xe059d5);
    }
    async function _0x743539(_0x34172b) {
      if (typeof _0x291164.createImageBitmap === "function") {
        const _0x308883 = await _0x291164.createImageBitmap(_0x34172b);
        return {
          'source': _0x308883,
          'width': _0x308883.width,
          'height': _0x308883.height,
          'cleanup'() {
            if (typeof _0x308883.close === "function") {
              _0x308883.close();
            }
          }
        };
      }
      const _0x4f9e1a = _0x291164.URL.createObjectURL(_0x34172b);
      const _0x301075 = new _0x291164.Image();
      _0x301075.decoding = "async";
      _0x301075.src = _0x4f9e1a;
      try {
        await _0x37d956(_0x301075);
        return {
          'source': _0x301075,
          'width': _0x301075.naturalWidth || _0x301075.width,
          'height': _0x301075.naturalHeight || _0x301075.height,
          'cleanup'() {
            _0x291164.URL.revokeObjectURL(_0x4f9e1a);
          }
        };
      } catch (_0xe1ba5b) {
        _0x291164.URL.revokeObjectURL(_0x4f9e1a);
        throw _0xe1ba5b;
      }
    }
    async function _0x4911f8(_0x2cafac, _0x101b50) {
      const _0x5b7b25 = _0x101b50 || _0x40a243;
      if (_0x5b7b25.type === _0x40a243.type) {
        return _0x2cafac;
      }
      const _0x361944 = await _0x743539(_0x2cafac);
      try {
        const _0x1d60ae = Math.floor(_0x361944.width);
        const _0x288360 = Math.floor(_0x361944.height);
        if (!_0x1d60ae || !_0x288360) {
          throw new Error("Ảnh không có kích thước hợp lệ để chuyển sang " + (_0x5b7b25?.["label"] || String(_0x5b7b25?.["type"] || "ảnh").replace(/^image\//, '').toUpperCase()) + '.');
        }
        const _0x227233 = _0x118e02(_0x1d60ae, _0x288360, true);
        _0x29130f(_0x227233, _0x5b7b25);
        _0x3c5a10(_0x227233.ctx, _0x361944.source, _0x1d60ae, _0x288360);
        return _0x1ecdb3(_0x227233, _0x5b7b25);
      } finally {
        _0x361944.cleanup();
      }
    }
    function _0x29130f(_0x11d87c, _0x3c68b9) {
      if (_0x3c68b9?.["type"] !== "image/jpeg") {
        return;
      }
      _0x11d87c.ctx.fillStyle = "#ffffff";
      _0x11d87c.ctx.fillRect(0, 0, _0x11d87c.width, _0x11d87c.height);
    }
    async function _0x510781(_0x5bc889, _0x2b399a) {
      const {
        width: _0xd32122,
        height: _0x535acb
      } = _0x2b399a.profile;
      const _0x368707 = await _0x2e93aa(_0x2b399a.url);
      const _0x243de3 = _0x118e02(_0xd32122, _0x535acb, true);
      try {
        if (_0x2b399a.profile.name === "full-size-openParam" && Number(_0x368707.image.naturalWidth || _0x368707.image.width) === Number(_0x5bc889.data?.["naturalWidth"]) && Number(_0x368707.image.naturalHeight || _0x368707.image.height) === Number(_0x5bc889.data?.["naturalHeight"])) {
          throw new Error("URL bỏ _s vẫn trả về ảnh nhỏ của viewer.");
        }
        _0x16e3ac(_0x5bc889.loader, _0x2b399a.profile, () => {
          _0x40bc9c(_0x243de3.ctx, _0x5bc889, _0x368707.image);
        });
        return {
          'blob': await _0x1ecdb3(_0x243de3, _0x40a243),
          'width': _0xd32122,
          'height': _0x535acb,
          'source': _0x2b399a.source,
          'profile': _0x2b399a.profile.name,
          'format': _0x2b399a.format,
          'rawUrl': _0x2b399a.url,
          'outputUrl': _0x2b399a.outputUrl
        };
      } finally {
        _0x368707.revoke();
      }
    }
    async function _0x5c43f1(_0x505d20) {
      const _0x531ee3 = _0x477fd4(_0x505d20);
      const _0x574aa9 = [];
      for (const _0x251337 of _0x531ee3) {
        try {
          return await _0x510781(_0x505d20, _0x251337);
        } catch (_0x4f7cb6) {
          _0x574aa9.push(_0x251337.source + ": " + (_0x4f7cb6?.["message"] || _0x4f7cb6));
        }
      }
      if (_0x574aa9.length > 0) {
        throw new Error("Không giải xáo trộn được ảnh raw. " + _0x574aa9.join(" | "));
      }
      const {
        width: _0x4efb8,
        height: _0x497e9b
      } = _0x540fc4(_0x505d20);
      const _0x286d33 = _0x505d20.data?.["currentSrc"] || _0x505d20.data?.["src"] || '';
      const _0x54248b = _0xf45af9(_0x35b542(_0x286d33) || _0x286d33);
      const _0x2d2304 = _0x118e02(_0x4efb8, _0x497e9b, true);
      if (!_0x505d20.data) {
        throw new Error("Page " + _0x20bc2c(_0x505d20) + " chưa có ảnh raw để giải xáo trộn.");
      }
      _0x16e3ac(_0x505d20.loader, _0x554d46(_0x505d20), () => {
        _0x40bc9c(_0x2d2304.ctx, _0x505d20, _0x505d20.data);
      });
      return {
        'blob': await _0x1ecdb3(_0x2d2304, _0x40a243),
        'width': _0x4efb8,
        'height': _0x497e9b,
        'source': "shuffle",
        'profile': "viewer-openParam",
        'format': _0x54248b,
        'rawUrl': _0x286d33
      };
    }
    function _0x4f351a(_0x2fd901, _0x3ad173) {
      const _0x4923b9 = _0x291164.URL.createObjectURL(_0x2fd901);
      const _0x5c5c2a = _0x36383f.createElement('a');
      _0x5c5c2a.href = _0x4923b9;
      _0x5c5c2a.download = _0x3ad173;
      _0x5c5c2a.rel = "noopener";
      _0x5c5c2a.style.display = "none";
      _0x36383f.documentElement.appendChild(_0x5c5c2a);
      _0x5c5c2a.click();
      _0x5c5c2a.remove();
      setTimeout(() => _0x291164.URL.revokeObjectURL(_0x4923b9), 60000);
    }
    function _0x44bc30(_0x408226, _0x246a44) {
      const _0x2b94c5 = Math.min(_0x408226.length, _0x246a44 + 4);
      for (let _0x37a6e0 = _0x246a44; _0x37a6e0 < _0x2b94c5; _0x37a6e0 += 1) {
        _0xeed374(_0x408226[_0x37a6e0])["catch"](_0x51cde3 => {
          console.warn("[ej-canvas-dl] preload page " + _0x20bc2c(_0x408226[_0x37a6e0], _0x37a6e0) + " failed", _0x51cde3);
        });
      }
    }

    // =========================================================================
    // 3. TIẾN TRÌNH TẢI ÂM THẦM & TẠO FILE ZIP
    // =========================================================================
    async function _0x31cbdc() {
      _0x369466.running = true;
      _0x592378(true);
      try {
        _0x224e25();
        _0xba03cc({ completed: 0, total: 0, stage: 0, status: "Đang tải..." });

        const { pages: _0x5ce1d2 } = await _0x46fbf4();
        const _0x11699e = _0x5ce1d2.slice(0, 1000);
        const _0x16d4bd = _0x11699e.length;
        if (!_0x16d4bd) {
          throw new Error("Viewer không có page hợp lệ để tải.");
        }

        const _0x445d41 = Boolean(_0x369466.convertJpeg);
        const zip = new PureZipWriter();

        // 1. Mã sách (VD: B00183678014) -> Tạo file TXT rỗng trong ZIP
        const bookCode = getBookCode(_0x11699e);
        zip.addFile(`${bookCode}.txt`, new Uint8Array(0));

        // Tên truyện -> File ZIP
        const mangaTitle = getCleanMangaTitle();

        _0x44bc30(_0x11699e, 0);

        for (let _0x2a8b16 = 0; _0x2a8b16 < _0x16d4bd; _0x2a8b16 += 1) {
          const _0x2303ff = _0x11699e[_0x2a8b16];
          const _0x4abdba = _0x20bc2c(_0x2303ff, _0x2a8b16);
          _0x44bc30(_0x11699e, _0x2a8b16 + 1);

          _0xba03cc({ completed: _0x2a8b16, total: _0x16d4bd, stage: 0.18, status: `Đang nạp trang ${_0x4abdba}/${_0x16d4bd}...` });
          await _0xeed374(_0x2303ff);

          _0xba03cc({ completed: _0x2a8b16, total: _0x16d4bd, stage: 0.55, status: `Đang giải xáo trộn trang ${_0x4abdba}/${_0x16d4bd}...` });
          const _0x168eb3 = await _0x5c43f1(_0x2303ff);

          _0xba03cc({ completed: _0x2a8b16, total: _0x16d4bd, stage: 0.82, status: `Đang xử lý trang ${_0x4abdba}/${_0x16d4bd}...` });
          let _0x44d988 = _0x168eb3.blob;
          let _0x14875f = 'png';

          if (_0x445d41) {
            _0x44d988 = await _0x4911f8(_0x44d988, _0x283fe1.jpg);
            if (!_0x44d988.size) {
              throw new Error("Blob JPG rỗng ở trang " + _0x4abdba + '.');
            }
            _0x14875f = 'jpg';
          } else {
            _0x44d988 = await _0x4911f8(_0x44d988, _0x168eb3.format);
            if (!_0x44d988.size) {
              throw new Error("Blob rỗng ở trang " + _0x4abdba + '.');
            }
            _0x14875f = _0x168eb3.format?.extension || 'png';
          }

          // Chuyển Blob sang Uint8Array
          const arrayBuffer = await _0x44d988.arrayBuffer();
          const uint8Data = new Uint8Array(arrayBuffer);

          // 2. Tên file ảnh ngắn gọn: 1.png, 2.png, 3.png...
          const fileName = `${_0x4abdba}.${_0x14875f}`;
          zip.addFile(fileName, uint8Data);

          _0xba03cc({ completed: _0x2a8b16 + 1, total: _0x16d4bd, stage: 0, status: `Đã nạp trang ${_0x4abdba}/${_0x16d4bd}` });
          await _0x37892f(40);
        }

        // Đóng gói ZIP siêu tốc (< 0.05s)
        _0xba03cc({ completed: _0x16d4bd, total: _0x16d4bd, stage: 0, status: "Đang xuất file ZIP..." });

        const zipBlob = zip.generateBlob();
        const zipFileName = `${mangaTitle}.zip`;
        _0x4f351a(zipBlob, zipFileName);

        _0xba03cc({ completed: _0x16d4bd, total: _0x16d4bd, stage: 0, status: "Hoàn tất" });
      } catch (_0x54b72c) {
        const _0x4541d2 = _0x54b72c?.["message"] || String(_0x54b72c);
        _0xba03cc({ status: "Lỗi: " + _0x4541d2 });
        console.error("[ej-canvas-dl] Download failed", _0x54b72c);
      } finally {
        _0x369466.running = false;
        _0x592378(false);
      }
    }

    // =========================================================================
    // 4. CẬP NHẬT GIAO DIỆN UI
    // =========================================================================
    function _0xba03cc(_0x467789 = {}) {
      const _0x4a17b8 = Number.isFinite(_0x467789.total) ? _0x467789.total : _0x369466.lastProgress.total;
      const _0x54fcde = Number.isFinite(_0x467789.completed) ? _0x467789.completed : Number.isFinite(_0x467789.current) ? _0x467789.current : _0x369466.lastProgress.completed;
      const _0x4b99de = Number.isFinite(_0x467789.stage) ? _0x467789.stage : _0x369466.lastProgress.stage;
      const _0x458405 = _0x4a17b8 > 0 ? Math.min(_0x4a17b8, _0x54fcde + _0x4b99de) : 0;
      const _0x2158e3 = _0x4a17b8 > 0 ? Math.max(0, Math.min(100, Math.round(_0x458405 / _0x4a17b8 * 100))) : 0;

      _0x369466.lastProgress = {
        completed: _0x54fcde,
        total: _0x4a17b8,
        stage: _0x4b99de,
        percent: _0x2158e3,
        status: _0x467789.status || _0x369466.lastProgress.status
      };

      const ui = _0x369466.ui;
      if (!ui) return;

      ui.count.textContent = _0x4a17b8 ? Math.min(_0x54fcde, _0x4a17b8) + '/' + _0x4a17b8 : "0/0";
      ui.percent.textContent = _0x2158e3 + '%';
      ui.fill.style.transform = "scaleX(" + _0x2158e3 / 100 + ')';
      ui.status.textContent = _0x369466.lastProgress.status;
    }

    function _0x592378(_0x120dd5) {
      const ui = _0x369466.ui;
      if (!ui) return;
      if (ui.button) {
        ui.button.disabled = _0x120dd5;
        ui.button.textContent = "Download";
        ui.button.style.opacity = _0x120dd5 ? "0.72" : '1';
        ui.button.style.cursor = _0x120dd5 ? "progress" : "pointer";
      }
      if (ui.jpgInput) {
        ui.jpgInput.disabled = _0x120dd5;
      }
    }

    function _0x2e488a() {
      if (_0x369466.ui || !_0x36383f.body) return;

      const PANEL_WIDTH = 220;
      const TAB_WIDTH = 14;
      let isCollapsed = _0x291164.localStorage.getItem("ej-dl:collapsed") === '1';

      const panel = _0x36383f.createElement("div");
      panel.id = "ej-canvas-dl";
      panel.style.cssText = [
        "all:initial",
        "position:fixed",
        "right:0px",
        "top:55px",
        "z-index:2147483647",
        "box-sizing:border-box",
        `width:${PANEL_WIDTH}px`,
        "padding:10px 14px",
        "border:1px solid #1d4ed8",
        "border-right:none",
        "border-radius:12px 0 0 12px",
        "background:#0d1222",
        "color:#ffffff",
        "font:12px/1.3 system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif",
        "user-select:none",
        "box-shadow:0 8px 24px rgba(0,0,0,0.85)",
        "transition:transform 0.22s cubic-bezier(0.16, 1, 0.3, 1)",
        `transform:${isCollapsed ? `translateX(calc(100% - ${TAB_WIDTH}px))` : "translateX(0)"}`,
        "overflow:hidden"
      ].join(';');

      const collapsedStrip = _0x36383f.createElement("div");
      collapsedStrip.style.cssText = [
        "all:initial",
        "position:absolute",
        "left:0px",
        "top:0px",
        `width:${TAB_WIDTH}px`,
        "height:100%",
        "background:#3b82f6",
        "cursor:pointer",
        "transition:opacity 0.15s, background 0.15s",
        `opacity:${isCollapsed ? "1" : "0"}`,
        `pointer-events:${isCollapsed ? "auto" : "none"}`
      ].join(';');
      collapsedStrip.title = "Bấm để mở bảng tải";
      collapsedStrip.onmouseenter = () => { collapsedStrip.style.background = "#60a5fa"; };
      collapsedStrip.onmouseleave = () => { collapsedStrip.style.background = "#3b82f6"; };

      const mainContent = _0x36383f.createElement("div");
      mainContent.style.cssText = [
        "all:initial",
        "display:block",
        "transition:opacity 0.2s",
        `opacity:${isCollapsed ? "0" : "1"}`,
        `pointer-events:${isCollapsed ? "none" : "auto"}`
      ].join(';');

      const collapseBtn = _0x36383f.createElement("button");
      collapseBtn.type = "button";
      collapseBtn.textContent = "▶";
      collapseBtn.title = "Thu gọn";
      collapseBtn.style.cssText = [
        "all:initial",
        "position:absolute",
        "left:0px",
        "top:0px",
        "width:24px",
        "height:24px",
        "display:flex",
        "align-items:center",
        "justify-content:center",
        "border-radius:12px 0 8px 0",
        "background:#3b82f6",
        "color:#ffffff",
        "font:900 10px system-ui,sans-serif",
        "cursor:pointer",
        "transition:background 0.15s ease",
        "z-index:2"
      ].join(';');
      collapseBtn.onmouseenter = () => { collapseBtn.style.background = "#60a5fa"; };
      collapseBtn.onmouseleave = () => { collapseBtn.style.background = "#3b82f6"; };

      const title = _0x36383f.createElement("div");
      title.textContent = "EbookJapan Downloader";
      title.style.cssText = "all:initial;display:block;color:#60a5fa;font:800 13px system-ui;margin-bottom:8px;text-align:center;padding-left:14px;";

      const btn = _0x36383f.createElement("button");
      btn.type = "button";
      btn.textContent = "Download";
      btn.style.cssText = [
        "all:initial",
        "display:block",
        "box-sizing:border-box",
        "width:100%",
        "padding:8px 0",
        "border:0",
        "border-radius:6px",
        "background:#3b82f6",
        "color:#ffffff",
        "font:700 14px/1.2 system-ui,sans-serif",
        "text-align:center",
        "cursor:pointer",
        "box-shadow:0 3px 10px rgba(59, 130, 246, 0.35)"
      ].join(';');

      btn.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();
        _0x31cbdc();
      });

      const label = _0x36383f.createElement("label");
      label.style.cssText = "all:initial;display:inline-flex;align-items:center;gap:6px;margin-top:8px;color:#bfdbfe;font:700 11px system-ui;cursor:pointer;";

      const jpgInput = _0x36383f.createElement("input");
      jpgInput.type = "checkbox";
      jpgInput.checked = _0x369466.convertJpeg;
      jpgInput.style.cssText = "all:initial;appearance:auto;width:14px;height:14px;accent-color:#3b82f6;cursor:pointer;";
      jpgInput.addEventListener("change", e => {
        e.stopPropagation();
        _0x369466.convertJpeg = jpgInput.checked;
        _0x375fac("ej-canvas-dl:convert-jpeg", _0x369466.convertJpeg);
      });

      const spanJpg = _0x36383f.createElement("span");
      spanJpg.textContent = "Xuất file JPG (mặc định PNG)";
      spanJpg.style.cssText = "all:initial;color:#bfdbfe;font:700 11px system-ui;";
      label.append(jpgInput, spanJpg);

      const progressRow = _0x36383f.createElement("div");
      progressRow.style.cssText = "all:initial;display:flex;justify-content:space-between;align-items:center;margin-top:10px;color:#ffffff;font:800 12px system-ui;";

      const countText = _0x36383f.createElement("span");
      countText.textContent = "0/0";
      countText.style.cssText = "all:initial;color:#ffffff;font:800 12px system-ui;";

      const percentText = _0x36383f.createElement("span");
      percentText.textContent = "0%";
      percentText.style.cssText = "all:initial;color:#ffffff;font:800 12px system-ui;";

      progressRow.append(countText, percentText);

      const track = _0x36383f.createElement("div");
      track.style.cssText = "all:initial;display:block;height:6px;overflow:hidden;border-radius:3px;background:#1e3a8a;margin-top:6px;";

      const fill = _0x36383f.createElement("div");
      fill.style.cssText = "all:initial;display:block;width:100%;height:100%;background:#60a5fa;transform:scaleX(0);transform-origin:left center;transition:transform .22s ease;";
      track.appendChild(fill);

      const statusText = _0x36383f.createElement("div");
      statusText.textContent = _0x369466.lastProgress.status;
      statusText.style.cssText = "all:initial;display:block;margin-top:8px;color:#bfdbfe;font:11px system-ui;word-break:break-word;";

      mainContent.append(collapseBtn, title, btn, label, progressRow, track, statusText);
      panel.append(collapsedStrip, mainContent);

      function setCollapsedState(collapsed) {
        isCollapsed = collapsed;
        _0x291164.localStorage.setItem("ej-dl:collapsed", isCollapsed ? '1' : '0');

        panel.style.transform = isCollapsed ? `translateX(calc(100% - ${TAB_WIDTH}px))` : "translateX(0)";
        collapsedStrip.style.opacity = isCollapsed ? "1" : "0";
        collapsedStrip.style.pointerEvents = isCollapsed ? "auto" : "none";
        mainContent.style.opacity = isCollapsed ? "0" : "1";
        mainContent.style.pointerEvents = isCollapsed ? "none" : "auto";
      }

      collapseBtn.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();
        setCollapsedState(true);
      });

      panel.addEventListener("click", () => {
        if (isCollapsed) setCollapsedState(false);
      });

      _0x36383f.body.appendChild(panel);

      _0x369466.ui = {
        panel,
        button: btn,
        jpgInput,
        count: countText,
        percent: percentText,
        fill,
        status: statusText
      };

      _0xba03cc(_0x369466.lastProgress);
    }

    function _0x336146(_0x30fb43) {
      if (_0x36383f.readyState === "loading") {
        _0x36383f.addEventListener("DOMContentLoaded", _0x30fb43, { once: true });
      } else {
        _0x30fb43();
      }
    }

    // Khởi động ngầm: Quét nạp xong tất cả số trang rồi mới bật UI
    async function boot() {
      while (!_0x36383f.body) {
        await _0x37892f(120);
      }
      _0x224e25();
      try {
        const { pages } = await _0x46fbf4();
        _0x2e488a();
        _0xba03cc({ completed: 0, total: pages.length, stage: 0, status: "Sẵn sàng." });
      } catch (err) {
        _0x2e488a();
        _0xba03cc({ completed: 0, total: 0, stage: 0, status: "Lỗi: " + (err?.message || err) });
      }
    }

    _0x336146(() => {
      boot();
    });

  })();
})();
