/**
 * Saúde do envio de e-mail: itens opcionais ("Opcional · não configurado" /
 * "Opcional · incompleto") e itens marcados como ciente. Nenhum dos dois conta
 * em "atenção" nem muda o selo; os dois continuam visíveis, com texto (não só
 * cor) e com o "O que fazer". A API é simulada (fetch).
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mailHealthScope,
  type DeliveryHealthResponse,
  type DeliveryHealthStateResponse,
  type DnsPlanResponse,
  type MailHealthCheck,
  type MailHealthCounts,
  type MailHealthScope,
  type MailHealthScopeSummary,
} from "@paas/core";
import { DeliveryHealthCard } from "../src/components/mail/DeliveryHealthCard";
import { ProjectEmailHealth } from "../src/components/project/ProjectEmailHealth";
import { setLocale } from "../src/i18n/core";

const DOMAIN = "envio.example.com";
const HOST = `mail.${DOMAIN}`;
const IP = "203.0.113.10";

const PLAN: DnsPlanResponse = {
  domain: DOMAIN,
  serverHostname: HOST,
  ptr: { ip: IP, expected: HOST },
  mtaStsPolicy: `version: STSv1\r\nmode: testing\r\nmx: ${HOST}\r\nmax_age: 86400\r\n`,
  records: [
    { id: "a", order: 1, type: "A", name: HOST, value: IP, need: "required", purpose: "a", proxied: false },
    { id: "mta_sts_a", order: 2, type: "A", name: `mta-sts.${DOMAIN}`, value: IP, need: "optional", purpose: "mta_sts_a", proxied: false },
    { id: "mta_sts", order: 3, type: "TXT", name: `_mta-sts.${DOMAIN}`, value: "v=STSv1; id=abc123", need: "optional", purpose: "mta_sts", proxied: false },
  ],
};

const ACK = { reason: "vou pedir ao suporte", at: "2026-10-26T12:00:00.000Z", by: "kelvin" };

function summarize(list: MailHealthCheck[]): MailHealthScopeSummary {
  const counts: MailHealthCounts = { ok: 0, warn: 0, critical: 0, optional: 0, acknowledged: 0 };
  for (const c of list) {
    if (c.level === "optional") counts.optional += 1;
    else if (c.acknowledged) counts.acknowledged += 1;
    else if (c.level === "ok" || c.level === "warn" || c.level === "critical") counts[c.level] += 1;
  }
  return { level: counts.critical ? "critical" : counts.warn ? "warn" : "ok", counts };
}

function reportOf(checks: MailHealthCheck[]): DeliveryHealthResponse {
  const total = summarize(checks);
  const scope = (s: MailHealthScope) => summarize(checks.filter((c) => mailHealthScope(c.id) === s));
  return {
    domain: DOMAIN,
    checkedAt: "2026-10-26T12:00:00.000Z",
    level: total.level,
    counts: total.counts,
    checks,
    scopes: { server: scope("server"), domain: scope("domain") },
    inboxIssues: checks.filter((c) => c.inbox && !c.acknowledged && (c.level === "warn" || c.level === "critical")).map((c) => c.id),
  };
}

const PTR_WARN: MailHealthCheck = {
  id: "ptr",
  level: "warn",
  inbox: true,
  code: "missing",
  params: { ip: IP, expected: HOST, current: "" },
  expected: HOST,
  found: [],
};
const OK_A: MailHealthCheck = { id: "a", level: "ok", inbox: true, code: "ok", params: { host: HOST, ip: IP } };
const STS_ABSENT: MailHealthCheck = { id: "mta_sts", level: "optional", inbox: false, code: "absent", params: { host: `mta-sts.${DOMAIN}` } };
const STS_MISSING_A: MailHealthCheck = {
  id: "mta_sts",
  level: "optional",
  inbox: false,
  code: "missing_a",
  params: { host: `mta-sts.${DOMAIN}`, ip: IP },
  expected: IP,
  found: ["v=STSv1; id=abc123"],
};
const TLS_RPT_NO_RUA: MailHealthCheck = { id: "tls_rpt", level: "optional", inbox: false, code: "no_rua", params: {}, expected: "v=TLSRPTv1; rua=mailto:x", found: ["v=TLSRPTv1"] };

interface Call {
  method: string;
  url: string;
  body: string | null;
}

/** API simulada: GET devolve `state`; PUT/DELETE de ciente devolvem o estado seguinte e guardam as chamadas. */
function mockApi(state: DeliveryHealthStateResponse, next?: DeliveryHealthStateResponse | Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url: String(input), body: typeof init?.body === "string" ? init.body : null });
      if (method === "GET") return Response.json(state);
      if (next instanceof Response) return next.clone();
      return Response.json(next ?? state);
    }),
  );
  return calls;
}

beforeEach(() => setLocale("pt-BR", { persist: false }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const row = (id: string) => document.querySelector(`[data-check="${id}"]`) as HTMLElement;

describe("itens opcionais", () => {
  it("não configurado: selo 'Opcional · não configurado', fora do 'atenção' e do selo geral, com o O que fazer", async () => {
    mockApi({ plan: PLAN, report: reportOf([OK_A, STS_ABSENT]) });
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByTestId("badge-mta_sts");
    expect(within(row("mta_sts")).getByText("Opcional · não configurado")).toBeInTheDocument();
    expect(row("mta_sts")).toHaveAttribute("data-level", "optional");
    // o estado é dito em texto, não só por cor
    expect(screen.getByTestId("badge-mta_sts")).toHaveTextContent("Opcional");
    expect(screen.getByTestId("delivery-health")).toHaveAttribute("data-level", "ok");
    expect(screen.getByText(/1 em ordem · 0 em atenção · 0 críticos · 1 opcionais/)).toBeInTheDocument();
    expect(screen.getByTestId("optional-summary")).toHaveTextContent("MTA-STS");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelector('[data-severity="warn"]')).toBeNull();
    expect(screen.getByText(/Nenhum item que afete diretamente a caixa de entrada/)).toBeInTheDocument();
    // continua com o "O que fazer"
    expect(within(row("mta_sts")).getByRole("button", { name: "O que fazer" })).toBeInTheDocument();
  });

  it("incompleto: mensagem própria para cada caso e selo 'Opcional · incompleto'", async () => {
    mockApi({ plan: PLAN, report: reportOf([OK_A, STS_MISSING_A, TLS_RPT_NO_RUA]) });
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByTestId("badge-mta_sts");
    expect(within(row("mta_sts")).getByText("Opcional · incompleto")).toBeInTheDocument();
    expect(within(row("mta_sts")).getByTestId("message-mta_sts")).toHaveTextContent(/Falta o registro A de mta-sts\.envio\.example\.com apontando para 203\.0\.113\.10/);
    expect(within(row("tls_rpt")).getByText("Opcional · incompleto")).toBeInTheDocument();
    expect(screen.getByTestId("delivery-health")).toHaveAttribute("data-level", "ok");
    expect(screen.getByTestId("optional-summary")).toHaveTextContent("MTA-STS, TLS-RPT");
  });

  it.each([
    ["absent", /O painel publica o arquivo da política sozinho/],
    ["missing_a", /Falta o registro A/],
    ["a_mismatch", /aponta para 198\.51\.100\.7, e não para 203\.0\.113\.10/],
    ["a_proxied", /atrás do proxy do Cloudflare/],
    ["missing_txt", /Falta o TXT _mta-sts/],
    ["id_outdated", /A política mudou/],
    ["cert_pending", /ainda está sendo emitido/],
    ["cert_failed", /não pôde ser emitido/],
    ["unreachable", /não abriu/],
    ["invalid", /não tem "version: STSv1"/],
    ["mx_mismatch", /não lista mail\.envio\.example\.com/],
    ["testing", /modo testing/],
    ["enforce", /modo enforce/],
  ])("mensagem do MTA-STS para o caso %s", async (code, pattern) => {
    const check: MailHealthCheck = {
      ...STS_ABSENT,
      level: code === "testing" ? "info" : code === "enforce" ? "ok" : "optional",
      code,
      params: { host: code === "mx_mismatch" ? HOST : `mta-sts.${DOMAIN}`, ip: IP, found: "198.51.100.7", mode: code },
      ...(code === "a_mismatch" ? { expected: IP, found: ["198.51.100.7"] } : {}),
    };
    mockApi({ plan: PLAN, report: reportOf([OK_A, check]) });
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByTestId("badge-mta_sts");
    expect(within(row("mta_sts")).getByTestId("message-mta_sts").textContent).toMatch(pattern);
  });

  it("o O que fazer do MTA-STS traz o A e o TXT com botão de copiar", async () => {
    mockApi({ plan: PLAN, report: reportOf([OK_A, STS_MISSING_A]) });
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByTestId("badge-mta_sts");
    await userEvent.click(within(row("mta_sts")).getByRole("button", { name: "O que fazer" }));
    const region = within(row("mta_sts")).getByRole("region");
    expect(region).toHaveTextContent(`mta-sts.${DOMAIN}`);
    expect(region).toHaveTextContent(`_mta-sts.${DOMAIN}`);
    expect(region).toHaveTextContent("v=STSv1; id=abc123");
    expect(region).toHaveTextContent(/nuvem CINZA/);
    expect(within(region).getByRole("button", { name: "Copiar Nome do registro A" })).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Copiar Valor do TXT" })).toBeInTheDocument();
    expect(region).toHaveTextContent(/Opcional, melhora a reputação/);
  });
});

describe("marcar como ciente", () => {
  it("o botão só aparece no que depende do provedor (PTR), não no que o painel e o DNS resolvem", async () => {
    const spf: MailHealthCheck = { id: "spf", level: "critical", inbox: true, code: "missing", params: { domain: DOMAIN }, expected: "x", found: [] };
    mockApi({ plan: PLAN, report: reportOf([OK_A, PTR_WARN, spf]) });
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByTestId("badge-ptr");
    expect(screen.getByTestId("ack-open-ptr")).toHaveTextContent("Marcar como ciente");
    expect(within(row("spf")).queryByText("Marcar como ciente")).toBeNull();
    expect(within(row("a")).queryByText("Marcar como ciente")).toBeNull();
  });

  it("marca com motivo (PUT), o item vira 'Ciente' e sai do atenção, do selo e do aviso amarelo", async () => {
    const marked = reportOf([OK_A, { ...PTR_WARN, acknowledged: ACK }]);
    const calls = mockApi({ plan: PLAN, report: reportOf([OK_A, PTR_WARN]) }, { plan: PLAN, report: marked });
    render(<DeliveryHealthCard domain={DOMAIN} />);
    // antes: aviso amarelo com o PTR e selo em atenção
    expect(await screen.findByText(/Atenção importante: itens que podem atrasar/)).toBeInTheDocument();
    expect(screen.getByTestId("delivery-health")).toHaveAttribute("data-level", "warn");
    await userEvent.click(screen.getByTestId("ack-open-ptr"));
    const form = screen.getByTestId("ack-form-ptr");
    await userEvent.type(within(form).getByLabelText("Motivo (opcional)"), "vou pedir ao suporte");
    await userEvent.click(within(form).getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(screen.queryByText(/Atenção importante: itens que podem atrasar/)).toBeNull());
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe(`/api/mail/domains/${encodeURIComponent(DOMAIN)}/health/ack/ptr`);
    expect(JSON.parse(put.body!)).toEqual({ reason: "vou pedir ao suporte" });
    // depois: selo 'Ciente' em texto, nível original ainda visível, nota e resumo
    expect(within(row("ptr")).getByText("Ciente")).toBeInTheDocument();
    expect(within(row("ptr")).getByText("Atenção")).toBeInTheDocument();
    expect(row("ptr")).toHaveAttribute("data-acknowledged", "true");
    expect(screen.getByTestId("ack-note-ptr")).toHaveTextContent(/Marcado como ciente em/);
    expect(screen.getByTestId("ack-note-ptr")).toHaveTextContent("Motivo: vou pedir ao suporte");
    expect(screen.getByTestId("ack-summary")).toHaveTextContent("DNS reverso (PTR)");
    expect(screen.getByTestId("delivery-health")).toHaveAttribute("data-level", "ok");
    expect(screen.getByText(/1 cientes/)).toBeInTheDocument();
    expect(screen.getByText(/Nenhum item que afete diretamente a caixa de entrada/)).toBeInTheDocument();
    // continua com o "O que fazer"
    expect(within(row("ptr")).getByRole("button", { name: "O que fazer" })).toBeInTheDocument();
  });

  it("sem motivo: PUT sem corpo; cancelar fecha o formulário sem chamar a API", async () => {
    const calls = mockApi({ plan: PLAN, report: reportOf([OK_A, PTR_WARN]) }, { plan: PLAN, report: reportOf([OK_A, { ...PTR_WARN, acknowledged: { ...ACK, reason: null } }]) });
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByTestId("ack-open-ptr");
    await userEvent.click(screen.getByTestId("ack-open-ptr"));
    await userEvent.click(within(screen.getByTestId("ack-form-ptr")).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByTestId("ack-form-ptr")).toBeNull();
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    await userEvent.click(screen.getByTestId("ack-open-ptr"));
    await userEvent.click(within(screen.getByTestId("ack-form-ptr")).getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(screen.getByTestId("ack-note-ptr")).toBeInTheDocument());
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toBeNull();
    expect(screen.queryByText(/Motivo:/)).toBeNull();
  });

  it("desmarcar (DELETE) volta ao normal: o item conta de novo", async () => {
    const calls = mockApi(
      { plan: PLAN, report: reportOf([OK_A, { ...PTR_WARN, acknowledged: ACK }]) },
      { plan: PLAN, report: reportOf([OK_A, PTR_WARN]) },
    );
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await userEvent.click(await screen.findByRole("button", { name: "Desmarcar" }));
    await waitFor(() => expect(screen.getByTestId("ack-open-ptr")).toBeInTheDocument());
    expect(calls.find((c) => c.method === "DELETE")!.url).toBe(`/api/mail/domains/${encodeURIComponent(DOMAIN)}/health/ack/ptr`);
    expect(within(row("ptr")).queryByText("Ciente")).toBeNull();
    expect(screen.getByTestId("delivery-health")).toHaveAttribute("data-level", "warn");
    expect(screen.getByText(/Atenção importante: itens que podem atrasar/)).toBeInTheDocument();
  });

  it("falha ao marcar: mostra o erro e deixa o formulário aberto", async () => {
    mockApi({ plan: PLAN, report: reportOf([OK_A, PTR_WARN]) }, Response.json({ error: "health_not_checked", message: "Verifique antes." }, { status: 409 }));
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await userEvent.click(await screen.findByTestId("ack-open-ptr"));
    await userEvent.click(within(screen.getByTestId("ack-form-ptr")).getByRole("button", { name: "Confirmar" }));
    expect(await screen.findByText("Verifique antes.")).toBeInTheDocument();
    expect(screen.getByTestId("ack-form-ptr")).toBeInTheDocument();
  });

  it("falha ao desmarcar mostra o erro e mantém a marcação", async () => {
    mockApi(
      { plan: PLAN, report: reportOf([OK_A, { ...PTR_WARN, acknowledged: ACK }]) },
      Response.json({ error: "x", message: "Não deu." }, { status: 500 }),
    );
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await userEvent.click(await screen.findByRole("button", { name: "Desmarcar" }));
    expect(await screen.findByText("Não deu.")).toBeInTheDocument();
    expect(screen.getByTestId("ack-note-ptr")).toBeInTheDocument();
  });

  it("item crítico nunca é silenciado: porta 25 bloqueada mantém o aviso vermelho e não oferece 'Marcar como ciente'", async () => {
    const port25: MailHealthCheck = { id: "port25", level: "critical", inbox: true, code: "blocked", params: { detail: "ETIMEDOUT" } };
    mockApi({ plan: PLAN, report: reportOf([OK_A, port25]) });
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByTestId("badge-port25");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(within(row("port25")).getByText("Crítico")).toBeInTheDocument();
    expect(within(row("port25")).queryByText("Marcar como ciente")).toBeNull();
  });

  it("porta 25 'não deu para testar' (atenção) pode ser marcada como ciente", async () => {
    const port25: MailHealthCheck = { id: "port25", level: "warn", inbox: false, code: "unavailable", params: { detail: "x" } };
    mockApi({ plan: PLAN, report: reportOf([OK_A, port25]) });
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByTestId("badge-port25");
    expect(within(row("port25")).getByText("Marcar como ciente")).toBeInTheDocument();
  });

  it("enforce que deixou de abrir: a causa aparece e o enforce anterior vem como agravante, em atenção", async () => {
    const sts: MailHealthCheck = { id: "mta_sts", level: "warn", inbox: false, code: "missing_a", params: { host: `mta-sts.${DOMAIN}`, ip: IP, wasEnforce: "1" }, expected: IP, found: [] };
    mockApi({ plan: PLAN, report: reportOf([OK_A, sts]) });
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByTestId("badge-mta_sts");
    expect(screen.getByTestId("message-mta_sts").textContent).toMatch(/Falta o registro A.*já esteve em enforce/s);
  });

  it("MX não conferido (consulta falhou): mensagem neutra, sem alarme", async () => {
    const sts: MailHealthCheck = { id: "mta_sts", level: "info", inbox: false, code: "mx_unverified", params: { host: DOMAIN } };
    mockApi({ plan: PLAN, report: reportOf([OK_A, sts]) });
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByTestId("badge-mta_sts");
    expect(screen.getByTestId("message-mta_sts").textContent).toMatch(/Não deu para conferir o MX/);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sem o domínio do painel, o item MTA-STS manda configurar o domínio do painel (e não criar A e TXT)", async () => {
    const sts: MailHealthCheck = { id: "mta_sts", level: "optional", inbox: false, code: "publish_unavailable", params: { host: `mta-sts.${DOMAIN}` } };
    mockApi({ plan: PLAN, report: reportOf([OK_A, sts]) });
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByTestId("badge-mta_sts");
    expect(within(row("mta_sts")).getByText(/Domínio do painel/)).toBeInTheDocument();
    await userEvent.click(within(row("mta_sts")).getByRole("button", { name: "O que fazer" }));
    expect(within(row("mta_sts")).getByText(/exige o domínio do painel configurado/)).toBeInTheDocument();
  });

  it("item em ordem ou opcional não oferece 'Marcar como ciente'", async () => {
    const ptrOk: MailHealthCheck = { ...PTR_WARN, level: "ok", code: "ok" };
    mockApi({ plan: PLAN, report: reportOf([OK_A, ptrOk, STS_ABSENT]) });
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByTestId("badge-ptr");
    expect(screen.queryByText("Marcar como ciente")).toBeNull();
  });
});

describe("em inglês", () => {
  it("rótulos de opcional e ciente traduzidos", async () => {
    setLocale("en", { persist: false });
    mockApi({ plan: PLAN, report: reportOf([OK_A, STS_ABSENT, { ...PTR_WARN, acknowledged: ACK }]) });
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByTestId("badge-mta_sts");
    expect(within(row("mta_sts")).getByText("Optional · not configured")).toBeInTheDocument();
    expect(within(row("ptr")).getByText("Acknowledged")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unmark" })).toBeInTheDocument();
  });
});

describe("resumo do projeto (ProjectEmailHealth)", () => {
  const renderIt = () =>
    render(
      <MemoryRouter>
        <ProjectEmailHealth domain={DOMAIN} />
      </MemoryRouter>,
    );

  it("PTR 'ciente' não vira linha de atenção no servidor nem acende o selo; a linha do servidor diz 'Ciente'", async () => {
    mockApi({ plan: PLAN, report: reportOf([OK_A, { ...PTR_WARN, acknowledged: ACK }, STS_ABSENT]) });
    renderIt();
    const badge = await screen.findByTestId("project-email-health-badge");
    expect(badge).toHaveAttribute("data-level", "ok");
    expect(screen.queryByText(/Atenção no servidor/)).toBeNull();
    expect(screen.getByTestId("project-email-health-server")).toHaveTextContent("DNS reverso (PTR): Ciente");
  });

  it("PTR em atenção sem marcação continua acendendo o aviso; opcional diz 'Opcional · …' e não pesa", async () => {
    mockApi({ plan: PLAN, report: reportOf([OK_A, PTR_WARN, STS_ABSENT]) });
    renderIt();
    expect(await screen.findByText(/Atenção no servidor: DNS reverso \(PTR\)/)).toBeInTheDocument();
    expect(screen.getByTestId("project-email-health-badge")).toHaveAttribute("data-level", "warn");
    expect(screen.getByTestId("project-email-health-domain-summary")).toHaveTextContent("Domínio: 1 em ordem · 0 em atenção · 0 críticos");
  });

  it("os itens do domínio mostram o opcional e permitem marcar o PTR pela linha completa", async () => {
    mockApi({ plan: PLAN, report: reportOf([OK_A, STS_ABSENT]) });
    renderIt();
    await screen.findByTestId("project-email-health-badge");
    await userEvent.click(screen.getByRole("button", { name: /Ver os itens de/ }));
    expect(within(screen.getByTestId("project-email-health-items")).getByText("Opcional · não configurado")).toBeInTheDocument();
  });
});
