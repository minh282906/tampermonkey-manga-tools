// decoders/StartsPublishingTools.js
(function (global) {
  'use strict';

  /* =========================================================================
   * BỘ SINH SỐ NGẪU NHIÊN CHUẨN NGUYÊN BẢN CỦA STARTS PUBLISHING (DAVID BAU ARC4)
   * Cô lập hoàn toàn trong closure, không gây ô nhiễm đối tượng Math toàn cục
   * ========================================================================= */
  const seedrandom = (function (f, a, c) {
    var s, l = 256, p = "random", d = c.pow(l, 6), g = c.pow(2, 52), y = 2 * g, h = l - 1;
    function n(n, t, r) {
      function e() {
        for (var n = u.g(6), t = d, r = 0; n < g;) n = (n + r) * l, t *= l, r = u.g(1);
        for (; y <= n;) n /= 2, t /= 2, r >>>= 1;
        return (n + r) / t;
      }
      var o = [], i = j(function n(t, r) {
        var e, o = [], i = typeof t;
        if (r && "object" == i) for (e in t) try { o.push(n(t[e], r - 1)); } catch (n) {}
        return o.length ? o : "string" == i ? t : t + "\0";
      }((t = 1 == t ? { entropy: !0 } : t || {}).entropy ? [n, S(a)] : null == n ? function () {
        try {
          var n; return s && (n = s.randomBytes) ? n = n(l) : (n = new Uint8Array(l), (f.crypto || f.msCrypto).getRandomValues(n)), S(n);
        } catch (n) {
          var t = f.navigator, r = t && t.plugins; return [+new Date, f, r, f.screen, S(a)];
        }
      }() : n, 3), o), u = new m(o);
      return e.int32 = function () { return 0 | u.g(4); }, e.quick = function () { return u.g(4) / 4294967296; }, e.double = e, j(S(u.S), a), (t.pass || r || function (n, t, r, e) {
        return e && (e.S && v(e, u), n.state = function () { return v(u, {}); }), r ? (c[p] = n, t) : n;
      })(e, i, "global" in t ? t.global : this == c, t.state);
    }
    function m(n) {
      var t, r = n.length, u = this, e = 0, o = u.i = u.j = 0, i = u.S = [];
      for (r || (n = [r++]); e < l;) i[e] = e++;
      for (e = 0; e < l; e++) i[e] = i[o = h & o + n[e % r] + (t = i[e])], i[o] = t;
      (u.g = function (n) {
        for (var t, r = 0, e = u.i, o = u.j, i = u.S; n--;) t = i[e = h & e + 1], r = r * l + i[h & (i[e] = i[o = h & o + t]) + (i[o] = t)];
        return u.i = e, u.j = o, r;
      })(l);
    }
    function v(n, t) { return t.i = n.i, t.j = n.j, t.S = n.S.slice(), t; }
    function j(n, t) {
      for (var r, e = n + "", o = 0; o < e.length;) t[h & o] = h & (r ^= 19 * t[h & o]) + e.charCodeAt(o++);
      return S(t);
    }
    function S(n) { return String.fromCharCode.apply(0, n); }
    return n;
  })({}, [], Math);

  function rfunc(prngFn, min, max) {
    return Math.floor(prngFn() * (max - min + 1)) + min;
  }

  function shuffle(arr, seed) {
    const prng = seedrandom(seed);
    const pool = arr.map((_, i) => i);
    const result = [];
    for (let c = 0; c < arr.length; c++) {
      const randIdx = rfunc(prng, 0, pool.length - 1);
      result.push(arr[pool[randIdx]]);
      pool.splice(randIdx, 1);
    }
    return result;
  }

  function getSubGrid(slices) {
    let cols = slices.length;
    if (slices.length > 1) {
      const initY = slices[0].y;
      for (let n = 0; n < slices.length; n++) {
        if (slices[n].y !== initY) {
          cols = n;
          break;
        }
      }
    }
    return {
      cols,
      rows: slices.length / cols,
      x: slices[0].x,
      y: slices[0].y
    };
  }

  /* =========================================================================
   * THUẬT TOÁN TÍNH TOÁN MA TRẬN TỌA ĐỘ VÀ BUCKET GROUPING ĐỘNG
   * ========================================================================= */
  const StartsPublishingTools = {
    /**
     * Tính toán kích thước ô lưới động và tọa độ hoán vị
     * tileSize = Math.max(width, height) / sizeParam
     */
    calculateCoords: function (width, height, seed, sizeParam = 4) {
      const div = Number(sizeParam) || 4;
      const tileSize = Math.max(width, height) / div;

      const numCols = Math.ceil(width / tileSize);
      const numRows = Math.ceil(height / tileSize);
      const totalTiles = numCols * numRows;

      // 1. Chia ảnh thành các ô và gom nhóm theo KÍCH THƯỚC (Bucket Grouping)
      const sizeGroups = {};
      for (let n = 0; n < totalTiles; n++) {
        const row = Math.floor(n / numCols);
        const col = n % numCols;

        const x = col * tileSize;
        const y = row * tileSize;
        const tileW = (x + tileSize <= width) ? tileSize : (width - x);
        const tileH = (y + tileSize <= height) ? tileSize : (height - y);

        const key = `${tileW}-${tileH}`;
        if (!sizeGroups[key]) sizeGroups[key] = [];

        sizeGroups[key].push({ x, y, width: tileW, height: tileH });
      }

      // 2. Tính toán ma trận hoán vị cho từng nhóm kích thước
      const coords = [];

      for (const key in sizeGroups) {
        const group = sizeGroups[key];
        const subGrid = getSubGrid(group);
        const indices = group.map((_, i) => i);
        const shuffled = shuffle(indices, seed);

        for (let p = 0; p < group.length; p++) {
          const m = shuffled[p];
          const srcRow = Math.floor(m / subGrid.cols);
          const srcCol = m - srcRow * subGrid.cols;

          const srcX = subGrid.x + srcCol * group[p].width;
          const srcY = subGrid.y + srcRow * group[p].height;
          const destX = group[p].x;
          const destY = group[p].y;

          coords.push({
            srcX, srcY,
            srcW: group[p].width, srcH: group[p].height,
            destX, destY,
            width: group[p].width, height: group[p].height
          });
        }
      }

      return {
        coords,
        width,
        height,
        tileSize,
        totalTiles
      };
    },

    descrambleCanvas: function (img, seed, sizeParam = 4) {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;

      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.imageSmoothingEnabled = false;
      ctx.mozImageSmoothingEnabled = false;
      ctx.webkitImageSmoothingEnabled = false;
      ctx.msImageSmoothingEnabled = false;

      ctx.drawImage(img, 0, 0, w, h);

      // DÁN ĐÈ CÁC Ô HOÁN VỊ ĐÃ ĐƯỢC GIẢI MÃ
      const geom = this.calculateCoords(w, h, seed, sizeParam);

      for (const c of geom.coords) {
        ctx.drawImage(
          img,
          c.srcX, c.srcY, c.srcW, c.srcH,
          c.destX, c.destY, c.width, c.height
        );
      }

      return { canvas, geom };
    }
  };

  (typeof globalThis !== 'undefined' ? globalThis : window).StartsPublishingTools = StartsPublishingTools;
})(typeof window !== 'undefined' ? window : this);