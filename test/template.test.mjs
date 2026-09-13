/**
 * 邮件"长什么样"的自检：模板引擎 + 会话名来源。
 *
 * 这两件事都属于"用户一眼看到的东西"，改动最容易踩坏，所以单独一套：
 *   1) 默认模板渲染出来的就是用户要的精简版（工作区 / 会话 / 状态 / 离开模式 + 一行出处）
 *   2) 自定义模板、认不出的占位符、空行整理
 *   3) 会话名取的是**侧栏那个名字**（投影缓存里的 title），而不是 session-… 这串 id
 *
 *   node test/template.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { resolveDshHome } from '../lib/config.js'
import { pickProjectedTitle, readProjectionCache, titleFromProjection } from '../lib/session-title.js'
import {
  DEFAULT_BODY_TEMPLATE,
  DEFAULT_SUBJECT_TEMPLATE,
  DETAILED_BODY_TEMPLATE,
  PLACEHOLDERS,
  renderSubject,
  renderTemplate,
  resolveTemplate,
  tidyText,
  unknownPlaceholders,
} from '../lib/template.js'

let failures = 0
function test(name, fn) {
  try {
    fn()
    console.log(`✓ ${name}`)
  } catch (error) {
    failures += 1
    console.log(`✗ ${name}\n   ${error.message}`)
  }
}

/** 一次"任务完成"通知的占位符取值（照着 lib/index.js 里 onTurnEnd 拼的那份）。 */
function turnEndVars(extra = {}) {
  return {
    会话: '继续邮件通知插件工作',
    会话ID: 'session-b4d28e9c-d696-47b0-8908-547f0180d025',
    工作区: 'F:\\Space For AI work\\harness',
    时间: '2026-09-13 18:20:05',
    地址: 'http://127.0.0.1:3080',
    图标: '✅',
    状态: '已完成',
    离开模式: '开',
    回合: 5,
    用时: '7 分 24 秒',
    详情: '',
    摘要: '',
    工具: '',
    提问: '把设置面板精简一下。',
    最后回复: '已经收进二级页面。',
    ...extra,
  }
}

/* ── 一、默认模板就是用户要的精简版 ─────────────────────────── */

test('默认主题：`[DSH] ✅ 任务已完成 · 会话名`（前缀由 subjectPrefix 另外拼）', () => {
  const subject = renderSubject(DEFAULT_SUBJECT_TEMPLATE, turnEndVars())
  assert.equal(subject, '✅ 任务已完成 · 继续邮件通知插件工作')
})

test('默认正文：工作区 / 会话 / 状态 / 离开模式 + 一行出处', () => {
  const body = tidyText(renderTemplate(DEFAULT_BODY_TEMPLATE, turnEndVars()))
  assert.equal(body, [
    '工作区：F:\\Space For AI work\\harness',
    '会话：继续邮件通知插件工作',
    '状态：已完成',
    '离开模式：开',
    '',
    '这封邮件由 dsh-email-notify 发送',
  ].join('\n'))
})

test('离开模式那一行跟着页头开关走：关着写"关"，自动模式写"自动"', () => {
  const render = (value) => tidyText(renderTemplate(DEFAULT_BODY_TEMPLATE, turnEndVars({ 离开模式: value })))
  assert.match(render('关'), /离开模式：关/)
  assert.match(render('自动'), /离开模式：自动/)
})

test('默认模板里没有任何多余的空白行', () => {
  const body = tidyText(renderTemplate(DEFAULT_BODY_TEMPLATE, turnEndVars()))
  assert.doesNotMatch(body, /\n\n\n/, '不该出现连续空行')
  assert.equal(body.split('\n').length, 6, `实际 ${body.split('\n').length} 行`)
})

test('提问通知：{详情} 里是问题与选项，默认模板照样把它带出来', () => {
  const body = tidyText(renderTemplate(DEFAULT_BODY_TEMPLATE, turnEndVars({
    图标: '❓',
    状态: '等你回答',
    详情: '高级设置想要哪种？\n   · 原地折叠展开\n   · 真正的二级页面\n\n任务现在停在等你回答这一步，回到 harness 窗口作答才会继续。',
  })))
  assert.match(body, /状态：等你回答/)
  assert.match(body, /· 真正的二级页面/)
  assert.match(body, /回到 harness 窗口作答才会继续/)
})

test('正文里绝不出现内部会话 id（用户只认侧栏名）', () => {
  const body = tidyText(renderTemplate(DEFAULT_BODY_TEMPLATE, turnEndVars()))
  assert.doesNotMatch(body, /session-b4d28e9c/)
  // 想显式显示 id 的人得自己写 {会话ID}
  assert.match(renderTemplate('{会话ID}', turnEndVars()), /session-b4d28e9c/)
})

test('详细模板也是三行开头 + 时间/回合 + 最后回复', () => {
  const body = tidyText(renderTemplate(DETAILED_BODY_TEMPLATE, turnEndVars()))
  assert.match(body, /^工作区：/)
  assert.match(body, /时间：2026-09-13 18:20:05/)
  assert.match(body, /回合：第 5 轮 · 用时 7 分 24 秒/)
  assert.match(body, /已经收进二级页面。/)
})

/* ── 二、模板引擎的行为 ─────────────────────────────────────── */

test('认不出的占位符渲染成空，并且能被单独查出来（供保存时提示）', () => {
  assert.equal(renderTemplate('会话：{会话}\n工作区：{会化}', turnEndVars()), '会话：继续邮件通知插件工作\n工作区：')
  assert.deepEqual(unknownPlaceholders('{会话}{会化}{会话}{工作区x}'), ['{会化}', '{工作区x}'])
  assert.deepEqual(unknownPlaceholders(DEFAULT_BODY_TEMPLATE), [], '默认模板里的占位符必须全部合法')
  assert.deepEqual(unknownPlaceholders('一个花括号都没有'), [])
})

test('占位符两边带空格也认（用户手滑不会失效）', () => {
  assert.equal(renderTemplate('{ 会话 }', turnEndVars()), '继续邮件通知插件工作')
  assert.deepEqual(unknownPlaceholders('{ 会话 }'), [])
})

test('值里带大括号不会被二次解析（助手的回复里就有 JSON）', () => {
  const body = renderTemplate('{最后回复}', turnEndVars({ 最后回复: '{"ok":true,"value":"{会话}"}' }))
  assert.equal(body, '{"ok":true,"value":"{会话}"}')
})

test('空值所在行会被压掉；首尾空行也去掉', () => {
  assert.equal(tidyText('a\n\n\n\nb'), 'a\n\nb')
  assert.equal(tidyText('\n\n  \na\n\n'), 'a')
  assert.equal(tidyText('a\n   \nb'), 'a\n\nb', '纯空格行也算空行')
  // 空占位符那一行会变成空行，和相邻空行一起被压成**一个**空行 —— 这正是默认正文里
  // 尾注前只留一个空行的原因；不会撑出好几行空白。
  assert.equal(tidyText(renderTemplate('状态：{状态}\n{详情}\n\n尾注', { 状态: '已完成', 详情: '' })), '状态：已完成\n\n尾注')
})

test('占位符改过名也认旧名：老的 `{结果}` 模板不会突然变成空白', () => {
  // 0.5.0 及更早叫 `{结果}`，后来改成 `{状态}`。老模板必须继续能用。
  assert.equal(renderTemplate('结果：{结果}', turnEndVars()), '结果：已完成')
  assert.equal(renderTemplate('状态：{状态}', turnEndVars()), '状态：已完成')
  assert.deepEqual(unknownPlaceholders('{结果}'), [], '旧名不该被当成拼错')
  // 但清单里只列新名字
  assert.equal(PLACEHOLDERS.some((item) => item.key === '结果'), false, '清单里不该再出现旧名')
})

test('标题模板里的换行与多余空格会被压成单行', () => {
  assert.equal(renderSubject('任务{状态}\n·  {会话}', turnEndVars()), '任务已完成 · 继续邮件通知插件工作')
})

test('模板留空 = 用内置默认（以后改进默认值，没自定义过的用户自动受益）', () => {
  assert.equal(resolveTemplate('', DEFAULT_SUBJECT_TEMPLATE), DEFAULT_SUBJECT_TEMPLATE)
  assert.equal(resolveTemplate('   ', DEFAULT_SUBJECT_TEMPLATE), DEFAULT_SUBJECT_TEMPLATE)
  assert.equal(resolveTemplate(undefined, DEFAULT_BODY_TEMPLATE), DEFAULT_BODY_TEMPLATE)
  assert.equal(resolveTemplate('我自己的模板', DEFAULT_SUBJECT_TEMPLATE), '我自己的模板')
})

test('占位符清单每项都有名字和说明（设置界面直接拿它当说明书）', () => {
  for (const item of PLACEHOLDERS) {
    assert.equal(typeof item.key, 'string')
    assert.ok(item.key.length > 0)
    assert.ok(item.desc && item.desc.length > 0, `${item.key} 缺少说明`)
  }
})

/* ── 三、会话名来自侧栏（投影缓存） ─────────────────────────── */

test('从真实的投影缓存结构里取出侧栏名', () => {
  // 结构照抄 <DSH_HOME>/storages/session_projcache.json 的真实形状。
  const projection = {
    unit: { name: 'session_projcache', version: 1 },
    tables: {
      sessions: {
        'session-b4d28e9c-d696-47b0-8908-547f0180d025': {
          identity: { cwd: 'F:\\Space For AI work\\harness' },
          rows: {
            title: { ver: 1, seq: 365591, val: '继续邮件通知插件工作' },
            sessionStats: { ver: 1, seq: 1, val: { turns: 7 } },
          },
        },
      },
    },
  }
  assert.equal(pickProjectedTitle(projection, 'session-b4d28e9c-d696-47b0-8908-547f0180d025'), '继续邮件通知插件工作')
})

test('会话名缺失时返回空串，绝不猜、也绝不抛异常', () => {
  const projection = { tables: { sessions: { 'session-x': { rows: { title: { ver: 1, seq: 1, val: null } } } } } }
  assert.equal(pickProjectedTitle(projection, 'session-x'), '')
  assert.equal(pickProjectedTitle(projection, 'session-不存在'), '')
  assert.equal(pickProjectedTitle(projection, ''), '')
  assert.equal(pickProjectedTitle(null, 'session-x'), '')
  assert.equal(pickProjectedTitle({}, 'session-x'), '')
  assert.equal(pickProjectedTitle({ tables: { sessions: null } }, 'session-x'), '')
})

test('查不到的会话不会把整封邮件拖垮（titleFromProjection 只返回空串）', () => {
  assert.equal(titleFromProjection('session-肯定不存在的会话'), '')
  assert.equal(titleFromProjection(''), '')
})

test('投影缓存读不到时返回 null 而不是抛异常', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = join(process.cwd(), '一个不存在的目录-用于测试')
  try {
    assert.equal(readProjectionCache(), null)
    assert.equal(titleFromProjection('session-x'), '')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('本机真有一份投影缓存时，能从中读出非空的侧栏名（DSH 改了存储格式就会在这里报出来）', () => {
  const path = join(resolveDshHome(), 'storages', 'session_projcache.json')
  if (!existsSync(path)) {
    console.log('   · 本机没有投影缓存（没跑过 DSH）—— 跳过')
    return
  }
  const projection = readProjectionCache()
  assert.ok(projection, '存在缓存文件却解析不出来，说明 DSH 的存储格式变了')
  const sessions = Object.keys(projection?.tables?.sessions ?? {})
  assert.ok(sessions.length > 0, '缓存里应当有会话')
  const titled = sessions.filter((id) => pickProjectedTitle(projection, id))
  assert.ok(titled.length > 0, '应当至少有一个会话带侧栏名')
  console.log(`   · 本机 ${sessions.length} 个会话，其中 ${titled.length} 个有侧栏名`)
})

console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
