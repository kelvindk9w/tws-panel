/**
 * Saúde do e-mail dentro da página do projeto (ProjectEmailHealth): resumo do
 * domínio do projeto, expansão com os itens, linha do servidor (PTR e porta 25),
 * estado "ainda não verificado" e botão de verificar com espera. API simulada.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mailHealthScope,
  type DeliveryHealthResponse,
  type DeliveryHealthStateResponse,
  type DnsPlanResponse,
  type MailHealthCheck,
  type MailHealthScope,
  type MailHealthScopeSummary,
} from "@paas/core";
import { ProjectEmailHealth } from "../src/components/project/ProjectEmailHealth";
import { setLocale } from "../src/i18n/core";

const DOMAIN = "loja.example.com";
const HOST = `mail.${DOMAIN}`;
const IP = "203.0.113.20";

const PLAN: DnsPlanResponse = {
  domain: DOMAIN,
  serverHostname: HOST,
  ptr: { ip: IP, expected: HOST },
  mtaStsPolicy: "version: STSv1\r\n",
  records: [{ id: "a", order: 1, type: "A", name: HOST, value: IP, need: "required", purpose: "a", proxied: false }],
};

function scopesOf(checks: MailHealthCheck[]): Record<MailHealthScope, MailHealthScopeSummary> {
  const one = (scope: MailHealthScope): MailHealthScopeSummary => {
    const counts = { ok: 0, warn: 0, critical: 0 };
    for (const c of checks) if (mailHealthScope(c.id) === scope && c.level !== "info") counts[c.level] += 1;
    return { level: counts.critical ? "critical" : counts.warn ? "warn" : "ok", counts };
  };
  return { server: one("server"), domain: one("domain") };
}

function reportOf(checks: MailHealthCheck[]): DeliveryHealthResponse {
  const counts = { ok: 0, warn: 0, critical: 0 };
  for (const c of checks) if (c.level !== "info") counts[c.level] += 1;
  return {
    domain: DOMAIN,
    checkedAt: "2026-10-22T12:00:00.000Z",
    level: counts.critical ? "critical" : counts.warn ? "warn" : "ok",
    counts,
    checks,
    scopes: scopesOf(checks),
    inboxIssues: [],
  };
}

const CHECKS: MailHealthCheck[] = [
  { id: "spf", level: "ok", inbox: true, code: "ok_soft", params: { lookups: 1 } },
  { id: "mx", level: "warn", inbox: false, code: "other", params: { found: "mx.example.org" } },
  { id: "ptr", level: "warn", inbox: true, code: "missing", params: { ip: IP, expected: HOST, current: "" }, expected: HOST, found: [] },
  { id: "port25", level: "ok", inbox: true, code: "ok", params: { host: "mx.example.org" } },
];

function mockApi(state: DeliveryHealthStateResponse, afterCheck?: DeliveryHealthStateResponse) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push(`${method} ${String(input)}`);
      return Response.json(method === "POST" && afterCheck ? afterCheck : state);
    }),
  );
  return calls;
}

function renderIt() {
  return render(
    <MemoryRouter>
      <ProjectEmailHealth domain={DOMAIN} />
    </MemoryRouter>,
  );
}

beforeEach(() => setLocale("pt-BR", { persist: false }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ProjectEmailHealth", () => {
  it("ainda não verificado: explica, mostra o servidor como não verificado e oferece verificar", async () => {
    const calls = mockApi({ plan: PLAN, report: null });
    renderIt();
    expect(await screen.findByText(/Ainda não verificado desde que o painel iniciou/)).toHaveTextContent(DOMAIN);
    const server = screen.getByTestId("project-email-health-server");
    expect(server).toHaveTextContent("DNS reverso (PTR): ainda não verificado");
    expect(server).toHaveTextContent("porta 25 de saída: ainda não verificado");
    expect(server).toHaveTextContent("do servidor (do IP), não deste projeto");
    expect(screen.queryByRole("button", { name: `Ver os itens de ${DOMAIN}` })).toBeNull();
    expect(screen.getByTestId("project-email-health")).toHaveAttribute("data-level", "unknown");
    expect(calls).toEqual([`GET /api/mail/domains/${DOMAIN}/health`]);
  });

  it("verificado: resumo só do domínio, itens do domínio na expansão e estado do servidor na linha", async () => {
    mockApi({ plan: PLAN, report: reportOf(CHECKS) });
    const user = userEvent.setup();
    renderIt();
    expect(await screen.findByText(/Domínio: 1 em ordem · 1 em atenção · 0 críticos/)).toBeInTheDocument();
    expect(screen.getByTestId("project-email-health")).toHaveAttribute("data-level", "warn");
    const server = screen.getByTestId("project-email-health-server");
    expect(server).toHaveTextContent("DNS reverso (PTR): Atenção");
    expect(server).toHaveTextContent("porta 25 de saída: Em ordem");
    expect(within(server).getByRole("link", { name: /Abrir a saúde completa/ })).toHaveAttribute("href", `/mail/${DOMAIN}?aba=dns`);

    const toggle = screen.getByRole("button", { name: `Ver os itens de ${DOMAIN}` });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("project-email-health-items")).toBeNull();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const items = screen.getByTestId("project-email-health-items");
    expect(toggle.getAttribute("aria-controls")).toBe(items.id);
    // só itens do domínio: o PTR e a porta 25 ficam na linha do servidor
    expect(Array.from(items.querySelectorAll("[data-check]")).map((e) => e.getAttribute("data-check"))).toEqual(["spf", "mx"]);
    // cada item tem o seu "O que fazer"
    expect(within(items.querySelector('[data-check="mx"]') as HTMLElement).getByRole("button", { name: "O que fazer" })).toBeInTheDocument();
    await user.click(toggle);
    expect(screen.queryByTestId("project-email-health-items")).toBeNull();
  });

  it("cenário do revisor: PTR e porta 25 em ordem, mas fila, listas e certificado críticos no servidor: nunca diz 'Em ordem'", async () => {
    const checks: MailHealthCheck[] = [
      { id: "spf", level: "ok", inbox: true, code: "ok_soft", params: { lookups: 1 } },
      { id: "dkim", level: "ok", inbox: true, code: "ok", params: { bits: 2048, selector: "paas" } },
      { id: "ptr", level: "ok", inbox: true, code: "ok", params: { ip: IP, expected: HOST, current: HOST } },
      { id: "port25", level: "ok", inbox: true, code: "ok", params: { host: "mx.example.org" } },
      { id: "dnsbl", level: "critical", inbox: true, code: "listed", params: { lists: "Lista Exemplo" } },
      { id: "tls", level: "critical", inbox: true, code: "invalid", params: { host: HOST, error: "expired" } },
      { id: "queue", level: "critical", inbox: true, code: "deferred_auth", params: { count: 2, attempts: 3, minutes: 5, reason: "5.7.26" } },
    ];
    mockApi({ plan: PLAN, report: reportOf(checks) });
    renderIt();
    const badge = await screen.findByTestId("project-email-health-badge");
    expect(badge).toHaveTextContent("Crítico");
    expect(badge).not.toHaveTextContent("Em ordem");
    const box = screen.getByTestId("project-email-health");
    expect(box).toHaveAttribute("data-level", "critical");
    // a COR do selo é a do pior nível (vermelho), mesmo com o domínio sem críticos
    expect(badge.className).toContain("text-red-400");
    expect(badge.className).not.toContain("text-emerald-400");
    expect(badge).toHaveAttribute("data-level", "critical");
    expect(box).toHaveAttribute("data-server-level", "critical");
    // contagem de cada nível, separada: a fila (do domínio) não é contada no servidor
    expect(screen.getByTestId("project-email-health-domain-summary")).toHaveTextContent("Domínio: 2 em ordem · 0 em atenção · 1 críticos");
    expect(screen.getByTestId("project-email-health-server-summary")).toHaveTextContent("Servidor (vale para todos os projetos): 2 em ordem · 0 em atenção · 2 críticos");
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Crítico no servidor, afeta todos os projetos");
    expect(alert).toHaveTextContent("Listas de bloqueio");
    expect(alert).toHaveTextContent("Certificado do servidor de e-mail");
    expect(alert).not.toHaveTextContent("Fila de envio");
    // a linha de PTR e porta 25 continua, sem esconder o resto
    expect(screen.getByTestId("project-email-health-server")).toHaveTextContent("DNS reverso (PTR): Em ordem");
  });

  it("domínio totalmente em ordem com crítico só no servidor: selo vermelho (nível do domínio sozinho enganaria)", async () => {
    const checks: MailHealthCheck[] = [
      { id: "spf", level: "ok", inbox: true, code: "ok_soft", params: { lookups: 1 } },
      { id: "dnsbl", level: "critical", inbox: true, code: "listed", params: { lists: "Lista Exemplo" } },
    ];
    const r = reportOf(checks);
    expect(r.scopes.domain.level).toBe("ok");
    mockApi({ plan: PLAN, report: r });
    renderIt();
    const badge = await screen.findByTestId("project-email-health-badge");
    expect(badge).toHaveTextContent("Crítico");
    expect(badge.className).toContain("text-red-400");
    expect(badge.className).not.toContain("text-emerald-400");
  });

  it("cor do selo por nível: atenção em âmbar, em ordem em verde", async () => {
    mockApi({ plan: PLAN, report: reportOf([{ id: "ptr", level: "warn", inbox: true, code: "missing", params: { ip: IP, expected: HOST, current: "" } }]) });
    renderIt();
    expect((await screen.findByTestId("project-email-health-badge")).className).toContain("text-amber-400");
    cleanup();
    mockApi({ plan: PLAN, report: reportOf([{ id: "spf", level: "ok", inbox: true, code: "ok_soft", params: { lookups: 1 } }]) });
    renderIt();
    expect((await screen.findByTestId("project-email-health-badge")).className).toContain("text-emerald-400");
  });

  it("domínio em ordem e servidor só em atenção: selo de atenção e aviso sem vermelho", async () => {
    const checks: MailHealthCheck[] = [
      { id: "spf", level: "ok", inbox: true, code: "ok_soft", params: { lookups: 1 } },
      { id: "ptr", level: "warn", inbox: true, code: "missing", params: { ip: IP, expected: HOST, current: "" }, expected: HOST, found: [] },
    ];
    mockApi({ plan: PLAN, report: reportOf(checks) });
    renderIt();
    expect(await screen.findByTestId("project-email-health-badge")).toHaveTextContent("Atenção");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Atenção no servidor: DNS reverso (PTR).")).toBeInTheDocument();
  });

  it("tudo em ordem: selo Em ordem e nenhum aviso do servidor", async () => {
    mockApi({ plan: PLAN, report: reportOf([{ id: "spf", level: "ok", inbox: true, code: "ok_soft", params: { lookups: 1 } }, { id: "port25", level: "ok", inbox: true, code: "ok", params: { host: "mx.example.org" } }]) });
    renderIt();
    expect(await screen.findByTestId("project-email-health-badge")).toHaveTextContent("Em ordem");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Atenção no servidor/)).toBeNull();
  });

  it("verificar agora: faz o POST, atualiza e segura o botão por 15 s (limite)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = mockApi({ plan: PLAN, report: null }, { plan: PLAN, report: reportOf(CHECKS) });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    renderIt();
    await screen.findByText(/Ainda não verificado/);
    await user.click(screen.getByRole("button", { name: "Verificar a saúde agora" }));
    expect(await screen.findByRole("button", { name: "Aguarde 15 s" })).toBeDisabled();
    expect(screen.getByTestId("project-email-health-server")).toHaveTextContent("DNS reverso (PTR): Atenção");
    expect(calls).toEqual([`GET /api/mail/domains/${DOMAIN}/health`, `POST /api/mail/domains/${DOMAIN}/health/check`]);
    await vi.advanceTimersByTimeAsync(15_500);
    expect(await screen.findByRole("button", { name: "Verificar a saúde agora" })).toBeEnabled();
  });

  it("429 do servidor: mostra o aviso e também segura o botão", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "POST"
          ? Response.json({ error: "health_check_too_soon", message: "Espere 9 s." }, { status: 429 })
          : Response.json({ plan: PLAN, report: null }),
      ),
    );
    const user = userEvent.setup();
    renderIt();
    await screen.findByText(/Ainda não verificado/);
    await user.click(screen.getByRole("button", { name: "Verificar a saúde agora" }));
    expect(await screen.findByText("Espere 9 s.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Aguarde \d+ s/ })).toBeDisabled();
  });

  it.each([
    [40, 40],
    [300, 60],
    [0, 15],
    [undefined, 15],
  ])("429 health_check_busy com retryAfter=%s: o botão espera %s s", async (retryAfter, expected) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "POST"
          ? Response.json({ error: "health_check_busy", message: "Muitas verificações.", ...(retryAfter === undefined ? {} : { retryAfter }) }, { status: 429 })
          : Response.json({ plan: PLAN, report: null }),
      ),
    );
    const user = userEvent.setup();
    renderIt();
    await screen.findByText(/Ainda não verificado/);
    await user.click(screen.getByRole("button", { name: "Verificar a saúde agora" }));
    expect(await screen.findByRole("button", { name: `Aguarde ${expected} s` })).toBeDisabled();
  });

  it("falha ao carregar: mostra o erro sem quebrar a página", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "x", message: "Servidor fora do ar." }, { status: 500 })));
    renderIt();
    expect(await screen.findByText("Servidor fora do ar.")).toBeInTheDocument();
    expect(screen.getByTestId("project-email-health-server")).toBeInTheDocument();
  });

  it("em inglês", async () => {
    setLocale("en", { persist: false });
    mockApi({ plan: PLAN, report: reportOf(CHECKS) });
    renderIt();
    expect(await screen.findByText(/Domain: 1 in order · 1 need attention/)).toBeInTheDocument();
    expect(screen.getByTestId("project-email-health-server")).toHaveTextContent("reverse DNS (PTR): Attention");
    expect(screen.getByRole("button", { name: `Show the items of ${DOMAIN}` })).toBeInTheDocument();
  });
});
