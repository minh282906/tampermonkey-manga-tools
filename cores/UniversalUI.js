// cores/UniversalUI.js
(function(global) {
  'use strict';

  function getContrastColor(hexColor) {
    if (!hexColor || typeof hexColor !== 'string') return '#ffffff';
    const hex = hexColor.replace('#', '');
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      return luminance > 0.6 ? '#18181b' : '#ffffff'; // Nền sáng -> Chữ Đen, Nền tối -> Chữ Trắng
    }
    return '#ffffff';
  }

  function createMangaDownloaderUI(options) {
    const {
      storagePrefix = "manga-dl",
      title = "Manga Downloader",
      themeColor = "#e52865",        // Màu nút & viền
      themeBg = "#18181b",           // Màu nền
      titleColor = "#f472b6",        // Màu chữ tiêu đề
      topOffset = "70px",            // Vị trí top
      defaultJpgText = "Xuất file JPG (mặc định PNG)",
      onDownload = () => {},
      onJpgChange = (checked) => {}
    } = options;

    const btnTextColor = getContrastColor(themeColor);
    const isLightBg = getContrastColor(themeBg) === '#18181b';
    const bodyTextColor = isLightBg ? '#1e293b' : '#ffffff'; 
    const subTextColor = isLightBg ? '#475569' : '#cbd5e1';  
    const trackBg = isLightBg ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.15)'; 
    const panelShadow = isLightBg ? '0 8px 24px rgba(0,0,0,0.12), -2px 0 8px rgba(0,0,0,0.04)' : '0 8px 24px rgba(0,0,0,0.85)';
    const btnShadow = isLightBg ? '0 2px 6px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.06)' : `0 3px 10px ${themeColor}55`;

    const DOC = document;
    const PANEL_WIDTH = 220;
    const TAB_WIDTH = 14;
    let isCollapsed = localStorage.getItem(`${storagePrefix}:collapsed`) === '1';

    // TỐI ƯU: Padding giảm xuống 8px 12px để bảng gọn gàng
    const panel = DOC.createElement("div");
    panel.id = `${storagePrefix}-panel`;
    panel.style.cssText = [
      "all:initial", "position:fixed", "right:0px", `top:${topOffset}`,
      "z-index:2147483647", "box-sizing:border-box", `width:${PANEL_WIDTH}px`,
      "padding:8px 12px", `border:1px solid ${themeColor}`, "border-right:none",
      "border-radius:12px 0 0 12px", `background:${themeBg}`, `color:${bodyTextColor}`,
      "font:12px/1.2 system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif",
      "user-select:none", `box-shadow:${panelShadow}`,
      "transition:transform 0.22s cubic-bezier(0.16, 1, 0.3, 1)",
      `transform:${isCollapsed ? `translateX(calc(100% - ${TAB_WIDTH}px))` : "translateX(0)"}`,
      "display:none", "overflow:hidden"
    ].join(';');

    const collapsedStrip = DOC.createElement("div");
    collapsedStrip.style.cssText = [
      "all:initial", "position:absolute", "left:0px", "top:0px",
      `width:${TAB_WIDTH}px`, "height:100%", `background:${themeColor}`, "cursor:pointer",
      "transition:opacity 0.15s, background 0.15s",
      `opacity:${isCollapsed ? "1" : "0"}`, `pointer-events:${isCollapsed ? "auto" : "none"}`
    ].join(';');
    collapsedStrip.title = "Mở bảng tải";

    const mainContent = DOC.createElement("div");
    mainContent.style.cssText = [
      "all:initial", "display:block", "transition:opacity 0.2s",
      `opacity:${isCollapsed ? "0" : "1"}`, `pointer-events:${isCollapsed ? "none" : "auto"}`
    ].join(';');

    const collapseBtn = DOC.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.textContent = "▶";
    collapseBtn.title = "Thu gọn";
    collapseBtn.style.cssText = [
      "all:initial", "position:absolute", "left:0px", "top:0px", "width:22px", "height:22px",
      "display:flex", "align-items:center", "justify-content:center",
      "border-radius:12px 0 8px 0", `background:${themeColor}`, `color:${btnTextColor}`,
      "font:900 10px system-ui,sans-serif", "cursor:pointer", "z-index:2"
    ].join(';');

    // TỐI ƯU: margin-bottom giảm còn 5px
    const titleEl = DOC.createElement("div");
    titleEl.textContent = title;
    titleEl.style.cssText = `all:initial;display:block;color:${titleColor};font:800 13px system-ui;margin-bottom:5px;text-align:center;padding-left:14px;`;

    // TỐI ƯU: padding nút Download giảm còn 7px
    const btn = DOC.createElement("button");
    btn.type = "button";
    btn.textContent = "Download";
    btn.style.cssText = [
      "all:initial", "display:block", "box-sizing:border-box", "width:100%", "padding:7px 0",
      "border:0", "border-radius:6px", `background:${themeColor}`, `color:${btnTextColor}`,
      "font:800 14px/1.2 system-ui,sans-serif", "text-align:center", "cursor:pointer",
      `box-shadow:${btnShadow}`
    ].join(';');
    btn.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); onDownload(); });

    // TỐI ƯU: margin-top giảm còn 5px
    const label = DOC.createElement("label");
    label.style.cssText = `all:initial;display:inline-flex;align-items:center;gap:6px;margin-top:5px;color:${subTextColor};font:700 11px system-ui;cursor:pointer;`;

    const jpgInput = DOC.createElement("input");
    jpgInput.type = "checkbox";
    jpgInput.checked = localStorage.getItem(`${storagePrefix}:convert-jpeg`) === '1';
    jpgInput.style.cssText = `all:initial;appearance:auto;width:13px;height:13px;accent-color:${themeColor};cursor:pointer;`;
    jpgInput.addEventListener("change", () => {
      localStorage.setItem(`${storagePrefix}:convert-jpeg`, jpgInput.checked ? '1' : '0');
      onJpgChange(jpgInput.checked);
    });

    const spanJpg = DOC.createElement("span");
    spanJpg.textContent = defaultJpgText;
    spanJpg.style.cssText = `all:initial;color:${subTextColor};font:700 11px system-ui;`;
    label.append(jpgInput, spanJpg);

    // TỐI ƯU: margin-top giảm còn 6px
    const progressRow = DOC.createElement("div");
    progressRow.style.cssText = `all:initial;display:flex;justify-content:space-between;align-items:center;margin-top:6px;color:${bodyTextColor};font:800 12px system-ui;`;

    const countText = DOC.createElement("span");
    countText.textContent = "0/0";
    countText.style.cssText = `all:initial;color:${bodyTextColor};font:800 12px system-ui;`;

    const percentText = DOC.createElement("span");
    percentText.textContent = "0%";
    percentText.style.cssText = `all:initial;color:${bodyTextColor};font:800 12px system-ui;`;
    progressRow.append(countText, percentText);

    // TỐI ƯU: track margin-top giảm còn 4px, cao 5px
    const track = DOC.createElement("div");
    track.style.cssText = `all:initial;display:block;height:5px;overflow:hidden;border-radius:3px;background:${trackBg};margin-top:4px;`;

    const fill = DOC.createElement("div");
    fill.style.cssText = `all:initial;display:block;width:100%;height:100%;background:${themeColor};transform:scaleX(0);transform-origin:left center;transition:transform .22s ease;`;
    track.appendChild(fill);

    // TỐI ƯU: statusText margin-top giảm còn 5px
    const statusText = DOC.createElement("div");
    statusText.textContent = "Đang kiểm tra...";
    statusText.style.cssText = `all:initial;display:block;margin-top:5px;color:${subTextColor};font:11px system-ui;word-break:break-word;`;

    mainContent.append(collapseBtn, titleEl, btn, label, progressRow, track, statusText);
    panel.append(collapsedStrip, mainContent);

    function setCollapsedState(collapsed) {
      isCollapsed = collapsed;
      localStorage.setItem(`${storagePrefix}:collapsed`, isCollapsed ? '1' : '0');
      panel.style.transform = isCollapsed ? `translateX(calc(100% - ${TAB_WIDTH}px))` : "translateX(0)";
      collapsedStrip.style.opacity = isCollapsed ? "1" : "0";
      collapsedStrip.style.pointerEvents = isCollapsed ? "auto" : "none";
      mainContent.style.opacity = isCollapsed ? "0" : "1";
      mainContent.style.pointerEvents = isCollapsed ? "none" : "auto";
    }

    collapseBtn.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); setCollapsedState(true); });
    panel.addEventListener("click", () => { if (isCollapsed) setCollapsedState(false); });
    DOC.body.appendChild(panel);

    return {
      panel,
      button: btn,
      jpgInput,
      jpgSpan: spanJpg,
      count: countText,
      percent: percentText,
      fill,
      status: statusText,
      updateProgress: function(data = {}) {
        const total = Number.isFinite(data.total) ? data.total : 0;
        const completed = Number.isFinite(data.completed) ? data.completed : 0;
        const pct = total > 0 ? Math.max(0, Math.min(100, Math.round(completed / total * 100))) : 0;
        countText.textContent = total ? `${Math.min(completed, total)}/${total}` : "0/0";
        percentText.textContent = `${pct}%`;
        fill.style.transform = `scaleX(${total > 0 ? pct / 100 : 0})`;
        if (data.status) statusText.textContent = data.status;
      },
      setBusy: function(isBusy) {
        btn.disabled = Boolean(isBusy);
        btn.style.opacity = isBusy ? "0.72" : '1';
        btn.style.cursor = isBusy ? "progress" : "pointer";
      },
      updateFormatUI: function(format) {
        if (format === 'jpg') {
          jpgInput.checked = true;
          jpgInput.disabled = true;
          spanJpg.textContent = "Xuất file JPG (ảnh gốc là JPG)";
        } else if (format === 'webp') {
          jpgInput.disabled = false;
          spanJpg.textContent = "Xuất file JPG (ảnh gốc là WebP)";
        } else if (format === 'png') {
          jpgInput.disabled = false;
          spanJpg.textContent = "Xuất file JPG (ảnh gốc là PNG)";
        }
      }
    };
  }

  (typeof globalThis !== 'undefined' ? globalThis : window).createMangaDownloaderUI = createMangaDownloaderUI;
})(typeof window !== 'undefined' ? window : this);