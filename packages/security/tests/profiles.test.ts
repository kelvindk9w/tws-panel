/**
 * Testes dos perfis de alvo do scanner (profiles.ts + flags hostOnly dos checks):
 * no perfil "container", checks de host são pulados (falsos-positivos de
 * contexto); no perfil "host", tudo roda.
 */
import { describe, expect, it } from "vitest";
import { SECURITY_CHECKS } from "../src/checks.js";
import {
  CONTAINER_SKIP_REASON,
  partitionChecksForProfile,
  profileNote,
} from "../src/profiles.js";

describe("flags hostOnly do catálogo", () => {
  it("checks de host esperados estão marcados como hostOnly", () => {
    const expectedHostOnly = [
      "update.unattended-upgrades",
      "ssh.root-login",
      "ssh.password-auth",
      "ssh.max-auth-tries",
      "ssh.forwarding-disabled",
      "firewall.ufw-active",
      "firewall.default-deny",
      "net.sysctl-hardening",
      "intrusion.fail2ban",
      "intrusion.apparmor",
      "minimal.snapd-absent",
      "minimal.unnecessary-services",
      "audit.auditd",
      "audit.aide-baseline",
      "audit.rkhunter",
      "audit.recurring-scan",
    ];
    const marked = SECURITY_CHECKS.filter((c) => c.hostOnly).map((c) => c.id);
    expect(marked.sort()).toEqual(expectedHostOnly.sort());
  });
});

describe("partitionChecksForProfile", () => {
  it("perfil host roda tudo e não pula nada", () => {
    const { run, skipped } = partitionChecksForProfile(SECURITY_CHECKS, "host");
    expect(run).toHaveLength(SECURITY_CHECKS.length);
    expect(skipped).toHaveLength(0);
  });

  it("perfil container pula os checks hostOnly com motivo documentado", () => {
    const { run, skipped } = partitionChecksForProfile(SECURITY_CHECKS, "container");
    expect(run.length + skipped.length).toBe(SECURITY_CHECKS.length);
    expect(skipped.length).toBeGreaterThan(0);
    for (const s of skipped) {
      expect(s.reason).toBe(CONTAINER_SKIP_REASON);
      expect(s.id.length).toBeGreaterThan(0);
      expect(s.title.length).toBeGreaterThan(0);
    }
    // nenhum check hostOnly roda em container
    expect(run.every((c) => !c.hostOnly)).toBe(true);
  });

  it("perfil container mantém checks aplicáveis (pacotes, usuários, portas)", () => {
    const { run } = partitionChecksForProfile(SECURITY_CHECKS, "container");
    const ids = run.map((c) => c.id);
    for (const applicable of [
      "update.pending-packages",
      "user.only-root-uid0",
      "user.root-password-locked",
      "user.non-root-sudo",
      "net.db-ports-exposed",
      "net.docker-api-exposed",
      "net.listening-inventory",
      "supplychain.third-party-repos",
      "minimal.legacy-clients",
    ]) {
      expect(ids, applicable).toContain(applicable);
    }
  });
});

describe("profileNote", () => {
  it("host não tem nota", () => {
    expect(profileNote("host")).toBeNull();
  });

  it("container explica os falsos-positivos de contexto", () => {
    const note = profileNote("container");
    expect(note).toContain("falsos-positivos");
    expect(note).toContain("PAAS_TARGET=host");
  });
});
