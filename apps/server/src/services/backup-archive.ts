/**
 * backup-archive.ts — monta, confere e abre os arquivos .7z dos backups.
 *
 * Usa o 7-Zip instalado na imagem do painel (pacote `7zip` do Debian, binário
 * `7zz`; ver Dockerfile). O .7z abre no 7-Zip (Windows) e no Keka (Mac) sem
 * o painel.
 *
 * Senha: vai pela ENTRADA PADRÃO do 7zz (ele pergunta "Enter password:" e lê
 * a linha), nunca pela linha de comando — os argumentos de qualquer processo
 * aparecem no `ps` de quem estiver no servidor. Com senha, os nomes dos
 * arquivos também são cifrados (-mhe=on). Sem senha, para nunca ficar
 * esperando uma senha que não vem, o teste e a extração passam `-p` vazio.
 */
import { spawn } from "node:child_process";
import path from "node:path";

export class ArchiveError extends Error {
  constructor(
    message: string,
    readonly code: "missing" | "wrong_password" | "failed" | "timeout" | "incomplete" | "cancelled",
  ) {
    super(message);
    this.name = "ArchiveError";
  }
}

export interface SevenZipOptions {
  /** Caminho do 7zz (padrão: PAAS_7Z_BIN ou "7zz"). */
  bin?: string;
  /** Caminho do tar (padrão: "tar"); só a listagem de um .tar de dentro do .7z usa. */
  tarBin?: string;
  /** Prazo de cada operação (padrão 4 h). */
  timeoutMs?: number;
}

const WRONG_PASSWORD_RE = /Wrong password|Cannot open encrypted archive|Break signaled|Can not open encrypted archive/i;

/** Linha de aviso do resumo do 7-Zip: "<caminho> : errno=2 : No such file or directory". */
const WARNING_LINE_RE = /^(.+?) : errno=(\d+) : (.+)$/;

function warningReason(errno: number, text: string): string {
  if (errno === 2) return "não encontrado";
  if (errno === 13) return "sem permissão de leitura";
  return text.trim();
}

/**
 * Arquivos que o 7-Zip avisou não ter lido, com o caminho a partir da
 * entrada (/tmp/x/painel/users.json → painel/users.json): o motivo do backup
 * recusado diz o que faltou sem expor a pasta temporária.
 */
export function parseArchiveWarnings(output: string, inputs: string[]): string[] {
  const seen = new Set<string>();
  for (const line of output.split("\n")) {
    const m = WARNING_LINE_RE.exec(line.trim());
    if (!m) continue;
    const file = m[1]!;
    const input = inputs.find((i) => file === i || file.startsWith(i + "/"));
    const shown = input ? path.join(path.basename(input), path.relative(input, file)) : path.basename(file);
    seen.add(`${shown} (${warningReason(Number(m[2]), m[3]!)})`);
  }
  return [...seen];
}

/** Um arquivo (não pasta) dentro do .7z, com o tamanho que ele terá depois de extraído. */
export interface ArchiveEntry {
  path: string;
  size: number;
}

/** Saída de `7zz l -slt`: blocos "Chave = valor" separados por linha em branco. Pastas e blocos sem tamanho ficam de fora. */
export function parseArchiveListing(output: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  for (const block of output.split(/\r?\n\r?\n/)) {
    const fields = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const at = line.indexOf(" = ");
      if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 3));
    }
    const file = fields.get("Path");
    const size = Number(fields.get("Size"));
    if (file !== undefined && fields.get("Folder") !== "+" && Number.isFinite(size) && fields.has("Size")) entries.push({ path: file, size });
  }
  return entries;
}

/** Quanto da listagem do 7-Zip se guarda (um .7z com milhões de nomes não deve encher a memória). */
const LISTING_MAX_CHARS = 64 * 1024 * 1024;

export class SevenZip {
  private readonly bin: string;
  private readonly tarBin: string;
  private readonly timeoutMs: number;

  constructor(opts: SevenZipOptions = {}) {
    this.bin = opts.bin ?? process.env.PAAS_7Z_BIN ?? "7zz";
    this.tarBin = opts.tarBin ?? "tar";
    this.timeoutMs = opts.timeoutMs ?? 4 * 60 * 60_000;
  }

  /**
   * `inputs`: só na criação. O código 1 do 7-Zip ("aviso") quer dizer que
   * algum arquivo não foi lido ou sumiu — o .7z sai sem ele e o teste do
   * arquivo não percebe. Ao criar, isso é falha (código "incomplete"); um
   * backup sem parte dos arquivos nunca conta como completo nem apaga
   * cópias antigas pela retenção.
   */
  private run(args: string[], stdin: string, cwd?: string, inputs?: string[], onStdout?: (text: string) => void, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new ArchiveError("Interrompido.", "cancelled"));
      const child = spawn(this.bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
      // cancelado (o teste de restauração): mata o 7-Zip na hora, para a fila andar
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        child.kill("SIGKILL");
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      let output = "";
      const keep = (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(-4000);
      };
      if (onStdout) child.stdout.on("data", (chunk: Buffer) => onStdout(chunk.toString("utf8")));
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, this.timeoutMs);
      child.on("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          err.code === "ENOENT"
            ? new ArchiveError("O 7-Zip não está instalado no container do painel. Atualize o painel (a imagem nova já traz o 7-Zip).", "missing")
            : new ArchiveError(`Não foi possível rodar o 7-Zip (${err.message}).`, "failed"),
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (aborted) return reject(new ArchiveError("Interrompido.", "cancelled"));
        if (timedOut) return reject(new ArchiveError("O 7-Zip passou do prazo e foi interrompido.", "timeout"));
        if (code === 1 && inputs) {
          const files = parseArchiveWarnings(output, inputs);
          const list = files.length > 0 ? `: ${files.slice(0, 5).join(", ")}${files.length > 5 ? ` e mais ${files.length - 5}` : ""}` : "";
          return reject(
            new ArchiveError(
              `O 7-Zip não conseguiu ler ${files.length || "algum"} arquivo(s)${list}. O backup não foi concluído e as cópias anteriores foram mantidas.`,
              "incomplete",
            ),
          );
        }
        if (code === 0 || code === 1) return resolve();
        if (WRONG_PASSWORD_RE.test(output)) {
          return reject(new ArchiveError("A senha não abre este backup.", "wrong_password"));
        }
        const line = output
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => /error|erro/i.test(l))
          .slice(-2)
          .join(" ");
        reject(new ArchiveError(`O 7-Zip falhou (código ${code})${line ? `: ${line}` : ""}.`, "failed"));
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(stdin);
    });
  }

  /** O 7zz existe e roda. */
  async available(): Promise<boolean> {
    try {
      await this.run(["i"], "");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Cria `archive` com os caminhos de `inputs` (cada um entra pelo nome, sem
   * o caminho de cima: /data/users.json → users.json; /tmp/x/bancos → bancos/…).
   */
  async create(archive: string, inputs: string[], opts: { password?: string | null; cwd?: string }): Promise<void> {
    const pw = opts.password ?? null;
    const args = ["a", "-t7z", "-mx=5", "-bd", "-bsp0", "-bso0", "-y", ...(pw ? ["-p", "-mhe=on"] : []), archive, ...inputs];
    await this.run(args, pw ? `${pw}\n` : "", opts.cwd, inputs);
  }

  /** Confere se o arquivo abre (e, cifrado, se a senha está certa). */
  async test(archive: string, password: string | null, signal?: AbortSignal): Promise<void> {
    await this.run(["t", "-bd", "-bsp0", ...(password ? [] : ["-p"]), archive], password ? `${password}\n` : "", undefined, undefined, undefined, signal);
  }

  /** Os arquivos do .7z com o tamanho que terão extraídos (para conferir o espaço ANTES de extrair). */
  async list(archive: string, password: string | null, signal?: AbortSignal): Promise<ArchiveEntry[]> {
    let text = "";
    await this.run(
      ["l", "-slt", "-ba", ...(password ? [] : ["-p"]), archive],
      password ? `${password}\n` : "",
      undefined,
      undefined,
      (chunk) => {
        if (text.length < LISTING_MAX_CHARS) text += chunk;
      },
      signal,
    );
    return parseArchiveListing(text);
  }

  /**
   * Lista o .tar `entry` de dentro do .7z SEM gravar nada no disco: o 7zz
   * extrai para a saída padrão (`x -so`, conferindo o CRC) e o `tar -t` lê dali.
   * Devolve quantas entradas o .tar tem; lança se o 7-Zip ou o tar falham.
   */
  listTar(archive: string, password: string | null, entry: string, signal?: AbortSignal): Promise<number> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new ArchiveError("Interrompido.", "cancelled"));
      const zip = spawn(this.bin, ["x", "-so", "-bd", "-bsp0", ...(password ? [] : ["-p"]), archive, entry], { stdio: ["pipe", "pipe", "pipe"] });
      const tar = spawn(this.tarBin, ["-tf", "-"], { stdio: ["pipe", "pipe", "pipe"] });
      let entries = 0;
      let partial = "";
      let zipOut = "";
      let tarOut = "";
      const done = { zip: null as number | null, tar: null as number | null };
      let failed: ArchiveError | null = null;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        zip.kill("SIGKILL");
        tar.kill("SIGKILL");
      }, this.timeoutMs);
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        zip.kill("SIGKILL");
        tar.kill("SIGKILL");
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const finish = () => {
        if (done.zip === null || done.tar === null) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (aborted) return reject(new ArchiveError("Interrompido.", "cancelled"));
        if (failed) return reject(failed);
        if (timedOut) return reject(new ArchiveError("O 7-Zip passou do prazo e foi interrompido.", "timeout"));
        if (done.zip !== 0) {
          if (WRONG_PASSWORD_RE.test(zipOut)) return reject(new ArchiveError("A senha não abre este backup.", "wrong_password"));
          return reject(new ArchiveError(`O 7-Zip falhou (código ${done.zip}) ao ler ${entry}.`, "failed"));
        }
        if (done.tar !== 0) return reject(new ArchiveError(`O arquivo ${entry} não é um .tar legível${tarOut.trim() ? ` (${tarOut.trim().split("\n").at(-1)})` : ""}.`, "failed"));
        resolve(entries + (partial.trim() ? 1 : 0));
      };
      const onError = (err: NodeJS.ErrnoException) => {
        failed ??= new ArchiveError(`Não foi possível rodar ${err.code === "ENOENT" ? "o 7-Zip ou o tar" : "a listagem"} (${err.message}).`, err.code === "ENOENT" ? "missing" : "failed");
      };
      zip.on("error", (err) => {
        onError(err);
        done.zip ??= -1;
        tar.stdin.end();
        finish();
      });
      tar.on("error", (err) => {
        onError(err);
        done.tar ??= -1;
        zip.kill("SIGKILL");
        finish();
      });
      zip.stderr.on("data", (c: Buffer) => (zipOut = (zipOut + c.toString("utf8")).slice(-4000)));
      tar.stderr.on("data", (c: Buffer) => (tarOut = (tarOut + c.toString("utf8")).slice(-2000)));
      tar.stdout.on("data", (c: Buffer) => {
        const lines = (partial + c.toString("utf8")).split("\n");
        partial = lines.pop() ?? "";
        entries += lines.filter((l) => l.length > 0).length;
      });
      tar.stdin.on("error", () => undefined);
      zip.stdin.on("error", () => undefined);
      zip.stdout.pipe(tar.stdin);
      zip.on("close", (code) => {
        done.zip ??= code ?? -1;
        finish();
      });
      tar.on("close", (code) => {
        done.tar ??= code ?? -1;
        finish();
      });
      zip.stdin.end(password ? `${password}\n` : "");
    });
  }

  /** `only`: extrai só estes caminhos do arquivo (ex.: o manifesto e a pasta dos bancos). */
  async extract(archive: string, outDir: string, password: string | null, only?: string[], signal?: AbortSignal): Promise<void> {
    await this.run(
      ["x", "-bd", "-bsp0", "-bso0", "-y", "-aoa", `-o${outDir}`, ...(password ? [] : ["-p"]), archive, ...(only ?? [])],
      password ? `${password}\n` : "",
      undefined,
      undefined,
      undefined,
      signal,
    );
  }
}
