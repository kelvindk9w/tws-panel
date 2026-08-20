/**
 * Testes da tabela de checklist DNS (MailDomainPage): badges de status por
 * registro (encontrado/ausente/divergente/não verificado) e o resumo
 * encontrado/total após a verificação.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
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

function mockApi(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.endsWith("/mailboxes") ? { mailboxes: [] } : CHECKLIST;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={["/mail/exemplo.com.br"]}>
      <Routes>
        <Route path="/mail/:domain" element={<MailDomainPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MailDomainPage — tabela de checklist DNS", () => {
  it("exibe um badge correto por status: ✅ encontrado, ❌ ausente, ⚠️ divergente, não verificado", async () => {
    mockApi();
    renderPage();

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
    renderPage();

    expect(await screen.findByText(/mecanismo final difere/)).toBeInTheDocument();
    expect(screen.getByText(/v=spf1 ip4:203.0.113.10 ~all/)).toBeInTheDocument();
  });

  it("PTR com ação necessária exibe o card de reverse DNS com o texto do chamado", async () => {
    mockApi();
    renderPage();

    expect(await screen.findByText(/Reverse DNS \(PTR\)/)).toBeInTheDocument();
    expect(screen.getByText(/FCrDNS/)).toBeInTheDocument();
    expect(screen.getByText("chamado…")).toBeInTheDocument();
  });

  it("após 'Verificar agora', exibe o resumo encontrado/total (1/5 OK)", async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole("table");
    await user.click(screen.getByRole("button", { name: /verificar agora/i }));

    // verify retorna o mesmo checklist: 1 registro found de 4 + PTR não resolvido = 1/5
    expect(await screen.findByText("1/5 OK")).toBeInTheDocument();
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
    renderPage();
    expect(await screen.findByText("Domínio não encontrado.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
