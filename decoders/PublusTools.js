// decoders/PublusTools.js
(function(global) {
  'use strict';

  const PublusTools = (() => {
    /**
     * Bộ sinh ma trận tọa độ giải mã PUBLUS / NFBR (Ô vuông 64x64px)
     * @param {number} imgW - Chiều rộng ảnh thô CDN
     * @param {number} imgH - Chiều cao ảnh thô CDN
     * @param {number} tileW - Kích thước ô ngang (mặc định 64)
     * @param {number} tileH - Kích thước ô dọc (mặc định 64)
     * @param {number} pattern - Khóa hoán vị (1, 2, 3, hoặc 4)
     * @returns {Array<{srcX, srcY, destX, destY, width, height}>} Ma trận lát cắt
     */
    function PublusCoordsGenerator(imgW, imgH, tileW = 64, tileH = 64, pattern = 1) {
      const calcPositionWithRest = (e, t, r, i) => e * i + (e >= t ? r : 0);
      const calcXCoordXRest = (e, t, r) => (e + 61 * r) % t;

      const calcYCoordXRest = (e, t, r, i, n) => {
        let s, a;
        const isOdd = n % 2 === 1;
        if (e < t ? isOdd : !isOdd) {
          a = r; s = 0;
        } else {
          a = i - r; s = r;
        }
        return (e + 53 * n + 59 * r) % a + s;
      };

      const calcXCoordYRest = (e, t, r, i, n) => {
        let s, a;
        const isOdd = n % 2 === 1;
        if (e < r ? isOdd : !isOdd) {
          a = i - t; s = t;
        } else {
          a = t; s = 0;
        }
        return (e + 67 * n + t + 71) % a + s;
      };

      const calcYCoordYRest = (e, t, r) => (e + 73 * r) % t;

      const cols = Math.floor(imgW / tileW);
      const rows = Math.floor(imgH / tileH);
      const restW = imgW % tileW;
      const restH = imgH % tileH;
      const coords = [];

      let shiftX = cols - (43 * pattern) % cols;
      shiftX = shiftX % cols === 0 ? (cols - 4) % cols : shiftX;
      shiftX = shiftX === 0 ? cols - 1 : shiftX;

      let shiftY = rows - (47 * pattern) % rows;
      shiftY = shiftY % rows === 0 ? (rows - 4) % rows : shiftY;
      shiftY = shiftY === 0 ? rows - 1 : shiftY;

      // 1. Mảnh góc dư (phải - dưới)
      if (restW > 0 && restH > 0) {
        const ox = shiftX * tileW;
        const oy = shiftY * tileH;
        coords.push({
          srcX: ox, srcY: oy, destX: ox, destY: oy, width: restW, height: restH
        });
      }

      // 2. Dải mảnh dư đáy
      if (restH > 0) {
        for (let l = 0; l < cols; l++) {
          const d = calcXCoordXRest(l, cols, pattern);
          const h = calcYCoordXRest(d, shiftX, shiftY, rows, pattern);
          const c = calcPositionWithRest(d, shiftX, restW, tileW);
          const p = h * tileH;
          const o = calcPositionWithRest(l, shiftX, restW, tileW);
          const u = shiftY * tileH;
          coords.push({
            srcX: o, srcY: u, destX: c, destY: p, width: tileW, height: restH
          });
        }
      }

      // 3. Dải mảnh dư phải
      if (restW > 0) {
        for (let m = 0; m < rows; m++) {
          const h = calcYCoordYRest(m, rows, pattern);
          const d = calcXCoordYRest(h, shiftX, shiftY, cols, pattern);
          const c = d * tileW;
          const p = calcPositionWithRest(h, shiftY, restH, tileH);
          const o = shiftX * tileW;
          const u = calcPositionWithRest(m, shiftY, restH, tileH);
          coords.push({
            srcX: o, srcY: u, destX: c, destY: p, width: restW, height: tileH
          });
        }
      }

      // 4. Ma trận các ô vuông 64x64 ở giữa
      for (let l = 0; l < cols; l++) {
        for (let m = 0; m < rows; m++) {
          const d = (l + 29 * pattern + 31 * m) % cols;
          const h = (m + 37 * pattern + 41 * d) % rows;
          const c = d * tileW + (d >= calcXCoordYRest(h, shiftX, shiftY, cols, pattern) ? restW : 0);
          const p = h * tileH + (h >= calcYCoordXRest(d, shiftX, shiftY, rows, pattern) ? restH : 0);
          const o = l * tileW + (l >= shiftX ? restW : 0);
          const u = m * tileH + (m >= shiftY ? restH : 0);
          coords.push({
            srcX: o, srcY: u, destX: c, destY: p, width: tileW, height: tileH
          });
        }
      }

      return coords;
    }

    /**
     * Tính toán Pattern ID từ đường dẫn file
     */
    function computePattern(filePath) {
      if (!filePath) return 1;
      return Array.from(filePath).reduce((acc, cur) => acc + cur.charCodeAt(0), 0) % 4 + 1;
    }

    return {
      PublusCoordsGenerator,
      computePattern
    };
  })();

  (typeof globalThis !== 'undefined' ? globalThis : window).PublusTools = PublusTools;
})(typeof window !== 'undefined' ? window : this);