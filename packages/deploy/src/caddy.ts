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
  /**
   * Site do PRÓPRIO painel (acesso por HTTPS, ex.: <ip-com-hífens>.sslip.io
   * → tws-panel:9000). Entra em todo Caddyfile gerado — ver renderCaddyfile.
   */
  panelSite?: PanelSite;
}

/** Domínio do painel servido pelo Caddy central e o upstream dele na paas-net. */
export interface PanelSite {
  domain: string;
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
  private readonly dataVolume: string;
  private readonly configVolume: string;
  private readonly panelSite: PanelSite | undefined;

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
    this.panelSite = options.panelSite;
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

  /**
   * Garante `container` na rede do Caddy. O docker-compose.yml do painel NÃO
   * declara a paas-net: numa instalação que nunca fez deploy a rede não existe,
   * e um `compose up` com rede externa inexistente falharia na atualização.
   */
  async connectToNetwork(container: string): Promise<void> {
    const inspect = await run("docker", ["inspect", "-f", "{{json .NetworkSettings.Networks}}", container]);
    if (inspect.code === 0) {
      try {
        const networks = JSON.parse(inspect.stdout.trim() || "{}") as Record<string, unknown>;
        if (Object.prototype.hasOwnProperty.call(networks, this.network)) return;
      } catch {
        // saída inesperada: tenta conectar (o daemon recusa se já estiver)
      }
    }
    const connect = await run("docker", ["network", "connect", this.network, container]);
    if (connect.code !== 0) {
      throw new Error(`falha ao conectar ${container} à rede ${this.network}: ${connect.stderr.trim()}`);
    }
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

  /**
   * Gera o Caddyfile a partir dos alvos e recarrega o Caddy sem downtime.
   * `mailHosts`: hostnames do servidor de e-mail (ver renderCaddyfile).
   */
  async apply(targets: CaddyTarget[], onLog?: (chunk: string) => void, mailHosts: string[] = []): Promise<void> {
    const content = renderCaddyfile(targets, this.panelSite, mailHosts);
    await this.ensureRunning(content);
    // O Caddy alcança o painel pelo nome do container na paas-net.
    if (this.panelSite) await this.connectToNetwork(this.panelSite.upstream.split(":")[0] ?? "");
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
}): string {
  const font = "font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif";
  return [
    "<!doctype html>",
    '<html lang="pt-BR"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    opts.refresh ? '<meta http-equiv="refresh" content="60">' : "",
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
    `<p style="margin:0 0 28px;font-size:13px;line-height:1.5;color:#94a3b8">${opts.hint}</p>`,
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
});

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

/**
 * Renderiza o Caddyfile completo (um bloco por alvo).
 *
 * `panel`: site do próprio painel (acesso por HTTPS). O Caddyfile é regenerado
 * INTEIRO a cada deploy/remoção, então o bloco do painel entra sempre — um
 * deploy nunca apaga o acesso ao painel — e um projeto com o mesmo domínio é
 * descartado (não sequestra o acesso). flush_interval -1: o terminal ao vivo
 * (WebSocket) e os logs em streaming não podem ficar presos em buffer.
 */
export function renderCaddyfile(allTargets: CaddyTarget[], panel?: PanelSite, mailHosts: string[] = []): string {
  const panelTarget =
    panel && isSafeCaddyTarget({ ...panel, websocket: true }) ? { ...panel, websocket: true } : null;
  const targets: CaddyTarget[] = [
    ...(panelTarget ? [panelTarget] : []),
    ...allTargets
      .filter((t) => isSafeCaddyTarget(t) && t.domain !== panelTarget?.domain)
      // domínio adicional inválido ou igual ao do painel sai; o resto do projeto segue
      .map((t) => ({
        ...t,
        aliases: (t.aliases ?? []).filter(
          (a) => SAFE_DOMAIN_RE.test(a) && a !== panelTarget?.domain && a !== t.domain,
        ),
      })),
  ];
  const lines: string[] = [
    "# Gerado pelo painel PaaS — não editar manualmente.",
    `# Atualizado em ${new Date().toISOString()}`,
    "",
  ];
  for (const target of targets) {
    lines.push(`${[target.domain, ...(target.aliases ?? [])].map(siteAddress).join(", ")} {`);
    if (target.websocket) {
      // WebSocket funciona nativamente; flush_interval -1 desativa buffer para
      // streaming/longs polls, e conexões hijacked (WS) não têm timeout de leitura.
      lines.push(`\treverse_proxy ${target.upstream} {`, "\t\tflush_interval -1", "}");
    } else {
      lines.push(`\treverse_proxy ${target.upstream}`);
    }
    if (target !== panelTarget) {
      // sem resposta do app: página neutra em vez do erro cru do proxy —
      // "em manutenção" se nunca foi publicado, senão "indisponível"
      const page = target.published === false ? PROJECT_PENDING_PAGE : PROJECT_DOWN_PAGE;
      lines.push(
        "\thandle_errors 502 503 504 {",
        '\t\theader Content-Type "text/html; charset=utf-8"',
        `\t\trespond \`${page}\` 503`,
        "\t}",
      );
    }
    lines.push("}", "");
  }
  // Servidor de e-mail: só para o Caddy emitir o certificado de mail.<domínio>.
  // Nome que já é de um site (ou do painel) sai — o bloco existente já emite
  // o certificado, e dois blocos com o mesmo nome derrubariam o Caddyfile
  // inteiro. .localhost não tem certificado público.
  const taken = new Set(targets.flatMap((t) => [t.domain, ...(t.aliases ?? [])]));
  for (const host of mailHosts) {
    if (!SAFE_DOMAIN_RE.test(host) || host.endsWith(".localhost") || taken.has(host)) continue;
    taken.add(host);
    lines.push(
      `${host} {`,
      '\theader Content-Type "text/html; charset=utf-8"',
      `\trespond \`${MAIL_HOST_PAGE}\` 200`,
      "}",
      "",
    );
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
