/**
 * Os mesmos compose hostis, agora pelo `docker compose config` REAL — o que o
 * deploy usa (achado A1). Aqui entram os que o YAML cru não mostra: merge,
 * `include`, `extends`, interpolação `${VAR:-true}`, caminhos relativos já
 * resolvidos. Roda só onde há `docker compose` (`config` não cria nada).
 */
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeEnv, loadCanonicalCompose } from "../src/compose-config.js";
import { checkComposeModel } from "../src/compose-model.js";

function temComposeReal(): boolean {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}
const DOCKER = temComposeReal();

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "hostil");
let root: string;
let src: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paas-hostil-docker-"));
  src = path.join(root, "projeto");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Mesmos argumentos do deploy (engine.composeArgs), sem o override. */
function args(): string[] {
  return ["compose", "-p", "paas-atacante", "--project-directory", src, "-f", path.join(src, "docker-compose.yml")];
}

async function resolvido(caso: string) {
  await cp(path.join(FIXTURES, caso), src, { recursive: true });
  const loaded = await loadCanonicalCompose(args());
  if (!loaded.ok) throw new Error(loaded.error);
  return checkComposeModel(loaded.model, {
    fileName: "docker-compose.yml",
    srcRoot: src,
    projectName: "paas-atacante",
    mode: "canonical",
    panelNetwork: "paas-net",
  });
}

describe.skipIf(!DOCKER)("compose hostil — pelo docker compose config real", () => {
  it("privileged: ${PRIV:-true} e volume montado por interpolação são barrados", async () => {
    const f = await resolvido("interp");
    const titulos = f.map((x) => x.title);
    expect(titulos).toContain("Container privilegiado");
    expect(titulos).toContain("Socket do Docker montado no container");
  });

  it("merge <<: *evil é barrado", async () => {
    const f = await resolvido("merge");
    expect(f.filter((x) => x.rule === "privileged-container")).not.toHaveLength(0);
  });

  it("include: e extends: de outro arquivo trazem privileged e docker.sock — barrados", async () => {
    const f = await resolvido("include");
    const servicos = f.filter((x) => x.rule === "privileged-container").map((x) => x.service);
    expect(servicos).toContain("ev");
    expect(servicos).toContain("web");
  });

  it("bind relativo que sobe da pasta, / e /run/docker.sock são barrados", async () => {
    // a raiz e /var/run são panel-resource (regra mais rígida, sem override); o restante, host-mount
    expect((await resolvido("bindlong")).filter((x) => x.rule === "host-mount" || x.rule === "panel-resource").length).toBeGreaterThanOrEqual(2);
    expect((await resolvido("rootmount")).filter((x) => x.rule === "host-mount" || x.rule === "panel-resource")).not.toHaveLength(0);
  });

  it("volume externo do painel e rede externa são barrados", async () => {
    const f = await resolvido("namedvol");
    expect(f.filter((x) => x.rule === "panel-resource")).toHaveLength(2);
  });

  it("env_file e build.context de fora da pasta são barrados sem ler o conteúdo", async () => {
    const f = await resolvido("dockerfile_ctx");
    expect(f.filter((x) => x.rule === "build-outside-src").length).toBeGreaterThanOrEqual(3);
  });

  it("compose legítimo (build local, volume nomeado, pasta ./dados, rede própria) passa", async () => {
    expect(await resolvido("legitimo")).toEqual([]);
  });

  it("o JSON canônico gravado fora do src volta igual pelo compose (é dele que o up roda) e ignora o .env do src", async () => {
    await cp(path.join(FIXTURES, "legitimo"), src, { recursive: true });
    await writeFile(path.join(src, ".env"), "IMAGEM=hostil\n");
    const loaded = await loadCanonicalCompose(args());
    expect(loaded.ok).toBe(true);
    const canonico = path.join(root, "paas.canonical.json");
    const vazio = path.join(root, "paas.up.env");
    await writeFile(canonico, JSON.stringify(loaded.ok ? loaded.model : null));
    await writeFile(vazio, "");
    const volta = await loadCanonicalCompose([
      "compose", "-p", "paas-atacante", "--env-file", vazio, "--project-directory", src, "-f", canonico,
    ]);
    expect(volta.ok).toBe(true);
    expect(volta.ok ? volta.model : null).toEqual(loaded.ok ? loaded.model : undefined);
  });

  it("variável só com o nome e ${VAR} de env_file resolvem no up pelo env-file do painel (config real + JSON canônico)", async () => {
    await mkdir(src, { recursive: true });
    await writeFile(
      path.join(src, "docker-compose.yml"),
      "services:\n  web:\n    image: nginx:1.27\n    environment: [DATABASE_URL]\n    env_file: [vars.env]\n",
    );
    await writeFile(path.join(src, "vars.env"), "DERIVADA=${PAINEL_VAR}-ok\n");
    // ambiente montado pelo painel: .env do projeto + Variáveis do painel (por último)
    const ambiente = path.join(root, "paas.up.env");
    await writeFile(ambiente, "DATABASE_URL=postgres://do-repo\nDATABASE_URL=postgres://painel\nPAINEL_VAR=valor\n");
    const cabecalho = ["compose", "-p", "paas-atacante", "--env-file", ambiente, "--project-directory", src];
    const loaded = await loadCanonicalCompose([...cabecalho, "-f", path.join(src, "docker-compose.yml")]);
    expect(loaded.ok).toBe(true);
    const canonico = path.join(root, "paas.canonical.json");
    await writeFile(canonico, JSON.stringify(loaded.ok ? loaded.model : null));
    // o que o `up` vai ver: o JSON conferido + o env-file do painel, com o ambiente resolvido
    const texto = execFileSync("docker", [...cabecalho, "-f", canonico, "config", "--format", "json"], { env: composeEnv(), encoding: "utf8" });
    expect(texto).toContain("postgres://painel");
    expect(texto).toContain("valor-ok");
  });

  it("o ambiente do painel NÃO entra na interpolação: ${SETUP_TOKEN} chega vazio", async () => {
    await cp(path.join(FIXTURES, "legitimo"), src, { recursive: true });
    await writeFile(
      path.join(src, "docker-compose.yml"),
      'services:\n  web:\n    image: nginx:1.27\n    environment:\n      VAZOU: "${SETUP_TOKEN:-vazio}"\n',
    );
    const antes = process.env.SETUP_TOKEN;
    process.env.SETUP_TOKEN = "segredo-do-painel";
    try {
      const loaded = await loadCanonicalCompose(args());
      expect(loaded.ok).toBe(true);
      const text = JSON.stringify(loaded.ok ? loaded.model : null);
      expect(text).toContain("vazio");
      expect(text).not.toContain("segredo-do-painel");
    } finally {
      if (antes === undefined) delete process.env.SETUP_TOKEN;
      else process.env.SETUP_TOKEN = antes;
    }
  });
});

describe("loadCanonicalCompose / composeEnv", () => {
  it("composeEnv repassa só o que o docker precisa", () => {
    const env = composeEnv({
      PATH: "/usr/bin",
      HOME: "/home/tws",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      HTTPS_PROXY: "http://proxy:3128",
      SETUP_TOKEN: "x",
      SESSION_SECRET: "y",
      PAAS_DATA_DIR: "/data",
      LC_ALL: "C",
    });
    expect(Object.keys(env).sort()).toEqual(["DOCKER_HOST", "HOME", "HTTPS_PROXY", "LC_ALL", "PATH"]);
  });

  it("falha do config: devolve o erro e as variáveis obrigatórias que faltam", async () => {
    const r = await loadCanonicalCompose(["compose"], async () => ({
      code: 1,
      stdout: "",
      stderr: "required variable DB_PASS is missing a value: defina\nrequired variable DB_PASS is missing a value",
    }));
    expect(r).toMatchObject({ ok: false, missing: ["DB_PASS"] });
  });

  it("saída que não é JSON vira erro, não exceção", async () => {
    const r = await loadCanonicalCompose(["compose"], async () => ({ code: 0, stdout: "name: x", stderr: "" }));
    expect(r).toMatchObject({ ok: false });
  });

  it("repassa o ambiente filtrado e o prazo ao executar", async () => {
    let visto: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {};
    await loadCanonicalCompose(["compose"], async (_f, _a, opts) => {
      visto = opts ?? {};
      return { code: 0, stdout: "{}", stderr: "" };
    });
    expect(visto.timeoutMs).toBeGreaterThan(0);
    expect(visto.env).not.toHaveProperty("SETUP_TOKEN");
  });
});
