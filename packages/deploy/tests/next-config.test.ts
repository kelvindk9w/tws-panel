/**
 * next-config.ts — leitura do `output` do next.config SÓ por texto: export,
 * standalone, expressão que o painel não consegue avaliar, comentários e
 * entradas hostis (tempo linear).
 */
import { describe, expect, it } from "vitest";
import { NEXT_CONFIG_MAX_CHARS, nextOutputOf, stripJsComments } from "../src/next-config.js";

describe("stripJsComments", () => {
  it("troca comentários de linha e de bloco por espaço e mantém o resto", () => {
    expect(stripJsComments("a // b\nc /* d */ e")).toBe("a  \nc   e");
  });

  it("não mexe em // dentro de string (URL) nem em /* dentro de string", () => {
    const src = 'const u = "https://example.com/*x*/"; const t = `a//b`; const s = \'/* y */\';';
    expect(stripJsComments(src)).toBe(src);
  });

  it("aspas escapadas não encerram a string", () => {
    const src = 'const s = "a\\"// ainda string"; // fim';
    expect(stripJsComments(src)).toBe('const s = "a\\"// ainda string";  ');
  });

  it("string e comentário de bloco sem fechamento vão até o fim, sem laço infinito", () => {
    expect(stripJsComments('x = "abc')).toBe('x = "abc');
    expect(stripJsComments("x /* nunca fecha")).toBe("x  ");
    expect(stripJsComments('x = "abc\\')).toBe('x = "abc\\');
  });

  it("limita o texto lido ao teto", () => {
    expect(stripJsComments("a".repeat(NEXT_CONFIG_MAX_CHARS + 5000)).length).toBe(NEXT_CONFIG_MAX_CHARS);
  });
});

describe("nextOutputOf", () => {
  it.each([
    ['export default { output: "export" };', "export"],
    ["module.exports = { output: 'export' }", "export"],
    ["module.exports = {\n  output: `export`,\n}", "export"],
    ['export default { "output": "export" }', "export"],
    ["const c = { output: 'standalone', reactStrictMode: true }", "standalone"],
    ["export default { output: 'standalone' as const } satisfies NextConfig", "standalone"],
    ["module.exports = { reactStrictMode: true }", "none"],
    ["", "none"],
    ['module.exports = { output: "server" }', "other"],
  ])("%s → %s", (source, expected) => {
    expect(nextOutputOf(source)).toBe(expected);
  });

  it("comentário com output: \"export\" não conta (mutação: ignorar comentários)", () => {
    expect(nextOutputOf('module.exports = {\n  // output: "export",\n  reactStrictMode: true,\n}')).toBe("none");
    expect(nextOutputOf('/* output: "standalone" */ module.exports = {}')).toBe("none");
  });

  it("expressão (variável, ternário, process.env) é dynamic: o painel não executa o arquivo", () => {
    expect(nextOutputOf("module.exports = { output: process.env.NEXT_OUTPUT }")).toBe("dynamic");
    expect(nextOutputOf('module.exports = { output: isDocker ? "standalone" : undefined }')).toBe("dynamic");
  });

  it("output: { … } do webpack é ignorado e não esconde o output do Next", () => {
    const cfg = 'module.exports = {\n webpack(c) { c.output = {}; return { output: { path: "x" } }; },\n output: "standalone" }';
    expect(nextOutputOf(cfg)).toBe("standalone");
    expect(nextOutputOf("const w = { output: { path: 'x' } }")).toBe("none");
  });

  it("export vence standalone, que vence dynamic, que vence outro literal", () => {
    expect(nextOutputOf('a = { output: "standalone" }; b = { output: "export" }')).toBe("export");
    expect(nextOutputOf('a = { output: x }; b = { output: "standalone" }')).toBe("standalone");
    expect(nextOutputOf('a = { output: "server" }; b = { output: x }')).toBe("dynamic");
  });

  it("palavra parecida (myoutput, outputs) não é o output do Next", () => {
    expect(nextOutputOf('const myoutput = { myoutput: "export" }')).toBe("none");
    expect(nextOutputOf('x = { outputs: "export" }')).toBe("none");
  });

  describe("entrada hostil: tempo linear", () => {
    const limitMs = 1500;
    const hostis: Array<[string, string]> = [
      ["milhões de espaços depois de output", "output" + " ".repeat(2_000_000)],
      ["output repetido sem dois-pontos", "output ".repeat(300_000)],
      ["aspas e barras invertidas", '"\\'.repeat(400_000)],
      ["comentário de bloco aninhado falso", "/*".repeat(400_000)],
      ["output: sem fim de linha", "x = { output: " + "a".repeat(2_000_000)],
      ["dois-pontos e espaços alternados", ("output :" + " \t").repeat(100_000)],
    ];
    it.each(hostis)("%s", (_nome, texto) => {
      const t0 = performance.now();
      nextOutputOf(texto);
      expect(performance.now() - t0).toBeLessThan(limitMs);
    });
  });
});
