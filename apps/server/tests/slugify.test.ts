/**
 * slugify.test.ts — o nome do projeto vira slug (endereço, pasta, container).
 * O texto vem de quem cria o projeto: nenhuma entrada pode fazer a conversão
 * levar tempo quadrático (alerta de ReDoS do CodeQL em `-+$`).
 */
import { describe, expect, it } from "vitest";
import { slugify } from "../src/services/deploy-service.js";

describe("slugify", () => {
  it("minúsculas, sem acento, separadores viram um hífen só, sem hífen nas pontas", () => {
    expect(slugify("Minha Loja Ação")).toBe("minha-loja-acao");
    expect(slugify("--  Olá,   mundo!! --")).toBe("ola-mundo");
    expect(slugify("a---b___c")).toBe("a-b-c");
    expect(slugify("-x-")).toBe("x");
  });

  it("corta em 40 caracteres", () => {
    expect(slugify("a".repeat(60))).toBe("a".repeat(40));
  });

  it("nada que preste vira projeto-<sorteio>", () => {
    expect(slugify("!!!")).toMatch(/^projeto-[0-9a-f]{6}$/);
    expect(slugify("-")).toMatch(/^projeto-[0-9a-f]{6}$/);
  });

  it("sequência enorme de hífens e separadores: responde na hora", () => {
    const start = performance.now();
    expect(slugify(`a${"-".repeat(200_000)}!b`)).toBe("a-b");
    expect(slugify(`${"- ".repeat(100_000)}x`)).toBe("x");
    expect(slugify(`x${"-".repeat(200_000)}`)).toBe("x");
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});
