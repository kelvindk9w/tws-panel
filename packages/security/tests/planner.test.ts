/**
 * Testes do planner de correção (planner.ts): o plano deve ter uma ação por
 * fase na ordem segura da spec, flags de confirmação/rollback nas fases de
 * risco, e pré-seleção apenas quando há falha crítica.
 */
import { describe, expect, it } from "vitest";
import {
  SECURITY_PHASES,
  type SecurityCheckResult,
  type SecurityScanReport,
} from "@paas/core";
import { SECURITY_CHECKS } from "../src/checks.js";
import { buildSecurityPlan } from "../src/planner.js";

function makeReport(checks: SecurityCheckResult[]): SecurityScanReport {
  return {
    id: "scan-test",
    scannedAt: new Date().toISOString(),
    durationMs: 10,
    target: "container-teste",
    hardeningIndex: 50,
    hardeningIndexSource: "internal",
    lynisAvailable: false,
    checks,
    summary: {
      total: checks.length,
      pass: checks.filter((c) => c.status === "pass").length,
      fail: checks.filter((c) => c.status === "fail").length,
      unknown: checks.filter((c) => c.status === "unknown").length,
      critical: checks.filter((c) => c.severity === "critical").length,
      warning: checks.filter((c) => c.severity === "warning").length,
    },
  };
}

function fromDefinition(id: string, status: SecurityCheckResult["status"]): SecurityCheckResult {
  const def = SECURITY_CHECKS.find((d) => d.id === id);
  if (!def) throw new Error(`check não existe: ${id}`);
  return {
    id: def.id,
    phase: def.phase,
    title: def.title,
    severity: def.severity,
    status,
    description: def.description,
    remediation: def.remediation,
  };
}

describe("buildSecurityPlan", () => {
  it("gera uma ação por fase, na ordem segura 00→06", () => {
    const plan = buildSecurityPlan(makeReport([fromDefinition("ssh.password-auth", "fail")]));
    expect(plan.actions.map((a) => a.phase)).toEqual(SECURITY_PHASES.map((p) => p.id));
    expect(plan.actions.map((a) => a.phaseKey)).toEqual(SECURITY_PHASES.map((p) => p.key));
    expect(plan.basedOnScanId).toBe("scan-test");
    expect(plan.hardeningIndex).toBe(50);
  });

  it("fases de risco (02 SSH, 03 firewall) exigem confirmação e avisam o impacto", () => {
    const plan = buildSecurityPlan(makeReport([]));
    for (const action of plan.actions) {
      expect(action.hasRollback).toBe(true);
      if (action.phase === "02" || action.phase === "03") {
        expect(action.requiresConfirmation).toBe(true);
        expect(action.impact).toContain("Rollback automático");
      } else {
        expect(action.requiresConfirmation).toBe(false);
        expect(action.impact).toBeNull();
      }
    }
  });

  it("fixesCheckIds contém apenas os checks FALHANDO e corrigíveis da fase", () => {
    const plan = buildSecurityPlan(
      makeReport([
        fromDefinition("ssh.password-auth", "fail"), // fixable, fase 02
        fromDefinition("ssh.root-login", "pass"), // passando — não entra
        fromDefinition("docker.sock-mounted", "fail"), // não-fixable — não entra
      ]),
    );
    const ssh = plan.actions.find((a) => a.phase === "02");
    expect(ssh?.fixesCheckIds).toEqual(["ssh.password-auth"]);
    const audit = plan.actions.find((a) => a.phase === "06");
    expect(audit?.fixesCheckIds).toEqual([]);
  });

  it("pré-seleciona a fase somente quando há falha CRÍTICA corrigível", () => {
    const plan = buildSecurityPlan(
      makeReport([
        fromDefinition("ssh.password-auth", "fail"), // critical → pré-seleciona fase 02
        fromDefinition("ssh.max-auth-tries", "fail"), // warning → não pré-seleciona sozinho
      ]),
    );
    expect(plan.actions.find((a) => a.phase === "02")?.preselected).toBe(true);

    const onlyWarning = buildSecurityPlan(makeReport([fromDefinition("minimal.snapd-absent", "fail")]));
    expect(onlyWarning.actions.find((a) => a.phase === "05")?.preselected).toBe(false);
  });

  it("alreadySatisfied: fase com checks corrigíveis e nenhum falhando", () => {
    const plan = buildSecurityPlan(
      makeReport([
        fromDefinition("ssh.password-auth", "pass"),
        fromDefinition("ssh.root-login", "pass"),
      ]),
    );
    expect(plan.actions.find((a) => a.phase === "02")?.alreadySatisfied).toBe(true);
    expect(plan.actions.find((a) => a.phase === "04")?.alreadySatisfied).toBe(false);
  });

  it("scan vazio gera plano completo sem correções pendentes", () => {
    const plan = buildSecurityPlan(makeReport([]));
    expect(plan.actions).toHaveLength(7);
    expect(plan.actions.every((a) => a.fixesCheckIds.length === 0)).toBe(true);
    expect(plan.actions.every((a) => !a.preselected)).toBe(true);
  });
});
