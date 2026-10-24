/**
 * log-mask-cut.test.ts — nenhum caminho de corte pode deixar pedaço de segredo:
 * ANSI/controle saem ANTES do corte cru (8000), o corte final (2000) vem
 * depois da máscara, e quando a linha crua foi cortada a ponta do texto
 * (possível começo de segredo) é descartada.
 */
import { describe, expect, it } from "vitest";
import type { DockerContainerInfo } from "@paas/core";
import { LOG_LINE_MAX, LOG_MASK, buildLogMasker, cleanLogText, stripLogControl } from "../src/services/log-mask.js";
import { ProjectLogsService, RAW_LINE_MAX } from "../src/services/project-logs.js";

const SECRET = "Qz9#kLm2-Segredo-Longo-77";

function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

const ctr: DockerContainerInfo = {
  id: "0123456789ab",
  name: "paas-a-web-1",
  image: "i",
  state: "running",
  status: "Up",
  managed: true,
  projectSlug: "a",
  composeProject: "paas-a",
  service: "web",
  health: null,
  ports: [],
};

async function lineOut(line: string): Promise<string> {
  const svc = new ProjectLogsService({
    listContainers: async () => [ctr],
    inspect: async () => ({ state: "running", health: null, restartCount: 0, startedAt: null, finishedAt: null, exitCode: 0, tty: false }),
    logs: async () => ({ ok: true, body: frame(`2026-10-24T11:00:00Z ${line}\n`) }),
    now: () => Date.parse("2026-10-24T12:00:00Z"),
  });
  return (await svc.read({ slug: "a" }, {}, [SECRET])).lines[0]!.text;
}

describe("stripLogControl", () => {
  it("tira ANSI, controle e \\r final; mantém tab", () => {
    expect(stripLogControl("\u001b[31mA\u001b[0m\tB\u0000\u0007\r")).toBe("A\tB");
  });
});

describe("corte cru depois de limpar ANSI/controle (caso do revisor)", () => {
  it("6400 caracteres de ANSI ou NUL antes do segredo na posição ~7988: nada do começo do segredo aparece", async () => {
    for (const pad of ["\u001b[0m".repeat(1600), "\u0000".repeat(6400)]) {
      const line = pad + "x".repeat(8000 - pad.length - 12) + SECRET;
      const out = await lineOut(line);
      expect(out).not.toContain(SECRET.slice(0, 4));
    }
  });

  it("varredura de posições: o segredo começando antes, na e depois da fronteira de 8000, com e sem ANSI, nunca deixa o começo dele", async () => {
    for (const ansi of [0, 1600]) {
      const pad = "\u001b[0m".repeat(ansi);
      for (let start = RAW_LINE_MAX - 40; start <= RAW_LINE_MAX + 5; start += 3) {
        const filler = "x".repeat(start);
        const out = await lineOut(pad + filler + SECRET);
        expect(out, `ansi=${ansi} start=${start}`).not.toContain("Qz9#");
        expect(out.length).toBeLessThanOrEqual(LOG_LINE_MAX + 1);
      }
    }
  });
});

describe("o corte cru conta o que sobra depois de limpar", () => {
  it("6400 caracteres de ANSI não gastam o espaço do texto: a linha limpa de 3000 caracteres não é considerada cortada", async () => {
    const pad = "\u001b[0m".repeat(1600);
    const out = await lineOut(pad + "ab ".repeat(1000));
    // sem corte cru: só o corte final de 2000 (com reticências); com o corte antes da limpeza sairiam ~1600
    expect(out.length).toBe(LOG_LINE_MAX + 1);
  });
});

describe("ponta da linha cortada", () => {
  it("segredo com espaços: o começo dele no fim do texto cortado também é descartado", () => {
    const multi = "minha senha longa demais";
    const m = buildLogMasker([multi]);
    const out = cleanLogText("inicio da linha minha senha lo", m, true);
    expect(out).not.toContain("minha senha");
  });

  const mask = buildLogMasker([SECRET]);

  it("com corte, o começo do segredo no fim do texto é descartado (todos os tamanhos de prefixo)", () => {
    for (let k = 1; k < SECRET.length; k++) {
      const out = cleanLogText(`inicio ${SECRET.slice(0, k)}`, mask, true);
      expect(out, `prefixo de ${k}`).not.toContain(SECRET.slice(0, Math.min(k, 4)));
    }
  });

  it("sem corte, texto igual ao do segredo parcial no fim é mantido (não é segredo)", () => {
    expect(cleanLogText("inicio Qz9#", mask, false)).toBe("inicio Qz9#");
  });

  it("com corte, uma palavra/URL partida no fim (senha em URL sem o @) é descartada", () => {
    expect(cleanLogText("conectando postgres://u:SenhaParcial", buildLogMasker([]), true)).toBe("conectando …");
  });

  it("com corte e sem segredos, só a última palavra é descartada", () => {
    expect(cleanLogText("uma linha com Bearer abc", buildLogMasker([]), true)).toBe("uma linha com Bearer …");
  });

  it("com corte, texto com segredo inteiro no meio continua mascarado", () => {
    const out = cleanLogText(`${"palavra ".repeat(40)}${SECRET} ${"resto ".repeat(40)}fim`, mask, true);
    expect(out).toContain(LOG_MASK);
    expect(out).not.toContain(SECRET);
    expect(out.endsWith("…")).toBe(true);
  });

  it("segredo muito grande: com corte, a linha inteira pode ser descartada, nunca vazada", () => {
    const big = "S".repeat(5000);
    const m = buildLogMasker([big]);
    const out = cleanLogText("a " + big.slice(0, 4999), m, true);
    expect(out).not.toContain("SSSS");
  });
});
