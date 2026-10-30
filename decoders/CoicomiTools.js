// decoders/CoicomiTools.js
(function(global) {
  'use strict';

  const CoicomiTools = (() => {
    // 1. Mảng hoán vị mặc định của DISEL / Coicomi Engine (8 cặp Cột & 8 cặp Hàng)
    const DEFAULT_T_ARRAY = [
      [[0, 11], [14, 9], [6, 8], [15, 7], [5, 4], [12, 1], [10, 2], [3, 13]], // tArray[0]: Columns
      [[0, 15], [5, 14], [4, 12], [7, 11], [10, 6], [9, 2], [8, 1], [3, 13]]  // tArray[1]: Rows
    ];

    /**
     * 2. Bóc tách hạt giống dịch chuyển k từ Query String 'ph' trên URL CDN
     * Ví dụ:
     * - cover.jpg_zip_100 -> 'cover' -> ký tự cuối 'r' -> k = 0
     * - i-001.jpg_zip_100 -> 'i-001' -> ký tự cuối '1' -> k = 1
     * - i-00b.jpg_zip_100 -> 'i-00b' -> ký tự cuối 'b' -> k = 11
     */
    function extractK(url) {
      if (!url || typeof url !== 'string') return 0;
      try {
        let ph = '';
        if (url.includes('?')) {
          const match = url.match(/[?&]ph=([^&]+)/);
          ph = match ? decodeURIComponent(match[1]) : '';
        } else {
          ph = url;
        }

        let clean = ph.split('/').pop() || '';
        clean = clean.replace(/_jpg_zip_(100|75)/gi, '')
                     .replace(/\.jpg_zip_(100|75)/gi, '');

        if (!clean.length) return 0;
        const lastChar = clean[clean.length - 1];
        const parsedHex = parseInt(lastChar, 16);
        return isNaN(parsedHex) ? 0 : parsedHex;
      } catch (e) {
        return 0;
      }
    }

    /**
     * 3. Giải mã ma trận 256 ô siêu vi mô (16x16) & Gọt rãnh đệm Gutter Pixel-Perfect
     * @param {CanvasImageSource} img - Đối tượng ảnh nguồn (ImageBitmap / HTMLImageElement)
     * @param {string} url - Link ảnh trên CDN chứa tham số ?ph= để bóc tách k
     * @param {object} options - Cấu hình: { coverWidth, coverHeight, gutter, tArray }
     */
    function descrambleCoicomiCanvas(img, url, options = {}) {
      const rawW = img.naturalWidth || img.width;
      const rawH = img.naturalHeight || img.height;

      const k = extractK(url);
      const tArray = options.tArray || DEFAULT_T_ARRAY;
      const l = tArray[0]; // Columns (8 pairs)
      const m = tArray[1]; // Rows (8 pairs)

      // Kích thước ô thô trên ảnh raw CDN (ví dụ 1584 / 16 = 99px, 2176 / 16 = 136px)
      const tileW = Math.floor(rawW / 16);
      const tileH = Math.floor(rawH / 16);

      // --- BƯỚC 1: Hoán vị Hàng (Row Swaps) qua tArray[1] ---
      const p = document.createElement('canvas');
      p.width = rawW; p.height = rawH;
      const ctxP = p.getContext('2d', { alpha: false });
      ctxP.imageSmoothingEnabled = false;

      for (let w = 0; w < m.length; w++) {
        const pair = m[w];
        const v = (pair[0] + k) % 16;
        const q = (pair[1] + k) % 16;
        ctxP.drawImage(img, 0, v * tileH, tileW * 16, tileH, 0, q * tileH, tileW * 16, tileH);
        ctxP.drawImage(img, 0, q * tileH, tileW * 16, tileH, 0, v * tileH, tileW * 16, tileH);
      }

      // --- BƯỚC 2: Hoán vị Cột (Col Swaps) qua tArray[0] ---
      const t = document.createElement('canvas');
      t.width = rawW; t.height = rawH;
      const ctxT = t.getContext('2d', { alpha: false });
      ctxT.imageSmoothingEnabled = false;

      for (let w = 0; w < l.length; w++) {
        const pair = l[w];
        const v = (pair[0] + k) % 16;
        const q = (pair[1] + k) % 16;
        ctxT.drawImage(p, v * tileW, 0, tileW, tileH * 16, q * tileW, 0, tileW, tileH * 16);
        ctxT.drawImage(p, q * tileW, 0, tileW, tileH * 16, v * tileW, 0, tileW, tileH * 16);
      }

      // --- BƯỚC 3: Hoán vị khối vĩ mô 2x2 trong từng cụm 4x4 ---
      const macro = document.createElement('canvas');
      macro.width = rawW; macro.height = rawH;
      const ctxMacro = macro.getContext('2d', { alpha: false });
      ctxMacro.imageSmoothingEnabled = false;
      ctxMacro.drawImage(t, 0, 0);

      for (let col = 0; col < 16; col += 4) {
        for (let row = 0; row < 16; row += 4) {
          if ((col + 2) * tileW < rawW && (row + 2) * tileH < rawH) {
            ctxMacro.drawImage(
              t,
              col * tileW, row * tileH, tileW * 2, tileH * 2,
              (col + 2) * tileW, (row + 2) * tileH, tileW * 2, tileH * 2
            );
            ctxMacro.drawImage(
              t,
              (col + 2) * tileW, (row + 2) * tileH, tileW * 2, tileH * 2,
              col * tileW, row * tileH, tileW * 2, tileH * 2
            );
          }
        }
      }

      // --- BƯỚC 4: Gọt rãnh đệm Gutter (u = 4px ở cả 4 cạnh mỗi ô) ---
      const u = options.gutter !== undefined ? options.gutter : 4;
      const innerW = tileW - u * 2; // Ví dụ: 99 - 8 = 91px
      const innerH = tileH - u * 2; // Ví dụ: 136 - 8 = 128px
      const netW = innerW * 16;     // 16 * 91 = 1456px
      const netH = innerH * 16;     // 16 * 128 = 2048px

      const trimmed = document.createElement('canvas');
      trimmed.width = netW; trimmed.height = netH;
      const ctxTrim = trimmed.getContext('2d', { alpha: false });
      ctxTrim.imageSmoothingEnabled = false;

      for (let row = 0; row < 16; row++) {
        for (let col = 0; col < 16; col++) {
          ctxTrim.drawImage(
            macro,
            col * tileW + u, row * tileH + u, innerW, innerH,
            col * innerW,     row * innerH,     innerW, innerH
          );
        }
      }

      // --- BƯỚC 5: Cắt gọt theo khổ in chuẩn (coverWidth x coverHeight) ---
      let finalW = netW;
      let finalH = netH;

      if (options.coverWidth && Math.abs(netW - options.coverWidth) <= 32) {
        finalW = options.coverWidth; // 1444px (gọt 12px mép phải ngoài cùng)
      }
      if (options.coverHeight && Math.abs(netH - options.coverHeight) <= 32) {
        finalH = options.coverHeight; // 2048px
      }

      // 1. sharpCanvas (Bản xuất file sạch 100% không suy hao)
      const sharpCanvas = document.createElement('canvas');
      sharpCanvas.width = finalW; sharpCanvas.height = finalH;
      const sCtx = sharpCanvas.getContext('2d', { alpha: false });
      sCtx.imageSmoothingEnabled = false;
      sCtx.mozImageSmoothingEnabled = false;
      sCtx.webkitImageSmoothingEnabled = false;
      sCtx.msImageSmoothingEnabled = false;

      // Dán trimmed lên sharpCanvas tại (0,0) -> 12px dư mép phải tự động rớt ra ngoài
      sCtx.drawImage(trimmed, 0, 0);

      // 2. rawCanvas (Bản ảnh xáo trộn nguyên bản từ CDN)
      const rawCanvas = document.createElement('canvas');
      rawCanvas.width = rawW; rawCanvas.height = rawH;
      const rCtx = rawCanvas.getContext('2d', { alpha: false });
      rCtx.imageSmoothingEnabled = false;
      rCtx.drawImage(img, 0, 0);

      // 3. visualCanvas (Bản Soi Live: Viền Cyan toàn ảnh + Lộ lớp nền Hồng ở các rãnh đệm gọt bỏ)
      const visualCanvas = document.createElement('canvas');
      visualCanvas.width = rawW; visualCanvas.height = rawH;
      const vCtx = visualCanvas.getContext('2d', { alpha: false });
      vCtx.imageSmoothingEnabled = false;
      vCtx.fillStyle = '#ff007f';
      vCtx.fillRect(0, 0, rawW, rawH);
      vCtx.drawImage(sharpCanvas, 0, 0);

      // Viền Cyan 4px nét liền bao quanh toàn bộ khung container rawW x rawH
      vCtx.strokeStyle = '#00ffff';
      vCtx.lineWidth = 4;
      vCtx.strokeRect(0, 0, rawW, rawH);

      const padW = rawW - finalW;
      const padH = rawH - finalH;
      const dummyText = (padW > 0 || padH > 0)
        ? `Vùng đệm bỏ: Dư ${padW}px phải, ${padH}px đáy (Đã gọt sạch)`
        : `Khớp 100% không có viền thừa`;

      return {
        sharpCanvas,
        visualCanvas,
        rawCanvas,
        rawW,
        rawH,
        gridW: finalW,
        gridH: finalH,
        dummyText,
        isScrambled: true,
        k
      };
    }

    return {
      extractK,
      DEFAULT_T_ARRAY,
      descrambleCoicomiCanvas
    };
  })();

  (typeof globalThis !== 'undefined' ? globalThis : window).CoicomiTools = CoicomiTools;
})(typeof window !== 'undefined' ? window : this);