/**
 * api-tokens.ts — tokens de API com escopo (Configurações → Acesso por IA).
 *
 * Um token deixa um programa (por exemplo, um assistente de IA) usar a API do
 * painel SEM cookie de sessão: `Authorization: Bearer <token>`. Cada token tem
 * escopo, validade e pode ser revogado na hora. O valor aparece UMA vez, na
 * criação; o servidor guarda só o hash.
 */

/** Início de todo token: identifica o que é (e deixa varredores de segredo acharem um vazamento). */
export const API_TOKEN_PREFIX = "tws_pat_";

/** Formato completo: prefixo + 32 bytes aleatórios (256 bits) em base64url. */
export const API_TOKEN_PATTERN = /^tws_pat_[A-Za-z0-9_-]{43}$/;

/**
 * leitura (GET), escrita (muda coisas) ou administração (rotas sensíveis).
 * Cada nível inclui os de baixo. Há rotas que NENHUM escopo alcança.
 */
export const API_TOKEN_SCOPES = ["read", "write", "admin"] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

/** Validade: padrão 30 dias; mínimo 1 hora; máximo 1 ano. 24 h é a do fluxo do assistente. */
export const API_TOKEN_DEFAULT_TTL_HOURS = 30 * 24;
export const API_TOKEN_MIN_TTL_HOURS = 1;
export const API_TOKEN_MAX_TTL_HOURS = 365 * 24;

/** Tokens ativos (não revogados e não vencidos) ao mesmo tempo. */
export const API_TOKEN_MAX_ACTIVE = 20;

export const API_TOKEN_NAME_MAX_LENGTH = 40;

/** Nome que aparece na Auditoria como `token:<nome>`: letras, números, espaço, ponto, hífen e sublinhado. */
export function validateApiTokenName(name: string): boolean {
  return name.length >= 1 && name.length <= API_TOKEN_NAME_MAX_LENGTH && /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(name) && name === name.trim();
}

export type ApiTokenStatus = "active" | "expired" | "revoked";

/** O que a lista mostra de um token: NUNCA o valor nem o hash. */
export interface ApiTokenInfo {
  id: string;
  name: string;
  scope: ApiTokenScope;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: ApiTokenStatus;
}

/** POST /api/settings/api-tokens — exige a senha atual e, com a verificação em duas etapas ativa, o código. */
export interface CreateApiTokenRequest {
  name: string;
  scope: ApiTokenScope;
  /** Validade em horas (padrão 720 = 30 dias; de 1 a 8760). */
  expiresInHours?: number;
  currentPassword: string;
  code?: string;
}

/** O valor do token só existe nesta resposta. */
export interface CreateApiTokenResponse {
  token: string;
  info: ApiTokenInfo;
}

export interface ListApiTokensResponse {
  tokens: ApiTokenInfo[];
  maxActive: number;
}
