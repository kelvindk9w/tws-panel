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

/**
 * Validade: padrão 30 dias; mínimo 1 hora; as horas informadas valem até 1 ano. Passar de um ano só pelo
 * "ilimitado" (`neverExpires`), que pede a confirmação explícita de quem cria. 24 h é a do fluxo do assistente.
 */
export const API_TOKEN_DEFAULT_TTL_HOURS = 30 * 24;
export const API_TOKEN_MIN_TTL_HOURS = 1;
export const API_TOKEN_MAX_TTL_HOURS = 365 * 24;

/** Validades oferecidas na tela, em dias (mais o "ilimitado"). O padrão continua 30. */
export const API_TOKEN_TTL_CHOICES_DAYS = [1, 7, 15, 30, 90, 180, 365] as const;

/** Data gravada num token "ilimitado": nunca chega, mas mantém o campo sempre preenchido. */
export const API_TOKEN_NEVER_EXPIRES_AT = "9999-12-31T23:59:59.999Z";

/** Esta data é a do "ilimitado"? */
export function isNeverExpiresAt(expiresAt: string): boolean {
  return expiresAt === API_TOKEN_NEVER_EXPIRES_AT;
}

/**
 * Opções do MCP por token (Fase 1). TODAS desligadas por padrão: quem cria o token decide quanto poder a IA
 * ganha, e ligar qualquer uma pede a senha (e o código, com 2FA) e mostra o aviso do risco.
 *  - `securityApply`: a IA pode APLICAR mudanças de segurança (SSH, firewall). Desligada = só simulação (dry-run);
 *  - `secretsRead`: a IA pode LER o valor de variáveis. Desligada = ela define e substitui valores, mas só vê
 *    os nomes (valor mascarado);
 *  - `skipApproval`: dispensa a aprovação humana (na tela, com 2FA) das ações sensíveis (recriar, aplicar segurança);
 *  - `metrics`: a IA pode consultar as métricas de recursos (do projeto; da VPS inteira só se o alcance permitir).
 */
export interface McpTokenOptions {
  securityApply: boolean;
  secretsRead: boolean;
  skipApproval: boolean;
  metrics: boolean;
}

export const MCP_TOKEN_OPTION_KEYS = ["securityApply", "secretsRead", "skipApproval", "metrics"] as const satisfies readonly (keyof McpTokenOptions)[];

export function defaultMcpOptions(): McpTokenOptions {
  return { securityApply: false, secretsRead: false, skipApproval: false, metrics: false };
}

/** Lê opções vindas de fora (disco, corpo): só `true` explícito liga; qualquer outra coisa fica desligada. */
export function normalizeMcpOptions(raw: unknown): McpTokenOptions {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = defaultMcpOptions();
  for (const key of MCP_TOKEN_OPTION_KEYS) out[key] = source[key] === true;
  return out;
}

/** As opções que ficaram LIGADAS e estavam desligadas (ligar = dar mais poder). */
export function widenedMcpOptions(before: McpTokenOptions, after: McpTokenOptions): (keyof McpTokenOptions)[] {
  return MCP_TOKEN_OPTION_KEYS.filter((key) => after[key] && !before[key]);
}

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
  /**
   * Alcance "projects": o token também vê o monitoramento da VPS inteira (CPU, memória, disco, rede),
   * só leitura. Desligado por padrão: o consumo da VPS revela a atividade de todos os projetos.
   * Token de painel inteiro sempre vê; nele este campo é sempre falso.
   */
  hostMetrics: boolean;
  /** Opções do MCP deste token (todas desligadas por padrão). */
  mcp: McpTokenOptions;
  createdAt: string;
  /** Data de vencimento; num token ilimitado é {@link API_TOKEN_NEVER_EXPIRES_AT}. */
  expiresAt: string;
  /** O token nunca vence (só revoga). Pede confirmação na criação. */
  neverExpires: boolean;
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
  /** Alcance "projects": o token pode ver o monitoramento da VPS (só leitura). Padrão: não. */
  hostMetrics?: boolean;
  /** Validade em horas (padrão 720 = 30 dias; de 1 a 8760). Ignorada com `neverExpires`. */
  expiresInHours?: number;
  /** Token sem vencimento. Exige `confirmNeverExpires: true` (a tela mostra o aviso do risco). */
  neverExpires?: boolean;
  confirmNeverExpires?: boolean;
  /** Opções do MCP. Ausente = todas desligadas. */
  mcp?: Partial<McpTokenOptions>;
  currentPassword: string;
  code?: string;
  /** Código por e-mail (só quando o usuário ligou esse fator). */
  emailCode?: string;
}

/** O valor do token só existe nesta resposta. */
export interface CreateApiTokenResponse {
  /** Preenchido quando o alerta por e-mail da mudança NÃO pôde sair (o motivo, em português); a tela mostra. */
  alertWarning?: string;
  token: string;
  info: ApiTokenInfo;
}

export interface ListApiTokensResponse {
  tokens: ApiTokenInfo[];
  maxActive: number;
}

/**
 * PATCH /api/settings/api-tokens/:id — troca a lista de projetos (e o "pode criar" e o "pode ver o monitoramento da VPS")
 * de um token de alcance "projects" ou "domains" (neste, "pode criar" e o monitoramento da VPS são sempre falsos).
 * Aumentar o alcance (projeto novo na lista ou ligar "pode criar" ou "monitoramento da VPS") exige a senha atual
 * e, com 2FA, o código, como a criação;
 * reduzir não exige.
 */
export interface UpdateApiTokenReachRequest {
  projects: string[];
  canCreate: boolean;
  /** Ausente = não muda. Ligar exige a senha atual e, com 2FA, o código (aumenta o alcance); desligar não. */
  hostMetrics?: boolean;
  /**
   * A lista de projetos que a tela mostrava à pessoa. Se a lista do token mudou desde então
   * (o token criou projeto), o servidor responde 409 e nada é gravado.
   */
  basedOn?: string[];
  currentPassword?: string;
  code?: string;
  emailCode?: string;
}

export interface UpdateApiTokenReachResponse {
  info: ApiTokenInfo;
}

/**
 * PATCH /api/settings/api-tokens/:id/mcp — troca as opções do MCP de um token ativo. LIGAR uma opção (dar mais
 * poder) exige a senha atual e, com 2FA, o código; desligar não exige.
 */
export interface UpdateApiTokenMcpRequest {
  mcp: Partial<McpTokenOptions>;
  currentPassword?: string;
  code?: string;
  emailCode?: string;
}

export interface UpdateApiTokenMcpResponse {
  info: ApiTokenInfo;
}
