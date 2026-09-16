/**
 * 编排模板(流水线保存复用 / 竞争 / fan-out)+ 内置模板。
 *
 * 模板 = 任务骨架数组(spec 中的 {goal} 占位符在创建 run 时替换)+
 * 默认预算/并发/worktree 策略。「模板市场」当前形态 = 内置模板 +
 * 用户模板 CRUD + JSON 导入导出(renderer 侧用文件对话框)。
 */
import type { OrchestrationTemplate, TaskSpecInput } from "@contracts/orchestration";
import { OrchestrationTemplateSchema } from "@contracts/orchestration";
import { SettingRepo } from "@main/store/repositories.js";
import { uid } from "@main/utils.js";

const TEMPLATES_KEY = "orch.templates.v1";

function task(spec: string, profileId: string, deps: string[] = [], extra: Partial<TaskSpecInput> = {}): TaskSpecInput {
  return {
    id: "",
    spec,
    deps,
    profileId,
    customModelId: null,
    providerId: null,
    model: null,
    effort: null,
    permissionMode: null,
    reviewOf: null,
    variantGroup: null,
    tags: [],
    runner: "agent",
    ...extra,
  };
}

function builtinTemplates(): OrchestrationTemplate[] {
  const t = Date.now();
  const base = { builtin: true, createdAt: t, updatedAt: t };
  const list: OrchestrationTemplate[] = [
    {
      ...base,
      id: "builtin-pipeline",
      name: "流水线(规划→实现→测试→审查→修复)",
      description: "生成/审查分离的标准链路:审查不通过自动打回实现者重做(上限 3 轮)。",
      tasks: [
        task("根据总体目标 {goal} 做实现规划,产出任务拆解与文件改动清单。", "builtin-planner"),
        task("按规划完成 {goal} 的实现。规划产物见上游。", "builtin-implementer", ["t1"]),
        task("运行/编写测试验证 {goal} 的实现,报告通过率。", "builtin-implementer", ["t2"]),
        task("审查 {goal} 的实现与测试产出,输出结论 pass / changes_requested。", "builtin-reviewer", ["t3"], { reviewOf: "t2" }),
      ],
      budgetUsd: null,
      concurrency: 2,
      worktreePolicy: "auto",
    },
    {
      ...base,
      id: "builtin-fanout",
      name: "并行拆解(fan-out)",
      description: "多个不相关子任务同时派发,适合互相独立的大任务。",
      tasks: [
        task("模块 A:{goal}", "builtin-implementer"),
        task("模块 B:{goal}", "builtin-implementer"),
        task("模块 C:{goal}", "builtin-implementer"),
        task("汇总审阅 A/B/C 的产出并给出整合意见。", "builtin-reviewer", ["t1", "t2", "t3"]),
      ],
      budgetUsd: null,
      concurrency: 4,
      worktreePolicy: "always_new",
    },
    {
      ...base,
      id: "builtin-competition",
      name: "多方案竞争(2 选 1)",
      description: "两个 agent 各出一版,完成后由你择优,落选方案标记淘汰。",
      tasks: [
        task("方案一:{goal}", "builtin-implementer", [], { variantGroup: "v1" }),
        task("方案二:{goal}", "builtin-implementer", [], { variantGroup: "v1" }),
      ],
      budgetUsd: null,
      concurrency: 2,
      worktreePolicy: "always_new",
    },
  ];
  // 内置模板的任务 id 在实例化时重排为 t1..tN。
  return list.map((tpl) => ({
    ...tpl,
    tasks: tpl.tasks.map((t2, i) => ({ ...t2, id: `t${i + 1}` })),
  }));
}

function readAll(): OrchestrationTemplate[] {
  const raw = SettingRepo.get(TEMPLATES_KEY);
  let list: OrchestrationTemplate[] = [];
  if (raw) {
    try {
      const arr = JSON.parse(raw) as unknown[];
      list = arr
        .map((x) => {
          const parsed = OrchestrationTemplateSchema.safeParse(x);
          return parsed.success ? parsed.data : null;
        })
        .filter((x): x is OrchestrationTemplate => x !== null);
    } catch {
      list = [];
    }
  }
  const ids = new Set(list.map((t) => t.id));
  const missing = builtinTemplates().filter((t) => !ids.has(t.id));
  if (missing.length > 0) {
    list = [...list, ...missing];
    SettingRepo.set(TEMPLATES_KEY, JSON.stringify(list));
  }
  return list;
}

export const TemplateStore = {
  list(): OrchestrationTemplate[] {
    return readAll();
  },
  save(input: OrchestrationTemplate): OrchestrationTemplate[] {
    const list = readAll();
    const idx = list.findIndex((t) => t.id === input.id);
    const tpl = OrchestrationTemplateSchema.parse({
      ...input,
      builtin: idx >= 0 ? list[idx].builtin : false,
      createdAt: idx >= 0 ? list[idx].createdAt : Date.now(),
      updatedAt: Date.now(),
    });
    if (idx >= 0) list[idx] = tpl;
    else list.push(tpl);
    SettingRepo.set(TEMPLATES_KEY, JSON.stringify(list));
    return list;
  },
  delete(id: string): OrchestrationTemplate[] {
    const list = readAll().filter((t) => t.id !== id || t.builtin);
    SettingRepo.set(TEMPLATES_KEY, JSON.stringify(list));
    return list;
  },
  /** 从现有 run 的任务骨架保存为用户模板。 */
  fromTasks(name: string, description: string, tasks: TaskSpecInput[]): OrchestrationTemplate {
    return OrchestrationTemplateSchema.parse({
      id: `tpl_${uid()}`,
      name,
      description,
      tasks,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
};
