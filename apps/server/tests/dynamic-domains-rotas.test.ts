/**
 * Domínios dinâmicos — rotas com o painel REAL: o que o token "domínios deste
 * projeto" alcança (e só isso), fora do alcance = 404 idêntico, o que só a
 * pessoa muda (sufixos, tetos), conflito sem pista, nome único entre sites
 * fixos e dinâmicos, página Certificados e projeto apagado.
 * Sem Docker e sem rede.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PASSWORD, startRealPanel, type RealPanel } from "./helpers/real-panel.js";

vi.mock("../src/services/docker-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/docker-service.js")>()),
  listContainers: async () => [],
}));

const MISSING = "0000000000000000";
let panel: RealPanel;
let A = "";
let B = "";
let tokenW = ""; // domínios de A, escrita
let tokenWId = "";
let tokenR = ""; // domínios de A, leitura
let tokenAdminA = ""; // projetos: A, admin
let tokenWriteA = ""; // projetos: A, write
let tokenPanelAdmin = "";

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const human = () => ({ cookie: panel.cookie });
const url = (id: string, rest = "") => `/api/projects/${id}/dynamic-domains${rest}`;
const call = (method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH", path: string, headers: Record<string, string>, payload?: unknown) =>
  panel.app.inject({ method, url: path, headers, ...(payload === undefined ? {} : { payload: payload as object }) });

beforeAll(async () => {
  panel = await startRealPanel();
  A = await panel.createProject("Saas", "saas.example.com");
  B = await panel.createProject("Loja", "loja.example.com");
  const w = await panel.createToken({ name: "saas-dominios", scope: "write", reach: "domains", projects: [A] });
  tokenW = w.token;
  tokenWId = w.id;
  tokenR = (await panel.createToken({ name: "saas-leitura", scope: "read", reach: "domains", projects: [A] })).token;
  tokenAdminA = (await panel.createToken({ name: "admin-a", scope: "admin", reach: "projects", projects: [A] })).token;
  tokenWriteA = (await panel.createToken({ name: "write-a", scope: "write", reach: "projects", projects: [A] })).token;
  tokenPanelAdmin = (await panel.createToken({ name: "painel", scope: "admin", reach: "panel" })).token;
}, 120_000);

afterAll(async () => panel.close());

describe("criação do token de domínios (só a pessoa, com a senha)", () => {
  const create = (payload: Record<string, unknown>) =>
    call("POST", "/api/settings/api-tokens", human(), { name: "novo", scope: "write", currentPassword: PASSWORD, ...payload });

  it("aparece na lista com o alcance 'domains'", async () => {
    const list = (await call("GET", "/api/settings/api-tokens", human())).json().tokens as Array<Record<string, unknown>>;
    expect(list.find((t) => t.id === tokenWId)).toMatchObject({ reach: "domains", scope: "write", projects: [A], canCreate: false });
  });

  it.each([
    ["sem projeto", () => ({ reach: "domains", projects: [] })],
    ["sem lista", () => ({ reach: "domains" })],
    ["pode criar", () => ({ reach: "domains", projects: [A], canCreate: true })],
    ["nível admin", () => ({ reach: "domains", projects: [A], scope: "admin" })],
    ["projeto inexistente", () => ({ reach: "domains", projects: [A, MISSING] })],
  ])("recusa %s", async (_label, payload) => {
    const res = await create(payload());
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_token_reach");
  });

  it("exige a senha atual", async () => {
    const res = await create({ reach: "domains", projects: [A], currentPassword: "errada" });
    expect(res.statusCode).toBe(401);
  });

  it("um token nunca cria outro token", async () => {
    const res = await call("POST", "/api/settings/api-tokens", bearer(tokenW), { name: "x", scope: "read", currentPassword: PASSWORD, reach: "domains", projects: [A] });
    expect(res.statusCode).toBe(403);
  });

  it("editar: tirar projeto vale sem senha; acrescentar pede a senha; 'pode criar' nunca", async () => {
    const made = await create({ name: "editavel", reach: "domains", projects: [A] });
    const id = made.json().info.id as string;
    try {
      const patch = (payload: Record<string, unknown>) => call("PATCH", `/api/settings/api-tokens/${id}`, human(), payload);
      expect((await patch({ projects: [A, B], canCreate: false })).statusCode).toBe(401);
      const widened = await patch({ projects: [A, B], canCreate: false, currentPassword: PASSWORD });
      expect(widened.statusCode).toBe(200);
      expect(widened.json().info).toMatchObject({ reach: "domains", projects: [A, B], canCreate: false });
      const bad = await patch({ projects: [A, B], canCreate: true, currentPassword: PASSWORD });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toBe("invalid_token_reach");
      const narrowed = await patch({ projects: [A], canCreate: false });
      expect(narrowed.statusCode).toBe(200);
      expect(narrowed.json().info.projects).toEqual([A]);
      expect((await patch({ projects: [], canCreate: false })).statusCode).toBe(400);
    } finally {
      await call("DELETE", `/api/settings/api-tokens/${id}`, human());
    }
  });
});

describe("o que o token de domínios faz no projeto dele", () => {
  it("cadastra (201), repete (200), consulta, lista e remove — tudo registrado como o token", async () => {
    const add = await call("POST", url(A), bearer(tokenW), { host: "Cliente1.Escola.Example" });
    expect(add.statusCode).toBe(201);
    expect(add.json().item).toMatchObject({ host: "cliente1.escola.example", state: "waiting", addedBy: "token:saas-dominios", via: "own" });
    expect((await call("POST", url(A), bearer(tokenW), { host: "cliente1.escola.example" })).statusCode).toBe(200);

    const one = await call("GET", url(A, "/cliente1.escola.example"), bearer(tokenW));
    expect(one.statusCode).toBe(200);
    expect(one.json().item.host).toBe("cliente1.escola.example");

    const list = (await call("GET", url(A), bearer(tokenW))).json();
    expect(list.items.map((i: { host: string }) => i.host)).toContain("cliente1.escola.example");
    expect(list.routing.ready).toBe(false); // painel de teste fora de container: a tela explica
    expect(list.counters.total).toBeGreaterThanOrEqual(1);

    expect((await call("DELETE", url(A, "/cliente1.escola.example"), bearer(tokenW))).statusCode).toBe(200);
    expect((await call("DELETE", url(A, "/cliente1.escola.example"), bearer(tokenW))).statusCode).toBe(404);

    const audit = (await call("GET", "/api/audit?perPage=200", human())).json().entries as Array<Record<string, string>>;
    const added = audit.find((e) => e.action === "domain.dynamic_added");
    expect(added).toMatchObject({ actor: "token:saas-dominios" });
    expect(audit.some((e) => e.action === "domain.dynamic_removed" && e.actor === "token:saas-dominios")).toBe(true);
  });

  it("nome inválido: 400 com o motivo; JSON fora do formato: 400", async () => {
    const bad = await call("POST", url(A), bearer(tokenW), { host: "*.escola.example" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "invalid_dynamic_host", issue: "wildcard" });
    expect((await call("POST", url(A), bearer(tokenW), { host: "" })).statusCode).toBe(400);
    expect((await call("POST", url(A), bearer(tokenW), { host: "a.example.com", extra: 1 })).statusCode).toBe(400);
    expect((await call("POST", url(A), bearer(tokenW), {})).statusCode).toBe(400);
  });

  it("consulta da lista: parâmetros fora do formato são recusados", async () => {
    for (const q of ["page=0", "page=x", "pageSize=7", "state=talvez", "q=" + "a".repeat(101), "outra=1"]) {
      expect((await call("GET", `${url(A)}?${q}`, bearer(tokenW))).statusCode, q).toBe(400);
    }
    expect((await call("GET", `${url(A)}?q=escola&state=waiting&page=1&pageSize=25`, bearer(tokenW))).statusCode).toBe(200);
  });

  it("nome de outro projeto ou de site fixo: 409 sem pista de quem usa", async () => {
    await call("POST", url(B), human(), { host: "da-loja.cliente.example" });
    const dynamic = await call("POST", url(A), bearer(tokenW), { host: "da-loja.cliente.example" });
    const fixed = await call("POST", url(A), bearer(tokenW), { host: "loja.example.com" });
    for (const res of [dynamic, fixed]) {
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("domain_unavailable");
      expect(res.body).not.toContain("Loja");
      expect(res.body).not.toContain(B);
    }
    // a pessoa, na tela, vê o motivo de verdade
    const human409 = await call("POST", url(A), human(), { host: "loja.example.com" });
    expect(human409.json().error).toBe("domain_in_use");
    await call("DELETE", url(B, "/da-loja.cliente.example"), human());
  });

  it("o nome dinâmico também trava o mesmo nome em site fixo de qualquer projeto", async () => {
    await call("POST", url(A), human(), { host: "reservado.cliente.example" });
    const res = await call("POST", `/api/projects/${B}/domains`, human(), { domain: "reservado.cliente.example" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("domain_in_use");
    await call("DELETE", url(A, "/reservado.cliente.example"), human());
    const free = await call("POST", `/api/projects/${B}/domains`, human(), { domain: "reservado.cliente.example" });
    expect(free.statusCode).toBeLessThan(300);
    await call("DELETE", `/api/projects/${B}/domains/reservado.cliente.example`, human());
  });
});

describe("alcance do token de domínios", () => {
  it("projeto fora da lista: o mesmo 404 do projeto que não existe, em todas as rotas", async () => {
    const reqs: Array<["GET" | "POST" | "DELETE", string, unknown?]> = [
      ["GET", url(B)],
      ["POST", url(B), { host: "x.cliente.example" }],
      ["GET", url(B, "/x.cliente.example")],
      ["DELETE", url(B, "/x.cliente.example")],
    ];
    for (const [method, path, body] of reqs) {
      const outside = await call(method, path, bearer(tokenW), body);
      const missing = await call(method, path.replace(B, MISSING), bearer(tokenW), body);
      expect(outside.statusCode, path).toBe(404);
      expect(outside.body, path).toBe(missing.body);
    }
    // por apelido (slug) também não
    expect((await call("GET", url("loja"), bearer(tokenW))).statusCode).toBe(404);
  });

  it("não alcança mais nada: nem ler o projeto, nem a lista de projetos, nem rotas abertas", async () => {
    const paths: Array<["GET" | "POST" | "PUT" | "DELETE", string, unknown?]> = [
      ["GET", `/api/projects/${A}`],
      ["GET", "/api/projects"],
      ["GET", `/api/projects/${A}/logs`],
      ["POST", `/api/projects/${A}/deploy`, {}],
      ["POST", `/api/projects/${A}/domains`, { domain: "novo.example.com" }],
      ["DELETE", `/api/projects/${A}`],
      ["GET", "/api/certificates"],
      ["GET", "/api/version"],
      ["GET", "/api/auth/me"],
      ["GET", "/api/settings/api-tokens"],
      ["POST", "/api/settings/api-tokens", { name: "x" }],
      ["GET", "/api/mail/status"],
      ["GET", "/api/audit"],
      ["GET", "/api/domains/check?domain=a.example.com"],
    ];
    for (const [method, path, body] of paths) {
      const res = await call(method, path, bearer(tokenW), body);
      expect(res.statusCode, `${method} ${path}`).toBe(403);
      expect(res.json().error, `${method} ${path}`).toBe("token_forbidden");
    }
  });

  it("sufixos e tetos são só da pessoa: nenhum token, de nenhum alcance, passa", async () => {
    for (const t of [tokenW, tokenR, tokenAdminA, tokenPanelAdmin]) {
      expect((await call("PUT", url(A, "/suffixes"), bearer(t), { suffixes: [{ suffix: "saas.example", openAll: true }] })).statusCode).toBe(403);
      expect((await call("GET", "/api/settings/dynamic-domains", bearer(t))).statusCode).toBe(403);
      expect((await call("PUT", "/api/settings/dynamic-domains", bearer(t), { maxIssuancesPerHour: 100 })).statusCode).toBe(403);
    }
    // nada mudou
    expect((await call("GET", url(A), human())).json().suffixes).toEqual([]);
    expect((await call("GET", "/api/settings/dynamic-domains", human())).json().limits).toEqual({ maxNamesPerProject: 500, maxIssuancesPerHour: 20 });
  });

  it("nível de leitura só lista e consulta; cadastrar e remover pedem escrita", async () => {
    await call("POST", url(A), bearer(tokenW), { host: "lido.cliente.example" });
    expect((await call("GET", url(A), bearer(tokenR))).statusCode).toBe(200);
    expect((await call("GET", url(A, "/lido.cliente.example"), bearer(tokenR))).statusCode).toBe(200);
    for (const [method, path, body] of [
      ["POST", url(A), { host: "outro.cliente.example" }],
      ["DELETE", url(A, "/lido.cliente.example"), undefined],
    ] as const) {
      const res = await call(method, path, bearer(tokenR), body);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("insufficient_scope");
    }
    await call("DELETE", url(A, "/lido.cliente.example"), bearer(tokenW));
  });

  it("revogar corta na hora; projeto apagado e recriado com o mesmo nome não herda o alcance", async () => {
    const t = await panel.createToken({ name: "curto", scope: "write", reach: "domains", projects: [A] });
    expect((await call("GET", url(A), bearer(t.token))).statusCode).toBe(200);
    await call("DELETE", `/api/settings/api-tokens/${t.id}`, human());
    expect((await call("GET", url(A), bearer(t.token))).statusCode).toBe(401);
  });
});

describe("os outros tokens precisam de admin para cadastrar e remover", () => {
  it("escrita comum: lista sim, cadastra e remove não (muda para onde o tráfego vai)", async () => {
    expect((await call("GET", url(A), bearer(tokenWriteA))).statusCode).toBe(200);
    const add = await call("POST", url(A), bearer(tokenWriteA), { host: "x.cliente.example" });
    expect(add.statusCode).toBe(403);
    expect(add.json().error).toBe("insufficient_scope");
    expect((await call("DELETE", url(A, "/x.cliente.example"), bearer(tokenWriteA))).statusCode).toBe(403);
  });

  it("admin limitado a projetos: no projeto dele sim; fora, 404; painel inteiro admin sim", async () => {
    expect((await call("POST", url(A), bearer(tokenAdminA), { host: "adm.cliente.example" })).statusCode).toBe(201);
    expect((await call("POST", url(B), bearer(tokenAdminA), { host: "adm2.cliente.example" })).statusCode).toBe(404);
    expect((await call("DELETE", url(A, "/adm.cliente.example"), bearer(tokenAdminA))).statusCode).toBe(200);
    expect((await call("POST", url(B), bearer(tokenPanelAdmin), { host: "adm3.cliente.example" })).statusCode).toBe(201);
    expect((await call("DELETE", url(B, "/adm3.cliente.example"), bearer(tokenPanelAdmin))).statusCode).toBe(200);
  });
});

describe("sufixos e tetos pela pessoa", () => {
  it("sufixo: valida, grava, mostra na lista e libera nomes sob ele", async () => {
    const bad = await call("PUT", url(A, "/suffixes"), human(), { suffixes: [{ suffix: "com.br", openAll: false }] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("invalid_dynamic_suffix");
    expect((await call("PUT", url(A, "/suffixes"), human(), { suffixes: [{ suffix: "x.example" }] })).statusCode).toBe(400);
    const ok = await call("PUT", url(A, "/suffixes"), human(), { suffixes: [{ suffix: "*.Saas.Example", openAll: false }] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().suffixes).toEqual([{ suffix: "saas.example", openAll: false }]);
    expect((await call("GET", url(A), human())).json().suffixes).toEqual([{ suffix: "saas.example", openAll: false }]);
    const sub = await call("POST", url(A), bearer(tokenW), { host: "cliente9.saas.example" });
    expect(sub.json().item.via).toBe("suffix");
    // o mesmo sufixo em outro projeto não pode
    expect((await call("PUT", url(B, "/suffixes"), human(), { suffixes: [{ suffix: "saas.example", openAll: false }] })).statusCode).toBe(409);
    await call("DELETE", url(A, "/cliente9.saas.example"), human());
    await call("PUT", url(A, "/suffixes"), human(), { suffixes: [] });
  });

  it("tetos: lê com a faixa e o padrão, muda, recusa fora da faixa", async () => {
    const got = (await call("GET", "/api/settings/dynamic-domains", human())).json();
    expect(got.defaults).toEqual({ maxNamesPerProject: 500, maxIssuancesPerHour: 20 });
    expect(got.range).toEqual({ maxNamesPerProject: { min: 10, max: 5000 }, maxIssuancesPerHour: { min: 1, max: 100 } });
    const set = await call("PUT", "/api/settings/dynamic-domains", human(), { maxIssuancesPerHour: 7 });
    expect(set.statusCode).toBe(200);
    expect(set.json().limits).toEqual({ maxNamesPerProject: 500, maxIssuancesPerHour: 7 });
    for (const body of [{ maxIssuancesPerHour: 0 }, { maxNamesPerProject: 9 }, { maxNamesPerProject: 1.5 }, {}, { outro: 1 }, { maxIssuancesPerHour: "dez" }]) {
      expect((await call("PUT", "/api/settings/dynamic-domains", human(), body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    await call("PUT", "/api/settings/dynamic-domains", human(), { maxIssuancesPerHour: 20 });
  });

  it("sem sessão nenhuma rota responde", async () => {
    for (const [method, path] of [
      ["GET", url(A)],
      ["POST", url(A)],
      ["GET", "/api/settings/dynamic-domains"],
    ] as const) {
      expect((await call(method, path, {})).statusCode).toBe(401);
    }
  });
});

describe("página Certificados", () => {
  it("o nome dinâmico aparece (dono = projeto) sem abrir conexão TLS; 'Tentar emitir agora' e certificado manual não valem", async () => {
    await call("POST", url(A), human(), { host: "listado.cliente.example" });
    const listed = (await call("GET", `/api/certificates?project=${A}`, human())).json();
    const item = listed.items.find((i: { host: string }) => i.host === "listado.cliente.example");
    expect(item).toBeDefined();
    expect(item.owner).toMatchObject({ kind: "project", projectId: A });
    const retry = await call("POST", "/api/certificates/listado.cliente.example/retry", human());
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error).toBe("on_demand");
    const manual = await call("PUT", "/api/certificates/listado.cliente.example/manual", human(), { certificate: "x", privateKey: "y" });
    expect(manual.statusCode).toBe(409);
    expect(manual.json().error).toBe("on_demand");
    await call("DELETE", url(A, "/listado.cliente.example"), human());
  });
});

describe("projeto apagado", () => {
  it("os nomes e sufixos saem com ele e o token de domínios passa a ver 404", async () => {
    const C = await panel.createProject("Efemero", "efemero.example.com");
    const t = await panel.createToken({ name: "efemero", scope: "write", reach: "domains", projects: [C] });
    await call("PUT", url(C, "/suffixes"), human(), { suffixes: [{ suffix: "efemero.example", openAll: true }] });
    await call("POST", url(C), bearer(t.token), { host: "a.cliente.example" });
    expect(await panel.app.dynamicDomains.names()).toContainEqual({ host: "a.cliente.example", projectId: C });
    expect((await call("DELETE", `/api/projects/${C}`, human())).statusCode).toBe(200);
    expect((await panel.app.dynamicDomains.names()).some((n) => n.projectId === C)).toBe(false);
    expect((await call("GET", url(C), bearer(t.token))).statusCode).toBe(404);
    // o nome fica livre para outro projeto
    expect((await call("POST", url(A), human(), { host: "a.cliente.example" })).statusCode).toBe(201);
    await call("DELETE", url(A, "/a.cliente.example"), human());
  });
});
