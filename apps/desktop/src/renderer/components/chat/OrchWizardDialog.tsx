/**
 * 内置编排向导(拆解 → 改派 → 确认 → 运行)。
 *
 * 「模型提案、用户审批」范式的皮套:自动拆解由规划者角色(side 会话,
 * main 侧 orch.proposePlan)驱动,产出任务 DAG 提案;用户在确认前可任意
 * 改派/增删/调依赖/调预算 —— 确认后才创建 run 并开始派发。可保存当前
 * 任务图为模板(pipeline 复用)。挂在 App 根,由 store.orchWizard 驱动。
 */
import { useEffect, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { api } from "@renderer/lib/api.js";
import type { TaskSpecInput } from "@contracts/orchestration";
import { Dialog } from "@renderer/components/ui/index.js";
import { Button, Input } from "@renderer/components/ui/index.js";
import { IconSparkles, IconPlus, IconX, IconDeviceFloppy } from "@renderer/lib/icons.js";

interface DraftTask {
  id: string;
  spec: string;
  profileId: string | null;
  deps: string[];
  reviewOf: string | null;
  variantGroup: string | null;
  runner: "agent" | "terminal";
  terminalCommand?: string;
}

let taskSeq = 0;
const nextTaskId = () => `t${++taskSeq}`;

const inputCls =
  "w-full rounded border border-edge bg-surface px-2 py-1.5 text-xs text-content placeholder:text-content-subtle outline-none focus:border-accent";
const selectCls = "h-8 rounded border border-edge bg-surface px-1.5 text-xs outline-none focus:border-accent";

export function OrchWizardDialog() {
  const { t } = useI18n();
  const open = useSessionStore((s) => s.orchWizard.open);
  const fromSessionId = useSessionStore((s) => s.orchWizard.fromSessionId);
  const seedGoal = useSessionStore((s) => s.orchWizard.goal);
  const seedProfiles = useSessionStore((s) => s.orchWizard.profileIds);
  const closeOrchWizard = useSessionStore((s) => s.closeOrchWizard);
  const agents = useSessionStore((s) => s.orchAgents);
  const templates = useSessionStore((s) => s.orchTemplates);
  const orchSettings = useSessionStore((s) => s.orchSettings);
  const reloadOrchAgents = useSessionStore((s) => s.reloadOrchAgents);
  const reloadOrchTemplates = useSessionStore((s) => s.reloadOrchTemplates);
  const orchProposePlan = useSessionStore((s) => s.orchProposePlan);
  const saveOrchTemplate = useSessionStore((s) => s.saveOrchTemplate);
  const loadOrchRuns = useSessionStore((s) => s.loadOrchRuns);
  const setRightPanelTab = useSessionStore((s) => s.setRightPanelTab);

  const [goal, setGoal] = useState("");
  const [tasks, setTasks] = useState<DraftTask[]>([]);
  const [budget, setBudget] = useState("");
  const [concurrency, setConcurrency] = useState(4);
  const [worktreePolicy, setWorktreePolicy] = useState<"auto" | "always_new" | "active_only">("auto");
  const [decomposing, setDecomposing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  // Open → hydrate from seed (goal / preset targets / settings defaults).
  useEffect(() => {
    if (!open) return;
    void reloadOrchAgents();
    void reloadOrchTemplates();
    setGoal(seedGoal);
    setConcurrency(orchSettings?.concurrency ?? 4);
    setBudget(orchSettings?.budgetUsd ? String(orchSettings.budgetUsd) : "");
    // Seed: one task per preset target, or a single empty task.
    if (seedProfiles.length > 0) {
      setTasks(
        seedProfiles.map((pid) => ({
          id: nextTaskId(),
          spec: "",
          profileId: pid,
          deps: [],
          reviewOf: null,
          variantGroup: seedProfiles.length > 1 ? "v1" : null,
          runner: "agent",
        })),
      );
    } else if (tasks.length === 0) {
      setTasks([{ id: nextTaskId(), spec: "", profileId: null, deps: [], reviewOf: null, variantGroup: null, runner: "agent" }]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const updateTask = (id: string, patch: Partial<DraftTask>) =>
    setTasks((ts) => ts.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const autoDecompose = async () => {
    if (!goal.trim()) return;
    setDecomposing(true);
    setError("");
    try {
      const proposal = await orchProposePlan(goal);
      if (proposal && proposal.length > 0) {
        // Model-proposed ids may collide with our draft ids — re-key to fresh
        // local ids and remap deps by position.
        const idMap = new Map<string, string>();
        const rekeyed = proposal.map((p) => {
          const fresh = nextTaskId();
          idMap.set(p.id, fresh);
          return { ...p, id: fresh, deps: [] as string[], spec: p.spec.replace(/\{goal\}/g, goal) };
        });
        for (let i = 0; i < proposal.length; i++) {
          rekeyed[i].deps = (proposal[i].deps ?? []).map((d) => idMap.get(d) ?? d).filter((d) => idMap.has(d));
        }
        setTasks(rekeyed);
      } else {
        setError(t("orch.wizard.decomposeFailed"));
      }
    } finally {
      setDecomposing(false);
    }
  };

  const applyTemplate = (tplId: string) => {
    const tpl = templates.find((x) => x.id === tplId);
    if (!tpl) return;
    const idMap = new Map<string, string>();
    const rekeyed: DraftTask[] = tpl.tasks.map((p) => {
      const fresh = nextTaskId();
      idMap.set(p.id, fresh);
      return {
        id: fresh,
        spec: p.spec.replace(/\{goal\}/g, goal || "{goal}"),
        profileId: p.profileId,
        deps: [],
        reviewOf: null,
        variantGroup: p.variantGroup,
        runner: p.runner,
        terminalCommand: p.terminalCommand,
      };
    });
    tpl.tasks.forEach((p, i) => {
      rekeyed[i].deps = p.deps.map((d) => idMap.get(d) ?? d).filter((d) => idMap.has(d));
      const reviewTarget = tpl.tasks.find((x) => x.id === p.reviewOf);
      if (reviewTarget) rekeyed[i].reviewOf = idMap.get(reviewTarget.id) ?? null;
    });
    setTasks(rekeyed);
    setConcurrency(tpl.concurrency);
    setWorktreePolicy(tpl.worktreePolicy);
    if (tpl.budgetUsd) setBudget(String(tpl.budgetUsd));
  };

  const saveAsTemplate = async () => {
    const spec: TaskSpecInput[] = tasks.map((x) => ({
      id: x.id,
      spec: x.spec,
      deps: x.deps,
      profileId: x.profileId,
      reviewOf: x.reviewOf,
      variantGroup: x.variantGroup,
      tags: [],
      runner: x.runner,
      terminalCommand: x.terminalCommand,
    }));
    await saveOrchTemplate({
      id: `tpl_${Date.now().toString(36)}`,
      name: goal.slice(0, 40) || "template",
      description: "",
      builtin: false,
      tasks: spec,
      budgetUsd: budget ? Number(budget) : null,
      concurrency,
      worktreePolicy,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  };

  const create = async () => {
    if (!fromSessionId) {
      setError(t("orch.panel.empty"));
      return;
    }
    const valid = tasks.filter((x) => x.spec.trim());
    if (valid.length === 0) {
      setError(t("orch.agents.errName"));
      return;
    }
    setCreating(true);
    setError("");
    try {
      await api.orch.createRun({
        sessionId: fromSessionId,
        goal,
        tasks: valid.map((x) => ({
          id: x.id,
          spec: x.spec.trim(),
          deps: x.deps,
          profileId: x.profileId,
          reviewOf: x.reviewOf,
          variantGroup: x.variantGroup,
          tags: [],
          runner: x.runner,
          terminalCommand: x.terminalCommand,
        })),
        budgetUsd: budget ? Number(budget) : null,
        concurrency,
        worktreePolicy,
      });
      await loadOrchRuns(fromSessionId);
      setRightPanelTab("orch");
      closeOrchWizard();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const estCost = tasks.reduce((sum, x) => {
    const cost = agents.find((a) => a.id === x.profileId)?.costPerMtok ?? 0;
    return sum + (Math.max(2000, x.spec.length * 2) / 1e6) * cost;
  }, 0);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && closeOrchWizard()}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="flex max-h-[86vh] w-[720px] max-w-[92vw] flex-col gap-3 p-5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">{t("orch.wizard.title")}</span>
            <button onClick={closeOrchWizard} className="ml-auto rounded p-1 text-content-subtle hover:text-content">
              <IconX size={16} />
            </button>
          </div>

          {/* 目标 + 自动拆解 */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium">{t("orch.wizard.goal")}</label>
              <Button
                variant="outline"
                size="sm"
                className="ml-auto h-7"
                disabled={decomposing || !goal.trim()}
                onClick={() => void autoDecompose()}
              >
                <IconSparkles size={13} className="mr-1" />
                {decomposing ? t("orch.wizard.decomposing") : t("orch.wizard.autoDecompose")}
              </Button>
              <select
                className={selectCls}
                defaultValue=""
                onChange={(e) => {
                  applyTemplate(e.target.value);
                  e.target.value = "";
                }}
              >
                <option value="">{t("orch.wizard.template")}</option>
                {templates.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>
                    {tpl.name}
                  </option>
                ))}
              </select>
            </div>
            <textarea
              className={cn(inputCls, "min-h-[56px] resize-y")}
              value={goal}
              placeholder={t("orch.wizard.goalPh")}
              onChange={(e) => setGoal(e.target.value)}
            />
          </div>

          {/* 任务列表 */}
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium">{t("orch.wizard.tasks")}</label>
              <span className="text-[0.686em] text-content-subtle">
                {t("orch.wizard.est")} ≈ ${estCost.toFixed(3)}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="ml-auto h-7"
                onClick={() =>
                  setTasks((ts) => [
                    ...ts,
                    { id: nextTaskId(), spec: "", profileId: null, deps: [], reviewOf: null, variantGroup: null, runner: "agent" },
                  ])
                }
              >
                <IconPlus size={13} className="mr-1" /> {t("orch.wizard.addTask")}
              </Button>
            </div>
            {tasks.map((task) => (
              <div key={task.id} className="space-y-1.5 rounded-lg border border-edge bg-surface-muted/40 p-2.5">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[0.686em] font-medium text-content-subtle">{task.id}</span>
                  <select
                    className={cn(selectCls, "ml-auto w-36")}
                    value={task.profileId ?? ""}
                    onChange={(e) => updateTask(task.id, { profileId: e.target.value || null })}
                  >
                    <option value="">{t("orch.wizard.agentNone")}</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.icon} {a.name}
                      </option>
                    ))}
                  </select>
                  <select
                    className={cn(selectCls, "w-24")}
                    value={task.runner}
                    onChange={(e) => updateTask(task.id, { runner: e.target.value as "agent" | "terminal" })}
                  >
                    <option value="agent">{t("orch.wizard.runner.agent")}</option>
                    <option value="terminal">{t("orch.wizard.runner.terminal")}</option>
                  </select>
                  <button
                    onClick={() => setTasks((ts) => ts.filter((x) => x.id !== task.id))}
                    className="rounded p-1 text-content-subtle hover:text-danger"
                  >
                    <IconX size={13} />
                  </button>
                </div>
                <textarea
                  className={cn(inputCls, "min-h-[44px] resize-y")}
                  value={task.spec}
                  placeholder={t("orch.wizard.specPh")}
                  onChange={(e) => updateTask(task.id, { spec: e.target.value })}
                />
                {task.runner === "terminal" && (
                  <Input
                    value={task.terminalCommand ?? ""}
                    placeholder={t("orch.wizard.terminal")}
                    onChange={(e) => updateTask(task.id, { terminalCommand: e.target.value })}
                  />
                )}
                <div className="flex flex-wrap items-center gap-1 text-[0.686em] text-content-subtle">
                  <span>{t("orch.wizard.deps")}:</span>
                  {tasks
                    .filter((x) => x.id !== task.id)
                    .map((x) => {
                      const on = task.deps.includes(x.id);
                      return (
                        <button
                          key={x.id}
                          onClick={() =>
                            updateTask(task.id, {
                              deps: on ? task.deps.filter((d) => d !== x.id) : [...task.deps, x.id],
                            })
                          }
                          className={cn(
                            "rounded-full border px-1.5 py-0.5",
                            on ? "border-accent bg-accent/15 text-accent" : "border-edge",
                          )}
                        >
                          {x.id}
                        </button>
                      );
                    })}
                </div>
              </div>
            ))}
          </div>

          {/* 运行参数 */}
          <div className="grid grid-cols-3 gap-2">
            <label className="space-y-1">
              <span className="text-[0.686em] text-content-subtle">{t("orch.wizard.budget")}</span>
              <Input value={budget} placeholder="0" onChange={(e) => setBudget(e.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-[0.686em] text-content-subtle">{t("orch.wizard.concurrency")}</span>
              <Input
                type="number"
                min={1}
                max={16}
                value={concurrency}
                onChange={(e) => setConcurrency(Math.max(1, Number(e.target.value) || 1))}
              />
            </label>
            <label className="space-y-1">
              <span className="text-[0.686em] text-content-subtle">{t("orch.wizard.worktree")}</span>
              <select
                className={cn(selectCls, "w-full")}
                value={worktreePolicy}
                onChange={(e) => setWorktreePolicy(e.target.value as "auto" | "always_new" | "active_only")}
              >
                <option value="auto">{t("orch.wizard.worktree.auto")}</option>
                <option value="always_new">{t("orch.wizard.worktree.always_new")}</option>
                <option value="active_only">{t("orch.wizard.worktree.active_only")}</option>
              </select>
            </label>
          </div>

          {error && <div className="text-xs text-danger">{error}</div>}

          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void saveAsTemplate()}>
              <IconDeviceFloppy size={13} className="mr-1" /> {t("orch.agents.tplNew")}
            </Button>
            <Button variant="ghost" size="sm" className="ml-auto" onClick={closeOrchWizard}>
              {t("orch.wizard.cancel")}
            </Button>
            <Button size="sm" disabled={creating || tasks.every((x) => !x.spec.trim())} onClick={() => void create()}>
              {t("orch.wizard.create")}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
