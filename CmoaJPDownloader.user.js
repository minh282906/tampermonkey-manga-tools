// ==UserScript==
// @name         Cmoajp Downloader (Auto Dynamic Inset & Pure ZIP)
// @namespace    https://www.cmoa.jp/
// @version      1.0
// @description  Giải mã ghép ảnh chuẩn tỷ lệ Inset % từng trang truyện của cmoa.jp, có đóng gói ZIP, lưu tên trang theo số thứ tự tăng dần và một file txt lưu tên mã truyện tương ứng.
// @author       anonymous & AI
// @match        https://www.cmoa.jp/bib/speedreader/*
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

(function cmoaSpeedReaderDownloader() {
  'use strict';

  const _0x4a2400 = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const _0x255af7 = _0x4a2400.document;

  // Kiểm tra cửa sổ chính hay Iframe ẩn
  const isTopWindow = (() => {
    try {
      return _0x4a2400.top === _0x4a2400.self;
    } catch {
      return true;
    }
  })();

  // 1. NẾU LÀ IFRAME ẨN: VÔ HIỆU HÓA LƯU LỊCH SỬ ĐỌC TRANG
  if (!isTopWindow) {
    if (_0x4a2400.location.hash.includes("tm-silent-reader-")) {
      try {
        _0x4a2400.Storage.prototype.setItem = function() {};
        _0x4a2400.Storage.prototype.removeItem = function() {};
        _0x4a2400.Storage.prototype.clear = function() {};
      } catch(e) {}
    }
    return;
  }

  const sleep = ms => new Promise(resolve => _0x4a2400.setTimeout(resolve, ms));

  // =========================================================================
  // BỘ ĐÓNG GÓI ZIP NGUYÊN BẢN (PURE ZIP WRITER - SIÊU TỐC)
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

  // =========================================================================
  // XỬ LÝ DỮ LIỆU VÀ TÊN FILE
  // =========================================================================
  const state = {
    running: false,
    convertJpeg: localStorage.getItem("cmoa-speedreader-dl:convert-jpeg") === '1',
    ui: null,
    lastProgress: { completed: 0, total: 0, stage: 0, percent: 0, status: "Đang chờ viewer..." }
  };

  function saveJpegPref(val) {
    try {
      _0x4a2400.localStoragesetItem("cmoa-speedreader-dl:convert-jpeg", val ? '1' : '0');
    } catch {}
  }

  function getCleanMangaTitle() {
    try {
      let rawTitle = _0x255af7.title || "";
      let clean = rawTitle.split('｜')[0].split('|')[0].trim();
      clean = clean.replace(/[\\/*?:"<>|]/g, '').trim();
      return clean || getCidPrefix() || "CMOA_Manga";
    } catch (e) {
      return getCidPrefix() || "CMOA_Manga";
    }
  }

  function getCidPrefix() {
    const search = new URLSearchParams(_0x4a2400.location.search);
    const cid = search.get("cid") || '';
    const match = cid.match(/\d+/g);
    if (match && match.length >= 2) return `${match[0]}-${match[1]}`;
    if (match && match.length === 1) return match[0];

    const hrefMatch = _0x4a2400.location.href.match(/\d+/g);
    if (hrefMatch && hrefMatch.length >= 2) return `${hrefMatch[0]}-${hrefMatch[1]}`;

    return "0000364491-0001";
  }

  function formatFileName(pageObj, ext) {
    return `${pageObj.pageNo}.${ext}`;
  }

  function getReader() {
    try {
      return _0x4a2400.SpeedBinb?.getInstance?.("content") || null;
    } catch {
      return null;
    }
  }

  function getCurrentPageIndex(reader) {
    if (!reader) return -1;
    try {
      if (typeof reader.getViewIndex === 'function') return reader.getViewIndex();
      if (typeof reader.p === 'number' && reader.p >= 0) return reader.p;
      if (typeof reader.currentP === 'number' && reader.currentP >= 0) return reader.currentP;
    } catch (e) {}
    return -1;
  }

  async function waitForReader(timeoutMs = 45000) {
    const endTime = (_0x4a2400.performance?.now?.() || Date.now()) + timeoutMs;
    while ((_0x4a2400.performance?.now?.() || Date.now()) < endTime) {
      const reader = getReader();
      if (Boolean(reader && reader.isContentLoaded && reader.content && Array.isArray(reader.content.page) && reader.content.page.length > 0)) {
        return reader;
      }
      await sleep(120);
    }
    throw new Error("Không tìm thấy viewer SpeedBinb đã tải xong.");
  }

  function getSilentFrameUrl() {
    const url = new URL(_0x4a2400.location.href);
    url.hash = "tm-silent-reader-" + Date.now();
    return url.href;
  }

  async function createSilentFrame(timeoutMs = 45000) {
    if (!_0x255af7.body) {
      throw new Error("Trang chưa sẵn sàng để tạo viewer ẩn.");
    }
    _0x255af7.getElementById("cmoa-speedreader-dl-silent-frame")?.remove();

    const frame = _0x255af7.createElement("iframe");
    frame.id = "cmoa-speedreader-dl-silent-frame";
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.src = getSilentFrameUrl();
    frame.style.cssText = [
      "position:fixed",
      "left:-20000px",
      "top:0",
      "width:1280px",
      "height:1800px",
      "border:0",
      "opacity:0",
      "pointer-events:none",
      "z-index:-1"
    ].join(';');

    _0x255af7.body.appendChild(frame);

    const cleanup = () => {
      try { frame.remove(); } catch {}
    };

    const endTime = (_0x4a2400.performance?.now?.() || Date.now()) + timeoutMs;

    try {
      while ((_0x4a2400.performance?.now?.() || Date.now()) < endTime) {
        let win = null;
        let doc = null;
        try {
          win = frame.contentWindow;
          doc = frame.contentDocument || win?.document || null;
        } catch {
          win = null;
          doc = null;
        }
        const reader = win?.SpeedBinb?.getInstance?.("content") || null;
        if (win && doc && Boolean(reader && reader.isContentLoaded && reader.content && Array.isArray(reader.content.page) && reader.content.page.length > 0)) {
          return { frame, W: win, D: doc, reader, cleanup };
        }
        await sleep(150);
      }
    } catch (err) {
      cleanup();
      throw err;
    }

    cleanup();
    throw new Error("Không tạo được viewer ẩn để tải âm thầm.");
  }

  function getPageList(reader) {
    const pages = Array.isArray(reader?.content?.page) ? reader.content.page : [];
    return pages.map((page, index) => ({
      page,
      index,
      domId: page?.id || ("content-p" + (index + 1)),
      pageNo: index + 1
    })).filter(item => item.page && item.pageNo > 0).slice(0, 1000);
  }

  function jumpToPage(reader, index) {
    if (!reader || typeof reader.moveTo !== "function") {
      throw new Error("Viewer không hỗ trợ chuyển trang tự động.");
    }
    reader.moveTo(index, false);
  }

  // =========================================================================
  // BÓC TÁCH INSET & TÍNH KÍCH THƯỚC TRỰC TIẾP (DYNAMIC RESOLUTION)
  // =========================================================================
  function parseSliceRect(styleStr) {
    if (!styleStr) return { top: 0, right: 0, bottom: 0, left: 0 };

    // 1. Thử đọc dạng inset: top% right% bottom% left%
    const insetMatch = styleStr.match(/inset:\s*([\d\.-]+)(%|px)?\s+([\d\.-]+)(%|px)?\s+([\d\.-]+)(%|px)?\s+([\d\.-]+)(%|px)?/i);
    if (insetMatch) {
      return {
        top: parseFloat(insetMatch[1]),
        right: parseFloat(insetMatch[3]),
        bottom: parseFloat(insetMatch[5]),
        left: parseFloat(insetMatch[7])
      };
    }

    // 2. Thử đọc dạng top%, left%, right%, bottom%, width%, height% lẻ
    let top = 0, right = 0, bottom = 0, left = 0;
    const topMatch = styleStr.match(/top:\s*([\d\.-]+)%/i);
    const rightMatch = styleStr.match(/right:\s*([\d\.-]+)%/i);
    const bottomMatch = styleStr.match(/bottom:\s*([\d\.-]+)%/i);
    const leftMatch = styleStr.match(/left:\s*([\d\.-]+)%/i);
    const widthMatch = styleStr.match(/width:\s*([\d\.-]+)%/i);
    const heightMatch = styleStr.match(/height:\s*([\d\.-]+)%/i);

    if (topMatch) top = parseFloat(topMatch[1]);
    if (leftMatch) left = parseFloat(leftMatch[1]);

    if (rightMatch) {
      right = parseFloat(rightMatch[1]);
    } else if (widthMatch) {
      right = 100 - left - parseFloat(widthMatch[1]);
    }

    if (bottomMatch) {
      bottom = parseFloat(bottomMatch[1]);
    } else if (heightMatch) {
      heightMatch[1] && (bottom = 100 - top - parseFloat(heightMatch[1]));
    }

    return { top, right, bottom, left };
  }

  async function stitchPageToUint8Array(pageDiv, isJpg) {
    const ptImg = pageDiv.querySelector('.pt-img') || pageDiv;
    const sliceDivs = Array.from(ptImg.children).filter(d => d.querySelector('img'));
    if (sliceDivs.length === 0) return null;

    const sliceData = [];
    let maxFullH = 0; // Tự động đo kích thước chiều cao thực
    let maxFullW = 0; // Tự động đo kích thước chiều rộng thực

    for (const div of sliceDivs) {
      const img = div.querySelector('img');
      if (!img || !img.complete || img.naturalWidth === 0 || !img.src.startsWith('blob:')) {
        return null;
      }

      const styleStr = div.getAttribute('style') || '';
      const inset = parseSliceRect(styleStr);

      // Tính kích thước tổng dựa trên % chiều cao mảnh cắt
      const spanH = (100 - inset.bottom - inset.top) / 100;
      if (spanH > 0) {
        const estH = img.naturalHeight / spanH;
        if (estH > maxFullH) maxFullH = estH;
      }

      // Tính kích thước tổng dựa trên % chiều rộng mảnh cắt
      const spanW = (100 - inset.left - inset.right) / 100;
      if (spanW > 0) {
        const estW = img.naturalWidth / spanW;
        if (estW > maxFullW) maxFullW = estW;
      }

      sliceData.push({ img, inset });
    }

    if (sliceData.length === 0 || maxFullW === 0 || maxFullH === 0) return null;

    // Kích thước khung vẽ CHUẨN TỰ ĐỘNG CỦA BỘ TRUYỆN NÀY
    const targetW = Math.round(maxFullW);
    const targetH = Math.round(maxFullH);

    const canvas = _0x255af7.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');

    if (isJpg) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, targetW, targetH);
    }

    // Ghép chính xác từng mảnh cắt vào ma trận 2D theo tỷ lệ inset %
    for (const item of sliceData) {
      const dx = Math.round((item.inset.left / 100) * targetW);
      const dy = Math.round((item.inset.top / 100) * targetH);
      const dw = Math.round(((100 - item.inset.left - item.inset.right) / 100) * targetW);
      const dh = Math.round(((100 - item.inset.top - item.inset.bottom) / 100) * targetH);

      ctx.drawImage(
        item.img,
        0, 0, item.img.naturalWidth, item.img.naturalHeight,
        dx, dy, dw, dh
      );
    }

    const mimeType = isJpg ? 'image/jpeg' : 'image/png';
    const quality = isJpg ? 0.95 : undefined;

    const blob = await new Promise(resolve => canvas.toBlob(resolve, mimeType, quality));
    const arrayBuffer = await blob.arrayBuffer();

    return {
      data: new Uint8Array(arrayBuffer),
      ext: isJpg ? 'jpg' : 'png'
    };
  }

  async function waitForRenderedPageAndStitch(pageObj, frameDoc, isJpg, timeoutMs = 18000) {
    const endTime = (_0x4a2400.performance?.now?.() || Date.now()) + timeoutMs;

    while ((_0x4a2400.performance?.now?.() || Date.now()) < endTime) {
      const pageDiv = frameDoc.getElementById(pageObj.domId) || frameDoc.querySelector(`#content-p${pageObj.pageNo}`);
      if (pageDiv) {
        const result = await stitchPageToUint8Array(pageDiv, isJpg);
        if (result) return result;
      }
      await sleep(120);
    }
    throw new Error("Không tìm thấy ảnh đã render ở trang " + pageObj.pageNo + '.');
  }

  function triggerDownload(blob, fileName) {
    const url = _0x4a2400.URL.createObjectURL(blob);
    const a = _0x255af7.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = "noopener";
    a.style.display = "none";
    _0x255af7.documentElement.appendChild(a);
    a.click();
    a.remove();
    _0x4a2400.setTimeout(() => _0x4a2400.URL.revokeObjectURL(url), 60000);
  }

  function updateProgressUI(data = {}) {
    const total = Number.isFinite(data.total) ? data.total : state.lastProgress.total;
    const completed = Number.isFinite(data.completed) ? data.completed : state.lastProgress.completed;
    const stage = Number.isFinite(data.stage) ? data.stage : state.lastProgress.stage;
    const calcVal = total > 0 ? Math.min(total, completed + stage) : 0;
    const pct = total > 0 ? Math.max(0, Math.min(100, Math.round(calcVal / total * 100))) : 0;

    state.lastProgress = {
      completed,
      total,
      stage,
      percent: pct,
      status: data.status || state.lastProgress.status
    };

    const ui = state.ui;
    if (!ui) return;

    ui.count.textContent = completed + '/' + total;
    ui.percent.textContent = pct + '%';
    ui.fill.style.transform = "scaleX(" + pct / 100 + ')';
    ui.status.textContent = state.lastProgress.status;
  }

  function setUiBusy(isBusy) {
    const ui = state.ui;
    if (!ui) return;
    ui.button.disabled = Boolean(isBusy);
    ui.button.textContent = "Download";
    ui.button.style.opacity = isBusy ? "0.72" : '1';
    ui.button.style.cursor = isBusy ? "progress" : "pointer";
    ui.jpgInput.disabled = Boolean(isBusy);
    ui.jpgInput.style.cursor = isBusy ? "default" : "pointer";
  }

  // =========================================================================
  // TIẾN TRÌNH TẢI ÂM THẦM & TẠO FILE ZIP
  // =========================================================================
  async function startDownload() {
    state.running = true;
    setUiBusy(true);
    let silentFrameObj = null;

    const mainReader = getReader();
    const initialPageIndex = getCurrentPageIndex(mainReader);

    try {
      updateProgressUI({ completed: 0, total: 0, stage: 0, status: "Đang tải..." });
      await waitForReader();
      silentFrameObj = await createSilentFrame();

      const reader = silentFrameObj.reader;
      const pages = getPageList(reader);
      const totalPages = pages.length;

      if (!totalPages) {
        throw new Error("Viewer không có trang hợp lệ để tải.");
      }

      const useJpeg = Boolean(state.convertJpeg);
      const zip = new PureZipWriter();
      const cidPrefix = getCidPrefix();

      // TẠO FILE TXT RỖNG MÃ TRUYỆN
      zip.addFile(`${cidPrefix}.txt`, new Uint8Array(0));

      updateProgressUI({ completed: 0, total: totalPages, stage: 0, status: "Đang tải..." });

      for (let i = 0; i < totalPages; i++) {
        const pageObj = pages[i];

        updateProgressUI({ completed: i, total: totalPages, stage: 0.12, status: "Đang tải..." });
        jumpToPage(reader, pageObj.index);

        updateProgressUI({ completed: i, total: totalPages, stage: 0.44, status: "Đang tải..." });

        const stitched = await waitForRenderedPageAndStitch(pageObj, silentFrameObj.D, useJpeg);

        // ĐẶT TÊN ẢNH NGẮN GỌN (1.png, 2.png...)
        const fileName = formatFileName(pageObj, stitched.ext);
        zip.addFile(fileName, stitched.data);

        updateProgressUI({ completed: i + 1, total: totalPages, stage: 0, status: "Đang tải..." });
        await sleep(40);
      }

      updateProgressUI({ completed: totalPages, total: totalPages, stage: 0, status: "Đang xuất file ZIP..." });

      const zipBlob = zip.generateBlob();
      const zipFileName = `${getCleanMangaTitle()}.zip`;
      triggerDownload(zipBlob, zipFileName);

      updateProgressUI({ completed: totalPages, total: totalPages, stage: 0, status: "Hoàn tất" });
    } catch (err) {
      const msg = err?.message || String(err);
      updateProgressUI({ status: "Lỗi: " + msg });
      console.error("[cmoa-speedreader-dl] Download failed", err);
    } finally {
      if (silentFrameObj) silentFrameObj.cleanup();

      try {
        const curMainReader = getReader();
        if (curMainReader && typeof curMainReader.moveTo === 'function' && initialPageIndex >= 0) {
          curMainReader.moveTo(initialPageIndex, false);
        }
      } catch (e) {}

      state.running = false;
      setUiBusy(false);
      updateProgressUI(state.lastProgress);
    }
  }

  function createUI() {
    if (state.ui || !_0x255af7.body) return;

    const panel = _0x255af7.createElement("div");
    panel.id = "cmoa-speedreader-dl";

    panel.style.cssText = [
      "all:initial",
      "position:fixed",
      "right:25px",
      "top:50%",
      "transform:translateY(-50%)",
      "z-index:2147483647",
      "box-sizing:border-box",
      "width:260px",
      "padding:14px 18px",
      "border:1px solid #1a233d",
      "border-radius:12px",
      "background:#0d1222",
      "color:#ffffff",
      "font:12px/1.35 system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif",
      "user-select:none",
      "box-shadow:0 10px 30px rgba(0,0,0,0.75)"
    ].join(';');

    const btn = _0x255af7.createElement("button");
    btn.type = "button";
    btn.textContent = "Download";
    btn.style.cssText = [
      "all:initial",
      "display:block",
      "box-sizing:border-box",
      "width:100%",
      "padding:10px 0",
      "border:0",
      "border-radius:8px",
      "background:#3b66f5",
      "color:#ffffff",
      "font:700 16px/1.2 system-ui,sans-serif",
      "text-align:center",
      "cursor:pointer",
      "box-shadow:0 3px 10px rgba(59, 102, 245, 0.35)"
    ].join(';');

    btn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      startDownload();
    });

    const label = _0x255af7.createElement("label");
    label.style.cssText = [
      "all:initial",
      "display:inline-flex",
      "align-items:center",
      "gap:8px",
      "box-sizing:border-box",
      "margin-top:12px",
      "color:#d1d8eb",
      "font:700 13px/1.2 system-ui,sans-serif",
      "cursor:pointer",
      "user-select:none"
    ].join(';');

    label.addEventListener("click", e => e.stopPropagation());

    const jpgInput = _0x255af7.createElement("input");
    jpgInput.type = "checkbox";
    jpgInput.checked = state.convertJpeg;
    jpgInput.style.cssText = "all:initial;appearance:auto;box-sizing:border-box;width:16px;height:16px;margin:0;accent-color:#3b66f5;cursor:pointer;";
    jpgInput.addEventListener("change", e => {
      e.stopPropagation();
      state.convertJpeg = jpgInput.checked;
      saveJpegPref(state.convertJpeg);
    });

    const spanJpg = _0x255af7.createElement("span");
    spanJpg.textContent = "JPG";
    spanJpg.style.cssText = "all:initial;color:#d1d8eb;font:700 13px/1.2 system-ui,sans-serif;";
    label.append(jpgInput, spanJpg);

    const progressRow = _0x255af7.createElement("div");
    progressRow.style.cssText = "all:initial;display:flex;justify-content:space-between;align-items:center;box-sizing:border-box;margin-top:14px;color:#ffffff;font:800 14px/1.2 system-ui,sans-serif;";

    const countText = _0x255af7.createElement("span");
    countText.textContent = "0/0";
    countText.style.cssText = "all:initial;color:#ffffff;font:800 14px/1.2 system-ui,sans-serif;";

    const percentText = _0x255af7.createElement("span");
    percentText.textContent = "0%";
    percentText.style.cssText = "all:initial;color:#ffffff;font:800 14px/1.2 system-ui,sans-serif;";

    progressRow.append(countText, percentText);

    const track = _0x255af7.createElement("div");
    track.style.cssText = "all:initial;display:block;box-sizing:border-box;height:8px;overflow:hidden;border-radius:4px;background:#1a233d;margin-top:8px;";

    const fill = _0x255af7.createElement("div");
    fill.style.cssText = "all:initial;display:block;width:100%;height:100%;background:#3b66f5;transform:scaleX(0);transform-origin:left center;transition:transform .22s ease;";
    track.appendChild(fill);

    const statusText = _0x255af7.createElement("div");
    statusText.textContent = state.lastProgress.status;
    statusText.style.cssText = "all:initial;display:block;box-sizing:border-box;margin-top:12px;color:#8c99b8;font:13px/1.35 system-ui,sans-serif;";

    panel.append(btn, label, progressRow, track, statusText);
    _0x255af7.body.appendChild(panel);

    state.ui = {
      panel,
      button: btn,
      jpgInput,
      count: countText,
      percent: percentText,
      track,
      fill,
      status: statusText
    };

    updateProgressUI(state.lastProgress);
  }

  async function boot() {
    while (!_0x255af7.body) {
      await sleep(120);
    }
    try {
      const reader = await waitForReader();
      const pages = getPageList(reader);
      createUI();
      updateProgressUI({
        completed: 0,
        total: pages.length,
        stage: 0,
        status: "Sẵn sàng."
      });
    } catch (err) {
      createUI();
      updateProgressUI({
        completed: 0,
        total: 0,
        stage: 0,
        status: "Lỗi: " + (err?.message || err)
      });
    }
  }

  if (_0x255af7.readyState === "loading") {
    _0x255af7.addEventListener("DOMContentLoaded", () => boot());
  } else {
    boot();
  }
})();