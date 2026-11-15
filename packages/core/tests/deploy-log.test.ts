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
  DEPLOY_LOG_TRIM_SLACK,
  deployLogAppender,
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

type Writer = "com estado" | "sem estado";
const WRITERS: Writer[] = ["com estado", "sem estado"];

/**
 * Escreve `chunks` um a um, como o deploy faz: "com estado" é o escritor do job (deployLogAppender, o caminho normal);
 * "sem estado" procura a marca no texto a cada passo (appendDeployLog, o mesmo caminho do log relido do disco).
 * Devolve o log e o maior tamanho que ele teve.
 */
function stream(chunks: string[], max?: number, headMax?: number, writer: Writer = "com estado"): string {
  return streamMax(chunks, max, headMax, writer).log;
}
function streamMax(chunks: string[], max?: number, headMax?: number, writer: Writer = "com estado") {
  const append = writer === "com estado" ? deployLogAppender({ max, headMax }) : (l: string, c: string) => appendDeployLog(l, c, max, headMax);
  let log = "";
  let maxLen = 0;
  for (const c of chunks) {
    log = append(log, c);
    maxLen = Math.max(maxLen, log.length);
  }
  return { log, maxLen };
}
const pieces = (text: string, size: number) => text.match(new RegExp(`[^]{1,${size}}`, "g"))!;

/** O começo que o corte escolhe para `full`: até a última quebra de linha dentro do espaço do começo. */
const expectedHead = (full: string, headMax: number) => full.slice(0, full.lastIndexOf("\n", headMax - 1) + 1);

/**
 * Confere o log contra o que foi escrito sabendo onde o começo termina (sem depender da leitura da marca no texto):
 * uma marca só, logo depois do começo, com a conta exata.
 */
function expectCutAfter(log: string, full: string, max: number, head: string) {
  expect(log.length).toBeLessThanOrEqual(max);
  expect(log.startsWith(head)).toBe(true);
  const m = /^\n\[… log cortado no meio: (\d+) caracteres e (\d+) linhas? omitidos; o começo e o fim foram guardados …\]\n/.exec(log.slice(head.length))!;
  expect(m).not.toBeNull();
  const tail = log.slice(head.length + m[0].length);
  expect(full.endsWith(tail)).toBe(true);
  expect(head.length + Number(m[1]) + tail.length).toBe(full.length);
  expect(Number(m[2])).toBe(countLines(full.slice(head.length, full.length - tail.length)));
  return { tail, omittedChars: Number(m[1]) };
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
    // divisão: o começo usa até 1/4 do teto; o fim fica com o resto, menos a folga que os próximos pedaços ocupam
    expect(cut.head.length).toBeGreaterThan(DEPLOY_LOG_HEAD_CHARS - 41);
    expect(cut.tail.length).toBeGreaterThan(DEPLOY_LOG_MAX_CHARS - DEPLOY_LOG_HEAD_CHARS - RESERVE - DEPLOY_LOG_TRIM_SLACK - 41);
    expect(log.length).toBeGreaterThan(DEPLOY_LOG_MAX_CHARS - DEPLOY_LOG_TRIM_SLACK - 82);
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
    const room = max - cut.head.length - RESERVE;
    expect(cut.tail.length).toBe(room - Math.floor(room / 8)); // folga de 1/8 num limite pequeno
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
  it.each(WRITERS)("pedaços de tamanho variado, cortando linhas ao meio (%s): o teto e a conta valem a cada passo", (writer) => {
    const max = 20_000;
    const headMax = 5_000;
    const source = "=== Etapa 1/5\n" + lines(0, 3_000, 33) + "fim do deploy\n";
    let seed = 7;
    const rnd = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    const append = writer === "com estado" ? deployLogAppender({ max, headMax }) : (l: string, c: string) => appendDeployLog(l, c, max, headMax);
    let log = "";
    let written = "";
    let head: string | null = null;
    let pos = 0;
    while (pos < source.length) {
      const size = 1 + Math.floor(rnd() * 900);
      const chunk = source.slice(pos, pos + size);
      pos += size;
      written += chunk;
      log = append(log, chunk);
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

  it("com o teto real e o log relido do disco (JSON) a cada pedaço, como depois de um reinício: os contadores continuam somando", () => {
    const full = lines(0, 30_000);
    let log = "";
    let written = "";
    for (let i = 0; i < full.length; i += 8_192) {
      const chunk = full.slice(i, i + 8_192);
      written += chunk;
      log = JSON.parse(JSON.stringify(deployLogAppender({ resumed: true })(log, chunk))) as string;
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

describe("frase igual à marca escrita pelo próprio build", () => {
  const fake = deployLogCutMarker(999_999, 9).slice(1); // o build imprimiu o mesmo texto numa linha

  it.each(WRITERS)("no começo, antes do primeiro corte, pedaço a pedaço (%s): o começo é o de sempre", (writer) => {
    const max = 5_000;
    const headMax = 1_000;
    const full = "=== Etapa 1/5 · Ingestão\nGuardrails ok\n" + fake + lines(0, 200);
    const log = stream(pieces(full, 100), max, headMax, writer);
    const head = expectedHead(full, headMax);
    expect(head.length).toBeGreaterThan(headMax - 41);
    expect(head).toContain(fake);
    expectCutAfter(log, full, max, head);
    // a leitura do texto (tela, disco) acha a marca de verdade, não a frase
    expect(parseDeployLogCut(log, headMax)!.head).toBe(head);
  });

  it.each(WRITERS)("no fim, depois do corte, com o começo curto por causa de uma linha comprida (%s): uma marca só", (writer) => {
    const max = 5_000;
    const headMax = 1_000;
    const full = "inicio\n" + "L".repeat(2_000) + "\n" + lines(0, 100) + fake + lines(100, 300);
    let log = "";
    const append = writer === "com estado" ? deployLogAppender({ max, headMax }) : (l: string, c: string) => appendDeployLog(l, c, max, headMax);
    let written = "";
    for (const c of pieces(full, 50)) {
      log = append(log, c);
      written += c;
      if (written.length > max) expectCutAfter(log, written, max, "inicio\n");
    }
    expect(log.split("log cortado no meio").length - 1).toBe(1);
    expect(parseDeployLogCut(log, headMax)!.head).toBe("inicio\n");
  });

  it("com linha em branco antes da frase: o escritor do job não se engana (ele não lê o texto)", () => {
    const max = 5_000;
    const headMax = 1_000;
    const full = "início\n\n" + fake + lines(0, 200);
    const log = stream(pieces(full, 64), max, headMax);
    expectCutAfter(log, full, max, expectedHead(full, headMax));
  });

  it.each(WRITERS)("contadores com 17 ou mais dígitos na frase (%s): o log nunca passa do teto e nada vira notação científica", (writer) => {
    const max = 5_000;
    const headMax = 1_000;
    for (const digits of [17, 20, 25]) {
      const n = "9".repeat(digits);
      const big = `[… log cortado no meio: ${n} caracteres e ${n} linhas omitidos; o começo e o fim foram guardados …]\n`;
      for (const full of ["a\n" + big + lines(0, 200), "a\n\n" + big + lines(0, 200)]) {
        const { log, maxLen } = streamMax(pieces(full, 100), max, headMax, writer);
        expect(maxLen).toBeLessThanOrEqual(max);
        expect(log).not.toMatch(/\de\+\d/);
        expectCutAfter(log, full, max, expectedHead(full, headMax));
      }
    }
  });
});

describe("leitura da marca no texto", () => {
  it("prefixo sem o resto da marca, ou marca depois do espaço do começo: não é corte", () => {
    expect(parseDeployLogCut("a\n" + DEPLOY_LOG_CUT_PREFIX + "qualquer coisa\n")).toBeNull();
    const late = "x".repeat(50) + deployLogCutMarker(10, 1) + "fim\n";
    expect(parseDeployLogCut(late, 20)).toBeNull();
    expect(parseDeployLogCut(late, 50)?.omittedChars).toBe(10);
    expect(parseDeployLogCut(late, 51)?.omittedChars).toBe(10); // teto do começo no meio de um emoji: um a menos
    expect(parseDeployLogCut(late, 52)).toBeNull();
  });

  it("a última candidata não serve: vale a anterior", () => {
    const real = "começo\n" + deployLogCutMarker(500, 20);
    // depois da marca de verdade: uma frase colada numa linha comum, outra com contador acima do inteiro seguro
    const unsafe = deployLogCutMarker(1, 1).replace("1 caracteres", "9999999999999999 caracteres"); // 16 dígitos, acima do inteiro seguro
    const log = real + "fim 1" + deployLogCutMarker(7, 7) + "\n" + unsafe + "fim\n";
    const cut = parseDeployLogCut(log)!;
    expect(cut.head).toBe("começo\n");
    expect(cut.omittedChars).toBe(500);
  });

  it("marca com contador acima do inteiro seguro fica no maior inteiro seguro (tamanho conhecido)", () => {
    expect(deployLogCutMarker(1e25, 1e25)).toBe(deployLogCutMarker(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER));
    expect(deployLogCutMarker(1e25, 1e25).length).toBe(RESERVE);
  });
});

describe("escritor do job", () => {
  it("log mexido por fora entre um pedaço e outro: volta a ler a marca do texto", () => {
    const max = 3_000;
    const headMax = 500;
    const append = deployLogAppender({ max, headMax });
    let log = append("", lines(0, 100));
    const before = parseDeployLogCut(log, headMax)!;
    log = JSON.parse(JSON.stringify(log)) as string; // mesmo conteúdo, outro texto (como relido do disco)
    log = append(log + "nota\n", lines(100, 10));
    const after = parseDeployLogCut(log, headMax)!;
    expect(after.head).toBe(before.head);
    expect(after.omittedChars).toBeGreaterThan(before.omittedChars);
    expect(log.endsWith(lines(100, 10))).toBe(true);
  });

  it("retomado do disco com o log já cortado: a nota entra na folga; o que passar soma aos contadores da marca", () => {
    const max = 3_000;
    const headMax = 500;
    const cutLog = appendDeployLog("", lines(0, 100), max, headMax);
    const first = parseDeployLogCut(cutLog, headMax)!;
    const note = "\n✖ Deploy interrompido pelo reinício do painel\n";
    const append = deployLogAppender({ resumed: true, max, headMax });
    const withNote = append(cutLog, note);
    expect(withNote).toBe(cutLog + note); // coube na folga: só concatenou
    const log = append(withNote, lines(100, 20));
    const cut = parseDeployLogCut(log, headMax)!;
    expect(cut.head).toBe(first.head);
    expect(cut.omittedChars).toBeGreaterThan(first.omittedChars);
    expect(log.endsWith(lines(100, 20))).toBe(true);
    expect(log.length).toBeLessThanOrEqual(max);
    expect(cut.head.length + cut.omittedChars + cut.tail.length).toBe(lines(0, 100).length + note.length + lines(100, 20).length);
  });
});
