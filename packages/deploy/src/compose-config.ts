/**
 * compose-config.ts — o compose do projeto como o Docker vai ENXERGAR.
 *
 * Os guardrails precisam olhar o que será executado, não o que está escrito:
 * `docker compose config --format json` devolve o modelo canônico, com merge
 * (`<<:`), `include`, `extends`, perfis e interpolação (`${VAR}`) já
 * resolvidos, usando os MESMOS `-p`, `--env-file`, `--project-directory` e
 * `-f` do deploy (achado A1 da auditoria).
 */
import { run as realRun, type ExecResult } from "./exec.js";

/**
 * Variáveis do ambiente do painel que o compose pode enxergar. O compose
 * interpola `${VAR}` a partir do ambiente do processo: com o ambiente inteiro,
 * um compose hostil com `environment: [X=${SETUP_TOKEN}]` ou `${SESSION_SECRET}`
 * receberia os segredos do painel. Só passa o que o docker precisa para
 * funcionar (caminho, home com o login do registro, daemon, proxy, locale).
 */
const COMPOSE_ENV_ALLOW = [
  /^PATH$/,
  /^HOME$/,
  /^USER$/,
  /^LOGNAME$/,
  /^LANG$/,
  /^LC_[A-Z_]+$/,
  /^TZ$/,
  /^TMPDIR$/,
  /^XDG_[A-Z_]+$/,
  /^DOCKER_(HOST|CONFIG|CONTEXT|CERT_PATH|TLS_VERIFY|TLS|API_VERSION|BUILDKIT|DEFAULT_PLATFORM)$/,
  /^BUILDKIT_PROGRESS$/,
  // estado do buildx (instances/defaults/activity): precisa de pasta gravável no container (rootfs somente leitura)
  /^BUILDX_CONFIG$/,
  /^(HTTP|HTTPS|NO|ALL)_PROXY$/i,
  /^SSL_CERT_(FILE|DIR)$/,
];

/** Ambiente seguro para rodar `docker` / `docker compose` sobre o compose de um projeto. */
export function composeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && COMPOSE_ENV_ALLOW.some((re) => re.test(key))) env[key] = value;
  }
  return env;
}

export type CanonicalCompose =
  | { ok: true; model: unknown }
  | { ok: false; error: string; missing: string[] };

/** Nomes de variáveis obrigatórias que o compose disse faltar. */
function missingVariables(output: string): string[] {
  return [...new Set([...output.matchAll(/required variable ([A-Za-z_][A-Za-z0-9_]*) is missing a value/g)].map((m) => m[1]!))];
}

type Runner = (file: string, args: string[], opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<ExecResult>;

/**
 * Carrega o modelo canônico. `composeArgs` é a mesma lista do deploy
 * (`["compose","-p",…,"-f",…]`). `--no-env-resolution` mantém os `env_file`
 * como caminhos (para conferir onde ficam) em vez de ler o conteúdo.
 */
export async function loadCanonicalCompose(composeArgs: string[], runner: Runner = realRun): Promise<CanonicalCompose> {
  const r = await runner("docker", [...composeArgs, "config", "--format", "json", "--no-env-resolution"], {
    timeoutMs: 120_000,
    env: composeEnv(),
  });
  if (r.code !== 0) {
    return { ok: false, error: (r.stderr || r.stdout).trim(), missing: missingVariables(`${r.stderr}\n${r.stdout}`) };
  }
  try {
    return { ok: true, model: JSON.parse(r.stdout) as unknown };
  } catch {
    return { ok: false, error: "o docker compose devolveu uma saída que não é JSON", missing: [] };
  }
}
