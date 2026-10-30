/**
 * Diagnóstico de e-mail do projeto: as regras de "por que nada chegou" (mail-hints.ts), a reunião dos fatos
 * (mail-diagnosis-service.ts) e o teste de conexão (mail-probe-service.ts). Tudo com dublês, sem rede nem Docker.
 */
import { describe, expect, it, vi } from "vitest";
import type { MailProbeResult, MailRefusalItem, MailSendItem, Project, ProjectEmailConfig } from "@paas/core";
import { buildMailHints, type MailHintFacts } from "../src/services/mail-hints.js";
import { DIAGNOSIS_WINDOW_HOURS, MailDiagnosisService, type MailDiagnosisDeps } from "../src/services/mail-diagnosis-service.js";
import { MailProbeService } from "../src/services/mail-probe-service.js";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const facts = (over: Partial<MailHintFacts> = {}): MailHintFacts => ({
  emailEnabled: true,
  hasMailbox: true,
  testInboxOn: false,
  emailNeedsRestart: false,
  silentMailer: null,
  laravel: false,
  unlinked: [],
  queueWithoutWorker: false,
  refusals: { count: 0, topKind: null },
  neverConnected: false,
  ...over,
});

describe("buildMailHints", () => {
  it("tudo certo e já conectou: nada a dizer", () => {
    expect(buildMailHints(facts())).toEqual([]);
  });

  it("e-mail desligado: só isso (mais mailer e fila, que valem com outro provedor)", () => {
    expect(buildMailHints(facts({ emailEnabled: false, testInboxOn: true, emailNeedsRestart: true }))).toEqual([{ code: "email_disabled", severity: "problem" }]);
    expect(buildMailHints(facts({ emailEnabled: false, silentMailer: "log", queueWithoutWorker: true })).map((h) => h.code)).toEqual([
      "email_disabled",
      "mailer_not_smtp",
      "queue_no_worker",
    ]);
  });

  it("cada causa vira um item, na ordem", () => {
    const hints = buildMailHints(
      facts({
        hasMailbox: false,
        testInboxOn: true,
        emailNeedsRestart: true,
        silentMailer: "array",
        laravel: true,
        unlinked: ["MAIL_HOST", "MAIL_PASSWORD"],
        queueWithoutWorker: true,
        refusals: { count: 4, topKind: "auth_failed" },
      }),
    );
    expect(hints.map((h) => h.code)).toEqual(["no_mailbox", "test_inbox_on", "needs_restart", "mailer_not_smtp", "smtp_not_linked", "queue_no_worker", "recent_refusals"]);
    expect(hints.find((h) => h.code === "mailer_not_smtp")!.params).toEqual({ mailer: "array" });
    expect(hints.find((h) => h.code === "smtp_not_linked")!.params).toEqual({ names: "MAIL_HOST, MAIL_PASSWORD" });
    expect(hints.find((h) => h.code === "recent_refusals")!.params).toEqual({ count: "4", kind: "auth_failed" });
  });

  it("variáveis não ligadas só contam em Laravel; recusas sem tipo dominante não trazem kind", () => {
    expect(buildMailHints(facts({ unlinked: ["MAIL_HOST"] }))).toEqual([]);
    expect(buildMailHints(facts({ refusals: { count: 1, topKind: null } }))[0]!.params).toEqual({ count: "1" });
  });

  it("'nunca conectou' só aparece quando nada mais explica", () => {
    expect(buildMailHints(facts({ neverConnected: true }))).toEqual([{ code: "app_never_connected", severity: "info" }]);
    expect(buildMailHints(facts({ neverConnected: true, testInboxOn: true })).map((h) => h.code)).toEqual(["test_inbox_on"]);
  });
});

const project = (over: Partial<Project> = {}): Project => ({ id: "p1", name: "Loja", slug: "loja", lastDeployAt: hoursAgo(48), detection: null, ...over }) as Project;
const emailOn: ProjectEmailConfig = { enabled: true, domain: "example.com", mailbox: "loja@example.com", mailFrom: "loja@example.com", env: {} };
const emailOff: ProjectEmailConfig = { enabled: false, domain: null, mailbox: null, mailFrom: null, env: {} };
const send = (at: string) => ({ at }) as MailSendItem;
const ref = (at: string, kind: MailRefusalItem["kind"] = "auth_failed") => ({ at, kind, login: "loja@example.com", projectId: "p1", projectName: "Loja" }) as MailRefusalItem;

function service(over: Partial<MailDiagnosisDeps> = {}) {
  const deps: MailDiagnosisDeps = {
    emailConfig: async () => emailOn,
    emailChangedAt: async () => hoursAgo(100),
    emailValues: async () => ({ SMTP_HOST: "mail.example.com", SMTP_USER: "loja@example.com", SMTP_PASS: "Senha-da-caixa-123" }),
    testInboxEnabled: async () => false,
    sends: async () => ({ items: [], total: 0 }),
    refusals: async () => ({ items: [], total: 0 }),
    savedEnv: async () => ({}),
    sourceDir: () => "/srv/loja",
    detectFramework: async () => null,
    hasQueueWorker: async () => false,
    readLaravelDefaults: async () => ({ queue: null, mail: null, log: null }),
    now: () => NOW,
    ...over,
  };
  return new MailDiagnosisService(deps);
}

describe("MailDiagnosisService", () => {
  it("envio recente: sem dicas, última tentativa aceita", async () => {
    const d = await service({ sends: async () => ({ items: [send(hoursAgo(2))], total: 5 }) }).diagnose(project());
    expect(d).toMatchObject({ windowHours: DIAGNOSIS_WINDOW_HOURS, noSendsRecent: false, hints: [], notices: [], lastAttempt: { at: hoursAgo(2), outcome: "accepted", kind: null } });
  });

  it("última tentativa é a mais nova entre envio aceito e recusa", async () => {
    const newerRefusal = await service({ sends: async () => ({ items: [send(hoursAgo(30))], total: 1 }), refusals: async () => ({ items: [ref(hoursAgo(1), "tls_error")], total: 1 }) }).diagnose(project());
    expect(newerRefusal.lastAttempt).toEqual({ at: hoursAgo(1), outcome: "refused", kind: "tls_error" });
    const newerSend = await service({ sends: async () => ({ items: [send(hoursAgo(1))], total: 1 }), refusals: async () => ({ items: [ref(hoursAgo(5))], total: 1 }) }).diagnose(project());
    expect(newerSend.lastAttempt).toMatchObject({ outcome: "accepted" });
  });

  it("sem envio na janela: explica; recusas recentes entram com o tipo mais frequente", async () => {
    const d = await service({
      sends: async () => ({ items: [send(hoursAgo(40))], total: 3 }),
      refusals: async () => ({ items: [ref(hoursAgo(1)), ref(hoursAgo(2), "tls_error"), ref(hoursAgo(3)), ref(hoursAgo(90))], total: 4 }),
    }).diagnose(project());
    expect(d.noSendsRecent).toBe(true);
    expect(d.hints).toEqual([{ code: "recent_refusals", severity: "problem", params: { count: "3", kind: "auth_failed" } }]);
  });

  it("e-mail desligado, caixa de teste ligada e reinício pendente", async () => {
    expect((await service({ emailConfig: async () => emailOff }).diagnose(project())).hints.map((h) => h.code)).toEqual(["email_disabled"]);
    expect((await service({ testInboxEnabled: async () => true }).diagnose(project())).hints.map((h) => h.code)).toEqual(["test_inbox_on"]);
    // mudou depois do último deploy
    const pending = await service({ emailChangedAt: async () => hoursAgo(1) }).diagnose(project());
    expect(pending.hints.map((h) => h.code)).toEqual(["needs_restart"]);
    // nunca publicado: não é "falta reiniciar"
    expect((await service({ emailChangedAt: async () => hoursAgo(1) }).diagnose(project({ lastDeployAt: null }))).hints.map((h) => h.code)).not.toContain("needs_restart");
    // caixa sem senha conhecida
    expect((await service({ emailValues: async () => ({}) }).diagnose(project())).hints.map((h) => h.code)).toEqual(["no_mailbox"]);
  });

  it("caixa de teste que falha ao consultar não derruba o diagnóstico", async () => {
    const d = await service({ testInboxEnabled: async () => Promise.reject(new Error("mailpit fora")), sends: async () => ({ items: [], total: 1 }) }).diagnose(project());
    expect(d.hints).toEqual([]);
  });

  it("MAIL_MAILER=log explícito em qualquer projeto", async () => {
    const d = await service({ savedEnv: async () => ({ MAIL_MAILER: "log" }), sends: async () => ({ items: [], total: 1 }) }).diagnose(project());
    expect(d.hints).toEqual([{ code: "mailer_not_smtp", severity: "problem", params: { mailer: "log" } }]);
    expect(d.notices).toEqual([]);
  });

  describe("projeto Laravel", () => {
    const laravel = (over: Partial<MailDiagnosisDeps> = {}) =>
      service({ detectFramework: async () => "laravel", sends: async () => ({ items: [], total: 1 }), ...over });

    it("fila sem worker vira aviso do projeto e item da dica; LOG_CHANNEL é só informação", async () => {
      const d = await laravel({ savedEnv: async () => ({ QUEUE_CONNECTION: "redis", MAIL_HOST: "mail.example.com", MAIL_USERNAME: "loja@example.com", MAIL_PASSWORD: "Senha-da-caixa-123" }) }).diagnose(project());
      expect(d.notices).toEqual([
        { code: "queue_no_worker", severity: "warning" },
        { code: "log_channel_stderr", severity: "info" },
      ]);
      expect(d.hints.map((h) => h.code)).toEqual(["queue_no_worker"]);
    });

    it("com worker no compose, não avisa; com envio recente os avisos continuam", async () => {
      const d = await laravel({ savedEnv: async () => ({ QUEUE_CONNECTION: "database" }), hasQueueWorker: async () => true, sends: async () => ({ items: [send(hoursAgo(1))], total: 1 }) }).diagnose(project());
      expect(d.notices.map((n) => n.code)).toEqual(["log_channel_stderr"]);
      expect(d.hints).toEqual([]);
    });

    it("padrão do projeto (Laravel 11: database e log) quando as variáveis não existem", async () => {
      const d = await laravel({ readLaravelDefaults: async () => ({ queue: "database", mail: "log", log: "stack" }) }).diagnose(project());
      expect(d.hints.map((h) => h.code)).toEqual(["mailer_not_smtp", "smtp_not_linked", "queue_no_worker"]);
    });

    it("MAIL_* ligadas ao e-mail do painel, ou com o mesmo valor, não são apontadas", async () => {
      const linked = await laravel({
        emailConfig: async () => ({ ...emailOn, envLinks: { MAIL_HOST: "SMTP_HOST", MAIL_USERNAME: "SMTP_USER", MAIL_PASSWORD: "SMTP_PASS" } }),
      }).diagnose(project());
      expect(linked.hints).toEqual([]);
      const same = await laravel({ savedEnv: async () => ({ MAIL_HOST: "mail.example.com", MAIL_USERNAME: "loja@example.com", MAIL_PASSWORD: "Senha-da-caixa-123" }) }).diagnose(project());
      expect(same.hints).toEqual([]);
      const wrongPass = await laravel({ savedEnv: async () => ({ MAIL_HOST: "mail.example.com", MAIL_USERNAME: "loja@example.com", MAIL_PASSWORD: "outra" }) }).diagnose(project());
      expect(wrongPass.hints).toEqual([{ code: "smtp_not_linked", severity: "problem", params: { names: "MAIL_PASSWORD" } }]);
      // a senha nunca aparece no resultado
      expect(JSON.stringify(wrongPass)).not.toContain("Senha-da-caixa-123");
      expect(JSON.stringify(wrongPass)).not.toContain("outra");
    });

    it("e-mail desligado: não cobra ligação das variáveis", async () => {
      const d = await laravel({ emailConfig: async () => emailOff }).diagnose(project());
      expect(d.hints.map((h) => h.code)).toEqual(["email_disabled"]);
    });

    it("projeto compose: o arquivo do compose entra na busca do worker", async () => {
      const hasQueueWorker = vi.fn(async () => true);
      await laravel({ hasQueueWorker }).diagnose(project({ detection: { type: "compose", composeFile: "docker/compose.yml" } as never }));
      expect(hasQueueWorker).toHaveBeenCalledWith("/srv/loja", "docker/compose.yml");
    });

    it("variáveis ilegíveis (cofre) ou busca do worker que falha: segue sem afirmar", async () => {
      const d = await laravel({ savedEnv: async () => Promise.reject(new Error("cofre")), hasQueueWorker: async () => Promise.reject(new Error("io")) }).diagnose(project());
      expect(d.notices.map((n) => n.code)).toEqual(["log_channel_stderr"]);
    });

    it("detecção que falha = não é Laravel", async () => {
      const d = await service({ detectFramework: async () => Promise.reject(new Error("io")), sends: async () => ({ items: [], total: 1 }) }).diagnose(project());
      expect(d.notices).toEqual([]);
    });
  });

  it("nunca conectou: dica informativa", async () => {
    const d = await service().diagnose(project());
    expect(d.hints).toEqual([{ code: "app_never_connected", severity: "info" }]);
    expect(d.lastAttempt).toBeNull();
  });
});

describe("MailProbeService", () => {
  const OK: MailProbeResult = { ok: true, host: "mail.example.com", port: 587, passed: ["connect", "ehlo", "starttls", "certificate", "auth"], failedStep: null, failure: null, detail: null, elapsedMs: 40 };
  const audit = () => ({ record: vi.fn(async () => undefined) });

  it("usa as credenciais reais da caixa, audita sem credencial e devolve o resultado", async () => {
    const probe = vi.fn(async () => OK);
    const a = audit();
    const svc = new MailProbeService({ smtpValues: async () => ({ SMTP_HOST: "mail.example.com", SMTP_PORT: "587", SMTP_USER: "loja@example.com", SMTP_PASS: "Senha-da-caixa-123" }), probe, audit: a });
    expect(await svc.run(project(), "admin")).toEqual(OK);
    expect(probe).toHaveBeenCalledWith({ host: "mail.example.com", port: 587, username: "loja@example.com", password: "Senha-da-caixa-123" });
    expect(a.record).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(a.record.mock.calls)).not.toContain("Senha-da-caixa-123");
    expect(JSON.stringify(a.record.mock.calls)).toContain("tudo certo");
  });

  it("falha: a auditoria diz o passo e o motivo; porta padrão 587", async () => {
    const probe = vi.fn(async (): Promise<MailProbeResult> => ({ ...OK, ok: false, failedStep: "auth", failure: "auth_rejected", passed: ["connect"] }));
    const a = audit();
    const svc = new MailProbeService({ smtpValues: async () => ({ SMTP_HOST: "h", SMTP_USER: "u", SMTP_PASS: "p" }), probe, audit: a });
    await svc.run(project(), "admin");
    expect((probe.mock.calls as unknown as Array<[{ port: number }]>)[0]![0].port).toBe(587);
    expect(JSON.stringify(a.record.mock.calls)).toContain("auth (auth_rejected)");
  });

  it("e-mail desligado ou caixa sem senha: 409 e nada é testado", async () => {
    const probe = vi.fn(async () => OK);
    for (const values of [{}, { SMTP_HOST: "h", SMTP_USER: "u" }, { SMTP_HOST: "h", SMTP_PASS: "p" }] as Array<Record<string, string>>) {
      const svc = new MailProbeService({ smtpValues: async () => values, probe });
      await expect(svc.run(project(), "admin")).rejects.toMatchObject({ statusCode: 409, code: "email_not_enabled" });
    }
    expect(probe).not.toHaveBeenCalled();
  });

  it("um teste por vez por projeto; depois libera, mesmo se o teste lançar", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const probe = vi.fn(async () => {
      await gate;
      return OK;
    });
    const svc = new MailProbeService({ smtpValues: async () => ({ SMTP_HOST: "h", SMTP_USER: "u", SMTP_PASS: "p" }), probe });
    const first = svc.run(project(), "admin");
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    await expect(svc.run(project(), "admin")).rejects.toMatchObject({ statusCode: 409, code: "probe_running" });
    // outro projeto não é bloqueado
    const other = svc.run(project({ id: "p2" }), "admin");
    release();
    await Promise.all([first, other]);
    const failing = new MailProbeService({
      smtpValues: async () => ({ SMTP_HOST: "h", SMTP_USER: "u", SMTP_PASS: "p" }),
      probe: async () => Promise.reject(new Error("quebrou")),
    });
    await expect(failing.run(project(), "admin")).rejects.toThrow("quebrou");
    await expect(failing.run(project(), "admin")).rejects.toThrow("quebrou");
  });

  it("auditoria que falha não derruba o teste", async () => {
    const svc = new MailProbeService({
      smtpValues: async () => ({ SMTP_HOST: "h", SMTP_USER: "u", SMTP_PASS: "p" }),
      probe: async () => OK,
      audit: { record: async () => Promise.reject(new Error("disco cheio")) },
    });
    expect(await svc.run(project(), "admin")).toEqual(OK);
  });
});
