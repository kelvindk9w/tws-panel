/**
 * mail-tls.test.ts — certificado de verdade no servidor de e-mail, SMTP_HOST
 * pelo nome do certificado e proteção do MX existente.
 *
 * Validação real (01/10/2026):
 *  - o Stalwart rodava com certificado autoassinado e o projeto recebia
 *    SMTP_HOST=paas-stalwart. O cassino (nodemailer com requireTLS e
 *    verificação padrão) recusaria a conexão: emissor não confiável e nome
 *    que nenhum certificado público tem. Agora o Caddy emite o certificado de
 *    mail.<domínio>, o painel o instala no Stalwart (e reinstala na
 *    renovação) e injeta SMTP_HOST=mail.<domínio>;
 *  - o dono do produto ia cadastrar o domínio principal da empresa, que
 *    recebe e-mail em outro provedor: apontar o MX para a VPS desviaria todo
 *    o e-mail dela. Agora o cadastro exige confirmação explícita.
 *
 * Sem Docker e sem DNS: StalwartManager/Client são dublês, e a leitura do
 * certificado no Caddy, a conferência TLS e o resolver são injetados.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIL_DEFAULT_PORTS, type Project } from "@paas/core";
import type { MailCertificate } from "@paas/mailer";
import type { ServerConfig } from "../src/config.js";

interface ManagerCall {
  opts: Record<string, unknown>;
  method: string;
  arg?: unknown;
}
const managerCalls: ManagerCall[] = [];
let running = true;
const clientCalls: string[] = [];

vi.mock("@paas/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paas/mailer")>();
  class FakeStalwartManager {
    constructor(private readonly opts: Record<string, unknown>) {}
    async status() {
      managerCalls.push({ opts: this.opts, method: "status" });
      return {
        installed: true,
        running,
        version: "0.11.8",
        image: "stalwartlabs/mail-server:v0.11.8",
        containerName: "paas-stalwart",
        hostname: this.opts.hostname,
        ports: MAIL_DEFAULT_PORTS,
        message: null,
      };
    }
    async start() {
      managerCalls.push({ opts: this.opts, method: "start" });
    }
    async waitReady() {
      managerCalls.push({ opts: this.opts, method: "waitReady" });
    }
    async connectContainer(name: string) {
      managerCalls.push({ opts: this.opts, method: "connectContainer", arg: name });
    }
    async applyTls(arg: { restart: boolean }) {
      managerCalls.push({ opts: this.opts, method: "applyTls", arg });
      return arg.restart ? "restarted" : "reloaded";
    }
    apiBaseUrl() {
      return (this.opts.apiBaseUrl as string | undefined) ?? "http://127.0.0.1:8080";
    }
  }
  class FakeStalwartClient {
    constructor(readonly baseUrl: string) {
      clientCalls.push(`new ${baseUrl}`);
    }
    async createDomain(d: string) {
      clientCalls.push(`domain ${d}`);
    }
    async createDkimSignature() {
      return "sig";
    }
    async getDkimPublicKey() {
      return "x".repeat(120);
    }
    async createMailbox(email: string) {
      clientCalls.push(`mailbox ${email}`);
    }
  }
  return { ...actual, StalwartManager: FakeStalwartManager, StalwartClient: FakeStalwartClient };
});

const { MailService } = await import("../src/services/mail-service.js");

let dir = "";
let config: ServerConfig;

function cert(host: string, fingerprint = "AA:BB"): MailCertificate {
  return {
    host,
    cert: `CERT ${host}`,
    key: `CHAVE ${host}`,
    fingerprint,
    issuer: "Let's Encrypt",
    validTo: "2026-12-30T00:00:00.000Z",
  };
}

async function seed(data: Record<string, unknown>) {
  await mkdir(path.join(dir, "mail"), { recursive: true });
  await writeFile(
    path.join(dir, "mail", "mail.json"),
    JSON.stringify({ adminSecret: "s", hostname: null, domains: {}, mailboxes: {}, projects: {}, ...data }),
  );
}

function domain(name: string) {
  return {
    name,
    dkimSelector: "paas",
    dkimPublicKey: "x".repeat(120),
    dkimKeyBits: 2048,
    dmarcStage: "none",
    createdAt: new Date(0).toISOString(),
    lastVerify: null,
  };
}

const resolverOf = (a: Record<string, string[]>, mx: Record<string, Array<{ exchange: string; priority: number }>> = {}) => ({
  resolve4: async (n: string) => {
    if (a[n]) return a[n]!;
    throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  },
  resolve6: async () => [],
  resolveTxt: async () => [],
  reverse: async () => [],
  resolveMx: async (n: string) => {
    if (mx[n]) return mx[n]!;
    throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
  },
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-mail-tls-"));
  managerCalls.length = 0;
  clientCalls.length = 0;
  running = true;
  config = {
    dataDir: dir,
    mailPorts: MAIL_DEFAULT_PORTS,
    mailHostname: null,
    publicIp: "203.0.113.10",
    publicIpv6: null,
    panelDomain: null,
  } as unknown as ServerConfig;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const project = { id: "p1", slug: "cassino" } as Project;

describe("SMTP_HOST pelo nome do certificado", () => {
  it("projeto com e-mail ativo recebe SMTP_HOST=mail.<domínio da caixa> (no próximo deploy)", async () => {
    await seed({
      domains: { "exemplo.com.br": domain("exemplo.com.br") },
      mailboxes: {
        "cassino@exemplo.com.br": {
          id: "cassino@exemplo.com.br", localPart: "cassino", domain: "exemplo.com.br", kind: "project",
          createdAt: new Date(0).toISOString(), password: "senha-forte",
        },
      },
      projects: { p1: { domain: "exemplo.com.br", mailbox: "cassino@exemplo.com.br", enabledAt: new Date(0).toISOString() } },
    });
    const service = new MailService(config, { inContainer: false });
    const env = await service.envForProject(project);
    expect(env.SMTP_HOST).toBe("mail.exemplo.com.br");
    expect(env.SMTP_PORT).toBe("587");
    expect((await service.projectEmailConfig("p1")).env.SMTP_HOST).toBe("mail.exemplo.com.br");
  });
});

describe("hostname e hosts do servidor de e-mail", () => {
  it("sem PAAS_MAIL_HOSTNAME: mail.<1º domínio>; hosts = hostname + mail.<cada domínio>", async () => {
    await seed({ domains: { "a.com": domain("a.com"), "b.com": domain("b.com") } });
    const service = new MailService(config, { inContainer: false });
    expect((await service.status()).hostname).toBe("mail.a.com");
    expect(await service.mailHosts()).toEqual(["mail.a.com", "mail.b.com"]);
  });

  it("PAAS_MAIL_HOSTNAME vale e entra na lista; mail.localhost (sem domínio) não entra", async () => {
    await seed({ domains: { "a.com": domain("a.com") } });
    const service = new MailService({ ...config, mailHostname: "smtp.provedor.com" } as ServerConfig, { inContainer: false });
    expect(await service.mailHosts()).toEqual(["smtp.provedor.com", "mail.a.com"]);
    await seed({});
    expect(await new MailService(config, { inContainer: false }).mailHosts()).toEqual([]);
  });
});

describe("syncTls — instala e renova o certificado do Caddy no Stalwart", () => {
  it("primeiro certificado: entrega ao Stalwart e REINICIA (seção nova só vale após restart)", async () => {
    await seed({ domains: { "a.com": domain("a.com") } });
    const service = new MailService(config, {
      inContainer: false,
      readCertificate: async (h) => (h === "mail.a.com" ? cert(h) : null),
    });
    expect(await service.syncTls()).toBe("restarted");
    const apply = managerCalls.find((c) => c.method === "applyTls")!;
    expect(apply.arg).toEqual({ restart: true });
    expect(apply.opts.certificates).toEqual([cert("mail.a.com")]);
    expect(apply.opts.aliases).toEqual(["mail.a.com"]);
    expect(apply.opts.hostname).toBe("mail.a.com");

    // mesma coisa de novo: nada a fazer
    managerCalls.length = 0;
    expect(await service.syncTls()).toBe("none");
    expect(managerCalls.some((c) => c.method === "applyTls")).toBe(false);

    // o estado aplicado fica no mail.json, sem a chave privada
    const stored = await readFile(path.join(dir, "mail", "mail.json"), "utf8");
    expect(stored).not.toContain("CHAVE");
  });

  it("renovação (mesmo nome, certificado novo): recarrega sem reiniciar", async () => {
    await seed({ domains: { "a.com": domain("a.com") } });
    let fp = "AA:BB";
    const service = new MailService(config, { inContainer: false, readCertificate: async (h) => cert(h, fp) });
    await service.syncTls();
    fp = "CC:DD";
    managerCalls.length = 0;
    expect(await service.syncTls()).toBe("reloaded");
    expect(managerCalls.find((c) => c.method === "applyTls")!.arg).toEqual({ restart: false });
  });

  it("domínio novo (alias novo, ainda sem certificado): só ajusta a rede, sem reiniciar", async () => {
    await seed({ domains: { "a.com": domain("a.com") } });
    const service = new MailService(config, {
      inContainer: false,
      readCertificate: async (h) => (h === "mail.a.com" ? cert(h) : null),
    });
    await service.syncTls();
    await seed({
      domains: { "a.com": domain("a.com"), "b.com": domain("b.com") },
      tls: JSON.parse(await readFile(path.join(dir, "mail", "mail.json"), "utf8")).tls,
    });
    const again = new MailService(config, {
      inContainer: false,
      readCertificate: async (h) => (h === "mail.a.com" ? cert(h) : null),
    });
    managerCalls.length = 0;
    expect(await again.syncTls()).toBe("reloaded");
    const apply = managerCalls.find((c) => c.method === "applyTls")!;
    expect(apply.arg).toEqual({ restart: false });
    expect(apply.opts.aliases).toEqual(["mail.a.com", "mail.b.com"]);
  });

  it("servidor parado ou nunca iniciado: não mexe em nada", async () => {
    await seed({ domains: { "a.com": domain("a.com") } });
    running = false;
    const service = new MailService(config, { inContainer: false, readCertificate: async (h) => cert(h) });
    expect(await service.syncTls()).toBe("none");
    expect(managerCalls.some((c) => c.method === "applyTls")).toBe(false);

    await seed({ adminSecret: null });
    expect(await new MailService(config, { inContainer: false }).syncTls()).toBe("none");
  });

  it("chamadas simultâneas compartilham a mesma sincronização", async () => {
    await seed({ domains: { "a.com": domain("a.com") } });
    const read = vi.fn(async (h: string) => cert(h));
    const service = new MailService(config, { inContainer: false, readCertificate: read });
    const [a, b] = await Promise.all([service.syncTls(), service.syncTls()]);
    expect(a).toBe(b);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("painel em container", () => {
  it("API e TLS pela rede paas-net: o painel é ligado a ela e fala com paas-stalwart:8080", async () => {
    await seed({ adminSecret: null, domains: { "a.com": domain("a.com") } });
    const service = new MailService(config, { inContainer: true, readCertificate: async () => null });
    await service.startServer();
    const connect = managerCalls.find((c) => c.method === "connectContainer")!;
    expect(connect.arg).toBe("tws-panel");
    expect(connect.opts.apiBaseUrl).toBe("http://paas-stalwart:8080");
    expect(managerCalls.map((c) => c.method)).toEqual(
      expect.arrayContaining(["connectContainer", "start", "waitReady"]),
    );
  });

  it("painel recriado (atualização) com o Stalwart já rodando: liga-se à paas-net antes de falar com ele, uma vez só", async () => {
    await seed({ domains: { "a.com": domain("a.com") } });
    const service = new MailService(config, { inContainer: true, readCertificate: async () => null });
    await service.syncTls();
    await service.syncTls();
    expect(managerCalls.filter((c) => c.method === "connectContainer").map((c) => c.arg)).toEqual(["tws-panel"]);
  });

  it("iniciado do zero com certificado: já sobe com ele (a sincronização seguinte não reinicia à toa)", async () => {
    await seed({ domains: { "a.com": domain("a.com") } });
    running = false;
    const service = new MailService(config, { inContainer: false, readCertificate: async (h) => cert(h) });
    await service.startServer();
    expect(managerCalls.find((c) => c.method === "start")!.opts.certificates).toEqual([cert("mail.a.com")]);
    running = true;
    managerCalls.length = 0;
    expect(await service.syncTls()).toBe("none");
  });

  it("já estava rodando: start() só regrava os arquivos, e a sincronização seguinte reinicia para valer", async () => {
    await seed({ domains: { "a.com": domain("a.com") } });
    const service = new MailService(config, { inContainer: false, readCertificate: async (h) => cert(h) });
    await service.startServer();
    expect(await service.syncTls()).toBe("restarted");
  });

  it("fora de container: API em 127.0.0.1 na porta publicada", async () => {
    await seed({ domains: { "a.com": domain("a.com") } });
    const service = new MailService(config, { inContainer: false, readCertificate: async () => null });
    await service.startServer();
    expect(managerCalls.some((c) => c.method === "connectContainer")).toBe(false);
    expect(managerCalls.find((c) => c.method === "start")!.opts.apiBaseUrl).toBeUndefined();
  });
});

describe("tlsStatus — estado visível na página E-mail", () => {
  const VALID = { ok: true, issuer: "Let's Encrypt", validTo: "2026-12-30T00:00:00.000Z", error: null };
  const SELF = { ok: false, issuer: null, validTo: null, error: "self-signed certificate" };

  it("válido: emissor e validade; a conferência é a mesma de um app (SNI = mail.<domínio>)", async () => {
    await seed({ domains: { "a.com": domain("a.com") } });
    const check = vi.fn(async () => VALID);
    const service = new MailService(config, {
      inContainer: true,
      readCertificate: async (h) => cert(h),
      checkCertificate: check,
      resolver: resolverOf({ "mail.a.com": ["203.0.113.10"] }),
    });
    const status = await service.tlsStatus();
    expect(status.serverRunning).toBe(true);
    expect(status.hosts).toEqual([
      expect.objectContaining({ host: "mail.a.com", ok: true, issuer: "Let's Encrypt", issued: true, hint: null }),
    ]);
    // em container: pelo alias na paas-net, porta 465 (TLS direto) — o caminho do app
    expect(check).toHaveBeenCalledWith(expect.objectContaining({ host: "mail.a.com", port: 465, servername: "mail.a.com" }));
  });

  it("fora de container: 127.0.0.1 na porta SMTPS publicada", async () => {
    await seed({ domains: { "a.com": domain("a.com") } });
    const check = vi.fn(async () => VALID);
    const service = new MailService({ ...config, mailPorts: { ...MAIL_DEFAULT_PORTS, submissions: 10465 } } as ServerConfig, {
      inContainer: false,
      readCertificate: async (h) => cert(h),
      checkCertificate: check,
      resolver: resolverOf({ "mail.a.com": ["203.0.113.10"] }),
    });
    await service.tlsStatus();
    expect(check).toHaveBeenCalledWith(expect.objectContaining({ host: "127.0.0.1", port: 10465, servername: "mail.a.com" }));
  });

  it("sem registro A: pendente, e o que falta é o A de mail.<domínio> com a nuvem CINZA", async () => {
    await seed({ domains: { "a.com": domain("a.com") } });
    const service = new MailService(config, {
      inContainer: false,
      readCertificate: async () => null,
      checkCertificate: async () => SELF,
      resolver: resolverOf({}),
    });
    const [h] = (await service.tlsStatus()).hosts;
    expect(h).toMatchObject({ ok: false, issued: false, dns: { status: "missing", expectedIp: "203.0.113.10" } });
    expect(h!.hint).toMatch(/registro A/);
    expect(h!.hint).toContain("mail.a.com");
    expect(h!.hint).toContain("203.0.113.10");
    expect(h!.hint).toMatch(/nuvem cinza/i);
  });

  it("IP da Cloudflare (nuvem laranja): explica que o certificado não sai assim", async () => {
    await seed({ domains: { "a.com": domain("a.com") } });
    const service = new MailService(config, {
      inContainer: false,
      readCertificate: async () => null,
      checkCertificate: async () => SELF,
      resolver: resolverOf({ "mail.a.com": ["104.16.1.1"] }),
    });
    const [h] = (await service.tlsStatus()).hosts;
    expect(h!.dns.status).toBe("cloudflare");
    expect(h!.hint).toMatch(/nuvem laranja/i);
  });

  it("aponta para outro IP: diz qual e para qual trocar", async () => {
    await seed({ domains: { "a.com": domain("a.com") } });
    const service = new MailService(config, {
      inContainer: false,
      readCertificate: async () => null,
      checkCertificate: async () => SELF,
      resolver: resolverOf({ "mail.a.com": ["198.51.100.7"] }),
    });
    const [h] = (await service.tlsStatus()).hosts;
    expect(h!.dns.status).toBe("other_ip");
    expect(h!.hint).toContain("198.51.100.7");
  });

  it("DNS certo, certificado ainda não emitido: aguardar a emissão (portas 80/443)", async () => {
    await seed({ domains: { "a.com": domain("a.com") } });
    const service = new MailService(config, {
      inContainer: false,
      readCertificate: async () => null,
      checkCertificate: async () => SELF,
      resolver: resolverOf({ "mail.a.com": ["203.0.113.10"] }),
    });
    const [h] = (await service.tlsStatus()).hosts;
    expect(h!.dns.status).toBe("ok");
    expect(h!.hint).toMatch(/80 e 443/);
  });

  it("emitido mas o servidor ainda apresenta outro: avisa e mostra o erro da conexão", async () => {
    await seed({ domains: { "a.com": domain("a.com") } });
    const service = new MailService(config, {
      inContainer: false,
      readCertificate: async (h) => cert(h),
      checkCertificate: async () => SELF,
      resolver: resolverOf({ "mail.a.com": ["203.0.113.10"] }),
    });
    const [h] = (await service.tlsStatus()).hosts;
    expect(h!.issued).toBe(true);
    expect(h!.hint).toMatch(/já foi emitido/);
    expect(h!.error).toBe("self-signed certificate");
  });

  it("servidor parado: não tenta conectar; falha da sincronização aparece no estado", async () => {
    await seed({ domains: { "a.com": domain("a.com") } });
    running = false;
    const check = vi.fn();
    const service = new MailService(config, {
      inContainer: false,
      readCertificate: async () => {
        throw new Error("docker fora do ar");
      },
      checkCertificate: check,
      resolver: resolverOf({ "mail.a.com": ["203.0.113.10"] }),
    });
    const status = await service.tlsStatus();
    expect(status.serverRunning).toBe(false);
    expect(check).not.toHaveBeenCalled();
    expect(status.hosts[0]!.hint).toMatch(/parado/);
  });

  it("falha ao instalar o certificado: aparece em syncError (não some em silêncio)", async () => {
    await seed({ domains: { "a.com": domain("a.com") } });
    const service = new MailService(config, {
      inContainer: false,
      readCertificate: async () => {
        throw new Error("docker fora do ar");
      },
      checkCertificate: async () => SELF,
      resolver: resolverOf({ "mail.a.com": ["203.0.113.10"] }),
    });
    expect((await service.tlsStatus()).syncError).toContain("docker fora do ar");
  });
});

describe("addDomain — o domínio já recebe e-mail em outro servidor", () => {
  it("MX em outro provedor sem confirmação: 409 com o servidor atual e a sugestão de subdomínio; nada é provisionado", async () => {
    await seed({});
    const service = new MailService(config, {
      inContainer: false,
      resolver: resolverOf({}, { "empresa.com.br": [{ exchange: "aspmx.l.google.com.", priority: 1 }] }),
    });
    const err = await service.addDomain("empresa.com.br").catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 409, code: "domain_receives_mail" });
    expect((err as Error).message).toContain("desviaria todo o e-mail que hoje chega em aspmx.l.google.com");
    expect((err as { details?: unknown }).details).toEqual({
      existingMail: { status: "elsewhere", servers: ["aspmx.l.google.com"], suggestedDomain: "envio.empresa.com.br" },
    });
    expect(clientCalls.filter((c) => !c.startsWith("new"))).toEqual([]);
  });

  it("com a confirmação explícita: segue e provisiona", async () => {
    await seed({});
    const service = new MailService(config, {
      inContainer: false,
      resolver: resolverOf({}, { "empresa.com.br": [{ exchange: "aspmx.l.google.com", priority: 1 }] }),
    });
    await service.addDomain("empresa.com.br", { confirmExistingMail: true });
    expect(clientCalls).toContain("domain empresa.com.br");
  });

  it("MX desconhecido (consulta falhou): também pede confirmação, com outra mensagem", async () => {
    await seed({});
    const service = new MailService(config, {
      inContainer: false,
      resolver: {
        ...resolverOf({}),
        resolveMx: async () => {
          throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
        },
      },
    });
    const err = await service.addDomain("empresa.com.br").catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 409, code: "domain_receives_mail" });
    expect((err as Error).message).toMatch(/não foi possível consultar/i);
  });

  it("sem MX (ou já apontando para cá): segue direto", async () => {
    await seed({});
    const service = new MailService(config, { inContainer: false, resolver: resolverOf({}) });
    await service.addDomain("envio.empresa.com.br");
    expect(clientCalls).toContain("domain envio.empresa.com.br");

    const here = new MailService(config, {
      inContainer: false,
      resolver: resolverOf({}, { "outro.com.br": [{ exchange: "mail.outro.com.br", priority: 10 }] }),
    });
    await here.addDomain("outro.com.br");
    expect(clientCalls).toContain("domain outro.com.br");
  });
});
