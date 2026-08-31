import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api.js";
import { Button } from "@renderer/components/ui/button.js";
import { Input } from "@renderer/components/ui/input.js";
import { Dialog } from "@renderer/components/ui/index.js";
import { IconLock } from "@renderer/lib/icons.js";
import type { BrowserAuthRequest } from "@contracts/ipc";
import { useI18n } from "@renderer/lib/i18n/index.js";

/**
 * HTTP Basic Auth prompt for the embedded browser. Shown when a page asks for
 * credentials (main pushes a browser:event "authRequest" and parks the
 * Electron login callback). On submit the answer goes back via
 * browser.authRespond and is used for that request only (nothing is
 * persisted).
 */
export function AuthPromptDialog({
  request,
  onClose,
}: {
  request: BrowserAuthRequest | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (request) {
      setUsername("");
      setPassword("");
    }
  }, [request]);

  if (!request) return null;

  const answer = (u: string, p: string) => {
    void api.browser.authRespond({
      requestId: request.requestId,
      username: u,
      password: p,
    });
    onClose();
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(o) => {
        if (!o) answer("", "");
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="w-[360px] max-w-[90vw] p-4">
          <div className="mb-3 flex items-center gap-2">
            <IconLock size={16} className="text-accent" />
            <Dialog.Title className="text-sm font-semibold text-content">
              {t("browser.authTitle", { host: request.host })}
            </Dialog.Title>
          </div>
          <Dialog.Description className="mb-3 text-xs text-content-muted">
            {t("browser.authDesc", { origin: request.origin })}
          </Dialog.Description>
          <div className="space-y-2">
            <Input
              autoFocus
              placeholder={t("browser.username")}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              spellCheck={false}
            />
            <Input
              type="password"
              placeholder={t("browser.password")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === "Enter" && username) answer(username, password);
              }}
            />
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => answer("", "")}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!username}
              onClick={() => answer(username, password)}
            >
              {t("browser.signIn")}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
