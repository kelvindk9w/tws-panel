/**
 * onboarding.ts — status dos passos do roteiro "Deixe o painel pronto"
 * (Dashboard), calculado do estado REAL que o painel já conhece.
 *
 * Cada passo tem uma "conferência" (OnboardingCheck). As de domínio do painel
 * e de notificações dizem "em breve": essas funcionalidades ainda não existem.
 * Para plugar uma delas depois, basta trocar a conferência em
 * createOnboardingChecks por uma que leia o estado novo — a rota, o Dashboard
 * e o texto "Como fazer" não mudam de forma (ver
 * comoFuncionaSistema/configuracoes/roteiro-primeiros-passos.json).
 */
import {
  ONBOARDING_STEP_IDS,
  OPTIONAL_ONBOARDING_STEPS,
  SECURITY_PHASES,
  isOnboardingComplete,
  type OnboardingResponse,
  type OnboardingStep,
  type OnboardingStepId,
  type OnboardingStepStatus,
  type SecurityHistoryEntry,
  type SecurityPhaseId,
  type SecurityScanReport,
} from "@paas/core";
import { buildSecurityPlan } from "@paas/security";
import type { ServerConfig } from "../config.js";
import { loadLastSecurityReport, loadSecurityHistory } from "./security-service.js";
import type { PanelDomainFacts } from "./panel-domain.js";
import type { StoredOnboarding, UserStore } from "./user-store.js";

/** Resultado de uma conferência ("Não vou usar" é aplicado depois, pela conta). */
export interface StepState {
  status: Exclude<OnboardingStepStatus, "skipped">;
  detail: string;
}

export interface OnboardingContext {
  userId: string;
  /** Nome com que a página foi aberta (Host do pedido) — passo do domínio do painel. */
  host?: string;
}

export type OnboardingCheck = (ctx: OnboardingContext) => Promise<StepState>;
export type OnboardingChecks = Record<OnboardingStepId, OnboardingCheck>;

// ---------------------------------------------------------------------------
// Passo 1 — proteções da VPS (hardening)
// ---------------------------------------------------------------------------

function indexLabel(report: SecurityScanReport | null): string | null {
  if (!report || typeof report.hardeningIndex !== "number") return null;
  return report.hardeningIndexSource === "lynis"
    ? `nota do Lynis ${report.hardeningIndex}`
    : `nota interna ${report.hardeningIndex}`;
}

/**
 * Uma fase está resolvida quando foi aplicada de verdade com sucesso (mesmo
 * que alguma checagem dela continue reprovada — caso da Contabo, em que um
 * arquivo do provedor vence a configuração; reaplicar não resolve) ou quando
 * a última varredura não aponta nada a corrigir nela. Sem varredura nenhuma,
 * só vale o que foi aplicado.
 */
export function hardeningState(report: SecurityScanReport | null, history: SecurityHistoryEntry[]): StepState {
  const applied = new Set<SecurityPhaseId>(
    history
      .filter((e) => e.kind === "job" && e.dryRun === false && e.status === "success" && e.phase)
      .map((e) => e.phase as SecurityPhaseId),
  );
  if (!report && applied.size === 0) {
    return {
      status: "pending",
      detail: "O painel ainda não conferiu a VPS. A varredura mostra o que falta proteger.",
    };
  }
  const plan = report ? buildSecurityPlan(report) : null;
  const pending = SECURITY_PHASES.filter((phase) => {
    if (applied.has(phase.id)) return false;
    if (!plan) return true;
    const action = plan.actions.find((a) => a.phase === phase.id);
    return (action?.fixesCheckIds.length ?? 0) > 0;
  });
  const total = SECURITY_PHASES.length;
  const resolved = total - pending.length;
  const nota = indexLabel(report);
  if (pending.length === 0) {
    return { status: "done", detail: [`Todas as ${total} fases resolvidas`, nota].filter(Boolean).join(" · ") + "." };
  }
  const parts = [
    `${resolved} de ${total} fases resolvidas`,
    nota,
    `falta: ${pending.map((p) => p.title).join(", ")}`,
  ];
  return { status: resolved > 0 ? "in_progress" : "pending", detail: parts.filter(Boolean).join(" · ") + "." };
}

// ---------------------------------------------------------------------------
// Passo 2 — verificação em duas etapas
// ---------------------------------------------------------------------------

export function twoFactorState(enabled: boolean): StepState {
  return enabled
    ? { status: "done", detail: "Ativa: entrar no painel pede também o código do celular." }
    : { status: "pending", detail: "Desligada: o painel está na internet e protegido só pela senha." };
}

// ---------------------------------------------------------------------------
// Passo 3 — domínio do painel
// ---------------------------------------------------------------------------

/**
 * Configurações → Domínio do painel (services/panel-domain.ts). Feito quando
 * a pessoa abre o painel pelo domínio novo com certificado válido — com o
 * acesso pelo IP desativado, ou ainda ativo (feito com aviso: desativar é
 * a última camada, e quem prefere manter o endereço de reserva não fica com
 * o cartão aberto para sempre). Túnel: feito — o painel não tem endereço na
 * internet, então não há IP exposto no nome.
 */
export function panelDomainState(facts: PanelDomainFacts): StepState {
  const ip = facts.ipAddress;
  if (!ip) {
    return {
      status: "done",
      detail: "Acesso só por túnel SSH: o painel não tem endereço na internet. Para usar um domínio, veja Configurações → Domínio do painel.",
    };
  }
  if (!ip.endsWith(".sslip.io")) {
    return { status: "done", detail: `O painel abre em https://${ip}.` };
  }
  const d = facts.domain;
  if (!d) {
    return { status: "pending", detail: `Hoje o painel abre em https://${ip} — o endereço atual tem o IP da VPS no nome.` };
  }
  if (!facts.active) {
    return { status: "in_progress", detail: `${d} cadastrado; falta o DNS apontar para a VPS (registro A) e clicar em "Verificar DNS".` };
  }
  if (!facts.certificateValid) {
    return { status: "in_progress", detail: `DNS de ${d} certo; falta o certificado HTTPS ficar válido (Configurações → Domínio do painel).` };
  }
  if (facts.ipAccessDisabled) {
    return { status: "done", detail: `O painel abre em https://${d}; o acesso pelo IP está desativado.` };
  }
  if (!facts.openedViaDomain) {
    return { status: "in_progress", detail: `Certificado pronto: abra o painel por https://${d} e entre de novo.` };
  }
  return {
    status: "done",
    detail: `O painel abre em https://${d} · acesso pelo IP ainda ativo (dá para desativar em Configurações → Domínio do painel).`,
  };
}

/** Sem a fonte do domínio (testes, túnel): só o endereço da instalação. */
function installFacts(panelDomain: string | null): PanelDomainFacts {
  return { ipAddress: panelDomain, domain: null, active: false, certificateValid: false, ipAccessDisabled: false, openedViaDomain: false };
}

// ---------------------------------------------------------------------------
// Passo 4 — e-mail do servidor (opcional)
// ---------------------------------------------------------------------------

export interface EmailFacts {
  /** O servidor de e-mail já foi criado alguma vez. */
  installed: boolean;
  /** Está ligado agora; null = não deu para conferir. */
  running: boolean | null;
  /** Domínios de e-mail; dnsOk = última verificação de DNS toda certa (null = nunca verificado). */
  domains: Array<{ name: string; dnsOk: boolean | null }>;
}

/**
 * DNS do domínio de e-mail conferido: os registros do domínio certos (A, MX,
 * SPF, DKIM, DMARC). O PTR fica de fora — é recomendação e às vezes fica "não
 * deu para conferir" quando o DNS demora (validação real, 07/10/2026).
 * Verificação antiga, sem `recordsOk`: tudo certo, como antes. null = nunca.
 */
export function domainDnsOk(
  lastVerify: { at: string; ok: number; total: number; recordsOk?: boolean } | null,
): boolean | null {
  if (!lastVerify) return null;
  if (typeof lastVerify.recordsOk === "boolean") return lastVerify.recordsOk;
  return lastVerify.total > 0 && lastVerify.ok === lastVerify.total;
}

export function emailState(facts: EmailFacts): StepState {
  const names = facts.domains.map((d) => d.name).join(", ");
  if (!facts.installed && facts.domains.length === 0) {
    return { status: "pending", detail: "Servidor de e-mail não iniciado e nenhum domínio de e-mail cadastrado." };
  }
  if (!facts.installed) {
    return { status: "in_progress", detail: `Domínio ${names} cadastrado, mas o servidor de e-mail não foi iniciado.` };
  }
  if (facts.running === null) {
    return { status: "unknown", detail: "Não foi possível conferir se o servidor de e-mail está ligado." };
  }
  if (!facts.running) {
    return { status: "in_progress", detail: "O servidor de e-mail está parado." };
  }
  if (facts.domains.length === 0) {
    return { status: "in_progress", detail: "Servidor ligado; falta adicionar um domínio de e-mail." };
  }
  const semDns = facts.domains.filter((d) => d.dnsOk !== true);
  if (semDns.length === facts.domains.length) {
    return {
      status: "in_progress",
      detail: `Servidor ligado; falta conferir o DNS de ${semDns.map((d) => d.name).join(", ")}.`,
    };
  }
  return { status: "done", detail: `Servidor ligado · ${names}.` };
}

// ---------------------------------------------------------------------------
// Passo 5 — notificações (em breve)
// ---------------------------------------------------------------------------

/** Aviso fora do painel (Telegram, e-mail) ainda não existe. */
export function notificationsState(): StepState {
  return {
    status: "soon",
    detail: "Hoje os alertas aparecem só dentro do painel: com ele fechado, você não fica sabendo.",
  };
}

// ---------------------------------------------------------------------------
// Montagem
// ---------------------------------------------------------------------------

export interface OnboardingDeps {
  config: Pick<ServerConfig, "dataDir" | "panelDomain">;
  userStore: Pick<UserStore, "findById">;
  /** Estado do e-mail (servidor + domínios). Ver onboarding-sources.ts. */
  emailFacts: () => Promise<EmailFacts>;
  /** Domínio do painel, vendo por onde a página foi aberta (PanelDomainService.facts). */
  panelDomainFacts?: (host: string) => Promise<PanelDomainFacts>;
}

/** As conferências de cada passo, a partir das fontes reais do painel. */
export function createOnboardingChecks(deps: OnboardingDeps): OnboardingChecks {
  return {
    hardening: async () =>
      hardeningState(await loadLastSecurityReport(deps.config.dataDir), await loadSecurityHistory(deps.config.dataDir)),
    "two-factor": async ({ userId }) => twoFactorState(Boolean((await deps.userStore.findById(userId))?.twoFactor)),
    "panel-domain": async ({ host }) =>
      panelDomainState(
        deps.panelDomainFacts ? await deps.panelDomainFacts(host ?? "") : installFacts(deps.config.panelDomain),
      ),
    email: async () => emailState(await deps.emailFacts()),
    notifications: async () => notificationsState(),
  };
}

/**
 * Roda as conferências (em paralelo; uma que falha vira "não confirmado"
 * sem derrubar as outras) e aplica as escolhas da conta.
 */
export async function buildOnboardingResponse(
  checks: OnboardingChecks,
  ctx: OnboardingContext,
  progress: StoredOnboarding | undefined,
  projectsDir: string,
): Promise<OnboardingResponse> {
  const skipped = new Set(progress?.skipped ?? []);
  const steps: OnboardingStep[] = await Promise.all(
    ONBOARDING_STEP_IDS.map(async (id) => {
      const optional = OPTIONAL_ONBOARDING_STEPS.includes(id);
      let state: StepState;
      try {
        state = await checks[id](ctx);
      } catch {
        state = { status: "unknown", detail: "Não foi possível conferir agora. Tente de novo em instantes." };
      }
      const status: OnboardingStepStatus = optional && skipped.has(id) && state.status !== "done" ? "skipped" : state.status;
      return { id, status, optional, detail: state.detail };
    }),
  );
  return {
    steps,
    started: Boolean(progress?.startedAt),
    complete: isOnboardingComplete(steps),
    projectsDir,
  };
}
