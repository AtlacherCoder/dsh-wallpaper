# dsh-wallpaper

把整个 DSH 网页铺上壁纸，并在同一个面板里显示**本次会话**的 token 用量。

- 背景：一张全页面壁纸（内置一张默认图，可上传替换、可调暗度 / 模糊 / 填充方式）
- 面板：侧边栏底部「壁纸」按钮打开（与设置/团队同尺寸、同节奏的文字按钮），右下角浮层；含壁纸选择、上传、删除、滑块、恢复默认
- 配色：四套深蓝色调（深蓝 / 墨蓝 / 午夜青 / 石墨），面板内可选；面板卡片、按钮、图标随配色变化，栏目（编辑栏、会话列表、菜单、悬停态）由重新着色的主题色阶一起变蓝 —— **壁纸本身不染色**
- 用量：`本次会话` 口径 —— 输入（未命中/命中缓存）、输出、推理、合计 token、步数，以及高峰/非高峰时段划分

## 安装（web profile）

```bash
dsh plugin --profile web add link:"/home/atlaslinux/Wallpaper Plugin/dsh-wallpaper"
```

或者手工两步：

1. 在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 里加
   `"dsh-wallpaper": "link:/home/atlaslinux/Wallpaper Plugin/dsh-wallpaper"`，
   并把 `dsh-wallpaper` 加进 `dsh.profile.bundles` 数组；
2. 在 `~/.dsh/profiles/web` 下执行 `pnpm install`，然后重启 `dsh web`。

之后壁纸面板随网页一起加载；卸载用 `dsh plugin --profile web remove dsh-wallpaper`。

## 它读什么、写什么

| 路径 | 内容 |
|---|---|
| `~/.dsh/sessions/**/session.v3.jsonl.zstd` | **只读**。用量数字来自会话日志里 `assistant/message` 事件携带的 `TokenUsage`，模型来自 `request/header` / `request/context` |
| `~/.dsh/wallpaper/config.json` | 显示配置（当前壁纸、暗度、模糊、填充、开关） |
| `~/.dsh/wallpaper/wallpapers/` | 你上传的壁纸文件 |

插件**不写**任何会话日志，也不改动 DSH 其它数据；状态放在 `~/.dsh/wallpaper/`，所以重装/升级插件不会丢你的选择。
（`DSH_WALLPAPER_HOME` 可覆盖该目录，测试脚本用它。）

## HTTP 接口

都在 `/dsh-wallpaper` 前缀下，只监听本机：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/dsh-wallpaper/api/state` | 配置 + 壁纸列表 + 实时用量 |
| GET | `/dsh-wallpaper/api/events` | SSE：用量/配置变化推送 |
| POST | `/dsh-wallpaper/api/config` | 局部更新配置（越界值会被夹紧） |
| POST | `/dsh-wallpaper/api/upload` | `{name, dataUrl}` 上传图片（png/jpg/webp/gif，≤约 9 MB） |
| POST | `/dsh-wallpaper/api/delete` | 删除某张用户壁纸（内置图拒绝删除） |
| GET | `/dsh-wallpaper/wallpaper/<id>` | 取壁纸文件（`default` 或 `user/<文件名>`） |

宿主侧另外提供 `ctx.wallpaper` 服务面，别的插件可以直接读用量：`config()` / `saveConfig()` /
`wallpapers()` / `sessionUsage()`。

## 配色

面板里「配色」一栏有四套深蓝色调，选了立即生效并持久化（`~/.dsh/wallpaper/config.json` 的 `scheme`）。

**换的是栏目本身，不是整页染色**：真正决定编辑栏、会话列表、菜单、悬停态颜色的，是主题里的
`--dsw-static-neutral-bluish-*` 这一条中性色阶（构建里现在是**近黑的灰**）。四套配色各自把这条色阶
**重新着色**，于是所有引用它的表面一起变蓝：

| 栏目 | 别名 | 引自色阶 |
|---|---|---|
| 编辑栏 / 卡片 / 主面板 | `alias-bg-layer-1` | `bluish-875`（暗）/ `bluish-00`（浅） |
| 菜单 / 弹层 | `alias-bg-layer-2` | `bluish-850` |
| 嵌套表面 | `alias-bg-layer-3` | `bluish-800` |
| 会话列表整列 | `specific-sidebar-fill` | `bluish-900` |
| 会话行悬停 / 选中 | `specific-sidebar-nav-item-hover` / `-active` | `bluish-850` / `bluish-750` |
| 插件/模块表面 | `alias-bg-module-platform` | `bluish-800` |

| id | 名称 | 色相 / 饱和度上限 | 暗色下的编辑栏 |
|---|---|---|---|
| `deep-blue` | 深蓝（默认） | 220° / 0.62 | `#101d38` |
| `ink-blue` | 墨蓝 | 226° / 0.68 | `#0e183a` |
| `midnight-cyan` | 午夜青 | 196° / 0.55 | `#122c36` |
| `mono` | 石墨（不偏蓝的退路） | 220° / 0.14 | `#1f2228` |

**色阶的明度不改，只换色相**：色阶的序号就是明度（`bluish-50` 最浅、`bluish-1000` 最深），主题用
`body` 给浅色模式、`body[data-ds-dark-theme]` 给深色模式绑定别名。所以插件保持构建里那条明度曲线、
只替换色相与饱和度 —— 浅色模式仍然和以前一样浅（只是偏蓝），深色模式的表面变成同一深度的蓝，
对比度和文字色阶都不用重做。反过来（把深色放到浅色端）会让浅色主题变成深蓝页面，`tools/ui-recolour-test.mjs` 专门守这条。

**壁纸本身不染色**：之前那版在画面上叠了一层 `mix-blend-mode: multiply` 的蓝色，已按你的要求撤掉。

纯白（`bluish-00`）不参与重新着色 —— 它是浅色模式的页面底色；最深的一档（`bluish-1000`）参与，
因为那正是深色模式的底色。

## 为什么没有金额

**这个插件不估算消费，也刻意不显示任何金额。** 曾经有过一版：内置一份 DeepSeek 官方价目表，按模型和
高峰/低谷分别计价，显示「预估消费 ¥x.xxxx」。它被**移除**了，原因不是算错，而是这类估算不可能可靠：

| 不可控因素 | 后果 |
|---|---|
| 官方随时调价 | 内置副本一过期就系统性偏差，而且偏差是静默的 |
| 法定节假日 | 官方节假日按低谷计价，本地没有任何权威日历可查 |
| 计费时刻口径 | 供应商按**请求**时刻判定高峰/低谷，日志只有**事件**时刻 |
| 缓存与重试的重叠 | 重试、失败请求、被中断的流在日志里的模样与账单口径未必一致 |

结论：与其给一个带免责声明的数字，不如只显示**日志真正记录了的东西** —— token 计数，以及高峰/非高峰
的时段划分（它能解释「为什么账单和 token 数不成正比」，而不假装自己是账单）。

## 验证

```bash
node tools/client-syntax-check.mjs  # 浏览器半契约 56 项（含点击穿透、配色覆盖）
node tools/host-smoke.mjs           # 宿主接口端到端 36 项（真实 HTTP + 真实壁纸字节）
node tools/ui-recolour-test.mjs     # 配色：读已安装主题的别名绑定，验证四套 × 深浅模式
node tools/usage-fold-test.mjs 4    # 用量折叠 与 会话日志原样重算逐字段比对（--disk 走磁盘路径）
node tools/crash-test.mjs           # 崩溃面：8 类恶意客户端，16 项
```

`usage-fold-test.mjs` 用一份**独立的**实现重新折叠真实会话日志，要求与插件逐字段一致 —— 这是「面板上的数字不是编的」的证据。
`crash-test.mjs` 在子进程里用 8 类恶意客户端打真实插件，把「未处理拒绝 / 未捕获异常」变成退出码。

## 仓库结构

```
README.md               # 本文件：功能、配色、验证方式
INSTALL.md              # 安装 / 卸载 / 回退步骤（可直接复制）
dsh-wallpaper/          # 插件本体 —— 把这一层挂进 profile
  package.json          #   dsh.bundle.patch + dsh.client（web）
  cordis.patch.yml      #   一行 insert，把自己挂进 profile
  lib/index.js          #   宿主半：路由 / 存储 / 用量折叠
  lib/client.js         #   浏览器半：壁纸层 + 配色 + 面板 + 页脚按钮 + 用量条
  assets/default-wallpaper.jpg   # 内置默认壁纸
tools/                  # 五个验证脚本（见上）
docs/                   # 决策日志、崩溃面审查、验证清单、回退点说明
```

## 安装

```bash
dsh plugin --profile web add link:/path/to/this/repo/dsh-wallpaper
```

装完重启 `dsh web`。卸载与回退见 [INSTALL.md](INSTALL.md)。

## 本轮验证读数

| 验证 | 命令 | 结果 |
|---|---|---|
| 浏览器半契约 | `node tools/client-syntax-check.mjs` | **56 项**全过（含「面板层必须保持点击穿透」这条 —— 它防的是一次真实事故：注册在 `shell.overlay` 时被宿主规则 `pointer-events: auto` 变成全屏挡板，把工作区选择器等控件点死） |
| 宿主接口（真实 HTTP） | `node tools/host-smoke.mjs` | 36 项全过 |
| 配色专项（四套 × 深/浅） | `node tools/ui-recolour-test.mjs` | 全过，含 WCAG 对比度；并把「宿主确实会给 overlay 子元素开 pointer-events」这条**从已安装的 DSH 包里读出来**做锚点 |
| 用量折叠（内存 / 磁盘） | `node tools/usage-fold-test.mjs [--disk]` | 与真实会话日志逐字段一致 |
| 崩溃面（8 类恶意客户端） | `node tools/crash-test.mjs` | 16 项全过，无崩溃向量 |
