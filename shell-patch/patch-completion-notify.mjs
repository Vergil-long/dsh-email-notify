/**
 * 修复 DSH 桌面外壳「任务一开始就弹完成通知」的误报。
 *
 * 问题：外壳的 main.js 里有个 injectTaskCompletionBridge()，它注入一段脚本扫描左侧
 * 会话列表的 DOM，用「稳定 id + 标题 + 同名序号」当 key 建状态表。会话标题在运行中一变，
 * 旧 key 就"消失"，而它消失前的状态是 running —— 于是被当成"任务完成"弹通知。
 * 用 tools/analyze-desktop-notifications.mjs 对齐外壳日志与会话日志实测：
 * 191 条通知里 163 条发生在回合还没结束的时候（很多是回合开始后 0.1~3 秒）。
 *
 * 本脚本把那段注入脚本换成「只按稳定行标识建键」的版本，并给"行消失"分支加两道保险：
 *   1) 扫不到任何一行（例如打开了设置页）时，绝不推断"正在跑的任务都结束了"；
 *   2) 只有当行元素真的从文档里消失、且已经跑够 RUNNING_MIN_MS 才算结束。
 *
 * 用法（改的是已安装的程序，改前请先完全退出 DSH）：
 *   node shell-patch/patch-completion-notify.mjs                 # 自动找 app.asar 并打补丁
 *   node shell-patch/patch-completion-notify.mjs --dry           # 只检查能不能打，不写盘
 *   node shell-patch/patch-completion-notify.mjs --revert        # 撤销补丁（按标记精确还原）
 *   node shell-patch/patch-completion-notify.mjs --asar <路径>   # 手动指定 app.asar
 *   node shell-patch/patch-completion-notify.mjs --keep-work     # 保留中间产物便于排查
 *   node shell-patch/patch-completion-notify.mjs --force         # 跳过"DSH 是否在运行"的确认
 *                                                                # （只在副本上演练、或查询被拒但你已确认退出时用）
 *
 * 安全措施：
 *   - DSH 正在运行就直接拒绝；**连"查不到进程"也拒绝**（fail-closed：
 *     spawnSync 遇到权限拒绝不会抛异常，若把"查不到"当成"没在运行"，
 *     就会去写被占用的 app.asar）。
 *   - 改完先做三重校验：整份 main.js 能通过语法检查、注入的那段脚本能单独通过语法检查、
 *     重新打包后除 main.js 外每个文件与原文件逐字节一致；校验不过就不替换。
 *   - 写完还要读回来核对；对不上就自动用备份还原并报错。
 *   - 原 app.asar 备份为同目录下的 app.asar.bak（只在不存在时创建，沿用"一个固定名字"的约定）。
 *   - 补丁是可逆的：--revert 按标记把那段函数原样换回来，不依赖备份。
 *
 * 注：下面两段函数文本用的是普通模板字符串，因此文中的反引号写成 \` 、正则里的
 * 双反斜杠写成 \\\\ —— 它们必须与 asar 里 main.js 的字节完全一致，否则脚本会拒绝动手。
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

import { ORIGINAL_FUNCTION, PATCHED_FUNCTION } from './bridge-snippets.mjs'
import { desktopProcessState } from './dsh-process.mjs'
import { findAsar } from './locate-asar.mjs'

const MARKER = 'dsh-email-notify stable-key fix'

/*
 * 两段函数文本放在 bridge-snippets.mjs 里，和自检脚本共用一份。
 * 它们按 LF 写；即便检出时被换成 CRLF（Windows 上的 autocrlf），
 * 这里统一归一化成 LF 再匹配，免得换行风格把匹配搞挂。
 */
const ORIGINAL_LF = ORIGINAL_FUNCTION.replace(/\r\n/g, '\n')
const PATCHED_LF = PATCHED_FUNCTION.replace(/\r\n/g, '\n')

/* ── asar 读写（格式与桌面项目里的 asar-tool.js 一致；自带一份以保持仓库自包含） ── */

const INTEGRITY_BLOCK = 4 * 1024 * 1024

function computeIntegrity(data) {
  const blocks = []
  for (let i = 0; i < data.length; i += INTEGRITY_BLOCK) {
    blocks.push(createHash('sha256').update(data.subarray(i, i + INTEGRITY_BLOCK)).digest('hex'))
  }
  return {
    algorithm: 'SHA256',
    hash: createHash('sha256').update(data).digest('hex'),
    blockSize: INTEGRITY_BLOCK,
    blocks,
  }
}

function parseAsar(buffer) {
  if (buffer.length < 16) throw new Error('文件太小，不像 asar')
  const headerBufferLength = buffer.readUInt32LE(4)
  const headerStart = 8
  const headerEnd = headerStart + headerBufferLength
  if (headerEnd > buffer.length) throw new Error('asar 头长度越界')
  const jsonLength = buffer.readUInt32LE(headerStart + 4)
  const jsonStart = headerStart + 8
  const jsonEnd = jsonStart + jsonLength
  if (jsonEnd > headerEnd) throw new Error('asar 头 JSON 长度越界')
  const header = JSON.parse(buffer.toString('utf8', jsonStart, jsonEnd))
  return { header, dataStart: Math.ceil(headerEnd / 4) * 4 }
}

function* walkEntries(header, prefix = '') {
  for (const name of Object.keys(header.files || {})) {
    const entry = header.files[name]
    const full = prefix ? prefix + '/' + name : name
    if (entry.files) yield* walkEntries(entry, full)
    else if (typeof entry.offset === 'string') yield { path: full, entry }
  }
}

/** 读出 asar 里每个文件的字节。 */
function readAll(buffer, header, dataStart) {
  const files = new Map()
  for (const { path, entry } of walkEntries(header)) {
    const offset = dataStart + parseInt(entry.offset, 10)
    files.set(path, buffer.subarray(offset, offset + entry.size))
  }
  return files
}

/** 按原 header 的树结构与顺序重新打包（文件数据连续排列，不插对齐填充）。 */
function repack(header, replacements) {
  const ordered = []
  const build = (node, prefix) => {
    if (node.files) {
      const files = {}
      for (const name of Object.keys(node.files)) {
        files[name] = build(node.files[name], prefix ? `${prefix}/${name}` : name)
      }
      return { files }
    }
    const data = replacements.get(prefix)
    if (data === undefined) throw new Error(`缺少文件内容：${prefix}`)
    ordered.push(data)
    return { size: data.length, integrity: computeIntegrity(data) }
  }
  const newHeader = build(header, '')

  let cursor = 0
  const assign = (node) => {
    if (node.files) {
      for (const name of Object.keys(node.files)) assign(node.files[name])
      return
    }
    const integrity = node.integrity
    delete node.integrity
    node.offset = String(cursor)
    node.integrity = integrity
    cursor += node.size
  }
  assign(newHeader)

  const jsonBuffer = Buffer.from(JSON.stringify(newHeader), 'utf8')
  const headerPickle = Buffer.alloc(8 + jsonBuffer.length)
  headerPickle.writeUInt32LE(4 + jsonBuffer.length, 0)
  headerPickle.writeUInt32LE(jsonBuffer.length, 4)
  jsonBuffer.copy(headerPickle, 8)

  const sizePickle = Buffer.alloc(8)
  sizePickle.writeUInt32LE(4, 0)
  sizePickle.writeUInt32LE(headerPickle.length, 4)

  const headerTotal = sizePickle.length + headerPickle.length
  const dataStart = Math.ceil(headerTotal / 4) * 4
  return Buffer.concat([sizePickle, headerPickle, Buffer.alloc(dataStart - headerTotal), ...ordered])
}

/* ── 工具函数 ────────────────────────────────────────────────── */

const say = (message) => console.log(message)

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

function argValue(name) {
  const index = process.argv.indexOf(`--${name}`)
  const value = index >= 0 ? process.argv[index + 1] : null
  return value && !value.startsWith('--') ? value : null
}

/** 定位 app.asar：显式 --asar 优先，其余交给共用的自动定位（环境变量→常见目录→注册表）。 */
function resolveAsar() {
  const explicit = argValue('asar')
  if (explicit) {
    const resolved = explicit.trim()
    if (!existsSync(resolved)) fail(`指定的 app.asar 不存在：${resolved}`)
    return resolved
  }
  const found = findAsar()
  if (found) return found
  fail([
    '找不到 app.asar。请用 --asar <路径> 指定，例如：',
    '  --asar "D:\\Download\\DeepSeekHarness\\resources\\app.asar"',
    '（自动定位会查 DSH_DESKTOP_ASAR 环境变量、常见安装目录，以及注册表卸载项；',
    '  若本进程不允许查询注册表，就只能手动指定。）',
  ].join('\n'))
}

/**
 * DSH 还开着？写入被占用的文件会写坏程序，所以直接拒绝。
 * 查不到进程时也拒绝（fail-closed），除非显式 --force。
 */
function assertDesktopClosed() {
  const force = process.argv.includes('--force') || process.argv.includes('--ignore-running')
  if (force) {
    say('· --force：跳过"DSH 是否在运行"的确认。请自行确保 DSH 已完全退出（否则写入会失败）。')
    return
  }
  const state = desktopProcessState()
  if (state.known && state.running) {
    fail('检测到 DeepSeekHarness.exe 还在运行。请先完全退出 DSH（任务管理器里确认没有残留），再运行本脚本。')
  }
  if (!state.known) {
    fail([
      `无法确认 DSH 是否已退出（${state.detail}）。`,
      '为了不写坏正在运行的程序，脚本在这里停下。请二选一：',
      '  ① 打开任务管理器确认没有 DeepSeekHarness.exe，然后加 --force 重跑；',
      '  ② 或者先解决"进程查询被拒绝"的问题再来。',
    ].join('\n  '))
  }
  say(`· 已确认 DSH 未在运行（${state.detail}）`)
}

/** 语法检查：编译整份 main.js，以及其中注入的那段脚本。 */
function assertSyntax(mainText) {
  try {
    new vm.Script(mainText)
  } catch (error) {
    fail(`打补丁后的 main.js 语法检查失败：${error.message}`)
  }
  const from = mainText.indexOf('injectTaskCompletionBridge')
  const injected = /executeJavaScript\(`([\s\S]*?)`\);/.exec(mainText.slice(from))
  if (!injected) fail('没能在 main.js 里定位注入脚本体（结构可能变了）')
  try {
    new vm.Script(injected[1])
  } catch (error) {
    fail(`注入脚本的语法检查失败：${error.message}`)
  }
}

/* ── 主流程 ──────────────────────────────────────────────────── */

const dryRun = process.argv.includes('--dry')
const revert = process.argv.includes('--revert')
const keepWork = process.argv.includes('--keep-work')

const asarPath = resolveAsar()
say(`app.asar：${asarPath}`)

const original = readFileSync(asarPath)
const parsed = parseAsar(original)
const files = readAll(original, parsed.header, parsed.dataStart)
const mainBytes = files.get('main.js')
if (!mainBytes) fail('asar 里没有 main.js')

/*
 * main.js 是 CRLF 换行的。下面的函数文本按 LF 写（仓库里可读），
 * 所以匹配前统一成 LF、写回前再还原成 CRLF —— 这样除被替换的那段函数外，
 * 文件其余字节保持完全不变。
 */
const mainRaw = mainBytes.toString('utf8')
const usesCrlf = mainRaw.includes('\r\n')
const toLf = (text) => text.replace(/\r\n/g, '\n')
const fromLf = (text) => (usesCrlf ? text.replace(/\n/g, '\r\n') : text)
const mainText = toLf(mainRaw)
say(`换行风格：${usesCrlf ? 'CRLF' : 'LF'}`)

const alreadyPatched = mainText.includes(MARKER)
say(`当前状态：${alreadyPatched ? '已打过补丁' : '原版（未打补丁）'}`)

if (revert) {
  if (!alreadyPatched) {
    say('· 没有检测到补丁标记，无需还原。')
    process.exit(0)
  }
  if (!mainText.includes(PATCHED_LF)) {
    fail('检测到补丁标记，但函数体与预期不一致。请用同目录的 app.asar.bak 还原，或重装 DSH。')
  }
  const restored = mainText.replace(PATCHED_LF, ORIGINAL_LF)
  assertSyntax(restored)
  files.set('main.js', Buffer.from(fromLf(restored), 'utf8'))
  say('· 已把 injectTaskCompletionBridge 还原成原版实现')
} else {
  if (alreadyPatched) {
    say('· 已经打过补丁，无需重复打。要撤销请加 --revert')
    process.exit(0)
  }
  if (!mainText.includes(ORIGINAL_LF)) {
    fail([
      '在 main.js 里找不到预期的那段 injectTaskCompletionBridge（DSH 可能更新过，代码变了）。',
      '请确认版本，或把新的 injectTaskCompletionBridge 函数贴给 AI 重新生成补丁；本次不做任何修改。',
    ].join('\n  '))
  }
  const patched = mainText.replace(ORIGINAL_LF, PATCHED_LF)
  assertSyntax(patched)
  files.set('main.js', Buffer.from(fromLf(patched), 'utf8'))
  say('· 已把状态表改成按稳定行标识建键，并加上"侧栏扫不到行""元素仍在文档里"两道保险')
}

const repacked = repack(parsed.header, files)
const check = parseAsar(repacked)
const checkFiles = readAll(repacked, check.header, check.dataStart)
if (checkFiles.size !== files.size) fail('重新打包后文件数量不一致')
for (const [path, data] of files) {
  const now = checkFiles.get(path)
  if (!now || !now.equals(data)) fail(`重新打包后 ${path} 的内容对不上`)
}
say('· 校验通过：文件清单一致、除 main.js 外逐字节一致、语法检查通过')

if (dryRun) {
  say('· --dry：不写盘。去掉 --dry 即会替换 app.asar。')
  process.exit(0)
}

assertDesktopClosed()

const backup = join(dirname(asarPath), 'app.asar.bak')
if (!existsSync(backup)) {
  copyFileSync(asarPath, backup)
  say(`· 已备份原文件 → ${backup}`)
} else {
  say(`· 备份已存在，保持不变：${backup}`)
}

const workDir = mkdtempSync(join(tmpdir(), 'dsh-shell-patch-'))
const tempOut = join(workDir, 'app.asar.new')
writeFileSync(tempOut, repacked)
try {
  writeFileSync(asarPath, repacked)
} catch (error) {
  rmSync(workDir, { recursive: true, force: true })
  fail([
    `写入 app.asar 失败：${error.message}`,
    '最可能的原因：DSH 还在运行，文件被占用。请完全退出 DSH 后重跑。',
    '原文件在此步骤之前没有被改动；上面的备份也可以用来核对。',
  ].join('\n  '))
}
// 写完再读回来核对一遍：万一写到一半出问题，立刻用备份还原并报错。
const written = readFileSync(asarPath)
if (!written.equals(repacked)) {
  if (existsSync(backup)) {
    copyFileSync(backup, asarPath)
    rmSync(workDir, { recursive: true, force: true })
    fail('写入后的内容与预期不一致，已自动用 app.asar.bak 还原。请重跑本脚本并留意磁盘/杀软干扰。')
  }
  rmSync(workDir, { recursive: true, force: true })
  fail(`写入后的内容与预期不一致，且没有备份可还原。请用 ${tempOut} 手动比对（已保留）。`)
}
say(`· 已写入 ${asarPath}（${original.length} → ${repacked.length} 字节），并已读回校验`)
if (keepWork) say(`· 中间产物保留在：${workDir}`)
else rmSync(workDir, { recursive: true, force: true })

say('')
say(revert ? '补丁已撤销。' : '补丁已打好。')
say('接下来：')
say('  1) 重新打开 DSH；')
say('  2) 故意让一个任务在窗口不前台时结束，确认通知只在真正完成时弹一次；')
say('  3) 想量化验证可跑：node tools/analyze-desktop-notifications.mjs（看新通知里误报比例是否归零）。')
say('')
say(`回滚：node ${process.argv[1].replace(/\\/g, '/')} --revert`)
say('注意：DSH 桌面程序自动更新会覆盖 app.asar，届时重跑本脚本即可。')
