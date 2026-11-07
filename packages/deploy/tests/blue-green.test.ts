/**
 * Troca sem queda (blue-green.ts): sucesso, saúde, timeout, falha em cada fase e recuperação depois de uma
 * interrupção. O Docker é um simulador em memória: containers com nome, estado, apelidos de rede e saúde.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { FakeDocker, bad, ok, type Box } from "./fake-docker.js";
import {
  SwapHealthError,
  caddyExecProbe,
  ensureAliases,
  performSwap,
  pickNextAlias,
  promoteNext,
  recoverSwap,
  swapEligibility,
  swapNames,
  type DockerFn,
  type SwapDeps,
} from "../src/blue-green.js";

const names = swapNames("paas-loja", "loja", false);
const webNames = swapNames("paas-loja", "loja", true);

let docker: FakeDocker;
let clock: number;
let logs: string[];
let probeResults: Array<number | null>;
let repoints: string[];
let repointFails: (up: string) => boolean;

function deps(over: Partial<SwapDeps> = {}, n = names): SwapDeps {
  return {
    docker: docker.fn,
    log: (c) => logs.push(c),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    probe: async () => (probeResults.length > 1 ? probeResults.shift()! : (probeResults[0] ?? null)),
    start: async () => {
      docker.add(n.next, { aliases: [n.nextAlias] });
    },
    repoint: async (up) => {
      repoints.push(up);
      if (repointFails(up)) throw new Error("O Caddy recusou a configuração");
    },
    ...over,
  };
}

const text = () => logs.join("");

beforeEach(() => {
  docker = new FakeDocker();
  clock = 0;
  logs = [];
  probeResults = [200];
  repoints = [];
  repointFails = () => false;
});

describe("nomes", () => {
  it("app tem previous; estático não; o apelido temporário nunca é um slug possível", () => {
    expect(names).toMatchObject({ current: "paas-loja-app", next: "paas-loja-app-next", previous: "paas-loja-app-previous", nextAlias: "loja--a" });
    expect(webNames).toMatchObject({ current: "paas-loja-web", next: "paas-loja-web-next", previous: null });
  });
});

describe("swapEligibility", () => {
  it("sem container no ar (inexistente ou parado): nada a trocar", async () => {
    expect(await swapEligibility(docker.fn, names)).toEqual({ ok: false, reason: "none" });
    docker.add(names.current, { running: false });
    expect(await swapEligibility(docker.fn, names)).toEqual({ ok: false, reason: "none" });
  });

  it("container comum: elegível; volume anônimo da imagem e montagem somente leitura não contam", async () => {
    docker.add(names.current, {
      ports: { "3000/tcp": [] },
      mounts: [
        { Type: "volume", Name: "a".repeat(64), RW: true, Destination: "/var/lib/x" },
        { Type: "bind", RW: false, Destination: "/usr/share/nginx/html" },
      ],
    });
    expect(await swapEligibility(docker.fn, names)).toEqual({ ok: true });
  });

  it("porta publicada no servidor: indisponível, com a porta no detalhe", async () => {
    docker.add(names.current, { ports: { "80/tcp": [{ HostPort: "8080" }] } });
    expect(await swapEligibility(docker.fn, names)).toEqual({ ok: false, reason: "ports", detail: "80/tcp" });
  });

  it("volume nomeado ou pasta do servidor gravável (SQLite, lock): indisponível", async () => {
    docker.add(names.current, { mounts: [{ Type: "volume", Name: "dados", RW: true, Destination: "/data" }] });
    expect(await swapEligibility(docker.fn, names)).toEqual({ ok: false, reason: "volume", detail: "/data" });
    docker.add(names.current, { mounts: [{ Type: "bind", RW: true, Destination: "/uploads" }] });
    expect(await swapEligibility(docker.fn, names)).toEqual({ ok: false, reason: "volume", detail: "/uploads" });
    docker.add(names.current, { mounts: [{ Type: "volume", RW: true, Destination: "/sem-nome" }] });
    expect(await swapEligibility(docker.fn, names)).toMatchObject({ ok: false, reason: "volume" });
  });

  it("inspeção ilegível conta como nada no ar", async () => {
    const weird: DockerFn = async () => ok("não é json");
    expect(await swapEligibility(weird, names)).toEqual({ ok: false, reason: "none" });
    const empty: DockerFn = async () => ok("[]");
    expect(await swapEligibility(empty, names)).toEqual({ ok: false, reason: "none" });
    const scalar: DockerFn = async () => ok("[1]");
    expect(await swapEligibility(scalar, names)).toEqual({ ok: false, reason: "none" });
  });
});

describe("detalhes defensivos", () => {
  it("PortBindings nulo e montagem sem destino não derrubam a conferência; erro que não é Error vira texto", async () => {
    const raw = (state: object): DockerFn => async (args) => (args[1] === "-f" ? ok("true") : ok(JSON.stringify([state])));
    expect(await swapEligibility(raw({ State: { Running: true }, HostConfig: { PortBindings: null } }), names)).toEqual({ ok: true });
    expect(await swapEligibility(raw({ State: { Running: true } }), names)).toEqual({ ok: true });
    expect(await swapEligibility(raw({ State: { Running: true }, Mounts: [{ Type: "bind", RW: true }] }), names)).toMatchObject({ ok: false, reason: "volume" });
    docker.add(names.current);
    const out: string[] = [];
    await expect(
      performSwap(deps({ log: (c) => out.push(c), probe: async () => Promise.reject("texto solto") }), names, { port: 3000, drainMs: 0 }),
    ).rejects.toBe("texto solto");
    expect(out.join("")).toContain("texto solto");
  });
});

describe("caddyExecProbe", () => {
  it("lê o último status dos cabeçalhos do wget (mesmo com 4xx/5xx) e devolve null sem resposta", async () => {
    const calls: string[][] = [];
    const timeouts: Array<number | undefined> = [];
    const answer = (stderr: string, code = 0): DockerFn => async (a, o) => {
      calls.push(a);
      timeouts.push(o?.timeoutMs);
      return { code, stdout: "", stderr };
    };
    const probe = (stderr: string, code?: number) => caddyExecProbe(answer(stderr, code), "paas-caddy")("loja--a", 3000);
    expect(await probe("  HTTP/1.1 301 Moved\n  HTTP/1.1 200 OK\n")).toBe(200);
    expect(await probe("  HTTP/1.1 503 Service Unavailable\nwget: server returned error", 1)).toBe(503);
    expect(await probe("wget: can't connect to remote host", 1)).toBeNull();
    // o prazo é de verdade: limite no cliente do Docker (o padrão seria 300 s) e `timeout` dentro do Caddy
    expect(timeouts[0]).toBe(8000);
    expect(calls[0]).toEqual(["exec", "paas-caddy", "timeout", "5", "wget", "--spider", "-S", "-T", "3", "-t", "1", "http://loja--a:3000/"]);
  });
});

describe("ensureAliases / promoteNext", () => {
  it("já tem o apelido: não mexe; sem inspeção legível: não mexe", async () => {
    docker.add(names.current, { aliases: ["loja", "loja--a"] });
    expect(await ensureAliases(docker.fn, names.current, names)).toBe(false);
    expect(docker.ran("network")).toBe(false);
    expect(await ensureAliases(docker.fn, "inexistente", names)).toBe(false);
  });

  it("versão de antes da rede do proxy por projeto, na paas-net com o apelido: não é ligada à rede nova (o IP do proxy que ela conhece é o da paas-net)", async () => {
    const calls: string[][] = [];
    const nets = (n: Record<string, { Aliases: string[] }>): DockerFn => async (args) => {
      calls.push(args);
      return { code: 0, stdout: JSON.stringify([{ NetworkSettings: { Networks: n } }]), stderr: "" };
    };
    expect(await ensureAliases(nets({ "paas-net": { Aliases: ["loja"] } }), "velho", names)).toBe(false);
    expect(calls.filter((a) => a[0] === "network")).toEqual([]);
    // na paas-net SEM o apelido: liga à rede do projeto normalmente
    expect(await ensureAliases(nets({ "paas-net": { Aliases: ["outro"] } }), "velho", names)).toBe(true);
    expect(calls.filter((a) => a[0] === "network")).toEqual([["network", "connect", "--alias", "loja", "paas-proxy-loja", "velho"]]);
  });

  it("sem o apelido: sai da rede e volta com os dois; fora da rede: só entra; tenta de novo uma vez", async () => {
    docker.add("c", { aliases: ["loja--a"] });
    expect(await ensureAliases(docker.fn, "c", names)).toBe(true);
    expect(docker.boxes.get("c")!.aliases).toContain("loja");
    docker.add("d", { aliases: null });
    docker.calls = [];
    expect(await ensureAliases(docker.fn, "d", names)).toBe(true);
    expect(docker.ran("network", "disconnect")).toBe(false);
    let attempts = 0;
    docker.failWhen = (a) => (a[0] === "network" && a[1] === "connect" && attempts++ === 0 ? bad("tente de novo") : undefined);
    docker.add("e", { aliases: null });
    expect(await ensureAliases(docker.fn, "e", names)).toBe(true);
    docker.failWhen = (a) => (a[0] === "network" && a[1] === "connect" ? bad("sem rede") : undefined);
    docker.add("f", { aliases: null });
    await expect(ensureAliases(docker.fn, "f", names)).rejects.toThrow(/não consegui ligar f à rede paas-proxy-loja/);
  });

  it("promoteNext: apelido e nome definitivos; renomear falhando lança", async () => {
    docker.add(names.next, { aliases: [names.nextAlias] });
    await promoteNext(docker.fn, names);
    expect(docker.boxes.get(names.current)!.aliases).toContain("loja");
    docker.add(names.next);
    docker.failWhen = (a) => (a[0] === "rename" ? bad("conflito") : undefined);
    await expect(promoteNext(docker.fn, names)).rejects.toThrow(/não consegui renomear/);
  });
});

describe("apelido temporário exclusivo por troca", () => {
  it("escolhe o que o container no ar NÃO tem; o legado --next e a leitura impossível também funcionam", async () => {
    docker.add(names.current, { aliases: ["loja", "loja--a"] });
    expect((await pickNextAlias(docker.fn, names)).nextAlias).toBe("loja--b");
    docker.add("outro", { aliases: ["loja", "loja--b"] });
    expect((await pickNextAlias(docker.fn, { ...names, current: "outro" })).nextAlias).toBe("loja--a");
    docker.add("legado", { aliases: ["loja", "loja--next"] });
    expect((await pickNextAlias(docker.fn, { ...names, current: "legado" })).nextAlias).toBe("loja--a");
    expect((await pickNextAlias(docker.fn, { ...names, current: "inexistente" })).nextAlias).toBe("loja--a");
    docker.add("fora", { aliases: null });
    expect((await pickNextAlias(docker.fn, { ...names, current: "fora" })).nextAlias).toBe("loja--a");
  });

  it("conta também os apelidos na paas-net (container de antes da rede do proxy por projeto)", async () => {
    const docker = new FakeDocker();
    docker.network = "paas-net";
    docker.add("paas-loja-app", { aliases: ["loja", "loja--a"] });
    expect((await pickNextAlias(docker.fn, names)).nextAlias).toBe("loja--b");
  });

  it("swapNames: a troca usa a rede do proxy do projeto", () => {
    expect(names.network).toBe("paas-proxy-loja");
    expect(swapNames("paas-blog", "blog", true).network).toBe("paas-proxy-blog");
  });

  it("nenhum container RODANDO do projeto pode ter o apelido (atual, sobra do -next); o anterior parado não conta", async () => {
    docker.add(names.current, { aliases: ["loja", "loja--b"] });
    docker.add(names.next, { aliases: ["loja", "loja--a"] });
    expect((await pickNextAlias(docker.fn, names)).nextAlias).toBe("loja--c");
    docker.boxes.get(names.next)!.running = false;
    expect((await pickNextAlias(docker.fn, names)).nextAlias).toBe("loja--a");
    docker.add(names.previous!, { aliases: ["loja", "loja--a"], running: true });
    expect((await pickNextAlias(docker.fn, names)).nextAlias).toBe("loja--c");
    docker.boxes.get(names.previous!)!.running = false;
    expect((await pickNextAlias(docker.fn, webNames)).nextAlias).toBe("loja--a");
  });

  it("ensureAliases preserva o temporário que o container já tem", async () => {
    docker.add("c", { aliases: ["loja--b"] });
    await ensureAliases(docker.fn, "c", names);
    expect(docker.boxes.get("c")!.aliases).toEqual(expect.arrayContaining(["loja", "loja--b"]));
  });

  async function swapOnce(n: SwapNames, newBox: Partial<Box> = {}, over: Partial<SwapDeps> = {}) {
    const picked = await pickNextAlias(docker.fn, n);
    await performSwap(
      deps(
        {
          probe: caddyExecProbe(docker.fn, "paas-caddy"),
          start: async () => void docker.add(picked.next, { aliases: [picked.nextAlias], ...newBox }),
          ...over,
        },
        picked,
      ),
      picked,
      { port: 3000, drainMs: 0, healthTimeoutMs: 4000 },
    );
    return picked;
  }

  for (const [label, n] of [["Next.js", names], ["estático", webNames]] as const) {
    it(`${label}: trocas seguidas (a partir de um container com o apelido legado) nunca sondam a versão que está no ar`, async () => {
      docker.add(n.current, { aliases: ["loja", "loja--next"], probeStatus: 200 });
      // troca 1: boa; a antiga (legado) responde 200 e a nova também, mas só a nova pode ser atingida
      expect((await swapOnce(n)).nextAlias).toBe("loja--a");
      expect(docker.probeHits.length).toBeGreaterThan(0);
      expect(new Set(docker.probeHits)).toEqual(new Set([n.next]));
      // troca 2: a nova está quebrada (não responde); a antiga no ar responde 200 e NÃO pode mascarar isso
      docker.probeHits = [];
      await expect(swapOnce(n, { probeStatus: null })).rejects.toThrow(SwapHealthError);
      expect(new Set(docker.probeHits)).toEqual(new Set([n.next]));
      expect(docker.boxes.get(n.current)).toMatchObject({ running: true });
      expect(docker.boxes.has(n.next)).toBe(false);
      // troca 3: boa, usa de novo o alternado
      docker.probeHits = [];
      expect((await swapOnce(n)).nextAlias).toBe("loja--b");
      expect(new Set(docker.probeHits)).toEqual(new Set([n.next]));
      // troca 4: quebrada de novo, agora com o --b no ar
      docker.probeHits = [];
      await expect(swapOnce(n, { probeStatus: null })).rejects.toThrow(SwapHealthError);
      expect(new Set(docker.probeHits)).toEqual(new Set([n.next]));
      expect(repoints.filter((u) => u.includes("--next"))).toEqual([]);
    });
  }

  it("o simulador alterna entre TODOS os containers que têm o apelido (prova de que o compartilhado seria pego)", async () => {
    docker.add("v1", { aliases: ["compartilhado"] });
    docker.add("v2", { aliases: ["compartilhado"] });
    const probe = caddyExecProbe(docker.fn, "paas-caddy");
    await probe("compartilhado", 3000);
    await probe("compartilhado", 3000);
    expect(new Set(docker.probeHits)).toEqual(new Set(["v1", "v2"]));
  });
});

describe("performSwap · sucesso", () => {
  it("Next/Dockerfile: sobe ao lado, confere, liga ao apelido do projeto, guarda a anterior parada e a nova assume o nome", async () => {
    docker.add(names.current);
    await performSwap(deps(), names, { port: 3000, drainMs: 2000 });
    expect(docker.boxes.get(names.current)).toMatchObject({ running: true });
    expect(docker.boxes.get(names.current)!.aliases).toContain("loja");
    expect(docker.boxes.get(names.previous!)).toMatchObject({ running: false });
    expect(docker.boxes.has(names.next)).toBe(false);
    expect(clock).toBe(2000); // drenagem
    const out = text();
    for (const n of [1, 2, 3, 4]) expect(out).toContain(`=== Troca sem queda · fase ${n}/4`);
    expect(out).toContain("Subindo nova versão");
    expect(out).toContain("Desligando versão anterior");
  });

  it("sem mistura de versões: o Caddy vai para o apelido temporário logo após ligar o apelido do projeto, antes da anterior parar", async () => {
    docker.add(names.current);
    const order: string[] = [];
    const base = docker.fn;
    docker.fn = async (a) => {
      if (a[0] === "network") order.push(`${a[1]}:${a[a.length - 1]}`);
      if (a[0] === "stop") order.push("stop");
      return base(a);
    };
    await performSwap(
      deps({
        docker: docker.fn,
        repoint: async (up) => void order.push(`repoint:${up}`),
      }),
      names,
      { port: 3000, drainMs: 0 },
    );
    // a nova só sai/entra da rede ANTES de o Caddy usá-la; depois do repoint nunca mais desconecta
    expect(order).toEqual([`disconnect:${names.next}`, `connect:${names.next}`, "repoint:loja--a:3000", "stop"]);
    expect(docker.boxes.get(names.current)!.aliases).toEqual(expect.arrayContaining(["loja", "loja--a"]));
  });

  it("durante a drenagem o Caddy já está no apelido que só a nova tem, com a anterior ainda de pé", async () => {
    docker.add(names.current, { aliases: ["loja", names.current] });
    let during: { repoints: string[]; oldRunning: boolean } | null = null;
    await performSwap(
      deps({
        sleep: async (ms) => {
          clock += ms;
          if (ms === 4000) during = { repoints: [...repoints], oldRunning: docker.boxes.get(names.current)!.running };
        },
      }),
      names,
      { port: 3000, drainMs: 4000 },
    );
    expect(during).toEqual({ repoints: ["loja--a:3000"], oldRunning: true });
    expect(text()).toContain("Tráfego na versão nova");
    expect(text()).toContain("Versão nova saudável (verificação: resposta HTTP 200");
  });

  it("a nova deixa de responder depois do reaponte: Caddy volta, a nova sai da rede antes de ser removida e a atual segue", async () => {
    docker.add(names.current);
    let probes = 0;
    const order: string[] = [];
    const base = docker.fn;
    docker.fn = async (a) => {
      if (a[0] === "network" && a[1] === "disconnect") order.push("disconnect");
      if (a[0] === "stop") order.push(`stop:${a[1]}`);
      if (a[0] === "rm" && a[2] === names.next) order.push("rm");
      return base(a);
    };
    const waits: number[] = [];
    await expect(
      performSwap(
        deps({
          docker: docker.fn,
          probe: async () => (++probes === 1 ? 200 : null),
          sleep: async (ms) => {
            waits.push(ms);
            order.push("sleep");
            clock += ms;
          },
        }),
        names,
        { port: 3000, drainMs: 0 },
      ),
    ).rejects.toThrow(/deixou de responder/);
    expect(repoints).toEqual(["loja--a:3000", "loja:3000"]);
    // depois do Caddy voltar: espera 3 s, para a nova com `stop` (graciosa), sai da rede e só então é removida
    expect(order.slice(-4)).toEqual(["sleep", `stop:${names.next}`, "disconnect", "rm"]);
    expect(waits.at(-1)).toBe(3000);
    expect(docker.boxes.has(names.next)).toBe(false);
    expect(docker.boxes.get(names.current)).toMatchObject({ running: true });
    expect(docker.calls.some((c) => c[0] === "stop" && c[1] === names.current)).toBe(false);
  });

  it("Caddy recusa o reaponte: aponta de volta, remove a nova, a atual segue", async () => {
    docker.add(names.current);
    repointFails = (up) => up.startsWith("loja--a");
    await expect(performSwap(deps(), names, { port: 3000, drainMs: 0 })).rejects.toThrow(/Caddy recusou/);
    expect(repoints).toEqual(["loja--a:3000", "loja:3000"]);
    expect(docker.boxes.has(names.next)).toBe(false);
    expect(docker.boxes.get(names.current)!.running).toBe(true);
    expect(text()).toContain("A versão anterior segue no ar");
  });

  it("nem apontar de volta funciona: a nova é mantida (nunca remove o único destino possível)", async () => {
    docker.add(names.current);
    repointFails = () => true;
    await expect(performSwap(deps(), names, { port: 3000, drainMs: 0 })).rejects.toThrow(/Caddy recusou/);
    expect(docker.boxes.has(names.next)).toBe(true);
    expect(docker.boxes.get(names.current)!.running).toBe(true);
    expect(text()).toContain("mantida no ar e o proxy segue nela");
    // sem o Caddy de volta, a nova NÃO sai da rede nem para: o proxy ainda aponta para ela
    expect(docker.boxes.get(names.next)).toMatchObject({ running: true });
    expect(docker.boxes.get(names.next)!.aliases).not.toBeNull();
  });

  it("ligar o apelido falha: desfaz do mesmo jeito", async () => {
    docker.add(names.current);
    docker.failWhen = (a) => (a[0] === "network" && a[1] === "connect" ? bad("sem rede") : undefined);
    await expect(performSwap(deps(), names, { port: 3000, drainMs: 0 })).rejects.toThrow(/sem rede/);
    expect(docker.boxes.has(names.next)).toBe(false);
    expect(docker.boxes.get(names.current)!.running).toBe(true);
  });

  it("estático: a anterior é removida, sem previous", async () => {
    docker.add(webNames.current);
    await performSwap(deps({ start: async () => docker.add(webNames.next, { aliases: [webNames.nextAlias] }) }, webNames), webNames, { port: 80, drainMs: 0 });
    expect([...docker.boxes.keys()]).toEqual([webNames.current]);
    expect(docker.boxes.get(webNames.current)!.aliases).toContain("loja");
  });

  it("sobra de uma troca anterior (-next) é limpa antes; previous antigo é substituído", async () => {
    docker.add(names.current);
    docker.add(names.next, { running: false });
    docker.add(names.previous!, { running: false });
    await performSwap(deps(), names, { port: 3000, drainMs: 0 });
    expect(docker.boxes.get(names.current)!.running).toBe(true);
    expect(docker.boxes.get(names.previous!)!.running).toBe(false);
  });
});

describe("performSwap · saúde", () => {
  beforeEach(() => docker.add(names.current));

  it("responde 4xx na raiz: o app está de pé; 5xx e sem resposta esperam até responder", async () => {
    probeResults = [null, 502, 404];
    await performSwap(deps(), names, { port: 3000, drainMs: 0 });
    expect(docker.boxes.get(names.current)!.running).toBe(true);
    expect(clock).toBe(2000); // dois ciclos de espera
  });

  it("HEALTHCHECK em starting mas o app responde desde o início: aceita a sonda depois de 30 s e explica no log", async () => {
    await performSwap(
      deps({ start: async () => docker.add(names.next, { aliases: [names.nextAlias], health: "starting" }) }),
      names,
      { port: 3000, drainMs: 0 },
    );
    expect(text()).toMatch(/verificação: resposta HTTP 200 na porta 3000 \(o HEALTHCHECK do Docker não confirmou: starting; aceito porque o app responde\)/);
    expect(clock).toBeGreaterThanOrEqual(30_000);
    expect(clock).toBeLessThan(40_000); // não espera os 90 s do prazo
    expect(docker.boxes.get(names.current)!.running).toBe(true);
  });

  it("HEALTHCHECK unhealthy mas o app responde: aceita a sonda na hora; unhealthy e sem resposta reprova citando as duas", async () => {
    await performSwap(
      deps({ start: async () => docker.add(names.next, { aliases: [names.nextAlias], health: "unhealthy" }) }),
      names,
      { port: 3000, drainMs: 0 },
    );
    expect(docker.boxes.get(names.current)!.running).toBe(true);
    expect(text()).toContain("não confirmou: unhealthy");
    probeResults = [null];
    await expect(
      performSwap(deps({ start: async () => docker.add(names.next, { aliases: [names.nextAlias], health: "unhealthy" }) }), names, { port: 3000, drainMs: 0 }),
    ).rejects.toThrow(/HEALTHCHECK do Docker: unhealthy; sonda HTTP: sem resposta na porta 3000/);
    probeResults = [503];
    await expect(
      performSwap(deps({ start: async () => docker.add(names.next, { aliases: [names.nextAlias], health: "starting" }) }), names, { port: 3000, healthTimeoutMs: 0 }),
    ).rejects.toThrow(/sonda HTTP: HTTP 503 na porta 3000/);
  });

  it("a sonda que falha no meio zera a contagem dos 30 s", async () => {
    probeResults = [200, 200, null, 200];
    await performSwap(
      deps({ start: async () => docker.add(names.next, { aliases: [names.nextAlias], health: "starting" }) }),
      names,
      { port: 3000, drainMs: 0 },
    );
    expect(clock).toBeGreaterThanOrEqual(33_000);
  });

  it("HEALTHCHECK do Docker manda: starting espera, healthy passa", async () => {
    let polls = 0;
    const base = docker.fn;
    docker.fn = async (a) => {
      if (a[0] === "inspect" && a.length === 2 && a[1] === names.next && ++polls === 2) docker.boxes.get(names.next)!.health = "healthy";
      return base(a);
    };
    await performSwap(
      deps({ docker: docker.fn, start: async () => docker.add(names.next, { aliases: [names.nextAlias], health: "starting" }) }),
      names,
      { port: 3000, drainMs: 0 },
    );
    expect(docker.boxes.get(names.current)!.running).toBe(true);
  });

  it("timeout: remove a nova, mantém a atual, o Caddy nunca foi tocado", async () => {
    probeResults = [null];
    await expect(performSwap(deps(), names, { port: 3000, healthTimeoutMs: 5000 })).rejects.toThrow(/sem resposta em 5s.*segue no ar, sem interrupção/);
    expect(docker.boxes.has(names.next)).toBe(false);
    expect(docker.boxes.get(names.current)!.running).toBe(true);
    expect(docker.boxes.get(names.current)!.aliases).toContain(names.current);
    expect(docker.ran("stop")).toBe(false);
    expect(text()).not.toContain("fase 3/4");
  });

  it("HTTP 500 até o fim do prazo e Docker unhealthy reprovam", async () => {
    probeResults = [500];
    await expect(performSwap(deps(), names, { port: 3000, healthTimeoutMs: 3000 })).rejects.toThrow(/HTTP 500 na porta 3000/);
    await expect(
      performSwap(deps({ start: async () => docker.add(names.next, { health: "unhealthy" }) }), names, { port: 3000 }),
    ).rejects.toBeInstanceOf(SwapHealthError);
    expect(docker.boxes.has(names.next)).toBe(false);
  });

  it("health com estado desconhecido espera até o prazo", async () => {
    probeResults = [null];
    await expect(
      performSwap(deps({ start: async () => docker.add(names.next, { health: "starting" }) }), names, { port: 3000, healthTimeoutMs: 2500 }),
    ).rejects.toThrow(/HEALTHCHECK do Docker: starting; sonda HTTP: sem resposta na porta 3000/);
  });

  it("container novo que sai (crash) reprova na hora, com o código", async () => {
    await expect(
      performSwap(deps({ start: async () => docker.add(names.next, { running: false, exitCode: 137 }) }), names, { port: 3000 }),
    ).rejects.toThrow(/saiu \(exited, código 137\)/);
    expect(docker.boxes.has(names.next)).toBe(false);
    expect(docker.boxes.get(names.current)!.running).toBe(true);
    expect(clock).toBe(0);
  });

  it("container novo que some entre a subida e a conferência", async () => {
    await expect(performSwap(deps({ start: async () => undefined }), names, { port: 3000 })).rejects.toThrow(/não foi encontrado/);
  });

  it("falha ao subir o container novo: a atual intocada e nada sobra", async () => {
    await expect(
      performSwap(
        deps({
          start: async () => {
            docker.add(names.next);
            throw new Error("falha ao subir o container: sem memória");
          },
        }),
        names,
        { port: 3000 },
      ),
    ).rejects.toThrow(/sem memória/);
    expect(docker.boxes.has(names.next)).toBe(false);
    expect(docker.boxes.get(names.current)!.running).toBe(true);
  });
});

describe("performSwap · falhas na hora de desligar a anterior", () => {
  beforeEach(() => docker.add(names.current));

  it("guardar a anterior (rename) falha: aborta e a atual segue", async () => {
    docker.failWhen = (a) => (a[0] === "rename" && a[1] === names.current ? bad("busy") : undefined);
    await expect(performSwap(deps(), names, { port: 3000, drainMs: 0 })).rejects.toThrow(/não consegui guardar a versão anterior: busy/);
    expect(docker.boxes.get(names.current)!.running).toBe(true);
    expect(docker.boxes.has(names.next)).toBe(false);
  });

  it("parar a anterior falha: devolve o nome e religa", async () => {
    docker.failWhen = (a) => (a[0] === "stop" ? bad("timeout") : undefined);
    await expect(performSwap(deps(), names, { port: 3000, drainMs: 0 })).rejects.toThrow(/não consegui parar a versão anterior/);
    expect(docker.boxes.get(names.current)!.running).toBe(true);
    expect(docker.boxes.has(names.previous!)).toBe(false);
    expect(docker.boxes.has(names.next)).toBe(false);
  });

  it("promover a nova falha depois de parar a anterior: a anterior volta a rodar", async () => {
    docker.failWhen = (a) => (a[0] === "rename" && a[1] === names.next ? bad("conflito") : undefined);
    await expect(performSwap(deps(), names, { port: 3000, drainMs: 0 })).rejects.toThrow(/não consegui renomear/);
    expect(docker.boxes.get(names.current)).toMatchObject({ running: true });
    expect(docker.boxes.has(names.next)).toBe(false);
    expect(docker.boxes.has(names.previous!)).toBe(false);
  });

  it("estático: remover a anterior falha, ela segue", async () => {
    docker.boxes.clear();
    docker.add(webNames.current);
    docker.failWhen = (a) => (a[0] === "rm" && a[2] === webNames.current ? bad("busy") : undefined);
    await expect(
      performSwap(deps({ start: async () => docker.add(webNames.next) }, webNames), webNames, { port: 80, drainMs: 0 }),
    ).rejects.toThrow(/não consegui remover a versão anterior/);
    expect(docker.boxes.get(webNames.current)!.running).toBe(true);
    expect(docker.boxes.has(webNames.next)).toBe(false);
  });

  it("estático: a anterior já saiu e a promoção falha — não dá para religar, mantém a nova", async () => {
    docker.boxes.clear();
    docker.add(webNames.current);
    docker.failWhen = (a) => (a[0] === "rename" && a[1] === webNames.next ? bad("conflito") : undefined);
    await expect(
      performSwap(deps({ start: async () => docker.add(webNames.next) }, webNames), webNames, { port: 80, drainMs: 0 }),
    ).rejects.toThrow(/não consegui renomear/);
    expect(docker.boxes.has(webNames.next)).toBe(true);
    expect(text()).toContain("mantive a versão nova no ar");
  });

  it("não consegue religar a anterior: promove a nova e registra", async () => {
    docker.failWhen = (a) => (a[0] === "start" ? bad("sem recurso") : a[0] === "rename" && a[1] === names.next && docker.calls.filter((c) => c[0] === "rename" && c[1] === names.next).length === 1 ? bad("conflito") : undefined);
    await expect(performSwap(deps(), names, { port: 3000, drainMs: 0 })).rejects.toThrow(/não consegui renomear/);
    expect(text()).toContain("mantive a versão nova no ar");
    expect(docker.boxes.get(names.current)).toBeDefined();
  });

  it("nem promover a nova dá certo no abort: registra e relança o erro original", async () => {
    docker.boxes.clear();
    docker.add(webNames.current);
    docker.failWhen = (a) => (a[0] === "rename" && a[1] === webNames.next ? bad("conflito") : undefined);
    await expect(
      performSwap(deps({ start: async () => docker.add(webNames.next) }, webNames), webNames, { port: 80, drainMs: 0 }),
    ).rejects.toThrow(/não consegui renomear/);
    expect(text()).toContain("✖ não consegui renomear");
  });

});

describe("recoverSwap · cada ponto de interrupção", () => {
  it("fase 1/2 (atual no ar + nova subindo): apaga a nova, o site segue com a atual", async () => {
    docker.add(names.current);
    docker.add(names.next, { aliases: [names.nextAlias] });
    expect(await recoverSwap(docker.fn, names, (c) => logs.push(c))).toBeNull();
    expect(docker.boxes.has(names.next)).toBe(false);
    expect(docker.boxes.get(names.current)!.running).toBe(true);
    expect(text()).toContain("sobrando");
  });

  it("fase 3 (Caddy já na nova, as duas rodando): o proxy regenerado aponta para o apelido da atual; a nova sai", async () => {
    docker.add(names.current, { aliases: ["loja"] });
    docker.add(names.next, { aliases: [names.nextAlias], health: "healthy" });
    await recoverSwap(docker.fn, names, () => undefined);
    expect(docker.boxes.has(names.next)).toBe(false);
    expect(docker.ran("stop")).toBe(false);
  });

  it("fase 4, depois do rename da anterior mas antes do stop: nada rodando como atual; a anterior ainda roda e a nova também → a nova é mantida e a anterior vira previous", async () => {
    docker.add(names.previous!, { running: true });
    docker.add(names.next, { aliases: [names.nextAlias] });
    expect(await recoverSwap(docker.fn, names, () => undefined)).toBe("promoted");
    expect(docker.boxes.get(names.current)).toMatchObject({ running: true });
    expect(docker.boxes.get(names.current)!.aliases).toContain("loja");
    expect(docker.boxes.get(names.previous!)).toMatchObject({ running: false });
  });

  it("fase 4, anterior já parada e nova rodando (sem nome definitivo): promove a nova", async () => {
    docker.add(names.previous!, { running: false });
    docker.add(names.next, { aliases: [names.nextAlias] });
    expect(await recoverSwap(docker.fn, names, (c) => logs.push(c))).toBe("promoted");
    expect(docker.boxes.get(names.current)).toMatchObject({ running: true });
    expect(docker.boxes.get(names.previous!)).toMatchObject({ running: false });
    expect(text()).toContain("mantida");
  });

  it("fase 4, atual que caiu (existe parada) e a nova roda: a atual vira previous e a nova assume", async () => {
    docker.add(names.current, { running: false });
    docker.add(names.next, { aliases: [names.nextAlias] });
    expect(await recoverSwap(docker.fn, names, () => undefined)).toBe("promoted");
    expect(docker.boxes.get(names.previous!)).toMatchObject({ running: false });
    expect(docker.boxes.get(names.current)).toMatchObject({ running: true });
  });

  it("estático: a antiga foi removida e a nova roda → promove; a antiga parada é apagada", async () => {
    docker.add(webNames.next, { aliases: [webNames.nextAlias] });
    expect(await recoverSwap(docker.fn, webNames, () => undefined)).toBe("promoted");
    expect([...docker.boxes.keys()]).toEqual([webNames.current]);
    docker.boxes.clear();
    docker.add(webNames.current, { running: false });
    docker.add(webNames.next, { aliases: [webNames.nextAlias] });
    expect(await recoverSwap(docker.fn, webNames, () => undefined)).toBe("promoted");
    expect([...docker.boxes.keys()]).toEqual([webNames.current]);
    expect(docker.boxes.get(webNames.current)!.running).toBe(true);
  });

  it("depois do rename da nova, antes do apelido: o container roda sem o apelido do projeto — corrigido", async () => {
    docker.add(names.current, { aliases: ["loja--a"] });
    docker.add(names.previous!, { running: false });
    expect(await recoverSwap(docker.fn, names, (c) => logs.push(c))).toBeNull();
    expect(docker.boxes.get(names.current)!.aliases).toContain("loja");
    expect(text()).toContain("apelido do projeto");
  });

  it("no meio da troca de apelido (fora da rede): volta para a rede", async () => {
    docker.add(names.current, { aliases: null });
    await recoverSwap(docker.fn, names, () => undefined);
    expect(docker.boxes.get(names.current)!.aliases).toContain("loja");
  });

  it("nova que existe mas não roda e nada atende: apaga a sobra e deixa o resto da recuperação seguir", async () => {
    docker.add(names.next, { running: false });
    expect(await recoverSwap(docker.fn, names, () => undefined)).toBeNull();
    expect(docker.boxes.has(names.next)).toBe(false);
  });

  it("sem nova e sem atual: nada a decidir", async () => {
    expect(await recoverSwap(docker.fn, names, () => undefined)).toBeNull();
  });

  it("deploy normal sem troca: atual rodando com apelido, nenhum comando que altere algo", async () => {
    docker.add(names.current, { aliases: ["loja"] });
    expect(await recoverSwap(docker.fn, names, () => undefined)).toBeNull();
    expect(docker.calls.some((c) => ["rm", "rename", "stop", "start", "network"].includes(c[0]!))).toBe(false);
  });
});
