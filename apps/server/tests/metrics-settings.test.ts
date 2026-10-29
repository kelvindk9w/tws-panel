import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { METRICS_RETENTION_DEFAULT } from "@paas/core";
import { MetricsSettings } from "../src/services/metrics-settings.js";
import { removeDir } from "./helpers/tmp.js";

let dir: string;
const file = () => path.join(dir, "metrics-settings.json");
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-metrics-settings-"));
});
afterEach(async () => {
  await chmod(dir, 0o700).catch(() => undefined);
  await removeDir(dir);
});

describe("retenção escolhida", () => {
  it("sem arquivo: o padrão (48 h, 90 dias, 2 anos), sem criar nada", async () => {
    const s = new MetricsSettings(dir);
    expect(s.current()).toEqual(METRICS_RETENTION_DEFAULT);
    expect(await s.load()).toEqual(METRICS_RETENTION_DEFAULT);
    expect(await readdir(dir)).toEqual([]);
  });

  it("grava e um processo novo lê o mesmo; current() muda na hora", async () => {
    const s = new MetricsSettings(dir);
    expect(await s.set({ minuteHours: 72, hourDays: 30, dayDays: 365 })).toEqual({ minuteHours: 72, hourDays: 30, dayDays: 365 });
    expect(s.current().minuteHours).toBe(72);
    expect(await new MetricsSettings(dir).load()).toEqual({ minuteHours: 72, hourDays: 30, dayDays: 365 });
    expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({ retention: { minuteHours: 72, hourDays: 30, dayDays: 365 } });
  });

  it("só os três campos são gravados (campo a mais não vai ao disco)", async () => {
    const s = new MetricsSettings(dir);
    await s.set({ minuteHours: 48, hourDays: 90, dayDays: 730, extra: 1 } as never);
    expect(Object.keys(JSON.parse(await readFile(file(), "utf8")).retention).sort()).toEqual(["dayDays", "hourDays", "minuteHours"]);
  });

  it("arquivo com valores fora dos limites ou de outra forma: padrão, e o arquivo ruim é guardado à parte ao gravar", async () => {
    for (const bad of ['{"retention":{"minuteHours":1,"hourDays":90,"dayDays":730}}', "lixo", "[]", "null", '{"retention":{"minuteHours":48,"hourDays":365,"dayDays":90}}']) {
      await writeFile(file(), bad);
      expect(await new MetricsSettings(dir).load()).toEqual(METRICS_RETENTION_DEFAULT);
    }
    const s = new MetricsSettings(dir);
    await s.set({ minuteHours: 24, hourDays: 7, dayDays: 90 });
    expect((await readdir(dir)).some((n) => n.startsWith("metrics-settings.json.corrompido-"))).toBe(true);
  });

  it("falha ao gravar lança e a memória fica como estava", async () => {
    const s = new MetricsSettings(path.join(dir, "nao-existe", "\0ruim"));
    await expect(s.set({ minuteHours: 24, hourDays: 7, dayDays: 90 })).rejects.toThrow();
    expect(s.current()).toEqual(METRICS_RETENTION_DEFAULT);
  });

  it("erro de leitura (não é 'não existe') mantém o último valor conhecido", async () => {
    const s = new MetricsSettings(dir);
    await s.set({ minuteHours: 72, hourDays: 30, dayDays: 365 });
    await rm(file());
    await writeFile(path.join(dir, "x"), "");
    // um diretório no lugar do arquivo faz a leitura falhar com EISDIR
    const { mkdir } = await import("node:fs/promises");
    await mkdir(file());
    expect(await s.load()).toEqual({ minuteHours: 72, hourDays: 30, dayDays: 365 });
  });
});
