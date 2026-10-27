/**
 * cloudflare-dns-regressao.test.ts — defeitos achados na revisão adversarial da integração com a Cloudflare:
 * SPF fundido nunca vira "do painel" para ser trocado inteiro, o que a pessoa viu na prévia é o que vale
 * na aplicação (se o DNS mudou, nada é escrito), arquivo de estado inválido, paginação, grafias do SPF,
 * AAAA antigo, token mal formatado, teto por hora persistido e conferência de permissão do token.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  tokenId: string | null = null;
  policies: unknown = undefined;
  pagedZones: Array<{ id: string; name: string }> | null = null;
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
      return this.verifyStatus === 200 ? ok({ status: this.tokenStatus, ...(this.tokenId ? { id: this.tokenId } : {}) }) : fail(this.verifyStatus, "x");
    }
    if (this.tokenId && path === `/user/tokens/${this.tokenId}`) {
      return this.policies === undefined ? fail(403, "sem acesso") : ok({ policies: this.policies });
    }
    const paged = /^\/zones\?per_page=50&page=(\d+)/.exec(path);
    if (paged && this.pagedZones) {
      const page = Number(paged[1]);
      return ok(this.pagedZones.slice((page - 1) * 50, page * 50), { result_info: { total_pages: Math.ceil(this.pagedZones.length / 50) } });
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
  await rm(dir, { recursive: true, force: true });
});

const find = (plan: Awaited<ReturnType<CloudflareDns["plan"]>>, id: string) => plan.items.find((i) => i.id === id)!;


const desiredMail = (service: CloudflareDns) => service.desired({ kind: "mail", domain: "example.com" });
const pick = async (service: CloudflareDns, desired: DesiredRecord[], ids: string[]) => {
  const plan = await service.plan(desired);
  return plan.items.filter((i) => ids.includes(i.id)).map(({ id, status, fingerprint }) => ({ id, status, fingerprint }));
};

describe("B1: SPF fundido continua sendo do dono", () => {
  it("depois de fundir, a nova prévia não propõe sobrescrever; os includes e o comentário da pessoa ficam", async () => {
    await svc.connect(TOKEN);
    cf.records.push({ id: "spfX", type: "TXT", name: "example.com", content: "v=spf1 include:_spf.mail-provider.test ~all", comment: "spf do provedor" });
    const d = await desiredMail(svc);
    expect(find(await svc.plan(d), "spf").status).toBe("merge");
    await svc.apply(d, await pick(svc, d, ["spf"]), "example.com");
    const merged = cf.records.find((r) => r.id === "spfX")!;
    expect(merged.content).toBe(`v=spf1 include:_spf.mail-provider.test ip4:${IP} ~all`);
    expect(merged.comment).toBe("spf do provedor");
    const storeText = await readFile(path.join(dir, "cloudflare-dns.json"), "utf8").catch(() => '{"records":[]}');
    expect(storeText).not.toContain("spfX");

    const again = await svc.plan(d);
    expect(find(again, "spf")).toMatchObject({ status: "ok", defaultSelected: false });
    // mesmo que o "all" mude, continua sendo fusão (nunca 'differs' pré-marcado)
    cf.records.find((r) => r.id === "spfX")!.content = "v=spf1 include:_spf.mail-provider.test -all";
    const changed = find(await svc.plan(d), "spf");
    expect(changed.status).toBe("merge");
    expect(changed.defaultSelected).toBe(false);
    expect(changed.proposed).toContain("include:_spf.mail-provider.test");
  });

  it("SPF simples criado pelo painel, com outro IP, é trocado inteiro (pré-marcado); com includes extras vira fusão mesmo sendo dele", async () => {
    await svc.connect(TOKEN);
    cf.records.push({ id: "s1", type: "TXT", name: "example.com", content: "v=spf1 ip4:198.51.100.9 ~all", comment: "tws-panel" });
    const d = await desiredMail(svc);
    expect(find(await svc.plan(d), "spf")).toMatchObject({ status: "differs", ours: true, defaultSelected: true });
    cf.records[0]!.content = "v=spf1 include:extra.test ip4:198.51.100.9 ~all";
    expect(find(await svc.plan(d), "spf")).toMatchObject({ status: "merge", defaultSelected: false });
  });

  it("trocar um A alheio (marcado) também preserva o comentário da pessoa e não o torna 'do painel'", async () => {
    await svc.connect(TOKEN);
    cf.records.push({ id: "a1", type: "A", name: "app.example.com", content: "198.51.100.7", comment: "do cliente" });
    const d = svc.desiredForHosts(["app.example.com"]);
    await svc.apply(d, await pick(svc, d, ["A:app.example.com"]), "x");
    expect(cf.records[0]).toMatchObject({ content: IP, comment: "do cliente" });
    expect(find(await svc.plan(d), "A:app.example.com")).toMatchObject({ status: "ok" });
  });
});

describe("B2/B3: o que a pessoa viu é o que vale", () => {
  it("prévia 'criar', depois surge um A alheio: a aplicação ignora com 'changed' e não escreve", async () => {
    await svc.connect(TOKEN);
    const d = svc.desiredForHosts(["app.example.com"]);
    const seen = await pick(svc, d, ["A:app.example.com"]);
    expect(seen[0]!.status).toBe("create");
    cf.records.push({ id: "alheio", type: "A", name: "app.example.com", content: "198.51.100.7", comment: "do cliente" });
    const r = await svc.apply(d, seen, "x");
    expect(r.results[0]).toMatchObject({ outcome: "skipped", reason: "changed" });
    expect(cf.writes()).toHaveLength(0);
    expect(cf.records[0]).toMatchObject({ content: "198.51.100.7", comment: "do cliente" });
  });

  it("prévia 'criar' do SPF, depois surge um SPF: não funde sem confirmação", async () => {
    await svc.connect(TOKEN);
    const d = await desiredMail(svc);
    const seen = await pick(svc, d, ["spf"]);
    cf.records.push({ id: "spfY", type: "TXT", name: "example.com", content: "v=spf1 include:x.test -all" });
    const r = await svc.apply(d, seen, "x");
    expect(r.results[0]).toMatchObject({ outcome: "skipped", reason: "changed" });
    expect(cf.writes()).toHaveLength(0);
    expect(cf.records[0]!.content).toBe("v=spf1 include:x.test -all");
  });

  it("prévia 'diferente' do registro X, o registro muda de valor ou é trocado por outro: ignora", async () => {
    await svc.connect(TOKEN);
    cf.records.push({ id: "a1", type: "A", name: "app.example.com", content: "198.51.100.7" });
    const d = svc.desiredForHosts(["app.example.com"]);
    const seen = await pick(svc, d, ["A:app.example.com"]);
    cf.records[0]!.content = "198.51.100.8";
    expect((await svc.apply(d, seen, "x")).results[0]).toMatchObject({ outcome: "skipped", reason: "changed" });
    cf.records.splice(0, 1, { id: "a2", type: "A", name: "app.example.com", content: "198.51.100.7" });
    expect((await svc.apply(d, seen, "x")).results[0]).toMatchObject({ outcome: "skipped", reason: "changed" });
    expect(cf.writes()).toHaveLength(0);
  });

  it("com a prévia intacta aplica normalmente; impressão digital inventada não escreve", async () => {
    await svc.connect(TOKEN);
    const d = svc.desiredForHosts(["app.example.com"]);
    const forged = [{ id: "A:app.example.com", status: "create" as const, fingerprint: "0000000000000000" }];
    expect((await svc.apply(d, forged, "x")).skipped).toBe(1);
    expect((await svc.apply(d, await pick(svc, d, ["A:app.example.com"]), "x")).created).toBe(1);
  });

  it("item que a prévia mostrou como conflito, mesmo marcado, não é escrito (not_applicable)", async () => {
    await svc.connect(TOKEN);
    cf.records.push({ id: "m1", type: "MX", name: "example.com", content: "aspmx.example.net", priority: 1 });
    const d = await desiredMail(svc);
    const r = await svc.apply(d, await pick(svc, d, ["mx"]), "x");
    expect(r.results[0]).toMatchObject({ outcome: "skipped", reason: "not_applicable" });
    expect(cf.writes()).toHaveLength(0);
  });
});

describe("menores", () => {
  it("arquivo de estado com elementos inválidos não derruba a prévia nem a aplicação", async () => {
    await svc.connect(TOKEN);
    await writeFile(path.join(dir, "cloudflare-dns.json"), JSON.stringify({ records: [null, 3, { id: 5 }, { id: "ok1", zoneId: "z1", type: "A", name: "x", at: "t" }] }));
    const d = svc.desiredForHosts(["app.example.com"]);
    expect((await svc.plan(d)).items[0]!.status).toBe("create");
    expect((await svc.apply(d, await pick(svc, d, ["A:app.example.com"]), "x")).created).toBe(1);
    await writeFile(path.join(dir, "cloudflare-dns.json"), "isto não é json");
    expect((await svc.plan(d)).items[0]!.status).toBe("ok");
  });

  it("zonas em várias páginas: usa o total da própria resposta, mesmo com outra chamada em paralelo", async () => {
    await svc.connect(TOKEN);
    cf.pagedZones = Array.from({ length: 120 }, (_, i) => ({ id: `z${i}`, name: `zone${i}.test` }));
    cf.pagedZones[119] = { id: "zlast", name: "example.com" };
    const fresh = make();
    const [names] = await Promise.all([fresh.connect(TOKEN), fresh.status()]);
    expect(names.zones).toHaveLength(120);
    expect(names.zones).toContain("example.com");
  });

  it("mergeSpf reconhece +ip4, /32 e ip6 equivalentes; faixa maior segue como fusão", () => {
    expect(mergeSpf(`v=spf1 +ip4:${IP} -all`, IP)).toBe(`v=spf1 +ip4:${IP} -all`);
    expect(mergeSpf(`v=spf1 ip4:${IP}/32 -all`, IP)).toBe(`v=spf1 ip4:${IP}/32 -all`);
    expect(mergeSpf(`v=spf1 ip6:${IPV6}/128 -all`, IPV6)).toBe(`v=spf1 ip6:${IPV6}/128 -all`);
    expect(mergeSpf("v=spf1 -all", IPV6)).toBe(`v=spf1 ip6:${IPV6} -all`);
    expect(mergeSpf("v=spf1 ip4:203.0.113.0/24 -all", IP)).toBe(`v=spf1 ip4:203.0.113.0/24 ip4:${IP} -all`);
  });

  it("SPF que já autoriza o IP em outra grafia é 'ok' (spf_covers)", async () => {
    await svc.connect(TOKEN);
    cf.records.push({ id: "t1", type: "TXT", name: "example.com", content: `v=spf1 ip4:${IP}/32 include:x.test -all` });
    expect(find(await svc.plan(await desiredMail(svc)), "spf")).toMatchObject({ status: "ok", reason: "spf_covers" });
  });

  it("AAAA alheio sem IPv6 na VPS aparece como conflito (não é ignorado); com IPv6 vira diferença normal", async () => {
    await svc.connect(TOKEN);
    cf.records.push({ id: "v6", type: "AAAA", name: "app.example.com", content: "2001:db8::99" });
    const p = await svc.plan(svc.desiredForHosts(["app.example.com"]));
    expect(p.items.map((i) => `${i.type}:${i.status}`)).toEqual(["A:create", "AAAA:conflict"]);
    expect(p.items[1]).toMatchObject({ reason: "stale_aaaa", selectable: false, current: ["2001:db8::99"] });
    const withV6 = await make({ ipv6: IPV6 }).plan(make({ ipv6: IPV6 }).desiredForHosts(["app.example.com"]));
    expect(withV6.items.map((i) => `${i.type}:${i.status}`)).toEqual(["A:create", "AAAA:differs"]);
  });

  it("token mal formatado (400) ou recusado (401) é 'token inválido', não erro genérico", async () => {
    cf.verifyStatus = 400;
    await expect(svc.connect(TOKEN)).rejects.toMatchObject({ statusCode: 400, code: "invalid_cloudflare_token" });
    cf.verifyStatus = 401;
    cf.zonesStatus = 401;
    await expect(svc.connect(TOKEN)).rejects.toMatchObject({ statusCode: 400, code: "invalid_cloudflare_token" });
  });

  it("o teto por hora sobrevive a reiniciar o painel (arquivo em data/)", async () => {
    const first = make({ hourlyLimit: 4 });
    await first.connect(TOKEN);
    await first.flush();
    const reborn = make({ hourlyLimit: 4 });
    expect((await reborn.status()).callsLastHour).toBe(2);
    await reborn.zoneNames();
    await expect(reborn.plan([{ id: "a", type: "A", name: "a.example.com", content: IP, optional: false }, { id: "b", type: "A", name: "b.example.com", content: IP, optional: false }, { id: "c", type: "A", name: "c.example.com", content: IP, optional: false }])).rejects.toMatchObject({ code: "cloudflare_hourly_limit" });
    nowMs += 3_600_001;
    expect((await make({ hourlyLimit: 4 }).status()).callsLastHour).toBe(0);
  });

  it("arquivo de chamadas ilegível não impede nada", async () => {
    await writeFile(path.join(dir, "cloudflare-calls.json"), "lixo");
    expect((await make().status()).callsLastHour).toBe(0);
  });

  it("token ativo sem Zone → Zone → Read: mensagem específica de permissão (não 'token inválido')", async () => {
    cf.zonesStatus = 403;
    await expect(svc.connect(TOKEN)).rejects.toMatchObject({ statusCode: 400, code: "cloudflare_no_zone_read" });
    expect((await svc.status()).connected).toBe(false);
  });

  it("AAAA já correto (IPv6 da VPS) em nome sem AAAA no plano não gera aviso; AAAA de outro endereço gera o aviso certo", async () => {
    const v6 = make({ ipv6: IPV6 });
    await v6.connect(TOKEN);
    cf.records.push({ id: "v6", type: "AAAA", name: "mta-sts.example.com", content: IPV6 });
    const d = await v6.desired({ kind: "mail", domain: "example.com" });
    expect((await v6.plan(d)).items.filter((i) => i.reason === "stale_aaaa" || i.reason === "other_aaaa")).toEqual([]);
    cf.records[0]!.content = "2001:db8::99";
    const warned = (await v6.plan(d)).items.filter((i) => i.type === "AAAA" && i.status === "conflict");
    expect(warned.map((i) => [i.name, i.reason, i.current])).toEqual([["mta-sts.example.com", "other_aaaa", ["2001:db8::99"]]]);
  });

  it("o histórico de chamadas é gravado em grupo (atraso curto) e na hora com flush", async () => {
    const first = make();
    await first.connect(TOKEN);
    await first.zoneNames();
    const file = path.join(dir, "cloudflare-calls.json");
    expect(await readFile(file, "utf8").catch(() => null)).toBeNull();
    await first.flush();
    expect(JSON.parse(await readFile(file, "utf8")).calls).toHaveLength(2);
    await first.flush();
    await expect(make().status()).resolves.toMatchObject({ callsLastHour: 2 });
  });

  it("erro 500 na listagem de zonas aparece como erro da Cloudflare (não como token inválido)", async () => {
    cf.zonesStatus = 500;
    await expect(svc.connect(TOKEN)).rejects.toMatchObject({ statusCode: 502, code: "cloudflare_error" });
  });

  it("resposta que não é JSON (página de erro do proxy) vira erro da Cloudflare, sem quebrar", async () => {
    const odd = new CloudflareDns({
      dataDir: dir,
      vault,
      serverIp: () => IP,
      serverIpv6: () => null,
      audit: { record: async () => undefined },
      fetchImpl: (async () => new Response("<html>bad gateway</html>", { status: 502 })) as unknown as typeof fetch,
    });
    made.push(odd);
    await expect(odd.connect(TOKEN)).rejects.toMatchObject({ code: "cloudflare_error" });
  });

  it("sem dependências injetadas usa fetch, espera e relógio reais (429 curto e depois sucesso)", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async (input: string) => {
      n += 1;
      if (n === 1) return new Response("{}", { status: 429, headers: { "retry-after": "0.01" } });
      return new Response(JSON.stringify({ success: true, result: { status: "active" } }), { status: 200 });
    });
    try {
      const plain = new CloudflareDns({ dataDir: dir, vault, serverIp: () => IP, serverIpv6: () => null, audit: { record: async () => undefined } });
      made.push(plain);
      // verify responde; a listagem de zonas usa o mesmo fetch e devolve a mesma resposta (sem lista)
      await expect(plain.connect(TOKEN)).rejects.toBeTruthy();
      expect(n).toBeGreaterThanOrEqual(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
