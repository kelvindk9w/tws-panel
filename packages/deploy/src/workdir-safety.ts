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
import { mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
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

/** Arquivos que o painel gera na pasta de trabalho (têm segredos: saem sempre com o projeto). */
const PANEL_FILES = ["paas.env", "paas.up.env", "paas.canonical.json"];
/** Entradas que o painel cria na pasta de trabalho de um projeto de código gerenciado (git/upload). */
const PANEL_ENTRIES = ["src", "repo.git", "site", ...PANEL_FILES];

export interface WorkDirRemoval {
  /** Entradas apagadas. */
  removed: string[];
  /** Entradas do usuário que ficaram na pasta (pasta antiga compartilhada). */
  kept: string[];
  /** A pasta de trabalho inteira foi apagada. */
  folderRemoved: boolean;
  /** Entradas que o painel criou mas NÃO apagou, com o motivo. */
  skipped: string[];
}

async function overlapsAnyOtherProject(ctx: IngestContext, project: Project, others: readonly Project[], target: string): Promise<string | null> {
  const own = localSource(project);
  if (own && pathsOverlap(target, await real(own))) return `coincide com a pasta do código deste projeto (${own})`;
  for (const other of others) {
    if (other.id === project.id) continue;
    const source = localSource(other);
    if (source && pathsOverlap(target, await real(source))) return `coincide com a pasta do código do projeto "${other.name}" (${source})`;
    if (pathsOverlap(target, await real(projectWorkDir(ctx, other)))) return `coincide com a pasta de trabalho do projeto "${other.name}"`;
  }
  return null;
}

/**
 * Remoção da pasta de trabalho, SOMENTE do que o painel cria (achado A5).
 *
 * - Pasta reservada (`.paas/<id>`): é toda do painel. Sai inteira ao apagar o
 *   código; sem apagar o código, saem só os arquivos com segredos (paas.*) —
 *   e, se a fonte é a pasta do usuário ("existing"), a pasta toda (só tem isso).
 * - Pasta antiga (`<projetos>/<slug>`): pode ser compartilhada com arquivos do
 *   usuário. Só se apaga o que o painel cria (`src`, `repo.git`, `site`, `paas.*`)
 *   e a pasta só vai embora se ficar vazia; o resto é listado em `kept`.
 */
export async function removeProjectWorkDir(
  ctx: IngestContext,
  project: Project,
  others: readonly Project[],
  opts: { deleteSource: boolean },
): Promise<WorkDirRemoval> {
  const out: WorkDirRemoval = { removed: [], kept: [], folderRemoved: false, skipped: [] };
  const dir = projectWorkDir(ctx, project);
  if (!existsSync(dir)) return out;
  const target = await real(dir);
  const root = await real(ctx.projectsDir);
  const rel = path.relative(root, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel) || target === (await real(reservedRoot(ctx)))) {
    out.skipped.push(`${dir}: a pasta de trabalho não está estritamente dentro da pasta de projetos`);
    return out;
  }
  const reserved = project.storageLayout === "reserved";
  const names = await readdir(dir);

  if (reserved && (opts.deleteSource || project.ingestMode === "existing")) {
    // Pasta do painel (nome validado pelo id): só ela é apagada, nunca a fonte do usuário.
    await rm(dir, { recursive: true, force: true });
    out.removed.push(...names);
    out.folderRemoved = true;
    return out;
  }

  const candidates = reserved || !opts.deleteSource ? PANEL_FILES : PANEL_ENTRIES;
  for (const name of names) {
    if (!candidates.includes(name)) continue;
    const entry = path.join(dir, name);
    const conflict = await overlapsAnyOtherProject(ctx, project, others, await real(entry));
    if (conflict) {
      out.skipped.push(`${name}: ${conflict}`);
      continue;
    }
    await rm(entry, { recursive: true, force: true });
    out.removed.push(name);
  }
  const rest = await readdir(dir);
  if (rest.length === 0 && opts.deleteSource && !reserved && project.ingestMode !== "existing") {
    const conflict = await overlapsAnyOtherProject(ctx, project, others, target);
    if (!conflict) {
      await rm(dir, { recursive: true, force: true });
      out.folderRemoved = true;
    }
  } else {
    out.kept.push(...rest);
  }
  return out;
}

/**
 * Projeto "existing"/"upload" criado antes da área reservada: move o que o
 * painel gera (paas.*; e, no upload, também src/repo.git/site) de
 * `<projetos>/<slug>` para `<projetos>/.paas/<id>`. Só se MOVE (nada é apagado
 * nem sobrescrito); a fonte do usuário não é tocada. Idempotente.
 * Devolve as entradas movidas, ou null quando não havia o que migrar.
 */
export async function migrateLegacyWorkDir(ctx: IngestContext, project: Project): Promise<string[] | null> {
  if (project.storageLayout === "reserved") return null;
  if (project.ingestMode === "git") return null;
  const oldDir = projectWorkDir(ctx, project);
  const migrated: Project = { ...project, storageLayout: "reserved" };
  const newDir = projectWorkDir(ctx, migrated);
  const moved: string[] = [];
  if (existsSync(oldDir)) {
    const names = project.ingestMode === "existing" ? PANEL_FILES : PANEL_ENTRIES;
    await mkdir(newDir, { recursive: true });
    for (const name of names) {
      const from = path.join(oldDir, name);
      const to = path.join(newDir, name);
      if (!existsSync(from) || existsSync(to)) continue;
      await rename(from, to);
      moved.push(name);
    }
  }
  project.storageLayout = "reserved";
  return moved;
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
