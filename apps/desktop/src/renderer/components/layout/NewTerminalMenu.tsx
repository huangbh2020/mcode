/**
 * 「新建终端会话」picker — a thin adapter wrapping NewSessionMenu with
 * showChatOption=false, maintained for backwards compatibility.
 */
import type { ReactNode } from "react";
import { NewSessionMenu } from "./NewSessionMenu.js";

export function NewTerminalMenu({
  projectId,
  disabled,
  triggerTitle,
  triggerClassName,
  children,
  onPick,
}: {
  /** Target project (undefined = the store's active project). */
  projectId?: string;
  disabled?: boolean;
  triggerTitle?: string;
  triggerClassName?: string;
  children: ReactNode;
  /** Override the dispatch (stream view's scoped project). */
  onPick?: (providerId: string) => void;
}) {
  return (
    <NewSessionMenu
      projectId={projectId}
      disabled={disabled}
      triggerTitle={triggerTitle}
      triggerClassName={triggerClassName}
      showChatOption={false}
      onNewTerminalSession={onPick}
    >
      {children}
    </NewSessionMenu>
  );
}
