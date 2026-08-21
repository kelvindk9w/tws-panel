/**
 * security-history.test.ts — resumo "hardening aplicado" derivado do
 * histórico persistido (data/security-history.json).
 *
 * Caso real de produção: o wizard completou o hardening (6 fases, Lynis 75),
 * o painel foi REINICIADO e o passo Segurança voltou ao zero ("Iniciar
 * varredura"), sem caminho para avançar. O resumo `applied` é o que permite
 * ao SecurityStep restaurar a tela "Hardening aplicado" após o restart — e
 * manter o "Antes" congelado (nunca recalculado).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SecurityHistoryEntry } from "@paas/core";
import { SecurityService, buildAppliedSummary } from "../src/services/security-service.js";
import type { ServerConfig } from "../src/config.js";

const SCAN = (at: string, hardeningIndex: number, source: "lynis" | "internal" = "lynis"): SecurityHistoryEntry => ({
  id: `scan-${at}`,
  at,
  kind: "scan",
  hardeningIndex,
  hardeningIndexSource: source,
});

const JOB = (
  at: string,
  phase: SecurityHistoryEntry["phase"],
  dryRun: boolean,
  status: SecurityHistoryEntry["status"],
): SecurityHistoryEntry => ({ id: `job-${phase}-${at}`, at, kind: "job", phase, dryRun, status });

describe("buildAppliedSummary", () => {
  it("sem histórico / sem apply real → null (fluxo normal do wizard)", () => {
    expect(buildAppliedSummary([])).toBeNull();
    expect(buildAppliedSummary([SCAN("2026-08-20T10:00:00Z", 39)])).toBeNull();
    // dry-runs NÃO contam como hardening aplicado
    expect(
      buildAppliedSummary([
        SCAN("2026-08-20T10:00:00Z", 39),
        JOB("2026-08-20T10:05:00Z", "00", true, "success"),
      ]),
    ).toBeNull();
  });

  it("último apply real com falha/rollback → null (fluxo normal é o caminho seguro)", () => {
    expect(
      buildAppliedSummary([
        SCAN("2026-08-20T10:00:00Z", 39),
        JOB("2026-08-20T10:05:00Z", "02", false, "success"),
        JOB("2026-08-20T10:10:00Z", "03", false, "rolled_back"),
      ]),
    ).toBeNull();
  });

  it("apply real bem-sucedido → resumo com Antes CONGELADO e Depois do scan final", () => {
    const entries: SecurityHistoryEntry[] = [
      SCAN("2026-08-20T10:00:00Z", 39),
      JOB("2026-08-20T10:05:00Z", "00", true, "success"), // dry-run: não conta
      JOB("2026-08-20T10:06:00Z", "00", false, "success"),
      JOB("2026-08-20T10:20:00Z", "06", false, "success"),
      SCAN("2026-08-20T10:25:00Z", 75),
    ];
    expect(buildAppliedSummary(entries)).toEqual({
      appliedAt: "2026-08-20T10:20:00Z",
      beforeIndex: 39,
      beforeIndexSource: "lynis",
      afterIndex: 75,
      afterIndexSource: "lynis",
    });
  });

  it("o Antes é o último scan ANTES do primeiro apply — scans posteriores nunca o alteram", () => {
    const entries: SecurityHistoryEntry[] = [
      SCAN("2026-08-20T10:00:00Z", 39),
      JOB("2026-08-20T10:05:00Z", "00", false, "success"),
      SCAN("2026-08-20T10:10:00Z", 49), // scan intermediário NÃO vira "Antes"
      SCAN("2026-08-20T10:15:00Z", 75),
    ];
    const applied = buildAppliedSummary(entries);
    expect(applied?.beforeIndex).toBe(39);
    expect(applied?.afterIndex).toBe(75);
  });

  it("tolera entradas antigas sem fonte de índice e sem scan posterior", () => {
    const entries: SecurityHistoryEntry[] = [
      { id: "s1", at: "2026-08-20T10:00:00Z", kind: "scan", hardeningIndex: 39 },
      JOB("2026-08-20T10:05:00Z", "00", false, "success"),
    ];
    const applied = buildAppliedSummary(entries);
    expect(applied?.beforeIndex).toBe(39);
    expect(applied?.beforeIndexSource).toBeNull();
    expect(applied?.afterIndex).toBeNull();
  });
});

describe("SecurityService.history — retomada após restart do painel", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "paas-sec-history-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Serviço "recém-iniciado" lendo o histórico persistido (simula o reinstall). */
  function freshService(): SecurityService {
    const config = {
      dataDir: dir,
      securityTarget: "container",
      securityTargetContainer: "paas-target-test",
      hardeningScriptsDir: "/tmp/nao-existe",
      hostHelperImage: "alpine:3",
      hostRepoDir: "/opt/tws-panel",
    } as ServerConfig;
    return new SecurityService(config);
  }

  it("estado persistido com apply concluído → applied com Antes/Depois congelados", async () => {
    const entries: SecurityHistoryEntry[] = [
      SCAN("2026-08-20T10:00:00Z", 39),
      JOB("2026-08-20T10:05:00Z", "00", false, "success"),
      JOB("2026-08-20T10:20:00Z", "06", false, "success"),
      SCAN("2026-08-20T10:25:00Z", 75),
    ];
    await writeFile(path.join(dir, "security-history.json"), JSON.stringify({ entries }), "utf8");

    const history = await freshService().history();
    expect(history.applied).toEqual({
      appliedAt: "2026-08-20T10:20:00Z",
      beforeIndex: 39,
      beforeIndexSource: "lynis",
      afterIndex: 75,
      afterIndexSource: "lynis",
    });
    expect(history.firstIndex).toBe(39);
    expect(history.latestIndex).toBe(75);
  });

  it("histórico sem apply → applied null (passo Segurança segue o fluxo normal)", async () => {
    await writeFile(
      path.join(dir, "security-history.json"),
      JSON.stringify({ entries: [SCAN("2026-08-20T10:00:00Z", 39)] }),
      "utf8",
    );
    expect((await freshService().history()).applied).toBeNull();
  });

  it("sem arquivo de histórico → applied null", async () => {
    expect((await freshService().history()).applied).toBeNull();
  });
});
