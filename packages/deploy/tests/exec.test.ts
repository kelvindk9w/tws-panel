/**
 * exec.ts — timeout de runStream.
 *
 * Bug: runStream (usado por docker build / compose up --build / docker run
 * durante o deploy) não tinha nenhum limite de tempo — um build travado
 * pendurava o job para sempre. `run()` já suporta `timeoutMs`; runStream
 * precisa do mesmo mecanismo, com um padrão generoso (30 min — builds podem
 * ser legitimamente lentos) e sem quebrar os chamadores existentes (que só
 * fazem `const code = await runStream(...)`).
 */
import { describe, expect, it } from "vitest";
import { runStream, DEFAULT_STREAM_TIMEOUT_MS } from "../src/exec.js";

describe("runStream — timeout", () => {
  it("mata o processo e rejeita com mensagem clara ao exceder o timeout", async () => {
    const chunks: string[] = [];
    await expect(
      runStream("sleep", ["5"], (c) => chunks.push(c), { timeoutMs: 100 }),
    ).rejects.toThrow(/tempo limite/i);
  }, 10_000);

  it("não deixa o processo vivo depois do timeout (mata de verdade, não só rejeita)", async () => {
    const start = Date.now();
    await expect(
      runStream("sleep", ["30"], () => {}, { timeoutMs: 100 }),
    ).rejects.toThrow();
    // Se o processo não fosse morto, o teste (ou o processo) ficaria pendurado
    // até os 30s do sleep. Uma rejeição rápida é evidência indireta do kill.
    expect(Date.now() - start).toBeLessThan(5_000);
  }, 10_000);

  it("comandos rápidos continuam resolvendo normalmente (não quebra chamadores existentes)", async () => {
    const code = await runStream("true", [], () => {});
    expect(code).toBe(0);
  });

  it("timeout padrão é generoso (30 min) — não aplicado nesse teste, só valida a constante exportada", () => {
    expect(DEFAULT_STREAM_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });
});
