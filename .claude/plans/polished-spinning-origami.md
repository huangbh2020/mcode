# 语音输入功能(中文识别:Parakeet TDT v3 / Zipformer streaming zh)

## Context

用户希望在 Mcode 聊天输入框的工具栏(composer action row)添加语音输入:一个麦克风图标,
支持**两种可切换模式**——(1) 点击开始/再点结束的**连续语音输入**;(2) **按住说话**(松手即结束)。
语音转成文字,中英文都要,**重点是中文识别能力强**。

用户明确点名要现代开源免费的中文 ASR 模型:**NVIDIA Parakeet TDT v3** 与
**Zipformer streaming zh**(sherpa-onnx / k2-fsa),而非系统级的弱识别。两者都免费、可本地离线运行。

引擎方案经与用户确认:**用 sherpa-onnx 的 Node.js 绑定在 Electron 主进程跑识别**——
它同时支持用户点名的两类模型:
- **流式 Zipformer 中文**(如 `sherpa-onnx-streaming-zipformer-zh-14M`,基于 WenetSpeech),支持
  **实时中间结果**(说话过程中不断出文字),正好驱动连续/按住两种模式的实时转写。
- **离线高精度模型**(sherpa-onnx 也已加入 NVIDIA Parakeet 离线支持),用于最终高精度转写。

音频在渲染进程用 `getUserMedia` 采集 16kHz 单声道 PCM,经 IPC 流式喂给主进程 sherpa-onnx 解码,
转写文字再推送回渲染进程填入编辑器。

> 说明:网络受限环境下无法在线核对 sherpa-onnx 对 Parakeet 的具体版本支持,实现时会优先确保
> **流式 Zipformer 中文**这条路径(这是两种模式实时 UX 的关键,也是用户点名的模型之一);Parakeet
> 作为离线高精度通道,若当前 sherpa-onnx 版本支持则以 sherpa 离线模型方式接入,否则退回已确认可用的
> 流式 zipformer 作为唯一引擎,保证功能可用。

## 架构总览

```
渲染进程 ChatPane 麦克风按钮
  │  getUserMedia 采集 16kHz mono Float32 PCM
  ▼
IPC(VoiceStream 通道) ──► 主进程 voice/speech 模块
                             │  sherpa-onnx-node(sherpa-onnx 解码)
                             ▼
                          识别结果(partial/final 文本)
  ▲                             │
  └── IPC 推送(VoiceResult 事件) ──┤
                                  ▼
                          渲染进程填入编辑器(editorRef.insertText)
```

## 实现步骤

### 1. 主进程 ASR 引擎模块(新文件)
新建 `apps/desktop/src/main/voice/speechRecognizer.ts`:
- 封装 sherpa-onnx-node 在线识别器(`OfflineRecognizer` 与 `OnlineRecognizer` 二选一/并存)。
- 模型文件:首次使用从 sherpa-onnx 模型库(HuggingFace/k2-fsa release)下载到
  `userData/models/voice/`(主进程 `app.getPath("userData")`),下载走已有网络工具,断点续传、缓存。
- 提供方法:`createSession(sessionId, lang)` → 开始;`feedPcm(sessionId, Float32Array)`;
  `stop(sessionId)` → 返回最终结果;`destroy(sessionId)`。
- 通过回调把 **partial**(实时中间)与 **final**(最终)文本emit 出来。

### 2. IPC 契约(`packages/contracts/src/ipc.ts`)
新增通道(沿用文件内 `IPC` 常量 + Zod schema 模式):
- 渲染→主:`voice.start`(`{ sessionId?, lang }`)、`voice.feed`(`{ sessionId, pcm: number[] }`)、
  `voice.stop`、`voice.cancel`。
- 主→渲染推送:`VoiceResultChannel`(`{ sessionId, kind: "partial"|"final", text }`)——
  复用现有 `sendToRenderer`/preload 的事件订阅模式。

### 3. Electron 首页准备(麦克风权限 + 主进程就绪)
- `apps/desktop/src/main/ipc/voice.ts`(新)注册上述 handler;
  在 `apps/desktop/src/main/ipc/index.ts` 的 `registerIpcHandlers()` 里登记。
- `apps/desktop/src/main/window.ts`:`session.defaultSession.setPermissionCheckHandler` /
  `setPermissionRequestHandler`,对 `media`(microphone)权限放行(该 app 唯一会用麦克风的地方)。
- ASR 引擎按需懒加载(首次点麦克风才初始化),避免拖慢启动。

### 4. 依赖与原生模块
- `apps/desktop/package.json` 新增 `sherpa-onnx`(或 `sherpa-onnx-node`)。
- 复用现有原生重编译管线(`build/rebuild-native.cjs` + `package` 脚本中的 `install-app-deps`,
  node-pty 已有先例),确保 ASR 原生 addon 对 Electron ABI 重编译、排除出 renderer bundle。
- 若 sherpa-onnx 原生 addon 打包复杂,作为后备也可考虑 `@huggingface/transformers`(WebGPU 渲染进程
  跑 Parakeet),但会失去流式中间结果,故主推主进程 sherpa-onnx。

### 5. 渲染进程:麦克风采集 hook(新文件)
新建 `apps/desktop/src/renderer/hooks/useVoiceInput.ts`:
- 封装 `getUserMedia({ audio: { channelCount:1, sampleRate:16000, echoCancellation:true,
  autoGainControl:true, noiseSuppression:true } })` + `AudioContext` + `AudioWorklet`(或
  `ScriptProcessorNode`)采集 16kHz mono Float32。
- 封装 Web Speech API 无关的、主进程驱动的录音/停止/取消,返回 `{ start, stop, cancel, busy }` 与
  实时 `interimText`/`finalText` 状态。
- 对两种模式提供统一 API:调用方决定"连续"(start 后直到 stop)还是"按住"(按下 start、松开 stop)。

### 6. 麦克风按钮组件(新文件)
新建 `apps/desktop/src/renderer/components/chat/MicButton.tsx`:
- 位置:composer action row 左侧芯片区,`<AttachMenuButton>` 旁边(`ChatPane.tsx` ~2720)。
- 图标:`IconMicrophone` / `IconMicrophoneFilled`(识别中高亮),`IconCircle` 按压状态;加入
  `lib/icons.tsx` 的 Tabler 再导出块。
- **模式切换**:小菜单(复用 `@base-ui/react Menu` 风格,参照 `AttachMenuButton`)在
  「连续语音 / 按住说话」间切换,并显示当前模式;默认模式存为持久设置。
- 交互:
  - 连续模式:点一次开始(图标变红/脉冲),再点或说完了自动停止,最终文本插入编辑器。
  - 按住模式:按下(mousedown/touchstart)开始,松开(mouseup/touchend/移出)停止。
- 进行中禁用其它输入锁定(`inputBlocked` 时禁按);识别到 `final` 文本用
  `editorRef.current?.insertText(text)` 插入(补空格),并 `setValue(...)` 同步镜像。
- 通过 props 使用 ChatPane 提供的 `editorRef`、`inputBlocked`、`t`。

### 7. 接入 ChatPane
`apps/desktop/src/renderer/components/chat/ChatPane.tsx`(~2720 composer-action-row):
- 在芯片区插入 `<MicButton ... />`,传入 `editorRef`、`disabled={inputBlocked}`。
- 接入 `useVoiceInput` 的转写文本 → 填入编辑器。

### 8. 设置(持久化默认模式/语言)
参照现有 `pasteTagThresholdChars`/`locale` 模式:
- `packages/contracts/src/ipc.ts` 新增 setting key:
  `UI_VOICE_INPUT_MODE_SETTING_KEY = "ui.voiceInputMode"`、`UI_VOICE_LANG_SETTING_KEY = "ui.voiceLang"`。
- `sessionStore.ts`:初始化默认值(`"continuous"` / `"zh-CN"`),`init()` 读取,新增 setter
  (`setVoiceInputMode` / `setVoiceLang`,沿用 `api.setting.set` + try/catch 风格)。
- `components/settings/GeneralPanel.tsx`(或新建 `VoicePanel`)新增
  `SettingsSection` + `SettingRow` + `Select`:选默认模式(连续/按住)、识别语言(zh-CN/en-US)。
- 麦克风按钮的默认模式/语言从此设置读取。

### 9. i18n
- `lib/i18n/zh/chat-composer.ts` + `en/chat-composer.ts`:新增 `chat.voice.*`
  (开始语音 / 停止 / 按住说话 / 连续语音 / 识别中… / 转写失败 / 需授权麦克风)。
- `lib/i18n/zh/settings.ts` + `en/settings.ts`:新增 `settings.general.voice*` 键。
- 注意 `MessageId = keyof typeof zh`,en 需与 zh 键一一对应(缺失会 typecheck 失败)。

## 关键文件清单
- 新增:`main/voice/speechRecognizer.ts`、`main/ipc/voice.ts`、`renderer/hooks/useVoiceInput.ts`、
  `renderer/components/chat/MicButton.tsx`
- 修改:`packages/contracts/src/ipc.ts`(IPC + Zod + setting keys)、`main/ipc/index.ts`、
  `main/window.ts`(权限)、`main/ipc/claude.ts`(如需)、`renderer/stores/sessionStore.ts`、
  `renderer/components/chat/ChatPane.tsx`、`renderer/components/settings/GeneralPanel.tsx`、
  `renderer/lib/icons.tsx`、两个 locale 的 `chat-composer.ts` / `settings.ts`、
  `apps/desktop/package.json`(sherpa-onnx)

## 复用已有实现
- 设置持久化:`sessionStore` 的 setter 模式 + `api.setting.set`(参考 `setPasteTagThresholdChars`,
  sessionStore.ts:6510)。
- 设置面板:通用 `SettingsSection` / `SettingRow` / `Select`(参考 GeneralPanel.tsx)。
- 菜单/弹层:`@base-ui/react Menu`(参考 AttachMenuButton.tsx)。
- 编辑器插入:`ComposerEditorHandle.insertText`(ComposerEditor.tsx:498)。
- i18n:`useI18n` → `t(key)`,`MessageId = keyof typeof zh`(core.ts:43)。

## 验证
1. `pnpm --filter @mcode/desktop rebuild:native`(确保 sherpa-onnx 原生 addon 对 Electron ABI 编译)。
2. `pnpm --filter @mcode/desktop typecheck`(i18n en/zh 键对齐 + TS 通过)。
3. `pnpm --filter @mcode/desktop dev` 启动:
   - 首次点麦克风 → 弹出系统麦克风授权有一致提示,允许后自动下载模型(进度提示)。
   - 连续模式:点开始说话,实时出中间文字;再点结束,最终文本插入编辑器。
   - 按住模式:按住说话实时转写,松手结束并插入。
   - 说中文验证识别质量;设置里切换连续/按住默认模式与语言。
   - 转写进行中重启应用 → 模型已缓存不再重复下载。
```
