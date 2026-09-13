/**
 * 测试用的假 SMTP 服务器：实现发信所需的最小对话，把收到的邮件记下来。
 * 只用于本地自检，不当真服务器用。
 */
import net from 'node:net'

/**
 * @param {object} [options]
 * @param {number} [options.port] - 0 = 由系统分配。
 * @param {string} [options.user] - 期望的账号；给了就校验。
 * @param {string} [options.pass] - 期望的授权码。
 * @param {boolean} [options.advertiseStartTls] - EHLO 里是否宣告 STARTTLS。
 * @param {boolean} [options.advertisePlain] - AUTH 里是否只宣告 PLAIN。
 * @param {string} [options.dataResponse] - DATA 结束后的应答码（默认 250，可设 554 测失败路径）。
 */
export function startMockSmtp(options = {}) {
  const {
    port = 0,
    user = null,
    pass = null,
    advertiseStartTls = false,
    advertisePlain = false,
    dataResponse = '250 2.0.0 Ok: queued',
  } = options

  const messages = []
  const transcript = []

  const server = net.createServer((socket) => {
    let buffer = ''
    let mode = 'command'
    let dataLines = []
    let expecting = null
    let authUser = null

    const send = (line) => {
      transcript.push(`S: ${line}`)
      socket.write(`${line}\r\n`)
    }

    send('220 mock.dsh.local ESMTP ready')

    const handleCommand = (line) => {
      transcript.push(`C: ${line}`)
      const upper = line.toUpperCase()
      if (expecting === 'user') {
        authUser = Buffer.from(line, 'base64').toString('utf8')
        expecting = 'pass'
        return send('334 UGFzc3dvcmQ6')
      }
      if (expecting === 'pass') {
        const secret = Buffer.from(line, 'base64').toString('utf8')
        expecting = null
        if (user !== null && (authUser !== user || secret !== pass)) return send('535 5.7.8 Authentication credentials invalid')
        return send('235 2.7.0 Authentication successful')
      }
      if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
        send('250-mock.dsh.local greets you')
        send(`250-AUTH ${advertisePlain ? 'PLAIN' : 'LOGIN PLAIN'}`)
        send('250-SIZE 35882577')
        if (advertiseStartTls) send('250-STARTTLS')
        send('250 8BITMIME')
        return
      }
      if (upper.startsWith('AUTH LOGIN')) {
        expecting = 'user'
        return send('334 VXNlcm5hbWU6')
      }
      if (upper.startsWith('AUTH PLAIN')) {
        const token = line.slice('AUTH PLAIN'.length).trim()
        const [, plainUser, plainPass] = Buffer.from(token, 'base64').toString('utf8').split('\u0000')
        if (user !== null && (plainUser !== user || plainPass !== pass)) return send('535 5.7.8 Authentication credentials invalid')
        return send('235 2.7.0 Authentication successful')
      }
      if (upper.startsWith('MAIL FROM')) return send('250 2.1.0 Ok')
      if (upper.startsWith('RCPT TO')) return send('250 2.1.5 Ok')
      if (upper === 'DATA') {
        mode = 'data'
        dataLines = []
        return send('354 End data with <CR><LF>.<CR><LF>')
      }
      if (upper === 'QUIT') {
        send('221 2.0.0 Bye')
        return socket.end()
      }
      return send('502 5.5.2 Command not implemented')
    }

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const end = buffer.indexOf('\r\n')
        if (end < 0) break
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (mode === 'data') {
          if (line === '.') {
            mode = 'command'
            messages.push(dataLines.join('\r\n'))
            send(dataResponse)
            continue
          }
          dataLines.push(line)
          continue
        }
        handleCommand(line)
      }
    })
    socket.on('error', () => { /* 客户端提前断开，忽略 */ })
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        messages,
        transcript,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

/** 把一封原始邮件拆成 { headers: Map, body(解码后的正文) }。 */
export function parseMessage(raw) {
  const split = raw.indexOf('\r\n\r\n')
  const headerText = split < 0 ? raw : raw.slice(0, split)
  const bodyText = split < 0 ? '' : raw.slice(split + 4)
  const headers = new Map()
  const unfolded = headerText.replace(/\r\n[ \t]+/g, ' ')
  for (const line of unfolded.split('\r\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    headers.set(key, headers.has(key) ? `${headers.get(key)}, ${value}` : value)
  }
  const encoding = (headers.get('content-transfer-encoding') ?? '').toLowerCase()
  let body = bodyText
  if (encoding === 'base64') body = Buffer.from(bodyText.replace(/\r\n/g, ''), 'base64').toString('utf8')
  return { headers, body }
}

/** 解 RFC 2047 编码的头字段（中文主题）。 */
export function decodeHeader(value) {
  return String(value ?? '').replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_all, base64) => Buffer.from(base64, 'base64').toString('utf8'))
}
