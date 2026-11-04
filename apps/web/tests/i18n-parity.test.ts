import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { catalog, SOURCE_LOCALE } from "../src/i18n/core";
import { NAMESPACES } from "../src/i18n/keys";

const SRC = path.resolve(__dirname, "../src");
const locales = Object.keys(catalog).filter((l) => l !== SOURCE_LOCALE);

/** Variáveis `{nome}` de um texto. */
const vars = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
/** Tags de marcação `<b>`…`</b>` de um texto. */
const tags = (text: string) => [...text.matchAll(/<(\w+)>/g)].map((m) => m[1]!).sort();

describe("paridade entre idiomas", () => {
  it("o idioma de origem tem todos os namespaces e os arquivos batem com a lista", () => {
    expect(Object.keys(catalog[SOURCE_LOCALE]!).sort()).toEqual([...NAMESPACES].sort());
    const onDisk = fs
      .readdirSync(path.join(SRC, "locales", SOURCE_LOCALE))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => f.replace(/\.ts$/, ""))
      .sort();
    expect(onDisk).toEqual([...NAMESPACES].sort());
  });

  it("há pelo menos um idioma além do de origem", () => {
    expect(locales).toContain("en");
  });

  describe.each(locales)("%s", (locale) => {
    it("mesmos namespaces", () => {
      expect(Object.keys(catalog[locale]!).sort()).toEqual(Object.keys(catalog[SOURCE_LOCALE]!).sort());
    });

    it.each(NAMESPACES)("namespace %s: nenhuma chave faltando ou sobrando", (ns) => {
      const source = Object.keys(catalog[SOURCE_LOCALE]![ns] ?? {}).sort();
      const other = Object.keys(catalog[locale]![ns] ?? {}).sort();
      expect({ missing: source.filter((k) => !other.includes(k)), extra: other.filter((k) => !source.includes(k)) }).toEqual({
        missing: [],
        extra: [],
      });
    });

    it.each(NAMESPACES)("namespace %s: mesmas variáveis, tags e nenhum texto vazio", (ns) => {
      const source = catalog[SOURCE_LOCALE]![ns] ?? {};
      const other = catalog[locale]![ns] ?? {};
      const problems: string[] = [];
      for (const [key, text] of Object.entries(source)) {
        const translated = other[key];
        if (translated === undefined) continue;
        if (translated.trim() === "" && text.trim() !== "") problems.push(`${ns}.${key}: vazio`);
        if (vars(text).join() !== vars(translated).join()) problems.push(`${ns}.${key}: variáveis ${vars(text)} x ${vars(translated)}`);
        if (tags(text).join() !== tags(translated).join()) problems.push(`${ns}.${key}: tags ${tags(text)} x ${tags(translated)}`);
      }
      expect(problems).toEqual([]);
    });
  });
});

describe("uso das chaves no código", () => {
  function sources(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === "locales" ? [] : sources(p);
      return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
    });
  }

  it("toda chave literal usada em t(\"ns.chave\") existe no idioma de origem", () => {
    const source = catalog[SOURCE_LOCALE]!;
    const exists = (key: string) => {
      const i = key.indexOf(".");
      const dict = source[key.slice(0, i)] ?? {};
      const inner = key.slice(i + 1);
      return inner in dict || `${inner}_other` in dict;
    };
    const usage = new RegExp(`\\b(?:t|tr|translate)\\(\\s*"((?:${NAMESPACES.join("|")})\\.[^"]+)"`, "g");
    const missing: string[] = [];
    for (const file of sources(SRC)) {
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(usage)) {
        if (!exists(m[1]!)) missing.push(`${path.relative(SRC, file)}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
