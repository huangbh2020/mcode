/**
 * worktree 决策表(docs/orchestration-plan.md §7)。
 *
 * 输入:run 策略 + 项目是否为 git 仓库(agent 角色的工作区偏好已随角色域
 *  退役;auto 策略现在默认本地检出,仅续作节点沿用既有 worktree)。
 * 输出:该 worker 会话的环境意图(envMode + wtStyle)。
 *
 * 决策规则(策略 × 偏好):
 *  - run.worktreePolicy = always_new  → 一律 new worktree(branch 形态)
 *  - run.worktreePolicy = active_only → 一律留在 active 检出
 *  - run.worktreePolicy = auto(默认) → 本地检出(打回续作节点沿用既有
 *    worktree;需要隔离时用户在画布上显式选 always_new)
 *
 * lineage(父/顶层)与 git base(基分支)是两个独立决策 —— 本实现里
 * base 恒为 HEAD(物化时由 worktreeOps 决定),lineage 由 envMode 表达。
 * 审查节点(reviewOf 非空)不越权:不建 worktree,在 active 检出上只读
 * 审查(简报里带实现节点的 worktree 路径供比对)。
 */
import type { OrchestrationRun, TaskNode } from "@contracts/orchestration";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ProjectRepo } from "@main/store/repositories.js";

export interface WorktreeDecision {
  envMode: "local" | "worktree";
  wtStyle: "detached" | "branch";
}

const LOCAL: WorktreeDecision = { envMode: "local", wtStyle: "detached" };
const NEW_BRANCH: WorktreeDecision = { envMode: "worktree", wtStyle: "branch" };

export function decideWorktree(
  run: OrchestrationRun,
  task: TaskNode,
): WorktreeDecision {
  // 终端 worker 不进 git 环境。
  if (task.runner === "terminal") return LOCAL;

  // run 级覆盖(用户在向导里显式选的策略)。
  if (run.worktreePolicy === "always_new") return NEW_BRANCH;
  if (run.worktreePolicy === "active_only") return LOCAL;

  // 审查者不越权:只读审查留在 active 检出。
  if (task.reviewOf) return LOCAL;

  // 打回重做的实现节点:继续在它已有的 worktree 里干(绑定既有检出,
  // 由 dispatcher 写入 worktreePath),这里只决定"意图"。
  if (task.worktreePath) return { envMode: "worktree", wtStyle: "branch" };
  return LOCAL;
}

/** 项目根是否为 git 仓库(非 repo 项目退化为本地,不硬失败)。 */
export function projectIsRepo(projectId: string): boolean {
  const project = ProjectRepo.get(projectId);
  if (!project) return false;
  return existsSync(join(project.path, ".git"));
}
