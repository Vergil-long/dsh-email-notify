/**
 * 查询 DSH 桌面程序是否在运行 —— 供外壳补丁与一键更新脚本共用。
 *
 * 这里最要紧的一点：**"查不到"不等于"没在运行"**。
 * Node 的 spawnSync 在遇到 EPERM / 拒绝访问时不会抛异常，而是把错误放进返回值的
 * `error` 字段、stdout 留空。如果据此判定"没在运行"，就会去写一个被占用的
 * app.asar —— 那是 fail-open，正是必须避免的方向。
 *
 * 所以这里返回三态：知道在跑 / 知道没在跑 / 查不出来（由调用方决定怎么办，
 * 但调用方应当把"查不出来"当成不安全来处理）。
 */
import { spawnSync } from 'node:child_process'

/**
 * @returns {{known: boolean, running: boolean, detail: string}}
 *   known=false 表示两种手段都没能给出可信结论。
 */
export function desktopProcessState() {
  const attempts = [
    {
      name: 'tasklist',
      run: () => spawnSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeekHarness.exe', '/NH'], { encoding: 'utf8', windowsHide: true }),
      match: (text) => {
        if (/DeepSeekHarness\.exe/i.test(text)) return true
        // 本地化的"没有匹配任务"提示；英文/中文两种都认。
        if (/no tasks|没有运行的任务|No tasks are running/i.test(text)) return false
        return null
      },
    },
    {
      name: 'powershell',
      run: () => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '(@(Get-Process -Name DeepSeekHarness -ErrorAction SilentlyContinue)).Count'], { encoding: 'utf8', windowsHide: true }),
      match: (text) => {
        const trimmed = text.trim()
        if (!/^\d+$/.test(trimmed)) return null
        return Number(trimmed) > 0
      },
    },
  ]

  const problems = []
  for (const attempt of attempts) {
    let result
    try {
      result = attempt.run()
    } catch (error) {
      problems.push(`${attempt.name}: ${error.message}`)
      continue
    }
    if (result.error || result.status !== 0) {
      problems.push(`${attempt.name}: ${result.error?.code ?? `exit ${result.status}`}`)
      continue
    }
    const verdict = attempt.match(String(result.stdout ?? ''))
    if (verdict === null) {
      problems.push(`${attempt.name}: 输出无法判断`)
      continue
    }
    return { known: true, running: verdict, detail: attempt.name }
  }
  return { known: false, running: false, detail: problems.join('; ') || '没有可用的查询手段' }
}

/** 给人看的一句话结论。 */
export function describeProcessState(state) {
  if (!state.known) return `无法确认 DSH 是否在运行（${state.detail}）`
  return state.running ? `检测到 DSH 正在运行（${state.detail}）` : `DSH 未在运行（${state.detail}）`
}
