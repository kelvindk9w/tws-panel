/**
 * mcp.ts — acesso por IA pelo protocolo MCP (Fase 1): o painel fala MCP em `POST /mcp`, com o token de API.
 *
 * O MCP vem DESLIGADO (Configurações → Acesso por IA). As opções de poder ficam em cada token
 * (`McpTokenOptions`, em api-tokens.ts); aqui ficam o liga/desliga da instalação e as aprovações humanas.
 */

/** Endereço do MCP no painel (transporte HTTP "streamable", respostas em JSON). */
export const MCP_PATH = "/mcp";

/** Versões do protocolo que o painel fala (a primeira é a preferida). */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

/** Quanto tempo uma ação sensível fica esperando a pessoa decidir, e quanto vale depois de aprovada. */
export const MCP_APPROVAL_TTL_MS = 10 * 60 * 1000;

/** Teto de aprovações guardadas ao mesmo tempo (pendentes e decididas recentes). */
export const MCP_APPROVAL_MAX = 50;

/** Nível do setup token no /mcp durante a instalação (variável PAAS_MCP_SETUP_LEVEL). */
export const MCP_SETUP_LEVELS = ["read", "write", "admin"] as const;
export type McpSetupLevel = (typeof MCP_SETUP_LEVELS)[number];

export interface McpSettingsResponse {
  enabled: boolean;
  /** Endereço relativo do MCP (a tela monta o endereço completo com o do painel). */
  path: string;
}

export interface UpdateMcpSettingsRequest {
  enabled: boolean;
  /** Ligar exige a senha atual e, com 2FA, o código (abre uma porta nova na internet). */
  currentPassword?: string;
  code?: string;
}

export type McpApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "used";

/** Uma ação sensível que uma IA pediu e espera a decisão de uma pessoa. */
export interface McpApprovalInfo {
  id: string;
  tokenId: string;
  tokenName: string;
  /** Nome do programa da IA (o que ele disse ser na abertura da conexão). */
  client: string;
  tool: string;
  /** Argumentos do pedido (só ferramentas sensíveis, que nunca recebem segredo). A tela os mostra à pessoa. */
  args: Record<string, unknown>;
  status: McpApprovalStatus;
  createdAt: string;
  expiresAt: string;
}

export interface McpApprovalListResponse {
  approvals: McpApprovalInfo[];
}

export interface DecideMcpApprovalRequest {
  currentPassword?: string;
  code?: string;
}
