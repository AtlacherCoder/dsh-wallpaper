# 回退点（每次都是可复原的完整快照）

**这轮之前的做法是错的**：我每轮都把同一个 `docs/rollback/R-001/` 覆盖成「当前版本」，
所以「上一步的成品」根本没有被保存下来 —— 用户要回退时无物可退，只能按记忆重建。
从现在起每个回退点独立成目录，只增不改。

| 目录 | 内容 | 状态 |
|---|---|---|
| `R-001-static-ramp/` | **静态色阶方案**：重着色主题的 `--dsw-static-neutral-bluish-*`（保留明度曲线，只换色相/饱和度）；`--dsw-alias-bg-base` 强制透明；**没有**表单控件表面补丁 | 当前生效 |
| `R-002-current/` | **别名覆盖方案**：覆盖 8 个表面别名（各带 light/dark）；base 跟随配色；表单控件显式声明表面 + `color-scheme: dark`；含 WCAG 对比度断言 | 已回退，保留待用 |

两个快照都是完整可复原的：`dsh-wallpaper/`（插件本体）+ `tools/`（全部验证脚本）+ `docs/`（决策与验证记录）+ `INSTALL.md`。

## 怎么用

```bash
# 回退到某一点（在仓库根目录执行）
cp -a docs/rollback/R-001-static-ramp/dsh-wallpaper/. dsh-wallpaper/
cp -a docs/rollback/R-001-static-ramp/tools/. tools/
# 然后重启 dsh web（宿主模块只在启动时加载；只改客户端时刷新页面即可）
fuser -k 3099/tcp   # 之前启动的验证实例
dsh web --port 3099 --no-open
```

## 两点提醒

1. **两个快照的测试脚本与各自的实现配套**。R-002 的 `client-syntax-check.mjs` 断言的是别名表与
   `color-scheme`；把它和 R-001 的实现混用会得到「失败但不是 bug」的噪音。回退时**整套**一起换。
2. R-001 保留了已知的两个隐患（当时没修）：`bg-base` 强制透明导致浅色模式下白卡片透出壁纸；
   下拉框等平台绘制部件没有自带表面（就是用户截图里白底浅字那个）。R-002 修掉了这两个，
   代价是覆盖面从「整条色阶」收窄到 8 个别名。
