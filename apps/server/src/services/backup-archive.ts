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

export class ArchiveError extends Error {
  constructor(
    message: string,
    readonly code: "missing" | "wrong_password" | "failed" | "timeout",
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

export class SevenZip {
  private readonly bin: string;
  private readonly timeoutMs: number;

  constructor(opts: SevenZipOptions = {}) {
    this.bin = opts.bin ?? process.env.PAAS_7Z_BIN ?? "7zz";
    this.timeoutMs = opts.timeoutMs ?? 4 * 60 * 60_000;
  }

  private run(args: string[], stdin: string, cwd?: string): Promise<void> {
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
    await this.run(args, pw ? `${pw}\n` : "", opts.cwd);
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
