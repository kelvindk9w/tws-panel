/**
 * notification-settings.test.tsx — Configurações → Notificações.
 *
 * API simulada com estado: colar o token → mandar /start e Conectar →
 * Enviar teste → Desconectar; e-mail (indisponível e disponível), o que
 * avisa e o histórico. O token nunca é mostrado depois de salvo.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationsStatus } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ApiRequestError } from "@/lib/api";
import { NotificationSettings } from "@/pages/settings/NotificationSettings";

const TOKEN = "123456789:AAEXEMPLOxxxxxxxxxxxxxxxxxxxxxxxxxx";

let state: NotificationsStatus;
let failures: Record<string, ApiRequestError>;

function base(): NotificationsStatus {
  return {
    telegram: { state: "none", botUsername: null, chatTitle: null, connectedAt: null, testedAt: null },
    email: {
      available: false,
      unavailableReason: "O servidor de e-mail do painel não foi iniciado.",
      from: null,
      recipients: [],
      testedAt: null,
    },
    kinds: { security: true, deploy: true, certificate: true, blacklist: true, disk: true, panel: false },
    history: [],
  };
}

function handler(path: string, init?: RequestInit): unknown {
  const method = init?.method ?? "GET";
  const key = `${method} ${path}`;
  if (failures[key]) throw failures[key];
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  switch (key) {
    case "GET /api/security/monitor/last":
      return { config: { intervalMs: 6 * 3_600_000 } };
    case "GET /api/notifications":
      return state;
    case "PUT /api/notifications/telegram":
      state = { ...state, telegram: { ...state.telegram, state: "awaiting_chat", botUsername: "meu_painel_bot" } };
      return state;
    case "POST /api/notifications/telegram/connect":
      state = {
        ...state,
        telegram: { ...state.telegram, state: "connected", chatTitle: "Maria Silva", connectedAt: "2026-10-07T12:00:00Z" },
      };
      return state;
    case "POST /api/notifications/telegram/test":
      state = {
        ...state,
        telegram: { ...state.telegram, testedAt: "2026-10-07T12:01:00Z" },
        history: [
          { id: "h1", at: "2026-10-07T12:01:00Z", channel: "telegram", kind: "test", title: "Teste de notificação", status: "sent", detail: null },
          ...state.history,
        ],
      };
      return state;
    case "DELETE /api/notifications/telegram":
      state = { ...state, telegram: base().telegram };
      return state;
    case "PUT /api/notifications/email":
      state = { ...state, email: { ...state.email, recipients: body.recipients as string[] } };
      return state;
    case "POST /api/notifications/email/test":
      state = { ...state, email: { ...state.email, testedAt: "2026-10-07T12:02:00Z" } };
      return state;
    case "DELETE /api/notifications/email":
      state = { ...state, email: { ...state.email, recipients: [], testedAt: null } };
      return state;
    case "PUT /api/notifications/kinds":
      state = { ...state, kinds: { ...state.kinds, ...(body.kinds as object) } };
      return state;
    default:
      throw new Error(`rota inesperada ${key}`);
  }
}

beforeEach(() => {
  state = base();
  failures = {};
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => handler(path, init));
});
afterEach(cleanup);

function renderPage() {
  return render(
    <MemoryRouter>
      <NotificationSettings />
    </MemoryRouter>,
  );
}

function callsTo(method: string, path: string) {
  return apiFetchMock.mock.calls.filter((c) => c[0] === path && ((c[1] as RequestInit | undefined)?.method ?? "GET") === method);
}

describe("Telegram", () => {
  it("fluxo completo: colar o token → /start → Conectar → Enviar teste → Desconectar", async () => {
    renderPage();
    const card = await screen.findByTestId("telegram-card");
    expect(within(card).getByRole("link", { name: /@BotFather/ })).toHaveAttribute("href", "https://t.me/BotFather");

    fireEvent.change(within(card).getByLabelText(/Token do robô/), { target: { value: `  ${TOKEN} ` } });
    fireEvent.click(within(card).getByRole("button", { name: "Salvar token" }));
    await waitFor(() => expect(card).toHaveTextContent(/Robô @meu_painel_bot conferido/));
    expect(JSON.parse(String(callsTo("PUT", "/api/notifications/telegram")[0]![1].body))).toEqual({ token: TOKEN });
    expect(within(card).getByRole("link", { name: /Abrir @meu_painel_bot/ })).toHaveAttribute("href", "https://t.me/meu_painel_bot");
    expect(card).toHaveTextContent("/start");
    // o token não aparece mais na tela
    expect(card.innerHTML).not.toContain("AAEXEMPLO");

    fireEvent.click(within(card).getByRole("button", { name: "Conectar" }));
    await waitFor(() => expect(card).toHaveTextContent("Maria Silva"));
    expect(card).toHaveTextContent(/Falta enviar o teste/);

    fireEvent.click(within(card).getByRole("button", { name: "Enviar teste" }));
    await waitFor(() => expect(card).toHaveTextContent(/Mensagem de teste enviada/));
    expect(card).toHaveTextContent(/Testado/);
    expect(screen.getByTestId("history-card")).toHaveTextContent("Teste de notificação");

    fireEvent.click(within(card).getByRole("button", { name: "Desconectar" }));
    fireEvent.click(within(card).getByRole("button", { name: "Sim, desconectar" }));
    await waitFor(() => expect(within(card).getByLabelText(/Token do robô/)).toBeInTheDocument());
  });

  it("Salvar sem token: botão desligado; token recusado: mostra o motivo", async () => {
    failures["PUT /api/notifications/telegram"] = new ApiRequestError(400, "invalid_token", "O Telegram não reconheceu o token.");
    renderPage();
    const card = await screen.findByTestId("telegram-card");
    expect(within(card).getByRole("button", { name: "Salvar token" })).toBeDisabled();
    fireEvent.change(within(card).getByLabelText(/Token do robô/), { target: { value: TOKEN } });
    fireEvent.click(within(card).getByRole("button", { name: "Salvar token" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent("O Telegram não reconheceu o token.");
  });

  it("Conectar antes do /start: explica e deixa tentar de novo; 'Trocar robô' volta ao token", async () => {
    state.telegram = { ...state.telegram, state: "awaiting_chat", botUsername: "meu_painel_bot" };
    failures["POST /api/notifications/telegram/connect"] = new ApiRequestError(
      409,
      "telegram_no_chat",
      "Ainda não chegou nenhuma mensagem para @meu_painel_bot. Mande /start.",
    );
    renderPage();
    const card = await screen.findByTestId("telegram-card");
    fireEvent.click(await within(card).findByRole("button", { name: "Conectar" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent(/Ainda não chegou/);
    fireEvent.click(within(card).getByRole("button", { name: "Trocar robô" }));
    await waitFor(() => expect(within(card).getByLabelText(/Token do robô/)).toBeInTheDocument());
  });

  it("teste que falha mostra o motivo; 'Não' cancela o desconectar; erro genérico vira texto padrão", async () => {
    state.telegram = { state: "connected", botUsername: "b_bot", chatTitle: "Equipe", connectedAt: "2026-10-07T12:00:00Z", testedAt: null };
    failures["POST /api/notifications/telegram/test"] = new ApiRequestError(502, "telegram_send_failed", "O robô foi bloqueado.");
    failures["DELETE /api/notifications/telegram"] = new Error("rede") as ApiRequestError;
    renderPage();
    const card = await screen.findByTestId("telegram-card");
    fireEvent.click(await within(card).findByRole("button", { name: "Enviar teste" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent("O robô foi bloqueado.");
    fireEvent.click(within(card).getByRole("button", { name: "Desconectar" }));
    fireEvent.click(within(card).getByRole("button", { name: "Não" }));
    expect(within(card).queryByRole("button", { name: "Sim, desconectar" })).not.toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Desconectar" }));
    fireEvent.click(within(card).getByRole("button", { name: "Sim, desconectar" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent(/Não foi possível/);
  });
});

describe("E-mail", () => {
  it("servidor de e-mail não pronto: explica o que falta, leva à página E-mail e sugere o Telegram", async () => {
    renderPage();
    const card = await screen.findByTestId("email-card");
    expect(card).toHaveTextContent("O servidor de e-mail do painel não foi iniciado.");
    expect(within(card).getByRole("link", { name: /Abrir E-mail/ })).toHaveAttribute("href", "/mail");
    expect(card).toHaveTextContent(/Telegram/);
    expect(within(card).queryByLabelText(/Endereços/)).not.toBeInTheDocument();
  });

  it("pronto: salva endereços (vírgula ou linha), testa e desliga", async () => {
    state.email = { available: true, unavailableReason: null, from: "postmaster@envio.exemplo.com.br", recipients: [], testedAt: null };
    renderPage();
    const card = await screen.findByTestId("email-card");
    expect(card).toHaveTextContent("postmaster@envio.exemplo.com.br");
    fireEvent.change(within(card).getByLabelText(/Endereços/), { target: { value: "a@exemplo.org, b@exemplo.org\n\n" } });
    fireEvent.click(within(card).getByRole("button", { name: "Salvar endereços" }));
    await waitFor(() => expect(within(card).getByRole("button", { name: "Enviar teste" })).toBeInTheDocument());
    expect(JSON.parse(String(callsTo("PUT", "/api/notifications/email")[0]![1].body))).toEqual({
      recipients: ["a@exemplo.org", "b@exemplo.org"],
    });
    expect(card).toHaveTextContent(/Falta enviar o teste/);
    fireEvent.click(within(card).getByRole("button", { name: "Enviar teste" }));
    await waitFor(() => expect(card).toHaveTextContent(/E-mail de teste enviado/));
    fireEvent.click(within(card).getByRole("button", { name: "Desligar e-mail" }));
    await waitFor(() => expect(within(card).queryByRole("button", { name: "Enviar teste" })).not.toBeInTheDocument());
  });

  it("endereço recusado pelo servidor: mostra o motivo", async () => {
    state.email = { available: true, unavailableReason: null, from: "postmaster@envio.exemplo.com.br", recipients: [], testedAt: null };
    failures["PUT /api/notifications/email"] = new ApiRequestError(400, "invalid_recipient", '"x" não é um endereço de e-mail válido.');
    renderPage();
    const card = await screen.findByTestId("email-card");
    fireEvent.change(within(card).getByLabelText(/Endereços/), { target: { value: "x" } });
    fireEvent.click(within(card).getByRole("button", { name: "Salvar endereços" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent(/não é um endereço/);
  });

  it("endereços salvos mas o servidor parou: avisa que os e-mails não vão sair", async () => {
    state.email = { ...state.email, recipients: ["a@exemplo.org"], testedAt: "2026-10-07T12:00:00Z" };
    renderPage();
    const card = await screen.findByTestId("email-card");
    expect(card).toHaveTextContent(/não vão sair/);
    expect(within(card).getByLabelText(/Endereços/)).toHaveValue("a@exemplo.org");
  });
});

describe("O que avisa", () => {
  it("liga e desliga por tipo, salvando na hora; erro volta a escolha", async () => {
    renderPage();
    const card = await screen.findByTestId("kinds-card");
    const panel = within(card).getByRole("checkbox", { name: /Painel reiniciado/ });
    expect(panel).not.toBeChecked();
    fireEvent.click(panel);
    await waitFor(() => expect(within(card).getByRole("checkbox", { name: /Painel reiniciado/ })).toBeChecked());
    expect(JSON.parse(String(callsTo("PUT", "/api/notifications/kinds")[0]![1].body))).toEqual({ kinds: { panel: true } });
    // sem canal conectado: lembra que nada sai ainda
    expect(card).toHaveTextContent(/Conecte o Telegram ou o e-mail/);

    failures["PUT /api/notifications/kinds"] = new ApiRequestError(500, "internal_error", "Falhou ao salvar.");
    fireEvent.click(within(card).getByRole("checkbox", { name: /Disco quase cheio/ }));
    expect(await within(card).findByRole("alert")).toHaveTextContent("Falhou ao salvar.");
    expect(within(card).getByRole("checkbox", { name: /Disco quase cheio/ })).toBeChecked();
  });
});

describe("Histórico", () => {
  it("lista os envios com o estado (sem conteúdo), mais recentes primeiro", async () => {
    state.telegram = { state: "connected", botUsername: "b_bot", chatTitle: "Equipe", connectedAt: "2026-10-07T12:00:00Z", testedAt: "2026-10-07T12:00:00Z" };
    state.history = [
      { id: "1", at: "2026-10-07T12:05:00Z", channel: "email", kind: "deploy", title: "Deploy de Loja falhou", status: "failed", detail: "Servidor parado." },
      { id: "2", at: "2026-10-07T12:04:00Z", channel: "telegram", kind: "security", title: "Porta nova", status: "retrying", detail: "Sem resposta." },
      { id: "3", at: "2026-10-07T12:03:00Z", channel: "telegram", kind: "summary", title: "Resumo", status: "sent", detail: null },
    ];
    renderPage();
    const card = await screen.findByTestId("history-card");
    const rows = within(card).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent(/E-mail.*Deploy de Loja falhou.*Servidor parado\..*Falhou/);
    expect(rows[1]).toHaveTextContent(/Telegram.*Porta nova.*Tentando de novo/);
    expect(rows[2]).toHaveTextContent(/Enviado/);
    expect(screen.getByTestId("kinds-card")).not.toHaveTextContent(/Conecte o Telegram ou o e-mail/);
  });

  it("sem envios: diz que ainda não houve", async () => {
    renderPage();
    expect(await screen.findByTestId("history-card")).toHaveTextContent(/Nenhum aviso enviado ainda/);
  });
});

describe("carga", () => {
  it("falha ao carregar: mensagem e botão de tentar de novo", async () => {
    failures["GET /api/notifications"] = new ApiRequestError(500, "internal_error", "Não foi possível concluir agora.");
    renderPage();
    expect(await screen.findByText("Não foi possível concluir agora.")).toBeInTheDocument();
    delete failures["GET /api/notifications"];
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByTestId("telegram-card")).toBeInTheDocument();
  });
});

describe("verificação automática (continua na tela)", () => {
  it("salva a frequência em horas", async () => {
    renderPage();
    const input = await screen.findByLabelText(/A cada quantas horas/);
    expect(input).toHaveValue(6);
  });
});
