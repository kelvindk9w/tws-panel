/**
 * Alerta de certificado automático que não renovou (certificate-alerts.ts):
 * o texto (nome, causa traduzida, o que fazer), a histerese, o agrupamento dos
 * avisos de uma rodada e o que NÃO deve virar alerta. AlertsService de verdade
 * em pasta temporária; nenhum Docker.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CertificateAlertAssessment, CertificateItem } from "@paas/core";
import { AlertsService } from "../src/services/alerts-service.js";
import {
  CLEAR_AFTER_CHECKS,
  CertificateAlertWatcher,
  GROUP_LIST_MAX,
  certificateAlertTitles,
  certificateProblem,
  groupNotification,
  singleNotification,
} from "../src/services/certificate-alerts.js";
import { alertNotification } from "../src/services/notification-sources.js";
import type { NotificationEvent } from "../src/services/notification-service.js";

const NOW = Date.parse("2027-03-01T12:00:00Z");
const DAY = 24 * 3600 * 1000;

function item(host: string, alert: CertificateAlertAssessment, extra: Partial<CertificateItem> = {}): CertificateItem {
  return {
    host,
    owner: { kind: "project", projectId: "p1", projectName: "Loja" },
    mode: "automatic",
    coveredBy: null,
    state: "valid",
    issuer: "Let's Encrypt",
    validFrom: new Date(NOW - 70 * DAY).toISOString(),
    validTo: new Date(NOW + 20 * DAY).toISOString(),
    renewsAround: new Date(NOW - 10 * DAY).toISOString(),
    lastError: null,
    manual: null,
    canRetry: false,
    alert,
    failure: null,
    ...extra,
  };
}

const LATE: CertificateAlertAssessment = { level: "warning", reason: "renewal_late" };
const LATE_CRIT: CertificateAlertAssessment = { level: "critical", reason: "renewal_late" };
const FAILING: CertificateAlertAssessment = { level: "warning", reason: "issuance_failing" };
const FAILING_LONG: CertificateAlertAssessment = { level: "critical", reason: "issuance_failing" };
const EXPIRED: CertificateAlertAssessment = { level: "critical", reason: "expired" };
const OK: CertificateAlertAssessment = { level: "none", reason: null };

const DNS_ERROR = {
  cause: "dns" as const,
  message: "O DNS deste nome não aponta para esta VPS. Crie ou corrija o registro A com o IP da VPS e tente de novo depois que propagar.",
  detail: "NXDOMAIN",
  at: null,
  retryAfter: null,
};
const failure = (rounds = 4) => ({
  rounds,
  firstAt: new Date(NOW - 3 * DAY).toISOString(),
  lastAt: new Date(NOW - 60_000).toISOString(),
  error: DNS_ERROR,
});

describe("certificateProblem: texto do alerta", () => {
  it("renovação atrasada (atenção): nome, datas, causa traduzida e o que fazer", () => {
    const p = certificateProblem(item("loja.exemplo.com.br", LATE, { failure: failure() }))!;
    expect(p.title).toBe("Certificado de loja.exemplo.com.br não renovou e vence em breve");
    expect(p.severity).toBe("warning");
    expect(p.detail).toContain("loja.exemplo.com.br");
    expect(p.detail).toContain(new Date(NOW + 20 * DAY).toLocaleDateString("pt-BR", { timeZone: "UTC" }));
    expect(p.detail).toContain("O DNS deste nome não aponta para esta VPS");
  });

  it("renovação atrasada crítica: título 'prestes a vencer' e gravidade crítica", () => {
    const p = certificateProblem(item("loja.exemplo.com.br", LATE_CRIT))!;
    expect(p.title).toBe("Certificado de loja.exemplo.com.br está prestes a vencer");
    expect(p.severity).toBe("critical");
    expect(p.short).toBe("prestes a vencer");
  });

  it("sem causa conhecida usa o roteiro genérico (portas 80 e 443, DNS, Tentar emitir agora)", () => {
    const p = certificateProblem(item("loja.exemplo.com.br", LATE))!;
    expect(p.detail).toMatch(/portas 80 e 443/);
    expect(p.detail).toMatch(/Tentar emitir agora/);
  });

  it("a causa também vem do último erro quando não há resumo de falha", () => {
    const p = certificateProblem(item("loja.exemplo.com.br", LATE, { lastError: { ...DNS_ERROR, message: "Causa do lastError." } }))!;
    expect(p.detail).toContain("Causa do lastError.");
  });

  it("vencido: crítico, com a data quando conhecida", () => {
    const p = certificateProblem(item("loja.exemplo.com.br", EXPIRED))!;
    expect(p).toMatchObject({ title: "Certificado de loja.exemplo.com.br venceu", severity: "critical", short: "venceu" });
    expect(p.detail).toMatch(/venceu em \d{2}\/\d{2}\/\d{4}/);
    const semData = certificateProblem(item("loja.exemplo.com.br", EXPIRED, { validTo: null }))!;
    expect(semData.detail).not.toMatch(/venceu em/);
  });

  it("emissão falhando sem certificado: quantas vezes, desde quando e a causa", () => {
    const p = certificateProblem(item("novo.exemplo.com.br", FAILING, { validTo: null, validFrom: null, renewsAround: null, state: "failed", failure: failure(7) }))!;
    expect(p.title).toBe("Certificado de novo.exemplo.com.br: emissão falhando repetidamente");
    expect(p.severity).toBe("warning");
    expect(p.detail).toContain("emitir o certificado de novo.exemplo.com.br");
    expect(p.detail).toContain("7 vezes");
    expect(p.detail).toContain("O DNS deste nome");
  });

  it("emissão falhando com certificado ainda válido: é a renovação, e diz até quando vale", () => {
    const p = certificateProblem(item("loja.exemplo.com.br", FAILING, { failure: failure() }))!;
    expect(p.detail).toContain("renovar o certificado de loja.exemplo.com.br (o atual vence em");
  });

  it("sem certificado há mais de 24 h: crítico, título próprio", () => {
    const p = certificateProblem(item("novo.exemplo.com.br", FAILING_LONG, { validTo: null, failure: failure() }))!;
    expect(p).toMatchObject({ title: "Certificado de novo.exemplo.com.br segue sem emissão há mais de 24 horas", severity: "critical" });
  });

  it("falha sem resumo: texto não quebra", () => {
    const p = certificateProblem(item("x.exemplo.com.br", FAILING, { failure: null, validTo: null }))!;
    expect(p.detail).toContain("várias vezes");
    expect(p.detail).toContain("data desconhecida");
  });

  it("sem alerta, manual ou motivo desconhecido: nada", () => {
    expect(certificateProblem(item("a.exemplo.com.br", OK))).toBeNull();
    expect(certificateProblem(item("a.exemplo.com.br", EXPIRED, { mode: "manual" }))).toBeNull();
    expect(certificateProblem(item("a.exemplo.com.br", { level: "warning", reason: "expiring" }))).toBeNull();
    expect(certificateProblem(item("a.exemplo.com.br", { level: "warning", reason: null }))).toBeNull();
  });

  it("os títulos de um nome são todos distintos", () => {
    expect(new Set(certificateAlertTitles("a.exemplo.com.br")).size).toBe(5);
  });

  it("nunca põe IP no texto", () => {
    const p = certificateProblem(item("loja.exemplo.com.br", LATE, { failure: failure() }))!;
    expect(p.detail).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
  });
});

describe("avisos fora do painel", () => {
  const p = (host: string, severity: "warning" | "critical" = "warning") => ({
    host,
    title: `Certificado de ${host} não renovou e vence em breve`,
    severity,
    short: "não renovou",
    detail: `Detalhe de ${host}.`,
  });

  it("um nome: título, gravidade e o texto completo; mesma chave do alerta (agrupa com ele)", () => {
    const e = singleNotification(p("a.exemplo.com.br", "critical"));
    expect(e).toMatchObject({ kind: "certificate", path: "/certificates", title: "Certificado de a.exemplo.com.br não renovou e vence em breve" });
    expect(e.body).toEqual(["Gravidade: crítico.", "Detalhe de a.exemplo.com.br."]);
    expect(e.key).toBe("alert:certificate:Certificado de a.exemplo.com.br não renovou e vence em breve");
    // a notificação do alerta criado por outro caminho tem a mesma chave
    expect(alertNotification({ id: "x", severity: "warning", source: "certificate", title: e.title, detail: "d", status: "open", createdAt: "", acknowledgedAt: null, resolvedAt: null }).key).toBe(e.key);
  });

  it("vários: uma linha por nome, no máximo GROUP_LIST_MAX, com 'e mais N'; a pior gravidade", () => {
    const many = Array.from({ length: GROUP_LIST_MAX + 3 }, (_, i) => p(`h${i}.exemplo.com.br`, i === 2 ? "critical" : "warning"));
    const e = groupNotification(many);
    expect(e.title).toBe(`${many.length} certificados com problema`);
    expect(e.body![0]).toBe("Gravidade: crítico.");
    expect(e.body!.filter((l) => l.startsWith("h"))).toHaveLength(GROUP_LIST_MAX);
    expect(e.body).toContain("e mais 3");
    expect(e.key).toBe("cert-alerts-group");
    const two = groupNotification([p("a.exemplo.com.br"), p("b.exemplo.com.br")]);
    expect(two.body![0]).toBe("Gravidade: atenção.");
    expect(two.body!.some((l) => l.startsWith("e mais"))).toBe(false);
    expect(two.body).toContain("a.exemplo.com.br: não renovou");
  });
});

describe("CertificateAlertWatcher", () => {
  let dir: string;
  let alerts: AlertsService;
  let items: CertificateItem[];
  let events: NotificationEvent[];
  let logs: string[];
  let watcher: CertificateAlertWatcher;
  const build = () =>
    new CertificateAlertWatcher({
      items: async () => items,
      alerts,
      notify: async (e) => void events.push(e),
      log: (m) => logs.push(m),
    });
  const certAlerts = async () => (await alerts.list()).alerts.filter((a) => a.source === "certificate");

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "paas-cert-watch-"));
    alerts = new AlertsService(dir);
    items = [];
    events = [];
    logs = [];
    watcher = build();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("problema novo: um alerta no painel e UM aviso fora, com nome e causa", async () => {
    items = [item("loja.exemplo.com.br", LATE, { failure: failure() })];
    await watcher.check();
    const list = await certAlerts();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ severity: "warning", status: "open", title: "Certificado de loja.exemplo.com.br não renovou e vence em breve" });
    expect(events).toHaveLength(1);
    expect(events[0]!.title).toContain("loja.exemplo.com.br");
    expect(events[0]!.body!.join(" ")).toContain("O DNS deste nome");
  });

  it("o alerta é silencioso para o gancho padrão (o aviso agrupado é do vigia): sem aviso duplicado", async () => {
    const heard: string[] = [];
    alerts.onCreated((a) => void heard.push(a.title));
    items = [item("loja.exemplo.com.br", LATE)];
    await watcher.check();
    expect(heard).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it("saudável: nada é criado nem avisado", async () => {
    items = [item("loja.exemplo.com.br", OK), item("outro.exemplo.com.br", OK)];
    await watcher.check();
    expect(await certAlerts()).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("conferências seguintes com o mesmo problema: nem alerta repetido nem aviso repetido", async () => {
    items = [item("loja.exemplo.com.br", LATE)];
    await watcher.check();
    await watcher.check();
    await watcher.check();
    expect(await certAlerts()).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it("detalhe que mudou atualiza o alerta aberto sem novo aviso", async () => {
    items = [item("loja.exemplo.com.br", FAILING, { failure: failure(4) })];
    await watcher.check();
    items = [item("loja.exemplo.com.br", FAILING, { failure: failure(9) })];
    await watcher.check();
    const list = await certAlerts();
    expect(list).toHaveLength(1);
    expect(list[0]!.detail).toContain("9 vezes");
    expect(events).toHaveLength(1);
  });

  it("alerta que a pessoa reconheceu não volta enquanto o problema durar (nem muda)", async () => {
    items = [item("loja.exemplo.com.br", FAILING, { failure: failure(4) })];
    await watcher.check();
    const [a] = await certAlerts();
    await alerts.setStatus(a!.id, "acknowledged");
    items = [item("loja.exemplo.com.br", FAILING, { failure: failure(9) })];
    await watcher.check();
    await watcher.check();
    const list = await certAlerts();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "acknowledged" });
    expect(list[0]!.detail).toContain("4 vezes");
    expect(events).toHaveLength(1);
  });

  it("piora de faixa: novo alerta (e novo aviso) e o anterior é resolvido", async () => {
    items = [item("loja.exemplo.com.br", LATE)];
    await watcher.check();
    items = [item("loja.exemplo.com.br", LATE_CRIT)];
    await watcher.check();
    const list = await certAlerts();
    expect(list.filter((a) => a.status === "open").map((a) => a.title)).toEqual(["Certificado de loja.exemplo.com.br está prestes a vencer"]);
    expect(list.filter((a) => a.status === "resolved").map((a) => a.title)).toEqual(["Certificado de loja.exemplo.com.br não renovou e vence em breve"]);
    expect(events).toHaveLength(2);
    expect(events[1]!.body![0]).toBe("Gravidade: crítico.");
  });

  it("histerese: só resolve depois de CLEAR_AFTER_CHECKS conferências seguidas sem problema", async () => {
    expect(CLEAR_AFTER_CHECKS).toBe(2);
    items = [item("loja.exemplo.com.br", LATE)];
    await watcher.check();
    items = [item("loja.exemplo.com.br", OK)];
    await watcher.check();
    expect((await certAlerts())[0]!.status).toBe("open");
    await watcher.check();
    const [a] = await certAlerts();
    expect(a).toMatchObject({ status: "resolved" });
    expect(a!.resolvedAt).not.toBeNull();
    // depois de resolvido, mais conferências limpas não mexem em nada
    await watcher.check();
    expect(await certAlerts()).toHaveLength(1);
  });

  it("o problema que volta no meio da recuperação zera a contagem (não pisca)", async () => {
    items = [item("loja.exemplo.com.br", LATE)];
    await watcher.check();
    items = [item("loja.exemplo.com.br", OK)];
    await watcher.check();
    items = [item("loja.exemplo.com.br", LATE)];
    await watcher.check();
    items = [item("loja.exemplo.com.br", OK)];
    await watcher.check();
    const list = await certAlerts();
    expect(list).toHaveLength(1);
    expect(list[0]!.status).toBe("open");
    expect(events).toHaveLength(1);
  });

  it("depois de resolvido, se o problema volta, alerta e aviso novos", async () => {
    items = [item("loja.exemplo.com.br", LATE)];
    await watcher.check();
    items = [item("loja.exemplo.com.br", OK)];
    await watcher.check();
    await watcher.check();
    items = [item("loja.exemplo.com.br", LATE)];
    await watcher.check();
    expect((await certAlerts()).filter((a) => a.status === "open")).toHaveLength(1);
    expect(events).toHaveLength(2);
  });

  it("reinício do painel com alerta vivo: não recria nem avisa de novo, e ainda resolve quando passa", async () => {
    items = [item("loja.exemplo.com.br", LATE)];
    await watcher.check();
    watcher = build();
    await watcher.check();
    expect(await certAlerts()).toHaveLength(1);
    expect(events).toHaveLength(1);
    items = [item("loja.exemplo.com.br", OK)];
    await watcher.check();
    await watcher.check();
    expect((await certAlerts())[0]!.status).toBe("resolved");
  });

  it("nome que sumiu da lista (projeto apagado) também é resolvido, com a mesma histerese", async () => {
    items = [item("loja.exemplo.com.br", LATE)];
    await watcher.check();
    items = [];
    await watcher.check();
    expect((await certAlerts())[0]!.status).toBe("open");
    await watcher.check();
    expect((await certAlerts())[0]!.status).toBe("resolved");
  });

  it("agrupamento: vários nomes na mesma rodada viram UM aviso e cada nome tem o seu alerta", async () => {
    items = ["a", "b", "c"].map((n) => item(`${n}.exemplo.com.br`, LATE));
    await watcher.check();
    expect(await certAlerts()).toHaveLength(3);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ key: "cert-alerts-group", title: "3 certificados com problema" });
    // quem aparece depois, sozinho, avisa sozinho
    items.push(item("d.exemplo.com.br", EXPIRED));
    await watcher.check();
    expect(events).toHaveLength(2);
    expect(events[1]!.title).toBe("Certificado de d.exemplo.com.br venceu");
  });

  it("dois nomes já bastam para agrupar; um só não agrupa", async () => {
    items = [item("a.exemplo.com.br", LATE), item("b.exemplo.com.br", LATE)];
    await watcher.check();
    expect(events.map((e) => e.key)).toEqual(["cert-alerts-group"]);
  });

  it("certificado manual e nomes cobertos por manual ficam com os alertas do CertificateService", async () => {
    items = [item("m.exemplo.com.br", EXPIRED, { mode: "manual" }), item("c.exemplo.com.br", LATE_CRIT, { mode: "manual", coveredBy: "m.exemplo.com.br" })];
    await watcher.check();
    expect(await certAlerts()).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("aceita nomes que não são de projeto nenhum nem do Caddyfile (emissão sob demanda)", async () => {
    items = [item("cliente.imobiliaria.exemplo.com.br", FAILING, { owner: { kind: "mail", projectId: null, projectName: null }, validTo: null, failure: failure() })];
    await watcher.check();
    expect((await certAlerts())[0]!.title).toContain("cliente.imobiliaria.exemplo.com.br");
  });

  it("lista indisponível: registra no log e não lança nem apaga nada", async () => {
    items = [item("loja.exemplo.com.br", LATE)];
    await watcher.check();
    const broken = new CertificateAlertWatcher({
      items: async () => {
        throw new Error("proxy fora");
      },
      alerts,
      notify: async (e) => void events.push(e),
      log: (m) => logs.push(m),
    });
    await expect(broken.check()).resolves.toBeUndefined();
    expect(logs.join(" ")).toContain("proxy fora");
    expect((await certAlerts())[0]!.status).toBe("open");
  });

  it("lista que lança algo que não é Error também é registrada", async () => {
    const broken = new CertificateAlertWatcher({
      items: async () => {
        throw "texto solto";
      },
      alerts,
      notify: vi.fn(),
      log: (m) => logs.push(m),
    });
    await broken.check();
    expect(logs.join(" ")).toContain("texto solto");
  });

  it("falha ao gravar o alerta: registra, não lança e não avisa o que não gravou", async () => {
    const failing = new CertificateAlertWatcher({
      items: async () => [item("loja.exemplo.com.br", LATE)],
      alerts: {
        create: async () => {
          throw new Error("disco cheio");
        },
        findActive: async () => null,
        resolveActive: async () => 0,
      },
      notify: async (e) => void events.push(e),
      log: (m) => logs.push(m),
    });
    await expect(failing.check()).resolves.toBeUndefined();
    expect(logs.join(" ")).toContain("disco cheio");
    expect(events).toHaveLength(0);
  });

  it("falha ao enviar o aviso: registra e o alerta continua gravado", async () => {
    const w = new CertificateAlertWatcher({
      items: async () => [item("loja.exemplo.com.br", LATE)],
      alerts,
      notify: async () => {
        throw new Error("telegram fora");
      },
      log: (m) => logs.push(m),
    });
    await w.check();
    expect(logs.join(" ")).toContain("telegram fora");
    expect(await certAlerts()).toHaveLength(1);
  });

  it("sem log informado, falhas passam em silêncio (não lança)", async () => {
    const w = new CertificateAlertWatcher({
      items: async () => {
        throw new Error("x");
      },
      alerts,
      notify: vi.fn(),
    });
    await expect(w.check()).resolves.toBeUndefined();
  });

  it("falha ao enviar o aviso (valor que não é Error) também é registrada", async () => {
    const w = new CertificateAlertWatcher({
      items: async () => [item("loja.exemplo.com.br", LATE)],
      alerts,
      notify: async () => {
        throw "sem canal";
      },
      log: (m) => logs.push(m),
    });
    await w.check();
    expect(logs.join(" ")).toContain("sem canal");
  });

  it("falha ao gravar com valor que não é Error também é registrada", async () => {
    const w = new CertificateAlertWatcher({
      items: async () => [item("loja.exemplo.com.br", LATE)],
      alerts: {
        create: async () => {
          throw "disco";
        },
        findActive: async () => null,
        resolveActive: async () => 0,
      },
      notify: vi.fn(),
      log: (m) => logs.push(m),
    });
    await w.check();
    expect(logs.join(" ")).toContain("disco");
  });
});
