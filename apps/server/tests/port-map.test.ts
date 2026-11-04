/**
 * port-map.test.ts — o mapa de portas do modal "Portas": o que está no ar
 * (docker ps), o que cada projeto compose do painel vai publicar (com as
 * trocas feitas no painel), conflitos e a validação de uma troca.
 */
import { describe, expect, it } from "vitest";
import type { DockerContainerInfo, Project } from "@paas/core";
import { composePortEntries } from "@paas/deploy";
import {
  buildPortRows,
  checkPortChange,
  checkPortsBatch,
  parseDockerPorts,
  projectPortsView,
  type PortsInput,
} from "../src/services/port-map.js";

const LOJA_COMPOSE = `services:
  api:
    image: app:1
    ports: ["127.0.0.1:8010:8010", "80:80"]
    expose: ["3000"]
  db:
    image: postgres:16
    ports: ["5432:5432"]
  worker:
    image: app:1
  edge:
    image: app:1
    ports: ["\${EDGE_PORT}:7000"]
`;

const BLOG_COMPOSE = `services:
  web:
    image: blog:1
    ports: ["8020:8020"]
`;

function project(id: string, name: string, extra: Partial<Project> = {}): Project {
  return {
    id,
    name,
    slug: name.toLowerCase(),
    ingestMode: "git",
    source: `https://example.com/${name}.git`,
    branch: "main",
    domain: `${name.toLowerCase()}.localhost`,
    websocket: false,
    detection: {
      type: "compose",
      composeFile: "compose.yaml",
      outputDir: null,
      packageManager: null,
      buildCommand: null,
      proxyService: "api",
      proxyPort: 3000,
      warnings: [],
      details: [],
      services: [
        {
          name: "api",
          image: "app:1",
          build: null,
          publishedPorts: [],
          internalPorts: [{ port: 3000, source: "expose" }],
          networkModeService: null,
          dependsOn: [],
          healthcheck: null,
        },
      ],
    },
    proxyService: null,
    proxyPort: null,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    lastDeployAt: null,
    lastDeployStatus: null,
    deployedBranch: null,
    deployedSource: null,
    ...extra,
  };
}

function container(name: string, ports: string[], extra: Partial<DockerContainerInfo> = {}): DockerContainerInfo {
  return {
    id: name,
    name,
    image: "img:1",
    state: "running",
    status: "Up 1 hour",
    managed: false,
    projectSlug: null,
    composeProject: null,
    service: null,
    health: null,
    ports,
    ...extra,
  };
}

const lojaC = (service: string, ports: string[], extra: Partial<DockerContainerInfo> = {}) =>
  container(`paas-loja-${service}-1`, ports, {
    managed: true,
    projectSlug: "loja",
    composeProject: "paas-loja",
    service,
    ...extra,
  });

function input(overrides: Partial<PortsInput> = {}): PortsInput {
  const loja = project("p1", "Loja");
  const blog = project("p2", "Blog", { slug: "blog" });
  return {
    projects: [loja, blog],
    composePorts: new Map([
      ["p1", composePortEntries(LOJA_COMPOSE)],
      ["p2", composePortEntries(BLOG_COMPOSE)],
    ]),
    containers: [
      lojaC("api", ["127.0.0.1:8010->8010/tcp", "3000/tcp"]),
      lojaC("db", ["0.0.0.0:5432->5432/tcp", "[::]:5432->5432/tcp"]),
      lojaC("worker", []),
      container("paas-caddy", ["0.0.0.0:80->80/tcp", "[::]:80->80/tcp", "0.0.0.0:443->443/tcp"], { managed: true }),
      container("tws-panel", ["127.0.0.1:9000->9000/tcp"]),
      container("outro-app", ["0.0.0.0:8020->80/tcp"], { image: "nginx:1" }),
    ],
    reserved: [80, 443, 2019, 9000],
    ...overrides,
  };
}

describe("parseDockerPorts", () => {
  it("lê as formas do docker ps e junta IPv4/IPv6 de todos os endereços", () => {
    expect(
      parseDockerPorts([
        "0.0.0.0:8080->80/tcp",
        "[::]:8080->80/tcp",
        ":::8081->81/tcp",
        "127.0.0.1:8010->8010/tcp",
        "[::1]:9000->9000/tcp",
        "53/udp",
        "0.0.0.0:7000-7001->7000-7001/tcp",
        "lixo",
      ]),
    ).toEqual([
      { hostIp: null, hostPort: 8080, containerPort: 80, protocol: "tcp" },
      { hostIp: null, hostPort: 8081, containerPort: 81, protocol: "tcp" },
      { hostIp: "127.0.0.1", hostPort: 8010, containerPort: 8010, protocol: "tcp" },
      { hostIp: "::1", hostPort: 9000, containerPort: 9000, protocol: "tcp" },
      { hostIp: null, hostPort: null, containerPort: 53, protocol: "udp" },
      { hostIp: null, hostPort: 7000, containerPort: 7000, protocol: "tcp" },
      { hostIp: null, hostPort: 7001, containerPort: 7001, protocol: "tcp" },
    ]);
  });
});

describe("buildPortRows (aba Todos os projetos)", () => {
  it("todos os containers, com o dono: projeto, painel ou externo", () => {
    const rows = buildPortRows(input());
    const byContainer = (name: string) => rows.filter((r) => r.container === name);
    expect(byContainer("paas-loja-api-1")).toEqual([
      expect.objectContaining({ owner: "project", projectName: "Loja", service: "api", hostIp: "127.0.0.1", hostPort: 8010, containerPort: 8010, source: "live", conflict: false }),
    ]);
    expect(byContainer("paas-loja-db-1")).toHaveLength(1);
    expect(byContainer("paas-loja-worker-1")).toEqual([expect.objectContaining({ hostPort: null, containerPort: null })]);
    expect(byContainer("paas-caddy").map((r) => [r.owner, r.hostPort, r.conflict])).toEqual([
      ["panel", 80, false],
      ["panel", 443, false],
    ]);
    expect(byContainer("tws-panel")[0]).toMatchObject({ owner: "panel", hostPort: 9000, conflict: false });
    expect(byContainer("outro-app")[0]).toMatchObject({ owner: "external", projectName: null, image: "nginx:1" });
  });

  it("porta que um projeto parado vai usar aparece como configurada e o conflito é marcado dos dois lados", () => {
    const rows = buildPortRows(input());
    const blog = rows.find((r) => r.projectName === "Blog");
    expect(blog).toMatchObject({ source: "configured", container: null, hostPort: 8020, conflict: true, conflictWith: "container outro-app" });
    expect(rows.find((r) => r.container === "outro-app")).toMatchObject({ conflict: true, conflictWith: "Blog · web" });
  });

  it("projeto que quer uma porta reservada do painel conflita com o painel", () => {
    const i = input();
    i.composePorts.set("p2", composePortEntries(`services:\n  web:\n    image: a\n    ports: ["2019:2019"]\n`));
    const blog = buildPortRows(i).find((r) => r.projectName === "Blog");
    expect(blog).toMatchObject({ conflict: true, conflictWith: "o painel (porta reservada)" });
  });

  it("endereços diferentes e específicos não conflitam", () => {
    const i = input({
      containers: [
        container("a", ["127.0.0.1:7777->80/tcp"]),
        container("b", ["10.0.0.5:7777->80/tcp"]),
        container("c", ["127.0.0.1:7777->80/udp"]),
      ],
    });
    expect(buildPortRows(i).filter((r) => r.conflict)).toEqual([]);
  });

  it("troca salva e ainda não aplicada: a porta nova aparece como configurada", () => {
    const i = input();
    i.projects[0]!.portOverrides = { api: [{ original: "127.0.0.1:8010:8010", hostPort: 18010, hostIp: "127.0.0.1" }] };
    const rows = buildPortRows(i).filter((r) => r.service === "api");
    expect(rows.map((r) => [r.source, r.hostPort])).toEqual([
      ["live", 8010],
      ["configured", 18010],
    ]);
  });

  it("Docker fora do ar: só o que está configurado", () => {
    const rows = buildPortRows(input({ containers: null }));
    expect(rows.every((r) => r.source === "configured")).toBe(true);
    expect(rows.map((r) => `${r.projectName}:${r.hostPort}`)).toEqual(["Loja:8010", "Loja:5432", "Blog:8020"]);
  });

  it("container de projeto que não é do painel conta como externo; projeto sem compose não gera configuradas", () => {
    const i = input({
      composePorts: new Map([["p1", null]]),
      containers: [container("x", [], { managed: true, projectSlug: "sumiu" })],
    });
    expect(buildPortRows(i)).toEqual([expect.objectContaining({ owner: "panel", container: "x" })]);
  });
});

describe("projectPortsView (aba Este projeto)", () => {
  it("cada serviço com estado, portas internas, publicadas e a entrada HTTP", () => {
    const view = projectPortsView(input().projects[0]!, input());
    expect(view).toMatchObject({ projectId: "p1", type: "compose", canChange: true, entry: { service: "api", port: 3000 }, pendingDeploy: false });
    expect(view.services.map((s) => s.name)).toEqual(["api", "db", "worker", "edge"]);
    const api = view.services[0]!;
    expect(api).toMatchObject({ container: "paas-loja-api-1", state: "running", internalPorts: [80, 3000, 8010] });
    expect(api.ports).toEqual([
      expect.objectContaining({ original: "127.0.0.1:8010:8010", published: true, hostIp: "127.0.0.1", hostPort: 8010, applied: true, changeable: true, override: null }),
      expect.objectContaining({ original: "80:80", published: false, panel: "removed", changeable: false, applied: true }),
    ]);
    const edge = view.services[3]!;
    expect(edge).toMatchObject({ container: null, state: null });
    expect(edge.ports[0]).toMatchObject({ composeHost: "${EDGE_PORT}", hostPort: null, applied: null, changeable: true });
  });

  it("troca salva: mostra a porta nova e avisa que vale no próximo deploy", () => {
    const i = input();
    i.projects[0]!.portOverrides = {
      api: [{ original: "127.0.0.1:8010:8010", hostPort: 18010, hostIp: "0.0.0.0" }],
      db: [{ original: "5432:5432", hostPort: null, hostIp: null }],
    };
    const view = projectPortsView(i.projects[0]!, i);
    expect(view.pendingDeploy).toBe(true);
    expect(view.services[0]!.ports[0]).toMatchObject({ hostPort: 18010, hostIp: null, applied: false, override: { hostPort: 18010 } });
    expect(view.services[1]!.ports[0]).toMatchObject({ published: false, applied: false });
  });

  it("removida e já aplicada; container parado não dá para saber", () => {
    const i = input({
      containers: [lojaC("db", []), lojaC("api", [], { state: "exited" })],
    });
    i.projects[0]!.portOverrides = { db: [{ original: "5432:5432", hostPort: null, hostIp: null }] };
    const view = projectPortsView(i.projects[0]!, i);
    expect(view.services[1]!.ports[0]!.applied).toBe(true);
    expect(view.services[0]!.ports[0]!.applied).toBeNull();
    expect(view.pendingDeploy).toBe(false);
  });

  it("projeto sem compose: os containers com as portas no ar, sem trocar", () => {
    const p = project("p3", "Site", {
      slug: "site",
      detection: { ...project("x", "x").detection!, type: "dockerfile", proxyService: null, proxyPort: 8080, services: undefined },
    });
    const i = input({
      projects: [p],
      composePorts: new Map(),
      containers: [container("paas-site", ["127.0.0.1:18080->8080/tcp", "8080/tcp"], { managed: true, projectSlug: "site" })],
    });
    const view = projectPortsView(p, i);
    expect(view).toMatchObject({ canChange: false, entry: { service: null, port: 8080 } });
    expect(view.services).toEqual([
      expect.objectContaining({
        name: "paas-site",
        ports: [],
        internalPorts: [8080],
        livePorts: [{ hostIp: "127.0.0.1", hostPort: 18080, containerPort: 8080, protocol: "tcp" }],
      }),
    ]);
  });

  it("compose sem o código no servidor: lista vazia e sem trocar; sem detecção, sem entrada", () => {
    const p = project("p1", "Loja", { detection: null });
    const view = projectPortsView(p, input({ composePorts: new Map(), containers: null }));
    expect(view).toMatchObject({ canChange: false, type: null, entry: null, services: [] });
  });
});

describe("checkPortChange (Trocar / Remover publicação)", () => {
  const loja = () => input().projects[0]!;

  it("troca para uma porta livre e grava a troca do serviço", () => {
    const i = input();
    const r = checkPortChange(i.projects[0]!, i, { service: "api", original: "127.0.0.1:8010:8010", action: "change", hostPort: 18010, hostIp: "127.0.0.1" });
    expect(r.portOverrides).toEqual({ api: [{ original: "127.0.0.1:8010:8010", hostPort: 18010, hostIp: "127.0.0.1" }] });
    expect(r.detail).toBe('Projeto "Loja", serviço api: 127.0.0.1:8010:8010 → 127.0.0.1:18010:8010.');
  });

  it("manter a porta e abrir para todos os endereços (a porta no ar é dele mesmo)", () => {
    const i = input();
    const r = checkPortChange(i.projects[0]!, i, { service: "api", original: "127.0.0.1:8010:8010", action: "change", hostIp: "0.0.0.0" });
    expect(r.portOverrides?.api).toEqual([{ original: "127.0.0.1:8010:8010", hostPort: 8010, hostIp: "0.0.0.0" }]);
  });

  it("voltar ao que o compose pede apaga a troca", () => {
    const i = input();
    i.projects[0]!.portOverrides = { api: [{ original: "127.0.0.1:8010:8010", hostPort: 18010, hostIp: "127.0.0.1" }] };
    const same = checkPortChange(i.projects[0]!, i, { service: "api", original: "127.0.0.1:8010:8010", action: "change", hostPort: 8010, hostIp: "127.0.0.1" });
    expect(same.portOverrides).toBeUndefined();
    const reset = checkPortChange(i.projects[0]!, i, { service: "api", original: "127.0.0.1:8010:8010", action: "reset" });
    expect(reset.portOverrides).toBeUndefined();
    expect(reset.detail).toContain("como está no compose");
  });

  it("remover a publicação", () => {
    const i = input();
    i.projects[0]!.portOverrides = { api: [{ original: "127.0.0.1:8010:8010", hostPort: 18010, hostIp: "127.0.0.1" }] };
    const r = checkPortChange(i.projects[0]!, i, { service: "db", original: "5432:5432", action: "remove" });
    expect(r.portOverrides).toEqual({
      api: [{ original: "127.0.0.1:8010:8010", hostPort: 18010, hostIp: "127.0.0.1" }],
      db: [{ original: "5432:5432", hostPort: null, hostIp: null }],
    });
    expect(r.detail).toContain("publicação removida");
  });

  it("recusa porta em uso por outro container, por outro projeto e pelo painel", () => {
    const i = input();
    const ask = (hostPort: number) => () =>
      checkPortChange(i.projects[0]!, i, { service: "api", original: "127.0.0.1:8010:8010", action: "change", hostPort, hostIp: "127.0.0.1" });
    expect(ask(5432)).toThrow(/já é usada por Loja · db/);
    expect(ask(8020)).toThrow(/container outro-app/);
    expect(ask(9000)).toThrow(/reservada ao painel/);
    try {
      ask(9000)();
    } catch (err) {
      expect(err).toMatchObject({ statusCode: 409, code: "port_in_use" });
    }
  });

  it("recusa 80/443, porta fora da faixa, serviço ou porta que não existem", () => {
    const i = input();
    const p = i.projects[0]!;
    expect(() => checkPortChange(p, i, { service: "api", original: "80:80", action: "remove" })).toThrow(/80 e 443/);
    expect(() => checkPortChange(p, i, { service: "api", original: "127.0.0.1:8010:8010", action: "change", hostPort: 500 })).toThrow(/1024/);
    expect(() => checkPortChange(p, i, { service: "nada", original: "1:1", action: "remove" })).toThrow(/não existe no compose/);
    expect(() => checkPortChange(p, i, { service: "api", original: "1:1", action: "remove" })).toThrow(/não está no compose/);
    expect(() => checkPortChange(p, i, { service: "edge", original: "${EDGE_PORT}:7000", action: "change" })).toThrow(/Informe a nova porta/);
  });

  it("só projeto compose com o código no servidor", () => {
    const i = input();
    const site = project("p3", "Site", { detection: { ...loja().detection!, type: "dockerfile" } });
    expect(() => checkPortChange(site, i, { service: "api", original: "x", action: "remove" })).toThrow(/compose/);
    const semCodigo = input({ composePorts: new Map() });
    expect(() => checkPortChange(loja(), semCodigo, { service: "api", original: "x", action: "remove" })).toThrow(
      /código do projeto/,
    );
  });
});

// ---------------------------------------------------------------------------
// Publicar porta por container e edição em lote (pedido de 04/10/2026)
// ---------------------------------------------------------------------------

const addedDb = {
  original: "+127.0.0.1:15432:5432",
  hostPort: 15432,
  hostIp: "127.0.0.1" as const,
  added: { containerPort: 5432, protocol: "tcp" as const },
};

describe("projectPortsView — publicações adicionadas e rede de outro serviço", () => {
  it("a adicionada aparece no serviço, marcada, e as do compose trazem o que o compose pede", () => {
    const i = input();
    i.projects[0]!.portOverrides = { worker: [{ ...addedDb, original: "+127.0.0.1:19000:9000", hostPort: 19000, added: { containerPort: 9000, protocol: "tcp" } }] };
    const view = projectPortsView(i.projects[0]!, i);
    const worker = view.services.find((s) => s.name === "worker")!;
    expect(worker.ports).toEqual([
      expect.objectContaining({
        original: "+127.0.0.1:19000:9000",
        added: true,
        published: true,
        hostIp: "127.0.0.1",
        hostPort: 19000,
        containerPort: 9000,
        composeHostPort: null,
        changeable: true,
        applied: false,
      }),
    ]);
    expect(worker.internalPorts).toContain(9000);
    expect(view.pendingDeploy).toBe(true);
    const api = view.services[0]!;
    expect(api.ports[0]).toMatchObject({ added: false, composeHostPort: 8010, composeHostIp: "127.0.0.1" });
    expect(api.publishBlocked).toBeNull();
  });

  it("adicionada já no ar: aplicada", () => {
    const i = input({ containers: [lojaC("db", ["127.0.0.1:15432->5432/tcp"])] });
    i.projects[0]!.portOverrides = { db: [{ original: "5432:5432", hostPort: null, hostIp: null }, addedDb] };
    const db = projectPortsView(i.projects[0]!, i).services.find((s) => s.name === "db")!;
    expect(db.ports.map((p) => [p.original, p.applied])).toEqual([
      ["5432:5432", true],
      ["+127.0.0.1:15432:5432", true],
    ]);
  });

  it("serviço na rede de outro: diz por que não publica (do compose ou, sem ele, da detecção)", () => {
    const i = input({ networkModes: new Map([["p1", { api: null, db: null, worker: "service:api", edge: null }]]) });
    const view = projectPortsView(i.projects[0]!, i);
    expect(view.services.find((s) => s.name === "worker")!.publishBlocked).toBe("Usa a rede do api — publique a porta no api.");

    const j = input();
    j.projects[0]!.detection!.services![0]!.networkModeService = "edge";
    expect(projectPortsView(j.projects[0]!, j).services[0]!.publishBlocked).toBe("Usa a rede do edge — publique a porta no edge.");
  });

  it("a aba Todos mostra a adicionada como configurada, com conflito", () => {
    const i = input();
    i.projects[1]!.portOverrides = { web: [{ ...addedDb, original: "+0.0.0.0:8010:80", hostPort: 8010, hostIp: "0.0.0.0", added: { containerPort: 80, protocol: "tcp" } }] };
    const row = buildPortRows(i).find((r) => r.projectId === "p2" && r.hostPort === 8010)!;
    expect(row).toMatchObject({ source: "configured", service: "web", containerPort: 80, conflict: true, conflictWith: "Loja · api" });
  });
});

describe("checkPortsBatch (Editar em lote / Publicar uma porta)", () => {
  it("grava trocas, remoção e adicionadas de vários serviços numa chamada, com o resumo de/para", () => {
    const i = input();
    const r = checkPortsBatch(i.projects[0]!, i, {
      ports: [
        { service: "api", original: "127.0.0.1:8010:8010", hostPort: 18010, hostIp: "0.0.0.0" },
        { service: "db", original: "5432:5432", hostPort: null },
        { service: "db", containerPort: 5432, hostPort: 15432, hostIp: "127.0.0.1" },
        { service: "worker", containerPort: 9000, protocol: "udp", hostPort: 19000 },
      ],
    });
    expect(r.portOverrides).toEqual({
      api: [{ original: "127.0.0.1:8010:8010", hostPort: 18010, hostIp: "0.0.0.0" }],
      db: [{ original: "5432:5432", hostPort: null, hostIp: null }, addedDb],
      worker: [{ original: "+127.0.0.1:19000:9000/udp", hostPort: 19000, hostIp: "127.0.0.1", added: { containerPort: 9000, protocol: "udp" } }],
    });
    expect(r.detail).toBe(
      'Projeto "Loja", portas em lote — api: 127.0.0.1:8010:8010 → 0.0.0.0:18010:8010; ' +
        "db: 5432:5432 → 127.0.0.1:15432:5432; worker: nenhuma → 127.0.0.1:19000:9000/udp.",
    );
  });

  it("lista vazia volta tudo ao compose; igual ao compose não vira troca", () => {
    const i = input();
    i.projects[0]!.portOverrides = { api: [{ original: "127.0.0.1:8010:8010", hostPort: 18010, hostIp: "127.0.0.1" }], db: [addedDb] };
    const back = checkPortsBatch(i.projects[0]!, i, { ports: [] });
    expect(back.portOverrides).toBeUndefined();
    expect(back.detail).toBe(
      'Projeto "Loja", portas em lote — api: 127.0.0.1:18010:8010 → 127.0.0.1:8010:8010; db: 5432:5432, 127.0.0.1:15432:5432 → 5432:5432.',
    );
    const same = checkPortsBatch(i.projects[0]!, i, { ports: [{ service: "api", original: "127.0.0.1:8010:8010", hostPort: 8010, hostIp: "127.0.0.1" }] });
    expect(same.portOverrides).toBeUndefined();
  });

  it("sem mudança nenhuma: o resumo diz isso", () => {
    const i = input();
    expect(checkPortsBatch(i.projects[0]!, i, { ports: [] }).detail).toBe('Projeto "Loja", portas em lote — nenhuma mudança.');
  });

  it("a porta no ar do próprio projeto não conta: dá para passar a 5432 do db para outro serviço", () => {
    const i = input();
    const r = checkPortsBatch(i.projects[0]!, i, {
      ports: [
        { service: "db", original: "5432:5432", hostPort: null },
        { service: "worker", containerPort: 5432, hostPort: 5432, hostIp: "0.0.0.0" },
      ],
    });
    expect(r.portOverrides?.worker?.[0]).toMatchObject({ hostPort: 5432, hostIp: "0.0.0.0" });
  });

  it("mostra o erro em cada linha: conflito entre si, com o compose, com outros e com o painel", () => {
    const i = input();
    let err: unknown;
    try {
      checkPortsBatch(i.projects[0]!, i, {
        ports: [
          { service: "worker", containerPort: 9000, hostPort: 19000 },
          { service: "edge", containerPort: 9001, hostPort: 19000, hostIp: "0.0.0.0" },
          { service: "worker", containerPort: 5432, hostPort: 5432 },
          { service: "worker", containerPort: 8020, hostPort: 8020 },
          { service: "worker", containerPort: 9000, hostPort: 9000 },
          { service: "worker", containerPort: 2019, hostPort: 2019 },
          { service: "worker", containerPort: 1, hostPort: 20001, protocol: "udp" },
        ],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ statusCode: 400, code: "invalid_ports" });
    const errors = (err as { details: { errors: Array<{ index: number; message: string }> } }).details.errors;
    expect(errors.map((e) => e.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(errors[0]!.message).toBe("A porta 19000 do servidor também está na linha de edge (→ 9001).");
    expect(errors[1]!.message).toBe("A porta 19000 do servidor também está na linha de worker (→ 9000).");
    expect(errors[2]!.message).toBe("A porta 5432 do servidor também está na linha de db (→ 5432).");
    expect(errors[3]!.message).toMatch(/A porta 8020 do servidor já é usada por (Blog · web|container outro-app)/);
    expect(errors[4]!.message).toBe("A porta 9000 do servidor é reservada ao painel. Escolha outra.");
    expect((err as Error).message).toBe("6 portas com problema. A primeira: A porta 19000 do servidor também está na linha de edge (→ 9001).");
  });

  it("endereços diferentes só conflitam quando um deles é todos os endereços", () => {
    const i = input();
    const r = checkPortsBatch(i.projects[0]!, i, {
      ports: [
        { service: "worker", containerPort: 9000, hostPort: 19000, hostIp: "127.0.0.1" },
        { service: "worker", containerPort: 9000, hostPort: 19000, protocol: "udp" },
      ],
    });
    expect(r.portOverrides?.worker).toHaveLength(2);
  });

  it("recusa linhas inválidas, cada uma com a explicação", () => {
    const i = input({ networkModes: new Map([["p1", { api: null, db: null, worker: "service:api", edge: null }]]) });
    const p = i.projects[0]!;
    const rowError = (row: Record<string, unknown>) => {
      try {
        checkPortsBatch(p, i, { ports: [row as never] });
      } catch (e) {
        return (e as { details: { errors: Array<{ message: string }> } }).details.errors[0]!.message;
      }
      return null;
    };
    expect(rowError({ service: "nada", containerPort: 1, hostPort: 2000 })).toMatch(/não existe no compose/);
    expect(rowError({ service: "api", original: "1:1", hostPort: 2000 })).toMatch(/não está no compose/);
    expect(rowError({ service: "api", original: "80:80", hostPort: 2000 })).toMatch(/80 e 443/);
    expect(rowError({ service: "worker", containerPort: 9000, hostPort: 19000 })).toBe("Usa a rede do api — publique a porta no api.");
    expect(rowError({ service: "db", hostPort: 2000 })).toMatch(/porta interna/);
    expect(rowError({ service: "db", containerPort: 70000, hostPort: 2000 })).toMatch(/porta interna/);
    expect(rowError({ service: "db", containerPort: 5432, hostPort: null })).toMatch(/Informe a porta do servidor/);
    expect(rowError({ service: "db", original: "5432:5432", hostPort: 443 })).toMatch(/80 e 443/);
    expect(rowError({ service: "db", original: "5432:5432", hostPort: 500 })).toMatch(/1024 a 65535/);
    expect(rowError({ service: "edge", original: "${EDGE_PORT}:7000", hostIp: "127.0.0.1" })).toMatch(/Informe a porta do servidor/);
    const dup = (() => {
      try {
        checkPortsBatch(p, i, {
          ports: [
            { service: "db", original: "5432:5432", hostPort: null },
            { service: "db", original: "5432:5432", hostPort: 15432 },
          ],
        });
      } catch (e) {
        return (e as { details: { errors: Array<{ index: number; message: string }> } }).details.errors;
      }
      return [];
    })();
    expect(dup).toEqual([{ index: 1, message: "Esta porta do compose aparece duas vezes na lista." }]);
  });

  it("só projeto compose com o código no servidor", () => {
    const i = input();
    const site = project("p3", "Site", { detection: { ...i.projects[0]!.detection!, type: "dockerfile" } });
    expect(() => checkPortsBatch(site, i, { ports: [] })).toThrow(/compose/);
    expect(() => checkPortsBatch(i.projects[0]!, input({ composePorts: new Map() }), { ports: [] })).toThrow(/código do projeto/);
  });
});
