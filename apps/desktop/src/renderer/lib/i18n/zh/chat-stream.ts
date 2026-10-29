/**
 * chat-stream area messages. Keys follow the area's prefix convention.
 * zh is the source of truth for `MessageId`.
 */
export const zh = {
  // ── MessageTimeline ──
  "chatStream.timeline.current": "当前",
  "chatStream.timeline.noText": "(无文本内容)",
  "chatStream.timeline.attachmentLine": "[附件] {text}",

  // ── MessageRow: user prompt overflow (5-line collapse) ──
  "chatStream.userMsg.expand": "展开",
  "chatStream.userMsg.collapse": "收起",

  // ── MessageBlocks: batch tool group ──
  "chatStream.opCount": "{n} 个操作",
  "chatStream.opFailed": "(操作失败)",

  // ── Chat stream · 方案A「脉络」: turn summary / reply mark ──
  "chatStream.stepCount": "{n} 步",
  "chatStream.filesChanged": "改 {n} 个文件",
  "chatStream.waitingModel": "等待模型…",

  // ── 运行台账（无框形态）台头 ──
  "chatStream.ledgerRunning": "运行中",
  "chatStream.tokensUsed": "{n} tokens",
  "chatStream.filesChangedShort": "{n} 文件",

  // ── 流式生成速率（运行中台头的实时读数，估算值）──
  "chatStream.streamRate": "{n} tok/s",
  "chatStream.streamRateHint": "按流式输出估算的生成速度（近似值，含思考）",

  // ── RenderErrorBoundary: per-segment render-failure fallback ──
  "chatStream.renderError": "此内容渲染出错，已跳过（其余内容不受影响）",

  // ── MessageBlocks: thinking / tool cards ──
  "chatStream.thinking": "思考",
  // ── 工具显示名本地化（chatStream.toolName.<原始工具名>）──
  // 仅 UI 展示用，逻辑判定（折叠分组/图标映射/守卫工具集）仍用原始名。
  // Claude 大写开头；Pi 全小写（read/grep/…）各留一份。MCP 工具
  // （mcp__server__tool）与未知工具不入表，按原始名显示。
  "chatStream.toolName.Read": "读取",
  "chatStream.toolName.read": "读取",
  "chatStream.toolName.Glob": "文件匹配",
  "chatStream.toolName.find": "文件匹配",
  "chatStream.toolName.Write": "写入",
  "chatStream.toolName.write": "写入",
  "chatStream.toolName.Edit": "编辑",
  "chatStream.toolName.edit": "编辑",
  "chatStream.toolName.MultiEdit": "多处编辑",
  "chatStream.toolName.multiedit": "多处编辑",
  "chatStream.toolName.NotebookEdit": "编辑笔记本",
  "chatStream.toolName.notebookedit": "编辑笔记本",
  "chatStream.toolName.Bash": "执行命令",
  "chatStream.toolName.bash": "执行命令",
  "chatStream.toolName.PowerShell": "执行命令",
  "chatStream.toolName.Grep": "内容搜索",
  "chatStream.toolName.grep": "内容搜索",
  "chatStream.toolName.ls": "浏览目录",
  "chatStream.toolName.TodoWrite": "更新待办",
  "chatStream.toolName.TodoRead": "读取待办",
  "chatStream.toolName.TaskCreate": "创建任务",
  "chatStream.toolName.TaskUpdate": "更新任务",
  "chatStream.toolName.TaskGet": "查询任务",
  "chatStream.toolName.Task": "子代理",
  "chatStream.toolName.task": "子代理",
  "chatStream.toolName.WebSearch": "网页搜索",
  "chatStream.toolName.WebFetch": "网页抓取",
  "chatStream.toolName.AskUserQuestion": "向用户提问",
  "chatStream.toolName.EnterPlanMode": "进入计划模式",
  "chatStream.toolName.ExitPlanMode": "退出计划模式",
  "chatStream.toolName.SlashCommand": "斜杠命令",
  "chatStream.toolName.Skill": "技能",
  "chatStream.toolName.BashOutput": "命令输出",
  "chatStream.toolName.KillShell": "终止后台命令",
  "chatStream.toolName.TaskOutput": "后台任务输出",
  "chatStream.tool.input": "输入",
  "chatStream.tool.result": "结果",
  "chatStream.lineCount": "{n} 行",
  "chatStream.emptyPlaceholder": "(空)",
  "chatStream.truncatedSuffix": "(已截断)",

  // ── MessageBlocks: compact summary ──
  "chatStream.compact.manual": "已手动压缩对话历史",
  "chatStream.compact.auto": "已自动压缩对话历史",
  "chatStream.compact.freed": "· 释放 {n} tokens",

  // ── MessageBlocks: images ──
  "chatStream.image.browserScreenshot": "浏览器截图",
  "chatStream.image.userImage": "用户图片",
  "chatStream.imageRenderedAbove": "[图片已在上方显示]",

  // ── MessageBlocks: inline video (script-generated media) ──
  "chatStream.media.tabVideos": "视频",
  "chatStream.media.tabImages": "图片",
  "chatStream.media.previewAll": "预览全部",
  "chatStream.media.screenshotsTotal": "浏览器截图 · 共 {n} 张",
  "chatStream.media.videosTotal": "视频附件 · 共 {n} 个",
  "chatStream.media.userImagesTotal": "用户图片 · 共 {n} 张",
  "chatStream.media.expandList": "展开列表",
  "chatStream.media.collapseList": "收起列表",
  "chatStream.video.unplayable": "无法播放",
  "chatStream.video.openInEditor": "在编辑器中打开",

  // ── MessageBlocks: image gallery ──
  "chatStream.gallery.screenshotAlt": "截图 {n}/{total}",
  "chatStream.gallery.prev": "上一张",
  "chatStream.gallery.next": "下一张",
  "chatStream.gallery.imageN": "第 {n} 张",

  // ── MessageBlocks: attachment chip ──
  "chatStream.attachment.viewImage": "查看图片",
  "chatStream.attachment.viewContent": "查看内容",
  "chatStream.attachment.collapseImage": "收起图片",
  "chatStream.attachment.collapseContent": "收起内容",
  "chatStream.attachment.externalTitle": "无法查看外部文件",
  "chatStream.attachment.externalBody": "该文件不在任何项目或工作树内,应用无法读取其内容。",
  "chatStream.attachment.stackSummary": "包含 {n} 项附件内容",
  "chatStream.attachment.collapse": "收起",
  "chatStream.attachment.expandTooltip": "点击展开全部 {n} 项附件",
  "chatStream.attachment.openInIde": "在编辑器中打开",
  "chatStream.attachment.typeCode": "文件",
  "chatStream.attachment.typePaste": "剪贴板片段",
  "chatStream.attachment.typeImage": "图片",

  // ── Markdown ──
  "chatStream.copyCode": "复制代码",
  "chatStream.code.expand": "展开",
  "chatStream.code.collapse": "收起",

  // ── FileLink ──
  "chatStream.fileLink.clickToOpen": "点击打开文件",
  "chatStream.fileLink.noMatch": "未找到匹配文件",
  "chatStream.fileLink.matchCount": "{n} 个匹配 · 选择打开",

  // ── DiffView / Write card diff labels ──
  "chatStream.diff.noChanges": "(无变化)",
  "chatStream.diff.newFile": "新文件",
  "chatStream.diff.vsPreTurn": "与本轮开始前的差异",
  "chatStream.diff.newFileContent": "新文件内容",

  // ── TurnFilesCard ──
  "chatStream.turnFiles.titleLong": "本轮修改了 {n} 个文件",
  "chatStream.turnFiles.titleShort": "修改 {n} 个文件",
  "chatStream.turnFiles.created": "创建 {n}",
  "chatStream.turnFiles.modified": "修改 {n}",
  "chatStream.turnFiles.rewindShort": "撤销",
  "chatStream.turnFiles.rewinding": "撤销中…",
  "chatStream.turnFiles.rewoundCheck": "已撤销 ✓",
  "chatStream.turnFiles.rewoundBadge": "已撤销",
  "chatStream.turnFiles.rewindLatestTitle": "把本轮所有文件恢复为轮开始前的状态",
  "chatStream.turnFiles.rewindHistoryTitle":
    "把该历史轮次的文件改动恢复为当时修改前的状态(可能影响后续轮次)",
  "chatStream.turnFiles.confirmTitle": "撤销本轮修改",
  "chatStream.turnFiles.confirmDescLatest": "将把本轮修改的文件恢复为轮开始前的状态。",
  "chatStream.turnFiles.confirmDescHistory1": "撤销历史轮次会把该轮修改的文件恢复到当时修改前的状态，",
  "chatStream.turnFiles.confirmDescHistory2": "可能影响后续轮次对同一文件的修改。确定继续吗？",
  "chatStream.turnFiles.reviewDiff": "在编辑器中审查改动",
  "chatStream.turnFiles.locateTitle": "在文件树中定位此文件",
  "chatStream.turnFiles.createdThisTurn": "本轮新建",
  "chatStream.turnFiles.modifiedThisTurn": "本轮修改",
  "chatStream.turnFiles.noChanges": "无变化",

  // ── Activity rail + console (聊天区右缘) ──
  "chatStream.activity.close": "关闭",
  "chatStream.activity.now": "现在",
  "chatStream.activity.emptyGroup": "这项筛选下没有内容",
  "chatStream.activity.tabAll": "全部",
  // 收放聚簇（方案 B）——圆钮 + 按紧急度伸出的文字横条
  "chatStream.activity.cluster.aria": "活动",
  "chatStream.activity.cluster.running": "{n} 个子代理运行中",
  "chatStream.activity.cluster.commands": "{n} 个命令运行中",
  "chatStream.activity.cluster.services": "{n} 个服务运行中",
  "chatStream.activity.cluster.failed": "{n} 个子代理失败",
  "chatStream.activity.cluster.waiting": "等待你的回答",
  "chatStream.activity.cluster.tasks": "任务 {done}/{total}",
  "chatStream.activity.cluster.plans": "{n} 计划",
  "chatStream.activity.cluster.noPlans": "无计划",
  "chatStream.activity.cluster.openPlans": "打开计划",
  // 苹果风格控制中心 (Control Deck) 与微岛 (Dynamic Island)
  "chatStream.activity.deck.title": "会话控制中心",
  "chatStream.activity.deck.escHint": "ESC 退出",
  "chatStream.activity.deck.liveServices": "实时服务",
  "chatStream.activity.deck.commandsAndAgents": "后台进程与子代理",
  "chatStream.activity.deck.todos": "任务进度",
  "chatStream.activity.deck.assets": "会话资产",
  "chatStream.activity.deck.allSettled": "全部已就绪",
  "chatStream.activity.deck.shortServices": "{n} 服务",
  "chatStream.activity.deck.shortCommands": "{n} 命令",
  "chatStream.activity.deck.shortAgents": "{n} 代理",
  "chatStream.activity.deck.shortPlans": "{n} 计划",
  "chatStream.activity.deck.shortBookmarks": "{n} 书签",
  "chatStream.activity.deck.shortSideChats": "{n} 子会话",
  "chatStream.activity.deck.activeCount": "{n} 活跃",
  "chatStream.activity.deck.plansHistory": "计划历史",
  "chatStream.activity.deck.bookmarksWidget": "高亮书签",
  "chatStream.activity.deck.viewFull": "查看完整明细",
  "chatStream.activity.deck.sched": "定时任务",
  "chatStream.activity.deck.schedSubtitle": "{total} 个排期 · {running} 个执行中",
  "chatStream.activity.deck.schedSubtitleIdle": "{n} 个排期任务",
  "chatStream.activity.deck.schedInFlight": "{n} 执行中",
  "chatStream.activity.deck.schedNext": "下次: {time}",
  "chatStream.activity.deck.schedEmpty": "暂无定时任务",
  "chatStream.activity.deck.openSched": "管理任务",
  "chatStream.activity.deck.newSched": "+ 新建",
  "chatStream.activity.cluster.schedRunning": "定时任务执行中",
  // 节点名（活动台台头 / 节点页签）
  "chatStream.activity.node.overview": "概览",
  "chatStream.activity.node.tasks": "任务",
  "chatStream.activity.node.subagents": "子代理",
  "chatStream.activity.node.commands": "运行命令",
  "chatStream.activity.node.services": "服务",
  "chatStream.activity.node.plans": "计划",
  "chatStream.activity.node.bookmarks": "书签",
  "chatStream.activity.node.sched": "定时",
  "chatStream.activity.node.sidechats": "子会话",
  // 分组标题与筛选 chip
  "chatStream.activity.groupRunning": "运行中",
  "chatStream.activity.groupSettled": "已结束",
  "chatStream.activity.groupCompleted": "已完成",
  "chatStream.activity.groupFailed": "失败",
  "chatStream.activity.groupInProgress": "进行中",
  "chatStream.activity.groupPending": "待办",
  "chatStream.activity.groupToday": "今天",
  "chatStream.activity.groupEarlier": "更早",
  "chatStream.activity.groupStale": "已失效",
  // 子代理面板
  "chatStream.activity.subagentsSubRunning": "{running} 个运行中 · {ended} 个已结束",
  "chatStream.activity.subagentsSubIdle": "{n} 个 · 全部已结束",
  "chatStream.activity.unitAgents": "个",
  "chatStream.activity.labelRunning": "运行中",
  "chatStream.activity.labelCumulative": "累计",
  "chatStream.activity.subagentsFooter": "条形为该代理的真实起止，运行中的延伸到「现在」",
  "chatStream.activity.noDescription": "(无描述)",
  "chatStream.activity.viewSubagent": "查看子代理详情",
  // 子会话面板
  "chatStream.activity.sidechatsSubRunning": "{running} 个进行中 · 共 {n} 个",
  "chatStream.activity.sidechatsSubIdle": "共 {n} 个",
  "chatStream.activity.sidechatsUnit": "个",
  "chatStream.activity.sidechatsFooter": "点击在右侧「问答」面板打开对应子会话",
  "chatStream.activity.openSideChat": "打开子会话",
  // 任务面板
  "chatStream.activity.tasksSubtitle": "{done}/{total} 已完成 · 剩余 {rest} 项",
  "chatStream.activity.tasksDoneSuffix": "已完成",
  "chatStream.activity.tasksRest": "剩余 {n} 项",
  "chatStream.activity.tasksFooter": "任务全部完成时该节点自动收起",
  "chatStream.activity.priorityHigh": "高",
  "chatStream.activity.priorityMedium": "中",
  "chatStream.activity.priorityLow": "低",
  // 计划面板
  "chatStream.activity.plansSubtitle": "共 {n} 份，最新排在最上",
  "chatStream.activity.unitPlans": "份",
  "chatStream.activity.latestChip": "最新",
  "chatStream.activity.openPlan": "打开",
  "chatStream.activity.plansFooter": "点击任一份在计划面板中打开",
  "chatStream.activity.planFallback": "(计划 {n})",
  "chatStream.activity.viewPlan": "点击查看完整计划内容",
  // 书签面板
  "chatStream.activity.bookmarksSub": "{n} 个书签",
  "chatStream.activity.bookmarksSubStale": "{n} 个 · {stale} 个已失效",
  "chatStream.activity.unitBookmarks": "个",
  "chatStream.activity.bookmarksFooter": "选中正文可添加；失效的书签只灰掉，不删除",
  "chatStream.subagent.statusRunning": "运行中",
  "chatStream.subagent.statusCompleted": "已完成",
  "chatStream.subagent.statusFailed": "失败",
  "chatStream.subagent.statusKilled": "已终止",

  // ── Agent-started bash commands（活动区「运行命令」节点）──
  "chatStream.bashTask.statusRunning": "运行中",
  "chatStream.bashTask.statusCompleted": "已完成",
  "chatStream.bashTask.statusFailed": "失败",
  "chatStream.bashTask.statusKilled": "已停止",
  "chatStream.bashTask.backgrounded": "后台",
  "chatStream.bashTask.noCommand": "(未知命令)",
  "chatStream.bashTask.stop": "停止",
  "chatStream.bashTask.stopTitle": "停止该命令（不影响回合继续）",
  "chatStream.bashTask.stopFailed": "停止命令失败",
  "chatStream.bashTask.output": "输出",
  "chatStream.bashTask.outputTitle": "展开/收起命令输出",
  "chatStream.bashTask.outputTruncated": "输出过长，仅显示末尾部分",
  "chatStream.bashTask.subRunning": "{running} 个运行中 · 共 {total} 条",
  "chatStream.bashTask.subIdle": "共 {n} 条 · 全部已结束",
  "chatStream.bashTask.unitCommands": "条",
  "chatStream.bashTask.footer": "模型通过 Bash 工具启动的命令（服务、脚本等）；关闭应用时会一并结束",

  // ── Agent-started services（活动区「服务」节点，端口扫描发现）──
  "chatStream.service.statusRunning": "运行中",
  "chatStream.service.stop": "停止",
  "chatStream.service.stopTitle": "停止端口 {port} 上的服务进程（连同其子进程）",
  "chatStream.service.stopFailed": "停止服务失败",
  "chatStream.service.open": "打开",
  "chatStream.service.openTitle": "在应用内浏览器打开 http://localhost:{port}",
  "chatStream.service.subRunning": "{n} 个服务在监听",
  "chatStream.service.unitServices": "个",
  "chatStream.service.unitPorts": "端口",
  "chatStream.service.footer": "模型启动的、正在监听端口的服务；停止会连同其子进程一并结束",

  // ── Message bookmarks (selection toolbar / capsule / timeline) ──
  "chatStream.bookmark.add": "添加书签",
  "chatStream.bookmark.addToChat": "添加到当前聊天",
  "chatStream.bookmark.askSideChat": "发送到子会话",
  "chatStream.bookmark.copied": "已复制",
  "chatStream.bookmark.capsuleTitle": "书签（{n} 个）",
  "chatStream.bookmark.sectionTitle": "书签 · {n} 个",
  "chatStream.bookmark.jumpTitle": "点击定位到原文",
  "chatStream.bookmark.remove": "删除书签",
  "chatStream.bookmark.rename": "重命名书签",
  "chatStream.bookmark.renamePlaceholder": "书签名称",
  "chatStream.bookmark.stale": "原消息已移除",
  "chatStream.bookmark.addedToast": "已添加书签",

  // ── ChatPane: streaming spinner hint ──
  "chatStream.upstreamRetry": "上游连接异常，正在重试（{attempt}/{attempts}）",

  // ── MessageBlocks: turn-incomplete warning card ──
  "chatStream.turnIncomplete.title": "任务提前中断",
  "chatStream.turnIncomplete.danglingDesc":
    "模型通道在任务中途返回了空响应，本轮未完成。直接发送「继续」可从中断处恢复。",
  "chatStream.turnIncomplete.emptyDesc":
    "模型通道未返回任何回复文本，本轮没有产出。建议重发或切换模型。",
  "chatStream.turnIncomplete.unfinishedDesc":
    "模型的收尾文本停在未写完的语句上，宣告的下一步没有发出。直接发送「继续」可从中断处恢复。",
  "chatStream.turnIncomplete.pendingTools": "未完成的调用：{tools}",

  // ── MessageBlocks: ExitPlanMode 审批通道故障警告 ──
  "chatStream.planApprovalBroken.title": "计划审批弹框未能弹出",
  "chatStream.planApprovalBroken.desc":
    "审批请求在传输通道中断（非用户拒绝）。模型通常已把计划写入计划文件，可直接回复「批准」或提出修改意见继续。",

  // ── EmptyThreadWelcome ──
  "chatStream.welcome.title": "开始新的会话",
  "chatStream.welcome.withProject": "在「{name}」中开始新的会话",
  "chatStream.welcome.todayUsage": "今天对话 {turns} 轮 · 消耗 {tokens} token",

  // ── Mermaid 流程图渲染 ──
  "chatStream.mermaid.chart": "图表",
  "chatStream.mermaid.code": "源码",
  "chatStream.mermaid.renderError": "图表语法解析失败",
  "chatStream.mermaid.fullscreen": "全屏查看",
  "chatStream.mermaid.clickToView": "点击全屏查看图表",
  // ── 对话修订:撤回已发送消息(2026-10-20) ──
  "chatStream.retract.button": "撤回",
  "chatStream.retract.title": "撤回这条消息",
  "chatStream.retract.scopeDesc": "将删除这条消息及其后的所有回合,会话回到这条消息发出之前;模型的上下文也会同步回退。",
  "chatStream.retract.warning": "撤回不会回滚已写入磁盘的文件改动;需要回滚文件请在撤回前使用「撤销本轮」。",
  "chatStream.retract.confirm": "撤回",
  "chatStream.retract.failed": "撤回失败",

  // ── 会话分叉 (Fork Session) ──
  "chatStream.fork.button": "分叉",
  "chatStream.fork.buttonTooltip": "从此消息分叉探索",
  "chatStream.fork.headerTooltip": "分叉当前会话探索",
  "chatStream.fork.dialogTitle": "分叉会话探索",
  "chatStream.fork.dialogDesc": "基于此节点前的上下文创建独立会话进行探索，不影响当前会话与大模型记忆。",
  "chatStream.fork.titleLabel": "新会话名称",
  "chatStream.fork.titlePlaceholder": "输入新会话名称…",
  "chatStream.fork.useWorktreeLabel": "启用代码工作区隔离 (Git Worktree)",
  "chatStream.fork.useWorktreeHint": "在独立工作树中运行，避免大模型修改主目录代码",
  "chatStream.fork.confirm": "分叉新会话",
  "chatStream.fork.failed": "分叉会话失败",
  "chatStream.fork.successToast": "已成功分叉为新会话",
} as const;
