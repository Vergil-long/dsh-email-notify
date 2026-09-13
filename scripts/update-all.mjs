#!/usr/bin/env node
/**
 * 一键更新：把工作区的插件代码同步到 DSH，并打上桌面外壳的误报通知补丁。
 *
 *   node scripts/update-all.mjs            # 两步都做（外壳补丁要求 DSH 已退出）
 *   node scripts/update-all.mjs --plugin   # 只同步插件代码
 *   node scripts/update-all.mjs --shell    # 只打外壳补丁
 *   node scripts/update-all.mjs --dry      # 只打印将要做什么
 *
 * 为什么要有这个脚本：以前要按顺序跑两个脚本（先同步插件、再打外壳补丁），
 * 少跑一个就会出现"设置页里看不到面板"或"任务开始还是乱弹通知"这类半吊子状态。
 *
 * 顺序固定为「先插件、后外壳」，因为外壳补丁需要 DSH 完全退出（app.asar 被占用时
 * 硬写会写坏程序），而插件同步不需要——如果你还开着 DSH，脚本会把插件部分做完，
 * 然后明确告诉你"关掉 DSH 后再跑一次 --shell"。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describeProcessState, desktopProcessState } from '../shell-patch/dsh-process.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry')
const onlyPlugin = args.has('--plugin')
const onlyShell = args.has('--shell')
const force = args.has('--force')

const say = (message) => console.log(message)

/** 跑一个子脚本，输出直接透到终端；返回是否成功。 */
function run(script, extra = []) {
  const path = join(root, script)
  if (!existsSync(path)) {
    say(`✗ 找不到 ${path}`)
    return false
  }
  say(`\n──── 运行 ${script} ${extra.join(' ')} ────`)
  const result = spawnSync(process.execPath, [path, ...extra], { stdio: 'inherit', cwd: root })
  return result.status === 0
}

say('=== dsh-email-notify 一键更新 ===')
const state = desktopProcessState()
say(`· ${describeProcessState(state)}`)
if (state.known && state.running) {
  say('  插件代码可以同步；但外壳补丁要等 DSH 退出（app.asar 被占用时写入会失败）。')
} else if (!state.known) {
  say('  为了安全，本次不做外壳补丁（连"是否在运行"都确认不了时不去写 app.asar）。')
}

let ok = true

if (!onlyShell) {
  ok = run('scripts/install.mjs', dryRun ? ['--dry'] : []) && ok
}

if (!onlyPlugin) {
  const canPatchShell = force || (state.known && !state.running)
  if (!canPatchShell) {
    say('\n──── 跳过外壳补丁 ────')
    if (state.known && state.running) {
      say('  完全退出 DSH 后，再运行一次：')
      say(`    node "${join(root, 'scripts', 'update-all.mjs')}" --shell`)
      say('  或双击 shell-patch\\修复桌面误报通知.cmd')
    } else {
      say(`  原因：${describeProcessState(state)}`)
      say('  确认任务管理器里没有 DeepSeekHarness.exe 后，加 --force 重跑即可：')
      say(`    node "${join(root, 'scripts', 'update-all.mjs')}" --shell --force`)
    }
  } else {
    const extra = dryRun ? ['--dry'] : []
    if (force) extra.push('--force')
    ok = run(join('shell-patch', 'patch-completion-notify.mjs'), extra) && ok
  }
}

say('')
if (dryRun) {
  say('（--dry：以上只是预演，没有写入任何东西。去掉 --dry 即会真正执行。）')
} else if (ok) {
  say('=== 完成。接下来 ===')
  say('  1) 重新打开 DSH（若刚才没关过，现在关掉再开，插件与补丁才会生效）。')
  say('  2) 打开「设置 → 邮件通知」：确认账号/收件人还在（授权码显示"已设置"），')
  say('     点「发送测试邮件」应当马上收到一封。')
  say('  3) 验证误报已修：任务开始时不该再弹"任务已完成"；')
  say(`     量化验证：node "${join(root, 'tools', 'analyze-desktop-notifications.mjs')}"`)
  say('  4) 验证提问通知：让我向你提问一次，然后最小化窗口，等提问后应当收到邮件。')
} else {
  say('=== 有步骤失败，请看上面的输出 ===')
}

process.exit(ok ? 0 : 1)
