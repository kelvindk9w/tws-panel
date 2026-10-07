/**
 * deploy-service.ts — orquestra projetos, jobs de deploy e o Caddy central.
 * Persistência em JSON (data/projects.json, data/deploy-jobs.json), seguindo o
 * padrão das fases 0/1 (ver services/setup-state.ts e security-service.ts).
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isInsideProjectsDir } from "./projects-dir.js";
import { httpError, type HttpError } from "./http-error.js";
import { GithubIntegration } from "./github-integration.js";
import { ProjectEnvStore, type EnvVar } from "./project-env.js";
import {
  DEFAULT_GIT_CREDENTIAL_USERNAME,
  DEPLOY_LOG_MAX_CHARS,
  INGEST_MODES,
  type CreateProjectRequest,
  type DeployJob,
  type DetectResult,
  type DockerContainerInfo,
  type DomainHttpsStatus,
  type GitReadCredential,
  type GuardrailReport,
  type EnvExampleVariable,
  type Project,
  type ProjectCredentialInfo,
  type ProjectEmailValueKey,
  type ProjectStatus,
  type PortsResponse,
  type ProjectPortsResponse,
  type SetPortRequest,
  type SetPortsRequest,
  type SetProjectCredentialRequest,
  type UpdateProjectRequest,
  missingComposeVariables,
} from "@paas/core";
import {
  DeployEngine,
  detectProject,
  ingestCode,
  projectSrcDir,
  projectWorkDir,
  runGuardrails,
  composeVariables,
  composeNetworkModes,
  composePortEntries,
  readEnvExamples,
  type CertificateStatus,
  type ComposePortEntry,
  type ComposeVariable,
  type EngineContext,
  type CaddyWebmail,
  type ManualCaddyCertificate,
  type PanelSite,
} from "@paas/deploy";

/** Nome do container do painel no docker-compose.yml (container_name). */
const PANEL_CONTAINER = "tws-panel";
import type { ServerConfig } from "../config.js";
import type { AlertsService } from "./alerts-service.js";
import type { AuditService } from "./audit-service.js";
import { CredentialVault } from "./credential-vault.js";
import { listContainers } from "./docker-service.js";
import { buildPortRows, checkPortChange, checkPortsBatch, projectPortsView, type PortsInput } from "./port-map.js";

const MAX_JOBS = 100;

interface ProjectsFile {
  projects: Project[];
}

interface JobsFile {
  jobs: DeployJob[];
}

export function slugify(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || `projeto-${randomBytes(3).toString("hex")}`;
}

/**
 * Hostname válido: rótulos alfanuméricos separados por ponto. Impede que
 * caracteres de controle do Caddyfile (`{`, `}`, quebra de linha, espaço)
 * cheguem ao arquivo gerado em caddy.ts.
 */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function normalizeDomain(domain: string): string {
  const normalized = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  return HOSTNAME_RE.test(normalized) ? normalized : "";
}

/**
 * URL de repositório aceita: https://, ssh:// ou o formato scp (git@host:caminho).
 *
 * Segurança: o valor vai como argumento posicional para `git clone` (ingest.ts).
 * O git interpreta a própria string, então uma allowlist de esquema é o que
 * bloqueia o transporte `ext::` (executa comando via sh) e valores iniciados
 * por `-`, que o git leria como flag.
 */
const GIT_URL_RE = /^(https|ssh):\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+$/;
const GIT_SCP_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[A-Za-z0-9._~/-]+$/;

export function validateGitSource(source: string): string {
  const value = source.trim();
  if (GIT_URL_RE.test(value) || GIT_SCP_RE.test(value)) return value;
  throw httpError(
    400,
    "invalid_source",
    "Fonte de código inválida. Use uma URL https://, ssh:// ou git@host:caminho.",
  );
}

/**
 * Nome de branch aceito: letras, números, ponto, traço, barra e underscore.
 * Não pode começar com `-` (o git leria como flag em checkout/pull).
 */
const BRANCH_RE = /^[A-Za-z0-9._/][A-Za-z0-9._/-]{0,200}$/;

export function validateBranch(branch: string | null | undefined): string | null {
  const value = (branch ?? "").trim();
  if (!value) return null;
  if (!BRANCH_RE.test(value) || value.includes("..")) {
    throw httpError(400, "invalid_branch", "Nome de branch inválido.");
  }
  return value;
}

/** Hooks opcionais da Fase 4 (auditoria + alertas) injetados pela API. */
export interface DeployHooks {
  audit?: AuditService;
  alerts?: AlertsService;
}

export class DeployService {
  private readonly engine: DeployEngine;
  private readonly engineCtx: EngineContext;
  private readonly projectsDir: string;
  private readonly projectsFile: string;
  private readonly jobsFile: string;
  private readonly caddyHttpPort: number;
  private readonly caddyHttpsPort: number;
  /** Portas do servidor que são do painel (Caddy, admin do Caddy, painel, e-mail). */
  private readonly reservedPorts: number[];
  private readonly hooks: DeployHooks;
  /**
   * Cofre das credenciais de leitura dos repositórios privados. Vive aqui (e
   * não em app.ts) porque quem conhece o ciclo de vida do projeto é este
   * serviço: criar, usar no clone e — principalmente — apagar junto com o
   * projeto.
   */
  private readonly credentials: CredentialVault;
  /** Conta do GitHub conectada (Configurações → Integrações). */
  readonly github: GithubIntegration;
  /** Variáveis de ambiente dos projetos (seção Variáveis), cifradas. */
  private readonly env: ProjectEnvStore;
  /** Variáveis do módulo de e-mail (SMTP), registradas pela rota de e-mail. */
  private mailEnv: ((project: Project) => Promise<Record<string, string>>) | null = null;
  /** Variáveis do app ligadas a valores do e-mail (SMTP_SENHA ← SMTP_PASS…). */
  private linkedMailEnv: ((project: Project) => Promise<Record<string, string>>) | null = null;
  /** De onde vem cada variável ligada (nome → valor do e-mail), só nomes. */
  private envLinkSourcesProvider: ((project: Project) => Promise<Record<string, ProjectEmailValueKey>>) | null = null;
  /** Hostnames do servidor de e-mail (mail.<domínio>), registrados pela rota de e-mail. */
  private mailHostsProvider: (() => Promise<string[]>) | null = null;
  /** Webmail ativado (upstream e IPs bloqueados), registrado pela rota de e-mail. */
  private webmailProvider: (() => Promise<CaddyWebmail | null>) | null = null;
  /** Certificados manuais em vigor (página Certificados), registrados no boot. */
  private manualCertificatesProvider: (() => Promise<ManualCaddyCertificate[]>) | null = null;
  /** Instala no Stalwart o certificado de mail.<domínio>, registrado pela rota de e-mail. */
  private mailTlsSync: (() => Promise<unknown>) | null = null;
  /** Site do painel no Caddy central (acesso por HTTPS); null = túnel. */
  private currentPanelSite: PanelSite | null;
  /** Nomes reservados ao painel mesmo antes de estarem no proxy (domínio cadastrado aguardando o DNS). */
  private panelReserved: string[] = [];
  private projects: Project[] = [];
  private jobs: DeployJob[] = [];
  private loaded = false;

  constructor(config: ServerConfig, hooks: DeployHooks = {}) {
    this.hooks = hooks;
    // Container do painel no compose (container_name) na rede paas-net.
    this.currentPanelSite = config.panelDomain
      ? { domain: config.panelDomain, upstream: `${PANEL_CONTAINER}:${config.port}` }
      : null;
    this.projectsDir = config.projectsDir;
    this.projectsFile = path.join(config.dataDir, "projects.json");
    this.jobsFile = path.join(config.dataDir, "deploy-jobs.json");
    this.caddyHttpPort = config.caddyHttpPort;
    this.caddyHttpsPort = config.caddyHttpsPort;
    this.reservedPorts = [
      ...new Set([
        80,
        443,
        2019,
        config.caddyHttpPort,
        config.caddyHttpsPort,
        config.port,
        ...(config.mailPorts ? Object.values(config.mailPorts) : []),
      ]),
    ].sort((a, b) => a - b);
    this.credentials = new CredentialVault(config.dataDir);
    this.github = new GithubIntegration(this.credentials);
    this.env = new ProjectEnvStore(config.dataDir);
    this.engineCtx = {
      projectsDir: this.projectsDir,
      // A ingestão pede a credencial na hora do clone. O valor em claro só
      // existe em memória e no ambiente do processo git (ver ingest.ts).
      credentialFor: (project: Project) => this.credentialFor(project),
      caddyDir: path.join(config.dataDir, "caddy"),
      nodeImage: process.env.PAAS_NODE_IMAGE ?? "node:22",
      staticImage: process.env.PAAS_STATIC_IMAGE ?? "nginx:alpine",
      caddyHttpPort: config.caddyHttpPort,
      caddyHttpsPort: config.caddyHttpsPort,
      // E-mail (SMTP), as Variáveis do projeto e as ligadas ao e-mail. Nome
      // padrão do e-mail (SMTP_HOST…): a das Variáveis substitui. Variável
      // ligada (EMAIL_DE ← MAIL_FROM): a ligação vence o valor salvo nas
      // Variáveis — validação real (03/10/2026): EMAIL_DE salva antes da
      // ligação, com o endereço de exemplo, ia no lugar do endereço da caixa.
      // Salva VAZIA nas Variáveis não apaga o valor do e-mail.
      envForProject: async (project: Project) => {
        const mail = (await this.mailEnv?.(project)) ?? {};
        const own = Object.entries(await this.env.asRecord(project.id)).filter(([k, v]) => v !== "" || !(k in mail));
        return { ...mail, ...Object.fromEntries(own), ...((await this.linkedMailEnv?.(project)) ?? {}) };
      },
      // Em TODOS os serviços do compose, só as do e-mail (comportamento de
      // sempre); as do operador vão pelo .env e o compose escolhe o destino.
      injectEnvForProject: async (project: Project) => (await this.mailEnv?.(project)) ?? {},
      // O Caddy serve mail.<domínio> para emitir o certificado do Stalwart.
      mailHosts: async () => (await this.mailHostsProvider?.()) ?? [],
      // Certificado manual: o Caddy usa o par enviado (`tls`) para o nome.
      manualCertificates: async () => (await this.manualCertificatesProvider?.()) ?? [],
      // Webmail ativado: os blocos mail.<domínio> encaminham para ele.
      webmail: async () => (await this.webmailProvider?.()) ?? null,
      ...(this.panelSite ? { panelSite: this.panelSite } : {}),
      // Em container, o health check fala com o Caddy pela rede interna
      // (127.0.0.1 de dentro do container não tem proxy — deploy saía como
      // "falhou" com o site no ar, visto em campo).
      ...(existsSync("/.dockerenv") ? { panelContainer: PANEL_CONTAINER } : {}),
    };
    this.engine = new DeployEngine(this.engineCtx);
  }

  /** Site do painel no Caddy central (acesso por HTTPS); null = túnel. */
  get panelSite(): PanelSite | null {
    return this.currentPanelSite;
  }

  /** Endereços em que o painel responde agora (o principal primeiro). */
  panelHosts(): string[] {
    const site = this.currentPanelSite;
    return site ? [site.domain, ...(site.aliases ?? [])] : [];
  }

  /**
   * Domínio do painel (Configurações → Domínio do painel): troca os endereços
   * do bloco do painel. Vale no próximo refreshProxy (quem chama decide).
   * No modo túnel não há site do painel — nada muda.
   */
  setPanelAddresses(site: { primary: string; aliases: string[] }): void {
    if (!this.currentPanelSite) return;
    this.currentPanelSite = { domain: site.primary, aliases: [...site.aliases], upstream: this.currentPanelSite.upstream };
    this.engine.caddy.setPanelSite(this.currentPanelSite);
  }

  /** Nomes reservados ao painel (domínio cadastrado, ainda sem DNS conferido). */
  setPanelReserved(names: string[]): void {
    this.panelReserved = [...names];
  }

  /** O nome é (ou vai ser) do painel: nenhum projeto pode usá-lo. */
  isPanelHost(domain: string): boolean {
    return this.panelHosts().includes(domain) || this.panelReserved.includes(domain);
  }

  /**
   * Garante o Caddy central no ar com o site do painel (acesso por HTTPS).
   * Chamado no boot: sem isso, numa instalação nova o Caddy só subiria no
   * primeiro deploy e o painel ficaria sem endereço. false = acesso por túnel.
   */
  async ensurePanelRoute(onLog?: (chunk: string) => void): Promise<boolean> {
    if (!this.panelSite) return false;
    await this.ensureLoaded();
    await this.engine.syncCaddy(this.projects, onLog);
    return true;
  }

  /**
   * Boot: sobe o site do painel sem bloquear o início do servidor, tentando de
   * novo se o Docker ainda estiver ocupado (ex.: logo depois do reboot da VPS).
   */
  startPanelRoute(
    log: { info: (msg: string) => void; warn: (msg: string) => void },
    opts: { attempts?: number; delayMs?: number } = {},
  ): void {
    if (!this.panelSite) return;
    const attempts = opts.attempts ?? 10;
    const delayMs = opts.delayMs ?? 30_000;
    const url = `https://${this.panelSite.domain}`;
    const attempt = (n: number): void => {
      this.ensurePanelRoute().then(
        () => log.info(`Painel publicado em ${url} (Caddy central, certificado Let's Encrypt).`),
        (err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err);
          if (n >= attempts) {
            log.warn(
              `Não foi possível publicar o painel em ${url} (${reason}); desistindo após ${n} tentativas — reinicie o painel (docker compose restart).`,
            );
            return;
          }
          log.warn(`Publicação do painel em ${url} falhou (${reason}); nova tentativa em ${delayMs / 1000}s.`);
          setTimeout(() => attempt(n + 1), delayMs).unref();
        },
      );
    };
    attempt(1);
  }

  /**
   * Registra o provedor de env vars extras por projeto (Fase 3 — injeção
   * SMTP). Chamado pelo módulo de e-mail na inicialização das rotas.
   */
  setEnvProvider(provider: (project: Project) => Promise<Record<string, string>>): void {
    this.mailEnv = provider;
  }

  /**
   * Registra o provedor das variáveis do app ligadas a valores do e-mail
   * (com o valor atual). Vão para o `.env` como as Variáveis do projeto —
   * não para todos os serviços do compose — e contam como fornecidas.
   */
  setLinkedEnvProvider(provider: (project: Project) => Promise<Record<string, string>>): void {
    this.linkedMailEnv = provider;
  }

  /** Registra quem informa de onde vem cada variável ligada ao e-mail (SMTP_SENHA ← SMTP_PASS). */
  setEnvLinkSourcesProvider(provider: (project: Project) => Promise<Record<string, ProjectEmailValueKey>>): void {
    this.envLinkSourcesProvider = provider;
  }

  /** Registra quem informa os hosts de e-mail que o proxy central precisa servir. */
  setMailHostsProvider(provider: () => Promise<string[]>): void {
    this.mailHostsProvider = provider;
  }

  /** Hostnames do servidor de e-mail (vazio sem o módulo de e-mail). */
  async mailHosts(): Promise<string[]> {
    return (await this.mailHostsProvider?.()) ?? [];
  }

  /** Registra quem instala no servidor de e-mail o certificado atual de mail.<domínio>. */
  setMailTlsSync(sync: () => Promise<unknown>): void {
    this.mailTlsSync = sync;
  }

  /** Instala no servidor de e-mail o certificado atual (nada sem o módulo de e-mail). */
  async syncMailTls(): Promise<void> {
    await this.mailTlsSync?.();
  }

  /** Registra quem informa se o webmail está ativado (e os IPs bloqueados nele). */
  setWebmailProvider(provider: () => Promise<CaddyWebmail | null>): void {
    this.webmailProvider = provider;
  }

  /** Registra quem informa os certificados manuais (página Certificados). */
  setManualCertificatesProvider(provider: () => Promise<ManualCaddyCertificate[]>): void {
    this.manualCertificatesProvider = provider;
  }

  /**
   * Recalcula o Caddyfile com todos os projetos (e os hosts de e-mail) e
   * recarrega. `force`: recarrega mesmo sem mudança — o Caddy recomeça na
   * hora a emissão dos nomes ainda sem certificado ("Tentar emitir agora").
   */
  async refreshProxy(onLog?: (chunk: string) => void, opts: { force?: boolean } = {}): Promise<void> {
    await this.ensureLoaded();
    await this.engine.syncCaddy(this.projects, onLog, opts);
  }

  /** O proxy central (Caddy) está rodando? */
  async proxyRunning(): Promise<boolean> {
    return this.engine.caddy.isRunning();
  }

  /** Certificado que o proxy central serve para o nome (como um navegador vê). */
  async servedCertificate(host: string): Promise<CertificateStatus> {
    return this.engine.servedCertificate(host);
  }

  /** Log das últimas 24 h do proxy central (texto não confiável — ver caddy-log.ts). */
  async proxyLogs(): Promise<string> {
    return this.engine.caddy.recentLogs();
  }

  /** Apaga de dentro do container do proxy o par manual do nome. */
  async removeManualCertificateFiles(host: string): Promise<void> {
    await this.engine.caddy.removeManualFiles(host);
  }

  /** Variáveis de ambiente do projeto (valem a partir do próximo deploy). */
  async getEnv(id: string): Promise<EnvVar[]> {
    await this.requireProject(id);
    return this.env.get(id);
  }

  /** Variáveis que o compose do projeto interpola (seção Variáveis mostra o que falta). */
  async composeVariablesFor(id: string): Promise<{ variables: ComposeVariable[]; usesEnvFile: boolean } | null> {
    const project = await this.requireProject(id);
    const file = project.detection?.type === "compose" ? project.detection.composeFile : null;
    if (!file) return null;
    try {
      const content = await readFile(path.join(projectSrcDir({ projectsDir: this.projectsDir }, project), file), "utf8");
      return composeVariables(content);
    } catch {
      return null;
    }
  }

  /**
   * Nomes citados nos arquivos de exemplo do código (`.env.example` e
   * variações), na raiz e na pasta do compose — o app pode ler variáveis
   * por `env_file` sem citá-las no compose. Só nomes; null = nenhum arquivo.
   */
  async envExampleFor(id: string): Promise<{ files: string[]; variables: EnvExampleVariable[] } | null> {
    const project = await this.requireProject(id);
    const composeFile = project.detection?.type === "compose" ? project.detection.composeFile : null;
    const dirs = ["", ...(composeFile ? [path.posix.dirname(composeFile).replace(/^\.$/, "")] : [])];
    try {
      return await readEnvExamples(projectSrcDir({ projectsDir: this.projectsDir }, project), dirs);
    } catch {
      return null; // código ainda não baixado
    }
  }

  /** Variáveis ligadas ao e-mail do projeto: nome → valor de origem (só nomes). */
  async envLinkSources(id: string): Promise<Record<string, ProjectEmailValueKey>> {
    const project = await this.requireProject(id);
    return (await this.envLinkSourcesProvider?.(project)) ?? {};
  }

  /** Certificado HTTPS de cada domínio do projeto (Visão geral). */
  async httpsStatus(id: string): Promise<DomainHttpsStatus[]> {
    const project = await this.requireProject(id);
    return this.engine.httpsStatus(project);
  }

  /** Variáveis que o painel fornece ao projeto sozinho: as do e-mail, se ativo, e as ligadas a ele. */
  async providedEnvKeys(id: string): Promise<string[]> {
    const project = await this.requireProject(id);
    const keys = new Set([
      ...Object.keys((await this.mailEnv?.(project)) ?? {}),
      ...Object.keys((await this.linkedMailEnv?.(project)) ?? {}),
    ]);
    return [...keys].sort();
  }

  /**
   * Valores que o painel fornece, para a seção Variáveis mostrar (com o olho).
   * A senha da caixa NÃO vai nesta listagem: nem SMTP_PASS, nem as variáveis
   * ligadas a ela, nem qualquer outra com o mesmo valor. Desde 04/10/2026 o
   * dono do produto quer poder vê-la pelo olho: ela sai uma por vez, a
   * pedido, por revealProvidedEnv (Auditoria + limite de frequência).
   */
  async providedEnvValues(id: string): Promise<Record<string, string>> {
    const project = await this.requireProject(id);
    const mail = (await this.mailEnv?.(project)) ?? {};
    const linked = (await this.linkedMailEnv?.(project)) ?? {};
    const sources = (await this.envLinkSourcesProvider?.(project)) ?? {};
    const password = mail.SMTP_PASS;
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries({ ...mail, ...linked })) {
      if (name === "SMTP_PASS" || sources[name] === "SMTP_PASS") continue;
      if (password && value === password) continue;
      out[name] = value;
    }
    return out;
  }

  /** Exibições por projeto no último minuto (limite do olho da seção Variáveis). */
  private readonly reveals = new Map<string, number[]>();

  /**
   * Valor de UMA variável fornecida pelo painel, senha da caixa inclusive,
   * para o olho da seção Variáveis. Decisão do dono do produto (04/10/2026):
   * "preciso conseguir visualizar o valor de qualquer variável". A listagem
   * (providedEnvValues) continua sem a senha; este valor só sai quando a
   * pessoa pede, fica na Auditoria (só o NOME) e tem limite de 30 por minuto
   * por projeto — o bastante para "Mostrar valores", pouco para varredura.
   */
  async revealProvidedEnv(id: string, name: string): Promise<string> {
    const project = await this.requireProject(id);
    const provided = {
      ...((await this.mailEnv?.(project)) ?? {}),
      ...((await this.linkedMailEnv?.(project)) ?? {}),
    };
    if (!Object.prototype.hasOwnProperty.call(provided, name)) {
      throw httpError(404, "env_not_provided", `${name} não é fornecida pelo painel neste projeto.`);
    }
    const now = Date.now();
    const recent = (this.reveals.get(project.id) ?? []).filter((t) => now - t < REVEAL_WINDOW_MS);
    if (recent.length >= REVEAL_LIMIT) {
      this.reveals.set(project.id, recent);
      throw httpError(429, "reveal_rate_limited", "Muitos valores exibidos em pouco tempo. Espere um minuto e tente de novo.");
    }
    recent.push(now);
    this.reveals.set(project.id, recent);
    await this.hooks.audit?.record({
      action: "project.env_revealed",
      target: project.slug,
      // só o NOME: o valor costuma ser segredo
      detail: `Valor de ${name} exibido no projeto "${project.name}".`,
    });
    return provided[name]!;
  }

  /**
   * Obrigatórias do compose ainda sem valor — nem nas Variáveis do projeto nem
   * fornecidas pelo painel. Vazio quando não é compose ou o código não está aqui.
   */
  async missingEnvFor(id: string): Promise<string[]> {
    const compose = await this.composeVariablesFor(id);
    if (!compose) return [];
    const defined = new Set([
      ...(await this.env.get(id)).filter((v) => v.value !== "").map((v) => v.key),
      ...(await this.providedEnvKeys(id)),
    ]);
    return missingComposeVariables(compose.variables, defined);
  }

  async setEnv(id: string, vars: EnvVar[]): Promise<EnvVar[]> {
    const project = await this.requireProject(id);
    const saved = await this.env.set(id, vars);
    await this.hooks.audit?.record({
      action: "project.env_updated",
      target: project.slug,
      // só os NOMES: valores costumam ser segredos
      detail: `Variáveis de "${project.name}" salvas (${saved.length}): ${saved.map((v) => v.key).join(", ") || "nenhuma"}.`,
    });
    return saved;
  }

  /**
   * URL de acesso ao projeto. Domínio público: https (o Caddy emite o
   * certificado sozinho). .localhost (desenvolvimento): http. A porta entra
   * quando não é a padrão.
   */
  projectUrl(project: Project): string {
    const local = project.domain === "localhost" || project.domain.endsWith(".localhost");
    if (local) {
      return this.caddyHttpPort === 80 ? `http://${project.domain}` : `http://${project.domain}:${this.caddyHttpPort}`;
    }
    return this.caddyHttpsPort === 443 ? `https://${project.domain}` : `https://${project.domain}:${this.caddyHttpsPort}`;
  }

  // -------------------------------------------------------------------------
  // Persistência
  // -------------------------------------------------------------------------

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.projectsFile, "utf8")) as Partial<ProjectsFile>;
      this.projects = Array.isArray(raw.projects) ? raw.projects : [];
    } catch {
      this.projects = [];
    }
    try {
      const raw = JSON.parse(await readFile(this.jobsFile, "utf8")) as Partial<JobsFile>;
      this.jobs = Array.isArray(raw.jobs) ? raw.jobs : [];
      // jobs "running" de uma execução anterior do processo são marcados como falhos
      for (const job of this.jobs) {
        if (job.status === "running" || job.status === "queued") {
          job.status = "failed";
          job.error = "Servidor reiniciado durante o deploy.";
          job.finishedAt = new Date().toISOString();
        }
      }
    } catch {
      this.jobs = [];
    }
  }

  private async saveProjects(): Promise<void> {
    await mkdir(path.dirname(this.projectsFile), { recursive: true });
    const data: ProjectsFile = { projects: this.projects };
    await writeFile(this.projectsFile, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  private async saveJobs(): Promise<void> {
    await mkdir(path.dirname(this.jobsFile), { recursive: true });
    const data: JobsFile = { jobs: this.jobs.slice(-MAX_JOBS) };
    await writeFile(this.jobsFile, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  // -------------------------------------------------------------------------
  // CRUD de projetos
  // -------------------------------------------------------------------------

  async listProjects(): Promise<Project[]> {
    await this.ensureLoaded();
    return this.projects;
  }

  async getProject(id: string): Promise<Project | null> {
    await this.ensureLoaded();
    return this.projects.find((p) => p.id === id || p.slug === id) ?? null;
  }

  async createProject(req: CreateProjectRequest): Promise<Project> {
    await this.ensureLoaded();
    const name = (req.name ?? "").trim();
    if (!name) throw httpError(400, "invalid_name", "Informe o nome do projeto.");
    if (!INGEST_MODES.includes(req.ingestMode)) {
      throw httpError(400, "invalid_ingest_mode", `Modo de ingestão inválido. Aceitos: ${INGEST_MODES.join(", ")}.`);
    }
    const rawSource = (req.source ?? "").trim();
    if (!rawSource) throw httpError(400, "invalid_source", "Informe a fonte do código (URL git ou caminho local).");
    // Modo git: a fonte vira argumento do `git clone`, então passa pela
    // allowlist de esquema. Modos upload/existing são caminhos locais.
    const source = req.ingestMode === "git" ? validateGitSource(rawSource) : rawSource;
    // Só a pasta de projetos: é a única do computador que o painel enxerga, e
    // qualquer outro caminho seria de dentro do container (inclusive /data,
    // com as chaves do cofre e do 2FA). Conferido ANTES de o caminho existir:
    // a resposta não revela o que há fora dela.
    if (
      (req.ingestMode === "upload" || req.ingestMode === "existing") &&
      !(await isInsideProjectsDir(this.projectsDir, source))
    ) {
      throw httpError(
        400,
        "source_outside_projects_dir",
        `A pasta precisa estar dentro da pasta de projetos (${this.projectsDir}).`,
      );
    }
    if ((req.ingestMode === "upload" || req.ingestMode === "existing") && !existsSync(path.resolve(source))) {
      throw httpError(400, "source_not_found", `Caminho não encontrado: ${source}`);
    }
    const branch = validateBranch(req.branch);
    const domain = normalizeDomain(req.domain ?? "");
    if (!domain) throw httpError(400, "invalid_domain", "Informe o domínio desejado.");

    let slug = slugify(name);
    while (this.projects.some((p) => p.slug === slug)) slug = `${slug}-${randomBytes(2).toString("hex")}`;
    if (this.domainInUse(domain, null)) {
      throw httpError(409, "domain_in_use", `O domínio ${domain} já está em uso por outro projeto.`);
    }

    const now = new Date().toISOString();
    const project: Project = {
      id: randomBytes(8).toString("hex"),
      name,
      slug,
      ingestMode: req.ingestMode,
      source,
      branch,
      domain,
      websocket: Boolean(req.websocket),
      detection: null,
      proxyService: req.proxyService?.trim() || null,
      proxyPort: req.proxyPort ?? null,
      createdAt: now,
      updatedAt: now,
      lastDeployAt: null,
      lastDeployStatus: null,
      deployedBranch: null,
      deployedSource: null,
    };
    this.projects.push(project);
    await this.saveProjects();
    // o endereço já responde ("site em configuração", com HTTPS) antes do deploy
    await this.applyProxy();
    return project;
  }

  /**
   * Recarrega o Caddy com todos os projetos. Falha aqui não desfaz o que foi
   * gravado: o próximo ajuste (ou deploy) tenta de novo.
   */
  private async applyProxy(): Promise<void> {
    try {
      await this.engine.syncCaddy(this.projects);
    } catch {
      // Caddy fora do ar: a configuração gravada vale no próximo ajuste
    }
  }

  async updateProject(id: string, req: UpdateProjectRequest): Promise<Project> {
    const project = await this.requireProject(id);
    // O slug NÃO é recalculado a partir do nome: ele nomeia o diretório do
    // clone, o compose project, a imagem, o alias de rede e os containers.
    // Renomear o projeto é uma mudança de rótulo; mexer no slug seria uma
    // migração de infraestrutura.
    if (req.name !== undefined) {
      const name = req.name.trim();
      if (!name) throw httpError(400, "invalid_name", "Informe o nome do projeto.");
      project.name = name;
    }
    if (req.source !== undefined) {
      const source = project.ingestMode === "git" ? validateGitSource(req.source) : req.source.trim();
      if (project.ingestMode !== "git" && !(await isInsideProjectsDir(this.projectsDir, source))) {
        throw httpError(
          400,
          "source_outside_projects_dir",
          `A pasta precisa estar dentro da pasta de projetos (${this.projectsDir}).`,
        );
      }
      project.source = source;
    }
    if (req.branch !== undefined) {
      project.branch = validateBranch(req.branch);
    }
    let domainChanged = false;
    if (req.domain !== undefined) {
      const domain = normalizeDomain(req.domain);
      if (!domain) throw httpError(400, "invalid_domain", "Domínio inválido.");
      if (domain !== project.domain && this.domainInUse(domain, project.id)) {
        throw httpError(409, "domain_in_use", `O domínio ${domain} já está em uso.`);
      }
      domainChanged = domain !== project.domain;
      project.domain = domain;
    }
    if (req.websocket !== undefined) project.websocket = Boolean(req.websocket);
    if (req.proxyService !== undefined) {
      const service = req.proxyService?.trim() || null;
      if (service) validateComposeEntry(project, service);
      project.proxyService = service;
    }
    if (req.proxyPort !== undefined) project.proxyPort = req.proxyPort;
    project.updatedAt = new Date().toISOString();
    await this.saveProjects();
    if (domainChanged) await this.applyProxy();
    return project;
  }

  async deleteProject(id: string, deleteSource: boolean, onLog: (chunk: string) => void): Promise<void> {
    const project = await this.requireProject(id);
    await this.hooks.audit?.record({
      action: "project.delete",
      target: project.slug,
      detail: `Projeto "${project.name}" removido (deleteSource=${deleteSource}).`,
    });
    await this.engine.remove(project, onLog);
    // Recalcula o Caddyfile sem o projeto removido (best-effort).
    this.projects = this.projects.filter((p) => p.id !== project.id);
    try {
      await this.engine.syncCaddy(this.projects, onLog);
    } catch {
      onLog("Aviso: não foi possível recarregar o Caddy após a remoção.\n");
    }
    // As variáveis também são segredos do projeto: saem com ele.
    await this.env.remove(project.id);
    // A credencial é um segredo com o mesmo ciclo de vida do projeto: sem
    // isto, o token sobreviveria ao projeto no disco — passivo, não recurso.
    if (await this.credentials.remove(project.id)) {
      onLog("Credencial de leitura do repositório removida do cofre.\n");
    }
    if (deleteSource && project.ingestMode !== "existing") {
      await rm(projectWorkDir({ projectsDir: this.projectsDir }, project), {
        recursive: true,
        force: true,
      });
      onLog("Código-fonte removido.\n");
    }
    await this.saveProjects();
  }

  // -------------------------------------------------------------------------
  // Credencial de LEITURA do repositório (repositórios privados)
  // -------------------------------------------------------------------------

  /** Existência + dica da credencial. NUNCA o valor. */
  async credentialInfo(project: Project): Promise<ProjectCredentialInfo> {
    return this.credentials.info(project.id);
  }

  /**
   * Grava (ou substitui) a credencial de leitura do projeto.
   * Devolve apenas o que pode ser mostrado — existência e dica.
   */
  async setCredential(
    id: string,
    req: SetProjectCredentialRequest,
  ): Promise<ProjectCredentialInfo> {
    const project = await this.requireProject(id);
    const token = (req.token ?? "").trim();
    if (!token) {
      throw httpError(
        400,
        "invalid_credential",
        "Informe o token de LEITURA do repositório (no GitHub, um fine-grained PAT com \"Contents: Read\").",
      );
    }
    const username = (req.username ?? "").trim() || DEFAULT_GIT_CREDENTIAL_USERNAME;
    return this.credentials.set(project.id, { username, token });
  }

  /** Apaga a credencial do projeto. true = havia uma credencial cadastrada. */
  async removeCredential(id: string): Promise<boolean> {
    const project = await this.requireProject(id);
    return this.credentials.remove(project.id);
  }

  // -------------------------------------------------------------------------
  // Detecção
  // -------------------------------------------------------------------------

  /** Diretório de código disponível localmente (src ingerido ou fonte local). */
  private sourceDirOf(project: Project): string | null {
    const src = projectSrcDir({ projectsDir: this.projectsDir }, project);
    if (existsSync(src)) return src;
    if (project.ingestMode === "git") return null;
    const dir = path.resolve(project.source);
    return existsSync(dir) ? dir : null;
  }

  /**
   * Roda os guardrails da Fase 4 sobre o código do projeto (sob demanda).
   * Retorna report=null quando o código ainda não está disponível localmente
   * (modo git antes do primeiro deploy — nesse caso o engine roda os
   * guardrails após a ingestão).
   */
  async guardrailsForProject(id: string): Promise<{ report: GuardrailReport | null; note: string | null }> {
    const project = await this.requireProject(id);
    const dir = this.sourceDirOf(project);
    if (!dir) {
      return {
        report: null,
        note: "Código ainda não ingerido (modo git). Os guardrails rodarão automaticamente no deploy, após o clone.",
      };
    }
    return { report: await runGuardrails(dir, project.detection?.composeFile, project.portOverrides), note: null };
  }

  async detect(id: string): Promise<DetectResult> {
    const project = await this.requireProject(id);
    // Modo upload/existing: usa a fonte original quando o src local ainda não
    // existe. Modo git: SEMPRE sincroniza agora com o repositório/branch
    // configurados, pelo mesmo caminho do deploy (com a credencial de leitura,
    // se houver) — clona na primeira vez, re-clona se a URL/branch mudou e só
    // faz fetch quando nada mudou. Antes a detecção exigia um
    // deploy anterior, e o assistente de novo projeto — que detecta logo após
    // criar — travava em qualquer repositório git (visto na validação real).
    let dir = project.ingestMode === "git" ? null : this.sourceDirOf(project);
    if (!dir) {
      try {
        dir = await ingestCode(this.engineCtx, project, () => undefined);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw httpError(422, "clone_failed", `Não foi possível baixar o código do repositório.\n\n${detail}`);
      }
    }
    const detection = await detectProject(dir);
    project.detection = detection;
    project.updatedAt = new Date().toISOString();
    await this.saveProjects();
    return detection;
  }

  // -------------------------------------------------------------------------
  // Deploy (job assíncrono)
  // -------------------------------------------------------------------------

  async startDeploy(id: string, opts?: { guardrailOverride?: boolean }): Promise<DeployJob> {
    const project = await this.requireProject(id);
    if (this.jobs.some((j) => j.projectId === project.id && (j.status === "running" || j.status === "queued"))) {
      throw httpError(409, "deploy_in_progress", "Já existe um deploy em andamento para este projeto.");
    }

    // Re-roda a detecção se necessário (código mudou desde a última).
    if (!project.detection) {
      const dir = this.sourceDirOf(project);
      if (dir) {
        project.detection = await detectProject(dir);
      }
    }
    if (!project.detection || project.detection.type === "unknown") {
      throw httpError(
        409,
        "unknown_type",
        "Tipo de projeto desconhecido. Rode a detecção e ajuste a configuração antes de deployar.",
      );
    }

    // Obrigatórias do compose sem valor: o `up` falharia — avisa antes, com a
    // lista (validação real: o cassino morria no compose com 8 faltando).
    const missing = await this.missingEnvFor(project.id);
    if (missing.length > 0) {
      const err = httpError(
        422,
        "missing_env",
        `Faltam ${missing.length} variável(is) obrigatória(s) do compose: ${missing.join(", ")}. ` +
          "Preencha na seção Variáveis do projeto e faça o deploy de novo.",
      );
      err.missing = missing;
      throw err;
    }

    // Fase 4: guardrails de deploy. Findings "block" exigem override explícito
    // (registrado em auditoria). No modo git sem código local, o engine re-roda
    // os guardrails após a ingestão e aplica a mesma decisão.
    const guardrailOverride = opts?.guardrailOverride === true;
    const srcDir = this.sourceDirOf(project);
    // Reaproveitado pelo engine na revalidação pós-ingestão quando é seguro
    // (ver comentário abaixo) — evita rodar o mesmo scan de guardrails duas
    // vezes sobre o mesmo diretório inalterado.
    let precomputedGuardrailReport: GuardrailReport | undefined;
    if (srcDir) {
      const report = await runGuardrails(srcDir, project.detection?.composeFile, project.portOverrides);
      // Só é seguro reaproveitar esse relatório na revalidação pós-ingestão do
      // engine quando o conteúdo do diretório NÃO muda entre este pré-check e
      // a ingestão (packages/deploy/src/ingest.ts): no modo "existing",
      // ingestCode() não copia nem faz pull — é literalmente o mesmo
      // diretório com o mesmo conteúdo. Em "git"/"upload" o conteúdo PODE
      // mudar (fetch+pull / recópia), então a revalidação pós-ingestão
      // precisa rodar de novo sobre o código efetivamente ingerido — é
      // exatamente o motivo de ela existir (pegar código que mudou depois do
      // clone), então não reaproveitamos o pré-check nesses dois modos.
      if (project.ingestMode === "existing") {
        precomputedGuardrailReport = report;
      }
      if (report.blockers > 0) {
        const blocking = report.findings.filter((f) => f.level === "block");
        const detail = blocking.map((f) => `[${f.rule}] ${f.title} — ${f.evidence}`).join("\n");
        if (!guardrailOverride) {
          await this.hooks.alerts?.create({
            severity: "critical",
            source: "guardrail",
            title: `Deploy bloqueado por guardrails: ${project.name}`,
            detail,
          });
          await this.hooks.audit?.record({
            action: "deploy.blocked",
            target: project.slug,
            detail: `Deploy bloqueado com ${report.blockers} violação(ões):\n${detail}`,
          });
          const err = httpError(
            409,
            "guardrail_blocked",
            `Deploy bloqueado: ${report.blockers} violação(ões) de segurança (block). Corrija ou confirme o override explícito.`,
          );
          err.report = report;
          throw err;
        }
        await this.hooks.audit?.record({
          action: "guardrail.override",
          target: project.slug,
          detail: `Override explícito de ${report.blockers} bloqueio(s) de guardrail:\n${detail}`,
        });
        await this.hooks.alerts?.create({
          severity: "warning",
          source: "guardrail",
          title: `Deploy com override de guardrails: ${project.name}`,
          detail,
        });
      }
    }

    await this.hooks.audit?.record({
      action: "deploy.start",
      target: project.slug,
      detail: `Deploy iniciado para "${project.name}" (${project.domain})${guardrailOverride ? " — com override de guardrails" : ""}.`,
    });

    const now = new Date().toISOString();
    const job: DeployJob = {
      id: randomBytes(8).toString("hex"),
      projectId: project.id,
      status: "running",
      createdAt: now,
      startedAt: now,
      finishedAt: null,
      steps: [
        { name: "Ingestão do código", status: "running" },
        { name: "Preparação", status: "running" },
        { name: "Build e subida", status: "running" },
        { name: "Proxy reverso (Caddy)", status: "running" },
        { name: "Health check", status: "running" },
      ].map((s, i) => ({ name: s.name, status: i === 0 ? "running" : ("skipped" as const) })),
      log: "",
      error: null,
    };
    // steps começam "skipped" (pendentes) e avançam conforme o log
    this.jobs.push(job);
    await this.saveProjects();
    await this.saveJobs();

    const appendLog = (chunk: string) => {
      job.log = (job.log + chunk).slice(-DEPLOY_LOG_MAX_CHARS);
      this.trackStep(job, chunk);
    };

    void (async () => {
      try {
        await this.engine.deploy(project, this.projects, appendLog, {
          guardrailOverride,
          precomputedGuardrailReport,
        });
        job.status = "success";
        project.lastDeployAt = new Date().toISOString();
        project.lastDeployStatus = "success";
        // Registra o FATO do que foi publicado. É a partir daqui que a tela
        // consegue dizer "configurado sandbox, no ar main" quando alguém edita
        // a configuração sem publicar em seguida.
        project.deployedBranch = project.branch;
        project.deployedSource = project.source;
        // persiste detecção feita durante o deploy
        project.updatedAt = new Date().toISOString();
        // primeira publicação: sem resposta do app, a página passa de
        // "em configuração" para "temporariamente indisponível"
        await this.applyProxy();
      } catch (err) {
        job.status = "failed";
        job.error = err instanceof Error ? err.message : String(err);
        project.lastDeployAt = new Date().toISOString();
        project.lastDeployStatus = "failed";
        appendLog(`\n✖ Deploy falhou: ${job.error}\n`);
      } finally {
        job.finishedAt = new Date().toISOString();
        for (const step of job.steps) {
          if (step.status === "running") step.status = job.status === "success" ? "done" : "failed";
        }
        await this.saveProjects();
        await this.saveJobs();
      }
    })();

    return job;
  }

  /** Marca etapas do job conforme os marcos "=== Etapa N/5" do log. */
  private trackStep(job: DeployJob, chunk: string): void {
    const match = /=== Etapa (\d)\/5/.exec(chunk);
    if (!match) return;
    const current = Number(match[1]) - 1;
    job.steps = job.steps.map((step, i) => ({
      name: step.name,
      status: i < current ? "done" : i === current ? "running" : "skipped",
    }));
  }

  async getJob(projectId: string, jobId: string): Promise<DeployJob | null> {
    await this.ensureLoaded();
    const project = await this.getProject(projectId);
    if (!project) return null;
    return this.jobs.find((j) => j.id === jobId && j.projectId === project.id) ?? null;
  }

  async listJobs(projectId: string): Promise<DeployJob[]> {
    await this.ensureLoaded();
    const project = await this.getProject(projectId);
    if (!project) return [];
    return this.jobs.filter((j) => j.projectId === project.id).slice(-20).reverse();
  }

  // -------------------------------------------------------------------------
  // Stop / start
  // -------------------------------------------------------------------------

  async stop(id: string, onLog: (chunk: string) => void): Promise<void> {
    const project = await this.requireProject(id);
    await this.engine.stop(project, onLog);
  }

  async start(id: string, onLog: (chunk: string) => void): Promise<void> {
    const project = await this.requireProject(id);
    await this.engine.start(project, onLog);
  }

  // -------------------------------------------------------------------------
  // Status agregado
  // -------------------------------------------------------------------------

  async statusOf(
    project: Project,
    containers?: DockerContainerInfo[],
  ): Promise<{ status: ProjectStatus; containers: DockerContainerInfo[] }> {
    const deploying = this.jobs.some(
      (j) => j.projectId === project.id && (j.status === "running" || j.status === "queued"),
    );
    let all: DockerContainerInfo[];
    try {
      all = containers ?? (await listContainers());
    } catch (err) {
      // Durante o deploy o Docker pode demorar a responder enquanto recria os
      // containers: é estado normal ("deploying"), não erro para a página.
      if (deploying) return { status: "deploying", containers: [] };
      throw err;
    }
    const mine = all.filter((c) => c.projectSlug === project.slug);
    let status: ProjectStatus;
    if (deploying) status = "deploying";
    else if (mine.length === 0) status = project.lastDeployStatus === "failed" ? "error" : "created";
    else if (mine.some((c) => c.state === "running")) status = "running";
    else status = project.lastDeployStatus === "failed" ? "error" : "stopped";
    return { status, containers: mine };
  }

  async listContainers(): Promise<DockerContainerInfo[]> {
    return listContainers();
  }

  // -------------------------------------------------------------------------
  // Portas (modal "Portas" da página do projeto)
  // -------------------------------------------------------------------------

  /** Portas publicadas e network_mode de cada serviço do compose do projeto, lidos do código no servidor. */
  private async composePortsOf(
    project: Project,
  ): Promise<{ ports: Record<string, ComposePortEntry[]>; networkModes: Record<string, string | null> } | null> {
    const file = project.detection?.type === "compose" ? project.detection.composeFile : null;
    const dir = file ? this.sourceDirOf(project) : null;
    if (!file || !dir) return null;
    try {
      const content = await readFile(path.join(dir, file), "utf8");
      return { ports: composePortEntries(content), networkModes: composeNetworkModes(content) };
    } catch {
      return null;
    }
  }

  /** Tudo o que o mapa de portas precisa, com UMA listagem do Docker. */
  private async portsInput(): Promise<PortsInput> {
    await this.ensureLoaded();
    let containers: DockerContainerInfo[] | null;
    try {
      containers = await listContainers();
    } catch {
      // Docker fora do ar: o modal mostra o que está configurado
      containers = null;
    }
    const composePorts = new Map<string, Record<string, ComposePortEntry[]> | null>();
    const networkModes = new Map<string, Record<string, string | null>>();
    for (const p of this.projects) {
      const facts = await this.composePortsOf(p);
      composePorts.set(p.id, facts?.ports ?? null);
      if (facts) networkModes.set(p.id, facts.networkModes);
    }
    return { projects: this.projects, composePorts, containers, reserved: this.reservedPorts, networkModes };
  }

  private portsResponse(input: PortsInput): PortsResponse {
    return { docker: input.containers !== null, rows: buildPortRows(input), reserved: input.reserved };
  }

  /** Todas as portas do servidor (somente leitura). */
  async portsOverview(): Promise<PortsResponse> {
    return this.portsResponse(await this.portsInput());
  }

  /** As portas do projeto e as de todo o servidor (somente leitura). */
  async projectPorts(id: string): Promise<ProjectPortsResponse> {
    const project = await this.requireProject(id);
    const input = await this.portsInput();
    return { ...this.portsResponse(input), project: projectPortsView(project, input) };
  }

  /**
   * Troca a porta do SERVIDOR de uma porta publicada do compose (ou remove a
   * publicação, ou volta ao compose). Vale no próximo deploy.
   */
  async setPort(id: string, req: SetPortRequest): Promise<ProjectPortsResponse> {
    const project = await this.requireProject(id);
    const input = await this.portsInput();
    const { portOverrides, detail } = checkPortChange(project, input, req);
    if (portOverrides) project.portOverrides = portOverrides;
    else delete project.portOverrides;
    project.updatedAt = new Date().toISOString();
    await this.saveProjects();
    await this.hooks.audit?.record({ action: "project.port_changed", target: project.slug, detail });
    return { ...this.portsResponse(input), project: projectPortsView(project, input) };
  }

  /**
   * Edição em lote (e "Publicar uma porta"): grava a lista COMPLETA de trocas
   * e publicações adicionadas numa chamada só. Qualquer linha com problema
   * recusa tudo (nada é gravado). Vale no próximo deploy.
   */
  async setPorts(id: string, req: SetPortsRequest): Promise<ProjectPortsResponse> {
    const project = await this.requireProject(id);
    const input = await this.portsInput();
    const { portOverrides, detail } = checkPortsBatch(project, input, req);
    if (portOverrides) project.portOverrides = portOverrides;
    else delete project.portOverrides;
    project.updatedAt = new Date().toISOString();
    await this.saveProjects();
    await this.hooks.audit?.record({ action: "project.ports_batch", target: project.slug, detail });
    return { ...this.portsResponse(input), project: projectPortsView(project, input) };
  }

  /**
   * true se o domínio já é do painel, de outro projeto (principal ou
   * adicional) ou — com `exceptProjectId` — um adicional do próprio projeto.
   */
  private domainInUse(domain: string, exceptProjectId: string | null): boolean {
    if (this.isPanelHost(domain)) return true;
    return this.projects.some((p) =>
      p.id === exceptProjectId ? (p.aliases ?? []).includes(domain) : p.domain === domain || (p.aliases ?? []).includes(domain),
    );
  }

  /**
   * Grava e aplica no Caddy na hora — também antes do primeiro deploy: o
   * domínio passa a responder com a página "site em configuração".
   */
  private async saveAndApplyDomains(project: Project, action: string, detail: string): Promise<Project> {
    project.updatedAt = new Date().toISOString();
    await this.saveProjects();
    await this.hooks.audit?.record({ action, target: project.slug, detail });
    await this.applyProxy();
    return project;
  }

  /** Conecta um domínio adicional ao projeto (o principal continua). */
  async addDomain(id: string, raw: string): Promise<Project> {
    const project = await this.requireProject(id);
    const domain = normalizeDomain(raw);
    if (!domain) throw httpError(400, "invalid_domain", "Domínio inválido. Exemplo: loja.meusite.com.br");
    if (domain === project.domain || this.domainInUse(domain, null)) {
      throw httpError(409, "domain_in_use", `O domínio ${domain} já está em uso.`);
    }
    project.aliases = [...(project.aliases ?? []), domain];
    return this.saveAndApplyDomains(project, "project.domain_added", `Domínio ${domain} conectado ao projeto "${project.name}".`);
  }

  /** Remove um domínio adicional (o principal só sai depois de outro virar principal). */
  async removeDomain(id: string, raw: string): Promise<Project> {
    const project = await this.requireProject(id);
    const domain = normalizeDomain(raw);
    if (domain === project.domain) {
      throw httpError(409, "primary_domain", "Este é o domínio principal. Torne outro domínio principal antes de removê-lo.");
    }
    if (!(project.aliases ?? []).includes(domain)) {
      throw httpError(404, "domain_not_found", `O domínio ${raw} não está conectado a este projeto.`);
    }
    project.aliases = (project.aliases ?? []).filter((d) => d !== domain);
    if (project.domainPorts?.[domain] !== undefined) {
      const { [domain]: _removida, ...resto } = project.domainPorts;
      project.domainPorts = resto;
    }
    return this.saveAndApplyDomains(project, "project.domain_removed", `Domínio ${domain} removido do projeto "${project.name}".`);
  }

  /**
   * Porta própria de um domínio no serviço de entrada (null = a do projeto).
   * Ex.: o site na 3200 e a carteira na 8009, no mesmo serviço.
   */
  async setDomainPort(id: string, raw: string, port: number | null): Promise<Project> {
    const project = await this.requireProject(id);
    const domain = normalizeDomain(raw);
    if (domain !== project.domain && !(project.aliases ?? []).includes(domain)) {
      throw httpError(404, "domain_not_found", `O domínio ${raw} não está conectado a este projeto.`);
    }
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      throw httpError(400, "invalid_port", "Porta inválida (de 1 a 65535).");
    }
    const { [domain]: _anterior, ...resto } = project.domainPorts ?? {};
    project.domainPorts = port === null ? resto : { ...resto, [domain]: port };
    return this.saveAndApplyDomains(
      project,
      "project.domain_port",
      `Domínio ${domain} de "${project.name}": ${port === null ? "porta do projeto" : `porta ${port}`}.`,
    );
  }

  /** Torna principal um domínio adicional; o antigo principal vira adicional. */
  async setPrimaryDomain(id: string, raw: string): Promise<Project> {
    const project = await this.requireProject(id);
    const domain = normalizeDomain(raw);
    if (domain === project.domain) return project;
    if (!(project.aliases ?? []).includes(domain)) {
      throw httpError(404, "domain_not_found", `O domínio ${raw} não está conectado a este projeto.`);
    }
    const old = project.domain;
    project.domain = domain;
    project.aliases = [old, ...(project.aliases ?? []).filter((d) => d !== domain)];
    return this.saveAndApplyDomains(project, "project.domain_primary", `Domínio principal de "${project.name}": ${old} → ${domain}.`);
  }

  /**
   * Credencial de clone: a do próprio projeto; sem ela, num repositório do
   * github.com, a da conta do GitHub conectada (ambas somente leitura).
   */
  async credentialFor(project: Project): Promise<GitReadCredential | null> {
    const own = await this.credentials.get(project.id);
    if (own) return own;
    return project.ingestMode === "git" ? this.github.credentialForUrl(project.source) : null;
  }

  // -------------------------------------------------------------------------

  private async requireProject(id: string): Promise<Project> {
    const project = await this.getProject(id);
    if (!project) throw httpError(404, "project_not_found", "Projeto não encontrado.");
    return project;
  }
}

/** Limite do olho da seção Variáveis: exibições por projeto numa janela. */
const REVEAL_LIMIT = 30;
const REVEAL_WINDOW_MS = 60_000;

export { httpError, type HttpError } from "./http-error.js";

/**
 * Entrada HTTP de um compose: o serviço tem de existir no compose detectado e
 * não pode usar a rede de outro (`network_mode: service:X`) — esse não entra
 * na rede do painel; a entrada certa é o X, na porta em que ele escuta.
 * Detecção antiga (sem a lista de serviços): aceita como antes.
 */
function validateComposeEntry(project: Project, service: string): void {
  const services = project.detection?.type === "compose" ? project.detection.services : undefined;
  if (!services || services.length === 0) return;
  const found = services.find((s) => s.name === service);
  if (!found) {
    throw httpError(
      400,
      "invalid_proxy_service",
      `O serviço "${service}" não existe no compose. Serviços: ${services.map((s) => s.name).join(", ")}.`,
    );
  }
  if (found.networkModeService) {
    throw httpError(
      400,
      "invalid_proxy_service",
      `O serviço "${service}" usa a rede do "${found.networkModeService}" (network_mode) e não entra na rede do painel: ` +
        `escolha "${found.networkModeService}" como entrada, na porta em que o "${service}" escuta.`,
    );
  }
}
