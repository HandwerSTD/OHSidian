// HcsSettingsTab 类的源码模板。
//
// 里面的 __EXTEND__、__NOTICE__、__SETTINGS_TAB_BASE__、__REFRESH__ 是占位符，
// 由 build-asar.mjs 按当前版本解析出的真实符号替换。压缩产物里的这些标识符
// 逐版重排，写死任何一个都会在换版本后指向错误的对象。
HcsSettingsTab=function(e){
function t(t,n){var r=e.call(this,t,n)||this;return r.id="huawei-cloud-sync",r.name="华为云同步",r.icon="cloud",r}
return __EXTEND__(t,e),t.prototype.getSettingDefinitions=function(){
var self=this,d=[];
var uid=electron.ipcRenderer.sendSync('hcs-get-userid');
if(!uid||uid==='pending'){
  var isPend=uid==='pending';
  d.push({
    name:"华为云同步",
    desc:isPend?'正在登录中，请在新窗口中完成华为账号一键登录':'登录华为账号后可将仓库数据安全备份到云端，数据独立存储，重装后可恢复。',
    render:function(e){
      e.setHeading();
      if(!isPend){
        e.addButton(function(b){
          return b.setButtonText('登录华为账号').setCta().onClick(function(){
            electron.ipcRenderer.sendSync('hcs-login');
            new __NOTICE__('正在打开登录窗口...');
            __REFRESH__(self);
          });
        });
      }
    }
  });
  return d;
}
var s=electron.ipcRenderer.sendSync('hcs-get-status');
var a=electron.ipcRenderer.sendSync('hcs-get-auto-sync');
var x=electron.ipcRenderer.sendSync('hcs-get-excluded');
var f=s.lastSync?new Date(s.lastSync).toLocaleString():'从未';
var sz=s.totalSize?(s.totalSize<1048576?(s.totalSize/1024).toFixed(1)+' KB':(s.totalSize/1048576).toFixed(1)+' MB'):'0 KB';
var c=s.files?s.files.length:0;
var cf=s.cloudFiles||0;
self.excluded=x||[];
d.push({
  name:"华为账号",
  desc:uid,
  render:function(e){
    e.addExtraButton(function(b){
      return b.setIcon('lucide-log-out').setTooltip('退出登录').onClick(function(){
        electron.ipcRenderer.sendSync('hcs-set-userid',null);
        __REFRESH__(self);
      });
    });
  }
});
d.push({
  name:"同步状态",
  desc:s.status||'就绪',
  render:function(e){
    e.addExtraButton(function(b){
      return b.setIcon('lucide-refresh-cw').setTooltip('刷新').onClick(function(){
        __REFRESH__(self);
      });
    });
  }
});
d.push({name:"上次同步",desc:f});
d.push({name:"本地文件",desc:c+' 个，'+sz});
if(cf>0){
  d.push({
    name:"云端文件",
    desc:cf+' 个文件已上传',
    render:function(e){
      e.addButton(function(b){
        return b.setButtonText('恢复').onClick(function(){
          var list=electron.ipcRenderer.sendSync('hcs-restore-list');
          var done=0;
          list.forEach(function(p){
            var r={path:p,vaultPath:self.app.vault.adapter.basePath};
            if(electron.ipcRenderer.sendSync('hcs-restore-file',r)){done++;}
          });
          new __NOTICE__('已从云端恢复 '+done+' 个文件');
          __REFRESH__(self);
        });
      });
    }
  });
}
d.push({
  name:"自动同步",
  desc:"文件变更时自动上传",
  render:function(e){
    e.addToggle(function(b){
      return b.setValue(a).onChange(function(v){
        electron.ipcRenderer.sendSync('hcs-set-auto-sync',v);
        __REFRESH__(self);
      });
    });
  }
});
d.push({
  name:"立即同步",
  desc:"扫描全部仓库文件并保存到同步记录",
  render:function(e){
    e.addButton(function(b){
      return b.setButtonText('开始同步').setCta().onClick(function(){
        var r=electron.ipcRenderer.sendSync('hcs-sync-all',self.app.vault.adapter.basePath);
        var t2=r.totalSize<1048576?(r.totalSize/1024).toFixed(1)+' KB':(r.totalSize/1048576).toFixed(1)+' MB';
        new __NOTICE__('同步完成：'+r.files.length+' 个文件，'+t2);
        __REFRESH__(self);
      });
    });
  }
});
var ex=self.excluded;
d.push({
  name:"排除文件夹",
  desc:(ex.length?ex.join('、'):'无')+'。输入路径后回车添加。',
  render:function(e){
    e.addText(function(b){
      b.setPlaceholder('文件夹路径，回车确认');
      b.inputEl.addEventListener('keydown',function(ev){
        if(ev.key==='Enter'&&b.inputEl.value.trim()){
          ex.push(b.inputEl.value.trim());
          electron.ipcRenderer.sendSync('hcs-set-excluded',ex);
          __REFRESH__(self);
        }
      });
    });
  }
});
return d;
},
__DISPLAY_FALLBACK__
t}(__SETTINGS_TAB_BASE__)
