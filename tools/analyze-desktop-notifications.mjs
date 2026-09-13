/**
 * 诊断工具：证明桌面外壳的「任务完成」通知大多是误报。
 *
 * 做法是把两边的**时间轴**对齐：
 *   - 外壳日志里的 `task completed`（每一条都对应一次弹窗，来自 %APPDATA%\dsh-desktop\dsh_desktop.log）
 *   - 会话日志里每个回合的 `turn/start` / `turn/end`（~/.dsh/sessions 下每会话一个
 *     session.jsonl.zstd）
 * 如果一条通知的时间落在某个回合**还没结束**的区间里，那它就是在任务还在跑的时候弹的误报。
 *
 * 用法：
 *   node tools/analyze-desktop-notifications.mjs
 *   node tools/analyze-desktop-notifications.mjs --sessions <目录> --log <日志文件>
 *   node tools/analyze-desktop-notifications.mjs --samples 30
 *
 * 只读，不改任何东西。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 会话日志的 zstd 帧魔数（一个文件里有多个帧，要逐帧解）。 */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function argOf(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const dshHome = (process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh')
const sessionsDir = argOf('sessions', join(dshHome, 'sessions'))
const logFile = argOf('log', join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'dsh-desktop', 'dsh_desktop.log'))
const sampleLimit = Number(argOf('samples', 12))

/** 逐帧解压 zstd（会话日志是分片追加写的，一次 zstdDecompressSync 只出第一帧）。 */
function readFrames(buffer) {
  const parts = []
  let cursor = 0
  while (cursor < buffer.length) {
    const index = buffer.indexOf(MAGIC, cursor)
    if (index < 0) break
    try {
      parts.push(zstdDecompressSync(buffer.subarray(index)))
    } catch {
      // 末尾可能是写了一半的帧，忽略
    }
    cursor = index + 4
  }
  return Buffer.concat(parts).toString('utf8')
}

/** 遍历 ~/.dsh/sessions/<工作区>/<会话>/session.jsonl.zstd。 */
function* sessionLogs(dir) {
  if (!existsSync(dir)) return
  for (const workspace of readdirSync(dir)) {
    const workspacePath = join(dir, workspace)
    if (!statSync(workspacePath).isDirectory()) continue
    for (const session of readdirSync(workspacePath)) {
      const sessionPath = join(workspacePath, session)
      if (!statSync(sessionPath).isDirectory()) continue
      const file = join(sessionPath, 'session.jsonl.zstd')
      if (existsSync(file)) yield file
    }
  }
}

/* ── 收集真实回合区间 ─────────────────────────────────────────── */

const turns = []
for (const file of sessionLogs(sessionsDir)) {
  let text
  try {
    text = readFrames(readFileSync(file))
  } catch {
    continue
  }
  let open = null
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!Number.isFinite(event.time)) continue
    if (event.type === 'turn/start') open = { start: event.time, end: null }
    else if (event.type === 'turn/end') {
      if (open) {
        open.end = event.time
        turns.push(open)
        open = null
      }
    }
  }
  if (open) turns.push(open) // 还没结束的回合
}

/* ── 收集外壳弹过的通知 ───────────────────────────────────────── */

const notified = []
if (existsSync(logFile)) {
  for (const line of readFileSync(logFile, 'utf8').split('\n')) {
    const match = /^\[(.+?)\] task completed$/.exec(line.trim())
    if (match) notified.push(Date.parse(match[1]))
  }
}

/* ── 对齐 ─────────────────────────────────────────────────────── */

const iso = (time) => new Date(time).toISOString()
const seconds = (ms) => `${Math.round(ms / 1000)}s`

console.log(`会话目录：${sessionsDir}`)
console.log(`外壳日志：${logFile}`)
console.log(`真实回合：${turns.length} 个（其中 ${turns.filter((t) => t.end !== null).length} 个已结束）`)
console.log(`外壳弹出的完成通知：${notified.length} 条`)
if (notified.length === 0) {
  console.log('\n没有可比对的通知记录。若确实收到过弹窗，检查 --log 是否指向 dsh_desktop.log。')
  process.exit(0)
}

let duringTurn = 0
let nearTurnEnd = 0
let unmatched = 0
const samples = []

for (const time of notified) {
  const running = turns.find((turn) => turn.end !== null && turn.start <= time && time < turn.end)
  if (running) {
    duringTurn += 1
    if (samples.length < sampleLimit) {
      samples.push(`通知 ${iso(time)} → 回合 ${iso(running.start)}..${iso(running.end)}（全程 ${seconds(running.end - running.start)}，提前 ${seconds(running.end - time)} 就报"完成"）`)
    }
    continue
  }
  if (turns.some((turn) => turn.end !== null && Math.abs(turn.end - time) < 60_000)) nearTurnEnd += 1
  else unmatched += 1
}

if (samples.length > 0) {
  console.log('\n样例（通知时间 vs 真实回合区间）：')
  for (const line of samples) console.log(`  ${line}`)
}

const percent = ((duringTurn / notified.length) * 100).toFixed(0)
console.log('\n结论：')
console.log(`  在回合还没结束时弹出的：${duringTurn} / ${notified.length}（${percent}%）← 误报`)
console.log(`  接近真实 turn/end 的：  ${nearTurnEnd}`)
console.log(`  对不上任何回合的：      ${unmatched}`)
console.log('\n成因：外壳靠扫描左侧会话列表的 DOM 文本判断完成，标题/状态文字一变，')
console.log('旧 key 就"消失"，而它消失前的状态是 running，于是被当成"任务完成"。')
console.log('修法见 dsh-email-notify 仓库 README 的说明（把状态表改成按稳定 id 建键）。')
