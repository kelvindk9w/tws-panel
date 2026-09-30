import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";

/** true se `candidate` é `root` ou está dentro dele (caminhos já resolvidos). */
export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Confere se um caminho local de projeto fica dentro da pasta de projetos. */
export async function isInsideProjectsDir(projectsDir: string, candidate: string): Promise<boolean> {
  const root = existsSync(projectsDir) ? await realpath(projectsDir) : path.resolve(projectsDir);
  const resolved = existsSync(candidate) ? await realpath(candidate) : path.resolve(candidate);
  return isInside(root, resolved);
}
