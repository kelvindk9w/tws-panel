/**
 * Ingestão git: troca de branch e de repositório em projeto já clonado.
 *
 * O clone é feito com --single-branch, então o clone local conhece apenas a
 * branch de origem. Atualizar via fetch+checkout só funciona enquanto a branch
 * configurada não muda; quando muda (ou quando a URL do repositório muda), o
 * código precisa ser re-clonado do zero.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@paas/core";
import { ingestCode, projectSrcDir } from "../src/ingest.js";
import { run } from "../src/exec.js";

let tmp: string;
let repo: string;
let projectsDir: string;

/** Cria um repositório git local com as branches main e sandbox. */
async function criarRepo(dir: string): Promise<void> {
  await run("git", ["init", "-q", "-b", "main", dir]);
  await run("git", ["-C", dir, "config", "user.email", "teste@exemplo.com"]);
  await run("git", ["-C", dir, "config", "user.name", "Teste"]);
  await writeFile(path.join(dir, "arquivo.txt"), "conteudo da main\n");
  await run("git", ["-C", dir, "add", "."]);
  await run("git", ["-C", dir, "commit", "-q", "-m", "commit da main"]);
  await run("git", ["-C", dir, "checkout", "-q", "-b", "sandbox"]);
  await writeFile(path.join(dir, "arquivo.txt"), "conteudo do sandbox\n");
  await run("git", ["-C", dir, "commit", "-q", "-am", "commit do sandbox"]);
  await run("git", ["-C", dir, "checkout", "-q", "main"]);
}

function projeto(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "App",
    slug: "app",
    ingestMode: "git",
    source: repo,
    branch: "main",
    domain: "app.localhost",
    websocket: false,
    detection: null,
    proxyService: null,
    proxyPort: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastDeployAt: null,
    lastDeployStatus: null,
    ...overrides,
  } as Project;
}

/** Branch efetivamente marcada no clone em disco. */
async function branchNoDisco(src: string): Promise<string> {
  const r = await run("git", ["-C", src, "rev-parse", "--abbrev-ref", "HEAD"]);
  return r.stdout.trim();
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "paas-ingest-test-"));
  repo = path.join(tmp, "repo");
  projectsDir = path.join(tmp, "projects");
  await criarRepo(repo);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("ingestCode — modo git", () => {
  it("clona a branch configurada na primeira ingestão", async () => {
    const p = projeto({ branch: "main" });
    const src = await ingestCode({ projectsDir }, p, () => {});
    expect(await branchNoDisco(src)).toBe("main");
  });

  it("clona a branch sandbox quando é a configurada", async () => {
    const p = projeto({ branch: "sandbox" });
    const src = await ingestCode({ projectsDir }, p, () => {});
    expect(await branchNoDisco(src)).toBe("sandbox");
  });

  it("troca de branch em projeto já clonado, re-clonando o repositório", async () => {
    // Primeiro deploy na main…
    await ingestCode({ projectsDir }, projeto({ branch: "main" }), () => {});
    // …e depois a branch é corrigida para sandbox na tela de configuração.
    const src = await ingestCode({ projectsDir }, projeto({ branch: "sandbox" }), () => {});
    expect(await branchNoDisco(src)).toBe("sandbox");
  });

  it("troca de repositório em projeto já clonado", async () => {
    await ingestCode({ projectsDir }, projeto({ branch: "main" }), () => {});
    const outroRepo = path.join(tmp, "outro-repo");
    await criarRepo(outroRepo);
    const src = await ingestCode({ projectsDir }, projeto({ source: outroRepo }), () => {});
    const origem = await run("git", ["-C", src, "remote", "get-url", "origin"]);
    expect(origem.stdout.trim()).toBe(outroRepo);
  });

  it("reaproveita o clone quando nada mudou (não re-clona à toa)", async () => {
    const p = projeto({ branch: "main" });
    const src = await ingestCode({ projectsDir }, p, () => {});
    // marca o diretório para detectar se foi apagado e recriado
    await writeFile(path.join(src, "marcador-local.txt"), "presente\n");
    const logs: string[] = [];
    await ingestCode({ projectsDir }, p, (c) => logs.push(c));
    expect(logs.join("")).toMatch(/atualizando clone existente/i);
  });
});
