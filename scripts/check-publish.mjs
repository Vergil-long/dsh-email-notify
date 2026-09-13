#!/usr/bin/env node
/**
 * 发布前安全检查：确认仓库里没有夹带个人/隐私信息。
 *
 *   node scripts/check-publish.mjs          # 有问题就退出码 1
 *   node scripts/check-publish.mjs --list   # 顺带列出跳过与检查的文件
 *
 * 为什么要有它：这个仓库是要推到 GitHub 给所有人看的，而开发环境里到处是
 * 真地址、真路径、真授权码。靠"我记得没写进去"不可靠，靠一条命令可靠。
 *
 * 不依赖 git：直接遍历工作区，跳过 .git / node_modules 与明确标记为私有的文件
 * （私有清单见 PRIVATE_FILES，与 .gitignore 保持一致）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 明确不发布的文件（与 .gitignore 对齐）。 */
const PRIVATE_FILES = new Set(['项目说明.md', 'config.json'])
const SKIP_DIRS = new Set(['.git', 'node_modules', 'shell-patch/.work', '.work'])

/** 只扫文本类文件。 */
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.txt', '.cmd', '.bat', '.html', '.css'])

/** 允许出现的占位名（写成这些就不算泄露）。 */
const PLACEHOLDER_USERS = new Set(['x', '<你>', '<you>', 'yourname', '用户名', 'user', 'username'])

/**
 * 检查规则。
 * 注意：宁可漏报也不要误报——误报会让人干脆忽略这条检查。
 * 明确**不算**泄露的：公开的 GitHub 账号名（`Vergil-long`，安装命令与包元数据里必须写）。
 */
const RULES = [
  {
    name: '私人邮箱前缀',
    pattern: /vergil7[._-]?7/i,
    hint: '把真实邮箱换成示例地址（如 me@example.com）',
  },
  {
    name: '真实的 Windows 用户目录绝对路径',
    pattern: /C:\\{1,2}Users\\{1,2}([\w.\u4e00-\u9fa5-]+)/gi,
    hint: '文档里用 C:\\Users\\<你>\\... 这类占位；代码里用 os.homedir()',
    allow: (match) => PLACEHOLDER_USERS.has(match[1].toLowerCase()),
  },
  {
    name: 'JSON 里疑似真实的密码/授权码',
    pattern: /"pass"\s*:\s*"([^"]{6,})"/g,
    hint: '配置模板里的口令一律留空；示例用明显的占位（如 "这里填授权码"）或空串',
    allow: (match) => /^(这里填|your|xxx|placeholder|\*+|<.*>)$/i.test(match[1]),
  },
]

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const rel = relative(root, full).replace(/\\/g, '/')
    if (SKIP_DIRS.has(rel) || SKIP_DIRS.has(name)) continue
    if (PRIVATE_FILES.has(rel)) continue
    const info = statSync(full)
    if (info.isDirectory()) {
      yield* walk(full)
      continue
    }
    if (!TEXT_EXT.has(name.slice(name.lastIndexOf('.')))) continue
    yield rel
  }
}

const listOnly = process.argv.includes('--list')
const findings = []
let scanned = 0

for (const rel of walk(root)) {
  scanned += 1
  if (listOnly) console.log(`  检查 ${rel}`)
  let text
  try {
    text = readFileSync(join(root, rel), 'utf8')
  } catch {
    continue
  }
  const lines = text.split('\n')
  for (const rule of RULES) {
    // 统一加 g 标志：否则 exec 永远停在同一个位置，while 会变成死循环（第一版就踩了这个坑）。
    const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`
    const pattern = new RegExp(rule.pattern.source, flags)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(line)) !== null) {
        if (match[0] === '') { pattern.lastIndex += 1; continue } // 防零宽匹配打转
        if (rule.allow?.(match)) continue
        findings.push({ file: rel, line: index + 1, rule: rule.name, text: line.trim().slice(0, 120), hint: rule.hint })
      }
    }
  }
}

console.log(`\n扫描了 ${scanned} 个文件（已跳过 .git / node_modules / ${[...PRIVATE_FILES].join(' / ')}）`)
if (findings.length === 0) {
  console.log('✓ 没发现个人/隐私信息，可以发布。')
  process.exit(0)
}
console.log(`✗ 发现 ${findings.length} 处需要处理：\n`)
for (const item of findings) {
  console.log(`  ${item.file}:${item.line}  [${item.rule}]`)
  console.log(`    ${item.text}`)
  console.log(`    → ${item.hint}`)
}
process.exit(1)
