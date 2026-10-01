/**
 * Tipos compartilhados do módulo de deploy (Fase 2 — Deploy + Domínios).
 * Spec: plano seções 5.1/5.2 e docs/projects-analysis.md.
 */

// ---------------------------------------------------------------------------
// Projetos
// ---------------------------------------------------------------------------

/** Tipo de pipeline detectado a partir do código-fonte. */
export type ProjectType = "static" | "static-node" | "compose" | "dockerfile" | "unknown";

export const PROJECT_TYPES: readonly ProjectType[] = [
  "static",
  "static-node",
  "compose",
  "dockerfile",
  "unknown",
];

/** Modo de ingestão do código-fonte. */
export type IngestMode = "git" | "upload" | "existing";

export const INGEST_MODES: readonly IngestMode[] = ["git", "upload", "existing"];

/** Status calculado do projeto (derivado dos containers + último deploy). */
export type ProjectStatus = "created" | "deploying" | "running" | "stopped" | "error";

export interface GuardrailWarning {
  /** Identificador estável, ex.: "compose.db-port-exposed". */
  id: string;
  severity: "critical" | "warning" | "info";
  /** Mensagem amigável (pt-BR). */
  message: string;
  /** Serviço do compose relacionado (quando aplicável). */
  service?: string;
}

export type PackageManager = "npm" | "pnpm" | "yarn";

/** Resultado da detecção automática de tipo de projeto. */
export interface DetectResult {
  type: ProjectType;
  /** Arquivo de compose adotado (relativo ao src), quando type=compose. */
  composeFile: string | null;
  /** Diretório de saída estática (out/, dist/, build/), quando type=static-node. */
  outputDir: string | null;
  packageManager: PackageManager | null;
  /** Comando de build detectado (ex.: "pnpm build"). */
  buildCommand: string | null;
  /** Serviço/porta sugeridos para o proxy reverso (compose/dockerfile). */
  proxyService: string | null;
  proxyPort: number | null;
  /** Guardrails de segurança (prévia da Fase 4). */
  warnings: GuardrailWarning[];
  /** Notas legíveis sobre a detecção (pt-BR). */
  details: string[];
}

export interface Project {
  id: string;
  name: string;
  /** Slug único usado em nomes de containers/rede (paas-<slug>). */
  slug: string;
  ingestMode: IngestMode;
  /** URL git (modo git) ou caminho local (modos upload/existing). */
  source: string;
  branch: string | null;
  /** Domínio principal (o do link "Abrir site" e do health check). */
  domain: string;
  /**
   * Outros domínios servidos pelo projeto ao mesmo tempo (ex.: o subdomínio
   * próprio além do endereço automático). Ausente em projetos antigos = [].
   */
  aliases?: string[];
  /**
   * Porta própria por domínio (no mesmo serviço de entrada) — ex.: o site na
   * 3200 e a API/carteira na 8009. Domínio ausente daqui usa a porta do projeto.
   */
  domainPorts?: Record<string, number>;
  /** Projeto precisa de WebSocket/timeouts longos (ex.: Colyseus). */
  websocket: boolean;
  /** Última detecção conhecida (null = ainda não detectado). */
  detection: DetectResult | null;
  /** Override manual do alvo do proxy (sobrepõe a detecção). */
  proxyService: string | null;
  proxyPort: number | null;
  createdAt: string;
  updatedAt: string;
  lastDeployAt: string | null;
  lastDeployStatus: "success" | "failed" | null;
  /**
   * Branch e fonte que o último deploy bem-sucedido efetivamente publicou.
   * Guardamos o FATO do que está no ar, não uma intenção de mudança: é isso
   * que permite à tela mostrar "configurado X, no ar Y" e sobrevive a
   * reinício, edição concorrente e falha no meio do fluxo.
   * null = nada publicado ainda.
   */
  deployedBranch: string | null;
  deployedSource: string | null;
}

// ---------------------------------------------------------------------------
// Credencial de LEITURA de repositório privado
// ---------------------------------------------------------------------------

/**
 * Credencial usada para CLONAR repositórios privados.
 *
 * Restrição inegociável do produto: o painel só LÊ repositórios — nunca
 * escreve, commita ou faz push. Por isso a credencial recomendada é um token
 * de escopo mínimo de leitura (no GitHub, um fine-grained PAT com
 * `Contents: Read`).
 *
 * O valor vive apenas no cofre cifrado do servidor e no ambiente do processo
 * git durante o clone. NUNCA volta pela API e NUNCA entra em log.
 */
export interface GitReadCredential {
  /** Usuário enviado ao git. No GitHub qualquer valor serve com um PAT. */
  username: string;
  /** Token de leitura. Nunca sai do servidor. */
  token: string;
}

/** Usuário padrão quando o operador informa só o token (convenção do GitHub). */
export const DEFAULT_GIT_CREDENTIAL_USERNAME = "x-access-token";

/**
 * O que a API pode contar sobre a credencial de um projeto: que ela existe e,
 * no máximo, uma dica não sensível para o operador conferir qual token está
 * cadastrado. O valor jamais aparece aqui.
 */
export interface ProjectCredentialInfo {
  configured: boolean;
  /** Últimos 4 caracteres do token (dica de conferência), ou null. */
  hint: string | null;
  username: string | null;
  updatedAt: string | null;
}

export interface SetProjectCredentialRequest {
  /** Token de LEITURA do repositório. */
  token: string;
  /** Usuário associado (opcional — padrão DEFAULT_GIT_CREDENTIAL_USERNAME). */
  username?: string;
}

export interface ProjectCredentialResponse {
  credential: ProjectCredentialInfo;
}

// ---------------------------------------------------------------------------
// Jobs de deploy
// ---------------------------------------------------------------------------

export type DeployJobStatus = "queued" | "running" | "success" | "failed";

export interface DeployJobStep {
  name: string;
  status: "running" | "done" | "failed" | "skipped";
}

export interface DeployJob {
  id: string;
  projectId: string;
  status: DeployJobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  steps: DeployJobStep[];
  /** Log bruto do deploy (stdout+stderr das etapas). */
  log: string;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Docker (visão não-invasiva)
// ---------------------------------------------------------------------------

export interface DockerContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  /** true se gerenciado pelo painel (label paas.managed ou compose project paas-*). */
  managed: boolean;
  /** Slug do projeto do painel associado (null = externo). */
  projectSlug: string | null;
  /** Projeto docker-compose de origem (label com.docker.compose.project). */
  composeProject: string | null;
  ports: string[];
}

// ---------------------------------------------------------------------------
// Domínios
// ---------------------------------------------------------------------------

export interface DomainCheckResponse {
  domain: string;
  /** Modo dev local: *.localhost resolve para loopback automaticamente. */
  devLocal: boolean;
  /** true se o domínio aponta para esta máquina (ou é .localhost em dev). */
  ok: boolean;
  /** IPs resolvidos via DNS. */
  resolvedIps: string[];
  /** IPs desta máquina (interfaces + IP público conhecido). */
  machineIps: string[];
  message: string;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export interface CreateProjectRequest {
  name: string;
  ingestMode: IngestMode;
  source: string;
  branch?: string;
  domain: string;
  websocket?: boolean;
  proxyService?: string;
  proxyPort?: number;
}

export interface UpdateProjectRequest {
  /** Nome de exibição. Editável e livre — nunca altera o slug. */
  name?: string;
  /** URL do repositório (modo git). Trocar exige re-clone no próximo deploy. */
  source?: string;
  /** Branch a publicar. Trocar exige re-clone no próximo deploy. */
  branch?: string;
  domain?: string;
  websocket?: boolean;
  proxyService?: string | null;
  proxyPort?: number | null;
}

export interface ProjectResponse {
  project: Project;
  status: ProjectStatus;
  containers: DockerContainerInfo[];
  /** URL de acesso em dev (http://<dominio>). */
  url: string;
  /** Existência (nunca o valor) da credencial de leitura do repositório. */
  credential: ProjectCredentialInfo;
}

export interface ProjectListResponse {
  projects: ProjectResponse[];
}

export interface DetectResponse {
  detection: DetectResult;
}

export interface DeployJobResponse {
  job: DeployJob;
}

export interface DeployJobListResponse {
  jobs: DeployJob[];
}

export interface DockerContainersResponse {
  containers: DockerContainerInfo[];
}

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Labels aplicadas a tudo que o painel cria no Docker. */
export const PAAS_LABEL_MANAGED = "paas.managed";
export const PAAS_LABEL_PROJECT = "paas.project";

/** Rede Docker dedicada dos projetos gerenciados + Caddy central. */
export const PAAS_NETWORK = "paas-net";

/** Nome do container do Caddy central. */
export const PAAS_CADDY_CONTAINER = "paas-caddy";

/** Limite do log de deploy persistido por job (mantém o início e o fim). */
export const DEPLOY_LOG_MAX_CHARS = 400_000;

/** Variável que o compose interpola (`${VAR}`), vista pela seção Variáveis. */
export interface ComposeVariable {
  name: string;
  /** `${VAR:?…}` / `${VAR?…}`: o compose recusa subir sem ela. */
  required: boolean;
  /** `${VAR:-padrão}` / `${VAR-padrão}`. */
  defaultValue: string | null;
  /**
   * Obrigatória só quando estas estão vazias: ela está no padrão delas
   * (`${EMAIL_DE:-${MAIL_FROM:?…}}` → MAIL_FROM, alternativa EMAIL_DE).
   */
  alternatives?: string[];
}

/**
 * Obrigatórias do compose ainda sem valor. `defined` = nomes com valor nas
 * Variáveis do projeto MAIS os que o painel fornece (ex.: e-mail do projeto).
 */
export function missingComposeVariables(variables: ComposeVariable[], defined: ReadonlySet<string>): string[] {
  return variables
    .filter((v) => v.required && !defined.has(v.name) && !(v.alternatives ?? []).some((a) => defined.has(a)))
    .map((v) => v.name);
}

/** Estado do certificado HTTPS de um domínio do projeto (Visão geral). */
export interface DomainHttpsStatus {
  domain: string;
  ok: boolean;
  /** Quem emitiu (ex.: "Let's Encrypt"). */
  issuer: string | null;
  validTo: string | null;
  error: string | null;
}

export interface ProjectHttpsResponse {
  domains: DomainHttpsStatus[];
}
