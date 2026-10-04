/**
 * compose-diagnose.ts — o "por que falhou" de um `docker compose up` que deu
 * errado. Caso real (cassino, 03/10/2026): o deploy terminou com
 * "dependency failed to start: container paas-cassino-wallet-1 is unhealthy"
 * e o log do painel não mostrou o que o wallet escreveu antes de ficar
 * unhealthy. Agora o painel consulta `compose ps -a`, junta o fim do log e o
 * resultado do healthcheck de cada serviço com problema e diz qual serviço
 * falhou na mensagem final.
 *
 * Sem Docker: o executor de comandos é um dublê.
 */
import { describe, expect, it } from "vitest";
import {
  DIAGNOSE_LOG_TAIL,
  diagnoseComposeFailure,
  failedServices,
  failureSummary,
  parseComposePs,
  sanitizeLogBlock,
  startableServices,
  type ComposeRunner,
} from "../src/compose-diagnose.js";

type Result = { code: number; stdout: string; stderr: string };
const ok = (stdout = ""): Result => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "erro"): Result => ({ code: 1, stdout: "", stderr });

const BASE = ["compose", "-p", "paas-cassino", "--env-file", "/data/paas.env", "-f", "/src/compose.yaml"];
const DECLARED = ["db", "redis", "wallet", "web", "caddy"];

/** `compose ps -a --format json` no formato NDJSON (compose ≥ 2.21). */
const PS_NDJSON = [
  { Service: "db", Name: "paas-cassino-db-1", State: "running", Health: "healthy", ExitCode: 0 },
  { Service: "redis", Name: "paas-cassino-redis-1", State: "running", Health: "healthy", ExitCode: 0 },
  { Service: "wallet", Name: "paas-cassino-wallet-1", State: "running", Health: "unhealthy", ExitCode: 0 },
  { Service: "web", Name: "paas-cassino-web-1", State: "created", Health: "", ExitCode: 0 },
]
  .map((e) => JSON.stringify(e))
  .join("\n");

const HEALTH = JSON.stringify({
  Status: "unhealthy",
  FailingStreak: 5,
  Log: [
    { Start: "t1", End: "t1", ExitCode: 1, Output: "primeira" },
    { Start: "t2", End: "t2", ExitCode: 1, Output: "segunda" },
    { Start: "t3", End: "t3", ExitCode: 1, Output: "terceira" },
    { Start: "t4", End: "t4", ExitCode: 1, Output: "curl: (7) Failed to connect to localhost port 8009\n" },
  ],
});

function fakeRunner(responses: (args: string[]) => Result): { run: ComposeRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (_file, args) => {
      calls.push(args);
      return responses(args);
    },
  };
}

describe("parseComposePs", () => {
  it("lê NDJSON (uma linha por container)", () => {
    const entries = parseComposePs(PS_NDJSON);
    expect(entries).toHaveLength(4);
    expect(entries[2]).toEqual({
      service: "wallet",
      name: "paas-cassino-wallet-1",
      state: "running",
      health: "unhealthy",
      exitCode: 0,
    });
  });

  it("lê o formato antigo (array JSON) e ignora linhas inválidas e sem serviço", () => {
    const arr = JSON.stringify([{ Service: "web", Name: "w", State: "exited", ExitCode: 137 }, { Name: "sem-servico" }]);
    expect(parseComposePs(`${arr}\n`)).toEqual([{ service: "web", name: "w", state: "exited", health: "", exitCode: 137 }]);
    expect(parseComposePs("lixo\n{\"Service\":\"db\"}\n")).toEqual([
      { service: "db", name: "", state: "", health: "", exitCode: null },
    ]);
    expect(parseComposePs("")).toEqual([]);
    expect(parseComposePs("[1, null]")).toEqual([]);
  });
});

describe("failedServices", () => {
  it("separa quem falhou (unhealthy, saiu com erro, reiniciando) de quem só não chegou a iniciar", () => {
    const entries = [
      ...parseComposePs(PS_NDJSON),
      { service: "migra", name: "m", state: "exited", health: "", exitCode: 0 },
      { service: "worker", name: "k", state: "exited", health: "", exitCode: 2 },
      { service: "fila", name: "f", state: "restarting", health: "", exitCode: 1 },
      { service: "velho", name: "v", state: "dead", health: "", exitCode: null },
    ];
    const failures = failedServices(entries, [...DECLARED, "migra", "worker", "fila", "velho"]);
    expect(failures.map((f) => [f.service, f.kind])).toEqual([
      ["wallet", "unhealthy"],
      ["worker", "exited"],
      ["fila", "restarting"],
      ["velho", "exited"],
      ["web", "not-started"],
      ["caddy", "missing"],
    ]);
  });

  it("nada a apontar quando todos rodam", () => {
    expect(failedServices([{ service: "db", name: "d", state: "running", health: "starting", exitCode: 0 }], ["db"])).toEqual([]);
  });
});

describe("failureSummary", () => {
  it("frase curta por tipo de falha", () => {
    expect(failureSummary([{ service: "wallet", container: "c", kind: "unhealthy", exitCode: 0 }])).toBe(
      "o serviço wallet não ficou saudável — veja o log dele acima",
    );
    expect(failureSummary([{ service: "w", container: "c", kind: "exited", exitCode: 1 }])).toBe(
      "o serviço w parou com erro (código 1) — veja o log dele acima",
    );
    expect(failureSummary([{ service: "w", container: "c", kind: "exited", exitCode: null }])).toBe(
      "o serviço w parou com erro — veja o log dele acima",
    );
    expect(failureSummary([{ service: "w", container: "c", kind: "restarting", exitCode: 1 }])).toBe(
      "o serviço w fica reiniciando sem parar — veja o log dele acima",
    );
  });

  it("vários serviços: junta as frases e fala no plural", () => {
    expect(
      failureSummary([
        { service: "a", container: "c", kind: "unhealthy", exitCode: 0 },
        { service: "b", container: "d", kind: "exited", exitCode: 3 },
        { service: "web", container: "e", kind: "not-started", exitCode: 0 },
      ]),
    ).toBe("o serviço a não ficou saudável; o serviço b parou com erro (código 3) — veja o log deles acima");
  });

  it("só serviços que não iniciaram ou não foram criados", () => {
    expect(failureSummary([{ service: "web", container: "e", kind: "not-started", exitCode: 0 }])).toBe(
      "o serviço web não chegou a iniciar",
    );
    expect(
      failureSummary([
        { service: "web", container: "e", kind: "not-started", exitCode: 0 },
        { service: "caddy", container: null, kind: "missing", exitCode: null },
      ]),
    ).toBe("os serviços web, caddy não chegaram a iniciar");
    expect(failureSummary([])).toBe("");
  });
});

describe("sanitizeLogBlock", () => {
  it("tira cores e caracteres de controle, mantendo as quebras de linha", () => {
    expect(sanitizeLogBlock("\u001b[31merro\u001b[0m\r\nlinha\u0007 2\tok\rfim")).toBe("erro\nlinha 2\tok\nfim");
  });

  it("corta linha comprida e guarda o FIM quando passa do limite", () => {
    const long = sanitizeLogBlock("x".repeat(3_000));
    expect(long.length).toBeLessThanOrEqual(1_001);
    expect(long.endsWith("…")).toBe(true);
    const many = sanitizeLogBlock(Array.from({ length: 50 }, (_v, i) => `linha ${i}`).join("\n"), 100);
    expect(many.startsWith("…")).toBe(true);
    expect(many.endsWith("linha 49")).toBe(true);
    expect(many.length).toBeLessThanOrEqual(101);
  });
});

describe("diagnoseComposeFailure", () => {
  it("anexa o log e o healthcheck do serviço unhealthy e devolve o resumo (caso do cassino)", async () => {
    const { run, calls } = fakeRunner((args) => {
      if (args.includes("ps")) return ok(PS_NDJSON);
      if (args.includes("logs")) return ok("\u001b[32mwallet-1  |\u001b[0m erro: KYC_MODO inválido\nwallet-1  | encerrando\n");
      if (args[0] === "inspect") return ok(`${HEALTH}\n`);
      return fail();
    });
    let log = "";
    const summary = await diagnoseComposeFailure(BASE, DECLARED, (c) => (log += c), run);

    expect(summary).toBe("o serviço wallet não ficou saudável — veja o log dele acima");
    // mesmos -p/-f/--env-file do deploy
    expect(calls[0]).toEqual([...BASE, "ps", "-a", "--format", "json"]);
    expect(calls).toContainEqual([...BASE, "logs", "--no-color", "--tail", String(DIAGNOSE_LOG_TAIL), "wallet"]);
    expect(calls).toContainEqual(["inspect", "--format", "{{json .State.Health}}", "paas-cassino-wallet-1"]);
    // o web (created) não tem log a buscar
    expect(calls.some((a) => a.includes("logs") && a.includes("web"))).toBe(false);

    expect(log).toContain("=== Por que falhou: serviço wallet ===");
    expect(log).toContain("erro: KYC_MODO inválido");
    expect(log).not.toContain("\u001b");
    // só as 3 últimas verificações
    expect(log).not.toContain("primeira");
    expect(log).toContain("segunda");
    expect(log).toContain("Failed to connect to localhost port 8009");
    expect(log).toContain("web: não chegou a iniciar");
    expect(log).toContain("caddy: não foi criado");
  });

  it("serviço que saiu com erro: log sem bloco de healthcheck quando não há healthcheck", async () => {
    const ps = JSON.stringify([{ Service: "app", Name: "paas-x-app-1", State: "exited", ExitCode: 1 }]);
    const { run } = fakeRunner((args) => {
      if (args.includes("ps")) return ok(ps);
      if (args.includes("logs")) return ok("");
      if (args[0] === "inspect") return ok("null\n");
      return fail();
    });
    let log = "";
    const summary = await diagnoseComposeFailure(BASE, ["app"], (c) => (log += c), run);
    expect(summary).toBe("o serviço app parou com erro (código 1) — veja o log dele acima");
    expect(log).toContain("(o serviço não escreveu nada no log)");
    expect(log).not.toContain("Healthcheck");
  });

  it("falha ao ler log ou healthcheck vira aviso no bloco, sem derrubar o diagnóstico", async () => {
    const { run } = fakeRunner((args) => {
      if (args.includes("ps")) return ok(PS_NDJSON);
      if (args.includes("logs")) return fail("sem permissão");
      if (args[0] === "inspect") return ok("{não é json");
      return fail();
    });
    let log = "";
    const summary = await diagnoseComposeFailure(BASE, ["wallet"], (c) => (log += c), run);
    expect(summary).toBe("o serviço wallet não ficou saudável — veja o log dele acima");
    expect(log).toContain("não foi possível ler o log (sem permissão)");
  });

  it("healthcheck sem entradas e inspect com erro não mostram bloco", async () => {
    const ps = JSON.stringify({ Service: "app", Name: "c1", State: "restarting", ExitCode: 1 });
    const { run } = fakeRunner((args) => {
      if (args.includes("ps")) return ok(ps);
      if (args.includes("logs")) return ok("boom\n");
      if (args[0] === "inspect") return ok(JSON.stringify({ Status: "unhealthy", Log: [] }));
      return fail();
    });
    let log = "";
    expect(await diagnoseComposeFailure(BASE, ["app"], (c) => (log += c), run)).toBe(
      "o serviço app fica reiniciando sem parar — veja o log dele acima",
    );
    expect(log).not.toContain("Healthcheck");

    const r2 = fakeRunner((args) => (args.includes("ps") ? ok(ps) : args.includes("logs") ? ok("x") : fail()));
    let log2 = "";
    await diagnoseComposeFailure(BASE, ["app"], (c) => (log2 += c), r2.run);
    expect(log2).not.toContain("Healthcheck");
  });

  it("verificação sem código nem saída, Log que não é lista e container sem nome", async () => {
    const health = JSON.stringify({ Status: "unhealthy", Log: [{ Output: "" }] });
    const ps = [
      JSON.stringify({ Service: "app", Name: "c1", State: "running", Health: "unhealthy" }),
      JSON.stringify({ Service: "api", Name: "c2", State: "running", Health: "unhealthy" }),
      JSON.stringify({ Service: "sem-nome", State: "running", Health: "unhealthy" }),
    ].join("\n");
    const { run, calls } = fakeRunner((args) => {
      if (args.includes("ps")) return ok(ps);
      if (args.includes("logs")) return { code: 0, stdout: "", stderr: "aviso no stderr" };
      if (args[0] === "inspect") return ok(args[3] === "c1" ? health : JSON.stringify({ Log: "x" }));
      return fail();
    });
    let log = "";
    await diagnoseComposeFailure(BASE, ["app", "api", "sem-nome"], (c) => (log += c), run);
    expect(log).toContain("· código ?: (sem saída)");
    expect(calls.filter((a) => a[0] === "inspect")).toHaveLength(2);
  });

  it("limita o total anexado ao log", async () => {
    const services = Array.from({ length: 10 }, (_v, i) => `s${i}`);
    const ps = services.map((s) => JSON.stringify({ Service: s, Name: s, State: "exited", ExitCode: 1 })).join("\n");
    const big = Array.from({ length: 80 }, (_v, i) => `${"y".repeat(900)} ${i}`).join("\n");
    const { run } = fakeRunner((args) => (args.includes("ps") ? ok(ps) : args.includes("logs") ? ok(big) : ok("null")));
    let log = "";
    await diagnoseComposeFailure(BASE, services, (c) => (log += c), run);
    expect(log.length).toBeLessThan(40_000);
    expect(log).toContain("diagnóstico encurtado");
  });

  it("devolve null quando o ps falha ou ninguém falhou", async () => {
    const broken = fakeRunner(() => fail("daemon fora"));
    let log = "";
    expect(await diagnoseComposeFailure(BASE, DECLARED, (c) => (log += c), broken.run)).toBeNull();
    expect(log).toContain("não foi possível consultar o estado dos serviços (daemon fora)");

    const allGood = fakeRunner(() => ok(JSON.stringify({ Service: "db", Name: "d", State: "running" })));
    expect(await diagnoseComposeFailure(BASE, ["db"], () => undefined, allGood.run)).toBeNull();
  });
});

describe("startableServices", () => {
  it("serviços declarados, sem os de profile (não sobem sem --profile) e tolerante a YAML ruim", () => {
    const yaml =
      "services:\n  db:\n    image: postgres\n  web:\n    build: .\n  mail:\n    image: mailpit\n    profiles: [dev]\n";
    expect(startableServices(yaml)).toEqual(["db", "web"]);
    expect(startableServices("services: [")).toEqual([]);
    expect(startableServices("x: 1")).toEqual([]);
    expect(startableServices("services:\n  a:\n")).toEqual(["a"]);
  });
});
