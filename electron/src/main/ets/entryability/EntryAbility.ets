/*
 * Copyright (c) 2023-2025 Haitai FangYuan Co., Ltd.
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this list of
 *    conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice, this list
 *    of conditions and the following disclaimer in the documentation and/or other materials
 *    provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors may be used
 *    to endorse or promote products derived from this software without specific prior written
 *    permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
 * THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
 * PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
 * CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
 * EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
 * PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS;
 * OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 * WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR
 * OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF
 * ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

import window from '@ohos.window';
import Want from '@ohos.app.ability.Want';
import AbilityConstant from '@ohos.app.ability.AbilityConstant';
import { Configuration } from '@ohos.app.ability.Configuration';
import { initialize } from '@hw-agconnect/hmcore';
import { util } from '@kit.ArkTS';

import { WebAbility } from 'web_engine';
import { DeeplinkBridge } from '../utils/DeeplinkBridge';

export default class EntryAbility extends WebAbility {
  onConfigurationUpdate(config: Configuration) {
    super.onConfigurationUpdate(config);
  }

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam) {
    // 必须在 super 之前取：super 会把 want.uri 当作起始页面地址读走。
    this.captureDeeplink(want);
    super.onCreate(want, launchParam);
    // 初始化华为 AGC 云服务
    this.initAgc();
  }

  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam) {
    super.onNewWant(want, launchParam);
    this.captureDeeplink(want);
  }

  private captureDeeplink(want: Want): void {
    let url = DeeplinkBridge.extractAndStrip(want);
    if (url === undefined) {
      return;
    }
    // 必须用 applicationContext 的目录：UIAbilityContext.filesDir 带模块前缀
    // （haps/electron/files），而 Electron 的 userData 是应用级目录（files），
    // 两者在磁盘上是两个不同的位置。
    DeeplinkBridge.enqueue(this.context.getApplicationContext().filesDir, url);
  }

  private async initAgc(): Promise<void> {
    try {
      const input = await this.context.resourceManager.getRawFileContent('agconnect-services.json');
      const jsonString = new util.TextDecoder().decodeWithStream(input, undefined);
      initialize(this.context, JSON.parse(jsonString));
      console.info('AGC initialized successfully');
    } catch (err) {
      console.error('AGC init failed: ' + JSON.stringify(err));
    }
  }

  onDestroy() {
    super.onDestroy();
  }

  onWindowStageCreate(windowStage: window.WindowStage) {
    super.onWindowStageCreate(windowStage);
  }

  onWindowStageDestroy() {
    super.onWindowStageDestroy();
  }

  onForeground() {
    super.onForeground();
  }

  onBackground() {
    super.onBackground();
  }
};
