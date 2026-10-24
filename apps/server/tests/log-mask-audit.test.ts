/**
 * log-mask-audit.test.ts — auditoria de desempenho de TODOS os padrões da
 * máscara: para cada um, o prefixo que ele reconhece repetido com vários
 * separadores, prefixos parciais e cada classe de caractere do corpo. Nenhum
 * pode custar mais que 400 ms para 200 linhas de 8000 caracteres (um padrão
 * quadrático custa segundos).
 */
import { describe, expect, it } from "vitest";
import { LOG_MASK, buildLogMasker } from "../src/services/log-mask.js";

const WIDTH = 8000;
const SEEDS: Record<string, string> = {
  bearer: "bearer ",
  authorization: "authorization: basic ",
  url: "postgres://u:",
  cookie: "cookie: ",
  session: "session=",
  sessionid: "phpsessid=",
  senha: "password=",
  secretkey: "secret_key=",
  token: "token:",
  jwt: "eyJ",
  jwtCompleto: "eyJhbGciOi.eyJzdWIiOi.",
  tws: "tws_pat_",
};
const SEPARATORS = ["", " ", "-", ".", "_", ":", "=", "/", "@", "a", "A", "0", '"', '\\"', "+", ",", ";"];
const FILLERS = ["a", "A", "0", "-", "_", ".", ":", "/", "@", "=", "+", " ", '"', "\\", "%"];

function hostile(seed: string): string[] {
  const out: string[] = [];
  for (const sep of SEPARATORS) out.push((seed + sep).repeat(Math.ceil(WIDTH / (seed.length + sep.length))).slice(0, WIDTH));
  for (let k = 1; k < seed.length; k += 2) out.push(seed.slice(0, k).repeat(Math.ceil(WIDTH / k)).slice(0, WIDTH));
  for (const f of FILLERS) {
    out.push((seed + f.repeat(WIDTH)).slice(0, WIDTH));
    out.push((f.repeat(WIDTH - seed.length) + seed).slice(0, WIDTH));
    out.push((seed + f).repeat(Math.ceil(WIDTH / (seed.length + 1))).slice(0, WIDTH));
  }
  return out;
}

describe("auditoria sistemática de desempenho por padrão", () => {
  for (const [name, seed] of Object.entries(SEEDS)) {
    it(`padrão ${name}: entradas hostis sistemáticas`, () => {
      const mask = buildLogMasker(["valor-secreto-qualquer-1"]);
      const slow: string[] = [];
      for (const input of hostile(seed)) {
        const t0 = performance.now();
        for (let i = 0; i < 200; i++) mask(input);
        const ms = performance.now() - t0;
        if (ms > 400) slow.push(`${ms.toFixed(0)} ms: ${JSON.stringify(input.slice(0, 40))}`);
      }
      expect(slow).toEqual([]);
    });
  }

  it("JWT 'eyJ-' repetido (caso do revisor) custa menos de 2 ms por linha", () => {
    const mask = buildLogMasker([]);
    const s = "eyJ-".repeat(2000);
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) mask(s);
    expect((performance.now() - t0) / 10).toBeLessThan(2);
  });

  it("JWT colado a outro texto não é tocado; com fronteira é mascarado", () => {
    const mask = buildLogMasker([]);
    expect(mask("xeyJhbGciOi.eyJzdWIiOi.abc")).toBe("xeyJhbGciOi.eyJzdWIiOi.abc");
    expect(mask("t eyJhbGciOi.eyJzdWIiOi.abc;")).toBe(`t ${LOG_MASK};`);
    expect(mask("t=eyJhbGciOi.eyJzdWIiOi.abc")).toBe(`t=${LOG_MASK}`);
  });
});
