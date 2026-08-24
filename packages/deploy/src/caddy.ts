/**
 * caddy.ts — Caddy central do painel (plano §5.2).
 *
 * Um container Caddy gerenciado pelo painel atua como reverse proxy da máquina.
 * O Caddyfile é gerado a partir dos projetos (domínio → upstream container:porta)
 * e recarregado sem downtime via `caddy reload` dentro do container.
 *
 * Modo dev local: domínios *.localhost são servidos em HTTP puro (o Caddy
 * trataria .localhost como nome local e emitiria cert interno; para testes com
 * curl/navegador sem instalar a CA, usamos o esquema http:// explícito).
 * Em produção (domínio real): endereço sem esquema → HTTPS automático.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PAAS_CADDY_CONTAINER,
  PAAS_LABEL_MANAGED,
  PAAS_NETWORK,
  type Project,
} from "@paas/core";
import { run } from "./exec.js";

export interface CaddyTarget {
  /** Domínio do projeto (ex.: app.localhost ou app.exemplo.com). */
  domain: string;
  /** Upstream na rede paas-net (ex.: "paas-app-web:80" ou alias do compose). */
  upstream: string;
  /** WebSocket/streaming: desativa buffer de resposta e timeouts curtos. */
  websocket: boolean;
}

export interface CaddyPorts {
  /** Porta do host publicada para o HTTP do Caddy (padrão 80). */
  http: number;
  /** Porta do host publicada para o HTTPS do Caddy (padrão 443). */
  https: number;
}

export class CaddyManager {
  constructor(
    /** Diretório data/caddy (Caddyfile persistido aqui). */
    private readonly caddyDir: string,
    private readonly image = "caddy:2-alpine",
    /** Portas publicadas no host (configurável para dev, ex.: 9080/9443). */
    private readonly ports: CaddyPorts = { http: 80, https: 443 },
  ) {}

  get containerName(): string {
    return PAAS_CADDY_CONTAINER;
  }

  /** Garante a rede dedicada do painel. */
  async ensureNetwork(): Promise<void> {
    const inspect = await run("docker", ["network", "inspect", PAAS_NETWORK]);
    if (inspect.code === 0) return;
    const create = await run("docker", [
      "network",
      "create",
      "--label",
      `${PAAS_LABEL_MANAGED}=true`,
      PAAS_NETWORK,
    ]);
    if (create.code !== 0) throw new Error(`falha ao criar a rede ${PAAS_NETWORK}: ${create.stderr}`);
  }

  async isRunning(): Promise<boolean> {
    const r = await run("docker", ["inspect", "-f", "{{.State.Running}}", PAAS_CADDY_CONTAINER]);
    return r.code === 0 && r.stdout.trim() === "true";
  }

  /** Sobe (ou garante) o container do Caddy central. */
  async ensureRunning(): Promise<void> {
    await this.ensureNetwork();
    if (await this.isRunning()) return;

    const exists = await run("docker", ["inspect", PAAS_CADDY_CONTAINER]);
    if (exists.code === 0) {
      const start = await run("docker", ["start", PAAS_CADDY_CONTAINER]);
      if (start.code !== 0) throw new Error(`falha ao iniciar ${PAAS_CADDY_CONTAINER}: ${start.stderr}`);
      return;
    }

    await mkdir(this.caddyDir, { recursive: true });
    const caddyfile = path.join(this.caddyDir, "Caddyfile");
    // Garante que o arquivo existe ANTES do bind mount (senão o Docker cria um
    // diretório no lugar e o mount falha).
    if (!existsSync(caddyfile)) {
      await writeFile(caddyfile, renderCaddyfile([]), "utf8");
    }
    const create = await run("docker", [
      "run",
      "-d",
      "--name",
      PAAS_CADDY_CONTAINER,
      "--restart",
      "unless-stopped",
      "--network",
      PAAS_NETWORK,
      "-p",
      `${this.ports.http}:80`,
      "-p",
      `${this.ports.https}:443`,
      "-v",
      `${caddyfile}:/etc/caddy/Caddyfile:ro`,
      "-v",
      "paas_caddy_data:/data",
      "-v",
      "paas_caddy_config:/config",
      "--label",
      `${PAAS_LABEL_MANAGED}=true`,
      "--label",
      "paas.role=caddy",
      this.image,
    ]);
    if (create.code !== 0) {
      throw new Error(`falha ao criar ${PAAS_CADDY_CONTAINER}: ${create.stderr}`);
    }
  }

  /** Gera o Caddyfile a partir dos alvos e recarrega o Caddy sem downtime. */
  async apply(targets: CaddyTarget[], onLog?: (chunk: string) => void): Promise<void> {
    await this.ensureRunning();
    const content = renderCaddyfile(targets);
    const file = path.join(this.caddyDir, "Caddyfile");
    await mkdir(this.caddyDir, { recursive: true });
    await writeFile(file, content, "utf8");

    const reload = await run("docker", [
      "exec",
      PAAS_CADDY_CONTAINER,
      "caddy",
      "reload",
      "--config",
      "/etc/caddy/Caddyfile",
    ]);
    if (reload.code !== 0) {
      onLog?.(`caddy reload falhou (${reload.stderr.trim()}); reiniciando o container…\n`);
      const restart = await run("docker", ["restart", PAAS_CADDY_CONTAINER]);
      if (restart.code !== 0) {
        throw new Error(`falha ao recarregar o Caddy: ${reload.stderr} / restart: ${restart.stderr}`);
      }
    }
    onLog?.(`Caddyfile aplicado com ${targets.length} domínio(s).\n`);
  }
}

/** Endereço do site no Caddyfile: http:// para *.localhost (dev), senão HTTPS automático. */
function siteAddress(domain: string): string {
  return domain.endsWith(".localhost") || domain === "localhost" ? `http://${domain}` : domain;
}

/**
 * Defesa em profundidade: o domínio já é validado ao criar/atualizar o projeto,
 * mas o Caddyfile também é montado a partir de projetos gravados antes dessa
 * validação existir. Um valor com `{`, `}` ou quebra de linha viraria diretiva
 * de configuração, então alvos fora do formato são descartados.
 */
const SAFE_DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const SAFE_UPSTREAM_RE = /^[A-Za-z0-9._-]+:[0-9]{1,5}$/;

export function isSafeCaddyTarget(target: CaddyTarget): boolean {
  return SAFE_DOMAIN_RE.test(target.domain) && SAFE_UPSTREAM_RE.test(target.upstream);
}

/** Renderiza o Caddyfile completo (um bloco por alvo). */
export function renderCaddyfile(allTargets: CaddyTarget[]): string {
  const targets = allTargets.filter(isSafeCaddyTarget);
  const lines: string[] = [
    "# Gerado pelo painel PaaS — não editar manualmente.",
    `# Atualizado em ${new Date().toISOString()}`,
    "",
  ];
  if (targets.length === 0) {
    // Caddyfile válido sem sites: responde 404 em qualquer host.
    lines.push("http:// {", "\trespond 404", "}", "");
    return lines.join("\n");
  }
  for (const target of targets) {
    lines.push(`${siteAddress(target.domain)} {`);
    if (target.websocket) {
      // WebSocket funciona nativamente; flush_interval -1 desativa buffer para
      // streaming/longs polls, e conexões hijacked (WS) não têm timeout de leitura.
      lines.push(`\treverse_proxy ${target.upstream} {`, "\t\tflush_interval -1", "}");
    } else {
      lines.push(`\treverse_proxy ${target.upstream}`);
    }
    lines.push("}", "");
  }
  return lines.join("\n");
}

/** Upstream padrão de um projeto a partir do domínio configurado. */
export function projectDomain(project: Pick<Project, "domain" | "slug">): string {
  return project.domain || `${project.slug}.localhost`;
}
