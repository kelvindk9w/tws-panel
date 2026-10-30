/**
 * database-docker.ts — o `docker exec` que a aba Banco usa (E/S crua). Fica fora da cobertura unitária,
 * como backup-docker.ts: o serviço (database-service.ts) usa um dublê e este arquivo é validado com Docker de verdade.
 *
 * Regras:
 *  - o SQL entra pela ENTRADA PADRÃO do processo, nunca pela linha de comando (argv aparece no `ps`);
 *  - as credenciais do banco são lidas pelo próprio script, das variáveis do container (backup-detect.ts);
 *  - toda execução tem prazo (SIGKILL) e teto de saída (passou do teto, o processo é encerrado e a saída vem cortada);
 *  - o comando do framework roda SEM shell sobre o texto do pedido: cada argumento vai separado ao `docker exec`
 *    (o `sh -c` que o envolve é fixo e só grava o pid e faz `exec "$@"`);
 *  - fechar o `docker exec` local NÃO para o que roda dentro do container. Por isso cada execução grava o pid do
 *    processo num arquivo e, no prazo ou no teto, um segundo `docker exec` o encerra (melhor esforço; o banco
 *    também tem prazo próprio, ver database-sql.ts).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

export interface DbExecOptions {
  /** Texto enviado à entrada padrão. */
  stdin?: string;
  timeoutMs: number;
  /** Teto de bytes de saída (stdout); acima disso o processo é encerrado e `truncated` vem true. */
  maxBytes: number;
}

export interface DbExecResult {
  /** Código de saída; null quando o processo foi encerrado por sinal (prazo ou teto). */
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  /** Só quando o processo local foi cortado (prazo ou teto): o processo dentro do container foi encerrado? */
  stopped?: boolean | null;
}

/** O que o serviço pede ao Docker (testes usam uma versão de mentira). */
export interface DatabaseExecutor {
  /** `docker exec -i <container> sh -c <script> sh <args...>` com `stdin` na entrada. */
  sh(container: string, script: string, args: string[], opts: DbExecOptions): Promise<DbExecResult>;
  /** `docker exec <container> <argv...>`, sem shell sobre o texto do pedido. */
  argv(container: string, argv: readonly string[], opts: DbExecOptions): Promise<DbExecResult>;
}

export class DockerDatabaseExec implements DatabaseExecutor {
  private readonly env: NodeJS.ProcessEnv;

  constructor(socketPath: string) {
    const host = /^[a-z][a-z0-9+.-]*:\/\//i.test(socketPath) ? socketPath : `unix://${socketPath}`;
    this.env = { ...process.env, DOCKER_HOST: host };
  }

  sh(container: string, script: string, args: string[], opts: DbExecOptions): Promise<DbExecResult> {
    const tag = randomBytes(8).toString("hex");
    return this.run(container, ["exec", "-i", container, "sh", "-c", `echo $$ > ${pidFile(tag)} 2>/dev/null\n${script}`, "sh", ...args], opts, tag);
  }

  argv(container: string, argv: readonly string[], opts: DbExecOptions): Promise<DbExecResult> {
    const tag = randomBytes(8).toString("hex");
    return this.run(container, ["exec", container, "sh", "-c", 'echo $$ > "$1" 2>/dev/null; shift; exec "$@"', "sh", pidFile(tag), ...argv], opts, tag);
  }

  /** Encerra, dentro do container, o processo da execução `tag` (melhor esforço). */
  private async stopInside(container: string, tag: string): Promise<boolean> {
    const r = await this.spawnDocker(["exec", container, "sh", "-c", 'kill -KILL "$(cat "$1")" 2>/dev/null; r=$?; rm -f "$1"; exit $r', "sh", pidFile(tag)], { timeoutMs: 10_000, maxBytes: 1_000 }, null);
    return r.code === 0;
  }

  private async run(container: string, args: string[], o: DbExecOptions, tag: string): Promise<DbExecResult> {
    const r = await this.spawnDocker(args, o, o.stdin ?? "");
    const stopped = r.timedOut || r.truncated ? await this.stopInside(container, tag) : null;
    return { ...r, stopped };
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

/** Arquivo (dentro do container) com o pid da execução; `tag` é hexadecimal gerado aqui. */
const pidFile = (tag: string): string => `/tmp/tws-db-${tag}.pid`;
