/**
 * host-timezone.test.ts — descobrir o fuso da VPS a partir do /etc/localtime
 * do host (montado em /host/etc/localtime), para os backups rodarem às 03:00
 * no horário da VPS e não no UTC do container.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyHostTimezone, detectHostTimezone } from "../src/services/host-timezone.js";

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
