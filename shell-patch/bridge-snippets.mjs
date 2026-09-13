/**
 * 外壳注入脚本的两个版本：原版与修补版。
 *
 * 单独放一个模块，是为了让 patch-completion-notify.mjs（打补丁）和
 * test-completion-bridge.mjs（行为自检）共用同一份文本，不会抄着抄着走样。
 *
 * 文本按 LF 写；真实 main.js 是 CRLF，由调用方负责换行风格转换。
 * 文中的反引号写成 \` 、正则里的双反斜杠写成 \\\\，必须与 asar 里的字节完全一致。
 */

/** 原版：状态表按「稳定 id + 标题 + 同名序号」建键 —— 标题一变就误报"完成"。 */
export const ORIGINAL_FUNCTION = `async function injectTaskCompletionBridge() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await mainWindow.webContents.executeJavaScript(\`
    (function () {
      if (window.__dshTaskCompletionObserver) return;
      const states = new Map();
      let scanQueued = false;
      const clean = (value) => (value || '').replace(/\\\\s+/g, ' ').trim();
      const statusOf = (row) => {
        const label = clean(row.firstElementChild && row.firstElementChild.textContent);
        const aria = clean(row.getAttribute && (row.getAttribute('aria-label') || row.getAttribute('data-state')));
        const text = label + ' ' + aria;
        if (/(等待批准|等待回答|计划审核|等待输入|Waiting for (?:approval|answer|input)|Plan review)/i.test(text)) return 'waiting';
        if (/(进行中|运行中|生成中|思考中|Running|Thinking|In progress)/i.test(text)) return 'running';
        if (/(已完成|完成|已结束|Completed|Done|Finished)/i.test(text)) return 'completed';
        if (/(失败|出错|已取消|Failed|Error|Cancelled|Canceled)/i.test(text)) return 'failed';
        return 'idle';
      };
      const titleOf = (row, state) => {
        const children = Array.from(row.children);
        const first = clean(children[0] && children[0].textContent);
        const titleNode = state === 'idle' && first ? children[0] : children[1];
        return clean(titleNode && titleNode.textContent) || 'DeepSeek Harness';
      };
      const urlOf = (row) => {
        const link = row.matches && row.matches('a[href]') ? row : row.querySelector && row.querySelector('a[href]');
        try { return link ? new URL(link.getAttribute('href'), location.href).href : location.href; }
        catch (_error) { return location.href; }
      };
      const scan = () => {
        scanQueued = false;
        const counts = new Map();
        const seen = new Set();
        document.querySelectorAll('[role="treeitem"]:not(button), li[data-state], div[data-state="task"]').forEach((row) => {
          const state = statusOf(row);
          const title = titleOf(row, state);
          const taskUrl = urlOf(row);
          const occurrence = counts.get(title) || 0;
          counts.set(title, occurrence + 1);
          const stableId = row.id || row.getAttribute('data-id') || row.getAttribute('data-key') || taskUrl;
          const key = stableId + '::' + title + '::' + occurrence;
          seen.add(key);
          const previous = states.get(key);
          if (previous && (previous.state === 'running' || previous.state === 'waiting') &&
              (state === 'completed' || state === 'failed')) {
            window.dshWin && window.dshWin.taskComplete({ key, title, taskUrl });
          }
          states.set(key, { state, title, taskUrl });
        });
        for (const [key, previous] of states) {
          if (!seen.has(key)) {
            if (previous.state === 'running' || previous.state === 'waiting') {
              window.dshWin && window.dshWin.taskComplete({
                key, title: previous.title, taskUrl: previous.taskUrl,
              });
            }
            states.delete(key);
          }
        }
      };
      const queueScan = () => {
        if (scanQueued) return;
        scanQueued = true;
        queueMicrotask(scan);
      };
      window.__dshTaskCompletionObserver = new MutationObserver(queueScan);
      window.__dshTaskCompletionObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      scan();
    })();
  \`);
}`

/** 修补版：状态表只按稳定行标识建键，并给"行消失"分支加两道保险。 */
export const PATCHED_FUNCTION = `async function injectTaskCompletionBridge() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await mainWindow.webContents.executeJavaScript(\`
    (function () {
      if (window.__dshTaskCompletionObserver) return;
      // dsh-email-notify stable-key fix（2026-09-13）
      // 原实现把「标题 + 同名序号」也算进 key：会话标题一变，旧 key 就"消失"，
      // 而它消失前的状态是 running，于是被误判成"任务完成"。
      // 实测（外壳日志 vs 会话日志按时间对齐）：191 条通知里 163 条发生在回合还没结束的时候。
      // 现在：状态表只按「稳定行标识」建键，标题只用于显示；"行消失"分支另加两道保险。
      const states = new Map();
      const RUNNING_MIN_MS = 4000;
      let scanQueued = false;
      const clean = (value) => (value || '').replace(/\\\\s+/g, ' ').trim();
      const statusOf = (row) => {
        const label = clean(row.firstElementChild && row.firstElementChild.textContent);
        const aria = clean(row.getAttribute && (row.getAttribute('aria-label') || row.getAttribute('data-state')));
        const text = label + ' ' + aria;
        if (/(等待批准|等待回答|计划审核|等待输入|Waiting for (?:approval|answer|input)|Plan review)/i.test(text)) return 'waiting';
        if (/(进行中|运行中|生成中|思考中|Running|Thinking|In progress)/i.test(text)) return 'running';
        if (/(已完成|完成|已结束|Completed|Done|Finished)/i.test(text)) return 'completed';
        if (/(失败|出错|已取消|Failed|Error|Cancelled|Canceled)/i.test(text)) return 'failed';
        return 'idle';
      };
      const titleOf = (row, state) => {
        const children = Array.from(row.children);
        const first = clean(children[0] && children[0].textContent);
        const titleNode = state === 'idle' && first ? children[0] : children[1];
        return clean(titleNode && titleNode.textContent) || 'DeepSeek Harness';
      };
      const urlOf = (row) => {
        const link = row.matches && row.matches('a[href]') ? row : row.querySelector && row.querySelector('a[href]');
        try { return link ? new URL(link.getAttribute('href'), location.href).href : location.href; }
        catch (_error) { return location.href; }
      };
      const scan = () => {
        scanQueued = false;
        const rows = document.querySelectorAll('[role="treeitem"]:not(button), li[data-state], div[data-state="task"]');
        const seen = new Set();
        const now = Date.now();
        rows.forEach((row) => {
          const state = statusOf(row);
          const title = titleOf(row, state);
          const taskUrl = urlOf(row);
          const stableId = row.id || row.getAttribute('data-id') || row.getAttribute('data-key') || taskUrl;
          seen.add(stableId);
          const previous = states.get(stableId);
          if (previous && (previous.state === 'running' || previous.state === 'waiting') &&
              (state === 'completed' || state === 'failed')) {
            window.dshWin && window.dshWin.taskComplete({ key: stableId, title, taskUrl });
          }
          const sameState = previous && previous.state === state;
          states.set(stableId, {
            state,
            title,
            taskUrl,
            element: row,
            since: sameState ? previous.since : now,
          });
        });
        // 保险一：侧栏整块不可见时（例如打开了设置页），本来就一行都扫不到，
        // 这时绝不能推断"那些正在跑的任务都结束了"。
        if (rows.length === 0) return;
        for (const [stableId, previous] of states) {
          if (seen.has(stableId)) continue;
          // 保险二：元素还挂在文档里 → 只是换了 key（重渲染/换 id），不是任务结束。
          if (previous.element && previous.element.isConnected) {
            states.delete(stableId);
            continue;
          }
          // 元素真的没了：跑够一会儿才算结束，刚跑几秒的多半是列表重排。
          if ((previous.state === 'running' || previous.state === 'waiting') &&
              now - previous.since >= RUNNING_MIN_MS) {
            window.dshWin && window.dshWin.taskComplete({
              key: stableId, title: previous.title, taskUrl: previous.taskUrl,
            });
          }
          states.delete(stableId);
        }
      };
      const queueScan = () => {
        if (scanQueued) return;
        scanQueued = true;
        queueMicrotask(scan);
      };
      window.__dshTaskCompletionObserver = new MutationObserver(queueScan);
      window.__dshTaskCompletionObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      scan();
    })();
  \`);
}`

/** 从函数文本里切出注入的那段脚本本体。 */
export function injectedScriptOf(functionText) {
  const match = /executeJavaScript\(`([\s\S]*?)`\);/.exec(functionText)
  if (!match) throw new Error('没能从函数文本里切出注入脚本')
  return match[1]
}
