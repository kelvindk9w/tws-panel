/**
 * onboarding-checklist.test.tsx — roteiro "Deixe o painel pronto".
 * Pedido do dono do produto (01/10/2026): depois da instalação, o painel não
 * dizia o que faltava configurar.
 *  - primeiro acesso (roteiro não começado): ABERTO, com todos os passos;
 *  - depois de começar (ou já com algo feito além das proteções): COMPACTO,
 *    com os números 1 a 5 e a orientação só do passo atual; "Ver todos os
 *    passos" expande a lista inteira no cartão;
 *  - cada passo tem "Como fazer" (o que é, por que importa, passo a passo e o
 *    botão que leva à tela certa);
 *  - só falta o que é "em breve": continua no Dashboard, compacto, com a
 *    mensagem e "Ocultar até ter novidade" (validação real, 07/10/2026);
 *  - tudo feito ou "Não vou usar": some do Dashboard e continua em Configurações;
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
  return { steps: steps(statuses), started: false, complete: false, hidden: false, projectsDir: "/opt/tws-projects", ...over };
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
    if (path === "/api/onboarding/hidden" && method === "PUT") {
      const { hidden } = JSON.parse(String(init?.body)) as { hidden: boolean };
      current = { ...current, started: true, hidden };
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
  // Pedido do dono do produto (01/10/2026): depois do primeiro acesso, só os
  // números 1 a 5 no topo (feitos com check verde, o atual destacado, os que
  // faltam aguardando) e a orientação do passo atual; "Ver todos os passos"
  // expande a lista inteira no próprio cartão.
  it("números 1 a 5 com a situação de cada passo, e só a orientação do passo atual", async () => {
    serve(response({ started: true }));
    renderChecklist();
    const card = await screen.findByTestId("onboarding-card");
    const stepper = within(card).getByTestId("onboarding-stepper");
    const dots = within(stepper).getAllByRole("button");
    expect(dots).toHaveLength(5);
    expect(dots[0]).toHaveAccessibleName(/1\. Proteções da VPS: feito/);
    expect(dots[1]).toHaveAccessibleName(/2\. Verificação em duas etapas: a fazer/);
    expect(dots[1]).toHaveAttribute("aria-current", "step");
    expect(dots[2]).toHaveAccessibleName(/3\. Domínio do painel: em breve/);
    expect(within(card).getAllByTestId(/^onboarding-step-/)).toHaveLength(1);
    // a orientação do passo atual já vem aberta
    const item = within(card).getByTestId("onboarding-step-two-factor");
    expect(within(item).getByText("Passo a passo")).toBeInTheDocument();
    expect(within(card).getByText(/1 feito · 2 a fazer · 2 em breve no painel/)).toBeInTheDocument();
    // a pasta dos projetos fica só na lista inteira
    expect(within(card).queryByText("/opt/tws-projects")).not.toBeInTheDocument();
  });

  it("já com algo feito além das proteções, abre compacto mesmo sem ter clicado em nada", async () => {
    serve(response({ started: false }, { "two-factor": "done" }));
    renderChecklist();
    const card = await screen.findByTestId("onboarding-card");
    expect(within(card).getAllByTestId(/^onboarding-step-/)).toHaveLength(1);
    expect(within(card).getByTestId("onboarding-step-email")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /4\. E-mail do servidor/ })).toHaveAttribute("aria-current", "step");
  });

  it("clicar num número mostra a orientação daquele passo", async () => {
    serve(response({ started: true }));
    renderChecklist();
    const card = await screen.findByTestId("onboarding-card");
    fireEvent.click(within(card).getByRole("button", { name: /3\. Domínio do painel/ }));
    expect(within(card).getByTestId("onboarding-step-panel-domain")).toBeInTheDocument();
    expect(within(card).queryByTestId("onboarding-step-two-factor")).not.toBeInTheDocument();
  });

  it("'Ver todos os passos' expande a lista inteira no cartão; 'Mostrar só o próximo' volta", async () => {
    serve(response({ started: true }));
    renderChecklist();
    const card = await screen.findByTestId("onboarding-card");
    fireEvent.click(within(card).getByRole("button", { name: /Ver todos os passos/ }));
    expect(within(card).getAllByTestId(/^onboarding-step-/)).toHaveLength(5);
    expect(within(card).getByText("/opt/tws-projects")).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: /Mostrar só o próximo/ }));
    expect(within(card).getAllByTestId(/^onboarding-step-/)).toHaveLength(1);
  });

  it("'Como fazer' explica o que é, por que importa e o passo a passo, com o botão para a tela certa", async () => {
    serve(response({ started: true }));
    renderChecklist();
    const item = await screen.findByTestId("onboarding-step-two-factor");
    expect(within(item).getByText("O que é")).toBeInTheDocument();
    expect(within(item).getByText("Por que importa")).toBeInTheDocument();
    fireEvent.click(within(item).getByRole("button", { name: /Como fazer/ }));
    expect(within(item).queryByText("O que é")).not.toBeInTheDocument();
    fireEvent.click(within(item).getByRole("button", { name: /Como fazer/ }));
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

describe("domínio do painel (deixou de ser 'em breve')", () => {
  it("passo a passo real e o botão para Configurações → Domínio do painel", async () => {
    serve(response({}, { "panel-domain": "pending" }));
    renderChecklist();
    const item = await screen.findByTestId("onboarding-step-panel-domain");
    fireEvent.click(within(item).getByRole("button", { name: /Como fazer/ }));
    expect(within(item).getByText(/IP da VPS no nome/)).toBeInTheDocument();
    expect(within(item).getByText(/nuvem cinza/)).toBeInTheDocument();
    expect(within(item).getByText(/Verificar DNS/)).toBeInTheDocument();
    expect(within(item).getByText(/entre de novo/)).toBeInTheDocument();
    expect(within(item).getByText(/Desativar o acesso pelo IP/)).toBeInTheDocument();
    expect(within(item).getByRole("link", { name: /Abrir Domínio do painel/ })).toHaveAttribute(
      "href",
      "/settings/panel-domain",
    );
  });
});

describe("passo das notificações", () => {
  it("passo a passo do Telegram (@BotFather, /start, Conectar, Enviar teste) e o botão para a tela", async () => {
    serve(response({}, { notifications: "pending" }));
    renderChecklist();
    const item = await screen.findByTestId("onboarding-step-notifications");
    fireEvent.click(within(item).getByRole("button", { name: /Como fazer/ }));
    expect(within(item).getByText(/@BotFather/)).toBeInTheDocument();
    expect(within(item).getByText(/clique em Conectar/)).toBeInTheDocument();
    expect(within(item).getByText(/Enviar teste/)).toBeInTheDocument();
    expect(within(item).getByText(/só o Telegram, só o e-mail ou os dois/)).toBeInTheDocument();
    expect(within(item).getByRole("link", { name: /Abrir Notificações/ })).toHaveAttribute("href", "/settings/notifications");
  });
});

// Validação real (07/10/2026): com os passos 1 a 4 feitos e o 5 "em breve",
// o cartão sumiu do Dashboard como se estivesse tudo pronto. O dono esperava
// continuar vendo o progresso e o que ainda vem.
describe("só falta o que chega em breve", () => {
  const waiting = { "two-factor": "done", "panel-domain": "done", email: "done" } as const;

  it("no Dashboard o cartão continua, compacto, com a mensagem e 'Ocultar até ter novidade'", async () => {
    serve(response({ started: true }, waiting));
    renderChecklist("dashboard");
    const card = await screen.findByTestId("onboarding-card");
    expect(within(card).getAllByRole("button", { name: /^\d\. / })).toHaveLength(5);
    expect(within(card).getByText(/4 feitos · 1 em breve no painel/)).toBeInTheDocument();
    expect(within(card).getByTestId("onboarding-waiting")).toHaveTextContent(
      "Tudo o que dá para fazer agora está feito. Notificações chega em breve.",
    );
    expect(within(card).queryAllByTestId(/^onboarding-step-/)).toHaveLength(0);
    expect(within(card).getByRole("button", { name: /Ocultar até ter novidade/ })).toBeInTheDocument();
    expect(within(card).queryByText(/Tudo pronto/)).not.toBeInTheDocument();
  });

  it("mais de um passo em breve: cita todos", async () => {
    serve(response({ started: true }, { "two-factor": "done", email: "skipped" }));
    renderChecklist("dashboard");
    expect(await screen.findByTestId("onboarding-waiting")).toHaveTextContent(
      "Domínio do painel e Notificações chegam em breve.",
    );
  });

  it("clicar num número ou em 'Ver todos os passos' ainda mostra os passos", async () => {
    serve(response({ started: true }, waiting));
    renderChecklist("dashboard");
    const card = await screen.findByTestId("onboarding-card");
    fireEvent.click(within(card).getByRole("button", { name: /Ver todos os passos/ }));
    expect(within(card).getAllByTestId(/^onboarding-step-/)).toHaveLength(5);
    fireEvent.click(within(card).getByRole("button", { name: /Recolher a lista/ }));
    expect(within(card).getByTestId("onboarding-waiting")).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: /5\. Notificações/ }));
    expect(within(card).getByTestId("onboarding-step-notifications")).toBeInTheDocument();
    expect(within(card).queryByTestId("onboarding-waiting")).not.toBeInTheDocument();
  });

  it("'Ocultar até ter novidade' grava na conta e o cartão sai do Dashboard", async () => {
    serve(response({ started: true }, waiting));
    const onVisibleChange = vi.fn();
    const router = createMemoryRouter([{ path: "*", element: <OnboardingChecklist variant="dashboard" onVisibleChange={onVisibleChange} /> }]);
    render(<RouterProvider router={router} />);
    fireEvent.click(await screen.findByRole("button", { name: /Ocultar até ter novidade/ }));
    await waitFor(() => expect(screen.queryByTestId("onboarding-card")).not.toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/onboarding/hidden",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ hidden: true }) }),
    );
    expect(onVisibleChange).toHaveBeenLastCalledWith(false);
  });

  it("falha ao ocultar: o cartão fica e mostra o motivo", async () => {
    serve(response({ started: true }, waiting));
    renderChecklist("dashboard");
    const btn = await screen.findByRole("button", { name: /Ocultar até ter novidade/ });
    apiFetchMock.mockRejectedValueOnce(new Error("Ainda há passo a fazer agora."));
    fireEvent.click(btn);
    expect(await screen.findByRole("alert")).toHaveTextContent(/Ainda há passo a fazer/);
    expect(screen.getByTestId("onboarding-card")).toBeInTheDocument();
  });

  it("ocultado e sem novidade: o Dashboard não mostra o cartão", async () => {
    serve(response({ started: true, hidden: true }, waiting));
    renderChecklist("dashboard");
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId("onboarding-card")).not.toBeInTheDocument();
  });

  it("em Configurações continua visível, diz que está oculto no Dashboard e permite mostrar de novo", async () => {
    serve(response({ started: true, hidden: true }, waiting));
    renderChecklist("settings");
    const card = await screen.findByTestId("onboarding-card");
    expect(within(card).getAllByTestId(/^onboarding-step-/)).toHaveLength(5);
    expect(within(card).getByTestId("onboarding-waiting")).toHaveTextContent(/Notificações chega em breve/);
    expect(within(card).queryByRole("button", { name: /Ocultar até ter novidade/ })).not.toBeInTheDocument();
    expect(within(card).getByText(/oculto no Dashboard até ter novidade/)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: /Mostrar no Dashboard/ }));
    await waitFor(() => expect(within(card).queryByText(/oculto no Dashboard/)).not.toBeInTheDocument());
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/onboarding/hidden",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ hidden: false }) }),
    );
  });
});

describe("tudo resolvido", () => {
  const allDone = { "two-factor": "done", "panel-domain": "done", email: "skipped", notifications: "skipped" } as const;

  it("no Dashboard o cartão some", async () => {
    serve(response({ started: true, complete: true }, allDone));
    renderChecklist("dashboard");
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId("onboarding-card")).not.toBeInTheDocument();
  });

  it("em Configurações continua acessível, com todos os passos e o aviso de que está tudo pronto", async () => {
    serve(response({ started: true, complete: true }, allDone));
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
