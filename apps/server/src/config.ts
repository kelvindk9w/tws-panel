import path from "node:path";
import {
  MAIL_DEFAULT_PORTS,
  MONITOR_DEFAULT_INTERVAL_MS,
  SETUP_PORT,
  SETUP_TOKEN_FILE,
  TERMINAL_ROOT_MODES,
  isTerminalRootMode,
  isValidSshUsername,
  type MailServerPorts,
  type TerminalInfoResponse,
  type TerminalRootMode,
} from "@paas/core";

/** Configuração inválida: a inicialização para com uma mensagem acionável. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface ServerConfig {
  port: number;
  host: string;
  /** Diretório de dados de runtime (setup-state.json, etc.). */
  dataDir: string;
  /**
   * Diretório onde vive o código dos projetos gerenciados.
   *
   * Em produção é um caminho REAL do host, montado no container com o mesmo
   * caminho dos dois lados (ver docker-compose.yml): o daemon Docker resolve
   * os bind mounts declarados no compose do usuário NO HOST, então um caminho
   * que só existisse dentro do container quebraria qualquer projeto que use
   * `./dados:/app/dados`.
   *
   * Sem PAAS_PROJECTS_DIR o valor é exatamente o de antes (<dataDir>/projects).
   * Isso não é cosmético: uma instalação existente que só rodou `git pull`
   * continua achando os projetos que já clonou, em vez de perdê-los em
   * silêncio.
   */
  projectsDir: string;
  /** Diretório do build do frontend (SPA). */
  webDist: string;
  /** Origens extras permitidas no CORS (ex.: dev do Vite). */
  allowedOrigins: string[];
  setupTokenFile: string;
  /**
   * Alvo do hardening: "container" (padrão — container Docker descartável,
   * seguro para desenvolvimento) ou "host" (somente quando explicitamente
   * configurado via PAAS_TARGET=host).
   */
  securityTarget: "container" | "host";
  /** Nome do container alvo quando securityTarget=container. */
  securityTargetContainer: string;
  /** Diretório local dos scripts de hardening. */
  hardeningScriptsDir: string;
  /**
   * Imagem do helper descartável do host bridge (nsenter no PID 1 do host).
   * Só usada quando securityTarget=host.
   */
  hostHelperImage: string;
  /**
   * Caminho do checkout do repo NO HOST (onde install.sh clonou o projeto) —
   * usado para montar os comandos do modo manual de cada fase.
   */
  hostRepoDir: string;
  /** Porta HTTP publicada do Caddy central (80 em produção; configurável em dev). */
  caddyHttpPort: number;
  /** Porta HTTPS publicada do Caddy central (443 em produção). */
  caddyHttpsPort: number;
  /** Portas publicadas do Stalwart no host (25/587/465/143/993/8080 em produção; altas em dev). */
  mailPorts: MailServerPorts;
  /** Hostname do servidor de e-mail (PAAS_MAIL_HOSTNAME ou derivado do 1º domínio). */
  mailHostname: string | null;
  /** IPv4 público da máquina para o checklist DNS (PAAS_PUBLIC_IP). */
  publicIp: string | null;
  /** IPv6 público da máquina (opcional — PAAS_PUBLIC_IPV6). */
  publicIpv6: string | null;
  /** Intervalo inicial do scan recorrente de segurança (ms). Persistido depois. */
  monitorIntervalMs: number;
  /** Caminho do unix socket do Docker (terminal web, host bridge, deploys). */
  dockerSocketPath: string;
  /** Timeout de inatividade da sessão do terminal web (ms). Default 30 min. */
  terminalIdleTimeoutMs: number;
  /**
   * Usuário com que o terminal web abre na VPS (PAAS_TERMINAL_USER).
   *
   * null = variável ausente/vazia: comportamento LEGADO, idêntico ao de antes
   * de a escolha existir (terminal root, varredura e fases digitadas nele).
   * Uma instalação que só rodou `git pull` não muda de comportamento em
   * silêncio. "root" é aceito como escolha explícita (desaconselhada).
   */
  terminalUser: string | null;
  /**
   * Como os comandos que precisam de root rodam quando o terminal NÃO é root
   * (PAAS_ROOT_MODE): "senha" (sudo no próprio terminal, recomendado) ou
   * "segundo-plano" (host bridge, com espelho só de visualização). null
   * quando o terminal é root (legado ou explícito) — aí o modo não se aplica.
   */
  terminalRootMode: TerminalRootMode | null;
}

/**
 * Lê e valida PAAS_TERMINAL_USER / PAAS_ROOT_MODE. Nunca adivinha: valor
 * inválido, ou usuário comum sem modo, para a inicialização com ConfigError.
 */
function loadTerminalAccess(env: NodeJS.ProcessEnv): Pick<ServerConfig, "terminalUser" | "terminalRootMode"> {
  const rawUser = env.PAAS_TERMINAL_USER ?? "";
  const rawMode = env.PAAS_ROOT_MODE ?? "";
  const modes = TERMINAL_ROOT_MODES.join(" ou ");

  // Modo com erro de digitação é rejeitado mesmo quando não se aplica: um
  // "senhaa" esquecido no .env viraria surpresa no dia em que o usuário
  // fosse definido.
  if (rawMode !== "" && !isTerminalRootMode(rawMode)) {
    throw new ConfigError(
      `PAAS_ROOT_MODE inválido (${JSON.stringify(rawMode)}): use ${modes}. ` +
        `"senha" (recomendado) roda o que precisa de root com sudo no próprio terminal; ` +
        `"segundo-plano" roda pelo host bridge como root e só espelha a saída no terminal.`,
    );
  }

  if (rawUser === "") return { terminalUser: null, terminalRootMode: null };
  if (rawUser === "root") return { terminalUser: "root", terminalRootMode: null };

  if (!isValidSshUsername(rawUser)) {
    throw new ConfigError(
      `PAAS_TERMINAL_USER inválido (${JSON.stringify(rawUser)}): informe "root" ou um usuário Linux existente na VPS ` +
        `(minúsculas, começando com letra ou "_", até 32 caracteres: letras, números, "_" e "-").`,
    );
  }
  if (rawMode === "") {
    throw new ConfigError(
      `PAAS_TERMINAL_USER=${rawUser} exige PAAS_ROOT_MODE=senha (recomendado: o sudo pede a sua senha no próprio terminal) ` +
        `ou PAAS_ROOT_MODE=segundo-plano (a varredura e as fases rodam como root pelo host bridge, auditadas). ` +
        `O painel não escolhe por você.`,
    );
  }
  return { terminalUser: rawUser, terminalRootMode: rawMode as TerminalRootMode };
}

/**
 * Deriva quem é o terminal DE FATO e como a elevação acontece. No alvo
 * container (dev) usuário e modo não se aplicam: o terminal continua sendo o
 * shell do container descartável, como sempre foi.
 */
export function resolveTerminalAccess(
  config: Pick<ServerConfig, "securityTarget" | "terminalUser" | "terminalRootMode">,
): TerminalInfoResponse {
  const common = {
    target: config.securityTarget,
    configuredUser: config.terminalUser,
    scheduledMonitoringRunsAsRoot: true as const,
  };
  if (config.securityTarget !== "host") {
    return { ...common, user: "root", rootMode: null, elevation: "container-dev" };
  }
  if (config.terminalUser === null) {
    return { ...common, user: "root", rootMode: null, elevation: "root-legado" };
  }
  if (config.terminalUser === "root") {
    return { ...common, user: "root", rootMode: null, elevation: "root" };
  }
  if (config.terminalRootMode === null) {
    // Inalcançável via loadConfig (que já recusa); protege config montada à
    // mão de cair em root por omissão.
    throw new ConfigError(`PAAS_TERMINAL_USER=${config.terminalUser} exige PAAS_ROOT_MODE (senha ou segundo-plano).`);
  }
  return {
    ...common,
    user: config.terminalUser,
    rootMode: config.terminalRootMode,
    elevation: config.terminalRootMode,
  };
}

export function loadConfig(): ServerConfig {
  const dataDir = path.resolve(process.env.PAAS_DATA_DIR ?? "../../data");
  return {
    port: Number(process.env.PORT ?? SETUP_PORT),
    host: process.env.HOST ?? "0.0.0.0",
    dataDir,
    projectsDir: path.resolve(process.env.PAAS_PROJECTS_DIR ?? path.join(dataDir, "projects")),
    webDist: path.resolve(process.env.WEB_DIST ?? "../web/dist"),
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
    setupTokenFile: process.env.SETUP_TOKEN_FILE ?? SETUP_TOKEN_FILE,
    securityTarget: process.env.PAAS_TARGET === "host" ? "host" : "container",
    securityTargetContainer: process.env.PAAS_TARGET_CONTAINER ?? "paas-target-test",
    hardeningScriptsDir: path.resolve(process.env.PAAS_SCRIPTS_DIR ?? "../../scripts/hardening"),
    hostHelperImage: process.env.PAAS_HOST_HELPER_IMAGE ?? "alpine:3",
    hostRepoDir: process.env.PAAS_HOST_REPO_DIR ?? "/opt/tws-panel",
    caddyHttpPort: Number(process.env.PAAS_CADDY_HTTP_PORT ?? 80),
    caddyHttpsPort: Number(process.env.PAAS_CADDY_HTTPS_PORT ?? 443),
    mailPorts: {
      smtp: Number(process.env.PAAS_STALWART_PORT_SMTP ?? MAIL_DEFAULT_PORTS.smtp),
      submission: Number(process.env.PAAS_STALWART_PORT_SUBMISSION ?? MAIL_DEFAULT_PORTS.submission),
      submissions: Number(process.env.PAAS_STALWART_PORT_SUBMISSIONS ?? MAIL_DEFAULT_PORTS.submissions),
      imap: Number(process.env.PAAS_STALWART_PORT_IMAP ?? MAIL_DEFAULT_PORTS.imap),
      imaps: Number(process.env.PAAS_STALWART_PORT_IMAPS ?? MAIL_DEFAULT_PORTS.imaps),
      http: Number(process.env.PAAS_STALWART_PORT_HTTP ?? MAIL_DEFAULT_PORTS.http),
    },
    mailHostname: process.env.PAAS_MAIL_HOSTNAME?.trim() || null,
    publicIp: process.env.PAAS_PUBLIC_IP?.trim() || null,
    publicIpv6: process.env.PAAS_PUBLIC_IPV6?.trim() || null,
    monitorIntervalMs: Number(process.env.PAAS_MONITOR_INTERVAL_MS ?? MONITOR_DEFAULT_INTERVAL_MS),
    dockerSocketPath: process.env.DOCKER_SOCKET_PATH ?? "/var/run/docker.sock",
    terminalIdleTimeoutMs: Number(process.env.PAAS_TERMINAL_IDLE_TIMEOUT_MS ?? 30 * 60_000),
    ...loadTerminalAccess(process.env),
  };
}
