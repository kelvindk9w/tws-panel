/**
 * Dispensas "não procede" dos guardrails (as funções puras de @paas/core, as mesmas na tela, na API e no engine):
 * identidade do achado, abrangência, regras inegociáveis e leitura tolerante do arquivo.
 */
import { describe, expect, it } from "vitest";
import {
  applyGuardrailDismissals,
  guardrailDismissalFor,
  guardrailDismissNeedsProof,
  guardrailFindingIdentity,
  isGuardrailDismissible,
  normalizeGuardrailEvidence,
  validGuardrailDismissals,
  type GuardrailDismissal,
  type GuardrailFinding,
  type GuardrailReport,
} from "../src/index";

const D: GuardrailDismissal = {
  id: "d1",
  rule: "weak-credentials",
  service: null,
  match: "target",
  value: "APP_TOKEN_TTL",
  title: "t",
  reason: null,
  by: "admin",
  at: "2026-11-06T12:00:00.000Z",
};

const weak = (service: string): GuardrailFinding => ({
  rule: "weak-credentials",
  level: "block",
  title: "t",
  evidence: `compose.yml: serviço "${service}" define APP_TOKEN_TTL`,
  fix: "f",
  service,
  target: "APP_TOKEN_TTL",
});

function report(findings: GuardrailFinding[]): GuardrailReport {
  return { ranAt: "", dir: "", findings, blockers: findings.filter((f) => f.level === "block").length, warnings: 0, infos: 0 };
}

describe("dispensas dos guardrails", () => {
  it("regras inegociáveis e as que pedem prova", () => {
    for (const r of ["panel-resource", "privileged-container", "host-namespace", "network-hijack", "reserved-name", "panel-image", "proxy-port-conflict", "invalid-compose"]) {
      expect(isGuardrailDismissible(r)).toBe(false);
    }
    expect(isGuardrailDismissible("weak-credentials")).toBe(true);
    expect(guardrailDismissNeedsProof("latest-tag")).toBe(false);
    expect(guardrailDismissNeedsProof("db-port-exposed")).toBe(true);
  });

  it("identidade: alvo, ou a evidência normalizada (sem espaços repetidos, linha e nome do serviço)", () => {
    expect(guardrailFindingIdentity({ target: "X" })).toEqual({ match: "target", value: "X" });
    expect(guardrailFindingIdentity({ evidence: ' a   "web"  b:9 ', service: "web" })).toEqual({ match: "evidence", value: 'a "*" b' });
    expect(guardrailFindingIdentity({})).toEqual({ match: "evidence", value: "" });
    expect(normalizeGuardrailEvidence("x:1")).toBe("x");
  });

  it("abrangência: projeto cobre todos os serviços; serviço cobre só o dele", () => {
    const r = report([weak("web"), weak("api"), { ...weak("db"), level: "warn" }, { ...weak("x"), level: "info", rule: "latest-tag" }]);
    const all = applyGuardrailDismissals(r, [D]);
    expect(all.findings.map((f) => f.service)).toEqual(["x"]);
    expect(all).toMatchObject({ blockers: 0, warnings: 0, infos: 1, dismissed: 3 });
    const one = applyGuardrailDismissals(r, [{ ...D, service: "api" }]);
    expect(one.findings.map((f) => f.service)).toEqual(["web", "db", "x"]);
    expect(one).toMatchObject({ blockers: 1, warnings: 1, dismissed: 1 });
    expect(guardrailDismissalFor({ rule: "weak-credentials", target: "APP_TOKEN_TTL" }, [{ ...D, service: "api" }])).toBeNull();
    expect(applyGuardrailDismissals(report([]), [])).not.toHaveProperty("dismissed");
    expect(applyGuardrailDismissals({ ...report([]), dismissed: 3 }, []).dismissed).toBe(3);
  });

  it("dispensa gravada de regra inegociável não vale", () => {
    const priv: GuardrailFinding = { rule: "privileged-container", level: "block", title: "t", evidence: "e", fix: "f", service: "web" };
    expect(guardrailDismissalFor(priv, [{ ...D, rule: "privileged-container", match: "evidence", value: "e" }])).toBeNull();
  });

  it("leitura tolerante: só entradas íntegras", () => {
    expect(validGuardrailDismissals(null)).toEqual([]);
    expect(
      validGuardrailDismissals([D, 0, null, { ...D, match: "?" }, { ...D, service: 1 }, { ...D, reason: 2 }, { ...D, title: null }, { ...D, by: 1 }, { ...D, at: "" }, { ...D, id: "d2", service: "web", reason: "r" }]),
    ).toEqual([D, { ...D, id: "d2", service: "web", reason: "r" }]);
  });
});
