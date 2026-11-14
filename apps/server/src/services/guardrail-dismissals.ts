/**
 * guardrail-dismissals.ts — "Não procede — não avisar mais": achados dos guardrails que a pessoa marcou como
 * falsos num projeto. Ficam no próprio projeto (Project.guardrailDismissals, em projects.json): saem com ele,
 * entram no backup dele e a leitura ignora entrada estragada (validGuardrailDismissals, em @paas/core).
 *
 * Aqui só a decisão (o que pode ser dispensado e como fica a lista); quem grava, audita e confere a pessoa é o
 * DeployService e a rota. A identidade do achado (regra + serviço + variável/alvo, ou a evidência normalizada) e
 * a aplicação no relatório vivem em @paas/core, as mesmas na tela, na API e no engine.
 */
import { randomBytes } from "node:crypto";
import {
  GUARDRAIL_DISMISSAL_REASON_MAX,
  GUARDRAIL_DISMISSALS_MAX,
  guardrailFindingIdentity,
  isGuardrailDismissible,
  type GuardrailDismissal,
  type GuardrailDismissalScope,
  type GuardrailDismissFinding,
  type GuardrailLevel,
} from "@paas/core";
import { GUARDRAIL_RULES } from "@paas/deploy";
import { httpError } from "./http-error.js";

/** Tamanho máximo do alvo/evidência guardados (a evidência do achado é curta; mais que isso é lixo). */
const VALUE_MAX = 1000;
const TITLE_MAX = 300;
/** Nome de serviço do compose (o Compose aceita letras, números, ponto, traço e sublinhado). */
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Nível da regra no catálogo (null = regra que o painel não conhece). */
export function guardrailRuleLevel(rule: string): GuardrailLevel | null {
  return GUARDRAIL_RULES.find((r) => r.rule === rule)?.level ?? null;
}

/**
 * Nível da regra, se ela pode ser dispensada; senão lança o erro que a tela mostra. A rota confere ANTES da
 * reautenticação (não gasta o código à toa) e decide por ele se pede a prova: bloqueio pede, aviso não.
 */
export function dismissibleLevel(rule: string): GuardrailLevel {
  if (!isGuardrailDismissible(rule)) {
    throw httpError(
      400,
      "not_dismissible",
      "Este achado não pode ser marcado como \"não procede\": a regra protege o painel, o servidor ou o isolamento entre projetos (volume/rede de outro projeto, pasta do servidor). Corrija o compose.",
    );
  }
  const level = guardrailRuleLevel(rule);
  if (level === null) throw httpError(400, "unknown_rule", "Regra de segurança desconhecida: atualize a página e tente de novo.");
  return level;
}

export interface DismissInput {
  finding: GuardrailDismissFinding;
  scope: GuardrailDismissalScope;
  reason?: string | undefined;
}

/**
 * Confere o pedido e devolve a lista nova e a dispensa que vale. Pedido repetido devolve a dispensa que já existe
 * (nada muda). Dispensa do projeto inteiro substitui as do mesmo achado feitas serviço a serviço.
 */
export function addDismissal(
  current: readonly GuardrailDismissal[],
  input: DismissInput,
  by: string,
  now: Date = new Date(),
): { list: GuardrailDismissal[]; dismissal: GuardrailDismissal; changed: boolean } {
  const f = input.finding;
  dismissibleLevel(f.rule);
  if (f.service !== undefined && !SERVICE_NAME.test(f.service)) {
    throw httpError(400, "invalid_service", "Serviço do compose inválido.");
  }
  if (input.scope === "service" && !f.service) {
    throw httpError(400, "service_required", "Este achado não é de um serviço: escolha \"em todos os serviços deste projeto\".");
  }
  const identity = guardrailFindingIdentity(f);
  if (identity.value.length === 0 || identity.value.length > VALUE_MAX) {
    throw httpError(400, "invalid_finding", "Achado sem variável nem evidência: atualize a página e tente de novo.");
  }
  const reason = (input.reason ?? "").trim();
  if (reason.length > GUARDRAIL_DISMISSAL_REASON_MAX) {
    throw httpError(400, "reason_too_long", `O motivo pode ter até ${GUARDRAIL_DISMISSAL_REASON_MAX} caracteres.`);
  }
  const service = input.scope === "project" ? null : f.service!;
  const same = (d: GuardrailDismissal) => d.rule === f.rule && d.match === identity.match && d.value === identity.value;
  // já coberto (pelo mesmo serviço ou pelo projeto inteiro): nada muda
  const existing = current.find((d) => same(d) && (d.service === null || d.service === service));
  if (existing) return { list: [...current], dismissal: existing, changed: false };
  const list = service === null ? current.filter((d) => !same(d)) : [...current];
  if (list.length >= GUARDRAIL_DISMISSALS_MAX) {
    throw httpError(409, "too_many_dismissals", `Este projeto já tem ${GUARDRAIL_DISMISSALS_MAX} alertas dispensados. Volte a avisar algum antes.`);
  }
  const dismissal: GuardrailDismissal = {
    id: randomBytes(8).toString("hex"),
    rule: f.rule,
    service,
    match: identity.match,
    value: identity.value,
    title: f.title.trim().slice(0, TITLE_MAX) || f.rule,
    reason: reason.length > 0 ? reason : null,
    by,
    at: now.toISOString(),
  };
  list.push(dismissal);
  return { list, dismissal, changed: true };
}

/** Texto da Auditoria (nunca valor de variável: só regra, serviço, alvo e motivo). */
export function dismissalAuditText(d: GuardrailDismissal): string {
  const where = d.service === null ? "em todos os serviços" : `no serviço "${d.service}"`;
  const what = d.match === "target" ? `alvo ${d.value}` : `evidência "${d.value}"`;
  return `[${d.rule}] ${d.title} — ${what}, ${where}${d.reason ? `. Motivo: ${d.reason}` : ""}`;
}
