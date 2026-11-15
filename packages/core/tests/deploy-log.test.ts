/**
 * Corte do log de deploy: passado o teto, guarda o começo e o fim, com uma marca no meio dizendo quanto saiu.
 * Os testes conferem o texto que fica guardado (o que a tela e o "Copiar histórico" mostram), pedaço a pedaço,
 * como o deploy escreve.
 */
import { describe, expect, it } from "vitest";
import {
  appendDeployLog,
  DEPLOY_LOG_CUT_PREFIX,
  DEPLOY_LOG_HEAD_CHARS,
  DEPLOY_LOG_MAX_CHARS,
  deployLogCutMarker,
  parseDeployLogCut,
} from "../src/index";

const RESERVE = deployLogCutMarker(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER).length;
const countLines = (s: string) => s.split("\n").length - 1;
/** Metade de um par substituto sem a outra metade (viraria U+FFFD ao gravar em UTF-8). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Linhas numeradas, cada uma com `width` caracteres mais a quebra. */
function lines(from: number, count: number, width = 40): string {
  let out = "";
  for (let i = from; i < from + count; i++) out += `linha ${String(i).padStart(7, "0")} `.padEnd(width, "x") + "\n";
  return out;
}

/** Escreve `chunks` um a um, como o deploy faz. */
function stream(chunks: string[], max?: number, headMax?: number): string {
  let log = "";
  for (const c of chunks) log = appendDeployLog(log, c, max, headMax);
  return log;
}

/** Confere o log cortado contra tudo o que foi escrito: começo e fim são o texto original e a conta fecha. */
function expectCoherentCut(log: string, full: string, max: number, headMax: number) {
  expect(log.length).toBeLessThanOrEqual(max);
  const cut = parseDeployLogCut(log, headMax);
  expect(cut).not.toBeNull();
  const { head, tail, omittedChars, omittedLines, marker } = cut!;
  expect(log).toBe(head + marker + tail);
  expect(head.length).toBeLessThanOrEqual(headMax);
  expect(full.startsWith(head)).toBe(true);
  expect(full.endsWith(tail)).toBe(true);
  expect(head.length + omittedChars + tail.length).toBe(full.length);
  expect(omittedLines).toBe(countLines(full.slice(head.length, full.length - tail.length)));
  return cut!;
}

describe("log abaixo do teto", () => {
  it("fica intacto, pedaço a pedaço", () => {
    const chunks = ["=== Etapa 1/5 · Ingestão\n", "clonando…\n", "ação concluída ✓\n"];
    const log = stream(chunks);
    expect(log).toBe(chunks.join(""));
    expect(parseDeployLogCut(log)).toBeNull();
  });

  it("um log grande que ainda cabe não ganha marca", () => {
    const full = lines(0, 9_000); // 369.000 caracteres
    expect(full.length).toBeLessThan(DEPLOY_LOG_MAX_CHARS);
    expect(stream(full.match(/[^]{1,4096}/g)!)).toBe(full);
  });
});

describe("no teto exato", () => {
  it("chegar a exatamente o teto mantém o log intacto; um caractere a mais corta", () => {
    const max = 2_000;
    const headMax = 500;
    const full = lines(0, 50).slice(0, max - 1) + "\n"; // termina em quebra de linha, exatamente no teto
    expect(full.length).toBe(max);
    const exact = appendDeployLog(full.slice(0, max - 10), full.slice(max - 10), max, headMax);
    expect(exact).toBe(full);
    expect(parseDeployLogCut(exact, headMax)).toBeNull();

    const over = appendDeployLog(exact, "!", max, headMax);
    expect(over).not.toBe(full + "!");
    const cut = expectCoherentCut(over, full + "!", max, headMax);
    expect(cut.tail.endsWith("!")).toBe(true);
  });

  it("com o teto de verdade: 400.000 cabem, 400.001 cortam", () => {
    const base = "y".repeat(DEPLOY_LOG_MAX_CHARS - 1);
    const atLimit = appendDeployLog(base, "\n");
    expect(atLimit.length).toBe(DEPLOY_LOG_MAX_CHARS);
    expect(parseDeployLogCut(atLimit)).toBeNull();
    const over = appendDeployLog(atLimit, "z");
    expect(over.length).toBeLessThanOrEqual(DEPLOY_LOG_MAX_CHARS);
    expectCoherentCut(over, base + "\nz", DEPLOY_LOG_MAX_CHARS, DEPLOY_LOG_HEAD_CHARS);
  });
});

describe("log acima do teto", () => {
  it("guarda o começo (etapas e guardrails), a marca e o fim (erro final)", () => {
    const start = "=== Etapa 1/5 · Ingestão do código ===\n=== Etapa 2/5 · Preparação ===\nGuardrails: 0 bloqueios\n";
    const end = "ERROR: failed to solve: process did not complete successfully\n✖ Deploy falhou: build da imagem\n";
    const full = start + lines(0, 20_000) + end; // ~820.000 caracteres
    const log = appendDeployLog("", full);
    const cut = expectCoherentCut(log, full, DEPLOY_LOG_MAX_CHARS, DEPLOY_LOG_HEAD_CHARS);
    expect(log.startsWith(start)).toBe(true);
    expect(log.endsWith(end)).toBe(true);
    // começo e fim em fronteira de linha, marca numa linha própria
    expect(cut.head.endsWith("\n")).toBe(true);
    expect(full[full.length - cut.tail.length - 1]).toBe("\n");
    expect(cut.marker).toBe(deployLogCutMarker(cut.omittedChars, cut.omittedLines));
    expect(cut.marker.startsWith(DEPLOY_LOG_CUT_PREFIX)).toBe(true);
    expect(cut.marker).toMatch(/^\n\[… log cortado no meio: \d+ caracteres e \d+ linhas omitidos; o começo e o fim foram guardados …\]\n$/);
    // divisão: o começo usa até 1/4 do teto; o fim fica com o resto (perto do teto no total)
    expect(cut.head.length).toBeGreaterThan(DEPLOY_LOG_HEAD_CHARS - 41);
    expect(cut.tail.length).toBeGreaterThan(DEPLOY_LOG_MAX_CHARS - DEPLOY_LOG_HEAD_CHARS - RESERVE - 41);
    // as linhas omitidas são as do meio, inteiras
    expect(cut.omittedLines).toBe(cut.omittedChars / 41);
  });

  it("o começo nunca muda depois do primeiro corte, e o fim acompanha o que chega", () => {
    const max = 5_000;
    const headMax = 1_000;
    let log = appendDeployLog("", lines(0, 200), max, headMax);
    const firstHead = parseDeployLogCut(log, headMax)!.head;
    let full = lines(0, 200);
    for (let i = 200; i < 400; i += 10) {
      const chunk = lines(i, 10);
      full += chunk;
      log = appendDeployLog(log, chunk, max, headMax);
      const cut = expectCoherentCut(log, full, max, headMax);
      expect(cut.head).toBe(firstHead);
      expect(log.endsWith(chunk)).toBe(true);
    }
  });

  it("uma linha gigante no fim não some: o corte cai no meio dela", () => {
    const max = 3_000;
    const headMax = 500;
    const giant = "E".repeat(5_000) + " erro final\n";
    const full = lines(0, 10) + giant;
    const log = appendDeployLog("", full, max, headMax);
    const cut = expectCoherentCut(log, full, max, headMax);
    expect(cut.tail.endsWith(" erro final\n")).toBe(true);
    expect(cut.tail.length).toBe(max - cut.head.length - RESERVE);
    expect(cut.omittedLines).toBe(0);
  });

  it("começo sem nenhuma quebra de linha: corta no teto do começo", () => {
    const max = 3_000;
    const headMax = 500;
    const full = "a".repeat(4_000) + "\nfim\n";
    const cut = expectCoherentCut(appendDeployLog("", full, max, headMax), full, max, headMax);
    expect(cut.head).toBe("a".repeat(headMax));
  });

  it("singular na marca: 1 linha", () => {
    const max = 1_000;
    const headMax = 100;
    const budget = max - headMax - RESERVE;
    // começo sem quebra (corte duro em 100), depois uma quebra e uma linha longa: sai só aquela quebra
    const full = "h".repeat(headMax) + "\n" + "t".repeat(budget + 500);
    const log = appendDeployLog("", full, max, headMax);
    expect(log).toContain(" caracteres e 1 linha omitidos;");
    expect(expectCoherentCut(log, full, max, headMax).omittedLines).toBe(1);
  });
});

describe("crescimento incremental (tempo real)", () => {
  it("pedaços de tamanho variado, cortando linhas ao meio: o teto e a conta valem a cada passo", () => {
    const max = 20_000;
    const headMax = 5_000;
    const source = "=== Etapa 1/5\n" + lines(0, 3_000, 33) + "fim do deploy\n";
    let seed = 7;
    const rnd = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    let log = "";
    let written = "";
    let head: string | null = null;
    let pos = 0;
    while (pos < source.length) {
      const size = 1 + Math.floor(rnd() * 900);
      const chunk = source.slice(pos, pos + size);
      pos += size;
      written += chunk;
      log = appendDeployLog(log, chunk, max, headMax);
      if (written.length <= max) {
        expect(log).toBe(written);
        continue;
      }
      const cut = expectCoherentCut(log, written, max, headMax);
      head ??= cut.head;
      expect(cut.head).toBe(head);
    }
    expect(log.startsWith("=== Etapa 1/5\n")).toBe(true);
    expect(log.endsWith("fim do deploy\n")).toBe(true);
  });

  it("com o teto real e o log relido do disco (JSON) no meio: os contadores continuam somando", () => {
    const full = lines(0, 30_000);
    let log = "";
    let written = "";
    for (let i = 0; i < full.length; i += 8_192) {
      const chunk = full.slice(i, i + 8_192);
      written += chunk;
      log = JSON.parse(JSON.stringify(appendDeployLog(log, chunk))) as string;
    }
    const cut = expectCoherentCut(log, written, DEPLOY_LOG_MAX_CHARS, DEPLOY_LOG_HEAD_CHARS);
    expect(cut.omittedChars).toBeGreaterThan(full.length - DEPLOY_LOG_MAX_CHARS);
  });
});

describe("caracteres multibyte", () => {
  it("acentos e emojis: nenhum corte deixa meio caractere, em qualquer posição", () => {
    // "😀" ocupa 2 unidades UTF-16 (um par substituto) e 4 bytes em UTF-8; sem quebras, todo corte é no meio da linha
    for (const headMax of [300, 301]) {
      for (let extra = 0; extra < 4; extra++) {
        const max = 1_000 + extra;
        const full = "ção".repeat(3) + "😀".repeat(1_500) + "é fim";
        const log = stream(full.match(/[^]{1,97}/gu)!, max, headMax);
        expect(log).not.toMatch(LONE_SURROGATE);
        expect(Buffer.from(log, "utf8").toString("utf8")).toBe(log);
        expectCoherentCut(log, full, max, headMax);
      }
    }
  });

  it("par que chega dividido em dois pedaços é guardado inteiro", () => {
    const max = 1_000;
    const headMax = 200;
    const full = "😀".repeat(800);
    const chunks = full.match(/[^]{1,3}/g)!; // de 3 em 3 unidades: metade de um emoji em cada pedaço
    const log = stream(chunks, max, headMax);
    expect(log).not.toMatch(LONE_SURROGATE);
    expectCoherentCut(log, full, max, headMax);
  });

  it("texto que já chega com uma metade solta não piora nem quebra o corte", () => {
    const max = 1_000;
    const headMax = 200;
    const full = "\uD83D".repeat(2_000) + "fim\n";
    const log = appendDeployLog("", full, max, headMax);
    expectCoherentCut(log, full, max, headMax);
  });
});

describe("leitura da marca", () => {
  it("frase igual à marca escrita pelo próprio build, no começo, é ignorada", () => {
    const max = 5_000;
    const headMax = 1_000;
    const fake = deployLogCutMarker(999_999, 9).slice(1); // o build imprimiu o mesmo texto numa linha
    const full = "início\n" + fake + lines(0, 200);
    const log = appendDeployLog("", full, max, headMax);
    const cut = expectCoherentCut(log, full, max, headMax);
    expect(cut.head.startsWith("início\n" + fake)).toBe(true);
    expect(cut.omittedChars).not.toBe(999_999);
  });

  it("prefixo sem o resto da marca, ou marca depois do espaço do começo: não é corte", () => {
    expect(parseDeployLogCut("a\n" + DEPLOY_LOG_CUT_PREFIX + "qualquer coisa\n")).toBeNull();
    const late = "x".repeat(50) + deployLogCutMarker(10, 1) + "fim\n";
    expect(parseDeployLogCut(late, 20)).toBeNull();
    expect(parseDeployLogCut(late, 50)?.omittedChars).toBe(10);
  });
});
