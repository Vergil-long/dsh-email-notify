#!/usr/bin/env node
/**
 * 把 dsh-email-notify 装进 DSH 的 web profile。
 *
 *   node scripts/install.mjs              # 安装 / 更新（复制 + 目录联接 + 改 profile 配置）
 *   node scripts/install.mjs --uninstall  # 卸载（只改 DSH 侧，保留用户目录里的插件副本）
 *   node scripts/install.mjs --dry        # 只打印将要做的改动
 *   node scripts/install.mjs --dir <路径> # 换一个插件落地目录（默认 ~/dsh-email-notify）
 *
 * 为什么这么做：DSH 的插件以「profile bundle」的形式装配，profile 的
 * package.json 里要有依赖项和 bundles 条目，node_modules 里要有可解析的包。
 * 本插件零依赖，所以不需要跑 pnpm install —— 直接建目录联接即可，
 * 和 dsh-custom-font 完全一样的装法（也顺便避开了「路径带空格会报
 * ERR_PNPM_SPEC_NOT_SUPPORTED」那个坑：落地目录固定放在无空格的用户目录下）。
 *
 * 注意：改写插件列表后需要重启 DSH 桌面应用才会加载（退出时会连后端一起重启）。
 * 邮件配置**不在这里填**——装好后在 DSH 的「设置 → 邮件通知」里填。
 */
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-email-notify'
const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry')
const uninstall = args.has('--uninstall')

const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshHome = (process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', 'web')
const profilePackage = join(profileDir, 'package.json')
const linkPath = join(profileDir, 'node_modules', PACKAGE_NAME)
const installDir = args.has('--dir')
  ? resolve(process.argv[process.argv.indexOf('--dir') + 1])
  : join(homedir(), PACKAGE_NAME)

const say = (message) => console.log(message)

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

if (!existsSync(profilePackage)) {
  fail(`找不到 profile：${profilePackage}\n  DSH_HOME=${dshHome}，请确认 web profile 是否存在。`)
}

/* ── 1. 插件文件复制到位 ─────────────────────────────────────── */

const ITEMS = ['lib', 'client', 'scripts', 'cordis.patch.yml', 'package.json', 'README.md', 'LICENSE']

function copyInto(target) {
  if (resolve(target) === sourceDir) {
    say(`· 插件目录与源目录相同，跳过复制：${target}`)
    return
  }
  if (dryRun) {
    say(`· 将要复制到 ${target}：${ITEMS.filter((item) => existsSync(join(sourceDir, item))).join(', ')}`)
    return
  }
  mkdirSync(target, { recursive: true })
  for (const item of ITEMS) {
    const from = join(sourceDir, item)
    if (!existsSync(from)) continue
    const to = join(target, item)
    rmSync(to, { recursive: true, force: true })
    cpSync(from, to, { recursive: true })
    say(`· 复制 ${item} → ${to}`)
  }
}

/* ── 2. profile 配置改写 ─────────────────────────────────────── */

function readProfile() {
  try {
    return JSON.parse(readFileSync(profilePackage, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    fail(`profile package.json 解析失败：${error.message}`)
  }
}

function writeProfile(next) {
  // 固定名字的单一备份，不堆 .bak/.old/.dbg 一堆（沿用用户的备份约定）。
  const backup = `${profilePackage}.dsh-email-notify.bak`
  if (!dryRun && !existsSync(backup)) {
    copyFileSync(profilePackage, backup)
    say(`· 已备份原 profile 配置 → ${backup}`)
  }
  const text = `${JSON.stringify(next, null, 2)}\n`
  if (dryRun) {
    say('· 将要写入的 profile package.json：')
    say(text.split('\n').map((line) => `    ${line}`).join('\n'))
    return
  }
  writeFileSync(profilePackage, text, 'utf8')
  say(`· 已更新 ${profilePackage}`)
}

function writeBundleEntry(withEntry) {
  const profile = readProfile()
  profile.dependencies = profile.dependencies ?? {}
  profile.dsh = profile.dsh ?? {}
  profile.dsh.profile = profile.dsh.profile ?? {}
  profile.dsh.profile.bundles = Array.isArray(profile.dsh.profile.bundles) ? profile.dsh.profile.bundles : []
  const spec = `link:${installDir.replace(/\\/g, '/')}`

  if (withEntry) {
    profile.dependencies[PACKAGE_NAME] = spec
    if (!profile.dsh.profile.bundles.includes(PACKAGE_NAME)) profile.dsh.profile.bundles.push(PACKAGE_NAME)
    say(`· dependencies["${PACKAGE_NAME}"] = "${spec}"`)
    say(`· dsh.profile.bundles 追加 "${PACKAGE_NAME}"`)
  } else {
    delete profile.dependencies[PACKAGE_NAME]
    profile.dsh.profile.bundles = profile.dsh.profile.bundles.filter((name) => name !== PACKAGE_NAME)
    say(`· 移除 dependencies / bundles 里的 "${PACKAGE_NAME}"`)
  }
  writeProfile(profile)
}

/* ── 3. node_modules 里的目录联接 ─────────────────────────────── */

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

function replaceLink() {
  mkdirSync(dirname(linkPath), { recursive: true })
  if (existsSync(linkPath) || isLink(linkPath)) {
    if (isLink(linkPath)) {
      if (dryRun) say(`· 将要重建目录联接 ${linkPath}`)
      else unlinkSync(linkPath)
    } else {
      // 真目录：说明有人手动拷过，先改名保留再换掉，不直接删别人的东西。
      const parked = `${linkPath}.bak-${Date.now()}`
      say(`· ${linkPath} 是真实目录，改名保留为 ${parked}`)
      if (!dryRun) {
        cpSync(linkPath, parked, { recursive: true })
        rmSync(linkPath, { recursive: true, force: true })
      }
    }
  }
  if (dryRun) {
    say(`· 将要创建目录联接 ${linkPath} → ${installDir}`)
    return
  }
  symlinkSync(installDir, linkPath, 'junction')
  say(`· 目录联接就绪：${linkPath} → ${installDir}`)
}

/* ── 4. 配置模板（空值，交给设置界面去填） ───────────────────── */

const configFile = join(dshHome, PACKAGE_NAME, 'config.json')

/**
 * 空模板：值全部留空。
 *
 * 早先版本在命令行里问邮箱和授权码；现在这些设置已经集成进
 * 「设置 → 邮件通知」面板，脚本不再碰用户的凭据。
 */
function templateConfig() {
  return {
    _说明: '本文件由 dsh-email-notify 插件读写。一般不用手改——打开 DSH 的「设置 → 邮件通知」在界面里改，改完会写回这里。',
    enabled: true,
    smtp: {
      host: 'smtp.qq.com',
      port: 465,
      secure: true,
      rejectUnauthorized: true,
      user: '',
      pass: '',
      from: '',
      fromName: 'DeepSeek Harness',
    },
    to: [],
  }
}

/** 配置是不是还没填过（只用于提示措辞，脚本不碰凭据）。 */
function configLooksEmpty() {
  try {
    const config = JSON.parse(readFileSync(configFile, 'utf8').replace(/^\uFEFF/, ''))
    const smtp = config?.smtp ?? {}
    return !String(smtp.user ?? '').trim() || !String(smtp.pass ?? '').trim()
  } catch {
    return true
  }
}

/* ── 主流程 ──────────────────────────────────────────────────── */

say(uninstall ? '卸载 dsh-email-notify' : '安装 dsh-email-notify')
say(`  DSH_HOME    : ${dshHome}`)
say(`  profile     : ${profileDir}`)
say(`  插件落地目录 : ${installDir}`)
say('')

if (uninstall) {
  writeBundleEntry(false)
  if (isLink(linkPath) || existsSync(linkPath)) {
    if (dryRun) say(`· 将要删除 ${linkPath}`)
    else {
      rmSync(linkPath, { recursive: true, force: true })
      say(`· 已删除 ${linkPath}`)
    }
  }
  say('')
  say('已卸载。重启 DSH 后生效；插件副本与配置仍在（需要的话手动删掉）：')
  say(`  ${installDir}`)
  say(`  ${join(dshHome, PACKAGE_NAME)}`)
  process.exit(0)
}

copyInto(installDir)
writeBundleEntry(true)
replaceLink()

if (!dryRun && !existsSync(configFile)) {
  mkdirSync(dirname(configFile), { recursive: true })
  writeFileSync(configFile, `${JSON.stringify(templateConfig(), null, 2)}\n`, 'utf8')
  say(`· 已生成空配置：${configFile}`)
}

const needsSetup = dryRun ? false : configLooksEmpty()

say('')
say('完成。接下来：')
say('  1) 重启 DSH 桌面应用（它会连后端一起重启，当前会话会中断，重开即可恢复）。')
if (needsSetup) {
  say('  2) 打开 DSH 的「设置 → 邮件通知」，填邮箱地址与授权码，点「发送测试邮件」验证。')
} else {
  say('  2) 配置已经填过，重启后可直接用；要改就在「设置 → 邮件通知」里改。')
}
say('  3) 命令行自检（可选）：node scripts/send-test.mjs --trace')
say('  4) 想看运行状态：http://127.0.0.1:3080/dsh-email-notify/status')
say('')
say('回滚安装：node scripts/install.mjs --uninstall')
