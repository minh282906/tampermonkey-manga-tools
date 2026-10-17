// decoders/SpeedBinbTools.js
(function(global) {
  'use strict';

  const SpeedBinbTools = (() => {
    function generateRandomString32(id) {
      function generateRandomString16() {
        let e = "";
        let n = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        for (let i = 0; i < 16; i++) {
          e += n.charAt(Math.floor(Math.random() * n.length));
        }
        return e;
      }
      let n = generateRandomString16(),
        i = Array(Math.ceil(16 / id.length) + 1).join(id),
        r = i.slice(0, 16),
        e = i.slice(-16),
        s = 0, h = 0, u = 0;
      return n.split("").map(function (t, i) {
        return s ^= n.charCodeAt(i),
          h ^= r.charCodeAt(i),
          u ^= e.charCodeAt(i),
          t + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[s + h + u & 63]
      }).join("");
    }

    function getDecryptedTable(t, i, n) {
      for (var r = t + ":" + i, e = 0, s = 0; s < r.length; s++)
        e += r.charCodeAt(s) << s % 16;
      0 == (e &= 2147483647) && (e = 305419896);
      var h = "", u = e;
      for (let s = 0; s < n.length; s++) {
        u = u >>> 1 ^ 1210056708 & -(1 & u);
        var o = (n.charCodeAt(s) - 32 + u) % 94 + 32;
        h += String.fromCharCode(o)
      }
      try {
        return JSON.parse(h)
      } catch (t) {}
      return null
    }

    function getDecryptionKey(t, ctbl, ptbl) {
      var i = [0, 0];
      if (t) {
        for (var n = t.lastIndexOf("/") + 1, r = t.length - n, e = 0; e < r; e++)
          i[e % 2] += t.charCodeAt(e + n);
        i[0] %= 8, i[1] %= 8
      }
      var s = ptbl[i[0]], h = ctbl[i[1]];
      return [h, s];
    }

    class CoordDecoder {
      constructor(t, i) {
        this.mode = null; // 'v1' (= cũ có Gutter) hoặc 'v2' (8-8- mới No-Gutter)
        if (!t || !i) return;

        // NHÁNH 1: CLASSIC (Bắt đầu bằng dấu '=')
        if (t.charAt(0) === "=" && i.charAt(0) === "=") {
          this.initV1(t, i);
        }
        // NHÁNH 2: VOYAGER V2 (Bắt đầu bằng số [0-9] như S-MANGA '8-8-')
        else if (/^[0-9]/.test(t) && /^[0-9]/.test(i)) {
          this.initV2(t, i);
        }
      }

      // --- LÕI THẾ HỆ 1 (BOOKLIVE, CMOA, YANMAGA...) ---
      initV1(t, i) {
        this.kt = [-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,62,-1,-1,52,53,54,55,56,57,58,59,60,61,-1,-1,-1,-1,-1,-1,-1,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,-1,-1,-1,-1,63,-1,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,-1,-1,-1,-1,-1];
        var n = t.match(/^=([0-9]+)-([0-9]+)([-+])([0-9]+)-([-_0-9A-Za-z]+)$/),
            r = i.match(/^=([0-9]+)-([0-9]+)([-+])([0-9]+)-([-_0-9A-Za-z]+)$/);
        if (null !== n && null !== r && n[1] === r[1] && n[2] === r[2] && n[4] === r[4] && "+" === n[3] && "-" === r[3] && (this.T = parseInt(n[1], 10), this.j = parseInt(n[2], 10), this.xt = parseInt(n[4], 10), !(8 < this.T || 8 < this.j || 64 < this.T * this.j))) {
          var e = this.T + this.j + this.T * this.j;
          if (n[5].length === e && r[5].length === e) {
            var s = this.St(n[5]), h = this.St(r[5]);
            this.Ct = s.n, this.At = s.t, this.Tt = h.n, this.Pt = h.t, this.It = [];
            for (var u = 0; u < this.T * this.j; u++) this.It.push(s.p[h.p[u]]);
            this.mode = 'v1';
          }
        }
      }

      St(t) {
        var i, n = [], r = [], e = [];
        for (i = 0; i < this.T; i++) n.push(this.kt[t.charCodeAt(i)]);
        for (i = 0; i < this.j; i++) r.push(this.kt[t.charCodeAt(this.T + i)]);
        for (i = 0; i < this.T * this.j; i++) e.push(this.kt[t.charCodeAt(this.T + this.j + i)]);
        return { t: n, n: r, p: e };
      }

      // --- LÕI THẾ HỆ 2 (S-MANGA VOYAGER NO-GUTTER) ---
      initV2(t, i) {
        var n = this.decodePieceV2(t), e = this.decodePieceV2(i);
        if (n && e && n.ndx === e.ndx && n.ndy === e.ndy) {
          this.srcPiece = n;
          this.dstPiece = e;
          this.mode = 'v2';
        }
      }

      decodeBase52(t) {
        var i = 0, n = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".indexOf(t);
        return n < 0 ? (n = "abcdefghijklmnopqrstuvwxyz".indexOf(t)) : (i = 1), i + 2 * n;
      }

      decodePieceV2(t) {
        var parts = t.split('-');
        if (parts.length < 3) return null;
        var n = parseInt(parts[0], 10), e = parseInt(parts[1], 10), r = parts[2];
        if (r.length !== n * e * 2) return null;

        for (var s, h, u, o, a = (n - 1) * (e - 1) - 1, f = n - 1 + a, c = e - 1 + f, l = 1 + c, v = [], d = 0; d < n * e; d++) {
          s = this.decodeBase52(r.charAt(2 * d));
          h = this.decodeBase52(r.charAt(2 * d + 1));
          d <= a ? o = u = 2 : d <= f ? (u = 2, o = 1) : d <= c ? (u = 1, o = 2) : d <= l && (o = u = 1);
          v.push({ x: s, y: h, w: u, h: o });
        }
        return { ndx: n, ndy: e, piece: v };
      }

      // --- HÀM TÍNH TOÁN TỌA ĐỘ VẠN NĂNG (DÙNG CHUNG) ---
      getCoords(t) {
        // Nhánh 1: Classic V1 (có trừ viền đệm 2*xt)
        if (this.mode === 'v1') {
          for (var i = t.width - 2 * this.T * this.xt, n = t.height - 2 * this.j * this.xt, r = Math.floor((i + this.T - 1) / this.T), e = i - (this.T - 1) * r, s = Math.floor((n + this.j - 1) / this.j), h = n - (this.j - 1) * s, u = [], o = 0; o < this.T * this.j; ++o) {
            var a = o % this.T, f = Math.floor(o / this.T),
                c = this.xt + a * (r + 2 * this.xt) + (this.Tt[f] < a ? e - r : 0),
                l = this.xt + f * (s + 2 * this.xt) + (this.Pt[a] < f ? h - s : 0),
                v = this.It[o] % this.T, d = Math.floor(this.It[o] / this.T),
                b = v * r + (this.Ct[d] < v ? e - r : 0),
                g = d * s + (this.At[v] < d ? h - s : 0),
                p = this.Tt[f] === a ? e : r, m = this.Pt[a] === f ? h : s;
            0 < i && 0 < n && u.push({ srcX: c, srcY: l, width: p, height: m, destX: b, destY: g });
          }
          return u;
        }

        // Nhánh 2: Voyager V2 (S-MANGA No-Gutter, khớp 100% không viền thừa)
        if (this.mode === 'v2') {
          var u = [],
              n = t.width - t.width % 8,
              e = Math.floor((n - 1) / 7) - Math.floor((n - 1) / 7) % 8,
              r = n - 7 * e,
              s = t.height - t.height % 8,
              h = Math.floor((s - 1) / 7) - Math.floor((s - 1) / 7) % 8,
              b = s - 7 * h,
              total = this.srcPiece.piece.length;

          for (var a = 0; a < total; a++) {
            var f = this.srcPiece.piece[a], c = this.dstPiece.piece[a];
            u.push({
              srcX: Math.floor(f.x / 2) * e + (f.x % 2) * r,
              srcY: Math.floor(f.y / 2) * h + (f.y % 2) * b,
              width: Math.floor(f.w / 2) * e + (f.w % 2) * r,
              height: Math.floor(f.h / 2) * h + (f.h % 2) * b,
              destX: Math.floor(c.x / 2) * e + (c.x % 2) * r,
              destY: Math.floor(c.y / 2) * h + (c.y % 2) * b
            });
          }
          return u;
        }

        return [];
      }
    }

    function parsePTImgCoords(coordStr) {
      if (!coordStr || typeof coordStr !== 'string') return null;
      const m = coordStr.match(/^([^:]+):(\d+),(\d+)\+(\d+),(\d+)>(\d+),(\d+)$/);
      if (!m) return null;
      return {
        srcX: parseInt(m[2], 10),
        srcY: parseInt(m[3], 10),
        width: parseInt(m[4], 10),
        height: parseInt(m[5], 10),
        destX: parseInt(m[6], 10),
        destY: parseInt(m[7], 10)
      };
    }

    return { generateRandomString32, getDecryptedTable, getDecryptionKey, CoordDecoder, parsePTImgCoords };
  })();

  (typeof globalThis !== 'undefined' ? globalThis : window).SpeedBinbTools = SpeedBinbTools;
})(typeof window !== 'undefined' ? window : this);