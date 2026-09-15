/**
 * caddy.ts — Caddy central do painel (plano §5.2).
 *
 * Um container Caddy gerenciado pelo painel atua como reverse proxy da máquina.
 * O Caddyfile é gerado a partir dos projetos (domínio → upstream container:porta)
 * e recarregado sem downtime via `caddy reload` dentro do container. O arquivo é
 * entregue ao container pelo daemon (`docker cp`), nunca por bind mount de um
 * caminho do painel — ver o comentário da classe CaddyManager.
 *
 * Modo dev local: domínios *.localhost são servidos em HTTP puro (o Caddy
 * trataria .localhost como nome local e emitiria cert interno; para testes com
 * curl/navegador sem instalar a CA, usamos o esquema http:// explícito).
 * Em produção (domínio real): endereço sem esquema → HTTPS automático.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PAAS_CADDY_CONTAINER,
  PAAS_LABEL_MANAGED,
  PAAS_NETWORK,
  type Project,
} from "@paas/core";
import {
  copyFilesToContainer,
  hasLegacyConfigBind,
  INSPECT_RUNNING_AND_MOUNTS,
  parseContainerInspect,
} from "./container-files.js";
import { run } from "./exec.js";

/** Diretório da configuração dentro do container do Caddy (existe na imagem). */
export const CADDY_CONFIG_DIR = "/etc/caddy";
export const CADDYFILE_PATH = `${CADDY_CONFIG_DIR}/Caddyfile`;

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

export interface CaddyManagerOptions {
  /** Nome do container (padrão paas-caddy). */
  containerName?: string;
  /** Rede Docker (padrão paas-net). */
  network?: string;
  /** Volume dos certificados/estado do Caddy (padrão paas_caddy_data). */
  dataVolume?: string;
  /** Volume do autosave do Caddy (padrão paas_caddy_config). */
  configVolume?: string;
}

/**
 * Onde o Caddyfile mora: na camada gravável do próprio container do Caddy,
 * escrito com `docker cp` (ver container-files.ts). NÃO há bind mount de
 * caminho do painel — em produção o painel roda em container e esse caminho
 * não existe no host, onde o daemon resolve o `-v`. O arquivo sobrevive a
 * `docker restart`/reboot (a camada do container persiste) e é regravado
 * antes de todo `docker start` e em todo `apply()`. A cópia em `caddyDir` é
 * só um espelho para inspeção; o Caddy nunca a lê.
 */
export class CaddyManager {
  private readonly name: string;
  private readonly network: string;
  private readonly dataVolume: string;
  private readonly configVolume: string;

  constructor(
    /** Diretório data/caddy (espelho do último Caddyfile aplicado, só para inspeção). */
    private readonly caddyDir: string,
    private readonly image = "caddy:2-alpine",
    /** Portas publicadas no host (configurável para dev, ex.: 9080/9443). */
    private readonly ports: CaddyPorts = { http: 80, https: 443 },
    options: CaddyManagerOptions = {},
  ) {
    this.name = options.containerName ?? PAAS_CADDY_CONTAINER;
    this.network = options.network ?? PAAS_NETWORK;
    this.dataVolume = options.dataVolume ?? "paas_caddy_data";
    this.configVolume = options.configVolume ?? "paas_caddy_config";
  }

  get containerName(): string {
    return this.name;
  }

  /** Garante a rede dedicada do painel. */
  async ensureNetwork(): Promise<void> {
    const inspect = await run("docker", ["network", "inspect", this.network]);
    if (inspect.code === 0) return;
    const create = await run("docker", [
      "network",
      "create",
      "--label",
      `${PAAS_LABEL_MANAGED}=true`,
      this.network,
    ]);
    if (create.code !== 0) throw new Error(`falha ao criar a rede ${this.network}: ${create.stderr}`);
  }

  async isRunning(): Promise<boolean> {
    const r = await run("docker", ["inspect", "-f", "{{.State.Running}}", this.name]);
    return r.code === 0 && r.stdout.trim() === "true";
  }

  /**
   * Sobe (ou garante) o container do Caddy central.
   *
   * `initialCaddyfile` é o conteúdo gravado quando o container precisa ser
   * criado (padrão: Caddyfile sem sites). Um container existente cuja
   * montagem é a da versão antiga (bind mount sobre /etc/caddy) é removido e
   * recriado: em produção ele enxerga um diretório vazio no lugar do arquivo e
   * nunca sobe. Nada é apagado no host — só o container.
   */
  async ensureRunning(initialCaddyfile?: string): Promise<void> {
    await this.ensureNetwork();

    const inspect = await run("docker", ["inspect", "-f", INSPECT_RUNNING_AND_MOUNTS, this.name]);
    if (inspect.code === 0) {
      const { running, mounts } = parseContainerInspect(inspect.stdout);
      if (!hasLegacyConfigBind(mounts, CADDY_CONFIG_DIR)) {
        if (running) return;
        if (initialCaddyfile !== undefined) await this.pushCaddyfile(initialCaddyfile);
        const start = await run("docker", ["start", this.name]);
        if (start.code !== 0) throw new Error(`falha ao iniciar ${this.name}: ${start.stderr}`);
        return;
      }
      const rm = await run("docker", ["rm", "-f", this.name]);
      if (rm.code !== 0) {
        throw new Error(`falha ao remover ${this.name} com montagem antiga do Caddyfile: ${rm.stderr}`);
      }
    }

    const create = await run("docker", [
      "create",
      "--name",
      this.name,
      "--restart",
      "unless-stopped",
      "--network",
      this.network,
      "-p",
      `${this.ports.http}:80`,
      "-p",
      `${this.ports.https}:443`,
      "-v",
      `${this.dataVolume}:/data`,
      "-v",
      `${this.configVolume}:/config`,
      "--label",
      `${PAAS_LABEL_MANAGED}=true`,
      "--label",
      "paas.role=caddy",
      this.image,
    ]);
    if (create.code !== 0) {
      throw new Error(`falha ao criar ${this.name}: ${create.stderr}`);
    }
    await this.pushCaddyfile(initialCaddyfile ?? renderCaddyfile([]));
    const start = await run("docker", ["start", this.name]);
    if (start.code !== 0) throw new Error(`falha ao iniciar ${this.name}: ${start.stderr}`);
  }

  /** Grava o Caddyfile dentro do container (parado ou rodando) pelo daemon. */
  private async pushCaddyfile(content: string): Promise<void> {
    const cp = await copyFilesToContainer(this.name, CADDY_CONFIG_DIR, [
      { name: "Caddyfile", content, mode: 0o644 },
    ]);
    if (cp.code !== 0) {
      throw new Error(`falha ao gravar o Caddyfile em ${this.name}: ${cp.stderr.trim()}`);
    }
  }

  /** Espelho local para inspeção; falhar aqui não pode derrubar o proxy. */
  private async writeMirror(content: string, onLog?: (chunk: string) => void): Promise<void> {
    try {
      await mkdir(this.caddyDir, { recursive: true });
      await writeFile(path.join(this.caddyDir, "Caddyfile"), content, "utf8");
    } catch (err) {
      onLog?.(`aviso: cópia local do Caddyfile não gravada (${err instanceof Error ? err.message : String(err)}).\n`);
    }
  }

  /** Gera o Caddyfile a partir dos alvos e recarrega o Caddy sem downtime. */
  async apply(targets: CaddyTarget[], onLog?: (chunk: string) => void): Promise<void> {
    const content = renderCaddyfile(targets);
    await this.ensureRunning(content);
    // Sempre regrava: se o container já estava rodando, ensureRunning não mexeu no arquivo.
    await this.pushCaddyfile(content);
    await this.writeMirror(content, onLog);

    const reload = await run("docker", [
      "exec",
      this.name,
      "caddy",
      "reload",
      "--config",
      CADDYFILE_PATH,
      "--adapter",
      "caddyfile",
    ]);
    if (reload.code !== 0) {
      onLog?.(`caddy reload falhou (${reload.stderr.trim()}); reiniciando o container…\n`);
      const restart = await run("docker", ["restart", this.name]);
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
