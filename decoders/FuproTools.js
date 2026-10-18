// decoders/FuproTools.js
(function(global) {
  'use strict';

  const FuproTools = (() => {
    /**
     * 1. Bóc tách ma trận hoán vị 4 góc phần tư từ chuỗi JSON `rebuild`
     * Mặc định: [{"x":1,"y":1},{"x":1,"y":0},{"x":0,"y":1},{"x":0,"y":0}]
     */
    function parseRebuildConfig(rebuildData) {
      if (Array.isArray(rebuildData) && rebuildData.length === 4) {
        return rebuildData;
      }
      if (typeof rebuildData === 'string') {
        try {
          const parsed = JSON.parse(rebuildData);
          if (Array.isArray(parsed) && parsed.length === 4) return parsed;
        } catch (e) {}
      }
      // Khung hoán vị mặc định của Fupro (BR -> TL, TR -> BL, BL -> TR, TL -> BR)
      return [
        { x: 1, y: 1 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
        { x: 0, y: 0 }
      ];
    }

    /**
     * 2. Tính toán tọa độ cắt và ghép 4 góc phần tư (2x2 Quadrant Split)
     * Trả về danh sách lát cắt: [{ srcX, srcY, destX, destY, width, height }]
     */
    function calculateCoords(width, height, rebuildData = null) {
      const rebuild = parseRebuildConfig(rebuildData);

      const midX = Math.round(width / 2);
      const midY = Math.round(height / 2);

      // Kích thước 4 góc đích
      const leftW = midX;
      const rightW = width - midX;
      const topH = midY;
      const bottomH = height - midY;

      // 4 góc đích theo thứ tự: TL (0,0), BL (0,1), TR (1,0), BR (1,1)
      const destBoxes = [
        { destX: 0,    destY: 0,    width: leftW,  height: topH },    // TL (0, 0)
        { destX: 0,    destY: midY, width: leftW,  height: bottomH }, // BL (0, 1)
        { destX: midX, destY: 0,    width: rightW, height: topH },    // TR (1, 0)
        { destX: midX, destY: midY, width: rightW, height: bottomH }  // BR (1, 1)
      ];

      const coords = [];

      for (let i = 0; i < 4; i++) {
        const dest = destBoxes[i];
        const srcCfg = rebuild[i]; // { x: 0/1, y: 0/1 }

        const srcX = srcCfg.x === 1 ? midX : 0;
        const srcY = srcCfg.y === 1 ? midY : 0;
        const srcW = srcCfg.x === 1 ? rightW : leftW;
        const srcH = srcCfg.y === 1 ? bottomH : topH;

        coords.push({
          srcX,
          srcY,
          srcW,
          srcH,
          destX: dest.destX,
          destY: dest.destY,
          width: dest.width,
          height: dest.height
        });
      }

      return {
        coords,
        midX,
        midY,
        width,
        height
      };
    }

    /**
     * 3. Thuật toán đảo màu âm bản trực tiếp trên mảng byte pixel Uint8ClampedArray (255 - RGB)
     */
    function invertRgbPixels(pixelArray) {
      if (!pixelArray || !pixelArray.length) return;
      const len = pixelArray.length;
      for (let i = 0; i < len; i += 4) {
        pixelArray[i]     = 255 - pixelArray[i];     // Đảo kênh Red
        pixelArray[i + 1] = 255 - pixelArray[i + 1]; // Đảo kênh Green
        pixelArray[i + 2] = 255 - pixelArray[i + 2]; // Đảo kênh Blue
        // Kênh Alpha (i + 3) giữ nguyên 100%
      }
    }

    return {
      parseRebuildConfig,
      calculateCoords,
      invertRgbPixels
    };
  })();

  (typeof globalThis !== 'undefined' ? globalThis : window).FuproTools = FuproTools;
})(typeof window !== 'undefined' ? window : this);