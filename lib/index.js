/**
 * dsh-email-notify — 宿主端。
 *
 * 目标：当我不在 harness 窗口前时，用邮件告诉我
 *   1) 某轮对话结束了（任务完成 / 出错 / 被中止）
 *   2) 某个工具请求授权，任务卡住等我在界面上点同意
 * 而我正在看着界面时就不发邮件（界面上本来就有提示）。
 *
 * 触发源全部取自**权威事实**，不猜 DOM：
 *   - `session/event` 里的 `turn/end` / `turn/start` / `session/title`
 *   - `session/event` 里的 `approval/asked`（ApprovalService 在等决策前写入的审计事件）
 * 顺带一提：桌面外壳原来那套「扫描左侧列表文本猜完成」的通知在真实日志里
 * 161/190 次是在回合还在跑的时候弹的，所以这里另起一套准确的判定。
 *
 * 「是否在看界面」由客户端半侧（client/client.js）上报：窗口有焦点且可见即视为在看。
 * 没有任何客户端上报（比如关掉了界面、只看后台）时按「不在看」处理 → 发邮件。
 */
import { collectRecipients, configPath, describeReadiness, loadConfig, publicConfig, saveConfig } from './config.js'
import { sendMail } from './smtp.js'

/** 客户端心跳过期时间：超过这个时间没上报就认为它不再「在看界面」。 */
const DEFAULT_STALE_MS = 90_000
const INBOX_LIMIT = 40
const BODY_LIMIT = 32 * 1024

export const name = 'dsh-email-notify'

/** 可读的时间：本机时区，秒级。 */
function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 工作区显示名：取路径最后一段，界面提示里比整条路径好读。 */
function workspaceName(cwd) {
  const text = String(cwd ?? '').replace(/[\\/]+$/, '')
  if (!text) return '未知工作区'
  const parts = text.split(/[\\/]/)
  return parts[parts.length - 1] || text
}

/** 秒数 → 人话。 */
function humanDuration(ms) {  if (!Number.isFinite(ms) || ms < 0) return '未知'
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

/** 把长文本压成一行摘要。 */
function excerpt(text, limit) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (clean.length <= limit) return clean
  return `${clean.slice(0, limit)}…（已截断）`
}

/** 从消息内容块里取纯文本。 */
function blocksToText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** 读请求体（带上限，坏 JSON 不抛给框架）。 */
function readJsonBody(request) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        request.destroy()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(null)
      }
    })
    request.on('error', () => resolve(null))
  })
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 */
export function apply(ctx) {
  const log = (level, message) => {
    try {
      const logger = ctx.logger
      if (logger && typeof logger[level] === 'function') logger[level](`[dsh-email-notify] ${message}`)
    } catch { /* 日志失败不影响功能 */ }
  }

  /** 会话 id → 标题（标题由 session/title 事件给出）。 */
  const titles = new Map()
  /** 会话 id → 最近一次 turn/start 的 {turn, at}。 */
  const openTurns = new Map()
  /** 客户端 id → 最近一次上报的在场状态。 */
  const clients = new Map()
  /** 已处理过的触发键，避免重复发信。 */
  const handled = new Map()
  /** 每类触发的节流时间戳。 */
  const lastSentAt = new Map()
  /** 发给「正在看界面」的客户端的提示队列。 */
  const inbox = []
  let inboxSeq = 0
  let lastResult = null

  function getConfig() {
    const loaded = loadConfig()
    if (loaded.error) log('warn', loaded.error)
    return loaded.value
  }

  function staleMs() {
    const seconds = Number(getConfig().watchingStaleSeconds)
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_STALE_MS
  }

  /** 现在是否有人正盯着 harness 界面看。 */
  function isWatching() {
    const now = Date.now()
    const limit = staleMs()
    for (const client of clients.values()) {
      if (client.focused && client.visible && now - client.at < limit) return true
    }
    return false
  }

  /** 给在场的客户端排一条提示（客户端会轮询取走）。 */
  function pushInbox(item) {
    inboxSeq += 1
    inbox.push({ id: inboxSeq, at: Date.now(), ...item })
    if (inbox.length > INBOX_LIMIT) inbox.splice(0, inbox.length - INBOX_LIMIT)
  }

  /** 触发去重：同一个回合 / 同一次授权请求只处理一次。 */
  function claim(key) {
    const now = Date.now()
    for (const [oldKey, at] of handled) if (now - at > 30 * 60_000) handled.delete(oldKey)
    if (handled.has(key)) return false
    handled.set(key, now)
    return true
  }

  /**
   * 节流判定。刻意按「触发类型 + 会话」计时：
   * 刚发过授权邮件的会话，紧接着的完成邮件不该被压掉。
   */
  function throttled(cfg, bucket) {
    const minGap = Number(cfg.minIntervalSeconds) * 1000
    const now = Date.now()
    const recent = [...lastSentAt.values()].filter((at) => now - at < 60_000)
    const maxPerMinute = Number(cfg.maxPerMinute)
    if (Number.isFinite(maxPerMinute) && maxPerMinute > 0 && recent.length >= maxPerMinute) {
      return '一分钟内发信已达上限'
    }
    if (Number.isFinite(minGap) && minGap > 0) {
      const previous = lastSentAt.get(bucket)
      if (previous !== undefined && now - previous < minGap) return '同类通知间隔过短'
    }
    return null
  }

  function markSent(bucket) {
    lastSentAt.set(bucket, Date.now())
  }

  /** 组装并发出一封邮件。 */
  async function deliver(cfg, { subject, body, bucket, meta }) {
    const readiness = describeReadiness(cfg)
    if (!readiness.ready) {
      log('warn', `配置未完成，跳过发信（缺 ${readiness.missing.join(', ')}），配置文件：${configPath()}`)
      lastResult = { at: Date.now(), ok: false, error: `配置未完成：缺 ${readiness.missing.join(', ')}` }
      return false
    }
    const skip = throttled(cfg, bucket)
    if (skip) {
      log('info', `跳过发信（${skip}）：${subject}`)
      return false
    }
    markSent(bucket)
    try {
      const result = await sendMail({
        host: cfg.smtp.host,
        port: cfg.smtp.port,
        secure: cfg.smtp.secure,
        rejectUnauthorized: cfg.smtp.rejectUnauthorized !== false,
        allowInsecure: cfg.smtp.allowInsecure === true,
        user: cfg.smtp.user,
        pass: cfg.smtp.pass,
        from: readiness.from,
        fromName: cfg.smtp.fromName,
        to: readiness.recipients,
        subject,
        text: body,
      })
      lastResult = { at: Date.now(), ok: true, subject, messageId: result.messageId, to: readiness.recipients }
      log('info', `已发送邮件「${subject}」→ ${readiness.recipients.join(', ')}`)
      return true
    } catch (error) {
      lastResult = { at: Date.now(), ok: false, subject, error: error.message }
      log('warn', `发信失败「${subject}」：${error.message}`)
      return false
    }
  }

  /**
   * 统一分发：在看界面 → 只推界面提示（按配置）；不在看界面 → 发邮件。
   *
   * 三种触发在看界面时的默认行为刻意不同：
   *  - turn-end：要不要弹由 notifyWhenFocused 决定（默认不弹，外壳自己会弹）；
   *  - approval / question：默认都不弹，因为授权框/问题就摆在眼前，弹了是打扰。
   *
   * @param {'turn-end'|'approval'|'question'} kind - 触发类型。
   * @param {object} payload - 事件摘要。
   * @param {object} mail - {subject, body} 邮件内容。
   */
  async function dispatch(kind, payload, mail) {
    const cfg = getConfig()
    if (!cfg.enabled) return
    const watching = isWatching()
    if (watching) {
      const wantToast = kind === 'turn-end' ? cfg.notifyWhenFocused
        : kind === 'question' ? cfg.questionNotifyWhenFocused
          : cfg.approvalNotifyWhenFocused
      if (wantToast) pushInbox({ kind, ...payload })
      else log('info', `你在看界面，跳过通知（${kind}）`)
      return
    }
    await deliver(cfg, { subject: mail.subject, body: mail.body, bucket: `${kind}:${payload.sessionId}` })
  }

  /**
   * 会话标题。
   *
   * 先查内存表（由 session/title 事件填充）；查不到就回读会话日志——
   * 插件通常在会话已经开始之后才挂载（或 DSH 重启过），这种情况下内存表是空的，
   * 而会话日志里那条 session/title 事件一直都在。这正是"邮件主题缺任务标题"的原因。
   */
  function titleOf(session) {
    const known = titles.get(session.id)
    if (typeof known === 'string' && known) return known
    const events = Array.isArray(session.events) ? session.events : []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'session/title') continue
      const title = event.data?.title
      if (typeof title === 'string' && title.trim()) {
        const clean = title.trim()
        titles.set(session.id, clean)
        return clean
      }
    }
    return ''
  }

  /** 收集正文里要引用的提问与最后回复。 */
  function collectExcerpts(session, turn, limit) {
    const events = Array.isArray(session.events) ? session.events : []
    let prompt = ''
    let reply = ''
    // 从尾部往前扫，最多 6000 条，够覆盖这一轮的收尾部分。
    const floor = Math.max(0, events.length - 6000)
    for (let index = events.length - 1; index >= floor; index -= 1) {
      const event = events[index]
      if (!event) continue
      if (!reply && event.type === 'assistant/message' && event.data?.turn === turn) {
        reply = blocksToText(event.data.message?.content)
      }
      if (!prompt && event.type === 'user/message') {
        prompt = blocksToText(event.data?.content)
      }
      if (reply && prompt) break
    }
    return { prompt: excerpt(prompt, limit), reply: excerpt(reply, limit) }
  }

  /** 正文公共部分。 */
  function contextLines(cfg, session, title) {
    const header = session.header ?? {}
    const base = String(cfg.linkBase || '').trim() || 'http://127.0.0.1:3080'
    return [
      `任务：${title || '（无标题）'}`,
      `工作区：${header.cwd || '未知'}`,
      `会话：${session.id}`,
      `时间：${stamp()}`,
      `地址：${base}`,
    ]
  }

  /** 回合结束。 */
  function onTurnEnd(session, event) {
    const cfg = getConfig()
    if (!cfg.events.turnEnd) return
    const header = session.header ?? {}
    const isSubagent = Boolean(header.parentSession) || Number(header.delegationDepth ?? 0) > 0
    if (isSubagent && !cfg.includeSubagents) return

    const turn = event.data?.turn
    const reason = event.data?.reason ?? { kind: 'completed' }
    const kind = String(reason.kind ?? 'completed')
    if (!claim(`turn:${session.id}:${turn}`)) return

    const opened = openTurns.get(session.id)
    openTurns.delete(session.id)
    const durationMs = opened && opened.turn === turn ? event.time - opened.at : Number.NaN

    const outcome = kind === 'completed' ? '已完成'
      : kind === 'error' ? '出错'
        : kind === 'stopped' || kind === 'aborted' ? '已中止'
          : kind === 'blocked' ? '被拒绝' : kind
    const title = titleOf(session)
    const prefix = cfg.subjectPrefix ? `${cfg.subjectPrefix} ` : ''
    const mark = kind === 'completed' ? '✅' : kind === 'error' ? '⚠️' : '⏹️'
    const subject = `${prefix}${mark} 任务${outcome}${title ? ` · ${excerpt(title, 40)}` : ''}`

    const lines = [
      ...contextLines(cfg, session, title),
      `回合：第 ${turn} 轮 · 用时 ${humanDuration(durationMs)}`,
      `结果：${outcome}${reason.error?.message ? `（${excerpt(reason.error.message, 200)}）` : ''}`,
    ]
    if (cfg.includeExcerpts) {
      const { prompt, reply } = collectExcerpts(session, turn, Number(cfg.excerptChars) || 700)
      if (prompt) lines.push('', '── 你的提问 ──', prompt)
      if (reply) lines.push('', '── 最后回复 ──', reply)
    }
    lines.push('', '（这封邮件由 dsh-email-notify 发送：通知时 harness 窗口不在前台，所以走了邮件。）')

    void dispatch(
      'turn-end',
      {
        sessionId: session.id,
        title,
        outcome: kind,
        turn,
        durationMs,
        // 界面提示要用的文案（客户端只认这两个字段）
        notifyTitle: `${mark} 任务${outcome}${title ? ` · ${excerpt(title, 30)}` : ''}`,
        notifyBody: `${workspaceName(header.cwd)} · 用时 ${humanDuration(durationMs)}`,
      },
      { subject, body: lines.join('\n') },
    )
  }

  /** 工具请求授权。 */
  function onApprovalAsked(session, event) {
    const cfg = getConfig()
    if (!cfg.events.approval) return
    const header = session.header ?? {}
    const isSubagent = Boolean(header.parentSession) || Number(header.delegationDepth ?? 0) > 0
    if (isSubagent && !cfg.includeSubagents) return

    const requestId = event.data?.id
    if (requestId && !claim(`approval:${session.id}:${requestId}`)) return

    const toolName = String(event.data?.toolName ?? '未知工具')
    const reason = String(event.data?.reason ?? '').trim()
    const title = titleOf(session)
    const prefix = cfg.subjectPrefix ? `${cfg.subjectPrefix} ` : ''
    const subject = `${prefix}🔐 需要你授权 · ${toolName}${title ? ` · ${excerpt(title, 30)}` : ''}`

    const lines = [
      ...contextLines(cfg, session, title),
      `工具：${toolName}`,
      reason ? `原因：${reason}` : '',
      '',
      '任务现在停在授权这一步等你决定，回到 harness 窗口点「允许」或「拒绝」才会继续。',
      '（这封邮件由 dsh-email-notify 发送：通知时 harness 窗口不在前台。）',
    ].filter((line) => line !== '')

    void dispatch(
      'approval',
      {
        sessionId: session.id,
        title,
        tool: toolName,
        reason: excerpt(reason, 200),
        notifyTitle: `🔐 需要授权 · ${toolName}`,
        notifyBody: [title ? `任务：${excerpt(title, 30)}` : '', excerpt(reason, 120)].filter(Boolean).join('\n'),
      },
      { subject, body: lines.join('\n') },
    )
  }

  /**
   * 助手向你提问（等你选/等你确认）。
   *
   * 挂的是 `tools/pre-execute` 这条 waterfall：`ask_user_question` 工具在真正
   * 把问题递给界面之前会经过它（dsh-hooks-*、dsh-tool-jobs 都用同一处）。
   * 必须原样 `next()` 委托，绝不能截胡——否则会抢掉别人的门禁决策。
   *
   * @param {object} exec - 工具执行输入（含 name / arguments / agent / callId）。
   */
  function onQuestionAsked(exec) {
    const cfg = getConfig()
    if (!cfg.events.question) return
    const session = exec.agent?.session
    if (!session) return
    const header = session.header ?? {}
    const isSubagent = Boolean(header.parentSession) || Number(header.delegationDepth ?? 0) > 0
    if (isSubagent && !cfg.includeSubagents) return
    if (!claim(`question:${session.id}:${exec.callId ?? 'unknown'}`)) return

    const raw = Array.isArray(exec.arguments?.questions) ? exec.arguments.questions : []
    const questions = raw.map((question) => ({
      header: typeof question?.header === 'string' ? question.header.trim() : '',
      text: typeof question?.question === 'string' ? question.question.trim() : '',
      options: Array.isArray(question?.options)
        ? question.options.map((option) => (typeof option === 'string' ? option : String(option?.label ?? ''))).filter(Boolean)
        : [],
    })).filter((question) => question.text)

    const title = titleOf(session)
    const prefix = cfg.subjectPrefix ? `${cfg.subjectPrefix} ` : ''
    const first = questions[0]
    const headline = first ? excerpt(first.header || first.text, 30) : '需要你回答'
    const subject = `${prefix}❓ 需要你回答 · ${headline}${title ? ` · ${excerpt(title, 30)}` : ''}`

    const lines = [
      ...contextLines(cfg, session, title),
      `问题数：${questions.length}`,
      '',
    ]
    for (const [index, question] of questions.entries()) {
      lines.push(`${questions.length > 1 ? `【${index + 1}】` : ''}${question.header ? `${question.header}：` : ''}${question.text}`)
      for (const option of question.options) lines.push(`   · ${option}`)
      lines.push('')
    }
    lines.push('任务现在停在等你回答这一步，回到 harness 窗口作答才会继续。')
    lines.push('（这封邮件由 dsh-email-notify 发送：通知时 harness 窗口不在前台。）')

    void dispatch(
      'question',
      {
        sessionId: session.id,
        title,
        questions: questions.length,
        preview: excerpt(first?.text ?? '', 120),
        notifyTitle: `❓ 需要你回答 · ${headline}`,
        notifyBody: [title ? `任务：${excerpt(title, 30)}` : '', excerpt(first?.text ?? '', 120)].filter(Boolean).join('\n'),
      },
      { subject, body: lines.filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n') },
    )
  }

  // ── 订阅会话事实 ────────────────────────────────────────────────
  ctx.on('session/event', (session, event) => {
    try {
      if (!session || !event) return
      switch (event.type) {
        case 'session/title': {
          const title = event.data?.title
          if (typeof title === 'string' && title.trim()) titles.set(session.id, title.trim())
          break
        }
        case 'turn/start':
          openTurns.set(session.id, { turn: event.data?.turn, at: event.time })
          break
        case 'turn/end':
          onTurnEnd(session, event)
          break
        case 'approval/asked':
          onApprovalAsked(session, event)
          break
        default:
          break
      }
    } catch (error) {
      log('warn', `处理会话事件 ${event?.type} 失败：${error.message}`)
    }
  })

  // ── 订阅工具门禁（只观察"提问"，原样委托） ──────────────────────
  ctx.on('tools/pre-execute', (exec, next) => {
    try {
      if (exec?.name === 'ask_user_question') onQuestionAsked(exec)
    } catch (error) {
      log('warn', `处理提问通知失败：${error.message}`)
    }
    // 关键：无论上面做了什么都要委托给下一环，绝不改变门禁结果。
    return next()
  })

  // ── HTTP 接口（浏览器半侧用） ───────────────────────────────────
  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(() => {
      const disposePresence = hostCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-email-notify/presence',
        handler: async (request, response) => {
          if (request.method !== 'POST') return sendJson(response, 405, { error: 'use POST' })
          const body = await readJsonBody(request)
          if (!body || typeof body !== 'object') return sendJson(response, 400, { error: 'invalid json' })
          const clientId = String(body.clientId ?? '').slice(0, 80) || 'anonymous'
          clients.set(clientId, {
            focused: Boolean(body.focused),
            visible: Boolean(body.visible),
            at: Date.now(),
          })
          sendJson(response, 200, { ok: true, watching: isWatching() })
        },
      })

      const disposeInbox = hostCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-email-notify/inbox',
        handler: async (request, response) => {
          if (request.method !== 'GET') return sendJson(response, 405, { error: 'use GET' })
          let since = null
          try {
            const raw = new URL(request.url, 'http://127.0.0.1').searchParams.get('since')
            if (raw !== null) since = Number(raw)
          } catch { /* 用默认值 */ }
          // since 缺省表示客户端刚启动：只回游标，不补发历史提示。
          if (since === null || !Number.isFinite(since)) return sendJson(response, 200, { items: [], next: inboxSeq })
          const items = inbox.filter((item) => item.id > since)
          sendJson(response, 200, { items, next: inboxSeq })
        },
      })

      const disposeStatus = hostCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-email-notify/status',
        handler: async (request, response) => {
          const cfg = getConfig()
          const readiness = describeReadiness(cfg)
          sendJson(response, 200, {
            enabled: cfg.enabled,
            ready: readiness.ready,
            missing: readiness.missing,
            smtp: { host: cfg.smtp.host, port: cfg.smtp.port, secure: cfg.smtp.secure, user: cfg.smtp.user ? '已填' : '未填', pass: cfg.smtp.pass ? '已填' : '未填' },
            to: collectRecipients(cfg),
            watching: isWatching(),
            clients: [...clients.entries()].map(([id, value]) => ({ id, focused: value.focused, visible: value.visible, ageMs: Date.now() - value.at })),
            configPath: configPath(),
            lastSend: lastResult,
          })
        },
      })

      const disposeConfig = hostCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-email-notify/config',
        handler: async (request, response) => {
          if (request.method === 'GET') {
            const cfg = getConfig()
            const readiness = describeReadiness(cfg)
            return sendJson(response, 200, {
              config: publicConfig(cfg),
              ready: readiness.ready,
              missing: readiness.missing,
              configPath: configPath(),
            })
          }
          if (request.method !== 'POST' && request.method !== 'PUT') {
            response.writeHead(405, { allow: 'GET, POST, PUT', 'content-type': 'application/json; charset=utf-8' })
            return response.end(JSON.stringify({ error: 'use GET or POST' }))
          }
          const body = await readJsonBody(request)
          if (!body || typeof body !== 'object') return sendJson(response, 400, { ok: false, error: '请求体不是合法 JSON' })
          // 设置界面把整份配置发回来，这里只挑白名单字段写入；口令留空表示"不改"。
          const saved = saveConfig(body.config ?? body)
          if (!saved.ok) return sendJson(response, 500, { ok: false, error: saved.error })
          const cfg = saved.value
          const readiness = describeReadiness(cfg)
          log('info', `设置已更新（配置文件：${configPath()}）`)
          sendJson(response, 200, {
            ok: true,
            config: publicConfig(cfg),
            ready: readiness.ready,
            missing: readiness.missing,
            configPath: configPath(),
          })
        },
      })

      const disposeTest = hostCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-email-notify/test',
        handler: async (request, response) => {
          if (request.method !== 'POST') return sendJson(response, 405, { error: 'use POST' })
          const body = await readJsonBody(request)
          const cfg = getConfig()
          const readiness = describeReadiness(cfg)
          // 允许在还没保存的草稿上试发：界面上刚填好就能验证，不用先保存再改。
          const draft = body && typeof body === 'object' && body.config ? body.config : null
          const host = String(draft?.smtp?.host ?? '').trim() || cfg.smtp.host
          const port = Number(draft?.smtp?.port) || cfg.smtp.port
          const secure = draft?.smtp?.secure === undefined ? cfg.smtp.secure : Boolean(draft.smtp.secure)
          const user = String(draft?.smtp?.user ?? '').trim() || cfg.smtp.user
          const pass = String(draft?.smtp?.pass ?? '').trim() || cfg.smtp.pass
          const from = String(draft?.smtp?.from ?? '').trim() || readiness.from || user
          const recipients = Array.isArray(draft?.to)
            ? draft.to.map((v) => String(v ?? '').trim()).filter((v) => v.includes('@'))
            : readiness.recipients
          if (!host || !user || !pass || !from || recipients.length === 0) {
            return sendJson(response, 400, {
              ok: false,
              error: '配置不完整，先填好 SMTP 服务器、账号、授权码与收件地址',
              missing: readiness.missing,
              configPath: configPath(),
            })
          }
          try {
            const result = await sendMail({
              host,
              port,
              secure,
              rejectUnauthorized: (draft?.smtp?.rejectUnauthorized ?? cfg.smtp.rejectUnauthorized) !== false,
              allowInsecure: (draft?.smtp?.allowInsecure ?? cfg.smtp.allowInsecure) === true,
              user,
              pass,
              from,
              fromName: String(draft?.smtp?.fromName ?? '').trim() || cfg.smtp.fromName,
              to: recipients,
              subject: `${cfg.subjectPrefix ? `${cfg.subjectPrefix} ` : ''}测试邮件 · dsh-email-notify`,
              text: `这是一封测试邮件，说明 SMTP 配置可用。\n\n${stamp()}\n${configPath()}`,
            })
            // 记进 lastSend：否则用户发完测试邮件再看 /status 仍是 null，会犯嘀咕。
            lastResult = {
              at: Date.now(),
              ok: true,
              test: true,
              subject: '测试邮件 · dsh-email-notify',
              messageId: result.messageId,
              to: recipients,
            }
            sendJson(response, 200, { ok: true, messageId: result.messageId, to: recipients })
          } catch (error) {
            lastResult = { at: Date.now(), ok: false, test: true, error: error.message }
            sendJson(response, 500, { ok: false, error: error.message })
          }
        },
      })

      return () => {
        for (const dispose of [disposePresence, disposeInbox, disposeStatus, disposeConfig, disposeTest]) {
          if (typeof dispose === 'function') dispose()
        }
      }
    }, 'dsh-email-notify: http routes')

    const loaded = loadConfig()
    const readiness = describeReadiness(loaded.value)
    log('info', `已挂载。配置文件：${loaded.path}`)
    if (loaded.created) log('info', '已生成配置模板，请填写 smtp.user / smtp.pass（QQ 邮箱授权码）与收件人。')
    else if (!readiness.ready) log('warn', `配置未完成，暂时不会发信：缺 ${readiness.missing.join(', ')}`)
    else log('info', `已就绪：${readiness.from} → ${readiness.recipients.join(', ')}（${loaded.value.smtp.host}:${loaded.value.smtp.port}）`)
  })
}
