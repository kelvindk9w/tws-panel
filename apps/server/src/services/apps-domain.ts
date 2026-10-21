/**
 * apps-domain.ts — Configurações → Domínio de aplicações.
 *
 * O endereço automático dos projetos é <projeto>.<ip-com-hífens>.sslip.io: o IP
 * da VPS fica à vista (prints, links compartilhados), o endereço quebra se o IP
 * mudar e depende de um serviço de terceiros. Aqui a pessoa define uma base
 * própria (ex.: apps.example.com) e cria UM registro curinga (*.apps.example.com)
 * apontando para a VPS. O painel:
 *  1. confere o DNS consultando um rótulo ALEATÓRIO sob a base
 *     (paas-check-<aleatório>.apps.example.com): só um registro curinga
 *     responde por ele; um registro só para o nome exato da base não passa;
 *  2. só SALVA a base com o DNS certo (uma base que não resolve geraria
 *     endereços que não abrem e tentativas de certificado inúteis);
 *  3. gera, para cada projeto novo, <projeto>-<sufixo aleatório>.<base>.
 *
 * O que NÃO muda no proxy: cada projeto continua com a sua rota explícita por
 * host (packages/deploy/src/caddy.ts). Não há certificado curinga nem emissão
 * sob demanda: um nome aleatório sob a base, sem rota, cai na página de
 * "domínio não configurado" em HTTP e não tem certificado emitido.
 *
 * Estado em <dataDir>/apps-domain.json (volume paas_data). O arquivo volta com
 * o backup do painel; por isso guarda o IP para o qual o DNS foi conferido:
 * restaurado em uma VPS com outro IP, a base fica "a conferir" e deixa de ser
 * oferecida até a pessoa atualizar o registro e conferir de novo.
 */
import { randomInt } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { domainToASCII } from "node:url";
import type { AppsDomainDnsCheck, AppsDomainRecord, AppsDomainStatus, AppsDomainVerifyResponse } from "@paas/core";
import { httpError } from "./http-error.js";
import { loadJson, writeFileAtomic } from "./json-file.js";
import { slugify } from "./deploy-service.js";
import { checkPanelDomainDns, type PanelDomainAuditSink, type PanelDomainResolver } from "./panel-domain.js";

export const APPS_DOMAIN_FILE = "apps-domain.json";

/** Mesma regra de nome do Caddyfile (SAFE_DOMAIN_RE), com no mínimo dois rótulos. */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** O nome gerado (<projeto>-<sufixo>.<base>) precisa caber nos 253 caracteres de um nome DNS. */
const MAX_BASE_LENGTH = 200;
/** Alfabeto do sufixo: sem letras e números que se confundem (i, l, o, 0, 1). */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const SUFFIX_SHORT = 5;
const SUFFIX_LONG = 8;
const ATTEMPTS_PER_LENGTH = 8;
const PROBE_PREFIX = "paas-check-";
const DEFAULT_DNS_TIMEOUT_MS = 6_000;

/** Terminações de rede interna, uso especial (RFC 6761/6762/8375) ou sem dono público. */
const RESERVED_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "lan",
  "home",
  "home.arpa",
  "localdomain",
  "intranet",
  "corp",
  "private",
  "test",
  "invalid",
  "onion",
  "arpa",
  "example",
];
/** Serviços de DNS curinga por IP: o endereço teria o IP no nome (justamente o problema). */
const IP_WILDCARD_SERVICES = ["sslip.io", "nip.io", "xip.io", "traefik.me", "localtest.me", "lvh.me", "localhost.run"];

export type AppsDomainInput =
  | { ok: true; domain: string }
  | { ok: false; code: "invalid_domain" | "reserved_domain" | "panel_domain"; message: string };

const invalid = (message: string): AppsDomainInput => ({ ok: false, code: "invalid_domain", message });
const INVALID_CHARS = "O domínio de aplicações é inválido. Use só letras, números, hífen e ponto (ex.: apps.example.com).";

const endsWithSuffix = (domain: string, suffix: string) => domain === suffix || domain.endsWith(`.${suffix}`);

/**
 * Limpa e confere a base digitada. Nunca devolve o texto bruto nas mensagens
 * (eco de quebra de linha ou chaves). O resultado aceito sempre passa na regra
 * estrita de hostname do Caddyfile.
 */
export function normalizeAppsDomainInput(raw: string, ctx: { panelHosts: string[]; ipAddress: string | null }): AppsDomainInput {
  let value = raw.trim();
  if (!value) return invalid("Informe o domínio de aplicações (ex.: apps.example.com).");
  // Controle, espaço ou barra invertida dentro do texto: nunca é um nome.
  if (/[\u0000-\u001f\u007f\s\\]/u.test(value)) return invalid(INVALID_CHARS);
  value = value.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  // Curinga óbvio (*.apps.example.com): guarda só a base. Qualquer outro * é recusado.
  if (value.startsWith("*.")) value = value.slice(2);
  if (value.includes("*")) {
    return invalid("Não digite o curinga (*) no meio do nome. Informe só a base, por exemplo apps.example.com: o painel mostra o registro *.apps.example.com a criar.");
  }
  if (/:\d*$/.test(value) && !isIP(value)) {
    return invalid("Informe só o nome, sem porta (ex.: apps.example.com).");
  }
  if (isIP(value)) {
    return invalid("Informe um nome de domínio, não um IP: o objetivo é justamente tirar o IP do endereço.");
  }
  // IDN e letras de largura total viram ASCII (punycode). O que sobrar é conferido na regra estrita abaixo.
  const ascii = /^[\x20-\x7e]*$/.test(value) ? value.toLowerCase() : domainToASCII(value);
  if (!ascii) return invalid(INVALID_CHARS);
  value = ascii.replace(/\.$/, "");
  if (value.length > MAX_BASE_LENGTH) {
    return invalid(`O domínio de aplicações é longo demais (máximo ${MAX_BASE_LENGTH} caracteres): os endereços gerados precisam caber no limite do DNS.`);
  }
  if (!/^[a-z0-9.-]+$/.test(value)) return invalid(INVALID_CHARS);
  if (value === "localhost" || value.endsWith(".localhost")) {
    return { ok: false, code: "reserved_domain", message: "Endereços .localhost só funcionam dentro do próprio computador." };
  }
  if (IP_WILDCARD_SERVICES.some((s) => endsWithSuffix(value, s))) {
    return {
      ok: false,
      code: "reserved_domain",
      message: "Serviços como sslip.io e nip.io colocam o IP da VPS no endereço, que é justamente o que o domínio de aplicações evita. Use um subdomínio seu (ex.: apps.example.com).",
    };
  }
  if (!HOSTNAME_RE.test(value)) {
    return value.includes(".") ? invalid(INVALID_CHARS) : invalid("Use um subdomínio dedicado, com o domínio completo (ex.: apps.example.com).");
  }
  const labels = value.split(".");
  if (/^\d+$/.test(labels[labels.length - 1]!)) {
    return invalid("A terminação do domínio não pode ser só números (isso é um IP, não um nome). Use um domínio seu, como apps.example.com.");
  }
  if (labels.length < 3) {
    return invalid("Use um subdomínio dedicado (ex.: apps.example.com), não o domínio principal: o registro curinga cobre tudo que fica abaixo dele.");
  }
  if (RESERVED_SUFFIXES.some((s) => endsWithSuffix(value, s))) {
    return {
      ok: false,
      code: "reserved_domain",
      message: "Esse domínio é de rede interna ou de uso reservado e não funciona na internet. Use um subdomínio de um domínio seu (ex.: apps.example.com).",
    };
  }
  if (ctx.panelHosts.includes(value) || (ctx.ipAddress !== null && value === ctx.ipAddress)) {
    return { ok: false, code: "panel_domain", message: "Esse nome é o endereço do painel. Escolha outro subdomínio para as aplicações (ex.: apps.example.com)." };
  }
  return { ok: true, domain: value };
}

/** Estado gravado em apps-domain.json. */
export interface StoredAppsDomain {
  base: string | null;
  /** IPv4 da VPS para o qual o DNS foi conferido; null = a conferir. */
  verifiedIp: string | null;
  verifiedAt: string | null;
  lastCheck: AppsDomainDnsCheck | null;
  updatedAt: string | null;
}

const EMPTY: StoredAppsDomain = { base: null, verifiedIp: null, verifiedAt: null, lastCheck: null, updatedAt: null };

export interface AppsDomainDeps {
  dataDir: string;
  /** Endereço do painel pelo IP (PAAS_PANEL_DOMAIN); null = acesso por túnel. */
  ipAddress: string | null;
  /** IPv4 público da VPS (valor do registro A). */
  serverIp: string | null;
  /** IPv6 público da VPS, se informado (um AAAA igual a ele é aceito). */
  serverIpv6: string | null;
  /** Endereços do painel agora (nenhum pode ser a base). */
  panelHosts(): string[];
  /** O nome já é de um projeto, do painel ou do e-mail? */
  domainInUse(domain: string): Promise<boolean>;
  /** Quantos projetos têm um endereço sob a base. */
  countUsingBase(base: string): Promise<number>;
  resolver: PanelDomainResolver;
  fallbackResolver: PanelDomainResolver | null;
  audit?: PanelDomainAuditSink | undefined;
  log?: ((message: string) => void) | undefined;
  now?: (() => number) | undefined;
  /** Caracteres aleatórios do alfabeto sem ambíguos (testes injetam um gerador previsível). */
  randomChars?: ((length: number) => string) | undefined;
  /** Prazo de cada consulta de DNS (padrão 6 s). */
  dnsTimeoutMs?: number | undefined;
}

function randomChars(length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** Consulta de DNS com prazo: um resolvedor que trava vira "sem resposta" (falha segura). */
function withTimeout(r: PanelDomainResolver, ms: number): PanelDomainResolver {
  const guard = <T>(run: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error("tempo esgotado"), { code: "ETIMEOUT" })), ms);
      Promise.resolve()
        .then(run)
        .then(
          (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          (e: unknown) => {
            clearTimeout(timer);
            reject(e);
          },
        );
    });
  return { resolve4: (name) => guard(() => r.resolve4(name)), resolve6: (name) => guard(() => r.resolve6(name)) };
}

/** Parte do projeto no rótulo: curta, só [a-z0-9-], sem hífen nas pontas e sem parecer punycode (xn--). */
function projectLabel(name: string): string {
  let slug = slugify(name).slice(0, 30).replace(/^-+|-+$/g, "");
  if (slug.startsWith("xn-")) slug = `app-${slug}`.slice(0, 30).replace(/-+$/g, "");
  return slug || "app";
}

export class AppsDomainService {
  private state: StoredAppsDomain = { ...EMPTY };
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: AppsDomainDeps) {
    this.file = path.join(deps.dataDir, APPS_DOMAIN_FILE);
  }

  private now(): string {
    return new Date((this.deps.now ?? Date.now)()).toISOString();
  }

  private get mode(): "https" | "tunnel" {
    return this.deps.ipAddress ? "https" : "tunnel";
  }

  private ctx() {
    return { panelHosts: this.deps.panelHosts(), ipAddress: this.deps.ipAddress };
  }

  /** Lê o arquivo: sem ele, ilegível ou com base que não passa nas regras, nada fica configurado. */
  async init(): Promise<void> {
    const raw = await loadJson<unknown>(this.file, { empty: () => null, parse: (v) => v, log: this.deps.log });
    this.state = { ...EMPTY };
    if (raw === null || typeof raw !== "object") return;
    const r = raw as Partial<StoredAppsDomain>;
    if (typeof r.base !== "string") return;
    const input = normalizeAppsDomainInput(r.base, this.ctx());
    if (!input.ok || input.domain !== r.base) return;
    this.state = {
      base: r.base,
      verifiedIp: typeof r.verifiedIp === "string" && isIP(r.verifiedIp) === 4 ? r.verifiedIp : null,
      verifiedAt: typeof r.verifiedAt === "string" ? r.verifiedAt : null,
      lastCheck: r.lastCheck && r.lastCheck.base === r.base ? r.lastCheck : null,
      updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : null,
    };
  }

  private async write(next: StoredAppsDomain): Promise<void> {
    await mkdir(this.deps.dataDir, { recursive: true });
    await writeFileAtomic(this.file, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    this.state = next;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private isVerified(): boolean {
    const s = this.state;
    return s.base !== null && s.verifiedIp !== null && s.verifiedIp === this.deps.serverIp;
  }

  private records(base: string): AppsDomainRecord[] {
    const out: AppsDomainRecord[] = [];
    if (this.deps.serverIp) out.push({ type: "A", name: `*.${base}`, value: this.deps.serverIp });
    if (this.deps.serverIpv6) out.push({ type: "AAAA", name: `*.${base}`, value: this.deps.serverIpv6 });
    return out;
  }

  async status(): Promise<AppsDomainStatus> {
    const s = this.state;
    const verified = this.isVerified();
    return {
      mode: this.mode,
      base: s.base,
      verified,
      needsRecheck: s.base !== null && !verified,
      serverIp: this.deps.serverIp,
      serverIpv6: this.deps.serverIpv6,
      records: s.base ? this.records(s.base) : [],
      lastCheck: s.lastCheck,
      projectsUsingBase: s.base ? await this.deps.countUsingBase(s.base).catch(() => 0) : 0,
      example: s.base ? `meu-projeto-k3x9q.${s.base}` : null,
    };
  }

  private requireHttps(): void {
    if (this.mode === "tunnel") {
      throw httpError(
        409,
        "tunnel_mode",
        "No acesso por túnel o painel não tem endereço na internet, então não há domínio de aplicações para configurar. Mude o acesso para HTTPS primeiro (veja Configurações → Domínio do painel).",
      );
    }
  }

  /** Mensagem para leigo de cada resultado da conferência. */
  private describe(problem: AppsDomainDnsCheck["problem"], base: string, probe: string, base4: string[], v6: string[]): string {
    const ip = this.deps.serverIp ?? "o IP da VPS";
    const wildcardName = `*.${base}`;
    switch (problem) {
      case "ok":
        return `${wildcardName} aponta para esta VPS (${ip}). Os endereços automáticos dos projetos novos passam a usar ${base}.`;
      case "missing":
        return `${probe}, um nome aleatório sob ${base}, não aponta para lugar nenhum. No seu provedor de DNS, crie um registro do tipo A com o nome ${wildcardName} e o valor ${ip}. Um registro só para ${base} não basta: o curinga (*) é o que faz qualquer endereço sob a base chegar aqui. A propagação costuma levar de minutos a algumas horas.`;
      case "cloudflare":
        return `${wildcardName} está com o proxy da Cloudflare ligado (nuvem laranja): ele responde com os IPs da Cloudflare, não com o da VPS, e o certificado de cada projeto não sai. Na Cloudflare, abra o registro e mude para a nuvem cinza ("Somente DNS"), com o valor ${ip}.`;
      case "wrong_ip":
        return base4.includes(this.deps.serverIp ?? "")
          ? `${wildcardName} aponta para mais de um lugar (${base4.join(", ")}). Apague os registros A que não são ${ip}.`
          : `${wildcardName} aponta para ${base4.join(", ")}, não para esta VPS. Troque o valor do registro A para ${ip}.`;
      case "wrong_ipv6":
        return `${wildcardName} também tem um registro AAAA (IPv6) apontando para ${v6.join(", ")}, que não é esta VPS. O emissor do certificado tenta o IPv6 primeiro e falharia: apague o registro AAAA curinga.`;
      case "unavailable":
        return "O DNS não respondeu agora. Nada foi salvo; tente verificar de novo em instantes.";
      case "no_server_ip":
        return "O painel não sabe o IP público desta VPS, então não dá para conferir o registro. Isso acontece no acesso por túnel.";
    }
  }

  private async runCheck(base: string): Promise<AppsDomainDnsCheck> {
    const probe = `${PROBE_PREFIX}${(this.deps.randomChars ?? randomChars)(12)}.${base}`;
    const ms = this.deps.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS;
    const raw = await checkPanelDomainDns({
      domain: probe,
      expectedIp: this.deps.serverIp,
      expectedIpv6: this.deps.serverIpv6,
      primary: withTimeout(this.deps.resolver, ms),
      fallback: this.deps.fallbackResolver ? withTimeout(this.deps.fallbackResolver, ms) : null,
      ...(this.deps.now ? { now: this.deps.now } : {}),
    });
    return {
      base,
      probe,
      ok: raw.ok,
      problem: raw.problem,
      ipv4: raw.ipv4,
      ipv6: raw.ipv6,
      expectedIp: raw.expectedIp,
      message: this.describe(raw.problem, base, probe, raw.ipv4, raw.ipv6),
      checkedAt: raw.checkedAt,
    };
  }

  /**
   * Valida a base, confere o DNS e SÓ ENTÃO salva. Falha não mexe no que já
   * estava salvo (exceto reconferir a base atual com uma resposta definitiva
   * de que não aponta mais: ela deixa de ser oferecida).
   */
  verify(rawDomain: string, actor: string): Promise<AppsDomainVerifyResponse> {
    return this.serial(async () => {
      this.requireHttps();
      const input = normalizeAppsDomainInput(rawDomain, this.ctx());
      if (!input.ok) throw httpError(input.code === "panel_domain" ? 409 : 400, input.code, input.message);
      const base = input.domain;
      const previous = this.state.base;
      if (base !== previous) {
        if ((await this.deps.domainInUse(base)) || (await this.deps.domainInUse(`mail.${base}`))) {
          throw httpError(
            409,
            "domain_in_use",
            `${base} já é de um projeto ou do e-mail. Escolha outro subdomínio (ex.: apps.${base.split(".").slice(-2).join(".")}).`,
          );
        }
      }
      const check = await this.runCheck(base);
      if (check.ok) {
        await this.write({
          base,
          verifiedIp: this.deps.serverIp,
          verifiedAt: check.checkedAt,
          lastCheck: check,
          updatedAt: this.now(),
        });
        await this.deps.audit?.record({
          actor,
          action: "apps_domain.set",
          target: base,
          detail:
            previous && previous !== base
              ? `Domínio de aplicações trocado de ${previous} para ${base} (DNS conferido). Os projetos que já usam ${previous} não mudam.`
              : `Domínio de aplicações definido: ${base} (DNS conferido). Os endereços automáticos de projetos novos usam ${base}.`,
        });
        return { check, saved: true, status: await this.status() };
      }
      if (base === previous) {
        const inconclusive = check.problem === "unavailable" || check.problem === "no_server_ip";
        await this.write({
          ...this.state,
          verifiedIp: inconclusive ? this.state.verifiedIp : null,
          lastCheck: check,
          updatedAt: this.now(),
        });
      }
      return { check, saved: false, status: await this.status() };
    });
  }

  /** Remove a base. Projetos que já usam um endereço sob ela continuam como estão. */
  remove(actor: string): Promise<AppsDomainStatus> {
    return this.serial(async () => {
      const base = this.state.base;
      if (!base) throw httpError(409, "no_domain", "Não há domínio de aplicações cadastrado.");
      await this.write({ ...EMPTY, updatedAt: this.now() });
      await this.deps.audit?.record({
        actor,
        action: "apps_domain.removed",
        target: base,
        detail: `Domínio de aplicações removido: ${base}. Os projetos que já usam um endereço sob ele continuam funcionando; os novos voltam a usar o endereço de teste.`,
      });
      return this.status();
    });
  }

  /**
   * Endereço automático de um projeto novo: <projeto>-<sufixo>.<base>. null
   * quando não há base verificada para o IP atual (o assistente usa o endereço
   * de teste). Garante que o nome está livre (projetos, painel, e-mail).
   */
  async suggest(projectName: string): Promise<string | null> {
    const base = this.state.base;
    if (!base || !this.isVerified()) return null;
    return this.uniqueUnder(projectName, base);
  }

  /**
   * Endereço PROVISÓRIO de um projeto novo: <projeto>-<sufixo>.localhost. Único
   * (conferido contra projetos, apelidos, painel e e-mail, como o da base), não
   * revela o IP da VPS e NÃO pede certificado público (o proxy serve .localhost
   * em HTTP puro). O projeto nasce com ele e só troca para o endereço definitivo
   * ao fim do assistente; um rascunho abandonado nunca gasta certificado.
   */
  async suggestProvisional(projectName: string): Promise<string> {
    return this.uniqueUnder(projectName, "localhost");
  }

  private async uniqueUnder(projectName: string, base: string): Promise<string> {
    const label = projectLabel(projectName);
    const rand = this.deps.randomChars ?? randomChars;
    for (const length of [SUFFIX_SHORT, SUFFIX_LONG]) {
      for (let attempt = 0; attempt < ATTEMPTS_PER_LENGTH; attempt += 1) {
        const candidate = `${label}-${rand(length)}.${base}`;
        if (!(await this.deps.domainInUse(candidate))) return candidate;
      }
    }
    throw httpError(409, "domain_in_use", "Não foi possível gerar um endereço livre agora. Tente de novo ou use um domínio seu.");
  }
}
