/**
 * Lote 6 / A5 — a pasta de trabalho de um projeto nunca coincide com pasta do usuário.
 *
 * Antes: o painel guardava tudo em `<pasta de projetos>/<slug>`. Se o usuário
 * tinha uma pasta com esse nome (a fonte de outro projeto "existing", por
 * exemplo), o painel gravava dentro dela e, ao remover o projeto com "apagar
 * código-fonte", dava `rm -rf` nela — apagando a pasta do OUTRO projeto.
 *
 * Agora: projetos novos vivem em `<pasta de projetos>/.paas/<id>` (nome que
 * nunca é de usuário: o id é gerado), a criação recusa slug que já é pasta, e
 * antes de qualquer remoção o alvo é conferido contra a fonte do projeto e a
 * dos outros. Projetos antigos (sem `storageLayout`) seguem no caminho antigo,
 * com a mesma conferência.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { DeployService } from "../src/services/deploy-service.js";

let dataDir: string;
let projectsDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-reservada-data-"));
  projectsDir = await mkdtemp(path.join(tmpdir(), "paas-reservada-host-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(projectsDir, { recursive: true, force: true });
});

function novoServico(): DeployService {
  const svc = new DeployService({ dataDir, projectsDir, caddyHttpPort: 80, caddyHttpsPort: 443 } as unknown as ServerConfig);
  const engine = (svc as unknown as { engine: { remove: unknown; syncCaddy: unknown } }).engine;
  engine.remove = vi.fn(async () => undefined);
  engine.syncCaddy = vi.fn(async () => undefined);
  return svc;
}

const git = (name: string) => ({ name, ingestMode: "git" as const, source: "https://github.com/k/r.git", branch: "main", domain: `${name.toLowerCase()}.localhost` });

describe("A5 — área reservada para o que o painel gera", () => {
  it("projeto novo vive em <projetos>/.paas/<id>, nunca em <projetos>/<slug>", async () => {
    const svc = novoServico();
    await mkdir(path.join(projectsDir, "app", "src"), { recursive: true });
    const p = await svc.createProject({ ...git("Outro"), name: "Outro" });
    expect(p.storageLayout).toBe("reserved");
    expect(svc.backupSourceDir(p)).toBe(path.join(projectsDir, ".paas", p.id, "src"));
  });

  it("slug que já existe como pasta é RECUSADO na criação (409), e a pasta do usuário não é tocada", async () => {
    const svc = novoServico();
    await mkdir(path.join(projectsDir, "app"));
    await writeFile(path.join(projectsDir, "app", "meu-arquivo.txt"), "do usuario");
    await expect(svc.createProject(git("App"))).rejects.toMatchObject({ statusCode: 409, code: "slug_folder_exists" });
    expect(await readFile(path.join(projectsDir, "app", "meu-arquivo.txt"), "utf8")).toBe("do usuario");
  });

  it("projeto de pasta existente cujo nome é o da própria pasta continua podendo ser criado", async () => {
    const svc = novoServico();
    await mkdir(path.join(projectsDir, "app"));
    const p = await svc.createProject({ name: "App", ingestMode: "existing", source: path.join(projectsDir, "app"), domain: "app.localhost" });
    expect(p.slug).toBe("app");
    expect(svc.backupSourceDir(p)).toBe(path.join(projectsDir, "app"));
  });

  it("fonte dentro da área reservada, ou a própria pasta de projetos, é recusada", async () => {
    const svc = novoServico();
    await mkdir(path.join(projectsDir, ".paas", "abc", "src"), { recursive: true });
    for (const source of [path.join(projectsDir, ".paas", "abc", "src"), path.join(projectsDir, ".paas"), projectsDir]) {
      await expect(svc.createProject({ name: "X", ingestMode: "existing", source, domain: "x.localhost" })).rejects.toMatchObject({
        statusCode: 400,
        code: "source_reserved",
      });
    }
  });

  it("remover com 'apagar código-fonte' apaga só a área do projeto; a pasta do usuário com o mesmo nome do slug fica", async () => {
    const svc = novoServico();
    const p = await svc.createProject(git("Loja"));
    const area = path.join(projectsDir, ".paas", p.id);
    await mkdir(path.join(area, "src"), { recursive: true });
    await writeFile(path.join(area, "src", "app.js"), "x");
    // depois da criação, o usuário passa a ter uma pasta com o nome do slug
    await mkdir(path.join(projectsDir, "loja"));
    await writeFile(path.join(projectsDir, "loja", "dados.txt"), "do usuario");
    const log: string[] = [];
    await svc.deleteProject(p.id, true, (c) => void log.push(c));
    expect(existsSync(area)).toBe(false);
    expect(await readFile(path.join(projectsDir, "loja", "dados.txt"), "utf8")).toBe("do usuario");
    expect(log.join("")).toMatch(/Código-fonte removido/);
  });
});

describe("A5 — projetos antigos (<projetos>/<slug>) e a conferência antes de remover", () => {
  async function comProjetosAntigos(projetos: Array<Record<string, unknown>>): Promise<DeployService> {
    const base = {
      websocket: false,
      detection: null,
      proxyService: null,
      proxyPort: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastDeployAt: null,
      lastDeployStatus: null,
      deployedBranch: null,
      deployedSource: null,
    };
    await writeFile(path.join(dataDir, "projects.json"), JSON.stringify({ projects: projetos.map((p) => ({ ...base, ...p })) }));
    return novoServico();
  }

  it("slug de um projeto antigo coincide com a pasta-fonte de OUTRO projeto: remover não apaga a pasta do outro", async () => {
    const fonteDoOutro = path.join(projectsDir, "app");
    await mkdir(fonteDoOutro);
    await writeFile(path.join(fonteDoOutro, "codigo.js"), "importante");
    const svc = await comProjetosAntigos([
      { id: "a", name: "Outro", slug: "outro", ingestMode: "existing", source: fonteDoOutro, domain: "outro.localhost" },
      { id: "b", name: "App", slug: "app", ingestMode: "git", source: "https://github.com/k/r.git", branch: "main", domain: "app.localhost" },
    ]);
    const log: string[] = [];
    await svc.deleteProject("b", true, (c) => void log.push(c));
    expect(await readFile(path.join(fonteDoOutro, "codigo.js"), "utf8")).toBe("importante");
    expect(log.join("")).toMatch(/ficaram na pasta.*codigo\.js/s);
    expect((await svc.listProjects()).map((p) => p.id)).toEqual(["a"]);
  });

  it("projeto antigo de upload cuja fonte é a própria pasta de trabalho: nada é apagado", async () => {
    const pasta = path.join(projectsDir, "site");
    await mkdir(path.join(pasta, "src"), { recursive: true });
    await writeFile(path.join(pasta, "index.html"), "original do usuario");
    const svc = await comProjetosAntigos([
      { id: "u", name: "Site", slug: "site", ingestMode: "upload", source: pasta, domain: "site.localhost" },
    ]);
    const log: string[] = [];
    await svc.deleteProject("u", true, (c) => void log.push(c));
    expect(await readFile(path.join(pasta, "index.html"), "utf8")).toBe("original do usuario");
    expect(log.join("")).toMatch(/NÃO removido: src/);
  });

  it("projeto antigo sem nenhuma coincidência: continua removendo a pasta do slug como sempre (compatibilidade)", async () => {
    const pasta = path.join(projectsDir, "velho");
    await mkdir(path.join(pasta, "src"), { recursive: true });
    await writeFile(path.join(pasta, "src", "app.js"), "x");
    const svc = await comProjetosAntigos([
      { id: "v", name: "Velho", slug: "velho", ingestMode: "git", source: "https://github.com/k/r.git", branch: "main", domain: "velho.localhost" },
    ]);
    expect(svc.backupSourceDir((await svc.getProject("v"))!)).toBe(path.join(pasta, "src"));
    const log: string[] = [];
    await svc.deleteProject("v", true, (c) => void log.push(c));
    expect(existsSync(pasta)).toBe(false);
    expect(log.join("")).toMatch(/Código-fonte removido/);
  });

  // Revisão do lote 6: pasta COMUM do usuário (não cadastrada em nenhum projeto) com o nome do slug.
  it("cenário 'blog': projeto git antigo + arquivos do usuário na mesma pasta — remover apaga SÓ o que o painel criou", async () => {
    const pasta = path.join(projectsDir, "blog");
    await mkdir(path.join(pasta, "src"), { recursive: true });
    await mkdir(path.join(pasta, "repo.git"), { recursive: true });
    await writeFile(path.join(pasta, "src", "app.js"), "clone");
    await writeFile(path.join(pasta, "paas.env"), "SEGREDO='1'\n");
    await writeFile(path.join(pasta, "paas.up.env"), "SEGREDO='1'\n");
    await writeFile(path.join(pasta, "notas-do-usuario.txt"), "minhas notas");
    await writeFile(path.join(pasta, "backup.sql"), "dump do usuario");
    const svc = await comProjetosAntigos([
      { id: "bl", name: "Blog", slug: "blog", ingestMode: "git", source: "https://github.com/k/r.git", branch: "main", domain: "blog.localhost" },
    ]);
    const log: string[] = [];
    await svc.deleteProject("bl", true, (c) => void log.push(c));
    expect(await readFile(path.join(pasta, "notas-do-usuario.txt"), "utf8")).toBe("minhas notas");
    expect(await readFile(path.join(pasta, "backup.sql"), "utf8")).toBe("dump do usuario");
    for (const gerado of ["src", "repo.git", "paas.env", "paas.up.env"]) expect(existsSync(path.join(pasta, gerado))).toBe(false);
    const texto = log.join("");
    expect(texto).toMatch(/ficaram na pasta.*notas-do-usuario\.txt/s);
    expect(texto).not.toMatch(/Código-fonte removido\./);
  });

  it("remover sem apagar o código tira só os paas.* (segredos) da pasta antiga; src e arquivos do usuário ficam", async () => {
    const pasta = path.join(projectsDir, "blog");
    await mkdir(path.join(pasta, "src"), { recursive: true });
    await writeFile(path.join(pasta, "paas.env"), "SEGREDO='1'\n");
    await writeFile(path.join(pasta, "notas.txt"), "n");
    const svc = await comProjetosAntigos([
      { id: "bl", name: "Blog", slug: "blog", ingestMode: "git", source: "https://github.com/k/r.git", branch: "main", domain: "blog.localhost" },
    ]);
    await svc.deleteProject("bl", false, () => undefined);
    expect(existsSync(path.join(pasta, "paas.env"))).toBe(false);
    expect(existsSync(path.join(pasta, "src"))).toBe(true);
    expect(existsSync(path.join(pasta, "notas.txt"))).toBe(true);
  });

  it("projeto novo de pasta existente: remover (mesmo sem apagar o código) limpa .paas/<id> com os segredos", async () => {
    const svc = novoServico();
    const fonte = path.join(projectsDir, "meu-app");
    await mkdir(fonte);
    const p = await svc.createProject({ name: "Meu App", ingestMode: "existing", source: fonte, domain: "meu.localhost" });
    const area = path.join(projectsDir, ".paas", p.id);
    await mkdir(area, { recursive: true });
    await writeFile(path.join(area, "paas.env"), "SEGREDO='1'\n");
    await writeFile(path.join(area, "paas.up.env"), "SEGREDO='1'\n");
    await svc.deleteProject(p.id, false, () => undefined);
    expect(existsSync(area)).toBe(false);
    expect(existsSync(fonte)).toBe(true);
  });

  it("cenário 'meusite': projeto 'existing' antigo migra sozinho para .paas/<id> no próximo deploy, sem apagar nada do usuário", async () => {
    const pasta = path.join(projectsDir, "meusite");
    await mkdir(path.join(pasta, "site"), { recursive: true });
    await writeFile(path.join(pasta, "index.html"), "<h1>meu site</h1>");
    await writeFile(path.join(pasta, "site", "pagina-do-usuario.html"), "pagina do usuario");
    await writeFile(path.join(pasta, "paas.env"), "SEGREDO='1'\n");
    await writeFile(path.join(pasta, "paas.up.env"), "SEGREDO='1'\n");
    await writeFile(path.join(pasta, "paas.canonical.json"), "{}");
    const svc = await comProjetosAntigos([
      {
        id: "ms", name: "meusite", slug: "meusite", ingestMode: "existing", source: pasta, branch: null, domain: "meusite.localhost",
        detection: { type: "static", warnings: [], details: [] },
      },
    ]);
    const engine = (svc as unknown as { engine: { deploy: unknown } }).engine;
    engine.deploy = vi.fn(async () => undefined);
    (svc as unknown as { applyProxy: () => Promise<void> }).applyProxy = async () => undefined;
    const job = await svc.startDeploy("ms");
    await vi.waitFor(async () => expect((await svc.getJob("ms", job.id))?.status).toBe("success"));
    const projeto = (await svc.getProject("ms"))!;
    expect(projeto.storageLayout).toBe("reserved");
    expect(svc.backupSourceDir(projeto)).toBe(pasta);
    expect(existsSync(path.join(projectsDir, ".paas", "ms"))).toBe(true);
    expect(await readFile(path.join(pasta, "site", "pagina-do-usuario.html"), "utf8")).toBe("pagina do usuario");
    expect(await readFile(path.join(pasta, "index.html"), "utf8")).toBe("<h1>meu site</h1>");
    for (const gerado of ["paas.env", "paas.up.env", "paas.canonical.json"]) expect(existsSync(path.join(pasta, gerado))).toBe(false);
    expect((await svc.getJob("ms", job.id))!.log).toMatch(/migrado para a área do painel/);
    // gravado no disco: o próximo boot já lê o novo layout
    expect(JSON.parse(await readFile(path.join(dataDir, "projects.json"), "utf8")).projects[0].storageLayout).toBe("reserved");
    // idempotente: um segundo deploy não migra de novo
    const job2 = await svc.startDeploy("ms");
    await vi.waitFor(async () => expect((await svc.getJob("ms", job2.id))?.status).toBe("success"));
    expect((await svc.getJob("ms", job2.id))!.log).not.toMatch(/migrado/);
    await new Promise((r) => setTimeout(r, 100)); // deixa o job terminar de gravar antes de apagar o diretório do teste
  });
});
