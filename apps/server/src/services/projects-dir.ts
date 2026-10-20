import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";

/** true se `candidate` é `root` ou está dentro dele (caminhos já resolvidos). */
export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * A pasta é a própria pasta de projetos ou a área que o painel reserva dentro
 * dela (`.paas`)? Nenhuma das duas pode ser a fonte de um projeto: a primeira
 * contém a área do painel (e as pastas de todos os outros projetos), a segunda
 * é o que o painel gera.
 */
export async function isPanelArea(projectsDir: string, candidate: string): Promise<boolean> {
  const root = existsSync(projectsDir) ? await realpath(projectsDir) : path.resolve(projectsDir);
  const resolved = existsSync(candidate) ? await realpath(candidate) : path.resolve(candidate);
  return resolved === root || isInside(path.join(root, ".paas"), resolved);
}

/** As duas pastas são a mesma (links resolvidos)? */
export async function sameFolder(a: string, b: string): Promise<boolean> {
  const real = async (p: string) => (existsSync(p) ? await realpath(p) : path.resolve(p));
  return (await real(a)) === (await real(b));
}

/** Confere se um caminho local de projeto fica dentro da pasta de projetos. */
export async function isInsideProjectsDir(projectsDir: string, candidate: string): Promise<boolean> {
  const root = existsSync(projectsDir) ? await realpath(projectsDir) : path.resolve(projectsDir);
  const resolved = existsSync(candidate) ? await realpath(candidate) : path.resolve(candidate);
  return isInside(root, resolved);
}
