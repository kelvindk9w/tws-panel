/**
 * Página Certificados — serviço.
 *
 * Pedido do dono do produto (01/10/2026): validando na VPS, viu o card do
 * e-mail "pendente" por um tempo sem ter onde ver o estado de todos os
 * certificados nem um botão para agir. Aqui:
 *  - lista única (painel, domínios dos projetos, mail.<domínio>) com estado
 *    conferido no certificado SERVIDO e, sem certificado, o último erro do
 *    log do Caddy traduzido;
 *  - "Tentar emitir agora" (reload forçado), com limite de 1 por minuto por
 *    nome e recusa quando o certificado já é válido;
 *  - certificado manual: validação com motivo, arquivos 0600 em pasta 0700,
 *    chave nunca na resposta/auditoria, alerta a 30 e a 7 dias do fim.
 *
 * Sem Docker: as dependências (proxy, log, conferência TLS) são dublês.
 * Certificados gerados com o openssl na hora.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";
import type { CertificateStatus } from "@paas/deploy";
import { AlertsService } from "../src/services/alerts-service.js";
import { AuditService } from "../src/services/audit-service.js";
import { CertificateService, type CertificateDeps } from "../src/services/certificate-service.js";
import { ManualCertificateStore } from "../src/services/certificate-store.js";

const DAY = 24 * 3600 * 1000;
let pemDir = "";
const pem: Record<string, { cert: string; key: string }> = {};

function issue(name: string, san: string, days: number): void {
  const key = path.join(pemDir, `${name}.chave`);
  const cert = path.join(pemDir, `${name}.crt`);
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
      "-keyout", key, "-out", cert, "-days", String(days),
      "-subj", "/O=Empresa Exemplo CA/CN=teste", "-addext", `subjectAltName=${san}`,
    ],
    { stdio: "ignore" },
  );
  pem[name] = { cert: readFileSync(cert, "utf8"), key: readFileSync(key, "utf8") };
}

beforeAll(() => {
  pemDir = mkdtempSync(path.join(tmpdir(), "paas-cert-svc-pem-"));
  issue("loja", "DNS:loja.exemplo.com.br", 365);
  issue("curinga", "DNS:*.exemplo.com.br", 365);
  issue("mail", "DNS:mail.exemplo.com.br", 365);
  issue("curto", "DNS:loja.exemplo.com.br", 20);
  issue("outro", "DNS:outro.exemplo.net", 365);
});
afterAll(() => rmSync(pemDir, { recursive: true, force: true }));

const PROJECT = {
  id: "p1",
  name: "Loja",
  slug: "loja",
  domain: "loja.exemplo.com.br",
  aliases: ["www.exemplo.com.br", "loja.localhost"],
} as unknown as Project;

const VALID = (validTo: string, issuer = "Let's Encrypt"): CertificateStatus => ({ ok: true, issuer, validTo, error: null });
const NONE: CertificateStatus = { ok: false, issuer: null, validTo: null, error: "tlsv1 alert internal error" };

let dir = "";
let now = Math.floor(Date.now() / 1000) * 1000 + 5_000; // um pouco à frente: o openssl emite com início "agora"
let served: Record<string, CertificateStatus>;
let logs = "";
let deps: { [K in keyof CertificateDeps]-?: ReturnType<typeof vi.fn> };
let audit: AuditService;
let alerts: AlertsService;
let store: ManualCertificateStore;
let service: CertificateService;

function build(): CertificateService {
  return new CertificateService(store, deps as unknown as CertificateDeps, { audit, alerts, now: () => now });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-cert-svc-"));
  now = Math.floor(Date.now() / 1000) * 1000 + 5_000; // um pouco à frente: o openssl emite com início "agora"
  served = {};
  logs = "";
  deps = {
    listProjects: vi.fn(async () => [PROJECT]),
    panelDomain: vi.fn(() => "painel.exemplo.com.br"),
    panelAliases: vi.fn((): string[] => []),
    mailHosts: vi.fn(async () => ["mail.exemplo.com.br"]),
    proxyRunning: vi.fn(async () => true),
    servedCertificate: vi.fn(async (host: string) => served[host] ?? NONE),
    caddyLogs: vi.fn(async () => logs),
    refreshProxy: vi.fn(async () => undefined),
    removeManualFiles: vi.fn(async () => undefined),
    syncMailTls: vi.fn(async () => "none"),
    resolve4: vi.fn(async () => ["203.0.113.10"]),
  };
  audit = new AuditService(dir);
  alerts = new AlertsService(dir);
  store = new ManualCertificateStore(dir);
  service = build();
});

afterEach(async () => {
  await audit.flush();
  await rm(dir, { recursive: true, force: true });
});

describe("lista", () => {
  it("todos os nomes com dono: painel, domínios do projeto (sem .localhost) e e-mail", async () => {
    const r = await service.list();
    expect(r.items.map((i) => [i.host, i.owner.kind, i.owner.projectName])).toEqual([
      ["painel.exemplo.com.br", "panel", null],
      ["loja.exemplo.com.br", "project", "Loja"],
      ["www.exemplo.com.br", "project", "Loja"],
      ["mail.exemplo.com.br", "mail", null],
    ]);
  });

  it("domínio do painel com o acesso pelo IP ainda ativo: os dois endereços do painel aparecem", async () => {
    deps.panelAliases.mockReturnValue(["203-0-113-10.sslip.io"]);
    const r = await service.list({ kind: "panel" });
    expect(r.items.map((i) => i.host)).toEqual(["painel.exemplo.com.br", "203-0-113-10.sslip.io"]);
  });

  it("nome repetido aparece uma vez só (o primeiro dono vence)", async () => {
    deps.mailHosts.mockResolvedValue(["loja.exemplo.com.br", "mail.exemplo.com.br"]);
    const r = await service.list();
    expect(r.items.filter((i) => i.host === "loja.exemplo.com.br")).toHaveLength(1);
  });

  it("válido no automático: emissor, validade e 'renova por volta de' = validade − 30 dias", async () => {
    const validTo = new Date(now + 90 * DAY).toISOString();
    served["loja.exemplo.com.br"] = VALID(validTo);
    const item = (await service.list()).items.find((i) => i.host === "loja.exemplo.com.br")!;
    expect(item).toMatchObject({
      mode: "automatic",
      state: "valid",
      issuer: "Let's Encrypt",
      validTo,
      renewsAround: new Date(now + 60 * DAY).toISOString(),
      canRetry: false,
      lastError: null,
    });
  });

  it("automático a menos de 20 dias do fim (não renovou): vence em breve", async () => {
    served["loja.exemplo.com.br"] = VALID(new Date(now + 10 * DAY).toISOString());
    expect((await service.list()).items.find((i) => i.host === "loja.exemplo.com.br")!.state).toBe("expiring");
  });

  it("sem certificado e sem erro no log: emitindo", async () => {
    logs = '{"level":"info","logger":"http.acme_client","msg":"trying to solve challenge","identifier":"mail.exemplo.com.br","challenge_type":"tls-alpn-01"}';
    const item = (await service.list()).items.find((i) => i.host === "mail.exemplo.com.br")!;
    expect(item.state).toBe("issuing");
    expect(item.canRetry).toBe(true);
  });

  it("sem certificado e com erro no log: falhou, com causa em linguagem simples", async () => {
    logs = JSON.stringify({
      level: "error",
      ts: now / 1000 - 60,
      logger: "tls.obtain",
      msg: "could not get certificate from issuer",
      identifier: "www.exemplo.com.br",
      error: "HTTP 400 urn:ietf:params:acme:error:dns - DNS problem: NXDOMAIN looking up A for www.exemplo.com.br",
    });
    deps.resolve4.mockResolvedValue([]);
    const item = (await service.list()).items.find((i) => i.host === "www.exemplo.com.br")!;
    expect(item.state).toBe("failed");
    expect(item.lastError?.cause).toBe("dns");
    expect(item.lastError?.at).toBe(new Date(now - 60_000).toISOString());
    expect(item.canRetry).toBe(true);
  });

  it("DNS do nome nos IPs da Cloudflare: a causa vira 'nuvem laranja'", async () => {
    logs = JSON.stringify({
      level: "error",
      logger: "tls.obtain",
      msg: "could not get certificate from issuer",
      identifier: "www.exemplo.com.br",
      error: "HTTP 403 urn:ietf:params:acme:error:unauthorized - Invalid response from http://www.exemplo.com.br/x: 404",
    });
    deps.resolve4.mockResolvedValue(["104.16.1.1"]);
    const item = (await service.list()).items.find((i) => i.host === "www.exemplo.com.br")!;
    expect(item.lastError?.cause).toBe("cloudflare");
  });

  it("certificado servido vencido: vencido", async () => {
    served["loja.exemplo.com.br"] = { ok: false, issuer: null, validTo: null, error: "certificate has expired" };
    expect((await service.list()).items.find((i) => i.host === "loja.exemplo.com.br")!.state).toBe("expired");
  });

  it("proxy fora do ar: estado desconhecido, sem conferir TLS", async () => {
    deps.proxyRunning.mockResolvedValue(false);
    const r = await service.list();
    expect(r.proxyRunning).toBe(false);
    expect(r.items.every((i) => i.state === "unknown")).toBe(true);
    expect(deps.servedCertificate).not.toHaveBeenCalled();
  });

  it("filtros: só e-mail / só um projeto / só um nome", async () => {
    expect((await service.list({ kind: "mail" })).items.map((i) => i.host)).toEqual(["mail.exemplo.com.br"]);
    expect((await service.list({ projectId: "p1" })).items.map((i) => i.host)).toEqual(["loja.exemplo.com.br", "www.exemplo.com.br"]);
    expect((await service.list({ host: "www.exemplo.com.br" })).items.map((i) => i.host)).toEqual(["www.exemplo.com.br"]);
  });

  it("mail.<domínio> válido: instala no servidor de e-mail na hora (syncTls)", async () => {
    served["mail.exemplo.com.br"] = VALID(new Date(now + 90 * DAY).toISOString());
    await service.list({ kind: "mail" });
    await vi.waitFor(() => expect(deps.syncMailTls).toHaveBeenCalled());
  });
});

describe("Tentar emitir agora", () => {
  it("recarrega o proxy com força, registra na auditoria e a lista passa a 'emitindo'", async () => {
    logs = JSON.stringify({
      level: "error",
      ts: now / 1000 - 600,
      logger: "tls.obtain",
      msg: "could not get certificate from issuer",
      identifier: "mail.exemplo.com.br",
      error: "Timeout during connect (likely firewall problem)",
    });
    const r = await service.retry("mail.exemplo.com.br");
    expect(r.host).toBe("mail.exemplo.com.br");
    expect(deps.refreshProxy).toHaveBeenCalledWith({ force: true });
    const item = (await service.list({ host: "mail.exemplo.com.br" })).items[0]!;
    expect(item.state).toBe("issuing");
    await audit.flush();
    const entries = (await audit.list()).entries;
    expect(entries[0]).toMatchObject({ action: "certificate.retry", target: "mail.exemplo.com.br" });
  });

  it("limite: 1 a cada 60 s por nome (429 com o tempo restante)", async () => {
    await service.retry("mail.exemplo.com.br");
    now += 30_000;
    await expect(service.retry("mail.exemplo.com.br")).rejects.toMatchObject({ statusCode: 429, code: "retry_too_soon" });
    // outro nome não espera
    await expect(service.retry("www.exemplo.com.br")).resolves.toBeDefined();
    now += 31_000;
    await expect(service.retry("mail.exemplo.com.br")).resolves.toBeDefined();
  });

  it("certificado já válido: recusa e explica que não precisa (o Let's Encrypt limita repetições)", async () => {
    served["loja.exemplo.com.br"] = VALID(new Date(now + 90 * DAY).toISOString());
    await expect(service.retry("loja.exemplo.com.br")).rejects.toMatchObject({ statusCode: 409, code: "already_valid" });
    expect(deps.refreshProxy).not.toHaveBeenCalled();
  });

  it("limite do Let's Encrypt ainda valendo: recusa com a data", async () => {
    logs = JSON.stringify({
      level: "error",
      logger: "tls.obtain",
      msg: "could not get certificate from issuer",
      identifier: "www.exemplo.com.br",
      error: `HTTP 429 urn:ietf:params:acme:error:rateLimited - too many certificates (5) already issued, retry after ${new Date(now + 2 * DAY).toISOString().slice(0, 19).replace("T", " ")} UTC`,
    });
    await expect(service.retry("www.exemplo.com.br")).rejects.toMatchObject({ statusCode: 409, code: "issuer_rate_limited" });
  });

  it("nome que o painel não serve: 404", async () => {
    await expect(service.retry("nada.exemplo.com.br")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("nome no modo manual: não há o que emitir", async () => {
    await service.installManual("loja.exemplo.com.br", pem.loja!.cert, pem.loja!.key);
    await expect(service.retry("loja.exemplo.com.br")).rejects.toMatchObject({ statusCode: 409, code: "manual_mode" });
  });

  // Pedido da verificação de DNS do e-mail (02/10/2026): o registro A de
  // mail.<domínio> ficou certo depois do cadastro; o painel pede a emissão
  // sozinho, sem prender a resposta enquanto o Caddy recarrega.
  it("em segundo plano: responde sem esperar o recarregamento do proxy, com as mesmas regras", async () => {
    let finish: () => void = () => {};
    deps.refreshProxy.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    const r = await service.retry("mail.exemplo.com.br", { background: true });
    expect(r.host).toBe("mail.exemplo.com.br");
    expect(deps.refreshProxy).toHaveBeenCalledWith({ force: true });
    finish();
    // o limite de 1 por minuto vale igual
    await expect(service.retry("mail.exemplo.com.br", { background: true })).rejects.toMatchObject({ code: "retry_too_soon" });
  });

  it("em segundo plano: falha ao recarregar o proxy vai para o log, sem derrubar quem pediu", async () => {
    const log = vi.fn();
    service = new CertificateService(store, deps as unknown as CertificateDeps, { audit, alerts, now: () => now, log });
    deps.refreshProxy.mockRejectedValue(new Error("docker fora do ar"));
    await expect(service.retry("mail.exemplo.com.br", { background: true })).resolves.toMatchObject({ host: "mail.exemplo.com.br" });
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining("docker fora do ar")));
  });

  it("em segundo plano: erro que não é Error também vai para o log", async () => {
    const log = vi.fn();
    service = new CertificateService(store, deps as unknown as CertificateDeps, { audit, alerts, now: () => now, log });
    deps.refreshProxy.mockRejectedValue("sem resposta");
    await service.retry("mail.exemplo.com.br", { background: true });
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining("sem resposta")));
  });
});

describe("certificado manual", () => {
  it("instala: arquivos 0600 em pasta 0700, recarrega o proxy, item no modo manual SEM a chave", async () => {
    const item = await service.installManual("loja.exemplo.com.br", pem.loja!.cert, pem.loja!.key);
    expect(item.mode).toBe("manual");
    expect(item.manual).toMatchObject({ issuer: "Empresa Exemplo CA", names: ["loja.exemplo.com.br"] });
    expect(JSON.stringify(item)).not.toContain("PRIVATE KEY");
    expect(deps.refreshProxy).toHaveBeenCalledWith({ force: false });

    const certDir = path.join(dir, "certificates");
    expect(statSync(certDir).mode & 0o777).toBe(0o700);
    for (const f of await readdir(certDir)) expect(statSync(path.join(certDir, f)).mode & 0o777).toBe(0o600);
    const pairs = await store.pairs();
    expect(pairs).toEqual([{ host: "loja.exemplo.com.br", cert: pem.loja!.cert, key: pem.loja!.key }]);
  });

  it("auditoria só com nome, emissor e validade — nunca a chave", async () => {
    await service.installManual("loja.exemplo.com.br", pem.loja!.cert, pem.loja!.key);
    await audit.flush();
    const raw = await readFile(path.join(dir, "audit.json"), "utf8");
    expect(raw).toContain("certificate.manual_install");
    expect(raw).toContain("Empresa Exemplo CA");
    expect(raw).not.toContain("PRIVATE KEY");
    expect(raw).not.toContain("BEGIN CERTIFICATE");
  });

  it("par inválido: 400 com o motivo; nada é gravado nem recarregado", async () => {
    await expect(service.installManual("loja.exemplo.com.br", pem.outro!.cert, pem.outro!.key)).rejects.toMatchObject({
      statusCode: 400,
      code: "wrong_name",
    });
    await expect(service.installManual("loja.exemplo.com.br", pem.loja!.cert, pem.outro!.key)).rejects.toMatchObject({
      statusCode: 400,
      code: "key_mismatch",
    });
    expect(deps.refreshProxy).not.toHaveBeenCalled();
    expect(await store.pairs()).toEqual([]);
  });

  it("wildcard: aceito; outros nomes que ele cobre aparecem como manual 'coberto por'", async () => {
    await service.installManual("loja.exemplo.com.br", pem.curinga!.cert, pem.curinga!.key);
    const items = (await service.list()).items;
    expect(items.find((i) => i.host === "www.exemplo.com.br")).toMatchObject({ mode: "manual", coveredBy: "loja.exemplo.com.br", canRetry: false });
    expect(items.find((i) => i.host === "loja.exemplo.com.br")).toMatchObject({ mode: "manual", coveredBy: null });
  });

  it("manual não renova: 'vence em breve' a 30 dias do fim, sem data de renovação", async () => {
    await service.installManual("loja.exemplo.com.br", pem.curto!.cert, pem.curto!.key);
    served["loja.exemplo.com.br"] = VALID(new Date(now + 19 * DAY).toISOString(), "Empresa Exemplo CA");
    const item = (await service.list()).items.find((i) => i.host === "loja.exemplo.com.br")!;
    expect(item).toMatchObject({ mode: "manual", state: "expiring", renewsAround: null });
  });

  it("mail.<domínio> manual: instala também no servidor de e-mail", async () => {
    await service.installManual("mail.exemplo.com.br", pem.mail!.cert, pem.mail!.key);
    expect(deps.syncMailTls).toHaveBeenCalled();
    expect((await store.forHost("mail.exemplo.com.br"))?.fingerprint).toBeDefined();
  });

  it("forHost: wildcard que cobre o nome também vale para o e-mail", async () => {
    await service.installManual("loja.exemplo.com.br", pem.curinga!.cert, pem.curinga!.key);
    expect((await store.forHost("mail.exemplo.com.br"))?.host).toBe("mail.exemplo.com.br");
    expect(await store.forHost("mail.outro.com.br")).toBeNull();
  });

  it("voltar para automático: apaga o par, recarrega, apaga do container, audita", async () => {
    await service.installManual("loja.exemplo.com.br", pem.loja!.cert, pem.loja!.key);
    deps.refreshProxy.mockClear();
    const item = await service.removeManual("loja.exemplo.com.br");
    expect(item.mode).toBe("automatic");
    expect(await store.pairs()).toEqual([]);
    expect(deps.refreshProxy).toHaveBeenCalledWith({ force: false });
    expect(deps.removeManualFiles).toHaveBeenCalledWith("loja.exemplo.com.br");
    await audit.flush();
    expect((await audit.list()).entries[0]).toMatchObject({ action: "certificate.manual_remove", target: "loja.exemplo.com.br" });
  });

  it("voltar para automático sem manual: 404", async () => {
    await expect(service.removeManual("loja.exemplo.com.br")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("instalar para nome que o painel não serve: 404", async () => {
    await expect(service.installManual("nada.exemplo.com.br", pem.loja!.cert, pem.loja!.key)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("o arquivo de índice sobrevive a reinício (outra instância lê o mesmo par)", async () => {
    await service.installManual("loja.exemplo.com.br", pem.loja!.cert, pem.loja!.key);
    const again = new ManualCertificateStore(dir);
    expect((await again.list()).map((m) => m.host)).toEqual(["loja.exemplo.com.br"]);
  });
});

describe("alertas do manual (30 e 7 dias)", () => {
  it("a 30 dias: alerta de aviso; a 7: crítico; vencido: crítico", async () => {
    await service.installManual("loja.exemplo.com.br", pem.loja!.cert, pem.loja!.key);
    const validTo = Date.parse((await store.list())[0]!.validTo);

    now = validTo - 40 * DAY;
    await service.checkExpiryAlerts();
    expect((await alerts.list()).alerts).toHaveLength(0);

    now = validTo - 25 * DAY;
    await service.checkExpiryAlerts();
    let list = (await alerts.list()).alerts;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ source: "certificate", severity: "warning" });
    expect(list[0]!.title).toContain("loja.exemplo.com.br");

    // repetir não empilha
    await service.checkExpiryAlerts();
    expect((await alerts.list()).alerts).toHaveLength(1);

    now = validTo - 5 * DAY;
    await service.checkExpiryAlerts();
    list = (await alerts.list()).alerts;
    expect(list.some((a) => a.severity === "critical" && a.title.includes("7 dias"))).toBe(true);

    now = validTo + DAY;
    await service.checkExpiryAlerts();
    expect((await alerts.list()).alerts.some((a) => a.title.includes("venceu"))).toBe(true);
  });
});
