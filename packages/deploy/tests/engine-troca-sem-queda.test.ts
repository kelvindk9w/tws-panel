/**
 * DeployEngine.deploy com a troca sem queda, ponta a ponta com dublês (Docker simulado, Caddy, health check):
 * Next.js, Dockerfile e site estático; ajuste desligado; porta publicada; saúde reprovada; rollback; recuperação.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";
import { FakeDocker } from "./fake-docker.js";

const fake = vi.hoisted(() => ({ current: null as null | { fn: (args: string[], opts?: unknown) => Promise<unknown> } }));
vi.mock("../src/exec.js", () => ({
  run: vi.fn(async (file: string, args: string[], opts?: unknown) => (file === "docker" && fake.current ? fake.current.fn(args, opts) : { code: 0, stdout: "", stderr: "" })),
  runStream: vi.fn(async () => 0),
}));
const healthMock = vi.hoisted(() => vi.fn());
vi.mock("../src/health-check.js", () => ({ waitHealthy: healthMock }));

const { DeployEngine } = await import("../src/engine.js");

let root: string;
let workDir: string;
let src: string;
let docker: FakeDocker;
let engine: InstanceType<typeof DeployEngine>;
let upstreams: string[];

beforeEach(async () => {
  docker = new FakeDocker();
  fake.current = docker as never;
  healthMock.mockReset();
  healthMock.mockResolvedValue(undefined);
  upstreams = [];
  root = await mkdtemp(path.join(tmpdir(), "paas-troca-"));
  workDir = path.join(root, "projects", "loja");
  src = path.join(root, "codigo");
  await mkdir(workDir, { recursive: true });
  await mkdir(src, { recursive: true });
  await writeFile(path.join(src, "package.json"), JSON.stringify({ scripts: { build: "next build" }, dependencies: { next: "15" } }));
  await writeFile(path.join(src, "package-lock.json"), "{}");
  await writeFile(path.join(src, "index.html"), "<h1>oi</h1>");
  await writeFile(path.join(src, "Dockerfile"), "FROM scratch\n");
  engine = new DeployEngine({
    projectsDir: path.join(root, "projects"),
    caddyDir: path.join(root, "projects", "caddy"),
    nodeImage: "node:22",
    staticImage: "nginx:alpine",
    caddyHttpPort: 80,
    caddyHttpsPort: 443,
    totalMemBytes: () => 2 * 1024 ** 3,
    swapDrainMs: 0,
    swapHealthTimeoutMs: 0,
  });
  engine.caddy.apply = vi.fn(async (targets: Array<{ upstream: string }>) => {
    upstreams.push(...targets.map((t) => t.upstream));
  }) as never;
  engine.caddy.ensureNetwork = vi.fn().mockResolvedValue(undefined) as never;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function project(type: "node-server" | "dockerfile" | "static", over: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "Loja",
    slug: "loja",
    ingestMode: "existing",
    source: src,
    branch: null,
    domain: "loja.localhost",
    websocket: false,
    detection: { type, composeFile: null, outputDir: null, packageManager: "npm", buildCommand: null, proxyService: null, proxyPort: 3000, warnings: [], details: [] },
    proxyService: null,
    proxyPort: null,
    createdAt: "",
    updatedAt: "",
    lastDeployAt: null,
    lastDeployStatus: null,
    deployedBranch: null,
    deployedSource: null,
    ...over,
  } as unknown as Project;
}

const runDeploy = async (p: Project) => {
  const logs: string[] = [];
  const result = await engine.deploy(p, [p], (c) => logs.push(c)).then(
    () => null,
    (e: Error) => e,
  );
  return { logs: logs.join(""), error: result };
};
const ran = (...prefix: string[]) => docker.calls.some((c) => prefix.every((x, i) => c[i] === x));
const names = (n: string) => `paas-loja-${n}`;

describe("Next.js (node-server)", () => {
  it("troca sem queda: nova ao lado, Caddy no apelido temporário e depois no definitivo, anterior parada e removida só no fim", async () => {
    docker.add(names("app"), { aliases: ["loja", names("app")] });
    const { error, logs } = await runDeploy(project("node-server"));
    expect(error).toBeNull();
    // Caddy: apelido que só a nova tem (sem mistura de versões) e, no passo final do deploy, o upstream de sempre
    expect(upstreams).toEqual(["loja--a:3000", "loja:3000"]);
    // a atual nunca foi removida antes da nova responder
    const run = docker.calls.find((c) => c[0] === "run")!;
    expect(run).toContain(names("app-next"));
    expect(run[run.indexOf("--network-alias") + 1]).toBe("loja--a");
    expect(docker.boxes.get(names("app"))!.aliases).toContain("loja");
    expect(docker.boxes.has(names("app-next"))).toBe(false);
    expect(docker.boxes.has(names("app-previous"))).toBe(false); // removida no fim (deploy saudável)
    for (const n of [1, 2, 3, 4]) expect(logs).toContain(`fase ${n}/4`);
    expect(ran("stop", names("app-previous"))).toBe(true);
    const stop = docker.calls.findIndex((c) => c[0] === "stop");
    const firstRepoint = docker.calls.findIndex((c) => c[0] === "run");
    expect(stop).toBeGreaterThan(firstRepoint);
    expect(logs).not.toContain("Atualizando");
  });

  it("nova não fica saudável: a atual segue atendendo, o Caddy nunca aponta para a nova, deploy falha com mensagem clara", async () => {
    docker.add(names("app"), { aliases: ["loja", names("app")] });
    docker.probeStatus = null;
    const { error, logs } = await runDeploy(project("node-server"));
    expect(error?.message).toMatch(/não ficou saudável.*segue no ar, sem interrupção/);
    expect(upstreams).toEqual([]);
    expect(docker.boxes.get(names("app"))).toMatchObject({ running: true });
    expect(docker.boxes.has(names("app-next"))).toBe(false);
    expect(ran("rename", names("app"), names("app-previous"))).toBe(false);
    expect(ran("rm", "-f", names("app"))).toBe(false); // o rollback clássico NÃO roda
    expect(logs).not.toContain("religada");
    // a anterior segue no ar: a notificação de deploy falho precisa dizer isso
    expect(engine.takeRestored("p1")).toBe(true);
  });

  it("ajuste desligado: comportamento de sempre (a atual é parada antes), com aviso no log", async () => {
    docker.add(names("app"));
    const { error, logs } = await runDeploy(project("node-server", { zeroDowntime: false }));
    expect(error).toBeNull();
    expect(logs).toContain("Troca sem queda desligada");
    expect(docker.calls.some((c) => c.includes(names("app-next")))).toBe(false);
    expect(ran("rename", names("app"), names("app-previous"))).toBe(true);
    expect(upstreams).toEqual(["loja:3000"]);
  });

  it("outra reaplicação do Caddy durante a troca (outro projeto, certificado) mantém o apelido temporário e depois o solta", async () => {
    docker.add(names("app"), { aliases: ["loja", names("app")] });
    const p = project("node-server");
    const seen: string[] = [];
    engine.caddy.apply = vi.fn(async (targets: Array<{ upstream: string }>) => {
      upstreams.push(...targets.map((t) => t.upstream));
      seen.push(engine.upstreamFor(p)); // o que um syncCaddy de outro motivo calcularia agora
    }) as never;
    const logs: string[] = [];
    await engine.deploy(p, [p], (c) => logs.push(c));
    expect(seen).toEqual(["loja--a:3000", "loja:3000"]);
    expect(engine.upstreamFor(p)).toBe("loja:3000");
  });

  it("falha na troca solta o apelido temporário do upstream", async () => {
    docker.add(names("app"), { aliases: ["loja", names("app")] });
    docker.probeStatus = null;
    const p = project("node-server");
    await engine.deploy(p, [p], () => undefined).catch(() => undefined);
    expect(engine.upstreamFor(p)).toBe("loja:3000");
  });

  it("dois deploys seguidos alternam o apelido temporário (a partir do legado --next) e a sonda nunca atinge a versão no ar", async () => {
    docker.add(names("app"), { aliases: ["loja", "loja--next", names("app")] });
    const p = project("node-server");
    for (const expected of ["loja--a", "loja--b", "loja--a"]) {
      docker.calls = [];
      docker.probeHits = [];
      await engine.deploy(p, [p], () => undefined);
      const run = docker.calls.find((c) => c[0] === "run")!;
      expect(run[run.indexOf("--network-alias") + 1]).toBe(expected);
      expect(new Set(docker.probeHits)).toEqual(new Set([names("app-next")]));
      expect(docker.boxes.get(names("app"))!.aliases).toEqual(expect.arrayContaining(["loja", expected]));
    }
    // um deploy cuja nova está quebrada, sobre o container que tem o --a: a sonda não pode ser enganada por ele
    docker.probeHits = [];
    docker.boxes.get(names("app"))!.probeStatus = 200;
    docker.probeStatus = null; // a nova não responde; só a que está no ar responde (200 próprio)
    const { error } = await runDeploy(p);
    expect(error?.message).toMatch(/não ficou saudável/);
    expect(new Set(docker.probeHits)).toEqual(new Set([names("app-next")]));
  });

  it("o Caddy não volta para <slug> depois de uma falha: a nova fica no ar e o upstream temporário continua valendo (até o próximo deploy)", async () => {
    docker.add(names("app"), { aliases: ["loja", names("app")] });
    const p = project("node-server");
    engine.caddy.apply = vi.fn(async () => {
      throw new Error("Caddy fora do ar");
    }) as never;
    const { error } = await runDeploy(p);
    expect(error).not.toBeNull();
    expect(docker.boxes.has(names("app-next"))).toBe(true);
    expect(engine.upstreamFor(p)).toBe("loja--a:3000");
  });

  describe("sobra de uma troca que não conseguiu desfazer", () => {
    // estado de partida: a nova (-app-next, com <slug> e --a) ficou no ar com o Caddy nela; a atual também roda
    const abandon = async (p: Project) => {
      const real = engine.caddy.apply;
      engine.caddy.apply = vi.fn(async () => {
        throw new Error("Caddy fora do ar");
      }) as never;
      await engine.deploy(p, [p], () => undefined).catch(() => undefined);
      engine.caddy.apply = real;
      upstreams = [];
    };

    it("cenário completo: abort sem volta do Caddy → deploy seguinte resolve a sobra e a nova que reprova NÃO derruba o site", async () => {
      docker.add(names("app"), { aliases: ["loja", names("app")], probeStatus: 200 });
      const p = project("node-server");
      await abandon(p);
      expect(docker.boxes.get(names("app-next"))).toMatchObject({ running: true });
      expect(engine.upstreamFor(p)).toBe("loja--a:3000");
      // 1) antes do aviso: Caddy de volta em <slug>, espera, stop, saída da rede, remoção; o mapa é solto
      const order: string[] = [];
      const base = docker.fn;
      docker.fn = async (a) => {
        if (a[0] === "stop" || (a[0] === "rm" && a[2] === names("app-next")) || (a[0] === "network" && a[1] === "disconnect")) order.push(a[0] === "network" ? "disconnect" : a[0]);
        return base(a);
      };
      expect(await engine.settleAbandonedSwap(p, [p], () => undefined)).toBe("cleared");
      expect(upstreams).toEqual(["loja:3000"]);
      expect(order).toEqual(["stop", "disconnect", "rm"]);
      expect(docker.boxes.has(names("app-next"))).toBe(false);
      expect(engine.upstreamFor(p)).toBe("loja:3000");
      // 2) o deploy seguinte, com a nova reprovando: a atual segue e o Caddy nunca aponta para um destino sem container
      docker.probeStatus = null;
      const { error } = await runDeploy(p);
      expect(error?.message).toMatch(/não ficou saudável/);
      expect(docker.boxes.get(names("app"))).toMatchObject({ running: true });
      expect(docker.boxes.get(names("app"))!.aliases).toContain("loja");
      expect(upstreams.filter((u) => u.includes("--"))).toEqual([]);
    });

    it("Caddy recusa de novo: nada é tocado (sobra no ar, sem stop/rm), o mapa continua e devolve 'refused'", async () => {
      docker.add(names("app"), { aliases: ["loja", names("app")] });
      const p = project("node-server");
      await abandon(p);
      engine.caddy.apply = vi.fn(async () => {
        throw new Error("ainda fora");
      }) as never;
      docker.calls = [];
      const logs: string[] = [];
      expect(await engine.settleAbandonedSwap(p, [p], (c) => logs.push(c))).toBe("refused");
      expect(docker.calls.some((c) => ["stop", "rm", "network"].includes(c[0]!))).toBe(false);
      expect(docker.boxes.get(names("app-next"))).toMatchObject({ running: true });
      expect(engine.upstreamFor(p)).toBe("loja--a:3000");
      expect(logs.join("")).toContain("a sobra foi mantida como está");
    });

    it("sem sobra (ou compose/sem tipo, ou -next parado): não faz nada", async () => {
      docker.add(names("app"));
      docker.add(names("app-next"), { running: false });
      const p = project("node-server");
      expect(await engine.settleAbandonedSwap(p, [p], () => undefined)).toBe("clean");
      expect(await engine.settleAbandonedSwap({ ...p, detection: { ...p.detection!, type: "compose" } } as never, [p], () => undefined)).toBe("clean");
      expect(await engine.settleAbandonedSwap({ ...p, detection: null } as never, [p], () => undefined)).toBe("clean");
      expect(upstreams).toEqual([]);
    });

    it("sobra de site estático (-web-next) também é resolvida", async () => {
      docker.add(names("web"), { aliases: ["loja", names("web")] });
      docker.add(names("web-next"), { aliases: ["loja", "loja--a"] });
      const p = project("static");
      expect(await engine.settleAbandonedSwap(p, [p], () => undefined)).toBe("cleared");
      expect(docker.boxes.has(names("web-next"))).toBe(false);
      expect(upstreams).toEqual(["loja:80"]);
    });

    it("a atual PARADA (abort que não conseguiu religá-la nem renomear a nova): a sobra é o único container que atende, é promovida e nunca removida", async () => {
      docker.add(names("app"), { running: false, aliases: ["loja", names("app")] });
      docker.add(names("app-next"), { aliases: ["loja", "loja--a"] });
      const p = project("node-server");
      const logs: string[] = [];
      expect(await engine.settleAbandonedSwap(p, [p], (c) => logs.push(c))).toBe("promoted");
      // a nova assumiu o nome, a atual parada virou -previous, nada da nova foi parado/removido
      expect(docker.boxes.get(names("app"))).toMatchObject({ running: true });
      expect(docker.boxes.get(names("app"))!.aliases).toEqual(expect.arrayContaining(["loja", "loja--a"]));
      expect(docker.boxes.get(names("app-previous"))).toMatchObject({ running: false });
      expect(docker.boxes.has(names("app-next"))).toBe(false);
      expect(docker.calls.some((c) => c[0] === "stop" && c[1] === names("app-next"))).toBe(false);
      expect(docker.calls.some((c) => c[0] === "rm" && c.includes(names("app-next")))).toBe(false);
      expect(upstreams).toEqual(["loja:3000"]);
      expect(logs.join("")).toContain("promovendo a nova, sem removê-la");
    });

    it("estático com o -web já removido: a sobra -web-next é promovida", async () => {
      docker.add(names("web-next"), { aliases: ["loja", "loja--a"] });
      const p = project("static");
      expect(await engine.settleAbandonedSwap(p, [p], () => undefined)).toBe("promoted");
      expect(docker.boxes.get(names("web"))).toMatchObject({ running: true });
      expect(docker.boxes.has(names("web-next"))).toBe(false);
      expect(upstreams).toEqual(["loja:80"]);
    });

    it("a promoção falha: a sobra NUNCA é parada nem removida e o resultado é 'failed'", async () => {
      docker.add(names("app"), { running: false, aliases: ["loja", names("app")] });
      docker.add(names("app-next"), { aliases: ["loja", "loja--a"] });
      docker.failWhen = (a) => (a[0] === "rename" && a[1] === names("app-next") ? { code: 1, stdout: "", stderr: "name in use" } : undefined);
      const p = project("node-server");
      const logs: string[] = [];
      expect(await engine.settleAbandonedSwap(p, [p], (c) => logs.push(c))).toBe("failed");
      expect(docker.boxes.get(names("app-next"))).toMatchObject({ running: true });
      expect(docker.calls.some((c) => c[0] === "stop" && c[1] === names("app-next"))).toBe(false);
      expect(docker.calls.some((c) => c[0] === "rm" && c.includes(names("app-next")))).toBe(false);
      expect(logs.join("")).toContain("Não consegui promover a versão nova");
      expect(upstreams).toEqual([]);
    });

    it("a promoção termina sem container rodando: 'failed', nada removido", async () => {
      docker.add(names("app"), { running: false });
      docker.add(names("app-next"), { aliases: ["loja", "loja--a"] });
      // o rename "funciona", mas a nova some da lista (simulador): nada atende depois
      docker.failWhen = (a) => {
        if (a[0] === "rename" && a[1] === names("app-next")) {
          docker.boxes.delete(names("app-next"));
          return { code: 0, stdout: "", stderr: "" };
        }
        return undefined;
      };
      const p = project("node-server");
      expect(await engine.settleAbandonedSwap(p, [p], () => undefined)).toBe("failed");
    });

    it("promovida, mas o Caddy recusa: segue 'promoted' com aviso (o container já atende)", async () => {
      docker.add(names("app"), { running: false });
      docker.add(names("app-next"), { aliases: ["loja", "loja--a"] });
      engine.caddy.apply = vi.fn(async () => {
        throw new Error("fora");
      }) as never;
      const p = project("node-server");
      const logs: string[] = [];
      expect(await engine.settleAbandonedSwap(p, [p], (c) => logs.push(c))).toBe("promoted");
      expect(logs.join("")).toContain("o Caddy recusou");
    });

    it("projeto parado pela pessoa (stoppedAt): só `docker stop` na sobra, sem promover, remover nem mexer no Caddy", async () => {
      docker.add(names("app"), { running: false });
      docker.add(names("app-next"), { aliases: ["loja", "loja--a"] });
      const p = project("node-server", { stoppedAt: "2026-01-01T00:00:00Z" } as never);
      const logs: string[] = [];
      expect(await engine.settleAbandonedSwap(p, [p], (c) => logs.push(c))).toBe("stopped");
      expect(docker.boxes.get(names("app-next"))).toMatchObject({ running: false });
      expect(docker.boxes.get(names("app"))).toMatchObject({ running: false });
      expect(docker.calls.some((c) => c[0] === "rm" || c[0] === "rename")).toBe(false);
      expect(upstreams).toEqual([]);
      expect(logs.join("")).toContain("parado pela pessoa");
    });

    it("defesa extra: mesmo sem resolver a sobra antes, a nova nunca recebe um apelido que a sobra já usa", async () => {
      docker.add(names("app"), { aliases: ["loja", "loja--b", names("app")] });
      docker.add(names("app-next"), { aliases: ["loja", "loja--a"] });
      const p = project("node-server");
      await engine.deploy(p, [p], () => undefined);
      const run = docker.calls.find((c) => c[0] === "run")!;
      expect(run[run.indexOf("--network-alias") + 1]).toBe("loja--c");
    });
  });

  it("primeiro deploy (nada no ar): sobe direto, sem troca", async () => {
    const { error, logs } = await runDeploy(project("node-server"));
    expect(error).toBeNull();
    expect(logs).toContain("não há versão no ar para trocar");
    expect(docker.boxes.get(names("app"))).toMatchObject({ running: true });
    expect(docker.calls.some((c) => c.includes(names("app-next")))).toBe(false);
  });

  it("atual publica porta no servidor: cai no modo de sempre sem falhar o deploy", async () => {
    docker.add(names("app"), { ports: { "3000/tcp": [{ HostPort: "3000" }] } });
    const { error, logs } = await runDeploy(project("node-server"));
    expect(error).toBeNull();
    expect(logs).toContain("Troca sem queda indisponível");
    expect(logs).toContain("3000/tcp");
    expect(docker.calls.some((c) => c.includes(names("app-next")))).toBe(false);
  });

  it("depois da troca o health check final reprova: rollback de sempre (nova sai, anterior religa) e é registrado", async () => {
    docker.add(names("app"), { aliases: ["loja", names("app")] });
    healthMock.mockRejectedValue(new Error("health check falhou"));
    const { error, logs } = await runDeploy(project("node-server"));
    expect(error?.message).toContain("health check falhou");
    expect(ran("rename", names("app-previous"), names("app"))).toBe(true);
    expect(docker.boxes.get(names("app"))).toMatchObject({ running: true });
    expect(logs).toContain("religada");
    expect(engine.takeRestored("p1")).toBe(true);
    expect(engine.takeRestored("p1")).toBe(false);
  });
});

describe("Next.js com a Porta alterada (3000 → 3001)", () => {
  const changed = () => project("node-server", { proxyPort: 3001 });
  const oldApp = () => docker.add(names("app"), { aliases: ["loja", names("app")], env: "PORT=3000\nNODE_ENV=production\n" });

  it("pinServingPort grava a porta do container no ar; o proxy segue nela; limpa quando volta a ser a configurada", async () => {
    oldApp();
    const p = changed();
    await engine.pinServingPort(p);
    expect(p.servingPort).toBe(3000);
    expect(engine.upstreamFor(p)).toBe("loja:3000");
    const same = project("node-server");
    same.servingPort = 3000; // sobra de um deploy revertido, mas o container no ar escuta na configurada
    await engine.pinServingPort(same);
    expect(same.servingPort).toBeUndefined();
  });

  it("pinServingPort não mexe sem container rodando, sem PORT legível ou fora do Next.js; nunca lança", async () => {
    const p = changed();
    await engine.pinServingPort(p);
    expect(p.servingPort).toBeUndefined();
    docker.add(names("app"), { running: false, env: "PORT=3000\n" });
    await engine.pinServingPort(p);
    expect(p.servingPort).toBeUndefined();
    docker.add(names("app"), { env: "NODE_ENV=production\n" });
    await engine.pinServingPort(p);
    expect(p.servingPort).toBeUndefined();
    const d = project("dockerfile", { proxyPort: 3001 });
    await engine.pinServingPort(d);
    expect(d.servingPort).toBeUndefined();
    const base = docker.fn;
    docker.fn = async () => {
      throw new Error("docker caiu");
    };
    await expect(engine.pinServingPort(changed())).resolves.toBeUndefined();
    docker.fn = base;
  });

  it("sucesso: modo de sempre (uma versão não atende nas duas portas), proxy na porta nova só no fim e servingPort limpo", async () => {
    oldApp();
    const p = changed();
    await engine.pinServingPort(p);
    const { error, logs } = await runDeploy(p);
    expect(error).toBeNull();
    expect(logs).toContain("a Porta do projeto mudou (3000 → 3001)");
    expect(docker.calls.some((c) => c.includes(names("app-next")))).toBe(false);
    expect(upstreams).toEqual(["loja:3001"]);
    expect(p.servingPort).toBeUndefined();
  });

  it("falha: o site volta e FICA na porta antiga (servingPort e proxy), sem cair na porta nova", async () => {
    oldApp();
    const p = changed();
    await engine.pinServingPort(p);
    healthMock.mockRejectedValue(new Error("health check falhou"));
    const { error } = await runDeploy(p);
    expect(error).not.toBeNull();
    expect(p.servingPort).toBe(3000);
    expect(engine.upstreamFor(p)).toBe("loja:3000");
    expect(upstreams.at(-1)).toBe("loja:3000");
  });

  it("Recriar depois disso explica o caso real (porta diferente da configurada), sem dizer que foi revertida", async () => {
    oldApp();
    const p = changed();
    await engine.pinServingPort(p);
    await expect(engine.recreate(p, () => undefined)).rejects.toThrow(/segue na versão anterior, na porta 3000 \(a Porta configurada agora é 3001\)/);
    const reverted = project("node-server");
    reverted.servingPort = 3000; // rollback na mesma porta
    await expect(engine.recreate(reverted, () => undefined)).rejects.toThrow(/foi revertida/);
  });
});

describe("Dockerfile", () => {
  it("padrão desligado (processo qualquer): comportamento de sempre", async () => {
    docker.add(names("app"));
    const { error, logs } = await runDeploy(project("dockerfile"));
    expect(error).toBeNull();
    expect(logs).toContain("Troca sem queda desligada");
    expect(docker.calls.some((c) => c.includes(names("app-next")))).toBe(false);
  });

  it("ligado pelo usuário: troca sem queda, anterior guardada e removida no fim", async () => {
    docker.add(names("app"), { aliases: ["loja", names("app")] });
    const { error } = await runDeploy(project("dockerfile", { zeroDowntime: true }));
    expect(error).toBeNull();
    expect(upstreams).toEqual(["loja--a:3000", "loja:3000"]);
    expect(docker.boxes.has(names("app-previous"))).toBe(false);
    expect(docker.boxes.get(names("app"))).toMatchObject({ running: true });
  });

  it("ligado e o health check final reprova: a anterior volta (rollback)", async () => {
    docker.add(names("app"), { aliases: ["loja", names("app")] });
    healthMock.mockRejectedValue(new Error("health check falhou"));
    const p = project("dockerfile", { zeroDowntime: true });
    const { error } = await runDeploy(p);
    expect(error).not.toBeNull();
    expect(ran("rename", names("app-previous"), names("app"))).toBe(true);
    expect(engine.takeRestored("p1")).toBe(true);
    expect(p.servingPort).toBeUndefined(); // servingPort é só do Next.js
  });
});

describe("site estático", () => {
  const web = names("web");

  it("troca sem queda: publica na outra pasta, a antiga sai, a anterior é removida (não há previous)", async () => {
    const main = path.join(workDir, "site");
    await mkdir(main, { recursive: true });
    await writeFile(path.join(main, "index.html"), "antigo");
    docker.add(web, { aliases: ["loja", web], mountSource: main });
    const { error } = await runDeploy(project("static", { detection: { type: "static" } as never }));
    expect(error).toBeNull();
    const run = docker.calls.find((c) => c[0] === "run")!;
    expect(run).toContain(names("web-next"));
    expect(run.some((a) => a.startsWith(`${path.join(workDir, "paas.site-next")}:`))).toBe(true);
    expect(existsSync(path.join(workDir, "paas.site-next", "index.html"))).toBe(true);
    expect(existsSync(main)).toBe(false); // a pasta que servia a versão anterior saiu
    expect(upstreams).toEqual(["loja--a:80", "loja:80"]);
    expect([...docker.boxes.keys()]).toEqual([web]);
  });

  it("na troca seguinte volta para a pasta principal", async () => {
    const alt = path.join(workDir, "paas.site-next");
    await mkdir(alt, { recursive: true });
    docker.add(web, { aliases: ["loja", web], mountSource: alt });
    const { error } = await runDeploy(project("static", { detection: { type: "static" } as never }));
    expect(error).toBeNull();
    expect(existsSync(path.join(workDir, "site", "index.html"))).toBe(true);
    expect(existsSync(alt)).toBe(false);
  });

  it("pasta servida desconhecida: usa a principal e não apaga nada", async () => {
    docker.add(web, { aliases: ["loja", web], mountSource: "" });
    const { error } = await runDeploy(project("static", { detection: { type: "static" } as never }));
    expect(error).toBeNull();
    expect(existsSync(path.join(workDir, "site", "index.html"))).toBe(true);
  });

  it("nova não responde: a antiga e a pasta dela ficam intactas", async () => {
    const main = path.join(workDir, "site");
    await mkdir(main, { recursive: true });
    await writeFile(path.join(main, "index.html"), "antigo");
    docker.add(web, { aliases: ["loja", web], mountSource: main });
    docker.probeStatus = null;
    const { error } = await runDeploy(project("static", { detection: { type: "static" } as never }));
    expect(error).not.toBeNull();
    expect(existsSync(path.join(main, "index.html"))).toBe(true);
    expect(docker.boxes.get(web)).toMatchObject({ running: true });
    expect(upstreams).toEqual([]);
  });

  it("ajuste desligado: serve a pasta de sempre e remove o container antes", async () => {
    docker.add(web, { mountSource: path.join(workDir, "site") });
    const { error } = await runDeploy(project("static", { zeroDowntime: false, detection: { type: "static" } as never }));
    expect(error).toBeNull();
    expect(docker.calls.some((c) => c.includes(names("web-next")))).toBe(false);
    expect(existsSync(path.join(workDir, "site", "index.html"))).toBe(true);
  });

  it("ajuste desligado com o site servido da pasta alternada: publica NELA, sem esquecer pasta nenhuma", async () => {
    const alt = path.join(workDir, "paas.site-next");
    await mkdir(alt, { recursive: true });
    docker.add(web, { aliases: ["loja", web], mountSource: alt });
    const { error } = await runDeploy(project("static", { zeroDowntime: false, detection: { type: "static" } as never }));
    expect(error).toBeNull();
    expect(existsSync(path.join(alt, "index.html"))).toBe(true);
    expect(existsSync(path.join(workDir, "site"))).toBe(false);
    const run = docker.calls.find((c) => c[0] === "run")!;
    expect(run.some((a) => a.startsWith(`${alt}:`))).toBe(true);
  });
});

describe("recuperação no boot (recoverInterruptedDeploy)", () => {
  const recover = (p: Project) => engine.recoverInterruptedDeploy(p, () => undefined, "2026-01-01T00:00:00.000Z");

  it("nova sobrando ao lado da atual: removida, o site segue", async () => {
    docker.add(names("app"), { aliases: ["loja", names("app")] });
    docker.add(names("app-next"), { aliases: ["loja--a"] });
    expect(await recover(project("node-server"))).toEqual({ outcome: "running" });
    expect(docker.boxes.has(names("app-next"))).toBe(false);
  });

  it("anterior parada e nova rodando: a nova é mantida", async () => {
    docker.add(names("app-previous"), { running: false });
    docker.add(names("app-next"), { aliases: ["loja--a"] });
    expect(await recover(project("node-server"))).toEqual({ outcome: "promoted" });
    expect(docker.boxes.get(names("app"))).toMatchObject({ running: true });
  });

  it("anterior ainda rodando e sem atual: volta ao nome de sempre", async () => {
    docker.add(names("app-previous"));
    expect(await recover(project("node-server"))).toEqual({ outcome: "running" });
    expect(docker.boxes.has(names("app"))).toBe(true);
    expect(docker.boxes.has(names("app-previous"))).toBe(false);
  });

  it("anterior rodando e um -app PARADO ocupa o nome: o parado sai e o que atende volta ao nome (nunca fica só como previous)", async () => {
    docker.add(names("app"), { running: false });
    docker.add(names("app-previous"));
    const logs: string[] = [];
    expect(await engine.recoverInterruptedDeploy(project("node-server"), (c) => logs.push(c), "2026-01-01T00:00:00.000Z")).toEqual({ outcome: "running" });
    expect(docker.boxes.get(names("app"))).toMatchObject({ running: true });
    expect(docker.boxes.has(names("app-previous"))).toBe(false);
    expect(logs.join("")).not.toContain("Aviso");
  });

  it("não consegue devolver o nome nem assim: avisa e não finge", async () => {
    docker.add(names("app-previous"));
    docker.failWhen = (a) => (a[0] === "rename" ? { code: 1, stdout: "", stderr: "busy" } : undefined);
    const logs: string[] = [];
    expect(await engine.recoverInterruptedDeploy(project("node-server"), (c) => logs.push(c), "2026-01-01T00:00:00.000Z")).toEqual({ outcome: "running" });
    expect(logs.join("")).toContain("segue no ar como paas-loja-app-previous");
    expect(docker.boxes.has(names("app-previous"))).toBe(true);
  });

  it("estático: nova rodando e a antiga já removida → promovida", async () => {
    docker.add(names("web-next"), { aliases: ["loja--a"] });
    expect(await recover(project("static"))).toEqual({ outcome: "promoted" });
    expect(docker.boxes.get(names("web"))).toMatchObject({ running: true });
  });
});

describe("parar, iniciar e remover ignoram o container temporário", () => {
  it("projectContainers não inclui -next; remove apaga os temporários", async () => {
    const label = (n: string) => `id-${n}`;
    const listing = ["app", "app-next", "app-previous", "web-next"].map((n) => `${label(n)} paas-loja-${n} `).join("\n");
    const base = docker.fn;
    docker.fn = async (args) => (args[0] === "ps" && args.includes("--format") ? { code: 0, stdout: listing, stderr: "" } : base(args));
    const ids = await engine.projectContainers(project("node-server"));
    expect(ids).toEqual(["id-app"]);
    // parar/remover enxergam também o container novo de uma troca interrompida
    expect(await engine.projectContainers(project("node-server"), { withTemporary: true })).toEqual(["id-app", "id-app-next", "id-web-next"]);
    docker.add(names("app-next"));
    docker.add(names("web-next"));
    await engine.remove(project("node-server"), () => undefined);
    expect(docker.boxes.has(names("app-next"))).toBe(false);
    expect(docker.boxes.has(names("web-next"))).toBe(false);
  });
});
