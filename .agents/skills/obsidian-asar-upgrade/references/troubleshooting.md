# 报错处置

本文件按报错来源分组。每条给出报错原样、原因与处置办法。

## 一、构建期

### 定位标记命中 0 次

```
[app.js] app.about-version: 定位标记命中 0 次，预期 1 次。
标记: t.setName(Fee.labelVersion({version:td.version}))...
```

官方改写了该处结构，脚本里的标记在新版中不存在。

处置：打开新版文件，找到该处的新写法，更新 `tools/build-asar.mjs` 里对应的 `find` 与替换文本。如果只是插入点外侧的局部变量名变了，改用 `replacePattern` 把可变部分捕获下来再拼回替换文本。

### 定位标记命中 N 次，预期 1 次

标记在新版中出现多次，无法确定改哪一处。

处置：扩大标记的前后文，使其唯一。例如加上前面的模块前缀、或者加入该处独有的字符串。

### 定位模式命中 N 次，预期 M 次

与上一条相同，针对 `replacePattern`。

### 补丁后语法检查未通过

```
[main.js] 补丁后语法检查未通过: Unexpected token ')'
```

补丁破坏了语句结构。三种常见原因：

1. 替换时把定位标记前面的前缀一并吃掉，或留下未闭合的花括号。检查替换文本首尾与标记首尾是否衔接。
2. 替换文本里的 `else` 匹配到了外层的 `if`，导致花括号失衡。把 `if`/`else` 分支都包在花括号里。构建脚本在 `main.reuse-existing-vault-window` 这条上有对应注释。
3. 去掉换行时未先剔除整行注释，行尾注释把后续代码注释掉了。`buildHcsSettingsTab` 渲染时先按行剔除注释再去掉换行。

### 括号计数偏离过大

```
[main.js] xxx: 括号计数偏离过大（圆括号 210，花括号 5），可能存在截断。
```

替换时吃掉了大段内容。检查替换文本是否在正确位置结束。

### 未找到任何两参数的标识符调用

```
未找到任何两参数的标识符调用，无法确定继承辅助函数
```

`app.js` 的结构变化超出解析器的描述范围。检查新版里类的写法是否仍是 `辅助函数(子类, 基类)`。

### 继承辅助函数的判定不明确

```
继承辅助函数的判定不明确：最高频 v(900 次) 与次高频 m(400 次) 差距不足三倍。
候选：v(900), m(400), ...
```

两个候选的频次接近，无法判定。处置：在 `tools/lib/symbols.mjs` 的 `findExtendHelper` 里加入额外判据，例如要求两边都是标识符、或该函数定义在文件前部。

### 其余角色判定失败

各解析函数的报错形如：

```
userData 目录的判定失败，命中 2 个：R, x
主仓库窗口创建函数的判定失败，命中 0 个：
设置页基类的判定失败：按 containerEl=createDiv("vertical-tab-content") 命中 0 个候选。
```

处置：打开新版 `main.js` 或 `app.js`，找到该角色对应的结构，更新 `tools/lib/main-symbols.mjs` 或 `tools/lib/symbols.mjs` 里的判定条件。不要改成按压缩变量名匹配。

### tools/hcs-settings-tab.js 引用了非本版本的标识符

```
tools/hcs-settings-tab.js 引用了非本版本的标识符:
  未替换的占位符 __SETTING_ITEM__
   new FooBar(
```

占位符未替换，或模板引用了不在已解析符号内的名字。处置：确认 `buildHcsSettingsTab` 替换了全部占位符；若模板里新引入了符号，在 `tools/lib/symbols.mjs` 的 `resolveAppIdentifiers` 里增加对应的解析结果，并在 `buildHcsSettingsTab` 的替换列表里加上。

### 输入文件不存在 / 缺少必需参数

```
缺少必需参数 --version
```

三个参数 `--input`、`--output`、`--version` 都必需。

### 资源文件不存在

```
资源文件不存在: .../resources/app/tray.png
```

仓库里缺少 `tray.png` 或 `icon.png`。这两个文件在 `web_engine/src/main/resources/resfile/resources/app/` 下。

## 二、运行期

### @electron/remote is disabled for this WebContents

设置页在独立窗口中打开时，其渲染进程在建立后立即同步调用 `remote.getCurrentWindow()`，而 asar 内部要到 `did-create-window` 才开启 remote。

处置：确认外层 `web_engine/src/main/resources/resfile/resources/app/main.js` 里有 `app.on('web-contents-created', ...)` 并在其中调用 `remote.enable(contents)`。这个时机在 WebContents 创建当下，早于该 WebContents 上的任何渲染进程脚本。

### 界面白屏，日志无异常

`app.js` 的模块求值抛错，通常意味着补丁引用了新版本不存在的标识符。模块加载失败不会在 `obsidian.log` 里留下记录。

处置：用 `node` 对补丁后的 `app.js` 做一次求值检查，或检查补丁文本里的每个标识符是否都来自本版本解析结果。`verify-asar.mjs` 的 `app.js` 一节覆盖了此项。

### Cannot read properties of undefined (reading 'ipcMain')

替换 `ipcMain.on(...)` 时未把模块前缀纳入定位标记，拼出了重复前缀（例如 `l.l.ipcMain`）。

处置：确认标记以模块前缀开头。`verify-asar.mjs` 会检查 `l.l.`、`m.m.`、`C.C.` 三种拼法。

### m.readFileSync is not a function

注入 `main.js` 的局部变量遮蔽了模块级别的 `fs` 别名。1.13.4 里 `fs` 的别名是 `m`。

处置：注入代码的局部变量全部加 `_` 前缀。

### 新 asar 不生效，仍是旧版本界面

`web_engine/src/main/resources/resfile/resources/app/package.json` 的 `version` 未同步修改。启动扫描 userData 时用 `isV2MoreRecent(app.getVersion(), version)` 判断新 asar 是否比当前版本新。

处置：改这个字段，重新构建。

### 托盘图标不出现

日志中搜索 `Tray init failed`。托盘在 `whenReady` 之后延迟 1 秒初始化，失败会被 catch 并打印。

处置：确认产物内有 `tray.png`，以及外层 `main.js` 里托盘初始化引用的是资源目录下的 `tray.png`。

### 应用的日志不再更新

`obsidian.log` 的时间早于进程启动时刻，说明当前进程没有写日志。用 `hdc shell date` 与进程启动时刻对照。

处置：重新安装并启动。若仍无记录，安装前先卸载，避免残留状态。

## 三、设备与工具

### 读不到 bundle 内的 asar

```
md5sum: /data/app/el1/bundle/public/com.mikannqaq.obsidian/.../obsidian.asar: Permission denied
```

bundle 目录不对普通 shell 开放。要核对产物，用仓库里的那份，或用 `verify-asar.mjs`。

### hilog 里看不到应用输出

应用的 `log()` 只写 `obsidian.log`。hilog 里能看到的只有系统与框架的输出。用 `hdc shell "tail -40 .../files/obsidian.log"` 读取。

### 构建脚本改为 debug 模式

`devecocli build` 会把 `web_engine/BuildProfile.ets` 改成 `BUILD_MODE_NAME = 'debug'` 与 `DEBUG = true`。发布前需要恢复为 `release` 与 `false`。
