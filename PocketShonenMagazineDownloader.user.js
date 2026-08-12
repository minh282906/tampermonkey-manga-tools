// ==UserScript==
// @name         Pocket Shonen Magazine ripper
// @namespace    https://tampermonkey.net/
// @icon         https://pocket.shonenmagazine.com/img/favicon.ico
// @version      1.1.0
// @author       Fuku
// @description  Download Pocket Shonen Magazine episode
// @match        https://pocket.shonenmagazine.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      mgpk-cdn.magazinepocket.com
// @connect      api.pocket.shonenmagazine.com
// ==/UserScript==

(function pocketShonenDownloader() {
  "use strict";

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 4, // Số lượng ảnh tải song song
    GRID_SIZE: 4,
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  /* =========================================================================
   * 1. BỘ ĐÓNG GÓI ZIP NGUYÊN BẢN (PURE ZIP WRITER)
   * ========================================================================= */
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

        const header = new Uint8Array(30 + nameBytes.length);
        const view = new DataView(header.buffer);
        view.setUint32(0, 0x04034b50, true);
        view.setUint16(4, 20, true);
        view.setUint16(6, 0, true);
        view.setUint16(8, 0, true);
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

  /* =========================================================================
   * 2. STATE & HELPER FUNCTIONS
   * ========================================================================= */
  const state = {
    running: false,
    convertJpeg: localStorage.getItem("pocket-dl:convert-jpeg") === '1',
    ui: null,
    episodeData: null,
    lastProgress: {
      completed: 0,
      total: 0,
      percent: 0,
      status: "Đang chờ dữ liệu tập...",
    },
  };

  function isEpisodeUrl() {
    return /\/episode\/\d+/.test(WIN.location.pathname);
  }

  function saveJpegPref(val) {
    try {
      WIN.localStorage.setItem("pocket-dl:convert-jpeg", val ? '1' : '0');
    } catch {}
  }

  function getEpisodeId() {
    if (state.episodeData?.episodeId) return String(state.episodeData.episodeId);
    const match = WIN.location.pathname.match(/\/episode\/(\d+)/);
    return match ? match[1] : "pocket_episode";
  }

  function getCleanTitle() {
    try {
      let seriesTitle = "";
      let episodeTitle = "";

      const sEl = DOC.querySelector('.p-episode__header-series-ttl, .p-series__ttl, [class*="series-ttl"], .p-episode__series-title');
      if (sEl) seriesTitle = sEl.textContent.trim();

      const eEl = DOC.querySelector('h2.p-episode__header-ttl, .p-episode__header-ttl, [class*="episode-ttl"], .p-episode__title');
      if (eEl) episodeTitle = eEl.textContent.trim();

      if ((!seriesTitle || !episodeTitle) && DOC.title) {
        const titleParts = DOC.title.split('|');
        if (titleParts.length >= 2) {
          if (!seriesTitle) seriesTitle = titleParts[0].trim();
          if (!episodeTitle) {
            episodeTitle = titleParts[1].split('/')[0].trim();
          }
        }
      }

      seriesTitle = seriesTitle.replace(/[\\/*?:"<>|]/g, '').trim();
      episodeTitle = episodeTitle.replace(/[\\/*?:"<>|]/g, '').trim();

      if (seriesTitle && episodeTitle && !seriesTitle.includes(episodeTitle)) {
        return `${seriesTitle} - ${episodeTitle}`;
      } else if (seriesTitle) {
        return seriesTitle;
      } else if (episodeTitle) {
        return episodeTitle;
      }
    } catch (e) {}

    return `Pocket_${getEpisodeId()}`;
  }

  function getExtensionFromUrl(url, defaultExt = 'jpg') {
    try {
      const pathname = new URL(url, WIN.location.href).pathname;
      const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
      if (match && match[1]) {
        const ext = match[1].toLowerCase();
        if (['jpg', 'jpeg', 'png', 'webp', 'avif'].includes(ext)) {
          return ext === 'jpeg' ? 'jpg' : ext;
        }
      }
    } catch (e) {}
    return defaultExt;
  }

  // Quét BẮT TẤT CẢ Ảnh Thương Mại / Quảng Cáo từ DOM + BỘ LỌC KÍCH THƯỚC FULL-PAGE
  async function getDomPrImages(timeoutMs = 400) {
    const selectors = [
      '.c-viewer__comic img',
      '.c-viewer__pages-item img',
      'img[src*="/static/ads/"]',
      'img[src*="/ads/"]',
      '.p-episode__end-banner img',
      '.p-viewer__end img'
    ];

    const startTime = Date.now();
    const prList = [];

    while (Date.now() - startTime < timeoutMs) {
      const imgs = DOC.querySelectorAll(selectors.join(', '));
      for (const img of imgs) {
        let src = img.getAttribute('data-src') || img.getAttribute('src') || '';
        if (!src || src.startsWith('data:')) continue;

        // BỘ LỌC KÍCH THƯỚC: Bỏ qua icon nhỏ / logo / banner ngang quá dẹp (h < 300px hoặc w/h > 1.8)
        const w = img.naturalWidth || parseInt(img.getAttribute('width') || '0', 10);
        const h = img.naturalHeight || parseInt(img.getAttribute('height') || '0', 10);

        if ((w > 0 && h > 0) && (h < 300 || (w / h) > 1.8)) {
          continue;
        }

        if (src.startsWith('//')) src = 'https:' + src;
        if (!prList.includes(src)) {
          prList.push(src);
        }
      }
      if (prList.length > 0) break;
      await sleep(100);
    }
    return prList;
  }

  /* =========================================================================
   * 3. FETCH HOOK + MESSAGE BRIDGE
   * ========================================================================= */
  function injectFetchHook() {
    const script = DOC.createElement("script");
    script.textContent = `
      (() => {
        const originalFetch = window.fetch;
        window.fetch = async (...args) => {
          const response = await originalFetch(...args);
          try {
            const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
            if (url?.includes('/web/episode/viewer')) {
              const data = await response.clone().json();
              if (Array.isArray(data.page_list)) {
                window.postMessage(
                  {
                    type: 'POCKET_PAGE_LIST',
                    pages: data.page_list,
                    seed: data.scramble_seed,
                    ver: data.scramble_ver,
                    mangaId: data.title_id,
                    episodeId: data.episode_id
                  },
                  '*'
                );
              }
            }
          } catch {}
          return response;
        };
      })();
    `;
    DOC.documentElement.appendChild(script);
  }

  function onPageListMessage(e) {
    if (e.data?.type !== "POCKET_PAGE_LIST") return;

    state.episodeData = {
      pages: e.data.pages,
      seed: e.data.seed,
      ver: e.data.ver,
      mangaId: e.data.mangaId,
      episodeId: e.data.episodeId,
    };

    createUI();
    if (state.ui?.panel) {
      state.ui.panel.style.display = isEpisodeUrl() ? "block" : "none";
    }

    updateProgressUI({
      completed: 0,
      total: state.episodeData.pages.length,
      status: "Sẵn sàng.",
    });
  }

  /* =========================================================================
   * 4. DESCRAMBLE ALGORITHM (HỖ TRỢ MẶC ĐỊNH PNG / TÙY CHỌN JPG)
   * ========================================================================= */
  const CHARSET_EVEN = "svdk0m7acl";
  const CHARSET_ODD = "q6jtf2xnog";
  const MULTIPLE_NUM = 8;

  async function descrambleImage(blob, seed, ver, mangaId, episodeId, grid = 4, isJpg = false) {
    const img = await loadImage(blob);
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;

    const canvas = DOC.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d", { alpha: !isJpg });
    ctx.imageSmoothingEnabled = false;

    // Nếu chọn JPG thì tô nền trắng
    if (isJpg) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
    }

    let finalSeed = seed;
    if (typeof seed === "string") {
      const charset = mangaId % 2 === 0 ? CHARSET_EVEN : CHARSET_ODD;
      finalSeed = ComputeSeed32(seed, charset, mangaId, episodeId);
    }

    const effectiveVer = -1;
    const i = effectiveVer === 1
      ? ComputeLCMBlockDimensions(width, height, grid)
      : ComputeGridBlockDimensions(width, height, grid);

    if (!i) {
      return {
        blob: blob,
        ext: isJpg ? 'jpg' : 'png'
      };
    }

    ctx.drawImage(img, 0, 0);
    const mapping = GenerateScrambleMapping(grid, finalSeed);

    for (const c of mapping) {
      ctx.drawImage(
        img,
        c.source.x * i.width,
        c.source.y * i.height,
        i.width,
        i.height,
        c.dest.x * i.width,
        c.dest.y * i.height,
        i.width,
        i.height
      );
    }

    const mimeType = isJpg ? 'image/jpeg' : 'image/png';
    const quality = isJpg ? 0.95 : undefined;

    const outputBlob = await new Promise((res) => canvas.toBlob(res, mimeType, quality));

    canvas.width = 0;
    canvas.height = 0;

    return {
      blob: outputBlob,
      ext: isJpg ? 'jpg' : 'png'
    };
  }

  function* xorshift(seed) {
    const x = Uint32Array.of(seed);
    while (true) {
      x[0] ^= x[0] << 13;
      x[0] ^= x[0] >>> 17;
      x[0] ^= x[0] << 5;
      yield x[0];
    }
  }

  function ShuffleArrayWithPRNG(array, seed) {
    const t = xorshift(seed);
    return array
      .map((r) => [t.next().value, r])
      .sort((r, i) => +(r[0] > i[0]) - +(i[0] > r[0]))
      .map((r) => r[1]);
  }

  function GenerateScrambleMapping(gridSize, seed) {
    const indices = [...Array(gridSize ** 2)].map((_, r) => r);
    const shuffled = ShuffleArrayWithPRNG(indices, seed);

    return shuffled.map((s, r) => ({
      source: { x: s % gridSize, y: Math.floor(s / gridSize) },
      dest: { x: r % gridSize, y: Math.floor(r / gridSize) },
    }));
  }

  function GetLeastCommonMultiple(a, b) {
    const t = (s, r) => (s ? t(r % s, s) : r);
    return (a * b) / t(a, b);
  }

  function ComputeLCMBlockDimensions(width, height, gridSize) {
    if (width < gridSize || height < gridSize) return null;
    const s = GetLeastCommonMultiple(gridSize, MULTIPLE_NUM);
    if (width > s && height > s) {
      width = Math.floor(width / s) * s;
      height = Math.floor(height / s) * s;
    }
    return {
      width: Math.floor(width / gridSize),
      height: Math.floor(height / gridSize),
    };
  }

  function ComputeGridBlockDimensions(width, height, gridSize) {
    if (width < gridSize * MULTIPLE_NUM || height < gridSize * MULTIPLE_NUM) return null;
    const s = Math.floor(width / MULTIPLE_NUM);
    const r = Math.floor(height / MULTIPLE_NUM);
    const i = Math.floor(s / gridSize);
    const c = Math.floor(r / gridSize);
    return {
      width: i * MULTIPLE_NUM,
      height: c * MULTIPLE_NUM,
    };
  }

  function ComputeSeed32(seed, charset, titleId, episodeId) {
    let parsedInt = 0n;
    for (const char of seed) {
      const index = charset.indexOf(char);
      if (index !== -1) {
        parsedInt = parsedInt * 10n + BigInt(index);
      } else {
        break;
      }
    }
    const parsedUInt32 = Number(parsedInt & 0xffffffffn);
    const combined = (titleId >>> 0) + (episodeId >>> 0);
    return (parsedUInt32 ^ combined) >>> 0;
  }

  function loadImage(blob) {
    return new Promise((res, rej) => {
      const objUrl = WIN.URL.createObjectURL(blob);
      const img = new WIN.Image();
      img.onload = () => {
        WIN.URL.revokeObjectURL(objUrl);
        res(img);
      };
      img.onerror = rej;
      img.src = objUrl;
    });
  }

  /* =========================================================================
   * 5. TIẾN TRÌNH TẢI SONG SONG
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    if (!state.episodeData?.pages?.length) {
      updateProgressUI({ status: "Chưa có dữ liệu trang." });
      return;
    }

    state.running = true;
    setUiBusy(true);

    const { pages, seed, ver, mangaId, episodeId } = state.episodeData;
    const useJpeg = Boolean(state.convertJpeg);

    try {
      const zip = new PureZipWriter();
      const currentEpId = getEpisodeId();

      zip.addFile(`${currentEpId}.txt`, new Uint8Array(0));

      const allTaskObjects = [];
      let prCount = 0;
      let mainPageNo = 1;

      // 1. Quét ảnh PR từ DOM
      const domPrs = await getDomPrImages(400);
      for (const prUrl of domPrs) {
        const inMain = pages.some(pUrl => pUrl.includes(prUrl.split('?')[0]));
        if (!inMain) {
          prCount++;
          allTaskObjects.push({
            isPR: true,
            prNo: prCount,
            url: prUrl
          });
        }
      }

      // 2. Quét trang chính từ API
      for (const url of pages) {
        const isAdUrl = url.includes('/static/ads/') || url.includes('/ads/');
        if (isAdUrl) {
          prCount++;
          allTaskObjects.push({
            isPR: true,
            prNo: prCount,
            url: url
          });
        } else {
          allTaskObjects.push({
            isPR: false,
            pageNo: mainPageNo++,
            url: url
          });
        }
      }

      allTaskObjects.forEach(p => {
        if (p.isPR) p.singlePR = (prCount === 1);
      });

      const totalItems = allTaskObjects.length;
      updateProgressUI({ completed: 0, total: totalItems, status: "Đang tải..." });

      const tasks = allTaskObjects.map((item) => async () => {
        const rawBlob = await fetchBlob(item.url);

        // Ảnh PR Thương mại: GIỮ NGUYÊN ĐỊNH DẠNG/ĐUÔI FILE GỐC (png/jpg/webp...)
        if (item.isPR) {
          let ext = getExtensionFromUrl(item.url);
          if (!ext && rawBlob.type) {
            ext = rawBlob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
          }
          const arrayBuffer = await rawBlob.arrayBuffer();
          const fileName = item.singlePR ? `PR.${ext}` : `PR_${item.prNo}.${ext}`;
          return {
            fileName: fileName,
            data: new Uint8Array(arrayBuffer)
          };
        }

        // Trang truyện chính: GIẢI MÃ MA TRẬN -> Xuất mặc định PNG (hoặc JPG nếu tích chọn)
        let decoded;
        if (seed) {
          decoded = await descrambleImage(rawBlob, seed, ver, mangaId, episodeId, CONFIG.GRID_SIZE, useJpeg);
        } else {
          decoded = {
            blob: rawBlob,
            ext: useJpeg ? 'jpg' : 'png'
          };
        }

        const arrayBuffer = await decoded.blob.arrayBuffer();
        return {
          fileName: `${item.pageNo}.${decoded.ext}`,
          data: new Uint8Array(arrayBuffer)
        };
      });

      const results = await runWithConcurrency(
        tasks,
        CONFIG.MAX_CONCURRENT,
        (done, total) => {
          updateProgressUI({ completed: done, total, status: "Đang tải..." });
        }
      );

      updateProgressUI({
        completed: totalItems,
        total: totalItems,
        status: "Đang đóng gói ZIP...",
      });
      await sleep(50);

      let savedCount = 0;
      for (const r of results) {
        if (r && r.data && r.data.length > 0) {
          zip.addFile(r.fileName, r.data);
          savedCount++;
        }
      }

      if (savedCount === 0) {
        throw new Error("Không lấy được dữ liệu ảnh.");
      }

      const zipBlob = zip.generateBlob();
      const zipFileName = `${getCleanTitle()}.zip`;
      triggerDownload(zipBlob, zipFileName);

      updateProgressUI({
        completed: totalItems,
        total: totalItems,
        status: "Hoàn tất!",
      });
    } catch (e) {
      console.error("[pocket-dl] Download failed", e);
      updateProgressUI({ status: `Lỗi: ${e?.message || e}` });
    } finally {
      state.running = false;
      setUiBusy(false);
      updateProgressUI(state.lastProgress);
    }
  }

  async function runWithConcurrency(tasks, limit, onProgress) {
    const results = new Array(tasks.length);
    let index = 0;
    let completed = 0;

    async function worker() {
      while (index < tasks.length) {
        const current = index++;
        try {
          results[current] = await tasks[current]();
        } catch (e) {
          results[current] = null;
        }
        completed++;
        onProgress?.(completed, tasks.length);
      }
    }

    const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
    await Promise.all(workers);
    return results;
  }

  /* =========================================================================
   * 6. GIAO DIỆN UI (THÊM TICKBOX CHỌN JPG/PNG)
   * ========================================================================= */
  function updateProgressUI(data = {}) {
    const total = Number.isFinite(data.total) ? data.total : state.lastProgress.total;
    const completed = Number.isFinite(data.completed) ? data.completed : state.lastProgress.completed;
    const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((completed / total) * 100))) : 0;

    state.lastProgress = {
      completed,
      total,
      percent: pct,
      status: data.status || state.lastProgress.status,
    };

    const ui = state.ui;
    if (!ui) return;

    ui.count.textContent = `${completed}/${total}`;
    ui.percent.textContent = `${pct}%`;
    ui.fill.style.transform = `scaleX(${pct / 100})`;
    ui.status.textContent = state.lastProgress.status;
  }

  function setUiBusy(isBusy) {
    const ui = state.ui;
    if (!ui) return;

    ui.button.disabled = Boolean(isBusy);
    ui.button.textContent = isBusy ? "Đang xử lý..." : "Download";
    ui.button.style.opacity = isBusy ? "0.72" : "1";
    ui.button.style.cursor = isBusy ? "progress" : "pointer";
    ui.jpgInput.disabled = Boolean(isBusy);
    ui.jpgInput.style.cursor = isBusy ? "default" : "pointer";
  }

  function createUI() {
    if (state.ui || !DOC.body) return;

    const panel = DOC.createElement("div");
    panel.id = "pocket-dl-panel";
    panel.style.cssText = [
      "all:initial",
      "position:fixed",
      "right:0px",
      "top:62px",
      "z-index:2147483647",
      "box-sizing:border-box",
      "width:220px",
      "padding:10px 14px",
      "border:1px solid #4338ca",
      "border-radius:10px",
      "background:#0f172a",
      "color:#ffffff",
      'font:12px/1.3 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      "user-select:none",
      "box-shadow:0 8px 24px rgba(0,0,0,0.85)",
      "display:none",
    ].join(";");

    const title = DOC.createElement("div");
    title.textContent = "Pocket Downloader";
    title.style.cssText = "all:initial;display:block;color:#818cf8;font:800 13px system-ui;margin-bottom:8px;text-align:center;";

    const btn = DOC.createElement("button");
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
      "background:#6366f1",
      "color:#ffffff",
      "font:700 14px/1.2 system-ui,sans-serif",
      "text-align:center",
      "cursor:pointer",
      "box-shadow:0 3px 10px rgba(99, 102, 241, 0.35)",
    ].join(";");
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      startDownload();
    });

    const label = DOC.createElement("label");
    label.style.cssText = "all:initial;display:inline-flex;align-items:center;gap:6px;margin-top:8px;color:#d1d8eb;font:700 11px system-ui;cursor:pointer;";

    const jpgInput = DOC.createElement("input");
    jpgInput.type = "checkbox";
    jpgInput.checked = state.convertJpeg;
    jpgInput.style.cssText = "all:initial;appearance:auto;width:14px;height:14px;accent-color:#6366f1;cursor:pointer;";
    jpgInput.addEventListener("change", e => {
      e.stopPropagation();
      state.convertJpeg = jpgInput.checked;
      saveJpegPref(state.convertJpeg);
    });

    const spanJpg = DOC.createElement("span");
    spanJpg.textContent = "Xuất file JPG (mặc định PNG)";
    spanJpg.style.cssText = "all:initial;color:#d1d8eb;font:700 11px system-ui;";
    label.append(jpgInput, spanJpg);

    const progressRow = DOC.createElement("div");
    progressRow.style.cssText = "all:initial;display:flex;justify-content:space-between;align-items:center;margin-top:10px;color:#ffffff;font:800 12px system-ui;";

    const countText = DOC.createElement("span");
    countText.textContent = "0/0";
    countText.style.cssText = "all:initial;color:#ffffff;font:800 12px system-ui;";

    const percentText = DOC.createElement("span");
    percentText.textContent = "0%";
    percentText.style.cssText = "all:initial;color:#ffffff;font:800 12px system-ui;";

    progressRow.append(countText, percentText);

    const track = DOC.createElement("div");
    track.style.cssText = "all:initial;display:block;height:6px;overflow:hidden;border-radius:3px;background:#1e1b4b;margin-top:6px;";

    const fill = DOC.createElement("div");
    fill.style.cssText = "all:initial;display:block;width:100%;height:100%;background:#818cf8;transform:scaleX(0);transform-origin:left center;transition:transform .22s ease;";
    track.appendChild(fill);

    const statusText = DOC.createElement("div");
    statusText.textContent = state.lastProgress.status;
    statusText.style.cssText = "all:initial;display:block;margin-top:8px;color:#c7d2fe;font:11px system-ui;word-break:break-word;";

    panel.append(title, btn, label, progressRow, track, statusText);

    state.ui = {
      panel,
      button: btn,
      jpgInput,
      count: countText,
      percent: percentText,
      fill,
      status: statusText,
    };

    DOC.body.appendChild(panel);
    updateProgressUI(state.lastProgress);
  }

  /* =========================================================================
   * 7. BỘ LẮNG NGHE CHUYỂN CHAP TỰ ĐỘNG (SPA ROUTE WATCHER)
   * ========================================================================= */
  function initRouteWatcher() {
    let lastUrl = WIN.location.href;

    const onUrlChange = () => {
      const currentUrl = WIN.location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;

        state.episodeData = null;
        state.running = false;
        setUiBusy(false);

        boot();
      }
    };

    const origPush = WIN.history.pushState;
    WIN.history.pushState = function(...args) {
      origPush.apply(this, args);
      onUrlChange();
    };

    const origReplace = WIN.history.replaceState;
    WIN.history.replaceState = function(...args) {
      origReplace.apply(this, args);
      onUrlChange();
    };

    WIN.addEventListener("popstate", onUrlChange);
    WIN.addEventListener("hashchange", onUrlChange);
    WIN.setInterval(onUrlChange, 600);
  }

  async function boot() {
    while (!DOC.body) {
      await sleep(100);
    }
    createUI();

    if (!isEpisodeUrl()) {
      if (state.ui && state.ui.panel) {
        state.ui.panel.style.display = "none";
      }
      return;
    }

    if (state.ui && state.ui.panel) {
      state.ui.panel.style.display = "block";
    }

    updateProgressUI({ completed: 0, total: 0, status: "Đang kiểm tra trang..." });

    if (state.episodeData?.pages?.length) {
      updateProgressUI({
        completed: 0,
        total: state.episodeData.pages.length,
        status: "Sẵn sàng."
      });
    } else {
      updateProgressUI({
        completed: 0,
        total: 0,
        status: "Chờ dữ liệu tập..."
      });
    }
  }

  /* =========================================================================
   * 8. HELPERS & BOOT
   * ========================================================================= */
  function fetchBlob(url) {
    return new Promise((res, rej) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "blob",
        timeout: 25000,
        onload: (r) => (r.status === 200 ? res(r.response) : rej(new Error(`Status: ${r.status}`))),
        onerror: (e) => rej(e),
        ontimeout: () => rej(new Error("Timeout tải ảnh")),
      });
    });
  }

  function triggerDownload(blob, name) {
    const a = DOC.createElement("a");
    a.href = WIN.URL.createObjectURL(blob);
    a.download = name;
    a.rel = "noopener";
    a.style.display = "none";
    DOC.documentElement.appendChild(a);
    a.click();
    a.remove();
    WIN.setTimeout(() => WIN.URL.revokeObjectURL(a.href), 60000);
  }

  function main() {
    injectFetchHook();
    WIN.addEventListener("message", onPageListMessage);
    initRouteWatcher();

    if (DOC.readyState === "loading") {
      DOC.addEventListener("DOMContentLoaded", () => boot());
    } else {
      boot();
    }
  }

  main();
})();
