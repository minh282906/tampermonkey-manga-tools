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

    /* =========================================================================
     * BỘ GIẢI MÃ 9 TẦNG & MA TRẬN 32px BOOKWALKER và PIXIV COMIC STORE (NFBR CIPHER PIPELINE)
     * ========================================================================= */
    const Xn3 = [
      [1, 3, 10], [1, 5, 16], [1, 5, 19], [1, 9, 29], [1, 11, 6], [1, 11, 16], [1, 19, 3],
      [1, 21, 20], [1, 27, 27], [2, 5, 15], [2, 5, 21], [2, 7, 7], [2, 7, 9], [2, 7, 25],
      [2, 9, 15], [2, 15, 17], [2, 15, 25], [2, 21, 9], [3, 1, 14], [3, 3, 26], [3, 3, 28],
      [3, 3, 29], [3, 5, 20], [3, 5, 22], [3, 5, 25], [3, 7, 29], [3, 13, 7], [3, 23, 25],
      [3, 25, 24], [3, 27, 11], [4, 3, 17], [4, 3, 27], [4, 5, 15], [5, 3, 21], [5, 7, 22],
      [5, 9, 7], [5, 9, 28], [5, 9, 31], [5, 13, 6], [5, 15, 17], [5, 17, 13], [5, 21, 12],
      [5, 27, 8], [5, 27, 21], [5, 27, 25], [5, 27, 28], [6, 1, 11], [6, 3, 17], [6, 17, 9],
      [6, 21, 7], [6, 21, 13], [7, 1, 9], [7, 1, 18], [7, 1, 25], [7, 13, 25], [7, 17, 21],
      [7, 25, 12], [7, 25, 20], [8, 7, 23], [8, 9, 23], [9, 5, 14], [9, 5, 25], [9, 11, 19],
      [9, 21, 16], [10, 9, 21], [10, 9, 25], [11, 7, 12], [11, 7, 16], [11, 17, 13],
      [11, 21, 13], [12, 9, 23], [13, 3, 17], [13, 3, 27], [13, 5, 19], [13, 17, 15],
      [14, 1, 15], [14, 13, 15], [15, 1, 29], [17, 15, 20], [17, 15, 23], [17, 15, 26]
    ];

    const tn3 = [
      (g, B, H, R) => ((g ^= g << B), (g ^= g >>> H), (g ^= g << R)),
      (R, D, U, A) => ((R ^= R << A), (R ^= R >>> U), (R ^= R << D)),
      (L, j, l, q) => ((L ^= L >>> j), (L ^= L << l), (L ^= L >>> q)),
      (v, s, M, m) => ((v ^= v >>> m), (v ^= v << M), (v ^= v >>> s)),
      (E, d, O, k) => ((E ^= E << d), (E ^= E << k), (E ^= E >>> O)),
      (f, T, C, K) => ((f ^= f >>> T), (f ^= f >>> K), (f ^= f << C))
    ];

    class T8n {
      constructor() {
        this.Rn3 = 2463534242;
        this.D83 = Xn3[74][0]; this.U83 = Xn3[74][1]; this.A83 = Xn3[74][2];
        this.L83 = tn3[0];
      }
      e7Ks(j, l) {
        this.Rn3 = 2463534242;
        const q = Xn3[j];
        this.D83 = q[0]; this.U83 = q[1]; this.A83 = q[2]; this.L83 = tn3[l];
      }
      j7p(v) { let s = v >>> 0; if (0 === s) s = 2463534242; this.Rn3 = s; }
      W5C(M) {
        if (M <= 1) return 0;
        let m, E, d = this.Rn3, O = 4294967295 - M;
        while ((m = (E = (d = this.L83(d, this.D83, this.U83, this.A83) >>> 0) - 1) % M), O < E - m);
        this.Rn3 = d;
        return m;
      }
    }
    T8n.M2e = Xn3.length; T8n.B4d = tn3.length; T8n.n2C = Xn3.length * tn3.length;

    const pushArr = Array.prototype.push;
    function kGm(g, B) { return B < 4 ? g(B + 1) : g(B - 1) + 1; }
    function CGm(H, R, D) { if (0 === D) return 0; const U = H(D); return U < R ? U : U + 1; }
    function dGm(K, V) {
      const F = [];
      for (let I = 0; I < V; I++) { const Q = K(I + 1); F[I] = F[Q]; F[Q] = I; }
      return F;
    }
    function FGm(A, L, j, l, q, v, s) {
      let d = v, O = s, k = l, f = q, T = 0, C = 0;
      while (0 < d + O) {
        const M = A(d + O);
        if (M < d) {
          if (M < k) {
            let m, E;
            for (m = C; 0 < m && !(T >= L[m - 1]); m--);
            for (E = C + O; E < s && !(T >= L[E]); E++);
            j[T] = A(E - m) + m; T++; k--;
          } else {
            let m, E;
            for (m = C; 0 < m && !(T + d <= L[m - 1]); m--);
            for (E = C + O; E < s && !(T + d <= L[E]); E++);
            j[T + d - 1] = A(E - m) + m;
          }
          d--;
        } else {
          if (M - d < f) {
            let m, E;
            for (m = T; 0 < m && !(C >= j[m - 1]); m--);
            for (E = T + d; E < v && !(C >= j[E]); E++);
            L[C] = A(E - m) + m; C++; f--;
          } else {
            let m, E;
            for (m = T; 0 < m && !(C + O <= j[m - 1]); m--);
            for (E = T + d; E < v && !(C + O <= j[E]); E++);
            L[C + O - 1] = A(E - m) + m;
          }
          O--;
        }
      }
    }

    function ZGm(x, w, P, J, G, h, r, n, b, p, S, X, t) {
      const A = [], L = x + 1, j = w + 1, lh = L << 1, qh = j << 1;
      const v = pushArr.bind(A);
      for (let B = 0; B < x; B++) {
        for (let H = 0; H < w; H++) {
          const Uh = P[B + H * x], RG = Uh % x, Dh = (Uh - RG) / x;
          const YG = B < S[H] ? B : B + L, zG = H < p[B] ? H : H + j, gG = RG < r[Dh] ? RG : RG + L;
          v((Dh < h[RG] ? Dh : Dh + j) * lh + YG);
          v(gG * qh + zG);
        }
      }
      v(b * lh + X); v(n * qh + t);
      for (let B = 0; B < x; B++) {
        const H = p[B], RG = J[B], gG = RG < n ? RG : RG + L;
        v(h[RG] * lh + (B < X ? B : B + L)); v(gG * qh + H);
      }
      for (let H = 0; H < w; H++) {
        const B = S[H], Dh = G[H], RG = r[Dh];
        v((Dh < b ? Dh : Dh + j) * lh + B); v(RG * qh + (H < t ? H : H + j));
      }
      return A;
    }

    function C6A_a3f(h, r, n, b) {
      const p = new T8n(), S = r ^ n ^ b;
      const X = Math.floor(h / 65536), tj = Math.floor(r / 65536), Y = Math.floor(n / 65536), z = Math.floor(b / 65536);
      let H = tj ^ Y ^ z, R = X ^ z;
      let DG = (h ^ r) >>> 0, UG = (h ^ n) >>> 0, AG = (h ^ b) >>> 0;
      const LG = (H >>>= 16) % T8n.B4d, jG = ((H - LG) / T8n.B4d) % T8n.M2e;
      const lG = p.W5C.bind(p);
      p.e7Ks(jG, LG); p.j7p(S);
      const qG = lG(65536) | (lG(65536) << 16), vG = tj >>> 16, sG = Y >>> 16;
      DG = (DG ^ qG) >>> 0; UG = (UG ^ qG) >>> 0; AG = (AG ^ qG) >>> 0;
      const MG = (R = (R >>> 16) ^ lG(512)) % T8n.B4d, mG = ((R - MG) / T8n.B4d) % T8n.M2e;
      p.e7Ks(mG, MG); p.j7p(DG);
      const EG = dGm(lG, vG * sG);
      p.j7p(UG);
      const OG = kGm(lG, vG), fG = kGm(lG, sG), TG = CGm(lG, OG, vG), KG = CGm(lG, fG, sG);
      p.j7p(AG);
      const VG = [], QG = [];
      FGm(lG, VG, QG, OG, fG, vG, sG);
      const IG = dGm(lG, vG), cG = dGm(lG, sG), NG = [], WG = [];
      FGm(lG, WG, NG, TG, KG, vG, sG);
      return ZGm(vG, sG, EG, IG, cG, NG, WG, TG, KG, QG, VG, OG, fG);
    }

    function getBlocks(pageInfo, sd, Md) {
      const md = [], Ed = pageInfo.BlockWidth || 32, dd = pageInfo.BlockHeight || 32;
      const Od = pageInfo.Q1i, kd = pageInfo.b0F, fd = pageInfo.v5m, Td = pageInfo.U2F;
      const Vd = Math.floor(sd / Ed), Qd = Math.floor(Md / dd), Fd = sd % Ed, Id = Md % dd;
      const cd = (Vd + 1) << 1, Nd = (Qd + 1) << 1, Wd = (Vd + 1) * Ed - Fd, Zd = (Qd + 1) * dd - Id;
      const xd = new T8n(), wd = Td ^ Vd ^ Qd, Pd = wd % T8n.B4d, Jd = ((wd - Pd) / T8n.B4d) % T8n.M2e;
      xd.e7Ks(Jd, Pd); xd.j7p(Od ^ kd ^ fd);
      let Gd = xd.W5C(65536) + 65536 * xd.W5C(65536) + 4294967296 * xd.W5C(512);
      const hd = 4294967296 * Vd + Od, rd = 4294967296 * Qd + kd, nd = 4294967296 * Td + fd;
      const bd = C6A_a3f(Gd, hd, rd, nd);

      const pd = (Sd, Xd, td, Yd) => {
        if (0 !== td && 0 !== Yd) {
          while (Sd < Xd) {
            const zd = bd[Sd++], gd = bd[Sd++], Hd = gd % Nd, Rd = (gd - Hd) / Nd, Bd = zd % cd, DO = (zd - Bd) / cd;
            md.push({
              srcX: Bd * Ed - (Vd < Bd ? Wd : 0),
              srcY: Hd * dd - (Qd < Hd ? Zd : 0),
              destX: Rd * Ed - (Vd < Rd ? Wd : 0),
              destY: DO * dd - (Qd < DO ? Zd : 0),
              width: td,
              height: Yd
            });
          }
        }
      };

      let OO = 0, kO = (Vd * Qd) << 1;
      pd(OO, kO, Ed, dd);
      pd((OO = kO), (kO += 2), Fd, Id);
      pd((OO = kO), (kO += Vd << 1), Ed, Id);
      pd((OO = kO), (kO += Qd << 1), Fd, dd);
      return md;
    }

    function a0FBin(p) {
      const Y = [], z = [], g = p.length;
      let X = 0, S = 0, t;
      for (X = S = 0; S < 256; S++, X++) { if (X === g) X = 0; z[(Y[S] = S)] = p[X]; }
      for (X = S = 0; S < 256; S++) {
        X = (X + Y[S] + z[S]) & 255; t = Y[S]; Y[S] = Y[X]; Y[X] = t;
      }
      return Y;
    }

    function I1s(k, f, T) { return a0FBin([].concat(k).concat(f).concat(T)); }
    function jYs(vh, sh) {
      const kh = []; kh.length = vh.length;
      const dh = a0FBin(sh); let mh = 0, Mh = 0;
      for (let Th = 0; Th < vh.length; Th++) {
        mh = (mh + dh[(Mh = (Mh + 1) & 255)]) & 255;
        const Oh = dh[Mh]; dh[Mh] = dh[mh]; dh[mh] = Oh;
        kh[Th] = vh[Th] ^ dh[(dh[Mh] + dh[mh]) & 255];
      }
      return kh;
    }
    function dgs(K, V, Q, F) { return jYs(K, [].concat(V).concat(Q).concat(F)); }

    function getFileNameUtf8(name = "configuration_pack.json") {
      const arr = [];
      for (let i = 0; i < name.length; i++) {
        let code = name.charCodeAt(i);
        if (code < 128) arr.push(code);
        else if (code < 2048) { arr.push(192 | (code >> 6)); arr.push(128 | (63 & code)); }
        else { arr.push(224 | (code >> 12)); arr.push(128 | ((code >> 6) & 63)); arr.push(128 | (63 & code)); }
      }
      return arr;
    }

    function d2j(Ggs, hgs, rgs, ngs, bgs, lYs) {
      let pgs, Sgs, zgs, Xgs, tgs, Ygs;
      switch (lYs) {
        case 0: pgs = Ggs; Sgs = hgs; zgs = 65536; Xgs = rgs; tgs = ngs; Ygs = bgs; break;
        case 1: pgs = bgs; zgs = Sgs = 32; Xgs = rgs; tgs = ngs; Ygs = null; break;
        case 2: pgs = ngs; zgs = Sgs = 32; Xgs = rgs; tgs = bgs; Ygs = null; break;
        case 3: pgs = rgs; zgs = Sgs = 32; Xgs = ngs; tgs = bgs; Ygs = null; break;
      }
      let Hgs = 0, Rgs = 0;
      for (let B = 0; B < 32; B++) { Hgs = (Hgs + Xgs[B]) & 255; Rgs ^= Xgs[B]; }
      for (let B = 0; B < 32; B++) { Hgs = (Hgs + tgs[B]) & 255; Rgs ^= tgs[B]; }
      if (Ygs) for (let B = 0; B < 32; B++) { Hgs = (Hgs + Ygs[B]) & 255; Rgs ^= Ygs[B]; }

      const s2s = 2 != (2 & Hgs), M2s = 4 != (4 & Hgs), m2s = 8 != (8 & Hgs);
      const E2s = Rgs >>> 5, d2s = 8 - E2s;
      const v2s = [];

      for (let f2s = 0; f2s < Sgs;) {
        let C2s = f2s + zgs; if (Sgs < C2s) C2s = Sgs;
        while (f2s < C2s) {
          const K2s = f2s + 32, V2s = C2s < K2s, Q2s = V2s ? C2s - f2s : 32;
          let W2s = Hgs, Z2s = Rgs, I2s = 0, c2s = f2s;
          while (I2s < Q2s) {
            let F = pgs[c2s++];
            if (s2s) F = ((85 & F) << 1) | ((F >>> 1) & 85);
            if (M2s) F = ((51 & F) << 2) | ((F >>> 2) & 51);
            if (m2s) F = ((15 & F) << 4) | ((F >>> 4) & 15);
            W2s = (W2s + (v2s[I2s++] = F)) & 255; Z2s ^= F;
          }
          const J2s = 2 != (2 & W2s), G2s = 4 != (4 & W2s), h2s = 8 != (8 & W2s), r2s = 16 != (16 & W2s), n2s = 32 != (32 & W2s);
          for (I2s = 0; I2s < Q2s; I2s++) {
            if (1 == (1 & I2s) && J2s) { const F = v2s[I2s]; v2s[I2s] = v2s[I2s - 1]; v2s[I2s - 1] = F; }
            if (3 == (3 & I2s)) {
              if (G2s) for (let N = I2s - 2, limit = N, c = I2s; limit < c;) { const F = v2s[c]; v2s[c--] = v2s[N]; v2s[N--] = F; }
              if (7 == (7 & I2s)) {
                if (h2s) for (let N = I2s - 4, limit = N, c = I2s; limit < c;) { const F = v2s[c]; v2s[c--] = v2s[N]; v2s[N--] = F; }
                if (15 == (15 & I2s)) {
                  if (r2s) for (let N = I2s - 8, limit = N, c = I2s; limit < c;) { const F = v2s[c]; v2s[c--] = v2s[N]; v2s[N--] = F; }
                  if (31 == (31 & I2s) && n2s) for (let N = I2s - 16, limit = N, c = I2s; limit < c;) { const F = v2s[c]; v2s[c--] = v2s[N]; v2s[N--] = F; }
                }
              }
            }
          }
          let P2s = Z2s >>> 3; P2s = V2s ? P2s % Q2s : P2s & 31;
          if (0 === E2s) {
            for (I2s = f2s, c2s = Q2s - P2s; I2s < (V2s ? C2s : K2s);) {
              if (c2s === Q2s) c2s = 0; pgs[I2s++] = v2s[c2s++];
            }
          } else {
            for (I2s = f2s, c2s = Q2s - P2s - 1; I2s < (V2s ? C2s : K2s);) {
              let F = v2s[c2s] << d2s; if (++c2s === Q2s) c2s = 0;
              F |= v2s[c2s] >>> E2s; pgs[I2s++] = 255 & F;
            }
          }
          f2s = V2s ? C2s : K2s;
        }
      }
      return [Ggs, hgs, rgs, ngs, bgs];
    }

    function b9q(D, U, A, L, j, vYs) {
      const l = I1s(L, vYs, j);
      for (let E = 0, d = 0; E < U; E++) { D[E] ^= l[d++]; d &= 255; }
      return [D, U, A, L, j];
    }

    function u6D(k, f, T, C, K, vYs) {
      const V = I1s(vYs, T, C);
      for (let x = (1 | f) - 2, w = 0, P = 0; x >= 0; x -= 2) {
        P = (P + V[(w = (w + 1) & 255)]) & 255;
        const N = V[w]; V[w] = V[P]; V[P] = N;
        k[x] ^= V[(V[w] + V[P]) & 255];
      }
      return [k, f, T, C, K];
    }

    function l3I(b, p, S, X, t, vYs) {
      const Y = I1s(t, vYs, S);
      for (let L = (p - 1) & -2, j = 0, l = 0; L >= 0; L -= 2) {
        l = (l + Y[(j = (j + 1) & 255)]) & 255;
        const D = Y[j]; Y[j] = Y[l]; Y[l] = D;
        b[L] ^= Y[(Y[j] + Y[l]) & 255];
      }
      return [b, p, S, X, t];
    }

    function x3U(b, p, S, X, t) {
      const B = p > 32 ? 32 : p;
      for (let H = 0; H < B; H++) {
        let g = b[H] ^ S[H] ^ X[H] ^ t[H], Y, z;
        switch (12 & g) { case 0: Y = S[H]; break; case 4: Y = X[H]; break; case 8: Y = t[H]; break; case 12: Y = b[H]; break; }
        switch (3 & g) {
          case 0: z = S[H]; S[H] = Y; break; case 1: z = X[H]; X[H] = Y; break;
          case 2: z = t[H]; t[H] = Y; break; case 3: z = b[H]; b[H] = Y; break;
        }
        switch (12 & g) { case 0: S[H] = z; break; case 4: X[H] = z; break; case 8: t[H] = z; break; case 12: b[H] = z; break; }
        switch (192 & g) { case 0: Y = S[H]; break; case 64: Y = X[H]; break; case 128: Y = t[H]; break; case 192: Y = b[H]; break; }
        switch (48 & g) {
          case 0: z = S[H]; S[H] = Y; break; case 16: z = X[H]; X[H] = Y; break;
          case 32: z = t[H]; t[H] = Y; break; case 48: z = b[H]; b[H] = Y; break;
        }
        switch (192 & g) { case 0: S[H] = z; break; case 64: X[H] = z; break; case 128: t[H] = z; break; case 192: b[H] = z; break; }
      }
      return [b, p, S, X, t];
    }

    function N3P(v, s, M, m, E, vYs) {
      E = dgs(E, m, M, vYs); m = dgs(m, M, vYs, E); M = dgs(M, vYs, E, m);
      return [v, s, M, m, E];
    }

    function T2l(T, C, K, V, Q, vYs) {
      const F = I1s(Q, V, vYs);
      for (let G = 0, h = 0, r = 0; G < C; G++) {
        r = (r + F[(h = (h + 1) & 255)]) & 255;
        const x = F[h]; F[h] = F[r]; F[r] = x;
        T[G] ^= F[(F[h] + F[r]) & 255];
      }
      return [T, C, K, V, Q];
    }

    function Y7p(T, C, K, V, Q) {
      const decoder = new TextDecoder('utf-8', { fatal: false });
      const jsonStr = decoder.decode(T);
      const toHex = (arr) => Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
      return {
        config: JSON.parse(jsonStr),
        key1: K, key2: V, key3: Q,
        key1Hex: toHex(K), key2Hex: toHex(V), key3Hex: toHex(Q)
      };
    }

    function decryptConfigurationPack(conf64Data) {
      const rawBinary = atob(conf64Data);
      const key1 = [], key2 = [], key3 = [];
      for (let i = 0; i < 32; i++) {
        key1.push(rawBinary.charCodeAt(i));
        key2.push(rawBinary.charCodeAt(32 + i));
        key3.push(rawBinary.charCodeAt(64 + i));
      }
      const dataLen = rawBinary.length - 96;
      const dataArr = new Uint8Array(dataLen);
      for (let i = 0; i < dataLen; i++) dataArr[i] = rawBinary.charCodeAt(96 + i);

      const vYs = getFileNameUtf8("configuration_pack.json");
      let res = [dataArr, dataLen, key1, key2, key3];
      res = d2j(...res, 0);
      res = b9q(...res, vYs);
      res = u6D(...res, vYs);
      res = l3I(...res, vYs);
      res = x3U(...res);
      res = N3P(...res, vYs);
      res = d2j(...res, 1);
      res = d2j(...res, 2);
      res = d2j(...res, 3);
      res = T2l(...res, vYs);
      return Y7p(...res);
    }

    function calcU2F(pageInfo, key1, key2, key3) {
      const imgName = pageInfo.imgName || pageInfo.file || "";
      const fileName = String(pageInfo.No ?? "");
      let U2F = 47;
      for (let i = 0; i < imgName.length; i++) U2F += imgName.charCodeAt(i);
      for (let i = 0; i < fileName.length; i++) U2F += fileName.charCodeAt(i);

      let keySum = 0;
      const S03 = (arr) => {
        let t = 0, y = -4 & arr.length; if (y > 32) y = 32;
        for (let z = 0; z < y;) {
          t ^= arr[z++] << 24; t ^= arr[z++] << 16; t ^= arr[z++] << 8; t ^= arr[z++];
        }
        return t >>> 0;
      };

      const keyAS3Arr = [S03(key1), S03(key2), S03(key3)];
      for (const k of [key1, key2, key3]) for (let i = 0; i < k.length; i++) keySum += k[i];

      U2F += keySum;
      let NS3 = 255 & U2F; NS3 |= NS3 << 8; NS3 |= NS3 << 16;
      pageInfo.U2F = U2F % T8n.n2C;
      pageInfo.Q1i = (NS3 ^ keyAS3Arr[0] ^ parseInt(pageInfo.NS || 0)) >>> 0;
      pageInfo.b0F = (NS3 ^ keyAS3Arr[1] ^ parseInt(pageInfo.PS || 0)) >>> 0;
      pageInfo.v5m = (NS3 ^ keyAS3Arr[2] ^ parseInt(pageInfo.RS || 0)) >>> 0;
    }

    function getImgURLHash(pageNo, imgName, key1, key2, key3, fileNameVersion) {
      const keyXor = new Uint8Array(32);
      for (let i = 0; i < 32; i++) keyXor[i] = key1[i] ^ key2[i] ^ key3[i];

      if (typeof fileNameVersion !== 'string') return String(pageNo);

      const Pjm = { No: String(pageNo) };
      const Gjm = parseInt(Pjm.No, 10);
      let prefix = "0" + Pjm.No;
      if (!isNaN(Gjm) && Gjm >= 0 && Gjm < 1152921504606847000) {
        const hjm = Gjm.toString(16);
        prefix = hjm.length.toString(16) + hjm;
      }

      const Yjm = imgName + "/", zjm = Pjm.No, D6m = Yjm + zjm;
      const Bjm = Yjm.length, Hjm = zjm.length, U6m = Bjm + Hjm;
      const L6m = (1 + Bjm) << 1, j6m = (1 + U6m) << 1;
      const l6m = new Array(j6m);
      let pjm = 0; l6m[pjm++] = 0; l6m[pjm++] = 59;
      for (let b = 0; b < U6m; b++) {
        const tjm = D6m.charCodeAt(b);
        l6m[pjm++] = tjm >>> 8; l6m[pjm++] = 255 & tjm;
      }
      let v6m = (Hjm << 1) + j6m + j6m, s6m = 3;
      while (v6m < 256) { v6m += j6m; s6m++; }

      let d6m = 1670739, O6m = 1282576, k6m = 2237221, Sjm = 0;
      let bjm = L6m;
      pjm = 0;
      let m6m, o6m, k6mProduct;

      for (Sjm = pjm = 0;;) {
        for (;
          m6m = 435 * d6m + ((3 & O6m) << 19) + ((4194296 & (k6m ^= l6m[bjm++] ^ keyXor[pjm++])) >>> 3) +
            ((o6m = 435 * O6m + ((7 & k6m) << 18) + ((k6mProduct = 435 * k6m) >>> 22)) >>> 21),
          k6m = 4194303 & k6mProduct,
          O6m = 2097151 & o6m,
          d6m = 2097151 & m6m,
          32 <= pjm && (pjm = 0),
          !(j6m <= bjm);
        ) {}
        if (++Sjm >= s6m) break;
        bjm = 0;
      }

      const f6m = new Array(16);
      const hexChars = (val, shift) => {
        const t = (val >>> shift) & 15;
        return (t < 10 ? 48 : 87) + t;
      };
      const xorB = [
        (d6m >>> 13) ^ keyXor[0], ((d6m >>> 5) & 255) ^ keyXor[1],
        (((31 & d6m) << 3) | (O6m >>> 18)) ^ keyXor[2], ((O6m >>> 10) & 255) ^ keyXor[3],
        ((O6m >>> 2) & 255) ^ keyXor[4], (((3 & O6m) << 6) | (k6m >>> 16)) ^ keyXor[5],
        ((k6m >>> 8) & 255) ^ keyXor[6], (255 & k6m) ^ keyXor[7]
      ];
      for (let i = 0; i < 8; i++) {
        f6m[i * 2] = hexChars(xorB[i], 4);
        f6m[i * 2 + 1] = hexChars(xorB[i], 0);
      }

      return prefix + String.fromCharCode.apply(null, f6m);
    }

    async function unscrambleBookWalkerImage(imgElement, pageItem, isJpg, quality = 0.95) {
      const rawW = imgElement.naturalWidth || imgElement.width;
      const rawH = imgElement.naturalHeight || imgElement.height;
      const targetW = pageItem.width;
      const targetH = pageItem.height;

      const pageObj = pageItem.pageInfo || {};
      const cropX = Number(pageObj.ContentArea?.X || pageObj.Rect?.X || 0);
      const cropY = Number(pageObj.ContentArea?.Y || pageObj.Rect?.Y || 0);

      const canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;

      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.imageSmoothingEnabled = false;
      ctx.mozImageSmoothingEnabled = false;
      ctx.webkitImageSmoothingEnabled = false;
      ctx.msImageSmoothingEnabled = false;

      if (!pageItem.isScrambled) {
        ctx.drawImage(imgElement, cropX, cropY, targetW, targetH, 0, 0, targetW, targetH);
      } else {
        const blocks = getBlocks(pageItem.pageInfo, rawW, rawH);
        for (let i = 0; i < blocks.length; i++) {
          const b = blocks[i];
          ctx.drawImage(
            imgElement,
            b.destX, b.destY, b.width, b.height,
            b.srcX - cropX, b.srcY - cropY, b.width, b.height
          );
        }
      }

      const mimeType = isJpg ? 'image/jpeg' : 'image/png';
      const outExt = isJpg ? 'jpg' : 'png';
      const blob = await new Promise(r => canvas.toBlob(r, mimeType, quality));

      canvas.width = 0; canvas.height = 0;

      return {
        fileName: `${pageItem.pageNo}.${outExt}`,
        data: new Uint8Array(await blob.arrayBuffer())
      };
    }

    return {
      PublusCoordsGenerator,
      computePattern,
      decryptConfigurationPack,
      calcU2F,
      getImgURLHash,
      getBlocks,
      unscrambleBookWalkerImage
    };
  })();

  (typeof globalThis !== 'undefined' ? globalThis : window).PublusTools = PublusTools;
})(typeof window !== 'undefined' ? window : this);