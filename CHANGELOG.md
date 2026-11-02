# 更新日志

Skillsmith 的版本记录。Release 正文默认取这里对应版本的段落。

## 未发布

**v1.1.0 — 与客户端真正联通（账本同步）**

这一版修的是本工具最根本的一个缺陷：**开关只生效了一半**。

过去的开关只动目录层（摘 junction / 删真实副本），但部分客户端除目录之外
还在自己的配置里另记一份「哪些技能被关掉过」。目录已经就位、客户端账本还记着
禁用时，客户端仍把它当关的 —— 表现就是「在本工具里开了，还得去客户端再开一遍」。
这是双份记账，不是单一真源。

本版新增：

- `client-state.js` —— 客户端账本适配层，统一三种账本格式：
  - `kv_lines`：CodeArts 的 `UserSkillStatus.txt`
  - `json_array`：Trae 的 `skill-config.json → disabledSkills`
  - `json_map`：WorkBuddy 的 `settings.json → skillOverrides`（开=删记录）
- WorkBuddy 与 WorkBuddy 国际版接入账本同步（此前完全没接）
- `core.verifyLedger()` + `GET /api/verify` —— 一致性自检：
  报告「目录已就位但客户端账本仍禁用」这类静默不一致
- `align-ledger.js` —— 以目录为准对齐客户端账本，默认 dry-run
- `verify-real-sync.js` —— 真实环境联通性验证：开关各一轮并断言两层同步
- `enable`/`disable` 的返回值区分「目录动了没」与「账本动了没」，
  便于排查「为什么客户端还是不生效」

安全约定（写的是用户真实配置，必须克制）：JSON 解析失败时**拒绝写入**
而不是重建；写盘前备份到 `~/.agents/skillsmith/backups/`；先写临时文件再 rename；
内容无变化不写盘。

测试：新增 `test_client_state.js`（30 项），全量 84 项通过。

## v1.0.1

**Skillsmith v1.0.1 — 智能体管理增强 + 不支持客户端保护 + 搬家修复**

跨 AI 客户端的共享技能开关工具。本版从 `mv-image-pipeline` 仓库独立成
[`kuoleroy/skillsmith`](https://github.com/kuoleroy/skillsmith)，成为通用软件。

### 新增

- 智能体管理：每行可改开关机制（junction / realdir）与状态清单位置
  （路径 / 格式 / 字段名）—— 客户端装在非默认位置时不用删了再加
- 新增端表单补「状态清单格式」与「json 字段名」

### 修复

- 清空状态清单会被内置默认值覆盖（空串被 `if (x)` 过滤掉）
- 启停按钮会丢掉自定义的状态清单位置
- **真源搬家后「重新绑定」形同虚设**：搬家会让所有端的 junction 同时断链，
  而 rebindAll 用 stat()（跟随链接）探测技能项，断链的会被丢弃，
  结果一个链接都没重绑；makeJunction 用 existsSync 判存在性，同样误判断链链接。
  两处都改成用 lstat 识别断链项，现在搬家后重新绑定能正确重指全部端

### 保护

- TeleAgent 明确不支持接入 —— 保存时拒绝并说明原因；
  即便手工改 `agents.json` 塞进它的路径，它也不会进生效映射，
  开关 / 批量 / 重新绑定一律不碰它

### 其它

- 仓库只放源码，安装包走 Release 附件（与 v1.0.0 一致）
- 真源地址可在设置里改，改址后用「重新绑定所有端」把各端链接重指过去

## v1.0.0

**Skillsmith v1.0.0 — 智能体技能管理软件**

跨 AI 客户端的共享技能开关工具。桌面版（Electron）+ 浏览器版共用同一套后端。

### 功能

- 10 个 Agent 端开关联动：WorkBuddy / WorkBuddy 国际版 / Claude Code /
  CodeBuddy / Codex(旧) / OpenCode / Trae CN / Trae 国际版 / 华为 CodeArts / 阿里 Qoder
- 批量开关：全部关闭 / 精简模式 / 全部开启
  （普通对话关掉 skills，用时再开 —— 能省下约 70% 的技能描述 token）
- 智能体管理：新增 / 删除 / 重命名 / 启停任意厂商的端
- 共享技能真源地址可配，改址后可「重新绑定」把各端链接重新指向新位置
- 路径面包屑 + 应用菜单（设置 / 窗口 / 帮助 / 关于）

### 安全

- 真源 `~/.agents/skills` 永远只读，永不删除
- 摘链接前校验确实是 junction，避免顺着链接误删真源
- 写操作跨进程加锁，多实例同时运行不会互相覆盖

### 技术

- 前端复用开源 [whale2002/skills-switch](https://github.com/whale2002/skills-switch)（MIT）
  的 React 产物，逻辑零改动
- 自研后端适配各端的加载差异（Junction / 真实目录副本 / 状态文件清单）
- 打包版由 GitHub Actions 自动构建，仓库只放源码
