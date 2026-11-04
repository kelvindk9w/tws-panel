import { useEffect, useState } from "react";
import type { SecurityPhaseId } from "@paas/core";
import { CopyButton } from "@/components/CopyButton";
import { Button } from "@/components/ui/button";
import { VPS_ADDRESS_PLACEHOLDER } from "@/lib/terminal-info";
import { Trans, useI18n, type TFunction } from "@/i18n";
import { AlertTriangle, ChevronDown, ChevronRight, Clock } from "lucide-react";

/** O que cada fase mudou no acesso — uma frase, no idioma de quem não é da área. */
function whatChanged(t: TFunction, phase: SecurityPhaseId, user: string | null): string {
  const who = user ?? t("hardening.access.whoDefault");
  switch (phase) {
    case "01":
      return t("hardening.access.changed.01", { who });
    case "02":
      return t("hardening.access.changed.02", { who });
    default:
      return t("hardening.access.changed.other");
  }
}

function secondsUntil(endsAtLocal: number): number {
  return Math.max(0, Math.floor((endsAtLocal - Date.now()) / 1000));
}

/**
 * Segundos que faltam, atualizados a cada segundo.
 *
 * Parte de `remainingMs` — quanto falta medido NO SERVIDOR quando a resposta
 * saiu — e só usa o relógio local para medir o tempo que passou desde então.
 * Antes comparava o prazo absoluto do servidor com o relógio do navegador: com
 * o computador 10 min adiantado, uma janela nova de 5 min já nascia vencida e
 * travava os botões (achado 21). Cada nova resposta do servidor ressincroniza.
 */
function useSecondsLeft(remainingMs: number): number {
  const [endsAtLocal, setEndsAtLocal] = useState(() => Date.now() + remainingMs);
  const [remaining, setRemaining] = useState(() => secondsUntil(endsAtLocal));
  useEffect(() => {
    const ends = Date.now() + remainingMs;
    setEndsAtLocal(ends);
    setRemaining(secondsUntil(ends));
  }, [remainingMs]);
  useEffect(() => {
    const t = setInterval(() => setRemaining(secondsUntil(endsAtLocal)), 1000);
    return () => clearInterval(t);
  }, [endsAtLocal]);
  return remaining;
}

function formatRemaining(remaining: number): string {
  return `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
}

/**
 * "Teste seu acesso agora" das fases que mexem em como se entra na VPS
 * (01 senha do root, 02 SSH, 03 firewall).
 *
 * Feedback da validação real: "abra outra janela" confundia (do navegador? do
 * terminal?), faltava copiar o comando e dizer por que testar a CADA fase, e
 * "Interromper" só parava a tela — a mudança seguia até a janela acabar. Agora:
 * curto na tela (onde, o comando, o que é dar certo, dois botões com
 * consequência clara) e o resto em "Mais detalhes".
 */
export function AccessTestAlert({
  phase,
  phaseTitle,
  user,
  host,
  remainingMs,
  busy,
  onConfirm,
  onUndo,
}: {
  phase: SecurityPhaseId;
  phaseTitle: string;
  /** Usuário não-root do teste; null = desconhecido (não se inventa comando). */
  user: string | null;
  /** Endereço da VPS para o ssh (ou VPS_ADDRESS_PLACEHOLDER). */
  host: string;
  /**
   * Quanto falta para a reversão automática, medido no relógio do servidor
   * (`job.rollbackRemainingMs`). Nunca o prazo absoluto: o relógio do
   * navegador pode estar adiantado ou atrasado.
   */
  remainingMs: number;
  /** Confirmando ou desfazendo: trava os botões. */
  busy: boolean;
  onConfirm: () => void;
  onUndo: () => void;
}) {
  const { t } = useI18n();
  const [details, setDetails] = useState(false);
  const remaining = useSecondsLeft(remainingMs);
  // Prazo acabou: quem decide agora é o servidor (a reversão agendada roda lá).
  // Os botões travam — confirmar a esta altura só daria erro.
  const expired = remaining === 0;
  const command = user ? `ssh ${user}@${host}` : null;

  return (
    <div
      role="alert"
      data-testid="access-test-alert"
      className="flex flex-col gap-4 rounded-xl border-4 border-amber-500 bg-amber-500/15 p-6 text-amber-50 shadow-[0_0_60px_rgba(245,158,11,0.3)]"
    >
      <p className="flex items-center gap-2 text-xl font-bold text-amber-300">
        <AlertTriangle className="h-6 w-6 shrink-0" /> {t("hardening.access.title", { phase, phaseTitle })}
      </p>
      <p className="text-base">{whatChanged(t, phase, user)}</p>

      <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
        <li>
          <Trans k="hardening.access.step1" components={{ b: <strong /> }} />
        </li>
        <li className="flex flex-col gap-1">
          <span>{t("hardening.access.step2.run")}</span>
          {command ? (
            <span className="flex items-center gap-2">
              <code
                data-testid="access-test-command"
                className="flex-1 rounded bg-black/60 px-3 py-2 font-mono text-sm text-emerald-300"
              >
                {command}
              </code>
              <CopyButton text={command} />
            </span>
          ) : (
            <span className="text-amber-200/90">{t("hardening.access.step2.fallback", { host })}</span>
          )}
          {host === VPS_ADDRESS_PLACEHOLDER && (
            <span className="text-amber-200/90">
              {t("hardening.access.step2.placeholder", { placeholder: VPS_ADDRESS_PLACEHOLDER })}
            </span>
          )}
        </li>
        <li>
          <Trans
            k="hardening.access.step3"
            params={{ user: user ?? t("hardening.access.userFallback") }}
            components={{ code: <code className="font-mono" />, b: <strong /> }}
          />
        </li>
      </ol>

      <p className="text-sm text-amber-100/90">
        {t("hardening.access.why")}
      </p>

      {expired ? (
        <p className="flex items-center gap-2 text-sm font-semibold text-amber-200">
          <Clock className="h-4 w-4 shrink-0" /> {t("hardening.access.expired")}
        </p>
      ) : (
        <p className="flex items-center gap-2 text-sm">
          <Clock className="h-4 w-4 shrink-0" />{" "}
          <Trans
            k="hardening.access.countdown"
            params={{ time: formatRemaining(remaining) }}
            components={{
              timer: (children) => (
                <span className={`font-mono font-bold ${remaining < 60 ? "text-red-400" : "text-amber-300"}`}>
                  {children}
                </span>
              ),
            }}
          />
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        <Button size="lg" onClick={onConfirm} disabled={busy || expired} className="bg-amber-500 text-black hover:bg-amber-400">
          {t("hardening.access.confirm")}
        </Button>
        <Button size="lg" variant="outline" onClick={onUndo} disabled={busy || expired}>
          {t("hardening.access.undo")}
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          aria-expanded={details}
          onClick={() => setDetails((v) => !v)}
          className="flex items-center gap-2 text-left text-sm font-medium text-amber-200"
        >
          {details ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          {t("hardening.access.details")}
        </button>
        {details && (
          <div className="flex flex-col gap-2 pl-6 text-sm text-amber-100/85">
            <p>
              <Trans k="hardening.access.details.why" components={{ b: <strong /> }} />
            </p>
            <p>
              <Trans k="hardening.access.details.where" components={{ b: <strong /> }} />
            </p>
            <p>
              <Trans k="hardening.access.details.password" components={{ b: <strong /> }} />
            </p>
            <p>
              <Trans
                k="hardening.access.details.keyName"
                components={{ b: <strong />, code: <code className="font-mono" /> }}
              />
            </p>
            <p>
              <Trans k="hardening.access.details.failed" components={{ b: <strong /> }} />
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
