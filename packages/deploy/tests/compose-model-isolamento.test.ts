/**
 * compose-model.ts — isolamento entre projetos e o painel (A3, A4, M9):
 * posse de recursos por nome EXATO e as regras duras (sem override do
 * operador): reserved-name, network-hijack e panel-image. Cada regra de
 * HARD_RULES precisa de um compose hostil que a dispare.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HARD_RULES, checkComposeModel, imageRepository, type ComposeCheckOptions } from "../src/compose-model.js";

let root: string;
let src: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paas-model-iso-"));
  src = path.join(root, "src");
  await mkdir(src, { recursive: true });
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

const regras = (model: unknown, o: ComposeCheckOptions | (() => ComposeCheckOptions) = opts) =>
  checkComposeModel(model, typeof o === "function" ? o() : o).map((f) => f.rule);

describe("posse por nome EXATO (app, app-outro e app_x não tocam recursos um do outro)", () => {
  const dono = (projectName: string) => () => opts({ projectName });

  it("volume e rede de 'paas-app-outro' ou 'paas-app_x' não são do projeto 'paas-app'", () => {
    for (const name of ["paas-app-outro_dados", "paas-app_x_dados", "paas-app-dados", "paas-app_outra"]) {
      expect(regras(servico({}, { volumes: { dados: { name } } }), dono("paas-app")), name).toEqual(["shared-resource"]);
    }
    expect(regras(servico({}, { networks: { rede: { name: "paas-app-outro_rede" } } }), dono("paas-app"))).toEqual(["shared-resource"]);
    expect(regras(servico({}, { networks: { rede: { name: "paas-app_x_rede" } } }), dono("paas-app"))).toEqual(["shared-resource"]);
  });

  it("o nome que é de 'paas-app-outro' passa para ele, e só para ele", () => {
    const model = servico({}, { volumes: { dados: { name: "paas-app-outro_dados" } } });
    expect(regras(model, dono("paas-app-outro"))).toEqual([]);
    expect(regras(model, dono("paas-app"))).toEqual(["shared-resource"]);
    expect(regras(model, dono("paas-app_x"))).toEqual(["shared-resource"]);
  });

  it("o nome exato <projeto>_<chave> passa", () => {
    expect(regras(servico({}, { volumes: { dados: { name: "paas-app_dados" } } }), dono("paas-app"))).toEqual([]);
  });
});

describe("regra dura reserved-name", () => {
  it("labels paas.* e com.docker.compose.* (mapa, lista, volume e rede do topo)", () => {
    expect(regras(servico({ labels: { "paas.project": "vitima" } }))).toEqual(["reserved-name"]);
    expect(regras(servico({ labels: ["com.docker.compose.project=paas-vitima"] }))).toEqual(["reserved-name"]);
    expect(regras(servico({ labels: { "traefik.enable": "true" } }))).toEqual([]);
    expect(regras(servico({}, { volumes: { v: { name: "paas-app_v", labels: { "paas.managed": "true" } } } }))).toEqual(["reserved-name"]);
    expect(regras(servico({}, { networks: { n: { name: "paas-app_n", labels: ["paas.managed=true"] } } }))).toEqual(["reserved-name"]);
  });

  it("container_name de painel, de outro projeto ou fora do prefixo do projeto", () => {
    const o = opts({ otherSlugs: ["vitima"], slug: "app" });
    for (const n of ["tws-panel", "paas-stalwart", "paas-caddy", "paas-webmail", "vitima", "paas-vitima-web-1", "tws-qualquer"]) {
      expect(regras(servico({ container_name: n }), o), n).toEqual(["reserved-name"]);
    }
    expect(regras(servico({ container_name: "paas-app-web" }), o)).toEqual([]);
  });

  it("hostname e alias reservados na rede do próprio projeto", () => {
    const o = opts({ proxyService: "web", slug: "app", otherSlugs: ["vitima"] });
    expect(regras(servico({ hostname: "paas-stalwart" }), o)).toEqual(["reserved-name"]);
    const rede = { networks: { fundo: { name: "paas-app_fundo" } } };
    expect(regras(servico({ networks: { fundo: { aliases: ["db"] } } }, rede), o)).toEqual([]);
    expect(regras(servico({ networks: { fundo: { aliases: ["tws-panel"] } } }, rede), o)).toEqual(["reserved-name"]);
    expect(regras(servico({ networks: { fundo: { aliases: ["vitima"] } } }, rede), o)).toEqual(["reserved-name"]);
  });
});

describe("regra dura network-hijack", () => {
  const o = () => opts({ proxyService: "web", slug: "app", otherSlugs: ["vitima"] });
  const topo = { networks: { "paas-net": { name: "paas-net", external: true } } };

  it("o serviço web só com o alias do slug (o que o override do painel faz) passa", () => {
    expect(regras(servico({ networks: { "paas-net": { aliases: ["app"] } } }, topo), o)).toEqual([]);
  });

  it("alias a mais na rede do proxy", () => {
    for (const alias of ["tws-panel", "paas-stalwart", "vitima", "qualquer"]) {
      expect(regras(servico({ networks: { "paas-net": { aliases: ["app", alias] } } }, topo), o), alias).toContain("network-hijack");
    }
  });

  it("serviço que não é o web ligado à rede do proxy (lista ou mapa)", () => {
    const lista = { services: { web: { image: "a" }, side: { image: "b", networks: ["paas-net"] } }, ...topo };
    expect(regras(lista, o)).toEqual(["network-hijack"]);
    const mapa = { services: { side: { image: "b", networks: { "paas-net": null } } }, ...topo };
    expect(regras(mapa, o)).toEqual(["network-hijack"]);
  });

  it("a rede do proxy sob outra chave (name: paas-net) também conta", () => {
    const model = { services: { side: { image: "b", networks: ["x"] } }, networks: { x: { name: "paas-net", external: true } } };
    expect(regras(model, o)).toContain("network-hijack");
  });

  it("declaração da rede do proxy com driver, sem external ou com ipam", () => {
    const rede = (extra: Record<string, unknown>) => servico({}, { networks: { "paas-net": { name: "paas-net", ...extra } } });
    expect(regras(rede({ external: true, driver: "host" }), o)).toEqual(["network-hijack"]);
    expect(regras(rede({}), o)).toEqual(["network-hijack"]);
    expect(regras(rede({ external: true, ipam: { config: [{ subnet: "10.0.0.0/8" }] } }), o)).toEqual(["network-hijack"]);
  });
});

describe("regra dura panel-image", () => {
  const o = () => opts({ protectedImages: ["alpine:3@sha256:abc", "node:22", "nginx:alpine", "docker.io/library/caddy:2-alpine"] });

  it("serviço que constrói e grava a tag de uma imagem do painel", () => {
    for (const image of ["alpine:3", "docker.io/library/alpine:3.20", "library/alpine", "node:22", "nginx:alpine", "caddy:2-alpine"]) {
      expect(regras(servico({ image, build: "." }), o), image).toEqual(["panel-image"]);
    }
  });

  it("build.tags com tag do painel", () => {
    expect(regras(servico({ image: "minha-loja:1", build: { context: ".", tags: ["alpine:3"] } }), o)).toEqual(["panel-image"]);
  });

  it("usar a imagem sem construir é permitido; construir com outro nome também", () => {
    expect(regras(servico({ image: "nginx:alpine" }), o)).toEqual([]);
    expect(regras(servico({ image: "minha-loja:1", build: "." }), o)).toEqual([]);
  });

  it("imagem do painel ou de outro projeto não se reutiliza", () => {
    for (const image of ["tws-panel:latest", "paas-vitima:latest", "paas-vitima-web"]) {
      expect(regras(servico({ image }), o), image).toEqual(["panel-image"]);
    }
  });
});

describe("HARD_RULES: toda regra declarada é exercitada por um compose hostil", () => {
  const o = () => opts({ proxyService: "web", slug: "app", otherSlugs: ["vitima"], protectedImages: ["alpine"] });
  const hostis: Record<string, unknown> = {
    "reserved-name": servico({ labels: { "paas.project": "vitima" } }),
    "network-hijack": servico(
      { networks: { "paas-net": { aliases: ["tws-panel"] } } },
      { networks: { "paas-net": { name: "paas-net", external: true } } },
    ),
    "panel-image": servico({ image: "alpine:3", build: "." }),
  };

  it("cada regra de HARD_RULES tem um hostil que a dispara", () => {
    expect([...HARD_RULES].sort()).toEqual(Object.keys(hostis).sort());
    for (const regra of HARD_RULES) expect(regras(hostis[regra], o), regra).toContain(regra);
  });
});

describe("imageRepository", () => {
  it("tira registro padrão, library/, tag e digest", () => {
    expect(imageRepository("docker.io/library/alpine:3@sha256:abc")).toBe("alpine");
    expect(imageRepository("localhost:5000/minha")).toBe("localhost:5000/minha");
    expect(imageRepository("stalwartlabs/mail-server:v0.11.8")).toBe("stalwartlabs/mail-server");
  });
});
