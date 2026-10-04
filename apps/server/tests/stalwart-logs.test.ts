/**
 * Leitura do registro do container do Stalwart, linha a linha. Sem Docker:
 * o "comando" é o próprio node (ou o echo), imprimindo linhas.
 */
import { describe, expect, it } from "vitest";
import { readStalwartLogs, streamCommandLines } from "../src/services/stalwart-logs.js";

describe("streamCommandLines", () => {
  it("entrega as linhas do stdout e do stderr", async () => {
    const lines: string[] = [];
    await streamCommandLines({
      command: process.execPath,
      args: ["-e", "console.log('um'); console.log('dois'); console.error('tres')"],
      onLine: (l) => lines.push(l),
    });
    expect(lines.sort()).toEqual(["dois", "tres", "um"]);
  });

  it("código diferente de zero vira erro com o fim do stderr", async () => {
    await expect(
      streamCommandLines({
        command: process.execPath,
        args: ["-e", "console.error('Error: No such container: paas-stalwart'); process.exit(1)"],
        onLine: () => {},
      }),
    ).rejects.toThrow("No such container");
  });

  it("código diferente de zero sem stderr: erro com o código", async () => {
    await expect(
      streamCommandLines({ command: process.execPath, args: ["-e", "process.exit(3)"], onLine: () => {} }),
    ).rejects.toThrow("código 3");
  });

  it("comando que não existe: erro", async () => {
    await expect(streamCommandLines({ command: "comando-que-nao-existe-xyz", args: [], onLine: () => {} })).rejects.toThrow();
  });

  it("tempo esgotado: o processo é encerrado", async () => {
    await expect(
      streamCommandLines({ command: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"], onLine: () => {}, timeoutMs: 100 }),
    ).rejects.toThrow();
  });
});

describe("readStalwartLogs", () => {
  it("pede ao docker o registro do container desde a hora informada", async () => {
    const lines: string[] = [];
    await readStalwartLogs(new Date("2026-10-04T12:00:00Z"), (l) => lines.push(l), { command: "echo" });
    expect(lines).toEqual(["logs --since 2026-10-04T12:00:00.000Z paas-stalwart"]);
  });

  it("sem hora: as últimas 720 horas (30 dias)", async () => {
    const lines: string[] = [];
    await readStalwartLogs(null, (l) => lines.push(l), { command: "echo", container: "outro" });
    expect(lines).toEqual(["logs --since 720h outro"]);
  });
});
