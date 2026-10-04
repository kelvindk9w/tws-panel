/**
 * Página Envios (E-mail → Envios). Pedido do dono do produto (04/10/2026):
 * acompanhar o que o servidor de e-mail faz — fila agora (com "Tentar agora"
 * e "Cancelar"), histórico com filtros, volume em gráfico, reputação (listas
 * de bloqueio) e a nota de entregabilidade. A API é simulada.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DeliverabilityResponse,
  MailHistoryResponse,
  MailQueueResponse,
  MailReputationResponse,
  MailVolumeResponse,
} from "@paas/core";
import { MailEnviosPage } from "../src/pages/MailEnviosPage";

const ID = "333028896599011329";

const QUEUE: MailQueueResponse = {
  available: true,
  message: null,
  total: 1,
  checkedAt: "2026-10-04T15:00:00.000Z",
  items: [
    {
      id: ID,
      sender: { address: "loja@envio.exemplo.com.br", mailbox: "loja@envio.exemplo.com.br", projectId: "p1", projectName: "Loja", system: false },
      createdAt: "2026-10-04T14:00:00.000Z",
      size: 2048,
      recipients: [{ address: "pessoa@gmail.com", domain: "gmail.com", state: "deferred", detail: "421 4.7.28 rate limited" }],
      attempts: 3,
      nextRetryAt: "2026-10-04T15:30:00.000Z",
      expiresAt: "2026-10-09T14:00:00.000Z",
      lastError: "421 4.7.28 rate limited",
    },
  ],
};

const HISTORY: MailHistoryResponse = {
  items: [
    {
      at: "2026-10-04T14:00:00.000Z",
      queueId: "1",
      from: "loja@envio.exemplo.com.br",
      to: "a@gmail.com",
      toDomain: "gmail.com",
      state: "delivered",
      code: 250,
      detail: "250 2.0.0 OK gsmtp",
      remoteHost: "gmail-smtp-in.l.google.com",
      nextRetryAt: null,
      sender: { address: "loja@envio.exemplo.com.br", mailbox: "loja@envio.exemplo.com.br", projectId: "p1", projectName: "Loja", system: false },
    },
    {
      at: "2026-10-04T13:00:00.000Z",
      queueId: "2",
      from: "loja@envio.exemplo.com.br",
      to: "b@outlook.com",
      toDomain: "outlook.com",
      state: "bounced",
      code: 550,
      detail: "550 5.7.1 S3150 blocked",
      remoteHost: "outlook-com.olc.protection.outlook.com",
      nextRetryAt: null,
      sender: { address: "loja@envio.exemplo.com.br", mailbox: "loja@envio.exemplo.com.br", projectId: "p1", projectName: "Loja", system: false },
    },
  ],
  total: 2,
  collectedAt: "2026-10-04T15:00:00.000Z",
  collectError: null,
  retentionDays: 30,
  projects: [{ id: "p1", name: "Loja" }],
  mailboxes: ["loja@envio.exemplo.com.br"],
  domains: ["gmail.com", "outlook.com"],
};

const days = Array.from({ length: 14 }, (_, i) => ({
  date: new Date(Date.UTC(2026, 8, 21 + i)).toISOString().slice(0, 10),
  delivered: i === 13 ? 40 : 0,
  bounced: i === 13 ? 2 : 0,
  deferred: i === 13 ? 1 : 0,
  cancelled: 0,
}));

const VOLUME: MailVolumeResponse = {
  days,
  byProject: [{ projectId: "p1", name: "Loja", delivered: 40, bounced: 2, deferred: 1 }],
  totals: { delivered: 40, bounced: 2, deferred: 1, cancelled: 0, recipients: 43 },
  bounceRate: { value: 2 / 42, limit: 0.02, high: true },
  deferRate: { value: 1 / 43, limit: 0.05, high: false },
  complaintRate: null,
  lowVolume: true,
};

const REPUTATION: MailReputationResponse = {
  lastCheck: {
    checkedAt: "2026-10-04T12:00:00.000Z",
    ip: {
      target: "203.0.113.10",
      results: [
        { dnsbl: "spamhaus-zen", label: "Spamhaus ZEN", status: "clean", detail: null, removalUrl: null, lookupUrl: "https://check.spamhaus.org/" },
        { dnsbl: "spamcop", label: "SpamCop", status: "listed", detail: "Listado (retorno 127.0.0.2).", removalUrl: "https://www.spamcop.net/bl.shtml", lookupUrl: "https://www.spamcop.net/bl.shtml" },
        {
          dnsbl: "barracuda",
          label: "Barracuda Reputation",
          status: "unknown",
          detail: "A Barracuda só responde a servidores DNS cadastrados nela.",
          removalUrl: null,
          lookupUrl: "https://www.barracudacentral.org/lookups",
        },
      ],
    },
    domains: [],
    listedCount: 1,
  },
  lastError: null,
  checking: false,
  nextCheckAt: "2026-10-05T12:00:00.000Z",
  dqs: { configured: false, hint: null },
};

const SCORE: DeliverabilityResponse = {
  score: 62,
  max: 100,
  band: "yellow",
  factsAt: "2026-10-04T12:00:00.000Z",
  marks: { googleAt: null, microsoftAt: null, spamRateOkAt: null },
  items: [
    { id: "dns", label: "DNS do e-mail (SPF, DKIM, DMARC, A, MX)", status: "done", points: 25, maxPoints: 25, detail: "6/6 certos no checklist DNS (1 domínio).", howTo: null, link: null },
    {
      id: "ptr",
      label: "Nome reverso do IP (PTR)",
      status: "partial",
      points: 5,
      maxPoints: 10,
      detail: "Genérico do provedor.",
      howTo: "Troque o nome reverso.",
      link: { label: "Abrir a página E-mail", href: "/mail" },
    },
    {
      id: "google-postmaster",
      label: "Google Postmaster Tools cadastrado",
      status: "todo",
      points: 0,
      maxPoints: 3,
      detail: "Ainda não marcado.",
      howTo: "Cadastre.",
      link: { label: "Abrir o Postmaster Tools", href: "https://postmaster.google.com/" },
    },
    { id: "dmarc-reports", label: "Relatórios DMARC sem falha", status: "unknown", points: 0, maxPoints: 5, detail: "O painel ainda não lê.", howTo: null, link: null },
  ],
};

type Reply = { status: number; body: unknown };
function mockApi(handler: (url: string, init?: RequestInit) => Reply | undefined) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const reply =
      handler(url, init) ??
      (url.startsWith("/api/mail/envios/queue")
        ? { status: 200, body: QUEUE }
        : url.startsWith("/api/mail/envios/history")
          ? { status: 200, body: HISTORY }
          : url.startsWith("/api/mail/envios/volume")
            ? { status: 200, body: VOLUME }
            : url.startsWith("/api/mail/envios/reputation")
              ? { status: 200, body: REPUTATION }
              : url.startsWith("/api/mail/envios/deliverability")
                ? { status: 200, body: SCORE }
                : { status: 404, body: { error: "not_found", message: "?" } });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage(path = "/mail/envios") {
  render(
    <MemoryRouter initialEntries={[path]}>
      <MailEnviosPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Envios — fila agora", () => {
  it("mostra destino, remetente com projeto, tentativas, próxima tentativa e motivo", async () => {
    mockApi(() => undefined);
    renderPage();
    const item = await screen.findByTestId(`queue-${ID}`);
    expect(within(item).getByText("pessoa@gmail.com")).toBeInTheDocument();
    expect(within(item).getByText(/Loja/)).toBeInTheDocument();
    expect(within(item).getByText(/loja@envio\.exemplo\.com\.br/)).toBeInTheDocument();
    expect(within(item).getByText(/3 tentativas/)).toBeInTheDocument();
    expect(within(item).getByText(/Próxima tentativa/)).toBeInTheDocument();
    expect(within(item).getAllByText(/421 4\.7\.28 rate limited/).length).toBeGreaterThan(0);
    expect(within(item).getByText("Adiada")).toBeInTheDocument();
  });

  it("Tentar agora pede confirmação explicando que é a última tentativa, e chama a API com o id inteiro", async () => {
    const fetchMock = mockApi((url, init) =>
      init?.method === "POST" && url.endsWith("/retry") ? { status: 200, body: { ok: true, message: "Tentando entregar agora." } } : undefined,
    );
    renderPage();
    const item = await screen.findByTestId(`queue-${ID}`);
    await userEvent.click(within(item).getByRole("button", { name: "Tentar agora" }));
    expect(within(item).getByText(/última tentativa/i)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/retry"))).toBe(false);
    await userEvent.click(within(item).getByRole("button", { name: "Sim, tentar agora" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u) === `/api/mail/envios/queue/${ID}/retry`)).toBe(true));
    expect(await screen.findByText("Tentando entregar agora.")).toBeInTheDocument();
  });

  it("Cancelar pede confirmação; desistir não chama a API", async () => {
    const fetchMock = mockApi((url, init) =>
      init?.method === "POST" && url.endsWith("/cancel") ? { status: 200, body: { ok: true, message: "Mensagem tirada da fila." } } : undefined,
    );
    renderPage();
    const item = await screen.findByTestId(`queue-${ID}`);
    await userEvent.click(within(item).getByRole("button", { name: "Cancelar" }));
    await userEvent.click(within(item).getByRole("button", { name: "Não" }));
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/cancel"))).toBe(false);
    await userEvent.click(within(item).getByRole("button", { name: "Cancelar" }));
    await userEvent.click(within(item).getByRole("button", { name: "Sim, cancelar" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u) === `/api/mail/envios/queue/${ID}/cancel`)).toBe(true));
    expect(await screen.findByText("Mensagem tirada da fila.")).toBeInTheDocument();
  });

  it("erro da ação aparece para a pessoa", async () => {
    mockApi((url, init) =>
      init?.method === "POST" ? { status: 404, body: { error: "queue_message_not_found", message: "Essa mensagem já saiu da fila." } } : undefined,
    );
    renderPage();
    const item = await screen.findByTestId(`queue-${ID}`);
    await userEvent.click(within(item).getByRole("button", { name: "Cancelar" }));
    await userEvent.click(within(item).getByRole("button", { name: "Sim, cancelar" }));
    expect(await screen.findByText("Essa mensagem já saiu da fila.")).toBeInTheDocument();
  });

  it("fila vazia e servidor indisponível", async () => {
    mockApi((url) => (url.startsWith("/api/mail/envios/queue") ? { status: 200, body: { ...QUEUE, items: [], total: 0 } } : undefined));
    renderPage();
    expect(await screen.findByText(/A fila está vazia/)).toBeInTheDocument();
    cleanup();
    mockApi((url) =>
      url.startsWith("/api/mail/envios/queue")
        ? { status: 200, body: { ...QUEUE, available: false, items: [], total: 0, message: "O servidor de e-mail ainda não foi criado." } }
        : undefined,
    );
    renderPage();
    expect(await screen.findByText("O servidor de e-mail ainda não foi criado.")).toBeInTheDocument();
  });
});

describe("Envios — histórico", () => {
  it("lista com estado, motivo e servidor; filtros mudam a consulta", async () => {
    const fetchMock = mockApi(() => undefined);
    renderPage();
    await userEvent.click(await screen.findByRole("tab", { name: "Histórico" }));
    const recusada = await screen.findByTestId("history-2-b@outlook.com");
    expect(within(recusada).getByText("Recusada")).toBeInTheDocument();
    expect(within(recusada).getByText(/550 5\.7\.1 S3150 blocked/)).toBeInTheDocument();
    expect(within(recusada).getByText(/sender\.office\.com/)).toBeInTheDocument(); // dica do bloqueio da Microsoft

    await userEvent.selectOptions(screen.getByLabelText("Estado"), "bounced");
    await userEvent.selectOptions(screen.getByLabelText("Projeto"), "p1");
    await userEvent.selectOptions(screen.getByLabelText("Domínio de destino"), "outlook.com");
    await userEvent.selectOptions(screen.getByLabelText("Caixa"), "loja@envio.exemplo.com.br");
    await userEvent.selectOptions(screen.getByLabelText("Período"), "30");
    await userEvent.type(screen.getByLabelText("Buscar"), "S3150");
    await waitFor(() => {
      const last = String(fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/api/mail/envios/history")).at(-1)![0]);
      const qs = new URLSearchParams(last.split("?")[1]);
      expect(qs.get("state")).toBe("bounced");
      expect(qs.get("projectId")).toBe("p1");
      expect(qs.get("domain")).toBe("outlook.com");
      expect(qs.get("mailbox")).toBe("loja@envio.exemplo.com.br");
      expect(qs.get("days")).toBe("30");
      expect(qs.get("q")).toBe("S3150");
    });
  });

  it("aviso quando a leitura do registro falhou e lista vazia", async () => {
    mockApi((url) =>
      url.startsWith("/api/mail/envios/history")
        ? { status: 200, body: { ...HISTORY, items: [], total: 0, collectError: "No such container: paas-stalwart" } }
        : undefined,
    );
    renderPage();
    await userEvent.click(await screen.findByRole("tab", { name: "Histórico" }));
    expect(await screen.findByText(/No such container/)).toBeInTheDocument();
    expect(screen.getByText(/Nenhum envio/)).toBeInTheDocument();
  });
});

describe("Envios — volume", () => {
  it("gráfico de 14 barras acessível, taxas com destaque e tabela", async () => {
    mockApi(() => undefined);
    renderPage();
    await userEvent.click(await screen.findByRole("tab", { name: "Volume" }));
    const chart = await screen.findByRole("img", { name: /Envios por dia/ });
    expect(within(chart).getAllByTestId("volume-bar")).toHaveLength(14);
    expect(within(chart).getByLabelText(/04\/10: 40 entregues, 2 recusadas, 1 adiada/)).toBeInTheDocument();
    const bounce = screen.getByTestId("rate-bounce");
    expect(bounce).toHaveTextContent("4,8%");
    expect(bounce).toHaveTextContent(/acima de 2%/);
    expect(screen.getByTestId("rate-defer")).toHaveTextContent("2,3%");
    expect(screen.getByText(/Poucos envios/)).toBeInTheDocument();
    expect(screen.getByText(/Reclamações/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Ver como tabela" }));
    expect(screen.getByRole("table")).toHaveTextContent("40");
    expect(screen.getByTestId("project-p1")).toHaveTextContent("Loja");
  });
});

describe("Envios — reputação", () => {
  it("limpo, listado com link de remoção e 'não deu para verificar' (nunca como limpo)", async () => {
    mockApi(() => undefined);
    renderPage();
    await userEvent.click(await screen.findByRole("tab", { name: "Reputação" }));
    const zen = await screen.findByTestId("bl-203.0.113.10-spamhaus-zen");
    expect(within(zen).getByText("Limpo")).toBeInTheDocument();
    const spamcop = screen.getByTestId("bl-203.0.113.10-spamcop");
    expect(within(spamcop).getByText("Listado")).toBeInTheDocument();
    expect(within(spamcop).getByRole("link", { name: /Pedir remoção/ })).toHaveAttribute("href", "https://www.spamcop.net/bl.shtml");
    const barracuda = screen.getByTestId("bl-203.0.113.10-barracuda");
    expect(within(barracuda).getByText("Não deu para verificar")).toBeInTheDocument();
    expect(within(barracuda).queryByText("Limpo")).not.toBeInTheDocument();
    expect(within(barracuda).getByRole("link", { name: /Conferir no site/ })).toHaveAttribute("href", "https://www.barracudacentral.org/lookups");
  });

  it("Conferir agora chama a API; erro 429 aparece", async () => {
    const fetchMock = mockApi((url, init) =>
      init?.method === "POST" && url.endsWith("/reputation/check")
        ? { status: 429, body: { error: "check_too_soon", message: "Espere um minuto para conferir de novo." } }
        : undefined,
    );
    renderPage();
    await userEvent.click(await screen.findByRole("tab", { name: "Reputação" }));
    await userEvent.click(await screen.findByRole("button", { name: "Conferir agora" }));
    expect(await screen.findByText("Espere um minuto para conferir de novo.")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u, i]) => String(u) === "/api/mail/envios/reputation/check" && i?.method === "POST")).toBe(true);
  });

  it("chave DQS: salva sem mostrar de volta; nunca conferido mostra o aviso", async () => {
    const fetchMock = mockApi((url, init) =>
      init?.method === "PUT"
        ? { status: 200, body: { ...REPUTATION, dqs: { configured: true, hint: "cdef" } } }
        : url.startsWith("/api/mail/envios/reputation")
          ? { status: 200, body: { ...REPUTATION, lastCheck: null } }
          : undefined,
    );
    renderPage();
    await userEvent.click(await screen.findByRole("tab", { name: "Reputação" }));
    expect(await screen.findByText(/Ainda não conferido/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Chave DQS/), "abcdefghij0123456789abcdef");
    await userEvent.click(screen.getByRole("button", { name: "Salvar chave" }));
    expect(await screen.findByText(/termina em cdef/)).toBeInTheDocument();
    const put = fetchMock.mock.calls.find(([, i]) => i?.method === "PUT")!;
    expect(JSON.parse(String(put[1]!.body))).toEqual({ key: "abcdefghij0123456789abcdef" });
    await userEvent.click(screen.getByRole("button", { name: "Apagar chave" }));
    await waitFor(() => expect(JSON.parse(String(fetchMock.mock.calls.filter(([, i]) => i?.method === "PUT").at(-1)![1]!.body))).toEqual({ key: null }));
  });
});

describe("Envios — nota", () => {
  it("nota, faixa e o que falta, com links; marcar o Postmaster com data", async () => {
    const fetchMock = mockApi((url, init) =>
      init?.method === "PUT" && url.endsWith("/postmaster") ? { status: 200, body: { marks: { googleAt: "2026-10-01T00:00:00.000Z", microsoftAt: null, spamRateOkAt: null } } } : undefined,
    );
    renderPage();
    await userEvent.click(await screen.findByRole("tab", { name: "Nota" }));
    expect(await screen.findByText("62")).toBeInTheDocument();
    expect(screen.getByText(/Vai chegar, mas com risco de spam/)).toBeInTheDocument();
    const ptr = screen.getByTestId("score-ptr");
    expect(within(ptr).getByText("5/10")).toBeInTheDocument();
    expect(within(ptr).getByText("Troque o nome reverso.")).toBeInTheDocument();
    expect(within(screen.getByTestId("score-dmarc-reports")).getByText("Não deu para verificar")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Abrir o Postmaster Tools/ })).toHaveAttribute("href", "https://postmaster.google.com/");
    expect(screen.getAllByRole("link", { name: /SNDS/ }).length).toBeGreaterThan(0);

    await userEvent.type(screen.getByLabelText(/Cadastrei no Google Postmaster Tools em/), "2026-10-01");
    await userEvent.click(screen.getByRole("button", { name: "Salvar marcações" }));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([u, i]) => String(u).endsWith("/postmaster") && i?.method === "PUT");
      expect(JSON.parse(String(put![1]!.body))).toMatchObject({ googleAt: "2026-10-01" });
    });
  });
});

describe("Envios — abas pelo endereço", () => {
  it("?aba=reputacao abre direto na reputação", async () => {
    mockApi(() => undefined);
    renderPage("/mail/envios?aba=reputacao");
    expect(await screen.findByTestId("bl-203.0.113.10-spamhaus-zen")).toBeInTheDocument();
  });
});
