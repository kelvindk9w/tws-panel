/**
 * Funções do modal "Portas": texto da porta, ordenação, busca, validação da
 * porta nova e a ordenação lembrada no navegador.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PortUsageRow, ProjectPortService } from "@paas/core";
import {
  bindingText,
  checkNewPort,
  filterRows,
  loadSort,
  ownerLabel,
  saveSort,
  sortRows,
  sortServices,
} from "@/lib/ports";

function row(extra: Partial<PortUsageRow>): PortUsageRow {
  return {
    owner: "project",
    projectId: "p1",
    projectName: "Loja",
    container: "paas-loja-api-1",
    service: "api",
    image: "app:1",
    state: "running",
    hostIp: "127.0.0.1",
    hostPort: 8010,
    containerPort: 8010,
    protocol: "tcp",
    source: "live",
    conflict: false,
    conflictWith: null,
    ...extra,
  };
}

function service(name: string, state: string | null, hostPort: number | null): ProjectPortService {
  return {
    name,
    container: state ? `c-${name}` : null,
    state,
    health: null,
    internalPorts: [],
    ports:
      hostPort === null
        ? []
        : [
            {
              original: `${hostPort}:${hostPort}`,
              containerPort: hostPort,
              protocol: "tcp",
              composeHost: String(hostPort),
              published: true,
              hostIp: null,
              hostPort,
              override: null,
              panel: null,
              applied: true,
              changeable: true,
            },
          ],
    livePorts: [],
    networkModeService: null,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("bindingText", () => {
  it("mostra endereço:porta do servidor → porta interna", () => {
    expect(bindingText("127.0.0.1", 8010, 8010, "tcp")).toBe("127.0.0.1:8010 → 8010");
    expect(bindingText(null, 5353, 53, "udp")).toBe("0.0.0.0:5353 → 53/udp");
    expect(bindingText("::1", 9000, 9000, "tcp")).toBe("[::1]:9000 → 9000");
    expect(bindingText(null, null, 80, "tcp")).toBe("80 (só interna)");
  });
});

describe("ownerLabel", () => {
  it("projeto, painel ou externo", () => {
    expect(ownerLabel(row({}))).toBe("Loja");
    expect(ownerLabel(row({ owner: "panel", projectName: null }))).toBe("Painel");
    expect(ownerLabel(row({ owner: "external", projectName: null }))).toBe("Externo");
  });
});

describe("sortRows", () => {
  const rows = [
    row({ projectName: "Loja", container: "b", hostPort: 8010, state: "running" }),
    row({ owner: "external", projectName: null, container: "a", hostPort: null, state: "exited" }),
    row({ projectName: "Blog", container: "c", hostPort: 3000, state: null, source: "configured" }),
  ];
  it("por projeto, container, porta e estado, nos dois sentidos", () => {
    expect(sortRows(rows, { key: "project", dir: "asc" }).map((r) => r.container)).toEqual(["c", "a", "b"]);
    expect(sortRows(rows, { key: "container", dir: "asc" }).map((r) => r.container)).toEqual(["a", "b", "c"]);
    expect(sortRows(rows, { key: "port", dir: "asc" }).map((r) => r.hostPort)).toEqual([3000, 8010, null]);
    expect(sortRows(rows, { key: "port", dir: "desc" }).map((r) => r.hostPort)).toEqual([8010, 3000, null]);
    expect(sortRows(rows, { key: "state", dir: "asc" }).map((r) => r.container)).toEqual(["b", "a", "c"]);
    expect(rows.map((r) => r.container)).toEqual(["b", "a", "c"]);
  });
});

describe("sortServices", () => {
  const services = [service("web", "exited", 3000), service("api", "running", 8010), service("db", null, null)];
  it("por serviço, porta e estado", () => {
    expect(sortServices(services, { key: "service", dir: "asc" }).map((s) => s.name)).toEqual(["api", "db", "web"]);
    expect(sortServices(services, { key: "service", dir: "desc" }).map((s) => s.name)).toEqual(["web", "db", "api"]);
    expect(sortServices(services, { key: "port", dir: "asc" }).map((s) => s.name)).toEqual(["web", "api", "db"]);
    expect(sortServices(services, { key: "state", dir: "asc" }).map((s) => s.name)).toEqual(["api", "web", "db"]);
  });
});

describe("filterRows", () => {
  it("busca por projeto, container, imagem, serviço e porta, sem diferenciar maiúsculas", () => {
    const rows = [row({ container: "paas-loja-api-1" }), row({ owner: "external", projectName: null, container: "outro", image: "nginx:1", hostPort: 8020 })];
    expect(filterRows(rows, "")).toHaveLength(2);
    expect(filterRows(rows, "NGINX").map((r) => r.container)).toEqual(["outro"]);
    expect(filterRows(rows, "8020").map((r) => r.container)).toEqual(["outro"]);
    expect(filterRows(rows, "loja").map((r) => r.container)).toEqual(["paas-loja-api-1"]);
    expect(filterRows(rows, "externo").map((r) => r.container)).toEqual(["outro"]);
  });
});

describe("checkNewPort", () => {
  const rows = [
    row({ projectName: "Loja", service: "db", hostPort: 5432 }),
    row({ owner: "panel", projectName: null, container: "tws-panel", service: null, hostPort: 9000 }),
    row({ projectName: "Loja", service: "api", hostPort: 8010 }),
  ];
  const own = { projectId: "p1", service: "api" };
  it("vazio = manter a mesma", () => {
    expect(checkNewPort("", rows, [80, 443], own)).toBeNull();
  });
  it("recusa fora da faixa, 80/443, reservada e em uso por outro", () => {
    expect(checkNewPort("abc", rows, [], own)).toMatch(/número/);
    expect(checkNewPort("80", rows, [80, 443], own)).toMatch(/80 e 443/);
    expect(checkNewPort("500", rows, [], own)).toMatch(/1024 a 65535/);
    expect(checkNewPort("70000", rows, [], own)).toMatch(/1024 a 65535/);
    expect(checkNewPort("2019", rows, [80, 443, 2019], own)).toMatch(/reservada ao painel/);
    expect(checkNewPort("5432", rows, [], own)).toMatch(/Loja · db/);
    expect(checkNewPort("9000", rows, [], own)).toMatch(/painel/);
  });
  it("a porta que o próprio serviço usa está livre para ele", () => {
    expect(checkNewPort("8010", rows, [], own)).toBeNull();
    expect(checkNewPort("18010", rows, [], own)).toBeNull();
  });
});

describe("ordenação lembrada no navegador", () => {
  it("salva e lê; valor inválido ou armazenamento bloqueado volta ao padrão", () => {
    const fallback = { key: "service", dir: "asc" } as const;
    expect(loadSort("x", ["service", "port"], fallback)).toEqual(fallback);
    saveSort("x", { key: "port", dir: "desc" });
    expect(loadSort("x", ["service", "port"], fallback)).toEqual({ key: "port", dir: "desc" });
    localStorage.setItem("paas.ports.sort.x", '{"key":"nada","dir":"asc"}');
    expect(loadSort("x", ["service", "port"], fallback)).toEqual(fallback);
    localStorage.setItem("paas.ports.sort.x", "{quebrado");
    expect(loadSort("x", ["service", "port"], fallback)).toEqual(fallback);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    expect(loadSort("x", ["service", "port"], fallback)).toEqual(fallback);
    expect(() => saveSort("x", { key: "port", dir: "asc" })).not.toThrow();
  });
});
