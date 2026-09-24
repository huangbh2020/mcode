# Agent 运行时版本更新 — 技术方案

> 状态:**已实施(2026-09-24)**,三阶段一次落地;冒烟 `scripts/runtime-update-smoke/run.sh`(61 断言)。
> 实施与本文的已知偏差:① 红灯(broken)版本不带 force 时在**下载前**直接拒装(比本文 §4.3 更严,人工结论优先于机械闸门);② G3 的 claude/codex 启动探针用 `--version` 而非 system/init 冒烟——有凭据的机器上全冒烟会真跑一次模型调用(花 token 且依赖登录态),`--version` + G2 标记扫描的组合是确定性等价物;③ installLocal 也纳入了 running-turn 守卫;④ 首轮实测(2026-09-24)后修订:pi 的 latest 源加**上游包回退链**(`@mcode/runtime-pi` 未发布,回退 `@earendil-works/pi-coding-agent` 的 dist-tag,装上游版本走本地 npm 组装),兼容名单改**镜像链** jsDelivr → raw.githubusercontent(国内 raw 不可靠),404 与网络故障分 reason 区分(`registry-missing` / `registry-unreachable`)。本文是「agent 版本更新」功能的完整技术方案:
> 用户在设置页**手动点击「检查更新」**,应用对比上游 npm 最新版、判定与 Mcode 的契合度,
> 契合(或用户知情强制)即可**免重新打包发版**地把 claude / codex / pi 运行时升到新版本。

---

## 0. 目标与非目标

**目标**

1. 设置页「Agent Runtimes」面板新增「检查更新」能力:**纯手动触发**——无定时器、无启动检查、无后台轮询、无通知推送。
2. 检查结果给出**契合判定**(三态),而不是只报版本号差异。
3. 更新走既有下载管线(sha512 校验、双 registry、原子落位),**落位前**跑硬闸门,失败则旧版本毫发无损。
4. 保留上一版本作为回退安全网,坏了一键回退。
5. 放行一个新版本的运维成本从「发一次 app 版」降为「更新一个兼容名单 JSON」。

**非目标**

- 不做自动更新/静默更新(审批链路类回归对用户是灾难性的,升级决定权必须留在用户手里)。
- 不做版本历史浏览/多版本并存管理(至多保留 当前 + 上一版 两份)。
- 不改 `installRuntimeFromLocalPath` 逃生通道的语义。

---

## 1. 现状与缺口(代码锚点)

基建已完成约 60%,以下为已核实的事实:

| 能力 | 现状 | 位置 |
|------|------|------|
| 按需下载管线 | claude(~209MB)/codex(~378MB)/pi(~44MB)不随安装包分发,运行时从 npmmirror/npmjs 下载到 `<userData>/runtimes/<agent>/<version>/`,sha512 校验 + staging 原子落位 | `main/runtimes/runtimeInstaller.ts` |
| latest 查询 | `fetchLatestVersion()` 已按 agent 查 npm `latest` dist-tag,10min TTL 缓存,UI 故意不展示 | `runtimeInstaller.ts:206-221`,`RuntimesPanel.tsx:176` |
| 安装目标 | `installRuntime(agent)` **只装打包时钉进 package.json 的版本**(`loadExpectedVersions()`),不收版本参数 | `runtimeInstaller.ts:487-497` |
| updateAvailable 语义 | `active !== expected`——检测的是「app 升级后 runtime 落后」,不是「上游有新版」 | `runtimeInstaller.ts:410` |
| 任意版本逃生 | `installRuntimeFromLocalPath()` 本地目录/.tgz 可装任意版本 | `runtimeInstaller.ts:575` |
| 运行时 JS 加载先例 | Pi 整个 SDK 从 managed 目录按文件 URL `import()`,证明 JS 层运行时可换 | `providers/pi-sdk/piSdkLoader.ts:60-84` |
| 版本目录枚举 | `listManagedVersions()` newest-first,解析器(`sdkBinaryPath` 等)取第一个存在的 | `runtimes/managedRuntimeRoots.ts:56-76` |
| 落位后清理 | 只保留一份,旧版全删——**无回退能力**(回退=重下 209MB) | `runtimeInstaller.ts:450-455` |
| 上游兼容元数据 | claude JS 包内 `manifest.json` 带 `sdkCompat.testedWrapperVersions` + 各平台二进制 checksum | SDK 0.3.258 实测 |
| JS 主包形态 | `dependencies: null`(零运行时依赖),平台二进制是同版本号的 optionalDependencies | SDK package.json 实测 |

**上游版本锁步关系**(设计依赖):wrapper JS 包、平台二进制包、CLI 三者版本号同节奏发布(wrapper 0.3.258 ↔ CLI 2.1.258,manifest.json 的 `version` 字段即 CLI 版本)。

---

## 2. 总体设计

### 2.1 手动检查模型

「检查更新」是一个普通 invoke 请求-应答,结束时即终结:

- **零后台**:不加定时器、不加 `runtimes:event` 新事件、不加 OS 通知。现有 `listRuntimes()` 打开面板时的 best-effort latest 查询保持不变(它不构成"检查更新"语义,且离线不阻塞)。
- 点击时**强制绕过** `LATEST_TTL` 缓存(用户明确要求了,不拿缓存搪塞),查完回写缓存。
- 检查结果(判定 + 时间戳)只存 renderer 组件态,不持久化、不进 settings 表。

### 2.2 检查/安装分离,闸门分层

**点击「检查」= 建议性结论,毫秒级~秒级,零下载**:

```
判定 = f(activeVersion, latestVersion, 兼容名单)
```

**点击「更新」= 走下载管线,重型闸门全部挂在安装时**(产物已在手,失败发生在落位前,旧版本无伤):

```
下载(sha512) → 解压到 staging → [黄灯才跑] 上游元数据闸门 + 二进制标记扫描 + 冒烟探针 → 落位 → 保留 N-1
```

### 2.3 契合判定三层

1. **Mcode 兼容名单**(权威,人工沉淀):静态 JSON,点击时热拉取。上游行为性破坏(Stream closed 秒拒、对话框 kind 改名等)只能靠人工回归后登记,这是无法绕过的一层。
2. **上游元数据**(辅助):新 CLI 的 `sdkCompat.testedWrapperVersions` 是否覆盖当前 wrapper 版本。
3. **本地机械检查**(安装时):二进制内关键字符串扫描 + `system/init` 冒烟探针。

三态呈现:**绿**(已适配,可直接更)/ **黄**(上游最新但未经 Mcode 回归,确认后可更)/ **红**(已知不兼容,默认拒绝,强确认可强装)。

---

## 3. 契约层改动(`packages/contracts/src/ipc.ts`)

### 3.1 新增类型与 schema

```ts
/** 一次手动「检查更新」对单个 agent 的结论。 */
export type RuntimeCheckVerdict =
  | "up-to-date"   // active 已是 registry latest
  | "ok"           // latest 有更新,且在 Mcode 兼容名单 tested 里(绿灯)
  | "untested"     // latest 有更新,名单未覆盖/名单拉取失败/registry 不可达(黄灯)
  | "blocked"      // latest 在名单 broken 里(红灯)
  | "not-installed"; // 该 agent 当前无可激活运行时(面板走安装流程,不走更新)

export interface RuntimeCheckResult {
  agent: RuntimeAgentId;
  activeVersion: string | null;
  latestVersion: string | null;
  verdict: RuntimeCheckVerdict;
  /** 机器可读原因码(registry-unreachable / compat-list-stale / tested-by-manifest …) */
  reasons: string[];
  /** 兼容名单拉取失败时 true —— verdict 至多 untested,UI 附提示 */
  compatListStale: boolean;
  checkedAt: string; // ISO 时间戳
}

export const RuntimesCheckSchema = z.object({}); // 无入参:一次查全部三个
export type RuntimesCheckInput = z.infer<typeof RuntimesCheckSchema>;

export const RuntimesRollbackSchema = z.object({ agent: RuntimeAgentSchema });
export type RuntimesRollbackInput = z.infer<typeof RuntimesRollbackSchema>;
```

### 3.2 修改既有 schema

```ts
export const RuntimesInstallSchema = z.object({
  agent: RuntimeAgentSchema,
  /** 目标版本(裸 semver)。缺省 = 适配版(现行为,完全向后兼容)。 */
  version: z.string().regex(/^\d+(\.\d+){2}(-[\w.+-]+)?$/).optional(),
  /** 黄灯/闸门失败时知情强制。红灯同样需要它。install.json 留痕。 */
  force: z.boolean().optional(),
});
```

`RuntimesRemoveSchema` 增可选 `version`(释放指定旧版本,配合 N-1 保留)。

### 3.3 新通道 + RPC 类型表

```ts
// IPC 常量区(现 :5285 附近)
RUNTIMES_CHECK_UPDATES: "runtimes:checkUpdates",
RUNTIMES_ROLLBACK: "runtimes:rollback",

// RpcMap(现 :4894 附近),模式与 runtimes.* 完全一致
"runtimes.checkUpdates": (input: RuntimesCheckInput) => Promise<{ results: RuntimeCheckResult[] }>;
"runtimes.rollback": (input: RuntimesRollbackInput) => Promise<{ ok: boolean; rolledBackTo?: string; error?: string }>;
// runtimes.install 返回值增加 version?: string(回显实际安装版本)
```

preload(`apps/desktop/src/preload/index.ts`)按既有模式白名单注册两个新通道;mobile webApi 不需要额外适配(runtimes 面板是桌面设置页,webApi proxy 对缺失命名空间的既有行为不变)。

### 3.4 updateAvailable 语义修正

`RuntimeAgentState.updateAvailable` 现为 `active !== expected`——用户升到 latest(> expected)后会永远显示 true。改为:

```ts
updateAvailable =
  activeVersion !== null &&
  activeVersion !== expectedVersion &&
  activeVersion !== latestVersion;   // latest 为 null(离线)时退回旧语义 active !== expected
```

---

## 4. main 侧改动

### 4.1 兼容名单:`main/runtimes/runtimeCompat.ts`(新文件)

**格式**(仓库源文件 `config/agent-runtime-compat.json`,随 app 打包一份作 baseline):

```json
{
  "schema": 1,
  "claude": {
    "tested": ["0.3.258"],
    "broken": { "0.3.240": "permission prompts fail with Stream closed" }
  },
  "codex": { "tested": ["0.153.4"], "broken": {} },
  "pi":    { "tested": ["0.83.0"],  "broken": {} }
}
```

**加载策略**:

- 打包 baseline 读 asar 内文件(构建时由 electron-builder 拷入,esbuild `?raw` 导入亦可);**远端**从 GitHub raw(`https://raw.githubusercontent.com/<org>/my-claude-gui/main/config/agent-runtime-compat.json`)拉取,10s 超时,远端**覆盖合并** baseline(远端是新名单的发布通道——放行新版本不需要发 app 版)。
- 拉取失败 → `compatListStale: true`,名单判定降级为 untested(黄灯),不阻塞版本对比。
- zod 校验 + 体积上限(64KB)——远端数据当**不可信输入**处理,只用于判定,永不执行。
- 内存缓存单份,每次检查强制重拉(手动模型下不需要 TTL 复杂度)。

**运维约定**:每次想放行新 claude 版本,按 AGENTS.md 的升级清单人工回归(changelog/issue 检索、checksum 比对、对话框 kind、四条链路:计划审批/AskUserQuestion/工具审批/子代理收尾),通过后往 `tested` 加一行、推 main 即可。

### 4.2 检查逻辑:`checkRuntimeUpdates()`(runtimeInstaller.ts 新导出)

```
对三个 agent 并行:
  1. 强制刷新 latest(绕过 latestCache,查完回写)
  2. 解析 activeVersion(复用 installedManagedPayload / probeRuntimeAvailability)
  3. 判定:
       active == null                      → not-installed
       latest == null                      → untested + reason=registry-unreachable
       compareVersions(latest, active) <= 0 → up-to-date
       latest ∈ compat.broken              → blocked(reason 取 broken[latest])
       latest ∈ compat.tested              → ok
       否则                                 → untested
  4. compatListStale 一并带回
  5. active 自身 ∈ compat.broken → 追加 reason=active-version-broken +
     broken:<reason>;仅当判定为 up-to-date 时翻转为 blocked(有更新可升时
     保留原判定——升级脱困是最佳引导,翻转会遮住「更新至 vX」按钮;面板对
     active-broken 隐藏「仍要安装」并出「展开详情使用回退」引导)
```

> **2026-09-24 实测补记(pi 0.87.1 事件)**:机械闸门(G1/G2/G3)测不出「新版本依赖了本机 Node 没有的 API」这类**链接期破坏**——pi 0.87.x 从 `node:fs` 静态导入 `globSync`(Node ≥ 22.14),Electron 33 主进程 Node 20.x 整个 SDK 加载失败,模型下拉/回合全灭且 `listAvailable` 把错误吞成空数组,黄灯确认形同虚设。防线两层:① 兼容名单登记 `pi.broken["0.87.1"]`(人工结论回填的教科书场景);② `piSdkLoader` 改**逐版本回退梯子**——newest-first 逐个 import,失败打 WARN 退回下一版本目录(keep-2 留下的次新版本即兜底;整版本目录自包含,无 claude 的 wrapper↔binary 配对约束),全部失败才抛聚合错误。

`compareVersions` 复用 `managedRuntimeRoots.ts:36`(注意 codex 的 latest 来自 wrapper 包,本身是裸 semver,无需归一化;已安装目录名的平台后缀归一化已有 `normalizeInstalledVersion`)。

### 4.3 安装参数化 + 硬闸门:`installRuntime(agent, version?, force?)`

```
installRuntime(agent, version = loadExpectedVersions()[agent], force = false):
  ├─ installing 互斥守卫(现有)
  ├─ ★ running-turn 守卫(新增,与 remove 对齐;见 §8 边界)
  ├─ 判定目标版本的风险级:
  │    version ∈ compat.tested          → 绿灯:跳过闸门,直达落位(人工已回归)
  │    其余(含 expected 本身但名单未登记者不在此列——expected 恒按绿灯)
  ├─ 下载+解压到 staging(现有管线,sha512 不可绕过)
  ├─ ★ 闸门(仅黄灯/红灯路径;force 可跳过除 sha512 外的全部):
  │    G1 上游元数据:claude 专用,见下
  │    G2 二进制标记扫描:claude/codex
  │    G3 冒烟探针:三 agent 各自形态
  ├─ 落位 finalizeInstall(现有)
  └─ ★ 保留策略:keep newest + 1 previous(改现有"只留一份")
```

**G1 — 上游 wrapper 兼容元数据**(claude):

- 复用 `fetchPackageMeta("@anthropic-ai/claude-agent-sdk", version)` 拿 tarball URL + integrity,`downloadVerifiedTarball` 下载(JS 主包 < 1MB,零依赖),解出 `manifest.json`。
- 校验 `sdkCompat.testedWrapperVersions` 是否包含当前 app 的 wrapper 钉版(`loadExpectedVersions().claude`);不包含 → 闸门失败,reason 附名单。`harnessSchema` 跳版(≠当前)同样失败。
- 顺带 sanity:`manifest.version`(CLI 版本)应与平台包版本锁步(0.3.x ↔ 2.1.x),不符则 reason 提示但**不阻断**(Anthropic 改节奏不该挡安装,只提示)。
- 下载的 wrapper tarball 按 version 缓存在内存/临时目录——阶段 3 它直接变成 wrapper 运行时安装的产物(见 §6)。

**G2 — 二进制关键标记扫描**(claude/codex):

- 对 staging 内二进制做**分块流式字符串搜索**(64KB 块 + 1KB 重叠,不整读 200MB 进内存),必含标记(AGENTS.md 升级清单的可自动化部分):
  - claude:`permission_exit_plan_mode_v2`(对话框 kind 改名 = 审批链路断)
  - codex:按现有 codex provider 依赖的协议标记维护列表(初始可空)
- 标记缺失 → 闸门失败,错误信息直指「上游改名了 XXX,Mcode 尚未适配」。

**G3 — 冒烟探针**(staging 内、落位前,失败 = 中止安装,旧版本无伤):

- claude:spawn `[stagingBinary, "--print", "--input-format", "stream-json", "--output-format", "stream-json"]`,stdin 保持打开,等首条 stdout JSON `type === "system"`(system/init,启动即发、不需要 API key),验证可启动 + 协议头在,然后 kill。超时 20s,超时/解析失败/非零退出 → 失败。best-effort 比对 init 里的版本与请求版本(取不到只 warn)。
- codex:`codex --version`(即时退出,验证可执行)。
- pi:对 staging 的 entry 做 file-URL `import()`,验证 `createAgentSession` 导出存在(即 piSdkLoader 的加载路径本身)。

**force 语义**:跳过 G1-G3(sha512 永不跳过),`install.json` 记 `{ forced: true }` 留痕。红灯版本 UI 上要过二次强确认才带 force 调用。

### 4.4 保留与回退

**保留策略**(改 `finalizeInstall` 的清理循环,`runtimeInstaller.ts:450-455`):

- 落位后 `listManagedVersions(agent)` 排序,保留 newest + 次新,其余删除(`KEEP_VERSIONS = 2`)。
- 磁盘代价上限:claude ~418MB、codex ~756MB、pi ~88MB,合计 ~1.2GB——`RuntimesRemoveSchema` 的 per-version 参数提供手动释放出口,面板已显示 diskBytes。

**回退 `rollbackRuntime(agent)`**(runtimeInstaller.ts 新导出 + IPC):

- 前置:`listManagedVersions(agent).length >= 2`;running-turn 守卫(Windows 下删除运行中 exe 的目录会 EPERM)。
- 动作:删除 newest 版本目录。**无持久化指针状态**——解析器恒取「newest-first 第一个存在者」(`sdkBinaryPath.ts:57-70` / `piSdkLoader.ts:63` / codexBinaryResolve 同款),删掉 newest 后自动回落到旧版。回退后回显 `rolledBackTo`。
- 生效时机:claude/codex 二进制是 per-turn spawn,**下一回合即生效**;pi 的模块缓存(`piSdkLoader.sdkModule`)意味着**需重启应用**——UI 在 pi 更新/回退成功后提示「重启后生效」。

### 4.5 IPC handler(`main/ipc/runtimes.ts`)

```ts
ipcMain.handle(IPC.RUNTIMES_CHECK_UPDATES, async () => ({ results: await checkRuntimeUpdates() }));

ipcMain.handle(IPC.RUNTIMES_INSTALL, async (_evt, raw) => {
  const input = RuntimesInstallSchema.parse(raw);
  // ★ install 也纳入 running-turn 守卫(现有缺口,见 §8)
  const running = runtimeManager.runningSessionIds();
  if (running.length > 0) return { ok: false, error: "…stop them before updating a runtime" };
  return await installRuntime(input.agent, input.version, input.force);
});

ipcMain.handle(IPC.RUNTIMES_ROLLBACK, async (_evt, raw) => {
  const input = RuntimesRollbackSchema.parse(raw);
  /* running-turn 守卫同上 */ return await rollbackRuntime(input.agent);
});
```

---

## 5. renderer 改动

### 5.1 `RuntimesPanel.tsx`

- **面板头部**(标题行右侧)一枚全局「检查更新」按钮:点击 → `api.runtimes.checkUpdates({})`,按钮进入 checking 态;结果常驻渲染到各 agent 卡片(非 toast),附「上次检查 HH:mm」(组件态,重进面板即清,可接受)。
- **每卡片判定行**(在现有版本行下方,仅检查后渲染):

| verdict | 徽标 | 文案要点 | 动作 |
|---|---|---|---|
| up-to-date | 绿点 | 已是最新(x.y.z) | active 自身 broken 时翻转为 blocked(带 active-version-broken reason) |
| ok | 绿点 | 可更新至 x.y.z(已适配) | 「更新」→ 直接 `install({agent, version: latest})` |
| untested | 琥珀 | 可更新至 x.y.z(未测试) | 「更新」→ ConfirmDialog 风险提示 → `install({agent, version, force: 闸门失败时用户重试})` |
| blocked | 红 | x.y.z 已知不兼容:<broken reason> | 「仍要安装」danger 按钮 → 强确认 → `install({force: true})` |
| not-installed / registry-unreachable | 灰 | 引导安装 / 检查网络重试 | 复用现有按钮 |

- 安装进度复用现有 `runtimes:event` 订阅与 installing 态;闸门失败的 error 里有可读原因,展示在 lastError 位置。
- **既有「更新」按钮改文案「安装适配版 x.y.z」**,与新「更新至最新」区分(它保持 `install({agent})` 缺省语义)。
- **回退按钮**:检查区/展开详情处,仅当 `listManagedVersions ≥ 2` 时显示「回退到 <prev>」;pi 场景附带重启提示。
- 展开详情增加「上一版本: x.y.z」行(数据从 `runtimes.list` 的 `installedVersion` 旁新增 `previousVersion: string | null` 字段获取——`listRuntimes()` 顺手返回 `listManagedVersions(agent)[1]`)。

### 5.2 i18n(zh/en 同步,键前缀 `settings.runtimes.*`)

```
checkNow / checking / lastCheckAt{time} / verdictUpToDate{v} / verdictOk{v} /
verdictUntested{v} / verdictBlocked{v}{reason} / verdictNotInstalled /
verdictRegistryError / updateTo{v} / installExpected{v}(改自现有「更新」)/
confirmUntestedTitle / confirmUntestedBody / confirmBlockedTitle / confirmBlockedBody /
rollbackTo{v} / restartRequired / gateFailedWrapper / gateFailedMarker{marker} /
gateFailedProbe / previousVersion{v}
```

---

## 6. 阶段 3:claude wrapper 成对安装与运行时加载

现状缺口:JS wrapper(`sdk.mjs`)在 asar 里随 app 走,运行时只能换二进制——wrapper 与 CLI 错配正是 G1 要防的风险,根因消除靠把 wrapper 也运行时化。

**做法**(全部复用既有模式,零新机制):

1. **成对安装**:`installRuntime("claude", v)` 在下载平台二进制包之外,再下载 `@anthropic-ai/claude-agent-sdk@v` JS 主包(零依赖、< 1MB,G1 本来就要下它),解到**同一个版本目录**:`<userData>/runtimes/claude/<v>/{claude.exe, sdk.mjs, sdk.d.ts, manifest.json, package.json}`。wrapper 与 CLI 版本锁步,同目录天然原子配对,回退一起回。
2. **新 `providers/claude-sdk/sdkLoader.ts`**(镜像 piSdkLoader):managed 目录优先(file-URL `import(sdk.mjs)`),回退裸 specifier(asar 内旧位置/dev node_modules)。**`pathToClaudeCodeExecutable` 恒由宿主传入**(现状如此,sdk.mjs 内部自解析路径不会生效),wrapper 换版本不影响二进制查找。
3. **收敛 6 个动态 import 调用点**到 `loadClaudeSdk()`:`ClaudeAgentSdkProvider.ts:78/:175`(query、createSdkMcpServer)、`ipc/titleGen.ts:126`、`ipc/customModel.ts:130`、`ipc/git.ts:382`、`automation/intentParser.ts:104`。类型引用(`import type`)不动——编译期类型仍来自 dev node_modules 钉版,运行期模块来自 managed 目录,版本偏差靠 G1 + 兼容名单兜底。
4. G1 随之本地化:wrapper 已在 staging 里,直接读 `manifest.json`,不再单独下载。

阶段 3 完成后,「检查更新」对 claude 的语义变成 **wrapper+CLI 整对升级**,与上游 testedWrapperVersions 矩阵天然对齐。

---

## 7. pi / codex 特有说明

- **pi**:latest 查询挂在 `@mcode/runtime-pi` meta 包上(`latestCheckPackageFor`,现有)——meta 包由维护者在人工回归后 bump,**pi 的契合闸门天然 = meta 包的发版节奏**,上游 `@earendil-works/pi-coding-agent` 直接 latest 的场景留给「从本地导入」逃生通道。registry miss 时 `assemblePiClosureWithNpm(stagingDir, version)` 已收 version 参数,参数化后即支持任意版本(仅改调用处一行)。pi 更新需重启生效(模块缓存)。
- **codex**:目标版本是裸 semver,`npmPackageFor` 拼 `${version}-${plat}`(现有);安装目录名经 `normalizeInstalledVersion` 剥后缀(现有);G2/G3 用 codex 形态(`--version` 探针、vendor 布局断言已在 `payloadEntryPath`)。

---

## 8. 边界与已知取舍

1. **install 的 running-turn 守卫是补漏**:现状 `finalizeInstall` 会 `rmSync` 旧版本目录,Windows 下若旧 exe 正被执行(运行中回合)删除会 EPERM——这是**现存 latent bug**,本方案顺带修复(install/remove/rollback 三者统一守卫)。
2. **名单是持续性运维成本,不是代码成本**:功能把「发版」降级为「更新 JSON + 用户自助点击」,但每个放行决定前的人工回归不可省。黄灯的存在就是为这件事定价:不回归也可以让用户自己冒险,但 UI 把风险说清楚。
3. **检查动作的网络面**:每次点击 = 3 个 latest 请求(双 registry 容错)+ 1 个名单 GET,无缓存复用是有意为之(手动场景要新鲜度)。离线时 up-to-date 判定退化为「不可检查」,绝不误报。
4. **磁盘翻倍**(~1.2GB 上限)是回退能力的代价,per-version remove 是泄压阀;若不可接受,可将 `KEEP_VERSIONS` 收窄为「仅黄灯/强制安装保留上一版,绿灯安装照旧全清」——实现上是同一处的分支,先按全局 KEEP=2 实施,后续按反馈收窄。
5. **force 的审计**:强制安装写 `install.json { forced: true }`,事后排障可从 main.log + install.json 双向取证。
6. **手机壳不受影响**:新通道均为设置页(桌面功能)服务,webApi 既有 proxy 行为天然兜底。
7. **上游改名/改协议的最坏情况**:G2/G3 在落位前拦截,旧版本无伤;若闸门本身判断失误(假阴性),回退按钮是最后防线。

---

## 9. 测试计划

**冒烟脚本 `scripts/runtime-update-smoke/run.sh`**(照 `github-smoke`/`service-scanner-smoke` 惯例:esbuild bundle、alias 桩掉 electron 邻接模块、`globalThis.fetch` 打桩伺服假 registry 元数据 + 真实 tar 夹具):

- 判定矩阵:五种 verdict 的全部触发路径(up-to-date/ok/untested/blocked/not-installed、registry 不可达、名单 stale 降级);
- `installRuntime(agent, version)` 参数正确传到 `npmPackageFor`;缺省 version 行为与现状 bit-for-bit 一致(回归护栏);
- G1:假 manifest 的 testedWrapperVersions 含/不含当前钉版两种结局;
- G2:夹具二进制含/缺 marker 两种结局(小块重叠边界用例);
- G3:探针桩成功/超时/非零退出;
- 闸门失败 → staging 清理、旧版本目录原样、install.json 未写;
- 保留策略:装两次后恰好剩 2 个版本目录;rollback 删除 newest、解析器回落(mock managedRuntimeRoots);
- running-turn 守卫对 install/rollback 生效;
- `updateAvailable` 新语义(latest=null 回退旧语义)。

**人工回归清单**(放行名单版本时执行,与 AGENTS.md 的 SDK 升级清单合并维护):四条链路(计划审批/AskUserQuestion/工具审批/子代理收尾)+ settle 门控日志锚点(`claude turn start` / `claude turn settled`)+ turn.incomplete 不误报。

---

## 10. 实施排期

| 阶段 | 内容 | 涉及文件 | 预估 |
|---|---|---|---|
| **1. 解钉 + 手动检查** | 契约(schema/通道/RPC)+ `checkRuntimeUpdates` + 兼容名单加载 + 面板检查按钮与三态渲染 + `updateAvailable` 语义修正 + i18n | contracts/ipc.ts、runtimeInstaller.ts、runtimeCompat.ts(新)、ipc/runtimes.ts、preload、RuntimesPanel.tsx、zh/en settings 词典 | 1-2 天 |
| **2. 闸门 + 保留/回退** | `installRuntime` 参数化 + G1/G2/G3 + KEEP=2 + rollback IPC/UI + running-turn 守卫补漏 + 冒烟脚本 | runtimeInstaller.ts、ipc/runtimes.ts、RuntimesPanel.tsx、scripts/runtime-update-smoke/ | 2-3 天 |
| **3. wrapper 运行时化** | claude 成对安装 + `sdkLoader.ts` + 6 调用点收敛 + G1 本地化 | runtimeInstaller.ts、providers/claude-sdk/sdkLoader.ts(新)、ClaudeAgentSdkProvider.ts、titleGen/customModel/git/intentParser | 2-3 天 |

阶段 1 单独发布即解决「每次都重新打包发版」的主诉(检查 → 看到新版 → 黄灯确认安装);阶段 2 是安全网;阶段 3 消除 wrapper 错配根因。三阶段互相独立可回退,阶段 1 不依赖 2/3 的任何代码。
