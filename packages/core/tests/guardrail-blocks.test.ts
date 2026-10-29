import { describe, expect, it } from "vitest";
import { guardrailBlockKey, unacceptedBlocks } from "../src/monitoring";

describe("bloqueios do guardrail aceitos pela pessoa", () => {
  it("a chave junta regra, serviço e evidência (serviço ausente vira vazio)", () => {
    expect(guardrailBlockKey({ rule: "r1", service: "web", evidence: "ev" })).toBe("r1|web|ev");
    expect(guardrailBlockKey({ rule: "r1", service: undefined, evidence: "ev" })).toBe("r1||ev");
  });

  it("devolve só os bloqueios que não estão na lista aceita", () => {
    const a = { rule: "r1", service: "web", evidence: "a", level: "block" };
    const b = { rule: "r2", service: undefined, evidence: "b", level: "block" };
    const aviso = { rule: "r3", service: "web", evidence: "c", level: "warn" };
    const semNivel = { rule: "r4", service: "db", evidence: "d" };
    const todos = [a, b, aviso, semNivel];
    expect(unacceptedBlocks(todos, [])).toEqual([a, b, semNivel]);
    expect(unacceptedBlocks(todos, [guardrailBlockKey(a), guardrailBlockKey(semNivel)])).toEqual([b]);
  });
});
