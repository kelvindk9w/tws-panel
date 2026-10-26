/**
 * mcp-unidades.test.ts — peças pequenas do MCP sem painel: pedidos de aprovação (prazo, fila cheia, uso único),
 * validador de argumentos e o liga/desliga em disco.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MCP_APPROVAL_MAX } from "@paas/core";
import { McpApprovals, approvalDigest } from "../src/services/mcp-approvals.js";
import { validateMcpArgs, type McpSchema } from "../src/services/mcp-validate.js";
import { McpSettings } from "../src/services/mcp-settings.js";

const input = (over: Partial<Parameters<McpApprovals["request"]>[0]> = {}) => ({
  tokenId: "t1",
  tokenName: "ia",
  client: "cli",
  tool: "recreate_project",
  args: { project: "a" },
  ...over,
});

describe("McpApprovals", () => {
  let now: number;
  let approvals: McpApprovals;
  beforeEach(() => {
    now = 1_000_000;
    approvals = new McpApprovals(() => now, 60_000);
  });

  it("ciclo completo: pede, aprova, gasta uma vez só", () => {
    const info = approvals.request(input())!;
    expect(info.status).toBe("pending");
    expect(approvals.pendingCount()).toBe(1);
    expect(approvals.consume(info.id, "t1", "recreate_project", { project: "a" })).toEqual({ ok: false, status: "pending" });
    expect(approvals.decide(info.id, "approved").ok).toBe(true);
    expect(approvals.decide(info.id, "rejected")).toEqual({ ok: false, reason: "not_pending" });
    expect(approvals.consume(info.id, "t1", "recreate_project", { project: "a" })).toEqual({ ok: true });
    expect(approvals.consume(info.id, "t1", "recreate_project", { project: "a" })).toEqual({ ok: false, status: "used" });
  });

  it("argumentos (em qualquer ordem de chaves), ferramenta ou token diferentes não gastam a aprovação", () => {
    const info = approvals.request(input({ args: { b: 1, a: [1, { y: 2, x: undefined }] } }))!;
    approvals.decide(info.id, "approved");
    expect(approvals.consume(info.id, "t1", "recreate_project", { b: 2, a: [1] })).toEqual({ ok: false, status: "mismatch" });
    expect(approvals.consume(info.id, "t1", "security_apply", { b: 1, a: [1, { y: 2 }] })).toEqual({ ok: false, status: "mismatch" });
    expect(approvals.consume(info.id, "t2", "recreate_project", { b: 1, a: [1, { y: 2 }] })).toEqual({ ok: false, status: "not_found" });
    expect(approvals.consume("nao-existe", "t1", "recreate_project", {})).toEqual({ ok: false, status: "not_found" });
    expect(approvals.consume(info.id, "t1", "recreate_project", { a: [1, { y: 2 }], b: 1 })).toEqual({ ok: true });
    expect(approvalDigest("x", null)).toBe(approvalDigest("x", null));
  });

  it("recusado não vale; só o dono do pedido o enxerga pelo statusFor", () => {
    const info = approvals.request(input())!;
    expect(approvals.statusFor(info.id, "t2")).toBeNull();
    expect(approvals.statusFor(info.id, "t1")?.status).toBe("pending");
    approvals.decide(info.id, "rejected");
    expect(approvals.consume(info.id, "t1", "recreate_project", { project: "a" })).toEqual({ ok: false, status: "rejected" });
    expect(approvals.decide("nao-existe", "approved")).toEqual({ ok: false, reason: "not_found" });
  });

  it("vence: pendente e aprovada passam a expired; aprovar dá mais um prazo inteiro", () => {
    const pendente = approvals.request(input())!;
    const aprovada = approvals.request(input({ args: { project: "b" } }))!;
    now += 50_000;
    approvals.decide(aprovada.id, "approved");
    now += 30_000;
    expect(approvals.statusFor(pendente.id, "t1")?.status).toBe("expired");
    expect(approvals.statusFor(aprovada.id, "t1")?.status).toBe("approved");
    expect(approvals.decide(pendente.id, "approved")).toEqual({ ok: false, reason: "not_pending" });
    now += 40_000;
    expect(approvals.consume(aprovada.id, "t1", "recreate_project", { project: "b" })).toEqual({ ok: false, status: "expired" });
  });

  it("lista: pendentes primeiro, depois as decididas, mais novas antes", () => {
    const a = approvals.request(input({ args: { n: 1 } }))!;
    const b = approvals.request(input({ args: { n: 2 } }))!;
    const c = approvals.request(input({ args: { n: 3 } }))!;
    approvals.decide(a.id, "rejected");
    approvals.decide(b.id, "rejected");
    expect(approvals.list().map((i) => i.id)).toEqual([c.id, b.id, a.id]);
  });

  it("fila cheia: abre vaga tirando uma decidida; só pendentes = recusa", () => {
    // um token por pedido: o teto por token (5) não atrapalha o teto global (50)
    const first = approvals.request(input({ tokenId: "t0", args: { n: 0 } }))!;
    for (let i = 1; i < MCP_APPROVAL_MAX; i++) expect(approvals.request(input({ tokenId: `t${i}`, args: { n: i } }))).not.toBeNull();
    expect(approvals.request(input({ tokenId: "tx", args: { n: "extra" } }))).toBeNull();
    approvals.decide(first.id, "rejected");
    expect(approvals.request(input({ tokenId: "tx", args: { n: "extra" } }))).not.toBeNull();
    expect(approvals.statusFor(first.id, "t0")).toBeNull();
    expect(approvals.list()).toHaveLength(MCP_APPROVAL_MAX);
  });

  it("usa o relógio e o prazo padrões quando não recebe nada", () => {
    const real = new McpApprovals();
    const info = real.request(input())!;
    expect(Date.parse(info.expiresAt) - Date.parse(info.createdAt)).toBeGreaterThan(0);
  });
});

describe("validateMcpArgs", () => {
  const schema: McpSchema = {
    type: "object",
    required: ["name"],
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 2, maxLength: 5, pattern: "^[a-z]+$" },
      count: { type: "integer", minimum: 1, maximum: 3 },
      ratio: { type: "number" },
      mode: { enum: ["a", "b"] },
      tags: { type: "array", maxItems: 2, items: { type: "string" } },
      either: { type: ["string", "null"] },
    },
  };

  it("aceita o que cumpre o esquema", () => {
    expect(validateMcpArgs(schema, { name: "abc", count: 2, ratio: 1.5, mode: "a", tags: ["x"], either: null })).toBeNull();
    expect(validateMcpArgs(schema, { name: "abc", ratio: 2 })).toBeNull();
    expect(validateMcpArgs({}, 42)).toBeNull();
  });

  it("recusa cada tipo de problema sem repetir o valor recebido", () => {
    const cases: Array<[unknown, RegExp]> = [
      ["texto", /tipo inválido/],
      [null, /tipo inválido/],
      [[], /tipo inválido/],
      [{}, /falta o campo "name"/],
      [{ name: "a" }, /curto demais/],
      [{ name: "abcdefg" }, /longo demais/],
      [{ name: "ABC" }, /formato inválido/],
      [{ name: "abc", count: 0 }, /menor que o mínimo/],
      [{ name: "abc", count: 9 }, /maior que o máximo/],
      [{ name: "abc", count: 1.5 }, /tipo inválido/],
      [{ name: "abc", mode: "z" }, /fora da lista/],
      [{ name: "abc", tags: ["a", "b", "c"] }, /itens demais/],
      [{ name: "abc", tags: [1] }, /argumentos\.tags\[0\]: tipo inválido/],
      [{ name: "abc", extra: 1 }, /campo desconhecido "extra"/],
      [{ name: "abc", either: 5 }, /tipo inválido/],
    ];
    for (const [value, expected] of cases) {
      const problem = validateMcpArgs(schema, value);
      expect(problem, JSON.stringify(value)).toMatch(expected);
    }
    expect(validateMcpArgs(schema, { name: "abc", ["x".repeat(100)]: 1 })).not.toContain("x".repeat(60));
  });

  it("campo desconhecido passa quando o esquema não o proíbe", () => {
    expect(validateMcpArgs({ type: "object", properties: {} }, { qualquer: 1 })).toBeNull();
  });
});

describe("McpSettings", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "paas-mcp-settings-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("sem arquivo, com lixo ou com formato estranho: desligado", async () => {
    expect(await new McpSettings(dir).load()).toBe(false);
    await writeFile(path.join(dir, "mcp-settings.json"), "isto não é json");
    expect(await new McpSettings(dir).load()).toBe(false);
    await writeFile(path.join(dir, "mcp-settings.json"), JSON.stringify({ enabled: "sim" }));
    expect(await new McpSettings(dir).load()).toBe(false);
    await writeFile(path.join(dir, "mcp-settings.json"), "null");
    expect(await new McpSettings(dir).load()).toBe(false);
  });

  it("grava e lê de volta; antes de ler está desligado", async () => {
    const settings = new McpSettings(dir);
    expect(settings.enabled()).toBe(false);
    expect(await settings.set(true)).toBe(true);
    expect(settings.enabled()).toBe(true);
    expect(JSON.parse(await readFile(path.join(dir, "mcp-settings.json"), "utf8"))).toEqual({ enabled: true });
    const other = new McpSettings(dir);
    expect(other.enabled()).toBe(false);
    expect(await other.load()).toBe(true);
  });

  it("falha de gravação lança e a memória não muda; falha de leitura mantém o último valor", async () => {
    const settings = new McpSettings(dir);
    await settings.set(true);
    const file = (settings as unknown as { file: { update: () => Promise<void>; read: () => Promise<unknown> } }).file;
    vi.spyOn(file, "update").mockRejectedValueOnce(new Error("disco cheio"));
    await expect(settings.set(false)).rejects.toThrow("disco cheio");
    expect(settings.enabled()).toBe(true);
    vi.spyOn(file, "read").mockRejectedValueOnce(new Error("ilegível"));
    expect(await settings.load()).toBe(true);
  });
});
