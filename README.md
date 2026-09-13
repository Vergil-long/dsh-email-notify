# dsh-email-notify

[DeepSeek Harness](https://github.com/deepseek-ai)（dsh）的邮件通知插件：**我不在 harness 窗口前的时候**，用邮件告诉我

- ✅ **任务完成**（回合结束，含出错 / 被中止）
- 🔐 **需要我授权**（工具请求提权、沙箱越界，任务卡在等我点「允许」）
- ❓ **助手在等我回答**（`ask_user_question` 提问，任务卡在等我选）

我**正在看着 harness 界面**时不发邮件——那时界面上本来就有提示，邮件只会是噪音。
全部设置都在 harness 的 **设置 → 邮件通知** 里，不用命令行、不用手改 JSON。

> 用哪个邮箱都行（QQ / 163 / Gmail / Outlook / 自建 SMTP）。默认预置 QQ 邮箱（`smtp.qq.com:465` + 授权码）。

---

## 为什么需要一个插件来做这件事

DSH 桌面外壳本来就有"任务完成"通知，但它是靠**扫描左侧会话列表的 DOM 文本**猜出来的：
会话标题在运行中一变，旧的那条就被当成"运行中的任务消失了"，于是误报成"已完成"。
把外壳日志和真实会话日志做时间对齐后可以看到：**190 次通知里有 161 次是在回合还在运行时弹出的**，
很多发生在回合开始后 0.1~3 秒（标题刚生成的那一刻），只有 26 次接近真正的 `turn/end`。

所以本插件不猜 DOM，直接订阅权威事实：

| 通知什么 | 依据 |
| --- | --- |
| 任务完成 | 会话事件 `turn/end`（带 `reason.kind`：completed / error / stopped …） |
| 需要授权 | 会话事件 `approval/asked`（ApprovalService 在等决策前写入日志的审计事实） |
| 等我回答 | `tools/pre-execute` 里看到 `ask_user_question`（**只观察，原样 `next()` 委托**，绝不抢夺门禁决策） |
| 是否在看界面 | 浏览器半侧上报 `document.hasFocus()` + `visibilityState`（窗口有焦点且可见 = 在看） |

---

## 安装

零依赖，不需要联网装包，也不需要 `pnpm install`。

**方式一：从 GitHub 装（推荐）**

```bash
dsh plugin --profile web add github:Vergil-long/dsh-email-notify
```

**方式二：从本地目录装**

```bash
# ① 把仓库克隆/复制到任意目录，然后把它登记进 profile
dsh plugin --profile web add link:/绝对路径/dsh-email-notify

# 或者用仓库自带的脚本（会复制到 ~/dsh-email-notify、建目录联接、改 profile 配置）
node scripts/install.mjs            # 先看会改什么：node scripts/install.mjs --dry
```

Windows 上也可以直接双击 `安装邮件通知.cmd`。

装完**重启 DSH 桌面应用**（退出时会连后端一起重启），然后打开 **设置 → 邮件通知** 填账号。
卸载：`node scripts/install.mjs --uninstall`，或 `dsh plugin --profile web remove dsh-email-notify`。

> **已经装过、只想升级**：`node scripts/update-all.mjs`（或双击 `更新并修复.cmd`）会一次做完
> "同步插件代码 + 打桌面外壳的误报通知补丁"，顺序固定、可 `--dry` 预演。
> 外壳补丁要求 DSH 已退出；还在运行时它会只做插件部分并提示你稍后补跑。

> 注意：安装路径**不要带空格**，否则 pnpm 的 `link:` 依赖会报 `ERR_PNPM_SPEC_NOT_SUPPORTED`。
> 本仓库的安装脚本默认把插件放到 `~/dsh-email-notify`（无空格）就是为了避开这个坑。

---

## 配置（都在设置界面里）

打开 DSH → **设置 → 邮件通知**：

| 分组 | 内容 |
| --- | --- |
| **邮件通道** | SMTP 服务器、端口、账号、授权码、发件人、发件显示名、收件地址、是否使用 TLS、是否校验证书、是否允许无 TLS 明文发送 |
| **通知时机** | 任务完成 / 需要授权 / 向我提问 三个开关；是否也给子会话发；三个"看界面时也弹提示"开关 |
| **邮件内容** | 是否附上提问与回复摘要、摘要长度、主题前缀、正文里的地址 |
| **限流与判定** | 同类通知最小间隔、每分钟上限、心跳过期判定、总开关 |

三个按钮：**保存设置**（写回 `config.json` 并立即生效，不用重启）、**发送测试邮件**（用界面上的草稿试发，没保存也能试）、**重新读取**。

面板顶部会显示当前状态：配置是否就绪、**此刻是否被判定为"你正在看界面"**、上次发信成功还是失败。

QQ 邮箱先做这一步：网页版邮箱 → 设置 → 账户 → 开启「IMAP/SMTP 服务」→ 生成**授权码**（16 位，**不是登录密码**）。

### 配置文件

设置在 `~/.dsh/dsh-email-notify/config.json`（Windows：`C:\Users\<你>\.dsh\dsh-email-notify\config.json`）。
设置界面读写的就是它；也可以手改，改完保存即生效。授权码只存在本机，**读回界面时永远为空**（留空 = 不修改）。

密码也可以不落盘：设环境变量 `DSH_EMAIL_NOTIFY_PASS`（可选 `DSH_EMAIL_NOTIFY_USER`），配置里 `pass` 留空即可，
界面会提示"由环境变量提供"。

---

## 自检与排查

```bash
npm test                            # 全部自检用例（清单 / 脚本 / 协议层 / 触发判定 / 浏览器半侧 / 外壳补丁）
node scripts/verify-live.mjs        # ★重启后第一件事：现场核验（插件加载没有、外壳补丁打没有）
node test/manifest.test.mjs         # 清单自检：能不能被 DSH 装上并加载（最易静默失败的一层）
node test/scripts.test.mjs          # 脚本纯函数（如从注册表输出推出 app.asar 路径）
node test/smtp.test.mjs             # 本地假 SMTP 服务器跑完整对话
node test/plugin.test.mjs           # 触发判定：看界面不发、离开才发、去重、节流、提问、设置接口
node test/client.test.mjs           # 浏览器半侧：在场上报、提示退化、设置面板
node shell-patch/test-completion-bridge.mjs  # 外壳注入脚本行为（原版 vs 修补版对照）
node test/live-probe.mjs            # 真连 smtp.qq.com:465，只握手不发信（验证网络/端口）
node scripts/send-test.mjs --check  # 只看配置填全没有
node scripts/send-test.mjs --trace  # 真发一封并打印完整 SMTP 对话（凭据已隐藏）
```

`scripts/verify-live.mjs` 会逐项报告：宿主半侧是不是新版、配置是否就绪、当前是否判定为"你在看界面"、
**浏览器半侧有没有被装配进页面**（读页面里的 `window.__DSH_BOOT__` 清单）、bundle 能不能取到、
已安装副本与源码是否一致、桌面外壳补丁打了没有 —— 每项不过都会给出该怎么修。

运行中查看状态：`http://127.0.0.1:3080/dsh-email-notify/status`

| 现象 | 原因 |
| --- | --- |
| `535` + 中文提示 | 账号或授权码不对：QQ 要用授权码，不是登录密码 |
| 日志里 `配置未完成，跳过发信` | 设置界面里还有没填的（面板顶部会列出缺什么） |
| 明明在看界面却收到邮件 | 窗口没焦点（切到别的程序 / 最小化 / 别的窗口在顶层）就算"离开"，符合预期 |
| 看界面时收不到插件提示 | 默认 `notifyWhenFocused=false`：桌面外壳自己会弹完成通知。想让插件接管请在设置里打开 |
| 收到邮件但主题没有任务名 | 0.2.0 已修（回读会话日志里的标题）；请确认插件版本 |

---

## 结构

```
lib/smtp.js          零依赖 SMTP 客户端（465 隐式 TLS / 587 STARTTLS / AUTH LOGIN·PLAIN，
                     RFC 2047 中文主题、base64 正文、可读的中文错误提示、可选协议追踪）
lib/config.js        配置读写：白名单字段、口令不回显、原子写入、空模板
lib/index.js         宿主端：订阅 turn/end、approval/asked、ask_user_question，
                     按"是否在看界面"决定发邮件还是排界面提示；提供本地 HTTP 接口
client/client.js     浏览器半侧：上报窗口焦点/可见性、轮询提示队列并弹系统通知
                     （退化方案：界面内浮层卡片）、渲染「设置 → 邮件通知」面板
scripts/install.mjs  安装/卸载（复制 + 目录联接 + 改 profile 配置，可 --dry）
scripts/send-test.mjs 命令行发信自检
shell-patch/         修桌面外壳"任务一开始就弹完成通知"的误报（自带 asar 读写、校验与行为自检）
test/                假 SMTP 服务器 + 假 cordis 上下文 + DOM/React 桩的自检用例
tools/               诊断工具（外壳误报通知的时间对齐分析）
```

宿主端 HTTP 接口（都只绑在 127.0.0.1 的 DSH web 服务上）：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/dsh-email-notify/presence` | 客户端上报 `{clientId, focused, visible}` |
| GET | `/dsh-email-notify/inbox?since=N` | 取"看着界面时"的提示队列（带游标） |
| GET | `/dsh-email-notify/config` | 读配置（口令只报是否已设置） |
| POST | `/dsh-email-notify/config` | 写配置（白名单字段，口令留空 = 不改） |
| GET | `/dsh-email-notify/status` | 诊断信息（含当前是否判定为"在看界面"、上次发信结果） |
| POST | `/dsh-email-notify/test` | 发测试邮件，可传入界面上的草稿配置 |

---

## 设计取舍

- **为什么"在看界面"由浏览器半侧判定**：只有页面知道 `hasFocus()` 与 `visibilityState`。
  心跳 20 秒一次（不监听鼠标键盘，免得每次敲键都刷接口），焦点/可见性变化即时上报；
  宿主端 90 秒收不到心跳就当客户端不在了（关窗口、崩溃、断线都覆盖）。
  没有任何客户端时按"不在看"处理——宁可多发一封，也不要漏掉完成通知。
- **为什么不订阅 `approval/request` 瀑布事件**：那是个 waterfall，监听器必须正确地 `next()` 委托，
  一不小心就会抢走别人的授权决策。而 `approval/asked` 是服务自己写入会话日志的审计事实，
  既权威又零风险。同理，`ask_user_question` 只从 `tools/pre-execute` **旁听**并原样委托。
- **为什么自己写 SMTP**：DSH 运行时的 `node_modules` 里没有 nodemailer，
  而这个插件要以"复制 + 目录联接"的方式装配，不能依赖需要联网安装的包。
- **去重与节流**：同一回合的 `turn/end`、同一次授权的 `approval/asked`、同一次提问的 `callId`
  各只处理一次（30 分钟窗口）；同类通知按会话节流，另有全局每分钟上限防死循环。
- **默认拒绝明文发信**（`allowInsecure: false`）：没有 STARTTLS 的服务器上继续发信等于把授权码明文丢出去，
  宁可失败也得说清楚；确实要发（本机中继）才在设置里打开。

## 相关

- 更新记录：[CHANGELOG.md](CHANGELOG.md)
- **修桌面外壳的误报通知**：桌面程序那条"任务完成"通知有 85% 是误报（任务一开始就弹），
  原因、修法与一键脚本见 [`shell-patch/`](shell-patch/README.md)：
  `node shell-patch/patch-completion-notify.mjs`（可 `--dry` 预演、`--revert` 撤销）。
- 量化诊断工具：`node tools/analyze-desktop-notifications.mjs`
  （把外壳日志与真实会话日志按时间对齐，统计误报比例）。

MIT License.
