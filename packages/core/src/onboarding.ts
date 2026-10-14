/**
 * onboarding.ts — roteiro "Deixe o painel pronto" do Dashboard.
 *
 * Depois da instalação, o painel não dizia o que ainda faltava configurar
 * (pedido do dono do produto em 01/10/2026). O roteiro lista os passos, na
 * ordem combinada com ele, cada um com o status calculado do estado REAL do
 * painel (GET /api/onboarding) — nada de caixinha marcada à mão para o que o
 * painel consegue conferir. Só "Não vou usar" (passos opcionais), "roteiro
 * iniciado" e "Ocultar até ter novidade" são escolhas da pessoa, guardadas
 * na conta.
 */

/** Passos, na ordem combinada com o dono do produto. */
export const ONBOARDING_STEP_IDS = ["hardening", "two-factor", "panel-domain", "email", "notifications"] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

/** Passos que a pessoa pode marcar como "Não vou usar" (e desfazer). */
export const OPTIONAL_ONBOARDING_STEPS: readonly OnboardingStepId[] = ["email", "notifications"];

/**
 * - done: o painel conferiu e está feito;
 * - in_progress: começou, mas falta parte (ex.: 3 de 8 fases aplicadas);
 * - pending: nada feito ainda;
 * - skipped: a pessoa marcou "Não vou usar" (só passos opcionais);
 * - soon: a funcionalidade ainda não existe no painel ("em breve");
 * - unknown: o painel não conseguiu conferir agora — nunca vale como feito.
 */
export type OnboardingStepStatus = "done" | "in_progress" | "pending" | "skipped" | "soon" | "unknown";

export interface OnboardingStep {
  id: OnboardingStepId;
  status: OnboardingStepStatus;
  /** Pode ser marcado como "Não vou usar". */
  optional: boolean;
  /** A situação real em uma frase (ex.: "6 de 8 fases resolvidas · nota do Lynis 76"). */
  detail: string;
}

/** GET /api/onboarding (e resposta das ações do roteiro). */
export interface OnboardingResponse {
  steps: OnboardingStep[];
  /**
   * A pessoa já começou o roteiro (clicou em algum passo, recolheu ou marcou
   * "Não vou usar"). Antes disso, o Dashboard mostra o roteiro aberto.
   */
  started: boolean;
  /**
   * Todos os passos feitos ou "Não vou usar": o cartão sai de vez do
   * Dashboard (continua em Configurações). Passo "em breve" segura o cartão.
   */
  complete: boolean;
  /**
   * A pessoa clicou em "Ocultar até ter novidade" e não há novidade desde
   * então (isOnboardingHiddenUntilNews): o Dashboard não mostra o cartão.
   */
  hidden: boolean;
  /** Pasta dos projetos na VPS — informativa, resolvida pelo instalador. */
  projectsDir: string;
}

/** PUT /api/onboarding/steps/:id — "Não vou usar" (true) ou desfazer (false). */
export interface OnboardingSkipRequest {
  skipped: boolean;
}

/** PUT /api/onboarding/hidden — "Ocultar até ter novidade" (true) ou mostrar de novo (false). */
export interface OnboardingHideRequest {
  hidden: boolean;
}

/** Status que não pedem nada da pessoa agora. */
export function isOnboardingStepResolved(status: OnboardingStepStatus): boolean {
  return status === "done" || status === "skipped" || status === "soon";
}

/** O primeiro passo, na ordem, que ainda pede algo — ou null. */
export function nextOnboardingStep(steps: readonly OnboardingStep[]): OnboardingStep | null {
  return steps.find((s) => !isOnboardingStepResolved(s.status)) ?? null;
}

/**
 * Roteiro concluído: todos os passos feitos ou "Não vou usar". Passo "em
 * breve" não conta como concluído — validação real (07/10/2026): com 1 a 4
 * feitos e o 5 "em breve", o cartão sumia do Dashboard como se estivesse
 * tudo pronto; o dono esperava continuar vendo o progresso e o que vem.
 */
export function isOnboardingComplete(steps: readonly OnboardingStep[]): boolean {
  return steps.every((s) => s.status === "done" || s.status === "skipped");
}

/** Os passos "em breve", na ordem. */
export function soonOnboardingSteps(steps: readonly OnboardingStep[]): OnboardingStepId[] {
  return steps.filter((s) => s.status === "soon").map((s) => s.id);
}

/**
 * Tudo o que dá para fazer agora está feito; falta só o que ainda chega
 * ("em breve"). O Dashboard mostra o cartão compacto com essa mensagem e o
 * botão "Ocultar até ter novidade".
 */
export function isOnboardingWaitingOnSoon(steps: readonly OnboardingStep[]): boolean {
  return nextOnboardingStep(steps) === null && !isOnboardingComplete(steps);
}

/**
 * "Ocultar até ter novidade" vale enquanto nada novo apareceu: nenhum passo
 * pede ação e todos os que eram "em breve" quando a pessoa ocultou
 * (`hiddenSoon`, guardado na conta) continuam "em breve". Um passo que
 * chega (deixa de ser "em breve") ou volta a pedir ação traz o cartão de volta.
 */
export function isOnboardingHiddenUntilNews(
  steps: readonly OnboardingStep[],
  hiddenSoon: readonly OnboardingStepId[] | null | undefined,
): boolean {
  if (!hiddenSoon) return false;
  if (nextOnboardingStep(steps) !== null) return false;
  return hiddenSoon.every((id) => steps.find((s) => s.id === id)?.status === "soon");
}

/**
 * Primeiro acesso: o roteiro ainda não foi começado e a pessoa não fez nada
 * nele além das proteções da VPS (que vêm do assistente da instalação). Só
 * nesse caso o Dashboard mostra os passos todos abertos; depois, compacto.
 */
export function isOnboardingFirstVisit(res: Pick<OnboardingResponse, "started" | "steps">): boolean {
  if (res.started) return false;
  return res.steps.every((s) => s.id === "hardening" || s.status === "pending" || s.status === "soon" || s.status === "unknown");
}
