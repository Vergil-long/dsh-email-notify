/**
 * 客户端半侧自检：用最小 DOM 桩加载 client/client.js，验证
 *   - 在场状态上报（加载时、focus/blur/visibilitychange、心跳）
 *   - 轮询宿主队列并弹提示（系统通知不可用时退化成界面浮层）
 *   - 模块以 __ModuleLoader__ 包装格式导出 apply/inject/name
 *
 *   node test/client.test.mjs
 */
import assert from 'node:assert/strict'

import { DEFAULT_BODY_TEMPLATE, DEFAULT_SUBJECT_TEMPLATE, DETAILED_BODY_TEMPLATE, PLACEHOLDERS } from '../lib/template.js'

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
    appendChild: (child) => {
      node.children.push(child)
      if (child && typeof child === 'object') child.parentNode = node
      return child
    },
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
    // 通用处理 style[data-xxx]：面板样式、按钮样式都走这条。
    const styleMatch = /^style\[data-([^\]]+)\]$/.exec(selector)
    if (styleMatch) {
      return created.find((node) => node.tagName === 'STYLE' && node.attributes.has('data-' + styleMatch[1])) ?? null
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
    subjectTemplate: '',
    bodyTemplate: '',
    awayMode: false,
    autoMode: false,
    subjectPrefix: '[DSH]',
    linkBase: '',
    watchingStaleSeconds: 90,
  }
}

/**
 * 假宿主端保存的配置。POST /config 会真的改它 —— 页头按钮点一下之后要能从
 * 响应里读到新状态，不然测出来的是"按钮永远显示关"。
 */
let serverConfig = sampleConfig()

globalThis.fetch = async (url, options = {}) => {
  const target = String(url)
  fetchCalls.push({ url: target, options })
  if (target.includes('/inbox')) return { ok: true, json: async () => globalThis.__inboxResponse }
  if (target.endsWith('/config')) {
    if (options?.method === 'POST') {
      const patch = (JSON.parse(options.body).config) ?? {}
      const smtp = patch.smtp ? { ...serverConfig.smtp, ...patch.smtp } : serverConfig.smtp
      serverConfig = { ...serverConfig, ...patch, smtp }
    }
    return {
      ok: true,
      json: async () => ({
        ok: true,
        config: serverConfig,
        ready: true,
        missing: [],
        configPath: 'C:\\Users\\x\\.dsh\\dsh-email-notify\\config.json',
        // 宿主端下发的模板元数据（与 lib/template.js 同一份，这里直接引用真常量）。
        templates: {
          defaultSubject: DEFAULT_SUBJECT_TEMPLATE,
          defaultBody: DEFAULT_BODY_TEMPLATE,
          detailedBody: DETAILED_BODY_TEMPLATE,
          placeholders: PLACEHOLDERS,
        },
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
  assert.deepEqual(moduleExports.inject, ['slots'], '声明依赖 slots，设置面板才不会因服务未就绪被跳过')
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

  assert.equal(registrations.length, 2, '应当注入设置面板 + 会话页头的开关')
  assert.equal(registrations[0].name, 'settings.section')
  assert.equal(registrations[0].value.spec.id, 'email-notify')
  assert.equal(registrations[0].value.spec.label(), '邮件通知')

  const rendered = registrations[0].value.factory()
  await flush()
  const panel = created.find((node) => node.className.includes('dsh-email-notify-settings'))
  assert.ok(panel, '应当渲染出面板根节点')
  assert.ok(panel.children.length >= 4, '面板应当有状态/按钮/消息/表单几块')

  // ── 基础页：新手只需要「邮件通道」+「邮件内容」，其余收进高级页 ──
  const collectTexts = () => {
    const texts = []
    const walk = (node) => {
      if (node.textContent) texts.push(node.textContent)
      for (const child of node.children ?? []) walk(child)
    }
    walk(panel)
    return texts
  }
  const findLive = (predicate) => {
    let hit = null
    const walk = (node) => {
      if (!hit && predicate(node)) hit = node
      for (const child of node.children ?? []) walk(child)
    }
    walk(panel)
    return hit
  }
  const findButton = (text) => findLive((node) => node.tagName === 'BUTTON' && node.textContent === text)

  let texts = collectTexts()
  for (const label of ['邮件通道', '邮件内容', '高级设置']) {
    assert.equal(texts.includes(label), true, `基础页应当有「${label}」分组`)
  }
  for (const label of ['通知时机', '限流与判定', 'SMTP 服务器']) {
    assert.equal(texts.includes(label), false, `「${label}」应当收进高级页，基础页上看不到`)
  }
  assert.equal(texts.includes('保存设置'), true)
  assert.equal(texts.includes('发送测试邮件'), true)
  assert.equal(fetchCalls.some((call) => call.url.endsWith('/config')), true, '应当去读配置')

  // 状态框只留两行：判定 / 发信方式 / 配置文件路径对使用者没意义（发信方式看页头按钮就够）
  const statusTexts = []
  const collectStatus = (node) => {
    if (node.textContent) statusTexts.push(node.textContent)
    for (const child of node.children ?? []) collectStatus(child)
  }
  collectStatus(findLive((node) => node.className === 'status'))
  for (const gone of ['当前判定', '发信方式', '配置文件']) {
    assert.equal(statusTexts.some((text) => text.includes(gone)), false, `状态框不该再显示「${gone}」`)
  }
  assert.equal(statusTexts.some((text) => text.includes('状态：配置就绪')), true, '状态框应当报告配置就绪')
  assert.equal(statusTexts.some((text) => text.includes('上次发信')), true)

  // 保存按钮要和别的按钮长得一样（早先带常驻灰底，看起来像一直按着没弹起来）
  assert.equal(findButton('保存设置').className, '', '保存按钮不该带常驻高亮样式')

  // 「配置存在哪 / 授权码不回显」那段说明从主界面挪进高级页
  assert.equal(texts.some((text) => text.includes('config.json 里')), false, '基础页不该再显示那段说明')

  // 邮件通道的说明按用户给的说法
  assert.equal(texts.some((text) => text.includes('IMAP/SMTP 授权码')), true)
  assert.equal(texts.some((text) => text.includes('账户与安全')), true)

  // 两个模板框都要**预填**内置默认模板：留空会让用户以为坏了，也没法照着改。
  // 标题用单行 input（它天生只有一行，多行框会白占半屏），正文才用 textarea。
  assert.equal(findLive((node) => node.tagName === 'INPUT' && node.value === DEFAULT_SUBJECT_TEMPLATE) !== null, true,
    '标题模板应当是单行输入框，并预填默认模板')
  assert.equal(findLive((node) => node.tagName === 'TEXTAREA' && node.value === DEFAULT_SUBJECT_TEMPLATE) !== null, false,
    '标题模板不该是多行框（那正是"太高"的原因）')
  assert.equal(findLive((node) => node.tagName === 'TEXTAREA' && node.value === DEFAULT_BODY_TEMPLATE) !== null, true,
    '正文模板框应当预填默认模板')

  // 预览要按样例数据渲染出成品，而不是显示模板原文
  const previewTexts = []
  const collectPreview = (node) => {
    if (node.textContent) previewTexts.push(node.textContent)
    for (const child of node.children ?? []) collectPreview(child)
  }
  // 精确匹配 class="preview"：外层现在还有 preview-block / preview-title，
  // 用 includes 会把标题文字也收进来。
  const previewNode = findLive((node) => node.className === 'preview')
  assert.ok(previewNode, '应当有预览区')
  collectPreview(previewNode)
  assert.equal(previewTexts.some((text) => text.includes('工作区：F:\\Space For AI work\\harness')), true,
    '预览里应当看到渲染后的正文')
  assert.equal(previewTexts.some((text) => text.includes('{')), false,
    `预览里不该残留未替换的占位符：${previewTexts.join(' | ')}`)

  // 预览与上面的设置要能区分开：有分隔线，且预览区带标题
  assert.ok(findLive((node) => node.className === 'divider'), '预览前应当有一条分隔线')
  assert.equal(findLive((node) => node.className === 'preview-title')?.textContent ?? '', '预览')

  const posts = () => fetchCalls.filter((call) => call.url.endsWith('/config') && call.options?.method === 'POST')
  const saveButton = findButton('保存设置')
  assert.ok(saveButton, '应当有保存按钮')

  // 什么都没改就点保存：不该发请求（避免把一堆默认值固化进用户文件）
  saveButton.handlers.click()
  await flush()
  assert.equal(posts().length, 0, '没有改动时不应发 POST')
  assert.match(msgBoxText(panel), /没有检测到改动/)

  // ── 高级页：点进去、看得见老字段、能返回 ──
  const advancedButton = findButton('高级设置 ▸')
  assert.ok(advancedButton, '基础页应当有进入高级页的按钮')
  advancedButton.handlers.click()
  await flush()
  texts = collectTexts()
  for (const label of ['SMTP 服务器', '发信时机', '通知时机', '标题与地址', '限流与判定']) {
    assert.equal(texts.includes(label), true, `高级页应当有「${label}」分组`)
  }
  assert.ok(findButton('← 返回基础设置'), '高级页应当能返回基础页')
  assert.equal(texts.some((text) => text.includes('config.json 里')), true,
    '「配置存在哪 / 授权码不回显」的说明应当在高级页上')

  // 改一个开关再保存：POST 里应当只有这一处改动
  const toggle = findLive((node) => node.tagName === 'INPUT' && node.type === 'checkbox'
    && node.parentNode?.children?.[1]?.textContent === '任务完成 / 出错时通知')
  assert.ok(toggle, '高级页应当能找到「任务完成 / 出错时通知」这个开关')
  toggle.handlers.change({ target: { checked: false } })
  saveButton.handlers.click()
  await flush()
  const saves = posts()
  assert.equal(saves.length, 1, '改了内容就应当发一次 POST')
  const body = JSON.parse(saves[0].options.body)
  assert.deepEqual(body, { config: { events: { turnEnd: false } } }, '只回传差异，不把整份配置写回去')
  assert.equal(JSON.stringify(body).includes('authcode'), false)

  // ── 回到基础页：点占位符应当插进模板，并且真的随保存回传 ──
  findButton('← 返回基础设置').handlers.click()
  await flush()
  const chip = findLive((node) => String(node.className).includes('tag') && node.textContent === '{最后回复}')
  assert.ok(chip, '应当列出可点的占位符')
  chip.handlers.click()
  await flush()
  const filled = findLive((node) => node.tagName === 'TEXTAREA' && String(node.value).includes('{最后回复}'))
  assert.ok(filled, '点占位符后正文模板里应当多出该占位符')
  const beforeChipSave = posts().length
  findButton('保存设置').handlers.click()
  await flush()
  const afterChip = posts()
  assert.equal(afterChip.length, beforeChipSave + 1, '改过模板就应当保存')
  const chipBody = JSON.parse(afterChip.at(-1).options.body)
  assert.match(chipBody.config.bodyTemplate, /\{最后回复\}/, '编辑过的模板要回传')
  assert.equal(chipBody.config.subjectTemplate, undefined, '没动过的标题模板不该被写回配置')
  void rendered
})

/* ── 会话页头的「离开模式」按钮 ───────────────────────────────── */

/**
 * 把客户端模块挂起来，返回它注册的槽位列表。
 * 每个用例都要重新 import（带不同 query）才能拿到干净的模块状态。
 */
async function mountClient(tag) {
  const pendingEffects = []
  const ReactStub = {
    useRef: (init) => ({ current: init ?? null }),
    useEffect: (fn) => { pendingEffects.push(fn) },
    createElement: (tagName, props) => {
      if (typeof tagName === 'function') {
        const tree = tagName(props ?? {})
        while (pendingEffects.length) pendingEffects.shift()()
        return tree
      }
      const node = makeElement(tagName)
      if (props && props.ref) props.ref.current = node
      return node
    },
  }
  delete globalThis.__loaded
  await import(`../client/client.js?${tag}=${Date.now()}-${Math.round(Math.random() * 1e6)}`)
  const loaded = globalThis.__loaded.factory((name) => {
    if (name === 'react') return ReactStub
    throw new Error(`未预期的 require("${name}")`)
  })
  const registrations = []
  loaded.apply({
    slots: {
      inject: (name, produce) => { registrations.push({ name, value: produce() }) },
      register: (spec, factory) => ({ spec, factory }),
    },
  })
  return registrations
}

await test('页头按钮：显示当前状态，点一下开、再点一下关（只回传 awayMode）', async () => {
  serverConfig = sampleConfig()
  const registrations = await mountClient('mode')
  const mode = registrations.find((item) => item.name === 'conversation.session.header.utilities')
  assert.ok(mode, '应当往 conversation.session.header.utilities 注册开关')

  const host = mode.value.factory()
  await flush()
  const button = () => host.children[0]
  const label = () => button().children[1].textContent
  const posts = () => fetchCalls.filter((call) => call.url.endsWith('/config') && call.options?.method === 'POST')
  const lastPost = () => JSON.parse(posts().at(-1).options.body)
  // fetchCalls 是整个文件累加的（前面的面板用例也 POST 过），所以看增量。
  const before = posts().length

  assert.equal(label(), '离开模式：关', '默认应当是关（要人工开启才发邮件）')
  assert.match(button().attributes.get('title'), /不会发任何邮件/)

  button().handlers.click()
  await flush()
  assert.equal(posts().length, before + 1, '点一下应当写一次配置')
  assert.deepEqual(lastPost(), { config: { awayMode: true } }, '只回传 awayMode，别把别的字段一起写回去')
  assert.equal(label(), '离开模式：开')
  assert.match(button().attributes.get('title'), /都会发邮件/)

  button().handlers.click()
  await flush()
  assert.equal(posts().length, before + 2, '再点一下应当再写一次')
  assert.equal(label(), '离开模式：关')
  assert.deepEqual(lastPost(), { config: { awayMode: false } })
})

await test('自动模式开着时：页头按钮变灰并注明原因（不让人白点）', async () => {
  serverConfig = { ...sampleConfig(), autoMode: true }
  const registrations = await mountClient('modeauto')
  const host = registrations.find((item) => item.name === 'conversation.session.header.utilities').value.factory()
  await flush()
  const button = host.children[0]
  assert.equal(button.disabled, true, '自动模式下按钮应当不可点')
  assert.match(button.children[1].textContent, /自动/)
  assert.match(button.attributes.get('title'), /自动模式已开启/)
})

await test('样式热重载：已注入的 <style> 内容会跟着更新（否则升级后新样式永远不生效）', async () => {
  // 第一次加载：把样式注入进去
  const first = await mountClient('css1')
  first.find((item) => item.name === 'settings.section').value.factory()
  await flush()
  const style = created.find((node) => node.tagName === 'STYLE' && node.attributes.has('data-dsh-email-notify-panel'))
  assert.ok(style, '应当注入面板样式')
  assert.match(style.textContent, /\.divider/, '样式里应当有预览分隔线那条规则')

  // 模拟"升级后：DOM 重建了，但上一次注入的旧 <style> 还留在页面里"
  style.textContent = 'OLD-CSS'
  const second = await mountClient('css2')
  second.find((item) => item.name === 'settings.section').value.factory()
  await flush()
  assert.notEqual(style.textContent, 'OLD-CSS', 'ensureCss 应当把旧样式内容替换掉，而不是看到已存在就返回')
  assert.match(style.textContent, /\.divider/, '替换后应当是新样式')
})

/** 取面板里消息区的文字（用于断言提示语）。 */
function msgBoxText(panel) {
  const found = []
  const walk = (node) => {
    if (node.className?.includes('msg')) found.push(node.textContent)
    for (const child of node.children ?? []) walk(child)
  }
  walk(panel)
  return found.join(' | ')
}

console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`)
globalThis.setInterval = realSetInterval
globalThis.setTimeout = realSetTimeout
process.exit(failures === 0 ? 0 : 1)
