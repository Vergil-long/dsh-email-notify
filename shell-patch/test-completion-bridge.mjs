/**
 * 行为自检：把外壳注入的那段脚本放进一个假 DOM 里跑，验证补丁真的修掉了误报，
 * 而且没有把"真完成"的通知也一起弄没。
 *
 * 同一组场景会分别喂给「原版」和「修补版」，用对照结果说话：
 *   1. 任务还在跑，会话标题变了            → 原版误报，修补版不报   ← 这次修的就是它
 *   2. 任务真的跑完了（运行中 → 已完成）    → 两版都报（确认没修坏）
 *   3. 侧栏整块不可见（例如打开设置页）      → 原版误报，修补版不报
 *   4. 运行中的行被移除，且已经跑了很久      → 修补版报（真结束）
 *   5. 运行中的行被移除，但只跑了几秒        → 修补版不报（多半是列表重排）
 *
 *   node shell-patch/test-completion-bridge.mjs
 */
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { ORIGINAL_FUNCTION, PATCHED_FUNCTION, injectedScriptOf } from './bridge-snippets.mjs'

/* ── 假 DOM ───────────────────────────────────────────────────── */

/** 造一行会话：firstElementChild 放状态文字，children[1] 放标题。 */
function makeRow({ id, status, title, connected = true }) {
  const statusNode = { textContent: status }
  const titleNode = { textContent: title }
  const row = {
    id,
    isConnected: connected,
    children: [statusNode, titleNode],
    firstElementChild: statusNode,
    matches: () => false,
    querySelector: () => null,
    getAttribute: (name) => (name === 'data-state' ? null : null),
  }
  return row
}

/**
 * 把注入脚本装进一个可控环境。
 * @param {string} code - 注入脚本本体。
 * @returns {{rows: object[], notifications: object[], tick: () => Promise<void>, setNow: (n: number) => void}}
 */
function createHarness(code) {
  const notifications = []
  const rows = []
  let now = 1_000_000
  let observerCallback = null

  const sandbox = {
    window: {
      __dshTaskCompletionObserver: null,
      dshWin: { taskComplete: (details) => notifications.push(details) },
    },
    document: {
      documentElement: {},
      querySelectorAll: () => rows,
    },
    MutationObserver: class {
      constructor(callback) { observerCallback = callback }
      observe() {}
    },
    location: { href: 'http://127.0.0.1:3080/' },
    URL,
    Map,
    Set,
    Array,
    Date: class extends Date {
      static now() { return now }
    },
    queueMicrotask,
  }

  vm.createContext(sandbox)
  new vm.Script(code).runInContext(sandbox)

  return {
    rows,
    notifications,
    /** 触发一次扫描并等微任务跑完。 */
    tick: async () => {
      observerCallback?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    setNow: (value) => { now = value },
    advance: (ms) => { now += ms },
  }
}

const RUNNING = '进行中'
const DONE = '已完成'

/* ── 场景 ─────────────────────────────────────────────────────── */

/**
 * 每个场景拿到一个干净的 harness，返回通知数组。
 * @param {string} code - 注入脚本。
 * @param {(h: ReturnType<typeof createHarness>) => Promise<void>} script - 场景动作。
 */
async function scenario(code, script) {
  const harness = createHarness(code)
  await script(harness)
  return harness.notifications
}

const VERSIONS = [
  { name: '原版', code: injectedScriptOf(ORIGINAL_FUNCTION) },
  { name: '修补版', code: injectedScriptOf(PATCHED_FUNCTION) },
]

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

const original = VERSIONS[0].code
const patched = VERSIONS[1].code

/* ── 用例 ─────────────────────────────────────────────────────── */

await test('场景 1：任务还在跑、会话标题变了 —— 原版误报，修补版不报', async () => {
  const run = (code) => scenario(code, async (harness) => {
    harness.rows.push(makeRow({ id: 'session-1', status: RUNNING, title: '你好，请你阅读' }))
    await harness.tick()                       // 首次扫描：登记为运行中
    harness.setNow(harness.now + 2000)
    harness.rows[0] = makeRow({ id: 'session-1', status: RUNNING, title: '给 harness 加邮件通知' })
    await harness.tick()                       // 标题变了，任务还在跑
  })
  assert.equal((await run(original)).length, 1, '原版应当在这里误报一次（这就是用户看到的那条假通知）')
  assert.equal((await run(patched)).length, 0, '修补版不该报')
})

await test('场景 2：任务真的跑完了 —— 两版都要报', async () => {
  const run = (code) => scenario(code, async (harness) => {
    harness.rows.push(makeRow({ id: 'session-2', status: RUNNING, title: '跑一个任务' }))
    await harness.tick()
    harness.advance(30_000)
    harness.rows[0] = makeRow({ id: 'session-2', status: DONE, title: '跑一个任务' })
    await harness.tick()
  })
  const fromOriginal = await run(original)
  const fromPatched = await run(patched)
  assert.equal(fromOriginal.length, 1)
  assert.equal(fromPatched.length, 1, '修补后仍然要能报真完成')
  assert.equal(fromPatched[0].title, '跑一个任务')
  assert.equal(fromPatched[0].key, 'session-2')
})

await test('场景 3：侧栏整块不可见（例如打开了设置页）—— 原版误报，修补版不报', async () => {
  const run = (code) => scenario(code, async (harness) => {
    harness.rows.push(makeRow({ id: 'session-3', status: RUNNING, title: '长时间任务' }))
    await harness.tick()
    harness.advance(60_000)
    harness.rows.length = 0                     // 侧栏被卸载，一行都扫不到
    await harness.tick()
  })
  assert.equal((await run(original)).length, 1, '原版会把"扫不到行"当成任务结束')
  assert.equal((await run(patched)).length, 0, '修补版不该报')
})

await test('场景 4：运行中的行真的从文档里消失，且已经跑了很久 —— 修补版要报', async () => {
  const reported = await scenario(patched, async (harness) => {
    const row = makeRow({ id: 'session-4', status: RUNNING, title: '被删掉的会话' })
    harness.rows.push(row)
    await harness.tick()
    harness.advance(20_000)
    row.isConnected = false                     // 元素真的被移出文档
    harness.rows.length = 0
    harness.rows.push(makeRow({ id: 'session-other', status: DONE, title: '别的会话' }))
    await harness.tick()
  })
  assert.equal(reported.length, 1, '真消失应当算结束')
  assert.equal(reported[0].key, 'session-4')
})

await test('场景 5：运行中的行消失，但只跑了几秒 —— 修补版不报（多半是列表重排）', async () => {
  const reported = await scenario(patched, async (harness) => {
    const row = makeRow({ id: 'session-5', status: RUNNING, title: '刚开的会话' })
    harness.rows.push(row)
    await harness.tick()
    harness.advance(1500)
    row.isConnected = false
    harness.rows.length = 0
    harness.rows.push(makeRow({ id: 'session-other2', status: DONE, title: '别的会话' }))
    await harness.tick()
  })
  assert.equal(reported.length, 0)
})

await test('场景 6：元素仍在文档里（只是换了 key / 重渲染）—— 修补版不报', async () => {
  const reported = await scenario(patched, async (harness) => {
    const row = makeRow({ id: 'session-6', status: RUNNING, title: '重渲染' })
    harness.rows.push(row)
    await harness.tick()
    harness.advance(30_000)
    harness.rows[0] = { ...row, id: 'session-6-renamed' } // 换了 id，但元素还在文档里
    await harness.tick()
  })
  assert.equal(reported.length, 0, '换了 key 不等于任务结束')
})

await test('场景 7：等待授权 → 已完成，仍然算完成（waiting 也是进行中的一种）', async () => {
  const reported = await scenario(patched, async (harness) => {
    harness.rows.push(makeRow({ id: 'session-7', status: '等待批准', title: '等你授权' }))
    await harness.tick()
    harness.advance(10_000)
    harness.rows[0] = makeRow({ id: 'session-7', status: DONE, title: '等你授权' })
    await harness.tick()
  })
  assert.equal(reported.length, 1)
})

await test('修补版没有改动对外的调用契约（key / title / taskUrl 三个字段）', async () => {
  const reported = await scenario(patched, async (harness) => {
    harness.rows.push(makeRow({ id: 'session-8', status: RUNNING, title: '契约定' }))
    await harness.tick()
    harness.advance(10_000)
    harness.rows[0] = makeRow({ id: 'session-8', status: DONE, title: '契约定' })
    await harness.tick()
  })
  assert.deepEqual(Object.keys(reported[0]).sort(), ['key', 'taskUrl', 'title'])
  assert.equal(reported[0].taskUrl, 'http://127.0.0.1:3080/')
})

console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
