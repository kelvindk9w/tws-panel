/**
 * exec.ts — helpers de execução de processos (docker CLI, git CLI).
 *
 * SEGURANÇA: comandos são montados com argumentos separados (execFile/spawn),
 * nunca interpolando entrada da API em strings de shell.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Executa um comando e captura a saída completa. */
export async function run(
  file: string,
  args: string[],
  opts?: { timeoutMs?: number; cwd?: string },
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      timeout: opts?.timeoutMs ?? 300_000,
      maxBuffer: 32 * 1024 * 1024,
      cwd: opts?.cwd,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

/**
 * Timeout padrão de runStream: 30 minutos. Generoso de propósito — um
 * `docker build`/`compose up --build` legítimo pode demorar bastante (imagens
 * grandes, sem cache). O objetivo não é apertar builds normais, é garantir
 * que um processo travado (rede caiu, prompt interativo, deadlock) não
 * pendure o job de deploy para sempre.
 */
export const DEFAULT_STREAM_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Executa um comando transmitindo a saída em tempo real. Retorna o exit code.
 *
 * `timeoutMs` (padrão DEFAULT_STREAM_TIMEOUT_MS, mesmo nome de opção que
 * `run()`): ao expirar, o processo é morto (SIGKILL) e a promise REJEITA com
 * um erro claro — os chamadores existentes já fazem `await runStream(...)`
 * sem try/catch local, então o erro simplesmente propaga como qualquer outra
 * falha de `docker`/`git` (mesmo caminho de `child.on("error", reject)`).
 */
export function runStream(
  file: string,
  args: string[],
  onData: (chunk: string) => void,
  opts?: { cwd?: string; timeoutMs?: number },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], cwd: opts?.cwd });
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      const msg = `Comando "${file}" excedeu o tempo limite de ${Math.round(timeoutMs / 1000)}s e foi encerrado.\n`;
      onData(`\n✖ ${msg}`);
      child.kill("SIGKILL");
    }, timeoutMs);
    // Não impede o processo Node de encerrar caso o timer ainda esteja pendente.
    timer.unref?.();

    child.stdout.on("data", (d: Buffer) => onData(d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => onData(d.toString("utf8")));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(`Comando "${file}" excedeu o tempo limite de ${Math.round(timeoutMs / 1000)}s.`),
        );
        return;
      }
      resolve(code ?? 1);
    });
  });
}
