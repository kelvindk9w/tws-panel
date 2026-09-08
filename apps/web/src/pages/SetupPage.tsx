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
  /** Maior passo já alcançado — passos até ele ficam montados (estado
   * preservado ao navegar de volta) e clicáveis no stepper. */
  const [maxReached, setMaxReached] = useState(0);
  /** Terminal web SÓ é liberado depois de o setup token ser validado. */
  const [terminalEnabled, setTerminalEnabled] = useState(false);
  /** Usuário não-root detectado na varredura (ou escolhido) na etapa de
   * Segurança. Vive aqui porque o terminal é irmão dos passos, não filho
   * deles: o nome sobe da SecurityStep e desce para o TerminalPanel. */
  const [detectedSshUser, setDetectedSshUser] = useState<string | null>(null);

  // Captura ?token= da URL na primeira renderização.
  useEffect(() => {
    const token = initSetupToken();
    if (!token) return;
    apiFetch<SetupStatusResponse>("/api/setup/status")
      .then((status) => {
        setSteps(status.steps);
        // NUNCA regride o passo: o auto-verify do WelcomeStep pode ter
        // avançado (advance(1)) ANTES deste fetch resolver — um currentStep
        // stale (0) não pode derrubar o usuário de volta ao passo 1.
        setStep((prev) => Math.max(prev, status.state.currentStep));
        setMaxReached((m) => Math.max(m, status.state.currentStep));
        // token da sessão é válido (o status respondeu 200): libera o terminal
        setTerminalEnabled(true);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiRequestError && (err.status === 401 || err.status === 503)) {
          // token salvo inválido: volta para o passo 0
          setStep(0);
        }
      });
  }, []);

  /** Avanço (persiste o progresso no servidor, melhor esforço). */
  function advance(next: number) {
    setStep(next);
    setMaxReached((m) => Math.max(m, next));
    apiFetch("/api/setup/advance", {
      method: "POST",
      body: JSON.stringify({ step: next }),
    }).catch(() => undefined);
  }

  /** Navegação livre entre passos já alcançados (não altera o progresso salvo). */
  function goTo(index: number) {
    if (index >= 0 && index <= maxReached) setStep(index);
  }

  function handleVerified() {
    // token validado AGORA: libera o terminal imediatamente e avança
    setTerminalEnabled(true);
    advance(1);
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
          <Stepper steps={steps} currentStep={step} maxSelectable={maxReached} onSelect={goTo} />
          <Progress value={progress} className="h-1" />
        </div>

        {/* Passos já alcançados ficam MONTADOS (ocultos) — voltar não perde estado.
            Ao ficar visível, o wrapper ganha um fade+rise curto (CSS puro) — ao
            ocultar, `hidden` remove do fluxo e a animação re-dispara na volta. */}
        <div className={step === 0 ? "animate-fade-in" : "hidden"}>
          <WelcomeStep onVerified={handleVerified} />
        </div>
        {maxReached >= 1 && (
          <div className={step === 1 ? "animate-fade-in" : "hidden"}>
            <HealthStep onNext={() => advance(2)} onBack={() => goTo(0)} />
          </div>
        )}
        {maxReached >= 2 && (
          <div className={step === 2 ? "animate-fade-in" : "hidden"}>
            <SecurityStep
              onNext={() => advance(3)}
              onBack={() => goTo(1)}
              onSshUserDetected={setDetectedSshUser}
            />
          </div>
        )}
        {maxReached >= 3 && (
          <div className={step === 3 ? "animate-fade-in" : "hidden"}>
            <AdminStep onBack={() => goTo(2)} />
          </div>
        )}

        {step > 0 && !getSetupToken() && (
          <p className="text-center text-sm text-muted-foreground">
            Sessão sem token — recarregue a página com o link fornecido pelo instalador.
          </p>
        )}

        {/* Visão dupla: terminal real do servidor ao vivo, como janela contida
            na área de conteúdo — bloqueado até o token ser validado */}
        <TerminalPanel enabled={terminalEnabled} sshUser={detectedSshUser} />
      </main>

      <footer className="border-t py-6">
        <p className="text-center text-xs text-muted-foreground">
          Powered by TWS · open-source (MIT)
        </p>
      </footer>
    </div>
  );
}
