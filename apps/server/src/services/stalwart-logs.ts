/**
 * stalwart-logs.ts — lê o registro do container do Stalwart linha a linha
 * (`docker logs --since <hora> paas-stalwart`), sem guardar a saída inteira
 * em memória. Usado pelo histórico da página Envios (mail-envios-service.ts).
 *
 * Argumentos separados (spawn, sem shell); nada vindo da API entra aqui.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { PAAS_STALWART_CONTAINER } from "@paas/core";

export interface StreamLinesOptions {
  command: string;
  args: string[];
  onLine: (line: string) => void;
  timeoutMs?: number;
}

/** Roda o comando e entrega cada linha (stdout e stderr). Falha = código ≠ 0. */
export function streamCommandLines(opts: StreamLinesOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.command, opts.args, { stdio: ["ignore", "pipe", "pipe"] });
    const tail: string[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 60_000);
    timer.unref?.();
    let open = 2;
    let exitCode: number | null = null;
    const finish = () => {
      if (open > 0 || exitCode === null) return;
      clearTimeout(timer);
      if (exitCode === 0) resolve();
      else reject(new Error(tail.join(" ").trim() || `o comando terminou com o código ${exitCode}`));
    };
    for (const [stream, isErr] of [
      [child.stdout, false],
      [child.stderr, true],
    ] as const) {
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      rl.on("line", (line) => {
        if (isErr) {
          tail.push(line);
          if (tail.length > 3) tail.shift();
        }
        opts.onLine(line);
      });
      rl.on("close", () => {
        open--;
        finish();
      });
    }
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      exitCode = code ?? 1;
      finish();
    });
  });
}

/**
 * Registro do Stalwart desde `since` (null = últimos `maxHours`). O docker
 * devolve no stdout o que o container escreveu no stdout (onde o Stalwart
 * escreve o registro) e no stderr o resto; as duas saídas são lidas.
 */
export function readStalwartLogs(
  since: Date | null,
  onLine: (line: string) => void,
  opts: { command?: string; container?: string; maxHours?: number } = {},
): Promise<void> {
  const sinceArg = since ? since.toISOString() : `${opts.maxHours ?? 720}h`;
  return streamCommandLines({
    command: opts.command ?? "docker",
    args: ["logs", "--since", sinceArg, opts.container ?? PAAS_STALWART_CONTAINER],
    onLine,
  });
}
