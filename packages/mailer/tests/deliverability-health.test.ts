/**
 * Testes da saúde de entregabilidade (deliverability-health.ts): plano de
 * registros, SPF com contagem de consultas, DKIM, DMARC, MX/A, PTR, porta 25,
 * TLS, listas de bloqueio, propagação, MTA-STS/TLS-RPT e a proteção contra
 * destinos privados. Resolvedores, sonda e busca da política são falsos: nada
 * sai para a rede (exceto o teste de banner, contra um servidor local).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mailHealthFingerprint, type BlacklistCheckResponse, type MailHealthCheck, type PtrCheck } from "@paas/core";
import {
  analyzeSpf,
  buildDnsPlan,
  classifyDelay,
  evaluateHealth,
  fetchMtaStsPolicy,
  getHttpsPolicy,
  applyAcknowledgements,
  isPrivateAddress,
  mtaStsHostFor,
  mtaStsId,
  mtaStsPolicy,
  mtaStsServedPolicy,
  summarizeChecks,
  probePort25,
  publicAddressesOf,
  readSmtpBanner,
  withDeadline,
  type HealthInput,
  type StoredAcknowledgement,
  type ResolverEntry,
} from "../src/deliverability-health.js";
import type { DnsResolverLike } from "../src/dns-checklist.js";
import type { QueueItemView } from "../src/queue-view.js";

const DOMAIN = "exemplo.com.br";
const HOST = `mail.${DOMAIN}`;
const IP = "203.0.113.10";

function keyOf(bits: number): string {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: bits });
  return publicKey.export({ type: "spki", format: "der" }).toString("base64");
}
const KEY_2048 = keyOf(2048);

type Zone = {
  a?: Record<string, string[]>;
  mx?: Record<string, Array<{ exchange: string; priority: number }>>;
  txt?: Record<string, string[]>;
  /** Nomes cuja consulta falha com erro de rede (não é "não existe"). */
  broken?: string[];
  /** Nomes cuja consulta falha com erro sem código. */
  plain?: string[];
};

function resolverOf(zone: Zone): DnsResolverLike {
  const notFound = () => Object.assign(new Error("nf"), { code: "ENOTFOUND" });
  const guard = (name: string) => {
    if (zone.plain?.includes(name)) throw new Error("falha sem código");
    if (zone.broken?.includes(name)) throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
  };
  return {
    async resolve4(name) {
      guard(name);
      const v = zone.a?.[name];
      if (!v) throw notFound();
      return v;
    },
    async resolve6() {
      throw notFound();
    },
    async resolveMx(name) {
      guard(name);
      const v = zone.mx?.[name];
      if (!v) throw notFound();
      return v;
    },
    async resolveTxt(name) {
      guard(name);
      const v = zone.txt?.[name];
      if (!v) throw notFound();
      return v.map((r) => r.match(/.{1,200}/g) ?? [""]);
    },
    async reverse() {
      throw notFound();
    },
  };
}

const GOOD_ZONE: Zone = {
  a: { [HOST]: [IP] },
  mx: { [DOMAIN]: [{ exchange: HOST, priority: 10 }] },
  txt: {
    [DOMAIN]: [`v=spf1 ip4:${IP} -all`],
    [`paas._domainkey.${DOMAIN}`]: [`v=DKIM1; k=rsa; p=${KEY_2048}`],
    [`_dmarc.${DOMAIN}`]: [`v=DMARC1; p=quarantine; rua=mailto:dmarc@${DOMAIN}`],
    [`_smtp._tls.${DOMAIN}`]: [`v=TLSRPTv1; rua=mailto:postmaster@${DOMAIN}`],
  },
};

const PTR_OK: PtrCheck = { ip: IP, expected: HOST, status: "found", found: [HOST], ticketText: null };
const CLEAN: BlacklistCheckResponse = {
  checkedAt: "2026-10-22T00:00:00Z",
  ip: { target: IP, results: [{ dnsbl: "z", label: "Spamhaus ZEN", status: "clean", detail: null, removalUrl: null }] },
  domains: [],
  listedCount: 0,
};
const NOW = Date.parse("2026-10-22T12:00:00Z");

function input(zone: Zone = GOOD_ZONE, over: Partial<HealthInput> = {}): HealthInput {
  const resolvers: ResolverEntry[] = [
    { label: "1.1.1.1", resolver: resolverOf(zone) },
    { label: "8.8.8.8", resolver: resolverOf(zone) },
  ];
  return {
    domain: DOMAIN,
    mailHostname: HOST,
    serverHostname: HOST,
    serverIp: IP,
    dkimSelector: "paas",
    dkimPublicKey: KEY_2048,
    dmarcStage: "quarantine",
    resolvers,
    ptr: PTR_OK,
    port25: { status: "open", host: "gmail-smtp-in.l.google.com" },
    queue: [],
    serverRunning: true,
    tlsHosts: [{ host: HOST, ok: true, validTo: "2026-12-30T00:00:00Z", error: null }],
    blacklist: CLEAN,
    fetchPolicy: async () => null,
    isProxyIp: (ip) => ip.startsWith("104.16."),
    now: NOW,
    ...over,
  };
}

async function checkOf(id: MailHealthCheck["id"], zone: Zone = GOOD_ZONE, over: Partial<HealthInput> = {}): Promise<MailHealthCheck> {
  const report = await evaluateHealth(input(zone, over));
  return report.checks.find((c) => c.id === id) as MailHealthCheck;
}

function withTxt(name: string, values: string[] | undefined): Zone {
  const txt = { ...GOOD_ZONE.txt };
  if (values) txt[name] = values;
  else delete txt[name];
  return { ...GOOD_ZONE, txt };
}

describe("plano de registros", () => {
  const plan = buildDnsPlan({
    domain: DOMAIN,
    mailHostname: HOST,
    serverHostname: HOST,
    serverIp: IP,
    dkimSelector: "paas",
    dkimPublicKey: "AAAA",
    dmarcStage: "none",
  });

  it("lista a ordem A, MX, SPF, DKIM, DMARC e depois os opcionais, nunca com proxy", () => {
    expect(plan.records.map((r) => r.id)).toEqual(["a", "mx", "spf", "dkim", "dmarc", "tls_rpt", "mta_sts_a", "mta_sts"]);
    expect(plan.records.map((r) => r.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(plan.records.every((r) => r.proxied === false)).toBe(true);
    expect(plan.records.filter((r) => r.need === "optional").map((r) => r.id)).toEqual(["tls_rpt", "mta_sts_a", "mta_sts"]);
    expect(plan.records.find((r) => r.id === "mta_sts_a")).toMatchObject({ type: "A", name: `mta-sts.${DOMAIN}`, value: IP, need: "optional" });
    expect(plan.records.find((r) => r.id === "mx")).toMatchObject({ value: HOST, priority: 10 });
    expect(plan.records.find((r) => r.id === "spf")?.value).toBe(`v=spf1 ip4:${IP} ~all`);
    expect(plan.records.find((r) => r.id === "dkim")?.value).toBe("v=DKIM1; k=rsa; p=AAAA");
    expect(plan.records.find((r) => r.id === "dmarc")?.value).toContain("p=none");
    expect(plan.ptr).toEqual({ ip: IP, expected: HOST });
  });

  it("acrescenta o A do nome do servidor (HELO) e o AAAA quando existem", () => {
    const other = buildDnsPlan({
      domain: DOMAIN,
      mailHostname: HOST,
      serverHostname: "mail.outro.example.com",
      serverIp: IP,
      serverIpv6: "2001:db8::10",
      dkimSelector: "paas",
      dkimPublicKey: "AAAA",
      dmarcStage: "reject",
    });
    expect(other.records.map((r) => r.id).slice(0, 3)).toEqual(["a", "a_helo", "aaaa"]);
    expect(other.records[1]).toMatchObject({ name: "mail.outro.example.com", value: IP });
    expect(other.ptr.expected).toBe("mail.outro.example.com");
  });

  it("a política MTA-STS começa em testing e o id muda com o texto", () => {
    expect(mtaStsPolicy(HOST)).toContain("mode: testing");
    expect(mtaStsPolicy(HOST)).toContain(`mx: ${HOST}`);
    expect(mtaStsId(mtaStsPolicy(HOST))).not.toBe(mtaStsId(mtaStsPolicy("mail.outro.example.com")));
    expect(plan.records.find((r) => r.id === "mta_sts")?.value).toBe(`v=STSv1; id=${mtaStsId(plan.mtaStsPolicy)}`);
  });
});

describe("destinos de rede", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.5",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    [224, 0, 0, 1].join("."),
    "::1",
    "0:0:0:0:0:0:0:1",
    "::127.0.0.1",
    "::10.0.0.1",
    "64:ff9b::7f00:1",
    "64:ff9b::a00:1",
    "fec0::1",
    "fe80::1%eth0",
    "2001:db8::1",
    "2001::1",
    "2002:7f00:1::",
    "2002:a9fe:a9fe::",
    "100::1",
    "fc00::1",
    "febf::1",
    "ffff::1",
    "::",
    "fd00::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "nao-e-ip",
  ])("%s é recusado", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["203.0.113.10", "8.8.8.8", "2606:4700::1111", "::ffff:8.8.8.8", "2002:808:808::", "2a00:1450::1"])("%s é público", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it("publicAddressesOf recusa nome que resolve para rede privada ou para nada", async () => {
    await expect(publicAddressesOf("a.example.com", async () => ["8.8.8.8"])).resolves.toEqual(["8.8.8.8"]);
    await expect(publicAddressesOf("a.example.com", async () => ["8.8.8.8", "10.0.0.1"])).rejects.toThrow("destino_nao_publico");
    await expect(publicAddressesOf("a.example.com", async () => [])).rejects.toThrow("destino_nao_publico");
  });

  it("publicAddressesOf usa o DNS do sistema por padrão (localhost é recusado)", async () => {
    await expect(publicAddressesOf("localhost")).rejects.toThrow();
  });
});

describe("porta 25 de saída", () => {
  const lookup = async () => ["8.8.8.8"];

  it("aberta quando vem o 220", async () => {
    const result = await probePort25({ lookup, banner: async () => "220 mx.example.com ESMTP" });
    expect(result).toEqual({ status: "open", host: "gmail-smtp-in.l.google.com" });
  });

  it("passa para o segundo destino quando o primeiro está fechado", async () => {
    let calls = 0;
    const result = await probePort25({
      lookup,
      banner: async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("x"), { code: "ETIMEDOUT" });
        return "220 ok";
      },
    });
    expect(result.status).toBe("open");
    expect(calls).toBe(2);
  });

  it("bloqueada quando nenhum destino atende (caso comum de VPS)", async () => {
    const result = await probePort25({
      lookup,
      banner: async () => {
        throw Object.assign(new Error("x"), { code: "ETIMEDOUT" });
      },
    });
    expect(result).toMatchObject({ status: "blocked", detail: "ETIMEDOUT" });
  });

  it("conectou sem banner 220: também conta como bloqueada", async () => {
    const result = await probePort25({ lookup, hosts: ["mx.example.com"], banner: async () => "554 no" });
    expect(result).toMatchObject({ status: "blocked", detail: "sem_banner" });
  });

  it("erro que não é de bloqueio (DNS, destino privado) vira 'não deu para testar'", async () => {
    const privateTarget = await probePort25({ lookup: async () => ["10.0.0.1"], banner: async () => "220 x" });
    expect(privateTarget).toMatchObject({ status: "error", detail: "destino_nao_publico" });
    const none = await probePort25({ hosts: [] });
    expect(none).toEqual({ status: "error", detail: "sem_destino" });
  });

  it("bloqueio vence erro de outro destino", async () => {
    let calls = 0;
    const result = await probePort25({
      lookup,
      banner: async () => {
        calls += 1;
        if (calls === 1) throw new Error("outra_coisa");
        throw Object.assign(new Error("x"), { code: "ECONNREFUSED" });
      },
    });
    expect(result.status).toBe("blocked");
  });

  it("erro sem código usa a mensagem", async () => {
    const result = await probePort25({
      lookup,
      hosts: ["a.example.com"],
      banner: async () => {
        throw new Error("falha_qualquer");
      },
    });
    expect(result).toMatchObject({ status: "error", detail: "falha_qualquer" });
  });
});

describe("leitura do banner (servidor local)", () => {
  function serve(onConnect: (socket: net.Socket) => void): Promise<{ port: number; close: () => void }> {
    return new Promise((resolve) => {
      const server = net.createServer(onConnect);
      server.listen(0, "127.0.0.1", () => {
        resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() });
      });
    });
  }

  it("devolve a primeira linha", async () => {
    const s = await serve((socket) => socket.write("220 teste ESMTP\r\nresto"));
    await expect(readSmtpBanner("127.0.0.1", s.port, 2_000)).resolves.toBe("220 teste ESMTP");
    s.close();
  });

  it("junta pedaços até chegar o fim da linha", async () => {
    const s = await serve((socket) => {
      socket.write("220 par");
      setTimeout(() => socket.write("cial\r\n"), 30);
    });
    await expect(readSmtpBanner("127.0.0.1", s.port, 2_000)).resolves.toBe("220 parcial");
    s.close();
  });

  it("corta linha sem fim em 512 bytes", async () => {
    const s = await serve((socket) => socket.write("x".repeat(600)));
    await expect(readSmtpBanner("127.0.0.1", s.port, 2_000)).resolves.toHaveLength(512);
    s.close();
  });

  it("conexão fechada sem dados é erro", async () => {
    const s = await serve((socket) => socket.end());
    await expect(readSmtpBanner("127.0.0.1", s.port, 2_000)).rejects.toThrow("conexao_fechada");
    s.close();
  });

  it("sem resposta no prazo: ETIMEDOUT", async () => {
    const s = await serve(() => undefined);
    await expect(readSmtpBanner("127.0.0.1", s.port, 50)).rejects.toMatchObject({ code: "ETIMEDOUT" });
    s.close();
  });

  it("porta fechada: erro de conexão", async () => {
    const s = await serve(() => undefined);
    const port = s.port;
    await new Promise<void>((r) => {
      s.close();
      setTimeout(r, 20);
    });
    await expect(readSmtpBanner("127.0.0.1", port, 1_000)).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});

describe("busca da política MTA-STS", () => {
  it("só conecta em endereço público e devolve o texto", async () => {
    const calls: string[] = [];
    const text = await fetchMtaStsPolicy(DOMAIN, {
      lookup: async () => ["8.8.8.8"],
      get: async (address, host) => {
        calls.push(`${address} ${host}`);
        return "version: STSv1";
      },
    });
    expect(text).toBe("version: STSv1");
    expect(calls).toEqual([`8.8.8.8 mta-sts.${DOMAIN}`]);
  });

  it("nome que resolve para rede privada não é consultado", async () => {
    let called = false;
    const text = await fetchMtaStsPolicy(DOMAIN, {
      lookup: async () => ["169.254.169.254"],
      get: async () => {
        called = true;
        return "x";
      },
    });
    expect(text).toBeNull();
    expect(called).toBe(false);
  });

  it("busca que não termina no prazo (get pendurado) devolve null no relógio", async () => {
    const started = Date.now();
    const text = await fetchMtaStsPolicy(DOMAIN, { lookup: async () => ["8.8.8.8"], get: () => new Promise(() => undefined), timeoutMs: 100 });
    expect(text).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("withDeadline devolve o resultado antes do prazo e o fallback depois", async () => {
    await expect(withDeadline(Promise.resolve("a"), 1_000, "b")).resolves.toBe("a");
    await expect(withDeadline(new Promise<string>(() => undefined), 50, "b")).resolves.toBe("b");
  });

  it("falha na busca ou DNS vira null", async () => {
    expect(await fetchMtaStsPolicy(DOMAIN, { lookup: async () => ["8.8.8.8"], get: async () => { throw new Error("x"); } })).toBeNull();
    expect(await fetchMtaStsPolicy(DOMAIN, { lookup: async () => { throw new Error("x"); } })).toBeNull();
  });

  describe("getHttpsPolicy contra um servidor HTTPS local", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tws-sts-"));
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
      "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"),
      "-subj", "/CN=mta-sts.example.com", "-addext", "subjectAltName=DNS:mta-sts.example.com",
    ], { stdio: "ignore" });
    const cert = readFileSync(path.join(dir, "c.pem"));
    const key = readFileSync(path.join(dir, "k.pem"));

    function serve(handler: https.RequestListener): Promise<{ port: number; close: () => void }> {
      return new Promise((resolve) => {
        const server = https.createServer({ cert, key }, handler);
        server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() }));
      });
    }
    const get = (port: number) => getHttpsPolicy("127.0.0.1", "mta-sts.example.com", 1_000, { port, ca: cert });

    it("200 devolve o texto e pede o caminho certo", async () => {
      let seen = "";
      const s = await serve((req, res) => {
        seen = `${req.url} ${req.headers.host}`;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("version: STSv1");
      });
      await expect(get(s.port)).resolves.toBe("version: STSv1");
      expect(seen).toBe("/.well-known/mta-sts.txt mta-sts.example.com");
      s.close();
    });

    it("sem Content-Type text/plain a política não vale", async () => {
      const wrong = await serve((_req, res) => {
        res.setHeader("content-type", "text/html");
        res.end("version: STSv1");
      });
      await expect(get(wrong.port)).resolves.toBeNull();
      wrong.close();
      const none = await serve((_req, res) => {
        res.removeHeader("content-type");
        res.end("version: STSv1");
      });
      await expect(get(none.port)).resolves.toBeNull();
      none.close();
    });

    it("redirecionamento e erro viram null (não segue)", async () => {
      const s = await serve((_req, res) => {
        res.statusCode = 301;
        res.setHeader("location", "https://169.254.169.254/");
        res.end();
      });
      await expect(get(s.port)).resolves.toBeNull();
      s.close();
    });

    it("corpo maior que 16 KB é descartado", async () => {
      const s = await serve((_req, res) => {
        res.write("x".repeat(20_000));
        res.end();
      });
      await expect(get(s.port)).resolves.toBeNull();
      s.close();
    });

    it("sem a CA do servidor, o certificado é recusado", async () => {
      const s = await serve((_req, res) => res.end("ok"));
      await expect(getHttpsPolicy("127.0.0.1", "mta-sts.example.com", 1_000, { port: s.port })).resolves.toBeNull();
      s.close();
    });

    it("prazo é do relógio: servidor que manda 1 byte a cada 200 ms não segura a busca", async () => {
      const s = await serve((_req, res) => {
        res.statusCode = 200;
        const timer = setInterval(() => res.write("x"), 200);
        res.on("close", () => clearInterval(timer));
      });
      const started = Date.now();
      await expect(getHttpsPolicy("127.0.0.1", "mta-sts.example.com", 600, { port: s.port, ca: cert })).resolves.toBeNull();
      expect(Date.now() - started).toBeLessThan(1_500);
      s.close();
    });

    it("servidor que não responde no prazo vira null", async () => {
      const s = await serve(() => undefined);
      await expect(getHttpsPolicy("127.0.0.1", "mta-sts.example.com", 100, { port: s.port, ca: cert })).resolves.toBeNull();
      s.close();
    });
  });

  it("getHttpsPolicy sem servidor HTTPS no endereço devolve null", async () => {
    // Porta 443 do loopback fechada: erro de conexão vira null (sem alvo externo).
    await expect(getHttpsPolicy("127.0.0.1", "mta-sts.example.com", 300)).resolves.toBeNull();
  });
});

describe("SPF", () => {
  it("conta as consultas de include, a, mx, ptr, exists e redirect", async () => {
    const zone: Zone = {
      a: { "a.example.com": [IP], "mx1.example.com": ["198.51.100.1"] },
      mx: { "mx.example.com": [{ exchange: "mx1.example.com", priority: 1 }], [DOMAIN]: [{ exchange: "mx1.example.com", priority: 1 }] },
      txt: {
        [DOMAIN]: ["v=spf1 include:inc.example.com a:a.example.com mx:mx.example.com mx a/24 ptr exists:%{i}.x.example.com redirect=r.example.com"],
        "inc.example.com": ["v=spf1 ip4:198.51.100.0/24 ~all"],
        "r.example.com": ["v=spf1 -all"],
      },
    };
    const spf = await analyzeSpf(DOMAIN, IP, resolverOf(zone));
    expect(spf.lookups).toBe(8);
    const viaMx = await analyzeSpf(DOMAIN, IP, resolverOf({ mx: { [DOMAIN]: [{ exchange: "m.example.com", priority: 1 }] }, a: { "m.example.com": [IP] }, txt: { [DOMAIN]: ["v=spf1 mx -all"] } }));
    expect(viaMx.authorizes).toBe(true);
    expect(spf.authorizes).toBe(true);
    expect(spf.usesPtr).toBe(true);
    expect(spf.all).toBeNull();
  });

  it("ip4 com máscara, ip exato e máscara inválida", async () => {
    const make = (mech: string) => resolverOf({ txt: { [DOMAIN]: [`v=spf1 ${mech} -all`] } });
    expect((await analyzeSpf(DOMAIN, IP, make("ip4:203.0.113.0/24"))).authorizes).toBe(true);
    expect((await analyzeSpf(DOMAIN, IP, make(`ip4:${IP}`))).authorizes).toBe(true);
    expect((await analyzeSpf(DOMAIN, IP, make("ip4:198.51.100.0/24"))).authorizes).toBe(false);
    expect((await analyzeSpf(DOMAIN, IP, make("ip4:203.0.113.0/99"))).authorizes).toBe(false);
    expect((await analyzeSpf(DOMAIN, IP, make("ip4:abc"))).authorizes).toBe(false);
    expect((await analyzeSpf("x.invalid", "abc", make("ip4:1.1.1.1"))).authorizes).toBe(false);
  });

  it("lê o qualificador do all final e ignora ip6", async () => {
    const r = (all: string) => resolverOf({ txt: { [DOMAIN]: [`v=spf1 ip6:2001:db8::/32 ${all}`] } });
    expect((await analyzeSpf(DOMAIN, IP, r("-all"))).all).toBe("-all");
    expect((await analyzeSpf(DOMAIN, IP, r("~all"))).all).toBe("~all");
    expect((await analyzeSpf(DOMAIN, IP, r("?all"))).all).toBe("?all");
    expect((await analyzeSpf(DOMAIN, IP, r("all"))).all).toBe("+all");
  });

  it("include circular não trava (profundidade limitada)", async () => {
    const zone: Zone = { txt: { [DOMAIN]: ["v=spf1 include:" + DOMAIN + " -all"] } };
    const spf = await analyzeSpf(DOMAIN, IP, resolverOf(zone));
    expect(spf.lookups).toBeGreaterThan(10);
  });

  it("consulta que falha vale como vazia", async () => {
    const zone: Zone = { txt: { [DOMAIN]: ["v=spf1 a mx include:x.example.com -all"] }, broken: [DOMAIN, "x.example.com"] };
    const spf = await analyzeSpf(DOMAIN, IP, resolverOf(zone));
    expect(spf.records).toEqual([]);
  });

  it("sem registro: nada", async () => {
    const spf = await analyzeSpf(DOMAIN, IP, resolverOf({}));
    expect(spf).toMatchObject({ records: [], lookups: 0, authorizes: false });
  });
});

describe("verificação ao vivo", () => {
  it("domínio todo certo: ok, sem pendência que afete a caixa de entrada", async () => {
    const report = await evaluateHealth(input());
    expect(report.level).toBe("ok");
    expect(report.counts.critical).toBe(0);
    expect(report.counts.warn).toBe(0);
    expect(report.inboxIssues).toEqual([]);
    expect(report.checkedAt).toBe("2026-10-22T12:00:00.000Z");
    expect(report.checks.map((c) => c.id)).not.toContain("helo");
    expect(report.checks.find((c) => c.id === "spf")).toMatchObject({ level: "ok", code: "ok_hard" });
    expect(report.checks.find((c) => c.id === "dkim")).toMatchObject({ level: "ok", params: { bits: 2048 } });
    expect(report.checks.find((c) => c.id === "dmarc")?.code).toBe("quarantine");
    expect(report.checks.find((c) => c.id === "tls_rpt")?.level).toBe("ok");
    expect(report.checks.find((c) => c.id === "mta_sts")).toMatchObject({ level: "optional", code: "absent", inbox: false });
  });

  it("nada publicado: crítico e a lista do que afeta a caixa de entrada", async () => {
    const report = await evaluateHealth(input({}));
    expect(report.level).toBe("critical");
    expect(report.inboxIssues).toEqual(expect.arrayContaining(["a", "mx", "spf", "dkim", "dmarc"]));
    expect(report.checks.find((c) => c.id === "propagation")?.level).toBe("info");
  });

  describe("A", () => {
    it("ausente, divergente, atrás do proxy e indisponível", async () => {
      expect((await checkOf("a", { ...GOOD_ZONE, a: {} })).code).toBe("missing");
      expect(await checkOf("a", { ...GOOD_ZONE, a: { [HOST]: ["198.51.100.9"] } })).toMatchObject({ code: "mismatch", level: "critical" });
      expect((await checkOf("a", { ...GOOD_ZONE, a: { [HOST]: ["104.16.1.1"] } })).code).toBe("proxied");
      expect(await checkOf("a", { ...GOOD_ZONE, broken: [HOST] })).toMatchObject({ code: "unavailable", level: "warn", inbox: false });
    });

    it("nome do servidor (HELO) diferente do mail.<domínio> também é conferido", async () => {
      const zone = { ...GOOD_ZONE, a: { [HOST]: [IP], "mail.outro.example.com": [IP] } };
      expect((await checkOf("helo", zone, { serverHostname: "mail.outro.example.com" })).level).toBe("ok");
      const wrong = { ...GOOD_ZONE, a: { [HOST]: [IP], "mail.outro.example.com": ["198.51.100.9"] } };
      expect((await checkOf("helo", wrong, { serverHostname: "mail.outro.example.com" })).level).toBe("critical");
    });
  });

  describe("MX", () => {
    it("ausente, em outro servidor, com A errado e indisponível", async () => {
      expect(await checkOf("mx", { ...GOOD_ZONE, mx: {} })).toMatchObject({ code: "missing", level: "warn", inbox: true });
      const other = { ...GOOD_ZONE, mx: { [DOMAIN]: [{ exchange: "mx.google.example.", priority: 1 }] } };
      expect(await checkOf("mx", other)).toMatchObject({ code: "other", level: "warn", inbox: false });
      expect((await checkOf("mx", { ...GOOD_ZONE, a: { [HOST]: ["198.51.100.9"] } })).code).toBe("target_wrong_ip");
      expect((await checkOf("mx", { ...GOOD_ZONE, broken: [DOMAIN] })).code).toBe("unavailable");
    });

    it("MX certo com A ainda sem resposta não acusa IP errado", async () => {
      expect((await checkOf("mx", { ...GOOD_ZONE, a: {} })).level).toBe("ok");
    });
  });

  describe("SPF", () => {
    it("ausente, múltiplo, sem o IP, enfraquecido, perto do limite, com ptr, suave", async () => {
      const spf = async (record: string[] | undefined, zone?: Zone) =>
        checkOf("spf", zone ?? withTxt(DOMAIN, record));
      expect((await spf(undefined)).code).toBe("missing");
      expect((await spf([`v=spf1 ip4:${IP} -all`, "v=spf1 -all"])).code).toBe("multiple");
      expect((await spf(["v=spf1 ip4:198.51.100.1 -all"])).code).toBe("ip_missing");
      expect((await spf([`v=spf1 ip4:${IP}`])).code).toBe("weak_all");
      expect((await spf([`v=spf1 ip4:${IP} +all`])).code).toBe("weak_all");
      expect((await spf([`v=spf1 ip4:${IP} ?all`])).level).toBe("critical");
      expect((await spf([`v=spf1 ip4:${IP} ptr -all`])).code).toBe("uses_ptr");
      expect((await spf([`v=spf1 ip4:${IP} ~all`])).code).toBe("ok_soft");
      const includes = Array.from({ length: 11 }, (_, i) => `include:i${i}.example.com`).join(" ");
      expect(await spf([`v=spf1 ip4:${IP} ${includes} -all`])).toMatchObject({ code: "too_many_lookups", level: "critical" });
      const eight = Array.from({ length: 8 }, (_, i) => `include:i${i}.example.com`).join(" ");
      expect(await spf([`v=spf1 ip4:${IP} ${eight} -all`])).toMatchObject({ code: "near_limit", level: "warn" });
    });

    it("DNS sem resposta: indisponível", async () => {
      expect((await checkOf("spf", { ...GOOD_ZONE, broken: [DOMAIN] })).code).toBe("unavailable");
    });

    it("avalia como um receptor: o qualificador manda e o primeiro termo que casa decide", async () => {
      const analyze = (record: string, extra: Record<string, string[]> = {}, a: Record<string, string[]> = {}) =>
        analyzeSpf(DOMAIN, IP, resolverOf({ txt: { [DOMAIN]: [record], ...extra }, a }));
      // "-ip4:" NÃO autoriza, mesmo com "+" depois
      expect(await analyze(`v=spf1 -ip4:${IP} ip4:${IP} -all`)).toMatchObject({ authorizes: false, outcome: "fail" });
      expect(await analyze(`v=spf1 ~ip4:${IP} -all`)).toMatchObject({ authorizes: false, outcome: "softfail" });
      expect(await analyze(`v=spf1 ?ip4:${IP} -all`)).toMatchObject({ authorizes: false, outcome: "neutral" });
      expect(await analyze(`v=spf1 +ip4:${IP} -all`)).toMatchObject({ authorizes: true, outcome: "pass" });
      expect(await analyze(`v=spf1 -a:a.example.com ip4:${IP} -all`, {}, { "a.example.com": [IP] })).toMatchObject({ authorizes: false });
      expect((await checkOf("spf", withTxt(DOMAIN, [`v=spf1 -ip4:${IP} -all`]))).code).toBe("ip_missing");
    });

    it("include: passa só se o destino passa; destino com -ip4 ou sem o IP não autoriza", async () => {
      const analyze = (inner: string[] | undefined) =>
        analyzeSpf(DOMAIN, IP, resolverOf({ txt: { [DOMAIN]: ["v=spf1 include:inc.example.com -all"], ...(inner ? { "inc.example.com": inner } : {}) } }));
      expect((await analyze([`v=spf1 ip4:${IP} -all`])).authorizes).toBe(true);
      expect((await analyze([`v=spf1 -ip4:${IP} ip4:${IP} ~all`])).authorizes).toBe(false);
      expect((await analyze(["v=spf1 ip4:198.51.100.1 -all"])).authorizes).toBe(false);
      // o "-all" do include não é o "all" do domínio
      expect((await analyze([`v=spf1 ip4:${IP} ~all`])).all).toBe("-all");
    });

    it("include (ou redirect) para domínio sem SPF, ou com dois, é erro permanente", async () => {
      const noSpf = await analyzeSpf(DOMAIN, IP, resolverOf({ txt: { [DOMAIN]: ["v=spf1 include:semspf.example.com -all"] } }));
      expect(noSpf).toMatchObject({ outcome: "permerror", authorizes: false });
      const twice = await analyzeSpf(
        DOMAIN,
        IP,
        resolverOf({ txt: { [DOMAIN]: ["v=spf1 include:dois.example.com -all"], "dois.example.com": ["v=spf1 -all", "v=spf1 +all"] } }),
      );
      expect(twice.outcome).toBe("permerror");
      const redirectToNothing = await analyzeSpf(DOMAIN, IP, resolverOf({ txt: { [DOMAIN]: ["v=spf1 redirect=nada.example.com"] } }));
      expect(redirectToNothing.outcome).toBe("permerror");
      expect((await checkOf("spf", withTxt(DOMAIN, ["v=spf1 include:semspf.example.com -all"]))).code).toBe("permerror");
      // erro depois de um termo que já casou não conta: o receptor nem chega nele
      const afterMatch = await analyzeSpf(DOMAIN, IP, resolverOf({ txt: { [DOMAIN]: [`v=spf1 ip4:${IP} include:semspf.example.com -all`] } }));
      expect(afterMatch).toMatchObject({ outcome: "pass", authorizes: true });
    });

    it("redirect= herda o all do destino e só vale sem all no registro", async () => {
      const zone = (target: string) => ({ txt: { [DOMAIN]: ["v=spf1 redirect=spf.example.com"], "spf.example.com": [target] } });
      const hard = await analyzeSpf(DOMAIN, IP, resolverOf(zone(`v=spf1 ip4:${IP} -all`)));
      expect(hard).toMatchObject({ authorizes: true, all: "-all", outcome: "pass" });
      const checked = await checkOf("spf", { txt: { [DOMAIN]: ["v=spf1 redirect=spf.example.com"], "spf.example.com": [`v=spf1 ip4:${IP} -all`] } });
      expect(checked).toMatchObject({ level: "ok", code: "ok_hard" });
      // o destino sem all continua fraco, e isso é dito
      const weak = await checkOf("spf", { txt: { [DOMAIN]: ["v=spf1 redirect=spf.example.com"], "spf.example.com": [`v=spf1 ip4:${IP}`] } });
      expect(weak.code).toBe("weak_all");
      // com all no registro, o redirect é ignorado
      const ignored = await analyzeSpf(DOMAIN, IP, resolverOf({ txt: { [DOMAIN]: ["v=spf1 -all redirect=spf.example.com"], "spf.example.com": [`v=spf1 ip4:${IP} -all`] } }));
      expect(ignored).toMatchObject({ authorizes: false, outcome: "fail", all: "-all" });
    });

    it("termos depois de all são ignorados (nem contam consultas)", async () => {
      const after = await analyzeSpf(DOMAIN, IP, resolverOf({ txt: { [DOMAIN]: [`v=spf1 -all ip4:${IP} include:x.example.com mx`] } }));
      expect(after).toMatchObject({ authorizes: false, outcome: "fail", lookups: 0 });
      const ok = await analyzeSpf(DOMAIN, IP, resolverOf({ txt: { [DOMAIN]: [`v=spf1 ip4:${IP} ~all include:x.example.com`] } }));
      expect(ok).toMatchObject({ authorizes: true, lookups: 0, all: "~all" });
    });

    it("macros não são expandidas: o termo não casa e a mensagem não afirma 'IP ausente'", async () => {
      const macro = await analyzeSpf(DOMAIN, IP, resolverOf({ txt: { [DOMAIN]: ["v=spf1 include:%{d}._spf.example.com a:%{h}.example.com mx:%{d}.example.com redirect=%{d}.example.com"] } }));
      expect(macro).toMatchObject({ macros: true, authorizes: false, lookups: 4 });
      const checked = await checkOf("spf", withTxt(DOMAIN, ["v=spf1 include:%{d}._spf.example.com -all"]));
      expect(checked).toMatchObject({ level: "warn", code: "has_macros" });
      // IP autorizado por outro termo continua passando, mesmo com macro no registro
      const pass = await analyzeSpf(DOMAIN, IP, resolverOf({ txt: { [DOMAIN]: [`v=spf1 ip4:${IP} exists:%{i}.x.example.com -all`] } }));
      expect(pass).toMatchObject({ authorizes: true, macros: true });
    });

    it("modificadores desconhecidos (exp=) não são mecanismos", async () => {
      const spf = await analyzeSpf(DOMAIN, IP, resolverOf({ txt: { [DOMAIN]: [`v=spf1 exp=explica.example.com ip4:${IP} -all`] } }));
      expect(spf).toMatchObject({ authorizes: true, lookups: 0 });
    });
  });

  describe("DKIM com reinício pendente (a chave existe, o servidor ainda não assina)", () => {
    // Garantia: "reinício pendente" NUNCA aparece como DKIM ok. O DNS está perfeito nos dois casos.
    it("marca ligada: item DKIM em atenção 'restart_pending', conta no aviso da caixa de entrada e no estado geral", async () => {
      const report = await evaluateHealth(input(GOOD_ZONE, { dkimRestartPending: true }));
      const item = report.checks.find((c) => c.id === "dkim")!;
      expect(item).toMatchObject({ level: "warn", code: "restart_pending", inbox: true, params: { selector: "paas" } });
      expect(report.inboxIssues).toContain("dkim");
      expect(report.level).not.toBe("ok");
      expect(report.counts.warn).toBeGreaterThanOrEqual(1);
    });

    it("marca desligada (ou ausente): o mesmo DNS dá DKIM ok e fora do aviso", async () => {
      for (const over of [{ dkimRestartPending: false }, {}]) {
        const report = await evaluateHealth(input(GOOD_ZONE, over));
        expect(report.checks.find((c) => c.id === "dkim")).toMatchObject({ level: "ok", code: "ok" });
        expect(report.inboxIssues).not.toContain("dkim");
      }
    });

    it("com a pendência, o erro de DNS mais grave continua aparecendo (a pendência não esconde chave errada)", async () => {
      const zone = withTxt(`paas._domainkey.${DOMAIN}`, undefined);
      const item = (await evaluateHealth(input(zone, { dkimRestartPending: true }))).checks.find((c) => c.id === "dkim")!;
      expect(item).toMatchObject({ level: "critical", code: "missing" });
    });
  });

  describe("DKIM", () => {
    const dkim = (value: string[] | undefined) => checkOf("dkim", withTxt(`paas._domainkey.${DOMAIN}`, value));

    it("ausente, revogado, inválido, divergente, curto, fraco e indisponível", async () => {
      expect((await dkim(undefined)).code).toBe("missing");
      expect((await dkim(["v=DKIM1; k=rsa; p="])).code).toBe("revoked");
      expect((await dkim(["v=DKIM1; k=rsa"])).code).toBe("revoked");
      expect((await dkim(["v=DKIM1; k=rsa; p=%%%nao-e-chave"])).code).toBe("invalid_key");
      expect(await dkim([`v=DKIM1; k=rsa; p=${keyOf(2048)}`])).toMatchObject({ code: "mismatch", level: "critical" });
      const short = keyOf(1024);
      expect(await checkOf("dkim", withTxt(`paas._domainkey.${DOMAIN}`, [`v=DKIM1; p=${short}`]), { dkimPublicKey: short })).toMatchObject({
        code: "short_key",
        level: "warn",
        params: { bits: 1024 },
      });
      const weak = keyOf(512);
      expect((await checkOf("dkim", withTxt(`paas._domainkey.${DOMAIN}`, [`v=DKIM1; p=${weak}`]), { dkimPublicKey: weak })).code).toBe("weak_key");
      expect((await checkOf("dkim", { ...GOOD_ZONE, broken: [`paas._domainkey.${DOMAIN}`] })).code).toBe("unavailable");
    });

    it("chave que não é RSA conta como inválida", async () => {
      const { generateKeyPairSync: gen } = await import("node:crypto");
      const ec = gen("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
      expect((await dkim([`v=DKIM1; k=ed25519; p=${ec}`])).code).toBe("invalid_key");
    });

    it("chave publicada com espaços (TXT dividido) ainda confere", async () => {
      const spaced = KEY_2048.replace(/(.{60})/g, "$1 ");
      expect((await dkim([`v=DKIM1; k=rsa; p=${spaced}`])).level).toBe("ok");
    });
  });

  describe("DMARC", () => {
    const dmarc = (value: string[] | undefined, zone?: Zone) => checkOf("dmarc", zone ?? withTxt(`_dmarc.${DOMAIN}`, value));

    it("ausente, múltiplo, inválido, sem rua, none, quarantine, reject, indisponível", async () => {
      expect((await dmarc(undefined)).code).toBe("missing");
      expect((await dmarc(["v=DMARC1; p=none", "v=DMARC1; p=reject"])).code).toBe("multiple");
      expect((await dmarc(["v=DMARC1; p=talvez; rua=mailto:a@b.c"])).code).toBe("invalid");
      expect(await dmarc(["v=DMARC1; p=none"])).toMatchObject({ code: "no_rua", level: "warn", inbox: false });
      expect(await dmarc(["v=DMARC1; p=none; rua=mailto:a@exemplo.com.br"])).toMatchObject({ code: "none", level: "ok" });
      expect((await dmarc(["v=DMARC1; p=reject; rua=mailto:a@exemplo.com.br"])).code).toBe("reject");
      expect((await dmarc(undefined, { ...GOOD_ZONE, broken: [`_dmarc.${DOMAIN}`] })).code).toBe("unavailable");
      expect((await dmarc(undefined, { ...GOOD_ZONE, plain: [`_dmarc.${DOMAIN}`] })).code).toBe("unavailable");
      expect((await dmarc(["v=DMARC1; rua=mailto:a@exemplo.com.br"])).code).toBe("invalid");
      expect((await dmarc(["v=DMARC1; p=none; rua=mailto:a@exemplo.com.br;"])).code).toBe("none");
    });

    it("subdomínio sem DMARC próprio herda o do domínio acima, e o painel avisa", async () => {
      const sub = "envio.exemplo.com.br";
      const zone: Zone = { txt: { "_dmarc.exemplo.com.br": ["v=DMARC1; p=none; rua=mailto:a@exemplo.com.br"] } };
      const report = await evaluateHealth(input(zone, { domain: sub, mailHostname: `mail.${sub}`, serverHostname: `mail.${sub}` }));
      expect(report.checks.find((c) => c.id === "dmarc")).toMatchObject({ code: "inherited", level: "warn", params: { parent: "exemplo.com.br" } });
      const none = await evaluateHealth(input({}, { domain: sub, mailHostname: `mail.${sub}`, serverHostname: `mail.${sub}` }));
      expect(none.checks.find((c) => c.id === "dmarc")?.code).toBe("missing");
    });
  });

  describe("PTR", () => {
    it.each([
      ["found", "ok", "ok"],
      ["generic", "warn", "generic"],
      ["mismatch", "warn", "mismatch"],
      ["action_required", "warn", "missing"],
      ["pending", "warn", "unavailable"],
    ] as const)("%s", async (status, level, code) => {
      const check = await checkOf("ptr", GOOD_ZONE, { ptr: { ...PTR_OK, status, found: status === "action_required" ? [] : ["vmi1.contaboserver.net"] } });
      expect(check).toMatchObject({ level, code });
    });
  });

  describe("porta 25, TLS e listas", () => {
    it("porta 25", async () => {
      expect((await checkOf("port25", GOOD_ZONE, { port25: { status: "blocked", detail: "ETIMEDOUT" } })).level).toBe("critical");
      expect((await checkOf("port25", GOOD_ZONE, { port25: { status: "error" } })).level).toBe("warn");
      expect((await checkOf("port25", GOOD_ZONE, { port25: { status: "blocked" } })).params).toEqual({ detail: "" });
      expect((await checkOf("port25", GOOD_ZONE, { port25: { status: "open" } })).params).toEqual({ host: "" });
    });

    it("TLS: servidor parado, inválido, vencendo, vencendo em breve, sem hosts, sem data", async () => {
      expect((await checkOf("tls", GOOD_ZONE, { serverRunning: false })).code).toBe("server_stopped");
      expect(await checkOf("tls", GOOD_ZONE, { tlsHosts: [{ host: HOST, ok: false, validTo: null, error: "expired" }] })).toMatchObject({ code: "invalid", params: { error: "expired" } });
      expect((await checkOf("tls", GOOD_ZONE, { tlsHosts: [{ host: HOST, ok: false, validTo: null, error: null }] })).params.error).toBe("");
      expect((await checkOf("tls", GOOD_ZONE, { tlsHosts: [{ host: HOST, ok: true, validTo: "2026-10-25T00:00:00Z", error: null }] })).code).toBe("expiring");
      expect((await checkOf("tls", GOOD_ZONE, { tlsHosts: [{ host: HOST, ok: true, validTo: "2026-11-01T00:00:00Z", error: null }] })).code).toBe("expiring_soon");
      expect((await checkOf("tls", GOOD_ZONE, { tlsHosts: [] })).code).toBe("no_hosts");
      const two = await checkOf("tls", GOOD_ZONE, {
        tlsHosts: [
          { host: "a.example.com", ok: true, validTo: "2026-12-30T00:00:00Z", error: null },
          { host: "b.example.com", ok: true, validTo: null, error: null },
        ],
      });
      expect(two).toMatchObject({ level: "ok", params: { host: "a.example.com" } });
      const reversed = await checkOf("tls", GOOD_ZONE, {
        tlsHosts: [
          { host: "b.example.com", ok: true, validTo: "2026-12-30T00:00:00Z", error: null },
          { host: "a.example.com", ok: true, validTo: "2026-11-05T00:00:00Z", error: null },
        ],
      });
      expect(reversed.params.host).toBe("a.example.com");
    });

    it("TLS sem validade conhecida não vira 'ok, 90 dias': fica informativo e fora do estado geral", async () => {
      const unknown = await checkOf("tls", GOOD_ZONE, { tlsHosts: [{ host: HOST, ok: true, validTo: null, error: null }] });
      expect(unknown).toMatchObject({ level: "info", code: "expiry_unknown", inbox: false, params: { host: HOST } });
      const garbled = await checkOf("tls", GOOD_ZONE, { tlsHosts: [{ host: HOST, ok: true, validTo: "não é data", error: null }] });
      expect(garbled.code).toBe("expiry_unknown");
    });

    it("lista não consultável (sem chave DQS) não impede o estado geral 'ok'", async () => {
      const unknownOnly: BlacklistCheckResponse = {
        ...CLEAN,
        domains: [{ target: DOMAIN, results: [{ dnsbl: "d", label: "Spamhaus DBL", status: "unknown", detail: null, removalUrl: null }] }],
      };
      const report = await evaluateHealth(input(GOOD_ZONE, { blacklist: unknownOnly }));
      expect(report.checks.find((c) => c.id === "dnsbl")?.level).toBe("info");
      expect(report.counts.warn).toBe(0);
    });

    it("listas de bloqueio: sem dados, listado, não verificado, limpo", async () => {
      expect((await checkOf("dnsbl", GOOD_ZONE, { blacklist: null })).code).toBe("not_checked");
      const bad = (status: "listed" | "unknown"): BlacklistCheckResponse => ({
        ...CLEAN,
        domains: [{ target: DOMAIN, results: [{ dnsbl: "d", label: "Spamhaus DBL", status, detail: null, removalUrl: null }] }],
      });
      expect(await checkOf("dnsbl", GOOD_ZONE, { blacklist: bad("listed") })).toMatchObject({ level: "critical", params: { lists: "Spamhaus DBL" } });
      expect(await checkOf("dnsbl", GOOD_ZONE, { blacklist: bad("unknown") })).toMatchObject({ level: "info", code: "unknown", inbox: false });
      expect((await checkOf("dnsbl")).code).toBe("ok");
      expect((await checkOf("dnsbl", GOOD_ZONE, { blacklist: { ...CLEAN, ip: null } })).code).toBe("ok");
    });
  });

  describe("propagação", () => {
    it("um resolvedor ainda sem o registro: atenção, sem afetar a caixa de entrada", async () => {
      const lagging = resolverOf({ ...GOOD_ZONE, txt: { [DOMAIN]: [`v=spf1 ip4:${IP} -all`] } });
      const resolvers = [
        { label: "1.1.1.1", resolver: resolverOf(GOOD_ZONE) },
        { label: "9.9.9.9", resolver: lagging },
      ];
      const check = await checkOf("propagation", GOOD_ZONE, { resolvers });
      expect(check).toMatchObject({ level: "warn", code: "partial", inbox: false });
      expect(String(check.params.missing)).toContain("DKIM (9.9.9.9)");
      expect(String(check.params.missing)).toContain("DMARC (9.9.9.9)");
    });

    it("resolvedor que não responde não conta como ausência; todos de acordo: ok", async () => {
      const broken = resolverOf({ broken: [DOMAIN, `paas._domainkey.${DOMAIN}`, `_dmarc.${DOMAIN}`] });
      const resolvers = [
        { label: "1.1.1.1", resolver: resolverOf(GOOD_ZONE) },
        { label: "9.9.9.9", resolver: broken },
      ];
      expect((await checkOf("propagation", GOOD_ZONE, { resolvers })).level).toBe("ok");
    });
  });

  describe("MTA-STS e TLS-RPT (opcionais)", () => {
    const STS_HOST = `mta-sts.${DOMAIN}`;
    const ID = mtaStsId(mtaStsPolicy(HOST));
    const SERVED = mtaStsServedPolicy(HOST);
    /** Zona com o TXT _mta-sts (valor dado; null = sem o TXT) e o A de mta-sts.<domínio> (null = sem o registro). */
    function stsZone(opts: { txt?: string | null; a?: string[] | null } = {}): Zone {
      const base = withTxt(`_mta-sts.${DOMAIN}`, opts.txt === null ? undefined : [opts.txt ?? `v=STSv1; id=${ID}`]);
      const a = { ...(base.a ?? {}) };
      if (opts.a !== null) a[STS_HOST] = opts.a ?? [IP];
      return { ...base, a };
    }
    const sts = (policy: string | null, zone: Zone = stsZone(), over: Partial<HealthInput> = {}) =>
      checkOf("mta_sts", zone, { fetchPolicy: async () => policy, ...over });

    it("busca pendurada não trava a verificação inteira: prazo total e item 'inalcançável'", async () => {
      const started = Date.now();
      const report = await evaluateHealth(input(stsZone(), { fetchPolicy: () => new Promise(() => undefined), mtaStsDeadlineMs: 80 }));
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(report.checks.find((c) => c.id === "mta_sts")).toMatchObject({ level: "optional", code: "unreachable", inbox: false });
    });

    it("nada configurado: 'não configurado', opcional, sem pesar em nada", async () => {
      const item = await sts(null, stsZone({ txt: null, a: null }));
      expect(item).toMatchObject({ level: "optional", code: "absent", inbox: false });
      const report = await evaluateHealth(input(stsZone({ txt: null, a: null })));
      expect(report.level).toBe("ok");
      expect(report.counts).toMatchObject({ warn: 0, critical: 0, optional: 1 });
      expect(report.scopes.domain.level).toBe("ok");
      expect(report.inboxIssues).toEqual([]);
    });

    it("falta o A (o TXT existe): mensagem própria com o IP esperado", async () => {
      expect(await sts(null, stsZone({ a: null }))).toMatchObject({ level: "optional", code: "missing_a", expected: IP, params: { host: STS_HOST, ip: IP } });
    });

    it("A aponta para outro IP ou atrás do proxy do Cloudflare", async () => {
      expect(await sts(null, stsZone({ a: ["198.51.100.9"] }))).toMatchObject({ level: "optional", code: "a_mismatch", found: ["198.51.100.9"] });
      expect(await sts(null, stsZone({ a: ["104.16.1.1"] }))).toMatchObject({ level: "optional", code: "a_proxied" });
    });

    it("falta o TXT (o A existe): mensagem própria com o valor esperado", async () => {
      expect(await sts(null, stsZone({ txt: null }))).toMatchObject({
        level: "optional",
        code: "missing_txt",
        expected: `v=STSv1; id=${ID}`,
      });
    });

    it("A e TXT certos, arquivo não abre: certificado sendo emitido, falhou ou arquivo inalcançável", async () => {
      const state = (s: "issuing" | "waiting" | "failed" | "valid" | "unknown") => ({ mtaStsCertState: async () => s });
      expect((await sts(null, stsZone(), state("issuing"))).code).toBe("cert_pending");
      expect((await sts(null, stsZone(), state("waiting"))).code).toBe("cert_pending");
      expect((await sts(null, stsZone(), state("failed"))).code).toBe("cert_failed");
      expect(await sts(null, stsZone(), state("valid"))).toMatchObject({ level: "optional", code: "unreachable" });
      expect((await sts(null, stsZone(), state("unknown"))).code).toBe("unreachable");
      expect((await sts(null, stsZone())).code).toBe("unreachable");
      // não conseguir ler o estado do certificado não derruba o item
      expect((await sts(null, stsZone(), { mtaStsCertState: async () => { throw new Error("x"); } })).code).toBe("unreachable");
    });

    it("política publicada: inválida, de outro host, testing e enforce", async () => {
      // em testing (ou sem modo) política quebrada só relata: continua opcional
      expect(await sts("version: STSv2\nmode: testing\nmx: " + HOST)).toMatchObject({ level: "optional", code: "invalid" });
      expect(await sts("version: STSv2\nmx: " + HOST)).toMatchObject({ level: "optional", code: "invalid" });
      expect(await sts("version: STSv1\nmode: testing\nmx: outro.example.com")).toMatchObject({ level: "optional", code: "mx_mismatch" });
      expect(await sts(SERVED)).toMatchObject({ level: "info", code: "testing" });
      expect(await sts(mtaStsPolicy(HOST))).toMatchObject({ level: "info", code: "testing" });
      // política escrita à mão em outro lugar tem id próprio: não é comparada com o do painel
      const own = stsZone({ txt: "v=STSv1; id=minha" });
      expect(await sts(`version: STSv1\r\nmode: testing\r\nmx: ${HOST}\r\nmax_age: 86400`, own)).toMatchObject({ level: "info", code: "testing" });
      expect(await sts(`version: STSv1\nmode: enforce\nmx: *.${DOMAIN}`, own)).toMatchObject({ level: "ok", code: "enforce" });
      expect((await sts(`version: STSv1\nmx: ${HOST}`, own)).code).toBe("testing");
    });

    it("enforce quebrado deixa de ser opcional: MX fora é crítico (entrega recusada) e política inválida é atenção", async () => {
      const bad = await sts("version: STSv1\nmode: enforce\nmx: outro.example.com");
      expect(bad).toMatchObject({ level: "critical", code: "mx_mismatch", inbox: true });
      const invalid = await sts("version: STSv2\nmode: enforce\nmx: " + HOST);
      expect(invalid).toMatchObject({ level: "warn", code: "invalid", inbox: true });
      const report = await evaluateHealth(input(stsZone(), { fetchPolicy: async () => "version: STSv1\nmode: enforce\nmx: outro.example.com" }));
      expect(report.inboxIssues).toContain("mta_sts");
      expect(report.counts.critical).toBeGreaterThan(0);
    });

    it("o MX real manda: MX no Google com enforce correto é ok; MX real fora da política é crítico (com o nome do MX)", async () => {
      const google = (zone: Zone): Zone => ({ ...zone, mx: { [DOMAIN]: [{ exchange: "aspmx.l.google.example.", priority: 1 }] } });
      const own = (mx: string) => `version: STSv1\nmode: enforce\nmx: ${mx}\nmax_age: 86400`;
      const zone = google(stsZone({ txt: "v=STSv1; id=minha" }));
      // curinga de UM nível casa aspmx.l.google.example
      expect(await sts(own("*.l.google.example"), zone)).toMatchObject({ level: "ok", code: "enforce" });
      // a política fala do host do painel, mas o MX real é outro: crítico, e a mensagem cita o MX real
      const bad = await sts(own(HOST), zone);
      expect(bad).toMatchObject({ level: "critical", code: "mx_mismatch", inbox: true, params: { host: "aspmx.l.google.example" } });
      // curinga não casa dois níveis (RFC 8461)
      expect((await sts(own("*.google.example"), zone)).code).toBe("mx_mismatch");
      // MX no painel e enforce sem o painel: crítico como antes
      expect(await sts(own("outro.example.com"), stsZone({ txt: "v=STSv1; id=minha" }))).toMatchObject({ level: "critical", code: "mx_mismatch", params: { host: HOST } });
      // qualquer MX real fora da política conta (backup)
      const two = { ...stsZone({ txt: "v=STSv1; id=minha" }), mx: { [DOMAIN]: [{ exchange: HOST, priority: 10 }, { exchange: "backup.example.net", priority: 20 }] } };
      expect(await sts(own(HOST), two)).toMatchObject({ level: "critical", params: { host: "backup.example.net" } });
    });

    it("consulta do MX que FALHA (timeout) não compara: nunca crítico; com enforce guardado, no máximo atenção", async () => {
      const own = `version: STSv1\nmode: enforce\nmx: *.l.google.example\nmax_age: 86400`;
      const zone: Zone = { ...stsZone({ txt: "v=STSv1; id=minha" }), broken: [DOMAIN] };
      expect(await sts(own, zone)).toMatchObject({ level: "info", code: "mx_unverified", inbox: false });
      // mesmo uma política que não lista o host do painel não vira crítico quando o MX não pôde ser consultado
      expect(await sts(`version: STSv1\nmode: enforce\nmx: outro.example.net`, zone)).toMatchObject({ level: "info", code: "mx_unverified" });
      expect(await sts(own, zone, { mtaStsLastMode: "enforce" })).toMatchObject({ level: "warn", code: "mx_unverified", inbox: false });
      const report = await evaluateHealth(input(zone, { fetchPolicy: async () => own }));
      expect(report.inboxIssues).not.toContain("mta_sts");
    });

    it("domínio SEM MX: o MX implícito é o próprio domínio (RFC 5321) e é com ele que a política é comparada", async () => {
      const noMx: Zone = { ...stsZone({ txt: "v=STSv1; id=minha" }), mx: {} };
      expect(await sts(`version: STSv1\nmode: enforce\nmx: ${DOMAIN}`, noMx)).toMatchObject({ level: "ok", code: "enforce" });
      expect(await sts(`version: STSv1\nmode: enforce\nmx: ${HOST}`, noMx)).toMatchObject({ level: "critical", code: "mx_mismatch", params: { host: DOMAIN } });
    });

    it("enforce que deixou de abrir: a causa conhecida aparece (em atenção, com o enforce anterior como agravante)", async () => {
      const enforced = { mtaStsLastMode: "enforce" };
      expect(await sts(null, stsZone({ a: null }), enforced)).toMatchObject({ level: "warn", code: "missing_a", params: { wasEnforce: "1" } });
      expect(await sts(null, stsZone({ a: ["104.16.1.1"] }), enforced)).toMatchObject({ level: "warn", code: "a_proxied", params: { wasEnforce: "1" } });
      expect(await sts(null, stsZone(), { ...enforced, mtaStsCertState: async () => "issuing" })).toMatchObject({ level: "warn", code: "cert_pending", params: { wasEnforce: "1" } });
      expect(await sts(null, stsZone(), { ...enforced, mtaStsPublishing: false })).toMatchObject({ level: "warn", code: "publish_unavailable" });
      // sem causa conhecida: o aviso próprio
      expect(await sts(null, stsZone(), enforced)).toMatchObject({ level: "warn", code: "enforce_lapsed" });
    });

    it("MX em outro provedor com a política do painel: 'mx_external' (opcional), sem pedir para trocar o MX da política", async () => {
      const zone: Zone = { ...stsZone(), mx: { [DOMAIN]: [{ exchange: "aspmx.l.google.example", priority: 1 }] } };
      expect(await sts(SERVED, zone)).toMatchObject({ level: "optional", code: "mx_external", params: { host: "aspmx.l.google.example" } });
    });

    it("a política em enforce que deixa de abrir avisa (atenção); em testing continua como antes", async () => {
      expect(await sts(null, stsZone(), { mtaStsLastMode: "enforce" })).toMatchObject({ level: "warn", code: "enforce_lapsed", inbox: false });
      expect(await sts(null, stsZone(), { mtaStsLastMode: "testing" })).toMatchObject({ level: "optional", code: "unreachable" });
      expect(await sts(null, stsZone(), { mtaStsLastMode: null })).toMatchObject({ code: "unreachable" });
    });

    it("com o TXT publicado a política é aberta primeiro: se funciona, o A não é cobrado (hospedada fora do painel)", async () => {
      const own = `version: STSv1\nmode: enforce\nmx: ${HOST}\nmax_age: 86400`;
      // sem A, A em outro IP ou atrás do proxy: a política abre e é válida
      for (const zone of [stsZone({ txt: "v=STSv1; id=minha", a: null }), stsZone({ txt: "v=STSv1; id=minha", a: ["198.51.100.9"] }), stsZone({ txt: "v=STSv1; id=minha", a: ["104.16.1.1"] })]) {
        expect(await sts(own, zone)).toMatchObject({ level: "ok", code: "enforce" });
        expect(await sts(own.replace("enforce", "testing"), zone)).toMatchObject({ level: "info", code: "testing" });
      }
    });

    it("sem o domínio do painel o proxy não publica: mensagem própria, sem mandar criar o A e o TXT", async () => {
      const off = { mtaStsPublishing: false };
      expect(await sts(null, stsZone({ txt: null, a: null }), off)).toMatchObject({ level: "optional", code: "publish_unavailable" });
      expect(await sts(null, stsZone(), off)).toMatchObject({ level: "optional", code: "publish_unavailable" });
      expect(await sts(null, stsZone({ a: null }), off)).toMatchObject({ level: "optional", code: "publish_unavailable" });
      // política de fora que funciona continua valendo mesmo sem publicação do painel
      expect(await sts(SERVED, stsZone(), off)).toMatchObject({ code: "testing" });
    });

    it("a política do painel mudou (MX novo): o id do TXT fica velho e a tela recebe o valor novo", async () => {
      const stale = await sts(SERVED, stsZone({ txt: "v=STSv1; id=antigo" }));
      expect(stale).toMatchObject({ level: "optional", code: "id_outdated", expected: `v=STSv1; id=${ID}`, found: ["v=STSv1; id=antigo"] });
      // TXT sem id também fica velho
      expect((await sts(SERVED, stsZone({ txt: "v=STSv1" }))).code).toBe("id_outdated");
    });

    it("o id do TXT acompanha o texto da política: muda quando o MX muda", () => {
      expect(mtaStsId(mtaStsPolicy(HOST))).not.toBe(mtaStsId(mtaStsPolicy("mail.novo.example.com")));
      expect(mtaStsHostFor(DOMAIN)).toBe(STS_HOST);
      expect(SERVED).toBe(`version: STSv1\nmode: testing\nmx: ${HOST}\nmax_age: 86400\n`);
      expect(SERVED).not.toContain("\r");
    });

    it("TLS-RPT: ok, incompleto (sem rua) e não configurado são opcionais e nunca pesam", async () => {
      expect(await checkOf("tls_rpt", withTxt(`_smtp._tls.${DOMAIN}`, ["v=TLSRPTv1"]))).toMatchObject({ level: "optional", code: "no_rua" });
      expect(await checkOf("tls_rpt", withTxt(`_smtp._tls.${DOMAIN}`, undefined))).toMatchObject({ level: "optional", code: "absent" });
      expect((await checkOf("tls_rpt", { ...GOOD_ZONE, broken: [`_smtp._tls.${DOMAIN}`] })).code).toBe("absent");
      expect((await checkOf("mta_sts", { ...GOOD_ZONE, broken: [`_mta-sts.${DOMAIN}`] })).code).toBe("absent");
      const report = await evaluateHealth(input(withTxt(`_smtp._tls.${DOMAIN}`, ["v=TLSRPTv1"])));
      expect(report.level).toBe("ok");
      expect(report.counts.warn).toBe(0);
    });

    it("DNS do A fora do ar: tratado como sem registro", async () => {
      expect((await sts(null, { ...stsZone(), broken: [STS_HOST] })).code).toBe("missing_a");
    });
  });

  it("opcional e informativo nunca pesam no estado geral", async () => {
    const report = await evaluateHealth(input(GOOD_ZONE, { blacklist: null }));
    expect(report.level).toBe("ok");
    expect(report.counts).toEqual({ ok: report.counts.ok, warn: 0, critical: 0, optional: 1, acknowledged: 0 });
  });

  it("PTR ausente com SPF, DKIM e DMARC passando é atenção forte, nunca crítico (o Gmail aceitou sem ele)", async () => {
    for (const status of ["action_required", "mismatch"] as const) {
      const report = await evaluateHealth(input(GOOD_ZONE, { ptr: { ...PTR_OK, status, found: [] } }));
      expect(report.level).toBe("warn");
      expect(report.counts.critical).toBe(0);
      expect(report.checks.filter((c) => c.level === "critical")).toEqual([]);
      expect(report.checks.find((c) => c.id === "ptr")).toMatchObject({ level: "warn", inbox: true });
    }
  });

  it("porta 25 bloqueada continua crítica (impede o envio de fato)", async () => {
    const report = await evaluateHealth(input(GOOD_ZONE, { port25: { status: "blocked", detail: "ETIMEDOUT" } }));
    expect(report.level).toBe("critical");
    expect(report.scopes.server.level).toBe("critical");
    expect(report.scopes.domain.level).toBe("ok");
  });

  it("separa o resumo em servidor (vale para todos os projetos) e domínio", async () => {
    const report = await evaluateHealth(input(GOOD_ZONE, { ptr: { ...PTR_OK, status: "action_required", found: [] } }));
    expect(report.scopes.server.level).toBe("warn");
    expect(report.scopes.server.counts.warn).toBe(1);
    expect(report.scopes.domain).toEqual({
      level: "ok",
      counts: { ok: report.scopes.domain.counts.ok, warn: 0, critical: 0, optional: 1, acknowledged: 0 },
    });
    const total = report.scopes.server.counts.ok + report.scopes.server.counts.warn + report.scopes.server.counts.critical +
      report.scopes.domain.counts.ok + report.scopes.domain.counts.warn + report.scopes.domain.counts.critical;
    expect(total).toBe(report.counts.ok + report.counts.warn + report.counts.critical);
  });

  it("atenção sem crítico: estado warn", async () => {
    const report = await evaluateHealth(input(GOOD_ZONE, { ptr: { ...PTR_OK, status: "generic" } }));
    expect(report.level).toBe("warn");
    expect(report.inboxIssues).toEqual(["ptr"]);
  });
});

describe("atraso na fila", () => {
  function queued(over: Partial<QueueItemView> = {}): QueueItemView {
    return {
      id: "1",
      from: `postmaster@${DOMAIN}`,
      createdAt: null,
      size: 10,
      recipients: [{ address: "a@gmail.com", domain: "gmail.com", state: "deferred", detail: "x" }],
      attempts: 1,
      nextRetryAt: "2026-10-22T12:02:00.000Z",
      expiresAt: null,
      lastError: "421-4.7.28 Gmail has detected an unusual rate of unsolicited mail",
      ...over,
    };
  }
  const queueCheck = (queue: QueueItemView[] | null) => checkOf("queue", GOOD_ZONE, { queue });

  it("fila vazia: em ordem; fila ilegível: só informação", async () => {
    expect(await queueCheck([])).toMatchObject({ level: "ok", code: "empty", inbox: false });
    expect(await queueCheck(null)).toMatchObject({ level: "info", code: "unavailable" });
  });

  it("só conta mensagens deste domínio e destinatários adiados", async () => {
    const other = queued({ from: "x@outro.example.com" });
    const delivered = queued({ recipients: [{ address: "a@b.c", domain: "b.c", state: "delivered", detail: null }] });
    expect((await queueCheck([other, delivered])).code).toBe("empty");
  });

  it("a fila é do DOMÍNIO: falha de autenticação das mensagens @domínio pesa no domínio, não no servidor", async () => {
    const report = await evaluateHealth(
      input(GOOD_ZONE, { queue: [queued({ lastError: "550 5.7.26 Unauthenticated email is not accepted" })] }),
    );
    expect(report.checks.find((c) => c.id === "queue")).toMatchObject({ level: "critical", code: "deferred_auth" });
    expect(report.scopes.domain.level).toBe("critical");
    expect(report.scopes.domain.counts.critical).toBe(1);
    expect(report.scopes.server.level).toBe("ok");
    expect(report.scopes.server.counts.critical).toBe(0);
  });

  it("mensagens de outro remetente na fila geral não entram no domínio nem no servidor", async () => {
    const report = await evaluateHealth(input(GOOD_ZONE, { queue: [queued({ from: "x@outro.example.com", lastError: "550 5.7.26" })] }));
    expect(report.checks.find((c) => c.id === "queue")).toMatchObject({ level: "ok", code: "empty" });
    expect(report.scopes.domain.counts.critical + report.scopes.server.counts.critical).toBe(0);
  });

  it("adiado por limite de taxa (IP novo): atenção, com tentativas e minutos até a próxima", async () => {
    const check = await queueCheck([queued(), queued({ attempts: 3, nextRetryAt: "2026-10-22T12:10:00.000Z" })]);
    expect(check).toMatchObject({ level: "warn", code: "deferred_rate_limited", inbox: true });
    expect(check.params).toMatchObject({ count: 2, attempts: 3, minutes: 2 });
    expect(String(check.params.reason)).toContain("4.7.28");
  });

  it("muitas tentativas ou IP bloqueado: crítico", async () => {
    expect((await queueCheck([queued({ attempts: 6 })])).level).toBe("critical");
    expect(await queueCheck([queued({ lastError: "550 5.7.1 blocked by Spamhaus" })])).toMatchObject({ level: "critical", code: "deferred_blocked_ip" });
  });

  it("sem próxima tentativa nem motivo", async () => {
    const check = await queueCheck([queued({ nextRetryAt: null, lastError: null })]);
    expect(check).toMatchObject({ code: "deferred_other", params: { minutes: 0, reason: "" } });
  });

  it("a causa mais comum vence", async () => {
    const check = await queueCheck([
      queued({ lastError: "451 4.7.1 greylisted, try later" }),
      queued({ lastError: "451 4.7.1 greylisted" }),
      queued({ lastError: "timeout" }),
    ]);
    expect(check.code).toBe("deferred_greylisted");
  });

  it.each([
    ["451 4.7.1 Greylisted, please try again in 300 seconds", "greylisted"],
    ["421-4.7.28 [203.0.113.10] Our system has detected an unusual rate of unsolicited mail", "rate_limited"],
    ["421 4.7.0 [TSS04] Messages from 203.0.113.10 temporarily deferred due to user complaints", "rate_limited"],
    ["450-4.2.1 The user you are trying to contact is receiving mail at a rate that prevents additional messages", "rate_limited"],
    ["421-4.7.26 This mail is unauthenticated, which poses a security risk to the recipient", "auth"],
    ["550-5.7.26 This message does not pass authentication checks (SPF and DKIM both do not pass)", "auth"],
    ["421-4.7.27 SPF check failed for the sending domain", "auth"],
    ["421-4.7.30 Your message is not aligned with DMARC policy", "auth"],
    ["421-4.7.32 Your email has been rate limited because the From: header is not aligned with either the authenticated SPF or DKIM domain", "auth"],
    ["550 5.7.509 Access denied, sending domain does not pass DMARC verification", "auth"],
    ["550 5.7.1 Service unavailable; Client host blocked using Spamhaus", "blocked_ip"],
    ["550 5.7.1 Unfortunately, messages from [203.0.113.10] weren't sent. S3150", "blocked_ip"],
    ["452 4.2.2 mailbox full", "mailbox"],
    ["no TLS offered by the remote server", "tls"],
    ["failed to lookup mx for example.invalid", "dns"],
    ["connection timed out", "connection"],
    ["Connection refused", "connection"],
    ["algo desconhecido", "other"],
  ] as const)("%s -> %s", (text, cause) => {
    expect(classifyDelay(text)).toBe(cause);
  });

  it("falha de autenticação no texto não é limite de taxa, e limite de taxa continua sendo", () => {
    expect(classifyDelay("421-4.7.28 unusual rate of unsolicited mail; see SPF and DKIM docs")).toBe("rate_limited");
  });

  it("fila: autenticação é crítica já na 1ª tentativa e aponta para SPF/DKIM", async () => {
    const check = await queueCheck([queued({ attempts: 1, lastError: "421-4.7.26 This mail is unauthenticated" })]);
    expect(check).toMatchObject({ code: "deferred_auth", level: "critical", inbox: true });
  });

  it("menção solta a SPF/DKIM/DMARC (num link, num conselho) não vira autenticação", () => {
    expect(classifyDelay("452 4.2.2 mailbox full; see https://example.com/help/dmarc and dkim docs")).toBe("mailbox");
    expect(classifyDelay("451 4.7.1 greylisted; sender policy: spf ok, dkim ok, dmarc ok")).toBe("greylisted");
    expect(classifyDelay("connection timed out (checked spf dkim dmarc already)")).toBe("connection");
    expect(classifyDelay("421 4.7.0 try again later, read about SPF and DKIM at example.com")).toBe("rate_limited");
  });

  it.each([
    "550 5.7.509 Access denied, sending domain does not pass DMARC verification",
    "550 5.7.1 Message failed the SPF check",
    "451 DKIM verification failed for the message",
    "421 message did not pass authentication",
    "550 5.7.26 unauthenticated sender",
    "421-4.7.32 From: header is not aligned with either the authenticated SPF or DKIM domain",
  ])("frase típica de autenticação: %s", (text) => {
    expect(classifyDelay(text)).toBe("auth");
  });

  it("sem texto: other", () => {
    expect(classifyDelay(null)).toBe("other");
  });
});

describe('"ciente" (item que depende do provedor)', () => {
  const PTR_MISSING: PtrCheck = { ip: IP, expected: HOST, status: "action_required", found: [], ticketText: null };
  const ACK_AT = "2026-10-22T10:00:00.000Z";

  async function reportOf(over: Partial<HealthInput> = {}) {
    return evaluateHealth(input(GOOD_ZONE, over));
  }
  /** Marcação feita sobre o item como está agora. */
  function ackOf(report: Awaited<ReturnType<typeof reportOf>>, id: "ptr" | "port25", reason: string | null = "peço ao suporte depois"): StoredAcknowledgement {
    const c = report.checks.find((x) => x.id === id) as MailHealthCheck;
    return { fingerprint: mailHealthFingerprint(c), reason, at: ACK_AT, by: "kelvin" };
  }

  it("PTR marcado: continua visível com o nível, mas não conta, não muda o selo e sai do aviso do topo", async () => {
    const raw = await reportOf({ ptr: PTR_MISSING });
    expect(raw.level).toBe("warn");
    expect(raw.inboxIssues).toEqual(["ptr"]);
    const marked = applyAcknowledgements(raw, { ptr: ackOf(raw, "ptr") });
    const ptr = marked.checks.find((c) => c.id === "ptr")!;
    expect(ptr).toMatchObject({ level: "warn", code: "missing", acknowledged: { reason: "peço ao suporte depois", at: ACK_AT, by: "kelvin" } });
    expect(marked.level).toBe("ok");
    expect(marked.scopes.server.level).toBe("ok");
    expect(marked.counts).toMatchObject({ warn: 0, critical: 0, acknowledged: 1 });
    expect(marked.inboxIssues).toEqual([]);
    // o relatório bruto não foi alterado
    expect(raw.level).toBe("warn");
    expect(raw.checks.find((c) => c.id === "ptr")?.acknowledged).toBeUndefined();
  });

  it("volta a contar sozinho se o PTR passar a apontar para outro nome", async () => {
    const before = await reportOf({ ptr: { ...PTR_MISSING, status: "mismatch", found: ["velho.example.com"] } });
    const ack = ackOf(before, "ptr");
    expect(applyAcknowledgements(before, { ptr: ack }).level).toBe("ok");
    const after = await reportOf({ ptr: { ...PTR_MISSING, status: "mismatch", found: ["outro.example.com"] } });
    const reapplied = applyAcknowledgements(after, { ptr: ack });
    expect(reapplied.level).toBe("warn");
    expect(reapplied.checks.find((c) => c.id === "ptr")?.acknowledged).toBeUndefined();
    expect(reapplied.inboxIssues).toEqual(["ptr"]);
  });

  it("volta a contar se o item mudar de problema ou de gravidade (de atenção para crítico)", async () => {
    const warn = await reportOf({ port25: { status: "error", detail: "x" } });
    // porta 25 "não deu para testar" é atenção sem peso na caixa de entrada; marcada, vira ciente
    const ack = ackOf(warn, "port25");
    expect(applyAcknowledgements(warn, { port25: ack }).counts.acknowledged).toBe(1);
    const critical = await reportOf({ port25: { status: "blocked", detail: "ETIMEDOUT" } });
    const again = applyAcknowledgements(critical, { port25: ack });
    expect(again.level).toBe("critical");
    expect(again.checks.find((c) => c.id === "port25")?.acknowledged).toBeUndefined();
  });

  it("item crítico nunca é silenciado: porta 25 bloqueada ignora a marcação (mesmo forjada)", async () => {
    const critical = await reportOf({ port25: { status: "blocked", detail: "ETIMEDOUT" } });
    const forced = applyAcknowledgements(critical, { port25: ackOf(critical, "port25") });
    expect(forced.checks.find((c) => c.id === "port25")?.acknowledged).toBeUndefined();
    expect(forced.level).toBe("critical");
    expect(forced.inboxIssues).toContain("port25");
  });

  it("a impressão do PTR não depende da ordem dos nomes encontrados", async () => {
    const one = await reportOf({ ptr: { ...PTR_MISSING, status: "mismatch", found: ["a.example.com", "b.example.com"] } });
    const swapped = await reportOf({ ptr: { ...PTR_MISSING, status: "mismatch", found: ["b.example.com", "a.example.com"] } });
    const out = applyAcknowledgements(swapped, { ptr: ackOf(one, "ptr") });
    expect(out.checks.find((c) => c.id === "ptr")?.acknowledged).toBeDefined();
  });

  it("marcação de item que já voltou ao normal não faz nada", async () => {
    const broken = await reportOf({ ptr: PTR_MISSING });
    const ack = ackOf(broken, "ptr");
    const fixed = await reportOf();
    const out = applyAcknowledgements(fixed, { ptr: ack });
    expect(out.checks.find((c) => c.id === "ptr")).toMatchObject({ level: "ok" });
    expect(out.checks.find((c) => c.id === "ptr")?.acknowledged).toBeUndefined();
    expect(out.counts.acknowledged).toBe(0);
  });

  it("só PTR e porta 25 podem ser marcados: marcação de outro item é ignorada", async () => {
    const dkimWarn = await evaluateHealth(input(withTxt(`paas._domainkey.${DOMAIN}`, undefined)));
    const fp = mailHealthFingerprint(dkimWarn.checks.find((c) => c.id === "dkim")!);
    const forged = { dkim: { fingerprint: fp, reason: null, at: ACK_AT, by: null } } as unknown as Parameters<typeof applyAcknowledgements>[1];
    const forced = applyAcknowledgements(dkimWarn, forged);
    expect(forced.checks.find((c) => c.id === "dkim")?.acknowledged).toBeUndefined();
    expect(forced.level).toBe("critical");
  });

  it("resumo: opcional e informativo ficam à parte; ciente não conta como atenção", () => {
    const mk = (over: Partial<MailHealthCheck>): MailHealthCheck => ({ id: "ptr", level: "ok", inbox: false, code: "ok", params: {}, ...over });
    const s = summarizeChecks([
      mk({ level: "ok" }),
      mk({ id: "mta_sts", level: "optional", code: "absent" }),
      mk({ id: "tls_rpt", level: "info" }),
      mk({ level: "warn", acknowledged: { reason: null, at: ACK_AT, by: null } }),
    ]);
    expect(s).toEqual({ level: "ok", counts: { ok: 1, warn: 0, critical: 0, optional: 1, acknowledged: 1 } });
  });
});
