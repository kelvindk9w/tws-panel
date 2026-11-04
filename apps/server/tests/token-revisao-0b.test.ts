/**
 * token-revisao-0b.test.ts — regressões do veredito da revisão da Fase 0b (ataques R1–R7).
 * Cada teste falharia sem a correção correspondente. Painel real, sem Docker, sem rede.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PASSWORD, startRealPanel, type RealPanel } from "./helpers/real-panel.js";

vi.mock("../src/services/docker-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/docker-service.js")>()),
  listContainers: async () => [],
}));
vi.mock("node:dns/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:dns/promises")>();
  const resolve4 = async () => {
    throw Object.assign(new Error("sem DNS nos testes"), { code: "ENOTFOUND" });
  };
  return { ...real, resolve4, default: { ...(real as unknown as { default: object }).default, resolve4 } };
});

let panel: RealPanel;
let A = "";
let tWriteA = "";
let tAdminA = "";
let tAdminAC = "";
let tPanel = "";
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const human = () => ({ cookie: panel.cookie });
const FAKE = { username: "x-access-token", token: "FAKE-NAO-REAL" };

beforeAll(async () => {
  panel = await startRealPanel();
  A = await panel.createProject("Fazenda", "fazenda.example.com");
  await panel.createProject("Loja", "loja.example.com");
  tWriteA = (await panel.createToken({ name: "w-a", scope: "write", reach: "projects", projects: [A] })).token;
  tAdminA = (await panel.createToken({ name: "adm-a", scope: "admin", reach: "projects", projects: [A] })).token;
  tAdminAC = (await panel.createToken({ name: "adm-ac", scope: "admin", reach: "projects", projects: [A], canCreate: true })).token;
  tPanel = (await panel.createToken({ name: "painel", scope: "admin", reach: "panel" })).token;
}, 120_000);
afterAll(async () => panel.close());

describe("1. guardrailOverride é só da pessoa", () => {
  it.each([
    ["escrita limitada", () => tWriteA],
    ["admin limitado", () => tAdminA],
    ["painel inteiro", () => tPanel],
  ])("token %s recebe 403 no formato da Fase 0", async (_n, get) => {
    const res = await panel.app.inject({ method: "POST", url: `/api/projects/${A}/deploy`, headers: bearer(get()), payload: { guardrailOverride: true } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("token_forbidden");
  });
  it("sem o override (ou false) o token segue o caminho normal; a sessão humana também pode pedir", async () => {
    for (const payload of [{}, { guardrailOverride: false }]) {
      const res = await panel.app.inject({ method: "POST", url: `/api/projects/${A}/deploy`, headers: bearer(tWriteA), payload });
      expect(res.statusCode).not.toBe(403);
    }
    const h = await panel.app.inject({ method: "POST", url: `/api/projects/${A}/deploy`, headers: human(), payload: { guardrailOverride: true } });
    expect(h.statusCode).not.toBe(403);
  });
});

describe("2. projeto criado por token limitado não usa a conta GitHub conectada", () => {
  async function create(token: string, name: string, domain: string) {
    return panel.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: bearer(token),
      payload: { name, ingestMode: "git", source: "https://github.com/outra-conta/repo-privado.git", domain, backup: false },
    });
  }
  function accountHas() {
    const svc = panel.app.deployService as unknown as { credentials: { get(k: string): Promise<unknown> } };
    return vi.spyOn(svc.credentials, "get").mockImplementation(async (k: string) => (k === "integration:github" ? FAKE : null));
  }
  it("a marca persiste e o clone não usa a credencial da conta; o de painel inteiro continua usando", async () => {
    const res = await create(tAdminAC, "Espiao", "espiao.example.com");
    expect(res.statusCode).toBe(201);
    const project = res.json().project;
    expect(project.noAccountCredential).toBe(true);
    const spy = accountHas();
    expect(await panel.app.deployService.credentialFor(project)).toBeNull();
    const whole = await create(tPanel, "Inteiro", "inteiro.example.com");
    expect(whole.json().project.noAccountCredential).toBeUndefined();
    expect(await panel.app.deployService.credentialFor(whole.json().project)).toEqual(FAKE);
    spy.mockRestore();
  });
  it("a credencial PRÓPRIA do projeto (posta pela pessoa) continua valendo", async () => {
    const res = await create(tAdminAC, "Proprio", "proprio.example.com");
    const project = res.json().project;
    const svc = panel.app.deployService as unknown as { credentials: { get(k: string): Promise<unknown> } };
    const spy = vi.spyOn(svc.credentials, "get").mockImplementation(async (k: string) => (k === project.id ? FAKE : null));
    expect(await panel.app.deployService.credentialFor(project)).toEqual(FAKE);
    spy.mockRestore();
  });
  it("a pessoa libera com senha; token (qualquer) não pode liberar nem trocar a fonte", async () => {
    const res = await create(tAdminAC, "Liberado", "liberado.example.com");
    const id = res.json().project.id as string;
    const url = `/api/projects/${id}/account-credential`;
    for (const t of [tAdminAC, tPanel]) {
      const r = await panel.app.inject({ method: "PUT", url, headers: bearer(t), payload: { allow: true, currentPassword: PASSWORD } });
      expect(r.statusCode).toBe(403);
    }
    const src = await panel.app.inject({ method: "PATCH", url: `/api/projects/${id}`, headers: bearer(tAdminAC), payload: { source: "https://example.com/y.git" } });
    expect(src.statusCode).toBe(403);
    const sem = await panel.app.inject({ method: "PUT", url, headers: human(), payload: { allow: true } });
    expect(sem.statusCode).toBe(401);
    const errada = await panel.app.inject({ method: "PUT", url, headers: human(), payload: { allow: true, currentPassword: "errada-errada" } });
    expect(errada.statusCode).toBe(401);
    expect((await panel.app.deployService.getProject(id))!.noAccountCredential).toBe(true);
    const ok = await panel.app.inject({ method: "PUT", url, headers: human(), payload: { allow: true, currentPassword: PASSWORD } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().project.noAccountCredential).toBeUndefined();
    const spy = accountHas();
    expect(await panel.app.deployService.credentialFor((await panel.app.deployService.getProject(id))!)).toEqual(FAKE);
    const back = await panel.app.inject({ method: "PUT", url, headers: human(), payload: { allow: false } });
    expect(back.statusCode).toBe(200);
    expect(back.json().project.noAccountCredential).toBe(true);
    expect(await panel.app.deployService.credentialFor((await panel.app.deployService.getProject(id))!)).toBeNull();
    spy.mockRestore();
    const audit = await panel.app.inject({ method: "GET", url: "/api/audit", headers: human() });
    expect(audit.body).toContain("project.account_credential");
  });
  it("projeto que não existe: 404", async () => {
    const r = await panel.app.inject({ method: "PUT", url: "/api/projects/ffffffffffffffff/account-credential", headers: human(), payload: { allow: false } });
    expect(r.statusCode).toBe(404);
  });
});

describe("3. apelido não sequestra o alcance quando a limpeza da lista falha", () => {
  it("DELETE falha alto (500 com código) e o id antigo não alcança projeto novo com o mesmo nome", async () => {
    const C = await panel.createProject("Cevada", "cevada.example.com");
    const t = (await panel.createToken({ name: "so-c", scope: "read", reach: "projects", projects: [C] })).token;
    const spy = vi.spyOn(panel.app.apiTokens, "forgetProject").mockRejectedValueOnce(new Error("disco cheio"));
    const del = await panel.app.inject({ method: "DELETE", url: `/api/projects/${C}`, headers: human() });
    spy.mockRestore();
    expect(del.statusCode).toBe(500);
    expect(del.json().error).toBe("token_lists_not_updated");
    expect(await panel.app.deployService.getProject(C)).toBeNull();
    const D = await panel.createProject(C, "dourado.example.com");
    const got = await panel.app.inject({ method: "GET", url: `/api/projects/${C}`, headers: bearer(t) });
    expect(got.statusCode).toBe(404);
    const miss = await panel.app.inject({ method: "GET", url: `/api/projects/ffffffffffffffff`, headers: bearer(t) });
    expect(got.body).toBe(miss.body);
    const list = await panel.app.inject({ method: "GET", url: `/api/projects`, headers: bearer(t) });
    expect(list.body).not.toContain(D);
    const pts = await panel.app.inject({ method: "GET", url: `/api/backups/targets/project:${C}/points`, headers: bearer(t) });
    expect(pts.statusCode).toBe(404);
  });
});

describe("5. nome livre e nome ocupado dão o mesmo tipo de apelido", () => {
  it("criar com o nome de projeto fora do alcance não denuncia por sufixo", async () => {
    const mk = (name: string, domain: string) =>
      panel.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: bearer(tAdminAC),
        payload: { name, ingestMode: "git", source: "https://example.com/x.git", domain, backup: false },
      });
    const taken = (await mk("Loja", "loja2.example.com")).json().project.slug as string;
    const free = (await mk("Nomelivre", "livre.example.com")).json().project.slug as string;
    expect(taken).toMatch(/^loja-[0-9a-f]{4}$/);
    expect(free).toMatch(/^nomelivre-[0-9a-f]{4}$/);
  });
});

describe("7. token limitado não apaga projeto; 'pode criar' só com administração", () => {
  it("DELETE por token limitado dá 403; painel inteiro admin continua podendo", async () => {
    const E = await panel.createProject("Estufa", "estufa.example.com");
    const t = (await panel.createToken({ name: "adm-e", scope: "admin", reach: "projects", projects: [E] })).token;
    const res = await panel.app.inject({ method: "DELETE", url: `/api/projects/${E}?deleteSource=true`, headers: bearer(t) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("token_forbidden");
    expect(await panel.app.deployService.getProject(E)).not.toBeNull();
    const whole = await panel.app.inject({ method: "DELETE", url: `/api/projects/${E}`, headers: bearer(tPanel) });
    expect(whole.statusCode).toBe(200);
  });
  it.each(["read", "write"])("criar token com escopo %s e 'pode criar' é recusado (400) antes da senha", async (scope) => {
    const r = await panel.createToken({ name: `cc-${scope}`, scope, reach: "projects", projects: [A], canCreate: true, currentPassword: "nem-chega-a-conferir" });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("invalid_token_reach");
  });
  it("editar o alcance de token sem administração para ligar 'pode criar' é recusado", async () => {
    const t = await panel.createToken({ name: "so-w", scope: "write", reach: "projects", projects: [A] });
    const r = await panel.app.inject({ method: "PATCH", url: `/api/settings/api-tokens/${t.id}`, headers: human(), payload: { projects: [A], canCreate: true, currentPassword: PASSWORD } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("invalid_token_reach");
  });
});

describe("6. editar o alcance não apaga o que o token criou durante a edição", () => {
  it("projeto registrado entre a leitura e a gravação: 409, nada some", async () => {
    const X = await panel.createProject("Xingu", "xingu.example.com");
    const Y = await panel.createProject("Yara", "yara.example.com");
    const Z = await panel.createProject("Zebra", "zebra.example.com");
    const t = await panel.createToken({ name: "corrida", scope: "admin", reach: "projects", projects: [X], canCreate: true });
    const real = panel.app.userStore.findById.bind(panel.app.userStore);
    const spy = vi.spyOn(panel.app.userStore, "findById").mockImplementationOnce(async (id: string) => {
      expect(await panel.app.apiTokens.addProject(t.id, Z)).toBe(true);
      return real(id);
    });
    const r = await panel.app.inject({ method: "PATCH", url: `/api/settings/api-tokens/${t.id}`, headers: human(), payload: { projects: [X, Y], canCreate: true, currentPassword: PASSWORD } });
    spy.mockRestore();
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("token_reach_changed");
    const now = (await panel.app.apiTokens.list()).find((i) => i.id === t.id)!;
    expect([...now.projects].sort()).toEqual([X, Z].sort());
    const again = await panel.app.inject({ method: "PATCH", url: `/api/settings/api-tokens/${t.id}`, headers: human(), payload: { projects: [X, Y, Z], canCreate: true, currentPassword: PASSWORD } });
    expect(again.statusCode).toBe(200);
  });
  it("quando o cliente informa a lista que viu (basedOn), lista desatualizada dá 409 mesmo sem corrida", async () => {
    const P = await panel.createProject("Pampa", "pampa.example.com");
    const Q = await panel.createProject("Quati", "quati.example.com");
    const t = await panel.createToken({ name: "defasada", scope: "admin", reach: "projects", projects: [P], canCreate: true });
    await panel.app.apiTokens.addProject(t.id, Q);
    const r = await panel.app.inject({ method: "PATCH", url: `/api/settings/api-tokens/${t.id}`, headers: human(), payload: { projects: [P], canCreate: true, basedOn: [P] } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("token_reach_changed");
    const ok = await panel.app.inject({ method: "PATCH", url: `/api/settings/api-tokens/${t.id}`, headers: human(), payload: { projects: [P], canCreate: true, basedOn: [P, Q] } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().info.projects).toEqual([P]);
  });
});
