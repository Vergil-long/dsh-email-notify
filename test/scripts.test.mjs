/**
 * 脚本层纯函数自检：把"只能靠真实环境才能跑"的判断逻辑拆出来单测。
 *
 * 起因：app.asar 的自动定位要先查环境变量/常见目录，再查注册表；而注册表查询
 * 需要捕获子进程输出，在受限环境里会被拒（EPERM），于是这条路径在沙箱内**跑不了**。
 * 把解析部分做成纯函数后，就能拿真实采集到的 reg 输出来验证它。
 *
 *   node test/scripts.test.mjs
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { parseRegistryOutput } from '../shell-patch/locate-asar.mjs'

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

console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
