/**
 * panel-domain.ts — Configurações → Domínio do painel.
 *
 * O instalador entrega o painel em https://<ip-com-hífens>.sslip.io
 * (PAAS_PANEL_DOMAIN, o "acesso pelo IP"). Aqui a pessoa cadastra um domínio
 * próprio e o painel:
 *  1. confere o DNS no resolvedor público (o do sistema só quando o público
 *     não responde), como a verificação do e-mail;
 *  2. com o DNS certo, acrescenta o domínio ao bloco do painel no proxy — os
 *     DOIS endereços respondem. O nome entra no proxy só com o DNS certo, então
 *     a primeira tentativa de emissão do certificado já sai na hora (não há
 *     espera acumulada de tentativas anteriores); a tela acompanha pela página
 *     Certificados, com o "Tentar emitir agora" se falhar;
 *  3. com a página aberta PELO DOMÍNIO NOVO e o certificado válido, deixa
 *     desativar o acesso pelo IP (o bloco fica só com o domínio);
 *  4. reativa pelo botão ou por SSH (scripts/reativar-acesso-ip.sh);
 *  5. nunca deixa o painel sem endereço: remover ou trocar o domínio reativa
 *     o IP antes.
 *
 * A escolha fica em <dataDir>/panel-domain.json (volume paas_data, /data no
 * container) e é reaplicada no boot do painel, antes de o proxy ser montado.
 * O PAAS_PANEL_DOMAIN do .env NUNCA muda: ele continua sendo a fonte do IP
 * público da VPS (registro A, checklist do e-mail, endereço automático dos
 * projetos).
 */
import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import type { CertificateItem, PanelDomainDnsCheck, PanelDomainStatus, PanelOpenedVia } from "@paas/core";
import { isCloudflareIp } from "../routes/domains.js";
import { httpError } from "./http-error.js";

export const PANEL_DOMAIN_FILE = "panel-domain.json";

/** Mesma regra de nome do Caddyfile (SAFE_DOMAIN_RE) e de PAAS_PANEL_DOMAIN. */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Estado gravado em panel-domain.json. */
export interface StoredPanelDomain {
  /** Domínio próprio cadastrado; null = nenhum. */
  domain: string | null;
  /** DNS conferido e domínio já no proxy. */
  active: boolean;
  /** Acesso pelo IP (sslip.io) desativado. Só vale com `active`. */
  ipAccessDisabled: boolean;
  lastCheck: PanelDomainDnsCheck | null;
  updatedAt: string | null;
}

const EMPTY: StoredPanelDomain = { domain: null, active: false, ipAccessDisabled: false, lastCheck: null, updatedAt: null };

/** Resolvedor injetável (público, do sistema, dublê nos testes). */
export interface PanelDomainResolver {
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
}

export interface PanelDomainAuditSink {
  record(input: { actor?: string; action: string; target?: string | null; detail: string }): Promise<unknown>;
}

export interface PanelDomainDeps {
  dataDir: string;
  /** Endereço pelo IP (PAAS_PANEL_DOMAIN, <ip>.sslip.io); null = acesso por túnel. */
  ipAddress: string | null;
  /** IPv4 público da VPS (valor do registro A). */
  serverIp: string | null;
  /** IPv6 público da VPS, se houver (um AAAA igual a ele é aceito). */
  serverIpv6: string | null;
  /** Pasta do repositório do painel no host (comando de SSH para reativar). */
  hostRepoDir: string;
  /**
   * Aplica os endereços do painel (o principal primeiro). `reload: false` (boot):
   * só guarda — o proxy é montado logo depois pela subida do painel.
   */
  applyAddresses(site: { primary: string; aliases: string[] }, opts: { reload: boolean }): Promise<void>;
  /** Nomes reservados ao painel (nenhum projeto pode usar), mesmo antes do DNS. */
  setReserved(names: string[]): void;
  /** Certificado servido para o nome (página Certificados); null = o painel não serve o nome. */
  certificate(host: string): Promise<CertificateItem | null>;
  /** O nome já é de um projeto ou do e-mail? */
  domainInUse(domain: string): Promise<boolean>;
  resolver: PanelDomainResolver;
  /** Segunda opção quando o resolvedor público não responde. */
  fallbackResolver: PanelDomainResolver | null;
  audit?: PanelDomainAuditSink;
  log?: (message: string) => void;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Regras puras
// ---------------------------------------------------------------------------

export type DomainInput = { ok: true; domain: string } | { ok: false; message: string };

/** Limpa e confere o domínio digitado (aceita "https://…/" e ponto final). */
export function normalizePanelDomainInput(raw: string, ipAddress: string | null): DomainInput {
  const value = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .replace(/\.$/, "");
  if (!value) return { ok: false, message: "Informe o domínio do painel (ex.: painel.exemplo.com.br)." };
  if (isIP(value)) {
    return { ok: false, message: "Informe um nome de domínio, não um IP: o objetivo é justamente tirar o IP do endereço." };
  }
  if (value.length > 253 || !/^[a-z0-9.-]+$/.test(value)) {
    return { ok: false, message: `"${raw.trim()}" é um domínio inválido. Use só letras, números, hífen e ponto.` };
  }
  if (!value.includes(".")) {
    return { ok: false, message: "Informe o domínio completo, com o ponto (ex.: painel.exemplo.com.br)." };
  }
  if (value === "localhost" || value.endsWith(".localhost")) {
    return { ok: false, message: "Endereços .localhost só funcionam dentro do próprio computador." };
  }
  if (value.endsWith(".sslip.io") || value === ipAddress) {
    return { ok: false, message: "Endereços sslip.io têm o IP da VPS no nome. Use um domínio seu (ex.: painel.exemplo.com.br)." };
  }
  if (!HOSTNAME_RE.test(value)) {
    return { ok: false, message: `"${raw.trim()}" é um domínio inválido. Use só letras, números, hífen e ponto.` };
  }
  return { ok: true, domain: value };
}

const NO_RECORD = new Set(["ENOTFOUND", "ENODATA", "NOTFOUND", "NODATA"]);
const UNAVAILABLE = Symbol("sem-resposta");

/** Consulta com uma segunda tentativa; "não existe" é resposta (lista vazia). */
async function ask(query: () => Promise<string[]>): Promise<string[] | typeof UNAVAILABLE> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await query();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (typeof code === "string" && NO_RECORD.has(code)) return [];
    }
  }
  return UNAVAILABLE;
}

async function lookup(
  primary: PanelDomainResolver,
  fallback: PanelDomainResolver | null,
  query: (r: PanelDomainResolver) => Promise<string[]>,
): Promise<string[] | typeof UNAVAILABLE> {
  const first = await ask(() => query(primary));
  if (first !== UNAVAILABLE || !fallback) return first;
  return ask(() => query(fallback));
}

const GRAY_CLOUD = 'No Cloudflare, deixe a nuvem cinza ("Somente DNS").';

/** Confere o registro A (e o AAAA) do domínio do painel. */
export async function checkPanelDomainDns(opts: {
  domain: string;
  expectedIp: string | null;
  expectedIpv6: string | null;
  primary: PanelDomainResolver;
  fallback?: PanelDomainResolver | null;
  now?: () => number;
}): Promise<PanelDomainDnsCheck> {
  const { domain, expectedIp } = opts;
  const checkedAt = new Date((opts.now ?? Date.now)()).toISOString();
  const result = (
    problem: PanelDomainDnsCheck["problem"],
    message: string,
    ipv4: string[] = [],
    ipv6: string[] = [],
  ): PanelDomainDnsCheck => ({ domain, ok: problem === "ok", problem, ipv4, ipv6, expectedIp, message, checkedAt });

  if (!expectedIp) {
    return result(
      "no_server_ip",
      "O painel não sabe o IP público desta VPS, então não dá para conferir o registro. Isso acontece no acesso por túnel.",
    );
  }
  const fallback = opts.fallback ?? null;
  const v4 = await lookup(opts.primary, fallback, (r) => r.resolve4(domain));
  if (v4 === UNAVAILABLE) {
    return result("unavailable", "O DNS não respondeu agora. Nada foi alterado; tente verificar de novo em instantes.");
  }
  // IPv6 é complemento: sem resposta, segue só com o A.
  const v6raw = await lookup(opts.primary, fallback, (r) => r.resolve6(domain));
  const v6 = v6raw === UNAVAILABLE ? [] : v6raw;
  const create = `No seu provedor de DNS, crie um registro do tipo A com o nome ${domain} e o valor ${expectedIp}. ${GRAY_CLOUD}`;

  if (v4.length === 0) {
    return result("missing", `${domain} ainda não aponta para lugar nenhum. ${create} A propagação costuma levar de minutos a algumas horas.`, v4, v6);
  }
  if (v4.every(isCloudflareIp)) {
    return result(
      "cloudflare",
      `${domain} está com o proxy da Cloudflare ligado (nuvem laranja): ele responde com os IPs da Cloudflare, não com o da VPS, e o certificado não sai. Abra o registro na Cloudflare e mude para a nuvem cinza ("Somente DNS"), com o valor ${expectedIp}.`,
      v4,
      v6,
    );
  }
  const others = v4.filter((ip) => ip !== expectedIp);
  if (others.length > 0) {
    return result(
      "wrong_ip",
      v4.includes(expectedIp)
        ? `${domain} aponta para mais de um lugar (${v4.join(", ")}). Apague os registros A com ${others.join(", ")} e deixe só o ${expectedIp}.`
        : `${domain} aponta para ${v4.join(", ")}, não para esta VPS. Troque o valor do registro A para ${expectedIp}.`,
      v4,
      v6,
    );
  }
  const otherV6 = v6.filter((ip) => ip !== opts.expectedIpv6);
  if (otherV6.length > 0) {
    return result(
      "wrong_ipv6",
      `${domain} também tem um registro AAAA (IPv6) apontando para ${otherV6.join(", ")}, que não é esta VPS. O emissor do certificado tenta o IPv6 primeiro e falharia: apague o registro AAAA.`,
      v4,
      v6,
    );
  }
  return result("ok", `${domain} aponta para esta VPS (${expectedIp}).`, v4, v6);
}

/** Por que "Desativar o acesso pelo IP" ainda não pode (vazio = liberado). */
export function disableIpBlockers(s: {
  mode: "https" | "tunnel";
  domain: string | null;
  domainActive: boolean;
  ipAccessDisabled: boolean;
  certificateValid: boolean;
  currentHost: string;
}): string[] {
  if (s.mode === "tunnel") return ["No acesso por túnel não há endereço pelo IP para desativar."];
  if (s.ipAccessDisabled) return ["O acesso pelo IP já está desativado."];
  if (!s.domain) return ["Cadastre o domínio do painel primeiro."];
  if (!s.domainActive) return [`Falta o DNS de ${s.domain} apontar para esta VPS (clique em "Verificar DNS").`];
  const out: string[] = [];
  if (!s.certificateValid) out.push(`O certificado HTTPS de ${s.domain} ainda não está válido.`);
  if (s.currentHost !== s.domain) {
    out.push(`Abra o painel pelo endereço novo (https://${s.domain}), entre de novo e volte a esta tela: o botão só funciona lá.`);
  }
  return out;
}

function certificateIsValid(item: CertificateItem | null): boolean {
  return item !== null && (item.state === "valid" || item.state === "expiring");
}

/** Para o roteiro de primeiros passos. */
export interface PanelDomainFacts {
  ipAddress: string | null;
  domain: string | null;
  active: boolean;
  certificateValid: boolean;
  ipAccessDisabled: boolean;
  openedViaDomain: boolean;
}

// ---------------------------------------------------------------------------
// Serviço
// ---------------------------------------------------------------------------

export class PanelDomainService {
  private state: StoredPanelDomain = { ...EMPTY };
  private readonly file: string;
  /** Fila das mudanças: uma de cada vez (gravação + proxy). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: PanelDomainDeps) {
    this.file = path.join(deps.dataDir, PANEL_DOMAIN_FILE);
  }

  private get mode(): "https" | "tunnel" {
    return this.deps.ipAddress ? "https" : "tunnel";
  }

  private now(): string {
    return new Date((this.deps.now ?? Date.now)()).toISOString();
  }

  /** Lê o arquivo (sem ele, ou ilegível: nada cadastrado) e aplica os endereços no serviço do proxy. */
  async init(): Promise<void> {
    this.state = await this.read();
    this.deps.setReserved(this.state.domain ? [this.state.domain] : []);
    const site = this.site(this.state);
    if (site) await this.deps.applyAddresses(site, { reload: false });
  }

  private async read(): Promise<StoredPanelDomain> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.deps.log?.(`Domínio do painel: ${this.file} ilegível (${err instanceof Error ? err.message : String(err)}); usando o endereço pelo IP.`);
      }
      return { ...EMPTY };
    }
    const r = (raw ?? {}) as Partial<StoredPanelDomain>;
    const domain = typeof r.domain === "string" && normalizePanelDomainInput(r.domain, this.deps.ipAddress).ok ? r.domain : null;
    const active = domain !== null && r.active === true;
    return {
      domain,
      active,
      // Incoerência (IP desativado sem domínio ativo) nunca tranca ninguém fora.
      ipAccessDisabled: active && r.ipAccessDisabled === true,
      lastCheck: domain && r.lastCheck && r.lastCheck.domain === domain ? r.lastCheck : null,
      updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : null,
    };
  }

  private async write(next: StoredPanelDomain): Promise<void> {
    await mkdir(this.deps.dataDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await rename(tmp, this.file);
  }

  /** Endereços do painel para um estado (o principal primeiro); null = túnel. */
  private site(s: StoredPanelDomain): { primary: string; aliases: string[] } | null {
    const ip = this.deps.ipAddress;
    if (!ip) return null;
    if (s.domain && s.active) return { primary: s.domain, aliases: s.ipAccessDisabled ? [] : [ip] };
    return { primary: ip, aliases: [] };
  }

  private addresses(s: StoredPanelDomain): string[] {
    const site = this.site(s);
    return site ? [site.primary, ...site.aliases] : [];
  }

  /**
   * Grava o estado novo e aplica no proxy, nessa ordem; se o proxy recusar,
   * volta o arquivo ao que era (o painel continua como estava).
   */
  private async commit(next: StoredPanelDomain, applyProxy: boolean): Promise<void> {
    const before = this.state;
    next.updatedAt = this.now();
    await this.write(next);
    this.state = next;
    this.deps.setReserved(next.domain ? [next.domain] : []);
    if (!applyProxy) return;
    const site = this.site(next);
    try {
      if (site) await this.deps.applyAddresses(site, { reload: true });
    } catch (err) {
      await this.write(before);
      this.state = before;
      this.deps.setReserved(before.domain ? [before.domain] : []);
      const prev = this.site(before);
      if (prev) await this.deps.applyAddresses(prev, { reload: true }).catch(() => undefined);
      throw err;
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async audit(actor: string, action: string, target: string | null, detail: string): Promise<void> {
    await this.deps.audit?.record({ actor, action, target, detail });
  }

  private async certificateFor(domain: string | null, active: boolean): Promise<CertificateItem | null> {
    if (!domain || !active) return null;
    try {
      return await this.deps.certificate(domain);
    } catch (err) {
      this.deps.log?.(`Domínio do painel: certificado de ${domain} não conferido (${err instanceof Error ? err.message : String(err)}).`);
      return null;
    }
  }

  private openedVia(host: string): PanelOpenedVia {
    const h = host.toLowerCase();
    if (this.state.domain && h === this.state.domain) return "domain";
    if (this.deps.ipAddress && h === this.deps.ipAddress) return "ip";
    return "other";
  }

  async status(requestHost: string): Promise<PanelDomainStatus> {
    const s = this.state;
    const currentHost = requestHost.toLowerCase();
    const certificate = await this.certificateFor(s.domain, s.active);
    const blockers = disableIpBlockers({
      mode: this.mode,
      domain: s.domain,
      domainActive: s.active,
      ipAccessDisabled: s.ipAccessDisabled,
      certificateValid: certificateIsValid(certificate),
      currentHost,
    });
    return {
      mode: this.mode,
      ipAddress: this.deps.ipAddress,
      ipAccessDisabled: s.ipAccessDisabled,
      serverIp: this.deps.serverIp,
      domain: s.domain,
      domainActive: s.active,
      lastCheck: s.lastCheck,
      certificate,
      addresses: this.addresses(s),
      currentHost,
      openedVia: this.openedVia(currentHost),
      disableIp: { allowed: blockers.length === 0, blockers },
      reactivateCommand: `cd ${this.deps.hostRepoDir} && sudo ./scripts/reativar-acesso-ip.sh`,
      configFile: `/data/${PANEL_DOMAIN_FILE} (volume Docker paas_data)`,
    };
  }

  /** Roteiro de primeiros passos. */
  async facts(requestHost: string): Promise<PanelDomainFacts> {
    const s = this.state;
    return {
      ipAddress: this.deps.ipAddress,
      domain: s.domain,
      active: s.active,
      certificateValid: certificateIsValid(await this.certificateFor(s.domain, s.active)),
      ipAccessDisabled: s.ipAccessDisabled,
      openedViaDomain: s.domain !== null && requestHost.toLowerCase() === s.domain,
    };
  }

  private requireHttps(): void {
    if (this.mode === "tunnel") {
      throw httpError(
        409,
        "tunnel_mode",
        "No acesso por túnel o painel não tem endereço na internet, então não dá para usar um domínio. Mude o acesso para HTTPS primeiro (a tela explica como).",
      );
    }
  }

  /** Cadastra (ou troca) o domínio. Não mexe no proxy até o DNS ser conferido — exceto para reativar o IP. */
  setDomain(raw: string, actor: string): Promise<PanelDomainStatus> {
    return this.serial(async () => {
      this.requireHttps();
      const input = normalizePanelDomainInput(raw, this.deps.ipAddress);
      if (!input.ok) throw httpError(400, "invalid_domain", input.message);
      const { domain } = input;
      const previous = this.state;
      if (previous.domain === domain) return this.status(domain);
      if (await this.deps.domainInUse(domain)) {
        throw httpError(409, "domain_in_use", `${domain} já está em uso por um projeto ou pelo e-mail. Escolha outro nome (ex.: painel.${domain.split(".").slice(1).join(".")}).`);
      }
      // Trocar tira o domínio antigo do proxy e devolve o acesso pelo IP: o
      // novo só entra depois do DNS conferido. Nunca sem endereço.
      const changedProxy = previous.active;
      await this.commit({ domain, active: false, ipAccessDisabled: false, lastCheck: null, updatedAt: null }, changedProxy);
      await this.audit(
        actor,
        "panel_domain.set",
        domain,
        previous.domain
          ? `Domínio do painel trocado de ${previous.domain} para ${domain}${previous.ipAccessDisabled ? "; acesso pelo IP reativado" : ""}.`
          : `Domínio do painel cadastrado: ${domain} (aguardando o DNS).`,
      );
      return this.status(this.deps.ipAddress ?? "");
    });
  }

  /** Confere o DNS; certo → acrescenta o domínio ao bloco do painel (o proxy emite o certificado). */
  verify(actor: string, requestHost: string): Promise<{ check: PanelDomainDnsCheck; status: PanelDomainStatus }> {
    return this.serial(async () => {
      this.requireHttps();
      const s = this.state;
      if (!s.domain) throw httpError(409, "no_domain", "Cadastre o domínio do painel primeiro.");
      const check = await checkPanelDomainDns({
        domain: s.domain,
        expectedIp: this.deps.serverIp,
        expectedIpv6: this.deps.serverIpv6,
        primary: this.deps.resolver,
        fallback: this.deps.fallbackResolver,
        ...(this.deps.now ? { now: this.deps.now } : {}),
      });
      const activating = check.ok && !s.active;
      await this.commit({ ...s, active: s.active || check.ok, lastCheck: check, updatedAt: null }, activating);
      if (activating) {
        await this.audit(
          actor,
          "panel_domain.activated",
          s.domain,
          `Domínio do painel ativado: ${s.domain} (DNS conferido). O painel responde em ${this.addresses(this.state).join(" e ")}.`,
        );
      }
      return { check, status: await this.status(requestHost) };
    });
  }

  /** Remove o domínio; o acesso pelo IP volta (se estava desativado) antes de o domínio sair. */
  removeDomain(actor: string): Promise<PanelDomainStatus> {
    return this.serial(async () => {
      const s = this.state;
      if (!s.domain) throw httpError(409, "no_domain", "Não há domínio do painel cadastrado.");
      await this.commit({ ...EMPTY }, s.active);
      await this.audit(
        actor,
        "panel_domain.removed",
        s.domain,
        `Domínio do painel removido: ${s.domain}. O painel volta a abrir só pelo endereço do IP${s.ipAccessDisabled ? " (reativado)" : ""}.`,
      );
      return this.status(this.deps.ipAddress ?? "");
    });
  }

  /** Desativa o acesso pelo IP: só com as condições atendidas e o domínio digitado. */
  disableIp(confirm: string, requestHost: string, actor: string): Promise<PanelDomainStatus> {
    return this.serial(async () => {
      const current = await this.status(requestHost);
      if (!current.disableIp.allowed) {
        throw httpError(409, "disable_ip_blocked", current.disableIp.blockers.join(" "));
      }
      const domain = this.state.domain!;
      if (confirm.trim().toLowerCase() !== domain) {
        throw httpError(400, "confirm_mismatch", `Para confirmar, digite exatamente ${domain}.`);
      }
      await this.commit({ ...this.state, ipAccessDisabled: true, updatedAt: null }, true);
      await this.audit(
        actor,
        "panel_domain.ip_disabled",
        this.deps.ipAddress,
        `Acesso pelo IP desativado: o painel responde só em https://${domain}. Para voltar: o botão "Reativar o acesso pelo IP" ou, por SSH, ${current.reactivateCommand}.`,
      );
      return this.status(requestHost);
    });
  }

  /** Reativa o acesso pelo IP (botão da tela; o script de SSH faz o mesmo no arquivo). */
  enableIp(actor: string, requestHost = ""): Promise<PanelDomainStatus> {
    return this.serial(async () => {
      if (this.state.ipAccessDisabled) {
        await this.commit({ ...this.state, ipAccessDisabled: false, updatedAt: null }, true);
        await this.audit(actor, "panel_domain.ip_enabled", this.deps.ipAddress, `Acesso pelo IP reativado: o painel volta a responder em https://${this.deps.ipAddress}.`);
      }
      return this.status(requestHost || this.deps.ipAddress || "");
    });
  }
}
