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
    readonly code: "missing" | "wrong_password" | "failed" | "timeout" | "incomplete",
  ) {
    super(message);
    this.name = "ArchiveError";
  }
}

export interface SevenZipOptions {
  /** Caminho do 7zz (padrão: PAAS_7Z_BIN ou "7zz"). */
  bin?: string;
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

export class SevenZip {
  private readonly bin: string;
  private readonly timeoutMs: number;

  constructor(opts: SevenZipOptions = {}) {
    this.bin = opts.bin ?? process.env.PAAS_7Z_BIN ?? "7zz";
    this.timeoutMs = opts.timeoutMs ?? 4 * 60 * 60_000;
  }

  /**
   * `inputs`: só na criação. O código 1 do 7-Zip ("aviso") quer dizer que
   * algum arquivo não foi lido ou sumiu — o .7z sai sem ele e o teste do
   * arquivo não percebe. Ao criar, isso é falha (código "incomplete"); um
   * backup sem parte dos arquivos nunca conta como completo nem apaga
   * cópias antigas pela retenção.
   */
  private run(args: string[], stdin: string, cwd?: string, inputs?: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      const keep = (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(-4000);
      };
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
  async test(archive: string, password: string | null): Promise<void> {
    await this.run(["t", "-bd", "-bsp0", ...(password ? [] : ["-p"]), archive], password ? `${password}\n` : "");
  }

  async extract(archive: string, outDir: string, password: string | null): Promise<void> {
    await this.run(
      ["x", "-bd", "-bsp0", "-bso0", "-y", "-aoa", `-o${outDir}`, ...(password ? [] : ["-p"]), archive],
      password ? `${password}\n` : "",
    );
  }
}
