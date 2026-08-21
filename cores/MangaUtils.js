// core/MangaUtils.js
(function(global) {
  'use strict';

  const MangaUtils = {
    // 1. Tải ArrayBuffer bằng GM_xmlhttpRequest
    fetchBuffer: function(url, headers = {}) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "GET",
          url: url,
          responseType: "arraybuffer",
          headers: { "Referer": location.href, ...headers },
          timeout: 25000,
          onload: res => (res.status >= 200 && res.status < 300 && res.response) ? resolve(res.response) : reject(new Error(`HTTP ${res.status}`)),
          onerror: () => reject(new Error("Lỗi tải dữ liệu mạng")),
          ontimeout: () => reject(new Error("Timeout tải dữ liệu"))
        });
      });
    },

    // 2. Chuyển ArrayBuffer thành HTML Image đã nạp xong (onload)
    loadImage: function(bufferOrBlob, mimeType = 'image/jpeg') {
      return new Promise((resolve, reject) => {
        const blob = bufferOrBlob instanceof Blob ? bufferOrBlob : new Blob([bufferOrBlob], { type: mimeType });
        const objUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.decoding = "async";
        img.onload = () => { URL.revokeObjectURL(objUrl); resolve(img); };
        img.onerror = (e) => { URL.revokeObjectURL(objUrl); reject(e); };
        img.src = objUrl;
      });
    },

    // 3. Quản lý hàng đợi tải song song (Worker Pool) truyền được số luồng 4 hoặc 6
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

  if (typeof window !== 'undefined') window.MangaUtils = MangaUtils;
  if (typeof unsafeWindow !== 'undefined') unsafeWindow.MangaUtils = MangaUtils;
  if (typeof globalThis !== 'undefined') globalThis.MangaUtils = MangaUtils;
  global.MangaUtils = MangaUtils;
})(typeof window !== 'undefined' ? window : this);