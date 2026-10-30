// decoders/NextViewerTools.js
(function (global) {
  'use strict';

  /* =========================================================================
   * CỖ MÁY GIẢI MÃ MA TRẬN LCG & BCP PROTOCOL (BEAGLEE NEXTVIEWER)
   * ========================================================================= */
  const NextViewerTools = {
    MAGIC: 'BCP000',

    // 1. Phân tích gói tin nhị phân BCP của Beaglee
    parseBcpFrame: function (input) {
      const buf = input instanceof Uint8Array ? input : new Uint8Array(input || []);
      const latin1 = (s, e) => Array.from(buf.subarray(s, e), c => String.fromCharCode(c)).join('');

      if (buf.length < 6 || latin1(0, 6) !== this.MAGIC) {
        throw new Error('Gói tin không hợp lệ: Không tìm thấy Magic BCP000');
      }

      if (buf.length === 6) return { isGreeting: true };

      const readNum = (off, w) => Number(latin1(off, off + w).trim());
      const jsonLen = readNum(6, 10);
      const jsonEnd = 16 + jsonLen;
      if (jsonEnd > buf.length) throw new Error('Dữ liệu JSON BCP bị cắt cụt');

      const body = JSON.parse(new TextDecoder().decode(buf.subarray(16, jsonEnd)));
      if (jsonEnd === buf.length) return { isGreeting: false, body, chunks: [] };

      const chunkCount = readNum(jsonEnd, 3);
      const chunks = [];
      let cur = jsonEnd + 3;
      for (let i = 0; i < chunkCount; i++) {
        const sz = readNum(cur, 10);
        cur += 10;
        chunks.push(buf.subarray(cur, cur + sz));
        cur += sz;
      }
      return { isGreeting: false, body, chunks };
    },

    // 2. Tính toán hình học ma trận và gọt rãnh đệm Gutter 2px
    calculateGeometry: function (declaredWidth, declaredHeight, rawW, rawH) {
      let cell = 32;
      if (declaredWidth > 1000 || declaredHeight > 1000) cell *= 3;      // Ô 96px
      else if (declaredWidth > 300 || declaredHeight > 300) cell *= 2;   // Ô 64px

      const block = cell - 2; // Gọt bỏ 1px mỗi bên (Gutter 2px)
      const gridX = Math.floor(rawW / cell);
      const gridY = Math.floor(rawH / cell);

      return { cell, block, gridX, gridY };
    },

    // 3. Bộ sinh số giả ngẫu nhiên LCG (Mersenne Prime 131071)
    generateScrambleOrder: function (gridX, gridY, key) {
      const total = gridX * gridY;
      const pool = Array.from({ length: total }, (_, i) => i);
      const order = new Uint32Array(total);
      let value = Number(key) || 0;

      for (let t = 0; t < total; t++) {
        value = (8741 * value + 30873) % 131071;
        const pick = value % pool.length;
        order[t] = pool[pick];
        pool.splice(pick, 1);
      }
      return order;
    },

    // 4. Giải mã và tái tạo ma trận phẳng lì lên Canvas (Pixel-Perfect)
    descrambleCanvas: function (img, declaredW, declaredH, key) {
      const rawW = img.naturalWidth || img.width;
      const rawH = img.naturalHeight || img.height;

      const geom = this.calculateGeometry(declaredW, declaredH, rawW, rawH);
      const order = this.generateScrambleOrder(geom.gridX, geom.gridY, key);

      const targetW = Math.min(Number(declaredW), geom.gridX * geom.block);
      const targetH = Math.min(Number(declaredH), geom.gridY * geom.block);

      const canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;

      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.imageSmoothingEnabled = false;
      ctx.mozImageSmoothingEnabled = false;
      ctx.webkitImageSmoothingEnabled = false;
      ctx.msImageSmoothingEnabled = false;

      const coords = [];
      for (let t = 0; t < order.length; t++) {
        const from = order[t];
        const srcX = (from % geom.gridX) * geom.cell + 1; // Nhảy qua 1px rãnh đệm trái
        const srcY = Math.floor(from / geom.gridX) * geom.cell + 1; // Nhảy qua 1px rãnh đệm trên
        const destX = (t % geom.gridX) * geom.block;
        const destY = Math.floor(t / geom.gridX) * geom.block;

        ctx.drawImage(img, srcX, srcY, geom.block, geom.block, destX, destY, geom.block, geom.block);
        coords.push({ srcX, srcY, destX, destY, width: geom.block, height: geom.block });
      }

      return { canvas, geom, coords, targetW, targetH };
    }
  };

  (typeof globalThis !== 'undefined' ? globalThis : window).NextViewerTools = NextViewerTools;
})(typeof window !== 'undefined' ? window : this);