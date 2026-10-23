/**
 * token-policy.ts — o que um token de API pode alcançar. Lista CENTRAL: o
 * plugin de autenticação consulta esta função em toda requisição com Bearer.
 *
 * Três respostas possíveis para (método, padrão da rota):
 *  - `denied`: NENHUM token alcança, nem com escopo admin (lista de exclusão);
 *  - `admin`: precisa de escopo admin (rotas administrativas/sensíveis);
 *  - `read` / `write`: GET/HEAD = read; qualquer outro método = write.
 *
 * Regra de ouro: a lista de exclusão vale ANTES de tudo e é por padrão da rota
 * (`/api/projects/:id/env`), nunca pelo endereço bruto. Rota nova não listada
 * aqui cai no padrão por método — por isso o teste `token-policy-rotas` falha
 * quando aparece uma rota sem classificação conhecida, forçando a revisão.
 *
 * Por que cada exclusão (plano MCP, seção 6):
 *  - terminal web: executa comandos como administrador do servidor;
 *  - reinício do assistente, troca de senha/usuário/2FA, login, logout: a
 *    identidade e a recuperação da conta são só da pessoa;
 *  - criar/listar/revogar tokens: um token nunca administra tokens;
 *  - senha dos backups (revelar, sugerir, testar, definir) e credenciais de
 *    caixas de e-mail (ver, trocar senha, revelar mensagens): segredo não passa por IA;
 *  - valores de variáveis (ler e gravar: a resposta devolve os valores);
 *  - tokens do GitHub e de serviços externos (GitHub, Telegram, destino S3,
 *    chave privada de certificado, credencial de deploy do projeto);
 *  - estado de uso da pessoa (preferências, roteiro "Deixe o painel pronto").
 */
import type { ApiTokenScope } from "@paas/core";

export type RouteAccess = { kind: "denied"; reason: string } | { kind: "scope"; scope: ApiTokenScope };

interface Rule {
  /** Método, "*" (qualquer um) ou "!GET" (qualquer um que muda coisas). */
  method: string;
  /** Padrão exato da rota; termina em "/*" para valer também para o que vem depois. */
  pattern: string;
  reason?: string;
}

const d = (method: string, pattern: string, reason: string): Rule => ({ method, pattern, reason });

/** Lista de exclusão: nenhum escopo alcança. */
export const DENIED_ROUTES: readonly Rule[] = [
  d("*", "/api/terminal/*", "terminal web (executa comandos como administrador do servidor)"),
  d("*", "/api/settings/restart-setup", "reinício do assistente de instalação"),
  d("*", "/api/setup/*", "assistente de instalação (só com o setup token, antes da conta existir)"),
  d("*", "/api/auth/login", "login só por senha, em pessoa"),
  d("*", "/api/auth/logout", "sessão é da pessoa"),
  d("*", "/api/auth/change-password", "troca de senha"),
  d("*", "/api/auth/2fa", "verificação em duas etapas"),
  d("*", "/api/auth/2fa/*", "verificação em duas etapas"),
  d("*", "/api/settings/profile", "identidade da conta"),
  d("*", "/api/settings/preferences", "preferências da pessoa"),
  d("*", "/api/settings/api-tokens", "criar/listar/revogar tokens"),
  d("*", "/api/settings/api-tokens/*", "criar/listar/revogar tokens"),
  d("POST", "/api/onboarding/start", "progresso do roteiro é da pessoa"),
  d("PUT", "/api/onboarding/hidden", "progresso do roteiro é da pessoa"),
  d("PUT", "/api/onboarding/steps/:id", "progresso do roteiro é da pessoa"),
  d("*", "/api/backups/password", "senha dos backups"),
  d("*", "/api/backups/password/*", "senha dos backups"),
  d("*", "/api/backups/destination", "chaves do destino dos backups (serviço externo)"),
  d("*", "/api/backups/destination/*", "chaves do destino dos backups (serviço externo)"),
  d("PUT", "/api/certificates/:host/manual", "chave privada de certificado"),
  d("*", "/api/projects/:id/env", "valores de variáveis"),
  d("*", "/api/projects/:id/env/provided/:name", "valores de variáveis"),
  d("*", "/api/projects/:id/credential", "credencial de deploy do projeto (token do GitHub)"),
  d("PUT", "/api/integrations/github", "token do GitHub"),
  d("DELETE", "/api/integrations/github", "token do GitHub"),
  d("GET", "/api/integrations/github/repos", "usa o token do GitHub guardado"),
  d("PUT", "/api/notifications/telegram", "token do Telegram"),
  d("*", "/api/mail/mailboxes/:id/credentials", "credenciais de caixas de e-mail"),
  d("*", "/api/mail/mailboxes/:id/password", "credenciais de caixas de e-mail"),
  d("POST", "/api/mail/domains/:domain/mailboxes", "a resposta traz a senha da caixa"),
  d("POST", "/api/projects/:id/email", "a resposta pode trazer a senha gerada da caixa"),
  d("POST", "/api/mail/envios/saidas/:msg/reveal", "conteúdo de mensagens enviadas"),
  d("POST", "/api/projects/:id/email/saidas/:msg/reveal", "conteúdo de mensagens enviadas"),
];

/** Rotas que exigem escopo admin (administrativas ou capazes de trancar/apagar). */
export const ADMIN_ROUTES: readonly Rule[] = [
  d("!GET", "/api/settings/panel-domain", "domínio do painel"),
  d("!GET", "/api/settings/panel-domain/*", "domínio do painel"),
  d("!GET", "/api/settings/apps-domain", "domínio de aplicações"),
  d("!GET", "/api/settings/apps-domain/*", "domínio de aplicações"),
  d("PUT", "/api/timezone", "fuso horário da VPS"),
  d("POST", "/api/security/*", "endurecimento do servidor"),
  d("PUT", "/api/security/*", "endurecimento do servidor"),
  d("DELETE", "/api/projects/:id", "apagar projeto"),
  d("DELETE", "/api/mail/domains/:domain", "apagar domínio de e-mail"),
  d("DELETE", "/api/mail/domains/:domain/mailboxes/:id", "apagar caixa de e-mail"),
  d("POST", "/api/mail/domains", "criar domínio de e-mail"),
  d("POST", "/api/mail/server/*", "servidor de e-mail"),
  d("DELETE", "/api/certificates/:host/manual", "apagar certificado"),
  d("POST", "/api/backups/targets/:target/restore", "restaurar backup"),
  d("PUT", "/api/backups/encryption", "criptografia dos backups"),
  d("GET", "/api/fs/dirs", "lista pastas do servidor"),
];

function matches(rule: Rule, method: string, pattern: string): boolean {
  if (rule.method === "!GET" ? method === "GET" : rule.method !== "*" && rule.method !== method) return false;
  if (rule.pattern.endsWith("/*")) return pattern.startsWith(rule.pattern.slice(0, -1));
  return rule.pattern === pattern;
}

/**
 * Classifica uma rota. `pattern` é o padrão que o roteador escolheu
 * (request.routeOptions.url) ou, sem rota, o caminho decodificado. Padrão
 * ausente ou fora de /api/ nega (fecha por omissão).
 */
export function classifyRoute(method: string, pattern: string | undefined): RouteAccess {
  if (!pattern || !pattern.startsWith("/api/")) return { kind: "denied", reason: "fora da API" };
  // HEAD é a leitura do mesmo GET: as listas valem para os dois.
  const upper = method.toUpperCase();
  const m = upper === "HEAD" ? "GET" : upper;
  const denied = DENIED_ROUTES.find((r) => matches(r, m, pattern));
  if (denied) return { kind: "denied", reason: denied.reason ?? "" };
  if (ADMIN_ROUTES.some((r) => matches(r, m, pattern))) return { kind: "scope", scope: "admin" };
  return { kind: "scope", scope: m === "GET" || m === "HEAD" ? "read" : "write" };
}

const RANK: Record<ApiTokenScope, number> = { read: 1, write: 2, admin: 3 };

/** O escopo do token cobre o exigido? (admin ⊃ write ⊃ read) */
export function scopeCovers(have: ApiTokenScope, need: ApiTokenScope): boolean {
  return RANK[have] >= RANK[need];
}
