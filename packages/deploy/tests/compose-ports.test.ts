/**
 * Testes da interpretação de `ports` do compose (compose-ports.ts), usada pelas
 * regras de guardrails.ts e rules.ts. Foco: qual porta do CONTAINER fica
 * publicada, em qual endereço, e como a porta do host (às vezes desconhecida)
 * é representada e exibida.
 */
import { describe, expect, it } from "vitest";
import { describeHostSide, formatPortMapping, publishedPorts } from "../src/compose-ports.js";

describe("publishedPorts — forma curta", () => {
  it("host:container literal", () => {
    expect(publishedPorts(["8080:80"])).toEqual([
      { container: 80, host: { kind: "fixed", port: 8080 }, hostIp: null, protocol: "tcp" },
    ]);
  });

  it("só a porta do container (string ou número) publica em porta aleatória", () => {
    expect(publishedPorts(["5432", 5432])).toEqual([
      { container: 5432, host: { kind: "random" }, hostIp: null, protocol: "tcp" },
      { container: 5432, host: { kind: "random" }, hostIp: null, protocol: "tcp" },
    ]);
  });

  it("porta do host 0 ou vazia é aleatória; o endereço fica disponível", () => {
    expect(publishedPorts(["0:5432", "127.0.0.1::5432"])).toEqual([
      { container: 5432, host: { kind: "random" }, hostIp: null, protocol: "tcp" },
      { container: 5432, host: { kind: "random" }, hostIp: "127.0.0.1", protocol: "tcp" },
    ]);
  });

  it("variáveis: com chaves, padrão com ':', aninhadas, sem chaves e no endereço", () => {
    const ports = publishedPorts([
      "${DB_PORT}:5432",
      "${DB_PORT:-5432}:5432",
      "${A:-${B:-1}}:5432",
      "$DB_PORT:5432",
      "${BIND_IP}:5432:5432",
    ]);
    expect(ports.map((p) => p.host)).toEqual([
      { kind: "variable", raw: "${DB_PORT}" },
      { kind: "variable", raw: "${DB_PORT:-5432}" },
      { kind: "variable", raw: "${A:-${B:-1}}" },
      { kind: "variable", raw: "$DB_PORT" },
      { kind: "fixed", port: 5432 },
    ]);
    expect(ports[4]?.hostIp).toBe("${BIND_IP}");
    expect(ports.every((p) => p.container === 5432)).toBe(true);
  });

  it("faixas: uma entrada por porta do container", () => {
    expect(publishedPorts(["9090-9091:8080-8081"]).map((p) => [p.host, p.container])).toEqual([
      [{ kind: "fixed", port: 9090 }, 8080],
      [{ kind: "fixed", port: 9091 }, 8081],
    ]);
    expect(publishedPorts(["8000-9000:80"])).toEqual([
      { container: 80, host: { kind: "range", start: 8000, end: 9000 }, hostIp: null, protocol: "tcp" },
    ]);
    expect(publishedPorts(["3000-3002"]).map((p) => p.container)).toEqual([3000, 3001, 3002]);
    expect(publishedPorts(["${P}:5432-5433"]).map((p) => p.host.kind)).toEqual(["variable", "variable"]);
  });

  it("IPv6 com e sem colchetes, e protocolos", () => {
    expect(publishedPorts(["[::1]:6001:6001/udp", "::1:6000:6000", "[::]::5432", "5000:5000/SCTP"])).toEqual([
      { container: 6001, host: { kind: "fixed", port: 6001 }, hostIp: "::1", protocol: "udp" },
      { container: 6000, host: { kind: "fixed", port: 6000 }, hostIp: "::1", protocol: "tcp" },
      { container: 5432, host: { kind: "random" }, hostIp: "::", protocol: "tcp" },
      { container: 5000, host: { kind: "fixed", port: 5000 }, hostIp: null, protocol: "sctp" },
    ]);
  });

  it("entradas que o Compose rejeita, ou com porta do container desconhecida, são ignoradas", () => {
    expect(
      publishedPorts([
        "abc:80",
        "80:abc",
        "",
        "0",
        "70000",
        "80:70000",
        "5433-5432",
        "5432/xyz",
        "15432-15434:5432-5433",
        "0-10:5432",
        "80:${PORTA}",
        "${PORTAS}",
        "$$5432:5432",
        ":5432:5432",
        "host.local:5432:5432",
        "[::1:5432:5432",
        "[::1]5432:5432",
        "[::1]:5432",
        5432.5,
        true,
        null,
        ["5432"],
      ]),
    ).toEqual([]);
  });

  it("valor que não é lista não publica nada", () => {
    expect(publishedPorts("5432:5432")).toEqual([]);
    expect(publishedPorts(undefined)).toEqual([]);
  });
});

describe("publishedPorts — forma longa", () => {
  it("target sozinho publica em porta aleatória", () => {
    expect(publishedPorts([{ target: 5432 }])).toEqual([
      { container: 5432, host: { kind: "random" }, hostIp: null, protocol: "tcp" },
    ]);
  });

  it("published em número, string, faixa, variável, vazio ou nulo", () => {
    const ports = publishedPorts([
      { target: 5432, published: 15432 },
      { target: "5432", published: "5432" },
      { target: 443, published: "8083-9000", host_ip: "127.0.0.1", protocol: "TCP" },
      { target: 5432, published: "${DB_PORT}" },
      { target: 5432, published: "" },
      { target: 5432, published: null, host_ip: "  " },
    ]);
    expect(ports.map((p) => p.host)).toEqual([
      { kind: "fixed", port: 15432 },
      { kind: "fixed", port: 5432 },
      { kind: "range", start: 8083, end: 9000 },
      { kind: "variable", raw: "${DB_PORT}" },
      { kind: "random" },
      { kind: "random" },
    ]);
    expect(ports[2]).toMatchObject({ container: 443, hostIp: "127.0.0.1", protocol: "tcp" });
    expect(ports[5]?.hostIp).toBeNull();
  });

  it("ignora target ausente, inválido ou de variável, protocolo e published inválidos", () => {
    expect(
      publishedPorts([
        { published: 5432 },
        { target: "${ALVO}", published: 5432 },
        { target: 0 },
        { target: "5432-5433" },
        { target: 5432, protocol: "icmp" },
        { target: 5432, published: "abc" },
        { target: 5432, published: { porta: 1 } },
      ]),
    ).toEqual([]);
  });
});

describe("exibição da porta do host", () => {
  const [fixa, faixa, variavel, aleatoria, loopbackAleatoria, ipv6] = publishedPorts([
    "127.0.0.1:15432:5432",
    "15432-15433:5432",
    "${DB_PORT}:5432",
    "5432",
    "127.0.0.1::5432",
    "[::]:5432:5432",
  ]);

  it("formatPortMapping mostra o mapeamento e explica o host desconhecido", () => {
    expect(formatPortMapping(fixa!)).toBe("127.0.0.1:15432:5432");
    expect(formatPortMapping(faixa!)).toBe("15432-15433:5432");
    expect(formatPortMapping(variavel!)).toBe("${DB_PORT}:5432 (porta do host definida pela variável ${DB_PORT})");
    expect(formatPortMapping(aleatoria!)).toBe("5432 (porta 5432 do container em porta aleatória do host)");
    expect(formatPortMapping(loopbackAleatoria!)).toBe(
      "127.0.0.1::5432 (porta 5432 do container em porta aleatória do host)",
    );
    expect(formatPortMapping(ipv6!)).toBe("[::]:5432:5432");
  });

  it("describeHostSide descreve o lado do host em frase", () => {
    expect(describeHostSide(fixa!)).toBe("a porta 15432 do host (em 127.0.0.1)");
    expect(describeHostSide(faixa!)).toBe("uma porta da faixa 15432-15433 do host");
    expect(describeHostSide(variavel!)).toBe("a porta do host definida pela variável ${DB_PORT}");
    expect(describeHostSide(aleatoria!)).toBe("uma porta aleatória do host");
  });
});
