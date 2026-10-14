import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import {
  isOnboardingFirstVisit,
  isOnboardingWaitingOnSoon,
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
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Circle,
  CircleMinus,
  Clock,
  Eye,
  EyeOff,
  FolderOpen,
  ListChecks,
  Loader2,
  Minus,
  RefreshCw,
  Sparkles,
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
  defaultOpen = false,
}: {
  step: OnboardingStep;
  number: number;
  busy: boolean;
  onSkip: (skipped: boolean) => void;
  onGo: () => void;
  /** No compacto, a orientação do passo mostrado já vem aberta. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
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
  defaultOpen,
}: {
  steps: OnboardingStep[];
  all: OnboardingStep[];
  busyId: string | null;
  onSkip: (step: OnboardingStep, skipped: boolean) => void;
  onGo: () => void;
  defaultOpen?: boolean;
}) {
  return (
    <ul className="flex flex-col divide-y">
      {steps.map((step) => (
        <StepItem
          key={step.id}
          defaultOpen={defaultOpen}
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

/** Bolinha numerada do compacto: feito com check verde, o passo mostrado destacado, o resto aguardando. */
function StepDot({ step, number, selected }: { step: OnboardingStep; number: number; selected: boolean }) {
  const base = "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors";
  if (step.status === "done")
    return (
      <span className={cn(base, "border-emerald-500 bg-emerald-500/15 text-emerald-400", selected && "ring-2 ring-emerald-400/50 ring-offset-2 ring-offset-background")}>
        <Check className="h-4 w-4" />
      </span>
    );
  if (step.status === "skipped")
    return (
      <span className={cn(base, "border-dashed text-muted-foreground", selected && "ring-2 ring-sky-400/50 ring-offset-2 ring-offset-background")}>
        <Minus className="h-4 w-4" />
      </span>
    );
  const attention = step.status === "in_progress" || step.status === "unknown";
  return (
    <span
      className={cn(
        base,
        step.status === "soon" ? "border-dashed text-muted-foreground" : "text-muted-foreground",
        attention && "border-amber-500/60 text-amber-400",
        selected && "border-sky-400 bg-sky-500/15 text-sky-300 ring-2 ring-sky-400/40 ring-offset-2 ring-offset-background",
      )}
    >
      {number}
    </span>
  );
}

function Stepper({
  steps,
  selectedId,
  currentId,
  onSelect,
}: {
  steps: OnboardingStep[];
  selectedId: string | null;
  currentId: string | null;
  onSelect: (id: OnboardingStep["id"]) => void;
}) {
  return (
    <ol data-testid="onboarding-stepper" className="flex items-start">
      {steps.map((step, i) => {
        const title = ONBOARDING_CONTENT[step.id].title;
        const selected = step.id === selectedId;
        return (
          <li key={step.id} className="flex min-w-0 flex-1 items-start last:flex-none">
            <button
              type="button"
              aria-label={`${i + 1}. ${title}: ${STATUS_LABEL[step.status]}`}
              aria-current={step.id === currentId ? "step" : undefined}
              aria-pressed={selected}
              title={`${title} — ${STATUS_LABEL[step.status]}`}
              onClick={() => onSelect(step.id)}
              className="flex w-8 flex-col items-center gap-1 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 sm:w-20"
            >
              <StepDot step={step} number={i + 1} selected={selected} />
              <span
                className={cn(
                  "hidden text-center text-[11px] leading-tight sm:block",
                  selected ? "font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                {title}
              </span>
            </button>
            {i < steps.length - 1 && (
              <span
                aria-hidden
                className={cn("mt-4 h-px min-w-2 flex-1", step.status === "done" ? "bg-emerald-500/60" : "bg-border")}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function ProjectsDirNote({ dir }: { dir: string }) {
  return (
    <p className="flex items-start gap-2 border-t pt-3 text-xs text-muted-foreground">
      <FolderOpen className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 break-words">
        Pasta dos projetos na VPS: <code className="text-foreground">{dir}</code> — definida na instalação, nada a
        fazer.
      </span>
    </p>
  );
}

function summary(steps: OnboardingStep[]): string {
  const count = (pred: (s: OnboardingStep) => boolean) => steps.filter(pred).length;
  const done = count((s) => s.status === "done");
  const skipped = count((s) => s.status === "skipped");
  const soon = count((s) => s.status === "soon");
  const todo = steps.length - done - skipped - soon;
  const parts = [`${done} ${done === 1 ? "feito" : "feitos"}`];
  if (skipped) parts.push(`${skipped} não vou usar`);
  if (todo) parts.push(`${todo} a fazer`);
  if (soon) parts.push(`${soon} em breve no painel`);
  return parts.join(" · ");
}

/** "Domínio do painel e Notificações chegam em breve." */
function soonSentence(steps: OnboardingStep[]): string {
  const titles = steps.filter((s) => s.status === "soon").map((s) => ONBOARDING_CONTENT[s.id].title);
  const names = titles.length > 1 ? `${titles.slice(0, -1).join(", ")} e ${titles[titles.length - 1]}` : titles[0];
  return `${names} ${titles.length > 1 ? "chegam" : "chega"} em breve.`;
}

/**
 * Roteiro "Deixe o painel pronto".
 *  - Dashboard: aberto só no primeiro acesso (isOnboardingFirstVisit);
 *    depois, compacto: números 1 a 5 com a situação de cada passo e a
 *    orientação só do passo atual (ou do número clicado); "Ver todos os
 *    passos" expande a lista no próprio cartão. Quando só falta o que é
 *    "em breve", continua compacto com "Tudo o que dá para fazer agora está
 *    feito…" e "Ocultar até ter novidade" (guardado na conta; o cartão volta
 *    quando um passo chega ou volta a pedir ação). Some de vez com tudo
 *    feito ou "Não vou usar". Sem resposta do servidor, não aparece.
 *  - Configurações: sempre a lista inteira, mesmo com tudo resolvido ou
 *    oculto no Dashboard ("Mostrar no Dashboard" desfaz o ocultar).
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
  const [hiding, setHiding] = useState(false);
  const [showAll, setShowAll] = useState(false);
  /** Passo escolhido nos números do compacto (null = o próximo que pede algo). */
  const [selectedId, setSelectedId] = useState<OnboardingStep["id"] | null>(null);

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

  /** "Ocultar até ter novidade" (true) ou "Mostrar no Dashboard" (false). */
  async function setHidden(hidden: boolean) {
    setHiding(true);
    try {
      setData(
        await apiFetch<OnboardingResponse>("/api/onboarding/hidden", {
          method: "PUT",
          body: JSON.stringify({ hidden }),
        }),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível salvar.");
    } finally {
      setHiding(false);
    }
  }

  const onDashboard = variant === "dashboard" && data !== null && !data.complete && !data.hidden;

  // só depois de saber (carregou ou falhou): enquanto carrega, não decide nada
  useEffect(() => {
    if (data === null && error === null) return;
    onVisibleChange?.(onDashboard);
  }, [data, error, onDashboard, onVisibleChange]);

  if (variant === "dashboard" && !onDashboard) return null;
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
  const resolved = actionable.filter((s) => s.status === "done" || s.status === "skipped").length;
  const compact = variant === "dashboard" && !isOnboardingFirstVisit(data);
  const next = nextOnboardingStep(data.steps);
  const shown = data.steps.find((s) => s.id === selectedId) ?? next;
  // Só falta o que é "em breve": no compacto, a mensagem no lugar do passo.
  const waiting = isOnboardingWaitingOnSoon(data.steps);
  const waitingOnly = compact && waiting && !showAll && !shown;
  const listAll = !waitingOnly && (!compact || showAll || !shown);
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
                ? summary(data.steps)
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
          {compact && (shown || waiting) && (
            <Button variant="outline" size="sm" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
              {showAll ? <ChevronUp className="h-4 w-4" /> : <ListChecks className="h-4 w-4" />}
              {showAll ? (waiting && !shown ? "Recolher a lista" : "Mostrar só o próximo") : "Ver todos os passos"}
            </Button>
          )}
        </div>
      </div>

      {compact ? (
        <Stepper
          steps={data.steps}
          selectedId={listAll ? null : (shown?.id ?? null)}
          currentId={next?.id ?? null}
          onSelect={(id) => {
            setSelectedId(id);
            setShowAll(false);
          }}
        />
      ) : (
        <div className="flex flex-col gap-1.5">
          <Progress value={actionable.length ? (resolved / actionable.length) * 100 : 100} className="h-1.5" />
          <p className="text-xs text-muted-foreground">{summary(data.steps)}</p>
        </div>
      )}

      {data.complete && (
        <p className="flex items-center gap-2 text-sm text-emerald-400">
          <CircleCheck className="h-4 w-4 shrink-0" /> Tudo pronto: nada mais pede a sua ação agora.
        </p>
      )}

      {waiting && (!compact || waitingOnly) && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed px-3 py-3">
          <p data-testid="onboarding-waiting" className="flex min-w-0 items-start gap-2 text-sm">
            <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <span>Tudo o que dá para fazer agora está feito. {soonSentence(data.steps)}</span>
          </p>
          {variant === "dashboard" && (
            <Button variant="outline" size="sm" disabled={hiding} onClick={() => void setHidden(true)}>
              {hiding ? <Loader2 className="h-4 w-4 animate-spin" /> : <EyeOff className="h-4 w-4" />} Ocultar até ter novidade
            </Button>
          )}
        </div>
      )}

      {variant === "settings" && data.hidden && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <p>Este roteiro está oculto no Dashboard até ter novidade.</p>
          <Button variant="outline" size="sm" disabled={hiding} onClick={() => void setHidden(false)}>
            {hiding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />} Mostrar no Dashboard
          </Button>
        </div>
      )}

      {waitingOnly ? null : listAll ? (
        <>
          <StepList steps={data.steps} {...listProps} />
          <ProjectsDirNote dir={data.projectsDir} />
        </>
      ) : (
        <StepList key={shown!.id} steps={[shown!]} defaultOpen {...listProps} />
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </Card>
  );
}
