# 安装步骤（唯一一份，可重复执行）

> **状态：本轮已执行完毕。** 实际做法是「改 profile 清单 + `pnpm install`」，等价于下面的一条命令；
> 已在 `dsh web --port 3099` 上验证生效（见 `docs/VERIFY-ROUND.md` 第 3 节）。
> 安装前原文件备份在 `/tmp/web-profile-package.json.bak`。

目标：把 `/home/atlaslinux/Wallpaper Plugin/dsh-wallpaper` 作为常驻插件挂进 web profile。

## 一条命令（推荐）

```bash
dsh plugin --profile web add link:"/home/atlaslinux/Wallpaper Plugin/dsh-wallpaper"
```

`dsh plugin` 会把参数转发给 profile 目录下的 pnpm，装完后 profile 的
`package.json` 里出现 `"dsh-wallpaper": "link:/home/atlaslinux/Wallpaper Plugin/dsh-wallpaper"`
（`dsh.profile.bundles` 里也会带上它）。

## 手工等价步骤

```bash
# 1. 依赖行（~/.dsh/profiles/web/package.json 的 dependencies）
#    "dsh-wallpaper": "link:/home/atlaslinux/Wallpaper Plugin/dsh-wallpaper"
# 2. bundle 行（同一个文件的 dsh.profile.bundles 数组末尾）
#    "dsh-wallpaper"
# 3. 建链接 + 更新 lock
cd ~/.dsh/profiles/web && pnpm install
# 4. 重启 web
```

## 生效与回退

- **生效**：插件行为在**重启 `dsh web` 之后**确定（profile 的 bundle 列表与客户端 bundle 都在启动时读取）。
  已在跑着的进程不会热加载新 bundle —— 本轮就是另起 `dsh web --port 3099` 验证的。
- **回退**：`dsh plugin --profile web remove dsh-wallpaper`（或删掉上面两行 + `pnpm install` + 重启）。
- 插件自己的数据在 `~/.dsh/wallpaper/`（配置 + 上传的壁纸）；卸载插件**不会**删它，需要的话手工删。

## 沙箱注意

写 `~/.dsh/profiles/web/**` 在工作区沙箱（workspace-write）之外，会以「Read-only file system」
被拒。执行这一步需要放宽一次文件沙箱（danger-full-access），或者在普通终端里跑上面那条命令。

## 发布到 GitHub（仓库首页 README 的权威副本在哪）

仓库 https://github.com/AtlacherCoder/dsh-wallpaper 的**根级 `README.md`** 与工作区里的
`dsh-wallpaper/README.md` 是**同一份内容**：发布时把它放到仓库根（覆盖最初的 15 字节占位）。
所以该文件的权威副本是 `dsh-wallpaper/README.md`，不要在两个位置各维护一份。

发布步骤（暂存目录，避免动工作区）：

```bash
STAGE=/tmp/dsh-wallpaper-upload; rm -rf "$STAGE"; mkdir -p "$STAGE"
for i in dsh-wallpaper tools docs INSTALL.md; do cp -a "$i" "$STAGE/"; done
rm -rf "$STAGE/docs/rollback"          # 回退快照不上传（按用户选择）
mv "$STAGE/dsh-wallpaper/README.md" "$STAGE/README.md"
# 然后 gitmanager_upload(source=$STAGE, repo=AtlacherCoder/dsh-wallpaper)
```

> 教训：这个 README 曾在「临时目录」里被改好却没落回源文件，导致下一次上传**内容倒退**。
> 现在源文件是权威副本，暂存只是搬运。
