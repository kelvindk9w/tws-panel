import { useEffect, useState } from "react";
import type { SetupStatusResponse } from "@paas/core";
import { apiFetch, getSetupToken, initSetupToken, ApiRequestError } from "@/lib/api";
import { Stepper } from "@/components/Stepper";
import { TerminalPanel } from "@/components/TerminalPanel";
import { WelcomeStep } from "@/pages/setup/WelcomeStep";
import { HealthStep } from "@/pages/setup/HealthStep";
import { SecurityStep } from "@/pages/setup/SecurityStep";
import { AdminStep } from "@/pages/setup/AdminStep";
import { Progress } from "@/components/ui/progress";

const FALLBACK_STEPS: SetupStatusResponse["steps"] = [
  { id: 0, key: "welcome", title: "Boas-vindas e token", available: true },
  { id: 1, key: "health", title: "Saúde da máquina", available: true },
  { id: 2, key: "security", title: "Segurança", available: true },
  { id: 3, key: "admin", title: "Conta de administrador", available: true },
];

export function SetupPage() {
  const [steps, setSteps] = useState(FALLBACK_STEPS);
  const [step, setStep] = useState(0);

  // Captura ?token= da URL na primeira renderização.
  useEffect(() => {
    const token = initSetupToken();
    if (!token) return;
    apiFetch<SetupStatusResponse>("/api/setup/status")
      .then((status) => {
        setSteps(status.steps);
        setStep(status.state.currentStep);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiRequestError && (err.status === 401 || err.status === 503)) {
          // token salvo inválido: volta para o passo 0
          setStep(0);
        }
      });
  }, []);

  function advance(next: number) {
    setStep(next);
    // melhor esforço: persiste o progresso no servidor
    apiFetch("/api/setup/advance", {
      method: "POST",
      body: JSON.stringify({ step: next }),
    }).catch(() => undefined);
  }

  const maxStep = steps.length - 1;
  const progress = (step / maxStep) * 100;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="border-b">
        <div className="container flex h-14 items-center justify-between">
          <span className="font-semibold tracking-tight">
            TWS <span className="text-muted-foreground">Panel</span>
          </span>
          <span className="text-xs text-muted-foreground">Assistente de configuração</span>
        </div>
      </header>

      <main className="container flex w-full max-w-4xl flex-1 flex-col gap-8 py-10">
        <div className="flex flex-col gap-3">
          <Stepper steps={steps} currentStep={step} />
          <Progress value={progress} className="h-1" />
        </div>

        {step === 0 && <WelcomeStep onVerified={() => advance(1)} />}
        {step === 1 && <HealthStep onNext={() => advance(2)} />}
        {step === 2 && <SecurityStep onNext={() => advance(3)} />}
        {step === 3 && <AdminStep />}

        {step > 0 && !getSetupToken() && (
          <p className="text-center text-sm text-muted-foreground">
            Sessão sem token — recarregue a página com o link fornecido pelo instalador.
          </p>
        )}
      </main>

      <footer className="border-t py-6">
        <p className="text-center text-xs text-muted-foreground">
          Powered by TWS · open-source (MIT)
        </p>
      </footer>

      {/* Visão dupla: terminal real do servidor ao vivo em TODOS os passos */}
      <TerminalPanel />
    </div>
  );
}
