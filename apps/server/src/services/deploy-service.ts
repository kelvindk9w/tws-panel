/**
 * deploy-service.ts — orquestra projetos, jobs de deploy e o Caddy central.
 * Persistência em JSON (data/projects.json, data/deploy-jobs.json), seguindo o
 * padrão das fases 0/1 (ver services/setup-state.ts e security-service.ts).
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEPLOY_LOG_MAX_CHARS,
  INGEST_MODES,
  type CreateProjectRequest,
  type DeployJob,
  type DetectResult,
  type DockerContainerInfo,
  type GuardrailReport,
  type Project,
  type ProjectStatus,
  type UpdateProjectRequest,
} from "@paas/core";
import {
  DeployEngine,
  detectProject,
  projectSrcDir,
  projectWorkDir,
  runGuardrails,
  type EngineContext,
} from "@paas/deploy";
import type { ServerConfig } from "../config.js";
import type { AlertsService } from "./alerts-service.js";
import type { AuditService } from "./audit-service.js";
import { listContainers } from "./docker-service.js";

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
  private readonly hooks: DeployHooks;
  private projects: Project[] = [];
  private jobs: DeployJob[] = [];
  private loaded = false;

  constructor(config: ServerConfig, hooks: DeployHooks = {}) {
    this.hooks = hooks;
    this.projectsDir = path.join(config.dataDir, "projects");
    this.projectsFile = path.join(config.dataDir, "projects.json");
    this.jobsFile = path.join(config.dataDir, "deploy-jobs.json");
    this.caddyHttpPort = config.caddyHttpPort;
    this.engineCtx = {
      projectsDir: this.projectsDir,
      caddyDir: path.join(config.dataDir, "caddy"),
      nodeImage: process.env.PAAS_NODE_IMAGE ?? "node:22",
      staticImage: process.env.PAAS_STATIC_IMAGE ?? "nginx:alpine",
      caddyHttpPort: config.caddyHttpPort,
      caddyHttpsPort: config.caddyHttpsPort,
    };
    this.engine = new DeployEngine(this.engineCtx);
  }

  /**
   * Registra o provedor de env vars extras por projeto (Fase 3 — injeção
   * SMTP). Chamado pelo módulo de e-mail na inicialização das rotas.
   */
  setEnvProvider(provider: (project: Project) => Promise<Record<string, string>>): void {
    this.engineCtx.envForProject = provider;
  }

  /** URL de acesso ao projeto (inclui porta do Caddy em dev quando ≠ 80). */
  projectUrl(project: Project): string {
    return this.caddyHttpPort === 80
      ? `http://${project.domain}`
      : `http://${project.domain}:${this.caddyHttpPort}`;
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
    if ((req.ingestMode === "upload" || req.ingestMode === "existing") && !existsSync(path.resolve(source))) {
      throw httpError(400, "source_not_found", `Caminho não encontrado: ${source}`);
    }
    const branch = validateBranch(req.branch);
    const domain = normalizeDomain(req.domain ?? "");
    if (!domain) throw httpError(400, "invalid_domain", "Informe o domínio desejado.");

    let slug = slugify(name);
    while (this.projects.some((p) => p.slug === slug)) slug = `${slug}-${randomBytes(2).toString("hex")}`;
    if (this.projects.some((p) => p.domain === domain)) {
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
    return project;
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
      project.source =
        project.ingestMode === "git" ? validateGitSource(req.source) : req.source.trim();
    }
    if (req.branch !== undefined) {
      project.branch = validateBranch(req.branch);
    }
    if (req.domain !== undefined) {
      const domain = normalizeDomain(req.domain);
      if (!domain) throw httpError(400, "invalid_domain", "Domínio inválido.");
      if (this.projects.some((p) => p.id !== project.id && p.domain === domain)) {
        throw httpError(409, "domain_in_use", `O domínio ${domain} já está em uso.`);
      }
      project.domain = domain;
    }
    if (req.websocket !== undefined) project.websocket = Boolean(req.websocket);
    if (req.proxyService !== undefined) project.proxyService = req.proxyService?.trim() || null;
    if (req.proxyPort !== undefined) project.proxyPort = req.proxyPort;
    project.updatedAt = new Date().toISOString();
    await this.saveProjects();
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
    return { report: await runGuardrails(dir), note: null };
  }

  async detect(id: string): Promise<DetectResult> {
    const project = await this.requireProject(id);
    // Modo git/upload: o código só existe após o primeiro deploy; para detectar
    // antes, usa a fonte original quando o src local ainda não existe.
    const dir = this.sourceDirOf(project);
    if (!dir) {
      throw httpError(
        409,
        "source_missing",
        "Código ainda não ingerido (modo git). Faça o primeiro deploy para clonar, ou use a detecção após o deploy.",
      );
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
      const report = await runGuardrails(srcDir);
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
    const all = containers ?? (await listContainers());
    const mine = all.filter((c) => c.projectSlug === project.slug);
    const deploying = this.jobs.some(
      (j) => j.projectId === project.id && (j.status === "running" || j.status === "queued"),
    );
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

  private async requireProject(id: string): Promise<Project> {
    const project = await this.getProject(id);
    if (!project) throw httpError(404, "project_not_found", "Projeto não encontrado.");
    return project;
  }
}

export interface HttpError extends Error {
  statusCode: number;
  code: string;
  /** Payload extra (ex.: relatório de guardrails no erro guardrail_blocked). */
  report?: GuardrailReport;
}

export function httpError(statusCode: number, code: string, message: string): HttpError {
  const err = new Error(message) as HttpError;
  err.statusCode = statusCode;
  err.code = code;
  return err;
}
