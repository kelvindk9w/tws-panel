/**
 * compose-model.ts — a lista do que um compose de projeto PODE pedir (A1).
 * Modelo canônico (saída do `docker compose config`) escrito à mão, um caso
 * por regra; os compose hostis completos estão em guardrails-hostil.test.ts e
 * compose-hostil-docker.test.ts.
 */
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkComposeModel, resolveRealPath, type ComposeCheckOptions } from "../src/compose-model.js";

let root: string;
let src: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paas-model-"));
  src = path.join(root, "src");
  await mkdir(path.join(src, "dados"), { recursive: true });
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

function servico(def: Record<string, unknown>, top: Record<string, unknown> = {}) {
  return { services: { web: { image: "nginx:1.27", ...def } }, ...top };
}

const regras = (model: unknown, o = opts()) => checkComposeModel(model, o).map((f) => f.rule);

describe("privilégios", () => {
  it.each([
    ["privileged: true", { privileged: true }],
    ["privileged: \"yes\"", { privileged: "yes" }],
    ["privileged: 1", { privileged: 1 }],
  ])("barra %s", (_n, def) => {
    expect(regras(servico(def))).toEqual(["privileged-container"]);
  });

  it("não barra privileged falso em qualquer escrita", () => {
    for (const v of [false, "false", "no", "off", "0", 0, "", null]) expect(regras(servico({ privileged: v }))).toEqual([]);
  });

  it("barra cap_add, devices (curto e longo), device_cgroup_rules, sysctls (mapa e lista) e provider", () => {
    expect(regras(servico({ cap_add: ["NET_ADMIN"] }))).toEqual(["privileged-container"]);
    expect(regras(servico({ devices: ["/dev/sda:/dev/sda"] }))).toEqual(["privileged-container"]);
    expect(regras(servico({ devices: [{ source: "/dev/kvm", target: "/dev/kvm" }] }))).toEqual(["privileged-container"]);
    expect(regras(servico({ device_cgroup_rules: ["c 1:3 mr"] }))).toEqual(["privileged-container"]);
    expect(regras(servico({ sysctls: { "net.core.somaxconn": 1024 } }))).toEqual(["privileged-container"]);
    expect(regras(servico({ sysctls: ["net.ipv4.ip_forward=1"] }))).toEqual(["privileged-container"]);
    expect(regras(servico({ provider: { type: "./evil.sh" } }))).toEqual(["privileged-container"]);
  });

  it("security_opt: só no-new-privileges é aceito", () => {
    expect(regras(servico({ security_opt: ["no-new-privileges:true"] }))).toEqual([]);
    expect(regras(servico({ security_opt: ["no-new-privileges"] }))).toEqual([]);
    expect(regras(servico({ security_opt: ["seccomp=unconfined", "no-new-privileges:true"] }))).toEqual(["privileged-container"]);
    expect(regras(servico({ security_opt: "apparmor=unconfined" }))).toEqual(["privileged-container"]);
  });
});

describe("namespaces", () => {
  it.each([
    ["pid", "host"],
    ["pid", "container:tws-panel"],
    ["ipc", "host"],
    ["ipc", "container:x"],
    ["network_mode", "host"],
    ["network_mode", "container:paas-stalwart"],
    ["userns_mode", "host"],
    ["cgroup", "host"],
    ["uts", "host"],
    ["cgroup", "service:web"],
  ])("barra %s: %s", (campo, valor) => {
    expect(regras(servico({ [campo]: valor }))).toEqual(["host-namespace"]);
  });

  it("aceita o isolamento padrão e o compartilhamento com outro serviço do mesmo compose", () => {
    const model = {
      services: {
        web: { image: "a", network_mode: "service:db", pid: "service:db", ipc: "shareable" },
        db: { image: "b", network_mode: "bridge", cgroup: "private" },
      },
    };
    expect(regras(model)).toEqual([]);
  });

  it("service:<nome> de serviço que não existe no compose é barrado", () => {
    expect(regras(servico({ network_mode: "service:fantasma" }))).toEqual(["host-namespace"]);
  });

  it("volumes_from de container e external_links são barrados; volumes_from de serviço não", () => {
    expect(regras(servico({ volumes_from: ["container:tws-panel"] }))).toEqual(["host-namespace"]);
    expect(regras(servico({ volumes_from: ["db"] }))).toEqual([]);
    expect(regras(servico({ external_links: ["paas-stalwart:mail"] }))).toEqual(["host-namespace"]);
  });
});

describe("montagens", () => {
  it("bind dentro da pasta do projeto passa (curto, longo, relativo e o próprio src)", () => {
    const model = servico({
      volumes: [
        "./dados:/d",
        { type: "bind", source: path.join(src, "dados"), target: "/e" },
        { type: "bind", source: src, target: "/app" },
        "./ainda-nao-existe/sub:/f",
      ],
    });
    expect(regras(model)).toEqual([]);
  });

  it("bind fora do projeto é barrado: /, ~, pasta irmã e prefixo parecido", () => {
    for (const source of ["/", "/etc", "~/chaves", path.join(root, "outro"), `${src}-irmao`, "../.."]) {
      expect(regras(servico({ volumes: [{ type: "bind", source, target: "/x" }] })), source).toEqual(["host-mount"]);
    }
  });

  it("bind por um link simbólico que sai do projeto é barrado (caminho real conferido)", async () => {
    await symlink("/etc", path.join(src, "atalho"));
    expect(regras(servico({ volumes: ["./atalho:/x"] }))).toEqual(["host-mount"]);
    expect(regras(servico({ volumes: ["./atalho/passwd:/x"] }))).toEqual(["host-mount"]);
  });

  it("docker.sock em qualquer caminho é privileged-container, uma vez só", () => {
    expect(regras(servico({ volumes: ["/var/run/docker.sock:/s", "/run/docker.sock:/t"] }))).toEqual([
      "privileged-container",
      "privileged-container",
    ]);
  });

  it("tipos de montagem fora da lista (npipe, cluster, image) são barrados; tmpfs e volume passam", () => {
    expect(regras(servico({ volumes: [{ type: "npipe", source: "x", target: "/y" }] }))).toEqual(["host-mount"]);
    expect(regras(servico({ volumes: [{ type: "tmpfs", target: "/tmp" }, "/so-destino"] }))).toEqual([]);
  });

  it("forma longa sem type: o caminho decide", () => {
    expect(regras(servico({ volumes: [{ source: "/etc", target: "/x" }] }))).toEqual(["host-mount"]);
    expect(regras(servico({ volumes: [{ source: "dados", target: "/x" }] }))).toEqual([]);
    expect(regras(servico({ volumes: [{ source: "./dados", target: "/x" }] }))).toEqual([]);
  });

  it("entradas que não são volume (null, número) são ignoradas", () => {
    expect(regras(servico({ volumes: [null, 3] }))).toEqual([]);
  });
});

describe("volumes e redes do topo", () => {
  it("volume do projeto (nome gerado pelo compose) passa; externo, de nome estranho e com driver_opts não", () => {
    const ok = servico({}, { volumes: { dados: { name: "paas-app_dados" } } });
    expect(regras(ok)).toEqual([]);
    expect(regras(servico({}, { volumes: { v: { name: "paas_data", external: true } } }))).toEqual(["shared-resource"]);
    expect(regras(servico({}, { volumes: { v: { name: "paas_data" } } }))).toEqual(["shared-resource"]);
    expect(
      regras(servico({}, { volumes: { v: { name: "paas-app_v", driver_opts: { type: "none", o: "bind", device: "/" } } } })),
    ).toEqual(["shared-resource"]);
    expect(regras(servico({}, { volumes: { v: { name: "paas-app_v", driver: "rexray" } } }))).toEqual(["shared-resource"]);
    expect(regras(servico({}, { volumes: { v: { name: "paas-app_v", driver: "local" } } }))).toEqual([]);
  });

  it("volume externo com o nome do próprio projeto é aceito (ex.: restaurado de backup)", () => {
    expect(regras(servico({}, { volumes: { v: { name: "paas-app_v", external: true } } }))).toEqual([]);
  });

  it("rede própria passa; externa, de nome estranho e com driver_opts/driver não", () => {
    expect(regras(servico({}, { networks: { default: { name: "paas-app_default" } } }))).toEqual([]);
    expect(regras(servico({}, { networks: { x: { name: "paas-vitima_default", external: true } } }))).toEqual(["shared-resource"]);
    expect(regras(servico({}, { networks: { x: { name: "bridge" } } }))).toEqual(["shared-resource"]);
    expect(regras(servico({}, { networks: { x: { name: "paas-app_x", driver: "host" } } }))).toEqual(["shared-resource"]);
    expect(regras(servico({}, { networks: { x: { name: "paas-app_x", driver_opts: { "com.docker.network.bridge.name": "docker0" } } } }))).toEqual([
      "shared-resource",
    ]);
    expect(regras(servico({}, { networks: { x: { name: "paas-app_x", driver: "bridge" } } }))).toEqual([]);
  });

  it("a paas-net externa do override do painel é aceita", () => {
    expect(regras(servico({}, { networks: { "paas-net": { name: "paas-net", external: true } } }))).toEqual([]);
    expect(regras(servico({}, { networks: { "paas-net": { external: true } } }))).toEqual([]);
  });

  it("segredos e configs: arquivo de fora do projeto ou externo é barrado", () => {
    expect(regras(servico({}, { secrets: { s: { file: "/data/session-secret" } } }))).toEqual(["build-outside-src"]);
    expect(regras(servico({}, { configs: { c: { file: path.join(src, "dados", "c") } } }))).toEqual([]);
    expect(regras(servico({}, { configs: { c: { external: true } } }))).toEqual(["build-outside-src"]);
    expect(regras(servico({}, { secrets: { s: { environment: "X" } } }))).toEqual([]);
  });
});

describe("build e env_file", () => {
  it("build com contexto dentro do projeto passa (texto, mapa, dockerfile relativo)", () => {
    expect(regras(servico({ build: "./api" }))).toEqual([]);
    expect(regras(servico({ build: { context: src, dockerfile: "docker/Dockerfile" } }))).toEqual([]);
    expect(regras(servico({ build: {} }))).toEqual([]);
  });

  it("contexto fora do projeto, remoto ou com Dockerfile de fora é barrado", () => {
    for (const build of [
      { context: "/" },
      { context: "https://github.com/x/y.git" },
      { context: "git@github.com:x/y.git" },
      { context: ".", dockerfile: "../../etc/passwd" },
      { context: ".", dockerfile: "/etc/passwd" },
    ]) {
      expect(regras(servico({ build })), JSON.stringify(build)).toEqual(["build-outside-src"]);
    }
  });

  it("additional_contexts: caminho de fora é barrado (mapa e lista); imagem e serviço não", () => {
    expect(regras(servico({ build: { context: ".", additional_contexts: { x: "/etc" } } }))).toEqual(["build-outside-src"]);
    expect(regras(servico({ build: { context: ".", additional_contexts: ["x=/etc"] } }))).toEqual(["build-outside-src"]);
    expect(
      regras(servico({ build: { context: ".", additional_contexts: { a: "docker-image://alpine", b: "service:db", c: "oci-layout://x", d: "./pasta" } } })),
    ).toEqual([]);
  });

  it("build privileged, com entitlements, ssh ou rede do host é barrado", () => {
    for (const extra of [{ privileged: true }, { entitlements: ["network.host"] }, { ssh: { default: null } }, { network: "host" }]) {
      expect(regras(servico({ build: { context: ".", ...extra } })), JSON.stringify(extra)).toEqual(["build-outside-src"]);
    }
    expect(regras(servico({ build: { context: ".", network: "none" } }))).toEqual([]);
  });

  it("env_file de fora do projeto é barrado (texto e objeto); de dentro passa", () => {
    expect(regras(servico({ env_file: "/data/vault.key" }))).toEqual(["build-outside-src"]);
    expect(regras(servico({ env_file: [{ path: "../../x" }, ".env"] }))).toEqual(["build-outside-src"]);
    expect(regras(servico({ env_file: [{ path: "./dados/.env", required: false }] }))).toEqual([]);
    expect(regras(servico({ env_file: [""] }))).toEqual([]);
  });
});

describe("YAML cru: o que tem ${…} só se sabe no deploy", () => {
  const cru = (def: Record<string, unknown>, top: Record<string, unknown> = {}) =>
    regras(servico(def, top), opts({ mode: "raw" }));

  it("pula valores interpolados, mas barra o que já está escrito", () => {
    expect(
      cru(
        {
          privileged: "${PRIV:-true}",
          cap_add: ["${CAP}"],
          devices: ["${DEV}"],
          security_opt: ["${SEC}"],
          pid: "${PID}",
          volumes: ["${HOST}:/x", { source: "${S}", target: "/y" }],
          build: { context: "${CTX}", additional_contexts: { a: "${A}" }, network: "${N}", dockerfile: "${D}" },
          env_file: "${ENVF}",
        },
        { volumes: { v: { name: "${VOL}" } }, networks: { n: { name: "${NET}" } } },
      ),
    ).toEqual([]);
    expect(cru({ privileged: "true" })).toEqual(["privileged-container"]);
  });

  it("rede e volume no cru usam o nome que o compose daria", () => {
    expect(cru({}, { volumes: { dados: {} } })).toEqual([]);
    expect(cru({}, { networks: { default: {}, back: {} } })).toEqual([]);
    expect(cru({}, { networks: { x: { external: true } } })).toEqual(["shared-resource"]);
  });

  it("sem saber o projeto (pré-checagem sem contexto), só o externo é barrado", () => {
    expect(regras(servico({}, { volumes: { dados: {} } }), opts({ projectName: undefined }))).toEqual([]);
    expect(regras(servico({}, { volumes: { v: { external: true } } }), opts({ projectName: undefined }))).toEqual(["shared-resource"]);
  });
});

describe("entrada fora do esperado", () => {
  it("modelo vazio, sem serviços ou com serviço que não é mapa não quebra nem barra", () => {
    expect(regras(null)).toEqual([]);
    expect(regras({})).toEqual([]);
    expect(regras({ services: { a: null, b: "x" } })).toEqual([]);
  });

  it("evidência traz o arquivo e o serviço", () => {
    const [f] = checkComposeModel(servico({ privileged: true }), opts());
    expect(f).toMatchObject({ level: "block", service: "web" });
    expect(f!.evidence).toContain("compose.yml");
    expect(f!.evidence).toContain('serviço "web"');
  });
});

describe("resolveRealPath", () => {
  it("resolve links e completa o caminho que ainda não existe", async () => {
    await symlink(src, path.join(root, "link"));
    expect(resolveRealPath(path.join(root, "link", "novo", "fundo"))).toBe(path.join(src, "novo", "fundo"));
  });

  it("devolve o caminho absoluto quando nem a raiz resolve", () => {
    expect(resolveRealPath("/")).toBe("/");
  });
});
