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
const SCRIPT_TO_PHASE = new Map<string, string>(SECURITY_PHASES.map((p) => [p.script, p.id]));

/**
 * Diretório de estado das execuções destacadas NO ALVO (scripts/hardening/lib.sh
 * escreve `<id>.log`, `<id>.pid`, `<id>.exit` e a trava por fase aqui).
 */
export const PHASE_RUN_DIR_DEFAULT = "/etc/paas/runs";

/**
 * Identificador de uma execução destacada: `f<fase>-<16 hex>`. Formato fechado
 * de propósito — ele entra no comando que sobe ao host (nome de arquivo e de
 * trava), então nada além de fase conhecida + hexadecimal pode aparecer ali.
 */
export const PHASE_RUN_ID_RE = new RegExp(`^f(?:${SECURITY_PHASES.map((p) => p.id).join("|")})-[0-9a-f]{16}$`);

export function isValidPhaseRunId(runId: string): boolean {
  return PHASE_RUN_ID_RE.test(runId);
}

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
  /**
   * Execução DESTACADA: id do run (`f<fase>-<16 hex>`, coerente com o script).
   * Com ele o comando montado não é mais `bash <fase>.sh`, e sim o lançador
   * `lib.sh --paas-run-detached`, que destaca a fase do canal e a acompanha.
   */
  runId?: string;
  /** Diretório de estado das execuções destacadas (default /etc/paas/runs). */
  runDir?: string;
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

  if (opts.runId !== undefined) {
    if (!isValidPhaseRunId(opts.runId)) throw new Error(`runId inválido: ${opts.runId}`);
    if (opts.runId.slice(1, 3) !== SCRIPT_TO_PHASE.get(opts.script)) {
      throw new Error(`runId ${opts.runId} não corresponde à fase de ${opts.script}`);
    }
    const runDir = opts.runDir ?? PHASE_RUN_DIR_DEFAULT;
    if (!REMOTE_DIR_RE.test(runDir)) throw new Error(`runDir inválido: ${runDir}`);
    return `${envPrefix}bash '${opts.remoteDir}/lib.sh' --paas-run-detached '${runDir}' ${opts.runId} ${opts.script}${args}`;
  }

  return `${envPrefix}bash '${opts.remoteDir}/${opts.script}'${args}`;
}

/**
 * Comando de REATACHE/reconciliação: reexibe o log da execução destacada desde
 * o início e segue até ela terminar, fechando com :::PAAS_RUN_END <código>.
 * Somente leitura de arquivos do alvo — por isso roda SEM elevação no modo
 * senha (a senha é pedida uma vez, no disparo).
 */
export function buildPhaseFollowCommand(opts: {
  remoteDir: string;
  runId: string;
  runDir?: string;
}): string {
  if (!REMOTE_DIR_RE.test(opts.remoteDir)) throw new Error(`remoteDir inválido: ${opts.remoteDir}`);
  if (!isValidPhaseRunId(opts.runId)) throw new Error(`runId inválido: ${opts.runId}`);
  const runDir = opts.runDir ?? PHASE_RUN_DIR_DEFAULT;
  if (!REMOTE_DIR_RE.test(runDir)) throw new Error(`runDir inválido: ${runDir}`);
  return `bash '${opts.remoteDir}/lib.sh' --paas-run-follow '${runDir}' ${opts.runId}`;
}

// ---------------------------------------------------------------------------
// Allowlist de comandos no host
// ---------------------------------------------------------------------------

/**
 * true se o comando pode ser executado no host real pelo host bridge.
 * Permitidos:
 *  1. comandos fixos somente-leitura (checks do scanner, baseline, Lynis);
 *  2. invocações dos scripts de fase (reconstruídas e validadas via parsing) —
 *     na forma direta, na forma DESTACADA (lib.sh --paas-run-detached) e no
 *     reatache somente-leitura (lib.sh --paas-run-follow).
 * Qualquer outra coisa (pipes livres, `;`, comandos arbitrários) é negada.
 */
export function isAllowedHostCommand(cmd: string, remoteDir: string, runDir?: string): boolean {
  if (fixedReadOnlyCommands().has(cmd)) return true;
  return parsePhaseScriptCommand(cmd, remoteDir, runDir) !== null;
}

/** true SOMENTE para o comando de reatache (leitura de log, sem elevação). */
export function isPhaseFollowCommand(cmd: string, remoteDir: string, runDir?: string): boolean {
  return parsePhaseScriptCommand(cmd, remoteDir, runDir)?.kind === "follow";
}

/** Forma do comando de fase aceita pela allowlist. */
export type PhaseCommandKind = "direct" | "detached" | "follow";

export interface ParsedPhaseCommand {
  /** Script da fase ("" no reatache, que não invoca script nenhum). */
  script: string;
  /** Argumentos do script, como aparecem no comando (inclui o espaço inicial). */
  args: string;
  kind: PhaseCommandKind;
  /** Id da execução destacada (formas "detached" e "follow"). */
  runId?: string;
}

/**
 * Tenta interpretar `cmd` como uma invocação de fase bem formada.
 * Retorna os parâmetros parseados ou null (fora da allowlist).
 *
 * Estratégia fail-closed: o comando é quebrado em campos por uma gramática
 * fixa, cada campo é validado (script no conjunto fechado de fases, diretórios
 * pela REMOTE_DIR_RE, runId pelo formato restrito, cada argumento revalidado) e
 * então o comando é RECONSTRUÍDO pelo builder e comparado byte a byte com o
 * original. Só passa o que o próprio painel seria capaz de montar — nenhuma
 * variação de espaçamento, ordem ou aspas escapa por diferença entre o parser
 * e o construtor.
 */
export function parsePhaseScriptCommand(
  cmd: string,
  remoteDir: string,
  runDir: string = PHASE_RUN_DIR_DEFAULT,
): ParsedPhaseCommand | null {
  if (!REMOTE_DIR_RE.test(remoteDir)) return null;
  if (!REMOTE_DIR_RE.test(runDir)) return null;
  if (cmd.includes("\n") || cmd.includes("\r")) return null;
  const escapedDir = remoteDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedRunDir = runDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const scripts = [...VALID_SCRIPTS].map((s) => s.replace(".", "\\.")).join("|");

  // Reatache (somente leitura): bash '<dir>/lib.sh' --paas-run-follow '<runDir>' <runId>
  const follow = new RegExp(
    `^bash '${escapedDir}/lib\\.sh' --paas-run-follow '${escapedRunDir}' (?<runId>[a-z0-9-]{1,40})$`,
  ).exec(cmd);
  if (follow) {
    // A regex já ancora o comando INTEIRO (não há argumento livre nesta
    // forma): validar o runId basta para fechar a gramática.
    const { runId } = follow.groups as { runId: string };
    if (!isValidPhaseRunId(runId)) return null;
    return { script: "", args: "", kind: "follow", runId };
  }

  // Disparo destacado:
  //   [PAAS_ROLLBACK_DELAY=<n> ]bash '<dir>/lib.sh' --paas-run-detached '<runDir>' <runId> <script>[ args]
  const detached = new RegExp(
    `^(?:PAAS_ROLLBACK_DELAY=(?<delay>\\d{1,6}) )?bash '${escapedDir}/lib\\.sh' --paas-run-detached ` +
      `'${escapedRunDir}' (?<runId>[a-z0-9-]{1,40}) (?<script>${scripts})(?<args>[^\\r\\n]*)$`,
  ).exec(cmd);
  if (detached) {
    const { runId, script, args, delay } = detached.groups as {
      runId: string;
      script: string;
      args: string;
      delay?: string;
    };
    if (!isValidPhaseRunId(runId)) return null;
    const parsedArgs = parsePhaseArgs(args);
    if (!parsedArgs) return null;
    const rebuilt = rebuild(() =>
      buildPhaseScriptCommand({
        remoteDir,
        script,
        runId,
        runDir,
        ...(delay !== undefined ? { rollbackDelaySec: Number(delay) } : {}),
        ...parsedArgs,
      }),
    );
    if (rebuilt !== cmd) return null;
    return { script, args, kind: "detached", runId };
  }

  // Forma direta (rollback imediato, --confirm e compatibilidade):
  //   [PAAS_ROLLBACK_DELAY=<n> ]bash '<dir>/<script>'[ args]
  const direct = new RegExp(
    `^(?:PAAS_ROLLBACK_DELAY=(?<delay>\\d{1,6}) )?bash '${escapedDir}/(?<script>${scripts})'(?<args>[^\\r\\n]*)$`,
  ).exec(cmd);
  if (!direct) return null;
  const { script, args, delay } = direct.groups as { script: string; args: string; delay?: string };
  const parsedArgs = parsePhaseArgs(args);
  if (!parsedArgs) return null;
  const rebuilt = rebuild(() =>
    buildPhaseScriptCommand({
      remoteDir,
      script,
      ...(delay !== undefined ? { rollbackDelaySec: Number(delay) } : {}),
      ...parsedArgs,
    }),
  );
  if (rebuilt !== cmd) return null;
  return { script, args, kind: "direct" };
}

/** Executa um builder devolvendo null quando ele rejeita os parâmetros. */
function rebuild(fn: () => string): string | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/**
 * Valida cada argumento individualmente (nenhum valor arbitrário passa) e
 * devolve as opções equivalentes para a reconstrução. Tokenizer respeita aspas
 * simples: a --pubkey contém espaços internos.
 */
function parsePhaseArgs(
  args: string,
): Pick<PhaseScriptCommandOptions, "dryRun" | "rollback" | "confirm" | "sshUser" | "sshPublicKey"> | null {
  const tokens = args.trim().length > 0 ? (args.trim().match(/'[^']*'|\S+/g) ?? []) : [];
  const out: Pick<
    PhaseScriptCommandOptions,
    "dryRun" | "rollback" | "confirm" | "sshUser" | "sshPublicKey"
  > = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (t === "--rollback") {
      out.rollback = true;
      continue;
    }
    if (t === "--confirm") {
      out.confirm = true;
      continue;
    }
    if (t === "--user") {
      const user = tokens[i + 1];
      if (user === undefined || !isValidSshUsername(user)) return null;
      out.sshUser = user;
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
      out.sshPublicKey = unquoted;
      i += 1;
      continue;
    }
    return null; // argumento desconhecido
  }
  return out;
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
