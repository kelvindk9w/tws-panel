/**
 * compose-model.ts — LISTA FECHADA (revisão do lote 5): chave que o painel não
 * conhece BLOQUEIA, em todos os níveis (topo, serviço, deploy, ganchos). Cada
 * contorno que passava com 0 bloqueios tem um teste hostil aqui.
 */
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HARD_RULES, checkComposeModel, type ComposeCheckOptions } from "../src/compose-model.js";

let root: string;
let src: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paas-model-fechado-"));
  src = path.join(root, "src");
  await mkdir(path.join(src, "dados", "sub"), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const opts = (extra: Partial<ComposeCheckOptions> = {}): ComposeCheckOptions => ({
  fileName: "compose.yml",
  srcRoot: src,
  projectName: "paas-app",
  mode: "canonical",
  panelNetwork: "paas-net",
  ...extra,
});
const servico = (def: Record<string, unknown>, top: Record<string, unknown> = {}) => ({
  services: { web: { image: "nginx:1.27", ...def } },
  ...top,
});
const regras = (model: unknown, extra: Partial<ComposeCheckOptions> = {}) => checkComposeModel(model, opts(extra)).map((f) => f.rule);

describe("chaves do serviço: o que não está na lista bloqueia", () => {
  it.each([
    ["use_api_socket", { use_api_socket: true }, "privileged-container"],
    ["gpus", { gpus: "all" }, "privileged-container"],
    ["runtime", { runtime: "nvidia" }, "privileged-container"],
    ["cgroup_parent", { cgroup_parent: "/system.slice" }, "privileged-container"],
    ["storage_opt", { storage_opt: { size: "1G" } }, "privileged-container"],
    ["label_file", { label_file: "/etc/shadow" }, "host-mount"],
    ["deploy.resources.reservations.devices", { deploy: { resources: { reservations: { devices: [{ capabilities: ["gpu"] }] } } } }, "privileged-container"],
  ])("%s", (_nome, def, regra) => {
    expect(regras(servico(def))).toContain(regra);
  });

  it("use_api_socket desligado não é pedido nenhum", () => {
    expect(regras(servico({ use_api_socket: false }))).toEqual([]);
  });

  it("campo desconhecido (inclusive de versão futura do Compose) bloqueia", () => {
    expect(regras(servico({ campo_novo_do_compose: 1 }))).toEqual(["unsupported-field"]);
    expect(regras(servico({ gerenciador_novo: { watch: true } }))).toEqual(["unsupported-field"]);
  });

  it("develop (o up ignora; só o `compose watch` o usa) e logging journald/syslog são aceitos", () => {
    expect(regras(servico({ develop: { watch: [{ path: "./src", action: "sync", target: "/app" }] } }))).toEqual([]);
    for (const driver of ["journald", "syslog", "json-file", "local", "none"]) {
      expect(regras(servico({ logging: { driver } })), driver).toEqual([]);
    }
  });

  it("driver de log que manda para outro lugar (gelf, fluentd, splunk…) segue barrado", () => {
    for (const driver of ["gelf", "fluentd", "splunk", "awslogs"]) {
      expect(regras(servico({ logging: { driver } })), driver).toEqual(["unsupported-field"]);
    }
  });

  it("extensão x-* é livre", () => {
    expect(regras(servico({ "x-meu": { a: 1 } }, { "x-global": 1 }))).toEqual([]);
  });

  it("campo desconhecido no topo do compose bloqueia", () => {
    expect(regras({ ...servico({}), models: { m: {} } })).toEqual(["unsupported-field"]);
  });

  it("um serviço comum completo passa", () => {
    expect(
      regras(
        servico({
          command: ["node", "x.js"],
          entrypoint: ["/e"],
          environment: { A: "1" },
          env_file: [],
          ports: [{ target: 80, published: "8080", protocol: "tcp", mode: "ingress" }],
          healthcheck: { test: ["CMD", "true"], interval: "5s" },
          depends_on: { db: { condition: "service_started" } },
          restart: "unless-stopped",
          user: "1000:1000",
          working_dir: "/app",
          read_only: true,
          cap_drop: ["ALL"],
          security_opt: ["no-new-privileges:true"],
          mem_limit: "512m",
          pids_limit: 100,
          ulimits: { nofile: 1024 },
          tmpfs: ["/tmp"],
          init: true,
          stop_grace_period: "10s",
          labels: { "traefik.enable": "true" },
          logging: { driver: "json-file", options: { "max-size": "10m" } },
          deploy: { replicas: 1, resources: { limits: { cpus: "1", memory: "512M" }, reservations: { cpus: "0.5", memory: "256M" } } },
          post_start: [{ command: ["/bin/true"], user: "root" }],
          pre_stop: [{ command: "/bin/true" }],
        }),
      ),
    ).toEqual([]);
  });
});

describe("logging: o log não sai da VPS (syslog-address, drivers de rede) e as opções são de lista fechada", () => {
  const log = (driver: string | undefined, options?: Record<string, unknown>) =>
    regras(servico({ logging: { ...(driver ? { driver } : {}), ...(options ? { options } : {}) } }));

  it.each(["tcp://atacante.exemplo:514", "udp://atacante.exemplo:514", "tcp+tls://atacante.exemplo:6514", "unix:///dev/log", "unixgram:///dev/log"])(
    "syslog com syslog-address %s é barrado (recusa por completo: o padrão já é o /dev/log local)",
    (address) => {
      expect(log("syslog", { "syslog-address": address })).toEqual(["unsupported-field"]);
    },
  );
  it("syslog-tls-* e opções de rede também", () => {
    expect(log("syslog", { "syslog-tls-ca-cert": "/etc/ssl/ca.pem" })).toEqual(["unsupported-field"]);
    expect(log("syslog", { "syslog-tls-skip-verify": "true" })).toEqual(["unsupported-field"]);
  });
  it("syslog e journald sem endereço, com as opções de formato, passam", () => {
    expect(log("syslog", { tag: "{{.Name}}", facility: "daemon", "syslog-format": "rfc5424" })).toEqual([]);
    expect(log("journald", { tag: "app", labels: "a,b" })).toEqual([]);
  });
  it("app comum: json-file com max-size/max-file, local e none passam; sem driver também", () => {
    expect(log("json-file", { "max-size": "10m", "max-file": "3", compress: "true" })).toEqual([]);
    expect(log(undefined, { "max-size": "10m", "max-file": "3" })).toEqual([]);
    expect(log("local", { "max-size": "10m" })).toEqual([]);
    expect(log("none")).toEqual([]);
  });
  it("opção desconhecida em qualquer driver aceito bloqueia (inclusive de outro driver e em none)", () => {
    expect(log("json-file", { "fluentd-address": "atacante:24224" })).toEqual(["unsupported-field"]);
    expect(log("json-file", { "syslog-address": "tcp://a:1" })).toEqual(["unsupported-field"]);
    expect(log("journald", { "max-size": "1m" })).toEqual(["unsupported-field"]);
    expect(log("none", { "max-size": "1m" })).toEqual(["unsupported-field"]);
    expect(log(undefined, { "gelf-address": "udp://a:1" })).toEqual(["unsupported-field"]);
  });
  it.each(["gelf", "fluentd", "awslogs", "splunk", "loki", "gcplogs", "etwlogs", "logentries", "loki-docker-driver:latest", "meu/plugin"])(
    "driver de rede ou plugin %s segue barrado",
    (driver) => {
      expect(log(driver, {})).toEqual(["unsupported-field"]);
    },
  );
});

describe("deploy: lista fechada", () => {
  it("chave desconhecida em deploy, resources, limits ou reservations bloqueia", () => {
    expect(regras(servico({ deploy: { x: 1 } }))).toEqual(["unsupported-field"]);
    expect(regras(servico({ deploy: { resources: { x: 1 } } }))).toEqual(["unsupported-field"]);
    expect(regras(servico({ deploy: { resources: { limits: { devices: [] } } } }))).toEqual(["unsupported-field"]);
    expect(regras(servico({ deploy: { resources: { reservations: { x: 1 } } } }))).toEqual(["unsupported-field"]);
  });
  it("labels reservadas em deploy.labels", () => {
    expect(regras(servico({ deploy: { labels: { "paas.project": "v" } } }))).toContain("reserved-name");
  });
});

describe("ganchos post_start / pre_stop / pre_start: mesma checagem por recursão", () => {
  it.each(["post_start", "pre_stop", "pre_start"])("%s com privileged: true", (gancho) => {
    expect(regras(servico({ [gancho]: [{ command: "/x", privileged: true }] }))).toContain("privileged-container");
  });
  it.each(["post_start", "pre_stop"])("%s com user root + volumes ou campo desconhecido", (gancho) => {
    expect(regras(servico({ [gancho]: [{ command: "/x", user: "root", volumes: ["/:/host"] }] }))).toEqual(["unsupported-field"]);
    expect(regras(servico({ [gancho]: [{ command: "/x", cap_add: ["SYS_ADMIN"] }] }))).toEqual(["unsupported-field"]);
  });
  it("gancho com privileged: false ou só user root é comum", () => {
    expect(regras(servico({ post_start: [{ command: "/x", user: "root", privileged: false }] }))).toEqual([]);
  });
  it("pre_start não existe no Compose: bloqueia mesmo sem privileged", () => {
    expect(regras(servico({ pre_start: [{ command: "/x" }] }))).toEqual(["unsupported-field"]);
  });
});

describe("bind dentro de outro bind gravável (o app troca a pasta por link)", () => {
  const bind = (source: string, target: string, ro = false) => ({ type: "bind", source: path.join(src, source), target, ...(ro ? { read_only: true } : {}) });

  it("./ e ./dados do mesmo serviço: bloqueia", () => {
    const m = servico({ volumes: [bind(".", "/app"), bind("dados", "/data")] });
    expect(regras(m)).toEqual(["host-mount"]);
  });
  it("em serviços diferentes também", () => {
    const m = { services: { web: { image: "a", volumes: [bind(".", "/app")] }, db: { image: "b", volumes: [bind("dados", "/data")] } } };
    expect(regras(m)).toEqual(["host-mount"]);
  });
  it("aninhado: ./dados e ./dados/sub", () => {
    const m = servico({ volumes: [bind("dados", "/data"), bind("dados/sub", "/sub")] });
    expect(regras(m)).toEqual(["host-mount"]);
  });
  it("forma curta (./:/app e ./dados:/data)", () => {
    const m = servico({ volumes: [`${src}:/app`, `${src}/dados:/data`] });
    expect(regras(m)).toEqual(["host-mount"]);
  });
  it("o pai só leitura não deixa o app trocar nada: passa", () => {
    expect(regras(servico({ volumes: [bind(".", "/app", true), bind("dados", "/data")] }))).toEqual([]);
    expect(regras(servico({ volumes: [`${src}:/app:ro`, `${src}/dados:/data`] }))).toEqual([]);
  });
  it("pastas irmãs e o mesmo bind repetido passam", () => {
    expect(regras(servico({ volumes: [bind("dados", "/a"), bind("dados", "/b")] }))).toEqual([]);
  });
  it("um bind só, mesmo de ./dados, passa (o app não escreve no pai)", () => {
    expect(regras(servico({ volumes: [bind("dados", "/data")] }))).toEqual([]);
  });
  it("irmão com o mesmo prefixo de nome não conta como aninhado", async () => {
    await mkdir(path.join(src, "dados2"), { recursive: true });
    expect(regras(servico({ volumes: [bind("dados", "/a"), bind("dados2", "/b")] }))).toEqual([]);
  });
  it("pasta que já é link para fora continua barrada pelo caminho real", async () => {
    await symlink("/etc", path.join(src, "raiz"));
    expect(regras(servico({ volumes: [bind("raiz", "/r")] }))).toContain("host-mount");
  });
});

describe("rede de e-mail: nomes do DNS dela (A4)", () => {
  const mail = { proxyService: "web", slug: "app", mailNetwork: "paas-mail", mailAliases: ["mail.exemplo.com"] };
  const topo = { networks: { "paas-mail": { name: "paas-mail", external: true } } };
  const com = (nome: string, def: Record<string, unknown> = {}) => ({
    services: { [nome]: { image: "a", networks: { default: null, "paas-mail": null }, ...def } },
    ...topo,
  });
  const m = (nome: string, def: Record<string, unknown> = {}) =>
    regras(com(nome, def), { ...mail, mailServices: [nome] });

  it.each(["paas-stalwart", "paas-webmail", "paas-caddy", "tws-panel", "stalwart", "caddy", "tws-qualquer", "paas-outra", "mail.exemplo.com", "mail.qualquer.org"])(
    "serviço chamado %s na rede de e-mail",
    (nome) => {
      expect(m(nome)).toContain("network-hijack");
    },
  );

  it("container_name e alias reservados num serviço da rede de e-mail", () => {
    expect(m("web", { container_name: "paas-stalwart" })).toContain("network-hijack");
    expect(m("web", { container_name: "mail.exemplo.com" })).toContain("network-hijack");
    expect(m("web", { networks: { "paas-mail": { aliases: ["mail.exemplo.com"] } } })).toContain("network-hijack");
    expect(m("web", { networks: { "paas-mail": null, outra: { aliases: ["paas-stalwart"] } } })).toContain("network-hijack");
  });

  it("slug de outro projeto como nome de serviço", () => {
    const r = regras(com("vitima"), { ...mail, mailServices: ["vitima"], otherSlugs: ["vitima"] });
    expect(r).toContain("network-hijack");
  });

  it("nomes comuns passam (web, worker, db, redis)", () => {
    for (const nome of ["web", "worker", "db", "redis"]) expect(m(nome), nome).toEqual([]);
  });

  it("serviço reservado FORA da rede de e-mail continua só reserved-name (a regra nova é da rede)", () => {
    const r = regras(servico({ container_name: "paas-stalwart" }), { ...mail, mailServices: [] });
    expect(r).toEqual(["reserved-name"]);
  });
});

describe("panel-resource: volume, rede e socket do painel (regra dura)", () => {
  it("é regra dura", () => {
    expect(HARD_RULES.has("panel-resource")).toBe(true);
  });

  it("volume paas_data, paas_* ou de outro projeto (externo ou por name:)", () => {
    for (const name of ["paas_data", "paas_caddy_data", "paas_stalwart_data", "paas-vitima_dados", "tws_x"]) {
      for (const external of [true, false]) {
        const r = regras(servico({}, { volumes: { v: { name, ...(external ? { external: true } : {}) } } }));
        expect(r, `${name} external=${external}`).toContain("panel-resource");
      }
    }
  });
  it("volume do próprio projeto e volume comum não são do painel", () => {
    expect(regras(servico({}, { volumes: { dados: { name: "paas-app_dados" } } }))).toEqual([]);
    expect(regras(servico({}, { volumes: { v: { name: "outra-coisa" } } }))).toEqual(["shared-resource"]);
  });
  it("rede paas_* / paas-* de outro projeto", () => {
    expect(regras(servico({}, { networks: { n: { name: "paas-vitima_default", external: true } } }))).toContain("panel-resource");
    expect(regras(servico({}, { networks: { n: { name: "paas_qualquer", external: true } } }))).toContain("panel-resource");
  });
  it("redes paas-panel e paas-mail-admin seguem como regra dura (network-hijack)", () => {
    for (const n of ["paas-panel", "paas-mail-admin"]) {
      const r = regras(servico({ networks: [n] }, { networks: { [n]: { name: n, external: true } } }));
      expect(r.every((x) => HARD_RULES.has(x)), n).toBe(true);
      expect(r.length).toBeGreaterThan(0);
    }
  });
  it.each([
    "/var/run/docker.sock",
    "/run/docker.sock",
    "//var//run//docker.sock",
    "/var/run/../run/docker.sock",
    "/proc/self/root/var/run/docker.sock",
    "/var/run/docker.sock/",
    "/VAR/RUN/DOCKER.SOCK",
  ])("docker.sock em qualquer grafia: %s", (source) => {
    const longa = regras(servico({ volumes: [{ type: "bind", source, target: "/s" }] }));
    const curta = regras(servico({ volumes: [`${source}:/s`] }));
    expect(longa).toContain("panel-resource");
    expect(curta).toContain("panel-resource");
  });
  it("link dentro do src que aponta para o docker.sock", async () => {
    await symlink("/var/run/docker.sock", path.join(src, "sock"));
    expect(regras(servico({ volumes: [{ type: "bind", source: path.join(src, "sock"), target: "/s" }] }))).toContain("panel-resource");
  });
  it("DOCKER_HOST apontando para o socket não é montagem: não entra aqui", () => {
    expect(regras(servico({ environment: { DOCKER_HOST: "unix:///var/run/docker.sock" } }))).toEqual([]);
  });
});

describe("panel-resource: bind que CONTÉM o socket, a pasta do Docker ou o /data do painel", () => {
  it.each([
    "/",
    "/run",
    "/var",
    "/var/run",
    "//var//run/",
    "/var/lib",
    "/var/lib/docker",
    "/var/lib/docker/volumes",
    "/var/lib/docker/volumes/paas_data/_data",
    "/data",
    "/data/session-secret",
    "/proc/self/root/var/run",
    "/var/run/../run",
    "/var/lib/../lib/docker",
  ])("bind de %s (forma curta e longa)", (source) => {
    expect(regras(servico({ volumes: [{ type: "bind", source, target: "/x" }] })), source).toContain("panel-resource");
    expect(regras(servico({ volumes: [`${source}:/x`] })), source).toContain("panel-resource");
  });
  it("sem override: o motivo é uma regra dura, e não aparece também como host-mount solto", () => {
    expect(regras(servico({ volumes: [{ type: "bind", source: "/var", target: "/x" }] }))).toEqual(["panel-resource"]);
  });
  it("link dentro do src para /run ou /var/lib/docker", async () => {
    await symlink("/run", path.join(src, "atalho-run"));
    await symlink("/var/lib/docker", path.join(src, "atalho-docker"));
    expect(regras(servico({ volumes: [`${src}/atalho-run:/x`] }))).toContain("panel-resource");
    expect(regras(servico({ volumes: [`${src}/atalho-docker:/x`] }))).toContain("panel-resource");
  });
  it("outras pastas do servidor seguem como host-mount (overridável): /etc, /home, /opt", () => {
    for (const source of ["/etc", "/home", "/opt/outra", "/var/log", "/tmp"]) {
      expect(regras(servico({ volumes: [{ type: "bind", source, target: "/x" }] })), source).toEqual(["host-mount"]);
    }
  });
});

describe("panel-resource: /proc, /sys, sockets de /run e as pastas do próprio painel (da configuração)", () => {
  const protegidos = () => ({ protectedPaths: ["/opt/tws-projects", "/opt/tws-panel"] });
  const bindEm = (source: string, extra: Partial<ComposeCheckOptions> = {}) =>
    regras(servico({ volumes: [{ type: "bind", source, target: "/x" }] }), { ...protegidos(), ...extra });

  it.each([
    "/proc",
    "/proc/1/root",
    "/proc/self/root/etc",
    "/proc/sys/kernel",
    "/sys",
    "/sys/kernel/uevent_helper",
    "/run/containerd/containerd.sock",
    "/var/run/containerd/containerd.sock",
    "/run/crio/crio.sock",
    "/var/run/qualquer.sock",
    "/run/containerd",
    "/var/run/docker",
    // toda a árvore /run e /var/run, não só nomes terminados em .sock
    "/run/dbus/system_bus_socket",
    "/var/run/dbus/system_bus_socket",
    "/run/dbus",
    "/run/systemd/private",
    "/run/systemd",
    "/run/user/0",
    "/run/user/1000/bus",
    "/run/qualquer-coisa",
    "/var/run/qualquer/coisa/aninhada",
    "//run//dbus/../dbus/system_bus_socket",
  ])("bind de %s é regra dura", (source) => {
    expect(bindEm(source), source).toEqual(["panel-resource"]);
    expect(regras(servico({ volumes: [`${source}:/x`] })), source).toContain("panel-resource");
  });

  it.each([
    "/opt/tws-projects",
    "/opt/tws-projects/outro-projeto/src",
    "/opt/tws-projects/outro-projeto",
    "/opt/tws-projects/outro-projeto/repo.git",
    "/opt/tws-panel",
    "/opt/tws-panel/.env",
    "/opt",
    "/opt//tws-projects/../tws-projects/x",
  ])("pasta de projetos e instalação do painel (da configuração): %s", (source) => {
    expect(bindEm(source), source).toEqual(["panel-resource"]);
  });

  it("as pastas protegidas vêm da configuração, não do código: sem protectedPaths, /opt/tws-panel é um host-mount comum", () => {
    expect(regras(servico({ volumes: [{ type: "bind", source: "/opt/tws-panel", target: "/x" }] }))).toEqual(["host-mount"]);
    expect(bindEm("/srv/painel-em-outro-lugar", { protectedPaths: ["/srv/painel-em-outro-lugar"] })).toEqual(["panel-resource"]);
  });

  it("o código do PRÓPRIO projeto (dentro da pasta de projetos) continua montável; a pasta de cima e a dos outros, não", async () => {
    const projetos = path.dirname(src);
    const o = { protectedPaths: [projetos] };
    expect(bindEm(path.join(src, "dados"), o)).toEqual([]);
    expect(bindEm(src, o)).toEqual([]);
    expect(bindEm(projetos, o)).toEqual(["panel-resource"]);
    expect(bindEm(path.join(projetos, "outro", "src"), o)).toEqual(["panel-resource"]);
  });

  it("o restante do servidor segue como host-mount (o operador pode liberar): /var/log/meuapp, /srv/x, /etc, /home", () => {
    for (const source of ["/var/log/meuapp", "/srv/x", "/etc", "/home/app", "/mnt/dados"]) {
      expect(bindEm(source), source).toEqual(["host-mount"]);
    }
  });
});

describe("o que o painel lê dentro de um bind gravável (o app troca a pasta por um link entre a conferência e o uso)", () => {
  const bind = (source: string, ro = false) => ({ type: "bind", source: path.join(src, source), target: "/app", ...(ro ? { read_only: true } : {}) });
  const abs = (...p: string[]) => path.join(src, ...p);

  it("contexto de build ./api com ./:/app: bloqueia", async () => {
    await mkdir(abs("api"), { recursive: true });
    const m = { services: { web: { build: { context: abs("api") }, volumes: [bind(".")] } } };
    expect(regras(m)).toEqual(["host-mount"]);
  });
  it("o bind em OUTRO serviço vale do mesmo jeito", async () => {
    await mkdir(abs("api"), { recursive: true });
    const m = { services: { web: { build: { context: abs("api") } }, outro: { image: "a", volumes: [bind(".")] } } };
    expect(regras(m)).toEqual(["host-mount"]);
  });
  it("Dockerfile dentro do bind (contexto fora dele): bloqueia", async () => {
    await mkdir(abs("dados"), { recursive: true });
    const m = { services: { web: { build: { context: src, dockerfile: "dados/Dockerfile" }, volumes: [bind("dados")] } } };
    expect(regras(m)).toEqual(["host-mount"]);
  });
  it("contexto adicional local dentro do bind: bloqueia", async () => {
    await mkdir(abs("dados"), { recursive: true });
    const m = { services: { web: { build: { context: src, additional_contexts: { x: abs("dados", "extra") } }, volumes: [bind("dados")] } } };
    expect(regras(m)).toEqual(["host-mount"]);
  });
  it("env_file dentro do bind (string e forma de objeto): bloqueia", async () => {
    await mkdir(abs("dados"), { recursive: true });
    for (const env_file of [[abs("dados", ".env")], [{ path: abs("dados", ".env"), required: true }]]) {
      const m = { services: { web: { image: "a", env_file, volumes: [bind("dados")] } } };
      expect(regras(m)).toEqual(["host-mount"]);
    }
  });
  it("secrets e configs de arquivo dentro do bind: bloqueia", async () => {
    await mkdir(abs("dados"), { recursive: true });
    for (const kind of ["secrets", "configs"]) {
      const m = { services: { web: { image: "a", volumes: [bind("dados")] } }, [kind]: { s: { file: abs("dados", "token") } } };
      expect(regras(m), kind).toEqual(["host-mount"]);
    }
  });
  it("bind só leitura, contexto igual ao próprio bind e arquivos fora de qualquer bind passam", async () => {
    await mkdir(abs("api"), { recursive: true });
    await mkdir(abs("dados"), { recursive: true });
    expect(regras({ services: { web: { build: { context: abs("api") }, volumes: [bind(".", true)] } } })).toEqual([]);
    expect(regras({ services: { web: { build: { context: abs("api") }, volumes: [bind("api")] } } })).toEqual([]);
    expect(regras({ services: { web: { build: { context: abs("api") }, env_file: [abs("api", ".env")], volumes: [bind("dados")] } } })).toEqual([]);
  });
});

describe("build: lista fechada e cache só em registro", () => {
  const build = (b: Record<string, unknown>) => servico({ image: undefined, build: { context: ".", ...b } });

  it.each([
    ["cache_to local no /data do painel", { cache_to: ["type=local,dest=/data"] }],
    ["cache_to local relativo", { cache_to: ["type=local,dest=./cache"] }],
    ["cache_from local no /data do painel", { cache_from: ["type=local,src=/data"] }],
    ["cache_from com src= solto", { cache_from: ["src=/data"] }],
    ["cache_to de tipo desconhecido (gha, s3, azblob)", { cache_to: ["type=s3,bucket=x"] }],
    ["cache_to no formato de mapa (local)", { cache_to: { type: "local", dest: "/data" } }],
  ])("%s", (_nome, b) => {
    expect(regras(build(b))).toContain("build-outside-src");
  });

  it.each([
    ["Type= e Dest= maiúsculos (o buildx baixa as chaves)", ["Type=local,Dest=/data"]],
    ["TYPE=LOCAL", ["TYPE=local,DEST=/data"]],
    ["aspas de CSV em cada campo", ['"type=local","dest=/data"']],
    ["aspas no valor", ['type="local",dest="/data"']],
    ["espaços em volta", [" type = local , dest = /data "]],
    ["maiúsculas misturadas", ["tYpE=local,dEsT=/data"]],
    ["src com maiúscula", ["Type=local,Src=/data"]],
    ["registry com dest escondido", ["type=registry,ref=x/y,Dest=/data"]],
    ["sem type e com dest", ["dest=/data"]],
    ["type gha, s3, azblob e local no mapa com maiúscula", ["type=gha", "type=s3,bucket=x", "type=azblob,account_url=x"]],
    ["objeto com chaves em maiúsculas", [{ Type: "local", Dest: "/data" }]],
    ["objeto com type desconhecido", [{ type: "s3" }]],
  ])("cache_to/cache_from: %s", (_nome, lista) => {
    expect(regras(build({ cache_to: lista })), "cache_to").toContain("build-outside-src");
    expect(regras(build({ cache_from: lista })), "cache_from").toContain("build-outside-src");
  });

  it.each([
    ["type=registry primeiro e type=local depois (o buildx usa o último)", ["type=registry,ref=x,type=local,dest=/data"]],
    ["type=local primeiro e type=registry depois", ["type=local,dest=/data,type=registry,ref=x"]],
    ["dest duplicado", ["type=registry,ref=x,dest=/a,dest=/data"]],
    ["type duplicado com maiúsculas diferentes", ["Type=registry,ref=x,type=local"]],
    ["type duplicado igual (também recusado)", ["type=registry,type=registry,ref=x"]],
    ["ref duplicado", ["type=registry,ref=a,ref=b"]],
    ["duplicado com aspas de CSV", ['"type=registry","ref=x","TYPE=local"']],
    ["objeto com Type e type", [{ Type: "registry", type: "local" }]],
  ])("chave duplicada é recusada: %s", (_nome, lista) => {
    expect(regras(build({ cache_to: lista })), "cache_to").toContain("build-outside-src");
    expect(regras(build({ cache_from: lista })), "cache_from").toContain("build-outside-src");
  });

  it("cache em registro, inline e referência de imagem continuam passando (CSV com aspas e espaços)", () => {
    for (const ok of ["minha-loja:cache", "type=registry,ref=ghcr.io/x/y:cache", '"type=registry","ref=ghcr.io/x/y:cache"', " type = inline ", "type=inline"]) {
      expect(regras(build({ cache_to: [ok] })), ok).toEqual([]);
    }
  });

  it("chave desconhecida em build bloqueia", () => {
    expect(regras(build({ novidade: "x" }))).toEqual(["unsupported-field"]);
  });

  it("build comum, cache em registro e imagem como cache_from passam", () => {
    expect(
      regras(
        build({
          dockerfile: "Dockerfile",
          args: { A: "1" },
          target: "prod",
          labels: { a: "b" },
          no_cache: true,
          pull: true,
          platforms: ["linux/amd64"],
          cache_from: ["minha-loja:cache", "type=registry,ref=ghcr.io/x/y:cache"],
          cache_to: ["type=inline", "type=registry,ref=ghcr.io/x/y:cache,mode=max"],
          tags: ["minha-loja:1"],
          secrets: ["token"],
          shm_size: "1gb",
          ulimits: { nofile: 1024 },
          extra_hosts: ["a:1.1.1.1"],
          network: "default",
          provenance: false,
          sbom: false,
          isolation: "default",
        }),
      ),
    ).toEqual([]);
  });

  it("build em forma curta (string) continua valendo", () => {
    expect(regras(servico({ build: "." }))).toEqual([]);
  });
});
