// decoders/AlphapolisTools.js
(function(global) {
  'use strict';

  const AlphapolisTools = (() => {
    // 1. Bóc tách mảng key từ placeholder (Steganography)
    function extractKeys(placeholderBase64) {
      if (!placeholderBase64 || typeof placeholderBase64 !== 'string') return [];
      const cleanB64 = placeholderBase64.replace(/^data:image\/[a-zA-Z]+;base64,/, '').trim();
      const rawStr = atob(cleanB64);
      const raw = new Uint8Array(rawStr.length);
      for (let i = 0; i < rawStr.length; i++) raw[i] = rawStr.charCodeAt(i);

      const keys = [];
      let pos = 33; // Vượt qua 8B PNG Signature + 25B IHDR Chunk

      while (pos + 2 <= raw.length) {
        const count = raw[pos] | (raw[pos + 1] << 8);
        const length = count * 8;
        const dataStart = pos + 2;
        const dataEnd = dataStart + length;

        if (dataEnd > raw.length) break;
        keys.push(raw.slice(dataStart, dataEnd));
        pos = dataEnd;
      }
      return keys;
    }

    // 2. Bộ sinh ma trận tọa độ hoán vị (100% Thuần toán học - Chuẩn PublusTools)
    function getAlphapolisCoords(rawW, rawH, keyBytes) {
      if (!keyBytes || keyBytes.byteLength < 8) {
        return { outW: rawW, outH: rawH, rawW, rawH, isScrambled: false, coords: [] };
      }

      const key = new DataView(keyBytes.buffer, keyBytes.byteOffset, keyBytes.byteLength);
      const firstValue = key.getInt32(0, true);
      const secondValue = key.getInt32(4, true);

      const tileSize = (secondValue >>> 24) & 0xFF;   // 240px
      const paddingWidth = (firstValue >>> 27) & 7;   // 1px

      if (tileSize === 0) {
        return { outW: rawW, outH: rawH, rawW, rawH, isScrambled: false, coords: [] };
      }

      const cols = Math.ceil(rawW / tileSize);
      const rows = Math.ceil(rawH / tileSize);
      const doublePadding = paddingWidth * 2;
      const baseTileSize = tileSize - doublePadding; // 238px
      const outW = rawW - (cols * doublePadding);
      const outH = rawH - (rows * doublePadding);
      const lastCol = cols - 1;
      const lastRow = rows - 1;

      const tileCount = Math.floor(key.byteLength / 8);
      const coords = [];

      for (let idx = 0; idx < tileCount; idx++) {
        const offset = idx * 8;
        const tileConfigV = key.getInt32(offset, true);
        const tileConfigHa = key.getInt32(offset + 4, true);

        const isMirrored = (tileConfigV & 1) !== 0;
        const rotationSteps = (tileConfigV >>> 1) & 3; // 0, 1, 2, 3 -> 0, -90, -180, -270 deg
        const destTop = (tileConfigV >>> 3) & 4095;
        const destLeft = (tileConfigV >>> 15) & 4095;
        const sourceRow = (tileConfigHa >>> 8) & 0xFF;
        const sourceCol = (tileConfigHa >>> 16) & 0xFF;

        const currentTileWidth = (baseTileSize !== 0 && Math.floor(destLeft / baseTileSize) === lastCol ? outW - destLeft : baseTileSize) + doublePadding;
        const currentTileHeight = (baseTileSize !== 0 && Math.floor(destTop / baseTileSize) === lastRow ? outH - destTop : baseTileSize) + doublePadding;

        const drawWidth = (rotationSteps % 2 === 1) ? currentTileHeight : currentTileWidth;
        const drawHeight = (rotationSteps % 2 === 1) ? currentTileWidth : currentTileHeight;

        const drawX = destLeft - paddingWidth;
        const drawY = destTop - paddingWidth;

        const sourceX = Math.max(0, Math.min(sourceCol * tileSize, rawW));
        const sourceY = Math.max(0, Math.min(sourceRow * tileSize, rawH));
        const cropWidth = Math.max(0, Math.min(drawWidth, rawW - sourceX));
        const cropHeight = Math.max(0, Math.min(drawHeight, rawH - sourceY));

        if (cropWidth <= 0 || cropHeight <= 0) continue;

        coords.push({
          sourceX, sourceY, cropWidth, cropHeight,
          drawX, drawY, drawWidth, drawHeight,
          rotationSteps, isMirrored
        });
      }

      return {
        outW, outH, rawW, rawH,
        paddingWidth, tileSize, cols, rows,
        isScrambled: true,
        coords
      };
    }

    return {
      extractKeys,
      getAlphapolisCoords
    };
  })();

  (typeof globalThis !== 'undefined' ? globalThis : window).AlphapolisTools = AlphapolisTools;
})(typeof window !== 'undefined' ? window : this);