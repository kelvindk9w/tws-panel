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
import { MCP_PATH, type ApiTokenScope } from "@paas/core";
import type { TokenReach } from "./api-token-store.js";
import { EXPECTED_ROUTE_ACCESS, EXPECTED_ROUTE_REACH, type RouteReach } from "./token-policy-table.js";

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
  d("*", "/api/auth/email-code", "código por e-mail (fator de segurança da pessoa)"),
  d("*", "/api/auth/email-code/*", "código por e-mail (fator de segurança da pessoa)"),
  d("*", "/api/security/access", "acesso à VPS (chaves SSH, senha do Linux, fail2ban, kit): só a pessoa, com senha e verificação em duas etapas"),
  d("*", "/api/security/access/*", "acesso à VPS (chaves SSH, senha do Linux, fail2ban, kit): só a pessoa, com senha e verificação em duas etapas"),
  d("*", "/api/projects/:id/database", "aba Banco: nomes de tabelas e dados do banco do projeto, esvaziar, zerar e SQL: só a pessoa"),
  d("*", "/api/projects/:id/database/*", "aba Banco: nomes de tabelas e dados do banco do projeto, esvaziar, zerar e SQL: só a pessoa"),
  d("*", "/api/health/docker-build", "Docker e BuildKit da VPS (leitura no host): só a pessoa"),
  d("*", "/api/health/docker-build/*", "instala o buildx no Docker da VPS: só a pessoa, com senha e verificação em duas etapas"),
  d("*", "/api/settings/profile", "identidade da conta"),
  d("*", "/api/settings/preferences", "preferências da pessoa"),
  d("*", "/api/settings/database", "quanto tempo a edição do banco fica liberada é decisão da pessoa, no painel"),
  d("*", "/api/settings/mcp", "ligar e desligar o MCP é decisão da pessoa, no painel"),
  d("*", "/api/mcp/*", "aprovar ou recusar o que a IA pediu é só da pessoa (a IA não aprova a si mesma)"),
  d("PUT", "/api/metrics/settings", "retenção das métricas é decisão da pessoa, no painel"),
  d("*", "/api/settings/api-tokens", "criar/listar/revogar tokens"),
  d("*", "/api/settings/api-tokens/*", "criar/listar/revogar tokens"),
  d("POST", "/api/onboarding/start", "progresso do roteiro é da pessoa"),
  d("PUT", "/api/onboarding/hidden", "progresso do roteiro é da pessoa"),
  d("PUT", "/api/onboarding/steps/:id", "progresso do roteiro é da pessoa"),
  d("*", "/api/backups/projects/:id/upload-restore", "restaurar o banco de um arquivo enviado: pede a senha de login e o código do 2FA, que um token não consegue digitar"),
  d("*", "/api/backups/projects/:id/upload-restore/*", "restaurar o banco de um arquivo enviado: pede a senha de login e o código do 2FA, que um token não consegue digitar"),
  d("POST", "/api/backups/targets/:target/restore", "restaurar backup pede a senha de login e o código do 2FA, que um token não consegue digitar"),
  d("*", "/api/backups/password", "senha dos backups"),
  d("*", "/api/backups/password/*", "senha dos backups"),
  d("*", "/api/backups/destination", "chaves do destino dos backups (serviço externo)"),
  d("*", "/api/backups/destination/*", "chaves do destino dos backups (serviço externo)"),
  d("PUT", "/api/certificates/:host/manual", "chave privada de certificado"),
  d("*", "/api/projects/:id/env", "valores de variáveis"),
  d("*", "/api/projects/:id/env/provided/:name", "valores de variáveis"),
  d("*", "/api/projects/:id/credential", "credencial de deploy do projeto (token do GitHub)"),
  d("*", "/api/projects/:id/account-credential", "liberar a conta GitHub conectada para o projeto"),
  d("PUT", "/api/integrations/github", "token do GitHub"),
  d("DELETE", "/api/integrations/github", "token do GitHub"),
  d("GET", "/api/integrations/github/repos", "usa o token do GitHub guardado"),
  d("*", "/api/integrations/cloudflare", "API Token da Cloudflare e criação de registros DNS: só a pessoa, com a prévia na tela"),
  d("*", "/api/integrations/cloudflare/*", "API Token da Cloudflare e criação de registros DNS: só a pessoa, com a prévia na tela"),
  d("PUT", "/api/notifications/telegram", "token do Telegram"),
  d("PUT", "/api/projects/:id/dynamic-domains/suffixes", "sufixos dos domínios dinâmicos (decidem quais nomes o projeto aceita): só a pessoa"),
  d("*", "/api/settings/dynamic-domains", "tetos dos domínios dinâmicos (protegem o limite do Let's Encrypt): só a pessoa"),
  d("PUT", "/api/projects/:id/email/links", "liga a senha da caixa de e-mail a uma variável do projeto"),
  d("PUT", "/api/projects/:id/mail-test", "ligar/desligar a caixa de teste decide para onde o e-mail do projeto vai (desligada, os clientes reais passam a recebê-lo): só a pessoa"),
  d("*", "/api/projects/:id/mail-test/*", "mensagens da caixa de teste (links de redefinição de senha, dados de clientes): só a pessoa"),
  d("PUT", "/api/mail/envios/reputation/dqs", "chave de serviço externo (Spamhaus DQS)"),
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
  d("!GET", "/api/projects/:id/domains", "domínios do projeto (mudam para onde o tráfego da internet vai)"),
  d("!GET", "/api/projects/:id/domains/*", "domínios do projeto (mudam para onde o tráfego da internet vai)"),
  d("!GET", "/api/projects/:id/dynamic-domains", "domínios dinâmicos (mudam para onde o tráfego da internet vai; o token \"domínios\" é o caminho para isso)"),
  d("!GET", "/api/projects/:id/dynamic-domains/*", "domínios dinâmicos (mudam para onde o tráfego da internet vai; o token \"domínios\" é o caminho para isso)"),
  d("!GET", "/api/projects/:id/ports", "portas do projeto (podem expor um serviço interno à internet)"),
  d("!GET", "/api/projects/:id/ports/*", "portas do projeto (podem expor um serviço interno à internet)"),
  d("POST", "/api/mail/webmail/enable", "publica o webmail na internet"),
  d("POST", "/api/mail/webmail/disable", "tira o webmail do ar"),
  d("POST", "/api/projects", "criar projeto (o repositório informado passa a rodar no servidor)"),
  d("PUT", "/api/notifications/email", "muda para onde vão os avisos"),
  d("DELETE", "/api/notifications/email", "muda para onde vão os avisos"),
  d("DELETE", "/api/notifications/telegram", "muda para onde vão os avisos"),
  d("POST", "/api/notifications/telegram/connect", "muda para onde vão os avisos"),
  d("DELETE", "/api/mail/domains/:domain", "apagar domínio de e-mail"),
  d("DELETE", "/api/mail/domains/:domain/mailboxes/:id", "apagar caixa de e-mail"),
  d("POST", "/api/mail/domains", "criar domínio de e-mail"),
  d("PUT", "/api/mail/domains/:domain/health/ack/:id", "marcar item da saúde do e-mail como ciente (tira o item do resumo): só admin"),
  d("DELETE", "/api/mail/domains/:domain/health/ack/:id", "desmarcar item da saúde do e-mail: só admin"),
  d("POST", "/api/mail/domains/:domain/mta-sts/verify", "verificar e publicar o MTA-STS do domínio (pode disparar a emissão de um certificado): só admin"),
  d("POST", "/api/mail/server/*", "servidor de e-mail"),
  d("DELETE", "/api/certificates/:host/manual", "apagar certificado"),
  d("PUT", "/api/backups/encryption", "criptografia dos backups"),
  d("GET", "/api/fs/dirs", "lista pastas do servidor"),
];

/** Campos do PATCH do projeto que mudam O QUE RODA ou ONDE o tráfego chega. */
export const PROJECT_RUNTIME_FIELDS = ["source", "branch", "domain", "proxyService", "proxyPort"] as const;

export interface RequestParts {
  params?: unknown;
  query?: unknown;
  body?: unknown;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/**
 * Aperta a classificação conforme o PEDIDO (parâmetros, consulta, corpo). Só
 * sobe o exigido (admin) ou proíbe; nunca afrouxa. Roda depois que o corpo foi
 * lido (preValidation). Existe porque algumas rotas "de escrita" mudam o que o
 * servidor executa ou revelam segredo conforme os campos enviados:
 *  - PATCH do projeto com repositório/branch/domínio/proxy: o próximo deploy roda
 *    código de outro lugar, que lê as variáveis do projeto → admin;
 *  - restaurar o alvo `panel` troca usuários, senha e 2FA → nenhum token;
 *  - deploy com `guardrailOverride` (libera bloqueios de segurança): nenhum token;
 *  - token limitado a projetos: não apaga projeto (confirmação humana, Fase 3);
 *  - testar acesso ao Git com token digitado ou o da conta conectada → nenhum token;
 *  - varredura de segurança nova (`fresh`) digita comandos no terminal root → admin.
 */
export function refineAccess(
  base: RouteAccess,
  method: string,
  pattern: string,
  parts: RequestParts,
  reach: TokenReach = { kind: "panel" },
): RouteAccess {
  if (base.kind === "denied") return base;
  const m = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  const deny = (reason: string): RouteAccess => ({ kind: "denied", reason });
  const admin: RouteAccess = { kind: "scope", scope: "admin" };
  // Passar por cima dos bloqueios de segurança do deploy (privileged, host-mount...) é decisão
  // da pessoa, na tela: nenhum token, de nenhum escopo ou alcance, pode pedir o override.
  if (m === "POST" && pattern === "/api/projects/:id/deploy" && obj(parts.body).guardrailOverride === true) {
    return deny("liberar os bloqueios de segurança do deploy (override) só pela pessoa, no painel");
  }
  if (reach.kind === "projects") {
    // Apagar projeto pede confirmação da pessoa na tela (Fase 3 do plano MCP); até existir, token limitado não apaga.
    if (m === "DELETE" && pattern === "/api/projects/:id") {
      return deny("apagar projeto pede a confirmação da pessoa, no painel");
    }
    // Pasta do servidor como fonte (e trocar a fonte) daria acesso a arquivos de OUTROS
    // projetos e do servidor: com alcance limitado só repositório remoto, e a fonte não muda.
    if (m === "POST" && pattern === "/api/projects" && obj(parts.body).ingestMode !== "git") {
      return deny("projeto de pasta local só pelo token de painel inteiro");
    }
    if (m === "PATCH" && pattern === "/api/projects/:id" && obj(parts.body).source !== undefined) {
      return deny("trocar a fonte do projeto só pelo painel");
    }
  }
  if (m === "PATCH" && pattern === "/api/projects/:id") {
    const body = obj(parts.body);
    // A marca de desenvolvimento tira o backup do padrão das ações destrutivas do banco: decisão só da pessoa.
    if (body.development !== undefined) return deny("a marca de projeto de desenvolvimento só se muda pela pessoa, no painel");
    if (PROJECT_RUNTIME_FIELDS.some((k) => body[k] !== undefined)) return admin;
  }
  if (m === "POST" && pattern === "/api/projects/check-git-access") {
    const body = obj(parts.body);
    if (body.token !== undefined || (body.useAccount !== undefined && body.useAccount !== false)) {
      return deny("testar acesso ao Git com token do GitHub");
    }
  }
  if (m === "GET" && pattern === "/api/security/scan") {
    const fresh = obj(parts.query).fresh;
    if (fresh !== undefined && fresh !== "0") return admin;
  }
  return base;
}

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
  // O MCP (/mcp) não é uma rota /api/: a porta de entrada vale leitura e cada ferramenta confere o nível
  // que a rota por trás dela exige (as ferramentas chamam as mesmas rotas, com o mesmo token).
  if (pattern === MCP_PATH) return { kind: "scope", scope: "read" };
  if (!pattern || !pattern.startsWith("/api/")) return { kind: "denied", reason: "fora da API" };
  const upper = method.toUpperCase();
  const m = upper === "HEAD" ? "GET" : upper;
  // Falha fechada em EXECUÇÃO: rota fora da tabela (token-policy-table.ts) é negada,
  // seja qual for o método. O teste token-policy-rotas exige a tabela completa.
  if (!Object.hasOwn(EXPECTED_ROUTE_ACCESS, `${m} ${pattern}`)) {
    return { kind: "denied", reason: "rota ainda sem classificação para tokens" };
  }
  return classifyRules(upper, pattern);
}

/** Só as listas e o método (sem a tabela). Usada pelo teste que compara as duas. */
export function classifyRules(method: string, pattern: string): RouteAccess {
  const upper = method.toUpperCase();
  const m = upper === "HEAD" ? "GET" : upper;
  const denied = DENIED_ROUTES.find((r) => matches(r, m, pattern));
  if (denied) return { kind: "denied", reason: denied.reason ?? "" };
  if (ADMIN_ROUTES.some((r) => matches(r, m, pattern))) return { kind: "scope", scope: "admin" };
  return { kind: "scope", scope: m === "GET" || m === "HEAD" ? "read" : "write" };
}

const RANK: Record<ApiTokenScope, number> = { read: 1, write: 2, admin: 3 };

/**
 * O que o token "domínios deste projeto" exige em cada rota que ele alcança. Os outros tokens
 * precisam de admin para cadastrar/remover (mudam para onde o tráfego da internet vai); este
 * token existe justamente para isso, então escrever pede só o nível `write`.
 */
export function classifyDomainsToken(method: string, pattern: string): RouteAccess {
  const upper = method.toUpperCase();
  const m = upper === "HEAD" ? "GET" : upper;
  if (reachOfRoute(m, pattern) !== "domains") return { kind: "denied", reason: DOMAINS_ONLY_REASON };
  return { kind: "scope", scope: m === "GET" ? "read" : "write" };
}

/** O escopo do token cobre o exigido? (admin ⊃ write ⊃ read) */
export function scopeCovers(have: ApiTokenScope, need: ApiTokenScope): boolean {
  return RANK[have] >= RANK[need];
}

/** Alcance da rota. Rota fora da tabela vale "panel": token limitado não a alcança (falha fechada). */
export function reachOfRoute(method: string, pattern: string | undefined): RouteReach {
  if (!pattern) return "panel";
  // Porta do MCP: aberta a qualquer alcance de painel/projetos; o alcance de cada ferramenta é conferido nas rotas por trás.
  if (pattern === MCP_PATH) return "open";
  const upper = method.toUpperCase();
  const key = `${upper === "HEAD" ? "GET" : upper} ${pattern}`;
  return Object.hasOwn(EXPECTED_ROUTE_REACH, key) ? EXPECTED_ROUTE_REACH[key]! : "panel";
}

/** Mensagem única das recusas por alcance (a forma é a das recusas da Fase 0). */
export const PROJECT_ONLY_REASON = "este token só alcança os projetos escolhidos";
export const CANNOT_CREATE_REASON = "este token não pode criar projetos";
export const DOMAINS_ONLY_REASON = "este token só alcança os domínios dinâmicos dos projetos escolhidos";
export const CANNOT_SEE_HOST_REASON = "este token não pode ver o monitoramento da VPS";

export type ReachDecision =
  | { kind: "allow" }
  | { kind: "forbidden"; reason: string }
  /** Projeto fora do alcance: responde como se não existisse (sem oráculo de existência). */
  | { kind: "not_found" };

/** Id de projeto dentro de um alvo de backup ("project:<id>"); null para "panel", "email" e o resto. */
export function projectOfTarget(target: unknown): string | null {
  if (typeof target !== "string" || !target.startsWith("project:")) return null;
  const id = target.slice("project:".length);
  return id.length > 0 ? id : null;
}

/**
 * Decide se o alcance do token cobre a rota. Token de painel inteiro passa por
 * tudo (o escopo é conferido à parte). Token limitado: só o que é de projeto da
 * lista; o que é do painel, 403; projeto fora da lista, 404 igual ao de inexistente.
 */
export function checkReach(reach: TokenReach, routeReach: RouteReach, params: unknown): ReachDecision {
  if (reach.kind === "panel") return { kind: "allow" };
  // Token "domínios deste projeto": só as rotas de domínios dinâmicos, e só dos projetos da lista.
  // Nem as rotas abertas (versão, quem sou) nem as filtradas (lista de projetos) lhe servem.
  if (reach.kind === "domains") {
    if (routeReach !== "domains") return { kind: "forbidden", reason: DOMAINS_ONLY_REASON };
    const id = obj(params).id;
    return typeof id === "string" && reach.ids.includes(id) ? { kind: "allow" } : { kind: "not_found" };
  }
  switch (routeReach) {
    case "open":
    case "scoped":
      return { kind: "allow" };
    case "create":
      return reach.canCreate ? { kind: "allow" } : { kind: "forbidden", reason: CANNOT_CREATE_REASON };
    case "host":
      return reach.hostMetrics ? { kind: "allow" } : { kind: "forbidden", reason: CANNOT_SEE_HOST_REASON };
    case "domains":
    case "project": {
      const id = obj(params).id;
      return typeof id === "string" && reach.ids.includes(id) ? { kind: "allow" } : { kind: "not_found" };
    }
    case "target": {
      const id = projectOfTarget(obj(params).target);
      if (id === null) return { kind: "forbidden", reason: PROJECT_ONLY_REASON };
      return reach.ids.includes(id) ? { kind: "allow" } : { kind: "not_found" };
    }
    default:
      return { kind: "forbidden", reason: PROJECT_ONLY_REASON };
  }
}
