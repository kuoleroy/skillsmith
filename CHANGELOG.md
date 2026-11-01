# 更新日志

Skillsmith 的版本记录。Release 正文默认取这里对应版本的段落。

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
