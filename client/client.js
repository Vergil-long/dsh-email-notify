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

    function ensureCss(id, text) {
      if (document.querySelector("style[data-" + id + "]")) return;
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
      ".dsh-email-notify-settings .desc{opacity:.72;font-size:12px;margin-bottom:12px;}",
      ".dsh-email-notify-settings .status{border:1px solid rgba(127,127,127,.28);border-radius:10px;padding:10px 14px;margin-bottom:14px;background:rgba(127,127,127,.05);font-size:12px;}",
      ".dsh-email-notify-settings .status .line{margin:2px 0;}",
      ".dsh-email-notify-settings .ok{color:#12a150;}",
      ".dsh-email-notify-settings .warn{color:#d97706;}",
      ".dsh-email-notify-settings .err{color:#dc2626;}",
      ".dsh-email-notify-settings .group{border:1px solid rgba(127,127,127,.28);border-radius:10px;padding:14px 16px;margin-bottom:14px;}",
      ".dsh-email-notify-settings .group-title{font-weight:600;font-size:14px;margin-bottom:4px;}",
      ".dsh-email-notify-settings .group-desc{opacity:.6;font-size:12px;margin-bottom:8px;}",
      ".dsh-email-notify-settings .row{display:grid;grid-template-columns:132px 1fr;align-items:center;gap:12px;margin:8px 0;}",
      ".dsh-email-notify-settings .row>label{opacity:.85;font-size:12px;}",
      ".dsh-email-notify-settings .field{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
      ".dsh-email-notify-settings input[type='text'],.dsh-email-notify-settings input[type='password'],.dsh-email-notify-settings input[type='number']{padding:6px 9px;border:1px solid rgba(127,127,127,.4);border-radius:7px;background:transparent;color:inherit;font-size:13px;}",
      ".dsh-email-notify-settings input[type='text'],.dsh-email-notify-settings input[type='password']{width:100%;max-width:320px;}",
      ".dsh-email-notify-settings input[type='number']{width:96px;}",
      ".dsh-email-notify-settings .check{display:flex;align-items:center;gap:7px;font-size:13px;margin:6px 0;cursor:pointer;}",
      ".dsh-email-notify-settings .hint{opacity:.6;font-size:12px;}",
      ".dsh-email-notify-settings .actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:4px 0 10px;}",
      ".dsh-email-notify-settings button{padding:7px 14px;border:1px solid rgba(127,127,127,.45);border-radius:8px;background:transparent;color:inherit;font-size:13px;cursor:pointer;}",
      ".dsh-email-notify-settings button.primary{background:rgba(127,127,127,.16);font-weight:600;}",
      ".dsh-email-notify-settings button:disabled{opacity:.5;cursor:default;}",
      ".dsh-email-notify-settings .msg{margin-top:10px;font-size:12px;white-space:pre-wrap;}",
    ].join("");

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
      return el("input", Object.assign({
        type: "text",
        value: value === undefined || value === null ? "" : String(value),
        on: { input: function (event) { onChange(event.target.value); } },
      }, extra || {}));
    }

    function numberInput(value, onChange, extra) {
      return el("input", Object.assign({
        type: "number",
        min: 0,
        value: value === undefined || value === null ? "" : String(value),
        on: { input: function (event) { onChange(event.target.value); } },
      }, extra || {}));
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
     * 设置面板本体：纯 DOM 构建。
     * 不把整份配置塞进 React state——字段多、还要保留"草稿未保存"的改动，
     * 直接读草稿对象 + 手动重绘表单更简单，也和 dsh-custom-font 的做法一致。
     */
    function buildPanel(root) {
      var draft = null;   // 正在编辑的配置（未保存的改动都在这里）
      var msgBox = el("div", { class: "msg" });
      var statusBox = el("div", { class: "status" });
      var body = el("div");
      var saveButton = el("button", { class: "primary", text: "保存设置", on: { click: function () { save(); } } });
      var testButton = el("button", { text: "发送测试邮件", on: { click: function () { sendTest(); } } });
      var reloadButton = el("button", { text: "重新读取", on: { click: function () { load(); } } });

      root.appendChild(el("div", {
        class: "desc",
        text: "这些设置保存在宿主端的 config.json 里，改完点「保存设置」立即生效，不用重启 DSH。授权码只存在本机，读回界面时永远为空（留空 = 不修改）。",
      }));
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
          statusBox.appendChild(el("div", {
            class: "line",
            text: "当前判定：" + (data.watching ? "你正在看界面（此时不发邮件）" : "你不在界面前（此时会发邮件）"),
          }));
          var last = data.lastSend;
          statusBox.appendChild(el("div", {
            class: "line " + (last ? (last.ok ? "ok" : "err") : ""),
            text: "上次发信：" + (last
              ? (last.ok
                ? "成功 · " + (last.subject || "") + " · " + new Date(last.at).toLocaleString("zh-CN", { hour12: false })
                : "失败 · " + (last.error || ""))
              : "还没有发过"),
          }));
          statusBox.appendChild(el("div", { class: "line hint", text: "配置文件：" + (data.configPath || "") }));
        }).catch(function () {
          statusBox.appendChild(el("div", { class: "line err", text: "读取状态失败：宿主端可能还没加载完，稍后点「重新读取」。" }));
        });
      }

      function renderForm() {
        while (body.firstChild) body.removeChild(body.firstChild);
        if (!draft) return;
        var smtp = draft.smtp || {};
        var events = draft.events || {};

        /* ── 邮件通道 ── */
        body.appendChild(el("div", { class: "group" }, [
          el("div", { class: "group-title", text: "邮件通道" }),
          el("div", { class: "group-desc", text: "QQ 邮箱用 smtp.qq.com:465 + 授权码（网页版邮箱 → 设置 → 账户 → 开启 IMAP/SMTP 服务后生成，不是登录密码）。" }),
          row("SMTP 服务器", textInput(smtp.host, function (v) { smtp.host = v.trim(); })),
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
          el("div", { class: "row" }, [el("label", { text: "安全" }), el("div", { class: "field" }, [
            checkbox("使用 TLS（465 端口勾选；587 不勾，走 STARTTLS）", smtp.secure, function (v) { smtp.secure = v; }),
          ])]),
          el("div", { class: "row" }, [el("label", { text: "高级" }), el("div", { class: "field" }, [
            checkbox("校验证书", smtp.rejectUnauthorized !== false, function (v) { smtp.rejectUnauthorized = v; }),
            checkbox("允许无 TLS 明文发送（仅本机/内网中继）", smtp.allowInsecure === true, function (v) { smtp.allowInsecure = v; }),
          ])]),
        ]));

        /* ── 通知时机 ── */
        body.appendChild(el("div", { class: "group" }, [
          el("div", { class: "group-title", text: "通知时机" }),
          el("div", { class: "group-desc", text: "离开电脑（窗口不在前台）时才发邮件；你在看界面时默认不打扰，靠界面上本来就有的提示。" }),
          checkbox("任务完成 / 出错时通知", events.turnEnd, function (v) { events.turnEnd = v; }),
          checkbox("工具需要我授权时通知", events.approval, function (v) { events.approval = v; }),
          checkbox("助手向我提问、等我回答时通知", events.question, function (v) { events.question = v; }),
          checkbox("子会话（subagent / 工作流子任务）也通知", draft.includeSubagents, function (v) { draft.includeSubagents = v; }, "默认只报主对话，避免一次任务收到一串邮件"),
          el("div", { class: "group-desc", text: "下面三项是「看界面时也弹一条提示」，默认全关——桌面外壳自己会弹完成通知，避免重复。" }),
          checkbox("看界面时也弹「任务完成」提示", draft.notifyWhenFocused, function (v) { draft.notifyWhenFocused = v; }),
          checkbox("看界面时也弹「需要授权」提示", draft.approvalNotifyWhenFocused, function (v) { draft.approvalNotifyWhenFocused = v; }),
          checkbox("看界面时也弹「向我提问」提示", draft.questionNotifyWhenFocused, function (v) { draft.questionNotifyWhenFocused = v; }),
        ]));

        /* ── 邮件内容 ── */
        body.appendChild(el("div", { class: "group" }, [
          el("div", { class: "group-title", text: "邮件内容" }),
          checkbox("正文附上「你的提问」与「最后回复」摘要", draft.includeExcerpts, function (v) { draft.includeExcerpts = v; }),
          row("摘要长度", numberInput(draft.excerptChars, function (v) { draft.excerptChars = Number(v) || 0; }), "字符"),
          row("主题前缀", textInput(draft.subjectPrefix, function (v) { draft.subjectPrefix = v; }), "例如 [DSH]"),
          row("正文里的地址", textInput(draft.linkBase, function (v) { draft.linkBase = v.trim(); }), "留空 = http://127.0.0.1:3080"),
        ]));

        /* ── 限流与判定 ── */
        body.appendChild(el("div", { class: "group" }, [
          el("div", { class: "group-title", text: "限流与判定" }),
          row("同类通知最小间隔", numberInput(draft.minIntervalSeconds, function (v) { draft.minIntervalSeconds = Number(v) || 0; }), "秒（同一会话）"),
          row("每分钟最多发", numberInput(draft.maxPerMinute, function (v) { draft.maxPerMinute = Number(v) || 0; }), "封，防死循环刷屏"),
          row("心跳过期判定", numberInput(draft.watchingStaleSeconds, function (v) { draft.watchingStaleSeconds = Number(v) || 0; }), "秒收不到界面心跳就当你已离开"),
          checkbox("启用插件（关掉后只保留设置，不发任何通知）", draft.enabled, function (v) { draft.enabled = v; }),
        ]));
      }

      function load() {
        setMessage(null, "");
        request("/config").then(function (result) {
          if (!result.ok) {
            setMessage("err", "读取配置失败：" + JSON.stringify(result.data));
            return;
          }
          draft = result.data.config;
          renderForm();
          renderStatus();
        }).catch(function (error) {
          setMessage("err", "读取配置失败：" + error.message + "\n（若刚装好插件，确认已经重启过 DSH）");
        });
      }

      function save() {
        if (!draft) return;
        saveButton.disabled = true;
        setMessage(null, "");
        request("/config", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ config: draft }),
        }).then(function (result) {
          if (!result.ok) {
            setMessage("err", "保存失败：" + (result.data.error || JSON.stringify(result.data)));
            return;
          }
          draft = result.data.config;
          renderForm();
          renderStatus();
          setMessage(result.data.ready ? "ok" : "warn", result.data.ready
            ? "已保存，配置就绪。"
            : "已保存，但还缺：" + (result.data.missing || []).join(", "));
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
      slots.inject("settings.section", function () {
        return slots.register({
          name: "settings.section",
          id: "email-notify",
          order: 65,
          label: function () { return "邮件通知"; },
        }, function () { return React.createElement(EmailNotifySettings); });
      });
    }

    // 模块一被求值就开始上报：在场信息要尽早送到宿主端。
    if (typeof document !== "undefined") start();

    exports.apply = apply;
    exports.inject = [];
    exports.name = "dsh-email-notify";
    exports.stop = stop;
    return module.exports;
  }
});
