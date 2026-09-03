/**
 * Testes do AuditService (audit-service.ts): registro com defaults, paginação
 * (mais recentes primeiro, clamps), cap de entradas e tolerância a arquivo
 * corrompido — com arquivos reais em diretório temporário.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditEntry } from "@paas/core";
import { AuditService } from "../src/services/audit-service.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-audit-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeEntry(i: number): AuditEntry {
  return {
    id: `e${i}`,
    at: new Date(i * 1000).toISOString(),
    actor: "teste",
    action: "teste.acao",
    target: null,
    detail: `entrada ${i}`,
  };
}

describe("AuditService.record", () => {
  it("aplica defaults (actor 'operador', target null) e persiste com modo 0600", async () => {
    const service = new AuditService(dir);
    const entry = await service.record({ action: "setup.admin_created", detail: "Admin criado." });
    expect(entry.actor).toBe("operador");
    expect(entry.target).toBeNull();
    expect(entry.id).toMatch(/^[0-9a-f]{16}$/);
    expect(new Date(entry.at).getTime()).toBeGreaterThan(0);

    const file = path.join(dir, "audit.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    // reload: a entrada sobrevive ao "boot"
    const fresh = new AuditService(dir);
    expect((await fresh.list()).total).toBe(1);
  });

  it("respeita o cap de 2000 entradas (descarta as mais antigas)", async () => {
    const seeded = Array.from({ length: 2_005 }, (_, i) => fakeEntry(i));
    await writeFile(path.join(dir, "audit.json"), JSON.stringify({ entries: seeded }), "utf8");

    const service = new AuditService(dir);
    await service.record({ actor: "admin", action: "teste.novo", detail: "novo" });

    const { entries, total } = await service.list(1, 1);
    expect(total).toBe(2_000);
    // a mais antiga (e0) foi descartada; a nova é a mais recente
    expect(entries[0]?.action).toBe("teste.novo");
    // o arquivo persistido começa na e6 (6 descartadas: e0..e5)
    const onDisk = JSON.parse(await readFile(path.join(dir, "audit.json"), "utf8"));
    expect(onDisk.entries).toHaveLength(2_000);
    expect(onDisk.entries[0].id).toBe("e6");
    expect(onDisk.entries.at(-1).action).toBe("teste.novo");
  });
});

describe("AuditService.list", () => {
  it("ordena do mais recente para o mais antigo e pagina corretamente", async () => {
    const service = new AuditService(dir);
    for (let i = 0; i < 5; i++) {
      await service.record({ action: `acao.${i}`, detail: `detalhe ${i}` });
    }
    const page1 = await service.list(1, 2);
    expect(page1.entries.map((e) => e.action)).toEqual(["acao.4", "acao.3"]);
    expect(page1.total).toBe(5);
    const page3 = await service.list(3, 2);
    expect(page3.entries.map((e) => e.action)).toEqual(["acao.0"]);
  });

  it("faz clamp de page/perPage fora da faixa", async () => {
    const service = new AuditService(dir);
    await service.record({ action: "a", detail: "d" });
    const weird = await service.list(0, 0);
    expect(weird.page).toBe(1);
    expect(weird.perPage).toBe(1);
    const huge = await service.list(1, 10_000);
    expect(huge.perPage).toBe(200);
  });

  it("audit.json corrompido → lista vazia sem lançar", async () => {
    await writeFile(path.join(dir, "audit.json"), "não é json", "utf8");
    const { entries, total } = await new AuditService(dir).list();
    expect(entries).toEqual([]);
    expect(total).toBe(0);
  });

  it("audit.json sem array de entradas → lista vazia", async () => {
    await writeFile(path.join(dir, "audit.json"), JSON.stringify({ entries: 42 }), "utf8");
    expect((await new AuditService(dir).list()).total).toBe(0);
  });
});

describe("rotação do log de auditoria", () => {
  it("arquiva as entradas mais antigas em vez de descartá-las ao atingir o teto", async () => {
    // A trilha de auditoria existe para investigação pós-incidente. Descartar
    // silenciosamente o começo apaga justamente o que se quer ler ("quando isso
    // foi configurado?"). Ao estourar o teto, as antigas vão para audit.1.json.
    const dir = await mkdtemp(path.join(tmpdir(), "paas-audit-rot-"));
    try {
      const service = new AuditService(dir, { maxEntries: 5 });
      for (let i = 1; i <= 8; i++) {
        await service.record({ action: "teste.acao", detail: `evento ${i}` });
      }

      const atual = JSON.parse(await readFile(path.join(dir, "audit.json"), "utf8"));
      expect(atual.entries).toHaveLength(5);
      expect(atual.entries[0].detail).toBe("evento 4");

      const arquivado = JSON.parse(await readFile(path.join(dir, "audit.1.json"), "utf8"));
      const detalhes = arquivado.entries.map((e: { detail: string }) => e.detail);
      expect(detalhes).toContain("evento 1");
      expect(detalhes).toContain("evento 3");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("flush() espera as gravações disparadas sem await (fire-and-forget)", async () => {
    // As rotas de terminal/segurança chamam `void auditService.record(...)` de
    // propósito, para não bloquear o caminho quente. Sem um ponto de dreno, a
    // gravação pode aterrissar depois que o dono do diretório já o apagou.
    const service = new AuditService(dir);
    void service.record({ action: "terminal.encerrado", detail: "sem await" });
    await service.flush();
    const gravado = JSON.parse(await readFile(path.join(dir, "audit.json"), "utf8"));
    expect(gravado.entries).toHaveLength(1);
    expect(gravado.entries[0].detail).toBe("sem await");
  });

  it("acumula no arquivo de arquivo em rotações sucessivas, sem perder o começo", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paas-audit-rot2-"));
    try {
      const service = new AuditService(dir, { maxEntries: 3 });
      for (let i = 1; i <= 12; i++) {
        await service.record({ action: "teste.acao", detail: `evento ${i}` });
      }
      const arquivado = JSON.parse(await readFile(path.join(dir, "audit.1.json"), "utf8"));
      const detalhes = arquivado.entries.map((e: { detail: string }) => e.detail);
      expect(detalhes).toContain("evento 1");
      expect(arquivado.entries.length).toBeGreaterThanOrEqual(9);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
