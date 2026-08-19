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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import {
  PAAS_LABEL_MANAGED,
  PAAS_LABEL_PROJECT,
  PAAS_NETWORK,
  type Project,
} from "@paas/core";
import { parse, stringify } from "yaml";
import { CaddyManager, projectDomain } from "./caddy.js";
import { run, runStream } from "./exec.js";
import { ingestCode, projectSrcDir, projectWorkDir, type IngestContext } from "./ingest.js";
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
  /**
   * Env vars extras por projeto (Fase 3 — injeção SMTP). Chamado no início de
   * cada deploy; o mapa é injetado no compose override (todos os serviços) ou
   * via -e no pipeline dockerfile. undefined = nenhuma injeção.
   */
  envForProject?: (project: Project) => Promise<Record<string, string>>;
}

export type LogFn = (chunk: string) => void;

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
    this.caddy = new CaddyManager(ctx.caddyDir, undefined, {
      http: ctx.caddyHttpPort,
      https: ctx.caddyHttpsPort,
    });
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
    opts?: { guardrailOverride?: boolean },
  ): Promise<void> {
    const type = project.detection?.type;
    if (!type || type === "unknown") {
      throw new Error("Tipo de projeto desconhecido — rode a detecção antes do deploy.");
    }

    onLog(`\n=== Etapa 1/5 · Ingestão do código (${project.ingestMode}) ===\n`);
    const src = await ingestCode(this.ctx, project, onLog);

    onLog("\n=== Guardrails de segurança (Fase 4) ===\n");
    const report = await runGuardrails(src);
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
      case "static-node":
        onLog("\n=== Etapa 3/5 · Build estático (container Node) ===\n");
        if (envKeys.length > 0) {
          onLog("Nota: site estático não recebe env vars de runtime (injeção ignorada).\n");
        }
        upstream = await this.deployStatic(project, src, onLog);
        break;
      case "compose":
        onLog("\n=== Etapa 3/5 · docker compose up (compose adotado) ===\n");
        upstream = await this.deployCompose(project, src, onLog, extraEnv);
        break;
      case "dockerfile":
        onLog("\n=== Etapa 3/5 · docker build (Dockerfile) ===\n");
        upstream = await this.deployDockerfile(project, src, onLog, extraEnv);
        break;
    }

    onLog("\n=== Etapa 4/5 · Proxy reverso (Caddy central) ===\n");
    const domain = projectDomain(project);
    const targets = allProjects
      .filter((p) => p.id !== project.id && p.lastDeployStatus === "success")
      .map((p) => ({ domain: projectDomain(p), upstream: this.upstreamFor(p), websocket: p.websocket }));
    targets.push({ domain, upstream, websocket: project.websocket });
    await this.caddy.apply(targets, onLog);
    onLog(`Domínio ${domain} → ${upstream}\n`);

    onLog("\n=== Etapa 5/5 · Health check ===\n");
    await this.waitHealthy(domain, onLog);
    onLog(`Health check OK — http://${domain} respondendo.\n`);
  }

  /** Recalcula o Caddyfile com TODOS os projetos ativos (chamado após cada mudança). */
  async syncCaddy(projects: Project[], onLog?: LogFn): Promise<void> {
    const targets = projects
      .filter((p) => p.lastDeployStatus === "success")
      .map((p) => ({
        domain: projectDomain(p),
        upstream: this.upstreamFor(p),
        websocket: p.websocket,
      }));
    await this.caddy.apply(targets, onLog);
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
      `${path.join(src, outputDir)}:/usr/share/nginx/html:ro`,
      "--label",
      `${PAAS_LABEL_MANAGED}=true`,
      "--label",
      `${PAAS_LABEL_PROJECT}=${project.slug}`,
      this.ctx.staticImage,
    ]);
    if (runRes.code !== 0) throw new Error(`falha ao subir o servidor estático: ${runRes.stderr}`);
    onLog(`Container ${web} servindo ${outputDir}/ na rede ${PAAS_NETWORK}.\n`);
    return `${project.slug}:80`;
  }

  // -------------------------------------------------------------------------
  // Pipeline: compose (adota o compose existente + override do painel)
  // -------------------------------------------------------------------------

  private async deployCompose(
    project: Project,
    src: string,
    onLog: LogFn,
    extraEnv: Record<string, string> = {},
  ): Promise<string> {
    const composeFile = project.detection?.composeFile;
    if (!composeFile) throw new Error("Nenhum arquivo compose detectado.");
    const proxyService = project.proxyService ?? project.detection?.proxyService;
    if (!proxyService) throw new Error("Informe o serviço web do compose (proxyService).");
    const proxyPort = project.proxyPort ?? project.detection?.proxyPort;
    if (!proxyPort) throw new Error("Informe a porta do serviço web (proxyPort).");

    // Override gerado pelo painel: NÃO reescreve o compose do usuário; apenas
    // anexa o serviço web à rede paas-net com um alias estável para o Caddy e,
    // quando há env vars extras (Fase 3 — SMTP), injeta em todos os serviços.
    const envServices = Object.keys(extraEnv).length > 0 ? await composeServiceNames(src, composeFile) : [];
    const overrideDoc: Record<string, unknown> = {
      networks: { [PAAS_NETWORK]: { external: true } },
      services: {
        [proxyService]: {
          networks: {
            default: null,
            [PAAS_NETWORK]: { aliases: [project.slug] },
          },
        },
      },
    };
    const services = overrideDoc.services as Record<string, Record<string, unknown>>;
    for (const name of envServices) {
      services[name] = { ...(services[name] ?? {}), environment: { ...extraEnv } };
      // o serviço web já tem a entrada de networks acima — preservada pelo spread
    }

    const workDir = projectWorkDir(this.ctx, project);
    await mkdir(workDir, { recursive: true });
    const overrideFile = path.join(workDir, "paas.override.yml");
    const header = "# Gerado pelo painel PaaS — não editar. Anexa o serviço web à rede do painel.\n";
    await writeFile(overrideFile, header + stringify(overrideDoc), { encoding: "utf8", mode: 0o600 });
    onLog(`Override gerado em ${overrideFile} (serviço "${proxyService}" na ${PAAS_NETWORK}).\n`);
    if (envServices.length > 0) {
      onLog(`Env vars injetadas nos serviços: ${envServices.join(", ")}.\n`);
    }

    const args = this.composeArgs(project, src);
    const code = await runStream("docker", [...args, "up", "-d", "--build"], onLog);
    if (code !== 0) throw new Error(`docker compose up falhou (exit ${code}).`);

    return `${project.slug}:${proxyPort}`;
  }

  private composeArgs(project: Project, src: string): string[] {
    const composeFile = project.detection?.composeFile ?? "compose.yml";
    const overrideFile = path.join(projectWorkDir(this.ctx, project), "paas.override.yml");
    return [
      "compose",
      "-p",
      composeProjectName(project),
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
      onLog("Nenhum container do projeto encontrado.\n");
      return;
    }
    const r = await run("docker", ["stop", ...ids], { timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(`falha ao parar containers: ${r.stderr}`);
    onLog(`${ids.length} container(es) parado(s).\n`);
  }

  async start(project: Project, onLog: LogFn): Promise<void> {
    const ids = await this.projectContainers(project);
    if (ids.length === 0) {
      throw new Error("Nenhum container do projeto encontrado — faça um deploy primeiro.");
    }
    const r = await run("docker", ["start", ...ids], { timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(`falha ao iniciar containers: ${r.stderr}`);
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

  // -------------------------------------------------------------------------
  // Health check (via Caddy central, com Host header)
  // -------------------------------------------------------------------------

  private async waitHealthy(domain: string, onLog: LogFn, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = "";
    while (Date.now() < deadline) {
      const result = await httpGet(domain, this.ctx.caddyHttpPort);
      if (result.ok) return;
      lastError = result.error ?? `HTTP ${result.status}`;
      await new Promise((r) => setTimeout(r, 2_000));
    }
    onLog(`Última resposta do health check: ${lastError}\n`);
    throw new Error(`health check falhou após ${Math.round(timeoutMs / 1000)}s (${lastError}).`);
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

/** GET http://127.0.0.1:<port>/ com Host: <domain> (passa pelo Caddy central). */
function httpGet(
  domain: string,
  port: number,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/", method: "GET", headers: { Host: domain }, timeout: 5_000 },
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
