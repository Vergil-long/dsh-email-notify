#!/usr/bin/env node
/**
 * 上线后的现场核验：一条命令把"插件到底加载没有、外壳补丁打上没有"全查清楚。
 *
 *   node scripts/verify-live.mjs                 # 默认查 http://127.0.0.1:3080
 *   node scripts/verify-live.mjs --url http://127.0.0.1:3081
 *   node scripts/verify-live.mjs --json          # 机器可读输出
 *
 * 查的都是**只能等 DSH 重启后才成立**的事，所以这是"重启之后第一件该跑的命令"：
 *   1) 宿主半侧新版是否挂上（v0.2 才有 /config 接口）
 *   2) 配置是否就绪、当前是否被判定为"你正在看界面"、上次发信结果
 *   3) **浏览器半侧是否被装配进页面**：读 index.html 里的 window.__DSH_BOOT__ 清单，
 *      看有没有 dsh-email-notify 这一项 —— 这是"设置里能不能看到那一节"的前提
 *   4) 浏览器半侧的 bundle 是否真的能取到（/plugins/<id>/client.js）
 *   5) 已安装的插件文件是否与工作区源码一致（有没有忘记同步）
 *   6) 桌面外壳的误报补丁是否已打进 app.asar
 *
 * 只读：不启动服务、不改任何文件。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { findAsar } from '../shell-patch/locate-asar.mjs'

const PACKAGE_NAME = 'dsh-email-notify'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argOf = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  const value = index >= 0 ? process.argv[index + 1] : null
  return value && !value.startsWith('--') ? value : fallback
}
const baseUrl = argOf('url', process.env.DSH_WEB_URL || 'http://127.0.0.1:3080').replace(/\/$/, '')
const asJson = process.argv.includes('--json')

const results = []
const record = (name, ok, detail, fix) => results.push({ name, ok, detail, fix })

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { accept: 'application/json' } })
  const text = await response.text()
  const type = response.headers.get('content-type') ?? ''
  if (!type.includes('json')) return { ok: false, reason: '不是 JSON（可能落到了 SPA 兜底：该路由不存在）', text }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return { ok: false, reason: `JSON 解析失败：${error.message}` }
  }
}

/* ── 1/2. 宿主半侧与状态 ─────────────────────────────────────── */

let status = null
try {
  const config = await getJson(`/${PACKAGE_NAME}/config`)
  if (config.ok) {
    record('宿主半侧是新版（/config 存在）', true, `configPath=${config.value.configPath}`)
    status = await getJson(`/${PACKAGE_NAME}/status`)
  } else {
    record('宿主半侧是新版（/config 存在）', false, config.reason,
      '把新版代码同步进 DSH 并重启：双击 更新并修复.cmd（或 node scripts/update-all.mjs）')
  }
} catch (error) {
  record('能否连上 DSH 的 web 服务', false, `${baseUrl} 连不上：${error.message}`,
    '确认 DSH 正在运行；或改端口：node scripts/verify-live.mjs --url http://127.0.0.1:8080')
}

if (status?.ok) {
  const value = status.value
  record('配置就绪（能发信）', value.ready === true,
    value.ready ? `发往 ${(value.to || []).join(', ')}` : `还缺：${(value.missing || []).join(', ')}`,
    '打开 设置 → 邮件通知 补全')
  record('在场判定可用', true, `watching=${value.watching}，客户端 ${(value.clients || []).length} 个`)
  const last = value.lastSend
  record('发信记录', Boolean(last?.ok), last ? `${last.ok ? '成功' : '失败'} · ${last.subject ?? ''} ${last.error ?? ''}` : '还没有发过')
}

/* ── 3. 浏览器半侧有没有被装配进页面 ─────────────────────────── */

try {
  const response = await fetch(`${baseUrl}/`, { headers: { accept: 'text/html' } })
  const html = await response.text()
  const match = /window\.__DSH_BOOT__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/.exec(html)
    ?? /window\.__DSH_BOOT__\s*=\s*(\{[\s\S]*?\})\s*;/.exec(html)
  if (!match) {
    record('页面里有启动清单（__DSH_BOOT__）', false, '没在 index.html 里找到清单',
      '这台 DSH 的版本可能不同；仍可看 /plugins/<id>/client.js 是否可取')
  } else {
    const graph = JSON.parse(match[1])
    const entries = Array.isArray(graph) ? graph : (graph.entries ?? graph.modules ?? [])
    const mine = entries.find((entry) => (entry?.id ?? '') === PACKAGE_NAME)
    record('浏览器半侧已装配进页面', Boolean(mine),
      mine ? `url=${mine.url}${mine.immediately ? ' immediate' : ''}` : `清单里共 ${entries.length} 项，没有 ${PACKAGE_NAME}`,
      '确认 package.json 的 dsh.client 与 exports["./client"] 没问题（npm run test:manifest），然后重启 DSH')
    if (mine?.url) {
      const bundle = await fetch(`${baseUrl}${mine.url}`)
      const text = await bundle.text()
      record('浏览器半侧 bundle 能取到', bundle.ok && text.includes('__ModuleLoader__'),
        `HTTP ${bundle.status}，${text.length} 字节`, '检查 /plugins 路由与 client/client.js 的内容')
    }
  }
} catch (error) {
  record('读取页面清单', false, error.message)
}

/* ── 4/5. 已安装副本是否与源码一致 ──────────────────────────── */

const dshHome = (process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh')
const installedDir = join(homedir(), PACKAGE_NAME)
const filesToCompare = ['lib/index.js', 'lib/config.js', 'lib/smtp.js', 'client/client.js', 'package.json', 'cordis.patch.yml']
if (existsSync(installedDir)) {
  const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
  const mismatched = filesToCompare.filter((file) => {
    const source = join(root, file)
    const installed = join(installedDir, file)
    return !existsSync(installed) || hash(source) !== hash(installed)
  })
  record('已安装副本与源码一致', mismatched.length === 0,
    mismatched.length === 0 ? `${filesToCompare.length} 个文件全部一致` : `不一致：${mismatched.join(', ')}`,
    '双击 更新并修复.cmd 同步（或 node scripts/install.mjs），再重启 DSH')
} else {
  record('已安装副本存在', false, `找不到 ${installedDir}`, '先安装：node scripts/install.mjs')
}

/* ── 6. 桌面外壳补丁 ────────────────────────────────────────── */

try {
  const asarPath = argOf('asar', null) ?? findAsar()
  if (!asarPath || !existsSync(asarPath)) {
    record('桌面外壳补丁状态', false, '找不到 app.asar', '用 --asar <路径> 指定，或跑 shell-patch 脚本时它会自动找')
  } else {
    const buffer = readFileSync(asarPath)
    const headerLength = buffer.readUInt32LE(4)
    const jsonLength = buffer.readUInt32LE(12)
    const header = JSON.parse(buffer.toString('utf8', 16, 16 + jsonLength))
    const dataStart = Math.ceil((8 + headerLength) / 4) * 4
    const entry = header.files['main.js']
    const offset = dataStart + parseInt(entry.offset, 10)
    const main = buffer.toString('utf8', offset, offset + entry.size)
    const patched = main.includes(`${PACKAGE_NAME} stable-key fix`)
    record('桌面外壳误报补丁已打', patched,
      patched ? `已打（${asarPath}）` : '未打：任务开始时仍可能误弹"任务已完成"',
      '完全退出 DSH 后跑 shell-patch\\修复桌面误报通知.cmd（或 node scripts/update-all.mjs --shell）')
  }
} catch (error) {
  record('桌面外壳补丁状态', false, error.message)
}

/* ── 输出 ───────────────────────────────────────────────────── */

if (asJson) {
  console.log(JSON.stringify({ baseUrl, results }, null, 2))
} else {
  console.log(`现场核验 ${baseUrl}\n`)
  const width = Math.max(...results.map((item) => item.name.length))
  for (const item of results) {
    console.log(`${item.ok ? '✓' : '✗'} ${item.name.padEnd(width)}  ${item.detail}`)
    if (!item.ok && item.fix) console.log(`${' '.repeat(width + 3)}→ ${item.fix}`)
  }
  const failed = results.filter((item) => !item.ok)
  console.log('')
  console.log(failed.length === 0
    ? '全部通过：插件已加载、浏览器半侧已装配、外壳补丁已就位。'
    : `有 ${failed.length} 项没过，按上面每条的 → 提示处理；改完需要重启 DSH 的会额外说明。`)
}

// 用 exitCode 而不是 process.exit()：后者会在还有未收敛的 fetch 句柄时
// 触发 libuv 断言（Windows 上见过 "Assertion failed: ... UV_HANDLE_CLOSING"），
// 还会把没刷完的输出截掉。
process.exitCode = results.some((item) => !item.ok) ? 1 : 0
