/**
 * dsh-email-notify — 浏览器（客户端）半侧。
 *
 * 干三件事：
 *   1) 告诉宿主端「我是不是正在看着 harness 界面」：窗口有焦点且页面可见 = 在看。
 *      宿主端据此决定「看界面就不发邮件」。心跳 + 焦点/可见性变化即时上报。
 *   2) 宿主端在我在场时想提醒我（默认关闭），轮询取回来并弹提示：优先系统通知
 *      （Electron 里就是 Windows 右下角那条），弹不出来退化成界面内浮层卡片。
 *   3) 在设置面板里提供「邮件通知」一节：所有配置都在这里改，不用去命令行或手改 JSON。
 *
 * 之所以由客户端判定"在看"：只有页面自己知道窗口焦点和可见性。
 */
window.__ModuleLoader__.load({
  id: "dsh-email-notify",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = null;
    try { React = require("react"); } catch (e) { React = null; }

    var ENDPOINT = "/dsh-email-notify";
    var HEARTBEAT_MS = 20000;
    var POLL_MS = 4000;
    var CLIENT_ID = "c-" + Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36);
    var lastInboxId = null;
    var pollTimer = null;
    var heartbeatTimer = null;
    var started = false;

    /* ================= 在场状态上报 ================= */

    function reportPresence() {
      var payload = {
        clientId: CLIENT_ID,
        focused: typeof document.hasFocus === "function" ? document.hasFocus() : true,
        visible: document.visibilityState !== "hidden",
      };
      try {
        fetch(ENDPOINT + "/presence", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          keepalive: true, // 页面正在卸载时也尽量把「我走了」发出去
        }).catch(function () { /* 后端可能正在关闭，忽略 */ });
      } catch (e) { /* 忽略 */ }
      return payload;
    }

    /* ================= 界面内浮层（系统通知不可用时的退路） ================= */

    var CSS = [
      ".dsh-email-notify-stack{position:fixed;right:18px;bottom:18px;z-index:2147483000;display:flex;flex-direction:column;gap:10px;pointer-events:none;}",
      ".dsh-email-notify-card{pointer-events:auto;width:320px;box-sizing:border-box;padding:12px 14px;border-radius:12px;",
      "background:rgba(255,255,255,.98);color:#1b1b1f;border:1px solid rgba(0,0,0,.10);",
      "box-shadow:0 10px 30px rgba(0,0,0,.18);font:13px/1.5 system-ui,'Microsoft YaHei',sans-serif;cursor:pointer;",
      "opacity:0;transform:translateY(8px);transition:opacity .18s ease,transform .18s ease;}",
      ".dsh-email-notify-card.is-in{opacity:1;transform:none;}",
      "body[data-ds-dark-theme] .dsh-email-notify-card{background:rgba(32,32,36,.98);color:#ececf1;border-color:rgba(255,255,255,.14);}",
      ".dsh-email-notify-card-title{font-weight:600;margin-bottom:2px;word-break:break-word;}",
      ".dsh-email-notify-card-body{opacity:.78;word-break:break-word;white-space:pre-wrap;}",
      ".dsh-email-notify-card-hint{margin-top:6px;font-size:11px;opacity:.5;}",
    ].join("");

    /**
     * 注入样式。
     *
     * 关键点：**内容变了必须替换**，不能只判断"有没有"。插件升级或客户端热重载时，
     * DOM 会按新代码重建，但上一次注入的旧 `<style>` 还留在页面里 —— 只判断存在就
     * 直接返回，新样式永远不生效，表现就是"界面文字更新了、样式却没变"。
     * （虚线分隔看不出来就是这么来的：新的 style 没被写进去。）
     */
    function ensureCss(id, text) {
      var selector = "style[data-" + id + "]";
      var existing = document.querySelector(selector);
      if (existing) {
        if (existing.textContent !== text) existing.textContent = text;
        return;
      }
      var style = document.createElement("style");
      style.setAttribute("data-" + id, "");
      style.textContent = text;
      (document.head || document.documentElement).appendChild(style);
    }

    function stack() {
      var existing = document.querySelector(".dsh-email-notify-stack");
      if (existing) return existing;
      var node = document.createElement("div");
      node.className = "dsh-email-notify-stack";
      (document.body || document.documentElement).appendChild(node);
      return node;
    }

    /** 点击提示时尽量跳到对应会话：找到侧栏里指向该会话的链接并点击。 */
    function openSession(sessionId) {
      try {
        if (sessionId) {
          var link = document.querySelector('a[href*="' + sessionId + '"]');
          if (link) { link.click(); return; }
        }
      } catch (e) { /* 忽略 */ }
    }

    function showCard(title, body, sessionId) {
      ensureCss("dsh-email-notify", CSS);
      var card = document.createElement("div");
      card.className = "dsh-email-notify-card";
      var titleNode = document.createElement("div");
      titleNode.className = "dsh-email-notify-card-title";
      titleNode.textContent = title;
      var bodyNode = document.createElement("div");
      bodyNode.className = "dsh-email-notify-card-body";
      bodyNode.textContent = body;
      var hint = document.createElement("div");
      hint.className = "dsh-email-notify-card-hint";
      hint.textContent = "点击跳转 · 8 秒后自动收起";
      card.appendChild(titleNode);
      card.appendChild(bodyNode);
      card.appendChild(hint);
      card.addEventListener("click", function () { openSession(sessionId); card.remove(); });
      stack().appendChild(card);
      requestAnimationFrame(function () { card.classList.add("is-in"); });
      setTimeout(function () {
        card.classList.remove("is-in");
        setTimeout(function () { card.remove(); }, 220);
      }, 8000);
    }

    /** 优先系统通知，失败退化成浮层。 */
    function notify(item) {
      var shown = false;
      try {
        if (typeof Notification === "function") {
          if (Notification.permission === "granted") {
            var note = new Notification(item.notifyTitle || "DeepSeek Harness", {
              body: item.notifyBody || "",
              tag: "dsh-email-notify-" + (item.sessionId || "") + "-" + item.id,
            });
            note.onclick = function () {
              try { window.focus(); } catch (e) { /* 忽略 */ }
              openSession(item.sessionId);
            };
            shown = true;
          } else if (Notification.permission === "default" && String(navigator.userAgent || "").indexOf("Electron") >= 0) {
            // Electron 里 requestPermission 不弹系统询问，直接放行。
            Notification.requestPermission().then(function (permission) {
              if (permission === "granted") notify(item);
              else showCard(item.notifyTitle, item.notifyBody, item.sessionId);
            }).catch(function () { showCard(item.notifyTitle, item.notifyBody, item.sessionId); });
            return;
          }
        }
      } catch (e) { shown = false; }
      if (!shown) showCard(item.notifyTitle || "DeepSeek Harness", item.notifyBody || "", item.sessionId);
    }

    /* ================= 轮询宿主端的提示队列 ================= */

    function pollInbox() {
      if (document.visibilityState === "hidden") return;
      var query = lastInboxId === null ? "" : "?since=" + lastInboxId;
      fetch(ENDPOINT + "/inbox" + query, { headers: { accept: "application/json" } })
        .then(function (response) { return response.ok ? response.json() : null; })
        .then(function (data) {
          if (!data) return;
          if (typeof data.next === "number") lastInboxId = data.next;
          var items = Array.isArray(data.items) ? data.items : [];
          for (var i = 0; i < items.length; i += 1) notify(items[i]);
        })
        .catch(function () { /* 后端重启中，下一轮再试 */ });
    }

    /* ================= 设置面板 ================= */

    var PANEL_CSS = [
      ".dsh-email-notify-settings{font-size:13px;line-height:1.7;padding:4px 0 32px;max-width:820px;color:inherit;}",
      ".dsh-email-notify-settings .status{border:1px solid rgba(127,127,127,.28);border-radius:10px;padding:10px 14px;margin-bottom:14px;background:rgba(127,127,127,.05);font-size:12px;}",
      ".dsh-email-notify-settings .status .line{margin:2px 0;}",
      ".dsh-email-notify-settings .ok{color:#12a150;}",
      ".dsh-email-notify-settings .warn{color:#d97706;}",
      ".dsh-email-notify-settings .err{color:#dc2626;}",
      ".dsh-email-notify-settings .group{border:1px solid rgba(127,127,127,.28);border-radius:10px;padding:14px 16px;margin-bottom:14px;}",
      ".dsh-email-notify-settings .group-title{font-weight:600;font-size:14px;margin-bottom:4px;}",
      // pre-line：说明文字里换行的地方要真的换行（授权码那两行说明就是这么写的）。
      ".dsh-email-notify-settings .group-desc{opacity:.6;font-size:12px;margin-bottom:8px;white-space:pre-line;}",
      ".dsh-email-notify-settings .row{display:grid;grid-template-columns:132px 1fr;align-items:center;gap:12px;margin:8px 0;}",
      ".dsh-email-notify-settings .row>label{opacity:.85;font-size:12px;}",
      ".dsh-email-notify-settings .field{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
      ".dsh-email-notify-settings input[type='text'],.dsh-email-notify-settings input[type='password'],.dsh-email-notify-settings input[type='number']{padding:6px 9px;border:1px solid rgba(127,127,127,.4);border-radius:7px;background:transparent;color:inherit;font-size:13px;}",
      ".dsh-email-notify-settings input[type='text'],.dsh-email-notify-settings input[type='password']{width:100%;max-width:320px;}",
      ".dsh-email-notify-settings input[type='number']{width:96px;}",
      ".dsh-email-notify-settings .check{display:flex;align-items:center;gap:7px;font-size:13px;margin:6px 0;cursor:pointer;}",
      ".dsh-email-notify-settings .hint{opacity:.6;font-size:12px;}",
      ".dsh-email-notify-settings textarea{width:100%;box-sizing:border-box;min-height:126px;padding:8px 10px;border:1px solid rgba(127,127,127,.4);border-radius:7px;background:transparent;color:inherit;font-size:12.5px;line-height:1.65;font-family:ui-monospace,Consolas,'Courier New',monospace;resize:vertical;}",
      // 标题模板是单行输入框，让它占满可用宽度（默认那条 320px 对长标题不够用）。
      ".dsh-email-notify-settings input.dsh-tpl-title{max-width:100%;font-family:ui-monospace,Consolas,'Courier New',monospace;font-size:12.5px;}",
      ".dsh-email-notify-settings .preview{border:1px dashed rgba(127,127,127,.45);border-radius:8px;padding:10px 12px;background:rgba(127,127,127,.06);font-size:12.5px;white-space:pre-wrap;font-family:ui-monospace,Consolas,'Courier New',monospace;}",
      ".dsh-email-notify-settings .preview .cap{opacity:.55;font-size:11px;margin:2px 0;}",
      // 分隔线用 currentColor + 半透明：深浅两个主题下都看得见（写死灰色的那条太淡了）。
      ".dsh-email-notify-settings .divider{border-top:1px dashed currentColor;opacity:.45;margin:22px 0 14px;}",
      ".dsh-email-notify-settings .preview-title{font-size:12px;opacity:.72;margin-bottom:8px;}",
      // 预览的切换按钮做成"分段控件"：一眼就和上面那些圆角占位符标签不是一类东西。
      ".dsh-email-notify-settings .tabs{display:inline-flex;gap:0;margin:0 0 10px;border:1px solid rgba(127,127,127,.4);border-radius:8px;overflow:hidden;}",
      ".dsh-email-notify-settings .tabs button{padding:4px 13px;border:0;border-radius:0;font-size:12px;}",
      ".dsh-email-notify-settings .tabs button + button{border-left:1px solid rgba(127,127,127,.25);}",
      ".dsh-email-notify-settings .tabs button.on{background:rgba(127,127,127,.22);font-weight:600;}",
      ".dsh-email-notify-settings .tag{border:1px solid rgba(127,127,127,.35);border-radius:6px;padding:1px 7px;font-size:11.5px;cursor:pointer;}",
      ".dsh-email-notify-settings .tag:hover{background:rgba(127,127,127,.14);}",
      ".dsh-email-notify-settings .group.step{border-left:3px solid rgba(127,127,127,.5);}",
      ".dsh-email-notify-settings .actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:4px 0 10px;}",
      ".dsh-email-notify-settings button{padding:7px 14px;border:1px solid rgba(127,127,127,.45);border-radius:8px;background:transparent;color:inherit;font-size:13px;cursor:pointer;}",
      // 没有常驻的"主按钮"底色：早先给「保存设置」加过灰底，看起来像一直按着没弹起来。
      ".dsh-email-notify-settings button:hover:not(:disabled){background:rgba(127,127,127,.14);}",
      ".dsh-email-notify-settings button:active:not(:disabled){background:rgba(127,127,127,.22);}",
      ".dsh-email-notify-settings button:disabled{opacity:.5;cursor:default;}",
      ".dsh-email-notify-settings .msg{margin-top:10px;font-size:12px;white-space:pre-wrap;}",
    ].join("");

    /**
     * 会话页头那个「离开模式」按钮的样式。
     * 用 currentColor + 半透明底，深浅两个主题都跟着走（和面板同一套做法）。
     */
    var MODE_CSS = [
      ".dsh-email-notify-mode{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border:1px solid rgba(127,127,127,.45);border-radius:999px;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1.6;cursor:pointer;white-space:nowrap;user-select:none;}",
      ".dsh-email-notify-mode:hover:not(:disabled){background:rgba(127,127,127,.14);}",
      ".dsh-email-notify-mode .dot{width:7px;height:7px;border-radius:50%;background:currentColor;opacity:.4;flex:none;}",
      // 开启态用蓝色：绿色是"成功/正常"，而这个状态的含义是"我不在，把消息转给我"，
      // 用绿色读起来像"一切正常"，和它的定位不搭。
      ".dsh-email-notify-mode.on{border-color:rgba(37,99,235,.5);color:#2563eb;background:rgba(37,99,235,.12);font-weight:600;}",
      ".dsh-email-notify-mode.on .dot{opacity:1;}",
      "body[data-ds-dark-theme] .dsh-email-notify-mode.on{border-color:rgba(96,165,250,.55);color:#7cb0f8;background:rgba(96,165,250,.16);}",
      ".dsh-email-notify-mode.auto{opacity:.7;cursor:default;}",
      ".dsh-email-notify-mode.busy{opacity:.55;cursor:default;}",
    ].join("");

    /* ================= 「离开模式」按钮的状态 ================= */

    /**
     * 页头按钮与设置面板**共享**这份状态。
     *
     * 浏览器半侧是同一个模块实例，所以不需要轮询：面板里改了「自动模式」，
     * 按钮立刻跟着变；按钮切换了，面板下次读取时也是新值。
     */
    var sendState = { away: false, auto: false, loaded: false, busy: false, error: null };
    var sendListeners = [];

    function emitSendState() {
      // 复制一份再遍历：订阅者在回调里退订不会打乱这一轮。
      sendListeners.slice().forEach(function (listener) {
        try {
          listener();
        } catch (error) { /* 单个订阅者出错不该影响别的 */ }
      });
    }

    /** 把宿主端返回的配置里那两个字段接过来。 */
    function adoptSendState(config) {
      if (!config || typeof config !== "object") return;
      sendState.away = config.awayMode === true;
      sendState.auto = config.autoMode === true;
      sendState.loaded = true;
      sendState.error = null;
      emitSendState();
    }

    /** 读回当前状态（按钮第一次挂载时用）。 */
    function refreshSendState() {
      return request("/config").then(function (result) {
        if (result.ok) adoptSendState(result.data.config);
        return sendState;
      }).catch(function (error) {
        sendState.error = error.message;
        return sendState;
      });
    }

    /**
     * 点按钮：开 → 关 → 开 …（自动模式下按钮不生效）
     *
     * 只回传 `awayMode` 一个字段 —— 沿用"只写改动项"的约定，
     * 所以不会把设置面板里还没保存的改动顺手写进去。
     */
    function toggleAwayMode() {
      if (sendState.auto || sendState.busy) return;
      var next = !sendState.away;
      sendState.busy = true;
      sendState.away = next; // 先乐观更新：点下去立刻有反馈
      emitSendState();
      request("/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: { awayMode: next } }),
      }).then(function (result) {
        if (result.ok) adoptSendState(result.data.config);
        else sendState.away = !next; // 写失败就回退，别显示一个假的"开"
      }).catch(function () {
        sendState.away = !next;
      }).then(function () {
        sendState.busy = false;
        emitSendState();
      });
    }

    /** 建元素的小工具（照 dsh-custom-font 的写法，保持同一套风格）。 */
    function el(tag, props, children) {
      var node = document.createElement(tag);
      if (props) {
        Object.keys(props).forEach(function (key) {
          var value = props[key];
          if (value === undefined || value === null || value === false) return;
          if (key === "class") node.className = value;
          else if (key === "text") node.textContent = value;
          else if (key === "on") Object.keys(value).forEach(function (name) { node.addEventListener(name, value[name]); });
          else if (key === "type" || key === "value" || key === "checked" || key === "disabled"
            || key === "placeholder" || key === "min" || key === "max" || key === "step" || key === "autocomplete") node[key] = value;
          else node.setAttribute(key, value);
        });
      }
      (children || []).forEach(function (child) { if (child) node.appendChild(child); });
      return node;
    }

    function textInput(value, onChange, extra) {
      // 和 textarea 一样：on 要**合并**，否则额外加一个 focus 处理器会把 input 挤掉。
      var props = Object.assign({
        type: "text",
        value: value === undefined || value === null ? "" : String(value),
      }, extra || {});
      props.on = Object.assign(
        { input: function (event) { onChange(event.target.value); } },
        props.on || {},
      );
      return el("input", props);
    }

    function numberInput(value, onChange, extra) {
      return el("input", Object.assign({
        type: "number",
        min: 0,
        value: value === undefined || value === null ? "" : String(value),
        on: { input: function (event) { onChange(event.target.value); } },
      }, extra || {}));
    }

    function textarea(value, onChange, extra) {
      // 注意：这里的 on 要**合并**而不是被 extra 整体覆盖 —— 否则额外加一个
      // focus 处理器就会把 input 处理器挤掉，模板改了却写不进草稿。
      var props = Object.assign({
        value: value === undefined || value === null ? "" : String(value),
      }, extra || {});
      props.on = Object.assign(
        { input: function (event) { onChange(event.target.value); } },
        props.on || {},
      );
      return el("textarea", props);
    }

    /**
     * 预览用的模板渲染 —— 刻意与 lib/template.js 保持一致。
     *
     * 为什么不调宿主端接口：预览要跟着敲键立刻变，来回一趟本地 HTTP 反而卡手。
     * 这份副本只影响**预览**（真发信永远走宿主端那一份），所以即使哪天两边
     * 有了细微出入，最坏也只是预览略有不同，不会把邮件发错。
     */
    function previewRender(template, vars) {
      return String(template === undefined || template === null ? "" : template)
        .replace(/\{([^{}\r\n]*)\}/g, function (match, name) {
          var value = vars[String(name).trim()];
          return value === undefined || value === null ? "" : String(value);
        });
    }

    /** 与 lib/template.js 的 tidyText 一致：压掉连续空行、去掉首尾空行。 */
    function previewTidy(text) {
      var lines = String(text === undefined || text === null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
      var out = [];
      lines.forEach(function (raw) {
        var line = raw.replace(/[ \t]+$/, "");
        if (line === "" && (out.length === 0 || out[out.length - 1] === "")) return;
        out.push(line);
      });
      while (out.length > 0 && out[out.length - 1] === "") out.pop();
      return out.join("\n");
    }

    function checkbox(label, checked, onChange, hint) {
      var box = el("input", {
        type: "checkbox",
        checked: Boolean(checked),
        on: { change: function (event) { onChange(event.target.checked); } },
      });
      var node = el("label", { class: "check" }, [box, el("span", { text: label })]);
      if (hint) node.appendChild(el("span", { class: "hint", text: hint }));
      return node;
    }

    function row(label, fieldNode, hint) {
      var field = el("div", { class: "field" }, [fieldNode]);
      if (hint) field.appendChild(el("span", { class: "hint", text: hint }));
      return el("div", { class: "row" }, [el("label", { text: label }), field]);
    }

    function request(path, options) {
      return fetch(ENDPOINT + path, options).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          return { ok: response.ok && data.ok !== false, status: response.status, data: data };
        });
      });
    }

    /**
     * 只挑出**真的改了**的字段。
     *
     * 为什么不在保存时把整份配置发回去：那样会把当前所有默认值也固化进用户的
     * config.json，以后再改默认值（升级插件）就不生效了。只回传差异，没碰过的项
     * 就继续跟着默认值走。
     *
     * 口令特例：读回来永远是空（不回显），所以"空"表示不修改、只有填了才回传。
     * @param {object} original - 加载/上次保存后的配置。
     * @param {object} draft - 界面上正在编辑的配置。
     * @returns {object} 只含改动的补丁对象，可能为空对象。
     */
    function diffConfig(original, draft) {
      var patch = {};
      var base = original || {};
      Object.keys(draft || {}).forEach(function (key) {
        // 只读标记 / 界面辅助字段，不属于配置本身，别回传给宿主。
        if (key === 'passSet' || key === 'passFromEnv'
          || key === 'subjectTemplateIsDefault' || key === 'bodyTemplateIsDefault') return;
        var before = base[key];
        var after = draft[key];
        if (after && typeof after === 'object' && !Array.isArray(after)) {
          var child = {};
          var childPatch = diffConfig(before && typeof before === 'object' ? before : {}, after);
          Object.keys(childPatch).forEach(function (inner) { child[inner] = childPatch[inner]; });
          if (Object.keys(child).length > 0) patch[key] = child;
          return;
        }
        if (key === 'pass') {
          if (typeof after === 'string' && after !== '') patch[key] = after;
          return;
        }
        if (JSON.stringify(before) !== JSON.stringify(after)) patch[key] = after;
      });
      return patch;
    }

    /**
     * 设置面板本体：纯 DOM 构建。
     * 不把整份配置塞进 React state——字段多、还要保留"草稿未保存"的改动，
     * 直接读草稿对象 + 手动重绘表单更简单，也和 dsh-custom-font 的做法一致。
     */
    function buildPanel(root) {
      var draft = null;    // 正在编辑的配置（未保存的改动都在这里）
      var original = null; // 加载/上次保存后的配置，用来算差异
      var level = "basic"; // "basic" = 日常项（只填两个框）；"advanced" = 高级页
      var previewKind = "turnEnd"; // 预览切换：任务完成 / 需要授权 / 等你回答
      var meta = { templates: {} }; // 宿主端下发的默认模板与占位符清单
      var templateNodes = {};      // 两个模板输入框的引用（插入占位符后要还原光标）
      var lastTemplateField = "body"; // 占位符默认插到正文模板
      var pendingFocus = null;     // 重绘后要重新聚焦的模板框
      var previewBox = null;       // 预览区容器（只重画它，避免打字时光标乱跳）
      var msgBox = el("div", { class: "msg" });
      var statusBox = el("div", { class: "status" });
      var body = el("div");
      // 保存按钮和别的按钮长一样：早先给它加了常驻的灰底（primary），看起来像"一直按着不弹起来"。
      var saveButton = el("button", { text: "保存设置", on: { click: function () { save(); } } });
      var testButton = el("button", { text: "发送测试邮件", on: { click: function () { sendTest(); } } });
      var reloadButton = el("button", { text: "重新读取", on: { click: function () { load(); } } });

      // 这行原本挂在页面最上方（"配置存在哪、授权码不回显"），对新手是天书 —— 挪进高级设置。
      root.appendChild(statusBox);
      root.appendChild(el("div", { class: "actions" }, [saveButton, testButton, reloadButton]));
      root.appendChild(msgBox);
      root.appendChild(body);

      function setMessage(kind, text) {
        if (!text) {
          msgBox.className = "msg";
          msgBox.textContent = "";
          return;
        }
        msgBox.className = "msg " + (kind === "err" ? "err" : kind === "warn" ? "warn" : "ok");
        msgBox.textContent = text;
      }

      function renderStatus() {
        while (statusBox.firstChild) statusBox.removeChild(statusBox.firstChild);
        request("/status").then(function (result) {
          var data = result.data || {};
          var readyText = data.ready ? "配置就绪" : "配置未完成（缺 " + (data.missing || []).join(", ") + "）";
          statusBox.appendChild(el("div", { class: "line " + (data.ready ? "ok" : "warn"), text: "状态：" + readyText }));
          // 这里只留"配置好没好"和"上次发信成不成"两行：判定、发信方式、配置文件路径
          // 对使用者没有意义（发信方式看页头那颗按钮就够了），要查细节用 /status 或核验脚本。
          var last = data.lastSend;
          statusBox.appendChild(el("div", {
            class: "line " + (last ? (last.ok ? "ok" : "err") : ""),
            text: "上次发信：" + (last
              ? (last.ok
                ? "成功 · " + (last.subject || "") + " · " + new Date(last.at).toLocaleString("zh-CN", { hour12: false })
                : "失败 · " + (last.error || ""))
              : "还没有发过"),
          }));
        }).catch(function () {
          statusBox.appendChild(el("div", { class: "line err", text: "读取状态失败：宿主端可能还没加载完，稍后点「重新读取」。" }));
        });
      }

      /** 建一个分组框（所有分组都长这样）。 */
      function group(title, desc, children) {
        var node = el("div", { class: "group" }, [
          el("div", { class: "group-title", text: title }),
          desc ? el("div", { class: "group-desc", text: desc }) : null,
        ]);
        (children || []).forEach(function (child) { if (child) node.appendChild(child); });
        return node;
      }

      /**
       * 表单分两级：
       *   基础页 —— 新手只要填「邮箱账号 + 授权码」，再按需改邮件模板；
       *   高级页 —— 服务器、端口、通知时机、限流等，从基础页点「高级设置」进来。
       *
       * 保存按钮不在这两层里面（它在 root 上），所以切来切去按钮始终在眼前。
       */
      function renderForm() {
        while (body.firstChild) body.removeChild(body.firstChild);
        templateNodes = {};
        if (!draft) return;
        if (level === "advanced") renderAdvanced();
        else renderBasic();
        // 点占位符会整块重绘、焦点会丢；这里补回来，方便连着插好几个。
        if (pendingFocus && templateNodes[pendingFocus]) {
          var node = templateNodes[pendingFocus];
          try {
            node.focus();
            node.setSelectionRange(node.value.length, node.value.length);
          } catch (error) { /* 光标位置不影响功能 */ }
        }
        pendingFocus = null;
      }

      /* ── 基础页 ─────────────────────────────────────────────── */

      function renderBasic() {
        var smtp = draft.smtp || {};

        body.appendChild(group(
          "邮件通道",
          "请注意：授权码为 IMAP/SMTP 授权码，不是登录密码\n"
            + "QQ 邮箱的授权码在：网页版邮箱 → 设置 → 账户与安全 → 安全设置 → POP3/IMAP/SMTP/Exchange/CardDAV 服务 → 生成授权码",
          [
            row("邮箱账号", textInput(smtp.user, function (v) { smtp.user = v.trim(); }), "你的邮箱地址"),
            row("授权码", el("input", {
              type: "password",
              autocomplete: "new-password",
              placeholder: draft.smtp.passSet ? "已设置，留空表示不修改" : (draft.smtp.passFromEnv ? "由环境变量提供" : "填授权码"),
              value: "",
              on: { input: function (event) { smtp.pass = event.target.value; } },
            })),
            row("收件地址", textInput((draft.to || []).join(", "), function (v) {
              draft.to = v.split(/[,，;\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
            }), "留空 = 发到上面的邮箱；多个用逗号分隔"),
            el("div", { class: "field" }, [
              el("span", { class: "hint", text: "服务器、端口、加密方式已按 QQ 邮箱设好，要改请进「高级设置」。" }),
            ]),
          ],
        ));

        body.appendChild(renderTemplateGroup());

        body.appendChild(group(
          "高级设置",
          "SMTP 服务器与端口、发件人显示名、通知时机、限流与启用开关。",
          [
            el("div", { class: "actions" }, [
              el("button", { text: "高级设置 ▸", on: { click: function () { level = "advanced"; renderForm(); } } }),
            ]),
          ],
        ));
      }

      /* ── 邮件内容（模板 + 预览） ────────────────────────────── */

      function renderTemplateGroup() {
        var placeholders = (meta.templates && meta.templates.placeholders) || [];

        return group(
          "邮件内容",
          "下面就是邮件正文。大括号里的词会被替换成真实内容。",
          [
            row("标题模板", templateInput("subject", draft.subjectTemplate, false)),
            row("正文模板", templateInput("body", draft.bodyTemplate, true)),
            el("div", { class: "actions" }, [
              el("button", { text: "恢复默认（精简）", on: { click: function () { useDefaultTemplates(); } } }),
              el("button", { text: "套用详细模板", on: { click: function () { useDetailedTemplate(); } } }),
            ]),
            el("div", { class: "group-desc", text: "可用占位符（点一下就插进上面最后编辑的那个框）：" }),
            el("div", { class: "field" }, placeholders.map(function (item) {
              return el("span", {
                class: "tag",
                text: "{" + item.key + "}",
                title: item.desc,
                on: { click: function () { insertPlaceholder("{" + item.key + "}"); } },
              });
            })),
            // 预览是"看效果"的地方，和上面的"改设置"用一条虚线隔开 ——
            // 否则那三颗按钮和占位符标签长得像一家人，没人看得出它们是干嘛的。
            el("div", { class: "divider" }),
            renderPreview(),
          ],
        );
      }

      /**
       * 模板输入框：记住最后编辑的是哪一个（占位符要插到那儿）。
       *
       * 标题用**单行**输入框：它天生只有一行，用多行框会白白占掉半屏高度，
       * 还会让"标题"和"正文"看起来一样重。只有正文才用多行框。
       */
      function templateInput(field, value, multiline) {
        var key = field === "subject" ? "subjectTemplate" : "bodyTemplate";
        var flag = field === "subject" ? "subjectTemplateIsDefault" : "bodyTemplateIsDefault";
        var onChange = function (next) {
          draft[key] = next;
          // 一动就不再是默认值了，保存时会真的写进配置。
          draft[flag] = false;
          renderPreviewInto();
        };
        var focus = { on: { focus: function () { lastTemplateField = field; } } };
        var node = multiline
          ? textarea(value, onChange, focus)
          : textInput(value, onChange, Object.assign({ class: "dsh-tpl-title" }, focus));
        templateNodes[field] = node;
        return node;
      }

      /** 只重画预览区（不整块重绘，免得打字时光标乱跳）。 */
      function renderPreviewInto() {
        if (!previewBox) return;
        var vars = previewVars(previewKind);
        var prefix = draft.subjectPrefix ? draft.subjectPrefix + " " : "";
        var subjectLine = prefix + String(draft.subjectTemplate || "");
        while (previewBox.firstChild) previewBox.removeChild(previewBox.firstChild);
        previewBox.appendChild(el("div", { class: "cap", text: "标题" }));
        previewBox.appendChild(el("div", { text: previewTidy(previewRender(subjectLine, vars)) || "（空）" }));
        previewBox.appendChild(el("div", { class: "cap", text: "正文" }));
        previewBox.appendChild(el("div", { text: previewTidy(previewRender(draft.bodyTemplate || "", vars)) || "（空）" }));
      }

      /** 预览区：三种通知各看一遍，编辑模板时立刻知道成品长什么样。 */
      function renderPreview() {
        var kinds = [
          { id: "turnEnd", label: "任务完成" },
          { id: "approval", label: "需要授权" },
          { id: "question", label: "等你回答" },
        ];
        var tabs = el("div", { class: "tabs" }, kinds.map(function (kind) {
          return el("button", {
            class: kind.id === previewKind ? "on" : "",
            text: kind.label,
            on: { click: function () { previewKind = kind.id; markTabs(); renderPreviewInto(); } },
          });
        }));
        // 切预览只换高亮和内容，不整块重绘 —— 免得正在编辑的光标被打断。
        function markTabs() {
          kinds.forEach(function (kind, index) {
            if (tabs.children[index]) tabs.children[index].className = kind.id === previewKind ? "on" : "";
          });
        }

        previewBox = el("div", { class: "preview" });
        var wrap = el("div", { class: "preview-block" }, [
          el("div", { class: "preview-title", text: "预览" }),
          tabs,
          previewBox,
        ]);
        renderPreviewInto();
        return wrap;
      }

      /** 预览用的样例数据（不是真数据，只为了让模板看起来具体）。 */
      function previewVars(kind) {
        var vars = {
          "会话": "继续邮件通知插件工作",
          "会话ID": "session-b4d28e9c-d696-47b0-8908-547f0180d025",
          "工作区": "F:\\Space For AI work\\harness",
          "时间": "2026-09-13 18:20:05",
          "地址": "http://127.0.0.1:3080",
          "回合": "5",
          "用时": "7 分 24 秒",
          "图标": "✅",
          "状态": "已完成",
          "工具": "",
          "摘要": "",
          "详情": "",
          "提问": "把设置面板精简一下，其他项收进高级。",
          "最后回复": "已经收进二级页面，默认正文改成三行。",
        };
        if (kind === "approval") {
          vars["图标"] = "🔐";
          vars["状态"] = "需要你授权";
          vars["工具"] = "pwsh";
          vars["摘要"] = "pwsh";
          vars["提问"] = "";
          vars["最后回复"] = "";
          vars["详情"] = "工具：pwsh\n原因：执行命令需要你确认\n\n任务现在停在授权这一步等你决定，回到 harness 窗口点「允许」或「拒绝」才会继续。";
        } else if (kind === "question") {
          vars["图标"] = "❓";
          vars["状态"] = "等你回答";
          vars["摘要"] = "高级设置想要哪种？";
          vars["提问"] = "";
          vars["最后回复"] = "";
          vars["详情"] = "高级设置想要哪种？\n   · 原地折叠展开\n   · 真正的二级页面\n\n任务现在停在等你回答这一步，回到 harness 窗口作答才会继续。";
        }
        return vars;
      }

      function insertPlaceholder(text) {
        var field = lastTemplateField;
        var key = field === "subject" ? "subjectTemplate" : "bodyTemplate";
        var current = String(draft[key] || "");
        var glue = current === "" || /\s$/.test(current) ? "" : field === "subject" ? " " : "\n";
        draft[key] = current + glue + text;
        draft[field === "subject" ? "subjectTemplateIsDefault" : "bodyTemplateIsDefault"] = false;
        pendingFocus = field;
        renderForm();
      }

      /** 「恢复默认」= 清空自定义，继续跟随插件升级后的内置模板。 */
      function useDefaultTemplates() {
        var templates = meta.templates || {};
        draft.subjectTemplate = templates.defaultSubject || "";
        draft.bodyTemplate = templates.defaultBody || "";
        draft.subjectTemplateIsDefault = true;
        draft.bodyTemplateIsDefault = true;
        renderForm();
      }

      function useDetailedTemplate() {
        var templates = meta.templates || {};
        draft.bodyTemplate = templates.detailedBody || draft.bodyTemplate;
        draft.bodyTemplateIsDefault = false;
        renderForm();
      }

      /* ── 高级页 ─────────────────────────────────────────────── */

      function renderAdvanced() {
        var smtp = draft.smtp || {};
        var events = draft.events || {};

        body.appendChild(group(
          "高级设置",
          // 从页面最上方挪过来的：这些是"配置存在哪、口令怎么处理"的说明，
          // 日常使用不需要看到。
          "这些设置保存在宿主端的 config.json 里，改完点上面的「保存设置」立即生效，不用重启 DSH。\n"
            + "授权码只存在本机，读回界面时永远为空（留空 = 不修改）。",
          [
            el("div", { class: "actions" }, [
              el("button", { text: "← 返回基础设置", on: { click: function () { level = "basic"; renderForm(); } } }),
            ]),
          ],
        ));

        body.appendChild(group(
          "发信时机",
          "默认由会话页头右上角的「离开模式」按钮说了算：开着 → 有通知就发邮件；关着 → 一封都不发。",
          [
            checkbox("自动模式：不看按钮，按「是否在看界面」自动发（旧行为）", draft.autoMode, function (v) {
              draft.autoMode = v;
              // 顺手让页头按钮立刻变灰/恢复，不用等保存
              adoptSendState({ awayMode: draft.awayMode, autoMode: v });
            }),
            el("div", { class: "field" }, [
              el("span", { class: "hint", text: "自动判断只看窗口有没有焦点：「人走了但窗口还开着」会被当成你还在看。" }),
            ]),
          ],
        ));

        body.appendChild(group(
          "SMTP 服务器",
          "默认已适配 QQ 邮箱（smtp.qq.com:465，隐式 TLS）。换别的邮箱服务商时才需要动。",
          [
            row("服务器", textInput(smtp.host, function (v) { smtp.host = v.trim(); })),
            row("端口", numberInput(smtp.port, function (v) { smtp.port = Number(v) || 465; }), "465 = 隐式 TLS"),
            row("账号", textInput(smtp.user, function (v) { smtp.user = v.trim(); }), "通常就是你的邮箱地址"),
            row("授权码", el("input", {
              type: "password",
              autocomplete: "new-password",
              placeholder: draft.smtp.passSet ? "已设置，留空表示不修改" : (draft.smtp.passFromEnv ? "由环境变量提供" : "填授权码"),
              value: "",
              on: { input: function (event) { smtp.pass = event.target.value; } },
            })),
            row("发件人", textInput(smtp.from, function (v) { smtp.from = v.trim(); }), "留空 = 用账号"),
            row("发件显示名", textInput(smtp.fromName, function (v) { smtp.fromName = v.trim(); })),
            row("收件地址", textInput((draft.to || []).join(", "), function (v) {
              draft.to = v.split(/[,，;\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
            }), "多个用逗号分隔；留空 = 发给自己"),
            el("div", { class: "row" }, [el("label", { text: "加密" }), el("div", { class: "field" }, [
              checkbox("使用 TLS（465 端口勾选；587 不勾，走 STARTTLS）", smtp.secure, function (v) { smtp.secure = v; }),
              checkbox("校验证书", smtp.rejectUnauthorized !== false, function (v) { smtp.rejectUnauthorized = v; }),
              checkbox("允许无 TLS 明文发送（仅本机/内网中继）", smtp.allowInsecure === true, function (v) { smtp.allowInsecure = v; }),
            ])]),
          ],
        ));

        /* ── 通知时机 ── */
        body.appendChild(el("div", { class: "group" }, [
          el("div", { class: "group-title", text: "通知时机" }),
          el("div", { class: "group-desc", text: "勾选的类型才会通知；具体发不发邮件由页头「离开模式」开关决定。" }),
          checkbox("任务完成 / 出错时通知", events.turnEnd, function (v) { events.turnEnd = v; }),
          checkbox("工具需要我授权时通知", events.approval, function (v) { events.approval = v; }),
          checkbox("助手向我提问、等我回答时通知", events.question, function (v) { events.question = v; }),
          checkbox("子会话（subagent / 工作流子任务）也通知", draft.includeSubagents, function (v) { draft.includeSubagents = v; }, "默认只报主对话，避免一次任务收到一串邮件"),
          el("div", { class: "group-desc", text: "下面三项是「看界面时也弹一条提示」，默认全关——桌面外壳自己会弹完成通知，避免重复。" }),
          checkbox("看界面时也弹「任务完成」提示", draft.notifyWhenFocused, function (v) { draft.notifyWhenFocused = v; }),
          checkbox("看界面时也弹「需要授权」提示", draft.approvalNotifyWhenFocused, function (v) { draft.approvalNotifyWhenFocused = v; }),
          checkbox("看界面时也弹「向我提问」提示", draft.questionNotifyWhenFocused, function (v) { draft.questionNotifyWhenFocused = v; }),
        ]));

        body.appendChild(group(
          "标题与地址",
          "标题前缀会加在每封邮件标题最前面；「摘要长度」只影响 {提问} 与 {最后回复} 这两个占位符的截断长度。",
          [
            row("标题前缀", textInput(draft.subjectPrefix, function (v) { draft.subjectPrefix = v.trim(); }), "例如 [DSH]"),
            row("正文里的地址", textInput(draft.linkBase, function (v) { draft.linkBase = v.trim(); }), "留空 = http://127.0.0.1:3080"),
            row("摘要长度", numberInput(draft.excerptChars, function (v) { draft.excerptChars = Number(v) || 0; }), "字符"),
          ],
        ));

        /* ── 限流与判定 ── */
        body.appendChild(el("div", { class: "group" }, [
          el("div", { class: "group-title", text: "限流与判定" }),
          row("同类通知最小间隔", numberInput(draft.minIntervalSeconds, function (v) { draft.minIntervalSeconds = Number(v) || 0; }), "秒（同一会话）"),
          row("每分钟最多发", numberInput(draft.maxPerMinute, function (v) { draft.maxPerMinute = Number(v) || 0; }), "封，防死循环刷屏"),
          row("心跳过期判定", numberInput(draft.watchingStaleSeconds, function (v) { draft.watchingStaleSeconds = Number(v) || 0; }), "秒收不到界面心跳就当你已离开"),
          checkbox("启用插件（关掉后只保留设置，不发任何通知）", draft.enabled, function (v) { draft.enabled = v; }),
        ]));
      }

      /**
       * 把宿主端返回的配置接过来当草稿。
       *
       * 模板留空 = 用内置默认。界面上不能显示成空白（用户会以为坏了），所以填上
       * 默认文本，同时记一个"还是默认"的标记 —— 保存时按标记发回空串，于是没
       * 自定义过的用户能继续跟随插件升级后的默认模板。
       */
      function adopt(config) {
        original = config;
        draft = JSON.parse(JSON.stringify(config));
        // 面板读到的配置也顺手同步给页头那个按钮，两边永远一致。
        adoptSendState(config);
        var templates = meta.templates || {};
        draft.subjectTemplateIsDefault = !String(draft.subjectTemplate || "").trim();
        draft.bodyTemplateIsDefault = !String(draft.bodyTemplate || "").trim();
        if (draft.subjectTemplateIsDefault) draft.subjectTemplate = templates.defaultSubject || "";
        if (draft.bodyTemplateIsDefault) draft.bodyTemplate = templates.defaultBody || "";
      }

      function load() {
        setMessage(null, "");
        request("/config").then(function (result) {
          if (!result.ok) {
            setMessage("err", "读取配置失败：" + JSON.stringify(result.data));
            return;
          }
          if (result.data.templates) meta = { templates: result.data.templates };
          adopt(result.data.config);
          renderForm();
          renderStatus();
        }).catch(function (error) {
          setMessage("err", "读取配置失败：" + error.message + "\n（若刚装好插件，确认已经重启过 DSH）");
        });
      }

      function save() {
        if (!draft) return;
        var patch = diffConfig(original, draft);
        // diffConfig 会把"界面里预填的默认模板"当成改动（草稿里是默认文本，配置里是空串）。
        // 这里按标记纠正：没自定义过就不回传，免得把默认模板固化进用户的配置文件，
        // 以后插件改进了默认模板他却收不到。
        delete patch.subjectTemplate;
        delete patch.bodyTemplate;
        // 模板：仍是默认的（或刚点了「恢复默认」）就发空串 = 继续跟随内置默认。
        var subjectOut = draft.subjectTemplateIsDefault ? "" : String(draft.subjectTemplate || "");
        var bodyOut = draft.bodyTemplateIsDefault ? "" : String(draft.bodyTemplate || "");
        var subjectChanged = subjectOut !== String(original.subjectTemplate || "");
        var bodyChanged = bodyOut !== String(original.bodyTemplate || "");
        if (Object.keys(patch).length === 0 && !subjectChanged && !bodyChanged) {
          setMessage("warn", "没有检测到改动。");
          return;
        }
        // 只回传真的改了的那一项 —— 没动过的模板不该被平白写进用户的配置文件。
        if (subjectChanged) patch.subjectTemplate = subjectOut;
        if (bodyChanged) patch.bodyTemplate = bodyOut;
        saveButton.disabled = true;
        setMessage(null, "");
        request("/config", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ config: patch }),
        }).then(function (result) {
          if (!result.ok) {
            setMessage("err", "保存失败：" + (result.data.error || JSON.stringify(result.data)));
            return;
          }
          if (result.data.templates) meta = { templates: result.data.templates };
          adopt(result.data.config);
          renderForm();
          renderStatus();
          var warnings = result.data.warnings || [];
          var base = result.data.ready
            ? "已保存（只写入了改动项），配置就绪。"
            : "已保存，但还缺：" + (result.data.missing || []).join(", ");
          setMessage(warnings.length ? "warn" : (result.data.ready ? "ok" : "warn"),
            warnings.length ? base + "\n" + warnings.join("\n") : base);
        }).catch(function (error) {
          setMessage("err", "保存失败：" + error.message);
        }).then(function () {
          saveButton.disabled = false;
        });
      }

      function sendTest() {
        testButton.disabled = true;
        setMessage(null, "正在发送测试邮件……");
        request("/test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ config: draft }),
        }).then(function (result) {
          if (result.ok) setMessage("ok", "测试邮件已投递 → " + (result.data.to || []).join(", ") + "\n（用的就是上面这些值，还没保存也没关系）");
          else setMessage("err", "发送失败：" + (result.data.error || JSON.stringify(result.data)));
          renderStatus();
        }).catch(function (error) {
          setMessage("err", "发送失败：" + error.message);
        }).then(function () {
          testButton.disabled = false;
        });
      }

      load();
    }

    function EmailNotifySettings() {
      var ref = React.useRef(null);
      React.useEffect(function () {
        if (!ref.current) return;
        // 每次打开设置页都重建，保证显示的是最新配置。
        ref.current.innerHTML = "";
        ensureCss("dsh-email-notify-panel", PANEL_CSS);
        var panel = el("div", { class: "dsh-email-notify-settings" });
        ref.current.appendChild(panel);
        buildPanel(panel);
      }, []);
      return React.createElement("div", { ref: ref });
    }

    /**
     * 会话页头最右侧的「离开模式」开关。
     *
     * 为什么要这么个按钮：靠"窗口有没有焦点"猜你在不在电脑前并不可靠 ——
     * 人走了、窗口还开着（甚至还是焦点）是最常见的情况，那时自动判定会以为
     * 你还在看，于是你在外面一封都收不到。所以把决定权交回给人：
     * 点一下 = 我要离开，有通知就发邮件；再点一下 = 我在这儿，别发。
     *
     * 挂的是 `conversation.session.header.utilities`：官方文档说这一列就是给
     * "可选会话工具"用的（渲染在页头最右侧，不会挤动原有的会话操作）。
     */
    function SendModeButton() {
      var ref = React.useRef(null);

      React.useEffect(function () {
        var draw = function () {
          var host = ref.current;
          if (!host) return;
          ensureCss("dsh-email-notify-mode", MODE_CSS);
          while (host.firstChild) host.removeChild(host.firstChild);

          var className = "dsh-email-notify-mode";
          var label;
          var hint;
          if (sendState.auto) {
            className += " auto";
            label = "离开模式：自动";
            hint = "自动模式已开启（在「设置 → 邮件通知 → 高级设置」里关掉它，这个按钮才管用）";
          } else if (sendState.away) {
            className += " on";
            label = "离开模式：开";
            hint = "现在所有勾选的通知都会发邮件（不管你在不在看界面）。再点一下关闭。";
          } else {
            label = "离开模式：关";
            hint = "现在不会发任何邮件。点一下开启：有通知就发到你邮箱。";
          }
          if (sendState.busy) className += " busy";
          if (sendState.error) hint += "（读配置失败：" + sendState.error + "）";

          host.appendChild(el("button", {
            class: className,
            type: "button",
            title: hint,
            disabled: sendState.auto || sendState.busy,
            on: { click: toggleAwayMode },
          }, [
            el("span", { class: "dot" }),
            el("span", { text: label }),
          ]));
        };

        sendListeners.push(draw);
        draw();
        if (!sendState.loaded) refreshSendState();
        return function () {
          var index = sendListeners.indexOf(draw);
          if (index >= 0) sendListeners.splice(index, 1);
        };
      }, []);

      return React.createElement("div", { ref: ref });
    }

    /* ================= 启动 ================= */

    function start() {
      if (started) return;
      started = true;
      reportPresence();

      // 焦点 / 可见性变化必须立刻上报：宿主端靠它判断"我是不是在看界面"。
      // 刻意不监听鼠标键盘活动——20 秒心跳已足够保持"在场"的新鲜度，
      // 每次敲键都发一个请求只会白白刷本地接口。
      window.addEventListener("focus", reportPresence);
      window.addEventListener("blur", reportPresence);
      document.addEventListener("visibilitychange", reportPresence);
      window.addEventListener("pagehide", reportPresence);
      window.addEventListener("beforeunload", reportPresence);

      heartbeatTimer = setInterval(reportPresence, HEARTBEAT_MS);
      pollTimer = setInterval(pollInbox, POLL_MS);
      setTimeout(pollInbox, 1500);
    }

    function stop() {
      started = false;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (pollTimer) clearInterval(pollTimer);
      heartbeatTimer = null;
      pollTimer = null;
    }

    function apply(ctx) {
      start();

      // 不依赖宿主服务：设置面板走插件自己的 HTTP 接口读写配置。
      var slots = ctx && ctx.slots ? ctx.slots : (ctx && typeof ctx.get === "function" ? ctx.get("slots") : null);
      if (!React || !slots || typeof slots.inject !== "function" || typeof slots.register !== "function") return;

      // 一个槽位注册失败不该拖垮另一个（比如某个 DSH 版本没有页头那一列）。
      var injectSafely = function (name, produce) {
        try {
          slots.inject(name, produce);
        } catch (error) { /* 该槽位在这个版本里不存在就算了 */ }
      };

      injectSafely("settings.section", function () {
        return slots.register({
          name: "settings.section",
          id: "email-notify",
          order: 65,
          label: function () { return "邮件通知"; },
        }, function () { return React.createElement(EmailNotifySettings); });
      });

      // 会话页头最右侧的「离开模式」开关（官方文档：这一列就是给可选会话工具用的）。
      injectSafely("conversation.session.header.utilities", function () {
        return slots.register({
          name: "conversation.session.header.utilities",
          id: "email-notify-away-mode",
          order: 60,
        }, function () { return React.createElement(SendModeButton); });
      });
    }

    // 模块一被求值就开始上报：在场信息要尽早送到宿主端。
    if (typeof document !== "undefined") start();

    // 声明依赖 slots：这样加载器会等 slots 服务就绪后再调用 apply，
    // 设置面板才不会被"服务还没到"这一个理由悄悄跳过（与 dsh-custom-font 一致）。
    exports.apply = apply;
    exports.inject = ["slots"];
    exports.name = "dsh-email-notify";
    exports.stop = stop;
    return module.exports;
  }
});
