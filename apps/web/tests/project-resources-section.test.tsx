/**
 * project-resources-section.test.tsx — aba "Recursos" do projeto: consulta por
 * período, soma e serviços, "sem dados" no lugar de zero, reinícios com horário,
 * erros, atualização automática e troca de projeto.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MetricPoint, ProjectMetricsResponse, ProjectServiceMetrics } from "@paas/core";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return { ...real, apiFetch: apiFetchMock };
});

import { ApiRequestError } from "@/lib/api";
import { setLocale } from "@/i18n/core";
import { ProjectResourcesSection } from "@/components/project/ProjectResourcesSection";

const T = Date.parse("2026-10-24T12:00:00Z") / 1000;
const line = (vals: number[]): MetricPoint[] => vals.map((v, i) => ({ t: T - 3600 + i * 600, v, max: v * 2 }));

function service(name: string, over: Partial<ProjectServiceMetrics> = {}): ProjectServiceMetrics {
  return {
    service: name,
    series: over.series ?? { cpu: line([10, 20, 30]), mem: line([1e8, 2e8]) },
    latest: over.latest ?? { cpu: 30, mem: 2e8, up: 1 },
  };
}

function reply(over: Partial<ProjectMetricsResponse> = {}): ProjectMetricsResponse {
  return {
    range: "24h",
    resolution: "minute",
    stepSeconds: 240,
    from: T - 86400,
    to: T,
    partial: false,
    total: {
      service: "",
      series: { cpu: line([15, 25, 35]), mem: line([3e8, 4e8]), ioRead: line([1000, 2000]), ioWrite: line([10, 20]), netRx: line([5000, 6000]), netTx: line([100, 200]), restarts: line([0, 2]), oom: line([1]) },
      latest: { cpu: 35, mem: 4e8, memLimit: 1024 ** 3, up: 2 },
    },
    services: [service("web"), service("db", { latest: { cpu: 1, mem: 1e8, up: 0 }, series: { restarts: line([1, 0]) } })],
    events: [
      { t: T - 600, service: "web", kind: "restart", count: 2 },
      { t: T - 1200, service: "db", kind: "oom", count: 1 },
      { t: T - 1800, service: "db", kind: "restart", count: 1 },
    ],
    collector: { mode: "full", hostSource: "mounted", containerSource: "cgroup", lastTickAt: null, lastError: null, retention: { minuteHours: 48, hourDays: 90, dayDays: 730 } },
    ...over,
  };
}

function show(projectId = "p1") {
  return render(
    <MemoryRouter>
      <ProjectResourcesSection projectId={projectId} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  setLocale("pt-BR");
  apiFetchMock.mockReset();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const urls = () => apiFetchMock.mock.calls.map((c) => c[0] as string);

describe("consulta", () => {
  it("abre em 24 horas; trocar o período consulta de novo e marca o botão", async () => {
    apiFetchMock.mockResolvedValue(reply());
    show();
    await screen.findByTestId("tile-cpu");
    expect(urls()).toEqual(["/api/projects/p1/metrics?range=24h"]);
    expect(screen.getByRole("button", { name: "24 horas" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "7 dias" }));
    await waitFor(() => expect(urls()).toContain("/api/projects/p1/metrics?range=7d"));
    expect(screen.getByRole("button", { name: "7 dias" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "24 horas" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "1 hora" }));
    await waitFor(() => expect(urls()).toContain("/api/projects/p1/metrics?range=1h"));
    fireEvent.click(screen.getByRole("button", { name: "30 dias" }));
    await waitFor(() => expect(urls()).toContain("/api/projects/p1/metrics?range=30d"));
  });

  it("o id do projeto é codificado na URL", async () => {
    apiFetchMock.mockResolvedValue(reply());
    show("a/b c");
    await screen.findByTestId("tile-cpu");
    expect(urls()[0]).toBe("/api/projects/a%2Fb%20c/metrics?range=24h");
  });

  it("botão Atualizar consulta de novo", async () => {
    apiFetchMock.mockResolvedValue(reply());
    show();
    await screen.findByTestId("tile-cpu");
    fireEvent.click(screen.getByRole("button", { name: "Atualizar" }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
  });
});

describe("conteúdo", () => {
  it("indicadores do projeto: processador, memória com limite, reinícios e mortes por memória do período", async () => {
    apiFetchMock.mockResolvedValue(reply());
    show();
    expect(await screen.findByTestId("tile-cpu")).toHaveTextContent("35% de um núcleo");
    expect(screen.getByTestId("tile-memory")).toHaveTextContent("381 MB");
    expect(screen.getByTestId("tile-memory")).toHaveTextContent("Limite do projeto: 1 GB");
    expect(screen.getByTestId("tile-restarts")).toHaveTextContent("2");
    expect(screen.getByTestId("tile-oom")).toHaveTextContent("1");
  });

  it("sem limite de memória e sem valor de agora: 'sem dados', nunca zero", async () => {
    apiFetchMock.mockResolvedValue(reply({ total: { service: "", series: { cpu: line([5]) }, latest: {} } }));
    show();
    expect(await screen.findByTestId("tile-cpu")).toHaveTextContent("sem dados");
    expect(screen.getByTestId("tile-memory")).toHaveTextContent("sem dados");
    expect(screen.getByTestId("tile-memory")).toHaveTextContent("sem limite de memória definido");
  });

  it("quatro gráficos (CPU, memória, disco, rede) com resumo em texto", async () => {
    apiFetchMock.mockResolvedValue(reply());
    show();
    await screen.findByTestId("tile-cpu");
    const charts = screen.getAllByTestId("metric-chart");
    expect(charts).toHaveLength(4);
    expect(charts[0]).toHaveTextContent("Processador");
    expect(charts[0]).toHaveTextContent("agora 35%");
    expect(charts[1]).toHaveTextContent("Memória");
    expect(charts[2]).toHaveTextContent("Leitura");
    expect(charts[2]).toHaveTextContent("Escrita");
    expect(charts[3]).toHaveTextContent("Entrada");
    expect(charts[3]).toHaveTextContent("Saída");
    expect(charts[3]).toHaveTextContent("/s");
  });

  it("gráfico sem medida (disco sem leitura do cgroup) mostra 'sem medidas', não uma linha em zero", async () => {
    const r = reply();
    delete r.total!.series.ioRead;
    delete r.total!.series.ioWrite;
    apiFetchMock.mockResolvedValue(r);
    show();
    await screen.findByTestId("tile-cpu");
    expect(screen.getAllByTestId("chart-empty")).toHaveLength(1);
  });

  it("serviços: estado, processador e memória (agora, média e pico), reinícios", async () => {
    apiFetchMock.mockResolvedValue(reply());
    show();
    await screen.findByTestId("tile-cpu");
    const web = screen.getByTestId("resources-service-web");
    expect(web).toHaveTextContent("rodando");
    expect(web).toHaveTextContent("30%");
    expect(web).toHaveTextContent("média 20% · pico 60%");
    expect(web).toHaveTextContent("191 MB");
    const db = screen.getByTestId("resources-service-db");
    expect(db).toHaveTextContent("parado");
    expect(db).toHaveTextContent("Reinícios");
    expect(db).toHaveTextContent("1");
    // db não tem CPU nem memória medidas no período
    expect(db).toHaveTextContent("sem dados");
  });

  it("serviço sem o indicador de 'no ar' não mostra estado", async () => {
    apiFetchMock.mockResolvedValue(reply({ services: [service("api", { latest: { cpu: 1 } })] }));
    show();
    const row = await screen.findByTestId("resources-service-api");
    expect(within(row).queryByText("rodando")).toBeNull();
    expect(within(row).queryByText("parado")).toBeNull();
  });

  it("eventos: horário, serviço e quantidade (singular e plural), com link para os logs", async () => {
    apiFetchMock.mockResolvedValue(reply());
    show();
    await screen.findByTestId("tile-cpu");
    const list = screen.getByTestId("resources-events");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("web reiniciou 2 vezes");
    expect(items[1]).toHaveTextContent("db: um processo foi morto por falta de memória");
    expect(items[2]).toHaveTextContent("db reiniciou");
    expect(items[2]).not.toHaveTextContent("vezes");
    expect(items[0].querySelector("time")).toHaveAttribute("datetime", new Date((T - 600) * 1000).toISOString());
    expect(screen.getByRole("link", { name: "Ver os logs" })).toHaveAttribute("href", "/projects/p1/logs");
  });

  it("vários processos mortos por memória usam o plural", async () => {
    apiFetchMock.mockResolvedValue(reply({ events: [{ t: T - 60, service: "web", kind: "oom", count: 3 }] }));
    show();
    expect(await screen.findByTestId("resources-events")).toHaveTextContent("web: 3 processos foram mortos por falta de memória");
  });

  it("sem eventos: mensagem", async () => {
    apiFetchMock.mockResolvedValue(reply({ events: [] }));
    show();
    expect(await screen.findByTestId("resources-no-events")).toHaveTextContent("Nenhum reinício nem morte por falta de memória");
  });

  it("sem nenhuma medida do projeto: explica que a primeira aparece em ~1 minuto", async () => {
    apiFetchMock.mockResolvedValue(reply({ total: null, services: [], events: [], partial: true }));
    show();
    expect(await screen.findByTestId("resources-empty")).toHaveTextContent("primeiras aparecem em cerca de 1 minuto");
    expect(screen.queryByTestId("tile-cpu")).toBeNull();
  });

  it("histórico curto avisa", async () => {
    apiFetchMock.mockResolvedValue(reply({ partial: true }));
    show();
    expect(await screen.findByTestId("resources-partial")).toHaveTextContent("histórico deste período ainda é curto");
    cleanup();
    apiFetchMock.mockResolvedValue(reply({ partial: false }));
    show();
    await screen.findByTestId("tile-cpu");
    expect(screen.queryByTestId("resources-partial")).toBeNull();
  });

  it("modo reduzido avisa como recriar o container", async () => {
    apiFetchMock.mockResolvedValue(reply({ collector: { ...reply().collector, mode: "reduced" } }));
    show();
    expect(await screen.findByTestId("resources-reduced")).toHaveTextContent("docker compose up -d --build");
  });

  it("em inglês", async () => {
    setLocale("en");
    apiFetchMock.mockResolvedValue(reply());
    show();
    expect(await screen.findByTestId("tile-cpu")).toHaveTextContent("35% of one core");
    expect(screen.getByRole("button", { name: "7 days" })).toBeInTheDocument();
    expect(screen.getByTestId("resources-events")).toHaveTextContent("web restarted 2 times");
  });
});

describe("erros e atualização", () => {
  it("falha de leitura: alerta; consulta ocupada (429): mensagem própria; some quando a seguinte dá certo", async () => {
    apiFetchMock.mockRejectedValue(new ApiRequestError(500, "x", "x"));
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar as medidas deste projeto.");
    apiFetchMock.mockRejectedValue(new ApiRequestError(429, "metrics_busy", "x"));
    fireEvent.click(screen.getByRole("button", { name: "Atualizar" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("consultas demais"));
    apiFetchMock.mockResolvedValue(reply());
    fireEvent.click(screen.getByRole("button", { name: "Atualizar" }));
    await screen.findByTestId("tile-cpu");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("mostra 'carregando' enquanto a primeira resposta não chega", async () => {
    apiFetchMock.mockReturnValue(new Promise(() => undefined));
    show();
    expect(screen.getByText("Carregando as medidas…")).toBeInTheDocument();
  });

  it("atualiza sozinha a cada minuto; falha numa atualização automática mantém o que estava na tela", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    apiFetchMock.mockResolvedValueOnce(reply());
    show();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("tile-cpu")).toBeInTheDocument();
    apiFetchMock.mockRejectedValue(new ApiRequestError(500, "x", "x"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("tile-cpu")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("outro projeto: as medidas do anterior somem na hora e a consulta é do novo", async () => {
    apiFetchMock.mockResolvedValue(reply());
    const { rerender } = show("p1");
    await screen.findByTestId("tile-cpu");
    apiFetchMock.mockReturnValue(new Promise(() => undefined));
    rerender(
      <MemoryRouter>
        <ProjectResourcesSection projectId="p2" />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("tile-cpu")).toBeNull();
    await waitFor(() => expect(urls()).toContain("/api/projects/p2/metrics?range=24h"));
  });

  it("resposta velha depois da nova é descartada; sair da aba cancela a consulta", async () => {
    let first!: (v: ProjectMetricsResponse) => void;
    let signal: AbortSignal | undefined;
    apiFetchMock.mockImplementationOnce((_u: string, init: { signal: AbortSignal }) => {
      signal = init.signal;
      return new Promise((r) => (first = r));
    });
    const { unmount } = show();
    apiFetchMock.mockResolvedValueOnce(reply({ total: { service: "", series: {}, latest: { cpu: 77 } } }));
    fireEvent.click(screen.getByRole("button", { name: "7 dias" }));
    await screen.findByTestId("tile-cpu");
    expect(signal?.aborted).toBe(true);
    await act(async () => first(reply({ total: { service: "", series: {}, latest: { cpu: 5 } } })));
    expect(screen.getByTestId("tile-cpu")).toHaveTextContent("77% de um núcleo");
    unmount();
  });
});
