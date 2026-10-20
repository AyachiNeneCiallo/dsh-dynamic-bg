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
        "html.dshbg-on, html.dshbg-on body { background: transparent !important; }",
        "html.dshbg-on #root { background: transparent !important; }",
        // 背景类 token：大面板全透明，卡片/气泡用极淡的黑色玻璃，
        // 这样聊天界面透出壁纸，同时文字仍有最低限度衬托。
        "html.dshbg-on {",
        "  --dsw-alias-bg-base: transparent !important;",
        "  --dsw-specific-sidebar-fill: transparent !important;",
        "  --dsw-alias-bg-layer-1: rgba(0,0,0,.22) !important;",
        "  --dsw-alias-bg-layer-2: rgba(0,0,0,.26) !important;",
        "  --dsw-alias-bg-layer-3: rgba(0,0,0,.30) !important;",
        "  --dsw-alias-bg-layer-4: rgba(0,0,0,.34) !important;",
        "  --dsw-alias-bg-module-platform: rgba(0,0,0,.22) !important;",
        "  --dsw-alias-settings-card-fill: rgba(0,0,0,.22) !important;",
        "  --dsw-alias-onboarding-card-fill: rgba(0,0,0,.26) !important;",
        "  --dsw-alias-onboarding-secondary-fill: rgba(0,0,0,.18) !important;",
        "  --dsw-menu-surface-fill: rgba(22,22,26,.94) !important;",
        "  --dsw-hovercard-bg: rgba(22,22,26,.94) !important;",
        "}",
        "html.dshbg-on [class*='_frame'], html.dshbg-on [class*='_centerCol'],",
        "html.dshbg-on [class*='_sidebarCol'],",
        "html.dshbg-on [class*='_rightbarCol'], html.dshbg-on [class*='_bottomRow'] {",
        "  background: transparent !important;",
        "}",
        "html.dshbg-on [class*='_frame']::before { background: transparent !important; }",
      ].join("\n");
      (document.head || document.documentElement).appendChild(st);
    }

    /* ---------------- 视图判定 ---------------- */
    // 聊天界面的特征：composer 输入区存在且可见。
    // 设置页 / 插件市场等整页视图会隐藏或卸载 composer。
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

    function clearBigBackgrounds() {
      var count = 0;
      try {
        // 把样式表移到 head 末尾，保证主题运行时重设 token 后仍是我们覆盖
        var styleTag = document.getElementById(STYLE_ID);
        if (styleTag && styleTag.parentNode) styleTag.parentNode.appendChild(styleTag);
      } catch (e) {}
      try {
        var vw = window.innerWidth || 1;
        var vh = window.innerHeight || 1;
        var all = document.querySelectorAll("#root, body *");
        for (var i = 0; i < all.length; i++) {
          var n = all[i];
          if (n.id === LAYER_ID || n.id === UI_ID) continue;
          // 跳过背景层（含遮罩）与设置面板内部的元素，否则会把遮罩清掉
          try {
            if (n.closest && (n.closest("#" + LAYER_ID) || n.closest("#" + UI_ID))) continue;
          } catch (e2) {}
          if (n.__dshbgTouched) continue;
          // 先量尺寸，再取计算样式：小元素直接跳过，避免对上千节点做 getComputedStyle
          var r = n.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          if (r.width * r.height < vw * vh * 0.12) continue;
          var cs = window.getComputedStyle(n);
          var bgc = cs.backgroundColor;
          var bgi = cs.backgroundImage;
          var hasOpaque = bgc && bgc !== "transparent" && bgc !== "rgba(0, 0, 0, 0)";
          var hasImage = bgi && bgi !== "none";
          if (!hasOpaque && !hasImage) continue;
          var rec = {
            el: n,
            bgColor: n.style.getPropertyValue("background-color"),
            bgPriority: n.style.getPropertyPriority("background-color"),
            bgImage: n.style.getPropertyValue("background-image"),
            bgImagePriority: n.style.getPropertyPriority("background-image"),
          };
          n.__dshbgTouched = true;
          touched.push(rec);
          n.style.setProperty("background-color", "transparent", "important");
          if (hasImage) n.style.setProperty("background-image", "none", "important");
          count++;
        }
      } catch (e) {}
      lastCleared = count;
      return count;
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
    }

    var modeOn = false;
    function syncMode(force) {
      var chat = isChatView();
      if (chat === modeOn && !force) return;
      modeOn = chat;
      try {
        document.documentElement.classList.toggle("dshbg-on", chat);
      } catch (e) {}
      if (chat) {
        clearBigBackgrounds();
      } else {
        // 离开聊天界面：还原所有被改过的容器（设置页保持 DSH 原样）
        restoreBackgrounds();
      }
    }

    var observer = null;
    var syncTimer = 0;
    function scheduleSync() {
      if (syncTimer) return;
      syncTimer = setTimeout(function () {
        syncTimer = 0;
        syncMode();
      }, 250);
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
      padding: "5px 10px", borderRadius: "7px", border: "1px solid #3a3a42",
      background: "#26262c", color: "#ddd", cursor: "pointer", fontSize: "12px",
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
          padding: "6px 0", borderBottom: "1px solid #26262c",
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
        maxHeight: "76vh", overflowY: "auto", background: "#1b1b20",
        color: "#e4e4e4", border: "1px solid #34343c", borderRadius: "12px",
        padding: "16px", zIndex: "2147483001",
        boxShadow: "0 12px 40px rgba(0,0,0,.55)",
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
        flex: "1", padding: "6px", background: "#111", color: "#e4e4e4",
        border: "1px solid #3a3a42", borderRadius: "6px",
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
        marginTop: "10px", borderTop: "1px solid #34343c", paddingTop: "6px",
      });
      listBox.setAttribute("data-role", "list");
      box.appendChild(listBox);

      var status = el("div", {
        marginTop: "10px", padding: "8px", borderRadius: "6px",
        background: "#141418", color: "#9cc", fontSize: "11.5px",
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

      msgEl = el("div", { marginTop: "8px", opacity: "0.85", color: "#8fd" });
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
        border: "1px solid #3a3a42", background: "rgba(28,28,33,.88)",
        color: "#c9c9c9", cursor: "grab", fontSize: "15px",
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
        injectStyle();
        mountUi();
        watchView();
        syncMode(true);
        refresh().then(function () { return applyMeta(meta); }).then(function () {
          // SPA 重新渲染后补几次，避免框架重置背景
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
