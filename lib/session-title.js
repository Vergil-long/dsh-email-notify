/**
 * 侧栏会话名的读取 —— 让邮件里显示"你在左边看到的那个名字"。
 *
 * 背景：DSH 的会话有两个身份 —— 内部 id（`session-b4d28e9c-…`）和侧栏显示的名字
 * （`继续邮件通知插件工作`）。用户只认后者，所以邮件里绝不能出现那串 id。
 *
 * 名字有三个来源，按可靠性逐级兜底：
 *   1. 内存表：`session/title` 事件实时填充（插件在会话创建时就挂上了才有）
 *   2. 会话日志：插件挂载晚 / DSH 重启过时，回读 `session.events` 里那条事件
 *   3. **侧栏投影缓存**：`<DSH_HOME>/storages/session_projcache.json` 里的
 *      `tables.sessions[<id>].rows.title.val` —— 这就是侧栏实际渲染用的那份数据，
 *      前两条都拿不到时以它为准。
 *
 * 第 3 条是这里实现的。它是 DSH 的内部存储格式，不是公开 API，所以：
 *   - 整个读取过程**不抛异常**，出错就当没有（宁可不显示名字，也不能拖垮发信）；
 *   - 按 `mtime + size` 缓存解析结果，避免每封邮件都去解几百 KB 的 JSON；
 *   - 文件大得离谱时直接放弃（防病态情况吃内存）。
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { resolveDshHome } from './config.js'

/** 超过这个大小就不解析了（正常几十万字节；真到这么大说明格式变了）。 */
const MAX_CACHE_BYTES = 32 * 1024 * 1024

/** 上次解析结果：`key` 是 mtime+size，文件没变就直接复用。 */
let cache = { key: '', value: null }

/**
 * 从投影缓存对象里取某个会话的侧栏名（纯函数，便于测试）。
 *
 * @param {object} projection - `session_projcache.json` 解析后的对象。
 * @param {string} sessionId - 会话 id（`session-…`）。
 * @returns {string} 侧栏名；没有则返回空串。
 */
export function pickProjectedTitle(projection, sessionId) {
  const rows = projection?.tables?.sessions?.[sessionId]?.rows
  if (!rows || typeof rows !== 'object') return ''
  // 投影行形如 { ver, seq, val }；val 就是侧栏上显示的名字。
  const value = rows.title?.val
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

/**
 * 读取并解析投影缓存（带缓存；读不到就返回 null）。
 *
 * @returns {object|null} 解析后的投影缓存对象。
 */
export function readProjectionCache() {
  const path = join(resolveDshHome(), 'storages', 'session_projcache.json')
  let stat
  try {
    stat = statSync(path)
  } catch {
    return null
  }
  if (!stat.isFile() || stat.size > MAX_CACHE_BYTES) return null

  const key = `${stat.mtimeMs}:${stat.size}`
  if (cache.key === key) return cache.value

  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    cache = { key, value }
    return value
  } catch {
    // 解析失败（正写到一半、格式变了）就当没有，别把这个错误传播出去。
    cache = { key, value: null }
    return null
  }
}

/**
 * 查某个会话的侧栏名。
 *
 * @param {string} sessionId - 会话 id。
 * @returns {string} 侧栏名；查不到返回空串。
 */
export function titleFromProjection(sessionId) {
  if (!sessionId) return ''
  return pickProjectedTitle(readProjectionCache(), sessionId)
}

/** 清掉缓存（测试用）。 */
export function resetProjectionCache() {
  cache = { key: '', value: null }
}
