/**
 * panel-domain.ts — Configurações → Domínio do painel.
 *
 * O instalador entrega o painel em https://<ip-com-hífens>.sslip.io (o
 * "acesso pelo IP": o endereço tem o IP da VPS no nome). Aqui a pessoa
 * cadastra um domínio próprio (ex.: painel.exemplo.com.br): o painel confere
 * o DNS, acrescenta o domínio ao bloco do painel no proxy (os dois endereços
 * respondem), acompanha o certificado e, aberto pelo endereço novo, permite
 * desativar o acesso pelo IP. Tudo reversível pela tela ou por SSH.
 */
import type { CertificateItem } from "./certificates";

/**
 * Resultado da conferência do DNS do domínio do painel:
 * - ok: todos os registros A apontam para a VPS (e nenhum AAAA para outro lugar);
 * - missing: nenhum registro A ainda;
 * - cloudflare: registro com a nuvem laranja (IPs da Cloudflare);
 * - wrong_ip: registro A apontando para outro IP;
 * - wrong_ipv6: registro AAAA apontando para outro lugar (o Let's Encrypt usaria ele);
 * - unavailable: o DNS não respondeu — não dá para dizer nada;
 * - no_server_ip: o painel não sabe o IP público da VPS (acesso por túnel).
 */
export type PanelDomainDnsProblem =
  | "ok"
  | "missing"
  | "cloudflare"
  | "wrong_ip"
  | "wrong_ipv6"
  | "unavailable"
  | "no_server_ip";

export interface PanelDomainDnsCheck {
  domain: string;
  ok: boolean;
  problem: PanelDomainDnsProblem;
  /** Registros A encontrados. */
  ipv4: string[];
  /** Registros AAAA encontrados. */
  ipv6: string[];
  /** IP que o registro A deve ter (o da VPS). */
  expectedIp: string | null;
  /** Explicação para leigo (pt-BR). */
  message: string;
  checkedAt: string;
}

/** Por onde a página foi aberta (Host do pedido): pelo domínio novo, pelo IP (sslip.io) ou outro (túnel, localhost). */
export type PanelOpenedVia = "domain" | "ip" | "other";

/** GET /api/settings/panel-domain (e resposta das ações). */
export interface PanelDomainStatus {
  /** "https": o painel tem endereço público pelo proxy; "tunnel": só por túnel SSH (a tela explica). */
  mode: "https" | "tunnel";
  /** Endereço automático pelo IP (<ip-com-hífens>.sslip.io); null no modo túnel. */
  ipAddress: string | null;
  /** O endereço pelo IP foi desativado (o painel não responde mais nele). */
  ipAccessDisabled: boolean;
  /** IP público da VPS (o valor do registro A); null se desconhecido. */
  serverIp: string | null;
  /** Domínio próprio cadastrado (ex.: painel.exemplo.com.br); null = nenhum. */
  domain: string | null;
  /** O DNS foi conferido e o domínio já está no proxy (responde pelo painel). */
  domainActive: boolean;
  /** Última conferência do DNS do domínio cadastrado. */
  lastCheck: PanelDomainDnsCheck | null;
  /** Certificado do domínio (página Certificados); null sem domínio ativo ou sem conferir. */
  certificate: CertificateItem | null;
  /** Endereços em que o painel responde agora (o principal primeiro). */
  addresses: string[];
  /** Nome com que esta página foi aberta (Host do pedido). */
  currentHost: string;
  openedVia: PanelOpenedVia;
  /** "Desativar o acesso pelo IP": liberado? Se não, por quê (frases para leigo). */
  disableIp: { allowed: boolean; blockers: string[] };
  /** Comando de SSH para reativar o acesso pelo IP se o domínio parar de abrir. */
  reactivateCommand: string;
  /** Onde a escolha fica gravada (volume de dados do painel). */
  configFile: string;
}

/** PUT /api/settings/panel-domain */
export interface PanelDomainSetRequest {
  domain: string;
}

/** POST /api/settings/panel-domain/verify */
export interface PanelDomainVerifyResponse {
  check: PanelDomainDnsCheck;
  status: PanelDomainStatus;
}

/** POST /api/settings/panel-domain/disable-ip — digitar o domínio para confirmar. */
export interface PanelDomainDisableIpRequest {
  confirm: string;
}
