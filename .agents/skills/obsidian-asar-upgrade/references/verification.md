# 验证判据

本文件列出升级后要核对的每一项，以及每项的预期值。构建期的自动检查由 `tools/build-asar.mjs` 与 `scripts/verify-asar.mjs` 执行；设备上的检查需要人工确认。

## 一、构建期自动检查

`tools/build-asar.mjs` 在打包之前完成以下检查，任一不通过即非零退出，不产出产物：

| 检查 | 内容 |
|------|------|
| 定位标记命中次数 | 每条替换的命中次数必须与预期相符 |
| 关键片段存在与不存在 | `assertContains` / `assertAbsent`，含重复前缀自检 |
| 括号计数 | `assertBalance`，偏离阈值即报错 |
| 语法检查 | 对 `main.js`、`app.js`、`starter.js` 各做一次 `new vm.Script` |
| 注入符号 | 注入 `app.js` 的代码只引用本版本解析出的符号 |

## 二、产物静态检查

```bash
node .agents/skills/obsidian-asar-upgrade/scripts/verify-asar.mjs <产物路径> <版本号>
```

脚本逐项确认下面的定制点。缺一项即报出并退出码 1。用官方原始 asar 运行时应当报出四十余个问题，这是脚本有效性的反向验证方式。

### main.js

| 定制点 | 预期 |
|--------|------|
| 版本下限检查短路 | `if(false&&` 出现 1 次 |
| 托盘图标路径 | `tray.png` 出现 1 次 |
| 托盘对象与状态 | `qtray`、`Ee_tray` 各出现 2 次以上 |
| 退出标志 | `before-quit` 出现 1 次 |
| 开关与强制退出通道 | `"exit-to-tray"`、`"force-quit"` 各 1 次 |
| 12 个云同步通道 | `hcs-get-status`、`hcs-sync-all`、`hcs-get-auto-sync`、`hcs-set-auto-sync`、`hcs-get-excluded`、`hcs-set-excluded`、`hcs-get-userid`、`hcs-set-userid`、`hcs-login`、`hcs-restore-list`、`hcs-restore-file`、`hcs-code` 各 1 次 |
| 模块前缀未重复 | `l.l.`、`m.m.`、`C.C.` 各 0 次 |

### app.js

| 定制点 | 预期 |
|--------|------|
| 窗口按钮处理 | `[HMOS-FRAME]` 1 次、`setWindowButtonVisibility` 2 次、`--frame-right-space` 1 次 |
| 云同步设置页 | `huawei-cloud-sync` 1 次、`HcsSettingsTab` 2 次、`addSettingTab(new HcsSettingsTab` 1 次、`华为云同步` 1 次以上 |
| 退出软件开关 | `退出软件` 1 次、`exit-to-tray` 1 次以上 |
| 设置页框架 | `getSettingDefinitions` 存在 |

`setWindowButtonVisibility` 出现 2 次，因为补丁先判函数类型再调用，两处都在同一段插入代码内。

### starter.js

| 定制点 | 预期 |
|--------|------|
| 标题栏文字 | `OHsidian` 1 次以上 |
| 打开仓库后不关窗 | `window.close()` 0 次 |

### app.css

| 定制点 | 预期 |
|--------|------|
| starter 标题栏隐藏 | `.starter .titlebar` 的规则体内为 `display: none` |
| starter 顶部间距 | `padding-top: 30px` 1 次 |

### i18n

| 定制点 | 预期 |
|--------|------|
| 版本文案 | `HarmonyOS-{{version}}`、`HarmonyOS Port {{version}}` 各 1 次 |
| 更新禁用说明 | `Updates are disabled. Running on HarmonyOS.` 1 次 |
| 检查更新按钮 | `Updates not available` 1 次以上 |
| 中文版本文案 | `HarmonyOS 移植版本 {{version}}` 1 次以上 |
| 中文自动更新说明 | `HarmonyOS 移植版不支持自动更新。` 1 次 |

### 文件与体积

- 产物内必须有 `icon.png`、`tray.png`、`index.html`、`starter.html`、`help.html`。
- `index.html`、`starter.html`、`help.html` 的标题为 `<title>OHsidian</title>`。
- `harmonyos-sync-bridge.js` 与 `icon.png.bak` 按设计被移除，若仍在则提示。
- 体积在 20–40 MB 之间。超出范围时确认输入是官方发布版 asar。安装包内的 `app.asar` 是外层加载器，体积远小于此，取错文件会在符号解析阶段报错。

### 1.13.4 的基线值

| 项 | 值 |
|----|----|
| 字节数 | 27684486 |
| md5 | `6746843bf8cfad21e4ac44dcee02e667` |
| 文件数 | 381 |

其他版本的产物尺寸与 md5 都不同。只有同一版本、同一输入 asar 的重复构建才应完全一致。

## 三、设备验证

构建通过后安装：

```bash
devecocli build
devecocli run --skip-build --device <设备>
```

### 读日志

```bash
hdc shell "tail -40 /data/app/el2/100/base/com.mikannqaq.obsidian/files/obsidian.log"
```

`obsidian.log` 是应用自己写的日志。hilog 里看不到应用的标准输出，只有这个文件可读。

### 日志检查项

| 检查 | 预期 |
|------|------|
| asar 被加载 | `Loaded main app package` 后跟产物路径 |
| 自动更新关闭 | `HarmonyOS port: desktop auto-update is disabled` |
| remote 已开启 | `[HMOS-REMOTE] 已开启 remote，WebContents <编号> 类型 window`，数量与打开的窗口数相符 |
| 字体补丁注入 | `字体兼容补丁已注入渲染进程 <编号>` 多次出现 |
| 无异常 | 不含 `UnhandledPromise`、`TypeError`、`ReferenceError`、`is not a function`、`is not defined`、`Cannot read` |

启动阶段的正常序列：`字体兼容补丁监听已注册` → `Loaded main app package` → `HarmonyOS port: desktop auto-update is disabled` → `[HMOS-REMOTE] 已开启 remote，WebContents 1 类型 window` → `字体兼容补丁已注入渲染进程 1` ×4 → `[HMOS-REMOTE] 已开启 remote，WebContents 2 类型 window` → `字体兼容补丁已注入渲染进程 2`。

### 界面检查项

以下需要人工确认，或取得用户明确授权后由子代理执行。不要自行操作设备。

| 检查 | 说明 |
|------|------|
| 设置界面能打开 | 1.13.4 起默认在独立窗口打开。无法打开通常意味着 remote 未提前开启 |
| 独立设置窗口出现 | 日志中应随之出现新的 `[HMOS-REMOTE] 已开启 remote` |
| 「华为云同步」设置页出现 | 验证 `HcsSettingsTab` 已注册 |
| 含非内嵌字体的 PDF 能渲染 | 验证 `FontFace` 补丁在页面导航后重新注入 |
| `obsidian://` 链接能派发 | 验证外层队列轮询 |
| 托盘图标出现且可点击 | 验证 `tray.png` 与托盘初始化 |
| 关闭窗口最小化到托盘 | 验证 `close` 事件拦截 |
| 「退出软件」开关生效 | 验证 `exit-to-tray` 通道往返 |

## 四、日志判读的两个要点

**日志时间早于进程启动时间**时，说明当前运行的进程没有写日志。用 `hdc shell date` 与进程的启动时刻对照，两者应处在同一时刻。

**进程存在不等于界面正常。** 进程可能处于休眠、占用大量虚拟内存、系统日志里没有任何输出。判据是 `obsidian.log` 有新记录。
