// 校验构建出的 obsidian.asar 是否带齐了全部定制。
//
// 用法：node verify-asar.mjs <asar 路径> [目标版本号]
//
// 逐项检查定制点是否存在、官方内容是否已被替换、文件是否齐全，
// 并报告产物体积。任何一项不符即以非零退出。
//
// 检查依据是产物里的字符串与结构，与构建脚本的补丁清单一一对应。
// 版本升级后如果某项检查因官方改写而不再适用，按 docs/asar-upgrade.md
// 的说明更新本文件的探针，不要放宽为「存在即可」的模糊判断。

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const asarPath = path.resolve(process.argv[2] ?? '');
const targetVersion = process.argv[3] ?? null;

if (!asarPath || !fs.existsSync(asarPath)) {
  console.error('用法：node verify-asar.mjs <asar 路径> [目标版本号]');
  console.error(`找不到文件：${asarPath}`);
  process.exit(2);
}

// @electron/asar 装在 tools/ 下。按当前目录解析，失败时回退到仓库的 tools/ 目录。
function loadAsar() {
  const candidates = [process.cwd()];
  const here = path.dirname(new URL(import.meta.url).pathname);
  candidates.push(path.resolve(here, '../../../../tools'));
  for (const dir of candidates) {
    try {
      return createRequire(path.join(dir, 'noop.js'))('@electron/asar');
    } catch {
      continue;
    }
  }
  console.error('找不到 @electron/asar。在 tools/ 目录下运行，或先执行 npm install。');
  process.exit(2);
}

let asar;
try {
  asar = loadAsar();
} catch (e) {
  console.error(`加载 @electron/asar 失败：${e.message}`);
  process.exit(2);
}

const read = (name) => asar.extractFile(asarPath, name).toString('utf8');
const problems = [];
const notes = [];

// 断言片段存在，并可要求出现次数。
function present(file, text, fragment, min = 1, max = Infinity) {
  const count = text.split(fragment).length - 1;
  if (count < min) {
    problems.push(`${file} 缺少定制片段（出现 ${count} 次，至少需要 ${min} 次）：${JSON.stringify(fragment)}`);
  } else if (count > max) {
    problems.push(`${file} 定制片段出现次数过多（出现 ${count} 次，最多 ${max} 次）：${JSON.stringify(fragment)}`);
  }
}

// 断言片段不存在。
function absent(file, text, fragment, label) {
  const count = text.split(fragment).length - 1;
  if (count !== 0) {
    problems.push(`${file} 残留了应当被替换的内容（${count} 处）${label ? `：${label}` : ''}：${JSON.stringify(fragment)}`);
  }
}

const main = read('main.js');
const app = read('app.js');
const starter = read('starter.js');
const css = read('app.css');
const i18n = read('i18n.js');
const zh = read('i18n/zh.txt');
const pkg = JSON.parse(read('package.json'));

// ---- package.json ----
if (targetVersion && pkg.version !== targetVersion) {
  problems.push(`package.json 版本为 ${pkg.version}，预期 ${targetVersion}`);
}
if (pkg.author !== 'OHsidian') {
  problems.push(`package.json 的 author 为 ${JSON.stringify(pkg.author)}，预期 "OHsidian"`);
}
if (pkg.description !== 'OHsidian HarmonyOS Edition') {
  problems.push(`package.json 的 description 为 ${JSON.stringify(pkg.description)}，预期 "OHsidian HarmonyOS Edition"`);
}

// ---- main.js ----
present('main.js', main, 'if(false&&', 1, 1);
// 短路前的写法形如 if(<标识符><18)，其中标识符逐版重排，用正则匹配。
if (/if\((?!false&&)[A-Za-z_$][\w$]*<18\)/.test(main)) {
  problems.push('main.js 的版本下限检查未被短路，仍存在 if(<标识符><18) 形式的判断');
}
present('main.js', main, 'tray.png', 1, 1);
present('main.js', main, '"exit-to-tray"', 1, 1);
present('main.js', main, '"force-quit"', 1, 1);
present('main.js', main, 'qtray', 2);
present('main.js', main, 'Ee_tray', 2);
present('main.js', main, 'before-quit', 1);
for (const ch of [
  'hcs-get-status', 'hcs-sync-all', 'hcs-get-auto-sync', 'hcs-set-auto-sync',
  'hcs-get-excluded', 'hcs-set-excluded', 'hcs-get-userid', 'hcs-set-userid',
  'hcs-login', 'hcs-restore-list', 'hcs-restore-file', 'hcs-code',
]) {
  present('main.js', main, `"${ch}"`, 1, 1);
}
// 重复前缀意味着替换时吃掉了或留下了模块前缀，运行时会读不到 ipcMain。
for (const dup of ['l.l.', 'm.m.', 'C.C.']) {
  absent('main.js', main, dup, '模块前缀重复');
}

// ---- app.js ----
present('app.js', app, '[HMOS-FRAME]', 1, 1);
// 同一段补丁里先判函数类型再调用，因此这个字符串出现 2 次。
present('app.js', app, 'setWindowButtonVisibility', 2, 2);
present('app.js', app, '--frame-right-space', 1, 1);
present('app.js', app, 'huawei-cloud-sync', 1, 1);
present('app.js', app, 'HcsSettingsTab', 2, 2);
present('app.js', app, '华为云同步', 1);
present('app.js', app, 'addSettingTab(new HcsSettingsTab', 1, 1);
present('app.js', app, '退出软件', 1);
present('app.js', app, 'exit-to-tray', 1);
// 设置页基类没有 update() 时，模板会附加 display() 分支。两种形态都合法，
// 这里只确认至少有一种刷新路径可用。
if (!app.includes('getSettingDefinitions')) {
  problems.push('app.js 里没有 getSettingDefinitions，设置页框架与预期不符');
}

// ---- starter.js ----
present('starter.js', starter, 'OHsidian', 1);
absent('starter.js', starter, 'window.close()', '打开仓库后仍会关窗');
present('starter.js', starter, 'titlebar-text', 1);

// ---- app.css ----
present('app.css', css, 'padding-top: 30px', 1);
if (!/\.starter \.titlebar[^{]*\{[^}]*display:\s*none/.test(css)) {
  problems.push('app.css 里没有隐藏 starter 标题栏的规则');
}

// ---- i18n ----
present('i18n.js', i18n, 'HarmonyOS-{{version}}', 1, 1);
present('i18n.js', i18n, 'HarmonyOS Port {{version}}', 1, 1);
present('i18n.js', i18n, 'Updates are disabled. Running on HarmonyOS.', 1, 1);
present('i18n.js', i18n, 'Updates not available', 1);
present('i18n/zh.txt', zh, 'HarmonyOS 移植版本 {{version}}', 1);
present('i18n/zh.txt', zh, 'HarmonyOS 移植版不支持自动更新。', 1);

// ---- 文件齐全 ----
const files = asar.listPackage(asarPath).map((p) => p.replace(/^\//, ''));
for (const name of ['icon.png', 'tray.png', 'index.html', 'starter.html', 'help.html']) {
  if (!files.includes(name)) {
    problems.push(`产物缺少文件：${name}`);
  }
}
for (const name of ['harmonyos-sync-bridge.js', 'icon.png.bak']) {
  if (files.includes(name)) {
    notes.push(`产物仍带有 ${name}，构建脚本按设计应移除它`);
  }
}
for (const name of ['index.html', 'starter.html', 'help.html']) {
  const html = read(name);
  if (!html.includes('<title>OHsidian</title>')) {
    problems.push(`${name} 的标题没有改成 OHsidian`);
  }
}

// ---- 体积 ----
const size = fs.statSync(asarPath).size;
notes.push(`产物体积：${size} 字节`);
if (size < 20 * 1024 * 1024 || size > 40 * 1024 * 1024) {
  notes.push('体积超出常见范围（20–40 MB）。确认输入的是官方发布版 asar。安装包内的 app.asar 是外层加载器，体积远小于此');
}

console.log(`检查产物：${asarPath}`);
console.log(`文件数：${files.length}`);
for (const n of notes) console.log(`  · ${n}`);

if (problems.length > 0) {
  console.log('');
  console.log(`发现 ${problems.length} 个问题：`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}

console.log('');
console.log('全部定制点检查通过。');
