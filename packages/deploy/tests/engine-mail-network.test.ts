/**
 * Migração do e-mail para a rede paas-mail (A4) e regra de banco/cache: os containers que estão rodando entram na
 * rede de e-mail (ou saem dela) conforme o carimbo `tws.mail.decided` que o deploy gravou, sem recalcular a regra.
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

const projeto = (slug: string) => ({ id: slug, name: slug, slug }) as unknown as Project;
const config = { projectsDir: "/tmp/x", caddyDir: "/tmp/x/caddy", nodeImage: "node:22", staticImage: "nginx:alpine", caddyHttpPort: 80, caddyHttpsPort: 443 };
const engine = () => new DeployEngine(config);
const engineComCaixa = (network: string | null) => new DeployEngine({ ...config, mailTestForProject: async () => (network ? { network } : null) });

/** Saída do `docker inspect -f` (JSON) de um container. */
const info = (o: { decided?: string; image?: string; service?: string; nets?: string[]; mode?: string } = {}) =>
  JSON.stringify({
    mode: o.mode ?? "paas-loja_default",
    image: o.image ?? "minha-app:1",
    decided: o.decided ?? "",
    service: o.service ?? "",
    networks: Object.fromEntries((o.nets ?? ["paas-loja_default"]).map((n) => [n, { IPAddress: "10.0.0.2" }])),
  });

const mundo = (containers: Record<string, string>, extra?: (a: string[]) => Result | undefined) => {
  respostas = (a) => {
    const custom = extra?.(a);
    if (custom) return custom;
    if (a[0] === "network" && a[1] === "inspect") return { code: 0, stdout: "true\n", stderr: "" };
    if (a[0] === "ps" && a.includes("-q")) return { code: 0, stdout: Object.keys(containers).join("\n") + "\n", stderr: "" };
    if (a[0] === "inspect") return { code: 0, stdout: containers[a.at(-1)!] ?? "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
};

describe("DeployEngine.joinMailNetwork", () => {
  it("liga à paas-mail os containers carimbados in (criando a rede se faltar)", async () => {
    mundo({ c1: info({ decided: "in" }), c2: info({ decided: "in" }) }, (a) => (a[0] === "network" && a[1] === "inspect" ? { code: 1, stdout: "", stderr: "no" } : undefined));
    await expect(engine().joinMailNetwork(projeto("loja"))).resolves.toBe(2);
    expect(calls).toContainEqual(["network", "create", "--label", "paas.managed=true", "paas-mail"]);
    expect(calls).toContainEqual(["network", "connect", "paas-mail", "c1"]);
    expect(calls).toContainEqual(["network", "connect", "paas-mail", "c2"]);
  });

  it("container que já está na rede não é erro; outra falha é", async () => {
    mundo({ c1: info({ decided: "in" }) }, (a) => (a[1] === "connect" ? { code: 1, stdout: "", stderr: "endpoint with name x already exists in network paas-mail" } : undefined));
    await expect(engine().joinMailNetwork(projeto("loja"))).resolves.toBe(1);
    mundo({ c1: info({ decided: "in" }) }, (a) => (a[1] === "connect" ? { code: 1, stdout: "", stderr: "daemon fora" } : undefined));
    await expect(engine().joinMailNetwork(projeto("loja"))).rejects.toThrow(/falha ao ligar c1 à rede paas-mail: daemon fora/);
  });

  it("falha ao criar a rede é erro claro", async () => {
    mundo({ c1: info({ decided: "in" }) }, (a) => (a[0] === "network" ? { code: 1, stdout: "", stderr: "sem endereços" } : undefined));
    await expect(engine().joinMailNetwork(projeto("loja"))).rejects.toThrow(/falha ao criar a rede paas-mail: sem endereços/);
  });

  it("projeto sem containers: nada a ligar", async () => {
    respostas = () => ({ code: 0, stdout: "", stderr: "" });
    await expect(engine().joinMailNetwork(projeto("loja"))).resolves.toBe(0);
  });

  it("container que compartilha a rede de outro (container:/host/none) não recebe network connect e não conta", async () => {
    mundo({ c1: info({ decided: "in" }), c2: info({ decided: "in", mode: "container:c1" }), c3: info({ decided: "in", mode: "host" }), c4: info({ decided: "in", mode: "none" }) });
    await expect(engine().joinMailNetwork(projeto("loja"))).resolves.toBe(1);
    expect(calls).toContainEqual(["network", "connect", "paas-mail", "c1"]);
    expect(calls.filter((c) => c[1] === "connect")).toHaveLength(1);
  });

  it("L1/L6: inspect que falha ou devolve texto que não é JSON pula o container", async () => {
    mundo({ c1: "paas-loja_default\n", c2: info({ decided: "in" }), c3: "" }, (a) => (a[0] === "inspect" && a.at(-1) === "c3" ? { code: 1, stdout: "", stderr: "No such object" } : undefined));
    await expect(engine().joinMailNetwork(projeto("loja"))).resolves.toBe(1);
    expect(calls.filter((c) => c[1] === "connect" || c[1] === "disconnect")).toEqual([["network", "connect", "paas-mail", "c2"]]);
  });

  it("valores de tipo errado no inspect viram vazio (sem carimbo e sem imagem de banco: liga como no A4)", async () => {
    mundo({ c1: JSON.stringify({ mode: 1, image: null, decided: 3, service: [], networks: "x" }) });
    await expect(engine().joinMailNetwork(projeto("loja"))).resolves.toBe(1);
    expect(calls).toContainEqual(["network", "connect", "paas-mail", "c1"]);
    expect(calls.some((c) => c[1] === "disconnect")).toBe(false);
  });

  it("R1: app SEM carimbo (instalação pré-A4) é ligado à paas-mail, senão perde o SMTP quando o Stalwart sai da paas-net", async () => {
    mundo({ app: info({ image: "minha-app:1", service: "web" }), host: info({ mode: "host" }) });
    await expect(engine().joinMailNetwork(projeto("loja"))).resolves.toBe(1);
    expect(calls).toContainEqual(["network", "connect", "paas-mail", "app"]);
    expect(calls.filter((c) => c[1] === "connect")).toHaveLength(1);
  });

  it("R1: falha ao ligar um container sem carimbo sobe como erro", async () => {
    mundo({ app: info() }, (a) => (a[1] === "connect" ? { code: 1, stdout: "", stderr: "daemon fora" } : undefined));
    await expect(engine().joinMailNetwork(projeto("loja"))).rejects.toThrow(/falha ao ligar app à rede paas-mail: daemon fora/);
  });
});

describe("DeployEngine.joinMailNetwork com a caixa de teste de e-mail", () => {
  it("liga os containers à rede INTERNA do Mailpit, nunca à do servidor de e-mail real", async () => {
    mundo({ c1: info({ decided: "in" }) }, (a) => (a[0] === "network" && a[1] === "inspect" ? { code: 1, stdout: "", stderr: "no" } : undefined));
    await expect(engineComCaixa("paas-mailtest-loja").joinMailNetwork(projeto("loja"))).resolves.toBe(1);
    expect(calls).toContainEqual(["network", "create", "--internal", "--label", "paas.managed=true", "paas-mailtest-loja"]);
    expect(calls).toContainEqual(["network", "connect", "paas-mailtest-loja", "c1"]);
    expect(calls.some((c) => c.includes("paas-mail"))).toBe(false);
  });

  it("caixa desligada (null): segue na paas-mail de sempre", async () => {
    mundo({ c1: info({ decided: "in" }) });
    await engineComCaixa(null).joinMailNetwork(projeto("loja"));
    expect(calls).toContainEqual(["network", "connect", "paas-mail", "c1"]);
  });

  it("REVISÃO: rede do Mailpit que já existe e TEM saída é recriada como interna; interna é reaproveitada", async () => {
    mundo({ c1: info({ decided: "in" }) }, (a) => (a[0] === "network" && a[1] === "inspect" ? { code: 0, stdout: "false\n", stderr: "" } : undefined));
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
      if (a[0] === "network" && a[1] === "inspect") return { code: 0, stdout: "false\n", stderr: "" };
      if (a[0] === "network" && a[1] === "rm") return { code: 1, stdout: "", stderr: "has active endpoints" };
      return undefined;
    });
    await expect(engineComCaixa("paas-mailtest-loja").joinMailNetwork(projeto("loja"))).rejects.toThrow(/não é interna.*has active endpoints/);
    expect(calls.some((c) => c[0] === "network" && c[1] === "connect")).toBe(false);
  });
});

describe("DeployEngine.joinMailNetwork — banco e cache ficam fora da rede de e-mail", () => {
  it("in liga; out desliga da paas-mail e mantém a rede do projeto", async () => {
    mundo({
      app: info({ decided: "in", nets: ["paas-loja_default"] }),
      db: info({ decided: "out", image: "paas-loja-db", nets: ["paas-loja_default", "paas-mail"] }),
      cache: info({ decided: "out", nets: ["paas-loja_default"] }),
    });
    const logs: string[] = [];
    await expect(engine().joinMailNetwork(projeto("loja"), (m) => logs.push(m))).resolves.toBe(1);
    expect(calls).toContainEqual(["network", "connect", "paas-mail", "app"]);
    expect(calls).toContainEqual(["network", "disconnect", "paas-mail", "db"]);
    expect(calls.filter((c) => c[1] === "disconnect")).toHaveLength(1);
    expect(calls.some((c) => c.join(" ").includes("disconnect paas-loja_default"))).toBe(false);
    expect(logs.join("")).toMatch(/saiu de paas-mail/);
  });

  it("M1: a imagem e a label tws.mail do container não contam quando há carimbo (não recalcula)", async () => {
    mundo({
      // build do compose: a imagem é paas-loja-db, não "postgres": só o carimbo sabe
      dbBuild: info({ decided: "out", image: "paas-loja-db", service: "db", nets: ["paas-loja_default", "paas-mail"] }),
      // imagem de banco, mas carimbada in (tws.mail=true no deploy): continua ligada
      forcado: info({ decided: "in", image: "postgres:16" }),
    });
    await expect(engine().joinMailNetwork(projeto("loja"))).resolves.toBe(1);
    expect(calls).toContainEqual(["network", "disconnect", "paas-mail", "dbBuild"]);
    expect(calls).toContainEqual(["network", "connect", "paas-mail", "forcado"]);
  });

  it("M1/R1: sem carimbo, desliga quem tem imagem de banco e liga o resto", async () => {
    mundo({
      velho: info({ image: "docker.io/library/redis:7", service: "cache", nets: ["paas-loja_default", "paas-mail"] }),
      app: info({ image: "minha-app:1", service: "web", nets: ["paas-loja_default", "paas-mail"] }),
    });
    const logs: string[] = [];
    await expect(engine().joinMailNetwork(projeto("loja"), (m) => logs.push(m))).resolves.toBe(1);
    expect(calls).toContainEqual(["network", "disconnect", "paas-mail", "velho"]);
    expect(calls).toContainEqual(["network", "connect", "paas-mail", "app"]);
    expect(calls.some((c) => c[1] === "disconnect" && c.at(-1) === "app")).toBe(false);
    expect(logs.join("")).toMatch(/cache saiu de paas-mail \(deve ficar fora da rede de e-mail\)/);
  });

  it("M4: container só com redes de e-mail (mailtest + paas-mail) não é desligado, e o log avisa", async () => {
    mundo({ db: info({ decided: "out", nets: ["paas-mailtest-loja", "paas-mail"] }), so: info({ decided: "out", nets: ["paas-mail"] }) });
    const logs: string[] = [];
    await engineComCaixa("paas-mailtest-loja").joinMailNetwork(projeto("loja"), (m) => logs.push(m));
    expect(calls.some((c) => c[1] === "disconnect")).toBe(false);
    expect(logs.join("")).toMatch(/db só tem rede de e-mail .*deveria ficar fora dela/);
    expect(logs.join("")).toMatch(/so só tem rede de e-mail/);
  });

  it("M4: recalcula a cada desligamento (nunca deixa o container sem rede que não seja de e-mail)", async () => {
    mundo({ db: info({ decided: "out", nets: ["paas-loja_default", "paas-mailtest-loja", "paas-mail"] }) });
    await engineComCaixa("paas-mailtest-loja").joinMailNetwork(projeto("loja"));
    expect(calls).toContainEqual(["network", "disconnect", "paas-mailtest-loja", "db"]);
    expect(calls).toContainEqual(["network", "disconnect", "paas-mail", "db"]);
    expect(calls.some((c) => c[1] === "connect")).toBe(false);
  });

  it("falha ao desligar sobe como erro; 'not connected' e 'no such container' são ignorados", async () => {
    const containers = { db: info({ decided: "out", nets: ["paas-loja_default", "paas-mail"] }) };
    mundo(containers, (a) => (a[1] === "disconnect" ? { code: 1, stdout: "", stderr: "container db is not connected to network paas-mail" } : undefined));
    await expect(engine().joinMailNetwork(projeto("loja"))).resolves.toBe(0);
    mundo(containers, (a) => (a[1] === "disconnect" ? { code: 1, stdout: "", stderr: "Error: No such container: db" } : undefined));
    await expect(engine().joinMailNetwork(projeto("loja"))).resolves.toBe(0);
    mundo(containers, (a) => (a[1] === "disconnect" ? { code: 1, stdout: "", stderr: "daemon fora" } : undefined));
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

describe("container único (docker run) com e-mail", () => {
  it("leva o carimbo tws.mail.decided=in só quando o e-mail está habilitado", async () => {
    respostas = () => ({ code: 0, stdout: "", stderr: "" });
    const eng = engine() as unknown as { runDockerfileContainer(p: Project, image: string, log: () => void, env: Record<string, string>, tz: null): Promise<void> };
    await eng.runDockerfileContainer(projeto("loja"), "img", () => {}, { SMTP_HOST: "mail.loja.test" }, null);
    const run = calls.find((c) => c[0] === "run")!;
    expect(run.join(" ")).toContain("--label tws.mail.decided=in");
    expect(calls).toContainEqual(["network", "connect", "paas-mail", "paas-loja-app"]);
    calls.length = 0;
    await eng.runDockerfileContainer(projeto("loja"), "img", () => {}, {}, null);
    expect(calls.find((c) => c[0] === "run")!.join(" ")).not.toContain("tws.mail.decided");
  });
});
