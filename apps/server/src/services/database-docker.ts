/**
 * database-docker.ts — o `docker exec` que a aba Banco usa (E/S crua). Fica fora da cobertura unitária,
 * como backup-docker.ts: o serviço (database-service.ts) usa um dublê e este arquivo é validado com Docker de verdade.
 *
 * Regras:
 *  - o SQL entra pela ENTRADA PADRÃO do processo, nunca pela linha de comando (argv aparece no `ps`);
 *  - as credenciais do banco são lidas pelo próprio script, das variáveis do container (backup-detect.ts);
 *  - toda execução tem prazo (SIGKILL) e teto de saída (passou do teto, o processo é encerrado e a saída vem cortada);
 *  - o comando do framework roda SEM shell: cada argumento vai separado ao `docker exec`.
 */
import { spawn } from "node:child_process";

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
}

/** O que o serviço pede ao Docker (testes usam uma versão de mentira). */
export interface DatabaseExecutor {
  /** `docker exec -i <container> sh -c <script> sh <args...>` com `stdin` na entrada. */
  sh(container: string, script: string, args: string[], opts: DbExecOptions): Promise<DbExecResult>;
  /** `docker exec <container> <argv...>`, sem shell. */
  argv(container: string, argv: readonly string[], opts: DbExecOptions): Promise<DbExecResult>;
}

export class DockerDatabaseExec implements DatabaseExecutor {
  private readonly env: NodeJS.ProcessEnv;

  constructor(socketPath: string) {
    const host = /^[a-z][a-z0-9+.-]*:\/\//i.test(socketPath) ? socketPath : `unix://${socketPath}`;
    this.env = { ...process.env, DOCKER_HOST: host };
  }

  sh(container: string, script: string, args: string[], opts: DbExecOptions): Promise<DbExecResult> {
    return this.run(["exec", "-i", container, "sh", "-c", script, "sh", ...args], opts);
  }

  argv(container: string, argv: readonly string[], opts: DbExecOptions): Promise<DbExecResult> {
    return this.run(["exec", container, ...argv], opts);
  }

  private run(args: string[], o: DbExecOptions): Promise<DbExecResult> {
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
      child.stdin.end(o.stdin ?? "");
    });
  }
}
