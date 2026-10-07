/**
 * Página Certificados.
 *
 * Pedido do dono do produto (01/10/2026): ver em um lugar só o certificado
 * de cada nome que o painel serve (painel, domínios dos projetos, e-mail),
 * com o estado de verdade e um botão para agir — "Tentar emitir agora" no
 * automático e certificado próprio (manual) com "Voltar para automático".
 */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CertificateItem, CertificateListResponse } from "@paas/core";
import { CertificatesPage } from "../src/pages/CertificatesPage";
import { CertificateSummary } from "../src/components/certificates/CertificateSummary";

const base: Omit<CertificateItem, "host" | "owner"> = {
  mode: "automatic",
  coveredBy: null,
  state: "valid",
  issuer: "Let's Encrypt",
  validTo: "2026-12-30T12:00:00.000Z",
  renewsAround: "2026-11-30T12:00:00.000Z",
  lastError: null,
  manual: null,
  canRetry: false,
};

const PANEL: CertificateItem = { ...base, host: "painel.exemplo.com.br", owner: { kind: "panel", projectId: null, projectName: null } };
const LOJA: CertificateItem = {
  ...base,
  host: "loja.exemplo.com.br",
  owner: { kind: "project", projectId: "p1", projectName: "Loja" },
  state: "failed",
  issuer: null,
  validTo: null,
  renewsAround: null,
  canRetry: true,
  lastError: {
    cause: "cloudflare",
    message: "A Cloudflare está na frente deste nome (nuvem laranja).",
    detail: "HTTP 403 urn:ietf:params:acme:error:unauthorized - 521",
    at: "2026-10-01T10:00:00.000Z",
    retryAfter: null,
  },
};
const MAIL: CertificateItem = {
  ...base,
  host: "mail.exemplo.com.br",
  owner: { kind: "mail", projectId: null, projectName: null },
  state: "issuing",
  issuer: null,
  validTo: null,
  renewsAround: null,
  canRetry: true,
};
const MANUAL: CertificateItem = {
  ...base,
  host: "www.exemplo.com.br",
  owner: { kind: "project", projectId: "p1", projectName: "Loja" },
  mode: "manual",
  state: "expiring",
  issuer: "Empresa Exemplo CA",
  validTo: "2026-10-20T12:00:00.000Z",
  renewsAround: null,
  manual: {
    issuer: "Empresa Exemplo CA",
    validFrom: "2025-10-20T12:00:00.000Z",
    validTo: "2026-10-20T12:00:00.000Z",
    names: ["www.exemplo.com.br"],
    installedAt: "2026-09-01T12:00:00.000Z",
  },
};

function list(items: CertificateItem[]): CertificateListResponse {
  return { checkedAt: new Date().toISOString(), proxyRunning: true, items };
}

type Reply = { status: number; body: unknown };
function mockApi(handler: (url: string, init?: RequestInit) => Reply | undefined) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const reply = handler(String(input), init) ?? { status: 404, body: { error: "not_found", message: "?" } };
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage() {
  render(
    <MemoryRouter>
      <CertificatesPage pollMs={10} pollMaxMs={2000} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

function setVisibility(value: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  document.dispatchEvent(new Event("visibilitychange"));
}

const VALID_LOJA: CertificateItem = {
  ...LOJA,
  state: "valid",
  issuer: "Let's Encrypt",
  validTo: base.validTo,
  renewsAround: base.renewsAround,
  lastError: null,
  canRetry: false,
};

describe("CertificatesPage — lista", () => {
  it("cada nome com dono, modo, estado, emissor, validade e renovação aproximada", async () => {
    mockApi((url) => (url.startsWith("/api/certificates") ? { status: 200, body: list([PANEL, LOJA, MAIL, MANUAL]) } : undefined));
    renderPage();
    const painel = await screen.findByTestId("cert-painel.exemplo.com.br");
    expect(within(painel).getByText("Painel")).toBeInTheDocument();
    expect(within(painel).getByText("Automático")).toBeInTheDocument();
    expect(within(painel).getByText("Válido")).toBeInTheDocument();
    expect(within(painel).getByText(/Emitido por Let's Encrypt/)).toBeInTheDocument();
    expect(within(painel).getByText(/30\/12\/2026/)).toBeInTheDocument();
    expect(within(painel).getByText(/renova sozinho por volta de 30\/11\/2026/)).toBeInTheDocument();
    expect(within(painel).getByText(/aproximad/)).toBeInTheDocument();

    const loja = screen.getByTestId("cert-loja.exemplo.com.br");
    expect(within(loja).getByText("Projeto Loja")).toBeInTheDocument();
    expect(within(loja).getByText("Falhou")).toBeInTheDocument();
    expect(within(loja).getByText(/nuvem laranja/)).toBeInTheDocument();

    expect(within(screen.getByTestId("cert-mail.exemplo.com.br")).getByText("E-mail")).toBeInTheDocument();
    expect(within(screen.getByTestId("cert-mail.exemplo.com.br")).getByText("Emitindo")).toBeInTheDocument();

    const manual = screen.getByTestId("cert-www.exemplo.com.br");
    expect(within(manual).getByText("Manual")).toBeInTheDocument();
    expect(within(manual).getByText("Vence em breve")).toBeInTheDocument();
    expect(within(manual).getByText(/não renova sozinho/i)).toBeInTheDocument();
  });

  it("proxy fora do ar: aviso", async () => {
    mockApi((url) =>
      url.startsWith("/api/certificates")
        ? { status: 200, body: { ...list([{ ...PANEL, state: "unknown", issuer: null, validTo: null, renewsAround: null }]), proxyRunning: false } }
        : undefined,
    );
    renderPage();
    expect(await screen.findByText(/proxy .* não está rodando/i)).toBeInTheDocument();
  });
});

describe("CertificatesPage — Tentar emitir agora", () => {
  it("um clique: pede a emissão e acompanha até ficar válido", async () => {
    let issued = false;
    const fetchMock = mockApi((url, init) => {
      if (url === "/api/certificates/loja.exemplo.com.br/retry" && init?.method === "POST") {
        return { status: 202, body: { host: "loja.exemplo.com.br", message: "Pedimos ao proxy." } };
      }
      if (url.startsWith("/api/certificates?host=loja.exemplo.com.br")) {
        const done = issued;
        issued = true;
        return { status: 200, body: list([done ? { ...LOJA, state: "valid", issuer: "Let's Encrypt", validTo: base.validTo, renewsAround: base.renewsAround, lastError: null, canRetry: false } : { ...LOJA, state: "issuing", lastError: null }]) };
      }
      if (url.startsWith("/api/certificates")) return { status: 200, body: list([LOJA]) };
      return undefined;
    });
    renderPage();
    const card = await screen.findByTestId("cert-loja.exemplo.com.br");
    await userEvent.click(within(card).getByRole("button", { name: /Tentar emitir agora/ }));
    expect(fetchMock.mock.calls.some(([u, i]) => String(u).endsWith("/retry") && i?.method === "POST")).toBe(true);
    expect(await within(card).findByText(/Certificado emitido/)).toBeInTheDocument();
    expect(within(card).getByText("Válido")).toBeInTheDocument();
  });

  it("o botão usa a cor azul (info)", async () => {
    mockApi((url) => (url.startsWith("/api/certificates") ? { status: 200, body: list([LOJA]) } : undefined));
    renderPage();
    const btn = await screen.findByRole("button", { name: /Tentar emitir agora/ });
    expect(btn.className).toContain("bg-sky-600");
  });

  it("limite de frequência (429): mostra a mensagem do servidor", async () => {
    mockApi((url, init) => {
      if (url.endsWith("/retry") && init?.method === "POST") {
        return { status: 429, body: { error: "retry_too_soon", message: "Tente de novo em 42 s.", retryAfterSeconds: 42 } };
      }
      if (url.startsWith("/api/certificates")) return { status: 200, body: list([LOJA]) };
      return undefined;
    });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /Tentar emitir agora/ }));
    expect(await screen.findByText(/Tente de novo em 42 s/)).toBeInTheDocument();
  });

  it("acompanhamento que estoura o tempo: avisa que o Caddy segue tentando sozinho", async () => {
    mockApi((url, init) => {
      if (url.endsWith("/retry") && init?.method === "POST") return { status: 202, body: { host: MAIL.host, message: "ok" } };
      if (url.startsWith("/api/certificates")) return { status: 200, body: list([MAIL]) };
      return undefined;
    });
    render(
      <MemoryRouter>
        <CertificatesPage pollMs={5} pollMaxMs={30} />
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole("button", { name: /Tentar emitir agora/ }));
    expect(await screen.findByText(/continua tentando sozinho/)).toBeInTheDocument();
  });

  it("certificado válido: 'Renovar agora?' só explica que não é preciso (não chama o servidor)", async () => {
    const fetchMock = mockApi((url) => (url.startsWith("/api/certificates") ? { status: 200, body: list([PANEL]) } : undefined));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /Renovar agora/ }));
    expect(screen.getByText(/não é preciso/i)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/retry"))).toBe(false);
  });
});

// Validação real (07/10/2026): o certificado ficou válido e a tela seguiu
// mostrando o estado antigo até recarregar a página.
describe("CertificatesPage — atualiza sozinha enquanto um certificado está a caminho", () => {
  it("consulta sozinha enquanto há nome emitindo/falhou e para quando todos ficam válidos", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let issued = false;
    const fetchMock = mockApi((url) =>
      url === "/api/certificates" ? { status: 200, body: list([PANEL, issued ? VALID_LOJA : LOJA]) } : undefined,
    );
    const listCalls = () => fetchMock.mock.calls.filter(([u]) => String(u) === "/api/certificates").length;
    renderPage();
    const card = await screen.findByTestId("cert-loja.exemplo.com.br");
    expect(within(card).getByText("Falhou")).toBeInTheDocument();
    issued = true;
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(within(screen.getByTestId("cert-loja.exemplo.com.br")).getByText("Válido")).toBeInTheDocument();
    const after = listCalls();
    await act(async () => vi.advanceTimersByTimeAsync(30 * 60_000));
    expect(listCalls()).toBe(after);
  });

  it("tudo válido (ou manual): não fica consultando", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = mockApi((url) => (url === "/api/certificates" ? { status: 200, body: list([PANEL, MANUAL]) } : undefined));
    renderPage();
    await screen.findByTestId("cert-painel.exemplo.com.br");
    await act(async () => vi.advanceTimersByTimeAsync(10 * 60_000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aba oculta: não consulta; uma consulta que falha não apaga a lista", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let fail = false;
    const fetchMock = mockApi((url) =>
      url === "/api/certificates" ? (fail ? { status: 500, body: { error: "x", message: "x" } } : { status: 200, body: list([MAIL]) }) : undefined,
    );
    renderPage();
    await screen.findByTestId("cert-mail.exemplo.com.br");
    act(() => setVisibility("hidden"));
    await act(async () => vi.advanceTimersByTimeAsync(10 * 60_000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fail = true;
    await act(async () => setVisibility("visible"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("cert-mail.exemplo.com.br")).toBeInTheDocument();
    expect(screen.queryByText(/Não foi possível carregar/)).not.toBeInTheDocument();
  });

  it("\"Tentar emitir agora\" e o servidor diz que já está válido: o card se atualiza na hora", async () => {
    mockApi((url, init) => {
      if (url.endsWith("/retry") && init?.method === "POST") {
        return { status: 409, body: { error: "already_valid", message: "O certificado de loja.exemplo.com.br já está válido." } };
      }
      if (url.startsWith("/api/certificates?host=loja.exemplo.com.br")) return { status: 200, body: list([VALID_LOJA]) };
      if (url === "/api/certificates") return { status: 200, body: list([LOJA]) };
      return undefined;
    });
    renderPage();
    const card = await screen.findByTestId("cert-loja.exemplo.com.br");
    await userEvent.click(within(card).getByRole("button", { name: /Tentar emitir agora/ }));
    expect(await within(card).findByText("Válido")).toBeInTheDocument();
    expect(within(card).getByText(/já está válido/)).toBeInTheDocument();
    expect(within(card).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /Tentar emitir agora/ })).not.toBeInTheDocument();
  });
});

describe("CertificatesPage — certificado próprio (manual)", () => {
  it("envia certificado e chave; recusa aparece com o motivo; sucesso vira Manual", async () => {
    let attempt = 0;
    const fetchMock = mockApi((url, init) => {
      if (url === "/api/certificates/loja.exemplo.com.br/manual" && init?.method === "PUT") {
        attempt += 1;
        if (attempt === 1) return { status: 400, body: { error: "key_mismatch", message: "A chave privada não é a deste certificado." } };
        return { status: 200, body: { item: { ...LOJA, mode: "manual", state: "valid", issuer: "Empresa Exemplo CA", validTo: base.validTo, lastError: null, canRetry: false, manual: MANUAL.manual } } };
      }
      if (url.startsWith("/api/certificates")) return { status: 200, body: list([LOJA]) };
      return undefined;
    });
    renderPage();
    const card = await screen.findByTestId("cert-loja.exemplo.com.br");
    await userEvent.click(within(card).getByRole("button", { name: /Usar certificado próprio/ }));
    await userEvent.type(within(card).getByLabelText(/Certificado \(PEM/), "CERT-PEM");
    await userEvent.type(within(card).getByLabelText(/Chave privada/), "KEY-PEM");
    const install = within(card).getByRole("button", { name: /Instalar certificado/ });
    expect(install.className).toContain("bg-emerald-600");
    await userEvent.click(install);
    expect(await within(card).findByText(/A chave privada não é a deste certificado/)).toBeInTheDocument();
    const put = fetchMock.mock.calls.find(([u, i]) => String(u).endsWith("/manual") && i?.method === "PUT")!;
    expect(JSON.parse(String(put[1]!.body))).toEqual({ certificate: "CERT-PEM", privateKey: "KEY-PEM" });

    await userEvent.click(within(card).getByRole("button", { name: /Instalar certificado/ }));
    await waitFor(() => expect(within(screen.getByTestId("cert-loja.exemplo.com.br")).getByText("Manual")).toBeInTheDocument());
  });

  it("Voltar para automático: vermelho, pede confirmação e chama DELETE", async () => {
    const fetchMock = mockApi((url, init) => {
      if (url === "/api/certificates/www.exemplo.com.br/manual" && init?.method === "DELETE") {
        return { status: 200, body: { item: { ...MANUAL, mode: "automatic", manual: null, state: "issuing", canRetry: true } } };
      }
      if (url.startsWith("/api/certificates")) return { status: 200, body: list([MANUAL]) };
      return undefined;
    });
    renderPage();
    const card = await screen.findByTestId("cert-www.exemplo.com.br");
    const btn = within(card).getByRole("button", { name: /Voltar para automático/ });
    expect(btn.className).toContain("bg-red-600");
    await userEvent.click(btn);
    expect(fetchMock.mock.calls.some(([, i]) => i?.method === "DELETE")).toBe(false);
    await userEvent.click(within(card).getByRole("button", { name: /Confirmar/ }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => i?.method === "DELETE")).toBe(true));
    expect(await within(card).findByText("Automático")).toBeInTheDocument();
  });
});

describe("CertificateSummary — resumo no e-mail e nos domínios do projeto", () => {
  it("mostra o estado de cada nome do filtro e o link 'Ver em Certificados'", async () => {
    const fetchMock = mockApi((url) => (url === "/api/certificates?project=p1" ? { status: 200, body: list([LOJA, MANUAL]) } : undefined));
    render(
      <MemoryRouter>
        <CertificateSummary query="project=p1" />
      </MemoryRouter>,
    );
    expect(await screen.findByText("loja.exemplo.com.br")).toBeInTheDocument();
    expect(screen.getByText("Falhou")).toBeInTheDocument();
    expect(screen.getByText(/Manual/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Ver em Certificados/ })).toHaveAttribute("href", "/certificates");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("certificado do e-mail emitindo: o resumo consulta sozinho até ficar válido", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let issued = false;
    const fetchMock = mockApi((url) =>
      url === "/api/certificates?kind=mail" ? { status: 200, body: list([issued ? { ...MAIL, state: "valid", canRetry: false } : MAIL]) } : undefined,
    );
    render(
      <MemoryRouter>
        <CertificateSummary query="kind=mail" />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Emitindo")).toBeInTheDocument();
    issued = true;
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(screen.getByText("Válido")).toBeInTheDocument();
    const after = fetchMock.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(30 * 60_000));
    expect(fetchMock.mock.calls.length).toBe(after);
  });

  it("falha ao carregar: só o link (não quebra o card que o contém)", async () => {
    mockApi(() => ({ status: 500, body: { error: "x", message: "x" } }));
    render(
      <MemoryRouter>
        <CertificateSummary query="kind=mail" />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("link", { name: /Ver em Certificados/ })).toBeInTheDocument();
  });
});
