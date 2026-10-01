/**
 * onboarding-checklist.test.tsx — roteiro "Deixe o painel pronto".
 * Pedido do dono do produto (01/10/2026): depois da instalação, o painel não
 * dizia o que faltava configurar.
 *  - primeiro acesso (roteiro não começado): ABERTO, com todos os passos;
 *  - depois de começar: COMPACTO, só o próximo passo, e "Ver todos os passos"
 *    abre uma janela com a lista inteira;
 *  - cada passo tem "Como fazer" (o que é, por que importa, passo a passo e o
 *    botão que leva à tela certa);
 *  - tudo resolvido: some do Dashboard e continua em Configurações;
 *  - opcionais podem ser marcados "Não vou usar" (e desfeitos).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingResponse, OnboardingStep, OnboardingStepStatus } from "@paas/core";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, init?: RequestInit) => apiFetchMock(path, init),
  ApiRequestError: class extends Error {},
}));

import { OnboardingChecklist } from "@/components/onboarding/OnboardingChecklist";
import { OnboardingSettings } from "@/pages/settings/OnboardingSettings";
import { SettingsLayout } from "@/pages/settings/SettingsLayout";

function steps(statuses: Partial<Record<OnboardingStep["id"], OnboardingStepStatus>> = {}): OnboardingStep[] {
  const base: Record<OnboardingStep["id"], OnboardingStepStatus> = {
    hardening: "done",
    "two-factor": "pending",
    "panel-domain": "soon",
    email: "pending",
    notifications: "soon",
    ...statuses,
  };
  return (Object.keys(base) as OnboardingStep["id"][]).map((id) => ({
    id,
    status: base[id],
    optional: id === "email" || id === "notifications",
    detail: `detalhe de ${id}`,
  }));
}

function response(over: Partial<OnboardingResponse> = {}, statuses = {}): OnboardingResponse {
  return { steps: steps(statuses), started: false, complete: false, projectsDir: "/opt/tws-projects", ...over };
}

function Where() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname + l.hash}</p>;
}

function renderChecklist(variant: "dashboard" | "settings" = "dashboard") {
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: (
          <>
            <OnboardingChecklist variant={variant} />
            <Where />
          </>
        ),
      },
    ],
    { initialEntries: ["/"] },
  );
  return render(<RouterProvider router={router} />);
}

/** Responde GET com `current`; POST/PUT trocam o estado como o servidor faria. */
function serve(initial: OnboardingResponse) {
  let current = initial;
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path === "/api/onboarding" && method === "GET") return current;
    if (path === "/api/onboarding/start" && method === "POST") {
      current = { ...current, started: true };
      return current;
    }
    const m = /^\/api\/onboarding\/steps\/(.+)$/.exec(path);
    if (m && method === "PUT") {
      const { skipped } = JSON.parse(String(init?.body)) as { skipped: boolean };
      current = {
        ...current,
        started: true,
        steps: current.steps.map((s) => (s.id === m[1] ? { ...s, status: skipped ? "skipped" : "pending" } : s)),
      };
      return current;
    }
    throw new Error(`rota inesperada: ${method} ${path}`);
  });
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("primeiro acesso", () => {
  it("roteiro aberto com os cinco passos, na ordem, e o status de cada um", async () => {
    serve(response());
    renderChecklist();
    const card = await screen.findByTestId("onboarding-card");
    const items = within(card).getAllByTestId(/^onboarding-step-/);
    expect(items.map((el) => el.dataset.testid)).toEqual([
      "onboarding-step-hardening",
      "onboarding-step-two-factor",
      "onboarding-step-panel-domain",
      "onboarding-step-email",
      "onboarding-step-notifications",
    ]);
    expect(within(card).getByText("Deixe o painel pronto")).toBeInTheDocument();
    expect(within(items[0]!).getByText("feito")).toBeInTheDocument();
    expect(within(items[1]!).getByText("a fazer")).toBeInTheDocument();
    expect(within(items[2]!).getByText("em breve")).toBeInTheDocument();
    expect(within(items[1]!).getByText("detalhe de two-factor")).toBeInTheDocument();
    // Pasta dos projetos: só informativa.
    expect(within(card).getByText("/opt/tws-projects")).toBeInTheDocument();
  });

  it("'Recolher' começa o roteiro e passa a mostrar só o próximo passo", async () => {
    serve(response());
    renderChecklist();
    fireEvent.click(await screen.findByRole("button", { name: /Recolher/ }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/api/onboarding/start", expect.objectContaining({ method: "POST" })));
    await waitFor(() => expect(screen.queryByTestId("onboarding-step-hardening")).not.toBeInTheDocument());
    expect(screen.getByTestId("onboarding-step-two-factor")).toBeInTheDocument();
  });
});

describe("depois de começar (compacto)", () => {
  it("mostra só o próximo passo e o progresso; 'Ver todos os passos' abre a janela com a lista inteira", async () => {
    serve(response({ started: true }));
    renderChecklist();
    const card = await screen.findByTestId("onboarding-card");
    expect(within(card).getAllByTestId(/^onboarding-step-/)).toHaveLength(1);
    expect(within(card).getByTestId("onboarding-step-two-factor")).toBeInTheDocument();
    // 1 de 3 que dá para fazer hoje (os "em breve" ficam de fora da conta).
    expect(within(card).getByText(/1 de 3 resolvidos/)).toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: /Ver todos os passos/ }));
    const dialog = await screen.findByRole("dialog", { name: /Deixe o painel pronto/ });
    expect(within(dialog).getAllByTestId(/^onboarding-step-/)).toHaveLength(5);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("'Como fazer' explica o que é, por que importa e o passo a passo, com o botão para a tela certa", async () => {
    serve(response({ started: true }));
    renderChecklist();
    const item = await screen.findByTestId("onboarding-step-two-factor");
    expect(within(item).queryByText("O que é")).not.toBeInTheDocument();
    fireEvent.click(within(item).getByRole("button", { name: /Como fazer/ }));
    expect(within(item).getByText("O que é")).toBeInTheDocument();
    expect(within(item).getByText("Por que importa")).toBeInTheDocument();
    expect(within(item).getByText("Passo a passo")).toBeInTheDocument();
    fireEvent.click(within(item).getByRole("link", { name: /Ativar a verificação/ }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/settings/security#two-factor"));
  });

  it("'Conferir de novo' busca o status outra vez", async () => {
    serve(response({ started: true }));
    renderChecklist();
    fireEvent.click(await screen.findByRole("button", { name: /Conferir de novo/ }));
    await waitFor(() => expect(apiFetchMock.mock.calls.filter(([p]) => p === "/api/onboarding")).toHaveLength(2));
  });
});

describe("e-mail do servidor (opcional)", () => {
  it("'Como fazer' recomenda subdomínio só para envio e avisa do MX do domínio principal", async () => {
    serve(response({ started: true }, { "two-factor": "done" }));
    renderChecklist();
    const item = await screen.findByTestId("onboarding-step-email");
    fireEvent.click(within(item).getByRole("button", { name: /Como fazer/ }));
    expect(within(item).getByText(/envio\.exemplo\.com\.br/)).toBeInTheDocument();
    expect(within(item).getByText(/desviaria o e-mail/)).toBeInTheDocument();
    expect(within(item).getByRole("link", { name: /Abrir E-mail/ })).toHaveAttribute("href", "/mail");
  });

  it("'Não vou usar' e 'Desfazer'", async () => {
    serve(response({ started: true }, { "two-factor": "done" }));
    renderChecklist("settings");
    const item = await screen.findByTestId("onboarding-step-email");
    fireEvent.click(within(item).getByRole("button", { name: /Não vou usar/ }));
    await waitFor(() => expect(within(screen.getByTestId("onboarding-step-email")).getByText("não vou usar")).toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/onboarding/steps/email",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ skipped: true }) }),
    );
    fireEvent.click(within(screen.getByTestId("onboarding-step-email")).getByRole("button", { name: /Desfazer/ }));
    await waitFor(() => expect(within(screen.getByTestId("onboarding-step-email")).getByText("a fazer")).toBeInTheDocument());
  });

  it("passo obrigatório não oferece 'Não vou usar'", async () => {
    serve(response());
    renderChecklist();
    const item = await screen.findByTestId("onboarding-step-two-factor");
    expect(within(item).queryByRole("button", { name: /Não vou usar/ })).not.toBeInTheDocument();
  });
});

describe("passos em breve", () => {
  it("domínio do painel: explica o porquê e não tem botão de ação", async () => {
    serve(response());
    renderChecklist();
    const item = await screen.findByTestId("onboarding-step-panel-domain");
    fireEvent.click(within(item).getByRole("button", { name: /Como fazer/ }));
    expect(within(item).getByText(/IP da VPS no nome/)).toBeInTheDocument();
    expect(within(item).queryByRole("link")).not.toBeInTheDocument();
  });

  it("notificações: Telegram primeiro, e-mail depois, um, outro ou os dois", async () => {
    serve(response());
    renderChecklist();
    const item = await screen.findByTestId("onboarding-step-notifications");
    fireEvent.click(within(item).getByRole("button", { name: /Como fazer/ }));
    expect(within(item).getByText(/Primeiro virá o Telegram/)).toBeInTheDocument();
    expect(within(item).getByText(/um, outro ou os dois/)).toBeInTheDocument();
  });
});

describe("tudo resolvido", () => {
  it("no Dashboard o cartão some", async () => {
    serve(response({ started: true, complete: true }, { "two-factor": "done", email: "skipped" }));
    renderChecklist("dashboard");
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId("onboarding-card")).not.toBeInTheDocument();
  });

  it("em Configurações continua acessível, com todos os passos e o aviso de que está tudo pronto", async () => {
    serve(response({ started: true, complete: true }, { "two-factor": "done", email: "skipped" }));
    renderChecklist("settings");
    const card = await screen.findByTestId("onboarding-card");
    expect(within(card).getAllByTestId(/^onboarding-step-/)).toHaveLength(5);
    expect(within(card).getByText(/Tudo pronto/)).toBeInTheDocument();
  });
});

describe("acesso em Configurações", () => {
  it("o menu de Configurações tem a seção 'Primeiros passos' com endereço próprio", () => {
    const router = createMemoryRouter([{ path: "*", element: <SettingsLayout /> }], { initialEntries: ["/settings"] });
    render(<RouterProvider router={router} />);
    const nav = screen.getByTestId("settings-nav");
    expect(within(nav).getByRole("link", { name: /Primeiros passos/ })).toHaveAttribute("href", "/settings/onboarding");
  });

  it("a página da seção mostra o roteiro inteiro", async () => {
    serve(response({ started: true }));
    const router = createMemoryRouter([{ path: "*", element: <OnboardingSettings /> }]);
    render(<RouterProvider router={router} />);
    const card = await screen.findByTestId("onboarding-card");
    expect(within(card).getAllByTestId(/^onboarding-step-/)).toHaveLength(5);
  });
});

describe("falha ao carregar", () => {
  it("no Dashboard não mostra nada; em Configurações diz que não carregou", async () => {
    apiFetchMock.mockRejectedValue(new Error("fora do ar"));
    renderChecklist("dashboard");
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId("onboarding-card")).not.toBeInTheDocument();
    cleanup();
    renderChecklist("settings");
    expect(await screen.findByRole("alert")).toHaveTextContent(/Não foi possível carregar/);
  });
});
