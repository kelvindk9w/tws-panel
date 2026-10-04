/**
 * engine.ts — pipelines de deploy (plano §5.1).
 *
 * Deploy = ingestão → detecção → build (conforme pipeline) → up → proxy (Caddy)
 * → health check. Tudo via docker/compose CLI (argumentos separados, nunca
 * shell interpolado) para não impor nada a stacks existentes.
 *
 * Convenções:
 *  - containers do painel: paas-<slug>-* com labels paas.managed/paas.project
 *  - projetos compose adotados: compose project "paas-<slug>" + override gerado
 *    pelo painel que anexa o serviço web à rede paas-net (com alias <slug>)
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import {
  PAAS_LABEL_MANAGED,
  PAAS_LABEL_PROJECT,
  PAAS_NETWORK,
  type DomainHttpsStatus,
  type GuardrailReport,
  type Project,
  PAAS_CADDY_CONTAINER,
} from "@paas/core";
import { parse } from "yaml";
import { CaddyManager, projectDomain, type CaddyTarget, type ManualCaddyCertificate, type PanelSite } from "./caddy.js";
import { run, runStream } from "./exec.js";
import { ingestCode, projectSrcDir, projectWorkDir, type IngestContext } from "./ingest.js";
import { preparePublishDir } from "./static-site.js";
import { certificateStatus, type CertificateStatus } from "./tls-status.js";
import { composeOverrideYaml, strippedProxyPortServices } from "./compose-override.js";
import { effectiveServicePorts } from "./port-overrides.js";
import { diagnoseComposeFailure, startableServices } from "./compose-diagnose.js";
import { missingFromComposeOutput, writeProjectDotenv } from "./project-dotenv.js";
import { runGuardrails } from "./rules.js";

export interface EngineContext extends IngestContext {
  /** Diretório data/caddy. */
  caddyDir: string;
  /** Imagem Node usada nos builds estáticos. */
  nodeImage: string;
  /** Imagem nginx usada para servir estáticos. */
  staticImage: string;
  /** Porta HTTP do Caddy no host (health check passa por ela). */
  caddyHttpPort: number;
  /** Porta HTTPS do Caddy no host. */
  caddyHttpsPort: number;
  /** Site do próprio painel no Caddy central (acesso por HTTPS); ausente = túnel. */
  panelSite?: PanelSite;
  /**
   * Container do próprio painel, quando ele roda no Docker. O health check
   * passa então pela rede interna (paas-caddy:80/443): de dentro do container,
   * 127.0.0.1 não tem proxy nenhum. Ausente = painel fora de container (dev).
   */
  panelContainer?: string;
  /**
   * Env vars extras por projeto (Fase 3 — injeção SMTP). Chamado no início de
   * cada deploy; o mapa é injetado no compose override (todos os serviços) ou
   * via -e no pipeline dockerfile. undefined = nenhuma injeção.
   */
  envForProject?: (project: Project) => Promise<Record<string, string>>;
  /**
   * Variáveis injetadas em TODOS os serviços do compose (override) — hoje as
   * do e-mail do painel. As demais (seção Variáveis) vão só para o `.env`: o
   * compose decide qual serviço recebe cada uma (o cassino, por exemplo, não
   * entrega segredos da carteira ao front de propósito).
   */
  injectEnvForProject?: (project: Project) => Promise<Record<string, string>>;
  /**
   * Hostnames do servidor de e-mail (mail.<domínio>) que o Caddy central
   * precisa servir para emitir o certificado deles. Consultado a cada
   * sincronização do proxy; ausente = nenhum.
   */
  mailHosts?: () => Promise<string[]>;
  /**
   * Certificados manuais em vigor (página Certificados). Consultado a cada
   * sincronização do proxy; ausente = todos os nomes no automático.
   */
  manualCertificates?: () => Promise<ManualCaddyCertificate[]>;
}

export type LogFn = (chunk: string) => void;

/**
 * Blocos do Caddyfile de um projeto. Domínios com porta própria
 * (`domainPorts`) vão para o mesmo host na porta deles; os demais ficam num
 * bloco só, com o upstream do projeto.
 */
export function projectCaddyTargets(project: Project, upstream: string): CaddyTarget[] {
  const host = upstream.slice(0, upstream.lastIndexOf(":"));
  const defaultPort = upstream.slice(upstream.lastIndexOf(":") + 1);
  const ports = project.domainPorts ?? {};
  const all = [projectDomain(project), ...(project.aliases ?? [])];
  const byUpstream = new Map<string, string[]>();
  for (const d of all) {
    const target = ports[d] ? `${host}:${ports[d]}` : `${host}:${defaultPort}`;
    byUpstream.set(target, [...(byUpstream.get(target) ?? []), d]);
  }
  return [...byUpstream.entries()].map(([up, domains]) => ({
    domain: domains[0]!,
    aliases: domains.slice(1),
    upstream: up,
    websocket: project.websocket,
  }));
}

/**
 * Alvos do proxy central para TODOS os projetos. O que nunca foi publicado
 * entra também (`published: false`): o domínio responde com HTTPS e a página
 * "site em manutenção". O que já esteve no ar continua nele mesmo que o
 * último deploy tenha falhado — antes ele sumia do proxy no próximo ajuste,
 * com os containers antigos ainda rodando.
 */
export function caddyTargetsFor(projects: Project[], upstreamFor: (p: Project) => string): CaddyTarget[] {
  return projects.flatMap((p) =>
    projectCaddyTargets(p, upstreamFor(p)).map((t) => ({ ...t, published: wasPublished(p) })),
  );
}

/** Já esteve no ar: último deploy ok ou o registro do que foi publicado. */
function wasPublished(p: Project): boolean {
  return p.lastDeployStatus === "success" || (p.deployedSource ?? null) !== null;
}

/** Onde o health check fala com o Caddy central (ver EngineContext.panelContainer). */
export function healthCheckTarget(ctx: EngineContext): { host: string; httpPort: number; httpsPort: number } {
  if (ctx.panelContainer) return { host: PAAS_CADDY_CONTAINER, httpPort: 80, httpsPort: 443 };
  return { host: "127.0.0.1", httpPort: ctx.caddyHttpPort, httpsPort: ctx.caddyHttpsPort };
}

/**
 * Erro de domínio do engine: mesmo formato duck-typed que `httpError`
 * (apps/server/src/services/deploy-service.ts) — `statusCode` + `code` +
 * `message` em pt-BR. packages/deploy não depende de apps/server, então o
 * tipo é definido aqui; `sendError()` (routes/projects.ts) já lê essas
 * propriedades de qualquer erro lançado, não exige uma classe específica.
 */
export interface EngineError extends Error {
  statusCode: number;
  code: string;
}

function engineError(statusCode: number, code: string, message: string): EngineError {
  const err = new Error(message) as EngineError;
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

/** Nome do compose project usado ao adotar um compose existente. */
export function composeProjectName(project: Project): string {
  return `paas-${project.slug}`;
}

/** Prefixo de todos os containers criados pelo painel para o projeto. */
export function containerPrefix(project: Project): string {
  return `paas-${project.slug}`;
}

export class DeployEngine {
  readonly caddy: CaddyManager;

  constructor(private readonly ctx: EngineContext) {
    this.caddy = new CaddyManager(
      ctx.caddyDir,
      undefined,
      { http: ctx.caddyHttpPort, https: ctx.caddyHttpsPort },
      ctx.panelSite ? { panelSite: ctx.panelSite } : {},
    );
  }

  // -------------------------------------------------------------------------
  // Deploy
  // -------------------------------------------------------------------------

  /**
   * Executa o pipeline completo. Lança erro em qualquer etapa falha.
   * `allProjects` é necessário para re-renderizar o Caddyfile com todos os
   * domínios ativos (o Caddy central é compartilhado).
   *
   * Fase 4: após a ingestão, roda os guardrails sobre o código ingerido.
   * Findings "block" abortam o deploy, a menos que `opts.guardrailOverride`
   * seja true (override explícito do operador — auditado na camada da API).
   */
  async deploy(
    project: Project,
    allProjects: Project[],
    onLog: LogFn,
    opts?: { guardrailOverride?: boolean; precomputedGuardrailReport?: GuardrailReport },
  ): Promise<void> {
    const type = project.detection?.type;
    if (!type || type === "unknown") {
      throw new Error("Tipo de projeto desconhecido — rode a detecção antes do deploy.");
    }

    onLog(`\n=== Etapa 1/5 · Ingestão do código (${project.ingestMode}) ===\n`);
    const src = await ingestCode(this.ctx, project, onLog);

    onLog("\n=== Guardrails de segurança (Fase 4) ===\n");
    // Desempenho: startDeploy() (deploy-service.ts) já roda os guardrails uma
    // vez antes de criar o job. Quando o modo de ingestão garante que o
    // diretório não mudou desde então (ver comentário no chamador), ele passa
    // esse resultado pronto aqui em vez de escanear a árvore de novo.
    const report = opts?.precomputedGuardrailReport ?? (await runGuardrails(src, project.detection?.composeFile, project.portOverrides));
    if (opts?.precomputedGuardrailReport) {
      onLog("Reaproveitando checagem de guardrails já feita antes do job (código não muda em modo \"existing\").\n");
    }
    if (report.findings.length === 0) {
      onLog("Nenhum problema encontrado pelos guardrails.\n");
    } else {
      for (const f of report.findings) {
        const mark = f.level === "block" ? "✖ BLOCK" : f.level === "warn" ? "⚠ WARN " : "ℹ INFO ";
        onLog(`${mark} [${f.rule}] ${f.title} — ${f.evidence}\n`);
      }
      onLog(
        `Resumo: ${report.blockers} bloqueio(s), ${report.warnings} alerta(s), ${report.infos} informativo(s).\n`,
      );
    }
    if (report.blockers > 0 && !opts?.guardrailOverride) {
      onLog("Deploy abortado pelos guardrails. Corrija os bloqueios ou faça override explícito na interface.\n");
      throw new Error(
        `guardrail_blocked: ${report.blockers} bloqueio(s) de segurança — deploy requer override explícito.`,
      );
    }
    if (report.blockers > 0) {
      onLog(`⚠ Override explícito do operador: prosseguindo com ${report.blockers} bloqueio(s).\n`);
    }

    onLog(`\n=== Etapa 2/5 · Preparação (${type}) ===\n`);
    await this.caddy.ensureNetwork();
    onLog(`Rede ${PAAS_NETWORK} OK.\n`);

    // Env vars extras (Fase 3 — SMTP). Valores NUNCA são logados.
    const extraEnv = (await this.ctx.envForProject?.(project)) ?? {};
    const envKeys = Object.keys(extraEnv);
    if (envKeys.length > 0) {
      onLog(`Injetando ${envKeys.length} variável(is) de ambiente do projeto (${envKeys.join(", ")}).\n`);
    }

    let upstream: string;
    switch (type) {
      case "static":
        onLog("\n=== Etapa 3/5 · Site estático (HTML, sem build) ===\n");
        if (envKeys.length > 0) {
          onLog("Nota: site estático não recebe env vars de runtime (injeção ignorada).\n");
        }
        upstream = await this.deployPlainStatic(project, src, onLog);
        break;
      case "static-node":
        onLog("\n=== Etapa 3/5 · Build estático (container Node) ===\n");
        if (envKeys.length > 0) {
          onLog("Nota: site estático não recebe env vars de runtime (injeção ignorada).\n");
        }
        upstream = await this.deployStatic(project, src, onLog);
        break;
      case "compose":
        onLog("\n=== Etapa 3/5 · docker compose up (compose adotado) ===\n");
        upstream = await this.deployCompose(
          project,
          src,
          onLog,
          extraEnv,
          (await this.ctx.injectEnvForProject?.(project)) ?? {},
        );
        break;
      case "dockerfile":
        onLog("\n=== Etapa 3/5 · docker build (Dockerfile) ===\n");
        upstream = await this.deployDockerfile(project, src, onLog, extraEnv);
        break;
    }

    onLog("\n=== Etapa 4/5 · Proxy reverso (Caddy central) ===\n");
    const domain = projectDomain(project);
    const targets = caddyTargetsFor(
      allProjects.filter((p) => p.id !== project.id),
      (p) => this.upstreamFor(p),
    );
    targets.push(...projectCaddyTargets(project, upstream).map((t) => ({ ...t, published: wasPublished(project) })));
    await this.caddy.apply(targets, onLog, await this.mailHosts(onLog), {
      manual: await this.manualCertificates(onLog),
      force: false,
    });
    onLog(`Domínio ${domain} → ${upstream}\n`);

    onLog("\n=== Etapa 5/5 · Health check ===\n");
    await this.waitHealthy(domain, onLog);
  }

  /**
   * Recalcula o Caddyfile com TODOS os projetos (chamado após cada mudança).
   * `force`: recarrega mesmo sem mudança ("Tentar emitir agora").
   */
  async syncCaddy(projects: Project[], onLog?: LogFn, opts: { force?: boolean } = {}): Promise<void> {
    await this.caddy.apply(caddyTargetsFor(projects, (p) => this.upstreamFor(p)), onLog, await this.mailHosts(onLog), {
      manual: await this.manualCertificates(onLog),
      force: opts.force ?? false,
    });
  }

  /** Certificados manuais; falha aqui não pode derrubar o proxy dos sites. */
  private async manualCertificates(onLog?: LogFn): Promise<ManualCaddyCertificate[]> {
    try {
      return (await this.ctx.manualCertificates?.()) ?? [];
    } catch (err) {
      onLog?.(`aviso: certificados manuais indisponíveis (${err instanceof Error ? err.message : String(err)}).\n`);
      return [];
    }
  }

  /**
   * Certificado que o proxy central serve para `host`, conferido como um
   * navegador confere (TLS com SNI, cadeia e nome) — página Certificados.
   */
  async servedCertificate(host: string): Promise<CertificateStatus> {
    const target = healthCheckTarget(this.ctx);
    if (this.ctx.panelContainer) await this.caddy.connectToNetwork(this.ctx.panelContainer);
    return certificateStatus({ host: target.host, port: target.httpsPort, servername: host, timeoutMs: 5_000 });
  }

  /** Hosts de e-mail; falha aqui não pode derrubar o proxy dos sites. */
  private async mailHosts(onLog?: LogFn): Promise<string[]> {
    try {
      return (await this.ctx.mailHosts?.()) ?? [];
    } catch (err) {
      onLog?.(`aviso: hosts do servidor de e-mail indisponíveis (${err instanceof Error ? err.message : String(err)}).\n`);
      return [];
    }
  }

  /** Upstream (host:porta na rede paas-net) conforme o tipo do projeto. */
  upstreamFor(project: Project): string {
    const type = project.detection?.type;
    const port = project.proxyPort ?? project.detection?.proxyPort ?? 80;
    if (type === "compose") return `${project.slug}:${port}`;
    if (type === "dockerfile") return `${project.slug}:${port}`;
    return `${project.slug}:80`;
  }

  // -------------------------------------------------------------------------
  // Pipeline: static (HTML puro, sem build)
  // -------------------------------------------------------------------------

  private async deployPlainStatic(project: Project, src: string, onLog: LogFn): Promise<string> {
    // Nunca serve a pasta do código direto: .git e .env ficariam baixáveis.
    const site = path.join(projectWorkDir(this.ctx, project), "site");
    await preparePublishDir(src, site);
    onLog("Arquivos copiados para a pasta de publicação (sem .git, .env nem outros ocultos).\n");
    return this.serveStaticDir(project, site, "site", onLog);
  }

  /** Sobe (ou recria) o container nginx que serve `dir` na rede do painel. */
  private async serveStaticDir(project: Project, dir: string, label: string, onLog: LogFn): Promise<string> {
    const web = `${containerPrefix(project)}-web`;
    await run("docker", ["rm", "-f", web]);
    const runRes = await run("docker", [
      "run",
      "-d",
      "--name",
      web,
      "--restart",
      "unless-stopped",
      "--network",
      PAAS_NETWORK,
      "--network-alias",
      project.slug,
      "-v",
      `${dir}:/usr/share/nginx/html:ro`,
      "--label",
      `${PAAS_LABEL_MANAGED}=true`,
      "--label",
      `${PAAS_LABEL_PROJECT}=${project.slug}`,
      this.ctx.staticImage,
    ]);
    if (runRes.code !== 0) throw new Error(`falha ao subir o servidor estático: ${runRes.stderr}`);
    onLog(`Container ${web} servindo ${label}/ na rede ${PAAS_NETWORK}.\n`);
    return `${project.slug}:80`;
  }

  // -------------------------------------------------------------------------
  // Pipeline: static-node
  // -------------------------------------------------------------------------

  private async deployStatic(project: Project, src: string, onLog: LogFn): Promise<string> {
    const outputDir = project.detection?.outputDir ?? "dist";
    const pm = project.detection?.packageManager ?? "npm";
    const installCmd =
      pm === "pnpm"
        ? "corepack enable && pnpm install"
        : pm === "yarn"
          ? "corepack enable && yarn install"
          : "npm install";
    const buildCmd = pm === "npm" ? "npm run build" : `${pm} build`;

    // --user: roda com o uid/gid do host para que os artefatos de build (dist/,
    // node_modules) não fiquem pertencentes a root no bind mount.
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    const code = await runStream(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        `paas-build-${project.slug}`,
        "--user",
        `${uid}:${gid}`,
        "-e",
        "HOME=/tmp",
        "-v",
        `${src}:/app`,
        "-w",
        "/app",
        this.ctx.nodeImage,
        "sh",
        "-c",
        `${installCmd} && ${buildCmd}`,
      ],
      onLog,
    );
    if (code !== 0) throw new Error(`build estático falhou (exit ${code}).`);

    return this.serveStaticDir(project, path.join(src, outputDir), outputDir, onLog);
  }

  // -------------------------------------------------------------------------
  // Pipeline: compose (adota o compose existente + override do painel)
  // -------------------------------------------------------------------------

  private async deployCompose(
    project: Project,
    src: string,
    onLog: LogFn,
    dotenv: Record<string, string> = {},
    extraEnv: Record<string, string> = {},
  ): Promise<string> {
    const composeFile = project.detection?.composeFile;
    if (!composeFile) throw new Error("Nenhum arquivo compose detectado.");
    const proxyService = project.proxyService ?? project.detection?.proxyService;
    if (!proxyService) throw new Error("Informe o serviço web do compose (proxyService).");
    const proxyPort = project.proxyPort ?? project.detection?.proxyPort;
    if (!proxyPort) throw new Error("Informe a porta do serviço web (proxyPort).");

    // Override gerado pelo painel (compose-override.ts): NÃO reescreve o
    // compose do usuário; anexa o serviço web à rede paas-net, injeta env
    // extra (Fase 3 — SMTP) e, em app comum, retira a publicação de 80/443.
    const envServices = Object.keys(extraEnv).length > 0 ? await composeServiceNames(src, composeFile) : [];
    const composeContent = await readFile(path.join(src, composeFile), "utf8");

    const workDir = projectWorkDir(this.ctx, project);
    await mkdir(workDir, { recursive: true });
    const overrideFile = path.join(workDir, "paas.override.yml");
    const overrideYaml = composeOverrideYaml({
      compose: composeContent,
      proxyService,
      slug: project.slug,
      network: PAAS_NETWORK,
      env: extraEnv,
      envServices,
      ...(project.portOverrides ? { portOverrides: project.portOverrides } : {}),
    });
    await writeFile(overrideFile, overrideYaml, { encoding: "utf8", mode: 0o600 });
    onLog(`Override gerado em ${overrideFile} (serviço "${proxyService}" na ${PAAS_NETWORK}).\n`);
    const stripped = strippedProxyPortServices(composeContent);
    if (stripped.length > 0) {
      onLog(
        `Portas 80/443 do servidor retiradas de: ${stripped.join(", ")} — são do proxy do painel; ` +
          "o tráfego chega pela rede interna (o repositório não foi alterado).\n",
      );
    }
    // Trocas da porta do servidor feitas no painel (modal Portas).
    const portChanges = effectiveServicePorts(composeContent, project.portOverrides, { stripProxyPorts: true });
    for (const c of portChanges.changes) {
      onLog(`Porta do servidor (${c.service}): ${c.from} → ${c.to ?? "publicação removida"} — troca feita no painel.\n`);
    }
    for (const s of portChanges.stale) {
      onLog(`Aviso: a troca da porta ${s.original} do serviço ${s.service} não vale mais — essa porta não está no compose (ou é 80/443).\n`);
    }
    if (envServices.length > 0) {
      onLog(`Env vars injetadas nos serviços: ${envServices.join(", ")}.\n`);
    }

    // Variáveis do projeto → .env do compose (interpolação ${VAR} e env_file).
    const env = await writeProjectDotenv(src, workDir, dotenv);
    const dotenvKeys = Object.keys(dotenv);
    if (dotenvKeys.length > 0) {
      onLog(`Variáveis gravadas no .env do projeto (${dotenvKeys.join(", ")}).\n`);
    }
    if (env.note) onLog(`Aviso: ${env.note}\n`);

    const args = this.composeArgs(project, src);
    let output = "";
    const code = await runStream("docker", [...args, "up", "-d", "--build"], (chunk) => {
      output += chunk;
      onLog(chunk);
    });
    if (code !== 0) {
      const missing = missingFromComposeOutput(output);
      if (missing.length > 0) {
        throw new Error(
          `faltam variáveis obrigatórias do compose: ${missing.join(", ")}. Preencha na seção Variáveis do projeto` +
            (missing.some((m) => m.startsWith("SMTP_") || m === "MAIL_FROM")
              ? " (SMTP_* e MAIL_FROM o painel preenche sozinho se você ativar a seção E-mail do projeto)"
              : "") +
            " e faça o deploy de novo.",
        );
      }
      // Por que falhou: estado de cada serviço, fim do log e healthcheck de
      // quem ficou unhealthy/parou (validação real: "wallet is unhealthy"
      // sem nenhuma linha do wallet no log do painel).
      onLog("\n=== Diagnóstico: estado dos serviços depois da falha ===\n");
      const summary = await diagnoseComposeFailure(args, startableServices(composeContent), onLog, run);
      throw new Error(summary ? `docker compose up falhou: ${summary}.` : `docker compose up falhou (exit ${code}).`);
    }

    return `${project.slug}:${proxyPort}`;
  }

  private composeArgs(project: Project, src: string): string[] {
    const composeFile = project.detection?.composeFile ?? "compose.yml";
    const workDir = projectWorkDir(this.ctx, project);
    const overrideFile = path.join(workDir, "paas.override.yml");
    // .env versionado no repositório: as variáveis do painel ficam à parte
    // (ver project-dotenv.ts) e todo comando do compose precisa delas.
    const envFile = path.join(workDir, "paas.env");
    return [
      "compose",
      "-p",
      composeProjectName(project),
      ...(existsSync(envFile) ? ["--env-file", envFile] : []),
      "--project-directory",
      src,
      "-f",
      path.join(src, composeFile),
      "-f",
      overrideFile,
    ];
  }

  // -------------------------------------------------------------------------
  // Pipeline: dockerfile
  // -------------------------------------------------------------------------

  private async deployDockerfile(
    project: Project,
    src: string,
    onLog: LogFn,
    extraEnv: Record<string, string> = {},
  ): Promise<string> {
    const image = `paas-${project.slug}:latest`;
    const port = project.proxyPort ?? project.detection?.proxyPort;
    if (!port) throw new Error("Informe a porta exposta pelo container (proxyPort).");

    const buildCode = await runStream(
      "docker",
      ["build", "-t", image, src],
      onLog,
    );
    if (buildCode !== 0) throw new Error(`docker build falhou (exit ${buildCode}).`);

    const app = `${containerPrefix(project)}-app`;
    await run("docker", ["rm", "-f", app]);
    const envArgs: string[] = [];
    for (const [key, value] of Object.entries(extraEnv)) {
      envArgs.push("-e", `${key}=${value}`);
    }
    const runRes = await run("docker", [
      "run",
      "-d",
      "--name",
      app,
      "--restart",
      "unless-stopped",
      "--network",
      PAAS_NETWORK,
      "--network-alias",
      project.slug,
      ...envArgs,
      "--label",
      `${PAAS_LABEL_MANAGED}=true`,
      "--label",
      `${PAAS_LABEL_PROJECT}=${project.slug}`,
      image,
    ]);
    if (runRes.code !== 0) throw new Error(`falha ao subir o container: ${runRes.stderr}`);
    onLog(`Container ${app} rodando na rede ${PAAS_NETWORK}.\n`);
    return `${project.slug}:${port}`;
  }

  // -------------------------------------------------------------------------
  // Stop / start / remove
  // -------------------------------------------------------------------------

  /** IDs dos containers do projeto (por label do painel + compose project). */
  async projectContainers(project: Project): Promise<string[]> {
    const ids = new Set<string>();
    for (const filter of [
      `label=${PAAS_LABEL_PROJECT}=${project.slug}`,
      `label=com.docker.compose.project=${composeProjectName(project)}`,
    ]) {
      const r = await run("docker", ["ps", "-a", "-q", "--filter", filter]);
      if (r.code === 0) {
        for (const line of r.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) ids.add(line);
      }
    }
    return [...ids];
  }

  async stop(project: Project, onLog: LogFn): Promise<void> {
    const ids = await this.projectContainers(project);
    if (ids.length === 0) {
      // Mesmo padrão de erro do start (bug conhecido): sem containers não há
      // o que parar — é uma condição de negócio, não uma falha de infra, e
      // precisa do statusCode/code corretos para sendError() não mapear
      // para 500 internal_error.
      throw engineError(
        409,
        "no_containers",
        `Nenhum container encontrado para "${project.name}" — faça um deploy primeiro.`,
      );
    }
    const r = await run("docker", ["stop", ...ids], { timeoutMs: 120_000 });
    if (r.code !== 0) {
      throw engineError(502, "docker_stop_failed", `Falha ao parar containers: ${r.stderr}`);
    }
    onLog(`${ids.length} container(es) parado(s).\n`);
  }

  async start(project: Project, onLog: LogFn): Promise<void> {
    const ids = await this.projectContainers(project);
    if (ids.length === 0) {
      throw engineError(
        409,
        "no_containers",
        `Nenhum container encontrado para "${project.name}" — faça um deploy primeiro.`,
      );
    }
    const r = await run("docker", ["start", ...ids], { timeoutMs: 120_000 });
    if (r.code !== 0) {
      throw engineError(502, "docker_start_failed", `Falha ao iniciar containers: ${r.stderr}`);
    }
    onLog(`${ids.length} container(es) iniciado(s).\n`);
  }

  /** Remove containers e artefatos Docker do projeto (código é decidido pela API). */
  async remove(project: Project, onLog: LogFn): Promise<void> {
    const src = projectSrcDir(this.ctx, project);
    if (project.detection?.type === "compose" && project.detection.composeFile) {
      const down = await run(
        "docker",
        [...this.composeArgs(project, src), "down", "--rmi", "local", "--remove-orphans"],
        { timeoutMs: 180_000 },
      );
      onLog(down.code === 0 ? "Stack compose removida.\n" : `compose down: ${down.stderr}\n`);
    }
    const ids = await this.projectContainers(project);
    if (ids.length > 0) {
      await run("docker", ["rm", "-f", ...ids]);
      onLog(`${ids.length} container(es) removido(s).\n`);
    }
    await run("docker", ["image", "rm", "-f", `paas-${project.slug}:latest`]);
  }

  /**
   * Certificado HTTPS de cada domínio do projeto, conferido pelo proxy central
   * (o mesmo caminho do health check). Domínio .localhost não tem HTTPS.
   */
  async httpsStatus(project: Project): Promise<DomainHttpsStatus[]> {
    const target = healthCheckTarget(this.ctx);
    if (this.ctx.panelContainer) await this.caddy.connectToNetwork(this.ctx.panelContainer);
    const domains = [project.domain, ...(project.aliases ?? [])];
    return Promise.all(
      domains.map(async (domain) =>
        domain.endsWith(".localhost") || domain === "localhost"
          ? { domain, ok: false, issuer: null, validTo: null, error: "domínio local (.localhost): sem HTTPS" }
          : { domain, ...(await certificateStatus({ host: target.host, port: target.httpsPort, servername: domain })) },
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Health check (via Caddy central, com Host header)
  // -------------------------------------------------------------------------

  private async waitHealthy(domain: string, onLog: LogFn, timeoutMs = 60_000): Promise<void> {
    const target = healthCheckTarget(this.ctx);
    // O painel precisa estar na rede do Caddy para alcançá-lo pelo nome.
    if (this.ctx.panelContainer) await this.caddy.connectToNetwork(this.ctx.panelContainer);
    const deadline = Date.now() + timeoutMs;
    let lastError = "";
    let ok = false;
    while (Date.now() < deadline) {
      const result = await httpGet(target.host, target.httpPort, domain);
      if (result.ok) {
        ok = true;
        break;
      }
      lastError = result.error ?? `HTTP ${result.status}`;
      await new Promise((r) => setTimeout(r, 2_000));
    }
    if (!ok) {
      onLog(`Última resposta do health check: ${lastError}\n`);
      throw new Error(`health check falhou após ${Math.round(timeoutMs / 1000)}s (${lastError}).`);
    }
    onLog(`Health check OK — o proxy responde por ${domain}.\n`);
    if (domain.endsWith(".localhost") || domain === "localhost") return;

    // HTTPS: o Caddy emite o certificado na primeira visita (Let's Encrypt).
    // Confere com o certificado de verdade; se ainda não saiu, avisa sem falhar.
    const httpsDeadline = Date.now() + 90_000;
    let httpsError = "";
    while (Date.now() < httpsDeadline) {
      const result = await httpsGet(target.host, target.httpsPort, domain);
      if (result.ok) {
        onLog(`HTTPS pronto (certificado válido) — o site está no ar em https://${domain}\n`);
        return;
      }
      httpsError = result.error ?? `HTTP ${result.status}`;
      await new Promise((r) => setTimeout(r, 3_000));
    }
    onLog(
      `⚠ O site responde, mas o certificado HTTPS ainda não ficou pronto (${httpsError}). ` +
        `Se o domínio acabou de ser apontado, o DNS pode estar propagando: o Caddy tenta de novo sozinho.\n`,
    );
  }
}

/** Nomes dos serviços declarados no compose adotado (para injeção de env vars). */
async function composeServiceNames(src: string, composeFile: string): Promise<string[]> {
  try {
    const doc = parse(await readFile(path.join(src, composeFile), "utf8")) as {
      services?: Record<string, unknown>;
    } | null;
    return Object.keys(doc?.services ?? {});
  } catch {
    return [];
  }
}

/** GET http://<host>:<port>/ com Host: <domain> (passa pelo Caddy central). */
function httpGet(
  host: string,
  port: number,
  domain: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  return new Promise((resolve) => {
    const req = http.request(
      { host, port, path: "/", method: "GET", headers: { Host: domain }, timeout: 5_000 },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        resolve({ ok: status >= 200 && status < 400, status });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
    req.end();
  });
}

/** GET https://<host>:<port>/ com SNI e Host = <domain>: exige o certificado válido do domínio. */
function httpsGet(
  host: string,
  port: number,
  domain: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  return new Promise((resolve) => {
    const req = https.request(
      { host, port, path: "/", method: "GET", servername: domain, headers: { Host: domain }, timeout: 10_000 },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        resolve({ ok: status >= 200 && status < 400, status });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
    req.end();
  });
}
