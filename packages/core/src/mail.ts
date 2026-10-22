/**
 * Tipos compartilhados do módulo de e-mail (Fase 3 — E-mail).
 * Spec: plano §5.3 e docs/internal/email-deliverability.md.
 */

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Nome do container do Stalwart Mail gerenciado pelo painel. */
export const PAAS_STALWART_CONTAINER = "paas-stalwart";

/** Volume Docker persistente dos dados do Stalwart. */
export const PAAS_STALWART_VOLUME = "paas_stalwart_data";

/** Seletor DKIM usado em todos os domínios provisionados pelo painel. */
export const DKIM_SELECTOR = "paas";

/** Portas padrão do servidor de e-mail (produção). Em dev, sobrescrever via env. */
export const MAIL_DEFAULT_PORTS = {
  smtp: 25,
  submission: 587,
  submissions: 465,
  imap: 143,
  imaps: 993,
  http: 8080,
} as const;

/** Env vars injetadas nos projetos com e-mail habilitado (plano §5.3). */
export const SMTP_ENV_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "MAIL_FROM"] as const;

// ---------------------------------------------------------------------------
// Servidor Stalwart
// ---------------------------------------------------------------------------

export interface MailServerPorts {
  smtp: number;
  submission: number;
  submissions: number;
  imap: number;
  imaps: number;
  http: number;
}

export interface MailServerStatus {
  /** Container existe (criado alguma vez). */
  installed: boolean;
  running: boolean;
  /** Versão do Stalwart (null se não conseguiu detectar). */
  version: string | null;
  image: string;
  containerName: string;
  /** Hostname do servidor de e-mail (mail.<domínio>). */
  hostname: string;
  ports: MailServerPorts;
  /** Mensagem amigável (pt-BR) com orientação quando algo está fora do esperado. */
  message: string | null;
}

// ---------------------------------------------------------------------------
// Domínios de e-mail
// ---------------------------------------------------------------------------

/** Política DMARC progressiva: começa em observação e endurece com o tempo. */
export type DmarcStage = "none" | "quarantine" | "reject";

export interface MailDomain {
  name: string;
  dkimSelector: string;
  /** Valor base64 do parâmetro p= do registro DKIM (chave pública RSA 2048). */
  dkimPublicKey: string;
  dkimKeyBits: number;
  dmarcStage: DmarcStage;
  createdAt: string;
}

export interface MailDomainSummary extends MailDomain {
  mailboxCount: number;
  /** Resumo da última verificação DNS persistida (null = nunca verificado). */
  lastVerify: {
    at: string;
    ok: number;
    total: number;
    /**
     * Os registros do domínio (A, MX, SPF, DKIM, DMARC) estão todos certos —
     * sem o PTR, que é recomendação. Ausente em verificações antigas.
     */
    recordsOk?: boolean;
  } | null;
}

export interface MailDomainListResponse {
  domains: MailDomainSummary[];
}

// ---------------------------------------------------------------------------
// Checklist DNS
// ---------------------------------------------------------------------------

export type DnsRecordType = "A" | "AAAA" | "MX" | "TXT" | "PTR";

export type DnsCheckStatus = "found" | "missing" | "mismatch" | "action_required" | "pending";

export interface DnsRecordCheck {
  /** Identificador estável (ex.: "a", "mx", "spf", "dkim", "dmarc"). */
  id: string;
  type: DnsRecordType;
  /** Nome do registro (ex.: "mail.exemplo.com", "_dmarc.exemplo.com"). */
  name: string;
  /** Valor esperado. */
  expected: string;
  /** Para quê serve (pt-BR). */
  purpose: string;
  status: DnsCheckStatus;
  /** Valores encontrados no DNS real (após verify). */
  found: string[];
  /** Observação adicional (ex.: explicar um mismatch). */
  note: string | null;
  /**
   * Só no MX: a prioridade e o servidor separados. O Cloudflare (e outros)
   * pedem os dois em campos diferentes; `expected` continua "10 mail…",
   * que é o que a verificação compara.
   */
  priority?: number;
  target?: string;
}

/**
 * Estado do DNS reverso (PTR) do IP da VPS, em três níveis:
 *  - found: o nome reverso é mail.<domínio> (o ideal);
 *  - generic: o IP tem um nome reverso genérico do provedor (ex.:
 *    vmi123.contaboserver.net) e esse nome volta para o mesmo IP. É o que o
 *    Gmail, o Yahoo e a Microsoft exigem (FCrDNS): o envio está liberado.
 *    Trocar para mail.<domínio> é opcional (melhora um pouco a reputação);
 *  - mismatch: o IP tem nome reverso, mas ele não volta para o IP (FCrDNS
 *    falha) — os grandes provedores podem recusar as mensagens;
 *  - action_required: o IP não tem nome reverso nenhum.
 */
export type PtrCheckStatus = DnsCheckStatus | "generic";

/** Provedor da VPS reconhecido pelo nome reverso atual, com o caminho para trocá-lo. */
export interface PtrProvider {
  /** Identificador estável (ex.: "contabo", "hetzner", "vultr"). */
  id: string;
  /** Nome para a pessoa (ex.: "Contabo"). */
  name: string;
  /** Onde clicar para trocar o nome reverso para mail.<domínio> (pt-BR). */
  instructions: string;
}

export interface PtrCheck {
  ip: string;
  /** Hostname esperado no reverse DNS. */
  expected: string;
  status: PtrCheckStatus;
  found: string[];
  /**
   * Algum nome reverso encontrado volta (registro A) para o mesmo IP —
   * FCrDNS válido. null = ainda não verificado ou não há nome reverso.
   */
  forwardConfirmed?: boolean | null;
  /** Provedor reconhecido pelo nome reverso atual (null = desconhecido). */
  provider?: PtrProvider | null;
  /**
   * Texto pronto para abrir chamado no provedor da VPS. Só vem quando o
   * provedor é desconhecido e o nome reverso ainda não é mail.<domínio>.
   */
  ticketText: string | null;
  /**
   * Só quando não deu para conferir (status "pending"): qual consulta ficou
   * sem resposta e em qual DNS (público e do sistema), para diagnóstico.
   */
  diagnostic?: string | null;
}

export interface DnsChecklistResponse {
  domain: string;
  mailHostname: string;
  serverIp: string;
  records: DnsRecordCheck[];
  ptr: PtrCheck;
  /** Sugestão de evolução da política (DMARC progressivo / SPF), pt-BR. */
  suggestion: string | null;
}

export interface DnsVerifyResponse {
  domain: string;
  verifiedAt: string;
  summary: { ok: number; total: number };
  records: DnsRecordCheck[];
  ptr: PtrCheck;
  suggestion: string | null;
  /**
   * O registro A de mail.<domínio> aponta para a VPS e o certificado dele
   * ainda não é válido: a verificação pediu a emissão (o mesmo "Tentar
   * emitir agora" da página Certificados). Ausente = nada foi pedido.
   */
  certificateRetry?: { host: string; message: string };
}

// ---------------------------------------------------------------------------
// Caixas de e-mail
// ---------------------------------------------------------------------------

export interface Mailbox {
  /** Endereço completo (identificador), ex.: contato@exemplo.com. */
  id: string;
  localPart: string;
  domain: string;
  /** Caixa técnica criada automaticamente para um projeto (slug) ou sistema. */
  kind: "user" | "project" | "system";
  createdAt: string;
  /**
   * Projeto dono da caixa: a caixa de envio do projeto e as criadas pela aba
   * Caixas do e-mail dele. Ausente = de nenhum projeto (ex.: criada na página
   * do domínio). Caixa antiga sem dono gravado: a de envio de um projeto
   * aparece como dele.
   */
  projectId?: string;
  /** Só nas listagens: nome do projeto dono (ausente se o projeto não existe mais). */
  projectName?: string;
  /**
   * O painel não sabe a senha desta caixa (ela veio de um backup e foi
   * cadastrada pela sincronização). A caixa funciona; para enviar pelo painel,
   * use "Trocar senha". Ausente = senha conhecida.
   */
  passwordUnknown?: boolean;
}

/**
 * Resultado de cadastrar no painel o que o servidor de e-mail já tem
 * (POST /api/mail/sync e o fim da restauração do e-mail). Só nomes: nunca
 * senhas nem dados da conta.
 */
export interface MailAdoptResult {
  /** Domínios cadastrados agora. */
  domains: string[];
  /** Caixas cadastradas agora (endereço completo; alias não conta como caixa). */
  mailboxes: string[];
  /** Nomes que o servidor tem e o painel não conseguiu cadastrar (no máximo MAIL_ADOPT_SKIPPED_MAX). */
  skipped: string[];
  /** Quantos nomes não foram cadastrados no total (maior que `skipped.length` quando a lista foi cortada). */
  skippedTotal?: number;
  /** O servidor tem mais de 20 000 domínios ou caixas: só os primeiros foram lidos; o resto não foi conferido. */
  truncated?: boolean;
  /**
   * Caixas de sistema (postmaster@) e de projeto cuja senha no servidor de e-mail DIFERIA da guardada pelo painel
   * e foi corrigida (depois de restaurar, o servidor volta com a senha antiga do backup). Ausente quando 0.
   */
  passwordsRealigned?: number;
  /** Caixas cuja senha o painel reaplicou sem conseguir conferir antes (o servidor não devolveu a senha). Ausente quando 0. */
  passwordsReapplied?: number;
  /** Endereços (nunca senhas) das caixas que o painel tentou realinhar e não conseguiu; as outras seguiram. */
  passwordsFailed?: string[];
}

/** Teto de nomes devolvidos em `skipped` (a resposta não cresce com o tamanho do servidor). */
export const MAIL_ADOPT_SKIPPED_MAX = 200;

export interface MailSyncResponse extends MailAdoptResult {
  ok: true;
  domainCount: number;
  mailboxCount: number;
}

export interface MailboxListResponse {
  mailboxes: Mailbox[];
}

/** Tamanho mínimo da senha que a pessoa define para uma caixa. */
export const MAILBOX_PASSWORD_MIN = 12;

export interface CreateMailboxRequest {
  localPart: string;
  /**
   * Senha definida pela pessoa (mínimo MAILBOX_PASSWORD_MIN). O painel nunca
   * a mostra de volta: quem esqueceu troca (ChangeMailboxPasswordRequest).
   * Ausente com `generatePassword: true`: o painel gera uma forte e a devolve
   * uma única vez em MailboxResponse.generatedPassword.
   */
  password?: string;
  generatePassword?: boolean;
  /** Criada pela aba Caixas do e-mail do projeto: a caixa fica sendo dele. */
  projectId?: string;
}

/**
 * PUT /api/mail/mailboxes/:id/password — nova senha definida pela pessoa, ou
 * `generate: true` para o painel gerar uma forte (devolvida uma vez em
 * MailboxResponse.generatedPassword).
 */
export interface ChangeMailboxPasswordRequest {
  password?: string;
  generate?: boolean;
}

/** Bloco de credenciais pronto para cliente externo (Outlook/Gmail/Thunderbird). */
/** Configuração para cliente externo. Sem senha: ela nunca volta pela API. */
export interface MailboxCredentials {
  email: string;
  username: string;
  imap: {
    host: string;
    port: number;
    security: "ssl";
  };
  imapAlt: {
    host: string;
    port: number;
    security: "starttls";
  };
  smtp: {
    host: string;
    port: number;
    security: "starttls";
  };
  smtpAlt: {
    host: string;
    port: number;
    security: "ssl";
  };
  notes: string[];
}

export interface MailboxCredentialsResponse {
  credentials: MailboxCredentials;
}

// ---------------------------------------------------------------------------
// E-mail de projeto (injeção SMTP)
// ---------------------------------------------------------------------------

/**
 * Valores que o e-mail do projeto entrega ao app no deploy, na ordem da tela.
 * MAIL_FROM_NAME só existe quando há nome de exibição.
 */
export const PROJECT_EMAIL_VALUE_KEYS = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "MAIL_FROM",
  "MAIL_FROM_NAME",
] as const;
export type ProjectEmailValueKey = (typeof PROJECT_EMAIL_VALUE_KEYS)[number];

/** Mesmo padrão das Variáveis do projeto (apps/server/src/services/project-env.ts). */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Nomes que mudam o compose, o Docker ou o próprio sistema do container. */
const RESERVED_ENV_NAMES = new Set(["PATH", "HOME", "HOSTNAME", "PWD", "SHELL", "USER"]);
const RESERVED_ENV_PREFIXES = ["COMPOSE_", "DOCKER_"];

/**
 * Por que um nome não pode receber um valor do e-mail do projeto (null = pode).
 * Recusa: fora do padrão de variável; um dos próprios valores do e-mail
 * (SMTP_PASS → SMTP_USER confundiria o app); e nomes reservados — no `.env`
 * do compose, COMPOSE_* e DOCKER_* mudam o próprio compose, e PATH/HOME
 * quebrariam o container.
 */
export function envLinkNameProblem(name: string): string | null {
  if (!ENV_NAME_RE.test(name)) {
    return `Nome inválido: "${name.slice(0, 60)}". Use letras, números e _ (sem começar com número), ex.: SMTP_SENHA.`;
  }
  const upper = name.toUpperCase();
  if ((PROJECT_EMAIL_VALUE_KEYS as readonly string[]).includes(upper)) {
    return `${name} já é um valor do e-mail do projeto: escolha "mesmo nome (padrão)".`;
  }
  if (RESERVED_ENV_NAMES.has(upper) || RESERVED_ENV_PREFIXES.some((p) => upper.startsWith(p))) {
    return `${name} é um nome reservado (muda o funcionamento do compose, do Docker ou do sistema).`;
  }
  return null;
}

export interface ProjectEmailConfig {
  enabled: boolean;
  domain: string | null;
  /**
   * Caixa do projeto: o próprio endereço de envio (o projeto entra com ela e
   * a pessoa pode abri-la num app de e-mail). Em registros antigos, a caixa
   * técnica <slug>@<domínio>, com o endereço de envio como alias.
   */
  mailbox: string | null;
  /** Endereço de envio (MAIL_FROM). */
  mailFrom: string | null;
  /** Nome de exibição do remetente (MAIL_FROM_NAME). */
  fromName?: string | null;
  /** Env vars que serão injetadas no próximo deploy (valores mascarados na API). */
  env: Record<string, string>;
  /**
   * Variáveis do app ligadas a valores do e-mail (nome da variável → valor de
   * origem, ex.: { SMTP_SENHA: "SMTP_PASS" }). O deploy entrega o valor atual.
   */
  envLinks?: Record<string, ProjectEmailValueKey>;
  /** Registro antigo (endereço de envio como alias da caixa técnica): salvar de novo migra. */
  legacyAlias?: boolean;
}

export interface ProjectEmailResponse {
  email: ProjectEmailConfig;
  /**
   * Senha gerada pelo painel ("Gerar uma senha forte para mim"). Vem UMA vez,
   * na resposta que a criou; nunca mais volta pela API.
   */
  generatedPassword?: string;
  /**
   * Só ao ligar o e-mail a uma caixa que já existia com a senha informada ou guardada: true = o painel
   * conferiu que a senha é a da caixa; false = o servidor de e-mail não deixou conferir e a senha foi aceita sem verificação.
   */
  passwordVerified?: boolean;
}

/**
 * Como o e-mail do projeto usa a senha de uma caixa que já existe: informa a senha atual
 * (`current_password`), mantém a que o painel já guarda (`keep_password`) ou troca por uma gerada pelo painel
 * (`replace_password`; apps e webmail que usam a antiga precisam ser atualizados).
 */
export type ExistingMailboxMode = "current_password" | "keep_password" | "replace_password";

/** Caixa do domínio que o e-mail de um projeto pode usar (GET /api/projects/:id/email/mailboxes). Nunca traz senha. */
export interface ProjectEmailUsableMailbox {
  address: string;
  localPart: string;
  kind: "user" | "project";
  /** O painel sabe a senha da caixa (dá para "manter a senha"). */
  passwordKnown: boolean;
}

export interface ProjectEmailMailboxesResponse {
  mailboxes: ProjectEmailUsableMailbox[];
}

/**
 * POST /api/projects/:id/email — ativa ou atualiza o e-mail do projeto.
 * O endereço de envio vira a caixa do projeto (padrão: <slug>@<domínio>);
 * sem fromName, usa o nome do projeto. Caixa nova pede a senha: `password`
 * (mínimo MAILBOX_PASSWORD_MIN) ou `generatePassword: true`.
 */
export interface EnableProjectEmailRequest {
  domain: string;
  /** Parte antes do @ do endereço de envio (ex.: "contato"). */
  fromLocalPart?: string;
  /** Nome que aparece para quem recebe (ex.: "Loja Exemplo"). */
  fromName?: string;
  /** Senha da caixa, digitada pela pessoa. */
  password?: string;
  /** O painel gera uma senha forte e a devolve uma única vez. */
  generatePassword?: boolean;
  /**
   * Usar a caixa `<fromLocalPart>@<domain>` que JÁ existe, em vez de criar uma. Nada é apagado.
   * `current_password` pede `password` (a atual da caixa); os outros dois não.
   */
  useExistingMailbox?: ExistingMailboxMode;
}

/** PUT /api/projects/:id/email/links — liga variáveis do app a valores do e-mail. */
export interface SetProjectEmailLinksRequest {
  links: Record<string, ProjectEmailValueKey>;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export interface MailServerActionResponse {
  ok: boolean;
  status: MailServerStatus;
}

export interface MailDomainResponse {
  domain: MailDomainSummary;
}

export interface CreateMailDomainRequest {
  domain: string;
  /**
   * O domínio já recebe e-mail em outro servidor (MX) e o operador confirmou
   * que quer seguir mesmo assim. Sem isto, o cadastro responde 409
   * `domain_receives_mail` com `existingMail`.
   */
  confirmExistingMail?: boolean;
}

/** Quem recebe o e-mail do domínio hoje (consulta ao MX antes do cadastro). */
export interface ExistingMailInfo {
  /** none = não recebe; here = já aponta para cá; elsewhere = outro servidor; unknown = consulta falhou. */
  status: "none" | "here" | "elsewhere" | "unknown";
  /** Servidores MX atuais, por prioridade. */
  servers: string[];
  /** Subdomínio sugerido para o envio (ex.: envio.exemplo.com.br). */
  suggestedDomain: string;
}

// ---------------------------------------------------------------------------
// Certificado do servidor de e-mail (mail.<domínio>)
// ---------------------------------------------------------------------------

/**
 * O registro A de mail.<domínio>: ok = aponta para esta VPS; missing = não
 * existe; cloudflare = proxy da Cloudflare ligado (nuvem laranja); other_ip =
 * aponta para outro lugar.
 */
export type MailTlsDnsStatus = "ok" | "missing" | "cloudflare" | "other_ip";

export interface MailTlsHostStatus {
  /** mail.<domínio> (ou PAAS_MAIL_HOSTNAME). */
  host: string;
  /** O servidor de e-mail apresenta um certificado válido para este nome. */
  ok: boolean;
  /** Emissor do certificado apresentado (quando válido). */
  issuer: string | null;
  /** Fim da validade (ISO, quando válido). */
  validTo: string | null;
  /** Erro da conexão TLS (quando não é válido). */
  error: string | null;
  /** O proxy (Caddy) já emitiu o certificado deste nome. */
  issued: boolean;
  dns: { status: MailTlsDnsStatus; resolved: string[]; expectedIp: string };
  /** O que falta, em pt-BR (null quando válido). */
  hint: string | null;
}

export interface MailTlsStatusResponse {
  checkedAt: string;
  serverRunning: boolean;
  hosts: MailTlsHostStatus[];
  /** Falha ao instalar o certificado no servidor de e-mail (null = ok). */
  syncError: string | null;
}

// ---------------------------------------------------------------------------
// E-mail de teste (página do domínio)
// ---------------------------------------------------------------------------

/**
 * Destino de um e-mail de teste:
 *  - queued: na fila do servidor de e-mail, tentando entregar;
 *  - delivered: o servidor do destinatário aceitou (ex.: Gmail);
 *  - bounced: o servidor do destinatário recusou de vez;
 *  - deferred: adiada (recusa temporária ou falha de conexão), nova tentativa marcada.
 */
export type MailTestState = "queued" | "delivered" | "bounced" | "deferred";

export interface MailTestStatus {
  id: string;
  domain: string;
  /** Caixa que enviou (postmaster@<domínio>). */
  from: string;
  to: string;
  sentAt: string;
  checkedAt: string;
  state: MailTestState;
  /** Resposta ou motivo devolvido pelo servidor do destinatário (quando houver). */
  detail: string | null;
  /** Próxima tentativa (ISO) quando adiada. */
  nextRetryAt: string | null;
  /**
   * true = o resultado veio do aviso de entrega do servidor de e-mail; false
   * = a mensagem só saiu da fila sem erro registrado (entregue, sem recibo).
   */
  confirmed: boolean;
  /** Resultado definitivo (entregue ou recusado): não precisa mais consultar. */
  final: boolean;
}

export interface SendTestEmailRequest {
  /** Um endereço de destino só (ex.: o Gmail da pessoa). */
  to: string;
  /** Caixa do domínio que envia (padrão: postmaster@<domínio>). */
  from?: string;
}

export interface MailTestResponse {
  test: MailTestStatus;
}

export interface MailboxResponse {
  mailbox: Mailbox;
  /** Só na troca com `generate: true`: a senha nova, mostrada uma única vez. */
  generatedPassword?: string;
}

// ---------------------------------------------------------------------------
// Monitoramento de blacklist (Fase 4)
// ---------------------------------------------------------------------------

export type BlacklistStatus = "listed" | "clean" | "unknown";

export interface BlacklistResult {
  /** Identificador da DNSBL, ex.: "spamhaus-zen". */
  dnsbl: string;
  /** Nome legível, ex.: "Spamhaus ZEN". */
  label: string;
  status: BlacklistStatus;
  /** Detalhe (códigos de retorno da DNSBL ou motivo do "unknown"). */
  detail: string | null;
  /** Link para checagem/remoção quando listed. */
  removalUrl: string | null;
  /**
   * Página da lista para conferir o endereço à mão. Vem sempre que a lista
   * tem uma; é o caminho quando o resultado é "unknown" (ex.: Barracuda sem
   * cadastro do servidor DNS). Ausente em resultados antigos.
   */
  lookupUrl?: string | null;
}

export interface BlacklistTargetResult {
  /** IP ou domínio consultado. */
  target: string;
  results: BlacklistResult[];
}

export interface BlacklistCheckResponse {
  checkedAt: string;
  /** IP público verificado (null se desconhecido). */
  ip: BlacklistTargetResult | null;
  /** Um item por domínio de e-mail cadastrado. */
  domains: BlacklistTargetResult[];
  /** Resumo: quantidade de listagens encontradas. */
  listedCount: number;
}
