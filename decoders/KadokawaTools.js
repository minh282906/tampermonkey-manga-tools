// decoders/KadokawaTools.js
(function(global) {
  'use strict';

  const KadokawaTools = (() => {
    /**
     * Bóc tách mã hash DRM từ URL ảnh (Dùng cho Niconico Manga và Kadokawa CDN)
     * @param {string} url - URL ảnh cần bóc tách
     * @returns {string|null} Chuỗi hash DRM 16-hex
     */
    function extractDrmHashFromUrl(url) {
      if (!url || typeof url !== 'string') return null;
      const match = url.match(/\/image\/([a-f0-9]+_\d+|[a-f0-9]{30,}|[a-z0-9_]+)/i);
      if (!match) return null;
      return match[1].split('_')[0];
    }

    /**
     * Thuật toán giải mã Cyclic 8-byte Bitwise XOR độc quyền của Kadokawa / Dwango
     * @param {Uint8Array|ArrayBuffer} bufferOrArray - Mảng byte nhị phân đã mã hóa
     * @param {string} drmHash - Chuỗi hash khóa DRM (tối thiểu 16 ký tự hex)
     * @returns {Uint8Array} Mảng byte nhị phân đã giải mã
     */
    function decryptKadokawaXor(bufferOrArray, drmHash) {
      if (!drmHash || typeof drmHash !== 'string' || drmHash.length < 16) {
        return bufferOrArray instanceof Uint8Array ? bufferOrArray : new Uint8Array(bufferOrArray);
      }

      try {
        const hexKey = drmHash.substring(0, 16);
        const keyBytes = new Uint8Array(8);
        for (let i = 0; i < 8; i++) {
          keyBytes[i] = parseInt(hexKey.substring(i * 2, i * 2 + 2), 16);
        }

        if (isNaN(keyBytes[0])) {
          return bufferOrArray instanceof Uint8Array ? bufferOrArray : new Uint8Array(bufferOrArray);
        }

        const rawUint8 = bufferOrArray instanceof Uint8Array ? bufferOrArray : new Uint8Array(bufferOrArray);
        const decrypted = new Uint8Array(rawUint8.length);

        for (let i = 0; i < rawUint8.length; i++) {
          decrypted[i] = rawUint8[i] ^ keyBytes[i % 8];
        }

        return decrypted;
      } catch (e) {
        return bufferOrArray instanceof Uint8Array ? bufferOrArray : new Uint8Array(bufferOrArray);
      }
    }

    return {
      extractDrmHashFromUrl,
      decryptKadokawaXor
    };
  })();

  (typeof globalThis !== 'undefined' ? globalThis : window).KadokawaTools = KadokawaTools;
})(typeof window !== 'undefined' ? window : this);