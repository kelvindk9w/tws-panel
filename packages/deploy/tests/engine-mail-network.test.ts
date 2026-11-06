/**
 * Rede de e-mail por projeto: os containers que estão rodando (ou parados) de um projeto com e-mail passam da paas-mail
 * compartilhada para a rede SÓ DELE (`paas-mail-<slug>`, com o Stalwart), sem parar nem recriar nada; banco/cache
 * entram ou saem conforme o carimbo `tws.mail.decided` que o deploy gravou, sem recalcular a regra. Também: criação da
 * rede com sub-rede da faixa do painel, remoção ao desativar o e-mail ou excluir o projeto, e a limpeza da paas-mail.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
/** O Stalwart entrando numa rede de projeto aparece na lista de chamadas, para conferir a ordem. */
const stalwart = async (network: string) => void calls.push(["<stalwart entra>", network]);
const engine = (extra: Record<string, unknown> = {}) => new DeployEngine({ ...config, joinMailServer: stalwart, ...extra });
const engineComCaixa = (network: string | null) => new DeployEngine({ ...config, joinMailServer: stalwart, mailTestForProject: async () => (network ? { network } : null) });

/** Saída do `docker inspect -f` (JSON) de um container. `shared`: apelidos na paas-mail. */
const info = (o: { decided?: string; image?: string; service?: string; nets?: string[]; mode?: string; shared?: string[] } = {}) =>
  JSON.stringify({
    mode: o.mode ?? "paas-loja_default",
    image: o.image ?? "minha-app:1",
    decided: o.decided ?? "",
    service: o.service ?? "",
    networks: Object.fromEntries((o.nets ?? ["paas-loja_default"]).map((n) => [n, { IPAddress: "10.0.0.2", Aliases: n === "paas-mail" ? (o.shared ?? null) : null }])),
  });

/**
 * Docker de mentira: a rede do projeto já existe, interna e do próprio projeto (`true <slug>`); `ps -q` lista os
 * containers; `inspect` devolve o JSON de cada um.
 */
const mundo = (containers: Record<string, string>, extra?: (a: string[]) => Result | undefined, owner = "loja") => {
  respostas = (a) => {
    const custom = extra?.(a);
    if (custom) return custom;
    if (a[0] === "network" && a[1] === "inspect") return ok(`true ${owner}\n`);
    if (a[0] === "ps" && a.includes("-q")) return ok(Object.keys(containers).join("\n") + "\n");
    if (a[0] === "inspect") return ok(containers[a.at(-1)!] ?? "");
    return ok();
  };
};
/** Rede do projeto ainda não existe; `subnets`: o que as redes do Docker já usam. */
const semRede = (subnets: string[] = []) => (a: string[]) => {
  if (a[0] === "network" && a[1] === "inspect" && a[2] === "-f" && a[3]!.includes("Internal")) return fail("Error: No such network");
  if (a[0] === "network" && a[1] === "ls") return ok(subnets.map((_, i) => `n${i}`).join("\n") + "\n");
  if (a[0] === "network" && a[1] === "inspect" && a[3]!.includes("IPAM")) return ok(subnets.join(" ") + "\n");
  return undefined;
};
const connects = () => calls.filter((c) => c[0] === "network" && c[1] === "connect");
const disconnects = () => calls.filter((c) => c[0] === "network" && c[1] === "disconnect");

describe("DeployEngine.joinMailNetwork — migração da paas-mail para a rede do projeto", () => {
  it("cria a rede do projeto (interna, sub-rede da faixa, label) e liga o Stalwart ANTES de qualquer container", async () => {
    mundo({ c1: info({ decided: "in", nets: ["paas-loja_default", "paas-mail"], shared: ["web"] }) }, semRede());
    await expect(engine().joinMailNetwork(projeto("loja"))).resolves.toBe(1);
    const create = calls.find((c) => c[1] === "create")!;
    expect(create).toEqual(["network", "create", "--internal", "--subnet", expect.stringMatching(/^10\.213\.\d+\.\d+\/26$/), "--label", "paas.managed=true", "--label", "paas.mail.project=loja", "paas-mail-loja"]);
    const i = (pred: (c: string[]) => boolean) => calls.findIndex(pred);
    expect(i((c) => c[0] === "<stalwart entra>")).toBeGreaterThan(i((c) => c[1] === "create"));
    expect(i((c) => c[0] === "<stalwart entra>")).toBeLessThan(i((c) => c[1] === "connect"));
  });

  it("os containers entram na rede do projeto com os MESMOS apelidos da paas-mail e só depois de TODOS entrarem saem da paas-mail", async () => {
    mundo({
      c1: info({ decided: "in", service: "web", nets: ["paas-loja_default", "paas-mail"], shared: ["web", "paas-loja-web-1", "c1"] }),
      c2: info({ decided: "in", service: "php", nets: ["paas-loja_default", "paas-mail"], shared: ["php", "php", "nome com espaço"] }),
    });
    const logs: string[] = [];
    await expect(engine().joinMailNetwork(projeto("loja"), (m) => logs.push(m))).resolves.toBe(2);
    expect(connects()).toEqual([
      // o id curto do container (c1) o docker põe sozinho; nome inválido nunca vira argumento
      ["network", "connect", "--alias", "web", "--alias", "paas-loja-web-1", "paas-mail-loja", "c1"],
      ["network", "connect", "--alias", "php", "paas-mail-loja", "c2"],
    ]);
    expect(disconnects()).toEqual([
      ["network", "disconnect", "paas-mail", "c1"],
      ["network", "disconnect", "paas-mail", "c2"],
    ]);
    const lastConnect = calls.lastIndexOf(connects().at(-1)!);
    const firstLeave = calls.indexOf(disconnects()[0]!);
    expect(firstLeave).toBeGreaterThan(lastConnect);
    expect(logs.join("")).toMatch(/web passou da paas-mail \(dividida com outros projetos\) para paas-mail-loja/);
  });

  it("sem apelido na paas-mail (instalação sem carimbo): entra com o nome do serviço; sem serviço, sem apelido", async () => {
    mundo({ app: info({ service: "web" }), solto: info() });
    await expect(engine().joinMailNetwork(projeto("loja"))).resolves.toBe(2);
    expect(connects()).toEqual([
      ["network", "connect", "--alias", "web", "paas-mail-loja", "app"],
      ["network", "connect", "paas-mail-loja", "solto"],
    ]);
    expect(disconnects()).toEqual([]);
  });

  it("idempotente: quem já está na rede do projeto e fora da paas-mail não é tocado (rodar de novo não muda nada)", async () => {
    mundo({ c1: info({ decided: "in", nets: ["paas-loja_default", "paas-mail-loja"] }) });
    await expect(engine().joinMailNetwork(projeto("loja"))).resolves.toBe(1);
    expect(connects()).toEqual([]);
    expect(disconnects()).toEqual([]);
    expect(calls.some((c) => c[1] === "create" || c[1] === "rm")).toBe(false);
  });

  it("migração interrompida no meio (já na rede nova, ainda na paas-mail): só falta sair da paas-mail", async () => {
    mundo({ c1: info({ decided: "in", nets: ["paas-loja_default", "paas-mail-loja", "paas-mail"] }) });
    await engine().joinMailNetwork(projeto("loja"));
    expect(connects()).toEqual([]);
    expect(disconnects()).toEqual([["network", "disconnect", "paas-mail", "c1"]]);
  });

  it("falha no meio (o 2º container não entra): o erro sobe e NINGUÉM sai da paas-mail (o SMTP segue pela rede antiga)", async () => {
    mundo(
      {
        c1: info({ decided: "in", nets: ["paas-loja_default", "paas-mail"] }),
        c2: info({ decided: "in", nets: ["paas-loja_default", "paas-mail"] }),
      },
      (a) => (a[1] === "connect" && a.at(-1) === "c2" ? fail("daemon fora") : undefined),
    );
    await expect(engine().joinMailNetwork(projeto("loja"))).rejects.toThrow(/falha ao ligar c2 à rede paas-mail-loja: daemon fora/);
    expect(disconnects()).toEqual([]);
  });

  it("o Stalwart não entrou na rede do projeto: o erro sobe e nenhum container é tocado", async () => {
    mundo({ c1: info({ decided: "in", nets: ["paas-loja_default", "paas-mail"] }) });
    const eng = engine({
      joinMailServer: async () => {
        throw new Error("rede sumiu");
      },
    });
    await expect(eng.joinMailNetwork(projeto("loja"))).rejects.toThrow(/o servidor de e-mail não entrou na rede paas-mail-loja \(rede sumiu\)/);
    expect(connects()).toEqual([]);
    expect(disconnects()).toEqual([]);
  });

  it("falha ao tirar da paas-mail sobe como erro; 'not connected' é tolerado", async () => {
    const cs = { c1: info({ decided: "in", nets: ["paas-loja_default", "paas-mail"] }) };
    mundo(cs, (a) => (a[1] === "disconnect" ? fail("container c1 is not connected to network paas-mail") : undefined));
    await expect(engine().joinMailNetwork(projeto("loja"))).resolves.toBe(1);
    mundo(cs, (a) => (a[1] === "disconnect" ? fail("busy") : undefined));
    await expect(engine().joinMailNetwork(projeto("loja"))).rejects.toThrow(/falha ao tirar c1 da rede paas-mail: busy/);
  });

  it("container parado (ps -a) também passa: a ligação vale quando ele subir; nada é iniciado nem parado", async () => {
    mundo({ parado: info({ decided: "in", nets: ["paas-loja_default", "paas-mail"] }) });
    await engine().joinMailNetwork(projeto("loja"));
    expect(calls.find((c) => c[0] === "ps")).toContain("-a");
    expect(connects()).toEqual([["network", "connect", "paas-mail-loja", "parado"]]);
    expect(disconnects()).toEqual([["network", "disconnect", "paas-mail", "parado"]]);
    expect(calls.some((c) => ["start", "stop", "restart", "rm", "create", "run"].includes(c[0]!))).toBe(false);
  });

  it("dois projetos: cada container só entra na rede do PRÓPRIO projeto", async () => {
    mundo({ a1: info({ decided: "in", nets: ["paas-projeto-a_default", "paas-mail"] }) }, undefined, "projeto-a");
    await engine().joinMailNetwork(projeto("projeto-a"));
    mundo({ b1: info({ decided: "in", nets: ["paas-projeto-b_default", "paas-mail"] }) }, undefined, "projeto-b");
    await engine().joinMailNetwork(projeto("projeto-b"));
    expect(connects()).toEqual([
      ["network", "connect", "paas-mail-projeto-a", "a1"],
      ["network", "connect", "paas-mail-projeto-b", "b1"],
    ]);
    expect(calls.filter((c) => c[0] === "<stalwart entra>").map((c) => c[1])).toEqual(["paas-mail-projeto-a", "paas-mail-projeto-b"]);
  });

  it("projeto sem containers: nada a ligar (nem a rede é criada)", async () => {
    respostas = () => ok();
    await expect(engine().joinMailNetwork(projeto("loja"))).resolves.toBe(0);
    expect(calls.some((c) => c[0] === "network")).toBe(false);
  });

  it("container que compartilha a rede de outro (container:/host/none) não recebe network connect e não conta", async () => {
    mundo({ c1: info({ decided: "in" }), c2: info({ decided: "in", mode: "container:c1" }), c3: info({ decided: "in", mode: "host" }), c4: info({ decided: "in", mode: "none" }) });
    await expect(engine().joinMailNetwork(projeto("loja"))).resolves.toBe(1);
    expect(connects()).toEqual([["network", "connect", "paas-mail-loja", "c1"]]);
  });

  it("L1/L6: inspect que falha ou devolve texto que não é JSON pula o container", async () => {
    mundo({ c1: "paas-loja_default\n", c2: info({ decided: "in" }), c3: "" }, (a) => (a[0] === "inspect" && a.at(-1) === "c3" ? fail("No such object") : undefined));
    await expect(engine().joinMailNetwork(projeto("loja"))).resolves.toBe(1);
    expect([...connects(), ...disconnects()]).toEqual([["network", "connect", "paas-mail-loja", "c2"]]);
  });

  it("valores de tipo errado no inspect viram vazio (sem carimbo e sem imagem de banco: liga)", async () => {
    mundo({ c1: JSON.stringify({ mode: 1, image: null, decided: 3, service: [], networks: "x" }) });
    await expect(engine().joinMailNetwork(projeto("loja"))).resolves.toBe(1);
    expect(connects()).toEqual([["network", "connect", "paas-mail-loja", "c1"]]);
    expect(disconnects()).toEqual([]);
  });

  it("o -previous guardado parado também passa para a rede nova (um deploy em andamento pode voltar para ele)", async () => {
    const prev = "f".repeat(64);
    mundo({ c1: info({ decided: "in", nets: ["paas-loja_default", "paas-mail"] }) }, (a) =>
      a[0] === "inspect" && a.at(-1) === "paas-loja-app-previous" ? ok(`${prev}\n`) : a[0] === "inspect" && a.at(-1) === prev ? ok(info({ decided: "in", nets: ["paas-net", "paas-mail"] })) : undefined,
    );
    await expect(engine().joinMailNetwork(projeto("loja"))).resolves.toBe(2);
    expect(connects().map((c) => c.at(-1))).toEqual(["c1", prev]);
    expect(disconnects()).toEqual([
      ["network", "disconnect", "paas-mail", "c1"],
      ["network", "disconnect", "paas-mail", prev],
    ]);
    expect(calls.some((c) => c[0] === "start")).toBe(false);
  });

  it("container removido no meio do caminho (deploy recriando o serviço) é pulado, sem falhar o projeto", async () => {
    mundo({ c1: info({ decided: "in", nets: ["paas-loja_default", "paas-mail"] }), c2: info({ decided: "in", nets: ["paas-loja_default", "paas-mail"] }) }, (a) =>
      a[1] === "connect" && a.at(-1) === "c1" ? fail("Error response from daemon: No such container: c1") : undefined,
    );
    await expect(engine().joinMailNetwork(projeto("loja"))).resolves.toBe(1);
    expect(disconnects()).toEqual([["network", "disconnect", "paas-mail", "c2"]]);
  });

  it("container que já está na rede ('already exists') não é erro; outra falha é", async () => {
    mundo({ c1: info({ decided: "in" }) }, (a) => (a[1] === "connect" ? fail("endpoint with name x already exists in network paas-mail-loja") : undefined));
    await expect(engine().joinMailNetwork(projeto("loja"))).resolves.toBe(1);
  });
});

describe("rede de e-mail do projeto — criação e sub-rede", () => {
  it("escolhe um bloco /26 que não se sobrepõe a nenhuma rede do Docker", async () => {
    // a faixa toda menos um bloco já usada por outras redes: só sobra aquele
    const usadas = ["10.213.0.0/17", "10.213.128.0/18", "10.213.192.0/19", "10.213.224.0/20", "10.213.240.0/21", "10.213.248.0/22", "10.213.252.0/23", "10.213.254.0/24", "10.213.255.0/25", "10.213.255.128/26", "fd00::/64"];
    mundo({ c1: info({ decided: "in" }) }, semRede(usadas));
    await engine().joinMailNetwork(projeto("loja"));
    expect(calls.find((c) => c[1] === "create")).toContain("10.213.255.192/26");
  });

  it("outra rede tomou o bloco no meio do caminho (overlap): tenta o próximo", async () => {
    let tentativas = 0;
    mundo({ c1: info({ decided: "in" }) }, (a) => semRede()(a) ?? (a[1] === "create" && tentativas++ === 0 ? fail("Pool overlaps with other one on this address space") : undefined));
    await engine().joinMailNetwork(projeto("loja"));
    const creates = calls.filter((c) => c[1] === "create").map((c) => c[c.indexOf("--subnet") + 1]);
    expect(creates).toHaveLength(2);
    expect(creates[0]).not.toBe(creates[1]);
  });

  it("faixa cheia, overlap sem fim, erro de create e erro ao listar as redes: erro claro", async () => {
    mundo({ c1: info({ decided: "in" }) }, semRede(["10.213.0.0/16"]));
    await expect(engine().joinMailNetwork(projeto("loja"))).rejects.toThrow(/a faixa das redes de e-mail \(10\.213\.0\.0\/16\) está cheia/);
    mundo({ c1: info({ decided: "in" }) }, (a) => semRede()(a) ?? (a[1] === "create" ? fail("overlaps") : undefined));
    await expect(engine().joinMailNetwork(projeto("loja"))).rejects.toThrow(/todo bloco tentado já estava em uso/);
    mundo({ c1: info({ decided: "in" }) }, (a) => semRede()(a) ?? (a[1] === "create" ? fail("sem permissão") : undefined));
    await expect(engine().joinMailNetwork(projeto("loja"))).rejects.toThrow(/falha ao criar a rede paas-mail-loja: sem permissão/);
    mundo({ c1: info({ decided: "in" }) }, (a) => (a[1] === "ls" ? fail("daemon fora") : semRede()(a)));
    await expect(engine().joinMailNetwork(projeto("loja"))).rejects.toThrow(/falha ao listar as redes do Docker: daemon fora/);
    mundo({ c1: info({ decided: "in" }) }, (a) => (a[1] === "inspect" && a[3]!.includes("IPAM") ? fail("daemon fora") : semRede(["10.0.0.0/8"])(a)));
    await expect(engine().joinMailNetwork(projeto("loja"))).rejects.toThrow(/falha ao ler as sub-redes do Docker: daemon fora/);
  });

  it("rede apagada entre o ls e o inspect: usa o que veio", async () => {
    mundo({ c1: info({ decided: "in" }) }, (a) => (a[1] === "inspect" && a[3]!.includes("IPAM") ? { code: 1, stdout: "10.213.0.0/17\n", stderr: "No such network: n9" } : semRede(["x"])(a)));
    await engine().joinMailNetwork(projeto("loja"));
    expect(calls.find((c) => c[1] === "create")![4]).toMatch(/^10\.213\.(1[2-9]\d|2[0-5]\d)\./);
  });

  it("a faixa vem de PAAS_MAIL_SUBNET_POOL (via contexto); valor inválido ou público usa a padrão", async () => {
    mundo({ c1: info({ decided: "in" }) }, semRede());
    await engine({ mailSubnetPool: "172.30.0.0/24" }).joinMailNetwork(projeto("loja"));
    expect(calls.find((c) => c[1] === "create")![4]).toMatch(/^172\.30\.0\.\d+\/26$/);
    calls.length = 0;
    await engine({ mailSubnetPool: "203.0.113.0/24" }).joinMailNetwork(projeto("loja"));
    expect(calls.find((c) => c[1] === "create")![4]).toMatch(/^10\.213\./);
  });

  it("rede com o nome do projeto que não é interna ou não é deste projeto: recriada; sem conseguir, erro e nada ligado", async () => {
    mundo({ c1: info({ decided: "in" }) }, (a) => (a[1] === "inspect" && a[3]!.includes("Internal") ? ok("false loja\n") : semRede()(a)));
    await engine().joinMailNetwork(projeto("loja"));
    expect(calls).toContainEqual(["network", "rm", "paas-mail-loja"]);
    expect(calls.some((c) => c[1] === "create")).toBe(true);

    calls.length = 0;
    mundo({ c1: info({ decided: "in" }) }, undefined, "outro");
    await engine().joinMailNetwork(projeto("loja"));
    expect(calls).toContainEqual(["network", "rm", "paas-mail-loja"]);

    calls.length = 0;
    mundo({ c1: info({ decided: "in" }) }, (a) => (a[1] === "rm" ? fail("has active endpoints") : undefined), "outro");
    await expect(engine().joinMailNetwork(projeto("loja"))).rejects.toThrow(/não é a rede de e-mail interna.*has active endpoints/);
    expect(connects()).toEqual([]);
  });

  it("duas criações ao mesmo tempo: uma de cada vez (não escolhem o mesmo bloco às cegas)", async () => {
    const order: string[] = [];
    mundo({ c1: info({ decided: "in" }) }, (a) => {
      if (a[1] === "create") order.push(`create ${a.at(-1)}`);
      if (a[1] === "ls") order.push("ls");
      return semRede()(a);
    }, "x");
    const eng = engine();
    await Promise.all([eng.joinMailNetwork(projeto("projeto-a")), eng.joinMailNetwork(projeto("projeto-b"))]);
    expect(order).toEqual(["ls", "create paas-mail-projeto-a", "ls", "create paas-mail-projeto-b"]);
  });

  it("uma criação que falhou não trava as seguintes", async () => {
    let primeira = true;
    mundo({ c1: info({ decided: "in" }) }, (a) => semRede()(a) ?? (a[1] === "create" && primeira ? ((primeira = false), fail("sem permissão")) : undefined));
    const eng = engine();
    await expect(eng.joinMailNetwork(projeto("loja"))).rejects.toThrow(/sem permissão/);
    await expect(eng.joinMailNetwork(projeto("loja"))).resolves.toBe(1);
  });

  it("slug 'admin' não toma a rede da administração do Stalwart (paas-mail-admin): vira paas-mail--admin", async () => {
    mundo({ c1: info({ decided: "in" }) }, undefined, "admin");
    await engine().joinMailNetwork(projeto("admin"));
    expect(connects()).toEqual([["network", "connect", "paas-mail--admin", "c1"]]);
    expect(calls.some((c) => c.includes("paas-mail-admin"))).toBe(false);
  });
});

describe("DeployEngine.joinMailNetwork com a caixa de teste de e-mail", () => {
  it("liga os containers à rede INTERNA do Mailpit, nunca à do servidor de e-mail real (e o Stalwart não entra nela)", async () => {
    mundo({ c1: info({ decided: "in" }) }, (a) => (a[0] === "network" && a[1] === "inspect" ? fail("no") : undefined));
    await expect(engineComCaixa("paas-mailtest-loja").joinMailNetwork(projeto("loja"))).resolves.toBe(1);
    expect(calls).toContainEqual(["network", "create", "--internal", "--label", "paas.managed=true", "paas-mailtest-loja"]);
    expect(calls).toContainEqual(["network", "connect", "paas-mailtest-loja", "c1"]);
    expect(calls.some((c) => c.includes("paas-mail") || c.includes("paas-mail-loja") || c[0] === "<stalwart entra>")).toBe(false);
  });

  it("com a caixa ligada, quem ainda estava na paas-mail sai dela depois de entrar na rede do Mailpit", async () => {
    mundo({ c1: info({ decided: "in", nets: ["paas-loja_default", "paas-mail"] }) });
    await engineComCaixa("paas-mailtest-loja").joinMailNetwork(projeto("loja"));
    expect(connects()).toEqual([["network", "connect", "paas-mailtest-loja", "c1"]]);
    expect(disconnects()).toEqual([["network", "disconnect", "paas-mail", "c1"]]);
  });

  it("caixa desligada (null): vai para a rede de e-mail do projeto", async () => {
    mundo({ c1: info({ decided: "in" }) });
    await engineComCaixa(null).joinMailNetwork(projeto("loja"));
    expect(connects()).toEqual([["network", "connect", "paas-mail-loja", "c1"]]);
  });

  it("REVISÃO: rede do Mailpit que já existe e TEM saída é recriada como interna; interna é reaproveitada", async () => {
    mundo({ c1: info({ decided: "in" }) }, (a) => (a[0] === "network" && a[1] === "inspect" ? ok("false\n") : undefined));
    await engineComCaixa("paas-mailtest-loja").joinMailNetwork(projeto("loja"));
    expect(calls).toContainEqual(["network", "rm", "paas-mailtest-loja"]);
    expect(calls).toContainEqual(["network", "create", "--internal", "--label", "paas.managed=true", "paas-mailtest-loja"]);

    calls.length = 0;
    mundo({ c1: info({ decided: "in" }) });
    await engineComCaixa("paas-mailtest-loja").joinMailNetwork(projeto("loja"));
    expect(calls.some((c) => c[0] === "network" && (c[1] === "rm" || c[1] === "create"))).toBe(false);
  });

  it("REVISÃO: não conseguiu recriar a rede com saída: o erro sobe (nunca liga o app a uma rede com saída)", async () => {
    mundo({ c1: info({ decided: "in" }) }, (a) => {
      if (a[0] === "network" && a[1] === "inspect") return ok("false\n");
      if (a[0] === "network" && a[1] === "rm") return fail("has active endpoints");
      return undefined;
    });
    await expect(engineComCaixa("paas-mailtest-loja").joinMailNetwork(projeto("loja"))).rejects.toThrow(/não é a rede de e-mail interna.*has active endpoints/);
    expect(connects()).toEqual([]);
  });
});

describe("DeployEngine.joinMailNetwork — banco e cache ficam fora da rede de e-mail", () => {
  it("in liga; out desliga da paas-mail (e da do projeto) e mantém a rede do compose", async () => {
    mundo({
      app: info({ decided: "in", nets: ["paas-loja_default"] }),
      db: info({ decided: "out", image: "paas-loja-db", nets: ["paas-loja_default", "paas-mail", "paas-mail-loja"] }),
      cache: info({ decided: "out", nets: ["paas-loja_default"] }),
    });
    const logs: string[] = [];
    await expect(engine().joinMailNetwork(projeto("loja"), (m) => logs.push(m))).resolves.toBe(1);
    expect(connects()).toEqual([["network", "connect", "paas-mail-loja", "app"]]);
    expect(disconnects()).toEqual([
      ["network", "disconnect", "paas-mail-loja", "db"],
      ["network", "disconnect", "paas-mail", "db"],
    ]);
    expect(logs.join("")).toMatch(/saiu de paas-mail/);
  });

  it("M1: a imagem e a label tws.mail do container não contam quando há carimbo (não recalcula)", async () => {
    mundo({
      dbBuild: info({ decided: "out", image: "paas-loja-db", service: "db", nets: ["paas-loja_default", "paas-mail"] }),
      forcado: info({ decided: "in", image: "postgres:16" }),
    });
    await expect(engine().joinMailNetwork(projeto("loja"))).resolves.toBe(1);
    expect(calls).toContainEqual(["network", "disconnect", "paas-mail", "dbBuild"]);
    expect(calls).toContainEqual(["network", "connect", "paas-mail-loja", "forcado"]);
  });

  it("M1/R1: sem carimbo, desliga quem tem imagem de banco e liga o resto", async () => {
    mundo({
      velho: info({ image: "docker.io/library/redis:7", service: "cache", nets: ["paas-loja_default", "paas-mail"] }),
      app: info({ image: "minha-app:1", service: "web", nets: ["paas-loja_default", "paas-mail"], shared: ["web"] }),
    });
    const logs: string[] = [];
    await expect(engine().joinMailNetwork(projeto("loja"), (m) => logs.push(m))).resolves.toBe(1);
    expect(calls).toContainEqual(["network", "disconnect", "paas-mail", "velho"]);
    expect(calls).toContainEqual(["network", "connect", "--alias", "web", "paas-mail-loja", "app"]);
    expect(logs.join("")).toMatch(/cache saiu de paas-mail \(deve ficar fora da rede de e-mail\)/);
  });

  it("M4: container só com redes de e-mail não é desligado, e o log avisa", async () => {
    mundo({ db: info({ decided: "out", nets: ["paas-mailtest-loja", "paas-mail"] }), so: info({ decided: "out", nets: ["paas-mail-loja"] }) });
    const logs: string[] = [];
    await engine().joinMailNetwork(projeto("loja"), (m) => logs.push(m));
    expect(disconnects()).toEqual([]);
    expect(logs.join("")).toMatch(/db só tem rede de e-mail .*deveria ficar fora dela/);
    expect(logs.join("")).toMatch(/so só tem rede de e-mail/);
  });

  it("M4: recalcula a cada desligamento (nunca deixa o container sem rede que não seja de e-mail)", async () => {
    mundo({ db: info({ decided: "out", nets: ["paas-loja_default", "paas-mailtest-loja", "paas-mail"] }) });
    await engineComCaixa("paas-mailtest-loja").joinMailNetwork(projeto("loja"));
    expect(calls).toContainEqual(["network", "disconnect", "paas-mailtest-loja", "db"]);
    expect(calls).toContainEqual(["network", "disconnect", "paas-mail", "db"]);
    expect(connects()).toEqual([]);
  });

  it("falha ao desligar sobe como erro; 'not connected' e 'no such container' são ignorados", async () => {
    const containers = { db: info({ decided: "out", nets: ["paas-loja_default", "paas-mail"] }) };
    mundo(containers, (a) => (a[1] === "disconnect" ? fail("container db is not connected to network paas-mail") : undefined));
    await expect(engine().joinMailNetwork(projeto("loja"))).resolves.toBe(0);
    mundo(containers, (a) => (a[1] === "disconnect" ? fail("Error: No such container: db") : undefined));
    await expect(engine().joinMailNetwork(projeto("loja"))).resolves.toBe(0);
    mundo(containers, (a) => (a[1] === "disconnect" ? fail("daemon fora") : undefined));
    await expect(engine().joinMailNetwork(projeto("loja"))).rejects.toThrow(/falha ao desligar db da rede paas-mail: daemon fora/);
  });

  it("projeto com diretório próprio: o cálculo não lê mais o compose no restart", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paas-join-"));
    try {
      mundo({ c1: info({ decided: "out", service: "pg", nets: ["paas-loja_default", "paas-mail"] }) });
      const proj = { ...projeto("loja"), detection: { type: "compose", composeFile: "compose.yml" } } as unknown as Project;
      await new DeployEngine({ ...config, projectsDir: dir }).joinMailNetwork(proj);
      expect(calls).toContainEqual(["network", "disconnect", "paas-mail", "c1"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("DeployEngine.removeMailNetwork — e-mail desativado ou projeto excluído", () => {
  const existe = (a: string[]) => a[0] === "network" && a[1] === "inspect" && a[3] === "{{.Name}}";
  const lista = (a: string[]) => a[0] === "ps" && a.includes("network=paas-mail-loja");
  const rede = (ids: string[], extra?: (a: string[]) => Result | undefined, containers: Record<string, string> = {}) =>
    mundo(containers, (a) => extra?.(a) ?? (lista(a) ? ok(ids.map((i) => `${i}\n`).join("")) : undefined));

  it("desliga na hora TODOS da rede do projeto, rodando ou PARADOS (inclusive o Stalwart), e apaga a rede, sem parar ninguém", async () => {
    rede(["idapp", "idstalwart"]);
    const logs: string[] = [];
    await expect(engine().removeMailNetwork(projeto("loja"), (m) => logs.push(m))).resolves.toBe(2);
    // o `ps -a` com filtro de rede (e não o .Containers do inspect, que só tem os que rodam): um container parado
    // ligado a uma rede apagada não sobe mais — o Stalwart parado deixaria todos os projetos sem e-mail
    expect(calls).toContainEqual(["ps", "-a", "-q", "--no-trunc", "--filter", "network=paas-mail-loja"]);
    expect(disconnects()).toEqual([
      ["network", "disconnect", "-f", "paas-mail-loja", "idapp"],
      ["network", "disconnect", "-f", "paas-mail-loja", "idstalwart"],
    ]);
    const rmAt = calls.findIndex((c) => c[0] === "network" && c[1] === "rm");
    expect(rmAt).toBeGreaterThan(calls.findIndex((c) => c[1] === "disconnect" && c.at(-1) === "idstalwart"));
    expect(calls.some((c) => ["stop", "restart", "rm", "start"].includes(c[0]!))).toBe(false);
    expect(logs.join("")).toMatch(/Rede de e-mail paas-mail-loja apagada \(2 container\(es\) desligado\(s\), inclusive o servidor de e-mail\)/);
  });

  it("rede que não existe: nada a fazer; container do projeto que ainda estava na paas-mail antiga sai dela", async () => {
    rede([], (a) => (existe(a) ? fail("Error: No such network: paas-mail-loja") : undefined), {
      app: info({ decided: "in", nets: ["paas-loja_default", "paas-mail"] }),
      outro: info({ decided: "in", nets: ["paas-loja_default"] }),
    });
    await expect(engine().removeMailNetwork(projeto("loja"))).resolves.toBe(0);
    expect(calls.some((c) => c[1] === "rm")).toBe(false);
    expect(disconnects()).toEqual([["network", "disconnect", "paas-mail", "app"]]);
  });

  it("erros: leitura da rede, desligar e apagar sobem; 'not connected' e rede já apagada são tolerados", async () => {
    rede([], (a) => (existe(a) ? fail("daemon fora") : undefined));
    await expect(engine().removeMailNetwork(projeto("loja"))).rejects.toThrow(/falha ao ler a rede paas-mail-loja: daemon fora/);
    rede([], (a) => (lista(a) ? fail("daemon fora") : undefined));
    await expect(engine().removeMailNetwork(projeto("loja"))).rejects.toThrow(/falha ao ler a rede paas-mail-loja: daemon fora/);
    expect(calls.some((c) => c[1] === "rm")).toBe(false);
    rede(["c1"], (a) => (a[1] === "disconnect" ? fail("busy") : undefined));
    await expect(engine().removeMailNetwork(projeto("loja"))).rejects.toThrow(/falha ao tirar c1 da rede paas-mail-loja: busy/);
    rede(["c1"], (a) => (a[1] === "disconnect" ? fail("is not connected") : a[1] === "rm" ? fail("No such network") : undefined));
    await expect(engine().removeMailNetwork(projeto("loja"))).resolves.toBe(1);
    rede([], (a) => (a[1] === "rm" ? fail("has active endpoints") : undefined));
    await expect(engine().removeMailNetwork(projeto("loja"))).rejects.toThrow(/falha ao apagar a rede paas-mail-loja: has active endpoints/);
  });

  it("excluir o projeto apaga a rede de e-mail dele; falha só avisa no log da remoção", async () => {
    rede(["idstalwart"]);
    await engine().remove(projeto("loja"), () => undefined);
    expect(calls).toContainEqual(["network", "disconnect", "-f", "paas-mail-loja", "idstalwart"]);
    expect(calls).toContainEqual(["network", "rm", "paas-mail-loja"]);

    rede([], (a) => (existe(a) ? fail("daemon fora") : undefined));
    const logs: string[] = [];
    await engine().remove(projeto("loja"), (m) => logs.push(m));
    expect(logs.join("")).toMatch(/a rede de e-mail paas-mail-loja não foi apagada agora \(falha ao ler a rede paas-mail-loja: daemon fora\)/);
  });
});

describe("DeployEngine.sweepSharedMailNetwork — a paas-mail fica só com o servidor de e-mail", () => {
  const ID = (c: string) => c.repeat(64);
  /** Saída do inspect de dono: labels e redes do container. */
  const dono = (labels: Record<string, string> | null, nets: string[]) => JSON.stringify({ labels, networks: Object.fromEntries(nets.map((n) => [n, {}])) });
  const membros = (linhas: string[], donos: Record<string, string> = {}, extra?: (a: string[]) => Result | undefined) => {
    respostas = (a) => extra?.(a) ?? (a[0] === "ps" ? ok(linhas.join("\n") + "\n") : a[0] === "inspect" ? ok(donos[a.at(-1)!] ?? "") : ok());
  };
  const compose = (slug: string) => ({ "com.docker.compose.project": `paas-${slug}` });

  it("tira só quem não depende mais dela para o SMTP; nunca quem ainda depende", async () => {
    membros(
      [
        `${ID("a")} paas-stalwart`,
        `${ID("b")} paas-webmail`,
        `${ID("c")} paas-projeto-a-web-1`,
        `${ID("d")} paas-projeto-b-php-1`,
        `${ID("e")} paas-semmail-app`,
        `${ID("f")} paas-projeto-c-app-1`,
        `${ID("1")} meu-container`,
        `${ID("2")} paas-semmail-worker`,
        `${ID("3")} paas-projeto-c-fila-1`,
        "",
      ],
      {
        [ID("c")]: dono(compose("projeto-a"), ["paas-projeto-a_default", "paas-mail", "paas-mail-projeto-a"]),
        [ID("e")]: dono({ "paas.project": "semmail", "paas.managed": "true" }, ["paas-net", "paas-mail"]),
        [ID("f")]: dono(compose("projeto-c"), ["paas-projeto-c_default", "paas-mail"]),
        [ID("1")]: dono(null, ["bridge", "paas-mail"]),
        [ID("2")]: dono({ "paas.project": "semmail" }, ["paas-mail"]),
        [ID("3")]: dono(compose("projeto-c"), ["paas-projeto-c_default", "paas-mail", "paas-mailtest-projeto-c"]),
      },
    );
    const logs: string[] = [];
    const n = await engine().sweepSharedMailNetwork(["paas-stalwart", "paas-webmail"], new Set(["dddddddddddd"]), new Set(["projeto-a", "projeto-b", "projeto-c"]), (m) => logs.push(m));
    expect(calls[0]).toEqual(["ps", "-a", "--no-trunc", "--filter", "network=paas-mail", "--format", "{{.ID}} {{.Names}}"]);
    // c: já está na rede dele; e: projeto sem e-mail; 3: na caixa de teste
    expect(disconnects()).toEqual([
      ["network", "disconnect", "paas-mail", ID("c")],
      ["network", "disconnect", "paas-mail", ID("e")],
      ["network", "disconnect", "paas-mail", ID("3")],
    ]);
    expect(n).toBe(3);
    const texto = logs.join("");
    expect(texto).toMatch(/paas-projeto-a-web-1 saiu da paas-mail \(agora só do servidor de e-mail\)/);
    expect(texto).toMatch(/paas-projeto-c-app-1 \(projeto projeto-c, com e-mail\) ainda não está na rede de e-mail dele e segue na paas-mail/);
    expect(texto).toMatch(/meu-container não é container de projeto do painel e segue na paas-mail/);
    expect(texto).toMatch(/paas-semmail-worker só tem rede de e-mail e segue na paas-mail/);
  });

  it("falha ao desligar ou ao ler um só avisa (a próxima rodada tenta); falha ao listar sobe", async () => {
    membros(
      [`${ID("c")} x`, `${ID("e")} y`, `${ID("f")} z`],
      { [ID("c")]: dono({ "paas.project": "s" }, ["paas-net", "paas-mail"]), [ID("e")]: dono({ "paas.project": "s" }, ["paas-net", "paas-mail"]), [ID("f")]: "{lixo" },
      (a) => (a[1] === "disconnect" && a.at(-1) === ID("c") ? fail("busy") : a[1] === "disconnect" && a.at(-1) === ID("e") ? fail("is not connected") : undefined),
    );
    const logs: string[] = [];
    await expect(engine().sweepSharedMailNetwork([], new Set(), new Set(), (m) => logs.push(m))).resolves.toBe(1);
    expect(logs.join("")).toMatch(/x não saiu da paas-mail agora \(busy\)/);
    expect(logs.join("")).toMatch(/não consegui ler z agora; ele segue na paas-mail/);
    membros([`${ID("c")} x`], {}, (a) => (a[0] === "inspect" ? fail("No such container") : undefined));
    await expect(engine().sweepSharedMailNetwork([], new Set(), new Set())).resolves.toBe(0);
    expect(disconnects()).toHaveLength(2);
    membros([], {}, (a) => (a[0] === "ps" ? fail("daemon fora") : undefined));
    await expect(engine().sweepSharedMailNetwork([], new Set(), new Set())).rejects.toThrow(/falha ao ler a rede paas-mail: daemon fora/);
  });
});

describe("container único (docker run) com e-mail", () => {
  it("leva o carimbo tws.mail.decided=in só quando o e-mail está habilitado, e entra na rede do PRÓPRIO projeto", async () => {
    respostas = (a) => (a[0] === "network" && a[1] === "inspect" ? ok("true loja\n") : ok());
    const eng = engine() as unknown as { runDockerfileContainer(p: Project, image: string, log: () => void, env: Record<string, string>, tz: null): Promise<void> };
    await eng.runDockerfileContainer(projeto("loja"), "img", () => {}, { SMTP_HOST: "mail.loja.test" }, null);
    const run = calls.find((c) => c[0] === "run")!;
    expect(run.join(" ")).toContain("--label tws.mail.decided=in");
    expect(calls).toContainEqual(["network", "connect", "paas-mail-loja", "paas-loja-app"]);
    expect(calls).toContainEqual(["<stalwart entra>", "paas-mail-loja"]);
    calls.length = 0;
    await eng.runDockerfileContainer(projeto("loja"), "img", () => {}, {}, null);
    expect(calls.find((c) => c[0] === "run")!.join(" ")).not.toContain("tws.mail.decided");
    expect(calls.some((c) => c[0] === "network")).toBe(false);
  });

  it("a rede (com o Stalwart) é garantida ANTES de mexer no container que está no ar; se falhar, nada é tocado", async () => {
    respostas = (a) => (a[0] === "network" && a[1] === "inspect" ? ok("true loja\n") : ok());
    const eng = engine({
      joinMailServer: async () => {
        throw new Error("daemon ocupado");
      },
    }) as unknown as { runDockerfileContainer(p: Project, image: string, log: () => void, env: Record<string, string>, tz: null): Promise<void> };
    await expect(eng.runDockerfileContainer(projeto("loja"), "img", () => {}, { SMTP_HOST: "mail.loja.test" }, null)).rejects.toThrow(/o servidor de e-mail não entrou na rede paas-mail-loja/);
    expect(calls.some((c) => ["run", "rm", "rename", "stop"].includes(c[0]!))).toBe(false);
  });
});
