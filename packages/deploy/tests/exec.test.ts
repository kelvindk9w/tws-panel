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
import { run, runStream, DEFAULT_STREAM_TIMEOUT_MS } from "../src/exec.js";

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

/**
 * Sem shell: `run` e `runStream` entregam cada argumento como está ao
 * programa. Um argumento com `;`, `$()`, crase ou `|` (nome de branch, slug,
 * caminho) nunca vira um segundo comando.
 */
describe("run/runStream — argumentos nunca passam por shell", () => {
  const hostile = ["a; touch /tmp/paas-nao-pode-existir", "$(id)", "`id`", "x | cat", "'aspas' \"duplas\"", "*"];

  it("run: cada argumento chega literal, na ordem", async () => {
    const r = await run("printf", ["%s\\n", ...hostile]);
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n").slice(0, -1)).toEqual(hostile);
  });

  it("runStream: o mesmo vale para a saída transmitida", async () => {
    const chunks: string[] = [];
    const code = await runStream("printf", ["%s\\n", ...hostile], (c) => chunks.push(c));
    expect(code).toBe(0);
    expect(chunks.join("").split("\n").slice(0, -1)).toEqual(hostile);
  });

  it("run: código de saída diferente de zero traz stdout e stderr do próprio comando", async () => {
    const r = await run("sh", ["-c", 'printf saida; printf erro >&2; exit 3']);
    expect(r).toEqual({ code: 3, stdout: "saida", stderr: "erro" });
  });

  it("run: cwd e env chegam ao processo", async () => {
    const r = await run("sh", ["-c", 'printf "%s|%s" "$PWD" "$PAAS_TESTE"'], { cwd: "/", env: { PATH: process.env.PATH, PAAS_TESTE: "ok" } });
    expect(r.stdout).toBe("/|ok");
  });
});
