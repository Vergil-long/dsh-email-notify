/**
 * SMTP 客户端自检：对着本地假服务器跑完整对话，验证命令顺序、认证、
 * 多行应答解析、MIME 组装（中文主题 + base64 正文）与错误提示。
 *
 *   node test/smtp.test.mjs
 */
import assert from 'node:assert/strict'
import { sendMail } from '../lib/smtp.js'
import { decodeHeader, parseMessage, startMockSmtp } from './mock-smtp.mjs'

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

await test('明文（显式允许）完成一次投递，中文主题与正文正确解码', async () => {
  const server = await startMockSmtp({ user: 'me@qq.com', pass: 'authcode' })
  try {
    const result = await sendMail({
      host: '127.0.0.1',
      port: server.port,
      secure: false,
      allowInsecure: true,
      user: 'me@qq.com',
      pass: 'authcode',
      from: 'me@qq.com',
      fromName: 'DeepSeek Harness',
      to: ['a@example.com', 'b@example.com'],
      subject: '[DSH] ✅ 任务完成 · 修复通知误报',
      text: '第一行\n第二行：中文与 emoji 🎉\n.点开头的一行也要安全',
    })

    assert.equal(server.messages.length, 1, '应当只投递一封')
    const { headers, body } = parseMessage(server.messages[0])
    assert.equal(decodeHeader(headers.get('subject')), '[DSH] ✅ 任务完成 · 修复通知误报')
    assert.equal(headers.get('to'), 'a@example.com, b@example.com')
    assert.match(headers.get('from'), /me@qq\.com/)
    assert.equal(headers.get('content-type'), 'text/plain; charset=UTF-8')
    assert.equal(headers.get('content-transfer-encoding'), 'base64')
    assert.match(headers.get('message-id'), /^<.+@127\.0\.0\.1>$/)
    assert.equal(body, '第一行\n第二行：中文与 emoji 🎉\n.点开头的一行也要安全')
    assert.deepEqual(result.accepted, ['a@example.com', 'b@example.com'])

    // 命令顺序 + AUTH LOGIN 的凭据确实发出去了（且原文里不含明文授权码）
    const commands = server.transcript.filter((line) => line.startsWith('C: ')).map((line) => line.slice(3))
    assert.equal(commands[0].startsWith('EHLO '), true)
    assert.deepEqual(commands.slice(1, 4), ['AUTH LOGIN', Buffer.from('me@qq.com').toString('base64'), Buffer.from('authcode').toString('base64')])
    assert.equal(commands[4], 'MAIL FROM:<me@qq.com>')
    assert.deepEqual(commands.slice(5, 7), ['RCPT TO:<a@example.com>', 'RCPT TO:<b@example.com>'])
    assert.equal(commands[7], 'DATA')
    assert.equal(commands.at(-1), 'QUIT')
    assert.equal(server.transcript.some((line) => line.includes('authcode')), false, '授权码不应出现在明文命令里')
  } finally {
    await server.close()
  }
})

await test('AUTH PLAIN 分支可用（服务器只宣告 PLAIN 时）', async () => {
  const server = await startMockSmtp({ user: 'me@qq.com', pass: 'pw', advertisePlain: true })
  try {
    await sendMail({
      host: '127.0.0.1',
      port: server.port,
      secure: false,
      allowInsecure: true,
      user: 'me@qq.com',
      pass: 'pw',
      from: 'me@qq.com',
      to: 'me@qq.com',
      subject: 'plain',
      text: 'ok',
    })
    assert.equal(server.messages.length, 1)
    assert.equal(server.transcript.some((line) => line.includes('C: AUTH PLAIN ')), true)
  } finally {
    await server.close()
  }
})

await test('认证失败时给出中文可读的提示（而不是裸 535）', async () => {
  const server = await startMockSmtp({ user: 'me@qq.com', pass: 'right' })
  try {
    await assert.rejects(
      () => sendMail({
        host: '127.0.0.1',
        port: server.port,
        secure: false,
        allowInsecure: true,
        user: 'me@qq.com',
        pass: 'wrong',
        from: 'me@qq.com',
        to: 'me@qq.com',
        subject: 'x',
        text: 'x',
      }),
      (error) => {
        assert.equal(error.code, 535)
        assert.match(error.message, /授权码/)
        return true
      },
    )
    assert.equal(server.messages.length, 0, '认证失败不应投递')
  } finally {
    await server.close()
  }
})

await test('默认拒绝没有 STARTTLS 的明文服务器（保护授权码）', async () => {
  const server = await startMockSmtp({ user: 'me@qq.com', pass: 'pw' })
  try {
    await assert.rejects(
      () => sendMail({
        host: '127.0.0.1',
        port: server.port,
        secure: false,
        user: 'me@qq.com',
        pass: 'pw',
        from: 'me@qq.com',
        to: 'me@qq.com',
        subject: 'x',
        text: 'x',
      }),
      /不支持 STARTTLS/,
    )
  } finally {
    await server.close()
  }
})

await test('DATA 阶段被拒（554）时报错并带上服务器应答', async () => {
  const server = await startMockSmtp({ user: 'me@qq.com', pass: 'pw', dataResponse: '554 5.7.1 Message rejected as spam' })
  try {
    await assert.rejects(
      () => sendMail({
        host: '127.0.0.1',
        port: server.port,
        secure: false,
        allowInsecure: true,
        user: 'me@qq.com',
        pass: 'pw',
        from: 'me@qq.com',
        to: 'me@qq.com',
        subject: 'x',
        text: 'x',
      }),
      /554/,
    )
  } finally {
    await server.close()
  }
})

await test('缺少必填项时立即报错，不发起连接', async () => {
  await assert.rejects(() => sendMail({ host: '127.0.0.1', from: 'a@b.c', to: [], subject: 's', text: 't' }), /收件人/)
  await assert.rejects(() => sendMail({ host: '127.0.0.1', to: 'a@b.c', subject: 's', text: 't' }), /发件人/)
  await assert.rejects(() => sendMail({ from: 'a@b.c', to: 'a@b.c', subject: 's', text: 't' }), /SMTP 主机/)
})

await test('单个收件人写成字符串也能用', async () => {
  const server = await startMockSmtp({})
  try {
    const result = await sendMail({
      host: '127.0.0.1',
      port: server.port,
      secure: false,
      allowInsecure: true,
      from: 'me@qq.com',
      to: 'solo@example.com',
      subject: 's',
      text: 't',
    })
    assert.deepEqual(result.accepted, ['solo@example.com'])
  } finally {
    await server.close()
  }
})

console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
