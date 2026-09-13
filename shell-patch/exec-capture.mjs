/**
 * 抓子进程输出，但不走管道 —— 供外壳补丁脚本、现场核验脚本、进程查询共用。
 *
 * 为什么要这么绕：DSH 自身的文件沙箱**禁止程序打开管道**，而 Node 的
 * `execFileSync` / `spawnSync` 抓 stdout 用的正是管道。于是在会话里跑这些脚本时，
 * 子进程一律以 EPERM 失败、stdout 一个字都拿不到 —— 而调用方往往把这种失败
 * 当成"没查到"（甚至更糟：当成"没在运行"）。
 *
 * 对策：把子进程的 stdout / stderr 接到**临时文件**而不是管道。文件不受这条限制，
 * 于是同一份脚本在沙箱内（AI 帮你跑）和沙箱外（你双击 .cmd）行为一致。
 *
 * 顺带修一个中文环境的隐患：Windows 控制台程序按控制台代码页输出（简体中文是 GBK），
 * 直接按 UTF-8 解码会把中文变成 U+FFFD，于是"按中文文案写的判断"永远不成立。
 * 这里统一做"先 UTF-8、出现乱码再退 GBK"的解码。
 *
 * 注意：临时文件用完即删，不留在磁盘上；文件名带 pid 与序号，避免并发互相覆盖。
 */
import { execFileSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 同一进程内的文件序号，避免并发调用撞名。 */
let sequence = 0

/**
 * 解码 Windows 控制台程序的输出。
 *
 * 纯函数，便于测试。策略：先按 UTF-8 解；只有在出现替换字符（U+FFFD，说明原本不是
 * UTF-8）时才改用 GBK 重解。这样纯 ASCII 与真正的 UTF-8 输出都原样保留，
 * 只有 GBK 中文才会走兜底。
 *
 * @param {Buffer|string} input - 子进程输出的原始字节（或已经是字符串）。
 * @returns {string} 解码后的文本。
 */
export function decodeConsoleOutput(input) {
  if (typeof input === 'string') return input
  const utf8 = input.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    const gbk = new TextDecoder('gbk').decode(input)
    if (!gbk.includes('\uFFFD')) return gbk
  } catch {
    // 运行时不带 GBK 解码器（缺 full-icu）就维持 UTF-8 的结果。
  }
  return utf8
}

/**
 * 同步跑一个命令并拿回它的输出（不经过管道）。
 *
 * 与 `execFileSync` 的差别：**非零退出不抛异常**，而是把结果如实交回调用方判断 ——
 * 有些查询工具（如 `reg query` 没匹配到）会用非零退出码表示"没找到"，输出仍然有效。
 *
 * @param {string} command - 可执行文件名或路径。
 * @param {string[]} [args] - 参数。
 * @param {{timeout?: number}} [options] - `timeout` 毫秒，默认 15 秒。
 * @returns {{ok: boolean, status: number|null, text: string, stderr: string, error: string|null}}
 *   `ok` 表示进程正常退出；`text` 是 stdout；`stderr` 用于解释失败原因
 *   （例如沙箱拒绝 `tasklist` 时会给出 `Access denied`）。
 */
export function captureSync(command, args = [], options = {}) {
  const tag = `dsh-capture-${process.pid}-${(sequence += 1)}`
  const outFile = join(tmpdir(), `${tag}.out.txt`)
  const errFile = join(tmpdir(), `${tag}.err.txt`)
  let outFd = null
  let errFd = null

  const readText = (file) => {
    try {
      return decodeConsoleOutput(readFileSync(file))
    } catch {
      return ''
    }
  }

  try {
    outFd = openSync(outFile, 'w')
    errFd = openSync(errFile, 'w')
    execFileSync(command, args, {
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
      timeout: options.timeout ?? 15_000,
    })
    return { ok: true, status: 0, text: readText(outFile), stderr: readText(errFile), error: null }
  } catch (error) {
    return {
      ok: false,
      status: typeof error?.status === 'number' ? error.status : null,
      text: readText(outFile),
      stderr: readText(errFile),
      error: error?.code ?? error?.message ?? 'unknown',
    }
  } finally {
    for (const fd of [outFd, errFd]) {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          // 关闭失败无所谓，文件已经不再需要。
        }
      }
    }
    for (const file of [outFile, errFile]) {
      try {
        unlinkSync(file)
      } catch {
        // 删不掉就留给系统清理临时目录，不影响结果。
      }
    }
  }
}
