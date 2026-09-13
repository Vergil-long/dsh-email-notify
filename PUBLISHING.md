# 发布指南

这个仓库可以直接推到 GitHub（也可以发到 npm）。下面是照着做就行的步骤，以及几个**会让你少踩坑**的提醒。

---

## 1. 发布前跑两条命令

```bash
npm test                          # 8 套自检 + 发布安全检查，全绿再往下走
node scripts/check-publish.mjs    # 单独再扫一遍隐私（会跳过 项目说明.md 与 config.json）
```

`check-publish` 会遍历工作区里的文本文件，找这三类东西：

| 规则 | 会被抓到的样子 |
| --- | --- |
| 私人邮箱前缀 | 把作者真实的邮箱地址写进仓库（本仓按作者邮箱前缀判定） |
| 真实的 Windows 用户目录 | `C:\Users\<真实用户名>\...`（`C:\Users\<你>\...` 这类占位会被放过） |
| JSON 里疑似真实的密码/授权码 | 配置模板里写了 6 位以上的口令 |

> 公开的 GitHub 账号名**不算**泄露——安装命令 `dsh plugin add github:<账号>/dsh-email-notify`
> 和包元数据里必须写它，所以规则不拦它。

---

## 2. 推到 GitHub（GitHub Desktop）

1. 打开 GitHub Desktop → **File → Add local repository**
2. 选这个文件夹：`F:\Space For AI work\harness\dsh-email-notify`
3. 右上角 **Publish repository**
   - 仓库名建议：`dsh-email-notify`
   - **取消勾选 "Keep this code private"**（要给别人装就得公开）
4. Publish 之后点仓库页右上角的 ⚙️ **About**，填：

   **Description**
   ```
   DeepSeek Harness 邮件通知插件：不在 harness 窗口前时，用邮件告诉你任务完成 / 工具等你授权 / 助手在等你回答。设置全部集成在 harness 设置界面里。
   ```
   **Topics**（逗号分隔）
   ```
   dsh-plugin, deepseek-harness, deepseek, dsh, email, smtp, notification, qq-mail
   ```

   `dsh-plugin` 这个 topic 很关键：DSH 里的插件发现功能就是按 GitHub 的这个 topic 搜的，
   加上它别人才能搜到这个插件。

> 仓库里已经 `.gitignore` 了 `config.json`（含授权码）、`项目说明.md`（工作区交接文档，
> 里面有本机路径与个人邮箱）、`shell-patch/.work/`（演练用的中间产物）。**不要**把它们强制加进仓库。

---

## 3. 可选：发到 npm

想让人用 `npm i dsh-email-notify` 装，就往 npm 发一份。参考同作者的 `dsh-custom-font` 流程，注意三点：

1. `package.json` 里已经有 `publishConfig` 吗？本仓库**没有**——如果要发 npm，加上：
   ```json
   "publishConfig": { "registry": "https://registry.npmjs.org/" }
   ```
   （不加的话，本机 npm 若指向 npmmirror 之类只读镜像会直接失败。）
2. npm 现在强制 2FA，且只剩「安全密钥」一种方式：用 Windows Hello 当安全密钥，**前提是先设好 PIN**，
   浏览器建议 Edge/Chrome。
3. 发布前确认 `files` 字段覆盖到位（`lib` / `client` / `scripts` / `cordis.patch.yml` / 文档），
   `test/manifest.test.mjs` 已经会检查 `files` 里列的每一项都真实存在。

---

## 4. 版本与更新记录

- 改了功能就顺手上调 `package.json` 的 `version`，并在 `CHANGELOG.md` 顶部加一节。
- 提交信息建议保持现在这个风格：一行说清"做了什么"，正文列要点（中文没问题）。

---

## 5. 发布之后的两件事

| 事情 | 说明 |
| --- | --- |
| **DSH 桌面程序自动更新会抹掉外壳补丁** | 那和本插件无关（插件装在 `~/.dsh` 里，不受影响）；但 `shell-patch` 打的补丁在 `resources\app.asar` 里，更新后要重跑 `修复桌面误报通知.cmd` |
| 别人报问题时让他先跑 | `node scripts/verify-live.mjs`——一条命令就能看出是"没装上""没重启"还是"配置没填" |
