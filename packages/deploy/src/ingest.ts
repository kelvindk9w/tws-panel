/**
 * ingest.ts — ingestão de código-fonte nos 3 modos (plano §5.1):
 *  - git:      clona o repositório (branch configurável) para data/projects/<slug>/src
 *  - upload:   copia um diretório local para data/projects/<slug>/src
 *  - existing: usa um caminho já existente (modo dev local; src = o próprio path)
 */
import { cp, rm } from "node:fs/promises";
import path from "node:path";
import type { Project } from "@paas/core";
import { run } from "./exec.js";

/** Diretórios/arquivos excluídos ao copiar código no modo upload. */
const UPLOAD_EXCLUDES = new Set(["node_modules", ".git", "dist", "out", "build", ".next", ".turbo"]);

export interface IngestContext {
  /** Raiz dos dados de projetos (data/projects). */
  projectsDir: string;
}

/** Diretório de trabalho do projeto (data/projects/<slug>). */
export function projectWorkDir(ctx: IngestContext, project: Project): string {
  return path.join(ctx.projectsDir, project.slug);
}

/** Diretório do código-fonte efetivo do projeto. */
export function projectSrcDir(ctx: IngestContext, project: Project): string {
  if (project.ingestMode === "existing") {
    return path.resolve(project.source);
  }
  return path.join(projectWorkDir(ctx, project), "src");
}

/**
 * Sincroniza o código-fonte conforme o modo de ingestão.
 * Retorna o diretório do código pronto para build.
 */
export async function ingestCode(
  ctx: IngestContext,
  project: Project,
  onLog: (chunk: string) => void,
): Promise<string> {
  switch (project.ingestMode) {
    case "git":
      return ingestGit(ctx, project, onLog);
    case "upload":
      return ingestUpload(ctx, project, onLog);
    case "existing":
      onLog(`Modo "existing": usando código diretamente de ${path.resolve(project.source)}\n`);
      return projectSrcDir(ctx, project);
  }
}

async function ingestGit(
  ctx: IngestContext,
  project: Project,
  onLog: (chunk: string) => void,
): Promise<string> {
  const src = projectSrcDir(ctx, project);
  const branch = project.branch ?? "main";

  const inside = await run("git", ["-C", src, "rev-parse", "--is-inside-work-tree"]);
  // Um clone existente só pode ser reaproveitado se ainda corresponder ao que
  // está configurado. O clone é --single-branch: se a branch mudou, o checkout
  // falharia porque a nova branch nem existe localmente. E se a URL do
  // repositório mudou, o fetch traria o código do repositório ANTIGO sem erro
  // algum — falha silenciosa. Nos dois casos, re-clonar é a saída correta.
  if (inside.code === 0 && inside.stdout.trim() === "true") {
    const origemAtual = await run("git", ["-C", src, "remote", "get-url", "origin"]);
    const branchAtual = await run("git", ["-C", src, "rev-parse", "--abbrev-ref", "HEAD"]);
    const mesmoRepositorio = origemAtual.stdout.trim() === project.source;
    const mesmaBranch = branchAtual.stdout.trim() === branch;

    if (!mesmoRepositorio) {
      onLog(
        `Repositório configurado mudou (${origemAtual.stdout.trim()} → ${project.source}). ` +
          `Refazendo o clone do zero…\n`,
      );
    } else if (!mesmaBranch) {
      onLog(
        `Branch configurada mudou (${branchAtual.stdout.trim()} → ${branch}). ` +
          `Refazendo o clone do zero…\n`,
      );
    }

    if (mesmoRepositorio && mesmaBranch) {
      onLog(`Atualizando clone existente (git fetch + checkout ${branch})…\n`);
      const fetch = await run("git", ["-C", src, "fetch", "--all", "--prune"], { timeoutMs: 600_000 });
      if (fetch.code !== 0) throw new Error(`git fetch falhou: ${fetch.stderr.trim()}`);
      const checkout = await run("git", ["-C", src, "checkout", branch]);
      if (checkout.code !== 0) throw new Error(`git checkout ${branch} falhou: ${checkout.stderr.trim()}`);
      const pull = await run("git", ["-C", src, "pull", "--ff-only", "origin", branch], { timeoutMs: 600_000 });
      if (pull.code !== 0) throw new Error(`git pull falhou: ${pull.stderr.trim()}`);
      onLog(pull.stdout);
      return src;
    }
  }

  onLog(`Clonando ${project.source} (branch ${branch})…\n`);
  await rm(src, { recursive: true, force: true });
  const clone = await run(
    "git",
    ["clone", "--branch", branch, "--single-branch", project.source, src],
    { timeoutMs: 900_000 },
  );
  if (clone.code !== 0) throw new Error(`git clone falhou: ${clone.stderr.trim()}`);
  onLog(clone.stderr || clone.stdout);
  return src;
}

async function ingestUpload(
  ctx: IngestContext,
  project: Project,
  onLog: (chunk: string) => void,
): Promise<string> {
  const from = path.resolve(project.source);
  const to = projectSrcDir(ctx, project);
  onLog(`Copiando ${from} → ${to} (excluindo ${[...UPLOAD_EXCLUDES].join(", ")})…\n`);
  await rm(to, { recursive: true, force: true });
  await cp(from, to, {
    recursive: true,
    filter: (srcPath) => {
      const base = path.basename(srcPath);
      return !UPLOAD_EXCLUDES.has(base);
    },
  });
  onLog("Cópia concluída.\n");
  return to;
}
