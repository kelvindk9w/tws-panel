/**
 * Testes do AuditService (audit-service.ts): registro com defaults, paginação
 * (mais recentes primeiro, clamps), cap de entradas e tolerância a arquivo
 * corrompido — com arquivos reais em diretório temporário.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe("auditoria best-effort — falha de disco não derruba a ação", () => {
  it("gravação que falha não rejeita o registro nem trava as gravações seguintes", async () => {
    const service = new AuditService(dir);
    // audit.json vira diretório: a escrita falha com EISDIR
    await mkdir(path.join(dir, "audit.json"));
    await expect(service.record({ action: "teste.durante", detail: "durante a falha" })).resolves.toMatchObject({
      action: "teste.durante",
    });

    await rm(path.join(dir, "audit.json"), { recursive: true });
    await service.record({ action: "teste.depois", detail: "depois da falha" });

    const gravado = JSON.parse(await readFile(path.join(dir, "audit.json"), "utf8"));
    expect(gravado.entries.map((e: AuditEntry) => e.action)).toEqual(["teste.durante", "teste.depois"]);
  });

  it("falha ao gravar o arquivo de rotação não impede o registro e não perde as antigas", async () => {
    const service = new AuditService(dir, { maxEntries: 2 });
    // audit.1.json vira diretório: o arquivamento falha
    await mkdir(path.join(dir, "audit.1.json"));
    for (let i = 1; i <= 3; i++) {
      await service.record({ action: "teste.acao", detail: `evento ${i}` });
    }
    // sem onde arquivar, a mais antiga fica no ativo (passa do teto, mas não some)
    const atual = JSON.parse(await readFile(path.join(dir, "audit.json"), "utf8"));
    expect(atual.entries.map((e: AuditEntry) => e.detail)).toEqual(["evento 1", "evento 2", "evento 3"]);
    // o arquivamento volta a funcionar: as excedentes vão para lá
    await rm(path.join(dir, "audit.1.json"), { recursive: true });
    await service.record({ action: "teste.acao", detail: "evento 4" });
    const depois = JSON.parse(await readFile(path.join(dir, "audit.json"), "utf8"));
    expect(depois.entries.map((e: AuditEntry) => e.detail)).toEqual(["evento 3", "evento 4"]);
    const arquivado = JSON.parse(await readFile(path.join(dir, "audit.1.json"), "utf8"));
    expect(arquivado.entries.map((e: AuditEntry) => e.detail)).toEqual(["evento 1", "evento 2"]);
  });

  it("arquivo de rotação com formato inesperado é recomeçado, preservando o excedente", async () => {
    await writeFile(path.join(dir, "audit.1.json"), JSON.stringify({ entries: "oops" }), "utf8");
    const service = new AuditService(dir, { maxEntries: 1 });
    await service.record({ action: "teste.acao", detail: "evento 1" });
    await service.record({ action: "teste.acao", detail: "evento 2" });
    const arquivado = JSON.parse(await readFile(path.join(dir, "audit.1.json"), "utf8"));
    expect(arquivado.entries.map((e: AuditEntry) => e.detail)).toEqual(["evento 1"]);
  });
});

/**
 * Concorrência real (achado 15 da revisão): registros disparados em paralelo,
 * com Promise.all, sobre arquivos de verdade numa pasta temporária. Antes da
 * correção, a carga inicial marcava "carregado" antes de ler o disco e a
 * rotação lia e gravava o audit.1.json fora da fila: registros sumiam, o
 * histórico antigo inteiro podia ser apagado e o audit.1.json saía corrompido.
 */
describe("auditoria com registros em paralelo", () => {
  async function lerIds(file: string): Promise<string[]> {
    const raw = JSON.parse(await readFile(path.join(dir, file), "utf8")) as { entries: AuditEntry[] };
    return raw.entries.map((e) => e.id);
  }

  it("11 registros paralelos logo depois de subir: os 11 ficam na memória e no disco", async () => {
    const service = new AuditService(dir);
    const feitos = await Promise.all(
      Array.from({ length: 11 }, (_, i) => service.record({ action: "teste.paralelo", detail: `registro ${i}` })),
    );
    expect((await service.list(1, 200)).total).toBe(11);
    expect((await lerIds("audit.json")).sort()).toEqual(feitos.map((e) => e.id).sort());
  });

  it("histórico existente + registros paralelos na subida: nada do que já estava some", async () => {
    const antigas = Array.from({ length: 1500 }, (_, i) => fakeEntry(i));
    await writeFile(path.join(dir, "audit.json"), JSON.stringify({ entries: antigas }), "utf8");
    for (let rodada = 0; rodada < 5; rodada++) {
      const service = new AuditService(dir);
      const antes = (await lerIds("audit.json")).length;
      const [a, b] = await Promise.all([
        service.record({ action: "teste.paralelo", detail: "a" }),
        service.record({ action: "teste.paralelo", detail: "b" }),
        service.list(),
      ]);
      const ids = await lerIds("audit.json");
      expect(ids).toHaveLength(antes + 2);
      expect(ids).toEqual(expect.arrayContaining(["e0", "e1499", a.id, b.id]));
    }
  });

  it("rotação com registros paralelos: nenhum registro perdido e o audit.1.json continua JSON válido", async () => {
    const service = new AuditService(dir, { maxEntries: 2 });
    const feitos = await Promise.all(
      Array.from({ length: 19 }, (_, i) => service.record({ action: "teste.paralelo", detail: `registro ${i}` })),
    );
    // as duas leituras lançam se o arquivo estiver corrompido
    const ativo = await lerIds("audit.json");
    const arquivo = await lerIds("audit.1.json");
    expect(ativo).toHaveLength(2);
    const todos = [...arquivo, ...ativo];
    expect(new Set(todos).size).toBe(19);
    expect(todos.sort()).toEqual(feitos.map((e) => e.id).sort());
  });

  it("audit.1.json ilegível é guardado à parte, nunca sobrescrito", async () => {
    await writeFile(path.join(dir, "audit.1.json"), "{ histórico importante, mas estragado", "utf8");
    const service = new AuditService(dir, { maxEntries: 1 });
    await Promise.all([1, 2, 3].map((i) => service.record({ action: "teste.acao", detail: `evento ${i}` })));
    const guardado = (await readdir(dir)).find((n) => n.startsWith("audit.1.json.corrompido-"));
    expect(guardado).toBeDefined();
    expect(await readFile(path.join(dir, guardado!), "utf8")).toBe("{ histórico importante, mas estragado");
    expect(await lerIds("audit.1.json")).toHaveLength(2);
  });
});
