/**
 * server-folders.ts — navegação nas pastas do servidor ("Pasta que já está no
 * servidor", modo "existing" do Novo Projeto).
 *
 * <projectsDir> é a única pasta do computador que o painel enxerga de dentro
 * do container (bind mount com o mesmo caminho): a navegação fica presa a ela.
 * Útil para quem usa o painel no próprio computador (WSL) e para código já
 * colocado na VPS pelo terminal.
 */
import { existsSync } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { httpError } from "./http-error.js";

/** Pasta interna do painel dentro da pasta de projetos (não aparece na navegação). */
export const UPLOADS_DIRNAME = "_uploads";

export interface DirListing {
  root: string;
  path: string;
  parent: string | null;
  dirs: Array<{ name: string; path: string; hasIndexHtml: boolean }>;
}

export class ServerFolders {
  constructor(private readonly projectsDir: string) {}

  /**
   * Subpastas de `dir` (padrão: a raiz), sem sair da pasta de projetos.
   *
   * O caminho pedido é conferido duas vezes: antes de tocar o disco (forma
   * textual, já normalizada — nada fora da pasta de projetos chega a ser
   * consultado) e depois de resolver os links (um link dentro da pasta que
   * aponte para fora também é recusado).
   */
  async listDirs(dir?: string): Promise<DirListing> {
    const root = await realpath(this.projectsDir);
    const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
    // A pasta de projetos como foi configurada (pode ser um link para `root`).
    const configured = path.resolve(this.projectsDir);
    const configuredPrefix = configured.endsWith(path.sep) ? configured : configured + path.sep;
    const outside = () => httpError(400, "outside_projects_dir", `Só dá para navegar dentro da pasta de projetos (${root}).`);

    const wanted = dir ? path.resolve(dir) : root;
    if (wanted !== root && !wanted.startsWith(rootPrefix) && wanted !== configured && !wanted.startsWith(configuredPrefix)) {
      throw outside();
    }
    let resolved: string;
    try {
      resolved = await realpath(wanted);
    } catch {
      throw httpError(404, "dir_not_found", "Pasta não encontrada.");
    }
    if (resolved !== root && !resolved.startsWith(rootPrefix)) throw outside();
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
