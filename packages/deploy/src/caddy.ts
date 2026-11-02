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
import { isIP } from "node:net";
import path from "node:path";
import {
  CADDY_IMAGE,
  PAAS_CADDY_CONTAINER,
  PAAS_CADDY_DATA_VOLUME,
  certificateFileId,
  PAAS_LABEL_MANAGED,
  PAAS_NETWORK,
  PAAS_PANEL_NETWORK,
  type Project,
} from "@paas/core";
import {
  copyFilesToContainer,
  hasLegacyConfigBind,
  INSPECT_RUNNING_AND_MOUNTS,
  parseContainerInspect,
} from "./container-files.js";
import { RESERVED_NAMES } from "./compose-model.js";
import { LIST_CERTIFICATES_SCRIPT, parseIssuedCertificates } from "./caddy-storage.js";
import type { CertificateStatus } from "./tls-status.js";
import { run } from "./exec.js";

/** Diretório da configuração dentro do container do Caddy (existe na imagem). */
export const CADDY_CONFIG_DIR = "/etc/caddy";
export const CADDYFILE_PATH = `${CADDY_CONFIG_DIR}/Caddyfile`;
/** Candidato a Caddyfile: gravado e validado ANTES de substituir o que está em uso. */
export const CADDYFILE_CANDIDATE_NAME = "Caddyfile.novo";
export const CADDYFILE_CANDIDATE_PATH = `${CADDY_CONFIG_DIR}/${CADDYFILE_CANDIDATE_NAME}`;
/** Esperas (ms) entre as tentativas de `caddy reload` quando a API de administração não responde. */
export const CADDY_RELOAD_BACKOFF_MS: readonly number[] = [1_000, 3_000, 8_000];

/**
 * O Caddy recusou a nova configuração na validação. O Caddy segue com a configuração
 * ANTERIOR (nada foi recarregado e o container não foi reiniciado).
 */
export class CaddyConfigRejectedError extends Error {
  constructor(detail: string) {
    super(`o Caddy recusou a nova configuração; o proxy segue com a anterior (${detail})`);
    this.name = "CaddyConfigRejectedError";
  }
}

/** Resume a saída de erro do Caddy para o log: poucas linhas, sem valores de token/senha/chave. */
export function summarizeCaddyError(stderr: string): string {
  const flat = stderr
    .trim()
    .split("\n")
    .slice(0, 3)
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/(token|secret|key|senha|password)=\S+/gi, "$1=***")
    .replace(/Bearer\s+\S+/gi, "Bearer ***");
  return flat.length > 400 ? `${flat.slice(0, 400)}…` : flat || "sem detalhe";
}

export interface CaddyTarget {
  /** Domínio do projeto (ex.: app.localhost ou app.exemplo.com). */
  domain: string;
  /** Outros domínios servidos pelo mesmo projeto (ex.: o subdomínio próprio além do automático). */
  aliases?: string[];
  /** Upstream na rede paas-net (ex.: "paas-app-web:80" ou alias do compose). */
  upstream: string;
  /** WebSocket/streaming: desativa buffer de resposta e timeouts curtos. */
  websocket: boolean;
  /**
   * false = o projeto nunca foi publicado: sem resposta do app, a página diz
   * "site em manutenção" (o domínio já responde com HTTPS). Ausente/true =
   * já esteve no ar: "temporariamente indisponível".
   */
  published?: boolean;
  /**
   * true = há um deploy/atualização em andamento neste projeto: quando o app não
   * responde, o visitante vê "Atualizando — volta em instantes" (503 com
   * Retry-After, atualização a cada 5 s) em vez da página genérica. Só vale
   * enquanto o job roda: o painel limpa ao terminar e na subida.
   */
  updating?: boolean;
  /**
   * true = o projeto foi parado de propósito no painel: o proxy NÃO espera o app
   * voltar (sem `lb_try_duration`) e mostra a página na hora.
   */
  stopped?: boolean;
}

/**
 * Certificado manual de um nome (página Certificados): o par vai para dentro
 * do container do Caddy em /etc/caddy/certs e o bloco do nome ganha
 * `tls <cert> <key>`. A chave nunca vai para log nem para o espelho local.
 */
export interface ManualCaddyCertificate {
  host: string;
  /** PEM do certificado, com a cadeia. */
  cert: string;
  /** PEM da chave privada. */
  key: string;
}

/**
 * Webmail (Roundcube) servido em cada mail.<domínio>. Ausente = o bloco do
 * nome responde a página "Servidor de e-mail" (como antes).
 */
export interface CaddyWebmail {
  /** Container do webmail na paas-net (ex.: paas-webmail:8000). */
  upstream: string;
  /** IPs bloqueados agora por excesso de senhas erradas (recebem 429). */
  blockedIps?: string[];
}

/**
 * Redirecionamento do par de um domínio (example.com <-> www.example.com):
 * `host` responde 308 para `to` (o domínio canônico, já servido por um
 * projeto). O bloco só existe quando o painel viu o DNS de `host` apontar
 * para a VPS: é isso que faz o Caddy pedir o certificado dele, e nome que não
 * aponta só geraria falha de ACME e gastaria o limite do Let's Encrypt.
 */
export interface CaddyRedirect {
  host: string;
  to: string;
}

/**
 * Domínios dinâmicos de UM projeto (SaaS multi-cliente): nomes que o Caddy
 * serve com certificado emitido SOB DEMANDA, no primeiro acesso, depois de o
 * painel autorizar (`ask`). `suffixes` viram blocos curinga (`*.example.com`):
 * qualquer subdomínio de um nível chega ao projeto sem mexer no Caddyfile.
 * `hosts` são nomes avulsos (domínios próprios dos clientes), um a um.
 */
export interface CaddyDynamicRoute {
  upstream: string;
  websocket: boolean;
  published?: boolean;
  /** Deploy em andamento (ver CaddyTarget.updating). */
  updating?: boolean;
  /** Projeto parado de propósito (ver CaddyTarget.stopped). */
  stopped?: boolean;
  suffixes: string[];
  hosts: string[];
}

/** Política MTA-STS publicada pelo próprio proxy em https://<host>/.well-known/mta-sts.txt. */
export interface CaddyMtaSts {
  /** mta-sts.<domínio de e-mail>. */
  host: string;
  /** Texto do arquivo (linhas "chave: valor"). */
  policy: string;
}

export interface CaddyDynamic {
  /** URL do `ask` do painel (rede interna paas-panel). Sem URL segura, nada dinâmico é gerado. */
  askUrl: string;
  routes: CaddyDynamicRoute[];
  /** Sites da política MTA-STS dos domínios de e-mail (certificado sob demanda, autorizado pelo mesmo `ask`). */
  mtaSts?: CaddyMtaSts[];
}

export interface CaddyApplyOptions {
  /** Domínios dinâmicos (emissão sob demanda) dos projetos. */
  dynamic?: CaddyDynamic;
  /** Pares (com/sem www) que redirecionam para o domínio canônico. */
  redirects?: CaddyRedirect[];
  /** Certificados manuais em vigor (os demais nomes ficam no automático). */
  manual?: ManualCaddyCertificate[];
  /** Webmail ativado: os blocos mail.<domínio> encaminham para ele. */
  webmail?: CaddyWebmail;
  /**
   * `caddy reload --force`: recarrega mesmo com a configuração igual. O
   * certmagic cancela as tentativas em espera da configuração antiga e
   * recomeça a emissão dos nomes sem certificado na hora (o primeiro
   * pedido de um "obtain" não espera). Certificados já válidos ficam como
   * estão — nada é apagado nem renovado à força.
   */
  force?: boolean;
}

/** Pasta dos certificados manuais dentro do container do Caddy. */
export const CADDY_MANUAL_CERTS_DIR = "/etc/caddy/certs";

/** Nome de arquivo do host: a mesma regra do painel e do Stalwart, sem colisão (@paas/core). */
const fileIdOf = certificateFileId;

/** Onde ficam (dentro do container do Caddy) o certificado e a chave manuais de `host`. */
export function manualCertificatePaths(host: string): { cert: string; key: string } {
  const id = fileIdOf(host);
  return { cert: `${CADDY_MANUAL_CERTS_DIR}/${id}.crt`, key: `${CADDY_MANUAL_CERTS_DIR}/${id}.key` };
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
  /** Rede só Caddy ↔ painel (padrão paas-panel): o painel NÃO fica na paas-net dos projetos. */
  panelNetwork?: string;
  /** Volume dos certificados/estado do Caddy (padrão paas_caddy_data). */
  dataVolume?: string;
  /** Volume do autosave do Caddy (padrão paas_caddy_config). */
  configVolume?: string;
  /**
   * Site do PRÓPRIO painel (acesso por HTTPS, ex.: <ip-com-hífens>.sslip.io
   * → tws-panel:9000). Entra em todo Caddyfile gerado — ver renderCaddyfile.
   */
  panelSite?: PanelSite;
  /** Esperas (ms) entre as tentativas de recarregar o Caddy (testes usam zeros). Padrão: 1 s, 3 s, 8 s. */
  reloadBackoffMs?: readonly number[];
}

/** Domínio do painel servido pelo Caddy central e o upstream dele na paas-net. */
export interface PanelSite {
  /** Endereço principal do painel (o domínio próprio, quando ativo; senão o sslip.io). */
  domain: string;
  /**
   * Outros endereços do MESMO bloco — Configurações → Domínio do painel: o
   * endereço automático pelo IP continua respondendo junto com o domínio
   * próprio até a pessoa desativá-lo.
   */
  aliases?: string[];
  upstream: string;
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
  private readonly panelNetwork: string;
  private readonly dataVolume: string;
  private readonly configVolume: string;
  private panelSite: PanelSite | undefined;
  private readonly reloadBackoffMs: readonly number[];
  /** Certificados manuais da última aplicação: vão junto em toda gravação do Caddyfile. */
  private manual: ManualCaddyCertificate[] = [];

  constructor(
    /** Diretório data/caddy (espelho do último Caddyfile aplicado, só para inspeção). */
    private readonly caddyDir: string,
    private readonly image = CADDY_IMAGE,
    /** Portas publicadas no host (configurável para dev, ex.: 9080/9443). */
    private readonly ports: CaddyPorts = { http: 80, https: 443 },
    options: CaddyManagerOptions = {},
  ) {
    this.name = options.containerName ?? PAAS_CADDY_CONTAINER;
    this.network = options.network ?? PAAS_NETWORK;
    this.panelNetwork = options.panelNetwork ?? PAAS_PANEL_NETWORK;
    this.dataVolume = options.dataVolume ?? PAAS_CADDY_DATA_VOLUME;
    this.configVolume = options.configVolume ?? "paas_caddy_config";
    this.panelSite = options.panelSite;
    this.reloadBackoffMs = options.reloadBackoffMs ?? CADDY_RELOAD_BACKOFF_MS;
  }

  get containerName(): string {
    return this.name;
  }

  /** Endereços do painel em uso (undefined = acesso por túnel). */
  get currentPanelSite(): PanelSite | undefined {
    return this.panelSite;
  }

  /**
   * Troca os endereços do painel (domínio próprio ativado, acesso pelo IP
   * desativado/reativado). Vale a partir do próximo apply().
   */
  setPanelSite(site: PanelSite | undefined): void {
    this.panelSite = site;
  }

  /** Garante a rede dos projetos (Caddy + projetos hospedados). */
  async ensureNetwork(): Promise<void> {
    await this.ensureNamedNetwork(this.network);
  }

  /** Garante a rede que liga o Caddy ao painel (nada além deles entra nela). */
  async ensurePanelNetwork(): Promise<void> {
    await this.ensureNamedNetwork(this.panelNetwork);
  }

  private async ensureNamedNetwork(name: string): Promise<void> {
    const inspect = await run("docker", ["network", "inspect", name]);
    if (inspect.code === 0) return;
    const create = await run("docker", ["network", "create", "--label", `${PAAS_LABEL_MANAGED}=true`, name]);
    if (create.code !== 0) throw new Error(`falha ao criar a rede ${name}: ${create.stderr}`);
  }

  /** Redes em que o container está (vazio se não existe ou a saída não se lê). */
  private async networksOf(container: string): Promise<string[] | null> {
    const inspect = await run("docker", ["inspect", "-f", "{{json .NetworkSettings.Networks}}", container]);
    if (inspect.code !== 0) return null;
    try {
      return Object.keys(JSON.parse(inspect.stdout.trim() || "{}") as Record<string, unknown>);
    } catch {
      return [];
    }
  }

  private async joinNetwork(container: string, network: string): Promise<void> {
    const current = await this.networksOf(container);
    if (current?.includes(network)) return;
    const connect = await run("docker", ["network", "connect", network, container]);
    if (connect.code !== 0) {
      throw new Error(`falha ao conectar ${container} à rede ${network}: ${connect.stderr.trim()}`);
    }
  }

  /**
   * Tira `container` da rede dos projetos. O painel não pode ficar nela:
   * qualquer projeto hospedado alcançaria a API do painel pelo nome (A4).
   */
  async leaveProjectNetwork(container: string): Promise<void> {
    const current = await this.networksOf(container);
    if (!current?.includes(this.network)) return;
    const out = await run("docker", ["network", "disconnect", this.network, container]);
    if (out.code !== 0 && !/is not connected/i.test(out.stderr)) {
      throw new Error(`falha ao tirar ${container} da rede ${this.network}: ${out.stderr.trim()}`);
    }
  }

  /**
   * Containers antigos na rede dos projetos com um alias que é nome do painel
   * (`tws-panel`, `paas-*`…) sem ser o dono do nome: antes das regras duras, um
   * compose podia pôr esse alias e receber o tráfego do painel pelo DNS da
   * rede. O painel só avisa (derrubar container de projeto é decisão do
   * operador). Falha do Docker ou saída ilegível = lista vazia.
   */
  async reservedAliases(): Promise<Array<{ container: string; alias: string }>> {
    const ps = await run("docker", ["ps", "-q", "--filter", `network=${this.network}`]);
    const ids = ps.code === 0 ? ps.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
    if (ids.length === 0) return [];
    const template = `{{.Name}}|{{json (index .NetworkSettings.Networks "${this.network}").Aliases}}`;
    const inspect = await run("docker", ["inspect", "-f", template, ...ids]);
    if (inspect.code !== 0) return [];
    const found: Array<{ container: string; alias: string }> = [];
    for (const line of inspect.stdout.split("\n")) {
      const at = line.indexOf("|");
      if (at < 0) continue;
      const container = line.slice(1, at);
      let aliases: unknown;
      try {
        aliases = JSON.parse(line.slice(at + 1));
      } catch {
        continue;
      }
      if (!Array.isArray(aliases)) continue;
      for (const alias of aliases) {
        if (typeof alias !== "string" || alias === container) continue;
        const n = alias.toLowerCase();
        if (RESERVED_NAMES.includes(n) || /^(paas|tws)[-_]/.test(n)) found.push({ container, alias });
      }
    }
    return found;
  }

  /**
   * Liga `container` (o painel) à rede só dele com o Caddy (paas-panel). O
   * docker-compose.yml do painel NÃO declara redes do painel: numa instalação
   * que nunca fez deploy elas não existem. O Caddy entra na rede antes
   * (instalações antigas têm o Caddy só na paas-net). Quando o Caddy não serve
   * o painel (acesso por túnel) ninguém depende da paas-net: o painel já sai
   * dela; com o painel servido, a saída fica para o fim do apply(), depois do
   * reload, para não cortar o próprio tráfego do Caddy.
   */
  async connectToNetwork(container: string): Promise<void> {
    await this.ensurePanelNetwork();
    if ((await this.networksOf(this.name)) !== null) await this.joinNetwork(this.name, this.panelNetwork);
    await this.joinNetwork(container, this.panelNetwork);
    if (!this.panelSite) await this.leaveProjectNetwork(container);
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
    await this.ensurePanelNetwork();

    const inspect = await run("docker", ["inspect", "-f", INSPECT_RUNNING_AND_MOUNTS, this.name]);
    if (inspect.code === 0) {
      const { running, mounts } = parseContainerInspect(inspect.stdout);
      if (!hasLegacyConfigBind(mounts, CADDY_CONFIG_DIR)) {
        await this.joinNetwork(this.name, this.panelNetwork);
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
    await this.joinNetwork(this.name, this.panelNetwork);
    await this.pushCaddyfile(initialCaddyfile ?? renderCaddyfile([]));
    const start = await run("docker", ["start", this.name]);
    if (start.code !== 0) throw new Error(`falha ao iniciar ${this.name}: ${start.stderr}`);
  }

  /**
   * Grava o Caddyfile dentro do container (parado ou rodando) pelo daemon —
   * com os certificados manuais na mesma cópia (pasta certs/ 0700, arquivos
   * 0600): um container recriado já sobe com eles, senão o Caddy recusaria
   * o Caddyfile por arquivo ausente.
   */
  private async pushCaddyfile(content: string, fileName = "Caddyfile"): Promise<void> {
    const manual = this.manual.filter((m) => SAFE_DOMAIN_RE.test(m.host));
    const certFiles = manual.flatMap((m) => {
      const id = fileIdOf(m.host);
      return [
        { name: `certs/${id}.crt`, content: m.cert, mode: 0o600 },
        { name: `certs/${id}.key`, content: m.key, mode: 0o600 },
      ];
    });
    const cp = await copyFilesToContainer(this.name, CADDY_CONFIG_DIR, [
      { name: fileName, content, mode: 0o644 },
      ...(certFiles.length ? [{ name: "certs/", mode: 0o700 }, ...certFiles] : []),
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

  /**
   * Gera o Caddyfile a partir dos alvos e recarrega o Caddy sem downtime.
   * `mailHosts`: hostnames do servidor de e-mail (ver renderCaddyfile).
   */
  async apply(
    targets: CaddyTarget[],
    onLog?: (chunk: string) => void,
    mailHosts: string[] = [],
    opts: CaddyApplyOptions = {},
  ): Promise<void> {
    // uma aplicação por vez: dois ajustes simultâneos (deploys seguidos, parar/iniciar) nunca se cruzam
    const run = this.applyQueue.then(() => this.applyNow(targets, onLog, mailHosts, opts));
    this.applyQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private applyQueue: Promise<void> = Promise.resolve();

  private async applyNow(
    targets: CaddyTarget[],
    onLog: ((chunk: string) => void) | undefined,
    mailHosts: string[],
    opts: CaddyApplyOptions,
  ): Promise<void> {
    this.manual = (opts.manual ?? []).filter((m) => SAFE_DOMAIN_RE.test(m.host));
    const content = renderCaddyfile(
      targets,
      this.panelSite,
      mailHosts,
      this.manual.map((m) => m.host),
      {
        ...(opts.webmail ? { webmail: opts.webmail } : {}),
        ...(opts.redirects ? { redirects: opts.redirects } : {}),
        ...(opts.dynamic ? { dynamic: opts.dynamic } : {}),
      },
    );
    await this.ensureRunning(content);
    // O Caddy alcança o painel pelo nome do container, na paas-panel.
    const panelContainer = this.panelSite ? (this.panelSite.upstream.split(":")[0] ?? "") : "";
    if (this.panelSite) await this.connectToNetwork(panelContainer);
    // Valida o candidato ANTES de tocar no arquivo em uso: configuração inválida nunca chega ao Caddy.
    await this.pushCaddyfile(content, CADDYFILE_CANDIDATE_NAME);
    const check = await run("docker", ["exec", this.name, "caddy", "validate", "--config", CADDYFILE_CANDIDATE_PATH, "--adapter", "caddyfile"]);
    await run("docker", ["exec", this.name, "rm", "-f", CADDYFILE_CANDIDATE_PATH]);
    if (check.code !== 0 && (await this.isRunning())) {
      const detail = summarizeCaddyError(check.stderr);
      onLog?.(`✖ O Caddy recusou a nova configuração (${detail}). O proxy segue com a configuração anterior; nada foi recarregado nem reiniciado.\n`);
      throw new CaddyConfigRejectedError(detail);
    }
    // Sempre regrava: se o container já estava rodando, ensureRunning não mexeu no arquivo.
    await this.pushCaddyfile(content);
    await this.writeMirror(content, onLog);
    await this.reloadCaddy(content, opts, onLog);
    // Migração (A4): instalações antigas têm o painel na paas-net dos projetos.
    if (panelContainer) {
      try {
        await this.leaveProjectNetwork(panelContainer);
      } catch (err) {
        onLog?.(`aviso: o painel continua na rede ${this.network} (${err instanceof Error ? err.message : String(err)}).\n`);
      }
    }
    onLog?.(`Caddyfile aplicado com ${targets.length} domínio(s).\n`);
  }

  /**
   * `caddy reload` com novas tentativas (1 s, 3 s, 8 s) para a API de administração
   * que ainda não responde. NUNCA reinicia um Caddy que está rodando (derrubaria todos
   * os sites): só se o container não está de pé é que ele é iniciado, e iniciar já
   * carrega o Caddyfile novo.
   */
  private async reloadCaddy(content: string, opts: CaddyApplyOptions, onLog?: (chunk: string) => void): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const reload = await run("docker", [
        "exec",
        this.name,
        "caddy",
        "reload",
        "--config",
        CADDYFILE_PATH,
        "--adapter",
        "caddyfile",
        ...(opts.force ? ["--force"] : []),
      ]);
      if (reload.code === 0) return;
      const why = summarizeCaddyError(reload.stderr);
      if (!(await this.isRunning())) {
        onLog?.(`caddy reload falhou (${why}) porque o container ${this.name} não está rodando; iniciando-o com a configuração nova…\n`);
        await this.ensureRunning(content);
        return;
      }
      const wait = this.reloadBackoffMs[attempt];
      if (wait === undefined) throw new Error(`falha ao recarregar o Caddy: ${why}`);
      onLog?.(`caddy reload falhou (${why}); nova tentativa em ${wait / 1000}s…\n`);
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
  }

  /**
   * Volta para o automático: apaga de dentro do container o par manual de
   * `host`. Chamado depois do apply que já tirou o `tls` do bloco.
   */
  async removeManualFiles(host: string): Promise<void> {
    if (!SAFE_DOMAIN_RE.test(host)) throw new Error(`nome inválido: ${JSON.stringify(host)}`);
    const p = manualCertificatePaths(host);
    await run("docker", ["exec", this.name, "rm", "-f", p.cert, p.key]);
  }

  /**
   * Certificados que o Caddy já emitiu (lidos do armazenamento, SEM conexão TLS:
   * num nome de emissão sob demanda o handshake dispararia a emissão). Vazio se o
   * container não roda ou a leitura falha — quem chama trata como "não sei".
   */
  async issuedCertificates(): Promise<Map<string, CertificateStatus> | null> {
    const r = await run("docker", ["exec", this.name, "sh", "-c", LIST_CERTIFICATES_SCRIPT], { timeoutMs: 30_000 });
    return r.code === 0 ? parseIssuedCertificates(r.stdout) : null;
  }

  /**
   * Log das últimas 24 h do Caddy (o Caddy escreve no stderr; junta os dois).
   * Texto não confiável — ver caddy-log.ts. Vazio se o container não existe.
   */
  async recentLogs(): Promise<string> {
    const r = await run("docker", ["logs", "--since", "24h", "--tail", "20000", this.name]);
    if (r.code !== 0) return "";
    return `${r.stdout}\n${r.stderr}`;
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

/** Ícones (traço, 24×24) das páginas servidas pelo Caddy. */
const PAGE_ICONS = {
  // chave de boca: manutenção
  wrench:
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  // setas girando: reiniciando
  refresh:
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>' +
    '<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  // envelope: servidor de e-mail
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  // globo: domínio
  globe:
    '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
} as const;

/**
 * Páginas servidas pelo próprio Caddy (o visitante é o cliente do dono do
 * site): mensagem amigável, sem jargão, e um selo discreto "Gerenciado com
 * TWS Panel". Sem chaves nem crases no HTML: o Caddy leria `{...}` como
 * variável e a crase como fim do texto — por isso todo estilo vai em
 * atributos style (sem bloco <style>). `refresh`: a página se recarrega a
 * cada 60 s, e o site aparece sozinho quando volta.
 */
function sitePage(opts: {
  title: string;
  message: string;
  hint: string;
  icon: keyof typeof PAGE_ICONS;
  refresh: boolean;
  /** Intervalo da atualização automática, em segundos (padrão 60). */
  refreshSeconds?: number;
  /** Linha extra em inglês, abaixo da dica. */
  english?: string;
}): string {
  const font = "font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif";
  return [
    "<!doctype html>",
    '<html lang="pt-BR"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    opts.refresh ? `<meta http-equiv="refresh" content="${opts.refreshSeconds ?? 60}">` : "",
    `<title>${opts.title}</title></head>`,
    `<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;` +
      `background:linear-gradient(160deg,#eef2ff 0%,#f8fafc 55%,#f5f3ff 100%);${font};color:#0f172a">`,
    '<main style="box-sizing:border-box;width:100%;max-width:480px;margin:24px;padding:40px 32px;' +
      'background:#ffffff;border:1px solid #e2e8f0;border-radius:20px;' +
      'box-shadow:0 20px 50px -20px rgba(79,70,229,0.25);text-align:center">',
    '<div style="width:64px;height:64px;margin:0 auto 20px;border-radius:50%;background:#eef2ff;' +
      'display:flex;align-items:center;justify-content:center">',
    '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="2" ' +
      `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PAGE_ICONS[opts.icon]}</svg>`,
    "</div>",
    `<h1 style="font-size:24px;line-height:1.3;margin:0 0 12px;font-weight:700">${opts.title}</h1>`,
    `<p style="margin:0 0 8px;font-size:16px;line-height:1.6;color:#475569">${opts.message}</p>`,
    `<p style="margin:0 0 ${opts.english ? 8 : 28}px;font-size:13px;line-height:1.5;color:#94a3b8">${opts.hint}</p>`,
    opts.english ? `<p style="margin:0 0 28px;font-size:13px;line-height:1.5;color:#94a3b8" lang="en">${opts.english}</p>` : "",
    '<a href="https://github.com/kelvindk9w/tws-panel" target="_blank" rel="noopener noreferrer" ' +
      'style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;' +
      'background:#f1f5f9;color:#64748b;font-size:12px;text-decoration:none">',
    '<span style="width:6px;height:6px;border-radius:50%;background:#4f46e5;display:inline-block"></span>',
    "Gerenciado com TWS Panel</a>",
    "</main></body></html>",
  ].join("");
}

/** Projeto que já esteve no ar e não responde (parado, reiniciando, redeploy). */
export const PROJECT_DOWN_PAGE = sitePage({
  title: "Site temporariamente indisponível",
  message: "Este site está passando por uma manutenção rápida ou reiniciando. Volte em alguns minutos.",
  hint: "Esta página se atualiza sozinha e o site aparece assim que voltar.",
  icon: "refresh",
  refresh: true,
  refreshSeconds: 10,
});

/**
 * Deploy/atualização em andamento: o app está sendo recriado e volta em instantes.
 * Atualiza a cada 5 s e é servida com 503 + Retry-After (ver pushSiteBody).
 */
export const PROJECT_UPDATING_PAGE = sitePage({
  title: "Atualizando — volta em instantes",
  message: "Este site está sendo atualizado agora e volta em instantes.",
  hint: "Esta página se atualiza sozinha a cada poucos segundos.",
  english: "Updating — back in a moment. This page refreshes by itself.",
  icon: "refresh",
  refresh: true,
  refreshSeconds: 5,
});

/** Quanto o proxy espera o app de um projeto voltar antes de mostrar a página de erro (reinício rápido num deploy). */
export const UPSTREAM_WAIT_SECONDS = 20;
export const UPSTREAM_WAIT_INTERVAL_MS = 300;
/** Espera curta enquanto o aviso "Atualizando" está ligado. */
export const UPDATING_WAIT_SECONDS = 3;
/** Prazo para conexões WebSocket sobreviverem a um reload do Caddy (reverse_proxy stream_close_delay, Caddy 2.7+). */
export const STREAM_CLOSE_DELAY = "5m";

/** Segundos do Retry-After da página "Atualizando". */
export const UPDATING_RETRY_AFTER_SECONDS = 5;

/**
 * Projeto ainda não publicado (domínio já conectado). "Manutenção", e não
 * "em configuração": pode ser um site existente sendo migrado para cá, e o
 * visitante não precisa saber disso (pedido do dono do produto).
 */
export const PROJECT_PENDING_PAGE = sitePage({
  title: "Site em manutenção",
  message: "Estamos preparando novidades. Este site está em manutenção e volta em breve.",
  hint: "Esta página se atualiza sozinha e o site aparece assim que estiver pronto.",
  icon: "wrench",
  refresh: true,
});

export const UNKNOWN_DOMAIN_PAGE = sitePage({
  title: "Domínio ainda não configurado",
  message: "Este domínio aponta para este servidor, mas ainda não está configurado em nenhum site.",
  hint: "Se você administra o servidor, conecte o domínio a um projeto no painel (Projeto → Domínios).",
  icon: "globe",
  refresh: false,
});

/**
 * mail.<domínio>: endereço do servidor de e-mail. O bloco existe para o Caddy
 * EMITIR o certificado desse nome (o painel o copia para o Stalwart — ver
 * packages/mailer/src/tls-certificates.ts); quem abre o endereço no
 * navegador vê só esta página.
 */
export const MAIL_HOST_PAGE = sitePage({
  title: "Servidor de e-mail",
  message: "Este endereço é o servidor de e-mail deste domínio. Não há site aqui.",
  hint: "Para ler e enviar e-mails, use o seu programa ou aplicativo de e-mail.",
  icon: "mail",
  refresh: false,
});

/** Webmail fora do ar (container parado, reiniciando ou atualizando). */
export const WEBMAIL_DOWN_PAGE = sitePage({
  title: "Webmail temporariamente indisponível",
  message: "O webmail está reiniciando ou em manutenção. Volte em alguns minutos.",
  hint: "Seus e-mails continuam chegando normalmente. Esta página se atualiza sozinha.",
  icon: "mail",
  refresh: true,
});

/** Visitante bloqueado por excesso de senhas erradas (ver WebmailService). */
export const WEBMAIL_BLOCKED_PAGE = sitePage({
  title: "Muitas tentativas de entrar",
  message: "Foram feitas muitas tentativas com senha errada a partir da sua conexão. Tente de novo em 1 hora.",
  hint: "Se esqueceu a senha, peça ao administrador do e-mail para trocá-la.",
  icon: "mail",
  refresh: false,
});

/** Linhas do bloco mail.<domínio> com o webmail (dentro das chaves). */
function webmailBody(webmail: CaddyWebmail): string[] {
  const blocked = [...new Set(webmail.blockedIps ?? [])].filter((ip) => isIP(ip) !== 0);
  return [
    ...(blocked.length
      ? [
          `\t@webmail_bloqueado remote_ip ${blocked.join(" ")}`,
          '\theader @webmail_bloqueado Content-Type "text/html; charset=utf-8"',
          `\trespond @webmail_bloqueado \`${WEBMAIL_BLOCKED_PAGE}\` 429`,
        ]
      : []),
    // O X-Frame-Options e a política de conteúdo vêm do próprio Roundcube.
    "\theader {",
    '\t\tStrict-Transport-Security "max-age=31536000"',
    '\t\tX-Content-Type-Options "nosniff"',
    '\t\tReferrer-Policy "no-referrer"',
    '\t\tPermissions-Policy "camera=(), microphone=(), geolocation=(), payment=()"',
    "\t}",
    `\treverse_proxy ${webmail.upstream} {`,
    "\t\theader_down -Server",
    "\t\theader_down -X-Powered-By",
    "\t}",
    "\thandle_errors 502 503 504 {",
    '\t\theader Content-Type "text/html; charset=utf-8"',
    `\t\trespond \`${WEBMAIL_DOWN_PAGE}\` 503`,
    "\t}",
  ];
}

/** Corpo de um bloco de site: proxy para o app e página amigável quando ele não responde. */
function pushSiteBody(lines: string[], target: CaddyTarget, isPanel: boolean): void {
  // Projeto (não o painel) fora do ar de propósito não espera: página na hora. Os demais esperam o app
  // voltar por alguns segundos (reinício rápido num deploy vira resposta lenta, não página de erro).
  const waits = !isPanel && target.stopped !== true;
  // stream_close_delay: o reload do Caddy fecha conexões "upgraded" (WebSocket) do bloco antigo; com 5 min de
  // prazo elas seguem vivas depois de cada ajuste do proxy (deploy de OUTRO projeto, parar/iniciar, aviso).
  const proxy: string[] = [`\t\tstream_close_delay ${STREAM_CLOSE_DELAY}`];
  if (target.websocket) {
    // WebSocket funciona nativamente; flush_interval -1 desativa buffer para
    // streaming/longs polls, e conexões hijacked (WS) não têm timeout de leitura.
    proxy.push("\t\tflush_interval -1");
  }
  // Com o aviso "Atualizando" ligado a espera é curta: o visitante vê o aviso logo e a página tenta de novo a cada 5 s.
  const wait = target.updating === true && target.published !== false ? UPDATING_WAIT_SECONDS : UPSTREAM_WAIT_SECONDS;
  if (waits) proxy.push(`\t\tlb_try_duration ${wait}s`, `\t\tlb_try_interval ${UPSTREAM_WAIT_INTERVAL_MS}ms`);
  lines.push(`\treverse_proxy ${target.upstream} {`, ...proxy, "\t}");
  if (!isPanel) {
    // sem resposta do app: página neutra em vez do erro cru do proxy —
    // "em manutenção" se nunca foi publicado, senão "indisponível"
    // "nunca publicado" tem prioridade: o domínio ainda não tem site para "voltar".
    const updating = target.updating === true && target.published !== false;
    const page = target.published === false ? PROJECT_PENDING_PAGE : updating ? PROJECT_UPDATING_PAGE : PROJECT_DOWN_PAGE;
    lines.push(
      "\thandle_errors 502 503 504 {",
      '\t\theader Content-Type "text/html; charset=utf-8"',
      ...(updating ? [`\t\theader Retry-After "${UPDATING_RETRY_AFTER_SECONDS}"`, '\t\theader Cache-Control "no-store"'] : []),
      `\t\trespond \`${page}\` 503`,
      "\t}",
    );
  }
}

/** URL do `ask`: http, nome de container na rede interna, porta e caminho simples (nada que vire diretiva). */
const SAFE_ASK_URL_RE = /^http:\/\/[A-Za-z0-9._-]+:[0-9]{1,5}\/[A-Za-z0-9/_-]*(\?k=[A-Za-z0-9]{16,128})?$/;

/** O nome está um nível abaixo do sufixo (x.example.com para example.com)? */
function oneLevelUnder(host: string, suffix: string): boolean {
  if (!host.endsWith(`.${suffix}`)) return false;
  const prefix = host.slice(0, host.length - suffix.length - 1);
  return prefix.length > 0 && !prefix.includes(".");
}

/**
 * Um bloco por projeto com domínios dinâmicos: `*.sufixo` e os nomes avulsos
 * juntos, com `tls { on_demand }`. Defensivo (o painel já valida): nome ou
 * sufixo fora do formato, `.localhost`, já servido (`taken`) ou já tomado por
 * outro projeto sai. Um nome avulso fica com o projeto que o cadastrou mesmo
 * quando OUTRO projeto tem um sufixo que o cobre: o Caddy escolhe o endereço
 * mais específico, então o bloco exato sempre vence o `*.sufixo` (o painel nem
 * deixa criar essa situação, mas o proxy não depende disso).
 */
function pushDynamicBlocks(lines: string[], routes: CaddyDynamicRoute[], taken: Set<string>): void {
  const okName = (n: string) => SAFE_DOMAIN_RE.test(n) && n.includes(".") && !n.endsWith(".localhost");
  const claimedSuffixes = new Map<string, number>();
  routes.forEach((route, index) => {
    if (!isSafeCaddyTarget({ domain: "x.example", upstream: route.upstream, websocket: route.websocket })) return;
    for (const suffix of route.suffixes) if (okName(suffix) && !claimedSuffixes.has(suffix)) claimedSuffixes.set(suffix, index);
  });
  routes.forEach((route, index) => {
    if (!isSafeCaddyTarget({ domain: "x.example", upstream: route.upstream, websocket: route.websocket })) return;
    const suffixes = [...new Set(route.suffixes)].filter((s) => claimedSuffixes.get(s) === index);
    const hosts = [...new Set(route.hosts)].filter((h) => {
      if (!okName(h) || taken.has(h)) return false;
      // coberto por um curinga DO PRÓPRIO bloco: o curinga já o atende. O de outro projeto não conta: o nome exato vence.
      return !suffixes.some((suffix) => oneLevelUnder(h, suffix));
    });
    for (const h of hosts) taken.add(h);
    const addresses = [...suffixes.map((s) => `*.${s}`), ...hosts];
    if (addresses.length === 0) return;
    lines.push(`${addresses.join(",\n")} {`, "\ttls {", "\t\ton_demand", "\t}");
    pushSiteBody(lines, { domain: "", upstream: route.upstream, websocket: route.websocket, published: route.published ?? true, updating: route.updating === true, stopped: route.stopped === true }, false);
    lines.push("}", "");
  });
}

/** Linhas aceitas numa política MTA-STS: "chave: valor" com caracteres de nome de host. Nada que feche o texto do Caddyfile. */
const SAFE_POLICY_RE = /^[A-Za-z0-9._*: -]+(\r?\n[A-Za-z0-9._*: -]+)*\r?\n?$/;

/**
 * Um bloco por domínio de e-mail com a política MTA-STS: só `/.well-known/mta-sts.txt` responde
 * (text/plain), o resto é 404. Certificado sob demanda: o Caddy só emite depois que o `ask` do
 * painel confirma que `mta-sts.<domínio>` é de um domínio de e-mail cadastrado (e o DNS aponta
 * para a VPS), em vez de tentar na subida e falhar enquanto o registro A não existe.
 */
function pushMtaStsBlocks(lines: string[], sites: CaddyMtaSts[], taken: Set<string>): void {
  for (const site of sites) {
    const host = site.host.toLowerCase();
    if (!host.startsWith("mta-sts.") || !SAFE_DOMAIN_RE.test(host) || host.endsWith(".localhost") || taken.has(host)) continue;
    if (!SAFE_POLICY_RE.test(site.policy)) continue;
    taken.add(host);
    const body = site.policy.replace(/\r\n/g, "\n");
    lines.push(
      `${host} {`,
      "\ttls {",
      "\t\ton_demand",
      "\t}",
      "\thandle /.well-known/mta-sts.txt {",
      '\t\theader Content-Type "text/plain; charset=utf-8"',
      '\t\theader Cache-Control "max-age=300"',
      `\t\trespond \`${body}\` 200`,
      "\t}",
      "\thandle {",
      '\t\trespond "Not found" 404',
      "\t}",
      "}",
      "",
    );
  }
}

/**
 * Renderiza o Caddyfile completo (um bloco por alvo).
 *
 * `panel`: site do próprio painel (acesso por HTTPS). O Caddyfile é regenerado
 * INTEIRO a cada deploy/remoção, então o bloco do painel entra sempre — um
 * deploy nunca apaga o acesso ao painel — e um projeto com o mesmo domínio é
 * descartado (não sequestra o acesso). flush_interval -1: o terminal ao vivo
 * (WebSocket) e os logs em streaming não podem ficar presos em buffer.
 */
export function renderCaddyfile(
  allTargets: CaddyTarget[],
  panel?: PanelSite,
  mailHosts: string[] = [],
  /** Nomes com certificado manual: bloco próprio com `tls <cert> <key>`. */
  manualHosts: string[] = [],
  opts: { webmail?: CaddyWebmail; redirects?: CaddyRedirect[]; dynamic?: CaddyDynamic } = {},
): string {
  const webmail = opts.webmail && SAFE_UPSTREAM_RE.test(opts.webmail.upstream) ? opts.webmail : null;
  const manual = new Set(manualHosts.filter((h) => SAFE_DOMAIN_RE.test(h)));
  const panelTarget: CaddyTarget | null =
    panel && isSafeCaddyTarget({ ...panel, websocket: true })
      ? {
          domain: panel.domain,
          aliases: [...new Set(panel.aliases ?? [])].filter((a) => SAFE_DOMAIN_RE.test(a) && a !== panel.domain),
          upstream: panel.upstream,
          websocket: true,
        }
      : null;
  // Todos os endereços do painel: nenhum projeto pode usar um deles.
  const panelNames = new Set(panelTarget ? [panelTarget.domain, ...(panelTarget.aliases ?? [])] : []);
  const targets: CaddyTarget[] = [
    ...(panelTarget ? [panelTarget] : []),
    ...allTargets
      .filter((t) => isSafeCaddyTarget(t) && !panelNames.has(t.domain))
      // domínio adicional inválido ou igual a um do painel sai; o resto do projeto segue
      .map((t) => ({
        ...t,
        aliases: (t.aliases ?? []).filter((a) => SAFE_DOMAIN_RE.test(a) && !panelNames.has(a) && a !== t.domain),
      })),
  ];
  const lines: string[] = [
    "# Gerado pelo painel PaaS — não editar manualmente.",
    `# Atualizado em ${new Date().toISOString()}`,
    "",
  ];
  for (const target of targets) {
    // Nome com certificado manual sai do bloco automático e ganha bloco
    // próprio (a diretiva tls vale para o bloco inteiro).
    const names = [target.domain, ...(target.aliases ?? [])];
    const auto = names.filter((n) => !manual.has(n));
    const groups: { names: string[]; tls: string | null }[] = [
      ...(auto.length ? [{ names: auto, tls: null }] : []),
      ...names.filter((n) => manual.has(n)).map((n) => {
        const p = manualCertificatePaths(n);
        return { names: [n], tls: `${p.cert} ${p.key}` };
      }),
    ];
    for (const group of groups) {
      lines.push(`${group.names.map(siteAddress).join(", ")} {`);
      if (group.tls) lines.push(`\ttls ${group.tls}`);
      pushSiteBody(lines, target, target === panelTarget);
      lines.push("}", "");
    }
  }
  // Pares (com/sem www): redirecionam para o canônico, que precisa estar servido.
  // Nome já ocupado por um site, pelo painel ou repetido sai (dois blocos com o
  // mesmo nome derrubariam o Caddyfile inteiro); .localhost não tem certificado.
  const served = new Set(targets.flatMap((t) => [t.domain, ...(t.aliases ?? [])]));
  const mailNames = new Set(mailHosts);
  for (const r of opts.redirects ?? []) {
    if (mailNames.has(r.host)) continue; // o servidor de e-mail/webmail tem prioridade sobre um par
    if (!SAFE_DOMAIN_RE.test(r.host) || !SAFE_DOMAIN_RE.test(r.to)) continue;
    if (r.host.endsWith(".localhost") || r.host === "localhost" || r.host === r.to) continue;
    if (!served.has(r.to) || served.has(r.host)) continue;
    served.add(r.host);
    const p = manualCertificatePaths(r.host);
    lines.push(
      `${r.host} {`,
      ...(manual.has(r.host) ? [`\ttls ${p.cert} ${p.key}`] : []),
      `\tredir https://${r.to}{uri} 308`,
      "}",
      "",
    );
  }
  // Servidor de e-mail: o bloco faz o Caddy emitir o certificado de
  // mail.<domínio> (o painel o copia para o Stalwart). Com o webmail ativado,
  // o mesmo bloco encaminha para ele; senão, a página do servidor de e-mail.
  // Nome que já é de um site (ou do painel) sai — o bloco existente já emite
  // o certificado, e dois blocos com o mesmo nome derrubariam o Caddyfile
  // inteiro. .localhost não tem certificado público.
  const taken = served;
  for (const host of mailHosts) {
    if (!SAFE_DOMAIN_RE.test(host) || host.endsWith(".localhost") || taken.has(host)) continue;
    taken.add(host);
    const p = manualCertificatePaths(host);
    lines.push(
      `${host} {`,
      ...(manual.has(host) ? [`\ttls ${p.cert} ${p.key}`] : []),
      ...(webmail
        ? webmailBody(webmail)
        : ['\theader Content-Type "text/html; charset=utf-8"', `\trespond \`${MAIL_HOST_PAGE}\` 200`]),
      "}",
      "",
    );
  }
  // Domínios dinâmicos: emissão sob demanda, autorizada pelo `ask` do painel.
  // Nome já servido por outro bloco (site, painel, par, e-mail) ou repetido sai —
  // dois blocos com o mesmo nome derrubariam o Caddyfile inteiro.
  if (opts.dynamic && SAFE_ASK_URL_RE.test(opts.dynamic.askUrl)) {
    const dynamicLines: string[] = [];
    pushDynamicBlocks(dynamicLines, opts.dynamic.routes, taken);
    pushMtaStsBlocks(dynamicLines, opts.dynamic.mtaSts ?? [], taken);
    if (dynamicLines.length > 0) {
      // Opções globais: o bloco sem endereço precisa ser o primeiro do arquivo.
      lines.splice(3, 0, "{", "\ton_demand_tls {", `\t\task ${opts.dynamic.askUrl}`, "\t}", "}", "");
      lines.push(...dynamicLines);
    }
  }
  // Qualquer outro host em HTTP: domínio que aponta para cá sem estar em
  // projeto nenhum (e o Caddyfile nunca fica sem site).
  lines.push(
    "http:// {",
    '\theader Content-Type "text/html; charset=utf-8"',
    `\trespond \`${UNKNOWN_DOMAIN_PAGE}\` 404`,
    "}",
    "",
  );
  return lines.join("\n");
}

/** Upstream padrão de um projeto a partir do domínio configurado. */
export function projectDomain(project: Pick<Project, "domain" | "slug">): string {
  return project.domain || `${project.slug}.localhost`;
}
