import { useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  SECURITY_PHASES,
  isValidSshPublicKey,
  isValidSshUsername,
  type SecurityHistoryResponse,
  type SecurityJob,
  type SecurityJobStep,
  type SecurityManualCommandsResponse,
  type SecurityPhaseId,
  type SecurityPlan,
  type SecurityScanReport,
} from "@paas/core";
import { EMPTY_REAUTH, ReauthFields, reauthPayload, type Reauth } from "@/components/settings/ReauthFields";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { AuthContext } from "@/lib/auth";
import { apiErrorText, formatDateTime, Trans, useI18n, type Key, type TFunction } from "@/i18n";
import {
  capitalize,
  isSudoJobError,
  sudoElevationFailure,
  vpsSshHost,
} from "@/lib/terminal-info";
import { pageLocation } from "@/lib/page-location";
import { TERMINAL_ATTENTION_CLEAR_EVENT, TERMINAL_ATTENTION_EVENT } from "@/components/TerminalPanel";
import { CopyButton } from "@/components/CopyButton";
import { IndexGauge } from "@/components/IndexGauge";
import { ManualPhaseModal } from "@/components/setup/ManualPhaseModal";
import { Phase01Card } from "@/components/setup/Phase01Card";
import { AccessTestAlert } from "@/components/setup/AccessTestAlert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
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
  TrendingDown,
  TrendingUp,
  Minus,
  XCircle,
} from "lucide-react";

interface SecurityStepProps {
  onNext: () => void;
  /** Navegação de volta no wizard (ex.: voltar à Saúde da máquina). */
  onBack?: () => void;
  /**
   * Avisa o wizard qual é o usuário não-root em jogo (detectado na varredura
   * ou escolhido pelo operador), para que o terminal — renderizado FORA deste
   * passo, na SetupPage — possa citá-lo pelo nome. `null` quando ainda não há
   * nome confiável.
   */
  onSshUserDetected?: (user: string | null) => void;
  /**
   * Usuário do terminal escolhido pelo operador NA INSTALAÇÃO
   * (PAAS_TERMINAL_USER, via GET /api/terminal/info). Quando é um nome
   * não-root válido, é a fonte primária do campo da Fase 01 — escolha
   * explícita vence a detecção da varredura, que fica como fallback.
   */
  configuredUser?: string | null;
  /**
   * IP público da VPS (lido pela tela de Saúde). Pelo túnel a página é
   * "localhost", que no computador do operador NÃO é a VPS: é este endereço
   * que entra no comando `ssh` de teste de acesso.
   */
  vpsAddress?: string | null;
  /**
   * "wizard" (padrão): etapa do assistente de instalação. "page": tela de
   * proteções depois do setup — os textos de navegação falam de Segurança, não
   * das etapas do assistente ("Voltar para Saúde da máquina", "Continuar").
   */
  mode?: "wizard" | "page";
}

/** O sudo não executou nada (modo senha) — varredura ou fase interrompida. */
type ElevationError = { context: "scan"; message: string } | { context: "phase"; title: string; message: string };

type Stage = "scan" | "plan" | "run" | "done";

const TERMINAL: SecurityJob["status"][] = ["success", "failed", "rolled_back"];

/** Apaga o alerta pulsante "olhe o terminal" (a espera por ação terminou). */
function clearTerminalAttention() {
  window.dispatchEvent(new CustomEvent(TERMINAL_ATTENTION_CLEAR_EVENT));
}

/** Índice exibido num gauge (antes/depois) — valor + fonte (lynis/interno). */
interface IndexSnapshot {
  index: number | null;
  source: string;
}

/** Intervalo das consultas ao servidor enquanto espera o teste de acesso. */
const AWAITING_POLL_MS = 2_000;

/** Nome da régua de uma nota, para a pessoa saber o que está comparando. */
function scaleLabel(t: TFunction, source: string): string {
  return t(source === "lynis" ? "hardening.scale.lynis" : "hardening.scale.internal");
}

/** Título da fase no idioma da interface (o de @paas/core está em português). */
const PHASE_TITLE_KEYS: Record<string, Key> = {
  "00": "hardening.phaseTitle.00",
  "01": "hardening.phaseTitle.01",
  "02": "hardening.phaseTitle.02",
  "03": "hardening.phaseTitle.03",
  "04": "hardening.phaseTitle.04",
  "05": "hardening.phaseTitle.05",
  "06": "hardening.phaseTitle.06",
  "07": "hardening.phaseTitle.07",
};

function localPhaseTitle(t: TFunction, id: string): string {
  const key = PHASE_TITLE_KEYS[id];
  return key ? t(key) : (SECURITY_PHASES.find((p) => p.id === id)?.title ?? id);
}

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
  const { t } = useI18n();
  switch (status) {
    case "pending":
      return <Hourglass className="h-4 w-4 shrink-0 text-muted-foreground" aria-label={t("hardening.phaseRun.pending")} />;
    case "running":
      return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-amber-400" aria-label={t("hardening.phaseRun.running")} />;
    case "done":
      return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" aria-label={t("hardening.phaseRun.done")} />;
    case "error":
      return <XCircle className="h-4 w-4 shrink-0 text-red-400" aria-label={t("hardening.phaseRun.error")} />;
    case "skipped":
      return <SkipForward className="h-4 w-4 shrink-0 text-muted-foreground" aria-label={t("hardening.phaseRun.skipped")} />;
  }
}

// ---------------------------------------------------------------------------
// Sub-componentes visuais
// ---------------------------------------------------------------------------

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
  const { t } = useI18n();
  if (severity === "critical") return <Badge variant="destructive">{t("hardening.severity.critical")}</Badge>;
  if (severity === "warning") return <Badge variant="warning">{t("hardening.severity.warning")}</Badge>;
  return <Badge variant="secondary">{t("hardening.severity.info")}</Badge>;
}

function JobStatusBadge({ status }: { status: SecurityJob["status"] }) {
  const { t } = useI18n();
  switch (status) {
    case "queued":
    case "running":
      return <Badge variant="secondary">{t("hardening.jobStatus.running")}</Badge>;
    case "awaiting_confirmation":
      return <Badge variant="warning">{t("hardening.jobStatus.awaiting")}</Badge>;
    case "success":
      return <Badge variant="success">{t("hardening.jobStatus.success")}</Badge>;
    case "failed":
      return <Badge variant="destructive">{t("hardening.jobStatus.failed")}</Badge>;
    case "rolled_back":
      return <Badge variant="destructive">{t("hardening.jobStatus.rolledBack")}</Badge>;
  }
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

export function SecurityStep({
  onNext,
  onBack,
  onSshUserDetected,
  configuredUser,
  vpsAddress,
  mode = "wizard",
}: SecurityStepProps) {
  const { t } = useI18n();
  const [stage, setStage] = useState<Stage>("scan");
  const [error, setError] = useState<string | null>(null);
  const [alertWarning, setAlertWarning] = useState<string | null>(null);
  // Falha do sudo fica separada do erro genérico: a mensagem do servidor já
  // diz o que aconteceu e o que fazer, e precisa aparecer inteira.
  const [elevationError, setElevationError] = useState<ElevationError | null>(null);

  // scan
  const [scanning, setScanning] = useState(false);
  const [report, setReport] = useState<SecurityScanReport | null>(null);
  const [expandedPhases, setExpandedPhases] = useState<Set<string>>(new Set());
  const [skippedOpen, setSkippedOpen] = useState(false);

  // plano — FASES OBRIGATÓRIAS: toda fase com pendência executa (00→07);
  // não há exclusão por checkbox. O modo manual por fase é a única
  // alternativa (o operador executa por conta própria e o painel valida).
  const [plan, setPlan] = useState<SecurityPlan | null>(null);

  // fase 01 — chave SSH do operador (o usuário não-root já foi criado no
  // início da instalação, seguindo o README — aqui ele é VALIDADO)
  const [sshUser, setSshUser] = useState("");
  const [sshPublicKey, setSshPublicKey] = useState("");
  // instalar a chave SSH pede senha do painel (+ código do app e, se ligado, o do e-mail), como em Acesso à VPS
  const [keyReauth, setKeyReauth] = useState<Reauth>(EMPTY_REAUTH);
  // Na primeira instalação ainda não há conta nem sessão: o setup token já é a prova e não há senha a pedir.
  const hasSession = useContext(AuthContext) !== null;
  // O operador já mexeu no campo? A partir daí, nenhuma varredura posterior
  // sobrescreve o que ele escreveu/escolheu — a decisão é dele.
  const sshUserTouched = useRef(false);

  // modo manual por fase — modal com passo a passo copiável + revarredura
  const [manualModal, setManualModal] = useState<SecurityPhaseId | null>(null);
  const [manualData, setManualData] = useState<Partial<Record<SecurityPhaseId, SecurityManualCommandsResponse>>>({});
  const [manualVerifying, setManualVerifying] = useState(false);

  // execução
  const [runQueue, setRunQueue] = useState<SecurityPhaseId[]>([]);
  const [runIndex, setRunIndex] = useState(0);
  /** Confirmando ou desfazendo o teste de acesso (trava os botões do alerta). */
  const [accessBusy, setAccessBusy] = useState(false);
  /** Job devolvido pelo "desfazer agora" (encerra a espera com o status real). */
  const undoneJob = useRef<SecurityJob | null>(null);
  const [runDry, setRunDry] = useState(true);
  const [job, setJob] = useState<SecurityJob | null>(null);
  const [phaseUi, setPhaseUi] = useState<Partial<Record<SecurityPhaseId, PhaseUiState>>>({});
  const [expandedRunPhases, setExpandedRunPhases] = useState<Set<string>>(new Set());
  const confirmResolver = useRef<((outcome: boolean | SecurityJob) => void) | null>(null);

  // resultado
  const [afterReport, setAfterReport] = useState<SecurityScanReport | null>(null);

  // "Antes" CONGELADO no momento em que a execução começa (bug: o scan final
  // sobrescrevia `report` e o Antes mudava na tela de resultado — 39 → 49).
  const [beforeSnapshot, setBeforeSnapshot] = useState<IndexSnapshot | null>(null);
  // Retomada após restart do painel: o estado "aplicado" vem do HISTÓRICO
  // persistido no servidor, não de um novo scan/plano/apply.
  const [resumed, setResumed] = useState(false);
  const [resumedAfter, setResumedAfter] = useState<IndexSnapshot | null>(null);
  /** Verificações do histórico do servidor, da mais antiga à mais recente. */
  const [historyScans, setHistoryScans] = useState<IndexSnapshot[]>([]);
  /** "O que isso faz?" do botão de simulação (pedido do dono do produto: recolhido). */
  const [dryRunHelpOpen, setDryRunHelpOpen] = useState(false);
  /**
   * Última aplicação real bem-sucedida de cada fase (histórico + esta sessão).
   * Validação real: a fase 02 era aplicada, o item seguia reprovado e o plano
   * a recomendava de novo como se fosse nova — o operador andava em círculo.
   */
  const [appliedAtByPhase, setAppliedAtByPhase] = useState<Partial<Record<SecurityPhaseId, string>>>({});

  // Ao montar: se o histórico server-side mostra um hardening já aplicado
  // com sucesso (último apply real = success), restaura direto a tela
  // "Hardening aplicado" (antes/depois congelados) com o botão Continuar —
  // sem exigir re-rodar plano/dry-run/apply de fases já satisfeitas.
  useEffect(() => {
    let cancelled = false;
    apiFetch<SecurityHistoryResponse>("/api/security/history")
      .then((h) => {
        if (cancelled) return;
        setHistoryScans(
          h.entries
            .filter((e) => e.kind === "scan" && typeof e.hardeningIndex === "number")
            .sort((a, b) => a.at.localeCompare(b.at))
            .map((e) => ({ index: e.hardeningIndex ?? null, source: e.hardeningIndexSource ?? "internal" })),
        );
        const appliedAt: Partial<Record<SecurityPhaseId, string>> = {};
        for (const e of h.entries) {
          if (e.kind !== "job" || e.dryRun || e.status !== "success" || !e.phase) continue;
          if (!appliedAt[e.phase] || e.at > appliedAt[e.phase]!) appliedAt[e.phase] = e.at;
        }
        setAppliedAtByPhase(appliedAt);
        if (!h.applied) return;
        if (h.applied.beforeIndex !== null) {
          setBeforeSnapshot({ index: h.applied.beforeIndex, source: h.applied.beforeIndexSource ?? "internal" });
        }
        if (h.applied.afterIndex !== null) {
          setResumedAfter({ index: h.applied.afterIndex, source: h.applied.afterIndexSource ?? "internal" });
        }
        setResumed(true);
        setStage("done");
      })
      .catch(() => undefined); // sem histórico acessível — fluxo normal
    return () => {
      cancelled = true;
    };
  }, []);

  // Usuários não-root com sudo DETECTADOS no servidor pela varredura. O campo
  // é opcional no contrato (relatórios antigos, persistidos antes de a
  // detecção existir, não o trazem): undefined vale como lista vazia.
  const detectedSudoUsers = report?.nonRootSudoUsers ?? [];
  const soleDetectedUser = detectedSudoUsers.length === 1 ? detectedSudoUsers[0]! : null;
  // Usuário escolhido na instalação ("root" e nomes inválidos não contam: a
  // Fase 01 é sobre um usuário NÃO-root).
  const configuredSshUser = configuredUser && isValidSshUsername(configuredUser) ? configuredUser : null;

  // Valor inicial do campo, só enquanto ele está INTOCADO:
  //  1) o usuário configurado na instalação (escolha explícita do operador);
  //  2) senão, um único candidato detectado pela varredura — o nome já foi
  //     descoberto no servidor, não faz sentido pedir que seja digitado às
  //     cegas. Havendo dois ou mais, o painel pergunta em vez de chutar.
  const defaultSshUser = configuredSshUser ?? soleDetectedUser;
  useEffect(() => {
    if (sshUserTouched.current || defaultSshUser === null) return;
    setSshUser(defaultSshUser);
  }, [defaultSshUser]);

  // Sobe o nome para a SetupPage, que o repassa ao terminal (renderizado fora
  // deste passo). Só um nome válido viaja — nada de meio-nome sendo digitado.
  useEffect(() => {
    const name = sshUser.trim();
    onSshUserDetected?.(isValidSshUsername(name) ? name : null);
  }, [sshUser, onSshUserDetected]);

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
    setElevationError(null);
    try {
      const res = await apiFetch<{ report: SecurityScanReport; cached: boolean }>(
        `/api/security/scan${fresh ? "?fresh=1" : ""}`,
      );
      setReport(res.report);
      return res.report;
    } catch (err) {
      const sudoMessage = sudoElevationFailure(err);
      if (sudoMessage !== null) setElevationError({ context: "scan", message: sudoMessage });
      else setError(apiErrorText(err, "hardening.error.scan"));
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
      setStage("plan");
    } catch (err) {
      setError(apiErrorText(err, "hardening.error.plan"));
    }
  }

  /** Fases com pendência no plano atual, na ordem 00→06 (execução obrigatória). */
  function pendingPhases(): SecurityPhaseId[] {
    if (!plan) return [];
    const pending = new Set(plan.actions.filter((a) => !a.alreadySatisfied).map((a) => a.phase));
    return SECURITY_PHASES.map((p) => p.id).filter((id) => pending.has(id));
  }

  // -------------------------------------------------------------- modo manual
  /** Abre o modal "Fazer manualmente" e carrega o passo a passo da fase. */
  async function openManual(phase: SecurityPhaseId) {
    setManualModal(phase);
    if (!manualData[phase]) {
      try {
        const data = await apiFetch<SecurityManualCommandsResponse>(`/api/security/phases/${phase}/manual`);
        setManualData((prev) => ({ ...prev, [phase]: data }));
      } catch (err) {
        setError(apiErrorText(err, "hardening.error.manualLoad"));
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
      setError(apiErrorText(err, "hardening.error.rescan"));
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
        // ALERTA DE AÇÃO DO USUÁRIO — bloqueia a continuação até o operador
        // agir; o terminal embutido acende o alerta pulsante "olhe o terminal".
        window.dispatchEvent(new CustomEvent(TERMINAL_ATTENTION_EVENT, { detail: { phase } }));
        const outcome = await new Promise<boolean | SecurityJob>((resolve) => {
          const done = (v: boolean | SecurityJob) => resolve(v);
          confirmResolver.current = done;
          // Continua consultando o servidor enquanto espera o clique: se o
          // prazo acabar, o servidor desfaz a fase e o job sai de
          // "awaiting_confirmation". Antes a tela só esperava o clique e ficava
          // parada em 0:00 (visto na validação real).
          const watch = async () => {
            while (confirmResolver.current === done) {
              await new Promise((r) => setTimeout(r, AWAITING_POLL_MS));
              if (confirmResolver.current !== done) return;
              try {
                const r = await apiFetch<{ job: SecurityJob }>(`/api/security/jobs/${id}`);
                if (confirmResolver.current !== done) return;
                if (r.job.status !== "awaiting_confirmation") done(r.job);
              } catch {
                // falha de rede momentânea: tenta de novo na próxima volta
              }
            }
          };
          void watch();
        });
        confirmResolver.current = null;
        // a espera terminou (confirmou, desfez, ou o prazo acabou): apaga o alerta
        clearTerminalAttention();
        if (typeof outcome !== "boolean") {
          // o servidor encerrou a espera sozinho (prazo esgotado → desfeita)
          setJob(outcome);
          updatePhaseUi(phase, { steps: outcome.steps, log: outcome.log, jobStatus: outcome.status });
          return outcome;
        }
        const confirmed = outcome;
        if (!confirmed) {
          // desfeita pelo operador: o job devolvido pelo servidor já diz "rolled_back"
          const undone = undoneJob.current;
          undoneJob.current = null;
          return undone ?? res.job;
        }
        continue; // re-poll após confirmação
      }
      if (TERMINAL.includes(res.job.status)) {
        // fim da execução (sucesso/falha/rollback): o alerta não pode ficar
        // preso se a janela de confirmação expirou sem ação do operador
        clearTerminalAttention();
        return res.job;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  async function runPhases(phases: SecurityPhaseId[], dryRun: boolean): Promise<boolean> {
    setRunQueue(phases);
    setRunDry(dryRun);
    setError(null);
    setElevationError(null);
    for (let i = 0; i < phases.length; i += 1) {
      setRunIndex(i);
      const phase = phases[i];
      if (!phase) continue;
      updatePhaseUi(phase, { status: "running", steps: [], log: "", jobStatus: null });
      try {
        const body: Record<string, unknown> = { phase, dryRun };
        if (phase === "01") {
          body["sshUser"] = sshUser.trim() || "deploy";
          if (sshPublicKey.trim() !== "") {
            body["sshPublicKey"] = sshPublicKey.trim();
            if (!dryRun && hasSession) {
              if (!keyReauth.password) {
                updatePhaseUi(phase, { status: "pending", steps: [], log: "", jobStatus: null });
                setError(t("access.reauth.forSetupKey"));
                return false;
              }
              Object.assign(body, reauthPayload(keyReauth));
            }
          }
        }
        // Fase 02 com o usuário: PermitRootLogin no + AllowUsers. Sem ele, o
        // root seguia entrando com chave (visto em campo). Nome inválido ou
        // vazio: a fase roda sem, como antes.
        if (phase === "02" && isValidSshUsername(sshUser.trim())) body["sshUser"] = sshUser.trim();
        const res = await apiFetch<{ job: SecurityJob; alertWarning?: string }>("/api/security/apply", {
          method: "POST",
          body: JSON.stringify(body),
        });
        setJob(res.job);
        if (res.alertWarning) setAlertWarning(res.alertWarning);
        const finished = await pollJob(phase, res.job.id);
        if (finished.status !== "success") {
          updatePhaseUi(phase, { status: "error", steps: finished.steps, log: finished.log });
          // O sudo não executou o script: não houve alteração nem rollback —
          // afirmar "o rollback foi executado" aqui seria falso.
          if (finished.status === "failed" && isSudoJobError(finished.error)) {
            setElevationError({ context: "phase", title: finished.title, message: finished.error ?? "" });
            return false;
          }
          setError(
            finished.status === "rolled_back" && finished.log.includes("operador não conseguiu entrar")
              ? t("hardening.error.undone", { title: finished.title })
              : finished.status === "rolled_back"
                ? t("hardening.error.expired", { title: finished.title })
                : t("hardening.error.failed", { title: finished.title }),
          );
          return false;
        }
        updatePhaseUi(phase, { status: "done", steps: finished.steps, log: finished.log });
      } catch (err) {
        updatePhaseUi(phase, { status: "error" });
        // A fase nem começou: o job na tela ainda é o da fase ANTERIOR, e o
        // log dele ("concluído") fazia parecer que tudo seguia — tela travada.
        setJob(null);
        const sudoMessage = sudoElevationFailure(err);
        if (sudoMessage !== null) {
          setElevationError({ context: "phase", title: phaseTitle(phase), message: sudoMessage });
        } else {
          setError(apiErrorText(err, "hardening.error.apply"));
        }
        return false;
      }
    }
    return true;
  }

  async function startExecution(phases?: SecurityPhaseId[]) {
    // padrão: todas as fases com pendência, na ordem 00→06; ou uma fase só
    // (ação principal por fase: "Executar apenas esta fase")
    const queue = phases ?? pendingPhases();
    if (queue.length === 0) {
      setError(t("hardening.error.nothingPending"));
      return;
    }
    // Congela o "Antes" AGORA: o scan final (pós-apply) vai sobrescrever
    // `report`, e o índice pré-hardening não pode mudar depois disso.
    setBeforeSnapshot(
      report ? { index: report.hardeningIndex, source: report.hardeningIndexSource } : null,
    );
    // estado inicial da lista ao vivo: fila pendente
    const initial: Partial<Record<SecurityPhaseId, PhaseUiState>> = {};
    for (const id of queue) initial[id] = { ...INITIAL_PHASE_UI };
    setPhaseUi(initial);
    setStage("run");
    // 1) dry-run das fases selecionadas
    const dryOk = await runPhases(queue, true);
    if (!dryOk) return;
    // 2) aplicação real exige confirmação explícita do operador
    setJob(null);
  }

  /** Nova verificação a partir do resultado salvo: volta ao relatório, atualizado. */
  async function verifyAgain() {
    setStage("scan");
    await runScan(true);
  }

  /** Refaz a simulação inteira do zero (depois de uma fase falhar). */
  async function retryDryRun() {
    setPhaseUi((prev) => {
      const next = { ...prev };
      for (const id of runQueue) next[id] = { ...INITIAL_PHASE_UI };
      return next;
    });
    setJob(null);
    await runPhases(runQueue, true);
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
    const now = new Date().toISOString();
    setAppliedAtByPhase((prev) => ({ ...prev, ...Object.fromEntries(runQueue.map((id) => [id, now])) }));
    // 3) scan final para comparação antes/depois. O resultado salvo de uma
    // aplicação anterior sai de cena: sem isto, a tela mostrava a nota velha
    // (86 → 86) enquanto o Lynis ainda media — parecia que nada tinha mudado.
    setResumed(false);
    setResumedAfter(null);
    setAfterReport(null);
    setStage("done");
    const after = await runScan(true);
    setAfterReport(after);
  }

  /**
   * "Não consegui entrar — desfazer agora": desfaz a fase NA HORA no servidor.
   * Antes existia só "Interromper", que parava a tela e deixava a mudança
   * valendo até a janela de 5 min acabar (visto na validação real).
   */
  async function undoAccess() {
    if (!job) return;
    setAccessBusy(true);
    try {
      const res = await apiFetch<{ job: SecurityJob }>("/api/security/undo-access", {
        method: "POST",
        body: JSON.stringify({ jobId: job.id }),
      });
      undoneJob.current = res.job;
      setJob(res.job); // o alerta sai: a fase não está mais aguardando
      confirmResolver.current?.(false);
    } catch (err) {
      setError(apiErrorText(err, "hardening.error.undo"));
    } finally {
      setAccessBusy(false);
    }
  }

  async function confirmAccess() {
    if (!job) return;
    setAccessBusy(true);
    try {
      await apiFetch("/api/security/confirm-access", {
        method: "POST",
        body: JSON.stringify({ jobId: job.id }),
      });
      setError(null); // apaga o aviso de uma tentativa anterior que falhou
      confirmResolver.current?.(true);
    } catch (err) {
      // Não encerra a espera: uma falha (rede, servidor reiniciando) não diz
      // que a fase foi desfeita — o servidor segue aguardando. O operador
      // tenta de novo, e o vigia de polling continua: se o prazo acabar, é o
      // status do servidor que encerra a espera (achado 20).
      setError(
        err instanceof ApiRequestError
          ? t("hardening.error.confirmRetry", { message: apiErrorText(err, "hardening.error.confirm") })
          : t("hardening.error.confirmNetwork"),
      );
    } finally {
      setAccessBusy(false);
    }
  }

  // -------------------------------------------------------------- render
  const phaseTitle = (id: string) => localPhaseTitle(t, id);
  const phase01Selected = pendingPhases().includes("01");
  // Fase da execução atual que falhou (a execução para nela).
  const failedPhase = runQueue.find((id) => phaseUi[id]?.status === "error") ?? null;
  const sshUserOk = isValidSshUsername(sshUser.trim());
  const sshKeyEmpty = sshPublicKey.trim() === "";
  const sshKeyOk = isValidSshPublicKey(sshPublicKey);
  // A chave é OPCIONAL: sem `--pubkey` o 01-user.sh mantém o authorized_keys
  // que já está no servidor (quem seguiu o README não precisa colá-la de novo).
  // Colar algo malformado, porém, continua bloqueando — o script rejeitaria.
  const sshFormValid = !phase01Selected || (sshUserOk && (sshKeyEmpty || sshKeyOk));
  // "Antes" da tela de resultado: SEMPRE o snapshot congelado (no início da
  // execução ou restaurado do histórico após restart); `report` é só fallback.
  const beforeView: IndexSnapshot | null =
    beforeSnapshot ??
    (report ? { index: report.hardeningIndex, source: report.hardeningIndexSource } : null);
  // Delta antes→depois da tela de resultado (celebra o ganho; null enquanto o
  // scan final não chegou ou o "antes" é desconhecido).
  // Jornada (validação real: a tela mostrava só a ÚLTIMA aplicação — o "antes"
  // virou 79 quando era 42 — e o "depois" antigo mesmo com uma verificação
  // mais nova dizendo outra coisa):
  //  - "Quando a VPS chegou": a primeira verificação de todas;
  //  - "Hoje": a verificação mais recente (a desta sessão, se houver);
  //  - "Última aplicação": antes/depois da última execução, à parte.
  // Diferença em pontos só entre notas da MESMA régua.
  const lastApplyAfter: IndexSnapshot | null = afterReport
    ? { index: afterReport.hardeningIndex, source: afterReport.hardeningIndexSource }
    : resumedAfter;
  const journeyFirst: IndexSnapshot | null = historyScans[0] ?? beforeView;
  const journeyToday: IndexSnapshot | null = afterReport
    ? lastApplyAfter
    : (historyScans.at(-1) ?? lastApplyAfter);
  const sameScale = (a: IndexSnapshot | null, b: IndexSnapshot | null) =>
    a !== null && b !== null && a.index !== null && b.index !== null && a.source === b.source;
  const doneDelta =
    stage === "done" && sameScale(journeyFirst, journeyToday)
      ? (journeyToday!.index as number) - (journeyFirst!.index as number)
      : null;
  const lastApplyDelta = sameScale(beforeView, lastApplyAfter)
    ? (lastApplyAfter!.index as number) - (beforeView!.index as number)
    : null;
  const showLastApply =
    beforeView?.index != null &&
    lastApplyAfter?.index != null &&
    (beforeView.index !== journeyFirst?.index || lastApplyAfter.index !== journeyToday?.index);
  const drifted =
    !afterReport &&
    sameScale(lastApplyAfter, journeyToday) &&
    (journeyToday!.index as number) < (lastApplyAfter!.index as number);

  return (
    <div className="flex animate-fade-in flex-col gap-6">
      <div>
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 mb-1">
            <ArrowLeft className="h-4 w-4" /> {t(mode === "page" ? "hardening.header.backPage" : "hardening.header.backWizard")}
          </Button>
        )}
        <h2 className="text-xl font-semibold tracking-tight">{t("hardening.header.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("hardening.header.subtitle")}
        </p>
      </div>

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {alertWarning && (
        <p role="status" data-testid="alert-warning" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
          {alertWarning}
        </p>
      )}

      {/* Falha do sudo (modo senha): a mensagem do servidor é acionável —
          diz por que nada rodou como root e o que fazer — e vai inteira. */}
      {elevationError && (
        <div
          role="alert"
          data-testid="sudo-elevation-error"
          className="flex flex-col gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
        >
          <p className="flex items-center gap-2 font-semibold text-amber-300">
            <KeyRound className="h-4 w-4 shrink-0" />
            {elevationError.context === "scan"
              ? t("hardening.elevation.scan")
              : t("hardening.elevation.phase", { title: elevationError.title })}
          </p>
          <p>{capitalize(elevationError.message)}</p>
          <p className="text-xs text-amber-200/80">
            {t("hardening.elevation.hint")}
          </p>
          {elevationError.context === "scan" && (
            <div>
              <Button size="sm" variant="outline" onClick={() => void runScan(true)} disabled={scanning}>
                <RefreshCw className="h-3.5 w-3.5" /> {t("hardening.elevation.retry")}
              </Button>
            </div>
          )}
        </div>
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
                <CardTitle>{t("hardening.scan.title")}</CardTitle>
                <CardDescription className="max-w-md">
                  {t("hardening.scan.description")}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex justify-center">
                <Button onClick={() => void runScan(true)}>
                  <Play className="h-4 w-4" /> {t("hardening.scan.start")}
                </Button>
              </CardContent>
            </Card>
          )}

          {scanning && (
            <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" /> {t("hardening.scan.running")}
            </div>
          )}

          {report && !scanning && (
            <>
              <Card>
                <CardContent className="flex flex-col items-center gap-4 py-6 sm:flex-row sm:justify-around">
                  <div className="flex flex-col items-center gap-2">
                    <IndexGauge value={report.hardeningIndex} source={report.hardeningIndexSource} />
                    {report.lynisNote && (
                      <p data-testid="lynis-note" className="max-w-xs text-center text-xs text-amber-300">
                        {report.lynisNote}
                      </p>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-6 text-center">
                    <div>
                      <p className="text-2xl font-bold text-emerald-400">{report.summary.pass}</p>
                      <p className="text-xs text-muted-foreground">{t("hardening.scan.ok")}</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-amber-400">{report.summary.warning}</p>
                      <p className="text-xs text-muted-foreground">{t("hardening.scan.warning")}</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-red-400">{report.summary.critical}</p>
                      <p className="text-xs text-muted-foreground">{t("hardening.scan.critical")}</p>
                    </div>
                  </div>
                  <div className="text-center text-xs text-muted-foreground">
                    <p>{t("hardening.scan.target", { target: report.target })}</p>
                    <p>{t("hardening.scan.profile", { profile: report.profile })}</p>
                    <p>
                      {t("hardening.scan.total", {
                        total: report.summary.total,
                        seconds: (report.durationMs / 1000).toFixed(1),
                      })}
                    </p>
                    {!report.lynisAvailable && <p>{t("hardening.scan.noLynis")}</p>}
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
                      {t("hardening.scan.skipped", { count: report.skippedChecks.length })}
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
                        {t("hardening.phaseLabel", { id: phase.id, title: localPhaseTitle(t, phase.id) })}
                      </span>
                      {fails === 0 ? (
                        <Badge variant="success">{t("hardening.scan.phaseAllOk")}</Badge>
                      ) : (
                        <Badge variant="warning">{t("hardening.scan.phasePending", { count: fails })}</Badge>
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
                  <RefreshCw className="h-4 w-4" /> {t("hardening.scan.again")}
                </Button>
                <Button onClick={() => void buildPlan()}>
                  {t("hardening.scan.buildPlan")} <ArrowRight className="h-4 w-4" />
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
                <ShieldAlert className="h-5 w-5" /> {t("hardening.plan.title")}
              </CardTitle>
              <CardDescription>
                <Trans
                  k="hardening.plan.description"
                  params={{ count: plan.actions.filter((a) => !a.alreadySatisfied).length }}
                  components={{ b: <strong /> }}
                />
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {plan.actions.map((a) => {
                return (
                  <div key={a.id} className="rounded-md border">
                    <div className="flex items-start gap-3 p-3">
                      <div className="flex-1 text-sm">
                        <p className="flex flex-wrap items-center gap-2 font-medium">
                          {t("hardening.phaseLabel", { id: a.phase, title: a.title })}
                          {a.alreadySatisfied && <Badge variant="success">{t("hardening.plan.satisfied")}</Badge>}
                          {a.fixesCheckIds.length > 0 && (
                            <Badge variant="warning">{t("hardening.plan.fixes", { count: a.fixesCheckIds.length })}</Badge>
                          )}
                          {a.hasRollback && <Badge variant="secondary">{t("hardening.plan.rollback")}</Badge>}
                        </p>
                        <p className="text-muted-foreground">{a.description}</p>
                        {a.impact && (
                          <p className="mt-1 flex items-start gap-1 text-xs text-amber-400">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {a.impact}
                          </p>
                        )}
                        {(() => {
                          const appliedAt = appliedAtByPhase[a.phase];
                          const stillFailing = (report?.checks ?? []).filter(
                            (c) => a.fixesCheckIds.includes(c.id) && c.status === "fail",
                          );
                          if (a.alreadySatisfied || !appliedAt || stillFailing.length === 0) return null;
                          return (
                            <div
                              data-testid={`already-applied-${a.phase}`}
                              className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300"
                            >
                              <p>
                                {t("hardening.plan.alreadyApplied", { date: formatDateTime(appliedAt) })}
                              </p>
                              <ul className="mt-1 list-disc pl-5">
                                {stillFailing.map((c) => (
                                  <li key={c.id}>
                                    <strong>{c.title}</strong>
                                    {c.detail ? ` — ${c.detail}` : ""}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                    {/* Ações da fase: principal = executar só ela; secundária = manual */}
                    {!a.alreadySatisfied && (
                      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2">
                        <span className="text-xs text-muted-foreground">
                          {/* A causa do botão desabilitado fica ao lado do botão, não
                              só no rodapé da página (longe demais para ser vista). */}
                          {a.phase === "01" && !sshFormValid ? (
                            <span className="text-amber-400">
                              {t("hardening.plan.phase01Hint")}
                            </span>
                          ) : (
                            <>
                              <Trans k="hardening.plan.dryRunHint" components={{ b: <strong /> }} />
                            </>
                          )}
                        </span>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7"
                            onClick={() => void openManual(a.phase)}
                          >
                            <TerminalSquare className="h-3.5 w-3.5" />
                            {t("hardening.plan.manual")}
                          </Button>
                          <Button
                            size="sm"
                            className="h-7"
                            disabled={a.phase === "01" && !sshFormValid}
                            onClick={() => void startExecution([a.phase])}
                          >
                            <Play className="h-3.5 w-3.5" />
                            {t("hardening.plan.runOne")}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>

          {/* Fase 01 — usuário não-root + chave SSH → desativar a senha do
              root. O card mostra o estado lido pela varredura e o resultado. */}
          {phase01Selected && (
            <Phase01Card
              sshUser={sshUser}
              onSshUserChange={(value) => {
                // a partir do primeiro toque, a varredura não decide mais por
                // ele (nem uma revarredura posterior)
                sshUserTouched.current = true;
                setSshUser(value);
              }}
              sshPublicKey={sshPublicKey}
              onSshPublicKeyChange={setSshPublicKey}
              configuredSshUser={configuredSshUser}
              detectedSudoUsers={detectedSudoUsers}
              report={report}
            />
          )}
          {hasSession && phase01Selected && sshPublicKey.trim() !== "" && (
            <div className="flex max-w-md flex-col gap-3 rounded-md border p-3" data-testid="setup-key-reauth">
              <p className="text-sm text-muted-foreground">{t("access.reauth.forSetupKey")}</p>
              {!configuredSshUser && <p className="text-xs text-amber-400" data-testid="single-user-notice">{t("access.reauth.singleUser")}</p>}
              <ReauthFields idPrefix="sk" action="access.keys" value={keyReauth} onChange={setKeyReauth} />
            </div>
          )}

          <div className="flex flex-col items-end gap-2 sm:flex-row sm:items-start sm:justify-between">
            <Button variant="outline" onClick={() => setStage("scan")}>
              {t("hardening.plan.backToReport")}
            </Button>
            <div className="flex flex-col items-end gap-1">
              <Button onClick={() => void startExecution()} disabled={!sshFormValid}>
                <Eye className="h-4 w-4" /> {t("hardening.plan.simulateAll")}
              </Button>
              {/* O rótulo antigo ("Executar dry-run…") não dizia a um leigo o
                  que o clique faz. A linha abaixo responde à pergunta literal
                  do dono do produto: "se eu clicar, o que acontece?". */}
              <p data-testid="dry-run-resumo" className="max-w-md text-right text-xs text-muted-foreground">
                <Trans k="hardening.plan.dryRunSummary" components={{ b: <strong /> }} />{" "}
                <button
                  type="button"
                  aria-expanded={dryRunHelpOpen}
                  onClick={() => setDryRunHelpOpen((v) => !v)}
                  className="font-medium text-sky-400 underline-offset-2 hover:underline"
                >
                  {t("hardening.plan.dryRunHelp")}
                </button>
              </p>
              {dryRunHelpOpen && (
                <p
                  data-testid="dry-run-explicacao"
                  className="max-w-md text-right text-xs text-muted-foreground"
                >
                  <Trans k="hardening.plan.dryRunExplain" components={{ b: <strong /> }} />
                </p>
              )}
            </div>
          </div>
          {!sshFormValid && (
            <p className="text-right text-xs text-amber-400">
              {t("hardening.plan.invalidForm")}
            </p>
          )}
        </>
      )}

      {/* ---------------------------------------------------------- EXECUÇÃO */}
      {stage === "run" && (
        <>
          {/* ALERTA GRANDE DE AÇÃO DO USUÁRIO — bloqueia a continuação */}
          {job?.status === "awaiting_confirmation" && typeof job.rollbackRemainingMs === "number" && (
            <AccessTestAlert
              phase={job.phase}
              phaseTitle={job.title}
              user={job.sshUser ?? (isValidSshUsername(sshUser.trim()) ? sshUser.trim() : null)}
              host={vpsSshHost(pageLocation(), vpsAddress)}
              remainingMs={job.rollbackRemainingMs}
              busy={accessBusy}
              onConfirm={() => void confirmAccess()}
              onUndo={() => void undoAccess()}
            />
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {runDry ? <Eye className="h-5 w-5" /> : <ShieldCheck className="h-5 w-5" />}
                {t(runDry ? "hardening.run.titleDry" : "hardening.run.titleReal")}
              </CardTitle>
              <CardDescription>
                {failedPhase ? (
                  <>{t("hardening.run.stoppedAt", { id: failedPhase, title: phaseTitle(failedPhase) })}</>
                ) : (
                  <>
                    {job
                      ? t("hardening.run.progressJob", {
                          current: Math.min(runIndex + 1, runQueue.length),
                          total: runQueue.length,
                          title: job.title,
                        })
                      : t("hardening.run.progress", {
                          current: Math.min(runIndex + 1, runQueue.length),
                          total: runQueue.length,
                        })}
                  </>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <Progress value={(runIndex / Math.max(runQueue.length, 1)) * 100} className="h-1.5" />

              {/* Lista de fases ao vivo com ícone de estado + detalhe expansível */}
              <ul className="flex flex-col gap-1">
                {SECURITY_PHASES.filter((p) => runQueue.includes(p.id)).map((p) => {
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
                          {t("hardening.phaseLabel", { id: p.id, title: phaseTitle(p.id) })}
                        </span>
                        <span className="ml-auto flex items-center gap-2">
                          {ui.status === "pending" && <span className="text-xs text-muted-foreground">{t("hardening.run.pending")}</span>}
                          {ui.status === "skipped" && (
                            <span className="text-xs text-muted-foreground">{t("hardening.run.skipped")}</span>
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
                    {t("hardening.run.liveLog", { title: job.title })} <JobStatusBadge status={job.status} />
                  </p>
                  <pre
                    ref={logRef}
                    className="max-h-72 overflow-auto rounded-md bg-black/60 p-3 font-mono text-xs text-emerald-100/80"
                  >
                    {job.log || t("hardening.run.noOutput")}
                  </pre>
                </div>
              )}

              {/* Uma fase falhou: dizer ONDE parou, POR QUÊ e o que fazer —
                  antes, a tela parecia travada (visto em campo). */}
              {failedPhase && (
                <div
                  role="alert"
                  data-testid="run-failed"
                  className="flex flex-col gap-2 rounded-md border border-red-500/50 bg-red-500/10 p-4 text-sm"
                >
                  <p className="flex items-center gap-2 font-semibold text-red-300">
                    <XCircle className="h-4 w-4 shrink-0" />
                    {t(runDry ? "hardening.run.failedDry" : "hardening.run.failedReal", {
                      id: failedPhase,
                      title: phaseTitle(failedPhase),
                    })}
                  </p>
                  {(error ?? elevationError?.message) && (
                    <p className="text-red-100/90">{error ?? elevationError?.message}</p>
                  )}
                  <p className="text-muted-foreground">
                    {t(runDry ? "hardening.run.failedDryNote" : "hardening.run.failedRealNote")}
                  </p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {runDry && (
                      <Button size="sm" onClick={() => void retryDryRun()}>
                        {t("hardening.run.retryDry")}
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => setStage("plan")}>
                      {t("hardening.run.backToPlan")}
                    </Button>
                  </div>
                </div>
              )}

              {/* Dry-run concluído: pedir confirmação para aplicar de verdade */}
              {!job && !error && !elevationError && (
                <div className="flex flex-col items-center gap-3 py-6 text-center">
                  <CheckCircle2 className="h-10 w-10 text-emerald-400" />
                  <p className="font-medium">
                    {t("hardening.run.dryDone")}
                  </p>
                  <p className="max-w-md text-sm text-muted-foreground">
                    <Trans
                      k="hardening.run.dryDoneBody"
                      params={{ count: runQueue.length }}
                      components={{ b: <strong /> }}
                    />
                  </p>
                  <p data-testid="apply-for-real-warning" className="text-sm font-semibold text-emerald-300">
                    {t("hardening.run.realWarning")}
                  </p>
                  <Button className="bg-emerald-600 text-white hover:bg-emerald-500" onClick={() => void startRealApply()}>
                    <ShieldCheck className="h-4 w-4" /> {t("hardening.run.applyReal")}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {job && TERMINAL.includes(job.status) && !failedPhase && (
            <div className="flex justify-start">
              <Button variant="outline" onClick={() => setStage("plan")}>
                {t("hardening.run.backToPlan")}
              </Button>
            </div>
          )}
        </>
      )}

      {/* ---------------------------------------------------------- RESULTADO */}
      {stage === "done" && (
        <>
          <Card className="border-emerald-500/25 bg-[radial-gradient(ellipse_at_top,rgba(52,211,153,0.06),transparent_65%)]">
            <CardHeader className="items-center text-center">
              <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10 shadow-[0_0_32px_rgba(52,211,153,0.18)] ring-1 ring-emerald-500/30 motion-safe:animate-scale-in">
                <ShieldCheck className="h-7 w-7 text-emerald-400" />
              </div>
              <CardTitle className="text-2xl tracking-tight">{t("hardening.done.title")}</CardTitle>
              <CardDescription>
                {t("hardening.done.subtitle")}
              </CardDescription>
            </CardHeader>
            <CardContent
              data-testid="journey"
              className="flex flex-col items-center gap-6 sm:flex-row sm:justify-center sm:gap-12"
            >
              <div className="flex flex-col items-center gap-2.5">
                <span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                  {t("hardening.done.first")}
                </span>
                <div className="opacity-75">
                  <IndexGauge value={journeyFirst?.index ?? null} source={journeyFirst?.source ?? "internal"} />
                </div>
              </div>
              <ArrowRight className="hidden h-6 w-6 text-muted-foreground sm:block" />
              <div className="flex flex-col items-center gap-2.5">
                <span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
                  {t("hardening.done.today")}
                </span>
                {afterReport || resumed ? (
                  <IndexGauge value={journeyToday?.index ?? null} source={journeyToday?.source ?? "internal"} />
                ) : (
                  <div className="flex w-40 flex-col items-center gap-2">
                    <div className="flex h-28 w-28 items-center justify-center">
                      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                    </div>
                    {/* Sem isto, alguns minutos parados pareciam travamento. */}
                    <p data-testid="final-scan-wait" className="text-center text-xs text-muted-foreground">
                      {t("hardening.done.waiting")}
                    </p>
                  </div>
                )}
              </div>
            </CardContent>
            {journeyFirst?.index != null &&
              journeyToday?.index != null &&
              journeyFirst.source !== journeyToday.source && (
                <p data-testid="journey-scales" className="px-6 pb-4 text-center text-xs text-muted-foreground">
                  {t("hardening.done.scales", {
                    first: scaleLabel(t, journeyFirst.source),
                    today: scaleLabel(t, journeyToday.source),
                  })}
                </p>
              )}
            {showLastApply && (
              <p data-testid="last-apply" className="px-6 pb-2 text-center text-xs text-muted-foreground">
                {lastApplyDelta !== null
                  ? t("hardening.done.lastApply", {
                      before: beforeView?.index ?? "",
                      after: lastApplyAfter?.index ?? "",
                      scale: scaleLabel(t, lastApplyAfter?.source ?? "internal"),
                      delta: `${lastApplyDelta >= 0 ? "+" : ""}${lastApplyDelta}`,
                      count: Math.abs(lastApplyDelta),
                    })
                  : t("hardening.done.lastApplyScales", {
                      before: beforeView?.index ?? "",
                      after: lastApplyAfter?.index ?? "",
                      scaleBefore: scaleLabel(t, beforeView?.source ?? "internal"),
                      scaleAfter: scaleLabel(t, lastApplyAfter?.source ?? "internal"),
                    })}
              </p>
            )}
            {drifted && (
              <p data-testid="journey-drift" className="px-6 pb-4 text-center text-xs text-amber-300">
                {t("hardening.done.drift", { after: lastApplyAfter?.index ?? "", today: journeyToday?.index ?? "" })}
              </p>
            )}
            {doneDelta !== null && (
              <div className="flex justify-center pb-6">
                {doneDelta > 0 ? (
                  <Badge variant="success" className="px-3 py-1 text-xs">
                    <TrendingUp className="h-3.5 w-3.5" /> {t("hardening.done.deltaUp", { delta: doneDelta, count: doneDelta })}
                  </Badge>
                ) : doneDelta === 0 ? (
                  <Badge variant="secondary" className="px-3 py-1 text-xs">
                    <Minus className="h-3.5 w-3.5" /> {t("hardening.done.deltaSame")}
                  </Badge>
                ) : (
                  <Badge variant="warning" className="px-3 py-1 text-xs">
                    <TrendingDown className="h-3.5 w-3.5" /> {t("hardening.done.deltaDown", { delta: doneDelta, count: Math.abs(doneDelta) })}
                  </Badge>
                )}
              </div>
            )}
          </Card>

          {/* Diz QUAL item crítico ficou — antes era só "ainda há 1 finding
              crítico", e o operador tinha de caçar no relatório. */}
          {afterReport &&
            afterReport.checks.some((c) => c.severity === "critical" && c.status === "fail") && (
              <div
                data-testid="remaining-critical"
                className="flex flex-col gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-400"
              >
                <p>{t("hardening.done.remaining")}</p>
                <ul className="list-disc pl-5">
                  {afterReport.checks
                    .filter((c) => c.severity === "critical" && c.status === "fail")
                    .map((c) => (
                      <li key={c.id}>
                        <strong>{c.title}</strong>
                        {c.detail ? ` — ${c.detail}` : ""}
                        {c.remediation ? <span className="text-amber-200/80"> ({c.remediation})</span> : null}
                      </li>
                    ))}
                </ul>
              </div>
            )}

          <div className="flex flex-wrap justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              {/* Fora do assistente a tela abre neste resultado salvo: sem este
                  botão não havia como verificar de novo (visto em campo). */}
              <Button variant="outline" onClick={() => void verifyAgain()} disabled={scanning}>
                <RefreshCw className="h-4 w-4" /> {t("hardening.done.verifyAgain")}
              </Button>
              <Button variant="ghost" onClick={() => setStage("scan")}>
                {t("hardening.done.fullReport")}
              </Button>
            </div>
            <Button onClick={onNext}>
              {mode === "page" ? (
                t("hardening.done.backToSecurity")
              ) : (
                <>
                  {t("hardening.done.continue")} <ArrowRight className="h-4 w-4" />
                </>
              )}
            </Button>
          </div>
        </>
      )}

      {/* ---------------------------------------------------------- MODAL MANUAL */}
      {manualModal !== null && (
        <ManualPhaseModal
          title={t("hardening.phaseLabel", { id: manualModal, title: phaseTitle(manualModal) })}
          data={manualData[manualModal] ?? null}
          verifying={manualVerifying}
          satisfied={
            plan?.actions.find((a) => a.phase === manualModal)?.alreadySatisfied ?? false
          }
          onRescan={() => void rescanAfterManual()}
          onClose={() => setManualModal(null)}
        />
      )}
    </div>
  );
}
