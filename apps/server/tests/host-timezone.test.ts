/**
 * host-timezone.test.ts — descobrir o fuso da VPS a partir do /etc/localtime
 * do host (montado em /host/etc/localtime), para os backups rodarem às 03:00
 * no horário da VPS e não no UTC do container.
 */
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TIMEZONE_STATE_FILE,
  applyHostTimezone,
  detectHostTimezone,
  readSavedTimezone,
  rememberStartupTimezone,
  resolveStartupTimezone,
  startupTimezone,
  writeSavedTimezone,
} from "../src/services/host-timezone.js";

let dir: string;
let zoneinfo: string;

function tzif(footer: string, body = "corpo"): Buffer {
  return Buffer.from(`TZif2${body}\n${footer}\n`);
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-tz-"));
  zoneinfo = path.join(dir, "zoneinfo");
  await mkdir(path.join(zoneinfo, "America"), { recursive: true });
  await mkdir(path.join(zoneinfo, "Brazil"), { recursive: true });
  await mkdir(path.join(zoneinfo, "posix", "America"), { recursive: true });
  await writeFile(path.join(zoneinfo, "America", "Sao_Paulo"), tzif("<-03>3", "sp"));
  await writeFile(path.join(zoneinfo, "Brazil", "East"), tzif("<-03>3", "sp"));
  await writeFile(path.join(zoneinfo, "posix", "America", "Sao_Paulo"), tzif("<-03>3", "sp"));
  await writeFile(path.join(zoneinfo, "UTC"), tzif("UTC0", "utc"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("fuso da VPS", () => {
  it("acha o nome do fuso pelo conteúdo do arquivo (prefere o nome canônico)", async () => {
    const host = path.join(dir, "localtime");
    await writeFile(host, tzif("<-03>3", "sp"));
    expect(await detectHostTimezone(host, zoneinfo)).toBe("America/Sao_Paulo");
  });

  it("versão diferente do tzdata: usa o deslocamento fixo do rodapé", async () => {
    const host = path.join(dir, "localtime");
    await writeFile(host, tzif("<-03>3", "outra-versao"));
    expect(await detectHostTimezone(host, zoneinfo)).toBe("Etc/GMT+3");
    await writeFile(host, tzif("<+0530>-5:30", "india"));
    expect(await detectHostTimezone(host, zoneinfo)).toBeNull();
    await writeFile(host, tzif("<+09>-9", "japao"));
    expect(await detectHostTimezone(host, zoneinfo)).toBe("Etc/GMT-9");
    await writeFile(host, tzif("UTC0", "x"));
    expect(await detectHostTimezone(host, zoneinfo)).toBe("UTC");
  });

  it("horário de verão sem arquivo igual, arquivo ausente ou estranho: não chuta", async () => {
    const host = path.join(dir, "localtime");
    await writeFile(host, tzif("WET0WEST,M3.5.0/1,M10.5.0", "lisboa"));
    expect(await detectHostTimezone(host, zoneinfo)).toBeNull();
    await writeFile(host, "não é tzif");
    expect(await detectHostTimezone(host, zoneinfo)).toBeNull();
    expect(await detectHostTimezone(path.join(dir, "nao-existe"), zoneinfo)).toBeNull();
    expect(await detectHostTimezone(path.join(dir, "nao-existe"), path.join(dir, "sem-zoneinfo"))).toBeNull();
  });

  it("arquivo da base que não abre é pulado", async () => {
    const host = path.join(dir, "localtime");
    await writeFile(host, tzif("<-03>3", "sp"));
    const blocked = path.join(zoneinfo, "America", "Araguaina");
    await writeFile(blocked, tzif("<-03>3", "outro"));
    await chmod(blocked, 0o000);
    try {
      expect(await detectHostTimezone(host, zoneinfo)).toBe("America/Sao_Paulo");
    } finally {
      await chmod(blocked, 0o600);
    }
  });

  it("aplica em TZ só quando ninguém definiu antes", async () => {
    const host = path.join(dir, "localtime");
    await writeFile(host, tzif("<-03>3", "sp"));
    const env: NodeJS.ProcessEnv = {};
    expect(await applyHostTimezone(env, host, zoneinfo)).toBe("America/Sao_Paulo");
    expect(env.TZ).toBe("America/Sao_Paulo");
    const fixed: NodeJS.ProcessEnv = { TZ: "Europe/Lisbon" };
    expect(await applyHostTimezone(fixed, host, zoneinfo)).toBe("Europe/Lisbon");
    expect(fixed.TZ).toBe("Europe/Lisbon");
    const none: NodeJS.ProcessEnv = {};
    expect(await applyHostTimezone(none, path.join(dir, "nao-existe"), zoneinfo)).toBeNull();
    expect(none.TZ).toBeUndefined();
  });
});

describe("fuso na subida do painel", () => {
  it("ordem: TZ do .env, o último lido da VPS, o /etc/localtime montado, nada", async () => {
    const host = path.join(dir, "localtime");
    await writeFile(host, tzif("<-03>3", "sp"));
    const fromEnv: NodeJS.ProcessEnv = { TZ: "Europe/Lisbon" };
    expect(await resolveStartupTimezone({ dataDir: dir, env: fromEnv, localtime: host, zoneinfo })).toEqual({
      zone: "Europe/Lisbon",
      source: "env",
      envOverride: "Europe/Lisbon",
    });

    const fromMount: NodeJS.ProcessEnv = { TZ: "" };
    expect(await resolveStartupTimezone({ dataDir: dir, env: fromMount, localtime: host, zoneinfo })).toEqual({
      zone: "America/Sao_Paulo",
      source: "localtime",
      envOverride: null,
    });
    expect(fromMount.TZ).toBe("America/Sao_Paulo");

    // a montagem congelada diz São Paulo, mas a VPS (lida pelo host bridge) está em Berlim
    await writeSavedTimezone(dir, { zone: "Europe/Berlin", readAt: "2026-10-15T12:00:00.000Z" });
    expect((await stat(path.join(dir, TIMEZONE_STATE_FILE))).mode & 0o777).toBe(0o600);
    const fromSaved: NodeJS.ProcessEnv = {};
    expect(await resolveStartupTimezone({ dataDir: dir, env: fromSaved, localtime: host, zoneinfo })).toEqual({
      zone: "Europe/Berlin",
      source: "saved",
      envOverride: null,
    });
    expect(fromSaved.TZ).toBe("Europe/Berlin");

    const none: NodeJS.ProcessEnv = {};
    const empty = await mkdtemp(path.join(tmpdir(), "paas-tz-vazio-"));
    expect(await resolveStartupTimezone({ dataDir: empty, env: none, localtime: path.join(dir, "nao-existe"), zoneinfo })).toEqual({
      zone: null,
      source: "default",
      envOverride: null,
    });
    expect(none.TZ).toBeUndefined();
    await rm(empty, { recursive: true, force: true });
  });

  it("arquivo guardado estragado ou com nome inseguro é ignorado; sem data vira 1970", async () => {
    const file = path.join(dir, TIMEZONE_STATE_FILE);
    await writeFile(file, "{ não é json");
    expect(await readSavedTimezone(dir)).toBeNull();
    await writeFile(file, JSON.stringify({ zone: "Europe/Berlin'; reboot" }));
    expect(await readSavedTimezone(dir)).toBeNull();
    await writeFile(file, JSON.stringify({ zone: "America/Recife" }));
    expect(await readSavedTimezone(dir)).toEqual({ zone: "America/Recife", readAt: new Date(0).toISOString() });
  });

  it("guarda o que a subida decidiu; sem subida, usa o TZ do ambiente", () => {
    expect(startupTimezone({ TZ: "Asia/Tokyo" })).toEqual({ zone: "Asia/Tokyo", source: "env", envOverride: "Asia/Tokyo" });
    expect(startupTimezone({})).toEqual({ zone: null, source: "default", envOverride: null });
    rememberStartupTimezone({ zone: "Europe/Berlin", source: "saved", envOverride: null });
    expect(startupTimezone({ TZ: "Asia/Tokyo" })).toEqual({ zone: "Europe/Berlin", source: "saved", envOverride: null });
  });
});
