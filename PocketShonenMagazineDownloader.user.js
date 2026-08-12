// ==UserScript==
// @name         Pocket Shonen Magazine ripper
// @namespace    https://tampermonkey.net/
// @icon         https://pocket.shonenmagazine.com/img/favicon.ico
// @version      1.1.0
// @author       Fuku
// @description  Download Pocket Shonen Magazine episode
// @match        https://pocket.shonenmagazine.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      mgpk-cdn.magazinepocket.com
// @connect      api.pocket.shonenmagazine.com
// ==/UserScript==

(function pocketShonenDownloader() {
  "use strict";

  const WIN = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const DOC = WIN.document;

  /* =========================================================================
   * 1. CONFIG & STATE
   * ========================================================================= */
  const CONFIG = {
    MAX_CONCURRENT: 24,
    GRID_SIZE: 4,
  };

  const state = {
    running: false,
    ui: null,
    episodeData: null,
    lastProgress: {
      completed: 0,
      total: 0,
      percent: 0,
      status: "Dang cho du lieu tap...",
    },
  };

  /* =========================================================================
   * 2. FETCH HOOK + MESSAGE BRIDGE
   * ========================================================================= */
  function injectFetchHook() {
    const script = DOC.createElement("script");
    script.textContent = `
      (() => {
        const originalFetch = window.fetch;
        window.fetch = async (...args) => {
          const response = await originalFetch(...args);
          try {
            const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
            if (url?.includes('/web/episode/viewer')) {
              const data = await response.clone().json();
              if (Array.isArray(data.page_list)) {
                window.postMessage(
                  {
                    type: 'POCKET_PAGE_LIST',
                    pages: data.page_list,
                    seed: data.scramble_seed,
                    ver: data.scramble_ver,
                    mangaId: data.title_id,
                    episodeId: data.episode_id
                  },
                  '*'
                );
              }
            }
          } catch {}
          return response;
        };
      })();
    `;
    DOC.documentElement.appendChild(script);
  }

  function onPageListMessage(e) {
    if (e.data?.type !== "POCKET_PAGE_LIST") return;

    state.episodeData = {
      pages: e.data.pages,
      seed: e.data.seed,
      ver: e.data.ver,
      mangaId: e.data.mangaId,
      episodeId: e.data.episodeId,
    };

    createUI();
    if (state.ui?.panel) {
      state.ui.panel.style.display = "block";
    }

    updateProgressUI({
      completed: 0,
      total: state.episodeData.pages.length,
      status: "San sang.",
    });
  }

  /* =========================================================================
   * 3. DESCRAMBLE
   * ========================================================================= */
  const CHARSET_EVEN = "svdk0m7acl";
  const CHARSET_ODD = "q6jtf2xnog";
  const MULTIPLE_NUM = 8;

  async function descrambleImage(
    blob,
    seed,
    ver,
    mangaId,
    episodeId,
    grid = 4,
  ) {
    const img = await loadImage(blob);
    const canvas = DOC.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;

    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.imageSmoothingEnabled = false;

    let finalSeed = seed;
    if (typeof seed === "string") {
      const charset = mangaId % 2 === 0 ? CHARSET_EVEN : CHARSET_ODD;
      finalSeed = ComputeSeed32(seed, charset, mangaId, episodeId);
    }

    // ShonenMagazine uses the same scrambling algorithm as CiaoPlus v2, but reports scramble_version as 1.
    // We force logic for v2 (ComputeGridBlockDimensions) if it's pocket shonen (implied by this script).
    // In the TS reference, ver is set to -1.
    // If ver is 1 coming from API, we treat it as -1 for dimension calculation if it follows the TS logic comment.
    // "ShonenMagazine ... reports scramble_version as 1. Set version to -1 here"
    const effectiveVer = -1;
    const i =
      effectiveVer === 1
        ? ComputeLCMBlockDimensions(img.width, img.height, grid)
        : ComputeGridBlockDimensions(img.width, img.height, grid);

    if (!i) return blob;

    ctx.drawImage(img, 0, 0);
    const mapping = GenerateScrambleMapping(grid, finalSeed);

    for (const c of mapping) {
      ctx.drawImage(
        img,
        c.source.x * i.width,
        c.source.y * i.height,
        i.width,
        i.height,
        c.dest.x * i.width,
        c.dest.y * i.height,
        i.width,
        i.height,
      );
    }

    return new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.95));
  }

  function* xorshift(seed) {
    const x = Uint32Array.of(seed);
    while (true) {
      x[0] ^= x[0] << 13;
      x[0] ^= x[0] >>> 17;
      x[0] ^= x[0] << 5;
      yield x[0];
    }
  }

  function ShuffleArrayWithPRNG(array, seed) {
    const t = xorshift(seed);
    return array
      .map((r) => [t.next().value, r])
      .sort((r, i) => +(r[0] > i[0]) - +(i[0] > r[0]))
      .map((r) => r[1]);
  }

  function GenerateScrambleMapping(gridSize, seed) {
    const indices = [...Array(gridSize ** 2)].map((_, r) => r);
    const shuffled = ShuffleArrayWithPRNG(indices, seed);

    return shuffled.map((s, r) => ({
      source: {
        x: s % gridSize,
        y: Math.floor(s / gridSize),
      },
      dest: {
        x: r % gridSize,
        y: Math.floor(r / gridSize),
      },
    }));
  }

  function GetLeastCommonMultiple(a, b) {
    const t = function (s, r) {
      return s ? t(r % s, s) : r;
    };
    return (a * b) / t(a, b);
  }

  function ComputeLCMBlockDimensions(width, height, gridSize) {
    if (width < gridSize || height < gridSize) {
      return null;
    }
    const s = GetLeastCommonMultiple(gridSize, MULTIPLE_NUM);
    if (width > s && height > s) {
      width = Math.floor(width / s) * s;
      height = Math.floor(height / s) * s;
    }
    return {
      width: Math.floor(width / gridSize),
      height: Math.floor(height / gridSize),
    };
  }

  function ComputeGridBlockDimensions(width, height, gridSize) {
    if (width < gridSize * MULTIPLE_NUM || height < gridSize * MULTIPLE_NUM) {
      return null;
    }
    const s = Math.floor(width / MULTIPLE_NUM);
    const r = Math.floor(height / MULTIPLE_NUM);
    const i = Math.floor(s / gridSize);
    const c = Math.floor(r / gridSize);
    return {
      width: i * MULTIPLE_NUM,
      height: c * MULTIPLE_NUM,
    };
  }

  function ComputeSeed32(seed, charset, titleId, episodeId) {
    let parsedInt = 0n;
    for (const char of seed) {
      const index = charset.indexOf(char);
      if (index !== -1) {
        parsedInt = parsedInt * 10n + BigInt(index);
      } else {
        break;
      }
    }

    const parsedUInt32 = Number(parsedInt & 0xffffffffn);
    const combined = (titleId >>> 0) + (episodeId >>> 0);
    return (parsedUInt32 ^ combined) >>> 0;
  }

  function loadImage(blob) {
    return new Promise((res, rej) => {
      const img = new WIN.Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = WIN.URL.createObjectURL(blob);
    });
  }

  /* =========================================================================
   * 4. DOWNLOAD FLOW
   * ========================================================================= */
  function getEpisodeTitle() {
    const el = DOC.querySelector("h2.p-episode__header-ttl");
    if (!el) return "pocket-episode";

    return el.textContent
      .trim()
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, " ");
  }

  async function startDownload() {
    if (state.running) return;
    if (!state.episodeData?.pages?.length) {
      updateProgressUI({ status: "Chua co du lieu page_list." });
      return;
    }

    state.running = true;
    setUiBusy(true);

    const { pages, seed, ver, mangaId, episodeId } = state.episodeData;

    try {
      updateProgressUI({
        completed: 0,
        total: pages.length,
        status: "Dang nap JSZip...",
      });
      await ensureJSZip();

      const JSZipCtor = WIN.JSZip?.default || WIN.JSZip || unsafeWindow?.JSZip;
      if (!JSZipCtor) {
        throw new Error("JSZip not found");
      }

      const zip = new JSZipCtor();
      const tasks = pages.map((url, i) => async () => {
        const blob = await fetchBlob(url);
        const finalBlob = seed
          ? await descrambleImage(
              blob,
              seed,
              ver,
              mangaId,
              episodeId,
              CONFIG.GRID_SIZE,
            )
          : blob;
        return {
          name: `${String(i + 1).padStart(3, "0")}.jpg`,
          blob: finalBlob,
        };
      });

      const results = await runWithConcurrency(
        tasks,
        CONFIG.MAX_CONCURRENT,
        (done, total) => {
          updateProgressUI({ completed: done, total, status: "Dang tai..." });
        },
      );

      updateProgressUI({
        completed: pages.length,
        total: pages.length,
        status: "Dang dong goi ZIP...",
      });

      for (const r of results) {
        if (r?.blob) {
          zip.file(r.name, r.blob);
        }
      }

      const content = await zip.generateAsync({ type: "blob" });
      const title = getEpisodeTitle();
      triggerDownload(content, `${title}.zip`);

      updateProgressUI({
        completed: pages.length,
        total: pages.length,
        status: "Hoan tat!",
      });
    } catch (e) {
      console.error("[pocket-dl] Download failed", e);
      updateProgressUI({ status: `Loi: ${e?.message || e}` });
    } finally {
      state.running = false;
      setUiBusy(false);
      updateProgressUI(state.lastProgress);
    }
  }

  async function runWithConcurrency(tasks, limit, onProgress) {
    const results = new Array(tasks.length);
    let index = 0;
    let completed = 0;

    async function worker() {
      while (index < tasks.length) {
        const current = index++;
        try {
          results[current] = await tasks[current]();
        } catch (e) {
          results[current] = null;
        }
        completed++;
        onProgress?.(completed, tasks.length);
      }
    }

    const workers = Array.from(
      { length: Math.min(limit, tasks.length) },
      worker,
    );
    await Promise.all(workers);
    return results;
  }

  /* =========================================================================
   * 5. UI (GIGAVIEWER STYLE)
   * ========================================================================= */
  function updateProgressUI(data = {}) {
    const total = Number.isFinite(data.total)
      ? data.total
      : state.lastProgress.total;
    const completed = Number.isFinite(data.completed)
      ? data.completed
      : state.lastProgress.completed;
    const pct =
      total > 0
        ? Math.max(0, Math.min(100, Math.round((completed / total) * 100)))
        : 0;

    state.lastProgress = {
      completed,
      total,
      percent: pct,
      status: data.status || state.lastProgress.status,
    };

    const ui = state.ui;
    if (!ui) return;

    ui.count.textContent = `${completed}/${total}`;
    ui.percent.textContent = `${pct}%`;
    ui.fill.style.transform = `scaleX(${pct / 100})`;
    ui.status.textContent = state.lastProgress.status;
  }

  function setUiBusy(isBusy) {
    const ui = state.ui;
    if (!ui) return;

    ui.button.disabled = Boolean(isBusy);
    ui.button.textContent = isBusy ? "Dang xu ly..." : "Download";
    ui.button.style.opacity = isBusy ? "0.72" : "1";
    ui.button.style.cursor = isBusy ? "progress" : "pointer";
  }

  function createUI() {
    if (state.ui || !DOC.body) return;

    const panel = DOC.createElement("div");
    panel.id = "pocket-dl-panel";
    panel.style.cssText = [
      "all:initial",
      "position:fixed",
      "right:0px",
      "top:62px",
      "z-index:2147483647",
      "box-sizing:border-box",
      "width:220px",
      "padding:10px 14px",
      "border:1px solid #4338ca",
      "border-radius:10px",
      "background:#0f172a",
      "color:#ffffff",
      'font:12px/1.3 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      "user-select:none",
      "box-shadow:0 8px 24px rgba(0,0,0,0.85)",
      "display:none",
    ].join(";");

    const title = DOC.createElement("div");
    title.textContent = "Pocket Downloader";
    title.style.cssText =
      "all:initial;display:block;color:#818cf8;font:800 13px system-ui;margin-bottom:8px;text-align:center;";

    const btn = DOC.createElement("button");
    btn.type = "button";
    btn.textContent = "Download";
    btn.style.cssText = [
      "all:initial",
      "display:block",
      "box-sizing:border-box",
      "width:100%",
      "padding:8px 0",
      "border:0",
      "border-radius:6px",
      "background:#6366f1",
      "color:#ffffff",
      "font:700 14px/1.2 system-ui,sans-serif",
      "text-align:center",
      "cursor:pointer",
      "box-shadow:0 3px 10px rgba(99, 102, 241, 0.35)",
    ].join(";");
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      startDownload();
    });

    const progressRow = DOC.createElement("div");
    progressRow.style.cssText =
      "all:initial;display:flex;justify-content:space-between;align-items:center;margin-top:10px;color:#ffffff;font:800 12px system-ui;";

    const countText = DOC.createElement("span");
    countText.textContent = "0/0";
    countText.style.cssText =
      "all:initial;color:#ffffff;font:800 12px system-ui;";

    const percentText = DOC.createElement("span");
    percentText.textContent = "0%";
    percentText.style.cssText =
      "all:initial;color:#ffffff;font:800 12px system-ui;";

    progressRow.append(countText, percentText);

    const track = DOC.createElement("div");
    track.style.cssText =
      "all:initial;display:block;height:6px;overflow:hidden;border-radius:3px;background:#1e1b4b;margin-top:6px;";

    const fill = DOC.createElement("div");
    fill.style.cssText =
      "all:initial;display:block;width:100%;height:100%;background:#818cf8;transform:scaleX(0);transform-origin:left center;transition:transform .22s ease;";
    track.appendChild(fill);

    const statusText = DOC.createElement("div");
    statusText.textContent = state.lastProgress.status;
    statusText.style.cssText =
      "all:initial;display:block;margin-top:8px;color:#c7d2fe;font:11px system-ui;word-break:break-word;";

    panel.append(title, btn, progressRow, track, statusText);

    state.ui = {
      panel,
      button: btn,
      count: countText,
      percent: percentText,
      fill,
      status: statusText,
    };

    DOC.body.appendChild(panel);
    updateProgressUI(state.lastProgress);
  }

  /* =========================================================================
   * 6. HELPERS
   * ========================================================================= */
  function fetchBlob(url) {
    return new Promise((res, rej) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "blob",
        onload: (r) =>
          r.status === 200
            ? res(r.response)
            : rej(new Error(`Status: ${r.status}`)),
        onerror: (e) => rej(e),
      });
    });
  }

  function triggerDownload(blob, name) {
    const a = DOC.createElement("a");
    a.href = WIN.URL.createObjectURL(blob);
    a.download = name;
    a.click();
    WIN.URL.revokeObjectURL(a.href);
  }

  async function ensureJSZip() {
    if (WIN.JSZip) return;
    await new Promise((res) => {
      const s = DOC.createElement("script");
      s.src =
        "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
      s.onload = res;
      DOC.head.appendChild(s);
    });
  }

  /* =========================================================================
   * 7. BOOT
   * ========================================================================= */
  function boot() {
    injectFetchHook();
    WIN.addEventListener("message", onPageListMessage);

    const ready = () => createUI();
    if (DOC.readyState === "loading") {
      DOC.addEventListener("DOMContentLoaded", ready);
      return;
    }
    ready();
  }

  boot();
})();
