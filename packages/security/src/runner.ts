/**
 * runner.ts — abstração de alvo de execução (host ou container Docker).
 *
 * SEGURANÇA: todos os comandos executados são strings FIXAS definidas no código
 * (checks e scripts de fase). Nenhum parâmetro vindo da API vira shell.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface TargetRunner {
  /** Rótulo legível do alvo (ex.: "host" ou "container:paas-target-test"). */
  readonly label: string;
  /** Garante que o alvo está pronto (no-op no host; cria container se ausente). */
  ensureReady(): Promise<void>;
  /** Executa um comando FIXO via bash no alvo. */
  exec(cmd: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
  /**
   * Executa um comando FIXO no alvo transmitindo a saída em tempo real.
   * Retorna o exit code.
   */
  execStream(cmd: string, onData: (chunk: string) => void): Promise<number>;
  /** Copia um diretório local para dentro do alvo. */
  uploadDir(localDir: string, remoteDir: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Host (somente quando explicitamente configurado — PAAS_TARGET=host)
// ---------------------------------------------------------------------------

export class HostRunner implements TargetRunner {
  readonly label = "host";

  async ensureReady(): Promise<void> {
    // no-op
  }

  async exec(cmd: string, opts?: { timeoutMs?: number }): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execFileAsync("bash", ["-c", cmd], {
        timeout: opts?.timeoutMs ?? 120_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  execStream(cmd: string, onData: (chunk: string) => void): Promise<number> {
    return streamCommand("bash", ["-c", cmd], onData);
  }

  async uploadDir(_localDir: string, _remoteDir: string): Promise<void> {
    // No host os scripts já estão no filesystem; nada a copiar.
  }
}

// ---------------------------------------------------------------------------
// Container Docker (modo padrão de desenvolvimento/teste — alvo descartável)
// ---------------------------------------------------------------------------

export interface ContainerRunnerOptions {
  /** Nome do container alvo. */
  name: string;
  /** Imagem usada quando o container precisa ser criado. */
  image?: string;
}

export class ContainerRunner implements TargetRunner {
  readonly label: string;
  private readonly name: string;
  private readonly image: string;

  constructor(opts: ContainerRunnerOptions) {
    this.name = opts.name;
    this.image = opts.image ?? "ubuntu:24.04";
    this.label = `container:${this.name}`;
  }

  private async docker(args: string[], timeoutMs = 120_000): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execFileAsync("docker", args, {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  async ensureReady(): Promise<void> {
    const inspect = await this.docker(["inspect", "-f", "{{.State.Running}}", this.name]);
    if (inspect.code === 0 && inspect.stdout.trim() === "true") return;
    if (inspect.code === 0) {
      const start = await this.docker(["start", this.name]);
      if (start.code !== 0) throw new Error(`falha ao iniciar container ${this.name}: ${start.stderr}`);
      return;
    }
    // Cria container descartável. NET_ADMIN permite testar UFW de verdade.
    const create = await this.docker([
      "run", "-d",
      "--name", this.name,
      "--cap-add", "NET_ADMIN",
      this.image,
      "sleep", "infinity",
    ]);
    if (create.code !== 0) {
      throw new Error(`falha ao criar container ${this.name}: ${create.stderr}`);
    }
  }

  async exec(cmd: string, opts?: { timeoutMs?: number }): Promise<ExecResult> {
    return this.docker(["exec", this.name, "bash", "-c", cmd], opts?.timeoutMs);
  }

  execStream(cmd: string, onData: (chunk: string) => void): Promise<number> {
    return streamCommand("docker", ["exec", this.name, "bash", "-c", cmd], onData);
  }

  async uploadDir(localDir: string, remoteDir: string): Promise<void> {
    await this.exec(`mkdir -p '${remoteDir}'`);
    const cp = await this.docker(["cp", `${localDir}/.`, `${this.name}:${remoteDir}/`]);
    if (cp.code !== 0) throw new Error(`falha ao copiar scripts para o container: ${cp.stderr}`);
  }
}

// ---------------------------------------------------------------------------

function streamCommand(file: string, args: string[], onData: (chunk: string) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d: Buffer) => onData(d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => onData(d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}
