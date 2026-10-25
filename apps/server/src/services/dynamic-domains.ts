/**
 * dynamic-domains.ts — Domínios dinâmicos do projeto (SaaS multi-cliente).
 *
 * O projeto atende nomes que o dono não conhece de antemão: subdomínios do
 * próprio SaaS (cliente1.example.com) e domínios próprios dos clientes
 * (app.cliente.example), apontados por CNAME/A para a VPS. Cada nome ganha o
 * próprio certificado, emitido SOB DEMANDA pelo Caddy no primeiro acesso. Quem
 * decide se um nome pode receber certificado é este serviço, pelo `ask` (ver
 * dynamic-ask-server.ts).
 *
 * Regras do `ask` (falha fechada em qualquer dúvida):
 *  1. o nome é um hostname válido e NÃO é do painel, do e-mail nem de um site
 *     fixo de projeto;
 *  2. está cadastrado em algum projeto — ou cai num sufixo "aberto" de um
 *     projeto (um nível abaixo), e então é cadastrado ali mesmo;
 *  3. cabe no teto de nomes do projeto;
 *  4. nome que já tem certificado (renovação) passa sem gastar cota; nome
 *     novo gasta uma das N emissões por hora (global: o limite do Let's
 *     Encrypt vale para a conta inteira) e o mesmo nome tem no máximo 3
 *     tentativas por hora (o Let's Encrypt barra 5 falhas por hora por nome).
 *
 * O estado fica em data/dynamic-domains.json (0600), gravado por inteiro de
 * uma vez. O contador de emissões e as tentativas por nome ficam em memória:
 * reiniciar o painel zera a janela (no pior caso, mais um lote de N pedidos).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DYNAMIC_DOMAIN_LIMIT_DEFAULTS,
  DYNAMIC_DOMAIN_LIMIT_RANGE,
  DYNAMIC_MAX_ATTEMPTS_PER_NAME_HOUR,
  DYNAMIC_MAX_SUFFIXES,
  DYNAMIC_NAME_STATES,
  DYNAMIC_SAME_ATTEMPT_MS,
  checkDynamicHost,
  apexOf,
  checkDynamicSuffix,
  cleanHost,
  isOneLevelUnder,
  type CertificateItem,
  type DynamicDomainCounters,
  type DynamicDomainItem,
  type DynamicDomainLimits,
  type DynamicDomainsResponse,
  type DynamicNameState,
  type DynamicSuffix,
} from "@paas/core";
import type { CertificateStatus } from "@paas/deploy";
import { httpError } from "./http-error.js";
import { loadJson, writeFileAtomic } from "./json-file.js";
import { currentActor } from "./request-actor.js";

interface StoredName {
  host: string;
  addedAt: string;
  addedBy: string;
  /** Primeira vez que o painel viu o certificado emitido: dali em diante o `ask` não gasta cota. */
  issuedAt?: string;
}

interface StoredProject {
  suffixes: DynamicSuffix[];
  names: StoredName[];
}

interface StateFile {
  version: 1;
  settings: Partial<DynamicDomainLimits>;
  projects: Record<string, StoredProject>;
}

export type AskReason =
  | "invalid"
  | "reserved"
  | "unknown"
  | "name_limit"
  | "name_cooldown"
  | "hourly_limit"
  | "weekly_limit"
  | "dns";

export type AskDecision = { allow: true } | { allow: false; reason: AskReason };

/**
 * Por onde o Caddy pergunta ao painel. Precisa do painel em container (o Caddy o alcança pelo nome, na rede
 * paas-panel) e servido pelo próprio Caddy (é o que o liga a essa rede). Sem isso, nada dinâmico é servido.
 */
export function dynamicRouting(o: { inContainer: boolean; askPort: number; panelServed: boolean; panelContainer: string; askPath: string }): {
  askUrl: string | null;
  ready: boolean;
  reason: string | null;
} {
  if (!o.inContainer) return { askUrl: null, ready: false, reason: "O painel não está rodando em container: o proxy não consegue consultá-lo." };
  if (o.askPort <= 0) return { askUrl: null, ready: false, reason: "A consulta do proxy ao painel está desligada (PAAS_ASK_PORT=0)." };
  if (!o.panelServed) {
    return { askUrl: null, ready: false, reason: "O proxy só consegue consultar o painel quando o painel é servido por HTTPS (Configurações → Domínio do painel)." };
  }
  return { askUrl: `http://${o.panelContainer}:${o.askPort}${o.askPath}`, ready: true, reason: null };
}

export type StaticOccupant = "panel" | "mail" | "project";

export interface DynamicDomainsDeps {
  dataDir: string;
  /** O projeto existe? (id exato) */
  projectExists(id: string): Promise<boolean>;
  /** Quem já serve o nome como site FIXO (painel, e-mail, domínio principal/adicional de qualquer projeto). */
  staticOccupant(host: string): Promise<StaticOccupant | null>;
  /** Recarrega o Caddy com a lista atual (já com a regra de lote/atraso do chamador). */
  refreshProxy(): Promise<void>;
  /** Estado do certificado de cada nome (tela Certificados; nunca abre conexão TLS). */
  inspect(projectId: string, hosts: ReadonlySet<string>): Promise<CertificateItem[]>;
  /** O proxy consegue perguntar ao painel? */
  routing(): { ready: boolean; reason: string | null };
  audit?: { record(input: { actor?: string; action: string; target?: string | null; detail: string }): Promise<unknown> };
  log?: (message: string) => void;
  now?: () => number;
  /** Atraso para juntar vários cadastros seguidos numa recarga só (padrão 3 s). */
  refreshDelayMs?: number;
  /**
   * O nome aponta (A/AAAA, seguindo CNAME) para esta VPS? Conferido antes de gastar uma emissão nova.
   * Sem esta função a conferência não existe (só testes); em produção ela sempre vem do app.
   */
  pointsHere?(host: string): Promise<boolean>;
  /** Nomes de sites FIXOS (painel, e-mail, projetos) um nível abaixo do sufixo, com o projeto dono (null = painel/e-mail). */
  fixedHostsUnder?(suffix: string): Promise<Array<{ host: string; projectId: string | null }>>;
  /** Base do domínio de aplicações (apps.example.com), se houver: nenhum sufixo pode se confundir com ela. */
  appsBase?(): Promise<string | null>;
  /** O arquivo de estado está ilegível: avisa a pessoa (alerta). */
  onUnreadable?(message: string): void;
}

const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * 24 * HOUR_MS;
const MAX_TRACKED_ATTEMPTS = 5_000;

function serialize(data: StateFile): string {
  return JSON.stringify(data, null, 2) + "\n";
}

function emptyFile(): StateFile {
  return { version: 1, settings: {}, projects: {} };
}

function validName(n: unknown): n is StoredName {
  if (!n || typeof n !== "object") return false;
  const r = n as Record<string, unknown>;
  return (
    typeof r.host === "string" &&
    checkDynamicHost(r.host).ok &&
    typeof r.addedAt === "string" &&
    typeof r.addedBy === "string" &&
    (r.issuedAt === undefined || typeof r.issuedAt === "string")
  );
}

function validSuffix(s: unknown): s is DynamicSuffix {
  if (!s || typeof s !== "object") return false;
  const r = s as Record<string, unknown>;
  return typeof r.suffix === "string" && checkDynamicSuffix(r.suffix).ok && typeof r.openAll === "boolean";
}

function parseFile(raw: unknown): StateFile | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || !r.projects || typeof r.projects !== "object" || Array.isArray(r.projects)) return null;
  const settings = r.settings && typeof r.settings === "object" ? (r.settings as Record<string, unknown>) : {};
  const projects: Record<string, StoredProject> = {};
  for (const [id, value] of Object.entries(r.projects as Record<string, unknown>)) {
    const p = value as Partial<StoredProject> | null;
    if (!p || !Array.isArray(p.suffixes) || !Array.isArray(p.names) || !p.suffixes.every(validSuffix) || !p.names.every(validName)) {
      return null;
    }
    projects[id] = { suffixes: p.suffixes.map((s) => ({ suffix: s.suffix, openAll: s.openAll })), names: p.names.map((n) => ({ ...n })) };
  }
  return { version: 1, settings: limitsFromDisk(settings), projects };
}

/** Teto gravado fora da faixa (arquivo editado à mão) é ignorado: vale o padrão. */
function limitsFromDisk(raw: Record<string, unknown>): Partial<DynamicDomainLimits> {
  const out: Partial<DynamicDomainLimits> = {};
  for (const key of ["maxNamesPerProject", "maxIssuancesPerHour", "maxIssuancesPerWeekPerDomain"] as const) {
    const v = raw[key];
    const range = DYNAMIC_DOMAIN_LIMIT_RANGE[key];
    if (typeof v === "number" && Number.isInteger(v) && v >= range.min && v <= range.max) out[key] = v;
  }
  return out;
}

/** Última lista boa do que o proxy precisa (nomes e sufixos): o Caddyfile não perde os clientes se o arquivo ficar ilegível. */
const LAST_GOOD_FILE = "dynamic-domains.lastgood.json";

export interface DynamicViewQuery {
  q?: string | undefined;
  state?: DynamicNameState | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

export class DynamicDomainsService {
  private readonly file: string;
  private data: StateFile = emptyFile();
  private loading: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  /** host → projeto, para o `ask` responder sem varrer a lista. */
  private byHost = new Map<string, string>();
  /** sufixo → dono, idem. */
  private bySuffix = new Map<string, { projectId: string; openAll: boolean }>();
  /** Pedidos de emissão que contaram na cota (últimas 1 h). */
  private grants: number[] = [];
  /** host → instantes das tentativas novas (última 1 h). */
  private attempts = new Map<string, number[]>();
  /** domínio registrável → instantes das emissões novas (últimos 7 dias). */
  private weekly = new Map<string, number[]>();
  /** projeto → nomes de sufixo aberto cuja vaga no teto já está reservada (corrida entre consultas). */
  private pending = new Map<string, Set<string>>();
  private readonly lastGoodFile: string;
  private refreshTimer: NodeJS.Timeout | null = null;
  /** Texto do estado como está no disco: gravação que não muda nada é pulada. */
  private lastText = "";

  constructor(private readonly deps: DynamicDomainsDeps) {
    this.file = path.join(deps.dataDir, "dynamic-domains.json");
    this.lastGoodFile = path.join(deps.dataDir, LAST_GOOD_FILE);
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => undefined);
  }

  // ---------------------------------------------------------------------------
  // Carga e gravação
  // ---------------------------------------------------------------------------

  private ensureLoaded(): Promise<void> {
    this.loading ??= loadJson<StateFile>(this.file, {
      empty: emptyFile,
      parse: parseFile,
      strict: true,
      recovery:
        "Restaure uma cópia dele (um backup do painel). Enquanto isso nenhum certificado novo de domínio dinâmico é emitido, e o painel mantém no proxy a última lista boa que guardou (dynamic-domains.lastgood.json).",
    })
      .then((data) => {
        this.data = data;
        this.lastText = serialize(data);
        this.reindex();
        this.saveLastGood(this.lastText);
      })
      .catch((err: unknown) => {
        this.loading = null; // a próxima chamada tenta de novo
        throw err;
      });
    return this.loading;
  }

  private reindex(): void {
    this.byHost = new Map();
    this.bySuffix = new Map();
    for (const [projectId, p] of Object.entries(this.data.projects)) {
      for (const n of p.names) this.byHost.set(n.host, projectId);
      for (const s of p.suffixes) this.bySuffix.set(s.suffix, { projectId, openAll: s.openAll });
    }
  }

  /** Aplica `change` ao estado e grava; se a gravação falhar, o estado volta ao que era. */
  private persist<T>(change: (data: StateFile) => T): Promise<T> {
    const run = this.writing.then(async () => {
      const before = this.data;
      const draft: StateFile = structuredClone(before);
      let result: T;
      try {
        result = change(draft);
      } catch (err) {
        this.data = before;
        throw err;
      }
      const text = serialize(draft);
      if (text === this.lastText) return result;
      this.data = draft;
      this.reindex();
      try {
        await writeFileAtomic(this.file, text);
        this.lastText = text;
        this.saveLastGood(text);
      } catch (err) {
        this.data = before;
        this.reindex();
        throw httpError(500, "storage_write_failed", "Não foi possível salvar os domínios dinâmicos no disco do servidor. Nada foi alterado.");
      }
      return result;
    });
    this.writing = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Cópia da última lista boa (melhor esforço): só serve ao Caddyfile quando o arquivo principal está ilegível. */
  private saveLastGood(text: string): void {
    writeFileAtomic(this.lastGoodFile, text).catch((err: unknown) => this.log(`domínios dinâmicos: cópia da última lista boa não gravada (${msg(err)})`));
  }

  async flush(): Promise<void> {
    await this.writing;
  }

  // ---------------------------------------------------------------------------
  // Tetos
  // ---------------------------------------------------------------------------

  async limits(): Promise<DynamicDomainLimits> {
    await this.ensureLoaded();
    return this.currentLimits();
  }

  private currentLimits(): DynamicDomainLimits {
    return { ...DYNAMIC_DOMAIN_LIMIT_DEFAULTS, ...this.data.settings };
  }

  /** Muda os tetos (só a pessoa, na tela). Valor fora da faixa é recusado, nunca ajustado em silêncio. */
  async setLimits(input: Partial<DynamicDomainLimits>): Promise<DynamicDomainLimits> {
    for (const key of ["maxNamesPerProject", "maxIssuancesPerHour", "maxIssuancesPerWeekPerDomain"] as const) {
      const v = input[key];
      if (v === undefined) continue;
      const { min, max } = DYNAMIC_DOMAIN_LIMIT_RANGE[key];
      if (!Number.isInteger(v) || v < min || v > max) {
        throw httpError(400, "invalid_dynamic_limit", `Valor fora da faixa: ${LIMIT_LABEL[key]} de ${min} a ${max}.`);
      }
    }
    await this.ensureLoaded();
    const before = this.currentLimits();
    const after = await this.persist((data) => {
      data.settings = { ...data.settings, ...definedOnly(input) };
      return { ...DYNAMIC_DOMAIN_LIMIT_DEFAULTS, ...data.settings };
    });
    await this.audit(
      "domain.dynamic_limits",
      null,
      `Tetos dos domínios dinâmicos: ${before.maxNamesPerProject} → ${after.maxNamesPerProject} nomes por projeto, ${before.maxIssuancesPerHour} → ${after.maxIssuancesPerHour} emissões por hora, ${before.maxIssuancesPerWeekPerDomain} → ${after.maxIssuancesPerWeekPerDomain} por semana por domínio.`,
    );
    return after;
  }

  // ---------------------------------------------------------------------------
  // Cadastro
  // ---------------------------------------------------------------------------

  private project(id: string): StoredProject {
    return this.data.projects[id] ?? { suffixes: [], names: [] };
  }

  /** O nome está sob um sufixo do projeto (um nível)? */
  private coveredBy(projectId: string, host: string): boolean {
    return this.project(projectId).suffixes.some((s) => isOneLevelUnder(host, s.suffix));
  }

  /** Projeto que tem um sufixo cobrindo o nome (um nível), ou null. */
  private suffixOwner(host: string): { projectId: string; openAll: boolean } | null {
    const dot = host.indexOf(".");
    return dot > 0 ? (this.bySuffix.get(host.slice(dot + 1)) ?? null) : null;
  }

  async add(projectId: string, raw: unknown): Promise<{ item: DynamicDomainItem; created: boolean }> {
    const check = checkDynamicHost(raw);
    if (!check.ok) {
      const err = httpError(400, "invalid_dynamic_host", check.message);
      err.details = { issue: check.issue };
      throw err;
    }
    const host = check.host;
    await this.requireProject(projectId);
    await this.ensureLoaded();
    const owner = this.suffixOwner(host);
    if (owner && owner.projectId !== projectId) throw domainInUse(host);
    if (await this.deps.staticOccupant(host)) throw domainInUse(host);
    const limit = this.currentLimits().maxNamesPerProject;
    const addedBy = currentActor() ?? "painel";
    // a conferência de duplicado repete DENTRO da gravação: dois cadastros do mesmo nome ao mesmo tempo
    const { record, created } = await this.persist((data) => {
      for (const [id, p] of Object.entries(data.projects)) {
        const found = p.names.find((n) => n.host === host);
        if (!found) continue;
        if (id === projectId) return { record: found, created: false };
        throw domainInUse(host);
      }
      const p = (data.projects[projectId] ??= { suffixes: [], names: [] });
      if (p.names.length >= limit) {
        throw httpError(409, "dynamic_limit_reached", `Este projeto já tem ${limit} domínios dinâmicos (o teto atual). Remova algum ou aumente o teto em Configurações → Domínios dinâmicos.`);
      }
      const named: StoredName = { host, addedAt: new Date(this.now()).toISOString(), addedBy };
      p.names.push(named);
      return { record: named, created: true };
    });
    if (!created) return { item: this.itemOf(projectId, record), created: false };
    if (!this.coveredBy(projectId, host)) this.scheduleRefresh();
    await this.audit("domain.dynamic_added", projectId, `Domínio dinâmico ${host} cadastrado no projeto ${projectId}.`);
    return { item: this.itemOf(projectId, record), created: true };
  }

  async remove(projectId: string, raw: unknown): Promise<void> {
    const host = typeof raw === "string" ? cleanHost(raw) : "";
    await this.requireProject(projectId);
    await this.ensureLoaded();
    if (!host || this.byHost.get(host) !== projectId) {
      throw httpError(404, "domain_not_found", "Esse domínio dinâmico não está cadastrado neste projeto.");
    }
    const covered = this.coveredBy(projectId, host);
    await this.persist((data) => {
      const p = data.projects[projectId]!;
      p.names = p.names.filter((n) => n.host !== host);
    });
    // as tentativas do nome NÃO são zeradas: remover e cadastrar de novo não burla o limite por nome
    if (!covered) this.scheduleRefresh();
    await this.audit("domain.dynamic_removed", projectId, `Domínio dinâmico ${host} removido do projeto ${projectId}.`);
  }

  async suffixes(projectId: string): Promise<DynamicSuffix[]> {
    await this.requireProject(projectId);
    await this.ensureLoaded();
    return this.project(projectId).suffixes.map((s) => ({ ...s }));
  }

  /** Troca a lista de sufixos do projeto (só a pessoa). Sufixo de outro projeto é recusado. */
  async setSuffixes(projectId: string, input: DynamicSuffix[]): Promise<DynamicSuffix[]> {
    await this.requireProject(projectId);
    await this.ensureLoaded();
    const list: DynamicSuffix[] = [];
    for (const item of input) {
      const check = checkDynamicSuffix(item.suffix);
      if (!check.ok) {
        const err = httpError(400, "invalid_dynamic_suffix", check.message);
        err.details = { issue: check.issue };
        throw err;
      }
      if (list.some((s) => s.suffix === check.host)) continue;
      list.push({ suffix: check.host, openAll: item.openAll === true });
    }
    if (list.length > DYNAMIC_MAX_SUFFIXES) {
      throw httpError(400, "invalid_dynamic_suffix", `No máximo ${DYNAMIC_MAX_SUFFIXES} sufixos por projeto.`);
    }
    const appsBase = (await this.deps.appsBase?.()) ?? null;
    for (const s of list) {
      const owner = this.bySuffix.get(s.suffix);
      if ((owner && owner.projectId !== projectId) || (await this.deps.staticOccupant(s.suffix)) === "panel") throw domainInUse(s.suffix);
      // o curinga tomaria o tráfego de um nome que outro projeto já tem um nível abaixo dele
      for (const [host, id] of this.byHost) {
        if (id !== projectId && isOneLevelUnder(host, s.suffix)) throw suffixCovers(s.suffix, host);
      }
      for (const fixed of (await this.deps.fixedHostsUnder?.(s.suffix)) ?? []) {
        if (fixed.projectId !== projectId) throw suffixCovers(s.suffix, fixed.host);
      }
      if (appsBase && (s.suffix === appsBase || s.suffix.endsWith(`.${appsBase}`) || appsBase.endsWith(`.${s.suffix}`))) {
        throw httpError(409, "domain_in_use", `O sufixo ${s.suffix} se confunde com o domínio de aplicações (${appsBase}). Use outro domínio.`);
      }
    }
    const before = this.project(projectId).suffixes;
    const same = before.length === list.length && before.every((b) => list.some((l) => l.suffix === b.suffix && l.openAll === b.openAll));
    if (same) return before.map((s) => ({ ...s }));
    await this.persist((data) => {
      (data.projects[projectId] ??= { suffixes: [], names: [] }).suffixes = list;
    });
    this.scheduleRefresh();
    await this.audit(
      "domain.dynamic_suffixes",
      projectId,
      `Sufixos dos domínios dinâmicos do projeto ${projectId}: ${list.length === 0 ? "nenhum" : list.map((s) => `*.${s.suffix}${s.openAll ? " (aberto)" : ""}`).join(", ")}.`,
    );
    return list.map((s) => ({ ...s }));
  }

  /** Projeto apagado: os nomes e sufixos dele saem (o Caddyfile já foi refeito sem o projeto). */
  async forgetProject(projectId: string): Promise<void> {
    await this.ensureLoaded();
    if (!this.data.projects[projectId]) return;
    await this.persist((data) => {
      delete data.projects[projectId];
    });
  }

  private async requireProject(id: string): Promise<void> {
    if (!(await this.deps.projectExists(id))) throw httpError(404, "project_not_found", "Projeto não encontrado.");
  }

  private async audit(action: string, target: string | null, detail: string): Promise<void> {
    await this.deps.audit?.record({ action, target, detail }).catch((err: unknown) => this.log(`domínios dinâmicos: auditoria não gravada (${msg(err)})`));
  }

  // ---------------------------------------------------------------------------
  // Proxy
  // ---------------------------------------------------------------------------

  /** Junta cadastros seguidos numa recarga só do Caddy; falha é registrada (o próximo ajuste tenta de novo). */
  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.deps.refreshProxy().catch((err: unknown) => this.log(`domínios dinâmicos: o proxy não foi recarregado (${msg(err)})`));
    }, this.deps.refreshDelayMs ?? 3_000);
    this.refreshTimer.unref();
  }

  /** Cancela a recarga pendente (desligamento). */
  close(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  /**
   * O que o Caddyfile precisa: por projeto, os sufixos e os nomes avulsos (os
   * que já estão sob um sufixo do projeto não entram: o curinga os atende).
   */
  async proxyProjects(): Promise<Array<{ projectId: string; suffixes: string[]; hosts: string[] }>> {
    let projects = this.data.projects;
    try {
      await this.ensureLoaded();
      projects = this.data.projects;
    } catch (err) {
      // arquivo ilegível: o Caddyfile mantém a última lista boa (os clientes não saem do ar) e a pessoa é avisada
      this.deps.onUnreadable?.(msg(err));
      const good = await this.readLastGood();
      if (!good) throw err;
      projects = good.projects;
    }
    const out: Array<{ projectId: string; suffixes: string[]; hosts: string[] }> = [];
    for (const [projectId, p] of Object.entries(projects)) {
      const suffixes = p.suffixes.map((s) => s.suffix);
      const hosts = p.names.map((n) => n.host).filter((h) => !suffixes.some((s) => isOneLevelUnder(h, s)));
      if (suffixes.length > 0 || hosts.length > 0) out.push({ projectId, suffixes, hosts });
    }
    return out;
  }

  private async readLastGood(): Promise<StateFile | null> {
    try {
      return parseFile(JSON.parse(await readFile(this.lastGoodFile, "utf8")));
    } catch {
      return null;
    }
  }

  /** Nomes cadastrados, com o projeto dono (tela Certificados e alertas). */
  async names(): Promise<Array<{ host: string; projectId: string }>> {
    await this.ensureLoaded();
    return [...this.byHost.entries()].map(([host, projectId]) => ({ host, projectId }));
  }

  /** Carrega o arquivo já no boot (um arquivo ilegível é só registrado: o `ask` segue negando). */
  async preload(): Promise<void> {
    await this.ensureLoaded().catch((err: unknown) => this.log(`domínios dinâmicos: ${msg(err)}`));
  }

  /** Alguém usa este nome como domínio dinâmico cadastrado? Impede o mesmo nome num site fixo. Sem carga: falso. */
  claimsSync(host: string): boolean {
    return this.byHost.has(host);
  }

  // ---------------------------------------------------------------------------
  // O `ask` do Caddy
  // ---------------------------------------------------------------------------

  /** Pode o Caddy emitir (ou renovar) o certificado deste nome? */
  async authorize(raw: string): Promise<AskDecision> {
    const host = cleanHost(raw);
    if (!host || !checkDynamicHost(host).ok) return { allow: false, reason: "invalid" };
    await this.ensureLoaded();
    let projectId = this.byHost.get(host) ?? null;
    let implicit = false;
    if (projectId === null) {
      const owner = this.suffixOwner(host);
      if (!owner?.openAll) return { allow: false, reason: "unknown" };
      projectId = owner.projectId;
      implicit = true;
    }
    if (await this.deps.staticOccupant(host)) return { allow: false, reason: "reserved" };
    // projeto apagado (mesmo que a limpeza dos nomes tenha falhado): nada é autorizado
    if (!(await this.deps.projectExists(projectId))) return { allow: false, reason: "unknown" };
    const needsQuota = !this.project(projectId).names.find((n) => n.host === host)?.issuedAt;
    // o DNS é conferido ANTES de gastar cota: nome que ainda não aponta para a VPS não consome emissão
    if (needsQuota && this.deps.pointsHere && !(await this.deps.pointsHere(host))) return { allow: false, reason: "dns" };

    // daqui até a resposta não há mais espera antes da reserva: a vaga no teto é tomada de forma atômica
    const limits = this.currentLimits();
    const reserved = implicit ? this.reserveSlot(projectId, host, limits.maxNamesPerProject) : true;
    if (!reserved) return { allow: false, reason: "name_limit" };
    try {
      if (needsQuota) {
        const verdict = this.spendQuota(host, limits);
        if (verdict) return { allow: false, reason: verdict };
      }
      if (implicit) await this.registerImplicit(projectId, host);
      return { allow: true };
    } finally {
      if (implicit) this.releaseSlot(projectId, host);
    }
  }

  /** Reserva uma vaga no teto para um nome de sufixo aberto (síncrono: duas consultas paralelas não passam juntas do teto). */
  private reserveSlot(projectId: string, host: string, max: number): boolean {
    const set = this.pending.get(projectId) ?? new Set<string>();
    const names = this.project(projectId).names;
    const registered = names.some((n) => n.host === host);
    // vaga reservada cujo nome já entrou na lista não conta duas vezes
    const used = names.length + [...set].filter((h) => h !== host && !names.some((n) => n.host === h)).length;
    if (!registered && used >= max) return false;
    set.add(host);
    this.pending.set(projectId, set);
    return true;
  }

  private releaseSlot(projectId: string, host: string): void {
    const set = this.pending.get(projectId);
    set?.delete(host);
    if (set?.size === 0) this.pending.delete(projectId);
  }

  /** Cota de emissões novas. Devolve o motivo da recusa, ou null (e gasta a cota). */
  private spendQuota(host: string, limits: DynamicDomainLimits): AskReason | null {
    const perHour = limits.maxIssuancesPerHour;
    const t = this.now();
    const domain = apexOf(host) ?? host;
    const week = (this.weekly.get(domain) ?? []).filter((w) => w > t - WEEK_MS);
    this.grants = this.grants.filter((g) => g > t - HOUR_MS);
    const tries = (this.attempts.get(host) ?? []).filter((a) => a > t - HOUR_MS);
    // concorrência no primeiro acesso: o mesmo pedido chega várias vezes, conta uma só
    if (tries.length > 0 && t - tries[tries.length - 1]! < DYNAMIC_SAME_ATTEMPT_MS) return null;
    if (tries.length >= DYNAMIC_MAX_ATTEMPTS_PER_NAME_HOUR) return "name_cooldown";
    if (this.grants.length >= perHour) return "hourly_limit";
    // o Let's Encrypt barra 50 certificados por domínio registrado a cada 7 dias
    if (week.length >= limits.maxIssuancesPerWeekPerDomain) return "weekly_limit";
    this.grants.push(t);
    tries.push(t);
    week.push(t);
    this.attempts.set(host, tries);
    this.weekly.set(domain, week);
    if (this.attempts.size > MAX_TRACKED_ATTEMPTS) this.pruneAttempts(t);
    if (this.weekly.size > MAX_TRACKED_ATTEMPTS) this.pruneWeekly(t);
    return null;
  }

  private pruneWeekly(t: number): void {
    for (const [domain, list] of this.weekly) {
      if (!list.some((w) => w > t - WEEK_MS)) this.weekly.delete(domain);
    }
  }

  private pruneAttempts(t: number): void {
    for (const [host, list] of this.attempts) {
      if (!list.some((a) => a > t - HOUR_MS)) this.attempts.delete(host);
    }
  }

  /** Nome autorizado por sufixo aberto entra na lista do projeto (conta no teto e aparece na tela). */
  private async registerImplicit(projectId: string, host: string): Promise<void> {
    const limit = this.currentLimits().maxNamesPerProject;
    try {
      await this.persist((data) => {
        const p = (data.projects[projectId] ??= { suffixes: [], names: [] });
        if (p.names.some((n) => n.host === host) || p.names.length >= limit) return;
        p.names.push({ host, addedAt: new Date(this.now()).toISOString(), addedBy: "acesso" });
      });
    } catch (err) {
      this.log(`domínios dinâmicos: nome autorizado não gravado (${msg(err)})`);
    }
  }

  /**
   * Nomes cujo certificado o painel já viu emitido: dali em diante o `ask` não
   * gasta cota (renovação). Recebe o que o Caddy guarda; null (não deu para ler) não faz nada.
   */
  async reconcileIssued(certs: Map<string, CertificateStatus> | null): Promise<number> {
    if (!certs) return 0;
    await this.ensureLoaded();
    const t = this.now();
    const known = (h: string) => this.project(this.byHost.get(h)!).names.find((n) => n.host === h);
    const fresh = [...this.byHost.keys()].filter((h) => {
      const c = certs.get(h);
      return c?.ok === true && c.validTo !== null && Date.parse(c.validTo) > t && !known(h)?.issuedAt;
    });
    // certificado visto VENCIDO: deixa de ser "renovação" e volta a gastar cota (e a respeitar o limite por nome)
    const lapsed = [...this.byHost.keys()].filter((h) => {
      const c = certs.get(h);
      return known(h)?.issuedAt !== undefined && c !== undefined && c.validTo !== null && Date.parse(c.validTo) <= t;
    });
    if (fresh.length === 0 && lapsed.length === 0) return 0;
    const stamp = new Date(t).toISOString();
    await this.persist((data) => {
      for (const p of Object.values(data.projects)) {
        for (const n of p.names) {
          if (fresh.includes(n.host)) n.issuedAt = stamp;
          else if (lapsed.includes(n.host)) delete n.issuedAt;
        }
      }
    });
    return fresh.length + lapsed.length;
  }

  // ---------------------------------------------------------------------------
  // Tela
  // ---------------------------------------------------------------------------

  private itemOf(projectId: string, n: StoredName, cert?: CertificateItem): DynamicDomainItem {
    return {
      host: n.host,
      addedAt: n.addedAt,
      addedBy: n.addedBy,
      via: this.coveredBy(projectId, n.host) ? "suffix" : "own",
      state: cert ? stateOf(cert) : "waiting",
      message: cert ? (cert.lastError?.message ?? cert.failure?.error?.message ?? null) : null,
      validTo: cert?.validTo ?? null,
    };
  }

  async view(projectId: string, query: DynamicViewQuery = {}, opts: { hideGlobalUsage?: boolean } = {}): Promise<DynamicDomainsResponse> {
    await this.requireProject(projectId);
    await this.ensureLoaded();
    const p = this.project(projectId);
    const certs = new Map<string, CertificateItem>();
    if (p.names.length > 0) {
      for (const c of await this.deps.inspect(projectId, new Set(p.names.map((n) => n.host)))) certs.set(c.host, c);
    }
    const all = p.names.map((n) => this.itemOf(projectId, n, certs.get(n.host)));
    const counters = Object.fromEntries(DYNAMIC_NAME_STATES.map((s) => [s, 0])) as DynamicDomainCounters;
    counters.total = all.length;
    for (const i of all) counters[i.state] += 1;
    const q = query.q?.trim().toLowerCase() ?? "";
    const filtered = all
      .filter((i) => (q === "" || i.host.includes(q)) && (query.state === undefined || i.state === query.state))
      .sort((a, b) => b.addedAt.localeCompare(a.addedAt) || a.host.localeCompare(b.host));
    const pageSize = query.pageSize ?? 50;
    const lastPage = Math.max(1, Math.ceil(filtered.length / pageSize));
    const page = Math.min(Math.max(1, query.page ?? 1), lastPage);
    this.grants = this.grants.filter((g) => g > this.now() - HOUR_MS);
    return {
      suffixes: p.suffixes.map((s) => ({ ...s })),
      limits: this.currentLimits(),
      usage: { names: all.length, issuancesLastHour: opts.hideGlobalUsage ? null : this.grants.length },
      counters,
      routing: this.deps.routing(),
      items: filtered.slice((page - 1) * pageSize, page * pageSize),
      total: filtered.length,
      page,
      pageSize,
    };
  }

  /** Um nome só, para o app do cliente acompanhar "aguardando DNS" → "válido". */
  async one(projectId: string, raw: string): Promise<DynamicDomainItem> {
    await this.requireProject(projectId);
    await this.ensureLoaded();
    const host = cleanHost(raw);
    const n = this.project(projectId).names.find((x) => x.host === host);
    if (!host || !n) throw httpError(404, "domain_not_found", "Esse domínio dinâmico não está cadastrado neste projeto.");
    const [cert] = await this.deps.inspect(projectId, new Set([host]));
    return this.itemOf(projectId, n, cert);
  }
}

/** Estado da tela a partir do item de Certificados (proxy parado não prova nada: aguardando). */
function stateOf(cert: CertificateItem): DynamicNameState {
  switch (cert.state) {
    case "valid":
    case "expiring":
    case "expired":
    case "issuing":
    case "failed":
      return cert.state;
    default:
      return "waiting";
  }
}

function suffixCovers(suffix: string, host: string) {
  return httpError(409, "domain_in_use", `O sufixo ${suffix} passaria a cobrir ${host}, que já é de outro projeto ou site. Remova o nome de lá antes.`);
}

function domainInUse(host: string) {
  return httpError(409, "domain_in_use", `O domínio ${host} já está em uso.`);
}

const LIMIT_LABEL: Record<keyof DynamicDomainLimits, string> = {
  maxNamesPerProject: "nomes por projeto",
  maxIssuancesPerHour: "emissões por hora",
  maxIssuancesPerWeekPerDomain: "emissões por semana por domínio",
};

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function definedOnly(input: Partial<DynamicDomainLimits>): Partial<DynamicDomainLimits> {
  const out: Partial<DynamicDomainLimits> = {};
  if (input.maxNamesPerProject !== undefined) out.maxNamesPerProject = input.maxNamesPerProject;
  if (input.maxIssuancesPerHour !== undefined) out.maxIssuancesPerHour = input.maxIssuancesPerHour;
  if (input.maxIssuancesPerWeekPerDomain !== undefined) out.maxIssuancesPerWeekPerDomain = input.maxIssuancesPerWeekPerDomain;
  return out;
}
