import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// O script de links (docs:links) pula comoFuncionaSistema/. Esta checagem cobre a pasta: toda referência a
// outro arquivo da documentação (módulo/arquivo.json) precisa existir, e o material de sessão não volta.
const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PASTA = join(RAIZ, "comoFuncionaSistema");

function listar(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? listar(p) : [p];
  });
}

const arquivos = listar(PASTA);
const modulos = readdirSync(PASTA).filter((n) => statSync(join(PASTA, n)).isDirectory());
// ex.: global/persistencia.json, ../docs/security/threat-model.json
const RE_REF = new RegExp(`(?<![\\w/.-])((?:\\.\\./docs/security|${modulos.join("|")})/[A-Za-z0-9._-]+\\.(?:json|md))`, "g");

describe("comoFuncionaSistema: referências entre arquivos", () => {
  it("toda referência módulo/arquivo.json aponta para um arquivo que existe", () => {
    const quebradas: string[] = [];
    for (const f of arquivos) {
      const texto = readFileSync(f, "utf8");
      for (const m of texto.matchAll(RE_REF)) {
        const ref = m[1]!;
        if (!existsSync(resolve(PASTA, ref))) quebradas.push(`${f.slice(RAIZ.length + 1)} -> ${ref}`);
      }
    }
    expect(quebradas).toEqual([]);
  });

  it("não cita arquivos de sessão que ficam fora do repositório", () => {
    const citam = arquivos.filter((f) => /_RELATORIO-[\w-]+\.md|_ESTADO-DA-SESSAO|_i18n-servidor|review-20\d\d-/.test(readFileSync(f, "utf8")));
    expect(citam.map((f) => f.slice(RAIZ.length + 1))).toEqual([]);
  });

  it("não tem relatórios nem estado de sessão versionados na pasta", () => {
    const proibidos = arquivos.filter((f) => /\/_(RELATORIO|ESTADO)[^/]*$|\/_i18n-[^/]*$|\/review-[^/]*\.json$/.test(f));
    expect(proibidos.map((f) => f.slice(RAIZ.length + 1))).toEqual([]);
  });
});
