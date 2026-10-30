// decoders/MangaZenkanTools.js
(function(global) {
  'use strict';

  const MangaZenkanTools = (() => {
    /**
     * Giải mã ma trận MediaDo Pubridge của MangaZenkan
     * Khôi phục từ hàm sf trong bundle index-D-7nfQi-.js
     * @param {CanvasImageSource} img - Ảnh nguồn raw CDN
     * @param {string|Array} shuffleMap - Chuỗi JSON hoặc mảng tọa độ đích [[dx, dy, ...], ...]
     * @param {number} blockLen - Kích thước khối (BLOCKLEN, mặc định 128px)
     */
    function descrambleMangaZenkanCanvas(img, shuffleMap, blockLen = 128) {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      const i = Number(blockLen) || 128;

      const cols = Math.floor(w / i); // s trong web code (6 cột)
      const rows = Math.floor(h / i); // c trong web code (8 hàng)
      const gridW = cols * i;
      const gridH = rows * i;
      const dummyW = w - gridW;
      const dummyH = h - gridH; // 64px đáy

      let map = shuffleMap;
      if (typeof map === 'string') {
        try { map = JSON.parse(map); } catch(e) { map = []; }
      }
      if (!Array.isArray(map)) map = [];

      // 1. sharpCanvas (Bản xuất file sạch 100% Lossless)
      const sharpCanvas = document.createElement('canvas');
      sharpCanvas.width = w;
      sharpCanvas.height = h;
      const sCtx = sharpCanvas.getContext('2d', { alpha: false });
      sCtx.imageSmoothingEnabled = false;
      sCtx.mozImageSmoothingEnabled = false;
      sCtx.webkitImageSmoothingEnabled = false;
      sCtx.msImageSmoothingEnabled = false;

      // Bước 1: Vẽ dải mép phải nguyên bản (nếu có phần dư)
      if (dummyW > 0) {
        sCtx.drawImage(img, gridW, 0, dummyW, h, gridW, 0, dummyW, h);
      }

      // Bước 2: Hoán vị ô vuông theo đúng thứ tự web: Cột ngoài (n), Hàng trong (r)
      let l = 0;
      for (let n = 0; n < cols; n++) {
        for (let r = 0; r < rows && l < map.length; r++) {
          const dx = map[l][0];
          const dy = map[l][1];
          const sx = n * i;
          const sy = r * i;

          sCtx.drawImage(img, sx, sy, i, i, dx, dy, i, i);
          l++;
        }
      }

      // Bước 3: Vẽ dải mép đáy nguyên bản (dummyH: 64px)
      if (dummyH > 0) {
        sCtx.drawImage(img, 0, gridH, w, dummyH, 0, gridH, w, dummyH);
      }

      // 2. rawCanvas (Bản raw xáo trộn từ CDN)
      const rawCanvas = document.createElement('canvas');
      rawCanvas.width = w; rawCanvas.height = h;
      const rCtx = rawCanvas.getContext('2d', { alpha: false });
      rCtx.imageSmoothingEnabled = false;
      rCtx.drawImage(img, 0, 0);

      // 3. visualCanvas (Soi Live: Viền Cyan toàn ảnh + Khung Hồng ma trận 6x8)
      const visualCanvas = document.createElement('canvas');
      visualCanvas.width = w; visualCanvas.height = h;
      const vCtx = visualCanvas.getContext('2d', { alpha: false });
      vCtx.imageSmoothingEnabled = false;
      vCtx.drawImage(sharpCanvas, 0, 0);

      // Khung Hồng nét liền bao quanh vùng ma trận (nếu có dải dư đáy 64px)
      if (dummyW > 0 || dummyH > 0) {
        vCtx.strokeStyle = '#ff007f';
        vCtx.lineWidth = 2;
        vCtx.strokeRect(0, 0, gridW, gridH);
      }
      // Viền Cyan nét liền 4px bao quanh toàn bộ tranh
      vCtx.strokeStyle = '#00ffff';
      vCtx.lineWidth = 4;
      vCtx.strokeRect(0, 0, w, h);

      const dummyText = (dummyW > 0 || dummyH > 0)
        ? `Mép giữ nguyên: ${dummyW}px phải, ${dummyH}px đáy (Không xáo trộn)`
        : `Khớp ma trận 100% (Không có phần dư)`;

      return {
        sharpCanvas,
        visualCanvas,
        rawCanvas,
        rawW: w,
        rawH: h,
        gridW,
        gridH,
        dummyW,
        dummyH,
        dummyText,
        isScrambled: true
      };
    }

    return {
      descrambleMangaZenkanCanvas
    };
  })();

  (typeof globalThis !== 'undefined' ? globalThis : window).MangaZenkanTools = MangaZenkanTools;
})(typeof window !== 'undefined' ? window : this);