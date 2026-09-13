/**
 * 找 DSH 桌面程序的 app.asar —— 供外壳补丁脚本与现场核验脚本共用。
 *
 * 不写死任何人的安装路径：先看环境变量与常见安装目录，再从注册表的卸载项
 * （UninstallString / DisplayIcon）推断安装目录。找不到就返回 null，
 * 由调用方提示用 --asar <路径> 手动指定。
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

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

  return fromRegistry()
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

/** 从注册表的卸载项推断。 */
function fromRegistry() {
  const roots = [
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]
  for (const root of roots) {
    let output = ''
    try {
      output = execFileSync('reg', ['query', root, '/s', '/f', 'DeepSeekHarness'], { encoding: 'utf8', windowsHide: true })
    } catch {
      continue
    }
    const candidate = parseRegistryOutput(output)
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}
