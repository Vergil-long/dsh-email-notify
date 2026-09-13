/**
 * 客户端半侧自检：用最小 DOM 桩加载 client/client.js，验证
 *   - 在场状态上报（加载时、focus/blur/visibilitychange、心跳）
 *   - 轮询宿主队列并弹提示（系统通知不可用时退化成界面浮层）
 *   - 模块以 __ModuleLoader__ 包装格式导出 apply/inject/name
 *
 *   node test/client.test.mjs
 */
import assert from 'node:assert/strict'

/* ── 最小 DOM / 定时器 / fetch 桩 ─────────────────────────────── */

const created = []
const listeners = new Map()
let focused = true
let visibility = 'visible'
const fetchCalls = []

function makeElement(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    children: [],
    attributes: new Map(),
    removed: false,
    style: {},
    classList: {
      add: () => { node.className += ' is-in' },
      remove: () => { node.className = node.className.replace(' is-in', '') },
    },
    setAttribute: (key, value) => node.attributes.set(key, value),
    appendChild: (child) => { node.children.push(child); return child },
    removeChild: (child) => {
      const index = node.children.indexOf(child)
      if (index >= 0) node.children.splice(index, 1)
      return child
    },
    remove: () => {
      node.removed = true
      const index = created.indexOf(node)
      if (index >= 0) created.splice(index, 1)
    },
    addEventListener: (type, handler) => { (node.handlers ??= {})[type] = handler },
  }
  Object.defineProperty(node, 'firstChild', { get: () => node.children[0] ?? null })
  // 面板会写 ref.current.innerHTML = "" 清空自己，桩要跟着清 children。
  Object.defineProperty(node, 'innerHTML', {
    get: () => '',
    set: (value) => { if (value === '') node.children.length = 0 },
  })
  created.push(node)
  return node
}

const documentStub = {
  visibilityState: 'visible',
  documentElement: makeElement('html'),
  body: makeElement('body'),
  createElement: (tag) => makeElement(tag),
  hasFocus: () => focused,
  addEventListener: (type, handler) => { (listeners.get(type) ?? listeners.set(type, []).get(type)).push(handler) },
  querySelector: (selector) => {
    if (selector === 'style[data-dsh-email-notify]') {
      return created.find((node) => node.tagName === 'STYLE' && node.attributes.has('data-dsh-email-notify')) ?? null
    }
    if (selector === '.dsh-email-notify-stack') return created.find((node) => node.className.includes('dsh-email-notify-stack')) ?? null
    if (selector.startsWith('a[href*=')) return null
    return null
  },
}
// visibilityState 要跟着变量走
Object.defineProperty(documentStub, 'visibilityState', { get: () => visibility })
Object.defineProperty(documentStub, 'head', { get: () => documentStub.documentElement })

const intervalCallbacks = []
const timeoutCallbacks = []

globalThis.window = {
  addEventListener: (type, handler) => { (listeners.get(type) ?? listeners.set(type, []).get(type)).push(handler) },
  focus: () => {},
  __ModuleLoader__: {
    load: (entry) => { globalThis.__loaded = entry },
  },
}
globalThis.document = documentStub
// Node 24 自带只读的 navigator，要覆盖得用 defineProperty。
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Electron/32' }, configurable: true, writable: true })
/** 设置面板用的样板配置（GET /config 的返回）。 */
function sampleConfig() {
  return {
    enabled: true,
    smtp: { host: 'smtp.qq.com', port: 465, secure: true, rejectUnauthorized: true, allowInsecure: false, user: 'me@qq.com', pass: '', passSet: true, fromName: 'DeepSeek Harness', from: 'me@qq.com' },
    to: ['me@qq.com'],
    events: { turnEnd: true, approval: true, question: true },
    includeSubagents: false,
    notifyWhenFocused: false,
    approvalNotifyWhenFocused: false,
    questionNotifyWhenFocused: false,
    minIntervalSeconds: 20,
    maxPerMinute: 6,
    excerptChars: 700,
    includeExcerpts: true,
    subjectPrefix: '[DSH]',
    linkBase: '',
    watchingStaleSeconds: 90,
  }
}

globalThis.fetch = async (url, options = {}) => {
  const target = String(url)
  fetchCalls.push({ url: target, options })
  if (target.includes('/inbox')) return { ok: true, json: async () => globalThis.__inboxResponse }
  if (target.endsWith('/config')) {
    return {
      ok: true,
      json: async () => ({
        ok: true,
        config: sampleConfig(),
        ready: true,
        missing: [],
        configPath: 'C:\\Users\\x\\.dsh\\dsh-email-notify\\config.json',
      }),
    }
  }
  if (target.endsWith('/status')) {
    return {
      ok: true,
      json: async () => ({
        enabled: true, ready: true, missing: [], watching: true,
        lastSend: { at: Date.now(), ok: true, subject: '[DSH] ✅ 任务已完成' },
        configPath: 'C:\\Users\\x\\.dsh\\dsh-email-notify\\config.json',
      }),
    }
  }
  if (target.endsWith('/test')) return { ok: true, json: async () => ({ ok: true, to: ['me@qq.com'] }) }
  return { ok: true, json: async () => ({ ok: true, watching: true }) }
}
globalThis.requestAnimationFrame = (callback) => { callback(); return 1 }
const realSetInterval = globalThis.setInterval
const realSetTimeout = globalThis.setTimeout
globalThis.setInterval = (callback, ms) => { intervalCallbacks.push({ callback, ms }); return intervalCallbacks.length }
globalThis.setTimeout = (callback, ms) => { timeoutCallbacks.push({ callback, ms }); return timeoutCallbacks.length }
globalThis.clearInterval = () => {}
globalThis.__inboxResponse = { items: [], next: 0 }

const flush = () => new Promise((resolve) => realSetTimeout(resolve, 10))
const dispatch = (type) => { for (const handler of listeners.get(type) ?? []) handler({ type }) }

/* ── 加载客户端模块 ───────────────────────────────────────────── */

await import('../client/client.js')
const entry = globalThis.__loaded
assert.ok(entry, '模块应通过 window.__ModuleLoader__.load 注册')

const moduleExports = entry.factory((name) => {
  throw new Error(`客户端半侧不应 require("${name}")`)
})

let failures = 0
async function test(name, fn) {
  try {
    await fn()
    console.log(`✓ ${name}`)
  } catch (error) {
    failures += 1
    console.log(`✗ ${name}\n   ${error.message}`)
  }
}

/* ── 用例 ─────────────────────────────────────────────────────── */

await test('以加载器要求的格式导出 apply / inject / name', () => {
  assert.equal(entry.id, 'dsh-email-notify')
  assert.equal(typeof moduleExports.apply, 'function')
  assert.equal(moduleExports.name, 'dsh-email-notify')
  assert.deepEqual(moduleExports.inject, [])
})

await test('模块被求值时就上报「在看界面」（不用等 apply）', async () => {
  await flush()
  const presence = fetchCalls.filter((call) => call.url.endsWith('/presence'))
  assert.equal(presence.length >= 1, true, '应当已经上报过一次')
  const body = JSON.parse(presence.at(-1).options.body)
  assert.equal(body.focused, true)
  assert.equal(body.visible, true)
  assert.equal(typeof body.clientId, 'string')
  assert.equal(JSON.parse(presence.at(-1).options.body).clientId.length > 4, true)
})

await test('apply 幂等：重复调用不会重复开心跳/轮询', async () => {
  const before = intervalCallbacks.length
  moduleExports.apply({})
  moduleExports.apply({})
  assert.equal(intervalCallbacks.length, before, '不应新增定时器')
  assert.equal(intervalCallbacks.length, 2, '心跳 + 轮询各一个')
})

await test('窗口失焦 / 页面隐藏都会立刻上报', async () => {
  const before = fetchCalls.length
  focused = false
  dispatch('blur')
  await flush()
  assert.equal(JSON.parse(fetchCalls.at(-1).options.body).focused, false)

  focused = true
  visibility = 'hidden'
  dispatch('visibilitychange')
  await flush()
  const last = JSON.parse(fetchCalls.at(-1).options.body)
  assert.equal(last.visible, false)
  assert.equal(last.focused, true)
  assert.equal(fetchCalls.length >= before + 2, true)
  visibility = 'visible'
})

await test('心跳按 20 秒触发上报', async () => {
  const heartbeat = intervalCallbacks.find((item) => item.ms === 20000)
  assert.ok(heartbeat, '应有 20s 心跳')
  const before = fetchCalls.length
  heartbeat.callback()
  await flush()
  assert.equal(fetchCalls.length, before + 1)
})

await test('轮询拿到宿主提示时：没有系统通知就退化成界面浮层卡片', async () => {
  const poll = intervalCallbacks.find((item) => item.ms === 4000)
  assert.ok(poll, '应有 4s 轮询')
  globalThis.__inboxResponse = {
    items: [{ id: 3, kind: 'turn-end', notifyTitle: '任务已完成 · 加邮件通知', notifyBody: '已完成', sessionId: 'session-1' }],
    next: 3,
  }
  poll.callback()
  await flush()
  const card = created.find((node) => node.className.includes('dsh-email-notify-card'))
  assert.ok(card, '应当出现浮层卡片')
  const texts = card.children.map((child) => child.textContent)
  assert.deepEqual(texts.slice(0, 2), ['任务已完成 · 加邮件通知', '已完成'])
  assert.equal(created.some((node) => node.tagName === 'STYLE' && node.attributes.has('data-dsh-email-notify')), true, '应注入样式')
})

await test('轮询会带上游标，避免重复弹同一条', async () => {
  const poll = intervalCallbacks.find((item) => item.ms === 4000)
  const before = fetchCalls.length
  poll.callback()
  await flush()
  const call = fetchCalls.at(-1)
  assert.equal(call.url, '/dsh-email-notify/inbox?since=3')
  assert.equal(fetchCalls.length >= before + 1, true)
})

await test('页面隐藏时不轮询（省电、也避免误弹）', async () => {
  visibility = 'hidden'
  const before = fetchCalls.length
  intervalCallbacks.find((item) => item.ms === 4000).callback()
  await flush()
  assert.equal(fetchCalls.length, before)
  visibility = 'visible'
})

await test('系统通知可用时优先用它，而不是浮层', async () => {
  const notes = []
  globalThis.Notification = function Notification(title, options) { notes.push({ title, options }) }
  globalThis.Notification.permission = 'granted'
  const cardsBefore = created.filter((node) => node.className.includes('dsh-email-notify-card')).length
  globalThis.__inboxResponse = {
    items: [{ id: 4, kind: 'turn-end', notifyTitle: '任务已完成', notifyBody: 'done', sessionId: 'session-2' }],
    next: 4,
  }
  intervalCallbacks.find((item) => item.ms === 4000).callback()
  await flush()
  assert.equal(notes.length, 1)
  assert.equal(notes[0].title, '任务已完成')
  assert.equal(notes[0].options.body, 'done')
  assert.match(notes[0].options.tag, /session-2/)
  const cardsAfter = created.filter((node) => node.className.includes('dsh-email-notify-card')).length
  assert.equal(cardsAfter, cardsBefore, '不应再额外弹浮层')
  delete globalThis.Notification
})

await test('不监听鼠标键盘活动（避免每次敲键都刷接口）', () => {
  const listened = [...listeners.keys()]
  assert.equal(listened.includes('keydown'), false)
  assert.equal(listened.includes('pointerdown'), false)
  for (const type of ['focus', 'blur', 'visibilitychange', 'pagehide', 'beforeunload']) {
    assert.equal(listened.includes(type), true, `应当监听 ${type}`)
  }
})

await test('首次访问不带游标（宿主只回游标，不补发历史）', async () => {
  // 重新加载一遍模块，模拟刷新页面
  intervalCallbacks.length = 0
  fetchCalls.length = 0
  globalThis.__inboxResponse = { items: [], next: 42 }
  delete globalThis.__loaded
  await import(`../client/client.js?reload=${Date.now()}`)
  const reloaded = globalThis.__loaded.factory(() => {})
  reloaded.apply({})
  // 首次轮询走的是 1.5s 的启动延时，这里手动触发一次。
  const boot = timeoutCallbacks.filter((item) => item.ms === 1500).at(-1)
  assert.ok(boot, '应当注册了启动轮询')
  boot.callback()
  await flush()
  const inboxCall = fetchCalls.find((call) => call.url.includes('/inbox'))
  assert.ok(inboxCall, '首次轮询应当发生')
  assert.equal(inboxCall.url, '/dsh-email-notify/inbox')
})

/* ── 设置面板：用一个最小的 React 桩把组件挂起来 ────────────────── */

await test('设置面板：注册成 harness 设置里的「邮件通知」一节，并渲染出表单', async () => {
  const pendingEffects = []
  const ReactStub = {
    useRef: (init) => ({ current: init ?? null }),
    useEffect: (fn) => { pendingEffects.push(fn) },
    createElement: (tag, props) => {
      if (typeof tag === 'function') {
        const tree = tag(props ?? {})
        // 真 React 是「先提交 DOM、再跑 effect」，这里照同样顺序，否则 ref.current 还是空。
        while (pendingEffects.length) pendingEffects.shift()()
        return tree
      }
      const node = makeElement(tag)
      if (props && props.ref) props.ref.current = node
      return node
    },
  }

  delete globalThis.__loaded
  await import(`../client/client.js?panel=${Date.now()}`)
  const panelExports = globalThis.__loaded.factory((name) => {
    if (name === 'react') return ReactStub
    throw new Error(`未预期的 require("${name}")`)
  })

  const registrations = []
  panelExports.apply({
    slots: {
      inject: (name, produce) => { registrations.push({ name, value: produce() }) },
      register: (spec, factory) => ({ spec, factory }),
    },
  })

  assert.equal(registrations.length, 1, '应当注入一节设置面板')
  assert.equal(registrations[0].name, 'settings.section')
  assert.equal(registrations[0].value.spec.id, 'email-notify')
  assert.equal(registrations[0].value.spec.label(), '邮件通知')

  const rendered = registrations[0].value.factory()
  await flush()
  const panel = created.find((node) => node.className.includes('dsh-email-notify-settings'))
  assert.ok(panel, '应当渲染出面板根节点')
  assert.ok(panel.children.length >= 4, '面板应当有说明/状态/按钮/表单几块')

  // 读到样板配置后，表单里应当出现这些分组的标题
  const texts = []
  const collect = (node) => {
    if (node.textContent) texts.push(node.textContent)
    for (const child of node.children ?? []) collect(child)
  }
  collect(panel)
  for (const label of ['邮件通道', '通知时机', '邮件内容', '限流与判定']) {
    assert.equal(texts.includes(label), true, `应当有「${label}」分组`)
  }
  assert.equal(texts.includes('保存设置'), true)
  assert.equal(texts.includes('发送测试邮件'), true)
  assert.equal(fetchCalls.some((call) => call.url.endsWith('/config')), true, '应当去读配置')

  // 点「保存设置」应当把草稿 POST 回宿主端
  const findButton = (node, text) => {
    if (node.tagName === 'BUTTON' && node.textContent === text) return node
    for (const child of node.children ?? []) {
      const hit = findButton(child, text)
      if (hit) return hit
    }
    return null
  }
  const saveButton = findButton(panel, '保存设置')
  assert.ok(saveButton, '应当有保存按钮')
  const beforeSaves = fetchCalls.filter((call) => call.url.endsWith('/config') && call.options?.method === 'POST').length
  saveButton.handlers.click()
  await flush()
  const saves = fetchCalls.filter((call) => call.url.endsWith('/config') && call.options?.method === 'POST')
  assert.equal(saves.length, beforeSaves + 1, '点保存应当发一次 POST')
  const body = JSON.parse(saves.at(-1).options.body)
  assert.equal(body.config.smtp.host, 'smtp.qq.com')
  assert.equal(body.config.smtp.pass, '', '界面上口令字段为空，POST 里也必须是空（= 不修改）')
  assert.equal(JSON.stringify(body).includes('authcode'), false)
  void rendered
})

console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`)
globalThis.setInterval = realSetInterval
globalThis.setTimeout = realSetTimeout
process.exit(failures === 0 ? 0 : 1)
