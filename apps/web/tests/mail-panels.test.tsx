/**
 * Painéis do domínio de e-mail, usados na página do domínio e na seção
 * E-mail do projeto (pedido do dono do produto, 03/10/2026: conferir e
 * configurar as caixas e o DNS sem sair do projeto).
 *
 * Os casos detalhados (copiar campo a campo, PTR, senha) continuam em
 * mail-domain-page.test.tsx; aqui, o que cada painel faz sozinho: carrega
 * os próprios dados a partir do domínio recebido.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DnsChecklistResponse, Mailbox } from "@paas/core";
import { MailboxesPanel } from "@/components/mail/MailboxesPanel";
import { DnsChecklistPanel } from "@/components/mail/DnsChecklistPanel";

const CHECKLIST: DnsChecklistResponse = {
  domain: "exemplo.com.br",
  mailHostname: "mail.exemplo.com.br",
  serverIp: "203.0.113.10",
  records: [
    {
      id: "a",
      type: "A",
      name: "mail.exemplo.com.br",
      expected: "203.0.113.10",
      purpose: "servidor",
      status: "missing",
      found: [],
      note: null,
    },
    {
      id: "mx",
      type: "MX",
      name: "exemplo.com.br",
      expected: "10 mail.exemplo.com.br",
      purpose: "recebimento",
      status: "missing",
      found: [],
      note: null,
      priority: 10,
      target: "mail.exemplo.com.br",
    },
  ],
  ptr: { ip: "203.0.113.10", expected: "mail.exemplo.com.br", status: "action_required", found: [], ticketText: "chamado…" },
  suggestion: "Endureça para p=quarantine.",
};

const USER_BOX: Mailbox = {
  id: "vendas@exemplo.com.br",
  localPart: "vendas",
  domain: "exemplo.com.br",
  kind: "user",
  createdAt: "2026-10-01T12:00:00.000Z",
};
const PROJECT_BOX: Mailbox = {
  id: "loja@exemplo.com.br",
  localPart: "loja",
  domain: "exemplo.com.br",
  kind: "project",
  createdAt: "2026-10-01T12:00:00.000Z",
};

type Call = { url: string; method: string; body: unknown };

function mockApi({
  mailboxes = [] as Mailbox[],
  verify = {} as Record<string, unknown>,
}: { mailboxes?: Mailbox[]; verify?: Record<string, unknown> } = {}): Call[] {
  const calls: Call[] = [];
  let boxes = [...mailboxes];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      let res: unknown = CHECKLIST;
      if (url.endsWith("/verify")) {
        res = {
          domain: "exemplo.com.br",
          records: CHECKLIST.records.map((r) => ({ ...r, status: "found" })),
          ptr: { ...CHECKLIST.ptr, status: "found" },
          summary: { ok: 3, total: 3 },
          verifiedAt: "2026-10-03T12:00:00.000Z",
          suggestion: null,
          ...verify,
        };
      } else if (url.split("?")[0]!.endsWith("/mailboxes") && method === "GET") res = { mailboxes: boxes };
      else if (url.endsWith("/mailboxes") && method === "POST") {
        const created: Mailbox = {
          ...USER_BOX,
          id: `${body.localPart}@exemplo.com.br`,
          localPart: body.localPart,
          ...(body.projectId ? { projectId: body.projectId } : {}),
        };
        boxes = [...boxes, created];
        res = { mailbox: created };
      }
      return new Response(JSON.stringify(res), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MailboxesPanel", () => {
  it("carrega as caixas do domínio recebido e avisa quantas são", async () => {
    const calls = mockApi({ mailboxes: [USER_BOX, PROJECT_BOX] });
    const onMailboxesChange = vi.fn();
    render(
      <MemoryRouter>
        <MailboxesPanel domain="exemplo.com.br" onMailboxesChange={onMailboxesChange} />
      </MemoryRouter>,
    );
    expect(await screen.findByText("vendas@exemplo.com.br")).toBeInTheDocument();
    expect(screen.getByText("loja@exemplo.com.br")).toBeInTheDocument();
    expect(calls[0]).toMatchObject({ url: "/api/mail/domains/exemplo.com.br/mailboxes", method: "GET" });
    await waitFor(() => expect(onMailboxesChange).toHaveBeenLastCalledWith([USER_BOX, PROJECT_BOX]));
    expect(screen.getByText("Caixas de e-mail")).toBeInTheDocument();
  });

  it("destaca a caixa do projeto quando recebe o endereço dela", async () => {
    mockApi({ mailboxes: [USER_BOX, PROJECT_BOX] });
    render(
      <MemoryRouter>
        <MailboxesPanel domain="exemplo.com.br" highlight="loja@exemplo.com.br" />
      </MemoryRouter>,
    );
    const row = (await screen.findByText("loja@exemplo.com.br")).closest("[data-mailbox]") as HTMLElement;
    expect(row).toHaveAttribute("data-highlight", "true");
    expect(within(row).getByText("deste projeto")).toBeInTheDocument();
    const other = screen.getByText("vendas@exemplo.com.br").closest("[data-mailbox]") as HTMLElement;
    expect(other).not.toHaveAttribute("data-highlight");
  });

  it("cria uma caixa nova no mesmo domínio (ex.: suporte@) e atualiza a lista", async () => {
    const calls = mockApi({ mailboxes: [PROJECT_BOX] });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MailboxesPanel domain="exemplo.com.br" />
      </MemoryRouter>,
    );
    await user.type(await screen.findByPlaceholderText("contato"), "suporte");
    expect(screen.getByText("@exemplo.com.br")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Senha da caixa"), "senha-forte-da-pessoa");
    await user.type(screen.getByLabelText("Repita a senha"), "senha-forte-da-pessoa");
    await user.click(screen.getByRole("button", { name: /Criar caixa/ }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")).toMatchObject({
        url: "/api/mail/domains/exemplo.com.br/mailboxes",
        body: { localPart: "suporte", password: "senha-forte-da-pessoa" },
      }),
    );
    expect(await screen.findByText("suporte@exemplo.com.br")).toBeInTheDocument();
  });

  /**
   * Pedido do dono do produto (03/10/2026): no projeto, só as caixas DELE (a
   * de envio e as criadas pela aba Caixas do projeto); na página do domínio,
   * todas, dizendo de qual projeto cada uma é.
   */
  it("no projeto: pede só as caixas dele e a caixa criada fica sendo dele", async () => {
    const calls = mockApi({ mailboxes: [{ ...PROJECT_BOX, projectId: "p1", projectName: "Loja" }] });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MailboxesPanel domain="exemplo.com.br" projectId="p1" highlight="loja@exemplo.com.br" />
      </MemoryRouter>,
    );
    expect(await screen.findByText("loja@exemplo.com.br")).toBeInTheDocument();
    expect(calls[0]).toMatchObject({ url: "/api/mail/domains/exemplo.com.br/mailboxes?projectId=p1", method: "GET" });
    expect(screen.getByText(/Caixas deste projeto/)).toBeInTheDocument();
    // no próprio projeto não repete "do projeto Loja"
    expect(screen.queryByText(/do projeto Loja/)).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("contato"), "suporte");
    await user.click(screen.getByRole("radio", { name: /Gerar uma senha forte/ }));
    await user.click(screen.getByRole("button", { name: /Criar caixa/ }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")).toMatchObject({
        url: "/api/mail/domains/exemplo.com.br/mailboxes",
        body: { localPart: "suporte", generatePassword: true, projectId: "p1" },
      }),
    );
  });

  it("no projeto sem caixas: diz que o projeto ainda não tem caixa", async () => {
    mockApi({ mailboxes: [] });
    render(
      <MemoryRouter>
        <MailboxesPanel domain="exemplo.com.br" projectId="p1" />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Nenhuma caixa deste projeto ainda/)).toBeInTheDocument();
  });

  it("página do domínio: todas, com o projeto dono de cada uma", async () => {
    mockApi({
      mailboxes: [
        USER_BOX,
        { ...PROJECT_BOX, projectId: "p1", projectName: "Loja" },
        { ...USER_BOX, id: "velha@exemplo.com.br", localPart: "velha", projectId: "sumiu" },
      ],
    });
    render(
      <MemoryRouter>
        <MailboxesPanel domain="exemplo.com.br" />
      </MemoryRouter>,
    );
    const loja = (await screen.findByText("loja@exemplo.com.br")).closest("[data-mailbox]") as HTMLElement;
    expect(within(loja).getByText("do projeto Loja")).toBeInTheDocument();
    const velha = screen.getByText("velha@exemplo.com.br").closest("[data-mailbox]") as HTMLElement;
    expect(within(velha).getByText("de um projeto removido")).toBeInTheDocument();
    const vendas = screen.getByText("vendas@exemplo.com.br").closest("[data-mailbox]") as HTMLElement;
    expect(within(vendas).queryByText(/projeto/)).not.toBeInTheDocument();
  });

  it("falha ao carregar: mostra a mensagem", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "not_found", message: "Domínio não encontrado." }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    render(
      <MemoryRouter>
        <MailboxesPanel domain="exemplo.com.br" />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Domínio não encontrado.")).toBeInTheDocument();
  });
});

describe("DnsChecklistPanel", () => {
  it("carrega o checklist do domínio, confere o DNS ao abrir e mostra o resumo", async () => {
    const calls = mockApi();
    render(
      <MemoryRouter>
        <DnsChecklistPanel domain="exemplo.com.br" />
      </MemoryRouter>,
    );
    expect(await screen.findByText("3/3 OK")).toBeInTheDocument();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /api/mail/domains/exemplo.com.br/dns",
      "POST /api/mail/domains/exemplo.com.br/verify",
    ]);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText(/Reverse DNS \(PTR\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Enviar e-mail de teste/ })).toBeInTheDocument();
  });

  it("MX em servidor e prioridade, nota da nuvem cinza e DMARC progressivo", async () => {
    mockApi({ verify: { records: CHECKLIST.records, ptr: CHECKLIST.ptr, suggestion: "Endureça para p=quarantine." } });
    render(
      <MemoryRouter>
        <DnsChecklistPanel domain="exemplo.com.br" />
      </MemoryRouter>,
    );
    expect(await screen.findByText("0/3 OK")).toBeInTheDocument();
    expect(screen.getByText("Servidor de e-mail:")).toBeInTheDocument();
    expect(screen.getByText("Prioridade:")).toBeInTheDocument();
    expect(screen.getByText("No Cloudflare: Proxy desligado (nuvem cinza)")).toBeInTheDocument();
    expect(screen.getByText(/DMARC progressivo/)).toBeInTheDocument();
  });

  it("certificado pedido pela verificação: avisa com link para Certificados", async () => {
    mockApi({ verify: { certificateRetry: { host: "mail.exemplo.com.br", message: "Pedimos…" } } });
    const onVerified = vi.fn();
    render(
      <MemoryRouter>
        <DnsChecklistPanel domain="exemplo.com.br" onVerified={onVerified} />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Certificado de mail\.exemplo\.com\.br: emissão pedida/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Certificados" })).toHaveAttribute("href", "/certificates");
    expect(onVerified).toHaveBeenCalledTimes(1);
  });

  it("sem o aviso de certificado quando quem usa o painel mostra o aviso por conta própria", async () => {
    mockApi({ verify: { certificateRetry: { host: "mail.exemplo.com.br", message: "Pedimos…" } } });
    render(
      <MemoryRouter>
        <DnsChecklistPanel domain="exemplo.com.br" showCertificateNotice={false} />
      </MemoryRouter>,
    );
    await screen.findByText("3/3 OK");
    expect(screen.queryByText(/emissão pedida/)).not.toBeInTheDocument();
  });

  it("'Verificar agora' confere de novo", async () => {
    const calls = mockApi();
    render(
      <MemoryRouter>
        <DnsChecklistPanel domain="exemplo.com.br" />
      </MemoryRouter>,
    );
    await screen.findByText("3/3 OK");
    fireEvent.click(screen.getByRole("button", { name: /Verificar agora/ }));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/verify"))).toHaveLength(2));
  });

  it("falha ao verificar: mostra a mensagem e mantém a tabela", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith("/verify")
          ? new Response(JSON.stringify({ error: "x", message: "DNS fora do ar." }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            })
          : new Response(JSON.stringify(CHECKLIST), { status: 200, headers: { "Content-Type": "application/json" } }),
      ),
    );
    render(
      <MemoryRouter>
        <DnsChecklistPanel domain="exemplo.com.br" />
      </MemoryRouter>,
    );
    expect(await screen.findByText("DNS fora do ar.")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
  });
});
