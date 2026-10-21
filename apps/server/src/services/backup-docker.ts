/**
 * backup-docker.ts — os comandos do Docker que o backup usa (E/S crua).
 *
 * Tudo passa pelo socket do Docker que o painel já usa; nada roda no host
 * fora do Docker. A regra (o que copiar, em que ordem) fica no
 * backup-service.ts — este arquivo só executa. Por isso fica fora da
 * cobertura unitária (como docker-service.ts) e é validado pelo teste de
 * ponta a ponta com Docker de verdade (ver _RELATORIO-backups.md).
 *
 *  - dump de banco: `docker exec <container> sh -c '<script>'`, saída
 *    gravada direto num arquivo (o dump nunca passa inteiro pela memória);
 *  - volumes e pastas: `docker cp <container>:<caminho> -` (um .tar, com
 *    dono e permissões) e, na volta, um container auxiliar descartável
 *    (`--volumes-from` ou `-v volume:/v`, imagem PAAS_HOST_HELPER_IMAGE) que
 *    esvazia a pasta e extrai o .tar;
 *  - tamanho: o mesmo auxiliar roda `du -sk` em cada montagem.
 */
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { listContainers } from "./docker-service.js";
import type { ContainerInspect } from "./backup-detect.js";

export interface ProjectContainer {
  id: string;
  name: string;
  service: string;
  running: boolean;
}

export interface SizeRequest {
  id: string;
  kind: "volume" | "bind";
  source: string;
}

/** O que o serviço de backups pede ao Docker (testes usam uma versão de mentira). */
export interface BackupDocker {
  projectContainers(slug: string): Promise<ProjectContainer[]>;
  inspect(ids: string[]): Promise<ContainerInspect[]>;
  diff(container: string): Promise<string>;
  sizes(items: SizeRequest[]): Promise<{ sizes: Record<string, number | null>; files: Set<string> }>;
  /** Roda o script no container e grava a saída em `outFile`. */
  execToFile(container: string, script: string, args: string[], outFile: string): Promise<{ stderr: string }>;
  /** Roda o script e devolve a saída (curta). */
  execCapture(container: string, script: string, args: string[]): Promise<string>;
  /** Roda o script com `inFile` na entrada. */
  execFromFile(container: string, script: string, args: string[], inFile: string): Promise<{ stderr: string }>;
  copyOut(container: string, path: string, outFile: string): Promise<void>;
  copyIn(container: string, parentPath: string, tarFile: string): Promise<void>;
  /** Esvazia `destination` e extrai o .tar (do `docker cp`) nela, com o container parado. */
  restorePath(container: string, destination: string, tarFile: string, isFile: boolean): Promise<void>;
  restoreVolume(volume: string, tarFile: string): Promise<void>;
  state(container: string): Promise<{ exists: boolean; running: boolean }>;
  stop(container: string): Promise<void>;
  start(container: string): Promise<void>;
}

export interface DockerCliOptions {
  socketPath: string;
  helperImage: string;
  /** Prazo de cada comando (padrão 2 h). */
  timeoutMs?: number;
}

interface RunOptions {
  stdinFile?: string;
  stdoutFile?: string;
  timeoutMs?: number;
}

const RESTORE_PATH_SCRIPT = [
  "set -e",
  'd="$1"',
  'if [ "$2" = "file" ]; then',
  '  mkdir -p "$(dirname "$d")"',
  '  tar -xf - -C "$(dirname "$d")"',
  "else",
  '  mkdir -p "$d"',
  '  find "$d" -mindepth 1 -maxdepth 1 -exec rm -rf {} +',
  '  tar -xf - -C "$d" --strip-components=1',
  "fi",
].join("\n");

/** Mensagem para erro de gravação/leitura dos arquivos do backup (sem caminho do servidor). */
function fileFailure(action: "gravar" | "ler", err: NodeJS.ErrnoException): Error {
  if (err.code === "ENOSPC") {
    return new Error("o disco do servidor ficou sem espaço ao gravar o backup — libere espaço e faça de novo");
  }
  return new Error(`não foi possível ${action} o arquivo temporário do backup (${err.code ?? err.message})`);
}

export class DockerCli implements BackupDocker {
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;

  constructor(private readonly opts: DockerCliOptions) {
    const host = /^[a-z][a-z0-9+.-]*:\/\//i.test(opts.socketPath) ? opts.socketPath : `unix://${opts.socketPath}`;
    this.env = { ...process.env, DOCKER_HOST: host };
    this.timeoutMs = opts.timeoutMs ?? 2 * 60 * 60_000;
  }

  private run(args: string[], o: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn("docker", args, { env: this.env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, o.timeoutMs ?? this.timeoutMs);
      // Erro nos arquivos do backup (disco cheio, permissão, arquivo sumido) NÃO
      // pode ser uma exceção sem ouvinte: derrubaria o painel no meio do backup.
      // Encerra o docker e rejeita a promessa do comando com a causa.
      let fileError: Error | null = null;
      const failFile = (err: Error): void => {
        if (fileError) return;
        fileError = err;
        child.kill("SIGKILL");
      };
      const sink = o.stdoutFile ? createWriteStream(o.stdoutFile, { mode: 0o600 }) : null;
      let sinkDone: Promise<void> = Promise.resolve();
      if (sink) {
        sink.on("error", (err: NodeJS.ErrnoException) => {
          child.stdout.unpipe(sink);
          child.stdout.resume();
          failFile(fileFailure("gravar", err));
        });
        child.stdout.pipe(sink);
        sinkDone = new Promise((r) => sink.on("close", () => r()));
      } else {
        child.stdout.on("data", (c: Buffer) => {
          stdout = (stdout + c.toString("utf8")).slice(-4_000_000);
        });
      }
      child.stderr.on("data", (c: Buffer) => {
        stderr = (stderr + c.toString("utf8")).slice(-20_000);
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`não foi possível rodar o docker (${err.message})`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        void sinkDone.then(() => {
          if (fileError) return reject(fileError);
          if (timedOut) return reject(new Error("o comando passou do prazo e foi interrompido"));
          if (code !== 0) return reject(new Error(stderr.trim().split("\n").slice(-3).join(" ") || `docker saiu com código ${code}`));
          resolve({ stdout, stderr });
        });
      });
      child.stdin.on("error", () => undefined);
      if (o.stdinFile) {
        const input = createReadStream(o.stdinFile);
        input.on("error", (err: NodeJS.ErrnoException) => {
          failFile(fileFailure("ler", err));
          child.stdin.destroy();
        });
        input.pipe(child.stdin);
      } else child.stdin.end();
    });
  }

  async projectContainers(slug: string): Promise<ProjectContainer[]> {
    const all = await listContainers(this.opts.socketPath);
    return all
      .filter((c) => c.projectSlug === slug)
      .map((c) => ({ id: c.id, name: c.name, service: c.service ?? c.name, running: c.state === "running" }));
  }

  async inspect(ids: string[]): Promise<ContainerInspect[]> {
    if (ids.length === 0) return [];
    const { stdout } = await this.run(["inspect", ...ids]);
    return JSON.parse(stdout) as ContainerInspect[];
  }

  async diff(container: string): Promise<string> {
    return (await this.run(["diff", container], { timeoutMs: 120_000 })).stdout;
  }

  async sizes(items: SizeRequest[]): Promise<{ sizes: Record<string, number | null>; files: Set<string> }> {
    const sizes: Record<string, number | null> = {};
    const files = new Set<string>();
    if (items.length === 0) return { sizes, files };
    const script =
      'for d in /m/*; do n=$(basename "$d"); k=$(du -sk "$d" 2>/dev/null | cut -f1); if [ -f "$d" ]; then echo "F $n ${k:-0}"; else echo "D $n ${k:-0}"; fi; done';
    try {
      const { stdout } = await this.run(
        [
          "run",
          "--rm",
          "--network",
          "none",
          ...items.flatMap((it, i) => ["-v", `${it.source}:/m/${i}:ro`]),
          this.opts.helperImage,
          "sh",
          "-c",
          script,
        ],
        { timeoutMs: 15 * 60_000 },
      );
      for (const line of stdout.split("\n")) {
        const m = /^([FD]) (\d+) (\d+)$/.exec(line.trim());
        if (!m) continue;
        const item = items[Number(m[2])];
        if (!item) continue;
        sizes[item.id] = Number(m[3]) * 1024;
        if (m[1] === "F") files.add(item.source);
      }
    } catch {
      // tamanho é informativo: sem ele a tela mostra "—"
    }
    return { sizes, files };
  }

  async execToFile(container: string, script: string, args: string[], outFile: string): Promise<{ stderr: string }> {
    const { stderr } = await this.run(["exec", container, "sh", "-c", script, "sh", ...args], { stdoutFile: outFile });
    return { stderr };
  }

  async execCapture(container: string, script: string, args: string[]): Promise<string> {
    return (await this.run(["exec", container, "sh", "-c", script, "sh", ...args], { timeoutMs: 120_000 })).stdout;
  }

  async execFromFile(container: string, script: string, args: string[], inFile: string): Promise<{ stderr: string }> {
    const { stderr } = await this.run(["exec", "-i", container, "sh", "-c", script, "sh", ...args], { stdinFile: inFile });
    return { stderr };
  }

  async copyOut(container: string, path: string, outFile: string): Promise<void> {
    await this.run(["cp", `${container}:${path}`, "-"], { stdoutFile: outFile });
  }

  async copyIn(container: string, parentPath: string, tarFile: string): Promise<void> {
    await this.run(["cp", "-a", "-", `${container}:${parentPath}`], { stdinFile: tarFile });
  }

  async restorePath(container: string, destination: string, tarFile: string, isFile: boolean): Promise<void> {
    await this.run(
      [
        "run",
        "--rm",
        "-i",
        "--network",
        "none",
        "--volumes-from",
        container,
        this.opts.helperImage,
        "sh",
        "-c",
        RESTORE_PATH_SCRIPT,
        "sh",
        destination,
        isFile ? "file" : "dir",
      ],
      { stdinFile: tarFile },
    );
  }

  async restoreVolume(volume: string, tarFile: string): Promise<void> {
    await this.run(
      ["run", "--rm", "-i", "--network", "none", "-v", `${volume}:/v`, this.opts.helperImage, "sh", "-c", RESTORE_PATH_SCRIPT, "sh", "/v", "dir"],
      { stdinFile: tarFile },
    );
  }

  async state(container: string): Promise<{ exists: boolean; running: boolean }> {
    try {
      const { stdout } = await this.run(["inspect", "-f", "{{.State.Running}}", container], { timeoutMs: 30_000 });
      return { exists: true, running: stdout.trim() === "true" };
    } catch {
      return { exists: false, running: false };
    }
  }

  /**
   * Como `state`, mas distingue "não existe" de "o Docker não respondeu": o
   * segundo LANÇA. A reconciliação depois de restaurar não pode tratar um
   * Docker fora do ar como "o webmail não existe".
   */
  async probe(container: string): Promise<"running" | "stopped" | "missing"> {
    try {
      const { stdout } = await this.run(["inspect", "-f", "{{.State.Running}}", container], { timeoutMs: 30_000 });
      return stdout.trim() === "true" ? "running" : "stopped";
    } catch (err) {
      if (/no such (object|container)/i.test(err instanceof Error ? err.message : "")) return "missing";
      throw err;
    }
  }

  async stop(container: string): Promise<void> {
    await this.run(["stop", "-t", "30", container], { timeoutMs: 120_000 });
  }

  async start(container: string): Promise<void> {
    await this.run(["start", container], { timeoutMs: 120_000 });
  }
}
