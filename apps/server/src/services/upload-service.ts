/**
 * upload-service.ts — código que vem do computador de quem usa o painel, e
 * navegação nas pastas do servidor.
 *
 * O navegador não pode entregar ao servidor o CAMINHO de uma pasta do
 * computador da pessoa (nem do WSL), mas pode enviar os ARQUIVOS da pasta que
 * ela escolher numa janela. Cada arquivo chega numa requisição e é gravado em
 * <projectsDir>/_uploads/<id>/, que vira a origem do projeto (modo "upload").
 *
 * <projectsDir> é a única pasta do computador que o painel enxerga de dentro
 * do container (bind mount com o mesmo caminho): a navegação de pastas
 * ("pasta no servidor", modo "existing") fica presa a ela.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { httpError } from "./http-error.js";
import { isInside } from "./projects-dir.js";

/** Pasta das sessões de envio, dentro da pasta de projetos. */
export const UPLOADS_DIRNAME = "_uploads";

/** Pastas que o painel não aceita receber (pesadas e reconstruídas no build, ou internas do git). */
const REFUSED_SEGMENTS = new Set(["node_modules", ".git"]);

export const UPLOAD_MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const DEFAULT_MAX_FILES = 10_000;
const SESSION_TTL_MS = 60 * 60_000;

interface Session {
  dir: string;
  bytes: number;
  files: number;
  expiresAt: number;
}

export interface DirListing {
  root: string;
  path: string;
  parent: string | null;
  dirs: Array<{ name: string; path: string; hasIndexHtml: boolean }>;
}

/** Caminho relativo seguro (sem sair da pasta de envio) ou null. */
function safeRelative(rel: string): string | null {
  if (!rel || rel.includes("\0") || rel.includes("\\") || path.isAbsolute(rel)) return null;
  const parts = rel.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0) return null;
  if (parts.some((p) => p === ".." || REFUSED_SEGMENTS.has(p) || p.length > 255)) return null;
  return parts.join("/");
}

export class UploadService {
  private readonly sessions = new Map<string, Session>();
  private readonly maxTotalBytes: number;
  private readonly maxFiles: number;

  constructor(
    private readonly projectsDir: string,
    opts: { maxTotalBytes?: number; maxFiles?: number } = {},
  ) {
    this.maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  }

  /** Abre uma sessão de envio: a pasta que vai receber os arquivos. */
  async begin(): Promise<{ id: string; dir: string }> {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (s.expiresAt < now) this.sessions.delete(id);
    const id = randomBytes(8).toString("hex");
    const dir = path.join(this.projectsDir, UPLOADS_DIRNAME, id);
    await mkdir(dir, { recursive: true });
    this.sessions.set(id, { dir, bytes: 0, files: 0, expiresAt: now + SESSION_TTL_MS });
    return { id, dir };
  }

  /** Grava um arquivo da pasta enviada, no caminho relativo dele. */
  async putFile(id: string, relPath: string, data: Buffer): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || session.expiresAt < Date.now()) {
      throw httpError(404, "upload_not_found", "Envio não encontrado ou expirado. Escolha a pasta de novo.");
    }
    const rel = safeRelative(relPath);
    if (!rel) {
      throw httpError(400, "invalid_path", `Caminho de arquivo recusado: ${JSON.stringify(relPath.slice(0, 200))}.`);
    }
    if (session.files + 1 > this.maxFiles) {
      throw httpError(
        413,
        "upload_too_many_files",
        `A pasta passou de ${this.maxFiles} arquivos. Confira se escolheu a pasta certa (a do projeto, não uma acima).`,
      );
    }
    if (session.bytes + data.length > this.maxTotalBytes) {
      throw httpError(
        413,
        "upload_too_large",
        `A pasta passou de ${Math.round(this.maxTotalBytes / 1024 / 1024)} MB. Confira se escolheu a pasta certa ` +
          "(pastas de build e dependências já ficam de fora).",
      );
    }
    const target = path.join(session.dir, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
    session.files += 1;
    session.bytes += data.length;
  }

  /** Subpastas de `dir` (padrão: a raiz), sem sair da pasta de projetos. */
  async listDirs(dir?: string): Promise<DirListing> {
    const root = await realpath(this.projectsDir);
    const wanted = dir ? path.resolve(dir) : root;
    const resolved = existsSync(wanted) ? await realpath(wanted) : wanted;
    if (!isInside(root, resolved)) {
      throw httpError(400, "outside_projects_dir", `Só dá para navegar dentro da pasta de projetos (${root}).`);
    }
    if (!existsSync(resolved)) throw httpError(404, "dir_not_found", "Pasta não encontrada.");
    const entries = await readdir(resolved, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !(resolved === root && e.name === UPLOADS_DIRNAME))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => {
        const full = path.join(resolved, name);
        return { name, path: full, hasIndexHtml: existsSync(path.join(full, "index.html")) };
      });
    return { root, path: resolved, parent: resolved === root ? null : path.dirname(resolved), dirs };
  }
}
