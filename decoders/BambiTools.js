// decoders/BambiTools.js
(function(global) {
  'use strict';

  const BambiTools = (() => {
    // Bảng mã giải mã chuỗi Seed cho nhóm Kodansha
    const CHARSETS = {
      MAGAPOKE_EVEN: "svdk0m7acl",
      MAGAPOKE_ODD:  "q6jtf2xnog",
      KMANGA_EVEN:   "we7ru3ty8i",
      KMANGA_ODD:    "h4xm9bqz1p"
    };

    /**
     * Bộ sinh số giả ngẫu nhiên PRNG Xorshift32 chuẩn của Link-U Bambi Engine
     */
    function* xorshift(seed) {
      const x = Uint32Array.of(seed);
      while (true) {
        x[0] ^= x[0] << 13;
        x[0] ^= x[0] >>> 17;
        x[0] ^= x[0] << 5;
        yield x[0];
      }
    }

    /**
     * Sinh ma trận hoán vị 16 ô vuông (Grid Size 4x4)
     */
    function generateScrambleMapping(gridSize, seed) {
      const indices = [...Array(gridSize ** 2)].map((_, r) => r);
      const t = xorshift(seed);
      const shuffled = indices
        .map((r) => [t.next().value, r])
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map((r) => r[1]);

      return shuffled.map((s, r) => ({
        source: { x: s % gridSize, y: Math.floor(s / gridSize) },
        dest:   { x: r % gridSize, y: Math.floor(r / gridSize) }
      }));
    }

    /**
     * Tính toán kích thước ô vuông ma trận (Hỗ trợ cả scramble_ver 1 & 2)
     */
    function computeGridBlockDimensions(width, height, gridSize = 4, ver = 2) {
      if (ver === 1) {
        // Thuật toán ver 1 dùng GCD / LCM
        const xs = (e, i) => {
          e > i && ([e, i] = [i, e]);
          const t = (s, o) => (s ? t(o % s, s) : o);
          return (e * i) / t(e, i);
        };
        if (width < gridSize || height < gridSize) return null;
        const s = xs(gridSize, 8);
        let e = width, i = height;
        if (e > s && i > s) {
          e = Math.floor(e / s) * s;
          i = Math.floor(i / s) * s;
        }
        return {
          width: Math.floor(e / gridSize),
          height: Math.floor(i / gridSize)
        };
      }

      // Thuật toán ver 2 chuẩn: Bội số của 8px
      const multiple = 8;
      if (width < gridSize * multiple || height < gridSize * multiple) return null;
      const s = Math.floor(width / multiple);
      const r = Math.floor(height / multiple);
      const i = Math.floor(s / gridSize);
      const c = Math.floor(r / gridSize);
      return {
        width: i * multiple,
        height: c * multiple
      };
    }

    /**
     * Giải mã chuỗi hạt giống từ bảng mã Charset (Dành cho MagaPoke và K MANGA)
     */
    function parseCharsetSeed(seed, charset, titleId = 0, episodeId = 0) {
      if (typeof seed === "number") return seed >>> 0;
      if (typeof seed !== "string") return 0;
      // Nếu chuỗi là số thuần (như Ciao Plus)
      if (/^\d+$/.test(seed)) return Number(seed) >>> 0;

      if (!charset) return 0;
      let parsedInt = 0n;
      for (const char of seed) {
        const index = charset.indexOf(char);
        if (index !== -1) {
          parsedInt = parsedInt * 10n + BigInt(index);
        } else {
          break;
        }
      }
      const parsedUInt32 = Number(parsedInt & 0xffffffffn);
      const combined = (Number(titleId) >>> 0) + (Number(episodeId) >>> 0);
      return (parsedUInt32 ^ combined) >>> 0;
    }

    /**
     * Tái tạo ảnh Canvas chuẩn Pixel-Perfect (Giữ nguyên 4 dải viền tranh gốc)
     */
    function descrambleBambiCanvas(img, seed, ver = 2, gridSize = 4) {
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.imageSmoothingEnabled = false;
      ctx.mozImageSmoothingEnabled = false;
      ctx.webkitImageSmoothingEnabled = false;
      ctx.msImageSmoothingEnabled = false;

      // Bước 1: Vẽ toàn bộ bức ảnh gốc lót nền để giữ nguyên vẹn viền thừa 0-7px
      ctx.drawImage(img, 0, 0);

      const dim = computeGridBlockDimensions(width, height, gridSize, ver);
      if (dim) {
        const mapping = generateScrambleMapping(gridSize, seed >>> 0);
        for (const c of mapping) {
          ctx.drawImage(
            img,
            c.source.x * dim.width, c.source.y * dim.height, dim.width, dim.height,
            c.dest.x * dim.width,   c.dest.y * dim.height,   dim.width, dim.height
          );
        }
      }

      return {
        canvas,
        blockDim: dim,
        gridW: dim ? dim.width * gridSize : width,
        gridH: dim ? dim.height * gridSize : height
      };
    }

    return {
      CHARSETS,
      xorshift,
      generateScrambleMapping,
      computeGridBlockDimensions,
      parseCharsetSeed,
      descrambleBambiCanvas
    };
  })();

  (typeof globalThis !== 'undefined' ? globalThis : window).BambiTools = BambiTools;
})(typeof window !== 'undefined' ? window : this);