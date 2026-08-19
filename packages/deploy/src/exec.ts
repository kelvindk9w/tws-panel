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

/** Executa um comando transmitindo a saída em tempo real. Retorna o exit code. */
export function runStream(
  file: string,
  args: string[],
  onData: (chunk: string) => void,
  opts?: { cwd?: string },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], cwd: opts?.cwd });
    child.stdout.on("data", (d: Buffer) => onData(d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => onData(d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}
