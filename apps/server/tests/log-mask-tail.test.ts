/**
 * log-mask-tail.test.ts — a ponta descartada de uma linha cortada: só o
 * necessário (não a linha inteira), sem vazar começo de segredo, JWT ou senha
 * em URL, e em tempo linear.
 */
import { describe, expect, it } from "vitest";
import { LOG_LINE_MAX, LOG_MASK, TAIL_RUN_MAX, buildLogMasker, cleanLogText } from "../src/services/log-mask.js";

const SECRET = "Qz9#kLm2-Segredo-Longo-77";
const mask = buildLogMasker([SECRET]);

describe("linha cortada sem espaços (JSON compacto, base64, URL longa)", () => {
  it("não vira só reticências: o começo da linha continua visível", () => {
    const json = '{"a":"' + "x".repeat(7990);
    const out = cleanLogText(json, mask, true);
    expect(out.startsWith('{"a":"xxxx')).toBe(true);
    expect(out.length).toBeGreaterThan(1000);
    expect(out.endsWith("…")).toBe(true);
  });

  it("8001 caracteres começando por um segredo: mascarado e o resto aparece", () => {
    const out = cleanLogText(SECRET + "y".repeat(7975), mask, true);
    expect(out.startsWith(`${LOG_MASK}yyyy`)).toBe(true);
  });

  it("descarta no máximo TAIL_RUN_MAX caracteres da ponta (e não mais) quando não há segredo grande", () => {
    expect(TAIL_RUN_MAX).toBe(512);
    const plain = buildLogMasker([]);
    const out = cleanLogText("a".repeat(1500), plain, true);
    expect(out).toBe("a".repeat(1500 - TAIL_RUN_MAX) + "…");
  });

  it("com espaço perto do fim, só a última palavra vai embora", () => {
    expect(cleanLogText("alfa beta gama", buildLogMasker([]), true)).toBe("alfa beta …");
  });

  it("linha que termina em espaço: só reticências no fim", () => {
    expect(cleanLogText("alfa beta ", buildLogMasker([]), true)).toBe("alfa beta …");
  });
});

describe("começo de JWT ou de senha em URL maiores que a ponta fixa", () => {
  const plain = buildLogMasker([]);

  it("JWT cortado no fim (900 caracteres) é descartado desde o eyJ", () => {
    const jwt = "eyJ" + "A".repeat(400) + "." + "B".repeat(400);
    const out = cleanLogText(`usuario entrou token=1 ${jwt}`, plain, true);
    expect(out).not.toContain("eyJ");
    expect(out.startsWith("usuario entrou")).toBe(true);
  });

  it("senha em URL cortada antes do @ (700 caracteres) é descartada desde o esquema", () => {
    const url = "postgres://app:" + "S".repeat(700);
    const out = cleanLogText(`conectando ${url}`, plain, true);
    expect(out).toBe("conectando …");
  });

  it("URL completa antes do corte (já tem / depois do host) não perde mais que a ponta", () => {
    const out = cleanLogText(`vai para https://example.com/${"p".repeat(700)}`, plain, true);
    expect(out.startsWith("vai para https://example.com/")).toBe(true);
  });

  it("JWT completo no meio ainda é mascarado, não descartado", () => {
    const jwt = "eyJhbGciOi.eyJzdWIiOi.SflKxwRJSMeKKF";
    const out = cleanLogText(`t ${jwt} ${"fim ".repeat(300)}`, plain, true);
    expect(out).toContain(`t ${LOG_MASK} `);
  });
});

describe("segredo maior que a ponta fixa", () => {
  it("segredo de 3000 caracteres cortado no fim: nenhum pedaço dele aparece", () => {
    const big = "Zk".repeat(1500);
    const m = buildLogMasker([big]);
    const out = cleanLogText("inicio " + big.slice(0, 2990), m, true);
    expect(out).not.toContain("ZkZk");
  });
});

describe("desempenho da ponta cortada", () => {
  it("linhas cortadas hostis (terminam em espaço, só espaços, eyJ e :// repetidos) custam pouco", () => {
    const m = buildLogMasker(["valor-secreto-qualquer-1"]);
    const inputs = [
      "a".repeat(7999) + " ",
      " ".repeat(8000),
      "eyJ-".repeat(2000),
      "://".repeat(2666),
      "a:// ".repeat(1600),
      "x".repeat(7000) + "://" + "y".repeat(990),
    ];
    for (const input of inputs) {
      const t0 = performance.now();
      for (let i = 0; i < 200; i++) cleanLogText(input, m, true);
      expect(performance.now() - t0, JSON.stringify(input.slice(0, 20))).toBeLessThan(400);
    }
  });

  it("o corte final continua em LOG_LINE_MAX", () => {
    const out = cleanLogText("palavra ".repeat(1500), buildLogMasker([]), true);
    expect(out.length).toBe(LOG_LINE_MAX + 1);
  });
});
