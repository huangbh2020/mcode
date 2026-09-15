/**
 * @@agent 角色选择器(Composer 内联 picker)。
 *
 * 触发:输入 `@@` + 查询词(recomputePicker 的双 @ 检测)。锚定在 composer
 * 上方(fixed,FileMentionPicker 同款几何)。选中即加入 @agent 目标簇
 * (OrchComposerChips 渲染 chips;发送时按 移交/编排 模式消费)。
 * 键盘:↑↓ 移动,Enter/Tab 确认,Esc 关闭。
 */
import { useEffect, useRef, useState } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import type { AgentProfile } from "@contracts/orchestration";
import { IconUsers } from "@renderer/lib/icons.js";

export interface AgentPickerProps {
  open: boolean;
  query?: string;
  anchorRect: DOMRect | null;
  onPick: (agent: AgentProfile) => void;
  onClose: () => void;
}

export function AgentPicker({ open, query, anchorRect, onPick, onClose }: AgentPickerProps) {
  const { t } = useI18n();
  const agents = useSessionStore((s) => s.orchAgents);
  const reloadOrchAgents = useSessionStore((s) => s.reloadOrchAgents);
  const [activeIdx, setActiveIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) void reloadOrchAgents();
  }, [open, reloadOrchAgents]);

  const q = (query ?? "").trim().toLowerCase();
  const list = q
    ? agents.filter(
        (a) => a.name.toLowerCase().includes(q) || a.tags.some((tag) => tag.includes(q)) || a.id.toLowerCase().includes(q),
      )
    : agents;

  useEffect(() => {
    if (open) setActiveIdx(0);
  }, [open, q]);

  // Keyboard: ↑↓ / Enter / Tab / Esc (capture beats textarea handlers).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => (list.length === 0 ? 0 : (i + 1) % list.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => (list.length === 0 ? 0 : (i - 1 + list.length) % list.length));
      } else if (e.key === "Enter" || e.key === "Tab") {
        const agent = list[activeIdx];
        if (agent) {
          e.preventDefault();
          e.stopPropagation();
          onPick(agent);
        }
      } else if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, list, activeIdx, onPick, onClose]);

  // Click outside closes.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current && !rootRef.current.contains(target)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onClose]);

  if (!open || !anchorRect) return null;
  const top = Math.max(8, anchorRect.top - 8);
  const left = anchorRect.left;
  const width = Math.min(Math.max(anchorRect.width, 280), 420);

  return (
    <div
      ref={rootRef}
      className="fixed z-[70] flex max-h-64 flex-col overflow-hidden rounded-lg border border-edge bg-surface shadow-xl"
      style={{ left, width, top, transform: "translateY(-100%)" }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="flex items-center gap-1.5 border-b border-edge px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-content-subtle">
        <IconUsers size={11} />
        {t("orch.composer.pickAgent")}
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {agents.length === 0 && (
          <div className="px-2.5 py-2 text-[11px] text-content-subtle">{t("orch.composer.noAgents")}</div>
        )}
        {list.map((agent, idx) => (
          <button
            key={agent.id}
            onMouseEnter={() => setActiveIdx(idx)}
            onClick={() => onPick(agent)}
            className={cn(
              "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs",
              idx === activeIdx ? "bg-surface-hover" : "hover:bg-surface-hover",
            )}
          >
            <span className="text-sm leading-none">{agent.icon || "🤖"}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-content">{agent.name}</span>
              <span className="block truncate text-[10px] text-content-subtle">
                {agent.providerId}/{agent.model} · {agent.tags.join("/")}
                {agent.builtin ? ` · ${t("orch.agents.builtin")}` : ""}
              </span>
            </span>
            {agent.costPerMtok > 0 && (
              <span className="shrink-0 text-[10px] text-content-subtle">${agent.costPerMtok}/M</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
