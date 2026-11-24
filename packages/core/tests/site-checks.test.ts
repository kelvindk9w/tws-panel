/**
 * site-checks.test.ts — conferências do endereço do site de documentação (scripts/check-site-url.mjs,
 * scripts/site-config.mjs e o uso de sitePageExists em scripts/check-doc-links.mjs).
 *
 * O site é um site de projeto do GitHub Pages que herda o domínio do site de usuário da conta:
 * site = EXPECTED_SITE, base = EXPECTED_BASE e nenhum site/public/CNAME. Os endereços "errados" dos
 * casos abaixo são montados por partes, para este arquivo não ter nenhum deles por extenso (o próprio
 * check-site-url varre os .ts do repositório).
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error módulo .mjs de scripts/ sem declaração de tipos
import { CNAME, EXPECTED_BASE, EXPECTED_SITE, siteSetupProblems } from "../../../scripts/check-site-url.mjs";
// @ts-expect-error módulo .mjs de scripts/ sem declaração de tipos
import { ROOT, readSiteConfig, sitePageExists } from "../../../scripts/site-config.mjs";

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts");
const ESQUEMA = "https:" + "//";
const HOST_DOCS = "docs.tws" + ".tec.br";
const HOST_ANTIGO = "kelvindk9w" + ".github.io";
const CONFIG = "site/astro.config.mjs";

type Cfg = { config: string; origin: string; basePath: string };
const certo: Cfg = { config: CONFIG, origin: EXPECTED_SITE, basePath: EXPECTED_BASE };

const pastas: string[] = [];
afterEach(() => {
  for (const d of pastas.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Pasta temporária com os arquivos dados (caminho → conteúdo). */
function pasta(arquivos: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "site-checks-"));
  pastas.push(dir);
  for (const [rel, conteudo] of Object.entries(arquivos)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), conteudo);
  }
  return dir;
}

/** Config do Astro com o site e o base dados, no formato que readSiteConfig lê. */
const astroConfig = (site: string, base: string) =>
  `const base = '${base}';\nexport default defineConfig({\n  site: '${site}',\n  base,\n});\n`;

/** Repositório git temporário com os scripts copiados (a raiz deles vira a pasta), rodando um. */
function rodar(script: string, arquivos: Record<string, string>) {
  const dir = pasta(arquivos);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  for (const f of ["site-config.mjs", script]) copyFileSync(join(SCRIPTS, f), join(dir, "scripts", f));
  const env = { PATH: process.env.PATH ?? "", HOME: dir, GIT_CONFIG_NOSYSTEM: "1" };
  spawnSync("git", ["init", "-q"], { cwd: dir, env });
  const r = spawnSync(process.execPath, [join("scripts", script)], { cwd: dir, env, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("check-site-url: site, base e CNAME (siteSetupProblems)", () => {
  it("os valores esperados são o domínio herdado e a pasta do repositório", () => {
    expect(EXPECTED_SITE).toBe(`${ESQUEMA}${HOST_DOCS}`);
    expect(EXPECTED_BASE).toBe("/tws-panel");
    expect(CNAME).toBe("site/public/CNAME");
  });

  it("aceita site e base esperados sem CNAME", () => {
    expect(siteSetupProblems(certo, { cnameExists: false })).toEqual([]);
  });

  it("reprova a existência de site/public/CNAME, mesmo com site e base certos", () => {
    const p = siteSetupProblems(certo, { cnameExists: true });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("site/public/CNAME");
    expect(p[0]).toContain("domínio próprio");
  });

  it("reprova o site na raiz do domínio (base /), como o PR antigo fazia", () => {
    const p = siteSetupProblems({ ...certo, basePath: "" }, { cnameExists: false });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('base é "/"');
    expect(p[0]).toContain(`"${EXPECTED_BASE}/"`);
  });

  it("reprova outra pasta, inclusive uma que só começa igual", () => {
    for (const basePath of ["/outro", "/tws-panel/en", "/tws-panel-x", "/TWS-PANEL"]) {
      expect(siteSetupProblems({ ...certo, basePath }, { cnameExists: false }), basePath).toHaveLength(1);
    }
  });

  it("reprova outro site: o endereço antigo do github.io, http, outro host ou caixa diferente", () => {
    for (const origin of [`${ESQUEMA}${HOST_ANTIGO}`, `http://${HOST_DOCS}`, `${ESQUEMA}x.example.com`, `${ESQUEMA}${HOST_DOCS.toUpperCase()}`]) {
      const p = siteSetupProblems({ ...certo, origin }, { cnameExists: false });
      expect(p, origin).toHaveLength(1);
      expect(p[0]).toContain(`"${EXPECTED_SITE}"`);
    }
  });

  it("junta todos os problemas de uma vez", () => {
    expect(siteSetupProblems({ config: CONFIG, origin: `${ESQUEMA}${HOST_ANTIGO}`, basePath: "" }, { cnameExists: true })).toHaveLength(3);
  });

  it("a config do repositório está no formato esperado e sem CNAME", () => {
    const cfg = readSiteConfig();
    expect(cfg.root).toBe(`${EXPECTED_SITE}${EXPECTED_BASE}/`);
    expect(siteSetupProblems(cfg, { cnameExists: existsSync(join(ROOT, CNAME)) })).toEqual([]);
  });
});

describe("check-site-url: o script, num repositório de verdade", () => {
  const raiz = `${EXPECTED_SITE}${EXPECTED_BASE}`;

  it("passa com a config esperada e um README apontando para a pasta do site", () => {
    const r = rodar("check-site-url.mjs", {
      [CONFIG]: astroConfig(EXPECTED_SITE, "/tws-panel/"),
      "README.md": `[Docs](${raiz}/) e [ajuda](${raiz}/en/guides/help/)\n`,
    });
    expect(r.out).toContain("OK: 1 arquivo(s)");
    expect(r.status).toBe(0);
  });

  it("reprova quando site/public/CNAME existe", () => {
    const r = rodar("check-site-url.mjs", {
      [CONFIG]: astroConfig(EXPECTED_SITE, "/tws-panel/"),
      "site/public/CNAME": `${HOST_DOCS}\n`,
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("site/public/CNAME: existe");
  });

  it("reprova a configuração antiga do PR (raiz do domínio, com CNAME)", () => {
    const r = rodar("check-site-url.mjs", {
      [CONFIG]: astroConfig(EXPECTED_SITE, "/"),
      "site/public/CNAME": `${HOST_DOCS}\n`,
      "README.md": `[Docs](${ESQUEMA}${HOST_DOCS}/en/)\n`,
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("2 problema(s)");
    expect(r.out).toContain('base é "/"');
    expect(r.out).toContain("site/public/CNAME: existe");
  });

  it("reprova o endereço antigo do github.io como site da config", () => {
    const r = rodar("check-site-url.mjs", { [CONFIG]: astroConfig(`${ESQUEMA}${HOST_ANTIGO}`, "/tws-panel") });
    expect(r.status).toBe(1);
    expect(r.out).toContain("1 problema(s)");
    expect(r.out).toContain(`mas tem de ser "${EXPECTED_SITE}"`);
  });

  it("reprova link para a raiz do domínio ou para o endereço antigo, com a config certa", () => {
    const r = rodar("check-site-url.mjs", {
      [CONFIG]: astroConfig(EXPECTED_SITE, "/tws-panel/"),
      "README.md": `[raiz](${ESQUEMA}${HOST_DOCS}/en/guides/help/)\n[antigo](${ESQUEMA}${HOST_ANTIGO}/tws-panel/en/)\n[certo](${raiz}/en/)\n`,
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("2 problema(s)");
    expect(r.out).toContain("README.md:1:");
    expect(r.out).toContain("README.md:2:");
    expect(r.out).not.toContain("README.md:3:");
  });
});

describe("sitePageExists (caminhos absolutos do site → página-fonte)", () => {
  const paginas = {
    "site/src/content/docs/en/guides/a.md": "# A\n",
    "site/src/content/docs/en/guides/b.mdx": "# B\n",
    "site/src/content/docs/en/pasta/index.md": "# Pasta\n",
    "site/src/content/docs/pt-br/outra/index.mdx": "# Outra\n",
    "site/src/pages/index.astro": "---\n---\n",
  };

  it("acha .md, .mdx e index da pasta, com ou sem barra final, âncora e consulta", () => {
    const root = pasta(paginas);
    const existe = (p: string) => sitePageExists(p, { basePath: "/tws-panel", root });
    for (const p of [
      "/tws-panel/en/guides/a/",
      "/tws-panel/en/guides/a",
      "/tws-panel/en/guides/a/#secao",
      "/tws-panel/en/guides/a/?q=1",
      "/tws-panel/en/guides/b/",
      "/tws-panel/en/pasta/",
      "/tws-panel/pt-br/outra/",
    ])
      expect(existe(p), p).toBe(true);
  });

  it("o base sozinho, com ou sem barra, é a página inicial", () => {
    const root = pasta(paginas);
    expect(sitePageExists("/tws-panel/", { basePath: "/tws-panel", root })).toBe(true);
    expect(sitePageExists("/tws-panel", { basePath: "/tws-panel", root })).toBe(true);
    const semInicial = pasta({ "site/src/content/docs/en/guides/a.md": "# A\n" });
    expect(sitePageExists("/tws-panel/", { basePath: "/tws-panel", root: semInicial })).toBe(false);
  });

  it("recusa página inexistente, caminho sem o base, base parecido e caminho com ..", () => {
    const root = pasta(paginas);
    const existe = (p: string) => sitePageExists(p, { basePath: "/tws-panel", root });
    for (const p of ["/tws-panel/en/guides/nao-existe/", "/en/guides/a/", "/tws-panel-x/en/guides/a/", "/tws-panel/en/../en/guides/a/", "/tws-panel/en/guides/"])
      expect(existe(p), p).toBe(false);
  });

  it("com o site na raiz do domínio (base vazio), todo caminho começado por / é do site", () => {
    const root = pasta(paginas);
    expect(sitePageExists("/en/guides/a/", { basePath: "", root })).toBe(true);
    expect(sitePageExists("/", { basePath: "", root })).toBe(true);
    expect(sitePageExists("/en/guides/z/", { basePath: "", root })).toBe(false);
  });

  it("acha as páginas reais do repositório pelo base da config", () => {
    const { basePath } = readSiteConfig();
    expect(sitePageExists(`${basePath}/en/getting-started/installation/`, { basePath })).toBe(true);
    expect(sitePageExists(`${basePath}/pt-br/guides/help/`, { basePath })).toBe(true);
    expect(sitePageExists(`${basePath}/en/nao-existe/`, { basePath })).toBe(false);
  });
});

describe("check-doc-links: caminhos absolutos do site, num repositório de verdade", () => {
  const base = {
    [CONFIG]: astroConfig(EXPECTED_SITE, "/tws-panel/"),
    "site/src/content/docs/en/guides/a.md": "# A\n",
  };

  it("passa quando o frontmatter e os links /tws-panel/… apontam para páginas que existem", () => {
    const r = rodar("check-doc-links.mjs", {
      ...base,
      "site/src/content/docs/en/index.md": "---\nhero:\n  actions:\n    - text: A\n      link: /tws-panel/en/guides/a/\n---\n\n[A](/tws-panel/en/guides/a/#a)\n",
    });
    expect(r.out).toContain("nenhum link interno quebrado");
    expect(r.status).toBe(0);
  });

  it("reprova link do frontmatter sem página, caminho do site sem página e caminho sem o base", () => {
    const r = rodar("check-doc-links.mjs", {
      ...base,
      "site/src/content/docs/en/index.md":
        "---\nhero:\n  actions:\n    - text: Sumiu\n      link: /tws-panel/en/guides/sumiu/\n---\n\n[ok](/tws-panel/en/guides/a/)\n[x](/tws-panel/en/nao-existe/)\n[y](/en/guides/a/)\n",
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("3 problema(s)");
    expect(r.out).toContain("link do frontmatter sem página (/tws-panel/en/guides/sumiu/)");
    expect(r.out).toContain("caminho absoluto sem página no site (/tws-panel/en/nao-existe/)");
    expect(r.out).toContain("caminho absoluto não resolvível (/en/guides/a/)");
  });
});
