import { useCallback, useEffect, useRef, useState } from "react";
import {
  SECURITY_PHASES,
  isValidSshPublicKey,
  isValidSshUsername,
  type SecurityJob,
  type SecurityJobStep,
  type SecurityManualCommandsResponse,
  type SecurityPhaseId,
  type SecurityPlan,
  type SecurityScanReport,
} from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock,
  Copy,
  Eye,
  Hourglass,
  KeyRound,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  SkipForward,
  TerminalSquare,
  XCircle,
} from "lucide-react";

interface SecurityStepProps {
  onNext: () => void;
}

type Stage = "scan" | "plan" | "run" | "done";

const TERMINAL: SecurityJob["status"][] = ["success", "failed", "rolled_back"];

// ---------------------------------------------------------------------------
// Estado visual por fase durante a execução
// ---------------------------------------------------------------------------

type PhaseRunStatus = "pending" | "running" | "done" | "error" | "skipped";

interface PhaseUiState {
  status: PhaseRunStatus;
  steps: SecurityJobStep[];
  log: string;
  jobStatus: SecurityJob["status"] | null;
}

const INITIAL_PHASE_UI: PhaseUiState = { status: "pending", steps: [], log: "", jobStatus: null };

function PhaseStatusIcon({ status }: { status: PhaseRunStatus }) {
  switch (status) {
    case "pending":
      return <Hourglass className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="aguardando" />;
    case "running":
      return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-400" aria-label="executando" />;
    case "done":
      return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" aria-label="concluída" />;
    case "error":
      return <XCircle className="h-4 w-4 shrink-0 text-red-400" aria-label="erro" />;
    case "skipped":
      return <SkipForward className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="pulada" />;
  }
}

// ---------------------------------------------------------------------------
// Sub-componentes visuais
// ---------------------------------------------------------------------------

function IndexGauge({ value, source }: { value: number | null; source: string }) {
  const v = value ?? 0;
  const color = v >= 75 ? "text-emerald-400" : v >= 50 ? "text-amber-400" : "text-red-400";
  const ring =
    v >= 75 ? "border-emerald-500/50" : v >= 50 ? "border-amber-500/50" : "border-red-500/50";
  return (
    <div className={`flex h-28 w-28 flex-col items-center justify-center rounded-full border-4 ${ring}`}>
      <span className={`text-3xl font-bold ${color}`}>{value ?? "—"}</span>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {source === "lynis" ? "Lynis Index" : "Índice interno"}
      </span>
    </div>
  );
}

function StatusIcon({ status, severity }: { status: string; severity: string }) {
  if (status === "pass") return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />;
  if (status === "unknown") return <CircleHelp className="h-4 w-4 shrink-0 text-muted-foreground" />;
  return severity === "critical" ? (
    <XCircle className="h-4 w-4 shrink-0 text-red-400" />
  ) : (
    <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  if (severity === "critical") return <Badge variant="destructive">crítico</Badge>;
  if (severity === "warning") return <Badge variant="warning">atenção</Badge>;
  return <Badge variant="secondary">info</Badge>;
}

function JobStatusBadge({ status }: { status: SecurityJob["status"] }) {
  switch (status) {
    case "queued":
    case "running":
      return <Badge variant="secondary">executando…</Badge>;
    case "awaiting_confirmation":
      return <Badge variant="warning">aguardando confirmação</Badge>;
    case "success":
      return <Badge variant="success">concluído</Badge>;
    case "failed":
      return <Badge variant="destructive">falhou</Badge>;
    case "rolled_back":
      return <Badge variant="destructive">revertido</Badge>;
  }
}

/** Countdown regressivo até um deadline ISO. */
function Countdown({ deadline }: { deadline: string }) {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.floor((new Date(deadline).getTime() - Date.now()) / 1000)),
  );
  useEffect(() => {
    const t = setInterval(() => {
      setRemaining(Math.max(0, Math.floor((new Date(deadline).getTime() - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(t);
  }, [deadline]);
  const min = Math.floor(remaining / 60);
  const sec = remaining % 60;
  return (
    <span className={`font-mono text-lg font-bold ${remaining < 60 ? "text-red-400" : "text-amber-400"}`}>
      {min}:{String(sec).padStart(2, "0")}
    </span>
  );
}

/** Botão copiar com feedback. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 px-2"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copiado" : "Copiar"}
    </Button>
  );
}

/** Lista de passos de uma fase (:::PAAS_STEP parseados pelo executor). */
function StepList({ steps }: { steps: SecurityJobStep[] }) {
  if (steps.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {steps.map((s, i) => (
        <li key={i} className="flex items-center gap-2">
          {s.status === "running" && <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" />}
          {s.status === "done" && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />}
          {s.status === "failed" && <XCircle className="h-3.5 w-3.5 text-red-400" />}
          {s.status === "skipped" && <CircleHelp className="h-3.5 w-3.5 text-muted-foreground" />}
          <span className={s.status === "running" ? "text-foreground" : "text-muted-foreground"}>{s.name}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Componente principal
// ---------------------------------------------------------------------------

export function SecurityStep({ onNext }: SecurityStepProps) {
  const [stage, setStage] = useState<Stage>("scan");
  const [error, setError] = useState<string | null>(null);

  // scan
  const [scanning, setScanning] = useState(false);
  const [report, setReport] = useState<SecurityScanReport | null>(null);
  const [expandedPhases, setExpandedPhases] = useState<Set<string>>(new Set());
  const [skippedOpen, setSkippedOpen] = useState(false);

  // plano
  const [plan, setPlan] = useState<SecurityPlan | null>(null);
  const [selected, setSelected] = useState<Set<SecurityPhaseId>>(new Set());

  // fase 01 — chave SSH do operador
  const [sshUser, setSshUser] = useState("deploy");
  const [sshPublicKey, setSshPublicKey] = useState("");

  // modo manual por fase
  const [manualPhases, setManualPhases] = useState<Set<SecurityPhaseId>>(new Set());
  const [manualData, setManualData] = useState<Partial<Record<SecurityPhaseId, SecurityManualCommandsResponse>>>({});
  const [manualVerifying, setManualVerifying] = useState(false);

  // execução
  const [runQueue, setRunQueue] = useState<SecurityPhaseId[]>([]);
  const [runIndex, setRunIndex] = useState(0);
  const [runDry, setRunDry] = useState(true);
  const [job, setJob] = useState<SecurityJob | null>(null);
  const [phaseUi, setPhaseUi] = useState<Partial<Record<SecurityPhaseId, PhaseUiState>>>({});
  const [expandedRunPhases, setExpandedRunPhases] = useState<Set<string>>(new Set());
  const confirmResolver = useRef<((confirmed: boolean) => void) | null>(null);

  // resultado
  const [afterReport, setAfterReport] = useState<SecurityScanReport | null>(null);

  const logRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job?.log]);

  const updatePhaseUi = useCallback((phase: SecurityPhaseId, patch: Partial<PhaseUiState>) => {
    setPhaseUi((prev) => ({ ...prev, [phase]: { ...(prev[phase] ?? INITIAL_PHASE_UI), ...patch } }));
  }, []);

  // -------------------------------------------------------------- scan
  const runScan = useCallback(async (fresh = false) => {
    setScanning(true);
    setError(null);
    try {
      const res = await apiFetch<{ report: SecurityScanReport; cached: boolean }>(
        `/api/security/scan${fresh ? "?fresh=1" : ""}`,
      );
      setReport(res.report);
      return res.report;
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Falha ao executar a varredura.");
      return null;
    } finally {
      setScanning(false);
    }
  }, []);

  // -------------------------------------------------------------- plano
  async function buildPlan() {
    setError(null);
    try {
      const p = await apiFetch<SecurityPlan>("/api/security/plan", { method: "POST", body: "{}" });
      setPlan(p);
      setSelected(new Set(p.actions.filter((a) => a.preselected).map((a) => a.phase)));
      setStage("plan");
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Falha ao gerar o plano.");
    }
  }

  function togglePhase(phase: SecurityPhaseId) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(phase)) next.delete(phase);
      else next.add(phase);
      return next;
    });
  }

  // -------------------------------------------------------------- modo manual
  async function toggleManual(phase: SecurityPhaseId) {
    if (manualPhases.has(phase)) {
      setManualPhases((prev) => {
        const next = new Set(prev);
        next.delete(phase);
        return next;
      });
      return;
    }
    setManualPhases((prev) => new Set(prev).add(phase));
    // fase manual sai da fila de execução automática
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(phase);
      return next;
    });
    if (!manualData[phase]) {
      try {
        const data = await apiFetch<SecurityManualCommandsResponse>(`/api/security/phases/${phase}/manual`);
        setManualData((prev) => ({ ...prev, [phase]: data }));
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : "Falha ao carregar os comandos manuais.");
      }
    }
  }

  /** "Já executei — revarrer": re-roda o scan para validar a fase manual. */
  async function rescanAfterManual() {
    setManualVerifying(true);
    setError(null);
    try {
      const r = await runScan(true);
      if (r) {
        const p = await apiFetch<SecurityPlan>("/api/security/plan", { method: "POST", body: "{}" });
        setPlan(p);
      }
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Falha ao revarrer.");
    } finally {
      setManualVerifying(false);
    }
  }

  // -------------------------------------------------------------- execução
  async function pollJob(phase: SecurityPhaseId, id: string): Promise<SecurityJob> {
    for (;;) {
      const res = await apiFetch<{ job: SecurityJob }>(`/api/security/jobs/${id}`);
      setJob(res.job);
      updatePhaseUi(phase, { steps: res.job.steps, log: res.job.log, jobStatus: res.job.status });
      if (res.job.status === "awaiting_confirmation") {
        // ALERTA DE AÇÃO DO USUÁRIO — bloqueia a continuação até o operador agir
        const confirmed = await new Promise<boolean>((resolve) => {
          confirmResolver.current = resolve;
        });
        confirmResolver.current = null;
        if (!confirmed) return res.job; // usuário pediu para parar
        continue; // re-poll após confirmação
      }
      if (TERMINAL.includes(res.job.status)) return res.job;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  async function runPhases(phases: SecurityPhaseId[], dryRun: boolean): Promise<boolean> {
    setRunQueue(phases);
    setRunDry(dryRun);
    setError(null);
    for (let i = 0; i < phases.length; i += 1) {
      setRunIndex(i);
      const phase = phases[i];
      if (!phase) continue;
      updatePhaseUi(phase, { status: "running", steps: [], log: "", jobStatus: null });
      try {
        const body: Record<string, unknown> = { phase, dryRun };
        if (phase === "01") {
          body["sshUser"] = sshUser.trim() || "deploy";
          if (sshPublicKey.trim() !== "") body["sshPublicKey"] = sshPublicKey.trim();
        }
        const res = await apiFetch<{ job: SecurityJob }>("/api/security/apply", {
          method: "POST",
          body: JSON.stringify(body),
        });
        setJob(res.job);
        const finished = await pollJob(phase, res.job.id);
        if (finished.status !== "success") {
          updatePhaseUi(phase, { status: "error", steps: finished.steps, log: finished.log });
          setError(
            finished.status === "rolled_back"
              ? `A fase "${finished.title}" foi revertida automaticamente (acesso não confirmado a tempo).`
              : `A fase "${finished.title}" falhou. O rollback foi executado — veja o log.`,
          );
          return false;
        }
        updatePhaseUi(phase, { status: "done", steps: finished.steps, log: finished.log });
      } catch (err) {
        updatePhaseUi(phase, { status: "error" });
        setError(err instanceof ApiRequestError ? err.message : "Falha ao aplicar a fase.");
        return false;
      }
    }
    return true;
  }

  async function startExecution() {
    const phases = SECURITY_PHASES.map((p) => p.id).filter((id) => selected.has(id) && !manualPhases.has(id));
    if (phases.length === 0) {
      setError(
        manualPhases.size > 0
          ? "Todas as fases escolhidas estão em modo manual — execute os comandos no servidor e clique em \"Já executei — revarrer\"."
          : "Selecione ao menos uma fase para aplicar.",
      );
      return;
    }
    // estado inicial da lista ao vivo: fila pendente, manuais puladas
    const initial: Partial<Record<SecurityPhaseId, PhaseUiState>> = {};
    for (const id of phases) initial[id] = { ...INITIAL_PHASE_UI };
    for (const id of manualPhases) initial[id] = { ...INITIAL_PHASE_UI, status: "skipped" };
    setPhaseUi(initial);
    setStage("run");
    // 1) dry-run de todas as fases selecionadas
    const dryOk = await runPhases(phases, true);
    if (!dryOk) return;
    // 2) aplicação real exige confirmação explícita do operador
    setJob(null);
  }

  async function startRealApply() {
    // dry-run ok: marca as fases como pendentes de novo para a aplicação real
    setPhaseUi((prev) => {
      const next = { ...prev };
      for (const id of runQueue) next[id] = { ...INITIAL_PHASE_UI };
      return next;
    });
    const ok = await runPhases(runQueue, false);
    if (!ok) return;
    // 3) scan final para comparação antes/depois
    setStage("done");
    const after = await runScan(true);
    setAfterReport(after);
  }

  async function confirmAccess() {
    if (!job) return;
    try {
      await apiFetch("/api/security/confirm-access", {
        method: "POST",
        body: JSON.stringify({ jobId: job.id }),
      });
      confirmResolver.current?.(true);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Falha ao confirmar acesso.");
      confirmResolver.current?.(false);
    }
  }

  function abortExecution() {
    confirmResolver.current?.(false);
  }

  // -------------------------------------------------------------- render
  const phaseTitle = (id: string) => SECURITY_PHASES.find((p) => p.id === id)?.title ?? id;
  const phase01Selected = selected.has("01") && !manualPhases.has("01");
  const sshUserOk = isValidSshUsername(sshUser.trim());
  const sshKeyOk = isValidSshPublicKey(sshPublicKey);
  const sshFormValid = !phase01Selected || (sshUserOk && sshKeyOk);

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold">Segurança</h2>
        <p className="text-sm text-muted-foreground">
          Varredura somente-leitura, plano de correção e hardening em fases — com dry-run, backups e
          rollback automático.
        </p>
      </div>

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {/* ---------------------------------------------------------- SCAN */}
      {stage === "scan" && (
        <>
          {!report && !scanning && (
            <Card>
              <CardHeader className="items-center text-center">
                <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
                  <ShieldCheck className="h-6 w-6" />
                </div>
                <CardTitle>Varredura de segurança</CardTitle>
                <CardDescription className="max-w-md">
                  Executa verificações somente-leitura (SSH, firewall, portas, pacotes, Docker) e, se
                  disponível, o Lynis — nada é alterado no servidor.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex justify-center">
                <Button onClick={() => void runScan(true)}>
                  <Play className="h-4 w-4" /> Iniciar varredura
                </Button>
              </CardContent>
            </Card>
          )}

          {scanning && (
            <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" /> Varrendo o servidor…
            </div>
          )}

          {report && !scanning && (
            <>
              <Card>
                <CardContent className="flex flex-col items-center gap-4 py-6 sm:flex-row sm:justify-around">
                  <IndexGauge value={report.hardeningIndex} source={report.hardeningIndexSource} />
                  <div className="grid grid-cols-3 gap-6 text-center">
                    <div>
                      <p className="text-2xl font-bold text-emerald-400">{report.summary.pass}</p>
                      <p className="text-xs text-muted-foreground">✅ ok</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-amber-400">{report.summary.warning}</p>
                      <p className="text-xs text-muted-foreground">⚠️ atenção</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-red-400">{report.summary.critical}</p>
                      <p className="text-xs text-muted-foreground">❌ crítico</p>
                    </div>
                  </div>
                  <div className="text-center text-xs text-muted-foreground">
                    <p>alvo: {report.target}</p>
                    <p>perfil: {report.profile}</p>
                    <p>{report.summary.total} verificações em {(report.durationMs / 1000).toFixed(1)}s</p>
                    {!report.lynisAvailable && <p>(Lynis ausente — índice interno)</p>}
                  </div>
                </CardContent>
              </Card>

              {/* Nota honesta de contexto: checks pulados no perfil container */}
              {report.profileNote && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200/90">
                  <p className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                    <span>{report.profileNote}</span>
                  </p>
                  {report.skippedChecks.length > 0 && (
                    <button
                      type="button"
                      className="mt-2 flex items-center gap-1 text-xs text-amber-300 underline"
                      onClick={() => setSkippedOpen((v) => !v)}
                    >
                      {skippedOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      {report.skippedChecks.length} check(s) pulados neste perfil
                    </button>
                  )}
                  {skippedOpen && (
                    <ul className="mt-2 flex flex-col gap-1 border-t border-amber-500/20 pt-2 text-xs">
                      {report.skippedChecks.map((s) => (
                        <li key={s.id}>
                          <span className="font-mono text-amber-300">{s.id}</span> — {s.title}
                          <span className="text-amber-200/60"> ({s.reason})</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {SECURITY_PHASES.map((phase) => {
                const checks = report.checks.filter((c) => c.phase === phase.id);
                if (checks.length === 0) return null;
                const fails = checks.filter((c) => c.status === "fail").length;
                const expanded = expandedPhases.has(phase.id);
                return (
                  <Card key={phase.id}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between px-6 py-4 text-left"
                      onClick={() =>
                        setExpandedPhases((prev) => {
                          const next = new Set(prev);
                          if (next.has(phase.id)) next.delete(phase.id);
                          else next.add(phase.id);
                          return next;
                        })
                      }
                    >
                      <span className="flex items-center gap-2 font-medium">
                        {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        Fase {phase.id} — {phase.title}
                      </span>
                      {fails === 0 ? (
                        <Badge variant="success">tudo ok</Badge>
                      ) : (
                        <Badge variant="warning">{fails} pendente(s)</Badge>
                      )}
                    </button>
                    {expanded && (
                      <CardContent className="flex flex-col gap-3 border-t pt-4">
                        {checks.map((c) => (
                          <div key={c.id} className="flex items-start gap-3 text-sm">
                            <StatusIcon status={c.status} severity={c.severity} />
                            <div className="flex-1">
                              <p className="flex flex-wrap items-center gap-2 font-medium">
                                {c.title} <SeverityBadge severity={c.severity} />
                              </p>
                              <p className="text-muted-foreground">{c.description}</p>
                              {c.detail && (
                                <p className="mt-1 font-mono text-xs text-muted-foreground/80">{c.detail}</p>
                              )}
                              {c.status === "fail" && (
                                <p className="mt-1 text-xs text-amber-400">➜ {c.remediation}</p>
                              )}
                            </div>
                          </div>
                        ))}
                      </CardContent>
                    )}
                  </Card>
                );
              })}

              <div className="flex justify-between">
                <Button variant="outline" onClick={() => void runScan(true)}>
                  <RefreshCw className="h-4 w-4" /> Revarrer
                </Button>
                <Button onClick={() => void buildPlan()}>
                  Gerar plano de correção <ArrowRight className="h-4 w-4" />
                </Button>
              </div>
            </>
          )}
        </>
      )}

      {/* ---------------------------------------------------------- PLANO */}
      {stage === "plan" && plan && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShieldAlert className="h-5 w-5" /> Plano de correção
              </CardTitle>
              <CardDescription>
                {plan.actions.filter((a) => !a.alreadySatisfied).length} fase(s) com pendências.
                Fases com findings críticos estão pré-marcadas. Tudo roda primeiro em dry-run.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {plan.actions.map((a) => {
                const isManual = manualPhases.has(a.phase);
                const manual = manualData[a.phase];
                return (
                  <div key={a.id} className="rounded-md border">
                    <label className="flex cursor-pointer items-start gap-3 p-3 hover:bg-secondary/40">
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 accent-emerald-500"
                        checked={selected.has(a.phase)}
                        disabled={isManual}
                        onChange={() => togglePhase(a.phase)}
                      />
                      <div className="flex-1 text-sm">
                        <p className="flex flex-wrap items-center gap-2 font-medium">
                          Fase {a.phase} — {a.title}
                          {a.alreadySatisfied && <Badge variant="success">já ok</Badge>}
                          {a.fixesCheckIds.length > 0 && (
                            <Badge variant="warning">{a.fixesCheckIds.length} correção(ões)</Badge>
                          )}
                          {a.hasRollback && <Badge variant="secondary">com rollback</Badge>}
                          {isManual && <Badge variant="warning">modo manual</Badge>}
                        </p>
                        <p className="text-muted-foreground">{a.description}</p>
                        {a.impact && (
                          <p className="mt-1 flex items-start gap-1 text-xs text-amber-400">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {a.impact}
                          </p>
                        )}
                      </div>
                    </label>
                    {/* Toggle de modo manual por fase */}
                    <div className="flex items-center justify-between border-t px-3 py-2">
                      <span className="text-xs text-muted-foreground">
                        {isManual
                          ? "Você executa esta fase no servidor; o painel só valida depois."
                          : "O painel executa esta fase automaticamente."}
                      </span>
                      <Button variant="ghost" size="sm" className="h-7" onClick={() => void toggleManual(a.phase)}>
                        <TerminalSquare className="h-3.5 w-3.5" />
                        {isManual ? "Voltar ao modo automático" : "Executar manualmente"}
                      </Button>
                    </div>
                    {isManual && (
                      <div className="flex flex-col gap-2 border-t bg-secondary/20 p-3">
                        {!manual ? (
                          <p className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Carregando comandos…
                          </p>
                        ) : (
                          <>
                            <p className="text-xs font-medium text-muted-foreground">
                              Comandos exatos (rode no servidor, na ordem):
                            </p>
                            {manual.commands.map((cmd) => (
                              <div
                                key={cmd}
                                className="flex items-center justify-between gap-2 rounded bg-black/60 px-2 py-1.5"
                              >
                                <code className="break-all font-mono text-xs text-emerald-100/90">{cmd}</code>
                                <CopyButton text={cmd} />
                              </div>
                            ))}
                            {manual.notes.map((n) => (
                              <p key={n} className="text-xs text-amber-300/90">ℹ️ {n}</p>
                            ))}
                            <details className="text-xs">
                              <summary className="cursor-pointer text-muted-foreground">
                                Ver o script completo da fase ({manual.script})
                              </summary>
                              <div className="relative mt-1">
                                <div className="absolute right-1 top-1">
                                  <CopyButton text={manual.scriptContent} />
                                </div>
                                <pre className="max-h-64 overflow-auto rounded bg-black/60 p-2 font-mono text-[11px] text-emerald-100/70">
                                  {manual.scriptContent}
                                </pre>
                              </div>
                            </details>
                            <div className="flex items-center gap-2 pt-1">
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={manualVerifying}
                                onClick={() => void rescanAfterManual()}
                              >
                                {manualVerifying ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <RefreshCw className="h-4 w-4" />
                                )}
                                Já executei — revarrer
                              </Button>
                              {a.alreadySatisfied && (
                                <Badge variant="success">✅ verificado no último scan</Badge>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>

          {/* Fase 01 — chave pública SSH do operador (obrigatória para travar o root) */}
          {phase01Selected && (
            <Card className="border-amber-500/40">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <KeyRound className="h-4 w-4 text-amber-400" /> Fase 01 — sua chave pública SSH
                </CardTitle>
                <CardDescription>
                  Cole a chave pública da SUA máquina (ex.: <code>~/.ssh/id_ed25519.pub</code>). Ela será
                  instalada no novo usuário — a senha do root <strong>só é travada com a chave presente</strong>{" "}
                  (proteção anti-lockout).
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground" htmlFor="ssh-user">
                    Usuário não-root a criar
                  </label>
                  <Input
                    id="ssh-user"
                    value={sshUser}
                    onChange={(e) => setSshUser(e.target.value)}
                    className="h-8 w-48 font-mono"
                    placeholder="deploy"
                  />
                  {!sshUserOk && (
                    <p className="text-xs text-red-400">Nome inválido (minúsculas, sem espaços, nunca root).</p>
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground" htmlFor="ssh-pubkey">
                    Chave pública (ssh-ed25519 ou ssh-rsa)
                  </label>
                  <textarea
                    id="ssh-pubkey"
                    value={sshPublicKey}
                    onChange={(e) => setSshPublicKey(e.target.value)}
                    rows={3}
                    spellCheck={false}
                    placeholder="ssh-ed25519 AAAAC3NzaC… voce@sua-maquina"
                    className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  {sshPublicKey.trim() !== "" && !sshKeyOk && (
                    <p className="text-xs text-red-400">
                      Formato não reconhecido — cole o conteúdo completo do arquivo .pub (uma linha,
                      começando com ssh-ed25519 ou ssh-rsa).
                    </p>
                  )}
                  {sshKeyOk && <p className="text-xs text-emerald-400">✅ Chave válida.</p>}
                </div>
              </CardContent>
            </Card>
          )}

          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStage("scan")}>
              Voltar ao relatório
            </Button>
            <Button onClick={() => void startExecution()} disabled={!sshFormValid}>
              <Eye className="h-4 w-4" /> Executar dry-run das fases selecionadas
            </Button>
          </div>
          {!sshFormValid && (
            <p className="text-right text-xs text-amber-400">
              Cole uma chave pública SSH válida para executar a Fase 01 (ou marque-a como manual).
            </p>
          )}
        </>
      )}

      {/* ---------------------------------------------------------- EXECUÇÃO */}
      {stage === "run" && (
        <>
          {/* ALERTA GRANDE DE AÇÃO DO USUÁRIO — bloqueia a continuação */}
          {job?.status === "awaiting_confirmation" && job.rollbackDeadline && (
            <div className="flex animate-pulse flex-col items-center gap-4 rounded-xl border-4 border-amber-500 bg-amber-500/20 p-8 text-center shadow-[0_0_60px_rgba(245,158,11,0.35)]">
              <AlertTriangle className="h-12 w-12 text-amber-400" />
              <p className="text-2xl font-bold tracking-tight text-amber-300">
                ⚠️ AÇÃO NECESSÁRIA — TESTE SEU ACESSO AGORA
              </p>
              {job.phase === "01" ? (
                <p className="max-w-xl text-base text-amber-100">
                  A fase <strong>{job.title}</strong> criou o usuário{" "}
                  <strong className="font-mono">{job.sshUser ?? sshUser}</strong> e{" "}
                  <strong>travou a senha do root</strong>. Abra{" "}
                  <strong>outra janela SSH</strong> e teste o login com o novo usuário{" "}
                  <strong>ANTES de confirmar</strong>:
                  <code className="mt-2 block rounded bg-black/60 px-3 py-2 font-mono text-sm text-emerald-300">
                    ssh {job.sshUser ?? sshUser}@{window.location.hostname}
                  </code>
                </p>
              ) : (
                <p className="max-w-xl text-base text-amber-100">
                  A fase <strong>{job.title}</strong> alterou SSH/firewall. Abra uma{" "}
                  <strong>nova sessão SSH</strong> (sem fechar a atual) e confirme abaixo. Sem confirmação,
                  a configuração anterior será restaurada automaticamente.
                </p>
              )}
              <div className="flex items-center gap-2 text-amber-200">
                <Clock className="h-5 w-5" />
                <span>Reversão automática em:</span>
                <Countdown deadline={job.rollbackDeadline} />
              </div>
              <div className="flex gap-3">
                <Button variant="outline" size="lg" onClick={abortExecution}>
                  Interromper
                </Button>
                <Button size="lg" className="bg-amber-500 text-black hover:bg-amber-400" onClick={() => void confirmAccess()}>
                  ✅ Testei o acesso — confirmar
                </Button>
              </div>
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {runDry ? <Eye className="h-5 w-5" /> : <ShieldCheck className="h-5 w-5" />}
                {runDry ? "Dry-run (simulação)" : "Aplicando hardening"}
              </CardTitle>
              <CardDescription>
                Fase {Math.min(runIndex + 1, runQueue.length)} de {runQueue.length}
                {job ? ` — ${job.title}` : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <Progress value={(runIndex / Math.max(runQueue.length, 1)) * 100} className="h-1.5" />

              {/* Lista de fases ao vivo com ícone de estado + detalhe expansível */}
              <ul className="flex flex-col gap-1">
                {SECURITY_PHASES.filter((p) => runQueue.includes(p.id) || manualPhases.has(p.id)).map((p) => {
                  const ui = phaseUi[p.id] ?? INITIAL_PHASE_UI;
                  const expanded = expandedRunPhases.has(p.id);
                  const hasDetail = ui.steps.length > 0 || ui.log !== "";
                  return (
                    <li key={p.id} className="rounded-md border">
                      <button
                        type="button"
                        className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm"
                        onClick={() =>
                          hasDetail &&
                          setExpandedRunPhases((prev) => {
                            const next = new Set(prev);
                            if (next.has(p.id)) next.delete(p.id);
                            else next.add(p.id);
                            return next;
                          })
                        }
                      >
                        <PhaseStatusIcon status={ui.status} />
                        <span className={ui.status === "running" ? "font-medium" : "text-muted-foreground"}>
                          Fase {p.id} — {phaseTitle(p.id)}
                        </span>
                        <span className="ml-auto flex items-center gap-2">
                          {ui.status === "pending" && <span className="text-xs text-muted-foreground">aguardando</span>}
                          {ui.status === "skipped" && (
                            <span className="text-xs text-muted-foreground">pulada (modo manual)</span>
                          )}
                          {ui.jobStatus && ui.status === "running" && <JobStatusBadge status={ui.jobStatus} />}
                          {hasDetail &&
                            (expanded ? (
                              <ChevronDown className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            ))}
                        </span>
                      </button>
                      {expanded && hasDetail && (
                        <div className="flex flex-col gap-2 border-t px-3 py-2">
                          <StepList steps={ui.steps} />
                          {ui.log !== "" && (
                            <pre className="max-h-48 overflow-auto rounded bg-black/60 p-2 font-mono text-[11px] text-emerald-100/70">
                              {ui.log}
                            </pre>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>

              {/* Log em tempo real da fase atual — sempre visível */}
              {job && (
                <div className="flex flex-col gap-1">
                  <p className="text-xs text-muted-foreground">
                    Log em tempo real — {job.title} <JobStatusBadge status={job.status} />
                  </p>
                  <pre
                    ref={logRef}
                    className="max-h-72 overflow-auto rounded-md bg-black/60 p-3 font-mono text-xs text-emerald-100/80"
                  >
                    {job.log || "(sem saída ainda)"}
                  </pre>
                </div>
              )}

              {/* Dry-run concluído: pedir confirmação para aplicar de verdade */}
              {!job && !error && (
                <div className="flex flex-col items-center gap-3 py-6 text-center">
                  <CheckCircle2 className="h-10 w-10 text-emerald-400" />
                  <p className="font-medium">Dry-run concluído sem erros.</p>
                  <p className="max-w-md text-sm text-muted-foreground">
                    Agora o hardening será aplicado DE VERDADE no alvo. Cada arquivo alterado terá
                    backup e as fases de SSH/firewall terão rollback automático de 5 minutos.
                  </p>
                  <Button onClick={() => void startRealApply()}>
                    <ShieldCheck className="h-4 w-4" /> Aplicar de verdade
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {job && TERMINAL.includes(job.status) && (
            <div className="flex justify-start">
              <Button variant="outline" onClick={() => setStage("plan")}>
                Voltar ao plano
              </Button>
            </div>
          )}
        </>
      )}

      {/* ---------------------------------------------------------- RESULTADO */}
      {stage === "done" && (
        <>
          <Card>
            <CardHeader className="items-center text-center">
              <ShieldCheck className="mb-2 h-10 w-10 text-emerald-400" />
              <CardTitle>Hardening aplicado</CardTitle>
              <CardDescription>
                Comparação do índice de segurança antes e depois das correções.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col items-center gap-6 sm:flex-row sm:justify-center sm:gap-12">
              <div className="flex flex-col items-center gap-2">
                <span className="text-xs uppercase text-muted-foreground">Antes</span>
                <IndexGauge value={report?.hardeningIndex ?? null} source={report?.hardeningIndexSource ?? "internal"} />
              </div>
              <ArrowRight className="hidden h-6 w-6 text-muted-foreground sm:block" />
              <div className="flex flex-col items-center gap-2">
                <span className="text-xs uppercase text-muted-foreground">Depois</span>
                {afterReport ? (
                  <IndexGauge value={afterReport.hardeningIndex} source={afterReport.hardeningIndexSource} />
                ) : (
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                )}
              </div>
            </CardContent>
          </Card>

          {afterReport && afterReport.summary.critical > 0 && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-400">
              ⚠️ Ainda há {afterReport.summary.critical} finding(s) crítico(s) — alguns exigem ação
              manual (ex.: containers Docker). Revarra e revise o relatório.
            </p>
          )}

          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStage("scan")}>
              Ver relatório completo
            </Button>
            <Button onClick={onNext}>
              Continuar <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
