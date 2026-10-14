# 交活前的验证清单（本轮实际执行）

> 「测试绿 ≠ 做完」。用户可见的改动必须有**真实窗口 + 读数**。没有浏览器自动化工具时，
> 最后一格必须由人确认 —— 这一格没打勾之前，本轮不算收口。

## 1. 契约层（接口/数据形状）

| # | 检查 | 命令 | 结果 |
|---|---|---|---|
| 1.1 | 宿主插件加载、`inject` 与注册面正确 | `node tools/host-smoke.mjs` | ✅ `inject: ["webServer"]`、`prefix /dsh-wallpaper`、`provide: wallpaper`、`events: session/event` |
| 1.2 | 状态接口形状（config / wallpapers / usage / pricing） | 同上，断言 1–5 | ✅ 28 项断言全过 |
| 1.3 | 内置壁纸按字节可比对 | 同上 | ✅ 322,731 字节，与磁盘文件 `Buffer.equals` 一致，JPEG magic `ff d8` |
| 1.4 | 上传/列出/取图/删除 闭环 | 同上，断言 10–13、22–24 | ✅ 含「不支持类型被拒」「内置图拒绝删除」 |
| 1.5 | 配置夹紧（dim 0.9 / blur 24 / fit 回退）与持久化 | 同上，断言 14–19 | ✅ 局部补丁不动其它字段 |
| 1.6 | SSE 真的推出帧（不只握手） | 同上，断言 20–21 | ✅ `ready` + 写配置后收到 `config` 帧 |
| 1.7 | 加固：路径穿越 404、未知路由 404、超大 body 拒绝 | 同上，断言 25–27 | ✅ |

## 2. 数据层（数字对不对）

| # | 检查 | 命令 | 结果 |
|---|---|---|---|
| 2.1 | 用量折叠与独立实现逐字段一致 | `node tools/usage-fold-test.mjs 4` | ✅ 4 份真实日志：`input/output/cacheRead/cacheWrite/reasoning/total/steps/peak/offPeak` 全部一致 |
| 2.2 | 计价公式可复算 | 同上 | ✅ 大日志 `peak 2,450,209 / off-peak 11,084,724` → `¥147.5103 × 0.5905 = ¥87.1069`；插件 ¥87.1069 |
| 2.3 | 模型归属正确 | 同上 | ✅ `request/header.header.config.model` 解析为 `deepseek-flash` |
| 2.4 | 分时段计价真的生效 | 同上 | ✅ 低谷占比 0.59 被乘进价（若只按高峰价，该会话会显示 ¥147.51，差 1.7 倍） |

## 3. 接线层（走真实入口，不是单元桩）

| # | 检查 | 方法 | 结果 |
|---|---|---|---|
| 3.1 | profile 里装上插件、bundle 表更新 | `pnpm install`（等价于 `dsh plugin --profile web add link:…`） | ✅ `node_modules/dsh-wallpaper -> ../../../../Wallpaper Plugin/dsh-wallpaper`；`dsh.profile.bundles` 末位出现 `dsh-wallpaper` |
| 3.2 | 组合后的 profile 真的加载了这一行 | `dsh --profile web --dump-config` | ✅ 输出第 586–588 行：`# == dsh-wallpaper` / `- id: dsh-wallpaper` / `name: dsh-wallpaper` |
| 3.3 | 启动无 `missingBundles` / `client-modules` 报错 | 真实启动 `dsh web --port 3099` | ✅ 启动日志只有登录 URL 一行；`/dsh-wallpaper/api/state` 返回 200 JSON |
| 3.4 | 客户端 bundle 进入 boot graph 并被真实 HTTP 取到 | `curl` 索引页 + combo URL | ✅ 索引里出现 `dsh-wallpaper/client.js`（与其它插件同一条 combo）；`GET /plugins/??dsh-wallpaper/client.js&rev=…` → `200 text/javascript 30,796 bytes` |
| 3.5 | 从真实 DSH 进程取到的用量读数 | `curl -b cookies …/api/state` | ✅ 见下表 |
| 3.6 | 浏览器侧语法与导出契约 | `node tools/client-syntax-check.mjs` | ✅ 14 项全过（含 `require` 只出现 `react`、三个 slot 名存在于真实 slot 树） |
| 3.7 | 壁纸文件经 HTTP 逐字节一致 | `curl …/wallpaper/default` + `cmp` | ✅ `200 image/jpeg 322,731 bytes`，与仓库内文件 `cmp` 一致 |

### 真实进程读数（端口 3099 实测，`session-02b8b368…` 就是本轮会话）

| 字段 | 读数 |
|---|---|
| 模型 / 步数 | `deepseek-flash` / 172 |
| 提示 token 合计（`inputTokens`） | 130,576 |
| 其中命中缓存（`cacheReadTokens`） | 24,599,808 |
| 其中未命中缓存 | 0（本轮提示全部命中缓存） |
| 输出（`outputTokens`） | 100,485 |
| 合计 | 231,061 tok |
| 高峰 / 低谷 | 231,061 / 0（本轮全部落在北京时间高峰段，系数 1.0000） |
| 计价构成 | 命中 24.599808M × ¥0.04 = ¥0.9840 · 未命中 0 × ¥2 = ¥0 · 输出 0.100485M × ¥8 = ¥0.8039 |
| 预估消费 | **¥1.7879** |

> 这些数字由真实接口（端口 3099）直接读出，同一份日志在 `tools/usage-fold-test.mjs` 里被**独立实现**重新折叠并计价，两者逐字段一致（含最终 `costCNY`）。所以面板上的金额是算出来的，不是写死的常数。
> 未命中输入取 `inputTokens − cacheReadTokens`：提示里被缓存命中的部分不会按未命中价重复计费 —— 这正是 `usage-fold-test.mjs` 校验的那条公式。

## 4. 目视层（真实窗口）

| # | 检查 | 结果 |
|---|---|---|
| 4.1 | 刷新 http://127.0.0.1:3080 后整页出现壁纸 | ⬜ 待用户确认 |
| 4.2 | 侧边栏底部出现 🖼 按钮，点开面板 | ⬜ |
| 4.3 | 面板里数字与 3.4 的读数一致 | ⬜ |
| 4.4 | 滑块（暗度/模糊）即时生效，上传图片能换图 | ⬜ |
| 4.5 | 「停用壁纸」后页面恢复原样（不留残影/不影响可用性） | ⬜ |
| 4.6 | 明暗主题切换后仍可读 | ⬜ |

## 5. 回退件

- `docs/rollback/R-001/` = 本轮交付内容快照（插件目录 + INSTALL.md），完整可复原。
- 插件数据 `~/.dsh/wallpaper/` 独立于插件本体，卸载插件不删用户壁纸。
- 卸载：`dsh plugin --profile web remove dsh-wallpaper`（详见 `INSTALL.md`）。
- profile 清单备份：`/tmp/web-profile-package.json.bak`（安装前的原文件）。
- 验证用实例：`dsh web --port 3099` 与 3080 的现有窗口并存，**不动现有窗口**。
  登录 URL（含 token，仅 loopback）：`http://127.0.0.1:3099/?token=XL16IR1z7X-2Vw5LG0BQVcDge2a-HmaqAprBnU1tyQA`
