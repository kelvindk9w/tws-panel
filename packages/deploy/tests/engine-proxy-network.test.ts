/**
 * Rede do proxy por projeto (`paas-proxy-<slug>`): criação com sub-rede da faixa própria (sem `--internal`), o Caddy
 * ligado a ela, a migração dos containers que ainda estão na paas-net (entra na nova ANTES de sair da antiga, sem
 * parar nem recriar nada) e a remoção junto com o projeto.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";

type Result = { code: number; stdout: string; stderr: string };
const calls: string[][] = [];
let respostas: (args: string[]) => Result;

vi.mock("../src/exec.js", () => ({
  run: vi.fn(async (_file: string, args: string[]): Promise<Result> => {
    calls.push(args);
    return respostas(args);
  }),
  runStream: vi.fn(async () => 0),
}));

const { DeployEngine } = await import("../src/engine.js");

beforeEach(() => {
  calls.length = 0;
});

const ok = (stdout = ""): Result => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): Result => ({ code: 1, stdout: "", stderr });

const projeto = (slug: string) => ({ id: slug, name: slug, slug }) as unknown as Project;
const config = { projectsDir: "/tmp/x", caddyDir: "/tmp/x/caddy", nodeImage: "node:22", staticImage: "nginx:alpine", caddyHttpPort: 80, caddyHttpsPort: 443 };
const engine = (extra: Record<string, unknown> = {}) => new DeployEngine({ ...config, ...extra });

/** Saída do `docker inspect -f` (labels + redes) de um container. */
const info = (o: { compose?: string; project?: string; managed?: string; nets?: Record<string, string[] | null>; env?: string[] } = {}) =>
  JSON.stringify({
    env: o.env ?? ["PATH=/usr/bin"],
    labels: {
      "com.docker.compose.project": o.compose ?? "",
      ...(o.project !== undefined ? { "paas.project": o.project } : {}),
      ...(o.managed !== undefined ? { "paas.managed": o.managed } : {}),
    },
    networks: Object.fromEntries(Object.entries(o.nets ?? { "paas-net": ["loja"] }).map(([n, aliases]) => [n, { Aliases: aliases }])),
  });

interface Mundo {
  /** id → JSON do inspect dos containers na paas-net (o Caddy é listado também e deve ser ignorado). */
  containers?: Record<string, string>;
  /** Label da rede do proxy do projeto (null = a rede não existe). */
  rede?: string | null;
  /** Redes em que o Caddy está (null = sem container do Caddy). */
  caddy?: string[] | null;
  subnets?: string[];
  /** Sub-rede da rede do proxy do projeto, como o Caddy a lê para o endereço fixo ("" = ilegível). */
  subnetDaRede?: string;
  extra?: (a: string[]) => Result | undefined;
}

const mundo = (m: Mundo = {}) => {
  const containers = m.containers ?? {};
  respostas = (a) => {
    const custom = m.extra?.(a);
    if (custom) return custom;
    if (a[0] === "ps" && a.includes("network=paas-net")) {
      return ok([...Object.keys(containers).map((id) => `${id} nome-${id}`), "cad paas-caddy"].join("\n") + "\n");
    }
    if (a[0] === "network" && a[1] === "inspect" && a[3]?.includes("paas.proxy.project")) {
      return m.rede === null || m.rede === undefined ? fail("Error: No such network: paas-proxy-loja") : ok(`${m.rede}\n`);
    }
    if (a[0] === "network" && a[1] === "inspect" && a[3]?.includes("IPAM") && a.at(-1) === "paas-proxy-loja") return ok(`${m.subnetDaRede ?? ""}\n`);
    if (a[0] === "network" && a[1] === "ls") return ok((m.subnets ?? []).map((_, i) => `n${i}`).join("\n") + "\n");
    if (a[0] === "network" && a[1] === "inspect" && a[3]?.includes("IPAM")) return ok((m.subnets ?? []).join(" ") + "\n");
    if (a[0] === "inspect" && a.includes("{{json .NetworkSettings.Networks}}")) {
      return m.caddy === null ? fail("No such object") : ok(JSON.stringify(Object.fromEntries((m.caddy ?? ["paas-net", "paas-panel"]).map((n) => [n, {}]))));
    }
    if (a[0] === "inspect") return ok(containers[a.at(-1)!] ?? "");
    return ok();
  };
};

const connects = () => calls.filter((c) => c[0] === "network" && c[1] === "connect");
const disconnects = () => calls.filter((c) => c[0] === "network" && c[1] === "disconnect");
const at = (pred: (c: string[]) => boolean) => calls.findIndex(pred);

describe("DeployEngine.ensureProxyNetwork — criação", () => {
  it("cria a rede do projeto SEM --internal, com bloco /26 da faixa do proxy e a label do projeto; liga o Caddy logo depois", async () => {
    mundo({ rede: null });
    const logs: string[] = [];
    await expect(engine().ensureProxyNetwork(projeto("loja"), (m) => logs.push(m))).resolves.toBe("paas-proxy-loja");
    const create = calls.find((c) => c[1] === "create")!;
    expect(create).toEqual([
      "network",
      "create",
      "--subnet",
      expect.stringMatching(/^10\.214\.\d+\.\d+\/26$/),
      "--ip-range",
      expect.stringMatching(/^10\.214\.\d+\.\d+\/27$/),
      "--label",
      "paas.managed=true",
      "--label",
      "paas.proxy.project=loja",
      "paas-proxy-loja",
    ]);
    // os endereços automáticos saem da metade de cima do bloco: o de baixo fica para o gateway e o Caddy
    const [base] = create[3]!.split("/");
    expect(create[5]).toBe(`${base!.split(".").slice(0, 3).join(".")}.${Number(base!.split(".")[3]) + 32}/27`);
    expect(connects()).toEqual([["network", "connect", "paas-proxy-loja", "paas-caddy"]]);
    expect(at((c) => c[1] === "connect")).toBeGreaterThan(at((c) => c[1] === "create"));
    expect(logs.join("")).toMatch(/Rede do proxy paas-proxy-loja criada.*Proxy \(Caddy\) ligado à rede paas-proxy-loja/s);
  });

  it("idempotente: rede do projeto e Caddy já nela → nada criado nem ligado", async () => {
    mundo({ rede: "loja", caddy: ["paas-net", "paas-panel", "paas-proxy-loja"] });
    await engine().ensureProxyNetwork(projeto("loja"));
    expect(calls.some((c) => c[1] === "create" || c[1] === "connect" || c[1] === "rm")).toBe(false);
  });

  it("a faixa vem de PAAS_PROXY_SUBNET_POOL (via contexto) e evita as sub-redes em uso; faixa inválida usa a padrão", async () => {
    mundo({ rede: null, subnets: ["172.17.0.0/16"] });
    await engine({ proxySubnetPool: "10.50.0.0/26" }).ensureProxyNetwork(projeto("loja"));
    expect(calls.find((c) => c[1] === "create")).toContain("10.50.0.0/26");
    calls.length = 0;
    mundo({ rede: null });
    await engine({ proxySubnetPool: "203.0.113.0/24" }).ensureProxyNetwork(projeto("loja"));
    expect(calls.find((c) => c[1] === "create")!.join(" ")).toMatch(/10\.214\./);
    calls.length = 0;
    mundo({ rede: null, subnets: ["10.50.0.0/16"] });
    await expect(engine({ proxySubnetPool: "10.50.0.0/26" }).ensureProxyNetwork(projeto("loja"))).rejects.toThrow(/faixa das redes de proxy \(10\.50\.0\.0\/26\) está cheia/);
  });

  it("rede com o nome do projeto que o painel não criou para ele: recriada; sem conseguir, erro e nada ligado", async () => {
    mundo({ rede: "outro" });
    await engine().ensureProxyNetwork(projeto("loja"));
    expect(at((c) => c[1] === "rm")).toBeLessThan(at((c) => c[1] === "create"));
    calls.length = 0;
    mundo({ rede: "", extra: (a) => (a[1] === "rm" ? fail("network has active endpoints") : undefined) });
    await expect(engine().ensureProxyNetwork(projeto("loja"))).rejects.toThrow(/não é a rede do proxy que o painel cria para este projeto, e não pôde ser recriada: network has active endpoints/);
    expect(connects()).toEqual([]);
  });

  it("erro ao ler a rede (que não seja 'não existe') sobe; Caddy que não entra vira erro claro", async () => {
    mundo({ extra: (a) => (a[1] === "inspect" && a[3]?.includes("paas.proxy.project") ? fail("permission denied") : undefined) });
    await expect(engine().ensureProxyNetwork(projeto("loja"))).rejects.toThrow(/falha ao ler a rede paas-proxy-loja: permission denied/);
    mundo({ rede: "loja", extra: (a) => (a[1] === "connect" ? fail("boom") : undefined) });
    await expect(engine().ensureProxyNetwork(projeto("loja"))).rejects.toThrow(/o proxy \(Caddy\) não entrou na rede paas-proxy-loja .*boom.*sem ele nela o site não responderia/);
  });

  it("sem o container do Caddy (instalação nova): cria a rede e segue (o Caddy entra quando for criado)", async () => {
    mundo({ rede: null, caddy: null });
    await engine().ensureProxyNetwork(projeto("loja"));
    expect(connects()).toEqual([]);
  });
});

describe("DeployEngine.migrateProxyNetwork — da paas-net para a rede do projeto", () => {
  it("cada container do projeto entra na rede nova só com os apelidos do Caddy e, depois de TODOS entrarem, sai da paas-net", async () => {
    mundo({
      rede: null,
      containers: {
        c1: info({ compose: "paas-loja", nets: { "paas-loja_default": ["web"], "paas-net": ["web", "loja", "tws-panel", "paas-loja-web-1"] } }),
        c2: info({ managed: "true", project: "loja", nets: { "paas-net": ["loja--b", "loja--x y", "paas-loja-app"] } }),
      },
    });
    const logs: string[] = [];
    await expect(engine().migrateProxyNetwork(projeto("loja"), (m) => logs.push(m))).resolves.toEqual({ moved: 2, held: [] });
    expect(connects()).toEqual([
      ["network", "connect", "paas-proxy-loja", "paas-caddy"],
      ["network", "connect", "--alias", "loja", "paas-proxy-loja", "c1"],
      ["network", "connect", "--alias", "loja--b", "paas-proxy-loja", "c2"],
    ]);
    expect(disconnects()).toEqual([
      ["network", "disconnect", "paas-net", "c1"],
      ["network", "disconnect", "paas-net", "c2"],
    ]);
    expect(calls.indexOf(disconnects()[0]!)).toBeGreaterThan(calls.lastIndexOf(connects().at(-1)!));
    expect(logs.join("")).toMatch(/nome-c1 passou da paas-net \(dividida com outros projetos\) para paas-proxy-loja/);
  });

  it("só os containers DESTE projeto (label do compose vence; paas.project só com paas.managed e sem compose); o Caddy nunca", async () => {
    mundo({
      rede: "loja",
      caddy: ["paas-net", "paas-proxy-loja"],
      containers: {
        outro: info({ compose: "paas-blog" }),
        imitador: info({ compose: "paas-blog", project: "loja", managed: "true" }),
        semManaged: info({ project: "loja" }),
        meu: info({ project: "loja", managed: "true" }),
      },
    });
    await expect(engine().migrateProxyNetwork(projeto("loja"))).resolves.toEqual({ moved: 1, held: [] });
    expect(connects()).toEqual([["network", "connect", "--alias", "loja", "paas-proxy-loja", "meu"]]);
    expect(calls.some((c) => c[0] === "inspect" && c.at(-1) === "cad")).toBe(false);
  });

  it("migração interrompida no meio (já na rede nova, ainda na paas-net): só falta sair da paas-net", async () => {
    mundo({ rede: "loja", containers: { c1: info({ compose: "paas-loja", nets: { "paas-net": ["loja"], "paas-proxy-loja": ["loja"] } }) } });
    await engine().migrateProxyNetwork(projeto("loja"));
    expect(connects().filter((c) => c.at(-1) === "c1")).toEqual([]);
    expect(disconnects()).toEqual([["network", "disconnect", "paas-net", "c1"]]);
  });

  it("falha ao ligar um container: o erro sobe e NINGUÉM sai da paas-net (o site segue pela rede antiga)", async () => {
    mundo({
      rede: "loja",
      containers: { c1: info({ compose: "paas-loja" }), c2: info({ compose: "paas-loja" }) },
      extra: (a) => (a[1] === "connect" && a.at(-1) === "c2" ? fail("sem endereço livre") : undefined),
    });
    await expect(engine().migrateProxyNetwork(projeto("loja"))).rejects.toThrow(/falha ao ligar nome-c2 à rede paas-proxy-loja: sem endereço livre/);
    expect(disconnects()).toEqual([]);
  });

  it("container removido no meio (no such container) é pulado; 'already exists' conta como ligado", async () => {
    mundo({
      rede: "loja",
      containers: { sumiu: info({ compose: "paas-loja" }), ja: info({ compose: "paas-loja" }) },
      extra: (a) => {
        if (a[1] === "connect" && a.at(-1) === "sumiu") return fail("Error: No such container: sumiu");
        if (a[1] === "connect" && a.at(-1) === "ja") return fail("endpoint with name x already exists in network paas-proxy-loja");
        return undefined;
      },
    });
    await expect(engine().migrateProxyNetwork(projeto("loja"))).resolves.toEqual({ moved: 1, held: [] });
    expect(disconnects()).toEqual([["network", "disconnect", "paas-net", "ja"]]);
  });

  it("falha ao sair da paas-net sobe; 'not connected' é tolerado", async () => {
    mundo({ rede: "loja", containers: { c1: info({ compose: "paas-loja" }) }, extra: (a) => (a[1] === "disconnect" ? fail("is not connected to network paas-net") : undefined) });
    await expect(engine().migrateProxyNetwork(projeto("loja"))).resolves.toEqual({ moved: 1, held: [] });
    mundo({ rede: "loja", containers: { c1: info({ compose: "paas-loja" }) }, extra: (a) => (a[1] === "disconnect" ? fail("daemon ocupado") : undefined) });
    await expect(engine().migrateProxyNetwork(projeto("loja"))).rejects.toThrow(/falha ao tirar nome-c1 da rede paas-net: daemon ocupado/);
  });

  it("nada na paas-net e sem `create`: não cria a rede; se ela existe, só confere que o Caddy está nela", async () => {
    mundo({ rede: null });
    await expect(engine().migrateProxyNetwork(projeto("loja"))).resolves.toEqual({ moved: 0, held: [] });
    expect(calls.some((c) => c[1] === "create" || c[1] === "connect")).toBe(false);
    calls.length = 0;
    mundo({ rede: "loja", caddy: ["paas-net"] });
    const logs: string[] = [];
    await engine().migrateProxyNetwork(projeto("loja"), (m) => logs.push(m));
    expect(connects()).toEqual([["network", "connect", "paas-proxy-loja", "paas-caddy"]]);
    expect(logs.join("")).toMatch(/ligado de novo à rede paas-proxy-loja/);
    calls.length = 0;
    mundo({ rede: "outro" });
    await engine().migrateProxyNetwork(projeto("loja"));
    expect(connects()).toEqual([]);
  });

  it("com `create` (deploy): cria a rede mesmo sem nada para mover", async () => {
    mundo({ rede: null });
    await expect(engine().migrateProxyNetwork(projeto("loja"), () => undefined, { create: true })).resolves.toEqual({ moved: 0, held: [] });
    expect(calls.some((c) => c[1] === "create")).toBe(true);
  });

  it("erro ao listar a paas-net sobe; inspect que falha ou não é JSON pula o container", async () => {
    mundo({ extra: (a) => (a[0] === "ps" ? fail("daemon fora do ar") : undefined) });
    await expect(engine().migrateProxyNetwork(projeto("loja"))).rejects.toThrow(/falha ao ler a rede paas-net: daemon fora do ar/);
    mundo({ rede: null, containers: { a: "não é json" }, extra: (a) => (a[0] === "inspect" && a.at(-1) === "b" ? fail("x") : undefined) });
    respostas = ((orig) => (a: string[]) => (a[0] === "ps" ? ok("a nome-a\nb nome-b\n\n") : orig(a)))(respostas);
    await expect(engine().migrateProxyNetwork(projeto("loja"))).resolves.toEqual({ moved: 0, held: [] });
  });

  it("labels e redes ausentes ou de tipo errado no inspect: não é do projeto", async () => {
    mundo({ rede: null, containers: { a: JSON.stringify({ labels: null, networks: null }), b: JSON.stringify({ labels: { "com.docker.compose.project": 7 } }) } });
    await expect(engine().migrateProxyNetwork(projeto("loja"))).resolves.toEqual({ moved: 0, held: [] });
  });

  it("container sem apelido na paas-net entra sem apelido (e sai de lá do mesmo jeito)", async () => {
    mundo({ rede: "loja", caddy: ["paas-proxy-loja"], containers: { c1: JSON.stringify({ labels: { "com.docker.compose.project": "paas-loja" }, networks: { "paas-net": { Aliases: null } } }) } });
    await engine().migrateProxyNetwork(projeto("loja"));
    expect(connects()).toEqual([["network", "connect", "paas-proxy-loja", "c1"]]);
  });
});

describe("DeployEngine.migrateProxyNetwork — quem recebeu PAAS_PROXY_* da paas-net (keepIfProxyEnv)", () => {
  const comEnv = (env: string[]) => info({ compose: "paas-loja", env });

  it("algum container com PAAS_PROXY_IP ou PAAS_PROXY_SUBNET: NADA do projeto sai da paas-net; os nomes voltam e o log diz o que fazer", async () => {
    for (const env of [["PAAS_PROXY_IP=172.18.0.2"], ["PAAS_PROXY_SUBNET=172.18.0.0/16"]]) {
      calls.length = 0;
      mundo({ rede: null, containers: { c1: comEnv(env), c2: comEnv([]) } });
      const logs: string[] = [];
      await expect(engine().migrateProxyNetwork(projeto("loja"), (m) => logs.push(m), { keepIfProxyEnv: true })).resolves.toEqual({ moved: 0, held: ["nome-c1"] });
      expect(connects()).toEqual([]);
      expect(disconnects()).toEqual([]);
      expect(calls.some((c) => c[1] === "create")).toBe(false);
      expect(logs.join("")).toMatch(/nome-c1 \(projeto loja\) recebeu PAAS_PROXY_IP\/PAAS_PROXY_SUBNET da paas-net e segue nela, no ar.*Refaça o deploy do projeto para ele passar para a rede própria/s);
    }
  });

  it("com `create` (recuperação de deploy), segura do mesmo jeito mas garante a rede do projeto", async () => {
    mundo({ rede: null, containers: { c1: comEnv(["PAAS_PROXY_IP=172.18.0.2"]) } });
    await expect(engine().migrateProxyNetwork(projeto("loja"), () => undefined, { create: true, keepIfProxyEnv: true })).resolves.toEqual({ moved: 0, held: ["nome-c1"] });
    expect(calls.some((c) => c[1] === "create")).toBe(true);
    expect(disconnects()).toEqual([]);
  });

  it("sem PAAS_PROXY_* (ou variável só parecida, ou env de tipo errado): passa normalmente; sem keepIfProxyEnv passa sempre", async () => {
    mundo({ rede: "loja", containers: { c1: comEnv(["PAAS_PROXY_IPX=1", "X=PAAS_PROXY_IP=1"]), c2: JSON.stringify({ labels: { "com.docker.compose.project": "paas-loja" }, networks: { "paas-net": {} }, env: "x" }) } });
    await expect(engine().migrateProxyNetwork(projeto("loja"), () => undefined, { keepIfProxyEnv: true })).resolves.toEqual({ moved: 2, held: [] });
    calls.length = 0;
    mundo({ rede: "loja", containers: { c1: comEnv(["PAAS_PROXY_IP=172.18.0.2"]) } });
    await expect(engine().migrateProxyNetwork(projeto("loja"))).resolves.toEqual({ moved: 1, held: [] });
  });

  it("sharedProxyNetworkContainersOf: os nomes do projeto que ainda estão na paas-net", async () => {
    mundo({ containers: { c1: comEnv([]), outro: info({ compose: "paas-blog" }) } });
    await expect(engine().sharedProxyNetworkContainersOf(projeto("loja"))).resolves.toEqual(["nome-c1"]);
  });
});

describe("DeployEngine.ensureProxyNetwork — endereço fixo do Caddy", () => {
  it("o Caddy entra com o endereço base+2 do bloco da rede", async () => {
    mundo({ rede: "loja", subnetDaRede: "10.214.7.128/26" });
    await engine().ensureProxyNetwork(projeto("loja"));
    expect(connects()).toEqual([["network", "connect", "--ip", "10.214.7.130", "paas-proxy-loja", "paas-caddy"]]);
  });
});

describe("DeployEngine.recreate — rede do proxy antes das variáveis", () => {
  it("dockerfile: a rede do projeto existe ANTES de ler as variáveis; o que está na paas-net só passa DEPOIS do container novo", async () => {
    const ordem: string[] = [];
    mundo({ rede: null, containers: { c1: info({ project: "loja", managed: "true" }) } });
    const base = respostas;
    respostas = (a) => {
      if (a[1] === "create" && !ordem.includes("rede")) ordem.push("rede"); // o dublê diz sempre que a rede não existe
      if (a[0] === "run") ordem.push("container");
      if (a[0] === "network" && a[1] === "disconnect" && a[2] === "paas-net") ordem.push("sai-da-paas-net");
      return base(a);
    };
    const envForProject = vi.fn(async () => {
      ordem.push("env");
      return {};
    });
    const p = { ...projeto("loja"), detection: { type: "dockerfile" } } as unknown as Project;
    await engine({ envForProject }).recreate(p, () => undefined);
    expect(ordem).toEqual(["rede", "env", "container", "sai-da-paas-net"]);
  });

  it("site estático: nada a recriar, nenhum docker", async () => {
    const logs: string[] = [];
    await engine().recreate({ ...projeto("loja"), detection: { type: "static" } } as unknown as Project, (m) => logs.push(m));
    expect(calls).toEqual([]);
    expect(logs.join("")).toMatch(/nada a recriar/);
  });
});

describe("DeployEngine.sharedProxyNetworkContainers", () => {
  it("quem está na paas-net além do Caddy; erro ao listar sobe", async () => {
    respostas = () => ok("paas-caddy\nsobra-1\n\n");
    await expect(engine().sharedProxyNetworkContainers()).resolves.toEqual(["sobra-1"]);
    respostas = () => fail("x");
    await expect(engine().sharedProxyNetworkContainers()).rejects.toThrow(/falha ao ler a rede paas-net/);
  });
});

describe("DeployEngine.removeProxyNetwork — projeto excluído", () => {
  const rede = (extra?: (a: string[]) => Result | undefined) => (a: string[]): Result => {
    const r = extra?.(a);
    if (r) return r;
    if (a[0] === "ps") return ok("caddyid\nsobra\n");
    return ok();
  };

  it("desliga todos da rede (rodando ou parados, inclusive o Caddy) e apaga a rede", async () => {
    respostas = rede();
    const logs: string[] = [];
    await expect(engine().removeProxyNetwork(projeto("loja"), (m) => logs.push(m))).resolves.toBe(2);
    expect(calls.find((c) => c[0] === "ps")).toEqual(["ps", "-a", "-q", "--no-trunc", "--filter", "network=paas-proxy-loja"]);
    expect(disconnects()).toEqual([
      ["network", "disconnect", "-f", "paas-proxy-loja", "caddyid"],
      ["network", "disconnect", "-f", "paas-proxy-loja", "sobra"],
    ]);
    expect(calls.at(-1)).toEqual(["network", "rm", "paas-proxy-loja"]);
    expect(logs.join("")).toMatch(/Rede do proxy paas-proxy-loja apagada \(2 container\(es\) desligado\(s\), inclusive o proxy\)/);
  });

  it("rede que não existe: nada a fazer; erros de leitura, de desligar e de apagar sobem (os toleráveis não)", async () => {
    respostas = rede((a) => (a[1] === "inspect" ? fail("Error: No such network") : undefined));
    await expect(engine().removeProxyNetwork(projeto("loja"))).resolves.toBe(0);
    respostas = rede((a) => (a[1] === "inspect" ? fail("permission denied") : undefined));
    await expect(engine().removeProxyNetwork(projeto("loja"))).rejects.toThrow(/falha ao ler a rede paas-proxy-loja: permission denied/);
    respostas = rede((a) => (a[0] === "ps" ? fail("ps falhou") : undefined));
    await expect(engine().removeProxyNetwork(projeto("loja"))).rejects.toThrow(/falha ao ler a rede paas-proxy-loja: ps falhou/);
    respostas = rede((a) => (a[1] === "disconnect" ? fail("is not connected") : a[1] === "rm" ? fail("no such network") : undefined));
    await expect(engine().removeProxyNetwork(projeto("loja"))).resolves.toBe(2);
    respostas = rede((a) => (a[1] === "disconnect" ? fail("boom") : undefined));
    await expect(engine().removeProxyNetwork(projeto("loja"))).rejects.toThrow(/falha ao tirar caddyid da rede paas-proxy-loja: boom/);
    respostas = rede((a) => (a[1] === "rm" ? fail("in use") : undefined));
    await expect(engine().removeProxyNetwork(projeto("loja"))).rejects.toThrow(/falha ao apagar a rede paas-proxy-loja: in use/);
  });

  it("excluir o projeto apaga a rede do proxy dele; falha só avisa no log da remoção, com o comando", async () => {
    respostas = rede();
    await engine().remove(projeto("loja"), () => undefined);
    expect(calls).toContainEqual(["network", "rm", "paas-proxy-loja"]);
    calls.length = 0;
    respostas = rede((a) => (a[1] === "rm" && a[2] === "paas-proxy-loja" ? fail("in use") : undefined));
    const logs: string[] = [];
    await engine().remove(projeto("loja"), (m) => logs.push(m));
    expect(logs.join("")).toMatch(/a rede do proxy paas-proxy-loja não foi apagada agora .*docker network disconnect -f paas-proxy-loja paas-caddy && docker network rm paas-proxy-loja/);
  });
});
