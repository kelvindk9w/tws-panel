/**
 * token-alcance-rotas.test.ts — o comportamento das rotas COM O HANDLER REAL
 * para tokens limitados a projetos (Fase 0b): listas filtradas, criação que
 * registra o projeto na lista do token (atômica), apagar tira o projeto das
 * listas, recusas de conflito sem pista, registro de backup e consulta de domínio
 * conferidos pelo alcance, gestão do alcance (criar/editar) e auditoria.
 * Sem Docker (listContainers vazio, socket inexistente), sem rede (DNS simulado).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";
import { PASSWORD, startRealPanel, type RealPanel } from "./helpers/real-panel.js";

vi.mock("../src/services/docker-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/docker-service.js")>()),
  listContainers: async () => [],
}));
// Nenhuma consulta de DNS sai da máquina de teste.
vi.mock("node:dns/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:dns/promises")>();
  const resolve4 = async () => {
    throw Object.assign(new Error("sem DNS nos testes"), { code: "ENOTFOUND" });
  };
  return { ...real, resolve4, default: { ...(real as unknown as { default: object }).default, resolve4 } };
});

const MISSING = "0000000000000000";
let panel: RealPanel;
let A = "";
let B = "";
let tokenA = ""; // só A
let tokenAC = ""; // A + pode criar
let tokenAcId = "";
let tokenAId = "";
let tokenPanel = "";

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const human = () => ({ cookie: panel.cookie });

async function tokenInfo(id: string) {
  const res = await panel.app.inject({ method: "GET", url: "/api/settings/api-tokens", headers: human() });
  return (res.json().tokens as Array<Record<string, any>>).find((t) => t.id === id)!;
}

beforeAll(async () => {
  panel = await startRealPanel();
  A = await panel.createProject("Fazenda", "fazenda.example.com");
  B = await panel.createProject("Loja", "loja.example.com");
  const a = await panel.createToken({ name: "so-a", reach: "projects", projects: [A] });
  tokenA = a.token;
  tokenAId = a.id;
  const ac = await panel.createToken({ name: "so-a-cria", reach: "projects", projects: [A], canCreate: true });
  tokenAC = ac.token;
  tokenAcId = ac.id;
  tokenPanel = (await panel.createToken({ name: "painel", reach: "panel" })).token;
}, 120_000);

afterAll(async () => panel.close());

describe("listas filtradas", () => {
  it("GET /api/projects: token limitado só vê os projetos da lista; painel inteiro e humano veem todos", async () => {
    const limited = await panel.app.inject({ method: "GET", url: "/api/projects", headers: bearer(tokenA) });
    expect(limited.statusCode).toBe(200);
    expect(limited.json().projects.map((p: { project: { id: string } }) => p.project.id)).toEqual([A]);
    for (const headers of [bearer(tokenPanel), human()]) {
      const all = await panel.app.inject({ method: "GET", url: "/api/projects", headers });
      expect(all.json().projects.map((p: { project: { id: string } }) => p.project.id).sort()).toEqual([A, B].sort());
    }
    // a resposta do limitado não carrega nem o nome nem o domínio do outro projeto
    expect(limited.body).not.toContain("loja");
    expect(limited.body).not.toContain(B);
  });

  it("GET /api/projects/update-status: só o projeto do alcance", async () => {
    const limited = await panel.app.inject({ method: "GET", url: "/api/projects/update-status", headers: bearer(tokenA) });
    expect(limited.statusCode).toBe(200);
    const ids = (limited.json().statuses as Array<{ projectId: string }>).map((s) => s.projectId);
    expect(ids).not.toContain(B);
    const all = await panel.app.inject({ method: "GET", url: "/api/projects/update-status", headers: human() });
    expect((all.json().statuses as Array<{ projectId: string }>).map((s) => s.projectId)).toContain(B);
  });

  it("detalhe de projeto: o seu abre; o de fora e o inexistente dão o mesmo 404", async () => {
    const own = await panel.app.inject({ method: "GET", url: `/api/projects/${A}`, headers: bearer(tokenA) });
    expect(own.statusCode).toBe(200);
    const outside = await panel.app.inject({ method: "GET", url: `/api/projects/${B}`, headers: bearer(tokenA) });
    const missing = await panel.app.inject({ method: "GET", url: `/api/projects/${MISSING}`, headers: bearer(tokenA) });
    expect(outside.statusCode).toBe(404);
    expect(outside.body).toBe(missing.body);
    // por apelido (slug) também não: o limite é pelo id
    const bySlug = await panel.app.inject({ method: "GET", url: "/api/projects/loja", headers: bearer(tokenA) });
    expect(bySlug.statusCode).toBe(404);
    expect(bySlug.body).toBe(missing.body);
  });

  it("jobs de outro projeto: o id de deploy não vaza entre projetos (404 igual)", async () => {
    const own = await panel.app.inject({ method: "GET", url: `/api/projects/${A}/jobs`, headers: bearer(tokenA) });
    expect(own.statusCode).toBe(200);
    // job de B pedido pelo caminho de A: não existe para A
    const job = await panel.app.inject({ method: "GET", url: `/api/projects/${A}/jobs/abcdef0123456789`, headers: bearer(tokenA) });
    expect(job.statusCode).toBe(404);
    expect(job.json().error).toBe("job_not_found");
    const outside = await panel.app.inject({ method: "GET", url: `/api/projects/${B}/jobs/abcdef0123456789`, headers: bearer(tokenA) });
    expect(outside.json()).toEqual({ error: "project_not_found", message: "Projeto não encontrado." });
  });
});

describe("identidade do projeto", () => {
  it("o id exato vence o apelido: um projeto cujo nome vira o id de outro não o sequestra", async () => {
    const service = panel.app.deployService as unknown as { projects: Array<Record<string, unknown>>; getProject(id: string): Promise<{ id: string } | null> };
    const real = (await service.getProject(A))!;
    // impostor na FRENTE da lista, com apelido igual ao id do projeto A
    const impostor = { ...real, id: "ffffffffffffffff", name: "Impostor", slug: A };
    const saved = service.projects;
    service.projects = [impostor, ...saved];
    try {
      expect((await service.getProject(A))!.id).toBe(A);
      // o apelido só vale quando nenhum id bate
      expect((await service.getProject("fazenda"))!.id).toBe(A);
    } finally {
      service.projects = saved;
    }
  });
});

describe("registro de backup e consulta de domínio", () => {
  it("GET /api/backups/records/:id: registro de projeto fora do alcance, do painel ou inexistente respondem igual", async () => {
    const record = vi.spyOn(panel.app.backupService, "record").mockImplementation(async (id: string) => {
      if (id === "r-a") return { id, target: `project:${A}` } as never;
      if (id === "r-b") return { id, target: `project:${B}` } as never;
      if (id === "r-panel") return { id, target: "panel" } as never;
      const err = new Error("Registro de backup não encontrado.") as Error & { statusCode: number; code: string };
      err.statusCode = 404;
      err.code = "not_found";
      throw err;
    });
    try {
      const get = (id: string, headers: Record<string, string>) => panel.app.inject({ method: "GET", url: `/api/backups/records/${id}`, headers });
      expect((await get("r-a", bearer(tokenA))).statusCode).toBe(200);
      const outside = await get("r-b", bearer(tokenA));
      const ofPanel = await get("r-panel", bearer(tokenA));
      const missing = await get("r-nada", bearer(tokenA));
      for (const res of [outside, ofPanel, missing]) expect(res.statusCode).toBe(404);
      expect(outside.body).toBe(missing.body);
      expect(ofPanel.body).toBe(missing.body);
      // painel inteiro e humano veem qualquer registro
      expect((await get("r-b", bearer(tokenPanel))).statusCode).toBe(200);
      expect((await get("r-panel", human())).statusCode).toBe(200);
    } finally {
      record.mockRestore();
    }
  });

  it("GET /api/domains/check?project=: projeto fora do alcance é 404 igual ao inexistente", async () => {
    const q = (project: string) =>
      panel.app.inject({ method: "GET", url: `/api/domains/check?domain=app.example.com&project=${project}`, headers: bearer(tokenA) });
    const outside = await q(B);
    const missing = await q(MISSING);
    expect(outside.statusCode).toBe(404);
    expect(outside.body).toBe(missing.body);
    expect((await q(A)).statusCode).toBe(200);
    // sem projeto na consulta, qualquer token lê
    const none = await panel.app.inject({ method: "GET", url: "/api/domains/check?domain=app.example.com", headers: bearer(tokenA) });
    expect(none.statusCode).toBe(200);
  });

  it("par do domínio ocupado por outro projeto/painel: token limitado lê 'indisponível', nunca quem usa", async () => {
    // "Par" usa www.apex-site.com, o par do domínio do projeto "Apex"
    const apex = await panel.createProject("Apex", "apex-site.com");
    const D = await panel.createProject("Par", "www.apex-site.com");
    const scoped = (await panel.createToken({ name: "so-apex", reach: "projects", projects: [apex] })).token;
    try {
      const asHuman = await panel.app.inject({ method: "GET", url: "/api/domains/check?domain=apex-site.com", headers: human() });
      expect(asHuman.json().pair.occupiedBy).toBe("other_project");
      const asToken = await panel.app.inject({ method: "GET", url: "/api/domains/check?domain=apex-site.com", headers: bearer(tokenA) });
      expect(asToken.json().pair.occupiedBy).toBe("unavailable");

      const pairsHuman = await panel.app.inject({ method: "GET", url: `/api/projects/${apex}/domains/pairs`, headers: human() });
      expect(pairsHuman.json().pairs[0].occupiedBy).toBe("other_project");
      const pairsToken = await panel.app.inject({ method: "GET", url: `/api/projects/${apex}/domains/pairs`, headers: bearer(scoped) });
      expect(pairsToken.json().pairs[0].occupiedBy).toBe("unavailable");
      expect(pairsToken.body).not.toContain("Par");
      // o painel inteiro continua vendo a verdade
      const pairsPanel = await panel.app.inject({ method: "GET", url: `/api/projects/${apex}/domains/pairs`, headers: bearer(tokenPanel) });
      expect(pairsPanel.json().pairs[0].occupiedBy).toBe("other_project");
    } finally {
      await panel.app.inject({ method: "DELETE", url: `/api/projects/${D}`, headers: human() });
      await panel.app.inject({ method: "DELETE", url: `/api/projects/${apex}`, headers: human() });
    }
  });
});

describe("recusa de conflito sem pista", () => {
  it("domínio já usado por outro projeto: 'indisponível', sem nome, id nem domínio do outro", async () => {
    const viaPatch = await panel.app.inject({
      method: "PATCH",
      url: `/api/projects/${A}`,
      headers: bearer(tokenA),
      payload: { domain: "loja.example.com" },
    });
    const viaDomains = await panel.app.inject({
      method: "POST",
      url: `/api/projects/${A}/domains`,
      headers: bearer(tokenA),
      payload: { domain: "loja.example.com" },
    });
    for (const res of [viaPatch, viaDomains]) {
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("domain_unavailable");
      expect(res.json().message).toBe("Este domínio não está disponível. Escolha outro.");
      expect(res.body).not.toContain("loja");
      expect(res.body).not.toContain(B);
    }
    // o humano segue recebendo a mensagem de sempre
    const human409 = await panel.app.inject({ method: "POST", url: `/api/projects/${A}/domains`, headers: human(), payload: { domain: "loja.example.com" } });
    expect(human409.json().error).toBe("domain_in_use");
    // e domínio livre funciona para o token
    const free = await panel.app.inject({ method: "POST", url: `/api/projects/${A}/domains`, headers: bearer(tokenA), payload: { domain: "extra.example.com" } });
    expect(free.statusCode).toBe(200);
    await panel.app.inject({ method: "DELETE", url: `/api/projects/${A}/domains/extra.example.com`, headers: bearer(tokenA) });
  });

  it("trocar a fonte do projeto é proibido para token limitado; o painel inteiro ainda pode", async () => {
    const limited = await panel.app.inject({ method: "PATCH", url: `/api/projects/${A}`, headers: bearer(tokenA), payload: { source: "https://example.com/outro.git" } });
    expect(limited.statusCode).toBe(403);
    expect(limited.json().error).toBe("token_forbidden");
    const wide = await panel.app.inject({ method: "PATCH", url: `/api/projects/${A}`, headers: bearer(tokenPanel), payload: { source: "https://example.com/fazenda.git" } });
    expect(wide.statusCode).toBe(200);
  });
});

describe("projeto criado pelo token", () => {
  const body = (name: string, domain: string) => ({ name, ingestMode: "git", source: "https://example.com/novo.git", domain, backup: false });

  it("sem 'pode criar': 403; só repositório remoto: pasta local é 403 mesmo com 'pode criar'", async () => {
    const no = await panel.app.inject({ method: "POST", url: "/api/projects", headers: bearer(tokenA), payload: body("Nao", "nao.example.com") });
    expect(no.statusCode).toBe(403);
    const local = await panel.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: bearer(tokenAC),
      payload: { ...body("Local", "local.example.com"), ingestMode: "existing", source: "/srv/qualquer" },
    });
    expect(local.statusCode).toBe(403);
    const list = await panel.app.inject({ method: "GET", url: "/api/projects", headers: human() });
    expect(list.json().projects.map((p: { project: { name: string } }) => p.project.name)).not.toContain("Nao");
  });

  it("com 'pode criar': o projeto entra na lista do token, aparece só para ele e fica registrado na Auditoria", async () => {
    const res = await panel.app.inject({ method: "POST", url: "/api/projects", headers: bearer(tokenAC), payload: body("Horta", "horta.example.com") });
    expect(res.statusCode).toBe(201);
    const id = res.json().project.id as string;
    expect((await tokenInfo(tokenAcId)).projects).toEqual([A, id]);
    // o outro token (só A) não o enxerga: nem na lista, nem por id
    const other = await panel.app.inject({ method: "GET", url: "/api/projects", headers: bearer(tokenA) });
    expect(other.json().projects.map((p: { project: { id: string } }) => p.project.id)).toEqual([A]);
    expect((await panel.app.inject({ method: "GET", url: `/api/projects/${id}`, headers: bearer(tokenA) })).statusCode).toBe(404);
    // o criador alcança o projeto novo logo em seguida
    expect((await panel.app.inject({ method: "GET", url: `/api/projects/${id}`, headers: bearer(tokenAC) })).statusCode).toBe(200);
    // Auditoria: ator token:<nome> e o projeto
    await panel.app.auditService.flush();
    const audit = (await panel.app.inject({ method: "GET", url: "/api/audit?perPage=200", headers: human() })).json().entries as Array<Record<string, string>>;
    const created = audit.find((e) => e.action === "project.create");
    expect(created).toMatchObject({ actor: "token:so-a-cria", target: expect.stringMatching(/^horta-[0-9a-f]{4}$/) });
    // sessão humana também vê o projeto, claro
    expect((await panel.app.inject({ method: "GET", url: `/api/projects/${id}`, headers: human() })).statusCode).toBe(200);

    // token limitado não apaga (403, até a confirmação humana da Fase 3); a pessoa apaga e o id sai da lista do token
    const refused = await panel.app.inject({ method: "DELETE", url: `/api/projects/${id}`, headers: bearer(tokenAC) });
    expect(refused.statusCode).toBe(403);
    const del = await panel.app.inject({ method: "DELETE", url: `/api/projects/${id}`, headers: human() });
    expect(del.statusCode).toBe(200);
    expect((await tokenInfo(tokenAcId)).projects).toEqual([A]);
    // e o id apagado não volta a valer: 404
    expect((await panel.app.inject({ method: "GET", url: `/api/projects/${id}`, headers: bearer(tokenAC) })).statusCode).toBe(404);
  });

  it("falha ao registrar na lista: o projeto é desfeito e a resposta diz que nada foi criado", async () => {
    const spy = vi.spyOn(panel.app.apiTokens, "addProject").mockRejectedValueOnce(new Error("disco cheio"));
    try {
      const res = await panel.app.inject({ method: "POST", url: "/api/projects", headers: bearer(tokenAC), payload: body("Falha", "falha.example.com") });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe("project_not_registered");
      const list = await panel.app.inject({ method: "GET", url: "/api/projects", headers: human() });
      expect(list.json().projects.map((p: { project: { name: string } }) => p.project.name)).not.toContain("Falha");
      expect((await tokenInfo(tokenAcId)).projects).toEqual([A]);
    } finally {
      spy.mockRestore();
    }
  });

  it("registro recusado (token sem 'pode criar' no momento): mesmo desfecho, nada sobra", async () => {
    const spy = vi.spyOn(panel.app.apiTokens, "addProject").mockResolvedValueOnce(false);
    try {
      const res = await panel.app.inject({ method: "POST", url: "/api/projects", headers: bearer(tokenAC), payload: body("Recusa", "recusa.example.com") });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe("project_not_registered");
      const list = await panel.app.inject({ method: "GET", url: "/api/projects", headers: human() });
      expect(list.json().projects.map((p: { project: { name: string } }) => p.project.name)).not.toContain("Recusa");
    } finally {
      spy.mockRestore();
    }
  });

  it("falha ao registrar E ao desfazer: o erro diz claramente que o projeto existe fora do alcance do token", async () => {
    const add = vi.spyOn(panel.app.apiTokens, "addProject").mockResolvedValueOnce(false);
    const del = vi.spyOn(panel.app.deployService, "deleteProject").mockRejectedValueOnce(new Error("docker fora"));
    try {
      const res = await panel.app.inject({ method: "POST", url: "/api/projects", headers: bearer(tokenAC), payload: body("Orfao", "orfao.example.com") });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe("project_created_unregistered");
      expect(res.json().message).toMatch(/"orfao-[0-9a-f]{4}"/);
      expect(res.json().message).toContain("fora do alcance do token");
      // o token NÃO alcança o órfão
      const list = await panel.app.inject({ method: "GET", url: "/api/projects", headers: bearer(tokenAC) });
      expect(list.json().projects.map((p: { project: { name: string } }) => p.project.name)).not.toContain("Orfao");
    } finally {
      add.mockRestore();
      del.mockRestore();
      const all = (await panel.app.inject({ method: "GET", url: "/api/projects", headers: human() })).json().projects as Array<{ project: { id: string; slug: string } }>;
      const orphan = all.find((p) => p.project.slug === "orfao");
      if (orphan) await panel.app.inject({ method: "DELETE", url: `/api/projects/${orphan.project.id}`, headers: human() });
    }
  });

  it("token de painel inteiro cria projeto sem tocar em listas de tokens", async () => {
    const before = JSON.stringify((await panel.app.inject({ method: "GET", url: "/api/settings/api-tokens", headers: human() })).json().tokens.map((t: any) => t.projects));
    const res = await panel.app.inject({ method: "POST", url: "/api/projects", headers: bearer(tokenPanel), payload: body("Amplo", "amplo.example.com") });
    expect(res.statusCode).toBe(201);
    const after = JSON.stringify((await panel.app.inject({ method: "GET", url: "/api/settings/api-tokens", headers: human() })).json().tokens.map((t: any) => t.projects));
    expect(after).toBe(before);
    await panel.app.inject({ method: "DELETE", url: `/api/projects/${res.json().project.id}`, headers: human() });
  });
});

describe("gestão do alcance (só sessão humana)", () => {
  const create = (payload: Record<string, unknown>) =>
    panel.app.inject({ method: "POST", url: "/api/settings/api-tokens", headers: human(), payload: { name: "novo", scope: "read", currentPassword: PASSWORD, ...payload } });

  it("alcance 'projects' sem projeto e sem 'pode criar' é recusado (400); painel com lista também", async () => {
    for (const payload of [
      { reach: "projects", projects: [] },
      { reach: "projects" },
      { reach: "panel", projects: [A] },
      { reach: "panel", canCreate: true },
    ]) {
      const res = await create(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error).toBe("invalid_token_reach");
    }
  });

  it("projeto inexistente na lista é recusado e não gasta tentativa de senha", async () => {
    const res = await create({ reach: "projects", projects: [A, MISSING] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_token_reach");
    // apelido não vale: a lista é de ids
    const bySlug = await create({ reach: "projects", projects: ["fazenda"] });
    expect(bySlug.statusCode).toBe(400);
  });

  it("sem alcance informado vale o painel inteiro (compatível com a Fase 0); a listagem mostra o alcance", async () => {
    const res = await create({ name: "compat" });
    expect(res.statusCode).toBe(201);
    expect(res.json().info).toMatchObject({ reach: "panel", projects: [], canCreate: false });
    const lim = await create({ name: "lim-lista", scope: "admin", reach: "projects", projects: [A, B], canCreate: true });
    expect(lim.statusCode).toBe(201);
    const listed = await tokenInfo(lim.json().info.id);
    expect(listed).toMatchObject({ reach: "projects", projects: [A, B], canCreate: true });
    await panel.app.inject({ method: "DELETE", url: `/api/settings/api-tokens/${lim.json().info.id}`, headers: human() });
    await panel.app.inject({ method: "DELETE", url: `/api/settings/api-tokens/${res.json().info.id}`, headers: human() });
  });

  it("criar exige a senha atual também com alcance de projetos", async () => {
    const res = await panel.app.inject({
      method: "POST",
      url: "/api/settings/api-tokens",
      headers: human(),
      payload: { name: "sem-senha", scope: "read", reach: "projects", projects: [A], currentPassword: "errada" },
    });
    expect(res.statusCode).toBe(401);
  });

  describe("editar a lista", () => {
    const patch = (id: string, payload: Record<string, unknown>, headers: Record<string, string> = human()) =>
      panel.app.inject({ method: "PATCH", url: `/api/settings/api-tokens/${id}`, headers, payload });

    it("aumentar (projeto novo ou 'pode criar') exige a senha atual; sem ela ou errada: 401 e nada muda", async () => {
      const made = await create({ name: "editavel", scope: "admin", reach: "projects", projects: [A] });
      const id = made.json().info.id as string;
      try {
        for (const extra of [{}, { currentPassword: "errada" }]) {
          const res = await patch(id, { projects: [A, B], canCreate: false, ...extra });
          expect(res.statusCode).toBe(401);
          expect(res.json().error).toBe("invalid_current_password");
        }
        const onlyCreate = await patch(id, { projects: [A], canCreate: true });
        expect(onlyCreate.statusCode).toBe(401);
        expect((await tokenInfo(id)).projects).toEqual([A]);
        expect((await tokenInfo(id)).canCreate).toBe(false);

        const ok = await patch(id, { projects: [A, B], canCreate: true, currentPassword: PASSWORD });
        expect(ok.statusCode).toBe(200);
        expect(ok.json().info).toMatchObject({ projects: [A, B], canCreate: true });
      } finally {
        await panel.app.inject({ method: "DELETE", url: `/api/settings/api-tokens/${id}`, headers: human() });
      }
    });

    it("reduzir (tirar projeto ou desligar 'pode criar') vale sem senha e já corta o acesso", async () => {
      const made = await create({ name: "enxuto", scope: "admin", reach: "projects", projects: [A, B], canCreate: true });
      const id = made.json().info.id as string;
      const token = made.json().token as string;
      try {
        expect((await panel.app.inject({ method: "GET", url: `/api/projects/${B}`, headers: bearer(token) })).statusCode).toBe(200);
        const res = await patch(id, { projects: [A], canCreate: false });
        expect(res.statusCode).toBe(200);
        expect(res.json().info).toMatchObject({ projects: [A], canCreate: false });
        // vale na hora, no pedido seguinte
        expect((await panel.app.inject({ method: "GET", url: `/api/projects/${B}`, headers: bearer(token) })).statusCode).toBe(404);
        expect((await panel.app.inject({ method: "POST", url: "/api/projects", headers: bearer(token), payload: { ingestMode: "git" } })).statusCode).toBe(403);
      } finally {
        await panel.app.inject({ method: "DELETE", url: `/api/settings/api-tokens/${id}`, headers: human() });
      }
    });

    it("lista vazia sem 'pode criar' é recusada na edição; projeto inexistente também", async () => {
      const made = await create({ name: "valida", reach: "projects", projects: [A] });
      const id = made.json().info.id as string;
      try {
        expect((await patch(id, { projects: [], canCreate: false })).statusCode).toBe(400);
        const bad = await patch(id, { projects: [A, MISSING], canCreate: false, currentPassword: PASSWORD });
        expect(bad.statusCode).toBe(400);
        expect(bad.json().error).toBe("invalid_token_reach");
      } finally {
        await panel.app.inject({ method: "DELETE", url: `/api/settings/api-tokens/${id}`, headers: human() });
      }
    });

    it("token de painel inteiro (409), revogado ou inexistente (404) não se edita", async () => {
      const wide = await create({ name: "amplo-edit" });
      const wideId = wide.json().info.id as string;
      expect((await patch(wideId, { projects: [A], canCreate: false, currentPassword: PASSWORD })).statusCode).toBe(409);
      const lim = await create({ name: "revogado-edit", reach: "projects", projects: [A] });
      const limId = lim.json().info.id as string;
      await panel.app.inject({ method: "DELETE", url: `/api/settings/api-tokens/${limId}`, headers: human() });
      expect((await patch(limId, { projects: [A], canCreate: false })).statusCode).toBe(404);
      expect((await patch("ffffffffffffffff", { projects: [A], canCreate: false })).statusCode).toBe(404);
      await panel.app.inject({ method: "DELETE", url: `/api/settings/api-tokens/${wideId}`, headers: human() });
    });

    it("nenhum token edita tokens (nem o próprio, nem com painel inteiro admin)", async () => {
      for (const t of [tokenA, tokenAC, tokenPanel]) {
        const res = await patch(tokenAId, { projects: [A, B], canCreate: true, currentPassword: PASSWORD }, bearer(t));
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toBe("token_forbidden");
      }
      expect((await tokenInfo(tokenAId)).projects).toEqual([A]);
    });

    it("a edição fica na Auditoria com o antes e o depois", async () => {
      const made = await create({ name: "auditado", reach: "projects", projects: [A] });
      const id = made.json().info.id as string;
      await patch(id, { projects: [A, B], canCreate: false, currentPassword: PASSWORD });
      await panel.app.auditService.flush();
      const audit = (await panel.app.inject({ method: "GET", url: "/api/audit?perPage=200", headers: human() })).json().entries as Array<Record<string, string>>;
      const entry = audit.find((e) => e.action === "auth.api_token_reach_changed" && e.target === id);
      expect(entry?.actor).toBe("admin");
      expect(entry?.detail).toContain(A);
      expect(entry?.detail).toContain(B);
      await panel.app.inject({ method: "DELETE", url: `/api/settings/api-tokens/${id}`, headers: human() });
    });
  });
});

describe("compatibilidade e falha fechada com o painel de pé", () => {
  it("arquivo da Fase 0 (sem campos de alcance): o token continua de painel inteiro", async () => {
    const { readFile, writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const file = path.join(panel.dir, "api-tokens.json");
    const raw = JSON.parse(await readFile(file, "utf8")) as { tokens: Array<Record<string, unknown>> };
    const legacy = raw.tokens.find((t) => t.name === "painel")!;
    delete legacy.reach;
    delete legacy.projects;
    delete legacy.canCreate;
    delete legacy.hostMetrics; // arquivo da Fase 0 não conhece a opção do monitoramento
    // outro token com a lista ilegível (alcance lixo): sem alcance nenhum
    const broken = raw.tokens.find((t) => t.name === "so-a")!;
    broken.projects = "lixo";
    await writeFile(file, JSON.stringify(raw));
    // nova instância do cadastro lendo o disco = reinício do painel
    const { ApiTokenStore } = await import("../src/services/api-token-store.js");
    const reloaded = new ApiTokenStore(panel.dir);
    const list = await reloaded.list();
    expect(list.find((t) => t.name === "painel")).toMatchObject({ reach: "panel", projects: [], canCreate: false });
    expect(list.find((t) => t.name === "so-a")).toMatchObject({ reach: "projects", projects: [], canCreate: false });
  });

  it("o assistente de instalação e o setup token não são alcançados por token", async () => {
    const res = await panel.app.inject({ method: "POST", url: "/api/setup/verify-token", headers: { ...bearer(tokenAC), [SETUP_TOKEN_HEADER]: "x" }, payload: {} });
    expect(res.statusCode).toBe(403);
  });
});
