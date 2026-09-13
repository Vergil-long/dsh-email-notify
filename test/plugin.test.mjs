/**
 * 插件宿主端自检：用假的 cordis ctx + 假会话事件 + 假 SMTP 服务器，
 * 验证「看界面就不发邮件、离开就发邮件」这套判定的实际行为。
 *
 *   node test/plugin.test.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseMessage, startMockSmtp } from './mock-smtp.mjs'

// config.js 通过 DSH_HOME 找配置文件，测试期间指向临时目录。
const home = mkdtempSync(join(tmpdir(), 'dsh-email-notify-test-'))
process.env.DSH_HOME = home
mkdirSync(join(home, 'dsh-email-notify'), { recursive: true })

const smtp = await startMockSmtp({ user: 'me@qq.com', pass: 'authcode' })
const configPath = join(home, 'dsh-email-notify', 'config.json')

function writeConfig(patch = {}) {
  const base = {
    enabled: true,
    smtp: {
      host: '127.0.0.1',
      port: smtp.port,
      secure: false,
      allowInsecure: true,
      user: 'me@qq.com',
      pass: 'authcode',
      from: 'me@qq.com',
      fromName: 'DeepSeek Harness',
    },
    to: ['me@qq.com'],
    minIntervalSeconds: 0,
    maxPerMinute: 0,
  }
  const merged = { ...base, ...patch }
  writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf8')
}
writeConfig()

const { apply } = await import('../lib/index.js')

/* ── 假的 cordis 上下文 ───────────────────────────────────────── */

const handlers = new Map()
const routes = new Map()
const disposers = []
const logs = []

const ctx = {
  logger: {
    info: (message) => logs.push(`info ${message}`),
    warn: (message) => logs.push(`warn ${message}`),
  },
  on: (type, handler) => {
    if (!handlers.has(type)) handlers.set(type, [])
    handlers.get(type).push(handler)
  },
  inject: (deps, callback) => {
    callback({
      effect: (fn) => {
        const dispose = fn()
        disposers.push(dispose)
        return dispose
      },
      webServer: {
        register: (route) => {
          if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    })
  },
}

apply(ctx)

const emit = (type, ...args) => {
  for (const handler of handlers.get(type) ?? []) handler(...args)
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 80))

function fakeRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(status) { this.statusCode = status },
    end(body) { this.body = body ?? '' },
  }
}

async function callRoute(path, { method = 'GET', body = null, url = null } = {}) {
  const route = routes.get(path)
  assert.ok(route, `路由 ${path} 未注册`)
  const request = new EventEmitter()
  request.method = method
  request.url = url ?? path
  request.destroy = () => {}
  const response = fakeRes()
  const done = route.handler(request, response)
  if (body !== null) {
    setImmediate(() => {
      request.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
      request.emit('end')
    })
  } else if (method === 'POST') {
    setImmediate(() => request.emit('end'))
  }
  await done
  return { status: response.statusCode, json: response.body ? JSON.parse(response.body) : null }
}

function makeSession({ id = 'session-1', cwd = 'F:\\Space For AI work\\harness', depth = 0, parentSession = undefined } = {}) {
  const session = {
    id,
    header: { id, cwd, delegationDepth: depth, ...(parentSession ? { parentSession } : {}) },
    events: [],
  }
  return session
}

/** 走一遍完整的回合：turn/start → 标题 → 提问/回复 → turn/end。 */
function runTurn(session, { turn = 1, reason = { kind: 'completed' }, prompt = '把通知改成邮件', reply = '已改好，测试通过。', emitTitle = true, title = '给 harness 加邮件通知' } = {}) {
  session.events.push({ type: 'turn/start', seq: 1, time: Date.now() - 4000, data: { turn } })
  emit('session/event', session, { type: 'turn/start', seq: 1, time: Date.now() - 4000, data: { turn } })
  if (emitTitle) {
    session.events.push({ type: 'session/title', seq: 2, time: Date.now() - 3900, data: { title } })
    emit('session/event', session, { type: 'session/title', seq: 2, time: Date.now() - 3900, data: { title } })
  }
  session.events.push({ type: 'user/message', seq: 3, time: Date.now() - 3800, data: { role: 'user', content: [{ type: 'text', text: prompt }] } })
  session.events.push({ type: 'assistant/message', seq: 4, time: Date.now() - 100, data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: reply }] } } })
  const endEvent = { type: 'turn/end', seq: 5, time: Date.now(), data: { turn, reason } }
  session.events.push(endEvent)
  emit('session/event', session, endEvent)
}

/** 调一次 tools/pre-execute 的 waterfall，返回门禁结果并记录是否委托过。 */
function runGate(exec) {
  const handler = (handlers.get('tools/pre-execute') ?? [])[0]
  assert.ok(handler, '应当注册了 tools/pre-execute 监听器')
  let delegated = false
  const result = handler(exec, () => {
    delegated = true
    return { kind: 'allow' }
  })
  return { result, delegated }
}

/** 造一个 ask_user_question 的工具执行输入。 */
function questionExec(session, questions, callId = 'call_q1') {
  return { name: 'ask_user_question', callId, agent: { session }, arguments: { questions } }
}

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

const baseline = () => smtp.messages.length

/* ── 用例 ─────────────────────────────────────────────────────── */

await test('路由已注册（presence / inbox / status / config / test）', async () => {
  assert.deepEqual([...routes.keys()].sort(), [
    '/dsh-email-notify/config',
    '/dsh-email-notify/inbox',
    '/dsh-email-notify/presence',
    '/dsh-email-notify/status',
    '/dsh-email-notify/test',
  ])
  assert.equal(typeof disposers[0], 'function', '应返回释放函数')
})

await test('没人在看界面时：回合结束 → 发一封中文邮件，含标题/工作区/提问/回复', async () => {
  const before = baseline()
  const session = makeSession({ id: 'session-away-1' })
  runTurn(session, { prompt: '把通知改成邮件', reply: '已完成改动并通过自检。' })
  await settle()
  assert.equal(smtp.messages.length, before + 1, '应当发出一封')
  const { headers, body } = parseMessage(smtp.messages.at(-1))
  const { decodeHeader } = await import('./mock-smtp.mjs')
  const subject = decodeHeader(headers.get('subject'))
  assert.match(subject, /✅ 任务已完成/)
  assert.match(subject, /给 harness 加邮件通知/)
  assert.match(body, /工作区：F:\\Space For AI work\\harness/)
  assert.match(body, /结果：已完成/)
  assert.match(body, /你的提问 ──\n把通知改成邮件/)
  assert.match(body, /最后回复 ──\n已完成改动并通过自检。/)
  assert.match(body, /第 1 轮 · 用时 \d+ 秒/)
  assert.match(body, /http:\/\/127\.0\.0\.1:3080/)
})

await test('正在看界面时：回合结束 → 不发邮件（默认也不弹提示，外壳会弹）', async () => {
  const first = await callRoute('/dsh-email-notify/presence', { method: 'POST', body: { clientId: 'c1', focused: true, visible: true } })
  assert.equal(first.json.watching, true, '宿主端应认为我在看界面')

  const started = await callRoute('/dsh-email-notify/inbox')
  const cursor = started.json.next

  const before = baseline()
  const session = makeSession({ id: 'session-watching-1' })
  runTurn(session)
  await settle()

  assert.equal(smtp.messages.length, before, '看界面时不应该发邮件')
  const inbox = await callRoute('/dsh-email-notify/inbox', { url: `/dsh-email-notify/inbox?since=${cursor}` })
  assert.equal(inbox.json.items.length, 0, '默认 notifyWhenFocused=false：外壳自己会弹，插件不再重复')
})

await test('打开 notifyWhenFocused 后：看界面时改为由插件弹提示', async () => {
  const before = baseline()
  const session = makeSession({ id: 'session-watching-2' })
  // 先关掉外壳那条之外的重复来源：这里直接把开关打开
  const read = await callRoute('/dsh-email-notify/config')
  const draft = JSON.parse(JSON.stringify(read.json.config))
  draft.notifyWhenFocused = true
  assert.equal((await callRoute('/dsh-email-notify/config', { method: 'POST', body: { config: draft } })).json.ok, true)
  await settle()
  const cursor = (await callRoute('/dsh-email-notify/inbox')).json.next
  runTurn(session)
  await settle()
  assert.equal(smtp.messages.length, before, '仍然不发邮件')
  const inbox = await callRoute('/dsh-email-notify/inbox', { url: `/dsh-email-notify/inbox?since=${cursor}` })
  assert.equal(inbox.json.items.length, 1, '应当排了一条界面提示')
  assert.equal(inbox.json.items[0].kind, 'turn-end')
  assert.equal(inbox.json.items[0].sessionId, 'session-watching-2')
  assert.match(inbox.json.items[0].notifyTitle, /任务已完成/)
  // 复位，后面的用例继续按默认配置跑
  draft.notifyWhenFocused = false
  await callRoute('/dsh-email-notify/config', { method: 'POST', body: { config: draft } })
  await settle()
})

await test('窗口失去焦点后：又恢复发邮件', async () => {
  await callRoute('/dsh-email-notify/presence', { method: 'POST', body: { clientId: 'c1', focused: false, visible: true } })
  const before = baseline()
  runTurn(makeSession({ id: 'session-away-2' }))
  await settle()
  assert.equal(smtp.messages.length, before + 1)
})

await test('离开界面时收到授权请求 → 发邮件（含工具名与原因）', async () => {
  const before = baseline()
  const session = makeSession({ id: 'session-approval-1' })
  emit('session/event', session, { type: 'session/title', seq: 1, time: Date.now(), data: { title: '改 app.asar' } })
  emit('session/event', session, {
    type: 'approval/asked',
    seq: 2,
    time: Date.now(),
    data: { id: 'req-1', toolName: 'pwsh', callId: 'call_1', reason: 'escalate sandbox to danger-full-access: 需要写入会话工作区之外的文件' },
  })
  await settle()
  assert.equal(smtp.messages.length, before + 1)
  const { decodeHeader } = await import('./mock-smtp.mjs')
  const { headers, body } = parseMessage(smtp.messages.at(-1))
  assert.match(decodeHeader(headers.get('subject')), /🔐 需要你授权 · pwsh/)
  assert.match(body, /工具：pwsh/)
  assert.match(body, /danger-full-access/)
  assert.match(body, /等你决定/)
})

await test('看着界面时的授权请求按默认不打扰（既不发邮件也不弹提示）', async () => {
  await callRoute('/dsh-email-notify/presence', { method: 'POST', body: { clientId: 'c1', focused: true, visible: true } })
  const cursor = (await callRoute('/dsh-email-notify/inbox')).json.next
  const before = baseline()
  const session = makeSession({ id: 'session-approval-2' })
  emit('session/event', session, { type: 'approval/asked', seq: 1, time: Date.now(), data: { id: 'req-2', toolName: 'bash', reason: '越界写入' } })
  await settle()
  assert.equal(smtp.messages.length, before, '看界面时不发邮件')
  const inbox = await callRoute('/dsh-email-notify/inbox', { url: `/dsh-email-notify/inbox?since=${cursor}` })
  assert.equal(inbox.json.items.length, 0, '授权框就在眼前，不额外弹提示')
  await callRoute('/dsh-email-notify/presence', { method: 'POST', body: { clientId: 'c1', focused: false, visible: true } })
})

await test('同一个回合重复的 turn/end 只发一封（去重）', async () => {
  const before = baseline()
  const session = makeSession({ id: 'session-dedup-1' })
  runTurn(session, { turn: 7 })
  const duplicate = { type: 'turn/end', seq: 6, time: Date.now(), data: { turn: 7, reason: { kind: 'completed' } } }
  emit('session/event', session, duplicate)
  await settle()
  assert.equal(smtp.messages.length, before + 1)
})

await test('子会话（subagent）默认不发通知', async () => {
  const before = baseline()
  runTurn(makeSession({ id: 'session-child-1', depth: 1, parentSession: 'session-parent' }))
  await settle()
  assert.equal(smtp.messages.length, before, '子会话默认跳过')

  writeConfig({ includeSubagents: true })
  await settle()
  runTurn(makeSession({ id: 'session-child-2', depth: 1, parentSession: 'session-parent' }))
  await settle()
  assert.equal(smtp.messages.length, before + 1, '打开 includeSubagents 后应发出')
  writeConfig()
  await settle()
})

await test('出错/中止的回合也会报，但主题标记不同', async () => {
  const before = baseline()
  runTurn(makeSession({ id: 'session-error-1' }), { reason: { kind: 'error', error: { message: 'LLM 请求失败：502', code: 'HTTP' } } })
  await settle()
  const { decodeHeader } = await import('./mock-smtp.mjs')
  const { headers, body } = parseMessage(smtp.messages.at(-1))
  assert.equal(smtp.messages.length, before + 1)
  assert.match(decodeHeader(headers.get('subject')), /⚠️ 任务出错/)
  assert.match(body, /结果：出错/)
  assert.match(body, /502/)
})

await test('间隔节流生效：同类通知太密会被跳过', async () => {
  writeConfig({ minIntervalSeconds: 600 })
  await settle()
  const before = baseline()
  const session = makeSession({ id: 'session-throttle-1' })
  runTurn(session, { turn: 1 })
  await settle()
  assert.equal(smtp.messages.length, before + 1, '第一封应当发出')
  runTurn(session, { turn: 2 })
  await settle()
  assert.equal(smtp.messages.length, before + 1, '600 秒内同一会话的第二封应被压掉')
  writeConfig()
  await settle()
})

await test('配置没填好时不发信、也不抛错，并给出可读日志', async () => {
  writeConfig({ smtp: { host: '127.0.0.1', port: smtp.port, secure: false, allowInsecure: true, user: '', pass: '', from: '', fromName: 'x' }, to: [] })
  await settle()
  const before = baseline()
  runTurn(makeSession({ id: 'session-unconfigured-1' }))
  await settle()
  assert.equal(smtp.messages.length, before)
  assert.equal(logs.some((line) => line.includes('配置未完成')), true)
  writeConfig()
  await settle()
})

await test('status 接口给出可诊断信息（口令只报是否已填）', async () => {
  const result = await callRoute('/dsh-email-notify/status')
  assert.equal(result.status, 200)
  assert.equal(result.json.ready, true)
  assert.equal(result.json.smtp.pass, '已填')
  assert.equal(result.json.smtp.user, '已填')
  assert.deepEqual(result.json.to, ['me@qq.com'])
  assert.equal(typeof result.json.configPath, 'string')
  assert.equal(JSON.stringify(result.json).includes('authcode'), false, '接口不能回显授权码')
})

await test('test 接口能真的发出一封测试邮件', async () => {
  const before = baseline()
  const result = await callRoute('/dsh-email-notify/test', { method: 'POST', body: {} })
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.equal(smtp.messages.length, before + 1)
  // 发过之后 status 要能看到结果，不能还显示 null
  const status = await callRoute('/dsh-email-notify/status')
  assert.equal(status.json.lastSend?.ok, true)
  assert.equal(status.json.lastSend?.test, true)
  assert.match(status.json.lastSend?.messageId ?? '', /@/)
})

await test('客户端队列游标：首次访问不补发历史提示', async () => {
  const fresh = await callRoute('/dsh-email-notify/inbox')
  assert.deepEqual(fresh.json.items, [])
  assert.equal(typeof fresh.json.next, 'number')
})

await test('离开界面时助手向你提问 → 发邮件（含问题与选项），并且原样委托门禁', async () => {
  const before = baseline()
  const session = makeSession({ id: 'session-question-away' })
  emit('session/event', session, { type: 'session/title', seq: 0, time: Date.now(), data: { title: '加邮件通知' } })
  const { result, delegated } = runGate(questionExec(session, [
    {
      id: 'smtp',
      header: '邮件通道',
      question: '用哪个邮箱发出？',
      options: [{ label: 'QQ 邮箱' }, { label: '163 邮箱' }],
    },
  ], 'call_q_away'))
  assert.equal(delegated, true, '必须把门禁委托给下一环，绝不能截胡')
  assert.deepEqual(result, { kind: 'allow' }, '返回值必须是 next() 的结果')

  await settle()
  assert.equal(smtp.messages.length, before + 1, '应当发出一封提问通知')
  const { decodeHeader } = await import('./mock-smtp.mjs')
  const { headers, body } = parseMessage(smtp.messages.at(-1))
  const subject = decodeHeader(headers.get('subject'))
  assert.match(subject, /❓ 需要你回答/)
  assert.match(subject, /邮件通道/)
  assert.match(subject, /加邮件通知/)
  assert.match(body, /邮件通道：用哪个邮箱发出？/)
  assert.match(body, /· QQ 邮箱/)
  assert.match(body, /· 163 邮箱/)
  assert.match(body, /问题数：1/)
  assert.match(body, /等你回答/)
})

await test('看着界面时的提问按默认不打扰', async () => {
  await callRoute('/dsh-email-notify/presence', { method: 'POST', body: { clientId: 'c1', focused: true, visible: true } })
  const cursor = (await callRoute('/dsh-email-notify/inbox')).json.next
  const before = baseline()
  const session = makeSession({ id: 'session-question-watching' })
  const { delegated } = runGate(questionExec(session, [{ id: 'a', question: '要继续吗？' }], 'call_q_watching'))
  assert.equal(delegated, true)
  await settle()
  assert.equal(smtp.messages.length, before, '看界面时不发邮件')
  const inbox = await callRoute('/dsh-email-notify/inbox', { url: `/dsh-email-notify/inbox?since=${cursor}` })
  assert.equal(inbox.json.items.length, 0, '问题就在眼前，不额外弹提示')
  await callRoute('/dsh-email-notify/presence', { method: 'POST', body: { clientId: 'c1', focused: false, visible: true } })
})

await test('同一次提问（同 callId）只通知一次', async () => {
  const before = baseline()
  const session = makeSession({ id: 'session-question-dedup' })
  runGate(questionExec(session, [{ id: 'a', question: '选哪个？' }], 'call_q_dup'))
  runGate(questionExec(session, [{ id: 'a', question: '选哪个？' }], 'call_q_dup'))
  await settle()
  assert.equal(smtp.messages.length, before + 1)
})

await test('其它工具不会触发提问通知', async () => {
  const before = baseline()
  const session = makeSession({ id: 'session-question-other' })
  const { delegated } = runGate({ name: 'pwsh', callId: 'call_x', agent: { session }, arguments: { command: 'echo hi' } })
  assert.equal(delegated, true)
  await settle()
  assert.equal(smtp.messages.length, before)
})

await test('插件在会话开始之后才挂载：标题从会话日志回读，主题里不缺标题', async () => {
  const before = baseline()
  const session = makeSession({ id: 'session-title-fallback' })
  // 模拟"插件挂载前"就写进日志、但没经过本插件监听的标题事件
  session.events.push({ type: 'session/title', seq: 0, time: Date.now() - 9000, data: { title: '日志里已有的标题' } })
  runTurn(session, { turn: 3, emitTitle: false })
  await settle()
  assert.equal(smtp.messages.length, before + 1)
  const { decodeHeader } = await import('./mock-smtp.mjs')
  const { headers, body } = parseMessage(smtp.messages.at(-1))
  assert.match(decodeHeader(headers.get('subject')), /日志里已有的标题/)
  assert.match(body, /任务：日志里已有的标题/)
})

await test('设置接口：读配置不回显授权码，写配置留空口令不会把授权码抹掉', async () => {
  const read = await callRoute('/dsh-email-notify/config')
  assert.equal(read.status, 200)
  assert.equal(read.json.config.smtp.pass, '', '口令字段必须为空')
  assert.equal(read.json.config.smtp.passSet, true, '只告诉界面"已设置"')
  assert.equal(JSON.stringify(read.json).includes('authcode'), false, '任何响应都不能带授权码')

  const draft = JSON.parse(JSON.stringify(read.json.config))
  draft.smtp.port = 2587
  draft.events.question = false
  draft.subjectPrefix = '[TEST]'
  draft.to = ['a@qq.com', 'b@qq.com']
  draft.smtp.pass = '' // 留空 = 不修改
  const saved = await callRoute('/dsh-email-notify/config', { method: 'POST', body: { config: draft } })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.ok, true)
  assert.equal(saved.json.config.smtp.port, 2587)
  assert.equal(saved.json.config.events.question, false)
  assert.equal(saved.json.config.subjectPrefix, '[TEST]')
  assert.deepEqual(saved.json.config.to, ['a@qq.com', 'b@qq.com'])
  assert.equal(saved.json.config.smtp.passSet, true, '授权码应当还在')

  const raw = readFileSync(configPath, 'utf8')
  assert.match(raw, /"authcode"/, '文件里确实还留着授权码')
  assert.match(raw, /2587/, '改动确实落盘了')
  assert.equal(JSON.stringify(saved.json).includes('authcode'), false)

  // 新回调的配置要立刻生效：端口变了，假服务器上的那台就不该再收到邮件
  writeConfig()
  await settle()
})

await test('设置接口会过滤掉非法值，不会把配置写坏', async () => {
  const before = readFileSync(configPath, 'utf8')
  const result = await callRoute('/dsh-email-notify/config', {
    method: 'POST',
    body: {
      config: {
        enabled: 'true',
        minIntervalSeconds: -5,
        subjectPrefix: 12345,
        to: 'x@qq.com, y@qq.com',
        smtp: { host: 'smtp.example.com', pass: '' },
        未来才有的字段: '应当被忽略',
      },
    },
  })
  assert.equal(result.json.ok, true)
  assert.equal(result.json.config.enabled, true, '字符串 true 应当被收窄成布尔')
  assert.deepEqual(result.json.config.to, ['x@qq.com', 'y@qq.com'], '逗号分隔的收件人应当被拆开')
  assert.equal(result.json.config.smtp.host, 'smtp.example.com')
  assert.equal('未来才有的字段' in result.json.config, false, '未知字段必须被丢弃')
  assert.notEqual(readFileSync(configPath, 'utf8'), before)
  writeConfig()
  await settle()
})

await test('测试邮件接口用的是界面上的草稿：端口写错会失败且不投递', async () => {
  const before = baseline()
  const result = await callRoute('/dsh-email-notify/test', {
    method: 'POST',
    body: {
      config: {
        smtp: {
          host: '127.0.0.1',
          port: 1,
          secure: false,
          allowInsecure: true,
          user: 'me@qq.com',
          pass: 'DRAFT-SECRET',
          from: 'me@qq.com',
        },
        to: ['me@qq.com'],
      },
    },
  })
  assert.equal(result.status, 500, '连不上就该报错')
  assert.equal(result.json.ok, false)
  assert.equal(smtp.messages.length, before, '不能投递')
  assert.match(result.json.error, /127\.0\.0\.1:1/, '错误信息要能定位到主机:端口')
  assert.equal(JSON.stringify(result.json).includes('DRAFT-SECRET'), false, '响应里绝不能出现授权码')
})

await test('草稿不完整时给出"缺什么"的提示，而不是抛异常', async () => {
  const result = await callRoute('/dsh-email-notify/test', {
    method: 'POST',
    body: { config: { smtp: { host: '', user: '', pass: '', from: '' }, to: [] } },
  })
  assert.equal(result.status, 400)
  assert.equal(result.json.ok, false)
  assert.match(result.json.error, /配置不完整/)
})

await test('老配置（v0.1 时代手写的那份）能平滑升级：默认值补齐、口令与手写说明键都保住', async () => {
  /*
   * 这份 fixture 刻意照用户真实 config.json 的样子写：
   * 有手写的 _说明 键、没有 events、没有 notifyWhenFocused，口令是明文躺在文件里的。
   * 要验证的是：新版读它时补默认值、面板保存时既不抹掉口令、也不把默认值固化进文件。
   */
  const legacy = {
    _说明: '用户手写的说明，不能被覆盖',
    enabled: true,
    smtp: {
      host: '127.0.0.1',
      port: smtp.port,
      secure: false,
      rejectUnauthorized: true,
      user: 'me@qq.com',
      pass: 'authcode',
      from: 'me@qq.com',
      fromName: 'DeepSeek Harness',
    },
    to: ['me@qq.com'],
  }
  writeFileSync(configPath, JSON.stringify(legacy, null, 2), 'utf8')
  await settle()

  const read = await callRoute('/dsh-email-notify/config')
  assert.equal(read.json.config.events.question, true, '缺失的 events.question 应补上默认值 true')
  assert.equal(read.json.config.notifyWhenFocused, false, 'notifyWhenFocused 默认应为 false（避免与外壳重复）')
  assert.equal(read.json.config.smtp.passSet, true)
  assert.equal(read.json.config.smtp.pass, '', '口令不回显')

  // 面板保存：只回传改动的字段（口令字段留空 = 不修改）
  const saved = await callRoute('/dsh-email-notify/config', {
    method: 'POST',
    body: { config: { events: { question: false } } },
  })
  assert.equal(saved.json.ok, true)

  const raw = JSON.parse(readFileSync(configPath, 'utf8'))
  assert.equal(raw._说明, '用户手写的说明，不能被覆盖', '手写的说明键必须原样保留')
  assert.equal(raw.smtp.pass, 'authcode', '口令留空 = 不修改，不能被抹掉')
  assert.equal(raw.events.question, false, '改动要落盘')
  assert.equal(raw.events.turnEnd, undefined, '没碰过的默认值不该被固化进用户文件')
  assert.equal(raw.notifyWhenFocused, undefined, '同理，默认值不落盘')
  assert.equal(raw.to.length, 1)

  writeConfig()
  await settle()
})

await test('释放函数会摘掉全部路由', async () => {
  for (const dispose of disposers) if (typeof dispose === 'function') dispose()
  assert.equal(routes.size, 0)
})

await smtp.close()
console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
