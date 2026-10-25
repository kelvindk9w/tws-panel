/**
 * Página Certificados — falha de emissão/renovação repetida (log do Caddy como
 * fixture) e o alerta do item. Sem Docker: o proxy, o log e a conferência TLS
 * são dublês; o relógio é um número.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";
import type { CertificateStatus } from "@paas/deploy";
import { CertificateService, type CertificateDeps } from "../src/services/certificate-service.js";
import { CertificateFailureStore } from "../src/services/certificate-failure-store.js";
import { ManualCertificateStore } from "../src/services/certificate-store.js";

const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;
const NOW = Date.parse("2027-03-01T12:00:00Z");
const HOST = "loja.exemplo.com.br";

const PROJECT = { id: "p1", name: "Loja", slug: "loja", domain: HOST, aliases: [] } as unknown as Project;

/** Rodada de falha do certmagic (três linhas seguidas) em `atMs`. */
function failRound(host: string, atMs: number, detail = "HTTP 400 urn:ietf:params:acme:error:dns - DNS problem: NXDOMAIN looking up A for " + host): string {
  const ts = (n: number) => (atMs + n * 1000) / 1000;
  return [
    JSON.stringify({ level: "error", ts: ts(0), msg: "challenge failed", identifier: host, problem: { type: "urn:ietf:params:acme:error:dns", detail: "NXDOMAIN" } }),
    JSON.stringify({ level: "error", ts: ts(1), msg: "could not get certificate from issuer", identifier: host, error: detail }),
    JSON.stringify({ level: "error", ts: ts(2), msg: "will retry", error: `[${host}] Obtain: falhou`, attempt: 1, retrying_in: 60 }),
  ].join("\n");
}

/** Três rodadas durante `spanMs`, a última agora. */
function failingLog(host: string, spanMs: number, detail?: string): string {
  return [NOW - spanMs, NOW - spanMs / 2, NOW - 10_000].map((t) => failRound(host, t, detail)).join("\n");
}

let dir = "";
let served: Record<string, CertificateStatus>;
let logs = "";
let deps: { [K in keyof CertificateDeps]-?: ReturnType<typeof vi.fn> };
let service: CertificateService;

const NONE: CertificateStatus = { ok: false, issuer: null, validFrom: null, validTo: null, error: "tlsv1 alert internal error" };
const VALID = (leftMs: number, validityDays = 90): CertificateStatus => ({
  ok: true,
  issuer: "Let's Encrypt",
  validFrom: new Date(NOW + leftMs - validityDays * DAY).toISOString(),
  validTo: new Date(NOW + leftMs).toISOString(),
  error: null,
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-cert-fail-"));
  served = {};
  logs = "";
  deps = {
    listProjects: vi.fn(async () => [PROJECT]),
    panelDomain: vi.fn(() => null),
    panelAliases: vi.fn((): string[] => []),
    mailHosts: vi.fn(async (): Promise<string[]> => []),
    proxyRunning: vi.fn(async () => true),
    servedCertificate: vi.fn(async (host: string) => served[host] ?? NONE),
    caddyLogs: vi.fn(async () => logs),
    refreshProxy: vi.fn(async () => undefined),
    removeManualFiles: vi.fn(async () => undefined),
    syncMailTls: vi.fn(async () => "none"),
    resolve4: vi.fn(async () => ["203.0.113.10"]),
  };
  service = new CertificateService(new ManualCertificateStore(dir), deps as unknown as CertificateDeps, { now: () => NOW, log: () => undefined });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const item = async () => (await service.list()).items.find((i) => i.host === HOST)!;

describe("emissão falhando repetidamente (sem certificado)", () => {
  it("3 rodadas em 2 h: falhou, com a causa traduzida e alerta de atenção", async () => {
    logs = failingLog(HOST, 2 * HOUR);
    const i = await item();
    expect(i.state).toBe("failed");
    expect(i.failure).toMatchObject({ rounds: 3 });
    expect(i.failure!.error!.cause).toBe("dns");
    expect(i.failure!.error!.message).toMatch(/DNS deste nome não aponta/);
    expect(i.alert).toEqual({ level: "warning", reason: "issuance_failing" });
  });

  it("domínio novo com DNS por apontar (menos de 1 h): ainda sem alerta", async () => {
    logs = failingLog(HOST, 30 * 60_000);
    const i = await item();
    expect(i.state).toBe("failed");
    expect(i.failure!.rounds).toBe(3);
    expect(i.alert).toEqual({ level: "none", reason: null });
  });

  it("só 2 rodadas em horas: sem alerta", async () => {
    logs = [NOW - 5 * HOUR, NOW - HOUR].map((t) => failRound(HOST, t)).join("\n");
    expect((await item()).alert.level).toBe("none");
  });

  it("Cloudflare: o DNS nos IPs da Cloudflare troca a causa", async () => {
    deps.resolve4.mockResolvedValue(["104.16.1.1"]);
    logs = failingLog(HOST, 2 * HOUR);
    expect((await item()).failure!.error!.cause).toBe("cloudflare");
  });

  it("limite do Let's Encrypt: a causa é rate_limit (nem a Cloudflare a troca) e traz a data", async () => {
    deps.resolve4.mockResolvedValue(["104.16.1.1"]);
    logs = failingLog(HOST, 2 * HOUR, "HTTP 429 urn:ietf:params:acme:error:rateLimited - too many certificates already issued, retry after 2027-03-02 12:00:00 UTC");
    const i = await item();
    expect(i.failure!.error!.cause).toBe("rate_limit");
    expect(i.failure!.error!.retryAfter).toBe("2027-03-02T12:00:00.000Z");
  });

  it("sucesso no log depois das falhas: sem falha em curso", async () => {
    logs = failingLog(HOST, 2 * HOUR) + "\n" + JSON.stringify({ ts: (NOW - 5000) / 1000, msg: "certificate obtained successfully", identifier: HOST });
    const i = await item();
    expect(i.failure).toBeNull();
    expect(i.alert.level).toBe("none");
  });
});

describe("renovação falhando com certificado ainda válido", () => {
  it("certificado novo (60 dias) e renovação falhando: atenção issuance_failing, estado continua válido", async () => {
    served[HOST] = VALID(60 * DAY);
    logs = failingLog(HOST, 3 * HOUR);
    const i = await item();
    expect(i.state).toBe("valid");
    expect(i.alert).toEqual({ level: "warning", reason: "issuance_failing" });
    expect(i.failure!.rounds).toBe(3);
    expect(i.lastError).toBeNull();
  });

  it("certificado válido e saudável: falha curta no log não alerta", async () => {
    served[HOST] = VALID(60 * DAY);
    logs = failRound(HOST, NOW - 60_000);
    const i = await item();
    expect(i.alert.level).toBe("none");
    expect(i.failure!.rounds).toBe(1);
  });

  it("falha E já na janela de renovação atrasada: o atraso manda (renewal_late)", async () => {
    served[HOST] = VALID(20 * DAY);
    logs = failingLog(HOST, 3 * HOUR);
    expect((await item()).alert).toEqual({ level: "warning", reason: "renewal_late" });
  });

  it("validade de 12 h: o aviso só acende depois do ponto em que o Caddy renova (faltam 4 h), nunca antes", async () => {
    served[HOST] = VALID(5 * HOUR, 0.5);
    expect((await item()).alert).toEqual({ level: "none", reason: null });
    served[HOST] = VALID(3.5 * HOUR, 0.5);
    expect((await item()).alert).toEqual({ level: "none", reason: null });
    served[HOST] = VALID(2.9 * HOUR, 0.5);
    expect((await item()).alert).toEqual({ level: "warning", reason: "renewal_late" });
    served[HOST] = VALID(1 * HOUR, 0.5);
    expect((await item()).alert).toEqual({ level: "critical", reason: "renewal_late" });
  });

  it("validade de 6 dias: renovação atrasada a 1,5 dia; crítico a 12 h", async () => {
    served[HOST] = VALID(1.4 * DAY, 6);
    expect((await item()).alert).toEqual({ level: "warning", reason: "renewal_late" });
    served[HOST] = VALID(11 * HOUR, 6);
    expect((await item()).alert).toEqual({ level: "critical", reason: "renewal_late" });
  });
});

describe("o que não vira falha", () => {
  it("certificado manual ignora o log do Caddy", async () => {
    const store = new ManualCertificateStore(dir);
    vi.spyOn(store, "list").mockResolvedValue([
      { host: HOST, issuer: "CA Exemplo", validFrom: new Date(NOW - 10 * DAY).toISOString(), validTo: new Date(NOW + 300 * DAY).toISOString(), names: [HOST], fingerprint: "ab", installedAt: new Date(NOW).toISOString() },
    ]);
    service = new CertificateService(store, deps as unknown as CertificateDeps, { now: () => NOW, log: () => undefined });
    served[HOST] = VALID(300 * DAY, 310);
    logs = failingLog(HOST, 30 * HOUR);
    const i = await item();
    expect(i.mode).toBe("manual");
    expect(i.failure).toBeNull();
    expect(i.alert.level).toBe("none");
  });

  it("log ilegível: lista normalmente, sem falha, e marca que a falha é desconhecida", async () => {
    deps.caddyLogs.mockRejectedValue(new Error("docker fora"));
    const i = await item();
    expect(i.state).toBe("issuing");
    expect(i.failure).toBeNull();
    expect(i.failureKnown).toBe(false);
  });

  it("log vazio (container recriado): também desconhecido; log com conteúdo é conhecido", async () => {
    logs = "  \n";
    expect((await item()).failureKnown).toBe(false);
    logs = failRound("outro.exemplo.com.br", NOW - 60_000);
    expect((await item()).failureKnown).toBe(true);
  });

  it("nome de outro host no log não contamina este", async () => {
    logs = failingLog("outro.exemplo.com.br", 2 * HOUR);
    const i = await item();
    expect(i.failure).toBeNull();
    expect(i.state).toBe("issuing");
  });
});

describe("início da falha guardado em arquivo (o log do Caddy tem só 24 h)", () => {
  let clock = NOW;
  const build = () =>
    new CertificateService(new ManualCertificateStore(dir), deps as unknown as CertificateDeps, {
      now: () => clock,
      log: () => undefined,
      failureStore: new CertificateFailureStore(dir),
    });
  /** O que `docker logs --since 24h` entrega: rodadas só das últimas 23 h. */
  const log24h = () =>
    [clock - 23 * HOUR, clock - 12 * HOUR, clock - 10_000].map((t) => failRound(HOST, t)).join("\n");

  beforeEach(() => {
    clock = NOW;
    service = build();
  });

  it("falhas por vários dias com log de só 24 h: atenção no primeiro dia e crítico no segundo", async () => {
    logs = log24h();
    const day1 = await item();
    expect(day1.alert).toEqual({ level: "warning", reason: "issuance_failing" });
    clock = NOW + 1 * DAY;
    logs = log24h();
    const day2 = await item();
    expect(day2.failure!.firstAt).toBe(new Date(NOW - 23 * HOUR).toISOString());
    expect(day2.alert).toEqual({ level: "critical", reason: "issuance_failing" });
  });

  it("o início sobrevive ao reinício do painel (outro serviço, mesma pasta)", async () => {
    logs = log24h();
    await item();
    clock = NOW + 3 * DAY;
    service = build();
    logs = log24h();
    expect((await item()).alert).toEqual({ level: "critical", reason: "issuance_failing" });
  });

  it("emissão com sucesso zera: a próxima falha começa do zero", async () => {
    logs = log24h();
    await item();
    clock = NOW + 1 * DAY;
    logs = log24h() + "\n" + JSON.stringify({ ts: (clock - 5000) / 1000, msg: "certificate obtained successfully", identifier: HOST });
    expect((await item()).failure).toBeNull();
    clock = NOW + 2 * DAY;
    logs = log24h();
    const again = await item();
    expect(again.failure!.firstAt).toBe(new Date(clock - 23 * HOUR).toISOString());
    expect(again.alert).toEqual({ level: "warning", reason: "issuance_failing" });
  });

  it("a falha some do log sem nenhum sucesso (log conhecido): uma falha nova NÃO herda o início antigo", async () => {
    logs = log24h();
    await item();
    clock = NOW + 40 * DAY;
    logs = failRound("outro.exemplo.com.br", clock - 1000);
    expect((await item()).failure).toBeNull();
    clock = NOW + 41 * DAY;
    logs = log24h();
    const again = await item();
    expect(again.failure!.firstAt).toBe(new Date(clock - 23 * HOUR).toISOString());
    expect(again.alert).toEqual({ level: "warning", reason: "issuance_failing" });
  });

  it("certificado válido e longe da renovação também zera o início", async () => {
    logs = log24h();
    await item();
    clock = NOW + 1 * DAY;
    served[HOST] = VALID(80 * DAY);
    logs = failRound("outro.exemplo.com.br", clock - 1000);
    expect((await item()).failure).toBeNull();
    served[HOST] = NONE;
    clock = NOW + 2 * DAY;
    logs = log24h();
    expect((await item()).failure!.firstAt).toBe(new Date(clock - 23 * HOUR).toISOString());
  });

  it("log ilegível ou vazio não zera nem mexe no início guardado", async () => {
    logs = log24h();
    await item();
    clock = NOW + 1 * DAY;
    logs = "";
    expect((await item()).failure).toBeNull();
    deps.caddyLogs.mockRejectedValueOnce(new Error("docker fora"));
    expect((await item()).failureKnown).toBe(false);
    logs = log24h();
    expect((await item()).alert).toEqual({ level: "critical", reason: "issuance_failing" });
  });

  it("nome que o painel deixou de servir é esquecido; filtro por nome não esquece ninguém", async () => {
    logs = log24h();
    await item();
    deps.listProjects.mockResolvedValue([{ ...PROJECT, domain: "outro.exemplo.com.br" } as unknown as Project]);
    await service.list({ host: "outro.exemplo.com.br" });
    deps.listProjects.mockResolvedValue([PROJECT]);
    clock = NOW + 1 * DAY;
    logs = log24h();
    expect((await item()).alert.level).toBe("critical");
    deps.listProjects.mockResolvedValue([{ ...PROJECT, domain: "outro.exemplo.com.br" } as unknown as Project]);
    await service.list();
    deps.listProjects.mockResolvedValue([PROJECT]);
    clock = NOW + 2 * DAY;
    logs = log24h();
    expect((await item()).alert).toEqual({ level: "warning", reason: "issuance_failing" });
  });

  it("arquivo do início ilegível ou que não grava: vale o que o log mostra, sem derrubar a página", async () => {
    const logged: string[] = [];
    service = new CertificateService(new ManualCertificateStore(dir), deps as unknown as CertificateDeps, {
      now: () => clock,
      log: (m) => logged.push(m),
      failureStore: {
        record: async () => {
          throw new Error("disco cheio");
        },
        clear: async () => undefined,
        prune: async () => undefined,
      } as unknown as CertificateFailureStore,
    });
    logs = log24h();
    const i = await item();
    expect(i.failure!.firstAt).toBe(new Date(NOW - 23 * HOUR).toISOString());
    expect(logged.join(" ")).toMatch(/disco cheio/);
  });
});
