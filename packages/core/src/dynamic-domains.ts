/**
 * dynamic-domains.ts — "Domínios dinâmicos" do projeto (SaaS multi-cliente).
 *
 * Um projeto pode atender centenas de nomes que ele mesmo não conhece de
 * antemão: subdomínios do próprio SaaS (cliente1.example.com) e domínios
 * próprios dos clientes (app.cliente.example), apontados por CNAME/A para a
 * VPS. Cada nome ganha o próprio certificado, emitido SOB DEMANDA no primeiro
 * acesso (Caddy on-demand TLS); quem autoriza a emissão é o painel (endpoint
 * `ask`), que só diz "sim" para nome registrado em algum projeto.
 *
 * Este arquivo reúne o que servidor, proxy e tela compartilham: limites,
 * validação do nome e do sufixo, e o formato das respostas da API.
 */
import { apexOf, cleanHost, isPublicSuffix } from "./domain-pair";

/** Tetos padrão e a faixa que a pessoa pode ajustar (Configurações → Domínios dinâmicos). */
export const DYNAMIC_DOMAIN_LIMIT_DEFAULTS = { maxNamesPerProject: 500, maxIssuancesPerHour: 20 } as const;
export const DYNAMIC_DOMAIN_LIMIT_RANGE = {
  maxNamesPerProject: { min: 10, max: 5000 },
  maxIssuancesPerHour: { min: 1, max: 100 },
} as const;

/** Sufixos permitidos por projeto (cada um vira um bloco curinga no proxy). */
export const DYNAMIC_MAX_SUFFIXES = 10;

/** Uma emissão nova do mesmo nome fora dessa janela conta como tentativa nova; dentro dela, é o mesmo pedido. */
export const DYNAMIC_SAME_ATTEMPT_MS = 60_000;
/** Tentativas novas do MESMO nome por hora (o Let's Encrypt barra 5 falhas por hora por nome). */
export const DYNAMIC_MAX_ATTEMPTS_PER_NAME_HOUR = 3;

export interface DynamicDomainLimits {
  maxNamesPerProject: number;
  maxIssuancesPerHour: number;
}

export type DynamicHostIssue =
  | "invalid"
  | "wildcard"
  | "ip"
  | "single_label"
  | "local"
  | "public_suffix"
  | "bad_suffix";

export type DynamicHostCheck = { ok: true; host: string } | { ok: false; issue: DynamicHostIssue; message: string };

/** Terminações que nunca recebem certificado público (uso local, interno ou reservado). */
const LOCAL_TLDS: readonly string[] = ["localhost", "local", "internal", "invalid", "test", "lan", "home", "corp", "intranet", "onion", "arpa"];

const fail = (issue: DynamicHostIssue, message: string): DynamicHostCheck => ({ ok: false, issue, message });

/**
 * Confere um NOME de domínio (avulso ou dentro de um sufixo). Normaliza
 * (minúsculas, sem ponto final, Unicode vira punycode) e recusa o que nunca
 * poderia ter certificado público ou que quebraria o proxy: curinga, IP,
 * nome sem ponto, localhost e terminações reservadas, sufixo público (com.br)
 * e qualquer coisa que não seja um hostname puro (URL, porta, caminho).
 */
export function checkDynamicHost(raw: unknown): DynamicHostCheck {
  if (typeof raw !== "string" || raw.trim() === "" || raw.length > 400) {
    return fail("invalid", "Informe um nome de domínio, por exemplo app.cliente.example.");
  }
  if (raw.includes("*")) {
    return fail("wildcard", "Curinga (*) não vale para um nome avulso. Para aceitar subdomínios de um sufixo seu, cadastre o sufixo.");
  }
  const host = cleanHost(raw);
  if (!host) return fail("invalid", "Nome inválido. Informe só o domínio, sem http://, porta ou caminho. Exemplo: app.cliente.example.");
  const labels = host.split(".");
  if (labels.length < 2) return fail("single_label", "O nome precisa ter ao menos um ponto (por exemplo app.cliente.example).");
  const tld = labels[labels.length - 1]!;
  if (/^\d+$/.test(tld)) return fail("ip", "Endereço IP não recebe certificado. Informe um nome de domínio.");
  if (LOCAL_TLDS.includes(tld)) {
    return fail("local", `Nomes terminados em .${tld} são de uso local ou reservado e não recebem certificado público.`);
  }
  if (isPublicSuffix(host)) return fail("public_suffix", "Esse nome é um sufixo público (como com.br), não um domínio de alguém.");
  return { ok: true, host };
}

/**
 * Confere um SUFIXO (`example.com` ou `*.example.com`, a base dos subdomínios
 * de um nível). Além das regras do nome: precisa estar sob um domínio
 * registrável conhecido pela Public Suffix List (nada de `*.com.br` nem de
 * hospedagem compartilhada como herokuapp.com).
 */
export function checkDynamicSuffix(raw: unknown): DynamicHostCheck {
  const text = typeof raw === "string" ? raw.trim().replace(/^\*\./, "") : raw;
  const base = checkDynamicHost(text);
  if (!base.ok) return base;
  if (apexOf(base.host) === null) {
    return fail("bad_suffix", "Não consigo confirmar que esse domínio é seu (sufixo público ou hospedagem compartilhada). Use um domínio registrado por você.");
  }
  return base;
}

/** O nome é exatamente UM nível acima do sufixo (x.example.com para example.com)? */
export function isOneLevelUnder(host: string, suffix: string): boolean {
  if (!host.endsWith(`.${suffix}`)) return false;
  const prefix = host.slice(0, host.length - suffix.length - 1);
  return prefix.length > 0 && !prefix.includes(".");
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/** Um sufixo do projeto: `example.com` libera `x.example.com`, um certificado por nome. */
export interface DynamicSuffix {
  suffix: string;
  /**
   * true = qualquer subdomínio de um nível é autorizado sem cadastro prévio
   * (o primeiro acesso cadastra). false = o nome precisa ser cadastrado antes.
   */
  openAll: boolean;
}

/**
 * - valid / expiring / expired: já há certificado (renova sozinho);
 * - issuing: o Caddy está tentando emitir agora;
 * - failed: a última tentativa falhou (a causa vem traduzida);
 * - waiting: aguardando o DNS apontar para a VPS e o primeiro acesso (a emissão só acontece nele).
 */
export type DynamicNameState = "valid" | "expiring" | "expired" | "issuing" | "failed" | "waiting";

export const DYNAMIC_NAME_STATES: readonly DynamicNameState[] = ["waiting", "issuing", "valid", "expiring", "expired", "failed"];

export interface DynamicDomainItem {
  host: string;
  addedAt: string;
  /** Quem cadastrou: o usuário do painel, `token:<nome>` ou `acesso` (sufixo aberto). */
  addedBy: string;
  /** Roteado pelo bloco do sufixo (sem recarregar o proxy) ou por bloco próprio. */
  via: "suffix" | "own";
  state: DynamicNameState;
  /** Causa traduzida quando falhou; null nos demais estados. */
  message: string | null;
  validTo: string | null;
}

export type DynamicDomainCounters = Record<DynamicNameState, number> & { total: number };

export interface DynamicDomainsResponse {
  suffixes: DynamicSuffix[];
  limits: DynamicDomainLimits;
  usage: { names: number; issuancesLastHour: number };
  counters: DynamicDomainCounters;
  /** O proxy consegue perguntar ao painel? Sem isso nenhum certificado novo sai. */
  routing: { ready: boolean; reason: string | null };
  items: DynamicDomainItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AddDynamicDomainRequest {
  host: string;
}

export interface AddDynamicDomainResponse {
  item: DynamicDomainItem;
}

export interface UpdateDynamicSuffixesRequest {
  suffixes: DynamicSuffix[];
}

export interface DynamicDomainSettingsResponse {
  limits: DynamicDomainLimits;
  defaults: DynamicDomainLimits;
  range: typeof DYNAMIC_DOMAIN_LIMIT_RANGE;
}

export const DYNAMIC_PAGE_SIZES = [25, 50, 100] as const;
