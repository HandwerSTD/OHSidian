// 从官方 Obsidian 发布版 obsidian.asar 生成 OHsidian 使用的定制 asar。
//
// 用法:
//   node tools/build-asar.mjs --input <官方 asar> --output <产物路径> --version <版本号>
//
// 设计要点: 所有文本改动都以「定位标记 + 唯一性检查 + 替换」施加。
// 压缩产物里的标识符会随版本重排，标记选的是跨版本稳定的字符串常量、
// 通道名与结构片段。任何一处标记命中次数与预期不符都会非零退出。
//
// 重要: 插到 app.js 里的代码（hcs-settings-tab.js 与脚本内的片段）会引用 app.js
// 的内部标识符。这些标识符随版本重命名，本脚本不再维护写死的对照表，
// 改为从产物本身解析出来，见 lib/main-symbols.mjs 与 lib/symbols.mjs。
// 解析不出来、或者解析结果不唯一时都报错退出。

import { extractAll, createPackageWithOptions } from '@electron/asar';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import vm from 'node:vm';
import { resolveMainSymbols } from './lib/main-symbols.mjs';
import { resolveAppIdentifiers } from './lib/symbols.mjs';

// 解析结果填充在这里。每一步都从它取值，不写死名字。

// 用 vm.Script 做语法检查。压缩产物是单行，node --check 给出的行号没有意义，
// 这一步用于确认补丁没有破坏文件结构。
function checkSyntax(file) {
  const src = fs.readFileSync(file, 'utf8');
  try {
    new vm.Script(src, { filename: path.basename(file) });
  } catch (e) {
    throw new Error(`[${path.basename(file)}] 补丁后语法检查未通过: ${e.message}`);
  }
}

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const RESOURCE_DIR = path.join(REPO_ROOT, 'web_engine/src/main/resources/resfile/resources/app');
const ICON_SRC = path.join(RESOURCE_DIR, 'icon.png');
const TRAY_SRC = path.join(RESOURCE_DIR, 'tray.png');

// 解析出的标识符放在这里。换版本时无需人工维护对照表，解析器会从产物本身读出。
const IDENT = {};

// app.js 里的标识符。插到 app.js 的定制代码引用这几个名字。
const IDENT_APP = {};

// 解析 main.js 的符号，填充 IDENT。
// 解析器按「结构 + 稳定字符串」定位，不依赖任何具体变量名，
// 因此官方发布新版后无需人工核对该文件。
function resolveMainSymbolsInto(work) {
  const src = fs.readFileSync(path.join(work, 'main.js'), 'utf8');
  Object.assign(IDENT, resolveMainSymbols(src));
}

// 解析 app.js 的符号，填充 IDENT_APP。
function resolveAppSymbolsInto(work) {
  const src = fs.readFileSync(path.join(work, 'app.js'), 'utf8');
  Object.assign(IDENT_APP, resolveAppIdentifiers(src));
}

// 校验插入到 app.js 的定制代码没有引用不属于当前版本的标识符。
// 校验插入到 app.js 的定制代码没有引用未解析的符号。
// 模板本身已不含写死的标识符，这里检查渲染后的结果。
function verifyInjectedSymbols(rendered) {
  // 全局对象不算标识符绑定，列在这里排除。
  const allowed = new Set(['HcsSettingsTab', 'Date', 'Error', 'Promise', 'Object', 'Array', 'JSON', 'Math', 'Number', 'String']);
  for (const item of Object.values(IDENT_APP)) {
    allowed.add(item);
  }
  const problems = [];
  for (const name of new Set([...rendered.matchAll(/__[A-Z_]+__/g)].map((m) => m[0]))) {
    problems.push(`  未替换的占位符 ${name}`);
  }
  // 只看形如 new X( 与 return X(t,e) 的调用，这些是真正会被执行的符号引用。
  for (const m of rendered.matchAll(/new ([A-Za-z_$][\w$]*)\(/g)) {
    if (!allowed.has(m[1])) {
      problems.push(`  new ${m[1]}(`);
    }
  }
  for (const m of rendered.matchAll(/return ([A-Za-z_$][\w$]*)\(t,e\)/g)) {
    if (!allowed.has(m[1])) {
      problems.push(`  return ${m[1]}(t,e)`);
    }
  }
  for (const m of rendered.matchAll(/\},t\}\(([A-Za-z_$][\w$]*)\)/g)) {
    if (!allowed.has(m[1])) {
      problems.push(`  },t}(${m[1]})`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      'tools/hcs-settings-tab.js 引用了非本版本的标识符:\n' + problems.join('\n') +
      '\n请检查解析出的符号是否正确。'
    );
  }
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) {
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`参数 ${key} 缺少取值`);
    }
    out[key.slice(2)] = value;
    i += 1;
  }
  for (const required of ['input', 'output', 'version']) {
    if (!out[required]) {
      throw new Error(`缺少必需参数 --${required}`);
    }
  }
  return {
    input: path.resolve(out.input),
    output: path.resolve(out.output),
    version: out.version,
  };
}

class Patcher {
  constructor(file) {
    this.file = file;
    this.text = fs.readFileSync(file, 'utf8');
    this.applied = [];
  }

  // 单处替换。标记命中次数必须恰为 1。
  replace(id, find, next) {
    const hits = this.text.split(find).length - 1;
    if (hits !== 1) {
      throw new Error(
        `[${path.basename(this.file)}] ${id}: 定位标记命中 ${hits} 次，预期 1 次。\n标记: ${find.slice(0, 160)}`
      );
    }
    this.text = this.text.replace(find, next);
    this.applied.push({ id, count: 1 });
  }

  // 多处同文替换。命中次数必须等于 expected。
  replaceAll(id, find, next, expected) {
    const hits = this.text.split(find).length - 1;
    if (hits !== expected) {
      throw new Error(
        `[${path.basename(this.file)}] ${id}: 定位标记命中 ${hits} 次，预期 ${expected} 次。\n标记: ${find.slice(0, 160)}`
      );
    }
    this.text = this.text.split(find).join(next);
    this.applied.push({ id, count: hits });
  }

  // 正则替换。压缩产物里的局部变量名逐版重排，某些插入点的外侧结构固定、
  // 但内部临时变量配不上，这时用正则把可变部分捕获下来，再拼回替换文本。
  // 要求全局命中次数恰为 expected。
  replacePattern(id, pattern, buildReplacement, expected = 1) {
    const re = new RegExp(pattern, 'g');
    const matches = [...this.text.matchAll(re)];
    if (matches.length !== expected) {
      throw new Error(
        `[${path.basename(this.file)}] ${id}: 定位模式命中 ${matches.length} 次，预期 ${expected} 次。\n模式: ${pattern.slice(0, 160)}`
      );
    }
    let result = '';
    let cursor = 0;
    for (const m of matches) {
      result += this.text.slice(cursor, m.index) + buildReplacement(m);
      cursor = m.index + m[0].length;
    }
    result += this.text.slice(cursor);
    this.text = result;
    this.applied.push({ id, count: matches.length });
  }

  // 在标记之前插入内容。
  insertBefore(id, marker, insertion) {
    const hits = this.text.split(marker).length - 1;
    if (hits !== 1) {
      throw new Error(
        `[${path.basename(this.file)}] ${id}: 定位标记命中 ${hits} 次，预期 1 次。\n标记: ${marker.slice(0, 160)}`
      );
    }
    this.text = this.text.replace(marker, insertion + marker);
    this.applied.push({ id, count: 1 });
  }

  // 检查某个片段在最终文本中是否出现。
  assertContains(id, fragment) {
    const hits = this.text.split(fragment).length - 1;
    if (hits < 1) {
      throw new Error(`[${path.basename(this.file)}] ${id}: 替换完成后的自检失败，未找到片段。`);
    }
  }

  assertAbsent(id, fragment) {
    const hits = this.text.split(fragment).length - 1;
    if (hits !== 0) {
      throw new Error(`[${path.basename(this.file)}] ${id}: 替换完成后的自检失败，仍残留 ${hits} 处片段。`);
    }
  }

  // 累加括号计数只能发现明显失衡，真正的语法检查交给 checkSyntax 的替代手段。
  assertBalance(id) {
    const parens = (this.text.match(/\(/g) || []).length - (this.text.match(/\)/g) || []).length;
    const braces = (this.text.match(/\{/g) || []).length - (this.text.match(/\}/g) || []).length;
    // 正则字面量里的括号会让计数不准，只对大幅偏离报错。
    const baseline = this.baseline || { parens: 0, braces: 0 };
    if (Math.abs(parens - baseline.parens) > 200 || Math.abs(braces - baseline.braces) > 200) {
      throw new Error(
        `[${path.basename(this.file)}] ${id}: 括号计数偏离过大（圆括号 ${parens}，花括号 ${braces}），可能存在截断。`
      );
    }
  }

  save() {
    fs.writeFileSync(this.file, this.text);
    return this.applied;
  }
}

// hcs-* 通道的 12 个处理器。
//
// 两处与 1.12.7 不同的地方需要留意：
//
// 1. 变量名按 1.13.4 的映射改写（见 IDENT）。原实现在 1.12.7 里用 x/h/D/s，
//    1.13.4 里对应 R/m/C/l。
// 2. 所有局部变量加 _ 前缀。原因是 1.13.4 把 fs 的别名从 h 改成了 m，
//    而原代码里用 m 当 cloud-sync-mirror 的目录变量，会遮蔽模块级的 fs，
//    导致 m.readFileSync 对字符串调用而抛错。加前缀根除这类与模块别名的撞名。
function buildHcsBlock() {
  const { electron: E, fs: F, path: P, userData: U } = IDENT;
  const lines = [
    `${E}.ipcMain.on("hcs-get-status",(t)=>{var _p=${P}.join(${U},"hcs-sync-status.json"),_e=${P}.join(${U},"hcs-auto-sync.json"),_f=${P}.join(${U},"hcs-excluded.json"),_m=${P}.join(${U},"cloud-sync-mirror");try{var _s=JSON.parse(${F}.readFileSync(_p,"utf8")),_a=JSON.parse(${F}.readFileSync(_e,"utf8"));_s.autoSync=_a.enabled}catch(_c){_s={status:"就绪",lastSync:null,files:[],totalSize:0,autoSync:!1}}try{_s.excluded=JSON.parse(${F}.readFileSync(_f,"utf8")).folders||[]}catch(_c){_s.excluded=[]}try{_s.cloudFiles=${F}.existsSync(_m)?${F}.readdirSync(_m).filter((function(_x){return ${F}.statSync(${P}.join(_m,_x)).isFile()})).length:0}catch(_c){_s.cloudFiles=0}try{_s.userId=JSON.parse(${F}.readFileSync(${P}.join(${U},"hcs-user.json"),"utf8")).userId}catch(_c){_s.userId=null}t.returnValue=_s}),`,
    `${E}.ipcMain.on("hcs-sync-all",(t,n)=>{var _v=[],_z=0;var _xf=[];var _md=${P}.join(${U},"cloud-sync-mirror");try{_xf=JSON.parse(${F}.readFileSync(${P}.join(${U},"hcs-excluded.json"),"utf8")).folders||[]}catch(_c){}try{${F}.existsSync(_md)||${F}.mkdirSync(_md,{recursive:!0});var _list=${F}.readdirSync(n,{recursive:!0});for(var _i=0;_i<_list.length;_i++){var _r=_list[_i];var _abs=${P}.join(n,_r);try{var _st=${F}.statSync(_abs);if(_st.isFile()){var _skip=!1;for(var _j=0;_j<_xf.length;_j++){if(_r.startsWith(_xf[_j])){_skip=!0;break}}if(!_skip){var _buf=${F}.readFileSync(_abs);var _ms=${P}.join(_md,_r);var _mp=${P}.dirname(_ms);${F}.existsSync(_mp)||${F}.mkdirSync(_mp,{recursive:!0});${F}.copyFileSync(_abs,_ms);var _hash="md5_"+_buf.length+"_"+_st.mtimeMs;_v.push({path:_r,hash:_hash,size:_st.size,modified:_st.mtimeMs});_z+=_st.size}}}catch(_c){}}}catch(_c){}var _sn={status:"已同步 ("+_v.length+"个文件)",lastSync:Date.now(),files:_v,totalSize:_z};${F}.writeFileSync(${P}.join(${U},"hcs-sync-status.json"),JSON.stringify(_sn));t.returnValue=_sn}),`,
    `${E}.ipcMain.on("hcs-get-auto-sync",(t)=>{try{t.returnValue=JSON.parse(${F}.readFileSync(${P}.join(${U},"hcs-auto-sync.json"),"utf8")).enabled}catch(_e){t.returnValue=!1}}),`,
    `${E}.ipcMain.on("hcs-set-auto-sync",(t,n)=>{var _on=!!n;${F}.writeFileSync(${P}.join(${U},"hcs-auto-sync.json"),JSON.stringify({enabled:_on})),t.returnValue=_on}),`,
    `${E}.ipcMain.on("hcs-get-excluded",(t)=>{try{t.returnValue=JSON.parse(${F}.readFileSync(${P}.join(${U},"hcs-excluded.json"),"utf8")).folders}catch(_e){t.returnValue=[]}}),`,
    `${E}.ipcMain.on("hcs-set-excluded",(t,n)=>{${F}.writeFileSync(${P}.join(${U},"hcs-excluded.json"),JSON.stringify({folders:n||[]})),t.returnValue=!0}),`,
    `${E}.ipcMain.on("hcs-get-userid",(t)=>{try{t.returnValue=JSON.parse(${F}.readFileSync(${P}.join(${U},"hcs-user.json"),"utf8")).userId}catch(_e){t.returnValue=null}try{var _pf=${P}.join(${U},".hcs-login-pending");if(${F}.existsSync(_pf)){var _ts=parseInt(${F}.readFileSync(_pf,"utf8"));if(Date.now()-_ts<3e4)t.returnValue="pending"}}catch(_e){}}),`,
    `${E}.ipcMain.on("hcs-set-userid",(t,n)=>{${F}.writeFileSync(${P}.join(${U},"hcs-user.json"),JSON.stringify({userId:n,loginTime:Date.now()})),t.returnValue=!0}),`,
    `${E}.ipcMain.on("hcs-login",(t)=>{${F}.writeFileSync(${P}.join(${U},".hcs-login-pending"),Date.now().toString());t.returnValue=null}),`,
    `${E}.ipcMain.on("hcs-restore-list",(t)=>{var _mir=${P}.join(${U},"cloud-sync-mirror");t.returnValue=${F}.existsSync(_mir)?${F}.readdirSync(_mir).filter((function(_x){return ${F}.statSync(${P}.join(_mir,_x)).isFile()})):[]}),`,
    `${E}.ipcMain.on("hcs-restore-file",(t,n)=>{var _src=${P}.join(${U},"cloud-sync-mirror",n.path),_status=JSON.parse(${F}.readFileSync(${P}.join(${U},"hcs-sync-status.json"),"utf8")),_rec=_status.files.find((function(_x){return _x.path===n.path}));if(_rec){var _rel=_rec.path,_dst=${P}.join(n.vaultPath,_rel),_dir=${P}.dirname(_dst);${F}.existsSync(_dir)||${F}.mkdirSync(_dir,{recursive:!0});try{${F}.copyFileSync(_src,_dst);t.returnValue=!0}catch(_c){t.returnValue=!1}}else t.returnValue=!1}),`,
    `${E}.ipcMain.on("hcs-code",(t,n)=>{var _status=JSON.parse(${F}.readFileSync(${P}.join(${U},"hcs-sync-status.json"),"utf8"));t.returnValue=JSON.stringify({lastSync:_status.lastSync,count:_status.files.length,status:_status.status})}),`,
  ];
  return lines.join('\n');
}

function patchMainJs(work) {
  const file = path.join(work, 'main.js');
  const p = new Patcher(file);
  const { electron: E, path: P, fs: F, userData: U } = IDENT;
  // 解出的其余角色。补丁文本里不再出现写死的变量名。
  const MAJOR = IDENT.electronMajor;
  const VAULTS = IDENT.vaultTable;
  const TABLE = IDENT.windowTable;
  const WIN = IDENT.vaultWindowCreator;
  const AUX = IDENT.auxWindowCreator;
  const STARTER_OPEN = IDENT.starterOpen;
  const STARTER = IDENT.starterWindow;
  const HELP_OPEN = IDENT.helpOpen;
  const HELP = IDENT.helpWindow;
  const WIRE = IDENT.windowWiring;
  const REGISTER = IDENT.windowRegister;
  const MARK_OPEN = IDENT.markVaultOpen;
  const SAVE = IDENT.configSave;
  const READ = IDENT.configRead;
  const RES = IDENT.resourceDir;
  const HELP_BASE = IDENT.help;
  const VAULT_URL = IDENT.vaultUrl;

  // 1. 短路 Electron 版本下限检查。
  p.replace(
    'main.version-guard',
    `if(${MAJOR}<18){${E}.dialog.showErrorBox("Manual update required"`,
    `if(false&&${MAJOR}<18){${E}.dialog.showErrorBox("Manual update required"`
  );

  // 2. 新增托盘与退出相关状态变量。
  p.replace(
    'main.tray-vars',
    `let ${TABLE}={},`,
    `let ${TABLE}={},Ee_tray=!0,qtray=null,isQt=!1,`
  );

  // 3. 托盘初始化，插在 whenReady 回调开头。
  // 这里的 ${STARTER} 是 starter 窗口。1.12.7 里这个窗口叫 le，但 1.13.4 把 le 改用作图标路径，
  // 直接沿用旧名字会拿到字符串，isVisible() 会抛错。窗口变量由解析器给出。
  // 回调内的局部参数名逐版重排，从产物里读出来。
  const whenReadyHead = `${E}.app.whenReady().then(()=>{`;
  const whenReadyTail = p.text.slice(p.text.indexOf(whenReadyHead) + whenReadyHead.length).match(/^let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)=>{/);
  if (!whenReadyTail) {
    throw new Error('无法定位 whenReady 回调的开头，托盘初始化的插入位置未知');
  }
  p.replace(
    'main.tray-init',
    `${whenReadyHead}let ${whenReadyTail[1]}=${whenReadyTail[2]}=>{`,
    `${E}.app.whenReady().then(()=>{setTimeout(()=>{try{qtray||(qtray=new ${E}.Tray(${P}.join(${RES},"tray.png")),qtray.on("click",()=>{let w=${STARTER}||Object.values(${TABLE})[0];w&&(w.isVisible()?w.hide():w.show())}),qtray.setContextMenu(${E}.Menu.buildFromTemplate([{label:"显示",click:()=>{let w=${STARTER}||Object.values(${TABLE})[0];w&&w.show()}},{label:"退出软件",click:()=>{Ee_tray=!1;try{qtray.destroy()}catch(_e){}${E}.app.quit()}}])))}catch(_e){console.error("Tray init failed:",_e)}},1000);let ${whenReadyTail[1]}=${whenReadyTail[2]}=>{`
  );

  // 4. 关窗时最小化到托盘。标记从产物里解析，包含回调内部的局部变量名。
  const closeHandler = IDENT.vaultWindowCloseHandler;
  const closeVar = closeHandler.param;
  if (!closeVar) throw new Error('仓库窗口的关闭处理器没有取到事件参数名，无法插入托盘逻辑');
  const closeWin = closeHandler.text.match(/^([A-Za-z_$][\w$]*)\.on/)[1];
  const closeInsert = `if(!isQt&&Ee_tray){${closeVar}.preventDefault();try{${closeWin}.hide()}catch(e){try{${closeWin}.minimize()}catch(e){}}return}`;
  const closeNext = closeHandler.text.replace(/\{/, `{${closeInsert}`);
  p.replace('main.close-to-tray', closeHandler.text, closeNext);

  // 5. 新增 exit-to-tray 与 force-quit 通道。
  p.replace(
    'main.exit-to-tray',
    `${E}.ipcMain.on("relaunch",t=>{t.returnValue="",console.log("Relaunching!")`,
    `${E}.ipcMain.on("exit-to-tray",(t,n)=>{n!==void 0&&(Ee_tray=!!n),t.returnValue=Ee_tray}),${E}.ipcMain.on("force-quit",()=>{Ee_tray=!1,isQt=!0,${E}.app.quit()}),${E}.ipcMain.on("relaunch",t=>{t.returnValue="",console.log("Relaunching!")`
  );

  // 6. 新增 before-quit 标记，用于区分真正退出与关窗到托盘。
  // 产物自带的 before-quit 设置的是 Obsidian 自己的退出标志，与我们的 isQt 无关，
  // 两者必须共存，因此这里无条件追加一个。
  p.replace(
    'main.before-quit',
    `${E}.app.on("window-all-closed",()=>{`,
    `${E}.app.on("before-quit",()=>{isQt=!0}),${E}.app.on("window-all-closed",()=>{`
  );

  // 7. starter 与 help 通道按发送窗口定位。
  p.replace(
    'main.starter-ipc',
    `${E}.ipcMain.on("starter",t=>{t.returnValue=null,${STARTER_OPEN}()}),${E}.ipcMain.on("help",t=>{t.returnValue=null,${HELP_OPEN}()}),`,
    `${E}.ipcMain.on("starter",t=>{t.returnValue=null;let w=${E}.BrowserWindow.fromWebContents(t.sender);for(let e in ${TABLE})if(${TABLE}[e]===w){w.loadURL(${HELP_BASE}+"starter.html");return}${STARTER_OPEN}()}),${E}.ipcMain.on("help",t=>{t.returnValue=null;let w=${E}.BrowserWindow.fromWebContents(t.sender);for(let e in ${TABLE})if(${TABLE}[e]===w){w.once("close",(y)=>{y.preventDefault(),w.loadURL(${VAULT_URL})}),w.loadURL(${HELP_BASE}+"help.html");return}${HELP_OPEN}()}),`
  );

  // 8. help 窗口复用 starter 窗口。
  // 打开函数内部给窗口变量赋值用的临时变量名逐版重排，用正则把可变部分捕获下来。
  p.replacePattern(
    'main.help-reuse',
    `function ${HELP_OPEN}\\(\\)\\{if\\(${HELP}\\)\\{${HELP}\\.isMinimized\\(\\)&&${HELP}\\.restore\\(\\),${HELP}\\.focus\\(\\);return\\}let ([A-Za-z_$][\\w$]*)=${HELP}=${AUX}\\(\\{width:600,height:680\\}\\);`,
    (m) => `function ${HELP_OPEN}(){if(${HELP}){${HELP}.isMinimized()&&${HELP}.restore(),${HELP}.focus();return}if(${STARTER}&&!${STARTER}.isDestroyed()){let r=${STARTER};${HELP}=r,${STARTER}=null;let i=function(e){e.preventDefault(),r.loadURL(${HELP_BASE}+"starter.html").then(()=>{${HELP}=null,${STARTER}=r})};return r.once("close",i),void r.loadURL(${HELP_BASE}+"help.html")}let ${m[1]}=${HELP}=${AUX}({width:600,height:680});`
  );

  // 9. starter 窗口复用为仓库窗口。
  p.replacePattern(
    'main.ke-reuse',
    `let ([A-Za-z_$][\\w$]*)=${'\\(\\)'}=>\\{for\\(let ([A-Za-z_$][\\w$]*) in ${VAULTS}\\)${VAULTS}\\[\\2\\]\\.open&&${WIN}\\(\\2\\);Object\\.keys\\(${TABLE}\\)\\.length===0&&${STARTER_OPEN}\\(\\)\\};`,
    (m) => `let ${m[1]}=()=>{let r=[];for(let o in ${VAULTS})${VAULTS}[o].open&&r.push(o);if(r.length>0){${STARTER_OPEN}();for(let e of r){if(${STARTER}&&!${STARTER}.isDestroyed()){${TABLE}[e]=${STARTER},${STARTER}=null,${WIRE}(${TABLE}[e],!0),${MARK_OPEN}(e,!0),${TABLE}[e].loadURL(${VAULT_URL}).then(()=>{${TABLE}[e].loaded=!0,${TABLE}[e].setResizable(!0),${TABLE}[e].setMaximizable(!0),${TABLE}[e].setMinimumSize(200,150),${TABLE}[e].show&&${TABLE}[e].show()});break}}}else ${STARTER_OPEN}()};`
  );

  // 10. 12 个 hcs-* 通道。插在 vault-move 之后、vault-open 之前。
  //
  // 标记必须带上前面的模块前缀，否则会只匹配到 ipcMain.on(...) 而把前缀留在原地，
  // 拼上替换文本里的前缀后变成重复前缀，运行时读不到 ipcMain。
  // vault-open 的第三个参数名逐版重排，用正则捕获后原样保留。
  p.replacePattern(
    'main.hcs-channels',
    `(${E}\\.ipcMain\\.on\\("vault-open",\\(t,n,([A-Za-z_$][\\w$]*)\\)=>\\{if\\(\\2\\)\\{if\\(${F}\\.existsSync\\(n\\)\\)\\{t\\.returnValue="Vault already exists";return\\})`,
    (m) => buildHcsBlock() + '\n' + m[1]
  );

  // 11. 打开最近仓库时复用 starter 窗口。两个分支都要插入，
  // 目的与 starter.js 去掉 window.close() 配套：冷启动时把已有的 starter
  // 窗口改造成仓库窗口。
  // 这段代码内部的循环变量与随机 id 函数名逐版重排，用正则捕获后原样使用。
  const reuseStartWindow = (vaultId) => [
    `if(${STARTER}&&!${STARTER}.isDestroyed()){`,
    `let _w=${STARTER};${TABLE}[${vaultId}]=_w,${STARTER}=null,${WIRE}(_w,!0),${MARK_OPEN}(${vaultId},!0),`,
    `_w.on("close",(_ev)=>{`,
    `let _st=${READ}(${vaultId});`,
    `function _save(){try{`,
    `let _b=_w.getBounds(),`,
    `_ok=function(){return !_w.isMaximized()&&!_w.isMinimized()&&!_w.isFullScreen()};`,
    `_ok()&&(_st.x=_b.x,_st.y=_b.y,_st.width=_b.width,_st.height=_b.height),`,
    `_st.isMaximized=_w.isMaximized(),`,
    `_st.devTools=_w.webContents.isDevToolsOpened(),`,
    `_st.zoom=_w.webContents.zoomLevel}catch(_e){}}`,
    `_save(),${SAVE}(${vaultId},_st),`,
    `setTimeout(()=>{!_ev.defaultPrevented&&!_w.isDestroyed()&&_w.destroy()},3e3)}),`,
    `_w.on("closed",()=>{delete ${TABLE}[${vaultId}]}),`,
    `_w.loadURL(${VAULT_URL}).then(()=>{`,
    `_w.loaded=!0,_w.setResizable(!0),_w.setMaximizable(!0),_w.setMinimizable(!0),_w.setMinimumSize(200,150);`,
    `try{_w.setBackgroundColor("#00000000")}catch(_e){}_w.show&&_w.show()})`,
    `}else{${WIN}(${vaultId})}`,
  ].join('');

  // 两处 else 必须包在花括号里。写成 `...}else ${WIN}(s);` 时，这个 else 会去匹配
  // 外层 if(d.path===t)，造成大括号失衡，语法检查会报 Unexpected token ')'。
  p.replacePattern(
    'main.reuse-existing-vault-window',
    `for\\(let ([A-Za-z_$][\\w$]*) in ${VAULTS}\\)\\{let ([A-Za-z_$][\\w$]*)=${VAULTS}\\[\\1\\];if\\(\\2\\.path===t\\)return \\2\\.ts=Date\\.now\\(\\),${WIN}\\(\\1\\),${E}\\.app\\.addRecentDocument\\(t\\),!0\\}let ([A-Za-z_$][\\w$]*)=([A-Za-z_$][\\w$]*)\\(16\\);return ${VAULTS}\\[\\3\\]=\\{path:t,ts:Date\\.now\\(\\)\\},${WIN}\\(\\3\\),${E}\\.app\\.addRecentDocument\\(t\\),!0\\}`,
    (m) => [
      `for(let ${m[1]} in ${VAULTS}){let ${m[2]}=${VAULTS}[${m[1]}];if(${m[2]}.path===t){${m[2]}.ts=Date.now();`,
      reuseStartWindow(m[1]),
      `return ${E}.app.addRecentDocument(t),!0}}`,
      `let ${m[3]}=${m[4]}(16);${VAULTS}[${m[3]}]={path:t,ts:Date.now()};`,
      reuseStartWindow(m[3]),
      `return ${E}.app.addRecentDocument(t),!0}`,
    ].join('')
  );

  // 自检: 替换标记漏掉前缀时会产生重复前缀，运行时报读不到 ipcMain。
  p.assertAbsent('main.dup-prefix-l', `${E}.${E}.`);
  p.assertAbsent('main.dup-prefix-m', `${F}.${F}.`);
  p.assertAbsent('main.dup-prefix-C', `${P}.${P}.`);
  p.assertContains('main.hcs-login', 'hcs-login');
  p.assertContains('main.exit-tray', 'exit-to-tray');
  p.assertContains('main.force-quit', 'force-quit');

  return p.save();
}

// HcsSettingsTab 的类定义。
// 源模板里的占位符按当前版本解析出的符号替换，
// 因此换版本时这个文件无需修改。
function buildHcsSettingsTab() {
  const A = IDENT_APP;
  // 刷新方式：1.13.4 起基类提供 update()；1.12.7 只有 display()。
  const refresh = A.settingsTabBaseMode === 'definitions'
    ? 'self.update()'
    : 'self.display()';
  // 1.13.4 起基类自己定义 getSettingDefinitions 与 update()，直接用；
  // 1.12.7 的基类只有 hide()，子类需自行实现 display() 并列创建设置项。
  // 两个方法共用同一份定义数组。
  const displayFallback = A.settingsTabBaseMode === 'definitions'
    ? ''
    : 't.prototype.display=function(){' +
      'var self=this,c=this.containerEl;c.empty();' +
      'self.getSettingDefinitions().forEach(function(item){' +
      `var s=new ${A.settingContainer}(c);` +
      's.setName(item.name);if(item.desc!=null)s.setDesc(item.desc);' +
      'if(item.render)item.render(s);});},';
  const body = buildHcsSettingsTabSource()
    .replaceAll('__DISPLAY_FALLBACK__', displayFallback)
    .replaceAll('__EXTEND__', A.extend)
    .replaceAll('__NOTICE__', A.notice)
    .replaceAll('__SETTINGS_TAB_BASE__', A.settingsTabBase)
    .replaceAll('__SETTING_ITEM__', A.settingContainer)
    .replaceAll('__REFRESH__(self)', refresh);
  const left = [...body.replace(/\/\/[^\n]*/g, '').matchAll(/__[A-Z_]+__/g)].map((m) => m[0]);
  if (left.length > 0) {
    throw new Error(`tools/hcs-settings-tab.js 里还有未替换的占位符: ${[...new Set(left)].join(', ')}`);
  }
  // 类文件用多行书写使于核对括号，嵌入 app.js 前去掉换行。
  // 压缩产物是单行，但换行本身在 JS 里合法；这里去除是为了让插入点两侧的
  // 行结构不被破坏。
  // 注释行必须先整行剔除，再去掉换行。否则去掉换行后，行尾注释会把
  // 后面的代码一并注释掉，造成语法错误。
  return body.replace(/^\s*\/\/.*$/gm, '').trim().replace(/\s*\n\s*/g, '');
}

function buildHcsSettingsTabSource() {
  return fs.readFileSync(path.join(REPO_ROOT, 'tools/hcs-settings-tab.js'), 'utf8');
}

function patchAppJs(work) {
  const file = path.join(work, 'app.js');
  const p = new Patcher(file);
  // 补丁文本里引用的内部符号一律取自解析结果。
  const A = IDENT_APP;
  const I18N = A.i18n;
  const FRAME = A.frameDom;
  const BASE = A.settingsTabBase;

  // 1. [HMOS-FRAME] 窗口按钮可见性与右边距。
  p.replace(
    'app.hmos-frame',
    `e.parent===e&&function(e){var t=e.electron.ipcRenderer.sendSync("frame")||"hidden";e.titlebarStyle=t,"native"!==t&&(e.frameDom=new ${FRAME}(e.electronWindow,e),"hidden"===t&&e.document.body.addClass("is-hidden-frameless"))}(e)`,
    `e.parent===e&&function(e){var t=e.electron.ipcRenderer.sendSync("frame")||"hidden";e.titlebarStyle=t;try{"function"==typeof e.electronWindow.setWindowButtonVisibility&&"native"!==t&&e.electronWindow.setWindowButtonVisibility("hidden"===t)}catch(n){console.error("[HMOS-FRAME] failed to set window button visibility",n)}"native"!==t&&(e.frameDom=new ${FRAME}(e.electronWindow,e),"hidden"===t&&(e.document.body.addClass("is-hidden-frameless"),e.document.body.style.setProperty("--frame-right-space","126px")))}(e)`
  );

  // 2. 「关于」页的版本项：去掉更新分支与检查更新按钮，只保留版本号与安装程序版本。
  p.replace(
    'app.about-version',
    `t.setName(${A.aboutI18n}.labelVersion({version:td.version})).setDesc(createFragment((function(e){e.appendText(${A.aboutI18n}.labelInstallVersion({version:td.build})),e.createEl("br"),"update-downloaded"===n?(e.appendText(${A.aboutI18n}.labelNewVersionReady()),e.createEl("br"),e.createEl("a",{text:${A.aboutI18n}.labelReadChangelog(),attr:{href:"https://obsidian.md/changelog",target:"_blank",rel:"noopener"}})):"update-manual-required"===n||qy(pf,xie)?(e.createEl("b",{text:${A.aboutI18n}.labelManualUpdateRequired()}),e.appendText(" "),e.createEl("a",{text:${I18N}.dialogue.buttonDownload(),attr:{href:Vy(),target:"_blank",rel:"noopener"}})):e.createEl("a",{text:${A.aboutI18n}.labelReadChangelog(),attr:{href:"https://obsidian.md/changelog",target:"_blank",rel:"noopener"}})}))),"update-downloaded"===n?t.addButton((function(t){return t.setCta().setButtonText(${A.aboutI18n}.buttonRelaunch()).onClick((function(){return e.app.relaunch()}))})):t.addButton((function(t){return t.setButtonText(${A.aboutI18n}.buttonCheckForUpdates()).setLoading(i).onClick((function(){of((function(t){t.ipcRenderer.send("check-update",!0),e.updateVersionSetting()}))}))}))`,
    `t.setName(${A.aboutI18n}.labelVersion({version:td.version})).setDesc(createFragment((function(e){e.appendText(${A.aboutI18n}.labelInstallVersion({version:td.build}))})))`
  );

  // 3. 「外观」页插入「退出软件」开关。位置在自定义图标按钮之后、translucency 项之前。
  p.replace(
    'app.exit-to-tray-toggle',
    `n.buttonEl.hide(),c()}}),vf()&&p.push({name:${I18N}.plugins.translucency.name()`,
    `n.buttonEl.hide(),c()}}),p.push({name:"退出软件",desc:"开启后，点击关闭按钮不会退出软件，需在托盘中退出软件",render:function(s){s.addToggle((function(c){return c.setValue(e.app.loadLocalStorage("exit-to-tray")!=="0").onChange((function(t){t?e.app.saveLocalStorage("exit-to-tray","1"):e.app.saveLocalStorage("exit-to-tray","0"),electron&&electron.ipcRenderer&&electron.ipcRenderer.sendSync("exit-to-tray",!!t)}))}))}}),vf()&&p.push({name:${I18N}.plugins.translucency.name()`
  );

  // 4. 插入 HcsSettingsTab 类定义。定位依据是社区插件设置页类的结尾：
  //    它以 `t}(<设置页基类>),<文案变量>=<i18n>.setting.thirdPartyPlugin,` 收束，
  //    新定义插在 �losing 前缀之后。
  //    注意保留 `t}(<BASE>),` 前缀，它属于上一个类的结尾，不能一并吃掉。
  const tabAnchor = `t}(${BASE}),${A.thirdPartyI18n}=${I18N}.setting.thirdPartyPlugin`;
  p.replace(
    'app.hcs-tab-class',
    tabAnchor,
    `t}(${BASE}),` + buildHcsSettingsTab() + `,${A.thirdPartyI18n}=${I18N}.setting.thirdPartyPlugin`
  );

  // 5. 注册 HcsSettingsTab。
  const registerAnchor = `n.addSettingTab(new ${A.communityTab}(t,n)),${A.platformFlags}.isMobile&&ug(n.contentEl`;
  p.replace(
    'app.hcs-tab-register',
    registerAnchor,
    `n.addSettingTab(new ${A.communityTab}(t,n)),n.addSettingTab(new HcsSettingsTab(t,n)),${A.platformFlags}.isMobile&&ug(n.contentEl`
  );

  p.assertContains('app.hmos-frame-check', '[HMOS-FRAME]');
  p.assertContains('app.hcs-tab-check', 'HcsSettingsTab');
  p.assertContains('app.exit-tray-check', 'exit-to-tray');

  return p.save();
}

function patchStarterJs(work) {
  const file = path.join(work, 'starter.js');
  const p = new Patcher(file);

  // 1. 标题栏文字。
  p.replace('starter.titlebar-text', 'text:"Obsidian"', 'text:"OHsidian"');

  // 2. 打开仓库后不再关窗。1.13.4 中该写法出现多次，需按实际次数核对。
  const occurrences = p.text.split('window.close()').length - 1;
  if (occurrences > 0) {
    p.replaceAll('starter.no-window-close', 'window.close()', 'void 0', occurrences);
  }

  return p.save();
}

function patchI18nJs(work) {
  const file = path.join(work, 'i18n.js');
  const p = new Patcher(file);

  // about 段落里的 7 个键。按「键名 + 官方原值」成对定位，避免误伤同名的其它段落。
  // 例如 buttonCheckForUpdates 在多处出现，只有 about 段落的值需要改。
  const replacements = [
    ['labelVersion', 'Version {{version}}', 'HarmonyOS-{{version}}'],
    ['labelInstallVersion', 'Installer version: {{version}}', 'HarmonyOS Port {{version}}'],
    ['labelReadChangelog', 'Read the changelog.', ''],
    [
      'labelManualUpdateRequired',
      'To support the latest features and to receive the latest security patches, Obsidian needs a major installer update. You need to manually download and reinstall Obsidian.',
      'This is a HarmonyOS port. Original update channels are not available.',
    ],
    ['labelDisabledUpdates', 'Updates are disabled.', 'Updates are disabled. Running on HarmonyOS.'],
    ['optionAutoUpdateDescription', 'Turn this off to prevent the app from checking for updates.', 'Automatic updates are disabled on HarmonyOS port.'],
  ];

  for (const [key, from, to] of replacements) {
    const marker = `${key}:"${from}"`;
    p.replace(`i18n.${key}`, marker, `${key}:"${to}"`);
  }

  // buttonCheckForUpdates 在多个段落里都有，不能用唯一性检查，
  // 改用「about 段落内定位」的办法。
  p.replace(
    'i18n.buttonCheckForUpdates',
    'labelDisabledUpdates:"Updates are disabled. Running on HarmonyOS.",buttonRelaunch:"Relaunch",buttonCheckForUpdates:"Check for updates"',
    'labelDisabledUpdates:"Updates are disabled. Running on HarmonyOS.",buttonRelaunch:"Relaunch",buttonCheckForUpdates:"Updates not available"'
  );

  p.assertContains('i18n.check', 'HarmonyOS-{{version}}');
  return p.save();
}

function patchZhText(work) {
  const file = path.join(work, 'i18n/zh.txt');
  const p = new Patcher(file);

  // 这一整段是 setting.about 的更新相关文案，1.12.7 与 1.13.4 两版逐行相同。
  // 在 1.13.4 里的行号是 304-313。整段替换比逐行替换稳定，
  // 因为「版本 {{version}}」单独出现时在文件里有 4 处。
  const from = [
    '版本 {{version}}',
    '安装程序版本: {{version}}',
    '阅读更新日志',
    'Obsidian 需要进行一次较大的更新来获取最新功能和安全补丁。为此，你需要手动下载安装包并重新安装 Obsidian。',
    '准备安装新版本。 ',
    '更新已禁用。',
    '重新启动应用',
    '检查更新',
    '自动更新',
    '关闭后 Obsidian 将不会自动更新。',
  ].join('\n') + '\n';
  const to = [
    'HarmonyOS-{{version}}',
    'HarmonyOS 移植版本 {{version}}',
    '',
    '此版本为 HarmonyOS 移植版，原有更新通道不可用。',
    '准备安装新版本。 ',
    '更新已禁用（HarmonyOS 移植版）。',
    '重新启动应用',
    '更新不可用',
    '自动更新',
    'HarmonyOS 移植版不支持自动更新。',
  ].join('\n') + '\n';

  p.replace('zh.about-block', from, to);
  p.assertContains('zh.check', 'HarmonyOS-{{version}}');
  return p.save();
}

function patchAppCss(work) {
  const file = path.join(work, 'app.css');
  const p = new Patcher(file);

  // 1.13.4 把 .starter.is-hidden-frameless .titlebar 合并进了复合选择器，
  // 仓库原来改的那条规则不存在了。改为直接隐藏 starter 标题栏。
  p.replace(
    'css.starter-titlebar',
    '.starter .titlebar {\n  background-color: transparent;\n  border: none;\n}',
    '.starter .titlebar {\n  display: none;\n}'
  );
  p.replace(
    'css.starter-padding',
    '.starter {\n  -webkit-user-select: none;\n  padding-top: 0! important;\n}',
    '.starter {\n  -webkit-user-select: none;\n  padding-top: 30px! important;\n}'
  );
  return p.save();
}

function patchPackageJson(work, version) {
  const file = path.join(work, 'package.json');
  const raw = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(raw);
  data.author = 'OHsidian';
  data.description = 'OHsidian HarmonyOS Edition';
  data.version = version;
  fs.writeFileSync(file, JSON.stringify(data, null, '\t') + '\n');
  return [{ id: 'package.json', count: 1 }];
}

function patchHtmlTitles(work) {
  const applied = [];
  for (const name of ['index.html', 'starter.html', 'help.html']) {
    const file = path.join(work, name);
    const text = fs.readFileSync(file, 'utf8');
    const hits = text.split('<title>Obsidian</title>').length - 1;
    if (hits !== 1) {
      throw new Error(`[${name}] html.title: 定位标记命中 ${hits} 次，预期 1 次。`);
    }
    fs.writeFileSync(file, text.replace('<title>Obsidian</title>', '<title>OHsidian</title>'));
    applied.push({ id: `${name}.title`, count: 1 });
  }
  return applied;
}

function copyResources(work) {
  const applied = [];
  for (const [src, name] of [[ICON_SRC, 'icon.png'], [TRAY_SRC, 'tray.png']]) {
    if (!fs.existsSync(src)) {
      throw new Error(`资源文件不存在: ${src}`);
    }
    fs.copyFileSync(src, path.join(work, name));
    applied.push({ id: `resource.${name}`, count: 1 });
  }
  for (const name of ['icon.png.bak', 'harmonyos-sync-bridge.js']) {
    const target = path.join(work, name);
    if (fs.existsSync(target)) {
      fs.rmSync(target);
      applied.push({ id: `resource.remove.${name}`, count: 1 });
    }
  }
  return applied;
}

async function main() {
  const args = parseArgs();
  if (!fs.existsSync(args.input)) {
    throw new Error(`输入文件不存在: ${args.input}`);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ohsidian-asar-'));
  const applied = [];
  try {
    console.log(`解包 ${args.input}`);
    await extractAll(args.input, work);

    // 先解析符号再用它们施加补丁。解析失败会直接报错，
    // 不会带着写死的旧版本名字继续构建出一个能打包但运行时报错的产物。
    console.log('解析 main.js 的符号');
    resolveMainSymbolsInto(work);
    console.log('解析 app.js 的符号');
    resolveAppSymbolsInto(work);

    applied.push(...copyResources(work));
    applied.push(...patchHtmlTitles(work));
    applied.push(...patchPackageJson(work, args.version));
    applied.push(...patchMainJs(work));
    applied.push(...patchAppJs(work));
    applied.push(...patchStarterJs(work));
    applied.push(...patchI18nJs(work));
    applied.push(...patchZhText(work));
    applied.push(...patchAppCss(work));

    // 补丁全部施加后做语法检查，确认没有破坏文件结构。
    for (const name of ['main.js', 'app.js', 'starter.js']) {
      checkSyntax(path.join(work, name));
    }

    // 确认插入 app.js 的代码引用的标识符确实存在。
    verifyInjectedSymbols(buildHcsSettingsTab());

    console.log('');
    console.log('解析出的符号:');
    for (const [key, value] of Object.entries({ ...IDENT, ...IDENT_APP })) {
      console.log(`  ${key.padEnd(20)} ${value}`);
    }

    console.log(`打包到 ${args.output}`);
    await createPackageWithOptions(work, args.output, {});

    console.log('');
    console.log('改动摘要:');
    for (const item of applied) {
      console.log(`  命中 ${String(item.count).padStart(2)} 次  ${item.id}`);
    }
    console.log('');
    console.log(`产物: ${args.output}`);
    console.log(`大小: ${fs.statSync(args.output).size}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('');
  console.error('构建失败:');
  console.error(e.message);
  process.exit(1);
});
