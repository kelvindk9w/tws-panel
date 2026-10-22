/**
 * Aviso da seção Variáveis: "o e-mail do projeto preenche estas variáveis".
 * Lista as variáveis obrigatórias do compose que têm a ver com e-mail, o estado
 * de cada uma e a ação que cabe: ligar o e-mail do projeto (leva ao cartão),
 * ligar um nome diferente (SMTP_PASSWORD ← SMTP_PASS; só a ligação é guardada,
 * nunca o valor) ou adicionar uma linha manual (SMTP_SECURE=false; sem salvar).
 */
import { useRef, useState } from "react";
import { Link } from "react-router";
import {
  MAX_PROJECT_EMAIL_LINKS,
  type ProjectEmailResponse,
  type ProjectEmailValueKey,
} from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { apiErrorText, Trans, useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import type { EmailAdvice, EmailAdviceItem } from "@/lib/email-env-advice";
import { Link2, Loader2, Mail, Plus } from "lucide-react";

const mono = <span className="font-mono" />;

export function EnvEmailAdvice({
  projectId,
  advice,
  compose,
  links,
  onLinked,
  onAddRow,
}: {
  projectId: string;
  advice: EmailAdvice;
  /** Projeto compose (o e-mail vem por cima no container) ou Dockerfile (o valor salvo vence). */
  compose: boolean;
  /** Ligações GUARDADAS (sem filtro): o PUT troca o mapa inteiro, então parte delas para nada se perder. */
  links: Record<string, ProjectEmailValueKey>;
  onLinked: (links: Record<string, ProjectEmailValueKey>, names: string[]) => void;
  onAddRow: (name: string, value: string) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // segura o clique duplo antes de o estado "busy" chegar à tela
  const inFlight = useRef(false);

  const emailLink = `/projects/${projectId}/email`;
  const { items, suggestions, enabled } = advice;

  async function link(chosen: { name: string; source: ProjectEmailValueKey }[]) {
    if (inFlight.current || chosen.length === 0) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const names = chosen.map((c) => c.name);
    try {
      const next: Record<string, ProjectEmailValueKey> = { ...links };
      for (const c of chosen) next[c.name] = c.source;
      const res = await apiFetch<ProjectEmailResponse>(`/api/projects/${projectId}/email/links`, {
        method: "PUT",
        body: JSON.stringify({ links: next }),
      });
      onLinked(res.email?.envLinks ?? next, names);
    } catch (err) {
      const why = err instanceof ApiRequestError ? apiErrorText(err, "env.email.link.retry") : t("env.email.link.retry");
      setError(`${t("env.email.link.failed", { names: names.join(", ") })} ${why}`);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function stateText(i: EmailAdviceItem): string {
    switch (i.state) {
      case "provided":
        return t("env.email.state.provided");
      case "linked":
        return t("env.email.state.linked", { source: i.source ?? "" });
      case "suggest":
        return t("env.email.state.suggest", { source: i.source ?? "" });
      case "off":
        return t("env.email.state.off");
      case "manual-missing":
        return t("env.email.state.manual");
      case "set":
        return t("env.email.state.set");
      case "unknown":
        return t("env.email.state.unknown");
      default:
        return t("env.email.state.unavailable");
    }
  }

  const missingOff = items.filter((i) => i.state === "off" && i.kind !== "manual").map((i) => i.name);
  const manual = items.filter((i) => i.state === "manual-missing");

  return (
    <div
      data-testid="env-email-advice"
      role="status"
      className="mt-2 rounded-md border border-sky-500/30 bg-sky-500/5 p-3 text-xs"
    >
      <p className="flex items-start gap-2 font-medium text-sky-200">
        <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 [overflow-wrap:anywhere]">{t(items.some((i) => i.kind !== "manual") ? "env.email.title" : "env.email.title.manual")}</span>
      </p>

      {enabled === null && (
        <p className="mt-2 text-muted-foreground [overflow-wrap:anywhere]">
          <Trans
            k="env.email.unreachable"
            components={{
              link: (c) => (
                <Link to={emailLink} className="text-sky-400 underline">
                  {c}
                </Link>
              ),
            }}
          />
        </p>
      )}

      {enabled === false && missingOff.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          <p className="text-muted-foreground [overflow-wrap:anywhere]">
            <Trans
              k="env.email.off.intro"
              params={{ names: missingOff.join(", ") }}
              components={{ mono }}
            />
          </p>
          <div>
            <Button asChild size="sm" variant="success">
              <Link to={emailLink}>
                <Mail className="h-3.5 w-3.5" /> {t("env.email.off.button")}
              </Link>
            </Button>
          </div>
        </div>
      )}

      {enabled === true && (
        <p className="mt-2 text-muted-foreground [overflow-wrap:anywhere]">{t("env.email.on.intro")}</p>
      )}

      <ul className="mt-2 flex flex-col gap-1">
        {items.map((i) => (
          <li
            key={i.name}
            data-testid={`env-email-item-${i.name}`}
            className="flex flex-wrap items-baseline gap-x-2 [overflow-wrap:anywhere]"
          >
            <span className="font-mono text-foreground">{i.name}</span>
            <span
              className={
                i.state === "provided" || i.state === "linked" || i.state === "set"
                  ? "text-emerald-300"
                  : "text-amber-300"
              }
            >
              {stateText(i)}
            </span>
            {i.state === "manual-missing" && (
              <span className="basis-full text-muted-foreground">
                {i.value !== undefined ? (
                  <Trans
                    k="env.email.manual.hint"
                    params={{ name: i.name, value: i.value }}
                    components={{ mono }}
                  />
                ) : (
                  <Trans k="env.email.manual.generic" params={{ name: i.name }} components={{ mono }} />
                )}
              </span>
            )}
          </li>
        ))}
      </ul>

      {items
        .filter((i) => i.collision)
        .map((i) => (
          <p
            key={i.name}
            data-testid={`env-email-collision-${i.name}`}
            className="mt-2 text-amber-300 [overflow-wrap:anywhere]"
          >
            {i.state === "linked"
              ? t("env.email.collision.linked", { name: i.name, source: i.source ?? "" })
              : t(compose ? "env.email.collision.direct" : "env.email.collision.directDockerfile", { name: i.name })}
          </p>
        ))}

      {suggestions.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-muted-foreground [overflow-wrap:anywhere]">
            {t("env.email.link.preview", {
              pairs: suggestions.map((s) => `${s.name} ← ${s.source}`).join(", "),
            })}
          </p>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <Button
                key={s.name}
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                className="h-auto min-h-8 max-w-full whitespace-normal py-1 text-left [overflow-wrap:anywhere]"
                onClick={() => void link([s])}
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5 shrink-0" />}
                {t("env.email.link.one", { name: s.name, source: s.source })}
              </Button>
            ))}
            {suggestions.length > 1 && (
              <Button type="button" size="sm" variant="success" disabled={busy} onClick={() => void link(suggestions)}>
                <Link2 className="h-3.5 w-3.5" /> {t("env.email.link.all", { count: suggestions.length })}
              </Button>
            )}
          </div>
        </div>
      )}
      {advice.overLimit && (
        <p className="mt-2 text-amber-300">{t("env.email.link.limit", { max: MAX_PROJECT_EMAIL_LINKS })}</p>
      )}

      {manual.some((i) => i.value !== undefined) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {manual
            .filter((i) => i.value !== undefined)
            .map((i) => (
              <Button
                key={i.name}
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onAddRow(i.name, i.value!)}
              >
                <Plus className="h-3.5 w-3.5" />
                {t("env.email.manual.add", { name: i.name, value: i.value! })}
              </Button>
            ))}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-red-300 [overflow-wrap:anywhere]">
          {error}
        </p>
      )}

      {enabled === true && (
        <p className="mt-2 text-muted-foreground">
          <Trans
            k="env.email.on.help"
            components={{
              link: (c) => (
                <Link to={emailLink} className="text-sky-400 underline">
                  {c}
                </Link>
              ),
            }}
          />
        </p>
      )}
    </div>
  );
}
