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
    detectMimeType: function(buffer) {
      if (!buffer || buffer.byteLength < 4) return 'image/jpeg';
      const u = new Uint8Array(buffer);
      if (u[0] === 0xFF && u[1] === 0xD8) return 'image/jpeg';
      if (u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4E && u[3] === 0x47) return 'image/png';
      if (u[0] === 0x52 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x46) return 'image/webp';
      return 'image/jpeg';
    },

    detectExt: function(buffer) {
      const mime = this.detectMimeType(buffer);
      if (mime === 'image/png') return 'png';
      if (mime === 'image/webp') return 'webp';
      return 'jpg';
    },

    // 3. Chuyển ArrayBuffer thành HTML Image an toàn trong RAM (Chống tràn bộ nhớ)
    loadImage: function(bufferOrBlob, fallbackMime = 'image/jpeg') {
      return new Promise((resolve, reject) => {
        let mime = fallbackMime;
        if (bufferOrBlob instanceof ArrayBuffer) {
          mime = this.detectMimeType(bufferOrBlob);
        }
        const blob = bufferOrBlob instanceof Blob ? bufferOrBlob : new Blob([bufferOrBlob], { type: mime });
        const objUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.decoding = "async";
        img.onload = () => { URL.revokeObjectURL(objUrl); resolve(img); };
        img.onerror = (e) => { URL.revokeObjectURL(objUrl); reject(e); };
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