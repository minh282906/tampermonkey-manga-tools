// decoders/ClipStudioTools.js
(function(global) {
  'use strict';

  const ClipStudioTools = (() => {
    /**
     * 1. Giải mã nhị phân: Dò tìm khóa XOR 1-byte qua Magic Bytes (Known Plaintext Attack)
     */
    function decryptBinary(bufferOrArray) {
      if (!bufferOrArray) return new Uint8Array(0);
      const data = bufferOrArray instanceof Uint8Array ? bufferOrArray : new Uint8Array(bufferOrArray);
      if (data.length < 4) return data;

      // TH1: Ảnh không bị mã hóa byte (như Firecross)
      const isCleanJpeg = data[0] === 0xFF && data[1] === 0xD8;
      const isCleanPng = data[0] === 0x89 && data[1] === 0x50;
      if (isCleanJpeg || isCleanPng) {
        return data;
      }

      // TH2: Mã hóa XOR 1-byte (như ComicDC, Hakusensha)
      let key = null;
      const possibleJpegKey = data[0] ^ 0xFF;
      if ((data[1] ^ possibleJpegKey) === 0xD8) {
        key = possibleJpegKey;
      } else {
        const possiblePngKey = data[0] ^ 0x89;
        if ((data[1] ^ possiblePngKey) === 0x50) {
          key = possiblePngKey;
        }
      }

      if (key === null) return data;

      const decrypted = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) {
        decrypted[i] = data[i] ^ key;
      }
      return decrypted;
    }

    /**
     * 2. Bóc tách thông số ma trận (Cột, Hàng, Tổng trang) từ file face.xml
     */
    function parseFaceXml(xmlString) {
      if (!xmlString || typeof xmlString !== 'string') {
        return { cols: 4, rows: 4, totalPages: null };
      }

      let cols = 4, rows = 4, totalPages = null;

      const mTotal = xmlString.match(/<TotalPage>(\d+)<\/TotalPage>/i);
      if (mTotal) totalPages = parseInt(mTotal[1], 10);

      const mScramble = xmlString.match(/<Scramble>[\s\S]*?<Width>(\d+)<\/Width>[\s\S]*?<Height>(\d+)<\/Height>[\s\S]*?<\/Scramble>/i);
      if (mScramble) {
        cols = parseInt(mScramble[1], 10) || 4;
        rows = parseInt(mScramble[2], 10) || 4;
      }

      return { cols, rows, totalPages };
    }

    /**
     * 3. Bóc tách mảng hoán vị Scramble từ chuỗi XML của từng trang {index}.xml
     */
    function parseScrambleXml(xmlString) {
      if (!xmlString || typeof xmlString !== 'string') {
        return Array.from({ length: 16 }, (_, i) => i);
      }

      const match = xmlString.match(/<Scramble>([\d,]+)<\/Scramble>/i);
      if (match && match[1]) {
        const arr = match[1].split(',').map(n => parseInt(n.trim(), 10)).filter(n => !isNaN(n));
        if (arr.length > 0) return arr;
      }

      return Array.from({ length: 16 }, (_, i) => i);
    }

    /**
     * 4. Tính toán ma trận tọa độ Celsys Clip Studio Reader chuẩn mực
     */
    function calculateCoords(width, height, scramblePattern, customCols = null, customRows = null) {
      const len = Array.isArray(scramblePattern) ? scramblePattern.length : 16;
      let cols = 4, rows = 4;

      if (customCols && customRows && customCols * customRows === len) {
        cols = customCols;
        rows = customRows;
      } else if (len === 16) {
        cols = 4;
        rows = 4;
      } else if (len === 704) {
        cols = 22;
        rows = 32;
      } else if (len === 780) {
        cols = 26;
        rows = 30;
      } else if (len === 2295) {
        cols = 45;
        rows = 51;
      } else {
        const sqrt = Math.round(Math.sqrt(len));
        if (sqrt * sqrt === len) {
          cols = sqrt;
          rows = sqrt;
        } else {
          const targetRatio = height / width;
          let bestDiff = Infinity;
          for (let c = 1; c <= len; c++) {
            if (len % c === 0) {
              const r = len / c;
              const diff = Math.abs((r / c) - targetRatio);
              if (diff < bestDiff) {
                bestDiff = diff;
                cols = c;
                rows = r;
              }
            }
          }
        }
      }

      // QUY CHUẨN GỐC CỦA CELSYS: TỪNG Ô BẮT BUỘC LÀ BỘI SỐ CỦA 8PX!
      const pieceWidth = 8 * Math.floor(Math.floor(width / cols) / 8);
      const pieceHeight = 8 * Math.floor(Math.floor(height / rows) / 8);

      const gridW = pieceWidth * cols;
      const gridH = pieceHeight * rows;
      const dummyW = Math.max(0, width - gridW);
      const dummyH = Math.max(0, height - gridH);

      const coords = [];
      const pattern = Array.isArray(scramblePattern) ? scramblePattern : Array.from({ length: len }, (_, i) => i);

      for (let destIndex = 0; destIndex < pattern.length; destIndex++) {
        const destX = (destIndex % cols) * pieceWidth;
        const destY = Math.floor(destIndex / cols) * pieceHeight;

        const srcIndex = pattern[destIndex];
        const srcX = (srcIndex % cols) * pieceWidth;
        const srcY = Math.floor(srcIndex / cols) * pieceHeight;

        coords.push({
          srcX,
          srcY,
          destX,
          destY,
          width: pieceWidth,
          height: pieceHeight
        });
      }

      return {
        coords,
        pieceWidth,
        pieceHeight,
        gridW,
        gridH,
        dummyW,
        dummyH,
        cols,
        rows
      };
    }

    return {
      decryptBinary,
      parseFaceXml,
      parseScrambleXml,
      calculateCoords
    };
  })();

  (typeof globalThis !== 'undefined' ? globalThis : window).ClipStudioTools = ClipStudioTools;
})(typeof window !== 'undefined' ? window : this);