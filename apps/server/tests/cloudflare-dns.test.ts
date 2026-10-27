/**
 * cloudflare-dns.test.ts — integração opcional com a API de DNS da Cloudflare.
 * Só fetch simulado (nenhuma rede). Regras conferidas: token cifrado e nunca devolvido,
 * prévia (criar / já está certo / diferente), nada é trocado sem marcar, SPF nunca
 * duplicado, MX de outro provedor é conflito, nuvem cinza, comentário "tws-panel",
 * 429 com espera, teto por hora e auditoria sem valores secretos.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanInput } from "@paas/mailer";
import { CloudflareDns, mergeSpf, type DesiredRecord } from "../src/services/cloudflare-dns.js";
import { CredentialVault } from "../src/services/credential-vault.js";

const TOKEN = "cf_TOKEN_SEGREDO_abcd1234efgh_WXYZ";
const IP = "203.0.113.10";
const IPV6 = "2001:db8::10";

interface FakeRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
  proxied?: boolean;
  comment?: string | null;
}

/** Cloudflare de mentira: zonas e registros em memória, com falhas programáveis. */
class FakeCloudflare {
  zones = [{ id: "z1", name: "example.com" }];
  records: FakeRecord[] = [];
  calls: Array<{ method: string; url: string; body: unknown; auth: string | null }> = [];
  verifyStatus = 200;
  zonesStatus = 200;
  tokenStatus = "active";
  failWrites: { status: number; message: string } | null = null;
  tooMany = 0;
  retryAfter: string | null = "3";
  private n = 0;

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = init?.headers as Record<string, string> | undefined;
    this.calls.push({ method, url, body, auth: headers?.Authorization ?? null });
    const ok = (result: unknown, extra: Record<string, unknown> = {}) =>
      new Response(JSON.stringify({ success: true, result, ...extra }), { status: 200 });
    const fail = (status: number, message: string) =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 1, message }] }), { status });
    if (this.tooMany > 0) {
      this.tooMany -= 1;
      return new Response("{}", { status: 429, headers: this.retryAfter ? { "retry-after": this.retryAfter } : {} });
    }
    const path = url.replace("https://api.cloudflare.com/client/v4", "");
    if (path === "/user/tokens/verify") {
      return this.verifyStatus === 200 ? ok({ status: this.tokenStatus }) : fail(this.verifyStatus, "x");
    }
    if (path.startsWith("/zones?")) {
      return this.zonesStatus === 200 ? ok(this.zones, { result_info: { total_pages: 1 } }) : fail(this.zonesStatus, "x");
    }
    let m = /^\/zones\/([^/]+)\/dns_records\?name=([^&]+)/.exec(path);
    if (m) return ok(this.records.filter((r) => r.name === decodeURIComponent(m![2]!)));
    if (method === "POST" && /^\/zones\/[^/]+\/dns_records$/.test(path)) {
      if (this.failWrites) return fail(this.failWrites.status, this.failWrites.message);
      const rec = { id: `r${(this.n += 1)}`, ...(body as object) } as FakeRecord;
      this.records.push(rec);
      return ok(rec);
    }
    m = /^\/zones\/[^/]+\/dns_records\/([^/]+)$/.exec(path);
    if (method === "PATCH" && m) {
      if (this.failWrites) return fail(this.failWrites.status, this.failWrites.message);
      const rec = this.records.find((r) => r.id === m![1]);
      if (!rec) return fail(404, "não existe");
      Object.assign(rec, body);
      return ok(rec);
    }
    return fail(404, "rota desconhecida");
  };

  writes() {
    return this.calls.filter((c) => c.method !== "GET");
  }
}

let dir: string;
let cf: FakeCloudflare;
let vault: CredentialVault;
let audits: Array<{ action: string; target?: string | null; detail: string; actor?: string }>;
let sleeps: number[];
let nowMs: number;
let svc: CloudflareDns;
const made: CloudflareDns[] = [];

const PLAN: PlanInput = {
  domain: "example.com",
  mailHostname: "mail.example.com",
  serverHostname: "mail.example.com",
  serverIp: IP,
  dkimSelector: "mail",
  dkimPublicKey: "MIIBIjANBgkq",
  dmarcStage: "none",
};

function make(opts: { hourlyLimit?: number; ipv6?: string | null; ip?: string | null } = {}): CloudflareDns {
  const s = new CloudflareDns({
    dataDir: dir,
    vault,
    serverIp: () => (opts.ip === undefined ? IP : opts.ip),
    serverIpv6: () => opts.ipv6 ?? null,
    audit: { record: async (e) => void audits.push(e) },
    fetchImpl: cf.fetch as unknown as typeof fetch,
    sleep: async (ms) => void sleeps.push(ms),
    now: () => nowMs,
    ...(opts.hourlyLimit ? { hourlyLimit: opts.hourlyLimit } : {}),
  });
  s.setMailPlanInput(async (domain) => ({ ...PLAN, domain }));
  made.push(s);
  return s;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-cf-"));
  cf = new FakeCloudflare();
  vault = new CredentialVault(dir);
  audits = [];
  sleeps = [];
  nowMs = 1_000_000;
  svc = make();
});

afterEach(async () => {
  await Promise.all(made.splice(0).map((m) => m.flush()));
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** O que a interface manda: os itens marcados com o status e a impressão digital da prévia. */
async function selection(service: CloudflareDns, desired: DesiredRecord[], ids: string[]) {
  const plan = await service.plan(desired);
  return plan.items.filter((i) => ids.includes(i.id)).map(({ id, status, fingerprint }) => ({ id, status, fingerprint }));
}
async function go(service: CloudflareDns, desired: DesiredRecord[], ids: string[], label: string, actor?: string) {
  return service.apply(desired, await selection(service, desired, ids), label, actor);
}

const find = (plan: Awaited<ReturnType<CloudflareDns["plan"]>>, id: string) => plan.items.find((i) => i.id === id)!;

describe("conexão", () => {
  it("valida o token, lista as zonas e guarda cifrado; só os 4 últimos caracteres voltam", async () => {
    const res = await svc.connect(`  ${TOKEN}  `);
    expect(res).toMatchObject({ connected: true, hint: "WXYZ", zones: ["example.com"] });
    expect(JSON.stringify(res)).not.toContain(TOKEN);
    expect(cf.calls[0]!.url).toContain("/user/tokens/verify");
    expect(cf.calls[0]!.auth).toBe(`Bearer ${TOKEN}`);
    const cofre = await readFile(path.join(dir, "credentials.json"), "utf8");
    expect(cofre).not.toContain(TOKEN);
    expect(JSON.stringify(await svc.status())).not.toContain(TOKEN);
    expect(await svc.zoneNames()).toEqual(["example.com"]);
  });

  it("recusa token vazio e a Global API Key (37 hexadecimais), sem chamar a Cloudflare", async () => {
    await expect(svc.connect("   ")).rejects.toMatchObject({ code: "invalid_cloudflare_token" });
    await expect(svc.connect("0123456789abcdef0123456789abcdef01234")).rejects.toMatchObject({ code: "cloudflare_global_key" });
    expect(cf.calls).toHaveLength(0);
    expect((await svc.status()).connected).toBe(false);
  });

  it("token inativo é recusado e nada é guardado", async () => {
    cf.tokenStatus = "expired";
    await expect(svc.connect(TOKEN)).rejects.toMatchObject({ code: "invalid_cloudflare_token" });
    expect((await svc.status()).connected).toBe(false);
  });

  it("token de conta (verify recusa, mas lista zonas) é aceito; token inválido nos dois caminhos é recusado", async () => {
    cf.verifyStatus = 403;
    expect((await svc.connect(TOKEN)).zones).toEqual(["example.com"]);
    cf.zones = [];
    await svc.disconnect();
    await expect(svc.connect(TOKEN)).rejects.toMatchObject({ code: "invalid_cloudflare_token" });
    cf.zonesStatus = 401;
    await expect(svc.connect(TOKEN)).rejects.toMatchObject({ code: "invalid_cloudflare_token" });
  });

  it("token válido sem nenhuma zona é guardado, com a lista vazia (a tela avisa)", async () => {
    cf.zones = [];
    expect((await svc.connect(TOKEN)).zones).toEqual([]);
  });

  it("Cloudflare fora do ar vira 502 amigável; erro com mensagem sai na resposta", async () => {
    const down = new CloudflareDns({
      dataDir: dir,
      vault,
      serverIp: () => IP,
      serverIpv6: () => null,
      audit: { record: async () => undefined },
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    await expect(down.connect(TOKEN)).rejects.toMatchObject({ statusCode: 502, code: "cloudflare_unreachable" });
    cf.verifyStatus = 500;
    await expect(svc.connect(TOKEN)).rejects.toMatchObject({ statusCode: 502, code: "cloudflare_error" });
  });

  it("desconectar remove o token", async () => {
    await svc.connect(TOKEN);
    expect(await svc.disconnect()).toBe(true);
    expect((await svc.status()).connected).toBe(false);
    await expect(svc.plan([])).rejects.toMatchObject({ code: "cloudflare_not_connected" });
  });

  it("as zonas ficam em cache e a lista é refeita quando vence", async () => {
    await svc.connect(TOKEN);
    const before = cf.calls.length;
    await svc.zoneNames();
    expect(cf.calls.length).toBe(before);
    nowMs += 6 * 60_000;
    await svc.zoneNames();
    expect(cf.calls.length).toBe(before + 1);
  });

  it("sem conexão, as zonas pedem para conectar", async () => {
    await expect(svc.zoneNames()).rejects.toMatchObject({ statusCode: 409, code: "cloudflare_not_connected" });
  });
});

describe("registros desejados", () => {
  it("e-mail: A, MX, SPF, DKIM, DMARC, TLS-RPT e MTA-STS (A e TXT), com opcionais marcados", async () => {
    const d = await svc.desiredForMail("Example.com.");
    expect(d.map((r) => r.id)).toEqual(["a", "mx", "spf", "dkim", "dmarc", "tls_rpt", "mta_sts_a", "mta_sts"]);
    expect(d.find((r) => r.id === "mx")).toMatchObject({ content: "mail.example.com", priority: 10, optional: false });
    expect(d.find((r) => r.id === "mta_sts")!.content).toMatch(/^v=STSv1; id=/);
    expect(d.filter((r) => r.optional).map((r) => r.id)).toEqual(["tls_rpt", "mta_sts_a", "mta_sts"]);
  });

  it("e-mail sem o plugin de e-mail avisa", async () => {
    const bare = new CloudflareDns({ dataDir: dir, vault, serverIp: () => IP, serverIpv6: () => null, audit: { record: async () => undefined } });
    await expect(bare.desiredForMail("example.com")).rejects.toMatchObject({ code: "mail_unavailable" });
  });

  it("nomes: A (e AAAA com IPv6), sem repetir, validando o formato e o IP", async () => {
    const v6 = make({ ipv6: IPV6 });
    expect(v6.desiredForHosts(["App.Example.com", "app.example.com", "*.apps.example.com"]).map((r) => r.id)).toEqual([
      "A:app.example.com",
      "AAAA:app.example.com",
      "A:*.apps.example.com",
      "AAAA:*.apps.example.com",
    ]);
    expect(svc.desiredForHosts(["a.example.com"])).toHaveLength(1);
    expect(() => svc.desiredForHosts([])).toThrow(/1 a 10/);
    expect(() => svc.desiredForHosts(Array.from({ length: 11 }, (_, i) => `h${i}.example.com`))).toThrow(/1 a 10/);
    expect(() => svc.desiredForHosts(["não é domínio"])).toThrow(/válido/);
    expect(() => make({ ip: null }).desiredForHosts(["a.example.com"])).toThrow(/IP público/);
  });

  it("desired() escolhe pelo escopo", async () => {
    expect((await svc.desired({ kind: "hosts", hosts: ["a.example.com"] })).map((r) => r.id)).toEqual(["A:a.example.com"]);
    expect((await svc.desired({ kind: "mail", domain: "example.com" })).length).toBeGreaterThan(5);
  });
});

describe("prévia", () => {
  beforeEach(async () => {
    await svc.connect(TOKEN);
  });

  it("zona vazia: tudo é 'criar', marcado por padrão, e nada é escrito", async () => {
    const plan = await svc.plan(await svc.desiredForMail("example.com"));
    expect(plan.noZoneCount).toBe(0);
    expect(plan.items.every((i) => i.status === "create" && i.defaultSelected && i.selectable)).toBe(true);
    expect(cf.writes().filter((c) => !c.url.includes("/user/") )).toHaveLength(0);
  });

  it("nome fora das zonas do token: no_zone, não selecionável", async () => {
    const plan = await svc.plan([{ id: "x", type: "A", name: "app.outro.org", content: IP, optional: false }]);
    expect(plan.noZoneCount).toBe(1);
    expect(plan.items[0]).toMatchObject({ status: "no_zone", selectable: false, defaultSelected: false });
  });

  it("registro certo é 'ok'; TXT com aspas e em pedaços também", async () => {
    cf.records.push(
      { id: "a1", type: "A", name: "mail.example.com", content: IP, proxied: false },
      { id: "m1", type: "MX", name: "example.com", content: "mail.example.com", priority: 10 },
      { id: "t1", type: "TXT", name: "example.com", content: `"v=spf1 ip4:${IP}" " ~all"` },
    );
    const plan = await svc.plan(await svc.desiredForMail("example.com"));
    expect(find(plan, "a").status).toBe("ok");
    expect(find(plan, "mx").status).toBe("ok");
    expect(find(plan, "spf").status).toBe("ok");
    expect(find(plan, "spf").selectable).toBe(false);
  });

  it("A com outro IP: 'differs' (não vem marcado, é de terceiros); A em laranja com o IP certo também", async () => {
    cf.records.push({ id: "a1", type: "A", name: "mail.example.com", content: "198.51.100.7", proxied: false });
    cf.records.push({ id: "a2", type: "A", name: "www.example.com", content: IP, proxied: true });
    const plan = await svc.plan([
      { id: "a", type: "A", name: "mail.example.com", content: IP, optional: false },
      { id: "w", type: "A", name: "www.example.com", content: IP, optional: false },
    ]);
    expect(find(plan, "a")).toMatchObject({ status: "differs", current: ["198.51.100.7"], proposed: IP, defaultSelected: false, ours: false });
    expect(find(plan, "w")).toMatchObject({ status: "differs", reason: "proxied", defaultSelected: false });
  });

  it("vários A diferentes no nome: conflito; CNAME no nome: conflito", async () => {
    cf.records.push(
      { id: "a1", type: "A", name: "mail.example.com", content: "198.51.100.7" },
      { id: "a2", type: "A", name: "mail.example.com", content: "198.51.100.8" },
      { id: "c1", type: "CNAME", name: "x.example.com", content: "alvo.example.net" },
    );
    const plan = await svc.plan([
      { id: "a", type: "A", name: "mail.example.com", content: IP, optional: false },
      { id: "x", type: "A", name: "x.example.com", content: IP, optional: false },
    ]);
    expect(find(plan, "a")).toMatchObject({ status: "conflict", reason: "multiple" });
    expect(find(plan, "x")).toMatchObject({ status: "conflict", reason: "cname", selectable: false });
  });

  it("MX de outro provedor é conflito, nunca troca", async () => {
    cf.records.push({ id: "m1", type: "MX", name: "example.com", content: "aspmx.l.example.net", priority: 1 });
    const plan = await svc.plan(await svc.desiredForMail("example.com"));
    expect(find(plan, "mx")).toMatchObject({ status: "conflict", reason: "other_mx", selectable: false, current: ["1 aspmx.l.example.net"] });
  });

  it("MX do próprio painel com outra prioridade pode ser trocado (marcado)", async () => {
    cf.records.push({ id: "m1", type: "MX", name: "example.com", content: "mail.example.com", priority: 5, comment: "tws-panel" });
    const plan = await svc.plan(await svc.desiredForMail("example.com"));
    expect(find(plan, "mx")).toMatchObject({ status: "differs", ours: true, defaultSelected: true });
  });

  it("SPF de terceiros: propõe a fusão (nunca um segundo SPF), sem vir marcado", async () => {
    cf.records.push({ id: "t1", type: "TXT", name: "example.com", content: '"v=spf1 include:_spf.example.net ~all"' });
    const plan = await svc.plan(await svc.desiredForMail("example.com"));
    expect(find(plan, "spf")).toMatchObject({
      status: "merge",
      proposed: `v=spf1 include:_spf.example.net ip4:${IP} ~all`,
      defaultSelected: false,
      selectable: true,
    });
  });

  it("SPF que já autoriza o IP é 'ok'; com redirect ou duplicado é conflito", async () => {
    cf.records.push({ id: "t1", type: "TXT", name: "example.com", content: `v=spf1 ip4:${IP} include:_spf.example.net -all` });
    expect(find(await svc.plan(await svc.desiredForMail("example.com")), "spf")).toMatchObject({ status: "ok", reason: "spf_covers" });
    cf.records.length = 0;
    cf.records.push({ id: "t2", type: "TXT", name: "example.com", content: "v=spf1 redirect=_spf.example.net" });
    expect(find(await svc.plan(await svc.desiredForMail("example.com")), "spf")).toMatchObject({ status: "conflict", reason: "spf_redirect" });
    cf.records.push({ id: "t3", type: "TXT", name: "example.com", content: "v=spf1 -all" });
    expect(find(await svc.plan(await svc.desiredForMail("example.com")), "spf")).toMatchObject({ status: "conflict", reason: "spf_multiple" });
  });

  it("outros TXT do mesmo nome (verificação de site) não são tocados", async () => {
    cf.records.push({ id: "t1", type: "TXT", name: "example.com", content: "google-site-verification=abc" });
    const plan = await svc.plan(await svc.desiredForMail("example.com"));
    expect(find(plan, "spf").status).toBe("create");
  });

  it("DMARC e MTA-STS desatualizados: 'differs'; do painel vêm marcados; DMARC duplicado é conflito", async () => {
    cf.records.push(
      { id: "d1", type: "TXT", name: "_dmarc.example.com", content: "v=DMARC1; p=reject" },
      { id: "s1", type: "TXT", name: "_mta-sts.example.com", content: "v=STSv1; id=antigo", comment: "tws-panel" },
    );
    let plan = await svc.plan(await svc.desiredForMail("example.com"));
    expect(find(plan, "dmarc")).toMatchObject({ status: "differs", defaultSelected: false });
    expect(find(plan, "mta_sts")).toMatchObject({ status: "differs", ours: true, defaultSelected: true });
    cf.records.push({ id: "d2", type: "TXT", name: "_dmarc.example.com", content: "v=DMARC1; p=none" });
    plan = await svc.plan(await svc.desiredForMail("example.com"));
    expect(find(plan, "dmarc")).toMatchObject({ status: "conflict", reason: "multiple" });
  });

  it("mergeSpf: antes do all; sem all vai ao fim; já presente não duplica; redirect não funde", () => {
    expect(mergeSpf("v=spf1 mx -all", "203.0.113.1")).toBe("v=spf1 mx ip4:203.0.113.1 -all");
    expect(mergeSpf('"v=spf1 mx"', "203.0.113.1")).toBe("v=spf1 mx ip4:203.0.113.1");
    expect(mergeSpf("v=spf1 ip4:203.0.113.1 ~all", "203.0.113.1")).toBe("v=spf1 ip4:203.0.113.1 ~all");
    expect(mergeSpf("v=spf1 redirect=x.example.net", "203.0.113.1")).toBeNull();
  });
});

describe("aplicação", () => {
  beforeEach(async () => {
    await svc.connect(TOKEN);
  });

  it("cria os marcados com nuvem cinza e comentário, guarda os ids e audita sem segredo", async () => {
    const desired = await svc.desiredForMail("example.com");
    const res = await go(svc, desired, desired.map((d) => d.id), "example.com", "kelvin");
    expect(res).toMatchObject({ created: 8, updated: 0, skipped: 0, failed: 0 });
    const posts = cf.writes();
    expect(posts).toHaveLength(8);
    expect(posts.every((p) => (p.body as { comment: string }).comment === "tws-panel")).toBe(true);
    expect(posts.find((p) => (p.body as { type: string }).type === "A" && (p.body as { name: string }).name === "mail.example.com")!.body).toMatchObject({ proxied: false, ttl: 1 });
    expect(posts.find((p) => (p.body as { type: string }).type === "MX")!.body).toMatchObject({ content: "mail.example.com", priority: 10 });
    expect(posts.every((p) => !("proxied" in (p.body as object)) || (p.body as { proxied: boolean }).proxied === false)).toBe(true);
    const store = JSON.parse(await readFile(path.join(dir, "cloudflare-dns.json"), "utf8")) as { records: unknown[] };
    expect(store.records).toHaveLength(8);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "cloudflare.dns_applied", target: "example.com", actor: "kelvin" });
    expect(audits[0]!.detail).toContain("8 registro(s) criado(s)");
    expect(JSON.stringify(audits)).not.toContain(TOKEN);
    expect(JSON.stringify(audits)).not.toContain("MIIBIjANBgkq");
    // de novo: tudo já está certo, nada é escrito
    cf.calls.length = 0;
    const again = await svc.plan(await svc.desiredForMail("example.com"));
    expect(again.items.every((i) => i.status === "ok")).toBe(true);
  });

  it("não marcado não é tocado: só o que a pessoa escolheu é escrito", async () => {
    const desired = await svc.desiredForMail("example.com");
    const res = await go(svc, desired, ["a", "mx", "inexistente"], "example.com");
    expect(res.created).toBe(2);
    expect(cf.records.map((r) => r.type).sort()).toEqual(["A", "MX"]);
  });

  it("registro diferente só é trocado se marcado; a troca preserva o comentário da pessoa", async () => {
    cf.records.push({ id: "a1", type: "A", name: "mail.example.com", content: "198.51.100.7", proxied: true, comment: "meu" });
    const desired: DesiredRecord[] = [{ id: "a", type: "A", name: "mail.example.com", content: IP, optional: false }];
    const none = await go(svc, desired, [], "x");
    expect(none).toMatchObject({ created: 0, updated: 0 });
    expect(cf.records[0]!.content).toBe("198.51.100.7");
    const res = await go(svc, desired, ["a"], "x");
    expect(res).toMatchObject({ updated: 1 });
    expect(cf.records[0]).toMatchObject({ content: IP, proxied: false, comment: "meu" });
    expect(cf.calls.some((c) => c.method === "PATCH")).toBe(true);
  });

  it("SPF: a fusão atualiza o registro existente (nunca cria um segundo)", async () => {
    cf.records.push({ id: "t1", type: "TXT", name: "example.com", content: "v=spf1 include:_spf.example.net ~all" });
    const desired = await svc.desiredForMail("example.com");
    await go(svc, desired, ["spf"], "example.com");
    const spf = cf.records.filter((r) => r.type === "TXT" && r.content.startsWith("v=spf1"));
    expect(spf).toHaveLength(1);
    expect(spf[0]!.content).toBe(`v=spf1 include:_spf.example.net ip4:${IP} ~all`);
  });

  it("itens que não podem ser aplicados (conflito, ok, sem zona) saem como ignorados e nada é escrito", async () => {
    cf.records.push({ id: "m1", type: "MX", name: "example.com", content: "aspmx.example.net", priority: 1 });
    const desired: DesiredRecord[] = [
      { id: "mx", type: "MX", name: "example.com", content: "mail.example.com", priority: 10, optional: false },
      { id: "z", type: "A", name: "a.outro.org", content: IP, optional: false },
    ];
    const res = await go(svc, desired, ["mx", "z"], "x");
    expect(res).toMatchObject({ created: 0, skipped: 2 });
    expect(cf.writes()).toHaveLength(0);
    expect(cf.records[0]!.content).toBe("aspmx.example.net");
  });

  it("falha de um item não impede os outros; a mensagem da Cloudflare chega", async () => {
    const desired: DesiredRecord[] = [
      { id: "a", type: "A", name: "mail.example.com", content: IP, optional: false },
      { id: "b", type: "A", name: "b.example.com", content: IP, optional: false },
    ];
    cf.failWrites = { status: 400, message: "Record already exists" };
    const res = await go(svc, desired, ["a", "b"], "x");
    expect(res.failed).toBe(2);
    expect(res.results[0]!.message).toContain("Record already exists");
  });

  it("permissão negada interrompe o resto com a mesma mensagem", async () => {
    const desired: DesiredRecord[] = [
      { id: "a", type: "A", name: "a.example.com", content: IP, optional: false },
      { id: "b", type: "A", name: "b.example.com", content: IP, optional: false },
    ];
    cf.failWrites = { status: 403, message: "Authentication error" };
    const res = await go(svc, desired, ["a", "b"], "x");
    expect(res.failed).toBe(2);
    expect(res.results[1]!.message).toContain("Zone → DNS → Edit");
    expect(cf.writes()).toHaveLength(1);
  });

  it("duas aplicações seguidas não se atropelam (fila)", async () => {
    const desired: DesiredRecord[] = [{ id: "a", type: "A", name: "a.example.com", content: IP, optional: false }];
    const [r1, r2] = await Promise.all([go(svc, desired, ["a"], "x"), go(svc, desired, ["a"], "x")]);
    expect(r1.created + r2.created).toBe(1);
    expect(cf.records).toHaveLength(1);
  });
});

describe("limites de chamadas", () => {
  it("429 espera o Retry-After e repete; sem o cabeçalho espera 2 s", async () => {
    await svc.connect(TOKEN);
    cf.tooMany = 1;
    await svc.plan([{ id: "a", type: "A", name: "a.example.com", content: IP, optional: false }]);
    expect(sleeps).toEqual([3000]);
    cf.tooMany = 1;
    cf.retryAfter = null;
    nowMs += 6 * 60_000;
    await svc.plan([{ id: "a", type: "A", name: "a.example.com", content: IP, optional: false }]);
    expect(sleeps).toEqual([3000, 2000]);
  });

  it("429 insistente desiste com mensagem clara", async () => {
    cf.tooMany = 5;
    await expect(svc.connect(TOKEN)).rejects.toMatchObject({ statusCode: 429, code: "cloudflare_rate_limited" });
    expect(sleeps).toHaveLength(2);
  });

  it("a espera do Retry-After tem teto de 30 s", async () => {
    cf.tooMany = 1;
    cf.retryAfter = "600";
    await svc.connect(TOKEN);
    expect(sleeps).toEqual([30_000]);
  });

  it("teto próprio por hora: passa do limite recusa e volta depois de uma hora", async () => {
    const limited = make({ hourlyLimit: 2 });
    await limited.connect(TOKEN);
    const one: DesiredRecord[] = [{ id: "a", type: "A", name: "a.example.com", content: IP, optional: false }];
    await expect(limited.plan(one)).rejects.toMatchObject({ statusCode: 429, code: "cloudflare_hourly_limit" });
    expect((await limited.status()).callsLastHour).toBe(2);
    nowMs += 3_600_001;
    expect((await limited.status()).callsLastHour).toBe(0);
    expect((await limited.plan(one)).items[0]!.status).toBe("create");
  });

  it("estourar o teto no meio da aplicação interrompe e relata", async () => {
    await svc.connect(TOKEN);
    const limited = make({ hourlyLimit: 6 });
    await limited.zoneNames();
    const desired = await limited.desiredForHosts(["a.example.com", "b.example.com", "c.example.com"]);
    const res = await limited.apply(desired, await selection(svc, desired, desired.map((d) => d.id)), "x");
    expect(res.created).toBeLessThan(3);
    expect(res.failed).toBeGreaterThan(0);
  });
});
