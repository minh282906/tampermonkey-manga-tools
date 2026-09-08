// cores/MangaUtils.js
(function(global) {
  'use strict';

  const MangaUtils = {
    // 1. Tải ArrayBuffer bằng GM_xmlhttpRequest (Vượt mọi rào cản CORS)
    fetchBuffer: function(url, headers = {}) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "GET",
          url: url,
          responseType: "arraybuffer",
          headers: { "Referer": location.href, ...headers },
          timeout: 30000,
          onload: res => (res.status >= 200 && res.status < 300 && res.response) ? resolve(res.response) : reject(new Error(`HTTP ${res.status}`)),
          onerror: () => reject(new Error("Lỗi tải dữ liệu mạng")),
          ontimeout: () => reject(new Error("Timeout tải dữ liệu"))
        });
      });
    },

    // 2. Nhận diện định dạng thực tế từ chữ ký nhị phân Magic Bytes
    detectMimeType: function(bufferOrArray) {
      if (!bufferOrArray) return 'image/jpeg';
      const u = bufferOrArray instanceof Uint8Array ? bufferOrArray : new Uint8Array(bufferOrArray);
      if (u.byteLength < 4) return 'image/jpeg';

      if (u[0] === 0xFF && u[1] === 0xD8) return 'image/jpeg';
      if (u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4E && u[3] === 0x47) return 'image/png';
      if (u[0] === 0x52 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x46) return 'image/webp';
      if (u.byteLength >= 12 && u[4] === 0x66 && u[5] === 0x74 && u[6] === 0x79 && u[7] === 0x70) return 'image/avif';

      return 'image/jpeg';
    },

    detectExt: function(buffer) {
      const mime = this.detectMimeType(buffer);
      if (mime === 'image/png') return 'png';
      if (mime === 'image/webp') return 'webp';
      if (mime === 'image/avif') return 'avif';
      return 'jpg';
    },

    // 3. Chuẩn hóa giải mã ảnh đồ họa (createImageBitmap + Zero Color Loss)
    loadImage: async function(bufferOrBlob, fallbackMime = 'image/jpeg') {
      let blob;
      if (bufferOrBlob instanceof Blob) {
        blob = bufferOrBlob;
      } else if (typeof bufferOrBlob === 'string') {
        return new Promise((resolve, reject) => {
          const img = new Image();
          img.decoding = "async";
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = bufferOrBlob;
        });
      } else {
        const buffer = (bufferOrBlob instanceof ArrayBuffer) ? bufferOrBlob : bufferOrBlob?.buffer;
        const mime = buffer ? this.detectMimeType(buffer) : fallbackMime;
        blob = new Blob([bufferOrBlob], { type: mime });
      }

      // Ưu tiên số 1: createImageBitmap khóa cứng colorSpaceConversion
      if (typeof createImageBitmap === 'function') {
        try {
          const bitmap = await createImageBitmap(blob, {
            colorSpaceConversion: 'none',
            premultiplyAlpha: 'none'
          });

          try {
            if (!bitmap.naturalWidth) {
              Object.defineProperty(bitmap, 'naturalWidth', { get: () => bitmap.width, configurable: true });
              Object.defineProperty(bitmap, 'naturalHeight', { get: () => bitmap.height, configurable: true });
            }
          } catch (e) {}

          return bitmap;
        } catch (optErr) {
          try {
            const bitmap = await createImageBitmap(blob);
            try {
              if (!bitmap.naturalWidth) {
                Object.defineProperty(bitmap, 'naturalWidth', { get: () => bitmap.width, configurable: true });
                Object.defineProperty(bitmap, 'naturalHeight', { get: () => bitmap.height, configurable: true });
              }
            } catch (e) {}
            return bitmap;
          } catch (fallbackErr) {}
        }
      }

      // Dự phòng an toàn: new Image()
      return new Promise((resolve, reject) => {
        const objUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.decoding = "async";
        img.onload = () => {
          URL.revokeObjectURL(objUrl);
          resolve(img);
        };
        img.onerror = (e) => {
          URL.revokeObjectURL(objUrl);
          reject(e);
        };
        img.src = objUrl;
      });
    },

    // 4. Quản lý Worker Pool tải song song
    runParallelQueue: async function(tasks, limit, onProgress) {
      const results = new Array(tasks.length);
      let completed = 0;
      let index = 0;
      const workers = Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
        while (index < tasks.length) {
          const currentIndex = index++;
          try {
            results[currentIndex] = await tasks[currentIndex]();
          } catch (err) {
            results[currentIndex] = null;
          } finally {
            completed++;
            if (onProgress) onProgress(completed, tasks.length);
          }
        }
      });
      await Promise.all(workers);
      return results;
    }
  };

  (typeof globalThis !== 'undefined' ? globalThis : window).MangaUtils = MangaUtils;
})(typeof window !== 'undefined' ? window : this);