/**
 * host-bridge.ts — funções PURAS do "host bridge": montagem dos comandos que
 * o NsenterHostRunner executa na VPS real e a allowlist que limita o que pode
 * rodar no host.
 *
 * Padrão (mesmo de Coolify/Portainer): um container helper DESCARTÁVEL e
 * privilegiado entra nos namespaces do PID 1 do host via nsenter:
 *
 *   docker run --rm --privileged --pid=host <imagem> \
 *     nsenter -t 1 -m -u -i -n -p -- bash -c "<comando>"
 *
 * Por que é seguro (docs/host-bridge.md):
 *  - sem senha/chave nova: usa o docker.sock que o painel já monta;
 *  - allowlist ESTRITA: só comandos fixos dos checks/baseline/Lynis e as
 *    invocações dos scripts de scripts/hardening/* — nada vindo da API vira
 *    shell arbitrário no host;
 *  - helper descartável (--rm): nenhum estado privilegiado permanece;
 *  - timeout por comando + nome único: timeout mata o cliente e o helper é
 *    removido (docker rm -f) — nada fica rodando solto;
 *  - auditoria: todo comando executado no host é registrado.
 *
 * Este módulo é propositalmente livre de I/O para ser 100% testável.
 */
import { isValidSshPublicKey, isValidSshUsername, SECURITY_PHASES } from "@paas/core";
import { SECURITY_CHECKS } from "./checks.js";
import { BASELINE_COMMANDS } from "./baseline.js";

/** Imagem do helper descartável (mínima; só precisa de nsenter/tar/sh). */
export const HOST_HELPER_IMAGE_DEFAULT = "alpine:3";

// ---------------------------------------------------------------------------
// Comandos fixos do Lynis (usados pelo scanner — reexportados para a allowlist)
// ---------------------------------------------------------------------------

export const LYNIS_CHECK_CMD = "command -v lynis >/dev/null 2>&1";
export const LYNIS_RUN_CMD = "lynis audit system --quick >/dev/null 2>&1 || true";
export const LYNIS_REPORT_CMD =
  "grep -E '^hardening_index=' /var/log/lynis-report.dat 2>/dev/null | tail -1";

/** Conjunto completo de comandos fixos somente-leitura permitidos no host. */
export function fixedReadOnlyCommands(): Set<string> {
  return new Set<string>([
    ...SECURITY_CHECKS.map((c) => c.command),
    ...BASELINE_COMMANDS,
    LYNIS_CHECK_CMD,
    LYNIS_RUN_CMD,
    LYNIS_REPORT_CMD,
  ]);
}

// ---------------------------------------------------------------------------
// Montagem da invocação dos scripts de fase
// ---------------------------------------------------------------------------

const VALID_SCRIPTS = new Set<string>(SECURITY_PHASES.map((p) => p.script));

export interface PhaseScriptCommandOptions {
  /** Diretório remoto (no alvo) onde os scripts foram enviados. */
  remoteDir: string;
  /** Nome do script (ex.: "01-user.sh") — precisa ser uma fase conhecida. */
  script: string;
  dryRun?: boolean;
  rollback?: boolean;
  confirm?: boolean;
  /** Janela do rollback agendado em segundos (propagada via env ao script). */
  rollbackDelaySec?: number;
  /** Fase 01: usuário não-root a criar. */
  sshUser?: string;
  /** Fase 01: chave pública SSH do operador. */
  sshPublicKey?: string;
}

/** Diretório remoto precisa ser um path absoluto "limpo" (sem espaços/aspas). */
export const REMOTE_DIR_RE = /^\/[a-z0-9/._-]{1,120}$/;

/**
 * Monta o comando shell que executa um script de fase no alvo.
 * Lança erro se qualquer parâmetro for inválido — NUNCA monta shell com
 * input não validado (a chave pública é revalidada aqui, defense-in-depth).
 */
export function buildPhaseScriptCommand(opts: PhaseScriptCommandOptions): string {
  if (!VALID_SCRIPTS.has(opts.script)) {
    throw new Error(`script fora da allowlist: ${opts.script}`);
  }
  if (!REMOTE_DIR_RE.test(opts.remoteDir)) {
    throw new Error(`remoteDir inválido: ${opts.remoteDir}`);
  }
  const modes = [opts.dryRun, opts.rollback, opts.confirm].filter(Boolean).length;
  if (modes > 1) throw new Error("dry-run/rollback/confirm são mutuamente exclusivos");

  let envPrefix = "";
  if (opts.rollbackDelaySec !== undefined) {
    if (!Number.isInteger(opts.rollbackDelaySec) || opts.rollbackDelaySec <= 0 || opts.rollbackDelaySec > 86_400) {
      throw new Error(`rollbackDelaySec inválido: ${opts.rollbackDelaySec}`);
    }
    envPrefix = `PAAS_ROLLBACK_DELAY=${opts.rollbackDelaySec} `;
  }

  let args = "";
  if (opts.dryRun) args += " --dry-run";
  if (opts.rollback) args += " --rollback";
  if (opts.confirm) args += " --confirm";
  if (opts.sshUser !== undefined) {
    if (!isValidSshUsername(opts.sshUser)) throw new Error(`sshUser inválido: ${opts.sshUser}`);
    args += ` --user ${opts.sshUser}`;
  }
  if (opts.sshPublicKey !== undefined) {
    // Revalidação severa: a chave entra single-quoted no shell — o validador
    // já garante ausência de aspas, backslashes e quebras de linha.
    if (!isValidSshPublicKey(opts.sshPublicKey)) throw new Error("chave pública SSH inválida");
    args += ` --pubkey '${opts.sshPublicKey.trim()}'`;
  }

  return `${envPrefix}bash '${opts.remoteDir}/${opts.script}'${args}`;
}

// ---------------------------------------------------------------------------
// Allowlist de comandos no host
// ---------------------------------------------------------------------------

/**
 * true se o comando pode ser executado no host real pelo host bridge.
 * Permitidos:
 *  1. comandos fixos somente-leitura (checks do scanner, baseline, Lynis);
 *  2. invocações dos scripts de fase (reconstruídas e validadas via parsing).
 * Qualquer outra coisa (pipes livres, `;`, comandos arbitrários) é negada.
 */
export function isAllowedHostCommand(cmd: string, remoteDir: string): boolean {
  if (fixedReadOnlyCommands().has(cmd)) return true;
  return parsePhaseScriptCommand(cmd, remoteDir) !== null;
}

/**
 * Tenta interpretar `cmd` como uma invocação de script de fase bem formada.
 * Retorna os parâmetros parseados ou null (fora da allowlist).
 */
export function parsePhaseScriptCommand(
  cmd: string,
  remoteDir: string,
): { script: string; args: string } | null {
  if (!REMOTE_DIR_RE.test(remoteDir)) return null;
  const escapedDir = remoteDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const scripts = [...VALID_SCRIPTS].map((s) => s.replace(".", "\\.")).join("|");
  const re = new RegExp(
    `^(?:PAAS_ROLLBACK_DELAY=\\d+ )?bash '(?<dir>${escapedDir})/(?<script>${scripts})'(?<args>[^\\r\\n]*)$`,
  );
  const m = re.exec(cmd);
  const args = m?.groups?.["args"] ?? null;
  const script = m?.groups?.["script"] ?? null;
  if (args === null || script === null) return null;

  // Valida cada argumento individualmente (nenhum valor arbitrário passa).
  // Tokenizer respeita aspas simples: a --pubkey contém espaços internos.
  const tokens = args.trim().length > 0 ? (args.trim().match(/'[^']*'|\S+/g) ?? []) : [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === "--dry-run" || t === "--rollback" || t === "--confirm") continue;
    if (t === "--user") {
      const user = tokens[i + 1];
      if (user === undefined || !isValidSshUsername(user)) return null;
      i += 1;
      continue;
    }
    if (t === "--pubkey") {
      const key = tokens[i + 1];
      if (key === undefined) return null;
      // o token vem single-quoted no comando; a regex de args já limitou o
      // conteúdo, mas revalidamos o formato completo da chave
      const unquoted = key.startsWith("'") && key.endsWith("'") ? key.slice(1, -1) : key;
      if (!isValidSshPublicKey(unquoted)) return null;
      i += 1;
      continue;
    }
    return null; // argumento desconhecido
  }
  return { script, args };
}

// ---------------------------------------------------------------------------
// Montagem do argv do helper nsenter
// ---------------------------------------------------------------------------

/**
 * argv do `docker run` que executa `cmd` nos namespaces do host.
 * Flags nsenter: -m(ount) -u(ts) -i(pc) -n(et) -p(id) do alvo 1 (init do host,
 * visível porque o helper roda com --pid=host).
 */
export function buildNsenterArgv(image: string, cmd: string, name?: string): string[] {
  return [
    "run",
    "--rm",
    ...(name !== undefined ? ["--name", name] : []),
    "--privileged",
    "--pid=host",
    image,
    "nsenter",
    "-t",
    "1",
    "-m",
    "-u",
    "-i",
    "-n",
    "-p",
    "--",
    "bash",
    "-c",
    cmd,
  ];
}

/**
 * argv do `docker run` usado no upload de scripts: recebe um tar via stdin e
 * extrai no remoteDir DO HOST (só o namespace de mount é necessário).
 */
export function buildNsenterUploadArgv(image: string, remoteDir: string, name?: string): string[] {
  if (!REMOTE_DIR_RE.test(remoteDir)) throw new Error(`remoteDir inválido: ${remoteDir}`);
  return [
    "run",
    "--rm",
    "-i",
    ...(name !== undefined ? ["--name", name] : []),
    "--privileged",
    "--pid=host",
    image,
    "nsenter",
    "-t",
    "1",
    "-m",
    "--",
    "sh",
    "-c",
    `mkdir -p '${remoteDir}' && tar -xf - -C '${remoteDir}'`,
  ];
}
