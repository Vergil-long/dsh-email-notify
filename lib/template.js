/**
 * 邮件主题与正文的模板引擎 —— 纯函数，便于单测，也被设置界面复用。
 *
 * 为什么要有这一层：早先正文是代码里写死的五行 + 提问 + 最后回复（最长 700 字），
 * 手机上根本看不完。现在正文完全由用户可编辑的模板决定，默认只留三行。
 *
 * 设计取舍：
 *   - 占位符用**中文大括号**（`{会话}`），因为这份模板是给用户看的，不是给程序员看的。
 *   - `{\s*会话\s*}` 也认，用户手滑加空格不会失效。
 *   - **认不出来的占位符渲染成空字符串**，而不是原样留着 —— 邮件里出现 `{会化}`
 *     这种残留比少一行更让人困惑。设置界面在保存时会提示"这几个占位符我不认识"，
 *     把问题暴露在编辑现场。
 *   - 连续的空行会被压成一个（见 `tidyText`），所以默认模板里那行 `{详情}` 在
 *     "任务完成"（详情为空）时只会留下一个空行做分隔，不会撑出好几行空白。
 */

/** 主题模板：默认与旧版行为一致（`[DSH] ✅ 任务已完成 · 会话名`，`[DSH]` 由 subjectPrefix 提供）。 */
export const DEFAULT_SUBJECT_TEMPLATE = '{图标} 任务{状态} · {会话}'

/** 正文模板（精简版，默认）：工作区、会话、状态、离开模式，末尾一行出处。 */
export const DEFAULT_BODY_TEMPLATE = [
  '工作区：{工作区}',
  '会话：{会话}',
  '状态：{状态}',
  '离开模式：{离开模式}',
  // `{详情}` 放在"离开模式"之后，是为了它为空时能跟下面那个空行合并 ——
  // 夹在「状态」和「离开模式」中间的话，任务完成的通知里会多出一道空行。
  // 需要授权 / 等你回答时，它才会展开成工具名与原因、或问题原文与选项。
  '{详情}',
  '',
  '这封邮件由 dsh-email-notify 发送',
].join('\n')

/** 正文模板（详细版）：想多看一点时点「套用详细模板」即可，不用自己查占位符。 */
export const DETAILED_BODY_TEMPLATE = [
  '工作区：{工作区}',
  '会话：{会话}',
  '状态：{状态}',
  '离开模式：{离开模式}',
  '时间：{时间}',
  '回合：第 {回合} 轮 · 用时 {用时}',
  '{详情}',
  '{最后回复}',
  '',
  '这封邮件由 dsh-email-notify 发送',
].join('\n')

/**
 * 可用占位符总表：设置界面直接渲染这份清单当"说明书"，宿主端与界面共用一份，
 * 避免两边各写一份而慢慢对不上。
 *
 * 每种通知里 `{详情}` / `{摘要}` / `{工具}` 的取值不同：
 *   - 任务完成：`{详情}` 与 `{摘要}` 为空（有 `{提问}` `{最后回复}` 可看）
 *   - 需要授权：`{详情}` = 工具名 + 原因；`{摘要}` = 工具名
 *   - 等你回答：`{详情}` = 问题全文与选项；`{摘要}` = 问题首行
 */
export const PLACEHOLDERS = [
  { key: '会话', desc: '会话名（左侧列表里显示的那个名字）' },
  { key: '工作区', desc: '工作目录的完整路径' },
  { key: '状态', desc: '已完成 / 出错 / 已中止 / 需要你授权 / 等你回答' },
  { key: '离开模式', desc: '开 / 关 / 自动 —— 页头那个开关的状态' },
  { key: '详情', desc: '提问内容、授权原因；任务完成时为空' },
  { key: '摘要', desc: '一行摘要（问题首行、工具名），适合放进标题' },
  { key: '提问', desc: '你这一轮的提问（按「摘要长度」截断）' },
  { key: '最后回复', desc: '助手的最后回复（按「摘要长度」截断）' },
  { key: '时间', desc: '形如 2026-09-13 18:08' },
  { key: '地址', desc: 'harness 的访问地址' },
  { key: '回合', desc: '第几轮' },
  { key: '用时', desc: '形如 7 分 24 秒' },
  { key: '图标', desc: '✅ / ⚠️ / ⏹️ / 🔐 / ❓' },
  { key: '工具', desc: '需要授权的工具名' },
  { key: '会话ID', desc: '会话的内部 id（一般用不到）' },
]

/**
 * 占位符改过名的旧名字 → 新名字。
 *
 * `{结果}` 是 0.5.0 及更早的名字，后来改成 `{状态}`。**老模板里的 `{结果}` 照样认**，
 * 否则已经存过自定义模板的人会突然发现那一行变成了空白，还以为是插件坏了。
 * 认归认，占位符清单里只列新名字，让新写模板的人用新的。
 */
export const PLACEHOLDER_ALIASES = { 结果: '状态' }

/** 占位符的合法名字集合（含旧名），供校验用。 */
export const PLACEHOLDER_KEYS = [
  ...PLACEHOLDERS.map((item) => item.key),
  ...Object.keys(PLACEHOLDER_ALIASES),
]

/** 匹配 `{...}`（其中可以有空格）。 */
const PLACEHOLDER_PATTERN = /\{([^{}\r\n]*)\}/g

/**
 * 渲染模板。
 *
 * 单趟替换：值里带 `{}` 也不会被二次解析（例如助手的回复里就有 JSON）。
 *
 * @param {string} template - 模板文本。
 * @param {Record<string, string|number>} vars - 占位符名 → 值（不带大括号）。
 * @returns {string} 渲染结果（不做空行整理，交给 `tidyText`）。
 */
export function renderTemplate(template, vars) {
  const values = vars ?? {}
  return String(template ?? '').replace(PLACEHOLDER_PATTERN, (_match, rawName) => {
    const name = String(rawName).trim()
    // 旧名字（如 `{结果}`）先映射到新名字，老模板照样能用。
    const key = PLACEHOLDER_ALIASES[name] ?? name
    const value = values[key]
    return value === undefined || value === null ? '' : String(value)
  })
}

/**
 * 找出模板里**认不出来**的占位符。
 *
 * 渲染时空值会被默默替换掉，但"你把 `{会化}` 拼错了"这种事必须让用户知道，
 * 所以设置界面保存前拿这个函数过一遍并提示。
 *
 * @param {string} template - 模板文本。
 * @returns {string[]} 去重后的未知占位符（带大括号，便于直接显示）。
 */
export function unknownPlaceholders(template) {
  const seen = new Set()
  const unknown = []
  const text = String(template ?? '')
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    const name = String(match[1]).trim()
    if (PLACEHOLDER_KEYS.includes(name) || seen.has(name)) continue
    seen.add(name)
    // 空的大括号（`{}`）多半是手滑，也算未知，提示用户。
    unknown.push(`{${name}}`)
  }
  return unknown
}

/**
 * 整理渲染结果：压掉空行、去掉首尾空行。
 *
 * 为什么需要：模板里为了可读性会留空行，而某个占位符渲染成空之后那一行会变成
 * 纯空白 —— 不处理的话邮件末尾就会挂着一串空行，手机上白花花一片。
 *
 * @param {string} text - 渲染后的文本。
 * @returns {string} 整理后的文本（换行统一成 \n）。
 */
export function tidyText(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  for (const raw of lines) {
    const line = raw.replace(/[ \t]+$/, '')
    if (line === '' && (out.length === 0 || out[out.length - 1] === '')) continue
    out.push(line)
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}

/**
 * 渲染主题：模板按单行处理（主题里的换行会被邮件客户端吃掉，不如自己压成空格）。
 *
 * @param {string} template - 主题模板。
 * @param {Record<string, string|number>} vars - 占位符取值。
 * @returns {string} 单行主题。
 */
export function renderSubject(template, vars) {
  return tidyText(renderTemplate(template, vars)).replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

/**
 * 取用户配置的模板，没配（空串）就用内置默认值。
 *
 * 刻意让"没配"表现为空串而不是把默认值抄进 config.json：以后改进默认模板，
 * 没自定义过的用户能自动受益。
 *
 * @param {string|undefined} configured - 配置里的模板。
 * @param {string} fallback - 内置默认模板。
 * @returns {string} 实际要用的模板。
 */
export function resolveTemplate(configured, fallback) {
  const value = typeof configured === 'string' ? configured : ''
  return value.trim() === '' ? fallback : value
}
