/**
 * runner.ts — abstração de alvo de execução (host real via host bridge,
 * host local ou container Docker descartável).
 *
 * SEGURANÇA: todos os comandos executados são strings FIXAS definidas no código
 * (checks e scripts de fase). Nenhum parâmetro vindo da API vira shell.
 */
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import type { SecurityTargetProfile } from "@paas/core";
import {
  HOST_HELPER_IMAGE_DEFAULT,
  buildNsenterArgv,
  buildNsenterUploadArgv,
  isAllowedHostCommand,
} from "./host-bridge.js";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface TargetRunner {
  /** Rótulo legível do alvo (ex.: "host" ou "container:paas-target-test"). */
  readonly label: string;
  /** Perfil do alvo — define quais checks do scanner se aplicam. */
  readonly profile: SecurityTargetProfile;
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
  readonly profile = "host" as const;

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
  readonly profile = "container" as const;
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
// Host REAL via host bridge (helper container privilegiado descartável + nsenter)
// ---------------------------------------------------------------------------
//
// BUG ARQUITETURAL CORRIGIDO: o HostRunner acima executa `bash -c` no namespace
// do PRÓPRIO container do painel — o scan mostrava dados do container Debian da
// imagem e o hardening modificaria o container (inútil). O NsenterHostRunner
// executa os comandos nos namespaces do PID 1 do HOST (padrão Coolify/
// Portainer): ver docs/host-bridge.md.

export interface NsenterHostRunnerOptions {
  /** Imagem do helper descartável (default alpine:3 — precisa de nsenter/tar/sh). */
  image?: string;
  /** Diretório remoto dos scripts no host (validação da allowlist). */
  remoteDir?: string;
  /** Callback de auditoria: chamado com cada comando executado no host. */
  onAudit?: (detail: string) => void;
}

export class NsenterHostRunner implements TargetRunner {
  readonly label = "host";
  readonly profile = "host" as const;
  private readonly image: string;
  private readonly remoteDir: string;
  private readonly onAudit?: ((detail: string) => void) | undefined;

  constructor(opts?: NsenterHostRunnerOptions) {
    this.image = opts?.image ?? HOST_HELPER_IMAGE_DEFAULT;
    this.remoteDir = opts?.remoteDir ?? "/opt/paas-hardening";
    this.onAudit = opts?.onAudit;
  }

  private audit(detail: string): void {
    // auditoria é best-effort e nunca bloqueia a execução
    this.onAudit?.(detail.length > 400 ? `${detail.slice(0, 400)}…` : detail);
  }

  /** Garante a imagem do helper presente no host (pull se ausente). */
  async ensureReady(): Promise<void> {
    const inspect = await this.docker(["image", "inspect", this.image], 30_000);
    if (inspect.code === 0) return;
    const pull = await this.docker(["pull", this.image], 300_000);
    if (pull.code !== 0) {
      throw new Error(`falha ao baixar a imagem do host bridge (${this.image}): ${pull.stderr.trim()}`);
    }
  }

  private assertAllowed(cmd: string): void {
    if (!isAllowedHostCommand(cmd, this.remoteDir)) {
      throw new Error(`comando fora da allowlist do host bridge: ${cmd.slice(0, 120)}`);
    }
  }

  private async docker(args: string[], timeoutMs = 120_000, name?: string): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execFileAsync("docker", args, {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
      // Timeout matou o cliente: remove o helper para não deixar nada rodando.
      if (e.killed && name !== undefined) {
        void execFileAsync("docker", ["rm", "-f", name]).catch(() => undefined);
      }
      return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  async exec(cmd: string, opts?: { timeoutMs?: number }): Promise<ExecResult> {
    this.assertAllowed(cmd);
    this.audit(`host-exec: ${cmd}`);
    const name = `paas-host-exec-${randomBytes(4).toString("hex")}`;
    return this.docker(buildNsenterArgv(this.image, cmd, name), opts?.timeoutMs ?? 120_000, name);
  }

  execStream(cmd: string, onData: (chunk: string) => void): Promise<number> {
    this.assertAllowed(cmd);
    this.audit(`host-exec (stream): ${cmd}`);
    const name = `paas-host-exec-${randomBytes(4).toString("hex")}`;
    return streamCommand("docker", buildNsenterArgv(this.image, cmd, name), onData, {
      // scripts de fase podem ser longos (apt upgrade) — teto de 30 min
      timeoutMs: 30 * 60_000,
      onTimeout: () => {
        void execFileAsync("docker", ["rm", "-f", name]).catch(() => undefined);
      },
    });
  }

  /**
   * Copia os scripts para o HOST: empacota em tar e extrai via helper
   * descartável (só o namespace de mount do host é necessário).
   */
  async uploadDir(localDir: string, remoteDir: string): Promise<void> {
    this.audit(`host-upload: ${localDir} -> ${remoteDir}`);
    const name = `paas-host-upload-${randomBytes(4).toString("hex")}`;
    await new Promise<void>((resolve, reject) => {
      const tar = spawn("tar", ["-C", localDir, "-cf", "-", "."], { stdio: ["ignore", "pipe", "pipe"] });
      const helper = spawn("docker", buildNsenterUploadArgv(this.image, remoteDir, name), {
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      let tarCode: number | null = null;
      tar.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      helper.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      tar.on("error", reject);
      helper.on("error", reject);
      tar.stdout.pipe(helper.stdin as NodeJS.WritableStream);
      tar.on("close", (code) => {
        tarCode = code;
        if (code !== 0) helper.stdin?.destroy();
      });
      helper.on("close", (code) => {
        if (tarCode === 0 && code === 0) resolve();
        else reject(new Error(`falha ao enviar scripts ao host (tar=${tarCode}, helper=${code}): ${stderr.trim()}`));
      });
    });
  }
}

// ---------------------------------------------------------------------------

function streamCommand(
  file: string,
  args: string[],
  onData: (chunk: string) => void,
  opts?: { timeoutMs?: number; onTimeout?: () => void },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d: Buffer) => onData(d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => onData(d.toString("utf8")));
    let timer: NodeJS.Timeout | null = null;
    if (opts?.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        opts.onTimeout?.();
        child.kill("SIGKILL");
      }, opts.timeoutMs);
      timer.unref();
    }
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve(code ?? (signal === "SIGKILL" ? 124 : 1));
    });
  });
}
