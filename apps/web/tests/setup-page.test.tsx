/**
 * setup-page.test.tsx — fluxo do wizard:
 *  - terminal bloqueado até o token ser validado (enabled=false) e liberado
 *    imediatamente após a validação;
 *  - navegação de volta: botão "Voltar" do passo + stepper clicável para
 *    passos já alcançados — SEM perder o estado (passos ficam montados).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks de API e dos passos filhos (o foco é a orquestração do SetupPage)
// ---------------------------------------------------------------------------

let tokenFromUrl: string | null = null;

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (path: string) => {
    if (path === "/api/setup/status") {
      return {
        state: { currentStep: 0, completed: false, updatedAt: "" },
        steps: [
          { id: 0, key: "welcome", title: "Boas-vindas e token", available: true },
          { id: 1, key: "health", title: "Saúde da máquina", available: true },
          { id: 2, key: "security", title: "Segurança", available: true },
          { id: 3, key: "admin", title: "Conta de administrador", available: true },
        ],
      };
    }
    return {};
  }),
  initSetupToken: () => tokenFromUrl,
  getSetupToken: () => tokenFromUrl,
  setSetupToken: vi.fn(),
  clearSetupToken: vi.fn(),
  ApiRequestError: class extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

vi.mock("@/components/TerminalPanel", () => ({
  TerminalPanel: ({ enabled }: { enabled: boolean }) => (
    <div data-testid="terminal-mock">{enabled ? "terminal:liberado" : "terminal:bloqueado"}</div>
  ),
}));

vi.mock("@/pages/setup/WelcomeStep", () => ({
  WelcomeStep: ({ onVerified }: { onVerified: () => void }) => (
    <div data-testid="step-welcome">
      <button onClick={onVerified}>validar-token</button>
    </div>
  ),
}));

vi.mock("@/pages/setup/HealthStep", () => ({
  HealthStep: ({ onNext, onBack }: { onNext: () => void; onBack?: () => void }) => (
    <div data-testid="step-health">
      <span>conteúdo-saúde</span>
      {onBack && <button onClick={onBack}>voltar-saúde</button>}
      <button onClick={onNext}>avançar-saúde</button>
    </div>
  ),
}));

vi.mock("@/pages/setup/SecurityStep", () => ({
  SecurityStep: ({ onNext, onBack }: { onNext: () => void; onBack?: () => void }) => (
    <div data-testid="step-security">
      <span>conteúdo-segurança</span>
      {onBack && <button onClick={onBack}>voltar-segurança</button>}
      <button onClick={onNext}>avançar-segurança</button>
    </div>
  ),
}));

vi.mock("@/pages/setup/AdminStep", () => ({
  AdminStep: () => <div data-testid="step-admin">conteúdo-admin</div>,
}));

import { SetupPage } from "@/pages/SetupPage";

function wrapperOf(testId: string): HTMLElement {
  const el = screen.getByTestId(testId).parentElement;
  if (!el) throw new Error(`wrapper de ${testId} não encontrado`);
  return el;
}

beforeEach(() => {
  sessionStorage.clear();
  tokenFromUrl = null;
});

afterEach(() => {
  cleanup();
});

describe("SetupPage", () => {
  it("terminal começa bloqueado e é liberado imediatamente após validar o token", async () => {
    render(<SetupPage />);
    await waitFor(() => expect(screen.getByTestId("step-welcome")).toBeInTheDocument());
    expect(screen.getByTestId("terminal-mock")).toHaveTextContent("terminal:bloqueado");
    fireEvent.click(screen.getByText("validar-token"));
    await waitFor(() => expect(screen.getByTestId("terminal-mock")).toHaveTextContent("terminal:liberado"));
    expect(screen.getByTestId("step-health")).toBeInTheDocument();
  });

  it("token válido na URL libera o terminal já na abertura da página", async () => {
    tokenFromUrl = "token-da-url";
    render(<SetupPage />);
    await waitFor(() => expect(screen.getByTestId("terminal-mock")).toHaveTextContent("terminal:liberado"));
  });

  it("botão Voltar do passo retorna sem desmontar o passo anterior", async () => {
    render(<SetupPage />);
    fireEvent.click(await screen.findByText("validar-token"));
    await screen.findByTestId("step-health");

    fireEvent.click(screen.getByText("voltar-saúde"));
    // passo 0 visível de novo; saúde continua montada (hidden) — estado preservado
    expect(wrapperOf("step-welcome")).not.toHaveClass("hidden");
    expect(wrapperOf("step-health")).toHaveClass("hidden");
  });

  it("stepper clicável volta para passos já alcançados sem perder estado", async () => {
    render(<SetupPage />);
    fireEvent.click(await screen.findByText("validar-token"));
    fireEvent.click(await screen.findByText("avançar-saúde"));
    await screen.findByTestId("step-security");
    expect(wrapperOf("step-security")).not.toHaveClass("hidden");

    // clica no passo "Saúde da máquina" do stepper
    fireEvent.click(screen.getByRole("button", { name: "Voltar para Saúde da máquina" }));
    expect(wrapperOf("step-health")).not.toHaveClass("hidden");
    // segurança continua montada (estado interno preservado)
    expect(wrapperOf("step-security")).toHaveClass("hidden");
    expect(screen.getByText("conteúdo-segurança")).toBeInTheDocument();

    // e dá para ir adiante de novo pelo stepper
    fireEvent.click(screen.getByRole("button", { name: "Voltar para Segurança" }));
    expect(wrapperOf("step-security")).not.toHaveClass("hidden");
  });

  it("passos futuros NÃO são clicáveis no stepper", async () => {
    render(<SetupPage />);
    fireEvent.click(await screen.findByText("validar-token"));
    await screen.findByTestId("step-health");
    expect(screen.queryByRole("button", { name: "Voltar para Segurança" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("step-security")).not.toBeInTheDocument();
  });
});
