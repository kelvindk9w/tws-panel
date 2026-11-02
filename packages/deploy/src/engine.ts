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
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { totalmem } from "node:os";
import path from "node:path";
import {
  COMPOSE_PROJECT_LABEL,
  PAAS_LABEL_MANAGED,
  PAAS_LABEL_PROJECT,
  hasPublicBuildPrefix,
  hostVariableLogLines,
  PAAS_MAIL_ADMIN_NETWORK,
  PAAS_MAIL_NETWORK,
  TWS_LABEL_MAIL,
  mailExclusionText,
  TWS_LABEL_MAIL_DECIDED,
  isDatabaseImage,
  PAAS_MAILTEST_ADMIN_NETWORK,
  PAAS_NETWORK,
  PAAS_PANEL_NETWORK,
  PANEL_IMAGE_REPOSITORIES,
  type DomainDnsState,
  type DomainHttpsStatus,
  type GuardrailReport,
  type Project,
  PAAS_CADDY_CONTAINER,
} from "@paas/core";
import { unacceptedBlocks } from "@paas/core";
import { parse } from "yaml";
import { activePairs, loadLastPairs, pairCandidates, saveLastPairs, type PairCandidate } from "./domain-pairs.js";
import { CaddyManager, projectDomain, type CaddyDynamic, type CaddyDynamicRoute, type CaddyMtaSts, type CaddyRedirect, type CaddyTarget, type CaddyWebmail, type ManualCaddyCertificate, type PanelSite } from "./caddy.js";
import { run, runStream } from "./exec.js";
import { ingestCode, projectSrcDir, projectWorkDir, type IngestContext } from "./ingest.js";
import { SPA_NGINX_CONF, preparePublishDir, publishBuildOutput } from "./static-site.js";
import { certificateStatus, type CertificateStatus } from "./tls-status.js";
import { composeBuildBaseImages, selectMailServices } from "./mail-services.js";
import { composeOverrideYaml, hardenComposeModel, mailNetworkTargets, strippedProxyPortServices } from "./compose-override.js";
import { effectiveServicePorts } from "./port-overrides.js";
import { diagnoseComposeFailure, startableServices } from "./compose-diagnose.js";
import { sourceFileTooLarge } from "./detect.js";
import { composeBuildTargets, excludePanelDotenv, hasPanelDotenv, ownDotenvInContext, restoreIgnoreJournal } from "./build-context.js";
import { buildArgsFor, renderBuildEnvFile, secretLookingNote, selectBuildVars } from "./build-vars.js";
import { DOCKERFILE_MAX_BYTES, dockerfileArgNames, dockerfileEnvTz, readDockerfileText } from "./dockerfile.js";
import { missingFromComposeOutput, removePanelDotenv, writeProjectDotenv } from "./project-dotenv.js";
import { isRegularFile, readFileNoFollow, readRegularFileLimited, writeFileNoFollow } from "./safe-fs.js";
import { composeDockerfiles, composeEnvFiles, composeServiceList, composeTimezoneDefinitions, composeTimezoneExcluded, timezoneServiceEnv } from "./compose-timezone.js";
import { runGuardrails } from "./rules.js";
import { composeEnv, loadCanonicalCompose } from "./compose-config.js";
import { HARD_RULES, checkComposeModel, resolveRealPath } from "./compose-model.js";
import { waitHealthy } from "./health-check.js";
import { NEXT_DEFAULT_PORT } from "./detect.js";
import { inspectNextApp } from "./next-app.js";
import { TailBuffer, explainBuildFailure, prepareNextBuild } from "./next-build.js";
import { BUILDX_MISSING_MESSAGE, BUILDX_UNUSABLE_MESSAGE, buildkitEnv, buildxHintFromOutput, checkBuildx, composeHasBuild } from "./buildx.js";

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
  /** RAM total do servidor em bytes (define o heap do `next build`); ausente = a do sistema. */
  totalMemBytes?: () => number;
  /** Pasta de instalação do painel no host (ex.: /opt/tws-panel): nenhum projeto a monta. */
  panelInstallDir?: string;
  /**
   * Env vars extras por projeto (Fase 3 — injeção SMTP). Chamado no início de
   * cada deploy; o mapa é injetado no compose override (todos os serviços) ou
   * via -e no pipeline dockerfile. undefined = nenhuma injeção.
   */
  envForProject?: (project: Project) => Promise<Record<string, string>>;
  /**
   * Variáveis que a pessoa marcou como "de build" (públicas: vão ao build estático e ao `docker build` como
   * --build-arg). Só as marcadas; segredo não marcado nunca está aqui. undefined = nenhuma.
   */
  buildEnvForProject?: (project: Project) => Promise<Record<string, string>>;
  /**
   * Variáveis injetadas em TODOS os serviços do compose (override) — hoje as
   * do e-mail do painel. As demais (seção Variáveis) vão só para o `.env`: o
   * compose decide qual serviço recebe cada uma (a vitrine, por exemplo, não
   * entrega segredos dos pagamentos ao front de propósito).
   */
  injectEnvForProject?: (project: Project) => Promise<Record<string, string>>;
  /**
   * Caixa de teste de e-mail do projeto. Chamado a cada deploy/reinício que injeta SMTP: com a caixa
   * ligada, sobe (ou garante) o Mailpit do projeto e devolve a rede interna dele — os serviços do
   * projeto entram nela no lugar da rede do servidor de e-mail. null/ausente = caixa desligada.
   */
  mailTestForProject?: (project: Project) => Promise<{ network: string } | null>;
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
  /**
   * Domínios dinâmicos (emissão sob demanda) por projeto, mais a URL do `ask`
   * do painel. Consultado a cada sincronização do proxy; ausente ou null =
   * nenhum (o Caddyfile fica como sempre foi, sem opções globais).
   */
  dynamicDomains?: () => Promise<DynamicDomainsInput | null>;
  /**
   * DNS de um nome: aponta para esta VPS? Consultado a cada sincronização do
   * proxy só para o par (com/sem www) dos domínios; ausente = nenhum par.
   */
  hostState?: (host: string) => Promise<DomainDnsState>;
  /** Nomes reservados ao painel (domínio cadastrado, ainda sem DNS conferido): o par nunca os toma. */
  reservedNames?: () => string[];
}

export type LogFn = (chunk: string) => void;

/** O que o painel informa sobre os domínios dinâmicos a cada sincronização do proxy. */
export interface DynamicDomainsInput {
  askUrl: string;
  projects: Array<{ projectId: string; suffixes: string[]; hosts: string[] }>;
  /** Política MTA-STS dos domínios de e-mail (mta-sts.<domínio>), servida pelo próprio proxy. */
  mtaSts?: CaddyMtaSts[];
}

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
export function caddyTargetsFor(
  projects: Project[],
  upstreamFor: (p: Project) => string,
  isUpdating: (p: Project) => boolean = () => false,
): CaddyTarget[] {
  return projects.flatMap((p) =>
    projectCaddyTargets(p, upstreamFor(p)).map((t) => ({
      ...t,
      published: wasPublished(p),
      ...(isUpdating(p) ? { updating: true } : {}),
      ...(p.stoppedAt ? { stopped: true } : {}),
    })),
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

/** Porta do servidor Node: a do projeto (campo Porta) > a detectada > 3000. */
export function nodeServerPort(project: Project): number {
  return project.proxyPort ?? project.detection?.proxyPort ?? NEXT_DEFAULT_PORT;
}

export class DeployEngine {
  readonly caddy: CaddyManager;

  /** Pastas de trabalho com um build do `.env` fora do contexto em andamento (nesta execução do painel). */
  private readonly activeBuilds = new Set<string>();
  /** Recuperações de sobra de build em andamento por pasta de trabalho: o build espera por elas. */
  private readonly recoveries = new Map<string, Promise<string[]>>();

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
   * Avisa no log (sem bloquear) de variável de host salva com esquema, barra,
   * porta ou espaço (SITE_HOST=http://…). Nunca imprime o valor salvo.
   */
  private warnHostVariables(vars: Record<string, string>, onLog: LogFn): void {
    for (const line of hostVariableLogLines(vars)) onLog(line);
  }

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
    opts?: { guardrailOverride?: boolean; acceptedBlocks?: string[]; precomputedGuardrailReport?: GuardrailReport },
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
    const report = opts?.precomputedGuardrailReport ?? (await runGuardrails(src, project.detection?.composeFile, project.portOverrides, this.isolationForRaw(project), (await this.ctx.envForProject?.(project)) ?? {}));
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
    if (report.blockers > 0 && opts?.acceptedBlocks) {
      // o override vale só para os bloqueios que a pessoa viu e aceitou (a ingestão pode ter trazido código novo)
      const fresh = unacceptedBlocks(report.findings.filter((f) => f.level === "block"), opts.acceptedBlocks);
      if (fresh.length > 0) {
        onLog("Deploy abortado: há bloqueios que você não aceitou. Revise e aceite de novo.\n");
        throw new Error(
          `guardrail_changed: os bloqueios mudaram desde que você os aceitou. Revise e aceite de novo. Novos: ${fresh.map((f) => `[${f.rule}] ${f.evidence}`).join("; ")}`,
        );
      }
    }
    if (report.blockers > 0) {
      onLog(`⚠ Override explícito do operador: prosseguindo com ${report.blockers} bloqueio(s).\n`);
    }

    const tooLarge = await sourceFileTooLarge(src, {
      composeFile: type === "compose" ? project.detection?.composeFile : null,
      node: type === "node-server" || type === "static-node",
    });
    if (tooLarge) throw new Error(tooLarge);

    onLog(`\n=== Etapa 2/5 · Preparação (${type}) ===\n`);
    await this.caddy.ensureNetwork();
    onLog(`Rede ${PAAS_NETWORK} OK.\n`);

    // Env vars extras (Fase 3 — SMTP). Valores NUNCA são logados.
    const extraEnv = (await this.ctx.envForProject?.(project)) ?? {};
    const envKeys = Object.keys(extraEnv);
    if (envKeys.length > 0) {
      onLog(`Injetando ${envKeys.length} variável(is) de ambiente do projeto (${envKeys.join(", ")}).\n`);
    }
    if (type !== "static" && type !== "static-node") this.warnHostVariables(extraEnv, onLog);

    const timezone = (await this.ctx.timezoneForProject?.(project)) ?? null;
    // Variáveis marcadas como "de build" (públicas): só elas vão ao build; as demais ficam só para a execução
    const buildEnv = (await this.ctx.buildEnvForProject?.(project)) ?? {};
    if (type === "static-node" || type === "dockerfile" || type === "compose") {
      const unmarked = Object.keys(extraEnv).filter((k) => !(k in buildEnv) && hasPublicBuildPrefix(k));
      if (unmarked.length > 0) {
        onLog(
          `Aviso: ${unmarked.join(", ")} tem prefixo de variável pública, mas NÃO está marcada como "de build" na seção Variáveis: não entra no build ` +
            "(se o site precisa dela, marque-a; só marque o que pode ficar visível no JavaScript do site).\n",
        );
      }
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
        upstream = await this.deployStatic(project, src, onLog, buildEnv);
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
          buildEnv,
          opts?.acceptedBlocks,
        );
        break;
      case "dockerfile":
        onLog("\n=== Etapa 3/5 · docker build (Dockerfile) ===\n");
        upstream = await this.deployDockerfile(project, src, onLog, extraEnv, timezone, buildEnv);
        break;
      case "node-server":
        onLog("\n=== Etapa 3/5 · Next.js com servidor (Dockerfile gerado pelo painel) ===\n");
        upstream = await this.deployNodeServer(project, src, onLog, extraEnv, timezone);
        break;
    }

    try {
      await this.proxyAndHealth(project, allProjects, upstream, onLog);
    } catch (err) {
      // Next.js: o container antigo foi só parado; se o novo não fica de pé, o site volta como estava
      if (type === "node-server") {
        const restoredPort = await this.rollbackNodeServer(project, onLog);
        // a porta pode ter mudado neste deploy e o Caddy já aponta para a nova: volta para a da versão antiga
        if (restoredPort !== null) {
          // fica gravado (mesmo com a mesma porta): o site está na versão antiga, então o Recriar é recusado e o
          // próximo refreshProxy (certificado, e-mail, outro deploy) não pode voltar à porta nova
          project.servingPort = restoredPort;
          if (restoredPort !== nodeServerPort(project)) {
            onLog(`Aviso: a Porta configurada (${nodeServerPort(project)}) não está em uso: o site segue na ${restoredPort}, da versão anterior, até um deploy bem-sucedido.\n`);
          }
        }
        if (restoredPort !== null && restoredPort !== nodeServerPort(project)) {
          try {
            await this.applyProxy(project, allProjects, `${project.slug}:${restoredPort}`, onLog);
            onLog(`↩ Proxy reaplicado com a porta da versão anterior (${restoredPort}).\n`);
          } catch (proxyErr) {
            onLog(`✖ Não consegui reaplicar o proxy com a porta da versão anterior (${restoredPort}): ${proxyErr instanceof Error ? proxyErr.message : String(proxyErr)}\n`);
          }
        }
      }
      throw err;
    }
    if (type === "node-server") {
      delete project.servingPort;
      await this.finishNodeServer(project, onLog);
    }
  }

  /** Etapas 4/5 e 5/5: proxy reverso e health check. */
  private async proxyAndHealth(project: Project, allProjects: Project[], upstream: string, onLog: LogFn): Promise<void> {
    onLog("\n=== Etapa 4/5 · Proxy reverso (Caddy central) ===\n");
    const domain = projectDomain(project);
    await this.applyProxy(project, allProjects, upstream, onLog);
    onLog(`Domínio ${domain} → ${upstream}\n`);

    onLog("\n=== Etapa 5/5 · Health check ===\n");
    await this.waitHealthy(domain, onLog);
  }

  /** Aplica no Caddy central o projeto apontando para `upstream` (os demais, como estão). */
  private applyProxy(project: Project, allProjects: Project[], upstream: string, onLog: LogFn): Promise<void> {
    // Na fila do Caddy: alvos, hosts de e-mail, certificados e pares são calculados NA VEZ desta chamada. Antes, o
    // retrato dos avisos por projeto era tirado antes dos awaits e um "desligar" de outro projeto, feito nesse
    // intervalo, era sobrescrito pelo retrato velho.
    return this.queueCaddy(() => this.applyProxyNow(project, allProjects, upstream, onLog));
  }

  private async applyProxyNow(project: Project, allProjects: Project[], upstream: string, onLog: LogFn): Promise<void> {
    const others = allProjects.filter((p) => p.id !== project.id);
    // tudo o que exige await vem PRIMEIRO; os alvos (que leem os avisos "Atualizando" e os projetos parados) são
    // montados por último, de forma síncrona, logo antes de aplicar — nenhum retrato fica velho esperando I/O
    const mailNames = await this.mailHosts(onLog);
    const manual = await this.manualCertificates(onLog);
    const redirects = await this.redirectOptions([...others, project], mailNames);
    const webmail = await this.webmail(onLog);
    const dynamic = await this.dynamicOptions([...others, project], onLog, { id: project.id, upstream });
    const targets = caddyTargetsFor(others, (p) => this.upstreamFor(p), (p) => this.updating.has(p.id));
    targets.push(
      ...projectCaddyTargets(project, upstream).map((t) => ({
        ...t,
        published: wasPublished(project),
        ...(this.updating.has(project.id) ? { updating: true } : {}),
        ...(project.stoppedAt ? { stopped: true } : {}),
      })),
    );
    await this.caddy.apply(targets, onLog, mailNames, { manual, ...dynamic, force: false, ...redirects, ...webmail });
    await this.commitPairs();
  }

  /**
   * Projetos com deploy/atualização em andamento: o proxy mostra "Atualizando" aos
   * visitantes enquanto o app não responde. Só em memória: some quando o painel
   * reinicia (e a próxima geração do Caddyfile, no boot, já sai sem o aviso).
   */
  private readonly updating = new Set<string>();

  /** Liga/desliga o aviso "Atualizando" do projeto no próximo Caddyfile gerado. Devolve se mudou. */
  setUpdating(projectId: string, on: boolean): boolean {
    if (on === this.updating.has(projectId)) return false;
    if (on) this.updating.add(projectId);
    else this.updating.delete(projectId);
    return true;
  }

  /** O aviso "Atualizando" está ligado para o projeto? */
  isUpdating(projectId: string): boolean {
    return this.updating.has(projectId);
  }

  /**
   * Recalcula o Caddyfile com TODOS os projetos (chamado após cada mudança).
   * `force`: recarrega mesmo sem mudança ("Tentar emitir agora").
   */
  async syncCaddy(projects: Project[], onLog?: LogFn, opts: { force?: boolean } = {}): Promise<void> {
    return this.queueCaddy(() => this.syncCaddyNow(projects, onLog, opts));
  }

  /**
   * Fila única dos ajustes do Caddy: o Caddyfile é calculado NA VEZ de cada chamada (lendo o aviso "Atualizando" de
   * agora), então um cálculo antigo nunca chega depois de um novo.
   */
  private queueCaddy(job: () => Promise<void>): Promise<void> {
    const run = this.syncQueue.then(job);
    this.syncQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private syncQueue: Promise<void> = Promise.resolve();

  private async syncCaddyNow(projects: Project[], onLog: LogFn | undefined, opts: { force?: boolean }): Promise<void> {
    const mailNames = await this.mailHosts(onLog);
    const manual = await this.manualCertificates(onLog);
    const redirects = await this.redirectOptions(projects, mailNames);
    const webmail = await this.webmail(onLog);
    const dynamic = await this.dynamicOptions(projects, onLog);
    // por último e de forma síncrona: os alvos leem o aviso "Atualizando" de agora
    const targets = caddyTargetsFor(projects, (p) => this.upstreamFor(p), (p) => this.updating.has(p.id));
    await this.caddy.apply(targets, onLog, mailNames, { manual, ...dynamic, force: opts.force ?? false, ...redirects, ...webmail });
    await this.commitPairs();
  }

  /**
   * `{ dynamic }` quando algum projeto tem domínio dinâmico; nada quando não tem.
   * `now`: projeto cujo upstream ainda não está gravado (deploy em curso). Falha aqui
   * não derruba o proxy dos sites: sem a lista, os nomes dinâmicos saem do Caddyfile
   * até o próximo ajuste (o certificado já emitido fica guardado).
   */
  private async dynamicOptions(
    projects: Project[],
    onLog?: LogFn,
    now?: { id: string; upstream: string },
  ): Promise<{ dynamic?: CaddyDynamic }> {
    try {
      const input = await this.ctx.dynamicDomains?.();
      if (!input) return {};
      const routes: CaddyDynamicRoute[] = [];
      for (const entry of input.projects) {
        const project = projects.find((p) => p.id === entry.projectId);
        if (!project || (entry.suffixes.length === 0 && entry.hosts.length === 0)) continue;
        routes.push({
          upstream: now?.id === project.id ? now.upstream : this.upstreamFor(project),
          websocket: project.websocket,
          published: wasPublished(project),
          ...(this.updating.has(project.id) ? { updating: true } : {}),
          ...(project.stoppedAt ? { stopped: true } : {}),
          suffixes: entry.suffixes,
          hosts: entry.hosts,
        });
      }
      const mtaSts = input.mtaSts ?? [];
      return routes.length > 0 || mtaSts.length > 0 ? { dynamic: { askUrl: input.askUrl, routes, mtaSts } } : {};
    } catch (err) {
      onLog?.(`aviso: domínios dinâmicos indisponíveis para o proxy (${err instanceof Error ? err.message : String(err)}).\n`);
      return {};
    }
  }

  /** Certificados já emitidos pelo Caddy (leitura do armazenamento; null = não deu para ler). */
  async issuedCertificates(): Promise<Map<string, CertificateStatus> | null> {
    return this.caddy.issuedCertificates();
  }

  /** O Caddy aplicou: os pares calculados passam a valer (se falhar, a reconferência tenta de novo). */
  private async commitPairs(): Promise<void> {
    const next = this.pendingPairs;
    this.pendingPairs = null;
    if (!next) return;
    const changed = next.size !== this.lastPairs.size || [...next].some((h) => !this.lastPairs.has(h));
    this.lastPairs = next;
    // persiste só quando muda: depois de um reinício do painel, um DNS mudo mantém os redirecionamentos
    if (changed) await saveLastPairs(this.pairsFile, next);
  }

  private get pairsFile(): string {
    return path.join(this.ctx.caddyDir, "pairs.json");
  }

  private pairsLoaded: Promise<void> | null = null;

  /** Carrega, uma vez, os últimos pares aplicados (de antes do reinício do painel). */
  private ensurePairsLoaded(): Promise<void> {
    this.pairsLoaded ??= loadLastPairs(this.pairsFile).then((saved) => {
      if (this.lastPairs.size === 0) this.lastPairs = saved;
    });
    return this.pairsLoaded;
  }

  /** Pares redirecionados na última aplicação do proxy (um DNS mudo não os derruba). */
  private lastPairs = new Set<string>();
  /** Pares calculados para a aplicação em curso; só viram `lastPairs` depois que o Caddy aplicou. */
  private pendingPairs: Set<string> | null = null;

  /** Pares que o Caddy está redirecionando de fato (aplicados com sucesso). */
  appliedPairs(): ReadonlySet<string> {
    return this.lastPairs;
  }

  /**
   * Candidatos a par. Reservados (nunca tomados): endereços do painel (ativos e
   * cadastrados aguardando DNS) e os nomes do servidor de e-mail/webmail.
   */
  private async pairCandidatesFor(projects: Project[], mailNames?: string[]): Promise<PairCandidate[]> {
    const panel = this.caddy.currentPanelSite;
    const reserved = [
      ...(panel ? [panel.domain, ...(panel.aliases ?? [])] : []),
      ...(this.ctx.reservedNames?.() ?? []),
      ...(mailNames ?? (await this.mailHosts())),
    ];
    return pairCandidates(projects, reserved);
  }

  /** `{ redirects }` quando há par a redirecionar; nada quando não há (a opção só existe se usada). */
  private async redirectOptions(projects: Project[], mailNames?: string[]): Promise<{ redirects?: CaddyRedirect[] }> {
    const redirects = await this.pairRedirects(projects, mailNames);
    return redirects.length > 0 ? { redirects } : {};
  }

  /** Os pares (com/sem www) que o Caddy deve redirecionar agora; DNS que falha = sem par novo. */
  private async pairRedirects(projects: Project[], mailNames?: string[]): Promise<CaddyRedirect[]> {
    await this.ensurePairsLoaded();
    const active = await activePairs(await this.pairCandidatesFor(projects, mailNames), this.ctx.hostState, this.lastPairs);
    this.pendingPairs = new Set(active.map((r) => r.host));
    return active;
  }

  /**
   * Os pares mudaram desde a última aplicação (o DNS de um par passou a apontar,
   * ou deixou de)? Só consulta; quem decide reaplicar o proxy é o chamador.
   */
  async pairsChanged(projects: Project[]): Promise<boolean> {
    await this.ensurePairsLoaded();
    const active = await activePairs(await this.pairCandidatesFor(projects), this.ctx.hostState, this.lastPairs);
    const next = new Set(active.map((r) => r.host));
    return next.size !== this.lastPairs.size || [...next].some((h) => !this.lastPairs.has(h));
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
    if (type === "node-server") return `${project.slug}:${project.servingPort ?? nodeServerPort(project)}`;
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
    // Aplicação de página única: o nginx responde o index.html a qualquer caminho que não seja arquivo.
    // A configuração fica na pasta de trabalho do painel (fora do código) e entra só leitura.
    const spaArgs: string[] = [];
    if (project.spa === true) {
      const workDir = projectWorkDir(this.ctx, project);
      const conf = path.join(workDir, "paas.spa.conf");
      await mkdir(workDir, { recursive: true });
      await writeFileNoFollow(conf, SPA_NGINX_CONF, 0o644);
      spaArgs.push("-v", `${conf}:/etc/nginx/conf.d/default.conf:ro`);
      onLog("Aplicação de página única: caminhos que não são arquivos respondem o index.html (try_files $uri $uri/ /index.html).\n");
    }
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
      ...spaArgs,
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

  private async deployStatic(project: Project, src: string, onLog: LogFn, buildEnv: Record<string, string> = {}): Promise<string> {
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
    // Variáveis marcadas como "de build": por um arquivo de ambiente 0600 fora do código (nada no argv),
    // apagado ao fim. As demais Variáveis (segredos) não chegam ao build estático.
    const { vars, skipped } = selectBuildVars(buildEnv);
    const names = Object.keys(vars);
    const buildEnvFile = path.join(projectWorkDir(this.ctx, project), "paas.build.env");
    if (names.length > 0) {
      await mkdir(path.dirname(buildEnvFile), { recursive: true });
      await writeFileNoFollow(buildEnvFile, renderBuildEnvFile(vars), 0o600);
      onLog(`Variáveis de build (públicas: ficam no JavaScript do site): ${names.join(", ")}.${secretLookingNote(names)}\n`);
    } else {
      onLog("Nenhuma variável marcada como \"de build\": o site é construído sem variáveis do projeto (as Variáveis não vão ao build estático).\n");
    }
    for (const s of skipped) onLog(`Variável de build ${s.name} ignorada (${s.reason}).\n`);
    let code: number;
    try {
      code = await runStream(
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
          ...(names.length > 0 ? ["--env-file", buildEnvFile] : []),
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
    } finally {
      await rm(buildEnvFile, { force: true });
    }
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
    buildEnv: Record<string, string> = {},
    acceptedBlocks?: string[],
  ): Promise<string> {
    await this.assertInputsSafe(src, [project.detection?.composeFile ?? "compose.yml"]);
    const { proxyPort, composeContent, mailServices, mailNetwork } = await this.writeComposeFiles(project, src, onLog, dotenv, extraEnv, timezone, buildEnv);
    await this.assertInputsSafe(src, [".env"]);
    await this.writeComposeEnv(project, src);
    const args = this.composeArgs(project, src);
    const model = await this.assertComposeAllowed(project, src, args, onLog, guardrailOverride, mailServices, mailNetwork, acceptedBlocks);
    // o up roda do que foi conferido, não do compose do repositório (o app pode trocá-lo entre o config e o up)
    const upArgs = await this.canonicalArgs(project, src, model);
    let output = "";
    const buildTargets = composeBuildTargets(model, src);
    // build sem o buildx quebraria no meio ("requires BuildKit"): falha antes de mexer em qualquer coisa.
    // Decide por "algum serviço tem build" (inclui dockerfile_inline e contexto remoto, que ficam fora de buildTargets)
    if (composeHasBuild(model)) await this.assertBuildx(onLog);
    // o .env que o painel gravou fica fora do contexto de cada build (COPY . . não o leva para a imagem)
    const code = await this.withDotenvOutOfBuild(project, src, buildTargets, onLog, () =>
      runStream("docker", [...upArgs, "up", "-d", "--build"], (chunk) => {
        output += chunk;
        onLog(chunk);
      }, { env: buildkitEnv() }),
    );
    if (code !== 0) await this.composeUpFailed(upArgs, output, code, composeContent, onLog);
    return `${project.slug}:${proxyPort}`;
  }

  /**
   * Antes de qualquer build: o Docker precisa ter o plugin buildx. Sem ele o CLI cai no builder clássico e o build
   * quebra no meio (COPY --chmod, RUN --mount...). O plugin vem na imagem do painel (somente leitura em execução),
   * então não há como instalar aqui com segurança: falha cedo, dizendo o que fazer.
   */
  private async assertBuildx(onLog: LogFn): Promise<void> {
    const check = await checkBuildx((file, args, opts) => run(file, args, opts));
    if (check.ok) return;
    const message = check.reason === "unusable" ? BUILDX_UNUSABLE_MESSAGE : BUILDX_MISSING_MESSAGE;
    onLog(`\n✖ ${message}${check.detail ? `\n  (docker buildx: ${check.detail})` : ""}\n`);
    throw new Error(message);
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
    mailNetwork: string = PAAS_MAIL_NETWORK,
    acceptedBlocks?: string[],
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
      // caixa de teste ligada: a rede dos serviços é a do Mailpit; a do servidor de e-mail real passa a ser só do painel
      ...(mailNetwork !== PAAS_MAIL_NETWORK
        ? { mailNetwork, restrictedNetworks: [PAAS_PANEL_NETWORK, PAAS_MAIL_ADMIN_NETWORK, PAAS_MAILTEST_ADMIN_NETWORK, PAAS_MAIL_NETWORK] }
        : {}),
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
    if (acceptedBlocks) {
      const fresh = unacceptedBlocks(findings, acceptedBlocks);
      if (fresh.length > 0) {
        onLog("Deploy abortado: há bloqueios no compose resolvido que você não aceitou. Revise e aceite de novo.\n");
        throw new Error(
          `guardrail_changed: os bloqueios mudaram desde que você os aceitou. Revise e aceite de novo. Novos: ${fresh.map((f) => `[${f.rule}] ${f.evidence}`).join("; ")}`,
        );
      }
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
    const buildxHint = buildxHintFromOutput(output);
    if (buildxHint) {
      onLog(`\n✖ ${buildxHint}\n`);
      throw new Error(`docker compose up falhou: ${buildxHint}`);
    }
    // Por que falhou: estado de cada serviço, fim do log e healthcheck de
    // quem ficou unhealthy/parou (validação real: "ledger is unhealthy"
    // sem nenhuma linha do ledger no log do painel).
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
  private async composeTimezone(
    src: string,
    composeContent: string,
    dotenv: Record<string, string>,
    timezone: string | null,
    onLog: LogFn,
  ): Promise<Record<string, Record<string, string>>> {
    if (!timezone) return {};
    const root = path.resolve(src);
    // arquivos do repositório do usuário: só arquivo comum, sem seguir link e com teto de tamanho
    const files = new Map<string, string | null>();
    for (const rel of [...composeEnvFiles(composeContent), ...composeDockerfiles(composeContent)]) {
      const file = path.resolve(root, rel);
      if (!file.startsWith(root + path.sep)) continue;
      files.set(rel, (await readRegularFileLimited(file, DOCKERFILE_MAX_BYTES)) ?? null);
    }
    const definitions = composeTimezoneDefinitions(composeContent, dotenv, (rel) => files.get(rel) ?? null);
    const excluded = composeTimezoneExcluded(composeContent);
    const serviceEnv = timezoneServiceEnv(composeServiceList(composeContent), definitions, timezone, excluded);
    const names = Object.keys(serviceEnv);
    if (names.length > 0) onLog(`Fuso horário: TZ=${timezone} nos serviços ${names.join(", ")}.\n`);
    for (const e of excluded) onLog(`Fuso horário: o serviço ${e.service} (${e.image}) é banco/cache; o painel não injeta TZ.\n`);
    for (const d of definitions) {
      const where =
        d.where === "compose" ? "no compose" : d.where === "variables" ? "nas Variáveis" : d.where === "dockerfile" ? "no ENV do Dockerfile" : "num env_file";
      onLog(`Fuso horário: o serviço ${d.service} já define TZ=${d.value} (${where}); mantido.\n`);
    }
    return serviceEnv;
  }

  /**
   * `build.args` por serviço: as variáveis marcadas como "de build" que o Dockerfile de cada serviço declara
   * com ARG (as outras não chegariam ao build). Lê o Dockerfile como texto, dentro do código do projeto.
   */
  private async composeBuildArgs(
    src: string,
    model: unknown,
    buildEnv: Record<string, string>,
    onLog: LogFn,
  ): Promise<Record<string, Record<string, string>>> {
    const { vars, skipped } = selectBuildVars(buildEnv);
    const out: Record<string, Record<string, string>> = {};
    if (Object.keys(vars).length === 0 && skipped.length === 0) return out;
    for (const s of skipped) onLog(`Variável de build ${s.name} ignorada (${s.reason}).\n`);
    const root = resolveRealPath(src);
    const passed = new Set<string>();
    for (const target of composeBuildTargets(model, src)) {
      const real = resolveRealPath(target.dockerfile);
      const text = real.startsWith(root + path.sep)
        ? await readDockerfileText(path.dirname(target.dockerfile), path.basename(target.dockerfile))
        : null;
      if (text === null) continue;
      const { args } = buildArgsFor(vars, dockerfileArgNames(text));
      if (Object.keys(args).length === 0) continue;
      out[target.service] = args;
      for (const name of Object.keys(args)) passed.add(name);
      onLog(`Variáveis de build (públicas) passadas ao build do serviço ${target.service} como args: ${Object.keys(args).join(", ")}.${secretLookingNote(Object.keys(args))}\n`);
    }
    const lost = Object.keys(vars).filter((n) => !passed.has(n));
    if (lost.length > 0) {
      onLog(`Marcadas como "de build" mas nenhum Dockerfile do compose declara ARG para: ${lost.join(", ")} (não foram passadas ao build).\n`);
    }
    return out;
  }

  /** Gera o paas.override.yml e o .env do compose (deploy e reinício com a configuração nova). */
  private async writeComposeFiles(
    project: Project,
    src: string,
    onLog: LogFn,
    dotenv: Record<string, string>,
    extraEnv: Record<string, string>,
    timezone: string | null,
    buildEnv: Record<string, string> = {},
  ): Promise<{ proxyPort: number; composeContent: string; mailServices: string[]; mailNetwork: string }> {
    const composeFile = project.detection?.composeFile;
    if (!composeFile) throw new Error("Nenhum arquivo compose detectado.");
    const proxyService = project.proxyService ?? project.detection?.proxyService;
    if (!proxyService) throw new Error("Informe o serviço web do compose (proxyService).");
    const proxyPort = project.proxyPort ?? project.detection?.proxyPort;
    if (!proxyPort) throw new Error("Informe a porta do serviço web (proxyPort).");

    // Override gerado pelo painel (compose-override.ts): NÃO reescreve o
    // compose do usuário; anexa o serviço web à rede paas-net, injeta env
    // extra (Fase 3 — SMTP) e, em app comum, retira a publicação de 80/443.
    const wantsEnv = Object.keys(extraEnv).length > 0;
    const rawServices = wantsEnv ? await composeServiceNames(src, composeFile) : [];
    // e-mail habilitado (SMTP_HOST injetado): esses serviços entram na rede de e-mail, a única que alcança o Stalwart (A4)
    // Quem usa `network_mode` não pode ter `networks` (o compose recusa): o dono do namespace entra no lugar.
    const composeContent = await readFile(path.join(src, composeFile), "utf8");
    // modelo resolvido SEM o override (merge, extends e include aplicados): decide quem tem network_mode.
    // O compose só lê o ambiente depois da checagem do .env (nunca segue link, A2).
    const workDirEnv = projectWorkDir(this.ctx, project);
    await mkdir(workDirEnv, { recursive: true });
    const env = await writeProjectDotenv(src, workDirEnv, dotenv);
    await this.assertInputsSafe(src, [".env"]);
    await this.writeComposeEnv(project, src);
    const pre = await loadCanonicalCompose(this.composeArgs(project, src, false));
    const resolved = pre.ok ? pre.model : undefined;
    // Serviços vindos de `include:`/`extends` só existem no modelo resolvido: as variáveis injetadas (e-mail, caixa de teste)
    // valem para o modelo inteiro, não só para o que está escrito no arquivo principal.
    const allServices = wantsEnv ? [...new Set([...rawServices, ...resolvedServiceNames(resolved)])] : [];
    // com e-mail habilitado, banco e cache não entram na rede de e-mail (compartilhada entre projetos) nem recebem o SMTP_*
    const mailSelection = extraEnv.SMTP_HOST
      ? selectMailServices(composeContent, allServices, resolved, await composeBuildBaseImages(composeContent, resolved, src))
      : null;
    const envServices = mailSelection ? mailSelection.included : allServices;
    const mailPlan = mailSelection ? mailNetworkTargets(composeContent, envServices, resolved) : null;
    const mailServices = mailPlan?.targets ?? [];
    const mailDecisions: Record<string, "in" | "out"> = {};
    for (const s of mailSelection?.included ?? []) mailDecisions[s] = "in";
    for (const e of mailSelection?.excluded ?? []) mailDecisions[e.service] = "out";
    // caixa de teste ligada: os serviços entram na rede interna do Mailpit, não na do servidor de e-mail real
    const mailNetwork = await this.mailNetworkOf(project);
    // com a caixa de teste ligada o conjunto tem de chegar a todos os serviços, inclusive os de include:/extends: sem o
    // modelo resolvido não há como saber quais são, e usar só o arquivo cru deixaria serviços com o SMTP de antes
    if (mailNetwork !== PAAS_MAIL_NETWORK && !pre.ok) {
      // a causa real primeiro: variável obrigatória (${VAR:?}) sem valor é o motivo mais comum e tem lista própria
      if (pre.missing.length > 0) throw this.missingVariablesError(pre.missing);
      throw new Error(
        `a caixa de teste de e-mail está ligada, mas o docker compose não conseguiu montar o modelo do compose (${pre.error.split("\n")[0] ?? "erro desconhecido"}). ` +
          "O deploy foi interrompido para o e-mail não sair por um serviço sem o SMTP da caixa.",
      );
    }
    if (mailServices.length > 0) await this.ensureMailNetwork(mailNetwork);

    const workDir = projectWorkDir(this.ctx, project);
    await mkdir(workDir, { recursive: true });
    const overrideFile = path.join(workDir, "paas.override.yml");
    const overrideYaml = composeOverrideYaml({
      compose: composeContent,
      proxyService,
      slug: project.slug,
      network: PAAS_NETWORK,
      mailNetwork,
      mailServices,
      mailDecisions,
      ...(resolved !== undefined ? { resolved } : {}),
      env: extraEnv,
      envServices,
      ...(project.portOverrides ? { portOverrides: project.portOverrides } : {}),
      serviceEnv: await this.composeTimezone(src, composeContent, dotenv, timezone, onLog),
      buildArgs: await this.composeBuildArgs(src, resolved, buildEnv, onLog),
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
    if (mailPlan) {
      if (mailServices.length > 0) onLog(`Rede de e-mail ${mailNetwork}${mailNetwork === PAAS_MAIL_NETWORK ? "" : " (caixa de teste)"} ligada em: ${mailServices.join(", ")}.\n`);
      for (const name of mailSelection?.forced ?? []) {
        onLog(`E-mail: ${name} é banco/cache, mas a label ${TWS_LABEL_MAIL}=true o mantém na rede de e-mail.\n`);
      }
      for (const e of mailSelection?.excluded ?? []) {
        const hint = e.decision.reason === "database-image" || e.decision.reason === "database-build" ? ` Para ligá-lo, ponha a label ${TWS_LABEL_MAIL}=true no serviço.` : "";
        onLog(`Rede de e-mail: ${e.service} fora (${mailExclusionText(e.decision)}); não recebe o SMTP_* e não alcança o servidor de e-mail.${hint}\n`);
      }
      for (const b of mailSelection?.badLabels ?? []) {
        onLog(`Aviso: ${b.service}: a label ${TWS_LABEL_MAIL}="${b.value}" não vale (use true ou false); a regra automática foi mantida.\n`);
      }
      const byOwner = new Map<string, string[]>();
      for (const [name, owner] of Object.entries(mailPlan.delegated)) byOwner.set(owner, [...(byOwner.get(owner) ?? []), name]);
      for (const [owner, names] of byOwner) {
        onLog(`E-mail: ${names.join(", ")} compartilham a rede de ${owner} (network_mode) e usam a dela para alcançar o servidor de e-mail.\n`);
      }
      for (const name of mailPlan.skipped) {
        onLog(`Aviso: ${name}: network_mode sem rede própria (host, none, container: ou serviço inexistente) — não alcança o servidor de e-mail.\n`);
      }
    }

    // Variáveis do projeto → .env do compose (interpolação ${VAR} e env_file).
    const dotenvKeys = Object.keys(dotenv);
    if (dotenvKeys.length > 0) {
      onLog(
        env.target === "paas.env"
          ? `Variáveis gravadas em ${path.join(workDir, "paas.env")} e passadas ao compose com --env-file (${dotenvKeys.join(", ")}); o .env da pasta do projeto NÃO foi alterado.\n`
          : `Variáveis gravadas no .env do projeto (${dotenvKeys.join(", ")}).\n`,
      );
    }
    if (env.note) onLog(`Aviso: ${env.note}\n`);
    return { proxyPort, composeContent, mailServices, mailNetwork };
  }

  /**
   * Alinha os containers JÁ rodando de um projeto com e-mail à rede de e-mail.
   * Migração (A4): o Stalwart sai da paas-net, e o projeto só o alcançaria
   * depois do próximo deploy. A regra NÃO é recalculada aqui: vale o carimbo
   * `tws.mail.decided` (in/out) que o deploy gravou no container pelo override.
   *  - `out`: desliga das redes de e-mail (a do projeto, pela qual o banco fala com o app, nunca é tocada, e só se
   *    desliga quem continua com ao menos uma rede que não é de e-mail);
   *  - `in` e sem carimbo (deploy anterior a esta regra) com imagem que não é de banco/cache: liga (o Stalwart sai da
   *    paas-net depois, e quem ficasse sem a rede de e-mail perderia o SMTP até o próximo deploy);
   *  - sem carimbo com imagem de banco/cache: desliga.
   * Devolve quantos containers foram ligados.
   */
  async joinMailNetwork(project: Project, onLog: LogFn = () => {}): Promise<number> {
    const ids = await this.projectContainers(project);
    if (ids.length === 0) return 0;
    const network = await this.mailNetworkOf(project);
    await this.ensureMailNetwork(network);
    let joined = 0;
    for (const id of ids) {
      const info = await this.inspectForMail(id);
      if (!info) continue;
      // container que usa a rede de outro (container:/host/none) não aceita `network connect`: o dono dela é ligado
      if (/^(container:|host$|none$)/.test(info.mode)) continue;
      const name = info.service || id;
      if (info.decided === "out" || (info.decided === "" && isDatabaseImage(info.image))) {
        await this.leaveMailNetworks(id, name, info.networks, new Set([network, PAAS_MAIL_NETWORK]), onLog);
        continue;
      }
      // sem carimbo e sem imagem de banco (deploy anterior a esta regra): liga como sempre — o Stalwart sai da paas-net
      // logo depois e quem ficasse de fora perderia o SMTP até o próximo deploy
      const join = await run("docker", ["network", "connect", network, id]);
      if (join.code !== 0 && !/already exists|already connected/i.test(join.stderr)) {
        throw new Error(`falha ao ligar ${id} à rede ${network}: ${join.stderr.trim()}`);
      }
      joined++;
    }
    return joined;
  }

  /** Lê do container o que a rede de e-mail precisa (JSON do próprio docker, sem separadores no texto); null = não deu. */
  private async inspectForMail(id: string): Promise<{ mode: string; image: string; decided: string; service: string; networks: string[] } | null> {
    const res = await run("docker", [
      "inspect",
      "-f",
      `{"mode":{{json .HostConfig.NetworkMode}},"image":{{json .Config.Image}},"decided":{{json (index .Config.Labels "${TWS_LABEL_MAIL_DECIDED}")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"networks":{{json .NetworkSettings.Networks}}}`,
      id,
    ]);
    if (res.code !== 0) return null;
    try {
      const o = JSON.parse(res.stdout) as { mode?: unknown; image?: unknown; decided?: unknown; service?: unknown; networks?: unknown };
      const text = (v: unknown): string => (typeof v === "string" ? v : "");
      const nets = o.networks && typeof o.networks === "object" ? Object.keys(o.networks) : [];
      return { mode: text(o.mode), image: text(o.image), decided: text(o.decided), service: text(o.service), networks: nets };
    } catch {
      return null;
    }
  }

  /** Desliga o container das redes de e-mail, sempre deixando-o com ao menos uma rede que não é de e-mail. */
  private async leaveMailNetworks(id: string, name: string, attachedNow: string[], mailNets: Set<string>, onLog: LogFn): Promise<void> {
    const isMail = (n: string) => mailNets.has(n) || n.startsWith("paas-mailtest");
    let attached = [...attachedNow];
    if (attached.length > 0 && attached.every(isMail)) {
      onLog(`Aviso: ${name} só tem rede de e-mail (${attached.join(", ")}) e deveria ficar fora dela; não desliguei para não isolá-lo. Faça um novo deploy.\n`);
      return;
    }
    for (const net of mailNets) {
      if (!attached.includes(net)) continue;
      const remaining = attached.filter((n) => n !== net);
      if (!remaining.some((n) => !isMail(n))) continue;
      const leave = await run("docker", ["network", "disconnect", net, id]);
      if (leave.code !== 0 && !/not connected|no such network|no such container|not found/i.test(leave.stderr)) {
        throw new Error(`falha ao desligar ${id} da rede ${net}: ${leave.stderr.trim()}`);
      }
      attached = remaining;
      onLog(`Rede de e-mail: ${name} saiu de ${net} (deve ficar fora da rede de e-mail).\n`);
    }
  }

  /**
   * A rede de e-mail do projeto: a do servidor de e-mail real ou, com a caixa de teste ligada, a rede
   * interna do Mailpit (o provedor sobe o Mailpit antes de devolvê-la).
   */
  private async mailNetworkOf(project: Project): Promise<string> {
    return (await this.ctx.mailTestForProject?.(project))?.network ?? PAAS_MAIL_NETWORK;
  }

  /** Garante a rede de e-mail (idempotente): `compose up` com rede externa inexistente falharia. */
  private async ensureMailNetwork(name: string = PAAS_MAIL_NETWORK): Promise<void> {
    const inspect = await run("docker", ["network", "inspect", "-f", "{{.Internal}}", name]);
    if (inspect.code === 0) {
      // a do Mailpit nunca tem saída para fora: uma com esse nome que tenha é recriada (ou o deploy para)
      if (name === PAAS_MAIL_NETWORK || inspect.stdout.trim() === "true") return;
      const gone = await run("docker", ["network", "rm", name]);
      if (gone.code !== 0) throw new Error(`a rede ${name} existe e não é interna (tem saída para a internet) e não pôde ser recriada: ${gone.stderr.trim()}`);
    }
    const internal = name === PAAS_MAIL_NETWORK ? [] : ["--internal"];
    const create = await run("docker", ["network", "create", ...internal, "--label", `${PAAS_LABEL_MANAGED}=true`, name]);
    if (create.code !== 0) throw new Error(`falha ao criar a rede ${name}: ${create.stderr.trim()}`);
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
      const { composeContent, mailServices, mailNetwork } = await this.writeComposeFiles(
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
      const model = await this.assertComposeAllowed(project, src, args, onLog, false, mailServices, mailNetwork);
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
    if (type === "node-server") {
      // Depois de um deploy revertido a versão no ar é a ANTIGA, mas a imagem `:latest` é a nova (que não ficou
      // saudável): recriar subiria justamente a versão que falhou, numa porta que o proxy não usa.
      if (project.servingPort != null) {
        throw new Error(
          `A última implantação foi revertida e o site segue na versão anterior (porta ${project.servingPort}). ` +
            "Recriar subiria a versão que falhou: faça um deploy que fique saudável para publicar a nova versão.",
        );
      }
      const image = `paas-${project.slug}:latest`;
      const inspect = await run("docker", ["image", "inspect", image]);
      if (inspect.code !== 0) throw new Error("a imagem do projeto não existe mais no servidor. Faça um deploy para construir de novo.");
      await this.runNodeServerContainer(project, image, onLog, extraEnv, timezone);
      return;
    }
    onLog("Site estático: o servidor web não usa fuso horário; nada a recriar.\n");
  }

  private composeArgs(project: Project, src: string, withOverride = true): string[] {
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
      ...(withOverride ? ["-f", overrideFile] : []),
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
    buildEnv: Record<string, string> = {},
  ): Promise<string> {
    const image = `paas-${project.slug}:latest`;
    const port = project.proxyPort ?? project.detection?.proxyPort;
    if (!port) throw new Error("Informe a porta exposta pelo container (proxyPort).");

    // Variáveis marcadas como "de build" que o Dockerfile declara com ARG viram --build-arg (só as marcadas)
    const { vars, skipped } = selectBuildVars(buildEnv);
    for (const s of skipped) onLog(`Variável de build ${s.name} ignorada (${s.reason}).\n`);
    const { args: buildArgs, notDeclared } = buildArgsFor(vars, dockerfileArgNames((await readDockerfileText(src)) ?? ""));
    const buildArgNames = Object.keys(buildArgs);
    if (buildArgNames.length > 0) {
      onLog(`Variáveis de build (públicas) passadas como --build-arg: ${buildArgNames.join(", ")}.${secretLookingNote(buildArgNames)}\n`);
    }
    if (notDeclared.length > 0) {
      onLog(`Marcadas como "de build" mas o Dockerfile não declara ARG para: ${notDeclared.join(", ")} (não foram passadas ao build).\n`);
    }

    // Projeto que já foi compose: o .env que o painel gravou na época não pode ir para o contexto do build
    if (await removePanelDotenv(src, projectWorkDir(this.ctx, project))) {
      onLog("Removido do código o .env que o painel gravou (de quando o projeto era compose): as Variáveis deste projeto vão só ao container, na execução.\n");
    }
    await this.assertBuildx(onLog);
    const buildTail = new TailBuffer();
    const buildCode = await this.withDotenvOutOfBuild(
      project,
      src,
      [{ context: src, dockerfile: path.join(src, "Dockerfile") }],
      onLog,
      // BuildKit: é ele que lê o <Dockerfile>.dockerignore; sem o plugin buildx o build falha em vez de ignorar a exclusão
      () =>
        runStream(
          "docker",
          ["build", "-t", image, ...buildArgNames.flatMap((n) => ["--build-arg", `${n}=${buildArgs[n]!}`]), src],
          (chunk) => {
            buildTail.push(chunk);
            onLog(chunk);
          },
          { env: { ...process.env, ...buildkitEnv() } },
        ),
    );
    if (buildCode !== 0) {
      const hint = buildxHintFromOutput(buildTail.toString());
      if (hint) onLog(`\n✖ ${hint}\n`);
      throw new Error(hint ? `docker build falhou: ${hint}` : `docker build falhou (exit ${buildCode}).`);
    }

    await this.runDockerfileContainer(project, image, onLog, extraEnv, timezone);
    return `${project.slug}:${port}`;
  }

  /**
   * Roda `build` com o `.env` gravado pelo painel FORA do contexto dos builds cujo contexto é a própria
   * pasta do código (build-context.ts). Restaura o estado anterior dos arquivos de ignore sempre, e o
   * `.dockerignore` do usuário nunca é apagado. Sem `.env` do painel na pasta, não toca em nada.
   */
  private async withDotenvOutOfBuild<T>(
    project: Project,
    src: string,
    targets: ReadonlyArray<{ context: string; dockerfile: string }>,
    onLog: LogFn,
    build: () => Promise<T>,
  ): Promise<T> {
    const workDir = projectWorkDir(this.ctx, project);
    const root = resolveRealPath(src);
    // serviços que compartilham o mesmo Dockerfile contam uma vez só
    const seen = new Set<string>();
    const own = targets.filter((t) => {
      const key = resolveRealPath(t.dockerfile);
      if (resolveRealPath(t.context) !== root || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // o build vale como ativo ANTES de qualquer espera: uma recuperação que chegue agora não mexe nele
    this.activeBuilds.add(workDir);
    const buildId = randomUUID();
    const restores: Array<() => Promise<void>> = [];
    try {
      // a recuperação da subida do painel que já estava em andamento termina antes de este build começar
      await this.recoveries.get(workDir);
      // sobra de um build interrompido antes deste (queda do painel): restaura primeiro
      for (const message of await restoreIgnoreJournal(workDir)) onLog(`Restauração do .dockerignore de um build interrompido falhou (${message}).\n`);
      if (own.length > 0 && (await hasPanelDotenv(src))) {
        for (const t of own) restores.push(await excludePanelDotenv(t.context, t.dockerfile, workDir, onLog, buildId));
        onLog(
          "O .env gravado pelo painel (suas Variáveis) fica fora do contexto do build: um `COPY . .` não o leva para a imagem. " +
            "Foi usado um .dockerignore mesclado só durante o build; o seu não foi alterado.\n",
        );
      } else {
        for (const t of own) {
          if (await ownDotenvInContext(t.context, t.dockerfile)) {
            onLog("Aviso: o .env do seu repositório entra no contexto do build e nenhum .dockerignore o exclui. Se ele tiver segredo, exclua-o no .dockerignore (o painel não mexe nele).\n");
            break;
          }
        }
      }
      return await build();
    } finally {
      // cada restauração tem o seu try/catch: uma que falha não esconde o erro do build nem impede as outras
      for (const restore of restores.reverse()) {
        try {
          await restore();
        } catch (err) {
          onLog(`Não foi possível restaurar um arquivo de ignore do build (${err instanceof Error ? err.message : String(err)}); o painel tenta de novo no próximo build.\n`);
        }
      }
      this.activeBuilds.delete(workDir);
    }
  }

  /** Subida do painel: restaura o que um build interrompido deixou nos arquivos de ignore do projeto. */
  async recoverBuildLeftovers(project: Project): Promise<string[]> {
    const workDir = projectWorkDir(this.ctx, project);
    // um build deste projeto já está rodando: o diário é dele, não uma sobra
    if (this.activeBuilds.has(workDir)) return [];
    const recovery = restoreIgnoreJournal(workDir);
    this.recoveries.set(workDir, recovery);
    try {
      return await recovery;
    } finally {
      this.recoveries.delete(workDir);
    }
  }

  /** Sobe (ou recria) o container do pipeline Dockerfile. */
  private async runDockerfileContainer(
    project: Project,
    image: string,
    onLog: LogFn,
    extraEnv: Record<string, string>,
    timezone: string | null,
    extra: { forcedEnv?: Record<string, string>; runArgs?: string[]; keepPrevious?: boolean; mailNetwork?: string } = {},
  ): Promise<void> {
    const app = `${containerPrefix(project)}-app`;
    // com a caixa de teste ligada, o Mailpit sobe ANTES do app (e antes de qualquer mudança no que está no ar)
    const mailNetwork = extra.mailNetwork ?? (await this.mailNetworkOf(project));
    if (extra.keepPrevious) {
      // o antigo só é parado e renomeado: se o novo falhar, volta (rollbackNodeServer)
      const previous = this.previousName(project);
      await run("docker", ["rm", "-f", previous]);
      if ((await run("docker", ["rename", app, previous])).code === 0) {
        await run("docker", ["stop", previous], { timeoutMs: 120_000 });
        onLog("Container anterior parado e guardado até a nova versão responder (se ela falhar, ele é religado).\n");
      }
    } else {
      await run("docker", ["rm", "-f", app]);
    }
    const envArgs: string[] = [];
    for (const [key, value] of Object.entries(extraEnv)) {
      envArgs.push("-e", `${key}=${value}`);
    }
    if (timezone) {
      // TZ nas Variáveis do projeto vence a escolha do painel.
      const imageTz = project.detection?.type === "dockerfile" ? dockerfileEnvTz((await readDockerfileText(projectSrcDir(this.ctx, project))) ?? "") : undefined;
      if (extraEnv.TZ) onLog(`Fuso horário: o projeto já define TZ=${extraEnv.TZ} nas Variáveis; mantido.\n`);
      else if (imageTz !== undefined) onLog(`Fuso horário: o Dockerfile já define ENV TZ=${imageTz}; mantido.\n`);
      else {
        envArgs.push("-e", `TZ=${timezone}`);
        onLog(`Fuso horário: TZ=${timezone}.\n`);
      }
    }
    // o que o painel exige do ambiente (ex.: PORT do Next.js) vem por último e vence as Variáveis
    for (const [key, value] of Object.entries(extra.forcedEnv ?? {})) envArgs.push("-e", `${key}=${value}`);
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
      ...(extraEnv.SMTP_HOST ? ["--label", `${TWS_LABEL_MAIL_DECIDED}=in`] : []),
      ...CONTAINER_HARDENING,
      ...(extra.runArgs ?? []),
      image,
    ]);
    if (runRes.code !== 0) throw new Error(`falha ao subir o container: ${runRes.stderr}`);
    onLog(`Container ${app} rodando na rede ${PAAS_NETWORK}.\n`);
    if (extraEnv.SMTP_HOST) {
      await this.ensureMailNetwork(mailNetwork);
      const join = await run("docker", ["network", "connect", mailNetwork, app]);
      if (join.code !== 0) throw new Error(`falha ao ligar ${app} à rede ${mailNetwork}: ${join.stderr.trim()}`);
      onLog(`Container ${app} ligado à rede de e-mail ${mailNetwork}${mailNetwork === PAAS_MAIL_NETWORK ? "" : " (caixa de teste)"}.\n`);
    }
  }

  // -------------------------------------------------------------------------
  // Pipeline: node-server (Next.js com servidor; Dockerfile gerado pelo painel)
  // -------------------------------------------------------------------------

  private async deployNodeServer(
    project: Project,
    src: string,
    onLog: LogFn,
    extraEnv: Record<string, string>,
    timezone: string | null,
  ): Promise<string> {
    const info = await inspectNextApp(src);
    if (!info?.hasNext) {
      throw new Error(
        "O código não tem mais a dependência next no package.json. Rode a detecção de novo (ou use um Dockerfile) antes de fazer o deploy.",
      );
    }
    if (info.output === "export") {
      throw new Error(
        'O next.config agora usa output: "export" (site estático). Rode a detecção de novo para o painel publicar como site estático.',
      );
    }
    if (existsSync(path.join(src, "Dockerfile"))) {
      onLog("Aviso: há um Dockerfile no repositório, mas o projeto está como Next.js (servidor): o painel usa o Dockerfile DELE. Rode a detecção para usar o seu.\n");
    }
    if (await removePanelDotenv(src, projectWorkDir(this.ctx, project))) {
      onLog("Removido do código o .env que o painel gravou (de quando o projeto era compose). Arquivos .env nunca entram no build: as Variáveis vão por argumento (NEXT_PUBLIC_) e segredo.\n");
    }
    for (const note of info.notes) onLog(`${note}\n`);
    onLog(
      `Next.js · ${info.packageManager}${info.lockfile ? ` (${info.lockfile}, instalação congelada)` : " (sem lockfile: instalação não reprodutível)"} · ` +
        `${info.output === "standalone" ? "standalone (node server.js)" : "next start"} · Node ${info.nodeMajor}.\n`,
    );

    // antes de preparar: prepareNextBuild grava o arquivo de segredos (paas.next.build.env), que só o bloco do build apaga
    await this.assertBuildx(onLog);
    const image = `paas-${project.slug}:latest`;
    const prepared = await prepareNextBuild({
      slug: project.slug,
      workDir: projectWorkDir(this.ctx, project),
      src,
      image,
      nodeMajor: info.nodeMajor,
      packageManager: info.packageManager,
      yarnBerry: info.yarnBerry,
      lockfile: info.lockfile !== null,
      standalone: info.output === "standalone",
      hasBuildScript: info.hasBuildScript,
      port: nodeServerPort(project),
      vars: extraEnv,
      totalMemBytes: (this.ctx.totalMemBytes ?? totalmem)(),
    });
    for (const note of prepared.notes) onLog(`${note}\n`);
    onLog("Dockerfile gerado fora do seu repositório (nada é gravado no código do projeto).\n");

    const tail = new TailBuffer();
    let code: number;
    try {
      code = await runStream(
        "docker",
        prepared.args,
        (chunk) => {
          tail.push(chunk);
          onLog(chunk);
        },
        { env: { ...process.env, ...buildkitEnv() } },
      );
    } finally {
      await prepared.cleanup();
    }
    if (code !== 0) {
      const hint = buildxHintFromOutput(tail.toString());
      if (hint) {
        onLog(`\n✖ ${hint}\n`);
        throw new Error(`build do Next.js falhou: ${hint}`);
      }
      const failure = explainBuildFailure(tail.toString(), { heapMb: prepared.heapMb, packageManager: info.packageManager });
      if (failure) onLog(`\n✖ ${failure.message}\n`);
      throw new Error(failure ? `build do Next.js falhou: ${failure.message}` : `build do Next.js falhou (exit ${code}).`);
    }
    await this.runNodeServerContainer(project, image, onLog, extraEnv, timezone, true);
    return `${project.slug}:${nodeServerPort(project)}`;
  }

  private previousName(project: Project): string {
    return `${containerPrefix(project)}-app-previous`;
  }

  /** Deploy no ar e saudável: o container antigo (parado) sai, e só então a imagem anterior pode ser podada. */
  private async finishNodeServer(project: Project, onLog: LogFn): Promise<void> {
    await run("docker", ["rm", "-f", this.previousName(project)]);
    await this.pruneBuildLeftovers(project, onLog);
  }

  /**
   * Boot do painel, depois de um deploy que o reinício do painel interrompeu. Devolve o que de fato aconteceu com o site:
   * - `restored`: o container novo não estava de pé e o anterior (guardado parado como `-app-previous`, Next.js) foi religado;
   * - `running`: o container do projeto está rodando (nada a restaurar; a versão em execução pode ser a nova, não confirmada);
   * - `down`: não há container rodando e não há anterior para religar (Dockerfile/estático já removeram o antigo): só um novo deploy resolve;
   * - `skipped`: compose (o `up` não remove o que já roda), projeto parado de propósito ou sem tipo detectado.
   */
  async recoverInterruptedDeploy(
    project: Project,
    onLog: LogFn,
    /** Início do job interrompido: só um `-app-previous` parado depois disso pertence a ele. */
    jobStartedAt?: string | null,
  ): Promise<{ outcome: "restored"; port: number } | { outcome: "running" | "down" | "skipped" }> {
    const type = project.detection?.type;
    if (!type || type === "compose" || project.stoppedAt) return { outcome: "skipped" };
    const prefix = containerPrefix(project);
    const isWeb = type === "static" || type === "static-node";
    const main = isWeb ? `${prefix}-web` : `${prefix}-app`;
    const running = async (name: string): Promise<boolean> => {
      const r = await run("docker", ["inspect", "-f", "{{.State.Running}}", name]);
      return r.code === 0 && r.stdout.trim() === "true";
    };
    if (await running(main)) return { outcome: "running" };
    if (!isWeb) {
      const prev = await run("docker", ["inspect", "-f", "{{.State.FinishedAt}}", this.previousName(project)]);
      if (prev.code === 0) {
        // o `docker stop` do deploy interrompido carimba FinishedAt: um anterior parado ANTES do job começar é sobra de outro deploy
        const stoppedAt = Date.parse(prev.stdout.trim());
        const startedAt = jobStartedAt ? Date.parse(jobStartedAt) : NaN;
        if (Number.isFinite(stoppedAt) && Number.isFinite(startedAt) && stoppedAt >= startedAt) {
          onLog("Container anterior encontrado parado (o deploy foi interrompido): religando-o.\n");
          const port = await this.rollbackNodeServer(project, onLog);
          if (port !== null) return { outcome: "restored", port };
        } else {
          onLog("Há um container anterior parado, mas ele não é deste deploy (sobra de outro): não foi religado. Faça o deploy de novo.\n");
        }
      }
    }
    return { outcome: "down" };
  }

  /** O novo container não subiu ou o site não respondeu: remove o novo e religa o antigo. */
  private async rollbackNodeServer(project: Project, onLog: LogFn): Promise<number | null> {
    const app = `${containerPrefix(project)}-app`;
    const previous = this.previousName(project);
    await run("docker", ["rm", "-f", app]);
    const renamed = await run("docker", ["rename", previous, app]);
    if (renamed.code !== 0) {
      onLog("✖ O deploy falhou e não havia versão anterior para religar: o projeto fica sem container no ar.\n");
      return null;
    }
    const started = await run("docker", ["start", app]);
    onLog(
      started.code === 0
        ? "↩ O novo container não ficou saudável: a versão anterior foi religada e o site continua no ar com ela.\n"
        : `✖ O novo container não ficou saudável e não consegui religar a versão anterior (${started.stderr.trim()}). Faça um deploy de novo.\n`,
    );
    if (started.code !== 0) return null;
    // a porta em que a versão antiga escuta (PORT do container): o proxy precisa voltar para ela
    const env = await run("docker", ["inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", app]);
    const match = env.code === 0 ? /^PORT=(\d+)$/m.exec(env.stdout) : null;
    // sem PORT legível (container de versão antiga do painel): vale a porta configurada, mas o rollback fica registrado
    return match ? Number(match[1]) : nodeServerPort(project);
  }

  /**
   * Limpeza depois de um deploy bom (melhor esforço, nunca falha o deploy):
   * a imagem anterior deste projeto (agora sem nome e sem container) e o cache do BuildKit com mais
   * de 7 dias. O cache de dependências é por projeto e cresce com o uso: esta é a
   * poda automática; a manual está em "docker builder prune" (ver o guia).
   */
  private async pruneBuildLeftovers(project: Project, onLog: LogFn): Promise<void> {
    const images = await run("docker", ["image", "prune", "-f", "--filter", `label=${PAAS_LABEL_PROJECT}=${project.slug}`]);
    const cache = await run("docker", ["builder", "prune", "-f", "--filter", "until=168h"]);
    if (images.code !== 0 || cache.code !== 0) {
      onLog("Aviso: não consegui limpar imagens antigas ou o cache de build (sem efeito no deploy).\n");
    } else {
      onLog("Limpeza: imagem anterior do projeto (sem uso) e cache de build com mais de 7 dias removidos.\n");
    }
  }

  /** Sobe (ou recria) o container do Next.js: usuário não-root da imagem, sem capabilities, PORT/HOSTNAME do painel. */
  private async runNodeServerContainer(
    project: Project,
    image: string,
    onLog: LogFn,
    extraEnv: Record<string, string>,
    timezone: string | null,
    keepPrevious = false,
  ): Promise<void> {
    const port = nodeServerPort(project);
    if (extraEnv.PORT !== undefined && extraEnv.PORT !== String(port)) {
      onLog(`Aviso: a variável PORT=${extraEnv.PORT} foi ignorada. O servidor escuta na porta do projeto (${port}); para mudar, use o campo Porta do projeto.\n`);
    }
    // O Mailpit (ou a falha dele) é resolvido ANTES de tocar no container que está no ar: se ele não sobe, o deploy
    // para aqui, sem rollback (nada foi alterado) e o site continua exatamente como estava.
    const mailNetwork = await this.mailNetworkOf(project);
    try {
      await this.runDockerfileContainer(project, image, onLog, extraEnv, timezone, {
        forcedEnv: { PORT: String(port), HOSTNAME: "0.0.0.0", NODE_ENV: "production" },
        runArgs: ["--init", "--cap-drop", "ALL"],
        keepPrevious,
        mailNetwork,
      });
    } catch (err) {
      if (keepPrevious) {
        const restoredPort = await this.rollbackNodeServer(project, onLog);
        // o docker run do novo falhou: o antigo voltou na porta dele, e o proxy (reaplicado por qualquer
        // outro motivo) precisa continuar nela
        if (restoredPort !== null) {
          project.servingPort = restoredPort;
          if (restoredPort !== port) {
            onLog(`Aviso: a Porta configurada (${port}) não está em uso: o site segue na ${restoredPort}, da versão anterior, até um deploy bem-sucedido.\n`);
          }
        }
      }
      throw err;
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
      '{{.ID}} {{.Names}} {{.Label "com.docker.compose.project"}}',
    ]);
    if (direct.code === 0) {
      for (const line of lines(direct.stdout)) {
        const [id, name, owner] = line.split(/\s+/);
        // o `-previous` (versão antiga guardada durante o deploy) nunca é do projeto: iniciá-lo
        // junto com o novo dividiria as visitas entre as duas versões (mesmo alias de rede)
        if (id && !owner && name !== this.previousName(project)) ids.add(id);
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
    await run("docker", ["rm", "-f", this.previousName(project)]);
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
/** Nomes dos serviços do modelo resolvido do compose (include, extends e merge aplicados). */
function resolvedServiceNames(model: unknown): string[] {
  const services = (model as { services?: unknown } | undefined)?.services;
  return typeof services === "object" && services !== null ? Object.keys(services) : [];
}

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
