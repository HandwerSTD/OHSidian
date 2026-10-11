---
name: obsidian-asar-upgrade
description: 升级 OHsidian 内置的 Obsidian 内核版本（升级 asar、跟随官方新版本、换 Obsidian 版本、asar 升级、构建 obsidian.asar、定制补丁未生效、设置页白屏、remote is disabled 报错、托盘或华为云同步设置页缺失）。用于把官方发布版 asar 构建成本项目使用的定制 asar，并验证定制是否施加成功。
---

# Obsidian 内核升级

本仓库把官方 Obsidian 发布版 asar 构建成项目使用的定制 asar。构建脚本在 `tools/`，文档在 `docs/asar-upgrade.md`。

## 先做这件事

升级开始前，完整读一遍 `docs/asar-upgrade.md`。它记录了官方两版的全部差异、仓库定制清单、补丁清单、设备验证项，以及尚未迁移的作者自定义内容。本文件只写操作流程与判据。

## 流程

### 1. 取得官方 asar

素材位于 `~/Download/com.huawei.hmos.browser/obsidian/`。1.12.7 与 1.13.4 有 `.asar.gz` 压缩件与 arm64 tar 安装包，1.14.4 只有解包后的目录。用 `ls` 确认目标版本的实际位置，不要照抄路径。

### 2. 更新外层 package.json 的版本号

`web_engine/src/main/resources/resfile/resources/app/package.json` 的 `version` 必须改成目标版本。这个字段同时是 `currentBaseVersion` 与 `app.getVersion()` 的来源，启动扫描 userData 时用 `isV2MoreRecent` 判断新 asar 是否被采用。漏改会导致新 asar 不生效。

### 3. 构建

```bash
cd tools && node build-asar.mjs \
  --input <官方 asar> \
  --output ../web_engine/src/main/resources/resfile/resources/app/obsidian.asar \
  --version <版本号>
```

三个参数都必需。构建失败会打印失败项、实际命中次数与候选列表，并以非零退出，不会产出可用产物。

### 4. 判定构建结果

**符号解析失败**：某个角色在新版里结构被改写。打开报错指出的解析函数（`tools/lib/main-symbols.mjs` 或 `tools/lib/symbols.mjs`），按新版结构更新形状描述。不要改成按压缩变量名匹配。

**定位标记命中次数不符**：新版该处写法变了。报错会给出补丁 id、实际次数与标记前 160 字符。更新 `tools/build-asar.mjs` 里对应的标记或替换文本。

**语法检查未通过**：补丁破坏了括号或语句结构。常见原因是替换时把定位标记前面的前缀一并吃掉，或替换文本里的 `else` 匹配到了外层 `if`。

**注入符号校验失败**：`tools/hcs-settings-tab.js` 引用了本版本不存在的符号。占位符未替换时也会报这里。

### 5. 核对产物

```bash
node .agents/skills/obsidian-asar-upgrade/scripts/verify-asar.mjs <产物路径>
```

脚本解包产物，逐项检查定制是否存在、官方内容是否残留、体积与请求数量是否合理，缺一项即以非零退出。判定标准见 `references/verification.md`。

1.13.4 的已知正确产物为 27684486 字节、md5 `6746843bf8cfad21e4ac44dcee02e667`。版本号不同的产物尺寸与 md5 都不同，只有同版本的重复构建才应完全一致。

### 6. 设备验证

```bash
devecocli build
devecocli run --skip-build --device <设备>
```

日志从设备读：`hdc shell "tail -40 /data/app/el2/100/base/com.mikannqaq.obsidian/files/obsidian.log"`。检查项见 `references/verification.md`。界面交互需要用户确认，不要自行操作设备。

## 三条设计约束

改动 `tools/` 里的补丁时遵守这三条，违反会导致产物能构建但运行时报错。

**一、remote 必须在 WebContents 创建时开启。** 外层引导脚本用 `app.on('web-contents-created', ...)` 调用 `remote.enable(contents)`。任何更晚的时机（`did-create-window`、`dom-ready`）都可能排在渲染进程首个脚本之后，设置页在独立窗口打开时会抛「@electron/remote is disabled for this WebContents」。

**二、注入 `main.js` 的局部变量加 `_` 前缀。** 1.13.4 把 `fs` 的别名改成了 `m`，注入代码里用 `m` 作为目录变量会遮蔽模块级别的 `fs`，对字符串调用 `m.readFileSync` 时抛错。

**三、替换 `ipcMain.on(...)` 时把模块前缀纳入定位标记。** 否则替换后拼出重复前缀（例如 `l.l.ipcMain`），运行时读不到 `ipcMain`。构建脚本用 `assertAbsent` 检查 `l.l.`、`m.m.`、`C.C.` 三种拼法。

## 尚未迁移的内容

1.13.4 产物中有六项 1.12.7 上的作者自定义未迁移，不影响升级包可用性，见 `docs/asar-upgrade.md` 的 4.11 节。升级到 1.14.4 时若需要这些内容，在新版上重新施加，不要直接照搬 1.12.7 的写法。

## 参考文件

- `references/verification.md`：产物与设备的验证判据，含每个定制点的预期字符串
- `references/troubleshooting.md`：构建期与运行期报错对应的处置
- `scripts/verify-asar.mjs`：产物校验脚本，可独立运行
