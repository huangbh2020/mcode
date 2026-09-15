/**
 * AgentProfile 存储(settings 表 JSON key)+ 内置角色模板。
 *
 * 角色 = 用户定义的"worker 模板":provider/model/effort/权限/系统提示/
 * worktree 偏好/能力标签/成本。内置五角色(规划者/实现者/文案/画图/审查者)
 * 按 docs/orchestration-plan.md §4;用户可覆盖内置角色(按 id upsert),
 * 但不允许删除(删除请求对 builtin 静默回退为恢复内置定义)。
 */
import type { AgentProfile } from "@contracts/orchestration";
import { AgentProfileSchema } from "@contracts/orchestration";
import { SettingRepo } from "@main/store/repositories.js";
import { uid } from "@main/utils.js";

const PROFILES_KEY = "orch.agents.v1";

const now = () => Date.now();

/** 内置角色(首次读取时播种;已存在同 id 用户覆盖时不重播)。 */
function builtinProfiles(): AgentProfile[] {
  const t = now();
  const base = { builtin: true, createdAt: t, updatedAt: t };
  return [
    {
      ...base,
      id: "builtin-planner",
      name: "规划者",
      icon: "🧭",
      color: "violet",
      providerId: "claude-sdk",
      model: "opus",
      effort: "high",
      systemPrompt:
        "你是任务规划专家。接收一个总体目标,产出结构化、可独立验收的子任务拆解。每个子任务给出:目标、约束、产物路径、验收标准。避免子任务间的隐式耦合。",
      allowedTools: [],
      permissionMode: "default",
      defaultWorktree: "none",
      tags: ["planning"],
    },
    {
      ...base,
      id: "builtin-implementer",
      name: "实现者",
      icon: "🔨",
      color: "sky",
      providerId: "claude-sdk",
      model: "sonnet",
      effort: "medium",
      systemPrompt:
        "你是实现工程师。按任务简报完成编码工作:先读相关代码,再最小化修改。完成后用一段简短总结说明做了什么、改了哪些文件、如何验证。遇到阻塞才提问。",
      allowedTools: [],
      permissionMode: "default",
      defaultWorktree: "new",
      tags: ["coding"],
    },
    {
      ...base,
      id: "builtin-writer",
      name: "文案",
      icon: "✍️",
      color: "amber",
      providerId: "claude-sdk",
      model: "sonnet",
      effort: "medium",
      systemPrompt:
        "你是文案专家。按简报产出文档/营销/说明文字,风格与受众以简报为准,交付物写入指定路径。",
      allowedTools: [],
      permissionMode: "default",
      defaultWorktree: "none",
      tags: ["writing"],
    },
    {
      ...base,
      id: "builtin-illustrator",
      name: "画图",
      icon: "🎨",
      color: "pink",
      providerId: "codex-sdk",
      model: "default",
      effort: "default",
      systemPrompt:
        "你是图像生成 worker。按简报生成图片并保存到指定产物路径;无法生成时明确说明原因。",
      allowedTools: [],
      permissionMode: "default",
      defaultWorktree: "none",
      tags: ["image"],
    },
    {
      ...base,
      id: "builtin-reviewer",
      name: "审查者",
      icon: "🔍",
      color: "emerald",
      providerId: "claude-sdk",
      model: "opus",
      effort: "high",
      systemPrompt:
        "你是代码审查者,只读不改。对目标改动输出结构化审查报告:结论(pass/fail/changes_requested)、问题清单(文件:行号)、修复建议。你的报告将决定任务是否打回重做。",
      allowedTools: [],
      permissionMode: "default",
      defaultWorktree: "none",
      tags: ["review"],
    },
  ];
}

function normalize(p: unknown): AgentProfile | null {
  const parsed = AgentProfileSchema.safeParse(p);
  return parsed.success ? parsed.data : null;
}

function readAll(): AgentProfile[] {
  const raw = SettingRepo.get(PROFILES_KEY);
  let list: AgentProfile[] = [];
  if (raw) {
    try {
      const arr = JSON.parse(raw) as unknown[];
      list = arr.map(normalize).filter((p): p is AgentProfile => p !== null);
    } catch {
      list = [];
    }
  }
  // 播种缺失的内置角色(用户删除内置角色 = 恢复内置定义,所以重新播种
  // 恰好是"不可删除"语义的实现;用户覆盖的同 id 角色优先保留)。
  const ids = new Set(list.map((p) => p.id));
  const missing = builtinProfiles().filter((p) => !ids.has(p.id));
  if (missing.length > 0) {
    list = [...list, ...missing];
    SettingRepo.set(PROFILES_KEY, JSON.stringify(list));
  }
  return list;
}

function writeAll(list: AgentProfile[]): void {
  SettingRepo.set(PROFILES_KEY, JSON.stringify(list));
}

export const ProfileStore = {
  list(): AgentProfile[] {
    return readAll();
  },
  get(id: string): AgentProfile | undefined {
    return readAll().find((p) => p.id === id);
  },
  save(input: AgentProfile): AgentProfile[] {
    const list = readAll();
    const idx = list.findIndex((p) => p.id === input.id);
    const agent: AgentProfile = AgentProfileSchema.parse({
      ...input,
      builtin: idx >= 0 ? list[idx].builtin : false,
      createdAt: idx >= 0 ? list[idx].createdAt : now(),
      updatedAt: now(),
    });
    if (idx >= 0) list[idx] = agent;
    else list.push(agent);
    writeAll(list);
    return list;
  },
  newDraft(): AgentProfile {
    return AgentProfileSchema.parse({
      id: `agent_${uid()}`,
      name: "",
      icon: "🤖",
      color: "sky",
      createdAt: now(),
      updatedAt: now(),
    });
  },
  delete(id: string): AgentProfile[] {
    const list = readAll();
    const next = list.filter((p) => p.id !== id || p.builtin);
    writeAll(next);
    return next;
  },
};

/* ── 分配学习(P3):tag → profileId → 成功计数,用于路由建议 ── */

const ROUTING_KEY = "orch.routing.v1";

function readRouting(): Record<string, Record<string, number>> {
  const raw = SettingRepo.get(ROUTING_KEY);
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return typeof v === "object" && v !== null ? (v as Record<string, Record<string, number>>) : {};
  } catch {
    return {};
  }
}

export const RoutingStats = {
  /** 记录一次任务结果(success 加 1 / 失败减 1,下限 0)。 */
  record(tag: string, profileId: string, success: boolean): void {
    const r = readRouting();
    const byProfile = (r[tag] ??= {});
    const cur = byProfile[profileId] ?? 0;
    byProfile[profileId] = Math.max(0, cur + (success ? 1 : -1));
    SettingRepo.set(ROUTING_KEY, JSON.stringify(r));
  },
  /** 按 tag 检索历史表现降序的 profileId 列表(仅包含计数 > 0 的)。 */
  topProfiles(tag: string): string[] {
    const byProfile = readRouting()[tag];
    if (!byProfile) return [];
    return Object.entries(byProfile)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
  },
};
