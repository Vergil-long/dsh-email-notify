/**
 * 零依赖 SMTP 客户端。
 *
 * 只实现发信需要的最小协议子集：EHLO → (STARTTLS) → AUTH LOGIN/PLAIN →
 * MAIL FROM → RCPT TO → DATA → QUIT。
 *
 * 为什么不用 nodemailer：DSH 运行时的 node_modules 里没有它，而这个插件要
 * 能直接以「拷贝 + 目录联接」的方式装进 profile，不能依赖任何需要联网安装
 * 的包。协议本身很短，自己实现反而更可控。
 *
 * 支持：
 *   - 465 隐式 TLS（secure: true，QQ/163/Gmail 常用）
 *   - 587/25 明文 + STARTTLS 升级（Outlook 常用）
 *   - AUTH LOGIN / AUTH PLAIN
 *   - RFC 2047 编码的主题、UTF-8 base64 正文（避免中文乱码与点填充问题）
 *
 * 默认拒绝「不支持 STARTTLS 的明文服务器」，避免授权码裸奔；只有在明确
 * 信任的本机/内网中继上，才用 allowInsecure 打开明文发送。
 */
import net from 'node:net'
import tls from 'node:tls'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

const CRLF = '\r\n'

/** 服务端返回码 != 预期时抛出的错误，带上原始应答便于排查。 */
export class SmtpError extends Error {
  constructor(message, code, response) {
    super(message)
    this.name = 'SmtpError'
    this.code = code
    this.response = response
  }
}

/** 把 SMTP 数字应答翻译成中文提示，方便直接看懂失败原因。 */
function explain(code, response) {
  const text = String(response || '').trim()
  if (code === 535 || code === 534 || code === 530) {
    return `认证失败（${code}）：账号或授权码不对。QQ 邮箱要用「设置 → 账户 → IMAP/SMTP 服务」里生成的授权码，不是登录密码。\n服务器应答：${text}`
  }
  if (code === 550 || code === 553 || code === 554) {
    return `发件人/收件人被拒绝（${code}）：检查 from 必须是登录的邮箱本身，收件人地址是否有效。\n服务器应答：${text}`
  }
  if (code === 421 || code === 450 || code === 451 || code === 452) {
    return `服务器暂时拒绝（${code}）：通常是发信过于频繁被限流，稍后再试。\n服务器应答：${text}`
  }
  return `SMTP 服务器返回 ${code}。\n服务器应答：${text}`
}

/**
 * 从缓冲区里切出**一条完整**应答；不完整返回 null（继续等数据）。
 * SMTP 多行应答形如 `250-XXX` 续行、最后一行 `250 XXX`。
 * @param {string} buffer - 已收到的文本（latin1 安全，应答都是 ASCII）。
 * @returns {{code: number, lines: string[], rest: string} | null}
 */
function takeReply(buffer) {
  let cursor = 0
  let code = null
  const lines = []
  for (;;) {
    const end = buffer.indexOf(CRLF, cursor)
    if (end < 0) return null
    const line = buffer.slice(cursor, end)
    cursor = end + 2
    const match = /^(\d{3})([ -])/.exec(line)
    if (!match) {
      // 应答还没开始就出现无法识别的行：当作噪声丢弃，等下一行。
      if (code === null) continue
      lines.push(line)
      continue
    }
    if (code === null) code = Number(match[1])
    lines.push(line)
    if (match[2] === ' ') return { code, lines, rest: buffer.slice(cursor) }
  }
}

/** 一条 SMTP 连接（含 TLS 升级后的重建）。 */
class SmtpConnection {
  constructor(socket, { timeoutMs, onTrace }) {
    this.socket = socket
    this.timeoutMs = timeoutMs
    this.onTrace = typeof onTrace === 'function' ? onTrace : null
    this.buffer = ''
    this.waiter = null
    this.failure = null
    this.closed = false
    this.onData = (chunk) => {
      this.buffer += chunk.toString('latin1')
      this.pump()
    }
    this.onError = (error) => this.fail(error)
    this.onClose = () => this.fail(new Error('SMTP 连接被服务器关闭'))
    socket.setTimeout(timeoutMs, () => this.fail(new Error(`SMTP 操作超时（${timeoutMs}ms）`)))
    socket.on('data', this.onData)
    socket.on('error', this.onError)
    socket.on('close', this.onClose)
  }

  /** 摘掉当前 socket 的监听（STARTTLS 升级前必须做，否则旧 socket 的事件会污染状态）。 */
  detach() {
    const socket = this.socket
    socket.off('data', this.onData)
    socket.off('error', this.onError)
    socket.off('close', this.onClose)
    try { socket.setTimeout(0) } catch { /* 已销毁 */ }
  }

  fail(error) {
    if (this.failure || this.closed) return
    this.failure = error
    const waiter = this.waiter
    this.waiter = null
    if (waiter) waiter.reject(error)
  }

  pump() {
    if (!this.waiter) return
    const taken = takeReply(this.buffer)
    if (!taken) return
    this.buffer = taken.rest
    const waiter = this.waiter
    this.waiter = null
    if (this.onTrace) this.onTrace(`S: ${taken.lines.join(' / ')}`)
    waiter.resolve({ code: taken.code, lines: taken.lines, text: taken.lines.join('\n') })
  }

  /** 等一条应答。 */
  read() {
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject }
      this.pump()
    })
  }

  /** 原样写一行（自动补 CRLF）。 */
  writeRaw(text) {
    return new Promise((resolve, reject) => {
      if (this.failure) return reject(this.failure)
      this.socket.write(text, (error) => (error ? reject(error) : resolve()))
    })
  }

  /**
   * 发一条命令并校验应答码。
   * @param {string} line - 命令原文。
   * @param {number[]} expected - 可接受的返回码。
   * @param {boolean} [redact] - 追踪输出里是否隐藏该行（认证凭据）。
   */
  async command(line, expected, redact = false) {
    if (this.onTrace) this.onTrace(`C: ${redact ? '<已隐藏>' : line}`)
    await this.writeRaw(line + CRLF)
    const reply = await this.read()
    if (expected && !expected.includes(reply.code)) {
      throw new SmtpError(explain(reply.code, reply.text), reply.code, reply.text)
    }
    return reply
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.detach()
    try { this.socket.destroy() } catch { /* 已关闭 */ }
  }
}

/** 连上目标（TLS 或明文），等连接真正可用。 */
async function connect({ host, port, secure, rejectUnauthorized, timeoutMs }) {
  const socket = secure
    ? tls.connect({ host, port, servername: host, rejectUnauthorized })
    : net.connect({ host, port })
  socket.setNoDelay(true)
  const event = secure ? 'secureConnect' : 'connect'
  const timer = setTimeout(() => socket.destroy(new Error(`连接 ${host}:${port} 超时（${timeoutMs}ms）`)), timeoutMs)
  try {
    await once(socket, event)
  } catch (error) {
    clearTimeout(timer)
    socket.destroy()
    throw new Error(`无法连接 ${host}:${port}：${error.message}`)
  }
  clearTimeout(timer)
  return socket
}

/** 解析 EHLO 应答里的扩展（返回 大写关键字 → 参数 的 Map）。 */
function parseCapabilities(lines) {
  const caps = new Map()
  for (const line of lines ?? []) {
    const body = line.slice(4).trim()
    if (!body) continue
    const space = body.indexOf(' ')
    const key = (space < 0 ? body : body.slice(0, space)).toUpperCase()
    const value = space < 0 ? '' : body.slice(space + 1).trim()
    caps.set(key, caps.has(key) ? `${caps.get(key)} ${value}` : value)
  }
  return caps
}

/** 非 ASCII 头字段按 RFC 2047 编码，防止中文主题在客户端变成问号。 */
function encodeHeaderValue(value) {
  const text = String(value ?? '')
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(text)) return text
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`
}

/** 显示名 + 地址。 */
function formatAddress(name, address) {
  const clean = String(address ?? '').trim()
  const label = String(name ?? '').trim()
  return label ? `${encodeHeaderValue(label)} <${clean}>` : `<${clean}>`
}

/** base64 正文按 76 列折行（SMTP 单行上限 998 字节）。 */
function wrapBase64(base64) {
  const out = []
  for (let i = 0; i < base64.length; i += 76) out.push(base64.slice(i, i + 76))
  return out
}

/** 组装一封 text/plain + UTF-8 的邮件实体。 */
function buildMessage({ from, fromName, to, subject, text, messageId, date, headers }) {
  const lines = [
    `From: ${formatAddress(fromName, from)}`,
    `To: ${to.join(', ')}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
  ]
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value === undefined || value === null) continue
    lines.push(`${key}: ${encodeHeaderValue(value)}`)
  }
  lines.push('', ...wrapBase64(Buffer.from(text, 'utf8').toString('base64')))
  return lines.join(CRLF)
}

/**
 * 发一封邮件。
 * @param {object} options
 * @param {string} options.host - SMTP 主机。
 * @param {number} [options.port] - 端口，默认 465。
 * @param {boolean} [options.secure] - true = 隐式 TLS（465），false = 明文 + STARTTLS。
 * @param {boolean} [options.rejectUnauthorized] - 是否校验证书，默认 true。
 * @param {string} [options.user] - 登录账号；留空则跳过 AUTH。
 * @param {string} [options.pass] - 授权码/密码。
 * @param {string} options.from - 发件地址。
 * @param {string} [options.fromName] - 发件显示名。
 * @param {string[]} options.to - 收件地址列表。
 * @param {string} options.subject - 主题。
 * @param {string} options.text - 正文。
 * @param {number} [options.timeoutMs] - 单步超时，默认 20000。
 * @returns {Promise<{messageId: string, accepted: string[], response: string}>}
 */
export async function sendMail(options) {
  const {
    host,
    port = 465,
    secure = port === 465,
    rejectUnauthorized = true,
    allowInsecure = false,
    user,
    pass,
    from,
    fromName,
    to,
    subject,
    text,
    timeoutMs = 20_000,
    headers,
    onTrace,
  } = options ?? {}

  const recipients = (Array.isArray(to) ? to : [to]).map((v) => String(v ?? '').trim()).filter(Boolean)
  if (!host) throw new Error('缺少 SMTP 主机（smtp.host）')
  if (!from) throw new Error('缺少发件人地址（smtp.from）')
  if (recipients.length === 0) throw new Error('缺少收件人地址（to）')

  const clientName = hostname() || 'dsh-email-notify'
  let connection = new SmtpConnection(
    await connect({ host, port, secure, rejectUnauthorized, timeoutMs }),
    { timeoutMs, onTrace },
  )

  try {
    const greeting = await connection.read()
    if (greeting.code !== 220) throw new SmtpError(explain(greeting.code, greeting.text), greeting.code, greeting.text)

    let ehlo = await connection.command(`EHLO ${clientName}`, [250])
    let caps = parseCapabilities(ehlo.lines)

    if (!secure && caps.has('STARTTLS')) {
      await connection.command('STARTTLS', [220])
      connection.detach()
      const upgraded = tls.connect({
        socket: connection.socket,
        servername: host,
        rejectUnauthorized,
      })
      upgraded.setNoDelay(true)
      const timer = setTimeout(() => upgraded.destroy(new Error('STARTTLS 握手超时')), timeoutMs)
      try {
        await once(upgraded, 'secureConnect')
      } finally {
        clearTimeout(timer)
      }
      connection = new SmtpConnection(upgraded, { timeoutMs, onTrace })
      ehlo = await connection.command(`EHLO ${clientName}`, [250])
      caps = parseCapabilities(ehlo.lines)
    } else if (!secure && !caps.has('STARTTLS')) {
      // 服务器不支持 STARTTLS：明文继续会让授权码裸奔，除非用户明确允许。
      if (!allowInsecure) {
        throw new Error(`服务器 ${host}:${port} 不支持 STARTTLS，拒绝在明文连接上发送账号信息（确实要发就设 smtp.allowInsecure=true）`)
      }
    }

    if (user) {
      const advertised = String(caps.get('AUTH') ?? '')
      if (/LOGIN/i.test(advertised) || advertised === '') {
        await connection.command('AUTH LOGIN', [334])
        await connection.command(Buffer.from(user, 'utf8').toString('base64'), [334], true)
        await connection.command(Buffer.from(String(pass ?? ''), 'utf8').toString('base64'), [235], true)
      } else {
        const token = Buffer.from(`\u0000${user}\u0000${pass ?? ''}`, 'utf8').toString('base64')
        await connection.command(`AUTH PLAIN ${token}`, [235], true)
      }
    }

    await connection.command(`MAIL FROM:<${from}>`, [250])
    for (const recipient of recipients) await connection.command(`RCPT TO:<${recipient}>`, [250, 251])
    await connection.command('DATA', [354])

    const messageId = `${randomUUID()}@${host}`
    const message = buildMessage({
      from,
      fromName,
      to: recipients,
      subject,
      text,
      messageId,
      date: new Date(),
      headers,
    })
    await connection.writeRaw(`${message}${CRLF}.${CRLF}`)
    const accepted = await connection.read()
    if (accepted.code !== 250) {
      throw new SmtpError(explain(accepted.code, accepted.text), accepted.code, accepted.text)
    }

    try {
      await connection.command('QUIT', [221])
    } catch {
      // 邮件已经投递成功，QUIT 失败不影响结果。
    }
    return { messageId, accepted: recipients, response: accepted.text }
  } finally {
    connection.close()
  }
}
