import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import {
  isOnboardingStepResolved,
  nextOnboardingStep,
  type OnboardingResponse,
  type OnboardingStep,
  type OnboardingStepStatus,
} from "@paas/core";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Circle,
  CircleMinus,
  Clock,
  FolderOpen,
  ListChecks,
  Loader2,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { ONBOARDING_CONTENT } from "./steps-content";

const STATUS_LABEL: Record<OnboardingStepStatus, string> = {
  done: "feito",
  in_progress: "em andamento",
  pending: "a fazer",
  skipped: "não vou usar",
  soon: "em breve",
  unknown: "não confirmado",
};

const STATUS_BADGE: Record<OnboardingStepStatus, "success" | "warning" | "outline" | "secondary"> = {
  done: "success",
  in_progress: "warning",
  pending: "outline",
  skipped: "secondary",
  soon: "secondary",
  unknown: "warning",
};

function StatusIcon({ status }: { status: OnboardingStepStatus }) {
  const cls = "h-5 w-5 shrink-0";
  switch (status) {
    case "done":
      return <CircleCheck className={cn(cls, "text-emerald-400")} />;
    case "in_progress":
      return <CircleDashed className={cn(cls, "text-amber-400")} />;
    case "unknown":
      return <CircleAlert className={cn(cls, "text-amber-400")} />;
    case "skipped":
      return <CircleMinus className={cn(cls, "text-muted-foreground")} />;
    case "soon":
      return <Clock className={cn(cls, "text-muted-foreground")} />;
    case "pending":
      return <Circle className={cn(cls, "text-muted-foreground")} />;
  }
}

/** Passos opcionais que ainda pedem algo podem virar "Não vou usar". */
function canSkip(step: OnboardingStep): boolean {
  return step.optional && (step.status === "pending" || step.status === "in_progress" || step.status === "unknown");
}

function StepItem({
  step,
  number,
  busy,
  onSkip,
  onGo,
}: {
  step: OnboardingStep;
  number: number;
  busy: boolean;
  onSkip: (skipped: boolean) => void;
  onGo: () => void;
}) {
  const [open, setOpen] = useState(false);
  const content = ONBOARDING_CONTENT[step.id];
  const Icon = content.icon;
  const muted = step.status === "soon" || step.status === "skipped";
  return (
    <li data-testid={`onboarding-step-${step.id}`} className="flex gap-3 py-3 first:pt-0 last:pb-0">
      <StatusIcon status={step.status} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn("flex items-center gap-1.5 font-medium", muted && "text-muted-foreground")}>
            <Icon className="h-4 w-4 shrink-0" />
            <span className="text-xs text-muted-foreground">{number}.</span> {content.title}
          </span>
          <Badge variant={STATUS_BADGE[step.status]}>{STATUS_LABEL[step.status]}</Badge>
          {step.optional && step.status !== "skipped" && (
            <span className="text-[11px] text-muted-foreground">opcional</span>
          )}
        </div>
        <p className="break-words text-sm text-muted-foreground">{step.detail}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 h-7 px-2"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            Como fazer
          </Button>
          {canSkip(step) && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-muted-foreground" disabled={busy} onClick={() => onSkip(true)}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Não vou usar
            </Button>
          )}
          {step.status === "skipped" && (
            <Button variant="ghost" size="sm" className="h-7 px-2" disabled={busy} onClick={() => onSkip(false)}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Desfazer
            </Button>
          )}
        </div>
        {open && (
          <div className="flex flex-col gap-3 rounded-md border bg-secondary/30 p-3 text-sm">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">O que é</p>
              <p>{content.whatIs}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Por que importa</p>
              <p>{content.why}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Passo a passo</p>
              <ol className="ml-5 list-decimal space-y-1">
                {content.howTo.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ol>
            </div>
            {content.note && <p className="text-muted-foreground">{content.note}</p>}
            {content.action ? (
              <div>
                <Button size="sm" variant="info" asChild>
                  <Link to={content.action.to} onClick={onGo}>
                    {content.action.label} <ArrowRight className="h-4 w-4" />
                  </Link>
                </Button>
              </div>
            ) : (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="h-3.5 w-3.5" /> Em breve no painel.
              </p>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function StepList({
  steps,
  all,
  busyId,
  onSkip,
  onGo,
}: {
  steps: OnboardingStep[];
  all: OnboardingStep[];
  busyId: string | null;
  onSkip: (step: OnboardingStep, skipped: boolean) => void;
  onGo: () => void;
}) {
  return (
    <ul className="flex flex-col divide-y">
      {steps.map((step) => (
        <StepItem
          key={step.id}
          step={step}
          number={all.indexOf(step) + 1}
          busy={busyId === step.id}
          onSkip={(skipped) => onSkip(step, skipped)}
          onGo={onGo}
        />
      ))}
    </ul>
  );
}

function AllStepsModal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-2 sm:p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Deixe o painel pronto — todos os passos"
        className="flex max-h-[90dvh] w-full max-w-2xl flex-col gap-4 overflow-y-auto rounded-xl border bg-background p-4 shadow-2xl sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Deixe o painel pronto</h2>
            <p className="text-sm text-muted-foreground">Todos os passos, na ordem recomendada.</p>
          </div>
          <Button variant="ghost" size="icon" aria-label="Fechar" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * Roteiro "Deixe o painel pronto".
 *  - Dashboard: aberto até a pessoa começar; depois, compacto (só o próximo
 *    passo, com "Ver todos os passos" numa janela); some quando nada mais
 *    pede ação. Sem resposta do servidor, não aparece.
 *  - Configurações: sempre a lista inteira, mesmo com tudo resolvido.
 */
export function OnboardingChecklist({
  variant,
  onVisibleChange,
}: {
  variant: "dashboard" | "settings";
  /** Avisa se o roteiro ficou na tela (o Dashboard esconde o aviso de 2FA, que repetiria o passo 2). */
  onVisibleChange?: (visible: boolean) => void;
}) {
  const [data, setData] = useState<OnboardingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    setChecking(true);
    try {
      const res = await apiFetch<OnboardingResponse>("/api/onboarding");
      // Resposta fora do formato (servidor antigo, proxy): não afirma nada.
      if (!Array.isArray(res?.steps)) throw new Error("Resposta inesperada do servidor.");
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar.");
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function start() {
    if (data?.started) return;
    try {
      setData(await apiFetch<OnboardingResponse>("/api/onboarding/start", { method: "POST" }));
    } catch {
      // Começar o roteiro é só a forma de exibir; uma falha aqui não impede nada.
    }
  }

  async function skip(step: OnboardingStep, skipped: boolean) {
    setBusyId(step.id);
    try {
      setData(
        await apiFetch<OnboardingResponse>(`/api/onboarding/steps/${step.id}`, {
          method: "PUT",
          body: JSON.stringify({ skipped }),
        }),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível salvar.");
    } finally {
      setBusyId(null);
    }
  }

  // só depois de saber (carregou ou falhou): enquanto carrega, não decide nada
  useEffect(() => {
    if (data === null && error === null) return;
    onVisibleChange?.(variant === "dashboard" && data !== null && !data.complete);
  }, [data, error, variant, onVisibleChange]);

  if (variant === "dashboard" && (!data || data.complete)) return null;
  if (!data) {
    return error ? (
      <p role="alert" className="text-sm text-destructive">
        Não foi possível carregar os primeiros passos: {error}
      </p>
    ) : (
      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
    );
  }

  const actionable = data.steps.filter((s) => s.status !== "soon");
  const resolved = actionable.filter((s) => isOnboardingStepResolved(s.status)).length;
  const soonCount = data.steps.length - actionable.length;
  const compact = variant === "dashboard" && data.started;
  const next = nextOnboardingStep(data.steps);
  const visible = compact && next ? [next] : data.steps;
  const listProps = { all: data.steps, busyId, onSkip: (s: OnboardingStep, v: boolean) => void skip(s, v), onGo: () => void start() };

  return (
    <Card data-testid="onboarding-card" className="flex flex-col gap-4 border-sky-500/30 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sky-500/10 ring-1 ring-sky-500/30">
            <Sparkles className="h-4 w-4 text-sky-400" />
          </div>
          <div className="min-w-0">
            <h2 className="font-semibold tracking-tight">Deixe o painel pronto</h2>
            <p className="text-sm text-muted-foreground">
              {compact
                ? "Próximo passo para deixar o painel seguro e completo."
                : "O que falta configurar depois da instalação, na ordem recomendada. O painel confere sozinho o que já está feito."}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={checking}>
            <RefreshCw className={cn("h-4 w-4", checking && "animate-spin")} /> Conferir de novo
          </Button>
          {variant === "dashboard" && !compact && (
            <Button variant="outline" size="sm" onClick={() => void start()}>
              <ChevronUp className="h-4 w-4" /> Recolher
            </Button>
          )}
          {compact && (
            <Button variant="outline" size="sm" onClick={() => setShowAll(true)}>
              <ListChecks className="h-4 w-4" /> Ver todos os passos
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Progress value={actionable.length ? (resolved / actionable.length) * 100 : 100} className="h-1.5" />
        <p className="text-xs text-muted-foreground">
          {resolved} de {actionable.length} resolvidos
          {soonCount > 0 && ` · ${soonCount} em breve no painel`}
        </p>
      </div>

      {data.complete && (
        <p className="flex items-center gap-2 text-sm text-emerald-400">
          <CircleCheck className="h-4 w-4 shrink-0" /> Tudo pronto: nada mais pede a sua ação agora.
        </p>
      )}

      <StepList steps={visible} {...listProps} />

      {!compact && (
        <p className="flex items-start gap-2 border-t pt-3 text-xs text-muted-foreground">
          <FolderOpen className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">
            Pasta dos projetos na VPS: <code className="text-foreground">{data.projectsDir}</code> — definida na
            instalação, nada a fazer.
          </span>
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {showAll && (
        <AllStepsModal onClose={() => setShowAll(false)}>
          <StepList steps={data.steps} {...listProps} />
          <p className="flex items-start gap-2 border-t pt-3 text-xs text-muted-foreground">
            <FolderOpen className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">
              Pasta dos projetos na VPS: <code className="text-foreground">{data.projectsDir}</code> — definida na
              instalação, nada a fazer.
            </span>
          </p>
        </AllStepsModal>
      )}
    </Card>
  );
}
