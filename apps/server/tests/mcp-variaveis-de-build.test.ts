/**
 * mcp-variaveis-de-build.test.ts — a mescla do MCP convive com a marca "de build" (#113): não a perde, a tela de
 * aprovação avisa que o valor novo vai para o JavaScript público, a Auditoria cita os nomes marcados, o MCP não grava a marca.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PASSWORD, startRealPanel, type RealPanel } from "./helpers/real-panel.js";
import { McpSession, enableMcp } from "./helpers/mcp-client.js";
import { ProjectEnvStore } from "../src/services/project-env.js";

vi.mock("../src/services/docker-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/docker-service.js")>()),
  listContainers: async () => [],
}));

let panel: RealPanel;
let A = "";
let session: McpSession;
const human = () => ({ cookie: panel.cookie });

beforeAll(async () => {
  panel = await startRealPanel();
  A = await panel.createProject("Fazenda", "fazenda.example.com");
  expect(await enableMcp(panel)).toBe(200);
  const t = await panel.createToken({ name: "escrita", scope: "write", reach: "projects", projects: [A] });
  session = new McpSession(panel.app, t.token);
  await session.initialize("c");
}, 120_000);
afterAll(async () => panel.close());

describe("ProjectEnvStore.merge e a marca de build", () => {
  it("preserva a marca de quem já existe, não marca a nova e honra um `build: true` explícito", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paas-env-build-"));
    try {
      const store = new ProjectEnvStore(dir);
      await store.set("p", [{ key: "NEXT_PUBLIC_URL", value: "https://a.example.com", build: true }, { key: "SEGREDO", value: "x1" }]);
      const depois = await store.merge("p", [{ key: "NEXT_PUBLIC_URL", value: "https://b.example.com" }, { key: "NOVA", value: "n" }], { allowOverwrite: true });
      expect(depois.find((v) => v.key === "NEXT_PUBLIC_URL")).toEqual({ key: "NEXT_PUBLIC_URL", value: "https://b.example.com", build: true });
      expect(depois.find((v) => v.key === "SEGREDO")).toEqual({ key: "SEGREDO", value: "x1" });
      expect(depois.find((v) => v.key === "NOVA")).toEqual({ key: "NOVA", value: "n" });
      expect(await store.buildRecord("p")).toEqual({ NEXT_PUBLIC_URL: "https://b.example.com" });
      // marca explícita `true` marca; tirar a marca é com a tela (setEnv)
      const marcou = await store.merge("p", [{ key: "SEGREDO", value: "x1", build: true }], { allowOverwrite: true });
      expect(marcou.find((v) => v.key === "SEGREDO")?.build).toBe(true);
      // sem allowOverwrite, trocar o valor de uma marcada ainda é recusado
      await store.merge("p", [{ key: "OUTRA_PUBLICA", value: "1", build: true }], { allowOverwrite: true });
      await expect(store.merge("p", [{ key: "OUTRA_PUBLICA", value: "2" }], { allowOverwrite: false })).rejects.toMatchObject({ code: "env_changed" });
      expect((await store.get("p")).find((v) => v.key === "OUTRA_PUBLICA")?.build).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe("MCP e variáveis de build", () => {
  it("trocar uma variável de build pede aprovação com alerta, mantém a marca e a Auditoria cita o nome", async () => {
    await panel.app.deployService.setEnv(A, [{ key: "VITE_API_URL", value: "https://api.example.com", build: true }]);
    const args = { projectId: A, vars: [{ key: "VITE_API_URL", value: "https://outra.example.com" }] };
    const pedido = await session.tool("set_env_vars", args);
    expect(pedido.data.status).toBe("approval_required");
    const lista = (await panel.app.inject({ method: "GET", url: "/api/mcp/approvals", headers: human() })).json().approvals as { id: string; args: Record<string, string> }[];
    const tela = lista.find((a) => a.id === pedido.data.approvalId)!;
    expect(tela.args.variables).toContain("ALERTA: variável de build");
    expect(tela.args.values).toContain("VITE_API_URL");
    expect(tela.args.values).toContain("https://outra.example.com");
    expect(JSON.stringify(tela.args)).not.toContain("api.example.com");
    const ok = await panel.app.inject({ method: "POST", url: `/api/mcp/approvals/${pedido.data.approvalId}/approve`, headers: human(), payload: { currentPassword: PASSWORD } });
    expect(ok.statusCode).toBe(200);
    expect((await session.tool("set_env_vars", { ...args, approvalId: pedido.data.approvalId })).isError).toBe(false);
    const env = await panel.app.deployService.getEnv(A);
    expect(env.find((v) => v.key === "VITE_API_URL")).toEqual({ key: "VITE_API_URL", value: "https://outra.example.com", build: true });
    const audit = (await panel.app.inject({ method: "GET", url: "/api/audit?perPage=200", headers: human() })).json().entries as { action: string; detail: string }[];
    expect(audit.some((e) => e.action === "project.env_updated" && e.detail.includes('Marcadas "de build": VITE_API_URL'))).toBe(true);
    expect(JSON.stringify(audit)).not.toContain("outra.example.com");
  });

  it("o MCP não grava a marca: o campo 'build' é recusado pelo esquema", async () => {
    const res = await session.tool("set_env_vars", { projectId: A, vars: [{ key: "X_R8", value: "1", build: true }] });
    expect(res.isError).toBe(true);
    expect(res.data.error).toBe("invalid_arguments");
  });

  it("o log de deploy pelo MCP mascara também o valor das variáveis de build", async () => {
    await panel.app.deployService.setEnv(A, [{ key: "VITE_CHAVE_PUBLICA", value: "valor-de-build-123456", build: true }]);
    const job = { id: "jb", projectId: A, status: "success", log: ["--build-arg VITE_CHAVE_PUBLICA=valor-de-build-123456", "ok"] };
    const spy = vi.spyOn(panel.app.deployService, "getJob").mockResolvedValue(job as never);
    const res = await session.tool("get_deploy", { projectId: A, jobId: "jb" });
    spy.mockRestore();
    expect(JSON.stringify(res.raw.json.result)).not.toContain("valor-de-build-123456");
  });
});
