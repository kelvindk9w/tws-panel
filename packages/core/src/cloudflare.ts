/**
 * Integração opcional com a API de DNS da Cloudflare: o painel cria sozinho os
 * registros que hoje a pessoa cria à mão. Tipos compartilhados entre o servidor
 * e a interface. O token nunca aparece aqui: a API só diz "conectado" e os 4
 * últimos caracteres.
 */

/** Texto do campo `comment` com que o painel marca os registros que criou. */
export const CLOUDFLARE_RECORD_COMMENT = "tws-panel";

/** Escopo do pedido: registros de e-mail de um domínio, ou A/AAAA de nomes que apontam para a VPS. */
export type CloudflareDnsScope = { kind: "mail"; domain: string } | { kind: "hosts"; hosts: string[] };

export interface CloudflareStatus {
  connected: boolean;
  /** Últimos 4 caracteres do token (dica de conferência); null quando desconectado. */
  hint: string | null;
  updatedAt: string | null;
  /** Chamadas feitas à Cloudflare na última hora e o teto próprio do painel. */
  callsLastHour: number;
  hourlyLimit: number;
}

export interface CloudflareConnectResponse extends CloudflareStatus {
  /** Nomes das zonas que o token alcança (vazio = o token não enxerga nenhuma). */
  zones: string[];
  /**
   * O token tem permissão de editar DNS (DNS Write)? false = parece só leitura (a tela avisa);
   * null = a Cloudflare não deixou conferir (token de conta etc.): só se saberá ao aplicar.
   */
  dnsEdit: boolean | null;
}

export interface CloudflareConnectRequest {
  token: string;
  currentPassword: string;
  code?: string;
}

export interface CloudflareDisconnectRequest {
  currentPassword: string;
  code?: string;
}

export type CloudflareRecordType = "A" | "AAAA" | "MX" | "TXT";

/**
 * Situação de um registro na prévia:
 *  - create: não existe, será criado;
 *  - ok: já está certo, nada a fazer;
 *  - differs: existe com outro valor (só troca se a pessoa marcar);
 *  - merge: SPF já existe: propõe-se a fusão no mesmo registro (só se a pessoa marcar);
 *  - conflict: não é seguro mexer (MX de outro provedor, CNAME no nome, vários registros…): manual;
 *  - no_zone: o nome não está numa zona que o token alcança.
 */
export type CloudflareItemStatus = "create" | "ok" | "differs" | "merge" | "conflict" | "no_zone";

export interface CloudflarePlanItem {
  /** Identificador estável dentro do pedido (a, mx, spf, dkim… ou tipo:nome). */
  id: string;
  type: CloudflareRecordType;
  name: string;
  status: CloudflareItemStatus;
  /** Valor proposto (MX: "10 mail.example.com"). */
  proposed: string;
  /** Valores que existem hoje no mesmo nome e tipo. */
  current: string[];
  optional: boolean;
  /** O registro existente foi criado por este painel. */
  ours: boolean;
  /** Código do motivo quando há algo a explicar (other_mx, cname, spf_multiple, spf_redirect, multiple, proxied, spf_covers). */
  reason: string | null;
  /**
   * Impressão digital do que a prévia mostrou (status + id do registro existente + conteúdo atual + proposta).
   * A aplicação devolve este valor: se o DNS mudou desde a prévia, o item não é escrito.
   */
  fingerprint: string;
  /** A pessoa pode marcar este item (create, differs, merge). */
  selectable: boolean;
  /** Já vem marcado na prévia (criar; trocar só o que o painel mesmo criou). */
  defaultSelected: boolean;
}

export interface CloudflarePlanResponse {
  items: CloudflarePlanItem[];
  /** Quantos nomes ficaram fora das zonas do token. */
  noZoneCount: number;
}

export interface CloudflareApplyRequest {
  scope: CloudflareDnsScope;
  /** Itens marcados na prévia, com o status e a impressão digital que a pessoa viu. */
  items: Array<{ id: string; status: CloudflareItemStatus; fingerprint: string }>;
}

export type CloudflareApplyOutcome = "created" | "updated" | "skipped" | "failed";

export interface CloudflareApplyResult {
  id: string;
  type: CloudflareRecordType;
  name: string;
  outcome: CloudflareApplyOutcome;
  /** Por que foi ignorado: changed = o DNS mudou desde a prévia (nada foi escrito); not_applicable = item que não se escreve. */
  reason?: "changed" | "not_applicable";
  message: string | null;
}

export interface CloudflareApplyResponse {
  results: CloudflareApplyResult[];
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}
