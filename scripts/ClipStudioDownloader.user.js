// ==UserScript==
// @name         Clip Studio Reader Universal Downloader
// @namespace    https://github.com/minh282906/tampermonkey-manga-tools
// @version      1.0.0
// @icon         https://www.google.com/s2/favicons?domain=clipstudio.net&sz=128
// @description  Tải manga và webtoon trên toàn bộ hệ sinh thái CLIP STUDIO READER.
// @author       anonymous & AI
// @match        https://firecross.jp/reader/*
// @match        https://*.firecross.jp/reader/*
// @match        https://comic-viewer.iowl.jp/*
// @match        https://drecom-media.jp/viewer/*
// @match        https://bsreader.hakusensha-e.net/*
// @match        https://bs.comicdc.jp/*
// @match        https://mbj-bs.pf.mobilebook.jp/*
// @match        https://bs.web-viewer.honto.jp/*
// @match        https://bsreader.handycomic.jp/*
// @match        https://api.distribution.mediadotech.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      firecross.jp
// @connect      comic-viewer.iowl.jp
// @connect      comic.iowl.jp
// @connect      drecom-media.jp
// @connect      bsreader.hakusensha-e.net
// @connect      bs.comicdc.jp
// @connect      mbj-bs.pf.mobilebook.jp
// @connect      bs.web-viewer.honto.jp
// @connect      bsreader.handycomic.jp
// @connect      api.distribution.mediadotech.com
//
// --- TỰ ĐỘNG NẠP KHI CÀI ĐẶT ĐỘC LẬP QUA JSDELIVR ---
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/PureZipWriter.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/UniversalUI.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/RouteWatcher.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/cores/MangaUtils.js
// @require      https://cdn.jsdelivr.net/gh/minh282906/tampermonkey-manga-tools@main/decoders/ClipStudioTools.js
// ==/UserScript==

(function clipStudioUniversalDownloader() {
  'use strict';

  /* =========================================================================
   * CẤU HÌNH HỆ THỐNG
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 6,   // 6 luồng TCP Socket
    JPEG_QUALITY: 1.0    // Chất lượng xuất JPG nếu người dùng chọn
  };

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;
  const sleep = ms => new Promise(resolve => WIN.setTimeout(resolve, ms));

  if (WIN.top !== WIN.self) return;

  const state = {
    running: false,
    convertJpeg: localStorage.getItem("clipstudio-dl:convert-jpeg") === '1',
    chapterData: null,
    ui: null,
    lastUrl: "",
    lastEpisodeKey: ""
  };

  /* =========================================================================
   * BẢNG CẤU HÌNH THEME TỪNG SÀN CLIP STUDIO READER (TỰ BÓC TÁCH THEO THƯƠNG HIỆU GỐC)
   * ========================================================================= */
  const SITE_THEMES = {

    // 1. Nhóm MediaDo (Comist, Galcomi, Itsudemo, Rakuraku)
    "comist.jp":                 { name: "Comist",           top: "56px", color: "#62C3C5", bg: "#ffffff", text: "#18181b" },
    "galcomi.jp":                { name: "Galcomi",          top: "56px", color: "#009596", bg: "#ffffff", text: "#4AA3A2" },
    "itsudoco.com":              { name: "いつでも書店",      top: "56px", color: "#E75098", bg: "#ffffff", text: "#02B9EE" },
    "rakurakucomic.com":         { name: "ラクラクコミック",  top: "56px", color: "#FF9F00", bg: "#ffffff", text: "#FF9F00" },


    // 2. Nhóm ComicDC / Happy Comic / Sugo Comic / Access Books
    "happycomic.jp":             { name: "Happyコミック",    top: "56px", color: "#FF7844", bg: "#ffffff", text: "#FF7844" },
    "s.accessbooks.jp":          { name: "アクセスBOOKS",    top: "56px", color: "#FF9933", bg: "#ffffff", text: "#FF9933" },
    "nadeshiko-shoten.jp":       { name: "スゴコミック",     top: "56px", color: "#DC698D", bg: "#ffffff", text: "#DC698D" },

    // 2. Nhận diện theo domain độc lập
    "web-viewer.honto.jp":       { name: "honto",            top: "48px", color: "#3A83C7", bg: "#ffffff", text: "#3A83C7" },
    "mbj-bs.pf.mobilebook.jp":   { name: "honto",            top: "48px", color: "#3A83C7", bg: "#ffffff", text: "#3A83C7" }, 
    "firecross.jp":              { name: "Fire CROSS",       top: "66.57px", color: "#EA3F25", bg: "#ffffff", text: "#EA3F25" }, 
    "comic-viewer.iowl.jp":      { name: "Com!cFesta",       top: "56px"   , color: "#9C27B0", bg: "#ffffff", text: "#9C27B0" }, 
    "drecom-media.jp":           { name: "DRE Comics",      top: "56px"    , color: "#FE7701", bg: "#ffffff", text: "#FE7701" }, 
    "bsreader.hakusensha-e.net": { name: "白泉社 e-net!",    top: "56px"    , color: "#4791ED", bg: "#ffffff", text: "#4791ED" },
    "bsreader.handycomic.jp":    { name: "ブッコミ",         top: "56px", color: "#E52A89", bg: "#ffffff", text: "#E52A89" },

    // 3. Dự phòng theo host backend
    "bs.comicdc.jp":             { name: "ComicDC",          top: "56px"   , color: "#FF7700", bg: "#ffffff", text: "#FF7700" },
    "mobilebook.jp":             { name: "MobileBook",       top: "56px"   , color: "#3A83C7", bg: "#ffffff", text: "#3A83C7" }
  };

  function resolveSiteTheme() {
    const sp = new URLSearchParams(WIN.location.search);
    const storeUrl = sp.get('url') || sp.get('colophon') || DOC.querySelector('input[name="url"]')?.value || "";
    const currentContext = `${WIN.location.hostname} ${storeUrl}`.toLowerCase();

    for (const key in SITE_THEMES) {
      if (currentContext.includes(key.toLowerCase())) {
        return SITE_THEMES[key];
      }
    }

    return { name: "Clip Studio", top: "56px", color: "#00a2e8", bg: "#18181b", text: "#ffffff" };
  }

  /* =========================================================================
   * 1. GIAO DIỆN THEME: XANH CELSYS (#00A2E8) - NỀN TỐI NGUYÊN BẢN
   * ========================================================================= */
  function getUI() {
    if (state.ui) return state.ui;
    const createUI = window.createMangaDownloaderUI || globalThis.createMangaDownloaderUI;

    if (typeof createUI === "function" && DOC.body) {

      const theme = resolveSiteTheme();
      const uiConfig = {
        storagePrefix: "clipstudio-dl",
        title: theme.name,
        engine: "Clip Studio Reader",
        themeColor: theme.color,
        themeBg: theme.bg,
        titleColor: theme.text,
        btnBg: theme.color,
        btnColor: "#ffffff",
        tabBg: theme.color,
        tabColor: "#ffffff",
        topOffset: theme.top,
        defaultJpgText: "Xuất file JPG (mặc định PNG)",
        onDownload: startDownload,
        onJpgChange: (checked) => {
          state.convertJpeg = checked;
          localStorage.setItem("clipstudio-dl:convert-jpeg", checked ? '1' : '0');
        }
      };

      state.ui = createUI(uiConfig);
      state.ui.setBusy(true);

      if (state.ui?.panel) {
        const titleEl = state.ui.panel.querySelector('[style*="font: 800 13px"], [style*="font:800 13px"]');
        if (titleEl) {
          titleEl.innerHTML = `
            <div style="all:initial;display:block;font:800 13px/1.2 system-ui,sans-serif;color:${uiConfig.titleColor};letter-spacing:0.3px;">${uiConfig.title}</div>
            <div style="all:initial;display:block;font:700 9px/1.2 system-ui,sans-serif;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;margin-top:2px;">${uiConfig.engine}</div>
          `;
        }
      }
    }
    return state.ui;
  }

  /* =========================================================================
   * 2. BỘ HỖ TRỢ XỬ LÝ CHUỖI, URL & METADATA
   * ========================================================================= */
  function isEpisodeUrl() {
    // 1. Chặn tuyệt đối chế độ Tiểu thuyết chữ (Novel Reflow) để không hiện UI rác
    const isReflowNovel = DOC.querySelector('script[src*="reflow"], link[href*="reflow"]') ||
                          WIN.location.search.includes('dirs=epub/reflow');
    if (isReflowNovel) return false;

    // 2. Nhận diện các trang Manga/Webtoon hợp lệ
    const p = WIN.location.pathname;
    const s = WIN.location.search;
    if (s.includes('param=') || DOC.querySelector('input[name="param"]')) return true;
    return /\/(?:reader|viewer)\//i.test(p);
  }

  function getEpisodeId() {
    const path = WIN.location.pathname;
    const sp = new URLSearchParams(WIN.location.search);
    const m = path.match(/\/(?:reader|viewer)\/(?:p\/)?([a-zA-Z0-9_-]+)/i);
    if (m) return m[1];
    if (sp.has('c')) return sp.get('c');
    if (sp.has('param')) return sp.get('param').slice(0, 16).replace(/[^a-zA-Z0-9]/g, '');
    return "CSR_Episode";
  }

  function cleanString(str) {
    if (!str) return "";
    return str
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/【(?!(?:フルカラー版|カラー版|完全版|特装版))[^】]*】/gi, '')
      .replace(/[\\/*?:"<>|]/g, '')
      .trim();
  }

  /* =========================================================================
   * BỘ BÓC TÁCH TIÊU ĐỀ ĐA TẦNG CHO TOÀN BỘ CÁC SÀN CSR
   * ========================================================================= */
  async function getCleanTitle(manifestTitle) {
    try {
      const sp = new URLSearchParams(WIN.location.search);
      const storeUrl = sp.get('url') || sp.get('colophon') || "";
      const Utils = WIN.MangaUtils || window.MangaUtils;

      // -------------------------------------------------------------
      // BƯỚC A: LẤY DANH SÁCH MỤC LỤC TRONG RAM / DOM (NẾU CÓ)
      // -------------------------------------------------------------
      let rawTocList = [];
      try {
        const tocData = WIN.appmain?.App_h5v?._tableOfContentsData;
        if (Array.isArray(tocData) && tocData.length > 0) {
          rawTocList = tocData.map(item => item?.str || item?.name || item?.title || "");
        }
      } catch (e) {}

      if (rawTocList.length === 0) {
        const domEls = DOC.querySelectorAll([
          '#scrollcontent_toc_panel [id^="toc_item_"]',
          '.panel-toc-list-item',
          '.toc_list_clone',
          '[class*="toc-list-item"]'
        ].join(', '));
        rawTocList = Array.from(domEls).map(el => el.textContent);
      }

      // Lọc bỏ từ rác: thêm cả chữ "カバー" của Happy Comic
      const validTocItems = rawTocList
        .map(t => cleanString(t))
        .filter(t => t && t.length > 1 && !/^(?:表紙|目次|もくじ|Cover(?:\s*Page)?|カバー|Main|本編|奥付|この作品に.*|未設定|再表示)$/i.test(t));

      // =============================================================
      // ĐẶC TRỊ RIÊNG CHO GALCOMI, RAKURAKU, HAPPY COMIC, ACCESS BOOKS & COMICFESTA
      // =============================================================
      if (storeUrl && Utils?.fetchBuffer) {
        const colophonUrl = sp.get('colophon') || "";

        // 1. Nhóm MediaDo (Galcomi & Rakuraku Comic): KHÔNG CÓ DẤU "-" nếu là (n)
        if (storeUrl.includes('galcomi.jp') || storeUrl.includes('rakurakucomic.com') || storeUrl.includes('/sd/page/')) {
          try {
            const buf = await Utils.fetchBuffer(storeUrl);
            const html = new TextDecoder().decode(buf);
            const mSeries = html.match(/class=["'][^"']*content-title-name[^"']*["']>([^<]+)<\//i);
            const mVol = html.match(/class=["'][^"']*content-permit-name[^"']*["']>([^<]+)<\//i);
            if (mSeries && mSeries[1]) {
              const sName = cleanString(mSeries[1]);
              const vName = mVol ? cleanString(mVol[1]) : "";
              if (vName) {
                // Có ngoặc đơn (n), (1), (6)... -> "Tên truyện (n)" (KHÔNG CÓ "-")
                if (/^[（\(].+[）\)]$/.test(vName)) {
                  return `${sName} ${vName}`;
                }
                // Không có ngoặc mới dùng " - "
                return `${sName} - ${vName}`;
              }
              return sName;
            }
          } catch (e) {}
        }

        // 2. Happy Comic: Bốc đích danh số tập ở cuối tham số book= (trị dứt điểm số 94)
        if (storeUrl.includes('happycomic.jp') || colophonUrl.includes('happycomic.jp')) {
          try {
            // Khóa chặt tham số book= hoặc id= ở colophon: ...-003 -> lấy đúng 3
            const mBookVol = storeUrl.match(/book=[^&]*-0*(\d+)/i) || colophonUrl.match(/id=[^&]*-0*(\d+)/i);
            const volNum = mBookVol ? parseInt(mBookVol[1], 10) : null;

            const targetUrl = storeUrl || colophonUrl;
            const buf = await Utils.fetchBuffer(targetUrl);
            const html = new TextDecoder().decode(buf);
            const mHappy = html.match(/class=["'][^"']*(?:volume-text|book-thumb-title-box)[^"']*["']>([^<]+)<\//i);

            if (mHappy && mHappy[1]) {
              let sTitle = cleanString(mHappy[1]).replace(/【(?:期間限定|無料).*?】/gi, '').replace(/\s*[0-9０-９]+$/, '').trim();
              if (volNum) return `${sTitle} - ${volNum}`;
              return sTitle;
            }
          } catch (e) {}
        }

        // 3. Access Books: Ưu tiên bóc ID tập thật từ colophon (12542854 -> Tập 7)
        if (storeUrl.includes('accessbooks.jp') || colophonUrl.includes('accessbooks.jp')) {
          try {
            // Lấy đúng mã ID của tập đang đọc từ colophonUrl (ví dụ tập 7 là 12542854)
            const realVolId = colophonUrl.match(/id=(\d+)/i)?.[1] || storeUrl.match(/content\/(\d+)/i)?.[1];
            const targetUrl = realVolId ? `https://s.accessbooks.jp/content/${realVolId}.html` : storeUrl;

            const buf = await Utils.fetchBuffer(targetUrl);
            const html = new TextDecoder().decode(buf);
            const doc = new DOMParser().parseFromString(html, "text/html");

            // Bóc tên từ title trang sản phẩm của đúng tập đó
            let fullTitle = doc.title || "";
            fullTitle = cleanString(fullTitle.replace(/\s*[-|｜]\s*アクセスBOOKS.*$/i, '').replace(/[\(（][^()（）]*(?:著|作|画|漫画|原作|オレコ)[^()（）]*[\)）]$/i, ''));

            // Nếu title thiếu số tập, tìm thẻ link chứa đúng mã ID này trong trang
            if (realVolId && (!/\d/.test(fullTitle) || fullTitle.includes('ポイント'))) {
              const linkText = doc.querySelector(`a[href*="${realVolId}"]`)?.textContent?.trim();
              if (linkText) fullTitle = cleanString(linkText);
            }

            if (fullTitle && fullTitle.length > 2 && !fullTitle.includes('ポイント')) {
              const mVol = fullTitle.match(/^(.*?)\s+([0-9０-９]+)$/);
              if (mVol) return `${cleanString(mVol[1])} - ${mVol[2]}`;
              return fullTitle;
            }
          } catch (e) {}
        }

        // 4. ComicFesta: Bốc tên truyện từ thẻ <h1> và số tập từ link (trị dứt điểm chữ コミックフェスタ)
        if (storeUrl.includes('comic.iowl.jp') || location.hostname.includes('iowl.jp')) {
          try {
            const targetUrl = storeUrl.includes('titles') ? storeUrl : (colophonUrl.includes('titles') ? colophonUrl : null);
            if (targetUrl) {
              const buf = await Utils.fetchBuffer(targetUrl);
              const html = new TextDecoder().decode(buf);
              const doc = new DOMParser().parseFromString(html, "text/html");

              // Bốc đúng tên truyện từ H1 theo class trong ảnh của bạn
              const sTitle = cleanString(doc.querySelector('.QsYa6q_titleName, h1')?.textContent?.trim() || "");

              // Lấy mã volume từ colophon: /volumes/1267539/colophon -> 1267539
              const volId = colophonUrl.match(/volumes\/(\d+)/i)?.[1] || "";

              // Tìm đúng thẻ chapterBox chứa volId để lấy tên tập trong _6OYW3W_name
              let volName = "";
              if (volId) {
                const targetBox = Array.from(doc.querySelectorAll('li[class*="chapterBox"], div[class*="chapterBox"]'))
                                       .find(box => box.innerHTML.includes(volId));
                if (targetBox) {
                  volName = cleanString(targetBox.querySelector('div[class*="_name"]')?.textContent?.trim() || "");
                }
              }

              if (!volName) {
                volName = cleanString(doc.querySelector('div[class*="_name"]')?.textContent?.trim() || "");
              }

              if (sTitle && volName) {
                return `${sTitle} - ${volName}`;
              }
              if (sTitle) return sTitle;
            }
          } catch (e) {}
        }
      }
      
      // -------------------------------------------------------------
      // BƯỚC B: KIỂM TRA TIÊU ĐỀ TRÊN DOCUMENT / IFRAME URL
      // -------------------------------------------------------------
      let rawTitle = manifestTitle || DOC.title || "";
      const isCsrGeneric = !rawTitle || /CLIP\s*STUDIO\s*READER|コミックフェスタ|ComicFesta/i.test(rawTitle);

      if (!isCsrGeneric) {
        rawTitle = rawTitle.replace(/\s*[-|｜]\s*(?:コミックフェスタ|ファイアCROSS|白泉社|Clip\s*Studio\s*Reader|DREノベルス|DREコミックス.*|ドリコムメディア|公式サイト).*$/i, '').trim();
        rawTitle = cleanString(rawTitle);

        // Đảo vế cho Firecross nếu vế 1 là số chap
        const isChap = str => /^(?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\.]+\s*(?:話|巻|章|節|部|エピソード|分冊版|単話)/i.test(str);
        const parts = rawTitle.split(/\s*[-－–—]\s*/);

        let baseSeries = rawTitle;
        if (parts.length >= 2) {
          const s = cleanString(parts[0]);
          const e = cleanString(parts[1]);
          baseSeries = isChap(s) ? `${e} - ${s}` : `${s} - ${e}`;
        }

        // TỰ ĐỘNG GHÉP MỤC LỤC CHO COMIST & ITSUDEMO:
        // Nếu tiêu đề chưa có chữ "第...話" mà trong Mục lục lại có mục "第...話" -> Ghép thêm vào đuôi!
        if (validTocItems.length > 0 && !/第\s*[0-9０-９]+/.test(baseSeries)) {
          const chapItem = validTocItems.find(t => /第\s*[0-9０-９]+/.test(t));
          if (chapItem) {
            // Bốc chính xác từ chữ "第...話" (bỏ qua toàn bộ phần tên truyện trùng lặp phía trước)
            const mChapOnly = chapItem.match(/((?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\.]+\s*(?:話|回|巻|章|節|部|エピソード|分冊版|単話).*)$/i);
            const cleanChap = mChapOnly ? cleanString(mChapOnly[1]) : cleanString(chapItem.replace(/^[-－–—\s]+/, ''));
            if (cleanChap) return `${baseSeries} - ${cleanChap}`;
          }
        }

        if (baseSeries && baseSeries.length > 3) return baseSeries;
      }

      // -------------------------------------------------------------
      // BƯỚC C: NẾU TIÊU ĐỀ LÀ GENERIC -> DÙNG MỤC LỤC LÀM GỐC
      // -------------------------------------------------------------
      if (validTocItems.length > 0 && validTocItems[0]) {
        let cleanToc = validTocItems[0]
          .replace(/\s*[（\(［\[]?(?:表紙|Cover(?:\s*Page)?|カバー)[）\)］\]]?\s*$/gi, '')
          .replace(/[［\[]ばら売り[］\]]/gi, '')
          .replace(/【単話版】/gi, '')
          .replace(/サンプル/gi, '')
          .trim();

        cleanToc = cleanToc.replace(/（([0-9０-９]+)）/g, '($1)').replace(/\s{2,}/g, ' ');

        const mChap = cleanToc.match(/^(.*?)[ \t\u3000]+(\([0-9０-９]+\)|(?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\.]+\s*(?:話|巻|章|節|部|エピソード|分冊版|単話)?.*)$/i);
        if (mChap) {
          if (/^\([0-9０-９]+\)$/.test(mChap[2])) {
            return `${cleanString(mChap[1])} ${cleanString(mChap[2])}`;
          }
          return `${cleanString(mChap[1])} - ${cleanString(mChap[2])}`;
        }
        if (cleanToc && cleanToc.length > 1) return cleanToc;
      }

      // -------------------------------------------------------------
      // BƯỚC D: KÉO HTML TRANG SẢN PHẨM (GALCOMI, RAKURAKU, HANDY, HAPPY, HONTO)
      // -------------------------------------------------------------
      let targetProductUrl = null;
      const colophon = sp.get('colophon') || "";

      // 1. Nhận diện MediaDo (Galcomi, Rakuraku, Comist, Itsudemo)
      if (storeUrl.includes('/sd/page/permit/') || storeUrl.includes('/sd/page/title/')) {
        targetProductUrl = storeUrl;
      }
      // 2. Nhận diện Handy Comic (sp.handycomic.jp)
      else if (storeUrl.includes('handycomic.jp/product/')) {
        targetProductUrl = storeUrl;
      }
      // 3. Nhận diện Happy Comic (happycomic.jp)
      else if (storeUrl.includes('happycomic.jp') || colophon.includes('happycomic.jp')) {
        targetProductUrl = storeUrl || colophon;
      }
      // 4. Nhận diện Honto
      else {
        const mHonto = colophon.match(/itemId=(\d+)/i) || storeUrl.match(/itemId=(\d+)/i);
        if (mHonto && mHonto[1]) targetProductUrl = `https://honto.jp/ebook/pd_${mHonto[1]}.html`;
        else if (storeUrl.includes('nadeshiko-shoten.jp') || storeUrl.includes('accessbooks.jp') || storeUrl.includes('comic.iowl.jp')) {
          targetProductUrl = storeUrl;
        }
      }

      if (targetProductUrl && Utils?.fetchBuffer) {
        try {
          const buf = await Utils.fetchBuffer(targetProductUrl);
          const html = new TextDecoder().decode(buf);

          // Trường hợp 1: Sàn MediaDo (Galcomi & Rakuraku Comic) -> Bóc content-title-name + content-permit-name
          if (html.includes('content-title-name')) {
            const mSeries = html.match(/class=["'][^"']*content-title-name[^"']*["']>([^<]+)<\//i);
            const mVol = html.match(/class=["'][^"']*content-permit-name[^"']*["']>([^<]+)<\//i);
            if (mSeries && mSeries[1]) {
              const sName = cleanString(mSeries[1]);
              const vName = mVol ? cleanString(mVol[1]) : "";
              if (vName) {
                if (/^\([0-9０-９]+\)$/.test(vName)) return `${sName} ${vName}`;
                return `${sName} - ${vName}`;
              }
              return sName;
            }
          }

          // Trường hợp 2: Handy Comic (sp.handycomic.jp) -> Bóc product-title__txt + product-title__title-vol-name
          if (html.includes('product-title__txt')) {
            const mSeries = html.match(/class=["'][^"']*product-title__txt[^"']*["']>([^<]+)<\//i);
            const mVol = html.match(/class=["'][^"']*product-title__title-vol-name[^"']*["']>([^<]+)<\//i);
            if (mSeries && mSeries[1]) {
              const sName = cleanString(mSeries[1]);
              const vName = mVol ? cleanString(mVol[1]) : "";
              if (vName) return `${sName} - ${vName}`;
              return sName;
            }
          }

          // Trường hợp 3: Happy Comic (happycomic.jp) -> Bóc volume-text
          if (html.includes('volume-text') || html.includes('book-thumb-title-box')) {
            const mHappy = html.match(/class=["'][^"']*(?:volume-text|book-thumb-title-box)[^"']*["']>([^<]+)<\//i);
            if (mHappy && mHappy[1]) {
              let hTitle = cleanString(mHappy[1]).replace(/【(?:期間限定|無料).*?】/gi, '').trim();
              const mVol = hTitle.match(/^(.*?)\s+([0-9０-９]+)$/);
              if (mVol) return `${cleanString(mVol[1])} - ${mVol[2]}`;
              return hTitle;
            }
          }

          // Trường hợp 4: Thẻ <title> chung (Honto, Nadeshiko, AccessBooks, ComicFesta)
          const mTitle = html.match(/<title>([^<]+)<\/title>/i);
          if (mTitle && mTitle[1]) {
            let fetchedTitle = mTitle[1]
              .replace(/[\(（](?:漫画|コミック|ラノベ|書籍|小説|文庫)[\)）].*$/i, '')
              .replace(/の電子書籍.*$/i, '')
              .replace(/[|｜]\s*新刊.*$/i, '')
              .replace(/\s*[-|｜]\s*(?:なでしこ書店|スゴコミック|アクセスBOOKS|honto本の通販ストア|honto電子書籍ストア|honto.*|電子書籍|無料漫画|コミックフェスタ|ComicFesta).*$/gi, '')
              .replace(/【電子(?:単行本|書籍|限定|版|特典).*?】/gi, '')
              .replace(/[\(（][^()（）]*(?:著|作|画|漫画|原作|オレコ)[^()（）]*[\)）]$/i, '')
              .trim();

            fetchedTitle = fetchedTitle.replace(/（([0-9０-９]+)）/g, '($1)').replace(/([^\s])(\([0-9０-９]+\))/g, '$1 $2').trim();

            const mVolChap = fetchedTitle.match(/^(.*?)\s+((?:第\s*)?[0-9０-９IVXLCDMivxlcdm一二三四五六七八九十百千万\.]+\s*(?:話|回|巻|章|節|部|エピソード|分冊版|単話).*)$/i);
            if (mVolChap && !/^\([0-9０-９]+\)$/.test(mVolChap[2])) {
              return `${cleanString(mVolChap[1])} - ${cleanString(mVolChap[2])}`;
            }
            fetchedTitle = cleanString(fetchedTitle);
            if (fetchedTitle && fetchedTitle.length > 2) return fetchedTitle;
          }
        } catch (e) {}
      }

      // -------------------------------------------------------------
      // BƯỚC E: PHAO CỨU SINH CUỐI CÙNG
      // -------------------------------------------------------------
      const mColo = colophon.match(/(?:product_)?id=([^\/?#&]+)/i) 
                 || storeUrl.match(/(?:product_)?id=([^\/?#&]+)/i)
                 || colophon.match(/itemId=([^\/?#&]+)/i);
      const bookId = mColo ? mColo[1] : (storeUrl.match(/\/([^\/?#]+)(?:\.html|\.php)?$/)?.[1] || getEpisodeId());

      const theme = typeof resolveSiteTheme === 'function' ? resolveSiteTheme() : { name: "ClipStudio" };
      return `${theme.name} - ${cleanString(bookId)}`;

    } catch (e) {}

    return `ClipStudio_${getEpisodeId()}`;
  }

  /* =========================================================================
   * 3. BÓC TÁCH THÔNG SỐ VIEWER (TẢI MẠNG 1 LẦN DUY NHẤT)
   * ========================================================================= */
  async function fetchViewerNetworkContext() {
    const urlParams = new URLSearchParams(WIN.location.search);
    const paramInput = DOC.querySelector('input[name="param"]');
    const cgiInput = DOC.querySelector('input[name="cgi"]');

    const rawParam = paramInput ? paramInput.value.trim() : (urlParams.get('param') || '').trim();
    const rawCgi = cgiInput ? cgiInput.value.trim() : (urlParams.get('cgi') || '').trim();
    if (!rawParam || !rawCgi) return null;

    let baseUrl = rawCgi;
    if (baseUrl.startsWith('/')) baseUrl = `${location.origin}${baseUrl}`;
    let param = encodeURIComponent(rawParam);

    // Tự động nhận diện vm: 2 (Webtoon), 1 (Handy Comic), 4 (Manga ngang)
    let vm = urlParams.get('vm');
    const isVertical = urlParams.get('viewer_type') === 'vertical' || urlParams.has('webtoon_margin');
    const isHandy = baseUrl.includes('handycomic');
    if (!vm) vm = isVertical ? '2' : (isHandy ? '1' : '4');

    const Utils = WIN.MangaUtils || window.MangaUtils;
    const Tools = WIN.ClipStudioTools || window.ClipStudioTools;

    try {
      const handshakeUrl = `${baseUrl}?mode=999&file=&reqtype=1&vm=${vm}&param=${param}&time=${Date.now()}`;
      const hsBuf = await Utils.fetchBuffer(handshakeUrl);
      const hsText = new TextDecoder().decode(hsBuf);
      if (hsText.includes('<Code>1000</Code>')) {
        const mToken = hsText.match(/<Content>([^<]+)<\/Content>/i);
        if (mToken && mToken[1]) param = encodeURIComponent(mToken[1].trim());
      }
    } catch (e) {}

    let faceTotalPages = null;
    let gridCols = 4, gridRows = 4;
    try {
      const manifestFile = urlParams.get('file') || 'face.xml';
      const manifestUrl = `${baseUrl}?mode=7&file=${manifestFile}&reqtype=0&vm=${vm}&param=${param}&time=${Date.now()}`;
      const buf = await Utils.fetchBuffer(manifestUrl);
      const faceConfig = Tools.parseFaceXml(new TextDecoder().decode(buf));
      if (faceConfig.totalPages) faceTotalPages = faceConfig.totalPages;
      if (faceConfig.cols) gridCols = faceConfig.cols;
      if (faceConfig.rows) gridRows = faceConfig.rows;
    } catch (e) {}

    return { baseUrl, param, vm, isVertical, faceTotalPages, gridCols, gridRows };
  }

  function getDomPageCount() {
    const nombreEl = DOC.getElementById("menu_nombre_total")
                  || DOC.getElementById("paging_slider_nombre_total")
                  || DOC.querySelector('[class*="nombre_total"], .total-pages');
    if (nombreEl) {
      const parsed = parseInt(nombreEl.textContent.trim(), 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return null;
  }

  /* =========================================================================
   * 4. GIẢI MÃ MA TRẬN TRÊN CANVAS (BẢO TỒN VIỀN DƯ 1:1)
   * ========================================================================= */
  async function descramblePage(pageIndex, ctxData, isJpg) {
    const Utils = WIN.MangaUtils || window.MangaUtils;
    const Tools = WIN.ClipStudioTools || window.ClipStudioTools;
    const { baseUrl, param, vm, gridCols, gridRows } = ctxData;

    const pageStr = pageIndex.toString().padStart(4, '0');

    // 1. Kéo XML tọa độ
    const xmlUrl = `${baseUrl}?mode=8&file=${pageStr}.xml&reqtype=0&vm=${vm}&param=${param}&time=${Date.now()}`;
    const xmlBuf = await Utils.fetchBuffer(xmlUrl);
    const pattern = Tools.parseScrambleXml(new TextDecoder().decode(xmlBuf));

    // 2. Kéo ảnh nhị phân .bin (Handy Comic dùng mode=3, các bên khác dùng mode=1)
    const modeImg = baseUrl.includes('handycomic') ? 3 : 1;
    const imgUrl = `${baseUrl}?mode=${modeImg}&file=${pageStr}_0000.bin&reqtype=0&vm=${vm}&param=${param}&time=${Date.now()}`;
    const rawBin = await Utils.fetchBuffer(imgUrl);

    // 3. Giải mã XOR 1-byte
    const cleanBytes = Tools.decryptBinary(rawBin);
    const mime = Utils.detectMimeType(cleanBytes.buffer);

    // 4. Tải ảnh vào RAM
    const img = await Utils.loadImage(cleanBytes.buffer, mime);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;

    // 5. Tính tọa độ cắt Celsys
    const geom = Tools.calculateCoords(w, h, pattern, gridCols, gridRows);

    // 6. Dựng Canvas Pixel-Perfect
    const canvas = DOC.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = false;
    ctx.mozImageSmoothingEnabled = false;
    ctx.webkitImageSmoothingEnabled = false;
    ctx.msImageSmoothingEnabled = false;

    // Vẽ lót nền 1:1 bảo tồn nét vẽ viền ngoài Untouched Remainder!
    ctx.drawImage(img, 0, 0);

    // Dán đè các ô hoán vị
    for (const c of geom.coords) {
      ctx.drawImage(
        img,
        c.srcX, c.srcY, c.width, c.height,
        c.destX, c.destY, c.width, c.height
      );
    }

    const outMime = isJpg ? 'image/jpeg' : 'image/png';
    const outExt = isJpg ? 'jpg' : 'png';
    const blob = await new Promise(r => canvas.toBlob(r, outMime, CONFIG.JPEG_QUALITY));

    canvas.width = 0;
    canvas.height = 0;

    return {
      fileName: `${pageIndex + 1}.${outExt}`,
      data: new Uint8Array(await blob.arrayBuffer())
    };
  }

  /* =========================================================================
   * 5. TIẾN TRÌNH TẢI CHÍNH (6 LUỒNG TRONG RAM)
   * ========================================================================= */
  async function startDownload() {
    if (state.running) return;
    const ui = getUI();

    state.running = true;
    if (ui) ui.setBusy(true);

    try {
      if (ui) ui.updateProgress({ completed: 0, total: 0, status: "Đang tải..." });

      let data = state.chapterData;
      if (!data || !data.totalPages) {
        throw new Error("Không lấy được dữ liệu chương truyện.");
      }

      const totalPages = data.totalPages;
      const useJpeg = Boolean(state.convertJpeg);

      const ZipClass = window.PureZipWriter || globalThis.PureZipWriter;
      const Utils = window.MangaUtils || globalThis.MangaUtils;
      const zip = new ZipClass();

      // File txt định danh theo Golden Rules
      const epId = getEpisodeId();
      zip.addFile(`${epId}.txt`, new Uint8Array(0));

      if (ui) ui.updateProgress({ completed: 0, total: totalPages, status: "Đang tải..." });

      // 6 luồng tải song song Zero-Copy trong RAM
      const tasks = Array.from({ length: totalPages }, (_, idx) => () => descramblePage(idx, data, useJpeg));
      const results = await Utils.runParallelQueue(tasks, CONFIG.MAX_CONCURRENT, (completed, total) => {
        if (ui) ui.updateProgress({ completed, total, status: "Đang tải..." });
      });

      let savedCount = 0;
      for (const res of results) {
        if (res?.data) {
          zip.addFile(res.fileName, res.data);
          savedCount++;
        }
      }

      if (savedCount === 0) {
        throw new Error("Giải mã thất bại toàn bộ các trang ảnh! Hãy kiểm tra lại kết nối.");
      }

      if (ui) ui.updateProgress({ completed: totalPages, total: totalPages, status: "Đang đóng gói file ZIP..." });
      await sleep(50);

      // Đặt tên ZIP chuẩn: [Tên Truyện] - [Tên Chap].zip
      const titleName = await getCleanTitle();
      const finalFileName = `${titleName}.zip`;
      zip.download(finalFileName);

      if (ui) {
        ui.updateProgress({ completed: totalPages, total: totalPages, status: "Hoàn tất." });
        ui.setBusy(false);
      }
    } catch (err) {
      if (ui) ui.updateProgress({ status: "Lỗi: " + (err?.message || err) });
      console.error("[clipstudio-dl] Download error:", err);
    } finally {
      state.running = false;
    }
  }

  /* =========================================================================
   * 6. KHỞI CHẠY & THEO DÕI ĐIỀU HƯỚNG SPA
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

    try {
      // 1. Tải mạng 1 lần duy nhất
      let netCtx = null;
      for (let r = 0; r < 15; r++) {
        netCtx = await fetchViewerNetworkContext();
        if (netCtx) break;
        await sleep(100);
      }
      if (!netCtx) throw new Error("Không thể kết nối máy chủ reader.");

      // 2. Chờ DOM nạp số trang đọc thử (polling trong RAM, không tốn mạng)
      let totalPages = null;
      let domPages = null;

      // Nếu chưa có, kiên nhẫn đợi DOM nạp số trang đọc thử trong 800ms
      if (!domPages && !netCtx.isVertical) {
        for (let w = 0; w < 10; w++) {
          domPages = getDomPageCount();
          if (domPages) break;
          await sleep(80);
        }
      }

      const facePages = netCtx.faceTotalPages;
      if (domPages && facePages) {
        totalPages = Math.min(domPages, facePages); // Lấy số nhỏ hơn: Math.min(9, 28) = 9!
      } else {
        totalPages = domPages || facePages;
      }

      if (!totalPages) throw new Error("Chương truyện bị khóa hoặc chưa mở.");

      state.chapterData = { ...netCtx, totalPages };

      if (ui) {
        ui.updateProgress({
          completed: 0,
          total: totalPages,
          status: "Sẵn sàng."
        });
        ui.setBusy(false);
      }
    } catch (err) {
      console.error("[clipstudio-dl] Boot error:", err);
      if (ui) {
        ui.updateProgress({ status: "Lỗi: " + (err?.message || "Không thể tải trang.") });
      }
    }
  }

  const watchRoute = window.initRouteWatcher || globalThis.initRouteWatcher;
  if (typeof watchRoute === "function") {
    watchRoute((newUrl) => {
      if (!isEpisodeUrl()) {
        const ui = getUI();
        if (ui?.panel) ui.panel.style.display = "none";
        state.chapterData = null;
        state.lastEpisodeKey = "";
        state.lastUrl = "";
        state.running = false;
        return;
      }

      const currentKey = getEpisodeId();
      if (state.lastEpisodeKey && state.lastEpisodeKey === currentKey) return;

      state.lastUrl = newUrl;
      state.lastEpisodeKey = currentKey;
      state.chapterData = null;
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