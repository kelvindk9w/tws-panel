/**
 * database-docker.ts — o `docker exec` que a aba Banco usa (E/S crua). Fica fora da cobertura unitária,
 * como backup-docker.ts: o serviço (database-service.ts) usa um dublê e este arquivo é validado com Docker de verdade.
 * Os scripts de parada (cancelScript, KILL_SCRIPT) são texto puro em database-sql.ts e têm teste.
 *
 * Regras:
 *  - o SQL entra pela ENTRADA PADRÃO do processo, nunca pela linha de comando (argv aparece no `ps`);
 *  - as credenciais do banco são lidas pelo próprio script, das variáveis do container (backup-detect.ts);
 *  - toda execução tem prazo (SIGKILL) e teto de saída (passou do teto, o processo é encerrado e a saída vem cortada);
 *  - o comando do framework roda SEM shell sobre o texto do pedido: cada argumento vai separado ao `docker exec`
 *    (o `sh -c` que o envolve é fixo e só grava o pid e faz `exec "$@"`);
 *  - fechar o `docker exec` local NÃO para o que roda dentro do container, nem o servidor de banco. Por isso, no prazo
 *    ou no teto de saída: (1) o cliente/comando é encerrado pelo pid gravado (conferido em /proc/<pid>/cmdline) e
 *    (2) a sessão do banco, marcada com a `tag`, é cancelada (PostgreSQL: pg_cancel/terminate_backend; MySQL/MariaDB:
 *    KILL QUERY). Só se diz `stopped: true` quando as duas coisas deram certo. Fora do prazo, o arquivo do pid é removido.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { DatabaseSqlEngine } from "@paas/core";
import { KILL_EXPECT_DB, KILL_SCRIPT, cancelScript, isTag, killExpectFor } from "./database-sql.js";

export interface DbExecOptions {
  /** Texto enviado à entrada padrão. */
  stdin?: string;
  timeoutMs: number;
  /** Teto de bytes de saída (stdout); acima disso o processo é encerrado e `truncated` vem true. */
  maxBytes: number;
  /** Marca da execução (hexadecimal): nome do arquivo do pid e da sessão no banco. Sem ela, uma é gerada. */
  tag?: string;
  /** Motor, para cancelar a sessão no servidor (só nas execuções de SQL). */
  engine?: DatabaseSqlEngine;
}

export interface DbExecResult {
  /** Código de saída; null quando o processo foi encerrado por sinal (prazo ou teto). */
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  /** Só quando a execução local foi cortada (prazo ou teto): o processo E a sessão no banco foram parados? */
  stopped?: boolean | null;
}

/** O que o serviço pede ao Docker (testes usam uma versão de mentira). */
export interface DatabaseExecutor {
  /** `docker exec -i <container> sh -c <script> sh <args...>` com `stdin` na entrada. */
  sh(container: string, script: string, args: string[], opts: DbExecOptions): Promise<DbExecResult>;
  /** `docker exec <container> <argv...>`, sem shell sobre o texto do pedido. */
  argv(container: string, argv: readonly string[], opts: DbExecOptions): Promise<DbExecResult>;
}

/** Arquivo (dentro do container) com o pid da execução; `tag` é hexadecimal. */
const pidFile = (tag: string): string => `/tmp/tws-db-${tag}.pid`;

export class DockerDatabaseExec implements DatabaseExecutor {
  private readonly env: NodeJS.ProcessEnv;

  constructor(socketPath: string) {
    const host = /^[a-z][a-z0-9+.-]*:\/\//i.test(socketPath) ? socketPath : `unix://${socketPath}`;
    this.env = { ...process.env, DOCKER_HOST: host };
  }

  private tagOf(o: DbExecOptions): string {
    const tag = o.tag ?? randomBytes(8).toString("hex");
    if (!isTag(tag)) throw new Error("tag inválida");
    return tag;
  }

  sh(container: string, script: string, args: string[], opts: DbExecOptions): Promise<DbExecResult> {
    const tag = this.tagOf(opts);
    return this.run(container, ["exec", "-i", container, "sh", "-c", `echo $$ > ${pidFile(tag)} 2>/dev/null\n${script}`, "sh", ...args], opts, tag, KILL_EXPECT_DB);
  }

  argv(container: string, argv: readonly string[], opts: DbExecOptions): Promise<DbExecResult> {
    const tag = this.tagOf(opts);
    const expected = killExpectFor((argv[0] ?? "").split("/").pop()!);
    return this.run(container, ["exec", container, "sh", "-c", 'echo $$ > "$1" 2>/dev/null; shift; exec "$@"', "sh", pidFile(tag), ...argv], opts, tag, expected);
  }

  /** Um `docker exec <container> sh -c <script> sh <args>` curto; devolve a execução. */
  private inside(container: string, script: string, args: string[], timeoutMs: number) {
    return this.spawnDocker(["exec", container, "sh", "-c", script, "sh", ...args], { timeoutMs, maxBytes: 10_000 }, null);
  }

  /** Para o processo do cliente/comando e a sessão no banco. true = os dois pararam (ou já tinham terminado). */
  private async stopInside(container: string, tag: string, expected: string, engine: DatabaseSqlEngine | undefined): Promise<boolean> {
    const process = await this.inside(container, KILL_SCRIPT, [pidFile(tag), expected], 10_000);
    if (!engine) return process.code === 0;
    const session = await this.inside(container, cancelScript(engine, tag), [], 20_000);
    return process.code === 0 && session.code === 0 && session.stdout.trim() === "0";
  }

  private async run(container: string, args: string[], o: DbExecOptions, tag: string, expected: string): Promise<DbExecResult> {
    const r = await this.spawnDocker(args, o, o.stdin ?? "");
    if (r.timedOut || r.truncated) return { ...r, stopped: await this.stopInside(container, tag, expected, o.engine) };
    // Terminou sozinho: só apaga o arquivo do pid (não vale esperar pelo resultado)
    await this.inside(container, 'rm -f "$1"', [pidFile(tag)], 5_000);
    return { ...r, stopped: null };
  }

  private spawnDocker(args: string[], o: DbExecOptions, stdin: string | null): Promise<Omit<DbExecResult, "stopped">> {
    return new Promise((resolve) => {
      const child = spawn("docker", args, { env: this.env, stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      let size = 0;
      let stderr = "";
      let truncated = false;
      let timedOut = false;
      let spawnError: string | null = null;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, o.timeoutMs);
      child.stdout.on("data", (c: Buffer) => {
        if (truncated) return;
        const room = o.maxBytes - size;
        if (c.length > room) {
          out.push(c.subarray(0, Math.max(0, room)));
          size = o.maxBytes;
          truncated = true;
          child.kill("SIGKILL");
          return;
        }
        out.push(c);
        size += c.length;
      });
      child.stderr.on("data", (c: Buffer) => {
        stderr = (stderr + c.toString("utf8")).slice(-20_000);
      });
      child.stdin.on("error", () => undefined);
      child.on("error", (err) => {
        spawnError = err.message;
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          code: spawnError ? 127 : code,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: spawnError ? `não foi possível rodar o docker (${spawnError})` : stderr,
          truncated,
          timedOut,
        });
      });
      child.stdin.end(stdin ?? "");
    });
  }
}
