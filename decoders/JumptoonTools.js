// decoders/JumptoonTools.js
const JumptoonTools = (() => {
  'use strict';

  // Hai bộ thông số rãnh đệm và lát cắt dọc của Shueisha Jumptoon
  const ALGORITHM_CONFIGS = {
    V1: { splitWidth: 12, paddingWidth: 3, blankWidth: 3 }, // Chu kỳ l = 21px
    V2: { splitWidth: 20, paddingWidth: 15, blankWidth: 1 } // Chu kỳ l = 51px
  };

  /**
   * 1. Tính toán hạt giống Seed từ chuỗi `${seriesId}:${number}`
   */
  function computeSeed(seriesId, number) {
    if (!seriesId || number === undefined || number === null) return 0;
    const key = `${seriesId}:${number}`;
    let seed = 0;
    for (let i = 0; i < key.length; i++) {
      seed += key.codePointAt(i);
    }
    return seed >>> 0;
  }

  /**
   * 2. Bộ sinh số ngẫu nhiên LCG (Linear Congruential Generator)
   */
  function createLCG(seed) {
    let state = seed >>> 0;
    return {
      next: () => {
        state = (1664525 * state + 1013904223) % 4294967296;
        return state;
      }
    };
  }

  /**
   * 3. Hoán vị Fisher-Yates Shuffle mảng các dải cột
   */
  function shuffleIndices(seed, numSlices, hasRemainder) {
    const indices = Array.from({ length: numSlices }, (_, idx) => idx);
    let shuffleCount = numSlices;
    if (hasRemainder) shuffleCount--; // Nếu có dải dư thì dải cuối cùng được giữ cố định

    const lcg = createLCG(seed);
    for (let i = shuffleCount; i > 1; i--) {
      const randIdx = lcg.next() % i;
      const temp = indices[randIdx];
      indices[randIdx] = indices[i - 1];
      indices[i - 1] = temp;
    }
    return indices;
  }

  /**
   * 4. Tính toán ma trận tọa độ gọt rãnh đệm và ráp dải cột
   * Trả về danh sách lát cắt: [{ srcX, srcY, width, height, destX, destY }]
   */
  function calculateCoords(seed, algorithmType, targetW, rawW, targetH) {
    const cfg = ALGORITHM_CONFIGS[algorithmType] || ALGORITHM_CONFIGS.V2;
    const { splitWidth: a, blankWidth: n, paddingWidth: o } = cfg;

    const pitch = a + n + 2 * o; // Bước nhảy một khối trên ảnh raw CDN
    const numSlices = Math.floor(rawW / pitch);
    const remainderW = targetW % a;

    // Sinh mảng hoán vị
    const shuffled = shuffleIndices(seed, numSlices, remainderW !== 0);

    // Tính mảng ánh xạ nghịch đảo (Inverse mapping)
    const invMap = new Array(numSlices);
    for (let i = 0; i < numSlices; i++) {
      invMap[shuffled[i]] = i;
    }

    const coords = [];

    // Các dải cột chuẩn
    for (let destIndex = 0; destIndex < numSlices; destIndex++) {
      const srcBlockIndex = invMap[destIndex];
      const srcX = srcBlockIndex * pitch + o; // Bỏ qua rãnh đệm trái (o)
      const destX = destIndex * a;

      coords.push({
        srcX: srcX,
        srcY: 0,
        width: a,
        height: targetH,
        destX: destX,
        destY: 0
      });
    }

    // Dải mép dư nếu có (Remainder)
    if (remainderW > 0) {
      const srcX = numSlices * pitch + o;
      const destX = numSlices * a;

      coords.push({
        srcX: srcX,
        srcY: 0,
        width: remainderW,
        height: targetH,
        destX: destX,
        destY: 0
      });
    }

    return {
      coords,
      numSlices,
      pitch,
      algorithmType: algorithmType || 'V2'
    };
  }

  return {
    computeSeed,
    calculateCoords
  };
})();

if (typeof window !== 'undefined') window.JumptoonTools = JumptoonTools;
if (typeof globalThis !== 'undefined') globalThis.JumptoonTools = JumptoonTools;