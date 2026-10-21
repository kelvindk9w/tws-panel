/**
 * apps-domain.ts — Configurações → Domínio de aplicações.
 *
 * Os endereços automáticos dos projetos nascem como
 * <projeto>.<ip-com-hífens>.sslip.io: o IP da VPS fica à vista. Com um
 * domínio de aplicações (ex.: apps.example.com) a pessoa cria UM registro
 * curinga (*.apps.example.com) apontando para a VPS, o painel confere o DNS e
 * passa a gerar <projeto>-<sufixo>.apps.example.com. Cada projeto continua com
 * a sua rota explícita no proxy: não há certificado curinga nem emissão sob
 * demanda para nomes desconhecidos.
 */
import type { PanelDomainDnsProblem } from "./panel-domain";

export type AppsDomainDnsProblem = PanelDomainDnsProblem;

/** Resultado da conferência do registro curinga (um nome aleatório sob a base). */
export interface AppsDomainDnsCheck {
  /** Base conferida (apps.example.com). */
  base: string;
  /** Nome aleatório consultado (paas-check-<aleatório>.<base>). */
  probe: string;
  ok: boolean;
  problem: AppsDomainDnsProblem;
  ipv4: string[];
  ipv6: string[];
  /** IP que o registro curinga deve ter (o da VPS). */
  expectedIp: string | null;
  /** Explicação para leigo (pt-BR). */
  message: string;
  checkedAt: string;
}

/** Um registro DNS que a pessoa precisa criar. */
export interface AppsDomainRecord {
  type: "A" | "AAAA";
  /** Nome completo do registro curinga (*.apps.example.com). */
  name: string;
  value: string;
}

/** GET /api/settings/apps-domain (e resposta das ações). */
export interface AppsDomainStatus {
  /** "https": a VPS tem endereço público; "tunnel": sem endereço público (não há o que configurar). */
  mode: "https" | "tunnel";
  /** Domínio de aplicações cadastrado; null = nenhum. */
  base: string | null;
  /**
   * DNS conferido para o IP ATUAL da VPS. Só com `verified` o assistente de
   * projeto gera endereços sob a base. Falso depois de restaurar o painel em
   * uma VPS com outro IP, até conferir de novo.
   */
  verified: boolean;
  /** A base foi conferida antes, mas para outro IP (VPS trocada) ou a última conferência falhou. */
  needsRecheck: boolean;
  serverIp: string | null;
  serverIpv6: string | null;
  /** Registros a criar (A e, se a VPS tem IPv6 público informado, AAAA). Vazio sem base. */
  records: AppsDomainRecord[];
  lastCheck: AppsDomainDnsCheck | null;
  /** Projetos que já usam um endereço sob a base (continuam funcionando se a base for removida). */
  projectsUsingBase: number;
  /** Exemplo do endereço que será gerado. */
  example: string | null;
}

/** POST /api/settings/apps-domain/verify */
export interface AppsDomainVerifyRequest {
  domain: string;
}

export interface AppsDomainVerifyResponse {
  check: AppsDomainDnsCheck;
  /** true = a base foi salva (só acontece com o DNS certo). */
  saved: boolean;
  status: AppsDomainStatus;
}

/**
 * GET /api/domains/suggest. Sem domínio de aplicações a resposta traz só
 * `auto` (sslip.io ou .localhost) e `publicIp`; com ele, os campos extras.
 */
export interface AutoDomainSuggestion {
  auto: string;
  publicIp: string | null;
  /** "apps": `auto` está sob o domínio de aplicações. Ausente = endereço de sempre. */
  kind?: "apps";
  appsBase?: string | null;
  /** Endereço sslip.io (com o IP no nome) para testar; null sem endereço público. */
  testAddress?: string | null;
  /** Endereço único e sem certificado público (.localhost) com que o projeto nasce; só com `kind: "apps"`. */
  provisional?: string;
}

/** Letras e números do sufixo do endereço provisório (o mesmo alfabeto que o servidor sorteia). */
const PROVISIONAL_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*-[abcdefghjkmnpqrstuvwxyz23456789]{5,8}\.localhost$/;

/** É o endereço provisório (`<projeto>-<sufixo>.localhost`) com que um projeto novo nasce? */
export function isProvisionalDomain(domain: string): boolean {
  return PROVISIONAL_RE.test(domain);
}

/** O painel está sendo aberto na própria máquina (localhost, 127.x, ::1)? */
export function isLocalPanelHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "[::1]" || h === "::1" || h.startsWith("127.");
}

/**
 * Avisar "endereço provisório"? Só num painel com endereço público: lá o
 * `.localhost` aponta para o computador de quem abre, não para a VPS.
 */
export function showsProvisionalNotice(domain: string, panelHostname: string): boolean {
  return isProvisionalDomain(domain) && !isLocalPanelHost(panelHostname);
}
