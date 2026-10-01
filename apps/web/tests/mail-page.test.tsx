/**
 * Página E-mail — certificado do servidor de e-mail e aviso de MX existente.
 *
 * Validação real (01/10/2026):
 *  - o app do projeto recusaria o certificado autoassinado do Stalwart; agora
 *    o painel instala o certificado de mail.<domínio> e a página mostra se
 *    ele está válido (emissor e validade) ou o que falta (geralmente o
 *    registro A com a nuvem CINZA na Cloudflare);
 *  - o dono do produto ia cadastrar o domínio principal da empresa, que
 *    recebe e-mail em outro provedor: o aviso precisa ser impossível de
 *    ignorar, recomendar um subdomínio e exigir confirmação explícita.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailServerStatus, MailTlsStatusResponse } from "@paas/core";
import { MailPage } from "../src/pages/MailPage";

const STATUS: MailServerStatus = {
  installed: true,
  running: true,
  version: "0.11.8",
  image: "stalwartlabs/mail-server:v0.11.8",
  containerName: "paas-stalwart",
  hostname: "mail.exemplo.com.br",
  ports: { smtp: 25, submission: 587, submissions: 465, imap: 143, imaps: 993, http: 8080 },
  message: null,
};

const DOMAIN = {
  name: "exemplo.com.br",
  dkimSelector: "paas",
  dkimPublicKey: "abc",
  dkimKeyBits: 2048,
  dmarcStage: "none",
  createdAt: new Date(0).toISOString(),
  mailboxCount: 1,
  lastVerify: null,
};

const TLS_PENDING: MailTlsStatusResponse = {
  checkedAt: new Date().toISOString(),
  serverRunning: true,
  syncError: null,
  hosts: [
    {
      host: "mail.exemplo.com.br",
      ok: false,
      issuer: null,
      validTo: null,
      error: "self-signed certificate",
      issued: false,
      dns: { status: "missing", resolved: [], expectedIp: "203.0.113.10" },
      hint: "Falta o registro A de mail.exemplo.com.br apontando para 203.0.113.10. Na Cloudflare, deixe a nuvem CINZA.",
    },
  ],
};

const TLS_OK: MailTlsStatusResponse = {
  ...TLS_PENDING,
  hosts: [
    {
      host: "mail.exemplo.com.br",
      ok: true,
      issuer: "Let's Encrypt",
      validTo: "2026-12-30T12:00:00.000Z",
      error: null,
      issued: true,
      dns: { status: "ok", resolved: ["203.0.113.10"], expectedIp: "203.0.113.10" },
      hint: null,
    },
  ],
};

type Handler = (url: string, init?: RequestInit) => { status: number; body: unknown } | undefined;

function mockApi(opts: { tls?: MailTlsStatusResponse | (() => MailTlsStatusResponse); domains?: unknown[]; extra?: Handler } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const custom = opts.extra?.(url, init);
    const reply = custom ?? (url.endsWith("/api/mail/status")
      ? { status: 200, body: STATUS }
      : url.endsWith("/api/mail/domains") && (!init?.method || init.method === "GET")
        ? { status: 200, body: { domains: opts.domains ?? [DOMAIN] } }
        : url.endsWith("/api/mail/tls")
          ? { status: 200, body: typeof opts.tls === "function" ? opts.tls() : (opts.tls ?? TLS_PENDING) }
          : { status: 404, body: { error: "not_found", message: "?" } });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage() {
  render(
    <MemoryRouter>
      <MailPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MailPage — certificado do servidor de e-mail", () => {
  it("pendente: mostra o host, o selo 'pendente' e o que falta", async () => {
    mockApi();
    renderPage();
    expect(await screen.findByText("Certificado do servidor de e-mail")).toBeInTheDocument();
    expect(await screen.findByText(/Falta o registro A de mail\.exemplo\.com\.br/)).toBeInTheDocument();
    expect(screen.getByText("pendente")).toBeInTheDocument();
    expect(screen.getByText(/self-signed certificate/)).toBeInTheDocument();
  });

  it("válido: emissor e data de validade", async () => {
    mockApi({ tls: TLS_OK });
    renderPage();
    expect(await screen.findByText("válido")).toBeInTheDocument();
    expect(screen.getByText(/Let's Encrypt/)).toBeInTheDocument();
    expect(screen.getByText(/30\/12\/2026/)).toBeInTheDocument();
  });

  it("'Conferir de novo' consulta outra vez", async () => {
    let calls = 0;
    mockApi({
      tls: () => {
        calls += 1;
        return calls === 1 ? TLS_PENDING : TLS_OK;
      },
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("pendente");
    await user.click(screen.getByRole("button", { name: /conferir de novo/i }));
    expect(await screen.findByText("válido")).toBeInTheDocument();
  });

  it("falha ao instalar o certificado aparece na tela", async () => {
    mockApi({ tls: { ...TLS_PENDING, syncError: "docker fora do ar" } });
    renderPage();
    expect(await screen.findByText(/docker fora do ar/)).toBeInTheDocument();
  });

  it("sem domínio cadastrado: o card não aparece", async () => {
    mockApi({ domains: [] });
    renderPage();
    await screen.findByText(/Configure seu primeiro domínio/);
    expect(screen.queryByText("Certificado do servidor de e-mail")).not.toBeInTheDocument();
  });
});

describe("MailPage — domínio que já recebe e-mail em outro servidor", () => {
  const CONFLICT = {
    status: 409,
    body: {
      error: "domain_receives_mail",
      message: "O domínio empresa.com.br já recebe e-mail em aspmx.l.google.com.",
      existingMail: { status: "elsewhere", servers: ["aspmx.l.google.com", "alt1.aspmx.l.google.com"], suggestedDomain: "envio.empresa.com.br" },
    },
  };

  function posts(fetchMock: ReturnType<typeof mockApi>) {
    return fetchMock.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
  }

  it("aviso forte com o servidor atual, recomendação de subdomínio e confirmação explícita", async () => {
    const fetchMock = mockApi({
      extra: (url, init) => {
        if (!url.endsWith("/api/mail/domains") || init?.method !== "POST") return undefined;
        const body = JSON.parse(String(init.body)) as { confirmExistingMail?: boolean };
        return body.confirmExistingMail ? { status: 201, body: { domain: DOMAIN } } : CONFLICT;
      },
    });
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByPlaceholderText("exemplo.com"), "empresa.com.br");
    await user.click(screen.getByRole("button", { name: /adicionar domínio/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Este domínio já recebe e-mail em outro servidor");
    expect(alert).toHaveTextContent(
      "apontar o MX para esta VPS desviaria todo o e-mail que hoje chega em aspmx.l.google.com",
    );
    expect(alert).toHaveTextContent("alt1.aspmx.l.google.com");
    expect(alert).toHaveTextContent("envio.empresa.com.br");

    // seguir exige marcar a confirmação
    const seguir = screen.getByRole("button", { name: /seguir com empresa\.com\.br mesmo assim/i });
    expect(seguir).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    expect(seguir).toBeEnabled();
    await user.click(seguir);

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(posts(fetchMock)).toEqual([
      { domain: "empresa.com.br" },
      { domain: "empresa.com.br", confirmExistingMail: true },
    ]);
  });

  it("'Usar o subdomínio' cadastra o subdomínio sugerido", async () => {
    const fetchMock = mockApi({
      extra: (url, init) => {
        if (!url.endsWith("/api/mail/domains") || init?.method !== "POST") return undefined;
        const body = JSON.parse(String(init.body)) as { domain: string };
        return body.domain === "envio.empresa.com.br" ? { status: 201, body: { domain: DOMAIN } } : CONFLICT;
      },
    });
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByPlaceholderText("exemplo.com"), "empresa.com.br");
    await user.click(screen.getByRole("button", { name: /adicionar domínio/i }));
    await user.click(await screen.findByRole("button", { name: /usar envio\.empresa\.com\.br/i }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(posts(fetchMock).at(-1)).toEqual({ domain: "envio.empresa.com.br" });
  });

  it("'Cancelar' fecha o aviso sem cadastrar", async () => {
    const fetchMock = mockApi({
      extra: (url, init) => (url.endsWith("/api/mail/domains") && init?.method === "POST" ? CONFLICT : undefined),
    });
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByPlaceholderText("exemplo.com"), "empresa.com.br");
    await user.click(screen.getByRole("button", { name: /adicionar domínio/i }));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: /^cancelar$/i }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(posts(fetchMock)).toHaveLength(1);
  });

  it("consulta do MX falhou: aviso próprio, também com confirmação", async () => {
    mockApi({
      extra: (url, init) =>
        url.endsWith("/api/mail/domains") && init?.method === "POST"
          ? {
              status: 409,
              body: {
                error: "domain_receives_mail",
                message: "Não foi possível consultar.",
                existingMail: { status: "unknown", servers: [], suggestedDomain: "envio.empresa.com.br" },
              },
            }
          : undefined,
    });
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByPlaceholderText("exemplo.com"), "empresa.com.br");
    await user.click(screen.getByRole("button", { name: /adicionar domínio/i }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/não foi possível confirmar quem recebe o e-mail/i);
    expect(screen.getByRole("checkbox")).toBeInTheDocument();
  });
});
