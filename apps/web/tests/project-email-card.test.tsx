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
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailDomainSummary, ProjectEmailConfig } from "@paas/core";

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
  fromName: "Contato - Cassino",
  env: {
    SMTP_HOST: "mail.envio.exemplo.com.br",
    SMTP_PORT: "587",
    SMTP_USER: "contato@envio.exemplo.com.br",
    SMTP_PASS: "••••••••••••",
    MAIL_FROM: "contato@envio.exemplo.com.br",
    MAIL_FROM_NAME: "Contato - Cassino",
  },
  envLinks: {},
  legacyAlias: false,
};
/** Gravado antes da mudança: endereço de envio como alias da caixa técnica. */
const LEGACY: ProjectEmailConfig = {
  ...ON,
  mailbox: "cassino@envio.exemplo.com.br",
  env: { ...ON.env, SMTP_USER: "cassino@envio.exemplo.com.br" },
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
}

function serve(email: ProjectEmailConfig, opts: ServeOpts = {}) {
  let current = email;
  const domains = opts.domains ?? [domain("envio.exemplo.com.br", 6)];
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path === "/api/mail/domains") return { domains };
    if (path === "/api/projects/p1/email" && method === "GET") return { email: current };
    if (path === "/api/projects/p1/email" && method === "POST") {
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
      <ProjectEmailCard projectId="p1" projectName="Cassino Royal" projectSlug="cassino" projectDomain="cassino.com.br" />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
});
afterEach(() => cleanup());

describe("ProjectEmailCard — ativar", () => {
  it("escolhe domínio, endereço, nome e digita a senha duas vezes; manda tudo ao ativar", async () => {
    serve(OFF);
    const user = userEvent.setup();
    renderCard();
    const local = await screen.findByLabelText("Endereço de envio");
    expect(local).toHaveAttribute("placeholder", "cassino");
    expect(screen.getByLabelText("Nome de exibição")).toHaveAttribute("placeholder", "Cassino Royal");
    await user.type(local, "contato");
    await user.type(screen.getByLabelText("Nome de exibição"), "Contato - Cassino");
    expect(screen.getByText(/Contato - Cassino <contato@envio\.exemplo\.com\.br>/)).toBeInTheDocument();
    // a caixa é o próprio endereço: dá para abrir num app de e-mail
    expect(screen.getByTestId("mailbox-explain")).toHaveTextContent(/contato@envio\.exemplo\.com\.br/);
    const pass = screen.getByLabelText("Senha da caixa");
    expect(pass).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Repita a senha")).toHaveAttribute("type", "password");
    await user.type(pass, SENHA);
    await user.type(screen.getByLabelText("Repita a senha"), SENHA);
    await user.click(screen.getByRole("button", { name: /Ativar e-mail/ }));
    await waitFor(() =>
      expect(bodyOf("/api/projects/p1/email", "POST")).toEqual({
        domain: "envio.exemplo.com.br",
        fromLocalPart: "contato",
        fromName: "Contato - Cassino",
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
    expect(screen.getByLabelText("Seu domínio")).toHaveValue("cassino.com.br");
  });
});

describe("ProjectEmailCard — ativado", () => {
  it("mostra o remetente, a caixa, as variáveis com copiar (menos a senha) e lembra do novo deploy", async () => {
    serve(ON);
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderCard();
    expect(await screen.findByText("Contato - Cassino <contato@envio.exemplo.com.br>")).toBeInTheDocument();
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
    expect(screen.getByLabelText("Nome de exibição")).toHaveValue("Contato - Cassino");
    expect(screen.queryByLabelText("Senha da caixa")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Salvar$/ }));
    await waitFor(() =>
      expect(bodyOf("/api/projects/p1/email", "POST")).toEqual({
        domain: "envio.exemplo.com.br",
        fromLocalPart: "contato",
        fromName: "Contato - Cassino",
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

  it("variável já preenchida em Variáveis: avisa que o valor de lá vence", async () => {
    serve(ON, { envList: { ...ENV_LIST, vars: [{ key: "EMAIL_DE", value: "x@y.com" }] } });
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: /Ligar às variáveis do projeto/ }));
    const dialog = await screen.findByRole("dialog");
    const from = within(dialog).getByRole("combobox", { name: "Variável que recebe MAIL_FROM" });
    await user.click(from);
    await user.click(within(dialog).getByRole("option", { name: /EMAIL_DE/ }));
    expect(within(dialog).getByText(/EMAIL_DE já tem valor em Variáveis/)).toBeInTheDocument();
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
        if (opts.receivesMail && body.domain === "cassino.com.br" && !body.confirmExistingMail) {
          throw new ApiRequestError(409, "domain_receives_mail", "Este domínio já recebe e-mail.", {
            existingMail: { status: "elsewhere", servers: ["mx.provedor.com"], suggestedDomain: "envio.cassino.com.br" },
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
    expect(input).toHaveValue("cassino.com.br");
    await user.click(screen.getByRole("button", { name: /Cadastrar domínio/ }));
    await waitFor(() => expect(posts).toEqual([{ domain: "cassino.com.br" }]));
    expect(await screen.findByLabelText("Domínio de e-mail")).toHaveValue("cassino.com.br");
    expect(screen.getByRole("link", { name: /Ver os registros DNS/ })).toHaveAttribute("href", "/mail/cassino.com.br?aba=dns");
    await user.click(screen.getByRole("button", { name: /Verificar agora/ }));
    expect(await screen.findByRole("option", { name: /cassino\.com\.br — DNS 6\/6 OK/ })).toBeInTheDocument();
  });

  it("o campo é editável: outro domínio vai no cadastro", async () => {
    const posts = serveWithAdd();
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: /Usar um domínio meu/ }));
    const input = screen.getByLabelText("Seu domínio");
    await user.clear(input);
    await user.type(input, "envio.cassino.com.br");
    await user.click(screen.getByRole("button", { name: /Cadastrar domínio/ }));
    await waitFor(() => expect(posts).toEqual([{ domain: "envio.cassino.com.br" }]));
  });

  it("domínio que já recebe e-mail em outro lugar: avisa e oferece o subdomínio de envio", async () => {
    const posts = serveWithAdd({ receivesMail: true });
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByRole("button", { name: /Usar um domínio meu/ }));
    await user.click(screen.getByRole("button", { name: /Cadastrar domínio/ }));
    expect(await screen.findByText(/já recebe e-mail em outro servidor/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Usar envio\.cassino\.com\.br/ }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ domain: "envio.cassino.com.br" }));
    expect(await screen.findByLabelText("Domínio de e-mail")).toHaveValue("envio.cassino.com.br");
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
