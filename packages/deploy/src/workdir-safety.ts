/**
 * workdir-safety.ts — conferências antes de o painel apagar (ou sobrescrever)
 * uma pasta de trabalho de projeto (achado A5 do lote 6).
 *
 * A pasta de trabalho de um projeto antigo é `<pasta de projetos>/<slug>`, e a
 * pasta de projetos é onde o usuário também guarda as dele. Se o slug coincide
 * com uma pasta do usuário (a fonte de outro projeto, um upload), apagar a
 * "pasta de trabalho" apagaria o código do usuário. Antes de qualquer remoção:
 *  - o alvo precisa estar DENTRO da pasta de projetos (nunca ela própria);
 *  - não pode conter nem ficar dentro da fonte do projeto;
 *  - não pode conter nem ficar dentro da fonte (ou da pasta de trabalho) de
 *    nenhum outro projeto.
 * Projetos novos vivem em `.paas/<id>` e passam sem tocar em nada do usuário.
 */
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { Project } from "@paas/core";
import { pathsOverlap, projectWorkDir, reservedRoot, type IngestContext } from "./ingest.js";

async function real(p: string): Promise<string> {
  const resolved = path.resolve(p);
  try {
    return existsSync(resolved) ? await realpath(resolved) : resolved;
  } catch {
    return resolved;
  }
}

/** Fonte local do projeto (upload/existing); git não tem pasta do usuário. */
function localSource(project: Project): string | null {
  return project.ingestMode === "git" ? null : project.source;
}

/**
 * null = pode apagar a pasta de trabalho. Texto = por que NÃO pode (vai para o
 * log do operador; nada é apagado).
 */
export async function workDirRemovalBlocker(ctx: IngestContext, project: Project, others: readonly Project[]): Promise<string | null> {
  if (project.ingestMode === "existing") return "a fonte é a pasta do próprio usuário.";
  const target = await real(projectWorkDir(ctx, project));
  const root = await real(ctx.projectsDir);
  const rel = path.relative(root, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return "a pasta de trabalho não está estritamente dentro da pasta de projetos.";
  }
  if (target === (await real(reservedRoot(ctx)))) return "a pasta de trabalho é a área reservada inteira.";

  const own = localSource(project);
  if (own && pathsOverlap(target, await real(own))) {
    return `a pasta de trabalho coincide com a pasta do código do projeto (${own}).`;
  }
  for (const other of others) {
    if (other.id === project.id) continue;
    const source = localSource(other);
    if (source && pathsOverlap(target, await real(source))) {
      return `a pasta coincide com a pasta do código do projeto "${other.name}" (${source}).`;
    }
    if (pathsOverlap(target, await real(projectWorkDir(ctx, other)))) {
      return `a pasta coincide com a pasta de trabalho do projeto "${other.name}".`;
    }
  }
  return null;
}

/** O código de origem (upload) não pode conter a pasta de trabalho nem estar dentro dela: a cópia apagaria ou se copiaria sobre si mesma. */
export async function uploadOverlapBlocker(ctx: IngestContext, project: Project): Promise<string | null> {
  const from = await real(project.source);
  const work = await real(projectWorkDir(ctx, project));
  if (pathsOverlap(from, work)) {
    return (
      `A pasta de origem (${project.source}) coincide com a pasta onde o painel guarda este projeto (${work}), ou contém ela. ` +
      "O painel não copia nem apaga nada para não perder o seu código. Crie o projeto de novo, apontando para a pasta de origem " +
      "que não seja a própria pasta de projetos."
    );
  }
  return null;
}
