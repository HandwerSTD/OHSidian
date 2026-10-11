# 运行时注入的最小验证记录

本文件记录一次实测：把官方原版 1.13.4 asar 放进本项目的外层壳，验证纯运行时注入路线是否成立。全部结论来自设备实测。

## 1. 验证目的

此前对每一处注入的可行性判断都来自静态阅读官方 asar 的代码，没有端到端验证。需要回答三个问题：

1. 官方原版 asar 能不能被这个壳加载并正常启动。
2. 外层注入的代码能不能真正执行，日志能不能留下痕迹。
3. `@electron/remote` 在各类窗口上的实际开启状态。

## 2. 验证环境

| 项 | 值 |
|----|-----|
| 分支 | `feat/runtime-inject-13`（从 `feat/harmony-port-fixes` 建立） |
| asar | 官方 1.13.4 原版，25783388 字节，md5 `bbae59d36fe60500436a82cb841d5ad6` |
| 设备 | HUAWEI MateBook Pro，序列号 `127.0.0.1:42021` |
| 构建 | `devecocli build` |
| 安装启动 | `devecocli run --skip-build --device 127.0.0.1:42021` |
| 日志 | `hdc shell "cat /data/app/el2/100/base/com.mikannqaq.obsidian/files/obsidian.log"` |

改动只有三处：替换 asar、把外层 `package.json` 的 `version` 改为 `1.13.4`、在 `main.js` 顶层加入探针。

## 3. 探针设计

第一版探针用 `console.log` 输出，结果一行都没有进日志。应用只把 `log()` 的写入写入 `obsidian.log`：

```
let log = logger(path.join(dataPath, 'obsidian.log'));
```

`console.log` 走标准输出，在设备上既不进这个文件，也不出现在 hilog 里。

改用同等格式写文件后，探针开始生效。探针自备写入函数，因为 `log()` 定义在第 280 行，而探针需要在其之前执行：

```js
let __probePath = path.join(app.getPath('userData'), 'obsidian.log');
function probe() {
	try {
		let d = new Date();
		let p2 = function (n) { return n < 10 ? '0' + n : '' + n; };
		let ts = d.getUTCFullYear() + '-' + ...;
		fs.appendFileSync(__probePath, ts + ' [PROBE] ' + util.format.apply(null, arguments) + os.EOL);
	} catch (e) {}
}
```

第二版探针多了一处：读 `@electron/remote` 自己的 `isRemoteModuleEnabled(contents)`，做开启前后的对比。

## 4. 实测结果

启动块（UTC 时间，北京时间 = UTC+8）：

```
2026-10-11 15:24:12 [PROBE] 版本改写：真实值 5.0.0-Release -> 现值 18.0.0
2026-10-11 15:24:12 字体兼容补丁监听已注册
2026-10-11 15:24:12 Loaded main app package /data/storage/el1/bundle/electron/resources/resfile/resources/app/obsidian.asar
2026-10-11 15:24:12 HarmonyOS port: desktop auto-update is disabled
2026-10-11 15:24:12 [PROBE] WebContents 1 类型 window：remote 开启前 false 开启后 true
2026-10-11 15:24:13 字体兼容补丁已注入渲染进程 1
2026-10-11 15:24:17 [PROBE] WebContents 2 类型 window：remote 开启前 false 开启后 true
2026-10-11 15:24:20 字体兼容补丁已注入渲染进程 2
2026-10-11 15:24:35 [PROBE] WebContents 3 类型 remote：remote 开启前 false 开启后 true
```

构建成功，安装启动成功。失败清单逐项检查，命中数全部为 0：`Manual update required`、`@electron/remote is disabled for this WebContents`、`Uncaught Exception`、`UnhandledPromiseRejection`、`TypeError`、`ReferenceError`、`is not a function`、`is not defined`、`Cannot read`、`Failed to require app package`、`Failed to load both app packages`。

## 5. 三条确认结论

### 5.1 官方原版 asar 可以加载运行

日志出现 `Loaded main app package`，没有 `Failed to require app package`，没有 `Failed to load both app packages`，没有 `Manual update required`，渲染进程被创建并注入字体补丁。界面上应用正常打开。

**纯运行时注入路线成立。** asar 不需要任何补丁。

### 5.2 设备上的 Electron 真实版本是 `5.0.0-Release`

主版本 5，低于 18。这意味着官方 asar 入口处的 `if(fo<18){` **确实会触发**，会弹出「Manual update required」并跳转下载页、退出应用。

把 `process.versions.electron` 改写为 `18.0.0` 是必需步骤，不是防御性措施。探针证明改写生效：真实值 5.0.0-Release，写入后现值 18.0.0。

**连带结论**：渲染进程读的是它自己的 `process.versions.electron`，主进程的改写不影响它。渲染进程里 `uf=process.versions.electron` 后 `pf=uf`，因此 `qy(pf, "28.2.3")` 比较的是 5 与 28，结果为真。实测 `qy("5.0.0-Release", "28.2.3")` 为 `true`（`zy` 解析出 `[5,0,0]`）。

所以「installer 版本过低」的提示与下载入口**会触发**，处理 `disable-update` 通道是必需的。

### 5.3 外层在 `web-contents-created` 的 remote 注入有效

三次观测全部是「开启前 false、开启后 true」。

官方 `@electron/remote` 的判定实现：

```
const isRemoteModuleEnabledImpl = function (contents) {
    const webPreferences = contents.getLastWebPreferences() || {};
    return webPreferences.enableRemoteModule != null ? !!webPreferences.enableRemoteModule : false;
};
const isRemoteModuleEnabledCache = new WeakMap();
const isRemoteModuleEnabled = function (contents) {
    if (hasWebPrefsRemoteModuleAPI && !isRemoteModuleEnabledCache.has(contents)) {
        isRemoteModuleEnabledCache.set(contents, isRemoteModuleEnabledImpl(contents));
    }
    return isRemoteModuleEnabledCache.get(contents);
};
function enable(contents) { isRemoteModuleEnabledCache.set(contents, true); }
```

`webPreferences.enableRemoteModule` 未设置时默认 `false`。官方 asar 自己也有开启路径，挂在窗口接线函数上：

```
function re(o){if(l.remote)try{l.remote.enable(o)}catch(r){console.error(r)}}
function J(o,r){let u=o.webContents;oe(u),re(u),o.on("app-command",...)}
```

`J` 由 `did-create-window` 触发，这个时刻晚于设置弹窗渲染进程的首个脚本。

## 6. 设置弹窗的实际创建路径

设置弹窗**不经过**主进程的 `setWindowOpenHandler`。渲染进程直接构造窗口，随后立刻使用 `electronWindow`：

```
function WJ(e){
  var o=["popup"];
  ... o.push("width="+t), o.push("height="+n), o.push("x="+i), o.push("y="+r)
  var s=window.open("about:blank","_blank",o.join(","));
  if(!s) return null;
  ...
  s.electronWindow&&(s.electron.webFrame.setZoomLevel(...),Cl(()=>s.electronWindow.show()));
  return {win:s,baseEl:l,cleanup:c}
}
```

两点：

- `o.join(",")` 以 `"popup"` 开头，这就是窗口识别判据。主进程的 `setWindowOpenHandler` 用 `u.url==="about:blank"&&u.features.startsWith("popup")` 判定这类窗口。
- `s.electronWindow` 是 `remote.getCurrentWindow()` 的产物，在 `window.open` 返回后立即访问。远程未开启时这里会失败。

## 7. 验证方法的价值

这一轮建立了可复用的验证闭环：改注入 → `devecocli build` → `devecocli run --skip-build` → 读 `obsidian.log` 的 `[PROBE]` 行。

三条要点：

- 注入的诊断输出必须写 `obsidian.log`，不能用 `console.log`。
- 探针需要自己实现写入，因为 `log()` 在其后定义。
- 探针要放在 `app.on('web-contents-created')` 注册之前，或者注册在 asar 加载之前，才能保证时序上早于官方。

## 8. 未验证事项

以下仍未验证，只是静态分析：

- 设置页注入能否生效。`Setting.prototype.addSettingTab` 内部立即调用 `e.update()`，而 `update()` 做 `this.settingItems=this.getSettingDefinitions()`，结果在 App 构造期间就被算出并缓存。外部包装 `getSettingDefinitions` 之后必须再调一次 `tab.update()`。
- `window.require('obsidian')` 返回什么。它是 webpack 模块内的闭包变量，用文本与语法树分析都没定位到绑定。回退取法（从 `window.app.setting.settingTabs[0]` 用 `Object.getPrototypeOf` 取基类）不依赖它。
- i18n 包装在真实页面里的表现。已用官方 `lib/i18next.min.js` 与官方的 `Up`、`Kp` 转换函数单独实测通过，未在页面内实测。
- `[HMOS-FRAME]` 的判据。官方那段代码里 `t` 取自 `ipcRenderer.sendSync("frame")`，而 `D.frame` 由渲染进程自己写回，注入脚本需要先弄清谁在何时设置它。
- 三项窗口复用（help 复用 starter、starter 复用为仓库窗口、打开最近仓库时复用 starter）在运行时没有等价接口。
