/**
 * Empty-thread welcome — the centered title shown above the composer on a
 * fresh thread. Kept minimal on purpose: the input box is the visual focus
 * of the home screen, the title just names it.
 *
 * A light fade-up plays once on mount (see `home-fade-up` in styles.css);
 * disabled under prefers-reduced-motion.
 */
import { useI18n } from "@renderer/lib/i18n/index.js";

export interface EmptyThreadWelcomeProps {
  /** Project display name; empty string degrades the title to the plain
   *  "start a new chat" wording. */
  projectName: string;
}

export function EmptyThreadWelcome({ projectName }: EmptyThreadWelcomeProps) {
  const { t } = useI18n();
  return (
    <div className="mb-4 flex animate-[home-fade-up_160ms_ease-out] justify-center">
      <h2 className="text-2xl font-semibold tracking-tight text-content">
        {projectName
          ? t("chatStream.welcome.withProject", { name: projectName })
          : t("chatStream.welcome.title")}
      </h2>
    </div>
  );
}
