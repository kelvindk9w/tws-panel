/**
 * E-mail do projeto (seção E-mail da página do projeto).
 * Pedido do dono do produto (02/10/2026): cada projeto escolhe o endereço de
 * envio (ex.: nao-responda@) e o nome que aparece para quem recebe; a tela
 * diz se o domínio está pronto (DNS), lembra do novo deploy e permite testar
 * o envio.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailDomainSummary, ProjectEmailConfig } from "@paas/core";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, init?: RequestInit) => apiFetchMock(path, init),
  ApiRequestError: class extends Error {},
}));

import { ProjectEmailCard } from "@/components/project/ProjectEmailCard";

const OFF: ProjectEmailConfig = { enabled: false, domain: null, mailbox: null, mailFrom: null, env: {} };
const ON: ProjectEmailConfig = {
  enabled: true,
  domain: "envio.exemplo.com.br",
  mailbox: "cassino@envio.exemplo.com.br",
  mailFrom: "nao-responda@envio.exemplo.com.br",
  fromName: "Cassino Royal",
  env: {
    SMTP_HOST: "mail.envio.exemplo.com.br",
    SMTP_PORT: "587",
    SMTP_USER: "cassino@envio.exemplo.com.br",
    SMTP_PASS: "••••••••••••",
    MAIL_FROM: "nao-responda@envio.exemplo.com.br",
    MAIL_FROM_NAME: "Cassino Royal",
  },
};

function domain(name: string, ok: number, total = 6): MailDomainSummary {
  return {
    name,
    dkimSelector: "paas",
    dkimPublicKey: "x",
    dkimKeyBits: 2048,
    dmarcStage: "none",
    createdAt: "2026-10-01T00:00:00.000Z",
    mailboxCount: 1,
    lastVerify: { at: "2026-10-02T12:00:00.000Z", ok, total },
  } as MailDomainSummary;
}

function serve(email: ProjectEmailConfig, domains: MailDomainSummary[] = [domain("envio.exemplo.com.br", 6)]) {
  let current = email;
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path === "/api/mail/domains") return { domains };
    if (path === "/api/projects/p1/email" && method === "GET") return { email: current };
    if (path === "/api/projects/p1/email" && method === "POST") {
      current = ON;
      return { email: current };
    }
    if (path === "/api/projects/p1/email" && method === "DELETE") {
      current = OFF;
      return { email: current };
    }
    throw new Error(`rota inesperada: ${method} ${path}`);
  });
}

function renderCard() {
  return render(
    <MemoryRouter>
      <ProjectEmailCard projectId="p1" projectName="Cassino Royal" projectSlug="cassino" />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
});
afterEach(() => cleanup());

describe("ProjectEmailCard — ativar", () => {
  it("escolhe domínio, endereço de envio e nome; manda tudo ao ativar", async () => {
    serve(OFF);
    const user = userEvent.setup();
    renderCard();
    const local = await screen.findByLabelText("Endereço de envio");
    expect(local).toHaveAttribute("placeholder", "cassino");
    expect(screen.getByLabelText("Nome de exibição")).toHaveAttribute("placeholder", "Cassino Royal");
    await user.type(local, "nao-responda");
    await user.type(screen.getByLabelText("Nome de exibição"), "Cassino");
    expect(screen.getByText(/Cassino <nao-responda@envio\.exemplo\.com\.br>/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Ativar e-mail/ }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/projects/p1/email",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ domain: "envio.exemplo.com.br", fromLocalPart: "nao-responda", fromName: "Cassino" }),
        }),
      ),
    );
  });

  it("em branco: envia como a caixa técnica com o nome do projeto (só o domínio vai na requisição)", async () => {
    serve(OFF);
    const user = userEvent.setup();
    renderCard();
    await screen.findByLabelText("Endereço de envio");
    expect(screen.getByText(/Cassino Royal <cassino@envio\.exemplo\.com\.br>/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Ativar e-mail/ }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/projects/p1/email",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ domain: "envio.exemplo.com.br" }) }),
      ),
    );
  });

  it("domínio com DNS pendente: avisa que o envio pode falhar e leva ao domínio", async () => {
    serve(OFF, [domain("envio.exemplo.com.br", 4)]);
    renderCard();
    const warn = await screen.findByText(/DNS deste domínio ainda tem pendências/);
    expect(within(warn.closest("div")!).getByRole("link")).toHaveAttribute("href", "/mail/envio.exemplo.com.br");
  });

  it("sem domínio de e-mail: explica o passo a passo e leva à página E-mail", async () => {
    serve(OFF, []);
    renderCard();
    expect(await screen.findByText(/Nenhum domínio de e-mail/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /E-mail/ })).toHaveAttribute("href", "/mail");
  });
});

describe("ProjectEmailCard — ativado", () => {
  it("mostra o remetente, as variáveis, lembra do novo deploy e testa o envio pela caixa técnica", async () => {
    serve(ON);
    const user = userEvent.setup();
    renderCard();
    expect(await screen.findByText("Cassino Royal <nao-responda@envio.exemplo.com.br>")).toBeInTheDocument();
    expect(screen.getByText("MAIL_FROM_NAME")).toBeInTheDocument();
    expect(screen.getByText(/novo deploy/)).toBeInTheDocument();
    // exemplo do compose com um $ só (antes saía "$${SMTP_PORT}")
    expect(screen.getByTestId("email-other-names").textContent).toContain("SMTP_PORTA: ${SMTP_PORT}");
    expect(screen.getByTestId("email-other-names").textContent).not.toContain("$${");
    await user.click(screen.getByRole("button", { name: /Enviar e-mail de teste/ }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("cassino@envio.exemplo.com.br");
  });

  it("'Alterar remetente' abre o formulário já preenchido", async () => {
    serve(ON);
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: /Alterar remetente/ }));
    expect(screen.getByLabelText("Endereço de envio")).toHaveValue("nao-responda");
    expect(screen.getByLabelText("Nome de exibição")).toHaveValue("Cassino Royal");
    expect(screen.getByRole("button", { name: /Salvar/ })).toBeInTheDocument();
  });

  it("desativar", async () => {
    serve(ON);
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: /Desativar e-mail/ }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith("/api/projects/p1/email", expect.objectContaining({ method: "DELETE" })),
    );
  });
});
