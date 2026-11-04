/**
 * node-version.ts — escolha do major do Node (engines.node > .nvmrc > .node-version),
 * padrão 22 LTS, limites 20/22/24 e faixas que o painel não entende.
 */
import { describe, expect, it } from "vitest";
import { majorSatisfies, pickNodeMajor } from "../src/node-version.js";

describe("majorSatisfies (aproximação por major)", () => {
  it.each([
    ["22", 22, true],
    ["22", 20, false],
    ["22.12.0", 22, true],
    ["v22.12.0", 22, true],
    ["=22", 22, true],
    ["22.x", 22, true],
    ["^22.12.0", 22, true],
    ["^22.12.0", 24, false],
    ["~20.9", 20, true],
    [">=18", 22, true],
    [">=18.18.0", 20, true],
    [">=22", 20, false],
    [">=22.12", 22, true],
    [">=22.99.99", 22, true],
    [">=22.100.0", 22, false],
    [">=22.99.100", 22, false],
    [">=22.99.5", 22, true],
    [">22.99.99", 22, false],
    [">22.98.0", 22, true],
    ["<22.100.0", 22, true],
    [">22", 22, false],
    [">22", 24, true],
    [">20.5", 20, true],
    ["<22", 22, false],
    ["<22", 20, true],
    ["<23", 22, true],
    ["<22.12", 22, false],
    ["<=22", 22, true],
    ["<=22", 24, false],
    ["<=22.12.0", 22, false],
    [">=20 <24", 22, true],
    [">=20 <24", 24, false],
    ["20 || 22", 22, true],
    ["20 || 22", 24, false],
    ["^18 || ^20", 20, true],
    [">=20.9.0 - 22", 22, null],
    ["20 - 22", 22, true],
    ["20 - 22", 24, false],
    ["*", 24, true],
    ["x", 20, true],
  ])("%s com Node %i → %s", (range, major, expected) => {
    expect(majorSatisfies(range, major)).toBe(expected);
  });

  it.each(["", "   ", "lts/*", "banana", ">=", "22 ||", "a - b", "22..1", "^", "latest"])(
    "faixa que não entende (%j) → null",
    (range) => {
      expect(majorSatisfies(range, 22)).toBeNull();
    },
  );

  it("faixa de mais de 200 caracteres → null, mesmo sendo válida (limite MAX_RANGE_CHARS)", () => {
    expect(majorSatisfies(">=20 <99", 22)).toBe(true);
    const longa = `>=20${" ".repeat(300)}<99`;
    expect(longa.length).toBeGreaterThan(200);
    expect(majorSatisfies(longa, 22)).toBeNull();
    const nolimite = `>=20${" ".repeat(150)}<99`;
    expect(nolimite.length).toBeLessThanOrEqual(200);
    expect(majorSatisfies(nolimite, 22)).toBe(true);
  });

  it("faixa enorme ou com conjuntos/tokens demais → null (sem laço caro)", () => {
    expect(majorSatisfies("22 ".repeat(100), 22)).toBeNull();
    expect(majorSatisfies(Array(30).fill("22").join("||"), 22)).toBeNull();
    expect(majorSatisfies(Array(25).fill("22").join(" "), 22)).toBeNull();
    const t0 = performance.now();
    majorSatisfies("0".repeat(5_000_000), 22);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe("pickNodeMajor", () => {
  it("nada pedido → Node 22 (padrão LTS)", () => {
    const r = pickNodeMajor({});
    expect(r).toMatchObject({ major: 22, source: "default" });
    expect(r.notes.join(" ")).toContain("Node 22");
  });

  it("engines.node vence .nvmrc e .node-version", () => {
    expect(pickNodeMajor({ engines: "^24", nvmrc: "20", nodeVersionFile: "20" })).toMatchObject({ major: 24, source: "engines" });
  });

  it(".nvmrc vence .node-version", () => {
    expect(pickNodeMajor({ nvmrc: "v20.11.1\n", nodeVersionFile: "24" })).toMatchObject({ major: 20, source: "nvmrc" });
  });

  it(".node-version sozinho", () => {
    expect(pickNodeMajor({ nodeVersionFile: "24.1.0" })).toMatchObject({ major: 24, source: "node-version" });
  });

  it("engines que aceita vários: prefere o 22, senão o mais novo que ela aceita", () => {
    expect(pickNodeMajor({ engines: ">=18" }).major).toBe(22);
    expect(pickNodeMajor({ engines: ">=23" }).major).toBe(24);
    expect(pickNodeMajor({ engines: "20 || 24" }).major).toBe(24);
    expect(pickNodeMajor({ engines: "20" }).major).toBe(20);
  });

  it("engines que não aceita nenhum Node disponível → padrão com aviso dos limites", () => {
    const r = pickNodeMajor({ engines: "^16" });
    expect(r).toMatchObject({ major: 22, source: "engines" });
    expect(r.notes.join(" ")).toMatch(/não aceita nenhum Node disponível.*20, 22, 24/);
    expect(r.notes.join(" ")).not.toContain("16");
  });

  it("engines que o painel não entende → padrão com aviso (e não tenta .nvmrc)", () => {
    const r = pickNodeMajor({ engines: "lts/*", nvmrc: "20" });
    expect(r).toMatchObject({ major: 22, source: "engines" });
    expect(r.notes.join(" ")).toContain("engines.node com valor inválido");
    expect(r.notes.join(" ")).not.toContain("lts");
  });

  it(".nvmrc com major fora de 20/22/24 → padrão com aviso", () => {
    const r = pickNodeMajor({ nvmrc: "18.20.1" });
    expect(r).toMatchObject({ major: 22, source: "nvmrc" });
    expect(r.notes.join(" ")).toContain(".nvmrc pede o Node 18");
    expect(pickNodeMajor({ nvmrc: "26" }).major).toBe(22);
  });

  it(".nvmrc sem número (lts/*, node) → padrão com aviso", () => {
    expect(pickNodeMajor({ nvmrc: "lts/*" }).notes.join(" ")).toContain("não indica um número");
    expect(pickNodeMajor({ nodeVersionFile: "node" })).toMatchObject({ major: 22, source: "node-version" });
  });

  it("nunca repete o conteúdo do arquivo nas notas (só o major, ou 'valor inválido')", () => {
    const segredo = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4";
    for (const input of [{ nvmrc: segredo }, { nodeVersionFile: segredo }, { engines: segredo }, { nvmrc: `v18-${segredo}` }]) {
      const r = pickNodeMajor(input);
      expect(r.notes.join("\n")).not.toContain(segredo.slice(0, 12));
      expect(r.notes.join("\n")).toContain("valor inválido");
    }
  });

  it("arquivo vazio ou só com espaço é como se não existisse", () => {
    expect(pickNodeMajor({ engines: "  ", nvmrc: "\n", nodeVersionFile: "24" })).toMatchObject({ major: 24, source: "node-version" });
  });

  it("só a primeira linha do .nvmrc conta (CRLF)", () => {
    expect(pickNodeMajor({ nvmrc: "20\r\n# comentário\r\n" }).major).toBe(20);
  });
});
