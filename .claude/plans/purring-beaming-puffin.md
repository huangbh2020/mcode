# Issue #22:@ 文件引用支持正文原位置内联显示

## Context

用户在 composer 通过 @ 引用文件(FileMentionPicker)后,`handleMentionPick`(`ChatPane.tsx:2545`)调 `clearTriggerToken()` 把 `@query` token 从编辑器正文**整段删除**——文件位置信息在 pick 那一刻就丢失了。发送后:气泡正文(`displayText`)是无 @ 标记的纯文本,文件引用变成 attachment 块,并因 MessageRow 的"媒体组/正文组二分"(`ChatPane.tsx:4849-4862`)永远堆叠在气泡顶部(`AttachmentStackDeck`)。多文件引用时无法分辨正文哪句话对应哪个文件(Issue #22 的诉求)。

**方案**:新设置 `ui.inlineFileMention`(默认关)。开启后:① pick 时在正文原位置保留 `@文件名` 轻量标记;② 渲染时该消息的 file 类引用卡不再堆叠顶部,正文中的 `@文件名` 渲染为内联 pill(视觉标记 + title 悬停完整路径)。**prompt 组装、attachment 块数据流、编辑重建、队列全部零改动**——模型读文件仍靠 prompt 尾部完整 `@path`,编辑/持久化 round-trip 自然成立(displayText 天然含标记)。

## 改动点

### 1. 设置基础设施(参照 `ui.tabBarMultiRow` 链路)

- **`packages/contracts/src/ipc.ts`**:在 `TAB_BAR_MULTI_ROW_SETTING_KEY`(:248)旁加 `export const INLINE_FILE_MENTION_SETTING_KEY = "ui.inlineFileMention";`
- **`apps/desktop/src/renderer/stores/sessionStore.ts`**:
  - 字段 `inlineFileMention: boolean`(默认 false,初始值区 :5177 附近)
  - first-paint `api.setting.getMany` keys 数组(:5433-5459)加入该 key,apply 区(:5556-5563 附近)镜像 tabBarMultiRow:`value === "true"` 时 set
  - action `setInlineFileMention(on)`:set + `api.setting.set` fire-and-forget(镜像 :10063 `setTabBarMultiRow`)
- **`apps/desktop/src/renderer/components/settings/GeneralPanel.tsx`**:「基础」SettingsSection(:121-261)末尾加 Switch 行(样式照 :265-275 自动归档行,`Switch` from `@renderer/components/ui/index.js`)
- **i18n**:`apps/desktop/src/renderer/lib/i18n/zh/settings.ts` + `en/settings.ts` 加 `settings.general.inlineFileMention` / `...Desc`(zh:「@ 引用文件内联显示」/「在正文原位置显示 @文件名 标记,而非在消息顶部堆叠引用卡」;en 镜像)

### 2. pick 期保留标记(ChatPane.tsx)

- 新 helper `replaceTriggerToken(replacement: string)`(紧挨 `clearTriggerToken` :2478):同款簿记(deleteTextRange(start, caret) → `editorRef.current.insertText(replacement)` → setValue 字符串拼接替换 → setPickerKind(null) → triggerStartRef 置 null → rAF setCaretOffset(start + replacement.length))
- `handleMentionPick`(:2545):`inlineFileMention` 开启时改调 `replaceTriggerToken(files.map(f => `@${f.name} `).join(""))`(f.name 为 basename,与 attachment 的 filePath basename 一致);关闭时维持 `clearTriggerToken()`。`addFileTags(files)` 照旧(chip 仍显示,可删/可看全路径)
- MessageRow 内经 `useSessionStore.getState().inlineFileMention`?不——订阅 selector(`s.inlineFileMention`)保持响应式;handleMentionPick 的 useCallback deps 加入该值

### 3. 渲染层:顶部卡剔除 + 正文 pill

- **`ChatPane.tsx` MessageRow**(:4849 二分处):
  - 计算 `inlinedFileAttachments`(useMemo):设置开启时,收集 `attachmentKind === "file"` 且**正文 text 块中字面出现 `@<basename(filePath)>`** 的 attachment(basename 从完整 filePath 派生,避开 preview 的 24 字符截断:`contentTag.ts` 的 `TAG_PREVIEW_CHARS = 24`)
  - `userMediaBlocks` 过滤掉这些已内联的块(paste/quote/image 与未命中正文的 file 卡不动——旧消息、用户手删标记时回退顶部卡,引用不丢)
  - 把 `inlineFiles`(`{name, filePath}[]`,引用稳定)传给 prose 容器的 `<MessageBlocks>`
- **`MessageBlocks.tsx`**:`MessageBlocks` 与 `BlockView` 加可选 prop `inlineFiles?: ReadonlyArray<{ name: string; filePath: string }>`,text 分支转发给 `<Markdown>`
- **`Markdown.tsx`**:加同名可选 prop,照 `rehypeSkillInline`(:266)先例新增 `rehypeFileInline(escaped)` 插件——把文本节点中 `@<name>`(regex `@(name1|name2)(?![A-Za-z0-9_-])`,longest-first 转义)替换为 `<span class="file-pill-inline" title={filePath}>` 元素节点(跳过 code/pre,复用 `walkAndTransform` 骨架);仅当 `inlineFiles` 非空时挂载该插件
- **`styles.css`**:在 `.skill-pill-inline`(:1911)旁加 `.file-pill-inline`(inline-flex、accent 蓝/文件色、0.85em、nowrap;视觉对齐 AttachmentCard 的 file 色系)

### 4. AGENTS.md

在「用户消息气泡 5 行折叠」小节后追加一条简短记录(项目惯例):设置项、pick 期保留标记的根因说明、渲染判定规则(basename 命中正文才隐藏顶部卡)、数据流零改动。

## 不改的东西(边界)

- `composePromptWithTags` / `composeSendAttachments` / store `sendPrompt`/`editAndResendMessage` 块构建:零改动(prompt 尾部完整 `@path` 仍是对模型的可靠引用通道;正文里的 `@aaa.py` 对 CLI 只是普通文本)
- UserMessageEditor / 队列编辑:零改动(text 预填含标记,重新提交自然 round-trip)
- 移动端:复用 ChatPane 的 MessageRow,自动生效
- pill 不做点击交互(Issue 的"或支持…"为备选建议;title tooltip 提供完整路径)——留作后续增强
- 关闭设置(默认)时所有行为与现状一致,零回归

## 验证

1. `cd apps/desktop && npx tsc --noEmit -p tsconfig.json`
2. `pnpm build`(根目录;`NODE_OPTIONS=--max-old-space-size=8192` 已知基线要求)
3. 人工(dev 实例):
   - 默认关:@ 引用两文件 → 现状堆叠卡,正文无标记
   - 开启后:@ 引用 `aaa.py`/`bbb.py` 分嵌两句话 → 正文原位置各显 `@aaa.py`/`@bbb.py` pill(hover 见完整路径),顶部无堆叠卡
   - 旧消息(设置开启前发的)仍显示顶部卡
   - 编辑该消息重发 → 标记与 pill 保持
   - 手动删掉正文标记的 file 引用 → 该卡回到顶部
