/**
 * container-logs.ts — limite do log de cada container que o painel cria.
 *
 * O driver padrão do Docker (json-file) guarda a saída do container num arquivo
 * que cresce sem limite e pode encher o disco da VPS. O painel declara, em todo
 * container que ele cria (serviços do compose dos projetos, containers de
 * Dockerfile/Next/estático, Caddy, Stalwart, webmail, Mailpit, descartáveis),
 * o MESMO driver json-file com rotação: `max-size` por arquivo e `max-file`
 * arquivos. Não troca de driver: a aba Logs e o `docker logs` seguem lendo o
 * json-file como sempre.
 *
 * Vale para o container criado (ou recriado) depois da atualização: o Docker
 * não muda o log de um container que já existe.
 *
 * Configuração (env do painel, no .env da instalação):
 *  - PAAS_LOG_MAX_SIZE: tamanho de cada arquivo (número + k, m ou g; padrão 10m);
 *    "off" = o painel não declara limite (vale o padrão do daemon, ex.: daemon.json);
 *  - PAAS_LOG_MAX_FILE: quantos arquivos guardar (1 a 20; padrão 3).
 * Valor inválido: o painel usa o padrão e avisa na subida (containerLogLimitsIssues).
 */

export interface ContainerLogLimits {
  /** Tamanho de cada arquivo de log (ex.: "10m"). */
  maxSize: string;
  /** Quantos arquivos o Docker guarda (o atual + os rotacionados). */
  maxFile: number;
}

export const CONTAINER_LOG_DEFAULTS: ContainerLogLimits = { maxSize: "10m", maxFile: 3 };

/**
 * Label que o painel grava no serviço do compose que declara `logging:` próprio (respeitado, sem o limite do
 * painel): o aviso da subida não acusa esse container de "sem limite" (a escolha é do projeto).
 */
export const TWS_LABEL_LOG_OWN = "tws.log.own";

/** Driver que o painel declara: o padrão do Docker, que a aba Logs lê. */
export const CONTAINER_LOG_DRIVER = "json-file";

const MAX_FILE_LIMITS = { min: 1, max: 20 } as const;

type Env = Record<string, string | undefined>;

function validSize(value: string): boolean {
  return /^[1-9][0-9]{0,5}[kmg]$/.test(value);
}

function validFile(value: string): boolean {
  if (!/^[0-9]{1,2}$/.test(value)) return false;
  const n = Number(value);
  return n >= MAX_FILE_LIMITS.min && n <= MAX_FILE_LIMITS.max;
}

/** Limite em vigor (null = desligado com PAAS_LOG_MAX_SIZE=off). Vazio ou inválido = o padrão. */
export function containerLogLimits(env: Env = process.env): ContainerLogLimits | null {
  const size = (env.PAAS_LOG_MAX_SIZE ?? "").trim().toLowerCase();
  if (size === "off") return null;
  const file = (env.PAAS_LOG_MAX_FILE ?? "").trim();
  return {
    maxSize: validSize(size) ? size : CONTAINER_LOG_DEFAULTS.maxSize,
    maxFile: validFile(file) ? Number(file) : CONTAINER_LOG_DEFAULTS.maxFile,
  };
}

/** Avisos da subida: valores descartados (o painel usa o padrão no lugar). */
export function containerLogLimitsIssues(env: Env = process.env): string[] {
  const issues: string[] = [];
  const size = (env.PAAS_LOG_MAX_SIZE ?? "").trim().toLowerCase();
  const file = (env.PAAS_LOG_MAX_FILE ?? "").trim();
  if (size !== "" && size !== "off" && !validSize(size)) {
    issues.push(
      `PAAS_LOG_MAX_SIZE="${env.PAAS_LOG_MAX_SIZE}" foi descartada (use um número com k, m ou g, ex.: 10m, ou "off"); o painel usa ${CONTAINER_LOG_DEFAULTS.maxSize}.`,
    );
  }
  if (file !== "" && !validFile(file)) {
    issues.push(
      `PAAS_LOG_MAX_FILE="${env.PAAS_LOG_MAX_FILE}" foi descartada (use um inteiro de ${MAX_FILE_LIMITS.min} a ${MAX_FILE_LIMITS.max}); o painel usa ${CONTAINER_LOG_DEFAULTS.maxFile}.`,
    );
  }
  return issues;
}

/** Argumentos de `docker run`/`docker create` com o limite (vazio quando desligado). */
export function dockerLogArgs(limits: ContainerLogLimits | null = containerLogLimits()): string[] {
  if (!limits) return [];
  return ["--log-driver", CONTAINER_LOG_DRIVER, "--log-opt", `max-size=${limits.maxSize}`, "--log-opt", `max-file=${limits.maxFile}`];
}

/** Bloco `logging:` de um serviço do compose (null quando desligado). */
export function composeLogging(limits: ContainerLogLimits | null = containerLogLimits()): { driver: string; options: Record<string, string> } | null {
  if (!limits) return null;
  return { driver: CONTAINER_LOG_DRIVER, options: { "max-size": limits.maxSize, "max-file": String(limits.maxFile) } };
}

/** `HostConfig.LogConfig` da API do Docker (undefined quando desligado). */
export function dockerApiLogConfig(limits: ContainerLogLimits | null = containerLogLimits()): { Type: string; Config: Record<string, string> } | undefined {
  if (!limits) return undefined;
  return { Type: CONTAINER_LOG_DRIVER, Config: { "max-size": limits.maxSize, "max-file": String(limits.maxFile) } };
}

/**
 * O container existente já tem o limite em vigor? Recebe a saída de
 * `docker inspect -f '{{json .HostConfig.LogConfig}}'`. Desligado = sempre sim
 * (não há o que aplicar). Saída ilegível = não (quem chama decide o que fazer).
 */
export function hasContainerLogLimits(inspectJson: string, limits: ContainerLogLimits | null = containerLogLimits()): boolean {
  if (!limits) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(inspectJson.trim());
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const cfg = parsed as { Type?: unknown; Config?: unknown };
  const opts = (typeof cfg.Config === "object" && cfg.Config !== null ? cfg.Config : {}) as Record<string, unknown>;
  return cfg.Type === CONTAINER_LOG_DRIVER && opts["max-size"] === limits.maxSize && opts["max-file"] === String(limits.maxFile);
}

/**
 * O log do container cresce sem teto? Só o json-file sem `max-size` (o caso que enche o disco). Outro driver
 * (local, journald, o de um compose que declara o próprio) e json-file com qualquer `max-size` contam como
 * limitados. Saída ilegível: não (não acusa sem saber).
 */
export function isUnboundedLogConfig(inspectJson: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inspectJson.trim());
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const cfg = parsed as { Type?: unknown; Config?: unknown };
  if (cfg.Type !== CONTAINER_LOG_DRIVER) return false;
  const opts = (typeof cfg.Config === "object" && cfg.Config !== null ? cfg.Config : {}) as Record<string, unknown>;
  return typeof opts["max-size"] !== "string" || opts["max-size"] === "";
}
