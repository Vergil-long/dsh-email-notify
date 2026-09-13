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
import { titleFromProjection } from './session-title.js'
import { sendMail } from './smtp.js'
import {
  DEFAULT_BODY_TEMPLATE,
  DEFAULT_SUBJECT_TEMPLATE,
  DETAILED_BODY_TEMPLATE,
  PLACEHOLDERS,
  renderSubject,
  renderTemplate,
  resolveTemplate,
  tidyText,
  unknownPlaceholders,
} from './template.js'

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
 * 设置界面要用的模板元数据：默认模板 + 占位符清单。
 *
 * 由宿主端下发而不是在客户端再抄一份 —— 客户端是单文件 bundle，没法 import 这些常量，
 * 两边各写一份迟早会对不上（占位符多一个少一个，用户就白填了）。
 */
const TEMPLATE_META = {
  defaultSubject: DEFAULT_SUBJECT_TEMPLATE,
  defaultBody: DEFAULT_BODY_TEMPLATE,
  detailedBody: DETAILED_BODY_TEMPLATE,
  placeholders: PLACEHOLDERS,
}

/**
 * 检查模板里有没有**拼错**的占位符。
 *
 * 渲染时认不出的占位符会变成空字符串，邮件里就"悄悄少了一行"；与其让用户对着
 * 邮件纳闷，不如在保存的那一刻就告诉他。
 *
 * @param {object} config - 解析后的配置。
 * @returns {string[]} 给人看的警告（没有问题时是空数组）。
 */
function templateWarnings(config) {
  const warnings = []
  for (const [label, text] of [['主题模板', config.subjectTemplate], ['正文模板', config.bodyTemplate]]) {
    const unknown = unknownPlaceholders(text)
    if (unknown.length > 0) warnings.push(`${label}里有我不认识的占位符：${unknown.join('、')}（会渲染成空）`)
  }
  return warnings
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
   * 现在到底该不该**发邮件**？
   *
   * 两种方式，由设置里的「自动模式」决定：
   *   - 自动模式（默认关）：**「离开模式」按钮说了算** —— 开着就一律发，关了一封都不发。
   *     为什么要让人来说了算：`isWatching()` 只能看"窗口有没有焦点"，而"人走了但
   *     窗口还开着、还有焦点"恰恰是最常见的情况 —— 那时自动判定会以为你还在看，
   *     于是你在外面一封都收不到。这正是"判断不够智能"的根源。
   *   - 自动模式打开：回到"不在看界面才发"的老行为。
   *
   * @param {object} cfg - 当前配置。
   * @returns {boolean} 是否应当发邮件。
   */
  function shouldMail(cfg) {
    if (!cfg.enabled) return false
    if (cfg.autoMode) return !isWatching()
    return cfg.awayMode === true
  }

  /**
   * 统一分发：发不发邮件由 `shouldMail` 决定；界面提示则照旧按"看界面时也弹提示"的开关。
   *
   * 两种决定刻意互相独立：邮件是"我不在电脑前"的通道，界面提示是"我在电脑前"的通道。
   * 离开模式开着又恰好坐在电脑前时，两者可以同时发生 —— 那正是用户主动点的"都发给我"。
   *
   * 三种触发在看界面时的默认行为不同：
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
    }

    if (!shouldMail(cfg)) {
      log('info', cfg.autoMode
        ? `你在看界面，不发邮件（${kind}）`
        : `离开模式没开，不发邮件（${kind}）`)
      return
    }
    await deliver(cfg, { subject: mail.subject, body: mail.body, bucket: `${kind}:${payload.sessionId}` })
  }

  /**
   * 会话名 —— 邮件里显示的必须是**左侧列表里那个名字**，不是 `session-…` 这串 id。
   *
   * 三层兜底：
   *   1) 内存表（由 `session/title` 事件填充，含用户改名）
   *   2) 回读会话日志：插件通常在会话已经开始之后才挂载（或 DSH 重启过），
   *      这时内存表是空的，而会话日志里那条 `session/title` 事件一直都在。
   *   3) 侧栏投影缓存：前两条都没有时，直接读侧栏渲染用的那份数据
   *      （`~/.dsh/storages/session_projcache.json`）。
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
    const projected = titleFromProjection(session.id)
    if (projected) titles.set(session.id, projected)
    return projected
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

  /**
   * 模板占位符里三种通知都有的那一份。
   *
   * 注意 `{会话}` 取的是**侧栏名**（`titleOf`），`{会话ID}` 才是内部 id ——
   * 用户只看前者，所以默认模板里出现的永远是前者。
   */
  function baseVars(cfg, session, title) {
    const header = session.header ?? {}
    return {
      会话: title || '（未命名会话）',
      会话ID: session.id,
      工作区: header.cwd || '未知',
      // 页头那个开关的状态。自动模式下写「自动」—— 那时按钮是灰的，
      // 写「关」会让人觉得"明明在发邮件，怎么说关着"。
      离开模式: cfg.autoMode ? '自动' : (cfg.awayMode === true ? '开' : '关'),
      时间: stamp(),
      地址: String(cfg.linkBase || '').trim() || 'http://127.0.0.1:3080',
    }
  }

  /**
   * 按用户模板生成主题与正文。
   *
   * 主题前缀（subjectPrefix）单独拼在最前面、不进模板：它是"全局标识"，
   * 不该因为用户改了模板就悄悄消失。
   *
   * @param {object} cfg - 当前配置。
   * @param {Record<string, string|number>} vars - 占位符取值。
   * @returns {{subject: string, body: string}} 邮件主题与正文。
   */
  function composeMail(cfg, vars) {
    const subjectTemplate = resolveTemplate(cfg.subjectTemplate, DEFAULT_SUBJECT_TEMPLATE)
    const bodyTemplate = resolveTemplate(cfg.bodyTemplate, DEFAULT_BODY_TEMPLATE)
    const prefix = cfg.subjectPrefix ? `${cfg.subjectPrefix} ` : ''
    return {
      subject: `${prefix}${renderSubject(subjectTemplate, vars)}`,
      body: tidyText(renderTemplate(bodyTemplate, vars)),
    }
  }

  /**
   * 测试邮件的主题与正文 —— **按用户当前的模板渲染**。
   *
   * 这样点一下「发送测试邮件」，手机上收到的就是真实通知的样子（自定义模板的效果
   * 一眼可见），不用等到真发生一次提问或授权才看出来。
   *
   * @param {object} cfg - 已保存的配置。
   * @param {object|null} draft - 界面上还没保存的草稿（模板以草稿为准，便于先试后存）。
   * @returns {{subject: string, body: string}} 邮件主题与正文。
   */
  function testMail(cfg, draft) {
    return composeMail(
      {
        subjectPrefix: cfg.subjectPrefix,
        linkBase: cfg.linkBase,
        subjectTemplate: String(draft?.subjectTemplate ?? cfg.subjectTemplate ?? ''),
        bodyTemplate: String(draft?.bodyTemplate ?? cfg.bodyTemplate ?? ''),
      },
      {
        会话: '示例会话名',
        会话ID: 'session-test',
        工作区: 'D:\\示例\\我的项目',
        时间: stamp(),
        地址: String(cfg.linkBase || '').trim() || 'http://127.0.0.1:3080',
        图标: '🧪',
        状态: '这是一封测试邮件',
        回合: 1,
        用时: '1 秒',
        工具: 'pwsh',
        摘要: '测试邮件',
        详情: `能收到就说明 SMTP 配置可用。主题和正文都按你现在的模板渲染，真通知就长这样。\n${configPath()}`,
        提问: '（这里会是你那一轮的提问）',
        最后回复: '（这里会是助手的最后回复）',
      },
    )
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
    const mark = kind === 'completed' ? '✅' : kind === 'error' ? '⚠️' : '⏹️'
    const { prompt, reply } = collectExcerpts(session, turn, Number(cfg.excerptChars) || 700)
    const mail = composeMail(cfg, {
      ...baseVars(cfg, session, title),
      图标: mark,
      状态: outcome,
      回合: turn,
      用时: humanDuration(durationMs),
      // 任务完成时没有"要你做什么"的详情；出错时把错误原因放这儿，方便直接看邮件定位。
      详情: reason.error?.message ? `错误：${excerpt(reason.error.message, 200)}` : '',
      摘要: '',
      工具: '',
      提问: prompt,
      最后回复: reply,
    })

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
      mail,
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

    // 「要你做什么」的那部分放进 {详情}：默认模板里它紧跟在「状态：」后面。
    const detail = [`工具：${toolName}`]
    if (reason) detail.push(`原因：${excerpt(reason, 200)}`)
    detail.push('', '任务现在停在授权这一步等你决定，回到 harness 窗口点「允许」或「拒绝」才会继续。')

    const mail = composeMail(cfg, {
      ...baseVars(cfg, session, title),
      图标: '🔐',
      状态: '需要你授权',
      回合: '',
      用时: '',
      工具: toolName,
      摘要: toolName,
      详情: detail.join('\n'),
      提问: '',
      最后回复: '',
    })

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
      mail,
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
    const first = questions[0]
    const headline = first ? excerpt(first.header || first.text, 30) : '需要你回答'

    // 问题全文与选项进 {详情} —— 用户要在手机上看完就能决定，这一段不能省。
    const detail = []
    for (const [index, question] of questions.entries()) {
      detail.push(`${questions.length > 1 ? `【${index + 1}】` : ''}${question.header ? `${question.header}：` : ''}${question.text}`)
      for (const option of question.options) detail.push(`   · ${option}`)
    }
    detail.push('', '任务现在停在等你回答这一步，回到 harness 窗口作答才会继续。')

    const mail = composeMail(cfg, {
      ...baseVars(cfg, session, title),
      图标: '❓',
      状态: '等你回答',
      回合: '',
      用时: '',
      工具: '',
      摘要: headline,
      详情: detail.join('\n'),
      提问: '',
      最后回复: '',
    })

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
      mail,
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
            // 「离开模式」按钮的状态与当前会不会发信（界面靠它显示按钮与状态行）
            awayMode: cfg.awayMode === true,
            autoMode: cfg.autoMode === true,
            willMail: shouldMail(cfg),
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
              templates: TEMPLATE_META,
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
          const warnings = templateWarnings(cfg)
          log('info', `设置已更新（配置文件：${configPath()}）`)
          sendJson(response, 200, {
            ok: true,
            config: publicConfig(cfg),
            ready: readiness.ready,
            missing: readiness.missing,
            configPath: configPath(),
            templates: TEMPLATE_META,
            warnings,
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
            const mail = testMail(cfg, draft)
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
              subject: mail.subject,
              text: mail.body,
            })
            // 记进 lastSend：否则用户发完测试邮件再看 /status 仍是 null，会犯嘀咕。
            lastResult = {
              at: Date.now(),
              ok: true,
              test: true,
              subject: mail.subject,
              messageId: result.messageId,
              to: recipients,
            }
            sendJson(response, 200, { ok: true, messageId: result.messageId, to: recipients, subject: mail.subject })
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
    // 发信总闸的当前状态要说清楚：默认是"离开模式关着=一封都不发"，
    // 不说明的话用户会以为插件坏了。
    if (loaded.value.autoMode) log('info', '发信方式：自动（不在看界面时发）')
    else if (loaded.value.awayMode) log('info', '发信方式：离开模式【开】—— 所有勾选的通知都会发邮件')
    else log('info', '发信方式：离开模式【关】—— 目前不会发任何邮件，点会话页头的「离开模式」按钮才会开始发')
  })
}
