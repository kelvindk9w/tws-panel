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
 *
 * Nome de exibição (pedido do dono, 04/10/2026): o painel grava também
 * paas-identities.json ({endereço: nome}) e instala o plugin paas_identity,
 * que dá esse nome à identidade da caixa no primeiro login e, para quem já
 * entrou antes, só preenche um nome vazio (ver ROUNDCUBE_IDENTITY_PLUGIN).
 */
import { randomBytes } from "node:crypto";
import { BlockList, isIP } from "node:net";
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
/** {endereço: nome de exibição} lido pelo plugin paas_identity (não é *.php: o entrypoint não o inclui). */
export const WEBMAIL_IDENTITIES_FILE = "paas-identities.json";
export const WEBMAIL_IDENTITIES_PATH = `${WEBMAIL_CONFIG_DIR}/${WEBMAIL_IDENTITIES_FILE}`;
/** Plugin do painel (nome = pasta = arquivo = classe, regra do Roundcube). */
export const WEBMAIL_IDENTITY_PLUGIN = "paas_identity";
/**
 * Onde o plugin fica: na fonte da imagem (o entrypoint copia tudo para a
 * pasta servida no primeiro start e a atualiza nos seguintes) e na pasta
 * servida, para valer na hora num container que já subiu.
 */
const PLUGINS_SOURCE_DIR = "/usr/src/roundcubemail/plugins";
const PLUGINS_SERVED_DIR = "/var/www/html/plugins";

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
    set("plugins", phpList(["archive", "zipdownload", WEBMAIL_IDENTITY_PLUGIN])),
    "// Nome de exibição de cada caixa ({endereço: nome}), lido pelo plugin paas_identity.",
    set("paas_identities_file", phpString(WEBMAIL_IDENTITIES_PATH)),
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

const IDENTITY_EMAIL_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}$/;
const NAME_MAX = 100;

/**
 * Conteúdo de paas-identities.json: {endereço: nome de exibição}. Endereço
 * em minúsculas (o plugin compara assim); nome numa linha só, sem
 * caractere de controle, até 100 caracteres. Endereço fora do formato ou
 * nome vazio ficam de fora. Ordem fixa: o arquivo só muda quando um nome muda.
 */
export function renderWebmailIdentities(identities: Record<string, string>): string {
  const clean: Record<string, string> = {};
  for (const [address, name] of Object.entries(identities)) {
    const email = address.trim().toLowerCase();
    if (!IDENTITY_EMAIL_RE.test(email)) continue;
    // eslint-disable-next-line no-control-regex
    const text = name.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, NAME_MAX).trim();
    if (text) clean[email] = text;
  }
  const sorted = Object.fromEntries(Object.keys(clean).sort().map((k) => [k, clean[k]!]));
  return `${JSON.stringify(sorted)}\n`;
}

/**
 * Plugin do Roundcube que dá à caixa o nome de exibição do e-mail do
 * projeto. Mínimo de propósito: só carrega na tela de login, só LÊ o
 * arquivo indicado em `paas_identities_file` e só mexe no nome da
 * identidade da própria caixa que entrou.
 *  - user_create (primeiro login): o nome da identidade criada vem do arquivo;
 *  - login_after (quem já entrou antes): preenche a identidade padrão só se
 *    o nome estiver VAZIO — nunca sobrescreve o que a pessoa escolheu.
 * Conferido no código do Roundcube 1.7.4: rcube_user::create passa
 * 'user_name' ao hook e usa-o como nome da identidade; index.php chama
 * login_after depois do login com sucesso; update_identity grava com
 * parâmetro (sem montar SQL com o nome).
 */
export const ROUNDCUBE_IDENTITY_PLUGIN = `<?php
/**
 * paas_identity — gerado pelo painel TWS; o painel regrava este arquivo.
 * Nome de exibição da caixa a partir do e-mail do projeto.
 */
class paas_identity extends rcube_plugin
{
    public $task = 'login';

    public function init()
    {
        $this->add_hook('user_create', [$this, 'user_create']);
        $this->add_hook('login_after', [$this, 'login_after']);
    }

    /** Nome configurado no painel para o endereço, ou null. */
    private function name_for($email)
    {
        $file = rcube::get_instance()->config->get('paas_identities_file');
        if (!is_string($file) || $file === '' || !is_readable($file)) {
            return null;
        }
        $map = json_decode((string) file_get_contents($file), true);
        if (!is_array($map)) {
            return null;
        }
        $name = $map[strtolower(trim((string) $email))] ?? null;
        return is_string($name) && trim($name) !== '' ? $name : null;
    }

    /** Primeiro login: a identidade nasce com o nome do painel. */
    public function user_create($args)
    {
        if (empty($args['user_name'])) {
            $name = $this->name_for(!empty($args['user_email']) ? $args['user_email'] : ($args['user'] ?? ''));
            if ($name !== null) {
                $args['user_name'] = $name;
            }
        }
        return $args;
    }

    /** Quem já entrou antes: só preenche um nome vazio. */
    public function login_after($args)
    {
        $user = rcmail::get_instance()->user;
        if (!$user || empty($user->ID)) {
            return $args;
        }
        $identity = $user->get_identity();
        if (!is_array($identity) || trim((string) ($identity['name'] ?? '')) !== '') {
            return $args;
        }
        $name = $this->name_for($identity['email'] ?? '');
        if ($name !== null) {
            $user->update_identity($identity['identity_id'], ['name' => $name]);
        }
        return $args;
    }
}
`;

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

/** Faixas que não são da internet (rede do Docker, loopback, link-local, CGNAT, ULA). */
const INTERNAL = new BlockList();
for (const [net, prefix] of [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["127.0.0.0", 8], ["169.254.0.0", 16], ["100.64.0.0", 10], ["0.0.0.0", 8]] as const) {
  INTERNAL.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [["::1", 128], ["fc00::", 7], ["fe80::", 10], ["::", 128]] as const) {
  INTERNAL.addSubnet(net, prefix, "ipv6");
}

/**
 * IP da internet? O bloqueio por senha errada só vale para eles: se o
 * Docker entregar ao Caddy o IP do gateway da rede (proxy de portas do
 * Docker), bloquear esse IP bloquearia todos os visitantes.
 */
export function isPublicIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped) return isPublicIp(mapped);
  return !INTERNAL.check(ip, family === 4 ? "ipv4" : "ipv6");
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
  /** Conteúdo de paas-identities.json (renderWebmailIdentities); padrão: nenhum nome. */
  identities?: string;
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
   * Entrega paas.php e paas-identities.json (0644: o Apache roda como
   * www-data e o arquivo chega com dono root) e o plugin paas_identity. Vale
   * na próxima requisição, sem reiniciar.
   *
   * O plugin vai para a fonte da imagem e, se o container já subiu alguma
   * vez (`served`), também para a pasta servida. Antes do primeiro start a
   * pasta servida está vazia e não pode ganhar nada: o entrypoint copia a
   * fonte para lá só se ela estiver vazia (senão espera 10 s com um aviso).
   */
  async pushConfig(opts: { served?: boolean } = {}): Promise<void> {
    // o plugin antes da configuração que o liga: num container que já roda
    // (atualização do painel), nenhuma requisição pede um plugin que não existe
    const plugin = [
      { name: `${WEBMAIL_IDENTITY_PLUGIN}/`, mode: 0o755 },
      { name: `${WEBMAIL_IDENTITY_PLUGIN}/${WEBMAIL_IDENTITY_PLUGIN}.php`, content: ROUNDCUBE_IDENTITY_PLUGIN, mode: 0o644 },
    ];
    for (const dir of opts.served === false ? [PLUGINS_SOURCE_DIR] : [PLUGINS_SOURCE_DIR, PLUGINS_SERVED_DIR]) {
      const r = await copyFilesToContainer(this.containerName, dir, plugin);
      // criado e nunca iniciado: a pasta servida ainda não existe (o start a cria com o plugin)
      if (r.code === 0 || (dir === PLUGINS_SERVED_DIR && /could not find|no such file/i.test(r.stderr))) continue;
      throw new Error(`falha ao instalar o plugin do webmail em ${this.containerName}: ${r.stderr.trim()}`);
    }
    const cp = await copyFilesToContainer(this.containerName, WEBMAIL_CONFIG_DIR, [
      { name: WEBMAIL_CONFIG_FILE, content: this.opts.config, mode: 0o644 },
      { name: WEBMAIL_IDENTITIES_FILE, content: this.opts.identities ?? "{}\n", mode: 0o644 },
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
    await this.pushConfig({ served: false });
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
