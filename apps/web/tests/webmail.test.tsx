/**
 * Webmail na tela (pedido do dono do produto, 04/10/2026): card "Webmail"
 * na página E-mail (ativar/desativar, estado, "Abrir webmail" por domínio) e
 * o botão "Abrir webmail" em cada caixa, que abre https://mail.<domínio>/
 * numa aba nova com o usuário preenchido — nunca a senha.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mailbox, WebmailStatus } from "@paas/core";
import { WebmailCard } from "@/components/mail/WebmailCard";
import { MailboxesPanel } from "@/components/mail/MailboxesPanel";

const OFF: WebmailStatus = {
  enabled: false,
  installed: false,
  running: false,
  image: "roundcube/roundcubemail:1.7.4-apache-nonroot",
  containerName: "paas-webmail",
  mailServerRunning: true,
  tlsVerified: true,
  links: [
    { domain: "exemplo.com.br", host: "mail.exemplo.com.br", url: "https://mail.exemplo.com.br/" },
    { domain: "outro.com", host: "mail.outro.com", url: "https://mail.outro.com/" },
  ],
  blockedIps: 0,
  message: "Ative o webmail para ler e enviar e-mails das caixas pelo navegador.",
};
const ON: WebmailStatus = { ...OFF, enabled: true, installed: true, running: true, message: null };

type Call = { url: string; method: string };

function mockApi(initial: WebmailStatus, opts: { enableError?: string; mailboxes?: Mailbox[]; proxyError?: string } = {}): Call[] {
  const calls: Call[] = [];
  let current = initial;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      let status = 200;
      let body: unknown = { error: "not_found", message: "?" };
      if (url.endsWith("/api/mail/webmail")) body = current;
      else if (url.endsWith("/api/mail/webmail/enable")) {
        if (opts.enableError) {
          status = 409;
          body = { error: "mail_server_stopped", message: opts.enableError };
        } else {
          current = ON;
          body = { ok: true, status: ON, ...(opts.proxyError ? { proxyError: opts.proxyError } : {}) };
        }
      } else if (url.endsWith("/api/mail/webmail/disable")) {
        current = OFF;
        body = { ok: true, status: OFF };
      } else if (url.includes("/mailboxes")) body = { mailboxes: opts.mailboxes ?? [] };
      else status = 404;
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WebmailCard", () => {
  it("desativado: explica e oferece ativar; sem links ainda", async () => {
    mockApi(OFF);
    render(<WebmailCard />);
    expect(await screen.findByText("desativado")).toBeInTheDocument();
    expect(screen.getByText(/Ative o webmail/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Abrir webmail/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ativar webmail/ })).toBeEnabled();
  });

  it("ativar: chama a API e passa a mostrar um 'Abrir webmail' por domínio, em aba nova", async () => {
    const calls = mockApi(OFF);
    render(<WebmailCard />);
    await userEvent.click(await screen.findByRole("button", { name: /Ativar webmail/ }));
    expect(await screen.findByText("ativo")).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith("/api/mail/webmail/enable") && c.method === "POST")).toBe(true);
    const links = screen.getAllByRole("link", { name: /Abrir webmail/ });
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["https://mail.exemplo.com.br/", "https://mail.outro.com/"]);
    for (const l of links) {
      expect(l).toHaveAttribute("target", "_blank");
      expect(l.getAttribute("rel")).toContain("noopener");
    }
    expect(screen.getByText(/10 minutos sem uso/)).toBeInTheDocument();
  });

  it("erro ao ativar aparece na tela", async () => {
    mockApi(OFF, { enableError: "O servidor de e-mail está parado." });
    render(<WebmailCard />);
    await userEvent.click(await screen.findByRole("button", { name: /Ativar webmail/ }));
    expect(await screen.findByText("O servidor de e-mail está parado.")).toBeInTheDocument();
  });

  it("proxy não atualizou: aviso para tentar de novo", async () => {
    mockApi(OFF, { proxyError: "caddy fora" });
    render(<WebmailCard />);
    await userEvent.click(await screen.findByRole("button", { name: /Ativar webmail/ }));
    expect(await screen.findByText(/caddy fora/)).toBeInTheDocument();
  });

  it("desativar pede confirmação", async () => {
    const calls = mockApi(ON);
    render(<WebmailCard />);
    await userEvent.click(await screen.findByRole("button", { name: /Desativar/ }));
    expect(calls.some((c) => c.url.endsWith("/disable"))).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: /Confirmar/ }));
    expect(await screen.findByText("desativado")).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith("/api/mail/webmail/disable") && c.method === "POST")).toBe(true);
  });

  it("desativar e cancelar", async () => {
    const calls = mockApi(ON);
    render(<WebmailCard />);
    await userEvent.click(await screen.findByRole("button", { name: /Desativar/ }));
    await userEvent.click(screen.getByRole("button", { name: /Cancelar/ }));
    expect(screen.getByRole("button", { name: /Desativar/ })).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith("/disable"))).toBe(false);
  });

  it("servidor de e-mail parado: não deixa ativar", async () => {
    mockApi({ ...OFF, mailServerRunning: false, message: "O servidor de e-mail está parado. Inicie-o para usar o webmail." });
    render(<WebmailCard />);
    expect(await screen.findByText(/servidor de e-mail está parado/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ativar webmail/ })).toBeDisabled();
  });

  it("ativado mas parado; certificado ainda não instalado; IPs bloqueados", async () => {
    mockApi({ ...ON, running: false, tlsVerified: false, blockedIps: 2, message: "O webmail está ativado, mas não está rodando." });
    render(<WebmailCard />);
    expect(await screen.findByText("parado")).toBeInTheDocument();
    expect(screen.getByText(/certificado de verdade ainda não foi instalado/)).toBeInTheDocument();
    expect(screen.getByText(/2 conexões bloqueadas/)).toBeInTheDocument();
    // parado: "Ativar webmail" sobe de novo
    expect(screen.getByRole("button", { name: /Ativar webmail/ })).toBeInTheDocument();
  });

  it("um IP bloqueado: singular", async () => {
    mockApi({ ...ON, blockedIps: 1 });
    render(<WebmailCard />);
    expect(await screen.findByText(/1 conexão bloqueada/)).toBeInTheDocument();
  });

  it("falha ao carregar: mostra o erro", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "x", message: "sem conexão" }), { status: 500 })));
    render(<WebmailCard />);
    expect(await screen.findByText("sem conexão")).toBeInTheDocument();
  });
});

describe("MailboxesPanel — Abrir webmail", () => {
  const BOX: Mailbox = {
    id: "contato@exemplo.com.br",
    localPart: "contato",
    domain: "exemplo.com.br",
    kind: "user",
    createdAt: "2026-10-01T12:00:00.000Z",
  };

  it("webmail ativo: cada caixa abre o webmail do domínio com o usuário preenchido (sem senha)", async () => {
    mockApi(ON, { mailboxes: [BOX] });
    render(
      <MemoryRouter>
        <MailboxesPanel domain="exemplo.com.br" />
      </MemoryRouter>,
    );
    const link = await screen.findByRole("link", { name: /Abrir webmail/ });
    expect(link).toHaveAttribute("href", "https://mail.exemplo.com.br/?_user=contato%40exemplo.com.br");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("href")).not.toMatch(/pass/i);
  });

  it("webmail desativado (ou sem o domínio): sem o botão", async () => {
    mockApi(OFF, { mailboxes: [BOX] });
    render(
      <MemoryRouter>
        <MailboxesPanel domain="exemplo.com.br" />
      </MemoryRouter>,
    );
    await screen.findByText("contato@exemplo.com.br");
    await waitFor(() => expect(screen.queryByRole("link", { name: /Abrir webmail/ })).not.toBeInTheDocument());

    cleanup();
    mockApi({ ...ON, links: [] }, { mailboxes: [BOX] });
    render(
      <MemoryRouter>
        <MailboxesPanel domain="exemplo.com.br" />
      </MemoryRouter>,
    );
    await screen.findByText("contato@exemplo.com.br");
    expect(screen.queryByRole("link", { name: /Abrir webmail/ })).not.toBeInTheDocument();
  });
});
