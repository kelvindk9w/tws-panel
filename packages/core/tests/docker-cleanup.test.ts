import { describe, expect, it } from "vitest";
import { DOCKER_CLEANUP_DEFAULTS, dockerCleanupWarns, validateDockerCleanupSettings, type DockerCleanupScan } from "../src/docker-cleanup";

const GB = 1024 ** 3;
const scan = (total: number, usedPercent: number | null): DockerCleanupScan => ({
  scannedAt: "2026-11-05T12:00:00Z",
  minAgeDays: 7,
  buildCache: { bytes: 0, entries: 0, totalBytes: 0 },
  images: { bytes: 0, candidates: [], protected: [] },
  totalBytes: total,
  totalPercentOfDisk: null,
  disk: usedPercent === null ? null : { totalBytes: 100 * GB, usedBytes: usedPercent * GB, usedPercent },
});

describe("configuração da limpeza do Docker", () => {
  it("o padrão é desligada, semanal, 7 dias, sem gatilho por disco", () => {
    expect(DOCKER_CLEANUP_DEFAULTS).toMatchObject({ enabled: false, frequency: "weekly", minAgeDays: 7, diskTriggerPercent: null, warnGainGb: 10, warnDiskPercent: 80 });
  });

  it("completa o que falta com o padrão e aceita o gatilho por disco", () => {
    expect(validateDockerCleanupSettings({})).toEqual({ ok: true, value: DOCKER_CLEANUP_DEFAULTS });
    expect(validateDockerCleanupSettings({ enabled: true, frequency: "daily", diskTriggerPercent: 90 })).toMatchObject({ ok: true, value: { enabled: true, frequency: "daily", diskTriggerPercent: 90 } });
    expect(validateDockerCleanupSettings({ diskTriggerPercent: null })).toMatchObject({ ok: true, value: { diskTriggerPercent: null } });
  });

  it("recusa o que está fora dos limites ou do tipo", () => {
    const bad: unknown[] = [null, "x", [], { enabled: "sim" }, { frequency: "hourly" }, { frequency: 3 }, { minAgeDays: 0 }, { minAgeDays: 366 }, { minAgeDays: 1.5 }, { diskTriggerPercent: 10 }, { diskTriggerPercent: "90" }, { warnGainGb: 0 }, { warnDiskPercent: 100 }];
    for (const b of bad) expect(validateDockerCleanupSettings(b), JSON.stringify(b)).toEqual({ ok: false });
  });
});

describe("aviso da limpeza do Docker", () => {
  const w = { warnGainGb: 10, warnDiskPercent: 80 };
  it("avisa por ganho grande, ou por disco cheio quando há o que limpar", () => {
    expect(dockerCleanupWarns(null, w)).toBe(false);
    expect(dockerCleanupWarns(scan(0, 95), w)).toBe(false);
    expect(dockerCleanupWarns(scan(10 * GB, 10), w)).toBe(true);
    expect(dockerCleanupWarns(scan(9 * GB, 10), w)).toBe(false);
    expect(dockerCleanupWarns(scan(GB, 80), w)).toBe(true);
    expect(dockerCleanupWarns(scan(GB, 79), w)).toBe(false);
    expect(dockerCleanupWarns(scan(GB, null), w)).toBe(false);
  });
});
