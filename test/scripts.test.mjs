/**
 * 脚本层自检：把"只能靠真实环境才能跑"的判断逻辑拆出来单测。
 *
 * 起因：app.asar 的自动定位要先查环境变量/常见目录，再查注册表；而注册表查询
 * 需要捕获子进程输出，在受限环境里会被拒（EPERM），于是这条路径在沙箱内**跑不了**。
 * 把解析部分做成纯函数后，就能拿真实采集到的 reg 输出来验证它。
 *
 * 2026-09-13 补：抓输出的方式从管道改成临时文件后，沙箱内也能跑了；这里再加两组
 * 回归测试守住那次修复 —— ① 中文控制台输出的 GBK 解码；② 从插件宿主的执行体位置
 * 反推 app.asar。所有"真实采集"的字节都标了来源，别凭记忆改。
 *
 *   node test/scripts.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveAsarFromExecPath, findAsar, parseRegistryOutput } from '../shell-patch/locate-asar.mjs'
import { decodeConsoleOutput } from '../shell-patch/exec-capture.mjs'

let failures = 0
function test(name, fn) {
  try {
    fn()
    console.log(`✓ ${name}`)
  } catch (error) {
    failures += 1
    console.log(`✗ ${name}\n   ${error.message}`)
  }
}

/** 本机真实采集到的 reg 输出片段（去掉键路径行，只留值行）。 */
const REAL_OUTPUT = [
  'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\1bf39983-50d0-5fe0-9ef4-cece76f67c5e',
  '    DisplayName    REG_SZ    DeepSeekHarness 2.1.0',
  '    UninstallString    REG_SZ    "D:\\Download\\DeepSeekHarness\\Uninstall DeepSeekHarness.exe" /allusers',
  '    QuietUninstallString    REG_SZ    "D:\\Download\\DeepSeekHarness\\Uninstall DeepSeekHarness.exe" /allusers /S',
  '    DisplayIcon    REG_SZ    D:\\Download\\DeepSeekHarness\\uninstallerIcon.ico',
  '',
].join('\r\n')

/**
 * 本机真实采集到的 GBK 字节：`tasklist /FI "IMAGENAME eq 不存在的进程" /NH` 的
 * "信息: 没有运行的任务匹配指定标准。"（用 PowerShell 的 Encoding(936) 生成并核对过）。
 * 注意它**不是**合法 UTF-8 —— 按 UTF-8 解会得到一串 U+FFFD。
 */
const REAL_GBK_NO_TASKS = Buffer.from(
  'd0c5cfa23a20c3bbd3d0d4cbd0d0b5c4c8cecef1c6a5c5e4d6b8b6a8b1ead7bca1a3',
  'hex',
)

test('从真实 reg 输出推出 app.asar 路径（带引号的 UninstallString，忽略后面的参数）', () => {
  assert.equal(parseRegistryOutput(REAL_OUTPUT), join('D:\\Download\\DeepSeekHarness', 'resources', 'app.asar'))
})

test('只有 DisplayIcon（无引号）时也能推出来', () => {
  const text = '    DisplayIcon    REG_SZ    C:\\Program Files\\DeepSeekHarness\\uninstallerIcon.ico'
  assert.equal(parseRegistryOutput(text), join('C:\\Program Files\\DeepSeekHarness', 'resources', 'app.asar'))
})

test('输出里没有可用值时返回 null（不要去猜）', () => {
  assert.equal(parseRegistryOutput(''), null)
  assert.equal(parseRegistryOutput('    DisplayName    REG_SZ    DeepSeekHarness 2.1.0'), null)
  assert.equal(parseRegistryOutput('    UninstallString    REG_SZ    '), null)
  assert.equal(parseRegistryOutput(undefined), null)
})

test('路径带空格时不会被截断', () => {
  const text = '    UninstallString    REG_SZ    "C:\\Program Files\\Some App\\Uninstall Some App.exe" /allusers'
  assert.equal(parseRegistryOutput(text), join('C:\\Program Files\\Some App', 'resources', 'app.asar'))
})

/* ── 从执行体位置反推（沙箱内也成立的那条兜底） ─────────────── */

test('插件宿主的 execPath 能反推出 app.asar（不碰注册表，沙箱里也管用）', () => {
  assert.equal(
    deriveAsarFromExecPath('D:\\Download\\DeepSeekHarness\\resources\\node\\node.exe'),
    join('D:\\Download\\DeepSeekHarness\\resources', 'app.asar'),
  )
  // 换成 dsh-runtime 目录（另一种可能的运行时布局）同样成立，因为都往上两级到 resources。
  assert.equal(
    deriveAsarFromExecPath('D:\\Download\\DeepSeekHarness\\resources\\dsh-runtime\\node.exe'),
    join('D:\\Download\\DeepSeekHarness\\resources', 'app.asar'),
  )
})

test('不像 Electron 资源目录的 execPath 一律返回 null（宁可手动指定也不瞎猜）', () => {
  // 本机系统 Node：往上两级是 D:\Download，目录名不是 resources。
  assert.equal(deriveAsarFromExecPath('D:\\Download\\node.js\\node.exe'), null)
  // 相对路径 / 空值。
  assert.equal(deriveAsarFromExecPath('node.exe'), null)
  assert.equal(deriveAsarFromExecPath(''), null)
  assert.equal(deriveAsarFromExecPath(undefined), null)
  // 只到 resources 一层（execPath 就是 resources\node.exe 时）。
  assert.equal(deriveAsarFromExecPath('C:\\x\\resources\\node.exe'), null)
})

/* ── 中文控制台输出（GBK）的解码 ─────────────────────────────── */

test('中文控制台的 GBK 输出能正确解码（否则"没有运行的任务"这条判断永远不成立）', () => {
  const text = decodeConsoleOutput(REAL_GBK_NO_TASKS)
  assert.equal(text, '信息: 没有运行的任务匹配指定标准。')
  assert.ok(!text.includes('\uFFFD'), '不应残留替换字符')
  // 这条正是 dsh-process.mjs 用来判断"没在运行"的中文分支。
  assert.ok(/没有运行的任务/.test(text))
})

test('UTF-8 与纯 ASCII 输出原样返回（别被 GBK 兜底改坏）', () => {
  assert.equal(decodeConsoleOutput(Buffer.from('DeepSeekHarness 2.1.0', 'utf8')), 'DeepSeekHarness 2.1.0')
  assert.equal(decodeConsoleOutput(Buffer.from('安装目录：D:\\程序', 'utf8')), '安装目录：D:\\程序')
  assert.equal(decodeConsoleOutput('已经是字符串'), '已经是字符串')
})

/* ── 定位入口本身 ───────────────────────────────────────────── */

test('DSH_DESKTOP_ASAR 环境变量优先（手动指定永远管用）', () => {
  const fake = join(tmpdir(), `fake-app-asar-${process.pid}.asar`)
  writeFileSync(fake, 'x')
  const previous = process.env.DSH_DESKTOP_ASAR
  process.env.DSH_DESKTOP_ASAR = fake
  try {
    assert.equal(findAsar(), fake)
  } finally {
    if (previous === undefined) delete process.env.DSH_DESKTOP_ASAR
    else process.env.DSH_DESKTOP_ASAR = previous
    try {
      unlinkSync(fake)
    } catch {
      // 临时文件删不掉不影响结论。
    }
  }
})

test('findAsar() 要么给出一条真实存在的路径，要么明确返回 null（不许返回幻觉路径）', () => {
  const found = findAsar()
  if (found === null) {
    console.log('   · 本机没找到（没装 DSH 或布局不常见）—— 用 --asar 手动指定即可')
    return
  }
  assert.ok(existsSync(found), `返回了不存在的路径：${found}`)
  console.log(`   · 本机自动定位到：${found}`)
})

console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
