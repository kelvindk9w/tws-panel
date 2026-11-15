/**
 * aof-repair-docker.ts — os comandos do Docker do reparo do AOF do redis (E/S crua, pelo `docker` CLI e o
 * socket que o painel já usa). A regra (o que conferir, em que ordem, quando parar) fica em aof-repair.ts.
 *
 * O container auxiliar é DESCARTÁVEL e fechado:
 *  - a MESMA imagem do serviço (onde está a ferramenta da versão certa), nunca baixada (`--pull never`);
 *  - só o volume da pasta de dados do serviço, montado no mesmo caminho (`--mount`), mais nada do projeto;
 *  - sem rede, sem capacidades além das de arquivo (dono e permissão na cópia), `no-new-privileges`,
 *    sistema de arquivos próprio só de leitura, limites de memória, CPU e processos, sem reinício;
 *  - rótulos do painel e do compose VAZIOS (os da imagem também): o monitoramento não o confunde com um
 *    container de projeto; e o rótulo `tws.aof-repair=1` diz o que ele é;
 *  - removido ao terminar (`--rm`) e, se passar do prazo, removido à força pelo nome.
 *
 * Fica fora da cobertura unitária (como backup-docker.ts e mail-test-docker.ts): o teste aof-repair-docker.test.ts
 * confere cada comando com um dublê de `run`.
 */
import { randomBytes } from "node:crypto";
import { RESTORE_CHECK_LABEL, dockerLogArgs } from "@paas/core";
import { run, type ExecResult } from "@paas/deploy";
import { sandboxBlankLabels } from "./backup-docker.js";

export type DockerRun = (file: string, args: string[], opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<ExecResult>;

/** Rótulo de todo container auxiliar do reparo. */
export const AOF_HELPER_LABEL = "tws.aof-repair";
/** Prefixo do nome do container auxiliar. */
export const AOF_HELPER_PREFIX = "tws-aof-";

export const AOF_HELPER_LIMITS = { memoryMb: 256, cpus: 1, pids: 64 } as const;

/** Uma montagem do container (o que o `docker inspect` diz). */
export interface AofMount {
  type: string;
  /** Nome do volume (tipo "volume"); null nos outros. */
  name: string | null;
  /** Caminho no host (bind) ou da área do volume. */
  source: string;
  destination: string;
  rw: boolean;
}

/** O que o reparo precisa saber do container do serviço. */
export interface AofContainerInspect {
  id: string;
  name: string;
  /** Id da imagem do container (sha256:...). */
  image: string;
  state: string;
  labels: Record<string, string>;
  workingDir: string | null;
  /** Programa e argumentos que o container roda (Path + Args). */
  argv: string[];
  mounts: AofMount[];
}

/** O container auxiliar: imagem, a montagem da pasta de dados, o script e os argumentos dele. */
export interface AofHelperSpec {
  image: string;
  mount: { type: "volume" | "bind"; source: string; destination: string };
  workdir: string;
  script: string;
  args: string[];
  timeoutMs: number;
}

export interface AofHelperResult {
  code: number;
  output: string;
  timedOut: boolean;
}

export interface AofDocker {
  inspect(id: string): Promise<AofContainerInspect | null>;
  /** Roda o auxiliar. Não lança por código de saída (quem chama decide); o código 125 é falha do próprio Docker. */
  helper(spec: AofHelperSpec): Promise<AofHelperResult>;
  stop(id: string): Promise<void>;
  start(id: string): Promise<void>;
}

/** Argumentos do `docker run` do auxiliar (puro: conferido nos testes). */
export function helperRunArgs(spec: AofHelperSpec, name: string, imageLabels: Record<string, string> | null): string[] {
  const m = spec.mount;
  const mount = m.type === "volume" ? `type=volume,src=${m.source},dst=${m.destination}` : `type=bind,src=${m.source},dst=${m.destination}`;
  return [
    "run",
    "--rm",
    "--name",
    name,
    "--pull",
    "never",
    "--network",
    "none",
    "--restart",
    "no",
    "--user",
    "0",
    "--cap-drop",
    "ALL",
    // só o que a cópia (`cp -a`) e o corte precisam num volume de outro dono: ler e gravar, dono, horários e bits
    // (conferido contra um Docker real em 15/11/2026, num ambiente de teste: cópia e corte funcionaram)
    "--cap-add",
    "CHOWN",
    "--cap-add",
    "DAC_OVERRIDE",
    "--cap-add",
    "FOWNER",
    "--cap-add",
    "FSETID",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--memory",
    `${AOF_HELPER_LIMITS.memoryMb}m`,
    "--memory-swap",
    `${AOF_HELPER_LIMITS.memoryMb}m`,
    "--cpus",
    String(AOF_HELPER_LIMITS.cpus),
    "--pids-limit",
    String(AOF_HELPER_LIMITS.pids),
    ...sandboxBlankLabels(imageLabels),
    // como nos `docker run` do painel: um LABEL do teste de restauração na imagem não esconde nada do monitoramento
    "--label",
    `${RESTORE_CHECK_LABEL}=`,
    "--label",
    `${AOF_HELPER_LABEL}=1`,
    ...dockerLogArgs(),
    "--mount",
    mount,
    "--workdir",
    spec.workdir,
    "--entrypoint",
    "sh",
    spec.image,
    "-c",
    spec.script,
    "sh",
    ...spec.args,
  ];
}

const ID_RE = /^[0-9a-f]{12,64}$/;

/** `docker inspect` (JSON) → o que o reparo usa; null se não deu para ler. */
export function parseAofInspect(stdout: string): AofContainerInspect | null {
  let doc: unknown;
  try {
    doc = (JSON.parse(stdout) as unknown[])[0];
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;
  const d = doc as {
    Id?: unknown;
    Name?: unknown;
    Image?: unknown;
    Path?: unknown;
    Args?: unknown;
    State?: { Status?: unknown } | null;
    Config?: { Labels?: unknown; WorkingDir?: unknown } | null;
    Mounts?: unknown;
  };
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  if (!ID_RE.test(str(d.Id)) || str(d.Image) === "") return null;
  const labels = d.Config?.Labels && typeof d.Config.Labels === "object" ? (d.Config.Labels as Record<string, string>) : {};
  const mounts: AofMount[] = Array.isArray(d.Mounts)
    ? d.Mounts.filter((x): x is Record<string, unknown> => x !== null && typeof x === "object").map((x) => ({
        type: str(x.Type),
        name: str(x.Name) || null,
        source: str(x.Source),
        destination: str(x.Destination),
        rw: x.RW === true,
      }))
    : [];
  return {
    id: str(d.Id),
    name: str(d.Name).replace(/^\//, ""),
    image: str(d.Image),
    state: str(d.State?.Status) || "unknown",
    labels,
    workingDir: str(d.Config?.WorkingDir) || null,
    argv: [str(d.Path), ...(Array.isArray(d.Args) ? d.Args.map(str) : [])].filter((a) => a !== ""),
    mounts,
  };
}

const TIMED_OUT = /encerrado pelo sinal|timed out|ETIMEDOUT/;

export class AofDockerCli implements AofDocker {
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    socketPath: string,
    private readonly exec: DockerRun = run,
  ) {
    const host = /^[a-z][a-z0-9+.-]*:\/\//i.test(socketPath) ? socketPath : `unix://${socketPath}`;
    this.env = { ...process.env, DOCKER_HOST: host };
  }

  async inspect(id: string): Promise<AofContainerInspect | null> {
    if (!ID_RE.test(id)) return null;
    const r = await this.exec("docker", ["inspect", "--type", "container", id], { timeoutMs: 30_000, env: this.env });
    return r.code === 0 ? parseAofInspect(r.stdout) : null;
  }

  async helper(spec: AofHelperSpec): Promise<AofHelperResult> {
    // rótulos da imagem: os do painel e do compose saem vazios (a imagem não faz o auxiliar passar por um projeto)
    let imageLabels: Record<string, string> | null = null;
    const img = await this.exec("docker", ["image", "inspect", "-f", "{{json .Config.Labels}}", spec.image], { timeoutMs: 30_000, env: this.env });
    if (img.code === 0) {
      try {
        imageLabels = JSON.parse(img.stdout) as Record<string, string> | null;
      } catch {
        imageLabels = null;
      }
    }
    const name = `${AOF_HELPER_PREFIX}${randomBytes(8).toString("hex")}`;
    const r = await this.exec("docker", helperRunArgs(spec, name, imageLabels), { timeoutMs: spec.timeoutMs, env: this.env });
    const timedOut = r.code !== 0 && TIMED_OUT.test(r.stderr);
    // passou do prazo: o `docker run` foi interrompido, mas o container pode continuar; sai à força, pelo nome
    if (timedOut) await this.exec("docker", ["rm", "-f", name], { timeoutMs: 60_000, env: this.env });
    return { code: r.code, output: `${r.stdout}${r.stderr ? (r.stdout.endsWith("\n") || r.stdout === "" ? "" : "\n") + r.stderr : ""}`, timedOut };
  }

  async stop(id: string): Promise<void> {
    const r = await this.exec("docker", ["stop", "-t", "30", id], { timeoutMs: 120_000, env: this.env });
    if (r.code !== 0) throw new Error(r.stderr.trim() || `docker stop saiu com código ${r.code}`);
  }

  async start(id: string): Promise<void> {
    const r = await this.exec("docker", ["start", id], { timeoutMs: 120_000, env: this.env });
    if (r.code !== 0) throw new Error(r.stderr.trim() || `docker start saiu com código ${r.code}`);
  }
}
