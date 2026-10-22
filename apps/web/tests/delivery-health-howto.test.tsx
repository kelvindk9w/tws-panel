/**
 * "O que fazer" de cada item da saúde do e-mail, severidade do PTR e os dois
 * níveis (servidor x domínio) no DeliveryHealthCard. A API é simulada (fetch).
 * Todos os endereços dos testes são de documentação (203.0.113.x, 198.51.100.x,
 * example.com): o código do painel não pode ter nenhum IP ou domínio real.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { DeliveryHealthCard } from "../src/components/mail/DeliveryHealthCard";
import { catalog, setLocale } from "../src/i18n/core";

const DOMAIN = "envio.example.com";
const HOST = `mail.${DOMAIN}`;
const IP = "203.0.113.10";

function planFor(ip: string, host: string): DnsPlanResponse {
  return {
    domain: DOMAIN,
    serverHostname: host,
    ptr: { ip, expected: host },
    mtaStsPolicy: "version: STSv1\r\nmode: testing\r\nmx: " + host + "\r\nmax_age: 86400\r\n",
    records: [
      { id: "a", order: 1, type: "A", name: host, value: ip, need: "required", purpose: "a", proxied: false },
      { id: "mx", order: 2, type: "MX", name: DOMAIN, value: host, priority: 10, need: "required", purpose: "mx", proxied: false },
      { id: "spf", order: 3, type: "TXT", name: DOMAIN, value: `v=spf1 ip4:${ip} ~all`, need: "required", purpose: "spf", proxied: false },
      { id: "dmarc", order: 4, type: "TXT", name: `_dmarc.${DOMAIN}`, value: `v=DMARC1; p=none; rua=mailto:postmaster@${DOMAIN}`, need: "required", purpose: "dmarc", proxied: false },
      { id: "tls_rpt", order: 5, type: "TXT", name: `_smtp._tls.${DOMAIN}`, value: `v=TLSRPTv1; rua=mailto:postmaster@${DOMAIN}`, need: "optional", purpose: "tls_rpt", proxied: false },
      { id: "mta_sts", order: 6, type: "TXT", name: `_mta-sts.${DOMAIN}`, value: "v=STSv1; id=abc", need: "optional", purpose: "mta_sts", proxied: false },
    ],
  };
}
const PLAN = planFor(IP, HOST);

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
    inboxIssues: checks.filter((c) => c.inbox && (c.level === "warn" || c.level === "critical")).map((c) => c.id),
  };
}

const OK_AUTH: MailHealthCheck[] = [
  { id: "spf", level: "ok", inbox: true, code: "ok_soft", params: { lookups: 1 } },
  { id: "dkim", level: "ok", inbox: true, code: "ok", params: { bits: 2048, selector: "paas" } },
  { id: "dmarc", level: "ok", inbox: true, code: "none", params: { policy: "none" }, expected: PLAN.records[3]!.value, found: [PLAN.records[3]!.value] },
];
const PTR_MISSING: MailHealthCheck = {
  id: "ptr",
  level: "warn",
  inbox: true,
  code: "missing",
  params: { ip: IP, expected: HOST, current: "" },
  expected: HOST,
  found: [],
};

function mockApi(state: DeliveryHealthStateResponse, afterCheck?: DeliveryHealthStateResponse): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      Response.json(init?.method === "POST" && afterCheck ? afterCheck : state),
    ),
  );
}

function row(id: string): HTMLElement {
  const el = document.querySelector(`[data-check="${id}"]`);
  if (!el) throw new Error(`linha ${id} não existe`);
  return el as HTMLElement;
}

beforeEach(() => setLocale("pt-BR", { persist: false }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("severidade do PTR", () => {
  it("PTR ausente com SPF, DKIM e DMARC em ordem: aviso laranja de atenção, nunca o vermelho crítico", async () => {
    mockApi({ plan: PLAN, report: reportOf([...OK_AUTH, PTR_MISSING]) });
    render(<DeliveryHealthCard domain={DOMAIN} />);
    const attention = await screen.findByRole("status");
    expect(attention).toHaveAttribute("data-severity", "warn");
    expect(attention).toHaveTextContent("Atenção importante");
    expect(attention).toHaveTextContent("DNS reverso (PTR)");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(row("ptr")).toHaveAttribute("data-level", "warn");
    expect(within(row("ptr")).getByText("Atenção")).toBeInTheDocument();
    expect(within(row("ptr")).getByText(/o Gmail pode aceitar sem ele, mas Microsoft, Yahoo e servidores corporativos podem atrasar ou recusar/)).toBeInTheDocument();
    expect(within(row("ptr")).queryByText("Crítico")).toBeNull();
  });

  it("o vermelho fica para a porta 25 bloqueada: cada aviso lista só os itens do seu nível", async () => {
    const port25: MailHealthCheck = { id: "port25", level: "critical", inbox: true, code: "blocked", params: { detail: "ETIMEDOUT" } };
    mockApi({ plan: PLAN, report: reportOf([...OK_AUTH, PTR_MISSING, port25]) });
    render(<DeliveryHealthCard domain={DOMAIN} />);
    const red = await screen.findByRole("alert");
    expect(red).toHaveAttribute("data-severity", "critical");
    expect(red).toHaveTextContent("Porta 25 de saída");
    expect(red).not.toHaveTextContent("DNS reverso (PTR)");
    const orange = screen.getByRole("status");
    expect(orange).toHaveTextContent("DNS reverso (PTR)");
    expect(orange).not.toHaveTextContent("Porta 25 de saída");
  });

  it("mostra o nome esperado e o valor atual encontrado do PTR", async () => {
    const generic: MailHealthCheck = { ...PTR_MISSING, code: "generic", found: ["vmi1.provedor.example.net"], params: { ip: IP, expected: HOST, current: "vmi1.provedor.example.net" } };
    mockApi({ plan: PLAN, report: reportOf([...OK_AUTH, generic]) });
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByRole("status");
    const ptr = row("ptr");
    expect(within(ptr).getByText("Esperado")).toBeInTheDocument();
    expect(within(ptr).getByText(HOST)).toBeInTheDocument();
    expect(within(ptr).getByText("vmi1.provedor.example.net")).toBeInTheDocument();
  });

  it("PTR ausente: o valor atual aparece como (nada)", async () => {
    mockApi({ plan: PLAN, report: reportOf([PTR_MISSING]) });
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByRole("status");
    expect(within(row("ptr")).getByText("(nada)")).toBeInTheDocument();
  });
});

describe("PTR no 2º domínio de um servidor: o item a conferir é o HELO", () => {
  const FIRST_HOST = "mail.primeiro.example.net";
  const HELO: MailHealthCheck = { id: "helo", level: "ok", inbox: true, code: "ok", params: { host: FIRST_HOST, ip: IP } };
  const A: MailHealthCheck = { id: "a", level: "ok", inbox: true, code: "ok", params: { host: HOST, ip: IP } };
  const ptr = (expected: string): MailHealthCheck => ({ ...PTR_MISSING, params: { ip: IP, expected, current: "" }, expected });

  it("2º domínio: o nome esperado é o do 1º; o texto manda para o HELO, na seção do servidor, e não para o Registro A", async () => {
    mockApi({ plan: planFor(IP, FIRST_HOST), report: reportOf([A, HELO, ptr(FIRST_HOST)]) });
    const user = userEvent.setup();
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByRole("status");
    await user.click(within(row("ptr")).getByRole("button", { name: "O que fazer" }));
    const region = within(row("ptr")).getByRole("region");
    expect(within(region).getByText(/confira o item "Nome do servidor no envio \(HELO\)", na seção do servidor, logo acima/)).toBeInTheDocument();
    expect(within(region).queryByText(/Registro A do servidor de e-mail/)).toBeNull();
    // o item citado existe de fato, na seção do servidor, antes do PTR
    const server = document.querySelector('[data-scope-section="server"]') as HTMLElement;
    const ids = Array.from(server.querySelectorAll("[data-check]")).map((e) => e.getAttribute("data-check"));
    expect(ids.indexOf("helo")).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf("helo")).toBeLessThan(ids.indexOf("ptr"));
  });

  it("1º domínio (sem item HELO): o texto manda para o Registro A, na seção do domínio", async () => {
    mockApi({ plan: PLAN, report: reportOf([A, ptr(HOST)]) });
    const user = userEvent.setup();
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByRole("status");
    await user.click(within(row("ptr")).getByRole("button", { name: "O que fazer" }));
    const region = within(row("ptr")).getByRole("region");
    expect(within(region).getByText(/confira o item "Registro A do servidor de e-mail", na seção do domínio, mais abaixo/)).toBeInTheDocument();
    expect(within(region).queryByText(/Nome do servidor no envio/)).toBeNull();
  });

  it("em inglês também", async () => {
    setLocale("en", { persist: false });
    mockApi({ plan: planFor(IP, FIRST_HOST), report: reportOf([A, HELO, ptr(FIRST_HOST)]) });
    const user = userEvent.setup();
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByRole("status");
    await user.click(within(row("ptr")).getByRole("button", { name: "What to do" }));
    expect(within(within(row("ptr")).getByRole("region")).getByText(/check the "Server name when sending \(HELO\)" item, in the server section just above/)).toBeInTheDocument();
  });
});

describe("nome de PTR longo e sem hífen", () => {
  it("quebra em qualquer ponto (nada de rolagem horizontal a 360 px)", async () => {
    const longName = `${"a".repeat(30)}${"b".repeat(35)}.example.com`;
    const plan = planFor(IP, longName);
    const ptr: MailHealthCheck = { ...PTR_MISSING, params: { ip: IP, expected: longName, current: "" }, expected: longName };
    mockApi({ plan, report: reportOf([ptr]) });
    const user = userEvent.setup();
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByRole("status");
    const rowEl = row("ptr");
    expect(rowEl.textContent).toContain(longName);
    // o texto da mensagem e a área de passos quebram em qualquer ponto
    expect((rowEl.firstElementChild!.nextElementSibling as HTMLElement).className).toContain("[overflow-wrap:anywhere]");
    expect(screen.getByTestId("message-ptr").className).toContain("[overflow-wrap:anywhere]");
    await user.click(within(rowEl).getByRole("button", { name: "O que fazer" }));
    expect(within(rowEl).getByRole("region").className).toContain("[overflow-wrap:anywhere]");
    for (const code of Array.from(rowEl.querySelectorAll("code, dd"))) expect(code.className, code.textContent ?? "").toMatch(/break-all|anywhere/);
  });
});

describe("dois níveis: servidor e domínio", () => {
  it("separa o que vale para todos os projetos do que é do domínio", async () => {
    const port25: MailHealthCheck = { id: "port25", level: "ok", inbox: true, code: "ok", params: { host: "mx.example.org" } };
    mockApi({ plan: PLAN, report: reportOf([...OK_AUTH, PTR_MISSING, port25, { id: "mta_sts", level: "info", inbox: false, code: "absent", params: {} }]) });
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByRole("status");
    const server = document.querySelector('[data-scope-section="server"]') as HTMLElement;
    const domain = document.querySelector('[data-scope-section="domain"]') as HTMLElement;
    expect(within(server).getByRole("heading", { name: "Servidor (vale para todos os projetos)" })).toBeInTheDocument();
    expect(within(domain).getByRole("heading", { name: `Domínio ${DOMAIN}` })).toBeInTheDocument();
    expect(Array.from(server.querySelectorAll("[data-check]")).map((e) => e.getAttribute("data-check"))).toEqual(["ptr", "port25"]);
    expect(Array.from(domain.querySelectorAll("[data-check]")).map((e) => e.getAttribute("data-check"))).toEqual(["spf", "dkim", "dmarc", "mta_sts"]);
    // o selo de cada nível vem do resumo do servidor
    expect(within(server).getAllByText("Atenção").length).toBeGreaterThan(0);
    expect(within(domain).queryByText("Atenção")).toBeNull();
    expect(row("ptr")).toHaveAttribute("data-scope", "server");
    expect(row("spf")).toHaveAttribute("data-scope", "domain");
  });
});

describe("O que fazer (expansível)", () => {
  it("abre e fecha: botão com aria-expanded e aria-controls, área só existe aberta", async () => {
    mockApi({ plan: PLAN, report: reportOf([PTR_MISSING]) });
    const user = userEvent.setup();
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByRole("status");
    const button = within(row("ptr")).getByRole("button", { name: "O que fazer" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(within(row("ptr")).queryByRole("region")).toBeNull();
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const region = within(row("ptr")).getByRole("region", { name: "Passos para: DNS reverso (PTR)" });
    expect(button.getAttribute("aria-controls")).toBe(region.id);
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(within(row("ptr")).queryByRole("region")).toBeNull();
  });

  it("funciona pelo teclado: Enter e Espaço abrem e fecham", async () => {
    mockApi({ plan: PLAN, report: reportOf([PTR_MISSING]) });
    const user = userEvent.setup();
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByRole("status");
    const button = within(row("ptr")).getByRole("button", { name: "O que fazer" });
    button.focus();
    await user.keyboard("{Enter}");
    expect(button).toHaveAttribute("aria-expanded", "true");
    await user.keyboard(" ");
    expect(button).toHaveAttribute("aria-expanded", "false");
    await user.keyboard(" ");
    expect(button).toHaveAttribute("aria-expanded", "true");
  });

  it("item em ordem não tem o botão (só o que precisa de ação ou é bônus)", async () => {
    mockApi({ plan: PLAN, report: reportOf([OK_AUTH[0]!, OK_AUTH[1]!, { id: "a", level: "ok", inbox: true, code: "ok", params: { host: HOST, ip: IP } }]) });
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByText(/Última verificação/);
    expect(screen.queryByRole("button", { name: "O que fazer" })).toBeNull();
  });

  it("PTR: é por IP e não por projeto, nome exato, valor atual, caminho da Contabo e genérico, e texto pronto com os dados da execução", async () => {
    mockApi({ plan: PLAN, report: reportOf([PTR_MISSING]) });
    const user = userEvent.setup();
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByRole("status");
    await user.click(within(row("ptr")).getByRole("button", { name: "O que fazer" }));
    const region = within(row("ptr")).getByRole("region");
    expect(within(region).getByText(/por IP do servidor, não por projeto nem por domínio/)).toBeInTheDocument();
    expect(within(region).getByText(new RegExp(`apontar para o nome ${HOST.replace(/\./g, "\\.")}`))).toBeInTheDocument();
    expect(within(region).getByText(/Customer Control Panel, abra o menu Reverse DNS Management/)).toBeInTheDocument();
    expect(within(region).getAllByText(/Reverse DNS/).length).toBeGreaterThanOrEqual(2);
    expect(within(region).getByText(/Gmail aceitou mensagens sem o PTR/)).toBeInTheDocument();
    expect(within(region).getByText(`Peço configurar o DNS reverso (PTR) do IP ${IP} para o nome ${HOST}.`)).toBeInTheDocument();
  });

  it("o texto copiável usa o IP e o nome que vieram do servidor (nada fixo no código)", async () => {
    const other = planFor("198.51.100.77", "mx.outro.example.org");
    mockApi({ plan: other, report: reportOf([{ ...PTR_MISSING, params: { ip: "198.51.100.77", expected: "mx.outro.example.org", current: "" }, expected: "mx.outro.example.org" }]) });
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByRole("status");
    await user.click(within(row("ptr")).getByRole("button", { name: "O que fazer" }));
    await user.click(within(row("ptr")).getByRole("button", { name: "Copiar Texto pronto para o suporte" }));
    expect(writeText).toHaveBeenCalledWith("Peço configurar o DNS reverso (PTR) do IP 198.51.100.77 para o nome mx.outro.example.org.");
    await user.click(within(row("ptr")).getByRole("button", { name: "Copiar Nome do DNS reverso" }));
    expect(writeText).toHaveBeenLastCalledWith("mx.outro.example.org");
    await user.click(within(row("ptr")).getByRole("button", { name: "Copiar IP do servidor" }));
    expect(writeText).toHaveBeenLastCalledWith("198.51.100.77");
  });

  it("bônus (MTA-STS e TLS-RPT): diz que é opcional, melhora a reputação e o ganho, com valores copiáveis", async () => {
    mockApi({
      plan: PLAN,
      report: reportOf([
        ...OK_AUTH,
        { id: "mta_sts", level: "info", inbox: false, code: "absent", params: {} },
        { id: "tls_rpt", level: "info", inbox: false, code: "absent", params: {} },
      ]),
    });
    const user = userEvent.setup();
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByText(/Última verificação/);
    await user.click(within(row("mta_sts")).getByRole("button", { name: "O que fazer" }));
    const sts = within(row("mta_sts")).getByRole("region");
    expect(within(sts).getByText("Opcional, melhora a reputação. Não é exigido e o envio funciona sem isto.")).toBeInTheDocument();
    expect(within(sts).getByText(/O que você ganha: quem envia para você passa a exigir conexão segura/)).toBeInTheDocument();
    expect(within(sts).getByText(`https://mta-sts.${DOMAIN}/.well-known/mta-sts.txt`)).toBeInTheDocument();
    expect(within(sts).getByText(`_mta-sts.${DOMAIN}`)).toBeInTheDocument();
    await user.click(within(row("tls_rpt")).getByRole("button", { name: "O que fazer" }));
    const rpt = within(row("tls_rpt")).getByRole("region");
    expect(within(rpt).getByText(/Opcional, melhora a reputação/)).toBeInTheDocument();
    expect(within(rpt).getByText(`v=TLSRPTv1; rua=mailto:postmaster@${DOMAIN}`)).toBeInTheDocument();
  });

  it("item com problema (SPF) leva o valor esperado para copiar", async () => {
    const spf: MailHealthCheck = { id: "spf", level: "critical", inbox: true, code: "missing", params: { domain: DOMAIN }, expected: `v=spf1 ip4:${IP} ~all`, found: [] };
    mockApi({ plan: PLAN, report: reportOf([spf]) });
    const user = userEvent.setup();
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByRole("alert");
    await user.click(within(row("spf")).getByRole("button", { name: "O que fazer" }));
    const region = within(row("spf")).getByRole("region");
    expect(within(region).getByRole("button", { name: "Copiar Valor" })).toBeInTheDocument();
    expect(within(region).getByText(`v=spf1 ip4:${IP} ~all`, { selector: "code" })).toBeInTheDocument();
    expect(within(region).queryByText(/Opcional/)).toBeNull();
  });
});

describe("próximo passo do DMARC (sugestão, não imposição)", () => {
  it("p=none em ordem: sugere quarentena só depois de semanas de relatórios, com o risco, e o valor novo copiável", async () => {
    mockApi({ plan: PLAN, report: reportOf(OK_AUTH) });
    const user = userEvent.setup();
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByText(/Última verificação/);
    // o DMARC está "Em ordem", e mesmo assim oferece o próximo passo opcional
    expect(row("dmarc")).toHaveAttribute("data-level", "ok");
    await user.click(within(row("dmarc")).getByRole("button", { name: "O que fazer" }));
    const region = within(row("dmarc")).getByRole("region");
    expect(within(region).getByText("Próximo passo, opcional e sem pressa.")).toBeInTheDocument();
    expect(within(region).getByText(/De 2 a 4 semanas lendo os relatórios|2 a 4 semanas lendo os relatórios/)).toBeInTheDocument();
    expect(within(region).getByText(/Risco: com quarantine, uma mensagem legítima que falhe/)).toBeInTheDocument();
    const current = region.querySelector('[data-copy="current"] code') as HTMLElement;
    const next = region.querySelector('[data-copy="value"] code') as HTMLElement;
    expect(current.textContent).toContain("p=none");
    expect(next.textContent).toContain("p=quarantine");
    expect(next.textContent).not.toContain("p=none");
    expect(next.textContent).toContain(`rua=mailto:postmaster@${DOMAIN}`);
  });

  it("p=quarantine em ordem: o próximo passo opcional é p=reject, com o risco", async () => {
    const q: MailHealthCheck = { ...OK_AUTH[2]!, code: "quarantine", found: [`v=DMARC1; p=quarantine; rua=mailto:postmaster@${DOMAIN}`] };
    mockApi({ plan: PLAN, report: reportOf([OK_AUTH[0]!, q]) });
    const user = userEvent.setup();
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByText(/Última verificação/);
    await user.click(within(row("dmarc")).getByRole("button", { name: "O que fazer" }));
    const region = within(row("dmarc")).getByRole("region");
    expect((region.querySelector('[data-copy="value"] code') as HTMLElement).textContent).toContain("p=reject");
    expect(within(region).getByText(/Risco: com reject/)).toBeInTheDocument();
  });

  it("p=reject em ordem: nada a sugerir", async () => {
    const r: MailHealthCheck = { ...OK_AUTH[2]!, code: "reject" };
    mockApi({ plan: PLAN, report: reportOf([r]) });
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByText(/Última verificação/);
    expect(screen.queryByRole("button", { name: "O que fazer" })).toBeNull();
  });
});

describe("em inglês", () => {
  it("o botão, os passos e o texto pronto do PTR saem em inglês", async () => {
    setLocale("en", { persist: false });
    mockApi({ plan: PLAN, report: reportOf([PTR_MISSING]) });
    const user = userEvent.setup();
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByRole("status");
    expect(screen.getByRole("heading", { name: "Server (applies to all projects)" })).toBeInTheDocument();
    await user.click(within(row("ptr")).getByRole("button", { name: "What to do" }));
    const region = within(row("ptr")).getByRole("region");
    expect(within(region).getByText(/per server IP, not per project or domain/)).toBeInTheDocument();
    expect(within(region).getByText(`Please set the reverse DNS (PTR) of IP ${IP} to the name ${HOST}.`)).toBeInTheDocument();
    expect(within(region).getByText(/Customer Control Panel, open the Reverse DNS Management menu/)).toBeInTheDocument();
  });
});

describe("Verificar agora: espera entre verificações", () => {
  it("depois de verificar, o botão fica desabilitado com a contagem e volta depois de 15 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockApi({ plan: PLAN, report: null }, { plan: PLAN, report: reportOf(OK_AUTH) });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    render(<DeliveryHealthCard domain={DOMAIN} />);
    await screen.findByText(/Ainda não verificado/);
    await user.click(screen.getByRole("button", { name: "Verificar a saúde agora" }));
    const waiting = await screen.findByRole("button", { name: "Aguarde 15 s" });
    expect(waiting).toBeDisabled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await screen.findByRole("button", { name: "Aguarde 10 s" })).toBeDisabled();
    await vi.advanceTimersByTimeAsync(10_500);
    expect(await screen.findByRole("button", { name: "Verificar a saúde agora" })).toBeEnabled();
  });
});

describe("nenhum endereço real no código", () => {
  const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
  const SAFE = /^(?:203\.0\.113\.|198\.51\.100\.|192\.0\.2\.)/;

  it("os textos de e-mail não trazem IP escrito (só os valores que o servidor manda na hora)", () => {
    for (const locale of Object.keys(catalog)) {
      const dict = catalog[locale]!.mailHealth as unknown as Record<string, string>;
      for (const [key, text] of Object.entries(dict)) {
        const hits = (text.match(IPV4) ?? []).filter((ip) => !SAFE.test(ip));
        expect(hits, `${locale}.mailHealth.${key}`).toEqual([]);
      }
    }
  });

  it("o código do 'O que fazer' e do resumo do projeto não traz IP nem domínio fixo", () => {
    const files = [
      "src/lib/mail-health-howto.ts",
      "src/components/mail/HealthHowTo.tsx",
      "src/components/mail/useDeliveryHealth.ts",
      "src/components/project/ProjectEmailHealth.tsx",
    ];
    for (const file of files) {
      const text = readFileSync(join(process.cwd(), file), "utf8");
      expect((text.match(IPV4) ?? []).filter((ip) => !SAFE.test(ip)), file).toEqual([]);
      // domínio escrito no código: só os de documentação
      const domains = (text.match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|dev|br)\b/g) ?? []).filter((d) => !/(^|\.)example\.(com|net|org)$/.test(d));
      expect(domains, file).toEqual([]);
    }
  });
});
