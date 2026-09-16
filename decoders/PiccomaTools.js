// decoders/PiccomaTools.js
(function(global) {
  'use strict';

  const PiccomaTools = (() => {
    /**
     * Bóc tách chuỗi băm Checksum động từ URL ảnh CDN của Piccoma
     * Cấu trúc URL: https://.../dna/.../[checksum]/image.jpg?expires=[timestamp]
     * @param {string} url - URL ảnh cần bóc tách
     * @returns {string} Chuỗi Checksum
     */
    function getChecksum(url) {
      if (!url || typeof url !== 'string') return '';
      try {
        const clean = url.split('?')[0].split('#')[0];
        const parts = clean.split('/').filter(Boolean);
        // Bóc tách phân đoạn kế cuối (bất chấp độ sâu thư mục phía trước)
        return parts.length >= 2 ? parts[parts.length - 2] : '';
      } catch (e) {
        return '';
      }
    }

    /**
     * Thuật toán dịch vòng chuỗi (Circular Shift) thuần toán học
     * Băm hạt giống thô dựa trên tổng các chữ số của tham số thời gian expires
     * @param {string} checksum - Chuỗi checksum từ URL
     * @param {string} expires - Tham số thời gian expires từ Query String
     * @returns {string} Hạt giống thô (Shifted Seed) chuẩn bị nạp vào Wasm dd()
     */
    function getSeed(checksum, expires) {
      if (!checksum) return '';
      if (!expires) return checksum;

      let sum = 0;
      for (let i = 0; i < expires.length; i++) {
        const digit = parseInt(expires[i], 10);
        if (!isNaN(digit)) sum += digit;
      }

      const shift = sum % checksum.length;
      if (shift === 0) return checksum;
      return checksum.slice(-shift) + checksum.slice(0, -shift);
    }

    /**
     * Bóc tách trọn bộ cặp tham số [checksum, expires] và sinh hạt giống thô từ URL
     * @param {string} url - URL ảnh CDN
     * @returns {{checksum: string, expires: string, rawSeed: string}}
     */
    function parseUrlSeedParams(url) {
      const checksum = getChecksum(url);
      const match = url ? url.match(/[?&]expires=([0-9]+)/) : null;
      const expires = match ? match[1] : '';
      const rawSeed = getSeed(checksum, expires);
      return { checksum, expires, rawSeed };
    }

    return {
      getChecksum,
      getSeed,
      parseUrlSeedParams
    };
  })();

  (typeof globalThis !== 'undefined' ? globalThis : window).PiccomaTools = PiccomaTools;
})(typeof window !== 'undefined' ? window : this);