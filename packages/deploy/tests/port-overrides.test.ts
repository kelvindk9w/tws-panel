/**
 * port-overrides.test.ts — trocas da porta do SERVIDOR feitas no painel (aba
 * Portas): as portas publicadas de cada serviço com uma chave estável, a lista
 * final que vai para o paas.override.yml (`ports: !override`) e a mesma lista
 * para os guardrails (porta de banco removida no painel não bloqueia mais).
 */
import { describe, expect, it } from "vitest";
import type { PortOverride } from "@paas/core";
import { composePortEntries, effectiveServicePorts, portEntryText } from "../src/port-overrides.js";
import { CASSINO_LIKE } from "./fixtures/cassino-like.js";

const APP = `services:
  web:
    image: nginx:1.27
    ports:
      - "80:80"
      - "127.0.0.1:8010:8010"
      - "5353:53/udp"
  db:
    image: postgres:16
    ports:
      - "5432:5432"
  worker:
    image: app:1
`;

const change = (original: string, hostPort: number | null, hostIp: PortOverride["hostIp"] = "127.0.0.1"): PortOverride => ({
  original,
  hostPort,
  hostIp: hostPort === null ? null : hostIp,
});

describe("composePortEntries", () => {
  it("lista as portas publicadas de cada serviço com a chave como está no compose", () => {
    const entries = composePortEntries(APP);
    expect(Object.keys(entries)).toEqual(["web", "db", "worker"]);
    expect(entries.web!.map((e) => e.key)).toEqual(["80:80", "127.0.0.1:8010:8010", "5353:53/udp"]);
    expect(entries.web![1]).toMatchObject({ containerPort: 8010, protocol: "tcp", hostIp: "127.0.0.1", hostPort: 8010, panel: null });
    expect(entries.web![0]!.panel).toBe("removed");
    expect(entries.web![2]).toMatchObject({ containerPort: 53, protocol: "udp", hostPort: 5353 });
    expect(entries.worker).toEqual([]);
  });

  it("proxy HTTPS próprio: 80/443 marcadas como conflito, as outras normais", () => {
    const entries = composePortEntries(CASSINO_LIKE);
    expect(entries.wallet!.map((e) => [e.key, e.panel])).toEqual([
      ["80:80", "conflict"],
      ["443:443", "conflict"],
      ["127.0.0.1:8010:8010", null],
    ]);
    expect(entries.caddy).toEqual([]);
  });

  it("formas variadas: faixa, variável, aleatória e IPv6", () => {
    const compose = `services:
  x:
    image: a
    ports:
      - "8000-8001:8000-8001"
      - "\${P:-9000}:9000"
      - "7000"
      - "[::1]:6000:6000"
`;
    const keys = composePortEntries(compose).x!.map((e) => [e.key, e.hostPort, e.composeHost]);
    expect(keys).toEqual([
      ["8000:8000", 8000, "8000"],
      ["8001:8001", 8001, "8001"],
      ["${P:-9000}:9000", null, "${P:-9000}"],
      ["7000", null, "aleatória"],
      ["[::1]:6000:6000", 6000, "[::1]:6000"],
    ]);
  });

  it("compose inválido ou sem serviços: vazio", () => {
    expect(composePortEntries(": : :")).toEqual({});
    expect(composePortEntries("services: 3")).toEqual({});
    expect(composePortEntries("services:\n  a: null\n")).toEqual({ a: [] });
  });
});

describe("portEntryText", () => {
  it("monta a forma curta do compose", () => {
    expect(portEntryText("127.0.0.1", 18010, 8010, "tcp")).toBe("127.0.0.1:18010:8010");
    expect(portEntryText("0.0.0.0", 5353, 53, "udp")).toBe("0.0.0.0:5353:53/udp");
    expect(portEntryText(null, 9000, 9000, "tcp")).toBe("9000:9000");
    expect(portEntryText("::1", 9000, 9000, "tcp")).toBe("[::1]:9000:9000");
  });
});

describe("effectiveServicePorts", () => {
  it("sem trocas: igual à retirada de 80/443 de sempre", () => {
    const r = effectiveServicePorts(APP, undefined, { stripProxyPorts: true });
    expect(r.ports).toEqual({ web: ["127.0.0.1:8010:8010", "5353:53/udp"] });
    expect(r.changes).toEqual([]);
    expect(r.stale).toEqual([]);
  });

  it("troca a porta do servidor e o endereço, mantendo a interna", () => {
    const r = effectiveServicePorts(
      APP,
      { web: [change("127.0.0.1:8010:8010", 18010, "0.0.0.0")] },
      { stripProxyPorts: true },
    );
    expect(r.ports.web).toEqual(["0.0.0.0:18010:8010", "5353:53/udp"]);
    expect(r.changes).toEqual([{ service: "web", from: "127.0.0.1:8010:8010", to: "0.0.0.0:18010:8010" }]);
  });

  it("remover a publicação tira a entrada da lista", () => {
    const r = effectiveServicePorts(APP, { db: [change("5432:5432", null)] }, { stripProxyPorts: true });
    expect(r.ports.db).toEqual([]);
    expect(r.changes).toEqual([{ service: "db", from: "5432:5432", to: null }]);
  });

  it("para os guardrails (sem retirar 80/443): só aplica as trocas", () => {
    const r = effectiveServicePorts(APP, { db: [change("5432:5432", null)] }, { stripProxyPorts: false });
    expect(r.ports).toEqual({ db: [] });
  });

  it("troca dentro de uma faixa: a faixa vira portas soltas", () => {
    const compose = `services:\n  x:\n    image: a\n    ports: ["8000-8001:8000-8001"]\n`;
    const r = effectiveServicePorts(compose, { x: [change("8001:8001", 18001)] }, { stripProxyPorts: true });
    expect(r.ports.x).toEqual(["8000:8000", "127.0.0.1:18001:8001"]);
  });

  it("faixa e variável do lado do servidor continuam como estavam ao lado de uma troca", () => {
    const compose = `services:
  x:
    image: a
    ports:
      - "9000-9010:80"
      - "\${P}:81"
      - target: 82
        published: "8082"
`;
    const r = effectiveServicePorts(compose, { x: [change("8082:82", 18082)] }, { stripProxyPorts: true });
    expect(r.ports.x).toEqual(["9000-9010:80", "${P}:81", "127.0.0.1:18082:82"]);
  });

  it("porta aleatória com variável no IP: reescrita fica igual ao compose", () => {
    const compose = `services:\n  x:\n    image: a\n    ports: ["\${IP}::7000", "7001:7001"]\n`;
    const r = effectiveServicePorts(compose, { x: [change("7001:7001", 17001)] }, { stripProxyPorts: false });
    expect(r.ports.x).toEqual(["${IP}::7000", "127.0.0.1:17001:7001"]);
  });

  it("troca que não existe mais no compose é ignorada e avisada", () => {
    const r = effectiveServicePorts(
      APP,
      { web: [change("127.0.0.1:9999:9999", 19999)], sumiu: [change("1:1", 2000)] },
      { stripProxyPorts: false },
    );
    expect(r.ports).toEqual({});
    expect(r.stale).toEqual([
      { service: "web", original: "127.0.0.1:9999:9999" },
      { service: "sumiu", original: "1:1" },
    ]);
  });

  it("80/443 não são trocadas pelo painel (a troca é ignorada)", () => {
    const r = effectiveServicePorts(APP, { web: [change("80:80", 8080)] }, { stripProxyPorts: true });
    expect(r.ports.web).toEqual(["127.0.0.1:8010:8010", "5353:53/udp"]);
    expect(r.stale).toEqual([{ service: "web", original: "80:80" }]);
  });

  it("proxy HTTPS próprio: 80/443 ficam, a outra porta é trocada", () => {
    const r = effectiveServicePorts(
      CASSINO_LIKE,
      { wallet: [change("127.0.0.1:8010:8010", 18010)] },
      { stripProxyPorts: true },
    );
    expect(r.ports.wallet).toEqual(["80:80", "443:443", "127.0.0.1:18010:8010"]);
  });

  it("compose inválido: nada muda", () => {
    expect(effectiveServicePorts("::", { a: [change("1:1", 2000)] }, { stripProxyPorts: true }).ports).toEqual({});
  });
});
