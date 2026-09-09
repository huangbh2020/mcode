# 插件功能可行性分析

> Mcode — 基于 Agent SDK 的桌面端 GUI · 插件(Plugin)子系统规划前置调研
>
> 状态:**可行性结论已定,待排期实施**。调研日期 2026-09-09,所有三家(Claude Code / Codex CLI / ZCode)的插件机制均为**本机实测**(二进制 --help 探测、本机插件目录剖析、官方文档核对),非纯文档转述。

**结论先行:Mcode 做插件系统高度可行,且是「管道大半已铺好」的状态。** skills 与 MCP 两类组件的投递通道在三个 provider 侧均已存在(Mcode 为隔离配置目录、codex skills RPC、Pi skill bridge 各自建过一遍);剩余工作主要是插件生命周期管理这层「壳」——清单解析、安装管线、启用/禁用、设置页面板。建议 v1 以 **skills + MCP servers** 为核心组件面,Claude 侧后续用 SDK 原生 `options.plugins` 解锁全组件。

---

## 一、插件是什么:知识普及

### 1.1 与传统 IDE 插件不是一回事

VSCode/Eclipse 的插件扩展的是**软件本身**(加 UI、加语言支持);Claude Code / Codex / ZCode 这类编码 Agent CLI 的插件,扩展的是**模型的能力面**——给 agent「发装备」。插件主体是**声明式资源**(markdown、JSON 配置),由 agent 运行时在会话启动时装配进模型上下文,而不是跑在宿主 UI 里的程序逻辑。

风险等级随组件类型递增:

- skills / commands 只是**文本**——最坏情况是提示词注入,无直接代码执行;
- MCP servers / hooks 是**真代码执行**——MCP server 是独立子进程,hooks 是事件触发的 shell 命令。这是插件安全模型的核心矛盾点,也是 v1 取舍的依据。

### 1.2 五类组件

| 组件 | 形态 | 作用 | 举例 |
|------|------|------|------|
| **Skills** | 目录 + `SKILL.md`(YAML frontmatter 写 name/description) | 按需注入的「操作手册」,模型看到描述自主决定何时加载全文 | pptx 文档制作技能、浏览器 GUI 测试技能 |
| **Commands** | `.md` 文件(frontmatter 可带参数模板) | 斜杠命令,用户敲 `/review` 展开成一段预制 prompt | `/deploy-check`、`/pr-review` |
| **MCP servers** | JSON 配置(stdio 命令或 http url) | 给模型挂新**工具**;MCP server 是独立进程,工具逻辑在插件作者手里 | Firecrawl 联网抓取、Context7 查最新文档 |
| **Hooks** | 生命周期事件 → shell 命令映射 | 在工具调用前后、回合结束等时机跑脚本,做拦截/格式化/通知 | 提交前自动 lint |
| **Agents(子代理)** | `.md` 角色定义 | 声明带专属 system prompt/工具集的子 agent,主 agent 可派活 | code-reviewer 子代理 |

### 1.3 Marketplace 分发

三家分发方式高度趋同:**一个 git 仓库 + 根部一份 `marketplace.json` 清单**,列出可装插件及其来源(相对路径 / GitHub repo / zip URL,部分支持 npm 之外的自定义 source)。用户把仓库加为 marketplace,从中安装;插件本体拷贝进 CLI 自己的缓存目录,启用状态记在 CLI 配置里。本地开发可绕过 marketplace 直接指向本地目录(Claude 的 `--plugin-dir`、ZCode 的 inline 目录)。

### 1.4 三家实现对照(2026-09-09 本机实测)

| | **Claude Code** | **Codex CLI** | **ZCode** |
|---|---|---|---|
| 清单位置 | `.claude-plugin/plugin.json` | `.codex-plugin/plugin.json` | `.zcode-plugin/plugin.json`,**兼容识别另外两家的清单名**(探测顺序 zcode → claude → codex) |
| 组件 | commands / agents / skills / hooks / mcpServers 全支持 | skills + MCP 实证(二进制校验字符串);app 型插件另有 `interface.*` 元数据(capabilities/defaultPrompt/brandColor/screenshots) | commands / skills / hooks / mcpServers / agents;`lspServers`/`channels`/`outputStyles`/`settings` 仅记录不执行 |
| 管理命令 | `claude plugin install/uninstall/enable/disable/update`、`plugin marketplace add/remove/list/update`、`plugin validate/bundle`;会话级 `--plugin-dir`/`--plugin-url` | `codex plugin add/list/remove` + `codex plugin marketplace add/list/upgrade/remove`(0.153.4 实测存在);来源支持本地路径 / `owner/repo[@ref]` / HTTPS/SSH Git / sparse checkout;有 `--json` 输出 | 设置界面图形化管理(Installed / Discover 双 tab) |
| 安装布局 | `~/.claude/plugins/` | CODEX_HOME 下缓存 + config.toml 记状态 | `~/.zcode/cli/plugins/cache/<marketplace>/<plugin>/<version>/`(多版本缓存)+ `data/<plugin>@<marketplace>/`(插件数据)+ `marketplaces/<name>/`(克隆的市场仓库) |
| 插件身份 | `name@marketplace` | 同左 | 同左;支持跨 marketplace 依赖(需市场侧 `allowCrossMarketplaceDependenciesOn` 白名单,拒环) |
| 插件配置 | 安装时提示授予 MCP 工具权限;受限市场自动放行其 MCP 工具 | — | `userConfig` 类型化配置(string/number/boolean/directory/file + title/default/required/sensitive);**sensitive 字段当前无法持久化**(客户端无凭据库) |
| 版本纪律 | plugin.json 的 `version` 须严格 semver | 同左(校验字符串实证) | `version` 可缺省(默认 0.0.0);Git/URL 插件按 commit 追踪更新 |

本机插件实例剖析(佐证组件形态):

- `browser-use@zcode-plugins-official` 0.4.2:清单只声明 `"skills": "skills"`,两个 skill 目录(control-browser / web-gui-tester)+ 一份 `dist/mcp/server.js`(未在清单声明 MCP,由宿主内置拉起);
- `zcode-cua` 0.5.10:skills + `mcpServers` 一项——command 指向**宿主 App 的 helper 二进制**,以 `ELECTRON_RUN_AS_NODE=1` 拉起插件目录里的 `dist/mcp/server.js`。这是「GUI 宿主为插件提供进程托管」的现成范本,与 Mcode 的 in-process MCP 思路可互为参照。

---

## 二、Mcode 现有资产盘点

### 2.1 已铺好的投递管道

| 通道 | Claude | Codex | Pi | 状态 |
|------|--------|-------|-----|------|
| Skills 投递 | `CLAUDE_CONFIG_DIR=~/.mcode`(`customEnv.ts`)→ CLI 原生扫 `$CLAUDE_CONFIG_DIR/skills`(即 `~/.mcode/skills`) | `skills/extraRoots/set` RPC,每 turn 注入额外 skill 根(`CodexAgentSdkProvider.ts`) | `piSkillBridge` 扫 `~/.mcode/skills` + `<cwd>/.claude/skills` | **三家全通,零新增投递工作** |
| MCP 投递 | `~/.mcode/.claude.json` 的 `mcpServers`(CLI 自动加载,`mcpConfig.ts`) | 物化 `<CODEX_HOME>/config.toml` 的 `[mcp_servers.*]`(已有同步器) | ❌ `supportsMcp: false`,Pi 只认 extension | 两家通,Pi 缺 |
| 管理 UI | 设置页 MCP 面板(user/project/builtin 三源、启停、从 `~/.claude.json` 导入) | 同左 | 同左 | **现成** |
| Skills 管理 | `ipc/skills.ts`:用户级/项目级 skill 管理 + **跨工具导入**(扫 Claude/Codex/Zcode 的 skill 目录——本身就是三生态兼容先例) | 同左 | 同左 | **现成** |
| 插件原生加载 | ✅ SDK `options.plugins`(见 2.2) | codex 原生 `plugin` 子命令存在但**清单校验未校准**(见四.3) | ❌ 无插件概念 | Claude 侧一等支持 |

### 2.2 Claude Agent SDK 的原生插件支持(关键利好)

仓库当前钉的 `@anthropic-ai/claude-agent-sdk` **0.3.258**(`package.json` 实测;⚠️ AGENTS.md 仍记 0.3.238,文档漂移待修正)实测具备:

- **`options.plugins?: SdkPluginConfig[]`**——类型为 `{ type: 'local'; path: string; skipMcpDiscovery?: boolean }`,按会话加载本地插件,官方注释明确覆盖 custom commands、agents、skills、hooks。`skipMcpDiscovery: true` 时只装 skills/hooks/agents/commands、不读插件的 `.mcp.json` 与清单 `mcpServers`——留给宿主自管 MCP 连接(Mcode 若想统一走自己的 MCP 管理面,就用这个开关);
- **会话内热重载 API**——"Reload plugins from disk and return the refreshed commands, agents, plugins, and MCP server status"(无需重建会话);
- 捆绑 CLI **2.1.258** 支持 `--plugin-dir`(目录或 .zip)、`--plugin-url`(会话级 zip)、`claude plugin` 管理子命令、`--plugin validate/bundle`;`--bare` 模式显式跳过插件(反证插件在正常路径默认装配);
- 插件的 MCP server 由插件系统托管,豁免 SDK 动态 MCP 面的约束(`skipMcpDiscovery` 文档实证)。

### 2.3 可复用的基础设施

- **运行时按需下载管线**(`runtimeInstaller.ts`):registry 元数据、tarball 流式下载、sha512 校验、staging + 原子落位、进度事件、本地路径安装逃生通道、RuntimesPanel UI——**几乎是插件安装管线的现成模板**;
- **safeStorage**:cookie vault 与 provider keys 已在用,可直接补上 ZCode 至今没解决的「插件 sensitive 配置无法持久化」短板;
- **审批 UI 哲学**:安装时展示「这个插件会运行什么」并显式确认,是 Mcode 已有 canUseTool 审批文化的自然延伸。

---

## 三、推荐架构

### 3.1 总体形态:provider 中立插件层,逐 provider 翻译

```
~/.mcode/plugins/<name>/<version>/        ← Mcode 自己的插件缓存(不塞进各 agent 的家目录)
  └─ .claude-plugin/plugin.json           ← 清单格式采纳 Claude 生态(生态最大,且 ZCode/codex 同形)
      skills/  commands/  agents/  hooks/  .mcp.json

启用一个插件时,按 provider 翻译:
  Claude → options.plugins: [{ type:'local', path }]     (原生,组件最全)
  Codex  → skills: skills/extraRoots 追加插件 skill 根(已有 RPC)
           MCP:   config.toml [mcp_servers] 追加(已有物化器)
  Pi     → skills: piSkillBridge 追加;MCP/commands 不投递(能力矩阵如实呈现)
```

要点:

- **插件装进 Mcode 自己的目录**(`~/.mcode/plugins/`),与 `~/.mcode/skills`、`.claude.json` 的现有格局并列,不污染各 agent 家目录;启用集合持久化在 settings 表(同 `lsp.servers` / MCP 管理态先例);
- **每 provider 按能力投递**,插件面板呈现「本插件各组件在三个 provider 的支持情况」矩阵——不假装全支持;
- Claude 走 `options.plugins` 而非物化进共享目录,天然获得**会话级启停粒度**(改插件不用动全局配置,下一 turn 即生效)。

### 3.2 清单格式选型:采纳 `.claude-plugin`

- 生态最肥:官方 marketplace([claude-plugins-official](https://github.com/anthropics/claude-code-plugins) 等)与社区市场可直接引用;
- 格式同形:ZCode 兼容识别 `.claude-plugin`,codex 用同构的 `.codex-plugin`——一份插件理论上可同时投三个生态;
- 字段齐备(官方 reference 核对):`name`(正则约束)、`version`(严格 semver)、`description`、`author`、`when`(条件启用)、`commands`/`agents`/`skills`/`hooks`/`mcpServers`(可为目录名、数组或内联定义;MCP 亦可放插件根 `.mcp.json`);
- Mcode 解析时对 `.claude-plugin` / `.zcode-plugin` / `.codex-plugin` 三个位置都探测,即可**白嫖另外两个生态的现成插件**(skills 类几乎免费)。

marketplace.json 同样采纳 Claude 形态(`.claude-plugin/marketplace.json`):`{ name, owner, plugins[] }`,`plugins[].source` 支持相对路径字符串 / `{source:'github', repo}` / `{source:'git', url, ref?}` / `{source:'url', url}`;`strict: true` 要求每项带 version+description。

### 3.3 组件级翻译策略

| 组件 | Claude | Codex | Pi | v1 取舍 |
|------|--------|-------|-----|---------|
| skills | 原生(plugin 目录) | extraRoots 追加 | piSkillBridge 追加 | ✅ v1 核心,三家全通 |
| MCP servers | 原生,或 `skipMcpDiscovery` + 并入 Mcode MCP 管理面 | config.toml 物化 | ❌ | ✅ v1 核心(两家);并入现有 MCP 面板统一展示 |
| commands | 原生 | 无直接等价物 | 无 | v2:Claude 原生 + composer「预制指令」翻译(Mcode 作为 GUI 能比 CLI 做得更好的地方) |
| agents(子代理) | 原生(`agents/*.md`) | 无声明式等价物 | 无 | v2(仅 Claude) |
| hooks | 原生 | 未验证 | extension 事件部分覆盖 | **v1 不执行**(可解析展示);v3 慎做 + 逐条审批 |

### 3.4 安装与安全模型

- 安装来源:git 仓库 / 本地目录 / zip(对齐 marketplace source 三形态);下载-校验-落位复用 runtimeInstaller 骨架;
- **安装时组件审查**:展示清单全部组件 + MCP server 将运行的 command/env + hooks 将执行的命令,显式确认后才启用——把工具审批的安全姿态前移到插件安装;
- MCP server 启用后并入现有 MCP 管理面板(可单独禁用);插件的 MCP 条目带插件命名空间前缀,卸载即移除;
- `userConfig`(插件自定义配置)走 settings 表;标记 `sensitive` 的值进 safeStorage——补齐 ZCode 的已知短板;
- 路径守卫沿用现有纪律:插件内声明的 skill/command 路径必须在插件根内(ZCode 同款校验:绝对路径或逃逸插件根即拒)。

---

## 四、差距与风险

1. **Pi 的能力天花板**:无 MCP、无命令概念。这是 provider 客观差异而非缺陷——靠能力矩阵如实呈现。skills 类插件(生态里占比最大)三家全通,是安全的 MVP 面。
2. **Hooks 是最大的安全洞**:等于让插件在生命周期事件里跑任意 shell。v1 只解析不执行;即便 v3 启用,也应做到每条 hook 单独审批 + 默认关。
3. **Codex 原生插件子系统未校准**(2026-09-09 实测):`codex plugin` CLI 子命令存在,但最小 marketplace 清单(尝试过 `.codex-plugin/marketplace.json`、根 `marketplace.json`、个人市场 `~/.agents/plugins/marketplace.json` 三种摆放 + 补 version 字段)均未通过校验("marketplace root does not contain a supported manifest");二进制内嵌的校验字符串显示 plugin.json 要求严格 semver、author 对象、`interface.*` 仅 https URL 等;另有 "[plugins feature is disabled" 字符串**疑似 feature 门控**。→ **v1 完全不耦合 codex 原生插件**,走 extraRoots + config.toml 翻译路线(两条已在生产验证);原生通道留作后续优化,实施前须按「协议硬事实」纪律重新探测。
4. **Commands 的跨端落差**:Claude 原生;Codex/Pi 无等价物。翻译方案(composer 预制指令)是 Mcode 自有 UI 概念,需进 i18n 词典。
5. **SDK 版本纪律**:AGENTS.md 记 0.3.238,`package.json`/node_modules 实际 0.3.258——`options.plugins` 在 0.3.258 实测存在;若版本有变,升级回归清单须加上「插件加载」链路。
6. **`.claude.json` 竞态**:CLI 频繁重写该文件,Mcode 已用 read-modify-write + 保留未知键处理(`mcpConfig.ts`);插件 MCP 若并入 user scope 须走同一条通道,不另开写路径。

---

## 五、分期路线

### v1(核心,预估 1.5~2 周量级)

- 插件清单解析(三格式探测 + zod 契约,进 `packages/contracts`);
- 安装管线:git / 本地目录 / zip,复用 runtimeInstaller 的下载与校验骨架,落 `~/.mcode/plugins/<name>/<version>/`;
- 启用/禁用(settings 表持久化,per-provider 投递);
- **skills + MCP 两类组件**投递三家管道(Claude `options.plugins` / Codex extraRoots+config.toml / Pi skillBridge);
- 设置页 Plugins 面板(Installed / Discover 双 tab,对齐 RuntimesPanel 交互范式;UI 文案全进 zh/en 词典);
- 安装时组件审查确认(重点展示 MCP 的 command/env 与 hooks 内容)。

### v2

- 插件 `userConfig`(sensitive 值走 safeStorage);
- 版本更新检测与升级;
- Claude 侧经 `options.plugins` 启用 commands / agents 全组件;
- commands 的 composer「预制指令」翻译(三家可用)。

### v3(慎做)

- hooks 执行 + 逐条审批 + 默认关;
- codex 原生 `codex plugin` 通道(前置:清单 schema 校准 + feature 门控探测);
- 跨 marketplace 依赖解析。

---

## 六、实施期待校准项

| 项 | 现状 | 动作 |
|----|------|------|
| codex marketplace.json 精确 schema | 最小清单三次摆放均被拒 | 找一份可用市场仓库对照,或反编译校验器;确认是否需 `--enable plugins` |
| SDK `options.plugins` 端到端 | 类型与 CLI 旗标实证,未跑真会话 | v1 开工首日做冒烟:本地插件目录 + skill/command,验证加载与权限交互 |
| 插件 MCP 与 Mcode MCP 管理面的合并形态 | 两种路线(原生托管 vs `skipMcpDiscovery` 自管) | 按审批 UI 统一性决策;倾向自管(与现有面板一致) |
| Pi 侧 MCP 桥接可行性 | `supportsMcp: false` | 若强需求,评估 extension 内 MCP client(工作量大,暂不做) |

---

## 七、参考

- [Claude Code Plugins Reference](https://code.claude.com/docs/en/plugins-reference) · [创建插件](https://code.claude.com/docs/en/plugins) · [创建与分发 marketplace](https://code.claude.com/docs/en/plugin-marketplaces) · [发现与安装插件](https://code.claude.com/docs/en/discover-plugins)
- [Codex CLI 官方文档(skills 与 plugins)](https://learn.chatgpt.com/docs/codex/cli) · [Awesome Codex Plugins(社区格式参考)](https://github.com/hashgraph-online/awesome-codex-plugins)
- ZCode 插件体系:本机 `~/.zcode/cli/plugins/` 实测 + zcode-guide 技能文档(manifest schema / 生命周期 / 常见故障)
- 本机二进制实测:codex-cli 0.153.4(`codex plugin --help` 全家)、Claude Code 2.1.258(`--plugin-dir` / `plugin` 子命令)、`@anthropic-ai/claude-agent-sdk` 0.3.258(`sdk.d.ts` 的 `SdkPluginConfig`)
