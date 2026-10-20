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
        "  --dsw-menu-surface-fill: rgba(22,22,26,.94) !important;",
        "  --dsw-hovercard-bg: rgba(22,22,26,.94) !important;",
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
      ["--dsw-menu-surface-fill", "rgba(22,22,26,.94)"],
      ["--dsw-hovercard-bg", "rgba(22,22,26,.94)"],
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

    function clearBigBackgrounds() {
      // 现在只让侧边栏透明，聊天区保持原生背景，
      // 所以不再自动清除大面积容器，避免把聊天区也清空。
      lastCleared = 0;
      return 0;
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
        if (!rec || !rec.blob) { removeLayer(); return; }
        injectStyle();
        watchView();
        if (isChatView()) syncMode(true); else syncMode();
        mountVideo(rec.blob, meta);
      }).catch(function () { removeLayer(); });
    }

    /* ---------------- UI ---------------- */
    var meta = { activeKey: "", fit: "cover", opacity: 1, scrim: 0.35, enabled: true };
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
      for (var k in patch) meta[k] = patch[k];
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
      var parts = [];
      parts.push("启用：" + (meta.enabled ? "是" : "否"));
      parts.push("已选：" + (meta.activeKey ? "有" : "无"));
      if (video) {
        parts.push("视频层：已挂载");
        parts.push("尺寸：" + (video.videoWidth || 0) + "×" + (video.videoHeight || 0));
        parts.push("状态：" + (video.readyState >= 2 ? "可播放" : "加载中"));
        parts.push("暂停：" + (video.paused ? "是" : "否"));
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
        }
      }).catch(function (e) {
        setMsg("读取失败：" + String((e && e.message) || e));
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
