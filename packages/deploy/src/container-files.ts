/**
 * container-files.ts — entrega arquivos de configuração a um container
 * PELO DAEMON DOCKER, sem bind mount de caminho do painel.
 *
 * Por que existe: em produção o painel roda dentro de um container e fala com
 * o daemon do HOST pelo socket. O lado esquerdo de um `-v caminho:destino` é
 * resolvido no sistema de arquivos do HOST, onde o `/data` do painel não existe
 * (é um volume nomeado). O daemon criava um diretório vazio no lugar do
 * arquivo e o Caddy/Stalwart subiam sem configuração. `docker cp -` recebe um
 * tar pela entrada padrão e o extrai dentro do container (camada gravável ou
 * volume montado nele), funciona com o container parado ou rodando, e se
 * comporta igual com o painel no host (desenvolvimento) ou em container
 * (produção) — sem precisar saber qual é o caso.
 *
 * Duplicado em packages/mailer/src/container-files.ts: os dois pacotes não
 * dependem um do outro e @paas/core não executa processos.
 */
import { spawn } from "node:child_process";

export interface ContainerFile {
  /** Caminho relativo dentro do diretório de destino (ex.: "Caddyfile", "etc/config.toml"). Termina em "/" para diretório. */
  name: string;
  /** Conteúdo do arquivo (ignorado para diretório). */
  content?: string | Buffer;
  /** Permissões (padrão 0644 para arquivo, 0755 para diretório). */
  mode?: number;
}

export interface InputExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

const BLOCK = 512;

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

/** Nome seguro para o tar: relativo, sem "..", ASCII e dentro do limite do ustar. */
function assertSafeName(name: string): void {
  const parts = name.replace(/\/$/, "").split("/");
  if (
    !name ||
    name.startsWith("/") ||
    parts.some((p) => p === "" || p === "." || p === "..") ||
    !/^[\x21-\x7e]+$/.test(name) ||
    Buffer.byteLength(name) > 99
  ) {
    throw new Error(`nome de arquivo inválido para cópia ao container: ${JSON.stringify(name)}`);
  }
}

/** Monta um arquivo tar (formato ustar) em memória. */
export function tarArchive(files: ContainerFile[], mtime = Math.floor(Date.now() / 1000)): Buffer {
  const chunks: Buffer[] = [];
  for (const file of files) {
    assertSafeName(file.name);
    const isDir = file.name.endsWith("/");
    const body = isDir ? Buffer.alloc(0) : Buffer.from(file.content ?? "");
    const header = Buffer.alloc(BLOCK, 0);
    header.write(file.name, 0, 100, "utf8");
    header.write(octal(file.mode ?? (isDir ? 0o755 : 0o644), 8), 100, 8, "ascii");
    header.write(octal(0, 8), 108, 8, "ascii"); // uid
    header.write(octal(0, 8), 116, 8, "ascii"); // gid
    header.write(octal(body.length, 12), 124, 12, "ascii");
    header.write(octal(mtime, 12), 136, 12, "ascii");
    header.write("        ", 148, 8, "ascii"); // checksum provisório (espaços)
    header.write(isDir ? "5" : "0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    chunks.push(header, body);
    const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
    if (pad) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(chunks);
}

/**
 * Executa um comando entregando `input` pela entrada padrão. Mesmo contrato
 * de retorno de `run()`: nunca rejeita; falha ao iniciar vira code 1 com a
 * causa no stderr.
 */
export function runWithInput(
  file: string,
  args: string[],
  input: Buffer,
  opts?: { timeoutMs?: number },
): Promise<InputExecResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: InputExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timeoutMs = opts?.timeoutMs ?? 120_000;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: 1, stdout, stderr: `${stderr}Comando "${file}" excedeu o tempo limite de ${Math.round(timeoutMs / 1000)}s.` });
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    // EPIPE quando o processo sai sem ler tudo: o código de saída já conta a história.
    child.stdin.on("error", () => {});
    child.on("error", (err) => {
      finish({ code: 1, stdout, stderr: `${stderr}Falha ao executar "${file}": ${err.message}` });
    });
    child.on("close", (code) => finish({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

/**
 * Copia arquivos para `destDir` dentro do container, via `docker cp -`.
 * `destDir` precisa existir no container (a imagem ou um volume o criam);
 * subdiretórios podem ser criados listando-os com "/" no fim do nome.
 */
export async function copyFilesToContainer(
  container: string,
  destDir: string,
  files: ContainerFile[],
): Promise<InputExecResult> {
  return runWithInput("docker", ["cp", "-", `${container}:${destDir}`], tarArchive(files));
}

export interface ContainerMount {
  type: string;
  destination: string;
}

/**
 * Formato de `docker inspect -f` que devolve "running|<json das montagens>".
 * Interpretado por parseContainerInspect.
 */
export const INSPECT_RUNNING_AND_MOUNTS = "{{json .State.Running}}|{{json .Mounts}}";

export function parseContainerInspect(stdout: string): { running: boolean; mounts: ContainerMount[] } {
  const sep = stdout.indexOf("|");
  const running = stdout.slice(0, sep === -1 ? undefined : sep).trim() === "true";
  let mounts: ContainerMount[] = [];
  if (sep !== -1) {
    try {
      const raw = JSON.parse(stdout.slice(sep + 1).trim()) as unknown;
      if (Array.isArray(raw)) {
        mounts = raw.map((m: { Type?: unknown; Destination?: unknown }) => ({
          type: String(m?.Type ?? ""),
          destination: String(m?.Destination ?? ""),
        }));
      }
    } catch {
      mounts = [];
    }
  }
  return { running, mounts };
}

/**
 * Montagem herdada da versão antiga: um bind mount (caminho do painel) sobre
 * o destino da configuração. Um container assim precisa ser recriado — em
 * produção ele enxerga um diretório vazio criado pelo daemon no host.
 */
export function hasLegacyConfigBind(mounts: ContainerMount[], configPath: string): boolean {
  const base = configPath.replace(/\/+$/, "");
  return mounts.some(
    (m) =>
      m.type === "bind" &&
      (m.destination === base || m.destination.startsWith(`${base}/`) || base.startsWith(`${m.destination}/`)),
  );
}
