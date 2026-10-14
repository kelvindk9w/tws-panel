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
  isOnboardingHiddenUntilNews,
  isOnboardingStepResolved,
  isOnboardingWaitingOnSoon,
  nextOnboardingStep,
  soonOnboardingSteps,
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

  it("sem próximo passo, mas com passo 'em breve': ainda não está concluído (o cartão continua)", () => {
    const steps = [
      step("hardening", "done"),
      step("two-factor", "done"),
      step("panel-domain", "done"),
      step("email", "skipped"),
      step("notifications", "soon"),
    ];
    expect(nextOnboardingStep(steps)).toBeNull();
    expect(isOnboardingComplete(steps)).toBe(false);
    expect(isOnboardingWaitingOnSoon(steps)).toBe(true);
    expect(soonOnboardingSteps(steps)).toEqual(["notifications"]);
  });

  // Validação real (07/10/2026): com 1 a 4 feitos e o 5 "em breve", o cartão
  // sumiu do Dashboard. Só some de vez com tudo feito ou "Não vou usar".
  it("concluído = todos os passos feitos ou 'Não vou usar'", () => {
    const steps = [
      step("hardening", "done"),
      step("two-factor", "done"),
      step("panel-domain", "done"),
      step("email", "skipped"),
      step("notifications", "skipped"),
    ];
    expect(isOnboardingComplete(steps)).toBe(true);
    expect(isOnboardingWaitingOnSoon(steps)).toBe(false);
    expect(isOnboardingComplete([...steps.slice(0, 4), step("notifications", "pending")])).toBe(false);
    expect(isOnboardingComplete([...steps.slice(0, 4), step("notifications", "unknown")])).toBe(false);
  });

  it("com passo pedindo ação, não está só esperando o 'em breve'", () => {
    expect(isOnboardingWaitingOnSoon([step("two-factor", "pending"), step("notifications", "soon")])).toBe(false);
  });

  describe("'Ocultar até ter novidade'", () => {
    const waiting = [
      step("hardening", "done"),
      step("two-factor", "done"),
      step("panel-domain", "done"),
      step("email", "done"),
      step("notifications", "soon"),
    ];

    it("nunca ocultado: aparece", () => {
      expect(isOnboardingHiddenUntilNews(waiting, undefined)).toBe(false);
      expect(isOnboardingHiddenUntilNews(waiting, null)).toBe(false);
    });

    it("ocultado com os mesmos passos 'em breve' e nada a fazer: continua oculto", () => {
      expect(isOnboardingHiddenUntilNews(waiting, ["notifications"])).toBe(true);
    });

    it("um passo deixou de ser 'em breve': é novidade, aparece de novo", () => {
      const arrived = [...waiting.slice(0, 4), step("notifications", "pending")];
      expect(isOnboardingHiddenUntilNews(arrived, ["notifications"])).toBe(false);
    });

    it("um passo voltou a pedir ação (ex.: 2FA desligada): aparece de novo", () => {
      const regressed = [waiting[0]!, step("two-factor", "pending"), ...waiting.slice(2)];
      expect(isOnboardingHiddenUntilNews(regressed, ["notifications"])).toBe(false);
    });

    it("passo que não dá para conferir agora também pede atenção: aparece", () => {
      const unknown = [waiting[0]!, step("two-factor", "unknown"), ...waiting.slice(2)];
      expect(isOnboardingHiddenUntilNews(unknown, ["notifications"])).toBe(false);
    });
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
