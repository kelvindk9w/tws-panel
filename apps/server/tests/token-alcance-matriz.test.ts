/**
 * token-alcance-matriz.test.ts — matriz ROTA × ALCANCE contra o painel REAL
 * (todas as rotas /api/* registradas no Fastify, com tokens reais):
 * painel inteiro, só o projeto A, projeto A + pode criar, e token que ficou sem
 * projeto nenhum (projeto dele apagado). Prova que:
 *  - rota do painel/servidor dá 403 igual (mesmo corpo) para token limitado;
 *  - projeto fora da lista dá o MESMO 404 de projeto inexistente (corpo e cabeçalhos);
 *  - a lista de exclusão de 47 rotas continua valendo, com qualquer alcance;
 *  - criar projeto só com "pode criar".
 * Um gancho de preValidation (depois do plugin de autenticação) responde
 * "chegou" para pedido de token que passou pela política, sem rodar a rota: assim
 * a matriz nunca dispara deploy, backup nem Docker.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EXPECTED_ROUTE_ACCESS, EXPECTED_ROUTE_REACH } from "../src/services/token-policy-table.js";
import { startRealPanel, type RealPanel } from "./helpers/real-panel.js";

vi.mock("../src/services/docker-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/docker-service.js")>()),
  listContainers: async () => [],
}));

const MISSING = "0000000000000000";
const FORBIDDEN_KEYS = ["error", "message"];

let panel: RealPanel;
let stubOn = true;
let A = "";
let B = "";
const tokens: Record<"painel" | "soA" | "soAcria" | "soAhost" | "vazio", string> = { painel: "", soA: "", soAcria: "", soAhost: "", vazio: "" };

beforeAll(async () => {
  panel = await startRealPanel({
    beforeReady: (app: FastifyInstance) => {
      app.addHook("preValidation", async (request, reply) => {
        if (stubOn && request.session?.token) return reply.code(200).send({ reached: true });
      });
    },
  });
  stubOn = false;
  A = await panel.createProject("Fazenda", "fazenda.example.com");
  B = await panel.createProject("Loja", "loja.example.com");
  const C = await panel.createProject("Temporario", "temp.example.com");
  tokens.painel = (await panel.createToken({ name: "painel", reach: "panel" })).token;
  tokens.soA = (await panel.createToken({ name: "so-a", reach: "projects", projects: [A] })).token;
  tokens.soAcria = (await panel.createToken({ name: "so-a-cria", reach: "projects", projects: [A], canCreate: true })).token;
  tokens.soAhost = (await panel.createToken({ name: "so-a-host", reach: "projects", projects: [A], hostMetrics: true })).token;
  const vazio = await panel.createToken({ name: "vazio", reach: "projects", projects: [C] });
  tokens.vazio = vazio.token;
  // projeto apagado sai da lista dos tokens: o token passa a não alcançar nada
  const del = await panel.app.inject({ method: "DELETE", url: `/api/projects/${C}`, headers: { cookie: panel.cookie } });
  expect(del.statusCode).toBe(200);
  stubOn = true;
}, 120_000);

afterAll(async () => {
  await panel.close();
});

function urlFor(pattern: string, id: string): string {
  return pattern.replace(/:([A-Za-z]+)/g, (_m, name: string) => {
    if (name === "id") return id;
    if (name === "target") return `project:${id}`;
    if (name === "domain" || name === "host") return "example.com";
    return `${name}1`;
  });
}

async function call(token: string, key: string, id: string, bodyOverride?: unknown) {
  const [method, pattern] = key.split(" ") as [string, string];
  const write = method === "POST" || method === "PUT" || method === "PATCH";
  return panel.app.inject({
    method: method as "GET",
    url: urlFor(pattern, id),
    headers: { authorization: `Bearer ${token}` },
    ...(write ? { payload: bodyOverride ?? {} } : {}),
  });
}

const bodyFor = (key: string) => (key === "POST /api/projects" ? { ingestMode: "git" } : undefined);

/** Sem /api/healthz (público) nem /api/auth/login (recusa à parte): o resto passa pela política. */
const ROUTES = Object.keys(EXPECTED_ROUTE_ACCESS).filter((k) => k !== "GET /api/healthz" && k !== "POST /api/auth/login");

type Outcome = "reached" | "forbidden" | "not_found";

/** Resultado esperado, escrito à mão a partir das regras (não reaproveita o código que está sendo testado). */
function expected(key: string, profile: "painel" | "soA" | "soAcria" | "soAhost" | "vazio", id: string): Outcome {
  const denied = EXPECTED_ROUTE_ACCESS[key] === "denied";
  const reach = EXPECTED_ROUTE_REACH[key]!;
  const allowedIds = profile === "soA" || profile === "soAcria" || profile === "soAhost" ? [A] : [];
  if (profile !== "painel") {
    if (reach === "panel") return "forbidden";
    // monitoramento da VPS: só com a opção ligada (e ela não abre nenhuma rota do painel)
    if (reach === "host") return profile === "soAhost" && !denied ? "reached" : "forbidden";
    if (reach === "create") return profile === "soAcria" ? (denied ? "forbidden" : "reached") : "forbidden";
    if (reach === "project" && !allowedIds.includes(id)) return "not_found";
    if (reach === "target" && !allowedIds.includes(id)) return "not_found";
    // apagar projeto pede confirmação humana (Fase 3): token limitado não apaga, nem dentro do alcance
    if (key === "DELETE /api/projects/:id") return "forbidden";
  }
  return denied ? "forbidden" : "reached";
}

/** Única rota com limite de frequência próprio (10/min): a matriz a chama mais que isso. */
const RATE_LIMITED = "POST /api/projects/check-git-access";

function outcomeOf(res: { statusCode: number; json: () => any }, key = ""): Outcome | `outro:${number}` {
  const body = res.json() as { reached?: boolean; error?: string };
  if (res.statusCode === 200 && body.reached) return "reached";
  if (res.statusCode === 429 && key === RATE_LIMITED) return "reached";
  if (res.statusCode === 403 && body.error === "token_forbidden") return "forbidden";
  if (res.statusCode === 404 && body.error === "project_not_found") return "not_found";
  return `outro:${res.statusCode}`;
}

describe("matriz rota × alcance (painel real, todas as rotas)", () => {
  it("cobre todas as rotas da tabela (187, fora healthz e login) e a tabela de alcance tem as mesmas chaves", () => {
    expect(ROUTES.length).toBe(Object.keys(EXPECTED_ROUTE_ACCESS).length - 2);
    expect(Object.keys(EXPECTED_ROUTE_REACH).sort()).toEqual(Object.keys(EXPECTED_ROUTE_ACCESS).sort());
  });

  for (const profile of ["painel", "soA", "soAcria", "soAhost", "vazio"] as const) {
    it(`token ${profile}: o resultado de cada rota é o esperado (com projeto A, B e inexistente)`, async () => {
      const wrong: string[] = [];
      for (const key of ROUTES) {
        for (const id of [A, B, MISSING]) {
          const res = await call(tokens[profile], key, id, bodyFor(key));
          const got = outcomeOf(res, key);
          const want = expected(key, profile, id);
          if (got !== want) wrong.push(`${key} (${id === A ? "A" : id === B ? "B" : "inexistente"}) → ${got}, esperado ${want}`);
        }
      }
      expect(wrong).toEqual([]);
    }, 120_000);
  }

  it("token limitado nunca alcança rota do painel: 403 com o MESMO corpo, qualquer escopo/rota", async () => {
    const bodies = new Set<string>();
    for (const key of ROUTES) {
      if (EXPECTED_ROUTE_REACH[key] !== "panel" || EXPECTED_ROUTE_ACCESS[key] === "denied") continue;
      for (const profile of ["soA", "soAcria", "vazio"] as const) {
        const res = await call(tokens[profile], key, A);
        expect(res.statusCode, `${key} ${profile}`).toBe(403);
        bodies.add(res.body);
      }
    }
    // a mensagem não depende da rota nem do token: nenhuma pista sobre o que existe
    expect(bodies.size).toBe(1);
    const only = JSON.parse([...bodies][0]!) as Record<string, string>;
    expect(Object.keys(only).sort()).toEqual(FORBIDDEN_KEYS);
    expect(only.error).toBe("token_forbidden");
  });

  it("rotas do painel/servidor citadas no pedido: domínio do painel, e-mail do servidor, backup do painel, segurança, usuários, notificações, tokens, terminal, configurações", async () => {
    const mustBe403: Array<[string, string]> = [
      ["GET", "/api/settings/panel-domain"],
      ["PUT", "/api/settings/panel-domain"],
      ["GET", "/api/mail/domains"],
      ["POST", "/api/mail/domains"],
      ["GET", "/api/mail/envios/history"],
      ["GET", "/api/backups"],
      ["PUT", "/api/backups/defaults"],
      ["POST", "/api/backups/targets/panel/restore"],
      ["POST", "/api/backups/targets/panel/run"],
      ["POST", "/api/backups/targets/email/run"],
      ["GET", "/api/security/scan"],
      ["POST", "/api/security/apply"],
      ["GET", "/api/security/monitor/last"],
      ["POST", "/api/auth/change-password"],
      ["GET", "/api/auth/2fa"],
      ["GET", "/api/notifications"],
      ["PUT", "/api/notifications/kinds"],
      ["GET", "/api/integrations/github"],
      ["GET", "/api/settings/api-tokens"],
      ["POST", "/api/settings/api-tokens"],
      ["PATCH", `/api/settings/api-tokens/0123456789abcdef`],
      ["DELETE", `/api/settings/api-tokens/0123456789abcdef`],
      ["GET", "/api/terminal/info"],
      ["PUT", "/api/settings/preferences"],
      ["GET", "/api/docker/containers"],
      ["GET", "/api/ports"],
      ["GET", "/api/audit"],
      ["GET", "/api/alerts"],
      ["GET", "/api/certificates"],
      ["GET", "/api/onboarding"],
      ["GET", "/api/health/scan"],
      ["GET", "/api/timezone"],
      ["GET", "/api/fs/dirs"],
    ];
    for (const profile of ["soA", "soAcria", "vazio"] as const) {
      for (const [method, url] of mustBe403) {
        const res = await panel.app.inject({
          method: method as "GET",
          url,
          headers: { authorization: `Bearer ${tokens[profile]}` },
          ...(method === "GET" || method === "DELETE" ? {} : { payload: {} }),
        });
        expect(`${res.statusCode} ${method} ${url} ${profile}`).toBe(`403 ${method} ${url} ${profile}`);
        expect(res.json().error).toBe("token_forbidden");
      }
    }
  });

  it("o painel inteiro continua chegando às rotas do painel (Fase 0 intacta) e a lista de exclusão vale até para ele", async () => {
    const mail = await call(tokens.painel, "GET /api/mail/domains", A);
    expect(outcomeOf(mail)).toBe("reached");
    const env = await call(tokens.painel, "GET /api/projects/:id/env", A);
    expect(outcomeOf(env)).toBe("forbidden");
    const tokensList = await call(tokens.painel, "GET /api/settings/api-tokens", A);
    expect(outcomeOf(tokensList)).toBe("forbidden");
  });

  it("projeto fora do alcance: o 404 é IDÊNTICO ao de inexistente (corpo e cabeçalhos), em toda rota de projeto", async () => {
    const strip = (headers: Record<string, unknown>) => {
      const { date: _d, ...rest } = headers;
      return rest;
    };
    let compared = 0;
    for (const key of ROUTES) {
      const reach = EXPECTED_ROUTE_REACH[key];
      if (reach !== "project" && reach !== "target") continue;
      for (const profile of ["soA", "soAcria", "vazio"] as const) {
        const outside = await call(tokens[profile], key, B);
        const missing = await call(tokens[profile], key, MISSING);
        expect(outside.statusCode, `${key} ${profile}`).toBe(404);
        expect(outside.body, `${key} ${profile}`).toBe(missing.body);
        expect(strip(outside.headers), `${key} ${profile}`).toEqual(strip(missing.headers));
        expect(outside.json()).toEqual({ error: "project_not_found", message: "Projeto não encontrado." });
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(60);
  });

  it("o id do projeto em outra grafia (maiúsculas, espaços, codificado, apelido) não vale: 404", async () => {
    for (const variant of [A.toUpperCase(), ` ${A}`, `${A}%20`, "fazenda", `%2e%2e/${A}`, `${A}/..`]) {
      const res = await panel.app.inject({
        method: "GET",
        url: `/api/projects/${variant}/jobs`,
        headers: { authorization: `Bearer ${tokens.soA}` },
      });
      expect([400, 403, 404], variant).toContain(res.statusCode);
      expect(res.json().reached, variant).toBeUndefined();
    }
  });

  it("rota desconhecida em execução continua negada para token limitado (falha fechada)", async () => {
    for (const method of ["GET", "POST"] as const) {
      const res = await panel.app.inject({
        method,
        url: "/api/rota-nova-sem-decisao",
        headers: { authorization: `Bearer ${tokens.soA}` },
        ...(method === "POST" ? { payload: {} } : {}),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("token_forbidden");
    }
  });

  it("o nível continua valendo dentro do alcance: token de leitura limitado ao projeto A não escreve nele", async () => {
    const read = (await panel.createToken({ name: "leitor-a", scope: "read", reach: "projects", projects: [A] })).token;
    const ok = await call(read, "GET /api/projects/:id", A);
    expect(outcomeOf(ok)).toBe("reached");
    const write = await call(read, "POST /api/projects/:id/stop", A);
    expect(write.statusCode).toBe(403);
    expect(write.json().error).toBe("insufficient_scope");
    // fora do alcance continua 404, mesmo pedindo coisa que o nível não cobre (nada de pista)
    const outside = await call(read, "POST /api/projects/:id/stop", B);
    expect(outside.statusCode).toBe(404);
  });
});
