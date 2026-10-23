/**
 * A lista de sufixos públicos embutida (public-suffixes.generated.ts) vem SÓ da cópia fixada da
 * Public Suffix List (packages/core/psl/public_suffix_list.dat), gerada por
 * scripts/gen-public-suffixes.mjs. Aqui: (1) o módulo não diverge da cópia (anti-memória: nada
 * editado à mão), (2) o motor de regras concorda com a PSL para TODA regra ICANN da cópia,
 * inclusive as escritas em Unicode (convertidas para punycode), (3) a seção privada vai à parte,
 * (4) tamanho do módulo no bundle web, (5) a cópia está versionada e (6) a licença continua no arquivo.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { domainToASCII, fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { apexOf, isPublicSuffix } from "../src/domain-pair";
import { PSL_COMMIT, PSL_COUNTRY_TLDS, PSL_PRIVATE_RULES, PSL_RULES, PSL_VERSION } from "../src/public-suffixes.generated";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const GERADO = path.join(RAIZ, "packages/core/src/public-suffixes.generated.ts");
const COPIA = path.join(RAIZ, "packages/core/psl/public_suffix_list.dat");

function secaoIcann(): string[] {
  const dat = readFileSync(COPIA, "utf8");
  return dat.slice(dat.indexOf("===BEGIN ICANN"), dat.indexOf("===END ICANN")).split("\n");
}
function primeiroToken(linha: string): string {
  return linha.trim().split(/\s+/)[0] ?? "";
}
const paraAscii = (nome: string) => nome.split(".").map((r) => (/^[\x00-\x7f]*$/.test(r) ? r : domainToASCII(r))).join(".");

describe("public-suffixes.generated.ts", () => {
  it("é exatamente o que o script gera a partir da cópia fixada (nada à mão)", () => {
    const regerado = execFileSync("node", [path.join(RAIZ, "scripts/gen-public-suffixes.mjs"), "--stdout"], { encoding: "utf8" });
    expect(readFileSync(GERADO, "utf8")).toBe(regerado);
  });

  it("registra a versão e o commit da cópia, e a licença MPL-2.0", () => {
    const dat = readFileSync(COPIA, "utf8");
    expect(dat).toContain(`// VERSION: ${PSL_VERSION}`);
    expect(dat).toContain(`// COMMIT: ${PSL_COMMIT}`);
    expect(dat).toContain("Mozilla Public");
    const gerado = readFileSync(GERADO, "utf8");
    expect(gerado).toMatch(/Mozilla Public\s+\*?\s*License 2\.0/);
    expect(gerado).toContain("GERADO por scripts/gen-public-suffixes.mjs");
  });

  it("tamanho do módulo de dados (ICANN + CentralNic + privada) no bundle web: <= 125 KB", () => {
    expect(readFileSync(GERADO).length).toBeLessThanOrEqual(125 * 1024);
  });

  it("a cópia fixada não é ignorada pelo controle de versão (nem a regra data/ do .gitignore nem o pre-commit a barram: fica em psl/)", () => {
    let ignorado = true;
    try {
      execFileSync("git", ["check-ignore", "-q", COPIA], { cwd: RAIZ, stdio: "ignore" });
    } catch {
      ignorado = false; // código 1 = não ignorado
    }
    expect(ignorado).toBe(false);
  });

  it("cada regra ICANN da cópia vale no motor (Unicode convertido para punycode): o sufixo não é registrável e um rótulo a mais é", () => {
    let verificadas = 0;
    let unicode = 0;
    for (const bruta of secaoIcann()) {
      const bruto = primeiroToken(bruta);
      if (bruto === "" || bruto.startsWith("//") || /^[*!]/.test(bruto)) continue;
      const regra = paraAscii(bruto);
      if (regra === "home.arpa" || !regra.includes(".")) continue; // home.arpa: rede local, tratada antes da PSL
      expect(isPublicSuffix(regra), bruto).toBe(true);
      expect(apexOf(regra), bruto).toBeNull();
      expect(apexOf(`example.${regra}`), bruto).toBe(`example.${regra}`);
      // digitado em Unicode vale o mesmo
      expect(isPublicSuffix(bruto), bruto).toBe(true);
      if (!/^[\x00-\x7f]*$/.test(bruto)) unicode++;
      verificadas++;
    }
    expect(verificadas).toBeGreaterThan(4000);
    expect(unicode).toBeGreaterThan(200);
  });

  it("curingas e exceções da cópia valem no motor", () => {
    let curingas = 0;
    let excecoes = 0;
    for (const bruta of secaoIcann()) {
      const regra = paraAscii(primeiroToken(bruta).replace(/^!/, "")).replace(/^xn--\*$/, "*");
      const bruto = primeiroToken(bruta);
      if (/^\*\./.test(bruto)) {
        const base = paraAscii(bruto.slice(2));
        expect(isPublicSuffix(`x.${base}`), bruto).toBe(true);
        curingas++;
      } else if (bruto.startsWith("!")) {
        expect(isPublicSuffix(regra), bruto).toBe(false);
        expect(apexOf(`www.${regra}`), bruto).toBe(regra);
        excecoes++;
      }
    }
    expect(curingas).toBeGreaterThan(5);
    expect(excecoes).toBeGreaterThan(5);
  });

  it("tem as entradas da CentralNic e os países; a seção privada fica à parte", () => {
    expect(PSL_RULES.com).toContain("br");
    expect(PSL_RULES.com).not.toMatch(/(^| )blogspot( |$)/);
    expect(PSL_RULES.net).toContain("uk");
    expect(PSL_COUNTRY_TLDS).toEqual(expect.arrayContaining(["br", "de", "uk", "io", "co"]));
    expect(PSL_RULES.br).toContain("*.nom");
    expect(PSL_RULES.br).not.toContain("santos");
    expect(PSL_PRIVATE_RULES.org).toContain("eu");
    expect(PSL_PRIVATE_RULES.io).toContain("github");
    expect(PSL_RULES.org).not.toContain("eu");
  });

  it("o módulo é só ASCII e traz as regras IDN em punycode", () => {
    expect(JSON.stringify([PSL_RULES, PSL_PRIVATE_RULES, PSL_COUNTRY_TLDS])).toMatch(/^[\x00-\x7f]*$/);
    expect(PSL_RULES.cn).toContain("xn--55qx5d");
    expect(PSL_RULES.hk).toContain("xn--wcvs22d");
  });
});
