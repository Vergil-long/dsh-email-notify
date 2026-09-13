/**
 * 真实运行时集成自检（不是假 ctx）：
 * 用 DSH 自带的 cordis 起一个真 Context，装上真的 `dsh-host-webserver`，
 * 再把本插件的宿主半侧挂上去，最后走**真 HTTP** 断言行为。
 *
 * 为什么要有这一层：别的用例都用假 ctx，验证的是"逻辑对不对"；
 * 这一层验证的是"在真 cordis 里挂得上、真服务器上路由真的能响应"——
 * 比如 ctx.inject(['webServer']) 的时机、effect 的用法、register 的重复路径保护、
 * 事件名注册会不会被拒绝，这些只有真运行时说了算。
 *
 * 本机没装 DSH 时自动跳过（用例只在有 DSH 运行时才有意义）。
 *
 *   node test/host-integration.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { findAsar } from '../shell-patch/locate-asar.mjs'

/* ── 找到 DSH 运行时的 node_modules ──────────────────────────── */

function findRuntimeModules() {
  const candidates = []
  if (process.env.DSH_RUNTIME_MODULES) candidates.push(process.env.DSH_RUNTIME_MODULES)
  // 桌面程序旁边就是运行时：<安装目录>/resources/dsh-runtime/node_modules
  const asar = findAsar()
  if (asar) candidates.push(join(asar, '..', 'dsh-runtime', 'node_modules'))
  for (const base of [process.env.ProgramFiles, process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')]) {
    if (base) candidates.push(join(base, 'DeepSeekHarness', 'resources', 'dsh-runtime', 'node_modules'))
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(join(candidate, '@deepseek-ai', 'cordis'))) return candidate
  }
  return null
}

const runtimeModules = findRuntimeModules()
if (!runtimeModules) {
  console.log('跳过：本机找不到 DSH 运行时的 node_modules。')
  console.log('这一层用例验证的是"在真 cordis + 真 webServer 上挂载并响应"，没装 DSH 的环境跳过即可。')
  console.log('要指定位置：设置环境变量 DSH_RUNTIME_MODULES=<...>/dsh-runtime/node_modules')
  process.exit(0)
}
console.log(`使用运行时：${runtimeModules}`)

/* ── 准备隔离的 DSH_HOME 与配置 ──────────────────────────────── */

const home = mkdtempSync(join(tmpdir(), 'dsh-email-notify-host-'))
mkdirSync(join(home, 'dsh-email-notify'), { recursive: true })
process.env.DSH_HOME = home

let failures = 0
async function test(name, fn) {
  try {
    await fn()
    console.log(`✓ ${name}`)
  } catch (error) {
    failures += 1
    console.log(`✗ ${name}\n   ${error.message}`)
  }
}

/* ── 起真实运行时 ────────────────────────────────────────────── */

const load = (relative) => import(pathToFileURL(join(runtimeModules, relative)).href)
const { Context } = await load('@deepseek-ai/cordis/lib/index.js')
const { default: WebServer } = await load('@deepseek-ai/dsh-host-webserver/lib/index.js')
const emailNotify = await import('../lib/index.js')

const ctx = new Context()
let mountError = null
let serverFiber = null
let pluginFiber = null
try {
  // cordis 4 里 ctx.plugin() 返回 Fiber；停止一个插件就是 dispose 它的 fiber。
  serverFiber = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await serverFiber
  pluginFiber = ctx.plugin(emailNotify)
  await pluginFiber
} catch (error) {
  mountError = error
}

const port = (() => {
  try {
    return ctx.webServer?.port
  } catch {
    return undefined
  }
})()
const base = port ? `http://127.0.0.1:${port}` : null
const get = async (path, init) => {
  const response = await fetch(`${base}${path}`, init)
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch { /* 非 JSON 就留 null */ }
  return { status: response.status, type: response.headers.get('content-type') ?? '', text, json }
}
const postJson = (path, body) => get(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

/* ── 用例 ────────────────────────────────────────────────────── */

await test('插件能在真实 cordis 上挂载（不报重复路由 / 事件未声明之类的错）', () => {
  assert.equal(mountError, null, `挂载时报错：${mountError?.message}`)
  assert.ok(port, 'webServer 应当已经在真端口上监听')
})

if (base) {
  await test('真服务器上：/status 返回 JSON 且初始为未就绪、不在场', async () => {
    const result = await get('/dsh-email-notify/status')
    assert.equal(result.status, 200)
    assert.match(result.type, /application\/json/)
    assert.equal(result.json.ready, false, '隔离的空配置应当还未就绪')
    assert.equal(result.json.watching, false)
    assert.ok(Array.isArray(result.json.missing) && result.json.missing.length > 0)
  })

  await test('真服务器上：/config 读回来的口令为空、只报是否已设置', async () => {
    const result = await get('/dsh-email-notify/config')
    assert.equal(result.status, 200)
    assert.equal(result.json.config.smtp.pass, '')
    assert.equal(result.json.config.smtp.passSet, false)
    assert.match(result.json.configPath, /config\.json$/)
  })

  await test('真服务器上：写配置能落盘，且口令留空不覆盖', async () => {
    const saved = await postJson('/dsh-email-notify/config', {
      config: {
        smtp: { host: 'smtp.example.com', port: 2525, secure: false, user: 'me@example.com', pass: 'secret-pass', from: 'me@example.com' },
        to: ['me@example.com'],
      },
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.json.ok, true)
    assert.equal(saved.json.ready, true, '填全后应当就绪')
    const onDisk = JSON.parse(readFileSync(join(home, 'dsh-email-notify', 'config.json'), 'utf8'))
    assert.equal(onDisk.smtp.pass, 'secret-pass')
    assert.equal(onDisk.smtp.host, 'smtp.example.com')

    const again = await postJson('/dsh-email-notify/config', { config: { smtp: { port: 2587 } } })
    assert.equal(again.json.config.smtp.port, 2587)
    assert.equal(again.json.config.smtp.passSet, true, '口令仍然在')
    assert.equal(JSON.stringify(again.json).includes('secret-pass'), false, '接口不回显口令')
  })

  await test('真服务器上：presence 上报会改变"在看界面"的判定', async () => {
    const before = await get('/dsh-email-notify/status')
    assert.equal(before.json.watching, false)
    const reported = await postJson('/dsh-email-notify/presence', { clientId: 'itest', focused: true, visible: true })
    assert.equal(reported.status, 200)
    assert.equal(reported.json.watching, true)
    const after = await get('/dsh-email-notify/status')
    assert.equal(after.json.watching, true)
    assert.equal(after.json.clients.length, 1)
    assert.equal(after.json.clients[0].id, 'itest')
    // 失焦后应当立刻不算在场
    await postJson('/dsh-email-notify/presence', { clientId: 'itest', focused: false, visible: true })
    assert.equal((await get('/dsh-email-notify/status')).json.watching, false)
  })

  await test('真服务器上：方法不对返回 405，未知路径返回 404', async () => {
    assert.equal((await get('/dsh-email-notify/presence')).status, 405)
    assert.equal((await get('/dsh-email-notify/config', { method: 'DELETE' })).status, 405)
    assert.equal((await get('/dsh-email-notify/nope')).status, 404)
  })

  await test('真服务器上：/inbox 首访只回游标、不补发历史', async () => {
    const result = await get('/dsh-email-notify/inbox')
    assert.equal(result.status, 200)
    assert.deepEqual(result.json.items, [])
    assert.equal(typeof result.json.next, 'number')
  })

  await test('真服务器上：总开关关掉后 /status 如实反映', async () => {
    await postJson('/dsh-email-notify/config', { config: { enabled: false } })
    assert.equal((await get('/dsh-email-notify/status')).json.enabled, false)
    await postJson('/dsh-email-notify/config', { config: { enabled: true } })
    assert.equal((await get('/dsh-email-notify/status')).json.enabled, true)
  })
} else {
  console.log('· 没有可用的监听端口，跳过 HTTP 断言')
}

/* ── 收尾：真实 dispose 路径（这才是 effect 是否写对的最终证据） ── */

/** 端口还开着吗？ */
function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' }, () => { socket.destroy(); resolve(true) })
    socket.on('error', () => resolve(false))
    socket.setTimeout(400, () => { socket.destroy(); resolve(false) })
  })
}

await test('dispose 掉插件的 fiber 后，它注册的路由真的消失（effect 的 disposer 生效）', async () => {
  assert.ok(pluginFiber && typeof pluginFiber.dispose === 'function', 'cordis 4 里应当能拿到 fiber.dispose')
  await pluginFiber.dispose()
  const after = await get('/dsh-email-notify/status')
  assert.equal(after.status, 404, '插件卸载后路由应当不再响应（这里是 webServer 自己的 404）')
  assert.equal(await portOpen(port), true, '此时服务器还应当开着（只卸载了插件）')
})

await test('dispose 掉 webServer 的 fiber 后，端口关闭、进程能自然退出', async () => {
  await serverFiber.dispose()
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(await portOpen(port), false, '服务器应当已经关闭')
})

console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`)
process.exitCode = failures === 0 ? 0 : 1
