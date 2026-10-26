/**
 * build-context.ts — .dockerignore mesclado só durante o build, e quais serviços do compose constroem
 * a partir de um Dockerfile.
 */
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IGNORE_JOURNAL, ownDotenvInContext, restoreIgnoreJournal } from "../src/build-context.js";
import {
  PANEL_IGNORE_BLOCK,
  composeBuildTargets,
  excludePanelDotenv,
  hasPanelDotenv,
  mergeDockerignore,
  stripPanelBlock,
} from "../src/build-context.js";
import { GENERATED_HEADER } from "../src/project-dotenv.js";

let top: string;
let dir: string;
/** Pasta de trabalho do painel (diário), fora do código. */
let work: string;
beforeEach(async () => {
  top = await mkdtemp(path.join(tmpdir(), "paas-build-context-"));
  dir = path.join(top, "src");
  work = path.join(top, "work");
  await mkdir(dir);
  await mkdir(work);
});
afterEach(async () => {
  await chmod(dir, 0o755).catch(() => undefined);
  await chmod(work, 0o755).catch(() => undefined);
  await rm(top, { recursive: true, force: true });
});

describe("mergeDockerignore / stripPanelBlock", () => {
  it("as linhas do painel vão por último, mesmo sem quebra de linha no fim do arquivo do usuário", () => {
    expect(mergeDockerignore("node_modules")).toBe(`node_modules\n${PANEL_IGNORE_BLOCK}`);
    expect(mergeDockerignore("a\n")).toBe(`a\n${PANEL_IGNORE_BLOCK}`);
    expect(mergeDockerignore("")).toBe(PANEL_IGNORE_BLOCK);
    expect(PANEL_IGNORE_BLOCK).toMatch(/^\.env$/m);
  });

  it("mesclar duas vezes dá o mesmo resultado (um bloco só)", () => {
    const uma = mergeDockerignore("a\n");
    expect(mergeDockerignore(uma)).toBe(uma);
  });

  it("stripPanelBlock tira o bloco do meio, preserva o que vem depois e tolera bloco sem fim", () => {
    expect(stripPanelBlock(`a\n${PANEL_IGNORE_BLOCK}b\n`)).toBe("a\nb\n");
    expect(stripPanelBlock("a\n# >>> TWS Panel (temporário, só durante o build)\n.env\n")).toBe("a\n");
    expect(stripPanelBlock("sem bloco\n")).toBe("sem bloco\n");
  });
});

describe("hasPanelDotenv", () => {
  it("só o .env com o cabeçalho do painel conta", async () => {
    expect(await hasPanelDotenv(dir)).toBe(false);
    await writeFile(path.join(dir, ".env"), "A=1\n");
    expect(await hasPanelDotenv(dir)).toBe(false);
    await writeFile(path.join(dir, ".env"), `${GENERATED_HEADER}\nA='1'\n`);
    expect(await hasPanelDotenv(dir)).toBe(true);
  });
});

describe("excludePanelDotenv", () => {
  it("cria o arquivo ao lado do Dockerfile e o remove ao restaurar (não existia)", async () => {
    const dockerfile = path.join(dir, "Dockerfile");
    const restore = await excludePanelDotenv(dir, dockerfile, work);
    expect(await readFile(`${dockerfile}.dockerignore`, "utf8")).toBe(PANEL_IGNORE_BLOCK);
    await restore();
    expect(existsSync(`${dockerfile}.dockerignore`)).toBe(false);
  });

  it("parte do .dockerignore da raiz do contexto quando não há o específico", async () => {
    await writeFile(path.join(dir, ".dockerignore"), "dist\n");
    const dockerfile = path.join(dir, "Dockerfile");
    const restore = await excludePanelDotenv(dir, dockerfile, work);
    expect(await readFile(`${dockerfile}.dockerignore`, "utf8")).toBe(`dist\n${PANEL_IGNORE_BLOCK}`);
    await restore();
    expect(await readFile(path.join(dir, ".dockerignore"), "utf8")).toBe("dist\n");
  });

  it("<Dockerfile>.dockerignore que é pasta: recusa com mensagem clara, sem gravar nada", async () => {
    await mkdir(path.join(dir, "Dockerfile.dockerignore"));
    await expect(excludePanelDotenv(dir, path.join(dir, "Dockerfile"), work)).rejects.toThrow(/não é um arquivo comum/);
  });
});

describe("diário: build interrompido (M1)", () => {
  const dockerfile = () => path.join(dir, "Dockerfile");
  const ignoreFile = () => `${dockerfile()}.dockerignore`;

  it("o diário é gravado ANTES de tocar no arquivo, fora do código, e some depois de restaurar", async () => {
    const restore = await excludePanelDotenv(dir, dockerfile(), work);
    const journal = JSON.parse(await readFile(path.join(work, IGNORE_JOURNAL), "utf8"));
    expect(journal.entries[0].file).toBe(ignoreFile());
    expect(existsSync(path.join(dir, IGNORE_JOURNAL))).toBe(false);
    await restore();
    expect(existsSync(path.join(work, IGNORE_JOURNAL))).toBe(false);
  });

  it("queda no meio, antes não havia o arquivo: o diário o apaga (não vira arquivo do usuário)", async () => {
    await writeFile(path.join(dir, ".dockerignore"), "node_modules\n");
    await excludePanelDotenv(dir, dockerfile(), work); // painel caiu: restore nunca roda
    expect(existsSync(ignoreFile())).toBe(true);
    expect(await restoreIgnoreJournal(work)).toEqual([]);
    expect(existsSync(ignoreFile())).toBe(false);
    expect(existsSync(path.join(work, IGNORE_JOURNAL))).toBe(false);
    // o do usuário segue mandando: mudar o .dockerignore depois vale no build seguinte
    expect(await readFile(path.join(dir, ".dockerignore"), "utf8")).toBe("node_modules\n");
  });

  it("queda no meio, antes havia um <Dockerfile>.dockerignore: o conteúdo dele volta, sem o bloco", async () => {
    await writeFile(ignoreFile(), "*.log\n");
    await excludePanelDotenv(dir, dockerfile(), work);
    await restoreIgnoreJournal(work);
    expect(await readFile(ignoreFile(), "utf8")).toBe("*.log\n");
  });

  it("queda no meio, antes era um link: o link volta", async () => {
    await writeFile(path.join(dir, "real.ignore"), "*.pem\n");
    await symlink("real.ignore", ignoreFile());
    await excludePanelDotenv(dir, dockerfile(), work);
    await restoreIgnoreJournal(work);
    expect((await lstat(ignoreFile())).isSymbolicLink()).toBe(true);
    expect(await readlink(ignoreFile())).toBe("real.ignore");
    expect(await readFile(path.join(dir, "real.ignore"), "utf8")).toBe("*.pem\n");
  });

  it("se a pessoa mexeu no arquivo depois da queda (sem o bloco), o diário não o toca", async () => {
    await excludePanelDotenv(dir, dockerfile(), work);
    await writeFile(ignoreFile(), "meu\n");
    await restoreIgnoreJournal(work);
    expect(await readFile(ignoreFile(), "utf8")).toBe("meu\n");
  });

  it("sem diário, nada a fazer; diário ilegível é descartado; entrada fora da pasta ou de outro nome é ignorada", async () => {
    expect(await restoreIgnoreJournal(work)).toEqual([]);
    await writeFile(path.join(work, IGNORE_JOURNAL), "isto não é json");
    expect(await restoreIgnoreJournal(work)).toEqual([]);
    expect(existsSync(path.join(work, IGNORE_JOURNAL))).toBe(false);
    const fora = path.join(top, "fora.dockerignore");
    await writeFile(fora, `${PANEL_IGNORE_BLOCK}`);
    const nome = path.join(dir, "outro.txt");
    await writeFile(nome, `${PANEL_IGNORE_BLOCK}`);
    await writeFile(
      path.join(work, IGNORE_JOURNAL),
      JSON.stringify({ root: dir, entries: [{ file: fora, before: { kind: "absent" } }, { file: nome, before: { kind: "absent" } }] }),
    );
    await restoreIgnoreJournal(work);
    expect(existsSync(fora)).toBe(true);
    expect(existsSync(nome)).toBe(true);
  });

  it("restauração que falha fica no diário e é devolvida (para a próxima tentativa)", async () => {
    if (process.getuid?.() === 0) return; // root ignora permissão de pasta
    await excludePanelDotenv(dir, dockerfile(), work);
    await chmod(dir, 0o555);
    const falhas = await restoreIgnoreJournal(work);
    expect(falhas).toHaveLength(1);
    expect(falhas[0]).toMatch(/^Dockerfile\.dockerignore:/);
    expect(existsSync(path.join(work, IGNORE_JOURNAL))).toBe(true);
    await chmod(dir, 0o755);
    expect(await restoreIgnoreJournal(work)).toEqual([]);
    expect(existsSync(ignoreFile())).toBe(false);
  });

  it("diário que não consegue ser regravado vira mensagem, não exceção", async () => {
    if (process.getuid?.() === 0) return;
    await excludePanelDotenv(dir, dockerfile(), work);
    await chmod(work, 0o555);
    const falhas = await restoreIgnoreJournal(work);
    await chmod(work, 0o755);
    expect(falhas.some((m) => m.startsWith("diário:"))).toBe(true);
  });
});

describe("rodada 2: mesmo Dockerfile duas vezes, link no caminho, sobra sem diário, linhas da pessoa", () => {
  const dockerfile = () => path.join(dir, "Dockerfile");
  const ignoreFile = () => `${dockerfile()}.dockerignore`;

  it("dois serviços com o mesmo Dockerfile: o arquivo temporário não fica na pasta (fim normal)", async () => {
    await writeFile(path.join(dir, ".dockerignore"), "node_modules\n");
    const semNota = () => undefined;
    const primeira = await excludePanelDotenv(dir, dockerfile(), work, semNota, "build-1");
    const segunda = await excludePanelDotenv(dir, dockerfile(), work, semNota, "build-1");
    await segunda();
    await primeira();
    expect(existsSync(ignoreFile())).toBe(false);
    expect(existsSync(path.join(work, IGNORE_JOURNAL))).toBe(false);
  });

  it("dois serviços com o mesmo Dockerfile, queda e recuperação: nada sobra", async () => {
    await writeFile(path.join(dir, ".dockerignore"), "node_modules\n");
    await excludePanelDotenv(dir, dockerfile(), work, undefined, "build-1");
    await excludePanelDotenv(dir, dockerfile(), work, undefined, "build-1");
    await restoreIgnoreJournal(work);
    expect(existsSync(ignoreFile())).toBe(false);
  });

  it("sobra sem diário que é só uma cópia do .dockerignore da raiz: vira 'não existia' e some (mudanças na raiz voltam a valer)", async () => {
    await writeFile(path.join(dir, ".dockerignore"), "node_modules\n");
    await writeFile(ignoreFile(), `node_modules\n${PANEL_IGNORE_BLOCK}`);
    const restore = await excludePanelDotenv(dir, dockerfile(), work);
    await restore();
    expect(existsSync(ignoreFile())).toBe(false);
    expect(await readFile(path.join(dir, ".dockerignore"), "utf8")).toBe("node_modules\n");
  });

  it("entrada de um build anterior que não foi restaurada: tenta restaurar e segue; se não der, RECUSA (nunca segue com o .env no contexto)", async () => {
    await excludePanelDotenv(dir, dockerfile(), work, undefined, "build-antigo"); // a restauração dele nunca rodou
    const restore = await excludePanelDotenv(dir, dockerfile(), work, undefined, "build-novo");
    expect(await readFile(ignoreFile(), "utf8")).toBe(PANEL_IGNORE_BLOCK);
    await restore();
    expect(existsSync(ignoreFile())).toBe(false);
    if (process.getuid?.() === 0) return; // root ignora permissão de pasta
    await excludePanelDotenv(dir, dockerfile(), work, undefined, "build-antigo");
    await chmod(dir, 0o555);
    await expect(excludePanelDotenv(dir, dockerfile(), work, undefined, "build-novo")).rejects.toThrow(/não conseguiu restaurá-lo.*recusado/);
    await chmod(dir, 0o755);
    expect(existsSync(path.join(work, IGNORE_JOURNAL))).toBe(true);
  });

  it("pasta de projetos atrás de um link simbólico: a restauração acontece (fim normal e pelo diário)", async () => {
    await mkdir(path.join(top, "real", "src"), { recursive: true });
    await symlink("real", path.join(top, "lnk"));
    const viaLink = path.join(top, "lnk", "src");
    await writeFile(path.join(viaLink, ".dockerignore"), "secrets/\n");
    const restore = await excludePanelDotenv(viaLink, path.join(viaLink, "Dockerfile"), work);
    const journal = JSON.parse(await readFile(path.join(work, IGNORE_JOURNAL), "utf8"));
    expect(journal.entries[0].file).toBe(path.join(await realpath(top), "real", "src", "Dockerfile.dockerignore"));
    await restore();
    expect(existsSync(path.join(viaLink, "Dockerfile.dockerignore"))).toBe(false);
    await excludePanelDotenv(viaLink, path.join(viaLink, "Dockerfile"), work);
    await restoreIgnoreJournal(work);
    expect(existsSync(path.join(viaLink, "Dockerfile.dockerignore"))).toBe(false);
    expect(await readFile(path.join(viaLink, ".dockerignore"), "utf8")).toBe("secrets/\n");
  });

  it("diário com o caminho pelo link (formato antigo) também restaura: a comparação é pelo caminho real", async () => {
    await mkdir(path.join(top, "real", "src"), { recursive: true });
    await symlink("real", path.join(top, "lnk"));
    const viaLink = path.join(top, "lnk", "src", "Dockerfile.dockerignore");
    await writeFile(viaLink, PANEL_IGNORE_BLOCK);
    await writeFile(
      path.join(work, IGNORE_JOURNAL),
      JSON.stringify({ root: await realpath(path.join(top, "real", "src")), entries: [{ file: viaLink, before: { kind: "absent" } }] }),
    );
    await restoreIgnoreJournal(work);
    expect(existsSync(viaLink)).toBe(false);
  });

  it("sobra do painel sem diário: só o bloco sai, as linhas da pessoa ficam, e o aviso é dado", async () => {
    await writeFile(ignoreFile(), `*.log\n${PANEL_IGNORE_BLOCK}`);
    const notas: string[] = [];
    const restore = await excludePanelDotenv(dir, dockerfile(), work, (m) => notas.push(m));
    expect(notas[0]).toMatch(/sem diário/);
    expect(await readFile(ignoreFile(), "utf8")).toBe(`*.log\n${PANEL_IGNORE_BLOCK}`);
    await restore();
    expect(await readFile(ignoreFile(), "utf8")).toBe("*.log\n");
  });

  it("sobra do painel sem diário e sem nada além do bloco: vira 'não existia' (nunca um arquivo vazio) e some", async () => {
    await writeFile(path.join(dir, ".dockerignore"), "dist\n");
    await writeFile(ignoreFile(), PANEL_IGNORE_BLOCK);
    const restore = await excludePanelDotenv(dir, dockerfile(), work);
    // a base é o .dockerignore da raiz, como se o arquivo não existisse
    expect(await readFile(ignoreFile(), "utf8")).toBe(`dist\n${PANEL_IGNORE_BLOCK}`);
    await restore();
    expect(existsSync(ignoreFile())).toBe(false);
  });

  it("a pessoa acrescentou uma linha ao arquivo temporário e manteve o bloco: só o bloco sai, a linha fica", async () => {
    const restore = await excludePanelDotenv(dir, dockerfile(), work);
    await writeFile(ignoreFile(), `minha-linha\n${await readFile(ignoreFile(), "utf8")}`);
    await restore();
    expect(await readFile(ignoreFile(), "utf8")).toBe("minha-linha\n");
  });

  it("editado e sem sobrar nada além do bloco (antes não havia o arquivo): o arquivo some", async () => {
    await excludePanelDotenv(dir, dockerfile(), work);
    await writeFile(ignoreFile(), `${PANEL_IGNORE_BLOCK}\n`);
    await restoreIgnoreJournal(work);
    expect(existsSync(ignoreFile())).toBe(false);
  });

  it("editado, antes havia um arquivo: ficam as linhas antigas e as novas, sem o bloco", async () => {
    await writeFile(ignoreFile(), "*.log\n");
    await excludePanelDotenv(dir, dockerfile(), work);
    await writeFile(ignoreFile(), `*.log\nextra\n${PANEL_IGNORE_BLOCK}`);
    await restoreIgnoreJournal(work);
    expect(await readFile(ignoreFile(), "utf8")).toBe("*.log\nextra\n");
  });
});

describe("leitura do .dockerignore (M2): link para dentro é seguido; fora, grande ou quebrado é recusado", () => {
  const dockerfile = () => path.join(dir, "Dockerfile");

  it(".dockerignore que é link para um arquivo dentro do projeto: o conteúdo do alvo vale", async () => {
    await mkdir(path.join(dir, "docker"));
    await writeFile(path.join(dir, "docker", "real.ignore"), "secrets/\n*.pem\n");
    await symlink("docker/real.ignore", path.join(dir, ".dockerignore"));
    const restore = await excludePanelDotenv(dir, dockerfile(), work);
    expect(await readFile(`${dockerfile()}.dockerignore`, "utf8")).toBe(`secrets/\n*.pem\n${PANEL_IGNORE_BLOCK}`);
    await restore();
    expect((await lstat(path.join(dir, ".dockerignore"))).isSymbolicLink()).toBe(true);
  });

  it("<Dockerfile>.dockerignore que é link para dentro: o alvo é a base e o link volta", async () => {
    await writeFile(path.join(dir, "real.ignore"), "*.key\n");
    await symlink("real.ignore", `${dockerfile()}.dockerignore`);
    const restore = await excludePanelDotenv(dir, dockerfile(), work);
    expect(await readFile(`${dockerfile()}.dockerignore`, "utf8")).toBe(`*.key\n${PANEL_IGNORE_BLOCK}`);
    await restore();
    expect(await readlink(`${dockerfile()}.dockerignore`)).toBe("real.ignore");
  });

  it("link para fora do projeto: recusa com mensagem clara e não grava nada", async () => {
    await writeFile(path.join(top, "fora.ignore"), "secrets/\n");
    await symlink("../fora.ignore", path.join(dir, ".dockerignore"));
    await expect(excludePanelDotenv(dir, dockerfile(), work)).rejects.toThrow(/link para fora da pasta do projeto/);
    expect(existsSync(`${dockerfile()}.dockerignore`)).toBe(false);
    expect(existsSync(path.join(work, IGNORE_JOURNAL))).toBe(false);
  });

  it("link quebrado: recusa", async () => {
    await symlink("nao-existe", path.join(dir, ".dockerignore"));
    await expect(excludePanelDotenv(dir, dockerfile(), work)).rejects.toThrow(/link quebrado/);
  });

  it("arquivo acima de 1 MB: recusa (não corta no meio de uma linha)", async () => {
    await writeFile(path.join(dir, ".dockerignore"), "a\n".repeat(600_000));
    await expect(excludePanelDotenv(dir, dockerfile(), work)).rejects.toThrow(/mais de 1 MB/);
    await rm(path.join(dir, ".dockerignore"));
    await writeFile(`${dockerfile()}.dockerignore`, "a\n".repeat(600_000));
    await expect(excludePanelDotenv(dir, dockerfile(), work)).rejects.toThrow(/mais de 1 MB/);
  });

  it(".dockerignore da raiz que é pasta: recusa", async () => {
    await mkdir(path.join(dir, ".dockerignore"));
    await expect(excludePanelDotenv(dir, dockerfile(), work)).rejects.toThrow(/não é um arquivo comum/);
  });

  it("Dockerfile fora da pasta do projeto: recusa sem gravar nada fora dela", async () => {
    await expect(excludePanelDotenv(dir, path.join(top, "Dockerfile"), work)).rejects.toThrow(/fora da pasta do projeto/);
    expect(existsSync(path.join(top, "Dockerfile.dockerignore"))).toBe(false);
  });
});

describe("ownDotenvInContext (aviso do .env do repositório)", () => {
  const dockerfile = () => path.join(dir, "Dockerfile");

  it("sem .env, ou com o .env do painel: não avisa", async () => {
    expect(await ownDotenvInContext(dir, dockerfile())).toBe(false);
    await writeFile(path.join(dir, ".env"), `${GENERATED_HEADER}\nA=1\n`);
    expect(await ownDotenvInContext(dir, dockerfile())).toBe(false);
  });

  it(".env do dono sem exclusão no .dockerignore: avisa; com a exclusão (na raiz ou no específico): não", async () => {
    await writeFile(path.join(dir, ".env"), "VITE_X=1\n");
    expect(await ownDotenvInContext(dir, dockerfile())).toBe(true);
    await writeFile(path.join(dir, ".dockerignore"), "node_modules\n.env\n");
    expect(await ownDotenvInContext(dir, dockerfile())).toBe(false);
    await writeFile(`${dockerfile()}.dockerignore`, "node_modules\n");
    expect(await ownDotenvInContext(dir, dockerfile())).toBe(true);
    await writeFile(`${dockerfile()}.dockerignore`, "**/.env*\n");
    expect(await ownDotenvInContext(dir, dockerfile())).toBe(false);
  });

  it("ignore ilegível (link para fora): avisa por precaução", async () => {
    await writeFile(path.join(dir, ".env"), "X=1\n");
    await writeFile(path.join(top, "fora.ignore"), ".env\n");
    await symlink("../fora.ignore", path.join(dir, ".dockerignore"));
    expect(await ownDotenvInContext(dir, dockerfile())).toBe(true);
  });
});

describe("composeBuildTargets", () => {
  const src = "/projetos/loja/src";

  it("contexto e Dockerfile absolutos; forma curta (build: ./api); padrão Dockerfile", () => {
    const targets = composeBuildTargets(
      {
        services: {
          web: { build: { context: src, dockerfile: "docker/web.Dockerfile" } },
          api: { build: "./api" },
          vazio: { build: {} },
        },
      },
      src,
    );
    expect(targets).toEqual([
      { service: "web", context: src, dockerfile: `${src}/docker/web.Dockerfile` },
      { service: "api", context: `${src}/api`, dockerfile: `${src}/api/Dockerfile` },
      { service: "vazio", context: src, dockerfile: `${src}/Dockerfile` },
    ]);
  });

  it("sem build, dockerfile_inline, contexto remoto (URL ou git@) e modelos estranhos ficam de fora", () => {
    expect(
      composeBuildTargets(
        {
          services: {
            a: { image: "x" },
            b: { build: null },
            c: { build: { context: src, dockerfile_inline: "FROM alpine" } },
            d: { build: { context: "https://example.com/x.git" } },
            e: { build: { context: "git@example.com:x/y.git" } },
            f: "texto",
            g: [],
          },
        },
        src,
      ),
    ).toEqual([]);
    expect(composeBuildTargets(null, src)).toEqual([]);
    expect(composeBuildTargets({ services: [] }, src)).toEqual([]);
    expect(composeBuildTargets({}, src)).toEqual([]);
  });
});
