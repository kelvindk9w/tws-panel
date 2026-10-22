/**
 * DeployService.checkGitAccess — "Testar acesso" do assistente Novo projeto.
 *
 * As mesmas validações da criação do projeto (validateGitSource /
 * validateBranch) valem antes de qualquer consulta; o token vem do corpo ou da
 * conta do GitHub conectada (só para github.com) e nunca é gravado.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitAccessInput } from "@paas/deploy";
import type { ServerConfig } from "../src/config.js";

const consultas: GitAccessInput[] = [];
vi.mock("@paas/deploy", async () => {
  const real = await vi.importActual<typeof import("@paas/deploy")>("@paas/deploy");
  return {
    ...real,
    checkGitAccess: vi.fn(async (input: GitAccessInput) => {
      consultas.push(input);
      return { ok: true, defaultBranch: "main", branches: ["main"], totalBranches: 1, branchFound: null, message: "ok" };
    }),
  };
});

const { DeployService } = await import("../src/services/deploy-service.js");

const TOKEN_DIGITADO = "ghp_DIGITADOsupersecreto0003";
const TOKEN_CONTA = "github_pat_CONTAsupersecreto0004";

let dataDir: string;
let svc: InstanceType<typeof DeployService>;

beforeEach(async () => {
  consultas.length = 0;
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-git-access-svc-"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ login: "kelvin" }), { status: 200 })),
  );
  svc = new DeployService({
    dataDir,
    projectsDir: path.join(dataDir, "projects"),
    caddyHttpPort: 80,
    caddyHttpsPort: 443,
    panelDomain: null,
    port: 9000,
  } as unknown as ServerConfig);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dataDir, { recursive: true, force: true });
});

describe("DeployService.checkGitAccess", () => {
  it("usa o token digitado e a URL validada, e devolve o resultado do teste", async () => {
    const r = await svc.checkGitAccess({ source: " https://github.com/dono/repo.git ", branch: "develop", token: ` ${TOKEN_DIGITADO} ` });
    expect(r.ok).toBe(true);
    expect(consultas).toHaveLength(1);
    expect(consultas[0]).toMatchObject({ source: "https://github.com/dono/repo.git", branch: "develop" });
    expect(consultas[0]?.credential).toEqual({ username: "x-access-token", token: TOKEN_DIGITADO });
  });

  it("sem token e sem conta: consulta como repositório público", async () => {
    await svc.checkGitAccess({ source: "https://gitlab.com/dono/repo.git" });
    expect(consultas[0]?.credential).toBeNull();
    expect(consultas[0]?.branch).toBeNull();
  });

  it("endereço fora da allowlist (ext::, file://, flag) é recusado sem consultar", async () => {
    for (const source of ["ext::sh -c touch /tmp/x", "file:///etc", "-oProxyCommand=x", "http://exemplo.com/r.git"]) {
      const r = await svc.checkGitAccess({ source });
      expect(r).toMatchObject({ ok: false, reason: "invalid_source" });
    }
    expect(consultas).toHaveLength(0);
  });

  it("branch inválida é recusada sem consultar", async () => {
    for (const branch of ["--upload-pack=x", "a..b", "com espaço"]) {
      expect(await svc.checkGitAccess({ source: "https://github.com/dono/repo.git", branch })).toMatchObject({
        ok: false,
        reason: "invalid_branch",
      });
    }
    expect(consultas).toHaveLength(0);
  });

  it("useAccount: usa o token da conta do GitHub, nunca o do corpo", async () => {
    await svc.github.connect(TOKEN_CONTA);
    await svc.checkGitAccess({ source: "https://github.com/dono/repo.git", useAccount: true, token: TOKEN_DIGITADO });
    expect(consultas[0]?.credential?.token).toBe(TOKEN_CONTA);
  });

  it("useAccount sem conta conectada, ou fora do github.com", async () => {
    expect(await svc.checkGitAccess({ source: "https://github.com/dono/repo.git", useAccount: true })).toMatchObject({
      ok: false,
      reason: "account_not_connected",
    });
    await svc.github.connect(TOKEN_CONTA);
    expect(await svc.checkGitAccess({ source: "https://gitlab.com/dono/repo.git", useAccount: true })).toMatchObject({
      ok: false,
      reason: "account_not_applicable",
    });
    expect(consultas).toHaveLength(0);
  });

  it("não grava nada no disco (projeto, cofre, auditoria)", async () => {
    const antes = await readdir(dataDir);
    await svc.checkGitAccess({ source: "https://github.com/dono/repo.git", token: TOKEN_DIGITADO });
    expect((await readdir(dataDir)).sort()).toEqual(antes.sort());
    expect(await svc.listProjects()).toEqual([]);
  });

  it("nenhuma resposta de falha de validação repete o token", async () => {
    const r = await svc.checkGitAccess({ source: "ext::x", token: TOKEN_DIGITADO });
    expect(JSON.stringify(r)).not.toContain(TOKEN_DIGITADO);
  });
});
