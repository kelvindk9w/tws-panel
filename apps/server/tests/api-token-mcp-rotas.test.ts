/**
 * api-token-mcp-rotas.test.ts — criação e edição de tokens com as opções do MCP e a validade ilimitada
 * (painel real): ligar poder pede senha, desligar não, ilimitado pede confirmação, tudo na Auditoria.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PASSWORD, startRealPanel, type RealPanel } from "./helpers/real-panel.js";

let panel: RealPanel;
const human = () => ({ cookie: panel.cookie });
const create = (payload: Record<string, unknown>) =>
  panel.app.inject({ method: "POST", url: "/api/settings/api-tokens", headers: human(), payload: { scope: "read", currentPassword: PASSWORD, ...payload } });
const patch = (id: string, payload: Record<string, unknown>, headers: Record<string, string> = human()) =>
  panel.app.inject({ method: "PATCH", url: `/api/settings/api-tokens/${id}/mcp`, headers, payload });
const audit = async () => (await panel.app.inject({ method: "GET", url: "/api/audit?perPage=200", headers: human() })).json().entries as { action: string; detail: string }[];

beforeAll(async () => {
  panel = await startRealPanel();
}, 120_000);
afterAll(async () => panel.close());

describe("validade", () => {
  it("as escolhas da tela (1 a 365 dias) valem; acima de um ano em horas é recusado", async () => {
    for (const [i, days] of [1, 7, 15, 30, 90, 180, 365].entries()) {
      const res = await create({ name: `v${i}`, expiresInHours: days * 24 });
      expect(res.statusCode, String(days)).toBe(201);
      const horas = (Date.parse(res.json().info.expiresAt) - Date.now()) / 3_600_000;
      expect(Math.round(horas)).toBe(days * 24);
      expect(res.json().info.neverExpires).toBe(false);
    }
    expect((await create({ name: "longo", expiresInHours: 366 * 24 })).statusCode).toBe(400);
    expect((await create({ name: "zero", expiresInHours: 0 })).statusCode).toBe(400);
  });

  it("sem informar nada vale 30 dias", async () => {
    const res = await create({ name: "padrao" });
    expect(Math.round((Date.parse(res.json().info.expiresAt) - Date.now()) / 86_400_000)).toBe(30);
  });

  it("ilimitado pede a confirmação explícita e a senha; o token funciona e a Auditoria diz que não vence", async () => {
    const sem = await create({ name: "eterno", neverExpires: true });
    expect(sem.statusCode).toBe(400);
    expect(sem.json().error).toBe("never_expires_not_confirmed");
    const falsa = await create({ name: "eterno", neverExpires: true, confirmNeverExpires: false });
    expect(falsa.statusCode).toBe(400);
    const senhaErrada = await create({ name: "eterno", neverExpires: true, confirmNeverExpires: true, currentPassword: "errada" });
    expect(senhaErrada.statusCode).toBe(401);
    const ok = await create({ name: "eterno", neverExpires: true, confirmNeverExpires: true });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().info).toMatchObject({ neverExpires: true, status: "active", expiresAt: "9999-12-31T23:59:59.999Z" });
    const uso = await panel.app.inject({ method: "GET", url: "/api/version", headers: { authorization: `Bearer ${ok.json().token}` } });
    expect(uso.statusCode).toBe(200);
    expect((await audit()).some((e) => e.action === "auth.api_token_created" && e.detail.includes("SEM vencimento"))).toBe(true);
  });

  it("ilimitado vence a validade em horas informada junto", async () => {
    const res = await create({ name: "eterno-2", neverExpires: true, confirmNeverExpires: true, expiresInHours: 5 });
    expect(res.json().info.neverExpires).toBe(true);
  });
});

describe("opções do MCP na criação", () => {
  it("desligadas por padrão; as ligadas aparecem na lista e na Auditoria", async () => {
    const padrao = await create({ name: "mcp-padrao" });
    expect(padrao.json().info.mcp).toEqual({ securityApply: false, secretsRead: false, skipApproval: false, metrics: false });
    const ligadas = await create({ name: "mcp-ligado", scope: "admin", mcp: { secretsRead: true, skipApproval: true } });
    expect(ligadas.json().info.mcp).toEqual({ securityApply: false, secretsRead: true, skipApproval: true, metrics: false });
    const lista = (await panel.app.inject({ method: "GET", url: "/api/settings/api-tokens", headers: human() })).json().tokens as any[];
    expect(lista.find((t) => t.name === "mcp-ligado").mcp.secretsRead).toBe(true);
    expect((await audit()).some((e) => e.action === "auth.api_token_created" && e.detail.includes("opções do MCP ligadas: secretsRead, skipApproval"))).toBe(true);
    expect((await audit()).some((e) => e.action === "auth.api_token_created" && e.detail.includes("opções do MCP: todas desligadas"))).toBe(true);
  });

  it("opção desconhecida é recusada", async () => {
    expect((await create({ name: "mcp-ruim", mcp: { tudo: true } })).statusCode).toBe(400);
    expect((await create({ name: "mcp-ruim-2", mcp: { metrics: "sim" } })).statusCode).toBe(400);
  });
});

describe("PATCH /api/settings/api-tokens/:id/mcp", () => {
  it("ligar uma opção pede senha (e erra sem ela); desligar não pede", async () => {
    const id = (await create({ name: "edita" })).json().info.id as string;
    expect((await patch(id, { mcp: { secretsRead: true } })).statusCode).toBe(401);
    expect((await patch(id, { mcp: { secretsRead: true }, currentPassword: "errada" })).statusCode).toBe(401);
    const ligou = await patch(id, { mcp: { secretsRead: true, metrics: true }, currentPassword: PASSWORD });
    expect(ligou.statusCode).toBe(200);
    expect(ligou.json().info.mcp).toEqual({ securityApply: false, secretsRead: true, skipApproval: false, metrics: true });
    // desligar sem senha; campo ausente não muda
    const desligou = await patch(id, { mcp: { secretsRead: false } });
    expect(desligou.statusCode).toBe(200);
    expect(desligou.json().info.mcp).toEqual({ securityApply: false, secretsRead: false, skipApproval: false, metrics: true });
    // "ligar" o que já está ligado não é aumentar poder
    expect((await patch(id, { mcp: { metrics: true } })).statusCode).toBe(200);
    expect((await patch(id, { mcp: {} })).statusCode).toBe(200);
    const eventos = (await audit()).filter((e) => e.action === "auth.api_token_mcp_changed");
    expect(eventos.some((e) => e.detail.includes("todas desligadas →") && e.detail.includes("secretsRead, metrics"))).toBe(true);
  });

  it("token (mesmo admin) nunca edita as opções; token inexistente, revogado ou vencido dão 404", async () => {
    const admin = await create({ name: "admin-ia", scope: "admin" });
    const id = admin.json().info.id as string;
    const viaToken = await patch(id, { mcp: { skipApproval: true }, currentPassword: PASSWORD }, { authorization: `Bearer ${admin.json().token}` });
    expect(viaToken.statusCode).toBe(403);
    expect((await patch("ffffffffffffffff", { mcp: { metrics: true }, currentPassword: PASSWORD })).statusCode).toBe(404);
    expect((await patch("não-é-hex", { mcp: {} })).statusCode).toBe(400);
    await panel.app.inject({ method: "DELETE", url: `/api/settings/api-tokens/${id}`, headers: human() });
    expect((await patch(id, { mcp: { metrics: true }, currentPassword: PASSWORD })).statusCode).toBe(404);
  });

  it("falhas do cadastro: edição concorrente 409, disco 500, ilegível 503", async () => {
    const id = (await create({ name: "falhas" })).json().info.id as string;
    const store = panel.app.apiTokens;
    const concorrente = vi.spyOn(store, "updateMcp").mockRejectedValueOnce(Object.assign(new Error("mudou"), { statusCode: 409, code: "token_mcp_changed" }));
    expect((await patch(id, { mcp: { metrics: true }, currentPassword: PASSWORD })).statusCode).toBe(409);
    concorrente.mockRestore();
    const disco = vi.spyOn(store, "updateMcp").mockRejectedValueOnce(Object.assign(new Error("x"), { statusCode: 500, code: "storage_write_failed" }));
    expect((await patch(id, { mcp: { metrics: true }, currentPassword: PASSWORD })).statusCode).toBe(500);
    disco.mockRestore();
    const sumiu = vi.spyOn(store, "updateMcp").mockResolvedValueOnce(null);
    expect((await patch(id, { mcp: { metrics: true }, currentPassword: PASSWORD })).statusCode).toBe(404);
    sumiu.mockRestore();
    const lista = vi.spyOn(store, "list").mockRejectedValueOnce(new Error("disco"));
    expect((await patch(id, { mcp: { metrics: true }, currentPassword: PASSWORD })).statusCode).toBe(503);
    lista.mockRestore();
    const inesperado = vi.spyOn(store, "updateMcp").mockRejectedValueOnce(new Error("boom"));
    expect((await patch(id, { mcp: { metrics: true }, currentPassword: PASSWORD })).statusCode).toBe(500);
    inesperado.mockRestore();
  });
});

describe("liga/desliga do MCP (Configurações)", () => {
  it("desligar não pede senha; ligar de novo pede; repetir o mesmo estado não grava nem audita de novo", async () => {
    const put = (payload: Record<string, unknown>) => panel.app.inject({ method: "PUT", url: "/api/settings/mcp", headers: human(), payload });
    expect((await put({ enabled: true, currentPassword: PASSWORD })).json()).toEqual({ enabled: true, path: "/mcp" });
    expect((await put({ enabled: true, currentPassword: PASSWORD })).statusCode).toBe(200);
    expect((await put({ enabled: false })).json().enabled).toBe(false);
    expect((await put({ enabled: false })).statusCode).toBe(200);
    expect((await put({ enabled: true })).statusCode).toBe(401);
    expect((await panel.app.inject({ method: "GET", url: "/api/settings/mcp", headers: human() })).json().enabled).toBe(false);
    const eventos = (await audit()).filter((e) => e.action === "mcp.enabled" || e.action === "mcp.disabled").map((e) => e.action);
    expect(eventos.filter((a) => a === "mcp.enabled")).toHaveLength(1);
    expect(eventos.filter((a) => a === "mcp.disabled")).toHaveLength(1);
  });

  it("falha ao gravar: nada fica ligado e a resposta explica", async () => {
    const falha = vi.spyOn(panel.app.mcpSettings, "set").mockRejectedValueOnce(new Error("disco cheio"));
    const res = await panel.app.inject({ method: "PUT", url: "/api/settings/mcp", headers: human(), payload: { enabled: true, currentPassword: PASSWORD } });
    falha.mockRestore();
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("storage_write_failed");
    expect(panel.app.mcpSettings.enabled()).toBe(false);
  });

  it("sem sessão, nada", async () => {
    expect((await panel.app.inject({ method: "GET", url: "/api/settings/mcp" })).statusCode).toBe(401);
    expect((await panel.app.inject({ method: "GET", url: "/api/mcp/approvals" })).statusCode).toBe(401);
  });
});
