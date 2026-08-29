// cores/InspectorUI.js
(function(global) {
  'use strict';

  function parseCustomPageRange(input, maxTotal) {
    if (!input || typeof input !== 'string') return null;
    // Chỉ cho phép: số, khoảng trắng, phẩy, gạch ngang, dấu > (của ->). Bác bỏ dấu . hoặc ~
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
      <div style="display:flex;align-items:center;gap:4px;">
        <button id="insp-prev-p" style="background:#1e293b;border:1px solid #475569;color:#38bdf8;width:28px;height:28px;border-radius:6px;font-weight:bold;cursor:pointer;">◀</button>
        <input id="insp-input-p" type="text" value="1" style="flex:1;background:#1e293b;border:1px solid #475569;color:#fff;padding:4px 8px;border-radius:6px;outline:none;text-align:center;font-size:13px;" />
        <button id="insp-next-p" style="background:#1e293b;border:1px solid #475569;color:#38bdf8;width:28px;height:28px;border-radius:6px;font-weight:bold;cursor:pointer;">▶</button>
      </div>
      <div style="display:flex;gap:4px;" id="insp-fmt-group">
        <button data-fmt="png" style="flex:1;background:#0284c7;color:#fff;border:1px solid #475569;padding:4px 0;border-radius:6px;font-size:11px;font-weight:bold;cursor:pointer;">PNG</button>
        <button data-fmt="jpg" style="flex:1;background:#1e293b;color:#fff;border:1px solid #475569;padding:4px 0;border-radius:6px;font-size:11px;font-weight:bold;cursor:pointer;">JPG</button>
        <button data-fmt="webp" style="flex:1;background:#1e293b;color:#fff;border:1px solid #475569;padding:4px 0;border-radius:6px;font-size:11px;font-weight:bold;cursor:pointer;">WEBP</button>
      </div>
      <div style="display:flex;gap:6px;">
        <button id="insp-btn-live" style="flex:1;background:#065f46;color:#34d399;border:1px solid #059669;padding:7px 0;border-radius:6px;font-weight:bold;cursor:pointer;">👁️ Soi Live</button>
        <button id="insp-btn-down" style="flex:1;background:#0284c7;color:#fff;border:none;padding:7px 0;border-radius:6px;font-weight:bold;cursor:pointer;">📥 Tải 2 Bản</button>
      </div>
      <div id="insp-info-box" style="background:#1e293b;padding:6px;border-radius:6px;font-size:11px;display:none;border-left:3px solid #38bdf8;"></div>
      <div id="insp-status-text" style="font-size:11px;color:#94a3b8;">Sẵn sàng.</div>
    `;

    let isOpen = true;
    btn.onclick = () => { isOpen = !isOpen; panel.style.display = isOpen ? 'flex' : 'none'; };

    const inputEl = panel.querySelector('#insp-input-p');
    panel.querySelector('#insp-prev-p').onclick = () => {
      let cur = parseInt(inputEl.value, 10) || 1;
      if (cur > 1) { inputEl.value = String(cur - 1); panel.querySelector('#insp-btn-live').click(); }
    };
    panel.querySelector('#insp-next-p').onclick = () => {
      let cur = parseInt(inputEl.value, 10) || 1;
      if (cur < totalPages) { inputEl.value = String(cur + 1); panel.querySelector('#insp-btn-live').click(); }
    };

    const fmtBtns = panel.querySelectorAll('#insp-fmt-group button');
    fmtBtns.forEach(b => {
      b.onclick = () => {
        selectedFormat = b.dataset.fmt;
        fmtBtns.forEach(x => x.style.background = (x.dataset.fmt === selectedFormat ? '#0284c7' : '#1e293b'));
      };
    });

    function renderOverlay() {
      if (!previewBox || !curData) return;
      const wrap = previewBox.querySelector('#insp-wrap');
      wrap.innerHTML = '';
      let target = isDecoded ? (curData.visualCanvas || curData.sharpCanvas) : curData.rawCanvas;
      target.style.cssText = 'max-height:88vh;max-width:88vw;border:3px solid #38bdf8;box-shadow:0 0 40px rgba(56,189,248,0.85);cursor:pointer;display:block;';
      target.onclick = () => { isDecoded = !isDecoded; renderOverlay(); };
      wrap.appendChild(target);
    }

    panel.querySelector('#insp-btn-live').onclick = () => {
      const parsed = parseCustomPageRange(inputEl.value, totalPages);
      if (!parsed) {
        alert("Dải trang không hợp lệ! Hãy dùng dạng: 1 hoặc 1-5 hoặc 1, 3, 5-9 hoặc 1 -> 5");
        return;
      }
      onPreview(parsed[0], (data, pNo) => {
        curData = data; isDecoded = true;
        if (!data.rawCanvas && data.img) {
          const rawC = DOC.createElement('canvas');
          rawC.width = data.rawW; rawC.height = data.rawH;
          const rCtx = rawC.getContext('2d', { alpha: false });
          rCtx.drawImage(data.img, 0, 0);
          rCtx.fillStyle = '#ff0055'; rCtx.font = 'bold 24px sans-serif'; rCtx.fillText('[RAW CDN GỐC]', 20, 45);
          curData.rawCanvas = rawC;
        }

        const info = panel.querySelector('#insp-info-box');
        info.style.display = 'block';
        info.innerHTML = `<b style="color:#34d399;">Trang ${pNo}: ${data.rawW}x${data.rawH}px</b><br><span style="color:#f43f5e;">${data.dummyText || "Khớp 100%"}</span>`;

        if (!previewBox) {
          previewBox = DOC.createElement('div');
          previewBox.style.cssText = 'position:fixed;top:15px;left:15px;z-index:2147483646;display:flex;flex-direction:column;';
          const cBtn = DOC.createElement('button');
          cBtn.textContent = '✖ ĐÓNG';
          cBtn.style.cssText = 'background:#e11d48;color:#fff;border:2px solid #fff;border-radius:6px;padding:3px 8px;font-weight:bold;cursor:pointer;margin-bottom:6px;width:max-content;';
          cBtn.onclick = () => { previewBox.remove(); previewBox = null; };
          const wrap = DOC.createElement('div'); wrap.id = 'insp-wrap';
          previewBox.append(cBtn, wrap);
          DOC.body.appendChild(previewBox);
        }
        renderOverlay();
      }, err => { panel.querySelector('#insp-status-text').textContent = `❌ ${err}`; });
    };

    panel.querySelector('#insp-btn-down').onclick = () => {
      const parsed = parseCustomPageRange(inputEl.value, totalPages);
      if (!parsed) {
        alert("Dải trang không hợp lệ! Hãy dùng dạng: 1 hoặc 1-5 hoặc 1, 3, 5-9");
        return;
      }
      onDownload(parsed, selectedFormat, selectedQuality, panel.querySelector('#insp-status-text'), panel.querySelector('#insp-btn-down'));
    };

    root.append(btn, panel);
    DOC.body.appendChild(root);
  }

  global.createInspectorUI = createInspectorUI;
  global.parseCustomPageRange = parseCustomPageRange;
})(typeof window !== 'undefined' ? window : this);