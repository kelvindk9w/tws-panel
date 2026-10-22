/**
 * E-mail do projeto (seção E-mail da página do projeto).
 * Pedido do dono do produto (02/10/2026): cada projeto escolhe o endereço de
 * envio (ex.: contato@) e o nome que aparece para quem recebe; a tela diz se
 * o domínio está pronto (DNS), lembra do novo deploy e permite testar o envio.
 *
 * Validação real do mesmo dia: o endereço de envio era só um alias de uma
 * caixa técnica sem senha — não dava para ler as respostas. Agora ele É a
 * caixa do projeto, com a senha que a pessoa digita ou que o painel gera e
 * mostra uma vez. E os valores podem ser ligados a outras variáveis do app.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DnsChecklistResponse, Mailbox, MailDomainSummary, ProjectEmailConfig, ProjectEmailUsableMailbox } from "@paas/core";
import { setLocale } from "@/i18n/core";

// Cada teste monta o cartão inteiro e digita campos longos; no runner do CI
// (mais lento) um deles passou de 5 s. Limite maior só neste arquivo.
vi.setConfig({ testTimeout: 20_000 });

const apiFetchMock = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, init?: RequestInit) => apiFetchMock(path, init),
  ApiRequestError: class ApiRequestError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
      public readonly data?: Record<string, unknown>,
    ) {
      super(message);
    }
  },
}));

import { ProjectEmailCard } from "@/components/project/ProjectEmailCard";
import { ApiRequestError } from "@/lib/api";

const SENHA = "senha-forte-da-pessoa";
const GERADA = "Gerada-Forte_123abcXYZ.9";
const OFF: ProjectEmailConfig = { enabled: false, domain: null, mailbox: null, mailFrom: null, env: {} };
const ON: ProjectEmailConfig = {
  enabled: true,
  domain: "envio.exemplo.com.br",
  mailbox: "contato@envio.exemplo.com.br",
  mailFrom: "contato@envio.exemplo.com.br",
  fromName: "Contato - Loja",
  env: {
    SMTP_HOST: "mail.envio.exemplo.com.br",
    SMTP_PORT: "587",
    SMTP_USER: "contato@envio.exemplo.com.br",
    SMTP_PASS: "••••••••••••",
    MAIL_FROM: "contato@envio.exemplo.com.br",
    MAIL_FROM_NAME: "Contato - Loja",
  },
  envLinks: {},
  legacyAlias: false,
};
/** Gravado antes da mudança: endereço de envio como alias da caixa técnica. */
const LEGACY: ProjectEmailConfig = {
  ...ON,
  mailbox: "loja@envio.exemplo.com.br",
  env: { ...ON.env, SMTP_USER: "loja@envio.exemplo.com.br" },
  legacyAlias: true,
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

interface ServeOpts {
  domains?: MailDomainSummary[];
  generated?: string;
  envList?: { vars: { key: string; value: string }[]; compose: unknown; provided?: string[] };
  mailboxes?: Mailbox[];
  usable?: ProjectEmailUsableMailbox[];
  usableError?: boolean;
  connectError?: Error;
  passwordVerified?: boolean;
}

const DNS_CHECKLIST: DnsChecklistResponse = {
  domain: "envio.exemplo.com.br",
  mailHostname: "mail.envio.exemplo.com.br",
  serverIp: "203.0.113.10",
  records: [
    {
      id: "a",
      type: "A",
      name: "mail.envio.exemplo.com.br",
      expected: "203.0.113.10",
      purpose: "servidor",
      status: "found",
      found: ["203.0.113.10"],
      note: null,
    },
  ],
  ptr: { ip: "203.0.113.10", expected: "mail.envio.exemplo.com.br", status: "missing", found: [], ticketText: "chamado…" },
  suggestion: null,
};

function serve(email: ProjectEmailConfig, opts: ServeOpts = {}) {
  let current = email;
  const domains = opts.domains ?? [domain("envio.exemplo.com.br", 6)];
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path === "/api/mail/domains") return { domains };
    if (path === "/api/projects/p1/email" && method === "GET") return { email: current };
    if (path.startsWith("/api/projects/p1/email/mailboxes?domain=") && method === "GET") {
      if (opts.usableError) throw new ApiRequestError(500, "boom", "Falha do servidor");
      return { mailboxes: opts.usable ?? [] };
    }
    if (path === "/api/projects/p1/email" && method === "POST") {
      const posted = JSON.parse(String(init?.body)) as { useExistingMailbox?: string };
      if (posted.useExistingMailbox && opts.connectError) throw opts.connectError;
      if (posted.useExistingMailbox) {
        current = ON;
        return {
          email: current,
          ...(opts.generated ? { generatedPassword: opts.generated } : {}),
          ...(opts.passwordVerified !== undefined ? { passwordVerified: opts.passwordVerified } : {}),
        };
      }
      current = ON;
      return opts.generated ? { email: current, generatedPassword: opts.generated } : { email: current };
    }
    if (path === "/api/projects/p1/email" && method === "DELETE") {
      current = OFF;
      return { email: current };
    }
    if (path === "/api/projects/p1/email/links" && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as { links: Record<string, never> };
      current = { ...current, envLinks: body.links };
      return { email: current };
    }
    if (path === "/api/projects/p1/env") {
      return opts.envList ?? { vars: [], compose: null, provided: [] };
    }
    // abas Caixas e DNS (domínio do projeto)
    if (path === "/api/mail/domains/envio.exemplo.com.br/mailboxes?projectId=p1" && method === "GET") {
      return { mailboxes: opts.mailboxes ?? [] };
    }
    if (path === "/api/mail/domains/envio.exemplo.com.br/dns") return DNS_CHECKLIST;
    if (path === "/api/mail/domains/envio.exemplo.com.br/verify" && method === "POST") {
      return { ...DNS_CHECKLIST, summary: { ok: 1, total: 2 }, verifiedAt: "2026-10-03T12:00:00.000Z" };
    }
    if (path.startsWith("/api/mail/mailboxes/") && path.endsWith("/password")) {
      const body = JSON.parse(String(init?.body)) as { generate?: boolean };
      const mailbox = { id: current.mailbox, localPart: "contato", domain: current.domain, kind: "project", createdAt: "x" };
      return body.generate ? { mailbox, generatedPassword: GERADA } : { mailbox };
    }
    if (path.startsWith("/api/mail/mailboxes/") && path.endsWith("/credentials")) {
      return {
        credentials: {
          email: current.mailbox,
          username: current.mailbox,
          imap: { host: "mail.envio.exemplo.com.br", port: 993, security: "ssl" },
          imapAlt: { host: "mail.envio.exemplo.com.br", port: 143, security: "starttls" },
          smtp: { host: "mail.envio.exemplo.com.br", port: 587, security: "starttls" },
          smtpAlt: { host: "mail.envio.exemplo.com.br", port: 465, security: "ssl" },
          notes: [],
        },
      };
    }
    throw new Error(`rota inesperada: ${method} ${path}`);
  });
}

function bodyOf(path: string, method: string): unknown {
  const call = apiFetchMock.mock.calls.find(([p, i]) => p === path && (i as RequestInit | undefined)?.method === method);
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : undefined;
}

function renderCard() {
  return render(
    <MemoryRouter>
      <ProjectEmailCard projectId="p1" projectName="Loja Royal" projectSlug="loja" projectDomain="loja.example.com" />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
});
afterEach(() => {
  cleanup();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  setLocale("pt-BR", { persist: false });
});

describe("ProjectEmailCard — ativar", () => {
  it("escolhe domínio, endereço, nome e digita a senha duas vezes; manda tudo ao ativar", async () => {
    serve(OFF);
    const user = userEvent.setup();
    renderCard();
    const local = await screen.findByLabelText("Endereço de envio");
    expect(local).toHaveAttribute("placeholder", "loja");
    expect(screen.getByLabelText("Nome de exibição (opcional)")).toHaveAttribute("placeholder", "Loja Royal");
    await user.type(local, "contato");
    // campos longos entram por colagem (um evento só), não tecla a tecla
    await user.click(screen.getByLabelText("Nome de exibição (opcional)"));
    await user.paste("Contato - Loja");
    expect(screen.getByText(/Contato - Loja <contato@envio\.exemplo\.com\.br>/)).toBeInTheDocument();
    // a caixa é o próprio endereço: dá para abrir num app de e-mail
    expect(screen.getByTestId("mailbox-explain")).toHaveTextContent(/contato@envio\.exemplo\.com\.br/);
    const pass = screen.getByLabelText("Senha da caixa");
    expect(pass).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Repita a senha")).toHaveAttribute("type", "password");
    await user.click(pass);
    await user.paste(SENHA);
    await user.click(screen.getByLabelText("Repita a senha"));
    await user.paste(SENHA);
    await user.click(screen.getByRole("button", { name: /Ativar e-mail/ }));
    await waitFor(() =>
      expect(bodyOf("/api/projects/p1/email", "POST")).toEqual({
        domain: "envio.exemplo.com.br",
        fromLocalPart: "contato",
        fromName: "Contato - Loja",
        password: SENHA,
      }),
    );
  });

  it("senha curta ou repetição diferente: avisa e não deixa ativar", async () => {
    serve(OFF);
    const user = userEvent.setup();
    renderCard();
    await user.type(await screen.findByLabelText("Senha da caixa"), "curta");
    expect(screen.getByText(/pelo menos 12 caracteres/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ativar e-mail/ })).toBeDisabled();
    await user.clear(screen.getByLabelText("Senha da caixa"));
    await user.type(screen.getByLabelText("Senha da caixa"), SENHA);
    await user.type(screen.getByLabelText("Repita a senha"), `${SENHA}x`);
    expect(screen.getByText(/As duas senhas não são iguais/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ativar e-mail/ })).toBeDisabled();
  });

  it("'Gerar uma senha forte para mim': mostra a senha uma vez, com copiar e o aviso de guardar", async () => {
    serve(OFF, { generated: GERADA });
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderCard();
    await user.click(await screen.findByRole("radio", { name: /Gerar uma senha forte para mim/ }));
    expect(screen.queryByLabelText("Senha da caixa")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Ativar e-mail/ }));
    await waitFor(() => expect(bodyOf("/api/projects/p1/email", "POST")).toEqual({ domain: "envio.exemplo.com.br", generatePassword: true }));
    const box = await screen.findByTestId("generated-password");
    expect(box).toHaveTextContent(GERADA);
    expect(box).toHaveTextContent("Guarde agora: o painel não mostra de novo. Esqueceu? Use Trocar senha.");
    fireEvent.click(within(box).getByRole("button", { name: /Copiar a senha/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(GERADA));
    await user.click(within(box).getByRole("button", { name: /Já guardei/ }));
    expect(screen.queryByText(GERADA)).not.toBeInTheDocument();
  });

  it("domínio com DNS pendente: avisa que o envio pode falhar e leva ao domínio", async () => {
    serve(OFF, { domains: [domain("envio.exemplo.com.br", 4)] });
    renderCard();
    const warn = await screen.findByText(/DNS deste domínio ainda tem pendências/);
    expect(within(warn.closest("div")!).getByRole("link")).toHaveAttribute("href", "/mail/envio.exemplo.com.br");
  });

  it("sem domínio de e-mail: explica e já oferece cadastrar o domínio do projeto, preenchido", async () => {
    serve(OFF, { domains: [] });
    renderCard();
    expect(await screen.findByText(/Nenhum domínio de e-mail/)).toBeInTheDocument();
    expect(screen.getByLabelText("Seu domínio")).toHaveValue("loja.example.com");
  });
});

describe("ProjectEmailCard — ativado", () => {
  it("mostra o remetente, a caixa, as variáveis com copiar (menos a senha) e lembra do novo deploy", async () => {
    serve(ON);
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderCard();
    expect(await screen.findByText("Contato - Loja <contato@envio.exemplo.com.br>")).toBeInTheDocument();
    expect(screen.getByText("MAIL_FROM_NAME")).toBeInTheDocument();
    expect(screen.getByText(/novo deploy/)).toBeInTheDocument();
    expect(screen.getByTestId("display-name-note")).toHaveTextContent(
      "O nome de exibição aparece para quem recebe quando o app do projeto usa MAIL_FROM_NAME (ou monta 'Nome <endereço>'). O e-mail de teste já sai com ele.",
    );
    for (const key of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "MAIL_FROM", "MAIL_FROM_NAME"]) {
      expect(screen.getByRole("button", { name: `Copiar ${key}` })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Copiar SMTP_PASS" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copiar SMTP_HOST" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("mail.envio.exemplo.com.br"));
    await user.click(screen.getByRole("button", { name: /Enviar e-mail de teste/ }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("contato@envio.exemplo.com.br");
  });

  it("'Configurar no app': servidor, portas e usuário da caixa, sem senha", async () => {
    serve(ON);
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: /Configurar no app/ }));
    const box = await screen.findByTestId("mailbox-app-settings");
    expect(apiFetchMock).toHaveBeenCalledWith("/api/mail/mailboxes/contato%40envio.exemplo.com.br/credentials", undefined);
    expect(box).toHaveTextContent("mail.envio.exemplo.com.br");
    expect(box).toHaveTextContent("993");
    expect(box).toHaveTextContent("587");
    expect(box).toHaveTextContent("contato@envio.exemplo.com.br");
    expect(box).toHaveTextContent(/Trocar senha/);
    await user.click(screen.getByRole("button", { name: /Configurar no app/ }));
    expect(screen.queryByTestId("mailbox-app-settings")).not.toBeInTheDocument();
  });

  it("'Trocar senha': digitada, troca e avisa que vale no próximo deploy", async () => {
    serve(ON);
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: /^Trocar senha$/ }));
    await user.type(screen.getByLabelText("Nova senha"), SENHA);
    await user.type(screen.getByLabelText("Repita a senha"), SENHA);
    await user.click(screen.getByRole("button", { name: /Salvar a senha nova/ }));
    await waitFor(() =>
      expect(bodyOf("/api/mail/mailboxes/contato%40envio.exemplo.com.br/password", "PUT")).toEqual({ password: SENHA }),
    );
    expect(await screen.findByText(/O projeto só recebe a senha nova no próximo deploy/)).toBeInTheDocument();
  });

  it("'Trocar senha' gerando uma forte: mostra a gerada uma vez", async () => {
    serve(ON);
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: /^Trocar senha$/ }));
    await user.click(screen.getByRole("radio", { name: /Gerar uma senha forte para mim/ }));
    await user.click(screen.getByRole("button", { name: /Salvar a senha nova/ }));
    await waitFor(() =>
      expect(bodyOf("/api/mail/mailboxes/contato%40envio.exemplo.com.br/password", "PUT")).toEqual({ generate: true }),
    );
    expect(await screen.findByTestId("generated-password")).toHaveTextContent(GERADA);
    expect(screen.getByText(/O projeto só recebe a senha nova no próximo deploy/)).toBeInTheDocument();
  });

  it("'Alterar remetente': preenchido; mesmo endereço não pede senha, endereço novo pede", async () => {
    serve(ON);
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: /Alterar remetente/ }));
    expect(screen.getByLabelText("Endereço de envio")).toHaveValue("contato");
    expect(screen.getByLabelText("Nome de exibição (opcional)")).toHaveValue("Contato - Loja");
    expect(screen.queryByLabelText("Senha da caixa")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Salvar$/ }));
    await waitFor(() =>
      expect(bodyOf("/api/projects/p1/email", "POST")).toEqual({
        domain: "envio.exemplo.com.br",
        fromLocalPart: "contato",
        fromName: "Contato - Loja",
      }),
    );
  });

  it("endereço novo: pede a senha e avisa que a caixa antiga sai", async () => {
    serve(ON);
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: /Alterar remetente/ }));
    await user.clear(screen.getByLabelText("Endereço de envio"));
    await user.type(screen.getByLabelText("Endereço de envio"), "vendas");
    expect(screen.getByLabelText("Senha da caixa")).toBeInTheDocument();
    expect(screen.getByTestId("old-mailbox-note")).toHaveTextContent(/contato@envio\.exemplo\.com\.br será removida/);
  });

  it("registro antigo (alias): explica e, ao salvar, pede a senha da caixa nova", async () => {
    serve(LEGACY);
    const user = userEvent.setup();
    renderCard();
    expect(await screen.findByTestId("legacy-alias")).toHaveTextContent(/Alterar remetente/);
    await user.click(screen.getByRole("button", { name: /Alterar remetente/ }));
    expect(screen.getByLabelText("Endereço de envio")).toHaveValue("contato");
    expect(screen.getByLabelText("Senha da caixa")).toBeInTheDocument();
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

/**
 * O app do projeto usa outros nomes (SMTP_SENHA, EMAIL_DE…): a pessoa liga
 * cada valor a uma variável do projeto. O painel guarda só o mapeamento.
 */
describe("ProjectEmailCard — ligar às variáveis do projeto", () => {
  const ENV_LIST = {
    vars: [{ key: "EMAIL_DE", value: "" }],
    compose: {
      usesEnvFile: true,
      variables: [
        { name: "SMTP_SENHA", required: true, defaultValue: null },
        { name: "SMTP_HOST", required: true, defaultValue: null },
      ],
    },
    provided: [],
  };

  it("uma linha por valor; escolhe a variável na lista com busca e salva só o mapeamento", async () => {
    serve(ON, { envList: ENV_LIST });
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: /Ligar às variáveis do projeto/ }));
    const dialog = await screen.findByRole("dialog", { name: /Ligar às variáveis do projeto/ });
    for (const key of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "MAIL_FROM", "MAIL_FROM_NAME"]) {
      expect(within(dialog).getByRole("combobox", { name: `Variável que recebe ${key}` })).toBeInTheDocument();
    }
    const pass = within(dialog).getByRole("combobox", { name: "Variável que recebe SMTP_PASS" });
    await user.click(pass);
    // opções: padrão, as do compose e as já cadastradas; os nomes do próprio e-mail aparecem desabilitados
    const names = within(dialog).getAllByRole("option").map((o) => o.textContent);
    expect(names.some((n) => n?.startsWith("mesmo nome (padrão)"))).toBe(true);
    expect(names.some((n) => n?.startsWith("SMTP_SENHA"))).toBe(true);
    expect(names.some((n) => n?.startsWith("EMAIL_DE"))).toBe(true);
    expect(within(dialog).getAllByRole("option").find((o) => o.textContent?.startsWith("SMTP_HOST"))).toHaveAttribute("aria-disabled", "true");
    await user.type(pass, "senha");
    await user.click(within(dialog).getByRole("option", { name: /SMTP_SENHA/ }));
    // nome novo digitado
    const from = within(dialog).getByRole("combobox", { name: "Variável que recebe MAIL_FROM" });
    await user.click(from);
    await user.type(from, "REMETENTE");
    await user.click(within(dialog).getByRole("option", { name: /Usar o nome novo REMETENTE/ }));
    await user.click(within(dialog).getByRole("button", { name: /Salvar ligações/ }));
    await waitFor(() =>
      expect(bodyOf("/api/projects/p1/email/links", "PUT")).toEqual({ links: { SMTP_SENHA: "SMTP_PASS", REMETENTE: "MAIL_FROM" } }),
    );
    // fecha e o card mostra as ligações
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByTestId("email-links")).toHaveTextContent("SMTP_SENHA ← SMTP_PASS");
  });

  it("nome inválido ou repetido: avisa na linha e não salva", async () => {
    serve(ON, { envList: ENV_LIST });
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: /Ligar às variáveis do projeto/ }));
    const dialog = await screen.findByRole("dialog");
    const host = within(dialog).getByRole("combobox", { name: "Variável que recebe SMTP_HOST" });
    await user.click(host);
    await user.type(host, "COMPOSE_FILE");
    await user.click(within(dialog).getByRole("option", { name: /Usar o nome novo COMPOSE_FILE/ }));
    expect(within(dialog).getByText(/nome reservado/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Salvar ligações/ })).toBeDisabled();
    await user.click(host);
    await user.click(within(dialog).getByRole("option", { name: /EMAIL_DE/ }));
    const user2 = within(dialog).getByRole("combobox", { name: "Variável que recebe SMTP_USER" });
    await user.click(user2);
    await user.click(within(dialog).getByRole("option", { name: /EMAIL_DE/ }));
    expect(within(dialog).getAllByText(/escolhida em mais de uma linha/).length).toBeGreaterThan(0);
    expect(within(dialog).getByRole("button", { name: /Salvar ligações/ })).toBeDisabled();
  });

  it("variável já salva em Variáveis: avisa que, com a ligação, o valor de lá é ignorado", async () => {
    serve(ON, { envList: { ...ENV_LIST, vars: [{ key: "EMAIL_DE", value: "x@y.com" }] } });
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: /Ligar às variáveis do projeto/ }));
    const dialog = await screen.findByRole("dialog");
    const from = within(dialog).getByRole("combobox", { name: "Variável que recebe MAIL_FROM" });
    await user.click(from);
    await user.click(within(dialog).getByRole("option", { name: /EMAIL_DE/ }));
    expect(within(dialog).getByText(/EMAIL_DE também está salva em Variáveis: com a ligação, o deploy usa o valor do e-mail e ignora o de lá/)).toBeInTheDocument();
  });

  it("abre com as ligações salvas; Esc fecha", async () => {
    serve({ ...ON, envLinks: { SMTP_SENHA: "SMTP_PASS" } }, { envList: ENV_LIST });
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: /Ligar às variáveis do projeto/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("combobox", { name: "Variável que recebe SMTP_PASS" })).toHaveValue("SMTP_SENHA");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("falha ao carregar as variáveis: ainda dá para digitar nomes", async () => {
    serve(ON);
    const base = apiFetchMock.getMockImplementation()!;
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/projects/p1/env") throw new ApiRequestError(500, "x", "Falhou");
      return base(path, init);
    });
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: /Ligar às variáveis do projeto/ }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/Não foi possível carregar as variáveis do projeto/)).toBeInTheDocument();
  });
});

/**
 * Validação real (02/10/2026): o card só deixava escolher domínios já
 * cadastrados na página E-mail. O dono quer configurar ali mesmo o e-mail do
 * domínio do projeto (ex.: contato@meudominio.com.br) — e o campo já vem
 * preenchido com o domínio do projeto (editável).
 */
describe("ProjectEmailCard — cadastrar o domínio do próprio projeto", () => {
  function serveWithAdd(opts: { receivesMail?: boolean } = {}) {
    const domains: MailDomainSummary[] = [domain("envio.exemplo.com.br", 6)];
    const posts: unknown[] = [];
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (path === "/api/mail/domains" && method === "GET") return { domains: [...domains] };
      if (path === "/api/mail/domains" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { domain: string; confirmExistingMail?: boolean };
        posts.push(body);
        if (opts.receivesMail && body.domain === "loja.example.com" && !body.confirmExistingMail) {
          throw new ApiRequestError(409, "domain_receives_mail", "Este domínio já recebe e-mail.", {
            existingMail: { status: "elsewhere", servers: ["mx.provedor.com"], suggestedDomain: "envio.loja.example.com" },
          });
        }
        domains.push({ ...domain(body.domain, 0), lastVerify: null });
        return { domain: domains.at(-1) };
      }
      if (path.endsWith("/verify") && method === "POST") {
        const name = decodeURIComponent(path.split("/")[4]!);
        const d = domains.find((x) => x.name === name)!;
        d.lastVerify = { at: "2026-10-02T13:00:00.000Z", ok: 6, total: 6 };
        return { domain: name, records: [], ptr: {}, summary: { ok: 6, total: 6 }, verifiedAt: d.lastVerify.at, suggestion: null };
      }
      if (path === "/api/projects/p1/email") return { email: OFF };
      throw new Error(`rota inesperada: ${method} ${path}`);
    });
    return posts;
  }

  it("'Usar um domínio meu': vem preenchido, cadastra, seleciona e mostra o próximo passo", async () => {
    const posts = serveWithAdd();
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: /Usar um domínio meu/ }));
    const input = screen.getByLabelText("Seu domínio");
    expect(input).toHaveValue("loja.example.com");
    await user.click(screen.getByRole("button", { name: /Cadastrar domínio/ }));
    await waitFor(() => expect(posts).toEqual([{ domain: "loja.example.com" }]));
    expect(await screen.findByLabelText("Domínio de e-mail")).toHaveValue("loja.example.com");
    expect(screen.getByRole("link", { name: /Ver os registros DNS/ })).toHaveAttribute("href", "/mail/loja.example.com?aba=dns");
    await user.click(screen.getByRole("button", { name: /Verificar agora/ }));
    expect(await screen.findByRole("option", { name: /loja\.example\.com — DNS 6\/6 OK/ })).toBeInTheDocument();
  });

  it("o campo é editável: outro domínio vai no cadastro", async () => {
    const posts = serveWithAdd();
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: /Usar um domínio meu/ }));
    const input = screen.getByLabelText("Seu domínio");
    await user.clear(input);
    await user.type(input, "envio.loja.example.com");
    await user.click(screen.getByRole("button", { name: /Cadastrar domínio/ }));
    await waitFor(() => expect(posts).toEqual([{ domain: "envio.loja.example.com" }]));
  });

  it("domínio que já recebe e-mail em outro lugar: avisa e oferece o subdomínio de envio", async () => {
    const posts = serveWithAdd({ receivesMail: true });
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: /Usar um domínio meu/ }));
    await user.click(screen.getByRole("button", { name: /Cadastrar domínio/ }));
    expect(await screen.findByText(/já recebe e-mail em outro servidor/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Usar envio\.loja\.example\.com/ }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ domain: "envio.loja.example.com" }));
    expect(await screen.findByLabelText("Domínio de e-mail")).toHaveValue("envio.loja.example.com");
  });

  it("sem nenhum domínio: o cadastro aparece direto", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/mail/domains") return { domains: [] };
      if (path === "/api/projects/p1/email") return { email: OFF };
      throw new Error(path);
    });
    renderCard();
    expect(await screen.findByLabelText("Seu domínio")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Pedido do dono do produto (03/10/2026): na seção E-mail do projeto, além do
// remetente, as caixas e o DNS do domínio do projeto — para conferir,
// configurar e criar caixas (ex.: suporte@) sem sair do projeto.
// ---------------------------------------------------------------------------

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <ProjectEmailCard projectId="p1" projectName="Loja Royal" projectSlug="loja" projectDomain="loja.example.com" />
      <Where />
    </MemoryRouter>,
  );
}

const PROJECT_BOX: Mailbox = {
  id: "contato@envio.exemplo.com.br",
  localPart: "contato",
  domain: "envio.exemplo.com.br",
  kind: "project",
  createdAt: "2026-10-01T12:00:00.000Z",
};

describe("ProjectEmailCard — abas Remetente, Caixas e DNS", () => {
  it("ativado: três abas, abre em Remetente com o conteúdo de sempre", async () => {
    serve(ON);
    renderAt("/projects/p1/email");
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Remetente", "Caixas", "DNS"]);
    expect(screen.getByRole("tab", { name: "Remetente" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Contato - Loja <contato@envio.exemplo.com.br>")).toBeInTheDocument();
    // as outras abas só carregam quando abertas
    expect(apiFetchMock.mock.calls.some(([p]) => String(p).endsWith("/mailboxes"))).toBe(false);
    expect(apiFetchMock.mock.calls.some(([p]) => String(p).endsWith("/verify"))).toBe(false);
  });

  it("aba Caixas: lista só as caixas do projeto, destaca a de envio e põe ?email=caixas no endereço", async () => {
    // o servidor filtra (?projectId=p1): o postmaster@ do domínio não vem
    serve(ON, { mailboxes: [PROJECT_BOX, { ...PROJECT_BOX, id: "suporte@envio.exemplo.com.br", localPart: "suporte", kind: "user" }] });
    const user = userEvent.setup();
    renderAt("/projects/p1/email");
    await user.click(await screen.findByRole("tab", { name: "Caixas" }));
    expect(screen.getByRole("tab", { name: "Caixas" })).toHaveAttribute("aria-selected", "true");
    const row = (await screen.findByText("contato@envio.exemplo.com.br", { selector: "p" })).closest(
      "[data-mailbox]",
    ) as HTMLElement;
    expect(row).toHaveAttribute("data-highlight", "true");
    expect(within(row).getByText("deste projeto")).toBeInTheDocument();
    expect(screen.getByText("suporte@envio.exemplo.com.br")).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith("/api/mail/domains/envio.exemplo.com.br/mailboxes?projectId=p1", undefined);
    // dá para criar outra caixa no mesmo domínio
    expect(screen.getByRole("button", { name: /Criar caixa/ })).toBeInTheDocument();
    expect(screen.getByText("@envio.exemplo.com.br")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/projects/p1/email?email=caixas");
    // o conteúdo do Remetente sai da tela
    expect(screen.queryByText("Contato - Loja <contato@envio.exemplo.com.br>")).not.toBeInTheDocument();
  });

  it("aba DNS: checklist do domínio, conferido ao abrir, e ?email=dns no endereço", async () => {
    serve(ON);
    const user = userEvent.setup();
    renderAt("/projects/p1/email");
    await user.click(await screen.findByRole("tab", { name: "DNS" }));
    expect(await screen.findByText("1/2 OK")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText(/Reverse DNS \(PTR\)/)).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/projects/p1/email?email=dns");
    // volta ao Remetente: o endereço perde o ?email
    await user.click(screen.getByRole("tab", { name: "Remetente" }));
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/projects\/p1\/email$/);
  });

  it("endereço com ?email=dns ou ?email=caixas abre direto na aba", async () => {
    serve(ON);
    renderAt("/projects/p1/email?email=dns");
    expect(await screen.findByRole("tab", { name: "DNS" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("table")).toBeInTheDocument();
    cleanup();
    serve(ON, { mailboxes: [PROJECT_BOX] });
    renderAt("/projects/p1/email?email=caixas");
    expect(await screen.findByRole("tab", { name: "Caixas" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("Caixas de e-mail")).toBeInTheDocument();
  });

  it("link discreto 'Abrir na página E-mail' leva ao domínio (no DNS, já na aba do checklist)", async () => {
    serve(ON);
    const user = userEvent.setup();
    renderAt("/projects/p1/email");
    expect(await screen.findByRole("link", { name: /Abrir na página E-mail/ })).toHaveAttribute(
      "href",
      "/mail/envio.exemplo.com.br",
    );
    await user.click(screen.getByRole("tab", { name: "DNS" }));
    expect(screen.getByRole("link", { name: /Abrir na página E-mail/ })).toHaveAttribute(
      "href",
      "/mail/envio.exemplo.com.br?aba=dns",
    );
  });

  it("desativado: sem abas, só o formulário de ativação (mesmo com ?email=dns)", async () => {
    serve(OFF);
    renderAt("/projects/p1/email?email=dns");
    expect(await screen.findByRole("button", { name: /Ativar e-mail/ })).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Abrir na página E-mail/ })).not.toBeInTheDocument();
  });
});

/**
 * Usar uma caixa que já existe (a da TWS configurada no webmail, por exemplo):
 * nada é apagado; a pessoa informa a senha atual ou troca por uma gerada.
 */
describe("ProjectEmailCard — usar uma caixa que já existe", () => {
  const CONTATO: ProjectEmailUsableMailbox = { address: "contato@envio.exemplo.com.br", localPart: "contato", kind: "user", passwordKnown: false };
  const GUARDADA: ProjectEmailUsableMailbox = { address: "solta@envio.exemplo.com.br", localPart: "solta", kind: "project", passwordKnown: true };
  const ATUAL = "senha-atual-da-caixa-1";

  async function openExisting(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByLabelText("Endereço de envio");
    await user.click(screen.getByLabelText("Usar uma caixa que já existe"));
  }

  it("a opção aparece ao ativar; escolher a caixa mostra os caminhos e o aviso de que o painel passa a gerenciá-la", async () => {
    serve(OFF, { usable: [CONTATO, GUARDADA] });
    const user = userEvent.setup();
    renderCard();
    await openExisting(user);
    const select = await screen.findByLabelText("Caixa existente");
    await waitFor(() => expect(select).not.toBeDisabled());
    expect(apiFetchMock).toHaveBeenCalledWith("/api/projects/p1/email/mailboxes?domain=envio.exemplo.com.br", undefined);
    // o fluxo de caixa nova some (sem senha dupla nem endereço)
    expect(screen.queryByLabelText("Endereço de envio")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Repita a senha")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Usar esta caixa" })).toBeDisabled();
    await user.selectOptions(select, CONTATO.address);
    expect(screen.getByLabelText("Informar a senha atual da caixa")).toBeChecked();
    expect(screen.getByLabelText("Trocar a senha desta caixa por uma gerada pelo painel")).toBeInTheDocument();
    // o painel não sabe a senha dela: sem "manter"
    expect(screen.queryByLabelText("Manter a senha que o painel já guarda")).not.toBeInTheDocument();
    expect(screen.getByText(/Não troque a senha dela direto no webmail/)).toBeInTheDocument();
    expect(screen.getByText(/Desativar o e-mail do projeto solta uma caixa que já existia/)).toBeInTheDocument();
    expect(screen.getByLabelText("Senha atual da caixa")).toHaveAttribute("type", "password");
  });

  it("senha atual: só habilita com 12+ caracteres e manda a caixa escolhida, o modo e a senha", async () => {
    serve(OFF, { usable: [CONTATO], passwordVerified: true });
    const user = userEvent.setup();
    renderCard();
    await openExisting(user);
    await waitFor(() => expect(screen.getByLabelText("Caixa existente")).not.toBeDisabled());
    await user.selectOptions(screen.getByLabelText("Caixa existente"), CONTATO.address);
    const submit = screen.getByRole("button", { name: "Usar esta caixa" });
    await user.type(screen.getByLabelText("Senha atual da caixa"), "curta");
    expect(submit).toBeDisabled();
    await user.clear(screen.getByLabelText("Senha atual da caixa"));
    await user.type(screen.getByLabelText("Senha atual da caixa"), ATUAL);
    await user.type(screen.getByLabelText("Nome de exibição (opcional)"), "Contato TWS");
    await user.click(submit);
    await waitFor(() =>
      expect(bodyOf("/api/projects/p1/email", "POST")).toEqual({
        domain: "envio.exemplo.com.br",
        fromLocalPart: "contato",
        useExistingMailbox: "current_password",
        fromName: "Contato TWS",
        password: ATUAL,
      }),
    );
    expect(await screen.findByText("Caixa do projeto: contato@envio.exemplo.com.br. O projeto entra no servidor de e-mail com ela.")).toBeInTheDocument();
    expect(screen.queryByTestId("password-unverified")).not.toBeInTheDocument();
    expect(screen.queryByText(ATUAL)).not.toBeInTheDocument();
  });

  it("projeto já ativado trocando para uma caixa existente: o nome que o formulário traz preenchido não conta como digitado", async () => {
    serve(ON, { usable: [CONTATO], passwordVerified: true });
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: /Alterar remetente/ }));
    expect(screen.getByLabelText("Nome de exibição (opcional)")).toHaveValue("Contato - Loja");
    await user.click(screen.getByLabelText("Usar uma caixa que já existe"));
    await waitFor(() => expect(screen.getByLabelText("Caixa existente")).not.toBeDisabled());
    await user.selectOptions(screen.getByLabelText("Caixa existente"), CONTATO.address);
    await user.type(screen.getByLabelText("Senha atual da caixa"), ATUAL);
    await user.click(screen.getByRole("button", { name: "Usar esta caixa" }));
    await waitFor(() => expect(bodyOf("/api/projects/p1/email", "POST")).toBeTruthy());
    expect(bodyOf("/api/projects/p1/email", "POST")).not.toHaveProperty("fromName");
  });

  it("senha aceita sem conferência: avisa", async () => {
    serve(OFF, { usable: [CONTATO], passwordVerified: false });
    const user = userEvent.setup();
    renderCard();
    await openExisting(user);
    await waitFor(() => expect(screen.getByLabelText("Caixa existente")).not.toBeDisabled());
    await user.selectOptions(screen.getByLabelText("Caixa existente"), CONTATO.address);
    await user.type(screen.getByLabelText("Senha atual da caixa"), ATUAL);
    await user.click(screen.getByRole("button", { name: "Usar esta caixa" }));
    expect(await screen.findByTestId("password-unverified")).toHaveTextContent(/não deixou conferi-la.*Sincronizar vai gravá-la/);
  });

  it("trocar a senha: avisa que apps e webmail precisam ser atualizados, não pede senha e mostra a gerada uma vez", async () => {
    serve(OFF, { usable: [CONTATO], generated: GERADA });
    const user = userEvent.setup();
    renderCard();
    await openExisting(user);
    await waitFor(() => expect(screen.getByLabelText("Caixa existente")).not.toBeDisabled());
    await user.selectOptions(screen.getByLabelText("Caixa existente"), CONTATO.address);
    await user.click(screen.getByLabelText("Trocar a senha desta caixa por uma gerada pelo painel"));
    expect(screen.getByTestId("replace-warning")).toHaveTextContent(/precisam ser atualizados.*senhas de app e a verificação em duas etapas/);
    expect(screen.queryByLabelText("Senha atual da caixa")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Usar esta caixa" }));
    await waitFor(() =>
      expect(bodyOf("/api/projects/p1/email", "POST")).toEqual({
        domain: "envio.exemplo.com.br",
        fromLocalPart: "contato",
        useExistingMailbox: "replace_password",
      }),
    );
    expect(await screen.findByTestId("generated-password")).toHaveTextContent(GERADA);
  });

  it("caixa de que o painel sabe a senha: oferece manter e já vem marcado", async () => {
    serve(OFF, { usable: [GUARDADA] });
    const user = userEvent.setup();
    renderCard();
    await openExisting(user);
    await waitFor(() => expect(screen.getByLabelText("Caixa existente")).not.toBeDisabled());
    await user.selectOptions(screen.getByLabelText("Caixa existente"), GUARDADA.address);
    expect(screen.getByLabelText("Manter a senha que o painel já guarda")).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Usar esta caixa" }));
    await waitFor(() =>
      expect(bodyOf("/api/projects/p1/email", "POST")).toEqual({
        domain: "envio.exemplo.com.br",
        fromLocalPart: "solta",
        useExistingMailbox: "keep_password",
      }),
    );
  });

  it("domínio sem caixas usáveis: explica e não deixa enviar", async () => {
    serve(OFF, { usable: [] });
    const user = userEvent.setup();
    renderCard();
    await openExisting(user);
    expect(await screen.findByTestId("existing-empty")).toHaveTextContent(/não tem nenhuma caixa que o projeto possa usar/);
    expect(screen.getByLabelText("Caixa existente")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Usar esta caixa" })).toBeDisabled();
  });

  it("falha ao listar: mostra o erro (role=alert)", async () => {
    serve(OFF, { usableError: true });
    const user = userEvent.setup();
    renderCard();
    await openExisting(user);
    expect(await screen.findByRole("alert")).toHaveTextContent("Falha do servidor");
  });

  it("senha errada ou caixa em uso por outro projeto: a mensagem do servidor aparece (role=alert) e nada muda", async () => {
    const scrollMock = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { value: scrollMock, configurable: true, writable: true });
    serve(OFF, {
      usable: [CONTATO],
      connectError: new ApiRequestError(409, "mailbox_taken_by_project", "A caixa contato@envio.exemplo.com.br já é usada pelo projeto Outra."),
    });
    const user = userEvent.setup();
    renderCard();
    await openExisting(user);
    await waitFor(() => expect(screen.getByLabelText("Caixa existente")).not.toBeDisabled());
    await user.selectOptions(screen.getByLabelText("Caixa existente"), CONTATO.address);
    await user.type(screen.getByLabelText("Senha atual da caixa"), ATUAL);
    await user.click(screen.getByRole("button", { name: "Usar esta caixa" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("já é usada pelo projeto Outra");
    // e entra na tela (o botão fica longe do topo do cartão)
    expect(scrollMock).toHaveBeenCalledWith({ block: "center" });
    expect(scrollMock.mock.contexts.at(-1)).toBe(alert);
    // o foco vai para o erro (o botão fica longe do topo do cartão)
    expect(alert).toHaveFocus();
    expect(screen.getByRole("button", { name: "Usar esta caixa" })).toBeInTheDocument();
  });

  it("voltar para 'Criar uma caixa nova' traz o fluxo de sempre", async () => {
    serve(OFF, { usable: [CONTATO] });
    const user = userEvent.setup();
    renderCard();
    await openExisting(user);
    await user.click(screen.getByLabelText("Criar uma caixa nova"));
    expect(await screen.findByLabelText("Endereço de envio")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ativar e-mail/ })).toBeInTheDocument();
  });

  it("em inglês: textos, aviso e erro traduzidos", async () => {
    setLocale("en", { persist: false });
    serve(OFF, { usable: [CONTATO], connectError: new ApiRequestError(400, "mailbox_password_mismatch", "A senha informada não é a da caixa x.") });
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByLabelText("Use a mailbox that already exists"));
    await waitFor(() => expect(screen.getByLabelText("Existing mailbox")).not.toBeDisabled());
    await user.selectOptions(screen.getByLabelText("Existing mailbox"), CONTATO.address);
    expect(screen.getByLabelText("Enter the mailbox's current password")).toBeChecked();
    await user.click(screen.getByLabelText("Replace this mailbox's password with one generated by the panel"));
    expect(screen.getByTestId("replace-warning")).toHaveTextContent(/must be updated/);
    await user.click(screen.getByLabelText("Enter the mailbox's current password"));
    await user.type(screen.getByLabelText("Mailbox's current password"), ATUAL);
    await user.click(screen.getByRole("button", { name: "Use this mailbox" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The password entered is not this mailbox's password.");
  });
});

describe("ProjectEmailCard — nome de exibição (campo único das caixas)", () => {
  it("nome com < > ou aspas: mostra o erro, marca o campo e não deixa ativar", async () => {
    serve(OFF);
    const user = userEvent.setup();
    renderCard();
    const field = await screen.findByLabelText("Nome de exibição (opcional)");
    await user.type(await screen.findByLabelText("Senha da caixa"), SENHA);
    await user.type(screen.getByLabelText("Repita a senha"), SENHA);
    await user.type(field, "Loja <x@exemplo.com>");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/Sem quebra de linha, caracteres de controle/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ativar e-mail/ })).toBeDisabled();
    await user.clear(field);
    expect(field).not.toHaveAttribute("aria-invalid");
    expect(screen.getByRole("button", { name: /Ativar e-mail/ })).toBeEnabled();
  });

  it("a dica diz que, em branco, vale o nome do projeto", async () => {
    serve(OFF);
    renderCard();
    await screen.findByLabelText("Nome de exibição (opcional)");
    expect(screen.getAllByText(/Em branco, o painel usa o nome do projeto/).length).toBeGreaterThan(0);
  });

  it("ativado: diz de onde vem o From que o app usa (MAIL_FROM_NAME + MAIL_FROM) e que a mudança vale no próximo deploy", async () => {
    serve(ON);
    renderCard();
    const note = await screen.findByTestId("from-source");
    expect(note).toHaveTextContent(/MAIL_FROM_NAME e MAIL_FROM/);
    expect(note).toHaveTextContent(/próximo deploy/);
    expect(note).toHaveTextContent("contato@envio.exemplo.com.br");
  });
});

describe("ProjectEmailCard — prévia usa a mesma limpeza do servidor", () => {
  it("nome do projeto com < > e quebra de linha: a prévia e o exemplo mostram a versão limpa", async () => {
    serve(OFF);
    render(
      <MemoryRouter>
        <ProjectEmailCard projectId="p1" projectName={"Loja <b>\u200b Royal"} projectSlug="loja" projectDomain="loja.example.com" />
      </MemoryRouter>,
    );
    const field = await screen.findByLabelText("Nome de exibição (opcional)");
    expect(field).toHaveAttribute("placeholder", "Loja b Royal");
    expect(screen.getByText(/Loja b Royal <loja@envio\.exemplo\.com\.br>/)).toBeInTheDocument();
  });
});
