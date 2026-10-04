/**
 * Funções da edição de portas em lote e do "Publicar uma porta" (pedido do
 * dono, 04/10/2026: "não consigo trocar de cada container ou em lote?"): o
 * rascunho tirado da aba do projeto, a lista que vai ao servidor, a conferência
 * de todas as linhas juntas e os atalhos.
 */
import { describe, expect, it } from "vitest";
import type { PortUsageRow, ProjectPortEntry, ProjectPortsView } from "@paas/core";
import {
  addDraftRow,
  checkDraft,
  closeAllToLocal,
  databaseName,
  draftFromView,
  draftToRequest,
  isAsCompose,
  resetAllToCompose,
  suggestHostPort,
  type DraftRow,
} from "@/lib/ports";

function entry(extra: Partial<ProjectPortEntry>): ProjectPortEntry {
  return {
    original: "127.0.0.1:8010:8010",
    containerPort: 8010,
    protocol: "tcp",
    composeHost: "127.0.0.1:8010",
    published: true,
    hostIp: "127.0.0.1",
    hostPort: 8010,
    override: null,
    panel: null,
    applied: true,
    changeable: true,
    added: false,
    composeHostPort: 8010,
    composeHostIp: "127.0.0.1",
    ...extra,
  };
}

function view(): ProjectPortsView {
  return {
    projectId: "p1",
    projectName: "Loja",
    type: "compose",
    canChange: true,
    entry: null,
    pendingDeploy: false,
    services: [
      {
        name: "api",
        container: null,
        state: null,
        health: null,
        internalPorts: [8010],
        networkModeService: null,
        livePorts: [],
        publishBlocked: null,
        ports: [
          entry({}),
          entry({ original: "80:80", containerPort: 80, published: false, panel: "removed", changeable: false, hostPort: null }),
        ],
      },
      {
        name: "db",
        container: null,
        state: null,
        health: null,
        internalPorts: [5432],
        networkModeService: null,
        livePorts: [],
        publishBlocked: null,
        ports: [
          entry({
            original: "5432:5432",
            containerPort: 5432,
            published: false,
            hostIp: null,
            hostPort: null,
            override: { original: "5432:5432", hostPort: null, hostIp: null },
            composeHostPort: 5432,
            composeHostIp: null,
          }),
          entry({
            original: "+127.0.0.1:15432:5432",
            containerPort: 5432,
            hostPort: 15432,
            added: true,
            override: { original: "+127.0.0.1:15432:5432", hostPort: 15432, hostIp: "127.0.0.1", added: { containerPort: 5432, protocol: "tcp" } },
            composeHostPort: null,
            composeHostIp: null,
          }),
        ],
      },
      {
        name: "edge",
        container: null,
        state: null,
        health: null,
        internalPorts: [7000],
        networkModeService: null,
        livePorts: [],
        publishBlocked: null,
        ports: [entry({ original: "7000", containerPort: 7000, composeHost: "aleatória", hostIp: null, hostPort: null, composeHostPort: null, composeHostIp: null })],
      },
      {
        name: "web",
        container: null,
        state: null,
        health: null,
        internalPorts: [3200],
        networkModeService: "api",
        livePorts: [],
        publishBlocked: "Usa a rede do api — publique a porta no api.",
        ports: [],
      },
    ],
  };
}

function row(extra: Partial<PortUsageRow>): PortUsageRow {
  return {
    owner: "project",
    projectId: "p2",
    projectName: "Blog",
    container: null,
    service: "web",
    image: null,
    state: null,
    hostIp: null,
    hostPort: 8020,
    containerPort: 8020,
    protocol: "tcp",
    source: "configured",
    conflict: false,
    conflictWith: null,
    ...extra,
  };
}

const ROWS: PortUsageRow[] = [
  row({}),
  row({ owner: "panel", projectId: null, projectName: null, container: "tws-panel", hostIp: "127.0.0.1", hostPort: 9000 }),
  row({ owner: "external", projectId: null, projectName: null, container: "outro", hostIp: "10.0.0.5", hostPort: 7777 }),
  // a porta do próprio projeto não conta (vale a lista nova)
  row({ projectId: "p1", projectName: "Loja", service: "db", hostPort: 5432 }),
];

const byService = (rows: DraftRow[], service: string) => rows.filter((r) => r.service === service);

describe("draftFromView", () => {
  it("uma linha por porta que o painel pode mexer, inclusive as adicionadas; 80/443 ficam de fora", () => {
    const rows = draftFromView(view());
    expect(rows.map((r) => [r.service, r.original, r.containerPort, r.hostPort, r.hostIp, r.removed])).toEqual([
      ["api", "127.0.0.1:8010:8010", "8010", "8010", "127.0.0.1", false],
      ["db", "5432:5432", "5432", "5432", "0.0.0.0", true],
      ["db", null, "5432", "15432", "127.0.0.1", false],
      ["edge", "7000", "7000", "", "0.0.0.0", false],
    ]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(4);
    expect(rows[0]!.compose).toEqual({ hostPort: 8010, hostIp: "127.0.0.1" });
    expect(rows[2]!.compose).toBeNull();
  });

  it("resposta antiga, sem o que o compose pede: usa a porta mostrada quando não há troca", () => {
    const v = view();
    const e = v.services[0]!.ports[0]!;
    delete e.composeHostPort;
    delete e.composeHostIp;
    delete e.added;
    expect(draftFromView(v)[0]!.compose).toEqual({ hostPort: 8010, hostIp: "127.0.0.1" });
    v.services[0]!.ports[0] = { ...e, override: { original: e.original, hostPort: 18010, hostIp: "0.0.0.0" }, hostPort: 18010, hostIp: null };
    expect(draftFromView(v)[0]!.compose).toEqual({ hostPort: null, hostIp: "0.0.0.0" });
  });
});

describe("draftToRequest", () => {
  it("só manda o que difere do compose, as remoções e as adicionadas", () => {
    const rows = draftFromView(view());
    const { ports, ids } = draftToRequest(rows);
    expect(ports).toEqual([
      { service: "db", original: "5432:5432", hostPort: null },
      { service: "db", containerPort: 5432, protocol: "tcp", hostPort: 15432, hostIp: "127.0.0.1" },
    ]);
    expect(ids).toEqual([rows[1]!.id, rows[2]!.id]);
  });

  it("troca de porta e de endereço numa porta do compose", () => {
    const rows = draftFromView(view()).map((r) => (r.service === "api" ? { ...r, hostPort: "18010", hostIp: "0.0.0.0" } : r));
    expect(draftToRequest(rows).ports[0]).toEqual({ service: "api", original: "127.0.0.1:8010:8010", hostPort: 18010, hostIp: "0.0.0.0" });
  });

  it("isAsCompose: igual ao compose, inclusive a aleatória sem número", () => {
    const rows = draftFromView(view());
    expect(rows.map(isAsCompose)).toEqual([true, false, false, true]);
  });
});

describe("checkDraft", () => {
  it("rascunho válido: nenhum erro", () => {
    expect(checkDraft(draftFromView(view()), ROWS, [80, 443, 2019, 9000], "p1")).toEqual({});
  });

  it("erro na linha: conflito entre si, com outro projeto, com o painel e reservadas", () => {
    const rows = draftFromView(view());
    const extra = [
      { ...addDraftRow("worker"), containerPort: "9000", hostPort: "15432" },
      { ...addDraftRow("worker"), containerPort: "1", hostPort: "8020" },
      { ...addDraftRow("worker"), containerPort: "1", hostPort: "9000" },
      { ...addDraftRow("worker"), containerPort: "1", hostPort: "2019" },
      { ...addDraftRow("worker"), containerPort: "1", hostPort: "443" },
      { ...addDraftRow("worker"), containerPort: "1", hostPort: "80a" },
      { ...addDraftRow("worker"), containerPort: "1", hostPort: "500" },
      { ...addDraftRow("worker"), containerPort: "1", hostPort: "" },
      { ...addDraftRow("worker"), containerPort: "0", hostPort: "20000" },
      { ...addDraftRow("worker"), containerPort: "1", hostPort: "7777", hostIp: "127.0.0.1" },
      { ...addDraftRow("worker"), containerPort: "1", hostPort: "20001", protocol: "udp" },
    ];
    const all = [...rows, ...extra];
    const errors = checkDraft(all, ROWS, [80, 443, 2019, 9000], "p1");
    expect(errors[rows[2]!.id]).toBe("A porta 15432 do servidor também está na linha de worker (→ 9000).");
    expect(errors[extra[0]!.id]).toBe("A porta 15432 do servidor também está na linha de db (→ 5432).");
    expect(errors[extra[1]!.id]).toBe("A porta 8020 do servidor já é usada por Blog · web. Escolha outra.");
    expect(errors[extra[2]!.id]).toBe("A porta 9000 é reservada ao painel. Escolha outra.");
    expect(errors[extra[3]!.id]).toBe("A porta 2019 é reservada ao painel. Escolha outra.");
    expect(errors[extra[4]!.id]).toMatch(/80 e 443/);
    expect(errors[extra[5]!.id]).toBe("Digite só o número da porta.");
    expect(errors[extra[6]!.id]).toBe("Use uma porta de 1024 a 65535.");
    expect(errors[extra[7]!.id]).toBe("Informe a porta do servidor.");
    expect(errors[extra[8]!.id]).toMatch(/porta interna/);
    // 10.0.0.5 e 127.0.0.1 são endereços diferentes: não conflitam
    expect(errors[extra[9]!.id]).toBeUndefined();
    expect(errors[extra[10]!.id]).toBeUndefined();
  });

  it("todos os endereços conflita com outro de endereço específico; o painel e externos pelo nome", () => {
    const rows = [{ ...addDraftRow("x"), containerPort: "1", hostPort: "7777", hostIp: "0.0.0.0" }];
    expect(checkDraft(rows, ROWS, [], "p1")[rows[0]!.id]).toBe("A porta 7777 do servidor já é usada pelo container outro. Escolha outra.");
    const panel = [{ ...addDraftRow("x"), containerPort: "1", hostPort: "9000" }];
    expect(checkDraft(panel, ROWS, [], "p1")[panel[0]!.id]).toBe("A porta 9000 do servidor já é usada pelo painel. Escolha outra.");
  });

  it("removida não confere; aleatória do compose sem mexer não pede número, mas pede se mudar o endereço", () => {
    const rows = draftFromView(view());
    expect(checkDraft(rows, [], [], "p1")).toEqual({});
    const edge = rows.find((r) => r.service === "edge")!;
    const changed = rows.map((r) => (r === edge ? { ...r, hostIp: "127.0.0.1" } : r));
    expect(checkDraft(changed, [], [], "p1")[edge.id]).toBe("Informe a porta do servidor.");
  });

  it("endereço do compose fora dos dois do painel: só vale sem mexer", () => {
    const rows = [{ ...draftFromView(view())[0]!, hostIp: "10.0.0.5", compose: { hostPort: 8010, hostIp: "10.0.0.5" } }];
    expect(checkDraft(rows, [], [], "p1")).toEqual({});
    const moved = [{ ...rows[0]!, hostPort: "18010" }];
    expect(checkDraft(moved, [], [], "p1")[moved[0]!.id]).toBe("Escolha onde a porta fica aberta: 127.0.0.1 ou 0.0.0.0.");
  });
});

describe("atalhos", () => {
  it("Fechar todas para a internet: todas as publicações em 127.0.0.1", () => {
    const rows = closeAllToLocal(draftFromView(view()));
    expect(rows.filter((r) => !r.removed).every((r) => r.hostIp === "127.0.0.1")).toBe(true);
    // a removida continua removida
    expect(byService(rows, "db")[0]).toMatchObject({ removed: true });
  });

  it("Voltar tudo ao compose: tira as adicionadas e desfaz trocas e remoções", () => {
    const start = draftFromView(view()).map((r) => (r.service === "api" ? { ...r, hostPort: "18010" } : r));
    const rows = resetAllToCompose(start);
    expect(rows.map((r) => [r.service, r.hostPort, r.hostIp, r.removed])).toEqual([
      ["api", "8010", "127.0.0.1", false],
      ["db", "5432", "0.0.0.0", false],
      ["edge", "", "0.0.0.0", false],
    ]);
    expect(draftToRequest(rows).ports).toEqual([]);
  });
});

describe("suggestHostPort e databaseName", () => {
  it("sugere a própria porta interna quando está livre; senão, +10000", () => {
    expect(suggestHostPort(5432, () => false)).toBe(5432);
    expect(suggestHostPort(5432, (p) => p === 5432)).toBe(15432);
    expect(suggestHostPort(80, () => false)).toBe(10080);
    expect(suggestHostPort(60000, (p) => p === 60000)).toBe(60001);
    expect(suggestHostPort(60000, () => true)).toBeNull();
  });

  it("reconhece as portas de banco", () => {
    expect(databaseName(5432)).toBe("PostgreSQL");
    expect(databaseName(6379)).toBe("Redis");
    expect(databaseName(8080)).toBeNull();
  });
});
