// cores/RouteWatcher.js
(function(global) {
  'use strict';

  function initRouteWatcher(onRouteChange) {
    if (typeof onRouteChange !== 'function') return;

    let lastUrl = window.location.href;

    const checkUrl = () => {
      const currentUrl = window.location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        onRouteChange(currentUrl);
      }
    };

    // Bắt sự kiện chuyển trang ngầm (SPA History Push/Replace)
    const origPush = window.history.pushState;
    window.history.pushState = function(...args) {
      origPush.apply(this, args);
      checkUrl();
    };

    const origReplace = window.history.replaceState;
    window.history.replaceState = function(...args) {
      origReplace.apply(this, args);
      checkUrl();
    };

    // Bắt sự kiện nút Back/Forward và đổi Hash (#)
    window.addEventListener("popstate", checkUrl);
    window.addEventListener("hashchange", checkUrl);

    // Dự phòng Polling kiểm tra mỗi 500ms
    window.setInterval(checkUrl, 500);
  }

  // GÁN BIẾN 4 TẦNG AN TOÀN TUYỆT ĐỐI
  if (typeof window !== 'undefined') window.initRouteWatcher = initRouteWatcher;
  if (typeof unsafeWindow !== 'undefined') unsafeWindow.initRouteWatcher = initRouteWatcher;
  if (typeof globalThis !== 'undefined') globalThis.initRouteWatcher = initRouteWatcher;
  global.initRouteWatcher = initRouteWatcher;
})(typeof window !== 'undefined' ? window : this);