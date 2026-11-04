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

/**
 * Executa um comando e captura a saída completa.
 *
 * `env` SUBSTITUI o ambiente do processo filho (semântica do child_process),
 * então quem passa deve montar o ambiente completo — normalmente
 * `{ ...process.env, ... }`. Existe para o único caminho seguro de entregar
 * um segredo a um subprocesso: variável de ambiente, nunca argv (o argv é
 * visível no `ps` de qualquer processo do host). Omitir mantém o
 * comportamento antigo (herda o ambiente do painel).
 */
export async function run(
  file: string,
  args: string[],
  opts?: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      timeout: opts?.timeoutMs ?? 300_000,
      maxBuffer: 32 * 1024 * 1024,
      cwd: opts?.cwd,
      ...(opts?.env ? { env: opts.env } : {}),
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as {
      code?: number | string;
      signal?: string;
      message?: string;
      stdout?: string;
      stderr?: string;
    };
    const stdout = e.stdout ?? "";
    const stderr = e.stderr ?? "";

    // Processo rodou e saiu com código != 0: quem fala é ele, nada é
    // acrescentado à saída (chamadores já exibem o stderr do comando).
    if (typeof e.code === "number") return { code: e.code, stdout, stderr };

    // Aqui o processo NÃO chegou a rodar (ENOENT = binário ausente do PATH,
    // EACCES = sem permissão) ou foi morto (timeout/sinal). Sem isto, o
    // retorno seria `code: 1` com stderr VAZIO — indistinguível de um comando
    // que rodou e falhou calado, e o chamador propagaria "X falhou:" seguido
    // de nada. Foi exatamente o que aconteceu com o `git` faltando na imagem.
    const motivo = e.message?.trim() || (typeof e.code === "string" ? e.code : "erro desconhecido");
    const dica =
      e.code === "ENOENT"
        ? ` — binário "${file}" não encontrado no PATH`
        : e.signal
          ? ` — processo encerrado pelo sinal ${e.signal}`
          : "";
    const descricao = `Falha ao executar "${file}": ${motivo}${dica}`;

    return {
      code: 1,
      stdout,
      stderr: stderr.trim() ? `${stderr.trimEnd()}\n${descricao}` : descricao,
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
  opts?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: opts?.cwd,
      // Mesma semântica de `run()`: substitui o ambiente do filho quando dado.
      ...(opts?.env ? { env: opts.env } : {}),
    });
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
