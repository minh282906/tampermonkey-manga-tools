// cores/InspectorUI.js
(function(global) {
  'use strict';

  function parseCustomPageRange(input, maxTotal) {
    if (!input || typeof input !== 'string') return null;
    if (/[^\d\s,\->]/.test(input)) return null;

    let str = input.replace(/->/g, '-').replace(/\s*-\s*/g, '-');
    let tokens = str.split(/[\s,]+/).filter(Boolean);
    const pages = new Set();

    for (const token of tokens) {
      if (token.includes('-')) {
        const parts = token.split('-');
        if (parts.length !== 2) return null;
        const start = parseInt(parts[0], 10);
        const end = parseInt(parts[1], 10);
        if (isNaN(start) || isNaN(end) || start <= 0 || end <= 0) return null;
        const [min, max] = start <= end ? [start, end] : [end, start];
        for (let i = min; i <= max; i++) {
          if (i <= maxTotal) pages.add(i);
        }
      } else {
        const p = parseInt(token, 10);
        if (isNaN(p) || p <= 0) return null;
        if (p <= maxTotal) pages.add(p);
      }
    }
    const res = Array.from(pages).sort((a, b) => a - b);
    return res.length > 0 ? res : null;
  }

  function createInspectorUI(options) {
    const { title = "INSPECTOR", totalPages = 100, onPreview = () => {}, onDownload = () => {} } = options;
    const DOC = document;
    DOC.getElementById('manga-inspector-root')?.remove();

    let isDecoded = true, curData = null, previewBox = null;
    let selectedFormat = 'png', selectedQuality = 0.95;

    const root = DOC.createElement('div');
    root.id = 'manga-inspector-root';
    root.style.cssText = 'all:initial;position:fixed;bottom:20px;right:20px;z-index:2147483647;font-family:system-ui,-apple-system,sans-serif;user-select:none;display:block;';

    const btn = DOC.createElement('div');
    btn.textContent = '🔬'; btn.title = 'Mở Inspector';
    btn.style.cssText = 'width:44px;height:44px;border-radius:50%;background:#0f172a;color:#38bdf8;display:flex;align-items:center;justify-content:center;font-size:20px;cursor:pointer;border:2px solid #38bdf8;box-shadow:0 4px 15px rgba(0,0,0,0.6);';

    const panel = DOC.createElement('div');
    panel.style.cssText = 'position:absolute;bottom:55px;right:0;width:330px;background:#0f172a;color:#fff;border:2px solid #38bdf8;border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px;box-shadow:0 10px 30px rgba(0,0,0,0.85);font-size:13px;';

    panel.innerHTML = `
      <div style="font-weight:900;color:#38bdf8;border-bottom:1px solid #334155;padding-bottom:5px;display:flex;justify-content:space-between;">
        <span>${title}</span>
        <span style="font-size:11px;color:#94a3b8;">(${totalPages} trang)</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:2px;">
        <div style="display:flex;align-items:center;gap:4px;">
          <button id="insp-prev-p" style="background:#1e293b;border:1px solid #475569;color:#38bdf8;width:28px;height:28px;border-radius:6px;font-weight:bold;cursor:pointer;">◀</button>
          <input id="insp-input-p" type="text" value="1" placeholder="ví dụ: 1 hoặc 1-5 hoặc 1, 3, 5-9" style="flex:1;background:#1e293b;border:1px solid #475569;color:#fff;padding:4px 8px;border-radius:6px;outline:none;text-align:center;font-size:12px;" />
          <button id="insp-next-p" style="background:#1e293b;border:1px solid #475569;color:#38bdf8;width:28px;height:28px;border-radius:6px;font-weight:bold;cursor:pointer;">▶</button>
        </div>
        <div style="font-size:10px;color:#94a3b8;text-align:center;margin-top:2px;">Nhập dải trang để tải</div>
      </div>
      <div style="display:flex;gap:4px;" id="insp-fmt-group">
        <button data-fmt="png" style="flex:1;background:#0284c7;color:#fff;border:1px solid #475569;padding:4px 0;border-radius:6px;font-size:11px;font-weight:bold;cursor:pointer;">PNG</button>
        <button data-fmt="jpg" style="flex:1;background:#1e293b;color:#fff;border:1px solid #475569;padding:4px 0;border-radius:6px;font-size:11px;font-weight:bold;cursor:pointer;">JPG</button>
        <button data-fmt="webp" style="flex:1;background:#1e293b;color:#fff;border:1px solid #475569;padding:4px 0;border-radius:6px;font-size:11px;font-weight:bold;cursor:pointer;">WEBP</button>
      </div>
      <div id="insp-quality-row" style="display:none;align-items:center;justify-content:space-between;gap:6px;font-size:11px;color:#94a3b8;">
        <span>Chất lượng: <b id="insp-q-val" style="color:#38bdf8;">95%</b></span>
        <input id="insp-q-slider" type="range" min="10" max="100" value="95" style="flex:1;cursor:pointer;accent-color:#38bdf8;" />
      </div>
      <div style="display:flex;gap:6px;">
        <button id="insp-btn-live" style="flex:1;background:#065f46;color:#34d399;border:1px solid #059669;padding:7px 0;border-radius:6px;font-weight:bold;cursor:pointer;transition:opacity 0.2s;">👁️ Soi Live</button>
        <button id="insp-btn-down" style="flex:1;background:#0284c7;color:#fff;border:none;padding:7px 0;border-radius:6px;font-weight:bold;cursor:pointer;transition:opacity 0.2s;">📥 Tải 2 Bản</button>
      </div>
      <div id="insp-info-box" style="background:#1e293b;padding:6px;border-radius:6px;font-size:11px;display:none;border-left:3px solid #38bdf8;line-height:1.45;"></div>
      <div id="insp-status-text" style="font-size:11px;color:#94a3b8;line-height:1.4;">Sẵn sàng.</div>
    `;

    let isOpen = true;
    btn.onclick = () => { isOpen = !isOpen; panel.style.display = isOpen ? 'flex' : 'none'; };

    const inputEl = panel.querySelector('#insp-input-p');
    const liveBtn = panel.querySelector('#insp-btn-live');
    const downBtn = panel.querySelector('#insp-btn-down');
    const prevBtn = panel.querySelector('#insp-prev-p');
    const nextBtn = panel.querySelector('#insp-next-p');
    const statusText = panel.querySelector('#insp-status-text');
    const infoBox = panel.querySelector('#insp-info-box');
    const qualityRow = panel.querySelector('#insp-quality-row');
    const qSlider = panel.querySelector('#insp-q-slider');
    const qVal = panel.querySelector('#insp-q-val');

    qSlider.oninput = () => {
      selectedQuality = parseInt(qSlider.value, 10) / 100;
      qVal.textContent = `${qSlider.value}%`;
    };

    function setBusy(busy) {
      [liveBtn, downBtn, prevBtn, nextBtn].forEach(b => {
        b.disabled = busy;
        b.style.opacity = busy ? '0.5' : '1';
        b.style.cursor = busy ? 'not-allowed' : 'pointer';
      });
    }

    prevBtn.onclick = () => {
      let cur = parseInt(inputEl.value, 10) || 1;
      if (cur > 1) { inputEl.value = String(cur - 1); liveBtn.click(); }
    };
    nextBtn.onclick = () => {
      let cur = parseInt(inputEl.value, 10) || 1;
      if (cur < totalPages) { inputEl.value = String(cur + 1); liveBtn.click(); }
    };

    const fmtBtns = panel.querySelectorAll('#insp-fmt-group button');
    fmtBtns.forEach(b => {
      b.onclick = () => {
        selectedFormat = b.dataset.fmt;
        fmtBtns.forEach(x => x.style.background = (x.dataset.fmt === selectedFormat ? '#0284c7' : '#1e293b'));
        qualityRow.style.display = selectedFormat === 'png' ? 'none' : 'flex';
      };
    });

    function updateStatusDisplay() {
      const ext = (curData?.rawExt || 'JPG').toUpperCase();
      if (curData?.isScrambled === false) {
        statusText.innerHTML = `Mode đang xem: <b style="color:#38bdf8;">RAW GỐC (${ext})</b><br><span style="color:#94a3b8;">(Ảnh gốc nguyên bản)</span>`;
      } else {
        statusText.innerHTML = `Mode đang xem: <b style="color:#38bdf8;">${isDecoded ? 'ĐÃ GHÉP XÁO TRỘN' : `RAW XÁO TRỘN GỐC (${ext})`}</b><br><span style="color:#94a3b8;">(Bấm vào ảnh để đảo Mode)</span>`;
      }
    }

    function renderOverlay() {
      if (!previewBox || !curData) return;
      const wrap = previewBox.querySelector('#insp-wrap');
      wrap.innerHTML = '';
      let target = isDecoded ? (curData.visualCanvas || curData.sharpCanvas) : curData.rawCanvas;
      target.style.cssText = 'max-height:94vh;max-width:94vw;border:2px solid #38bdf8;box-shadow:0 0 30px rgba(56,189,248,0.85);cursor:pointer;display:block;';
      target.title = 'Bấm vào ảnh để chuyển MODE';
      target.onclick = () => {
        isDecoded = !isDecoded;
        renderOverlay();
        updateStatusDisplay();
      };
      wrap.appendChild(target);
    }

    liveBtn.onclick = () => {
      const parsed = parseCustomPageRange(inputEl.value, totalPages);
      if (!parsed) {
        alert("Dải trang không hợp lệ! Hãy dùng dạng: 1 hoặc 1-5 hoặc 1, 3, 5-9");
        return;
      }
      setBusy(true);
      statusText.textContent = `Đang xử lý trang ${parsed[0]}...`;

      onPreview(parsed[0], (data, pNo) => {
        setBusy(false);
        curData = data; isDecoded = true;
        updateStatusDisplay();

        if (!data.rawCanvas && data.img) {
          const rawC = DOC.createElement('canvas');
          rawC.width = data.rawW; rawC.height = data.rawH;
          const rCtx = rawC.getContext('2d', { alpha: false });
          rCtx.imageSmoothingEnabled = false;
          rCtx.drawImage(data.img, 0, 0);
          curData.rawCanvas = rawC;
        }

        infoBox.style.display = 'block';
        infoBox.innerHTML = `
          <div style="font-weight:bold;color:#34d399;">✅ Trang ${pNo}: Kích thước ${data.rawW}x${data.rawH}px</div>
          ${data.gridW ? `<div style="color:#cbd5e1;">Khung ma trận: <b>${data.gridW}x${data.gridH}px</b></div>` : ''}
          <div style="color:${data.dummyText?.includes('Khớp') ? '#38bdf8' : '#f43f5e'};font-weight:bold;">${data.dummyText || "Khớp 100% không có viền thừa"}</div>
        `;

        if (!previewBox) {
          previewBox = DOC.createElement('div');
          previewBox.style.cssText = 'position:fixed;top:10px;left:10px;z-index:2147483646;display:flex;flex-direction:column;align-items:flex-start;';
          const cBtn = DOC.createElement('button');
          cBtn.textContent = '✖';
          cBtn.title = 'Đóng ảnh';
          cBtn.style.cssText = 'width:24px;height:24px;background:#e11d48;color:#fff;border:1.5px solid #fff;border-radius:50%;font-size:12px;font-weight:900;cursor:pointer;margin-bottom:4px;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.5);';
          cBtn.onclick = () => { previewBox.remove(); previewBox = null; };
          const wrap = DOC.createElement('div'); wrap.id = 'insp-wrap';
          previewBox.append(cBtn, wrap);
          DOC.body.appendChild(previewBox);
        }
        renderOverlay();
      }, err => {
        setBusy(false);
        statusText.textContent = `❌ ${err}`;
      });
    };

    downBtn.onclick = () => {
      const parsed = parseCustomPageRange(inputEl.value, totalPages);
      if (!parsed) {
        alert("Dải trang không hợp lệ! Hãy dùng dạng: 1 hoặc 1-5 hoặc 1, 3, 5-9");
        return;
      }
      onDownload(parsed, selectedFormat, selectedQuality, statusText, downBtn);
    };

    root.append(btn, panel);
    DOC.body.appendChild(root);
  }

  global.createInspectorUI = createInspectorUI;
  global.parseCustomPageRange = parseCustomPageRange;
})(typeof window !== 'undefined' ? window : this);