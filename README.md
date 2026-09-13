# dsh-email-notify

**简体中文** · [English](README.en.md)

[![version](https://img.shields.io/badge/version-0.5.4-4176E6)](CHANGELOG.md)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
![deps](https://img.shields.io/badge/dependencies-0-success)
[![dsh-plugin](https://img.shields.io/badge/DeepSeek_Harness-dsh--plugin-1F6FEB)](https://github.com/topics/dsh-plugin)

[DeepSeek Harness](https://github.com/topics/dsh-plugin)（DSH）的邮件通知插件：人不在电脑前时，让 harness 发邮件叫你回来。

- **任务完成** —— 含出错、被中止
- **工具等待授权** —— 任务卡在等你点「允许」
- **助手等你回答** —— 邮件里带问题和选项

发不发由会话页头的**「离开模式」**按钮决定：出门前点一下，回来再点一下。
零依赖、纯本地发信，QQ / 163 / Gmail / Outlook / 自建 SMTP 都行。设置全在 DSH 的设置界面里，不用命令行、不用手改 JSON。

<p align="center">
  <img src="docs/img/away-button.png" width="560" alt="会话页头的「离开模式」按钮">
</p>
<p align="center">
  <img src="docs/img/email-phone.jpg" width="300" alt="手机上收到的通知邮件">
</p>

## 安装

```bash
dsh plugin --profile web add github:Vergil-long/dsh-email-notify
```

然后三步：

1. 重启 DSH 桌面应用（退出时会连后端一起重启）
2. 打开 **设置 → 邮件通知**，填邮箱账号和授权码。QQ 邮箱已预置服务器端口，只需去网页版邮箱开「IMAP/SMTP 服务」拿一个 16 位授权码（不是登录密码）
3. 到会话页头点开**「离开模式」**——0.4.0 起默认关着，不点开一封都不会发

Windows 上也可以双击仓库里的 `安装邮件通知.cmd`；从本地目录装用
`dsh plugin --profile web add link:/绝对路径/dsh-email-notify`（路径不要带空格，否则 pnpm 会报
`ERR_PNPM_SPEC_NOT_SUPPORTED`）。卸载：`node scripts/install.mjs --uninstall`。

升级：`node scripts/update-all.mjs`（或双击 `更新并修复.cmd`），一次做完"同步插件代码 + 打桌面外壳误报补丁"。

## 离开模式

页头最右侧的按钮是总闸：

| 按钮状态 | 行为 |
| --- | --- |
| `离开模式：开` | 勾选的通知发生就发邮件，不管你在不在看界面 |
| `离开模式：关`（默认） | 一封都不发 |
| `离开模式：自动`（按钮变灰） | 高级设置里开了「自动模式」：回到旧行为，判定"不在看界面"才发 |

为什么不让插件自动猜人在不在：它只能看到窗口有没有焦点，而"人走了、窗口还开着"恰恰是最常见的情况——
那时自动判定会以为你还在看，你在外面一封都收不到。所以把决定权交回给人，状态记在配置里、重启后保持。

## 邮件长什么样

标题和正文都是可编辑模板，15 个占位符（`{会话}` `{状态}` `{摘要}` `{用时}`……），设置界面里带实时预览。
默认模板很短，适合在手机上扫一眼：

```
工作区：F:\Space For AI work\harness
会话：继续邮件通知插件工作
状态：已完成
离开模式：开

这封邮件由 dsh-email-notify 发送
```

「等你回答」的邮件会展开问题和选项，回到窗口作答任务才继续。

<p align="center"><img src="docs/img/template-preview.png" width="480" alt="设置里的模板编辑与实时预览"></p>

## 设置

基础页只有两个框：邮箱账号、授权码。SMTP 服务器、通知时机、限流、自动模式这些都在
「高级设置 ▸」二级页里，默认值开箱即用。配置存在 `~/.dsh/dsh-email-notify/config.json`，
授权码只留在本机、读回界面时永远为空。

<p align="center"><img src="docs/img/settings-basic.png" width="520" alt="设置 → 邮件通知：基础页"></p>

完整字段说明、模板占位符全表、环境变量方式：[docs/配置参考.md](docs/配置参考.md)

## 常见问题

| 现象 | 说明 |
| --- | --- |
| 装完一封邮件都没有 | 离开模式默认关。到会话页头点开它 |
| `535` 报错 | QQ 邮箱要用 16 位授权码，不是登录密码 |
| 日志里「配置未完成，跳过发信」 | 设置里还有没填的，面板顶部会列出缺什么 |
| 邮件主题没有任务名 | 0.3.0 起显示左侧列表里的会话名；显示「（未命名会话）」说明标题还没生成 |
| 邮件里出现 `{会话}` 原文 | 宿主半侧还是旧版。跑 `node scripts/verify-live.mjs` 确认后同步并重启 |
| 其他 | 见 [docs/测试与排查.md](docs/测试与排查.md) |

## 文档

- [配置参考](docs/配置参考.md) —— 两级设置、模板占位符全表、config.json、环境变量
- [设计与架构](docs/设计与架构.md) —— 为什么不信外壳的 DOM 通知、代码结构、宿主端 HTTP 接口、设计取舍
- [测试与排查](docs/测试与排查.md) —— 8 套自检怎么跑、现场核验、完整故障对照表
- [修外壳误报通知](shell-patch/README.md) —— 独立于本插件可用的一键补丁
- [更新记录](CHANGELOG.md)

## License

[MIT](LICENSE)。项目由 Vergil-long 与 DeepSeek Harness 结对完成：需求与取舍由人定，编码、测试与文档由 AI 写。
