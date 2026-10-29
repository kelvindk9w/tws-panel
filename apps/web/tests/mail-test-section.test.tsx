/**
 * mail-test-section.test.tsx — aba "Caixa de teste": ligar, aviso de reinício com o botão, desligar
 * perguntando das mensagens, lista, mensagem aberta (iframe isolado, abas, anexos, links, apagar),
 * e a faixa no topo do projeto.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailTestMessage, MailTestView } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => true) }));

import { setLocale } from "@/i18n/core";
import { MailTestSection } from "@/components/project/MailTestSection";
import { MailTestBanner } from "@/components/project/MailTestBanner";

const BASE = "/api/projects/p1/mail-test";
let view: MailTestView;
let calls: Array<{ url: string; method: string; body: unknown }>;
let failNext: string | null;

function makeView(over: Partial<MailTestView> = {}): MailTestView {
  return {
    enabled: true,
    settings: { enabled: true, maxMessages: 500, maxAgeDays: 7 },
    container: "running",
    smtpHost: "paas-mailtest-loja",
    smtpPort: 1025,
    redirectedVariables: ["SMTP_HOST", "SMTP_PORT"],
    needsRestart: false,
    maxMessageBytes: 4 * 1024 * 1024,
    diskBudgetBytes: 2 * 1024 * 1024 * 1024,
    databaseBytes: 3 * 1024 * 1024,
    messages: 2,
    unread: 1,
    problem: null,
    uncontrolled: [],
    ...over,
  };
}

const MESSAGE: MailTestMessage = {
  id: "m1",
  subject: "Bem-vindo",
  from: { name: "Loja", address: "loja@example.com" },
  to: [{ name: "", address: "cliente@example.com" }],
  created: "2026-10-27T10:00:00Z",
  read: false,
  size: 2048,
  attachments: 1,
  snippet: "Olá",
  cc: [{ name: "", address: "cc@example.com" }],
  bcc: [],
  replyTo: [],
  text: "Texto simples",
  hasHtml: true,
  headers: [{ name: "Subject", value: "Bem-vindo" }],
  attachmentList: [{ partId: "2", fileName: "nota.pdf", contentType: "application/pdf", size: 3 * 1024 * 1024, inline: false }],
  links: ["https://example.com/confirmar"],
};

function summary(id: string, over: Record<string, unknown> = {}) {
  const { text: _t, hasHtml: _h, headers: _hd, attachmentList: _a, links: _l, cc: _c, bcc: _b, replyTo: _r, ...rest } = MESSAGE;
  return { ...rest, id, ...over };
}

let list: ReturnType<typeof summary>[];

beforeEach(() => {
  setLocale("pt-BR");
  view = makeView();
  calls = [];
  failNext = null;
  list = [summary("m1"), summary("m2", { subject: "", read: true, attachments: 0, from: null, snippet: "" })];
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    if (failNext && method !== "GET") {
      const f = failNext;
      failNext = null;
      const { ApiRequestError } = await import("../src/lib/api");
      throw new ApiRequestError(502, f, "x");
    }
    if (url === BASE && method === "GET") return view;
    if (url === BASE && method === "PUT") {
      const b = JSON.parse(init!.body!);
      view = b.enabled ? makeView({ needsRestart: true, settings: { enabled: true, maxMessages: b.maxMessages, maxAgeDays: b.maxAgeDays } }) : makeView({ enabled: false, container: "off", needsRestart: true });
      return view;
    }
    if (url === "/api/projects/p1/recreate") {
      view = makeView({ needsRestart: false });
      return {};
    }
    if (url.startsWith(`${BASE}/messages?`)) return { total: list.length, unread: 1, start: 0, messages: list };
    if (url === `${BASE}/messages/m1` && method === "GET") return { message: MESSAGE };
    if (url === `${BASE}/messages/m1` && method === "DELETE") return {};
    if (url === `${BASE}/messages` && method === "DELETE") {
      list = [];
      return {};
    }
    throw new Error(`inesperado: ${method} ${url}`);
  });
});
afterEach(cleanup);

function renderSection() {
  return render(
    <MemoryRouter>
      <MailTestSection projectId="p1" />
    </MemoryRouter>,
  );
}

describe("MailTestSection", () => {
  it("desligada: mostra o aviso e liga com a retenção escolhida", async () => {
    view = makeView({ enabled: false, container: "off", messages: null, unread: null });
    renderSection();
    expect(await screen.findByText(/Desligada\./)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Mensagens guardadas (no máximo)"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: /Ligar a caixa de teste/ }));
    await screen.findByText(/Caixa de teste ligada\. Reinicie/);
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ enabled: true, maxMessages: 100, maxAgeDays: 7 });
    // depois de ligar falta reiniciar: o botão aparece e reinicia
    fireEvent.click(await screen.findByRole("button", { name: /Reiniciar o projeto agora/ }));
    await screen.findByText(/Reinício pedido/);
    expect(calls.some((c) => c.url === "/api/projects/p1/recreate" && c.method === "POST")).toBe(true);
  });

  it("ligada: mostra as variáveis, o aviso de API e salva a retenção", async () => {
    renderSection();
    expect(await screen.findByText(/Variáveis redirecionadas: SMTP_HOST, SMTP_PORT/)).toBeTruthy();
    expect(screen.getByTestId("mail-test-limits").textContent).toContain("NÃO são capturados");
    const save = screen.getByRole("button", { name: "Salvar retenção" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Guardar por (dias)"), { target: { value: "3" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await screen.findByText("Retenção salva.");
  });

  it("REVISÃO B1: mostra o limite da garantia e lista as variáveis de e-mail que o painel não controla", async () => {
    view = makeView({
      uncontrolled: [
        { name: "MAIL_RELAY_HOST", file: ".env", kind: "smtp" },
        { name: "SENDGRID_API_KEY", file: "Variáveis do painel", kind: "api" },
      ],
    });
    renderSection();
    const box = await screen.findByTestId("mail-test-uncontrolled");
    expect(box.textContent).toContain("MAIL_RELAY_HOST");
    expect(box.textContent).toContain("em .env");
    expect(box.textContent).toContain("pode apontar para um servidor SMTP");
    expect(box.textContent).toContain("SENDGRID_API_KEY");
    expect(box.textContent).toContain("provedor por API HTTP (não capturado)");
    expect(screen.getByTestId("mail-test-guarantee").textContent).toContain("NÃO bloqueia a rede");
    expect(screen.getByTestId("mail-test-limits").textContent).toContain("MAIL_MAILER=smtp");
    expect(screen.getByTestId("mail-test-limits").textContent).toContain("TODOS os serviços do projeto, inclusive banco de dados e cache");
  });

  it("sem variáveis fora do controle, diz isso", async () => {
    renderSection();
    expect((await screen.findByTestId("mail-test-uncontrolled")).textContent).toContain("Não encontrei outras variáveis de e-mail conhecidas");
  });

  it("M1: ligada sem reiniciar, o estado NÃO diz que os e-mails vão para a caixa: diz que o app ainda envia e-mail real", async () => {
    view = makeView({ needsRestart: true });
    renderSection();
    const status = await screen.findByTestId("mail-test-status");
    expect(status.textContent).toContain("AINDA NÃO");
    expect(status.textContent).not.toContain("vão para a caixa de teste");
    expect(status.className).toContain("red");
    expect(screen.getByTestId("mail-test-restart").className).toContain("red");
  });

  it("M4: mostra o tamanho máximo por mensagem, o orçamento de disco e o espaço ocupado; avisa quando passou", async () => {
    renderSection();
    const disk = await screen.findByTestId("mail-test-disk");
    // 4 MiB por mensagem × 500 mensagens = 1.95 GiB no máximo (os números que o Mailpit realmente aplica)
    expect(disk.textContent).toContain("4.0 MiB");
    expect(disk.textContent).toContain("500 mensagens");
    expect(disk.textContent).toContain("2.0 GiB");
    expect(disk.textContent).toContain("3.0 MiB");
    expect(screen.queryByTestId("mail-test-disk-over")).toBeNull();
    cleanup();
    view = makeView({ databaseBytes: 3 * 1024 * 1024 * 1024 });
    renderSection();
    expect(await screen.findByTestId("mail-test-disk-over")).toBeTruthy();
  });

  it("erro de leitura (painel sem acesso à rede da caixa) mostra o motivo e o botão Tentar de novo recarrega", async () => {
    view = makeView({ problem: "O painel não encontrou a caixa de teste na rede interna.", messages: null, unread: null });
    renderSection();
    expect((await screen.findByRole("alert")).textContent).toContain("não encontrou a caixa");
    const before = calls.filter((c) => c.method === "GET" && c.url === BASE).length;
    fireEvent.click(screen.getByTestId("mail-test-retry"));
    await waitFor(() => expect(calls.filter((c) => c.method === "GET" && c.url === BASE).length).toBeGreaterThan(before));
  });

  it("desligada mas ainda apontando: avisa que os envios falham até reiniciar", async () => {
    view = makeView({ enabled: false, container: "off", needsRestart: true });
    renderSection();
    expect((await screen.findByTestId("mail-test-restart")).textContent).toContain("FALHAM");
    expect(screen.queryByTestId("mail-test-uncontrolled")).toBeNull();
  });

  it("desligar pergunta das mensagens e manda a escolha", async () => {
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: /Desligar…/ }));
    fireEvent.click(screen.getByLabelText(/Apagar as mensagens/));
    fireEvent.click(screen.getByRole("button", { name: "Desligar a caixa" }));
    await screen.findByText(/Caixa de teste desligada/);
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ enabled: false, deleteMessages: true });
    expect(screen.getByText(/ainda aponta para ela/)).toBeTruthy();
  });

  it("desligar pode ser cancelado", async () => {
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: /Desligar…/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByTestId("mail-test-disable")).toBeNull();
  });

  it("erro da API aparece e não derruba a tela", async () => {
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: /Desligar…/ }));
    failNext = "mail_test_docker";
    fireEvent.click(screen.getByRole("button", { name: "Desligar a caixa" }));
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
  });

  it("falha ao carregar mostra o erro", async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockRejectedValue(new Error("boom"));
    renderSection();
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("lista, abre a mensagem, vê as abas e apaga", async () => {
    renderSection();
    fireEvent.click(await screen.findByTestId("mail-test-row-m1"));
    await screen.findByTestId("mail-test-detail");
    const frame = (await screen.findByTitle("Conteúdo do e-mail")) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("src")).toBe(`${BASE}/messages/m1/html`);
    fireEvent.click(screen.getByLabelText(/Carregar as imagens de fora/));
    expect((screen.getByTitle("Conteúdo do e-mail") as HTMLIFrameElement).getAttribute("src")).toBe(`${BASE}/messages/m1/html?images=1`);

    fireEvent.click(screen.getByRole("tab", { name: "Texto" }));
    expect(screen.getByText("Texto simples")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Cabeçalhos" }));
    expect(screen.getByText(/Subject:/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Anexos (1)" }));
    const dl = screen.getByRole("link", { name: /Baixar/ });
    expect(dl.getAttribute("href")).toBe(`${BASE}/messages/m1/parts/2?download=1`);
    fireEvent.click(screen.getByRole("tab", { name: "Links (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Copiar" }));
    await screen.findByText("Copiado");

    fireEvent.click(screen.getByRole("button", { name: /Apagar esta mensagem/ }));
    fireEvent.click(screen.getByRole("button", { name: "Apagar esta mensagem" }));
    await screen.findByText("Mensagem apagada.");
    expect(calls.some((c) => c.method === "DELETE" && c.url === `${BASE}/messages/m1`)).toBe(true);
  });

  it("mensagem sem HTML, sem texto e sem extras mostra os avisos vazios", async () => {
    const bare = { ...MESSAGE, hasHtml: false, text: "", headers: [], attachmentList: [], links: [], cc: [] };
    apiFetchMock.mockImplementationOnce(async () => view); // GET inicial
    renderSection();
    await screen.findByTestId("mail-test-row-m1");
    const prev = apiFetchMock.getMockImplementation()!;
    apiFetchMock.mockImplementation(async (url: string, init?: { method?: string }) =>
      url === `${BASE}/messages/m1` && (init?.method ?? "GET") === "GET" ? { message: bare } : prev(url, init as never),
    );
    fireEvent.click(screen.getByTestId("mail-test-row-m1"));
    await screen.findByText("Esta mensagem não tem parte de texto.");
    fireEvent.click(screen.getByRole("tab", { name: "E-mail" }));
    expect(screen.getByText("Esta mensagem não tem parte em HTML.")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Cabeçalhos" }));
    expect(screen.getByText("Sem cabeçalhos para mostrar.")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Anexos (0)" }));
    expect(screen.getByText("Esta mensagem não tem anexos.")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Links (0)" }));
    expect(screen.getByText(/Não há links/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Voltar à lista/ }));
    await screen.findByTestId("mail-test-messages");
  });

  it("esvazia a caixa depois de confirmar", async () => {
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: /Esvaziar a caixa/ }));
    fireEvent.click(screen.getByRole("button", { name: "Apagar tudo" }));
    await screen.findByText("Caixa esvaziada.");
    await screen.findByText(/Nenhuma mensagem ainda/);
  });

  it("container parado não lista mensagens", async () => {
    view = makeView({ container: "stopped" });
    renderSection();
    expect(await screen.findByText(/não está em funcionamento/)).toBeTruthy();
    expect(calls.some((c) => c.url.includes("/messages?"))).toBe(false);
  });
});

describe("MailTestBanner", () => {
  function renderBanner() {
    return render(
      <MemoryRouter>
        <MailTestBanner projectId="p1" />
      </MemoryRouter>,
    );
  }

  it("não aparece com a caixa desligada e sem pendência", async () => {
    view = makeView({ enabled: false, container: "off" });
    renderBanner();
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId("mail-test-banner")).toBeNull();
  });

  it("não aparece se a consulta falha", async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockRejectedValue(new Error("x"));
    renderBanner();
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId("mail-test-banner")).toBeNull();
  });

  it("ligada com reinício pendente: avisa e reinicia", async () => {
    view = makeView({ needsRestart: true });
    renderBanner();
    // M1: pendente = aviso forte, e nada de afirmar que os e-mails já vão para a caixa
    expect(await screen.findByText(/a caixa de teste está ligada, mas este projeto ainda NÃO a usa/)).toBeTruthy();
    expect(screen.getByTestId("mail-test-banner").dataset.state).toBe("pending-on");
    expect(screen.getByTestId("mail-test-banner").className).toContain("red");
    expect(screen.getByText(/continua enviando e-mail de verdade/)).toBeTruthy();
    expect(screen.queryByText("Os e-mails deste projeto estão indo para a caixa de teste")).toBeNull();
    expect(screen.queryByText(/não chega a destinatário real/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Reiniciar agora/ }));
    await waitFor(() => expect(screen.getByTestId("mail-test-banner").dataset.state).toBe("active"));
    expect(screen.getByText("Os e-mails deste projeto estão indo para a caixa de teste")).toBeTruthy();
  });

  it("desligada mas ainda apontando: só o aviso de reinício; erro do reinício aparece", async () => {
    view = makeView({ enabled: false, container: "off", needsRestart: true });
    renderBanner();
    expect(await screen.findAllByText(/ainda aponta para ela/)).not.toHaveLength(0);
    expect(screen.getByTestId("mail-test-banner").dataset.state).toBe("pending-off");
    expect(screen.queryByRole("link", { name: "Ver mensagens" })).toBeNull();
    failNext = "mail_test_docker";
    fireEvent.click(screen.getByRole("button", { name: /Reiniciar agora/ }));
    await screen.findByRole("alert");
  });
});
