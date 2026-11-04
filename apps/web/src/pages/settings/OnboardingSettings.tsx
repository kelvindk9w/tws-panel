import { OnboardingChecklist } from "@/components/onboarding/OnboardingChecklist";

/**
 * Configurações → Primeiros passos: o roteiro "Deixe o painel pronto" inteiro,
 * sempre acessível — inclusive depois que ele sai do Dashboard.
 */
export function OnboardingSettings() {
  return <OnboardingChecklist variant="settings" />;
}
