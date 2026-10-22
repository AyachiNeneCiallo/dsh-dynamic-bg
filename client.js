/**
 * dsh-dynamic-bg —— 客户端半区（纯 DOM，零第三方依赖）。
 *
 * 渲染策略：
 *   视频层固定全屏、z-index:-1（在内容之下）；
 *   同时把 html / body / #root / 主框架背景改成透明，
 *   否则 DSH 自带的不透明背景会把视频层完全盖住。
 *
 * 按钮：左下角 🎞，可拖拽到任意位置，位置存 localStorage。
 */
window.__ModuleLoader__.load({
  id: "dsh-dynamic-bg",
  factory: () => {
    var exports = {};

    var LAYER_ID = "dsh-dynamic-bg-layer";
    var UI_ID = "dsh-dynamic-bg-ui";
    var STYLE_ID = "dsh-dynamic-bg-style";
    var POS_KEY = "dsh-dynamic-bg-pos";
    var DB_NAME = "dsh-dynamic-bg";
    var STORE = "videos";
    var META_KEY = "__meta__";

    /* ---------------- 透明化样式（仅聊天界面生效） ---------------- */
    // 所有规则都挂在 html.dshbg-on 下：只有判定当前在聊天主界面时才加这个类，
    // 进入设置页 / 插件市场等页面时会移除，恢复 DSH 原本的背景。
    function injectStyle() {
      if (document.getElementById(STYLE_ID)) return;
      var st = document.createElement("style");
      st.id = STYLE_ID;
      st.textContent = [
        // 聊天区 + 左侧会话栏透明，透出壁纸；
        // 右栏、底栏、设置页等其它区域保持 DSH 原生背景。
        "html.dshbg-on, html.dshbg-on body { background: transparent !important; }",
        "html.dshbg-on #root { background: transparent !important; }",
        "html.dshbg-on {",
        "  --dsw-alias-bg-base: transparent !important;",
        "  --dsw-specific-sidebar-fill: transparent !important;",
        "  --dsw-alias-bg-layer-1: transparent !important;",
        "  --dsw-alias-bg-layer-2: transparent !important;",
        "  --dsw-alias-bg-layer-3: transparent !important;",
        "  --dsw-alias-bg-layer-4: transparent !important;",
        "  --dsw-alias-bg-l1: transparent !important;",
        "  --dsw-alias-bg-l2: transparent !important;",
        "  --dsw-alias-fill-l1: transparent !important;",
        "  --dsw-alias-fill-l2: transparent !important;",
        "  --dsw-alias-bg-module-platform: transparent !important;",
        "  --dsw-alias-markdown-code-block: transparent !important;",
        "  --dsw-menu-surface-fill: rgba(255,255,255,.68) !important;",
        "  --dsw-hovercard-bg: rgba(255,255,255,.74) !important;",
        "}",
        "html.dshbg-on [class*='_frame'], html.dshbg-on [class*='_centerCol'],",
        "html.dshbg-on [class*='_sidebarCol'], html.dshbg-on [class*='_bottomRow'] {",
        "  background: transparent !important;",
        "}",
        // 右栏（代码 / diff / 预览）加一层很淡的白色蒙层：
        // 壁纸仍然透出来，但代码区域被提亮，深色文字更清楚。
        "html.dshbg-on [class*='_rightbarCol'] {",
        "  background: rgba(255,255,255,.45) !important;",
        "}",
        "html.dshbg-on [class*='_frame']::before { background: transparent !important; }",
        // 深度透明开启时，输入框改成毛玻璃：透出壁纸又不影响打字可读性
        "html.dshbg-on.dshbg-clear [data-composer-card] {",
        "  background: rgba(255,255,255,.38) !important;",
        "  backdrop-filter: blur(14px) saturate(1.15) !important;",
        "  -webkit-backdrop-filter: blur(14px) saturate(1.15) !important;",
        "}",
      ].join("\n");
      (document.head || document.documentElement).appendChild(st);
    }

    /* ---------------- 实色兜底（给代码预览区用） ---------------- */
    // 在启用透明之前，先把主题原本的底色记下来，右栏代码/预览区用它做不透明背景。
    var solidColor = null;
    function captureSolidColor() {
      if (solidColor) return;
      try {
        var cs = window.getComputedStyle(document.documentElement);
        var v = (cs.getPropertyValue("--dsw-alias-bg-base") || "").trim();
        if (!v || v === "transparent") {
          v = (cs.getPropertyValue("--dsw-specific-sidebar-fill") || "").trim();
        }
        if (v && v !== "transparent") solidColor = v;
      } catch (e) {}
      if (!solidColor) solidColor = "rgba(28,28,33,.96)";
      try {
        document.documentElement.style.setProperty("--dshbg-solid", solidColor);
      } catch (e) {}
    }

    /* ---------------- 视图判定 ---------------- */    // 聊天界面的特征：composer 输入区存在、可见，且**没有被其它页面盖住**。
    // 设置页 / 插件市场等整页视图常常是覆盖层，composer 仍留在 DOM 里，
    // 所以只判断“存在且可见”会把设置页误判成聊天界面。
    function isChatView() {
      try {
        var c = document.querySelector(
          "[data-composer-input],[data-composer-seat],[data-composer-card]"
        );
        if (!c) return false;
        var r = c.getBoundingClientRect();
        if (r.width < 60 || r.height < 10) return false;
        var cs = window.getComputedStyle(c);
        if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;

        // 只看输入框是否还在：设置是居中弹层，聊天页并没有离开，
        // 弹层打开时应当继续保留壁纸。
        // 真正切走（插件市场等整页视图）时 composer 会被卸载/隐藏。
        return true;
      } catch (e) {
        return false;
      }
    }

    /**
     * 把「占据较大面积且背景不透明」的容器改成透明。
     * 只在聊天视图下执行，并记录原值，离开聊天界面时完整还原。
     */
    var lastCleared = 0;
    var touched = [];

    // 主题可能在切换会话/重渲染时把背景 token 写回 root 的 inline 样式，
    // 这里每次清理都重新断言一遍，并备份原值以便离开聊天界面时还原。
    var ROOT_VARS = [
      ["--dsw-alias-bg-base", "transparent"],
      ["--dsw-specific-sidebar-fill", "transparent"],
      ["--dsw-alias-bg-layer-1", "transparent"],
      ["--dsw-alias-bg-layer-2", "transparent"],
      ["--dsw-alias-bg-layer-3", "transparent"],
      ["--dsw-alias-bg-layer-4", "transparent"],
      ["--dsw-alias-bg-l1", "transparent"],
      ["--dsw-alias-bg-l2", "transparent"],
      ["--dsw-alias-fill-l1", "transparent"],
      ["--dsw-alias-fill-l2", "transparent"],
      ["--dsw-alias-bg-module-platform", "transparent"],
      ["--dsw-alias-markdown-code-block", "transparent"],
      ["--dsw-alias-settings-card-fill", "transparent"],
      ["--dsw-alias-onboarding-card-fill", "transparent"],
      ["--dsw-alias-onboarding-secondary-fill", "transparent"],
      ["--dsw-menu-surface-fill", "rgba(255,255,255,.68)"],
      ["--dsw-hovercard-bg", "rgba(255,255,255,.74)"],
    ];
    var rootVarBackup = null;

    function varTargets() {
      var list = [];
      if (document.documentElement) list.push(document.documentElement);
      if (document.body) list.push(document.body);
      return list;
    }

    // 需要强制透明的“画布层”：主题/宿主可能在这些元素上写 inline !important 背景
    var surfaceBackups = null;

    function makeSurfaceTransparent() {
      var els = [document.documentElement, document.body, document.getElementById("root")];
      if (!surfaceBackups) surfaceBackups = [];
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (!el || !el.style) continue;
        var tag = i; // 用下标定位，元素可能被替换
        surfaceBackups.push([
          tag,
          el.style.getPropertyValue("background-color"),
          el.style.getPropertyPriority("background-color"),
          el.style.getPropertyValue("background-image"),
          el.style.getPropertyPriority("background-image"),
        ]);
        el.style.setProperty("background-color", "transparent", "important");
        el.style.setProperty("background-image", "none", "important");
      }
    }

    function restoreSurfaces() {
      if (!surfaceBackups) return;
      var els = [document.documentElement, document.body, document.getElementById("root")];
      for (var i = 0; i < surfaceBackups.length; i++) {
        var rec = surfaceBackups[i];
        var el = els[rec[0]];
        if (!el || !el.style) continue;
        try {
          if (rec[1]) el.style.setProperty("background-color", rec[1], rec[2] || "");
          else el.style.removeProperty("background-color");
          if (rec[3]) el.style.setProperty("background-image", rec[3], rec[4] || "");
          else el.style.removeProperty("background-image");
        } catch (e) {}
      }
      surfaceBackups = null;
    }

    function enforceRootVars() {
      // 变量写在 #root 上（不是 html/body）：
      // DSH 主题会把背景 token 以 inline !important 写在 html/body 上，
      // 作者样式表压不过它；但主题不会去改 #root 的 inline 样式，
      // 所以把覆盖下沉一层既生效又不会被反复改写（不会闪）。
      try {
        var root = document.getElementById("root");
        if (!root || !root.style) return;
        if (!rootVarBackup) {
          rootVarBackup = [];
          for (var i = 0; i < ROOT_VARS.length; i++) {
            var name = ROOT_VARS[i][0];
            rootVarBackup.push([
              name,
              root.style.getPropertyValue(name),
              root.style.getPropertyPriority(name),
            ]);
          }
        }
        for (var j = 0; j < ROOT_VARS.length; j++) {
          root.style.setProperty(ROOT_VARS[j][0], ROOT_VARS[j][1], "important");
        }
        // 画布层（html/body/#root）也必须透明，否则侧栏透明后看到的是它们的底色
        makeSurfaceTransparent();
      } catch (e) {}
    }

    function restoreRootVars() {
      restoreSurfaces();
      if (!rootVarBackup) return;
      try {
        var root = document.getElementById("root");
        if (root && root.style) {
          for (var i = 0; i < rootVarBackup.length; i++) {
            var rec = rootVarBackup[i];
            if (rec[1]) root.style.setProperty(rec[0], rec[1], rec[2] || "");
            else root.style.removeProperty(rec[0]);
          }
        }
      } catch (e) {}
      rootVarBackup = null;
    }

    /* ---- 深度透明：把仍然不透明、面积够大的面板底色清掉 ----
     * 只靠 CSS 变量和固定选择器，覆盖不到按钮组、卡片、标题条这类组件，
     * 而 DSH 改版后类名还会变。这里改成运行时按「计算样式 + 面积」判定，
     * 只要够大且不透明就清掉，并记录原值以便随时还原。
     */
    var clearedEls = [];
    var clearedSet = typeof WeakSet === "function" ? new WeakSet() : null;
    var sweepTimer = 0;

    /** 解析 rgb()/rgba() 的 alpha；非 rgba 视为不透明。 */
    function alphaOf(color) {
      if (!color || color === "transparent") return 0;
      var m = /rgba?\(([^)]+)\)/.exec(color);
      if (!m) return 1;
      var parts = m[1].split(",");
      if (parts.length < 4) return 1;
      var a = parseFloat(parts[3]);
      return isNaN(a) ? 1 : a;
    }

    /** 不该被清掉的东西：交互控件、媒体、输入区，以及插件自己的图层。 */
    function isProtectedEl(el) {
      var tag = el.tagName;
      if (tag === "BUTTON" || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
          tag === "OPTION" || tag === "IMG" || tag === "VIDEO" || tag === "CANVAS" ||
          tag === "SVG" || tag === "PATH" || tag === "IFRAME") return true;
      if (el.isContentEditable) return true;
      var role = el.getAttribute && el.getAttribute("role");
      if (role && /button|checkbox|switch|tab|menuitem|option|slider|radio|dialog|tooltip/.test(role)) return true;
      if (el.closest) {
        if (el.closest("#" + LAYER_ID) || el.closest("#" + UI_ID)) return true;
        // 真正的输入控件区域保留，避免把光标所在的可编辑区弄透
        if (el.closest("[data-composer-input],[data-composer-seat]")) return true;
      }
      return false;
    }

    function clearOne(el, cs) {
      try {
        var rec = {
          el: el,
          bg: el.style.getPropertyValue("background-color"),
          bgPri: el.style.getPropertyPriority("background-color"),
          img: el.style.getPropertyValue("background-image"),
          imgPri: el.style.getPropertyPriority("background-image"),
          hadGradient: /gradient/.test(cs.backgroundImage),
        };
        el.style.setProperty("background-color", "transparent", "important");
        if (rec.hadGradient) el.style.setProperty("background-image", "none", "important");
        clearedEls.push(rec);
        if (clearedSet) clearedSet.add(el);
        return true;
      } catch (e) {
        return false;
      }
    }

    function restoreCleared() {
      for (var i = 0; i < clearedEls.length; i++) {
        var rec = clearedEls[i];
        try {
          var el = rec.el;
          if (!el || !el.style) continue;
          if (rec.bg) el.style.setProperty("background-color", rec.bg, rec.bgPri || "");
          else el.style.removeProperty("background-color");
          if (rec.hadGradient) {
            if (rec.img) el.style.setProperty("background-image", rec.img, rec.imgPri || "");
            else el.style.removeProperty("background-image");
          }
        } catch (e) {}
      }
      clearedEls = [];
      clearedSet = typeof WeakSet === "function" ? new WeakSet() : null;
      lastCleared = 0;
    }

    function sweepOpaque() {
      if (!meta.autoClear) return;
      var on = false;
      try { on = document.documentElement.classList.contains("dshbg-on"); } catch (e) { on = true; }
      if (!on) return;
      var root = document.getElementById("root");
      if (!root) return;

      // 先维护已清理过的元素：React 重渲染可能把背景写回来，补一次即可
      var alive = [];
      for (var j = 0; j < clearedEls.length; j++) {
        var rec = clearedEls[j];
        try {
          if (!rec.el || !rec.el.isConnected) continue;
          if (rec.el.style.getPropertyValue("background-color") !== "transparent") {
            rec.el.style.setProperty("background-color", "transparent", "important");
          }
          alive.push(rec);
        } catch (e) {}
      }
      clearedEls = alive;

      var vw = window.innerWidth || 1280;
      var vh = window.innerHeight || 800;
      var minArea = vw * vh * (meta.clearMinArea == null ? 0.01 : meta.clearMinArea);
      var all = root.getElementsByTagName("*");
      var limit = Math.min(all.length, 6000);
      for (var i = 0; i < limit; i += 1) {
        var el = all[i];
        if (clearedSet && clearedSet.has(el)) continue;
        if (isProtectedEl(el)) continue;
        var w = el.offsetWidth;
        var h = el.offsetHeight;
        if (w < 40 || h < 24 || w * h < minArea) continue;
        var cs;
        try { cs = window.getComputedStyle(el); } catch (e) { continue; }
        if (cs.visibility === "hidden" || cs.display === "none") continue;
        if (Number(cs.opacity) === 0) continue;
        var a = alphaOf(cs.backgroundColor);
        var grad = /gradient/.test(cs.backgroundImage);
        if (a <= 0.5 && !grad) continue;   // 半透明蒙层（比如右栏 45%）保留
        clearOne(el, cs);
      }
      lastCleared = clearedEls.length;
    }

    function scheduleSweep() {
      if (!meta.autoClear) return;
      if (sweepTimer) return;
      sweepTimer = setTimeout(function () {
        sweepTimer = 0;
        sweepOpaque();
      }, 400);
    }

    function clearBigBackgrounds() {
      // 由 CSS 变量 + 下面的运行时清扫共同完成，这里只负责触发
      scheduleSweep();
      return lastCleared;
    }

    /** 深度透明开关变化时立即生效：开 → 清一遍；关 → 全部还原。 */
    function applyClearMode() {
      var on = meta.autoClear !== false;
      try {
        document.documentElement.classList.toggle("dshbg-clear", modeOn && on);
      } catch (e) {}
      if (!on) restoreCleared();
      else if (modeOn) sweepOpaque();
    }

    function restoreBackgrounds() {
      for (var i = 0; i < touched.length; i++) {
        var rec = touched[i];
        try {
          var el = rec.el;
          if (!el || !el.style) continue;
          if (rec.bgColor) el.style.setProperty("background-color", rec.bgColor, rec.bgPriority || "");
          else el.style.removeProperty("background-color");
          if (rec.bgImage) el.style.setProperty("background-image", rec.bgImage, rec.bgImagePriority || "");
          else el.style.removeProperty("background-image");
          el.__dshbgTouched = false;
        } catch (e) {}
      }
      touched = [];
      lastCleared = 0;
      restoreCleared();
      restoreRootVars();
    }

    var modeOn = false;
    var chatHits = 0;
    var nonChatHits = 0;

    function applyMode(chat) {
      if (chat === modeOn) {
        if (chat) clearBigBackgrounds();
        return;
      }
      modeOn = chat;
      try {
        document.documentElement.classList.toggle("dshbg-on", chat);
        document.documentElement.classList.toggle("dshbg-clear", chat && meta.autoClear !== false);
      } catch (e) {}
      if (chat) {
        enforceRootVars();
        clearBigBackgrounds();
      } else {
        // 离开聊天界面：还原所有被改过的容器（设置页保持 DSH 原样）
        restoreBackgrounds();
        restoreRootVars();
      }
    }

    // 视图判定带滞后：进入聊天要连续 2 次命中，离开要连续 3 次，
    // 避免覆盖层动画/浮层导致 true/false 抖动，从而反复透明/还原。
    function syncMode(force) {
      var chat = isChatView();
      if (force) {
        chatHits = 0;
        nonChatHits = 0;
        applyMode(chat);
        return;
      }
      if (chat) { chatHits++; nonChatHits = 0; }
      else { nonChatHits++; chatHits = 0; }
      if (!modeOn && chatHits >= 2) applyMode(true);
      else if (modeOn && nonChatHits >= 3) applyMode(false);
      else if (modeOn) clearBigBackgrounds();
    }

    var observer = null;
    var syncTimer = 0;
    function scheduleSync() {
      if (syncTimer) return;
      syncTimer = setTimeout(function () {
        syncTimer = 0;
        // 用带滞后的判定，避免覆盖层/浮层让视图判定抖动
        syncMode(false);
        // DOM 变了就顺带清扫一次，新出现的面板也能被透明化
        scheduleSweep();
      }, 300);
    }
    function watchView() {
      if (observer) return;
      try {
        observer = new MutationObserver(scheduleSync);
        observer.observe(document.documentElement, { childList: true, subtree: true });
      } catch (e) {}
    }

    /* ---------------- IndexedDB ---------------- */
    function openDb() {
      return new Promise(function (resolve, reject) {
        var req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    }
    function dbGet(key) {
      return openDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(STORE, "readonly");
          var r = tx.objectStore(STORE).get(key);
          r.onsuccess = function () { resolve(r.result); };
          r.onerror = function () { reject(r.error); };
        });
      });
    }
    function dbPut(key, value) {
      return openDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).put(value, key);
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { reject(tx.error); };
        });
      });
    }
    function dbDelete(key) {
      return openDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).delete(key);
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { reject(tx.error); };
        });
      });
    }
    function dbList() {
      return openDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(STORE, "readonly");
          var store = tx.objectStore(STORE);
          var kq = store.getAllKeys();
          var vq = store.getAll();
          tx.oncomplete = function () {
            var keys = kq.result || [];
            var vals = vq.result || [];
            var out = [];
            for (var i = 0; i < keys.length; i++) {
              if (keys[i] !== META_KEY) out.push({ key: keys[i], value: vals[i] });
            }
            resolve(out);
          };
          tx.onerror = function () { reject(tx.error); };
        });
      });
    }

    /* ---------------- 背景层 ---------------- */
    function removeLayer() {
      stopScene();
      var old = document.getElementById(LAYER_ID);
      if (old) {
        var v = old.querySelector("video");
        if (v && v.src) { try { URL.revokeObjectURL(v.src); } catch (e) {} }
        old.remove();
      }
    }
    function ensureLayer() {
      removeLayer();
      var layer = document.createElement("div");
      layer.id = LAYER_ID;
      var s = layer.style;
      s.position = "fixed";
      s.top = "0"; s.left = "0"; s.right = "0"; s.bottom = "0";
      s.zIndex = "-1";
      s.pointerEvents = "none";
      s.overflow = "hidden";
      s.background = "#000";
      (document.body || document.documentElement).prepend(layer);
      return layer;
    }
    function mountVideo(blob, meta) {
      var layer = ensureLayer();
      var video = document.createElement("video");
      video.src = URL.createObjectURL(blob);
      video.loop = true;
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute("muted", "");
      var s = video.style;
      s.position = "absolute";
      s.top = "0"; s.left = "0";
      s.width = "100%"; s.height = "100%";
      s.objectFit = meta.fit || "cover";
      s.opacity = String(meta.opacity == null ? 1 : meta.opacity);
      layer.appendChild(video);

      // 白色遮罩：叠在视频之上、页面内容之下（0 = 不遮）
      var scrim = document.createElement("div");
      var ss = scrim.style;
      ss.position = "absolute";
      ss.top = "0"; ss.left = "0"; ss.width = "100%"; ss.height = "100%";
      ss.background = "#fff";
      ss.pointerEvents = "none";
      ss.opacity = String(meta.scrim == null ? 0.35 : meta.scrim);
      layer.appendChild(scrim);

      var p = video.play();
      if (p && p.catch) p.catch(function () {});
      return video;
    }
    function applyMeta(meta) {
      if (!meta || !meta.enabled || !meta.activeKey) { removeLayer(); return Promise.resolve(); }
      return dbGet(meta.activeKey).then(function (rec) {
        if (!rec) { removeLayer(); return; }

        // Wallpaper Engine 场景：交给 WebGL 渲染
        if (rec.kind === "we") {
          if (!rec.dir) { removeLayer(); return; }
          injectStyle();
          watchView();
          if (isChatView()) syncMode(true); else syncMode();
          // 同一个场景只更新外观，避免拖动滑块时反复重载几 MB 贴图
          if (sceneMountedDir === rec.dir && sceneApply) {
            sceneApply(meta);
            renderStatus();
            return;
          }
          return mountScene(meta, rec).catch(function (e) {
            sceneStatus = { ok: false, text: String((e && e.message) || e), width: 0, height: 0 };
            removeLayer();
          });
        }

        if (!rec.blob) { removeLayer(); return; }
        injectStyle();
        watchView();
        if (isChatView()) syncMode(true); else syncMode();
        mountVideo(rec.blob, meta);
      }).catch(function () { removeLayer(); });
    }

    /* ---------------- Wallpaper Engine 场景（WebGL） ---------------- */
    var WE_API = "/api/dsh-dynamic-bg/";
    var sceneStop = null;
    var sceneApply = null;          // 已挂载场景的外观更新钩子（亮度/遮罩）
    var sceneMountedDir = "";       // 当前已挂载的场景目录，避免重复加载贴图
    var sceneStatus = { ok: false, text: "未使用", width: 0, height: 0 };

    function stopScene() {
      sceneMountedDir = "";
      sceneApply = null;
      if (!sceneStop) return;
      try { sceneStop(); } catch (e) {}
      sceneStop = null;
    }

    function weUrl(route, params) {
      var parts = [];
      for (var k in params) {
        if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
        if (params[k] == null) continue;
        parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
      }
      return WE_API + route + (parts.length ? "?" + parts.join("&") : "");
    }

    /** 把宿主解好的贴图上传成 WebGL 纹理（PNG 交给浏览器解码，其余是 RGBA 原始像素）。 */
    function fetchTexture(gl, dir, name, repeat) {
      return fetch(weUrl("asset", { dir: dir, name: name })).then(function (res) {
        if (!res.ok) throw new Error("贴图读取失败：" + name);
        var enc = res.headers.get("x-we-encoding");
        var w = Number(res.headers.get("x-we-width") || 0);
        var h = Number(res.headers.get("x-we-height") || 0);
        return res.arrayBuffer().then(function (buf) {
          var tex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, tex);
          var wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          if (enc === "png") {
            return createImageBitmap(new Blob([buf], { type: "image/png" })).then(function (bmp) {
              var bw = bmp.width, bh = bmp.height;
              gl.bindTexture(gl.TEXTURE_2D, tex);
              gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
              gl.generateMipmap(gl.TEXTURE_2D);
              if (bmp.close) bmp.close();
              return { tex: tex, width: bw, height: bh };
            });
          }
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(buf));
          return { tex: tex, width: w, height: h };
        });
      });
    }

    var SCENE_VS = [
      "#version 300 es",
      "precision highp float;",
      "in vec2 aPos;",
      "out vec2 vUv;",
      "void main() {",
      "  vUv = aPos;",
      "  gl_Position = vec4(aPos.x * 2.0 - 1.0, 1.0 - aPos.y * 2.0, 0.0, 1.0);",
      "}",
    ].join("\n");

    // 效果着色器：waterflow（水流）与 foliagesway（摆叶/发丝）逐行移植自场景自带的 GLSL
    var SCENE_FS = [
      "#version 300 es",
      "precision highp float;",
      "in vec2 vUv;",
      "out vec4 outColor;",
      "uniform sampler2D uBase;",
      "uniform sampler2D uFlow;",
      "uniform sampler2D uPhase;",
      "uniform sampler2D uMask;",
      "uniform float uHasFlow;",
      "uniform float uHasSway;",
      "uniform float uTime;",
      "uniform float uAmp;",
      "uniform float uSpeed;",
      "uniform float uPhaseScale;",
      "uniform float uAlpha;",
      "uniform vec2 uFitScale;",
      "uniform vec2 uFitOffset;",
      "uniform vec4 uSway;",        // x=strength y=speed z=phase w=power
      "uniform float uSwayScale;",  // 噪声采样缩放
      "uniform float uSwayAspect;",
      "uniform vec2 uSwayDir;",     // 方向角转成的 cos/sin
      "const float TAU = 6.28318530718;",
      "vec2 rot(vec2 v, vec2 cs) { return vec2(v.x * cs.x - v.y * cs.y, v.x * cs.y + v.y * cs.x); }",
      "float noise1(vec2 p) {",
      "  vec2 i = floor(p); vec2 f = fract(p);",
      "  f = f * f * (3.0 - 2.0 * f);",
      "  float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453);",
      "  float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);",
      "  float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);",
      "  float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);",
      "  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);",
      "}",
      "void main() {",
      "  vec2 uv = uFitOffset + vUv * uFitScale;",
      "  vec2 sampleUv = uv;",
      "  if (uHasSway > 0.5) {",
      "    float amp = uSway.x * uSway.x * 0.005;",
      "    amp *= texture(uMask, uv).r;",
      "    float n = noise1(uv * uSwayScale * 200.0);",
      "    vec2 rp = rot(uv, uSwayDir);",
      "    float phase = (n * TAU + rp.x * 10.0 + rp.y * 5.0) * uSway.z;",
      "    vec4 sines = sin(phase + uSway.y * uTime * vec4(1.0, -0.16161616, 0.0083333, -0.00019841));",
      "    vec4 csines = sin(0.4 + phase + uSway.y * uTime * vec4(-0.5, 0.041666666, -0.0013888889, 0.000024801587));",
      "    sines = pow(abs(sines), vec4(uSway.w)) * sign(sines);",
      "    csines = pow(abs(csines), vec4(uSway.w)) * sign(csines);",
      "    vec2 dirW = rot(vec2(1.0 / uSwayAspect, uSwayAspect), uSwayDir);",
      "    sampleUv += vec2(dirW.x * dot(sines, vec4(amp)), dirW.y * dot(csines, vec4(amp)));",
      "  }",
      "  vec4 albedo = texture(uBase, sampleUv);",
      "  if (uHasFlow > 0.5) {",
      "    float flowPhase = texture(uPhase, sampleUv * uPhaseScale).r;",
      "    vec2 flowColors = texture(uFlow, sampleUv).rg;",
      "    vec2 flowMask = (flowColors - vec2(0.498)) * 2.0;",
      "    float flowAmount = length(flowMask);",
      "    float t = uTime * uSpeed;",
      "    vec4 cycles = vec4(fract(t), fract(t + 0.5), fract(0.25 + t), fract(0.25 + t + 0.5));",
      "    float blend = 2.0 * abs(cycles.x - 0.5);",
      "    float blend2 = 2.0 * abs(cycles.z - 0.5);",
      "    cycles -= 0.5;",
      "    vec4 o1 = (flowMask.xyxy * uAmp * 0.1) * cycles.xxyy;",
      "    vec4 o2 = (flowMask.xyxy * uAmp * 0.1) * cycles.zzww;",
      "    vec4 fa = mix(texture(uBase, sampleUv + o1.xy), texture(uBase, sampleUv + o1.zw), blend);",
      "    vec4 fa2 = mix(texture(uBase, sampleUv + o2.xy), texture(uBase, sampleUv + o2.zw), blend2);",
      "    float w = smoothstep(0.2, 0.8, flowPhase);",
      "    albedo = mix(albedo, mix(fa, fa2, w), flowAmount);",
      "  }",
      "  outColor = vec4(albedo.rgb, albedo.a) * uAlpha;",
      "}",
    ].join("\n");

    function compileShader(gl, type, src) {
      var sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error("着色器编译失败：" + gl.getShaderInfoLog(sh));
      }
      return sh;
    }

    /** object-fit 的采样映射：把画布 uv 映射到贴图上的可见区域。 */
    function fitUv(fit, imgW, imgH, cw, ch) {
      var ia = imgW / imgH, ca = cw / ch;
      var sx = 1, sy = 1;
      if (fit === "fill") {
        sx = 1; sy = 1;
      } else if (fit === "contain") {
        if (ia > ca) { sx = 1; sy = ca / ia; } else { sx = ia / ca; sy = 1; }
      } else {
        if (ia > ca) { sx = ca / ia; sy = 1; } else { sx = 1; sy = ia / ca; }
      }
      return { sx: sx, sy: sy, ox: (1 - sx) / 2, oy: (1 - sy) / 2 };
    }

    /**
     * 挂载一个 Wallpaper Engine 场景。
     * @param {object} m 当前设置（fit / opacity / scrim / effectStrength）
     * @param {object} rec 背景项记录（dir 指向工坊壁纸目录）
     */
    function mountScene(m, rec) {
      var dir = rec.dir;
      sceneStatus = { ok: false, text: "载入中…", width: 0, height: 0 };
      stopScene();
      var fetched = null;   // 降级时复用已拿到的场景描述，避免再打一次 /scene

      return fetch(weUrl("scene", { dir: dir }))
        .then(function (res) {
          return res.json().then(function (body) {
            if (!res.ok) throw new Error(body && body.error ? body.error : "场景解析失败");
            return body;
          });
        })
        .then(function (graph) {
          fetched = graph;
          if (!graph.layers || graph.layers.length === 0) throw new Error("这个场景里没有可渲染的图层");
          var host = ensureLayer();
          var canvas = document.createElement("canvas");
          canvas.style.position = "absolute";
          canvas.style.top = "0";
          canvas.style.left = "0";
          canvas.style.width = "100%";
          canvas.style.height = "100%";
          canvas.style.opacity = String(m.opacity == null ? 1 : m.opacity);
          host.appendChild(canvas);

          // 白色遮罩：叠在画布之上、页面内容之下
          var scrim = document.createElement("div");
          var ss = scrim.style;
          ss.position = "absolute";
          ss.top = "0"; ss.left = "0"; ss.width = "100%"; ss.height = "100%";
          ss.background = "#fff";
          ss.pointerEvents = "none";
          ss.opacity = String(m.scrim == null ? 0.35 : m.scrim);
          host.appendChild(scrim);

          sceneMountedDir = dir;
          sceneApply = function (mm) {
            canvas.style.opacity = String(mm.opacity == null ? 1 : mm.opacity);
            scrim.style.opacity = String(mm.scrim == null ? 0.35 : mm.scrim);
          };

          var gl = canvas.getContext("webgl2", {
            alpha: false, antialias: false, depth: false, stencil: false,
            premultipliedAlpha: false, powerPreference: "high-performance",
          });
          if (!gl) throw new Error("当前环境不支持 WebGL2，无法渲染场景壁纸");

          var program = gl.createProgram();
          gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, SCENE_VS));
          gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, SCENE_FS));
          gl.linkProgram(program);
          if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error("着色器链接失败：" + gl.getProgramInfoLog(program));
          }
          gl.useProgram(program);

          var buf = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, buf);
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            0, 0, 1, 0, 0, 1,
            1, 0, 1, 1, 0, 1,
          ]), gl.STATIC_DRAW);
          var aPos = gl.getAttribLocation(program, "aPos");
          gl.enableVertexAttribArray(aPos);
          gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

          var uni = {};
          ["uBase", "uFlow", "uPhase", "uMask", "uHasFlow", "uHasSway", "uTime", "uAmp",
            "uSpeed", "uPhaseScale", "uAlpha", "uFitScale", "uFitOffset",
            "uSway", "uSwayScale", "uSwayAspect", "uSwayDir"].forEach(function (n) {
            uni[n] = gl.getUniformLocation(program, n);
          });
          gl.uniform1i(uni.uBase, 0);
          gl.uniform1i(uni.uFlow, 1);
          gl.uniform1i(uni.uPhase, 2);
          gl.uniform1i(uni.uMask, 3);

          // 预载所有图层的贴图（底板 + 各效果用到的遮罩/相位图）
          var jobs = graph.layers.map(function (l, index) {
            var flowEffect = null, swayEffect = null;
            (l.effects || []).forEach(function (e) {
              if (e.shader === "waterflow") flowEffect = e;
              else if (e.shader === "foliagesway") swayEffect = e;
            });
            var extras = [];
            if (flowEffect && flowEffect.mask && flowEffect.phase) {
              extras.push(fetchTexture(gl, dir, flowEffect.mask, false).then(function (t) { return { key: "flow", tex: t }; }));
              extras.push(fetchTexture(gl, dir, flowEffect.phase, true).then(function (t) { return { key: "phase", tex: t }; }));
            } else {
              flowEffect = null;
            }
            if (swayEffect && swayEffect.mask) {
              extras.push(fetchTexture(gl, dir, swayEffect.mask, false).then(function (t) { return { key: "swayMask", tex: t }; }));
            } else {
              swayEffect = null;
            }
            return Promise.all([fetchTexture(gl, dir, l.texture, false)].concat(extras)).then(function (all) {
              var out = { index: index, base: all[0], flowEffect: flowEffect, swayEffect: swayEffect };
              for (var k = 1; k < all.length; k += 1) out[all[k].key] = all[k].tex;
              return out;
            });
          });

          return Promise.all(jobs).then(function (layers) {
            var imgW = graph.width || layers[0].base.width;
            var imgH = graph.height || layers[0].base.height;
            var raf = 0;
            var start = (window.performance && performance.now ? performance.now() : Date.now());
            var stopped = false;

            function resize() {
              var dpr = Math.min(window.devicePixelRatio || 1, 2);
              var cw = host.clientWidth || window.innerWidth || 1280;
              var ch = host.clientHeight || window.innerHeight || 720;
              var w = Math.max(1, Math.round(cw * dpr));
              var h = Math.max(1, Math.round(ch * dpr));
              // 控制总像素量，4K DPR=2 会很吃力
              var cap = 2560 / w;
              if (cap < 1) { w = Math.round(w * cap); h = Math.round(h * cap); }
              if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
              }
              return { w: w, h: h };
            }

            function frame() {
              if (stopped) return;
              raf = window.requestAnimationFrame(frame);
              // 壁纸模式关掉时（设置页等）不渲染，省 GPU
              var on = false;
              try { on = document.documentElement.classList.contains("dshbg-on"); } catch (e) { on = true; }
              if (!on) return;

              var t0 = window.performance && performance.now ? performance.now() : Date.now();
              var size = resize();
              var now = (t0 - start) / 1000;
              var fit = fitUv(m.fit || "cover", imgW, imgH, size.w, size.h);
              gl.viewport(0, 0, size.w, size.h);
              gl.clearColor(0, 0, 0, 1);
              gl.clear(gl.COLOR_BUFFER_BIT);
              gl.uniform2f(uni.uFitScale, fit.sx, fit.sy);
              gl.uniform2f(uni.uFitOffset, fit.ox, fit.oy);
              gl.uniform1f(uni.uTime, now);
              gl.uniform1f(uni.uAlpha, 1);
              var strength = m.effectStrength == null ? 1 : m.effectStrength;

              for (var i = 0; i < layers.length; i += 1) {
                var L = layers[i];
                if (i === 0) {
                  gl.disable(gl.BLEND);
                } else {
                  gl.enable(gl.BLEND);
                  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                }
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, L.base.tex);
                if (L.flowEffect) {
                  gl.uniform1f(uni.uHasFlow, 1);
                  gl.uniform1f(uni.uAmp, L.flowEffect.strength * strength);
                  gl.uniform1f(uni.uSpeed, L.flowEffect.speed);
                  gl.uniform1f(uni.uPhaseScale, L.flowEffect.phaseScale || 2);
                  gl.activeTexture(gl.TEXTURE1);
                  gl.bindTexture(gl.TEXTURE_2D, L.flow.tex);
                  gl.activeTexture(gl.TEXTURE2);
                  gl.bindTexture(gl.TEXTURE_2D, L.phase.tex);
                } else {
                  gl.uniform1f(uni.uHasFlow, 0);
                }

                if (L.swayEffect) {
                  var se = L.swayEffect;
                  var dir = se.direction || 0;
                  var aspect = (imgH / imgW) * (se.ratio || 0.3);
                  // amp 在着色器里是 strength 的平方，这里用 sqrt 让滑块的放大保持线性
                  gl.uniform1f(uni.uHasSway, 1);
                  gl.uniform4f(
                    uni.uSway,
                    (se.strength == null ? 0.4 : se.strength) * Math.sqrt(Math.max(strength, 0)),
                    se.speed == null ? 5 : se.speed,
                    se.phase == null ? 0.5 : se.phase,
                    se.power == null ? 1 : se.power
                  );
                  gl.uniform1f(uni.uSwayScale, se.scale == null ? 0.05 : se.scale);
                  gl.uniform1f(uni.uSwayAspect, aspect || 1);
                  gl.uniform2f(uni.uSwayDir, Math.cos(dir), Math.sin(dir));
                  gl.activeTexture(gl.TEXTURE3);
                  gl.bindTexture(gl.TEXTURE_2D, L.swayMask.tex);
                } else {
                  gl.uniform1f(uni.uHasSway, 0);
                }
                gl.drawArrays(gl.TRIANGLES, 0, 6);
              }
            }

            sceneStop = function () {
              stopped = true;
              if (raf) window.cancelAnimationFrame(raf);
              raf = 0;
              layers.forEach(function (L) {
                try {
                  gl.deleteTexture(L.base.tex);
                  if (L.flow) gl.deleteTexture(L.flow.tex);
                  if (L.phase) gl.deleteTexture(L.phase.tex);
                  if (L.swayMask) gl.deleteTexture(L.swayMask.tex);
                } catch (e) {}
              });
              try { gl.deleteProgram(program); gl.deleteBuffer(buf); } catch (e) {}
            };

            sceneStatus = {
              ok: true,
              text: (rec.title || rec.name || "") + " · " + graph.layers.length + " 层",
              width: imgW,
              height: imgH,
            };
            resize();   // 先按当前窗口定好画布，避免首帧之前是默认 300×150
            raf = window.requestAnimationFrame(frame);
            return canvas;
          });
        })
        .catch(function (e) {
          sceneStatus = { ok: false, text: String((e && e.message) || e), width: 0, height: 0 };
          // 兜底：WebGL 不可用/解析失败时，至少把壁纸自带动图铺上
          mountPreviewImage(m, rec, fetched);
        });
    }

    /** 渲染失败时的降级路径：优先用场景底图（通常是 4K PNG），再退回壁纸自带的预览图。 */
    function mountPreviewImage(m, rec, graph) {
      // /scene 没拿到时也没有底图名，直接用 preview.gif；两者都没有就由 drawStaticLayer 收尾
      var first = graph && graph.layers && graph.layers[0];
      drawStaticLayer(m, rec, first ? weUrl("asset", { dir: rec.dir, name: first.texture }) : null);
    }

    function drawStaticLayer(m, rec, src) {
      var host = ensureLayer();
      var img = document.createElement("img");
      var s = img.style;
      s.position = "absolute";
      s.top = "0"; s.left = "0";
      s.width = "100%"; s.height = "100%";
      s.objectFit = m.fit || "cover";
      s.opacity = String(m.opacity == null ? 1 : m.opacity);
      // 底图可能是压缩纹理（浏览器无法直接显示），那就换回预览图；
      // 两张都加载不了说明目录已被删除/移走，直接收掉图层，别在界面上留个破图
      img.addEventListener("error", function () {
        if (!img.parentNode) return;   // 已经被别的壁纸替换掉了，别去动当前背景
        if (img.getAttribute("data-retry") !== "1") {
          img.setAttribute("data-retry", "1");
          img.src = weUrl("preview", { dir: rec.dir });
          return;
        }
        sceneStatus = { ok: false, text: "壁纸文件已失效（目录可能已被删除或移动）", width: 0, height: 0 };
        removeLayer();
        try { setMsg("壁纸文件已失效，已清除背景：" + (rec.title || rec.dir)); } catch (e) {}
        renderStatus();
      });
      img.src = src || weUrl("preview", { dir: rec.dir });
      host.appendChild(img);

      var scrim = document.createElement("div");
      var ss = scrim.style;
      ss.position = "absolute";
      ss.top = "0"; ss.left = "0"; ss.width = "100%"; ss.height = "100%";
      ss.background = "#fff";
      ss.pointerEvents = "none";
      ss.opacity = String(m.scrim == null ? 0.35 : m.scrim);
      host.appendChild(scrim);

      sceneApply = function (mm) {
        img.style.opacity = String(mm.opacity == null ? 1 : mm.opacity);
        scrim.style.opacity = String(mm.scrim == null ? 0.35 : mm.scrim);
      };
    }

    /* ---------------- UI ---------------- */
    var meta = { activeKey: "", fit: "cover", opacity: 1, scrim: 0.35, enabled: true, effectStrength: 1, autoClear: true };
    var items = [];
    var panel = null;
    var msgEl = null;
    var btnEl = null;

    function el(tag, style, text) {
      var n = document.createElement(tag);
      if (style) for (var k in style) n.style[k] = style[k];
      if (text != null) n.textContent = text;
      return n;
    }
    var BTN = {
      padding: "5px 10px", borderRadius: "7px", border: "1px solid #dcdce4",
      background: "#f4f4f7", color: "#333338", cursor: "pointer", fontSize: "12px",
    };
    var ROW = { display: "flex", alignItems: "center", gap: "8px", margin: "9px 0" };

    function setMsg(t) { if (msgEl) msgEl.textContent = t || ""; }

    function saveMeta(patch) {
      var beforeClear = meta.autoClear;
      for (var k in patch) meta[k] = patch[k];
      // 深度透明开关要在保存前立即生效，不然要等下一次视图同步
      if (beforeClear !== meta.autoClear) applyClearMode();
      return dbPut(META_KEY, meta)
        .then(function () { return applyMeta(meta); })
        .then(function () { renderStatus(); })
        .catch(function (e) { setMsg("保存失败：" + String((e && e.message) || e)); });
    }

    function renderStatus() {
      if (!panel) return;
      var box = panel.querySelector("[data-role=status]");
      if (!box) return;
      var layer = document.getElementById(LAYER_ID);
      var video = layer ? layer.querySelector("video") : null;
      var canvas = layer ? layer.querySelector("canvas") : null;
      var parts = [];
      parts.push("启用：" + (meta.enabled ? "是" : "否"));
      parts.push("已选：" + (meta.activeKey ? "有" : "无"));
      if (video) {
        parts.push("视频层：已挂载");
        parts.push("尺寸：" + (video.videoWidth || 0) + "×" + (video.videoHeight || 0));
        parts.push("状态：" + (video.readyState >= 2 ? "可播放" : "加载中"));
        parts.push("暂停：" + (video.paused ? "是" : "否"));
      } else if (canvas) {
        parts.push("场景层：已挂载");
        if (sceneStatus.ok) {
          parts.push("壁纸：" + sceneStatus.text);
          parts.push("尺寸：" + sceneStatus.width + "×" + sceneStatus.height);
          parts.push("进度：" + (canvas.width) + "×" + (canvas.height) + "px");
        } else {
          parts.push("错误：" + sceneStatus.text);
        }
      } else if (sceneStatus.text && sceneStatus.text !== "未使用") {
        parts.push("场景：" + sceneStatus.text);
      } else {
        parts.push("视频层：未挂载");
      }
      parts.push("已透明化：" + lastCleared + " 块");
      var cls = false;
      try { cls = document.documentElement.classList.contains("dshbg-on"); } catch (e) {}
      parts.push("壁纸模式：" + (cls ? "开" : "关") + "（判定 " + (modeOn ? "聊天" : "非聊天") + "）");
      box.textContent = parts.join(" · ");
    }

    function renderList() {
      if (!panel) return;
      var list = panel.querySelector("[data-role=list]");
      if (!list) return;
      while (list.firstChild) list.removeChild(list.firstChild);
      if (items.length === 0) {
        list.appendChild(el("div", { opacity: "0.6" }, "还没有视频"));
        return;
      }
      items.forEach(function (it) {
        var row = el("div", {
          display: "flex", alignItems: "center", gap: "8px",
          padding: "6px 0", borderBottom: "1px solid #ececf1",
        });
        var radio = el("input");
        radio.type = "radio";
        radio.name = "dshbgpick";
        radio.checked = meta.activeKey === it.key;
        radio.addEventListener("change", function () {
          saveMeta({ activeKey: it.key, enabled: true });
        });
        row.appendChild(radio);

        var name = el("span", {
          flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }, (it.value && it.value.name) || it.key);
        name.title = name.textContent;
        row.appendChild(name);

        var del = el("button", BTN, "删除");
        del.addEventListener("click", function () {
          dbDelete(it.key).then(function () {
            if (meta.activeKey === it.key) return saveMeta({ activeKey: "", enabled: false });
            return null;
          }).then(refresh).then(function () {
            renderList(); renderStatus(); setMsg("已删除");
          }).catch(function (e) { setMsg("删除失败：" + String((e && e.message) || e)); });
        });
        row.appendChild(del);
        list.appendChild(row);
      });
    }

    function refresh() {
      return dbList().then(function (list) {
        items = list;
        return dbGet(META_KEY);
      }).then(function (m) {
        if (m) {
          meta.activeKey = m.activeKey || "";
          meta.fit = m.fit || "cover";
          meta.opacity = m.opacity == null ? 1 : m.opacity;
          meta.scrim = m.scrim == null ? 0.35 : m.scrim;
          meta.enabled = m.enabled !== false;
          meta.effectStrength = m.effectStrength == null ? 1 : m.effectStrength;
          meta.autoClear = m.autoClear !== false;
        }
      }).catch(function (e) {
        setMsg("读取失败：" + String((e && e.message) || e));
      });
    }

    /** 扫描本机 Steam 创意工坊 431960，渲染可选壁纸列表。 */
    function loadWeList(box) {
      box.textContent = "正在扫描 Steam 创意工坊（431960）…";
      box.style.padding = "8px";
      fetch(WE_API + "scan").then(function (r) {
        return r.json().then(function (body) {
          if (!r.ok) throw new Error((body && body.error) || "扫描失败");
          return body;
        });
      }).then(function (body) {
        var list = (body && body.wallpapers) || [];
        while (box.firstChild) box.removeChild(box.firstChild);
        if (list.length === 0) {
          box.appendChild(el("div", { opacity: "0.7" }, "没找到创意工坊壁纸目录"));
          return;
        }
        list.forEach(function (w) {
          var row = el("div", {
            display: "flex", alignItems: "center", gap: "8px",
            padding: "6px 2px", borderBottom: "1px solid #f0f0f4",
          });
          var thumb = el("img", {
            width: "64px", height: "36px", objectFit: "cover",
            borderRadius: "4px", background: "#e8e8ee", flex: "0 0 auto",
          });
          thumb.loading = "lazy";
          if (w.preview) thumb.src = weUrl("preview", { dir: w.dir });
          row.appendChild(thumb);

          var info = el("div", { flex: "1", minWidth: "0" });
          var title = el("div", {
            fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }, w.title);
          title.title = w.title;
          info.appendChild(title);
          info.appendChild(el("div", { fontSize: "11px", opacity: "0.6" },
            w.scene ? "场景 · 可渲染" : (w.type + " · 暂不支持，仅作列出")));
          row.appendChild(info);

          if (w.scene) {
            row.style.cursor = "pointer";
            row.addEventListener("click", function () {
              var key = "we:" + w.dir;
              setMsg("正在载入场景…");
              dbPut(key, { name: w.title, kind: "we", dir: w.dir, title: w.title, type: w.type })
                .then(function () { return saveMeta({ activeKey: key, enabled: true }); })
                .then(refresh)
                .then(function () {
                  renderList();
                  renderStatus();
                  setMsg(sceneStatus.ok ? "已应用场景：" + w.title : "应用失败：" + sceneStatus.text);
                })
                .catch(function (e) { setMsg("载入失败：" + String((e && e.message) || e)); });
            });
          } else {
            row.style.opacity = "0.55";
          }
          box.appendChild(row);
        });
      }).catch(function (e) {
        box.textContent = "扫描失败：" + String((e && e.message) || e) + "（需要重启 DSH 才会注册宿主接口）";
      });
    }

    function buildPanel() {
      var box = el("div", {
        position: "fixed", right: "16px", bottom: "16px", width: "360px",
        maxHeight: "76vh", overflowY: "auto", background: "#ffffff",
        color: "#22222a", border: "1px solid #e3e3ea", borderRadius: "12px",
        padding: "16px", zIndex: "2147483001",
        boxShadow: "0 12px 40px rgba(0,0,0,.18)",
        font: "13px/1.65 system-ui,-apple-system,'Segoe UI',sans-serif",
      });

      var head = el("div", {
        display: "flex", justifyContent: "space-between",
        alignItems: "center", marginBottom: "6px",
      });
      head.appendChild(el("strong", { fontSize: "14px" }, "动态背景"));
      var closeBtn = el("button", BTN, "关闭");
      closeBtn.addEventListener("click", function () {
        if (panel) { panel.remove(); panel = null; }
      });
      head.appendChild(closeBtn);
      box.appendChild(head);

      var pickRow = el("div", ROW);
      var fileInput = el("input");
      fileInput.type = "file";
      fileInput.accept = "video/*";
      fileInput.style.display = "none";
      var pickBtn = el("button", BTN, "选择本地视频…");
      pickBtn.addEventListener("click", function () { fileInput.click(); });
      fileInput.addEventListener("change", function () {
        var file = fileInput.files && fileInput.files[0];
        if (!file) return;
        var isVideo = /^video\//.test(file.type || "")
          || /\.(mp4|webm|ogg|mov|mkv|m4v|avi)$/i.test(file.name);
        if (!isVideo) { setMsg("请选择视频文件（mp4 / webm / mov / mkv…）"); return; }
        var key = "v:" + Date.now() + ":" + file.name;
        setMsg("正在保存…（视频越大越久）");
        dbPut(key, { name: file.name, size: file.size, type: file.type, blob: file })
          .then(function () { return saveMeta({ activeKey: key, enabled: true }); })
          .then(refresh)
          .then(function () {
            renderList(); renderStatus();
            setMsg("已添加并应用：" + file.name);
          })
          .catch(function (e) { setMsg("添加失败：" + String((e && e.message) || e)); });
        fileInput.value = "";
      });
      pickRow.appendChild(pickBtn);
      pickRow.appendChild(fileInput);
      box.appendChild(pickRow);

      /* ---- Wallpaper Engine 场景壁纸 ---- */
      var weRow = el("div", ROW);
      var weBtn = el("button", BTN, "Wallpaper Engine 壁纸…");
      weRow.appendChild(weBtn);
      box.appendChild(weRow);

      var weBox = el("div", {
        display: "none", marginBottom: "8px", border: "1px solid #ececf1",
        borderRadius: "8px", maxHeight: "260px", overflowY: "auto", background: "#fbfbfd",
      });
      box.appendChild(weBox);

      var weLoaded = false;
      weBtn.addEventListener("click", function () {
        if (weBox.style.display === "none") {
          weBox.style.display = "block";
          if (!weLoaded) { weLoaded = true; loadWeList(weBox); }
        } else {
          weBox.style.display = "none";
        }
      });

      var enRow = el("div", ROW);
      var en = el("input");
      en.type = "checkbox";
      en.checked = meta.enabled !== false;
      en.addEventListener("change", function () {
        saveMeta({ enabled: en.checked }).then(renderStatus);
      });
      enRow.appendChild(en);
      enRow.appendChild(el("span", null, "启用动态背景"));
      box.appendChild(enRow);

      // 深度透明：运行时清掉仍然不透明的大块面板（输入框改毛玻璃）
      var acRow = el("div", ROW);
      var ac = el("input");
      ac.type = "checkbox";
      ac.checked = meta.autoClear !== false;
      ac.addEventListener("change", function () {
        saveMeta({ autoClear: ac.checked }).then(function () {
          renderStatus();
          setMsg(ac.checked ? "已开启深度透明，正在清理面板底色" : "已还原面板底色");
        });
      });
      acRow.appendChild(ac);
      var acLabel = el("span", null, "深度透明（清掉残留的不透明面板）");
      acLabel.title = "按「面积 + 计算背景」判定，自动把按钮组/卡片/标题条之类的实心底色清成透明；输入框会改成毛玻璃";
      acRow.appendChild(acLabel);
      box.appendChild(acRow);

      var fitRow = el("div", ROW);
      fitRow.appendChild(el("span", null, "填充"));
      var fitSel = el("select", {
        flex: "1", padding: "6px", background: "#ffffff", color: "#22222a",
        border: "1px solid #dcdce4", borderRadius: "6px",
      });
      [["cover", "填充（裁剪边缘）"], ["contain", "完整显示"], ["fill", "拉伸填满"]].forEach(function (p) {
        var o = document.createElement("option");
        o.value = p[0]; o.textContent = p[1];
        fitSel.appendChild(o);
      });
      fitSel.value = meta.fit || "cover";
      fitSel.addEventListener("change", function () { saveMeta({ fit: fitSel.value }); });
      fitRow.appendChild(fitSel);
      box.appendChild(fitRow);

      var opRow = el("div", ROW);
      opRow.appendChild(el("span", null, "视频亮度"));
      var range = el("input", { flex: "1" });
      range.type = "range";
      range.min = "0.1"; range.max = "1"; range.step = "0.05";
      range.value = String(meta.opacity == null ? 1 : meta.opacity);
      range.addEventListener("input", function () { meta.opacity = Number(range.value); });
      range.addEventListener("change", function () { saveMeta({ opacity: Number(range.value) }); });
      opRow.appendChild(range);
      box.appendChild(opRow);

      // 白色遮罩：越大画面越白、文字越清楚（0 = 不遮）
      var scrimRow = el("div", ROW);
      scrimRow.appendChild(el("span", null, "白色遮罩"));
      var scrim = el("input", { flex: "1" });
      scrim.type = "range";
      scrim.min = "0"; scrim.max = "0.9"; scrim.step = "0.05";
      scrim.value = String(meta.scrim == null ? 0.35 : meta.scrim);
      var scrimVal = el("span", { width: "38px", textAlign: "right", opacity: "0.7", fontSize: "11px" },
        Math.round((meta.scrim == null ? 0.35 : meta.scrim) * 100) + "%");
      scrim.addEventListener("input", function () {
        meta.scrim = Number(scrim.value);
        scrimVal.textContent = Math.round(meta.scrim * 100) + "%";
      });
      scrim.addEventListener("change", function () {
        saveMeta({ scrim: Number(scrim.value) });
      });
      scrimRow.appendChild(scrim);
      scrimRow.appendChild(scrimVal);
      box.appendChild(scrimRow);

      // 动效强度：只对 Wallpaper Engine 场景有意义（缩放着色器里的位移幅度）
      var effRow = el("div", ROW);
      effRow.appendChild(el("span", null, "动效强度"));
      var eff = el("input", { flex: "1" });
      eff.type = "range";
      eff.min = "0"; eff.max = "3"; eff.step = "0.05";
      eff.value = String(meta.effectStrength == null ? 1 : meta.effectStrength);
      var effVal = el("span", { width: "38px", textAlign: "right", opacity: "0.7", fontSize: "11px" },
        Math.round((meta.effectStrength == null ? 1 : meta.effectStrength) * 100) + "%");
      eff.addEventListener("input", function () {
        meta.effectStrength = Number(eff.value);
        effVal.textContent = Math.round(meta.effectStrength * 100) + "%";
      });
      eff.addEventListener("change", function () {
        saveMeta({ effectStrength: Number(eff.value) });
      });
      effRow.appendChild(eff);
      effRow.appendChild(effVal);
      box.appendChild(effRow);

      var listBox = el("div", {
        marginTop: "10px", borderTop: "1px solid #ececf1", paddingTop: "6px",
      });
      listBox.setAttribute("data-role", "list");
      box.appendChild(listBox);

      var status = el("div", {
        marginTop: "10px", padding: "8px", borderRadius: "6px",
        background: "#f6f6f9", color: "#5a6472", fontSize: "11.5px",
        lineHeight: "1.5", wordBreak: "break-all",
      });
      status.setAttribute("data-role", "status");
      box.appendChild(status);

      var reapply = el("button", BTN, "重新应用背景");
      reapply.style.marginTop = "8px";
      reapply.addEventListener("click", function () {
        applyMeta(meta).then(function () {
          renderStatus();
          setMsg("已重新应用");
        });
      });
      box.appendChild(reapply);

      msgEl = el("div", { marginTop: "8px", opacity: "0.9", color: "#2f7d32" });
      box.appendChild(msgEl);

      return box;
    }

    /* ---------------- 可拖拽按钮 ---------------- */
    function readPos() {
      try {
        var raw = localStorage.getItem(POS_KEY);
        if (!raw) return null;
        var p = JSON.parse(raw);
        if (typeof p.left === "number" && typeof p.top === "number") return p;
      } catch (e) {}
      return null;
    }
    function writePos(left, top) {
      try { localStorage.setItem(POS_KEY, JSON.stringify({ left: left, top: top })); } catch (e) {}
    }
    function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

    function mountUi() {
      if (document.getElementById(UI_ID)) return;
      var host = el("div", {});
      host.id = UI_ID;

      var btn = el("button", {
        position: "fixed", left: "12px", bottom: "12px", zIndex: "2147483002",
        width: "34px", height: "34px", borderRadius: "50%",
        border: "1px solid #dcdce4", background: "rgba(255,255,255,.92)",
        color: "#55555f", cursor: "grab", fontSize: "15px",
        display: "flex", alignItems: "center", justifyContent: "center",
        opacity: "0.45", transition: "opacity .15s",
        userSelect: "none", touchAction: "none",
      }, "🎞");
      btn.title = "动态背景设置（可拖动）";
      btnEl = btn;

      var pos = readPos();
      if (pos) {
        btn.style.left = pos.left + "px";
        btn.style.top = pos.top + "px";
        btn.style.bottom = "auto";
      }

      var dragging = false;
      var moved = false;
      var startX = 0, startY = 0;
      var startLeft = 0, startTop = 0;

      btn.addEventListener("pointerdown", function (ev) {
        dragging = true;
        moved = false;
        startX = ev.clientX;
        startY = ev.clientY;
        var r = btn.getBoundingClientRect();
        startLeft = r.left;
        startTop = r.top;
        try { btn.setPointerCapture(ev.pointerId); } catch (e) {}
        btn.style.cursor = "grabbing";
        ev.preventDefault();
      });
      btn.addEventListener("pointermove", function (ev) {
        if (!dragging) return;
        var dx = ev.clientX - startX;
        var dy = ev.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
        var left = clamp(startLeft + dx, 4, window.innerWidth - 40);
        var top = clamp(startTop + dy, 4, window.innerHeight - 40);
        btn.style.left = left + "px";
        btn.style.top = top + "px";
        btn.style.bottom = "auto";
      });
      btn.addEventListener("pointerup", function (ev) {
        if (!dragging) return;
        dragging = false;
        btn.style.cursor = "grab";
        try { btn.releasePointerCapture(ev.pointerId); } catch (e) {}
        var r = btn.getBoundingClientRect();
        writePos(Math.round(r.left), Math.round(r.top));
        if (!moved) togglePanel();
      });
      btn.addEventListener("pointercancel", function () {
        dragging = false;
        btn.style.cursor = "grab";
      });
      btn.addEventListener("mouseenter", function () { btn.style.opacity = "1"; });
      btn.addEventListener("mouseleave", function () { if (!dragging) btn.style.opacity = "0.45"; });

      function togglePanel() {
        if (panel) { panel.remove(); panel = null; return; }
        panel = buildPanel();
        host.appendChild(panel);
        refresh().then(function () {
          renderList();
          renderStatus();
        });
      }

      host.appendChild(btn);
      (document.body || document.documentElement).appendChild(host);
    }

    function boot() {
      try {
        // 先确保处于未启用状态，才能读到主题原本的底色
        try { document.documentElement.classList.remove("dshbg-on"); } catch (e) {}
        captureSolidColor();
        injectStyle();
        mountUi();
        watchView();
        syncMode(true);
        refresh().then(function () { return applyMeta(meta); }).then(function () {
          // SPA 重新渲染后补几次；这里用 force 是首次/兜底，不参与滞后计数
          setTimeout(function () { syncMode(true); renderStatus(); }, 300);
          setTimeout(function () { syncMode(true); }, 1200);
          setTimeout(function () { syncMode(true); renderStatus(); }, 2500);
          // 常驻兜底：即使没有 DOM 变动，也定期把新冒出来的不透明面板清一遍
          try { setInterval(scheduleSweep, 2000); } catch (e) {}
        });
      } catch (e) {
        console.warn("[dsh-dynamic-bg]", e);
      }
    }

    var started = false;
    function apply() {
      if (started) return;
      started = true;
      if (document.body) boot();
      else document.addEventListener("DOMContentLoaded", boot, { once: true });
    }

    exports.apply = apply;
    exports.inject = [];
    exports.name = "dsh-dynamic-bg";
    return exports;
  },
});
