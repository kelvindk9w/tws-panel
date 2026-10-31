/**
 * Tipos compartilhados do módulo de deploy (Fase 2 — Deploy + Domínios).
 * Spec: plano seções 5.1/5.2 e docs/internal/projects-analysis.md.
 */
import type { ProjectTimezoneSetting } from "./timezone";


// ---------------------------------------------------------------------------
// Projetos
// ---------------------------------------------------------------------------

/** Tipo de pipeline detectado a partir do código-fonte. */
export type ProjectType = "static" | "static-node" | "compose" | "dockerfile" | "node-server" | "unknown";

export const PROJECT_TYPES: readonly ProjectType[] = [
  "static",
  "static-node",
  "compose",
  "dockerfile",
  "node-server",
  "unknown",
];

/** Tipos que a pessoa pode escolher à mão no assistente (sobrepõem a detecção). "unknown" não é escolha. */
export const CHOOSABLE_PROJECT_TYPES: readonly ProjectType[] = ["static", "static-node", "compose", "dockerfile", "node-server"];

/**
 * Prefixos de nome que os frameworks de front-end embutem no JavaScript do site: são públicos por
 * definição, então o painel sugere marcá-las como "de build". A sugestão nunca marca sozinha.
 */
export const PUBLIC_BUILD_PREFIXES: readonly string[] = ["VITE_", "NEXT_PUBLIC_", "PUBLIC_", "REACT_APP_"];

/** O nome tem um prefixo público conhecido (VITE_, NEXT_PUBLIC_, PUBLIC_, REACT_APP_) e algo depois dele. */
export function hasPublicBuildPrefix(name: string): boolean {
  return PUBLIC_BUILD_PREFIXES.some((prefix) => name.startsWith(prefix) && name.length > prefix.length);
}

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

/** Porta publicada no host por um serviço do compose. */
export interface ComposePublishedPort {
  /** Como está escrita, normalizada (ex.: "127.0.0.1:8010:8010"). */
  mapping: string;
  /** Porta do container. */
  containerPort: number;
  /** Porta do host quando fixa; null = aleatória, faixa ou variável. */
  hostPort: number | null;
  /**
   * O que o painel faz com ela: "removed" = 80/443 retiradas no deploy (são
   * do proxy do painel); "conflict" = 80/443 de um proxy HTTPS próprio, que o
   * painel não retira e que bloqueiam o deploy; null = publicada como está.
   */
  panel: "removed" | "conflict" | null;
}

/** Porta em que o serviço escuta dentro da rede Docker (não publicada). */
export interface ComposeInternalPort {
  port: number;
  /** De onde veio: expose do compose, EXPOSE do Dockerfile, URL do healthcheck ou variável PORT. */
  source: "expose" | "dockerfile" | "healthcheck" | "environment";
}

/** Um serviço do compose, como o painel o entende (detecção). */
export interface ComposeServiceInfo {
  name: string;
  /** Imagem pronta (ex.: postgres:18-alpine); null quando só tem build. */
  image: string | null;
  /** Construído do repositório (build); null = só imagem. */
  build: { context: string; dockerfile: string } | null;
  publishedPorts: ComposePublishedPort[];
  internalPorts: ComposeInternalPort[];
  /** `network_mode: service:X` → "X" (usa a rede do serviço X). */
  networkModeService: string | null;
  dependsOn: Array<{ service: string; condition: string | null }>;
  /** Onde está o healthcheck: no compose, no Dockerfile, desligado ou nenhum. */
  healthcheck: "compose" | "dockerfile" | "disabled" | null;
}

/** Framework de um projeto `node-server` (servidor Node gerado pelo painel). Só "next" existe hoje. */
export type NodeServerFramework = "next";

/** Majors de Node que o painel sabe usar nas imagens do build (ver NODE_SERVER_IMAGES). */
export type NodeMajor = 20 | 22 | 24;

/** De onde veio a versão do Node escolhida para o build. */
export type NodeVersionSource = "engines" | "nvmrc" | "node-version" | "default";

/** O que a detecção descobriu de um servidor Node (type=node-server). */
export interface NodeServerInfo {
  framework: NodeServerFramework;
  /** `output: "standalone"` no next.config: imagem final mínima, `node server.js`. */
  standalone: boolean;
  /** Major do Node usado no build e na execução. */
  nodeMajor: NodeMajor;
  nodeSource: NodeVersionSource;
  /** Existe lockfile do gerenciador (instalação congelada); sem ele a instalação não é reprodutível. */
  lockfile: boolean;
}

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
  /**
   * Todos os serviços do compose (type=compose). Ausente em detecções antigas
   * (anteriores a 03/10/2026) — a tela pede para ler o compose de novo.
   */
  services?: ComposeServiceInfo[];
  /** Servidor Node (type=node-server): framework, standalone, versão do Node, lockfile. */
  nodeServer?: NodeServerInfo;
  /**
   * Site estático com cara de aplicação de página única (Vite/React/Vue/Svelte sem servidor): o
   * assistente sugere ligar o "fallback de SPA" do nginx. Nunca é verdadeiro para HTML puro.
   */
  spaSuggested?: boolean;
  /** O tipo foi escolhido à mão (sobrepõe a detecção); `detectedType` é o que a detecção automática diria. */
  chosenType?: boolean;
  detectedType?: ProjectType;
  /** Guardrails de segurança (prévia da Fase 4). */
  warnings: GuardrailWarning[];
  /** Notas legíveis sobre a detecção (pt-BR). */
  details: string[];
}

/** Branch usada quando o projeto não define uma (ingestão e alerta de atualização). */
export const DEFAULT_PROJECT_BRANCH = "main";

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
   * Domínios (principal ou adicionais) cujo PAR (com/sem www, ver domain-pair.ts) a pessoa
   * desligou. Ausente = o par segue o padrão: redireciona para o domínio assim que o DNS
   * dele aponta para a VPS e ninguém mais usa esse nome.
   */
  pairOff?: string[];
  /**
   * Porta própria por domínio (no mesmo serviço de entrada) — ex.: o site na
   * 3200 e a API/pagamentos na 8009. Domínio ausente daqui usa a porta do projeto.
   */
  domainPorts?: Record<string, number>;
  /** Projeto precisa de WebSocket/timeouts longos (ex.: Colyseus). */
  websocket: boolean;
  /** Última detecção conhecida (null = ainda não detectado). */
  detection: DetectResult | null;
  /** Override manual do alvo do proxy (sobrepõe a detecção). */
  proxyService: string | null;
  proxyPort: number | null;
  /**
   * "Aplicação de página única" (site estático): o nginx responde index.html para qualquer caminho que
   * não seja um arquivo (`try_files $uri $uri/ /index.html`), para as rotas do front-end abrirem no
   * link direto e no F5. Ausente/false = como sempre foi (404 para caminho inexistente).
   */
  spa?: boolean;
  /** Tipo escolhido à mão no assistente: a detecção automática respeita a escolha enquanto ela for válida. */
  typeOverride?: ProjectType | null;
  /**
   * Porta em que o site está de fato no ar quando difere da configurada (Next.js com servidor): fica
   * gravada depois de um deploy revertido, que religou a versão antiga na porta antiga. Limpa no
   * próximo deploy bem-sucedido. O proxy usa esta porta; a configurada vale para o próximo deploy.
   */
  servingPort?: number | null;
  createdAt: string;
  updatedAt: string;
  lastDeployAt: string | null;
  lastDeployStatus: "success" | "failed" | null;
  /**
   * Quando os containers do projeto passaram a rodar com o e-mail atual: só um deploy ou reinício que TERMINOU bem
   * grava (um deploy que falhou muda lastDeployAt e não aplica nada). Ausente = projeto anterior a este campo.
   */
  mailAppliedAt?: string | null;
  /**
   * Branch e fonte que o último deploy bem-sucedido efetivamente publicou.
   * Guardamos o FATO do que está no ar, não uma intenção de mudança: é isso
   * que permite à tela mostrar "configurado X, no ar Y" e sobrevive a
   * reinício, edição concorrente e falha no meio do fluxo.
   * null = nada publicado ainda.
   */
  deployedBranch: string | null;
  deployedSource: string | null;
  /**
   * Commit (hash completo) que o último deploy bem-sucedido deixou no ar, lido do
   * repositório do painel ao fim do deploy. É o que o alerta "nova atualização" compara
   * com a ponta da branch no repositório remoto. Ausente/null = projeto publicado antes
   * deste registro (ou sem repositório): o estado é "desconhecido", nunca "atualização".
   */
  deployedCommit?: string | null;
  /**
   * Trocas da porta do SERVIDOR feitas no painel, por serviço do compose
   * (aba Portas). Nunca mexem na porta interna. Valem no próximo deploy, pelo
   * paas.override.yml. Ausente = tudo como está no compose.
   */
  portOverrides?: Record<string, PortOverride[]>;
  /**
   * Fuso horário dos serviços (campo "Fuso horário" do projeto). Ausente =
   * "Padrão da imagem": o painel não injeta TZ.
   */
  timezone?: ProjectTimezoneSetting;
  /**
   * Quando a pessoa parou o projeto pelo painel. Enquanto existir, serviço parado é o esperado (o monitoramento
   * não alerta). Limpo ao iniciar, fazer deploy ou recriar. Ausente = nunca parado pelo painel.
   */
  stoppedAt?: string | null;
  /**
   * TZ que o último deploy (ou reinício com o fuso novo) injetou. null =
   * nenhum; ausente = projeto publicado antes desta opção existir.
   */
  timezoneApplied?: string | null;
  /**
   * Onde o painel guarda o que gera para o projeto (código clonado, repositório
   * do painel, arquivos paas.*). "reserved" = `<pasta de projetos>/.paas/<id>`,
   * área que nunca coincide com pasta do usuário. Ausente = projeto de antes
   * desta mudança: `<pasta de projetos>/<slug>` (mantido como está, sem mover
   * dados; a remoção confere o alvo antes de apagar).
   */
  storageLayout?: "reserved";
  /**
   * Projeto criado por token de API limitado a projetos: o clone NUNCA usa a credencial da conta
   * GitHub conectada (só repositório público, ou a credencial própria que a pessoa pôs no projeto).
   * Só a pessoa, com senha/2FA, libera (rota account-credential). Ausente = como antes.
   */
  noAccountCredential?: true;
  /**
   * "Este é um projeto de desenvolvimento": marca escolhida pela pessoa (Configurações do projeto). Hoje só muda
   * o PADRÃO da aba Banco: nas ações destrutivas a cópia de segurança vem como "Não fazer backup". Ausente = não.
   */
  development?: boolean;
}

/** Endereço de escuta de uma porta publicada que o painel aceita escolher. */
export type PortBindAddress = "127.0.0.1" | "0.0.0.0";

/**
 * Troca de uma porta publicada do compose: só o lado do servidor (porta e
 * endereço de escuta) ou a remoção da publicação.
 */
export interface PortOverride {
  /** A porta como está no compose (chave estável), ex.: "127.0.0.1:8010:8010", "5353:53/udp". */
  original: string;
  /** Nova porta do servidor; null = a publicação foi removida. */
  hostPort: number | null;
  /** Endereço de escuta; null quando a publicação foi removida. */
  hostIp: PortBindAddress | null;
  /**
   * Publicação ADICIONADA no painel (a porta não está no compose): a porta
   * interna e o protocolo. Nesse caso `original` é só um identificador
   * ("+127.0.0.1:15432:5432") e hostPort/hostIp nunca são null.
   */
  added?: { containerPort: number; protocol: PortProtocol };
}

/** Protocolo de uma porta publicada pelo painel. */
export type PortProtocol = "tcp" | "udp";

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

/** Liberar (allow) ou voltar a bloquear a conta GitHub conectada num projeto criado por token limitado. */
export interface SetAccountCredentialRequest {
  allow: boolean;
  /** Obrigatórios só para liberar (aumenta o acesso). */
  currentPassword?: string;
  code?: string;
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
// "Testar acesso" ao repositório (assistente Novo projeto)
// ---------------------------------------------------------------------------

/**
 * Consulta SOMENTE LEITURA (`git ls-remote`): nada é clonado nem salvo. O token
 * do corpo nunca é gravado, registrado nem devolvido.
 */
export interface GitAccessCheckRequest {
  source: string;
  branch?: string;
  /** Token digitado no assistente. */
  token?: string;
  /** Usar o token da conta do GitHub conectada (em vez de `token`). */
  useAccount?: boolean;
}

/** Por que o teste não deu certo (a interface traduz cada um). */
export type GitAccessFailureReason =
  | "invalid_source"
  | "invalid_branch"
  | "invalid_token"
  | "auth_required"
  | "no_permission"
  | "not_found"
  | "not_found_or_no_access"
  | "branch_not_found"
  | "unsupported_host"
  | "unreachable"
  | "timeout"
  | "redirected"
  | "blocked_host"
  | "token_not_applicable"
  | "account_not_connected"
  | "account_not_applicable"
  | "unknown";

export type GitAccessCheckResponse =
  | {
      ok: true;
      /** Branch padrão do repositório (null se vazio). */
      defaultBranch: string | null;
      /** Lista curta: a padrão primeiro. */
      branches: string[];
      totalBranches: number;
      /** A branch pedida existe? null = nenhuma foi pedida. */
      branchFound: boolean | null;
      /** Token informado: o git de fato o enviou? false = repositório público, o token NÃO foi verificado. null = sem token. */
      tokenUsed: boolean | null;
      message: string;
    }
  | {
      ok: false;
      reason: GitAccessFailureReason;
      /** Mensagem em português, sem nenhum segredo. */
      message: string;
      /** Só em branch_not_found: o que existe. */
      defaultBranch?: string | null;
      branches?: string[];
      totalBranches?: number;
      /** Só em unknown: última linha do git, sem token nem credenciais da URL. */
      detail?: string;
    };

// ---------------------------------------------------------------------------
// Alerta de "nova atualização do projeto"
// ---------------------------------------------------------------------------

/**
 * Situação do código do projeto frente à branch configurada no repositório.
 *  - up_to_date: o commit no ar é a ponta da branch;
 *  - update_available: a branch tem commit novo (só aviso: o deploy é sempre manual);
 *  - checking: a consulta ao repositório está em andamento;
 *  - unknown: foi publicado, mas o commit no ar não foi registrado (projeto antigo) — sem alerta;
 *  - never_deployed: ainda sem primeiro deploy;
 *  - config_changed: a branch/repositório configurados não são os que estão no ar;
 *  - error: não deu para verificar (NÃO é "sem atualização"); veja `reason`;
 *  - not_applicable: sem repositório (upload, pasta existente).
 */
export type UpdateState =
  | "up_to_date"
  | "update_available"
  | "checking"
  | "unknown"
  | "never_deployed"
  | "config_changed"
  | "error"
  | "not_applicable";

/** Motivo (código fixo, sem texto do servidor remoto) de a verificação não ter dado certo; a interface traduz. */
export type UpdateErrorReason =
  | "unreachable"
  | "timeout"
  | "auth"
  | "no_permission"
  | "not_found"
  | "branch_not_found"
  | "redirected"
  | "blocked_host"
  | "unsupported"
  | "unknown";

export interface ProjectUpdateStatus {
  projectId: string;
  state: UpdateState;
  /** Branch consultada (a configurada hoje; "main" quando não há). */
  branch: string | null;
  /** Commit remoto curto (7 caracteres); só em update_available e up_to_date. */
  remoteCommit: string | null;
  /** Commit curto que está no ar; null se desconhecido. */
  deployedCommit: string | null;
  /** Só em state "error". */
  reason: UpdateErrorReason | null;
  /** Quando a consulta (bem ou mal sucedida) terminou; null = nunca consultado. */
  checkedAt: string | null;
}

export interface ProjectUpdateStatusResponse {
  status: ProjectUpdateStatus;
}

export interface ProjectUpdateStatusListResponse {
  statuses: ProjectUpdateStatus[];
}

// ---------------------------------------------------------------------------
// Jobs de deploy
// ---------------------------------------------------------------------------

export type DeployJobStatus = "queued" | "running" | "success" | "failed";

export interface DeployJobStep {
  name: string;
  status: "running" | "done" | "failed" | "skipped";
  /** Quando a etapa começou (ISO). Ausente em deploys antigos e em etapas que não rodaram. */
  startedAt?: string;
  /** Quando a etapa terminou (ISO). */
  finishedAt?: string;
}

/** Tempo de subida de um serviço neste deploy (do início do container até estar pronto). */
export interface DeployJobStartup {
  service: string;
  seconds: number;
  via: "health" | "port";
  approx: boolean;
}

export interface DeployJob {
  id: string;
  projectId: string;
  /**
   * deploy = publicação completa; recreate = só recria os containers com a
   * configuração atual (ex.: fuso novo), sem baixar código nem rebuild.
   * Ausente = deploy (registros antigos).
   */
  kind?: "deploy" | "recreate";
  status: DeployJobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  steps: DeployJobStep[];
  /** Log bruto do deploy (stdout+stderr das etapas). */
  log: string;
  error: string | null;
  /** Tempo de subida por serviço, medido pelo monitoramento depois do deploy. Só nas respostas da API (não é gravado). */
  startups?: DeployJobStartup[];
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
  /** Serviço do compose (label com.docker.compose.service); null fora do compose. Ausente em respostas antigas. */
  service?: string | null;
  /** Saúde do healthcheck, lida do status do docker ps; null = sem healthcheck. */
  health?: "healthy" | "unhealthy" | "starting" | null;
  ports: string[];
}

// ---------------------------------------------------------------------------
// Domínios
// ---------------------------------------------------------------------------

/** Resultado da consulta de DNS de UM nome. */
export type DomainDnsState =
  /** Aponta para esta VPS. */
  | "pointed"
  /** Sem registro A. */
  | "missing"
  /** Aponta para outro lugar. */
  | "elsewhere"
  /** Cloudflare em modo proxy (nuvem laranja). */
  | "cloudflare"
  /** O DNS não respondeu agora (nada se conclui). */
  | "unavailable";

/**
 * Quem já usa o nome do par: o painel, outro projeto ou o próprio projeto. "unavailable" só sai
 * para token limitado a projetos: não revela quem usa (painel ou projeto fora do alcance dele).
 */
export type DomainPairOccupant = "panel" | "mail" | "other_project" | "same_project" | "unavailable";

/** Verificação do par (com/sem www) do domínio verificado. Par que falha é aviso, nunca erro. */
export interface DomainPairCheck {
  /** O nome do par (www.example.com ou example.com). */
  domain: string;
  /** O que o par é em relação ao digitado: "www" ou "apex". */
  role: "www" | "apex";
  ok: boolean;
  state: DomainDnsState;
  resolvedIps: string[];
  /** Quem já usa esse nome (o par não é criado). Ausente = livre. */
  occupiedBy?: DomainPairOccupant;
  message: string;
}

export interface DomainCheckResponse {
  domain: string;
  /** DNS do nome digitado, por categoria (a tela explica cada uma). */
  state?: DomainDnsState;
  /** O par (com/sem www). Ausente = este nome não tem par (subdomínio, IP, .localhost…). */
  pair?: DomainPairCheck;
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
  /** "Fazer backup" do projeto (padrão sim). Fica no serviço de backups, não no projeto. */
  backup?: boolean;
}

export interface UpdateProjectRequest {
  /** Nome de exibição. Editável e livre — nunca altera o slug. */
  name?: string;
  /** URL do repositório (modo git). Trocar exige re-clone no próximo deploy. */
  source?: string;
  /** Branch a publicar. Trocar exige re-clone no próximo deploy. */
  branch?: string;
  domain?: string;
  /** false com `domain` = não criar o par (com/sem www) desse domínio. */
  pair?: boolean;
  websocket?: boolean;
  proxyService?: string | null;
  proxyPort?: number | null;
  /** Aplicação de página única (site estático): o nginx responde index.html a qualquer caminho que não seja arquivo. */
  spa?: boolean;
  /** Marca "projeto de desenvolvimento" (muda só o padrão do backup antes de ações destrutivas na aba Banco). */
  development?: boolean;
}

/** Corpo opcional do `POST /api/projects/:id/detect`: o tipo escolhido à mão (null = voltar à detecção automática). */
export interface DetectRequest {
  type?: ProjectType | null;
}

/** Situação do par de um domínio do projeto (GET /api/projects/:id/domains/pairs). */
export interface ProjectDomainPair {
  /** O domínio conectado (canônico). */
  domain: string;
  pair: string;
  role: "www" | "apex";
  /** A pessoa deixou o par ligado (padrão). */
  enabled: boolean;
  state: DomainDnsState;
  occupiedBy?: DomainPairOccupant;
  /** O par está redirecionando agora: ligado, DNS apontado, nome livre e já aplicado no proxy. */
  active: boolean;
}

export interface ProjectDomainPairsResponse {
  pairs: ProjectDomainPair[];
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
  /** Aviso por e-mail ao dono que não pôde sair (só no deploy com override dos bloqueios). */
  alertWarning?: string;
}

export interface DeployJobListResponse {
  jobs: DeployJob[];
}

export interface DockerContainersResponse {
  containers: DockerContainerInfo[];
}

// ---------------------------------------------------------------------------
// Portas (modal "Portas" da página do projeto)
// ---------------------------------------------------------------------------

/** Porta de um container no ar, lida do docker ps. */
export interface LivePort {
  /** Endereço de escuta; null = todos (0.0.0.0 / ::). */
  hostIp: string | null;
  /** Porta do servidor; null = só exposta (interna, sem publicação). */
  hostPort: number | null;
  containerPort: number;
  protocol: string;
}

/** Uma porta publicada do compose, com a troca do painel aplicada. */
export interface ProjectPortEntry {
  /** Chave estável: como está no compose. */
  original: string;
  containerPort: number;
  protocol: string;
  /** Lado do servidor como o compose pede, em texto ("127.0.0.1:8010", "${P}", "aleatória"). */
  composeHost: string;
  /** Como o painel vai publicar: false = não publica (removida ou 80/443 retiradas). */
  published: boolean;
  /** Endereço de escuta configurado; null = todos. */
  hostIp: string | null;
  /** Porta do servidor configurada; null = aleatória, faixa ou variável. */
  hostPort: number | null;
  /** Troca feita no painel; null = como está no compose. */
  override: PortOverride | null;
  /** 80/443: "removed" = o painel retira; "conflict" = proxy HTTPS próprio. */
  panel: "removed" | "conflict" | null;
  /** O que está no ar já é isso? null = não dá para saber (parado, Docker fora). */
  applied: boolean | null;
  /** O painel pode trocar esta porta. */
  changeable: boolean;
  /** Publicação adicionada no painel (não está no compose). */
  added?: boolean;
  /** Lado do servidor como o compose pede (null = não é número fixo; nas adicionadas, null). */
  composeHostPort?: number | null;
  composeHostIp?: string | null;
}

export interface ProjectPortService {
  name: string;
  /** Container do serviço (null = sem container). */
  container: string | null;
  state: string | null;
  health: DockerContainerInfo["health"];
  /** Portas onde o app escuta dentro do container (informativo). */
  internalPorts: number[];
  /** Portas publicadas do compose (vazio fora do compose). */
  ports: ProjectPortEntry[];
  /** Portas publicadas no ar que não vêm do compose (ex.: projeto Dockerfile). */
  livePorts: LivePort[];
  /** `network_mode: service:X` → "X". */
  networkModeService: string | null;
  /** Por que o painel não pode publicar porta própria neste serviço (null = pode). */
  publishBlocked?: string | null;
}

export interface ProjectPortsView {
  projectId: string;
  projectName: string;
  type: ProjectType | null;
  /** O painel troca portas deste projeto (compose com o código disponível). */
  canChange: boolean;
  /** Entrada HTTP do painel (serviço:porta). */
  entry: { service: string | null; port: number | null } | null;
  services: ProjectPortService[];
  /** Há troca salva que ainda não está no ar (vale no próximo deploy). */
  pendingDeploy: boolean;
}

/** Uma linha da aba "Todos os projetos". */
export interface PortUsageRow {
  owner: "project" | "panel" | "external";
  projectId: string | null;
  projectName: string | null;
  container: string | null;
  service: string | null;
  image: string | null;
  state: string | null;
  hostIp: string | null;
  hostPort: number | null;
  containerPort: number | null;
  protocol: string;
  /** "live" = no ar agora; "configured" = o projeto vai usar no próximo deploy ou ao iniciar. */
  source: "live" | "configured";
  /** Outra coisa quer a mesma porta do servidor. */
  conflict: boolean;
  /** Com quem conflita (frase curta), quando conflict. */
  conflictWith: string | null;
}

export interface PortsResponse {
  /** false = o Docker não respondeu; só o que está configurado aparece. */
  docker: boolean;
  rows: PortUsageRow[];
  /** Portas do servidor reservadas ao painel (80, 443, 2019…). */
  reserved: number[];
}

export interface ProjectPortsResponse extends PortsResponse {
  project: ProjectPortsView;
}

export interface SetPortRequest {
  service: string;
  /** Chave da porta (ProjectPortEntry.original). */
  original: string;
  /** change = nova porta/endereço; remove = tirar a publicação; reset = como no compose. */
  action: "change" | "remove" | "reset";
  /** Nova porta do servidor (1024–65535); ausente = manter a mesma. */
  hostPort?: number;
  hostIp?: PortBindAddress;
}

/**
 * Uma publicação na edição em lote. Com `original`, é uma porta do compose
 * (troca, ou remoção com hostPort null); sem, é uma publicação adicionada no
 * painel (containerPort obrigatório).
 */
export interface PortPublicationInput {
  service: string;
  original?: string;
  containerPort?: number;
  protocol?: PortProtocol;
  /** Porta do servidor (1024–65535); null = remover a publicação do compose. */
  hostPort: number | null;
  /** Endereço de escuta; padrão 127.0.0.1. */
  hostIp?: PortBindAddress;
}

/**
 * Edição em lote: a lista COMPLETA de trocas e publicações adicionadas do
 * projeto. Substitui a atual; porta do compose fora da lista = como no compose.
 */
export interface SetPortsRequest {
  ports: PortPublicationInput[];
}

/** Erro de uma linha da edição em lote (índice na lista enviada). */
export interface PortRowError {
  index: number;
  message: string;
}

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Labels aplicadas a tudo que o painel cria no Docker. */
export const PAAS_LABEL_MANAGED = "paas.managed";
export const PAAS_LABEL_PROJECT = "paas.project";

/** Rede Docker dedicada dos projetos gerenciados + Caddy central. */
export const PAAS_NETWORK = "paas-net";

/**
 * Redes internas do painel (achado A4): os projetos hospedados ficam só na
 * paas-net, SEM o painel e SEM o Stalwart — senão alcançariam a API do painel
 * e a administração do e-mail. Cada ligação tem a sua rede:
 *  - paas-panel: só Caddy ↔ painel (o Caddy serve o domínio do painel);
 *  - paas-mail-admin: só painel ↔ Stalwart (API de administração);
 *  - paas-mail: Stalwart (SMTP), webmail e os serviços dos projetos com e-mail
 *    habilitado (o SMTP_HOST injetado aponta para o alias do Stalwart nela).
 */
export const PAAS_PANEL_NETWORK = "paas-panel";
export const PAAS_MAIL_ADMIN_NETWORK = "paas-mail-admin";
export const PAAS_MAIL_NETWORK = "paas-mail";

/** Nome do container do Caddy central. */
export const PAAS_CADDY_CONTAINER = "paas-caddy";
/** Volume com os certificados e a conta ACME do Caddy central (montado em /data do container). */
export const PAAS_CADDY_DATA_VOLUME = "paas_caddy_data";

/** Rede e proxy vistos pelo projeto (cartão "Rede e proxy" da seção Variáveis). */
export interface ProjectProxyInfo {
  /** Rede Docker compartilhada (paas-net). */
  network: string;
  /** IP do Caddy do painel nessa rede; null se ele não está nela agora. Não é fixo: muda se o Caddy for recriado. */
  ip: string | null;
  /** Sub-rede IPv4 da rede (CIDR), estável enquanto a rede existir; null se não foi possível ler. */
  subnet: string | null;
  /** Cabeçalhos com o IP do visitante que o Caddy envia ao app. */
  headers: string[];
  /** O projeto é compose (o cartão só explica o repasse das variáveis ao serviço nesse caso). */
  compose: boolean;
  /** Nome do app na rede e porta, como o Caddy o enxerga (ex.: meu-app:3000). */
  upstream: string;
  /** Variáveis que o painel entrega a cada deploy (nomes). */
  variables: string[];
  /** Quais dessas variáveis o projeto sobrescreveu com um valor próprio (vence o do painel). */
  overridden: string[];
  /** O tipo de projeto recebe variáveis de execução (site estático não recebe). */
  delivered: boolean;
}

/** Limite do log de deploy persistido por job (guarda só o final: o início é cortado). */
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
 * Nome citado num arquivo de exemplo do repositório (`.env.example`…). Só o
 * nome: o valor de exemplo nunca sai do servidor.
 */
export interface EnvExampleVariable {
  name: string;
  /** Arquivo onde o nome aparece, relativo ao código (ex.: ".env.example"). */
  file: string;
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
