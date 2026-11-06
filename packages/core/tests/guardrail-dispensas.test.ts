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
  value: "CACHE_SALT",
  title: "t",
  reason: null,
  by: "admin",
  at: "2026-11-06T12:00:00.000Z",
};

const weak = (service: string): GuardrailFinding => ({
  rule: "weak-credentials",
  level: "block",
  title: "t",
  evidence: `compose.yml: serviço "${service}" define CACHE_SALT`,
  fix: "f",
  service,
  target: "CACHE_SALT",
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

  it("identidade: alvo, ou a evidência normalizada (sem espaços repetidos e com o nome do serviço trocado)", () => {
    expect(guardrailFindingIdentity({ target: "X" })).toEqual({ match: "target", value: "X" });
    expect(guardrailFindingIdentity({ evidence: ' a:   serviço "web"  b ', service: "web" })).toEqual({ match: "evidence", value: 'a: serviço "*" b' });
    expect(guardrailFindingIdentity({})).toEqual({ match: "evidence", value: "" });
    // nada é cortado do fim: ":80" e ":443" são alvos diferentes
    expect(normalizeGuardrailEvidence("x:1")).toBe("x:1");
    expect(normalizeGuardrailEvidence('c.yml: serviço "w" usa extra_hosts h:80', "w")).not.toBe(normalizeGuardrailEvidence('c.yml: serviço "w" usa extra_hosts h:443', "w"));
  });

  it("a normalização só troca o serviço do achado: o mesmo nome noutro ponto da evidência continua sendo o alvo", () => {
    // serviço "db" com o volume "db" e serviço "cache" com o volume "cache": volumes diferentes, achados diferentes
    const ev = (s: string) => `compose.yml: serviço "${s}" usa o volume "${s}", que não é do projeto`;
    expect(normalizeGuardrailEvidence(ev("db"), "db")).toBe('compose.yml: serviço "*" usa o volume "db", que não é do projeto');
    const d: GuardrailDismissal = { ...D, rule: "shared-resource", match: "evidence", value: normalizeGuardrailEvidence(ev("db"), "db") };
    const finding = (s: string): GuardrailFinding => ({ rule: "shared-resource", level: "block", title: "t", evidence: ev(s), fix: "f", service: s });
    expect(guardrailDismissalFor(finding("db"), [d])).toBe(d);
    expect(guardrailDismissalFor(finding("cache"), [d])).toBeNull();
  });

  it("abrangência: projeto cobre todos os serviços; serviço cobre só o dele", () => {
    const r = report([weak("web"), weak("api"), { ...weak("db"), level: "warn" }, { ...weak("x"), level: "info", rule: "latest-tag" }]);
    const all = applyGuardrailDismissals(r, [D]);
    expect(all.findings.map((f) => f.service)).toEqual(["x"]);
    expect(all).toMatchObject({ blockers: 0, warnings: 0, infos: 1, dismissed: 3 });
    const one = applyGuardrailDismissals(r, [{ ...D, service: "api" }]);
    expect(one.findings.map((f) => f.service)).toEqual(["web", "db", "x"]);
    expect(one).toMatchObject({ blockers: 1, warnings: 1, dismissed: 1 });
    expect(guardrailDismissalFor({ rule: "weak-credentials", target: "CACHE_SALT" }, [{ ...D, service: "api" }])).toBeNull();
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
