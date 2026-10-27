/**
 * deploy-service.ts — orquestra projetos, jobs de deploy e o Caddy central.
 * Persistência em JSON (data/projects.json, data/deploy-jobs.json), seguindo o
 * padrão das fases 0/1 (ver services/setup-state.ts e security-service.ts).
 */
import { createHash, randomBytes } from "node:crypto";
import { currentActor } from "./request-actor.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isInsideProjectsDir, isPanelArea, sameFolder } from "./projects-dir.js";

const PANEL_AREA_MESSAGE =
  "Essa pasta é a própria pasta de projetos ou a área interna do painel (.paas). Escolha a pasta do código dentro da pasta de projetos.";
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
  type DomainDnsState,
  type DomainHttpsStatus,
  type DomainPairOccupant,
  type GitAccessCheckRequest,
  type GitAccessCheckResponse,
  type GitAccessFailureReason,
  type GitReadCredential,
  type GuardrailReport,
  type EnvExampleVariable,
  type Project,
  NODE_BUILD_IMAGE,
  STATIC_SERVER_IMAGE,
  type ProjectCredentialInfo,
  type ProjectDomainPair,
  type ProjectEmailValueKey,
  type ProjectStatus,
  type ProjectType,
  type ProjectUpdateStatus,
  type PortsResponse,
  type ProjectPortsResponse,
  type SetPortRequest,
  type SetPortsRequest,
  type SetProjectCredentialRequest,
  type UpdateProjectRequest,
  type ProjectTimezoneDefinition,
  type ProjectTimezoneRequest,
  type ProjectTimezoneService,
  type ProjectTimezoneSetting,
  type ProjectTimezoneView,
  PAAS_NETWORK,
  effectiveProjectZone,
  mailTestContainerName,
  mailTestEnv,
  mailTestUserOverrides,
  type MailTestUncontrolled,
  isKnownTimezone,
  isSafeTimezoneName,
  missingComposeVariables,
  cleanHost,
  isOneLevelUnder,
  pairOf,
  timezoneOptions,
} from "@paas/core";
import {
  DeployEngine,
  GIT_ACCESS_MESSAGES,
  checkGitAccess,
  remoteBranchCommit,
  readDeployedCommit,
  resolveTarget,
  type DnsLookup,
  composeProjectName,
  detectProject,
  ForcedTypeError,
  ingestCode,
  projectSrcDir,
  runGuardrails,
  migrateLegacyWorkDir,
  removeProjectWorkDir,
  composeVariables,
  composeEnvFiles,
  composeTimezoneDefinitions,
  composeNetworkModes,
  composePortEntries,
  readEnvExamples,
  type CertificateStatus,
  type ComposePortEntry,
  type ComposeVariable,
  type DynamicDomainsInput,
  type EngineContext,
  type CaddyMtaSts,
  type CaddyWebmail,
  type ManualCaddyCertificate,
  type PanelSite,
} from "@paas/deploy";

/** Nome do container do painel no docker-compose.yml (container_name). */
export const PANEL_CONTAINER = "tws-panel";
import type { ServerConfig } from "../config.js";
import type { AlertsService } from "./alerts-service.js";
import type { AuditService } from "./audit-service.js";
import { CredentialVault } from "./credential-vault.js";
import { containerTimezone, listContainers } from "./docker-service.js";
import { buildPortRows, checkPortChange, checkPortsBatch, projectPortsView, type PortsInput } from "./port-map.js";
import { loadJson, withFileLock, writeFileAtomic } from "./json-file.js";
import { UpdateCheckService } from "./update-check-service.js";
import { scanUncontrolledMail } from "./mail-test-scan.js";

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
  const stripped = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  // A MESMA normalização do guia (core): Unicode vira punycode, e o que é guardado é sempre ASCII.
  const normalized = cleanHost(stripped);
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
/** O que o DeployService pede à caixa de teste de e-mail (implementada em mail-test-service.ts). */
/** Fotografia da caixa de teste no começo de um deploy/reinício: o que o app recebe e a versão disso. */
export interface MailTestSnapshot {
  /** "off" ou o hash do ambiente de e-mail (ver mailTestVersion). */
  version: string;
  box: { host: string; password: string } | null;
}

export interface MailTestProvider {
  /** Caixa ligada neste projeto? Devolve o host e a senha de SMTP que o app recebe; null = desligada. */
  active(project: Project): Promise<{ host: string; password: string } | null>;
  /** A fotografia do estado agora (um deploy usa a mesma do começo ao fim). */
  snapshot(project: Project): Promise<MailTestSnapshot>;
  /**
   * Deploy/reinício: sobe (ou garante) o Mailpit e devolve a rede interna dele; null = e-mail normal. Sem fotografia
   * (religar containers que já rodam) vale o ambiente que eles têm, não o que está ligado agora.
   */
  prepare(project: Project, snapshot: MailTestSnapshot | null): Promise<{ network: string } | null>;
  /** O deploy/reinício terminou bem com o ambiente desta versão: só agora os containers a têm. */
  applied(project: Project, version: string): Promise<void>;
  /** Projeto removido: apaga container, rede e mensagens. */
  removed(project: Project): Promise<void>;
}

export interface DeployHooks {
  audit?: AuditService;
  alerts?: AlertsService;
  /**
   * DNS de um nome (aponta para a VPS?). Usado só no par com/sem www dos
   * domínios; ausente = nenhum par é criado (o painel não sabe verificar).
   */
  hostState?: (host: string) => Promise<DomainDnsState>;
  /**
   * Um deploy terminou (notificações: "falhou" e "voltou a funcionar"). Recebe
   * o resultado anterior do projeto. Falha de quem escuta não muda o deploy.
   */
  onDeployFinished?: (e: {
    projectId: string;
    projectName: string;
    status: "success" | "failed";
    previousStatus: "success" | "failed" | null;
  }) => void;
}

export class DeployService {
  private readonly engine: DeployEngine;
  private readonly engineCtx: EngineContext;
  private readonly projectsDir: string;
  private readonly projectsFile: string;
  private readonly backupsDir: string;
  private readonly jobsFile: string;
  private readonly caddyHttpPort: number;
  private readonly caddyHttpsPort: number;
  /** Portas do servidor que são do painel (Caddy, admin do Caddy, painel, e-mail). */
  private readonly reservedPorts: number[];
  /** Projetos com um deploy/reinício sendo preparado (antes de o job existir). */
  private readonly starting = new Set<string>();
  private readonly hooks: DeployHooks;
  /**
   * Cofre das credenciais de leitura dos repositórios privados. Vive aqui (e
   * não em app.ts) porque quem conhece o ciclo de vida do projeto é este
   * serviço: criar, usar no clone e — principalmente — apagar junto com o
   * projeto.
   */
  private readonly credentials: CredentialVault;
  /** O mesmo cofre cifrado, para integrações (Cloudflare) que guardam o próprio token com a mesma chave. */
  get credentialVault(): CredentialVault {
    return this.credentials;
  }
  /** Conta do GitHub conectada (Configurações → Integrações). */
  readonly github: GithubIntegration;
  /** Alerta de "nova atualização" por projeto (só aviso; ver update-check-service.ts). */
  readonly updates: UpdateCheckService;
  /** Variáveis de ambiente dos projetos (seção Variáveis), cifradas. */
  private readonly env: ProjectEnvStore;
  /** Variáveis do módulo de e-mail (SMTP), registradas pela rota de e-mail. */
  private mailEnv: ((project: Project) => Promise<Record<string, string>>) | null = null;
  /** Variáveis do app ligadas a valores do e-mail (SMTP_SENHA ← SMTP_PASS…). */
  private linkedMailEnv: ((project: Project) => Promise<Record<string, string>>) | null = null;
  /** Caixa de teste de e-mail (Mailpit) dos projetos, registrada no boot (mail-test-service.ts). */
  private mailTest: MailTestProvider | null = null;
  /** De onde vem cada variável ligada (nome → valor do e-mail), só nomes. */
  private envLinkSourcesProvider: ((project: Project) => Promise<Record<string, ProjectEmailValueKey>>) | null = null;
  /** Quem solta o e-mail do projeto removido (módulo de e-mail); a falha dele não impede a remoção. */
  private projectRemovedListener: ((projectId: string) => Promise<void>) | null = null;
  /** Hostnames do servidor de e-mail (mail.<domínio>), registrados pela rota de e-mail. */
  private mailHostsProvider: (() => Promise<string[]>) | null = null;
  /** Sites da política MTA-STS dos domínios de e-mail (mta-sts.<domínio>), registrados pela rota de e-mail. */
  private mtaStsProvider: (() => Promise<CaddyMtaSts[]>) | null = null;
  /** Webmail ativado (upstream e IPs bloqueados), registrado pela rota de e-mail. */
  private webmailProvider: (() => Promise<CaddyWebmail | null>) | null = null;
  /** Certificados manuais em vigor (página Certificados), registrados no boot. */
  private manualCertificatesProvider: (() => Promise<ManualCaddyCertificate[]>) | null = null;
  /** Domínios dinâmicos por projeto (emissão sob demanda) e a URL do `ask`, registrados no boot. */
  private dynamicDomainsProvider: (() => Promise<DynamicDomainsInput | null>) | null = null;
  /** O nome é um domínio dinâmico cadastrado? Nenhum site fixo pode tomá-lo. */
  private dynamicClaims: ((host: string) => boolean) | null = null;
  /** Instala no Stalwart o certificado de mail.<domínio>, registrado pela rota de e-mail. */
  private mailTlsSync: (() => Promise<unknown>) | null = null;
  /** Site do painel no Caddy central (acesso por HTTPS); null = túnel. */
  private currentPanelSite: PanelSite | null;
  /** Nomes reservados ao painel mesmo antes de estarem no proxy (domínio cadastrado aguardando o DNS). */
  private panelReserved: string[] = [];
  private projects: Project[] = [];
  private jobs: DeployJob[] = [];
  private loadedPromise: Promise<void> | null = null;
  /** Fuso da VPS em uso (Configurações → Fuso horário), para "Igual ao da VPS". */
  private hostTimezoneProvider: () => string = () => process.env.TZ || "UTC";
  /** TZ e base de fusos de um container (trocado nos testes). */
  private timezoneProbe: (id: string, zone: string | null) => Promise<{ tz: string | null; zoneinfo: boolean | null }> = (id, zone) =>
    containerTimezone(id, zone);

  constructor(config: ServerConfig, hooks: DeployHooks = {}) {
    this.hooks = hooks;
    // Container do painel no compose (container_name) na rede paas-net.
    this.currentPanelSite = config.panelDomain
      ? { domain: config.panelDomain, upstream: `${PANEL_CONTAINER}:${config.port}` }
      : null;
    // o mesmo padrão de config.ts (PAAS_PROJECTS_DIR ?? <dataDir>/projects)
    this.projectsDir = config.projectsDir ?? path.join(config.dataDir, "projects");
    this.projectsFile = path.join(config.dataDir, "projects.json");
    this.backupsDir = path.join(config.dataDir, "backups");
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
      ...(config.panelInstallDir ? { panelInstallDir: config.panelInstallDir } : {}),
      // A ingestão pede a credencial na hora do clone. O valor em claro só
      // existe em memória e no ambiente do processo git (ver ingest.ts).
      credentialFor: (project: Project) => this.credentialFor(project),
      caddyDir: path.join(config.dataDir, "caddy"),
      nodeImage: process.env.PAAS_NODE_IMAGE ?? NODE_BUILD_IMAGE,
      staticImage: process.env.PAAS_STATIC_IMAGE ?? STATIC_SERVER_IMAGE,
      protectedImages: [config.hostHelperImage],
      projectSlugs: () => this.projects.map((p) => p.slug),
      caddyHttpPort: config.caddyHttpPort,
      caddyHttpsPort: config.caddyHttpsPort,
      // E-mail (SMTP), as Variáveis do projeto e as ligadas ao e-mail. Nome
      // padrão do e-mail (SMTP_HOST…): a das Variáveis substitui. Variável
      // ligada (EMAIL_DE ← MAIL_FROM): a ligação vence o valor salvo nas
      // Variáveis — validação real (03/10/2026): EMAIL_DE salva antes da
      // ligação, com o endereço de exemplo, ia no lugar do endereço da caixa.
      // Salva VAZIA nas Variáveis não apaga o valor do e-mail.
      envForProject: async (project: Project) => {
        // começo de um deploy/reinício: UMA fotografia da caixa de teste, usada até o fim (ambiente, rede, "aplicado")
        const snap = await this.takeMailSnapshot(project);
        const mail = await this.mailEnvOf(project, snap);
        const own = Object.entries(await this.env.asRecord(project.id)).filter(([k, v]) => v !== "" || !(k in mail));
        // Caixa de teste ligada: o conjunto completo do Mailpit vence tudo o que o projeto salvou nas Variáveis
        // (inclusive as ligadas ao e-mail): o e-mail real nunca chega ao app.
        const box = snap?.box ?? null;
        return { ...mail, ...Object.fromEntries(own), ...(box ? mailTestEnv(box) : {}), ...(await this.linkedEnvOf(project, snap)) };
      },
      // Caixa de teste de e-mail: sobe o Mailpit do projeto e devolve a rede interna dele.
      mailTestForProject: async (project: Project) => (await this.mailTest?.prepare(project, this.mailSnaps.get(project.id) ?? null)) ?? null,
      // Só as marcadas como "de build" (públicas): vão ao build estático e ao docker build; as demais nunca.
      buildEnvForProject: async (project: Project) => this.env.buildRecord(project.id),
      // Em TODOS os serviços do compose, só as do e-mail (comportamento de
      // sempre); as do operador vão pelo .env e o compose escolhe o destino.
      injectEnvForProject: async (project: Project) => this.mailEnvOf(project, this.mailSnaps.get(project.id)),
      // Fuso do projeto: TZ nos serviços que não definem TZ (compose-timezone.ts).
      timezoneForProject: async (project: Project) => this.projectZone(project),
      // O Caddy serve mail.<domínio> para emitir o certificado do Stalwart.
      mailHosts: async () => (await this.mailHostsProvider?.()) ?? [],
      // Domínios dinâmicos: blocos de emissão sob demanda, com o `ask` do painel.
      dynamicDomains: async () => (await this.dynamicDomainsProvider?.()) ?? null,
      // Certificado manual: o Caddy usa o par enviado (`tls`) para o nome.
      manualCertificates: async () => (await this.manualCertificatesProvider?.()) ?? [],
      // Webmail ativado: os blocos mail.<domínio> encaminham para ele.
      webmail: async () => (await this.webmailProvider?.()) ?? null,
      ...(hooks.hostState ? { hostState: hooks.hostState } : {}),
      // Domínio do painel cadastrado e ainda sem DNS conferido: o par não toma esse nome.
      reservedNames: () => this.panelReserved,
      ...(this.panelSite ? { panelSite: this.panelSite } : {}),
      // Em container, o health check fala com o Caddy pela rede interna
      // (127.0.0.1 de dentro do container não tem proxy — deploy saía como
      // "falhou" com o site no ar, visto em campo).
      ...(existsSync("/.dockerenv") ? { panelContainer: PANEL_CONTAINER } : {}),
    };
    this.engine = new DeployEngine(this.engineCtx);
    this.updates = new UpdateCheckService({
      credentialFor: (project) => this.credentialFor(project),
      // lê targetLookup na hora da consulta (os testes trocam a resolução de nomes depois)
      resolveTarget: (source) => resolveTarget(source, this.targetLookup),
      remoteBranchCommit,
    });
  }

  /**
   * Migração (A4): containers antigos na rede dos projetos com alias que é
   * nome do painel. Só avisa — parar container de projeto é decisão do
   * operador. Nunca lança (roda no boot).
   */
  async warnReservedNetworkAliases(log: { warn: (msg: string) => void }): Promise<void> {
    try {
      for (const { container, alias } of await this.engine.caddy.reservedAliases()) {
        log.warn(
          `Rede ${PAAS_NETWORK}: o container ${container} responde pelo nome "${alias}", que é do painel — ele poderia receber o tráfego do painel. ` +
            `Confira o compose do projeto e, para tirá-lo da rede agora: docker network disconnect ${PAAS_NETWORK} ${container}. ` +
            "O próximo deploy do projeto já é barrado por esse alias.",
        );
      }
    } catch (err) {
      log.warn(`Rede ${PAAS_NETWORK}: não consegui conferir os nomes dos containers (${err instanceof Error ? err.message : String(err)}).`);
    }
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

  /** Registra a caixa de teste de e-mail: com ela ligada, o SMTP do projeto vai para o Mailpit. */
  setMailTestProvider(provider: MailTestProvider): void {
    this.mailTest = provider;
  }

  /**
   * Variáveis de e-mail que o painel entrega: as do e-mail do projeto e, com a caixa de teste ligada, as SMTP_*
   * apontando para o Mailpit (o servidor de e-mail real fica de fora; MAIL_FROM e o nome continuam).
   */
  private async mailEnvOf(project: Project, snap?: MailTestSnapshot | null): Promise<Record<string, string>> {
    const base = (await this.mailEnv?.(project)) ?? {};
    const box = snap !== undefined ? (snap?.box ?? null) : await this.mailTest?.active(project);
    return box ? { ...base, ...mailTestEnv(box) } : base;
  }

  /** As variáveis ligadas ao e-mail; as ligadas a SMTP_* seguem o Mailpit enquanto a caixa de teste está ligada. */
  private async linkedEnvOf(project: Project, snap?: MailTestSnapshot | null): Promise<Record<string, string>> {
    const linked = (await this.linkedMailEnv?.(project)) ?? {};
    const box = snap !== undefined ? (snap?.box ?? null) : await this.mailTest?.active(project);
    if (!box) return linked;
    const mail = await this.mailEnvOf(project, snap);
    const out = { ...linked };
    for (const [name, source] of Object.entries((await this.envLinkSourcesProvider?.(project)) ?? {})) {
      if (mail[source] !== undefined) out[name] = mail[source]!;
    }
    return out;
  }

  /** Fotografias da caixa de teste dos deploys/reinícios em andamento (por projeto); soltas no fim do job. */
  private readonly mailSnaps = new Map<string, MailTestSnapshot>();

  private async takeMailSnapshot(project: Project): Promise<MailTestSnapshot | null> {
    if (!this.mailTest) return null;
    const snap = await this.mailTest.snapshot(project);
    this.mailSnaps.set(project.id, snap);
    return snap;
  }

  /** O deploy/reinício terminou bem: os containers têm o ambiente da fotografia. Nunca falha o deploy. */
  private async markMailApplied(project: Project): Promise<void> {
    const snap = this.mailSnaps.get(project.id);
    if (!snap || !this.mailTest) return;
    try {
      await this.mailTest.applied(project, snap.version);
    } catch (err) {
      console.warn(`Caixa de teste de e-mail: não consegui registrar o ambiente aplicado de ${project.slug} (${err instanceof Error ? err.message : String(err)}).`);
    }
  }

  /** A caixa de teste do projeto, para a seção Variáveis: host e quais variáveis ela redireciona (null = desligada). */
  async mailTestInfo(id: string): Promise<{ host: string; variables: string[] } | null> {
    const project = await this.requireProject(id);
    const box = await this.mailTest?.active(project);
    if (!box) return null;
    const names = new Set(Object.keys(mailTestEnv(box)));
    for (const v of await this.env.get(id)) if (v.value !== "") names.add(v.key);
    const redirected = new Set(Object.keys(mailTestUserOverrides(names, box)));
    for (const [name, source] of Object.entries((await this.envLinkSourcesProvider?.(project)) ?? {})) {
      if (["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS"].includes(source)) redirected.add(name);
    }
    for (const base of Object.keys(mailTestEnv(box))) redirected.add(base);
    return { host: box.host, variables: [...redirected].sort() };
  }

  /**
   * Variáveis de e-mail do projeto que a caixa de teste NÃO redireciona (achadas no .env versionado, no compose, nos
   * env_file, no Dockerfile e nas Variáveis do painel), para a tela avisar. Nunca lança.
   */
  async mailTestUncontrolled(project: Project): Promise<MailTestUncontrolled[]> {
    try {
      const own = (await this.env.get(project.id)).map((v) => v.key);
      return await scanUncontrolledMail({
        srcDir: this.sourceDirOf(project),
        composeFile: project.detection?.type === "compose" ? (project.detection.composeFile ?? null) : null,
        panelNames: own,
        controlled: new Set(Object.keys(mailTestEnv({ host: "x", password: "x" }))),
      });
    } catch {
      return [];
    }
  }

  /** Registra quem informa de onde vem cada variável ligada ao e-mail (SMTP_SENHA ← SMTP_PASS). */
  setEnvLinkSourcesProvider(provider: (project: Project) => Promise<Record<string, ProjectEmailValueKey>>): void {
    this.envLinkSourcesProvider = provider;
  }

  /**
   * Registra quem é avisado quando um projeto é removido: o módulo de e-mail solta o vínculo dele (a caixa e as
   * mensagens ficam). Falha do ouvinte vai para o log da remoção e não a impede.
   */
  setProjectRemovedListener(listener: (projectId: string) => Promise<void>): void {
    this.projectRemovedListener = listener;
  }

  /** Registra quem informa os hosts de e-mail que o proxy central precisa servir. */
  setMailHostsProvider(provider: () => Promise<string[]>): void {
    this.mailHostsProvider = provider;
  }

  /** Registra quem informa os sites da política MTA-STS (mta-sts.<domínio>) que o proxy central publica. */
  setMtaStsProvider(provider: () => Promise<CaddyMtaSts[]>): void {
    this.mtaStsProvider = provider;
  }

  /** Sites da política MTA-STS dos domínios de e-mail (vazio sem o módulo de e-mail). */
  async mtaStsSites(): Promise<CaddyMtaSts[]> {
    return (await this.mtaStsProvider?.()) ?? [];
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

  /** Registra quem informa os domínios dinâmicos (e a URL do `ask`) que o proxy central precisa servir. */
  setDynamicDomainsProvider(provider: () => Promise<DynamicDomainsInput | null>): void {
    this.dynamicDomainsProvider = provider;
  }

  /** O proxy consegue publicar a política MTA-STS? Precisa do `ask` (domínio do painel configurado). */
  async mtaStsPublishing(): Promise<boolean> {
    return ((await this.dynamicDomainsProvider?.()) ?? null) !== null;
  }

  /**
   * Registra a reserva de cota de certificados de um domínio comum (`count` emissões; o ator é o token, se houver).
   * Devolve o motivo da recusa ou a função que devolve a reserva.
   */
  setDomainQuota(quota: (host: string, count: number, actor?: string) => Promise<{ reason: string } | { release: () => void }>): void {
    this.domainQuota = quota;
  }

  private domainQuota: ((host: string, count: number, actor?: string) => Promise<{ reason: string } | { release: () => void }>) | null = null;

  /** Reserva a cota de certificados do domínio novo (e do par www, se ligado). Lança 429 se passou do teto. */
  private async reserveDomainQuota(domain: string, pairOn: boolean): Promise<() => void> {
    if (!this.domainQuota) return () => undefined;
    const reserved = await this.domainQuota(domain, pairOn && pairOf(domain) ? 2 : 1, currentActor());
    if ("reason" in reserved) {
      if (reserved.reason === "state_unreadable") {
        throw httpError(
          503,
          "quota_state_unreadable",
          "Não foi possível ler o estado dos certificados (arquivo dos domínios dinâmicos ilegível). O cadastro foi recusado para não estourar o limite do Let's Encrypt; corrija o arquivo e tente de novo.",
        );
      }
      throw httpError(
        429,
        reserved.reason,
        reserved.reason === "hourly_limit"
          ? "Limite de certificados por hora atingido (os mesmos tetos dos domínios dinâmicos). Tente mais tarde."
          : "Limite semanal de certificados deste domínio atingido (o Let's Encrypt barra 50 por semana). Tente em alguns dias.",
      );
    }
    return reserved.release;
  }

  /** Registra a consulta "este nome é um domínio dinâmico cadastrado?". */
  setDynamicClaims(claims: (host: string) => boolean): void {
    this.dynamicClaims = claims;
  }

  /** Certificados já emitidos pelo Caddy, lidos do armazenamento (sem abrir conexão TLS). */
  async issuedCertificates(): Promise<Map<string, CertificateStatus> | null> {
    return this.engine.issuedCertificates();
  }

  /**
   * Quem serve o nome como site FIXO: o painel, o servidor de e-mail ou o domínio
   * (principal ou adicional) de um projeto. Domínio dinâmico não pode tomá-lo.
   */
  async staticOccupant(host: string): Promise<"panel" | "mail" | "project" | null> {
    await this.ensureLoaded();
    if (this.isPanelHost(host)) return "panel";
    if ((await this.mailHosts().catch((): string[] => [])).includes(host)) return "mail";
    if (this.projects.some((p) => p.domain === host || (p.aliases ?? []).includes(host))) return "project";
    // política MTA-STS de um domínio de e-mail: é do e-mail (nenhum projeto nem domínio dinâmico toma o nome)
    return (await this.mtaStsSites().catch((): CaddyMtaSts[] => [])).some((s) => s.host === host) ? "mail" : null;
  }

  /**
   * Sites FIXOS (painel, e-mail, domínio principal e adicionais de projetos) que ficam exatamente
   * um nível abaixo do sufixo, com o projeto dono (null = painel ou e-mail). Um sufixo dinâmico
   * de outro projeto não pode cobrir esses nomes: o curinga tomaria o tráfego deles.
   */
  async fixedHostsUnder(suffix: string): Promise<Array<{ host: string; projectId: string | null }>> {
    await this.ensureLoaded();
    const out: Array<{ host: string; projectId: string | null }> = [];
    for (const h of [...this.panelHosts(), ...this.panelReserved, ...(await this.mailHosts().catch((): string[] => []))]) {
      if (isOneLevelUnder(h, suffix)) out.push({ host: h, projectId: null });
    }
    for (const p of this.projects) {
      for (const h of [p.domain, ...(p.aliases ?? [])]) if (h && isOneLevelUnder(h, suffix)) out.push({ host: h, projectId: p.id });
    }
    return out;
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

  /**
   * Valores das variáveis do projeto (as dele, as do e-mail e as ligadas a
   * ele) para MASCARAR o que os containers escrevem na aba Logs. Nunca sai da
   * API: só alimenta a máscara. Se não for possível ler (cofre quebrado), quem
   * chama não mostra log nenhum.
   */
  async logSecretValues(project: Project): Promise<string[]> {
    return [
      ...Object.values((await this.mailEnvOf(project))),
      ...Object.values(await this.env.asRecord(project.id)),
      ...Object.values((await this.linkedEnvOf(project))),
    ];
  }

  /** Deploys bloqueados por guardrail feitos por TOKEN, por projeto + ator + conjunto de regras (o `detail`). */
  private readonly blockedSeen = new Map<string, { at: number; suppressed: number; slug: string; detail: string; actor: string; timer?: NodeJS.Timeout }>();

  /**
   * O mesmo bloqueio, pelo mesmo token, no mesmo projeto, dentro de um minuto, só grava a Auditoria e o alerta na primeira
   * vez; a contagem do que foi suprimido entra quando a janela fecha. Nunca suprime o deploy de uma pessoa (sem token) nem
   * um conjunto de regras diferente.
   */
  private blockedRecently(project: { id: string; slug: string }, detail: string): boolean {
    const actor = currentActor();
    if (!actor) return false;
    const now = Date.now();
    const key = `${project.id}|${actor}|${createHash("sha256").update(detail).digest("hex")}`;
    const seen = this.blockedSeen.get(key);
    if (seen && now - seen.at < 60_000) {
      seen.suppressed++;
      if (!seen.timer) {
        seen.timer = setTimeout(() => {
          this.blockedSeen.delete(key);
          void this.hooks.audit?.record({
            actor,
            action: "deploy.blocked",
            target: project.slug,
            detail: `Deploy bloqueado de novo ${seen.suppressed} vez(es) na última janela de 1 minuto, com as mesmas violações do registro anterior.`,
          });
        }, Math.max(1, 60_000 - (now - seen.at)) + 50);
        seen.timer.unref();
      }
      return true;
    }
    if (this.blockedSeen.size >= 1_000) {
      for (const [k, v] of this.blockedSeen) if (now - v.at >= 60_000 && !v.timer) this.blockedSeen.delete(k);
    }
    this.blockedSeen.set(key, { at: now, suppressed: 0, slug: project.slug, detail, actor });
    return false;
  }

  /** Variáveis que o painel fornece ao projeto sozinho: as do e-mail, se ativo, e as ligadas a ele. */
  async providedEnvKeys(id: string): Promise<string[]> {
    const project = await this.requireProject(id);
    const keys = new Set([
      ...Object.keys((await this.mailEnvOf(project))),
      ...Object.keys((await this.linkedEnvOf(project))),
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
    const mail = (await this.mailEnvOf(project));
    const linked = (await this.linkedEnvOf(project));
    const sources = (await this.envLinkSourcesProvider?.(project)) ?? {};
    const password = mail.SMTP_PASS;
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries({ ...mail, ...linked })) {
      if (name === "SMTP_PASS" || sources[name] === "SMTP_PASS") continue;
      if (password && value.includes(password)) continue;
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
      ...((await this.mailEnvOf(project))),
      ...((await this.linkedEnvOf(project))),
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
      detail:
        `Variáveis de "${project.name}" salvas (${saved.length}): ${saved.map((v) => v.key).join(", ") || "nenhuma"}.` +
        // marcar "de build" expõe o valor (JavaScript do site, histórico da imagem): fica registrado, só o nome
        (saved.some((v) => v.build === true) ? ` Marcadas "de build": ${saved.filter((v) => v.build === true).map((v) => v.key).join(", ")}.` : ""),
    });
    return saved;
  }

  /**
   * Acrescenta ou troca variáveis sem tocar nas outras (a mescla roda dentro da fila do armazenamento) e audita só
   * os NOMES. Usada pelo MCP; a tela continua usando setEnv.
   */
  async mergeEnv(id: string, vars: EnvVar[], opts: { allowOverwrite: boolean }): Promise<EnvVar[]> {
    const project = await this.requireProject(id);
    // Mesclar o que já está igual não muda nada: não grava nem audita (só repetiria a entrada da chamada).
    const now = await this.env.asRecord(id);
    if (vars.every((v) => now[v.key.trim()] === v.value)) return this.env.get(id);
    const saved = await this.env.merge(id, vars, opts);
    const touched = new Set(vars.map((v) => v.key.trim()));
    const marked = saved.filter((v) => v.build === true && touched.has(v.key)).map((v) => v.key);
    const buildNote = marked.length > 0 ? ` Marcadas "de build": ${marked.join(", ")}.` : "";
    await this.hooks.audit?.record({
      action: "project.env_updated",
      target: project.slug,
      detail: `Variáveis de "${project.name}" mescladas (${vars.length} informadas, ${saved.length} no total): ${vars.map((v) => v.key.trim()).join(", ") || "nenhuma"}.` +
        // como em setEnv: marcada "de build" expõe o valor (JavaScript do site); fica registrado, só o nome
        buildNote,
    });
    return saved;
  }

  /**
   * URL de acesso ao projeto. Domínio público: https (o Caddy emite o
   * certificado sozinho). .localhost (desenvolvimento): http. A porta entra
   * quando não é a padrão.
   */
  /** Pasta do código do projeto no servidor (backups dos projetos que não vêm do GitHub). */
  backupSourceDir(project: Project): string {
    return projectSrcDir(this.engineCtx, project);
  }

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

  /**
   * Carga única e compartilhada. Com a flag marcada antes de ler, uma segunda
   * chamada seguia com a lista vazia e a gravação dela apagava os projetos.
   */
  private ensureLoaded(): Promise<void> {
    this.loadedPromise ??= this.load().catch((err: unknown) => {
      // falha de leitura NÃO é "sem projetos": a próxima chamada tenta de novo
      this.loadedPromise = null;
      throw err;
    });
    return this.loadedPromise;
  }

  private async load(): Promise<void> {
    // A lista de projetos é o que o Caddyfile e o resto do painel usam: erro de
    // leitura (ou arquivo ilegível) falha a carga e o arquivo não é tocado —
    // nunca "sem projetos", que recalcularia o Caddyfile sem eles e seria
    // gravado por cima na próxima alteração.
    this.projects = await loadJson<Project[]>(this.projectsFile, {
      empty: () => [],
      parse: (raw) => {
        const projects = (raw as Partial<ProjectsFile> | null)?.projects;
        return Array.isArray(projects) ? projects : null;
      },
      strict: true,
    });
    // Histórico de deploys: ilegível vai para o lado e recomeça (não é a lista de projetos).
    this.jobs = await loadJson<DeployJob[]>(this.jobsFile, {
      empty: () => [],
      parse: (raw) => {
        const jobs = (raw as Partial<JobsFile> | null)?.jobs;
        return Array.isArray(jobs) ? jobs : null;
      },
    });
    // jobs "running" de uma execução anterior do processo são marcados como falhos
    for (const job of this.jobs) {
      if (job.status === "running" || job.status === "queued") {
        job.status = "failed";
        job.error = "Servidor reiniciado durante o deploy.";
        job.finishedAt = new Date().toISOString();
      }
    }
  }

  /**
   * Grava a lista em memória de AGORA (lida dentro da fila do arquivo), de
   * forma atômica: duas gravações nunca terminam fora de ordem, com uma
   * versão mais velha chegando por último.
   */
  private async saveProjects(): Promise<void> {
    await withFileLock(this.projectsFile, () => {
      const data: ProjectsFile = { projects: this.projects };
      return writeFileAtomic(this.projectsFile, JSON.stringify(data, null, 2) + "\n");
    });
  }

  private async saveJobs(): Promise<void> {
    await withFileLock(this.jobsFile, () => {
      const data: JobsFile = { jobs: this.jobs.slice(-MAX_JOBS) };
      return writeFileAtomic(this.jobsFile, JSON.stringify(data, null, 2) + "\n");
    });
  }

  // -------------------------------------------------------------------------
  // CRUD de projetos
  // -------------------------------------------------------------------------

  async listProjects(): Promise<Project[]> {
    await this.ensureLoaded();
    return this.projects;
  }

  /**
   * Subida do painel: um build interrompido (queda, reinício) pode ter deixado um `<Dockerfile>.dockerignore`
   * temporário na pasta do código. Restaura a partir do diário de cada projeto. Nunca lança: o que falhar vai ao log.
   */
  async recoverBuildLeftovers(log: { warn: (message: string, detail: string) => void }): Promise<void> {
    try {
      for (const project of await this.listProjects()) {
        try {
          for (const message of await this.engine.recoverBuildLeftovers(project)) log.warn("restauração do .dockerignore de build interrompido (%s)", `${project.slug}: ${message}`);
        } catch (err) {
          log.warn("restauração do .dockerignore de build interrompido falhou (%s)", `${project.slug}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      log.warn("restauração do .dockerignore de build interrompido falhou (%s)", err instanceof Error ? err.message : String(err));
    }
  }

  async getProject(id: string): Promise<Project | null> {
    await this.ensureLoaded();
    // O id exato vence o apelido (slug): um projeto cujo nome vire o id de outro nunca o sequestra
    // (o limite de um token por projeto confere o id e depende disto).
    return this.projects.find((p) => p.id === id) ?? this.projects.find((p) => p.slug === id) ?? null;
  }

  async createProject(req: CreateProjectRequest, opts: { byLimitedToken?: boolean } = {}): Promise<Project> {
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
    if ((req.ingestMode === "upload" || req.ingestMode === "existing") && (await isPanelArea(this.projectsDir, source))) {
      throw httpError(400, "source_reserved", PANEL_AREA_MESSAGE);
    }
    if ((req.ingestMode === "upload" || req.ingestMode === "existing") && !existsSync(path.resolve(source))) {
      throw httpError(400, "source_not_found", `Caminho não encontrado: ${source}`);
    }
    const branch = validateBranch(req.branch);
    const domain = normalizeDomain(req.domain ?? "");
    if (!domain) throw httpError(400, "invalid_domain", "Informe o domínio desejado.");

    const baseSlug = slugify(name);
    // Token limitado: o apelido SEMPRE leva sufixo aleatório, esteja o nome livre ou ocupado. Um sufixo só
    // quando o nome já existe revelaria projetos fora do alcance dele.
    let slug = opts.byLimitedToken ? `${baseSlug}-${randomBytes(2).toString("hex")}` : baseSlug;
    // Pasta de backups com esse slug = de um projeto apagado: não reaproveita (misturaria as cópias).
    while (this.projects.some((p) => p.slug === slug) || (await this.slugHasBackups(slug))) slug = `${slug}-${randomBytes(2).toString("hex")}`;
    // Pasta com o nome do slug na pasta de projetos é do usuário: o painel não
    // guarda nada lá (usa .paas/<id>), mas recusa o nome para que ninguém
    // confunda o projeto com a pasta — exceto quando a pasta é a própria fonte
    // do projeto (nome igual ao da pasta é o caso comum).
    const slugFolder = path.join(this.projectsDir, slug);
    if (existsSync(slugFolder) && !(req.ingestMode !== "git" && (await sameFolder(slugFolder, source)))) {
      throw httpError(
        409,
        "slug_folder_exists",
        `Já existe uma pasta "${slug}" na pasta de projetos (${this.projectsDir}). Escolha outro nome para o projeto.`,
      );
    }
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
      // o que o painel gera mora em <projetos>/.paas/<id>, longe das pastas do usuário
      storageLayout: "reserved",
      // criado por token limitado: nunca usa a credencial da conta GitHub conectada (só a pessoa libera)
      ...(opts.byLimitedToken ? { noAccountCredential: true as const } : {}),
    };
    // Criado por token: o certificado do domínio (e do par www) gasta a cota, e ela volta se a criação falhar.
    const release = currentActor() ? await this.reserveDomainQuota(domain, true) : () => undefined;
    // a reserva esperou: confere de novo que o nome continua livre
    if (this.domainInUse(domain, null)) {
      release();
      throw httpError(409, "domain_in_use", `O domínio ${domain} já está em uso por outro projeto.`);
    }
    this.projects.push(project);
    try {
      await this.saveProjects();
    } catch (err) {
      this.projects = this.projects.filter((p) => p.id !== project.id);
      release();
      throw err;
    }
    // o endereço já responde ("site em configuração", com HTTPS) antes do deploy
    await this.applyProxy();
    return project;
  }

  /**
   * Liga os containers que já rodam de um projeto com e-mail à rede de e-mail
   * (migração A4). Projeto que não existe mais ou sem containers: 0.
   */
  async joinMailNetwork(projectId: string): Promise<number> {
    const project = await this.getProject(projectId);
    return project ? this.engine.joinMailNetwork(project) : 0;
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
    // Tudo é validado ANTES de tocar no projeto (achado 11 da revisão): as
    // mudanças vão para `changes` e só são aplicadas no fim. Antes, nome,
    // fonte e branch eram gravados no objeto compartilhado e um erro no
    // domínio ou no serviço de entrada deixava a memória alterada — e o
    // próximo save (de qualquer deploy) levava isso para o disco.
    const changes: Partial<Project> = {};
    if (req.name !== undefined) {
      const name = req.name.trim();
      if (!name) throw httpError(400, "invalid_name", "Informe o nome do projeto.");
      changes.name = name;
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
      if (project.ingestMode !== "git" && (await isPanelArea(this.projectsDir, source))) {
        throw httpError(400, "source_reserved", PANEL_AREA_MESSAGE);
      }
      changes.source = source;
    }
    if (req.branch !== undefined) {
      changes.branch = validateBranch(req.branch);
    }
    let domainChanged = false;
    if (req.domain !== undefined) {
      const domain = normalizeDomain(req.domain);
      if (!domain) throw httpError(400, "invalid_domain", "Domínio inválido.");
      if (domain !== project.domain && this.domainInUse(domain, project.id)) {
        throw httpError(409, "domain_in_use", `O domínio ${domain} já está em uso.`);
      }
      domainChanged = domain !== project.domain;
      changes.domain = domain;
    }
    if (req.websocket !== undefined) changes.websocket = Boolean(req.websocket);
    if (req.proxyService !== undefined) {
      const service = req.proxyService?.trim() || null;
      if (service) validateComposeEntry(project, service);
      changes.proxyService = service;
    }
    if (req.proxyPort !== undefined) changes.proxyPort = req.proxyPort;
    if (req.spa !== undefined) changes.spa = Boolean(req.spa);
    const previousPrimary = project.domain;
    Object.assign(project, changes);
    // o principal antigo sai do projeto: a escolha do par dele sai junto
    if (domainChanged) this.dropPairOff(project, previousPrimary);
    const pairBefore = (project.pairOff ?? []).join(",");
    if (req.domain !== undefined && req.pair === false) {
      project.pairOff = [...new Set([...(project.pairOff ?? []), project.domain])];
    } else if (req.domain !== undefined && req.pair === true) {
      this.dropPairOff(project, project.domain);
    }
    const pairChanged = (project.pairOff ?? []).join(",") !== pairBefore;
    project.updatedAt = new Date().toISOString();
    await this.saveProjects();
    if (domainChanged || pairChanged) await this.applyProxy();
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
    this.updates.invalidate(project.id);
    try {
      await this.engine.syncCaddy(this.projects, onLog);
    } catch {
      onLog("Aviso: não foi possível recarregar o Caddy após a remoção.\n");
    }
    // As variáveis também são segredos do projeto: saem com ele.
    await this.env.remove(project.id);
    // A caixa de teste de e-mail (Mailpit, rede e mensagens) sai com o projeto.
    try {
      await this.mailTest?.removed(project);
    } catch (err) {
      onLog(`Aviso: não foi possível remover a caixa de teste de e-mail agora (${err instanceof Error ? err.message : String(err)}). Confira e apague à mão o container, o volume e a rede ${mailTestContainerName(project.slug)} (docker rm -f, docker volume rm ${mailTestContainerName(project.slug)}-data, docker network rm).\n`);
    }
    // O e-mail do projeto é solto (a caixa e as mensagens ficam), senão o endereço ficaria "preso" ao projeto apagado.
    try {
      await this.projectRemovedListener?.(project.id);
    } catch {
      onLog(
        "Aviso: não foi possível soltar o e-mail do projeto agora (a caixa e as mensagens não foram mexidas). " +
          "Ele é solto na próxima vez que o e-mail do painel for aberto.\n",
      );
    }
    // A credencial é um segredo com o mesmo ciclo de vida do projeto: sem
    // isto, o token sobreviveria ao projeto no disco — passivo, não recurso.
    if (await this.credentials.remove(project.id)) {
      onLog("Credencial de leitura do repositório removida do cofre.\n");
    }
    // Só se apaga o que o PAINEL criou (A5): numa pasta antiga compartilhada com
    // arquivos do usuário, ficam os dele e o log diz quais. Os arquivos com
    // segredos (paas.*) saem sempre, mesmo sem apagar o código.
    const removal = await removeProjectWorkDir({ projectsDir: this.projectsDir }, project, this.projects, {
      deleteSource: deleteSource && project.ingestMode !== "existing",
    });
    if (removal.folderRemoved && deleteSource) onLog("Código-fonte removido.\n");
    else if (removal.removed.length > 0) onLog(`Removido da pasta do projeto: ${removal.removed.join(", ")}.\n`);
    if (removal.kept.length > 0 && deleteSource) {
      onLog(`Os arquivos que ficaram na pasta (não foram criados pelo painel): ${removal.kept.join(", ")}.\n`);
    }
    for (const s of removal.skipped) {
      onLog(`NÃO removido: ${s}. Confira a pasta e apague à mão, se for o caso.\n`);
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
    const info = await this.credentials.set(project.id, { username, token });
    this.updates.invalidate(project.id);
    return info;
  }

  /** Apaga a credencial do projeto. true = havia uma credencial cadastrada. */
  async removeCredential(id: string): Promise<boolean> {
    const project = await this.requireProject(id);
    this.updates.invalidate(project.id);
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
    const report = await runGuardrails(dir, project.detection?.composeFile, project.portOverrides, this.engine.isolationForRaw(project), await this.guardrailVariables(project));
    return { report, note: null };
  }

  /** Valores das Variáveis do projeto, só para a regra weak-credentials decidir (nunca saem: a mensagem cita o nome). */
  private async guardrailVariables(project: Project): Promise<Record<string, string>> {
    return (await this.engineCtx.envForProject?.(project)) ?? {};
  }

  /**
   * Detecta o tipo do projeto. `opts.type` = tipo escolhido à mão no assistente (null = voltar ao
   * automático); sem ele vale a escolha anterior (`typeOverride`) enquanto ainda combinar com o código.
   */
  async detect(id: string, opts: { type?: ProjectType | null } = {}): Promise<DetectResult> {
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
    const explicit = opts.type !== undefined;
    const wanted = explicit ? opts.type : (project.typeOverride ?? null);
    const variables = await this.guardrailVariables(project);
    let detection: DetectResult;
    try {
      detection = await detectProject(dir, { forceType: wanted, variables });
    } catch (err) {
      if (!(err instanceof ForcedTypeError)) throw err;
      // escolha feita agora e que não combina com o código: erro claro, nada muda
      if (explicit) throw httpError(422, "invalid_type", err.message);
      // escolha antiga que deixou de combinar (o código mudou): volta ao automático e conta
      detection = await detectProject(dir, { variables });
      detection.warnings.push({
        id: "detect.type-override-dropped",
        severity: "warning",
        message: `O tipo que você tinha escolhido (${wanted}) não combina mais com o código (${err.message}). Voltei para a detecção automática.`,
      });
      project.typeOverride = null;
    }
    if (explicit) project.typeOverride = wanted ?? null;
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
    const release = this.reserveProject(project);
    try {
      return await this.startDeployReserved(project, opts);
    } finally {
      release();
    }
  }

  private async startDeployReserved(project: Project, opts?: { guardrailOverride?: boolean }): Promise<DeployJob> {
    // Projeto "existing"/"upload" de antes da área reservada: o que o painel gera
    // (paas.*, site) sai da pasta do usuário e vai para .paas/<id>. Só move,
    // nunca apaga; roda uma vez (depois o projeto já é "reserved").
    let migrationNote = "";
    const movedEntries = await migrateLegacyWorkDir({ projectsDir: this.projectsDir }, project);
    if (movedEntries) {
      await this.saveProjects();
      migrationNote =
        `Projeto migrado para a área do painel (${path.join(this.projectsDir, ".paas", project.id)}). ` +
        (movedEntries.length > 0
          ? `Movidos da pasta antiga: ${movedEntries.join(", ")}. `
          : "Não havia arquivos do painel na pasta antiga. ") +
        "Nenhum arquivo seu foi apagado.\n";
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
      const report = await runGuardrails(srcDir, project.detection?.composeFile, project.portOverrides, this.engine.isolationForRaw(project), await this.guardrailVariables(project));
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
          if (this.blockedRecently(project, detail)) {
            const err = httpError(409, "guardrail_blocked", `Deploy bloqueado: ${report.blockers} violação(ões) de segurança (block). Corrija ou confirme o override explícito.`);
            err.report = report;
            throw err;
          }
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
      log: migrationNote,
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

    const previousStatus = project.lastDeployStatus ?? null;
    void (async () => {
      try {
        await this.engine.deploy(project, this.projects, appendLog, {
          guardrailOverride,
          precomputedGuardrailReport,
        });
        // O commit que ficou no ar (base do alerta de nova atualização) é lido ANTES de o job constar como
        // concluído: quem vê "success" já encontra o commit registrado. readDeployedCommit nunca lança;
        // null (não deu para ler) vira "desconhecido", nunca "atualização disponível".
        const deployedCommit = await readDeployedCommit(this.engineCtx, project);
        job.status = "success";
        project.lastDeployAt = new Date().toISOString();
        project.lastDeployStatus = "success";
        // Registra o FATO do que foi publicado. É a partir daqui que a tela
        // consegue dizer "configurado sandbox, no ar main" quando alguém edita
        // a configuração sem publicar em seguida.
        project.deployedBranch = project.branch;
        project.deployedSource = project.source;
        project.deployedCommit = deployedCommit;
        // O fuso que entrou nos containers (a tela compara com a escolha atual).
        project.timezoneApplied = this.projectZone(project);
        // persiste detecção feita durante o deploy
        project.updatedAt = new Date().toISOString();
        // primeira publicação: sem resposta do app, a página passa de
        // "em configuração" para "temporariamente indisponível"
        await this.applyProxy();
        // os containers foram recriados e responderam: agora (e só agora) eles têm o e-mail da fotografia deste deploy
        await this.markMailApplied(project);
      } catch (err) {
        job.status = "failed";
        job.error = err instanceof Error ? err.message : String(err);
        project.lastDeployAt = new Date().toISOString();
        project.lastDeployStatus = "failed";
        appendLog(`\n✖ Deploy falhou: ${job.error}\n`);
      } finally {
        this.mailSnaps.delete(project.id);
        job.finishedAt = new Date().toISOString();
        for (const step of job.steps) {
          if (step.status === "running") step.status = job.status === "success" ? "done" : "failed";
        }
        // Gravar o estado pode falhar (disco cheio): nunca vira rejeição sem
        // tratamento (derrubaria o processo) e não impede o aviso de fim de deploy.
        for (const gravar of [() => this.saveProjects(), () => this.saveJobs()]) {
          try {
            await gravar();
          } catch (err) {
            console.warn(`Deploy: não foi possível gravar o estado ao final (${err instanceof Error ? err.message : String(err)}).`);
          }
        }
        try {
          this.hooks.onDeployFinished?.({
            projectId: project.id,
            projectName: project.name,
            status: job.status === "success" ? "success" : "failed",
            previousStatus,
          });
        } catch {
          // aviso é extra: nunca muda o resultado do deploy
        }
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
    if (this.isPanelHost(domain) || this.dynamicClaims?.(domain)) return true;
    return this.projects.some((p) =>
      p.id === exceptProjectId ? (p.aliases ?? []).includes(domain) : p.domain === domain || (p.aliases ?? []).includes(domain),
    );
  }

  /**
   * Grava e aplica no Caddy na hora — também antes do primeiro deploy: o
   * domínio passa a responder com a página "site em configuração".
   */
  private async saveAndApplyDomains(project: Project, action: string, detail: string, onSaveFailed?: () => void): Promise<Project> {
    project.updatedAt = new Date().toISOString();
    try {
      await this.saveProjects();
    } catch (err) {
      onSaveFailed?.(); // só a falha ANTES de gravar devolve a cota: gravado, o certificado sai na próxima aplicação do proxy
      throw err;
    }
    await this.hooks.audit?.record({ action, target: project.slug, detail });
    await this.applyProxy();
    return project;
  }

  /** Conecta um domínio adicional ao projeto (o principal continua). */
  async addDomain(id: string, raw: string, opts: { pair?: boolean } = {}): Promise<Project> {
    const project = await this.requireProject(id);
    const domain = normalizeDomain(raw);
    if (!domain) throw httpError(400, "invalid_domain", "Domínio inválido. Exemplo: loja.meusite.com.br");
    if (domain === project.domain || this.domainInUse(domain, null)) {
      throw httpError(409, "domain_in_use", `O domínio ${domain} já está em uso.`);
    }
    // Só depois de validar (nome livre, não é do painel nem do e-mail) a cota é gasta; se o cadastro falhar, ela volta.
    const release = await this.reserveDomainQuota(domain, opts.pair !== false);
    // A reserva esperou: outro cadastro do mesmo nome pode ter entrado nesse intervalo. Confere de novo, sem await até gravar.
    if (domain === project.domain || this.domainInUse(domain, null)) {
      release();
      throw httpError(409, "domain_in_use", `O domínio ${domain} já está em uso.`);
    }
    project.aliases = [...(project.aliases ?? []), domain];
    if (opts.pair === false) project.pairOff = [...new Set([...(project.pairOff ?? []), domain])];
    return this.saveAndApplyDomains(project, "project.domain_added", `Domínio ${domain} conectado ao projeto "${project.name}".`, release);
  }

  /** O domínio saiu do projeto: a escolha sobre o par dele sai junto (um nome futuro igual começa do padrão). */
  private dropPairOff(project: Project, domain: string): void {
    if (!project.pairOff) return;
    const rest = project.pairOff.filter((d) => d !== domain);
    if (rest.length > 0) project.pairOff = rest;
    else delete project.pairOff;
  }

  /** Quem já usa o nome `host` fora deste projeto (null = livre). */
  private async pairOccupant(host: string, projectId: string): Promise<DomainPairOccupant | null> {
    if (this.isPanelHost(host)) return "panel";
    if ((await this.mailHosts().catch((): string[] => [])).includes(host)) return "mail";
    const owner = this.projects.find((p) => p.domain === host || (p.aliases ?? []).includes(host));
    if (!owner) return null;
    return owner.id === projectId ? "same_project" : "other_project";
  }

  /** Quem usa o nome `host` para outro propósito que não o do projeto `projectId` (consulta da verificação). */
  async occupantOf(host: string, projectId: string | null): Promise<DomainPairOccupant | null> {
    return this.pairOccupant(host, projectId ?? "");
  }

  /**
   * O par (com/sem www) de cada domínio do projeto e a situação dele agora:
   * ligado ou desligado, DNS e se está redirecionando. Só consulta.
   */
  async domainPairs(id: string): Promise<ProjectDomainPair[]> {
    const project = await this.requireProject(id);
    const off = new Set(project.pairOff ?? []);
    const rows: ProjectDomainPair[] = [];
    for (const domain of [project.domain, ...(project.aliases ?? [])]) {
      const pair = pairOf(domain);
      if (!pair) continue;
      const occupant = await this.pairOccupant(pair.pair, project.id);
      const state: DomainDnsState = this.hooks.hostState
        ? await this.hooks.hostState(pair.pair).catch((): DomainDnsState => "unavailable")
        : "unavailable";
      const enabled = !off.has(domain);
      rows.push({
        domain,
        pair: pair.pair,
        role: pair.role,
        enabled,
        state,
        ...(occupant ? { occupiedBy: occupant } : {}),
        // "redirecionando" só depois que o Caddy aplicou (DNS apontado e ainda não aplicado = "começa em instantes")
        active: enabled && occupant === null && state === "pointed" && this.engine.appliedPairs().has(pair.pair),
      });
    }
    return rows;
  }

  /** Liga ou desliga o par (com/sem www) de um domínio do projeto; vale na hora no proxy. */
  async setDomainPair(id: string, raw: string, enabled: boolean): Promise<Project> {
    const project = await this.requireProject(id);
    const domain = normalizeDomain(raw);
    if (domain !== project.domain && !(project.aliases ?? []).includes(domain)) {
      throw httpError(404, "domain_not_found", `O domínio ${raw} não está conectado a este projeto.`);
    }
    if (!pairOf(domain)) {
      throw httpError(400, "no_pair", `${domain} não tem par com/sem www (só o domínio principal do site e o www dele têm).`);
    }
    const off = new Set(project.pairOff ?? []);
    if (enabled) off.delete(domain);
    else off.add(domain);
    if (off.size > 0) project.pairOff = [...off];
    else delete project.pairOff;
    return this.saveAndApplyDomains(
      project,
      "project.domain_pair",
      `Par (com/sem www) de ${domain} em "${project.name}": ${enabled ? "ligado" : "desligado"}.`,
    );
  }

  /**
   * Reaplica o proxy se algum par passou a apontar (ou deixou de) desde a
   * última aplicação: a pessoa configura o DNS depois de conectar o domínio e
   * o redirecionamento nasce sozinho, sem novo deploy. Chamado de tempos em
   * tempos pelo painel.
   */
  async reconcilePairs(): Promise<boolean> {
    if (!(await this.engine.pairsChanged(this.projects))) return false;
    await this.applyProxy();
    return true;
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
    this.dropPairOff(project, domain);
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
    // Projeto criado por token limitado: sem a conta conectada (senão apontar para um repositório
    // privado de terceiros clonaria com o acesso da conta). Só repositório público.
    if (project.noAccountCredential) return null;
    return project.ingestMode === "git" ? this.github.credentialForUrl(project.source) : null;
  }

  /** A pessoa libera (ou volta a bloquear) o uso da conta GitHub conectada num projeto criado por token limitado. */
  async setAccountCredential(id: string, allow: boolean): Promise<Project> {
    const project = await this.requireProject(id);
    if (allow) delete project.noAccountCredential;
    else project.noAccountCredential = true;
    project.updatedAt = new Date().toISOString();
    await this.saveProjects();
    return project;
  }

  /**
   * "Testar acesso" do assistente Novo projeto: consulta SOMENTE LEITURA
   * (`git ls-remote`) com as mesmas validações da criação do projeto. O token
   * vem do corpo ou da conta do GitHub conectada (só github.com), vive só na
   * memória desta chamada e no ambiente do processo git; nada é gravado.
   */
  /** Resolução de nomes do "Testar acesso" (os testes trocam por um dublê); undefined = DNS do sistema. */
  targetLookup: DnsLookup | undefined = undefined;

  async checkGitAccess(req: GitAccessCheckRequest): Promise<GitAccessCheckResponse> {
    const falha = (reason: GitAccessFailureReason): GitAccessCheckResponse => ({
      ok: false,
      reason,
      message: GIT_ACCESS_MESSAGES[reason],
    });
    let source: string;
    let branch: string | null;
    try {
      source = validateGitSource(req.source);
    } catch {
      return falha("invalid_source");
    }
    try {
      branch = validateBranch(req.branch);
    } catch {
      return falha("invalid_branch");
    }
    let credential: GitReadCredential | null = null;
    if (req.useAccount) {
      credential = await this.github.credentialForUrl(source);
      if (!credential) return falha((await this.github.token()) ? "account_not_applicable" : "account_not_connected");
    } else if (req.token?.trim()) {
      credential = { username: DEFAULT_GIT_CREDENTIAL_USERNAME, token: req.token.trim() };
    }
    // Loopback, link-local e metadados da nuvem não são consultados (a rota não vira sonda da rede
    // interna); redes privadas seguem permitidas. Os endereços conferidos são fixados no curl.
    const target = await resolveTarget(source, this.targetLookup);
    if (!target.ok) return falha(target.reason);
    return checkGitAccess({ source, branch, credential, pin: target.pin });
  }

  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Alerta de "nova atualização do projeto" (só aviso; o deploy é sempre manual)
  // -------------------------------------------------------------------------

  /** Estado do projeto frente à branch configurada; consulta o repositório se o cache venceu. */
  async updateStatus(id: string, opts: { force?: boolean } = {}): Promise<ProjectUpdateStatus> {
    return this.updates.status(await this.requireProject(id), opts);
  }

  /** Estado de todos os projetos (Dashboard). */
  async updateStatuses(): Promise<ProjectUpdateStatus[]> {
    return this.updates.statuses(await this.listProjects());
  }

  // -------------------------------------------------------------------------
  // Fuso horário do projeto
  // -------------------------------------------------------------------------

  /** Quem informa o fuso da VPS em uso (o TimezoneService, em app.ts). */
  setHostTimezoneProvider(provider: () => string): void {
    this.hostTimezoneProvider = provider;
  }

  /** O fuso que o projeto recebe agora (null = o da imagem; site estático não usa). */
  private projectZone(project: Project): string | null {
    const type = project.detection?.type;
    if (type === "static" || type === "static-node") return null;
    return effectiveProjectZone(project.timezone, this.hostTimezoneProvider());
  }

  /** Onde o próprio projeto já define TZ (compose, Variáveis ou env_file). */
  private async timezoneDefinitions(project: Project): Promise<ProjectTimezoneDefinition[]> {
    const vars = (await this.engineCtx.envForProject?.(project)) ?? {};
    if (project.detection?.type === "dockerfile" || project.detection?.type === "node-server") {
      return vars.TZ ? [{ service: "app", value: vars.TZ, where: "variables" }] : [];
    }
    const composeFile = project.detection?.composeFile;
    const dir = this.sourceDirOf(project);
    if (project.detection?.type !== "compose" || !composeFile || !dir) return [];
    let content: string;
    try {
      content = await readFile(path.join(dir, composeFile), "utf8");
    } catch {
      return [];
    }
    const root = path.resolve(dir);
    const files = new Map<string, string | null>();
    for (const rel of composeEnvFiles(content)) {
      const file = path.resolve(root, rel);
      if (!file.startsWith(root + path.sep)) continue;
      files.set(rel, await readFile(file, "utf8").catch(() => null));
    }
    return composeTimezoneDefinitions(content, vars, (rel) => files.get(rel) ?? null);
  }

  /** Campo "Fuso horário" do projeto: a escolha, o que está nos containers e o aviso do tzdata. */
  async timezoneView(id: string): Promise<ProjectTimezoneView> {
    const project = await this.requireProject(id);
    const type = project.detection?.type;
    const supported = type === "compose" || type === "dockerfile" || type === "node-server";
    const hostZone = this.hostTimezoneProvider();
    const setting: ProjectTimezoneSetting = project.timezone ?? { mode: "image" };
    const effectiveZone = this.projectZone(project);
    const appliedZone = project.timezoneApplied ?? null;
    const deployed = project.lastDeployStatus === "success" || (project.deployedSource ?? null) !== null;
    let services: ProjectTimezoneService[] = [];
    try {
      const mine = (await listContainers()).filter((c) => c.projectSlug === project.slug);
      services = await Promise.all(
        mine.map(async (c) => {
          const running = c.state === "running";
          const probe = running ? await this.timezoneProbe(c.id, effectiveZone).catch(() => ({ tz: null, zoneinfo: null })) : { tz: null, zoneinfo: null };
          return { service: c.service ?? c.name, container: c.name, running, tz: probe.tz, zoneinfo: probe.zoneinfo };
        }),
      );
    } catch {
      services = [];
    }
    return {
      setting,
      effectiveZone,
      hostZone,
      definedByProject: supported ? await this.timezoneDefinitions(project) : [],
      appliedZone,
      pendingRestart: supported && deployed && effectiveZone !== appliedZone,
      supported,
      services,
      options: timezoneOptions(),
    };
  }

  async setProjectTimezone(id: string, req: ProjectTimezoneRequest, actor?: string): Promise<Project> {
    const project = await this.requireProject(id);
    let setting: ProjectTimezoneSetting;
    if (req.mode === "zone") {
      if (!req.zone || !isKnownTimezone(req.zone)) throw httpError(400, "invalid_timezone", "Escolha um fuso da lista.");
      setting = { mode: "zone", zone: req.zone };
    } else if (req.mode === "host" || req.mode === "image") {
      setting = { mode: req.mode };
    } else {
      throw httpError(400, "invalid_timezone", "Escolha uma das opções de fuso.");
    }
    const label = setting.mode === "image" ? "padrão da imagem" : setting.mode === "host" ? "igual ao da VPS" : setting.zone!;
    if (setting.mode === "image") delete project.timezone;
    else project.timezone = setting;
    project.updatedAt = new Date().toISOString();
    await this.saveProjects();
    await this.hooks.audit?.record({
      action: "project.timezone",
      ...(actor ? { actor } : {}),
      target: project.slug,
      detail: `Fuso horário de "${project.name}": ${label}.`,
    });
    return project;
  }

  /**
   * O slug já aparece em backups (pasta local, conferências `<slug>/arquivo` ou
   * histórico de um projeto de mesmo nome)? Então é de um projeto apagado.
   */
  private async slugHasBackups(slug: string): Promise<boolean> {
    if (existsSync(path.join(this.backupsDir, slug))) return true;
    const dataDir = path.dirname(this.backupsDir);
    try {
      const cfg = JSON.parse(await readFile(path.join(dataDir, "backups.json"), "utf8")) as { checks?: Record<string, unknown> };
      if (Object.keys(cfg.checks ?? {}).some((k) => k.startsWith(`${slug}/`))) return true;
    } catch {
      /* sem configuração de backups */
    }
    try {
      const hist = JSON.parse(await readFile(path.join(dataDir, "backups-history.json"), "utf8")) as {
        entries?: Array<{ target?: string; targetName?: string }>;
      };
      return (hist.entries ?? []).some((e) => e.target?.startsWith("project:") && typeof e.targetName === "string" && slugify(e.targetName) === slug);
    } catch {
      return false;
    }
  }

  /**
   * "Reiniciar com o fuso novo": recria os containers com a configuração
   * atual, sem baixar código nem refazer o build (o TZ só entra num container
   * novo; `docker restart` mantém o ambiente antigo). Vira um job, como o
   * deploy, e aparece na aba Deploys.
   */
  async startRecreate(id: string, actor?: string): Promise<DeployJob> {
    const project = await this.requireProject(id);
    const release = this.reserveProject(project);
    try {
      return await this.startRecreateReserved(project, actor);
    } finally {
      release();
    }
  }

  private async startRecreateReserved(project: Project, actor?: string): Promise<DeployJob> {
    const deployed = project.lastDeployStatus === "success" || (project.deployedSource ?? null) !== null;
    if (!deployed) throw httpError(409, "not_deployed", "Faça o primeiro deploy do projeto: o fuso entra junto.");
    const zone = this.projectZone(project);
    if (zone !== null && !isSafeTimezoneName(zone)) throw httpError(400, "invalid_timezone", "Escolha um fuso da lista.");
    await this.hooks.audit?.record({
      action: "project.recreate",
      ...(actor ? { actor } : {}),
      target: project.slug,
      detail: `Containers de "${project.name}" recriados com a configuração atual (fuso: ${zone ?? "padrão da imagem"}).`,
    });
    // Projeto "existing"/"upload" antigo: os arquivos do painel saem da pasta do usuário antes de recriar.
    const movedEntries = await migrateLegacyWorkDir({ projectsDir: this.projectsDir }, project);
    if (movedEntries) await this.saveProjects();
    const now = new Date().toISOString();
    const job: DeployJob = {
      id: randomBytes(8).toString("hex"),
      projectId: project.id,
      kind: "recreate",
      status: "running",
      createdAt: now,
      startedAt: now,
      finishedAt: null,
      steps: [{ name: "Recriar os containers com a configuração atual", status: "running" }],
      log:
        "=== Reinício com a configuração atual (sem baixar código nem refazer o build) ===\n" +
        (movedEntries ? `Projeto migrado para a área do painel (${path.join(this.projectsDir, ".paas", project.id)}). Nenhum arquivo seu foi apagado.\n` : ""),
      error: null,
    };
    this.jobs.push(job);
    await this.saveJobs();
    const appendLog = (chunk: string) => {
      job.log = (job.log + chunk).slice(-DEPLOY_LOG_MAX_CHARS);
    };
    void (async () => {
      try {
        await this.engine.recreate(project, appendLog);
        await this.markMailApplied(project);
        job.status = "success";
        project.timezoneApplied = zone;
        project.updatedAt = new Date().toISOString();
      } catch (err) {
        job.status = "failed";
        job.error = err instanceof Error ? err.message : String(err);
        appendLog(`\n✖ Reinício falhou: ${job.error}\n`);
      } finally {
        this.mailSnaps.delete(project.id);
        job.finishedAt = new Date().toISOString();
        for (const step of job.steps) step.status = job.status === "success" ? "done" : "failed";
        await this.saveProjects();
        await this.saveJobs();
      }
    })();
    return job;
  }

  /**
   * Reserva o projeto como um deploy faz: enquanto a reserva existir, nenhum deploy dele começa (409). Lança se já há
   * deploy em andamento. Devolve a função que solta. Usado pelo teste de restauração de backup no projeto de destino.
   */
  async holdProject(id: string): Promise<() => void> {
    return this.reserveProject(await this.requireProject(id));
  }

  /**
   * Reserva o projeto para um deploy/reinício (achado 10 da revisão). A
   * reserva é feita SEM nenhum `await` entre conferir e marcar: até o job
   * ser registrado há vários `await` (detecção, variáveis, guardrails,
   * auditoria), e só olhar os jobs deixava dois pedidos passarem juntos.
   * O segundo pedido é recusado (409), não fica esperando. Depois que o job
   * entra em `this.jobs`, ele mesmo segura o projeto; quem chama libera a
   * reserva no `finally`.
   */
  private reserveProject(project: Project): () => void {
    const busy =
      this.starting.has(project.id) ||
      this.jobs.some((j) => j.projectId === project.id && (j.status === "running" || j.status === "queued"));
    if (busy) throw httpError(409, "deploy_in_progress", "Já existe um deploy em andamento para este projeto.");
    this.starting.add(project.id);
    return () => {
      this.starting.delete(project.id);
    };
  }

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
