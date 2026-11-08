/**
 * backup-docker.ts — os comandos do Docker que o backup usa (E/S crua).
 *
 * Tudo passa pelo socket do Docker que o painel já usa; nada roda no host
 * fora do Docker. A regra (o que copiar, em que ordem) fica no
 * backup-service.ts — este arquivo só executa. Por isso fica fora da
 * cobertura unitária (como docker-service.ts) e é validado pelo teste de
 * ponta a ponta com Docker de verdade (ver relatório interno backups).
 *
 *  - dump de banco: `docker exec <container> sh -c '<script>'`, saída
 *    gravada direto num arquivo (o dump nunca passa inteiro pela memória);
 *  - volumes e pastas: `docker cp <container>:<caminho> -` (um .tar, com
 *    dono e permissões) e, na volta, um container auxiliar descartável
 *    (`--volumes-from` ou `-v volume:/v`, imagem PAAS_HOST_HELPER_IMAGE) que
 *    esvazia a pasta e extrai o .tar;
 *  - tamanho: o mesmo auxiliar roda `du -sk` em cada montagem;
 *  - teste de restauração: um container DESCARTÁVEL da imagem do banco
 *    (`docker run -d --network none`, sem volumes do projeto, com limite de
 *    memória, CPU e processos, sem baixar imagem), sempre com o rótulo
 *    `tws.restore-check=1`, removido com os volumes anônimos (`rm -f -v`).
 */
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import type { Readable } from "node:stream";
import { COMPOSE_PROJECT_LABEL, PAAS_LABEL_MANAGED, PAAS_LABEL_PROJECT, RESTORE_CHECK_LABEL } from "@paas/core";
import { listContainers } from "./docker-service.js";
import type { ContainerInspect } from "./backup-detect.js";

export interface ProjectContainer {
  id: string;
  name: string;
  service: string;
  running: boolean;
}

/** Rótulo de todo container descartável do teste de restauração: só um container com ele é removido. */
export const SANDBOX_LABEL = RESTORE_CHECK_LABEL;

/** Rótulo com o id do projeto de origem do container descartável. */
export const SANDBOX_PROJECT_LABEL = `${RESTORE_CHECK_LABEL}.project`;

/** Container descartável que existe no Docker (pelo rótulo). */
export interface SandboxEntry {
  name: string;
  /** Projeto de origem (rótulo SANDBOX_PROJECT_LABEL); null = sem o rótulo. */
  projectId: string | null;
}

/**
 * Rótulos que o container descartável recebe VAZIOS, além dos `paas.*`/`com.docker.compose.*` que a imagem traga:
 * como nos containers de `docker run` do painel (CONTAINER_HARDENING), a label do compose vazia vale como ausente,
 * e sem `paas.managed=true` nem `paas.project` o container não é de projeto nenhum (ver container-identity.ts).
 */
const SANDBOX_BLANK_LABELS = [COMPOSE_PROJECT_LABEL, "com.docker.compose.service", PAAS_LABEL_MANAGED, PAAS_LABEL_PROJECT];

/** Os `--label chave=` que neutralizam os rótulos do painel e do compose herdados da imagem. */
export function sandboxBlankLabels(imageLabels: Record<string, string> | null | undefined): string[] {
  const keys = new Set(SANDBOX_BLANK_LABELS);
  for (const k of Object.keys(imageLabels ?? {})) {
    if (k.startsWith("paas.") || k.startsWith("com.docker.compose.") || (k.startsWith(`${RESTORE_CHECK_LABEL}.`) && k !== SANDBOX_PROJECT_LABEL)) keys.add(k);
  }
  return [...keys].sort().flatMap((k) => ["--label", `${k}=`]);
}

/** O container descartável do teste de restauração. */
export interface SandboxSpec {
  name: string;
  /** Id (ou nome) da imagem; nunca é baixada (`--pull never`). */
  image: string;
  /** Variáveis de ambiente (sem segredo: o container não tem rede). */
  env: Record<string, string>;
  /** Rótulos além do SANDBOX_LABEL. */
  labels: Record<string, string>;
  memoryMb: number;
  cpus: number;
  pids: number;
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
  /** Roda o script com `inFile` (arquivo, ou um fluxo já aberto) na entrada. `opts.timeoutMs`: prazo próprio (padrão: o do Docker, 2 h). */
  execFromFile(container: string, script: string, args: string[], inFile: string | Readable, opts?: { timeoutMs?: number }): Promise<{ stderr: string; stdout?: string }>;
  copyOut(container: string, path: string, outFile: string): Promise<void>;
  copyIn(container: string, parentPath: string, tarFile: string): Promise<void>;
  /** Esvazia `destination` e extrai o .tar (do `docker cp`) nela, com o container parado. */
  restorePath(container: string, destination: string, tarFile: string, isFile: boolean): Promise<void>;
  restoreVolume(volume: string, tarFile: string): Promise<void>;
  /**
   * Junta o .tar (do `docker cp` de /data) ao volume SEM esvaziá-lo: arquivos
   * de mesmo caminho são trocados, o resto fica; dono root e permissões
   * fechadas (pastas 0700, arquivos 0600). Para os dados do Caddy.
   */
  mergeVolume(volume: string, tarFile: string): Promise<void>;
  state(container: string): Promise<{ exists: boolean; running: boolean }>;
  stop(container: string): Promise<void>;
  start(container: string): Promise<void>;
  /** Sobe o container descartável do teste de restauração (desanexado). */
  runSandbox(spec: SandboxSpec): Promise<void>;
  /**
   * Remove o container descartável e os volumes anônimos dele. Só remove um
   * container com o rótulo SANDBOX_LABEL. true = confirmado que não existe mais.
   */
  removeSandbox(name: string): Promise<boolean>;
  /** Containers descartáveis do teste que existem (pelo rótulo), com o projeto de origem. */
  listSandboxes(): Promise<SandboxEntry[]>;
}

export interface DockerCliOptions {
  socketPath: string;
  helperImage: string;
  /** Prazo de cada comando (padrão 2 h). */
  timeoutMs?: number;
}

interface RunOptions {
  stdinFile?: string | Readable;
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

/**
 * Junta o .tar ao volume (dados do Caddy: certificados e conta ACME, com
 * chaves privadas). Não esvazia e NÃO sobrescreve: o que o Caddy desta VPS já
 * emitiu continua, e um arquivo de mesmo caminho do backup é descartado (um
 * certificado novo nunca é trocado por um velho). Roda como root no container
 * auxiliar (o Caddy da imagem oficial é root): dono 0:0, pastas 0700 e
 * arquivos 0600 — como o certmagic grava. Travas (locks/) velhas que vierem no
 * backup viram "vencidas" em segundos e o certmagic as apaga sozinho.
 *
 * Argumentos: $1 = pasta do volume; $2 (opcional) = arquivo .tar (sem ele, lê
 * do stdin). O .tar só pode ter arquivos e pastas: link (simbólico ou duro),
 * dispositivo, FIFO e socket são RECUSADOS (a listagem recusa o que o tar mostra
 * como link; depois de extrair, a pasta de passagem é conferida de novo e recusa
 * também link duro, que o tar do busybox lista como arquivo comum). A extração
 * vai para uma pasta de passagem no próprio volume e só então cada arquivo
 * ausente é movido ao lugar (portátil: busybox e GNU, sem depender do código de
 * saída de `tar -k`). O trap garante dono e permissão (e a limpeza) mesmo se a
 * extração falhar no meio. Sem aspas simples: o mesmo texto vai dentro de
 * aspas simples em scripts/restaurar-painel.sh.
 */
export const MERGE_VOLUME_SCRIPT = [
  "set -e",
  'd="$1"',
  'src="${2:-}"',
  's="$d/.restaurando.$$"',
  't=""',
  "fix() {",
  "  code=$?",
  "  set +e",
  '  rm -rf "$s"',
  '  [ -z "$t" ] || rm -f "$t"',
  '  [ "$(id -u)" != "0" ] || chown -R 0:0 "$d"',
  '  find "$d" -type d -exec chmod 700 {} +',
  '  find "$d" -type f -exec chmod 600 {} +',
  '  exit "$code"',
  "}",
  "merge() {",
  '  for e in "$1"/* "$1"/.[!.]* "$1"/..?*; do',
  '    [ -e "$e" ] || continue',
  '    n="${e#$s/}"',
  '    if [ -d "$e" ]; then',
  '      mkdir -p "$d/$n"',
  '      merge "$e"',
  '    elif [ ! -e "$d/$n" ]; then',
  '      mv "$e" "$d/$n"',
  "    fi",
  "  done",
  "}",
  'mkdir -p "$d"',
  "trap fix EXIT",
  'if [ -z "$src" ]; then t="$(mktemp)"; cat > "$t"; src="$t"; fi',
  'if tar -tvf "$src" | grep -q "^[^-d]"; then echo "o backup traz link ou arquivo especial; recusado" >&2; exit 1; fi',
  'rm -rf "$s"',
  'mkdir -p "$s"',
  'tar -xf "$src" -C "$s" --strip-components=1',
  'if [ -n "$(find "$s" \\( ! -type f ! -type d \\) -o \\( -type f -links +1 \\))" ]; then echo "o backup traz link ou arquivo especial; recusado" >&2; exit 1; fi',
  'merge "$s"',
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
          // `stderr` fica no erro: quem restaura de um arquivo mostra o final dele (até 20 mil caracteres) como saída da falha.
          if (code !== 0) return reject(Object.assign(new Error(stderr.trim().split("\n").slice(-3).join(" ") || `docker saiu com código ${code}`), { stderr }));
          resolve({ stdout, stderr });
        });
      });
      child.stdin.on("error", () => undefined);
      if (o.stdinFile) {
        const input = typeof o.stdinFile === "string" ? createReadStream(o.stdinFile) : o.stdinFile;
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

  async execFromFile(container: string, script: string, args: string[], inFile: string | Readable, opts?: { timeoutMs?: number }): Promise<{ stderr: string; stdout: string }> {
    return this.run(["exec", "-i", container, "sh", "-c", script, "sh", ...args], { stdinFile: inFile, timeoutMs: opts?.timeoutMs });
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

  async mergeVolume(volume: string, tarFile: string): Promise<void> {
    await this.run(
      ["run", "--rm", "-i", "--network", "none", "--user", "0", "-v", `${volume}:/v`, this.opts.helperImage, "sh", "-c", MERGE_VOLUME_SCRIPT, "sh", "/v"],
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

  async runSandbox(spec: SandboxSpec): Promise<void> {
    // Rótulos da imagem: os do painel e do compose saem vazios (a imagem do banco não faz o container passar por um projeto).
    let imageLabels: Record<string, string> | null = null;
    try {
      imageLabels = JSON.parse((await this.run(["image", "inspect", "-f", "{{json .Config.Labels}}", spec.image], { timeoutMs: 30_000 })).stdout) as Record<string, string> | null;
    } catch (err) {
      // imagem ausente: o `docker run --pull never` abaixo diz isso com a mensagem do Docker
      if (!/no such image/i.test(err instanceof Error ? err.message : "")) throw err;
    }
    await this.run(
      [
        "run",
        "-d",
        "--name",
        spec.name,
        "--pull",
        "never",
        "--network",
        "none",
        "--memory",
        `${spec.memoryMb}m`,
        "--memory-swap",
        `${spec.memoryMb}m`,
        "--cpus",
        String(spec.cpus),
        "--pids-limit",
        String(spec.pids),
        "--cap-drop",
        "NET_RAW",
        "--security-opt",
        "no-new-privileges",
        "--restart",
        "no",
        ...sandboxBlankLabels(imageLabels),
        "--label",
        `${SANDBOX_LABEL}=1`,
        ...Object.entries(spec.labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
        ...Object.entries(spec.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
        spec.image,
      ],
      { timeoutMs: 120_000 },
    );
  }

  async removeSandbox(name: string): Promise<boolean> {
    let label: string;
    try {
      label = (await this.run(["inspect", "-f", `{{index .Config.Labels "${SANDBOX_LABEL}"}}`, name], { timeoutMs: 30_000 })).stdout.trim();
    } catch (err) {
      // não existe (já foi removido): confirmado; o Docker fora do ar não confirma nada
      return /no such (object|container)/i.test(err instanceof Error ? err.message : "");
    }
    if (label !== "1") return false;
    try {
      await this.run(["rm", "-f", "-v", name], { timeoutMs: 120_000 });
    } catch {
      /* confere abaixo */
    }
    return (await this.probe(name).catch(() => "unknown")) === "missing";
  }

  async listSandboxes(): Promise<SandboxEntry[]> {
    const { stdout } = await this.run(["ps", "-a", "--filter", `label=${SANDBOX_LABEL}=1`, "--format", `{{.Names}}|{{.Label "${SANDBOX_PROJECT_LABEL}"}}`], {
      timeoutMs: 30_000,
    });
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [name = "", projectId = ""] = l.split("|");
        return { name, projectId: projectId || null };
      });
  }
}
