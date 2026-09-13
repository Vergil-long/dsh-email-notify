/**
 * 找 DSH 桌面程序的 app.asar —— 供外壳补丁脚本与现场核验脚本共用。
 *
 * 不写死任何人的安装路径，按"越来越间接"的顺序试四种手段：
 *   1. `DSH_DESKTOP_ASAR` 环境变量（手动指定，永远优先）
 *   2. 常见安装目录（用户级 / Program Files）
 *   3. **当前进程的执行体位置**：插件宿主就跑在 DSH 里，能反推出安装目录
 *   4. 注册表的卸载项（`UninstallString` / `DisplayIcon`）
 *
 * 第 4 步要跑 `reg`，而 DSH 沙箱禁止用管道抓子进程输出，所以走 `captureSync`
 * （stdout 落临时文件）。早期版本用 `execFileSync` 直接抓、失败还被 `catch` 吞掉，
 * 于是在会话里跑必然"找不到 app.asar" —— 只有双击 `.cmd`（沙箱外）才找得到，
 * 这正是"脚本说找不到 app.asar，得手动加 --asar"那个现象的根因。
 *
 * 全都失败就返回 null，由调用方提示手动指定。
 */
import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { captureSync } from './exec-capture.mjs'

/**
 * @returns {string|null} app.asar 的绝对路径。
 */
export function findAsar() {
  const explicit = (process.env.DSH_DESKTOP_ASAR || '').trim()
  if (explicit && existsSync(explicit)) return explicit

  const candidates = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeekHarness', 'resources', 'app.asar'),
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'DeepSeekHarness', 'resources', 'app.asar'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'DeepSeekHarness', 'resources', 'app.asar'),
  ].filter(Boolean)
  for (const candidate of candidates) if (existsSync(candidate)) return candidate

  const fromRuntime = fromRunningRuntime()
  if (fromRuntime) return fromRuntime

  return fromRegistry()
}

/**
 * 从当前进程的执行体位置反推 app.asar（纯函数，便于测试）。
 *
 * 插件宿主就跑在 DSH 里，它的 `process.execPath` 形如
 * `<安装目录>\resources\node\node.exe`，于是 `<安装目录>\resources\app.asar`
 * 就是外壳的 asar —— 不用碰注册表，沙箱里也照样成立。
 *
 * 只在路径长得**确实像** Electron 的资源目录时才认：必须是绝对路径，且往上两级
 * 的目录名得叫 `resources`。否则返回 null —— 宁可返回 null 让调用方手动指定，
 * 也不猜一个可能存在的路径出来。
 *
 * @param {string} execPath - 通常传 `process.execPath`。
 * @returns {string|null} app.asar 路径（不保证存在，调用方自行 existsSync）。
 */
export function deriveAsarFromExecPath(execPath) {
  const value = String(execPath ?? '').trim()
  if (!value || !isAbsolute(value)) return null
  const resourcesDir = dirname(dirname(value))
  if (basename(resourcesDir).toLowerCase() !== 'resources') return null
  return join(resourcesDir, 'app.asar')
}

/**
 * 从 `reg query ... /s /f DeepSeekHarness` 的输出里推出 app.asar 路径（纯函数，便于测试）。
 *
 * 真实输出形如：
 *     DisplayName    REG_SZ    DeepSeekHarness 2.1.0
 *     UninstallString    REG_SZ    "D:\Download\DeepSeekHarness\Uninstall DeepSeekHarness.exe" /allusers
 *     DisplayIcon    REG_SZ    D:\Download\DeepSeekHarness\uninstallerIcon.ico
 *
 * @param {string} text - reg 的输出。
 * @returns {string|null} 推导出的 app.asar 路径（不保证存在，调用方自行 existsSync）。
 */
export function parseRegistryOutput(text) {
  const match = /(?:UninstallString|DisplayIcon)\s+REG_SZ\s+"?([^"\r\n]+)"?/.exec(String(text ?? ''))
  if (!match) return null
  const exePath = match[1].trim()
  if (!exePath) return null
  return join(dirname(exePath), 'resources', 'app.asar')
}

/** 第 3 步：按当前进程的执行体位置推。 */
function fromRunningRuntime() {
  const candidate = deriveAsarFromExecPath(process.execPath)
  return candidate && existsSync(candidate) ? candidate : null
}

/** 第 4 步：从注册表的卸载项推断。 */
function fromRegistry() {
  const roots = [
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]
  for (const root of roots) {
    // captureSync 不抛异常：`reg query` 没匹配到会以非零退出码 + "End of search" 收场，
    // 那属于正常情况，输出照样交给解析函数看。
    const result = captureSync('reg', ['query', root, '/s', '/f', 'DeepSeekHarness'])
    if (!result.text) continue
    const candidate = parseRegistryOutput(result.text)
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}
