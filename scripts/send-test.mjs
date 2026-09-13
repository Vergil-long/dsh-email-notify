#!/usr/bin/env node
/**
 * 独立发信自检：不需要 DSH 在运行，直接读配置文件并走一遍 SMTP。
 *
 *   node scripts/send-test.mjs           # 真发一封测试邮件
 *   node scripts/send-test.mjs --trace   # 附带完整 SMTP 对话（排查用，凭据已隐藏）
 *   node scripts/send-test.mjs --check   # 只看配置是否填全，不联网
 */
import { configPath, describeReadiness, loadConfig } from '../lib/config.js'
import { sendMail } from '../lib/smtp.js'

const args = new Set(process.argv.slice(2))
const trace = args.has('--trace')
const checkOnly = args.has('--check')

const loaded = loadConfig(true)
const ready = describeReadiness(loaded.value)

console.log(`配置文件：${loaded.path}`)
if (loaded.error) console.log(`配置问题：${loaded.error}`)
if (loaded.created) {
  console.log('（刚刚生成了配置模板，请先填好 smtp.user / smtp.pass / to 再跑一次）')
}

if (!ready.ready) {
  console.log(`✗ 配置未完成，缺：${ready.missing.join(', ')}`)
  console.log('  QQ 邮箱：设置 → 账户 → 开启「IMAP/SMTP 服务」→ 生成授权码，把它填进 smtp.pass。')
  process.exit(1)
}

const { smtp } = loaded.value
console.log(`✓ 配置完整：${ready.from} → ${ready.recipients.join(', ')}（${smtp.host}:${smtp.port}${smtp.secure ? ' TLS' : ' STARTTLS'}）`)

if (checkOnly) process.exit(0)

const started = Date.now()
try {
  const result = await sendMail({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    rejectUnauthorized: smtp.rejectUnauthorized !== false,
    allowInsecure: smtp.allowInsecure === true,
    user: smtp.user,
    pass: smtp.pass,
    from: ready.from,
    fromName: smtp.fromName,
    to: ready.recipients,
    subject: `${loaded.value.subjectPrefix ? `${loaded.value.subjectPrefix} ` : ''}测试邮件 · dsh-email-notify`,
    text: [
      '这是一封来自 dsh-email-notify 的测试邮件。',
      '',
      '收到它说明 SMTP 配置可用；之后当 harness 窗口不在前台时，',
      '任务完成或需要授权都会发到这些地址。',
      '',
      `时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      `配置：${configPath()}`,
    ].join('\n'),
    onTrace: trace ? (line) => console.log(`  ${line}`) : undefined,
  })
  console.log(`✓ 已投递（${Date.now() - started}ms）messageId=${result.messageId}`)
  console.log(`  收件人：${result.accepted.join(', ')}`)
} catch (error) {
  console.log(`✗ 发送失败（${Date.now() - started}ms）：${error.message}`)
  process.exit(1)
}
