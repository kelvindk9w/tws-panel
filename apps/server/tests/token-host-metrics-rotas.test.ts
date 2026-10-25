/**
 * token-host-metrics-rotas.test.ts — a opção "pode ver o monitoramento da VPS"
 * pelas rotas de tokens (painel real, sem Docker): criar, ligar (pede senha e,
 * com 2FA, código), desligar (sem senha, vale na hora), token de painel não
 * aceita, e o que a opção abre e o que NÃO abre.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PASSWORD, startRealPanel, type RealPanel } from "./helpers/real-panel.js";

vi.mock("../src/services/docker-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/docker-service.js")>()),
  listContainers: async () => [],
}));

let panel: RealPanel;
let A = "";
const human = () => ({ cookie: panel.cookie });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const patch = (id: string, payload: Record<string, unknown>, headers: Record<string, string> = human()) =>
  panel.app.inject({ method: "PATCH", url: `/api/settings/api-tokens/${id}`, headers, payload });
const info = async (id: string) =>
  ((await panel.app.inject({ method: "GET", url: "/api/settings/api-tokens", headers: human() })).json().tokens as Array<Record<string, any>>).find((t) => t.id === id)!;

beforeAll(async () => {
  panel = await startRealPanel();
  A = await panel.createProject("Fazenda", "fazenda.example.com");
}, 120_000);
afterAll(async () => panel.close());

describe("criação", () => {
  it("padrão desligada; com a opção, a lista mostra ligada", async () => {
    const off = await panel.createToken({ name: "sem-opcao", scope: "read", reach: "projects", projects: [A] });
    expect(off.status).toBe(201);
    expect(off.json.info.hostMetrics).toBe(false);
    const on = await panel.createToken({ name: "com-opcao", scope: "read", reach: "projects", projects: [A], hostMetrics: true });
    expect(on.status).toBe(201);
    expect((await info(on.id)).hostMetrics).toBe(true);
  });

  it("token de painel inteiro com a opção: 400 invalid_token_reach", async () => {
    const res = await panel.createToken({ name: "painel-opcao", scope: "read", reach: "panel", hostMetrics: true });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("invalid_token_reach");
  });

  it("a auditoria registra a opção, sem o valor do token", async () => {
    const t = await panel.createToken({ name: "auditado", scope: "read", reach: "projects", projects: [A], hostMetrics: true });
    const audit = (await panel.app.inject({ method: "GET", url: "/api/audit", headers: human() })).json();
    const entry = (audit.entries as Array<{ action: string; detail: string }>).find((e) => e.action === "auth.api_token_created" && e.detail.includes("auditado"))!;
    expect(entry.detail).toContain("pode ver o monitoramento da VPS");
    expect(entry.detail).not.toContain(t.token);
  });
});

describe("edição", () => {
  it("ligar pede a senha (401 sem ela ou errada, nada muda); com a senha liga", async () => {
    const made = await panel.createToken({ name: "ligar", scope: "read", reach: "projects", projects: [A] });
    for (const extra of [{}, { currentPassword: "errada" }]) {
      const res = await patch(made.id, { projects: [A], canCreate: false, hostMetrics: true, ...extra });
      expect(res.statusCode).toBe(401);
    }
    expect((await info(made.id)).hostMetrics).toBe(false);
    const ok = await patch(made.id, { projects: [A], canCreate: false, hostMetrics: true, currentPassword: PASSWORD });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().info.hostMetrics).toBe(true);
  });

  it("desligar não pede senha e vale no pedido seguinte", async () => {
    const made = await panel.createToken({ name: "desligar", scope: "read", reach: "projects", projects: [A], hostMetrics: true });
    const res = await patch(made.id, { projects: [A], canCreate: false, hostMetrics: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().info.hostMetrics).toBe(false);
    expect((await panel.app.inject({ method: "GET", url: "/api/metrics/summary", headers: bearer(made.token) })).statusCode).toBe(403);
  });

  it("cliente antigo (sem o campo) não liga nem desliga a opção sem querer", async () => {
    const made = await panel.createToken({ name: "preserva", scope: "read", reach: "projects", projects: [A], hostMetrics: true });
    const res = await patch(made.id, { projects: [A], canCreate: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().info.hostMetrics).toBe(true);
  });

  it("cliente antigo (sem o campo) com a opção desligada não a liga e não pede senha", async () => {
    const made = await panel.createToken({ name: "antigo-desligado", scope: "read", reach: "projects", projects: [A] });
    const res = await patch(made.id, { projects: [A], canCreate: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().info.hostMetrics).toBe(false);
    expect((await info(made.id)).hostMetrics).toBe(false);
    expect((await panel.app.inject({ method: "GET", url: "/api/metrics/summary", headers: bearer(made.token) })).statusCode).toBe(403);
  });

  it("repetir a opção já ligada não pede senha (não aumentou nada)", async () => {
    const made = await panel.createToken({ name: "repete", scope: "read", reach: "projects", projects: [A], hostMetrics: true });
    expect((await patch(made.id, { projects: [A], canCreate: false, hostMetrics: true })).statusCode).toBe(200);
  });

  it("um token não edita a opção de nenhum token (nem o próprio)", async () => {
    const adm = await panel.createToken({ name: "admin-edita", scope: "admin", reach: "panel" });
    const res = await patch(adm.id, { projects: [A], canCreate: false, hostMetrics: true, currentPassword: PASSWORD }, bearer(adm.token));
    expect(res.statusCode).toBe(403);
  });
});
