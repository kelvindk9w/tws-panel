/**
 * webmail.ts — webmail (Roundcube) em container, gerenciado pelo painel.
 *
 * Pedido do dono do produto (04/10/2026): ler, responder e enviar e-mail das
 * caixas pelo navegador, sem configurar Outlook/Gmail. O container fica na
 * paas-net SEM porta publicada; o Caddy central o serve em
 * https://mail.<domínio>/ (o mesmo bloco que emite o certificado do
 * Stalwart). Ele fala só com o servidor de e-mail do painel, por TLS
 * implícito (IMAP 993, SMTP 465), com o mesmo login nos dois.
 *
 * Por que Roundcube (e não SnappyMail): imagem oficial mantida pelo próprio
 * projeto, com versão de segurança mês a mês em 2026 (1.7.4 em 06/09/2026);
 * SQLite embutido (sem banco externo); sem painel administrativo (o
 * instalador vem desligado); usuário preenchido por URL (`?_user=`). O
 * SnappyMail não publica versão desde 2.38.2 (out/2024) e tem um painel de
 * administração na própria URL. Fontes no relatório
 * comoFuncionaSistema/_RELATORIO-webmail.md.
 *
 * A configuração do painel vai para /var/roundcube/config/paas.php pelo
 * daemon (`docker cp`): o entrypoint da imagem inclui todo *.php dessa pasta
 * DEPOIS dos valores das variáveis de ambiente, e o PHP relê o arquivo a
 * cada requisição — trocar o arquivo vale na hora, sem reiniciar.
 */
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { PAAS_LABEL_MANAGED, PAAS_NETWORK, PAAS_WEBMAIL_CONTAINER, PAAS_WEBMAIL_VOLUME } from "@paas/core";
import { copyFilesToContainer } from "./container-files.js";
import { run } from "./exec.js";

/**
 * Roundcube 1.7.4 (versão de segurança de 06/09/2026), variante Apache que
 * roda sem root (usuário www-data, porta 8000). Tag E digest: a imagem não
 * muda por baixo do painel. Trocar de versão = trocar as duas e conferir.
 */
export const ROUNDCUBE_IMAGE =
  "roundcube/roundcubemail:1.7.4-apache-nonroot@sha256:533b48d35f8fef99f24ae6997a032a727888d6992bd55a1a0a24d1ea208dbf3f";

/** Raiz dos dados do Roundcube na imagem (pastas config/ e db/; dono www-data). */
export const WEBMAIL_DATA_DIR = "/var/roundcube";
/** Pasta lida pelo entrypoint: todo *.php daqui é incluído na configuração. */
export const WEBMAIL_CONFIG_DIR = `${WEBMAIL_DATA_DIR}/config`;
export const WEBMAIL_CONFIG_FILE = "paas.php";

/** Faixas privadas: o Caddy chega ao webmail pela paas-net, com IP de uma delas. */
const PRIVATE_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];

const SAFE_HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Texto PHP entre aspas simples (só \ e ' têm significado ali). */
export function phpString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function phpList(values: string[]): string {
  return `[${values.map(phpString).join(", ")}]`;
}

/** Chave da cifra da sessão (AES-256-CBC pede 32 caracteres). */
export function generateDesKey(): string {
  return randomBytes(24).toString("base64url");
}

export interface RoundcubeConfigInput {
  /** Nome do servidor de e-mail na paas-net (alias do paas-stalwart). */
  imapHost: string;
  /**
   * true = o certificado de `imapHost` já está instalado no Stalwart: a
   * conexão confere cadeia e nome. false = ainda autoassinado: cifra, mas
   * sem conferir (a conexão não sai da paas-net).
   */
  verifyTls: boolean;
  /** Chave da cifra da sessão (32 caracteres). */
  desKey: string;
  /** Nomes aceitos no cabeçalho Host (mail.<domínio> de cada domínio). */
  trustedHosts: string[];
}

function assertHost(host: string): void {
  if (!SAFE_HOST_RE.test(host)) throw new Error(`nome de host inválido para o webmail: ${JSON.stringify(host)}`);
}

function tlsOptions(host: string, verify: boolean): string {
  return verify
    ? `['ssl' => ['verify_peer' => true, 'verify_peer_name' => true, 'peer_name' => ${phpString(host)}]]`
    : "['ssl' => ['verify_peer' => false, 'verify_peer_name' => false, 'allow_self_signed' => true]]";
}

/** Configuração do Roundcube gerada pelo painel (determinística). */
export function renderRoundcubeConfig(input: RoundcubeConfigInput): string {
  assertHost(input.imapHost);
  input.trustedHosts.forEach(assertHost);
  if (input.desKey.length < 32) throw new Error("chave da sessão do webmail curta demais (mínimo 32 caracteres).");
  const host = input.imapHost;
  const set = (key: string, value: string) => `$config['${key}'] = ${value};`;
  return [
    "<?php",
    "// Gerado pelo painel TWS — não editar: o painel regrava este arquivo.",
    "",
    "// Só o servidor de e-mail do painel, pela rede interna, com TLS implícito.",
    set("imap_host", phpString(`ssl://${host}:993`)),
    set("imap_conn_options", tlsOptions(host, input.verifyTls)),
    set("smtp_host", phpString(`ssl://${host}:465`)),
    set("smtp_conn_options", tlsOptions(host, input.verifyTls)),
    set("smtp_user", "'%u'"),
    set("smtp_pass", "'%p'"),
    "",
    "// Nada de instalador, cadastro ou plugin além do necessário.",
    set("enable_installer", "false"),
    set("plugins", phpList(["archive", "zipdownload"])),
    set("enable_spellcheck", "false"),
    set("auto_create_user", "true"),
    set("login_username_filter", "'email'"),
    set("identities_level", "3"),
    set("product_name", "'Webmail'"),
    set("display_product_info", "0"),
    set("support_url", "''"),
    set("language", "'pt_BR'"),
    set("skin", "'elastic'"),
    "",
    "// Sessão curta, cookie só por HTTPS e limite de senhas erradas por caixa.",
    set("session_lifetime", "10"),
    set("session_samesite", "'Strict'"),
    set("use_https", "true"),
    set("x_frame_options", "'deny'"),
    set("login_rate_limit", "3"),
    set("log_logins", "true"),
    set("trusted_host_patterns", phpList(input.trustedHosts)),
    set("proxy_whitelist", phpList(PRIVATE_RANGES)),
    "",
    set("des_key", phpString(input.desKey)),
    set("cipher_method", "'AES-256-CBC'"),
    "",
  ].join("\n");
}

/** Uma tentativa de login recusada, com o IP de quem tentou. */
export interface FailedLogin {
  ip: string;
  user: string;
}

/**
 * Linha do Roundcube (log_logins / falha de login):
 * "Failed login for <usuário> from <REMOTE_ADDR> (X-Forwarded-For: <ip>) in session <id> (error: <n>)".
 * O REMOTE_ADDR é o Caddy (rede interna); quem tentou é o último IP do
 * X-Forwarded-For — o Caddy substitui o que o visitante mandar.
 */
const FAILED_RE = /Failed login for (\S{1,300}) from (\S+)(?: \(([^)]*)\))? in session \S+ \(error: -?\d+\)/;

function clientIp(remote: string, extra: string | undefined): string | null {
  const xff = /X-Forwarded-For: ([^)]*)$/.exec(extra ?? "")?.[1];
  const candidate = xff ? xff.slice(xff.lastIndexOf(",") + 1).trim() : remote;
  return isIP(candidate) ? candidate : null;
}

export function parseFailedLogins(log: string): FailedLogin[] {
  const found: FailedLogin[] = [];
  for (const line of log.split("\n")) {
    const m = FAILED_RE.exec(line);
    if (!m) continue;
    const ip = clientIp(m[2]!, m[3]);
    if (ip) found.push({ ip, user: m[1]! });
  }
  return found;
}

export interface WebmailManagerOptions {
  /** Conteúdo de paas.php (renderRoundcubeConfig). */
  config: string;
  image?: string;
  containerName?: string;
  network?: string;
  dataVolume?: string;
}

export class WebmailManager {
  readonly image: string;
  readonly containerName: string;
  private readonly network: string;
  private readonly dataVolume: string;

  constructor(private readonly opts: WebmailManagerOptions) {
    this.image = opts.image ?? ROUNDCUBE_IMAGE;
    this.containerName = opts.containerName ?? PAAS_WEBMAIL_CONTAINER;
    this.network = opts.network ?? PAAS_NETWORK;
    this.dataVolume = opts.dataVolume ?? PAAS_WEBMAIL_VOLUME;
  }

  private async ensureNetwork(): Promise<void> {
    if ((await run("docker", ["network", "inspect", this.network])).code === 0) return;
    const create = await run("docker", ["network", "create", "--label", `${PAAS_LABEL_MANAGED}=true`, this.network]);
    if (create.code !== 0) throw new Error(`falha ao criar a rede ${this.network}: ${create.stderr}`);
  }

  async status(): Promise<{ installed: boolean; running: boolean }> {
    const inspect = await run("docker", ["inspect", "-f", "{{.State.Running}}", this.containerName]);
    if (inspect.code !== 0) return { installed: false, running: false };
    return { installed: true, running: inspect.stdout.trim() === "true" };
  }

  /**
   * Entrega paas.php (0644: o Apache roda como www-data e o arquivo chega
   * com dono root). Vale na próxima requisição, sem reiniciar.
   */
  async pushConfig(): Promise<void> {
    const cp = await copyFilesToContainer(this.containerName, WEBMAIL_CONFIG_DIR, [
      { name: WEBMAIL_CONFIG_FILE, content: this.opts.config, mode: 0o644 },
    ]);
    if (cp.code !== 0) {
      throw new Error(`falha ao gravar a configuração em ${this.containerName}: ${cp.stderr.trim()}`);
    }
  }

  /**
   * Sobe (ou garante) o container. A config vai ANTES do primeiro start: o
   * entrypoint só inclui os arquivos que existem quando ele roda.
   */
  async start(): Promise<void> {
    await this.ensureNetwork();
    const current = await this.status();
    if (current.installed) {
      await this.pushConfig();
      if (current.running) return;
      if ((await run("docker", ["start", this.containerName])).code === 0) return;
      // não sobe (imagem trocada, estado quebrado): recria — os dados ficam no volume
      await run("docker", ["rm", "-f", this.containerName]);
    }
    const create = await run("docker", [
      "create",
      "--name",
      this.containerName,
      "--restart",
      "unless-stopped",
      "--network",
      this.network,
      // sem -p: só o Caddy (paas-net) alcança o webmail
      "-v",
      `${this.dataVolume}:${WEBMAIL_DATA_DIR}`,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--memory",
      "256m",
      "--label",
      `${PAAS_LABEL_MANAGED}=true`,
      "--label",
      "paas.role=webmail",
      this.image,
    ]);
    if (create.code !== 0) throw new Error(`falha ao criar ${this.containerName}: ${create.stderr}`);
    await this.pushConfig();
    const start = await run("docker", ["start", this.containerName]);
    if (start.code !== 0) throw new Error(`falha ao iniciar ${this.containerName}: ${start.stderr}`);
  }

  async stop(): Promise<void> {
    const stop = await run("docker", ["stop", this.containerName], { timeoutMs: 60_000 });
    if (stop.code !== 0 && !/no such container/i.test(stop.stderr)) {
      throw new Error(`falha ao parar ${this.containerName}: ${stop.stderr}`);
    }
  }

  /** Remove o container (o volume com preferências e contatos fica). */
  async remove(): Promise<void> {
    const rm = await run("docker", ["rm", "-f", this.containerName]);
    if (rm.code !== 0 && !/no such container/i.test(rm.stderr)) {
      throw new Error(`falha ao remover ${this.containerName}: ${rm.stderr}`);
    }
  }

  /** IP do webmail na paas-net (null se não estiver nela). */
  async internalIp(): Promise<string | null> {
    const inspect = await run("docker", ["inspect", "-f", "{{json .NetworkSettings.Networks}}", this.containerName]);
    if (inspect.code !== 0) return null;
    try {
      const networks = JSON.parse(inspect.stdout.trim()) as Record<string, { IPAddress?: string }>;
      const ip = networks[this.network]?.IPAddress ?? "";
      return isIP(ip) ? ip : null;
    } catch {
      return null;
    }
  }

  /** Log do webmail desde `sinceUnix` (segundos). Texto não confiável. */
  async logsSince(sinceUnix: number): Promise<string> {
    const r = await run("docker", ["logs", "--since", String(sinceUnix), this.containerName]);
    if (r.code !== 0) return "";
    return `${r.stdout}\n${r.stderr}`;
  }
}
