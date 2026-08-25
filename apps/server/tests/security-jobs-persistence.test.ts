/**
 * security-jobs-persistence.test.ts — jobs de segurança persistidos em disco
 * (data/security-jobs.json), apps/server/src/services/security-service.ts.
 *
 * Bug real: os jobs viviam só em memória (SecurityExecutor). Um restart do
 * painel durante "awaiting_confirmation" fazia GET /api/security/jobs/:id
 * responder 404, embora o rollback agendado NO ALVO continuasse rodando de
 * forma independente — o operador perdia visibilidade exatamente no momento
 * em que precisa confirmar que ainda tem acesso. Segue o padrão de
 * audit-service.ts/alerts-service.ts: JSON com mode 0o600 no dataDir.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SecurityJob } from "@paas/core";
import { SecurityService } from "../src/services/security-service.js";
import type { ServerConfig } from "../src/config.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-sec-jobs-"));
});

afterEach(async () => {
  // As gravações de jobs são disparadas sem await (o onChange não pode
  // atrasar a requisição). Sem esperar por elas, o cleanup apaga o diretório
  // no meio de uma gravação e o rmdir falha com ENOTEMPTY.
  await Promise.all(criados.map((s) => s.flushJobWrites().catch(() => undefined)));
  criados.length = 0;
  await rm(dir, { recursive: true, force: true });
});

/** Services criados no teste corrente — usados para aguardar gravações. */
const criados: SecurityService[] = [];

function freshService(): SecurityService {
  const config = {
    dataDir: dir,
    securityTarget: "container",
    securityTargetContainer: "paas-target-test",
    hardeningScriptsDir: "/tmp/nao-existe",
    hostHelperImage: "alpine:3",
    hostRepoDir: "/opt/tws-panel",
  } as ServerConfig;
  const s = new SecurityService(config);
  criados.push(s);
  return s;
}

function awaitingConfirmationJob(overrides: Partial<SecurityJob> = {}): SecurityJob {
  return {
    id: "job-restart",
    phase: "02",
    phaseKey: "ssh",
    title: "Hardening de SSH",
    dryRun: false,
    status: "awaiting_confirmation",
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    steps: [],
    log: "",
    rollbackScheduled: true,
    rollbackDeadline: new Date(Date.now() + 60_000).toISOString(),
    error: null,
    ...overrides,
  };
}

describe("SecurityService — restoreJobsFromDisk (restart durante awaiting_confirmation)", () => {
  it("sem arquivo de jobs → não lança, getJob segue null (primeira execução)", async () => {
    const service = freshService();
    expect(service.getJob("qualquer")).toBeNull();
    await expect(service.restoreJobsFromDisk()).resolves.toBeUndefined();
    expect(service.getJob("qualquer")).toBeNull();
  });

  it("job.json corrompido → não lança, nada é restaurado", async () => {
    await writeFile(path.join(dir, "security-jobs.json"), "{quebrado", "utf8");
    const service = freshService();
    await expect(service.restoreJobsFromDisk()).resolves.toBeUndefined();
    expect(service.getJob("job-restart")).toBeNull();
  });

  it("job 'awaiting_confirmation' persistido volta a ser visível via getJob() após restoreJobsFromDisk", async () => {
    const job = awaitingConfirmationJob();
    await writeFile(path.join(dir, "security-jobs.json"), JSON.stringify({ jobs: [job] }), "utf8");

    const service = freshService();
    // ANTES de restaurar: exatamente o bug relatado — GET .../jobs/:id não acharia o job (404).
    expect(service.getJob("job-restart")).toBeNull();

    await service.restoreJobsFromDisk();
    const restored = service.getJob("job-restart");
    expect(restored?.status).toBe("awaiting_confirmation");
    expect(restored?.rollbackDeadline).toBe(job.rollbackDeadline);
  });

  it("job 'running' persistido é restaurado como 'failed' — e o arquivo em disco é atualizado (persistJobs via onChange)", async () => {
    const job = awaitingConfirmationJob({
      id: "job-em-execucao",
      status: "running",
      rollbackScheduled: false,
      rollbackDeadline: null,
    });
    await writeFile(path.join(dir, "security-jobs.json"), JSON.stringify({ jobs: [job] }), "utf8");

    const service = freshService();
    await service.restoreJobsFromDisk();

    const restored = service.getJob("job-em-execucao");
    expect(restored?.status).toBe("failed");
    expect(restored?.error).toMatch(/reiniciado/i);

    // persistJobs() é disparado pelo onChange do executor de forma
    // fire-and-forget (void) — aguarda a gravação pendente em vez de dormir
    // um tempo fixo, que falharia sob carga.
    await service.flushJobWrites();
    const onDisk = JSON.parse(await readFile(path.join(dir, "security-jobs.json"), "utf8")) as {
      jobs: SecurityJob[];
    };
    expect(onDisk.jobs.find((j) => j.id === "job-em-execucao")?.status).toBe("failed");
  });

  it("job 'awaiting_confirmation' com deadline já expirado é restaurado como 'rolled_back'", async () => {
    const job = awaitingConfirmationJob({
      id: "job-expirado",
      rollbackDeadline: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    await writeFile(path.join(dir, "security-jobs.json"), JSON.stringify({ jobs: [job] }), "utf8");

    const service = freshService();
    await service.restoreJobsFromDisk();
    expect(service.getJob("job-expirado")?.status).toBe("rolled_back");
  });

  it("arquivo com `jobs` que não é array → ignorado silenciosamente", async () => {
    await writeFile(path.join(dir, "security-jobs.json"), JSON.stringify({ jobs: "oops" }), "utf8");
    const service = freshService();
    await expect(service.restoreJobsFromDisk()).resolves.toBeUndefined();
  });
});
