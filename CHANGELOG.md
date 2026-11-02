# 更新日志

Skillsmith 的版本记录。Release 正文默认取这里对应版本的段落。

## 未发布

**v1.1.0 — 客户端账本同步 + 技能安装**

两件事：把「开关」打通到客户端真正读取的地方；把「装」做成一条可检查的链路。

### 一、与客户端真正联通（账本同步）

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

### 二、技能安装（真源管理器）

从「开关面板」扩展成「安装入口」。界面还没有入口，先做后端与 CLI。

- `manifest.js` —— 清单容错解析
  支持 YAML 子集（多行块 `|`、折叠 `>`、行内数组、列表），剥 BOM，字段缺失不当错误。
  实测 12 个真实技能：11 个有 frontmatter、1 个是 BOM 开头、只有 1 个声明了 version ——
  所以「缺版本」必须能容忍，不能要求作者整改。
  技能名过 `validateName`（挡路径穿越、Windows 保留名、结尾点/空格）。

- `safety.js` —— 安全扫描，分级只报告不拦截
  代码风险：管道执行（`curl | sh`）、PowerShell 下载执行、base64 解码执行、
  读 SSH 私钥 / 云凭据 / 浏览器密码库、上传本地文件、递归删家目录、
  计划任务与注册表自启动、写 System32、夹带 `.exe/.dll`。
  提示词风险（技能独有）：`忽略之前的指令` 类改写话术、零宽字符藏字、
  HTML 注释藏指令。
  不禁用的原因：合法技能天天调 API，一刀切会把正常技能挡在门外，
  用户学到的只会是「关掉检查」。判断权交人。

- `installer.js` —— 安装 / 卸载 / 纳管
  来源：本地文件夹、`owner/repo`、仓库 URL、`owner/repo#subdir`、GitHub `/tree/` 路径。
  两步式：`preview` 只读不写盘，`install` 重新拉取并比对 commit ——
  「预览里看到的」就是「装进去的」。
  monorepo 自动定位技能根；多个技能时不猜，要求指定子目录。
  元数据写 `~/.agents/skillsmith/installed.json`，**不进技能目录**（避免污染真源、避免被客户端读进上下文）。
  已装清单区分 `installed` / `missing`（记录在目录没了）/ `unmanaged`（手工放入未纳管）。

- API：`GET /api/installed`、`POST /api/install/preview`、`POST /api/install`、
  `POST /api/uninstall`、`POST /api/adopt`
- CLI：`node skillsmith.js preview|install|list|remove|adopt`

两个实测抓到的 bug（都是「看起来正常、实际失效」那种）：

- 扫描器把 `curl -fsS`（fail+silent）误判成 `-F`（表单上传）——
  正则加了 `i` 标志，12 个真实技能报出 7 个假高危。改成区分大小写。
- 扫描器把 `ENV_API_KEY` 里的 `ENV` 当成 `env` 命令 —— 缺词边界。补 `\b`。
- git 来源落在仓库根时，拿临时目录名（`skillsmith-fetch-xxxx`）去和 frontmatter
  比对，误报「名字不一致」。改成只在目录名有意义时才比对。

### 三、安装界面与本地搜索

侧边栏「＋ 安装技能」打开面板，两个 tab：本地（可用）、在线（占位）。

- `search.js` —— 本地模糊搜索
  四字段加权（name 10 / title 8 / tags 6 / description 3），
  多词 AND（`comfy 视频` 只出同时沾边的）。
  命中质量分档：相等 1.0 · 前缀 0.85 · 词边界 0.8 · 包含 0.7 · 子序列 0.3。
  两处实测调出来的边界：
  · **子序列只在名字/标题/标签上开**，描述上开会把 `mvi` 命到
    `browser-cli-skill` 这种毫不相关的技能
  · **子序列有密度闸**（hit/span ≥ 0.4）：`mvi` 命中 `mv-image-pipeline`
    跨 4 位可以通过，`comfyui-minimax-h3-video` 跨 19 位被挡掉
  多词 AND 全空时退回 OR 并标 `partial` —— 否则用户以为搜不到。
  索引 2 秒 TTL 缓存，安装/卸载/纳管后显式失效。

- `vendor/install-panel.js` —— 安装与搜索面板
  搜索框防抖 220ms；结果按状态标签（已安装/手工放入/记录残留）着色；
  点条目展开详情（来源、版本、体积、安装时间、卸载/纳管）；
  预览页把安全发现按级别列出（规则名 + 文件:行号 + 原因 + 证据原文）。
  预览时底部固定成「← 返回列表 / 安装」，不跟内容滚出屏幕。

- 在线 tab 明确写「建设中」并说明将来的三步计划。
  不做点了没反应的假按钮 —— 那比没有更糟。

### 四、修掉一个打包漏文件

`electron/stage.js` 打包时用的是硬编码白名单
（`core/server/agent-config/settings`）。后来陆续加了
`client-state / manifest / safety / installer / search`，白名单没跟上 ——
打出来的安装包 `require` 不到模块，**一启动就崩**。
本地 `npm start` 完全正常，只有装到别人机器上才炸，属于最难定位的一类。
改成扫根目录所有 `.js`（排除测试与命令行入口）。

测试：新增 `test_safety.js`（31 项，含真实误报回归）、`test_installer.js`（63 项）、
`test_search.js`（34 项），全量 **214 项**通过。

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
