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
import { existsSync, readFileSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  COMPOSE_PROJECT_LABEL,
  PAAS_LABEL_MANAGED,
  PAAS_LABEL_PROJECT,
  PAAS_MAIL_NETWORK,
  PAAS_NETWORK,
  PANEL_IMAGE_REPOSITORIES,
  type DomainHttpsStatus,
  type GuardrailReport,
  type Project,
  PAAS_CADDY_CONTAINER,
} from "@paas/core";
import { parse } from "yaml";
import { CaddyManager, projectDomain, type CaddyTarget, type CaddyWebmail, type ManualCaddyCertificate, type PanelSite } from "./caddy.js";
import { run, runStream } from "./exec.js";
import { ingestCode, projectSrcDir, projectWorkDir, type IngestContext } from "./ingest.js";
import { preparePublishDir, publishBuildOutput } from "./static-site.js";
import { certificateStatus, type CertificateStatus } from "./tls-status.js";
import { composeOverrideYaml, hardenComposeModel, strippedProxyPortServices } from "./compose-override.js";
import { effectiveServicePorts } from "./port-overrides.js";
import { diagnoseComposeFailure, startableServices } from "./compose-diagnose.js";
import { missingFromComposeOutput, writeProjectDotenv } from "./project-dotenv.js";
import { isRegularFile, readFileNoFollow } from "./safe-fs.js";
import { composeServiceList, composeTimezoneDefinitions, timezoneServiceEnv } from "./compose-timezone.js";
import { runGuardrails } from "./rules.js";
import { composeEnv, loadCanonicalCompose } from "./compose-config.js";
import { HARD_RULES, checkComposeModel, resolveRealPath } from "./compose-model.js";
import { waitHealthy } from "./health-check.js";

export interface EngineContext extends IngestContext {
  /** Diretório data/caddy. */
  caddyDir: string;
  /** Imagem Node usada nos builds estáticos. */
  nodeImage: string;
  /** Imagem nginx usada para servir estáticos. */
  staticImage: string;
  /** Imagens extras do painel que um build de projeto não pode regravar (além das fixas e das duas acima). */
  protectedImages?: string[];
  /** Slugs de todos os projetos (nomes que o DNS da rede do proxy já responde). */
  projectSlugs?: () => string[];
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
  /** Pasta de instalação do painel no host (ex.: /opt/tws-panel): nenhum projeto a monta. */
  panelInstallDir?: string;
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
   * Fuso horário que o projeto recebe (campo "Fuso horário" do projeto):
   * `TZ=<fuso>` nos serviços que não definem TZ. null/ausente = o da imagem.
   */
  timezoneForProject?: (project: Project) => Promise<string | null>;
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
  /**
   * Webmail ativado (upstream e IPs bloqueados) ou null. Consultado a cada
   * sincronização do proxy; ausente = página do servidor de e-mail.
   */
  webmail?: () => Promise<CaddyWebmail | null>;
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
    const report = opts?.precomputedGuardrailReport ?? (await runGuardrails(src, project.detection?.composeFile, project.portOverrides, this.isolationForRaw(project)));
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

    const timezone = (await this.ctx.timezoneForProject?.(project)) ?? null;

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
          timezone,
          opts?.guardrailOverride === true,
        );
        break;
      case "dockerfile":
        onLog("\n=== Etapa 3/5 · docker build (Dockerfile) ===\n");
        upstream = await this.deployDockerfile(project, src, onLog, extraEnv, timezone);
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
      ...(await this.webmail(onLog)),
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
      ...(await this.webmail(onLog)),
    });
  }

  /** Webmail ativado; falha aqui não pode derrubar o proxy dos sites. */
  private async webmail(onLog?: LogFn): Promise<{ webmail?: CaddyWebmail }> {
    try {
      const webmail = await this.ctx.webmail?.();
      return webmail ? { webmail } : {};
    } catch (err) {
      onLog?.(`aviso: webmail indisponível para o proxy (${err instanceof Error ? err.message : String(err)}).\n`);
      return {};
    }
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

  /**
   * Hosts do servidor de e-mail para a checagem do compose (um serviço não pode ter o nome DNS
   * deles na rede de e-mail). Falha FECHADA: sem a lista, um hostname que não começa por
   * `mail.` ficaria sem proteção; então o deploy com e-mail espera a leitura funcionar.
   */
  private async requiredMailHosts(): Promise<string[]> {
    try {
      return (await this.ctx.mailHosts?.()) ?? [];
    } catch (err) {
      throw new Error(
        `não consegui ler os hosts do servidor de e-mail (${err instanceof Error ? err.message : String(err)}); ` +
          "o deploy de um projeto com e-mail só segue com essa conferência. Tente de novo em instantes.",
      );
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
      ...CONTAINER_HARDENING,
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

    // O nginx não monta a pasta do build direto (poderia ser um link para o
    // host, achado M8): serve uma cópia criada pelo painel, fora do src.
    const site = path.join(projectWorkDir(this.ctx, project), "site");
    await publishBuildOutput(src, outputDir, site);
    onLog(`Saída do build (${outputDir}/) copiada para a pasta de publicação, sem links simbólicos.\n`);
    return this.serveStaticDir(project, site, outputDir, onLog);
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
    timezone: string | null = null,
    guardrailOverride = false,
  ): Promise<string> {
    await this.assertInputsSafe(src, [project.detection?.composeFile ?? "compose.yml"]);
    const { proxyPort, composeContent, mailServices } = await this.writeComposeFiles(project, src, onLog, dotenv, extraEnv, timezone);
    await this.assertInputsSafe(src, [".env"]);
    await this.writeComposeEnv(project, src);
    const args = this.composeArgs(project, src);
    const model = await this.assertComposeAllowed(project, src, args, onLog, guardrailOverride, mailServices);
    // o up roda do que foi conferido, não do compose do repositório (o app pode trocá-lo entre o config e o up)
    const upArgs = await this.canonicalArgs(project, src, model);
    let output = "";
    const code = await runStream("docker", [...upArgs, "up", "-d", "--build"], (chunk) => {
      output += chunk;
      onLog(chunk);
    }, { env: composeEnv() });
    if (code !== 0) await this.composeUpFailed(upArgs, output, code, composeContent, onLog);
    return `${project.slug}:${proxyPort}`;
  }

  /** Erro de variáveis obrigatórias do compose sem valor. */
  private missingVariablesError(missing: string[]): Error {
    return new Error(
      `faltam variáveis obrigatórias do compose: ${missing.join(", ")}. Preencha na seção Variáveis do projeto` +
        (missing.some((m) => m.startsWith("SMTP_") || m === "MAIL_FROM")
          ? " (SMTP_* e MAIL_FROM o painel preenche sozinho se você ativar a seção E-mail do projeto)"
          : "") +
        " e faça o deploy de novo.",
    );
  }

  /**
   * Confere o compose COMO O DOCKER O VAI EXECUTAR (`docker compose config`
   * com os mesmos -p, --env-file, --project-directory e -f do `up`: merge,
   * include, extends e ${VAR} já resolvidos) contra a lista do que um projeto
   * pode pedir (compose-model.ts). É a checagem que vale: a da tela olha o
   * YAML cru. Bloqueios de isolamento do painel (HARD_RULES) não têm override.
   */
  private async assertComposeAllowed(
    project: Project,
    src: string,
    args: string[],
    onLog: LogFn,
    guardrailOverride: boolean,
    mailServices: readonly string[] = [],
  ): Promise<unknown> {
    const loaded = await loadCanonicalCompose(args);
    if (!loaded.ok) {
      if (loaded.missing.length > 0) throw this.missingVariablesError(loaded.missing);
      throw new Error(`o docker compose não conseguiu interpretar o compose do projeto: ${loaded.error.slice(0, 1500)}`);
    }
    const findings = checkComposeModel(loaded.model, {
      fileName: project.detection?.composeFile ?? "compose.yml",
      srcRoot: src,
      projectName: composeProjectName(project),
      mode: "canonical",
      panelNetwork: PAAS_NETWORK,
      ...this.isolationFor(project, mailServices),
      // os hosts que o Stalwart responde na rede de e-mail: nome de serviço de projeto nenhum pode repeti-los
      ...(mailServices.length > 0 ? { mailAliases: await this.requiredMailHosts() } : {}),
    });
    onLog("\n=== Guardrails sobre o compose resolvido (docker compose config) ===\n");
    if (findings.length === 0) {
      onLog("O compose resolvido só pede o que um projeto pode pedir.\n");
      return loaded.model;
    }
    for (const f of findings) onLog(`✖ BLOCK [${f.rule}] ${f.title} — ${f.evidence}\n`);
    const hard = findings.filter((f) => HARD_RULES.has(f.rule));
    if (hard.length > 0) {
      onLog("Estes bloqueios protegem o próprio painel e não têm override.\n");
      throw new Error(
        `guardrail_blocked: ${hard.length} bloqueio(s) de isolamento do painel no compose resolvido — sem override possível.`,
      );
    }
    if (!guardrailOverride) {
      onLog("Deploy abortado pelos guardrails. Corrija os bloqueios ou faça override explícito na interface.\n");
      throw new Error(
        `guardrail_blocked: ${findings.length} bloqueio(s) de segurança no compose resolvido — deploy requer override explícito.`,
      );
    }
    onLog(`⚠ Override explícito do operador: prosseguindo com ${findings.length} bloqueio(s).\n`);
    return loaded.model;
  }

  /**
   * Arquivos do projeto que o `docker compose` lê seguindo links (o `.env`
   * da interpolação, o próprio compose): precisam ser arquivos de verdade,
   * com caminho real DENTRO do src. Um `.env` que é link para /etc ou para um
   * segredo do painel seria lido pelo compose (achado A2).
   */
  private async assertInputsSafe(src: string, files: string[]): Promise<void> {
    const root = resolveRealPath(src);
    for (const rel of files) {
      const file = path.join(src, rel);
      let info;
      try {
        info = await lstat(file);
      } catch {
        continue; // não existe: a ausência é problema de quem lê (mensagem própria do compose)
      }
      const real = resolveRealPath(file);
      if (info.isSymbolicLink() || !info.isFile() || !real.startsWith(root + path.sep)) {
        throw new Error(
          `o arquivo ${rel} do projeto não é um arquivo comum dentro da pasta do projeto (link simbólico ou fora dela). ` +
            "O docker compose o leria seguindo o link — troque por um arquivo de verdade e faça o deploy de novo.",
        );
      }
    }
  }

  /**
   * Monta o ambiente do compose (`<projeto>/paas.up.env`, 0600, fora do src): cópia
   * do `.env` do projeto (só se for arquivo comum, lido sem seguir link) seguida do
   * `paas.env` com as Variáveis do painel, que vem por último e vence. O `config`
   * (--no-env-resolution deixa `environment: [VAR]` e `${VAR}` de env_file para o
   * `up`) e o `up` recebem ESTE arquivo: o compose nunca lê `src/.env` por conta
   * própria, nem seguindo link (A2).
   */
  private async writeComposeEnv(project: Project, src: string): Promise<void> {
    const workDir = projectWorkDir(this.ctx, project);
    await mkdir(workDir, { recursive: true });
    const parts: string[] = [];
    const dotenv = path.join(src, ".env");
    if (await isRegularFile(dotenv)) parts.push(await readFileNoFollow(dotenv));
    const panelEnv = path.join(workDir, "paas.env");
    if (existsSync(panelEnv)) parts.push(await readFile(panelEnv, "utf8"));
    const merged = parts.map((p) => (p.endsWith("\n") ? p : `${p}\n`)).join("");
    const target = path.join(workDir, "paas.up.env");
    await writeFile(target, merged, { encoding: "utf8", mode: 0o600 });
    await chmod(target, 0o600);
  }

  /**
   * Grava o modelo conferido em `paas.canonical.json` (fora do src, 0600) e
   * devolve os argumentos do `docker compose` para subir DELE, com o mesmo
   * ambiente do `config` (`paas.up.env`, ver writeComposeEnv).
   */
  private async canonicalArgs(project: Project, src: string, model: unknown): Promise<string[]> {
    const workDir = projectWorkDir(this.ctx, project);
    await mkdir(workDir, { recursive: true });
    const canonical = path.join(workDir, "paas.canonical.json");
    await writeFile(canonical, JSON.stringify(hardenComposeModel(model)), { encoding: "utf8", mode: 0o600 });
    await chmod(canonical, 0o600);
    const envFile = path.join(workDir, "paas.up.env");
    return ["compose", "-p", composeProjectName(project), "--env-file", envFile, "--project-directory", src, "-f", canonical];
  }

  /** Mesmo contexto para a checagem sobre o YAML cru. */
  isolationForRaw(project: Project) {
    return { projectName: composeProjectName(project), ...this.isolationFor(project) };
  }

  /** Quem é o projeto e o que é do painel, para as regras de isolamento. */
  private isolationFor(project: Project, mailServices: readonly string[] = []) {
    return {
      mailServices,
      slug: project.slug,
      // pastas do próprio painel: projetos (paas.env, paas.canonical.json, repo.git dos outros) e instalação
      protectedPaths: [this.ctx.projectsDir, ...(this.ctx.panelInstallDir ? [this.ctx.panelInstallDir] : [])],
      ...((project.proxyService ?? project.detection?.proxyService)
        ? { proxyService: (project.proxyService ?? project.detection?.proxyService)! }
        : {}),
      otherSlugs: (this.ctx.projectSlugs?.() ?? []).filter((s) => s !== project.slug),
      protectedImages: [...PANEL_IMAGE_REPOSITORIES, this.ctx.nodeImage, this.ctx.staticImage, ...(this.ctx.protectedImages ?? [])],
    };
  }

  /** O compose falhou: variáveis faltando ou "por que falhou" de cada serviço. */
  private async composeUpFailed(args: string[], output: string, code: number, composeContent: string, onLog: LogFn): Promise<never> {
    const missing = missingFromComposeOutput(output);
    if (missing.length > 0) throw this.missingVariablesError(missing);
    // Por que falhou: estado de cada serviço, fim do log e healthcheck de
    // quem ficou unhealthy/parou (validação real: "wallet is unhealthy"
    // sem nenhuma linha do wallet no log do painel).
    onLog("\n=== Diagnóstico: estado dos serviços depois da falha ===\n");
    const summary = await diagnoseComposeFailure(
      args,
      startableServices(composeContent),
      onLog,
      (file, a, o) => run(file, a, { ...o, env: composeEnv() }),
    );
    throw new Error(summary ? `docker compose up falhou: ${summary}.` : `docker compose up falhou (exit ${code}).`);
  }

  /** TZ do fuso do projeto por serviço (quem já define TZ fica como está). */
  private composeTimezone(
    src: string,
    composeContent: string,
    dotenv: Record<string, string>,
    timezone: string | null,
    onLog: LogFn,
  ): Record<string, Record<string, string>> {
    if (!timezone) return {};
    const root = path.resolve(src);
    const definitions = composeTimezoneDefinitions(composeContent, dotenv, (rel) => {
      const file = path.resolve(root, rel);
      if (!file.startsWith(root + path.sep)) return null;
      try {
        return readFileSync(file, "utf8");
      } catch {
        return null;
      }
    });
    const serviceEnv = timezoneServiceEnv(composeServiceList(composeContent), definitions, timezone);
    const names = Object.keys(serviceEnv);
    if (names.length > 0) onLog(`Fuso horário: TZ=${timezone} nos serviços ${names.join(", ")}.\n`);
    for (const d of definitions) {
      const where = d.where === "compose" ? "no compose" : d.where === "variables" ? "nas Variáveis" : "num env_file";
      onLog(`Fuso horário: o serviço ${d.service} já define TZ=${d.value} (${where}); mantido.\n`);
    }
    return serviceEnv;
  }

  /** Gera o paas.override.yml e o .env do compose (deploy e reinício com a configuração nova). */
  private async writeComposeFiles(
    project: Project,
    src: string,
    onLog: LogFn,
    dotenv: Record<string, string>,
    extraEnv: Record<string, string>,
    timezone: string | null,
  ): Promise<{ proxyPort: number; composeContent: string; mailServices: string[] }> {
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
    // e-mail habilitado (SMTP_HOST injetado): esses serviços entram na rede de e-mail, a única que alcança o Stalwart (A4)
    const mailServices = extraEnv.SMTP_HOST ? envServices : [];
    if (mailServices.length > 0) await this.ensureMailNetwork();
    const composeContent = await readFile(path.join(src, composeFile), "utf8");

    const workDir = projectWorkDir(this.ctx, project);
    await mkdir(workDir, { recursive: true });
    const overrideFile = path.join(workDir, "paas.override.yml");
    const overrideYaml = composeOverrideYaml({
      compose: composeContent,
      proxyService,
      slug: project.slug,
      network: PAAS_NETWORK,
      mailNetwork: PAAS_MAIL_NETWORK,
      mailServices,
      env: extraEnv,
      envServices,
      ...(project.portOverrides ? { portOverrides: project.portOverrides } : {}),
      serviceEnv: this.composeTimezone(src, composeContent, dotenv, timezone, onLog),
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
      onLog(
        c.from === null
          ? `Porta do servidor (${c.service}): ${c.to} — publicação adicionada no painel.\n`
          : `Porta do servidor (${c.service}): ${c.from} → ${c.to ?? "publicação removida"} — troca feita no painel.\n`,
      );
    }
    for (const s of portChanges.stale) {
      onLog(`Aviso: a troca da porta ${s.original} do serviço ${s.service} não vale mais — essa porta não está no compose (ou é 80/443, ou o serviço usa a rede de outro).\n`);
    }
    if (envServices.length > 0) {
      onLog(`Env vars injetadas nos serviços: ${envServices.join(", ")}.\n`);
    }

    // Variáveis do projeto → .env do compose (interpolação ${VAR} e env_file).
    const env = await writeProjectDotenv(src, workDir, dotenv);
    const dotenvKeys = Object.keys(dotenv);
    if (dotenvKeys.length > 0) {
      onLog(
        env.target === "paas.env"
          ? `Variáveis gravadas em ${path.join(workDir, "paas.env")} e passadas ao compose com --env-file (${dotenvKeys.join(", ")}); o .env da pasta do projeto NÃO foi alterado.\n`
          : `Variáveis gravadas no .env do projeto (${dotenvKeys.join(", ")}).\n`,
      );
    }
    if (env.note) onLog(`Aviso: ${env.note}\n`);
    return { proxyPort, composeContent, mailServices };
  }

  /**
   * Liga os containers JÁ rodando de um projeto com e-mail à rede de e-mail.
   * Migração (A4): o Stalwart sai da paas-net, e o projeto só o alcançaria
   * depois do próximo deploy. Devolve quantos containers foram ligados.
   */
  async joinMailNetwork(project: Project): Promise<number> {
    const ids = await this.projectContainers(project);
    if (ids.length === 0) return 0;
    await this.ensureMailNetwork();
    for (const id of ids) {
      const join = await run("docker", ["network", "connect", PAAS_MAIL_NETWORK, id]);
      if (join.code !== 0 && !/already exists|already connected/i.test(join.stderr)) {
        throw new Error(`falha ao ligar ${id} à rede ${PAAS_MAIL_NETWORK}: ${join.stderr.trim()}`);
      }
    }
    return ids.length;
  }

  /** Garante a rede de e-mail (idempotente): `compose up` com rede externa inexistente falharia. */
  private async ensureMailNetwork(): Promise<void> {
    if ((await run("docker", ["network", "inspect", PAAS_MAIL_NETWORK])).code === 0) return;
    const create = await run("docker", ["network", "create", "--label", `${PAAS_LABEL_MANAGED}=true`, PAAS_MAIL_NETWORK]);
    if (create.code !== 0) throw new Error(`falha ao criar a rede ${PAAS_MAIL_NETWORK}: ${create.stderr.trim()}`);
  }

  /**
   * Recria os containers com a configuração atual (variáveis, e-mail, fuso),
   * SEM baixar código nem refazer o build: é o necessário para um TZ novo
   * entrar (`docker restart` mantém o ambiente antigo). Compose: `up -d
   * --no-build` só recria quem mudou. Dockerfile: o mesmo container de
   * novo, da imagem já construída. Site estático: nada a fazer.
   */
  async recreate(project: Project, onLog: LogFn): Promise<void> {
    const type = project.detection?.type;
    const src = projectSrcDir(this.ctx, project);
    const extraEnv = (await this.ctx.envForProject?.(project)) ?? {};
    const timezone = (await this.ctx.timezoneForProject?.(project)) ?? null;
    if (type === "compose") {
      await this.assertInputsSafe(src, [project.detection?.composeFile ?? "compose.yml"]);
      const { composeContent, mailServices } = await this.writeComposeFiles(
        project,
        src,
        onLog,
        extraEnv,
        (await this.ctx.injectEnvForProject?.(project)) ?? {},
        timezone,
      );
      await this.assertInputsSafe(src, [".env"]);
      await this.writeComposeEnv(project, src);
      const args = this.composeArgs(project, src);
      // o código pode ter sido alterado pelo próprio app desde o último deploy: confere de novo
      const model = await this.assertComposeAllowed(project, src, args, onLog, false, mailServices);
      const upArgs = await this.canonicalArgs(project, src, model);
      let output = "";
      const code = await runStream("docker", [...upArgs, "up", "-d", "--no-build"], (chunk) => {
        output += chunk;
        onLog(chunk);
      }, { env: composeEnv() });
      if (code !== 0) {
        if (/no such image|image .* not found|must be built|pull access denied/i.test(output)) {
          throw new Error("a imagem de um serviço não existe mais no servidor. Faça um deploy para construir de novo.");
        }
        await this.composeUpFailed(upArgs, output, code, composeContent, onLog);
      }
      onLog("Containers recriados com a configuração atual.\n");
      return;
    }
    if (type === "dockerfile") {
      const image = `paas-${project.slug}:latest`;
      const inspect = await run("docker", ["image", "inspect", image]);
      if (inspect.code !== 0) throw new Error("a imagem do projeto não existe mais no servidor. Faça um deploy para construir de novo.");
      await this.runDockerfileContainer(project, image, onLog, extraEnv, timezone);
      return;
    }
    onLog("Site estático: o servidor web não usa fuso horário; nada a recriar.\n");
  }

  private composeArgs(project: Project, src: string): string[] {
    const composeFile = project.detection?.composeFile ?? "compose.yml";
    const workDir = projectWorkDir(this.ctx, project);
    const overrideFile = path.join(workDir, "paas.override.yml");
    // .env versionado no repositório: as variáveis do painel ficam à parte
    // (ver project-dotenv.ts) e todo comando do compose precisa delas.
    const upEnv = path.join(workDir, "paas.up.env");
    const envFile = existsSync(upEnv) ? upEnv : path.join(workDir, "paas.env");
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
    timezone: string | null = null,
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

    await this.runDockerfileContainer(project, image, onLog, extraEnv, timezone);
    return `${project.slug}:${port}`;
  }

  /** Sobe (ou recria) o container do pipeline Dockerfile. */
  private async runDockerfileContainer(
    project: Project,
    image: string,
    onLog: LogFn,
    extraEnv: Record<string, string>,
    timezone: string | null,
  ): Promise<void> {
    const app = `${containerPrefix(project)}-app`;
    await run("docker", ["rm", "-f", app]);
    const envArgs: string[] = [];
    for (const [key, value] of Object.entries(extraEnv)) {
      envArgs.push("-e", `${key}=${value}`);
    }
    if (timezone) {
      // TZ nas Variáveis do projeto vence a escolha do painel.
      if (extraEnv.TZ) onLog(`Fuso horário: o projeto já define TZ=${extraEnv.TZ} nas Variáveis; mantido.\n`);
      else {
        envArgs.push("-e", `TZ=${timezone}`);
        onLog(`Fuso horário: TZ=${timezone}.\n`);
      }
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
      ...CONTAINER_HARDENING,
      image,
    ]);
    if (runRes.code !== 0) throw new Error(`falha ao subir o container: ${runRes.stderr}`);
    onLog(`Container ${app} rodando na rede ${PAAS_NETWORK}.\n`);
    if (extraEnv.SMTP_HOST) {
      await this.ensureMailNetwork();
      const join = await run("docker", ["network", "connect", PAAS_MAIL_NETWORK, app]);
      if (join.code !== 0) throw new Error(`falha ao ligar ${app} à rede ${PAAS_MAIL_NETWORK}: ${join.stderr.trim()}`);
      onLog(`Container ${app} ligado à rede de e-mail ${PAAS_MAIL_NETWORK}.\n`);
    }
  }

  // -------------------------------------------------------------------------
  // Stop / start / remove
  // -------------------------------------------------------------------------

  /**
   * IDs dos containers do projeto. O dono vem da label do compose
   * (`com.docker.compose.project`, que o compose grava por cima de qualquer
   * label da imagem). `paas.project` só vale em container SEM label do
   * compose (criado pelo painel com `docker run`) e marcado `paas.managed`:
   * uma imagem com `LABEL paas.project=<outro>` não captura nem é capturada (M9).
   */
  async projectContainers(project: Project): Promise<string[]> {
    const ids = new Set<string>();
    const lines = (out: string): string[] => out.split("\n").map((l) => l.trim()).filter(Boolean);
    const compose = await run("docker", [
      "ps",
      "-a",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${composeProjectName(project)}`,
    ]);
    if (compose.code === 0) for (const id of lines(compose.stdout)) ids.add(id);
    const direct = await run("docker", [
      "ps",
      "-a",
      "--filter",
      `label=${PAAS_LABEL_PROJECT}=${project.slug}`,
      "--filter",
      `label=${PAAS_LABEL_MANAGED}=true`,
      "--format",
      '{{.ID}} {{.Label "com.docker.compose.project"}}',
    ]);
    if (direct.code === 0) {
      for (const line of lines(direct.stdout)) {
        const [id, owner] = line.split(/\s+/);
        if (id && !owner) ids.add(id);
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
        { timeoutMs: 180_000, env: composeEnv() },
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
    await waitHealthy({ ...target, domain, onLog, timeoutMs });
  }
}

/**
 * Opções de todo `docker run` do painel para código de projeto: sem NET_RAW,
 * no-new-privileges e a label do compose VAZIA (a do `LABEL` da imagem não
 * pode fazer o container passar por outro projeto: ver container-identity.ts).
 */
const CONTAINER_HARDENING = [
  "--cap-drop",
  "NET_RAW",
  "--security-opt",
  "no-new-privileges",
  "--label",
  `${COMPOSE_PROJECT_LABEL}=`,
];

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
