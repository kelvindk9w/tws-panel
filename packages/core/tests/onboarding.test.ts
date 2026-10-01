/**
 * Roteiro "Deixe o painel pronto" (Dashboard): a ordem dos passos combinada
 * com o dono do produto e as regras que decidem o próximo passo e quando o
 * roteiro está concluído — usadas igualmente pelo servidor e pela interface.
 */
import { describe, expect, it } from "vitest";
import {
  ONBOARDING_STEP_IDS,
  OPTIONAL_ONBOARDING_STEPS,
  isOnboardingComplete,
  isOnboardingFirstVisit,
  isOnboardingStepResolved,
  nextOnboardingStep,
  type OnboardingStep,
  type OnboardingStepStatus,
} from "../src/index";

function step(id: OnboardingStep["id"], status: OnboardingStepStatus): OnboardingStep {
  return { id, status, optional: OPTIONAL_ONBOARDING_STEPS.includes(id), detail: "" };
}

describe("roteiro de primeiros passos", () => {
  it("ordem combinada: proteções, 2FA, domínio do painel, e-mail, notificações", () => {
    expect(ONBOARDING_STEP_IDS).toEqual(["hardening", "two-factor", "panel-domain", "email", "notifications"]);
  });

  it("só e-mail e notificações podem ser marcados como 'Não vou usar'", () => {
    expect(OPTIONAL_ONBOARDING_STEPS).toEqual(["email", "notifications"]);
  });

  it("feito, 'não vou usar' e 'em breve' não pedem nada agora; o resto pede", () => {
    expect(isOnboardingStepResolved("done")).toBe(true);
    expect(isOnboardingStepResolved("skipped")).toBe(true);
    expect(isOnboardingStepResolved("soon")).toBe(true);
    expect(isOnboardingStepResolved("pending")).toBe(false);
    expect(isOnboardingStepResolved("in_progress")).toBe(false);
    // Não deu para conferir não é "feito".
    expect(isOnboardingStepResolved("unknown")).toBe(false);
  });

  it("próximo passo = o primeiro, na ordem, que ainda pede algo", () => {
    const steps = [
      step("hardening", "done"),
      step("two-factor", "pending"),
      step("panel-domain", "soon"),
      step("email", "pending"),
      step("notifications", "soon"),
    ];
    expect(nextOnboardingStep(steps)?.id).toBe("two-factor");
    expect(nextOnboardingStep([step("hardening", "done"), step("email", "in_progress")])?.id).toBe("email");
  });

  it("tudo resolvido: sem próximo passo e roteiro concluído (passos 'em breve' não seguram o cartão)", () => {
    const steps = [
      step("hardening", "done"),
      step("two-factor", "done"),
      step("panel-domain", "soon"),
      step("email", "skipped"),
      step("notifications", "soon"),
    ];
    expect(nextOnboardingStep(steps)).toBeNull();
    expect(isOnboardingComplete(steps)).toBe(true);
    expect(isOnboardingComplete([...steps.slice(0, 4), step("notifications", "pending")])).toBe(false);
  });

  // Pedido do dono do produto (01/10/2026): com 2FA ligado e projeto rodando,
  // o roteiro aberto com os 5 passos não fazia sentido. Aberto só no primeiro
  // acesso; as proteções contam como "instalação" (vêm do assistente inicial).
  it("primeiro acesso: roteiro não começado e nada feito além das proteções da VPS", () => {
    const fresh = [step("hardening", "done"), step("two-factor", "pending"), step("panel-domain", "soon"), step("email", "pending")];
    expect(isOnboardingFirstVisit({ started: false, steps: fresh })).toBe(true);
    expect(isOnboardingFirstVisit({ started: true, steps: fresh })).toBe(false);
    expect(isOnboardingFirstVisit({ started: false, steps: [step("hardening", "done"), step("two-factor", "done")] })).toBe(false);
    expect(isOnboardingFirstVisit({ started: false, steps: [step("two-factor", "pending"), step("email", "skipped")] })).toBe(false);
    expect(isOnboardingFirstVisit({ started: false, steps: [step("two-factor", "pending"), step("email", "in_progress")] })).toBe(false);
  });
});
