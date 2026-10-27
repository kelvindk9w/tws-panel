/**
 * cloudflare-dns.ts — integração OPCIONAL com a API de DNS da Cloudflare.
 *
 * Com a conta conectada, o painel cria sozinho os registros que hoje a pessoa
 * cria à mão (e-mail: MX, SPF, DKIM, DMARC, MTA-STS, TLS-RPT; domínios: A/AAAA
 * para a VPS). Regras inegociáveis:
 *  - o token (API Token com Zone → DNS → Edit e Zone → Zone → Read) fica no cofre
 *    cifrado das credenciais; nunca volta pela API, pelo log ou pela auditoria;
 *  - NUNCA apaga nem sobrescreve registro sem a pessoa marcar aquele item numa
 *    prévia (criar / já está certo / diferente); registro de outro provedor de
 *    e-mail (MX) é conflito, e um segundo SPF nunca é criado (propõe-se a fusão);
 *  - tudo sai com `proxied: false` (nuvem cinza) e `comment: "tws-panel"`; os ids
 *    criados ficam em data/cloudflare-dns.json;
 *  - respeita o 429 da Cloudflare (espera o Retry-After) e tem teto próprio por hora.
 *
 * Os registros desejados vêm de quem chama (plano de e-mail ou A/AAAA de nomes);
 * este serviço só compara com a zona e aplica.
 */
import path from "node:path";
import { CLOUDFLARE_RECORD_COMMENT } from "@paas/core";
import type {
  CloudflareApplyResponse,
  CloudflareApplyResult,
  CloudflareConnectResponse,
  CloudflareDnsScope,
  CloudflareItemStatus,
  CloudflarePlanItem,
  CloudflarePlanResponse,
  CloudflareRecordType,
  CloudflareStatus,
} from "@paas/core";
import { buildDnsPlan, type PlanInput } from "@paas/mailer";
import type { CredentialVault } from "./credential-vault.js";
import { httpError } from "./http-error.js";
import { JsonFile } from "./json-file.js";

const API = "https://api.cloudflare.com/client/v4";
const VAULT_KEY = "integration:cloudflare";
/** Teto próprio de chamadas por hora (a Cloudflare permite bem mais; isto protege contra laço). */
export const CLOUDFLARE_HOURLY_LIMIT = 600;
const HOUR_MS = 3_600_000;
const ZONES_TTL_MS = 5 * 60_000;
const MAX_ZONE_PAGES = 10;
const MAX_RETRIES_429 = 2;
const MAX_WAIT_MS = 30_000;
const MAX_HOSTS = 10;

/** Uma Global API Key (37 hexadecimais): perigosa demais, o painel não a aceita. */
const GLOBAL_KEY = /^[0-9a-f]{37}$/i;
const HOST_RE = /^(\*\.)?([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z0-9-]{2,63}$/;

/** Um registro que o painel quer ter no DNS. */
export interface DesiredRecord {
  id: string;
  type: CloudflareRecordType;
  name: string;
  /** MX: o servidor de e-mail (sem a prioridade). */
  content: string;
  priority?: number;
  optional: boolean;
}

interface CfRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
  proxied?: boolean;
  comment?: string | null;
}

interface CfZone {
  id: string;
  name: string;
}

interface StoredRecord {
  id: string;
  zoneId: string;
  type: string;
  name: string;
  at: string;
}

interface Store {
  records: StoredRecord[];
}

export interface CloudflareDnsDeps {
  dataDir: string;
  vault: CredentialVault;
  serverIp: () => string | null;
  serverIpv6: () => string | null;
  audit: { record(input: { actor?: string; action: string; target?: string | null; detail: string }): Promise<unknown> };
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  hourlyLimit?: number;
  log?: (message: string) => void;
}

/** Minúsculas e sem ponto final. */
function norm(name: string): string {
  return name.trim().toLowerCase().replace(/\.+$/, "");
}

/** TXT da Cloudflare pode vir entre aspas e/ou em pedaços de 255: junta tudo. */
function txtValue(content: string): string {
  return content.replace(/"\s+"/g, "").replace(/^"/, "").replace(/"$/, "").trim();
}

/** Fusão do SPF: acrescenta o IP antes do `all` final. null = não dá para fundir com segurança. */
export function mergeSpf(existing: string, ip4: string): string | null {
  const tokens = txtValue(existing).split(/\s+/).filter(Boolean);
  if (tokens.some((t) => /^redirect=/i.test(t))) return null;
  const mechanism = `ip4:${ip4}`;
  if (tokens.some((t) => t.toLowerCase() === mechanism)) return tokens.join(" ");
  const allAt = tokens.findIndex((t) => /^[+\-~?]?all$/i.test(t));
  if (allAt === -1) tokens.push(mechanism);
  else tokens.splice(allAt, 0, mechanism);
  return tokens.join(" ");
}

function mxText(r: DesiredRecord): string {
  return `${r.priority ?? 10} ${r.content}`;
}

export class CloudflareDns {
  private readonly store: JsonFile<Store>;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly hourlyLimit: number;
  private calls: number[] = [];
  private zonesCache: { at: number; zones: CfZone[] } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private mailPlanInput: ((domain: string) => Promise<PlanInput>) | null = null;

  constructor(private readonly deps: CloudflareDnsDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? Date.now;
    this.hourlyLimit = deps.hourlyLimit ?? CLOUDFLARE_HOURLY_LIMIT;
    this.store = new JsonFile<Store>(path.join(deps.dataDir, "cloudflare-dns.json"), {
      empty: () => ({ records: [] }),
      parse: (raw) => {
        const records = (raw as Partial<Store> | null)?.records;
        return Array.isArray(records) ? { records } : null;
      },
    });
  }

  /** O plugin de e-mail (onde mora o MailService) entrega aqui a leitura do cadastro do domínio. */
  setMailPlanInput(fn: (domain: string) => Promise<PlanInput>): void {
    this.mailPlanInput = fn;
  }

  // ---------------------------------------------------------------------------
  // Conexão
  // ---------------------------------------------------------------------------

  private callsLastHour(): number {
    const cutoff = this.now() - HOUR_MS;
    this.calls = this.calls.filter((t) => t > cutoff);
    return this.calls.length;
  }

  async status(): Promise<CloudflareStatus> {
    const info = await this.deps.vault.info(VAULT_KEY);
    return {
      connected: info.configured,
      hint: info.hint,
      updatedAt: info.updatedAt,
      callsLastHour: this.callsLastHour(),
      hourlyLimit: this.hourlyLimit,
    };
  }

  private async token(): Promise<string> {
    const credential = await this.deps.vault.get(VAULT_KEY);
    if (!credential) {
      throw httpError(409, "cloudflare_not_connected", "Conecte a Cloudflare em Configurações → Integrações.");
    }
    return credential.token;
  }

  /** Confere o token na Cloudflare, lista as zonas que ele alcança e guarda (cifrado). */
  async connect(rawToken: string): Promise<CloudflareConnectResponse> {
    const token = rawToken.trim();
    if (!token) throw httpError(400, "invalid_cloudflare_token", "Cole o API Token da Cloudflare.");
    if (GLOBAL_KEY.test(token)) {
      throw httpError(
        400,
        "cloudflare_global_key",
        "Isto parece a Global API Key, que dá acesso a TODA a conta e não é aceita. Crie um API Token só com Zone → DNS → Edit e Zone → Zone → Read.",
      );
    }
    let verified = false;
    try {
      const result = await this.request<{ status?: string }>("GET", "/user/tokens/verify", undefined, token);
      if (result.status && result.status !== "active") {
        throw httpError(400, "invalid_cloudflare_token", "A Cloudflare diz que este token não está ativo (expirou ou foi desativado).");
      }
      verified = true;
    } catch (err) {
      const code = (err as { code?: string }).code;
      // Token de conta (account-owned) não passa por /user/tokens/verify: a listagem de zonas decide.
      if (code !== "cloudflare_token_rejected") throw err;
    }
    const zones = await this.fetchZones(token);
    if (!verified && zones.length === 0) {
      throw httpError(400, "invalid_cloudflare_token", "A Cloudflare recusou o token: confira se copiou inteiro e se ele não expirou.");
    }
    await this.deps.vault.set(VAULT_KEY, { username: "cloudflare", token });
    this.zonesCache = { at: this.now(), zones };
    return { ...(await this.status()), zones: zones.map((z) => z.name).sort() };
  }

  async disconnect(): Promise<boolean> {
    this.zonesCache = null;
    return this.deps.vault.remove(VAULT_KEY);
  }

  async zoneNames(): Promise<string[]> {
    return (await this.zones()).map((z) => z.name).sort();
  }

  // ---------------------------------------------------------------------------
  // Chamadas à API (teto por hora, 429 com espera)
  // ---------------------------------------------------------------------------

  private async request<T>(method: string, route: string, body: unknown, token: string): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      if (this.callsLastHour() >= this.hourlyLimit) {
        throw httpError(
          429,
          "cloudflare_hourly_limit",
          `O painel já fez ${this.hourlyLimit} chamadas à Cloudflare na última hora (teto de segurança). Tente de novo mais tarde.`,
        );
      }
      this.calls.push(this.now());
      let res: Response;
      try {
        res = await this.fetchImpl(`${API}${route}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": "tws-panel",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        throw httpError(502, "cloudflare_unreachable", "Não foi possível falar com a Cloudflare agora. Tente de novo em instantes.");
      }
      if (res.status === 429) {
        if (attempt >= MAX_RETRIES_429) {
          throw httpError(429, "cloudflare_rate_limited", "A Cloudflare pediu para diminuir o ritmo. Tente de novo em alguns instantes.");
        }
        const retry = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(retry) && retry > 0 ? retry * 1000 : 2_000;
        await this.sleep(Math.min(wait, MAX_WAIT_MS));
        continue;
      }
      let payload: { success?: boolean; result?: T; errors?: Array<{ code?: number; message?: string }>; result_info?: { total_pages?: number } } | null;
      try {
        payload = (await res.json()) as typeof payload;
      } catch {
        payload = null;
      }
      if (res.ok && payload?.success !== false) {
        this.lastTotalPages = payload?.result_info?.total_pages ?? 1;
        return payload?.result as T;
      }
      if (res.status === 401 || res.status === 403) {
        // Nunca 401/403 para a interface: ela leria "a sessão do painel acabou".
        throw httpError(
          409,
          "cloudflare_token_rejected",
          "A Cloudflare recusou o token ou ele não tem permissão para isso. Confira se tem Zone → DNS → Edit e Zone → Zone → Read nas zonas desejadas.",
        );
      }
      const first = payload?.errors?.[0];
      throw httpError(502, "cloudflare_error", `A Cloudflare respondeu com erro${first?.message ? `: ${first.message}` : ` ${res.status}`}.`);
    }
  }

  private lastTotalPages = 1;

  private async fetchZones(token: string): Promise<CfZone[]> {
    const zones: CfZone[] = [];
    for (let page = 1; page <= MAX_ZONE_PAGES; page += 1) {
      const batch = await this.request<CfZone[]>("GET", `/zones?per_page=50&page=${page}`, undefined, token);
      zones.push(...batch.map((z) => ({ id: z.id, name: norm(z.name) })));
      if (page >= this.lastTotalPages) break;
    }
    return zones;
  }

  private async zones(): Promise<CfZone[]> {
    if (this.zonesCache && this.now() - this.zonesCache.at < ZONES_TTL_MS) return this.zonesCache.zones;
    const zones = await this.fetchZones(await this.token());
    this.zonesCache = { at: this.now(), zones };
    return zones;
  }

  /** A zona mais específica que contém o nome, ou null. */
  private zoneFor(zones: CfZone[], name: string): CfZone | null {
    const host = norm(name).replace(/^\*\./, "");
    let best: CfZone | null = null;
    for (const z of zones) {
      if ((host === z.name || host.endsWith(`.${z.name}`)) && (!best || z.name.length > best.name.length)) best = z;
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // Registros desejados
  // ---------------------------------------------------------------------------

  /** Todos os registros de e-mail do domínio (plano de entregabilidade), sem o PTR. */
  async desiredForMail(domain: string): Promise<DesiredRecord[]> {
    if (!this.mailPlanInput) throw httpError(409, "mail_unavailable", "O servidor de e-mail não está disponível neste painel.");
    const plan = buildDnsPlan(await this.mailPlanInput(norm(domain)));
    return plan.records.map((r) => ({
      id: r.id,
      type: r.type as CloudflareRecordType,
      name: norm(r.name),
      content: r.value,
      ...(r.priority !== undefined ? { priority: r.priority } : {}),
      optional: r.need === "optional",
    }));
  }

  /** A (e AAAA, se a VPS tem IPv6) de cada nome apontando para a VPS. */
  desiredForHosts(rawHosts: string[]): DesiredRecord[] {
    const hosts = [...new Set(rawHosts.map(norm))].filter(Boolean);
    if (hosts.length === 0 || hosts.length > MAX_HOSTS) {
      throw httpError(400, "invalid_hosts", `Informe de 1 a ${MAX_HOSTS} nomes.`);
    }
    for (const host of hosts) {
      if (host.length > 253 || !HOST_RE.test(host)) throw httpError(400, "invalid_hosts", `"${host}" não é um nome de domínio válido.`);
    }
    const ip = this.deps.serverIp();
    if (!ip) {
      throw httpError(409, "public_ip_unknown", "O painel não sabe o IP público desta VPS; crie os registros à mão.");
    }
    const ipv6 = this.deps.serverIpv6();
    const out: DesiredRecord[] = [];
    for (const host of hosts) {
      out.push({ id: `A:${host}`, type: "A", name: host, content: ip, optional: false });
      if (ipv6) out.push({ id: `AAAA:${host}`, type: "AAAA", name: host, content: ipv6, optional: false });
    }
    return out;
  }

  async desired(scope: CloudflareDnsScope): Promise<DesiredRecord[]> {
    return scope.kind === "mail" ? this.desiredForMail(scope.domain) : this.desiredForHosts(scope.hosts);
  }

  // ---------------------------------------------------------------------------
  // Prévia
  // ---------------------------------------------------------------------------

  private async existing(zoneId: string, name: string, token: string): Promise<CfRecord[]> {
    return this.request<CfRecord[]>("GET", `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}&per_page=100`, undefined, token);
  }

  private classify(
    d: DesiredRecord,
    found: CfRecord[],
    ours: (r: CfRecord) => boolean,
  ): { status: CloudflareItemStatus; current: string[]; reason: string | null; target: CfRecord | null; proposed: string } {
    const proposed = d.type === "MX" ? mxText(d) : d.content;
    const result = (status: CloudflareItemStatus, current: string[], reason: string | null = null, target: CfRecord | null = null, value = proposed) => ({
      status,
      current,
      reason,
      target,
      proposed: value,
    });
    const sameType = found.filter((r) => r.type === d.type);
    const currentOf = (list: CfRecord[]) =>
      list.map((r) => (d.type === "MX" ? `${r.priority ?? ""} ${norm(r.content)}`.trim() : d.type === "TXT" ? txtValue(r.content) : r.content));
    if (found.some((r) => r.type === "CNAME")) {
      return result("conflict", found.filter((r) => r.type === "CNAME").map((r) => `CNAME ${r.content}`), "cname");
    }

    if (d.type === "A" || d.type === "AAAA") {
      const exact = sameType.find((r) => r.content.toLowerCase() === d.content.toLowerCase());
      if (exact) {
        if (exact.proxied) return result("differs", [`${exact.content} (proxied)`], "proxied", exact);
        return result("ok", [exact.content]);
      }
      if (sameType.length === 0) return result("create", []);
      if (sameType.length === 1) return result("differs", currentOf(sameType), null, sameType[0]!);
      return result("conflict", currentOf(sameType), "multiple");
    }

    if (d.type === "MX") {
      const exact = sameType.find((r) => norm(r.content) === norm(d.content) && r.priority === (d.priority ?? 10));
      if (exact) return result("ok", currentOf(sameType));
      if (sameType.length === 0) return result("create", []);
      if (sameType.length === 1 && ours(sameType[0]!)) return result("differs", currentOf(sameType), null, sameType[0]!);
      return result("conflict", currentOf(sameType), "other_mx");
    }

    // TXT: compara só os registros da mesma "família" (v=spf1, v=DKIM1, v=DMARC1…); os demais TXT do nome não são tocados.
    const wanted = txtValue(d.content);
    const tag = /^v=[A-Za-z0-9]+/.exec(wanted)?.[0]?.toLowerCase() ?? null;
    const family = sameType.filter((r) => (tag ? txtValue(r.content).toLowerCase().startsWith(tag) : txtValue(r.content) === wanted));
    const exact = family.find((r) => txtValue(r.content) === wanted);
    if (exact) return result("ok", currentOf([exact]));
    if (family.length === 0) return result("create", []);
    if (family.length > 1) return result("conflict", currentOf(family), tag === "v=spf1" ? "spf_multiple" : "multiple");
    const only = family[0]!;
    if (tag === "v=spf1" && !ours(only)) {
      const ip4 = /\bip4:(\S+)/i.exec(wanted)?.[1];
      const merged = ip4 ? mergeSpf(only.content, ip4) : null;
      if (!ip4 || merged === null) return result("conflict", currentOf(family), "spf_redirect");
      if (merged === txtValue(only.content)) return result("ok", currentOf(family), "spf_covers");
      return result("merge", currentOf(family), null, only, merged);
    }
    return result("differs", currentOf(family), null, only);
  }

  /** Compara os registros desejados com a zona. Só leitura. */
  async plan(desired: DesiredRecord[]): Promise<CloudflarePlanResponse> {
    return (await this.analyse(desired)).response;
  }

  private async analyse(desired: DesiredRecord[]) {
    const token = await this.token();
    const zones = await this.zones();
    const stored = new Set((await this.store.read()).records.map((r) => r.id));
    const ours = (r: CfRecord) => r.comment === CLOUDFLARE_RECORD_COMMENT || stored.has(r.id);
    const byName = new Map<string, Promise<CfRecord[]>>();
    const items: CloudflarePlanItem[] = [];
    const targets = new Map<string, { zone: CfZone; target: CfRecord | null; proposed: string; status: CloudflareItemStatus }>();
    let noZoneCount = 0;
    for (const d of desired) {
      const zone = this.zoneFor(zones, d.name);
      if (!zone) {
        noZoneCount += 1;
        items.push({
          id: d.id,
          type: d.type,
          name: d.name,
          status: "no_zone",
          proposed: d.type === "MX" ? mxText(d) : d.content,
          current: [],
          optional: d.optional,
          ours: false,
          reason: null,
          selectable: false,
          defaultSelected: false,
        });
        continue;
      }
      const key = `${zone.id}|${d.name}`;
      if (!byName.has(key)) byName.set(key, this.existing(zone.id, d.name, token));
      const found = await byName.get(key)!;
      const c = this.classify(d, found, ours);
      const selectable = c.status === "create" || c.status === "differs" || c.status === "merge";
      const isOurs = c.target !== null && ours(c.target);
      items.push({
        id: d.id,
        type: d.type,
        name: d.name,
        status: c.status,
        proposed: c.proposed,
        current: c.current,
        optional: d.optional,
        ours: isOurs,
        reason: c.reason,
        selectable,
        defaultSelected: c.status === "create" || (c.status === "differs" && isOurs),
      });
      targets.set(d.id, { zone, target: c.target, proposed: c.proposed, status: c.status });
    }
    return { response: { items, noZoneCount }, targets };
  }

  // ---------------------------------------------------------------------------
  // Aplicação
  // ---------------------------------------------------------------------------

  /** Aplica SÓ os itens marcados (recalculando a prévia na hora: o DNS pode ter mudado desde que a pessoa a viu). */
  apply(desired: DesiredRecord[], selected: string[], label: string, actor?: string): Promise<CloudflareApplyResponse> {
    const run = this.queue.then(() => this.doApply(desired, selected, label, actor));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doApply(desired: DesiredRecord[], selected: string[], label: string, actor?: string): Promise<CloudflareApplyResponse> {
    const token = await this.token();
    const { response, targets } = await this.analyse(desired);
    const wanted = new Set(selected);
    const results: CloudflareApplyResult[] = [];
    const made: StoredRecord[] = [];
    let stop: Error | null = null;
    for (const item of response.items) {
      if (!wanted.has(item.id)) continue;
      const d = desired.find((x) => x.id === item.id)!;
      const base = { id: item.id, type: item.type, name: item.name };
      if (!item.selectable) {
        results.push({ ...base, outcome: "skipped", message: item.status });
        continue;
      }
      if (stop) {
        results.push({ ...base, outcome: "failed", message: stop.message });
        continue;
      }
      const { zone, target } = targets.get(item.id)!;
      const payload: Record<string, unknown> = {
        type: d.type,
        name: d.name,
        content: item.status === "merge" ? item.proposed : d.content,
        ttl: 1,
        comment: CLOUDFLARE_RECORD_COMMENT,
        ...(d.type === "MX" ? { priority: d.priority ?? 10 } : {}),
        ...(d.type === "A" || d.type === "AAAA" ? { proxied: false } : {}),
      };
      try {
        if (item.status === "create") {
          const rec = await this.request<CfRecord>("POST", `/zones/${zone.id}/dns_records`, payload, token);
          made.push({ id: rec.id, zoneId: zone.id, type: d.type, name: d.name, at: new Date(this.now()).toISOString() });
          results.push({ ...base, outcome: "created", message: null });
        } else {
          await this.request<CfRecord>("PATCH", `/zones/${zone.id}/dns_records/${target!.id}`, payload, token);
          made.push({ id: target!.id, zoneId: zone.id, type: d.type, name: d.name, at: new Date(this.now()).toISOString() });
          results.push({ ...base, outcome: "updated", message: null });
        }
      } catch (err) {
        const e = err as { code?: string; message?: string };
        if (e.code === "cloudflare_hourly_limit" || e.code === "cloudflare_rate_limited" || e.code === "cloudflare_token_rejected") {
          stop = err as Error;
        }
        results.push({ ...base, outcome: "failed", message: e.message ?? "Erro." });
      }
    }
    if (made.length > 0) {
      await this.store.update((cur) => ({ records: [...cur.records.filter((r) => !made.some((m) => m.id === r.id)), ...made] }));
    }
    const count = (o: CloudflareApplyResult["outcome"]) => results.filter((r) => r.outcome === o).length;
    const out: CloudflareApplyResponse = {
      results,
      created: count("created"),
      updated: count("updated"),
      skipped: count("skipped"),
      failed: count("failed"),
    };
    const touched = results.filter((r) => r.outcome === "created" || r.outcome === "updated").map((r) => `${r.type} ${r.name}`);
    await this.deps.audit.record({
      ...(actor ? { actor } : {}),
      action: "cloudflare.dns_applied",
      target: label,
      detail:
        `Cloudflare: ${out.created} registro(s) criado(s), ${out.updated} atualizado(s), ${out.skipped} ignorado(s), ${out.failed} com falha` +
        (touched.length > 0 ? ` — ${touched.join("; ")}.` : "."),
    });
    return out;
  }
}
