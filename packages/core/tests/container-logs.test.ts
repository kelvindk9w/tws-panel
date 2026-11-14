import { afterEach, describe, expect, it } from "vitest";
import {
  CONTAINER_LOG_DEFAULTS,
  composeLogging,
  containerLogLimits,
  containerLogLimitsIssues,
  dockerApiLogConfig,
  dockerLogArgs,
  hasContainerLogLimits,
  isUnboundedLogConfig,
} from "../src/index";

describe("containerLogLimits: PAAS_LOG_MAX_SIZE / PAAS_LOG_MAX_FILE", () => {
  it("sem nada = o padrão seguro (10m x 3)", () => {
    expect(containerLogLimits({})).toEqual({ maxSize: "10m", maxFile: 3 });
    expect(CONTAINER_LOG_DEFAULTS).toEqual({ maxSize: "10m", maxFile: 3 });
  });

  it("valores válidos valem (maiúsculas e espaços aceitos)", () => {
    expect(containerLogLimits({ PAAS_LOG_MAX_SIZE: " 50M ", PAAS_LOG_MAX_FILE: "5" })).toEqual({ maxSize: "50m", maxFile: 5 });
    expect(containerLogLimits({ PAAS_LOG_MAX_SIZE: "1g", PAAS_LOG_MAX_FILE: "20" })).toEqual({ maxSize: "1g", maxFile: 20 });
    expect(containerLogLimits({ PAAS_LOG_MAX_SIZE: "500k", PAAS_LOG_MAX_FILE: "1" })).toEqual({ maxSize: "500k", maxFile: 1 });
  });

  it("off desliga (o painel não declara limite)", () => {
    expect(containerLogLimits({ PAAS_LOG_MAX_SIZE: "OFF" })).toBeNull();
  });

  it("valor inválido cai no padrão e vira aviso", () => {
    const env = { PAAS_LOG_MAX_SIZE: "10mb", PAAS_LOG_MAX_FILE: "0" };
    expect(containerLogLimits(env)).toEqual(CONTAINER_LOG_DEFAULTS);
    const issues = containerLogLimitsIssues(env);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain('PAAS_LOG_MAX_SIZE="10mb"');
    expect(issues[1]).toContain('PAAS_LOG_MAX_FILE="0"');
    for (const bad of ["0m", "10", "-1m", "1234567m"]) expect(containerLogLimits({ PAAS_LOG_MAX_SIZE: bad })?.maxSize).toBe("10m");
    for (const bad of ["21", "abc", "3.5", "100"]) expect(containerLogLimits({ PAAS_LOG_MAX_FILE: bad })?.maxFile).toBe(3);
  });

  it("sem aviso para vazio, off e valores válidos", () => {
    expect(containerLogLimitsIssues({})).toEqual([]);
    expect(containerLogLimitsIssues({ PAAS_LOG_MAX_SIZE: "off", PAAS_LOG_MAX_FILE: "" })).toEqual([]);
    expect(containerLogLimitsIssues({ PAAS_LOG_MAX_SIZE: "20m", PAAS_LOG_MAX_FILE: "4" })).toEqual([]);
  });
});

describe("formatos do limite (docker run, compose, API)", () => {
  const limits = { maxSize: "10m", maxFile: 3 };

  it("docker run/create: json-file com max-size e max-file", () => {
    expect(dockerLogArgs(limits)).toEqual(["--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=3"]);
    expect(dockerLogArgs(null)).toEqual([]);
  });

  it("compose: bloco logging", () => {
    expect(composeLogging(limits)).toEqual({ driver: "json-file", options: { "max-size": "10m", "max-file": "3" } });
    expect(composeLogging(null)).toBeNull();
  });

  it("API do Docker: HostConfig.LogConfig", () => {
    expect(dockerApiLogConfig(limits)).toEqual({ Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } });
    expect(dockerApiLogConfig(null)).toBeUndefined();
  });

  describe("sem argumento: lê o ambiente do processo", () => {
    const saved = { size: process.env.PAAS_LOG_MAX_SIZE, file: process.env.PAAS_LOG_MAX_FILE };
    afterEach(() => {
      if (saved.size === undefined) delete process.env.PAAS_LOG_MAX_SIZE;
      else process.env.PAAS_LOG_MAX_SIZE = saved.size;
      if (saved.file === undefined) delete process.env.PAAS_LOG_MAX_FILE;
      else process.env.PAAS_LOG_MAX_FILE = saved.file;
    });

    it("usa o .env em vigor", () => {
      process.env.PAAS_LOG_MAX_SIZE = "25m";
      process.env.PAAS_LOG_MAX_FILE = "2";
      expect(dockerLogArgs()).toContain("max-size=25m");
      expect(composeLogging()?.options["max-file"]).toBe("2");
      expect(dockerApiLogConfig()?.Config["max-size"]).toBe("25m");
      expect(containerLogLimits()).toEqual({ maxSize: "25m", maxFile: 2 });
      expect(containerLogLimitsIssues()).toEqual([]);
      expect(hasContainerLogLimits('{"Type":"json-file","Config":{"max-size":"25m","max-file":"2"}}')).toBe(true);
    });
  });
});

describe("hasContainerLogLimits: o container existente já tem o limite de hoje?", () => {
  const limits = { maxSize: "10m", maxFile: 3 };

  it("igual = sim; diferente, sem opções ou outro driver = não", () => {
    expect(hasContainerLogLimits('{"Type":"json-file","Config":{"max-size":"10m","max-file":"3"}}', limits)).toBe(true);
    expect(hasContainerLogLimits('{"Type":"json-file","Config":{"max-size":"5m","max-file":"3"}}', limits)).toBe(false);
    expect(hasContainerLogLimits('{"Type":"json-file","Config":{}}', limits)).toBe(false);
    expect(hasContainerLogLimits('{"Type":"json-file","Config":null}', limits)).toBe(false);
    expect(hasContainerLogLimits('{"Type":"local","Config":{"max-size":"10m","max-file":"3"}}', limits)).toBe(false);
  });

  it("ilegível = não; limite desligado = sempre sim", () => {
    expect(hasContainerLogLimits("não é json", limits)).toBe(false);
    expect(hasContainerLogLimits("null", limits)).toBe(false);
    expect(hasContainerLogLimits("qualquer", null)).toBe(true);
  });
});

describe("isUnboundedLogConfig: só o json-file sem max-size cresce sem teto", () => {
  it("json-file sem max-size = sem teto", () => {
    expect(isUnboundedLogConfig('{"Type":"json-file","Config":{}}')).toBe(true);
    expect(isUnboundedLogConfig('{"Type":"json-file","Config":null}')).toBe(true);
    expect(isUnboundedLogConfig('{"Type":"json-file","Config":{"max-size":""}}')).toBe(true);
  });

  it("com max-size, outro driver ou ilegível = não acusa", () => {
    expect(isUnboundedLogConfig('{"Type":"json-file","Config":{"max-size":"5m"}}')).toBe(false);
    expect(isUnboundedLogConfig('{"Type":"journald","Config":{}}')).toBe(false);
    expect(isUnboundedLogConfig("lixo")).toBe(false);
    expect(isUnboundedLogConfig("7")).toBe(false);
  });
});
