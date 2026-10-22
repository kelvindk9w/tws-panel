/**
 * Alerta de "nova atualização" de ponta a ponta no DeployService, com um repositório de verdade
 * (git local em pasta temporária, sem rede): o deploy registra o commit que ficou no ar, um commit
 * novo na branch do projeto vira "atualização disponível", outra branch do MESMO repositório não
 * interfere, e destinos internos continuam recusados.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ingestCode, readDeployedCommit, remoteBranchCommit, run } from "@paas/deploy";
import type { Project } from "@paas/core";
import type { ServerConfig } from "../src/config.js";
import { DeployService } from "../src/services/deploy-service.js";
import { UpdateCheckService } from "../src/services/update-check-service.js";

let dataDir: string;
let repo: string;
let svc: DeployService;
let started = 0;
let finished = 0;

const git = (...args: string[]) => run("git", ["-C", repo, ...args]);
const head = async (ref: string) => (await git("rev-parse", ref)).stdout.trim();
async function commit(branch: string, texto: string) {
  await git("checkout", "-q", branch);
  await writeFile(path.join(repo, "a.txt"), `${texto}\n`);
  await git("commit", "-q", "-am", texto);
  await git("checkout", "-q", "main");
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-update-status-"));
  repo = path.join(dataDir, "repo");
  await run("git", ["init", "-q", "-b", "main", repo]);
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "T");
  await writeFile(path.join(repo, "a.txt"), "1\n");
  await git("add", ".");
  await git("commit", "-q", "-m", "1");
  await git("branch", "sandbox");

  svc = new DeployService(
    { dataDir, projectsDir: path.join(dataDir, "projects"), caddyHttpPort: 80, caddyHttpsPort: 443, panelDomain: null, port: 9000 } as unknown as ServerConfig,
    {
      audit: { record: vi.fn(async () => ({})) } as never,
      // dispara DEPOIS de o estado final ter sido gravado: o afterEach espera por ele antes de apagar a pasta
      onDeployFinished: () => void (finished += 1),
    },
  );
  started = 0;
  finished = 0;
  const realStart = svc.startDeploy.bind(svc);
  svc.startDeploy = async (...args: Parameters<typeof svc.startDeploy>) => {
    const job = await realStart(...args);
    started += 1;
    return job;
  };
  // o "deploy" de verdade da ingestão, sem build; o resto do motor é dublê
  const ctx = { projectsDir: path.join(dataDir, "projects") };
  (svc as unknown as { engine: { deploy: (p: Project) => Promise<void> } }).engine.deploy = async (p) => {
    await ingestCode(ctx, p, () => undefined);
  };
  (svc as unknown as { applyProxy: () => Promise<void> }).applyProxy = async () => undefined;
  // o repositório de teste é uma pasta local: a conferência de endereço de rede não se aplica a ela
  (svc as unknown as { updates: UpdateCheckService }).updates = new UpdateCheckService({
    credentialFor: async () => null,
    resolveTarget: async () => ({ ok: true, pin: null }),
    remoteBranchCommit,
  });
});

afterEach(async () => {
  // todo deploy iniciado precisa ter terminado de gravar o estado antes de apagar a pasta
  await vi.waitFor(() => expect(finished).toBe(started), { timeout: 10_000 });
  await rm(dataDir, { recursive: true, force: true });
});

async function novoProjeto(name: string, branch: string, domain: string): Promise<Project> {
  const p = await svc.createProject({ name, ingestMode: "git", source: "https://github.com/k/loja", branch, domain });
  const stored = (await svc.getProject(p.id))!;
  stored.source = repo; // a fonte real do teste
  stored.detection = { type: "static", warnings: [], details: [] } as never;
  return stored;
}

async function deploy(p: Project) {
  const job = await svc.startDeploy(p.id);
  await vi.waitFor(async () => expect((await svc.getJob(p.id, job.id))?.status).toBe("success"), { timeout: 15_000 });
}

describe("alerta de nova atualização", () => {
  it("antes do primeiro deploy: sem alerta; depois do deploy: atualizado com o commit no ar", async () => {
    const p = await novoProjeto("loja", "main", "loja.example.com");
    expect((await svc.updateStatus(p.id)).state).toBe("never_deployed");

    await deploy(p);
    expect(p.deployedCommit).toBe(await head("main"));
    const s = await svc.updateStatus(p.id);
    expect(s).toMatchObject({ state: "up_to_date", branch: "main" });
    expect(s.deployedCommit).toBe((await head("main")).slice(0, 7));
  });

  it("commit novo na branch do projeto: atualização disponível; depois de novo deploy, atualizado", async () => {
    const p = await novoProjeto("loja", "main", "loja.example.com");
    await deploy(p);
    await commit("main", "2");
    svc.updates.invalidateAll(); // o prazo do cache é testado no teste do serviço
    const s = await svc.updateStatus(p.id);
    expect(s).toMatchObject({ state: "update_available", remoteCommit: (await head("main")).slice(0, 7) });

    await deploy(p);
    expect(p.deployedCommit).toBe(await head("main"));
    expect((await svc.updateStatus(p.id)).state).toBe("up_to_date");
  });

  it("commit novo em OUTRA branch do mesmo repositório não avisa o projeto da main, só o do sandbox", async () => {
    const prod = await novoProjeto("loja", "main", "loja.example.com");
    const sbx = await novoProjeto("loja sandbox", "sandbox", "sandbox.example.com");
    await deploy(prod);
    await deploy(sbx);
    await commit("sandbox", "so no sandbox");
    const todos = await svc.updateStatuses();
    const porId = new Map(todos.map((s) => [s.projectId, s]));
    expect(porId.get(prod.id)).toMatchObject({ state: "up_to_date", branch: "main" });
    expect(porId.get(sbx.id)).toMatchObject({ state: "update_available", branch: "sandbox" });
  });

  it("trocar a branch do projeto: 'config_changed' (o que está no ar vem de outra branch), sem alerta falso", async () => {
    const p = await novoProjeto("loja", "main", "loja.example.com");
    await deploy(p);
    await svc.updateProject(p.id, { branch: "sandbox" });
    expect((await svc.updateStatus(p.id)).state).toBe("config_changed");
  });

  it("branch que sumiu do repositório: erro claro (não é 'atualizado')", async () => {
    const p = await novoProjeto("loja", "main", "loja.example.com");
    await deploy(p);
    await git("branch", "-q", "-m", "main", "principal");
    const s = await svc.updateStatus(p.id);
    expect(s).toMatchObject({ state: "error", reason: "branch_not_found", branch: "main" });
  });

  it("projeto publicado antes do registro do commit: 'unknown' até o próximo deploy", async () => {
    const p = await novoProjeto("loja", "main", "loja.example.com");
    await deploy(p);
    p.deployedCommit = undefined; // como num projects.json antigo
    expect((await svc.updateStatus(p.id)).state).toBe("unknown");
    await deploy(p);
    expect((await svc.updateStatus(p.id)).state).toBe("up_to_date");
  });

  it("deploy FALHO não grava (nem apaga) o commit no ar", async () => {
    const p = await novoProjeto("loja", "main", "loja.example.com");
    await deploy(p);
    const antes = p.deployedCommit;
    expect(antes).toBe(await head("main"));
    await commit("main", "2");
    // o deploy BAIXA o código novo (o repositório do painel avança) e só então falha, como um build quebrado
    const ctx = { projectsDir: path.join(dataDir, "projects") };
    (svc as unknown as { engine: { deploy: (p: Project) => Promise<void> } }).engine.deploy = async (proj) => {
      await ingestCode(ctx, proj, () => undefined);
      throw new Error("build quebrou");
    };
    const job = await svc.startDeploy(p.id);
    await vi.waitFor(async () => expect((await svc.getJob(p.id, job.id))?.status).toBe("failed"), { timeout: 15_000 });
    // o código novo foi baixado, mas o commit no ar continua o do último deploy que deu certo
    expect(await readDeployedCommit(ctx, p)).toBe(await head("main"));
    expect(p.deployedCommit).toBe(antes);
    expect(p.deployedCommit).not.toBe(await head("main"));
  });

  it("quando o job consta como 'success' o commit já está registrado (sem janela entre os dois)", async () => {
    const p = await novoProjeto("loja", "main", "loja.example.com");
    const job = await svc.startDeploy(p.id);
    const limite = Date.now() + 20_000;
    let visto: string | undefined;
    while (Date.now() < limite && visto !== "success") {
      visto = (await svc.getJob(p.id, job.id))?.status;
      if (visto === "success") {
        // no instante em que o job aparece como concluído, o commit já está gravado
        expect(p.deployedCommit).toBe(await head("main"));
      } else {
        await new Promise((r) => setImmediate(r));
      }
    }
    expect(visto).toBe("success");
  });

  it("publicado com a branch vazia (padrão) e depois trocado para sandbox: 'config_changed', não atualização", async () => {
    const p = await novoProjeto("loja", "main", "loja.example.com");
    p.branch = null;
    await deploy(p);
    expect(p.deployedBranch).toBeNull();
    expect((await svc.updateStatus(p.id)).state).toBe("up_to_date");
    await svc.updateProject(p.id, { branch: "sandbox" });
    expect((await svc.updateStatus(p.id)).state).toBe("config_changed");
  });

  it("apagar o projeto esquece o resultado guardado", async () => {
    const p = await novoProjeto("loja", "main", "loja.example.com");
    await deploy(p);
    await svc.updateStatus(p.id);
    const cache = (svc.updates as unknown as { cache: Map<string, unknown> }).cache;
    expect(cache.has(p.id)).toBe(true);
    await svc.deleteProject(p.id, false, () => undefined);
    expect(cache.has(p.id)).toBe(false);
  });

  it("projeto inexistente: 404", async () => {
    await expect(svc.updateStatus("nao-existe")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("trocar ou remover a credencial invalida o resultado guardado", async () => {
    const p = await novoProjeto("loja", "main", "loja.example.com");
    await deploy(p);
    await svc.updateStatus(p.id);
    expect(svc.updates.statusOf(p).state).toBe("up_to_date");
    await svc.setCredential(p.id, { token: "tkn_TOKENNOVOsupersecreto0001" });
    expect(svc.updates.statusOf(p).state).toBe("checking");
    await svc.updateStatus(p.id);
    await svc.removeCredential(p.id);
    expect(svc.updates.statusOf(p).state).toBe("checking");
  });
});

describe("com a conferência de endereço de verdade", () => {
  it("repositório em loopback é recusado (blocked_host) e nada é consultado", async () => {
    const real = new DeployService(
      { dataDir, projectsDir: path.join(dataDir, "projects"), caddyHttpPort: 80, caddyHttpsPort: 443, panelDomain: null, port: 9000 } as unknown as ServerConfig,
      {},
    );
    const p = await real.createProject({ name: "x", ingestMode: "git", source: "https://github.com/k/x", branch: "main", domain: "x.example.com" });
    const stored = (await real.getProject(p.id))!;
    stored.source = "http://127.0.0.1:9/repo.git";
    stored.deployedSource = stored.source;
    stored.deployedBranch = "main";
    stored.deployedCommit = "a".repeat(40);
    stored.lastDeployStatus = "success";
    const s = await real.updateStatus(p.id);
    expect(s).toMatchObject({ state: "error", reason: "blocked_host" });
  });
});
