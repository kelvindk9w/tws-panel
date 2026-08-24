/**
 * Tipos compartilhados do módulo de deploy (Fase 2 — Deploy + Domínios).
 * Spec: plano seções 5.1/5.2 e docs/projects-analysis.md.
 */

// ---------------------------------------------------------------------------
// Projetos
// ---------------------------------------------------------------------------

/** Tipo de pipeline detectado a partir do código-fonte. */
export type ProjectType = "static-node" | "compose" | "dockerfile" | "unknown";

export const PROJECT_TYPES: readonly ProjectType[] = [
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
  domain: string;
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
