/**
 * mail-test-docker.ts — os comandos que sobem o Mailpit de um projeto, conferidos com um dublê do
 * docker (sem Docker real): redes internas, sem porta publicada, limites, retenção, sem relay,
 * label fora do projeto e recriação quando a configuração muda.
 */
import { describe, expect, it } from "vitest";
import { MAILPIT_IMAGE, containerIdentity } from "@paas/core";
import { MailTestDocker, mailTestConfigMark, type MailTestContainerSpec } from "../src/services/mail-test-docker.js";

type R = { code: number; stdout: string; stderr: string };
const ok = (stdout = ""): R => ({ code: 0, stdout, stderr: "" });
const bad = (stderr: string): R => ({ code: 1, stdout: "", stderr });

const SPEC: MailTestContainerSpec = { slug: "loja", maxMessages: 500, maxAgeDays: 7, uiUser: "panel", uiPassword: "ui-segredo" };

function harness(answer: (args: string[]) => R | undefined = () => undefined) {
  const calls: string[][] = [];
  const docker = new MailTestDocker(async (_file, args) => {
    calls.push(args);
    return answer(args) ?? ok();
  });
  return { docker, calls };
}

describe("MailTestDocker.ensure", () => {
  it("cria o container do painel: redes internas, sem -p, limites, retenção, sem relay, fora do projeto", async () => {
    const { docker, calls } = harness((a) => (a[0] === "network" && a[1] === "inspect") || (a[0] === "inspect" && a[1] === "-f") ? bad("No such") : undefined);
    await docker.ensure(SPEC);
    expect(calls).toContainEqual(["network", "create", "--internal", "--label", "paas.managed=true", "paas-mailtestadm"]);
    expect(calls).toContainEqual(["network", "create", "--internal", "--label", "paas.managed=true", "paas-mailtest-loja"]);
    const create = calls.find((a) => a[0] === "create")!;
    expect(create).toContain(MAILPIT_IMAGE);
    expect(create.slice(create.indexOf("--name"), create.indexOf("--name") + 2)).toEqual(["--name", "paas-mailtest-loja"]);
    expect(create).not.toContain("-p");
    expect(create).not.toContain("--publish");
    expect(create[create.indexOf("--network") + 1]).toBe("paas-mailtest-loja");
    expect(create).toEqual(expect.arrayContaining(["-v", "paas-mailtest-loja-data:/data", "--cap-drop", "ALL", "--memory", "128m", "--cpus", "0.25", "--pids-limit", "128"]));
    expect(create).toEqual(expect.arrayContaining(["MP_MAX_MESSAGES=500", "MP_MAX_AGE=168h", "MP_DATABASE=/data/mailpit.db", "MP_UI_AUTH=panel:ui-segredo", "MP_SMTP_AUTH_ACCEPT_ANY=1"]));
    // sem relay: nenhuma opção de encaminhamento
    expect(create.join(" ")).not.toMatch(/RELAY/i);
    // não é "do projeto": não entra em parar/iniciar/logs/backup dele
    expect(create.join(" ")).not.toContain("paas.project=");
    expect(create).toContain("paas.role=mailtest");
    expect(calls).toContainEqual(["network", "connect", "paas-mailtestadm", "paas-mailtest-loja"]);
    expect(calls.at(-1)).toEqual(["start", "paas-mailtest-loja"]);
  });

  it("o container NÃO é do projeto: fora de parar/iniciar/logs e do backup dele", async () => {
    const { docker, calls } = harness((a) => (a[0] === "network" && a[1] === "inspect") || (a[0] === "inspect" && a[1] === "-f") ? bad("No such") : undefined);
    await docker.ensure(SPEC);
    const create = calls.find((a) => a[0] === "create")!;
    const labels: Record<string, string> = {};
    create.forEach((arg, i) => {
      if (arg === "--label") {
        const [k, v] = create[i + 1]!.split("=", 2) as [string, string];
        labels[k] = v;
      }
    });
    // o painel acha os containers de um projeto por com.docker.compose.project ou por paas.project (com managed): nenhum dos dois
    expect(containerIdentity(labels)).toEqual({ managed: true, projectSlug: null, composeProject: null });
  });

  it("container certo e rodando não é tocado", async () => {
    const { docker, calls } = harness((a) => (a[0] === "inspect" ? ok(`true|${mailTestConfigMark(SPEC)}`) : undefined));
    await docker.ensure(SPEC);
    expect(calls.some((a) => a[0] === "create" || a[0] === "rm" || a[0] === "start")).toBe(false);
  });

  it("parado com a configuração certa: só inicia", async () => {
    const { docker, calls } = harness((a) => (a[0] === "inspect" ? ok(`false|${mailTestConfigMark(SPEC)}`) : undefined));
    await docker.ensure(SPEC);
    expect(calls).toContainEqual(["start", "paas-mailtest-loja"]);
    expect(calls.some((a) => a[0] === "create")).toBe(false);
  });

  it("retenção nova: recria o container (as mensagens ficam no volume)", async () => {
    const { docker, calls } = harness((a) => (a[0] === "inspect" ? ok(`true|${mailTestConfigMark({ maxMessages: 100, maxAgeDays: 1 })}`) : undefined));
    await docker.ensure(SPEC);
    expect(calls).toContainEqual(["rm", "-f", "paas-mailtest-loja"]);
    expect(calls.some((a) => a[0] === "create")).toBe(true);
    expect(calls.some((a) => a[0] === "volume")).toBe(false);
  });

  it("parado que não inicia: recria", async () => {
    const { docker, calls } = harness((a) => {
      if (a[0] === "inspect") return ok(`false|${mailTestConfigMark(SPEC)}`);
      if (a[0] === "start" && calls.filter((c) => c[0] === "start").length === 1) return bad("quebrado");
      return undefined;
    });
    await docker.ensure(SPEC);
    expect(calls).toContainEqual(["rm", "-f", "paas-mailtest-loja"]);
    expect(calls.some((a) => a[0] === "create")).toBe(true);
  });

  it("falhas viram erros claros", async () => {
    await expect(harness((a) => (a[0] === "inspect" ? bad("x") : a[0] === "network" && a[1] === "inspect" ? bad("x") : a[0] === "network" ? bad("sem endereços") : undefined)).docker.ensure(SPEC)).rejects.toThrow(/falha ao criar a rede paas-mailtestadm: sem endereços/);
    await expect(harness((a) => (a[0] === "inspect" ? bad("x") : a[0] === "create" ? bad("imagem não baixou") : undefined)).docker.ensure(SPEC)).rejects.toThrow(/falha ao criar paas-mailtest-loja: imagem não baixou/);
    await expect(harness((a) => (a[0] === "inspect" ? bad("x") : a[0] === "start" ? bad("porta") : undefined)).docker.ensure(SPEC)).rejects.toThrow(/falha ao iniciar/);
    await expect(harness((a) => (a[0] === "inspect" ? bad("x") : a[0] === "network" && a[1] === "connect" ? bad("daemon") : undefined)).docker.ensure(SPEC)).rejects.toThrow(/falha ao ligar paas-mailtest-loja à rede paas-mailtestadm: daemon/);
  });

  it("rede criada ao mesmo tempo por outro pedido, e container já na rede, não são erro", async () => {
    const { docker } = harness((a) => {
      if (a[0] === "network" && a[1] === "inspect") return bad("No such");
      if (a[0] === "network" && a[1] === "create") return bad("network with name x already exists");
      if (a[0] === "network" && a[1] === "connect") return bad("endpoint already exists in network");
      if (a[0] === "inspect") return bad("No such");
      return undefined;
    });
    await expect(docker.ensure(SPEC)).resolves.toBeUndefined();
  });
});

describe("MailTestDocker.remove", () => {
  it("desligar mantendo as mensagens: tira o container e tenta a rede; o volume fica", async () => {
    const { docker, calls } = harness();
    await docker.remove("loja", { deleteData: false });
    expect(calls).toEqual([
      ["rm", "-f", "paas-mailtest-loja"],
      ["network", "rm", "paas-mailtest-loja"],
    ]);
  });

  it("desligar apagando: o volume sai também", async () => {
    const { docker, calls } = harness();
    await docker.remove("loja", { deleteData: true });
    expect(calls).toContainEqual(["volume", "rm", "-f", "paas-mailtest-loja-data"]);
  });

  it("container ou volume que já não existem não são erro; outra falha é", async () => {
    await expect(harness((a) => (a[0] === "rm" ? bad("Error: No such container") : a[0] === "volume" ? bad("No such volume") : undefined)).docker.remove("loja", { deleteData: true })).resolves.toBeUndefined();
    await expect(harness((a) => (a[0] === "rm" ? bad("daemon fora") : undefined)).docker.remove("loja", { deleteData: false })).rejects.toThrow(/falha ao remover/);
    await expect(harness((a) => (a[0] === "volume" ? bad("em uso") : undefined)).docker.remove("loja", { deleteData: true })).rejects.toThrow(/falha ao apagar as mensagens \(em uso\)/);
  });
});

describe("MailTestDocker: painel, estado e endereço", () => {
  it("o painel entra na rede de leitura uma vez; já nela, nada a fazer; fora de container, nada a fazer", async () => {
    const a = harness((x) => (x[0] === "inspect" ? ok('{"bridge":{}}') : x[0] === "network" && x[1] === "inspect" ? ok() : undefined));
    await a.docker.connectPanel("tws-panel");
    expect(a.calls).toContainEqual(["network", "connect", "paas-mailtestadm", "tws-panel"]);
    const b = harness((x) => (x[0] === "inspect" ? ok('{"paas-mailtestadm":{}}') : undefined));
    await b.docker.connectPanel("tws-panel");
    expect(b.calls.some((x) => x[0] === "network" && x[1] === "connect")).toBe(false);
    const c = harness((x) => (x[0] === "inspect" && x[1] === "-f" ? bad("No such container") : undefined));
    await c.docker.connectPanel("tws-panel");
    expect(c.calls.some((x) => x[0] === "network" && x[1] === "connect")).toBe(false);
    const d = harness((x) => (x[0] === "inspect" ? ok("não é json") : undefined));
    await d.docker.connectPanel("tws-panel");
    expect(d.calls).toContainEqual(["network", "connect", "paas-mailtestadm", "tws-panel"]);
    await expect(harness((x) => (x[0] === "inspect" ? ok("{}") : x[0] === "network" && x[1] === "connect" ? bad("negado") : undefined)).docker.connectPanel("tws-panel")).rejects.toThrow(/falha ao conectar o painel/);
    await expect(harness((x) => (x[0] === "inspect" ? ok("{}") : x[0] === "network" && x[1] === "connect" ? bad("already connected") : undefined)).docker.connectPanel("tws-panel")).resolves.toBeUndefined();
  });

  it("status e endereço", async () => {
    expect(await harness((x) => (x[0] === "inspect" ? ok("true\n") : undefined)).docker.status("loja")).toEqual({ installed: true, running: true });
    expect(await harness((x) => (x[0] === "inspect" ? ok("false") : undefined)).docker.status("loja")).toEqual({ installed: true, running: false });
    expect(await harness((x) => (x[0] === "inspect" ? bad("No such") : undefined)).docker.status("loja")).toEqual({ installed: false, running: false });
    const nets = (ip: string) => ok(JSON.stringify({ "paas-mailtestadm": { IPAddress: ip } }));
    expect(await harness((x) => (x[0] === "inspect" ? nets("172.30.0.9") : undefined)).docker.address("loja")).toBe("172.30.0.9");
    expect(await harness((x) => (x[0] === "inspect" ? nets("") : undefined)).docker.address("loja")).toBeNull();
    expect(await harness((x) => (x[0] === "inspect" ? bad("No such") : undefined)).docker.address("loja")).toBeNull();
    expect(await harness((x) => (x[0] === "inspect" ? ok("lixo") : undefined)).docker.address("loja")).toBeNull();
  });
});
