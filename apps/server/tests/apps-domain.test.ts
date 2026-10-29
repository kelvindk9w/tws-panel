/**
 * apps-domain.test.ts — Configurações → Domínio de aplicações (serviço).
 *
 * Sem DNS de verdade: os resolvedores são dublês. O que importa aqui é a regra:
 *  - a base (apps.example.com) é normalizada e recusada se for hostil, IP,
 *    rede interna, serviço sslip, endereço do painel ou nome já em uso;
 *  - a conferência consulta um rótulo ALEATÓRIO sob a base (só um registro
 *    curinga responde), com prazo, IPv4/IPv6 e proxy da Cloudflare = não aponta;
 *  - só salva com o DNS certo; falha não mexe no que estava salvo;
 *  - o endereço automático é <projeto>-<sufixo aleatório>.<base>, único e sem
 *    nada além do nome do projeto;
 *  - restaurar o painel em uma VPS com outro IP deixa a base "a conferir".
 */
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPS_DOMAIN_FILE,
  AppsDomainService,
  normalizeAppsDomainInput,
  type AppsDomainDeps,
} from "../src/services/apps-domain.js";
import type { PanelDomainResolver } from "../src/services/panel-domain.js";

const IP_HOST = "203-0-113-10.sslip.io";
const PANEL = "painel.example.com";
const BASE = "apps.example.com";
const SERVER_IP = "203.0.113.10";
const CTX = { panelHosts: [IP_HOST, PANEL], ipAddress: IP_HOST };

type Answer = string[] | Error | ((name: string) => string[] | Error);

function dnsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** Resolvedor que responde por nome; registra o que foi perguntado. */
function resolver(a: Answer, aaaa: Answer = []): PanelDomainResolver & { asked: string[] } {
  const pick = (v: Answer, name: string) => {
    const r = typeof v === "function" ? v(name) : v;
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  };
  const asked: string[] = [];
  return {
    asked,
    resolve4: vi.fn((name: string) => {
      asked.push(name);
      return pick(a, name);
    }),
    resolve6: vi.fn((name: string) => pick(aaaa, name)),
  };
}

/** Só um registro CURINGA responde para qualquer rótulo; o nome exato da base não é perguntado como "resposta". */
const wildcard = (ip: string) => (name: string) => (name.endsWith(`.${BASE}`) ? [ip] : []);

describe("normalizeAppsDomainInput", () => {
  it("normaliza: minúsculas, espaços, ponto final, https:// e barra final", () => {
    expect(normalizeAppsDomainInput("  Apps.Example.COM. ", CTX)).toEqual({ ok: true, domain: BASE });
    expect(normalizeAppsDomainInput("https://apps.example.com/", CTX)).toEqual({ ok: true, domain: BASE });
    expect(normalizeAppsDomainInput("apps.example.com\n", CTX)).toEqual({ ok: true, domain: BASE });
  });

  it("aceita o curinga digitado de forma óbvia (*.apps.example.com) e guarda só a base", () => {
    expect(normalizeAppsDomainInput("*.apps.example.com", CTX)).toEqual({ ok: true, domain: BASE });
  });

  it("IDN vira punycode e letras de largura total viram ASCII; o resultado sempre passa na regra estrita", () => {
    const idn = normalizeAppsDomainInput("ação.example.com", CTX);
    expect(idn).toEqual({ ok: true, domain: "xn--ao-siap.example.com" });
    expect(normalizeAppsDomainInput("apps.exämple.com", CTX)).toEqual({ ok: true, domain: "apps.xn--exmple-cua.com" });
    expect(normalizeAppsDomainInput("ａｐｐｓ.example.com", CTX)).toEqual({ ok: true, domain: BASE });
  });

  it.each([
    ["", /Informe/],
    ["   ", /Informe/],
    ["example.com", /subdomínio/],
    ["apps", /subdomínio/],
    // injeção no Caddyfile / hostnames hostis
    ["apps.example.com;rm -rf /", /inválido/],
    ["apps.example.com\nrespond 200", /inválido/],
    ["apps.example.com\r\nreverse_proxy x", /inválido/],
    ["apps.example.com {", /inválido/],
    ["apps.example.com }", /inválido/],
    ["{$HOME}.example.com", /inválido/],
    ["apps example.com", /inválido/],
    ["apps.example.com\0", /inválido/],
    ["apps.example.com\t.evil.test", /inválido/],
    ["apps.example.com/caminho", /inválido/],
    ["apps.example.com?x=1", /inválido/],
    ["user@apps.example.com", /inválido/],
    ["apps.example.com#frag", /inválido/],
    ["apps.example.com\\x", /inválido/],
    ["apps.example.com\"", /inválido/],
    ["apps.example.com`", /inválido/],
    ["apps.example.com,evil.com", /inválido/],
    // porta
    ["apps.example.com:8080", /porta/],
    ["https://apps.example.com:443/", /porta/],
    // curingas fora do formato aceito
    ["*apps.example.com", /curinga/],
    ["a*.example.com", /curinga/],
    ["**.apps.example.com", /curinga/],
    ["apps.*.example.com", /curinga/],
    ["*.*.example.com", /curinga/],
    ["*", /curinga/],
    // rótulos
    ["-apps.example.com", /inválido/],
    ["apps-.example.com", /inválido/],
    ["apps..example.com", /inválido/],
    [".apps.example.com", /inválido/],
    ["apps_x.example.com", /inválido/],
    [`${"a".repeat(64)}.example.com`, /inválido/],
    [`${"a".repeat(30)}.${"b".repeat(30)}.${"c".repeat(30)}.${"d".repeat(30)}.${"e".repeat(30)}.${"f".repeat(30)}.${"g".repeat(30)}.com`, /longo/],
    ["xn--.example.com", /inválido/],
    // IP em qualquer forma
    ["203.0.113.10", /IP/],
    ["1.2.3.4.5", /IP|inválido/],
    ["0x7f.0.0.1", /IP|inválido/],
    ["2130706433", /IP|subdomínio/],
    ["[::1]", /IP|inválido/],
    ["::1", /IP|inválido/],
    ["2001:db8::1", /IP|inválido/],
    ["apps.example.123", /IP|inválido/],
    // rede interna, reservados e serviços sslip
    ["apps.localhost", /localhost/],
    ["localhost", /localhost|subdomínio/],
    ["apps.foo.local", /rede interna|reservado/],
    ["apps.foo.internal", /rede interna|reservado/],
    ["apps.foo.lan", /rede interna|reservado/],
    ["apps.foo.home.arpa", /rede interna|reservado/],
    ["apps.foo.localdomain", /rede interna|reservado/],
    ["apps.foo.test", /rede interna|reservado/],
    ["apps.foo.invalid", /rede interna|reservado/],
    ["apps.foo.onion", /rede interna|reservado/],
    ["apps.1.168.192.in-addr.arpa", /rede interna|reservado/],
    ["apps.foo.sslip.io", /sslip/],
    ["apps.nip.io", /sslip|serviço/],
    ["x.y.traefik.me", /serviço|sslip/],
    // painel
    [IP_HOST, /sslip|painel/],
    [PANEL, /painel/],
  ])("recusa %j", (raw, msg) => {
    const r = normalizeAppsDomainInput(raw, CTX);
    expect(r.ok, JSON.stringify(r)).toBe(false);
    if (!r.ok) expect(r.message).toMatch(msg);
  });

  it("a mensagem de recusa nunca devolve o texto bruto com quebra de linha ou chaves (sem eco hostil)", () => {
    const r = normalizeAppsDomainInput("a.example.com\n}\nrespond", CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).not.toMatch(/[\n\r{}]/);
    }
  });

  it("o resultado aceito sempre é um hostname que o Caddyfile aceita", () => {
    const re = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
    for (const raw of ["Apps.Example.com", "*.apps.example.com", "ação.example.com", "a.b.c.d.example.org", "ａｐｐｓ.example.com"]) {
      const r = normalizeAppsDomainInput(raw, CTX);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.domain).toMatch(re);
    }
  });
});

describe("AppsDomainService", () => {
  let dir: string;
  let audit: Array<{ action: string; target?: string | null; detail: string }>;
  let inUse: Set<string>;
  let using: number;
  let counter: number;

  function make(over: Partial<AppsDomainDeps> = {}): AppsDomainService {
    return new AppsDomainService({
      dataDir: dir,
      ipAddress: IP_HOST,
      serverIp: SERVER_IP,
      serverIpv6: null,
      panelHosts: () => [IP_HOST, PANEL],
      domainInUse: async (d) => inUse.has(d),
      countUsingBase: async () => using,
      resolver: resolver(wildcard(SERVER_IP)),
      fallbackResolver: null,
      audit: {
        record: async (e) => {
          audit.push(e);
        },
      },
      // sufixo previsível nos testes (o real vem do crypto)
      randomChars: (n) => String(++counter).padStart(n, "0").slice(-n).replace(/0/g, "a"),
      dnsTimeoutMs: 40,
      now: () => Date.parse("2026-10-21T12:00:00Z"),
      ...over,
    });
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "apps-domain-"));
    audit = [];
    inUse = new Set();
    using = 0;
    counter = 0;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const file = () => path.join(dir, APPS_DOMAIN_FILE);

  describe("status", () => {
    it("sem base: nada configurado, sem registros", async () => {
      const s = await make().status();
      expect(s).toMatchObject({ mode: "https", base: null, verified: false, needsRecheck: false, records: [], example: null, serverIp: SERVER_IP });
    });

    it("modo túnel (sem endereço público): mode=tunnel", async () => {
      const s = await make({ ipAddress: null, serverIp: null }).status();
      expect(s.mode).toBe("tunnel");
    });
  });

  describe("verify", () => {
    it("registro curinga certo: consulta um rótulo aleatório sob a base, salva, audita e mostra os registros", async () => {
      const res = resolver(wildcard(SERVER_IP));
      const svc = make({ resolver: res });
      const r = await svc.verify("Apps.Example.com", "admin");
      expect(r.saved).toBe(true);
      expect(r.check).toMatchObject({ ok: true, problem: "ok", base: BASE, ipv4: [SERVER_IP] });
      expect(r.check.probe).toMatch(/^paas-check-[a-z0-9]+\.apps\.example\.com$/);
      expect(r.check.probe).not.toBe(BASE);
      expect(res.asked).toEqual([r.check.probe]);
      expect(r.status).toMatchObject({
        base: BASE,
        verified: true,
        needsRecheck: false,
        records: [{ type: "A", name: `*.${BASE}`, value: SERVER_IP }],
      });
      expect(r.status.example).toMatch(/\.apps\.example\.com$/);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ action: "apps_domain.set", target: BASE });
      expect(JSON.parse(await readFile(file(), "utf8"))).toMatchObject({ base: BASE, verifiedIp: SERVER_IP });
      expect((await stat(file())).mode & 0o777).toBe(0o600);
    });

    it("cada conferência usa um rótulo diferente (não dá para acertar com um registro só do nome exato)", async () => {
      const res = resolver(wildcard(SERVER_IP));
      const svc = make({ resolver: res, randomChars: undefined });
      const a = (await svc.verify(BASE, "admin")).check.probe;
      const b = (await svc.verify(BASE, "admin")).check.probe;
      expect(a).not.toBe(b);
      expect(a).toMatch(/^paas-check-[a-z0-9]{12,}\./);
    });

    it("só o nome exato tem registro (sem curinga): não aponta e NADA é salvo", async () => {
      const svc = make({ resolver: resolver((name) => (name === BASE ? [SERVER_IP] : [])) });
      const r = await svc.verify(BASE, "admin");
      expect(r.saved).toBe(false);
      expect(r.check).toMatchObject({ ok: false, problem: "missing" });
      expect(r.check.message).toContain(`*.${BASE}`);
      expect(r.check.message).toContain(SERVER_IP);
      await expect(stat(file())).rejects.toThrow();
      expect((await svc.status()).base).toBeNull();
      expect(audit).toHaveLength(0);
    });

    it("NXDOMAIN/NODATA = não existe (missing); proxy da Cloudflare = não aponta e explica a nuvem cinza", async () => {
      const svc = make({ resolver: resolver(dnsError("ENOTFOUND")) });
      expect((await svc.verify(BASE, "a")).check.problem).toBe("missing");
      const cf = make({ resolver: resolver(["104.21.32.1", "172.67.150.2"]) });
      const r = await cf.verify(BASE, "a");
      expect(r.saved).toBe(false);
      expect(r.check.problem).toBe("cloudflare");
      expect(r.check.message).toMatch(/nuvem cinza/);
      expect(r.check.message).toContain(`*.${BASE}`);
    });

    it("IP errado, ou um certo e outro errado: não salva e diz qual apagar", async () => {
      const wrong = await make({ resolver: resolver(["198.51.100.7"]) }).verify(BASE, "a");
      expect(wrong.check).toMatchObject({ ok: false, problem: "wrong_ip" });
      expect(wrong.check.message).toContain(SERVER_IP);
      const mixed = await make({ resolver: resolver([SERVER_IP, "198.51.100.7"]) }).verify(BASE, "a");
      expect(mixed.check.problem).toBe("wrong_ip");
      expect(mixed.saved).toBe(false);
    });

    it("IPv6: AAAA para outro lugar reprova; AAAA igual ao IPv6 informado da VPS é aceito", async () => {
      const bad = await make({ resolver: resolver(wildcard(SERVER_IP), ["2001:db8::99"]) }).verify(BASE, "a");
      expect(bad.check).toMatchObject({ ok: false, problem: "wrong_ipv6" });
      expect(bad.check.message).toContain("2001:db8::99");
      const good = await make({ serverIpv6: "2001:db8::1", resolver: resolver(wildcard(SERVER_IP), ["2001:db8::1"]) }).verify(BASE, "a");
      expect(good.check.ok).toBe(true);
      expect(good.status.records).toEqual([
        { type: "A", name: `*.${BASE}`, value: SERVER_IP },
        { type: "AAAA", name: `*.${BASE}`, value: "2001:db8::1" },
      ]);
    });

    it("IPv6 sem resposta não derruba: segue só com o A", async () => {
      const r = resolver(wildcard(SERVER_IP));
      r.resolve6 = vi.fn(() => Promise.reject(dnsError("ETIMEOUT")));
      const out = await make({ resolver: r }).verify(BASE, "a");
      expect(out.check.ok).toBe(true);
    });

    it("DNS que não responde (erro) → unavailable, nada salvo, sem dizer que 'não aponta'", async () => {
      const out = await make({ resolver: resolver(dnsError("ETIMEOUT")) }).verify(BASE, "a");
      expect(out.saved).toBe(false);
      expect(out.check.problem).toBe("unavailable");
      expect(out.check.message).toMatch(/não respondeu/);
    });

    it("DNS que trava para sempre: o prazo corta e vira unavailable (falha segura)", async () => {
      const hang: PanelDomainResolver = { resolve4: () => new Promise(() => undefined), resolve6: () => new Promise(() => undefined) };
      const t0 = Date.now();
      const out = await make({ resolver: hang, dnsTimeoutMs: 30 }).verify(BASE, "a");
      expect(out.check.problem).toBe("unavailable");
      expect(out.saved).toBe(false);
      expect(Date.now() - t0).toBeLessThan(2000);
    });

    it("usa o DNS do sistema quando o público não responde", async () => {
      const out = await make({ resolver: resolver(dnsError("ETIMEOUT")), fallbackResolver: resolver(wildcard(SERVER_IP)) }).verify(BASE, "a");
      expect(out.check.ok).toBe(true);
    });

    it("sem IP público conhecido (túnel): recusa antes de consultar o DNS", async () => {
      const res = resolver(wildcard(SERVER_IP));
      await expect(make({ ipAddress: null, serverIp: null, resolver: res }).verify(BASE, "a")).rejects.toMatchObject({
        statusCode: 409,
        code: "tunnel_mode",
      });
      expect(res.asked).toEqual([]);
    });

    it("base inválida: 400 sem consultar o DNS; reservada: 400 reserved_domain", async () => {
      const res = resolver(wildcard(SERVER_IP));
      const svc = make({ resolver: res });
      await expect(svc.verify("apps.example.com;x", "a")).rejects.toMatchObject({ statusCode: 400, code: "invalid_domain" });
      await expect(svc.verify("apps.foo.internal", "a")).rejects.toMatchObject({ statusCode: 400, code: "reserved_domain" });
      expect(res.asked).toEqual([]);
    });

    it("colisão: a base não pode ser o domínio do painel, um domínio de projeto, nem o mail.<base> de um domínio de e-mail", async () => {
      const res = resolver(wildcard(SERVER_IP));
      const svc = make({ resolver: res });
      await expect(svc.verify(PANEL, "a")).rejects.toMatchObject({ statusCode: 409, code: "panel_domain" });
      inUse.add("loja.example.com");
      await expect(svc.verify("loja.example.com", "a")).rejects.toMatchObject({ statusCode: 409, code: "domain_in_use" });
      inUse.add("mail.mail-domain.example.com");
      await expect(svc.verify("mail-domain.example.com", "a")).rejects.toMatchObject({ statusCode: 409, code: "domain_in_use" });
      expect(res.asked).toEqual([]);
      await expect(stat(file())).rejects.toThrow();
    });

    it("trocar a base: a antiga some do status, a auditoria cita as duas e os projetos antigos não são tocados", async () => {
      const svc = make({ resolver: resolver((n) => (n.endsWith(".example.com") ? [SERVER_IP] : [])) });
      await svc.verify(BASE, "admin");
      using = 3;
      const r = await svc.verify("sites.example.com", "admin");
      expect(r.status.base).toBe("sites.example.com");
      expect(audit[1]!.detail).toContain(BASE);
      expect(audit[1]!.detail).toContain("sites.example.com");
    });

    it("conferir uma base nova que FALHA não mexe na que já estava salva e verificada", async () => {
      const svc = make({ resolver: resolver((n) => (n.endsWith(`.${BASE}`) ? [SERVER_IP] : [])) });
      await svc.verify(BASE, "admin");
      const bad = await svc.verify("outra.example.com", "admin");
      expect(bad.saved).toBe(false);
      expect(bad.status).toMatchObject({ base: BASE, verified: true });
      expect(await svc.suggest("Meu app")).toMatch(/\.apps\.example\.com$/);
    });

    it("reconferir a base JÁ salva e falhar: a base fica, mas deixa de ser oferecida (needsRecheck)", async () => {
      let ok = true;
      const svc = make({ resolver: resolver((n) => (ok && n.endsWith(`.${BASE}`) ? [SERVER_IP] : [])) });
      await svc.verify(BASE, "admin");
      ok = false;
      const r = await svc.verify(BASE, "admin");
      expect(r.saved).toBe(false);
      expect(r.status).toMatchObject({ base: BASE, verified: false, needsRecheck: true });
      expect(await svc.suggest("Meu app")).toBeNull();
      ok = true;
      const again = await svc.verify(BASE, "admin");
      expect(again.status).toMatchObject({ verified: true, needsRecheck: false });
    });

    it("conferências em paralelo são serializadas (sem arquivo corrompido)", async () => {
      const svc = make();
      await Promise.all([svc.verify(BASE, "a"), svc.verify(BASE, "b"), svc.verify(BASE, "c")]);
      expect(JSON.parse(await readFile(file(), "utf8")).base).toBe(BASE);
    });
  });

  describe("persistência e restauração do painel", () => {
    it("a base verificada volta depois de reiniciar o painel", async () => {
      await make().verify(BASE, "admin");
      const again = make();
      await again.init();
      expect(await again.status()).toMatchObject({ base: BASE, verified: true });
    });

    it("painel restaurado em outra VPS (IP diferente): a base volta, mas 'a conferir' e não é mais oferecida", async () => {
      await make().verify(BASE, "admin");
      const novo = make({ serverIp: "198.51.100.20", ipAddress: "198-51-100-20.sslip.io" });
      await novo.init();
      const s = await novo.status();
      expect(s).toMatchObject({ base: BASE, verified: false, needsRecheck: true, serverIp: "198.51.100.20" });
      expect(s.records[0]).toMatchObject({ value: "198.51.100.20" });
      expect(await novo.suggest("Meu app")).toBeNull();
    });

    it("arquivo com base inválida ou hostil é ignorado (nada configurado)", async () => {
      await writeFile(file(), JSON.stringify({ base: "apps.example.com;rm -rf /", verifiedIp: SERVER_IP }));
      const svc = make();
      await svc.init();
      expect((await svc.status()).base).toBeNull();
      await writeFile(file(), JSON.stringify({ base: PANEL, verifiedIp: SERVER_IP }));
      const svc2 = make();
      await svc2.init();
      expect((await svc2.status()).base).toBeNull();
    });

    it("arquivo com JSON inválido não derruba o painel", async () => {
      await writeFile(file(), "{não é json");
      const svc = make({ log: () => undefined });
      await svc.init();
      expect((await svc.status()).base).toBeNull();
    });
  });

  describe("remove", () => {
    it("remove a base, audita, e o assistente volta ao padrão; o número de projetos que usam a base vem no status", async () => {
      const svc = make();
      await svc.verify(BASE, "admin");
      using = 2;
      expect((await svc.status()).projectsUsingBase).toBe(2);
      const s = await svc.remove("admin");
      expect(s.base).toBeNull();
      expect(audit.at(-1)).toMatchObject({ action: "apps_domain.removed", target: BASE });
      expect(await svc.suggest("x")).toBeNull();
      expect(JSON.parse(await readFile(file(), "utf8")).base).toBeNull();
    });

    it("sem base: 409 no_domain", async () => {
      await expect(make().remove("admin")).rejects.toMatchObject({ statusCode: 409, code: "no_domain" });
    });
  });

  describe("suggest (endereço automático)", () => {
    async function ready(over: Partial<AppsDomainDeps> = {}): Promise<AppsDomainService> {
      const svc = make(over);
      await svc.verify(BASE, "admin");
      counter = 0;
      return svc;
    }

    it("sem base, ou base não verificada: null (o assistente usa o endereço de teste)", async () => {
      expect(await make().suggest("Meu app")).toBeNull();
    });

    it("gera <projeto>-<sufixo>.<base>, em minúsculas e sem acento", async () => {
      const svc = await ready();
      const out = await svc.suggest("Minha Loja Ação");
      expect(out).toMatch(/^minha-loja-acao-[a-z0-9]{5}\.apps\.example\.com$/);
    });

    it("com o gerador real: sufixo de 5 caracteres do alfabeto sem ambíguos, diferente a cada chamada", async () => {
      const svc = make({ randomChars: undefined });
      await svc.verify(BASE, "admin");
      const seen = new Set<string>();
      for (let i = 0; i < 40; i += 1) {
        const out = (await svc.suggest("loja"))!;
        expect(out).toMatch(/^loja-[a-hj-km-np-z2-9]{5}\.apps\.example\.com$/);
        seen.add(out);
      }
      expect(seen.size).toBeGreaterThan(35);
    });

    it("colisão: tenta de novo até achar um nome livre", async () => {
      const svc = await ready();
      const asked: string[] = [];
      inUse = { has: (d: string) => (asked.push(d), asked.length <= 3) } as unknown as Set<string>;
      const out = await svc.suggest("loja");
      expect(asked).toHaveLength(4);
      expect(new Set(asked).size).toBe(4);
      expect(asked.at(-1)).toBe(out);
    });

    it("provisório: <projeto>-<sufixo>.localhost, único e sem pedir certificado público", async () => {
      const svc = await ready();
      const asked: string[] = [];
      inUse = { has: (d: string) => (asked.push(d), asked.length <= 2) } as unknown as Set<string>;
      const out = await svc.suggestProvisional("Minha Loja");
      expect(out).toMatch(/^minha-loja-[a-z0-9]{5}\.localhost$/);
      expect(asked).toHaveLength(3);
      expect(out).not.toMatch(/sslip|\d+\.\d+/);
    });

    it("provisório não depende de base configurada e repetir o mesmo nome dá endereços diferentes", async () => {
      const svc = make({ randomChars: undefined });
      const a = await svc.suggestProvisional("loja");
      const b = await svc.suggestProvisional("loja");
      expect(a).toMatch(/^loja-[a-hj-km-np-z2-9]{5}\.localhost$/);
      expect(a).not.toBe(b);
    });

    it("provisório: tudo ocupado vira erro claro", async () => {
      const svc = make();
      inUse = { has: () => true } as unknown as Set<string>;
      await expect(svc.suggestProvisional("loja")).rejects.toMatchObject({ statusCode: 409, code: "domain_in_use" });
    });

    it("tudo ocupado (improvável): erro claro em vez de repetir um nome em uso", async () => {
      const svc = await ready();
      inUse = { has: () => true } as unknown as Set<string>;
      await expect(svc.suggest("loja")).rejects.toMatchObject({ statusCode: 409, code: "domain_in_use" });
    });

    it.each([
      ["x".repeat(200)],
      ["---"],
      ["???"],
      ["xn--abc"],
      ["Projeto com {chaves} e \n quebra; rm -rf /"],
      ["../../etc/passwd"],
      ["a.b.c"],
      ["UPPER_case Name"],
    ])("nome de projeto %j vira um rótulo DNS válido (≤ 63, sem hífen nas pontas, sem '--', sem xn--)", async (name) => {
      const svc = await ready();
      const out = (await svc.suggest(name))!;
      const label = out.slice(0, out.length - BASE.length - 1);
      expect(out.endsWith(`.${BASE}`)).toBe(true);
      expect(label).toMatch(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/);
      expect(label.length).toBeLessThanOrEqual(63);
      expect(label).not.toContain("--");
      expect(label.startsWith("xn-")).toBe(false);
      expect(out).toMatch(/^[a-z0-9.-]+$/);
    });

    it("não contém IP nem informação da máquina: só o nome do projeto, o sufixo e a base", async () => {
      const svc = await ready();
      const out = (await svc.suggest("Meu blog"))!;
      expect(out).not.toContain("203");
      expect(out).not.toContain("sslip");
      expect(out.endsWith(`.${BASE}`)).toBe(true);
    });
  });
});
