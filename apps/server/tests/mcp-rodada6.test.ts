/**
 * mcp-rodada6.test.ts — cota de certificados só no sucesso e com subcota por token; ações aprovadas e leituras de
 * segredo protegidas na Auditoria; a tela (arquivo ativo) com as mesmas cotas; bordas do escape.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PASSWORD, startRealPanel, type RealPanel } from "./helpers/real-panel.js";
import { McpSession, enableMcp } from "./helpers/mcp-client.js";
import { AUDIT_SECRET_READS_PER_TOKEN, AuditService, isHumanQuota, trimArchive } from "../src/services/audit-service.js";
import { visibleValue } from "../src/services/mcp-tools.js";

vi.mock("../src/services/docker-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/docker-service.js")>()),
  listContainers: async () => [],
}));

let panel: RealPanel;
let A = "";
const human = () => ({ cookie: panel.cookie });
const put = (payload: Record<string, number>) => panel.app.inject({ method: "PUT", url: "/api/settings/dynamic-domains", headers: human(), payload });
const personAdds = (domain: string, pair = false) =>
  panel.app.inject({ method: "POST", url: `/api/projects/${A}/domains`, headers: human(), payload: { domain, pair } });

async function tokenSession(name: string, extra: Record<string, unknown> = {}) {
  const t = await panel.createToken({ name, scope: "admin", reach: "panel", ...extra });
  expect(t.status, JSON.stringify(t.json)).toBe(201);
  const s = new McpSession(panel.app, t.token);
  await s.initialize("c");
  return s;
}

beforeAll(async () => {
  panel = await startRealPanel();
  A = await panel.createProject("Fazenda", "fazenda.example.com");
  expect(await enableMcp(panel)).toBe(200);
}, 120_000);
afterAll(async () => panel.close());
// cada teste começa com a cota de certificados vazia
beforeEach(() => {
  const dd = panel.app.dynamicDomains as unknown as { grants: number[]; weekly: Map<string, number[]>; tokenGrants: Map<string, number[]> };
  dd.grants = [];
  dd.weekly.clear();
  dd.tokenGrants.clear();
});

describe("cota de certificados: só no sucesso", () => {
  it("cadastros inválidos, nome em uso e erros não gastam a cota: o válido da pessoa passa", async () => {
    const s = await tokenSession("invalidos");
    for (let i = 0; i < 25; i++) {
      const ruim = await s.tool("add_domain", { projectId: A, domain: `x${i}..invalido`, pair: false });
      expect(ruim.data.error, `${i}`).toBe("invalid_domain");
    }
    // nome já em uso e projeto inexistente também não gastam
    for (let i = 0; i < 25; i++) expect((await s.tool("add_domain", { projectId: A, domain: "fazenda.example.com", pair: false })).data.error).toBe("domain_in_use");
    for (let i = 0; i < 25; i++) expect((await s.tool("add_domain", { projectId: "ffffffffffffffff", domain: "nada.example.org" })).isError).toBe(true);
    const ok = await personAdds("loja.example.org");
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("se o cadastro falha depois de reservar, a reserva volta", async () => {
    expect((await put({ maxIssuancesPerHour: 2 })).statusCode).toBe(200);
    try {
      const svc = panel.app.deployService as unknown as { saveProjects(): Promise<void> };
      const spy = vi.spyOn(svc, "saveProjects").mockRejectedValueOnce(new Error("disco cheio"));
      const falha = await personAdds("falha-r6.example.net");
      expect(falha.statusCode).toBe(500);
      spy.mockRestore();
      expect((await personAdds("depois1-r6.example.net")).statusCode).toBe(200);
      expect((await personAdds("depois2-r6.example.org")).statusCode).toBe(200);
      const cheia = await personAdds("depois3-r6.example.com");
      expect(cheia.statusCode).toBe(429);
      expect(cheia.json().error).toBe("hourly_limit");
    } finally {
      await put({ maxIssuancesPerHour: 100 });
    }
  });

  it("o par www custa 2 emissões; sem par, 1; nome que não gera certificado (localhost) não custa nada", async () => {
    const spy = vi.spyOn(panel.app.dynamicDomains, "reserveManual");
    try {
      expect((await personAdds("par-r6.io", true)).statusCode).toBe(200);
      expect(spy).toHaveBeenLastCalledWith("par-r6.io", 2, undefined);
      expect((await personAdds("sem-par-r6.io", false)).statusCode).toBe(200);
      expect(spy).toHaveBeenLastCalledWith("sem-par-r6.io", 1, undefined);
      const calls = spy.mock.calls.length;
      expect((await personAdds("app-r6.localhost", true)).statusCode).toBe(200);
      expect(spy.mock.calls.length).toBe(calls);
    } finally {
      spy.mockRestore();
    }
  });

  it("estado dos domínios dinâmicos ilegível: o cadastro é recusado com mensagem clara e a cota não é reservada nem gravada", async () => {
    const ready = vi.spyOn(panel.app.dynamicDomains, "ensureReady").mockRejectedValueOnce(new Error("ilegível"));
    const spy = vi.spyOn(panel.app.dynamicDomains, "reserveManual");
    try {
      const res = await personAdds("ilegivel-r6.example.io");
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("quota_state_unreadable");
      expect(res.json().message).toMatch(/ilegível/);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      ready.mockRestore();
      spy.mockRestore();
    }
  });

  it("a subcota de um token (metade) trava o token, e a pessoa ainda cadastra", async () => {
    expect((await put({ maxIssuancesPerHour: 4 })).statusCode).toBe(200);
    try {
      const s = await tokenSession("subcota");
      expect((await s.tool("add_domain", { projectId: A, domain: "a-r6.example.dev", pair: false })).isError).toBe(false);
      expect((await s.tool("add_domain", { projectId: A, domain: "b-r6.example.app", pair: false })).isError).toBe(false);
      const barrado = await s.tool("add_domain", { projectId: A, domain: "c-r6.example.page", pair: false });
      expect(barrado.data).toMatchObject({ status: 429, error: "hourly_limit" });
      // restam 2 na cota global: a pessoa passa
      expect((await personAdds("pessoa-r6.example.xyz")).statusCode).toBe(200);
    } finally {
      await put({ maxIssuancesPerHour: 100 });
    }
  });

  it("o teto semanal por domínio registrável vale, e a subcota semanal do token também", async () => {
    expect((await put({ maxIssuancesPerWeekPerDomain: 2 })).statusCode).toBe(200);
    try {
      const s = await tokenSession("semanal");
      expect((await s.tool("add_domain", { projectId: A, domain: "um.semanal-r6.com.br", pair: false })).isError).toBe(false);
      expect((await s.tool("add_domain", { projectId: A, domain: "dois.semanal-r6.com.br", pair: false })).data).toMatchObject({ status: 429, error: "weekly_limit" });
      expect((await personAdds("tres.semanal-r6.com.br")).statusCode).toBe(200);
      expect((await personAdds("quatro.semanal-r6.com.br")).json().error).toBe("weekly_limit");
    } finally {
      await put({ maxIssuancesPerWeekPerDomain: 49 });
    }
  });

  it("projeto criado por token também gasta a cota, e a devolve se a criação falhar", async () => {
    const s = await tokenSession("cria-r6", { reach: "projects", projects: [A], canCreate: true });
    const svc = panel.app.deployService as unknown as { saveProjects(): Promise<void> };
    const spy = vi.spyOn(panel.app.dynamicDomains, "reserveManual");
    const falha = vi.spyOn(svc, "saveProjects").mockRejectedValueOnce(new Error("disco cheio"));
    const ruim = await s.tool("create_project", { name: "Falha", source: "https://example.com/falha.git", domain: "falha-r6.example.co" });
    falha.mockRestore();
    expect(ruim.isError).toBe(true);
    const ok = await s.tool("create_project", { name: "Certo", source: "https://example.com/certo.git", domain: "certo-r6.example.co" });
    expect(ok.isError, JSON.stringify(ok.data)).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe("cota de certificados: ajustes finais", () => {
  it("nomes sob a base das aplicações pagam cota como qualquer outro (cada nome tem o seu certificado); IP e .localhost não", async () => {
    expect((await put({ maxIssuancesPerWeekPerDomain: 1 })).statusCode).toBe(200);
    const status = vi.spyOn(panel.app.appsDomainService, "status").mockResolvedValue({ base: "apps-r7.example.org" } as never);
    try {
      expect((await personAdds("a.apps-r7.example.org")).statusCode).toBe(200);
      const barrado = await personAdds("b.apps-r7.example.org");
      expect(barrado.statusCode).toBe(429);
      expect(barrado.json().error).toBe("weekly_limit");
      expect((await personAdds("c-r7.localhost")).statusCode).toBe(200);
      expect((await personAdds("d-r7.localhost")).statusCode).toBe(200);
    } finally {
      status.mockRestore();
      await put({ maxIssuancesPerWeekPerDomain: 49 });
    }
  });

  it("dois cadastros simultâneos do mesmo nome, em projetos diferentes: um entra, o outro leva 409 e a cota dele volta", async () => {
    const B = await panel.createProject("Loja", "loja-r7.example.com");
    const svc = panel.app.deployService as unknown as { reserveDomainQuota(...args: unknown[]): Promise<() => void> };
    const original = svc.reserveDomainQuota.bind(svc);
    const spy = vi.spyOn(svc, "reserveDomainQuota").mockImplementation(async (...args: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, 30)); // as duas validações passam antes de qualquer gravação
      return original(...args);
    });
    try {
      const add = (id: string) => panel.app.inject({ method: "POST", url: `/api/projects/${id}/domains`, headers: human(), payload: { domain: "corrida-r7.example.net", pair: false } });
      const [x, y] = await Promise.all([add(A), add(B)]);
      expect([x.statusCode, y.statusCode].sort()).toEqual([200, 409]);
      const dd = panel.app.dynamicDomains as unknown as { grants: number[] };
      expect(dd.grants).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("se a falha vem depois de gravar o domínio (aplicação do proxy), a cota NÃO volta; antes de gravar, volta", async () => {
    expect((await put({ maxIssuancesPerHour: 2 })).statusCode).toBe(200);
    const svc = panel.app.deployService as unknown as { applyProxy(): Promise<void> };
    const spy = vi.spyOn(svc, "applyProxy").mockRejectedValueOnce(new Error("caddy fora"));
    try {
      const falha = await personAdds("gravado-r7.example.net");
      expect(falha.statusCode).toBe(500);
      const dd = panel.app.dynamicDomains as unknown as { grants: number[] };
      expect(dd.grants).toHaveLength(1); // o domínio ficou gravado: a emissão sai na próxima aplicação
      expect((await personAdds("outro1-r7.example.net")).statusCode).toBe(200);
      expect((await personAdds("outro2-r7.example.net")).statusCode).toBe(429);
    } finally {
      spy.mockRestore();
      await put({ maxIssuancesPerHour: 100 });
    }
  });
});

describe("Auditoria: ações aprovadas e leituras de segredo", () => {
  it("leitura de segredo nunca cai na cota humana, nem quando o ator é uma pessoa", () => {
    const leitura = { id: "1", at: "2026-10-26T00:00:00Z", actor: "kelvin", action: "mcp.secret_read", target: null, detail: "" };
    expect(isHumanQuota(leitura)).toBe(false);
    const humanos = Array.from({ length: 5 }, (_, i) => ({ ...leitura, id: `h${i}`, action: "auth.login" }));
    const lidas = Array.from({ length: 30 }, (_, i) => ({ ...leitura, id: `r${i}` }));
    const cortadas = trimArchive([...humanos, ...lidas], 5);
    expect(cortadas.filter((e) => e.action === "auth.login")).toHaveLength(5);
  });

  const entry = (id: number, action: string, actor: string) => ({ id: String(id), at: "2026-10-26T00:00:00Z", actor, action, target: null, detail: "" });

  it("o ator setup-token cai na cota de token; ação aprovada cai na cota humana", () => {
    expect(isHumanQuota(entry(1, "project.updated", "setup-token"))).toBe(false);
    expect(isHumanQuota(entry(2, "project.updated", "token:ia"))).toBe(false);
    expect(isHumanQuota(entry(3, "project.updated", "kelvin"))).toBe(true);
    expect(isHumanQuota(entry(4, "mcp.tool_approved", "token:ia"))).toBe(true);
    const humano = [entry(1, "auth.login", "kelvin")];
    const setup = Array.from({ length: 30 }, (_, i) => entry(10 + i, "project.updated", "setup-token"));
    const cortadas = trimArchive([...humano, ...setup], 20);
    expect(cortadas.filter((e) => e.actor === "setup-token")).toHaveLength(10);
    expect(cortadas[0]!.id).toBe("1");
  });

  it("as últimas N leituras de segredo de cada token ficam protegidas; o excesso de um token não tira o de outro", () => {
    const leituras = [
      ...Array.from({ length: AUDIT_SECRET_READS_PER_TOKEN + 100 }, (_, i) => entry(i, "mcp.secret_read", "token:a")),
      entry(9_000, "mcp.secret_read", "token:b"),
    ];
    const ruido = Array.from({ length: 30 }, (_, i) => entry(10_000 + i, "mcp.tool_call", "token:a"));
    const cortadas = trimArchive([...leituras, ...ruido], 20);
    const doA = cortadas.filter((e) => e.actor === "token:a" && e.action === "mcp.secret_read");
    expect(doA).toHaveLength(AUDIT_SECRET_READS_PER_TOKEN);
    expect(doA[0]!.id).toBe("100"); // as 100 mais antigas saíram
    expect(cortadas.some((e) => e.actor === "token:b")).toBe(true);
    // as leituras não competem com a cota de token (o ruído é cortado a 10 do teto 20)
    expect(cortadas.filter((e) => e.action === "mcp.tool_call")).toHaveLength(10);
  });

  it("ação aprovada por uma pessoa é gravada como mcp.tool_approved e nunca se agrega; a dispensa do token é agregada", async () => {
    const t = await panel.createToken({ name: "aprovada", scope: "write", reach: "projects", projects: [A] });
    const s = new McpSession(panel.app, t.token);
    await s.initialize("c");
    for (let i = 0; i < 2; i++) {
      const args = { projectId: A, vars: [{ key: "APROVADA_R6", value: `v${i}` }] };
      const pedido = await s.tool("set_env_vars", args);
      const dec = await panel.app.inject({ method: "POST", url: `/api/mcp/approvals/${pedido.data.approvalId}/approve`, headers: human(), payload: { currentPassword: PASSWORD } });
      expect(dec.statusCode).toBe(200);
      expect((await s.tool("set_env_vars", { ...args, approvalId: pedido.data.approvalId })).isError).toBe(false);
    }
    const lista = async (actor: string, action: string) =>
      ((await panel.app.inject({ method: "GET", url: "/api/audit?perPage=200", headers: human() })).json().entries as { action: string; actor: string }[]).filter((e) => e.actor === actor && e.action === action).length;
    expect(await lista("token:aprovada", "mcp.tool_approved")).toBe(2);
    expect(await lista("token:aprovada", "mcp.tool_changed")).toBe(0);

    const livre = await tokenSession("dispensa-r6", { mcp: { skipApproval: true } });
    for (let i = 0; i < 4; i++) expect((await livre.tool("set_env_vars", { projectId: A, vars: [{ key: "LIVRE_R6", value: `v${i}` }] })).isError).toBe(false);
    // uma entrada + a contagem das 3 repetidas (a leitura da Auditoria a descarrega)
    expect(await lista("token:dispensa-r6", "mcp.tool_changed")).toBe(2);
    expect(await lista("token:dispensa-r6", "mcp.tool_approved")).toBe(0);
  });
});

describe("a tela da Auditoria (arquivo ativo) tem as mesmas cotas", () => {
  it("2 mil escritas de um token não tiram da lista o login humano mais antigo", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paas-audit-r6-"));
    try {
      const audit = new AuditService(dir, { maxEntries: 20, maxArchivedEntries: 100 });
      await audit.record({ actor: "kelvin", action: "auth.login", detail: "login antigo" });
      await audit.record({ actor: "kelvin", action: "mcp.enabled", detail: "ligou" });
      for (let i = 0; i < 60; i++) await audit.record({ actor: "token:ia", action: "project.updated", detail: `renomeou ${i}` });
      const tela = (await audit.list(1, 200)).entries;
      expect(tela.some((e) => e.action === "auth.login")).toBe(true);
      expect(tela.some((e) => e.action === "mcp.enabled")).toBe(true);
      expect(tela.filter((e) => e.actor === "token:ia").length).toBeLessThanOrEqual(10);
      expect(tela[0]!.detail).toBe("renomeou 59");
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe("escape: borda do aviso ×N", () => {
  it("até 3 repetições aparecem uma a uma; a partir de 4 viram ×N", () => {
    expect(visibleValue("a   b")).toBe("a\\u{a0}\\u{a0}\\u{a0}b");
    expect(visibleValue("a    b")).toBe("a\\u{a0}×4b");
  });
});
