/**
 * Ingestão git sobre um clone que o PRÓPRIO PROJETO consegue gravar (achado A2
 * da auditoria): o `src` é montado com escrita nos containers do projeto
 * (`./:/app`, build estático), então um app invadido pode plantar hooks e
 * `core.fsmonitor` no `.git` e esperar o próximo deploy rodar o git dentro do
 * container do painel (com o docker.sock ao alcance).
 *
 * O painel não pode confiar em nada que esteja dentro de `src`: o repositório
 * git do painel fica FORA dele (`<pasta do projeto>/repo.git`) e todo comando
 * roda com hooks e fsmonitor desligados.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@paas/core";
import { ingestCode, projectGitDir, projectSrcDir, projectWorkDir } from "../src/ingest.js";

let tmp: string;
let repo: string;
let projectsDir: string;
let sentinela: string;

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

async function criarRepo(dir: string): Promise<void> {
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  git(dir, "config", "user.email", "teste@exemplo.com");
  git(dir, "config", "user.name", "Teste");
  await writeFile(path.join(dir, "app.txt"), "v1\n");
  await writeFile(path.join(dir, "velho.txt"), "so na v1\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "v1");
}

async function novoCommit(arquivo: string, conteudo: string): Promise<void> {
  await writeFile(path.join(repo, arquivo), conteudo);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", `muda ${arquivo}`);
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

/**
 * O que um app invadido faz com a escrita em `src`: troca o `.git` por um
 * clone SEU, com hooks e fsmonitor que gravam a sentinela (prova de execução).
 */
async function plantarClonePerigoso(src: string): Promise<void> {
  const isca = path.join(tmp, "isca");
  execFileSync("git", ["clone", "-q", repo, isca]);
  await rm(path.join(src, ".git"), { recursive: true, force: true });
  await rename(path.join(isca, ".git"), path.join(src, ".git"));
  const gitDir = path.join(src, ".git");
  const script = `#!/bin/sh\necho executou >> ${sentinela}\n`;
  for (const hook of ["post-merge", "post-checkout", "post-rewrite", "pre-auto-gc", "reference-transaction"]) {
    await mkdir(path.join(gitDir, "hooks"), { recursive: true });
    await writeFile(path.join(gitDir, "hooks", hook), script, { mode: 0o755 });
  }
  const fsmonitor = path.join(tmp, "fsmonitor.sh");
  await writeFile(fsmonitor, script, { mode: 0o755 });
  execFileSync("git", ["config", "-f", path.join(gitDir, "config"), "core.fsmonitor", fsmonitor]);
  execFileSync("git", ["config", "-f", path.join(gitDir, "config"), "core.sshCommand", fsmonitor]);
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "paas-ingest-hostil-"));
  repo = path.join(tmp, "repo");
  projectsDir = path.join(tmp, "projects");
  sentinela = path.join(tmp, "SENTINELA");
  await criarRepo(repo);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("ingestCode — git sobre clone gravável pelo projeto (A2)", () => {
  it("hooks e fsmonitor plantados no .git de src NÃO rodam no deploy seguinte", async () => {
    const p = projeto();
    const src = await ingestCode({ projectsDir }, p, () => {});
    await plantarClonePerigoso(src);
    await novoCommit("app.txt", "v2\n");

    await ingestCode({ projectsDir }, p, () => {});

    expect(existsSync(sentinela)).toBe(false);
    // e o deploy continua funcionando: o código novo chegou
    expect(await readFile(path.join(src, "app.txt"), "utf8")).toBe("v2\n");
  });

  it("repo.git/config adulterado (insteadOf, uploadpack, sshCommand, gitProxy, credential.helper, include) NÃO é seguido (segunda defesa)", async () => {
    const p = projeto();
    const ctx = { projectsDir };
    await ingestCode(ctx, p, () => {});
    const config = path.join(projectGitDir(ctx, p), "config");
    const script = path.join(tmp, "executa.sh");
    await writeFile(script, `#!/bin/sh\necho executou >> ${sentinela}\nexec "$@"\n`, { mode: 0o755 });
    const iscaRepo = path.join(tmp, "repo-do-atacante");
    await criarRepo(iscaRepo);
    await writeFile(path.join(iscaRepo, "app.txt"), "DO ATACANTE\n");
    git(iscaRepo, "commit", "-qam", "isca");
    execFileSync("git", ["config", "-f", config, `url.${iscaRepo}.insteadOf`, repo]);
    execFileSync("git", ["config", "-f", config, "remote.origin.uploadpack", `${script} git-upload-pack`]);
    execFileSync("git", ["config", "-f", config, "core.sshCommand", script]);
    execFileSync("git", ["config", "-f", config, "core.gitProxy", script]);
    execFileSync("git", ["config", "-f", config, "credential.helper", `!${script}`]);
    execFileSync("git", ["config", "-f", config, "include.path", path.join(tmp, "outro-config")]);
    execFileSync("git", ["config", "-f", config, "core.alternateRefsCommand", script]);
    await novoCommit("app.txt", "v3 legitimo\n");

    const src = await ingestCode(ctx, p, () => {});

    expect(existsSync(sentinela)).toBe(false);
    expect(await readFile(path.join(src, "app.txt"), "utf8")).toBe("v3 legitimo\n");
    const texto = await readFile(config, "utf8");
    for (const proibido of ["insteadOf", "uploadpack", "sshCommand", "gitProxy", "helper", "include", "alternateRefsCommand"]) {
      expect(texto, proibido).not.toMatch(new RegExp(proibido, "i"));
    }
    // o que o painel precisa continua lá
    expect(texto).toContain(repo);
  });

  it("GIT_SAFE_CONFIG zera core.gitProxy e credential.helper na linha de comando", async () => {
    const { GIT_SAFE_CONFIG } = await import("../src/git-safe.js");
    for (const chave of ["core.gitProxy=", "credential.helper="]) {
      expect(GIT_SAFE_CONFIG).toContain(chave);
    }
  });

  it("o repositório git do painel fica fora de src e o .git de src vira só um ponteiro", async () => {
    const p = projeto();
    const ctx = { projectsDir };
    const src = await ingestCode(ctx, p, () => {});
    const gitDir = projectGitDir(ctx, p);
    expect(gitDir).toBe(path.join(projectWorkDir(ctx, p), "repo.git"));
    expect(existsSync(path.join(gitDir, "HEAD"))).toBe(true);
    const ponteiro = path.join(src, ".git");
    expect((await lstat(ponteiro)).isFile()).toBe(true);
    expect(await readFile(ponteiro, "utf8")).toBe(`gitdir: ${gitDir}\n`);
    // o operador ainda consegue usar o git dentro de src
    expect(git(src, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
  });

  it("clone antigo (pasta .git dentro de src) é migrado sem perder os arquivos não versionados", async () => {
    const p = projeto();
    const ctx = { projectsDir };
    const src = projectSrcDir(ctx, p);
    await mkdir(path.dirname(src), { recursive: true });
    execFileSync("git", ["clone", "-q", repo, src]);
    await mkdir(path.join(src, "dados"), { recursive: true });
    await writeFile(path.join(src, "dados", "banco.db"), "dados do usuario");
    await writeFile(path.join(src, ".env"), "SEGREDO=1\n");
    await novoCommit("app.txt", "v2\n");

    await ingestCode(ctx, p, () => {});

    expect((await lstat(path.join(src, ".git"))).isFile()).toBe(true);
    expect(await readFile(path.join(src, "app.txt"), "utf8")).toBe("v2\n");
    expect(await readFile(path.join(src, "dados", "banco.db"), "utf8")).toBe("dados do usuario");
    expect(await readFile(path.join(src, ".env"), "utf8")).toBe("SEGREDO=1\n");
  });

  it("clone antigo: o .git do usuário (histórico, stash, commits locais) é guardado ao lado, não apagado", async () => {
    const p = projeto();
    const ctx = { projectsDir };
    const src = projectSrcDir(ctx, p);
    await mkdir(path.dirname(src), { recursive: true });
    execFileSync("git", ["clone", "-q", repo, src]);
    git(src, "config", "user.email", "t@e.com");
    git(src, "config", "user.name", "T");
    await writeFile(path.join(src, "local.txt"), "commit so local\n");
    git(src, "add", ".");
    git(src, "commit", "-q", "-m", "commit local do usuario");

    const log: string[] = [];
    await ingestCode(ctx, p, (c) => void log.push(c));

    const guardado = (await readdir(path.dirname(src))).find((n) => n.startsWith(".git-antigo-"));
    expect(guardado).toBeDefined();
    const antigo = path.join(path.dirname(src), guardado!);
    expect(git(antigo, "log", "--format=%s", "-1").trim()).toBe("commit local do usuario");
    expect(log.join("")).toMatch(/\.git-antigo-/);
    // e o painel nunca lê o .git guardado: src/.git é só o ponteiro
    expect((await lstat(path.join(src, ".git"))).isFile()).toBe(true);
  });

  it("atualização normal preserva arquivos não versionados e remove os que saíram do repositório", async () => {
    const p = projeto();
    const src = await ingestCode({ projectsDir }, p, () => {});
    await writeFile(path.join(src, "upload.bin"), "do usuario");
    await rm(path.join(repo, "velho.txt"));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "remove velho");

    await ingestCode({ projectsDir }, p, () => {});

    expect(existsSync(path.join(src, "velho.txt"))).toBe(false);
    expect(await readFile(path.join(src, "upload.bin"), "utf8")).toBe("do usuario");
  });

  it("troca de branch: o código passa a ser o da nova branch e o que não é versionado fica", async () => {
    git(repo, "checkout", "-q", "-b", "sandbox");
    await novoCommit("app.txt", "sandbox\n");
    git(repo, "checkout", "-q", "main");
    const ctx = { projectsDir };
    const src = await ingestCode(ctx, projeto(), () => {});
    await writeFile(path.join(src, "dados.txt"), "meu");

    await ingestCode(ctx, projeto({ branch: "sandbox" }), () => {});

    expect(await readFile(path.join(src, "app.txt"), "utf8")).toBe("sandbox\n");
    expect(await readFile(path.join(src, "dados.txt"), "utf8")).toBe("meu");
    expect(git(src, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("sandbox");
  });

  it("troca de repositório: traz o código do novo, mesmo sem história em comum", async () => {
    const ctx = { projectsDir };
    const src = await ingestCode(ctx, projeto(), () => {});
    const outro = path.join(tmp, "outro");
    await criarRepo(outro);
    await writeFile(path.join(outro, "app.txt"), "do outro repo\n");
    execFileSync("git", ["-C", outro, "commit", "-q", "-am", "outro"]);

    await ingestCode(ctx, projeto({ source: outro }), () => {});

    expect(await readFile(path.join(src, "app.txt"), "utf8")).toBe("do outro repo\n");
  });

  it("alteração local num arquivo versionado que conflita com o repositório continua barrando o deploy", async () => {
    const p = projeto();
    const src = await ingestCode({ projectsDir }, p, () => {});
    await writeFile(path.join(src, "app.txt"), "editado na VPS\n");
    await novoCommit("app.txt", "v2\n");

    await expect(ingestCode({ projectsDir }, p, () => {})).rejects.toThrow(/git/);
    expect(await readFile(path.join(src, "app.txt"), "utf8")).toBe("editado na VPS\n");
  });

  it(".git de src trocado por link simbólico é substituído sem seguir o link", async () => {
    const p = projeto();
    const src = await ingestCode({ projectsDir }, p, () => {});
    const alvo = path.join(tmp, "alvo-do-link");
    await mkdir(alvo);
    await writeFile(path.join(alvo, "config"), "nao mexa");
    await rm(path.join(src, ".git"), { recursive: true, force: true });
    await symlink(alvo, path.join(src, ".git"));
    await novoCommit("app.txt", "v2\n");

    await ingestCode({ projectsDir }, p, () => {});

    expect(await readFile(path.join(alvo, "config"), "utf8")).toBe("nao mexa");
    expect((await lstat(path.join(src, ".git"))).isFile()).toBe(true);
    expect((await readlink(path.join(src, "app.txt")).catch(() => null))).toBeNull();
    expect((await stat(alvo)).isDirectory()).toBe(true);
  });

  it("repositório inexistente: erro claro, sem apagar o código que já estava em src", async () => {
    const p = projeto();
    const src = await ingestCode({ projectsDir }, p, () => {});
    await cp(repo, path.join(tmp, "repo-bak"), { recursive: true });
    await rm(repo, { recursive: true, force: true });

    await expect(ingestCode({ projectsDir }, p, () => {})).rejects.toThrow(/git fetch falhou/);
    expect(await readFile(path.join(src, "app.txt"), "utf8")).toBe("v1\n");
  });

  it("endereço de repositório que começa com '-' é recusado antes de qualquer comando", async () => {
    await expect(ingestCode({ projectsDir }, projeto({ source: "-oProxyCommand=touch /tmp/x" }), () => {})).rejects.toThrow(
      /não pode começar com/,
    );
    expect(existsSync(projectGitDir({ projectsDir }, projeto()))).toBe(false);
  });
});
