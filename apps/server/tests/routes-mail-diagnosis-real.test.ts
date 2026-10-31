/**
 * Diagnóstico de e-mail no painel REAL (plugin de e-mail de verdade, sem Docker): a fiação das rotas, o 409 do
 * teste de conexão com o e-mail desligado, o limite de 6 pedidos por minuto e a política de tokens (teste de
 * conexão nunca por token; leitura do diagnóstico e das recusas só dentro do alcance).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startRealPanel, type RealPanel } from "./helpers/real-panel.js";

vi.mock("../src/services/docker-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/docker-service.js")>()),
  listContainers: async () => [],
}));

let panel: RealPanel;
let A = "";
let B = "";
const MISSING = "0000000000000000";

beforeAll(async () => {
  panel = await startRealPanel();
  A = await panel.createProject("Loja", "loja.example.com");
  B = await panel.createProject("Blog", "blog.example.com");
}, 120_000);

afterAll(async () => {
  await panel.close();
});

const call = (method: "GET" | "POST", url: string, headers: Record<string, string>) => panel.app.inject({ method, url, headers });
const human = () => ({ cookie: panel.cookie });

describe("rotas de diagnóstico no painel real", () => {
  it("diagnóstico de projeto sem e-mail: explica e não afirma nada do Laravel", async () => {
    const res = await call("GET", `/api/projects/${A}/email/diagnostico`, human());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ windowHours: 24, noSendsRecent: true, notices: [], lastAttempt: null });
    expect(res.json().hints.map((h: { code: string }) => h.code)).toEqual(["email_disabled"]);
  });

  it("recusas: do projeto e global, vazias sem servidor de e-mail", async () => {
    for (const url of [`/api/projects/${A}/email/recusas`, "/api/mail/envios/recusas"]) {
      const res = await call("GET", url, human());
      expect(res.statusCode, url).toBe(200);
      expect(res.json()).toMatchObject({ items: [], total: 0, retentionDays: 30, serverCreated: false });
    }
  });

  it("projeto inexistente: 404", async () => {
    expect((await call("GET", `/api/projects/${MISSING}/email/diagnostico`, human())).statusCode).toBe(404);
    expect((await call("POST", `/api/projects/${MISSING}/email/testar-conexao`, human())).statusCode).toBe(404);
  });

  it("testar conexão com o e-mail desligado: 409 traduzido, sem rede", async () => {
    const res = await call("POST", `/api/projects/${A}/email/testar-conexao`, human());
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("email_not_enabled");
  });

  it("token de API: o teste de conexão é negado para qualquer escopo; leitura respeita o alcance", async () => {
    const admin = await panel.createToken({ name: "admin", scope: "admin", reach: "panel" });
    const read = await panel.createToken({ name: "leitura", scope: "read", reach: "panel" });
    const onlyA = await panel.createToken({ name: "so-a", scope: "read", reach: "projects", projects: [A] });
    const bearer = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });
    expect((await call("POST", `/api/projects/${A}/email/testar-conexao`, bearer(admin))).statusCode).toBe(403);
    expect((await call("POST", `/api/projects/${A}/email/testar-conexao`, bearer(onlyA))).statusCode).toBe(403);
    expect((await call("GET", `/api/projects/${A}/email/diagnostico`, bearer(read))).statusCode).toBe(200);
    expect((await call("GET", `/api/projects/${A}/email/diagnostico`, bearer(onlyA))).statusCode).toBe(200);
    expect((await call("GET", `/api/projects/${B}/email/diagnostico`, bearer(onlyA))).statusCode).toBe(404);
    expect((await call("GET", `/api/projects/${B}/email/recusas`, bearer(onlyA))).statusCode).toBe(404);
    // a lista global das recusas é do painel inteiro
    expect((await call("GET", "/api/mail/envios/recusas", bearer(read))).statusCode).toBe(200);
    expect((await call("GET", "/api/mail/envios/recusas", bearer(onlyA))).statusCode).toBe(403);
  });

  it("limite de 6 testes por minuto: 429", async () => {
    let limited = 0;
    for (let i = 0; i < 10; i++) {
      if ((await call("POST", `/api/projects/${A}/email/testar-conexao`, human())).statusCode === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });
});
