import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Variable } from "lucide-react";
import { Trans, useI18n } from "@/i18n";

/**
 * O servidor recusou o deploy (422 missing_env): o compose exige variáveis
 * que ainda não têm valor. Mostra quais e leva direto para preencher.
 */
export function MissingEnvModal({
  projectId,
  missing,
  onClose,
}: {
  projectId: string;
  missing: string[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const fromMail = missing.filter((m) => m.startsWith("SMTP_") || m === "MAIL_FROM");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div
        role="dialog"
        aria-modal="true"
        data-testid="missing-env"
        className="flex w-full max-w-lg flex-col gap-4 rounded-xl border border-amber-500/40 bg-background p-6 shadow-2xl"
      >
        <h2 className="flex items-center gap-2 text-lg font-semibold text-amber-300">
          <Variable className="h-5 w-5" /> {t("projects.missingEnv.title", { count: missing.length })}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("projects.missingEnv.intro")}
        </p>
        <ul className="flex flex-wrap gap-1.5">
          {missing.map((m) => (
            <li key={m} className="rounded border border-red-500/40 px-2 py-0.5 font-mono text-xs text-red-300">
              {m}
            </li>
          ))}
        </ul>
        {fromMail.length > 0 && (
          <p className="text-sm text-muted-foreground">
            <Trans
              k="projects.missingEnv.fromMail"
              params={{ vars: fromMail.join(", ") }}
              components={{
                link: (c) => (
                  <Link to={`/projects/${projectId}/email`} onClick={onClose} className="text-sky-400 underline">
                    {c}
                  </Link>
                ),
              }}
            />
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t("projects.missingEnv.close")}
          </Button>
          <Button asChild size="sm">
            <Link to={`/projects/${projectId}/env`} onClick={onClose}>
              {t("projects.missingEnv.goEnv")}
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
