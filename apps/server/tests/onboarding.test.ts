/**
 * onboarding.test.ts — status de cada passo do roteiro "Deixe o painel
 * pronto", calculado do estado REAL que o painel já conhece: relatório e
 * histórico de segurança, 2FA da conta, domínio do painel (PAAS_PANEL_DOMAIN)
 * e servidor/domínios de e-mail. Nada de caixinha marcada à mão.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecurityCheckResult, SecurityHistoryEntry, SecurityScanReport } from "@paas/core";
import {
  buildOnboardingResponse,
  createOnboardingChecks,
  emailState,
  domainDnsOk,
  hardeningState,
  notificationsState,
  panelDomainState,
  twoFactorState,
  type OnboardingChecks,
} from "../src/services/onboarding.js";
import { UserStore } from "../src/services/user-store.js";

function check(id: string, phase: SecurityCheckResult["phase"], status: SecurityCheckResult["status"]): SecurityCheckResult {
  return { id, phase, title: id, severity: "warning", status, description: "", remediation: "" };
}

function report(checks: SecurityCheckResult[], index: number | null = 76, source: "lynis" | "internal" = "lynis"): SecurityScanReport {
  return {
    id: "scan-1",
    scannedAt: "2026-10-01T10:00:00Z",
    durationMs: 1000,
    target: "host",
    hardeningIndex: index,
    hardeningIndexSource: source,
    lynisAvailable: source === "lynis",
    checks,
    summary: { total: checks.length, pass: 0, fail: 0, unknown: 0, critical: 0, warning: 0 },
    profile: "host",
    skippedChecks: [],
    profileNote: null,
  };
}

const applied = (phase: SecurityHistoryEntry["phase"], status: SecurityHistoryEntry["status"] = "success", dryRun = false): SecurityHistoryEntry => ({
  id: `job-${phase}`,
  at: "2026-10-01T09:00:00Z",
  kind: "job",
  phase,
  dryRun,
  status,
});

// Uma checagem corrigível por fase (00 a 07), todas aprovadas.
const ALL_PASS = [
  check("update.pending-packages", "00", "pass"),
  check("user.non-root-sudo", "01", "pass"),
  check("ssh.forwarding-disabled", "02", "pass"),
  check("firewall.default-deny", "03", "pass"),
  check("intrusion.apparmor", "04", "pass"),
  check("minimal.legacy-clients", "05", "pass"),
  check("audit.aide-baseline", "06", "pass"),
  check("extra.accounting", "07", "pass"),
];

describe("proteções da VPS (hardening)", () => {
  it("sem varredura e sem fase aplicada → pendente, explicando que o painel ainda não conferiu", () => {
    const s = hardeningState(null, []);
    expect(s.status).toBe("pending");
    expect(s.detail).toMatch(/ainda não conferiu/);
  });

  it("todas as fases resolvidas → feito, com a nota do Lynis", () => {
    const s = hardeningState(report(ALL_PASS, 86), []);
    expect(s.status).toBe("done");
    expect(s.detail).toMatch(/Todas as 8 fases/);
    expect(s.detail).toMatch(/nota do Lynis 86/);
  });

  it("parte aplicada → em andamento: quantas fases, a nota e o que falta", () => {
    const checks = ALL_PASS.map((c) => (c.phase === "03" || c.phase === "07" ? { ...c, status: "fail" as const } : c));
    const s = hardeningState(report(checks, 70), [applied("00"), applied("01")]);
    expect(s.status).toBe("in_progress");
    expect(s.detail).toMatch(/6 de 8 fases/);
    expect(s.detail).toMatch(/nota do Lynis 70/);
    expect(s.detail).toMatch(/Firewall \(UFW\)/);
  });

  it("nada aprovado e nada aplicado → pendente; nota interna aparece como tal", () => {
    const checks = ALL_PASS.map((c) => ({ ...c, status: "fail" as const }));
    const s = hardeningState(report(checks, 40, "internal"), []);
    expect(s.status).toBe("pending");
    expect(s.detail).toMatch(/0 de 8 fases/);
    expect(s.detail).toMatch(/nota interna 40/);
  });

  it("fase aplicada com sucesso conta como resolvida mesmo com a checagem ainda reprovada (caso Contabo)", () => {
    const checks = ALL_PASS.map((c) => (c.phase === "02" ? { ...c, status: "fail" as const } : c));
    expect(hardeningState(report(checks), [applied("02")]).status).toBe("done");
    // Simulação, falha ou reversão não contam como aplicada.
    expect(hardeningState(report(checks), [applied("02", "success", true)]).status).toBe("in_progress");
    expect(hardeningState(report(checks), [applied("02", "rolled_back")]).status).toBe("in_progress");
  });

  it("sem varredura mas com fases aplicadas → em andamento; sem nota, a frase não inventa uma", () => {
    const s = hardeningState(null, [applied("00")]);
    expect(s.status).toBe("in_progress");
    expect(s.detail).toMatch(/1 de 8 fases/);
    expect(s.detail).not.toMatch(/nota/);
    expect(hardeningState(report(ALL_PASS, null), []).detail).not.toMatch(/nota/);
  });
});

describe("verificação em duas etapas", () => {
  it("ligada → feito; desligada → pendente, dizendo que só a senha protege", () => {
    expect(twoFactorState(true).status).toBe("done");
    const off = twoFactorState(false);
    expect(off.status).toBe("pending");
    expect(off.detail).toMatch(/só pela senha/);
  });
});

describe("domínio do painel", () => {
  const IP = "203-0-113-10.sslip.io";
  const D = "painel.exemplo.com.br";
  const base = { ipAddress: IP, domain: null, active: false, certificateValid: false, ipAccessDisabled: false, openedViaDomain: false };

  it("só o endereço automático sslip.io → a fazer, explicando que o nome tem o IP da VPS", () => {
    const s = panelDomainState(base);
    expect(s.status).toBe("pending");
    expect(s.detail).toContain(`https://${IP}`);
    expect(s.detail).toMatch(/IP da VPS no nome/);
  });

  it("domínio cadastrado sem DNS conferido → em andamento, dizendo que falta o DNS", () => {
    const s = panelDomainState({ ...base, domain: D });
    expect(s.status).toBe("in_progress");
    expect(s.detail).toMatch(/DNS/);
  });

  it("DNS certo, certificado ainda não válido → em andamento, falta o certificado", () => {
    const s = panelDomainState({ ...base, domain: D, active: true });
    expect(s.status).toBe("in_progress");
    expect(s.detail).toMatch(/certificado/);
  });

  it("certificado válido, mas aberto pelo IP → em andamento: abrir pelo endereço novo", () => {
    const s = panelDomainState({ ...base, domain: D, active: true, certificateValid: true });
    expect(s.status).toBe("in_progress");
    expect(s.detail).toContain(`https://${D}`);
  });

  it("aberto pelo domínio novo com certificado, IP ainda ativo → feito, com o aviso do IP", () => {
    const s = panelDomainState({ ...base, domain: D, active: true, certificateValid: true, openedViaDomain: true });
    expect(s.status).toBe("done");
    expect(s.detail).toMatch(/acesso pelo IP ainda ativo/);
  });

  it("IP desativado e certificado válido → feito", () => {
    const s = panelDomainState({ ...base, domain: D, active: true, certificateValid: true, ipAccessDisabled: true });
    expect(s.status).toBe("done");
    expect(s.detail).toContain(`https://${D}`);
    expect(s.detail).not.toMatch(/ainda ativo/);
  });

  it("acesso por túnel SSH → feito: o painel não tem endereço na internet", () => {
    const s = panelDomainState({ ...base, ipAddress: null });
    expect(s.status).toBe("done");
    expect(s.detail).toMatch(/túnel SSH/);
  });

  it("domínio próprio já configurado na instalação (PAAS_PANEL_DOMAIN sem sslip.io) → feito", () => {
    const s = panelDomainState({ ...base, ipAddress: D });
    expect(s.status).toBe("done");
    expect(s.detail).toContain(`https://${D}`);
  });
});

describe("e-mail do servidor", () => {
  it("servidor nunca iniciado e nenhum domínio → pendente", () => {
    expect(emailState({ installed: false, running: false, domains: [] }).status).toBe("pending");
  });

  it("servidor ligado com domínio e DNS conferido → feito", () => {
    const s = emailState({ installed: true, running: true, domains: [{ name: "envio.exemplo.com.br", dnsOk: true }] });
    expect(s.status).toBe("done");
    expect(s.detail).toContain("envio.exemplo.com.br");
  });

  it("ligado sem domínio, parado, ou DNS ainda não conferido → em andamento, dizendo o que falta", () => {
    expect(emailState({ installed: true, running: true, domains: [] }).detail).toMatch(/falta adicionar um domínio/);
    const parado = emailState({ installed: true, running: false, domains: [{ name: "envio.exemplo.com.br", dnsOk: true }] });
    expect(parado.status).toBe("in_progress");
    expect(parado.detail).toMatch(/parado/);
    const semDns = emailState({ installed: true, running: true, domains: [{ name: "envio.exemplo.com.br", dnsOk: false }] });
    expect(semDns.status).toBe("in_progress");
    expect(semDns.detail).toMatch(/falta conferir o DNS/);
    expect(emailState({ installed: false, running: false, domains: [{ name: "envio.exemplo.com.br", dnsOk: null }] }).status).toBe(
      "in_progress",
    );
  });

  it("não deu para saber se o servidor está ligado → não confirmado (nunca 'feito')", () => {
    const s = emailState({ installed: true, running: null, domains: [{ name: "envio.exemplo.com.br", dnsOk: true }] });
    expect(s.status).toBe("unknown");
  });
});

describe("notificações", () => {
  const ch = (id: "telegram" | "email", connected: boolean, tested: boolean) => ({ id, connected, tested });

  it("sem canal conectado: pendente, dizendo que hoje os alertas só aparecem dentro do painel", () => {
    const s = notificationsState({ channels: [ch("telegram", false, false), ch("email", false, false)] });
    expect(s.status).toBe("pending");
    expect(s.detail).toMatch(/dentro do painel/);
  });

  it("conectado mas sem teste: em andamento, pedindo o teste", () => {
    const s = notificationsState({ channels: [ch("telegram", true, false), ch("email", false, false)] });
    expect(s.status).toBe("in_progress");
    expect(s.detail).toMatch(/Telegram/);
    expect(s.detail).toMatch(/Enviar teste/);
  });

  it("pelo menos um canal conectado e testado: feito, citando os canais", () => {
    expect(notificationsState({ channels: [ch("telegram", true, true), ch("email", false, false)] })).toEqual({
      status: "done",
      detail: "Avisos chegando por Telegram.",
    });
    expect(notificationsState({ channels: [ch("telegram", true, true), ch("email", true, false)] }).detail).toBe(
      "Avisos chegando por Telegram e e-mail (o e-mail ainda sem teste).",
    );
    expect(notificationsState({ channels: [ch("telegram", true, true), ch("email", true, true)] }).detail).toBe(
      "Avisos chegando por Telegram e e-mail.",
    );
  });
});

describe("buildOnboardingResponse", () => {
  const fixed = (status: Awaited<ReturnType<OnboardingChecks["email"]>>["status"]) => async () => ({ status, detail: status });
  const checks: OnboardingChecks = {
    hardening: fixed("done"),
    "two-factor": fixed("pending"),
    "panel-domain": fixed("soon"),
    email: fixed("pending"),
    notifications: fixed("soon"),
  };

  it("monta os passos na ordem, com 'opcional' e o progresso da conta", async () => {
    const res = await buildOnboardingResponse(checks, { userId: "u1" }, undefined, "/opt/tws-projects");
    expect(res.steps.map((s) => s.id)).toEqual(["hardening", "two-factor", "panel-domain", "email", "notifications"]);
    expect(res.steps.find((s) => s.id === "email")?.optional).toBe(true);
    expect(res.steps.find((s) => s.id === "hardening")?.optional).toBe(false);
    expect(res.started).toBe(false);
    expect(res.complete).toBe(false);
    expect(res.projectsDir).toBe("/opt/tws-projects");
  });

  it("'Não vou usar' vale só para passo opcional que não está feito", async () => {
    const res = await buildOnboardingResponse(
      { ...checks, "two-factor": fixed("done") },
      { userId: "u1" },
      { startedAt: "2026-10-01T10:00:00Z", skipped: ["email", "two-factor"] },
      "/opt/tws-projects",
    );
    expect(res.started).toBe(true);
    expect(res.steps.find((s) => s.id === "email")?.status).toBe("skipped");
    expect(res.steps.find((s) => s.id === "two-factor")?.status).toBe("done");
    expect(res.complete).toBe(true);

    const feito = await buildOnboardingResponse(
      { ...checks, email: fixed("done") },
      { userId: "u1" },
      { startedAt: null, skipped: ["email"] },
      "/x",
    );
    expect(feito.steps.find((s) => s.id === "email")?.status).toBe("done");
  });

  it("um passo que falha ao conferir vira 'não confirmado', sem derrubar os outros", async () => {
    const res = await buildOnboardingResponse(
      {
        ...checks,
        email: async () => {
          throw new Error("docker fora do ar");
        },
      },
      { userId: "u1" },
      undefined,
      "/x",
    );
    const email = res.steps.find((s) => s.id === "email");
    expect(email?.status).toBe("unknown");
    expect(email?.detail).toMatch(/Não foi possível conferir/);
    expect(res.steps.find((s) => s.id === "hardening")?.status).toBe("done");
  });
});

describe("createOnboardingChecks — fontes reais", () => {
  let dir: string;
  let users: UserStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "paas-onboarding-"));
    users = new UserStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lê relatório e histórico de segurança do disco, o 2FA da conta e o domínio do painel", async () => {
    const user = await users.create("admin", "hash");
    await writeFile(path.join(dir, "security-last-scan.json"), JSON.stringify(report(ALL_PASS, 86)));
    await writeFile(path.join(dir, "security-history.json"), JSON.stringify({ entries: [applied("00")] }));
    const checks = createOnboardingChecks({
      config: { dataDir: dir, panelDomain: "203-0-113-10.sslip.io" },
      userStore: users,
      emailFacts: async () => ({ installed: false, running: false, domains: [] }),
    });
    const ctx = { userId: user.id };
    expect((await checks.hardening(ctx)).status).toBe("done");
    expect((await checks["two-factor"](ctx)).status).toBe("pending");
    expect((await checks["panel-domain"](ctx)).status).toBe("pending");
    expect((await checks.email(ctx)).status).toBe("pending");
    // sem a fonte das notificações: nenhum canal
    expect((await checks.notifications(ctx)).status).toBe("pending");
  });

  it("notificações: usa a fonte do serviço de notificações", async () => {
    const user = await users.create("admin", "hash");
    const checks = createOnboardingChecks({
      config: { dataDir: dir, panelDomain: null },
      userStore: users,
      emailFacts: async () => ({ installed: false, running: false, domains: [] }),
      notificationFacts: async () => ({ channels: [{ id: "email", connected: true, tested: true }] }),
    });
    expect(await checks.notifications({ userId: user.id })).toEqual({ status: "done", detail: "Avisos chegando por e-mail." });
  });

  it("domínio do painel: usa a fonte do domínio com o endereço por onde a página foi aberta", async () => {
    const facts = vi.fn(async (host: string) => ({
      ipAddress: "203-0-113-10.sslip.io",
      domain: "painel.exemplo.com.br",
      active: true,
      certificateValid: true,
      ipAccessDisabled: false,
      openedViaDomain: host === "painel.exemplo.com.br",
    }));
    const checks = createOnboardingChecks({
      config: { dataDir: dir, panelDomain: "203-0-113-10.sslip.io" },
      userStore: users,
      emailFacts: async () => ({ installed: false, running: false, domains: [] }),
      panelDomainFacts: facts,
    });
    expect((await checks["panel-domain"]({ userId: "x", host: "painel.exemplo.com.br" })).status).toBe("done");
    expect((await checks["panel-domain"]({ userId: "x", host: "203-0-113-10.sslip.io" })).status).toBe("in_progress");
    expect((await checks["panel-domain"]({ userId: "x" })).status).toBe("in_progress");
    expect(facts).toHaveBeenLastCalledWith("");
  });

  it("sem arquivos de segurança (painel novo) → pendente; conta inexistente → 2FA pendente", async () => {
    const checks = createOnboardingChecks({
      config: { dataDir: dir, panelDomain: null },
      userStore: users,
      emailFacts: async () => ({ installed: false, running: false, domains: [] }),
    });
    expect((await checks.hardening({ userId: "x" })).status).toBe("pending");
    expect((await checks["two-factor"]({ userId: "x" })).status).toBe("pending");
  });
});

/**
 * Validação real (07/10/2026): e-mail funcionando (DKIM, SPF e DMARC passando
 * no Gmail) e o passo 4 continuava "em andamento" — a regra exigia TUDO certo
 * na última verificação, inclusive o PTR, que é recomendação e às vezes fica
 * "não deu para conferir" quando o DNS demora. Agora valem os registros do
 * domínio (A, MX, SPF, DKIM, DMARC).
 */
describe("e-mail do servidor — DNS conferido sem depender do PTR", () => {
  it("registros certos e PTR pendente → DNS ok", () => {
    expect(domainDnsOk({ at: "x", ok: 5, total: 6, recordsOk: true })).toBe(true);
  });
  it("registro faltando → não ok, mesmo com o PTR certo", () => {
    expect(domainDnsOk({ at: "x", ok: 5, total: 6, recordsOk: false })).toBe(false);
  });
  it("verificação antiga, sem recordsOk: vale a regra antiga (tudo certo)", () => {
    expect(domainDnsOk({ at: "x", ok: 6, total: 6 })).toBe(true);
    expect(domainDnsOk({ at: "x", ok: 5, total: 6 })).toBe(false);
  });
  it("nunca verificado → null", () => {
    expect(domainDnsOk(null)).toBeNull();
  });
});
