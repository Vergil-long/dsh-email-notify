#!/usr/bin/env node
/**
 * 真实网络握手探测：连上真实 SMTP 服务器走一遍 TLS + EHLO（不做认证、不发信），
 * 用来区分「配置写错了」和「网络/端口不通」。
 *
 *   node test/live-probe.mjs                      # 默认探测 smtp.qq.com:465
 *   node test/live-probe.mjs smtp.163.com 465
 *
 * 预期结果：收到 530 / 550 之类的「需要认证」应答 —— 这恰好证明 TLS、EHLO
 * 与多行应答解析都正常，只是没带凭据而已。能看到中文提示就说明链路是通的。
 */
import { sendMail } from '../lib/smtp.js'

const host = process.argv[2] || 'smtp.qq.com'
const port = Number(process.argv[3] || 465)

console.log(`探测 ${host}:${port}（${port === 465 ? '隐式 TLS' : '明文 + STARTTLS'}）……`)
const lines = []
try {
  await sendMail({
    host,
    port,
    secure: port === 465,
    from: 'probe@example.com',
    to: 'probe@example.com',
    subject: 'probe',
    text: 'probe',
    timeoutMs: 15000,
    onTrace: (line) => lines.push(line),
  })
  console.log('意外成功（没带凭据却投递了？请检查服务器配置）')
} catch (error) {
  console.log('对话过程：')
  for (const line of lines) console.log(`  ${line}`)
  console.log(`\n结果：${error.message}`)
  const reachable = lines.some((line) => line.startsWith('S: 2'))
  console.log(reachable
    ? '✓ TLS 连接与 SMTP 对话正常 —— 网络与协议栈没问题。'
    : '✗ 没能建立有效对话：优先检查网络、代理、防火墙对该端口的放行。')
}
