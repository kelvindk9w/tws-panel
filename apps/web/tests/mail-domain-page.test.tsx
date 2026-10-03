/**
 * Testes da tabela de checklist DNS (MailDomainPage): badges de status por
 * registro (encontrado/ausente/divergente/não verificado) e o resumo
 * encontrado/total após a verificação.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DnsChecklistResponse } from "@paas/core";
import { MailDomainPage } from "../src/pages/MailDomainPage";

function record(
  id: string,
  status: DnsChecklistResponse["records"][number]["status"],
  overrides: Partial<DnsChecklistResponse["records"][number]> = {},
): DnsChecklistResponse["records"][number] {
  return {
    id,
    type: "TXT",
    name: `${id}.exemplo.com.br`,
    expected: `valor-${id}`,
    purpose: `finalidade ${id}`,
    status,
    found: [],
    note: null,
    ...overrides,
  };
}

const CHECKLIST: DnsChecklistResponse = {
  domain: "exemplo.com.br",
  mailHostname: "mail.exemplo.com.br",
  serverIp: "203.0.113.10",
  records: [
    record("a", "found", { type: "A", name: "mail.exemplo.com.br", expected: "203.0.113.10", found: ["203.0.113.10"] }),
    record("mx", "missing", { type: "MX", expected: "10 mail.exemplo.com.br" }),
    record("spf", "mismatch", {
      expected: "v=spf1 ip4:203.0.113.10 -all",
      found: ["v=spf1 ip4:203.0.113.10 ~all"],
      note: "SPF encontrado com o IP correto, mas o mecanismo final difere.",
    }),
    record("dkim", "pending", { name: "paas._domainkey.exemplo.com.br" }),
  ],
  ptr: { ip: "203.0.113.10", expected: "mail.exemplo.com.br", status: "action_required", found: [], ticketText: "chamado…" },
  suggestion: "Endureça para p=quarantine.",
};

function mockApi(checklist: DnsChecklistResponse = CHECKLIST): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.endsWith("/mailboxes") ? { mailboxes: [] } : checklist;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

/** A página abre na aba Caixas; os testes do checklist abrem a aba DNS. */
async function renderPage({ openDns = true }: { openDns?: boolean } = {}): Promise<void> {
  render(
    <MemoryRouter initialEntries={["/mail/exemplo.com.br"]}>
      <Routes>
        <Route path="/mail/:domain" element={<MailDomainPage />} />
      </Routes>
    </MemoryRouter>,
  );
  if (openDns) fireEvent.click(await screen.findByRole("button", { name: /Checklist DNS/ }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MailDomainPage — tabela de checklist DNS", () => {
  it("exibe um badge correto por status: ✅ encontrado, ❌ ausente, ⚠️ divergente, não verificado", async () => {
    mockApi();
    await renderPage();

    const table = (await screen.findByRole("table"));
    const rows = within(table).getAllByRole("row");
    // linha 0 = cabeçalho; 4 registros a seguir
    expect(rows).toHaveLength(5);
    expect(within(rows[1]!).getByText("encontrado")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("ausente")).toBeInTheDocument();
    expect(within(rows[3]!).getByText("divergente")).toBeInTheDocument();
    expect(within(rows[4]!).getByText("não verificado")).toBeInTheDocument();
  });

  it("registro divergente mostra a nota e o valor encontrado no DNS", async () => {
    mockApi();
    await renderPage();

    expect(await screen.findByText(/mecanismo final difere/)).toBeInTheDocument();
    expect(screen.getByText(/v=spf1 ip4:203.0.113.10 ~all/)).toBeInTheDocument();
  });

  it("PTR com ação necessária exibe o card de reverse DNS com o texto do chamado", async () => {
    mockApi();
    await renderPage();

    expect(await screen.findByText(/Reverse DNS \(PTR\)/)).toBeInTheDocument();
    expect(screen.getByText(/FCrDNS/)).toBeInTheDocument();
    expect(screen.getByText("chamado…")).toBeInTheDocument();
  });

  it("após 'Verificar agora', exibe o resumo encontrado/total (1/5 OK)", async () => {
    mockApi();
    const user = userEvent.setup();
    await renderPage();

    await screen.findByRole("table");
    await user.click(screen.getByRole("button", { name: /verificar agora/i }));

    // verify retorna o mesmo checklist: 1 registro found de 4 + PTR não resolvido = 1/5
    expect(await screen.findByText("1/5 OK")).toBeInTheDocument();
  });

  it("PTR genérico com FCrDNS válido (azul): envio liberado, troca opcional com o caminho da Contabo, sem chamado", async () => {
    mockApi({
      ...CHECKLIST,
      records: [record("a", "found", { type: "A", name: "mail.exemplo.com.br", expected: "203.0.113.10" })],
      ptr: {
        ip: "203.0.113.10",
        expected: "mail.exemplo.com.br",
        status: "generic",
        found: ["vmi1234567.contaboserver.net"],
        forwardConfirmed: true,
        provider: {
          id: "contabo",
          name: "Contabo",
          instructions: "Na Contabo você mesmo troca, sem chamado: no painel da Contabo (my.contabo.com)…",
        },
        ticketText: null,
      },
    });
    const user = userEvent.setup();
    await renderPage();

    expect(await screen.findByText(/Envio liberado/)).toBeInTheDocument();
    expect(screen.getByText(/Gmail, Yahoo e Microsoft aceitam/)).toBeInTheDocument();
    expect(screen.getByText(/vmi1234567\.contaboserver\.net/)).toBeInTheDocument();
    // não é o aviso amarelo, nem o chamado
    expect(screen.queryByText(/podem recusar/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Copiar texto do chamado/)).not.toBeInTheDocument();
    // instrução recolhida, marcada como opcional
    const summary = screen.getByText(/Opcional: trocar o nome reverso/);
    await user.click(summary);
    expect(screen.getByText(/my\.contabo\.com/)).toBeVisible();

    // conta como OK na contagem
    await user.click(screen.getByRole("button", { name: /verificar agora/i }));
    expect(await screen.findByText("2/2 OK")).toBeInTheDocument();
  });

  it("PTR que não volta para o IP (amarelo) na Contabo: aviso de recusa e o caminho no painel, sem chamado", async () => {
    mockApi({
      ...CHECKLIST,
      ptr: {
        ip: "203.0.113.10",
        expected: "mail.exemplo.com.br",
        status: "mismatch",
        found: ["vmi1234567.contaboserver.net"],
        forwardConfirmed: false,
        provider: { id: "contabo", name: "Contabo", instructions: "Na Contabo você mesmo troca (my.contabo.com)." },
        ticketText: null,
      },
    });
    await renderPage();
    expect(await screen.findByText(/podem recusar/)).toBeInTheDocument();
    expect(screen.getByText(/não volta para o IP/)).toBeInTheDocument();
    expect(screen.getByText(/my\.contabo\.com/)).toBeInTheDocument();
    expect(screen.queryByText(/Copiar texto do chamado/)).not.toBeInTheDocument();
  });

  it("PTR não conferido porque o DNS demorou: explica sem alarmar (sem 'podem recusar')", async () => {
    mockApi({ ...CHECKLIST, ptr: { ip: "203.0.113.10", expected: "mail.exemplo.com.br", status: "pending", found: [], forwardConfirmed: null, provider: null, ticketText: null } });
    await renderPage();
    expect(await screen.findByText(/o DNS demorou a responder/)).toBeInTheDocument();
    expect(screen.queryByText(/podem recusar/)).not.toBeInTheDocument();
  });

  it("aba do checklist traz o card de e-mail de teste; o botão abre o modal de postmaster@", async () => {
    mockApi();
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Enviar e-mail de teste/ }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("postmaster@exemplo.com.br");
  });

  it("erro ao carregar → mensagem em vez da tabela", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "not_found", message: "Domínio não encontrado." }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    await renderPage({ openDns: false });
    expect(await screen.findByText("Domínio não encontrado.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Pedido do dono do produto (02/10/2026): a lista mostrava "6/6 registros OK"
// e o detalhe "não verificado"; o certo é abrir em Caixas; e a senha de uma
// caixa nunca fica visível — quem esqueceu troca.
// ---------------------------------------------------------------------------

type Call = { url: string; method: string; body: unknown };

function mockMailboxApi(mailboxes: unknown[] = []): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      let body: unknown = CHECKLIST;
      if (url.endsWith("/verify")) {
        body = {
          domain: "exemplo.com.br",
          records: CHECKLIST.records.map((r) => ({ ...r, status: "found" })),
          ptr: { ...CHECKLIST.ptr, status: "found" },
          summary: { ok: 5, total: 5 },
          verifiedAt: "2026-10-02T12:00:00.000Z",
          suggestion: null,
        };
      } else if (url.endsWith("/mailboxes") && method === "GET") body = { mailboxes };
      else if (url.endsWith("/mailboxes") && method === "POST") {
        body = { mailbox: { id: "vendas@exemplo.com.br", localPart: "vendas", domain: "exemplo.com.br", kind: "user", createdAt: "2026-10-02T12:00:00.000Z" } };
      } else if (url.endsWith("/password")) body = { mailbox: mailboxes[0] };
      else if (url.endsWith("/credentials")) {
        body = {
          credentials: {
            email: "vendas@exemplo.com.br",
            username: "vendas@exemplo.com.br",
            imap: { host: "mail.exemplo.com.br", port: 993, security: "ssl" },
            imapAlt: { host: "mail.exemplo.com.br", port: 143, security: "starttls" },
            smtp: { host: "mail.exemplo.com.br", port: 587, security: "starttls" },
            smtpAlt: { host: "mail.exemplo.com.br", port: 465, security: "ssl" },
            notes: [],
          },
        };
      }
      return new Response(JSON.stringify(body), { status: method === "POST" && url.endsWith("/mailboxes") ? 201 : 200, headers: { "Content-Type": "application/json" } });
    }),
  );
  return calls;
}

const USER_BOX = { id: "vendas@exemplo.com.br", localPart: "vendas", domain: "exemplo.com.br", kind: "user", createdAt: "2026-10-01T12:00:00.000Z" };
const PROJECT_BOX = { id: "loja@exemplo.com.br", localPart: "loja", domain: "exemplo.com.br", kind: "project", createdAt: "2026-10-01T12:00:00.000Z" };

describe("MailDomainPage — abre em Caixas e confere o DNS sozinha", () => {
  it("abre na aba Caixas, que vem primeiro", async () => {
    mockMailboxApi([USER_BOX]);
    await renderPage({ openDns: false });
    expect(await screen.findByText("Caixas de e-mail")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    const tabs = screen.getAllByRole("button", { name: /^(Caixas|Checklist DNS)/ });
    expect(tabs.map((t) => t.textContent)).toEqual(["Caixas (1)", "Checklist DNS"]);
  });

  it("ao abrir, verifica o DNS: a aba DNS já mostra o resultado (igual à lista de domínios)", async () => {
    const calls = mockMailboxApi();
    await renderPage();
    expect(await screen.findByText("5/5 OK")).toBeInTheDocument();
    expect(calls.filter((c) => c.url.endsWith("/verify") && c.method === "POST")).toHaveLength(1);
    expect(screen.queryByText("não verificado")).not.toBeInTheDocument();
  });
});

describe("MailDomainPage — senha das caixas nunca visível", () => {
  it("criar caixa: a pessoa define a senha (com confirmação) e ela não aparece depois", async () => {
    const calls = mockMailboxApi();
    const user = userEvent.setup();
    await renderPage({ openDns: false });
    await user.type(await screen.findByPlaceholderText("contato"), "vendas");
    const create = screen.getByRole("button", { name: /Criar caixa/ });
    expect(create).toBeDisabled();
    await user.type(screen.getByLabelText("Senha da caixa"), "senha-forte-da-pessoa");
    await user.type(screen.getByLabelText("Repita a senha"), "senha-diferente-xx");
    expect(screen.getByText(/As senhas não conferem/)).toBeInTheDocument();
    expect(create).toBeDisabled();
    await user.clear(screen.getByLabelText("Repita a senha"));
    await user.type(screen.getByLabelText("Repita a senha"), "senha-forte-da-pessoa");
    await user.click(create);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/mailboxes"))?.body).toEqual({
        localPart: "vendas",
        password: "senha-forte-da-pessoa",
      }),
    );
    expect(await screen.findByText(/criada/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("senha-forte-da-pessoa");
    expect(screen.getByLabelText("Senha da caixa")).toHaveAttribute("type", "password");
  });

  it("senha curta não habilita o botão", async () => {
    mockMailboxApi();
    const user = userEvent.setup();
    await renderPage({ openDns: false });
    await user.type(await screen.findByPlaceholderText("contato"), "vendas");
    await user.type(screen.getByLabelText("Senha da caixa"), "curta");
    await user.type(screen.getByLabelText("Repita a senha"), "curta");
    expect(screen.getByRole("button", { name: /Criar caixa/ })).toBeDisabled();
    expect(screen.getByText(/pelo menos 12 caracteres/)).toBeInTheDocument();
  });

  it("configuração para app de e-mail: sem senha, com o caminho para trocar", async () => {
    mockMailboxApi([USER_BOX]);
    const user = userEvent.setup();
    await renderPage({ openDns: false });
    await user.click(await screen.findByRole("button", { name: /Configurar no app/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByText("mail.exemplo.com.br", { selector: "code" }).length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/a que você definiu/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Trocar senha/ })).toBeInTheDocument();
  });

  it("trocar senha: nova senha com confirmação, PUT e aviso de sucesso, sem mostrar a senha", async () => {
    const calls = mockMailboxApi([USER_BOX]);
    const user = userEvent.setup();
    await renderPage({ openDns: false });
    await user.click(await screen.findByRole("button", { name: /Trocar senha/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Nova senha"), "nova-senha-forte-123");
    await user.type(within(dialog).getByLabelText("Repita a nova senha"), "nova-senha-forte-123");
    await user.click(within(dialog).getByRole("button", { name: /Salvar nova senha/ }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")).toEqual({
        url: "/api/mail/mailboxes/vendas%40exemplo.com.br/password",
        method: "PUT",
        body: { password: "nova-senha-forte-123" },
      }),
    );
    expect(await screen.findByText(/Senha de vendas@exemplo.com.br trocada/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("nova-senha-forte-123");
    // logo ali, o teste de envio a partir dessa caixa (confirma a senha nova)
    await user.click(screen.getByRole("button", { name: /Enviar e-mail de teste/ }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("vendas@exemplo.com.br");
  });

  it("'Testar envio' em cada caixa abre o modal com aquela caixa como remetente", async () => {
    mockMailboxApi([USER_BOX]);
    const user = userEvent.setup();
    await renderPage({ openDns: false });
    await user.click(await screen.findByRole("button", { name: /Testar envio/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName(/vendas@exemplo\.com\.br/);
    expect(within(dialog).getByPlaceholderText(/gmail/i)).toBeInTheDocument();
  });

  it("caixa técnica de projeto não oferece trocar senha (o painel cuida dela)", async () => {
    mockMailboxApi([PROJECT_BOX]);
    await renderPage({ openDns: false });
    expect(await screen.findByText("loja@exemplo.com.br")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Trocar senha/ })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Validação real na VPS (02/10/2026): o botão de copiar levava "nome  tipo
// valor" juntos, e a pessoa colava tudo num campo só do Cloudflare. Agora cada
// campo tem o seu botão; o MX aparece em Servidor de e-mail e Prioridade.
// ---------------------------------------------------------------------------

function mockClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

function rowOf(name: string, type: string): HTMLElement {
  const rows = within(screen.getByRole("table")).getAllByRole("row");
  const row = rows.find((r) => within(r).queryByText(type, { exact: true }) && r.textContent?.includes(name));
  if (!row) throw new Error(`linha ${type} ${name} não encontrada`);
  return row;
}

const CLOUDFLARE_CHECKLIST: DnsChecklistResponse = {
  ...CHECKLIST,
  records: [
    record("a", "missing", { type: "A", name: "mail.exemplo.com.br", expected: "203.0.113.10" }),
    record("mx", "missing", {
      type: "MX",
      name: "exemplo.com.br",
      expected: "10 mail.exemplo.com.br",
      priority: 10,
      target: "mail.exemplo.com.br",
    }),
    record("spf", "missing", { name: "exemplo.com.br", expected: "v=spf1 ip4:203.0.113.10 ~all" }),
  ],
};

describe("MailDomainPage — checklist DNS copiável por campo", () => {
  it("cada registro tem um botão para o nome e outro para o valor, cada um copiando só aquele campo", async () => {
    const writeText = mockClipboard();
    mockApi(CLOUDFLARE_CHECKLIST);
    await renderPage();
    await screen.findByRole("table");

    const a = rowOf("mail.exemplo.com.br", "A");
    fireEvent.click(within(a).getByRole("button", { name: "Copiar nome de mail.exemplo.com.br" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("mail.exemplo.com.br"));
    fireEvent.click(within(a).getByRole("button", { name: "Copiar valor de mail.exemplo.com.br" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("203.0.113.10"));

    const spf = rowOf("exemplo.com.br", "TXT");
    fireEvent.click(within(spf).getByRole("button", { name: "Copiar valor de exemplo.com.br" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("v=spf1 ip4:203.0.113.10 ~all"));

    // nenhum botão junta nome, tipo e valor
    for (const [text] of writeText.mock.calls as unknown as Array<[string]>) {
      expect(text).not.toMatch(/\s{2}/);
    }
  });

  it("o ícone vira 'copiado' por um instante e depois volta", async () => {
    mockClipboard();
    mockApi(CLOUDFLARE_CHECKLIST);
    await renderPage();
    await screen.findByRole("table");
    const button = within(rowOf("mail.exemplo.com.br", "A")).getByRole("button", {
      name: "Copiar nome de mail.exemplo.com.br",
    });
    fireEvent.click(button);
    await waitFor(() => expect(button.querySelector(".lucide-check")).not.toBeNull());
    await waitFor(() => expect(button.querySelector(".lucide-check")).toBeNull(), { timeout: 3_000 });
  });

  it("MX em dois campos, como no Cloudflare: Servidor de e-mail e Prioridade, cada um com o seu copiar", async () => {
    const writeText = mockClipboard();
    mockApi(CLOUDFLARE_CHECKLIST);
    await renderPage();
    await screen.findByRole("table");

    const mx = rowOf("exemplo.com.br", "MX");
    expect(within(mx).getByText("Servidor de e-mail:")).toBeInTheDocument();
    expect(within(mx).getByText("Prioridade:")).toBeInTheDocument();
    expect(within(mx).getByText(/No Cloudflare, o MX tem dois campos: Servidor de e-mail e Prioridade\./)).toBeInTheDocument();
    // o valor junto ("10 mail…") não aparece para a pessoa copiar de uma vez
    expect(mx.textContent).not.toContain("10 mail.exemplo.com.br");

    fireEvent.click(within(mx).getByRole("button", { name: "Copiar servidor de e-mail de exemplo.com.br" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("mail.exemplo.com.br"));
    fireEvent.click(within(mx).getByRole("button", { name: "Copiar prioridade de exemplo.com.br" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("10"));
    fireEvent.click(within(mx).getByRole("button", { name: "Copiar nome de exemplo.com.br" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("exemplo.com.br"));
  });

  it("MX de um servidor antigo (sem os campos separados): separa a partir do valor", async () => {
    mockClipboard();
    mockApi();
    await renderPage();
    await screen.findByRole("table");
    const mx = rowOf("mx.exemplo.com.br", "MX");
    expect(within(mx).getByText("Servidor de e-mail:")).toBeInTheDocument();
    expect(within(mx).getByRole("button", { name: "Copiar prioridade de mx.exemplo.com.br" })).toBeInTheDocument();
    expect(mx.textContent).toContain("mail.exemplo.com.br");
  });

  it("registro A de mail.<domínio>: lembra de deixar o proxy do Cloudflare desligado", async () => {
    mockApi(CLOUDFLARE_CHECKLIST);
    await renderPage();
    await screen.findByRole("table");
    expect(within(rowOf("mail.exemplo.com.br", "A")).getByText("No Cloudflare: Proxy desligado (nuvem cinza)")).toBeInTheDocument();
    expect(within(rowOf("exemplo.com.br", "TXT")).queryByText(/nuvem cinza/)).not.toBeInTheDocument();
  });
});

describe("MailDomainPage — certificado pedido pela verificação", () => {
  it("o registro A ficou certo e a verificação pediu o certificado: avisa com link para Certificados", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = url.endsWith("/mailboxes")
          ? { mailboxes: [] }
          : url.endsWith("/verify")
            ? {
                ...CHECKLIST,
                verifiedAt: "2026-10-02T12:00:00.000Z",
                summary: { ok: 1, total: 5 },
                certificateRetry: { host: "mail.exemplo.com.br", message: "Pedimos ao proxy…" },
              }
            : CHECKLIST;
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
    await renderPage();
    expect(
      await screen.findByText(/Certificado de mail\.exemplo\.com\.br: emissão pedida — confira em/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Certificados" })).toHaveAttribute("href", "/certificates");
  });

  it("sem pedido de certificado, sem aviso", async () => {
    mockApi();
    await renderPage();
    await screen.findByText("1/5 OK");
    expect(screen.queryByText(/emissão pedida/)).not.toBeInTheDocument();
  });
});

describe("MailDomainPage — PTR pendente com detalhe técnico", () => {
  it("mostra qual consulta ficou sem resposta e onde", async () => {
    mockApi({
      ...CHECKLIST,
      ptr: {
        ip: "203.0.113.10",
        expected: "mail.exemplo.com.br",
        status: "pending",
        found: [],
        ticketText: null,
        diagnostic: "reverso de 203.0.113.10 — DNS público (1.1.1.1, 8.8.8.8): sem resposta (ETIMEOUT)",
      },
    });
    await renderPage();
    expect(await screen.findByText(/Detalhe técnico/)).toBeInTheDocument();
    expect(screen.getByText(/sem resposta \(ETIMEOUT\)/)).toBeInTheDocument();
  });
});

describe("MailDomainPage — endereço com ?aba=dns", () => {
  it("abre direto no Checklist DNS (link do e-mail do projeto)", async () => {
    mockMailboxApi();
    render(
      <MemoryRouter initialEntries={["/mail/exemplo.com.br?aba=dns"]}>
        <Routes>
          <Route path="/mail/:domain" element={<MailDomainPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("table")).toBeInTheDocument();
  });
});
