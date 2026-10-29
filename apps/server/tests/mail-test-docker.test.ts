/**
 * mail-test-docker.ts — os comandos que sobem o Mailpit de um projeto, conferidos com um dublê do
 * docker (sem Docker real): redes internas (uma de leitura por projeto), sem porta publicada, API só na rede de
 * leitura, container read-only, limites, retenção, tamanho máximo por mensagem, sem relay, label fora do projeto e
 * recriação quando a configuração muda.
 */
import { describe, expect, it } from "vitest";
import { MAILPIT_IMAGE, containerIdentity, mailTestMaxMessageBytes } from "@paas/core";
import { MailTestDocker, mailTestConfigMark, readNetworkAddresses, readNetworkSubnet, type MailTestContainerSpec } from "../src/services/mail-test-docker.js";

type R = { code: number; stdout: string; stderr: string };
const ok = (stdout = ""): R => ({ code: 0, stdout, stderr: "" });
const bad = (stderr: string): R => ({ code: 1, stdout: "", stderr });

const SPEC: MailTestContainerSpec = { slug: "loja", maxMessages: 500, maxAgeDays: 7, uiUser: "panel", uiPassword: "ui-segredo" };
const READ = "paas-mailtestadm-loja";
const SUBNET = readNetworkSubnet("loja");
const ADDR = readNetworkAddresses(SUBNET)!;
const UI = "10.250.4.10";
const MARK = mailTestConfigMark(SPEC, UI);

/**
 * Dublê com redes que existem de verdade: `exists` diz quais já existem; criar uma rede a registra (com a sub-rede
 * pedida). `answer` sobrescreve qualquer resposta.
 */
function harness(answer: (args: string[]) => R | undefined = () => undefined, exists: { internal: Record<string, boolean>; subnet?: string } = { internal: {} }) {
  const calls: string[][] = [];
  const nets = new Map<string, { internal: boolean; subnet: string }>(Object.entries(exists.internal).map(([n, internal]) => [n, { internal, subnet: exists.subnet ?? "10.250.4.8/29" }]));
  const docker = new MailTestDocker(async (_file, args) => {
    calls.push(args);
    const custom = answer(args);
    if (custom !== undefined) return custom;
    if (args[0] === "network") {
      const name = args.at(-1)!;
      if (args[1] === "inspect") {
        const net = nets.get(name);
        if (!net) return bad("Error: No such network");
        if (args[3]?.includes("Subnet")) return ok(`${net.subnet} `);
        if (args[3]?.includes("Containers")) return ok("");
        return ok(String(net.internal));
      }
      if (args[1] === "create") {
        const sub = args.indexOf("--subnet");
        nets.set(name, { internal: true, subnet: sub >= 0 ? args[sub + 1]! : "172.30.0.0/24" });
        return ok();
      }
      if (args[1] === "rm") {
        nets.delete(name);
        return ok();
      }
    }
    if (args[0] === "inspect" && args[1] === "-f" && args[2]?.includes("Running")) return bad("No such container");
    return ok();
  });
  return { docker, calls };
}

describe("MailTestDocker.ensure", () => {
  it("cria o container do painel: redes internas (leitura por projeto), sem -p, read-only, limites, retenção, tamanho por mensagem, sem relay, fora do projeto", async () => {
    const { docker, calls } = harness();
    await docker.ensure(SPEC);
    expect(calls).toContainEqual(["network", "create", "--internal", "--label", "paas.managed=true", "--subnet", readNetworkSubnet("loja"), READ]);
    expect(calls).toContainEqual(["network", "create", "--internal", "--label", "paas.managed=true", "paas-mailtest-loja"]);
    const create = calls.find((a) => a[0] === "create")!;
    expect(create).toContain(MAILPIT_IMAGE);
    expect(create.slice(create.indexOf("--name"), create.indexOf("--name") + 2)).toEqual(["--name", "paas-mailtest-loja"]);
    expect(create).not.toContain("-p");
    expect(create).not.toContain("--publish");
    // B2: nasce só na rede de leitura DO PROJETO, num endereço fixo; a rede do projeto entra depois (só SMTP lá)
    expect(create[create.indexOf("--network") + 1]).toBe(READ);
    expect(create[create.indexOf("--ip") + 1]).toBe(ADDR.ui);
    expect(create).toContain(`MP_UI_BIND_ADDR=${ADDR.ui}:8025`);
    expect(create).toEqual(expect.arrayContaining(["-v", "paas-mailtest-loja-data:/data", "--cap-drop", "ALL", "--memory", "128m", "--cpus", "0.25", "--pids-limit", "128"]));
    // B5: read-only com tmpfs e log com teto
    expect(create).toEqual(expect.arrayContaining(["--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m", "--log-driver", "json-file", "--log-opt", "max-size=5m", "--log-opt", "max-file=2"]));
    // M4: tamanho máximo por mensagem (MP_MAX_MESSAGE_SIZE, Mailpit 1.30+)
    expect(create).toContain(`MP_MAX_MESSAGE_SIZE=${mailTestMaxMessageBytes(500)}`);
    expect(create).toEqual(expect.arrayContaining(["MP_MAX_MESSAGES=500", "MP_MAX_AGE=168h", "MP_DATABASE=/data/mailpit.db", "MP_UI_AUTH=panel:ui-segredo", "MP_SMTP_AUTH_ACCEPT_ANY=1"]));
    expect(create.join(" ")).not.toMatch(/RELAY/i);
    expect(create.join(" ")).not.toContain("paas.project=");
    expect(create).toContain("paas.role=mailtest");
    expect(calls).toContainEqual(["network", "connect", "paas-mailtest-loja", "paas-mailtest-loja"]);
    // não existe mais rede de leitura compartilhada entre projetos
    expect(calls.flat()).not.toContain("paas-mailtestadm");
    expect(calls.at(-1)).toEqual(["start", "paas-mailtest-loja"]);
  });

  it("o container NÃO é do projeto: fora de parar/iniciar/logs e do backup dele", async () => {
    const { docker, calls } = harness();
    await docker.ensure(SPEC);
    const create = calls.find((a) => a[0] === "create")!;
    const labels: Record<string, string> = {};
    create.forEach((arg, i) => {
      if (arg === "--label") {
        const [k, v] = create[i + 1]!.split("=", 2) as [string, string];
        labels[k] = v;
      }
    });
    expect(containerIdentity(labels)).toEqual({ managed: true, projectSlug: null, composeProject: null });
  });

  it("container certo e rodando não é tocado", async () => {
    const { docker, calls } = harness((a) => (a[0] === "inspect" ? ok(`true|${MARK}`) : undefined), { internal: { [READ]: true, "paas-mailtest-loja": true } });
    await docker.ensure(SPEC);
    expect(calls.some((a) => a[0] === "create" || a[0] === "rm" || a[0] === "start")).toBe(false);
  });

  it("parado com a configuração certa: só inicia", async () => {
    const { docker, calls } = harness((a) => (a[0] === "inspect" ? ok(`false|${MARK}`) : undefined), { internal: { [READ]: true, "paas-mailtest-loja": true } });
    await docker.ensure(SPEC);
    expect(calls).toContainEqual(["start", "paas-mailtest-loja"]);
    expect(calls.some((a) => a[0] === "create")).toBe(false);
  });

  it("retenção nova (ou formato antigo do container): recria; as mensagens ficam no volume", async () => {
    const { docker, calls } = harness((a) => (a[0] === "inspect" ? ok(`true|${mailTestConfigMark({ maxMessages: 100, maxAgeDays: 1 }, UI)}`) : undefined));
    await docker.ensure(SPEC);
    expect(calls).toContainEqual(["rm", "-f", "paas-mailtest-loja"]);
    expect(calls.some((a) => a[0] === "create")).toBe(true);
    expect(calls.some((a) => a[0] === "volume")).toBe(false);
  });

  it("parado que não inicia: recria", async () => {
    const { docker, calls } = harness((a) => {
      if (a[0] === "inspect") return ok(`false|${MARK}`);
      if (a[0] === "start" && calls.filter((c) => c[0] === "start").length === 1) return bad("quebrado");
      return undefined;
    }, { internal: { [READ]: true, "paas-mailtest-loja": true } });
    await docker.ensure(SPEC);
    expect(calls).toContainEqual(["rm", "-f", "paas-mailtest-loja"]);
    expect(calls.some((a) => a[0] === "create")).toBe(true);
  });

  it("falhas viram erros claros", async () => {
    await expect(harness((a) => (a[0] === "network" && a[1] === "create" ? bad("sem endereços") : undefined)).docker.ensure(SPEC)).rejects.toThrow(/falha ao criar a rede paas-mailtestadm-loja: sem endereços/);
    await expect(harness((a) => (a[0] === "create" ? bad("imagem não baixou") : undefined)).docker.ensure(SPEC)).rejects.toThrow(/falha ao criar paas-mailtest-loja: imagem não baixou/);
    await expect(harness((a) => (a[0] === "start" ? bad("porta") : undefined)).docker.ensure(SPEC)).rejects.toThrow(/falha ao iniciar/);
    await expect(harness((a) => (a[0] === "network" && a[1] === "connect" ? bad("daemon") : undefined)).docker.ensure(SPEC)).rejects.toThrow(/falha ao ligar paas-mailtest-loja à rede paas-mailtest-loja: daemon/);
    await expect(harness((a) => (a[0] === "network" && a[1] === "inspect" && a[3]?.includes("Subnet") ? ok("") : undefined), { internal: { [READ]: true } }).docker.ensure(SPEC)).rejects.toThrow(/sub-rede/);
  });

  it("rede criada ao mesmo tempo por outro pedido, e container já na rede, não são erro", async () => {
    const { docker } = harness((a) => {
      if (a[0] === "network" && a[1] === "create") return bad("network with name x already exists");
      if (a[0] === "network" && a[1] === "connect") return bad("endpoint already exists in network");
      return undefined;
    }, { internal: { [READ]: true } });
    await expect(docker.ensure(SPEC)).resolves.toBeUndefined();
  });

  it("sub-rede da rede de leitura ocupada por outra rede do Docker: tenta a vizinha", async () => {
    const tried: string[] = [];
    const { docker } = harness((a) => {
      if (a[0] === "network" && a[1] === "create" && a.includes("--subnet")) {
        tried.push(a[a.indexOf("--subnet") + 1]!);
        if (tried.length === 1) return bad("Pool overlaps with other one on this address space");
      }
      return undefined;
    });
    await docker.ensure(SPEC);
    expect(tried).toEqual([readNetworkSubnet("loja", 0), readNetworkSubnet("loja", 1)]);
  });
});

describe("sub-rede e endereços da rede de leitura", () => {
  it("determinística por slug, /29 em 10.250.0.0/16, e o Mailpit fica no .2 e o painel no .3", () => {
    expect(readNetworkSubnet("loja")).toBe(readNetworkSubnet("loja"));
    expect(readNetworkSubnet("loja")).toMatch(/^10\.250\.\d{1,3}\.\d{1,3}\/29$/);
    expect(readNetworkSubnet("loja", 1)).not.toBe(readNetworkSubnet("loja", 0));
    expect(readNetworkAddresses("10.250.4.8/29")).toEqual({ ui: "10.250.4.10", panel: "10.250.4.11" });
    expect(readNetworkAddresses("10.250.4.8/30")).toBeNull();
    expect(readNetworkAddresses("lixo")).toBeNull();
    expect(readNetworkAddresses("10.250.999.8/29")).toBeNull();
  });
});

describe("MailTestDocker.remove", () => {
  it("desligar mantendo as mensagens: tira o container e as duas redes; o volume fica", async () => {
    const { docker, calls } = harness();
    await docker.remove("loja", { deleteData: false });
    expect(calls.map((c) => c.slice(0, 2).join(" "))).toEqual(["rm -f", "network inspect", "network rm", "network rm"]);
    expect(calls).toContainEqual(["network", "rm", "paas-mailtest-loja"]);
    expect(calls).toContainEqual(["network", "rm", READ]);
  });

  it("o painel (e quem mais estiver na rede de leitura) sai dela antes de a rede ser removida", async () => {
    const { docker, calls } = harness((a) => (a[0] === "network" && a[1] === "inspect" && a[3]?.includes("Containers") ? ok("tws-panel ") : undefined));
    await docker.remove("loja", { deleteData: false });
    expect(calls).toContainEqual(["network", "disconnect", "-f", READ, "tws-panel"]);
    expect(calls.findIndex((a) => a[1] === "disconnect")).toBeLessThan(calls.findIndex((a) => a[1] === "rm" && a[2] === READ));
  });

  it("desligar apagando: o volume sai também", async () => {
    const { docker, calls } = harness();
    await docker.remove("loja", { deleteData: true });
    expect(calls).toContainEqual(["volume", "rm", "-f", "paas-mailtest-loja-data"]);
  });

  it("container ou volume que já não existem não são erro; outra falha é", async () => {
    await expect(harness((a) => (a[0] === "rm" ? bad("Error: No such container") : a[0] === "volume" ? bad("No such volume") : undefined)).docker.remove("loja", { deleteData: true })).resolves.toEqual({ networkLeft: null });
    await expect(harness((a) => (a[0] === "rm" ? bad("daemon fora") : undefined)).docker.remove("loja", { deleteData: false })).rejects.toThrow(/falha ao remover/);
    await expect(harness((a) => (a[0] === "volume" ? bad("em uso") : undefined)).docker.remove("loja", { deleteData: true })).rejects.toThrow(/falha ao apagar as mensagens \(em uso\)/);
  });

  it("rede que não saiu (ainda em uso) é devolvida para quem remove o projeto avisar; rede que já não existe não conta", async () => {
    const used = harness((a) => (a[0] === "network" && a[1] === "rm" ? bad("error while removing network: has active endpoints") : undefined));
    await expect(used.docker.remove("loja", { deleteData: false })).resolves.toEqual({ networkLeft: "paas-mailtest-loja" });
    const gone = harness((a) => (a[0] === "network" && a[1] === "rm" ? bad("Error: No such network: x") : undefined));
    await expect(gone.docker.remove("loja", { deleteData: false })).resolves.toEqual({ networkLeft: null });
  });
});

describe("MailTestDocker: rede existente precisa ser interna", () => {
  it("rede com o nome da caixa que TEM saída para a internet é recriada como interna", async () => {
    const { docker, calls } = harness(undefined, { internal: { "paas-mailtest-loja": false } });
    await docker.ensure(SPEC);
    expect(calls).toContainEqual(["network", "rm", "paas-mailtest-loja"]);
    expect(calls).toContainEqual(["network", "create", "--internal", "--label", "paas.managed=true", "paas-mailtest-loja"]);
    expect(calls.findIndex((a) => a[0] === "network" && a[1] === "rm")).toBeLessThan(calls.findIndex((a) => a[0] === "network" && a[1] === "create" && a.at(-1) === "paas-mailtest-loja"));
  });

  it("se não dá para recriar (containers ligados nela), o deploy para em vez de usar uma rede com saída", async () => {
    const { docker, calls } = harness((a) => (a[0] === "network" && a[1] === "rm" ? bad("has active endpoints") : undefined), { internal: { "paas-mailtest-loja": false } });
    await expect(docker.ensure(SPEC)).rejects.toThrow(/não é interna.*has active endpoints/);
    expect(calls.some((a) => a[0] === "create")).toBe(false);
  });
});

describe("MailTestDocker: painel, estado e endereço", () => {
  it("o painel entra na rede de leitura DO PROJETO, no .3; já nela ou fora de container, nada a fazer", async () => {
    const a = harness((x) => (x[0] === "inspect" ? ok('{"bridge":{}}') : undefined));
    await a.docker.connectPanel("loja", "tws-panel");
    expect(a.calls).toContainEqual(["network", "connect", "--ip", ADDR.panel, READ, "tws-panel"]);
    const b = harness((x) => (x[0] === "inspect" ? ok(`{"${READ}":{}}`) : undefined));
    await b.docker.connectPanel("loja", "tws-panel");
    expect(b.calls.some((x) => x[0] === "network" && x[1] === "connect")).toBe(false);
    const c = harness((x) => (x[0] === "inspect" && x[1] === "-f" ? bad("No such container") : undefined));
    await c.docker.connectPanel("loja", "tws-panel");
    expect(c.calls.some((x) => x[0] === "network" && x[1] === "connect")).toBe(false);
    const d = harness((x) => (x[0] === "inspect" ? ok("não é json") : undefined));
    await d.docker.connectPanel("loja", "tws-panel");
    expect(d.calls).toContainEqual(["network", "connect", "--ip", ADDR.panel, READ, "tws-panel"]);
    await expect(harness((x) => (x[0] === "inspect" ? ok("{}") : x[0] === "network" && x[1] === "connect" ? bad("negado") : undefined)).docker.connectPanel("loja", "tws-panel")).rejects.toThrow(/falha ao conectar o painel/);
    await expect(harness((x) => (x[0] === "inspect" ? ok("{}") : x[0] === "network" && x[1] === "connect" ? bad("already connected") : undefined)).docker.connectPanel("loja", "tws-panel")).resolves.toBeUndefined();
  });

  it("status e endereço", async () => {
    expect(await harness((x) => (x[0] === "inspect" ? ok("true\n") : undefined)).docker.status("loja")).toEqual({ installed: true, running: true });
    expect(await harness((x) => (x[0] === "inspect" ? ok("false") : undefined)).docker.status("loja")).toEqual({ installed: true, running: false });
    expect(await harness((x) => (x[0] === "inspect" ? bad("No such") : undefined)).docker.status("loja")).toEqual({ installed: false, running: false });
    const nets = (ip: string) => ok(JSON.stringify({ [READ]: { IPAddress: ip } }));
    expect(await harness((x) => (x[0] === "inspect" ? nets("172.30.0.9") : undefined)).docker.address("loja")).toBe("172.30.0.9");
    expect(await harness((x) => (x[0] === "inspect" ? nets("") : undefined)).docker.address("loja")).toBeNull();
    expect(await harness((x) => (x[0] === "inspect" ? bad("No such") : undefined)).docker.address("loja")).toBeNull();
    expect(await harness((x) => (x[0] === "inspect" ? ok("lixo") : undefined)).docker.address("loja")).toBeNull();
  });
});
