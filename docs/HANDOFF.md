# 交接摘要 · dsh-wallpaper（第 1 轮）

## 一句话

DSH 壁纸插件已做好并**装进 web profile**，功能在真实进程上验证通过；剩下**唯一一格未打勾**是「人眼看着刷新后的页面」，因为本机没有浏览器自动化工具。

## 交付物

| 路径 | 说明 |
|---|---|
| `dsh-wallpaper/` | 插件本体（宿主半 + 浏览器半 + 内置壁纸 + patch 行），可独立拷走 |
| `dsh-wallpaper/lib/index.js` | 宿主半：`/dsh-wallpaper` 路由、配置与壁纸库、会话用量折叠与计价 |
| `dsh-wallpaper/lib/client.js` | 浏览器半：壁纸层 + 面板 + 作曲器下方用量条 |
| `dsh-wallpaper/assets/default-wallpaper.jpg` | 用户给的那张图（1430×1039，322,731 字节） |
| `INSTALL.md` | 安装/回退（装配已执行，留档备查） |
| `docs/DECISIONS.md` | 8 条已定决策 + 依据 + 代价，6 条未做 |
| `docs/VERIFY-ROUND.md` | 契约/数据/接线/目视 四层验证清单（前三层已勾，附真实读数） |
| `docs/rollback/R-001/` | 本轮交付快照（插件 + 工具脚本 + INSTALL） |
| `docs/CRASH-REVIEW.md` | 崩溃面审查：三条路径、6 个真实缺陷、测试边界、未消除风险 |
| `tools/*.mjs` | 五个可重复执行的脚本（客户端契约 / 宿主接口 / 用量两种路径 / 崩溃测试 + 其子进程 harness） |

## 第 2 轮追加：崩溃面审查

用户要求「检查一下，防止 dsh 崩溃」。详见 `docs/CRASH-REVIEW.md`。要点：

- 三条崩溃路径（未处理拒绝 / 响应流未消费的 error / 加载期抛异常）已按防御性写法处理；
- 顺带修掉 6 个**真实**缺陷，其中最要紧的是 **浅色主题会被硬编码白字压成不可读** —— 已改为通过
  `ctx.theme.overrideTokens` 叠加明暗成对 token，且不再覆盖任何文字色；
- 新增 `tools/crash-test.mjs`（子进程 + 8 类恶意客户端，把未处理拒绝变成退出码）；
- **诚实边界**：把守卫全拆掉的版本也通过该测试 → 它是「未发现向量」，不是「修复证明」。脚本注释里写明了。

## 第 3 轮：删除金额

用户反馈「预估消费还是删掉吧，感觉不太准」，并要求「删掉后 UI 不要留空」+「再确保一次不会崩」。已做：

- 宿主：删除 `PRICING` 价目表、`priceUsage()`，用量行不再有 `costCNY`/`unitPrices`，`/api/state` 不再返回 `pricing`；
- 面板：删掉「预估消费」行、「单价说明」按钮及其展开内容；空出来的位置**用真实数据补满** —— 合计行
  （`合计 231,061 tok · 172 步 · 输入 … / 输出 …`）+ 高峰/非高峰两行（并入同一张表，避免两表列宽不一致的视觉空隙）；
- 侧边栏按钮与作曲器下方的用量条：去掉金额，改为 token 数（用量条补上输入/输出）；
- 测试：金额断言 → 反转为「金额字段必须不存在」；客户端新增面板内容断言（见 `docs/CRASH-REVIEW.md` 第 5 节）；
- 崩溃面：五套件 + 真实实例恶意请求复验，全过。

## 第 4 轮：配色 + 页脚按钮

用户要求「UI 换成深蓝色调 + 一点缀，并做成 UI 里的颜色选项」和「按钮换成文字、与团队 UI 统一」。已做：
四套深蓝配色（面板内可选、持久化、含画面染色层）；页脚按钮改成照抄 shell/团队规格的文字按钮 + 内联 SVG 图标；
`applyScheme` 的 DOM 守卫与旧层迁移（见 `docs/CRASH-REVIEW.md` 第 6 节）。客户端断言扩到 41 项。

## 第 5 轮：修页脚按钮挤掉团队按钮

用户截图报「你把团队的按钮挤出去了」。根因是共享 flex 行里照抄了设置按钮的 `width:100%` + 负外边距，
溢出不裁切把邻居推出侧栏；已改为内容宽度 + 6px 间距 + 隐藏长数字，并加 3 项防回归断言（客户端共 48 项）。
详见 `docs/DECISIONS.md` D-11 与 `docs/CRASH-REVIEW.md` 第 7 节。

## 第 6 轮：配色改为换栏目颜色

用户澄清「调整 ui 的颜色是指栏目（编辑栏/会话列表…），不是整体颜色」。已撤掉整页染色层，改为重着色主题的
中性色阶 `--dsw-static-neutral-bluish-*`（保留明度曲线，只换色相与饱和度），于是编辑栏、会话列表、菜单、
悬停态一起变蓝而壁纸不受影响。新增 `tools/ui-recolour-test.mjs` 直接读已安装主题的别名绑定做验证。
本轮抓到两个真实缺陷（色阶方向填反、ramp 返回对象而消费端按元组解构导致整层静默失效），详见
`docs/CRASH-REVIEW.md` 第 8 节。

## 第 7 轮：白色下拉框 + 两处结构修正

用户截图指出面板里的会话下拉是白底浅字。修法是给表单控件显式声明表面 + `color-scheme`（展开列表由平台绘制）。
同时修正两处结构问题：改为覆盖**别名**而不是主题的静态色阶（避免样式表顺序竞争导致静默失效）；
`bg-base` 不再强制透明（浅色模式下白卡片不该透出壁纸）。新增 WCAG 对比度断言。详见
`docs/CRASH-REVIEW.md` 第 9 节。

## 第 8 轮：回退到静态色阶方案（R-001）

用户要求「回退到上一步的成品」。上一步 = 第 6 轮的**静态色阶方案**（重着色
`--dsw-static-neutral-bluish-*`，保留明度曲线只换色相）。第 7 轮的别名覆盖 + 表单控件补丁已整体撤下，
但**保留在 `docs/rollback/R-002-current/`** 里，随时可以换回来。

详见 `docs/ROLLBACK.md`（含两个快照的差异、互换方法与各自已知隐患）。

> 流程缺陷（已修）：此前每轮都把 `docs/rollback/R-001/` 覆盖成当前版本，等于没有回退点。
> 现在每个回退点独立目录、只增不改。

## 当前状态（实测）

- **已装**：`~/.dsh/profiles/web/package.json` 有 `"dsh-wallpaper": "link:/home/atlaslinux/Wallpaper Plugin/dsh-wallpaper"`，`dsh.profile.bundles` 末位有 `dsh-wallpaper`；`pnpm install` 已建软链。
- **已验**：`dsh --profile web --dump-config` 输出含该行；`dsh web --port 3099` 真实启动后：
  - `/dsh-wallpaper/api/state` → 200，返回真实用量（本轮会话 172 步、231,061 tok、预估 ¥1.7879）
  - 索引页 boot graph 含 `dsh-wallpaper/client.js`；combo 路由 → `200 text/javascript`
  - `/dsh-wallpaper/wallpaper/default` → `200 image/jpeg 322,731 bytes`，与仓库文件逐字节一致
- **未验**：人眼目视（壁纸铺开效果、面板外观、滑块手感）。

## 下一步（只需用户做两件事）

1. 打开验证实例（**不影响现有 3080 窗口**）：
   `http://127.0.0.1:3099/?token=…`（完整 URL 见 `docs/VERIFY-ROUND.md` 末节；该实例是后台任务，会话结束后会被回收）
2. 看一眼并回话：壁纸是否铺满、侧边栏底部 🖼 按钮、面板里的数字、暗度/模糊滑块、上传换图。
   确认后若要让它常驻在自己的 3080 窗口，**重启一次 `dsh web`** 即可（重启会清空内存会话表，此时面板走「读最近日志」的只读回退，仍能显示用量）。

## 坑清单（本机/本插件特有）

1. **客户端 bundle 必须自建 CJS 信封**：`factory(require)` 里要自己 `var module = { exports: {} }` / `var exports = module.exports`，否则浏览器里 `exports is not defined`（Node 里 `--check` 查不出来，必须真的 `new Function` 跑一遍 —— `tools/client-syntax-check.mjs` 就是干这个的）。
2. **bundle 路径由 `exports["./client"]` 决定**，不是固定 `client.js` 位置；`dsh.client.platform` 必须是 `web`，否则整个客户端模块被静默忽略（`dsh.client.inject` 会被当模块 id 解析，所以留空最安全）。
3. **`shell.overlay` 是 click-through 层**：面板外层必须 `pointer-events: none`，卡片自身 `auto`，否则整个应用点不动。
4. **当前会话 id 只有浏览器知道**：权威来源是 `conversation.composer.dock`（session 作用域）的 `sessionId` prop；宿主 HTTP 请求里没有会话上下文。
5. **DSH 不落盘账单**：唯一的用量真源是会话日志里 `assistant/message.usage`（官方注释：there is no separate usage record）。
6. **会话日志是「多帧 zstd 串联」**，`zstdDecompressSync` 一次只解一帧，必须循环跳帧魔数 `28 b5 2f fd`。
7. **高峰/低谷差一倍**：官方北京时间周一至周五 09:00–12:00、14:00–18:00 为高峰，其余半价；本机日志里大段用量落在低谷，不分时段会高估近一倍。
8. **写 `~/.dsh` 需要工作区沙箱之外**：本会话已切到 danger-full-access 才完成安装；换到别的会话要重跑安装时注意这点。
9. **本机 `pkill -f "…"` 会杀掉自己的 bash**（沙箱把命令行也算了进去，`/proc` 里看到的就是自己）—— 杀进程要按 PID 判断。
10. **验证实例用另一个端口**（3099），不要动用户的 3080 窗口。
11. **宿主模块只在启动时加载一次**：改 `lib/index.js` 后必须重启 `dsh web` 才生效（跑着的实例不会变）；
    只改 `lib/client.js` 时刷新页面即可（boot graph 每次请求重新生成）。
12. **页脚按钮要跟邻居统一，规格只能从源码读**：shell 的 42px 行高/12px 圆角/36px 圆钮在 `dsh-client-ui-sidebar` 的 CSS module 里，团队按钮在 `@wowyuarm/dsh-agent-team` 的 `TeamFooterAction` + `.YvAbSa_footerAction` 里；凭感觉写必然对不齐。
13. **任何 emoji 图标都可能渲染成豆腐块**（用户截图里的 🖼 就是），图标一律用内联 SVG + `currentColor`。
14. **共享 flex 行里不能照抄邻居的宽度**：`sidebar.footer.action` 是与团队按钮共用的一行，
    设置按钮的 `width:100% + margin:0 -2px` 只适用于「自己独占一行」的场景；照抄 = 把邻居挤出屏幕。
15. **要改「栏目颜色」只能动中性色阶**：主题的 `--dsw-static-neutral-bluish-*` 序号即明度
    （50 最浅 → 1000 最深），`body` / `body[data-ds-dark-theme]` 分别绑定浅色与深色别名 ——
    保留明度曲线、只换色相才不会把浅色主题变成深蓝页面。
16. **颜色类故障是静默的**：不崩、不报错、界面只是「看起来没变」。验证必须断言「token 层叠上了且覆盖栏目引用的步进」，
    并打开被 catch 吞掉的错误（本轮就是这样才发现 `[light, dark]` 元组写成了对象）。
17. **平台绘制的部件必须自己声明表面**：下拉展开列表、原生 checkbox、滚动条都不是 CSS 能继承到的 ——
    只给文字上色、把背景留给 UA，就会在某个配色下变成白底浅字（不报错，只是看不清）。
18. **优先覆盖别名，不要覆盖主题的静态变量**：静态变量由主题自己的规则声明，覆盖它是比样式表顺序，
    可能静默失效；别名覆盖是元素内联属性，必然生效。
19. **停掉卡住的验证实例用 `fuser -k 3099/tcp`**：沙箱内的 `kill` 看不到宿主命名空间的进程，
    而 `pkill -f "dsh web"` 会匹配到自己的 bash 命令行把自己杀掉。
