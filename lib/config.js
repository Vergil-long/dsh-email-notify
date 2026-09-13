/**
 * 插件配置：~/.dsh/dsh-email-notify/config.json
 *
 * 为什么不走 DSH 的 settings 命名空间：外部插件的 namespace 必须出现在
 * host 的 api-proxy 白名单里才能被浏览器端读写（见
 * @deepseek-ai/dsh-client-ui-settings-plugins 的已知限制），第三方插件做不到。
 * 所以按本机既有插件（dsh-bottom-info-bar）的约定，用一个自己的 JSON 文件，
 * 好处是改完即生效、不用重启。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 取 DSH 用户目录：优先环境变量，回落到 ~/.dsh。 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
  return join(homedir(), '.dsh')
}

export function configDir() {
  return join(resolveDshHome(), 'dsh-email-notify')
}

export function configPath() {
  return join(configDir(), 'config.json')
}

/**
 * 默认配置。
 *
 * 关键默认值的选择：
 *  - port 465 + secure：QQ/163/Gmail 的隐式 TLS 端口。
 *  - watchOnlyWhenAway（见 index.js）：看着界面就不发邮件。
 *  - notifyWhenFocused：看着界面时由本插件补一条完成提示（外壳那条通知误报率极高）。
 */
export const DEFAULTS = {
  enabled: true,
  smtp: {
    host: 'smtp.qq.com',
    port: 465,
    secure: true,
    rejectUnauthorized: true,
    /** 仅本机/内网可信中继才打开：允许在完全没有 TLS 的明文连接上发信。 */
    allowInsecure: false,
    user: '',
    pass: '',
    from: '',
    fromName: 'DeepSeek Harness',
  },
  /** 收件人，可多个。留空则回落到 smtp.from（发给自己）。 */
  to: [],
  /** 触发开关。 */
  events: {
    /** 回合结束（任务完成/失败）时通知。 */
    turnEnd: true,
    /** 需要授权（工具请求提权、沙箱越界等）时通知。 */
    approval: true,
    /** 助手向你提问、任务停在等你回答时通知。 */
    question: true,
  },
  /** 是否也给子会话（subagent / workflow 子任务）发通知，默认只报主对话。 */
  includeSubagents: false,
  /**
   * 看着界面时是否弹提示（仅 turnEnd 生效）。
   *
   * 默认 false：桌面外壳自己就会在看界面时弹"任务完成"系统通知
   * （它的误报已在 main.js 里修掉），插件再弹一条就是双份。
   * 想让插件接管这条提示（比如不用桌面外壳、直接用浏览器打开 GUI）再打开。
   */
  notifyWhenFocused: false,
  /** 看着界面时是否为「需要授权」弹提示，默认不弹——授权框就在眼前。 */
  approvalNotifyWhenFocused: false,
  /** 看着界面时是否为「向你提问」弹提示，默认不弹——问题就摆在眼前。 */
  questionNotifyWhenFocused: false,
  /** 两次发信的最小间隔（秒），0 = 不限。用于压掉异常的连续触发。 */
  minIntervalSeconds: 20,
  /** 一分钟内最多发几封，超过则静默丢弃，防止死循环刷屏。 */
  maxPerMinute: 6,
  /** 邮件正文里引用提问/回复的截断长度（字符）。`{提问}` `{最后回复}` 用它。 */
  excerptChars: 700,
  /**
   * 标题模板；留空 = 用内置默认（`{图标} 任务{状态} · {会话}`）。
   *
   * 刻意让"没自定义"表现为空串、而不是把默认值抄进 config.json：
   * 以后改进默认模板，没动过这项的用户能自动受益。
   */
  subjectTemplate: '',
  /** 正文模板；留空 = 用内置默认（精简版：工作区 / 会话 / 状态 / 离开模式）。 */
  bodyTemplate: '',
  /**
   * 离开模式 —— 会话页头那个按钮的状态，也是"要不要发邮件"的总闸。
   *
   *   开：**一律发**。不管你是不是正在看 harness 界面（这正是它存在的理由：
   *       "猜你在不在看界面"本身就不够可靠 —— 人走了但窗口还有焦点是常见情况）。
   *   关（默认）：**一封都不发** —— 我在电脑前看着呢，别拿邮件打扰我。
   *
   * 默认关：邮件通知由人明确开启，而不是靠猜。
   */
  awayMode: false,
  /**
   * 自动模式：不看「离开模式」按钮，回到"不在看界面才发邮件"的自动判定。
   *
   * 默认关（由按钮说了算）。想让插件自己判断就打开它 —— 打开后按钮会变灰并注明原因。
   */
  autoMode: false,
  /** 主题前缀。 */
  subjectPrefix: '[DSH]',
  /** 正文末尾附一行「打开 harness」的地址；留空自动用 http://127.0.0.1:3080。 */
  linkBase: '',
  /** 客户端心跳多久没到就认为它已不在看界面（秒）。 */
  watchingStaleSeconds: 90,
}

/** 深拷贝（配置都是 JSON 值）。 */
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** 把文件里的值合并到默认值上；只认已知字段，避免手写配置里的拼写错误静默生效。 */
function merge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return base
  const out = Array.isArray(base) ? base.slice() : { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in out)) continue
    if (key.startsWith('_')) continue
    const current = out[key]
    if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
      out[key] = merge(current, value)
    } else if (Array.isArray(current)) {
      out[key] = Array.isArray(value) ? value.slice() : current
    } else if (typeof current === typeof value || current === '' || current === null) {
      // 允许空字符串的字段（user/pass/from）接住任意字符串。
      out[key] = value
    }
  }
  return out
}

/**
 * 首次运行时写一份空模板。
 *
 * 刻意留空而不是写占位文字：这些值会直接显示在 harness 的设置界面里，
 * 写「你的QQ邮箱@qq.com」那种占位符会被当成真实值显示，反而让人以为填过了。
 * 用户第一次打开 设置 → 邮件通知 时照着界面填即可。
 */
function writeTemplate(path) {
  const template = {
    _说明: '本文件由 dsh-email-notify 插件读写。一般不用手改——打开 DSH 的「设置 → 邮件通知」在界面里改，改完会写回这里。',
    enabled: true,
    smtp: {
      host: 'smtp.qq.com',
      port: 465,
      secure: true,
      rejectUnauthorized: true,
      user: '',
      pass: '',
      from: '',
      fromName: 'DeepSeek Harness',
    },
    to: [],
  }
  writeFileSync(path, `${JSON.stringify(template, null, 2)}\n`, 'utf8')
}

let cache = null

/**
 * 读取配置（带 mtime 缓存，文件一改就生效）。
 * @param {boolean} [force] - 忽略缓存强制重读。
 * @returns {{value: object, path: string, created: boolean, error: string|null}}
 */
export function loadConfig(force = false) {
  const path = configPath()
  let created = false
  try {
    if (!existsSync(path)) {
      mkdirSync(configDir(), { recursive: true })
      writeTemplate(path)
      created = true
    }
  } catch (error) {
    return { value: clone(DEFAULTS), path, created: false, error: `无法创建配置文件：${error.message}` }
  }

  let mtimeMs = 0
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch (error) {
    return { value: clone(DEFAULTS), path, created, error: `无法读取配置文件：${error.message}` }
  }
  if (!force && cache && cache.mtimeMs === mtimeMs) {
    return { value: cache.value, path, created: false, error: cache.error }
  }

  let parsed = {}
  let error = null
  try {
    const raw = readFileSync(path, 'utf8')
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch (parseError) {
    error = `config.json 解析失败，已按默认值运行：${parseError.message}`
    parsed = {}
  }

  const value = merge(clone(DEFAULTS), parsed)
  // 环境变量兜底：密码可以放在 DSH_EMAIL_NOTIFY_PASS 里，避免写进磁盘。
  if (!value.smtp.pass && process.env.DSH_EMAIL_NOTIFY_PASS) {
    value.smtp.pass = process.env.DSH_EMAIL_NOTIFY_PASS
  }
  if (!value.smtp.user && process.env.DSH_EMAIL_NOTIFY_USER) {
    value.smtp.user = process.env.DSH_EMAIL_NOTIFY_USER
  }
  cache = { mtimeMs, value, error }
  return { value, path, created, error }
}

/** 配置是否已经填好了发信所需的字段。 */
export function describeReadiness(config) {
  const smtp = config.smtp ?? {}
  const missing = []
  if (!smtp.host) missing.push('smtp.host')
  if (!smtp.user) missing.push('smtp.user')
  if (!smtp.pass) missing.push('smtp.pass')
  const from = smtp.from || smtp.user
  if (!from) missing.push('smtp.from')
  const recipients = collectRecipients(config)
  if (recipients.length === 0) missing.push('to')
  return { ready: missing.length === 0, missing, from, recipients }
}

/** 收件人列表：to 为空时发给发件人自己。 */
export function collectRecipients(config) {
  const smtp = config.smtp ?? {}
  const list = (Array.isArray(config.to) ? config.to : [config.to])
    .map((v) => String(v ?? '').trim())
    .filter((v) => v.includes('@'))
  if (list.length > 0) return list
  const self = String(smtp.from || smtp.user || '').trim()
  return self.includes('@') ? [self] : []
}

/**
 * 给设置界面用的安全视图：口令一律替换成布尔位，绝不把授权码发到浏览器。
 * @param {object} config - 解析后的配置。
 * @returns {object} 可安全返回给前端的一份拷贝。
 */
export function publicConfig(config) {
  const smtp = config.smtp ?? {}
  return {
    ...clone(config),
    smtp: {
      ...clone(smtp),
      pass: '',
      passSet: Boolean(smtp.pass),
      /** 口令来自环境变量时，界面要提示"由环境变量提供"，避免用户以为没生效。 */
      passFromEnv: !smtp.pass && Boolean(process.env.DSH_EMAIL_NOTIFY_PASS),
    },
  }
}

/** 只允许从设置界面写这些键，别的键（含 _说明 之类）由文件自己保留。 */
const WRITABLE = {
  enabled: 'boolean',
  to: 'array',
  includeSubagents: 'boolean',
  awayMode: 'boolean',
  autoMode: 'boolean',
  notifyWhenFocused: 'boolean',
  approvalNotifyWhenFocused: 'boolean',
  questionNotifyWhenFocused: 'boolean',
  minIntervalSeconds: 'number',
  maxPerMinute: 'number',
  excerptChars: 'number',
  subjectTemplate: 'string',
  bodyTemplate: 'string',
  subjectPrefix: 'string',
  linkBase: 'string',
  watchingStaleSeconds: 'number',
}
const WRITABLE_SMTP = {
  host: 'string',
  port: 'number',
  secure: 'boolean',
  rejectUnauthorized: 'boolean',
  allowInsecure: 'boolean',
  user: 'string',
  pass: 'string',
  from: 'string',
  fromName: 'string',
}
const WRITABLE_EVENTS = { turnEnd: 'boolean', approval: 'boolean', question: 'boolean' }

/** 按类型收窄一个来路不明的值；类型不对就返回 undefined 表示"忽略这一项"。 */
function coerce(kind, value) {
  if (kind === 'boolean') {
    if (typeof value === 'boolean') return value
    if (value === 'true') return true
    if (value === 'false') return false
    return undefined
  }
  if (kind === 'number') {
    const num = typeof value === 'number' ? value : Number(String(value ?? '').trim())
    return Number.isFinite(num) && num >= 0 ? num : undefined
  }
  if (kind === 'string') return typeof value === 'string' ? value.trim() : undefined
  if (kind === 'array') {
    if (Array.isArray(value)) return value.map((v) => String(v ?? '').trim()).filter(Boolean)
    if (typeof value === 'string') return value.split(/[,，;\s]+/).map((v) => v.trim()).filter(Boolean)
    return undefined
  }
  return undefined
}

/** 从任意输入里挑出允许写入的字段。 */
function pickWritable(patch) {
  const out = {}
  if (patch === null || typeof patch !== 'object') return out
  for (const [key, kind] of Object.entries(WRITABLE)) {
    if (!(key in patch)) continue
    const value = coerce(kind, patch[key])
    if (value !== undefined) out[key] = value
  }
  if (patch.smtp && typeof patch.smtp === 'object') {
    const smtp = {}
    for (const [key, kind] of Object.entries(WRITABLE_SMTP)) {
      if (!(key in patch.smtp)) continue
      const value = coerce(kind, patch.smtp[key])
      // 口令留空 = "不改"，这是设置界面的约定，否则每次保存都会把授权码抹掉。
      if (key === 'pass' && value === '') continue
      if (value !== undefined) smtp[key] = value
    }
    if (Object.keys(smtp).length > 0) out.smtp = smtp
  }
  if (patch.events && typeof patch.events === 'object') {
    const events = {}
    for (const [key, kind] of Object.entries(WRITABLE_EVENTS)) {
      if (!(key in patch.events)) continue
      const value = coerce(kind, patch.events[key])
      if (value !== undefined) events[key] = value
    }
    if (Object.keys(events).length > 0) out.events = events
  }
  return out
}

/** 把两个对象深合并（只有普通对象才递归，数组整体替换）。 */
function deepAssign(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    const current = target[key]
    if (current !== null && typeof current === 'object' && !Array.isArray(current)
      && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      deepAssign(current, value)
    } else {
      target[key] = value
    }
  }
  return target
}

/**
 * 把设置界面提交的改动写进 config.json。
 *
 * 刻意"读原始文件 → 只覆盖白名单字段 → 整体写回"：
 * 直接写 DEFAULTS 的合并结果会把用户没碰过的默认值也固化进文件，
 * 以后改默认值就不生效了；而只挑白名单能保证手写的注释键、未知键都被保留。
 *
 * @param {object} patch - 来自设置界面的部分字段。
 * @returns {{ok: boolean, error?: string, value?: object}}
 */
export function saveConfig(patch) {
  const path = configPath()
  const picked = pickWritable(patch)

  let raw = {}
  try {
    if (existsSync(path)) raw = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    // 文件坏了也别丢：下面会以空对象为底重写一份可用的。
    raw = {}
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) raw = {}

  deepAssign(raw, picked)
  try {
    mkdirSync(configDir(), { recursive: true })
    // 先写临时文件再改名，避免写到一半崩溃留下半个 JSON。
    const temp = `${path}.tmp`
    writeFileSync(temp, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
    renameSync(temp, path)
  } catch (error) {
    return { ok: false, error: `写入失败：${error.message}` }
  }

  cache = null
  const loaded = loadConfig(true)
  return { ok: true, value: loaded.value }
}
