// decoders/SharpEblievaTools.js
(function (global) {
  'use strict';

  const SharpEblievaTools = (() => {
    /* =========================================================================
     * THUẬT TOÁN GỐC NGUYÊN BẢN CỦA SHARP (ImageDecryptMgr)
     * ========================================================================= */
    function lT(t, e) {
      const i = Math.floor(t / e);
      return 0 === i ? e : (t % e > Math.floor(e / 2) ? (i + 1) * e : i * e);
    }

    function nT(t, e) {
      return lT(Math.floor(t / 2), e);
    }

    function oT(t, e, i) {
      const s = Math.floor((t - i - 1) / ((e - 2) * i)) * i;
      const r = Math.floor(lT(Math.floor(t * (e - 2) / e), i * (e - 2)) / (e - 2));
      return r <= s ? r : s;
    }

    function rT(w, h, e, i) {
      const s = oT(w, e, 16);
      const r = oT(h, i, 16);
      return {
        Yy: e,
        Qy: i,
        tT: nT(w - s * (e - 2), 16),
        eT: nT(h - r * (i - 2), 16),
        iT: s,
        sT: r
      };
    }

    function parseSequence(coordStr) {
      if (!coordStr || typeof coordStr !== 'string') return null;
      const h = coordStr.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      const a = h.length;
      if (a < 3) return null;

      const l = new Int32Array(a);
      l[0] = h[0];
      l[1] = h[1];
      for (let t = 2; t < a; t++) {
        l[t] = h[t] + l[t - 1] - l[t - 2];
      }
      return l;
    }

    function descrambleVariantA(mainImg, coordStr, b1Img = null, b2Img = null) {
      const w = mainImg.naturalWidth || mainImg.width;
      const h = mainImg.naturalHeight || mainImg.height;

      const rawCanvas = document.createElement('canvas');
      rawCanvas.width = w; rawCanvas.height = h;
      const rCtx = rawCanvas.getContext('2d', { alpha: false });
      rCtx.imageSmoothingEnabled = false;
      rCtx.drawImage(mainImg, 0, 0);

      const l = parseSequence(coordStr);
      if (!l) {
        return {
          sharpCanvas: rawCanvas, visualCanvas: rawCanvas, rawCanvas,
          img: mainImg, isScrambled: false, rawW: w, rawH: h, gridW: w, gridH: h,
          dummyText: "Không có xáo trộn ma trận"
        };
      }

      const a = l.length;
      const gridWidth = l[a - 2];
      const gridHeight = l[a - 1];
      const c = rT(w, h, gridWidth, gridHeight);

      const u = [], _ = [], d = c.Yy - 1;
      for (let e = 0; e <= d; e++) {
        u[e] = 0 === e ? 0 : u[e - 1] + _[e - 1];
        _[e] = 0 === e ? c.tT : (e < d ? c.iT : w - u[e]);
      }

      const f = [], wArr = [], g = c.Qy - 1;
      for (let e = 0; e <= g; e++) {
        f[e] = 0 === e ? 0 : f[e - 1] + wArr[e - 1];
        wArr[e] = 0 === e ? c.eT : (e < g ? c.sT : h - f[e]);
      }

      const sharpCanvas = document.createElement('canvas');
      sharpCanvas.width = w; sharpCanvas.height = h;
      const sCtx = sharpCanvas.getContext('2d', { alpha: false });
      sCtx.imageSmoothingEnabled = false;
      sCtx.mozImageSmoothingEnabled = false;
      sCtx.webkitImageSmoothingEnabled = false;
      sCtx.msImageSmoothingEnabled = false;

      const R = Math.floor((a - 2) / 2);
      for (let e = 0; e < a - 2; e++) {
        const i = e < R ? 2 * (e + 1) : 2 * (e - R) + 1;
        const s = (i - 1) % c.Yy;
        const r = Math.floor((i - 1) / c.Yy);
        const o = l[e];
        const hCol = (o - 1) % c.Yy;
        const aRow = Math.floor((o - 1) / c.Yy);

        sCtx.save();
        sCtx.beginPath();
        sCtx.rect(u[hCol], f[aRow], _[hCol], wArr[aRow]);
        sCtx.clip();
        sCtx.drawImage(mainImg, u[s], f[r], _[s], wArr[r], u[hCol], f[aRow], _[hCol], wArr[aRow]);
        sCtx.restore();
      }

      let m = 0;
      if (b1Img) {
        const b1H = b1Img.naturalHeight || b1Img.height;
        m = Math.floor(b1H / (2 * c.Qy - 2));
        if (m > 0) {
          for (let t = 1; t < c.Qy; t++) {
            sCtx.save();
            sCtx.beginPath();
            sCtx.rect(0, f[t] - m, w, 2 * m);
            sCtx.clip();
            sCtx.drawImage(b1Img, 0, (2 * t - 2) * m, w, 2 * m, 0, f[t] - m, w, 2 * m);
            sCtx.restore();
          }
        }
      }

      if (b2Img) {
        const b2W = b2Img.naturalWidth || b2Img.width;
        const E = Math.floor(b2W / (2 * c.Yy - 2));
        if (E > 0) {
          let tAcc = 0, eAcc = 0;
          for (let i = 0; i < c.Qy; i++) {
            eAcc += tAcc;
            const s = 0 === i ? 0 : f[i] + m;
            tAcc = wArr[i] - (0 === i || i === c.Qy - 1 ? 1 : 2) * m;
            for (let j = 1; j < c.Yy; j++) {
              sCtx.save();
              sCtx.beginPath();
              sCtx.rect(u[j] - E, s, 2 * E, tAcc);
              sCtx.clip();
              sCtx.drawImage(b2Img, (2 * j - 2) * E, eAcc, 2 * E, tAcc, u[j] - E, s, 2 * E, tAcc);
              sCtx.restore();
            }
          }
        }
      }

      const visualCanvas = document.createElement('canvas');
      visualCanvas.width = w; visualCanvas.height = h;
      const vCtx = visualCanvas.getContext('2d', { alpha: false });
      vCtx.imageSmoothingEnabled = false;
      vCtx.drawImage(sharpCanvas, 0, 0);

      vCtx.strokeStyle = '#ff007f';
      vCtx.lineWidth = 1;
      for (let r = 0; r < c.Qy; r++) {
        for (let col = 0; col < c.Yy; col++) {
          vCtx.strokeRect(u[col], f[r], _[col], wArr[r]);
        }
      }

      vCtx.strokeStyle = '#00ffff';
      vCtx.lineWidth = 4;
      vCtx.strokeRect(0, 0, w, h);

      return {
        sharpCanvas, visualCanvas, rawCanvas, img: mainImg,
        rawW: w, rawH: h, gridW: w, gridH: h,
        dummyText: `Khớp ma trận ${c.Yy}x${c.Qy} ô (Đã vá Seam b1 & b2)`,
        isScrambled: true
      };
    }

    /* =========================================================================
     * THUẬT TOÁN GIẢI MÃ PHÂN ĐOẠN GALAPAGOS (SegmentedImageJson)
     * ========================================================================= */
    function decryptGalapagosJsonp(text, keyItem) {
      const start = text.indexOf('"');
      const end = text.lastIndexOf('"');
      if (start === -1 || end === -1) throw new Error("Không thể trích xuất chuỗi từ JSONP");

      const rawStr = text.substring(start + 1, end).replace(/\\"/g, '"');
      const decryptedStr = keyItem.Dp(rawStr);
      return JSON.parse(decryptedStr);
    }

    async function stitchGalapagosCanvas(pageData, Utils) {
      const header = pageData.h || "";
      const slices = pageData.d.map(chunk => header + chunk);
      const cols = pageData.c || 3;

      const rawImages = await Promise.all(slices.map(uri => Utils.loadImage(uri, 'image/jpeg')));

      const rows = Math.ceil(rawImages.length / cols);
      const colWidths = [];
      const rowHeights = [];

      for (let c = 0; c < cols; c++) colWidths[c] = rawImages[c]?.width || 0;
      for (let r = 0; r < rows; r++) rowHeights[r] = rawImages[r * cols]?.height || 0;

      const totalW = colWidths.reduce((a, b) => a + b, 0);
      const totalH = rowHeights.reduce((a, b) => a + b, 0);

      // 1. sharpCanvas (Bản sạch Lossless)
      const sharpCanvas = document.createElement('canvas');
      sharpCanvas.width = totalW; sharpCanvas.height = totalH;
      const sCtx = sharpCanvas.getContext('2d', { alpha: false });
      sCtx.imageSmoothingEnabled = false;

      let idx = 0, curY = 0;
      for (let r = 0; r < rows; r++) {
        let curX = 0;
        const rh = rowHeights[r];
        for (let c = 0; c < cols; c++) {
          const img = rawImages[idx++];
          if (img && (img.width || img.naturalWidth)) {
            sCtx.drawImage(img, curX, curY);
          }
          curX += colWidths[c];
        }
        curY += rh;
      }

      // 2. rawCanvas (Hiển thị 9 mảnh phân đoạn có viền lưới hồng tách biệt rõ 9 ô)
      const rawCanvas = document.createElement('canvas');
      rawCanvas.width = totalW; rawCanvas.height = totalH;
      const rCtx = rawCanvas.getContext('2d', { alpha: false });
      rCtx.imageSmoothingEnabled = false;
      rCtx.drawImage(sharpCanvas, 0, 0);

      rCtx.strokeStyle = '#ff007f';
      rCtx.lineWidth = 1.5;
      let yL = 0;
      for (let r = 0; r < rows; r++) {
        let xL = 0;
        const rh = rowHeights[r];
        for (let c = 0; c < cols; c++) {
          rCtx.strokeRect(xL, yL, colWidths[c], rh);
          xL += colWidths[c];
        }
        yL += rh;
      }
      rCtx.strokeStyle = '#00ffff';
      rCtx.lineWidth = 4;
      rCtx.strokeRect(0, 0, totalW, totalH);

      // 3. visualCanvas (Soi Live)
      const visualCanvas = document.createElement('canvas');
      visualCanvas.width = totalW; visualCanvas.height = totalH;
      const vCtx = visualCanvas.getContext('2d', { alpha: false });
      vCtx.imageSmoothingEnabled = false;
      vCtx.drawImage(sharpCanvas, 0, 0);

      vCtx.strokeStyle = '#00ffff';
      vCtx.lineWidth = 4;
      vCtx.strokeRect(0, 0, totalW, totalH);

      return {
        sharpCanvas, visualCanvas, rawCanvas, img: sharpCanvas,
        rawW: totalW, rawH: totalH, gridW: totalW, gridH: totalH,
        dummyText: `Phân đoạn ${cols}x${rows} lát (${totalW}x${totalH}px)`,
        isScrambled: true
      };
    }

    return {
      descrambleVariantA,
      decryptGalapagosJsonp,
      stitchGalapagosCanvas
    };
  })();

  (typeof globalThis !== 'undefined' ? globalThis : window).SharpEblievaTools = SharpEblievaTools;
})(typeof window !== 'undefined' ? window : this);