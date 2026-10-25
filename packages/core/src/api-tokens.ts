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

/**
 * Alcance (Fase 0b): o que o token enxerga, além do nível (escopo).
 *  - `panel`: o painel inteiro (comportamento da Fase 0);
 *  - `projects`: só os projetos da lista (e, se `canCreate`, os que o próprio
 *    token criar entram sozinhos nela). Nunca alcança rotas do painel/servidor;
 *  - `domains`: token "domínios deste projeto" (SaaS): só as rotas dos domínios
 *    dinâmicos dos projetos da lista, e mais nada (nem ler o projeto). Níveis
 *    `read` (listar) e `write` (cadastrar e remover); nunca `admin`.
 */
export const API_TOKEN_REACHES = ["panel", "projects", "domains"] as const;
export type ApiTokenReach = (typeof API_TOKEN_REACHES)[number];

/** Teto de projetos na lista de um token (o painel não tem tantos; barra lista absurda). */
export const API_TOKEN_MAX_PROJECTS = 100;

export type ApiTokenStatus = "active" | "expired" | "revoked";

/** O que a lista mostra de um token: NUNCA o valor nem o hash. */
export interface ApiTokenInfo {
  id: string;
  name: string;
  scope: ApiTokenScope;
  /** Alcance: painel inteiro, só os projetos da lista ou só os domínios dinâmicos deles. */
  reach: ApiTokenReach;
  /** Ids dos projetos que o token alcança (vazio quando o alcance é o painel inteiro). */
  projects: string[];
  /** Alcance "projects": os projetos que o token criar entram sozinhos na lista. */
  canCreate: boolean;
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
  /** Alcance (padrão "panel" = painel inteiro, como na Fase 0). */
  reach?: ApiTokenReach;
  /** Alcance "projects": ids de projetos existentes (sem repetir). */
  projects?: string[];
  /** Alcance "projects": o token pode criar projetos novos, que entram na lista dele. */
  canCreate?: boolean;
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

/**
 * PATCH /api/settings/api-tokens/:id — troca a lista de projetos (e o "pode criar")
 * de um token de alcance "projects" ou "domains" (neste, "pode criar" é sempre falso). Aumentar o alcance (projeto novo na lista ou
 * ligar "pode criar") exige a senha atual e, com 2FA, o código, como a criação;
 * reduzir não exige.
 */
export interface UpdateApiTokenReachRequest {
  projects: string[];
  canCreate: boolean;
  /**
   * A lista de projetos que a tela mostrava à pessoa. Se a lista do token mudou desde então
   * (o token criou projeto), o servidor responde 409 e nada é gravado.
   */
  basedOn?: string[];
  currentPassword?: string;
  code?: string;
}

export interface UpdateApiTokenReachResponse {
  info: ApiTokenInfo;
}
