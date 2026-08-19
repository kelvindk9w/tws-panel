/**
 * exec.ts — helper de execução de processos (docker CLI).
 * Mesmo padrão de packages/deploy/src/exec.ts: argumentos separados
 * (execFile), nunca interpolando entrada da API em strings de shell.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(
  file: string,
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      timeout: opts?.timeoutMs ?? 300_000,
      maxBuffer: 32 * 1024 * 1024,
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
