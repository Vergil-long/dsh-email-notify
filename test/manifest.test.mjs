/**
 * 清单自检：守住"插件能不能被 DSH 装上并加载"这件事。
 *
 * 这一层最容易出的错是**静默失败**——清单里少一个字段、路径写错、client 包装里的 id
 * 和包名不一致，结果就是"设置页里根本没有那一节"，而日志里什么也看不见。
 * 所以这里按运行时的实际校验规则逐条对着查：
 *   - dsh.bundle.patch 指向存在的文件，且那份 patch 里确实插入了本包（id/name 对得上）
 *   - dsh.client.platform 是字符串、inject 是字符串数组、immediately 是布尔
 *     （dsh-client-modules 对这三个字段是严格校验的，类型不对会直接让组合失败）
 *   - exports["./client"] 能解析到真实文件，且该文件是 __ModuleLoader__ 包装格式、
 *     包装里的 id 与包名一致（不一致会让浏览器端模块表找不到它）
 *   - 宿主半侧能被 import，并导出 apply（以及可选的 name/id）
 *
 *   node test/manifest.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(join(root, relative), 'utf8')

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

const pkg = JSON.parse(read('package.json'))

await test('package.json 基本字段齐全（name/version/license/main/type）', () => {
  assert.equal(pkg.type, 'module', '必须是 ESM（宿主半侧用的是 import/export）')
  assert.match(pkg.name, /^dsh-[\w.-]+$/, '包名应当以 dsh- 开头（DSH 插件命名习惯）')
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
  assert.equal(pkg.license, 'MIT')
  assert.ok(pkg.main, '要有 main，否则宿主半侧无法按包名加载')
  assert.ok(existsSync(join(root, pkg.main)), `main 指向的文件不存在：${pkg.main}`)
  assert.ok(pkg.repository?.url, 'GitHub 封装后应当有 repository')
})

await test('dsh.bundle.patch 存在，且那份 patch 确实插入了本包', () => {
  const patchPath = pkg.dsh?.bundle?.patch
  assert.ok(patchPath, '缺少 dsh.bundle.patch')
  assert.ok(existsSync(join(root, patchPath)), `patch 文件不存在：${patchPath}`)
  const text = read(patchPath)
  assert.match(text, /-\s*insert:/, 'patch 应当是一条 insert 列表')
  assert.match(text, new RegExp(`id:\\s*['"]?${pkg.name}['"]?`), `patch 里没有 id: ${pkg.name}`)
  assert.match(text, new RegExp(`name:\\s*['"]${pkg.name}['"]`), `patch 里没有 name: '${pkg.name}'`)
})

await test('dsh.client 声明符合 dsh-client-modules 的严格校验', () => {
  const client = pkg.dsh?.client
  assert.ok(client, '缺少 dsh.client（浏览器半侧不会被装配）')
  assert.equal(typeof client.platform, 'string', 'platform 必须是字符串')
  assert.equal(client.platform, 'web')
  if (client.inject !== undefined) {
    assert.ok(Array.isArray(client.inject) && client.inject.every((item) => typeof item === 'string'),
      'inject 必须是字符串数组')
  }
  if (client.immediately !== undefined) {
    assert.equal(typeof client.immediately, 'boolean', 'immediately 必须是布尔')
  }
})

await test('exports["./client"] 能解析到真实文件', () => {
  const entry = pkg.exports?.['./client']
  const resolved = typeof entry === 'string' ? entry : entry?.default
  assert.equal(typeof resolved, 'string', 'exports["./client"] 必须是字符串或带 default 的对象')
  assert.ok(existsSync(join(root, resolved)), `client 文件不存在：${resolved}`)
})

await test('client 包装里的 id 与包名一致，且用的是 __ModuleLoader__ 格式', () => {
  const entry = pkg.exports['./client']
  const source = read(typeof entry === 'string' ? entry : entry.default)
  assert.match(source, /window\.__ModuleLoader__\.load\(/, 'client 半侧必须是 __ModuleLoader__.load 包装格式')
  const idMatch = /id:\s*["']([^"']+)["']/.exec(source)
  assert.ok(idMatch, '包装里没有 id')
  assert.equal(idMatch[1], pkg.name, '包装里的 id 必须与包名一致')
  assert.match(source, /factory:/, '包装里要有 factory')
})

await test('宿主半侧可以 import，并导出 apply', async () => {
  // Windows 上动态 import 绝对路径必须转成 file:// URL，否则报 "protocol 'f:'"。
  const module = await import(pathToFileURL(join(root, pkg.main)).href)
  assert.equal(typeof module.apply, 'function', '宿主半侧必须导出 apply(ctx)')
  if (module.name !== undefined) assert.equal(typeof module.name, 'string')
})

await test('exports 里声明的入口都存在', () => {
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    const target = typeof value === 'string' ? value : value?.default
    if (typeof target !== 'string') continue
    assert.ok(existsSync(join(root, target)), `exports["${key}"] 指向的文件不存在：${target}`)
  }
})

await test('files 字段里的每一项都存在（npm 发布时不会缺文件）', () => {
  for (const item of pkg.files ?? []) {
    assert.ok(existsSync(join(root, item)), `files 里列了不存在的项：${item}`)
  }
  for (const required of ['README.md', 'LICENSE']) {
    assert.ok(pkg.files?.includes(required), `files 里应当包含 ${required}`)
  }
})

console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
