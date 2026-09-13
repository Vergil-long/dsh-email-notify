/**
 * 查询 DSH 桌面程序是否在运行 —— 供外壳补丁与一键更新脚本共用。
 *
 * 这里最要紧的一点：**"查不到"不等于"没在运行"**。
 * 查询失败时绝不能得出"没在运行"的结论，否则就会去写一个被占用的 app.asar
 * —— 那是 fail-open，正是必须避免的方向。
 *
 * 所以这里返回三态：知道在跑 / 知道没在跑 / 查不出来（由调用方决定怎么办，
 * 但调用方应当把"查不出来"当成不安全来处理）。
 *
 * 两个实现细节（都踩过）：
 *   1. 子进程输出走 `captureSync`（落临时文件）而不是管道 —— DSH 沙箱禁止管道，
 *      用管道时两个手段都会以 EPERM 失败，于是永远"查不出来"。
 *   2. `tasklist` 在 DSH 沙箱里会被**直接拒绝**（`Access denied`），拿不到输出；
 *      所以 `Get-Process` 这条兜底不是可有可无的，它才是沙箱内真正管用的那个。
 */
import { captureSync } from './exec-capture.mjs'

/**
 * @returns {{known: boolean, running: boolean, detail: string}}
 *   known=false 表示两种手段都没能给出可信结论。
 */
export function desktopProcessState() {
  const attempts = [
    {
      name: 'tasklist',
      run: () => captureSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeekHarness.exe', '/NH']),
      match: (text) => {
        if (/DeepSeekHarness\.exe/i.test(text)) return true
        // 本地化的"没有匹配任务"提示；英文/中文两种都认。
        if (/no tasks|没有运行的任务|No tasks are running/i.test(text)) return false
        return null
      },
    },
    {
      name: 'powershell',
      run: () => captureSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '(@(Get-Process -Name DeepSeekHarness -ErrorAction SilentlyContinue)).Count']),
      match: (text) => {
        const trimmed = text.trim()
        if (!/^\d+$/.test(trimmed)) return null
        return Number(trimmed) > 0
      },
    },
  ]

  const problems = []
  for (const attempt of attempts) {
    const result = attempt.run()
    if (!result.ok) {
      problems.push(`${attempt.name}: ${describeFailure(result)}`)
      continue
    }
    const verdict = attempt.match(result.text)
    if (verdict === null) {
      problems.push(`${attempt.name}: 输出无法判断`)
      continue
    }
    return { known: true, running: verdict, detail: attempt.name }
  }
  return { known: false, running: false, detail: problems.join('; ') || '没有可用的查询手段' }
}

/**
 * 把一次失败的查询说清楚 —— 带上 stderr 的第一行。
 * 沙箱拒绝 `tasklist` 时那一行就是 `ERROR: Access denied`，比光看 `exit 1` 有用得多。
 */
function describeFailure(result) {
  const reason = result.error ?? `exit ${result.status}`
  const firstLine = String(result.stderr ?? '').trim().split(/\r?\n/)[0] ?? ''
  return firstLine ? `${reason}（${firstLine}）` : reason
}

/** 给人看的一句话结论。 */
export function describeProcessState(state) {
  if (!state.known) return `无法确认 DSH 是否在运行（${state.detail}）`
  return state.running ? `检测到 DSH 正在运行（${state.detail}）` : `DSH 未在运行（${state.detail}）`
}
