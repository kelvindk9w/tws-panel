import { describe, expect, it } from "vitest";
import {
  BRAZIL_TIMEZONES,
  BRAZIL_TIMEZONE_PLACES,
  IANA_ZONE_NAMES,
  effectiveProjectZone,
  formatUtcOffset,
  isKnownTimezone,
  isSafeTimezoneName,
  timezoneChoices,
  timezoneOffsetMinutes,
  timezoneOptions,
} from "../src/index";

describe("nomes de fuso", () => {
  it("lista do Brasil na ordem pedida, todos na base IANA e com o lugar", () => {
    expect(BRAZIL_TIMEZONES[0]).toBe("America/Sao_Paulo");
    expect(BRAZIL_TIMEZONES).toHaveLength(15);
    for (const z of BRAZIL_TIMEZONES) {
      expect(IANA_ZONE_NAMES).toContain(z);
      expect(BRAZIL_TIMEZONE_PLACES[z]).toBeTruthy();
    }
  });

  it("aceita só nomes da lista (nada de texto livre)", () => {
    expect(isKnownTimezone("America/Sao_Paulo")).toBe(true);
    expect(isKnownTimezone("America/Argentina/Buenos_Aires")).toBe(true);
    expect(isKnownTimezone("UTC")).toBe(true);
    expect(isKnownTimezone("Etc/UTC")).toBe(true);
    expect(isKnownTimezone("Asia/Kolkata")).toBe(true);
    // nome antigo: no Ubuntu 24.04 só existe com tzdata-legacy
    expect(isKnownTimezone("Asia/Calcutta")).toBe(false);
    expect(isKnownTimezone("America/Sao_Paulo; rm -rf /")).toBe(false);
    expect(isKnownTimezone("../../etc/passwd")).toBe(false);
    expect(isKnownTimezone("")).toBe(false);
  });

  it("formato seguro para nomes lidos do host", () => {
    expect(isSafeTimezoneName("Europe/Berlin")).toBe(true);
    expect(isSafeTimezoneName("Etc/GMT+3")).toBe(true);
    expect(isSafeTimezoneName("America/North_Dakota/New_Salem")).toBe(true);
    expect(isSafeTimezoneName("UTC")).toBe(true);
    expect(isSafeTimezoneName("Europe/Berlin'")).toBe(false);
    expect(isSafeTimezoneName("Europe/Ber lin")).toBe(false);
    expect(isSafeTimezoneName("/usr/share/zoneinfo/UTC")).toBe(false);
    expect(isSafeTimezoneName("a/b/c/d")).toBe(false);
  });

  it("ordem do seletor: Brasil, UTC e o resto em ordem alfabética, sem repetir", () => {
    const list = timezoneChoices();
    expect(list.slice(0, 15)).toEqual([...BRAZIL_TIMEZONES]);
    expect(list[15]).toBe("UTC");
    const rest = list.slice(16);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)));
    expect(new Set(list).size).toBe(list.length);
    expect(rest).not.toContain("America/Sao_Paulo");
  });
});

describe("deslocamento", () => {
  const winter = new Date("2026-07-01T12:00:00Z");
  it("calcula o deslocamento no instante pedido", () => {
    expect(timezoneOffsetMinutes("America/Sao_Paulo", winter)).toBe(-180);
    expect(timezoneOffsetMinutes("Europe/Berlin", winter)).toBe(120);
    expect(timezoneOffsetMinutes("Asia/Kolkata", winter)).toBe(330);
    expect(timezoneOffsetMinutes("UTC", winter)).toBe(0);
    expect(timezoneOffsetMinutes("Nao/Existe", winter)).toBeNull();
  });

  it("formata como UTC−3, UTC+5:30 e UTC", () => {
    expect(formatUtcOffset(-180)).toBe("UTC−3");
    expect(formatUtcOffset(330)).toBe("UTC+5:30");
    expect(formatUtcOffset(-570)).toBe("UTC−9:30");
    expect(formatUtcOffset(0)).toBe("UTC");
  });

  it("opções do seletor com deslocamento e lugar", () => {
    const opts = timezoneOptions(winter);
    expect(opts[0]).toEqual({
      zone: "America/Sao_Paulo",
      offset: "UTC−3",
      place: BRAZIL_TIMEZONE_PLACES["America/Sao_Paulo"],
      brazil: true,
    });
    const berlin = opts.find((o) => o.zone === "Europe/Berlin")!;
    expect(berlin).toEqual({ zone: "Europe/Berlin", offset: "UTC+2", place: null, brazil: false });
    expect(timezoneOptions().length).toBe(opts.length);
  });
});

describe("fuso do projeto", () => {
  it("padrão da imagem não injeta; igual ao da VPS acompanha; específico usa o escolhido", () => {
    expect(effectiveProjectZone(undefined, "America/Sao_Paulo")).toBeNull();
    expect(effectiveProjectZone({ mode: "image" }, "America/Sao_Paulo")).toBeNull();
    expect(effectiveProjectZone({ mode: "host" }, "America/Manaus")).toBe("America/Manaus");
    expect(effectiveProjectZone({ mode: "zone", zone: "Europe/Lisbon" }, "UTC")).toBe("Europe/Lisbon");
    expect(effectiveProjectZone({ mode: "zone" }, "UTC")).toBeNull();
  });
});
