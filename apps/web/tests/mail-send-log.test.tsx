/**
 * Envios por SMTP na tela: lista por projeto e global (E-mail > Envios >
 * Saídas), com filtros, páginas, estados de carregando/erro/vazio, erros
 * explicados em linguagem clara (com detalhes técnicos recolhidos), assunto e
 * corpo ocultos até "Exibir", e a configuração de privacidade. A API é simulada.
 */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailSendContent, MailSendItem, MailSendListResponse, MailSendSettings } from "@paas/core";
import { SendLogSection } from "../src/components/envios/SendLogSection";
import { SendPrivacyCard } from "../src/components/envios/SendPrivacyCard";
import { MailEnviosPage } from "../src/pages/MailEnviosPage";
import { setLocale } from "../src/i18n";
import { formatBytes, sendErrorText } from "../src/lib/envios";

function item(id: string, over: Partial<MailSendItem> = {}): MailSendItem {
  return {
    id,
    at: "2026-10-22T12:00:00.000Z",
    from: "loja@example.com",
    mailbox: "loja@example.com",
    origin: "project",
    projectId: "p1",
    projectName: "Loja",
    state: "delivered",
    recipients: [{ address: `cliente${id}@exemplo.net`, domain: "exemplo.net", state: "delivered", deferrals: 0, updatedAt: null, nextRetryAt: null, remoteHost: "mx.exemplo.net", error: null }],
    size: 2048,
    attachments: [],
    hasContent: true,
    contentExpired: false,
    contentTruncated: false,
    captured: true,
    ...over,
  };
}

function list(items: MailSendItem[], over: Partial<MailSendListResponse> = {}): MailSendListResponse {
  return {
    items,
    total: items.length,
    limit: 25,
    offset: 0,
    projects: [{ id: "p1", name: "Loja" }],
    capture: { configured: true, lastReceivedAt: "2026-10-22T12:00:00.000Z", serverCreated: true },
    retention: { metadataDays: 90, bodyDays: 14 },
    storesContent: true,
    ...over,
  };
}

const CONTENT: MailSendContent = { id: "1", subject: "Seu pedido #1", body: "Corpo secreto do pedido", bodyTruncated: false, attachments: [], expiresAt: "2026-11-05T12:00:00.000Z" };
const FAILED = item("2", {
  state: "failed",
  recipients: [
    {
      address: "x@nao-existe.example.org",
      domain: "nao-existe.example.org",
      state: "failed",
      deferrals: 0,
      updatedAt: null,
      nextRetryAt: null,
      remoteHost: null,
      error: { kind: "no_mx", code: null, enhanced: null, technical: 'record not found for MX' },
    },
  ],
});

type Reply = { status: number; body: unknown };
function mockApi(handler: (url: string, init?: RequestInit) => Reply | undefined) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const reply = handler(url, init) ?? { status: 404, body: { error: "not_found", message: "?" } };
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setLocale("pt-BR", { persist: false });
});

describe("lista", () => {
  it("mostra de, para, hora, estado e projeto; assunto e corpo ficam ocultos", async () => {
    mockApi((url) => (url.startsWith("/api/projects/p1/email/saidas?") ? { status: 200, body: list([item("1")]) } : undefined));
    render(<SendLogSection projectId="p1" />);
    const row = await screen.findByTestId("send-1");
    expect(within(row).getByText("cliente1@exemplo.net")).toBeInTheDocument();
    expect(within(row).getByText("Entregue")).toBeInTheDocument();
    expect(within(row).getByText(/loja@example\.com · Loja/)).toBeInTheDocument();
    expect(within(row).getByText("oculto")).toBeInTheDocument();
    expect(screen.queryByText(/secreto/)).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "" })).toBeDefined();
    expect(screen.getByText("Mostrando 1 a 1 de 1.")).toBeInTheDocument();
  });

  it("pede só o projeto (escopo na rota) e nenhum filtro de projeto na tela", async () => {
    const fn = mockApi(() => ({ status: 200, body: list([item("1")]) }));
    render(<SendLogSection projectId="p1" />);
    await screen.findByTestId("send-1");
    expect(String(fn.mock.calls[0]![0])).toBe("/api/projects/p1/email/saidas?limit=25&offset=0");
    expect(screen.queryByLabelText("Projeto")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Origem")).not.toBeInTheDocument();
  });

  it("carregando, depois vazio (sem filtro e com filtro)", async () => {
    let release: (r: Response) => void = () => undefined;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => (release = r))));
    render(<SendLogSection projectId="p1" />);
    expect(screen.getByText("Carregando os envios...")).toBeInTheDocument();
    await act(async () => release(new Response(JSON.stringify(list([])), { status: 200, headers: { "Content-Type": "application/json" } })));
    expect(await screen.findByText("Nenhum envio registrado ainda.")).toBeInTheDocument();
    mockApi(() => ({ status: 200, body: list([]) }));
    await userEvent.selectOptions(screen.getByLabelText("Estado"), "failed");
    expect(await screen.findByText("Nenhum envio encontrado com esses filtros.")).toBeInTheDocument();
  });

  it("erro ao carregar vira alerta", async () => {
    mockApi(() => ({ status: 500, body: { error: "x", message: "Falhou feio" } }));
    render(<SendLogSection projectId="p1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Falhou feio");
  });

  it("avisos da captura: servidor não criado, captura desligada, aguardando o primeiro envio", async () => {
    const cases: Array<[MailSendListResponse["capture"], RegExp]> = [
      [{ configured: false, lastReceivedAt: null, serverCreated: false }, /ainda não foi criado/],
      [{ configured: false, lastReceivedAt: null, serverCreated: true }, /não está configurado/],
      [{ configured: true, lastReceivedAt: null, serverCreated: true }, /ainda não chegou nenhum envio/],
    ];
    for (const [capture, re] of cases) {
      mockApi(() => ({ status: 200, body: list([], { capture }) }));
      const { unmount } = render(<SendLogSection />);
      expect(await screen.findByText(re)).toBeInTheDocument();
      unmount();
    }
  });
});

describe("erros em linguagem clara", () => {
  it("falha: título, sugestão e detalhes técnicos recolhidos", async () => {
    mockApi(() => ({ status: 200, body: list([FAILED]) }));
    render(<SendLogSection projectId="p1" />);
    const row = await screen.findByTestId("send-2");
    expect(within(row).getByText("Falhou")).toBeInTheDocument();
    expect(within(row).getByText("O domínio do destinatário não recebe e-mail (sem MX)")).toBeInTheDocument();
    expect(within(row).getByText(/Corrija o endereço/)).toBeInTheDocument();
    const details = within(row).getByText("Detalhes técnicos").closest("details")!;
    expect(details.open).toBe(false);
    expect(details).toHaveTextContent("record not found for MX");
  });

  it("adiada mostra tentativas e a próxima; vários destinatários listam cada um", async () => {
    const deferred = item("3", {
      state: "deferred",
      recipients: [
        { address: "a@x.org", domain: "x.org", state: "deferred", deferrals: 2, updatedAt: null, nextRetryAt: "2026-10-22T13:00:00.000Z", remoteHost: "mx.x.org", error: { kind: "greylisted", code: 451, enhanced: "4.7.1", technical: "451 4.7.1 Greylisted" } },
        { address: "b@x.org", domain: "x.org", state: "delivered", deferrals: 0, updatedAt: null, nextRetryAt: null, remoteHost: null, error: null },
      ],
    });
    mockApi(() => ({ status: 200, body: list([deferred]) }));
    render(<SendLogSection projectId="p1" />);
    const row = await screen.findByTestId("send-3");
    expect(within(row).getByText(/Adiada 2 vez\(es\)/)).toBeInTheDocument();
    expect(within(row).getByText("O destino pediu para tentar de novo mais tarde (greylist)")).toBeInTheDocument();
    expect(within(row).getAllByText("Entregue").length).toBeGreaterThan(0);
    expect(within(row).getByText(/mx\.x\.org: 451 4\.7\.1 Greylisted/)).toBeInTheDocument();
  });

  it("todo tipo de erro tem título e sugestão nos dois idiomas", () => {
    const kinds = ["no_such_user", "mailbox_full", "message_too_large", "blocklisted", "spam_content", "sender_auth", "policy_rejected", "greylisted", "rate_limited", "no_mx", "dns_failure", "tls_failure", "timeout", "connection_failed", "expired", "temporary", "rejected_other", "unknown"] as const;
    for (const locale of ["pt-BR", "en"] as const) {
      setLocale(locale, { persist: false });
      for (const k of kinds) {
        const { title, hint } = sendErrorText(k);
        expect(title).not.toMatch(/^envios\./);
        expect(hint).not.toMatch(/^envios\./);
        expect(title.length).toBeGreaterThan(5);
      }
    }
    setLocale("en", { persist: false });
    expect(sendErrorText("no_such_user").title).toBe("The recipient address does not exist");
  });

  it("sem captura: explica que não há assunto nem corpo; expirado e não guardado", async () => {
    mockApi(() =>
      ({
        status: 200,
        body: list([
          item("4", { hasContent: false, captured: false }),
          item("5", { hasContent: false, contentExpired: true }),
          item("6", { hasContent: false }),
        ]),
      }),
    );
    render(<SendLogSection projectId="p1" />);
    expect(await screen.findByText(/só pelo registro de entrega/i)).toBeInTheDocument();
    expect(screen.getByText(/já foram apagados pela retenção/)).toBeInTheDocument();
    expect(screen.getByText("Assunto e corpo não guardados.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Exibir assunto/ })).not.toBeInTheDocument();
  });
});

describe("Exibir", () => {
  it("revela UMA mensagem por clique (POST), com botão acessível, e oculta de novo", async () => {
    const fn = mockApi((url, init) => {
      if (url === "/api/projects/p1/email/saidas/1/reveal" && init?.method === "POST") return { status: 200, body: CONTENT };
      return { status: 200, body: list([item("1"), item("7")]) };
    });
    render(<SendLogSection projectId="p1" />);
    const row = await screen.findByTestId("send-1");
    const button = within(row).getByRole("button", { name: "Exibir assunto e corpo da mensagem para cliente1@exemplo.net" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveAttribute("aria-controls", "send-content-1");
    await userEvent.click(button);
    expect(await within(row).findByText("Corpo secreto do pedido")).toBeInTheDocument();
    expect(within(row).getByText("Seu pedido #1")).toBeInTheDocument();
    expect(within(row).getByText(/Será apagado em/)).toBeInTheDocument();
    // a outra mensagem continua oculta e não foi pedida
    expect(within(screen.getByTestId("send-7")).getByText("oculto")).toBeInTheDocument();
    expect(fn.mock.calls.filter((c) => String(c[0]).endsWith("/reveal"))).toHaveLength(1);
    const hide = within(row).getByRole("button", { name: /Ocultar assunto e corpo/ });
    expect(hide).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(hide);
    expect(within(row).queryByText("Corpo secreto do pedido")).not.toBeInTheDocument();
    expect(within(row).getByText("oculto")).toBeInTheDocument();
  });

  it("Exibir todos revela cada uma (uma chamada por mensagem) e Ocultar todos esconde", async () => {
    const fn = mockApi((url) => {
      if (url.endsWith("/reveal")) return { status: 200, body: { ...CONTENT, body: `Corpo ${url.split("/").at(-2)}` } };
      return { status: 200, body: list([item("1"), item("7")]) };
    });
    render(<SendLogSection projectId="p1" />);
    await screen.findByTestId("send-1");
    await userEvent.click(screen.getByRole("button", { name: "Exibir todos" }));
    expect(await screen.findByText("Corpo 1")).toBeInTheDocument();
    expect(await screen.findByText("Corpo 7")).toBeInTheDocument();
    expect(fn.mock.calls.filter((c) => String(c[0]).endsWith("/reveal"))).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Ocultar todos" }));
    expect(screen.queryByText("Corpo 1")).not.toBeInTheDocument();
  });

  it("erro ao exibir mostra o motivo e deixa tentar de novo", async () => {
    mockApi((url) => (url.endsWith("/reveal") ? { status: 410, body: { error: "content_expired", message: "Já foi apagado." } } : { status: 200, body: list([item("1")]) }));
    render(<SendLogSection projectId="p1" />);
    await userEvent.click(await screen.findByRole("button", { name: /Exibir assunto/ }));
    expect(await screen.findByText("Já foi apagado.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Exibir assunto/ })).toBeEnabled();
  });

  it("corpo cortado avisa; trocar de filtro esquece o que estava exibido", async () => {
    mockApi((url) => (url.endsWith("/reveal") ? { status: 200, body: { ...CONTENT, bodyTruncated: true } } : { status: 200, body: list([item("1")]) }));
    render(<SendLogSection projectId="p1" />);
    await userEvent.click(await screen.findByRole("button", { name: /Exibir assunto/ }));
    expect(await screen.findByText("O corpo foi cortado no limite de tamanho guardado.")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Estado"), "delivered");
    await waitFor(() => expect(screen.queryByText("Corpo secreto do pedido")).not.toBeInTheDocument());
    expect(await screen.findByText("oculto")).toBeInTheDocument();
  });
});

describe("filtros, páginas e atualização", () => {
  it("global: filtros de projeto e origem viram parâmetros; estado, datas e destinatário também", async () => {
    const fn = mockApi(() => ({ status: 200, body: list([item("1")]) }));
    render(<SendLogSection />);
    await screen.findByTestId("send-1");
    await userEvent.selectOptions(screen.getByLabelText("Projeto"), "p1");
    await userEvent.selectOptions(screen.getByLabelText("Origem"), "panel");
    await userEvent.selectOptions(screen.getByLabelText("Estado"), "failed");
    await userEvent.type(screen.getByLabelText("De (data)"), "2026-10-01");
    await userEvent.type(screen.getByLabelText("Até (data)"), "2026-10-22");
    await userEvent.type(screen.getByLabelText("Destinatário"), "gmail");
    await waitFor(() => {
      const last = String(fn.mock.calls.at(-1)![0]);
      expect(last).toContain("/api/mail/envios/saidas?");
      for (const part of ["projectId=p1", "origin=panel", "state=failed", "from=2026-10-01", "to=2026-10-22", "recipient=gmail"]) expect(last).toContain(part);
    });
  });

  it("páginas: Próxima e Anterior mudam o deslocamento; fim da lista desabilita", async () => {
    const fn = mockApi((url) => {
      const offset = Number(new URL(url, "http://x").searchParams.get("offset"));
      return { status: 200, body: list([item(String(offset + 1))], { total: 30, offset }) };
    });
    render(<SendLogSection projectId="p1" />);
    await screen.findByTestId("send-1");
    expect(screen.getByText("Página 1 de 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Anterior" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Próxima" }));
    expect(await screen.findByTestId("send-26")).toBeInTheDocument();
    expect(String(fn.mock.calls.at(-1)![0])).toContain("offset=25");
    expect(screen.getByRole("button", { name: "Próxima" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Anterior" }));
    expect(await screen.findByTestId("send-1")).toBeInTheDocument();
  });

  it("Atualizar recarrega; enquanto há mensagem na fila, atualiza sozinho", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fn = mockApi(() => ({ status: 200, body: list([item("1", { state: "queued" })]) }));
    render(<SendLogSection projectId="p1" />);
    await screen.findByTestId("send-1");
    const before = fn.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "Atualizar" }));
    await waitFor(() => expect(fn.mock.calls.length).toBeGreaterThan(before));
    const afterClick = fn.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    expect(fn.mock.calls.length).toBeGreaterThan(afterClick);
  });
});

describe("opção por projeto", () => {
  it("desliga e liga a gravação de assunto e corpo do projeto", async () => {
    let stores = true;
    const fn = mockApi((url, init) => {
      if (url.endsWith("/settings") && init?.method === "PUT") {
        stores = (JSON.parse(String(init.body)) as { storeContent: boolean }).storeContent;
        return { status: 200, body: {} };
      }
      return { status: 200, body: list([item("1")], { storesContent: stores }) };
    });
    render(<SendLogSection projectId="p1" />);
    const box = await screen.findByLabelText("Guardar assunto e corpo das mensagens deste projeto");
    expect(box).toBeChecked();
    await userEvent.click(box);
    expect(await screen.findByText("Opção salva.")).toBeInTheDocument();
    expect(fn.mock.calls.some((c) => String(c[0]) === "/api/projects/p1/email/saidas/settings" && (c[1] as RequestInit).method === "PUT")).toBe(true);
    await waitFor(() => expect(screen.getByLabelText("Guardar assunto e corpo das mensagens deste projeto")).not.toBeChecked());
  });

  it("erro ao salvar aparece", async () => {
    mockApi((url, init) => (init?.method === "PUT" ? { status: 400, body: { error: "x", message: "Recusado" } } : { status: 200, body: list([item("1")]) }));
    render(<SendLogSection projectId="p1" />);
    await userEvent.click(await screen.findByLabelText(/Guardar assunto e corpo/));
    expect(await screen.findByText("Recusado")).toBeInTheDocument();
  });
});

describe("privacidade e retenção", () => {
  const SETTINGS: MailSendSettings = { metadataDays: 90, bodyDays: 14, storeContent: true, maxBodyKiB: 64, maxTotalMiB: 100, projectsWithoutContent: ["p9"] };

  it("mostra o padrão e salva as mudanças", async () => {
    const fn = mockApi((url, init) => {
      if (init?.method === "PUT") return { status: 200, body: { ...SETTINGS, ...(JSON.parse(String(init.body)) as object) } };
      return { status: 200, body: SETTINGS };
    });
    render(<SendPrivacyCard />);
    expect(await screen.findByLabelText("Dias guardando assunto e corpo")).toHaveValue(14);
    expect(screen.getByLabelText("Dias guardando os dados da mensagem")).toHaveValue(90);
    expect(screen.getByText("Projetos sem gravação de assunto e corpo: 1.")).toBeInTheDocument();
    expect(screen.getByText(/data\/envios-conteudo/)).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Dias guardando assunto e corpo"));
    await userEvent.type(screen.getByLabelText("Dias guardando assunto e corpo"), "7");
    await userEvent.click(screen.getByLabelText("Guardar assunto e corpo das mensagens"));
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(await screen.findByText("Configuração salva.")).toBeInTheDocument();
    const put = fn.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "PUT")!;
    expect(JSON.parse(String((put[1] as RequestInit).body))).toEqual({ storeContent: false, metadataDays: 90, bodyDays: 7, maxBodyKiB: 64, maxTotalMiB: 100 });
  });

  it("erro ao carregar e ao salvar", async () => {
    mockApi(() => ({ status: 500, body: { error: "x", message: "Sem configuração" } }));
    const { unmount } = render(<SendPrivacyCard />);
    expect(await screen.findByText("Sem configuração")).toBeInTheDocument();
    unmount();
    mockApi((url, init) => (init?.method === "PUT" ? { status: 400, body: { error: "x", message: "Valor fora do limite" } } : { status: 200, body: SETTINGS }));
    render(<SendPrivacyCard />);
    await userEvent.click(await screen.findByRole("button", { name: "Salvar" }));
    expect(await screen.findByText("Valor fora do limite")).toBeInTheDocument();
  });
});

describe("página Envios", () => {
  it("abas Saídas e Privacidade pelo endereço", async () => {
    mockApi((url) => (url.startsWith("/api/mail/envios/saidas/settings") ? { status: 200, body: { metadataDays: 90, bodyDays: 14, storeContent: true, maxBodyKiB: 64, maxTotalMiB: 100, projectsWithoutContent: [] } } : url.startsWith("/api/mail/envios/saidas") ? { status: 200, body: list([item("1")]) } : undefined));
    const { unmount } = render(
      <MemoryRouter initialEntries={["/mail/envios?aba=saidas"]}>
        <MailEnviosPage />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("send-1")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Saídas", selected: true })).toBeInTheDocument();
    unmount();
    render(
      <MemoryRouter initialEntries={["/mail/envios?aba=privacidade"]}>
        <MailEnviosPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Privacidade e retenção dos envios")).toBeInTheDocument();
  });
});

describe("formatos", () => {
  it("bytes legíveis", () => {
    expect(formatBytes(10)).toBe("10 B");
    expect(formatBytes(1536)).toMatch(/1[,.]5 KiB/);
    expect(formatBytes(3 * 1024 * 1024)).toMatch(/3 MiB/);
  });
});
